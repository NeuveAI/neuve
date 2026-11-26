import { type CreateModelsOptions, getSupportedThinkingLevels, type Models, type MutableModels } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

import type { ModelOption, ModelRef } from "./protocol";

// Pi's legacy ChatGPT route uses a sign-in Ace cannot manage.
const LEGACY_CHATGPT_PROVIDER = "openai-codex";

export function createCatalogue(options: CreateModelsOptions): MutableModels {
	const models = builtinModels(options);
	models.deleteProvider(LEGACY_CHATGPT_PROVIDER);
	return models;
}

/** One inaccessible provider must not hide another provider's usable models. */
export async function available(models: Models, routeModel?: Omit<ModelOption, "efforts">): Promise<ModelOption[]> {
	const results = await Promise.allSettled(
		models.getProviders().map((provider) => models.getAvailable(provider.id)),
	);
	const found = results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
	const failed = results.find((result) => result.status === "rejected");
	if (!found.length && failed?.status === "rejected") throw failed.reason;
	return found.map((model) => ({
		provider: model.provider,
		modelId: model.id,
		efforts: getSupportedThinkingLevels(model),
		...(routeModel?.account !== undefined && routeModel.provider === model.provider && routeModel.modelId === model.id
			? { account: routeModel.account }
			: {}),
	}));
}

export async function usable(models: Models, model: ModelRef): Promise<boolean> {
	const found = await models.getAvailable(model.provider).catch(() => []);
	return found.some((value) => value.id === model.modelId);
}

export function sameModel(left: ModelRef | undefined, right: ModelRef | undefined): boolean {
	return left?.provider === right?.provider && left?.modelId === right?.modelId;
}

/** Resolve an automatic choice only when admitting an agent invocation. */
export async function choose(models: Models): Promise<ModelRef> {
	const [selected] = await available(models);
	if (!selected) {
		throw new Error(
			"Add a provider key for this channel before invoking an agent. Chat is still available.",
		);
	}
	return { provider: selected.provider, modelId: selected.modelId };
}
