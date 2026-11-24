import type {ModelOption} from "@ace/channel/protocol";
import {runtimeHooks} from "./runtime-hooks";
import {failure, log} from "./log";

type ListedModel = Omit<ModelOption, "efforts">;

/** Native credentials remain authoritative for native models; managed routes add exact identities. */
export async function extendModels(native: Promise<readonly ListedModel[]>): Promise<ListedModel[]> {
	const additional: readonly ListedModel[] = runtimeHooks().modelAvailability?.() || [];
	let available: readonly ListedModel[];
	try {available = await native;}
	catch (error) {
		if (!additional.length) throw error;
		log("warn", "models.native.unavailable", failure(error));
		available = [];
	}
	const models = new Map<string, ListedModel>();
	for (const model of [...available, ...additional]) {
		const key = `${model.provider}\0${model.modelId}`;
		if (model.account !== undefined || models.get(key)?.account === undefined) models.set(key, model);
	}
	return [...models.values()];
}
