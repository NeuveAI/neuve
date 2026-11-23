import { expect, test } from "bun:test";
import { Effect, Fiber, Layer, Stream } from "effect";
import {
  Account,
  AccountDirectory,
  AccountNotFound,
  DuplicateAccount,
  AccountName,
  CapabilityUnsupported,
  RuntimeRegistry,
  RuntimeUnavailable,
  TurnFailed,
  TurnLimit,
  inMemoryAccountDirectory,
  inMemoryAccountDirectoryLayer,
  runtimeRegistryLayer,
  runtimeRegistryLayerEffect,
  type AccountProbe,
  type RuntimeEvent,
  type RuntimeCapabilities,
  type RuntimeSession,
  type RuntimeShape,
  type SessionPolicy,
  type SessionStart,
  type ToolCall,
  type ToolDefinition,
} from "../src/index.ts";

const piAccount = Account.parse({
  name: "api",
  kind: "openai-api-key",
  runtime: "pi",
  credential: { kind: "environment", variable: "OPENAI_API_KEY" },
});
const claudeAccount = Account.parse({
  name: "subscription",
  kind: "claude-subscription",
  runtime: "claude-code",
  credential: { kind: "claude-config-folder" },
});
const accounts = [piAccount, claudeAccount];
const policy: SessionPolicy = {
  systemPrompt: "test",
  tools: [],
  turnLimit: TurnLimit.parse(1),
  approvalPolicy: "allow",
};
const capabilities: RuntimeCapabilities = {
  ownsLoop: true,
  toolEndsTurn: true,
  resumeInTurn: true,
  perMessageUsage: true,
  resume: false,
  fork: false,
  interrupt: false,
  modelSwitchInSession: false,
  structuredOutput: true,
  steering: false,
  approvals: false,
  perRequestTelemetry: false,
  ownTools: false,
  byteExactCapture: false,
  nativeToolServer: false,
  statusProbe: true,
  internalRetries: false,
};
const session: RuntimeSession = {
  nativeSessionId: "native-session-1",
  startTurn: () => Effect.void,
  steerTurn: () => Effect.void,
  interruptTurn: () => Effect.void,
  setModel: () => Effect.void,
  respondToApproval: () => Effect.succeed({ delivered: true }),
  events: Stream.empty,
};
function fakeRuntime(
  kind: RuntimeShape["kind"],
  calls: string[],
): RuntimeShape {
  const record = <A>(operation: string, account: Account, value: A) =>
    Effect.sync(() => {
      calls.push(`${kind}:${operation}:${account.name}`);
      return value;
    });
  return {
    kind,
    continuation: (account) => {
      calls.push(`${kind}:continuation:${account.name}`);
      return {
        runtime: kind,
        key:
          account.credential.kind === "claude-config-folder"
            ? `config:${account.credential.folder ?? "default"}`
            : `account:${account.name}`,
      };
    },
    capabilities: (account) => record("capabilities", account, capabilities),
    openSession: (account) => record("openSession", account, session),
    signOut: (account) => record("signOut", account, undefined),
    probe: (account) =>
      record("probe", account, {
        signIn: { state: "unknown", reason: "not-checked" },
        limits: [],
        checkedAt: "2026-11-10T12:00:00Z",
      } satisfies AccountProbe),
  };
}
const registryLayer = (runtimes: RuntimeShape[]) =>
  runtimeRegistryLayer(runtimes).pipe(
    Layer.provide(inMemoryAccountDirectoryLayer(accounts)),
  );

// A fork or conversation reset changes the native id after open, so callers must see the current id.
test("wrapped sessions read the native session id live after a turn", async () => {
  let nativeSessionId = "native-session-1";
  const runtime: RuntimeShape = {
    ...fakeRuntime("claude-code", []),
    openSession: () =>
      Effect.succeed({
        ...session,
        get nativeSessionId() {
          return nativeSessionId;
        },
        startTurn: () =>
          Effect.sync(() => {
            nativeSessionId = "native-session-2";
          }),
      }),
  };
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* RuntimeRegistry;
        const opened = yield* registry.openSession(claudeAccount.name, policy);
        expect(opened.nativeSessionId).toBe("native-session-1");
        yield* opened.startTurn({ turnId: "turn-1", message: "continue" });
        expect(opened.nativeSessionId).toBe("native-session-2");
      }),
    ).pipe(Effect.provide(registryLayer([runtime]))),
  );
});

