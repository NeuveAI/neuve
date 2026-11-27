import {expect, test} from "bun:test";
import {join} from "node:path";
import {fauxAssistantMessage} from "@earendil-works/pi-ai";
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
