import {
	GithubPullDescriptorSchema,
	type GithubPullDescriptor,
} from "@ace/channel/github";
export {
	GithubPullDescriptorSchema,
	type GithubPullDescriptor,
} from "@ace/channel/github";
import { z } from "zod";
import type {
	GithubCheck,
	GithubComment,
	GithubDetail,
	GithubFile,
	GithubItem,
	GithubKind,
	GithubList,
	GithubPull,
} from "@ace/channel/github";
import { config } from "./host-config";
import { githubRepo, NOT_GITHUB, type HostRequest } from "./extension-protocol";

const REPO = /^[a-z\d][a-z\d-]*\/[a-z\d_.-]+$/i;
const OID = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const Author = z.object({ login: z.string() }).nullable();
const Item = z.object({
	number: z.int().positive(),
	title: z.string(),
	url: z.url(),
	state: z.enum(["OPEN", "CLOSED", "MERGED"]),
	author: Author,
	createdAt: z.string(),
	updatedAt: z.string(),
	labels: z.array(z.object({ name: z.string(), color: z.string() })),
	isDraft: z.boolean().optional(),
	headRefName: z.string().optional(),
	isCrossRepository: z.boolean().optional(),
});
const Comment = z.object({
	id: z.string(),
	url: z.string(),
	author: Author,
	body: z.string(),
	createdAt: z.string(),
});
const Review = z.object({
	id: z.string(),
	author: Author,
	body: z.string(),
	submittedAt: z.string().nullable(),
	state: z.enum([
		"APPROVED",
		"CHANGES_REQUESTED",
		"COMMENTED",
		"DISMISSED",
		"PENDING",
	]),
});
const Detail = Item.extend({
	body: z.string(),
	comments: z.array(Comment),
	reviews: z.array(Review).optional(),
	baseRefName: z.string().optional(),
	additions: z.number().optional(),
	deletions: z.number().optional(),
	changedFiles: z.number().optional(),
	reviewDecision: z.string().optional(),
});
const Check = z.discriminatedUnion("__typename", [
	z.object({
		__typename: z.literal("CheckRun"),
		name: z.string(),
		detailsUrl: z.string().optional(),
		status: z.string(),
		conclusion: z.string().nullable(),
	}),
	z.object({
		__typename: z.literal("StatusContext"),
		context: z.string(),
		targetUrl: z.string().optional(),
		state: z.string(),
	}),
]);
const Pull = Item.extend({
	statusCheckRollup: z.array(Check).nullable(),
	headRefOid: OID,
	reviewDecision: z.string(),
	isCrossRepository: z.boolean(),
});
const File = z.object({
	filename: z.string(),
	previous_filename: z.string().optional(),
	status: z.string(),
	additions: z.number(),
	deletions: z.number(),
	patch: z.string().optional(),
});
const Repo = z.object({ full_name: z.string() });
const PullSource = z.object({
  state: z.enum(["open", "closed"]).optional(),
	number: z.int().positive(),
	html_url: z.url(),
	title: z.string(),
	body: z.string().nullable(),
	updated_at: z.string(),
	changed_files: z.int().nonnegative(),
	base: z.object({ ref: z.string(), sha: OID, repo: Repo }),
	head: z.object({ ref: z.string(), sha: OID, repo: Repo.nullable() }),
});
const FIELDS = "number,title,url,state,author,createdAt,updatedAt,labels";

export function repository(value: string): string {
	if (!REPO.test(value) || [".", ".."].includes(value.split("/")[1]!))
		throw new Error("Choose a GitHub repository in owner/name format");
	return value.toLowerCase();
}
export function parse(value: string): string {
	const repo = githubRepo(value);
	if (!repo) throw new Error(NOT_GITHUB);
	return repository(repo);
}
function number(value: number): string {
	if (!Number.isSafeInteger(value) || value < 1)
		throw new Error("Invalid GitHub item number");
	return String(value);
}
const command = (kind: GithubKind) => (kind === "issues" ? "issue" : "pr");

