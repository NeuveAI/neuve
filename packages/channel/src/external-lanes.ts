import type { Context } from "@earendil-works/chord";
import {
	configure,
	defineExtension,
	defineTool,
	type Extension,
	LiveDoc,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";

import { git, quote } from "./git";
import {
	checkWorkLaneName,
	guard,
	laneArguments,
	LanesDoc,
	missingWorkLane,
	select,
	selectWorkLaneBase,
	type Selection,
} from "./lanes";

export { LanesDoc } from "./lanes";

/**
 * The initial channel name remains the lane prefix after a rename. `lanes` is the directory the
 * host gives this channel's lane worktrees, outside the project checkout. `env` reaches the
 * project's Git for lane operations.
 */
export type Place = {
	name: string;
	project: string;
	lanes: string;
	env(cwd: string): ExecutionEnv;
};

/** Whether `cwd` is outside the project checkout, where ordinary tool environments are allowed. */
export function isPlaced(cwd: string, project: string): boolean {
	return cwd !== project && !cwd.startsWith(`${project}/`);
}

async function addWorktree(env: ExecutionEnv, project: string, branch: string, path: string, commit: string, context: Context) {
	await git(env, `-C ${quote(project)} worktree add -b ${quote(branch)} ${quote(path)} ${quote(commit)}`, context);
}

export async function buildWorktree(place: Place, name: string, context: Context, source?: { branch: string; base: string }, recorded?: { path: string; base?: string }) {
	const env = place.env(place.project);
	const path = `${place.lanes}/${name}`;
	const branch = `${place.name}/${name}`;
	if (recorded && recorded.path !== path) throw new Error("The recorded work lane is outside its host-owned location.");
	const exists = await env.exists(path, context);
	if (!exists.ok) throw exists.error;
	if (exists.value || recorded) {
		const worktrees = await git(env, `-C ${quote(place.project)} worktree list --porcelain -z`, context);
		const found = worktrees.split("\0\0").map(record => record.split("\0")).find(fields =>
			fields[0] === `worktree ${path}` && fields.includes(`branch refs/heads/${branch}`));
		if (exists.value) {
			// Git may have created the worktree before the channel could record it.
			const base = found?.find(field => field.startsWith("HEAD "))?.slice(5);
			if (!base) throw new Error("The worktree path is already in use.");
			return { path, branch, base: recorded?.base ?? source?.base ?? base };
		}
		// Archive removes the folder, not its branch or the chat's durable lane assignment.
		const base = (await git(env, `-C ${quote(place.project)} rev-parse --verify ${quote(`refs/heads/${branch}^{commit}`)}`, context)).trim();
		const prunable = found?.some(field => field === "prunable" || field.startsWith("prunable "));
		await git(env, `-C ${quote(place.project)} worktree add${prunable ? " -f" : ""} ${quote(path)} ${quote(branch)}`, context);
		return { path, branch, base: recorded?.base ?? base };
	}
	// An unrecorded branch with no matching worktree is not an interrupted creation we can prove.
	const collision = await git(env, `-C ${quote(place.project)} for-each-ref --format='%(refname)' ${quote(`refs/heads/${branch}`)}`, context);
	if (collision.split("\n").includes(`refs/heads/${branch}`)) throw new Error(`Branch ${branch} already exists without a recorded worktree; it was not adopted.`);
	const { commit } = await select(env, place.project, source ? `refs/heads/${source.branch}` : "HEAD", context);
	await addWorktree(env, place.project, branch, path, commit, context);
	return { path, branch, base: source?.base ?? commit };
}

export function lanes(place: Place): Extension {
	return defineExtension({
		name: "ace-lanes",
		tools: [
			defineTool({
				...laneArguments,
				description:
					"Start a work lane (an isolated Git worktree and branch outside the project checkout) for a new unit of work, switch to an existing work lane, or list work lanes. A new work lane starts from origin's default branch, fetched first, or from the project's HEAD without origin, unless base names a branch, tag, or commit; a remote branch such as origin/release is fetched first. The work lane's Diff compares against that base. Passing base for an existing work lane only changes what its Diff compares against; it never moves the worktree. Starting or switching makes the work lane your working directory.",
				// A rerun reuses its memoized base and finds the worktree it created.
				replay: "safe",
				executionMode: "sequential",
				execute: async (args, api, context) => {
					const env = place.env(place.project);
					if (args.action === "list") {
						const state = await api.snapshot(LanesDoc, context);
						const names = Object.keys(state?.lanes || {});
						return { content: [{ type: "text", text: names.join("\n") || "No work lanes yet." }] };
					}
					checkWorkLaneName(args);
					const { action, name, base } = args;
					const branch = `${place.name}/${name}`;
					const recorded = (await api.snapshot(LanesDoc, context))?.lanes[name];
					const created = `${place.lanes}/${name}`;
					let path = recorded?.path || created;
					const exists = await env.exists(path, context);
					if (!exists.ok) throw exists.error;
					if (action === "switch" && !exists.value) throw missingWorkLane(args);
					await guard(
						recorded?.chat,
						api.conversationId,
						(chat) => api.snapshot(LiveDoc, chat, context),
						args,
					);
					// The selection is durable before the worktree exists, so a rerun after a crash doesn't
					// fetch again.
					let selection = await api.memo<Selection>("selection", context);
					if (!selection && (base || !exists.value)) {
						selection = await api.memo(
							"selection",
							await selectWorkLaneBase(env, place.project, args, context),
							context,
						);
					}
					// The worktree starts at the memoized commit, so a rerun cannot start it somewhere else.
					if (!exists.value) {
						path = created;
						await addWorktree(env, place.project, branch, path, selection!.commit, context);
					}
					// Another chat can take the lane while this call fetches, so ownership is checked again
					// where it is claimed, and the lane keeps the base committed by then.
					const target = await api.commit(async (tx) => {
						const doc = await tx.doc(LanesDoc);
						const current = doc.lanes[name];
						await guard(current?.chat, api.conversationId, (chat) => tx.doc(LiveDoc, chat), args);
						const target = selection?.base || current?.base;
						doc.lanes[name] = {
							chat: api.conversationId,
							path,
							...(target ? { base: target } : {}),
							...(current?.hostCreated && current.path === path ? { hostCreated: true as const } : {}),
						};
						await configure(tx, api.conversationId, { cwd: path });
						return target;
					}, context);
					const verb = exists.value ? "Switched to" : "Started";
					const from = exists.value ? "" : ` from ${selection!.commit.slice(0, 12)}`;
					const against = target ? `. Its Diff compares against ${target}` : "";
					return {
						content: [{
							type: "text",
							text: `${verb} work lane ${name} on branch ${branch}${from} at ${path}${against}`,
						}],
					};
				},
			}),
		],
	});
}
