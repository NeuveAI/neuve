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
  // The person's own Codex login, as `claude` is Claude Code's own configuration.
  Account.parse({
    name: "codex",
    kind: "chatgpt-subscription",
    runtime: "codex",
    credential: { kind: "codex-home" },
  }),
];

/**
 * Names an added account can't take: `neuve review --route <name>` reads `anthropic` and `openai`
 * as routes, and the built-in accounts' names as those accounts, before any added account.
 */
export const RESERVED_ACCOUNT_NAMES: ReadonlyArray<string> = [
  ...new Set(["anthropic", "openai", ...DEFAULT_ACCOUNTS.map((a) => a.name)]),
];
