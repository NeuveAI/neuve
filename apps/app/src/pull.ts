import { useEffect, useMemo, useReducer } from "react";

import type { GithubPull } from "@ace/channel/protocol";
import { toast } from "@ace/ui";

import { host } from "./host";

/** One branch's pull request: what the host's reader last sent, and the views watching it. */
type Entry = { value?: GithubPull | null; views: Set<() => void>; stop?: () => void };

// Kept after the last view leaves, so switching back to a channel shows its pull request at once.
const entries = new Map<string, Entry>();

const key = (repo: string, branch: string) => `${repo}\0${branch}`;

/**
 * Watches one branch's pull request for `view`. The app holds one host subscription per branch,
 * opened by its first view and closed by its last; the host reads GitHub once for every app.
 */
function watch(repo: string, branch: string, view: () => void): () => void {
	let found = entries.get(key(repo, branch));
	if (!found) entries.set(key(repo, branch), found = { views: new Set() });
	const entry = found;
	entry.views.add(view);
	entry.stop ??= host.watchPull(repo, branch, ({ pull, error }) => {
		// A failed read keeps the last pull request shown rather than saying there is none.
		if (error && !pull) return;
		entry.value = pull;
		for (const each of entry.views) each();
	});
	return () => {
		entry.views.delete(view);
		if (entry.views.size) return;
		entry.stop?.();
		entry.stop = undefined;
	};
}

/**
 * The newest pull request from each of `branches`, by branch: `null` once read and none exists,
 * absent while unknown. Every view of one branch shares one subscription.
 */
export function usePulls(repo: string | undefined, branches: readonly string[]): ReadonlyMap<string, GithubPull | null> {
	const [version, render] = useReducer((count: number) => count + 1, 0);
	const list = branches.join("\0");
	useEffect(() => {
		if (!repo || !list) return;
		const offs = list.split("\0").map((branch) => watch(repo, branch, render));
		return () => offs.forEach((off) => off());
	}, [repo, list]);
	return useMemo(() => {
		const pulls = new Map<string, GithubPull | null>();
		if (!repo || !list) return pulls;
		for (const branch of list.split("\0")) {
			const value = entries.get(key(repo, branch))?.value;
			if (value !== undefined) pulls.set(branch, value);
		}
		return pulls;
		// `version` moves with every update the host sends.
	}, [repo, list, version]);
}

/** The newest pull request from one branch; see `usePulls`. */
export function usePull(repo: string | undefined, branch: string | undefined): GithubPull | null | undefined {
	return usePulls(repo, branch ? [branch] : []).get(branch ?? "");
}

/**
 * Merges a plan's pull request through the host, pinned to the head the card shows, so a newer
 * push is refused. The host's refusal shows as a toast, and the promise rejects so Merge is
 * offered again.
 */
export function mergePlan(channel: string, build: string, pull: GithubPull): Promise<void> {
	if (!pull.sha) return Promise.reject(new Error("No head commit"));
	return host.request({ op: "plan-pull-merge", channel, build, number: pull.number, head: pull.sha }).then(
		() => {},
		(error: Error) => {
			toast.error(`Could not merge #${pull.number}`, { description: error.message });
			throw error;
		},
	);
}
