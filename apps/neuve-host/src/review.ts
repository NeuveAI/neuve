import { observeJudgementBranch } from "./judgement-hooks";
import { realpath } from "node:fs/promises";
import { basename } from "node:path";
import { ReviewRefusalError } from "@ace/channel/review-protocol";
import { reviewPaths } from "./app-gateway";
import type { ReviewCard } from "@ace/channel/review-cards";
import type { ReviewFeedSnapshot } from "./review-protocol";
import {githubRef} from "./external-ref";
import type { ReviewTarget, ReviewSnapshot, NativeHandoff, PreparedReview } from "./review-protocol";
import { GitHubExternalRefSchema, ExternalReviewSourceSchema, type GitHubExternalRef } from "@neuve/records-schema";
import { hostname } from "node:os";
import * as github from "./review-github";
import * as projects from "./review-projects";
import type { PlanningState } from "@ace/channel/planning";
import type { Changes, ChannelInfo } from "@ace/channel/protocol";

import * as catalog from "./catalog";
import type { Connection } from "./client";
import { git } from "./review-projects";
import type { ReviewHandoff, LaneReviewHandoff, PullReviewHandoff, ReviewReceipt } from "./extension-protocol";

export type Review = (handoff: ReviewHandoff) => Promise<ReviewReceipt>;

/**
 * Paths Git reports as changed or untracked in a checkout, and the commit they were compared to,
 * from one `git status` so the two describe the same moment. Unlike `changes`, whose file list
 * stops at a display cap, this counts every path; an untracked directory counts once.
 */
async function loose(cwd: string): Promise<{ head: string; paths: number }> {
	const result = await git(cwd, [
		"--no-optional-locks",
		"status",
		"--porcelain=v2",
		"--branch",
		"--untracked-files=normal",
		"-z",
	]);
	if (result.status !== 0) {
		throw new Error(result.stderr.trim() || `Could not read the status of ${cwd}`);
	}
	const fields = result.stdout.split("\0");
	let head = "";
	let paths = 0;
	for (let i = 0; i < fields.length; i++) {
		const field = fields[i]!;
		if (field.startsWith("# branch.oid ")) head = field.slice("# branch.oid ".length);
		else if (field && !field.startsWith("# ")) {
			paths++;
			// A rename or copy is followed by its original path as a field of its own.
			if (field.startsWith("2 ")) i++;
		}
	}
	return { head, paths };
}

/**
 * What a chat's lane holds for review: its commits from where it forked to its head. Work only on
 * disk is not in that history, so a lane with any is refused instead of reviewed partially; Git's
 * own status decides that, not the Diff's capped file list.
 */
export async function handoff(
	channel: string,
	chat: number | undefined,
	connection: Connection,
	items: GitHubExternalRef[] = [],
): Promise<LaneReviewHandoff> {
	const info = await connection.request<ChannelInfo>({ op: "info" });
	const id = chat ?? info.chats.find((value) => value.parent === undefined)?.id;
	if (id === undefined || !info.chats.some((value) => value.id === id)) {
		throw new Error(`No chat ${chat}`);
	}
	const changes = await connection.request<Changes>({ op: "changes", chat: id });
	if (!changes.lane) throw new ReviewRefusalError("no_lane", "This chat has no lane to review");
	const { head, paths: count } = await loose(changes.cwd);
	if (head !== changes.head) {
		throw new ReviewRefusalError("source_moved", `Lane ${changes.lane} moved while its review was prepared; try again`);
	}
	if (count) {
		throw new ReviewRefusalError(
			"uncommitted_changes",
			`Lane ${changes.lane} has ${count} uncommitted or untracked ${
				count === 1 ? "path" : "paths"
			}; commit or remove ${count === 1 ? "it" : "them"} before review`,
		);
	}
	if (changes.base === changes.head) throw new ReviewRefusalError("nothing_to_review", `Lane ${changes.lane} has no commits to review`);
	const planning = await connection.request<PlanningState>({ op: "planning-state", chat: id });
	if (planning.selection && planning.selection.lane !== changes.lane) throw new ReviewRefusalError("scope_mismatch", "The selected Linear scope belongs to another lane");
	const known = await connection.request<unknown[]>({ op: "review-origin", chat: id });
	const refs = references([...known.map(githubRef),...items]);
	const sources = await Promise.all(refs.map(item => github.body(item).then(value => ExternalReviewSourceSchema.parse(value))));
	return {
		origin: { kind: "channel", host: hostname(), channel, chat: id, lane: changes.lane, items: refs },
		externalSources: sources,
		...(planning.selection ? { source: planning.selection.source } : {}),
		channel,
		chat: id,
		project: catalog.read(channel).project,
		cwd: changes.cwd,
		lane: changes.lane,
		...(changes.branch ? { branch: changes.branch } : {}),
		...(changes.against ? { against: changes.against } : {}),
		base: changes.base,
		head: changes.head,
	};
}

