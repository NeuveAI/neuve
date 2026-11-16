import { expect, test } from "bun:test";
import {
  Account,
  AccountKind,
  AccountName,
  AccountStatus,
  RuntimeKind,
  LimitWindow,
  RuntimeEvent,
  RuntimeFailure,
  SignInRequired,
  AccountRejected,
  UsageLimitReached,
  RuntimeUnavailable,
  AccountNotFound,
  AccountNeedsNewerBuild,
  CapabilityUnsupported,
  ContentBlock,
  AccountProbe,
  RuntimeModel,
  TurnFailed,
  TurnFailureReason,
  runtimeErrorToFailure,
  runtimeFailureToError,
  type CredentialReference,
  type RuntimeError,
} from "../src/index.ts";

const claude = {
  name: "work",
  kind: "claude-subscription",
  runtime: "claude-code",
  credential: { kind: "claude-config-folder" },
};

test("strict account and reference objects refuse credential values at the boundary", () => {
  for (const field of ["token", "apiKey"]) {
    expect(
      Account.safeParse({ ...claude, [field]: "private-value" }).success,
    ).toBe(false);
    expect(
      Account.safeParse({
        ...claude,
        credential: { ...claude.credential, [field]: "private-value" },
      }).success,
    ).toBe(false);
  }
});

const references: CredentialReference[] = [
  { kind: "claude-config-folder" },
  { kind: "vault", entry: "ANTHROPIC_API_KEY" },
  { kind: "environment", variable: "API_KEY" },
  { kind: "neuve-sign-in" },
];
const permitted = new Set([
  "claude-subscription/claude-code/claude-config-folder",
  "anthropic-api-key/pi/vault",
  "anthropic-api-key/pi/environment",
  "anthropic-api-key/claude-code/vault",
  "anthropic-api-key/claude-code/environment",
  "chatgpt-subscription/pi/neuve-sign-in",
  "openai-api-key/pi/vault",
  "openai-api-key/pi/environment",
]);
for (const kind of AccountKind.options) {
  for (const runtime of RuntimeKind.options) {
    for (const credential of references) {
      const key = `${kind}/${runtime}/${credential.kind}`;
      test(`account table ${permitted.has(key) ? "accepts" : "refuses"} ${key} to prevent credential misrouting`, () => {
        expect(
          Account.safeParse({ name: "work", kind, runtime, credential })
            .success,
        ).toBe(permitted.has(key));
      });
    }
  }
}

test("vault references accept existing Keychain item names so key accounts need no credential migration", () => {
  for (const entry of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]) {
    expect(
      Account.parse({
        name: "api",
        kind: "anthropic-api-key",
        runtime: "pi",
        credential: { kind: "vault", entry },
      }).credential,
    ).toEqual({ kind: "vault", entry });
  }
});

test("account names refuse malformed slugs so callers have stable identifiers", () => {
  for (const name of [
    "",
    "-work",
    "Work",
    "a_b",
    "a b",
    "a".repeat(64),
    "a\n",
  ]) {
    expect(Account.safeParse({ ...claude, name }).success).toBe(false);
  }
  expect(String(AccountName.parse("0-work"))).toBe("0-work");
  expect(String(AccountName.parse("a".repeat(63)))).toBe("a".repeat(63));
});
test("environment references refuse malformed variable names so key routes keep their boundary", () => {
  for (const variable of [
    "",
    "lowercase",
    "_KEY",
    "1KEY",
    "API-KEY",
    "API KEY",
    "API_KEY\n",
  ]) {
    expect(
      Account.safeParse({
        name: "api",
        kind: "anthropic-api-key",
        runtime: "pi",
        credential: { kind: "environment", variable },
      }).success,
    ).toBe(false);
  }
});

test("status snapshots refuse utilization outside 0..1 so apps receive fractions", () => {
  const status = {
    name: "work",
    kind: "claude-subscription",
    signIn: { state: "signed-in" },
    limits: [],
    checkedAt: "2026-11-10T12:00:00Z",
  };
  for (const utilization of [-0.01, 1.01]) {
    expect(
      AccountStatus.safeParse({
        ...status,
        limits: [{ window: "other", status: "allowed", utilization }],
      }).success,
    ).toBe(false);
  }
  for (const utilization of [0, 1]) {
    expect(
      AccountStatus.safeParse({
        ...status,
        limits: [{ window: "other", status: "allowed", utilization }],
      }).success,
    ).toBe(true);
  }
});

