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
import { PLAN_TOOL, type ChatMode } from "./protocol";
import { ATTENDED_SECTION } from "./approvals";

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
	PLAN_TOOL,
	"runtime_work",
]);

export type IsPlanning = (chat: ConversationId, context: Context) => Promise<boolean>;

export async function isPlanning(
	harness: Harness, chat: ConversationId, context: Context,
	admission: (chat: ConversationId) => Promise<unknown> | undefined,
): Promise<boolean> {
	const result = await harness.commit(async (tx) => {
		const { chats } = await tx.doc(ChatModesDoc);
		for (let id: ConversationId | undefined = chat; id !== undefined;) {
			const pending = admission(id);
			if (pending) return { pending };
			if (chats[id] === "plan") return true;
			id = (await tx.conversation(id))?.owner?.conversationId;
		}
		return false;
	}, context);
	if (typeof result === "boolean") return result;
	await result.pending.catch(() => {});
	return isPlanning(harness, chat, context, admission);
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

export async function setChatMode(tx: Tx, chat: ConversationId, mode: ChatMode) {
	const { chats } = await tx.doc(ChatModesDoc);
	const previous = chats[chat];
	if ((previous ?? "ace") === mode) return;
	await checkIdle(tx, chat, chats);
	chats[chat] = mode;
	return { previous };
}

// The bridge consumes this transient marker before its request becomes a runtime turn.
const planningRequest = Symbol.for("neuve.chat.plan-request");
const requestMode = "neuve.chat.request-mode";

/** Pi can commit a streamed partial instead of calling afterResponse when a run is interrupted. */
export function planModeModels(models: Models, receivesAttendance: (provider: string) => boolean): Models {
	const streamSimple: Models["streamSimple"] = (model, request, options) => {
		const decision = request.messages.findLast(message =>
			message.role === "system" && message.sections?.[requestMode] !== undefined);
		const mode = decision?.role === "system" && decision.sections?.[requestMode];
		if (mode !== "ace" && mode !== "plan") throw new Error("Pi's model request is missing the chat mode.");
		const keepAttendance = receivesAttendance(model.provider);
		const messages = request.messages.filter(message => message !== decision && (
			keepAttendance || message.role !== "system" || !Object.hasOwn(message.sections ?? {}, ATTENDED_SECTION)
		));
		if (mode === "plan") {
			// Add the marker after all request hooks, which may copy the transcript.
			const tools = getCurrentTools(messages);
			const offer: SystemMessage = {
				role: "system",
				content: tools.some(tool => tool.name === PLAN_TOOL)
					? `When ready, deliver the full plan or revision in one \`${PLAN_TOOL}\` call on its own. That ends the turn.`
					: "",
				timestamp: messages.at(-1)?.timestamp ?? 0,
				toolsRemoved: tools.filter(tool => !planTools.has(tool.name)).map(({ name }) => ({ name })),
			};
			Object.defineProperty(offer, planningRequest, { value: true });
			messages.push(offer);
		}
		const stream = models.streamSimple(model, { ...request, messages }, options);
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
				const mode = await planning(api.conversationId, context) ? "plan" : "ace";
				const decision: SystemMessage = {
					role: "system", content: "", timestamp: messages.at(-1)?.timestamp ?? 0,
					sections: { [requestMode]: mode },
				};
				return { messages: [...messages, decision] };
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
