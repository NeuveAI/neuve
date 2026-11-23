import type { JSONType } from "zod";
import type { ReviewCard } from "./review-cards";
export type { ReviewCard } from "./review-cards";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { CommentThreadState } from "@neuve/review-rules/comment-thread";
import type { FileLine, FileLinesAnchor, FileLinesPlacement } from "@neuve/review-rules/file-lines-anchor";
export type { CommentThreadState } from "@neuve/review-rules/comment-thread";
export type { FileLine, FileLinesAnchor, FileLinesPlacement } from "@neuve/review-rules/file-lines-anchor";

/** The wire contract between a channel and its clients: one JSON value per line. */

export type ModelRef = { provider: string; modelId: string };
/** "off" leaves always-thinking providers at their default; otherwise disables reasoning. */
export type Effort = ModelThinkingLevel;
export type ModelOption = ModelRef & { efforts: Effort[] };

/** Cumulative usage for one chat, including compaction and usage reported by tools. */
export type Usage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	/** Estimated USD at the model catalog's prices. */
	cost?: number;
};

/** pi conversation and entry IDs. */
export type ChatId = number;
export type EntryId = number;

export type Metadata = { name: string; summary: string; revision: number };

/**
 * The end of a run a person invoked. `stopped` means a participant aborted it; `author` is the
 * participant whose input the run answered last.
 */
export type RunEnd = {
	chat: ChatId;
	at: number;
	/**
	 * The host publishes `question` when a run starts waiting on a person for a question or approval
	 * request, and `answered` when that wait ends with the run still going.
	 */
	outcome: "done" | "failed" | "stopped" | "question" | "answered";
	author: string;
	system?: ReviewNotice;
};

/**
 * A message a person or another channel's agent wrote, published for teammates' attention.
 * `mentions` are the lowercased names it @mentions, which people write as GitHub logins.
 */
export type Said = { chat: ChatId; at: number; author: string; mentions?: string[] };

/** A host-originated input that wakes the agent and renders as a Neuve system row. */
export type ReviewNotice = { kind: "neuve:review:terminal"; review: string };

export function reservedReviewRequestId(requestId: string | undefined): boolean {
	return requestId?.startsWith("neuve.review:") ?? false;
}

/** Host-only delivery state. Clients receive the system marker, never this document. */
export type ReviewFeedState = {
	positions: Record<string, number>;
	rows: Record<string, true>;
	ended?: Record<string, "not_found" | "records_mismatch">;
	notices: Record<string, { phase: "finished" | "stopped"; delivered: boolean; chat: number; requestId?: string; submission?: number }>;
};

/** A portable definition keeps the producer and channel reader on the same document contract. */
export const ReviewFeedDefinition = {
	kind: "neuve.review-feed", version: 1, scope: "conversation", history: "latest", fork: "current",
	initial: (): ReviewFeedState => ({ positions: {}, rows: {}, notices: {} }),
} as const;

// Approval requests.
type ApprovalDecision = "allow" | "deny";
export type ApprovalPath =
	| { kind: "path"; path: string }
	| { kind: "glob"; pattern: string }
	| { kind: "root" | "minimal" | "tmpdir" | "slash-tmp" }
	| { kind: "project-roots"; subpath?: string };

export type ApprovalFileChange = { path: string; diff: string } & (
	| { kind: "add" | "delete" }
	| { kind: "update"; newPath?: string }
);

/** What a person is being asked to allow. The runtime owns the mapping. */
export type ApprovalAsked = { reason?: string } & (
	| { kind: "command"; command: string; folder: string; network?: { host: string; protocol: "http" | "https" | "socks5-tcp" | "socks5-udp" } }
	| { kind: "file-change"; changes: ApprovalFileChange[] | null }
	| { kind: "wider-access"; paths: { access: "read" | "write" | "deny"; target: ApprovalPath }[]; network: boolean | null; folder?: string; globDepthLimit?: number }
	| { kind: "server-prompt"; server: string; message: string; url?: string }
	| { kind: "unrecognised" }
);

