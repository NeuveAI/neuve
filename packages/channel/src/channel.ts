import { ReviewCardsDoc } from "./review-cards";
import { type ApprovalAdmission, ApprovalRequestsDoc, Approvals, requirePerson, watchApprovals } from "./approvals";
import type { Context } from "@earendil-works/chord";
import { type Admission, type ChannelExtension, install, observe, price } from "./extensions";
import { admitted, claim, digest } from "./requests";
import {
	type AssistantMessage,
	getSupportedThinkingLevels,
	isContextOverflow,
	type Model,
	type Models,
} from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT as context, withCancel } from "@earendil-works/chord/context";
import {
	AgentDoc,
	type AgentChange,
	type AgentEvent,
	type CommitChange,
	configure,
	type Conversation,
	type ConversationHandle,
	type ConversationId,
	type ConversationRecord,
	type DocumentWatch,
	createRegistry,
	type Cursor,
	defineDoc,
	defineEntry,
	defineExtension,
	type EntryId,
	type EntryRecord,
	GenerationTask,
	Harness,
	InboxDoc,
	type InboxState,
	type InputSubmissionDraft,
	LiveDoc,
	type LiveState,
	ROOT_CONVERSATION_ID,
	type Storage,
	type Submission,
	type SubmissionId,
	type SubmissionRecord,
	type Tx,
	ToolResultEntry,
	UsageDoc,
	type UsageState,
	watchEvents,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { CodingTools } from "@earendil-works/pi-durable/tools";

import { type Directory, messaging, subagent } from "./agents";
import { type Browser, browser } from "./browser";
import { Builds, BuildsDoc, buildTools, isMentionSubmission, isWorkMessageSubmission, MentionStopping, waitForBrief, workLog, type BuildHost, type BuildsState, type Mention } from "./build";
import {
	caption,
	CaptionsDoc,
	FAST,
	isStale,
	pick,
	recap,
	segments,
	spend,
	STRONG,
} from "./captions";
import { instructions } from "./context";
import { changes, fetchBase, patch } from "./changes";
import { type Desktop, desktop } from "./desktop";
import { HANDOFF, Handoffs } from "./handoffs";
import { type Images, images } from "./images";
import { lanes, LanesDoc } from "./lanes";
import { failure, type Log, logging, scoped } from "./log";
import {
	DeletionEntry,
	edit,
	EditEntry,
	type Messages,
	MessagesDoc,
	react,
	remove,
} from "./messages";
import { metadata, MetadataDoc, validateName } from "./metadata";
import { available, choose, resolveStoredModel, usable } from "./models";
import { Plans, PlansDoc, type PlanCommentReceipt, type PlanFiles, type PlansState } from "./plan";
import {
	changePlanComment, discardPlanCommentBatch, keepPlanComment, KEPT_PLAN_REPLIES_REASON, planCommentAnswers, planCommentBatch,
	planComments, PlanCommentPlacements, preparePlanCommentSend, recoverPlanCommentSends, stagePlanCommentBatch, updatePlanCommentDelivery,
} from "./plan-comments";
import { ChatModesDoc, isPlanning, type IsPlanning, planModeExtension, planModeModels, setChatMode } from "./plan-mode";
import { progress } from "./progress";
import { answer, PersonWaits, Questions } from "./questions";
import type {
	ApprovalRequestsState,
	BuildNotice,
	ChannelInfo,
	Chat,
	ChatId,
	ChatMode,
	Effort,
	Event,
	Metadata,
	ModelOption,
	ModelRef,
	Request,
	RunEnd,
	ReviewCard,
	ReviewNewCommits,
	ReviewNotice,
	QueuedMessage,
	Said,
	Usage,
} from "./protocol";
import { buildId, MENTION, reservedBuildRequestId, reservedReviewRequestId, ReviewFeedDefinition } from "./protocol";
import { queue, withdrawn } from "./queue";
import * as room from "./room";
import { exportSeed, importSeed, type Seed } from "./seed";
import { type Tabs, tabs } from "./tabs";

const ReviewNewCommitsEntry = defineEntry<ReviewNewCommits & { at: number }>("neuve:review:new-commits");
const ReviewFeedDoc = defineDoc(ReviewFeedDefinition);

declare const crypto: { randomUUID(): string };

type Settings = { shared: boolean; desktop: boolean };

const SettingsDoc = defineDoc<Settings>({
	kind: "ace.settings",
	version: 2,
	scope: "session",
	initial: () => ({ shared: false, desktop: false }),
	migrate: (value) => ({ shared: value.shared as boolean, desktop: true }),
});

/** Channels created before new channels started unshared store no settings and stay shared. */
const LEGACY: Settings = { shared: true, desktop: true };

/** Inactivity is measured in hours, so activity is published at most this often. */
const ACTIVITY_INTERVAL = 5 * 60_000;

export type Options = {
	id: string;
	name: string;
	/** Existing and explicitly named channels keep their name until a requested rename. */
	named?: boolean;
	/** Immutable Git branch prefix, seeded from the channel's initial name. */
	prefix?: string;
	owner: string;
	/** Paths inside the execution environment's file system. */
	project: string;
	model?: ModelRef;
	/**
	 * The lane a forked channel's root chat starts in, recorded only in the commit that creates the
	 * root chat, so reopening never moves a chat that has since switched lanes.
	 */
	lane?: { name: string; path: string; base: string };
	/**
	 * For a copy restored into another project: every chat moves to the project checkout and the
	 * original's lanes, which are worktrees of the original project, are forgotten before work resumes.
	 */
	relocate?: boolean;
	/** The host's current preference, consulted only for a chat's first agent invocation. */
	defaultModel?(): Promise<ModelRef>;
	routeModel?: Omit<ModelOption, "efforts"> | undefined;
	/** Administrative opens leave durable work for the configured worker. Defaults to true. */
	resume?: boolean;
	storage: Storage;
	models: Models;
	env(cwd: string): ExecutionEnv;
	/** Wrap shared file access for one chat. Check its mode when the file is opened. */
	planFileAccess?(env: ExecutionEnv, isPlanning: (context: Context) => Promise<boolean>): ExecutionEnv;
	/** The channel's Markdown files, in storage the host owns outside the project. */
	planFiles?: PlanFiles;
	build?: BuildHost;
	desktop?: Desktop;
	browser?: Browser;
	images?: Images;
	tabs?: Tabs;
	directory: Directory;
	/**
	 * Reserve a new name among the runtime's channels: `exact` refuses a taken name, otherwise the
	 * name actually reserved comes back numbered. Hosted channels cannot see other channels yet.
	 */
	claim?(name: string, exact: boolean): Promise<string>;
	/** Publish a projection of committed metadata to the runtime's channel catalog. */
	onMetadata?(value: Metadata): void;
	/** Publish when the transcript last grew, in epoch milliseconds. */
	onActivity?(at: number): void;
	/** Rebuildable channel-wide projection of pi live runs, including child chats. */
	onBusy?(busy: boolean): void;
	/** Publish each run a person invoked as it ends, for their attention. */
	onRun?(run: RunEnd): void;
	/** Publish each message people and other channels' agents write, for teammates' attention. */
	onSaid?(said: Said): void;
	log: Log;
	extension?: Omit<ChannelExtension, "attach"> & {
		attach?(harness: Harness, admission: Admission & ApprovalAdmission): void | Promise<void>;
	};
	/** Host-owned document producers join before native storage closes. */
	feed?(harness: Harness, submitInput: Channel["submitInput"]): Promise<{ close(): Promise<void>; pending(): boolean }>;
};

type Send = (event: Event) => void;
type PlanDelivery = {
	chat: ConversationId;
	requestId: string;
	record: SubmissionRecord;
	pickedUp: boolean;
	runError?: string;
};
/** `reacted` once a reactions event, which carries the chat's whole state, has been sent. */
type Listener = {
	chat: ChatId;
	send: Send;
	captions: boolean;
	actions: boolean;
	typing: boolean;
	agent: boolean;
	reacted?: boolean;
};

export class Channel {
	#options: Options;
	#harness: Harness;
	#log: Log;
	#metadata: Metadata;
	#plans: Plans;
	#builds: Builds;
	#planState?: Readonly<PlansState>;
	#planPlacements = new Map<ConversationId, PlanCommentPlacements>();
	#pendingPlanDeliveries: PlanDelivery[][] = [];
	#planDeliveries?: Promise<void>;
	#approvals: Approvals;
	/** Committed settings, maintained from pi's commit stream before native dispatch. */
	#settings: Settings;
	#active = 0;
	/** Each live run's inputs, from pi's `LiveDoc`. */
	#runs = new Map<ConversationId, readonly SubmissionId[]>();
	#publishedBusy?: boolean;
	#unsubscribe?: () => void;
	#unbind?: () => void;
	#closed?: Promise<void>;
	#feed?: { close(): Promise<void>; pending(): boolean };
	#captionTasks = new Set<Promise<void>>();
	#admissions = new Map<ChatId, Promise<unknown>>();
	#changingModes = new Map<ChatId, Promise<unknown>>();
	#listeners = new Set<Listener>();
	/** Chats with a captioning pass in progress; `true` when another pass must follow it. */
	#captioning = new Map<ConversationId, boolean>();
	#closing = new AbortController();

	private constructor(
		options: Options,
		harness: Harness,
		log: Log,
		value: Metadata,
		settings: Settings,
		plans: Plans,
		approvals: Approvals,
	) {
		this.#options = options;
		this.#harness = harness;
		this.#log = log;
		this.#metadata = value;
		this.#settings = settings;
		this.#plans = plans;
		this.#builds = new Builds(harness, log, {
			shared: () => this.#settings.shared,
			canInvoke: (author, shared) => this.#canInvoke(author, shared),
			admit: (chat, action) => this.#admitted(chat, action),
			submitInput: this.submitInput.bind(this),
			stop: async (chat, by, at, requestId) =>
				this.#stopChat(await this.#conversation(chat), requestId ? { by, at, requestId } : undefined, true),
			host: options.build,
		});
		this.#approvals = approvals;
	}

	static async open(options: Options): Promise<Channel> {
		let ownedHarness: Harness | undefined;
		let ownedChannel: Channel | undefined;
		let unbind: (() => void) | undefined;
		try {
		const log = scoped(options.log, { channel: options.id });
		let channel: Channel;
		const planning: IsPlanning = async (chat, context) =>
			isPlanning(channel.#harness, chat, context, id => channel.#changingModes.get(id));
		const registry = createRegistry();
		registry.install(logging(log));
		registry.install(CodingTools);
		const handoffs = new Handoffs(options.directory);
		registry.install(handoffs.extension);
		const waits = new PersonWaits((chat, phase) => { void Promise.resolve().then(() => channel.#asked(chat, phase)); });
		const questions = new Questions(waits);
		const approvals = new Approvals(waits, error => log("warn", "approval.dismiss.failed", failure(error)),
			(chat, work) => channel.#admitted(chat, work));
		registry.install(questions.extension);
		const execute = options.desktop;
		if (execute) {
			registry.install(desktop(async (request, context) => {
				// Check every dispatch, including child chats and calls from already-active runs.
				if (!channel.#settings.desktop) {
					return {
						text:
							"Native desktop tools are off for this channel, and no desktop operation was dispatched. If the task needs them, ask the channel owner to turn on Channel desktop tools in the channel header, then wait for their reply instead of working around it.",
						isError: true,
						outcome: "refused",
					};
				}
				return execute(request, context);
			}));
		}
		if (options.browser) registry.install(browser(options.browser));
		if (options.images) registry.install(images(options.images));
		if (options.tabs) registry.install(tabs(options.tabs));
		registry.install(lanes({ ...options, name: options.prefix || options.name }));
		registry.install(subagent((handle, input, scope) => channel.submitInput(handle, input, scope), questions.extension));
		registry.install(metadata((value) => channel.#changed(value), options.claim));
		registry.install(messaging(options.directory));
		registry.install(
			defineExtension({ name: "ace-channel", sections: [
				room.section(options, chat => channel.#builds.agent(chat)?.role), instructions,
			] }),
		);
		registry.install(approvals.extension);
		registry.install(planModeExtension(planning));
		const plans = new Plans(options.planFiles);
		const plan = plans.extension(planning, (chat, work) => channel.#admitted(chat, work), log);
		if (plan) registry.install(plan);
		registry.install(planCommentAnswers(planning));
		const { agents, query, clearInheritedQuery } = buildTools(() => channel.#builds);
		registry.install(agents);
		if (options.build?.query) registry.install(query);
		install(registry, options.extension, planning, !!options.planFileAccess, log, (chat, scope) => channel.#builds.paused(chat, scope));
		const harness = await Harness.open(options.storage, {
			models: planModeModels(options.models, provider => approvals.receivesAttendance(provider)),
			registry,
			settings: { get extensions() { return registry.snapshot().installed().filter(extension => extension.name !== query.name); } },
			conversationCreated: clearInheritedQuery,
			env: async ({ cwd, conversationId }, context) => {
				const folder = cwd || options.project;
				const { planFileAccess } = options;
				const chatPlanning = (context: Context) => planning(conversationId, context);
				if (options.extension?.environment?.(folder) === false) {
					if (!planFileAccess || !await chatPlanning(context).catch(() => false)) return;
					// An environment granted by plan mode stays confined for its lifetime.
					return planFileAccess(options.env(folder), async () => true);
				}
				const env = options.env(folder);
				return planFileAccess?.(env, chatPlanning) ?? env;
			},
			onReport: (error) => log("error", "harness.report", failure(error)),
		}, context);
		ownedHarness = harness;
		unbind = await observe(harness, options.extension);
		// Only a new channel stores its settings at creation; an existing one without them is legacy.
		if (!await harness.conversation(ROOT_CONVERSATION_ID, context)) {
			await harness.commit(async (tx) => void await tx.doc(SettingsDoc), context);
		}
		const { lane } = options;
		await harness.root(context, {
			agent: { model: options.model, cwd: lane?.path || options.project, ...(options.extension?.thinkingLevel ? {thinkingLevel: options.extension.thinkingLevel} : {}) },
			...(lane
				? {
					init: async (tx, chat) => {
						(await tx.doc(LanesDoc)).lanes[lane.name] = { chat, path: lane.path, base: lane.base };
					},
				}
				: {}),
		});
		const value = await harness.commit(async (tx) => {
			await tx.doc(ChatModesDoc);
			const doc = await tx.doc(MetadataDoc);
			// A missing document is the version 0 upgrade; existing pi metadata always wins.
			if (!doc.name) {
				doc.name = options.name;
				doc.named = options.named ?? true;
			}
			return { name: doc.name, summary: doc.summary, revision: doc.revision };
		}, context);
		const settings = await harness.snapshot(SettingsDoc, context);
		channel = new Channel(
			options,
			harness,
			log,
			value,
			settings || LEGACY,
			plans,
			approvals,
		);
		ownedChannel = channel;
		channel.#unbind = unbind;
		channel.#changed(value);
		// Scheduling has not resumed and no caller has this channel yet, so the initial snapshot
		// and subscription cannot miss a run transition. LiveDoc forks start empty in pi.
		channel.#planState = await recoverPlanCommentSends(harness, await harness.snapshot(PlansDoc, context), context);
		channel.#builds.observe(await harness.snapshot(BuildsDoc, context));
		await channel.#restoreRunsAndHandoffs(handoffs);
		channel.#unsubscribe = harness.subscribeCommits(({ changes }) => {
			const commentMessages = channel.#observePlanCommentSends(changes);
			const unannouncedEntries = new Set<EntryId>();
			for (const change of changes) {
				if (change.type !== "submission") continue;
				const submission = change.value;
				const workMessage = isWorkMessageSubmission(submission);
				const mention = isMentionSubmission(submission);
				if (workMessage) handoffs.buildSteer(submission);
				if (submission.entry !== undefined && (workMessage || mention || channel.#builds.isBrief(submission))) {
					unannouncedEntries.add(submission.entry);
				}
				channel.#builds.postedMention(submission);
			}
			const ended: [ConversationId, readonly SubmissionId[]][] = [];
			let runEnded = false;
			for (const change of changes) {
				if (change.type === "entry" && change.value.model?.[0]?.role === "assistant") {
					channel.#caption(change.value.conversationId);
				}
				if (change.type === "entry" && !unannouncedEntries.has(change.value.id)) {
					channel.#said(change.value, commentMessages?.has(change.value.id));
				}
				if (change.type !== "document") continue;
				if (change.record.kind === BuildsDoc.definition.kind) {
					const woken = channel.#builds.observe(change.value as BuildsState | null);
					if (options.resume !== false && woken.length) void Promise.resolve().then(() => channel.#builds.resume(woken));
					continue;
				}
				// Commit order, not request completion order, decides the state clients see.
				if (change.record.kind === SettingsDoc.definition.kind) {
					channel.#settings = change.value as Settings;
					channel.#broadcast();
					continue;
				}
				if (change.record.kind === MessagesDoc.definition.kind) {
					const { scope } = change.record;
					const value = change.value as Messages | null;
					if (scope.kind === "conversation" && value) {
						const chat = scope.conversationId;
						channel.#sendActions(chat, { kind: "reactions", chat, reactions: value.reactions });
					}
					continue;
				}
				if (change.record.kind === InboxDoc.definition.kind) {
					const { scope } = change.record;
					if (scope.kind === "conversation") {
						handoffs.inbox(scope.conversationId, change.value as InboxState | null);
						waits.inbox(scope.conversationId, change.value as InboxState | null);
					}
					continue;
				}
				if (change.record.kind === ApprovalRequestsDoc.definition.kind) {
					const { scope } = change.record;
					if (scope.kind === "conversation") approvals.changed(harness, scope.conversationId, change.value as ApprovalRequestsState | null);
					continue;
				}
				if (change.record.kind !== LiveDoc.definition.kind) continue;
				const { scope } = change.record;
				if (scope.kind !== "conversation") continue;
				const { run } = (change.value || {}) as LiveState;
				const inputs = channel.#runs.get(scope.conversationId);
				if (inputs && inputs[0] !== run?.inputs[0]) runEnded = true;
				if (run) {
					channel.#runs.set(scope.conversationId, run.inputs);
					if (inputs?.[0] !== run.inputs[0]) {
						void channel.#builds.state(scope.conversationId, "running", run.inputs[0]);
					}
				} else if (inputs) {
					channel.#runs.delete(scope.conversationId);
					channel.#caption(scope.conversationId);
					ended.push([scope.conversationId, inputs]);
				}
			}
			if (runEnded) void channel.#builds.replyToMentions();
			// Ending a run settles its inputs in the same commit, in no particular change order.
			for (const [chat, inputs] of ended) {
				const task = channel.#ended(chat, inputs, changes);
				channel.#captionTasks.add(task);
				void task.finally(() => channel.#captionTasks.delete(task));
			}
			// Publish once per atomic commit, not once per chat or streaming delta.
			channel.#publishBusy();
			if (changes.some((change) => change.type === "entry")) channel.#activity();
		});
		if (options.relocate) {
			await harness.commit(async (tx) => {
				let cursor: Cursor | undefined;
				do {
					const page = await tx.scanConversations({}, 256, cursor);
					for (const record of page.items) {
						await configure(tx, record.id, { cwd: options.project });
					}
					cursor = page.next;
				} while (cursor);
				(await tx.doc(LanesDoc)).lanes = {};
			}, context);
		}
		// Opening resumes work a crash interrupted; a killed channel left only terminal tasks behind.
		await options.extension?.attach?.(harness, {
			invoke: async (author) => { channel.#author(author); await channel.#mayInvoke(author); },
			serialize: (chat, work) => channel.#admitted(chat, work),
			onStop: stop => approvals.registerStop(stop),
			onApprovalAnswer: send => approvals.registerAnswer(send),
			requestAttendance: owns => approvals.registerRuntimeModels(owns),
		});
		channel.#feed = await options.feed?.(harness, channel.submitInput.bind(channel));
		if (options.resume !== false) {
			await channel.#builds.finishStops();
			await channel.#builds.recoverMentionEntries();
			harness.resume();
			void channel.#builds.resume();
		}
		log("info", "channel.open", { name: value.name, project: options.project });
		return channel;
		} catch (error) {
			const errors: unknown[] = [error];
			if (ownedChannel) {
				try {
					await ownedChannel.close();
				} catch (cleanup) {
					errors.push(cleanup);
				}
			} else if (ownedHarness) {
				try {
					await ownedHarness.close(context);
				} catch (cleanup) {
					errors.push(cleanup);
				}
				try {
					unbind?.();
				} catch (cleanup) {
					errors.push(cleanup);
				}
			} else {
				try {
					await options.storage.close(context);
				} catch (cleanup) {
					errors.push(cleanup);
				}
			}
			if (errors.length > 1)
				throw new AggregateError(errors, "Channel startup and cleanup failed");
			throw error;
		}
	}

	/** Runs a client request, logging its outcome with the caller's `trace` id. */
	async handle(request: Request, send: Send, trace?: string): Promise<unknown> {
		if (this.#closed) throw new Error("The channel is shutting down");
		const start = Date.now();
		const fields = {
			...(trace ? { trace } : {}),
			op: request.op,
			...("chat" in request && request.chat !== undefined ? { chat: request.chat } : {}),
			...("author" in request ? { author: request.author } : {}),
			...("requestId" in request && request.requestId ? { requestId: request.requestId } : {}),
			...("model" in request && request.model ? { model: request.model } : {}),
		};
		try {
			const value = await this.#handle(request, send);
			// Watches and polls are constant traffic; their failures still log below.
			const level = request.op === "watch" || request.op === "info" || request.op === "models"
				? "debug"
				: "info";
			this.#log(level, "request", { ...fields, ms: Date.now() - start, ...result(value) });
			return value;
		} catch (error) {
			// Refused requests are expected; their message is enough.
			const message = error instanceof Error ? error.message : String(error);
			this.#log("warn", "request.failed", { ...fields, ms: Date.now() - start, error: message });
			throw error;
		}
	}

	async #handle(request: Request, send: Send): Promise<unknown> {
		switch (request.op) {
			case "info":
				return this.info();
			case "models":
				return available(this.#options.models, this.#options.routeModel);
			case "say":
				return this.#admitted(request.chat, () => this.#say(request));
			case "ask":
				return this.#ask(request);
			case "select":
				return this.#admitted(request.chat, () => this.#pick(request));
			case "chat":
				return this.#chat(request);
			case "answer": {
				this.#author(request.author);
				await this.#mayInvoke(request.author);
				const { id } = await this.#conversation(request.chat);
				const answers = "text" in request ? request.text : request.answers;
				return answer(this.#harness, id, request.call, request.author, answers, context);
			}
			case "skip": {
				this.#author(request.author);
				await this.#mayInvoke(request.author);
				const { id } = await this.#conversation(request.chat);
				return answer(this.#harness, id, request.call, request.author, null, context);
			}
			case "approval-answer":
				return this.#admitted(request.chat, async () => {
					requirePerson(request.author);
					this.#author(request.author);
					await this.#mayInvoke(request.author);
					return this.#approvals.answer(this.#harness, (await this.#conversation(request.chat)).id, request);
				});
			case "plan":
				return this.#admitted(request.chat, async () => {
					const { id } = await this.#conversation(request.chat);
					return this.#plans.read(this.#harness, id, request.plan, context);
				});
			case "plan-approve": {
				const { id, plan, state } = await this.#admitted(request.chat, async () => {
					this.#author(request.author);
					if (room.isAgent(request.author)) throw new Error("Only a person can approve a plan.");
					await this.#mayInvoke(request.author);
					const { id } = await this.#conversation(request.chat);
					let admission: ReturnType<Builds["approve"]> | undefined;
					const plan = await this.#plans.approve(this.#harness, id, request.plan, request.hash, request.author, context,
						async (tx, stored, approved) => {
							// Pi publishes the previous settings commit before running this transaction.
							admission = this.#builds.approve(tx, id, stored.plan.hash, { stored, approved });
							await admission;
						});
					const state = await (admission ?? this.#harness.commit(tx => this.#builds.approve(tx, id, plan.hash), context));
					return { id, plan, state };
				});
				const build = buildId(id, plan.hash);
				if (state) this.#log("info", "build.recorded", { build, state });
				if (this.#options.resume !== false) void this.#builds.resume([build]);
				return plan;
			}
			case "plan-comment":
			case "plan-comment-reply":
			case "plan-comment-edit":
			case "plan-comment-remove":
			case "plan-comments-send":
				return this.#admitted(request.chat, async settled => {
					const conversation = await this.#writableChat(request.chat);
					this.#author(request.author);
					if (room.isAgent(request.author)) throw new Error("Only a person can manage plan comments.");
					await this.#flushPlanDeliveries();
					if (request.op === "plan-comments-send") {
						this.#clientRequestId(request.requestId);
						await this.#mayInvoke(request.author);
						return this.#recordPlanCommentSend(conversation, request, settled);
					}
					const { id } = conversation;
					return request.op === "plan-comment"
						? keepPlanComment(this.#plans, this.#harness, id, request, context)
						: changePlanComment(this.#harness, id, request, this.#planPlacementCache(id), context);
				});
			case "react": {
				this.#author(request.author);
				const { id } = await this.#conversation(request.chat);
				const entry = request.entry as EntryId;
				const reaction = { from: request.author, emoji: request.emoji };
				return react(this.#harness, id, entry, reaction, !!request.remove, context);
			}
			case "delete":
			case "edit": {
				this.#author(request.author);
				const { id } = await this.#writableChat(request.chat);
				const entry = request.entry as EntryId;
				await this.#mayChangeMessage(id, entry);
				return request.op === "edit"
					? edit(this.#harness, id, entry, request.author, request.text, context)
					: remove(this.#harness, id, entry, request.author, context);
			}
			case "stop": {
				this.#author(request.author);
				// Whoever can't start a run here can't end the owner's either.
				await this.#mayInvoke(request.author);
				const conversation = await this.#conversation(request.chat);
				return this.#stopChat(conversation, this.#runs.has(conversation.id)
					? { by: request.author, at: Date.now() } : undefined);
			}
			case "build-stop":
				this.#author(request.author);
				if (room.isAgent(request.author)) throw new Error("Only a person can stop the plan's agents.");
				await this.#mayInvoke(request.author);
				return this.#builds.stop(request.build, request.author);
			case "kill":
				this.#author(request.author);
				await this.#mayInvoke(request.author);
				return this.kill(request.author);
			case "share":
				return this.#share(request);
			case "desktop":
				return this.#desktop(request);
			case "rename":
				return this.#rename(request);
			case "watch":
				return this.#watch(request, send);
			case "typing": {
				this.#author(request.author);
				const { id } = await this.#conversation(request.chat);
				const event: Event = { kind: "typing", chat: id, author: request.author };
				for (const listener of this.#listeners) {
					if (listener.chat !== id || !listener.typing) continue;
					try {
						listener.send(event);
					} catch {
						this.#listeners.delete(listener);
					}
				}
				return;
			}
			case "changes": {
				const { cwd, lane } = await this.#place(request.chat);
				return changes(this.#options.env(cwd), cwd, this.#options.project, lane, context);
			}
			case "fetch": {
				const { cwd, lane } = await this.#place(request.chat);
				return fetchBase(this.#options.env(cwd), cwd, lane?.base, context);
			}
			case "patch": {
				const { cwd, lane } = await this.#place(request.chat);
				const { env, project } = this.#options;
				return patch(env(cwd), cwd, project, lane?.base, request.file, request.state, context);
			}
			case "wait": {
				const submission = await this.#harness.submission(
					request.submission as SubmissionId,
					context,
				);
				if (!submission) throw new Error(`Unknown submission ${request.submission}`);
				return (await submission.wait(context)).status;
			}
		}
	}

	async info(): Promise<ChannelInfo> {
		const { id, project, owner } = this.#options;
		const { name, summary, revision } = (await this.#harness.snapshot(MetadataDoc, context))!;
		const records: ConversationRecord[] = [];
		let cursor: Cursor | undefined;
		do {
			const page = await this.#harness.commit(
				(tx) => tx.scanConversations({}, 256, cursor),
				context,
			);
			records.push(...page.items);
			cursor = page.next;
		} while (cursor);
		const lanes = (await this.#harness.snapshot(LanesDoc, context))?.lanes || {};
		const modes = (await this.#harness.snapshot(ChatModesDoc, context))?.chats || {};
		const byPath = new Map(Object.entries(lanes).map(([lane, { path }]) => [path, lane]));
		const chats: Chat[] = await Promise.all(records.map(async (record) => {
			const [agent, live, spent] = await Promise.all([
				this.#harness.snapshot(AgentDoc, record.id, context),
				this.#harness.snapshot(LiveDoc, record.id, context),
				this.#harness.snapshot(UsageDoc, record.id, context),
			]);
			const cwd = agent?.cwd;
			const lane = cwd && byPath.get(cwd);
			const chat: Chat = { id: record.id, busy: !!live?.run, usage: price(usage(spent), [...Object.keys(spent?.models || {}), ...Object.keys(spent?.tools || {})], this.#options.extension?.priced) };
			chat.mode = modes[record.id] ?? "ace";
			const membership = this.#builds.agent(record.id);
			if (membership) {
				const { build, role, part } = membership;
				chat.build = { id: build, role, ...(part === undefined ? {} : { part }) };
			}
			const window = agent?.model
				&& this.#options.models.getModel(agent.model.provider, agent.model.modelId)?.contextWindow;
			const used = window && await this.#used(record.id);
			if (window && used) chat.context = { used, window };
			if (record.owner) chat.parent = record.owner.conversationId;
			if (agent?.model) chat.model = agent.model;
			chat.effort = agent?.thinkingLevel || "off";
			if (lane) Object.assign(chat, { lane, cwd });
			return chat;
		}));
		// Without a usable key there is nothing to name; asking says so.
		const automatic = await this.#automatic().catch(() => undefined);
		return {
			id,
			name,
			summary,
			revision,
			project,
			owner,
			...this.#settings,
			chats,
			...(automatic ? { automatic } : {}),
		};
	}

	/** The newest response's own token count; providers report what that request carried. */
	async #used(id: ConversationId): Promise<number | undefined> {
		const conversation = await this.#harness.conversation(id, context);
		const { messages } = await conversation!.context(context);
		for (let index = messages.length - 1; index >= 0; index--) {
			const message = messages[index]!;
			if (message.role !== "assistant") continue;
			const { input, output, cacheRead, cacheWrite } = message.usage;
			const total = input + output + cacheRead + cacheWrite;
			// A failed or aborted request reports nothing; the context is what the last real one carried.
			if (total) return total;
		}
	}

	get busy(): boolean {
		return this.#runs.size > 0;
	}

	get observing(): boolean { return this.#feed?.pending() ?? false; }

	async isIdle(): Promise<boolean> {
		return !this.busy && !this.#builds.pending;
	}

	async #restoreRunsAndHandoffs(handoffs: Handoffs): Promise<void> {
		let cursor: Cursor | undefined;
		do {
			const page = await this.#harness.commit(
				(tx) => tx.scanConversations({}, 256, cursor),
				context,
			);
			for (const { id } of page.items) {
				const live = await this.#harness.snapshot(LiveDoc, id, context);
				if (live?.run) this.#runs.set(id, live.run.inputs);
				if (!this.#builds.agent(id)) continue;
				const inbox = await this.#harness.snapshot(InboxDoc, id, context);
				for (const item of inbox?.items ?? []) {
					if (item.mode === "write") continue;
					const submission = await (await this.#harness.submission(item.id, context))?.status(context);
					if (submission && isWorkMessageSubmission(submission)) handoffs.buildSteer(submission);
				}
			}
			cursor = page.next;
		} while (cursor);
		this.#publishBusy();
	}

	#publishBusy(): void {
		const busy = this.busy;
		if (busy === this.#publishedBusy) return;
		try {
			this.#options.onBusy?.(busy);
			this.#publishedBusy = busy;
		} catch (error) {
			this.#log("warn", "busy.publish", failure(error));
		}
	}

	async #ended(
		chat: ConversationId,
		inputs: readonly SubmissionId[],
		changes: readonly CommitChange[],
	): Promise<void> {
		const settled = new Map<SubmissionId, SubmissionRecord>();
		for (const change of changes) {
			if (change.type === "submission") settled.set(change.value.id, change.value);
		}
		const last = settled.get(inputs.at(-1)!);
		if (!last) return;
		const outcome = last.status === "done"
			? "done"
			: last.reason === "aborted"
			? "stopped"
			: "failed";
		await this.#builds.state(chat, outcome, undefined);
		await this.#publishRun(chat, inputs.map((id) => settled.get(id)), outcome);
	}

	#planPlacementCache(chat: ConversationId): PlanCommentPlacements {
		let placements = this.#planPlacements.get(chat);
		if (!placements) {
			placements = new PlanCommentPlacements();
			placements.retain(this.#planState, chat);
			this.#planPlacements.set(chat, placements);
		}
		return placements;
	}

	#observePlanCommentSends(changes: readonly CommitChange[]): Set<EntryId> | undefined {
		const plans = changes.find(change => change.type === "document" && change.record.kind === PlansDoc.definition.kind);
		if (plans?.type === "document") {
			this.#planState = (plans.value as PlansState | null) ?? undefined;
			for (const [chat, placements] of this.#planPlacements) placements.retain(this.#planState, chat);
		}
		if (!this.#planState?.sends) return;
		const entries = new Set<EntryId>();
		const deliveries = changes.flatMap((change): PlanDelivery[] => {
			if (change.type !== "submission") return [];
			const { conversationId: chat, requestId, entry, id } = change.value;
			if (change.value.type !== "input" || requestId === undefined) return [];
			const batch = planCommentBatch(this.#planState, chat, requestId);
			if (!batch || (batch.receipt && batch.receipt.submission !== id)) return [];
			if (entry !== undefined) entries.add(entry);
			if (batch.settled) return [];
			const live = changes.find(change => change.type === "document" && change.record.kind === LiveDoc.definition.kind
				&& change.conversationId === chat);
			const run = live?.type === "document" ? (live.value as LiveState | null)?.run : undefined;
			const failed = changes.find(change => change.type === "task" && change.value.conversationId === chat
				&& change.value.kind === GenerationTask.definition.name && change.value.state.outcome?.error);
			const runError = failed?.type === "task" ? failed.value.state.outcome?.error?.message : undefined;
			return [{ chat, requestId, record: change.value, pickedUp: run?.inputs.includes(id) ?? false, runError }];
		});
		if (deliveries.length) {
			this.#pendingPlanDeliveries.push(deliveries);
			void this.#flushPlanDeliveries().catch(error => this.#log("warn", "plan.comments.delivery.failed", failure(error)));
		}
		return entries;
	}

	#flushPlanDeliveries(): Promise<void> {
		if (this.#planDeliveries) return this.#planDeliveries;
		if (!this.#pendingPlanDeliveries.length) return Promise.resolve();
		// A watcher can see Pi's transcript entry before the carried items are marked sent.
		// A crash there leaves the entry and staged batch. Retry drains these updates in-process.
		// Reopening reconciles the staged batch against Pi's durable submission.
		this.#planDeliveries = Promise.resolve().then(async () => {
			try {
				for (let deliveries; (deliveries = this.#pendingPlanDeliveries[0]);) {
					await this.#harness.commit(async tx => {
						const state = await tx.doc(PlansDoc);
						for (const { chat, requestId, record, pickedUp, runError } of deliveries) {
							const batch = planCommentBatch(state, chat, requestId);
							if (batch) updatePlanCommentDelivery(state, batch, record, pickedUp, runError);
						}
					}, context);
					this.#pendingPlanDeliveries.shift();
				}
			} finally {
				this.#planDeliveries = undefined;
			}
		});
		return this.#planDeliveries;
	}

	/** A run waiting on a person needs the same attention as one that ended. */
	async #asked(chat: ConversationId, phase: "question" | "answered"): Promise<void> {
		const inputs = this.#runs.get(chat);
		if (!inputs) return;
		await this.#builds.state(chat, phase === "question" ? "waiting" : "running", inputs[0]);
		const submissions = await Promise.all(inputs.map(async (id) => {
			const submission = await this.#harness.submission(id, context);
			return submission?.status(context);
		}));
		await this.#publishRun(chat, submissions, phase);
	}

	async #publishRun(
		chat: ConversationId,
		submissions: (SubmissionRecord | undefined)[],
		outcome: RunEnd["outcome"],
	): Promise<void> {
		try {
			// The newest human input names who is waiting; agents' inputs are their parents' work.
			const input = await this.#harness.commit(async (tx) => {
				for (const submission of submissions.toReversed()) {
					if (submission?.type !== "input" || submission.conversationId !== chat || submission.entry === undefined) continue;
					if (this.#builds.isBrief(submission) || isMentionSubmission(submission)) continue;
					const human = room.human((await tx.entry(submission.entry))!);
					if (human && !room.isAgent(human.author)) return { author: human.author, submission: submission.id };
				}
			}, context);
			if (!input) return;
			const feed = await this.#harness.snapshot(ReviewFeedDoc, chat, context);
			const notice = Object.entries(feed?.notices ?? {}).find(([, notice]) =>
				notice.delivered && notice.chat === chat && notice.submission === input.submission
			);
			const system: ReviewNotice | undefined = notice ? { kind: "neuve:review:terminal", review: notice[0] } : undefined;
			this.#options.onRun?.({ chat, at: Date.now(), outcome, author: input.author, ...(system ? { system } : {}) });
		} catch (error) {
			this.#log("warn", "run.publish", failure(error));
		}
	}

	/** Durably abort every chat's work, including background subagents, so reopening resumes none of it. */
	/** The channel's chats as a seed another channel can import. */
	export(): Promise<Seed> {
		return exportSeed(this.#harness);
	}

	/** Fills a new channel from a seed, `shift` milliseconds later than its own times. */
	import(value: Seed, shift?: number): Promise<void> {
		return importSeed(this.#harness, value, shift);
	}

	/** `author`'s kill records a Stop in each chat it ended, so their next runs know. */
	async kill(author?: string): Promise<void> {
		const { chats } = await this.info();
		const busy = chats.filter((chat) => chat.busy);
		this.#log("warn", "channel.kill", { chats: busy.map((c) => c.id) });
		await Promise.all(chats.map(async (chat) => {
			const conversation = await this.#harness.conversation(chat.id as ConversationId, context);
			await conversation?.abort(context, { background: true });
		}));
		await this.#flushPlanDeliveries();
		if (!author) return;
		const at = Date.now();
		await Promise.all(busy.map(async (chat) => {
			const conversation = await this.#conversation(chat.id);
			await conversation.submit({ type: "write", entry: room.stop(author, at) }, context);
		}));
	}

	close(): Promise<void> {
		return (this.#closed ??= Promise.resolve().then(async () => {
			const errors: unknown[] = [];
			try {
				this.#log("info", "channel.close");
			} catch (error) {
				errors.push(error);
			}
			this.#closing.abort();
			const builds = this.#builds.close();
			try { await this.#feed?.close(); } catch (error) { errors.push(error); }
			// Native close seals admission and joins generation and tool tasks before storage closes.
			// Caption calls are external producers, so join them before entering that boundary.
			await Promise.allSettled(this.#captionTasks);
			await Promise.allSettled(this.#admissions.values());
			await builds;
			await this.#approvals.close();
			await this.#flushPlanDeliveries().catch(error => errors.push(error));
			try {
				await this.#harness.close(context);
			} catch (error) {
				errors.push(error);
			}
			for (const remove of [this.#unsubscribe, this.#unbind]) {
				try {
					remove?.();
				} catch (error) {
					errors.push(error);
				}
			}
			this.#runs.clear();
			try {
				this.#publishBusy();
			} catch (error) {
				errors.push(error);
			}
			if (errors.length > 1)
				throw new AggregateError(errors, "Channel close failed");
			if (errors.length === 1) throw errors[0];
		}));
	}

	/** Where a chat works: its current lane's worktree, or the project checkout before it has one. */
	async #place(
		chat: ChatId | undefined,
	): Promise<{ cwd: string; lane?: { name: string; base?: string } }> {
		const { id } = await this.#conversation(chat);
		const cwd = (await this.#harness.snapshot(AgentDoc, id, context))?.cwd || this.#options.project;
		const lanes = (await this.#harness.snapshot(LanesDoc, context))?.lanes || {};
		const found = Object.entries(lanes).find(([, value]) => value.path === cwd);
		if (!found) return { cwd };
		const [name, { base }] = found;
		return { cwd, lane: base ? { name, base } : { name } };
	}

	async #conversation(chat: ChatId | undefined): Promise<Conversation> {
		const conversation = await this.#harness.conversation(
			(chat ?? ROOT_CONVERSATION_ID) as ConversationId,
			context,
		);
		if (!conversation) throw new Error(`No chat ${chat}`);
		return conversation;
	}

	async #writableChat(chat: ChatId | undefined): Promise<Conversation> {
		const conversation = await this.#conversation(chat);
		if (this.#builds.agent(conversation.id)) throw new Error("An agent's chat is read-only.");
		return conversation;
	}

	async #stopChat(conversation: Conversation, note?: { by: string; at: number; requestId?: string }, background = false) {
		await this.#approvals.stop(conversation.id);
		await conversation.abort(context, { background });
		await this.#flushPlanDeliveries();
		if (note) await conversation.submit({ type: "write", entry: room.stop(note.by, note.at), requestId: note.requestId }, context);
	}

	#author(author: string) {
		if (!room.isAuthor(author)) throw new Error(`Invalid author ${author}`);
	}

	async #mayChangeMessage(chat: ConversationId, entry: EntryId) {
		const target = await this.#harness.commit(tx => tx.entry(entry), context);
		if (target?.conversationId !== chat) throw new Error(`No message ${entry} in chat ${chat}`);
		const feed = await this.#harness.snapshot(ReviewFeedDoc, chat, context);
		for (const notice of Object.values(feed?.notices ?? {})) {
			if (notice.chat !== chat) continue;
			const requestId = notice.requestId;
			const record = notice.delivered && notice.submission !== undefined
				? await (await this.#harness.submission(notice.submission as SubmissionId, context))?.status(context)
				: !notice.delivered && requestId
					? await this.#harness.commit(tx => tx.submissionByRequest(chat, requestId), context)
					: undefined;
			if (record?.type === "input" && record.conversationId === chat && record.entry === entry)
				throw new Error("Neuve review system messages cannot be edited or deleted");
		}
	}

	async #say(request: Extract<Request, { op: "say" }>) {
		this.#clientRequestId(request.requestId);
		this.#author(request.author);
		const conversation = await this.#writableChat(request.chat);
		room.checkAttachments(request);
		const mention = this.#mention(request, conversation.id);
		const requestId = mention?.requestId ?? request.requestId;
		const { author, text, images, files, agents } = request;
		const value = requestId && await digest({ op: "say", author, text, images, files, agents });
		if (mention) {
			const existing = await this.#checkMessage(conversation.id, mention.requestId, value!, mention);
			if (existing !== undefined) return { submission: existing };
		}
		// The chat's next run reads this message, so it must fit the model the chat has now.
		const { model } = await conversation.agent(context);
		const selected = model && this.#options.models.getModel(model.provider, model.modelId);
		if (selected) room.checkContext(selected, request);
		const entry = room.draft(request.author, request.text, Date.now(), request);
		if (requestId && value) {
			const existing = await this.#afterMentionStops(() => this.#harness.commit(
				tx => this.#claimMessage(tx, conversation.id, requestId, value, mention),
				context,
			));
			if (existing !== undefined) return { submission: existing };
		}
		const submission = await conversation.submit({
			type: "write",
			entry,
			...(requestId ? { requestId } : {}),
		}, context);
		return { submission: submission.id };
	}

	#mention({ agents, author, text, requestId }: Extract<Request, { op: "say" | "ask" }>, thread: ConversationId): Mention | undefined {
		if (!agents) return;
		return { thread, author, text, requestId: requestId ?? crypto.randomUUID(), agents: [...new Set(agents)] as ConversationId[] };
	}

	#mentionProblems(author: string) {
		const problems: string[] = [];
		if (room.isAgent(author)) problems.push("Only a person can mention a plan's agents.");
		const refusal = this.#invokeRefusal(author, this.#settings.shared);
		if (refusal) problems.push(refusal);
		return problems;
	}

	#checkMessage(chat: ConversationId, requestId: string, value: string, mention: Mention | undefined) {
		return this.#harness.commit(async tx => {
			const existing = await admitted(tx, chat, requestId, value);
			if (existing !== undefined) return existing;
			if (mention) {
				await this.#builds.checkMention(tx, mention.agents, this.#mentionProblems(mention.author));
			}
		}, context);
	}

	async #claimMessage(tx: Tx, chat: ConversationId, requestId: string, value: string, mention: Mention | undefined) {
		const existing = await claim(tx, chat, requestId, value);
		if (existing === undefined && mention) await this.#builds.recordMention(tx, mention, this.#mentionProblems(mention.author));
		return existing;
	}

	async #afterMentionStops<T>(admit: () => Promise<T>): Promise<T> {
		for (;;) {
			try { return await admit(); }
			catch (error) {
				if (!(error instanceof MentionStopping)) throw error;
				await Promise.all(error.builds.map(build => this.#builds.finishStops(build)));
			}
		}
	}

	#ask(request: Extract<Request, { op: "ask" }>) {
		this.#clientRequestId(request.requestId);
		return this.#admitted(request.chat, settled => this.#admit(request, settled));
	}

	async #recordPlanCommentSend(
		conversation: Conversation, request: Extract<Request, { op: "plan-comments-send" }>, settled: Promise<unknown>,
	): Promise<PlanCommentReceipt> {
		const chat = conversation.id;
		const requestId = request.requestId ?? crypto.randomUUID();
		const value = await digest({ op: request.op, author: request.author, plan: request.plan });
		const existing = await this.#harness.commit(tx => admitted(tx, chat, requestId, value), context);
		if (existing !== undefined) {
			const receipt = planCommentBatch(this.#planState, chat, requestId)?.receipt;
			if (!receipt || receipt.submission !== existing) throw new Error("The plan comment send receipt is missing.");
			return receipt;
		}
		const batch = await preparePlanCommentSend(this.#planState, chat, request, this.#planPlacementCache(chat));
		const bound = async (tx: Tx) => {
			if (await claim(tx, chat, requestId, value) !== undefined) {
				throw new Error(`Request ${requestId} was admitted by a concurrent request`);
			}
			await stagePlanCommentBatch(tx, chat, requestId, batch);
		};
		const input: InputSubmissionDraft = {
			type: "input", content: room.content(request.author, batch.message.text), whenBusy: "steer", requestId,
		};
		const queuedParents = new Set(batch.items.flatMap(({ comment, reply }) =>
			reply && comment.sent && comment.sent.entry === undefined ? [comment.sent.submission] : []));
		const cancellation = queuedParents.size ? withCancel(context) : undefined;
		const refusal = `Nothing was sent. ${KEPT_PLAN_REPLIES_REASON}`;
		// Pi publishes each withdrawal before checking cancellation for the next submission commit.
		const unsubscribe = cancellation && this.#harness.subscribeCommits(({ changes }) => {
			if (changes.some(change => change.type === "submission" && queuedParents.has(change.value.id)
				&& change.value.status === "unanswered" && change.value.entry === undefined)) {
				cancellation.cancel(new Error(refusal));
			}
		});
		let submission: SubmissionId | undefined;
		try {
			for (const parent of queuedParents) {
				const handle = await this.#harness.submission(parent as SubmissionId, context);
				const record = await handle?.status(context);
				if (record?.entry === undefined && record?.status !== "queued") throw new Error(refusal);
			}
			({ submission } = await this.#select(conversation, {}, {
				bound, mode: "plan", attended: undefined, input, settled,
			}, cancellation?.context ?? context));
		} catch (error) {
			if (planCommentBatch(this.#planState, chat, requestId)) {
				await this.#harness.commit(tx => discardPlanCommentBatch(tx, chat, requestId), context)
					.catch(cleanup => this.#log("warn", "plan.comments.cleanup.failed", failure(cleanup)));
			}
			throw error;
		} finally {
			unsubscribe?.();
		}
		await this.#flushPlanDeliveries();
		const receipt = planCommentBatch(this.#planState, chat, requestId)?.receipt;
		if (!receipt || receipt.submission !== submission) throw new Error("The plan comment send receipt is missing.");
		return receipt;
	}

	#clientRequestId(requestId: string | undefined) {
		if (reservedReviewRequestId(requestId)) throw new Error("The neuve.review: request-ID namespace is reserved for the host");
		if (reservedBuildRequestId(requestId)) throw new Error("The neuve.build: request-ID namespace is reserved for the host.");
	}

	async #admitted<T>(id: ChatId | undefined, admit: (settled: Promise<T>) => Promise<T>): Promise<T> {
		const chat = id || ROOT_CONVERSATION_ID;
		const previous = this.#admissions.get(chat) || Promise.resolve();
		// Selection and submission must stay together across concurrent clients.
		const pending: Promise<T> = previous.catch(() => {}).then(() => admit(pending));
		this.#admissions.set(chat, pending);
		try {
			return await pending;
		} finally {
			if (this.#admissions.get(chat) === pending) this.#admissions.delete(chat);
		}
	}

	submitInput(handle: Pick<ConversationHandle, "id" | "submit">, input: InputSubmissionDraft, callContext: Context): Promise<Submission>;
	submitInput(handle: Pick<ConversationHandle, "id" | "submit">, input: InputSubmissionDraft, callContext: Context, canSubmit: () => boolean): Promise<Submission | undefined>;
	submitInput(handle: Pick<ConversationHandle, "id" | "submit">, input: InputSubmissionDraft, callContext: Context, canSubmit?: () => boolean): Promise<Submission | undefined> {
		return this.#admitted(handle.id, async () => {
			if (canSubmit?.() === false) return;
			await this.#select(await this.#conversation(handle.id), {}, undefined, callContext);
			if (canSubmit?.() === false) return;
			return handle.submit(input, callContext);
		});
	}

	async #admit(request: Extract<Request, { op: "ask" }>, settled: Promise<unknown>) {
		this.#author(request.author);
		room.checkAttachments(request);
		if (!request.agents) await this.#mayInvoke(request.author);
		const conversation = await this.#writableChat(request.chat);
		const mention = this.#mention(request, conversation.id);
		const requestId = mention?.requestId ?? request.requestId;
		const { author, text, images, files, model, automatic, effort, mode, attended, agents } = request;
		let bound: ((tx: Tx) => Promise<void>) | undefined;
		if (requestId) {
			const value = await digest({ op: "ask", author, text, images, files, model, automatic, effort, mode, attended, agents });
			// A retry gets its submission back without selecting again, so it never undoes a later choice.
			const existing = await this.#checkMessage(conversation.id, requestId, value, mention);
			if (existing !== undefined) return { submission: existing };
			bound = async (tx) => {
				if (await this.#claimMessage(tx, conversation.id, requestId, value, mention) !== undefined) {
					throw new Error(`Request ${requestId} was admitted by a concurrent request`);
				}
			};
		}
		if (mode !== undefined && room.isAgent(author)) throw new Error("Only a person can set the chat's mode.");
		if (attended !== undefined && room.isAgent(author)) throw new Error("Only a person can set the chat's attendance.");
		const input: InputSubmissionDraft = {
			type: "input",
			content: room.content(request.author, request.text, request),
			whenBusy: "steer",
			...(requestId ? { requestId } : {}),
		};
		const { submission } = await this.#afterMentionStops(() => this.#select(conversation, request, { bound, mode, attended, input, settled }));
		return { submission };
	}

	async #pick(request: Extract<Request, { op: "select" }>) {
		this.#author(request.author);
		await this.#mayInvoke(request.author);
		const conversation = await this.#conversation(request.chat);
		const agent = this.#builds.agent(conversation.id);
		if (agent && !await this.#harness.commit(tx => tx.submissionByRequest(conversation.id, agent.requestId), context)) {
			throw new Error(waitForBrief);
		}
		return this.#select(conversation, request);
	}

	#canInvoke(author: string, shared: boolean): boolean {
		// Hosts rewrite every client's author, so an agent author is another channel's agent on this
		// host, already running as the owner's user. Sharing gates teammates, not those handoffs.
		return author === this.#options.owner || room.isAgent(author) || shared;
	}

	#invokeRefusal(author: string, shared: boolean) {
		if (this.#canInvoke(author, shared)) return;
		return `Agent access is off in this channel, so only its owner, ${this.#options.owner}, can ask its agents.`;
	}

	async #mayInvoke(author: string) {
		const settings = await this.#harness.snapshot(SettingsDoc, context);
		const refusal = this.#invokeRefusal(author, settings?.shared !== false);
		if (refusal) throw new Error(refusal);
	}

	/** Model and effort apply to a whole run, never just its later turns. */
	async #select(
		conversation: Conversation,
		selection: room.Attached & { model?: ModelRef; effort?: Effort; automatic?: boolean },
		invocation?: { bound: ((tx: Tx) => Promise<void>) | undefined; mode: ChatMode | undefined; attended: boolean | undefined; input: InputSubmissionDraft; settled: Promise<unknown> },
		callContext = context,
	): Promise<{ model: ModelRef; effort: Effort; submission?: SubmissionId }> {
		const { model: requested, effort, automatic } = selection;
		const agent = await conversation.agent(callContext);
		const current = agent.model;
		const kept = !requested && !automatic && current
			? await resolveStoredModel(this.#options.models, current)
			: undefined;
		const model = requested || kept || await this.#automatic();
		const selected = this.#options.models.getModel(model.provider, model.modelId);
		if (!selected) {
			throw new Error(`Model ${model.provider}/${model.modelId} is not offered. Choose another model.`);
		}
		// Before configuring, so a refused message leaves the chat's model as it was.
		room.checkContext(selected, selection);
		const levels = getSupportedThinkingLevels(selected);
		if (effort !== undefined && effort !== "off" && !levels.includes(effort)) {
			const listed = levels.filter((level) => level !== "off");
			throw new Error(
				`Unsupported reasoning effort ${effort} for ${model.provider}/${model.modelId}: ${listed.length ? `it lists ${listed.join(", ")}` : "it lists no effort levels"}, and off.`,
			);
		}
		// Pi's "off" means omit reasoning, allowing provider defaults on always-thinking models.
		const thinkingLevel = effort
			|| (levels.includes(agent.thinkingLevel) ? agent.thinkingLevel : this.#options.extension?.thinkingLevel || "off");
		const sameModel = current?.provider === model.provider && current.modelId === model.modelId;
		const same = sameModel && thinkingLevel === agent.thinkingLevel;
		if (model !== kept && !await usable(this.#options.models, model)) {
			// getModel above found this model, so its provider is registered.
			const name = this.#options.models.getProvider(model.provider)!.name;
			throw new Error(
				`The ${name} API key is missing. Add it in Provider settings to invoke an agent. Chat is still available.`,
			);
		}
		const mode = invocation?.mode;
		const checkModelIdle = async (tx: Tx) => {
			if (!same && (await tx.doc(LiveDoc, conversation.id)).run) {
				throw new Error(
					"The chat is busy; stop it or wait before changing its model or reasoning effort",
				);
			}
		};
		let modeChange: Awaited<ReturnType<typeof setChatMode>>;
		let previousSelection: Pick<AgentChange, "model" | "thinkingLevel"> | undefined;
		let submission: SubmissionId | undefined;
		try {
			if (invocation && mode !== undefined) {
				// The chat and affected children must be idle, and new policy reads wait for admission to settle.
				this.#changingModes.set(conversation.id, invocation.settled);
				modeChange = await this.#harness.commit(async tx => {
					await checkModelIdle(tx);
					await invocation.bound?.(tx);
					return setChatMode(tx, conversation.id, mode);
				}, callContext);
			}
			if (!same || (mode === undefined && invocation?.bound)) {
				previousSelection = await this.#harness.commit(async tx => {
					await checkModelIdle(tx);
					if (mode === undefined) await invocation?.bound?.(tx);
					if (same) return;
					const state = await tx.doc(AgentDoc, conversation.id);
					const previous = { model: state.model ? { ...state.model } : null, thinkingLevel: state.thinkingLevel ?? null };
					await configure(tx, conversation.id, { model, thinkingLevel });
					return previous;
				}, callContext);
			}
			if (!same && !modeChange) this.#agentChanged(conversation.id, model, thinkingLevel);
			if (invocation) {
				submission = (await this.#approvals.admit(this.#harness, conversation.id, invocation.attended, invocation.settled,
					() => conversation.submit(invocation.input, callContext))).id;
			}
		} catch (error) {
			if (modeChange) {
				const { previous } = modeChange;
				try {
					await this.#harness.commit(async tx => {
						const { chats } = await tx.doc(ChatModesDoc);
						if (previous === undefined) delete chats[conversation.id];
						else chats[conversation.id] = previous;
						if (previousSelection) await configure(tx, conversation.id, previousSelection);
					}, context);
				} catch (rollback) {
					throw new AggregateError([error, rollback], "The chat could not restore its mode after admission failed.");
				}
			}
			throw error;
		} finally {
			if (mode !== undefined) this.#changingModes.delete(conversation.id);
		}
		if (modeChange) this.#agentChanged(conversation.id, model, thinkingLevel, mode);
		return { model, effort: thinkingLevel, ...(submission === undefined ? {} : { submission }) };
	}

	#agentChanged(chat: ChatId, model: ModelRef, effort: Effort, mode?: ChatMode) {
		const event: Event = {
			kind: "agent", chat, model, effort,
			...(mode === undefined ? {} : { mode }),
		};
		if (mode !== undefined) this.#log("info", "plan.mode.changed", { chat, mode });
		for (const listener of this.#listeners) {
			if (listener.chat !== chat || !listener.agent) continue;
			try {
				listener.send(event);
			} catch {
				this.#listeners.delete(listener);
			}
		}
	}

	#automatic(): Promise<ModelRef> {
		return this.#options.defaultModel?.() || choose(this.#options.models);
	}

	async #chat(request: Extract<Request, { op: "chat" }>) {
		this.#author(request.author);
		const conversation = await this.#harness.createConversation({
			ownership: { kind: "ownerless" },
			agent: { model: request.model || this.#options.model, cwd: this.#options.project, ...(this.#options.extension?.thinkingLevel ? {thinkingLevel: this.#options.extension.thinkingLevel} : {}) },
		}, context);
		return { chat: conversation.id };
	}

	async #share(request: Extract<Request, { op: "share" }>) {
		if (request.author !== this.#options.owner) {
			throw new Error("Only the owner can change sharing");
		}
		const resumed = await this.#harness.commit(async (tx) => {
			(await tx.doc(SettingsDoc)).shared = request.shared;
			return this.#builds.share(tx, request.shared);
		}, context);
		if (this.#options.resume !== false && resumed.length) void this.#builds.resume(resumed);
	}

	async #desktop(request: Extract<Request, { op: "desktop" }>) {
		if (request.author !== this.#options.owner) {
			throw new Error("Only the owner can change desktop tools access");
		}
		if (typeof request.enabled !== "boolean") throw new Error("enabled must be a boolean");
		await this.#harness.commit(async (tx) => {
			const doc = await tx.doc(SettingsDoc);
			// A legacy channel's first write would otherwise store `initial`'s unshared default.
			doc.shared = this.#settings.shared;
			doc.desktop = request.enabled;
		}, context);
	}

	async #rename(request: Extract<Request, { op: "rename" }>): Promise<Metadata> {
		if (request.author !== this.#options.owner) {
			throw new Error("Only the owner can rename the channel");
		}
		const name = validateName(request.name);
		const value = await this.#harness.commit(async (tx) => {
			const doc = await tx.doc(MetadataDoc);
			if (doc.name !== name) {
				doc.name = await this.#options.claim?.(name, true) || name;
				doc.revision++;
			}
			doc.named = true;
			return { name: doc.name, summary: doc.summary, revision: doc.revision };
		}, context);
		this.#changed(value);
		return value;
	}

	#changed(value: Metadata): void {
		if (value.revision < this.#metadata.revision) return;
		this.#metadata = value;
		try {
			this.#options.onMetadata?.(value);
		} catch (error) {
			this.#log("warn", "metadata.publish", failure(error));
		}
		this.#broadcast();
	}

	/** Every metadata event carries the whole current state, so the newest one a client saw wins. */
	#broadcast(): void {
		for (const listener of this.#listeners) {
			try {
				listener.send(this.#event(listener.chat));
			} catch {
				this.#listeners.delete(listener);
			}
		}
	}

	#event(chat: ChatId): Event {
		return { kind: "metadata", chat, ...this.#metadata, ...this.#settings };
	}

	#said(entry: EntryRecord, suppressMentions = false): void {
		const human = room.human(entry);
		if (!human) return;
		const names = suppressMentions ? [] : [...human.text.matchAll(MENTION)].map(match => match[1]!.toLowerCase());
		const mentions = [...new Set(names)];
		try {
			this.#options.onSaid?.({
				chat: entry.conversationId,
				at: human.at,
				author: human.author,
				...(mentions.length ? { mentions } : {}),
			});
		} catch (error) {
			this.#log("warn", "said.publish", failure(error));
		}
	}

	#activity(): void {
		const now = Date.now();
		if (now - this.#active < ACTIVITY_INTERVAL) return;
		this.#active = now;
		try {
			this.#options.onActivity?.(now);
		} catch (error) {
			this.#log("warn", "activity.publish", failure(error));
		}
	}

	/** Coalesces requests so each chat has at most one captioning pass running. */
	#caption(id: ConversationId): void {
		if (this.#captioning.has(id)) return void this.#captioning.set(id, true);
		this.#captioning.set(id, false);
		if (this.#closing.signal.aborted) return;
		const task = (async () => {
			do {
				this.#captioning.set(id, false);
				await this.#captionPass(id).catch((error) => {
					if (!this.#closing.signal.aborted) this.#log("warn", "caption", failure(error));
				});
			} while (this.#captioning.get(id) && !this.#closing.signal.aborted);
			this.#captioning.delete(id);
		})();
		this.#captionTasks.add(task);
		void task.finally(() => this.#captionTasks.delete(task));
	}

	async #captionPass(id: ConversationId): Promise<void> {
		const conversation = await this.#harness.conversation(id, context);
		if (!conversation) return;
		const [agent, live, view, stored] = await Promise.all([
			this.#harness.snapshot(AgentDoc, id, context),
			this.#harness.snapshot(LiveDoc, id, context),
			conversation.context(context),
			this.#harness.snapshot(CaptionsDoc, id, context),
		]);
		const captions = { ...stored?.groups };
		const recaps = { ...stored?.recaps };
		const { models } = this.#options;
		const signal = this.#closing.signal;
		let fast: Model<any> | undefined | null;
		let strong: Model<any> | undefined | null;
		for (const segment of segments(view.messages, !!live?.run)) {
			for (const [index, group] of segment.groups.entries()) {
				const key = group.calls[0]!.id;
				if (!isStale(group, captions[key])) continue;
				fast ??= await pick(models, FAST, agent?.model) || null;
				if (!fast) return;
				const previous = segment.groups.slice(Math.max(0, index - 3), index)
					.flatMap((earlier) => captions[earlier.calls[0]!.id]?.text || []);
				const { text, usage } = await caption(
					this.#options.extension?.nonTurnModels?.("caption", id) || models,
					fast,
					segment.request,
					group,
					previous,
					signal,
				);
				const value = { calls: group.calls.map((call) => call.id), text, done: group.closed };
				await this.#harness.commit(async (tx) => {
					(await tx.doc(CaptionsDoc, id)).groups[key] = value;
					await this.#builds.updateAgent(tx, id, { caption: text });
					spend(await tx.doc(UsageDoc, id), usage);
				}, context);
				captions[key] = value;
				this.#sendCaption(id, { kind: "caption", chat: id, calls: value.calls, text });
			}
			if (!segment.closed || !segment.groups.length) continue;
			const calls = segment.groups.flatMap((group) => group.calls.map((call) => call.id));
			const key = calls[0]!;
			if (recaps[key]?.calls.length === calls.length) continue;
			strong ??= await pick(models, STRONG, agent?.model)
				|| await pick(models, FAST, agent?.model) || null;
			if (!strong) return;
			const { text, usage } = await recap(this.#options.extension?.nonTurnModels?.("recap", id) || models, strong, segment, captions, signal);
			await this.#harness.commit(async (tx) => {
				(await tx.doc(CaptionsDoc, id)).recaps[key] = { calls, text };
				spend(await tx.doc(UsageDoc, id), usage);
			}, context);
			recaps[key] = { calls, text };
			this.#sendCaption(id, { kind: "recap", chat: id, calls, text });
		}
	}

	#sendCaption(chat: ConversationId, event: Event): void {
		for (const listener of this.#listeners) {
			if (listener.chat !== chat || !listener.captions) continue;
			try {
				listener.send(event);
			} catch {
				this.#listeners.delete(listener);
			}
		}
	}

	#sendActions(chat: ConversationId, event: Event): void {
		for (const listener of this.#listeners) {
			if (listener.chat !== chat || !listener.actions) continue;
			try {
				listener.reacted = true;
				listener.send(event);
			} catch {
				this.#listeners.delete(listener);
			}
		}
	}

	/** Replays the chat's active transcript, then streams. Resolves when the stream ends. */
	async #watch(request: Extract<Request, { op: "watch" }>, send: Send) {
		const conversation = await this.#conversation(request.chat);
		const stream = await watchEvents(this.#harness, conversation.id, context);
		const observedChats = new Set<ConversationId>([conversation.id]);
		type NoticeIndex = {
			entries: Map<number, ReviewNotice | BuildNotice>; submissions: Map<number, ReviewNotice | BuildNotice>;
			pendingEntries: Set<number>; pendingSubmissions: Set<number>;
		};
		const notices = new Map<number, NoticeIndex>();
		const held = new Map<number, Extract<Event, { kind: "message" }>>();
		let stopped = false;
		let refreshing = Promise.resolve();
		let queueSending = Promise.resolve();
		let releaseHeld = () => {};
		let queueChanged = async () => {};
		const loadNotices = (chats: Iterable<ConversationId>) => {
			const selected = [...chats];
			return refreshing = refreshing.catch(() => {}).then(async () => {
				if (stopped) return;
				for (const chat of selected) {
					if (stopped) return;
					observedChats.add(chat);
					const index: NoticeIndex = { entries: new Map(), submissions: new Map(), pendingEntries: new Set(), pendingSubmissions: new Set() };
					const brief = this.#builds.agent(chat);
					if (brief) {
						const record = await this.#harness.commit(tx => tx.submissionByRequest(chat, brief.requestId), context);
						if (record?.type === "input") {
							const system: BuildNotice = { kind: "neuve:build:brief", build: brief.build };
							index.submissions.set(record.id, system);
							if (record.entry !== undefined) index.entries.set(record.entry, system);
						}
					}
					const feed = await this.#harness.snapshot(ReviewFeedDoc, chat, context);
					for (const [review, notice] of Object.entries(feed?.notices ?? {})) {
						if (notice.chat !== chat) continue;
						if (notice.delivered && notice.submission !== undefined) {
							const submission = await this.#harness.submission(notice.submission as SubmissionId, context);
							const record = await submission?.status(context);
							if (record?.type !== "input" || record.conversationId !== chat) continue;
							const system: ReviewNotice = { kind: "neuve:review:terminal", review };
							index.submissions.set(record.id, system);
							if (record.entry !== undefined) index.entries.set(record.entry, system);
						} else if (!notice.delivered && notice.requestId) {
							const requestId = notice.requestId;
							const record = await this.#harness.commit(tx => tx.submissionByRequest(chat, requestId), context);
							if (record?.type !== "input") continue;
							// Hold placement until the feed records its exact submission ID and acknowledges it.
							index.pendingSubmissions.add(record.id);
							if (record.entry !== undefined) index.pendingEntries.add(record.entry);
						}
					}
					notices.set(chat, index);
				}
				if (!stopped) releaseHeld();
			});
		};
		const updates = new Set<Promise<void>>();
		const unsubscribeNotices = this.#harness.subscribeCommits(({ changes }) => {
			const chats = new Set<ConversationId>();
			for (const change of changes) if (change.type === "document" && change.record.kind === ReviewFeedDefinition.kind && change.record.scope.kind === "conversation" && observedChats.has(change.record.scope.conversationId)) chats.add(change.record.scope.conversationId);
			if (!chats.size || stopped) return;
			const update = loadNotices(chats).then(() => queueChanged());
			updates.add(update);
			void update.catch(error => { if (!stopped) this.#log("warn", "review.notice.failed", failure(error)); }).finally(() => updates.delete(update));
		});
		const stopNotices = async () => {
			stopped = true;
			unsubscribeNotices();
			held.clear();
			await Promise.allSettled([...updates, refreshing, queueSending]);
		};
		const sourceChats = (entries: readonly EntryRecord[]) => new Set(entries.filter(entry => entry.kind === "pi.user").map(entry => entry.conversationId));
		const markQueue = (messages: QueuedMessage[]): QueuedMessage[] => {
			const index = notices.get(conversation.id);
			return messages.flatMap(message => {
				if (index?.pendingSubmissions.has(message.submission)) return [];
				const system = index?.submissions.get(message.submission);
				return [system ? { ...message, system } : message];
			});
		};
		await loadNotices([conversation.id, ...sourceChats(stream.snapshot.entries)]).catch(async error => { await stopNotices(); await stream.stop(); throw error; });
		const tools = request.progress ? progress(conversation.id, send) : undefined;
		const harness = this.#harness;
		let reviews: DocumentWatch<{ cards: Record<string, ReviewCard> }> | undefined;
		let plans: DocumentWatch<PlansState> | undefined;
		let builds: DocumentWatch<BuildsState> | undefined;
		let approvals: Awaited<ReturnType<typeof watchApprovals>> | undefined;
		const stopDocs = () => Promise.all([reviews?.stop(), plans?.stop(), builds?.stop(), approvals?.stop()]);
		try {
			if (request.planComments) await this.#flushPlanDeliveries();
			await harness.commit(async tx => {
				await tx.doc(ReviewCardsDoc, conversation.id);
				if (request.plans || request.planComments) await tx.doc(PlansDoc);
				if (request.builds) await tx.doc(BuildsDoc);
			}, context);
			reviews = await harness.watchDoc(ReviewCardsDoc, conversation.id, context);
			if (request.plans || request.planComments) plans = await harness.watchDoc(PlansDoc, context);
			if (request.builds) builds = await harness.watchDoc(BuildsDoc, context);
			const sendReviews = (value: Readonly<{ cards: Record<string, ReviewCard> }> | null | undefined) =>
				send({ kind: "review-cards", chat: conversation.id, cards: value?.cards || {} });
			sendReviews(reviews?.value);
			reviews?.start(async value => { sendReviews(value); });
			if (builds) {
				const sendBuilds = (value: Readonly<BuildsState> | null) => send({
					kind: "builds", chat: conversation.id,
					builds: Object.values(value?.records ?? {}).map(({ build }) => build),
					messages: workLog(value),
				});
				sendBuilds(builds.value);
				builds.start(async value => sendBuilds(value));
			}
			if (request.approvals) approvals = await watchApprovals(harness, conversation.id, send);
			if (plans) {
				let lastPlans: string | undefined;
				let lastComments: string | undefined;
				const sendPlans = (value: Readonly<PlansState> | null | undefined) => {
					if (!request.plans) return;
					const current = value?.chats[conversation.id]?.map(({ plan }) => plan) ?? [];
					const key = JSON.stringify(current);
					if (key === lastPlans) return;
					lastPlans = key;
					send({ kind: "plans", chat: conversation.id, plans: current });
				};
				const sendPlanComments = async (value: Readonly<PlansState> | null | undefined) => {
					if (!request.planComments) return;
					const chat = conversation.id;
					const comments = await planComments(value, chat, this.#planPlacementCache(chat));
					const key = JSON.stringify(comments);
					if (key === lastComments) return;
					lastComments = key;
					send({ kind: "plan-comments", chat: conversation.id, comments });
				};
				sendPlans(plans.value);
				await sendPlanComments(plans.value);
				plans.start(async value => { sendPlans(value); await sendPlanComments(value); });
			}
		} catch (error) {
			await stopDocs();
			tools?.stop();
			await stopNotices();
			await stream.stop();
			throw error;
		}
		// Agent events expose only inbox IDs. The shared conversation mount carries their content,
		// including an atomic initial snapshot and updates when the inbox is first created.
		const view = request.queue
			? await conversation.watch(context).catch(async (error) => {
				await stopDocs();
				tools?.stop();
				await stopNotices();
				await stream.stop();
				throw error;
			})
			: undefined;
		const actions = !!request.actions;
		const listener: Listener = {
			chat: conversation.id,
			send,
			captions: !!request.captions,
			actions,
			typing: !!request.typing,
			agent: !!request.agent,
		};
		this.#listeners.add(listener);
		// Read after the stream's snapshot, so every deletion it holds is here; later ones arrive live.
		const messages = await this.#harness.snapshot(MessagesDoc, conversation.id, context);
		const deleted = messages?.deleted || {};
		// Clients that did not opt in never see deletions or edits as events, but replay still drops
		// a deleted message's content and shows an edited one's newest text.
		const forward = (event: Event) => {
			if (stopped) return;
			if (event.kind === "message") {
				const index = notices.get(event.chat);
				if (index?.pendingEntries.has(event.entry)) { held.set(event.entry, event); return; }
				const system = index?.entries.get(event.entry);
				if (system) event = { ...event, system };
				const agents = this.#builds.mentionAgents(event.entry);
				if (agents) event = { ...event, agents };
			}
			if ((event.kind === "deleted" || event.kind === "edited") && !actions) return;
			if (event.kind === "stopped" && !request.stops) return;
			if (event.kind !== "message" || !deleted[event.entry]) return send(event);
			const { images: _, files: __, edited: ___, ...rest } = event;
			send({ ...rest, text: "", deleted: true });
		};
		releaseHeld = () => {
			const messages = [...held.values()];
			held.clear();
			for (const message of messages) forward(message);
		};
		// An edit follows its message, so replay folds the newest one in and sends no earlier text.
		const edits = new Map<number, { text: string; at: number }>();
		for (const entry of stream.snapshot.entries) {
			if (EditEntry.is(entry)) edits.set(entry.data.target, entry.data);
		}
		const replay = (event: Event) => {
			if (event.kind === "edited") return;
			if (event.kind !== "message") return forward(event);
			const edited = edits.get(event.entry);
			forward(edited ? { ...event, text: edited.text, edited: edited.at } : event);
		};
		void stream.closed.then(async () => {
			await stopDocs();
			await stopNotices();
			this.#listeners.delete(listener);
			tools?.stop();
			return view?.stop();
		});
		void view?.closed.then(() => stream.stop());
		send(this.#event(conversation.id));
		for (const entry of stream.snapshot.entries) for (const event of events(entry)) replay(event);
		// A commit while the document was read has already sent its newer state.
		if (actions && !listener.reacted && Object.keys(messages?.reactions || {}).length) {
			send({ kind: "reactions", chat: conversation.id, reactions: messages!.reactions });
		}
		if (request.captions) {
			const captions = await this.#harness.snapshot(CaptionsDoc, conversation.id, context);
			for (const { calls, text } of Object.values(captions?.groups || {})) {
				send({ kind: "caption", chat: conversation.id, calls, text });
			}
			for (const { calls, text } of Object.values(captions?.recaps || {})) {
				send({ kind: "recap", chat: conversation.id, calls, text });
			}
		}
		if (stream.snapshot.run) send({ kind: "run", chat: conversation.id, state: "start" });
		tools?.snapshot(stream.snapshot.tools);
		if (view) {
			await loadNotices([conversation.id]);
			let messages = markQueue(queue(view.value));
			send({ kind: "queue", chat: conversation.id, messages });
			queueChanged = () => queueSending = queueSending.catch(() => {}).then(async () => {
				if (stopped) return;
				const before = messages;
				messages = markQueue(queue(view.value));
				const gone = await withdrawn(this.#harness, before, messages);
				if (!stopped) send({ kind: "queue", chat: conversation.id, messages, ...(gone.length ? { withdrawn: gone } : {}) });
			});
			let inbox = view.value.docs[InboxDoc.definition.kind];
			view.start(async value => {
				const next = value.docs[InboxDoc.definition.kind];
				if (next === inbox) return;
				inbox = next;
				await loadNotices([conversation.id]);
				await queueChanged();
			});
		}
		send({ kind: "live", chat: conversation.id });
		stream.start(async (batch) => {
			const chats = new Set<ConversationId>();
			for (const event of batch) {
				if (event.type === "submission") chats.add(event.record.conversationId);
				else if (event.type === "snapshot") for (const chat of sourceChats(event.entries)) chats.add(chat);
			}
			if (chats.size) await loadNotices(chats);
			for (const event of batch) {
				if (event.type === "snapshot") tools?.snapshot(event.tools);
				else tools?.update(event);
				for (const mapped of live(conversation.id, event)) forward(mapped);
			}
		});
		return {
			stop: async () => {
				await stopNotices();
				this.#listeners.delete(listener);
				tools?.stop();
				await stopDocs();
				await view?.stop();
				return stream.stop();
			},
		};
	}
}

function usage(state: Readonly<UsageState> | undefined): Usage {
	const total: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: 0,
	};
	if (!state) return total;
	for (const bucket of [state.models, state.tools]) {
		for (const value of Object.values(bucket)) {
			total.input += value.input;
			total.output += value.output;
			total.cacheRead += value.cacheRead;
			total.cacheWrite += value.cacheWrite;
			total.totalTokens += value.totalTokens;
			if (total.cost !== undefined) total.cost += value.cost.total;
		}
	}
	return total;
}

/** Submission and chat ids a request produced, so later lines can be traced back to it. */
function result(value: unknown) {
	if (!value || typeof value !== "object") {
		return typeof value === "string"
			? { result: value }
			: {};
	}
	const { submission, chat } = value as { submission?: number; chat?: number };
	return { ...(submission ? { submission } : {}), ...(chat ? { created: chat } : {}) };
}

/** Providers append their JSON error body; its message is the part a person can act on. */
function readable(error: string | undefined): string {
	if (!error) return "The provider failed the response";
	const start = error.indexOf("{");
	if (start < 0) return error;
	try {
		const body = JSON.parse(error.slice(start));
		const detail = body.message ?? body.error?.message;
		return typeof detail === "string" ? `${error.slice(0, start).trim()} ${detail}` : error;
	} catch {
		return error;
	}
}

/**
 * The transcript keeps whatever overflowed, so every later run in the chat fails the same way until
 * a person removes it; channels from before attachments were checked against the model can hold one.
 */
function failed(message: AssistantMessage): string {
	const error = readable(message.errorMessage);
	if (!isContextOverflow(message)) return error;
	const hint = "This chat no longer fits the model's context, so every run fails this way until "
		+ "you delete the message with the large attachment or pick a model with a larger context.";
	return `${error.replace(/\.?$/, ".")} ${hint}`;
}

function live(chat: ChatId, event: AgentEvent): Event[] {
	if (event.type === "message_end" || event.type === "entry_appended") return events(event.entry);
	if (event.type === "message_update") {
		const text = event.changes.flatMap((change) =>
			change.type === "text_delta" ? [change.delta] : []
		).join("");
		return text ? [{ kind: "delta", chat, text }] : [];
	}
	if (event.type === "run_start") return [{ kind: "run", chat, state: "start" }];
	if (event.type === "run_end") return [{ kind: "run", chat, state: "end" }];
	return [];
}

function events(entry: EntryRecord): Event[] {
	const chat = entry.conversationId;
	if (ReviewNewCommitsEntry.is(entry)) return [{ kind: "neuve:review:new-commits", chat, entry: entry.id, ...entry.data }];
	if (DeletionEntry.is(entry)) return [{ kind: "deleted", chat, entry: entry.data.target }];
	if (EditEntry.is(entry)) {
		const { target, text, at } = entry.data;
		return [{ kind: "edited", chat, entry: target, text, at }];
	}
	if (room.StopEntry.is(entry)) {
		const at = entry.model![0]!.timestamp;
		return [{ kind: "stopped", chat, at, author: entry.data.author }];
	}
	const human = room.human(entry);
	if (human) return [{ kind: "message", chat, entry: entry.id, ...human }];
	const message = entry.model?.[0];
	if (message?.role === "assistant") {
		const out: Event[] = [];
		const text = room.text(message);
		const at = message.timestamp;
		const model = message.model;
		const error = message.stopReason === "error";
		const stopped = message.stopReason === "aborted";
		const mode = "neuveChatMode" in message && (message.neuveChatMode === "plan" || message.neuveChatMode === "ace")
			? message.neuveChatMode
			: undefined;
		if (text || error || stopped) {
			out.push({
				kind: "reply",
				chat,
				entry: entry.id,
				at,
				model,
				text,
				...(mode === undefined ? {} : { mode }),
				...(error ? { error: failed(message) } : {}),
				...(stopped ? { stopped } : {}),
			});
		}
		for (const block of message.content) {
			if (block.type !== "toolCall") continue;
			out.push({
				kind: "tool",
				chat,
				at,
				model,
				call: block.id,
				name: block.name,
				args: block.arguments,
				// pi runs calls only from a finished reply; a cut-off one's calls were never run.
				...(error || stopped ? { unrun: true as const } : {}),
			});
		}
		return out;
	}
	if (message?.role === "toolResult") {
		const codes = ToolResultEntry.is(entry) ? entry.data.diagnostics.map(({ code }) => code) : [];
		const stopped = codes.includes("aborted");
		// pi reports this only when recovery finds an unsafe call that a previous worker started.
		const interrupted = codes.includes("interrupted");
		const handoff = codes.includes(HANDOFF);
		const images = room.images(message);
		return [{
			kind: "result",
			chat,
			call: message.toolCallId,
			error: message.isError,
			text: room.text(message),
			...(images ? { images } : {}),
			...(stopped ? { stopped: true } : {}),
			...(interrupted ? { interrupted: true } : {}),
			...(handoff ? { handoff: true } : {}),
		}];
	}
	return [];
}
