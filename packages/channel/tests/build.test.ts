import { setChatMode } from "../src/plan-mode";
import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentSystemPrompt, type FauxResponseStep } from "@earendil-works/pi-ai";
import { defineDoc, ROOT_CONVERSATION_ID, type ConversationId, type Harness, type SubmissionId, type ToolRegistration } from "@earendil-works/pi-durable";
import { SharedWork } from "../../records-core/src/shared-work";
import { TURN_CANCELLED, TURN_RETRY_FAILURE } from "@neuve/records-schema/turn-recovery";
import { planScopeRead } from "../../../apps/neuve-host/src/worker-runtime";
import { policy } from "../../harness/src/chat-runtime/transcript";
import { ApprovalRequestsDoc } from "../src/approvals";
import { BuildsDoc, type BuildHost } from "../src/build";
import { buildWorktree } from "../src/external-lanes";
import { EventSchema } from "../src/frame";
import { PlansDoc } from "../src/plan";
import type { Build, Plan, Request, RunEnd, Said } from "../src/protocol";
import { Fixture, git, MODEL, OWNER, scratchEnv, until, type Watch } from "./helpers";

const context = BACKGROUND_CONTEXT;
const planText = "# Export retries\n\nKeep the retry in the export queue.";
const revisedText = "# Export retries, revised\n\nKeep the retry in the export queue until delivery.";
const tool = (name: string, args: Parameters<typeof fauxToolCall>[1], id: string) =>
	fauxAssistantMessage(fauxToolCall(name, args, { id }), { stopReason: "toolUse" });
const question = (id: string) => fauxAssistantMessage(fauxToolCall("question", {
	questions: [{
		header: "Exports", question: "Which exports?", multiple: false,
		options: [{ label: "New", description: "Review new exports." }],
	}],
}, { id }), { stopReason: "toolUse" });

const fixtures: Fixture[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.dispose(); });

async function setup(options: {
	hosted?: boolean;
	withoutQuery?: boolean;
	query?: Parameters<typeof planScopeRead>[2];
	beforeWorktree?(): Promise<void>;
	beforeSharedResult?(): Promise<void>;
	onSharedWait?(): void;
	onStep?(step: string): void;
	nonTurnModels?: Fixture["options"]["nonTurnModels"];
	wrapTool?(tool: ToolRegistration): ToolRegistration;
} = {}) {
	const files = new Map<string, Uint8Array>();
	const work = new SharedWork<unknown>();
	const worktrees: Awaited<ReturnType<typeof buildWorktree>>[] = [];
	const said: Said[] = [];
	const runs: RunEnd[] = [];
	let harness!: Harness;
	let read: ReturnType<typeof planScopeRead>;
	const host: BuildHost = {
		async share<T>(key: string, run: () => Promise<T>) {
			const { outcome } = await work.run({
				scope: "build", key,
				onEvent: ({ role }) => { if (role === "waiter") options.onSharedWait?.(); },
				async run() {
					const value = await run();
					if (options.beforeSharedResult) await options.beforeSharedResult();
					return { kind: "succeeded", value };
				},
			});
			if (outcome.kind === "failed") throw outcome.error;
			return outcome.value as T;
		},
		async worktree(...[target, source]) {
			await options.beforeWorktree?.();
			const name = typeof target === "string" ? target : `chat-${target.chat}`;
			const recorded = typeof target === "string" ? undefined : target.recorded;
			const result = await buildWorktree({
				name: "one", project: fixture.project, lanes: fixture.lanes, env: cwd => scratchEnv(cwd, fixture.root),
			}, name, context, source, recorded);
			worktrees.push(result);
			return result;
		},
		...(options.withoutQuery ? {} : { query: { sessionId: "one", read: request => read(request) } }),
	};
	const fixture = await Fixture.create({
		planFiles: {
			async stage(file, _hash, bytes) { files.set(file, bytes); },
			async read(file, _hash, bytes) { return files.get(file) ?? bytes; },
		},
		build: options.hosted ? undefined : host,
		extension: { extensions: [], attach(value, admission) {
			harness = value;
			admission.onApprovalAnswer?.(async (_chat, _answer, record) => { await record(); return true; });
		} },
		tool: options.wrapTool,
		...(options.nonTurnModels ? { nonTurnModels: options.nonTurnModels } : {}),
		log: (_level, step) => options.onStep?.(step),
		onSaid: value => said.push(value),
		onRun: value => runs.push(value),
	});
	fixtures.push(fixture);
	const plans = join(fixture.root, "plans");
	read = planScopeRead(fixture.project, plans, options.query ?? (async ({ question }) => ({ query: question })));
	const watch = await fixture.watch({ op: "watch", plans: true, builds: true, approvals: true });
	const draft = async (text: string) => {
		const call = crypto.randomUUID();
		fixture.script(tool("plan_write", { text }, call));
		const receipt = await fixture.request<{ submission: number }>({
			op: "ask", author: OWNER, mode: "plan", model: MODEL, effort: "high", text: "Write the plan.",
		});
		expect(await fixture.request({ op: "wait", submission: receipt.submission })).toBe("done");
		const { plans } = await watch.until("plans", event => event.plans.some(plan => plan.call === call));
		return plans.find(plan => plan.call === call)!;
	};
	const approve = (plan: Plan, author = OWNER) =>
		fixture.request<Plan>({ op: "plan-approve", author, plan: plan.id, hash: plan.hash });
	return {
		fixture, watch, draft, approve, worktrees, said, runs,
		get harness() { return harness; },
		useHost() { fixture.options.build = host; },
		plans,
	};
}

async function buildAt(watch: Watch, index: number, kind: Build["state"]["kind"]): Promise<Build> {
	const event = await watch.until("builds", event => event.builds[index]?.state.kind === kind);
	return event.builds[index]!;
}

// Approval can succeed while the brief, role, inherited settings, or write access silently fail.
test("approval starts one ownerless implementer with the marked brief and write access", async () => {
	const run = await setup();
	const { fixture, watch, draft, approve } = run;
	const finish = Promise.withResolvers<void>();
	try {
		const plan = await draft(planText);
		fixture.script(tool("write", { path: "implemented.txt", content: "worktree only" }, "implement-write"), async () => {
			await finish.promise;
			return fauxAssistantMessage("Implemented.");
		});
		const [approval, retry] = await Promise.all([approve(plan), approve(plan)]);
		expect(retry).toEqual(approval);
		expect(await approve(plan)).toEqual(approval);
		const build = await buildAt(watch, 0, "started");
		const chat = build.agents[0]!.chat;
		expect(build.agents).toEqual([{ chat, role: "implementer", state: "running", started: expect.any(Number) }]);
		const [worktree] = run.worktrees;
		expect(run.worktrees).toHaveLength(1);
		expect(git(worktree!.path, "branch", "--show-current").trim()).toBe(worktree!.branch);
		expect(git(worktree!.path, "rev-parse", "HEAD").trim()).toBe(git(fixture.project, "rev-parse", "HEAD").trim());
		const agent = await fixture.watch({ op: "watch", chat, builds: true, approvals: true });
		const brief = await agent.until("message");
		expect(brief).toMatchObject({ author: "unknown", invoked: true, system: { kind: "neuve:build:brief", build: build.id } });
		for (const text of [plan.title, plan.hash, worktree!.path, worktree!.branch, "agent_start", "agent_message", "Load the Neuve skill."]) {
			expect(brief.text).toContain(text);
		}
		expect(brief.text).toContain(planText);
		expect(brief.text).toContain("Ask for your scope with neuve_query");
		expect(brief.text).not.toContain("neuve query");
		expect(brief.text).not.toContain(run.plans);
		const { file } = (await run.harness.snapshot(PlansDoc, context))!.chats[ROOT_CONVERSATION_ID]![0]!;
		expect(brief.text).not.toContain(file);
		expect(brief).not.toHaveProperty("mode");
		expect(await agent.until("result", event => event.call === "implement-write")).toMatchObject({ error: false });
		expect(await readFile(join(worktree!.path, "implemented.txt"), "utf8")).toBe("worktree only");
		const info = await fixture.channel.info();
		expect(info).toMatchObject({ chats: [
			{ id: 1, mode: "ace", model: MODEL, effort: "high" },
			{ id: chat, mode: "ace", model: MODEL, effort: "high", cwd: worktree!.path, build: { id: build.id, role: "implementer" } },
		] });
		expect(info.chats[1]).not.toHaveProperty("parent");
		expect(watch.of("builds").map(event => event.builds[0]?.state.kind)).toEqual([undefined, "starting", "starting", "starting", "started"]);
		expect(agent.of("builds")).toEqual([{ kind: "builds", chat, builds: [build], messages: [] }]);
		expect(agent.of("message")).toEqual([brief]);
		expect(agent.of("approval-requests").flatMap(event => event.requests)).toEqual([]);
		expect(agent.of("tool").map(event => event.name)).toEqual(["write"]);
		finish.resolve();
		await agent.until("reply", event => event.text === "Implemented.");
		fixture.script(
			tool("write", { path: "planning.txt", content: "approved" }, "planning-write"),
			fauxAssistantMessage("The approved chat can write."),
		);
		const receipt = await fixture.request<{ submission: number }>({ op: "ask", author: OWNER, text: "Try writing." });
		await fixture.request({ op: "wait", submission: receipt.submission });
		expect(await watch.until("result", event => event.call === "planning-write")).toMatchObject({ error: false });
		expect(await readFile(join(fixture.lane.path, "planning.txt"), "utf8")).toBe("approved");
		await fixture.channel.close();
		expect(run.said.filter(value => value.chat === chat)).toEqual([]);
		expect(run.runs.filter(value => value.chat === chat)).toEqual([]);
	} finally {
		finish.resolve();
	}
});

for (const retry of ["the same plan", "an identical copy"]) {
	// A failed worktree could leave an approved plan with no agent, or a retry could create a second build.
	test(`approving ${retry} retries a failed build and reuses a started or stopped build`, async () => {
		let fail = true;
		const run = await setup({ async beforeWorktree() { if (fail) throw new Error("Worktree unavailable"); } });
		const { fixture, watch, draft, approve } = run;
		const first = await draft(planText);
		await approve(first);
		const failed = await buildAt(watch, 0, "failed");
		expect(failed).toMatchObject({ state: { detail: "The implementer's worktree could not be created." }, agents: [] });
		const plan = retry === "the same plan" ? first : await draft(planText);
		fail = false;
		fixture.script(fauxAssistantMessage("Brief read."));
		expect(await approve(plan)).toMatchObject({ state: "approved" });
		await until(() => fixture.channel.isIdle());
		const started = watch.of("builds").at(-1)?.builds;
		expect(started).toMatchObject([{ id: failed.id, plan: { id: first.id }, state: { kind: "started" } }]);
		const { chat } = started![0]!.agents[0]!;
		const transcript = await fixture.watch({ op: "watch", chat });
		expect(transcript.of("reply").at(-1)?.text).toBe("Brief read.");

		await approve(await draft(planText));
		await fixture.request({ op: "build-stop", author: OWNER, build: failed.id });
		await approve(await draft(planText));
		await until(() => fixture.channel.isIdle());
		const attached = await fixture.watch({ op: "watch", builds: true });
		expect((await attached.until("builds")).builds).toMatchObject([{ id: failed.id, state: { kind: "stopped" } }]);
		expect((await fixture.channel.info()).chats.map(chat => chat.id)).toEqual([1, chat]);
		expect(run.worktrees).toHaveLength(1);
	});
}

// A restart can appear to recover while quietly creating a second worktree, chat, or brief.
for (const step of ["build.worktree", "build.chat"]) {
	test(`reopen finishes a start interrupted at ${step} once`, async () => {
		const closing = Promise.withResolvers<Promise<void>>();
		let interrupt = true;
		const run = await setup({
			onStep(event) {
				if (interrupt && event === step) {
					interrupt = false;
					closing.resolve(run.fixture.channel.close());
				}
			},
		});
		const plan = await run.draft(planText);
		run.fixture.script(fauxAssistantMessage("Brief read."));
		await run.approve(plan);
		await closing.promise;
		await run.fixture.restart();
		const watch = await run.fixture.watch({ op: "watch", builds: true });
		const build = await buildAt(watch, 0, "started");
		const chat = build.agents[0]!.chat;
		const agent = await run.fixture.watch({ op: "watch", chat });
		await agent.until("reply", event => event.text === "Brief read.");
		expect(agent.of("message")).toHaveLength(1);
		expect(agent.of("message")[0]?.system).toEqual({ kind: "neuve:build:brief", build: build.id });
		expect((await run.fixture.channel.info()).chats.map(chat => chat.id)).toEqual([1, chat]);
		expect(run.worktrees).toHaveLength(1);
	});
}

// A prior approval can be mistaken for an unfinished start even though it has no build record.
test("reapproving an older approval starts nothing, including after reopening", async () => {
	const run = await setup({ hosted: true });
	const plan = await run.draft(planText);
	const approved = await run.approve(plan);
	await run.harness.commit(tx => tx.retireDoc(BuildsDoc), context);
	run.useHost();
	await run.fixture.restart();
	expect(await run.approve(plan)).toEqual(approved);
	await until(() => run.fixture.channel.isIdle());
	const watch = await run.fixture.watch({ op: "watch", builds: true });
	expect(watch.of("builds")).toEqual([{ kind: "builds", chat: 1, builds: [], messages: [] }]);
	expect((await run.fixture.channel.info()).chats.map(chat => chat.id)).toEqual([1]);
	expect(run.worktrees).toEqual([]);
});

// A channel can otherwise appear to approve normally while starting unattended work.
for (const mode of ["hosted", "shared", "legacy"] as const) {
	test(`approval records the unavailable build in a ${mode} channel`, async () => {
		const run = await setup({ hosted: mode === "hosted" });
		const plan = await run.draft(planText);
		let watch = run.watch;
		if (mode === "shared") await run.fixture.request({ op: "share", author: OWNER, shared: true });
		if (mode === "legacy") {
			const settings = defineDoc({
				kind: "ace.settings", scope: "session", version: 2, initial: () => ({ shared: false, desktop: false }),
			});
			await run.harness.commit(tx => tx.retireDoc(settings), context);
			await run.fixture.restart();
			watch = await run.fixture.watch({ op: "watch", builds: true });
		}
		await run.approve(plan, mode === "legacy" ? "teammate" : OWNER);
		expect(await buildAt(watch, 0, "unavailable")).toMatchObject({
			state: { kind: "unavailable", reason: mode === "hosted" ? "hosted" : "shared" }, agents: [],
		});
		expect((await run.fixture.channel.info()).chats.map(chat => chat.id)).toEqual([1]);
		expect(run.worktrees).toEqual([]);
	});
}

// A plan approved while shared could stay approved without ever reaching an implementer.
test("unsharing starts the build approved while shared and sends one brief", async () => {
	const run = await setup();
	const { fixture, watch, draft, approve } = run;
	const plan = await draft(planText);
	await fixture.request({ op: "share", author: OWNER, shared: true });
	await approve(plan);
	const unavailable = await buildAt(watch, 0, "unavailable");
	expect(unavailable).toMatchObject({ state: { reason: "shared" }, agents: [] });
	await approve(plan);
	await until(() => fixture.channel.isIdle());
	expect(run.worktrees).toEqual([]);

	fixture.script(fauxAssistantMessage("Brief read."));
	await fixture.request({ op: "share", author: OWNER, shared: false });
	await until(() => fixture.channel.isIdle());
	const builds = watch.of("builds").at(-1)?.builds;
	expect(builds).toMatchObject([{ id: unavailable.id, state: { kind: "started" }, agents: [{ role: "implementer" }] }]);
	const { chat } = builds![0]!.agents[0]!;
	const transcript = await fixture.watch({ op: "watch", chat });
	expect(transcript.of("reply").at(-1)?.text).toBe("Brief read.");
	expect(transcript.of("message").map(event => event.system?.kind)).toEqual(["neuve:build:brief"]);
	expect(run.worktrees).toHaveLength(1);
});