/**
 * One runtime request. A single call can raise several requests, each with its own `requestId`.
 * The record and its state are JSON objects so pi-durable can store the same union the wire uses.
 */
export type ApprovalRequest = Record<string, JSONType> & {
	requestId: string;
	callId: string;
	/** The runtime's input for the card's details. */
	input: JSONType;
	/** What Allow grants. An unrecognised request uses its raw input for display. */
	asked: ApprovalAsked;
	/** When the request opened, in milliseconds since the Unix epoch. */
	openedAt: number;
	/** An answer names the verified participant and its time in milliseconds since the Unix epoch. */
	state: Record<string, JSONType> & (
		| { kind: "open"; by?: never; at?: never; decision?: never; reason?: never }
		| { kind: "answered"; by: string; at: number; decision: ApprovalDecision; reason?: never }
		| {
			kind: "closed";
			reason: "turn-ended" | "runtime-resolved" | "stopped" | "restarted";
			by?: never;
			at?: never;
			decision?: never;
		}
		/** `by` is the person who sent a message instead of answering. */
		| { kind: "closed"; reason: "message"; by: string; at?: never; decision?: never }
	);
} & (
	| { toolName: string; work?: never }
	| { toolName?: never; work: "command" | "file-change" | "web-search" | "tool" }
);

export type ApprovalRequestsState = { requests: ApprovalRequest[] };

/** Forks start empty because each request belongs to a turn in its original chat. */
export const ApprovalRequestsDefinition = {
	kind: "neuve.approval-requests", version: 1, scope: "conversation", history: "latest", fork: "initial",
	initial: (): ApprovalRequestsState => ({ requests: [] }),
} as const;

/** An @mention in message text; the channel counts what the app links, so both use this one. */
export const MENTION = /(?<=^|\s)@([a-zA-Z0-9_-]+)/g;

export type ChannelInfo = Metadata & {
	id: string;
	/** Directory of the project checkout lanes are created from. */
	project: string;
	owner: string;
	/** Whether participants other than the owner may invoke agents. */
	shared: boolean;
	/** Channel-wide native desktop tools gate, including the owner's agents and child chats. */
	desktop: boolean;
	chats: Chat[];
	/** What a chat without a model, or one handed back with Automatic, runs next; absent without a key. */
	automatic?: ModelRef;
};

/**
 * How a chat's agent works: `plan` is plan mode, read-only by the channel's own check; `ace` is
 * the agent's ordinary mode. The ids are the composer's own mode ids.
 */
export type ChatMode = "plan" | "ace";

/**
 * A plan a planning chat's agent wrote. Its file lies in the host's storage for the channel,
 * outside the project, so clients never read it from disk: `plan` reads its text and
 * `plan-approve` approves it. A draft keeps its `id` while the agent rewrites it; once approved its
 * file never changes, and the agent's next write starts a new plan with a new `id`.
 */
export type Plan = {
	/** Names one plan file for the channel's life. */
	id: string;
	/** The SHA-256 of the file's bytes as the host last wrote them, in lowercase hex: the plan's version. */
	hash: string;
	/** The plan-writing tool call that last wrote the file; the chat shows the plan's card at it. */
	call: string;
	/** The file's first heading, without its marks; empty when it has none. */
	title: string;
	/**
	 * `replaced` once a later plan of the same chat is approved. A draft is never replaced: the
	 * agent's next write rewrites it.
	 */
	state: "draft" | "approved" | "replaced";
	/** When the host last wrote the file, in ms. */
	written: number;
	/** Who approved this version, and when, in ms; kept once the plan is replaced. */
	approved?: { by: string; at: number };
};

/** The tool by which a planning chat's agent writes its plan; the only writer of plan files. */
export const PLAN_TOOL = "plan_write";

// Comments on a plan.

/**
 * A person's comment on lines of one of the chat's plans, with the replies under it. A person
 * keeps comments and replies with the plan, then sends all of their own kept ones at once, as one
 * message to the chat's agent (`plan-comments-send`). Comments live in the chat's session state,
 * not in Records, and are never deleted once sent.
 */
