import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { type Harness, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { ChatModesDoc, setChatMode } from "../src/plan-mode";
import type { Plan } from "../src/protocol";
import { Fixture, OWNER, until } from "./helpers";

// These exercise the permission boundary and the durable intent against actual pi run state.
async function setup() {
	let harness!: Harness;
	const fixture = await Fixture.create({
		planFiles: { stage: async () => {}, read: async (_file, _hash, bytes) => bytes },
		extension: { attach: async value => { harness = value; } },
	});
	const watch = await fixture.watch({ op: "watch", plans: true });
	const draft = async (text = "# Plan") => {
		const call = crypto.randomUUID();
		fixture.script(fauxAssistantMessage(fauxToolCall("plan_write", { text }, { id: call }), { stopReason: "toolUse" }));
		const { submission } = await fixture.request<{ submission: number }>({ op: "ask", author: OWNER, text: "Plan", mode: "plan" });
		expect(await fixture.request({ op: "wait", submission })).toBe("done");
		return (await watch.until("plans", event => event.plans.some(plan => plan.call === call))).plans.find(plan => plan.call === call)!;
	};
	const approve = (plan: Plan, fields = {}) => fixture.request({ op: "plan-approve", author: OWNER, plan: plan.id, hash: plan.hash, ...fields });
	const state = () => harness.snapshot(ChatModesDoc, BACKGROUND_CONTEXT);
	const mode = async () => (await state())?.chats[ROOT_CONVERSATION_ID];
	return { fixture, watch, draft, approve, state, mode, get harness() { return harness; } };
}

async function busy(fixture: Fixture, chat?: number) {
	const started = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	fixture.script(async () => { started.resolve(); await finish.promise; return fauxAssistantMessage("Done"); });
	const { submission } = await fixture.request<{ submission: number }>({ op: "ask", author: OWNER, text: "Read", ...(chat === undefined ? {} : { chat }) });
	await started.promise;
	return { finish: () => finish.resolve(), wait: () => fixture.request({ op: "wait", submission }) };
}

test("approval exits immediately once, and a revision exits with its own approval association", async () => {
	const run = await setup();
	try {
		for (const text of ["# First", "# Revision"]) {
			const plan = await run.draft(text);
			await run.approve(plan);
			expect(await run.mode()).toBe("ace");
			expect((await run.state())?.pendingExits).toEqual({});
			const logs = run.fixture.log.filter(item => item.event === "plan.mode.exited");
			expect(logs.at(-1)?.fields).toMatchObject({ chat: ROOT_CONVERSATION_ID, previous: "plan", mode: "ace", approval: { plan: plan.id, hash: plan.hash } });
			await run.approve(plan);
			expect(run.fixture.log.filter(item => item.event === "plan.mode.exited")).toHaveLength(logs.length);
		}
		let tools: string[] = [];
		run.fixture.script(request => { tools = getCurrentTools(request.messages).map(tool => tool.name); return fauxAssistantMessage("Ready"); });
		const { submission } = await run.fixture.request<{ submission: number }>({ op: "ask", author: OWNER, text: "Continue" });
		await run.fixture.request({ op: "wait", submission });
		expect(tools).toContain("bash");
		await run.fixture.restart();
		expect(await run.mode()).toBe("ace");
	} finally { await run.fixture.dispose(); }
});

test.each([false, true])("approval defers while an affected run is busy (descendant: %s)", async descendant => {
	const run = await setup();
	let working: Awaited<ReturnType<typeof busy>> | undefined;
	try {
		let chat: number | undefined;
		if (descendant) {
			run.fixture.script(fauxAssistantMessage(fauxToolCall("subagent", { task: "Inspect" }), { stopReason: "toolUse" }), fauxAssistantMessage("Child"), fauxAssistantMessage("Parent"));
			const { submission } = await run.fixture.request<{ submission: number }>({ op: "ask", author: OWNER, text: "Inspect" });
			await run.fixture.request({ op: "wait", submission });
			chat = (await run.fixture.channel.info()).chats.find(item => item.parent === ROOT_CONVERSATION_ID)!.id;
		}
		const plan = await run.draft();
		working = await busy(run.fixture, chat);
		await run.approve(plan);
		await run.approve(plan);
		expect(await run.mode()).toBe("plan");
		expect((await run.state())?.pendingExits?.[ROOT_CONVERSATION_ID]).toEqual({ plan: plan.id, hash: plan.hash });
		expect(run.fixture.log.filter(item => item.event === "plan.mode.exited")).toHaveLength(0);
		working.finish();
		await working.wait();
		await until(async () => await run.mode() === "ace");
		expect(run.fixture.log.filter(item => item.event === "plan.mode.exited")).toHaveLength(1);
	} finally { working?.finish(); await run.fixture.dispose(); }
});

test("a deliberate Plan choice supersedes a pending exit, even when it keeps the same mode", async () => {
	const run = await setup();
	let working: Awaited<ReturnType<typeof busy>> | undefined;
	try {
		const plan = await run.draft();
		working = await busy(run.fixture);
		await run.approve(plan);
		await run.harness.commit(tx => setChatMode(tx, ROOT_CONVERSATION_ID, "plan"), BACKGROUND_CONTEXT);
		working.finish();
		await working.wait();
		await run.fixture.restart();
		expect(await run.mode()).toBe("plan");
		expect((await run.state())?.pendingExits).toEqual({});
		await run.approve(plan);
		expect(await run.mode()).toBe("plan");
	} finally { working?.finish(); await run.fixture.dispose(); }
});

test("rejected approvals create neither a transition nor deferred intent", async () => {
	const run = await setup();
	try {
		const plan = await run.draft();
		await expect(run.approve(plan, { hash: "0".repeat(64) })).rejects.toThrow("changed");
		await expect(run.approve(plan, { author: "agent@other" })).rejects.toThrow("Only a person");
		await expect(run.approve(plan, { author: "teammate" })).rejects.toThrow();
		expect(await run.mode()).toBe("plan");
		expect((await run.state())?.pendingExits).toBeUndefined();
	} finally { await run.fixture.dispose(); }
});

test("reopening reconciles an approved pending exit left idle during shutdown", async () => {
	const run = await setup();
	let working: Awaited<ReturnType<typeof busy>> | undefined;
	try {
		const plan = await run.draft();
		working = await busy(run.fixture);
		await run.approve(plan);
		const closing = run.fixture.channel.close();
		// Closing suppresses new reconciliation work, but native close still joins the run.
		await Promise.resolve();
		working.finish();
		await closing;
		await run.fixture.open();
		await until(async () => await run.mode() === "ace");
		expect(run.fixture.log.filter(item => item.event === "plan.mode.exited")).toHaveLength(1);
	} finally { working?.finish(); await run.fixture.dispose(); }
});

test("an unrelated running chat does not delay the approved planning chat", async () => {
	const run = await setup();
	let working: Awaited<ReturnType<typeof busy>> | undefined;
	try {
		const plan = await run.draft();
		const { chat } = await run.fixture.request<{ chat: number }>({ op: "chat", author: OWNER });
		working = await busy(run.fixture, chat);
		await run.approve(plan);
		expect(await run.mode()).toBe("ace");
		expect((await run.fixture.channel.info()).chats.find(item => item.id === chat)?.busy).toBe(true);
	} finally { working?.finish(); await run.fixture.dispose(); }
});

test("a newer draft written by the running planner invalidates the previous approval's pending exit", async () => {
	const run = await setup();
	const started = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	try {
		const plan = await run.draft();
		run.fixture.script(async () => {
			started.resolve();
			await finish.promise;
			return fauxAssistantMessage(fauxToolCall("plan_write", { text: "# A newer planning session" }, { id: "newer-session" }), { stopReason: "toolUse" });
		});
		const { submission } = await run.fixture.request<{ submission: number }>({ op: "ask", author: OWNER, text: "Revise" });
		await started.promise;
		await run.approve(plan);
		finish.resolve();
		await run.fixture.request({ op: "wait", submission });
		await run.watch.until("plans", event => event.plans.some(item => item.call === "newer-session"));
		await run.fixture.restart();
		expect(await run.mode()).toBe("plan");
		expect((await run.state())?.pendingExits).toEqual({});
	} finally { finish.resolve(); await run.fixture.dispose(); }
});
