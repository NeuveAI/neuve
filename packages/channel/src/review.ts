import { Type } from "@earendil-works/pi-ai";
import {
	defineExtension,
	defineTool,
	type Extension,
	type ToolExecutionApi,
	type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { z } from "zod";
import {
	ReviewBranchInputSchema,
	ReviewPullRequestInputSchema,
	ReviewLaneInputSchema,
	ReviewLookupInputSchema,
	ReviewSnapshotSchema,
	PreparedReviewSchema,
	ReviewAdmissionSchema,
	ReviewStatusSchema,
	ReviewOutcomeSchema,
	ReviewRefusalSchema,
	reviewRefusals,
	refuseReview,
	reviewRefusal,
	ReviewRefusalError,
	type ReviewAdapter,
	type ReviewTarget,
	type PreparedReview,
	type ReviewAdmission,
} from "./review-protocol";
import { PlanningDoc, emptyPlanningState } from "./planning";
import { LanesDoc } from "./lanes";
import { ReviewContextDoc } from "./review-context";
import { ReviewCardsDoc, type ReviewCard } from "./review-cards";
export * from "./review-protocol";
export type Review = ReviewAdapter;

export const REVIEW_CLOSING =
	"Completing a review does not approve the change. Point the person at the review card.";
export const REVIEW_NO_SUBSTITUTE = "No chat review replaces a Neuve review.";
const notify = Type.Optional(
	Type.Boolean({
		description:
			"Set only when the person asks to be told when this review finishes.",
	}),
);
const lookup = Type.Object(
	{
		review: Type.Optional(Type.String({ pattern: "^[0-9A-HJKMNP-TV-Z]{26}$" })),
	},
	{ additionalProperties: false },
);
const json = (value: unknown) =>
	z.json().parse(JSON.parse(JSON.stringify(value)));

function result(
	value: unknown,
	closing = false,
	card?: unknown,
): ToolExecutionResult {
	const refused = ReviewRefusalSchema.safeParse(value).success;
	return {
		content: [
			{
				type: "text",
				text: [
					JSON.stringify(value),
					...(refused ? [REVIEW_NO_SUBSTITUTE] : []),
					...(closing ? [REVIEW_CLOSING] : []),
				].join("\n"),
			},
		],
		isError: refused,
		...(card ? { details: json(card) } : {}),
	};
}

async function firstCard(
	api: ToolExecutionApi,
	context: Context,
	card: ReviewCard,
): Promise<ReturnType<typeof json>> {
	return api.commit(async (tx) => {
		const doc = await tx.doc(ReviewCardsDoc, api.conversationId);
		const existing = doc.cards[api.callId];
		// The host may already have advanced the card while an interrupted call replays.
		if (existing) {
			if (
				existing.kind === "review" &&
				card.kind === "review" &&
				card.recovered
			)
				existing.recovered = true;
			return json(existing);
		}
		doc.cards[api.callId] = card;
		return json(card);
	}, context);
}

const ComparisonBaseSchema = z.object({
	against: z.string().trim().min(1).optional(),
});
function cardFor(
	value: ReviewAdmission,
	target: ReviewTarget,
	prepared?: PreparedReview,
): ReviewCard {
	if (value.outcome === "refused")
		return {
			kind: "refused",
			...reviewRefusals[value.reason],
			reason: value.reason,
			detail: value.detail,
		};
	const handoff = ComparisonBaseSchema.safeParse(prepared?.handoff);
	const against =
		(target.kind === "project-branch" ? target.against : undefined) ??
		(handoff.success ? handoff.data.against : undefined) ??
		value.range.base;
	const baseLabel = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(against)
		? against.slice(0, 7)
		: against.replace(/^refs\/(heads|remotes|tags)\//, "");
	return {
		kind: "review",
		review: value.review,
		source:
			target.kind === "project-branch"
				? "branch"
				: target.kind === "pull-request"
					? "pull_request"
					: "lane",
		label:
			target.kind === "pull-request"
				? `${target.repo}#${target.number}`
				: `${value.range.branch} against ${baseLabel}`,
		range: value.range,
		recovered: value.recovered,
		notify: value.notify,
		phase: "queued",
		stage: null,
		stages: [],
		finished: null,
		stopped: null,
		newCommits: null,
		links: null,
		updatedAt: Date.now(),
	};
}

export function review(adapter?: Review): Extension {
	async function start(
		target: ReviewTarget,
		notify: boolean,
		api: ToolExecutionApi,
		context: Context,
	) {
		let value: ReviewAdmission;
		let prepared: PreparedReview | undefined;
		try {
			const previous = (
				await api.snapshot(ReviewCardsDoc, api.conversationId, context)
			)?.cards[api.callId];
			if (previous?.kind === "refused")
				return result(
					refuseReview(previous.reason, previous.detail),
					false,
					previous,
				);
			const accepted = await api.memo("neuve-review-result", context);
			if (accepted) {
				const savedPrepared = await api.memo("neuve-review-prepared", context);
				if (savedPrepared) prepared = PreparedReviewSchema.parse(savedPrepared);
				const saved = ReviewAdmissionSchema.parse(accepted);
				value =
					saved.outcome === "admitted" ? { ...saved, recovered: true } : saved;
			} else {
				if (!adapter)
					throw new ReviewRefusalError(
						"not_connected",
						"Neuve review is not connected on this host",
					);
				const saved = await api.memo("neuve-review-prepared", context);
				if (saved) prepared = PreparedReviewSchema.parse(saved);
				else {
					const agent = await api.agent(context);
					const snapshot = await api.commit(async (tx) => {
						const lanes = await tx.doc(LanesDoc);
						const match = Object.entries(lanes.lanes).find(
							([, lane]) => lane.path === agent.cwd,
						);
						const items =
							(await tx.doc(ReviewContextDoc)).chats[
								String(api.conversationId)
							] || [];
						if (items.length > 16)
							throw new ReviewRefusalError(
								"too_many_references",
								"A review can reference at most 16 external items.",
							);
						return ReviewSnapshotSchema.parse({
							chat: api.conversationId,
							lane: match?.[1].base
								? { name: match[0], path: match[1].path, base: match[1].base }
								: null,
							planning:
								(await tx.doc(PlanningDoc)).chats[String(api.conversationId)] ||
								emptyPlanningState(),
							items,
						});
					}, context);
					if (target.kind === "lane") {
						if (!snapshot.lane)
							throw new ReviewRefusalError(
								"no_lane",
								"This chat has no lane to review",
							);
						if (
							snapshot.planning.selection &&
							snapshot.planning.selection.lane !== snapshot.lane.name
						)
							throw new ReviewRefusalError(
								"scope_mismatch",
								"The selected Linear scope belongs to another lane",
							);
					}
					prepared = PreparedReviewSchema.parse(
						await adapter.prepare(target, snapshot, context),
					);
					if (JSON.stringify(prepared.target) !== JSON.stringify(target))
						throw new ReviewRefusalError(
							"records_mismatch",
							"The prepared source does not match the requested target",
						);
					prepared = PreparedReviewSchema.parse(
						await api.memo("neuve-review-prepared", json(prepared), context),
					);
				}
				value = ReviewAdmissionSchema.parse(
					await adapter.submit({ ...prepared, notify }, context),
				);
				if (value.outcome === "admitted") {
					if (value.review !== prepared.requestId || value.notify !== notify)
						throw new ReviewRefusalError(
							"records_mismatch",
							"The admission does not match the pinned request or notification preference",
						);
					value = ReviewAdmissionSchema.parse(
						await api.memo("neuve-review-result", json(value), context),
					);
				}
			}
		} catch (cause) {
			if (context.abortSignal?.aborted) throw cause;
			value = reviewRefusal(cause, target);
		}
		if (value.outcome === "refused") value = reviewRefusal(value, target);
		const card = await firstCard(
			api,
			context,
			cardFor(value, target, prepared),
		);
		return result(value, false, card);
	}

	async function read(
		kind: "status" | "outcome",
		args: unknown,
		api: ToolExecutionApi,
		context: Context,
	) {
		const input = ReviewLookupInputSchema.parse(args);
		try {
			if (!adapter)
				throw new ReviewRefusalError(
					"not_connected",
					"Neuve review is not connected on this host",
				);
			const query = { ...input, chat: api.conversationId };
			const raw = await adapter[kind](query, context);
			const refused = ReviewRefusalSchema.safeParse(raw);
			if (refused.success)
				return result(
					refuseReview(refused.data.reason, refused.data.detail),
					true,
				);
			const value =
				kind === "status"
					? ReviewStatusSchema.parse(raw)
					: ReviewOutcomeSchema.parse(raw);
			if (input.review && "review" in value && value.review !== input.review)
				throw new ReviewRefusalError(
					"records_mismatch",
					"The host returned another review's record",
				);
			return result(value, true);
		} catch (cause) {
			if (context.abortSignal?.aborted) throw cause;
			return result(reviewRefusal(cause), true);
		}
	}

	return defineExtension({
		name: "neuve-review",
		sections: [
			{
				key: "neuve-review",
				render: () =>
					"When asked to review code, changes, a branch or a pull request, you MUST use the Neuve review tools. Never substitute a chat review for a Neuve review.",
			},
		],
		tools: [
			defineTool({
				name: "neuve_review_branch",
				prepareArguments: (args) => ReviewBranchInputSchema.parse(args),
				description:
					"Start a native Neuve review of the connected project's current branch when asked to review code, changes or a branch. Omit against for the default comparison base. Set notify only when the person asks to be told when it finishes. The host updates the review card; do not poll.",
				parameters: Type.Object(
					{
						against: Type.Optional(
							Type.String({ minLength: 1, maxLength: 1000 }),
						),
						notify,
					},
					{ additionalProperties: false },
				),
				replay: "safe",
				execute: async (args, api, context) => {
					const { against, notify } = ReviewBranchInputSchema.parse(args);
					return start(
						{ kind: "project-branch", ...(against ? { against } : {}) },
						notify ?? false,
						api,
						context,
					);
				},
			}),
			defineTool({
				name: "neuve_review_pull_request",
				prepareArguments: (args) => ReviewPullRequestInputSchema.parse(args),
				description:
					"Start a native Neuve review when asked to review a named pull request. Supply its owner/repository and number; expected_head pins the head shown to the person. Set notify only when the person asks to be told when it finishes. The host updates the review card; do not poll.",
				parameters: Type.Object(
					{
						repo: Type.String({ pattern: "^[\\w.-]+/[\\w.-]+$" }),
						number: Type.Integer({ minimum: 1 }),
						expected_head: Type.Optional(
							Type.String({ pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$" }),
						),
						notify,
					},
					{ additionalProperties: false },
				),
				replay: "safe",
				execute: async (args, api, context) => {
					const { repo, number, expected_head, notify } =
						ReviewPullRequestInputSchema.parse(args);
					return start(
						{
							kind: "pull-request",
							repo,
							number,
							...(expected_head ? { expectedHead: expected_head } : {}),
						},
						notify ?? false,
						api,
						context,
					);
				},
			}),
			defineTool({
				name: "neuve_review_lane",
				prepareArguments: (args) => ReviewLaneInputSchema.parse(args),
				description:
					"Start a native Neuve review only when the person explicitly asks to review this chat's lane, meaning its own Git worktree. Never create a lane to request review. Neuve's responsibility category is always called a review lane. Set notify only when asked to be told when it finishes. The host updates the review card; do not poll.",
				parameters: Type.Object({ notify }, { additionalProperties: false }),
				replay: "safe",
				execute: async (args, api, context) =>
					start(
						{ kind: "lane" },
						ReviewLaneInputSchema.parse(args).notify ?? false,
						api,
						context,
					),
			}),
			defineTool({
				name: "neuve_review_status",
				prepareArguments: (args) => ReviewLookupInputSchema.parse(args),
				description:
					"Read where a requested Neuve review is when the person asks for progress. Omit review for this chat's latest review. Returns status without findings. The host updates the review card; do not poll.",
				parameters: lookup,
				replay: "safe",
				execute: (args, api, context) => read("status", args, api, context),
			}),
			defineTool({
				name: "neuve_review_outcome",
				prepareArguments: (args) => ReviewLookupInputSchema.parse(args),
				description:
					"Read what Records recorded when the person asks for a Neuve review's result. Omit review for this chat's latest review. Point the person at the review card. Completing a review does not approve the change.",
				parameters: lookup,
				replay: "safe",
				execute: (args, api, context) => read("outcome", args, api, context),
			}),
		],
	});
}
