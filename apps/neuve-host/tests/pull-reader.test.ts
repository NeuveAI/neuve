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

function transport(route: (url: URL, request: RequestInit) => Response | undefined) {
	return pullGithub(Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		const url = new URL(String(input));
		expect(url.origin).toBe("https://api.github.com");
		expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fake");
		if (url.pathname === "/graphql" && String(init?.body).includes("reviewDecision")) {
			return Response.json({ data: { node: { reviewDecision: "APPROVED" } } });
		}
		const served = route(url, init ?? {});
		if (served) return served;
		if (url.pathname.endsWith("/check-runs")) return Response.json({ check_runs: [] });
		if (url.pathname.endsWith("/status")) return Response.json({ statuses: [] });
		throw new Error(`Unexpected request ${init?.method ?? "GET"} ${url}`);
	}, { preconnect: () => {} }), async () => "fake");
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
	const github = transport((url, request) => {
		const tag = new Headers(request.headers).get("if-none-match");
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
	const github = transport((url, request) => {
		if (url.pathname.endsWith("/pulls")) {
			reads.push(new Headers(request.headers).get("if-none-match"));
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

test("the channel repository is origin even when gh has chosen upstream", () => {
	expect(remote([
		"remote.upstream.url git@github.com:other/project.git",
		"remote.upstream.gh-resolved base",
		"remote.origin.url git@github.com:Owner/Project.git",
	].join("\n"))).toBe("owner/project");
});
