import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Type, type AssistantMessage, type Static } from "@earendil-works/pi-ai";
import { TURN_CANCELLED, TURN_RETRY_FAILURE, TurnRetryFailure } from "@neuve/records-schema/turn-recovery";
import {
	AgentDoc, configure, defineDoc, defineExtension, defineTool, InboxDoc, LiveDoc,
	type ConversationId, type EntryId, type Harness, type InputSubmissionDraft, type SubmissionId, type SubmissionRecord, type TaskId, type ToolExecutionApi, type ToolExecutionResult, type Tx,
} from "@earendil-works/pi-durable";
import type { Channel } from "./channel";
import type { Admission } from "./extensions";
import { LanesDoc } from "./lanes";
import { failure, type Log } from "./log";
import { checkedPlanText, findPlan, PlansDoc, type StoredPlan } from "./plan";
import { AGENT_MESSAGE_TOOL, AGENT_START_TOOL, buildId, failureCaption, type AgentFailure, type AgentMessage, type AgentMessageArgs, type AgentRole, type AgentStartArgs, type Build, type BuildAgent, type BuildReview, type Effort, type ModelRef, type WorkMessage } from "./protocol";
import { ReviewCardsDoc, type ReviewCard } from "./review-cards";
import { content, draft, text as messageText } from "./room";

declare const crypto: { randomUUID(): string };

type Worktree = { path: string; branch: string; base: string };
type ReviewSource = Pick<Worktree, "branch" | "base">;
export type BuildHost = {
	share<T>(key: string, run: () => Promise<T>): Promise<T>;
	worktree(...args:
		| [name: string, source?: ReviewSource | "origin"]
		| [placement: { chat: ConversationId; recorded?: { path: string; base?: string } }]
	): Promise<Worktree>;
	removeWorktree?(lane: string, worktree: Worktree, head: string): Promise<boolean>;
	query?: {
		sessionId: string;
		read(input: ScopeRead): Promise<ScopeReadAnswer>;
	};
};

type ScopeRead = {
	repository: string;
	revision: string;
	branch?: string;
	question: string;
	scope: readonly string[];
	plan: PlanCitation & { text: string };
	previousPlans: readonly PlanCitation[];
	requester: { _tag: "Agent"; harness: "neuve-pi"; sessionId: string; subagentId: string };
};

type PlanCitation = Pick<StoredPlan, "file"> & Pick<StoredPlan["plan"], "title" | "hash">;
type ScopeReadAnswer = { text: string; isError?: true };

type Start = {
	part?: string;
	model?: ModelRef;
	effort: Effort;
	worktree?: Worktree;
	brief?: { chat: ConversationId; requestId: string };
	lane: string;
	pendingRuns?: SubmissionId[];
	lastRun?: SubmissionId;
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
	starts: Record<string, Start>;
	revision?: { requests: Record<string, string> };
	stopping?: { chat: ConversationId; running: boolean }[];
	mergeCleanup?: { head: string };
	finishedReview?: { humanRequired: number; reviewerHeads: string[] };
};

type StoredMessage = {
	requestId: string;
	message: AgentMessage & { to: ConversationId };
	submission?: SubmissionId;
	failure?: AgentFailure;
	deliveryFailed?: true;
};
export type Mention = { thread: ConversationId; requestId: string; author: string; text: string; agents: ConversationId[] };
type PendingMention = Omit<Mention, "author" | "text"> & {
	entry?: EntryId;
	author?: string;
	text?: string;
	deliveries?: Record<string, SubmissionId | "settled">;
};
type StoredMention = PendingMention | { entry: EntryId; agents: ConversationId[] };
type MentionReply = {
	thread: ConversationId;
	chat: ConversationId;
	answer: EntryId;
	inputs: { id: SubmissionId; requestId: string; mention: string }[];
};
export type BuildsState = { records: Record<string, StoredBuild>; messages: StoredMessage[]; mentions?: StoredMention[] };
/** Local host projection of the committed build and its agents' last completed runs. */
export type BuildPull = { build: Build; ended: number[]; finishedReview?: StoredBuild["finishedReview"] };
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
const ScopeParameters = Type.Object({
	question: Type.String({ pattern: "\\S" }),
	scope: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
}, { additionalProperties: false });
const scopeReadExtension = { name: "neuve-query" };

const agentKey = (role: AgentRole, part?: string) => JSON.stringify([role, part ?? null]);
const firstImplementer = agentKey("implementer");
const messagePrefix = "neuve.build:message:";
const failurePrefix = `${messagePrefix}failure:`;
const mentionPrefix = "neuve.build:mention:";
const stopped = "The plan's agents have been stopped.";
const pendingStart = "The agent start is recorded and will finish when work resumes.";
export const waitForBrief = "Wait for the host to send the agent’s brief.";

function unknownAgent(records: readonly StoredBuild[]): string {
	const agents = new Set(records.flatMap(record => record.build.agents
		.filter(({ role, part }) => record.starts[agentKey(role, part)]?.state.kind === "started")
		.map(({ role, part }) => `${role === "implementer" ? "an" : "a"} ${role}${part === undefined ? "" : ` for ${JSON.stringify(part)}`}`)));
	const multiple = records.length > 1;
	const target = multiple ? "The available plans have no unique started agent with that role and path scope."
		: "This plan has no started agent with that role and path scope.";
	const subject = multiple ? "The available plans have" : "The plan has";
	const listing = agents.size ? `started ${new Intl.ListFormat("en").format(agents)}.` : "no started agents yet.";
	return `${target} ${subject} ${listing}`;
}

export class MentionStopping extends Error {
	constructor(readonly builds: string[]) { super(stopped); }
}

export function isWorkMessageSubmission(submission: SubmissionRecord): boolean {
	return submission.type === "input" && (submission.requestId?.startsWith(messagePrefix) ?? false);
}

export function isMentionSubmission<T extends Pick<SubmissionRecord, "type" | "requestId">>(submission: T): submission is T & { type: "input"; requestId: string } {
	return submission.type === "input" && (submission.requestId?.startsWith(mentionPrefix) ?? false);
}

const mentionKey = (thread: ConversationId, requestId: string) => `${thread}:${requestId}`;
const mentionDeliveryId = ({ thread, requestId }: PendingMention, chat: ConversationId) =>
	`${mentionPrefix}${mentionKey(thread, requestId)}:${chat}`;

