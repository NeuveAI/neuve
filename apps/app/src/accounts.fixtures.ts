import { AccountStatus } from "@neuve/runtime/status";

const checkedAt = "2026-11-10T10:00:00Z";
const resetsAt = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
const later = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
const hint = {
  kind: "command",
  command: "claude auth login",
  environment: { CLAUDE_CONFIG_DIR: "/tmp/Neuve's work account" },
} as const;
function account(
  name: string,
  signIn: AccountStatus["signIn"],
  limits: AccountStatus["limits"] = [],
  kind: AccountStatus["kind"] = "claude-subscription",
): AccountStatus {
  return AccountStatus.parse({ name, kind, signIn, limits, checkedAt });
}
const signedIn = {
  state: "signed-in",
  email: "alex@example.com",
  plan: "Max",
} as const;

export const accountFixtures = {
  signedIn: [account("default", signedIn)],
  signedInWithoutDetails: [account("personal", { state: "signed-in" })],
  notSignedIn: [account("work", { state: "not-signed-in", hint })],
  rejected: [
    account("work", { state: "credential-rejected", reason: "expired", hint }),
  ],
  rejectedWithoutHint: [
    account("work", { state: "credential-rejected", reason: "revoked" }),
  ],
  nearLimit: [
    account("default", signedIn, [
      { window: "five-hour", status: "warning", utilization: 0.82, resetsAt },
    ]),
  ],
  limitReached: [
    account("default", signedIn, [
      {
        window: "five-hour",
        status: "rejected",
        utilization: 1,
        resetsAt: later,
      },
    ]),
  ],
  unknown: [account("work", { state: "unknown", reason: "not-checked" })],
  checkFailed: [
    account("work", { state: "unknown", reason: "check-failed", hint }),
  ],
  notInstalled: [
    account("default", {
      state: "runtime-unavailable",
      reason: "not-installed",
    }),
  ],
  notRegistered: [
    account("default", {
      state: "runtime-unavailable",
      reason: "not-registered",
    }),
  ],
  unsupportedVersion: [
    account("default", {
      state: "runtime-unavailable",
      reason: "unsupported-version",
    }),
  ],
  startFailed: [
    account("default", {
      state: "runtime-unavailable",
      reason: "start-failed",
    }),
  ],
  environmentMismatch: [
    account("work", {
      ...signedIn,
      credentialSource: "environment",
      sourceMatchesAccount: false,
    }),
  ],
  chatgpt: [
    account(
      "personal",
      {
        state: "not-signed-in",
        hint: {
          kind: "command",
          command: "neuve auth login",
          account: AccountStatus.shape.name.parse("personal"),
        },
      },
      [],
      "chatgpt-subscription",
    ),
  ],
  settingsHint: [
    account(
      "personal",
      { state: "not-signed-in", hint: { kind: "settings", entry: "accounts" } },
      [],
      "chatgpt-subscription",
    ),
  ],
  keyAccount: [
    account(
      "api",
      { state: "not-signed-in", hint: { kind: "settings", entry: "accounts" } },
      [],
      "anthropic-api-key",
    ),
  ],
  severalAccounts: [
    account("default", signedIn, [
      {
        window: "weekly",
        status: "allowed",
        utilization: 0.3,
        resetsAt: later,
      },
      { window: "weekly-model", model: "Opus", status: "warning", resetsAt },
      { window: "overage", status: "allowed" },
      { window: "other", status: "allowed", utilization: 0.1 },
    ]),
    account("work", { state: "not-signed-in", hint }),
    account(
      "personal",
      { state: "signed-in", plan: "Plus" },
      [],
      "chatgpt-subscription",
    ),
    account("api", { state: "signed-in" }, [], "openai-api-key"),
  ],
} satisfies Record<string, AccountStatus[]>;
