import type { Context } from "@earendil-works/chord";
import { getCurrentTools, type Models, type SystemMessage } from "@earendil-works/pi-ai";
import type { SessionPolicy } from "@neuve/runtime";
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
import { AGENT_MESSAGE_TOOL, AGENT_MODEL_TOOL, PLAN_COMMENT_TOOL, PLAN_TOOL, type ChatMode } from "./protocol";
import { ATTENDED_SECTION } from "./approvals";

export type PlanExit = { plan: string; hash: string };
export type ModeTransition = { chat: ConversationId; previous: ChatMode; mode: ChatMode; approval: PlanExit };

export const ChatModesDoc = defineDoc<{
	chats: Record<string, ChatMode>;
	pendingEntries?: Record<string, true>;
	pendingExits?: Record<string, PlanExit>;
}>({
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
	PLAN_COMMENT_TOOL,
	AGENT_MESSAGE_TOOL,
	AGENT_MODEL_TOOL,
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
		return false;
	}
	let cursor: Cursor | undefined;
	do {
		const page = await tx.scanConversations({ ownerConversationId: chat }, 256, cursor);
		for (const child of page.items) {
			if (modes[child.id] !== "plan" && !await checkIdle(tx, child.id, modes)) return false;
		}
		cursor = page.next;
	} while (cursor);
	return true;
}

export async function setChatMode(tx: Tx, chat: ConversationId, mode: ChatMode) {
	const doc = await tx.doc(ChatModesDoc);
	const previous = doc.chats[chat];
	const pendingExit = doc.pendingExits?.[chat];
	if ((previous ?? "ace") !== mode) {
		if (!await checkIdle(tx, chat, doc.chats)) {
			throw new Error("The chat or a chat it started is busy. Stop it or wait before changing its mode.");
		}
		doc.chats[chat] = mode;
	} else if (!pendingExit) return;
	// Even selecting Plan again deliberately supersedes an older approved session's exit.
	if (doc.pendingExits) delete doc.pendingExits[chat];
	return { previous, pendingExit: pendingExit ? { ...pendingExit } : undefined };
}

/** Called only in the transaction that records a new, validated approval. */
export async function requestPlanExit(tx: Tx, chat: ConversationId, approval: PlanExit) {
	const doc = await tx.doc(ChatModesDoc);
	if (doc.chats[chat] !== "plan") return;
	doc.pendingExits ??= {};
	doc.pendingExits[chat] = approval;
	return reconcilePlanExit(tx, chat);
}

/** The same idle boundary as a deliberate mode change; intent never changes a running turn. */
export async function reconcilePlanExit(tx: Tx, chat: ConversationId): Promise<ModeTransition | undefined> {
	const doc = await tx.doc(ChatModesDoc);
	const approval = doc.pendingExits?.[chat];
	if (!approval) return;
	if (doc.chats[chat] !== "plan") {
		delete doc.pendingExits![chat];
		return;
	}
	if (!await checkIdle(tx, chat, doc.chats)) return;
	await setChatMode(tx, chat, "ace");
	return { chat, previous: "plan", mode: "ace", approval: { ...approval } };
}

export async function reconcilePlanEntry(tx: Tx, chat: ConversationId) {
	const doc = await tx.doc(ChatModesDoc);
	const entries = doc.pendingEntries;
	if (!entries?.[chat] || !await checkIdle(tx, chat, doc.chats)) return;
	delete entries[chat];
	if (doc.chats[chat] === "plan") return;
	await setChatMode(tx, chat, "plan");
	return { chat, previous: "ace", mode: "plan" } as const;
}

// The bridge strips marked tool offers from the transcript. A true value denotes Plan mode.
const planningRequest = Symbol.for("neuve.chat.plan-request");
const sandboxPluginTools = Symbol.for("neuve.chat.sandbox-plugin-tools");
const nativePluginServers = Symbol.for("neuve.chat.native-plugin-servers");
const deferredPluginTools = Symbol.for("neuve.chat.deferred-plugin-tools");
const requestMode = "neuve.chat.request-mode";

export type PluginOffers = {
	httpTools(): ReadonlySet<string>;
	deferredTools?(): ReadonlySet<string>;
	nativeServers?(folder?: string): SessionPolicy["mcpServers"];
	nativeTool?(name: string): boolean;
};

/** Pi can commit a streamed partial instead of calling afterResponse when a run is interrupted. */
export function planModeModels(
	models: Models, receivesAttendance: (provider: string) => boolean,
	plugins?: PluginOffers,
): Models {
	const streamSimple: Models["streamSimple"] = (model, request, options) => {
		const decision = request.messages.findLast(message =>
			message.role === "system" && message.sections?.[requestMode] !== undefined);
		const mode = decision?.role === "system" && decision.sections?.[requestMode];
		if (mode !== "ace" && mode !== "plan") throw new Error("Pi's model request is missing the chat mode.");
		const keepAttendance = receivesAttendance(model.provider);
		const attendance = request.messages.findLast(message =>
			message.role === "system" && Object.hasOwn(message.sections ?? {}, ATTENDED_SECTION));
		const attended = attendance?.role === "system" && attendance.sections?.[ATTENDED_SECTION] === "true";
		const messages = request.messages.filter(message => message !== decision && (
			keepAttendance || message.role !== "system" || !Object.hasOwn(message.sections ?? {}, ATTENDED_SECTION)
		)).map(message =>
			mode === "ace" && message.role === "system" && message.toolsAdded
				? { ...message, toolsAdded: message.toolsAdded.filter(tool => tool.name !== PLAN_COMMENT_TOOL && tool.name !== PLAN_TOOL) }
				: message);
		if (mode === "plan" || ((attended || keepAttendance) && plugins?.nativeTool)) {
			// Add the marker after all request hooks, which may copy the transcript.
			const tools = getCurrentTools(messages);
			const offer: SystemMessage = {
				role: "system",
				content: mode === "plan" && tools.some(tool => tool.name === PLAN_TOOL)
					? `When ready, deliver the full plan or revision in one \`${PLAN_TOOL}\` call on its own. That ends the turn.`
					: "",
				timestamp: messages.at(-1)?.timestamp ?? 0,
				toolsRemoved: tools.filter(tool => mode === "plan" ? !planTools.has(tool.name) : plugins?.nativeTool?.(tool.name))
					.map(({ name }) => ({ name })),
			};
			Object.defineProperty(offer, planningRequest, { value: mode === "plan" });
			if (mode === "plan" || offer.toolsRemoved?.length) messages.push(offer);
		}
		const streamOptions = mode === "ace" && plugins && model.api === "neuve-runtime"
			? {
				...options,
				[sandboxPluginTools]: plugins.httpTools(),
				[deferredPluginTools]: plugins.deferredTools?.(),
				[nativePluginServers]: keepAttendance ? plugins.nativeServers : undefined,
			}
			: options;
		const stream = models.streamSimple(model, { ...request, messages }, streamOptions);
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
