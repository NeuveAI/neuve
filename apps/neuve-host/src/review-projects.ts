import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { config, inside } from "./host-config";
import { git } from "./projects";
export { git, list, checkout } from "./projects";
export { project as repository } from "./github";
export function validatePath(value: string): void {
	let parent = resolve(value);
	const suffix: string[] = [];
	while (!existsSync(parent)) {
		const next = dirname(parent);
		if (next === parent) throw new Error("The project path has no available parent directory.");
		suffix.unshift(basename(parent)); parent = next;
	}
	const actual = join(realpathSync(parent),...suffix);
	if (config.volume && !inside(actual,config.volume)) throw new Error(`Projects must stay on the configured storage volume ${config.volume}. Choose an existing checkout there; Neuve will not move or copy this folder.`);
	if (inside(actual,config.home) || inside(actual,config.lanes)) throw new Error("A project cannot be opened inside the host's state or lane directories.");
}
export async function validateRepository(path: string): Promise<void> {
	validatePath(path);
	const common = await git(path,["rev-parse", "--path-format=absolute", "--git-common-dir"]);
	if (common.status === 0 && config.volume && !inside(realpathSync(common.stdout.trim()),config.volume)) throw new Error(`This checkout's Git repository is outside the configured storage volume ${config.volume}. Open a repository whose objects are also on that volume.`);
}
