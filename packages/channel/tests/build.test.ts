import { afterEach, expect, spyOn, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentSystemPrompt, type FauxResponseStep } from "@earendil-works/pi-ai";
import { defineDoc, type ConversationId, type Harness, type ToolRegistration } from "@earendil-works/pi-durable";
import { SharedWork } from "../../records-core/src/shared-work";
import { ApprovalRequestsDoc } from "../src/approvals";
import { BuildsDoc, type BuildHost } from "../src/build";
import { buildWorktree } from "../src/external-lanes";
import type { Build, Plan, Request, RunEnd, Said } from "../src/protocol";
import { Fixture, git, MODEL, OWNER, scratchEnv, until, type Watch } from "./helpers";

const context = BACKGROUND_CONTEXT;
const planText = "# Export retries\n\nKeep the retry in the export queue.";
const revisedText = "# Export retries, revised\n\nKeep the retry in the export queue until delivery.";
const tool = (name: string, args: Record<string, string>, id: string) =>
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
	beforeWorktree?(): Promise<void>;
	beforeSharedResult?(): Promise<void>;
	onSharedWait?(): void;
	onStep?(step: string): void;
	wrapTool?(tool: ToolRegistration): ToolRegistration;
} = {}) {
	const files = new Map<string, Uint8Array>();
	const work = new SharedWork<void>();
	const worktrees: Awaited<ReturnType<typeof buildWorktree>>[] = [];
	const said: Said[] = [];
	const runs: RunEnd[] = [];
	let harness!: Harness;
	const host: BuildHost = {
		async share(key: string, run: () => Promise<void>) {
			const { outcome } = await work.run({
				scope: "build", key,
				onEvent: ({ role }) => { if (role === "waiter") options.onSharedWait?.(); },
				async run() {
					await run();
					if (options.beforeSharedResult) await options.beforeSharedResult();
					return { kind: "succeeded", value: undefined };
				},
			});
			if (outcome.kind === "failed") throw outcome.error;
		},
		async worktree(name, source) {
			await options.beforeWorktree?.();
			const result = await buildWorktree({
				name: "one", project: fixture.project, lanes: fixture.lanes, env: cwd => scratchEnv(cwd, fixture.root),
			}, name, context, source);
			worktrees.push(result);
			return result;
		},
		planPath: (file: string) => join(fixture.root, "plans", file),
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
		log: (_level, step) => options.onStep?.(step),
		onSaid: value => said.push(value),
		onRun: value => runs.push(value),
	});
	fixtures.push(fixture);
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
		planPath: () => host.planPath([...files.keys()][0]!),
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
		for (const text of [plan.title, plan.hash, worktree!.path, worktree!.branch, "agent_start", "agent_message"]) {
			expect(brief.text).toContain(text);
		}
		expect(brief.text.split("\n").find(line => line.startsWith("neuve query "))).toEndWith(`--scope '${run.planPath()}'`);
		expect(brief.text).not.toContain("Keep the retry in the export queue.");
		expect(brief).not.toHaveProperty("mode");
		expect(await agent.until("result", event => event.call === "implement-write")).toMatchObject({ error: false });
		expect(await readFile(join(worktree!.path, "implemented.txt"), "utf8")).toBe("worktree only");
		const info = await fixture.channel.info();
		expect(info).toMatchObject({ chats: [
			{ id: 1, mode: "plan", model: MODEL, effort: "high" },
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
			tool("write", { path: "planning.txt", content: "blocked" }, "planning-write"),
			fauxAssistantMessage("The write was refused."),
		);
		const receipt = await fixture.request<{ submission: number }>({ op: "ask", author: OWNER, text: "Try writing." });
		await fixture.request({ op: "wait", submission: receipt.submission });
		expect(await watch.until("result", event => event.call === "planning-write")).toMatchObject({ error: true });
		await fixture.channel.close();
		expect(run.said.filter(value => value.chat === chat)).toEqual([]);
		expect(run.runs.filter(value => value.chat === chat)).toEqual([]);
	} finally {
		finish.resolve();
	}
});

