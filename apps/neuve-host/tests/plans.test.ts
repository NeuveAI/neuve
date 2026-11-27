import "./fixtures/memory-secrets";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteDatabase, openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { Event, Plan, PlanComment, Request } from "@ace/channel/protocol";
import { EventSchema } from "@ace/channel/frame";
import { RequestSchema } from "@ace/channel/parse";
import { exportSnapshot, importSnapshot } from "@ace/channel/transfer";
import { git, until, Watch } from "../../../packages/channel/tests/helpers";
import { placeFileLinesAnchor } from "../../../packages/review-rules/src/file-lines-anchor";
import { backup, restore } from "../src/backup";
import * as catalog from "../src/catalog";
import { config } from "../src/host-config";
import { remove } from "../src/manage";
import { configureRuntime, runtimeHooks } from "../src/runtime-hooks";
import { openChannel } from "../src/worker-runtime";
import { fauxNonTurnModels } from "./fixtures/non-turn-models";

const owner = "owner";
const model = { provider: "plans-test", modelId: "agent" };
const nonTurnModels = fauxNonTurnModels(model);
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function open(project: string, state: string, id = "plans", name = "plans") {
	const fake = fauxProvider({ provider: model.provider, models: [{ id: model.modelId }], tokensPerSecond: 100_000 });
	const models = createModels();
	models.setProvider(fake.provider);
	// Direct plan-storage fixtures have no host catalog; placement is tested through the worker.
	const lanes = config.lanes;
	Reflect.deleteProperty(config, "lanes");
	let channel: Awaited<ReturnType<typeof openChannel>>;
	try { channel = await openChannel({
		id, name, project, owner, model, models,
		storage: await openNodeSqliteStorage(join(state, "channel.sqlite")),
		env: cwd => new NodeExecutionEnv({ cwd }),
		directory: { self: { id, name }, list: async () => [], deliver: async () => {} },
		log: () => {},
		extension: { extensions: [], nonTurnModels },
	}, state); }
	finally { if (lanes !== undefined) config.lanes = lanes; }
	const request = async <T = unknown>(input: Request) => channel.handle(input, () => {}) as Promise<T>;
	const watch = async (plans?: boolean, chat?: number, planComments?: boolean) => {
		const events: Event[] = [];
		const watchRequest = RequestSchema.parse({ op: "watch", plans, chat, planComments });
		const handle = await channel.handle(watchRequest, event => events.push(EventSchema.parse(event)));
		if (!handle || typeof handle !== "object" || !("stop" in handle) || typeof handle.stop !== "function") {
			throw new Error("The channel did not open a watch.");
		}
		return new Watch(events, { stop: handle.stop.bind(handle) });
	};
	const ask = async (mode: "ace" | "plan", chat?: number) => {
		const { submission } = await request<{ submission: number }>({ op: "ask", author: owner, text: "Write the plan.", mode, chat });
		expect(await request({ op: "wait", submission })).toBe("done");
	};
	const write = async (text: string, call: string, chat?: number) => {
		fake.appendResponses([fauxAssistantMessage(fauxToolCall("plan_write", { text }, { id: call }), { stopReason: "toolUse" })]);
		await ask("plan", chat);
	};
	return { channel, fake, request, watch, ask, write };
}

async function folders() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "plans-")));
	const project = join(root, "project");
	const state = join(root, "state");
	await mkdir(project);
	await mkdir(state);
	return { root, project, state };
}