export type PlanComment = {
	/** Names the comment for the channel's life. */
	id: string;
	plan: string;
	/** The verified participant who wrote it. */
	author: string;
	/** When it was kept, in ms. */
	at: number;
	text: string;
	/** Absent while the comment is kept and not yet sent; a kept comment can be edited or removed. */
	sent?: PlanCommentSend;
	/** Where the comment was made, on the version it was made on. Never changes. */
	anchor: FileLinesAnchor;
	/** Where the comment sits on the plan's current version, by the file-lines anchor rule. */
	placement: FileLinesPlacement;
	/**
	 * Where the latest send that carried this comment or a reply under it is on its way to the
	 * agent: `queued` while its message waits as a submission, `sent` once the message is placed
	 * in the chat. Absent before the first such send. `working` is not used here.
	 */
	state?: CommentThreadState;
	/** Why the latest send failed, with `failed`. */
	failure?: string;
	/** Replies under the comment, oldest first. */
	replies: PlanCommentReply[];
};

export type PlanCommentReply =
	/** A person's reply; kept like a comment, and sent with the next send of its author. */
	| { kind: "person"; id: string; author: string; at: number; text: string; sent?: PlanCommentSend }
	/** The agent's answer, written by `PLAN_COMMENT_TOOL`; `model` is the model that wrote it. */
	| { kind: "agent"; id: string; model: string; at: number; text: string };

/**
 * The send that carried a comment or reply: when it was admitted, its message's submission, and
 * the chat entry that message became once it was placed. A send that Stop withdraws before its
 * message is placed leaves its items kept again, without `sent`.
 */
export type PlanCommentSend = { at: number; submission: number; entry?: EntryId };

/**
 * What `plan-comments-send` answers: the message's submission, its entry when it was placed at
 * once, and the comments it carried. `keptReplies` names the author's replies the send held back,
 * because a reply goes only with its comment or after the comment has reached the chat, and says
 * why in a sentence for the person.
 */
export type PlanCommentsSent = {
	submission: number;
	entry?: EntryId;
	comments: string[];
	keptReplies?: { ids: string[]; reason: string };
};

/**
 * The plan-mode tool by which the agent answers one comment, with `{ comment, text }`. It writes
 * only into that comment's thread, and only for a comment on one of its own chat's plans.
 */
export const PLAN_COMMENT_TOOL = "plan_comment_answer";

// End of comments on a plan.

export type Chat = {
	id: ChatId;
	/** The chat whose agent created this one as a subagent. */
	parent?: ChatId;
	busy: boolean;
	/** The chat's stored mode; absent means `ace`. A change is announced by the `agent` event. */
	mode?: ChatMode;
	model?: ModelRef;
	effort?: Effort;
	lane?: string;
	/** The lane's worktree, present with `lane`. */
	cwd?: string;
	/** Older hosts may not report usage. */
	usage?: Usage;
	/**
	 * How full the model's context window is: the latest response's tokens, as its provider
	 * reported them. Absent before the first response.
	 */
	context?: { used: number; window: number };
};

/** A file the chat's work changed, relative to `Changes.cwd`. */
export type Change = {
	file: string;
	from?: string;
	binary: boolean;
	adds: number;
	dels: number;
	/** The worktree file's version, independent of its diff's line counts. */
	version: string;
	/**
	 * Committed on the checkout's branch since its base, or only on disk. A file can be listed
	 * once committed and again uncommitted. Older hosts omit it and list each file once against
	 * the base.
	 */
	state?: "committed" | "uncommitted" | "untracked";
};

/**
 * What a chat's work changed: its lane's commits since it forked from the lane's base, as a pull
 * request into that base would show them, then uncommitted and untracked files. A chat without a
 * lane has no committed changes.
 */