function references(items: GitHubExternalRef[]): GitHubExternalRef[] {
	const refs = new Map<string,GitHubExternalRef>();
	for (const item of items) {
		const value = GitHubExternalRefSchema.parse(item);
		refs.set(`${value.repo.toLowerCase()}:${value.kind}:${value.number}`,value);
	}
	if (refs.size > 16) throw new Error("A review can reference at most 16 external items.");
	return [...refs.values()];
}

/** Fetch exact provider objects, without changing refs, branches, index or checkout files. */
export async function acquirePull(project: string, source: github.GithubPullDescriptor): Promise<{ base: string; head: string }> {
	await projects.validateRepository(project);
	const localRepo = await projects.repository(project);
	if (localRepo !== source.baseRepo.toLowerCase() && localRepo !== source.headRepo.toLowerCase()) throw new ReviewRefusalError("pull_request_unavailable", "The selected project does not match this pull request's base or head repository.");
	let didFetch = false;
	for (const [repo,oid] of [[source.baseRepo,source.baseOid],[source.headRepo,source.headOid]]) {
		if (!repo || !oid) throw new ReviewRefusalError("pull_request_unavailable", "The pull request is missing its immutable source identity.");
		const present = await git(project,["cat-file", "-e",`${oid}^{commit}`]);
		if (present.status !== 0) {
			const fetched = await git(project,["fetch", "--no-tags", "--no-write-fetch-head", `https://github.com/${github.repository(repo)}.git`,oid]);
			if (fetched.status !== 0) throw new ReviewRefusalError("pull_request_unavailable", fetched.stderr.trim() || `Could not acquire the pull request commit ${oid}`);
			didFetch = true;
		}
		const verified = await git(project,["rev-parse", "--verify", "--end-of-options",`${oid}^{commit}`]);
		if (verified.status !== 0 || verified.stdout.trim() !== oid) throw new ReviewRefusalError("pull_request_unavailable", `The exact pull request commit ${oid} is unavailable.`);
	}
	const merged = await git(project,["merge-base",source.baseOid,source.headOid]);
	if (merged.status !== 0 || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(merged.stdout.trim())) throw new ReviewRefusalError("pull_request_unavailable", "The pull request's immutable base and head do not have an available merge base.");
	await observeJudgementBranch({ project, branch: source.headRef, base: merged.stdout.trim(), head: source.headOid, reviewed: false, openPullRequest: source.state === "open", trigger: didFetch ? "fetch" : "pull-request" });
	return { base: merged.stdout.trim(), head: source.headOid };
}
export async function pullHandoff(project: string, repo: string, number: number, expectedHead?: string): Promise<PullReviewHandoff> {
	const root = (await projects.checkout(project)).root;
	const connected = (await projects.list()).find(value => value.path === root);
	if (!connected) throw new ReviewRefusalError("pull_request_unavailable", "Open the pull request's project on this host first.");
	const descriptor = await github.descriptor(repo,number);
	if (expectedHead && expectedHead !== descriptor.headOid) throw new ReviewRefusalError("pull_request_changed", "This pull request changed since it was shown. Refresh it before starting review.");
	const range = await acquirePull(project,descriptor);
	const item = GitHubExternalRefSchema.parse({ provider: "github", repo: descriptor.repo, kind: "pull-request", number: descriptor.number, url: descriptor.url });
	const source = ExternalReviewSourceSchema.parse({ item, title: descriptor.title, text: descriptor.body, version: descriptor.updatedAt, fetchedAt: descriptor.fetchedAt, complete: true });
	return { project, cwd: project, base: range.base, head: range.head, against: descriptor.baseOid, origin: { kind: "external", host: hostname(), items: [item], display: { project: connected.name, branch: descriptor.headRef, base: descriptor.baseRef } }, externalSources: [source] };
}

/** Display lookup cannot refuse an otherwise valid review. */
async function projectNameFor(project: string): Promise<string> {
	try {
		const { root } = await projects.checkout(project);
		return (await projects.list()).find(value => value.path === root)?.name || basename(root) || root;
	} catch {
		return basename(project) || project;
	}
}

