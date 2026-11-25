import { useSyncExternalStore } from "react";

import type { Build, Changes, GithubPull, Plan, PlanComment, WorkMessage } from "@ace/channel/protocol";
import type { ChannelInfo } from "@ace/host/protocol";

import type { NewestReview } from "./review-card";
import type { Item } from "./transcript";

/** A git or pull request action the chat's agent was asked to take. */
export type Ask =
	| "create"
	| "commit"
	| "push"
	| "update"
	| "rebase"
	| "review"
	| "ready"
	| "merge"
	| "close";

/** What an open channel's views know, shared with its details sidebar outside their tree. */
export type Details = {
	info?: ChannelInfo;
	changes?: Changes;
	/** The chat branch's newest pull request; `null` once read and none exists. */
	pull?: GithubPull | null;
	/** What the chat's agent was asked to do and hasn't finished; `null` once it has. */
	asked?: Ask | null;
	items?: Item[];
	/** Whether teammates may invoke agents, as the chat's watch reports it. */
	shared?: boolean;
	/** Whether the watch follows sharing changes; older hosts report only a snapshot. */
	sharedLive?: boolean;
	desktop?: boolean;
	desktopLive?: boolean;
	/** Shows the chat's Diff tab, opening one when none is open, at `file` when it changed. */
	diff?: (file?: string) => void;
	/** The shown chat's plans, oldest first, once its transcript has loaded. */
	plans?: { chat: number; list: Plan[] };
	/**
	 * The comments on the shown chat's plans, oldest first, once its transcript has loaded, and every
	 * submission that sent some of them, as the channel's events showed it.
	 */
	planComments?: { chat: number; list: PlanComment[]; sends?: number[] };
	/** The shown chat's newest review with a batch overview, `null` when it has none, once its transcript has loaded. */
	reviews?: { chat: number; newest: NewestReview | null };
	/** Shows the chat's Plan tab, opening one beside the chat when none is open, at plan `id`. */
	plan?: (id?: string) => void;
	/** The channel's builds and what their agents said to each other, once a chat's transcript has loaded. */
	builds?: { list: Build[]; messages: WorkMessage[] };
	/** Shows the channel's Work log tab, opening one when none is open, at agent chat `chat`. */
	work?: (chat?: number) => void;
	/** A file the chat's Diff should show once its changes list it; `null` once shown. */
	reveal?: { chat: number; file: string; key: number } | null;
};

const EMPTY: Details = {};
const values = new Map<string, Details>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
	listeners.add(listener);
	return () => void listeners.delete(listener);
}

/**
 * Undefined fields keep their last known value, so a channel opened again shows what it showed
 * before and its fresh reads replace that in place instead of the sidebar emptying and refilling.
 */
export function publish(channel: string, patch: Details) {
	const next = { ...values.get(channel) };
	for (const [key, value] of Object.entries(patch)) {
		if (value !== undefined) Object.assign(next, { [key]: value });
	}
	values.set(channel, next);
	for (const listener of listeners) listener();
}

/** Drops the Diff, Plan and Work log openers, which only work while the channel's tabs are mounted. */
export function forget(channel: string) {
	const { diff: _, plan: __, work: ___, ...rest } = values.get(channel) || {};
	values.set(channel, rest);
	for (const listener of listeners) listener();
}

export function useDetails(channel: string): Details {
	return useSyncExternalStore(subscribe, () => values.get(channel) || EMPTY);
}

/** The id of the chat's newest plan, once the chat's transcript has loaded and it has one. */
export function useNewestPlan(channel: string, chat: number): string | undefined {
	return useSyncExternalStore(subscribe, () => {
		const plans = values.get(channel)?.plans;
		return plans?.chat === chat ? plans.list.at(-1)?.id : undefined;
	});
}

/**
 * The chat's newest review with a batch overview: `null` once the chat's transcript has loaded and
 * it has none, undefined before then.
 */
export function useNewestReview(channel: string, chat: number): NewestReview | null | undefined {
	return useSyncExternalStore(subscribe, () => {
		const reviews = values.get(channel)?.reviews;
		return reviews?.chat === chat ? reviews.newest : undefined;
	});
}