// Unsharing could turn a teammate's approval into work on the owner's machine without the owner's approval.
test("unsharing leaves a teammate's build unavailable until the owner approves identical text", async () => {
	const run = await setup();
	const { fixture, watch, draft, approve } = run;
	const plan = await draft(planText);
	await fixture.request({ op: "share", author: OWNER, shared: true });
	await approve(plan, "teammate");
	const unavailable = await buildAt(watch, 0, "unavailable");
	expect(unavailable).toMatchObject({ approved: { by: "teammate" }, state: { reason: "shared" }, agents: [] });

	await fixture.request({ op: "share", author: OWNER, shared: false });
	await until(() => fixture.channel.isIdle());
	expect(watch.of("builds").at(-1)?.builds).toEqual([unavailable]);
	expect((await fixture.channel.info()).chats.map(chat => chat.id)).toEqual([ROOT_CONVERSATION_ID]);
	expect(run.worktrees).toEqual([]);

	const copy = await draft(planText);
	expect(copy.id).not.toBe(plan.id);
	fixture.script(fauxAssistantMessage("Brief read."));
	expect(await approve(copy)).toMatchObject({ state: "approved", approved: { by: OWNER } });
	const started = await buildAt(watch, 0, "started");
	expect(started).toMatchObject({ id: unavailable.id, agents: [{ role: "implementer" }] });
	const transcript = await fixture.watch({ op: "watch", chat: started.agents[0]!.chat });
	await transcript.until("reply", event => event.text === "Brief read.");
	expect(transcript.of("message").map(event => event.system?.kind)).toEqual(["neuve:build:brief"]);
	expect(run.worktrees).toHaveLength(1);
});

// Unsharing could start an implementer on a plan the owner already replaced.
test("unsharing starts only the latest plan approved while shared", async () => {
	const run = await setup();
	const { fixture, watch, draft, approve } = run;
	await fixture.request({ op: "share", author: OWNER, shared: true });
	const first = await draft(planText);
	await approve(first);
	const revision = await draft(revisedText);
	await approve(revision);
	await buildAt(watch, 1, "unavailable");

	fixture.script(fauxAssistantMessage("Brief read."), fauxAssistantMessage("Brief read."));
	await fixture.request({ op: "share", author: OWNER, shared: false });
	await until(() => fixture.channel.isIdle());
	const builds = watch.of("builds").at(-1)?.builds;
	expect(builds).toMatchObject([
		{ plan: { id: first.id }, state: { kind: "unavailable", reason: "shared" }, agents: [] },
		{ plan: { id: revision.id }, state: { kind: "started" }, agents: [{ role: "implementer" }] },
	]);
	const transcript = await fixture.watch({ op: "watch", chat: builds![1]!.agents[0]!.chat });
	expect(transcript.of("message").map(event => event.system?.kind)).toEqual(["neuve:build:brief"]);
	expect(run.worktrees).toHaveLength(1);
});

// Retrying an earlier failed plan could start a competing implementer while its successor is still working.
test("approving identical text after a failure delivers to the live implementer", async () => {
	let fail = true;
	const run = await setup({ async beforeWorktree() { if (fail) throw new Error("Worktree unavailable"); } });
	const { fixture, watch, draft, approve } = run;
	await approve(await draft(planText));
	const failed = await buildAt(watch, 0, "failed");
	fail = false;
	const revision = await draft(revisedText);
	const entered = Promise.withResolvers<void>();
	const hold = Promise.withResolvers<void>();
	try {
		fixture.script(async () => { entered.resolve(); await hold.promise; return fauxAssistantMessage("Ready."); });
		await approve(revision);
		const live = await buildAt(watch, 1, "started");
		const { chat } = live.agents[0]!;
		await entered.promise;
		const copy = await draft(planText);
		fixture.script(fauxAssistantMessage("Revision read."));
		await approve(copy);
		const transcript = await fixture.watch({ op: "watch", chat, builds: true });
		expect(transcript.of("builds").at(-1)?.builds).toMatchObject([
			{ id: failed.id, state: { kind: "delivered", to: live.id }, agents: [] },
			{ id: live.id, state: { kind: "started" }, agents: [{ chat }] },
		]);
		hold.resolve();
		expect(await transcript.until("message", event => event.text === planText)).toMatchObject({ author: OWNER });
		await until(() => fixture.channel.isIdle());
		expect(run.worktrees).toHaveLength(1);
	} finally {
		hold.resolve();
	}
});

// A revision can appear approved while it is lost between the approval commit and the first brief.
test("approval during worktree creation delivers the revision once the implementer starts", async () => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const run = await setup({ async beforeWorktree() { entered.resolve(); await release.promise; } });
	try {
		const first = await run.draft(planText);
		await run.approve(first);
		await entered.promise;
		const build = await buildAt(run.watch, 0, "starting");
		expect(build.agents).toEqual([]);
		const revision = await run.draft(revisedText);
		await Promise.all([run.approve(revision), run.approve(revision)]);
		expect(await buildAt(run.watch, 1, "delivered")).toMatchObject({ state: { kind: "delivered", to: build.id }, agents: [] });
		run.fixture.script(fauxAssistantMessage("Brief read."), fauxAssistantMessage("Revision read."));
		release.resolve();
		const started = await buildAt(run.watch, 0, "started");
		const agent = await run.fixture.watch({ op: "watch", chat: started.agents[0]!.chat });
		await agent.until("message", event => event.text === revisedText);
		expect(agent.of("message").map(event => ({ author: event.author, mark: event.system }))).toEqual([
			{ author: "unknown", mark: { kind: "neuve:build:brief", build: build.id } },
			{ author: OWNER, mark: undefined },
		]);
		expect(run.worktrees).toHaveLength(1);
	} finally {
		release.resolve();
	}
});

// Treating a busy chat as ended would silently start another implementer on a competing branch.
test("approval steers a live implementer and a later plan starts a new one after it ends", async () => {
	const run = await setup();
	const first = await run.draft(planText);
	run.fixture.script(tool("bash", { command: "while [ ! -e continue-build ]; do sleep .02; done" }, "wait-for-revision"));
	await run.approve(first);
	const build = await buildAt(run.watch, 0, "started");
	const agent = await run.fixture.watch({ op: "watch", chat: build.agents[0]!.chat });
	await agent.until("tool", event => event.call === "wait-for-revision");
	const revision = await run.draft(revisedText);
	await run.approve(revision);
	expect(await buildAt(run.watch, 1, "delivered")).toMatchObject({ state: { kind: "delivered", to: build.id } });
	await agent.until("queue", event => event.messages.some(message => message.text === revisedText));
	expect(agent.of("result").some(event => event.call === "wait-for-revision")).toBe(false);
	run.fixture.script(fauxAssistantMessage("Revision read."));
	await writeFile(join(run.worktrees[0]!.path, "continue-build"), "");
	expect(await agent.until("result", event => event.call === "wait-for-revision")).toMatchObject({ error: false });
	expect(await agent.until("message", event => event.text === revisedText)).toMatchObject({ author: OWNER, invoked: true });
	await agent.until("run", event => event.state === "end");
	expect(run.worktrees).toHaveLength(1);
	const later = await run.draft("# Export monitoring\n\nTrack completed exports.");
	run.fixture.script(fauxAssistantMessage("New plan read."));
	await run.approve(later);
	const started = await buildAt(run.watch, 2, "started");
	expect(started.agents).toMatchObject([{ role: "implementer" }]);
	expect(started.agents[0]!.chat).not.toBe(build.agents[0]!.chat);
	expect(run.worktrees).toHaveLength(2);
});

// A forged host request could look identical to a brief or claim a revision's retry key.
test("direct channel routes refuse client use of build request IDs", async () => {
	const run = await setup();
	const requests: Request[] = [
		{ op: "say", author: OWNER, text: "Brief", requestId: "neuve.build:forged" },
		{ op: "ask", author: OWNER, text: "Brief", requestId: "neuve.build:forged" },
		{ op: "plan-comments-send", author: OWNER, plan: "plan", requestId: "neuve.build:forged" },
	];
	for (const request of requests) {
		await expect(run.fixture.channel.handle(request, () => {})).rejects.toThrow("The neuve.build: request-ID namespace is reserved for the host.");
	}
});

async function startBuild(run: Awaited<ReturnType<typeof setup>>, reply: FauxResponseStep = fauxAssistantMessage("Ready.")) {
	const plan = await run.draft(planText);
	run.fixture.script(reply);
	await run.approve(plan);
	const build = await buildAt(run.watch, 0, "started");
	const chat = build.agents[0]!.chat;
	const agent = await run.fixture.watch({ op: "watch", chat, approvals: true });
	await agent.until("reply", event => event.text === "Ready.");
	await until(() => run.fixture.channel.isIdle());
	return { plan, build, chat, agent };
}

async function invoke(fixture: Fixture, text: string, chat?: number) {
	const { submission } = await fixture.request<{ submission: number }>({ op: "ask", author: OWNER, text, chat });
	return submission;
}

async function wake(run: Awaited<ReturnType<typeof setup>>, text: string, chat: number) {
	const conversation = (await run.harness.conversation(chat as ConversationId, context))!;
	return (await conversation.submit({ type: "input", content: `${OWNER}: ${text}` }, context)).id;
}

async function askScope(run: Awaited<ReturnType<typeof setup>>, chat: number, call: string, scope?: string[]) {
	const watch = await run.fixture.watch({ op: "watch", chat });
	run.fixture.script(tool("neuve_query", { question: call, ...(scope ? { scope } : {}) }, call), fauxAssistantMessage("Read finished."));
	await run.fixture.request({ op: "wait", submission: await wake(run, "Read scope.", chat) });
	return watch.until("result", event => event.call === call);
}

// A channel default or inherited selection would expose the host tool in chats with no approved-plan assignment.
test("the sandbox bridge serves scope reads only to plan agents, including after a restart", async () => {
	const run = await setup();
	const seen: boolean[][] = [];
	const probe: FauxResponseStep = ({ messages }) => {
		seen.push([false, true].map(ownTools =>
			policy(messages, async () => ({ content: [] }), undefined, { ownTools }).tools.some(tool => tool.name === "neuve_query")));
		return fauxAssistantMessage("Ready.");
	};
	run.fixture.script(probe);
	await run.fixture.request({ op: "wait", submission: await invoke(run.fixture, "Check which tools I can use.") });
	const { chat } = await startBuild(run, probe);
	await run.fixture.restart();
	run.fixture.script(probe);
	await run.fixture.request({ op: "wait", submission: await wake(run, "Check tools after reopening.", chat) });
	const source = (await run.harness.conversation(chat as ConversationId, context))!;
	const entry = (await source.context(context)).entries.at(-1)!;
	const fork = await source.fork(entry.id, { ownership: { kind: "ownerless" } }, context);
	run.fixture.script(probe);
	await (await fork.submit({ type: "input", content: "Check tools in this fork." }, context)).wait(context);
	expect(seen).toEqual([[false, false], [true, true], [true, true], [false, false]]);
});

// Plain Ace can start a plan's agent even when the worker has no Neuve query hook.
test("the brief and the sandbox bridge omit scope reads when the host cannot run them", async () => {
	const run = await setup({ withoutQuery: true });
	const { agent } = await startBuild(run, ({ messages }) => {
		expect(policy(messages, async () => ({ content: [] }), undefined, { ownTools: true }).tools.map(tool => tool.name)).toContain("agent_start");
		expect(policy(messages, async () => ({ content: [] }), undefined, { ownTools: true }).tools.map(tool => tool.name)).not.toContain("neuve_query");
		return fauxAssistantMessage("Ready.");
	});
	const { text } = await agent.until("message");
	expect(text).toContain(planText);
	expect(text).not.toMatch(/neuve_query|neuve query/);
	expect(text).not.toContain(run.plans);
});

// All three roles call the same tool but only the reviewer reads its implementer's branch.
test("scope reads reach the host with the worktree, base, plan first and calling agent", async () => {
	const requests: Parameters<Parameters<typeof planScopeRead>[2]>[0][] = [];
	const run = await setup({ query: async request => {
		requests.push(request);
		return { query: request.question };
	} });
	const { chat, plan } = await startBuild(run);
	for (const [role, args] of [
		["reviewer", { role: "reviewer" }],
		["implementer", { role: "implementer", part: "parser", brief: "Implement the parser." }],
	] as const) {
		run.fixture.script(tool("agent_start", args, `start-${role}`), fauxAssistantMessage("Ready."), fauxAssistantMessage("Ready."));
		await run.fixture.request({ op: "wait", submission: await wake(run, "Start another agent.", chat) });
		await until(() => run.fixture.channel.isIdle());
	}
	const { builds } = await run.watch.until("builds", event => event.builds[0]?.agents.length === 3);
	const [primary, reviewer, second] = builds[0]!.agents;
	for (const [index, { chat: caller }] of [primary!, reviewer!, second!].entries()) {
		const question = `Read ${index}.`;
		const result = await askScope(run, caller, question, ["README.md"]);
		expect(result).toMatchObject({ error: false, text: JSON.stringify({ query: question }) });
		const worktree = run.worktrees[index]!;
		const planPath = requests[index]!.scope[0]!;
		expect(dirname(planPath)).toBe(run.plans);
		expect(await readFile(planPath, "utf8")).toBe(planText);
		expect(requests[index]).toEqual({
			repository: worktree.path, revision: worktree.base, question,
			...(index === 1 ? { branch: run.worktrees[0]!.branch } : {}),
			scope: [planPath, join(worktree.path, "README.md")],
			plan: { path: planPath, sha256: plan.hash },
			requester: { _tag: "Agent", harness: "neuve-pi", sessionId: "one", subagentId: String(caller) },
		});
	}
});

// An agent can read again in the same round or during fixes after a plan revision.
test("later and fix-round reads name the approved plan again", async () => {
	const named: string[] = [];
	let originalPath: string;
	const run = await setup({ query: async ({ question, scope }) => {
		named.push(await readFile(scope[0]!, "utf8"));
		originalPath ??= scope[0]!;
		return { query: question, scope: [{ title: originalPath, ref: { path: originalPath } }] };
	} });
	const { chat, plan } = await startBuild(run);
	expect((await askScope(run, chat, "First read")).error).toBe(false);
	await writeFile(originalPath!, "Changed outside the channel.");
	expect((await askScope(run, chat, "Later read")).error).toBe(false);
	const live = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	try {
		run.fixture.script(async () => {
			live.resolve();
			await release.promise;
			return fauxAssistantMessage("Ready for fixes.");
		});
		const submission = await wake(run, "Review requested changes.", chat);
		await live.promise;
		const revision = await run.draft(revisedText);
		await run.approve(revision);
		release.resolve();
		await run.fixture.request({ op: "wait", submission });
		await until(() => run.fixture.channel.isIdle());
		const result = await askScope(run, chat, "Fix-round read");
		expect(result.error).toBe(false);
		const label = `${plan.title} (${plan.hash})`;
		expect(JSON.parse(result.text).scope).toEqual([{ title: label, ref: { path: label } }]);
		expect(result.text).not.toContain(run.plans);
		expect(named).toEqual([planText, planText, revisedText]);
	} finally {
		release.resolve();
	}
});

