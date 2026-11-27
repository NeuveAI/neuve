import { layout, prepare } from "@chenglou/pretext";
import { createContext, type MouseEvent, use, useState } from "react";

import type { BuildCardView } from "../../types";
import { IconLoader } from "../../icons";
import { cn } from "../../lib/utils";
import { Button } from "../../ui/button";
import { AgentLine } from "../agents/agents";
import { FONT } from "../blocks/constants";
import { checkSummary } from "../checks/checks";
import { needPerson, PULL_ICONS } from "../session-details/session-details";

import { CARD, CARD_FOOTER, CARD_HEAD, RequestCard, RequestCardBody, RequestCardFooter, RequestCardHead, StatePill } from "./card";
import { planCardWidth } from "./plan";
import { LaneGlyph, REVIEW_LANE_COLORS, useReviewActions } from "./review";

/** What the build card's controls do; the app provides them around the timeline. */
type BuildActions = {
	/** Shows the channel's work log, at agent chat `chat` when one is given. */
	open: (chat?: number) => void;
	/** Stops every agent of the build as the person; the app reports a failure. */
	stop: (build: string) => Promise<void>;
	/** Merges the plan's pull request through the host as the person; the app reports a refusal. */
	merge: (build: string) => Promise<void>;
	/** Whether this person may stop the channel's agents and merge its plans. */
	mayStop: boolean;
};

const BuildActionsContext = createContext<BuildActions | null>(null);
export const BuildActionsProvider = BuildActionsContext.Provider;

const NOT_ALLOWED_TO_STOP = "Only people who may ask this channel's agents can stop them";
const NOT_ALLOWED_TO_MERGE = "Only people who may ask this channel's agents can merge its plans";

const ROW = 22;
const ROWS_PAD_Y = 6;

const META_FONT = `400 12px ${FONT.replace(/^\S+\s+/, "")}`;

/** The plan's rows over its agents: its pull request, then its newest Neuve review. */
function planRows(view: BuildCardView) {
	return (view.pull ? 1 : 0) + (view.review ? 1 : 0);
}

/**
 * The card's height at a given width: its head when it has one, the plan's rows, a line per agent,
 * and its footer once it has agents. A failure's sentence wraps, measured with the timeline's own
 * text measurer; any other second line is one truncated line.
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
	const plan = planRows(view);
	const rows = (plan ? (head ? CARD.border : 0) + ROWS_PAD_Y * 2 + plan * ROW : 0)
		+ (view.agents.length
			? (head || plan ? CARD.border : 0) + ROWS_PAD_Y * 2 + view.agents.length * ROW + CARD_FOOTER
			: 0);
	return CARD.border * 2 + head + rows;
}

/** The plan's pull request on one line: its state, title and number, then its checks or conflicts. */
function PullRow({ pull }: { pull: NonNullable<BuildCardView["pull"]> }) {
	const [Icon, color] = PULL_ICONS[pull.state];
	const live = pull.state === "open" || pull.state === "draft";
	const checks = live ? checkSummary(pull.checks) : undefined;
	const [Check, tone, label] = checks ?? [];
	return (
		<a
			href={pull.url}
			target="_blank"
			rel="noopener noreferrer"
			title={pull.url}
			aria-label={`Pull request #${pull.number}, ${pull.state}: ${pull.title}`}
			className="-mx-1 flex min-w-0 items-center gap-2 rounded-md squircle px-1 text-xs outline-none hover:bg-muted/60 focus-visible:bg-muted/60"
			style={{ blockSize: ROW }}
		>
			<Icon className={cn("size-4 shrink-0", color)} aria-hidden />
			<bdi className="min-w-0 truncate">{pull.title}</bdi>
			<span className="shrink-0 text-muted-foreground tabular-nums">#{pull.number}</span>
			<span className="ml-auto flex shrink-0 items-center gap-1.5 text-muted-foreground">
				{live && pull.conflicts
					? <span className="text-destructive">Conflicts with its base</span>
					: Check && (
						<>
							<Check className={cn("size-3.5 shrink-0", tone)} aria-hidden />
							<span>{label}</span>
						</>
					)}
			</span>
		</a>
	);
}

