import { accountForProvider, type AccountKind } from "./account.ts";
import type { AccountStatus } from "./status.ts";

type Listed = { provider: string; modelId: string; account?: string };

// Use the provider names shown in Accounts when a key and an account share a name.
const accountProviders = {
  "claude-subscription": "Claude",
  "chatgpt-subscription": "ChatGPT",
  "anthropic-api-key": "Anthropic",
  "openai-api-key": "OpenAI",
} satisfies Record<AccountKind, string>;
const builtInProviders: Readonly<Record<string, string>> = {
  anthropic: accountProviders["anthropic-api-key"],
  openai: accountProviders["openai-api-key"],
};

export const key = (model: Listed) => `${model.provider}/${model.modelId}`;

/** Subscriptions of one kind fold per model, unless their known emails differ. The first route serves the group. */
export function modelGroups<T extends Listed>(
  models: readonly T[],
  accounts: readonly AccountStatus[],
): [T, ...T[]][] {
  // The prefixed route owns the account metadata when its name also names a built-in provider.
  const managed = new Set(
    models.flatMap(({ provider }) => accountForProvider(provider) ?? []),
  );
  const named = (model: T) =>
    model.account ??
    accountForProvider(model.provider) ??
    (managed.has(model.provider) ? undefined : model.provider);
  const account = (model: T) =>
    accounts.find(({ name }) => name === named(model));
  const plan = (model: T) => {
    const kind = account(model)?.kind;
    return kind === "chatgpt-subscription" || kind === "claude-subscription"
      ? kind
      : undefined;
  };
  const email = (model: T) => {
    const signIn = account(model)?.signIn;
    return signIn?.state === "signed-in" ? signIn.email : undefined;
  };
  const groups: [T, ...T[]][] = [];
  for (const model of models) {
    const kind = plan(model);
    const group =
      kind &&
      groups.find((members) =>
        members.every(
          (member) =>
            member.modelId === model.modelId &&
            plan(member) === kind &&
            (!email(member) || !email(model) || email(member) === email(model)),
        ),
      );
    if (group) group.push(model);
    else groups.push([model]);
  }
  return groups;
}

/** Show each model once per sign-in and keep a stored pick on its visible row. */
export function listed<T extends Listed>(
  models: readonly T[],
  picked: string,
  accounts: readonly AccountStatus[] = [],
) {
  const groups = modelGroups(models, accounts);
  const kept = groups.map(([first]) => first);
  const rows = kept.map((model) => {
    const siblings = kept.filter(
      (value) => value !== model && value.modelId === model.modelId,
    );
    const managed = accountForProvider(model.provider);
    let label = model.provider;
    if (managed !== undefined) {
      label = model.account ?? managed;
      if (siblings.some(({ provider }) => provider === managed)) {
        const account = accounts.find(({ name }) => name === label);
        label = `${account ? accountProviders[account.kind] : "Account"} · ${label}`;
      }
    } else if (
      siblings.some(
        ({ provider }) => accountForProvider(provider) === model.provider,
      )
    ) {
      label = builtInProviders[model.provider] ?? model.provider;
    }
    return {
      ...model,
      name: siblings.length ? `${model.modelId} · ${label}` : model.modelId,
    };
  });
  const row = groups.find((members) =>
    members.some((member) => key(member) === picked),
  )?.[0];
  return { rows, picked: row ? key(row) : picked };
}
