import type { Context } from "@earendil-works/chord";
import { z } from "zod";
import { ExternalRefSchema } from "./external-ref";
const GitOid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const Ulid = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
import { PlanningStateSchema } from "./planning-protocol";

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
	lane: z
		.strictObject({
			name: z.string().min(1),
			path: z.string().min(1),
			base: z.string().min(1),
		})
		.nullable(),
	planning: PlanningStateSchema,
	items: z.array(ExternalRefSchema).max(16),
});
export type ReviewSnapshot = z.infer<typeof ReviewSnapshotSchema>;

/** The adapter pins the source and configuration; channel replays them and uses the comparison name for the card label. */
export const NativeHandoffSchema = z.json();
export type NativeHandoff = z.infer<typeof NativeHandoffSchema>;

export const PreparedReviewSchema = z.strictObject({
	requestId: Ulid,
	target: ReviewTargetSchema,
	handoff: NativeHandoffSchema,
	config: z.json(),
});
export type PreparedReview = z.infer<typeof PreparedReviewSchema>;
export const ReviewSubmissionSchema = PreparedReviewSchema.extend({
	notify: z.boolean(),
});
export type ReviewSubmission = z.infer<typeof ReviewSubmissionSchema>;
export const RefusalReasonSchema = z.enum([
	"not_connected",
	"uncommitted_changes",
	"nothing_to_review",
	"no_comparison_base",
	"no_lane",
	"scope_mismatch",
	"pull_request_changed",
	"pull_request_unavailable",
	"source_moved",
	"too_many_references",
	"records_mismatch",
	"not_found",
]);
export type RefusalReason = z.infer<typeof RefusalReasonSchema>;

export const reviewRefusals = {
	not_connected: {
		title: "Neuve is not connected",
		fix: "Start the Neuve workspace on this host",
	},
	uncommitted_changes: {
		title: "Uncommitted changes",
		fix: "Commit or remove them, then ask again",
	},
	nothing_to_review: {
		title: "Nothing to review",
		fix: "Commit work first, or name another comparison base",
	},
	no_comparison_base: {
		title: "No comparison base",
		fix: "Name the comparison base",
	},
	no_lane: { title: "No lane", fix: "Ask for a branch review instead" },
	scope_mismatch: {
		title: "Scope belongs to another lane",
		fix: "Select this lane's scope",
	},
	pull_request_changed: {
		title: "Pull request changed",
		fix: "Refresh the pull request and ask again",
	},
	pull_request_unavailable: {
		title: "Pull request unavailable",
		fix: "Open the pull request's project on this host",
	},
	source_moved: {
		title: "Review source moved",
		fix: "Ask again; the new head will be pinned",
	},
	too_many_references: {
		title: "Too many linked items",
		fix: "Remove some linked items",
	},
	records_mismatch: {
		title: "Records identity mismatch",
		fix: "Report this to the owner; do not retry",
	},
	not_found: { title: "Review not found", fix: "Check the review handle" },
} satisfies Record<RefusalReason, { title: string; fix: string }>;

export const ReviewRefusalSchema = z.strictObject({
	outcome: z.literal("refused"),
	reason: RefusalReasonSchema,
	detail: z.string(),
	fix: z.string(),
});
export type ReviewRefusal = z.infer<typeof ReviewRefusalSchema>;
export function refuseReview(
	reason: RefusalReason,
	detail: string,
): ReviewRefusal {
	return {
		outcome: "refused",
		reason,
		detail: detail.slice(0, 1000),
		fix: reviewRefusals[reason].fix,
	};
}

/** Transport adapters should throw this or return a typed refusal, rather than classify prose. */
export class ReviewRefusalError extends Error {
	constructor(
		readonly reason: RefusalReason,
		detail: string,
	) {
		super(detail);
	}
}