test("terminal failures refuse untyped errors and provider text so private diagnostics cannot cross", () => {
  const account = AccountName.parse("work");
  for (const failure of [
    { _tag: "ProviderError", account, message: "private configuration" },
    { _tag: "TurnFailed", account, reason: "arbitrary provider reason" },
    {
      _tag: "TurnFailed",
      account,
      reason: "protocol-error",
      message: "private configuration",
    },
  ]) {
    expect(
      RuntimeEvent.safeParse({
        type: "turn.finished",
        turnId: "turn-1",
        at: "2026-11-10T12:00:00Z",
        outcome: { status: "failed", failure, disposition: "broken" },
      }).success,
    ).toBe(false);
  }
});

test("every typed error round trips through JSON without losing recovery fields", () => {
  const account = AccountName.parse("work");
  const hint = {
    kind: "command",
    command: "claude auth login",
    environment: { CLAUDE_CONFIG_DIR: "/tmp/account-reference" },
  } as const;
  const errors: RuntimeError[] = [
    new SignInRequired({ account, hint }),
    new SignInRequired({
      account,
      hint: { kind: "command", command: "claude auth login" },
    }),
    new SignInRequired({
      account,
      hint: { kind: "command", command: "neuve auth login", account },
    }),
    new SignInRequired({
      account,
      hint: { kind: "settings", entry: "accounts" },
    }),
    new AccountRejected({ account, hint, reason: "expired" }),
    new AccountRejected({ account, reason: "billing" }),
    new UsageLimitReached({
      account,
      window: "five-hour",
      resetsAt: "2026-11-10T18:00:00Z",
    }),
    new UsageLimitReached({
      account,
      window: "weekly-model",
      model: "test-model",
      status: "rejected",
      utilization: 1,
      observedAt: "2026-11-10T12:00:00Z",
    }),
    new UsageLimitReached({ account, window: "other" }),
    new UsageLimitReached({ account }),
    new RuntimeUnavailable({ account, reason: "not-installed" }),
    new AccountNotFound({ account }),
    // Why: the persisted refusal must round-trip without any record contents.
    new AccountNeedsNewerBuild({ account }),
    new CapabilityUnsupported({ account, capability: "steering" }),
    ...TurnFailureReason.options.map(
      (reason) => new TurnFailed({ account, reason }),
    ),
  ];
  for (const error of errors) {
    const encoded = runtimeErrorToFailure(error);
    const parsed = RuntimeFailure.parse(JSON.parse(JSON.stringify(encoded)));
    const decoded = runtimeFailureToError(parsed);
    expect(decoded.constructor).toBe(error.constructor);
    expect(decoded).toEqual(error);
    expect(runtimeErrorToFailure(decoded)).toEqual(encoded);
    expect(Object.keys(encoded)).not.toContain("message");
    expect(Object.keys(encoded)).not.toContain("stack");
  }
});

test("limit windows refuse provider wire names so apps only see normalized windows", () => {
  expect(
    LimitWindow.safeParse({ window: "five_hour", status: "allowed" }).success,
  ).toBe(false);
  expect(
    LimitWindow.safeParse({ window: "five-hour", status: "allowed" }).success,
  ).toBe(true);
});

// Tool-result endings need a resume point, while existing turn endings must still parse without one.
test("turn.finished parses with or without a resume point", () => {
  const event = {
    type: "turn.finished",
    turnId: "turn-1",
    at: "2026-11-10T12:00:00Z",
    outcome: { status: "completed" },
  } satisfies RuntimeEvent;
  expect(RuntimeEvent.parse(event)).toEqual(event);
  const checkpoint = { ...event, resumePoint: "tool-result-chain-uuid" };
  expect(RuntimeEvent.parse(checkpoint)).toEqual(checkpoint);
});

test("message.finished parses completed responses and refuses unknown stop reasons so consumers can map endings exhaustively", () => {
  const message = {
    type: "message.finished",
    turnId: "turn-1",
    at: "2026-11-10T12:00:00Z",
    messageId: "native-message-1",
    resumePoint: "last-content-block-chain-uuid",
    toolCalls: [
      {
        callId: "native-call-1",
        toolName: "read",
        input: { path: "test-file" },
      },
    ],
    model: "test-model",
    usage: {
      input: 2,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheRead: 0,
      output: 1,
    },
  } satisfies Omit<
    Extract<RuntimeEvent, { type: "message.finished" }>,
    "stopReason"
  >;
  for (const stopReason of [
    "end-turn",
    "tool-use",
    "max-tokens",
    "refusal",
    "other",
  ] as const) {
    const event = { ...message, stopReason };
    expect(RuntimeEvent.parse(event)).toEqual(event);
  }
  expect(
    RuntimeEvent.safeParse({ ...message, stopReason: "unknown" }).success,
  ).toBe(false);
  expect(
    RuntimeEvent.safeParse({
      ...message,
      stopReason: "tool-use",
      toolCalls: [{ callId: "native-call-1", toolName: "read" }],
    }).success,
  ).toBe(false);
  const minimal = {
    type: "message.finished",
    turnId: "turn-1",
    at: "2026-11-10T12:00:00Z",
    messageId: "native-message-2",
    resumePoint: "next-chain-uuid",
    stopReason: "end-turn",
    toolCalls: [],
  } satisfies RuntimeEvent;
  expect(RuntimeEvent.parse(minimal)).toEqual(minimal);
});

