import { expect, test } from "bun:test";

import { listed } from "../src/listed-models.ts";
import { AccountStatus } from "../src/status.ts";

const models = [
  { provider: "openai", modelId: "m" },
  { provider: "account:openai", modelId: "m", account: "openai" },
];

// Both routes must stay selectable and readable even before account status arrives.
test.each([
  ["chatgpt-subscription", "m · ChatGPT · openai"],
  ["openai-api-key", "m · OpenAI · openai"],
  [undefined, "m · Account · openai"],
] as const)(
  "a built-in provider and a same-named account have distinct labels with %s status",
  (kind, accountLabel) => {
    const accounts =
      kind === undefined
        ? []
        : [
            AccountStatus.parse({
              name: "openai",
              kind,
              signIn: { state: "signed-in" },
              limits: [],
              checkedAt: "2026-11-27T00:00:00Z",
            }),
          ];
    const { rows, picked } = listed(models, "account:openai/m", accounts);
    expect(rows.map(({ name }) => name)).toEqual(["m · OpenAI", accountLabel]);
    expect(picked).toBe("account:openai/m");
    expect(listed(models, "openai/m", accounts).picked).toBe("openai/m");
  },
);
