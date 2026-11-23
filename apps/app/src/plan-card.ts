import { PLAN_TOOL, type Plan } from "@ace/channel/protocol";
import type { PlanCardView } from "@ace/ui";

import type { Tool } from "./transcript";

const TIME = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });

export function planView(plan: Plan, name: (author: string) => string): PlanCardView {
	return {
		plan: plan.id,
		hash: plan.hash,
		title: plan.title,
		state: plan.state,
		...(plan.approved ? { meta: `${name(plan.approved.by)} · ${TIME.format(plan.approved.at)}` } : {}),
	};
}

/** Each plan's card, by the call that last wrote it. */
export function planCards(plans: Plan[], name: (author: string) => string) {
	return new Map(plans.map((plan) => [plan.call, planView(plan, name)]));
}

/** The writing tool's row keeps a refusal's reason; a written plan shows in its card. */
export function planTool(tool: Tool): { name: string; summary?: string; result?: string } | undefined {
	if (tool.name !== PLAN_TOOL) return;
	return { name: "Write plan", result: tool.result?.error ? tool.result.text : "" };
}
