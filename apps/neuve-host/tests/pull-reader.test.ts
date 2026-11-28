import "./fixtures/memory-secrets";
import { expect, test } from "bun:test";

import { pullGithub, remote } from "../src/github";
import { parseHostEnvelope, parseHostFrame } from "../src/parse";
import { PullReaders } from "../src/pull-reader";
import type { PullUpdate } from "../src/protocol";

const repo = "owner/project";
const branch = "river/build-first";
const head = "a".repeat(40);
const now = "2026-11-27T12:00:00Z";

function detail(number: number, branch: string, state: "open" | "closed" | "merged" = "open", draft = false) {
	return {
		number, head: { ref: branch, sha: head, repo: { full_name: repo } },
		node_id: `pull-${number}`, title: "Export retries", html_url: `https://github.com/${repo}/pull/${number}`,
		draft, state: state === "merged" ? "closed" : state, merged_at: state === "merged" ? now : null,
		mergeable: true, mergeable_state: draft ? "draft" : "clean", labels: [],
		user: { login: "owner" }, created_at: now, updated_at: now,
	};
}

function transport(route: (url: URL, etag: string | null) => Response | undefined) {
	return pullGithub(async (args, _body, _cwd, signal) => {
		signal?.throwIfAborted();
		expect(args[0]).toBe("api");
		if (args[1] === "graphql") {
			expect(args.join(" ")).toContain("reviewDecision");
			expect(args.slice(-2)).toEqual(["--jq", ".data.node.reviewDecision"]);
			return { out: "APPROVED\n", error: "", code: 0 };
		}
		expect(args[1]).toBe("-i");
		const url = new URL(args.at(-1)!, "https://api.github.com");
		const etag = args[args.indexOf("-H") + 1]?.match(/^If-None-Match: (.+)$/)?.[1] ?? null;
		const response = route(url, etag)
			?? (url.pathname.endsWith("/check-runs") ? Response.json({ check_runs: [] })
				: url.pathname.endsWith("/status") ? Response.json({ statuses: [] }) : undefined);
		if (!response) throw new Error(`Unexpected request ${url}`);
		const { status } = response;
		const headers = [...response.headers].map(([name, value]) => `${name === "etag" ? "ETag" : name}: ${value}\r\n`).join("");
		return {
			out: `HTTP/2.0 ${status} ${status === 304 ? "Not Modified" : "OK"}\n${headers}\r\n${await response.text()}`,
			code: status === 304 ? 1 : 0, error: status === 304 ? "gh: HTTP 304" : "",
		};
	});
}

async function until(predicate: () => boolean) {
	for (let i = 0; i < 200; i++) {
		if (predicate()) return;
		await Bun.sleep(5);
	}
	throw new Error("The expected pull request update never arrived.");
}

function updates(readers: PullReaders, branch: string) {
	const values: PullUpdate[] = [];
	const stop = readers.watch(repo, branch, value => values.push(value));
	return { values, stop };
}

test("pull updates survive host frame parsing", () => {
	const frame = {
		githubPull: { subscription: "1", repo, branch, pull: {
			kind: "prs", number: 7, title: "Plan", url: `https://github.com/${repo}/pull/7`,
			state: "open", author: "owner", created: now, updated: now, labels: [],
			checks: [{ name: "CI", state: "passed" }], sha: head, merge: "ready", review: "approved",
		} },
	};
	expect(parseHostFrame(JSON.stringify(frame))).toEqual(frame);
	const channels = { channels: [{
		id: "river", host: "local", name: "river", owner: "owner", project: "/project",
		created: 1, state: "dormant", plans: { branches: [branch], ready: true, humanRequired: 2, waiting: true },
	}] };
	expect(parseHostFrame(JSON.stringify(channels))).toEqual(channels);
});

test("merge crosses the channel request boundary with the verified person's identity", () => {
	const request = { op: "build-merge", author: "claimed", build: `1:${"a".repeat(64)}`, number: 7, head };
	const envelope = { id: 1, op: "channel", channel: "river", request };
	expect(parseHostEnvelope(JSON.stringify(envelope), "owner")).toEqual({
		...envelope, request: { ...request, author: "owner" },
	});
	expect(() => parseHostEnvelope(JSON.stringify({
		id: 1, channel: "river", op: "plan-pull-merge", build: request.build, number: 7, head,
	}), "owner")).toThrow();
});

