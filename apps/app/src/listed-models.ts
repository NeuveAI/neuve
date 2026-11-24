import type { ModelRef } from "@ace/channel/protocol";
import type { AccountStatus } from "@neuve/runtime/status";

export const key = (model: ModelRef) => `${model.provider}/${model.modelId}`;

/**
 * Each model once per sign-in. Accounts that reach one sign-in through different runtimes fold
 * into the first that lists the model, since which serves it is the host's choice; a model offered
 * on two sign-ins is named with its account. A stored pick on a folded account shows on its row.
 */
export function listed<T extends ModelRef>(
	models: readonly T[],
	picked: string,
	accounts: readonly AccountStatus[] = [],
) {
	const email = ({ provider }: ModelRef) => {
		const signIn = accounts.find((account) => account.name === provider)?.signIn;
		return signIn?.state === "signed-in" ? signIn.email : undefined;
	};
	const kept: T[] = [];
	const folded = new Map<string, string>();
	for (const model of models) {
		const row = kept.find((value) =>
			value.modelId === model.modelId && (!email(value) || !email(model) || email(value) === email(model)));
		if (row) folded.set(key(model), key(row));
		else kept.push(model);
	}
	const rows = kept.map((model) => ({
		...model,
		name: kept.filter((value) => value.modelId === model.modelId).length > 1
			? `${model.modelId} · ${model.provider}`
			: model.modelId,
	}));
	const id = picked.slice(picked.indexOf("/") + 1);
	const row = rows.find((model) => key(model) === picked)
		?? rows.find((model) => key(model) === folded.get(picked))
		?? rows.find((model) => model.modelId === id);
	return { rows, picked: row ? key(row) : picked };
}
