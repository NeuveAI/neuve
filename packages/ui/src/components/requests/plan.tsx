import { createContext, use, useState } from "react";

import type { PlanCardView } from "../../types";
import { Button } from "../../ui/button";

import { CARD, CARD_FOOTER, CARD_HEAD, RequestCard, RequestCardFooter, RequestCardHead, StatePill } from "./card";

/** What the plan card's controls do; the app provides them around the timeline. */
export type PlanActions = {
	/** Shows the plan in the Plan tab. */
	open: (plan: string) => void;
	/** Approves this version of the plan as the person; the app reports a failure. */
	approve: (plan: string, hash: string) => Promise<void>;
	/** Whether this person may ask the channel's agents, which approving a plan needs. */
	mayApprove: boolean;
};

const PlanActionsContext = createContext<PlanActions | null>(null);
export const PlanActionsProvider = PlanActionsContext.Provider;

export const NOT_ALLOWED_TO_APPROVE = "Only people who may ask this channel's agents can approve a plan";

const MAX_WIDTH = 440;

/** A settled plan's state beside its title. */
export function PlanBadge({ state }: { state: PlanCardView["state"] }) {
	if (state === "draft") return null;
	return <StatePill tone={state === "approved" ? "success" : "muted"}>{state === "approved" ? "Approved" : "Replaced"}</StatePill>;
}

/** The card's height: its head, less the line under the title when it has none, and a footer while it is a draft. */
export function planCardHeight(view: PlanCardView) {
	return CARD_HEAD - (view.meta === undefined ? CARD.metaGap + CARD.metaLine : 0) + (view.state === "draft" ? CARD_FOOTER : 0);
}

export function planCardWidth(available: number) {
	return Math.min(available, MAX_WIDTH);
}

/** A plan the chat's agent wrote, with the person's approval while it is a draft. */
export function PlanCard({ view, width }: { view: PlanCardView; width: number }) {
	let actions = use(PlanActionsContext);
	let [approving, setApproving] = useState(false);
	let allowed = !!actions?.mayApprove;
	let draft = view.state === "draft";
	return (
		<RequestCard
			aria-label="Plan"
			className="overflow-hidden"
			style={{ inlineSize: planCardWidth(width), blockSize: planCardHeight(view) }}
		>
			<RequestCardHead
				title={
					<>
						{draft
							? <span className="min-w-0 truncate">{view.title || "Plan"}</span>
							: (
								<button
									type="button"
									className="min-w-0 truncate text-left outline-none hover:underline focus-visible:underline"
									onClick={() => actions?.open(view.plan)}
								>
									{view.title || "Plan"}
								</button>
							)}
						<PlanBadge state={view.state} />
					</>
				}
				meta={view.meta}
				metaProps={{ className: "truncate" }}
			/>
			{draft && (
				<RequestCardFooter className="items-center justify-end gap-1.5">
					<Button size="sm" variant="outline" onClick={() => actions?.open(view.plan)}>
						Open plan
					</Button>
					<Button
						size="sm"
						className="aria-disabled:opacity-50"
						aria-disabled={!allowed || approving || undefined}
						title={allowed ? undefined : NOT_ALLOWED_TO_APPROVE}
						onClick={() => {
							if (!actions || !allowed || approving) return;
							setApproving(true);
							void actions.approve(view.plan, view.hash).finally(() => setApproving(false));
						}}
					>
						{approving ? "Approving…" : "Approve and implement"}
					</Button>
				</RequestCardFooter>
			)}
		</RequestCard>
	);
}