function compactMention(mentions: StoredMention[], index: number, mention: PendingMention) {
	const { deliveries } = mention;
	if (!deliveries || !mention.agents.every(chat => deliveries[chat] !== undefined)) return;
	if (mention.agents.every(chat => deliveries[chat] === "settled")) {
		mentions[index] = { entry: mention.entry!, agents: [...mention.agents] };
	} else {
		delete mention.author;
		delete mention.text;
	}
}

export function workLog(value: Readonly<BuildsState> | null): WorkMessage[] {
	const failures = new Map<string, Extract<WorkMessage, { kind: "agent-failure" }>>();
	const messages = (value?.messages ?? [])
		.flatMap(({ requestId, message, submission, failure, deliveryFailed }) => {
			if (!failure) return submission === undefined ? [] : [{ message, submission }];
			const key = JSON.stringify([message.build, message.from, failure.turn]);
			let entry = failures.get(key);
			if (!entry) {
				entry = { ...message, kind: "agent-failure", failure, deliveries: [] };
				failures.set(key, entry);
			}
			if (requestId.startsWith(messagePrefix)) {
				entry.deliveries.push({
					to: message.to,
					status: submission !== undefined ? "sent" : deliveryFailed ? "failed" : "pending",
				});
			}
			return [];
		})
		.sort((a, b) => a.submission - b.submission)
		.map(({ message }) => message);
	if (!failures.size) return messages;
	return [...messages, ...failures.values()].sort((a, b) => a.at - b.at);
}

type EndedInput = Extract<SubmissionRecord, { type: "input"; status: "done" | "unanswered" }>;
const endedInput = (input: SubmissionRecord | undefined): input is EndedInput =>
	input?.type === "input" && (input.status === "done" || input.status === "unanswered");

function runFailure(input: EndedInput, response?: AssistantMessage) {
	if (input.status !== "unanswered" || input.entry === undefined) return;
	if (["aborted", "reset", "stale", "cancelled", "canceled"].includes(input.reason)) return;
	if (response?.diagnostics?.some(item => item.type === TURN_CANCELLED)) return;
	const diagnostic = response?.diagnostics?.findLast(item => item.type === TURN_RETRY_FAILURE);
	const retry = TurnRetryFailure.safeParse(diagnostic?.details);
	if (diagnostic && retry.success) return {
		turn: retry.data.turn, reason: retry.data.reason, attempts: retry.data.attempt + 1,
		at: Number.isFinite(diagnostic.timestamp) ? diagnostic.timestamp : Date.now(),
	};
	const reason = ["model_error", "no_model", "faulted"].includes(input.reason) ? input.reason : "run_failed";
	return { turn: `submission:${input.id}`, reason, attempts: 1, at: Date.now() };
}

function answer(text: string): ToolExecutionResult {
	return { content: [{ type: "text", text }] };
}

function refuse(text: string): ToolExecutionResult {
	return { ...answer(text), isError: true };
}

export function buildTools(builds: () => Builds) {
	const agents = defineExtension({
		name: "neuve-build",
		tools: [defineTool({
			name: AGENT_START_TOOL,
			description: "Ask the host to start another agent of this plan. Give an implementer a path scope in the part field and a brief. For a reviewer, the host writes the brief. A reviewer follows the implementer who asked for it, or the first implementer if a reviewer asked.",
			parameters: StartParameters,
			replay: "safe",
			execute: (args, api, context) => builds().startAgent(args, api, context),
		}), defineTool({
			name: AGENT_MESSAGE_TOOL,
			description: "Send a message to an agent of this plan, from a started agent or the chat that drafted the plan. Name its role and give its path scope in the part field. Omit that field to reach the agent assigned to the whole plan.",
			parameters: Type.Object({
				to: Role,
				part: Type.Optional(Type.String()),
				text: Type.String(),
			}, { additionalProperties: false }),
			replay: "safe",
			execute: (args, api, context) => builds().messageAgent(args, api, context),
		})],
	});
	const query = defineExtension({
		...scopeReadExtension,
		tools: [defineTool({
			name: "neuve_query",
			description: "Read code and scope for the approved plan. Ask a question and optionally name extra files in scope.",
			parameters: ScopeParameters,
			replay: "safe",
			execute: (args, api, context) => builds().readScope(args, api, context),
		})],
	});
	return {
		agents,
		query,
		async clearInheritedQuery(tx: Tx, { id }: { id: ConversationId }) {
			const agent = await tx.doc(AgentDoc, id);
			if (!Array.isArray(agent.extensions) && agent.extensions?.add?.includes(query.name)) {
				agent.extensions.add = agent.extensions.add.filter(name => name !== query.name);
			}
		},
	};
}

async function firstStart(tx: Tx, chat: ConversationId, plan: string): Promise<Start> {
	const agent = await tx.doc(AgentDoc, chat);
	return {
		role: "implementer", state: { kind: "starting" }, lane: `build-${plan}`,
		...(agent.model ? { model: { ...agent.model } } : {}), effort: agent.thinkingLevel ?? "off",
	};
}

function buildRefusal(state: Build["state"]["kind"]): string | undefined {
	if (state === "stopped") return stopped;
	if (state === "paused") return "The plan's agents are paused while other people may ask them.";
}

const refusedBySharing = (state: Build["state"]) => state.kind === "unavailable" && state.reason === "shared";

async function approvedPlan(plans: readonly StoredPlan[] | undefined) {
	const stored = plans!.findLast(({ plan }) => plan.state === "approved")!;
	const { file, plan: { title, hash }, text } = stored;
	return { file, title, hash, text: await checkedPlanText(hash, text) };
}

function briefText(plan: ScopeRead["plan"], { path, branch }: Worktree, start: Start, query: boolean): string {
	const reference = [
		`Approved plan "${plan.title}" (${plan.hash}).`,
		`Work on branch ${branch} in the worktree at ${path}.`,
		"Load the Neuve skill.",
		"Push your work with lane push. The host opens, readies and merges the plan's pull request. Do not run gh pr create, gh pr ready or gh pr merge.",
		...(query ? ["Ask for your scope with neuve_query using the plan's goal and done-when items as your question."] : []),
		"",
		plan.text,
		"",
	];
	if ("text" in start) return [...reference, start.text].join("\n");
	const source = start.role === "reviewer" ? start.source.branch : undefined;
	return [
		...reference,
		source ? `Review the implementer's work on branch ${source}.` : "Implement this plan.",
		...(source ? [] : ["Use agent_start to ask the host for a reviewer or another implementer."]),
		"Use agent_message to message another agent of this plan.",
	].join("\n");
}

