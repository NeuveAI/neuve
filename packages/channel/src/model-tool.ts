import type { Models } from "@earendil-works/pi-ai";
import { AgentDoc, defineExtension, defineTool, type ConversationId, type ToolExecutionResult, type Tx } from "@earendil-works/pi-durable";
import { z } from "zod";

import { EffortSchema } from "./effort";
import { sameModel } from "./models";
import { ModelSettings, OwnerInputDoc, PendingModelDoc } from "./model-settings";
import { ModelRefSchema } from "./parse";
import { AGENT_MODEL_TOOL, type Effort, type ModelOption, type ModelRef, type PendingModel } from "./protocol";
import { toolArguments } from "./tool-arguments";

const argumentsForModel = toolArguments(AGENT_MODEL_TOOL, z.strictObject({
	role: z.enum(["main", "implementer", "reviewer"]),
	part: z.string().optional().describe("The agent's path scope. Omit for an agent assigned to the whole plan."),
	model: ModelRefSchema.optional().describe("The provider and model ID named in the owner's message."),
	effort: EffortSchema.optional().describe("The effort named in the owner's message."),
}));

const words = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

function occurrences(text: readonly string[], aliases: readonly string[]): [number, number][] {
	return aliases.flatMap(alias => {
		const name = words(alias);
		if (!name.length) return [];
		return text.flatMap((_, index): [number, number][] =>
			name.every((word, offset) => text[index + offset] === word) ? [[index, index + name.length]] : []);
	});
}

/** A longer name owns its words, so "extra high" never also names "high". */
function matches<T>(text: readonly string[], entries: readonly T[], aliases: (entry: T) => string[]) {
	const found = entries.flatMap(entry => occurrences(text, aliases(entry)).map(span => ({ entry, span })));
	return found.filter(({ span: [from, to] }) => !found.some(({ span: [start, end] }) =>
		start <= from && end >= to && (start < from || end > to)));
}

function namedModels(text: readonly string[], options: ModelOption[], models: Models) {
	const found = matches(text, options, ({ provider, modelId }) => {
		const label = models.getModel(provider, modelId)?.name ?? modelId;
		const names = [...new Set([modelId, label])];
		return names.flatMap(name => [name, `${provider} ${name}`]);
	});
	const remaining = text.map((word, index) => found.some(({ span: [start, end] }) => index >= start && index < end) ? "" : word);
	// A qualifier disambiguates accounts for the same named model, without hiding another named model.
	const qualified = found.filter(({ entry, span: [start, end] }) => {
		const label = models.getModel(entry.provider, entry.modelId)?.name ?? entry.modelId;
		return end - start > Math.max(words(label).length, words(entry.modelId).length)
			|| occurrences(remaining, [entry.account ?? entry.provider, models.getProvider(entry.provider)?.name ?? ""]).length > 0;
	});
	const named = [...new Set(found.filter(({ entry }) =>
		qualified.some(match => match.entry === entry)
		|| !qualified.some(match => match.entry.modelId === entry.modelId)).map(({ entry }) => entry))];
	return { named, remaining };
}

const effortNames: Record<Effort, string[]> = {
	off: ["effort off", "no effort", "no reasoning"],
	minimal: ["minimal"],
	low: ["low"],
	medium: ["medium"],
	high: ["high"],
	xhigh: ["xhigh", "x-high", "extra high"],
	max: ["max", "maximum"],
};

const refused = "The owner's latest message must name one available model or effort. Name the account when a model appears twice.";

export async function modelNamedByOwner(
	tx: Tx, chat: ConversationId, requested: ModelRef, settings: ModelSettings,
): Promise<boolean> {
	const { text } = await tx.doc(OwnerInputDoc, chat);
	if (text === undefined) return false;
	const { named } = namedModels(words(text), await settings.listed().catch(() => []), settings.models);
	return named.length === 1 && sameModel(named[0], requested);
}

export function modelTool(
	settings: ModelSettings,
	findChat: (tx: Tx, from: ConversationId, role: "main" | "implementer" | "reviewer", part?: string) => Promise<ConversationId | undefined>,
) {
	return defineExtension({
		name: "neuve-agent-model",
		tools: [defineTool({
			...argumentsForModel,
			description: "Set an agent's model or effort when the channel owner explicitly names it in their latest message to you. Supply only what they named. A busy agent uses the change on its next run. Ask the owner to name the model or account if ambiguous.",
			execute: ({ role, part, model, effort }, api, context) => api.commit<ToolExecutionResult>(async tx => {
				const { text } = await tx.doc(OwnerInputDoc, api.conversationId);
				if (text === undefined) return { content: [{ type: "text", text: refused }], isError: true };
				const chat = await findChat(tx, api.conversationId, role, part);
				if (chat === undefined) return {
					content: [{ type: "text", text: "No agent has that role and path scope in this plan." }], isError: true,
				};
				const options = await settings.listed().catch(() => []);
				const { named, remaining } = namedModels(words(text), options, settings.models);
				const stored = await tx.doc(AgentDoc, chat);
				const current = await tx.doc(PendingModelDoc, chat);
				const effective = named[0] ?? options.find(option => sameModel(option, current.pending?.model ?? stored.model));
				const efforts = effective?.efforts ?? [];
				const foundEfforts = [...new Set(matches(remaining, efforts, value => effortNames[value]).map(({ entry }) => entry))];
				if ((!model && effort === undefined) || named.length > 1 || foundEfforts.length > 1
					|| model !== undefined && (named.length !== 1 || !sameModel(named[0], model))
					|| effort !== undefined && (foundEfforts.length !== 1 || foundEfforts[0] !== effort)) {
					return { content: [{ type: "text", text: refused }], isError: true };
				}
				const change: PendingModel = {
					...(model ? { model } : {}),
					...(effort === undefined ? {} : { effort }),
				};
				const result = await settings.select(tx, chat, change);
				const selected = result.pending?.model ?? result.model;
				const level = result.pending?.effort ?? result.effort;
				return { content: [{ type: "text", text: `${selected.provider}/${selected.modelId}, effort ${level}${result.pending ? ", on the next run." : "."}` }] };
			}, context),
		})],
	});
}