// A successful tool result can hide a write to the checkout or a second model request.
test("the planning tool writes only to host storage and ends the turn on its own", async () => {
	const { root, project, state } = await folders();
	try {
		const run = await open(project, state);
		try {
			const watch = await run.watch(true);
			const path = join(project, "notes.md");
			const text = "\uFEFF## Plan café ##\r\n\r\nShip it.\r\n";
			await writeFile(path, "Keep these notes.");
			run.fake.appendResponses([request => {
				expect(getCurrentTools(request.messages).map(tool => tool.name)).toContain("plan_write");
				return fauxAssistantMessage(fauxToolCall("plan_write", { text, path }, { id: "draft" }), { stopReason: "toolUse" });
			}]);
			await run.ask("plan");
			expect(await watch.until("result", event => event.call === "draft")).toMatchObject({
				error: false, text: `Plan ready for approval.\n\n${text}`,
			});
			const { plans: [draft] } = await watch.until("plans", event => event.plans.length === 1);
			expect(draft).toMatchObject({ title: "Plan café", call: "draft", state: "draft", hash: hash(text) });
			const files = await readdir(join(state, "plans"));
			expect(files).toEqual([expect.stringMatching(/\.md$/)]);
			expect(await readFile(join(state, "plans", files[0]), "utf8")).toBe(text);
			expect(await readFile(path, "utf8")).toBe("Keep these notes.");
			expect(await run.request({ op: "plan", plan: draft.id })).toEqual({ hash: hash(text), text });
			expect(run.fake.state.callCount).toBe(1);
			expect(watch.of("tool").map(tool => tool.name)).toEqual(["plan_write"]);

			run.fake.appendResponses([request => {
				expect(request.messages).toContainEqual(expect.objectContaining({
					role: "toolResult", toolCallId: "draft",
					content: [{ type: "text", text: `Plan ready for approval.\n\n${text}` }],
				}));
				return fauxAssistantMessage("Ready for feedback.");
			}]);
			await run.ask("plan");
			run.fake.appendResponses([
				fauxAssistantMessage(fauxToolCall("plan_write", { text: "Do not save this." }, { id: "ordinary" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("Understood."),
			]);
			await run.ask("ace");
			expect(await watch.until("result", event => event.call === "ordinary")).toMatchObject({
				error: true, text: "Plans can only be written in Plan mode.",
			});
			expect(await run.request({ op: "plan", plan: draft.id })).toEqual({ hash: hash(text), text });
			await watch.stop();
		} finally { await run.channel.close(); }
	} finally { await rm(root, { recursive: true, force: true }); }
});

// The same plan card can appear correct while a stale or unauthorized click approves different bytes.
test("plan approvals are versioned, human-only, idempotent and confined to the chat", async () => {
	const { root, project, state } = await folders();
	try {
		const run = await open(project, state);
		try {
			const watch = await run.watch(true);
			const ordinary = await run.watch(false);
			const { chat } = await run.request<{ chat: number }>({ op: "chat", author: owner });
			const other = await run.watch(true, chat);
			const draft = async (call: string, watch: Watch) => (await watch.until("plans", event => event.plans.some(plan => plan.call === call))).plans.at(-1)!;
			const approve = (plan: Plan, fields: Partial<Extract<Request, { op: "plan-approve" }>> = {}) => run.request<Plan>({
				op: "plan-approve", author: owner, plan: plan.id, hash: plan.hash, ...fields,
			});
			expect(watch.of("plans").map(event => event.plans)).toEqual([[]]);
			await run.write("First draft", "first");
			const first = await draft("first", watch);
			const revised = "## Revised\n\nSecond draft";
			await run.write(revised, "revision");
			const revision = await draft("revision", watch);
			expect(revision.id).toBe(first.id);
			expect(await readdir(join(state, "plans"))).toHaveLength(1);
			await expect(approve(first)).rejects.toThrow("The plan has changed.");
			await expect(approve(revision, { author: "agent@other" })).rejects.toThrow("Only a person can approve a plan.");
			await expect(approve(revision, { author: "teammate" })).rejects.toThrow("Agent access is off");
			await expect(approve(revision, { author: "/invalid" })).rejects.toThrow("Invalid author");
			const [filename] = await readdir(join(state, "plans"));
			const path = join(state, "plans", filename);
			const altered = Buffer.from("\uFEFF## Altered outside the tool\r\n");
			await writeFile(path, altered);
			expect(await run.request({ op: "plan", plan: revision.id })).toEqual({ hash: hash(revised), text: revised });
			expect(await readFile(path, "utf8")).toBe(revised);
			await expect(approve(revision, { hash: hash(altered) })).rejects.toThrow("The plan has changed.");
			await run.write("Another chat's plan", "other", chat);
			const otherPlan = await draft("other", other);
			for (const plan of ["missing", `../plans/${filename}`, otherPlan.id]) {
				await expect(run.request({ op: "plan", plan })).rejects.toThrow("Unknown plan in this chat.");
				await expect(approve(revision, { plan })).rejects.toThrow("Unknown plan in this chat.");
			}

			const start = Date.now();
			const approved = await approve(revision);
			expect(approved).toEqual({ ...revision, state: "approved", approved: { by: owner, at: expect.any(Number) } });
			expect(approved.approved!.at).toBeWithin(start, Date.now() + 1);
			await watch.until("plans", event => event.plans.some(plan => plan.state === "approved"));
			await run.request({ op: "share", author: owner, shared: true });
			expect(await approve(revision, { author: "teammate" })).toEqual(approved);

			await run.write("Third draft", "next");
			const next = await draft("next", watch);
			expect(next.id).not.toBe(revision.id);
			expect(await readFile(path, "utf8")).toBe("## Revised\n\nSecond draft");
			expect(watch.of("plans").at(-1)?.plans).toEqual([approved, next]);
			const approvedNext = await approve(next, { author: "teammate" });
			const replaced: Plan = { ...approved, state: "replaced" };
			await until(() => watch.of("plans").at(-1)?.plans[1]?.state === "approved");
			expect(watch.of("plans").at(-1)?.plans).toEqual([replaced, approvedNext]);
			await expect(approve(approved)).rejects.toThrow("A later plan has already replaced this plan.");
			expect(await run.request({ op: "plan", plan: approved.id })).toEqual({ hash: revision.hash, text: "## Revised\n\nSecond draft" });
			expect(watch.of("plans").map(event => event.plans.map(plan => `${plan.call}:${plan.state}`))).toEqual([
				[], ["first:draft"], ["revision:draft"], ["revision:approved"],
				["revision:approved", "next:draft"], ["revision:replaced", "next:approved"],
			]);
			expect(ordinary.of("plans")).toEqual([]);
			expect(other.of("plans").map(event => event.plans)).toEqual([[], [otherPlan]]);
			const attached = await run.watch(true);
			expect(attached.of("plans").map(event => event.plans)).toEqual([[replaced, approvedNext]]);
			await Promise.all([watch.stop(), ordinary.stop(), other.stop(), attached.stop()]);
		} finally { await run.channel.close(); }
	} finally { await rm(root, { recursive: true, force: true }); }
});

// An approved card can look right while a comment-driven revision overwrites its Markdown file.
test("reading repairs the approved file and a comment send writes a separate draft", async () => {
	const { root, project, state } = await folders();
	try {
		const run = await open(project, state);
		try {
			const watch = await run.watch(true, undefined, true);
			const text = "# Approved plan\r\n\r\nShip this version.\r\n";
			await run.write(text, "approved-copy");
			const { plans: [draft] } = await watch.until("plans", event => event.plans.length === 1);
			const approved = await run.request<Plan>({ op: "plan-approve", author: owner, plan: draft.id, hash: hash(text) });
			await watch.until("plans", event => event.plans[0]?.state === "approved");
			const [filename] = await readdir(join(state, "plans"));
			const path = join(state, "plans", filename);
			await writeFile(path, "# A different plan\n");
			expect(await run.request({ op: "plan", plan: approved.id })).toEqual({ hash: hash(text), text });
			expect(await readFile(path, "utf8")).toBe(text);
			const kept = await run.request<PlanComment>({
				op: "plan-comment", author: owner, plan: approved.id, hash: approved.hash,
				lines: [{ line: 3, text: "Ship this version." }], quote: "Ship this version.", text: "Revise the rollout.",
			});
			const revisionText = "# Revised plan\n\nRoll out gradually.\n";
			run.fake.appendResponses([fauxAssistantMessage(fauxToolCall("plan_write", { text: revisionText }, { id: "revision" }), { stopReason: "toolUse" })]);
			const receipt = await run.request<{ submission: number; entry: number; comments: string[] }>({
				op: "plan-comments-send", author: owner, plan: approved.id, requestId: "revise-approved",
			});
			expect(receipt).toEqual({ submission: expect.any(Number), entry: expect.any(Number), comments: [kept.id] });
			expect(await run.request({ op: "wait", submission: receipt.submission })).toBe("done");
			const { plans: [original, revision] } = await watch.until("plans", event => event.plans.length === 2);
			expect(original).toEqual(approved);
			expect(revision).toMatchObject({ state: "draft", hash: hash(revisionText) });
			expect(revision.id).not.toBe(approved.id);
			expect(await readdir(join(state, "plans"))).toHaveLength(2);
			expect(await readFile(path, "utf8")).toBe(text);
			expect(await run.request({ op: "plan", plan: revision.id })).toEqual({ hash: hash(revisionText), text: revisionText });
			const { comments: [sent] } = await watch.until("plan-comments", event => event.comments[0]?.sent?.entry === receipt.entry);
			expect(sent).toMatchObject({ plan: approved.id, placement: kept.placement, sent: { entry: receipt.entry, submission: receipt.submission } });
			await watch.stop();
		} finally { await run.channel.close(); }
	} finally { await rm(root, { recursive: true, force: true }); }
});

// Pi keeps generating after a mixed tool round. A plan saved there could appear ready while the agent is still working.
test("a mixed tool round must retry the plan as a standalone call", async () => {
	const { root, project, state } = await folders();
	try {
		const run = await open(project, state);
		try {
			const watch = await run.watch(true);
			run.fake.appendResponses([
				fauxAssistantMessage([
					fauxToolCall("plan_write", { text: "One plan" }, { id: "first" }),
					fauxToolCall("plan_write", { text: "Another plan" }, { id: "second" }),
				], { stopReason: "toolUse" }),
				fauxAssistantMessage(fauxToolCall("plan_write", { text: "One finished plan" }, { id: "ready" }), { stopReason: "toolUse" }),
			]);
			await run.ask("plan");
			for (const call of ["first", "second"]) {
				expect(await watch.until("result", event => event.call === call)).toMatchObject({
					error: true, text: "Call plan_write on its own to end the turn.",
				});
			}
			const { plans: [draft] } = await watch.until("plans", event => event.plans.length > 0);
			expect(draft).toMatchObject({ call: "ready", hash: hash("One finished plan") });
			expect(run.fake.state.callCount).toBe(2);
			await watch.stop();
		} finally { await run.channel.close(); }
	} finally { await rm(root, { recursive: true, force: true }); }
});

// A snapshot can preserve the current Markdown while dropping the anchor version and the thread.
test("approved Markdown and anchored comments survive a native backup, restore and move", async () => {
	const { root, project, state } = await folders();
	const previous = runtimeHooks();
	const scope = { home: catalog.home, user: catalog.user, local: config.channelScope === "local" };
	try {
		git(project, "init", "-q");
		git(project, "commit", "-q", "--allow-empty", "-m", "Fixture");
		const home = join(root, "home");
		await mkdir(home);
		catalog.bind({ home, user: owner, local: true });
		configureRuntime({ nativeSources: undefined });
		const source = catalog.draft(project, model, "planned");
		const sourcePaths = catalog.paths(source.id);
		catalog.save(source);
		const run = await open(project, sourcePaths.base, source.id, source.name);
		const text = "# Durable plan\n\nKeep the approval and the bytes.\n";
		const earlier = "# Durable plan\n\nKeep the draft and the bytes.\n";
		let approved: Plan;
		let kept: PlanComment;
		try {
			const watch = await run.watch(true, undefined, true);
			await run.write(earlier, "earlier");
			const { plans: [original] } = await watch.until("plans", event => event.plans[0]?.call === "earlier");
			const comment = await run.request<PlanComment>({
				op: "plan-comment", author: owner, plan: original.id, hash: original.hash,
				lines: [{ line: 3, text: "Keep the draft and the bytes." }], quote: "Keep the draft", text: "Keep this with the revision.",
			});
			const thread = await run.request<PlanComment>({
				op: "plan-comment-reply", author: owner, comment: comment.id, text: "Keep the reply too.",
			});
			await run.write(text, "durable");
			const { plans: [draft] } = await watch.until("plans", event => event.plans[0]?.call === "durable");
			approved = await run.request<Plan>({ op: "plan-approve", author: owner, plan: draft.id, hash: hash(text) });
			kept = {
				...thread,
				placement: placeFileLinesAnchor(thread.anchor, earlier, { hash: draft.hash, text }),
			};
			expect((await watch.until("plan-comments", event => event.comments[0]?.placement.hash === draft.hash)).comments).toEqual([kept]);
			await watch.stop();
		} finally { await run.channel.close(); }
		const [filename] = await readdir(sourcePaths.plans);
		const path = join(sourcePaths.plans, filename);
		expect(await readFile(path, "utf8")).toBe(text);
		const directory = await backup(source, join(root, "backup"));
		const db = await openNodeSqliteDatabase(sourcePaths.storage);
		try {
			const snapshot = await exportSnapshot(db, source.id);
			const moved = await openNodeSqliteDatabase(join(state, "channel.sqlite"));
			try { await importSnapshot(moved, snapshot); } finally { await moved.close(); }
		} finally { await db.close(); }
		await mkdir(join(state, "plans"));
		await writeFile(join(state, "plans", filename), "# Parked copy\n");

		await remove(source.id);
		await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
		const restored = await restore(directory, { name: source.name });
		for (const target of [catalog.paths(restored.id).base, state]) {
			const copy = await open(project, target);
			try {
				const watch = await copy.watch(true, undefined, true);
				expect(watch.of("plans").map(event => event.plans)).toEqual([[approved]]);
				expect(watch.of("plan-comments").map(event => event.comments)).toEqual([[kept]]);
				expect(await copy.request({ op: "plan", plan: approved.id })).toEqual({ hash: hash(text), text });
				expect(await readFile(join(target, "plans", filename), "utf8")).toBe(text);
				await watch.stop();
			} finally { await copy.channel.close(); }
		}
	} finally {
		configureRuntime({ nativeSources: previous.nativeSources });
		catalog.bind(scope);
		await rm(root, { recursive: true, force: true });
	}
});
