import type { Block } from "../../lib/block";
import type { ReviewCardView } from "../../types";
import { ReviewCard, reviewCardPlan } from "../requests/review";

/** A Neuve review card under the turn that started it; its height follows its state. */
function reviewCard(call: string, view: ReviewCardView): Block {
	return {
		// One component per start call, so its live status region announces each change.
		key: `review-card:${call}`,
		measure: (width) => ({ height: reviewCardPlan(view, width).height, fit: width }),
		render: (width) => <ReviewCard view={view} width={width} />,
	};
}

export { reviewCard };
