import type { BuildCardView, Event, PlanCardView, ReviewActions, ReviewCardView } from "@ace/ui";

import { AGENT_ALIAS } from "./agent-mention";
import type { Event as ChannelEvent, QueuedMessage, ReviewNotice } from "@ace/channel/protocol";
import type { ReviewCard } from "@ace/channel/review-cards";

import { openReview } from "./review-destination";
import type { Item, Tool } from "./transcript";

/**
 * One chat's review cards as the host feed sends them, keyed by the start call that made each, or
 * by `request:` and the review for one requested from the command line.
 */
export type ReviewCards = Record<string, ReviewCard>;

/** The host feed's review events, as the channel protocol carries them. */
export type ReviewEvent = Extract<ChannelEvent, { kind: "review-cards" | "neuve:review:new-commits" }>;

/** The timeline item for a new-commit event, keyed by its stored entry like other rows. */
export function reviewCommits(
	event: Extract<ReviewEvent, { kind: "neuve:review:new-commits" }>,
): Item {
	const { entry, at, review, branch, reviewedHead, head, label } = event;
	return {
		kind: "review-commits",
		key: `e${entry}`,
		at,
		text: "",
		review,
		branch,
		reviewedHead,
		head,
		label,
	};
}

/** The tools that start a review; each gets a card under its turn, chosen by name like `question`. */
const START = new Set(["neuve_review_branch", "neuve_review_pull_request", "neuve_review_lane"]);
const STATUS = "neuve_review_status";
const OUTCOME = "neuve_review_outcome";
const NO_APPROVAL = "Completing a review does not approve the change.";

// The Review tab's entry routes (contract section 7): a cycle's batch overview and its review
// desk, under the project's SHA-256 key. The same rule as the Review tab's `reviewPath`.
const ENTRY = /^\/review\/[0-9a-f]{64}\/cycles\/[0-9A-HJKMNP-TV-Z]{26}(?:\/desk)?$/;

/** Whether a card link is an app-relative review entry route; anything else shows as plain text. */
export function reviewEntry(path: string): boolean {
	return ENTRY.test(path);
}

/** A review and its batch overview route. */
export type NewestReview = { review: string; path: string };

/**
 * The chat's newest admitted review whose batch overview is a review entry route. Review ids are
 * time-ordered, so the greatest is the newest; `updatedAt` moves with every progress update.
 */
export function newestReview(cards: ReviewCards): NewestReview | null {
	let newest: NewestReview | null = null;
	for (const card of Object.values(cards)) {
		if (card.kind !== "review" || !card.links || !reviewEntry(card.links.batch)) continue;
		if (!newest || card.review > newest.review) newest = { review: card.review, path: card.links.batch };
	}
	return newest;
}

/** The host's mark on its notify wake, on a message or queued message; the mark, not the author, decides. */
export function reviewNotice(value: Pick<QueuedMessage, "system">): ReviewNotice | undefined {
	return value.system?.kind === "neuve:review:terminal" ? value.system : undefined;
}

/** The review a transcript message tells the agent about, when it is the host's marked wake. */
export function wakeNote(item: Item): ReviewNotice | undefined {
	return item.kind === "message" ? reviewNotice(item) : undefined;
}

/** How the wake reads: the reviewed card's end state, when this chat holds it. */
export function wakePhase(cards: ReviewCards, review: string): "finished" | "stopped" | null {
	const card = reviewed(cards, review);
	return card?.phase === "finished" || card?.phase === "stopped" ? card.phase : null;
}

type Args = Record<string, unknown>;
type Admission =
	| {
		outcome: "admitted";
		review: string;
		recovered: boolean;
		range: { branch: string; base: string; head: string; commits: number };
	}
	| { outcome: "refused"; reason: string; detail: string; fix: string };
