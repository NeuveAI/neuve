import { ReviewRangeSchema, ReviewRefusalError, ReviewRefusalSchema } from "@ace/channel/review-protocol";
import { z } from "zod";
import { githubRef } from "./external-ref";
import { ExternalRefSchema } from "@ace/channel/external-ref";
import {
	ExternalReviewSourceSchema,
	GitHubExternalRefSchema,
	GitOid,
	ReviewOriginSchema,
	Ulid,
} from "@neuve/records-schema";
import { PlanningStateSchema, SourcePinSchema } from "@ace/channel/planning-protocol";

export const ReviewTargetSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("project-branch"),
		against: z.string().min(1).max(1000).optional(),
	}),
	z.strictObject({ kind: z.literal("lane") }),
	z.strictObject({
		kind: z.literal("pull-request"),
		repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
		number: z.int().positive(),
		expectedHead: GitOid.optional(),
	}),
]);
export type ReviewTarget = z.infer<typeof ReviewTargetSchema>;
export const ReviewSnapshotSchema = z.strictObject({
	chat: z.int().nonnegative(),
	sourceBranch: z.string().min(1).optional(),
	lane: z
		.strictObject({
			name: z.string().min(1),
			path: z.string().min(1),
			base: z.string().min(1),
		})
		.nullable(),
	planning: PlanningStateSchema,
	items: z.array(ExternalRefSchema.transform((value) => githubRef(value))).max(16),
});
export type ReviewSnapshot = z.infer<typeof ReviewSnapshotSchema>;

export const NativeHandoffSchema = z.strictObject({
	project: z.string().min(1),
	cwd: z.string().min(1),
	base: GitOid,
	head: GitOid,
	channel: z.string().min(1),
	chat: z.int().nonnegative(),
	lane: z.string().optional(),
	branch: z.string().optional(),
	sourceBranch: z.string().min(1).optional(),
	against: z.string().optional(),
	origin: ReviewOriginSchema,
	externalSources: z.array(ExternalReviewSourceSchema).max(16),
	source: SourcePinSchema.optional(),
});
export type NativeHandoff = z.infer<typeof NativeHandoffSchema>;