/** Native admission never requests a read or write from its calling worker. */
export async function nativeHandoff(
	channel: string,
	target: ReviewTarget,
	snapshot: ReviewSnapshot,
): Promise<NativeHandoff> {
	if (!catalog.owns(channel))
		throw new Error("This channel does not belong to this host");
	const project = catalog.read(channel).project;
	const projectName = await projectNameFor(project);
	const origin = {
		kind: "channel" as const,
		host: hostname(),
		channel,
		chat: snapshot.chat,
		items: references(snapshot.items),
	};
	if (target.kind === "pull-request") {
		const value = await pullHandoff(
			project,
			target.repo,
			target.number,
			target.expectedHead,
		);
		return {
			...value,
			channel,
			chat: snapshot.chat,
			origin: { ...origin, items: value.origin.items, display: value.origin.display },
		};
	}
	const lane = target.kind === "lane" ? snapshot.lane : null;
	if (target.kind === "lane" && !lane)
		throw new ReviewRefusalError("no_lane", "This chat has no lane to review");
	const cwd = lane ? await lanePath(channel, lane.name, lane.path) : project;
	const status = await loose(cwd);
	if (status.paths)
		throw new ReviewRefusalError(
			"uncommitted_changes",
			`The review source has ${status.paths} uncommitted or untracked ${status.paths === 1 ? "path" : "paths"}; commit or remove ${status.paths === 1 ? "it" : "them"} before review`,
		);
	const branchRead = await git(cwd, [
		"symbolic-ref",
		"--quiet",
		"--short",
		"HEAD",
	]);
	const branch = branchRead.status === 0 ? branchRead.stdout.trim() : undefined;
	let against =
		lane?.base ??
		(target.kind === "project-branch" ? target.against : undefined);
	if (!against) {
		if (!branch)
			throw new ReviewRefusalError(
				"no_comparison_base",
				"Detached project HEAD requires an explicit against comparison base",
			);
		const defaultRef = await git(project, [
			"symbolic-ref",
			"--quiet",
			"refs/remotes/origin/HEAD",
		]);
		if (defaultRef.status === 0) against = defaultRef.stdout.trim();
		else {
			const main = await git(project, [
				"rev-parse",
				"--verify",
				"--end-of-options",
				"refs/heads/main^{commit}",
			]);
			if (main.status === 0) against = "refs/heads/main";
		}
	}
	if (!against)
		throw new ReviewRefusalError(
			"no_comparison_base",
			"No local default comparison base is available. Supply target.against explicitly",
		);
	const baseCommit = await commit(cwd, against);
	const baseRead = await git(cwd, ["merge-base", baseCommit, status.head]);
	if (baseRead.status !== 0)
		throw new ReviewRefusalError(
			"no_comparison_base",
			"The comparison base and HEAD have no available merge base",
		);
	const base = baseRead.stdout.trim();
	if (base === status.head)
		throw new ReviewRefusalError("nothing_to_review", "The selected range has no commits to review");
	if (
		lane &&
		snapshot.planning.selection &&
		snapshot.planning.selection.lane !== lane.name
	)
		throw new ReviewRefusalError("scope_mismatch", "The selected Linear scope belongs to another lane");
	const externalSources = await Promise.all(
		origin.items.map((item) =>
			github
				.body(item)
				.then((value) => ExternalReviewSourceSchema.parse(value)),
		),
	);
	return {
		project,
		cwd,
		channel,
		chat: snapshot.chat,
		...(lane ? { lane: lane.name } : {}),
		...(branch ? { branch } : {}),
		against,
		base,
		head: status.head,
		origin: { ...origin, ...(lane ? { lane: lane.name } : {}), display: { project: projectName, ...(branch ? { branch } : {}), base: against } },
		externalSources,
		...(lane && snapshot.planning.selection
			? { source: snapshot.planning.selection.source }
			: {}),
	};
}
async function lanePath(
	channel: string,
	name: string,
	path: string,
): Promise<string> {
	const { realpath } = await import("node:fs/promises");
	const { resolve, sep } = await import("node:path");
	const root = await realpath(catalog.paths(channel).lanes);
	const actual = await realpath(path);
	if (
		!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name) ||
		actual !== resolve(root, name) ||
		!actual.startsWith(root + sep)
	)
		throw new Error("The lane path does not belong to this channel");
	return actual;
}
async function commit(cwd: string, revision: string): Promise<string> {
	const result = await git(cwd, [
		"rev-parse",
		"--verify",
		"--end-of-options",
		`${revision}^{commit}`,
	]);
	if (
		result.status !== 0 ||
		!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(result.stdout.trim())
	)
		throw new ReviewRefusalError("no_comparison_base", "The requested comparison commit is unavailable");
	return result.stdout.trim();
}
export async function validateNative(
	channel: string,
	prepared: PreparedReview,
	current: boolean,
): Promise<void> {
	if (!catalog.owns(channel))
		throw new Error("This channel does not belong to this host");
	const h = prepared.handoff;
	if (h.channel !== channel || h.project !== catalog.read(channel).project)
		throw new Error(
			"The prepared review belongs to another project or channel",
		);
	if (
		h.origin.kind === "channel" &&
		(h.origin.channel !== channel ||
			h.origin.chat !== h.chat ||
			h.origin.lane !== h.lane)
	)
		throw new Error("The review provenance does not match its caller");
	if (prepared.target.kind === "lane" && !h.lane)
		throw new Error("A lane review requires its bound lane");
	const cwd =
		prepared.target.kind === "lane" && h.lane
			? await lanePath(channel, h.lane, h.cwd)
			: h.project;
	if (cwd !== h.cwd || (prepared.target.kind !== "lane" && h.lane))
		throw new Error("The prepared source path does not match its target");
	if (
		(await commit(cwd, h.base)) !== h.base ||
		(await commit(cwd, h.head)) !== h.head ||
		h.base === h.head
	)
		throw new Error("The pinned review range is unavailable or empty");
	if (current && prepared.target.kind !== "pull-request") {
		const status = await loose(cwd);
		if (status.head !== h.head)
			throw new ReviewRefusalError(
				"source_moved",
				"The review source moved after preparation; request a fresh review",
			);
		if (status.paths)
			throw new ReviewRefusalError("uncommitted_changes", "The review source has uncommitted or untracked paths");
	}
}