// Removal can be missed by a file watch, so every turn start rechecks the account before the runtime is called.
test("checkTurn runs before every startTurn and a failure stops the runtime from being called", async () => {
  const calls: string[] = [];
  let usable = true;
  const base = inMemoryAccountDirectory(accounts);
  const directory = AccountDirectory.of({
    ...base,
    checkTurn: (name) =>
      Effect.suspend(() => {
        calls.push(`checkTurn:${name}`);
        return usable
          ? Effect.void
          : Effect.fail(new AccountNotFound({ account: name }));
      }),
  });
  const runtime: RuntimeShape = {
    ...fakeRuntime("claude-code", []),
    openSession: () =>
      Effect.succeed({
        ...session,
        // Recorded when the function is called, not when its effect runs.
        startTurn: (input) => {
          calls.push(`startTurn:${input.turnId}`);
          return Effect.void;
        },
      }),
  };
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* RuntimeRegistry;
        const opened = yield* registry.openSession(claudeAccount.name, policy);
        yield* opened.startTurn({ turnId: "turn-1", message: "continue" });
        usable = false;
        return yield* opened
          .startTurn({ turnId: "turn-2", message: "continue" })
          .pipe(
            Effect.match({
              onFailure: (error) => error._tag,
              onSuccess: () => "unexpected success",
            }),
          );
      }),
    ).pipe(
      Effect.provide(
        runtimeRegistryLayer([runtime]).pipe(
          Layer.provide(Layer.succeed(AccountDirectory, directory)),
        ),
      ),
    ),
  );
  expect(result).toBe("AccountNotFound");
  expect(calls).toEqual([
    `checkTurn:${claudeAccount.name}`,
    "startTurn:turn-1",
    `checkTurn:${claudeAccount.name}`,
  ]);
});

test("a runtime without ownsLoop is never opened but still routes account operations so callers can use status-only runtimes", async () => {
  const calls: string[] = [];
  const statusOnly = { ...capabilities, ownsLoop: false };
  const runtime: RuntimeShape = {
    ...fakeRuntime("pi", calls),
    capabilities: () => Effect.succeed(statusOnly),
  };
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* RuntimeRegistry;
        const declared = yield* registry.capabilities(piAccount.name);
        const identity = yield* registry.continuation(piAccount.name);
        const failure = yield* registry
          .openSession(piAccount.name, policy)
          .pipe(
            Effect.match({
              onFailure: (error) => error,
              onSuccess: () => "unexpected success",
            }),
          );
        const status = yield* registry.probe(piAccount.name);
        yield* registry.signOut(piAccount.name);
        return { declared, identity, failure, status };
      }),
    ).pipe(Effect.provide(registryLayer([runtime]))),
  );
  expect(result).toEqual({
    declared: statusOnly,
    identity: { runtime: "pi", key: "account:api" },
    failure: new CapabilityUnsupported({
      account: piAccount.name,
      capability: "ownsLoop",
    }),
    status: {
      name: piAccount.name,
      kind: "openai-api-key",
      signIn: { state: "unknown", reason: "not-checked" },
      limits: [],
      checkedAt: "2026-11-10T12:00:00Z",
    },
  });
  expect(calls).toEqual([
    "pi:continuation:api",
    "pi:probe:api",
    "pi:signOut:api",
  ]);
});

test("probe returns unknown without statusProbe so an unsupported runtime probe is never called", async () => {
  const calls: string[] = [];
  const runtime: RuntimeShape = {
    ...fakeRuntime("pi", calls),
    capabilities: () => Effect.succeed({ ...capabilities, statusProbe: false }),
  };
  const status = await Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* RuntimeRegistry;
      return yield* registry.probe(piAccount.name);
    }).pipe(Effect.provide(registryLayer([runtime]))),
  );
  expect({ signIn: status.signIn, calls }).toEqual({
    signIn: { state: "unknown", reason: "not-checked" },
    calls: [],
  });
});

