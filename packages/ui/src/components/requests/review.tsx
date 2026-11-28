import { layout, measureNaturalWidth, prepare, prepareWithSegments } from "@chenglou/pretext";
import { createContext, type MouseEvent, use, useState } from "react";

import type { ReviewCardView } from "../../types";
import { buttonVariants } from "../../lib/button-variants";
import { cn } from "../../lib/utils";
import { IconLoader } from "../../icons";
import { Button } from "../../ui/button";
import { FONT } from "../blocks/constants";

import { CARD, CARD_HEAD, RequestCard, RequestCardBody, RequestCardFooter, RequestCardHead } from "./card";

type Review = Extract<ReviewCardView, { kind: "review" }>;

/** What the card's links and buttons do; the app provides them around the timeline. */
export type ReviewActions = {
	/** Opens an app-relative review route in the Review tab. */
	open: (path: string) => void;
	/** Asks the agent, as the person, for a new review of the same source. */
	again: (review: string, label: string) => Promise<void>;
	/** Whether this person may ask the agent; asking is refused otherwise. */
	mayAsk: boolean;
};

const ReviewActionsContext = createContext<ReviewActions | null>(null);
export const ReviewActionsProvider = ReviewActionsContext.Provider;
export function useReviewActions() {
	return use(ReviewActionsContext);
}

// -- Layout --
//
// The timeline places every block before it mounts, so the card's height is worked out here from
// its content and width alone. Each line has a fixed box; the few lines that wrap are measured with
// the timeline's own text measurer and given exactly that height.

const MAX_WIDTH = 600;
const BODY_GAP = 12;
const LINE = 16;
const TEXT_LINE = 20;
const STAGE_BAR = 3;
const STAGE_GAP = 6;
const LANE_BAR = 6;
const LANE_GAP = 8;
const LANE_ROW_GAP = 4;
const FOOT_GAP = 8;
const BUTTON = 24;
const BUTTON_PAD_X = 8;
const BUTTON_GAP = 6;
const BUTTON_ROW_GAP = 6;
// Room per button for rounding and the outline's shadow.
const BUTTON_SLACK = 4;
// Room left over so a slightly wider rendering truncates the status instead of wrapping it.
const SLACK = 16;
const CELL_GAP = 12;

const FAMILY = FONT.replace(/^\S+\s+/, "");
const font = (size: number, weight = 400) => `${weight} ${size}px ${FAMILY}`;

function lines(text: string, size: number, lineHeight: number, width: number, weight?: number) {
	// Measured a little narrower than drawn, so a rounding difference leaves space, never overlap.
	return layout(prepare(text, font(size, weight)), Math.max(1, width - 2), lineHeight).height;
}

function natural(text: string, size: number, weight?: number) {
	return measureNaturalWidth(prepareWithSegments(text, font(size, weight)));
}

const NO_APPROVAL = "Completing a review does not approve the change.";
const NO_SUBSTITUTE = "No chat review replaces a Neuve review.";
export const NOT_ALLOWED = "Only people who may ask this channel's agent can request a review";

type Action =
	| { kind: "link"; label: string; path: string | null; primary?: boolean }
	| { kind: "again"; label: string; review: string; source: string; primary?: boolean };

type Item =
	| { kind: "working"; text: string }
	| { kind: "stages"; stages: string[]; done: number; live?: number; halt?: number; dim?: boolean }
	| { kind: "judgment"; count: number }
	| { kind: "lanes"; lanes: Review["finished"] & {}; columns: 1 | 2 | 4 }
	| { kind: "fact"; text: string }
	| { kind: "text"; text: string; tone?: "strong" | "muted"; height: number };

type Footer = {
	status?: string;
	busy?: boolean;
	/** The actions in order, split into rows that each fit the card's width. */
	rows: Action[][];
	/** Status and actions share one row when both fit. */
	inline: boolean;
	statusHeight: number;
	height: number;
};

type Plan = {
	width: number;
	tone?: "error";
	title: string;
	badge?: string;
	meta: string;
	/** The end of the meta line, kept whole while `meta` truncates. */
	metaTail?: string;
	metaTone?: "error";
	mono: boolean;
	items: Item[];
	footer?: Footer;
	/** What a screen reader hears when the card changes. */
	announce: string;
	height: number;
};

