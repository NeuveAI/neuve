import type { Block } from "../../lib/block";
import type { PlanCardView } from "../../types";
import { PlanCard, planCardHeight, planCardWidth } from "../requests/plan";

/** A plan's card under the turn whose call last wrote it; its height follows its state. */
function planCard(view: PlanCardView): Block {
	return {
		key: `plan-card:${view.plan}`,
		measure: (width) => ({ height: planCardHeight(view), fit: planCardWidth(width) }),
		render: (width) => <PlanCard view={view} width={width} />,
	};
}

export { planCard };