// Coding chats read the runtime's model list only through the registry, so a probe's models must reach callers in order.
test("probe passes the runtime's models through, default first", async () => {
  const models = [
    { id: "default", displayName: "Default", description: "Recommended" },
    { id: "haiku", displayName: "Haiku", description: "Fast" },
  ];
  const runtime: RuntimeShape = {
    ...fakeRuntime("pi", []),
    probe: () =>
      Effect.succeed({
        signIn: { state: "unknown", reason: "not-checked" },
        limits: [],
        checkedAt: "2026-11-10T12:00:00Z",
        models,
      }),
  };
  const status = await Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* RuntimeRegistry;
      return yield* registry.probe(piAccount.name);
    }).pipe(Effect.provide(registryLayer([runtime]))),
  );
  expect(status.models).toEqual(models);
});

test("route each account's capabilities, session and probe to its own runtime", async () => {
  const calls: string[] = [];
  const layer = runtimeRegistryLayerEffect(
    Effect.succeed([
      fakeRuntime("pi", calls),
      fakeRuntime("claude-code", calls),
    ]),
  ).pipe(Layer.provide(inMemoryAccountDirectoryLayer(accounts)));
  const values = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* RuntimeRegistry;
        const values = [];
        for (const account of accounts) {
          values.push(yield* registry.capabilities(account.name));
          const opened = yield* registry.openSession(account.name, policy);
          values.push(yield* Stream.runCollect(opened.events));
          values.push(yield* registry.probe(account.name));
        }
        return values;
      }),
    ).pipe(Effect.provide(layer)),
  );
  expect(calls).toEqual([
    "pi:capabilities:api",
    "pi:capabilities:api",
    "pi:openSession:api",
    "pi:capabilities:api",
    "pi:probe:api",
    "claude-code:capabilities:subscription",
    "claude-code:capabilities:subscription",
    "claude-code:openSession:subscription",
    "claude-code:capabilities:subscription",
    "claude-code:probe:subscription",
  ]);
  expect(values).toEqual([
    capabilities,
    [],
    {
      name: piAccount.name,
      kind: "openai-api-key",
      signIn: { state: "unknown", reason: "not-checked" },
      limits: [],
      checkedAt: "2026-11-10T12:00:00Z",
    },
    capabilities,
    [],
    {
      name: claudeAccount.name,
      kind: "claude-subscription",
      signIn: { state: "unknown", reason: "not-checked" },
      limits: [],
      checkedAt: "2026-11-10T12:00:00Z",
    },
  ]);
});

for (const operation of ["capabilities", "openSession", "probe"] as const) {
  test(`${operation} reports AccountNotFound so an unknown account cannot start work`, async () => {
    const calls: string[] = [];
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const registry = yield* RuntimeRegistry;
          const name = AccountName.parse("missing");
          const request =
            operation === "openSession"
              ? registry.openSession(name, policy).pipe(Effect.asVoid)
              : operation === "capabilities"
                ? registry.capabilities(name).pipe(Effect.asVoid)
                : registry.probe(name).pipe(Effect.asVoid);
          return yield* request.pipe(
            Effect.match({
              onFailure: (error) => ({
                tag: error._tag,
                account: String(error.account),
              }),
              onSuccess: () => "unexpected success",
            }),
          );
        }),
      ).pipe(Effect.provide(registryLayer([fakeRuntime("pi", calls)]))),
    );
    expect(result).toEqual({ tag: "AccountNotFound", account: "missing" });
    expect(calls).toEqual([]);
  });
  test(`${operation} reports RuntimeUnavailable so a missing runtime cannot start work`, async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const registry = yield* RuntimeRegistry;
          const request =
            operation === "openSession"
              ? registry
                  .openSession(claudeAccount.name, policy)
                  .pipe(Effect.asVoid)
              : operation === "capabilities"
                ? registry.capabilities(claudeAccount.name).pipe(Effect.asVoid)
                : registry.probe(claudeAccount.name).pipe(Effect.asVoid);
          return yield* request.pipe(
            Effect.match({
              onFailure: (error) => ({
                tag: error._tag,
                account: String(error.account),
                reason:
                  error._tag === "RuntimeUnavailable"
                    ? error.reason
                    : undefined,
              }),
              onSuccess: () => "unexpected success",
            }),
          );
        }),
      ).pipe(Effect.provide(registryLayer([]))),
    );
    expect(result).toEqual({
      tag: "RuntimeUnavailable",
      account: "subscription",
      reason: "not-registered",
    });
  });
}