const plural = (count: number, one: string, many = `${one}s`) =>
	`${count} ${count === 1 ? one : many}`;

function short(head: string) {
	return head.slice(0, 7);
}

const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** The base as people name it: the name the review tools put in the label, else a short commit. */
function base(card: Review) {
	let named = `${card.range.branch} against `;
	let name = card.source !== "pull_request" && card.label.startsWith(named)
		? card.label.slice(named.length)
		: "";
	name ||= card.range.base;
	return OID.test(name) ? short(name) : name;
}

/** The range line: the branch truncates first, so the range and its commit count stay whole. */
function range(card: Review): Pick<Plan, "meta" | "metaTail"> {
	let name = card.source === "pull_request" ? card.label : card.range.branch;
	return {
		meta: name,
		metaTail: `· ${base(card)}..${short(card.range.head)} · ${plural(card.range.commits, "commit")}`,
	};
}

function lanesHeight(columns: number) {
	let rows = 4 / columns;
	return LANE_BAR + LANE_GAP + rows * LINE + (rows - 1) * LANE_ROW_GAP;
}

/** As many legend columns as fit untruncated: one row, two columns, or one. */
function laneColumns(lanes: Review["finished"] & {}, inner: number): 1 | 2 | 4 {
	// Glyph, two 6px gaps, label, count, and a little room for rounding.
	let cells = LANES.map((lane) =>
		10 + 12 + natural(lane.label, 12) + natural(String(lanes.byReviewLane[lane.key]), 12, 500) + 4
	);
	if (cells.reduce((sum, cell) => sum + cell, 0) + CELL_GAP * 3 <= inner) return 4;
	if (Math.max(...cells) * 2 + CELL_GAP <= inner) return 2;
	return 1;
}

function itemHeight(item: Item) {
	switch (item.kind) {
		case "working":
		case "fact":
			return LINE;
		case "stages":
			return STAGE_BAR + STAGE_GAP + LINE;
		case "judgment":
			return TEXT_LINE;
		case "lanes":
			return lanesHeight(item.columns);
		case "text":
			return item.height;
	}
}

function footer(
	inner: number,
	actions: Action[],
	status?: string,
	busy?: boolean,
): Footer | undefined {
	if (!actions.length && !status) return;
	// Buttons fill rows in order and start a new row when the next one would not fit, so none is
	// ever cut off; a button wider than the card on its own truncates its label.
	let rows: Action[][] = [];
	let used = 0;
	let widest = 0;
	for (let action of actions) {
		let width = natural(action.label, 12, 500) + BUTTON_PAD_X * 2 + BUTTON_SLACK;
		let row = rows.at(-1);
		if (row && used + BUTTON_GAP + width <= inner) {
			row.push(action);
			used += BUTTON_GAP + width;
		} else {
			rows.push([action]);
			used = width;
		}
		widest = Math.max(widest, used);
	}
	let text = status ? natural(status, 12) + (busy ? 18 : 0) : 0;
	// Actions alone sit in rows; a status alone wraps; both share a row only when they fit in one.
	let inline = !status || (rows.length === 1 && text + FOOT_GAP + widest + SLACK <= inner);
	let statusHeight = status && !inline ? lines(status, 12, LINE, inner) : LINE;
	let buttons = rows.length * BUTTON + Math.max(0, rows.length - 1) * BUTTON_ROW_GAP;
	let body = !rows.length
		? statusHeight
		: inline
		? buttons
		: statusHeight + FOOT_GAP + buttons;
	return {
		status,
		busy,
		rows,
		inline,
		statusHeight,
		height: CARD.border + CARD.footPadY * 2 + body,
	};
}

function stagesItem(
	card: Review,
	done: number,
	{ live, halt, dim }: { live?: number; halt?: number; dim?: boolean } = {},
): Item[] {
	if (!card.stages.length) return [];
	return [{ kind: "stages", stages: card.stages, done, live, halt, dim }];
}

