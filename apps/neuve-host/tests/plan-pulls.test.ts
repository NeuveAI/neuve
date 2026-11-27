import "./fixtures/memory-secrets";
import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pullGithub } from "../src/github";
import { parseHostEnvelope, parseHostFrame } from "../src/parse";
import { requirePullOwner } from "../src/plan-pulls";
import { removePlanWorktree } from "../src/plan-worktree";
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
		if (url.pathname.endsWith("/check-runs")) return Response.json({ check_runs: [] });
		if (url.pathname.endsWith("/status")) return Response.json({ statuses: [] });
		const served = route(url, init ?? {});
		if (!served) throw new Error(`Unexpected request ${init?.method ?? "GET"} ${url}`);
		return served;
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

for (const final of ["closed", "merged"] as const) {
	// All views must receive the same revision, including a check run that changes during a 304.
	test(`three views share conditional requests and reads stop after ${final}`, async () => {
		let reads = 0;
		let runs = 0;
		const log: unknown[] = [];
		const github = transport((url, request) => {
			if (url.pathname.endsWith("/pulls")) {
				expect(url.searchParams.get("head")).toBe(`owner:${branch}`);
				expect(url.searchParams.get("state")).toBe("all");
				return Response.json([detail(7, branch)]);
			}
			if (url.pathname.endsWith("/pulls/7")) {
				reads++;
				const conditional = new Headers(request.headers).get("if-none-match");
				if (reads === 1) {
					expect(conditional).toBeNull();
					return Response.json(detail(7, branch), { headers: { etag: '"open"' } });
				}
				expect(conditional).toBe('"open"');
				return reads === 2 ? new Response(null, { status: 304 }) : Response.json(detail(7, branch, final));
			}
		});
		const instrumented = { ...github, async checks(...args: Parameters<typeof github.checks>) {
			await github.checks(...args);
			return [{ name: "CI", state: ++runs === 1 ? "pending" as const : "passed" as const }];
		} };
		const readers = new PullReaders(instrumented, (_level, event, fields) => {
			if (event === "pull.read") log.push(fields?.status);
		}, { pending: 10, idle: 35 });
		try {
			const views = [updates(readers, branch), updates(readers, branch), updates(readers, branch)];
			await until(() => views.every(view => view.values.at(-1)?.pull?.state === final));
			expect(views[0]!.values).toEqual(views[1]!.values);
			expect(views[0]!.values).toEqual(views[2]!.values);
			expect(views[0]!.values[1]?.pull?.checks).toEqual([{ name: "CI", state: "passed" }]);
			await Bun.sleep(85);
			expect(reads).toBe(3);
			expect(log).toEqual([200, 304, 200]);
		} finally {
			readers.close();
		}
	});
}