async function alive(tx: Tx, build: Build): Promise<boolean> {
	if (build.merged) return false;
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
	#mentions = new Map<string, PendingMention>();
	#mentionEntries = new Map<number, ConversationId[]>();
	#document?: Readonly<BuildsState> | null;
	#pending = new Set<Promise<void>>();
	#closing = false;

	constructor(private readonly harness: Harness, private readonly log: Log, private readonly options: {
		shared(): boolean;
		canInvoke(author: string, shared: boolean): boolean;
		admit: Admission["serialize"];
		submitInput: Channel["submitInput"];
		stop(chat: ConversationId, by: string, at: number, requestId?: string): Promise<void>;
		host?: BuildHost;
	}) {}

	observe(value: Readonly<BuildsState> | null | undefined): string[] {
		const previous = this.#document;
		this.#document = value;
		this.#agents.clear();
		for (const { build, starts } of Object.values(value?.records ?? {})) {
			for (const [index, { chat, role, part }] of build.agents.entries()) {
				const { requestId } = starts[agentKey(role, part)]!.brief!;
				this.#agents.set(chat, { build: build.id, index, requestId, role, part });
			}
		}
		const previousMentions = this.#mentions;
		this.#mentions = new Map();
		if (!value?.mentions) this.#mentionEntries.clear();
		for (const mention of value?.mentions ?? []) {
			if (mention.entry !== undefined) this.#mentionEntries.set(mention.entry, mention.agents);
			if (!("thread" in mention)) continue;
			const key = mentionKey(mention.thread, mention.requestId);
			this.#mentions.set(key, mention);
			if (!previous || previousMentions.has(key)) continue;
			for (const build of new Set(mention.agents.map(chat => this.agent(chat)!.build))) {
				this.log("info", "build.mention.recorded", { build, thread: mention.thread, agents: mention.agents });
			}
		}
		const woken = Object.values(value?.records ?? {})
			.filter(({ build }) => build.state.kind === "started" && previous?.records[build.id]?.build.state.kind === "stopped")
			.map(({ build }) => build.id);
		for (const build of woken) this.log("info", "build.woken", { build });
		return woken;
	}

	agent(chat: number) { return this.#agents.get(chat); }

	pulls(): BuildPull[] {
		return Object.values(this.#document?.records ?? {}).map(({ build, starts, finishedReview }) => ({
			build, ended: Object.values(starts).map(start => start.lastRun ?? 0), finishedReview,
		}));
	}

	async pullText(id: string, branch: string): Promise<string> {
		const build = this.#document?.records[id]?.build;
		if (build?.branch !== branch || build.merged) throw new Error("This plan's branch is no longer open.");
		const plans = (await this.harness.snapshot(PlansDoc, context))?.chats[build.chat];
		return checkedPlanText(build.plan.hash, findPlan(plans, build.plan.id).text);
	}

	async refreshReviews(chats?: readonly number[]) {
		const ids = chats ? new Set(chats.flatMap(chat => this.agent(chat)?.build ?? []))
			: new Set(Object.keys(this.#document?.records ?? {}));
		if (!ids.size) return;
		await this.#track(this.harness.commit(async tx => {
			const { records } = await tx.doc(BuildsDoc);
			for (const id of ids) {
				const record = records[id];
				if (!record) continue;
				const { build, starts } = record;
				build.branch ??= starts[firstImplementer]?.worktree?.branch;
				let latest: { chat: number; card: Extract<ReviewCard, { kind: "review" }> } | undefined;
				let finished: Extract<ReviewCard, { kind: "review" }> | undefined;
				const reviewerHeads = new Set<string>();
				for (const { chat, role } of build.agents) {
					for (const card of Object.values((await tx.doc(ReviewCardsDoc, chat as ConversationId)).cards)) {
						if (card.kind !== "review") continue;
						if (!latest || card.updatedAt > latest.card.updatedAt) latest = { chat, card };
						if (card.phase !== "finished") continue;
						// Review IDs are time-ordered. Old cards can be updated when the branch moves.
						if (!finished || card.review > finished.review) finished = card;
						if (role === "reviewer") reviewerHeads.add(card.range.head);
					}
				}
				const finishedReview = finished && {
					humanRequired: finished.finished?.byReviewLane.humanRequired ?? 0,
					reviewerHeads: [...reviewerHeads].sort(),
				};
				if (JSON.stringify(record.finishedReview) !== JSON.stringify(finishedReview)) {
					if (finishedReview) record.finishedReview = finishedReview;
					else delete record.finishedReview;
				}
				if (!latest) continue;
				const { chat, card } = latest;
				const review: BuildReview = {
					chat, review: card.review, phase: card.phase, head: card.range.head,
					...(card.finished ? { humanRequired: card.finished.byReviewLane.humanRequired } : {}),
					...(card.links ? { desk: card.links.desk } : {}),
				};
				if (JSON.stringify(build.review) !== JSON.stringify(review)) build.review = review;
			}
		}, context));
	}

	async pullMerged(input: { build: string; branch: string; number: number; head: string; at: number }, owner: string) {
		const host = this.options.host;
		if (!host) throw new Error("This channel's work lanes are unavailable.");
		await this.#track(host.share(`neuve.build:${input.build}:merged`, async () => {
			const lanes = await this.harness.commit(async tx => {
				const record = (await tx.doc(BuildsDoc)).records[input.build];
				if (record?.build.branch !== input.branch) throw new Error("This pull request belongs to a different plan branch.");
				const { build } = record;
				if (build.merged && build.merged.number !== input.number) throw new Error("This plan has already merged a different pull request.");
				if (!build.merged) {
					build.merged = { number: input.number, at: input.at };
					record.mergeCleanup = { head: input.head };
				}
				if (record.mergeCleanup?.head !== input.head) return [];
				for (const agent of build.agents) {
					agent.state = "done";
					delete agent.failure;
				}
				return Object.values(record.starts).map(({ lane, worktree, brief }) => ({
					lane, worktree: worktree && { ...worktree }, chat: brief?.chat,
				}));
			}, context);
			for (const { chat } of lanes) {
				if (chat !== undefined) {
					await this.options.admit(chat, async () => {});
					await this.options.stop(chat, owner, input.at);
				}
			}
			for (const { lane, worktree, chat } of lanes) {
				if (!worktree || !await host.removeWorktree?.(lane, worktree, input.head)) continue;
				await this.harness.commit(async tx => {
					const lanes = (await tx.doc(LanesDoc)).lanes;
					if (lanes[lane]?.chat === chat) delete lanes[lane];
				}, context);
			}
			await this.harness.commit(async tx => {
				const record = (await tx.doc(BuildsDoc)).records[input.build];
				if (record?.mergeCleanup?.head === input.head) delete record.mergeCleanup;
			}, context);
		}));
	}

	async finishMergeCleanup(owner: string) {
		for (const { build, mergeCleanup } of Object.values(this.#document?.records ?? {})) {
			if (!build.branch || !build.merged || !mergeCleanup) continue;
			await this.pullMerged({ build: build.id, branch: build.branch, head: mergeCleanup.head, ...build.merged }, owner)
				.catch(error => this.log("warn", "build.merge.cleanup.failed", { build: build.id, ...failure(error) }));
		}
	}

	async findAgent(tx: Tx, from: ConversationId, role: AgentRole, part?: string) {
		const { records } = await tx.doc(BuildsDoc);
		const key = agentKey(role, part);
		const member = this.agent(from);
		const candidates = Object.values(records).filter(({ build }) =>
			!build.merged && (build.state.kind === "started" || build.state.kind === "starting"));
		const local = member ? candidates.filter(({ build }) => build.id === member.build)
			: candidates.filter(({ build }) => build.chat === from);
		const eligible = local.length ? local : member ? [] : candidates;
		const matches = eligible.flatMap(({ starts }) => {
			const start = starts[key];
			return start?.state.kind === "started" && start.brief ? [start.brief.chat] : [];
		});
		const [chat] = matches;
		return chat !== undefined && matches.length === 1 ? { chat } : { refusal: unknownAgent(eligible) };
	}

	isBrief(submission: SubmissionRecord): boolean {
		return submission.type === "input" && submission.requestId !== undefined
			&& submission.requestId === this.agent(submission.conversationId)?.requestId;
	}

	async checkMention(tx: Tx, agents: ConversationId[], problems: string[]): Promise<StoredBuild[]> {
		const { records } = await tx.doc(BuildsDoc);
		const builds = new Map<string, StoredBuild>();
		let foreign = false;
		for (const chat of agents) {
			const agent = this.agent(chat);
			if (!agent) {
				if (!foreign) problems.push("Mention only agents of this channel's plans.");
				foreign = true;
				continue;
			}
			const { build, role, part, requestId } = agent;
			const record = records[build]!;
			builds.set(build, record);
			const name = `The ${role}${part === undefined ? "" : ` for ${JSON.stringify(part)}`}`;
			if (record.build.merged) problems.push(`${name}: The plan has merged.`);
			if (!await tx.submissionByRequest(chat, requestId)) problems.push(`${name}: ${waitForBrief}`);
			// A stopped plan stays stopped when sharing turns on, so a mention must not wake it then either.
			const kind = record.build.state.kind;
			if (kind === "paused") problems.push(`${name}: ${buildRefusal("paused")}`);
			else if (kind === "stopped" && this.options.shared())
				problems.push(`${name}: The plan's agents are stopped, and a mention can't restart them while other people may ask them.`);
		}
		if (problems.length) throw new Error(problems.join(" "));
		return [...builds.values()];
	}

	async recordMention(tx: Tx, mention: Mention, problems: string[]) {
		const builds = await this.checkMention(tx, mention.agents, problems);
		const stopping = builds.filter(record => record.stopping).map(({ build }) => build.id);
		if (stopping.length) throw new MentionStopping(stopping);
		const document = await tx.doc(BuildsDoc);
		document.mentions ??= [];
		const { mentions } = document;
		const index = mentions.findIndex(old => "thread" in old && old.thread === mention.thread && old.requestId === mention.requestId);
		if (index === -1) mentions.push(mention);
		else mentions[index] = mention;
		for (const { build } of builds) {
			if (build.state.kind === "stopped") build.state = { kind: "started" };
		}
	}

	mentionAgents(entry: number) { return this.#mentionEntries.get(entry); }

	postedMention({ conversationId: thread, entry, requestId }: SubmissionRecord) {
		if (this.#closing || entry === undefined || requestId === undefined || this.#mentionEntries.has(entry)) return;
		const mention = this.#mentions.get(mentionKey(thread, requestId));
		if (!mention) return;
		this.#mentionEntries.set(entry, mention.agents);
		void this.#track(Promise.resolve().then(async () => {
			await this.harness.commit(async tx => {
				const stored = (await tx.doc(BuildsDoc)).mentions!.find(old =>
					"thread" in old && old.thread === thread && old.requestId === requestId)!;
				stored.entry = entry;
			}, context);
			await this.#deliverMention(mention);
		}).catch(error => this.log("error", "build.mention.failed", { thread, ...failure(error) })));
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
		const { records } = await tx.doc(BuildsDoc);
		const resumed: string[] = [];
		for (const { build, starts } of Object.values(records)) {
			if (build.merged) continue;
			if (shared && (build.state.kind === "starting" || build.state.kind === "started")) {
				build.state = { kind: "paused", reason: "shared" };
			} else if (!shared && build.state.kind === "paused") {
				build.state = starts[firstImplementer]!.state;
				resumed.push(build.id);
			}
		}
		if (shared || !this.options.host) return resumed;
		for (const record of Object.values(records)) {
			const { build } = record;
			if (!refusedBySharing(build.state)) continue;
			const current = (await tx.doc(PlansDoc)).chats[build.chat]?.findLast(({ plan }) => plan.state === "approved")?.plan;
			if (current?.hash !== build.plan.hash || !current.approved || !this.options.canInvoke(current.approved.by, shared)) continue;
			await this.#admit(tx, records, record);
			resumed.push(build.id);
		}
		return resumed;
	}

	async stop(id: string, by: string) {
		const stopping = await this.harness.commit(async tx => {
			const record = (await tx.doc(BuildsDoc)).records[id];
			if (!record) throw new Error("This plan has no agents to stop.");
			if (record.build.merged || record.build.state.kind === "stopped") return false;
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
			const { build } = record;
			const { by, at } = record.build.state;
			const key = `neuve.build:${build.id}:stop:${at}`;
			const finish = async () => {
				const current = this.#document?.records[build.id];
				if (current?.build.state.kind !== "stopped" || current.build.state.at !== at || !current.stopping) return;
				await Promise.all(current.stopping.map(async ({ chat, running }) => {
					// Drain admission before aborting, without holding it while tools finish.
					await this.options.admit(chat, async () => {});
					await this.options.stop(chat, by, at, running ? `neuve.build:${build.id}:stop:${chat}:${at}` : undefined);
				}));
				await this.harness.commit(async tx => { delete (await tx.doc(BuildsDoc)).records[build.id]!.stopping; }, context);
				this.log("info", "build.stopped", { build: build.id });
			};
			if (this.options.host) await this.options.host.share(key, finish);
			else await finish();
		}
	}

	async updateAgent(tx: Tx, chat: ConversationId, change: Partial<Pick<BuildAgent, "state" | "caption">>) {
		const agent = this.agent(chat);
		if (!agent) return;
		const record = (await tx.doc(BuildsDoc)).records[agent.build];
		if (!record || record.build.merged || (record.stopping && change.state)) return;
		Object.assign(record.build.agents[agent.index]!, change);
	}

	async state(chat: ConversationId, state: BuildAgent["state"], firstInput: SubmissionId | undefined, begin = false) {
		const brief = this.agent(chat);
		if (!brief) return;
		await this.#track(this.harness.commit(async tx => {
			// Steering keeps the run’s first input. A follow-up starts a new run.
			if ((await tx.doc(LiveDoc, chat)).run?.inputs[0] === firstInput) {
				await this.updateAgent(tx, chat, { state });
			}
			if (begin && firstInput !== undefined) {
				const start = (await tx.doc(BuildsDoc)).records[brief.build]?.starts[agentKey(brief.role, brief.part)];
				if (start?.state.kind === "started" && (start.lastRun ?? 0) < firstInput && !start.pendingRuns?.includes(firstInput)) {
					start.pendingRuns = [...(start.pendingRuns ?? []), firstInput];
				}
			}
		}, context).catch(error => this.log("error", "build.agent.state.failed", {
			build: brief.build, chat, state, ...failure(error),
		})));
	}

	async endRun(chat: ConversationId, input: EndedInput, response?: AssistantMessage, deliver = true) {
		const member = this.agent(chat);
		if (!member) return;
		const recordEnd = (async () => {
			const failed = runFailure(input, response);
			const requestIds = await this.harness.commit(async tx => {
				const { records, messages } = await tx.doc(BuildsDoc);
				const record = records[member.build];
				const start = record?.starts[agentKey(member.role, member.part)];
				if (!record || record.build.merged || !start) return;
				const pending = start.pendingRuns;
				const remembered = pending !== undefined && pending.includes(input.id);
				if (remembered) {
					const remaining = pending.filter(id => id !== input.id);
					if (remaining.length) start.pendingRuns = remaining;
					else delete start.pendingRuns;
				}
				const latest = (start.lastRun ?? 0) < input.id;
				if (!latest && !remembered) return;
				const { build } = record;
				const agent = build.agents[member.index]!;
				if (latest) {
					start.lastRun = input.id;
					if (!record.stopping && !(await tx.doc(LiveDoc, chat)).run) {
						agent.state = input.status === "done" ? "done" : failed ? "failed" : "stopped";
					}
					if (input.status === "done") delete agent.failure;
				}
				if (!failed || record.stopping || (start.state.kind !== "started" &&
					!(start.state.kind === "starting" && start.brief?.requestId === input.requestId))) return;
				if (messages.some(row => row.message.build === build.id && row.message.from === chat && row.failure?.turn === failed.turn)) return;
				const { role, part } = member;
				const notice: AgentFailure = { ...failed, role, ...(part === undefined ? {} : { part }) };
				if (latest) agent.failure = notice;
				const name = part === undefined ? role : `${role} for ${JSON.stringify(part)}`;
				const branch = start.worktree?.branch;
				const text = [
					`${failureCaption(notice)}.`,
					`The ${name} was working in lane ${JSON.stringify(start.lane)}${branch ? ` on branch ${JSON.stringify(branch)}` : ""}.`,
					...(notice.reason === "ambiguous-tool-effect" ? ["Check whether the last tool ran before trying it again."] : []),
					"Review the work there and decide what to do next.",
				].join(" ");
				const message = { build: build.id, from: chat, to: build.chat as ConversationId, at: notice.at, text };
				const recipients = new Set([message.to]);
				if (!input.requestId?.startsWith(failurePrefix)) {
					for (const other of Object.values(record.starts)) {
						if (other.state.kind === "started" && other.brief) recipients.add(other.brief.chat);
					}
				}
				recipients.delete(chat);
				return [...recipients].map(to => {
					const requestId = failurePrefix + JSON.stringify([build.id, chat, notice.turn, to]);
					messages.push({ requestId, message: { ...message, to }, failure: notice });
					return requestId;
				});
			}, context);
			if (!requestIds || !failed) return;
			this.log("info", "build.agent.turn.failed", {
				build: member.build, chat, ...failed,
			});
			const host = this.options.host;
			if (!deliver || !host || !requestIds.length) return;
			void this.#track((async () => {
				for (const requestId of requestIds) {
					if (this.#closing) return;
					await host.share(requestId, () => this.#deliverMessage(requestId)).catch(error =>
						this.#messageFailed(requestId, member.build, chat, error));
				}
			})());
		})().catch(error => this.log("error", "build.agent.end.failed", { build: member.build, chat, ...failure(error) }));
		await this.#track(recordEnd);
	}

	async reconcileRuns(): Promise<void> {
		for (const { starts } of Object.values(this.#document?.records ?? {})) {
			for (const { pendingRuns, brief, state, lastRun } of Object.values(starts)) {
				if (!brief) continue;
				if (state.kind === "starting" && lastRun === undefined) {
					const input = await this.harness.commit(tx => tx.submissionByRequest(brief.chat, brief.requestId), context);
					if (endedInput(input)) await this.endRun(brief.chat, input, await this.#failedResponse(brief.chat, input), false);
				}
				for (const run of pendingRuns ?? []) {
					const input = await (await this.harness.submission(run, context))?.status(context);
					if (!endedInput(input)) continue;
					await this.endRun(brief.chat, input, await this.#failedResponse(brief.chat, input), false);
				}
			}
		}
	}

	async #failedResponse(chat: ConversationId, input: EndedInput): Promise<AssistantMessage | undefined> {
		if (input.status !== "unanswered" || input.reason !== "model_error" || input.entry === undefined) return;
		return this.harness.commit(async tx => {
			let cursor;
			const seen = new Set<TaskId>();
			let response: AssistantMessage | undefined;
			do {
				const page = await tx.scanEntries({ conversationId: chat, minEntryId: input.entry }, 64, cursor);
				for (const entry of page.items) {
					if (entry.byTaskId === undefined || seen.has(entry.byTaskId)) continue;
					seen.add(entry.byTaskId);
					const message = entry.model?.[0];
					if (message?.role !== "assistant" || message.errorMessage !== input.detail) continue;
					const task = await tx.task(entry.byTaskId);
					if (task?.state.outcome?.status === "failed") response = message;
				}
				cursor = page.next;
			} while (cursor);
			return response;
		}, context);
	}

	async approve(tx: Tx, chat: ConversationId, hash: string, fresh?: { stored: StoredPlan; approved: Build["approved"] }) {
		const id = buildId(chat, hash);
		if (!fresh && !this.#document?.records[id]) return;
		const { records } = await tx.doc(BuildsDoc);
		const refusal = !this.options.host ? "hosted" : this.options.shared() ? "shared" : undefined;
		let record = records[id];
		if (record) {
			const { state } = record.build;
			if (refusal || (state.kind !== "failed" && !refusedBySharing(state))) return;
		} else {
			if (!fresh) return;
			const { stored: { plan }, approved } = fresh;
			const reused = Object.values(records).some(({ build }) => build.plan.id === plan.id && build.merged);
			record = { starts: { [firstImplementer]: await firstStart(tx, chat, reused ? `${plan.id}-${hash}` : plan.id) }, build: {
				id, chat, approved, agents: [],
				state: refusal ? { kind: "unavailable", reason: refusal } : { kind: "starting" },
				plan: { id: plan.id, hash, title: plan.title, call: plan.call },
			} };
		}
		if (!refusal) await this.#admit(tx, records, record);
		records[id] ??= record;
		return record.build.state.kind;
	}

	async #admit(tx: Tx, records: BuildsState["records"], record: StoredBuild) {
		const { build, starts } = record;
		for (const { build: prior } of Object.values(records).reverse()) {
			if (prior.chat !== build.chat || prior.id === build.id || !await alive(tx, prior)) continue;
			build.state = { kind: "delivered", to: prior.id };
			record.revision = { requests: {} };
			return;
		}
		starts[firstImplementer] ??= await firstStart(tx, build.chat as ConversationId, build.plan.id);
		starts[firstImplementer]!.state = { kind: "starting" };
		build.state = { kind: "starting" };
	}

	get pending(): boolean { return this.#pending.size > 0; }

	async readScope(
		{ question, scope = [] }: Static<typeof ScopeParameters>,
		api: ToolExecutionApi,
		context: Context,
	): Promise<ToolExecutionResult> {
		const host = this.options.host!;
		const query = host.query!;
		const chat = api.conversationId;
		const member = this.agent(chat)!;
		const result = await host.share(`neuve.query:${chat}:${api.callId}`, async () => {
			const memo = await api.memo<ScopeReadAnswer>("neuve-query-result", context);
			if (memo) return memo;
			const { build, starts } = (await api.snapshot(BuildsDoc, context))!.records[member.build]!;
			if (build.state.kind === "stopped") {
				return { text: "The plan's agents were stopped, so there is nothing for you to read or fix.", isError: true } satisfies ScopeReadAnswer;
			}
			const start = starts[agentKey(member.role, member.part)]!;
			const { path, base } = start.worktree!;
			const plans = (await api.snapshot(PlansDoc, context))?.chats[build.chat];
			const plan = await approvedPlan(plans);
			const value = await query.read({
				repository: path, revision: base, question, scope, plan,
				previousPlans: plans!.flatMap(({ file, plan }) =>
					plan.state === "replaced" ? [{ file, title: plan.title, hash: plan.hash }] : []),
				...(start.role === "reviewer" ? { branch: start.source.branch } : {}),
				requester: { _tag: "Agent", harness: "neuve-pi", sessionId: query.sessionId, subagentId: String(chat) },
			});
			return api.memo("neuve-query-result", value, context);
		});
		return result.isError ? refuse(result.text) : answer(result.text);
	}

	async startAgent(
		{ role, part, brief }: Static<typeof StartParameters>,
		api: ToolExecutionApi,
		context: Context,
	): Promise<ToolExecutionResult> {
		let request: AgentStartArgs;
		if (role === "reviewer") {
			if (brief !== undefined) return refuse("The host writes the reviewer's brief.");
			if (part !== undefined && !part.trim()) return refuse("Give the reviewer a path scope or leave it out.");
			request = { role, part };
		} else {
			if (!part?.trim()) return refuse("Give the implementer a path scope.");
			if (!brief?.trim()) return refuse("Give the implementer a brief.");
			request = { role, part, brief };
		}
		const key = agentKey(role, part);
		const reserved = await api.commit(async tx => {
			const { records } = await tx.doc(BuildsDoc);
			const caller = this.agent(api.conversationId);
			const record = caller && records[caller.build];
			if (!record) return { refusal: "Only an agent of a plan can ask the host to start another agent." };
			const { build, starts } = record;
			if (build.merged) return { refusal: "The plan has merged." };
			const existing = starts[key];
			if (build.state.kind === "paused" && existing?.state.kind === "starting") return { pending: true as const };
			const blocked = buildRefusal(build.state.kind);
			if (blocked) return { refusal: blocked };
			if (build.state.kind === "failed") return { refusal: "The host couldn't finish starting the plan's implementer." };
			if (existing) {
				if ("task" in existing && existing.task === api.taskId) return { id: build.id };
				if (existing.state.kind === "started") {
					return { refusal: "This plan already has an agent with that role and path scope." };
				}
				if (existing.state.kind === "failed") {
					existing.state = { kind: "starting" };
					if ("task" in existing) existing.task = api.taskId;
				}
				return { id: build.id };
			}
			const start = {
				by: api.conversationId, task: api.taskId, lane: `build-${crypto.randomUUID()}`,
				state: { kind: "starting" as const },
			};
			if (request.role === "reviewer") {
				const implementer = starts[agentKey("implementer", caller.role === "implementer" ? caller.part : undefined)]!;
				const { branch, base } = implementer.worktree!;
				const settings = await tx.doc(AgentDoc, implementer.brief!.chat);
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
		if (reserved.pending) return answer(pendingStart);
		const { id } = reserved;
		const host = this.options.host!;
		if (reserved.fresh) this.log("info", "build.agent.recorded", { build: id, role, part });
		await this.#track(this.#runStart(id, host, key));
		const { build, starts } = (await api.snapshot(BuildsDoc, context))!.records[id]!;
		const { state } = starts[key]!;
		if (state.kind === "failed") return refuse(state.detail);
		if (state.kind === "starting") return build.state.kind === "stopped" ? refuse(stopped) : answer(pendingStart);
		return answer(part === undefined ? `The ${role} started.` : `The ${role} for ${part} started.`);
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
			const plans = sender ? undefined : (await tx.doc(PlansDoc)).chats[from];
			const latest = (plans?.findLast(({ plan }) => plan.state === "approved") ?? plans?.at(-1))?.plan;
			let record = sender ? records[sender.build] : latest && records[buildId(from, latest.hash)];
			// Approved revisions reuse the preceding build's agents, as recorded at approval.
			if (!sender && record?.build.state.kind === "delivered") record = records[record.build.state.to];
			if (!record && (sender || !latest)) return { refusal: "Only the chat that drafted a plan, or one of its agents, can message that plan's agents." };
			const blocked = record && buildRefusal(record.build.state.kind);
			if (blocked) return { refusal: blocked };
			const recipient = record?.starts[agentKey(to, part)];
			if (!record || recipient?.state.kind !== "started" || !recipient.brief) {
				return { refusal: unknownAgent(record ? [record] : []) };
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
			const { messages, records } = (await api.snapshot(BuildsDoc, context))!;
			if (messages.find(message => message.requestId === requestId)?.submission === undefined) {
				if (records[build]?.build.state.kind === "stopped") return refuse(stopped);
				return answer("The message is recorded and will be delivered when work resumes.");
			}
		}
		return answer("The message was sent.");
	}

	async #track(task: Promise<void>): Promise<void> {
		this.#pending.add(task);
		try { await task; }
		finally { this.#pending.delete(task); }
	}

	async recoverMentionEntries(): Promise<void> {
		if (!this.#mentions.size) return;
		await this.harness.commit(async tx => {
			const { mentions = [] } = await tx.doc(BuildsDoc);
			for (let index = mentions.length - 1; index >= 0; index--) {
				const mention = mentions[index]!;
				if (!("thread" in mention)) continue;
				if (mention.entry === undefined) {
					const submission = await tx.submissionByRequest(mention.thread, mention.requestId);
					if (submission?.entry !== undefined) mention.entry = submission.entry;
					else if (submission?.status !== "queued") {
						mentions.splice(index, 1);
						continue;
					}
				}
				compactMention(mentions, index, mention);
			}
		}, context);
	}

	async resume(ids?: readonly string[]): Promise<void> {
		const host = this.options.host;
		if (!host || this.#closing) return;
		const task = (async () => {
			const { records, messages, mentions } = (await this.harness.snapshot(BuildsDoc, context)) ?? { records: {}, messages: [] };
			await Promise.all((mentions ?? []).map(mention =>
				"thread" in mention && mention.entry !== undefined && this.#deliverMention(mention, ids)));
			if (!ids) await this.replyToMentions();
			for (const { requestId, message, submission } of messages) {
				if (this.#closing) return;
				if (!requestId.startsWith(messagePrefix) || submission !== undefined || (ids && !ids.includes(message.build))) continue;
				await this.#resumePending(host, message.build, requestId, () => this.#deliverMessage(requestId),
					() => this.#document?.messages.find(message => message.requestId === requestId)?.submission === undefined,
				).catch(error =>
					this.#messageFailed(requestId, message.build, message.to, error, "build.message.resume.failed"));
			}
			const selected = ids ? ids.flatMap(id => records[id] ? [records[id]] : []) : Object.values(records);
			await Promise.all(selected.map(async ({ build, revision, starts }) => {
				try {
					if (this.#closing) return;
					if (build.state.kind === "delivered" && revision) {
						await this.#deliver(build.state.to, host);
					}
					await Promise.all(Object.entries(starts).filter(([, start]) => start.state.kind === "starting")
						.map(([key]) => this.#runStart(build.id, host, key)));
					await this.#deliver(build.id, host);
				} catch (error) {
					this.log("error", "build.resume.failed", { build: build.id, ...failure(error) });
				}
			}));
		})().catch(error => this.log("error", "build.resume.failed", failure(error)));
		await this.#track(task);
	}

	#runStart(id: string, host: BuildHost, key: string) {
		return this.#resumePending(host, id, `${id}:${key}`, () => this.#start(id, host, key),
			() => this.#document?.records[id]?.starts[key]?.state.kind === "starting");
	}

	async #resumePending(host: BuildHost, id: string, key: string, run: () => Promise<void>, pending: () => boolean) {
		await host.share(key, run);
		// A caller can join an attempt that already yielded to a pause.
		if (this.#canSend(id) && pending()) await host.share(key, run);
	}

	async close(): Promise<void> {
		this.#closing = true;
		await Promise.allSettled(this.#pending);
	}

	#canSend(build: string) {
		const record = this.#document?.records[build]?.build;
		return !this.#closing && !record?.merged && (record?.state.kind === "starting" || record?.state.kind === "started");
	}

	async #send(build: string, chat: ConversationId, draft: Omit<InputSubmissionDraft, "content"> & {
		requestId: string;
		content: InputSubmissionDraft["content"] | (() => Promise<string>);
	}) {
		const existing = await this.harness.commit(tx => tx.submissionByRequest(chat, draft.requestId), context);
		if (existing) return existing.id;
		if (!this.#canSend(build)) return;
		const conversation = await this.harness.conversation(chat, context);
		if (!conversation) throw new Error("The agent's chat could not be found.");
		const input = typeof draft.content === "function" ? await draft.content() : draft.content;
		const submission = await this.options.submitInput(conversation, { ...draft, content: input }, context, () => this.#canSend(build));
		return submission?.id;
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
			const message = (await tx.doc(BuildsDoc)).messages.find(message => message.requestId === requestId)!;
			message.submission = submission;
			delete message.deliveryFailed;
		}, context);
		this.log("info", "build.message.delivered", { build, chat: to, submission });
	}

	async #messageFailed(requestId: string, build: string, chat: number, error: unknown, event = "build.message.failed") {
		this.log("error", event, { build, chat, requestId, ...failure(error) });
		if (!requestId.startsWith(failurePrefix)) return;
		await this.harness.commit(async tx => {
			const message = (await tx.doc(BuildsDoc)).messages.find(message => message.requestId === requestId);
			if (message && message.submission === undefined) message.deliveryFailed = true;
		}, context).catch(error => this.log("error", "build.message.receipt.failed", { build, chat, requestId, ...failure(error) }));
	}

	async #deliverMention(mention: PendingMention, ids?: readonly string[]): Promise<void> {
		const { thread, author, text } = mention;
		if (author === undefined || text === undefined) return;
		const key = mentionKey(thread, mention.requestId);
		const host = this.options.host!;
		await Promise.all(mention.agents.map(async chat => {
			const { build } = this.agent(chat)!;
			if (mention.deliveries?.[chat] !== undefined || (ids && !ids.includes(build))) return;
			const requestId = mentionDeliveryId(mention, chat);
			const pending = () => {
				const saved = this.#mentions.get(key);
				return saved !== undefined && saved.deliveries?.[chat] === undefined;
			};
			try {
				await this.#resumePending(host, build, requestId, async () => {
					if (!pending()) return;
					const submission = await this.#send(build, chat, {
						type: "input", whenBusy: "steer", requestId, content: content(author, text),
					});
					if (submission === undefined) return;
					await this.harness.commit(async tx => {
						const { mentions = [] } = await tx.doc(BuildsDoc);
						const index = mentions.findIndex(old =>
							"thread" in old && old.thread === thread && old.requestId === mention.requestId);
						const saved = mentions[index];
						if (!saved || !("thread" in saved)) return;
						saved.deliveries ??= {};
						saved.deliveries[chat] ??= submission;
						compactMention(mentions, index, saved);
					}, context);
					this.log("info", "build.mention.delivered", { build, chat, submission });
				}, pending);
			} catch (error) {
				this.log("error", "build.mention.failed", { build, chat, thread, ...failure(error) });
			}
		}));
	}

	async replyToMentions(): Promise<void> {
		const host = this.options.host;
		if (!host || this.#closing || !this.#mentions.size) return;
		await this.#track(Promise.resolve().then(async () => {
			const replies = await this.harness.commit(async tx => {
				const { mentions = [] } = await tx.doc(BuildsDoc);
				const replies = new Map<string, MentionReply>();
				for (const [index, mention] of mentions.entries()) {
					if (!("thread" in mention) || mention.entry === undefined) continue;
					const { thread } = mention;
					for (const chat of mention.agents) {
						if (mention.deliveries?.[chat] === "settled") continue;
						const requestId = mentionDeliveryId(mention, chat);
						const submission = await tx.submissionByRequest(chat, requestId);
						if (submission?.status === "unanswered") {
							mention.deliveries ??= {};
							mention.deliveries[chat] = "settled";
						}
						if (submission?.type !== "input" || submission.status !== "done") continue;
						const { answer, id } = submission;
						const key = `${thread}:${answer}`;
						const reply = replies.get(key) ?? { thread, chat, answer, inputs: [] };
						reply.inputs.push({ id, requestId, mention: mention.requestId });
						replies.set(key, reply);
					}
					compactMention(mentions, index, mention);
				}
				return [...replies.values()];
			}, context);
			await Promise.all(replies.map(reply => this.#postMentionReply(host, reply)));
		}).catch(error => this.log("error", "build.mention.reply.failed", failure(error))));
	}

	async #postMentionReply(host: BuildHost, { thread, chat, answer, inputs }: MentionReply) {
		const first = inputs.reduce((first, input) => input.id < first.id ? input : first);
		const requestId = `neuve.build:reply:${first.requestId}`;
		const build = this.agent(chat)!.build;
		try {
			await host.share(requestId, async () => {
				if (!inputs.some(input => {
					const mention = this.#mentions.get(mentionKey(thread, input.mention));
					return mention && mention.deliveries?.[chat] !== "settled";
				})) return;
				const message = (await this.harness.commit(tx => tx.entry(answer), context))?.model?.[0];
				const text = message?.role === "assistant" && messageText(message);
				if (message && text) {
					const conversation = await this.harness.conversation(thread, context);
					if (!conversation) throw new Error("The mentioning thread could not be found.");
					const reply = await conversation.submit({
						type: "write", entry: draft(`agent@${chat}`, text, message.timestamp), requestId,
					}, context);
					if ((await reply.status(context)).status !== "done") return;
				}
				const sent = new Set(inputs.map(input => input.mention));
				await this.harness.commit(async tx => {
					const { mentions = [] } = await tx.doc(BuildsDoc);
					for (const [index, mention] of mentions.entries()) {
						if (!("thread" in mention) || mention.thread !== thread || !sent.has(mention.requestId)) continue;
						mention.deliveries ??= {};
						mention.deliveries[chat] = "settled";
						compactMention(mentions, index, mention);
					}
				}, context);
				if (text) this.log("info", "build.mention.replied", { build, chat, thread });
			});
		} catch (error) {
			this.log("error", "build.mention.reply.failed", { build, chat, thread, ...failure(error) });
		}
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
				const source = role === "reviewer" ? start.source : first ? "origin" : undefined;
				worktree = await host.worktree(lane, source);
				const created = worktree;
				await update((saved, build) => {
					saved.worktree = created;
					if (first) build.branch = created.branch;
				});
				log("build.worktree", { path: worktree.path, branch: worktree.branch });
			}
			detail = `The ${role}'s chat could not be created.`;
			const { path, base } = worktree;
			let brief = start.brief;
			if (!brief) {
				brief = await update(async (saved, build, tx) => {
					if (!this.#canSend(id)) return;
					const { id: chat } = await tx.createConversation({ ownership: { kind: "ownerless" } });
					await configure(tx, chat, {
						model: start.model, thinkingLevel: start.effort, cwd: path,
						...(host.query ? { extensions: { add: [scopeReadExtension] } } : {}),
					});
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
			detail = `The ${role}'s brief could not be sent.`;
			const submission = await this.#send(id, brief.chat, {
				type: "input", whenBusy: "followUp", requestId: brief.requestId,
				content: async () => briefText(
					await approvedPlan((await this.harness.snapshot(PlansDoc, context))?.chats[record.build.chat]),
					worktree, start, host.query !== undefined,
				),
			});
			if (submission === undefined) return;
			log("build.brief", { chat: brief.chat, submission });
			detail = `The ${role}'s start could not be recorded.`;
			await update((saved, build) => {
				saved.state = { kind: "started" };
				if (saved.lastRun === undefined && !saved.pendingRuns?.includes(submission)) {
					saved.pendingRuns = [...(saved.pendingRuns ?? []), submission];
				}
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
				await this.#resumePending(host, to, build.id, () => this.#deliverRevision(build, target),
					() => this.#document?.records[build.id]?.revision !== undefined);
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
		const checked = await checkedPlanText(build.plan.hash, text);
		for (const { chat, requestId } of recipients) {
			const submission = await this.#send(target.build.id, chat, {
				type: "input", whenBusy: "steer", requestId,
				content: content(build.approved.by, checked),
			});
			if (submission === undefined) return;
			this.log("info", "build.revision.submitted", { build: build.id, chat, submission });
		}
		await this.harness.commit(async tx => {
			delete (await tx.doc(BuildsDoc)).records[build.id]!.revision;
		}, context);
	}
}
