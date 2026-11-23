import { layout, prepare } from "@chenglou/pretext";
import { createContext, use, useState } from "react";

import type { BuildCardView } from "../../types";
import { Button } from "../../ui/button";
import { AgentLabel, AgentStateIcon } from "../agents/agents";
import { FONT } from "../blocks/constants";

import { CARD, CARD_FOOTER, CARD_HEAD, RequestCard, RequestCardBody, RequestCardFooter, RequestCardHead } from "./card";
import { planCardWidth } from "./plan";

/** What the build card's controls do; the app provides them around the timeline. */
type BuildActions = {
	/** Shows the channel's work log. */
	open: () => void;
	/** Stops every agent of the build as the person; the app reports a failure. */
	stop: (build: string) => Promise<void>;
	/** Whether this person may stop the channel's agents. */
	mayStop: boolean;
};

const BuildActionsContext = createContext<BuildActions | null>(null);
export const BuildActionsProvider = BuildActionsContext.Provider;

const NOT_ALLOWED_TO_STOP = "Only people who may ask this channel's agents can stop them";

const ROW = 22;
const ROWS_PAD_Y = 6;

const META_FONT = `400 12px ${FONT.replace(/^\S+\s+/, "")}`;

/**
 * The card's height at a given width: its head when it has one, a line per agent, and its footer
 * once it has agents. A failure's sentence wraps, measured with the timeline's own text measurer;
 * any other second line is one truncated line.
 */
export function buildCardHeight(view: BuildCardView, width: number) {
	let head = 0;
	if (view.title !== undefined) {
		// Measured a little narrower than drawn, so a rounding difference leaves space, never overlap.
		const inner = planCardWidth(width) - CARD.border * 2 - CARD.padX * 2 - 2;
		const meta = view.meta === undefined
			? 0
			: CARD.metaGap + (view.tone === "error"
				? layout(prepare(view.meta, META_FONT), Math.max(1, inner), CARD.metaLine).height
				: CARD.metaLine);
		head = CARD_HEAD - CARD.border * 2 - CARD.metaGap - CARD.metaLine + meta;
	}
	const rows = view.agents.length
		? (head ? CARD.border : 0) + ROWS_PAD_Y * 2 + view.agents.length * ROW + CARD_FOOTER
		: 0;
	return CARD.border * 2 + head + rows;
}

/** The agents one approved plan started, what each is doing, and the controls over all of them. */
export function BuildCard({ view, width }: { view: BuildCardView; width: number }) {
	let actions = use(BuildActionsContext);
	let [stopping, setStopping] = useState(false);
	let allowed = !!actions?.mayStop;
	return (
		<RequestCard
			aria-label="Build"
			tone={view.tone}
			className="overflow-hidden"
			style={{ inlineSize: planCardWidth(width), blockSize: buildCardHeight(view, width) }}
		>
			{view.title !== undefined && (
				<RequestCardHead
					title={<span className="min-w-0 truncate">{view.title}</span>}
					meta={view.meta === undefined ? undefined : <bdi>{view.meta}</bdi>}
					metaProps={{
						className: view.tone === "error" ? "text-destructive [overflow-wrap:anywhere]" : "truncate",
						...(view.tone === "error" ? {} : { title: view.meta }),
					}}
				/>
			)}
			{view.agents.length > 0 && (
				<>
					<RequestCardBody
						bare
						className={view.title === undefined ? "border-t-0" : undefined}
						style={{ paddingInline: CARD.padX, paddingBlock: ROWS_PAD_Y }}
					>
						<ul>
							{view.agents.map((agent) => (
								<li
									key={agent.chat}
									className="flex min-w-0 items-center gap-2 text-xs"
									style={{ blockSize: ROW }}
								>
									<AgentStateIcon state={agent.state} />
									<AgentLabel agent={agent} />
								</li>
							))}
						</ul>
					</RequestCardBody>
					<RequestCardFooter className="items-center justify-end gap-1.5">
						{view.stoppable && (
							<Button
								size="sm"
								variant="ghost"
								className="aria-disabled:opacity-50"
								aria-disabled={!allowed || stopping || undefined}
								title={allowed ? undefined : NOT_ALLOWED_TO_STOP}
								onClick={() => {
									if (!actions || !allowed || stopping) return;
									setStopping(true);
									void actions.stop(view.build).finally(() => setStopping(false));
								}}
							>
								Stop all
							</Button>
						)}
						<Button size="sm" variant="outline" onClick={() => actions?.open()}>
							Open work log
						</Button>
					</RequestCardFooter>
				</>
			)}
		</RequestCard>
	);
}