test("one existing pull request is adopted and another plan gets its own draft and review", async () => {
	const second = "river/build-second";
	const actions: unknown[] = [];
	let created = false;
	let readied = false;
	let ready = false;
	const github = transport((url, request) => {
		if (url.pathname.endsWith("/pulls") && request.method === "POST") {
			actions.push(JSON.parse(String(request.body)));
			created = true;
			return Response.json(detail(8, second), { status: 201 });
		}
		if (url.pathname.endsWith("/pulls")) {
			const first = url.searchParams.get("head") === `owner:${branch}`;
			return Response.json(first ? [detail(7, branch)] : created ? [detail(8, second)] : []);
		}
		if (url.pathname.endsWith("/pulls/7")) return Response.json(detail(7, branch));
		if (url.pathname.endsWith("/pulls/8")) return Response.json(detail(8, second, "open", !readied));
		if (url.pathname.endsWith("/project")) return Response.json({
			default_branch: "main", allow_squash_merge: true, allow_merge_commit: true, allow_rebase_merge: true,
		});
		if (url.pathname.endsWith("/compare/main...river%2Fbuild-second")) return Response.json({ ahead_by: 1 });
		if (url.pathname === "/graphql") {
			actions.push("ready");
			expect(JSON.parse(String(request.body)).variables).toEqual({ id: "pull-8" });
			readied = true;
			return Response.json({ data: { markPullRequestReadyForReview: { pullRequest: { id: "pull-8" } } } });
		}
	});
	const readers = new PullReaders(github, () => {});
	try {
		const firstView = updates(readers, branch);
		const secondView = updates(readers, second);
		const plan = {
			id: "second", title: "Second plan", open: true, text: async () => "# Second plan",
			ready: (sha: string) => ready && sha === head, merged: async () => {},
		};
		readers.plan(repo, branch, { ...plan, id: "first", text: async () => { throw Error("Adoption must not ask for a body"); } });
		readers.plan(repo, second, plan);
		await until(() => firstView.values.at(-1)?.pull?.number === 7 && secondView.values.at(-1)?.pull?.state === "draft");
		expect(actions).toEqual([{ head: second, base: "main", body: "# Second plan", draft: true, title: "Second plan" }]);
		ready = true;
		readers.plan(repo, second, { ...plan, open: false });
		await until(() => secondView.values.at(-1)?.pull?.state === "open");
		expect(secondView.values.at(-1)?.pull?.number).toBe(8);
		expect(actions.at(-1)).toBe("ready");
	} finally {
		readers.close();
	}
});

test("GitHub refuses a merge when its head moved after the reader observed it", async () => {
	const received: unknown[] = [];
	const github = transport((url, request) => {
		if (url.pathname.endsWith("/pulls")) return Response.json([detail(7, branch)]);
		if (url.pathname.endsWith("/pulls/7")) return Response.json(detail(7, branch));
		if (url.pathname.endsWith("/project")) return Response.json({
			default_branch: "main", allow_squash_merge: true, allow_merge_commit: true, allow_rebase_merge: true,
		});
		if (url.pathname.endsWith("/merge")) {
			received.push(JSON.parse(String(request.body)));
			return Response.json({ message: "Head branch was modified" }, { status: 409 });
		}
	});
	const readers = new PullReaders(github, () => {});
	try {
		const view = updates(readers, branch);
		readers.plan(repo, branch, {
			id: "plan", title: "Plan", open: false, text: async () => "",
			ready: () => false, merged: async () => { throw Error("A refusal must not mark the build merged"); },
		});
		await until(() => view.values.at(-1)?.pull?.sha === head);
		await expect(readers.merge(repo, branch, "plan", 7, "b".repeat(40))).rejects.toThrow("Review its latest head");
		await expect(readers.merge(repo, branch, "plan", 7, head)).rejects.toThrow("Head branch was modified.");
		expect(received).toEqual([{ sha: head, merge_method: "squash" }]);
		expect(view.values.at(-1)?.pull?.state).toBe("open");
	} finally {
		readers.close();
	}
});

test("a successful merge publishes the result and cleans up the matching remote branch", async () => {
	const actions: unknown[] = [];
	const github = transport((url, request) => {
		if (url.pathname.endsWith("/pulls")) return Response.json([detail(7, branch)]);
		if (url.pathname.endsWith("/pulls/7")) return Response.json(detail(7, branch));
		if (url.pathname.endsWith("/project")) return Response.json({
			default_branch: "main", allow_squash_merge: false, allow_merge_commit: true, allow_rebase_merge: true,
		});
		if (url.pathname.endsWith("/merge")) {
			actions.push(JSON.parse(String(request.body)));
			return Response.json({ message: "Pull request merged", merged: true });
		}
		if (url.pathname.includes("/git/ref/heads/")) {
			return Response.json({ object: { sha: head } });
		}
		if (url.pathname.endsWith(`/git/refs/heads/${branch}`) && request.method === "DELETE") {
			actions.push("deleted");
			return new Response(null, { status: 204 });
		}
	});
	const readers = new PullReaders(github, () => {});
	try {
		const view = updates(readers, branch);
		readers.plan(repo, branch, {
			id: "plan", title: "Plan", open: false, text: async () => "", ready: () => false,
			merged: async (number, sha, at) => { actions.push({ number, sha, at }); },
		});
		await until(() => view.values.at(-1)?.pull?.sha === head);
		await Promise.all([readers.merge(repo, branch, "plan", 7, head), readers.merge(repo, branch, "plan", 7, head)]);
		expect(view.values.at(-1)?.pull?.state).toBe("merged");
		expect(actions).toEqual([{ sha: head, merge_method: "merge" }, "deleted", { number: 7, sha: head, at: expect.any(Number) }]);
	} finally {
		readers.close();
	}
});

