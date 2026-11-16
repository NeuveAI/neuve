import { reviewPath } from "@ace/ui/review-link";

/** The mounted channel's Review tab opener; a window shows one channel. */
const reviewer: { current?: { channel: string; open: (path: string) => void } } = {};

/** How long a review waits for its channel to open before it is dropped. */
const WAIT = 30_000;

/**
 * A review to show once its channel's tabs mount: that channel, or with no channel the next one
 * to mount, which a channel created for it is.
 */
let waiting: { channel?: string; path: string; until: number } | undefined;

/** Lets the mounted channel's layout receive review links; returns its release. */
export function register(channel: string, open: (path: string) => void): () => void {
	const entry = { channel, open };
	reviewer.current = entry;
	const pending = waiting;
	if (pending && pending.until > Date.now() && (!pending.channel || pending.channel === channel)) {
		waiting = undefined;
		open(pending.path);
	}
	return () => {
		if (reviewer.current === entry) delete reviewer.current;
	};
}

/**
 * Opens a review route in the channel's Review tab: it shows the channel's open Review tab at
 * `path`, or opens one next to Chat at full width. Card links, the new-commit row, the details
 * sidebar, review links in replies and New tab › Review all come here. Returns false when the
 * channel isn't the one this window shows or `path` isn't a review route on this origin.
 */
export function openReview(channel: string, path: string): boolean {
	const route = reviewPath(path);
	const target = reviewer.current;
	if (!route || target?.channel !== channel) return false;
	target.open(route);
	return true;
}

/**
 * Opens a review route in a channel this window is about to show, such as one picked from a
 * pull request's review history: at once if it is shown, else when its tabs mount. Without a
 * channel it goes to the next channel to mount, so call it only just before that channel is
 * created and shown. Returns false when `path` isn't a review route on this origin.
 */
export function openReviewWhenShown(channel: string | undefined, path: string): boolean {
	const route = reviewPath(path);
	if (!route) return false;
	if (channel && openReview(channel, route)) return true;
	waiting = { ...(channel ? { channel } : {}), path: route, until: Date.now() + WAIT };
	return true;
}

/**
 * The channel a review receipt says it was requested from, if any: Records' return link names
 * the channel when the review started in one. Only a return link on this origin is read.
 */
export function reviewChannel(url: string, origin = location.origin): string | undefined {
	try {
		const back = new URL(url, origin).searchParams.get("returnTo");
		if (!back) return;
		const target = new URL(back);
		if (target.origin !== origin) return;
		const channel = target.searchParams.get("channel");
		return channel && /^[A-Za-z0-9_-]{1,64}$/.test(channel) ? channel : undefined;
	} catch {
		return;
	}
}
