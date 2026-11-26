import type { ModelRef } from "@ace/channel/protocol";
import { accountForProvider } from "@neuve/runtime/account";
import type { AccountStatus } from "@neuve/runtime/status";

export const key = (model: ModelRef) => `${model.provider}/${model.modelId}`;

type Listed = ModelRef & { account?: string };

/**
 * Each model once per sign-in. A row's account is the one it names, else its provider's.
 * Subscriptions of one kind that reach one sign-in through different runtimes or routes fold into
 * the first that lists the model, since which serves it is the host's choice; anything else, such
 * as an API key, stays its own row. A model listed more than once is named with its provider, or
 * with its account's own name for an account listed as `account:<name>` because a built-in
 * provider has that id. A stored pick on a folded account shows on its row.
 */
export function listed<T extends Listed>(
	models: readonly T[],
	picked: string,
	accounts: readonly AccountStatus[] = [],
) {
	// A built-in provider's row is not the account that shares its id, which has a row of its own.
	const managed = new Set(models.flatMap(({ provider }) => accountForProvider(provider) ?? []));
	const named = (model: Listed) =>
		model.account ?? accountForProvider(model.provider) ?? (managed.has(model.provider) ? undefined : model.provider);
	const account = (model: Listed) => accounts.find(({ name }) => name === named(model));
	const plan = (model: Listed) => {
		const kind = account(model)?.kind;
		return kind === "chatgpt-subscription" || kind === "claude-subscription" ? kind : undefined;
	};
	const email = (model: Listed) => {
		const signIn = account(model)?.signIn;
		return signIn?.state === "signed-in" ? signIn.email : undefined;
	};
	const groups: T[][] = [];
	for (const model of models) {
		const kind = plan(model);
		const group = kind && groups.find((members) =>
			members.every((member) =>
				member.modelId === model.modelId
				&& plan(member) === kind
				&& (!email(member) || !email(model) || email(member) === email(model))));
		if (group) group.push(model);
		else groups.push([model]);
	}
	const kept = groups.map(([first]) => first!);
	const rows = kept.map((model) => ({
		...model,
		name: kept.filter((value) => value.modelId === model.modelId).length > 1
			? `${model.modelId} · ${accountForProvider(model.provider) === undefined ? model.provider : named(model)}`
			: model.modelId,
	}));
	const row = groups.find((members) => members.some((member) => key(member) === picked))?.[0];
	return { rows, picked: row ? key(row) : picked };
}
