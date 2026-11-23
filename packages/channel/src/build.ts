import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Type, type Static } from "@earendil-works/pi-ai";
import {
	AgentDoc, configure, defineDoc, defineExtension, defineTool, InboxDoc, LiveDoc,
	type ConversationId, type Harness, type InputSubmissionDraft, type SubmissionId, type SubmissionRecord, type TaskId, type ToolExecutionApi, type ToolExecutionResult, type Tx,
} from "@earendil-works/pi-durable";
import type { Admission } from "./extensions";
import { quote } from "./git";
import { LanesDoc } from "./lanes";
import { failure, type Log } from "./log";
import { findPlan, PlansDoc, type StoredPlan } from "./plan";
import { AGENT_MESSAGE_TOOL, AGENT_START_TOOL, buildId, type AgentMessageArgs, type AgentRole, type AgentStartArgs, type Build, type BuildAgent, type Effort, type ModelRef, type WorkMessage } from "./protocol";
import { ReviewCardsDoc } from "./review-cards";
import { content } from "./room";

declare const crypto: { randomUUID(): string };

type Worktree = { path: string; branch: string; base: string };
type ReviewSource = Pick<Worktree, "branch" | "base">;
export type BuildHost = {
	share(key: string, run: () => Promise<void>): Promise<void>;
	worktree(name: string, source?: ReviewSource): Promise<Worktree>;
	planPath(file: string): string;
};

type Start = {
	part?: string;
	model?: ModelRef;
	effort: Effort;
	worktree?: Worktree;
	brief?: { chat: ConversationId; requestId: string };
	lane: string;
	state: Extract<Build["state"], { kind: "starting" | "started" | "failed" }>;
} & (
	| { role: "implementer" }
	| { by: ConversationId; task: TaskId } & (
		| { role: "reviewer"; source: ReviewSource }
		| { role: "implementer"; part: string; text: string }
	)
);
type StoredBuild = {
	build: Build;
	file: string;
	starts: Record<string, Start>;
	revision?: { requests: Record<string, string> };
	stopping?: { chat: ConversationId; running: boolean }[];
};

type StoredMessage = { requestId: string; message: WorkMessage & { to: ConversationId }; submission?: SubmissionId };
export type BuildsState = { records: Record<string, StoredBuild>; messages: StoredMessage[] };
export const BuildsDoc = defineDoc<BuildsState>({
	kind: "neuve.builds",
	version: 1,
	scope: "session",
	initial: () => ({ records: {}, messages: [] }),
});

const Role = Type.Union([Type.Literal("implementer"), Type.Literal("reviewer")]);
const StartParameters = Type.Object({
	role: Role,
	part: Type.Optional(Type.String()),
	brief: Type.Optional(Type.String()),
}, { additionalProperties: false });

const agentKey = (role: AgentRole, part?: string) => JSON.stringify([role, part ?? null]);
const firstImplementer = agentKey("implementer");
const messagePrefix = "neuve.build:message:";

export function isWorkMessageSubmission(submission: SubmissionRecord): boolean {
	return submission.type === "input" && (submission.requestId?.startsWith(messagePrefix) ?? false);
}

export function workLog(value: Readonly<BuildsState> | null): WorkMessage[] {
	return (value?.messages ?? [])
		.flatMap(({ message, submission }) => submission === undefined ? [] : [{ message, submission }])
		.sort((a, b) => a.submission - b.submission)
		.map(({ message }) => message);
}

function refuse(text: string): ToolExecutionResult {
	return { isError: true, content: [{ type: "text", text }] };
}

export function buildTools(builds: () => Builds) {
	return defineExtension({
		name: "neuve-build",
		tools: [defineTool({
			name: AGENT_START_TOOL,
			description: "Ask the host to start another agent of this plan. Give an implementer a part and a brief. For a reviewer, the host writes the brief. A reviewer follows the implementer who asked for it, or the implementer with no part if a reviewer asked.",
			parameters: StartParameters,
			replay: "safe",
			execute: (args, api, context) => builds().startAgent(args, api, context),
		}), defineTool({
			name: AGENT_MESSAGE_TOOL,
			description: "Send a message to an agent of this plan. Name its role and part. Leave out the part to reach the agent with no part.",
			parameters: Type.Object({
				to: Role,
				part: Type.Optional(Type.String()),
				text: Type.String(),
			}, { additionalProperties: false }),
			replay: "safe",
			execute: (args, api, context) => builds().messageAgent(args, api, context),
		})],
	});
}