test("withAccess refuses opening before runtime access so removal can close admission", async () => {
  const calls: string[] = [];
  const base = inMemoryAccountDirectory(accounts);
  const directory = AccountDirectory.of({
    ...base,
    withAccess: (name) => {
      calls.push(`admission:${name}`);
      return Effect.fail(
        new RuntimeUnavailable({ account: name, reason: "start-failed" }),
      );
    },
  });
  const layer = runtimeRegistryLayer([fakeRuntime("pi", calls)]).pipe(
    Layer.provide(Layer.succeed(AccountDirectory, directory)),
  );
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* RuntimeRegistry;
        return yield* registry.openSession(piAccount.name, policy).pipe(
          Effect.match({
            onFailure: (error) => error._tag,
            onSuccess: () => "unexpected success",
          }),
        );
      }),
    ).pipe(Effect.provide(layer)),
  );
  expect(result).toBe("RuntimeUnavailable");
  expect(calls).toEqual(["admission:api"]);
});

test("duplicate runtime kinds fail layer construction so routing is unambiguous", async () => {
  const calls: string[] = [];
  const result = await Effect.runPromise(
    RuntimeRegistry.pipe(
      Effect.provide(
        registryLayer([fakeRuntime("pi", calls), fakeRuntime("pi", calls)]),
      ),
      Effect.match({
        onFailure: (error) => ({ tag: error._tag, kind: error.kind }),
        onSuccess: () => "unexpected success",
      }),
    ),
  );
  expect(result).toEqual({ tag: "DuplicateRuntime", kind: "pi" });
  expect(calls).toEqual([]);
});

test("duplicate account names throw at construction so a credential cannot silently replace another", () => {
  expect(() =>
    inMemoryAccountDirectory([
      piAccount,
      { ...claudeAccount, name: piAccount.name },
    ]),
  ).toThrow(DuplicateAccount);
});

test("signOut routes by account and reports lookup failures so callers never select runtimes", async () => {
  const calls: string[] = [];
  const failures = await Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* RuntimeRegistry;
      yield* registry.signOut(piAccount.name);
      yield* registry.signOut(claudeAccount.name);
      const missing = yield* registry
        .signOut(AccountName.parse("missing"))
        .pipe(
          Effect.match({
            onFailure: (error) => error._tag,
            onSuccess: () => "unexpected success",
          }),
        );
      return missing;
    }).pipe(
      Effect.provide(
        registryLayer([
          fakeRuntime("pi", calls),
          fakeRuntime("claude-code", calls),
        ]),
      ),
    ),
  );
  expect(calls).toEqual(["pi:signOut:api", "claude-code:signOut:subscription"]);
  expect(failures).toBe("AccountNotFound");
  const unregistered = await Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* RuntimeRegistry;
      return yield* registry.signOut(claudeAccount.name).pipe(
        Effect.match({
          onFailure: (error) => error._tag,
          onSuccess: () => "unexpected success",
        }),
      );
    }).pipe(Effect.provide(registryLayer([]))),
  );
  expect(unregistered).toBe("RuntimeUnavailable");
});

