import type { Context } from "@earendil-works/chord";
import type { PromptSection } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { LanesDoc } from "./lanes";

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

export function environment(host: HostEnvironment | undefined, role: (chat: number) => string | undefined): PromptSection {
	return {
		key: "ace-environment",
		async render({ conversationId, agent, env, read }, context) {
			// File access alone, or an executable login shell on the host, grants no runtime shell.
			const shell = !!env && agent.tools.some(tool => tool.name === "bash");
			const lanes = (await read.snapshot(LanesDoc, context))?.lanes ?? {};
			const lane = Object.entries(lanes).find(([, lane]) => lane.path === (env?.cwd ?? agent.cwd));
			const [branch, neuve] = shell ? await Promise.all([
				probe(env!, "git symbolic-ref --quiet --short HEAD || { git rev-parse --verify HEAD >/dev/null 2>&1 && printf 'detached HEAD'; }", context),
				probe(env!, 'p=$(command -v neuve) || exit 1; printf "%s\\n" "$p"; "$p" --version', context),
			]) : ["unknown (no runtime shell)", "unknown (no runtime shell)"];
			return [
				`Execution host: ${host?.host ?? "unknown (host metadata unavailable)"}.`,
				`Running Ace build: version ${host?.version ?? "unknown (not supplied by launcher)"}; commit ${host?.commit ?? "unknown (not supplied by launcher)"}. This is running-build provenance, not the lane HEAD.`,
				`Installed Neuve executable and reported version: ${neuve}.`,
				`Role: ${role(conversationId) ?? "main chat"}. Working folder: ${env?.cwd ?? agent.cwd ?? "unknown (no execution environment)"}. Git branch: ${branch}.`,
				`Work lane: ${lane ? lane[0] : "none recorded for this folder"}. Runtime shell: ${shell ? "available (bash tool and execution environment)" : "unavailable (no bash tool or execution environment)"}.`,
				"Ace serves the channel, threads, work log, plan and tools. Neuve is the neuve command, its skill, reviews and desk, not a native app. Repository setup and checks belong in AGENTS.md and docs/development.md; read those instructions rather than infer commands from host facts.",
			].join("\n");
		},
	};
}