function buildRefusal(state: Build["state"]["kind"]): string | undefined {
	if (state === "stopped") return "The plan's agents have been stopped.";
	if (state === "paused") return "The plan's agents are paused while other people may ask them.";
}

function briefText(record: StoredBuild, worktree: Worktree, planPath: string, start: Start): string {
	const { path, branch, base } = worktree;
	const plan = record.build.plan;
	const reference = [
		`The approved plan “${plan.title}” is at ${planPath}. Its hash is ${plan.hash}.`,
		`Work on branch ${branch} in the worktree at ${path}.`,
	];
	if ("text" in start) return [...reference, "", start.text].join("\n");
	const source = start.role === "reviewer" ? start.source.branch : undefined;
	return [
		...reference,
		source ? `Review the implementer’s work on branch ${source}.` : "Implement this plan.",
		"Load the Neuve skill. Fill in the question and run this command.",
		`neuve query --repo ${quote(path)} --revision ${base}${source ? ` --branch ${quote(source)}` : ""} --question "<the plan's goal and its done-when items in one sentence>" --scope ${quote(planPath)}`,
		...(source ? [] : ["Use agent_start to ask the host for a reviewer or another implementer."]),
		"Use agent_message to message another agent of this plan.",
	].join("\n");
}

async function alive(tx: Tx, build: Build): Promise<boolean> {
	if (build.state.kind === "starting") return true;
	if (build.state.kind !== "started") return false;
	for (const agent of build.agents) {
		const chat = agent.chat as ConversationId;
		if ((await tx.doc(LiveDoc, chat)).run) return true;
		if ((await tx.doc(InboxDoc, chat)).items.length) return true;
		if (Object.values((await tx.doc(ReviewCardsDoc, chat)).cards).some(card =>
			card.kind === "review" && (card.phase === "queued" || card.phase === "running"))) return true;
	}
	return false;
}

export class Builds {
	#agents = new Map<number, { build: string; index: number; requestId: string; role: AgentRole; part?: string }>();
	#document?: Readonly<BuildsState> | null;
	#pending = new Set<Promise<void>>();
	#closing = false;

	constructor(private readonly harness: Harness, private readonly log: Log, private readonly options: {
		shared(): boolean;
		admit: Admission["serialize"];
		stop(chat: ConversationId, by: string, at: number, requestId?: string): Promise<void>;
		host?: BuildHost;
	}) {}

	observe(value: Readonly<BuildsState> | null | undefined): void {
		this.#document = value;
		this.#agents.clear();
		for (const { build, starts } of Object.values(value?.records ?? {})) {
			for (const [index, { chat, role, part }] of build.agents.entries()) {
				const { requestId } = starts[agentKey(role, part)]!.brief!;
				this.#agents.set(chat, { build: build.id, index, requestId, role, part });
			}
		}
	}