// Closing after the memo commit but before the tool result forces pi to re-enter the original call.
test("a replayed scope call returns the saved answer and reads once", async () => {
	const asked: string[] = [];
	const saved = Promise.withResolvers<void>();
	let replay = false;
	const run = await setup({
		query: async ({ question }) => {
			asked.push(question);
			return { query: question };
		},
		wrapTool(tool) {
			if (tool.name !== "neuve_query") return tool;
			return { ...tool, async execute(args, api, context) {
				const result = await tool.execute(args, api, context);
				if (!replay) {
					replay = true;
					const interrupted = new Promise<void>(resolve => context.abortSignal?.addEventListener("abort", () => resolve(), { once: true }));
					saved.resolve();
					await interrupted;
					context.abortSignal?.throwIfAborted();
				}
				return result;
			} };
		},
	});
	const { chat } = await startBuild(run);
	run.fixture.script(tool("neuve_query", { question: "Find exports." }, "resume-scope"), fauxAssistantMessage("Read finished."));
	await wake(run, "Read scope.", chat);
	await saved.promise;
	await run.fixture.restart();
	const watch = await run.fixture.watch({ op: "watch", chat });
	expect(await watch.until("result", event => event.call === "resume-scope")).toMatchObject({ error: false, text: '{"query":"Find exports."}' });
	expect(asked).toEqual(["Find exports."]);
});

// A link swapped in at the plan read can point to bytes that match the approved hash.
test("scope restores the approved plan when a link is swapped in at open", async () => {
	const run = await setup();
	const { chat } = await startBuild(run);
	await askScope(run, chat, "Materialize the plan");
	const [file] = await fs.readdir(run.plans);
	const path = join(run.plans, file!);
	const outside = join(run.fixture.root, "outside.md");
	await writeFile(outside, planText);
	let swapped = false;
	const swap = async () => {
		swapped = true;
		await fs.unlink(path);
		await symlink(outside, path);
	};
	const lstat = fs.lstat;
	const open = fs.open;
	const beforeRead = spyOn(fs, "lstat").mockImplementation(async (...args) => {
		const entry = await lstat(...args);
		if (args[0] === path && !swapped) await swap();
		return entry;
	});
	const atOpen = spyOn(fs, "open").mockImplementation(async (...args) => {
		if (args[0] === path && !swapped) await swap();
		return open(...args);
	});
	try {
		expect(await askScope(run, chat, "Read the approved plan")).toMatchObject({ error: false });
	} finally {
		atOpen.mockRestore();
		beforeRead.mockRestore();
	}
	expect(swapped).toBe(true);
	expect((await lstat(path)).isFile()).toBe(true);
	expect(await readFile(path, "utf8")).toBe(planText);
});

// The query receives only bounded real paths and its public answer can cite the plan without exposing its folder.
test("scope paths reject escapes and scope answers redact plan paths from citations, gaps and errors", async () => {
	const calls: string[] = [];
	const run = await setup({ query: async ({ question, scope: [path] }) => {
		calls.push(question);
		if (question === "Broken read") throw new Error(`Could not read ${path}`);
		return { query: question, scope: [{ title: path, ref: { path } }], scope_gaps: [`${path}: The held copy could not be read.`], retrieval: { status: "error", error: `Could not read ${path}` } };
	} });
	const { chat, plan } = await startBuild(run);
	const outside = join(run.fixture.root, "outside.md");
	await writeFile(outside, "Private");
	await symlink(outside, join(run.worktrees[0]!.path, "escape.md"));
	await symlink(run.fixture.root, join(run.worktrees[0]!.path, "escape-dir"), "dir");
	const valid = await askScope(run, chat, "Read notes");
	const label = `${plan.title} (${plan.hash})`;
	expect(JSON.parse(valid.text)).toMatchObject({
		scope: [{ title: label, ref: { path: label } }],
		scope_gaps: [`${label}: The held copy could not be read.`],
		retrieval: { status: "error", error: `Could not read ${label}` },
	});
	expect(valid.text).not.toContain(run.plans);
	const broken = await askScope(run, chat, "Broken read");
	expect(broken).toMatchObject({ error: true, text: `The host could not read scope for question "Broken read" (Could not read ${label}). Ask the channel owner to check the worker before retrying.` });
	expect(broken.text).not.toContain(run.plans);
	const denied = await askScope(run, chat, "Read invalid paths", [outside, "escape.md", "bad\0path", "escape-dir/missing.md"]);
	expect(denied).toMatchObject({
		error: true,
		text: `scope[0] received ${JSON.stringify(outside)} outside the allowed roots and scope[1] received "escape.md" through a link and scope[2] received "bad\\u0000path" but paths cannot contain NUL bytes and scope[3] received "escape-dir/missing.md" through a link, so name files inside the repository, its worktrees or this channel's plans folder and name each linked file by a path with no link in it.`,
	});
	expect(calls).toEqual(["Read notes", "Broken read"]);
});

test.each(["file", "folder"] as const)("scope refuses an in-root linked %s", async (kind) => {
	const run = await setup();
	const { chat } = await startBuild(run);
	const { path } = run.worktrees[0]!;
	await Bun.write(join(path, "target", "notes.md"), "Scope fixture.");
	const name = kind === "file" ? "alias.md" : "alias/notes.md";
	await symlink(
		join(path, kind === "file" ? "target/notes.md" : "target"),
		join(path, kind === "file" ? name : "alias"),
	);
	const result = await askScope(run, chat, "Read linked scope", [name]);
	expect(result).toMatchObject({ error: true, text: expect.stringContaining(`scope[0] received ${JSON.stringify(name)} through a link`) });
});

// A reviewer can appear to start while reading another chat's context or getting a revision as its first input.
test("a reviewer starts fresh on the asking implementer's branch head", async () => {
		const held = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let startingReviewer = false;
	const run = await setup({
		onStep(step) {
			if (!startingReviewer || step !== "build.chat") return;
			startingReviewer = false;
			const conversation = run.harness.conversation.bind(run.harness);
			const lookup = spyOn(run.harness, "conversation").mockImplementationOnce(async (chat, context) => {
				lookup.mockRestore();
				held.resolve();
				await release.promise;
				return conversation(chat, context);
			});
		},
	});
	const { fixture } = run;
	const summary = "The channel summary contains an unrelated design.";
	const privateText = "An implementer's account must not reach the reviewer.";
	let implementerPrompt = "";
	let reviewerPrompt = "";
	let reviewerRoles: string[] = [];
	const answer: FauxResponseStep = request => {
		const messages = request.messages.filter(message => message.role !== "system");
		if (messages.length === 1) {
			reviewerRoles = messages.map(message => message.role);
			reviewerPrompt = getCurrentSystemPrompt(request.messages);
			return fauxAssistantMessage("Review started fresh.");
		}
		return fauxAssistantMessage("Reviewer requested.");
	};
	try {
		fixture.script(tool("channel", { summary }, "write-summary"), fauxAssistantMessage("Summary saved."));
		await fixture.request({ op: "wait", submission: await invoke(fixture, "Save the summary.") });
		const { build, chat, agent } = await startBuild(run, request => {
			implementerPrompt = getCurrentSystemPrompt(request.messages);
			return fauxAssistantMessage("Ready.");
		});
		await fixture.request({ op: "select", author: OWNER, chat, effort: "low" });
		const implementer = run.worktrees[0]!;
		git(implementer.path, "commit", "--allow-empty", "-m", "Review this work");
		const head = git(implementer.path, "rev-parse", "HEAD").trim();
		fixture.script(tool("agent_start", { role: "reviewer" }, "start-reviewer"));
		startingReviewer = true;
		const submission = await wake(run, privateText, chat);
		await held.promise;
		const revision = await run.draft(revisedText);
		await run.approve(revision);
		await agent.until("queue", event => event.messages.some(message => message.text === revisedText));
		fixture.script(answer, answer);
		release.resolve();
		expect(await fixture.request({ op: "wait", submission })).toBe("done");
		expect(await agent.until("result", event => event.call === "start-reviewer")).toMatchObject({ error: false, text: "The reviewer started." });
		const event = await run.watch.until("builds", event => event.builds[0]?.agents.some(agent => agent.role === "reviewer") ?? false);
		const reviewer = event.builds[0]!.agents.find(agent => agent.role === "reviewer")!;
		const watch = await fixture.watch({ op: "watch", chat: reviewer.chat });
		await watch.until("reply", event => event.text === "Review started fresh.");
		const message = await watch.until("message");
		expect(watch.of("message")).toEqual([message]);
		expect(message).toMatchObject({ system: { kind: "neuve:build:brief", build: build.id } });
		for (const text of [revision.title, revision.hash, revisedText, `Review the implementer's work on branch ${implementer.branch}.`, "neuve_query", "agent_message"]) {
			expect(message.text).toContain(text);
		}
		expect(message.text).not.toContain(run.plans);
		expect(message.text).not.toContain(privateText);
		expect(reviewerRoles).toEqual(["user"]);
		expect(implementerPrompt).toContain(summary);
		expect(reviewerPrompt).not.toContain(summary);
		expect(reviewerPrompt).not.toContain(privateText);
		const info = (await fixture.channel.info()).chats.find(chat => chat.id === reviewer.chat);
		const worktree = run.worktrees[1]!;
		expect(info).toMatchObject({ build: { id: build.id, role: "reviewer" }, model: MODEL, effort: "low", cwd: worktree.path });
		expect(info).not.toHaveProperty("parent");
		expect(git(worktree.path, "rev-parse", "HEAD").trim()).toBe(head);
		expect(git(worktree.path, "branch", "--show-current").trim()).not.toBe(implementer.branch);
	} finally {
		release.resolve();
	}
});

// The part could be recorded while the host loses the supplied brief or reuses the first worktree.
test("a second implementer gets its own branch, the approved model settings, and the asking agent's brief", async () => {
	const run = await setup();
	const { fixture } = run;
	const { plan, build, chat, agent } = await startBuild(run);
	await fixture.request({ op: "select", author: OWNER, chat, effort: "low" });
	const brief = "Build the export parser and exercise its failure path.";
	fixture.script(tool("agent_start", { role: "implementer", part: "parser", brief }, "start-part"),
		fauxAssistantMessage("Ready for the part."), fauxAssistantMessage("Ready for the part."));
	await fixture.request({ op: "wait", submission: await wake(run, "Start the parser work.", chat) });
	expect(await agent.until("result", event => event.call === "start-part")).toMatchObject({
		error: false, text: "The implementer for parser started.",
	});
	const event = await run.watch.until("builds", event => event.builds[0]?.agents.length === 2);
	const started = event.builds[0]!.agents[1]!;
	expect(started).toMatchObject({ by: chat, role: "implementer", part: "parser" });
	const worktree = run.worktrees[1]!;
	expect(worktree.path).not.toBe(run.worktrees[0]!.path);
	expect(git(worktree.path, "branch", "--show-current").trim()).toBe(worktree.branch);
	expect(worktree.branch).not.toBe(run.worktrees[0]!.branch);
	const watch = await fixture.watch({ op: "watch", chat: started.chat });
	const message = await watch.until("message");
	expect(message).toMatchObject({ system: { kind: "neuve:build:brief", build: build.id } });
	for (const text of [plan.title, plan.hash, planText, worktree.branch, "neuve_query", "Load the Neuve skill."]) expect(message.text).toContain(text);
	expect(message.text).not.toContain(run.plans);
	expect(message.text.split("\n\n").at(-1)).toBe(brief);
	const info = (await fixture.channel.info()).chats.find(chat => chat.id === started.chat);
	expect(info).toMatchObject({ effort: "high", model: MODEL, cwd: worktree.path, build: { id: build.id, role: "implementer", part: "parser" } });
	expect(info).not.toHaveProperty("parent");
	await until(() => fixture.channel.isIdle());

	const requestReview = async (from: number, part: string, branch: string) => {
		fixture.script(tool("agent_start", { role: "reviewer", part }, `review-${part}`),
			fauxAssistantMessage("Ready to review."), fauxAssistantMessage("Ready to review."));
		await fixture.request({ op: "wait", submission: await wake(run, "Ask for a reviewer.", from) });
		const event = await run.watch.until("builds", event => event.builds[0]?.agents.some(agent => agent.role === "reviewer" && agent.part === part) ?? false);
		const reviewer = event.builds[0]!.agents.find(agent => agent.role === "reviewer" && agent.part === part)!;
		const watch = await fixture.watch({ op: "watch", chat: reviewer.chat });
		expect((await watch.until("message")).text).toContain(`Review the implementer's work on branch ${branch}.`);
		await until(() => fixture.channel.isIdle());
		return reviewer.chat;
	};
	const reviewer = await requestReview(started.chat, "parser", worktree.branch);
	await requestReview(reviewer, "whole plan", run.worktrees[0]!.branch);
});

// A sealed schema alone cannot enforce which fields are valid for a role or who may ask.
test("agent start refuses invalid arguments, duplicate roles, and callers outside the build", async () => {
	const run = await setup();
	const { fixture } = run;
	const { chat, agent } = await startBuild(run);
	const refuse = async (watch: Watch, chat: number, call: string, args: Record<string, string>, reason: string) => {
		fixture.script(tool("agent_start", args, call), fauxAssistantMessage("No agent started."));
		await fixture.request({ op: "wait", submission: await (watch === agent ? wake(run, "Ask for an agent.", chat) : invoke(fixture, "Ask for an agent.", chat)) });
		const result = await watch.until("result", event => event.call === call);
		expect(result.error).toBe(true);
		expect(result.text).toContain(reason);
	};
	await refuse(agent, chat, "reviewer-brief", { role: "reviewer", brief: "My account." }, "The host writes the reviewer's brief.");
	await refuse(agent, chat, "missing-part", { role: "implementer", brief: "Write tests." }, "Give the implementer a path scope.");
	await refuse(agent, chat, "missing-brief", { role: "implementer", part: "parser" }, "Give the implementer a brief.");
	await refuse(agent, chat, "unknown-model", { role: "reviewer", model: "other" }, "must not have additional properties");
	fixture.script(tool("agent_start", { role: "reviewer" }, "first-reviewer"),
		fauxAssistantMessage("Ready to review."), fauxAssistantMessage("Ready to review."));
	await fixture.request({ op: "wait", submission: await wake(run, "Ask for a reviewer.", chat) });
	await until(() => fixture.channel.isIdle());
	await refuse(agent, chat, "duplicate-role", { role: "reviewer" }, "This plan already has an agent with that role and path scope.");
	const other = await fixture.request<{ chat: number }>({ op: "chat", author: OWNER });
	await refuse(await fixture.watch({ op: "watch", chat: other.chat }), other.chat, "not-agent", { role: "reviewer" },
		"Only an agent of a plan can ask the host to start another agent.");
	await run.harness.commit(tx => setChatMode(tx, ROOT_CONVERSATION_ID, "plan"), context);
	await refuse(run.watch, 1, "planning-start", { role: "reviewer" }, "Plan mode is read-only. The agent_start tool is unavailable in plan mode.");
	// The ordinary writing chat also gets placement, without becoming a plan agent.
	expect(run.worktrees).toHaveLength(3);
	expect(run.worktrees[2]?.branch).toBe(`one/chat-${other.chat}`);
	expect((await fixture.channel.info()).chats.filter(chat => chat.build)).toHaveLength(2);
});