test("only the verified channel owner can use the merge command", () => {
	const build = `1:${"f".repeat(64)}`;
	const command = { op: "plan-pull-merge", channel: "deadbeefdeadbeef", build, number: 7, head };
	expect(parseHostEnvelope(JSON.stringify({ id: 1, ...command }), "owner")).toEqual({ id: 1, ...command });
	expect(() => parseHostEnvelope(JSON.stringify({ id: 1, ...command, author: "owner" }), "guest")).toThrow();
	expect(() => parseHostEnvelope(JSON.stringify({ id: 1, op: "plan-pull-merged", branch, build, number: 7, head, at: 1 }), "owner")).toThrow();
	expect(() => requirePullOwner({ peer: false, user: "guest" }, "owner", "owner")).toThrow("Only the channel's owner");
	expect(() => requirePullOwner({ peer: true, user: "owner" }, "owner", "owner")).toThrow("Only the channel's owner");
	expect(() => requirePullOwner({ peer: false, user: "agent@1" }, "agent@1", "agent@1")).toThrow("Only the channel's owner");
	expect(() => requirePullOwner({ peer: false, user: "owner" }, "owner", "owner")).not.toThrow();
});

test("pull updates survive host frame parsing", () => {
	const frame = {
		githubPull: { subscription: "1", repo, branch, pull: {
			kind: "prs", number: 7, title: "Plan", url: `https://github.com/${repo}/pull/7`,
			state: "open", author: "owner", created: now, updated: now, labels: [],
			checks: [{ name: "CI", state: "passed" }], sha: head, merge: "ready", review: "approved",
		} },
	};
	expect(parseHostFrame(JSON.stringify(frame))).toEqual(frame);
});

test("cleanup leaves a dirty lane and removes it once clean at the merged head", async () => {
	const root = await mkdtemp(join(tmpdir(), "plan-worktree-"));
	const project = join(root, "project");
	const directory = join(root, "lanes");
	const lane = "build-123";
	const path = join(directory, lane);
	const branch = `river/${lane}`;
	const git = (cwd: string, ...args: string[]) => {
		const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stderr: "pipe" });
		if (result.exitCode !== 0) throw Error(result.stderr.toString());
		return result.stdout.toString().trim();
	};
	try {
		git(root, "init", "-b", "main", project);
		git(project, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "Base");
		git(project, "worktree", "add", "-b", branch, path);
		git(path, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "Work");
		const head = git(path, "rev-parse", "HEAD");
		const input = { project, directory, prefix: "river", lane, path, branch, head };
		const untracked = join(path, "draft.txt");
		await writeFile(untracked, "keep this work");
		expect(await removePlanWorktree(input, () => {})).toBe(false);
		expect(await Bun.file(untracked).text()).toBe("keep this work");
		expect(git(project, "rev-parse", branch)).toBe(head);
		await rm(untracked);
		expect(await removePlanWorktree({ ...input, head: git(project, "rev-parse", "HEAD") }, () => {})).toBe(false);
		expect(existsSync(path)).toBe(true);
		expect(await removePlanWorktree(input, () => {})).toBe(true);
		expect(existsSync(path)).toBe(false);
		expect(git(project, "branch", "--list", branch)).toBe("");
		expect(await removePlanWorktree(input, () => {})).toBe(true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