test("class-backed sessions keep text and image inputs, every control and its receiver so registry wrapping cannot drop content or prototype methods", async () => {
  class ClassSession implements RuntimeSession {
    readonly nativeSessionId = "class-native-session";
    readonly received: { operation: string; input: unknown }[] = [];
    readonly events: Stream.Stream<RuntimeEvent> = Stream.make({
      type: "turn.started",
      turnId: "turn-1",
      at: "2026-11-10T12:00:00Z",
    });
    startTurn(input: Parameters<RuntimeSession["startTurn"]>[0]) {
      return Effect.sync(() => {
        this.received.push({ operation: "startTurn", input });
      });
    }
    steerTurn(input: Parameters<RuntimeSession["steerTurn"]>[0]) {
      return Effect.sync(() => {
        this.received.push({ operation: "steerTurn", input });
      });
    }
    interruptTurn(input: Parameters<RuntimeSession["interruptTurn"]>[0]) {
      return Effect.sync(() => {
        this.received.push({ operation: "interruptTurn", input });
      });
    }
    setModel(input: Parameters<RuntimeSession["setModel"]>[0]) {
      return Effect.sync(() => {
        this.received.push({ operation: "setModel", input });
      });
    }
    respondToApproval(
      input: Parameters<RuntimeSession["respondToApproval"]>[0],
    ) {
      return Effect.sync(() => {
        this.received.push({ operation: "respondToApproval", input });
        return { delivered: true } as const;
      });
    }
  }
  const original = new ClassSession();
  const runtime: RuntimeShape = {
    ...fakeRuntime("pi", []),
    capabilities: () =>
      Effect.succeed({
        ...capabilities,
        steering: true,
        approvals: true,
        interrupt: true,
        modelSwitchInSession: true,
      }),
    openSession: () => Effect.succeed(original),
  };
  const events = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* RuntimeRegistry;
        const opened = yield* registry.openSession(piAccount.name, {
          ...policy,
          approvalPolicy: "ask",
        });
        expect(opened.nativeSessionId).toBe("class-native-session");
        yield* opened.startTurn({ turnId: "turn-1", message: "start" });
        yield* opened.steerTurn({ turnId: "turn-1", message: "steer" });
        yield* opened.startTurn({
          turnId: "turn-2",
          message: [
            { type: "text", text: "look" },
            { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
          ],
        });
        yield* opened.steerTurn({
          turnId: "turn-2",
          message: [
            { type: "image", mimeType: "image/jpeg", data: "c3RlZXI=" },
          ],
        });
        yield* opened.interruptTurn({ turnId: "turn-1", reason: "stop" });
        yield* opened.setModel({ id: "next-model", effort: "high" });
        yield* opened.respondToApproval({
          requestId: "approval-1",
          decision: "deny",
          message: "skip",
        });
        return yield* Stream.runCollect(opened.events);
      }),
    ).pipe(Effect.provide(registryLayer([runtime]))),
  );
  expect(original.received).toEqual([
    { operation: "startTurn", input: { turnId: "turn-1", message: "start" } },
    { operation: "steerTurn", input: { turnId: "turn-1", message: "steer" } },
    {
      operation: "startTurn",
      input: {
        turnId: "turn-2",
        message: [
          { type: "text", text: "look" },
          { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
        ],
      },
    },
    {
      operation: "steerTurn",
      input: {
        turnId: "turn-2",
        message: [{ type: "image", mimeType: "image/jpeg", data: "c3RlZXI=" }],
      },
    },
    { operation: "interruptTurn", input: { turnId: "turn-1", reason: "stop" } },
    { operation: "setModel", input: { id: "next-model", effort: "high" } },
    {
      operation: "respondToApproval",
      input: { requestId: "approval-1", decision: "deny", message: "skip" },
    },
  ]);
  expect(events).toEqual([
    { type: "turn.started", turnId: "turn-1", at: "2026-11-10T12:00:00Z" },
  ]);
});