	agent(chat: number) { return this.#agents.get(chat); }

	isBrief(submission: SubmissionRecord): boolean {
		return submission.type === "input" && submission.requestId !== undefined
			&& submission.requestId === this.agent(submission.conversationId)?.requestId;
	}

	async paused(chat: ConversationId, scope: Context): Promise<string | undefined> {
		if (!this.options.shared() || !this.#agents.size) return;
		return this.harness.commit(async tx => {
			for (let id: ConversationId | undefined = chat; id !== undefined;) {
				const agent = this.agent(id);
				if (agent && this.#document?.records[agent.build]?.build.state.kind === "paused") return buildRefusal("paused");
				id = (await tx.conversation(id))?.owner?.conversationId;
			}
		}, scope);
	}

	async share(tx: Tx, shared: boolean): Promise<string[]> {
		const resumed: string[] = [];
		for (const { build, starts } of Object.values((await tx.doc(BuildsDoc)).records)) {
			if (shared && (build.state.kind === "starting" || build.state.kind === "started")) {
				build.state = { kind: "paused", reason: "shared" };
			} else if (!shared && build.state.kind === "paused") {
				build.state = starts[firstImplementer]!.state;
				if (Object.values(starts).some(start => start.state.kind === "starting")) resumed.push(build.id);
			}
		}
		return resumed;
	}

	async stop(id: string, by: string) {
		const stopping = await this.harness.commit(async tx => {
			const record = (await tx.doc(BuildsDoc)).records[id];
			if (!record) throw new Error("This plan has no agents to stop.");
			if (record.build.state.kind === "stopped") return false;
			record.build.state = { kind: "stopped", by, at: Date.now() };
			record.stopping = [];
			for (const agent of record.build.agents) {
				const chat = agent.chat as ConversationId;
				const running = !!(await tx.doc(LiveDoc, chat)).run;
				if (running || agent.state === "running" || agent.state === "waiting") agent.state = "stopped";
				record.stopping.push({ chat, running });
			}
			return true;
		}, context);
		if (stopping) await this.finishStops(id);
	}

	async finishStops(id?: string) {
		const records = this.#document?.records ?? {};
		for (const record of id === undefined ? Object.values(records) : [records[id]]) {
			if (!record?.stopping || record.build.state.kind !== "stopped") continue;
			const { build, stopping } = record;
			const { by, at } = record.build.state;
			await Promise.all(stopping.map(async ({ chat, running }) => {
				// Drain admission before aborting, without holding it while tools finish.
				await this.options.admit(chat, async () => {});
				await this.options.stop(chat, by, at, running ? `neuve.build:${build.id}:stop:${chat}` : undefined);
			}));
			await this.harness.commit(async tx => { delete (await tx.doc(BuildsDoc)).records[build.id]!.stopping; }, context);
			this.log("info", "build.stopped", { build: build.id });
		}
	}

	async updateAgent(tx: Tx, chat: ConversationId, change: Partial<Pick<BuildAgent, "state" | "caption">>) {
		const agent = this.agent(chat);
		if (!agent) return;
		const record = (await tx.doc(BuildsDoc)).records[agent.build];
		if (!record || (record.stopping && change.state)) return;
		Object.assign(record.build.agents[agent.index]!, change);
	}

	async state(chat: ConversationId, state: BuildAgent["state"], firstInput: SubmissionId | undefined) {
		const brief = this.agent(chat);
		if (!brief) return;
		await this.#track(this.harness.commit(async tx => {
			// Steering keeps the run’s first input. A follow-up starts a new run.
			if ((await tx.doc(LiveDoc, chat)).run?.inputs[0] === firstInput) {
				await this.updateAgent(tx, chat, { state });
			}
		}, context).catch(error => this.log("error", "build.agent.state.failed", {
			build: brief.build, chat, state, ...failure(error),
		})));
	}

	async approve(tx: Tx, chat: ConversationId, { plan, file }: StoredPlan, approved: Build["approved"]) {
		const id = buildId(chat, plan.hash);
		const { records } = await tx.doc(BuildsDoc);
		if (records[id]) return;
		const build: Build = {
			id, chat, approved, agents: [], state: { kind: "starting" },
			plan: { id: plan.id, hash: plan.hash, title: plan.title, call: plan.call },
		};
		const record: StoredBuild = { build, file, starts: {} };
		if (!this.options.host) build.state = { kind: "unavailable", reason: "hosted" };
		else if (this.options.shared()) build.state = { kind: "unavailable", reason: "shared" };
		else {
			for (const { build: prior } of Object.values(records).reverse()) {
				if (prior.chat !== chat || !await alive(tx, prior)) continue;
				build.state = { kind: "delivered", to: prior.id };
				record.revision = { requests: {} };
				break;
			}
		}
		if (build.state.kind === "starting") {
			const agent = await tx.doc(AgentDoc, chat);
			record.starts[firstImplementer] = {
				role: "implementer", state: { kind: "starting" }, lane: `build-${plan.id}`,
				...(agent.model ? { model: { ...agent.model } } : {}), effort: agent.thinkingLevel ?? "off",
			};
		}
		records[id] = record;
		return build.state.kind;
	}

