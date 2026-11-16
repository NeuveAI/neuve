import { defineDoc } from "@earendil-works/pi-durable";
import type {
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

export const ReviewCardsDoc = defineDoc<{ cards: Record<string, ReviewCard> }>({
	kind: "neuve.review-cards",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ cards: {} }),
});
