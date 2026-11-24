import type { ModelRef } from "@ace/channel/protocol";
import type { AccountStatus } from "@neuve/runtime/status";

export const key = (model: ModelRef) => `${model.provider}/${model.modelId}`;

type Listed = ModelRef & { account?: string };

/**
 * Each model once per sign-in. A row's account is the one it names, else its provider's.
 * Subscriptions of one kind that reach one sign-in through different runtimes or routes fold into
 * the first that lists the model, since which serves it is the host's choice; anything else, such
 * as an API key, stays its own row. A model listed more than once is named with its provider. A
 * stored pick shows on its row, or on its model's row from a subscription of the same kind when its
 * own account no longer lists it, as the channel then runs it.
 */
export function listed<T extends Listed>(
	models: readonly T[],
	picked: string,
	accounts: readonly AccountStatus[] = [],
) {
	const account = (model: Listed) => accounts.find(({ name }) => name === (model.account ?? model.provider));
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
			? `${model.modelId} · ${model.provider}`
			: model.modelId,
	}));
	const split = picked.indexOf("/");
	const stored = { provider: picked.slice(0, split), modelId: picked.slice(split + 1) };
	const group = groups.find((members) => members.some((member) => key(member) === picked));
	const row = group
		? group[0]
		: plan(stored) && kept.find((model) => model.modelId === stored.modelId && plan(model) === plan(stored));
	return { rows, picked: row ? key(row) : picked };
}
