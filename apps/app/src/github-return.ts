import { type GithubKind, type GithubList } from "@ace/channel/protocol";
import { GithubDetailSchema, GithubPullDescriptorSchema } from "@ace/channel/github";
import { checkoutId, type HostRequest } from "@ace/host/protocol";
import type { AppProject } from "./projects";

type DetailRequest = Extract<HostRequest, { op: "github-detail" }>;
export type GithubReturnTarget =
	| { status: "item"; project: string; repo: string; kind: GithubKind; number: number }
	| { status: "invalid"; error: string };

export function githubReturnTarget(url: URL): GithubReturnTarget | undefined {
	const fields = url.searchParams;
	if (!["repo", "pull", "issue"].some((name) => fields.has(name))) return;
	const invalid: GithubReturnTarget = { status: "invalid", error: "This return link from a review is not valid." };
	const kind = fields.has("pull") ? "prs" : fields.has("issue") ? "issues" : undefined;
	if (!kind || (url.hash && url.hash !== `#${kind}`)) return invalid;
	const field = kind === "prs" ? "pull" : "issue";
	if (["project", "repo", field].some((name) => fields.getAll(name).length !== 1)
		|| fields.has(kind === "prs" ? "issue" : "pull") || fields.has("channel")) return invalid;
	const project = fields.get("project");
	const raw = fields.get(field) ?? "";
	const repo = GithubPullDescriptorSchema.shape.repo.safeParse(fields.get("repo"));
	const number = Number(raw);
	if (!project || !repo.success || !/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(number)) return invalid;
	return { status: "item", project, repo: repo.data.toLowerCase(), kind, number };
}

export function githubReturnQuery(target: GithubReturnTarget, project: AppProject, repo: string | null | undefined, localHost: string): { request?: DetailRequest; project?: string; error?: string } {
	if (target.status === "invalid") return { error: target.error };
	if (!project.checkouts.has(checkoutId(localHost, target.project))) return { error: "The GitHub return link does not name the selected project." };
	if (repo === undefined) return {};
	if (!repo) return { error: "This project has no GitHub remote, so the returned item can't be shown." };
	if (target.repo !== repo.toLowerCase()) return { error: "The returned item belongs to a different repository than this project." };
	return { request: { op: "github-detail", repo: target.repo, kind: target.kind, number: target.number }, project: target.project };
}

export function githubReturnList(request: DetailRequest, value: unknown): GithubList {
	const item = GithubDetailSchema.parse(value);
	const expected = `https://github.com/${request.repo}/${request.kind === "prs" ? "pull" : "issues"}/${request.number}`;
	if (item.kind !== request.kind || item.number !== request.number || item.url.toLowerCase() !== expected.toLowerCase()) {
		throw new Error("GitHub returned a different item than the return link asked for.");
	}
	const { head, fork, ...detail } = item;
	return { items: [{ ...detail, ...(head === undefined ? {} : { head }), ...(fork === undefined ? {} : { fork }) }], more: false };
}
