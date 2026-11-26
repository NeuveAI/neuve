import type { Context, Draft } from "@earendil-works/chord";
import {
	type ConversationId, type EntryId, type EntryRecord, type Harness, LiveDoc, type LiveState, type SubmissionId,
	type Tx,
} from "@earendil-works/pi-durable";

type Commit = <T>(change: (tx: Tx) => T | Promise<T>, context: Context, ...scope: unknown[]) => Promise<T>;

/**
 * Pi 1.0 has no input or run-start transaction hook. Both submit() and Pi's queued-input
 * boundary use commitWith. Keep this adapter at that boundary until Pi exposes a public hook.
 */
export function observeInputs(harness: Harness, hooks: {
	admit(tx: Tx, chat: ConversationId, context: Context): Promise<void>;
	clear(tx: Tx, chat: ConversationId): Promise<void>;
	passive(tx: Tx, chat: ConversationId, context: Context): Promise<void>;
	start(tx: Tx, chat: ConversationId, context: Context): Promise<void>;
}): void {
	const commitWith: unknown = Reflect.get(harness, "commitWith");
	if (typeof commitWith !== "function") throw new Error("Pi's input transaction boundary is unavailable.");
	const commit: Commit = commitWith.bind(harness);
	const wrapped: Commit = (change, context, ...scope) => commit(async tx => {
		const live = new Map<ConversationId, { state: Draft<LiveState>; first: SubmissionId | undefined }>();
		const unbound = new Map<EntryId, ConversationId>();
		const overrides: Partial<Tx> = {
			doc: (async (token: typeof LiveDoc, chat: ConversationId) => {
				const state = await tx.doc(token, chat);
				if (token === LiveDoc && !live.has(chat)) live.set(chat, { state, first: state.run?.inputs[0] });
				return state;
			}) as Tx["doc"],
			appendEntry: (async (...args: unknown[]) => {
				const entry: EntryRecord = await Reflect.apply(tx.appendEntry, tx, args);
				if (entry.model?.[0]?.role === "user") unbound.set(entry.id, entry.conversationId);
				return entry;
			}) as Tx["appendEntry"],
			async createSubmission(draft) {
				if ("entry" in draft && draft.entry !== undefined) unbound.delete(draft.entry);
				if (draft.type === "input") await hooks.admit(tx, draft.conversationId, context);
				else await hooks.passive(tx, draft.conversationId, context);
				return tx.createSubmission(draft);
			},
			placeSubmission(id, entry) {
				unbound.delete(entry);
				tx.placeSubmission(id, entry);
			},
		};
		const value = await change(new Proxy(tx, {
			get(target, key) {
				if (key === "doc") return (...args: unknown[]) =>
					args[0] === LiveDoc ? Reflect.apply(overrides.doc!, overrides, args) : Reflect.apply(target.doc, target, args);
				if (Object.hasOwn(overrides, key)) return Reflect.get(overrides, key);
				const method = Reflect.get(target, key);
				return typeof method === "function" ? method.bind(target) : method;
			},
		}));
		// A continuation or handoff can append user context without creating a submission.
		for (const chat of new Set(unbound.values())) await hooks.clear(tx, chat);
		for (const [chat, { state, first }] of live) {
			const next = state.run?.inputs[0];
			if (next !== undefined && next !== first) await hooks.start(tx, chat, context);
		}
		return value;
	}, context, ...scope);
	Reflect.set(harness, "commitWith", wrapped);
}
