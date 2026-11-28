import { gitArgs } from "@ace/channel/git";
import type {
	GithubCheck,
	GithubComment,
	GithubDetail,
	GithubFile,
	GithubItem,
	GithubKind,
	GithubList,
	GithubPull,
} from "@ace/channel/protocol";

import { z } from "zod";

import { githubEnv } from "./keys";
import { githubRepo, type HostRequest, NOT_GITHUB } from "./protocol";

const REPO = /^[a-z\d][a-z\d-]*\/[a-z\d_.-]+$/i;
const FIELDS = "number,title,url,state,author,createdAt,updatedAt,labels";

type Item = {
	number: number;
	title: string;
	url: string;
	state: "OPEN" | "CLOSED" | "MERGED";
	isDraft?: boolean;
	author: { login: string } | null;
	createdAt: string;
	updatedAt: string;
	labels: { name: string; color: string }[];
	headRefName?: string;
	isCrossRepository?: boolean;
};
type Comment = {
	id: string;
	url: string;
	author: { login: string } | null;
	body: string;
	createdAt: string;
};
type Review = Omit<Comment, "createdAt" | "url"> & {
	submittedAt: string;
	state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";
};
type Detail = Item & {
	body: string;
	comments: Comment[];
	reviews?: Review[];
	baseRefName?: string;
	additions?: number;
	deletions?: number;
	changedFiles?: number;
	reviewDecision?: string;
};
type Check =
	| {
		__typename: "CheckRun";
		name: string;
		detailsUrl?: string;
		status: string;
		conclusion: string;
	}
	| { __typename: "StatusContext"; context: string; targetUrl?: string; state: string };
type File = {
	filename: string;
	previous_filename?: string;
	status: string;
	additions: number;
	deletions: number;
	patch?: string;
};

function validRepository(value: string): boolean {
	return REPO.test(value) && ![".", ".."].includes(value.split("/")[1]!);
}

export function repository(value: string): string {
	if (!validRepository(value)) {
		throw new Error("Choose a GitHub repository in owner/name format");
	}
	return value;
}

/** GitHub hides what this host's account can't read, and collaborator permissions from readers. */
const MISSING = /HTTP 404|Not Found/;
const PUSH = /HTTP 403/;

/**
 * Whether `login` can read `repo`, as this host's gh account sees it: a public repository is
 * readable by everyone, even without a known login, this host's own account by reading it, and anyone else through their
 * collaborator permission, which GitHub shows only to accounts that can push; without push, others
 * can't be confirmed and get false. Throws when GitHub can't answer, so callers decide how long to
 * trust that.
 */
export async function readable(repo: string, login?: string): Promise<boolean> {
	const path = `repos/${repository(repo)}`;
	const found = await gh<{ private: boolean }>(["api", path]).catch((error: Error) => {
		if (MISSING.test(error.message)) return undefined;
		throw error;
	});
	if (!found) return false;
	if (!found.private) return true;
	if (!login || !/^[A-Za-z0-9-]{1,39}$/.test(login)) return false;
	if (login.toLowerCase() === owner?.toLowerCase()) return true;
	const { permission } = await gh<{ permission: string }>([
		"api",
		`${path}/collaborators/${login}/permission`,
	]).catch((error: Error) => {
		if (MISSING.test(error.message) || PUSH.test(error.message)) return { permission: "none" };
		throw error;
	});
	return permission !== "none";
}

/**
 * Whether GitHub finds `repo` for this host's gh account. It answers not found for private
 * repositories the account can't read, and `gh pr list --search` returns nothing for them instead
 * of failing. Other failures throw, so the lists can show them.
 */
export async function found(repo: string): Promise<boolean> {
	return gh(["api", `repos/${repository(repo)}`, "--jq", ".id"]).then(
		() => true,
		(error: Error) => {
			if (MISSING.test(error.message)) return false;
			throw error;
		},
	);
}

/** A GitHub repository URL, SSH remote, or owner/name, as a valid owner/name. */
export function parse(value: string): string {
	const repo = githubRepo(value);
	if (!repo) throw new Error(NOT_GITHUB);
	return repository(repo);
}

function command(kind: GithubKind): "issue" | "pr" {
	if (kind === "issues") return "issue";
	if (kind === "prs") return "pr";
	throw new Error("Choose issues or pull requests");
}

function number(value: number): string {
	if (!Number.isSafeInteger(value) || value < 1) throw new Error("Invalid GitHub item number");
	return String(value);
}

