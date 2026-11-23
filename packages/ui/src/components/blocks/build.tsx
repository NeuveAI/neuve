import type { Block } from "../../lib/block";
import type { BuildCardView } from "../../types";
import { BuildCard, buildCardHeight } from "../requests/build";
import { planCardWidth } from "../requests/plan";

/** A build's card, right after the card of the plan it builds; its height follows its agents. */
export function buildCard(view: BuildCardView): Block {
	return {
		key: `build-card:${view.build}`,
		measure: (width) => ({ height: buildCardHeight(view, width), fit: planCardWidth(width) }),
		render: (width) => <BuildCard view={view} width={width} />,
	};
}
