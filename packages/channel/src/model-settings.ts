import type { Context } from "@earendil-works/chord";
import { createContextKey, withContextValue } from "@earendil-works/chord/context";
import { getSupportedThinkingLevels, type Models } from "@earendil-works/pi-ai";
import { AgentDoc, configure, defineDoc, type ConversationId, type Harness, LiveDoc, type Tx } from "@earendil-works/pi-durable";

import { available, choose, sameModel, usable } from "./models";
import { observeInputs } from "./pi-inputs";
import type { Effort, ModelOption, ModelRef, PendingModel } from "./protocol";
import { type Attached, checkContext } from "./room";

export const PendingModelDoc = defineDoc<{ pending?: PendingModel }>({
	kind: "neuve.pending-model", version: 1, scope: "conversation", history: "latest", fork: "initial",
	initial: () => ({}),
});

export const OwnerInputDoc = defineDoc<{ text?: string }>({
	kind: "neuve.model-owner-input", version: 1, scope: "conversation", history: "latest", fork: "initial",
	initial: () => ({}),
});

export type ModelSelection = Attached & PendingModel & { automatic?: boolean };
export type SelectedModel = { model: ModelRef; effort: Effort; pending?: PendingModel };
type Admission = { chat: ConversationId; selection?: ModelSelection; ownerText?: string };
const input = createContextKey<Admission>("channel.input");
const passive = createContextKey<ConversationId>("channel.passive-message");

export class ModelSettings {
	constructor(
		readonly models: Models,
		readonly defaultModel?: () => Promise<ModelRef>,
		readonly defaultEffort: Effort = "off",
		readonly routeModel?: Omit<ModelOption, "efforts">,
	) {}

	async automatic(): Promise<ModelRef> {
		const preferred = await this.defaultModel?.().catch(() => undefined);
		return preferred && await usable(this.models, preferred) ? preferred : choose(this.models);
	}

	listed() {
		return available(this.models, this.routeModel);
	}

	async check(harness: Harness, chat: ConversationId, selection: ModelSelection, context: Context) {
		const [state, doc] = await Promise.all([
			harness.snapshot(AgentDoc, chat, context),
			harness.snapshot(PendingModelDoc, chat, context),
		]);
		await this.#resolve(state?.model, state?.thinkingLevel ?? "off", doc?.pending ?? {}, selection);
	}

	inputContext(chat: ConversationId, selection: ModelSelection | undefined, ownerText: string | undefined, context: Context) {
		return withContextValue(input, { chat, ...(selection ? { selection } : {}), ...(ownerText === undefined ? {} : { ownerText }) }, context);
	}

	passiveContext(chat: ConversationId, context: Context) {
		return withContextValue(passive, chat, context);
	}

	attach(harness: Harness) {
		observeInputs(harness, {
			admit: async (tx, chat, context) => {
				const supplied = context.value(input);
				const admission = supplied?.chat === chat ? supplied : undefined;
				const owner = await tx.doc(OwnerInputDoc, chat);
				owner.text = admission?.ownerText;
				if (admission?.selection) await this.select(tx, chat, admission.selection, true);
			},
			clear: async (tx, chat) => { delete (await tx.doc(OwnerInputDoc, chat)).text; },
			passive: async (tx, chat, context) => {
				if (context.value(passive) === chat) delete (await tx.doc(OwnerInputDoc, chat)).text;
			},
			start: async (tx, chat, context) => {
				const state = await tx.doc(AgentDoc, chat);
				const doc = await tx.doc(PendingModelDoc, chat);
				const effort = state.thinkingLevel ?? "off";
				const selected = await this.#resolve(state.model, effort, doc.pending ?? {}, {})
					.catch(error => {
						if (context.value(input)?.chat === chat) throw error;
						// The last run still has to end if the queued run lost every available model.
						return undefined;
					});
				if (!sameModel(state.model, selected?.model) || effort !== (selected?.effort ?? "off")) {
					await configure(tx, chat, { model: selected?.model ?? null, thinkingLevel: selected?.effort ?? "off" });
				}
				delete doc.pending;
			},
		});
	}

	async select(tx: Tx, chat: ConversationId, selection: ModelSelection, admitting = false): Promise<SelectedModel> {
		const state = await tx.doc(AgentDoc, chat);
		const { pending } = await tx.doc(PendingModelDoc, chat);
		const effort = state.thinkingLevel ?? "off";
		const explicit = !!selection.model || selection.effort !== undefined || selection.automatic === true;
		const busy = !!(await tx.doc(LiveDoc, chat)).run;
		const staged = pending ?? {};
		const desired = await this.#resolve(state.model, effort, staged, selection);
		if (!explicit && (admitting || pending || busy)) {
			return state.model ? { model: { ...state.model }, effort, ...(pending ? { pending: { ...pending } } : {}) } : desired;
		}
		const doc = await tx.doc(PendingModelDoc, chat);
		if (busy && state.model) {
			const change = {
				...(!sameModel(state.model, desired.model) ? { model: desired.model } : {}),
				...(effort !== desired.effort ? { effort: desired.effort } : {}),
			};
			doc.pending = change.model !== undefined || change.effort !== undefined ? change : undefined;
			return { model: { ...state.model }, effort, ...(doc.pending ? { pending: change } : {}) };
		}
		await configure(tx, chat, { model: desired.model, thinkingLevel: desired.effort });
		delete doc.pending;
		return desired;
	}

	async #resolve(current: ModelRef | undefined, effort: Effort, pending: PendingModel, selection: ModelSelection): Promise<SelectedModel> {
		const stored = selection.automatic ? undefined : pending.model ?? current;
		const model = selection.model
			?? (stored && await usable(this.models, stored) ? stored : await this.automatic());
		const selected = this.models.getModel(model.provider, model.modelId);
		if (!selected) throw new Error(`Model ${model.provider}/${model.modelId} is not offered. Choose another model.`);
		if (selection.model && !await usable(this.models, model)) {
			const name = this.models.getProvider(model.provider)?.name ?? model.provider;
			throw new Error(`The ${name} API key is missing. Add it in Provider settings to invoke an agent. Chat is still available.`);
		}
		checkContext(selected, selection);
		const levels = getSupportedThinkingLevels(selected);
		const supports = (level: Effort) => level === "off" || levels.includes(level);
		if (selection.effort !== undefined && !supports(selection.effort)) {
			const listed = levels.filter(level => level !== "off");
			throw new Error(
				`Unsupported reasoning effort ${selection.effort} for ${model.provider}/${model.modelId}: ${listed.length ? `it lists ${listed.join(", ")}` : "it lists no effort levels"}, and off.`,
			);
		}
		const wanted = pending.effort ?? effort;
		return { model: { provider: model.provider, modelId: model.modelId },
			effort: selection.effort ?? (supports(wanted) ? wanted : supports(this.defaultEffort) ? this.defaultEffort : "off") };
	}
}
