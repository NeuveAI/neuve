import type { ReviewLookup, ReviewStatus, ReviewOutcome, ReviewRefusal } from "@ace/channel/review-protocol";
import type { ReviewTarget, ReviewSnapshot, NativeHandoff, PreparedReview, ReviewSubmission, NativeReviewResult, ReviewStatusQuery, ReviewFeedQuery, ReviewFeedSnapshot, ReviewRequestsReply } from "./review-protocol";
import type { ReviewOrigin, GitHubExternalRef, ExternalReviewSource } from "@neuve/records-schema";
import type { SourcePin } from "@ace/channel/planning-protocol";
export type { ReviewOrigin, GitHubExternalRef, ExternalReviewSource } from "@neuve/records-schema";
export * from "./protocol";
export type LaneAssignment = { name: string; path: string; base?: string | undefined };

/**
 * What a review of a chat's lane covers, as the host hands it to Records. The host keeps no
 * record of it: Records owns the review and refers back to the channel and chat.
 */
export type LaneReviewHandoff = {
	origin?: ReviewOrigin;
	externalSources?: ExternalReviewSource[];
	source?: SourcePin | undefined;
	channel: string;
	chat: number;
	project: string;
	cwd: string;
	lane: string;
	branch?: string | undefined;
	/** What the lane's base names: a full ref or a commit. */
	against?: string | undefined;
	/** Where the lane forked from its base, and its head, as full commits. */
	base: string;
	head: string;
};

export type PullReviewHandoff = {
	project: string; cwd: string; base: string; head: string; against: string;
	origin: Extract<ReviewOrigin, { kind: "external" }>;
	externalSources: ExternalReviewSource[];
	channel?: never; chat?: never; lane?: never; branch?: never; source?: never;
};
export type ReviewHandoff = LaneReviewHandoff | PullReviewHandoff | NativeHandoff;

/** Records' own reference to the review it accepted; the host stores nothing about it. */
export type ReviewReceipt = { reference: string; url: string; base?: string; head?: string; association?: string };
export type ReviewHistoryQuery =
	| { project: string; channel: string; chat?: number; item?: never }
	| { project: string; item: GitHubExternalRef; channel?: never; chat?: never };

export type NativeReviewCallbacks = {
	reviewPrepare?(handoff: NativeHandoff): Promise<Pick<PreparedReview, "requestId" | "config">>;
	reviewSubmit?(prepared: ReviewSubmission, validate: (current: boolean) => Promise<void>): Promise<NativeReviewResult>;
	reviewStatus?(project: string, query: ReviewStatusQuery): Promise<NativeReviewResult>;
	reviewLookup?(project: string, channel: string, query: ReviewLookup): Promise<Omit<ReviewStatus, "new_commits"> | ReviewRefusal>;
	reviewOutcome?(project: string, channel: string, query: ReviewLookup): Promise<ReviewOutcome | ReviewRefusal>;
	reviewFeed?(project: string, channel: string, query: ReviewFeedQuery): Promise<{ stamp: string; snapshot: ReviewFeedSnapshot } | null>;
	reviewRequests?(project: string, channel: string, after: number, signal: AbortSignal): Promise<ReviewRequestsReply | null>;
};

export type ExtensionRequest =
	| { op: "planning-connections" }
	| { op: "review-link"; channel: string; chat?: number }
	| { op: "reviews"; channel: string; chat?: number; project?: never; item?: never }
	| { op: "reviews"; project: string; item: GitHubExternalRef; channel?: never; chat?: never }
	| { op: "review-prepare"; channel: string; target: ReviewTarget; snapshot: ReviewSnapshot }
	| { op: "review-submit"; channel: string; prepared: ReviewSubmission }
	| { op: "review-status"; channel: string; query: ReviewStatusQuery | ReviewLookup }
	| { op: "review-outcome"; channel: string; query: ReviewLookup }
	| { op: "review-feed"; channel: string; query: ReviewFeedQuery }
	| { op: "review-requests"; channel: string; after: number }
	| { op: "review-pull"; project: string; repo: string; number: number; expectedHead?: string }
	| { op: "review"; channel: string; chat?: number; items?: GitHubExternalRef[] }
	| { op: "github-descriptor"; repo: string; number: number };
export type HostRequest = Exclude<import("./protocol").HostRequest, {op: "channel" | "create"}> | ExtensionRequest | {op: "create"; project: string; name?: string; model?: import("@ace/channel/protocol").ModelRef; cloud?: true; items?: GitHubExternalRef[]; lane?: LaneAssignment} | {op: "channel"; channel: string; request: import("@ace/channel/protocol").Request | import("@ace/channel/operations-protocol").ExtensionRequest};
export type HostEnvelope = {id: number; trace?: string} & HostRequest;

/** Legacy Neuve hosts published hello as a push; original Ace answers the hello request. */
export type HostFrame = import("./protocol").HostFrame | {hello: import("./protocol").Hello};