/** GitHub's GraphQL errors as a sentence; GitHub answers this way for private repositories too. */
function sentence(error: string): string {
	const repo = /Could not resolve to a Repository with the name '([^']+)'/.exec(error)?.[1];
	if (repo) {
		return `GitHub didn't find ${repo} for this host's GitHub account. Check that the project's origin names the right repository and that the account signed in with gh can read it; a pending invitation must be accepted first.`;
	}
	return error.replace(/^GraphQL: /, "GitHub refused the request: ");
}

/** The environment gh runs in: this host's GitHub token, github.com, and no prompts. */
export function environment(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		...githubEnv(),
		GH_HOST: "github.com",
		GH_PROMPT_DISABLED: "1",
		GH_PAGER: "cat",
	};
	delete env.GH_REPO;
	return env;
}

async function spawnGh(args: string[], body?: string, cwd?: string) {
	const path = Bun.which("gh", { PATH: process.env.PATH });
	if (!path) throw new Error("Install GitHub CLI on this host, then sign in with gh auth login.");
	const child = Bun.spawn([path, ...args], {
		cwd,
		env: environment(),
		stdin: body === undefined ? "ignore" : new Blob([body]),
		stdout: "pipe",
		stderr: "pipe",
		timeout: 30_000,
	});
	const [out, error, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { out, error: error.trim(), code };
}

export async function runGh(args: string[], body?: string): Promise<string> {
	// Keep repository-local worktree cleanup outside gh.
	const { out, error, code } = await spawnGh(args, body, "/");
	if (code !== 0) throw new Error(error || `gh exited with status ${code}`);
	return out;
}

async function gh<T>(args: string[]): Promise<T> {
	const { out, error, code } = await spawnGh(args);
	if (code === 4) throw new Error("Sign in to GitHub on this host with gh auth login.");
	if (code !== 0) throw new Error(sentence(error) || "GitHub did not respond. Try again.");
	return JSON.parse(out) as T;
}

/**
 * A plain Git clone, so public repositories need no GitHub account and organization SSO cannot
 * block them. Private ones use this host's existing Git credential helpers, with the token gh
 * would see. Git never prompts, since the helper has no terminal. Ace never removes anything at
 * `path`; only Git cleans up what its own failed clone created.
 */
export async function clone(repo: string, path: string): Promise<void> {
	const command = gitArgs(["clone", "--", `https://github.com/${repository(repo)}.git`, path]);
	const child = Bun.spawn(["git", ...command], {
		env: { ...process.env, ...githubEnv(), GIT_TERMINAL_PROMPT: "0" },
		stdin: "ignore",
		stdout: "ignore",
		stderr: "pipe",
		timeout: 30 * 60_000,
	});
	const [error, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
	if (code === 0) return;
	if (child.signalCode) throw new Error("Cloning took too long and was stopped. Try again.");
	const detail = error.trim().split("\n").filter((line) => !line.startsWith("Cloning into"))
		.slice(-4).join("\n");
	if (/\bSAML\b|\bSSO\b|single sign-on/i.test(error)) {
		throw new Error(
			`${
				repo.split("/")[0]
			} requires single sign-on for this repository. Authorize this host's Git credentials for the organization on GitHub, then try again.\n${detail}`,
		);
	}
	if (/terminal prompts disabled|could not read Username|Authentication failed/i.test(error)) {
		throw new Error(
			`GitHub needs credentials to clone ${repo}. Set up Git credentials on this host, for example with gh auth setup-git, then try again.`,
		);
	}
	// GitHub answers "not found" for private repositories the credentials can't read.
	if (/Repository not found/i.test(error)) {
		throw new Error(
			`GitHub didn't find ${repo} for this host's Git credentials. Check the name, and that the signed-in account has access; a pending invitation must be accepted first.\n${detail}`,
		);
	}
	throw new Error(detail || `Could not clone ${repo}.`);
}

let owner: string | undefined;
let checked = 0;

/** The owner's GitHub login if gh already told it, without asking again. */
export function known(): string | undefined {
	return owner;
}

/**
 * The owner's GitHub login from gh, for avatars. Unknown until resolved; a missing or signed-out
 * gh is checked again at most every five minutes, so signing in later takes effect.
 */
export function login(changed: () => void): string | undefined {
	if (!owner && Date.now() - checked > 300_000) {
		checked = Date.now();
		gh<{ login: string }>(["api", "user"]).then((user) => {
			owner = user.login;
			changed();
		}, () => {});
	}
	return owner;
}

export const REMOTES = ["config", "--local", "--get-regexp", "^remote\\..*\\.(url|gh-resolved)$"] as const;

/** The GitHub repository in `git config` output for REMOTES, preferring origin. */
export function remote(config: string): string | null {
	const remotes = new Map<string, string>();
	let preferred: string | undefined;
	for (const line of config.trim().split("\n")) {
		const match = /^remote\.(.+)\.(url|gh-resolved)\s+(.+)$/.exec(line);
		if (!match) continue;
		const name = match[1]!;
		const field = match[2]!;
		const value = match[3]!;
		if (field === "gh-resolved" && value === "base") preferred = name;
		if (field === "url") remotes.set(name, value);
	}
	for (const name of ["origin", preferred, "upstream", ...remotes.keys()]) {
		const url = name ? remotes.get(name) : undefined;
		if (!url) continue;
		const match =
			/^(?:https?:\/\/(?:[^/@]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com(?::443)?\/)([^/]+\/[^/]+?)\/?$/i
				.exec(url);
		if (!match) continue;
		const repo = match[1]!.replace(/\.git$/i, "");
		if (validRepository(repo)) return repo.toLowerCase();
	}
	return null;
}

/** Reading a remote needs no GitHub credentials, including on a teammate's host. */
export async function project(path: string): Promise<string | null> {
	const child = Bun.spawn(["git", "-C", path, ...gitArgs(REMOTES)], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "ignore",
		timeout: 5000,
	});
	const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
	return code === 0 ? remote(out) : null;
}

function item(value: Item, kind: GithubKind): GithubItem {
	return {
		kind,
		number: value.number,
		title: value.title,
		url: value.url,
		state: value.state === "MERGED"
			? "merged"
			: value.state === "CLOSED"
			? "closed"
			: value.isDraft
			? "draft"
			: "open",
		author: value.author?.login || "ghost",
		created: value.createdAt,
		updated: value.updatedAt,
		labels: value.labels.map(({ name, color }) => ({ name, color })),
		head: value.headRefName,
		fork: value.isCrossRepository,
	};
}

export async function list(
	request: Extract<HostRequest, { op: "github-list" }>,
): Promise<GithubList> {
	const { repo, kind, state, search, limit } = request;
	if (!["open", "closed", "all"].includes(state)) throw new Error("Invalid GitHub state filter");
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
		throw new Error("Load between 1 and 1000 GitHub items");
	}
	const values = await gh<Item[]>([
		command(kind),
		"list",
		"--repo",
		repository(repo),
		"--state",
		state,
		"--limit",
		String(limit + 1),
		"--search",
		`${search} sort:updated-desc`.trim(),
		"--json",
		FIELDS + (kind === "prs" ? ",isDraft,headRefName,isCrossRepository" : ""),
	]);
	return {
		items: values.slice(0, limit).map((value) => item(value, kind)),
		more: values.length > limit,
	};
}

export async function detail(
	request: Extract<HostRequest, { op: "github-detail" }>,
): Promise<GithubDetail> {
	const { repo, kind } = request;
	const value = await gh<Detail>([
		command(kind),
		"view",
		number(request.number),
		"--repo",
		repository(repo),
		"--json",
		FIELDS + ",body,comments" + (kind === "prs"
			? ",isDraft,reviews,baseRefName,headRefName,additions,deletions,changedFiles,reviewDecision"
			: ""),
	]);
	const comments: GithubComment[] = value.comments.map((comment) => ({
		id: comment.id,
		url: comment.url,
		author: comment.author?.login || "ghost",
		body: comment.body,
		created: comment.createdAt,
	}));
	for (const review of value.reviews || []) {
		if (review.state === "PENDING") continue;
		comments.push({
			id: review.id,
			url: value.url,
			author: review.author?.login || "ghost",
			body: review.body,
			created: review.submittedAt,
			review: review.state.toLowerCase() as GithubComment["review"],
		});
	}
	comments.sort((a, b) => a.created.localeCompare(b.created));
	return {
		...item(value, kind),
		body: value.body,
		comments,
		...(kind === "prs"
			? {
				pull: {
					base: value.baseRefName!,
					head: value.headRefName!,
					adds: value.additions!,
					dels: value.deletions!,
					files: value.changedFiles!,
					review: value.reviewDecision!,
				},
			}
			: {}),
	};
}

function check(value: Check): GithubCheck {
	if (value.__typename === "StatusContext") {
		const state = value.state === "SUCCESS"
			? "passed"
			: ["FAILURE", "ERROR"].includes(value.state)
			? "failed"
			: "pending";
		return { name: value.context, ...(value.targetUrl ? { url: value.targetUrl } : {}), state };
	}
	const state = value.status !== "COMPLETED"
		? "pending"
		: value.conclusion === "SUCCESS"
		? "passed"
		: ["NEUTRAL", "SKIPPED", "STALE"].includes(value.conclusion)
		? "skipped"
		: "failed";
	return { name: value.name, ...(value.detailsUrl ? { url: value.detailsUrl } : {}), state };
}

const REVIEWS: Record<string, GithubPull["review"]> = {
	APPROVED: "approved",
	CHANGES_REQUESTED: "changes",
	REVIEW_REQUIRED: "required",
};

const Ref = z.object({ ref: z.string(), sha: z.string(), repo: z.object({ full_name: z.string() }).nullable() });
const PullRow = z.object({ number: z.int().positive(), head: Ref });
const PullDetail = PullRow.extend({
	node_id: z.string(), title: z.string(), html_url: z.string(), draft: z.boolean(),
	state: z.enum(["open", "closed"]), merged_at: z.string().nullable(),
	mergeable_state: z.string(), mergeable: z.boolean().nullable(),
	user: z.object({ login: z.string() }).nullable(), created_at: z.string(), updated_at: z.string(),
	labels: z.array(z.object({ name: z.string(), color: z.string() })),
});
const CheckRuns = z.object({ check_runs: z.array(z.object({
	name: z.string(), details_url: z.string().nullable(), status: z.string(), conclusion: z.string().nullable(),
})) });
const Statuses = z.object({ statuses: z.array(z.object({
	context: z.string(), target_url: z.string().nullable(), state: z.string(),
})) });
const GithubError = z.object({ message: z.string() });
type PullDetail = z.infer<typeof PullDetail>;

async function token(): Promise<string> {
	const env = environment();
	if (env.GH_TOKEN) return env.GH_TOKEN;
	const executable = Bun.which("gh", { PATH: process.env.PATH });
	if (!executable) throw new Error("Install GitHub CLI on this host, then sign in with gh auth login.");
	const child = Bun.spawn([executable, "auth", "token", "--hostname", "github.com"], {
		env, stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 5000,
	});
	const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
	if (code !== 0 || !out.trim()) throw new Error("Sign in to GitHub on this host with gh auth login.");
	return out.trim();
}

type Cache = Map<string, { etag: string | null; value: unknown; next: string | undefined }>;
export function pullGithub(fetcher: typeof globalThis.fetch = fetch, signIn = token) {
	async function request(path: string, options: {
		signal: AbortSignal; etag?: string | null; body?: object;
	}): Promise<Response> {
		const { signal, body, etag } = options;
		const url = new URL(path, "https://api.github.com");
		if (url.origin !== "https://api.github.com") throw new Error("GitHub returned an invalid link.");
		const response = await fetcher(url, {
			method: body ? "POST" : "GET", signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
			headers: {
				accept: "application/vnd.github+json", authorization: `Bearer ${await signIn()}`,
				"x-github-api-version": "2022-11-28",
				...(etag ? { "if-none-match": etag } : {}),
				...(body ? { "content-type": "application/json" } : {}),
			},
			...(body ? { body: JSON.stringify(body) } : {}),
		});
		if (response.ok || response.status === 304) return response;
		const error = GithubError.safeParse(await response.json().catch(() => null));
		const detail = error.success ? error.data.message : `GitHub refused the request (HTTP ${response.status})`;
		throw new Error(/[.!?]$/.test(detail) ? detail : `${detail}.`);
	}

	async function read<T>(path: string, schema: z.ZodType<T>, signal: AbortSignal, cache: Cache) {
		const saved = cache.get(path);
		const response = await request(path, { signal, etag: saved?.etag });
		const row = response.status === 304 && saved ? saved : {
			etag: response.headers.get("etag"), value: await response.json(),
			next: /<([^>]+)>; rel="next"/.exec(response.headers.get("link") ?? "")?.[1],
		};
		const value = schema.parse(row.value);
		cache.set(path, row);
		return { value, status: response.status, next: row.next };
	}

	async function pages<T>(path: string, schema: z.ZodType<T>, signal: AbortSignal, cache: Cache) {
		const result: T[] = [];
		for (let next: string | undefined = path; next;) {
			const page: { value: T; next: string | undefined } = await read(next, schema, signal, cache);
			result.push(page.value);
			next = page.next;
		}
		return result;
	}

	const path = (repo: string) => `/repos/${repository(repo)}`;

	return {
		async find(repo: string, branch: string, signal: AbortSignal, cache: Cache) {
			const search = new URLSearchParams({ head: `${repo.split("/")[0]}:${branch}`, state: "all", sort: "created", direction: "desc", per_page: "100" });
			const { value, status } = await read(`${path(repo)}/pulls?${search}`,
				z.array(PullRow.extend({ state: PullDetail.shape.state })), signal, cache);
			const matching = value.filter(row => row.head.ref === branch && row.head.repo?.full_name.toLowerCase() === repo);
			return { number: (matching.find(row => row.state === "open") ?? matching[0])?.number, status };
		},
		async detail(repo: string, number: number, signal: AbortSignal, cache: Cache) {
			return read(`${path(repo)}/pulls/${number}`, PullDetail, signal, cache);
		},
		async checks(repo: string, sha: string, signal: AbortSignal, cache: Cache) {
			const prefix = `${path(repo)}/commits/${encodeURIComponent(sha)}`;
			const [runs, statuses] = await Promise.all([
				pages(`${prefix}/check-runs?per_page=100`, CheckRuns, signal, cache),
				pages(`${prefix}/status?per_page=100`, Statuses, signal, cache),
			]);
			return [
				...runs.flatMap(page => page.check_runs.map(run => check({
					__typename: "CheckRun", name: run.name, status: run.status.toUpperCase(),
					conclusion: run.conclusion?.toUpperCase() ?? "", detailsUrl: run.details_url ?? undefined,
				}))),
				...statuses.flatMap(page => page.statuses.map(status => check({
					__typename: "StatusContext", context: status.context, state: status.state.toUpperCase(),
					targetUrl: status.target_url ?? undefined,
				}))),
			];
		},
		async review(id: string, signal: AbortSignal) {
			const response = await request("/graphql", {
				signal,
				body: { query: "query($id: ID!) { node(id: $id) { ... on PullRequest { reviewDecision } } }", variables: { id } },
			});
			const result = z.object({ data: z.unknown().optional(), errors: z.array(GithubError).optional() }).parse(await response.json());
			if (result.errors?.length) throw new Error(sentence(result.errors.map(error => error.message).join(" ")));
			const { node } = z.object({ node: z.object({ reviewDecision: z.string().nullable() }) }).parse(result.data);
			return REVIEWS[node.reviewDecision ?? ""];
		},
	};
}

export function pullSnapshot(value: PullDetail, checks: GithubCheck[], review: GithubPull["review"]): GithubPull {
	const base = item({
		number: value.number, title: value.title, url: value.html_url, isDraft: value.draft,
		state: value.merged_at ? "MERGED" : value.state === "open" ? "OPEN" : "CLOSED",
		author: value.user, createdAt: value.created_at, updatedAt: value.updated_at,
		labels: value.labels, headRefName: value.head.ref,
	}, "prs");
	const merge = value.mergeable_state === "dirty" ? "conflicts"
		: value.mergeable_state === "unknown" || value.mergeable === null ? "unknown"
		: value.mergeable_state === "clean" || value.mergeable_state === "unstable" ? "ready" : "blocked";
	return {
		...base, checks, sha: value.head.sha, ...(review ? { review } : {}),
		...(base.state === "open" || base.state === "draft" ? { merge } : {}),
	};
}

export async function files(repo: string, id: number): Promise<GithubFile[]> {
	const pages = await gh<File[][]>([
		"api",
		`repos/${repository(repo)}/pulls/${number(id)}/files?per_page=100`,
		"--paginate",
		"--slurp",
	]);
	return pages.flat().map((file) => {
		const from = file.previous_filename || file.filename;
		const old = file.status === "added" ? "/dev/null" : `a/${from}`;
		const next = file.status === "removed" ? "/dev/null" : `b/${file.filename}`;
		let patch = `diff --git ${JSON.stringify(`a/${from}`)} ${
			JSON.stringify(`b/${file.filename}`)
		}\n`;
		if (file.status === "renamed") {
			patch += `rename from ${JSON.stringify(from)}\nrename to ${JSON.stringify(file.filename)}\n`;
		}
		patch += `--- ${JSON.stringify(old)}\n+++ ${JSON.stringify(next)}\n${file.patch || ""}\n`;
		const hasPatch = file.patch !== undefined
			|| (file.status === "renamed" && !file.additions && !file.deletions);
		return {
			file: file.filename,
			from: file.previous_filename,
			adds: file.additions,
			dels: file.deletions,
			signature: new Bun.CryptoHasher("sha256").update(patch).digest("hex"),
			patch: hasPatch ? patch : undefined,
			error: hasPatch ? undefined : "GitHub did not include a text diff for this file.",
		};
	});
}