// A worktree failure could reserve the reviewer's role and part permanently.
test("retrying a failed reviewer start creates one reviewer for that part", async () => {
	let fail = false;
	const run = await setup({ async beforeWorktree() { if (fail) throw new Error("Worktree unavailable"); } });
	const { fixture, watch } = run;
	const { chat, agent } = await startBuild(run);
	const args = { role: "reviewer", part: "exports" };
	fail = true;
	fixture.script(tool("agent_start", args, "fail-reviewer"), fauxAssistantMessage("The worktree failed."));
	await fixture.request({ op: "wait", submission: await wake(run, "Start the reviewer.", chat) });
	expect(await agent.until("result", event => event.call === "fail-reviewer")).toMatchObject({
		error: true, text: "The reviewer's worktree could not be created.",
	});

	fail = false;
	fixture.script(tool("agent_start", args, "retry-reviewer"), fauxAssistantMessage("Ready."), fauxAssistantMessage("Ready."));
	await fixture.request({ op: "wait", submission: await wake(run, "Retry the reviewer.", chat) });
	expect(await agent.until("result", event => event.call === "retry-reviewer")).toMatchObject({
		error: false, text: "The reviewer for exports started.",
	});
	await until(() => fixture.channel.isIdle());
	const agents = watch.of("builds").at(-1)?.builds[0]?.agents;
	expect(agents).toMatchObject([{ chat, role: "implementer" }, { role: "reviewer", part: "exports" }]);
	const transcript = await fixture.watch({ op: "watch", chat: agents![1]!.chat });
	expect(transcript.of("message").map(event => event.system?.kind)).toEqual(["neuve:build:brief"]);
	expect(run.worktrees).toHaveLength(2);
});

// Channel recovery and pi's replay of this call can both see the same unfinished start.
test("reopening during an agent start replays the same call and sends one brief", async () => {
	const tasks: number[] = [];
	let interrupt = false;
	const closed = Promise.withResolvers<void>();
	const run = await setup({
		onStep(step) {
			if (interrupt && step === "build.worktree") {
				interrupt = false;
				void run.fixture.channel.close().then(closed.resolve, closed.reject);
			}
		},
		wrapTool(tool) {
			if (tool.name !== "agent_start") return tool;
			return {
				...tool,
				async execute(args, api, context) {
					tasks.push(api.taskId);
					return tool.execute(args, api, context);
				},
			};
		},
	});
	const { chat } = await startBuild(run);
	interrupt = true;
	run.fixture.script(tool("agent_start", { role: "reviewer" }, "restart-reviewer"),
		fauxAssistantMessage("Recovered."), fauxAssistantMessage("Recovered."));
	await wake(run, "Ask for a reviewer.", chat);
	await closed.promise;
	await run.fixture.restart();
	const agent = await run.fixture.watch({ op: "watch", chat });
	expect(await agent.until("result", event => event.call === "restart-reviewer")).toMatchObject({ error: false, text: "The reviewer started." });
	expect(tasks).toEqual([tasks[0]!, tasks[0]!]);
	expect(run.worktrees).toHaveLength(2);
	const chats = (await run.fixture.channel.info()).chats;
	expect(chats).toHaveLength(3);
	const review = await run.fixture.watch({ op: "watch", chat: chats.find(chat => chat.build?.role === "reviewer")!.id });
	await review.until("reply", event => event.text === "Recovered.");
	expect(review.of("message")).toHaveLength(1);
});

// A state update that submits input could wake a chat on its own.
test("a build agent's question, answer, and captions update the work log without new input", async () => {
	const captions = fauxProvider({ provider: MODEL.provider, models: [{ id: MODEL.modelId }], tokensPerSecond: 100_000 });
	const captionModels = createModels();
	captionModels.setProvider(captions.provider);
	const run = await setup({ nonTurnModels: () => captionModels });
	const { fixture, watch } = run;
	const finish = Promise.withResolvers<void>();
	try {
		const { chat, agent } = await startBuild(run);
		await watch.until("builds", event => event.builds[0]?.agents[0]?.state === "done");
		const offset = watch.events.length;
		captions.appendResponses([
			fauxAssistantMessage("Checking the export approach"),
			fauxAssistantMessage("Checked the export approach"),
			fauxAssistantMessage("Asked which export approach to take."),
		]);
		fixture.script(
			question("ask-approach"),
			async () => {
				await finish.promise;
				return fauxAssistantMessage("I will change one export path.");
			},
		);
		const submission = await wake(run, "Ask which export approach to take.", chat);
		const awaiting = await agent.until("caption", event => event.text === "Checking the export approach");
		const state = (expected: Build["agents"][number]["state"], after: number, caption?: string) => until(() => watch.events
			.slice(after)
			.find(event => event.kind === "builds" && event.builds[0]?.agents.some(agent =>
				agent.chat === chat && agent.state === expected && (caption === undefined || agent.caption === caption))));
		const running = await state("running", offset);
		const waiting = await state("waiting", watch.events.indexOf(running), awaiting.text);
		await fixture.request({ op: "answer", author: OWNER, chat, call: "ask-approach", answers: [{ choices: [0] }] });
		const answered = await state("running", watch.events.indexOf(waiting));
		finish.resolve();
		expect(await fixture.request({ op: "wait", submission })).toBe("done");
		const latest = await agent.until("caption", event => event.text === "Checked the export approach");
		await state("done", watch.events.indexOf(answered), latest.text);
		expect(agent.of("message").map(message => message.system?.kind ?? message.text)).toEqual([
			"neuve:build:brief", "Ask which export approach to take.",
		]);
		expect(watch.of("message").map(message => message.text)).toEqual(["Write the plan."]);
	} finally {
		finish.resolve();
	}
});

// An overly broad read-only guard could reject reactions or block an agent awaiting a decision.
test("build chat routes refuse writes and allow reactions, approval answers, and skips", async () => {
	const run = await setup();
	const { fixture } = run;
	const { chat, plan, agent } = await startBuild(run);
	const brief = agent.of("message")[0]!;
	const requests = [
		{ op: "say", text: "A message." },
		{ op: "ask", text: "A message." },
		{ op: "plan-comment", plan: plan.id, hash: plan.hash, lines: [{ line: 1, text: plan.title }], quote: plan.title, text: "A note." },
		{ op: "plan-comment-reply", comment: "comment", text: "A reply." },
		{ op: "plan-comment-edit", comment: "comment", text: "An edit." },
		{ op: "plan-comment-remove", comment: "comment" },
		{ op: "plan-comments-send", plan: plan.id },
		{ op: "edit", entry: brief.entry, text: "An edit." },
		{ op: "delete", entry: brief.entry },
	] satisfies Partial<Request>[];
	for (const request of requests) {
		for (const author of [OWNER, "agent@another-channel"]) {
			await expect(fixture.request({ ...request, chat, author })).rejects.toThrow("An agent's chat is read-only.");
		}
	}
	await fixture.request({ op: "react", author: OWNER, chat, entry: brief.entry, emoji: "👍" });
	expect(await agent.until("reactions", event => !!event.reactions[brief.entry])).toBeDefined();
	await run.harness.commit(async tx => {
		(await tx.doc(ApprovalRequestsDoc, chat as ConversationId)).requests.push({
			requestId: "review-command", callId: "command", work: "command", input: { command: "pwd" },
			asked: { kind: "unrecognised" }, openedAt: Date.now(), state: { kind: "open" },
		});
	}, context);
	await fixture.request({ op: "approval-answer", chat, author: OWNER, requestId: "review-command", decision: "allow" });
	await agent.until("approval-requests", event => event.requests.some(request =>
		request.requestId === "review-command" && request.state.kind === "answered"));
	fixture.script(question("pick-exports"), fauxAssistantMessage("Continuing."));
	const submission = await wake(run, "Check the exports.", chat);
	await run.watch.until("builds", event => event.builds[0]?.agents[0]?.state === "waiting");
	await fixture.request({ op: "skip", chat, author: OWNER, call: "pick-exports" });
	expect(await fixture.request({ op: "wait", submission })).toBe("done");
	expect(agent.of("message").map(event => event.system?.kind ?? event.text)).toEqual([
		"neuve:build:brief", "Check the exports.",
	]);
});

// A failed or stopped run could leave the card showing an agent as still working.
test("the work log distinguishes a failed run from a person's stop", async () => {
	const run = await setup();
	const { fixture, watch } = run;
	const { chat, agent } = await startBuild(run);
	fixture.script(fauxAssistantMessage("", { stopReason: "error", errorMessage: "The export failed." }));
	const failed = await wake(run, "Try the export.", chat);
	expect(await fixture.request({ op: "wait", submission: failed })).toBe("unanswered");
	await watch.until("builds", event => event.builds[0]?.agents[0]?.state === "failed");

	fixture.script(tool("bash", { command: "until test -f done; do sleep .02; done" }, "stop-export"));
	const stopped = await wake(run, "Keep checking the export.", chat);
	await agent.until("tool", event => event.call === "stop-export");
	await fixture.request({ op: "stop", author: OWNER, chat });
	expect(await fixture.request({ op: "wait", submission: stopped })).toBe("unanswered");
	await watch.until("builds", event => event.builds[0]?.agents[0]?.state === "stopped");
	expect((await agent.until("stopped")).author).toBe(OWNER);
	fixture.script(fauxAssistantMessage("Export checked."));
	const followUp = await wake(run, "Check the export again.", chat);
	expect(await fixture.request({ op: "wait", submission: followUp })).toBe("done");
	await agent.until("reply", event => event.text === "Export checked.");
});

// Stopping the visible agents could leave a child shell running or leave the build eligible for revisions.
test("stop-all ends the build and its child work, and a later approval starts a new agent", async () => {
	const run = await setup();
	const { fixture, watch } = run;
	const { build, chat, agent, reviewer } = await startPair(run);
	fixture.script(tool("subagent", { task: "Check the queue." }, "check-queue"),
		tool("bash", { command: "until test -f release-child; do sleep .02; done" }, "child-shell"));
	const implementation = await wake(run, "Check the queue.", chat);
	const child = await until(async () => (await fixture.channel.info()).chats.find(item => item.parent === chat && item.busy));
	const childWatch = await fixture.watch({ op: "watch", chat: child.id });
	await childWatch.until("tool", event => event.call === "child-shell");
	fixture.script(tool("bash", { command: "until test -f release-review; do sleep .02; done" }, "review-shell"));
	const review = await wake(run, "Review the queue.", reviewer);
	const reviewerWatch = await fixture.watch({ op: "watch", chat: reviewer });
	await reviewerWatch.until("tool", event => event.call === "review-shell");
	const stop = { op: "build-stop", build: build.id, author: OWNER } as const;
	await expect(fixture.request({ ...stop, author: "agent@other" })).rejects.toThrow("Only a person can stop the plan's agents.");
	await expect(fixture.request({ ...stop, author: "teammate" })).rejects.toThrow("only its owner");
	await expect(fixture.request({ ...stop, build: `1:${"0".repeat(64)}` })).rejects.toThrow("This plan has no agents to stop.");
	await fixture.request(stop);
	for (const submission of [implementation, review]) expect(await fixture.request({ op: "wait", submission })).toBe("unanswered");
	expect((await fixture.channel.info()).chats.find(item => item.id === child.id)?.busy).toBe(false);
	const stopped = await buildAt(watch, 0, "stopped");
	expect(stopped.state).toEqual({ kind: "stopped", by: OWNER, at: expect.any(Number) });
	expect(stopped.agents.map(agent => agent.state)).toEqual(["stopped", "stopped"]);
	for (const transcript of [agent, reviewerWatch]) await transcript.until("stopped");
	const attached = await fixture.watch({ op: "watch", builds: true });
	const cursor = attached.of("builds").length;
	await fixture.request(stop);
	expect(attached.of("builds")).toHaveLength(cursor);
	expect(agent.of("stopped")).toHaveLength(1);
	expect(reviewerWatch.of("stopped")).toHaveLength(1);
	const revision = await run.draft(revisedText);
	fixture.script(fauxAssistantMessage("New build ready."));
	await run.approve(revision);
	expect((await buildAt(watch, 1, "started")).agents[0]?.chat).not.toBe(chat);
});

// Sharing can interrupt the current tool, and unsharing can start a new run when no input is pending.
test("sharing pauses new tools and unsharing without pending input does not wake the build", async () => {
	const run = await setup();
	const { fixture, watch } = run;
	const { chat, agent } = await startBuild(run);
	const path = run.worktrees[0]!.path;
	fixture.script(tool("bash", { command: "touch entered; until test -f release; do sleep .02; done" }, "live-shell"));
	const work = await wake(run, "Check the queue.", chat);
	await until(async () => readFile(join(path, "entered")).then(() => true, () => false));
	await fixture.request({ op: "share", author: OWNER, shared: true });
	expect((await buildAt(watch, 0, "paused")).state).toEqual({ kind: "paused", reason: "shared" });
	expect(agent.of("result").some(event => event.call === "live-shell")).toBe(false);
	fixture.script(tool("write", { path: "after.txt", content: "Next step." }, "paused-write"), fauxAssistantMessage("Paused."));
	await writeFile(join(path, "release"), "");
	expect(await agent.until("result", event => event.call === "live-shell")).toMatchObject({ error: false });
	expect(await agent.until("result", event => event.call === "paused-write")).toMatchObject({ error: true, text: "The plan's agents are paused while other people may ask them." });
	expect(await fixture.request({ op: "wait", submission: work })).toBe("done");
	const count = fixture.faux.state.callCount;
	const cursor = watch.events.length;
	await fixture.request({ op: "share", author: OWNER, shared: false });
	await until(() => watch.events.slice(cursor).find(event => event.kind === "builds" && event.builds[0]?.state.kind === "started"));
	await until(() => fixture.channel.isIdle());
	expect(fixture.faux.state.callCount).toBe(count);
	fixture.script(tool("write", { path: "after.txt", content: "Next step." }, "resumed-write"), fauxAssistantMessage("Resumed."));
	await fixture.request({ op: "wait", submission: await wake(run, "Continue.", chat) });
	expect(await readFile(join(path, "after.txt"), "utf8")).toBe("Next step.");
});

// A worktree can finish while the build is paused and accidentally wake a new agent.
test("clearing a pause finishes an already authorized start", async () => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const run = await setup({ async beforeWorktree() { entered.resolve(); await release.promise; } });
	try {
		await run.approve(await run.draft(planText));
		await entered.promise;
		await run.fixture.request({ op: "share", author: OWNER, shared: true });
		await buildAt(run.watch, 0, "paused");
		release.resolve();
		await until(() => run.fixture.channel.isIdle());
		expect((await run.fixture.channel.info()).chats).toHaveLength(1);
		run.fixture.script(fauxAssistantMessage("Ready."));
		await run.fixture.request({ op: "share", author: OWNER, shared: false });
		expect((await buildAt(run.watch, 0, "started")).agents).toHaveLength(1);
		expect(run.worktrees).toHaveLength(1);
	} finally {
		release.resolve();
	}
});

// Unsharing can join the paused start just before it returns without sending the brief.
test("unsharing while a paused start is settling sends its brief once", async () => {
	const worktree = Promise.withResolvers<void>();
	const releaseWorktree = Promise.withResolvers<void>();
	const paused = Promise.withResolvers<void>();
	const settle = Promise.withResolvers<void>();
	const joined = Promise.withResolvers<void>();
	const run = await setup({
		async beforeWorktree() { worktree.resolve(); await releaseWorktree.promise; },
		async beforeSharedResult() { paused.resolve(); await settle.promise; },
		onSharedWait: joined.resolve,
	});
	const { fixture, watch } = run;
	try {
		await run.approve(await run.draft(planText));
		await worktree.promise;
		await fixture.request({ op: "share", author: OWNER, shared: true });
		releaseWorktree.resolve();
		await paused.promise;
		fixture.script(fauxAssistantMessage("Ready."));
		await fixture.request({ op: "share", author: OWNER, shared: false });
		await joined.promise;
		settle.resolve();
		await until(() => fixture.channel.isIdle());
		expect((await fixture.channel.info()).chats).toHaveLength(2);
		const { agents: [agent] } = await buildAt(watch, 0, "started");
		const transcript = await fixture.watch({ op: "watch", chat: agent!.chat });
		await transcript.until("reply", event => event.text === "Ready.");
		expect(transcript.of("message").map(event => event.system?.kind)).toEqual(["neuve:build:brief"]);
	} finally {
		releaseWorktree.resolve();
		settle.resolve();
	}
});

