import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import * as catalog from "./catalog";
import { config, inside } from "./host-config";
import {git} from "./projects";
import type {LaneAssignment} from "./extension-protocol";
const FIRST_LANE = "work";
const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
async function output(dir: string, args: string[]): Promise<string> {
	const result = await git(dir, args);
	if (result.status !== 0) {
		throw new Error((result.stderr || result.stdout).trim() || `git ${args[0]} failed`);
	}
	return result.stdout.trim();
}

/** The repository's shared Git directory, which every worktree of one repository names. */
const common = async (dir: string) =>
	realpathSync(await output(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));

/** A branch's full ref name, or else the commit `revision` names. */
async function base(dir: string, revision: string): Promise<string> {
	const full = await git(dir, ["rev-parse", "--verify", "--symbolic-full-name", "--end-of-options", revision]);
	const name = full.status === 0 ? full.stdout.trim() : "";
	if (/^refs\/(heads|tags|remotes)\//.test(name)) return name;
	return output(dir, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${revision}^{commit}`])
		.catch(() => {
			throw new Error(`No branch, tag, or commit named ${revision}`);
		});
}

/**
 * The root chat's lane for a new channel: the worktree `requested` names, once it proves to be a
 * worktree of the project's repository outside the checkout, or else a new `work` lane the host
 * creates from the project's HEAD, as the lane tool would.
 */
export async function lane(
	record: catalog.Listing,
	requested: LaneAssignment | undefined,
): Promise<{ name: string; path: string; base: string }> {
	const against = await base(record.project, requested?.base || "HEAD");
	if (!requested) {
		const path = join(catalog.paths(record.id).lanes, FIRST_LANE);
		const commit = await output(record.project, ["rev-parse", "--verify", "HEAD^{commit}"]);
		mkdirSync(catalog.paths(record.id).lanes, { recursive: true });
		await output(record.project, [
			"worktree",
			"add",
			"-b",
			`${record.prefix}/${FIRST_LANE}`,
			path,
			commit,
		]);
		return { name: FIRST_LANE, path: realpathSync(path), base: against };
	}
	if (!NAME.test(requested.name)) throw new Error("A lane name must be lowercase kebab-case");
	if (!isAbsolute(requested.path) || !existsSync(requested.path)) {
		throw new Error(`There's no worktree at ${requested.path}`);
	}
	const path = realpathSync(requested.path);
	if (!statSync(path).isDirectory()) throw new Error(`${requested.path} is not a folder`);
	if (inside(path, record.project) || inside(record.project, path)) {
		throw new Error("A lane must be a worktree outside the project checkout");
	}
	if (inside(path, config.home)) throw new Error("A lane can't be inside the host's state");
	if (realpathSync(await output(path, ["rev-parse", "--show-toplevel"])) !== path) {
		throw new Error(`${requested.path} is not the top of a Git worktree`);
	}
	if (await common(path) !== await common(record.project)) {
		throw new Error(`${requested.path} is not a worktree of ${record.project}`);
	}
	const taken = catalog.list().find((other) => other.lane?.path === path);
	if (taken) throw new Error(`Channel ${taken.name} already started in ${requested.path}`);
	return { name: requested.name, path, base: against };
}


/** Neuve's coding isolation policy is composed after ordinary native channel admission. */
export async function assign(record: catalog.Listing, requested?: LaneAssignment): Promise<catalog.Listing> {
	try {
		const assigned = await lane(record, requested);
		catalog.write({...record, lane: assigned});
		return catalog.read(record.id);
	} catch (error) {
		catalog.remove(record.id);
		throw error;
	}
}