// A second plan card with the same bytes could start another chat after the first agent ends.
test("approving an identical copy keeps the first build and starts no chat", async () => {
	const run = await setup();
	const { plan: first, build, chat } = await startBuild(run);
	const copy = await run.draft(planText);
	expect(copy.id).not.toBe(first.id);
	expect(await run.approve(copy)).toMatchObject({ state: "approved" });
	await until(() => run.fixture.channel.isIdle());
	const attached = await run.fixture.watch({ op: "watch", builds: true });
	expect((await attached.until("builds")).builds).toMatchObject([{ id: build.id, plan: { id: first.id } }]);
	expect((await run.fixture.channel.info()).chats.map(chat => chat.id)).toEqual([1, chat]);
	expect(run.worktrees).toHaveLength(1);
});

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
		const { plan, build, chat, agent } = await startBuild(run, request => {
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
		for (const text of [plan.title, plan.hash, run.planPath(), `--branch '${implementer.branch}'`, "neuve query", "--scope", "--question \"<", "agent_message"]) {
			expect(message.text).toContain(text);
		}
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
	for (const text of [plan.title, plan.hash, run.planPath(), worktree.branch]) expect(message.text).toContain(text);
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
		expect((await watch.until("message")).text).toContain(`--branch '${branch}'`);
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
	await refuse(agent, chat, "reviewer-brief", { role: "reviewer", brief: "My account." }, "The host writes the reviewer’s brief.");
	await refuse(agent, chat, "missing-part", { role: "implementer", brief: "Write tests." }, "Give the implementer a part.");
	await refuse(agent, chat, "missing-brief", { role: "implementer", part: "parser" }, "Give the implementer a brief.");
	await refuse(agent, chat, "unknown-model", { role: "reviewer", model: "other" }, "must not have additional properties");
	fixture.script(tool("agent_start", { role: "reviewer" }, "first-reviewer"),
		fauxAssistantMessage("Ready to review."), fauxAssistantMessage("Ready to review."));
	await fixture.request({ op: "wait", submission: await wake(run, "Ask for a reviewer.", chat) });
	await until(() => fixture.channel.isIdle());
	await refuse(agent, chat, "duplicate-role", { role: "reviewer" }, "This plan already has an agent with that role and part.");
	const other = await fixture.request<{ chat: number }>({ op: "chat", author: OWNER });
	await refuse(await fixture.watch({ op: "watch", chat: other.chat }), other.chat, "not-agent", { role: "reviewer" },
		"Only an agent of a plan can ask the host to start another agent.");
	await refuse(run.watch, 1, "planning-start", { role: "reviewer" }, "Plan mode is read-only. The agent_start tool is unavailable in plan mode.");
	expect(run.worktrees).toHaveLength(2);
	expect((await fixture.channel.info()).chats.filter(chat => chat.build)).toHaveLength(2);
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
	const run = await setup();
	const { fixture, watch } = run;
	const finish = Promise.withResolvers<void>();
	try {
		const { chat, agent } = await startBuild(run);
		await watch.until("builds", event => event.builds[0]?.agents[0]?.state === "done");
		const offset = watch.events.length;
		const captions = fauxProvider({ provider: "anthropic", models: [{ id: "claude-haiku-4-5" }], tokensPerSecond: 100_000 });
		captions.appendResponses([
			fauxAssistantMessage("Checking the export approach"),
			fauxAssistantMessage("Checked the export approach"),
			fauxAssistantMessage("Asked which export approach to take."),
		]);
		fixture.scripted.models.setProvider(captions.provider);
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

// Sharing during a tool must block the next tool without interrupting the one in progress or waking the chat on unshare.
test("sharing pauses a working build and clearing it waits for new input", async () => {
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
	expect(await fixture.channel.isIdle()).toBe(true);
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

async function startPair(run: Awaited<ReturnType<typeof setup>>) {
	const first = await startBuild(run);
	const { fixture } = run;
	fixture.script(tool("agent_start", { role: "reviewer", part: "exports" }, "start-exports-review"),
		fauxAssistantMessage("Ready."), fauxAssistantMessage("Ready."));
	await fixture.request({ op: "wait", submission: await wake(run, "Start the exports reviewer.", first.chat) });
	await until(() => fixture.channel.isIdle());
	const event = await run.watch.until("builds", event => event.builds[0]?.agents.some(agent => agent.role === "reviewer") ?? false);
	const reviewer = event.builds[0]!.agents.find(agent => agent.role === "reviewer")!;
	return { ...first, reviewer: reviewer.chat };
}

const messageTool = (text: string, call: string) => tool("agent_message", { to: "reviewer", part: "exports", text }, call);

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
	fixture.script(fauxAssistantMessage("I read the updates."));
	await writeFile(join(folder, "release-shell"), "");
	expect(await target.until("result", event => event.call === "review-shell")).toMatchObject({ error: false, text: "Shell finished." });
	await target.until("message", event => event.text === texts.at(-1));
	expect(target.of("message").slice(-2).map(({ author, text }) => ({ author, text }))).toEqual(
		texts.map(text => ({ author: `agent@${chat}`, text })));
	expect(await fixture.request({ op: "wait", submission })).toBe("done");
	expect(run.said.filter(value => value.chat === reviewer).map(value => value.author)).toEqual([OWNER]);
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
	await refuse(chat, agent, "missing-agent", { ...valid, part: "another part" }, "This plan has no started agent with that role and part.");
	await refuse(other.chat, outside, "outside-build", valid, "Only an agent of a plan can message another agent of that plan.");
	await refuse(chat, agent, "same-chat", { to: "implementer", text: "Ready." }, "Send the message to another agent of this plan.");
	await refuse(chat, agent, "empty-text", { ...valid, text: "  " }, "Write a message to send.");
	await refuse(1, watch, "planning-message", valid, "Plan mode is read-only. The agent_message tool is unavailable in plan mode.");

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
for (const phase of ["before Pi admits the message", "after Pi admits the message"] as const) {
	test(`reopening ${phase} sends one message and records it once`, async () => {
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
			const text = "Review the export queue.";
			fixture.script(messageTool(text, "recover-message"),
				fauxAssistantMessage("Ready."), fauxAssistantMessage("Ready."));
			await wake(run, "Ask the reviewer to check the queue.", pair.chat);
			await held.promise;
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
				expect(await pair.agent.until("result", event => event.call === "recover-message")).toMatchObject({
					error: true, text: "The host could not finish sending this message.",
				});
				await until(() => fixture.channel.isIdle());
			}
			await fixture.restart();
			const sender = await fixture.watch({ op: "watch", chat: pair.chat, builds: true });
			if (phase === "before Pi admits the message") {
				expect(await sender.until("result", event => event.call === "recover-message")).toMatchObject({
					error: false, text: "The message was sent.",
				});
				expect(calls).toEqual([calls[0]!, calls[0]!]);
			}
			const log = await sender.until("builds", event => event.messages.length === 1);
			expect(log.messages).toEqual([{ build: pair.build.id, from: pair.chat, to: reviewer, text, at: expect.any(Number) }]);
			const reopened = await fixture.watch({ op: "watch", chat: reviewer });
			await reopened.until("message", event => event.text === text);
			expect(reopened.of("message").filter(message => message.text === text)).toHaveLength(1);
			await until(() => run.fixture.channel.isIdle());
		} finally {
			release.resolve();
		}
	});
}