async function startReviewer(run: Awaited<ReturnType<typeof setup>>, implementer: number) {
	const { fixture } = run;
	fixture.script(tool("agent_start", { role: "reviewer", part: "exports" }, "start-exports-review"),
		fauxAssistantMessage("Ready."), fauxAssistantMessage("Ready."));
	await fixture.request({ op: "wait", submission: await wake(run, "Start the exports reviewer.", implementer) });
	await until(() => fixture.channel.isIdle());
	const event = await run.watch.until("builds", event => event.builds[0]?.agents.some(agent => agent.role === "reviewer") ?? false);
	return event.builds[0]!.agents.find(agent => agent.role === "reviewer")!.chat;
}

async function startPair(run: Awaited<ReturnType<typeof setup>>) {
	const first = await startBuild(run);
	return { ...first, reviewer: await startReviewer(run, first.chat) };
}

const failedResponse = () => fauxAssistantMessage("", {
	stopReason: "error", errorMessage: "Private provider body",
});

// Reason: exhausting a plan agent's retries must be visible and wake the other agents of that plan.
test("build failure records an exhausted turn and tells the reviewer and planning chat once", async () => {
	const run = await setup();
	const { fixture, watch } = run;
	const { build, chat, reviewer } = await startPair(run);
	const reviewerWatch = await fixture.watch({ op: "watch", chat: reviewer });
	const at = Date.now();
	fixture.script({
		...failedResponse(),
		diagnostics: [{
			type: TURN_RETRY_FAILURE, timestamp: at,
			details: { turn: "failed-logical-turn", reason: "retry-budget-exhausted", attempt: 5 },
		}],
	}, fauxAssistantMessage("Planning heard the failure."), fauxAssistantMessage("Review heard the failure."));
	const submission = await wake(run, "Finish the export queue.", chat);
	expect(await fixture.request({ op: "wait", submission })).toBe("unanswered");
	const log = await watch.until("builds", event => event.messages.some(message =>
		message.kind === "agent-failure" && message.deliveries.every(delivery => delivery.status === "sent")));
	const failure = { role: "implementer", at, turn: "failed-logical-turn", reason: "retry-budget-exhausted", attempts: 6 };
	expect(log.builds[0]).toMatchObject({ state: { kind: "started" }, agents: [
		{ chat, state: "failed", failure }, { chat: reviewer },
	] });
	const lane = run.worktrees[0]!.branch.split("/").at(-1);
	const text = `Failed after 6 attempts. The implementer was working in lane "${lane}" on branch "${run.worktrees[0]!.branch}". Review the work there and decide what to do next.`;
	expect(log.messages).toEqual([{
		kind: "agent-failure", build: build.id, from: chat, to: build.chat, at, text, failure,
		deliveries: [{ to: build.chat, status: "sent" }, { to: reviewer, status: "sent" }],
	}]);
	expect(EventSchema.parse(JSON.parse(JSON.stringify(log)))).toEqual(log);
	await until(() => fixture.channel.isIdle());
	for (const recipient of [watch, reviewerWatch]) {
		expect(recipient.of("message").filter(message => message.text === text)).toEqual([
			expect.objectContaining({ invoked: true, author: `agent@${chat}` }),
		]);
	}
	expect(JSON.stringify(log)).not.toContain("Private provider body");
});

// Reason: a failed notice turn must tell the planner in plain language without waking other build agents.
test("build failure sends a reviewer's failed notice turn only to the planning chat", async () => {
	const run = await setup();
	const { fixture, watch } = run;
	const { build, chat, agent, reviewer } = await startPair(run);
	const reviewing = await fixture.watch({ op: "watch", chat: reviewer });
	const calls = fixture.faux.state.callCount;
	const receiveNotice: FauxResponseStep = ({ messages }) =>
		messages.some(message => message.role === "user" && typeof message.content === "string"
			&& message.content.includes("Review the implementer's work on branch"))
			? failedResponse()
			: fauxAssistantMessage("Planning heard the failure.");
	fixture.script(failedResponse(), receiveNotice, receiveNotice, failedResponse(),
		fauxAssistantMessage("Another notice arrived."));
	const submission = await wake(run, "Finish the export queue.", chat);
	expect(await fixture.request({ op: "wait", submission })).toBe("unanswered");
	const failure = await watch.until("builds", event => event.messages.some(message =>
		message.kind === "agent-failure" && message.from === reviewer));
	expect(failure.builds[0]?.agents[1]).toMatchObject({
		chat: reviewer, state: "failed", failure: { role: "reviewer", part: "exports", reason: "model_error", attempts: 1 },
	});
	await until(() => fixture.channel.isIdle());
	const log = watch.of("builds").at(-1)!;
	expect(log.messages).toEqual([
		expect.objectContaining({ kind: "agent-failure", from: chat, deliveries: [
			{ to: build.chat, status: "sent" }, { to: reviewer, status: "sent" },
		] }),
		expect.objectContaining({ kind: "agent-failure", from: reviewer, deliveries: [
			{ to: build.chat, status: "sent" },
		] }),
	]);
	for (const recipient of [watch, reviewing]) {
		expect(recipient.of("message").filter(message => message.text === log.messages[0]!.text)).toEqual([
			expect.objectContaining({ invoked: true, author: `agent@${chat}` }),
		]);
	}
	const text = log.messages[1]!.text;
	expect(text).toContain("Failed without an answer.");
	expect(text).not.toContain("model_error");
	expect(watch.of("message").filter(message => message.author === `agent@${reviewer}`)).toEqual([
		expect.objectContaining({ invoked: true, text }),
	]);
	expect(agent.of("message").filter(message => message.author === `agent@${reviewer}`)).toEqual([]);
	expect(fixture.faux.state.callCount).toBe(calls + 4);
	await fixture.restart();
	await until(() => fixture.channel.isIdle());
	const reopened = await fixture.watch({ op: "watch", builds: true });
	expect(reopened.of("builds").at(-1)?.messages).toEqual(log.messages);
	expect(fixture.faux.state.callCount).toBe(calls + 4);
});

// Reason: restart must recover both an unrecorded run ending and a missing delivery receipt without invoking twice.
test("build failure retries a failed delivery across restart without invoking twice", async () => {
	let interrupted = false;
	const missedEnding = Promise.withResolvers<void>();
	const run = await setup({
		onStep(step) {
			if (step === "build.agent.end.failed") missedEnding.resolve();
			if (step !== "build.message.submitted" || interrupted) return;
			interrupted = true;
			const commit = spyOn(run.harness, "commit").mockImplementationOnce(async () => {
				commit.mockRestore();
				throw new Error("The work log write was interrupted.");
			});
		},
	});
	const { fixture } = run;
	const { build, chat, reviewer } = await startPair(run);
	const originalCommit = run.harness.commit.bind(run.harness);
	const skipEnding = spyOn(run.harness, "commit").mockImplementation((change, scope) => originalCommit(async tx => {
		const result = await change(tx);
		const agent = (await tx.doc(BuildsDoc)).records[build.id]?.build.agents[0];
		if (agent?.failure) {
			skipEnding.mockRestore();
			throw new Error("The worker closed after Pi settled the failed turn.");
		}
		return result;
	}, scope));
	fixture.script({
		...failedResponse(),
		diagnostics: [{
			type: TURN_RETRY_FAILURE, timestamp: Date.now(),
			details: { turn: "ended-before-projection", reason: "unsafe-continuation", attempt: 2 },
		}],
	}, fauxAssistantMessage("Planning heard the failure."), fauxAssistantMessage("Review heard the failure."));
	const submission = await wake(run, "Finish the export queue.", chat);
	expect(await fixture.request({ op: "wait", submission })).toBe("unanswered");
	await missedEnding.promise;
	await fixture.restart();
	await until(() => fixture.channel.isIdle());
	const watch = await fixture.watch({ op: "watch", builds: true });
	const pending = watch.of("builds").at(-1)!;
	expect(pending.messages).toHaveLength(1);
	expect(pending.messages[0]).toMatchObject({
		kind: "agent-failure", deliveries: [{ to: build.chat, status: "failed" }, { to: reviewer, status: "sent" }],
	});
	const calls = fixture.faux.state.callCount;
	await fixture.restart();
	const reopened = await fixture.watch({ op: "watch", builds: true });
	const log = await reopened.until("builds", event => event.messages.some(message =>
		message.kind === "agent-failure" && message.deliveries.every(delivery => delivery.status === "sent")));
	expect(log.messages).toEqual([{
		...pending.messages[0],
		deliveries: [{ to: build.chat, status: "sent" }, { to: reviewer, status: "sent" }],
	}]);
	expect(log.builds[0]?.agents[0]?.failure).toMatchObject({
		turn: "ended-before-projection", reason: "unsafe-continuation", attempts: 3,
	});
	const reviewerWatch = await fixture.watch({ op: "watch", chat: reviewer });
	for (const recipient of [reopened, reviewerWatch]) {
		expect(recipient.of("message").filter(message => message.text === log.messages[0]!.text)).toHaveLength(1);
	}
	expect(fixture.faux.state.callCount).toBe(calls);
});

// Reason: a person's Stop and runtime cancellation must not become failure handoffs.
test("build failure handoff ignores a person's Stop and runtime cancellation", async () => {
	const run = await setup();
	const { fixture, watch } = run;
	const { chat, agent, reviewer } = await startPair(run);
	const release = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	fixture.script(async () => {
		entered.resolve();
		await release.promise;
		return failedResponse();
	});
	try {
		const submission = await wake(run, "Finish the export queue.", chat);
		await entered.promise;
		const stop = fixture.request({ op: "stop", chat, author: OWNER });
		await until(() => run.harness.commit(tx => tx.scanTasks({ conversationId: chat as ConversationId, abortRequested: true }, 1), context)
			.then(page => page.items.length));
		release.resolve();
		await stop;
		expect(await fixture.request({ op: "wait", submission })).toBe("unanswered");
		await agent.until("stopped");
		const ended = await watch.until("builds", event => event.builds[0]?.agents[0]?.state === "stopped");
		expect(ended.builds[0]?.agents[0]?.failure).toBeUndefined();
		expect(ended.messages).toEqual([]);
		fixture.script({
			...failedResponse(),
			stopReason: "aborted",
			diagnostics: [{ type: TURN_CANCELLED, timestamp: Date.now() }],
		});
		const cancelled = await wake(run, "Continue the export queue.", chat);
		expect(await fixture.request({ op: "wait", submission: cancelled })).toBe("unanswered");
		await until(() => fixture.channel.isIdle());
		expect(watch.of("builds").at(-1)?.messages).toEqual([]);
		const reviewerWatch = await fixture.watch({ op: "watch", chat: reviewer });
		expect(reviewerWatch.of("message").map(message => message.system?.kind)).toEqual(["neuve:build:brief"]);
	} finally {
		release.resolve();
	}
});

// Reason: success after an unanswered turn clears the agent's current failure while keeping the work log.
test("build failure clears on the agent's later success and remains in the log", async () => {
	const run = await setup();
	const { fixture, watch } = run;
	const { reviewer } = await startPair(run);
	fixture.script(failedResponse(), fauxAssistantMessage("Planning heard the failure."), fauxAssistantMessage("Implementation heard the failure."));
	const failed = await wake(run, "Review the export queue.", reviewer);
	expect(await fixture.request({ op: "wait", submission: failed })).toBe("unanswered");
	const notice = await watch.until("builds", event => event.messages.some(message =>
		message.kind === "agent-failure" && message.deliveries.every(delivery => delivery.status === "sent")));
	expect(notice.builds[0]?.agents[1]?.failure).toMatchObject({ role: "reviewer", part: "exports", attempts: 1 });
	await until(() => fixture.channel.isIdle());
	const cursor = watch.events.length;
	fixture.script(fauxAssistantMessage("The review is complete."));
	const successful = await wake(run, "Continue the review.", reviewer);
	expect(await fixture.request({ op: "wait", submission: successful })).toBe("done");
	const recovered = await until(() => watch.events.slice(cursor).find(event =>
		event.kind === "builds" && event.builds[0]?.agents[1]?.state === "done" && !event.builds[0]?.agents[1]?.failure));
	expect(recovered).toMatchObject({ messages: notice.messages });
});

// Only the agent chat's queue and transcript show whether duplicate targets turn into extra steers.
test("a say mention steers each distinct plan agent as the person without announcing it again", async () => {
	const run = await setup();
	const { fixture } = run;
	const { chat, agent, reviewer } = await startPair(run);
	const target = await fixture.watch({ op: "watch", chat: reviewer });
	const folder = run.worktrees[1]!.path;
	fixture.script(tool("bash", { command: "until test -f release-mention; do sleep .02; done" }, "mention-shell"));
	const working = await wake(run, "Check the exports.", reviewer);
	await target.until("tool", event => event.call === "mention-shell");
	const text = "Hold the final review for @teammate.";
	const request = {
		op: "say" as const, author: OWNER, text, agents: [reviewer, chat, reviewer], requestId: "mention:hold",
		files: [{ name: "thread-only.txt", text: "The attachment belongs in the thread." }],
	};
	const before = run.runs.filter(value => value.chat === chat).length;
	fixture.script(fauxAssistantMessage("I will hold."), fauxAssistantMessage("I will hold."));
	const receipt = await fixture.request(request);
	expect(await fixture.request(request)).toEqual(receipt);
	const queued = await target.until("queue", event => event.messages.some(message => message.text === text));
	expect(queued.messages).toEqual([{ submission: expect.any(Number), author: OWNER, text, invoked: true }]);
	await agent.until("reply", event => event.text === "I will hold.");
	expect(target.of("result").some(event => event.call === "mention-shell")).toBe(false);
	await writeFile(join(folder, "release-mention"), "");
	await target.until("reply", event => event.text === "I will hold.");
	for (const [recipient, transcript] of [[reviewer, target], [chat, agent]] as const) {
		const delivered = await run.harness.commit(
			tx => tx.submissionByRequest(recipient as ConversationId, `neuve.build:mention:1:mention:hold:${recipient}`), context,
		);
		const messages = transcript.of("message").filter(message => message.text === text);
		expect(messages).toEqual([{
			kind: "message", chat: recipient, entry: delivered?.entry, author: OWNER, text, invoked: true, at: expect.any(Number),
		}]);
	}
	const original = await (await run.harness.submission(working, context))?.status(context);
	const steer = await (await run.harness.submission(queued.messages[0]!.submission as SubmissionId, context))?.status(context);
	expect(steer).toMatchObject({ status: "done", answer: original?.answer });
	await fixture.channel.close();
	expect(run.said.filter(value => value.chat === reviewer).map(value => value.author)).toEqual([OWNER]);
	expect(run.said.filter(value => value.chat === chat).some(value => value.mentions?.includes("teammate"))).toBe(false);
	expect(run.runs.filter(value => value.chat === chat)).toHaveLength(before);
});