export const PreparedReviewSchema = z.strictObject({
	requestId: Ulid,
	target: ReviewTargetSchema,
	handoff: NativeHandoffSchema,
	config: z.json(),
});
export type PreparedReview = z.infer<typeof PreparedReviewSchema>;
export const ReviewSubmissionSchema = PreparedReviewSchema.extend({ notify: z.boolean().optional() });
export type ReviewSubmission = z.infer<typeof ReviewSubmissionSchema>;
export const ReviewFailureSchema = z.strictObject({
	kind: z.literal("failure"),
	reason: z.enum(["unavailable", "refused", "disconnected", "not-found"]),
	message: z.string().max(1000),
});
export const ReviewStatusQuerySchema = z.strictObject({
	request: Ulid,
	reference: Ulid,
	job: z.int().positive(),
	run: Ulid,
});
export type ReviewStatusQuery = z.infer<typeof ReviewStatusQuerySchema>;
/** Batches and sections of a review still being judged, as its newest packet counts them. */
const ReviewPendingSchema = z.strictObject({ batches: z.int().nonnegative(), sections: z.int().nonnegative() });
export const NativeReviewResultSchema = z.discriminatedUnion("kind", [
	ReviewFailureSchema,
	z.strictObject({
		kind: z.literal("review"),
		request: Ulid,
		reference: Ulid,
		job: z.int().positive(),
		run: Ulid,
		base: GitOid,
		head: GitOid,
		url: z.url().refine((value) => {
			const u = new URL(value);
			return (
				["http:", "https:"].includes(u.protocol) &&
				["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) &&
				!u.username &&
				!u.password
			);
		}),
		state: z.enum([
			"queued",
			"running",
			"completed",
			"timed-out",
			"failed",
			"incomplete",
		]),
		queue: z
			.enum(["waiting", "delayed", "active", "completed", "failed"])
			.nullable(),
		target: ReviewTargetSchema.optional(),
		branch: z.string().optional(),
		admission: z.strictObject({ recovered: z.boolean(), commits: z.int().nonnegative(), branch: z.string(), notify: z.boolean() }).optional(),
		recorded: z.strictObject({
			receipt: Ulid.nullable(),
			packet: Ulid.nullable(),
			complete: z.boolean(),
			gaps: z.int().nonnegative().nullable(),
			undecoded: z.int().nonnegative().nullable(),
			units: z.int().nonnegative().nullable(),
			/** What is still being judged; only for a review of the new shape (`packet.published@2`). */
			pending: ReviewPendingSchema.optional(),
			message: z.string().max(1000),
		}),
	}),
]);
export type NativeReviewResult = z.infer<typeof NativeReviewResultSchema>;

const ReviewStageSchema = z.strictObject({ done: z.int().nonnegative(), of: z.int().positive(), name: z.string().min(1) })
	.refine(value => value.done <= value.of);
const FinishedReviewSchema = z.strictObject({
	units: z.int().nonnegative(),
	byReviewLane: z.strictObject({
		humanRequired: z.int().nonnegative(), humanSuggested: z.int().nonnegative(),
		agentic: z.int().nonnegative(), static: z.int().nonnegative(),
	}),
	needJudgment: z.int().nonnegative(), complete: z.boolean(),
	gaps: z.int().nonnegative(), undecoded: z.int().nonnegative(),
	/** What is still being judged; only for a review of the new shape (`packet.published@2`). */
	pending: ReviewPendingSchema.optional(),
});
/** An exact request's projection, read after subscribing to Records, then whenever its events change it. */
export const ReviewFeedSnapshotSchema = z.strictObject({
	review: Ulid, chat: z.int().nonnegative(), sequence: z.int().nonnegative(), project: z.string().min(1), cycle: Ulid,
	stages: z.array(z.string().min(1)),
	progress: z.discriminatedUnion("phase", [
		z.strictObject({ phase: z.literal("queued") }),
		z.strictObject({ phase: z.literal("running"), stage: ReviewStageSchema.nullable() }),
		z.strictObject({ phase: z.literal("finished"), finished: FinishedReviewSchema }),
		z.strictObject({ phase: z.literal("stopped"), reason: z.string().min(1) }),
	]),
});
export type ReviewFeedSnapshot = z.infer<typeof ReviewFeedSnapshotSchema>;
export type ReviewFeedSource = {
	/** Resolve job/run from request identity. Deliver an initial snapshot and serialize later deliveries. */
	watch(review: string, receive: (snapshot: unknown) => Promise<void>, context: import("@earendil-works/chord").Context, failed?: (error: unknown) => void): Promise<() => void | Promise<void>>;
	requests?(after: number, signal: AbortSignal): Promise<ReviewRequestsReply | null>;
};


export const ReviewFeedQuerySchema = z.strictObject({ review: Ulid, after: z.string().max(64).optional() });
export type ReviewFeedQuery = z.infer<typeof ReviewFeedQuerySchema>;
export const ReviewFeedReplySchema = z.strictObject({ stamp: z.string(), snapshot: ReviewFeedSnapshotSchema });

export const ReviewRequestsReplySchema = z.strictObject({
	after: z.int().positive(),
	requests: z.array(z.strictObject({
		review: Ulid, chat: z.int().nonnegative(), at: z.int().nonnegative(),
		range: ReviewRangeSchema, baseRef: z.string().min(1), pullRequest: z.int().positive().nullable(),
	})).min(1).max(100),
});
export type ReviewRequestsReply = z.infer<typeof ReviewRequestsReplySchema>;

/** Retry transport/store outages, but never repeatedly request an absent or invalid review. */
export function reviewFeedFailure(error: unknown): { reason: "not_connected" | "not_found" | "records_mismatch"; permanent: boolean } {
	const refusal = ReviewRefusalSchema.safeParse(error);
	const reason = error instanceof ReviewRefusalError ? error.reason : refusal.success ? refusal.data.reason : undefined;
	const message = error instanceof Error ? error.message : refusal.success ? refusal.data.detail : "";
	if (reason === "records_mismatch") return { reason, permanent: true };
	// A checkout can return at the same path after a move or an external drive reconnects.
	if (/review project.*(no longer|unavailable|not found)|not inside a git repository/i.test(message))
		return { reason: "not_connected", permanent: false };
	if (reason === "not_found") return { reason, permanent: true };
	if (error instanceof z.ZodError) return { reason: "records_mismatch", permanent: true };
	if (/neuve records migrate|older than this store|store.*older than|store.*(not initialized|never initialized)/i.test(message))
		return { reason: "records_mismatch", permanent: true };
	if (/does not hold this review request|review.*not found/i.test(message))
		return { reason: "not_found", permanent: true };
	if (/Records.*(did not decode|does not belong|belongs to a different|exact.*unavailable|no owning chat|retains.*not.*(job|receipt))/i.test(message))
		return { reason: "records_mismatch", permanent: true };
	return { reason: "not_connected", permanent: false };
}
