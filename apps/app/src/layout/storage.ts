import * as Split from "@ace/split-tabs";
import { reviewPagePath } from "@ace/ui/review-link";

import { load, remove, save } from "../window-storage";

/** The Chat tab's uid; it can't be closed or renamed. */
export const CHAT = "chat";

const STORAGE = "ace:channel-layout";
const VERSION = 1;
const KINDS = new Set<Kind>(["blank", "chat", "plan", "diff", "terminal", "live", "review", "work"]);

/** Plan, Diff and Terminal tabs belong to the chat whose plan or lane they show. */
export type Content =
	& (
		| { type: "blank" }
		| { type: "chat" }
		// Without `plan` the tab follows the chat's newest plan.
		| { type: "plan"; chat: number; plan?: string }
		| { type: "diff"; chat: number }
		| { type: "terminal"; chat: number; terminal?: string }
		// A native window on this Mac, drawn live over the pane; `window` is its CGWindowID and
		// `app` the bundle ID that a relink looks for.
		| { type: "live"; window: number; app?: string }
		// Neuve's review app at an app-relative `/review/` route; none lists the channel's reviews.
		// `title` is the label the review app last gave the tab.
		| { type: "review"; path?: string; title?: string }
		// The channel's work log, showing agent chat `chat` when one is chosen.
		| { type: "work"; chat?: number }
	)
	& { name?: string };

export type Kind = Content["type"];
export type Meta = Record<string, Content>;

/**
 * `diff` records that a Diff tab already opened for the chat's current changes, `plans` the
 * newest plan a Plan tab opened for, by chat, `work` how much of the work log was seen, once a
 * Work log tab opened, and `reviews` the newest review a Review tab opened for, by chat; an empty
 * id marks a chat seen with no review.
 */
export type Planned = Record<string, string>;
type Layout = {
	state: Split.State;
	meta: Meta;
	diff: boolean;
	plans: Planned;
	work?: number;
	reviews: Planned;
};

type Saved = {
	version: typeof VERSION;
	state: Split.Data;
	tabs: Meta;
	diff?: boolean;
	plans?: Planned;
	work?: number;
	reviews?: Planned;
};

function object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function content(kind: Kind, chat: number): Content {
	if (kind === "diff" || kind === "terminal" || kind === "plan") return { type: kind, chat };
	if (kind === "live") return { type: "blank" };
	return { type: kind };
}

export function fallback(uid: string): Content {
	return uid === CHAT ? { type: "chat" } : { type: "blank" };
}

function clean(state: Split.State, meta?: unknown): Meta {
	const input = object(meta) ? meta : {};
	const next: Meta = {};
	for (const uid of state.tabs) {
		const value = input[uid];
		if (uid === CHAT || !object(value) || !KINDS.has(value.type as Kind)) {
			next[uid] = fallback(uid);
			continue;
		}
		if (value.type === "live") {
			next[uid] = Number.isInteger(value.window)
				? {
					type: "live",
					window: value.window as number,
					...(typeof value.app === "string" ? { app: value.app } : undefined),
					...(typeof value.name === "string" ? { name: value.name } : undefined),
				}
				: fallback(uid);
			continue;
		}
		if (value.type === "work") {
			const name = typeof value.name === "string" ? value.name.trim() : "";
			next[uid] = {
				type: "work",
				...(Number.isInteger(value.chat) && (value.chat as number) > 0
					? { chat: value.chat as number }
					: undefined),
				...(name ? { name } : undefined),
			};
			continue;
		}
		if (value.type === "review") {
			const path = typeof value.path === "string" ? reviewPagePath(value.path) : undefined;
			const title = typeof value.title === "string" ? value.title.trim().slice(0, 80) : "";
			const name = typeof value.name === "string" ? value.name.trim() : "";
			next[uid] = {
				type: "review",
				...(path ? { path } : undefined),
				...(title ? { title } : undefined),
				...(name ? { name } : undefined),
			};
			continue;
		}
		const chat = Number.isInteger(value.chat) && (value.chat as number) > 0
			? value.chat as number
			: 1;
		const name = typeof value.name === "string" ? value.name.trim() : "";
		const terminal = value.type === "terminal" && typeof value.terminal === "string"
			? value.terminal
			: undefined;
		const plan = value.type === "plan" && typeof value.plan === "string" ? value.plan : undefined;
		next[uid] = {
			...content(value.type as Kind, chat),
			...(name ? { name } : undefined),
			...(terminal ? { terminal } : undefined),
			...(plan ? { plan } : undefined),
		};
	}
	return next;
}

function planned(value: unknown): Planned {
	return Object.fromEntries(
		Object.entries(object(value) ? value : {}).filter(([, id]) => typeof id === "string"),
	) as Planned;
}

export function read(id: string): Layout {
	const raw = load(`${STORAGE}:${id}`);
	if (raw) {
		try {
			const data = JSON.parse(raw) as Saved;
			const state = Split.restore(data.state);
			const work = Number.isInteger(data.work) && data.work! >= 0 ? data.work : undefined;
			return {
				state,
				meta: clean(state, data.tabs),
				diff: data.diff === true,
				plans: planned(data.plans),
				work,
				reviews: planned(data.reviews),
			};
		} catch {
			remove(`${STORAGE}:${id}`);
		}
	}
	const state = Split.initial(CHAT);
	return { state, meta: clean(state), diff: false, plans: {}, reviews: {} };
}

export function write(
	id: string,
	state: Split.State,
	meta: Meta,
	diff: boolean,
	plans: Planned = {},
	work?: number,
	reviews: Planned = {},
) {
	const data = {
		version: VERSION,
		state: Split.save(state),
		tabs: clean(state, meta),
		diff,
		plans,
		...(work === undefined ? {} : { work }),
		reviews,
	} satisfies Saved;
	save(`${STORAGE}:${id}`, JSON.stringify(data));
}