// A stopped build can look active while its agent stays asleep or a later Stop reuses the old note.
test("a mention wakes a stopped plan and a second Stop writes its own note", async () => {
	const joined = Promise.withResolvers<void>();
	const run = await setup({ onSharedWait: joined.resolve });
	const { fixture, watch } = run;
	const { build, chat, agent } = await startBuild(run);
	const stop = { op: "build-stop", author: OWNER, build: build.id } as const;
	const command = "until test -f release-stop; do sleep .02; done";
	fixture.script(tool("bash", { command }, "before-stop"));
	await wake(run, "Keep checking.", chat);
	await agent.until("tool", event => event.call === "before-stop");
	const stopLookup = Promise.withResolvers<void>();
	const releaseStop = Promise.withResolvers<void>();
	const conversation = run.harness.conversation.bind(run.harness);
	const lookup = spyOn(run.harness, "conversation").mockImplementation(async (id, scope) => {
		if (id === chat) {
			stopLookup.resolve();
			await releaseStop.promise;
		}
		return conversation(id, scope);
	});
	const stopping = fixture.request(stop);
	try {
		await stopLookup.promise;
		fixture.script(tool("bash", { command }, "after-mention"));
		const sending = fixture.request({ op: "say", author: OWNER, text: "Check again.", agents: [chat] });
		await Promise.race([joined.promise, sending.then(() => { throw new Error("The mention posted before Stop finished."); })]);
		expect(watch.of("message").some(event => event.text === "Check again.")).toBe(false);
		releaseStop.resolve();
		await Promise.all([stopping, sending]);
	} finally {
		releaseStop.resolve();
		lookup.mockRestore();
		await stopping.catch(() => {});
	}
	await agent.until("stopped");
	const stopped = await buildAt(watch, 0, "stopped");
	await agent.until("tool", event => event.call === "after-mention");
	expect(watch.of("builds").at(-1)?.builds[0]?.state).toEqual({ kind: "started" });
	await fixture.request(stop);
	const second = await agent.until("stopped", event => event.at !== (stopped.state.kind === "stopped" && stopped.state.at));
	expect(agent.of("stopped")).toEqual([
		expect.objectContaining({ at: stopped.state.kind === "stopped" && stopped.state.at }),
		second,
	]);
});

// Sharing pauses only a running plan, so a mention must not wake a stopped plan in a shared channel.
test("a mention does not wake a stopped plan while the channel is shared", async () => {
	const run = await setup();
	const { fixture, watch } = run;
	const { build, chat } = await startBuild(run);
	await fixture.request({ op: "build-stop", author: OWNER, build: build.id });
	await buildAt(watch, 0, "stopped");
	await fixture.request({ op: "share", author: OWNER, shared: true });
	await expect(fixture.request({ op: "say", author: OWNER, text: "Wake up.", agents: [chat] })).rejects.toThrow(
		"The plan's agents are stopped, and a mention can't restart them while other people may ask them.",
	);
	expect(watch.of("message").some(event => event.text === "Wake up.")).toBe(false);
	expect(watch.of("builds").at(-1)?.builds[0]?.state.kind).toBe("stopped");
});

// Passive writes, invoked inputs, and replay use different transcript paths.
test("say and ask publish their distinct mentions live and after reopening", async () => {
	const run = await setup();
	const { fixture, watch } = run;
	const { chat, reviewer } = await startPair(run);
	fixture.script(fauxAssistantMessage("Read."), fauxAssistantMessage("Read."));
	await fixture.request({ op: "say", author: OWNER, text: "Please check.", agents: [reviewer, chat, reviewer] });
	const said = await watch.until("message", event => event.text === "Please check.");
	expect(said).toMatchObject({ invoked: false, agents: [reviewer, chat] });
	await until(() => fixture.channel.isIdle());
	fixture.script(fauxAssistantMessage("Read."), fauxAssistantMessage("Read."));
	const asked = await fixture.request<{ submission: number }>({ op: "ask", author: OWNER, text: "Please verify.", agents: [chat] });
	const message = await watch.until("message", event => event.text === "Please verify.");
	expect(message).toMatchObject({ invoked: true, agents: [chat] });
	expect(await fixture.request({ op: "wait", submission: asked.submission })).toBe("done");
	await until(() => fixture.channel.isIdle());
	await fixture.request({ op: "edit", author: OWNER, entry: said.entry, text: "Checked." });
	await fixture.request({ op: "delete", author: OWNER, entry: message.entry });
	await fixture.restart();
	const replay = await fixture.watch();
	expect(replay.of("message").find(event => event.entry === said.entry)).toMatchObject({ text: "Checked.", agents: [reviewer, chat] });
	expect(replay.of("message").find(event => event.entry === message.entry)).toMatchObject({ deleted: true, agents: [chat] });
});

// A queued ask has no transcript entry until the thread's current run reaches a boundary.
test("a queued ask publishes its agent list and delivers the mention only when it posts", async () => {
	const run = await setup();
	const { fixture, watch } = run;
	const { chat, agent } = await startBuild(run);
	const running = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	fixture.script(async () => {
		running.resolve();
		await finish.promise;
		return fauxAssistantMessage("Finished the first check.");
	});
	const text = "Please verify the retry too.";
	const requestId = "queued-mention";
	const delivery = () => run.harness.commit(tx => tx.submissionByRequest(
		chat as ConversationId, `neuve.build:mention:${ROOT_CONVERSATION_ID}:${requestId}:${chat}`,
	), context);
	try {
		await invoke(fixture, "Check the export.");
		await running.promise;
		const { submission } = await fixture.request<{ submission: number }>({ op: "ask", author: OWNER, text, agents: [chat], requestId });
		await watch.until("queue", event => event.messages.some(message => message.submission === submission));
		expect(watch.of("message").some(event => event.text === text)).toBe(false);
		expect(await delivery()).toBeUndefined();

		fixture.script(fauxAssistantMessage("Verified."), fauxAssistantMessage("Verified."));
		finish.resolve();
		const posted = await watch.until("message", event => event.text === text);
		expect(posted).toMatchObject({ invoked: true, agents: [chat] });
		const received = await agent.until("message", event => event.text === text);
		expect(received).toMatchObject({ author: OWNER, invoked: true });
		expect(received.entry).toBeGreaterThan(posted.entry);
		expect((await delivery())?.entry).toBe(received.entry);
		expect(await fixture.request({ op: "wait", submission })).toBe("done");
	} finally {
		finish.resolve();
	}
});

// The thread can post while the worker is closing, before the mention is linked or delivered.
test("reopening finds a posted mention that the closing worker did not deliver", async () => {
	const closing = Promise.withResolvers<Promise<void>>();
	const run = await setup({ onStep(step) {
		if (step === "build.mention.recorded") closing.resolve(run.fixture.channel.close());
	} });
	const { fixture } = run;
	const { chat } = await startBuild(run);
	const text = "Pick up after reopening.";
	await fixture.request({ op: "say", author: OWNER, text, agents: [chat] });
	await closing.promise;
	fixture.script(fauxAssistantMessage("Picked up."));
	await fixture.restart();
	const replay = await fixture.watch();
	expect(replay.of("message").find(event => event.text === text)).toMatchObject({ agents: [chat] });
	await replay.until("message", event => event.text === "Picked up." && event.author === `agent@${chat}`);
	const agent = await fixture.watch({ op: "watch", chat });
	expect(agent.of("message").filter(event => event.text === text)).toHaveLength(1);
});

// A run can settle durably even when its reply write fails.
test("reopening posts a settled mention's missed reply exactly once", async () => {
	const failed = Promise.withResolvers<void>();
	const run = await setup({ onStep(step) {
		if (step === "build.mention.reply.failed") failed.resolve();
	} });
	const { fixture, watch } = run;
	const { chat } = await startBuild(run);
	const conversation = run.harness.conversation.bind(run.harness);
	const thread = (await conversation(ROOT_CONVERSATION_ID, context))!;
	const submit = thread.submit.bind(thread);
	const lookup = spyOn(run.harness, "conversation").mockImplementation((id, scope) =>
		id === ROOT_CONVERSATION_ID ? Promise.resolve(thread) : conversation(id, scope));
	const write = spyOn(thread, "submit").mockImplementation(async (draft, scope) => {
		if (draft.requestId?.startsWith("neuve.build:reply:")) throw new Error("Thread write failed.");
		return submit(draft, scope);
	});
	const text = "Check the retry.";
	try {
		fixture.script(fauxAssistantMessage("Retry verified."));
		await fixture.request({ op: "say", author: OWNER, text, agents: [chat] });
		await failed.promise;
		expect(watch.of("message").some(event => event.author === `agent@${chat}`)).toBe(false);
		await fixture.channel.close();
	} finally {
		write.mockRestore();
		lookup.mockRestore();
	}
	for (let restart = 0; restart < 2; restart++) {
		await fixture.restart();
		const replay = await fixture.watch();
		const original = await replay.until("message", event => event.text === text);
		await replay.until("message", event => event.author === `agent@${chat}`);
		await until(() => fixture.channel.isIdle());
		expect(replay.of("message").filter(event => event.author === `agent@${chat}`)).toEqual([
			expect.objectContaining({ text: "Retry verified.", invoked: false }),
		]);
		expect(original.agents).toEqual([chat]);
		expect((await run.harness.snapshot(BuildsDoc, context))?.mentions).toEqual([
			{ entry: original.entry, agents: [chat] },
		]);
	}
});

// Pi can settle a run with mentions from several threads and start its follow-up in the same commit.
test("a mentioned agent replies once to each thread while its queued follow-up runs", async () => {
	const run = await setup();
	const { fixture, watch } = run;
	const { chat, agent } = await startBuild(run);
	const { chat: other } = await fixture.request<{ chat: number }>({ op: "chat", author: OWNER });
	const otherThread = await fixture.watch({ op: "watch", chat: other });
	fixture.script(tool("bash", { command: "until test -f release-reply; do sleep .02; done" }, "reply-shell"));
	const working = await wake(run, "Check the export.", chat);
	await agent.until("tool", event => event.call === "reply-shell");
	const mentions = [
		{ requestId: "first", text: "Check the retry too." },
		{ requestId: "second", text: "Check errors too." },
		{ requestId: "from-other", text: "Check the response.", chat: other },
	];
	for (const mention of mentions) {
		await fixture.request({ op: "say", author: OWNER, agents: [chat], ...mention });
		await agent.until("queue", event => event.messages.some(message => message.text === mention.text));
	}
	const followUp = await wake(run, "Check the next export.", chat);
	const finishFollowUp = Promise.withResolvers<void>();
	fixture.script(tool("bash", { command: "true" }, "retry-check"),
		tool("bash", { command: "true" }, "error-check"), fauxAssistantMessage("All checks passed."), async () => {
			await finishFollowUp.promise;
			return fauxAssistantMessage("Next export checked.");
		});
	try {
		await writeFile(join(run.worktrees[0]!.path, "release-reply"), "");
		expect(await fixture.request({ op: "wait", submission: working })).toBe("done");
		for (const thread of [watch, otherThread]) {
			await thread.until("message", event => event.text === "All checks passed.");
		}
		expect((await (await run.harness.submission(followUp, context))?.status(context))?.status).toBe("placed");
	} finally {
		finishFollowUp.resolve();
	}
	expect(await fixture.request({ op: "wait", submission: followUp })).toBe("done");
	await fixture.restart();
	for (const thread of [ROOT_CONVERSATION_ID, other]) {
		const replay = await fixture.watch({ op: "watch", chat: thread });
		expect(replay.of("message").filter(event => event.author === `agent@${chat}`)).toEqual([
			expect.objectContaining({ text: "All checks passed.", invoked: false }),
		]);
	}
});

// Stop ends queued asks without an entry, even when their mention record is already durable.
test("a mention withdrawn into the draft does not reach the plan agent on reopen", async () => {
	const run = await setup();
	const { fixture, watch } = run;
	const { chat, agent } = await startBuild(run);
	fixture.script(tool("bash", { command: "until test -f release-thread; do sleep .02; done" }, "thread-shell"));
	await fixture.request({ op: "ask", author: OWNER, mode: "ace", text: "Check the export." });
	await watch.until("tool", event => event.call === "thread-shell");
	const request = { op: "ask", author: OWNER, text: "Check the retry.", agents: [chat], requestId: "withdraw" } as const;
	const receipt = await fixture.request<{ submission: number }>(request);
	await watch.until("queue", event => event.messages.some(message => message.submission === receipt.submission));
	await fixture.request({ op: "stop", author: OWNER });
	await watch.until("queue", event => !!event.withdrawn?.some(message => message.submission === receipt.submission));
	expect(agent.of("message").some(event => event.text === request.text)).toBe(false);
	await fixture.restart();
	await until(() => fixture.channel.isIdle());
	expect((await run.harness.snapshot(BuildsDoc, context))?.mentions).toEqual([]);
	const replay = await fixture.watch({ op: "watch", chat });
	fixture.script(fauxAssistantMessage("Checked."));
	await fixture.request({ ...request, op: "say", requestId: "resend" });
	await replay.until("reply", event => event.text === "Checked.");
	expect(replay.of("message").filter(event => event.text === request.text)).toHaveLength(1);
	const ids = await run.harness.commit(async tx => Promise.all(["withdraw", "resend"].map(id => tx.submissionByRequest(
		chat as ConversationId, `neuve.build:mention:${ROOT_CONVERSATION_ID}:${id}:${chat}`,
	))), context);
	expect(ids).toEqual([undefined, expect.objectContaining({ status: "done" })]);
});

// A refused batch could wake an earlier valid target before reaching its invalid targets.
test("a mention names every bad target without posting or waking a valid stopped plan", async () => {
	const run = await setup();
	const { fixture, watch } = run;
	const first = await startBuild(run);
	await fixture.request({ op: "build-stop", author: OWNER, build: first.build.id });
	const plan = await run.draft(revisedText);
	fixture.script(fauxAssistantMessage("Second plan ready."));
	await run.approve(plan);
	const build = await buildAt(watch, 1, "started");
	const chat = build.agents[0]!.chat;
	await until(() => fixture.channel.isIdle());

	const briefLookup = Promise.withResolvers<ConversationId>();
	const releaseBrief = Promise.withResolvers<void>();
	const conversation = run.harness.conversation.bind(run.harness);
	const lookup = spyOn(run.harness, "conversation").mockImplementation(async (id, scope) => {
		const target = await conversation(id, scope);
		if (id <= chat || !target) return target;
		briefLookup.resolve(id);
		await releaseBrief.promise;
		return target;
	});
	try {
		fixture.script(tool("agent_start", { role: "reviewer", part: "src/x" }, "unbriefed-reviewer"), fauxAssistantMessage("Paused."));
		await wake(run, "Start the reviewer.", chat);
		const reviewer = await briefLookup.promise;
		await fixture.request({ op: "share", author: OWNER, shared: true });
		await buildAt(watch, 1, "paused");
		const text = "Do not post this.";
		await expect(fixture.request({ op: "say", author: OWNER, text, agents: [first.chat, 900, reviewer, chat, 901] }))
			.rejects.toThrow("Mention only agents of this channel's plans. The reviewer for \"src/x\": Wait for the host to send the agent’s brief. The reviewer for \"src/x\": The plan's agents are paused while other people may ask them. The implementer: The plan's agents are paused while other people may ask them.");
		expect(watch.of("message").some(event => event.text === text)).toBe(false);
		expect(watch.of("builds").at(-1)?.builds[0]?.state.kind).toBe("stopped");
		expect((await run.harness.snapshot(BuildsDoc, context))?.mentions).toBeUndefined();
	} finally {
		lookup.mockRestore();
		releaseBrief.resolve();
	}
});

