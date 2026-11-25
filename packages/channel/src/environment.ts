import type { Context } from "@earendil-works/chord";
import type { PromptSection } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { LanesDoc } from "./lanes";
import type { IsPlanning } from "./plan-mode";

/** Immutable provenance supplied by the host, never inferred from a mutable chat checkout. */
export type HostEnvironment = { host: string; version?: string; commit?: string };

async function probe(env: ExecutionEnv, command: string, context: Context): Promise<string> {
	let output = "";
	try {
		const result = await env.exec(command, {
			timeout: 2,
			onOutput: chunk => { output = (output + chunk).slice(0, 2048); },
		}, context);
		return result.ok && result.value.exitCode === 0 && output.trim()
			? output.trim() : "unknown (probe unavailable or failed)";
	} catch {
		return "unknown (probe unavailable or failed)";
	}
}

export function environment(
	host: HostEnvironment | undefined,
	role: (chat: number) => string,
	planning: IsPlanning,
	ownTools?: (provider: string) => boolean,
): PromptSection {
	return {
		key: "ace-environment",
		async render({ conversationId, agent, env, read }, context) {
			const native = agent.model !== undefined && ownTools?.(agent.model.provider);
			const plan = await planning(conversationId, context);
			const hasShell = native
				? agent.cwd !== undefined
				: env !== undefined && !plan && agent.tools.some(tool => tool.name === "bash");
			const shell = native
				? plan ? "runtime's own shell, read-only in Plan mode" : "runtime's own shell"
				: "Ace's bash tool";
			const folder = env?.cwd ?? agent.cwd;
			const lanes = (await read.snapshot(LanesDoc, context))?.lanes ?? {};
			const lane = Object.entries(lanes).find(([, lane]) => lane.path === folder);
			const notProbed = "not probed (Ace has no execution environment)";
			const [branch, neuve] = env ? await Promise.all([
				probe(env, "git symbolic-ref --quiet --short HEAD || { git rev-parse --verify HEAD >/dev/null 2>&1 && printf 'detached HEAD'; }", context),
				probe(env, 'p=$(command -v neuve) || exit 1; printf "%s\\n" "$p"; "$p" --version', context),
			]) : [notProbed, notProbed];
			return [
				`Execution host: ${host?.host ?? "unknown (host metadata unavailable)"}.`,
				`Running Ace build: version ${host?.version ?? "unknown"}, commit ${host?.commit ?? "unknown"}.`,
				`Installed neuve and its version: ${neuve}.`,
				`Role: ${role(conversationId)}. Working folder: ${folder ?? "unknown"}. Git branch: ${branch}.`,
				`Work lane: ${lane?.[0] ?? "none recorded for this folder"}. Runtime shell: ${hasShell ? `available (${shell})` : "unavailable"}.`,
				"Ace serves the channel, threads, work log, plan and tools. Neuve is the neuve command, its skill, reviews and the desk.",
			].join("\n");
		},
	};
}
