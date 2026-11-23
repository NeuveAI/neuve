import { createContext, use, useState } from "react";

import type { PlanCardView } from "../../types";
import { cn } from "../../lib/utils";
import { Button } from "../../ui/button";

import { CARD_FOOTER, CARD_HEAD, RequestCard, RequestCardFooter, RequestCardHead } from "./card";

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

const TONES = {
	draft: "bg-(--agent-plan)/14 text-(--agent-plan)",
	approved: "bg-success/14 text-success",
	replaced: "bg-muted text-muted-foreground",
} as const;

const LABELS = { draft: "Draft", approved: "Approved", replaced: "Replaced" } as const;

/** The plan's state as a pill beside its title. */
export function PlanBadge({ state }: { state: PlanCardView["state"] }) {
	return (
		<span
			className={cn(
				"shrink-0 rounded-full px-1.5 text-[10px] leading-4 font-normal transition-colors duration-120 motion-reduce:transition-none",
				TONES[state],
			)}
		>
			{LABELS[state]}
		</span>
	);
}

/** The card's height at a given width: its head, and a footer while it is a draft. */
export function planCardHeight(view: PlanCardView) {
	return CARD_HEAD + (view.state === "draft" ? CARD_FOOTER : 0);
}

export function planCardWidth(available: number) {
	return Math.min(available, MAX_WIDTH);
}

/** A plan the chat's agent wrote, with the person's approval while it is a draft. */
export function PlanCard({ view, width }: { view: PlanCardView; width: number }) {
	let actions = use(PlanActionsContext);
	let [approving, setApproving] = useState(false);
	let allowed = !!actions?.mayApprove;
	return (
		<RequestCard
			aria-label="Plan"
			className="overflow-hidden"
			style={{ inlineSize: planCardWidth(width), blockSize: planCardHeight(view) }}
		>
			<RequestCardHead
				title={
					<>
						<button
							type="button"
							className="min-w-0 truncate text-left outline-none hover:underline focus-visible:underline"
							onClick={() => actions?.open(view.plan)}
						>
							{view.title || "Plan"}
						</button>
						<PlanBadge state={view.state} />
					</>
				}
				meta={view.meta}
				metaProps={{ className: "truncate font-mono" }}
			/>
			{view.state === "draft" && (
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
						{approving ? "Approving…" : "Approve and build"}
					</Button>
				</RequestCardFooter>
			)}
		</RequestCard>
	);
}