export type Changes = {
	lane?: string;
	/** The checked-out branch; absent when HEAD is detached. */
	branch?: string;
	cwd: string;
	base: string;
	head: string;
	/** What the lane's base names: a full ref such as `refs/remotes/origin/main`, or a commit. */
	against?: string;
	/**
	 * Commits on the lane's base, as last fetched, that the lane doesn't have yet; absent when
	 * none or without a lane.
	 */
	behind?: number;
	/**
	 * Commits its remote doesn't have: those past its upstream, or since its base for a lane not
	 * yet pushed. Absent when none or without a remote.
	 */
	ahead?: number;
	files: Change[];
	/** Untracked directories too large to list file by file. */
	dirs?: { dir: string; files: number }[];
};

/** GitHub views are read through the host; they are not durable channel state. */
export type GithubKind = "issues" | "prs";
export type GithubFilter = "open" | "closed" | "all";
export type GithubItem = {
	kind: GithubKind;
	number: number;
	title: string;
	url: string;
	state: "open" | "closed" | "merged" | "draft";
	author: string;
	created: string;
	updated: string;
	labels: { name: string; color: string }[];
	/** A pull request's head branch, which names the channel whose lane pushed it. */
	head?: string;
	/** A listed pull request comes from another repository. */
	fork?: boolean;
};
export type GithubList = { items: GithubItem[]; more: boolean };
export type GithubCheck = {
	name: string;
	url?: string;
	state: "pending" | "passed" | "failed" | "skipped";
};
/** The newest pull request from a branch, with its latest check results. */
export type GithubPull = GithubItem & {
	checks: GithubCheck[];
	/** The head commit GitHub has; older hosts omit it. */
	sha?: string;
	/** What reviewers decided, when the base branch requires a review or someone gave one. */
	review?: "approved" | "changes" | "required";
};
export type GithubComment = {
	id: string;
	url: string;
	author: string;
	body: string;
	created: string;
	review?: "approved" | "changes_requested" | "commented" | "dismissed";
};
export type GithubDetail = GithubItem & {
	body: string;
	comments: GithubComment[];
	pull?: {
		base: string;
		head: string;
		adds: number;
		dels: number;
		files: number;
		review: string;
	};
};
export type GithubFile = {
	file: string;
	from?: string;
	adds: number;
	dels: number;
	signature: string;
	patch?: string;
	error?: string;
};

/** An image as base64. Clients downscale before sending; see `checkAttachments` in room.ts. */
export type Image = { mimeType: string; data: string };

/** Images per message; composers refuse more before the channel would. */
export const MAX_IMAGES = 4;

/** A text file attached to a message; models read its contents beside the message's text. */
export type TextFile = { name: string; text: string };

/** A message admitted by pi but not yet placed in the chat's transcript. */
export type QueuedMessage = {
	submission: number;
	author: string;
	text: string;
	images?: Image[];
	files?: TextFile[];
	invoked: boolean;
	system?: ReviewNotice;
};

export type Answer = { choices: number[] } | { custom: string };

/** `from` is the author who reacted. */
export type Reaction = { from: string; emoji: string };

/** Each message's reactions by entry, in the order people added them. */
export type Reactions = Record<EntryId, Reaction[]>;

