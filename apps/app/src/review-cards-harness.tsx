// Dev-only page (review-cards.html, served by `vite` but not built): Ace's real timeline over
// fixture transcripts, showing every Neuve review card state, the refusal card, the plain review
// tool rows and the new-commit row. `?theme=dark` renders the dark theme.
import { createRoot } from "react-dom/client";
import { useState } from "react";

import { Button, ReviewActionsProvider, Timeline } from "@ace/ui";

import "./styles.css";

import { reviewActions, reviewCommits, withReviews } from "./review-card";
import type { ReviewCard } from "@ace/channel/review-cards";
import { toEvents } from "./timeline";
import type { Item, Tool } from "./transcript";

const dark = new URLSearchParams(location.search).get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);

const USER = "vinicius@example.com";
const T = Date.UTC(2026, 10, 1, 10, 0, 0);
const STAGES = ["Understand", "Investigate", "Assemble", "Dispose", "Publish"];
const RANGE = { branch: "codex/pi-transition", base: "main", head: "a3f9c2e81d", commits: 41 };
const KEY = "4f1c9a0e".repeat(8);
const CYCLE = "01JD8Q3ZK6V7W2X9Y4R5T1M0NB";
const LINKS = { batch: `/review/${KEY}/cycles/${CYCLE}`, desk: `/review/${KEY}/cycles/${CYCLE}/desk` };
const FINISHED = {
	units: 26,
	byReviewLane: { humanRequired: 4, humanSuggested: 3, agentic: 7, static: 12 },
	needJudgment: 4,
	complete: true,
	gaps: 0,
	undecoded: 0,
};

const review = (patch: Partial<Extract<ReviewCard, { kind: "review" }>>): ReviewCard => ({
	kind: "review",
	review: "01JD8Q3ZK6V7W2X9Y4R5T1M0NB",
	source: "branch",
	label: "codex/pi-transition against main",
	range: RANGE,
	recovered: false,
	notify: false,
	phase: "queued",
	stage: null,
	stages: STAGES,
	finished: null,
	stopped: null,
	newCommits: null,
	links: null,
	updatedAt: T,
	...patch,
});

const admitted = (recovered = false) =>
	[
		JSON.stringify({
			outcome: "admitted",
			review: "01JD8Q3ZK6V7W2X9Y4R5T1M0NB",
			recovered,
			range: RANGE,
			notify: false,
		}),
		"Completing a review does not approve the change. Point the person at the review card.",
	].join("\n");

type Scene = {
	label: string;
	tools: Tool[];
	reply?: string;
	cards?: Record<string, ReviewCard>;
	/** New-commit events the host feed posts, folded by the transcript like the live app. */
	newCommits?: { entry: number; at: number; head: string }[];
	busy?: boolean;
	connected?: boolean;
	width?: number;
	height?: number;
	after?: Item[];
};

const start = (result?: string, error = false): Tool => ({
	call: "start",
	name: "neuve_review_branch",
	args: { against: "main" },
	...(result ? { result: { error, text: result } } : {}),
});

const refusedCard = (
	title: string,
	detail: string,
	fix: string,
	reason: Extract<ReviewCard, { kind: "refused" }>["reason"] = "uncommitted_changes",
): ReviewCard => ({
	kind: "refused",
	reason,
	title,
	detail,
	fix,
});

const REFUSED_TEXT = [
	JSON.stringify({
		outcome: "refused",
		reason: "uncommitted_changes",
		detail: "12 uncommitted or untracked paths in neuve.",
		fix: "Commit or remove them, then ask again",
	}),
	"No chat review replaces a Neuve review.",
].join("\n");