// Model selection yields between the first check and the commit that admits an ask.
test("an ask mention rechecks a plan paused during model selection", async () => {
	const run = await setup();
	const { fixture, watch } = run;
	const { chat } = await startBuild(run);
	await run.harness.commit(tx => setChatMode(tx, ROOT_CONVERSATION_ID, "plan"), context);
	const { models } = fixture.scripted;
	const selecting = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const available = models.getAvailable.bind(models);
	const lookup = spyOn(models, "getAvailable").mockImplementation(async (provider, options) => {
		selecting.resolve();
		await release.promise;
		return available(provider, options);
	});
	const text = "Check this before switching modes.";
	try {
		const attempt = fixture.request({ op: "ask", author: OWNER, mode: "ace", text, agents: [chat] });
		await selecting.promise;
		await fixture.request({ op: "share", author: OWNER, shared: true });
		release.resolve();
		await expect(attempt).rejects.toThrow("The implementer: The plan's agents are paused while other people may ask them.");
		expect(watch.of("message").some(event => event.text === text)).toBe(false);
		expect((await fixture.channel.info()).chats.find(item => item.id === ROOT_CONVERSATION_ID)?.mode).toBe("plan");
	} finally {
		release.resolve();
		lookup.mockRestore();
	}
});

// Ordinary say is open to teammates and agent authors can ordinarily invoke.
test("say and ask refuse mention lists from agent authors and teammates without access", async () => {
	const run = await setup();
	const { chat } = await startBuild(run);
	for (const op of ["say", "ask"] as const) {
		const request = { op, text: "Check the retry.", agents: [chat] };
		await expect(run.fixture.request({ ...request, author: "agent@other" }))
			.rejects.toThrow("Only a person can mention a plan's agents.");
		await expect(run.fixture.request({ ...request, author: "teammate" }))
			.rejects.toThrow(`Agent access is off in this channel, so only its owner, ${OWNER}, can ask its agents.`);
	}
	expect(run.watch.of("message").some(event => event.text === "Check the retry.")).toBe(false);
});

// Pi accepts the same request id again, so both channel entry points must bind it to the agent list.
test("say and ask reject a retry that changes the list of mentioned agents", async () => {
	const run = await setup();
	const { fixture } = run;
	const { chat, reviewer } = await startPair(run);
	for (const op of ["say", "ask"] as const) {
		fixture.script(fauxAssistantMessage("Read."), ...(op === "ask" ? [fauxAssistantMessage("Read.")] : []));
		const request = { op, author: OWNER, text: "Check the retry.", agents: [chat], requestId: `${op}-mention` };
		const first = await fixture.request<{ submission: number }>(request);
		expect(await fixture.request(request)).toEqual(first);
		await expect(fixture.request({ ...request, agents: [reviewer] })).rejects.toThrow("was already used for a different message");
		await fixture.request({ op: "wait", submission: first.submission });
		await until(() => fixture.channel.isIdle());
	}
});

// Sharing changes who can receive a new mention while the original submission is still valid.
test("say and ask return the original submission when a retried mention's plan has paused", async () => {
	const run = await setup();
	const { fixture, watch } = run;
	const { chat } = await startBuild(run);
	const posted = [];
	for (const op of ["say", "ask"] as const) {
		fixture.script(fauxAssistantMessage("Read."), ...(op === "ask" ? [fauxAssistantMessage("Read.")] : []));
		const request = { op, author: OWNER, text: `Check the ${op} retry.`, agents: [chat], requestId: `${op}-mention` };
		const first = await fixture.request<{ submission: number }>(request);
		await watch.until("message", event => event.text === request.text);
		expect(await fixture.request({ op: "wait", submission: first.submission })).toBe("done");
		await until(() => fixture.channel.isIdle());
		posted.push({ request, first });
	}
	await fixture.request({ op: "share", author: OWNER, shared: true });
	await buildAt(watch, 0, "paused");
	for (const { request, first } of posted) {
		expect(await fixture.request(request)).toEqual(first);
		expect(watch.of("message").filter(event => event.text === request.text)).toHaveLength(1);
	}
});

// Sharing could leave an approved revision waiting until the channel reopens.
test("unsharing delivers an owed revision once to each agent before reopening", async () => {
	const run = await setup();
	const { fixture, watch, draft, approve } = run;
	const { build, chat, reviewer, agent } = await startPair(run);
	const target = await fixture.watch({ op: "watch", chat: reviewer });
	const revision = await draft(revisedText);
	const finishRuns = Promise.withResolvers<void>();
	const lookingUp = Promise.withResolvers<void>();
	const releaseLookup = Promise.withResolvers<void>();
	const continueWork = async () => {
		await finishRuns.promise;
		return fauxAssistantMessage("Ready for the revision.");
	};
	try {
		fixture.script(continueWork, continueWork);
		await wake(run, "Continue implementing.", chat);
		await wake(run, "Continue reviewing.", reviewer);
		const conversation = run.harness.conversation.bind(run.harness);
		const lookup = spyOn(run.harness, "conversation").mockImplementation(async (id, scope) => {
			const found = await conversation(id, scope);
			if (id !== chat) return found;
			lookup.mockRestore();
			lookingUp.resolve();
			await releaseLookup.promise;
			return found;
		});
		try {
			await approve(revision);
			expect(await buildAt(watch, 1, "delivered")).toMatchObject({ state: { to: build.id } });
			await lookingUp.promise;
			await fixture.request({ op: "share", author: OWNER, shared: true });
			releaseLookup.resolve();
			finishRuns.resolve();
			await until(() => fixture.channel.isIdle());
			for (const transcript of [agent, target]) {
				expect(transcript.of("message").filter(event => event.text === revisedText)).toHaveLength(0);
			}

			fixture.script(fauxAssistantMessage("Revision read."), fauxAssistantMessage("Revision read."));
			await fixture.request({ op: "share", author: OWNER, shared: false });
			await until(() => fixture.channel.isIdle());
			for (const transcript of [agent, target]) {
				expect(transcript.of("message").filter(event => event.text === revisedText)).toHaveLength(1);
			}
			const calls = fixture.faux.state.callCount;
			await fixture.restart();
			await until(() => fixture.channel.isIdle());
			for (const id of [chat, reviewer]) {
				const reopened = await fixture.watch({ op: "watch", chat: id });
				expect(reopened.of("message").filter(event => event.text === revisedText)).toHaveLength(1);
			}
			expect(fixture.faux.state.callCount).toBe(calls);
		} finally {
			lookup.mockRestore();
		}
	} finally {
		releaseLookup.resolve();
		finishRuns.resolve();
	}
});

const messageTool = (text: string, call: string) => tool("agent_message", { to: "reviewer", part: "exports", text }, call);

// A retry could be refused while the start for that role and part is still waiting to resume.
test("retrying a paused reviewer start sends one brief when sharing clears", async () => {
	const creating = Promise.withResolvers<void>();
	const releaseWorktree = Promise.withResolvers<void>();
	const retryEntered = Promise.withResolvers<void>();
	const releaseRetry = Promise.withResolvers<void>();
	const run = await setup({
		async beforeWorktree() {
			if (run.worktrees.length !== 2) return;
			creating.resolve();
			await releaseWorktree.promise;
		},
		wrapTool(tool) {
			if (tool.name !== "agent_start") return tool;
			return { ...tool, async execute(args, api, scope) {
				if (api.callId === "retry-paused-reviewer") {
					retryEntered.resolve();
					await releaseRetry.promise;
				}
				return tool.execute(args, api, scope);
			} };
		},
	});
	const { fixture, watch } = run;
	const { chat, reviewer, agent } = await startPair(run);
	const other = await fixture.watch({ op: "watch", chat: reviewer });
	const args = { role: "reviewer", part: "retry path" };
	try {
		fixture.script(tool("agent_start", args, "start-paused-reviewer"));
		const first = await wake(run, "Start a retry reviewer.", chat);
		await creating.promise;
		fixture.script(tool("agent_start", args, "retry-paused-reviewer"));
		const second = await wake(run, "Start the same reviewer.", reviewer);
		await retryEntered.promise;
		await fixture.request({ op: "share", author: OWNER, shared: true });
		fixture.script(fauxAssistantMessage("Start recorded."), fauxAssistantMessage("Start recorded."));
		releaseWorktree.resolve();
		const pending = { error: false, text: "The agent start is recorded and will finish when work resumes." };
		expect(await agent.until("result", event => event.call === "start-paused-reviewer")).toMatchObject(pending);
		releaseRetry.resolve();
		expect(await other.until("result", event => event.call === "retry-paused-reviewer")).toMatchObject(pending);
		for (const submission of [first, second]) expect(await fixture.request({ op: "wait", submission })).toBe("done");
		expect((await buildAt(watch, 0, "paused")).agents).toHaveLength(2);

		fixture.script(fauxAssistantMessage("Retry brief read."));
		await fixture.request({ op: "share", author: OWNER, shared: false });
		const { builds: [build] } = await watch.until("builds", event => event.builds[0]?.agents.length === 3);
		const transcript = await fixture.watch({ op: "watch", chat: build!.agents[2]!.chat });
		await transcript.until("reply", event => event.text === "Retry brief read.");
		expect(transcript.of("message").map(event => event.system?.kind)).toEqual(["neuve:build:brief"]);
		expect(run.worktrees).toHaveLength(3);
		expect(watch.of("builds").at(-1)?.builds[0]?.agents).toHaveLength(3);
	} finally {
		releaseWorktree.resolve();
		releaseRetry.resolve();
	}
});

function offerRetiredModel(fixture: Fixture) {
	const model = { provider: "retired", modelId: "old-model" };
	fixture.scripted.models.setProvider(fauxProvider({ provider: model.provider, models: [{ id: model.modelId }] }).provider);
	return model;
}

// Approval and the work log can look complete even when the recipient's stored model cannot run.
test("build briefs and agent messages use Automatic when the recipient's provider is gone", async () => {
	const run = await setup({
		onStep(step) {
			if (step === "build.chat" && run.worktrees.length === 1) run.fixture.scripted.models.deleteProvider(retired.provider);
		},
	});
	const { fixture } = run;
	const plan = await run.draft(planText);
	const retired = offerRetiredModel(fixture);
	await fixture.request({ op: "select", author: OWNER, model: retired });
	fixture.script(fauxAssistantMessage("I received the brief."));
	await run.approve(plan);
	await until(() => fixture.channel.isIdle());
	const build = run.watch.of("builds").at(-1)?.builds[0];
	expect(build?.state).toEqual({ kind: "started" });
	const { chat } = build!.agents[0]!;
	const sender = await fixture.watch({ op: "watch", chat });
	expect(sender.of("reply").at(-1)).toMatchObject({ model: "coder", text: "I received the brief." });

	const reviewer = await startReviewer(run, chat);
	offerRetiredModel(fixture);
	await fixture.request({ op: "select", author: OWNER, chat: reviewer, model: retired });
	fixture.script(() => {
		fixture.scripted.models.deleteProvider(retired.provider);
		return messageTool("Check the retry path.", "send-on-automatic");
	}, fauxAssistantMessage("I received the update."), fauxAssistantMessage("I received the update."));
	const submission = await wake(run, "Ask the reviewer to check the retry path.", chat);
	expect(await fixture.request({ op: "wait", submission })).toBe("done");
	expect(await sender.until("result", event => event.call === "send-on-automatic")).toMatchObject({
		error: false, text: "The message was sent.",
	});
	await until(() => fixture.channel.isIdle());
	const target = await fixture.watch({ op: "watch", chat: reviewer });
	expect(target.of("reply").at(-1)).toMatchObject({ model: "coder", text: "I received the update." });
	expect(target.of("message").at(-1)).toMatchObject({ author: `agent@${chat}`, text: "Check the retry path." });
});

// Sharing could change a paused agent's model, wake it early, or lose a recorded message after reopening.
test("sharing holds the brief and delivers the pending message once after reopening and unsharing", async () => {
	const run = await setup();
	const { fixture, watch } = run;
	const { models } = fixture.scripted;
	const plan = await run.draft(planText);
	const retired = offerRetiredModel(fixture);
	await fixture.request({ op: "select", author: OWNER, model: retired });
	const briefLookup = Promise.withResolvers<ConversationId>();
	const releaseBrief = Promise.withResolvers<void>();
	const conversation = run.harness.conversation.bind(run.harness);
	const lookup = spyOn(run.harness, "conversation").mockImplementation(async (chat, scope) => {
		const target = await conversation(chat, scope);
		if (chat === ROOT_CONVERSATION_ID || !target) return target;
		lookup.mockRestore();
		briefLookup.resolve(chat);
		await releaseBrief.promise;
		return target;
	});
	const share = (shared: boolean) => fixture.request({ op: "share", author: OWNER, shared });
	try {
		await run.approve(plan);
		const chat = await briefLookup.promise;
		models.deleteProvider(retired.provider);
		await share(true);
		await buildAt(watch, 0, "paused");
		releaseBrief.resolve();
		await until(() => fixture.channel.isIdle());
		expect((await fixture.channel.info()).chats.find(item => item.id === chat)).toMatchObject({ model: retired, busy: false });
		const sender = await fixture.watch({ op: "watch", chat });
		expect(sender.of("message")).toEqual([]);

		fixture.script(fauxAssistantMessage("Ready."));
		await share(false);
		await sender.until("reply", event => event.text === "Ready.");
		await buildAt(watch, 0, "started");
		await until(() => fixture.channel.isIdle());
		const reviewer = await startReviewer(run, chat);
		offerRetiredModel(fixture);
		await fixture.request({ op: "select", author: OWNER, chat: reviewer, model: retired });
		const selecting = Promise.withResolvers<void>();
		const releaseSelection = Promise.withResolvers<void>();
		const available = models.getAvailable.bind(models);
		const selection = spyOn(models, "getAvailable").mockImplementation(async (provider, options) => {
			if (provider === retired.provider) {
				selecting.resolve();
				await releaseSelection.promise;
			}
			return available(provider, options);
		});
		try {
			fixture.script(messageTool("Check the retry path.", "send-during-pause"), fauxAssistantMessage("Message attempt finished."));
			const submission = await wake(run, "Ask the reviewer to check the retry path.", chat);
			await selecting.promise;
			await share(true);
			await watch.until("builds", event => event.builds[0]?.state.kind === "paused"
				&& event.builds[0].agents.some(agent => agent.chat === reviewer));
			releaseSelection.resolve();
			expect(await fixture.request({ op: "wait", submission })).toBe("done");
			expect(await sender.until("result", event => event.call === "send-during-pause")).toMatchObject({
				error: false, text: "The message is recorded and will be delivered when work resumes.",
			});
			const target = await fixture.watch({ op: "watch", chat: reviewer, builds: true });
			expect(target.of("message").map(event => event.system?.kind)).toEqual(["neuve:build:brief"]);
			expect(target.of("builds").at(-1)?.messages).toEqual([]);

			await fixture.restart();
			await until(() => fixture.channel.isIdle());
			const reopened = await fixture.watch({ op: "watch", chat: reviewer, builds: true });
			expect(reopened.of("message").map(event => event.system?.kind)).toEqual(["neuve:build:brief"]);
			models.deleteProvider(retired.provider);
			fixture.script(fauxAssistantMessage("I received the update."));
			await share(false);
			await reopened.until("reply", event => event.text === "I received the update.");
			await until(() => fixture.channel.isIdle());
			await fixture.restart();
			await until(() => fixture.channel.isIdle());
			const replay = await fixture.watch({ op: "watch", chat: reviewer, builds: true });
			expect(replay.of("message").map(event => event.system?.kind ?? event.text)).toEqual(["neuve:build:brief", "Check the retry path."]);
			expect(replay.of("builds").at(-1)?.messages).toMatchObject([{ from: chat, to: reviewer, text: "Check the retry path." }]);
		} finally {
			releaseSelection.resolve();
			selection.mockRestore();
		}
	} finally {
		releaseBrief.resolve();
		lookup.mockRestore();
	}
});