/** The card's content and exact height at a given content width. */
export function reviewCardPlan(view: ReviewCardView, available: number): Plan {
	let width = Math.min(available, MAX_WIDTH);
	let inner = width - CARD.border * 2 - CARD.padX * 2;
	let text = (value: string, tone?: "strong" | "muted"): Item => ({
		kind: "text",
		text: value,
		tone,
		height: lines(value, 14, TEXT_LINE, inner, tone === "strong" ? 500 : 400),
	});
	let plan: Omit<Plan, "height" | "width">;

	if (view.kind === "asked") {
		plan = {
			title: "Neuve review",
			meta: view.label,
			mono: false,
			items: [{ kind: "working", text: "Pinning the range and checking it can be reviewed" }],
			announce: "Starting a Neuve review",
		};
	} else if (view.kind === "refused") {
		plan = {
			tone: "error",
			title: view.title,
			meta: "Neuve review didn't start",
			metaTone: "error",
			mono: false,
			items: [text(view.detail, "muted"), text(view.fix, "strong")],
			footer: footer(inner, [], NO_SUBSTITUTE),
			announce: `Neuve review didn't start: ${view.title}. ${view.fix}`,
		};
	} else {
		let card = view;
		let stage = card.stage;
		let of = stage?.of || card.stages.length;
		let meta = range(card);
		let recovered = card.recovered
			? "Recovered after a restart: the same request continues."
			: undefined;
		switch (card.phase) {
			case "queued":
				plan = {
					title: "Neuve review · queued",
					...meta,
					mono: true,
					items: stagesItem(card, 0),
					footer: footer(inner, [], recovered ?? "Waiting for Neuve to start it."),
					announce: "Neuve review queued",
				};
				break;
			case "running": {
				let title = stage
					? `Neuve review · stage ${stage.done + 1} of ${of}: ${stage.name}`
					: "Neuve review · running";
				plan = {
					title,
					...meta,
					mono: true,
					items: stagesItem(card, stage?.done ?? 0, { live: stage?.done ?? 0 }),
					footer: footer(inner, [], recovered),
					announce: title,
				};
				break;
			}
			case "finished": {
				let finished = card.finished;
				let actions: Action[] = card.links
					? [
						{ kind: "link", label: "Open batch overview", path: card.links.batch },
						{ kind: "link", label: "Open review desk", path: card.links.desk },
					]
					: [];
				// The batch overview stays first; with newer commits, the new review is the primary.
				if (card.newCommits) {
					actions.push({
						kind: "again",
						label: "Request a new review",
						review: card.review,
						source: card.label,
						primary: true,
					});
				} else if (actions[0]) actions[0].primary = true;
				let items: Item[] = [...stagesItem(card, card.stages.length)];
				if (finished) {
					items.push(
						{ kind: "judgment", count: finished.needJudgment },
						{ kind: "lanes", lanes: finished, columns: laneColumns(finished, inner) },
						{
							kind: "fact",
							text: finished.complete
								? `Complete · ${finished.gaps ? plural(finished.gaps, "gap") : "no gaps"}`
								: [
									"Incomplete",
									plural(finished.gaps, "gap"),
									...(finished.undecoded ? [`${finished.undecoded} undecoded`] : []),
								].join(" · "),
						},
					);
				}
				if (card.newCommits) {
					items.push(
						text(
							`This review covers ${short(card.range.head)}; the branch is now at ${
								short(card.newCommits.head)
							}.`,
							"muted",
						),
					);
				}
				let judgment = finished?.needJudgment
					? `${finished.needJudgment} need your judgment`
					: "nothing needs your judgment";
				plan = {
					title: "Neuve review · finished",
					badge: card.newCommits ? "Newer commits" : undefined,
					...meta,
					mono: true,
					items,
					footer: footer(inner, actions, NO_APPROVAL),
					announce: `Neuve review finished; ${judgment}. ${NO_APPROVAL}`,
				};
				break;
			}
			case "stopped": {
				let title = stage
					? `Neuve review · stopped during ${stage.name}`
					: "Neuve review · stopped";
				plan = {
					title,
					...meta,
					mono: true,
					items: [
						...stagesItem(card, stage?.done ?? 0, { halt: stage?.done }),
						...(card.stopped ? [text(card.stopped.reason, "muted")] : []),
					],
					footer: footer(
						inner,
						card.links
							? [{ kind: "link", label: "Open the cycle", path: card.links.batch }]
							: [],
					),
					announce: `${title}. ${card.stopped?.reason ?? ""}`.trim(),
				};
				break;
			}
			case "connection_lost": {
				plan = {
					title: stage ? `Neuve review · stage ${stage.done + 1} of ${of}` : "Neuve review",
					...meta,
					mono: true,
					items: stagesItem(card, stage?.done ?? 0, { dim: true }),
					footer: footer(inner, [], "Reconnecting to Neuve; last known state shown", true),
					announce: "Connection to Neuve lost; reconnecting",
				};
				break;
			}
		}
	}

	let height = CARD_HEAD;
	if (plan.items.length) {
		height += CARD.border + CARD.bodyPadY * 2
			+ plan.items.reduce((sum, item) => sum + itemHeight(item), 0)
			+ (plan.items.length - 1) * BODY_GAP;
	}
	if (plan.footer) height += plan.footer.height;
	return { ...plan, width, height };
}