export async function projectReviewCard(card: Extract<ReviewCard, { kind: "review" }>, snapshot: ReviewFeedSnapshot, at: number): Promise<Extract<ReviewCard, { kind: "review" }>> {
	if (snapshot.review !== card.review) throw new Error("Records feed returned a different review request");
	const progress = snapshot.progress;
	let project: string;
	try { project = await realpath(snapshot.project); }
	catch { throw new ReviewRefusalError("not_connected", "The review project is temporarily unavailable."); }
	return {
		...card,
		phase: progress.phase,
		stages: snapshot.stages,
		stage: progress.phase === "running" ? progress.stage : null,
		finished: progress.phase === "finished" ? progress.finished : null,
		stopped: progress.phase === "stopped" ? { reason: progress.reason } : null,
		links: reviewPaths(project, snapshot.cycle),
		updatedAt: at,
	};
}

/** Pin the person's notification choice before admission, including a lost admission reply. */
export async function rememberReviewNotification(directory: string, review: string, notify: boolean, branch = "", head?: string): Promise<boolean> {
	const { mkdir, writeFile, readFile, link, rm } = await import("node:fs/promises");
	const { join } = await import("node:path");
	const { randomUUID } = await import("node:crypto");
	const { z } = await import("zod");
	const schema = z.strictObject({ review: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/), notify: z.boolean(), branch: z.string(), head: z.string().optional() });
	const value = schema.parse({ review, notify, branch, ...(head ? { head } : {}) });
	const root = join(directory, "review-admissions");
	await mkdir(root, { recursive: true, mode: 0o700 });
	const path = join(root, `${value.review}.json`);
	const temporary = join(root, `${value.review}.${randomUUID()}.tmp`);
	try {
		await writeFile(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 });
		try { await link(temporary, path); }
		catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
		const saved = schema.parse(JSON.parse(await readFile(path, "utf8")));
		if (saved.review !== review || saved.notify !== notify || saved.branch !== branch || saved.head !== head) throw new Error("Records admission identity was reused with a different notification choice");
		return saved.notify;
	} finally { await rm(temporary, { force: true }); }
}

/** Status reads the same branch captured at admission, even after the checkout switches branches. */
export async function reviewHasNewCommits(directory: string, review: string, project: string): Promise<boolean> {
	const { readFile } = await import("node:fs/promises");
	const { join } = await import("node:path");
	const { z } = await import("zod");
	const id = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/).parse(review);
	let raw: string;
	try { raw = await readFile(join(directory, "review-admissions", `${id}.json`), "utf8"); }
	catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return false; throw error; }
	const saved = z.object({ review: z.literal(id), branch: z.string(), head: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/).optional() }).parse(JSON.parse(raw));
	if (!saved.branch || !saved.head) return false;
	const current = await git(project, ["rev-parse", "--verify", "--end-of-options", `refs/heads/${saved.branch}^{commit}`]);
	const head = current.stdout.trim();
	return current.status === 0 && head !== saved.head && (await git(project, ["merge-base", "--is-ancestor", saved.head, head])).status === 0;
}