/** The plan's newest Neuve review: how many units need a person, and its batch on the desk. */
function ReviewRow({ review }: { review: NonNullable<BuildCardView["review"]> }) {
	const actions = useReviewActions();
	const count = review.humanRequired ?? 0;
	const finished = review.phase === "finished";
	const desk = review.desk;
	return (
		<div className="flex min-w-0 items-center gap-2 text-xs" style={{ blockSize: ROW }}>
			{finished
				? (
					<span className="grid size-4 shrink-0 place-items-center">
						{count > 0 ? <LaneGlyph shape="required" /> : <LaneGlyph shape="agentic" />}
					</span>
				)
				: <IconLoader className="size-4 shrink-0 text-muted-foreground motion-safe:animate-spin" aria-hidden />}
			<span className={cn("min-w-0 truncate", finished && count > 0 && "font-medium text-(--review-req-ink)")}>
				{finished ? needPerson(count) : `Neuve review ${review.phase === "queued" ? "queued" : "running"}`}
			</span>
			{review.stale && <StatePill tone="muted">Newer commits</StatePill>}
			{finished && desk && (
				<a
					href={desk}
					onClick={(event: MouseEvent) => {
						// Modified clicks keep the browser's own handling, such as a new window.
						if (!actions || event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
						event.preventDefault();
						actions.open(desk);
					}}
					className="ml-auto shrink-0 rounded-sm text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/30"
				>
					Open review desk
				</a>
			)}
		</div>
	);
}

/** The agents one approved plan started, what each is doing, and the controls over all of them. */
export function BuildCard({ view, width }: { view: BuildCardView; width: number }) {
	let actions = use(BuildActionsContext);
	let [stopping, setStopping] = useState(false);
	let [merging, setMerging] = useState(false);
	let allowed = !!actions?.mayStop;
	let plan = planRows(view) > 0;
	return (
		<RequestCard
			aria-label="Build"
			tone={view.tone}
			className={cn("overflow-hidden", REVIEW_LANE_COLORS)}
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
			{plan && (
				<RequestCardBody
					bare
					className={view.title === undefined ? "border-t-0" : undefined}
					style={{ paddingInline: CARD.padX, paddingBlock: ROWS_PAD_Y }}
				>
					{view.pull && <PullRow pull={view.pull} />}
					{view.review && <ReviewRow review={view.review} />}
				</RequestCardBody>
			)}
			{view.agents.length > 0 && (
				<>
					<RequestCardBody
						bare
						className={view.title === undefined && !plan ? "border-t-0" : undefined}
						style={{ paddingInline: CARD.padX, paddingBlock: ROWS_PAD_Y }}
					>
						<ul>
							{view.agents.map((agent) => (
								<li
									key={agent.chat}
									className="flex min-w-0 items-center gap-2 text-xs"
									style={{ blockSize: ROW }}
								>
									<AgentLine agent={agent} />
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
						<Button
							size="sm"
							variant="outline"
							onClick={() => actions?.open(view.agents.find((agent) => agent.state === "waiting")?.chat)}
						>
							Open work log
						</Button>
						{view.mergeable && (
							<Button
								size="sm"
								className="aria-disabled:opacity-50"
								// Still focusable while it merges or can't, so focus stays and the reason can be read.
								aria-disabled={!allowed || merging || undefined}
								title={allowed ? undefined : NOT_ALLOWED_TO_MERGE}
								onClick={() => {
									if (!actions || !allowed || merging) return;
									setMerging(true);
									// Merge stays pending until the build records the merge; a refusal offers it again.
									void actions.merge(view.build).catch(() => setMerging(false));
								}}
							>
								{merging ? "Merging" : "Merge"}
							</Button>
						)}
					</RequestCardFooter>
				</>
			)}
		</RequestCard>
	);
}