test("removing accounts refuse use but allow sign-out so removal can clear the runtime credential", async () => {
  const calls: string[] = [];
  const base = inMemoryAccountDirectory(accounts);
  const removing = new Set([claudeAccount.name]);
  const directory = AccountDirectory.of({
    ...base,
    lookup: (name, purpose) =>
      removing.has(name) && purpose === "use"
        ? Effect.succeed(undefined)
        : base.lookup(name, purpose),
  });
  const layer = runtimeRegistryLayer([fakeRuntime("claude-code", calls)]).pipe(
    Layer.provide(Layer.succeed(AccountDirectory, directory)),
  );
  const results = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* RuntimeRegistry;
        const result = [];
        for (const request of [
          registry.capabilities(claudeAccount.name).pipe(Effect.asVoid),
          registry.probe(claudeAccount.name).pipe(Effect.asVoid),
          registry.openSession(claudeAccount.name, policy).pipe(Effect.asVoid),
        ]) {
          result.push(
            yield* request.pipe(
              Effect.match({
                onFailure: (error) => error._tag,
                onSuccess: () => "unexpected success",
              }),
            ),
          );
        }
        yield* registry.signOut(claudeAccount.name);
        return result;
      }),
    ).pipe(Effect.provide(layer)),
  );
  expect(results).toEqual([
    "AccountNotFound",
    "AccountNotFound",
    "AccountNotFound",
  ]);
  expect(calls).toEqual(["claude-code:signOut:subscription"]);
});

test("final turns require a schema and forward it with final true so the runtime can produce the requested output", async () => {
  const calls: string[] = [];
  const policies: SessionPolicy[] = [];
  const turns: Parameters<RuntimeSession["startTurn"]>[0][] = [];
  const runtime: RuntimeShape = {
    ...fakeRuntime("pi", calls),
    openSession: (_account, receivedPolicy) =>
      Effect.sync(() => {
        policies.push(receivedPolicy);
        return {
          ...session,
          startTurn: (input) =>
            Effect.sync(() => {
              turns.push(input);
            }),
        } satisfies RuntimeSession;
      }),
  };
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* RuntimeRegistry;
        const opened = yield* registry.openSession(piAccount.name, policy);
        const failure = yield* opened
          .startTurn({ turnId: "final", message: "finish", final: true })
          .pipe(
            Effect.match({
              onFailure: (error) => error,
              onSuccess: () => "unexpected success",
            }),
          );
        yield* opened.startTurn({ turnId: "normal", message: "continue" });
        const finalSession = yield* registry.openSession(piAccount.name, {
          ...policy,
          outputSchema: { type: "object" },
        });
        yield* finalSession.startTurn({
          turnId: "valid-final",
          message: "finish",
          final: true,
        });
        return failure;
      }),
    ).pipe(Effect.provide(registryLayer([runtime]))),
  );
  expect(result).toEqual(
    new TurnFailed({ account: piAccount.name, reason: "no-output-schema" }),
  );
  expect(policies).toEqual([
    policy,
    { ...policy, outputSchema: { type: "object" } },
  ]);
  expect(turns).toEqual([
    { turnId: "normal", message: "continue" },
    { turnId: "valid-final", message: "finish", final: true },
  ]);
});

test("usage tap broadcasts each session's usage and rate limits with its account while preserving every caller event", async () => {
  const at = "2026-11-10T12:00:00Z";
  const events = [
    { type: "turn.started", turnId: "turn-1", at },
    { type: "text", turnId: "turn-1", at, text: "hello" },
    {
      type: "usage",
      turnId: "turn-1",
      at,
      scope: "turn",
      model: "test-model",
      usage: {
        input: 2,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        cacheRead: 0,
        output: 1,
      },
      costUsd: null,
    },
    {
      type: "rate-limit",
      turnId: "turn-1",
      at,
      window: "five-hour",
      status: "warning",
      utilization: 0.8,
    },
    {
      type: "message.finished",
      turnId: "turn-1",
      at,
      messageId: "native-message-1",
      resumePoint: "last-chain-uuid",
      stopReason: "end-turn",
      toolCalls: [],
      usage: {
        input: 2,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        cacheRead: 0,
        output: 1,
      },
    },
    {
      type: "turn.finished",
      turnId: "turn-1",
      at,
      outcome: { status: "completed" },
    },
  ] as const satisfies ReadonlyArray<RuntimeEvent>;
  const calls: string[] = [];
  const runtimes = [
    fakeRuntime("pi", calls),
    fakeRuntime("claude-code", calls),
  ].map((runtime) => ({
    ...runtime,
    openSession: () =>
      Effect.succeed({ ...session, events: Stream.fromIterable(events) }),
  }));
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* RuntimeRegistry;
        const tap = yield* registry.accountEvents.pipe(
          Stream.take(4),
          Stream.runCollect,
          Effect.forkScoped({ startImmediately: true }),
        );
        const secondTap = yield* registry.accountEvents.pipe(
          Stream.take(4),
          Stream.runCollect,
          Effect.forkScoped({ startImmediately: true }),
        );
        const delivered = [];
        for (const account of accounts) {
          const opened = yield* registry.openSession(account.name, policy);
          delivered.push(yield* Stream.runCollect(opened.events));
        }
        return {
          delivered,
          tapped: yield* Fiber.join(tap),
          broadcast: yield* Fiber.join(secondTap),
        };
      }),
    ).pipe(Effect.provide(registryLayer(runtimes))),
  );
  expect(result.delivered).toEqual([[...events], [...events]]);
  const expected = accounts.flatMap((account) => [
    { account: account.name, event: events[2] },
    { account: account.name, event: events[3] },
  ]);
  expect(result.tapped).toEqual(expected);
  expect(result.broadcast).toEqual(expected);
});

