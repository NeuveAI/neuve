import { useEffect, useMemo, useReducer } from "react";

import type { Build, GithubPull } from "@ace/channel/protocol";
import { toast } from "@ace/ui";

import { host } from "./host";

/** One branch's pull request: what the host's reader last sent, the views watching it, and its watch. */
type Entry = {
	value?: GithubPull | null;
	views: Set<() => void>;
	listener: (update: { pull: GithubPull | null; error?: string }) => void;
	stop?: () => void;
};

// Kept after the last view leaves, so switching back to a channel shows its pull request at once.
const entries = new Map<string, Entry>();

const key = (repo: string, branch: string) => `${repo}\0${branch}`;

/**
 * Watches one branch's pull request for `view`. The app holds one host watch per branch, opened by
 * its first view and closed by its last; the host reads GitHub once for every app.
 */
function watch(repo: string, branch: string, view: () => void): () => void {
	let entry = entries.get(key(repo, branch));
	if (!entry) {
		const created: Entry = {
			views: new Set(),
			listener: ({ pull, error }) => {
				// A failed read keeps the last pull request shown rather than saying there is none.
				if (error && !pull) return;
				created.value = pull;
				for (const each of created.views) each();
			},
		};
		entries.set(key(repo, branch), entry = created);
	}
	const found = entry;
	found.views.add(view);
	found.stop ??= host.watchPull(repo, branch, found.listener);
	return () => {
		found.views.delete(view);
		if (found.views.size) return;
		found.stop?.();
		found.stop = undefined;
	};
}

/**
 * Asks the host to read a watched branch's pull request now. Watching again does it: the new
 * watch is open before the old one closes, so the host keeps its reader and joins any read under way.
 */
export function readAgain(repo: string, branch: string) {
	const entry = entries.get(key(repo, branch));
	if (!entry?.stop) return;
	const stop = entry.stop;
	entry.stop = host.watchPull(repo, branch, entry.listener);
	stop();
}

window.addEventListener("focus", () => {
	for (const name of entries.keys()) readAgain(...(name.split("\0") as [string, string]));
});

/**
 * The newest pull request from each watched repository and branch, by branch: `null` once read
 * and none exists, absent while unknown. Every view of one branch shares one watch.
 */
export function usePulls(watched: readonly (readonly [repo: string, branch: string])[]): ReadonlyMap<string, GithubPull | null> {
	const [version, render] = useReducer((count: number) => count + 1, 0);
	const list = watched.map(([repo, branch]) => key(repo, branch)).join("\n");
	useEffect(() => {
		if (!list) return;
		const offs = list.split("\n").map((name) => watch(...(name.split("\0") as [string, string]), render));
		return () => offs.forEach((off) => off());
	}, [list]);
	return useMemo(() => {
		const pulls = new Map<string, GithubPull | null>();
		for (const name of list ? list.split("\n") : []) {
			const value = entries.get(name)?.value;
			if (value !== undefined) pulls.set(name.split("\0")[1]!, value);
		}
		return pulls;
		// `version` moves with every update the host sends.
	}, [list, version]);
}

/** The newest pull request from one branch; see `usePulls`. */
export function usePull(repo: string | undefined, branch: string | undefined): GithubPull | null | undefined {
	return usePulls(repo && branch ? [[repo, branch]] : []).get(branch ?? "");
}

/**
 * Merges a plan's pull request through its channel, pinned to the head the card shows, so a newer
 * push is refused. A refusal shows as a toast, and the promise rejects so Merge is offered again.
 */
export function mergePlan(channel: string, user: string, repo: string, build: Build, pull: GithubPull): Promise<void> {
	const { id, branch } = build;
	if (!pull.sha || !branch) return Promise.reject(new Error("No head commit"));
	return host.channel(channel, { op: "build-merge", author: user, build: id, number: pull.number, head: pull.sha }).then(
		() => readAgain(repo, branch),
		(error: Error) => {
			toast.error(`Could not merge #${pull.number}`, { description: error.message });
			throw error;
		},
	);
}
