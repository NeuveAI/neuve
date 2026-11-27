import type { Context } from "@earendil-works/chord";
import { getSupportedThinkingLevels, type Models } from "@earendil-works/pi-ai";
import { AgentDoc, configure, defineDoc, type ConversationId, type Harness, LiveDoc, type Tx } from "@earendil-works/pi-durable";
import type { AccountStatus } from "@neuve/runtime/status";

import { selectableEfforts } from "./effort";
import { available, choose, sameModel, usable } from "./models";
import type { Effort, ModelOption, ModelRef, PendingModel } from "./protocol";
import { type Attached, checkContext } from "./room";

export const PendingModelDoc = defineDoc<{ pending?: PendingModel }>({
	kind: "neuve.pending-model", version: 1, scope: "conversation", history: "latest", fork: "initial",
	initial: () => ({}),
});

export const OwnerInputDoc = defineDoc<{ input?: { requestId: string; text: string } }>({
	kind: "neuve.model-owner-input", version: 1, scope: "conversation", history: "latest", fork: "initial",
	initial: () => ({}),
});

export type ModelSelection = Attached & PendingModel & { automatic?: boolean };
export type SelectedModel = { model: ModelRef; effort: Effort; pending?: PendingModel };

export async function ownerInput(tx: Tx, chat: ConversationId): Promise<string | undefined> {
	const { input } = await tx.doc(OwnerInputDoc, chat);
	if (!input) return;
	// The settings commit precedes submit. Only a submission Pi accepted can authorize a tool.
	const submission = await tx.submissionByRequest(chat, input.requestId);
	if (submission?.type !== "input") return;
	const { run } = await tx.doc(LiveDoc, chat);
	if (run && (submission.status === "queued" || run.inputs.includes(submission.id))) return input.text;
}

export class ModelSettings {
	constructor(
		readonly models: Models,
		readonly defaultModel?: () => Promise<ModelRef>,
		readonly defaultEffort: Effort = "off",
		readonly routeModel?: Omit<ModelOption, "efforts">,
		readonly accountStatuses: () => readonly AccountStatus[] = () => [],
	) {}

	async automatic(): Promise<ModelRef> {
		const preferred = await this.defaultModel?.();
		return preferred && await usable(this.models, preferred).catch(() => false) ? preferred : choose(this.models);
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

	async select(tx: Tx, chat: ConversationId, selection: ModelSelection, admitting = false): Promise<SelectedModel> {
		const state = await tx.doc(AgentDoc, chat);
		const doc = await tx.doc(PendingModelDoc, chat);
		const { pending } = doc;
		const effort = state.thinkingLevel ?? "off";
		const explicit = !!selection.model || selection.effort !== undefined || selection.automatic === true;
		const busy = !!(await tx.doc(LiveDoc, chat)).run;
		const desired = await this.#resolve(state.model, effort, pending ?? {}, selection);
		if (!busy && !admitting && pending?.model && state.model
			&& !selection.model && !selection.automatic && selection.effort !== undefined) {
			await configure(tx, chat, { thinkingLevel: desired.effort });
			const change = { model: { ...pending.model } };
			doc.pending = change;
			return { model: { ...state.model }, effort: desired.effort, pending: change };
		}
		if (!busy && (admitting || explicit || !pending)) {
			if (!sameModel(state.model, desired.model) || effort !== desired.effort) {
				await configure(tx, chat, { model: desired.model, thinkingLevel: desired.effort });
			}
			delete doc.pending;
			return desired;
		}
		const model = explicit ? (!sameModel(state.model, desired.model) ? desired.model : undefined) : pending?.model;
		const level = explicit ? (effort !== desired.effort ? desired.effort : undefined) : pending?.effort;
		const change = model !== undefined || level !== undefined ? {
			...(model === undefined ? {} : { model: { ...model } }),
			...(level === undefined ? {} : { effort: level }),
		} : undefined;
		if (explicit) doc.pending = change;
		return state.model
			? { model: { ...state.model }, effort, ...(change ? { pending: change } : {}) }
			: desired;
	}

	async #resolve(current: ModelRef | undefined, effort: Effort, pending: PendingModel, selection: ModelSelection): Promise<SelectedModel> {
		const stored = selection.automatic ? undefined : pending.model ?? current;
		const model = selection.model
			?? (stored && await usable(this.models, stored).catch(() => false) ? stored : await this.automatic());
		const offered = !selection.model || await usable(this.models, model);
		const selected = this.models.getModel(model.provider, model.modelId);
		if (!selected) throw new Error(`Model ${model.provider}/${model.modelId} is not offered. Choose another model.`);
		if (!offered) {
			const name = this.models.getProvider(model.provider)?.name ?? model.provider;
			throw new Error(`The ${name} API key is missing. Add it in Provider settings to invoke an agent. Chat is still available.`);
		}
		checkContext(selected, selection);
		const levels = selectableEfforts(getSupportedThinkingLevels(selected));
		const supports = (level: Effort) => levels.includes(level);
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