// -- Rendering --

/** Neuve's review lane colours, when its theme provides them, for anything that draws a lane. */
export const REVIEW_LANE_COLORS = cn(
	"[--review-req:var(--nv-req,#c63d8e)] [--review-req-ink:var(--nv-req-fg,#ac2973)] [--review-sug:var(--nv-sug,#ad7c1c)] [--review-agt:var(--nv-agt,#148252)] [--review-sta:var(--nv-sta,#78736a)] [--review-live:var(--nv-gold,#b8860b)]",
	"dark:[--review-req:var(--nv-req,#e680c5)] dark:[--review-req-ink:var(--nv-req-fg,#efb1dc)] dark:[--review-sug:var(--nv-sug,#e2ca5e)] dark:[--review-agt:var(--nv-agt,#44be82)] dark:[--review-sta:var(--nv-sta,#9a9488)] dark:[--review-live:var(--nv-gold,#e2ca5e)]",
);

const LANES = [
	{ key: "humanRequired", label: "Human-required", color: "var(--review-req)", shape: "required" },
	{ key: "humanSuggested", label: "Human-suggested", color: "var(--review-sug)", shape: "suggested" },
	{ key: "agentic", label: "Agentic", color: "var(--review-agt)", shape: "agentic" },
	{ key: "static", label: "Static automation", color: "var(--review-sta)", shape: "static" },
] as const;

/** Lane glyphs follow Neuve's: shape carries the review lane, so colour is never the only signal. */
export function LaneGlyph({ shape }: { shape: (typeof LANES)[number]["shape"] }) {
	return (
		<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" className="shrink-0">
			{shape === "required" && <path d="M5 .8 9.2 5 5 9.2 .8 5z" fill="var(--review-req)" />}
			{shape === "suggested" && (
				<>
					<path d="M5 .8 9.2 5 5 9.2 .8 5z" fill="none" stroke="var(--review-sug)" strokeWidth="1.4" />
					<path d="M5 .8V9.2L.8 5z" fill="var(--review-sug)" />
				</>
			)}
			{shape === "agentic" && (
				<circle cx="5" cy="5" r="3.9" fill="none" stroke="var(--review-agt)" strokeWidth="1.6" />
			)}
			{shape === "static" && (
				<rect
					x="1.2"
					y="1.2"
					width="7.6"
					height="7.6"
					rx="1.5"
					fill="none"
					stroke="var(--review-sta)"
					strokeWidth="1.5"
				/>
			)}
		</svg>
	);
}

function Stages({ item }: { item: Extract<Item, { kind: "stages" }> }) {
	return (
		<ol
			aria-label="Review stages"
			className={cn("grid gap-1", item.dim && "opacity-60")}
			style={{ gridTemplateColumns: `repeat(${item.stages.length}, minmax(0, 1fr))` }}
		>
			{item.stages.map((name, index) => {
				let done = index < item.done;
				let live = index === item.live;
				let halt = index === item.halt;
				return (
					<li
						key={`${index}:${name}`}
						aria-current={live ? "step" : undefined}
						className="flex min-w-0 flex-col"
						style={{ gap: STAGE_GAP }}
					>
						<span
							className={cn(
								"rounded-full",
								done
									? "bg-foreground"
									: live
									? "bg-(--review-live) motion-safe:animate-pulse"
									: halt
									? "bg-destructive"
									: "bg-border",
							)}
							style={{ blockSize: STAGE_BAR }}
						/>
						<span
							className={cn(
								"truncate text-[11px] leading-4",
								done || live || halt ? "text-foreground" : "text-muted-foreground",
							)}
						>
							{name}
							<span className="sr-only">
								{done ? ", done" : live ? ", in progress" : halt ? ", stopped here" : ""}
							</span>
						</span>
					</li>
				);
			})}
		</ol>
	);
}

