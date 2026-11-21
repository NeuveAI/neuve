import type { Context } from "@earendil-works/chord";
import { getCurrentTools, type Models, type SystemMessage } from "@earendil-works/pi-ai";
import {
	defineDoc,
	defineExtension,
	GenerationTask,
	hook,
	InboxDoc,
	LiveDoc,
	UserEntry,
	type ConversationId,
	type Cursor,
	type EntryDraft,
	type Harness,
	type InputSubmissionDraft,
	type SubmissionId,
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

/** Place the input that changes an idle chat's mode in the same commit as that mode. */
export async function submitModeChange(tx: Tx, chat: ConversationId, mode: ChatMode, input: InputSubmissionDraft) {
	const { chats } = await tx.doc(ChatModesDoc);
	if ((chats[chat] ?? "ace") === mode) return;
	await checkIdle(tx, chat, chats);
	const live = await tx.doc(LiveDoc, chat);
	const inbox = await tx.doc(InboxDoc, chat);
	let head = inbox.items.some(item => item.mode === "write") ? (await tx.latestHeadMarker(chat))?.head : undefined;
	const { id } = await tx.createSubmission({
		conversationId: chat, type: "input", status: "queued",
		...(input.requestId === undefined ? {} : { requestId: input.requestId }),
	});
	inbox.items.push({ id, mode: "steer", content: input.content });

	// Match pi's idle boundary: place passive writes first and take one input of each queue mode.
	const placed = new Set<SubmissionId>();
	for (const item of inbox.items) {
		if (item.mode !== "write") continue;
		// Pi stores previously admitted EntryDraft values as JSON in the inbox.
		const draft = item.entry as unknown as EntryDraft;
		if (typeof draft.head === "number" && head !== undefined && draft.head < head) {
			tx.settleSubmission(item.id, { status: "unanswered", reason: "stale" });
		} else {
			const entry = await tx.appendEntry(chat, draft);
			if (draft.head !== undefined) head = draft.head === "self" ? entry.id : draft.head;
			tx.placeSubmission(item.id, entry.id);
		}
		placed.add(item.id);
	}
	const inputs: SubmissionId[] = [];
	const modes = new Set<"steer" | "followUp">();
	const timestamp = Date.now();
	for (const item of inbox.items) {
		if (item.mode === "write" || modes.has(item.mode)) continue;
		modes.add(item.mode);
		const entry = await tx.appendEntry(UserEntry, chat, {
			model: [{ role: "user", content: item.content, timestamp }],
		});
		tx.placeSubmission(item.id, entry.id);
		inputs.push(item.id);
		placed.add(item.id);
	}
	for (let index = inbox.items.length - 1; index >= 0; index--) {
		if (placed.has(inbox.items[index]!.id)) inbox.items.splice(index, 1);
	}
	const taskId = await tx.createTask(GenerationTask, {}, { conversationId: chat, ownership: { kind: "conversation" } });
	chats[chat] = mode;
	live.run = { taskId, inputs };
	return id;
}

// The bridge consumes this transient marker before its request becomes a runtime turn.
const planningRequest = Symbol.for("neuve.chat.plan-request");
const planningSignals = new WeakSet<NonNullable<Context["abortSignal"]>>();

/** Pi can commit a streamed partial instead of calling afterResponse when a run is interrupted. */
export function planModeModels(models: Models): Models {
	const streamSimple: Models["streamSimple"] = (model, request, options) => {
		const mode: ChatMode = options?.signal && planningSignals.has(options.signal) ? "plan" : "ace";
		if (mode === "plan") {
			const { messages } = request;
			// Add the marker after all request hooks, which may copy the transcript.
			const offer: SystemMessage = {
				role: "system",
				content: "",
				timestamp: messages.at(-1)?.timestamp ?? 0,
				toolsRemoved: getCurrentTools(messages).filter(tool => !planTools.has(tool.name)).map(({ name }) => ({ name })),
			};
			Object.defineProperty(offer, planningRequest, { value: true });
			request = { ...request, messages: [...messages, offer] };
		}
		const stream = models.streamSimple(model, request, options);
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
			async beforeRequest(_request, api, context) {
				if (!await planning(api.conversationId, context)) return;
				if (!context.abortSignal) throw new Error("A planning request requires pi's task signal.");
				planningSignals.add(context.abortSignal);
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
