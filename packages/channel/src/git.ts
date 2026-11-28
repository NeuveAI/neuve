import type { Context } from "@earendil-works/chord";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";

export type GitCommand = readonly [subcommand: string, ...args: string[]];

// .gitmodules can override config defaults, so use flags for commands that can recurse.
const submoduleFlags = new Map<string, readonly string[]>([
	["diff", ["--ignore-submodules=dirty", "--submodule=short"]],
	["status", ["--ignore-submodules=dirty"]],
	["fetch", ["--no-recurse-submodules"]],
]);

export function gitArgs([command, ...args]: GitCommand, config: readonly string[] = []): string[] {
	if (!command || command.startsWith("-")) throw new Error("Expected a Git subcommand first");
	return [
		...config.flatMap(value => ["-c", value]),
		"-c", "core.fsmonitor=false",
		// A relative hooks path resolves inside the lane, where an agent writes.
		"-c", "core.hooksPath=/dev/null",
		"-c", "submodule.recurse=false",
		command, ...(submoduleFlags.get(command) ?? []), ...args,
	];
}

export function quote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Runs git and returns stdout. Pathspecs are literal so file names can't act as globs, reads take
 * no optional locks so they never contend with the agent's own git commands, and fetches fail
 * rather than wait on a credential prompt no one can answer.
 */
export async function git(
	env: ExecutionEnv,
	args: GitCommand,
	context: Context,
	options: { cwd?: string; ok?: number[]; quiet?: boolean } = {},
): Promise<string> {
	const command = gitArgs(args).map(quote).join(" ");
	const shell = `GIT_LITERAL_PATHSPECS=1 GIT_OPTIONAL_LOCKS=0 GIT_TERMINAL_PROMPT=0 git ${command}${options.quiet ? " 2>/dev/null" : ""}`;
	let output = "";
	const result = await env.exec(
		shell,
		{
			...(options.cwd ? { cwd: options.cwd } : {}),
			onOutput: (chunk) => (output += chunk),
		},
		context,
	);
	if (!result.ok) throw result.error;
	if (!(options.ok ?? [0]).includes(result.value.exitCode)) {
		throw new Error(output.trim() || `${shell} exited ${result.value.exitCode}`);
	}
	return output;
}
