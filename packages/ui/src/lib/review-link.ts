import { createContext, useContext } from "react";

/** Opens an app-relative review route in the shown channel's Review tab. */
export type ReviewOpen = (path: string) => void;

const ReviewLink = createContext<ReviewOpen | undefined>(undefined);

/** Provided by the mounted channel; review links outside one stay ordinary links. */
export const ReviewLinkProvider = ReviewLink.Provider;

export function useReviewOpen(): ReviewOpen | undefined {
	return useContext(ReviewLink);
}

// The host's two entry routes (reviewPaths in @ace/host/app-gateway): a cycle's batch overview and
// its review desk. The project key is the SHA-256 hex of the project path; cycles are ULIDs.
const ENTRY = /^\/review\/[0-9a-f]{64}\/cycles\/[0-9A-HJKMNP-TV-Z]{26}(?:\/desk)?$/;
// Pages of the review app the tab may show once open; its API and server functions never.
const PAGE = /^\/review\/[0-9a-f]{64}\/(?:cycles|batch|review|changes)(?:\/[A-Za-z0-9._~-]+)+$/;
// A saved route stays far below what storage and history allow.
const LONGEST = 2048;

function parse(href: string, origin: string): URL | undefined {
	try {
		const url = new URL(href, origin);
		// The parser has already resolved dot segments, encoded ones included.
		if (url.origin === origin && !url.username && !url.password) return url;
	} catch {}
}

/**
 * The entry route a review link from outside the tab may open, on this page's own origin: a
 * batch overview or review desk, without its query, such as the standalone app's `returnTo`,
 * or fragment, since the tab is the way back. Anything else stays a plain link.
 */
export function reviewPath(href: string, origin = location.origin): string | undefined {
	const url = parse(href, origin);
	if (url && ENTRY.test(url.pathname)) return url.pathname;
}

/**
 * A review page the tab may show and save once it is open, with its query and fragment: the
 * routes the embedded review app moves through, such as a batch or a unit, under a project's
 * review prefix on this origin.
 */
export function reviewPagePath(href: string, origin = location.origin): string | undefined {
	const url = parse(href, origin);
	if (!url || !PAGE.test(url.pathname)) return;
	const path = `${url.pathname}${url.search}${url.hash}`;
	if (path.length <= LONGEST) return path;
}
