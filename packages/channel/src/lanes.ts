import type { Context } from "@earendil-works/chord";
import { type ConversationId, defineDoc } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { z } from "zod";

import { git, type GitCommand } from "./git";
import { toolArguments, toolRefusal } from "./tool-arguments";

/**
 * Which chat last took each lane, which only that chat may write to while it is busy, and the
 * base its Diff compares against: a full ref name, or a commit when the base named no ref.
 * Version 1 lanes have no base.
 */
export const LanesDoc = defineDoc<
	{ lanes: Record<string, { chat: ConversationId; path: string; base?: string; hostCreated?: true }> }
>({
	kind: "ace.lanes",
	version: 2,
	scope: "session",
	initial: () => ({ lanes: {} }),
	migrate: (value) => ({
		lanes: value.lanes as Record<string, { chat: ConversationId; path: string }>,
	}),
});

const nameDescription = "Lowercase kebab-case name, such as implement-auth.";
const baseDescription = "Branch, tag, or commit, such as HEAD, release, or origin/release.";
const laneChangeFields = {
	name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/).describe(nameDescription),
	base: z.string().optional().describe(baseDescription),
};
const LaneArguments = z.discriminatedUnion("action", [
	z.strictObject({ action: z.literal("start"), ...laneChangeFields }),
	z.strictObject({ action: z.literal("switch"), ...laneChangeFields }),
	z.strictObject({
		action: z.literal("list"),
		name: z.string().optional().describe(nameDescription),
		base: z.string().optional().describe(baseDescription),
	}).overwrite(({ action }) => ({ action })),
]);
export const laneArguments = toolArguments("lane", LaneArguments, {
	name: 'a lowercase kebab-case work lane name of 1 to 63 characters starting with a letter or digit, such as "implement-auth"',
	base: 'a branch, tag, or commit, such as "HEAD", or omit base to use the default',
}, { coerce: true });
type LaneChange = Exclude<z.infer<typeof LaneArguments>, { action: "list" }>;

export function checkWorkLaneName(args: LaneChange) {
	// Pi recovery can execute an intent recorded before the schema required this name.
	if (!laneChangeFields.name.safeParse(args.name).success) laneArguments.prepareArguments(args);
}

/** A lane's base and the commit a new worktree starts from. */
export type Selection = { base: string; commit: string };

/** Fetches one remote branch to its remote-tracking ref, which then becomes the base. */
async function fetched(
	run: (args: GitCommand, quiet?: boolean) => Promise<string>,
	remote: string,
	branch: string,
): Promise<Selection> {
	const base = `refs/remotes/${remote}/${branch}`;
	await run(["fetch", remote, `+refs/heads/${branch}:${base}`]).catch((error) => {
		throw new Error(`Could not fetch ${remote}/${branch} (${error.message})`);
	});
	const commit = (await run(["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`]))
		.trim();
	return { base, commit };
}

/** A remote's HEAD names its default branch as the remote advertises it now. */
async function advertised(run: (args: GitCommand, quiet?: boolean) => Promise<string>, remote: string) {
	const output = await run(["ls-remote", "--symref", remote, "HEAD"]).catch((error) => {
		throw new Error(`Could not read ${remote}'s default branch (${error.message})`);
	});
	const branch = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(output)?.[1];
	if (!branch) throw new Error(`${remote} advertises no default branch`);
	return fetched(run, remote, branch);
}

/**
 * Resolves a requested base in the project. Without one, a lane starts from origin's advertised
 * default branch, which a stale or missing local origin/HEAD can't be trusted to name, or from
 * the project's HEAD in a repository without origin, such as a folder Ace initialized.
 */
export async function select(
	env: ExecutionEnv,
	project: string,
	requested: string | undefined,
	context: Context,
): Promise<Selection> {
	const run = (args: GitCommand, quiet = false) => git(env, args, context, { cwd: project, quiet });
	const remotes = (await run(["remote"])).split("\n");
	if (!requested && remotes.includes("origin")) return advertised(run, "origin");
	requested ||= "HEAD";
	const ref = requested.replace(/^refs\/remotes\//, "");
	const remote = remotes
		.filter((name) => name && ref.startsWith(`${name}/`))
		.sort((a, b) => b.length - a.length)[0];
	const branch = remote && ref.slice(remote.length + 1);
	if (branch === "HEAD") return advertised(run, remote!);
	// An expression such as origin/main~2 is resolved locally like any other commit.
	const isBranch = branch
		&& await run(["check-ref-format", `refs/heads/${branch}`]).then(() => true, () => false);
	if (isBranch) return fetched(run, remote!, branch);
	// Output is parsed, so warnings such as an ambiguous name stay out of it.
	const resolve = (option: string, revision: string) =>
		run(["rev-parse", "--verify", option, "--end-of-options", revision], true).then(
			(output) => output.trim(),
			() => {
				throw new Error(`No branch, tag, or commit named ${JSON.stringify(requested)}`);
			},
		);
	const full = await resolve("--symbolic-full-name", requested);
	const commit = await resolve("--quiet", `${requested}^{commit}`);
	return { base: /^refs\/(heads|tags|remotes)\//.test(full) ? full : commit, commit };
}

/** Only the chat that last took a lane may write to it while that chat is busy. */
export async function guard(
	owner: ConversationId | undefined,
	chat: ConversationId,
	live: (owner: ConversationId) => Promise<{ run?: unknown } | undefined>,
	args: LaneChange,
) {
	if (!owner || owner === chat) return;
	if ((await live(owner))?.run) throw toolRefusal("lane", args, [
		`name: Work lane ${JSON.stringify(args.name)} is in use, so wait for that chat to finish or choose another work lane.`,
	]);
}

export function missingWorkLane(args: LaneChange): Error {
	return toolRefusal("lane", args, [
		`name: No work lane is named ${JSON.stringify(args.name)}, so use {"action":"list"} with lane to find existing names.`,
	]);
}

export async function selectWorkLaneBase(env: ExecutionEnv, project: string, args: LaneChange, context: Context) {
	try {
		return await select(env, project, args.base, context);
	} catch (cause) {
		if (context.abortSignal?.aborted) throw cause;
		const reason = cause instanceof Error ? cause.message : String(cause);
		throw toolRefusal("lane", args, [
			`base: ${reason.trim()}, so specify a local branch, tag, or commit such as "HEAD".`,
		]);
	}
}