test("content blocks preserve text and supported images and refuse unknown MIME types so image input stays portable", () => {
  expect(ContentBlock.parse({ type: "text", text: "look" })).toEqual({
    type: "text",
    text: "look",
  });
  for (const mimeType of [
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
  ] as const) {
    const image = {
      type: "image",
      mimeType,
      data: "aW1hZ2U=",
    } satisfies ContentBlock;
    expect(ContentBlock.parse(image)).toEqual(image);
  }
  expect(
    ContentBlock.safeParse({
      type: "image",
      mimeType: "image/svg+xml",
      data: "aW1hZ2U=",
    }).success,
  ).toBe(false);
  expect(
    ContentBlock.safeParse({
      type: "image",
      mimeType: "image/png",
      data: "not base64",
    }).success,
  ).toBe(false);
});

test("failure conversion projects nested hints so incidental private fields cannot cross", () => {
  const account = AccountName.parse("work");
  const hint = {
    kind: "command",
    command: "claude auth login",
    environment: {
      CLAUDE_CONFIG_DIR: "/tmp/account-reference",
      token: "private-value",
    },
    apiKey: "private-value",
  } as const;
  for (const error of [
    new SignInRequired({ account, hint }),
    new AccountRejected({ account, hint }),
  ]) {
    const failure = runtimeErrorToFailure(error);
    expect(failure).toEqual({
      _tag: error._tag,
      account,
      hint: {
        kind: "command",
        command: "claude auth login",
        environment: { CLAUDE_CONFIG_DIR: "/tmp/account-reference" },
      },
    });
    expect(RuntimeFailure.safeParse(failure).success).toBe(true);
    expect(JSON.stringify(failure)).not.toContain("private-value");
    if (
      failure._tag === "SignInRequired" ||
      failure._tag === "AccountRejected"
    ) {
      expect(failure.hint).not.toBe(hint);
    }
  }
});

// Coding chats offer the runtime's own models and effort levels, so the list must parse as the runtime reports it.
test("runtime models parse with optional effort fields and refuse unknown effort levels", () => {
  const model = {
    id: "default",
    resolvedModel: "claude-opus-5-5",
    displayName: "Default (recommended)",
    description: "Opus 5.5 with 1M context",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
  } satisfies RuntimeModel;
  expect(RuntimeModel.parse(model)).toEqual(model);
  expect(
    RuntimeModel.safeParse({
      id: "haiku",
      displayName: "Haiku",
      description: "",
    }).success,
  ).toBe(true);
  expect(
    RuntimeModel.safeParse({ ...model, supportedEffortLevels: ["minimal"] })
      .success,
  ).toBe(false);
  expect(RuntimeModel.safeParse({ ...model, id: "" }).success).toBe(false);
  expect(
    RuntimeModel.safeParse({ ...model, description: undefined }).success,
  ).toBe(false);
});

// pi reports no models, so the field is optional on a probe.
test("account probes parse with and without models", () => {
  const probe = {
    signIn: { state: "unknown", reason: "not-checked" },
    limits: [],
    checkedAt: "2026-11-10T12:00:00Z",
  } as const;
  expect(AccountProbe.safeParse(probe).success).toBe(true);
  expect(
    AccountProbe.safeParse({
      ...probe,
      models: [{ id: "default", displayName: "Default", description: "" }],
    }).success,
  ).toBe(true);
});

// Token limits come from the runtime's turn usage, beside the model and never inside CallUsage.
test("usage events carry optional positive model limits and refuse zero or fractions", () => {
  const usage = {
    type: "usage",
    turnId: "turn-1",
    at: "2026-11-10T12:00:00Z",
    scope: "turn",
    model: "claude-opus-5-5",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    usage: {
      input: 1,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheRead: 0,
      output: 1,
    },
    costUsd: null,
  };
  expect(RuntimeEvent.safeParse(usage).success).toBe(true);
  expect(
    RuntimeEvent.safeParse({ ...usage, contextWindow: undefined }).success,
  ).toBe(true);
  expect(RuntimeEvent.safeParse({ ...usage, contextWindow: 0 }).success).toBe(
    false,
  );
  expect(
    RuntimeEvent.safeParse({ ...usage, maxOutputTokens: 1.5 }).success,
  ).toBe(false);
});