test("openSession defaults to new and forwards explicit starts so callers can resume at a native point or fork", async () => {
  const received: {
    account: Account;
    policy: SessionPolicy;
    start: SessionStart;
  }[] = [];
  const runtime: RuntimeShape = {
    ...fakeRuntime("claude-code", []),
    capabilities: () =>
      Effect.succeed({ ...capabilities, resume: true, fork: true }),
    openSession: (account, policy, start) =>
      Effect.sync(() => {
        received.push({ account, policy, start });
        return session;
      }),
  };
  const starts: SessionStart[] = [
    { kind: "new" },
    { kind: "resume", session: "old-session", fork: false },
    {
      kind: "resume",
      session: "old-session",
      at: "last-chain-uuid",
      fork: true,
    },
  ];
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* RuntimeRegistry;
        const opened = yield* registry.openSession(claudeAccount.name, policy);
        expect(opened.nativeSessionId).toBe("native-session-1");
        for (const start of starts)
          yield* registry.openSession(claudeAccount.name, policy, start);
      }),
    ).pipe(Effect.provide(registryLayer([runtime]))),
  );
  expect(received).toEqual(
    [{ kind: "new" } satisfies SessionStart, ...starts].map((start) => ({
      account: claudeAccount,
      policy,
      start,
    })),
  );
  for (const [index, start] of starts.entries())
    expect(received[index + 1]?.start).toBe(start);
});

for (const denied of ["resume", "fork"] as const) {
  test(`openSession refuses unsupported ${denied} before opening so the runtime cannot perform forbidden continuation`, async () => {
    const calls: string[] = [];
    const runtime: RuntimeShape = {
      ...fakeRuntime("claude-code", calls),
      capabilities: () =>
        Effect.succeed({
          ...capabilities,
          resume: denied !== "resume",
          fork: denied !== "fork",
        }),
    };
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const registry = yield* RuntimeRegistry;
          return yield* registry
            .openSession(claudeAccount.name, policy, {
              kind: "resume",
              session: "old-session",
              at: "chain-uuid",
              fork: true,
            })
            .pipe(
              Effect.match({
                onFailure: (error) => error,
                onSuccess: () => "unexpected success",
              }),
            );
        }),
      ).pipe(Effect.provide(registryLayer([runtime]))),
    );
    expect(result).toEqual(
      new CapabilityUnsupported({
        account: claudeAccount.name,
        capability: denied,
      }),
    );
    expect(calls).toEqual([]);
  });
}