function Lanes({ item }: { item: Extract<Item, { kind: "lanes" }> }) {
	let { lanes, columns } = item;
	let total = lanes.units || 1;
	return (
		<div className="flex flex-col" style={{ gap: LANE_GAP }}>
			<div aria-hidden="true" className="flex overflow-hidden rounded-full" style={{ blockSize: LANE_BAR, gap: 2 }}>
				{LANES.map((lane) =>
					lanes.byReviewLane[lane.key] > 0 && (
						<span
							key={lane.key}
							className="rounded-full"
							style={{ flex: lanes.byReviewLane[lane.key] / total, background: lane.color }}
						/>
					)
				)}
			</div>
			<dl
				aria-label={`${plural(lanes.units, "review unit")} by review lane`}
				className="grid text-xs"
				style={{
					rowGap: LANE_ROW_GAP,
					columnGap: CELL_GAP,
					gridTemplateColumns: columns === 4
						? "repeat(4, max-content)"
						: `repeat(${columns}, minmax(0, 1fr))`,
				}}
			>
				{LANES.map((lane) => (
					<div key={lane.key} className="flex min-w-0 items-center gap-1.5 leading-4">
						<LaneGlyph shape={lane.shape} />
						<dt className="min-w-0 truncate text-muted-foreground">{lane.label}</dt>
						<dd className="shrink-0 font-medium tabular-nums text-foreground">
							{lanes.byReviewLane[lane.key]}
						</dd>
					</div>
				))}
			</dl>
		</div>
	);
}

function Body({ item }: { item: Item }) {
	switch (item.kind) {
		case "working":
			return (
				<p className="flex items-center gap-2 text-xs leading-4 text-muted-foreground">
					<IconLoader className="size-3.5 shrink-0 motion-safe:animate-spin" aria-hidden />
					<span className="min-w-0 truncate">{item.text}</span>
				</p>
			);
		case "stages":
			return <Stages item={item} />;
		case "judgment":
			return (
				<p className="flex items-center gap-2 text-sm leading-5 font-medium">
					{item.count > 0
						? (
							<>
								<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" className="shrink-0">
									<path d="M5 .8 9.2 5 5 9.2 .8 5z" fill="var(--review-req)" />
								</svg>
								<span className="min-w-0 truncate text-(--review-req-ink)">
									{item.count} need your judgment
								</span>
							</>
						)
						: <span className="min-w-0 truncate">Nothing needs your judgment</span>}
				</p>
			);
		case "lanes":
			return <Lanes item={item} />;
		case "fact":
			return <p className="truncate text-xs leading-4 text-muted-foreground">{item.text}</p>;
		case "text":
			return (
				<p
					className={cn(
						"text-sm leading-5",
						item.tone === "strong" ? "font-medium text-foreground" : "text-muted-foreground",
					)}
					style={{ blockSize: item.height }}
				>
					{item.text}
				</p>
			);
	}
}