export type Request =
	| { op: "info" }
	| { op: "models" }
	/** Post to the chat without invoking its agent. */
	| {
		op: "say";
		chat?: ChatId;
		author: string;
		text: string;
		images?: Image[];
		files?: TextFile[];
		requestId?: string;
	}
	/** Post to the chat and invoke its agent; a busy chat takes the message as steering. */
	| {
		op: "ask";
		chat?: ChatId;
		author: string;
		text: string;
		images?: Image[];
		files?: TextFile[];
		model?: ModelRef;
		/** Without `model`, replace the chat's model with the channel's choice, as for a new chat. */
		automatic?: boolean;
		effort?: Effort;
		/**
		 * The mode the person sent this in, stored as the chat's. Absent leaves the chat's mode as it
		 * is; one equal to it changes nothing. Changing a busy chat's mode, or a mode on a message an
		 * agent authored, is refused as any `ask` is. Part of the digest that recognises a retried
		 * `requestId`, so a retry cannot carry another mode.
		 */
		mode?: ChatMode;
		requestId?: string;
		/** Whether the person's client can show approval cards, stored on the chat. Omit to keep the stored value. */
		attended?: boolean;
	}
	/**
	 * Set the model and effort the chat's next run uses, as `ask` would, without posting. Answers
	 * with the chat's resulting model and effort.
	 */
	| {
		op: "select";
		chat?: ChatId;
		author: string;
		model?: ModelRef;
		/** Without `model`, replace the chat's model with the channel's choice, as for a new chat. */
		automatic?: boolean;
		effort?: Effort;
	}
	| { op: "chat"; author: string; model?: ModelRef }
	/** Answer a pending `question` tool call: each question's chosen option indices or written answer. */
	| { op: "answer"; chat?: ChatId; call: string; author: string; answers: Answer[] }
	/** Answer every item of `call`, or of the chat's newest open question, with one written answer. */
	| { op: "answer"; chat?: ChatId; call?: string; author: string; text: string }
	/** Decline a pending `question` tool call; the agent hears that no answer was given. */
	| { op: "skip"; chat?: ChatId; call: string; author: string }
	/** The current text of one of the chat's plans, with the hash of exactly those bytes. */
	| { op: "plan"; chat?: ChatId; plan: string }
	/**
	 * Approve the version `hash` of plan `plan`, as the person read it. Answers with the approved
	 * `Plan`. Refused for an agent author, a hash the file's bytes no longer have, an unknown plan,
	 * and a replaced one; approving an approved version again changes nothing.
	 */
	| { op: "plan-approve"; chat?: ChatId; author: string; plan: string; hash: string }
	// Comments on a plan. Each refuses an agent author: agents answer with PLAN_COMMENT_TOOL.
	/**
	 * Keep a comment on lines of version `hash` of plan `plan`, as the person read it. `lines` are
	 * consecutive, 1-based, with their exact text in that version, and `quote` is inside them; the
	 * host checks both against the file's bytes and sets the section itself. Answers with the
	 * `PlanComment`. Refused for an unknown or replaced plan, a hash the plan no longer has, lines or
	 * a quote that do not match, and empty text.
	 */
	| {
		op: "plan-comment";
		chat?: ChatId;
		author: string;
		plan: string;
		hash: string;
		lines: FileLine[];
		quote: string;
		text: string;
	}
	/** Keep a reply under comment `comment`. Answers with the `PlanComment`. Refused for empty text. */
	| { op: "plan-comment-reply"; chat?: ChatId; author: string; comment: string; text: string }
	/**
	 * Replace the text of the author's own kept comment, or of its kept reply `reply`. Answers with
	 * the `PlanComment`. Refused once sent, for another person's, and for empty text.
	 */
	| { op: "plan-comment-edit"; chat?: ChatId; author: string; comment: string; reply?: string; text: string }
	/**
	 * Remove the author's own kept comment with its kept replies, or only its kept reply `reply`.
	 * Refused once sent and for another person's.
	 */
	| { op: "plan-comment-remove"; chat?: ChatId; author: string; comment: string; reply?: string }
	/**
	 * Send every comment and reply the author keeps on plan `plan`, together, as one message of the
	 * author's to the chat the plan belongs to, invoking its agent in plan mode as `ask` with mode
	 * `plan` would, and refused as that `ask` would be. The host writes the message: for each comment
	 * its id, section and lines, the quoted plan text marked as quotation, and the words; for each
	 * reply the comment it answers and the words. Mentions in it are never published. A reply goes
	 * only with its comment or once that comment has reached the chat; the others stay kept. Answers
	 * with `PlanCommentsSent`. Refused when nothing can be carried, saying why, and for a replaced
	 * plan. A retried `requestId` answers as the first send.
	 */
	| { op: "plan-comments-send"; chat?: ChatId; author: string; plan: string; requestId?: string }
	// End of comments on a plan.
	/** Add, or `remove`, the author's reaction to a human message or agent reply. */
	| { op: "react"; chat?: ChatId; author: string; entry: EntryId; emoji: string; remove?: boolean }
	/** Replace the author's own human message with a tombstone, for people and later model context. */
	| { op: "delete"; chat?: ChatId; author: string; entry: EntryId }
	/** Replace the text of the author's own human message, for people and later model context. */
	| { op: "edit"; chat?: ChatId; author: string; entry: EntryId; text: string }
	/** Stop and kill are admitted like `ask`. Older clients omit `author`; gateways stamp it anyway. */
	| { op: "stop"; chat?: ChatId; author: string }
	| { op: "kill"; author: string }
	| { op: "share"; author: string; shared: boolean }
	| { op: "desktop"; author: string; enabled: boolean }
	| { op: "rename"; author: string; name: string }
	/** Tell the chat's other watchers that the author is writing. Nothing is stored. */
	| { op: "typing"; chat?: ChatId; author: string }
	/** Resolve once the answer to a submission is placed: "done", or "unanswered" when stopped or killed. */
	| { op: "wait"; submission: number }
	| { op: "changes"; chat?: ChatId }
	/** Fetch the lane's remote base so `Changes.behind` counts what landed since; no-op otherwise. */
	| { op: "fetch"; chat?: ChatId }
	/** One listed file's unified diff; without `state`, its worktree against the base. */
	| { op: "patch"; chat?: ChatId; file: string; state?: Change["state"] }
	/** Answer one open approval request by its runtime `requestId`. The host stamps the verified author. */
	| { op: "approval-answer"; chat?: ChatId; author: string; requestId: string; decision: ApprovalDecision }
	/** Replay the chat's transcript, then stream its events until the connection closes. */
	| {
		op: "watch";
		chat?: ChatId;
		/** Include approval-requests events; older clients do not understand them. */
		approvals?: boolean;
		/** Include queue events; older clients do not understand them. */
		queue?: boolean;
		/** Include caption and recap events; older clients do not understand them. */
		captions?: boolean;
		/** Include progress events; older clients do not understand them. */
		progress?: boolean;
		/** Include deleted, edited, and reactions events; older clients do not understand them. */
		actions?: boolean;
		/** Include typing events; older clients do not understand them. */
		typing?: boolean;
		/** Include agent events; older clients do not understand them. */
		agent?: boolean;
		/** Include stopped events; older clients do not understand them. */
		stops?: boolean;
		/** Include plans events; older clients do not understand them. */
		plans?: boolean;
		/** Include plan-comments events; older clients do not understand them. */
		planComments?: boolean;
	};