type Status = {
	review: string;
	state: "queued" | "running" | "finished" | "stopped";
	stage?: { done: number; of: number; name: string };
	new_commits: boolean;
};
type Outcome =
	| { review: string; complete: boolean; units: number; gaps: number; undecoded: number }
	| { outcome: "not_finished"; state: string };

const record = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

/** The model-facing result: JSON on its first line, then fixed sentences for the agent. */
function payload(tool: Tool): Record<string, unknown> | undefined {
	if (!tool.result) return;
	try {
		const value: unknown = JSON.parse(tool.result.text.split("\n", 1)[0]!);
		return record(value) ? value : undefined;
	} catch {
		return;
	}
}

function refusal(value: Record<string, unknown> | undefined) {
	return value?.outcome === "refused" && typeof value.detail === "string"
			&& typeof value.fix === "string" && typeof value.reason === "string"
		? (value as Extract<Admission, { outcome: "refused" }>)
		: undefined;
}

function admission(value: Record<string, unknown> | undefined) {
	if (value?.outcome !== "admitted" || typeof value.review !== "string") return;
	const range = value.range;
	if (
		!record(range) || typeof range.branch !== "string" || typeof range.base !== "string"
		|| typeof range.head !== "string" || typeof range.commits !== "number"
	) return;
	return value as Extract<Admission, { outcome: "admitted" }>;
}

const plural = (count: number, one: string, many = `${one}s`) =>
	`${count} ${count === 1 ? one : many}`;

/** "uncommitted_changes" reads "Uncommitted changes" when only the model result names it. */
function reasonTitle(reason: string) {
	return capital(reason.replaceAll("_", " "));
}

/** What the start call asked for, before Neuve has pinned it: "this branch against main". */
function asked(tool: Tool) {
	const args = (tool.args ?? {}) as Args;
	if (tool.name === "neuve_review_pull_request") {
		return typeof args.repo === "string" && typeof args.number === "number"
			? `${args.repo}#${args.number}`
			: "a pull request";
	}
	if (tool.name === "neuve_review_lane") return "this chat's lane";
	return typeof args.against === "string" && args.against
		? `this branch against ${args.against}`
		: "this branch";
}

const capital = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

function label(tool: Tool, range: Extract<Admission, { outcome: "admitted" }>["range"]) {
	if (tool.name === "neuve_review_pull_request") return asked(tool);
	const args = (tool.args ?? {}) as Args;
	const against = typeof args.against === "string" && args.against ? args.against : range.base;
	return `${range.branch} against ${against}`;
}

function view(card: ReviewCard, connected: boolean): ReviewCardView {
	if (card.kind === "refused") {
		return { kind: "refused", title: card.title, detail: card.detail, fix: card.fix };
	}
	const { notify: _, updatedAt: __, links, ...rest } = card;
	// The host can't move a live card while the app is cut off from it, so its last state shows.
	const live = card.phase === "queued" || card.phase === "running";
	return {
		...rest,
		phase: live && !connected ? "connection_lost" : card.phase,
		links: links && {
			batch: reviewEntry(links.batch) ? links.batch : null,
			desk: reviewEntry(links.desk) ? links.desk : null,
		},
	};
}

/**
 * The card a start call shows: its doc entry once the tool or host wrote one, else what the call
 * itself says: asked while it runs, then the admission or refusal in its result.
 */
export function reviewCard(
	tool: Tool,
	cards: ReviewCards,
	busy: boolean,
	connected: boolean,
): ReviewCardView | undefined {
	if (!START.has(tool.name)) return;
	const card = cards[tool.call];
	if (card) return view(card, connected);
	if (!tool.result) {
		return busy && !tool.unrun ? { kind: "asked", label: capital(asked(tool)) } : undefined;
	}
	const value = payload(tool);
	const refused = refusal(value);
	if (refused) {
		return {
			kind: "refused",
			title: reasonTitle(refused.reason),
			detail: refused.detail,
			fix: refused.fix,
		};
	}
	const admitted = admission(value);
	if (!admitted) return;
	return {
		kind: "review",
		review: admitted.review,
		source: tool.name === "neuve_review_pull_request"
			? "pull_request"
			: tool.name === "neuve_review_lane"
			? "lane"
			: "branch",
		label: label(tool, admitted.range),
		range: admitted.range,
		recovered: admitted.recovered === true,
		phase: connected ? "queued" : "connection_lost",
		stage: null,
		stages: [],
		finished: null,
		stopped: null,
		newCommits: null,
		links: null,
	};
}

