import type { Context } from "@earendil-works/chord";
import type { Models } from "@earendil-works/pi-ai";
import type { ConversationId, PromptSection } from "@earendil-works/pi-durable";
import { LanesDoc } from "./lanes";
import type { IsPlanning } from "./plan-mode";

export type HostEnvironment = {
	host: string;
	version?: string;
	release?: boolean;
	commit?: string;
	neuve: { path: string; version?: string } | undefined;
	readBranch(folder: string, context: Context): Promise<string | undefined>;
};

export function environment(
	host: HostEnvironment | undefined,
	role: (chat: number) => string,
	planning: IsPlanning,
	ownTools?: (provider: string) => boolean,
	modelContext?: {
		models: Pick<Models, "getModel">;
		used: (chat: ConversationId, context: Context) => Promise<number | undefined>;
	},
): PromptSection {
	return {
		key: "ace-environment",
		async render({ conversationId, agent, env, read }, context) {
			const native = agent.model !== undefined && ownTools?.(agent.model.provider);
			const selection = agent.model;
			const model = selection && modelContext?.models.getModel(selection.provider, selection.modelId);
			const used = await modelContext?.used(conversationId, context);
			const modelName = model && model.name !== model.id ? `${model.name} (${model.id})` : selection?.modelId;
			const limit = model?.contextWindow.toLocaleString("en");
			// In tenths of the limit, so the section changes rarely and pi adds few copies of it.
			const tenth = used !== undefined && model?.contextWindow ? Math.min(9, Math.floor(10 * used / model.contextWindow)) * 10 : undefined;
			const contextUsage = tenth === undefined
				? `unknown. Context limit: ${limit ?? "unknown"} tokens`
				: `${tenth}–${tenth + 10}% of ${limit} tokens`;
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
			const branch = folder === undefined ? undefined : await host?.readBranch(folder, context);
			const buildKind = host?.release === undefined ? "" : host.release ? " (release build)" : " (source run)";
			const neuve = host?.neuve
				? `${host.neuve.path} (${host.neuve.version ?? "version unavailable"})`
				: host ? "not found on the host's PATH" : "unknown (host metadata unavailable)";
			return [
				`Execution host: ${host?.host ?? "unknown (host metadata unavailable)"}.`,
				`Running Ace build: version ${host?.version ?? "unknown"}${buildKind}, commit ${host?.commit ?? "unknown"}.`,
				`Installed neuve and its version: ${neuve}.`,
				`Role: ${role(conversationId)}. Working folder: ${folder ?? "unknown"}. Git branch: ${branch ?? "unknown"}.`,
				`Model: ${modelName ?? "unknown"}. Effort: ${agent.thinkingLevel ?? "default"}. Context used: ${contextUsage}.`,
				`Work lane: ${lane?.[0] ?? "none recorded for this folder"}. Runtime shell: ${hasShell ? `available (${shell})` : "unavailable"}.`,
				"Ace serves the channel, threads, work log, plan and tools. Neuve is the neuve command, its skill, reviews and the desk.",
				...(plan ? [] : ["Plans for the person to approve are written in Plan mode, which the person picks in the composer. Asked for one outside it, answer as usual and say so once."]),
			].join("\n");
		},
	};
}
