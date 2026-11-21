import type { Context } from "@earendil-works/chord";
import { getCurrentTools, type Models, type SystemMessage } from "@earendil-works/pi-ai";
import {
	defineDoc,
	defineExtension,
	GenerationTask,
	hook,
	LiveDoc,
	type ConversationId,
	type Cursor,
	type Harness,
	type Tx,
} from "@earendil-works/pi-durable";
import type { ChatMode } from "./protocol";

export const ChatModesDoc = defineDoc<{ chats: Record<string, ChatMode> }>({
	kind: "neuve.chat-modes",
	version: 1,
	scope: "session",
	initial: () => ({ chats: {} }),
});

export const planTools: ReadonlySet<string> = new Set([
	"read",
	"explore",
	"planning_search",
	"planning_issue",
	"planning_dependencies",
	"question",
	"runtime_work",
]);

export type IsPlanning = (chat: ConversationId, context: Context) => Promise<boolean>;

export function isPlanning(harness: Harness, chat: ConversationId, context: Context): Promise<boolean> {
	return harness.commit(async (tx) => {
		const { chats } = await tx.doc(ChatModesDoc);
		for (let id: ConversationId | undefined = chat; id !== undefined;) {
			if (chats[id] === "plan") return true;
			id = (await tx.conversation(id))?.owner?.conversationId;
		}
		return false;
	}, context);
}

/** A mode change also changes the permissions of descendants that inherit it. */
async function checkIdle(tx: Tx, chat: ConversationId, modes: Readonly<Record<string, ChatMode>>) {
	if ((await tx.doc(LiveDoc, chat)).run) {
		throw new Error("The chat or a chat it started is busy. Stop it or wait before changing its mode.");
	}
	let cursor: Cursor | undefined;
	do {
		const page = await tx.scanConversations({ ownerConversationId: chat }, 256, cursor);
		for (const child of page.items) {
			if (modes[child.id] !== "plan") await checkIdle(tx, child.id, modes);
		}
		cursor = page.next;
	} while (cursor);
}

export async function setChatMode(tx: Tx, chat: ConversationId, mode: ChatMode): Promise<boolean> {
	const { chats } = await tx.doc(ChatModesDoc);
	if ((chats[chat] ?? "ace") === mode) return false;
	await checkIdle(tx, chat, chats);
	chats[chat] = mode;
	return true;
}

/** The bridge reads this non-enumerable request marker. It never enters the transcript or prompt. */
const planningRequest = Symbol.for("neuve.chat.plan-request");

/** Pi can commit a streamed partial instead of calling afterResponse when a run is interrupted. */
export function planModeModels(models: Models): Models {
	const streamSimple: Models["streamSimple"] = (model, request, options) => {
		const stream = models.streamSimple(model, request, options);
		const mode: ChatMode = request.messages.some(message => Reflect.get(message, planningRequest) === true)
			? "plan" : "ace";
		return new Proxy(stream, {
			get(target, property) {
				if (property === Symbol.asyncIterator) return async function* () {
					for await (const event of target) {
						yield "partial" in event
							? { ...event, partial: { ...event.partial, neuveChatMode: mode } }
							: event;
					}
				};
				const value: unknown = Reflect.get(target, property);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
	};
	return new Proxy(models, {
		get(target, property) {
			if (property === "streamSimple") return streamSimple;
			const value: unknown = Reflect.get(target, property);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

export function planModeExtension(planning: IsPlanning) {
	return defineExtension({
		name: "neuve-chat-mode",
		hooks: [hook(GenerationTask, {
			async beforeRequest({ messages }, api, context) {
				if (!await planning(api.conversationId, context)) return;
				// Pi keeps all registrations for execution and safe replay. Only the model's offer changes.
				const offer: SystemMessage = {
					role: "system",
					content: "",
					timestamp: messages.at(-1)?.timestamp ?? 0,
					toolsRemoved: getCurrentTools(messages).filter(tool => !planTools.has(tool.name)).map(({ name }) => ({ name })),
				};
				Object.defineProperty(offer, planningRequest, { value: true });
				return { messages: [...messages, offer] };
			},
			async afterResponse(message, api, context) {
				// Pi persists this message in its assistant entry. Mode must travel with the reply
				// because the chat can switch modes before the reply is replayed to another client.
				const mode: ChatMode = await planning(api.conversationId, context) ? "plan" : "ace";
				Object.assign(message, { neuveChatMode: mode });
			},
		})],
	});
}