const SCENES: Scene[] = [
	{ label: "Asked: the start call is running", tools: [start()], busy: true },
	{
		label: "Queued",
		tools: [start(admitted())],
		reply: "I started a Neuve review of codex/pi-transition against main.",
		cards: { start: review({}) },
	},
	{
		label: "Recovered after a restart",
		tools: [start(admitted(true))],
		reply: "The earlier request continues.",
		cards: { start: review({ recovered: true }) },
	},
	{
		label: "Running, by stage",
		tools: [start(admitted())],
		reply: "I started a Neuve review of codex/pi-transition against main.",
		cards: {
			start: review({ phase: "running", stage: { done: 1, of: 5, name: "Investigate" } }),
		},
	},
	{
		label: "Finished",
		tools: [start(admitted())],
		reply: "I started a Neuve review of codex/pi-transition against main.",
		cards: { start: review({ phase: "finished", finished: FINISHED, links: LINKS }) },
		height: 520,
	},
	{
		label: "Finished, with newer commits",
		tools: [start(admitted())],
		reply: "I started a Neuve review of codex/pi-transition against main.",
		cards: {
			start: review({
				phase: "finished",
				finished: { ...FINISHED, complete: false, gaps: 2, undecoded: 1 },
				links: LINKS,
				newCommits: { head: "b71d004c2a" },
			}),
		},
		newCommits: [{ entry: 9, at: T + 60_000, head: "b71d004c2a" }],
		height: 600,
	},
	{
		label: "Stopped",
		tools: [start(admitted())],
		reply: "I started a Neuve review of codex/pi-transition against main.",
		cards: {
			start: review({
				phase: "stopped",
				stage: { done: 1, of: 5, name: "Investigate" },
				stopped: { reason: "The model provider timed out. Finished work is kept." },
				links: LINKS,
			}),
		},
	},
	{
		label: "Connection lost",
		tools: [start(admitted())],
		reply: "I started a Neuve review of codex/pi-transition against main.",
		cards: {
			start: review({ phase: "running", stage: { done: 1, of: 5, name: "Investigate" } }),
		},
		connected: false,
	},
	{
		label: "Refused",
		tools: [start(REFUSED_TEXT, true)],
		reply: "Neuve can't start that review yet.",
		cards: {
			start: refusedCard(
				"Uncommitted changes",
				"12 uncommitted or untracked paths in neuve.",
				"Commit or remove them, then ask again",
			),
		},
	},
	{
		label: "Refused: Records identity mismatch",
		tools: [start(REFUSED_TEXT, true)],
		reply: "Neuve refused the request.",
		cards: {
			start: refusedCard(
				"Records identity mismatch",
				"The review records name a different project for this request.",
				"Report this to the owner; do not retry",
				"records_mismatch",
			),
		},
	},
	{
		label: "Check and read rows stay plain",
		tools: [
			{
				call: "status",
				name: "neuve_review_status",
				args: {},
				result: {
					error: false,
					text: JSON.stringify({
						review: "01JD8Q3ZK6V7W2X9Y4R5T1M0NB",
						state: "finished",
						new_commits: false,
					}),
				},
			},
			{
				call: "outcome",
				name: "neuve_review_outcome",
				args: { review: "01JD8Q3ZK6V7W2X9Y4R5T1M0NB" },
				result: {
					error: false,
					text: JSON.stringify({
						review: "01JD8Q3ZK6V7W2X9Y4R5T1M0NB",
						complete: true,
						units: 26,
						gaps: 0,
						undecoded: 0,
					}),
				},
			},
		],
		cards: { earlier: review({ phase: "running" }) },
	},
	{
		label: "Finished, phone width",
		tools: [start(admitted())],
		reply: "Started.",
		cards: { start: review({ phase: "finished", finished: FINISHED, links: LINKS }) },
		width: 360,
		height: 600,
	},
	{
		label: "Finished, a desk link that isn't a review route",
		tools: [start(admitted())],
		reply: "I started a Neuve review of codex/pi-transition against main.",
		cards: {
			start: review({
				phase: "finished",
				finished: FINISHED,
				links: { batch: LINKS.batch, desk: "https://example.com/desk" },
			}),
		},
		height: 520,
	},
	{
		label: "Told the agent the review finished (notify wake)",
		tools: [start(admitted())],
		reply: "I started a Neuve review and will tell you when it finishes.",
		cards: {
			start: review({ phase: "finished", finished: FINISHED, links: LINKS, notify: true }),
		},
		after: [
			{
				kind: "message",
				key: "e7",
				entry: 7,
				at: T + 90_000,
				author: "unknown",
				text:
					"[Neuve system note] Review 01JD8Q3ZK6V7W2X9Y4R5T1M0NB is finished. Point the person at the review card without summarizing findings. Completing a review does not approve the change.",
				invoked: true,
				// The host's mark, as the transcript keeps it from the message event's `system`.
				system: { kind: "neuve:review:terminal", review: "01JD8Q3ZK6V7W2X9Y4R5T1M0NB" },
			},
			{
				kind: "reply",
				key: "e8",
				entry: 8,
				at: T + 95_000,
				model: "",
				text: "The review finished; the card above has the batch overview and the review desk.",
				tools: [],
			},
		],
		height: 640,
	},
];

