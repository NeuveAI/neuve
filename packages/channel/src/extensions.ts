import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import type { ConversationId, Cursor, Extension, Harness, Registry, ToolRegistration } from "@earendil-works/pi-durable";
import type { Effort, ModelRef, Usage } from "./protocol";
import type { Log } from "./log";
import { type IsPlanning, planTools } from "./plan-mode";

export type Admission = {
	invoke(author: string): Promise<void>;
	serialize<T>(chat: number | undefined, work: () => Promise<T>): Promise<T>;
};

/** Native pi extensions are installed before recovery. Binding precedes scheduler resume. */
export type ChannelExtension = {
	extensions: readonly Extension[];
	environment?(cwd: string): boolean;
	attach?(harness: Harness, admission: Admission): void | Promise<void>;
	tool?(tool: ToolRegistration): ToolRegistration;
	onConversation?(id: ConversationId): void;
	priced?(model: ModelRef): boolean;
	thinkingLevel?: Effort;
	nonTurnModels?(kind: "caption" | "recap", chat: ConversationId): Models;
};

export function install(
	registry: Registry,
	extension: ChannelExtension | undefined,
	planning: IsPlanning,
	confinedReads: boolean,
	log: Log,
	buildPaused: (chat: ConversationId, context: Context) => Promise<string | undefined>,
): void {
	for (const item of extension?.extensions || []) registry.install(item);
	const guard = (registration: ToolRegistration): ToolRegistration => {
		const tool = extension?.tool?.(registration) ?? registration;
		return {
			...tool,
			async execute(args, api, context) {
				const paused = await buildPaused(api.conversationId, context);
				if (paused) return { content: [{ type: "text", text: paused }], isError: true };
				// Pi re-enters execute directly when recovering an interrupted replay-safe tool.
				const allowed = planTools.has(registration.name)
					&& (registration.name !== "read" || confinedReads);
				if (!allowed && await planning(api.conversationId, context)) {
					const reason = registration.name === "read"
						? "Plan mode requires confined file access, which is unavailable here."
						: `Plan mode is read-only. The ${registration.name} tool is unavailable in plan mode.`;
					log("info", "plan.tool.refused", { chat: api.conversationId, tool: registration.name });
					return { content: [{ type: "text", text: reason }], isError: true };
				}
				return tool.execute(args, api, context);
			},
		};
	};
	for (const installed of registry.snapshot().installed()) {
		if (installed.tools) registry.install({ ...installed, tools: installed.tools.map(guard) });
	}
}

export async function observe(harness: Harness, extension?: ChannelExtension): Promise<() => void> {
	const stop = harness.subscribeCommits(({ changes }) => {
		for (const change of changes) if (change.type === "conversation") extension?.onConversation?.(change.value.id);
	});
	try {
		let cursor: Cursor | undefined;
		do {
			const page = await harness.commit((tx) => tx.scanConversations({}, 256, cursor), context);
			for (const record of page.items) extension?.onConversation?.(record.id);
			cursor = page.next;
		} while (cursor);
		return stop;
	} catch (error) {
		stop();
		throw error;
	}
}

export function price(usage: Usage, keys: readonly string[], priced?: ChannelExtension["priced"]): Usage {
	if (!priced) return usage;
	if (!keys.length || keys.some((key) => {
		const separator = key.indexOf("/");
		return separator < 1 || !priced({provider: key.slice(0, separator), modelId: key.slice(separator + 1)});
	})) delete usage.cost;
	return usage;
}
