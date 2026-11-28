import {expect, test} from "bun:test";
import {join} from "node:path";
import {BACKGROUND_CONTEXT} from "@earendil-works/chord/context";
import {fauxAssistantMessage} from "@earendil-works/pi-ai";
import {InboxDoc, ROOT_CONVERSATION_ID, type Harness} from "@earendil-works/pi-durable";
import {openNodeSqliteStorage} from "@earendil-works/pi-durable/storage/sqlite/node";
import {Channel} from "../src/channel";
import {Fixture, MODEL, OWNER, closedDatabase, faux, isolateClaudeConfig, scratchEnv} from "./helpers";

isolateClaudeConfig();

test("paused administrative opens preserve pending native work until normal resume", async () => {
	const fixture = await Fixture.create();
	const scripted = faux();
	let calls = 0;
	scripted.faux.appendResponses([() => { calls++; return fauxAssistantMessage("resumed exactly once"); }]);
	const path = join(fixture.root, "state", "channel.sqlite");
	const limits = Promise.withResolvers<void>();
	const open = async (resume: boolean) => Channel.open({
		id: "one", name: "one", owner: OWNER, project: fixture.project, resume,
		storage: await openNodeSqliteStorage(path), models: scripted.models,
		...(resume ? { prepareModels: () => limits.promise } : {}),
		defaultModel: async () => MODEL,
		env: (cwd) => scratchEnv(cwd, fixture.root),
		directory: {self: {id: "one", name: "one"}, list: async () => [], deliver: async () => {}}, log: () => {},
	});
	let channel = fixture.channel;
	try {
		await channel.close();
		channel = await open(false);
		const result = await channel.handle({op: "ask", author: OWNER, text: "persist pending work", model: MODEL}, () => {});
		const submission = typeof result === "object" && result !== null && "submission" in result && typeof result.submission === "number" ? result.submission : undefined;
		expect(submission).toBeNumber();
		await channel.close();
		const tasks = () => {const db = closedDatabase(path); try {return db.prepare("SELECT * FROM tasks ORDER BY id").all();} finally {db.close();}};
		const before = tasks();
		expect(before.length).toBeGreaterThan(0);
		channel = await open(false);
		await channel.close();
		expect(calls).toBe(0);
		const after = tasks();
		expect(after).toHaveLength(before.length);
		expect(after.map((task) => ({id: task.id, kind: task.kind, abort: task.abort_requested}))).toEqual(before.map((task) => ({id: task.id, kind: task.kind, abort: task.abort_requested})));
		expect(after.every((task) => task.status === "pending" && task.abort_requested === 0)).toBe(true);
		expect(after.map((task) => JSON.parse(String(task.record)).state.checkpoint)).toEqual(before.map((task) => JSON.parse(String(task.record)).state.checkpoint));
		channel = await open(true);
		const events: string[] = [];
		await channel.handle({ op: "watch" }, event => events.push(event.kind));
		expect(events).toContain("live");
		expect(calls).toBe(0);
		if (submission === undefined) throw new Error("Native ask did not return a submission");
		const waiting = channel.handle({op: "wait", submission}, () => {});
		limits.resolve();
		expect(await waiting).toBe("done");
		expect(calls).toBe(1);
		expect(JSON.stringify(await channel.export())).toContain("resumed exactly once");
	} finally {limits.resolve(); await channel.close(); await fixture.dispose();}
});

test("failed background lane recovery closes the channel and reopening resumes the saved input once", async () => {
	const fixture = await Fixture.create({resume: false, lane: undefined});
	const limits = Promise.withResolvers<void>();
	let laneAvailable = false;
	let laneAttempts = 0;
	try {
		const {submission} = await fixture.request<{submission: number}>({op: "ask", author: OWNER, text: "Saved input", model: MODEL});
		await fixture.channel.close();
		fixture.options.resume = true;
		fixture.options.prepareModels = () => limits.promise;
		fixture.options.build = {
			share: (_key, run) => run(),
			async worktree() {
				laneAttempts++;
				if (!laneAvailable) throw new Error("Git refused the work lane");
				return fixture.lane;
			},
		};
		fixture.options.feed = async (harness, submitInput) => {
			const chat = await harness.conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
			if (!chat) throw new Error("Missing fixture chat");
			const sending = submitInput(chat, {type: "input", content: "Pending feed message"}, BACKGROUND_CONTEXT);
			const closed = sending.then(() => {}, () => {});
			return {close: () => closed, pending: () => true};
		};
		fixture.script(fauxAssistantMessage("Recovered the saved input"));
		await fixture.open();
		const watch = await fixture.watch();
		expect(watch.of("live")).toHaveLength(1);
		const waiting = fixture.request({op: "say", author: OWNER, text: "Waiting for recovery"});
		limits.resolve();
		await expect(waiting).rejects.toThrow("Git refused the work lane");
		await expect(fixture.request({op: "info"})).rejects.toThrow("The channel is shutting down");
		await fixture.channel.close();
		expect(laneAttempts).toBe(1);
		expect(fixture.faux.state.callCount).toBe(0);

		laneAvailable = true;
		delete fixture.options.feed;
		await fixture.restart();
		expect(await fixture.request({op: "wait", submission})).toBe("done");
		expect(fixture.faux.state.callCount).toBe(1);
		expect(JSON.stringify(await fixture.channel.export())).toContain("Recovered the saved input");
	} finally {
		limits.resolve();
		await fixture.dispose();
	}
});

test("a queued input with no live task waits for model limits before a message places it", async () => {
	let harness: Harness | undefined;
	const fixture = await Fixture.create({
		resume: false,
		extension: {extensions: [], attach: value => { harness = value; }},
	});
	const limits = Promise.withResolvers<void>();
	let preparing = false;
	let limitsReady = false;
	let limitsAtRun: boolean | undefined;
	try {
		await fixture.request({op: "select", author: OWNER, model: MODEL});
		if (!harness) throw new Error("Missing fixture harness");
		const submission = await harness.commit(async tx => {
			const chat = ROOT_CONVERSATION_ID;
			const inbox = await tx.doc(InboxDoc, chat);
			const {id} = await tx.createSubmission({conversationId: chat, type: "input", status: "queued"});
			inbox.items.push({id, mode: "followUp", content: "owner: queued input"});
			return id;
		}, BACKGROUND_CONTEXT);
		await fixture.channel.close();
		const db = closedDatabase(join(fixture.root, "state", "channel.sqlite"));
		try { expect(db.prepare("SELECT id FROM tasks").all()).toEqual([]); }
		finally { db.close(); }

		fixture.options.resume = true;
		fixture.options.prepareModels = () => {
			preparing = true;
			return limits.promise;
		};
		fixture.script(() => {
			limitsAtRun = limitsReady;
			return fauxAssistantMessage("Answered the queued input");
		});
		await fixture.open();
		const watch = await fixture.watch();
		expect(preparing).toBe(true);
		const sending = fixture.request({op: "say", author: OWNER, text: "Place the queued input"});
		try {
			expect(await Promise.race([sending.then(() => "sent"), Bun.sleep(100).then(() => "waiting")])).toBe("waiting");
			expect(fixture.faux.state.callCount).toBe(0);
		} finally {
			limitsReady = true;
			limits.resolve();
			await sending;
		}
		expect(await fixture.request({op: "wait", submission})).toBe("done");
		expect(limitsAtRun).toBe(true);
		await watch.stop();
	} finally {
		limits.resolve();
		await fixture.dispose();
	}
});
