import type { ModelRef } from "@ace/channel/protocol";
import type { AccountStatus } from "@neuve/runtime/status";

export const key = (model: ModelRef) => `${model.provider}/${model.modelId}`;

/**
 * Each model once per sign-in. Accounts of one kind that reach one sign-in through different
 * runtimes fold into the first that lists the model, since which serves it is the host's choice;
 * a provider that is no account, such as an API key, is never folded. A model listed more than
 * once is named with its provider. A stored pick on a folded account shows on its row.
 */
export function listed<T extends ModelRef>(
	models: readonly T[],
	picked: string,
	accounts: readonly AccountStatus[] = [],
) {
	const account = ({ provider }: ModelRef) => accounts.find(({ name }) => name === provider);
	const email = (model: ModelRef) => {
		const signIn = account(model)?.signIn;
		return signIn?.state === "signed-in" ? signIn.email : undefined;
	};
	const groups: T[][] = [];
	for (const model of models) {
		const kind = account(model)?.kind;
		const group = kind && groups.find((members) =>
			members.every((member) =>
				member.modelId === model.modelId
				&& account(member)?.kind === kind
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
	const id = picked.slice(picked.indexOf("/") + 1);
	const group = groups.find((members) => members.some((member) => key(member) === picked));
	const row = group ? group[0] : kept.find((model) => model.modelId === id);
	return { rows, picked: row ? key(row) : picked };
}