for (const denied of [
  "interrupt",
  "modelSwitchInSession",
  "steering",
  "approvals",
] as const) {
  test(`session refuses unsupported ${denied} before calling the runtime so controls honor capabilities`, async () => {
    const calls: string[] = [];
    const runtime: RuntimeShape = {
      ...fakeRuntime("claude-code", []),
      openSession: () =>
        Effect.succeed({
          ...session,
          interruptTurn: () => {
            calls.push("interruptTurn");
            return Effect.void;
          },
          setModel: () => {
            calls.push("setModel");
            return Effect.void;
          },
          steerTurn: () => {
            calls.push("steerTurn");
            return Effect.void;
          },
          respondToApproval: () => {
            calls.push("respondToApproval");
            return Effect.succeed({ delivered: true });
          },
        }),
    };
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const registry = yield* RuntimeRegistry;
          const opened = yield* registry.openSession(
            claudeAccount.name,
            policy,
          );
          const request = (() => {
            switch (denied) {
              case "interrupt":
                return opened.interruptTurn({
                  turnId: "turn-1",
                  reason: "stop",
                });
              case "modelSwitchInSession":
                return opened.setModel({ id: "next-model", effort: "high" });
              case "steering":
                return opened.steerTurn({ turnId: "turn-1", message: "steer" });
              case "approvals":
                return opened.respondToApproval({
                  requestId: "approval-1",
                  decision: "deny",
                });
            }
          })();
          return yield* request.pipe(
            Effect.match({
              onFailure: (error) => error,
              onSuccess: () => "unexpected success",
            }),
          );
        }),
      ).pipe(Effect.provide(registryLayer([runtime]))),
    );
    expect(result).toEqual(
      new CapabilityUnsupported({
        account: claudeAccount.name,
        capability: denied,
      }),
    );
    expect(calls).toEqual([]);
  });
}

test("continuation routes by account so two accounts on one runtime can have distinct continuation identities", async () => {
  const other = Account.parse({
    ...claudeAccount,
    name: "other-subscription",
    credential: {
      kind: "claude-config-folder",
      folder: "/tmp/other-account-reference",
    },
  });
  const calls: string[] = [];
  const layer = runtimeRegistryLayer([
    fakeRuntime("pi", calls),
    fakeRuntime("claude-code", calls),
  ]).pipe(Layer.provide(inMemoryAccountDirectoryLayer([...accounts, other])));
  const identities = await Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* RuntimeRegistry;
      const result = [];
      for (const account of [...accounts, other])
        result.push(yield* registry.continuation(account.name));
      return result;
    }).pipe(Effect.provide(layer)),
  );
  expect(identities).toEqual([
    { runtime: "pi", key: "account:api" },
    { runtime: "claude-code", key: "config:default" },
    { runtime: "claude-code", key: "config:/tmp/other-account-reference" },
  ]);
  expect(calls).toEqual([
    "pi:continuation:api",
    "claude-code:continuation:subscription",
    "claude-code:continuation:other-subscription",
  ]);
});

test("runtime passes its ToolCall to a definition's handler so tools can correlate native calls and observe cancellation", async () => {
  const call: ToolCall = {
    callId: "native-tool-use-1",
    signal: new AbortController().signal,
  };
  const received: { input: unknown; call: ToolCall | undefined }[] = [];
  const tool: ToolDefinition = {
    name: "read",
    description: "Read test input",
    inputSchema: { type: "object" },
    hints: {
      readOnly: true,
      destructive: false,
      idempotent: true,
      openWorld: false,
    },
    handle: (input, call) =>
      Effect.sync(() => {
        received.push({ input, call });
        return { text: "read result" };
      }),
  };
  const input = { path: "test-file" };
  const runtime: RuntimeShape = {
    ...fakeRuntime("claude-code", []),
    capabilities: () => Effect.succeed({ ...capabilities, ownsLoop: true }),
    openSession: (_account, policy) =>
      Effect.succeed({
        ...session,
        startTurn: () =>
          Effect.gen(function* () {
            for (const tool of policy.tools) yield* tool.handle(input, call);
          }),
      }),
  };
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* RuntimeRegistry;
        const opened = yield* registry.openSession(claudeAccount.name, {
          ...policy,
          tools: [tool],
        });
        yield* opened.startTurn({ turnId: "turn-1", message: "read" });
      }),
    ).pipe(Effect.provide(registryLayer([runtime]))),
  );
  expect(received).toEqual([{ input: { path: "test-file" }, call }]);
  expect(received[0]?.call).toBe(call);
  expect(received[0]?.call?.signal).toBe(call.signal);
});