	get pending(): boolean { return this.#pending.size > 0; }

	async startAgent(
		{ role, part, brief }: Static<typeof StartParameters>,
		api: ToolExecutionApi,
		context: Context,
	): Promise<ToolExecutionResult> {
		let request: AgentStartArgs;
		if (role === "reviewer") {
			if (brief !== undefined) return refuse("The host writes the reviewer’s brief.");
			if (part !== undefined && !part.trim()) return refuse("Give the reviewer a part or leave it out.");
			request = { role, part };
		} else {
			if (!part?.trim()) return refuse("Give the implementer a part.");
			if (!brief?.trim()) return refuse("Give the implementer a brief.");
			request = { role, part, brief };
		}
		const key = agentKey(role, part);
		const reserved = await api.commit(async tx => {
			const { records } = await tx.doc(BuildsDoc);
			const caller = this.agent(api.conversationId);
			const record = caller && records[caller.build];
			if (!record) return { refusal: "Only an agent of a plan can ask the host to start another agent." };
			const { build } = record;
			const blocked = buildRefusal(build.state.kind);
			if (blocked) return { refusal: blocked };
			if (build.state.kind === "failed") return { refusal: "The host couldn't finish starting the plan's implementer." };
			const { starts } = record;
			const existing = starts[key];
			if (existing && "task" in existing && existing.task === api.taskId) return { id: build.id };
			if (existing) {
				return { refusal: "This plan already has an agent with that role and part." };
			}
			const start = {
				by: api.conversationId, task: api.taskId, lane: `build-${crypto.randomUUID()}`,
				state: { kind: "starting" as const },
			};
			if (request.role === "reviewer") {
				const implementer = starts[agentKey("implementer", caller.role === "implementer" ? caller.part : undefined)];
				if (!implementer?.worktree || !implementer.brief) return { refusal: "The implementer’s worktree could not be found." };
				const { branch, base } = implementer.worktree;
				const settings = await tx.doc(AgentDoc, implementer.brief.chat);
				starts[key] = {
					...start, role: request.role, ...(part === undefined ? {} : { part }),
					...(settings.model ? { model: { ...settings.model } } : {}), effort: settings.thinkingLevel ?? "off",
					source: { branch, base },
				};
			} else {
				const approved = starts[firstImplementer]!;
				starts[key] = {
					...start, role: request.role, part: request.part, text: request.brief,
					...(approved.model ? { model: { ...approved.model } } : {}), effort: approved.effort,
				};
			}
			return { id: build.id, fresh: true };
		}, context);
		if (reserved.refusal !== undefined) return refuse(reserved.refusal);
		const { id } = reserved;
		const host = this.options.host!;
		if (reserved.fresh) this.log("info", "build.agent.recorded", { build: id, role, part });
		await this.#track(host.share(`${id}:${key}`, () => this.#start(id, host, key)));
		const start = (await api.snapshot(BuildsDoc, context))?.records[id]?.starts[key];
		if (start?.state.kind === "failed") return refuse(start.state.detail);
		if (start?.state.kind !== "started") return refuse("This agent start was interrupted.");
		const text = part === undefined ? `The ${role} started.` : `The ${role} for ${part} started.`;
		return { content: [{ type: "text", text }] };
	}

	async messageAgent({ to, part, text }: AgentMessageArgs, api: ToolExecutionApi, context: Context): Promise<ToolExecutionResult> {
		if (!text.trim()) return refuse("Write a message to send.");
		const from = api.conversationId;
		const requestId = `${messagePrefix}${from}:${api.taskId}`;
		const reserved = await api.commit(async tx => {
			const { records, messages } = await tx.doc(BuildsDoc);
			const existing = messages.find(message => message.requestId === requestId);
			if (existing?.submission !== undefined) return;
			if (existing) return { build: existing.message.build };
			const sender = this.agent(from);
			const record = sender && records[sender.build];
			if (!record) return { refusal: "Only an agent of a plan can message another agent of that plan." };
			const blocked = buildRefusal(record.build.state.kind);
			if (blocked) return { refusal: blocked };
			const recipient = record.starts[agentKey(to, part)];
			if (recipient?.state.kind !== "started" || !recipient.brief) {
				return { refusal: "This plan has no started agent with that role and part." };
			}
			const chat = recipient.brief.chat;
			if (chat === from) return { refusal: "Send the message to another agent of this plan." };
			const message = { build: record.build.id, from, to: chat, at: Date.now(), text };
			messages.push({ requestId, message });
			return { build: message.build, fresh: true };
		}, context);
		if (reserved?.refusal !== undefined) return refuse(reserved.refusal);
		if (reserved) {
			const { build, fresh } = reserved;
			const host = this.options.host!;
			if (fresh) this.log("info", "build.message.recorded", { build, chat: from });
			try {
				await this.#track(host.share(requestId, () => this.#deliverMessage(requestId)));
			} catch (error) {
				this.log("error", "build.message.failed", { build, chat: from, ...failure(error) });
				return refuse("The host could not finish sending this message.");
			}
			const stored = (await api.snapshot(BuildsDoc, context))?.messages.find(message => message.requestId === requestId);
			if (stored?.submission === undefined) return refuse("The host has not finished sending this message.");
		}
		return { content: [{ type: "text", text: "The message was sent." }] };
	}

	async #track(task: Promise<void>): Promise<void> {
		this.#pending.add(task);
		try { await task; }
		finally { this.#pending.delete(task); }
	}

	async resume(id?: string): Promise<void> {
		const host = this.options.host;
		if (!host || this.#closing) return;
		const task = (async () => {
			const { records, messages } = (await this.harness.snapshot(BuildsDoc, context)) ?? { records: {}, messages: [] };
			if (id === undefined) {
				for (const { requestId, message, submission } of messages) {
					if (this.#closing) return;
					if (submission !== undefined) continue;
					await host.share(requestId, () => this.#deliverMessage(requestId)).catch(error =>
						this.log("error", "build.message.resume.failed", { build: message.build, chat: message.to, ...failure(error) }));
				}
			}
			const selected = id ? [records[id]].filter(record => record !== undefined) : Object.values(records);
			await Promise.all(selected.map(async ({ build, revision, starts }) => {
				try {
					if (this.#closing) return;
					if (build.state.kind === "delivered" && revision) {
						await this.#deliver(build.state.to, host);
					}
					await Promise.all(Object.entries(starts).map(async ([key, start]) => {
						if (start.state.kind !== "starting") return;
						const sharedKey = `${build.id}:${key}`;
						const run = () => this.#start(build.id, host, key);
						await host.share(sharedKey, run);
						// Unshare can join a start that just yielded to the pause.
						if (this.#canSend(build.id) &&
							this.#document?.records[build.id]?.starts[key]?.state.kind === "starting") {
							await host.share(sharedKey, run);
						}
					}));
					if (build.state.kind === "starting") await this.#deliver(build.id, host);
				} catch (error) {
					this.log("error", "build.resume.failed", { build: build.id, ...failure(error) });
				}
			}));
		})().catch(error => this.log("error", "build.resume.failed", { build: id, ...failure(error) }));
		await this.#track(task);
	}

	async close(): Promise<void> {
		this.#closing = true;
		await Promise.allSettled(this.#pending);
	}

	#canSend(build: string) {
		const state = this.#document?.records[build]?.build.state.kind;
		return !this.#closing && (state === "starting" || state === "started");
	}

	#send(build: string, chat: ConversationId, draft: InputSubmissionDraft & { requestId: string }) {
		return this.options.admit(chat, async () => {
			if (this.#canSend(build)) {
				const conversation = await this.harness.conversation(chat, context);
				if (!conversation) throw new Error("The agent’s chat could not be found.");
				if (this.#canSend(build)) return (await conversation.submit(draft, context)).id;
			}
			return this.harness.commit(async tx => (await tx.submissionByRequest(chat, draft.requestId))?.id, context);
		});
	}

	async #deliverMessage(requestId: string): Promise<void> {
		const stored = (await this.harness.snapshot(BuildsDoc, context))?.messages.find(message => message.requestId === requestId);
		if (this.#closing || !stored || stored.submission !== undefined) return;
		const { build, from, to, text } = stored.message;
		const submission = await this.#send(build, to, {
			type: "input", whenBusy: "steer", requestId, content: content(`agent@${from}`, text),
		});
		if (submission === undefined) return;
		this.log("info", "build.message.submitted", { build, chat: to, submission });
		await this.harness.commit(async tx => {
			(await tx.doc(BuildsDoc)).messages.find(message => message.requestId === requestId)!.submission = submission;
		}, context);
		this.log("info", "build.message.delivered", { build, chat: to, submission });
	}

	async #start(id: string, host: BuildHost, key: string): Promise<void> {
		const record = (await this.harness.snapshot(BuildsDoc, context))?.records[id];
		const start = record?.starts[key];
		if (!this.#canSend(id) || !record || start?.state.kind !== "starting") return;
		const { role, part, lane } = start;
		const first = key === firstImplementer;
		const by = "by" in start ? start.by : undefined;
		const update = <T>(change: (saved: Start, build: Build, tx: Tx) => T | Promise<T>) =>
			this.harness.commit(async tx => {
				const { build, starts } = (await tx.doc(BuildsDoc)).records[id]!;
				return change(starts[key]!, build, tx);
			}, context);
		const log = (event: string, fields?: Record<string, unknown>) =>
			this.log("info", event, { build: id, role, part, ...fields });
		let detail = `The ${role}'s worktree could not be created.`;
		try {
			let worktree = start.worktree;
			if (!worktree) {
				worktree = await host.worktree(lane, role === "reviewer" ? start.source : undefined);
				const created = worktree;
				await update(saved => { saved.worktree = created; });
				log("build.worktree", { path: worktree.path, branch: worktree.branch });
			}
			detail = `The ${role}’s chat could not be created.`;
			const { path, branch, base } = worktree;
			let brief = start.brief;
			if (!brief) {
				brief = await update(async (saved, build, tx) => {
					if (!this.#canSend(id)) return;
					const { id: chat } = await tx.createConversation({ ownership: { kind: "ownerless" } });
					await configure(tx, chat, { model: start.model, thinkingLevel: start.effort, cwd: path });
					(await tx.doc(LanesDoc)).lanes[lane] = { chat, path, base };
					build.agents.push({
						chat, role, state: "running", started: Date.now(),
						...(part === undefined ? {} : { part }), ...(by === undefined ? {} : { by }),
					});
					const brief = { chat, requestId: `neuve.build:${id}:brief:${chat}` };
					saved.brief = brief;
					return brief;
				});
				if (!brief) return;
				log("build.chat", { chat: brief.chat });
			}
			detail = `The ${role}’s brief could not be sent.`;
			const planPath = host.planPath(record.file);
			const submission = await this.#send(id, brief.chat, {
				type: "input", whenBusy: "followUp", requestId: brief.requestId,
				content: briefText(record, worktree, planPath, start),
			});
			if (submission === undefined) return;
			log("build.brief", { chat: brief.chat, submission });
			detail = `The ${role}’s start could not be recorded.`;
			await update((saved, build) => {
				saved.state = { kind: "started" };
				if (first && build.state.kind === "starting") build.state = saved.state;
			});
			log(first ? "build.started" : "build.agent.started");
		} catch (error) {
			this.log("error", first ? "build.failed" : "build.agent.failed", { build: id, role, part, ...failure(error) });
			await update(async (saved, build, tx) => {
				saved.state = { kind: "failed", detail };
				if (first && build.state.kind === "starting") build.state = saved.state;
				if (saved.brief && build.state.kind !== "stopped") await this.updateAgent(tx, saved.brief.chat, { state: "failed" });
			});
		}
	}

	async #deliver(to: string, host: BuildHost): Promise<void> {
		const records = (await this.harness.snapshot(BuildsDoc, context))?.records;
		const target = records?.[to];
		if (!records || target?.build.state.kind !== "started") return;
		for (const { build, revision } of Object.values(records)) {
			if (this.#closing) return;
			if (!revision || build.state.kind !== "delivered" || build.state.to !== to) continue;
			try {
				await host.share(build.id, () => this.#deliverRevision(build, target));
			} catch (error) {
				this.log("error", "build.revision.failed", { build: build.id, ...failure(error) });
				return;
			}
		}
	}

	async #deliverRevision(build: Build, target: StoredBuild): Promise<void> {
		const recipients = await this.harness.commit(async tx => {
			const pending = (await tx.doc(BuildsDoc)).records[build.id]?.revision;
			if (!pending) return;
			const fresh = !Object.keys(pending.requests).length;
			return Object.values(target.starts).flatMap(({ state, brief }) => {
				if (state.kind !== "started" || !brief) return [];
				const { chat } = brief;
				if (fresh) pending.requests[chat] = `neuve.build:revision:${build.id}:${chat}`;
				const requestId = pending.requests[chat];
				return requestId ? [{ chat, requestId }] : [];
			});
		}, context);
		if (!recipients) return;
		const plans = await this.harness.snapshot(PlansDoc, context);
		const { text } = findPlan(plans?.chats[build.chat], build.plan.id);
		for (const { chat, requestId } of recipients) {
			const submission = await this.#send(target.build.id, chat, {
				type: "input", whenBusy: "steer", requestId,
				content: content(build.approved.by, text),
			});
			if (submission === undefined) return;
			this.log("info", "build.revision.submitted", { build: build.id, chat, submission });
		}
		await this.harness.commit(async tx => {
			delete (await tx.doc(BuildsDoc)).records[build.id]!.revision;
		}, context);
	}
}