/** Compatibility for the existing host's thrown errors until it returns typed refusals. */
export function reviewRefusal(
	cause: unknown,
	target?: ReviewTarget,
): ReviewRefusal {
	const refusal = (reason: RefusalReason, detail: string) =>
		refuseReview(
			target?.kind === "pull-request" && reason === "no_comparison_base"
				? "pull_request_unavailable"
				: reason,
			detail,
		);
	if (cause instanceof ReviewRefusalError)
		return refusal(cause.reason, cause.message);
	const typed = ReviewRefusalSchema.safeParse(cause);
	if (typed.success) return refusal(typed.data.reason, typed.data.detail);
	const detail =
		cause instanceof Error
			? cause.message
			: "The host did not return a valid review response";
	const mappings: [RegExp, RefusalReason][] = [
		[/uncommitted|untracked/i, "uncommitted_changes"],
		[
			/no commits to review|unavailable or empty|base equals head/i,
			"nothing_to_review",
		],
		[/pull request.*merge base/i, "pull_request_unavailable"],
		[/detached|comparison (base|commit)|merge base/i, "no_comparison_base"],
		[/no lane|requires its bound lane/i, "no_lane"],
		[/scope belongs to another lane/i, "scope_mismatch"],
		[/pull request changed/i, "pull_request_changed"],
		[
			/does not match this pull request|pull request.*(unavailable|missing|project)|acquire the pull request commit/i,
			"pull_request_unavailable",
		],
		[/moved.*(prepar|pinn)|source moved/i, "source_moved"],
		[/at most 16|more than 16/i, "too_many_references"],
		[/does not hold this review request|review.*not found/i, "not_found"],
		[
			/provenance|does not belong|do not belong|belongs to (another|a different)|does not match|records|run identity|external review context|different (scope|external context)/i,
			"records_mismatch",
		],
		[
			/^Neuve review (?:host|adapter|transport)\b.*(?:unavailable|disconnect|closed|timed? ?out|timeout)/i,
			"not_connected",
		],
		[
			/^(?:Native Neuve review(?: status)? is unavailable on this host|Neuve review is (?:not connected|unavailable))\b/i,
			"not_connected",
		],
		[
			/^(?:(?:Disconnected from|Not connected to) the host[.!]?$|Malformed frame from the host\b)/i,
			"not_connected",
		],
		[/\b(?:ENOENT|ENOTDIR|EACCES)\b.*\bhost\.port\b/i, "not_connected"],
		[/^The channel is hosted or moving[.!]?$/i, "not_connected"],
	];
	const reason =
		cause instanceof z.ZodError
			? "records_mismatch"
			: (mappings.find(([pattern]) => pattern.test(detail))?.[1] ??
				(target?.kind === "pull-request"
					? "pull_request_unavailable"
					: "records_mismatch"));
	return refusal(reason, detail);
}

export const ReviewBranchInputSchema = z.strictObject({
	against: z.string().min(1).max(1000).optional(),
	notify: z.boolean().optional(),
});
export const ReviewPullRequestInputSchema = z.strictObject({
	repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
	number: z.int().positive(),
	expected_head: GitOid.optional(),
	notify: z.boolean().optional(),
});
export const ReviewLaneInputSchema = z.strictObject({
	notify: z.boolean().optional(),
});
export const ReviewLookupInputSchema = z.strictObject({
	review: Ulid.optional(),
});
export const ReviewLookupSchema = ReviewLookupInputSchema.extend({
	chat: z.int().nonnegative(),
});
export type ReviewLookup = z.infer<typeof ReviewLookupSchema>;
export const ReviewRangeSchema = z.strictObject({
	branch: z.string(),
	base: GitOid,
	head: GitOid,
	commits: z.int().nonnegative(),
});
export type ReviewRange = z.infer<typeof ReviewRangeSchema>;
export const ReviewAdmissionSchema = z.discriminatedUnion("outcome", [
	z.strictObject({
		outcome: z.literal("admitted"),
		review: Ulid,
		recovered: z.boolean(),
		range: ReviewRangeSchema,
		notify: z.boolean(),
	}),
	ReviewRefusalSchema,
]);
export type ReviewAdmission = z.infer<typeof ReviewAdmissionSchema>;
export const ReviewStateSchema = z.enum([
	"queued",
	"running",
	"finished",
	"stopped",
]);
export const ReviewStatusSchema = z.strictObject({
	review: Ulid,
	state: ReviewStateSchema,
	stage: z
		.strictObject({
			done: z.int().nonnegative(),
			of: z.int().positive(),
			name: z.string(),
		})
		.optional(),
	new_commits: z.boolean(),
});
export type ReviewStatus = z.infer<typeof ReviewStatusSchema>;
export const ReviewOutcomeSchema = z.union([
	z.strictObject({
		review: Ulid,
		complete: z.boolean(),
		units: z.int().nonnegative(),
		gaps: z.int().nonnegative(),
		undecoded: z.int().nonnegative(),
	}),
	z.strictObject({
		outcome: z.literal("not_finished"),
		state: z.enum(["queued", "running", "stopped"]),
	}),
]);
export type ReviewOutcome = z.infer<typeof ReviewOutcomeSchema>;

/** The host resolves request -> exact Records job/run. No other IDs cross into tool inputs. */
export interface ReviewAdapter {
	prepare(
		target: ReviewTarget,
		snapshot: ReviewSnapshot,
		context: Context,
	): Promise<PreparedReview>;
	// notify is pinned with the receipt and persisted by the host on the admission.
	submit(
		prepared: ReviewSubmission,
		context: Context,
	): Promise<ReviewAdmission>;
	status(
		query: ReviewLookup,
		context: Context,
	): Promise<ReviewStatus | ReviewRefusal>;
	outcome(
		query: ReviewLookup,
		context: Context,
	): Promise<ReviewOutcome | ReviewRefusal>;
}
