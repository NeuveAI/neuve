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

test("a first-party probe without sign-in evidence asks for Claude Code login", () => {
  expect(probeSignIn(account, { apiProvider: "firstParty" })).toEqual({
    state: "not-signed-in",
    hint: { kind: "command", command: "claude auth login" },
  });
});

for (const apiKeySource of ["/login managed key", "oauth"] as const)
  test(`a ${apiKeySource} sign-in is the account's own Claude Code login`, () => {
    expect(
      probeSignIn(account, { apiKeySource, tokenSource: "none" }),
    ).toMatchObject({ state: "signed-in", sourceMatchesAccount: true });
  });

test("a setup token is the default account's own Claude Code login", () => {
  expect(
    probeSignIn(account, { tokenSource: "CLAUDE_CODE_OAUTH_TOKEN" }),
  ).toMatchObject({
    state: "signed-in",
    sourceMatchesAccount: true,
    credentialSource: "environment",
  });
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
