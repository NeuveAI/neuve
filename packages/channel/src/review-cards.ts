import { defineDoc } from "@earendil-works/pi-durable";
import type {
	ReviewAdmission,
	RefusalReason,
	ReviewRange,
	ReviewStatus,
} from "./review-protocol";

export type ReviewCard =
	| {
			kind: "refused";
			reason: RefusalReason;
			title: string;
			detail: string;
			fix: string;
	  }
	| {
			kind: "review";
			review: string;
			source: "branch" | "pull_request" | "lane";
			label: string;
			range: ReviewRange;
			recovered: boolean;
			notify: boolean;
			phase: ReviewStatus["state"] | "connection_lost";
			stage: NonNullable<ReviewStatus["stage"]> | null;
			stages: string[];
			finished: {
				units: number;
				byReviewLane: {
					humanRequired: number;
					humanSuggested: number;
					agentic: number;
					static: number;
				};
				needJudgment: number;
				complete: boolean;
				gaps: number;
				undecoded: number;
			} | null;
			stopped: { reason: string } | null;
			newCommits: { head: string } | null;
			links: { batch: string; desk: string } | null;
			updatedAt: number;
	  };

export function admittedReviewCard(
	value: Extract<ReviewAdmission, { outcome: "admitted" }>,
	source: Extract<ReviewCard, { kind: "review" }>["source"],
	comparison: string,
	at: number,
): ReviewCard {
	const baseLabel = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(comparison)
		? comparison.slice(0, 7)
		: comparison.replace(/^refs\/(heads|remotes|tags)\//, "");
	return {
		kind: "review",
		review: value.review,
		source,
		label: source === "pull_request" ? comparison : `${value.range.branch || value.range.head.slice(0, 7)} against ${baseLabel}`,
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
		updatedAt: at,
	};
}

export const ReviewCardsDoc = defineDoc<{ cards: Record<string, ReviewCard> }>({
	kind: "neuve.review-cards",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ cards: {} }),
});