export type ReviewNewCommits = { review: string; branch: string; reviewedHead: string; head: string; label: string };

export type Event =
	| { kind: "review-cards"; chat: ChatId; cards: Record<string, ReviewCard> }
	/** The chat's complete plans, oldest first, sent on attachment and on every change. */
	| { kind: "plans"; chat: ChatId; plans: Plan[] }
	/** The comments on all the chat's plans, oldest first, sent on attachment and on every change. */
	| { kind: "plan-comments"; chat: ChatId; comments: PlanComment[] }
	| ({ kind: "neuve:review:new-commits"; chat: ChatId; entry: EntryId; at: number } & ReviewNewCommits)
	/**
	 * The complete current message queue, sent on attachment and every committed change.
	 * `withdrawn` lists the invoked messages this change removed without running them, as Stop
	 * does; pi keeps no copy, so they are sent once, live, for their authors to get back.
	 */
	| { kind: "queue"; chat: ChatId; messages: QueuedMessage[]; withdrawn?: QueuedMessage[] }
	/**
	 * A human message; `invoked` when it asked the chat's agent to run. A message its author deleted
	 * replays `deleted`, without its text or images. An edited one replays its latest text, and
	 * `edited` is when it was last edited.
	 */
	| {
		kind: "message";
		chat: ChatId;
		entry: EntryId;
		at: number;
		author: string;
		text: string;
		images?: Image[];
		files?: TextFile[];
		invoked: boolean;
		system?: ReviewNotice;
		deleted?: boolean;
		edited?: number;
	}
	/** The message `entry` was deleted by its author since it was sent. */
	| { kind: "deleted"; chat: ChatId; entry: EntryId }
	/** The message `entry` was edited by its author at `at`, and now reads `text`. */
	| { kind: "edited"; chat: ChatId; entry: EntryId; text: string; at: number }
	/** The chat's complete reactions, sent on attachment when there are any and on every change. */
	| { kind: "reactions"; chat: ChatId; reactions: Reactions }
	/** `error` when the provider failed the response; `stopped` when someone stopped it. */
	| {
		kind: "reply";
		chat: ChatId;
		entry: EntryId;
		at: number;
		model: string;
		text: string;
		error?: string;
		stopped?: boolean;
		/** The mode the run that wrote this reply ran in; absent from older hosts. */
		mode?: ChatMode;
	}
	/** Streamed text of the reply being generated; the next `reply` replaces it. */
	| { kind: "delta"; chat: ChatId; text: string }
	| {
		kind: "tool";
		chat: ChatId;
		at: number;
		model: string;
		call: string;
		name: string;
		args: unknown;
		/** The reply ended while the agent was still writing this call, so it never ran. */
		unrun?: true;
	}
	/**
	 * The bounded tail of a running tool call's output, sent on attachment and as it grows, at most
	 * every half second. Each replaces the call's previous one; its `result` supersedes them all.
	 * `truncated` when earlier output is not shown. Not stored: only pi's live state backs it.
	 */
	| { kind: "progress"; chat: ChatId; call: string; text: string; truncated?: boolean }
	/**
	 * `interrupted` when the channel restarted while the tool ran, so it may have partially run.
	 * `handoff` when another channel's agent's message stopped the shell command or kept it from
	 * starting.
	 */
	| {
		kind: "result";
		chat: ChatId;
		call: string;
		error: boolean;
		text: string;
		images?: Image[];
		stopped?: boolean;
		interrupted?: boolean;
		handoff?: boolean;
	}
	/**
	 * A fast model's one-line description of a group of consecutive tool calls, sent on attachment
	 * and whenever a group is captioned again. Clients show it for whichever group holds `calls`.
	 */
	| { kind: "caption"; chat: ChatId; calls: string[]; text: string }
	/**
	 * A stronger model's summary of all the work after a human message, sent on attachment and
	 * once the work ends. Clients show it for whichever agent turn holds `calls`.
	 */
	| { kind: "recap"; chat: ChatId; calls: string[]; text: string }
	| { kind: "run"; chat: ChatId; state: "start" | "end" }
	/** `author` stopped the run, whose aborted reply came before this. */
	| { kind: "stopped"; chat: ChatId; at: number; author: string }
	/** The chat's model, effort or mode changed, so the next run uses these; `info` has the mode. */
	| {
		kind: "agent";
		chat: ChatId;
		model: ModelRef;
		effort: Effort;
		/** The chat's stored mode, sent when it changes. */
		mode?: ChatMode;
	}
	/**
	 * Channel-wide metadata, sent initially and whenever its name, summary, or settings change.
	 * `revision` covers only the name and summary. Older hosts omit `shared` and `desktop`;
	 * missing settings do not establish support for changing them.
	 */
	| ({ kind: "metadata"; chat: ChatId; shared?: boolean; desktop?: boolean } & Metadata)
	/** The replayed transcript has been sent; later events are live. */
	| { kind: "live"; chat: ChatId }
	/**
	 * The chat's complete list of open, answered, and closed approval requests, oldest opening
	 * first. Sent on attachment and every change when the watch opts in with `approvals`.
	 */
	| { kind: "approval-requests"; chat: ChatId; requests: ApprovalRequest[] }
	/** `author` is writing in the chat; live only, and stale once a few seconds pass without another. */
	| { kind: "typing"; chat: ChatId; author: string };

export type Frame =
	| { id: number; ok: true; value: unknown }
	| { id: number; ok: false; error: string }
	| { id: number; event: Event };

/** `trace` ties a request's log lines together across the processes that relay it. */
export type Envelope = { id: number; trace?: string } & Request;

/** A message one channel's agent sends to another channel. */
export type Delivery = {
	channel: string;
	chat?: ChatId;
	author: string;
	text: string;
	invoke: boolean;
	requestId: string;
};
