// Why: a key Claude Code's own /login made was counted as an outside credential, so the account
// was described as signed in "through a credential from the environment", which was untrue.
import { expect, test } from "bun:test";
import { Account } from "@neuve/runtime";
import { probeSignIn } from "../src/mapping.ts";

const account = Account.parse({
  name: "claude",
  kind: "claude-subscription",
  runtime: "claude-code",
  credential: { kind: "claude-config-folder" },
});
if (account.kind !== "claude-subscription")
  throw new Error("Fixture must be Claude");

for (const apiKeySource of ["/login managed key", "oauth"] as const)
  test(`a ${apiKeySource} sign-in is the account's own Claude Code login`, () => {
    expect(
      probeSignIn(account, { apiKeySource, tokenSource: "none" }),
    ).toMatchObject({ state: "signed-in", sourceMatchesAccount: true });
  });

test("an API key from the environment is not the account's own login", () => {
  expect(
    probeSignIn(account, {
      apiKeySource: "ANTHROPIC_API_KEY",
      tokenSource: "none",
    }),
  ).toMatchObject({
    state: "signed-in",
    sourceMatchesAccount: false,
    credentialSource: "environment",
  });
});