function ActionControl({ action, actions }: { action: Action; actions: ReviewActions | null }) {
	let [asking, setAsking] = useState(false);
	let variant = action.primary ? ("default" as const) : ("outline" as const);
	if (action.kind === "link") {
		let path = action.path;
		// Only a Review tab entry route becomes a link; anything else stays plain text.
		if (path === null) {
			return (
				<span
					className="inline-flex h-6 min-w-0 items-center truncate px-2 text-xs text-muted-foreground"
					title="This review link isn't a review route"
				>
					{action.label}
				</span>
			);
		}
		return (
			<a
				href={path}
				onClick={(event: MouseEvent) => {
					// Modified clicks keep the browser's own handling, such as a new window.
					if (!actions || event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
					event.preventDefault();
					actions.open(path);
				}}
				className={cn(buttonVariants({ size: "sm", variant }), "min-w-0 max-w-full truncate")}
			>
				{action.label}
			</a>
		);
	}
	let allowed = !!actions?.mayAsk;
	return (
		<Button
			size="sm"
			variant={variant}
			className="min-w-0 max-w-full truncate aria-disabled:opacity-50"
			// Still focusable while it asks or can't, so focus stays and the reason can be read.
			aria-disabled={!allowed || asking || undefined}
			title={allowed ? undefined : NOT_ALLOWED}
			onClick={() => {
				if (!actions || !allowed || asking) return;
				setAsking(true);
				// The app reports a failure; the button is ready again either way.
				void actions.again(action.review, action.source).finally(() => setAsking(false));
			}}
		>
			{asking ? "Asking…" : action.label}
		</Button>
	);
}

function FooterView({ footer }: { footer: Footer }) {
	let actions = useReviewActions();
	let status = footer.status && (
		<p
			className={cn(
				"flex min-w-0 items-start gap-1.5 text-xs leading-4 text-muted-foreground",
				footer.inline && "flex-1 items-center",
			)}
			style={footer.inline ? undefined : { blockSize: footer.statusHeight }}
		>
			{footer.busy && (
				<IconLoader className="mt-px size-3 shrink-0 motion-safe:animate-spin" aria-hidden />
			)}
			<span className={cn("min-w-0", footer.inline && "truncate")}>{footer.status}</span>
		</p>
	);
	let buttons = footer.rows.length > 0 && (
		<div className={cn("flex min-w-0 flex-col", footer.inline ? "shrink-0" : "self-stretch")} style={{ gap: BUTTON_ROW_GAP }}>
			{footer.rows.map((row, index) => (
				<div key={index} className="flex min-w-0 items-center" style={{ gap: BUTTON_GAP }}>
					{row.map((action) => (
						<ActionControl key={action.label} action={action} actions={actions} />
					))}
				</div>
			))}
		</div>
	);
	return (
		<RequestCardFooter
			className={footer.inline ? "items-center justify-between" : "flex-col items-start"}
			style={{ blockSize: footer.height, gap: FOOT_GAP }}
		>
			{status}
			{buttons}
		</RequestCardFooter>
	);
}

/**
 * A Neuve review's request card or refusal card, in the shared request card shell. It draws at
 * exactly the height `reviewCardPlan` reports for the same width.
 */
export function ReviewCard({ view, width }: { view: ReviewCardView; width: number }) {
	let plan = reviewCardPlan(view, width);
	return (
		<RequestCard
			aria-label={view.kind === "refused" ? "Neuve review refusal" : "Neuve review"}
			tone={plan.tone}
			className={cn("overflow-hidden", REVIEW_LANE_COLORS)}
			style={{ inlineSize: plan.width, blockSize: plan.height }}
		>
			<p role="status" className="sr-only">{plan.announce}</p>
			<RequestCardHead
				title={
					<>
						<span className="min-w-0 truncate">{plan.title}</span>
						{plan.badge && (
							<span className="shrink-0 rounded-full bg-muted px-1.5 text-[10px] leading-4 font-normal text-muted-foreground">
								{plan.badge}
							</span>
						)}
					</>
				}
				meta={
					<>
						{/* The branch gives way first; a tail too wide for the card truncates last. */}
						<span className="min-w-[4ch] shrink-[1000] truncate">{plan.meta}</span>
						{/* Not laid out between flex items, but read: the gap alone is silent. */}
						{plan.metaTail && " "}
						{plan.metaTail && <span className="min-w-0 truncate">{plan.metaTail}</span>}
					</>
				}
				metaProps={{
					className: cn(
						"flex min-w-0 gap-[1ch] overflow-hidden",
						plan.metaTone === "error" && "text-destructive",
						plan.mono && "font-mono",
					),
					style: { blockSize: CARD.metaLine },
					title: plan.metaTail ? `${plan.meta} ${plan.metaTail}` : undefined,
				}}
			/>
			{plan.items.length > 0 && (
				<RequestCardBody className="flex flex-col" style={{ gap: BODY_GAP }}>
					{plan.items.map((item, index) => <Body key={index} item={item} />)}
				</RequestCardBody>
			)}
			{plan.footer && <FooterView footer={plan.footer} />}
		</RequestCard>
	);
}