function items(scene: Scene): Item[] {
	return [
		{
			kind: "message",
			key: "e1",
			entry: 1,
			at: T,
			author: USER,
			text: "review this branch against main",
			invoked: true,
		},
		{ kind: "reply", key: "e2", entry: 2, at: T + 2000, model: "", text: "", tools: scene.tools },
		...(scene.reply
			? [{
				kind: "reply" as const,
				key: "e3",
				entry: 3,
				at: T + 4000,
				model: "",
				text: scene.reply,
				tools: [],
			}]
			: []),
		...(scene.after || []),
	];
}

function Panel({ scene, onAction }: { scene: Scene; onAction: (text: string) => void }) {
	// The host feed's new-commit events become timeline items the way the transcript folds them.
	let feed = scene.cards || {};
	let list = [
		...items(scene),
		...(scene.newCommits || []).map((posted) =>
			reviewCommits({
				kind: "neuve:review:new-commits",
				chat: 1,
				entry: posted.entry,
				at: posted.at,
				review: "01JD8Q3ZK6V7W2X9Y4R5T1M0NB",
				branch: RANGE.branch,
				reviewedHead: RANGE.head,
				head: posted.head,
				label: "codex/pi-transition against main",
			})
		),
	];
	let busy = !!scene.busy;
	let events = withReviews(
		toEvents(
			list,
			"harness",
			busy,
			{ text: "" },
			{},
			new Map(),
			{},
			{},
			{},
			() => undefined,
			feed,
		),
		list,
		feed,
		"harness",
		busy,
		scene.connected !== false,
	);
	let actions = reviewActions(
		feed,
		true,
		(text) =>
			new Promise((resolve) =>
				setTimeout(() => {
					onAction(`Sent as the person: “${text}”`);
					resolve();
				}, 500)
			),
		(path) => onAction(`Open Review tab at ${path}`),
	);
	return (
		<figure className="flex min-w-0 flex-col gap-2">
			<figcaption className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
				{scene.label}
			</figcaption>
			<div
				className="overflow-hidden rounded-xl border border-border bg-background"
				style={{ inlineSize: scene.width ?? "100%", blockSize: scene.height ?? 420 }}
			>
				<ReviewActionsProvider value={actions}>
					<Timeline
						className="h-full min-h-0"
						events={events}
						working={busy || undefined}
						currentUser={{ login: USER, own: [USER] }}
					/>
				</ReviewActionsProvider>
			</div>
		</figure>
	);
}

// One card moved through its phases in place, as the host would move it.
const LIVE: Scene[] = [
	SCENES[0]!,
	SCENES[1]!,
	SCENES[3]!,
	{ ...SCENES[3]!, cards: { start: review({ phase: "running", stage: { done: 3, of: 5, name: "Dispose" } }) } },
	SCENES[4]!,
];

function Live({ onAction }: { onAction: (text: string) => void }) {
	let [step, setStep] = useState(0);
	return (
		<div className="flex flex-col gap-2">
			<Button
				size="sm"
				variant="outline"
				className="self-start"
				onClick={() => setStep((value) => (value + 1) % LIVE.length)}
			>
				Next phase ({step + 1} of {LIVE.length})
			</Button>
			<Panel scene={{ ...LIVE[step]!, label: "Live: one card, moved in place" }} onAction={onAction} />
		</div>
	);
}

function Harness() {
	let [last, setLast] = useState("Nothing pressed yet.");
	let only = new URLSearchParams(location.search).get("scene");
	if (only === "live") {
		return (
			<main className="h-full overflow-auto bg-muted/40 p-6 text-foreground">
				<Live onAction={setLast} />
			</main>
		);
	}
	let scenes = only === null ? SCENES : [SCENES[Number(only)]!];
	return (
		<main className="h-full overflow-auto bg-muted/40 p-6 text-foreground">
			<header className="mb-5 flex flex-wrap items-baseline justify-between gap-3">
				<h1 className="text-base font-medium">Neuve review cards in Ace's timeline</h1>
				<p role="status" className="text-xs text-muted-foreground" data-testid="last-action">
					{last}
				</p>
			</header>
			<div className="grid gap-6" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 640px), 1fr))" }}>
				{scenes.map((scene) => <Panel key={scene.label} scene={scene} onAction={setLast} />)}
			</div>
		</main>
	);
}

createRoot(document.getElementById("root")!).render(<Harness />);
