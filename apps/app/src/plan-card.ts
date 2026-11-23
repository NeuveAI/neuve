import { PLAN_TOOL, type Plan } from "@ace/channel/protocol";
import type { PlanCardView } from "@ace/ui";

import type { Tool } from "./transcript";

const TIME = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });

/** A plan's second line: who approved it and when, or when it was written; then its version. */
function meta(plan: Plan, name: (author: string) => string) {
	const version = plan.hash.slice(0, 8);
	return plan.approved
		? `${name(plan.approved.by)} · ${TIME.format(plan.approved.at)} · ${version}`
		: `${TIME.format(plan.written)} · ${version}`;
}

export function planView(plan: Plan, name: (author: string) => string): PlanCardView {
	return { plan: plan.id, hash: plan.hash, title: plan.title, state: plan.state, meta: meta(plan, name) };
}

/** Each plan's card, by the call that last wrote it. */
export function planCards(plans: Plan[], name: (author: string) => string) {
	return new Map(plans.map((plan) => [plan.call, planView(plan, name)]));
}

/**
 * The writing tool's row: its arguments and its result hold the whole plan, which the plan's card
 * shows instead, so the row keeps only the result's first line.
 */
export function planTool(tool: Tool): { name: string; summary?: string; result?: string } | undefined {
	if (tool.name !== PLAN_TOOL) return;
	return { name: "Write plan", result: tool.result?.text.split("\n", 1)[0] };
}
