import type { Models } from "@earendil-works/pi-ai";
import { AgentDoc, defineExtension, defineTool, type ConversationId, type ToolExecutionResult, type Tx } from "@earendil-works/pi-durable";
import { key as modelKey, modelGroups } from "@neuve/runtime/listed-models";
import { z } from "zod";

import { EffortSchema, selectableEfforts } from "./effort";
import { sameModel } from "./models";
import { ModelSettings, ownerInput, PendingModelDoc } from "./model-settings";
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

async function namedModels(text: readonly string[], settings: ModelSettings) {
	const options = await settings.listed().catch(() => []);
	const { models } = settings;
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
	const named = new Set(found.filter(({ entry }) =>
		qualified.some(match => match.entry === entry)
		|| !qualified.some(match => match.entry.modelId === entry.modelId)).map(({ entry }) => entry));
	const groups = modelGroups(options, settings.accountStatuses()).filter(group => group.some(model => named.has(model)));
	return { groups, remaining, options };
}

function servingModel(groups: [ModelOption, ...ModelOption[]][], requested: ModelRef): ModelRef | undefined {
	const [group] = groups;
	if (groups.length !== 1 || !group?.some(route => sameModel(route, requested))) return;
	const [{ provider, modelId }] = group;
	return { provider, modelId };
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

async function namedSettings(tx: Tx, chat: ConversationId, text: string, settings: ModelSettings) {
	const { groups, remaining, options } = await namedModels(words(text), settings);
	const stored = await tx.doc(AgentDoc, chat);
	const current = await tx.doc(PendingModelDoc, chat);
	const effective = groups[0]?.[0] ?? options.find(option => sameModel(option, current.pending?.model ?? stored.model));
	const efforts = effective ? selectableEfforts(effective.efforts) : [];
	const foundEfforts = [...new Set(matches(remaining, efforts, value => effortNames[value]).map(({ entry }) => entry))];
	return { groups, foundEfforts };
}

function unmatched({ groups, foundEfforts }: Awaited<ReturnType<typeof namedSettings>>): string {
	const modelNames = groups.map(([first]) => modelKey(first)).join(", ") || "no available model";
	const effortNames = foundEfforts.length ? `effort ${foundEfforts.join(", ")}` : "no available effort";
	return `The owner's latest message matches ${modelNames} and ${effortNames}.`
		+ (groups.length > 1 ? " Name the account when a model appears twice." : "");
}

export async function modelNamedByOwner(
	tx: Tx, chat: ConversationId, requested: ModelRef, settings: ModelSettings,
): Promise<{ model: ModelRef } | { refusal: string }> {
	const text = await ownerInput(tx, chat);
	if (text === undefined) return { refusal: refused };
	const named = await namedSettings(tx, chat, text, settings);
	const model = servingModel(named.groups, requested);
	return model ? { model } : { refusal: unmatched(named) };
}

export function modelTool(
	settings: ModelSettings,
	findChat: (tx: Tx, from: ConversationId, role: "main" | "implementer" | "reviewer", part?: string) =>
		Promise<{ chat: ConversationId } | { refusal: string }>,
) {
	return defineExtension({
		name: "neuve-agent-model",
		tools: [defineTool({
			...argumentsForModel,
			description: "Set an agent's model or effort when the channel owner explicitly names it in their latest message to you. Supply only what they named. A busy agent keeps the change pending until the channel sends it an input while idle. Ask the owner to name the model or account if ambiguous.",
			execute: ({ role, part, model, effort }, api, context) => api.commit<ToolExecutionResult>(async tx => {
				const text = await ownerInput(tx, api.conversationId);
				if (text === undefined) return { content: [{ type: "text", text: refused }], isError: true };
				const target = await findChat(tx, api.conversationId, role, part);
				if ("refusal" in target) return {
					content: [{ type: "text", text: target.refusal }], isError: true,
				};
				const { chat } = target;
				const named = await namedSettings(tx, chat, text, settings);
				const { groups, foundEfforts } = named;
				const serving = model && servingModel(groups, model);
				if ((!model && effort === undefined) || groups.length > 1 || foundEfforts.length > 1
					|| model !== undefined && serving === undefined
					|| effort !== undefined && (foundEfforts.length !== 1 || foundEfforts[0] !== effort)) {
					return { content: [{ type: "text", text: unmatched(named) }], isError: true };
				}
				const change: PendingModel = {
					...(serving ? { model: serving } : {}),
					...(effort === undefined ? {} : { effort }),
				};
				const result = await settings.select(tx, chat, change);
				const selected = result.pending?.model ?? result.model;
				const level = result.pending?.effort ?? result.effort;
				return { content: [{ type: "text", text: `${selected.provider}/${selected.modelId}, effort ${level}${result.pending ? ", pending until an input is sent while idle." : "."}` }] };
			}, context),
		})],
	});
}