// A queued agent input can stop the shell or notify teammates even when the work log looks right.
test("messages by role and part steer after the shell, stay private, and appear in send order", async () => {
	const run = await setup();
	const { fixture, watch } = run;
	const { build, chat, agent, reviewer } = await startPair(run);
	const target = await fixture.watch({ op: "watch", chat: reviewer });
	const folder = run.worktrees[1]!.path;
	fixture.script(tool("bash", {
		command: "touch shell-entered; until test -f release-shell; do sleep .02; done; printf 'Shell finished.'",
	}, "review-shell"));
	const submission = await wake(run, "Check the exports.", reviewer);
	await until(async () => readFile(join(folder, "shell-entered")).then(() => true, () => false));
	const texts = ["Exports are ready for @teammate to check.\nKeep the retry path.", "The retry now keeps its place in the queue."];
	for (const [index, text] of texts.entries()) {
		const call = `send-${index}`;
		fixture.script(messageTool(text, call), fauxAssistantMessage("Sent."));
		await fixture.request({ op: "wait", submission: await wake(run, "Send the update.", chat) });
		expect(await agent.until("result", event => event.call === call)).toMatchObject({ error: false, text: "The message was sent." });
	}
	const queued = await target.until("queue", event => event.messages.length === texts.length);
	expect(queued.messages.map(({ author, text }) => ({ author, text }))).toEqual(
		texts.map(text => ({ author: `agent@${chat}`, text })));
	expect(target.of("result").some(event => event.call === "review-shell")).toBe(false);
	expect(target.of("message").map(event => event.system?.kind ?? event.text)).toEqual(["neuve:build:brief", "Check the exports."]);
	const log = await watch.until("builds", event => event.messages.length === texts.length);
	expect(log.messages).toEqual(texts.map(text => ({ build: build.id, from: chat, to: reviewer, text, at: expect.any(Number) })));
	fixture.script(fauxAssistantMessage("I read the updates."), fauxAssistantMessage("I read the next update."));
	await writeFile(join(folder, "release-shell"), "");
	expect(await target.until("result", event => event.call === "review-shell")).toMatchObject({ error: false, text: "Shell finished." });
	await target.until("message", event => event.text === texts.at(-1));
	expect(target.of("message").slice(-2).map(({ author, text }) => ({ author, text }))).toEqual(
		texts.map(text => ({ author: `agent@${chat}`, text })));
	expect(await fixture.request({ op: "wait", submission })).toBe("done");
	expect(run.said.filter(value => value.chat === reviewer).map(value => value.author)).toEqual([OWNER]);
});

// Drafting a revision keeps messages on the approved plan's build.
test("a chat in Plan mode reaches its approved plan's agents while drafting a revision", async () => {
	const run = await setup();
	const { fixture, watch } = run;
	const { build, chat, reviewer } = await startPair(run);
	const send = async (to: string, part: string | undefined, text: string, error = false, expected = "The message was sent.") => {
		fixture.script(tool("agent_message", { to, ...(part ? { part } : {}), text }, text),
			fauxAssistantMessage("Send finished."), ...(!error ? [fauxAssistantMessage("Received.")] : []));
		const { submission } = await fixture.request<{ submission: number }>({
			op: "ask", author: OWNER, mode: "plan", text: "Send the message.",
		});
		await fixture.request({ op: "wait", submission });
		expect(await watch.until("result", event => event.call === text)).toMatchObject({ error, text: expected });
		await until(() => fixture.channel.isIdle());
	};
	await send("implementer", undefined, "Planning implementer delivery.");
	await send("reviewer", "exports", "Planning reviewer delivery.");
	await send("reviewer", undefined, "Missing whole-plan reviewer.", true,
		'This plan has no started agent with that role and path scope. The plan has started an implementer and a reviewer for "exports".');
	const revision = await run.draft(revisedText);
	await send("reviewer", "exports", "Review the draft revision.");
	const finish = Promise.withResolvers<void>();
	const reviewing = await fixture.watch({ op: "watch", chat: reviewer });
	fixture.script(async () => { await finish.promise; return fauxAssistantMessage("Implementation is ready."); },
		fauxAssistantMessage("Revision received."), fauxAssistantMessage("Revision received."));
	await wake(run, "Continue implementing.", chat);
	try {
		await run.approve(revision);
		expect((await buildAt(watch, 1, "delivered")).state).toEqual({ kind: "delivered", to: build.id });
		await reviewing.until("reply", event => event.text === "Revision received.");
	} finally { finish.resolve(); }
	await until(() => fixture.channel.isIdle());
	// A later plan in another chat must not change the drafting chat's destination.
	const other = await fixture.request<{ chat: number }>({ op: "chat", author: OWNER });
	fixture.script(tool("plan_write", { text: "# Other chat plan" }, "other-plan"));
	const otherDraft = await fixture.request<{ submission: number }>({ op: "ask", author: OWNER, chat: other.chat, mode: "plan", text: "Draft." });
	await fixture.request({ op: "wait", submission: otherDraft.submission });
	const outside = await fixture.watch({ op: "watch", chat: other.chat });
	fixture.script(tool("agent_message", { to: "implementer", text: "Review the first draft." }, "first-draft-message"),
		fauxAssistantMessage("No message sent."));
	const { submission } = await fixture.request<{ submission: number }>({
		op: "ask", author: OWNER, chat: other.chat, mode: "plan", text: "Send the message.",
	});
	await fixture.request({ op: "wait", submission });
	expect(await outside.until("result", event => event.call === "first-draft-message")).toMatchObject({
		error: true, text: "This plan has no started agent with that role and path scope. The plan has no started agents yet.",
	});
	await send("reviewer", "exports", "Revised planning delivery.");
	const messages = watch.of("builds").at(-1)!.messages;
	expect(messages).toEqual([
		{ build: build.id, from: 1, to: chat, text: "Planning implementer delivery.", at: expect.any(Number) },
		{ build: build.id, from: 1, to: reviewer, text: "Planning reviewer delivery.", at: expect.any(Number) },
		{ build: build.id, from: 1, to: reviewer, text: "Review the draft revision.", at: expect.any(Number) },
		{ build: build.id, from: 1, to: reviewer, text: "Revised planning delivery.", at: expect.any(Number) },
	]);
	for (const message of messages) {
		const target = await fixture.watch({ op: "watch", chat: message.to });
		expect(target.of("message").filter(event => event.text === message.text)).toMatchObject([
			{ author: "agent@1", text: message.text },
		]);
	}
	expect(run.worktrees).toHaveLength(2);
});

// A rejected call could still wake an agent if a role or part were resolved outside the build.
test("agent messages refuse unknown recipients, outsiders, self, empty text, and closed builds", async () => {
	const run = await setup();
	const { fixture, watch } = run;
	const { build, chat, agent, reviewer } = await startPair(run);
	const other = await fixture.request<{ chat: number }>({ op: "chat", author: OWNER });
	const outside = await fixture.watch({ op: "watch", chat: other.chat });
	const target = await fixture.watch({ op: "watch", chat: reviewer });
	const refuse = async (from: number, transcript: Watch, call: string, args: Record<string, string>, text: string, name = "agent_message") => {
		fixture.script(tool(name, args, call), fauxAssistantMessage("No message sent."));
		await fixture.request({ op: "wait", submission: await (transcript === agent ? wake(run, "Try sending the message.", from) : invoke(fixture, "Try sending the message.", from)) });
		expect(await transcript.until("result", event => event.call === call)).toMatchObject({ error: true, text });
	};
	const valid = { to: "reviewer", part: "exports", text: "Ready." };
	await refuse(chat, agent, "missing-agent", { ...valid, part: "another part" },
		'This plan has no started agent with that role and path scope. The plan has started an implementer and a reviewer for "exports".');
	await refuse(other.chat, outside, "outside-build", valid, "Only the chat that drafted a plan, or one of its agents, can message that plan's agents.");
	await refuse(chat, agent, "same-chat", { to: "implementer", text: "Ready." }, "Send the message to another agent of this plan.");
	await refuse(chat, agent, "empty-text", { ...valid, text: "  " }, "Write a message to send.");

	const closedStates = [
		[{ kind: "paused", reason: "shared" }, "The plan's agents are paused while other people may ask them."],
		[{ kind: "stopped", by: OWNER, at: Date.now() }, "The plan's agents have been stopped."],
	] satisfies [Build["state"], string][];
	for (const [state, refusal] of closedStates) {
		await run.harness.commit(async tx => { (await tx.doc(BuildsDoc)).records[build.id]!.build.state = state; }, context);
		await refuse(chat, agent, state.kind, valid, refusal);
		await refuse(chat, agent, `start-${state.kind}`, { role: "reviewer" }, refusal, "agent_start");
	}
	expect(target.of("message").map(event => event.system?.kind ?? event.text)).toEqual(["neuve:build:brief"]);
	expect(watch.of("builds").at(-1)?.messages).toEqual([]);
});

// Pi can have admitted a message even when the work log still has only the pending record.
for (const [phase, planning] of [
	["before Pi admits the message", false], ["before Pi admits the message", true],
	["after Pi admits the message", false], ["after Pi admits the message", true],
] as const) {
	test(`reopening ${phase} sends one ${planning ? "planning-chat" : "agent"} message and records it once`, async () => {
		const calls: number[] = [];
		const held = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let reviewer: number;
		let heldWrite = false;
		const run = await setup({
			wrapTool(tool) {
				if (tool.name !== "agent_message") return tool;
				return { ...tool, execute(args, api, context) {
					calls.push(api.taskId);
					return tool.execute(args, api, context);
				} };
			},
			onStep(step) {
				if (phase === "after Pi admits the message" && step === "build.message.submitted" && !heldWrite) {
					heldWrite = true;
					const ack = spyOn(run.harness, "commit").mockImplementationOnce(async () => {
						ack.mockRestore();
						held.resolve();
						await release.promise;
						throw new Error("The work log write was interrupted.");
					});
					return;
				}
				if (phase !== "before Pi admits the message" || step !== "build.message.recorded") return;
				const conversation = run.harness.conversation.bind(run.harness);
				const lookup = spyOn(run.harness, "conversation").mockImplementation(async (chat, context) => {
					const target = await conversation(chat, context);
					if (chat !== reviewer || !target) return target;
					lookup.mockRestore();
					held.resolve();
					await release.promise;
					return target;
				});
			},
		});
		const { fixture } = run;
		try {
			const pair = await startPair(run);
			reviewer = pair.reviewer;
			const from = planning ? 1 : pair.chat;
			if (planning) {
				fixture.script(fauxAssistantMessage("Ready to coordinate."));
				const { submission } = await fixture.request<{ submission: number }>({ op: "ask", author: OWNER, mode: "ace", text: "Coordinate." });
				await fixture.request({ op: "wait", submission });
			}
			const senderWatch = planning ? run.watch : pair.agent;
			const text = "Review the export queue.";
			fixture.script(messageTool(text, "recover-message"),
				fauxAssistantMessage("Ready."), fauxAssistantMessage("Ready."));
			await wake(run, "Ask the reviewer to check the queue.", from);
			await held.promise;
			if (planning) {
				// A newer draft appearing after reservation must not retarget or refuse the replay.
				await run.harness.commit(async tx => {
					const plans = (await tx.doc(PlansDoc)).chats[1]!;
					const prior = plans.at(-1)!;
					plans.push({ ...prior, plan: { ...prior.plan, id: "newer-draft", hash: "newer-hash", state: "draft" } });
				}, context);
			}
			const pending = await fixture.watch({ op: "watch", builds: true });
			expect(pending.of("builds").at(-1)?.messages).toEqual([]);
			const target = await fixture.watch({ op: "watch", chat: reviewer });
			expect(target.of("message").filter(message => message.text === text)).toHaveLength(
				phase === "after Pi admits the message" ? 1 : 0);
			if (phase === "before Pi admits the message") {
				const closing = fixture.channel.close();
				await Promise.resolve();
				release.resolve();
				await closing;
			} else {
				release.resolve();
				expect(await senderWatch.until("result", event => event.call === "recover-message")).toMatchObject({
					error: true, text: "The host could not finish sending this message.",
				});
				await until(() => fixture.channel.isIdle());
			}
			await fixture.restart();
			const sender = await fixture.watch({ op: "watch", chat: from, builds: true });
			if (phase === "before Pi admits the message") {
				expect(await sender.until("result", event => event.call === "recover-message")).toMatchObject({
					error: false, text: "The message was sent.",
				});
				expect(calls).toEqual([calls[0]!, calls[0]!]);
			}
			const log = await sender.until("builds", event => event.messages.length === 1);
			expect(log.messages).toEqual([{ build: pair.build.id, from, to: reviewer, text, at: expect.any(Number) }]);
			const reopened = await fixture.watch({ op: "watch", chat: reviewer });
			await reopened.until("message", event => event.text === text);
			expect(reopened.of("message").filter(message => message.text === text)).toHaveLength(1);
			await until(() => run.fixture.channel.isIdle());
		} finally {
			release.resolve();
		}
	});
}

// A host brief must not authorize a tool call even if its plan text names the model.
test("a plan's unattended implementer cannot use its brief to change models", async () => {
	const run = await setup();
	const { fixture } = run;
	const alternate = offerRetiredModel(fixture);
	const plan = await run.draft("# Export retries\n\nUse old-model for implementation.");
	fixture.script(tool("set_agent_model", { role: "implementer", model: alternate }, "unattended-model"), fauxAssistantMessage("Ready."));
	await run.approve(plan);
	const build = await buildAt(run.watch, 0, "started");
	const chat = build.agents[0]!.chat;
	const agent = await fixture.watch({ op: "watch", chat });
	expect(await agent.until("result", event => event.call === "unattended-model")).toMatchObject({ error: true });
	expect((await fixture.channel.info()).chats.find(value => value.id === chat)).toMatchObject({ model: MODEL, effort: "high" });
	expect((await fixture.channel.info()).chats.find(value => value.id === chat)?.pending).toBeUndefined();
});

// A real owner mention counts even if the implementer was already running on a host input.
test("an owner mention can schedule a model change during an implementer's run", async () => {
	const run = await setup();
	const { fixture } = run;
	const { chat, agent } = await startBuild(run);
	const alternate = offerRetiredModel(fixture);
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	fixture.script(async () => {
		entered.resolve();
		await release.promise;
		return tool("set_agent_model", { role: "implementer", model: alternate }, "mentioned-model");
	}, fauxAssistantMessage("Done."));
	try {
		const submission = await wake(run, "Work on exports.", chat);
		await entered.promise;
		await fixture.request({ op: "say", author: OWNER, text: "Use old-model.", agents: [chat] });
		await agent.until("queue", event => event.messages.some(message => message.text === "Use old-model."));
		release.resolve();
		expect(await agent.until("result", event => event.call === "mentioned-model")).toMatchObject({ error: false });
		expect((await fixture.channel.info()).chats.find(value => value.id === chat)).toMatchObject({
			model: MODEL, effort: "high", pending: { model: alternate, effort: "off" },
		});
		expect(await fixture.request({ op: "wait", submission })).toBe("done");
	} finally { release.resolve(); }
});