function reviewed(cards: ReviewCards, review: unknown) {
	for (const card of Object.values(cards)) {
		if (card.kind === "review" && card.review === review) return card;
	}
}

/** Who a status or outcome read is about: its review, or the chat's latest when it named none. */
function subject(tool: Tool, cards: ReviewCards) {
	const args = (tool.args ?? {}) as Args;
	const review = typeof args.review === "string" ? args.review : payload(tool)?.review;
	const card = review === undefined
		? Object.values(cards).filter((value) => value.kind === "review")
			.sort((a, b) => a.updatedAt - b.updatedAt).at(-1)
		: reviewed(cards, review);
	if (card?.kind !== "review") return;
	return card.source === "pull_request" ? card.label : card.range.branch;
}

function refused(prefix: string, value: Extract<Admission, { outcome: "refused" }>) {
	return `${prefix}: ${value.detail.replace(/\.?$/, ".")} ${value.fix.replace(/\.?$/, ".")}`;
}

function admissionText(value: Record<string, unknown> | undefined) {
	const no = refusal(value);
	if (no) return refused("Didn't start", no);
	const yes = admission(value);
	if (!yes) return;
	return `${yes.recovered ? "Recovered after a restart" : "Admitted"}: ${
		plural(yes.range.commits, "commit")
	} from ${yes.range.base} to ${yes.range.head.slice(0, 7)}. The card below follows it.`;
}

function statusText(value: Record<string, unknown> | undefined) {
	const no = refusal(value);
	if (no) return refused("Couldn't check", no);
	if (typeof value?.state !== "string") return;
	const status = value as Status;
	const stage = status.stage;
	const where = status.state === "running" && stage
		? `Running, stage ${stage.done + 1} of ${stage.of}: ${stage.name}.`
		: `${reasonTitle(status.state)}.`;
	const line = status.new_commits ? `${where} The branch has newer commits.` : where;
	return status.state === "finished" ? `${line}\n${NO_APPROVAL}` : line;
}

function outcomeText(value: Record<string, unknown> | undefined) {
	const no = refusal(value);
	if (no) return refused("Couldn't read it", no);
	if (value?.outcome === "not_finished") {
		return `Not finished: ${String((value as Extract<Outcome, { outcome: "not_finished" }>).state)}.`;
	}
	if (typeof value?.units !== "number") return;
	const outcome = value as Extract<Outcome, { units: number }>;
	return [
		`${outcome.complete ? "Complete" : "Incomplete"}: ${plural(outcome.units, "review unit")}`,
		outcome.gaps ? plural(outcome.gaps, "gap") : "no gaps",
		...(outcome.undecoded ? [`${outcome.undecoded} undecoded`] : []),
	].join(", ") + `.\n${NO_APPROVAL}`;
}

/**
 * The plain row a review tool shows in place of its raw name, arguments and JSON result. Rows of
 * other tools are left alone.
 */
