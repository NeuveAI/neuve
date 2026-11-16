import type {ModelRef} from "@ace/channel/protocol";
import {runtimeHooks} from "./runtime-hooks";
import {failure, log} from "./log";

/** Native credentials remain authoritative for native models; managed routes add exact identities. */
export async function extendModels(native: Promise<readonly ModelRef[]>): Promise<ModelRef[]> {
	const additional = runtimeHooks().modelAvailability?.() || [];
	let available: readonly ModelRef[];
	try {available = await native;}
	catch (error) {
		if (!additional.length) throw error;
		log("warn", "models.native.unavailable", failure(error));
		available = [];
	}
	return [...new Map([...available, ...additional].map((model) => [`${model.provider}\0${model.modelId}`, model])).values()];
}