test("overlapping watches share a conditional refresh and see the latest checks", async () => {
	const details: (string | null)[] = [];
	const checks: (string | null)[] = [];
	let finds = 0;
	const github = transport((url, tag) => {
		if (url.pathname.endsWith("/pulls")) {
			finds++;
			expect(url.searchParams.get("head")).toBe(`owner:${branch}`);
			return Response.json([detail(7, branch)]);
		}
		if (url.pathname.endsWith("/pulls/7")) {
			details.push(tag);
			return tag === '"open"' ? new Response(null, { status: 304 })
				: Response.json(detail(7, branch), { headers: { etag: '"open"' } });
		}
		if (url.pathname.endsWith("/check-runs")) {
			checks.push(tag);
			return Response.json({ check_runs: [{
				name: "CI", details_url: null, status: tag ? "completed" : "in_progress", conclusion: tag ? "success" : null,
			}] }, { headers: { etag: tag ? '"passed"' : '"pending"' } });
		}
	});
	const readers = new PullReaders(github, () => {});
	try {
		const card = updates(readers, branch);
		const detailsPanel = updates(readers, branch);
		const sidebar = updates(readers, branch);
		await until(() => sidebar.values.at(-1)?.pull?.checks[0]?.state === "pending");
		const focus = updates(readers, branch);
		const repeated = updates(readers, branch);
		focus.stop();
		repeated.stop();
		await until(() => sidebar.values.at(-1)?.pull?.checks[0]?.state === "passed");
		expect(card.values).toEqual(sidebar.values);
		expect(detailsPanel.values).toEqual(sidebar.values);
		expect(sidebar.values.at(-1)?.pull).toMatchObject({ number: 7, state: "open", sha: head, review: "approved", merge: "ready" });
		expect(details).toEqual([null, '"open"']);
		expect(checks).toEqual([null, '"pending"']);
		expect(finds).toBe(1);
	} finally {
		readers.close();
	}
});

test("a repeat watch discovers a newly published draft in the channel repository", async () => {
	let published = false;
	const reads: (string | null)[] = [];
	const github = transport((url, tag) => {
		if (url.pathname.endsWith("/pulls")) {
			reads.push(tag);
			const fork = detail(99, branch);
			fork.head.repo.full_name = "owner/fork";
			return published ? Response.json([fork, detail(7, branch, "open", true)])
				: Response.json([fork], { headers: { etag: '"missing"' } });
		}
		if (url.pathname.endsWith("/pulls/7")) return Response.json(detail(7, branch, "open", true));
	});
	const readers = new PullReaders(github, () => {});
	try {
		const card = updates(readers, branch);
		await until(() => card.values.length === 1);
		expect(card.values).toEqual([{ pull: null }]);
		published = true;
		const refreshed = updates(readers, branch);
		await until(() => card.values.at(-1)?.pull?.state === "draft");
		expect(refreshed.values).toEqual(card.values);
		expect(card.values.at(-1)?.pull?.number).toBe(7);
		expect(reads).toEqual([null, '"missing"']);
	} finally {
		readers.close();
	}
});

test("a watch discovers a replacement after the previous pull request merged", async () => {
	let replacement = false;
	const gitHub = transport(url => {
		if (url.pathname.endsWith("/pulls")) return Response.json(replacement
			? [detail(8, branch), detail(7, branch, "merged")] : [detail(7, branch, "merged")]);
		if (url.pathname.endsWith("/pulls/7")) return Response.json(detail(7, branch, "merged"));
		if (url.pathname.endsWith("/pulls/8")) return Response.json(detail(8, branch));
	});
	const readers = new PullReaders(gitHub, () => {});
	try {
		const card = updates(readers, branch);
		await until(() => card.values.at(-1)?.pull?.state === "merged");
		replacement = true;
		const reopened = updates(readers, branch);
		await until(() => reopened.values.at(-1)?.pull?.number === 8);
		expect(card.values.map(value => value.pull?.state)).toEqual(["merged", "open"]);
		expect(readers.current(repo, branch)?.number).toBe(8);
	} finally {
		readers.close();
	}
});

test.each(["closed", "merged"] as const)("a watched pull request stops refreshing when it is %s", async state => {
	let reads = 0;
	const github = transport(url => {
		if (url.pathname.endsWith("/pulls")) return Response.json([detail(7, branch)]);
		if (url.pathname.endsWith("/pulls/7")) return Response.json(detail(7, branch, ++reads === 1 ? "open" : state));
	});
	const readers = new PullReaders(github, () => {}, undefined, { pending: 10, idle: 10 });
	try {
		const card = updates(readers, branch);
		await until(() => card.values.at(-1)?.pull?.state === state);
		await Bun.sleep(50);
		expect(card.values.map(value => value.pull?.state)).toEqual(["open", state]);
		expect(reads).toBe(2);
	} finally {
		readers.close();
	}
});

test("the reader stops refreshing when the last view leaves", async () => {
	let reads = 0;
	const github = transport(url => {
		if (url.pathname.endsWith("/pulls")) return Response.json([detail(7, branch)]);
		if (url.pathname.endsWith("/pulls/7")) {
			reads++;
			return Response.json(detail(7, branch));
		}
	});
	const readers = new PullReaders(github, () => {}, undefined, { pending: 10, idle: 10 });
	try {
		const card = updates(readers, branch);
		const sidebar = updates(readers, branch);
		await until(() => sidebar.values.length > 0);
		card.stop();
		await until(() => reads >= 2);
		sidebar.stop();
		const stoppedAt = reads;
		await Bun.sleep(50);
		expect(reads).toBe(stoppedAt);
		expect(readers.current(repo, branch)).toBeUndefined();
	} finally {
		readers.close();
	}
});

test("the channel repository is origin even when gh has chosen upstream", () => {
	expect(remote([
		"remote.upstream.url git@github.com:other/project.git",
		"remote.upstream.gh-resolved base",
		"remote.origin.url git@github.com:Owner/Project.git",
	].join("\n"))).toBe("owner/project");
});
