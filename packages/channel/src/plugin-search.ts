import type { Context } from "@earendil-works/chord";
import { Type, type Message, type Tool } from "@earendil-works/pi-ai";
import { toToolDeclaration } from "@earendil-works/pi-ai/utils/transcript";
import {
	defineExtension, defineTool, GenerationTask, hook, ResetEntry,
	type Conversation, type ConversationId, type Cursor, type ToolRegistration,
} from "@earendil-works/pi-durable";
import { z } from "zod";
import type { IsPlanning } from "./plan-mode";
import type { ModelRef } from "./protocol";

export const PLUGIN_SEARCH = "plugin_tool_search";
export const deferredPluginTool = (tool: Tool) => "deferred" in tool && tool.deferred === true;

const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

function matches(tools: readonly Tool[], query: string, limit: number): Tool[] {
	const value = query.trim();
	if (value.startsWith("select:")) {
		const byName = new Map(tools.map(tool => [tool.name, tool]));
		return [...new Set(value.slice("select:".length).split(",").map(name => name.trim()))]
			.flatMap(name => {
				const tool = byName.get(name);
				return tool ? [tool] : [];
			}).slice(0, limit);
	}
	const terms = [...new Set(words(value))];
	const required = new Set(value.split(/\s+/).filter(term => term.startsWith("+")).flatMap(words));
	return tools.flatMap(tool => {
		const name = new Set(words(tool.name));
		const description = new Set(words(tool.description));
		const hits = terms.map(term => name.has(term) ? 10 : description.has(term) ? 1 : 0);
		if (terms.some((term, index) => required.has(term) && !hits[index])) return [];
		const score = hits.reduce<number>((sum, hit) => sum + hit, 0);
		return score > 0 ? [{ tool, score }] : [];
	}).sort((a, b) => b.score - a.score).slice(0, limit).map(({ tool }) => tool);
}

const searchNames = z.array(z.string());
function discovered(message: Message): string[] | undefined {
	if (message.role !== "toolResult" || message.toolName !== PLUGIN_SEARCH || message.isError) return;
	const names = searchNames.safeParse(message.details);
	return names.success ? names.data : undefined;
}

async function loadedTools(conversation: Conversation, available: ReadonlySet<string>, context: Context, callId?: string) {
	const loaded = new Set<string>();
	if (available.size === 0) return loaded;
	// Compaction moves the model's context head. Its original tool results stay in conversation history.
	let cursor: Cursor | undefined;
	do {
		const page = await conversation.entries({}, 64, cursor, context);
		for (const entry of page.items) {
			if (ResetEntry.is(entry)) return loaded;
			for (const message of entry.model ?? []) {
				if (callId !== undefined) {
					if (message.role === "assistant" && message.content.some(block => block.type === "toolCall" && block.id === callId))
						callId = undefined;
					continue;
				}
				for (const name of discovered(message) ?? []) if (available.has(name)) loaded.add(name);
			}
			if (loaded.size === available.size) return loaded;
		}
		cursor = page.next;
	} while (cursor);
	return loaded;
}

export function pluginDiscovery(
	conversationFor: (id: ConversationId, context: Context) => Promise<Conversation | undefined>,
	nativeSearch: (model: ModelRef | undefined) => string | undefined,
	planning: IsPlanning,
	ownsTool: (name: string) => boolean,
	toolsForAttendance: (tools: readonly Tool[], id: ConversationId, context: Context) => Promise<readonly Tool[]>,
) {
	const search = defineTool({
		name: PLUGIN_SEARCH,
		description: "Find and load plugin tools for the next request. Use select:name1,name2 for exact names, or keywords with +term for a required word.",
		parameters: Type.Object({
			query: Type.String(),
			max_results: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum results. Defaults to 5." })),
		}),
		replay: "safe",
		outputLimits: { maxBytes: Number.POSITIVE_INFINITY },
		async execute({ query, max_results = 5 }, api, context) {
			const agent = await api.agent(context);
			const tools = nativeSearch(agent.model) ? [] : matches(
				await toolsForAttendance(agent.tools.filter(deferredPluginTool), api.conversationId, context), query, max_results,
			);
			return {
				details: tools.map(tool => tool.name),
				content: tools.length
					? tools.map(tool => ({ type: "text", text: JSON.stringify(toToolDeclaration(tool)) }))
					: [{ type: "text", text: "No plugin tools matched." }],
			};
		},
	});
	return {
		extension: defineExtension({
			name: "ace-plugin-search",
			tools: [search],
			hooks: [hook(GenerationTask, {
				async beforeRequest({ messages }, api, context) {
					const conversation = await conversationFor(api.conversationId, context);
					if (!conversation) return;
					const agent = await conversation.agent(context);
					const native = nativeSearch(agent.model);
					const plan = await planning(api.conversationId, context);
					const candidates = plan ? [] : await toolsForAttendance(agent.tools.filter(deferredPluginTool), api.conversationId, context);
					const available = new Set(candidates.map(tool => tool.name));
					const loaded = native ? available : await loadedTools(conversation, available, context);
					const core = new Set(agent.tools.filter(tool => !deferredPluginTool(tool)).map(tool => tool.name));
					const visible = (name: string) => {
						if (name === PLUGIN_SEARCH) return !native && available.size > 0;
						if (ownsTool(name) || available.has(name)) return loaded.has(name) || core.has(name);
						return true;
					};
					const transformed = messages.map(message => {
						if (message.role === "system" && message.toolsAdded) {
							const toolsAdded = message.toolsAdded.filter(tool => visible(tool.name));
							return toolsAdded.length === message.toolsAdded.length ? message : { ...message, toolsAdded };
						}
						const names = discovered(message);
						if (message.role === "toolResult" && names?.some(name => !available.has(name))) {
							return {
								...message,
								details: names.filter(name => available.has(name)),
								content: [{ type: "text" as const, text: "The search included plugin tools that are now unavailable." }],
							};
						}
						return message;
					});
					return { messages: transformed };
				},
			})],
		}),
		guard(tool: ToolRegistration): ToolRegistration {
			return {
				...tool,
				async execute(args, api, context) {
					if (!(await toolsForAttendance([tool], api.conversationId, context)).length) return {
						content: [{ type: "text", text: "This tool is unavailable in a person-driven chat." }],
						isError: true,
					};
					const agent = await api.agent(context);
					if (!nativeSearch(agent.model)) {
						const conversation = await conversationFor(api.conversationId, context);
						const loaded = conversation && await loadedTools(conversation, new Set([tool.name]), context, api.callId);
						if (!loaded || !loaded.has(tool.name)) return {
							content: [{ type: "text", text: `Use ${PLUGIN_SEARCH} to load ${tool.name} before calling it.` }],
							isError: true,
						};
					}
					return tool.execute(args, api, context);
				},
			};
		},
	};
}
