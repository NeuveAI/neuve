import type { Context } from "@earendil-works/chord";
import type { AssistantMessage, Message, TextContent } from "@earendil-works/pi-ai";
import {
	AgentDoc,
	AssistantEntry,
	configure,
	defineExtension,
	defineTool,
	type EntryId,
	type Extension,
	GenerationTask,
	hook,
	type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { z } from "zod";

import type { Delivery } from "./protocol";
import type { Channel } from "./channel";
import { MetadataExtension } from "./metadata";
import * as room from "./room";
import { toolArguments, toolRefusal } from "./tool-arguments";

async function answer(api: ToolExecutionApi, id: EntryId, context: Context): Promise<string> {
	const entry = await api.commit((tx) => tx.entry(AssistantEntry, id), context);
	const message = entry?.model?.[0] as AssistantMessage | undefined;
	return message ? room.text(message) : "";
}

const SubagentModel = z.string().regex(/^[^/\s]+\/\S+$/)
	.describe("A model in provider/model-id form. Omit to inherit the parent chat's model.");
const subagentArguments = toolArguments("subagent", z.strictObject({
	task: z.string().describe("What the subagent should do"),
	model: SubagentModel.optional(),
}), { model: "a model in provider/model-id form, or omit model to inherit the parent chat's model" }, { coerce: true });

/**
 * A subagent works in a child chat owned by this tool call's task, so stopping or killing the parent
 * reaches the child. The child stays in the channel afterwards for people to read or continue.
 * `without` lists extensions a child chat must not have, such as questions nobody would see.
 */
export const subagent = (submitInput: Channel["submitInput"], ...without: Extension[]): Extension =>
	defineExtension({
		name: "ace-subagent",
		tools: [
			defineTool({
				...subagentArguments,
				description:
					"Delegate a self-contained piece of work to a subagent in a new chat of this channel and wait for its answer. It does not see this chat, so give it everything it needs. It starts in your current work lane; tell it to start its own work lane for separate work.",
				// A rerun after a crash finds the child it created and the submission it made.
				replay: "safe",
				execute: async (args, api, context) => {
					// Pi recovery can execute a stored call without preparing its arguments again.
					if (args.model && !SubagentModel.safeParse(args.model).success) subagentArguments.prepareArguments(args);
					const split = args.model?.indexOf("/") ?? 0;
					const change = args.model && { provider: args.model.slice(0, split), modelId: args.model.slice(split + 1) };
					const child = await api.commit(async (tx) => {
						const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
						if (existing) return existing.id;
						const created = await tx.createConversation({
							ownership: { kind: "task", taskId: api.taskId },
						});
						await configure(tx, created.id, {
							extensions: { remove: [subagent(submitInput), MetadataExtension, ...without] },
							...(change ? { model: change } : {}),
						});
						return created.id;
					}, context);
					await api.details({ chat: child }, context);
					const handle = (await api.conversation(child, context))!;
					const author = `agent@${api.conversationId}`;
					const request = {
						type: "input",
						content: room.content(author, args.task),
						requestId: `subagent:${api.taskId}`,
					} as const;
					const submission = await (change ? handle.submit(request, context) : submitInput(handle, request, context));
					const settled = await submission.wait(context);
					if (settled.answer === undefined) {
						if (args.model && settled.reason === "no_model") {
							throw toolRefusal("subagent", args, [
								`model: Model ${JSON.stringify(args.model)} is not available in this channel, so omit model to use your own.`,
							]);
						}
						const childModel = (await api.snapshot(AgentDoc, child, context))?.model;
						const requested = args.model || (childModel ? `${childModel.provider}/${childModel.modelId}` : "automatic model selection");
						const detail = typeof settled.detail === "string" ? settled.detail : JSON.stringify(settled.detail);
						const reason = [settled.reason, detail].filter(Boolean).join(": ") || "no answer was recorded";
						throw new Error(`Subagent chat ${child} ended unanswered with ${requested} (${reason})`);
					}
					const text = await answer(api, settled.answer, context);
					return { content: [{ type: "text", text }], details: { chat: child } };
				},
			}),
		],
	});

export type Directory = {
	self: { id: string; name: string };
	list(context: Context): Promise<{
		id: string;
		name: string;
		/** The channel's original name, which its agent's messages are authored `agent@<prefix>` by. */
		prefix: string;
		project: string;
		summary?: string;
	}[]>;
	deliver(delivery: Delivery, context: Context): Promise<void>;
};

const channelsArguments = toolArguments("channels", z.strictObject({}));
const messageArguments = toolArguments("message", z.strictObject({
	channel: z.string().describe("Channel id or unique name. Use the id when names repeat."),
	chat: z.int().nonnegative().optional().describe("Chat id. Omit for the channel's first chat."),
	text: z.string(),
	invoke: z.boolean(),
}), {
	channel: "a channel id or unique name from channels",
	chat: "a nonnegative integer chat id in the destination channel, or omit chat for its first chat",
	invoke: "true to start the destination chat's agent or false to deliver the message without starting it",
}, { coerce: true });

/**
 * Other channels' current names, as `#name`, keyed by the author their agents' messages carry. That
 * author keeps the name a channel was created with, which nobody knows it by after a rename.
 */
export async function senders(
	directory: Directory,
	context: Context,
): Promise<Map<string, string>> {
	const channels = await directory.list(context);
	return new Map(channels.map((channel) => [`agent@${channel.prefix}`, `#${channel.name}`]));
}

/** Names the author of another channel's message as people see it, leaving the stored entry alone. */
function rename(message: Message, names: Map<string, string>): Message {
	if (message.role !== "user") return message;
	const { author } = room.input(message.content);
	const name = names.get(author);
	if (!name) return message;
	const swap = (text: string) => name + text.slice(author.length);
	const { content } = message;
	if (typeof content === "string") return { ...message, content: swap(content) };
	const first = content.findIndex((block) => block.type === "text");
	const block = content[first] as TextContent;
	return {
		...message,
		content: content.with(first, { ...block, text: swap(block.text) }),
	};
}

/** Agents in different channels coordinate only by messaging each other's chats. */
export function messaging(directory: Directory): Extension {
	return defineExtension({
		name: "ace-messaging",
		hooks: [
			hook(GenerationTask, {
				async beforeRequest(request, _api, context) {
					const { messages } = request;
					const agents = messages.some((message) =>
						message.role === "user" && room.isAgent(room.input(message.content).author)
					);
					if (!agents) return;
					const names = await senders(directory, context);
					return { messages: messages.map((message) => rename(message, names)) };
				},
			}),
		],
		tools: [
			defineTool({
				...channelsArguments,
				description:
					"List the channels on this host that you can message, with their rolling summaries.",
				replay: "safe",
				execute: async (_args, _api, context) => {
					const channels = await directory.list(context);
					const lines = channels.map((channel) =>
						`${channel.id}\t${channel.name}\t${channel.project}`
						+ (channel.summary ? `\t${channel.summary.replace(/\s+/g, " ")}` : "")
					);
					return { content: [{ type: "text", text: lines.join("\n") || "No other channels." }] };
				},
			}),
			defineTool({
				...messageArguments,
				description:
					"Post a message to another channel's chat. Set invoke to start that chat's agent on it, which also stops any shell command that agent is running so it reads your message next; otherwise people and the agent there only see it. Delivery does not wait for an answer: to get one, ask that agent to message this channel with invoke set when it is ready, say in your chat what you are waiting for, and end your run.",
				// The request ID makes redelivery after a crash a no-op at the destination.
				replay: "safe",
				execute: async (args, api, context) => {
					const channels = await directory.list(context);
					// Names can change after delivery; a recovered call must keep its original destination.
					const saved = await api.memo<string>("channel", context);
					// Messages from other channels name them `#name`.
					const ref = saved || args.channel.replace(/^#/, "");
					let target = channels.find((channel) => channel.id === ref);
					if (!target && !saved) {
						const matches = channels.filter((channel) => channel.name === ref);
						if (matches.length > 1) {
							throw toolRefusal("message", args, [
								`channel: More than one channel is named ${JSON.stringify(ref)}, so use one of their ids (${matches.map(channel => JSON.stringify(channel.id)).join(", ")}).`,
							]);
						}
						target = matches[0];
					}
					if (!target) throw toolRefusal("message", args, [
						`channel: No channel matches ${JSON.stringify(ref)}, so use an id or unique name returned by channels.`,
					]);
					await api.memo("channel", target.id, context);
					await directory.deliver({
						channel: target.id,
						...(args.chat === undefined ? {} : { chat: args.chat }),
						author: `agent@${directory.self.name}`,
						text: args.text,
						invoke: args.invoke,
						requestId: `message:${directory.self.id}:${api.taskId}`,
					}, context);
					return { content: [{ type: "text", text: `Delivered to ${target.name}` }] };
				},
			}),
		],
	});
}