export function reviewTool(
	tool: Tool,
	cards: ReviewCards,
): { name: string; summary?: string; result?: string } | undefined {
	const value = payload(tool);
	// A result that isn't the tools' JSON, such as a thrown error, still reads as a sentence.
	const fallback = tool.result
		? tool.result.error
			? "Neuve couldn't answer this call."
			: "Neuve answered in a form this app can't read."
		: undefined;
	if (START.has(tool.name)) {
		const card = cards[tool.call];
		const admitted = admission(value);
		return {
			name: "Start Neuve review",
			summary: card?.kind === "review"
				? card.label
				: admitted
				? label(tool, admitted.range)
				: tool.name === "neuve_review_pull_request"
				? asked(tool)
				: `of ${asked(tool)}`,
			result: tool.result ? admissionText(value) ?? fallback : undefined,
		};
	}
	if (tool.name === STATUS) {
		return {
			name: "Check Neuve review",
			summary: subject(tool, cards),
			result: tool.result ? statusText(value) ?? fallback : undefined,
		};
	}
	if (tool.name === OUTCOME) {
		return {
			name: "Read Neuve review outcome",
			summary: subject(tool, cards),
			result: tool.result ? outcomeText(value) ?? fallback : undefined,
		};
	}
}

/**
 * Places each command-line request's card at its entry, and each review start call's card and each
 * plan's card at the call that last wrote it right after the run that made it, so it reads under its call without splitting the agent's turn and
 * above anything that came later, such as a new-commit row. `events` holds one event per item,
 * then the streamed draft when there is one. `plans` holds each plan's card by its writing call.
 */
export function withCards(
	events: Event[],
	items: Item[],
	cards: ReviewCards,
	plans: ReadonlyMap<string, PlanCardView>,
	topic: string,
	busy: boolean,
	connected: boolean,
	builds: ReadonlyMap<string, BuildCardView> = new Map(),
): Event[] {
	const out: Event[] = [];
	let pending: Event[] = [];
	const flush = () => {
		out.push(...pending);
		pending = [];
	};
	items.forEach((item, index) => {
		if (item.kind !== "reply") flush();
		if (item.kind === "review-requested") {
			const card = cards[`request:${item.review}`];
			if (card) out.push({ ...events[index]!, card: view(card, connected) } as Event);
			return;
		}
		out.push(events[index]!);
		if (item.kind !== "reply") return;
		for (const tool of item.tools) {
			const plan = plans.get(tool.call);
			if (plan) {
				pending.push({
					id: `${topic}::plan:${plan.plan}`,
					uid: `plan:${plan.plan}`,
					type: "neuve:plan:card",
					topic,
					created_at: Math.floor(item.at / 1000),
					card: plan,
				});
			}
			const build = builds.get(tool.call);
			if (build) {
				pending.push({
					id: `${topic}::build:${build.build}`,
					uid: `build:${build.build}`,
					type: "neuve:build:card",
					topic,
					created_at: Math.floor(item.at / 1000),
					card: build,
				});
			}
			const card = reviewCard(tool, cards, busy, connected);
			if (!card) continue;
			pending = pending.filter((value) => value.uid !== `review:${tool.call}`);
			pending.push({
				id: `${topic}::review:${tool.call}`,
				uid: `review:${tool.call}`,
				type: "neuve:review:card",
				topic,
				created_at: Math.floor(item.at / 1000),
				call: tool.call,
				card,
			});
		}
		// Later replies in the same run move the card down with them, stamped at their time.
		pending = pending.map((value) => ({ ...value, created_at: Math.floor(item.at / 1000) }));
	});
	const draft = events[items.length];
	if (draft) out.push(draft);
	flush();
	return out;
}

/**
 * Where a chat's review links go: the channel's Review tab, through its one opener, never a
 * browser tab of its own.
 */
export function reviewTab(channel: string): (path: string) => void {
	return (path) => void openReview(channel, path);
}

/**
 * What the cards' links and buttons do. A new review is an ordinary message from the person to the
 * agent, so every review still starts through the agent's tools.
 */
export function reviewActions(
	cards: ReviewCards,
	mayAsk: boolean,
	ask: (text: string) => Promise<void>,
	open: (path: string) => void,
): ReviewActions {
	return {
		open,
		mayAsk,
		again: (review, label) => {
			const card = reviewed(cards, review);
			const what = card?.source === "lane" ? "this chat's lane" : label;
			return ask(`@${AGENT_ALIAS.name} review ${what} again`);
		},
	};
}
