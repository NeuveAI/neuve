import { Account } from "./account.ts";

// The account store owns accounts beyond these defaults.
export const DEFAULT_ACCOUNTS: ReadonlyArray<Account> = [
  Account.parse({
    name: "anthropic",
    kind: "anthropic-api-key",
    runtime: "pi",
    credential: { kind: "environment", variable: "ANTHROPIC_API_KEY" },
  }),
  Account.parse({
    name: "chatgpt",
    kind: "chatgpt-subscription",
    runtime: "pi",
    credential: { kind: "neuve-sign-in" },
  }),
  Account.parse({
    name: "claude",
    kind: "claude-subscription",
    runtime: "claude-code",
    credential: { kind: "claude-config-folder" },
  }),
];