/** Uses the inherited GitHub CLI account; never reads, copies or mutates its credentials. */
export function environment(): Record<string, string> {
	const { GH_REPO: _repo, ...env } = config.environment;
	return {
		...env,
		GH_HOST: "github.com",
		GH_PROMPT_DISABLED: "1",
		GH_PAGER: "cat",
		GIT_TERMINAL_PROMPT: "0",
	};
}
export async function gh<T>(schema: z.ZodType<T>, args: string[]): Promise<T> {
	const path = Bun.which("gh", { PATH: config.environment.PATH ?? "" });
	if (!path) throw new Error("GitHub CLI is unavailable on this host.");
	const child = Bun.spawn([path, ...args], {
		env: environment(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		timeout: 30_000,
	});
	const [out, error, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code === 4) throw new Error("This host's GitHub CLI is not signed in.");
	if (code !== 0)
		throw new Error(
			error.trim().replace(/^GraphQL: /, "GitHub refused the request: ") ||
				"GitHub did not respond. Try again.",
		);
	let value: unknown;
	try {
		value = JSON.parse(out);
	} catch {
		throw new Error("GitHub CLI returned invalid JSON");
	}
	const parsed = schema.safeParse(value);
	if (!parsed.success)
		throw new Error(
			`GitHub CLI returned an unsupported response: ${z.prettifyError(parsed.error)}`,
		);
	return parsed.data;
}

export const REMOTES = [
	"config",
	"--local",
	"--get-regexp",
	"^remote\\..*\\.(url|gh-resolved)$",
];
export function remote(text: string): string | null {
	const remotes = new Map<string, string>();
	let preferred: string | undefined;
	for (const line of text.trim().split("\n")) {
		const match = /^remote\.(.+)\.(url|gh-resolved)\s+(.+)$/.exec(line);
		if (!match) continue;
		if (match[2] === "gh-resolved" && match[3] === "base") preferred = match[1];
		if (match[2] === "url") remotes.set(match[1]!, match[3]!);
	}
	for (const name of [preferred, "origin", "upstream", ...remotes.keys()]) {
		const url = name ? remotes.get(name) : undefined;
		if (!url) continue;
		const match =
			/^(?:https?:\/\/(?:[^/@]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com(?::443)?\/)([^/]+\/[^/]+?)\/?$/i.exec(
				url,
			);
		if (!match) continue;
		const repo = match[1]!.replace(/\.git$/i, "");
		if (REPO.test(repo)) return repository(repo);
	}
	return null;
}
function item(value: z.infer<typeof Item>, kind: GithubKind): GithubItem {
	return {
		kind,
		number: value.number,
		title: value.title,
		url: value.url,
		state:
			value.state === "MERGED"
				? "merged"
				: value.state === "CLOSED"
					? "closed"
					: value.isDraft
						? "draft"
						: "open",
		author: value.author?.login || "ghost",
		created: value.createdAt,
		updated: value.updatedAt,
		labels: value.labels,
		...(value.headRefName === undefined ? {} : { head: value.headRefName }),
		...(value.isCrossRepository === undefined
			? {}
			: { fork: value.isCrossRepository }),
	};
}
export async function list(
	request: Extract<HostRequest, { op: "github-list" }>,
): Promise<GithubList> {
	if (
		!Number.isSafeInteger(request.limit) ||
		request.limit < 1 ||
		request.limit > 1000
	)
		throw new Error("Load between 1 and 1000 GitHub items");
	const values = await gh(z.array(Item), [
		command(request.kind),
		"list",
		"--repo",
		repository(request.repo),
		"--state",
		request.state,
		"--limit",
		String(request.limit + 1),
		"--search",
		`${request.search} sort:updated-desc`.trim(),
		"--json",
		FIELDS +
			(request.kind === "prs" ? ",isDraft,headRefName,isCrossRepository" : ""),
	]);
	return {
		items: values
			.slice(0, request.limit)
			.map((value) => item(value, request.kind)),
		more: values.length > request.limit,
	};
}
export async function detail(
	request: Extract<HostRequest, { op: "github-detail" }>,
): Promise<GithubDetail> {
	const value = await gh(Detail, [
		command(request.kind),
		"view",
		number(request.number),
		"--repo",
		repository(request.repo),
		"--json",
		FIELDS +
			",body,comments" +
			(request.kind === "prs"
				? ",isDraft,reviews,baseRefName,headRefName,additions,deletions,changedFiles,reviewDecision"
				: ""),
	]);
	const comments: GithubComment[] = value.comments.map((c) => ({
		id: c.id,
		url: c.url,
		author: c.author?.login || "ghost",
		body: c.body,
		created: c.createdAt,
	}));
	for (const review of value.reviews || []) {
		if (review.state === "PENDING" || !review.submittedAt) continue;
		const state =
			review.state === "APPROVED"
				? "approved"
				: review.state === "CHANGES_REQUESTED"
					? "changes_requested"
					: review.state === "DISMISSED"
						? "dismissed"
						: "commented";
		comments.push({
			id: review.id,
			url: value.url,
			author: review.author?.login || "ghost",
			body: review.body,
			created: review.submittedAt,
			review: state,
		});
	}
	comments.sort((a, b) => a.created.localeCompare(b.created));
	return {
		...item(value, request.kind),
		body: value.body,
		comments,
		...(request.kind === "prs" &&
		value.baseRefName !== undefined &&
		value.headRefName !== undefined &&
		value.additions !== undefined &&
		value.deletions !== undefined &&
		value.changedFiles !== undefined
			? {
					pull: {
						base: value.baseRefName,
						head: value.headRefName,
						adds: value.additions,
						dels: value.deletions,
						files: value.changedFiles,
						review: value.reviewDecision || "",
					},
				}
			: {}),
		completeness: {
			kind: "unknown",
			reason:
				"GitHub CLI may return only the first page of discussion. The full item body is present.",
		},
	};
}
function check(value: z.infer<typeof Check>): GithubCheck {
	if (value.__typename === "StatusContext")
		return {
			name: value.context,
			...(value.targetUrl ? { url: value.targetUrl } : {}),
			state:
				value.state === "SUCCESS"
					? "passed"
					: ["FAILURE", "ERROR"].includes(value.state)
						? "failed"
						: "pending",
		};
	return {
		name: value.name,
		...(value.detailsUrl ? { url: value.detailsUrl } : {}),
		state:
			value.status !== "COMPLETED"
				? "pending"
				: value.conclusion === "SUCCESS"
					? "passed"
					: value.conclusion &&
						  ["NEUTRAL", "SKIPPED", "STALE"].includes(value.conclusion)
						? "skipped"
						: "failed",
	};
}
export async function pull(
	repo: string,
	branch: string,
): Promise<GithubPull | null> {
	if (!branch || branch.startsWith("-")) throw new Error("Invalid branch name");
	const values = await gh(z.array(Pull), [
		"pr",
		"list",
		"--repo",
		repository(repo),
		`--head=${branch}`,
		"--state",
		"all",
		"--limit",
		"30",
		"--json",
		`${FIELDS},isDraft,statusCheckRollup,headRefOid,reviewDecision,isCrossRepository`,
	]);
	const value = values.find((candidate) => !candidate.isCrossRepository);
	if (!value) return null;
	const review =
		value.reviewDecision === "APPROVED"
			? "approved"
			: value.reviewDecision === "CHANGES_REQUESTED"
				? "changes"
				: value.reviewDecision === "REVIEW_REQUIRED"
					? "required"
					: undefined;
	return {
		...item(value, "prs"),
		checks: (value.statusCheckRollup || []).map(check),
		sha: value.headRefOid,
		...(review ? { review } : {}),
	};
}
export async function descriptor(
	repo: string,
	id: number,
): Promise<GithubPullDescriptor> {
	const repositoryName = repository(repo);
	const raw = await gh(z.unknown(), [
		"api",
		`repos/${repositoryName}/pulls/${number(id)}`,
	]);
	const result = parseDescriptor(raw, repositoryName);
	if (result.number !== id)
		throw new Error("GitHub returned a different pull request than requested.");
	return result;
}
export function parseDescriptor(
	raw: unknown,
	repo: string,
	fetchedAt = new Date().toISOString(),
): GithubPullDescriptor {
	const repositoryName = repository(repo);
	const value = PullSource.parse(raw);
	if (!value.head.repo)
		throw new Error(
			"This pull request's head repository is unavailable; its exact source cannot be acquired.",
		);
	return GithubPullDescriptorSchema.parse({
    ...(value.state === undefined ? {} : { state: value.state }),
		repo: repositoryName,
		number: value.number,
		url: value.html_url,
		baseRepo: repository(value.base.repo.full_name),
		headRepo: repository(value.head.repo.full_name),
		baseRef: value.base.ref,
		headRef: value.head.ref,
		baseOid: value.base.sha,
		headOid: value.head.sha,
		title: value.title,
		body: value.body || "",
		updatedAt: value.updated_at,
		fetchedAt,
		files: value.changed_files,
	});
}
export async function files(repo: string, id: number): Promise<GithubFile[]> {
	const source = await descriptor(repo, id);
	const pages = await gh(z.array(z.array(File)), [
		"api",
		`repos/${repository(repo)}/pulls/${number(id)}/files?per_page=100`,
		"--paginate",
		"--slurp",
	]);
	const values = pages.flat();
	if (values.length !== source.files)
		throw new Error(
			`GitHub returned ${values.length} of ${source.files} changed files; the file list is incomplete.`,
		);
	return values.map((file) => {
		const from = file.previous_filename || file.filename;
		const old = file.status === "added" ? "/dev/null" : `a/${from}`;
		const next = file.status === "removed" ? "/dev/null" : `b/${file.filename}`;
		let patch = `diff --git ${JSON.stringify(`a/${from}`)} ${JSON.stringify(`b/${file.filename}`)}\n`;
		if (file.status === "renamed")
			patch += `rename from ${JSON.stringify(from)}\nrename to ${JSON.stringify(file.filename)}\n`;
		patch += `--- ${JSON.stringify(old)}\n+++ ${JSON.stringify(next)}\n${file.patch || ""}\n`;
		const hasPatch =
			file.patch !== undefined ||
			(file.status === "renamed" && !file.additions && !file.deletions);
		return {
			file: file.filename,
			...(file.previous_filename ? { from: file.previous_filename } : {}),
			adds: file.additions,
			dels: file.deletions,
			signature: new Bun.CryptoHasher("sha256").update(patch).digest("hex"),
			...(hasPatch
				? { patch }
				: { error: "GitHub did not include a text diff for this file." }),
		};
	});
}
let owner: string | undefined;
let checked = 0;
export function login(changed: () => void): string | undefined {
	if (!owner && Date.now() - checked > 300_000) {
		checked = Date.now();
		void gh(z.object({ login: z.string() }), ["api", "user"]).then(
			(value) => {
				owner = value.login;
				changed();
			},
			() => {},
		);
	}
	return owner;
}

/** The exact description body, fetched independently of cached rows or incomplete discussions. */
export async function body(
	item: import("@neuve/records-schema").GitHubExternalRef,
): Promise<import("@neuve/records-schema").ExternalReviewSource> {
	const ItemBody = z.object({
		number: z.int().positive(),
		html_url: z.url(),
		title: z.string(),
		body: z.string().nullable(),
		updated_at: z.string(),
	});
	const value = await gh(ItemBody, [
		"api",
		`repos/${repository(item.repo)}/${item.kind === "issue" ? "issues" : "pulls"}/${number(item.number)}`,
	]);
	if (
		value.number !== item.number ||
		value.html_url.toLowerCase() !== item.url.toLowerCase()
	)
		throw new Error(
			"GitHub returned a different external item than requested.",
		);
	return {
		item,
		title: value.title,
		text: value.body || "",
		version: value.updated_at,
		fetchedAt: new Date().toISOString(),
		complete: true,
	};
}
