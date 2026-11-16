import { expect, test } from "bun:test";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  Account,
  AccountProbe,
  JsonSchema,
  RuntimeEvent,
  TurnLimit,
  type RuntimeSession,
  type SessionPolicy,
} from "@neuve/runtime";
import { Effect, Exit, Fiber, Layer, Queue, Scope, Stream } from "effect";
import { z } from "zod";
import { childEnvironment, REMOVED_ENVIRONMENT } from "../src/environment.ts";
import { makeRuntime } from "../src/runtime.ts";
import { ClaudeExecutable, ClaudeProcess } from "../src/services.ts";
import { TOOL_TIMEOUT_MS } from "../src/tools.ts";
import {
  assistant,
  errorResult,
  result,
  SESSION_ID,
  textDelta,
  usage,
} from "./frames.ts";
import { inbound, out, replay, toolLifecycle, type Entry } from "./replay.ts";

const account = Account.parse({
  name: "test",
  kind: "claude-subscription",
  runtime: "claude-code",
  credential: { kind: "claude-config-folder", folder: "/test/config" },
});
if (account.kind !== "claude-subscription")
  throw new Error("Fixture must be Claude");
const schema = {
  type: "object",
  properties: { value: { type: "string", minLength: 2 } },
  required: ["value"],
  additionalProperties: false,
};
const policy: SessionPolicy = {
  systemPrompt: "test policy",
  tools: [],
  turnLimit: TurnLimit.parse(5),
  approvalPolicy: "allow",
  outputSchema: schema,
};
const config = {
  cwd: "/test/neuve",
  environment: { HOME: "/test/home" },
  identity: { sessionId: SESSION_ID },
  probeTimeoutMs: 5,
};
const executableLayer = Layer.succeed(ClaudeExecutable, {
  resolve: () => Effect.succeed("/test/claude"),
});
const processLayer = Layer.succeed(ClaudeProcess, {
  run: () => Effect.die("Unexpected process use"),
});
function setup(
  entries: Entry[],
  options: Partial<Parameters<typeof makeRuntime>[0]> = {},
) {
  const fake = replay(entries);
  const layer = Layer.mergeAll(fake.layer, executableLayer, processLayer);
  return { ...fake, layer, runtime: makeRuntime({ ...config, ...options }) };
}
const eventReader = (session: RuntimeSession) =>
  Effect.gen(function* () {
    const seen: RuntimeEvent[] = [];
    const observeTools = toolLifecycle();
    const queue = yield* Queue.unbounded<RuntimeEvent>();
    yield* Stream.runForEach(session.events, (event) =>
      Effect.sync(() => {
        RuntimeEvent.parse(event);
        observeTools(event);
        seen.push(event);
        Queue.offerUnsafe(queue, event);
      }),
    ).pipe(Effect.forkScoped);
    const until = (type: RuntimeEvent["type"]): Effect.Effect<RuntimeEvent> =>
      Effect.gen(function* () {
        while (true) {
          const event = yield* Queue.take(queue);
          if (event.type === type) return event;
        }
      });
    return { seen, until };
  });
function sessionTest(
  entries: Entry[],
  body: (
    session: AwaitedSession,
    reader: Reader,
  ) => Effect.Effect<void, unknown, Scope.Scope>,
  sessionPolicy = policy,
  options: Partial<Parameters<typeof makeRuntime>[0]> = {},
) {
  const fake = setup(entries, options);
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* fake.runtime;
        const session = yield* runtime.openSession(account, sessionPolicy);
        const reader = yield* eventReader(session);
        yield* body(session, reader);
      }),
    ).pipe(Effect.provide(fake.layer), Effect.timeout("3 seconds")),
  );
}
type AwaitedSession = RuntimeSession;
type Reader = Effect.Success<ReturnType<typeof eventReader>>;
const normal = { turnId: "one", message: "test prompt" };
const open = out({ type: "query.open" });
const offer = out({ type: "prompt.offer", message: normal.message });
const close = out({ type: "query.close" });

async function finalOutputFormat(
  outputSchema: NonNullable<SessionPolicy["outputSchema"]>,
) {
  let outputFormat: Options["outputFormat"];
  await sessionTest(
    [
      open,
      close,
      out({
        type: "query.open",
        check: (options) => {
          outputFormat = options.outputFormat;
        },
      }),
      offer,
      inbound(result({ structured_output: { ok: true } })),
      close,
    ],
    (session, reader) =>
      Effect.gen(function* () {
        yield* session.startTurn({ ...normal, final: true });
        expect(yield* reader.until("turn.finished")).toMatchObject({
          outcome: { status: "completed", structuredOutput: { ok: true } },
        });
      }),
    { ...policy, outputSchema },
  );
  return outputFormat;
}

// Reason: Zod's draft declaration must not reach Claude Code or be removed from the caller's policy.
test("R22b final output omits the top-level $schema without mutating the policy", async () => {
  const outputSchema = JsonSchema.parse(
    z.toJSONSchema(z.strictObject({ ok: z.boolean() })),
  );
  const original = structuredClone(outputSchema);
  const { $schema, ...expected } = original;
  const outputFormat = await finalOutputFormat(outputSchema);
  expect($schema).toBe("https://json-schema.org/draft/2020-12/schema");
  expect(outputFormat?.schema).not.toHaveProperty("$schema");
  expect(outputFormat).toEqual({ type: "json_schema", schema: expected });
  expect(outputSchema).toEqual(original);
});

// Reason: passes before, guards behaviour for callers that already omit the draft declaration.
test("R22b a schema without $schema passes unchanged", async () => {
  const outputSchema = {
    type: "object",
    properties: { ok: { type: "boolean" } },
    required: ["ok"],
    additionalProperties: false,
  };
  expect(await finalOutputFormat(outputSchema)).toEqual({
    type: "json_schema",
    schema: outputSchema,
  });
});

// Reason: passes before, guards behaviour so non-final turns never request structured output.
test("R22b non-final opens carry no outputFormat", async () => {
  let options: Options | undefined;
  await sessionTest(
    [
      out({
        type: "query.open",
        check: (opened) => {
          options = opened;
        },
      }),
      offer,
      inbound(result()),
      close,
    ],
    (session, reader) =>
      Effect.gen(function* () {
        yield* session.startTurn(normal);
        expect(yield* reader.until("turn.finished")).toMatchObject({
          outcome: { status: "completed" },
        });
      }),
    {
      ...policy,
      outputSchema: JsonSchema.parse(
        z.toJSONSchema(z.strictObject({ ok: z.boolean() })),
      ),
    },
  );
  expect(options).toBeDefined();
  expect(options).not.toHaveProperty("outputFormat");
});

// Reason: dropping the top-level declaration must preserve nested $schema keys and all other schema data.
test("R22b nested $schema stays unchanged when the top-level key is omitted", async () => {
  const nested = {
    type: "object",
    properties: {
      x: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "string",
      },
    },
    additionalProperties: false,
  };
  const outputSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    ...nested,
  };
  const original = structuredClone(outputSchema);
  expect(await finalOutputFormat(outputSchema)).toEqual({
    type: "json_schema",
    schema: nested,
  });
  expect(outputSchema).toEqual(original);
});

test("acceptance: a review session runs a raw-input tool then resumes for structured final output", async () => {
  const handled: unknown[] = [];
  const tools = ["read", "submit"].map((name) => ({
    name,
    description: name,
    inputSchema: schema,
    hints: {
      readOnly: true,
      destructive: false,
      idempotent: true,
      openWorld: false,
    },
    handle: (input: unknown) =>
      Effect.sync(() => {
        handled.push(input);
        return { text: "test tool result" };
      }),
  }));
  const verify =
    (final: boolean) =>
    (options: import("@anthropic-ai/claude-agent-sdk").Options) => {
      expect(options).toMatchObject({
        pathToClaudeCodeExecutable: "/test/claude",
        env: { CLAUDE_CONFIG_DIR: "/test/config", HOME: "/test/home" },
        cwd: config.cwd,
        tools: [],
        settingSources: [],
        settings: { disableAllHooks: false },
        strictMcpConfig: true,
        skills: [],
        systemPrompt: policy.systemPrompt,
        permissionMode: "default",
        includePartialMessages: true,
        allowedTools: ["mcp__neuve__read", "mcp__neuve__submit"],
        persistSession: true,
        model: "test-model",
        effort: "high",
      });
      expect(options.mcpServers?.neuve).toMatchObject({
        type: "sdk",
        name: "neuve",
        timeout: TOOL_TIMEOUT_MS,
      });
      expect(options.outputFormat).toEqual(
        final ? { type: "json_schema", schema } : undefined,
      );
      expect(final ? options.resume : options.sessionId).toBe(SESSION_ID);
      expect(final ? options.sessionId : options.resume).toBeUndefined();
    };
  await sessionTest(
    [
      out({ type: "query.open", check: verify(false) }),
      offer,
      {
        type: "tool.calls",
        calls: [{ name: "read", callId: "call-1", input: { value: "raw" } }],
        check: (results) =>
          expect(results).toEqual([
            {
              content: [{ type: "text", text: "test tool result" }],
              isError: false,
            },
          ]),
      },
      inbound({
        ...textDelta(""),
        event: {
          type: "message_start" as const,
          message: {
            ...assistant(undefined).message,
            content: [],
            stop_reason: null,
          },
        },
      }),
      inbound(textDelta("delta")),
      inbound(assistant(undefined, "delta")),
      inbound(textDelta("nested", "child")),
      inbound(result({ modelUsage: { "test-model": usage(10) } })),
      close,
      out({ type: "query.open", check: verify(true) }),
      out({ type: "prompt.offer", message: "final" }),
      inbound(
        result({
          structured_output: { value: "ok" },
          modelUsage: { "test-model": usage(15, 4) },
        }),
      ),
      close,
    ],
    (session, reader) =>
      Effect.gen(function* () {
        yield* session.startTurn(normal);
        const first = yield* reader.until("turn.finished");
        expect(first).toMatchObject({ outcome: { status: "completed" } });
        yield* session.startTurn({
          turnId: "final",
          message: "final",
          final: true,
        });
        expect(yield* reader.until("turn.finished")).toMatchObject({
          outcome: { status: "completed", structuredOutput: { value: "ok" } },
        });
        expect(handled).toEqual([{ value: "raw" }]);
        expect(reader.seen.map((event) => event.type)).toEqual([
          "turn.started",
          "tool.started",
          "message.finished",
          "tool.finished",
          "text",
          "message.finished",
          "usage",
          "turn.finished",
          "turn.started",
          "usage",
          "turn.finished",
        ]);
        expect(
          reader.seen
            .filter((event) => event.type === "usage")
            .map((event) => event.usage.input),
        ).toEqual([10, 5]);
      }),
    { ...policy, tools, model: { id: "test-model", effort: "high" } },
  );
});

test("environment: stray keys and parent sessions cannot replace the folder subscription or HOME", () => {
  const parent: Record<string, string> = {
    HOME: "/test/home",
    PATH: "/test/bin",
    CLAUDE_CODE_USE_FUTURE_PROVIDER: "test",
  };
  for (const key of REMOVED_ENVIRONMENT)
    Object.defineProperty(parent, key, {
      enumerable: true,
      get() {
        throw new Error("Credential or parent-session value accessed");
      },
    });
  const env = childEnvironment(parent, account);
  expect(env.CLAUDE_CONFIG_DIR).toBe("/test/config");
  expect(env.HOME).toBe(parent.HOME);
  expect(env.CLAUDE_CODE_USE_FUTURE_PROVIDER).toBeUndefined();
  for (const key of REMOVED_ENVIRONMENT) expect(key in env).toBe(false);
  const defaultAccount = {
    ...account,
    credential: { kind: "claude-config-folder" as const },
  };
  expect(
    childEnvironment(parent, defaultAccount).CLAUDE_CONFIG_DIR,
  ).toBeUndefined();
  expect(env).toMatchObject({
    ENABLE_CLAUDEAI_MCP_SERVERS: "false",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    CLAUDE_CODE_AUTO_CONNECT_IDE: "0",
    CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: "1",
    CLAUDE_AGENT_SDK_CLIENT_APP: "neuve/0.1.0",
  });
});

test("usage: cumulative ledgers become per-model turn totals and absorb a steering abort", async () => {
  await sessionTest(
    [
      open,
      offer,
      inbound(result({ modelUsage: { a: usage(10), b: usage(5) } })),
      out({ type: "prompt.offer", message: "second" }),
      out({ type: "prompt.offer", message: "steer", priority: "now" }),
      inbound(
        result({
          terminal_reason: "aborted_streaming",
          modelUsage: { a: usage(13, 3), b: usage(7, 3) },
        }),
      ),
      inbound(result({ modelUsage: { a: usage(18, 5), b: usage(9, 4) } })),
      close,
    ],
    (session, reader) =>
      Effect.gen(function* () {
        yield* session.startTurn(normal);
        yield* reader.until("turn.finished");
        yield* session.startTurn({ turnId: "two", message: "second" });
        yield* session.steerTurn({ turnId: "two", message: "steer" });
        yield* reader.until("turn.finished");
        expect(
          reader.seen
            .filter((e) => e.type === "usage")
            .map((e) => [e.turnId, e.model, e.usage.input]),
        ).toEqual([
          ["one", "a", 10],
          ["one", "b", 5],
          ["two", "a", 3],
          ["two", "b", 2],
          ["two", "a", 8],
          ["two", "b", 4],
        ]);
        expect(
          reader.seen.filter((e) => e.type === "turn.finished"),
        ).toHaveLength(2);
      }),
  );
});

const failureCases: Array<{
  name: string;
  frames: SDKMessage[];
  expected: unknown;
}> = [
  {
    name: "revoked authentication",
    frames: [
      assistant("authentication_failed", "OAuth token revoked"),
      result({ is_error: true }),
    ],
    expected: { _tag: "AccountRejected", reason: "revoked" },
  },
  {
    name: "expired authentication",
    frames: [
      assistant(
        "authentication_failed",
        "OAuth session expired and could not be refreshed",
      ),
      result({ is_error: true }),
    ],
    expected: { _tag: "AccountRejected", reason: "expired" },
  },
  {
    name: "organization policy code",
    frames: [assistant("oauth_org_not_allowed"), result({ is_error: true })],
    expected: { _tag: "AccountRejected", reason: "organization-not-allowed" },
  },
  {
    name: "organization policy prefix",
    frames: [
      assistant("unknown", "TEST_ORG_LIMIT"),
      result({ is_error: true }),
    ],
    expected: { _tag: "AccountRejected", reason: "organization-not-allowed" },
  },
  {
    name: "account hold",
    frames: [assistant("account_on_hold"), result({ is_error: true })],
    expected: { _tag: "AccountRejected", reason: "account-on-hold" },
  },
  {
    name: "billing",
    frames: [assistant("billing_error"), result({ is_error: true })],
    expected: { _tag: "AccountRejected", reason: "billing" },
  },
  {
    name: "403 verification",
    frames: [
      assistant("verification_required"),
      result({ is_error: true, api_error_status: 403 }),
    ],
    expected: { _tag: "AccountRejected", reason: "other" },
  },
  {
    name: "403 authentication",
    frames: [
      assistant("authentication_failed"),
      result({ is_error: true, api_error_status: 403 }),
    ],
    expected: { _tag: "AccountRejected", reason: "other" },
  },
  {
    name: "sign-in required",
    frames: [assistant("authentication_failed"), result({ is_error: true })],
    expected: { _tag: "SignInRequired" },
  },
  {
    name: "not signed in text",
    frames: [result({ is_error: true, result: "Not logged in" })],
    expected: { _tag: "SignInRequired" },
  },
  {
    name: "usage prefix",
    frames: [result({ is_error: true, result: "TEST_USAGE_LIMIT" })],
    expected: { _tag: "UsageLimitReached" },
  },
  {
    name: "context prompt",
    frames: [result({ terminal_reason: "prompt_too_long" })],
    expected: { _tag: "TurnFailed", reason: "context-overflow" },
  },
  {
    name: "context blocking",
    frames: [result({ terminal_reason: "blocking_limit" })],
    expected: { _tag: "TurnFailed", reason: "context-overflow" },
  },
  {
    name: "turn count",
    frames: [errorResult("error_max_turns")],
    expected: { _tag: "TurnFailed", reason: "turn-limit-reached" },
  },
  {
    name: "startup",
    frames: [
      errorResult("error_during_execution", {
        startup_failure_reason: "cwd_unavailable",
      }),
    ],
    expected: { _tag: "RuntimeUnavailable", reason: "start-failed" },
  },
  {
    name: "turn setup",
    frames: [result({ terminal_reason: "turn_setup_failed" })],
    expected: { _tag: "RuntimeUnavailable", reason: "start-failed" },
  },
  {
    name: "final overload",
    frames: [result({ api_error_status: 529 })],
    expected: { _tag: "TurnFailed", reason: "provider-unavailable" },
  },
  {
    name: "overload code",
    frames: [assistant("overloaded"), errorResult("error_during_execution")],
    expected: { _tag: "TurnFailed", reason: "provider-unavailable" },
  },
  {
    name: "provider failure",
    frames: [errorResult("error_during_execution")],
    expected: { _tag: "TurnFailed", reason: "provider-failed" },
  },
  {
    name: "HTTP 429 without plan evidence",
    frames: [result({ api_error_status: 429 })],
    expected: { _tag: "TurnFailed", reason: "provider-failed" },
  },
  {
    name: "structured retry exhaustion",
    frames: [errorResult("error_max_structured_output_retries")],
    expected: { _tag: "TurnFailed", reason: "structured-output-invalid" },
  },
];
for (const scenario of failureCases)
  test(`failure boundary: ${scenario.name} maps SDK evidence without provider text`, async () => {
    const broken =
      scenario.expected !== null &&
      typeof scenario.expected === "object" &&
      "_tag" in scenario.expected &&
      scenario.expected._tag === "RuntimeUnavailable";
    await sessionTest(
      [open, offer, ...scenario.frames.map(inbound), close],
      (session, reader) =>
        Effect.gen(function* () {
          yield* session.startTurn(normal);
          expect(yield* reader.until("turn.finished")).toMatchObject({
            outcome: {
              status: "failed",
              disposition: broken ? "broken" : "reusable",
              failure: {
                account: account.name,
                ...(scenario.expected as object),
              },
            },
          });
        }),
    );
  });

test("probe: initialization signed-in state closes without ever offering a prompt", async () => {
  for (const [info, state] of [
    [{ tokenSource: "claude.ai", subscriptionType: "test-plan" }, "signed-in"],
    [{ tokenSource: "none" }, "not-signed-in"],
  ] as const) {
    const fake = setup([
      out({
        type: "query.open",
        account: info,
        check: (options) =>
          expect(options).toMatchObject({
            persistSession: false,
            tools: [],
            allowedTools: [],
            settingSources: [],
            mcpServers: {},
            strictMcpConfig: true,
          }),
      }),
      close,
    ]);
    const probe = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* fake.runtime).probe(account);
      }).pipe(Effect.provide(fake.layer), Effect.scoped),
    );
    expect(AccountProbe.parse(probe).signIn.state).toBe(state);
  }
});
for (const mode of ["timeout", "failed"] as const)
  test(`probe: ${mode} is an unknown sign-in state and closes the query`, async () => {
    const fake = setup([
      out({
        type: "query.open",
        ...(mode === "timeout" ? { initNever: true } : { initFail: true }),
      }),
      close,
    ]);
    const probe = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* fake.runtime).probe(account);
      }).pipe(Effect.provide(fake.layer), Effect.scoped),
    );
    expect(probe.signIn).toMatchObject({
      state: "unknown",
      reason: "check-failed",
    });
  });

test("missing executable: probe returns unavailable and session opening fails without SDK fallback", async () => {
  const fake = setup([]);
  const value = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* fake.runtime.pipe(
          Effect.provideService(ClaudeExecutable, {
            resolve: () => Effect.succeed(undefined),
          }),
        );
        const probe = yield* runtime.probe(account);
        const opening = yield* runtime
          .openSession(account, policy)
          .pipe(Effect.flip);
        return { probe, opening };
      }),
    ).pipe(
      Effect.provide(fake.layer),
      Effect.provideService(ClaudeExecutable, {
        resolve: () => Effect.succeed(undefined),
      }),
    ),
  );
  expect(value.probe.signIn).toEqual({
    state: "runtime-unavailable",
    reason: "not-installed",
  });
  expect(value.opening).toMatchObject({
    _tag: "RuntimeUnavailable",
    reason: "not-installed",
  });
});

test("interrupt: closing the query settles one interrupted outcome with the caller's reason", async () => {
  await sessionTest([open, offer, close], (session, reader) =>
    Effect.gen(function* () {
      yield* session.startTurn(normal);
      yield* session.interruptTurn({ turnId: "one", reason: "cutoff" });
      expect(yield* reader.until("turn.finished")).toMatchObject({
        outcome: { status: "interrupted", reason: "cutoff" },
      });
    }),
  );
});

test("child death: an open turn fails broken and the no-error event stream ends", async () => {
  await sessionTest(
    [open, offer, { type: "runtime_exit" }, close],
    (session, reader) =>
      Effect.gen(function* () {
        yield* session.startTurn(normal);
        expect(yield* reader.until("turn.finished")).toMatchObject({
          outcome: { status: "failed", disposition: "broken" },
        });
        expect(
          yield* session.startTurn(normal).pipe(Effect.flip),
        ).toMatchObject({ reason: "session-stopped" });
      }),
  );
});

test("scope: closing the provider scope interrupts its open turn before ending events", async () => {
  const fake = setup([open, offer, close]);
  const events = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* fake.runtime;
        const sessionScope = yield* Scope.make();
        const session = yield* runtime
          .openSession(account, policy)
          .pipe(Effect.provideService(Scope.Scope, sessionScope));
        const collector = yield* Stream.runCollect(session.events).pipe(
          Effect.forkScoped,
        );
        yield* session.startTurn(normal);
        yield* Scope.close(sessionScope, Exit.void);
        return yield* Fiber.join(collector);
      }),
    ).pipe(Effect.provide(fake.layer), Effect.timeout("3 seconds")),
  );
  expect(events.map((event) => RuntimeEvent.parse(event).type)).toEqual([
    "turn.started",
    "turn.finished",
  ]);
  expect(events[1]).toMatchObject({
    outcome: { status: "interrupted", reason: "shutdown" },
  });
});

for (const abort of [false, true])
  test(`approval: ${abort ? "SDK abort denies" : "answer returns raw input"} without a hanging request`, async () => {
    const tools = [
      {
        name: "read",
        description: "read",
        inputSchema: schema,
        hints: {
          readOnly: true,
          destructive: false,
          idempotent: true,
          openWorld: false,
        },
        handle: () => Effect.succeed({ text: "test" }),
      },
    ];
    await sessionTest(
      [
        open,
        offer,
        {
          type: "permission.request",
          tool: "mcp__neuve__read",
          callId: "call-permission",
          input: { value: "raw" },
          abort,
        },
        out({
          type: "permission.response",
          check: (response) =>
            expect(response).toMatchObject(
              abort
                ? { behavior: "deny", interrupt: true }
                : { behavior: "allow", updatedInput: { value: "raw" } },
            ),
        }),
        inbound(result()),
        close,
      ],
      (session, reader) =>
        Effect.gen(function* () {
          yield* session.startTurn(normal);
          if (!abort) {
            const event = yield* reader.until("approval.requested");
            if (event.type !== "approval.requested")
              throw new Error("Wrong event");
            expect(event).toMatchObject({
              toolName: "read",
              callId: "call-permission",
            });
            yield* session.respondToApproval({
              requestId: event.requestId,
              decision: "allow",
            });
          }
          yield* reader.until("turn.finished");
          expect(
            yield* session
              .respondToApproval({ requestId: "unknown", decision: "allow" })
              .pipe(Effect.flip),
          ).toMatchObject({ reason: "previous-turn-active" });
        }),
      { ...policy, approvalPolicy: "ask", tools },
    );
  });

test("tool bridge: simultaneous identical same-name calls retain distinct native ids and unmodified schemas", async () => {
  const calls: Array<{ callId: string; signal: AbortSignal }> = [];
  const tools = [
    {
      name: "read",
      description: "read",
      inputSchema: schema,
      hints: {
        readOnly: true,
        destructive: false,
        idempotent: true,
        openWorld: false,
      },
      handle: () => Effect.succeed({ text: "test" }),
    },
  ];
  await sessionTest(
    [
      open,
      offer,
      {
        type: "tool.calls",
        calls: [
          { name: "read", callId: "first", input: { value: "same" } },
          { name: "read", callId: "second", input: { value: "same" } },
        ],
      },
      inbound(result()),
      close,
    ],
    (session, reader) =>
      Effect.gen(function* () {
        yield* session.startTurn(normal);
        yield* reader.until("turn.finished");
        expect(
          reader.seen
            .filter((e) => e.type === "tool.started")
            .map((e) => e.callId),
        ).toEqual(["first", "second"]);
        expect(
          reader.seen
            .filter((e) => e.type === "tool.finished")
            .map((e) => e.callId),
        ).toEqual(["first", "second"]);
      }),
    { ...policy, tools },
    {
      handleTool: (definition, input, context) =>
        Effect.sync(() => {
          calls.push(context);
        }).pipe(Effect.andThen(definition.handle(input))),
    },
  );
  expect(calls.map((call) => call.callId)).toEqual(["first", "second"]);
  expect(calls.every((call) => call.signal.aborted)).toBe(true);
});

test("sign-out: only Claude's own logout receives the account folder", async () => {
  const fake = setup([]);
  const calls: unknown[] = [];
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* (yield* fake.runtime.pipe(
          Effect.provideService(ClaudeProcess, {
            run: (command, env) =>
              Effect.sync(() => {
                calls.push({ command, env });
              }),
          }),
        )).signOut(account);
      }),
    ).pipe(
      Effect.provide(fake.layer),
      Effect.provideService(ClaudeProcess, {
        run: (command, env) =>
          Effect.sync(() => {
            calls.push({ command, env });
          }),
      }),
    ),
  );
  expect(calls).toEqual([
    {
      command: ["/test/claude", "auth", "logout"],
      env: childEnvironment(config.environment, account),
    },
  ]);
});

for (const [rateLimitType, window, model] of [
  ["five_hour", "five-hour"],
  ["seven_day", "weekly"],
  ["seven_day_opus", "weekly-model", "opus"],
  ["seven_day_sonnet", "weekly-model", "sonnet"],
  ["overage", "overage"],
  ["seven_day_overage_included", "overage"],
  [undefined, "other"],
] as const)
  test(`rate-limit boundary: ${rateLimitType ?? "unknown"} preserves units, reset and model`, async () => {
    const info = {
      status: "allowed_warning" as const,
      ...(rateLimitType === undefined ? {} : { rateLimitType }),
      utilization: 1.3,
      resetsAt: 1_800_000_000,
    };
    await sessionTest(
      [
        open,
        offer,
        inbound({
          type: "rate_limit_event",
          rate_limit_info: info,
          uuid: crypto.randomUUID(),
          session_id: SESSION_ID,
        }),
        inbound(result()),
        close,
      ],
      (session, reader) =>
        Effect.gen(function* () {
          yield* session.startTurn(normal);
          yield* reader.until("turn.finished");
          const event = reader.seen.find((e) => e.type === "rate-limit");
          expect(event).toMatchObject({
            window,
            status: "warning",
            utilization: 1,
            resetsAt: new Date(1_800_000_000_000).toISOString(),
          });
          if (event?.type !== "rate-limit")
            throw new Error("Missing rate-limit event");
          expect(event.model).toBe(model);
        }),
    );
  });
for (const overage of [
  undefined,
  "isUsingOverage",
  "overageInUse",
  "overageStatus",
] as const)
  test(`rate-limit boundary: rejected ${overage ?? "without overage"} maps the whole plan-limit predicate`, async () => {
    const rate_limit_info = {
      status: "rejected" as const,
      rateLimitType: "five_hour" as const,
      ...(overage === "overageStatus"
        ? { overageStatus: "allowed_warning" as const }
        : overage === undefined
          ? {}
          : { [overage]: true }),
    };
    await sessionTest(
      [
        open,
        offer,
        inbound({
          type: "rate_limit_event",
          rate_limit_info,
          uuid: crypto.randomUUID(),
          session_id: SESSION_ID,
        }),
        inbound(
          result({
            terminal_reason: "blocking_limit",
            api_error_status: 429,
            is_error: true,
          }),
        ),
        close,
      ],
      (session, reader) =>
        Effect.gen(function* () {
          yield* session.startTurn(normal);
          expect(yield* reader.until("turn.finished")).toMatchObject({
            outcome: {
              status: "failed",
              failure:
                overage === undefined
                  ? { _tag: "UsageLimitReached", window: "five-hour" }
                  : { _tag: "TurnFailed", reason: "provider-failed" },
            },
          });
        }),
    );
  });

test("rate-limit boundary: defensively reads the repeated undeclared assistant payload", async () => {
  const frame = {
    ...assistant("rate_limit"),
    api_error_params: {
      rate_limit_info: { status: "rejected", rateLimitType: "seven_day" },
    },
  };
  await sessionTest(
    [
      open,
      offer,
      inbound(frame),
      inbound(result({ terminal_reason: "api_error", api_error_status: 429 })),
      close,
    ],
    (session, reader) =>
      Effect.gen(function* () {
        yield* session.startTurn(normal);
        expect(yield* reader.until("turn.finished")).toMatchObject({
          outcome: { failure: { _tag: "UsageLimitReached", window: "weekly" } },
        });
      }),
  );
});

test("retries: api_retry reaches the contract and recovered overload still completes", async () => {
  await sessionTest(
    [
      open,
      offer,
      inbound({
        type: "system",
        subtype: "api_retry",
        attempt: 1,
        max_retries: 10,
        retry_delay_ms: 100,
        error_status: 529,
        error: "overloaded",
        uuid: crypto.randomUUID(),
        session_id: SESSION_ID,
      }),
      inbound(result()),
      close,
    ],
    (session, reader) =>
      Effect.gen(function* () {
        yield* session.startTurn(normal);
        expect(yield* reader.until("turn.finished")).toMatchObject({
          outcome: { status: "completed" },
        });
        expect(
          reader.seen.find((event) => event.type === "retry"),
        ).toMatchObject({
          attempt: 1,
          maxAttempts: 10,
          delayMs: 100,
          httpStatus: 529,
        });
      }),
  );
});

test("refresh lock: retry only the initial server_error once before tools or output", async () => {
  const locked = assistant(
    "server_error",
    "another Claude Code process is refreshing it",
  );
  const retried = {
    ...locked,
    uuid: crypto.randomUUID(),
    message: { ...locked.message, id: "retry-message" },
  };
  await sessionTest(
    [
      open,
      offer,
      inbound(locked),
      inbound(errorResult("error_during_execution")),
      offer,
      inbound(retried),
      inbound(errorResult("error_during_execution")),
      close,
    ],
    (session, reader) =>
      Effect.gen(function* () {
        yield* session.startTurn(normal);
        expect(yield* reader.until("turn.finished")).toMatchObject({
          outcome: { status: "failed", failure: { reason: "provider-failed" } },
        });
        expect(
          reader.seen.filter((e) => e.type === "turn.started"),
        ).toHaveLength(1);
      }),
  );
});

test("refresh lock: a response delta prevents replaying a turn with visible progress", async () => {
  await sessionTest(
    [
      open,
      offer,
      inbound(textDelta("progress")),
      inbound(
        assistant(
          "server_error",
          "another Claude Code process is refreshing it",
        ),
      ),
      inbound(errorResult("error_during_execution")),
      close,
    ],
    (session, reader) =>
      Effect.gen(function* () {
        yield* session.startTurn(normal);
        yield* reader.until("turn.finished");
      }),
  );
});

for (const structured of [undefined, { value: "ok" }])
  test(`final boundary: ${structured === undefined ? "missing output fails" : "normal turns never expose structured output"}`, async () => {
    const entries =
      structured === undefined
        ? [open, close, open, offer, inbound(result()), close]
        : [
            open,
            offer,
            inbound(result({ structured_output: structured })),
            close,
          ];
    await sessionTest(entries, (session, reader) =>
      Effect.gen(function* () {
        yield* session.startTurn({
          ...normal,
          ...(structured === undefined ? { final: true } : {}),
        });
        const event = yield* reader.until("turn.finished");
        expect(event).toMatchObject({
          outcome:
            structured === undefined
              ? {
                  status: "failed",
                  failure: { reason: "structured-output-missing" },
                }
              : { status: "completed" },
        });
        if (
          event.type === "turn.finished" &&
          event.outcome.status === "completed"
        )
          expect(event.outcome.structuredOutput).toBeUndefined();
      }),
    );
  });

test("turn admission: active turns and schema-free finals fail before another prompt is sent", async () => {
  await sessionTest(
    [open, offer, close],
    (session) =>
      Effect.gen(function* () {
        expect(
          yield* session
            .startTurn({ ...normal, final: true })
            .pipe(Effect.flip),
        ).toMatchObject({ reason: "no-output-schema" });
        yield* session.startTurn(normal);
        expect(
          yield* session
            .startTurn({ turnId: "two", message: "overlap" })
            .pipe(Effect.flip),
        ).toMatchObject({ reason: "previous-turn-active" });
        expect(
          yield* session
            .steerTurn({ turnId: "wrong", message: "late" })
            .pipe(Effect.flip),
        ).toMatchObject({ reason: "previous-turn-active" });
      }),
    { ...policy, outputSchema: undefined },
  );
});

test("interrupt: a query with no result closes and finishes interrupted exactly once", async () => {
  await sessionTest([open, offer, close], (session, reader) =>
    Effect.gen(function* () {
      yield* session.startTurn(normal);
      yield* session.interruptTurn({ turnId: "one", reason: "deadline" });
      expect(yield* reader.until("turn.finished")).toMatchObject({
        outcome: { status: "interrupted", reason: "deadline" },
      });
      expect(
        reader.seen.filter((e) => e.type === "turn.finished"),
      ).toHaveLength(1);
    }),
  );
});

test("stream failure: provider death finishes broken without exposing an event error channel", async () => {
  await sessionTest(
    [open, offer, { type: "stream_failure" }, close],
    (session, reader) =>
      Effect.gen(function* () {
        yield* session.startTurn(normal);
        expect(yield* reader.until("turn.finished")).toMatchObject({
          outcome: {
            status: "failed",
            disposition: "broken",
            failure: { reason: "provider-failed" },
          },
        });
      }),
  );
});

test("protocol boundary: malformed result cannot silently finish completed", async () => {
  const malformed = {
    ...result(),
    modelUsage: { broken: { ...usage(1), inputTokens: -1 } },
  };
  await sessionTest(
    [open, offer, inbound(malformed), close],
    (session, reader) =>
      Effect.gen(function* () {
        yield* session.startTurn(normal);
        expect(yield* reader.until("turn.finished")).toMatchObject({
          outcome: {
            status: "failed",
            disposition: "broken",
            failure: { reason: "protocol-error" },
          },
        });
      }),
  );
});

test("resume and model control: internal options preserve the exact SDK identities and running setModel", async () => {
  const identity = {
    resume: SESSION_ID,
    resumeSessionAt: "00000000-0000-4000-8000-000000000002",
    forkSession: true,
    sessionId: "00000000-0000-4000-8000-000000000003",
  };
  const fake = setup(
    [
      out({
        type: "query.open",
        check: (options) => expect(options).toMatchObject(identity),
      }),
      out({ type: "query.set_model", model: "test-model" }),
      out({ type: "query.flags", effortLevel: "high" }),
      close,
    ],
    { identity, usageBaseline: new Map() },
  );
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* fake.runtime;
        const session = yield* runtime.openSession(account, policy);
        yield* session.setModel({ id: "test-model", effort: "high" });
      }),
    ).pipe(Effect.provide(fake.layer)),
  );
});

test("unsupported account: capabilities, open and probe reject an API account without touching SDK", async () => {
  const fake = setup([]);
  const api = Account.parse({
    name: "api",
    kind: "anthropic-api-key",
    runtime: "claude-code",
    credential: { kind: "environment", variable: "TEST_KEY" },
  });
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* fake.runtime;
        for (const operation of [
          runtime.capabilities(api).pipe(Effect.asVoid),
          runtime.probe(api).pipe(Effect.asVoid),
          runtime.openSession(api, policy).pipe(Effect.asVoid),
        ])
          expect(yield* operation.pipe(Effect.flip)).toMatchObject({
            _tag: "RuntimeUnavailable",
            reason: "not-registered",
          });
        yield* runtime.signOut(api);
      }),
    ).pipe(Effect.provide(fake.layer)),
  );
});

test("usage: explicit cache lifetimes and thinking retain their non-regressing baseline", async () => {
  const first = {
    ...usage(20, 9),
    cacheCreationInputTokens: 10,
    cacheCreationEphemeral5mInputTokens: 3,
    cacheCreationEphemeral1hInputTokens: 7,
    thinkingTokens: 4,
  };
  const second = {
    ...usage(2, 1),
    cacheCreationInputTokens: 2,
    cacheCreationEphemeral5mInputTokens: 1,
    cacheCreationEphemeral1hInputTokens: 1,
    thinkingTokens: 1,
  };
  await sessionTest(
    [
      open,
      offer,
      inbound(result({ modelUsage: { a: first } })),
      out({ type: "prompt.offer", message: "second" }),
      inbound(result({ modelUsage: { a: second } })),
      close,
    ],
    (session, reader) =>
      Effect.gen(function* () {
        yield* session.startTurn(normal);
        yield* reader.until("turn.finished");
        yield* session.startTurn({ turnId: "two", message: "second" });
        yield* reader.until("turn.finished");
        expect(
          reader.seen.filter((e) => e.type === "usage").map((e) => e.usage),
        ).toEqual([
          {
            input: 20,
            output: 9,
            cacheRead: 3,
            cacheWrite5m: 3,
            cacheWrite1h: 7,
            thinking: 4,
          },
        ]);
      }),
  );
});

test("steering while a tool is pending: prompt offer proceeds and the tool result completes before the result frame", async () => {
  const gate = yieldDeferred();
  const tools = [
    {
      name: "read",
      description: "read",
      inputSchema: schema,
      hints: {
        readOnly: true,
        destructive: false,
        idempotent: true,
        openWorld: false,
      },
      handle: () =>
        Effect.promise(() => gate.promise).pipe(Effect.as({ text: "test" })),
    },
  ];
  await sessionTest(
    [
      open,
      offer,
      {
        type: "tool.calls",
        calls: [{ name: "read", callId: "pending", input: { value: "test" } }],
      },
      out({ type: "prompt.offer", message: "steer", priority: "now" }),
      inbound(result({ terminal_reason: "aborted_tools" })),
      inbound(result()),
      close,
    ],
    (session, reader) =>
      Effect.gen(function* () {
        yield* session.startTurn(normal);
        yield* reader.until("tool.started");
        yield* session.steerTurn({ turnId: "one", message: "steer" });
        gate.resolve();
        yield* reader.until("turn.finished");
        expect(reader.seen.map((e) => e.type)).toEqual([
          "turn.started",
          "tool.started",
          "message.finished",
          "tool.finished",
          "turn.finished",
        ]);
      }),
    { ...policy, tools },
  );
});
function yieldDeferred() {
  return Promise.withResolvers<void>();
}

test("interrupting pending tools: handler finalization completes before turn.finished", async () => {
  let finalized = false;
  const tools = [
    {
      name: "read",
      description: "read",
      inputSchema: schema,
      hints: {
        readOnly: true,
        destructive: false,
        idempotent: true,
        openWorld: false,
      },
      handle: () =>
        Effect.never.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              finalized = true;
            }),
          ),
        ),
    },
  ];
  await sessionTest(
    [
      open,
      offer,
      {
        type: "tool.calls",
        calls: [{ name: "read", callId: "pending", input: { value: "test" } }],
      },
      close,
    ],
    (session, reader) =>
      Effect.gen(function* () {
        yield* session.startTurn(normal);
        yield* reader.until("tool.started");
        yield* session.interruptTurn({ turnId: "one", reason: "stop" });
        expect(yield* reader.until("turn.finished")).toMatchObject({
          outcome: { status: "interrupted", reason: "stop" },
        });
        expect(finalized).toBe(true);
        expect(reader.seen.map((e) => e.type)).toEqual([
          "turn.started",
          "tool.started",
          "message.finished",
          "usage",
          "tool.finished",
          "turn.finished",
        ]);
      }),
    { ...policy, tools },
  );
});

test("scope closing with approval pending: denial resolves the callback and the event stream ends", async () => {
  const tools = [
    {
      name: "read",
      description: "read",
      inputSchema: schema,
      hints: {
        readOnly: true,
        destructive: false,
        idempotent: true,
        openWorld: false,
      },
      handle: () => Effect.succeed({ text: "test" }),
    },
  ];
  const fake = setup([
    open,
    offer,
    {
      type: "permission.request",
      tool: "mcp__neuve__read",
      callId: "pending",
      input: { value: "test" },
    },
    out({
      type: "permission.response",
      check: (response) =>
        expect(response).toMatchObject({ behavior: "deny", interrupt: true }),
    }),
    close,
  ]);
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* fake.runtime;
        const providerScope = yield* Scope.make();
        const session = yield* runtime
          .openSession(account, { ...policy, approvalPolicy: "ask", tools })
          .pipe(Effect.provideService(Scope.Scope, providerScope));
        const reader = yield* eventReader(session);
        yield* session.startTurn(normal);
        yield* reader.until("approval.requested");
        yield* Scope.close(providerScope, Exit.void);
        expect(yield* reader.until("turn.finished")).toMatchObject({
          outcome: { status: "interrupted" },
        });
      }),
    ).pipe(Effect.provide(fake.layer), Effect.timeout("3 seconds")),
  );
});

test("normal turn after a final: structured output is removed by another scoped resume", async () => {
  await sessionTest(
    [
      open,
      close,
      out({
        type: "query.open",
        check: (options) => expect(options.outputFormat).toBeDefined(),
      }),
      offer,
      inbound(result({ structured_output: { value: "ok" } })),
      close,
      out({
        type: "query.open",
        check: (options) => expect(options.outputFormat).toBeUndefined(),
      }),
      out({ type: "prompt.offer", message: "normal again" }),
      inbound(result()),
      close,
    ],
    (session, reader) =>
      Effect.gen(function* () {
        yield* session.startTurn({ ...normal, final: true });
        yield* reader.until("turn.finished");
        yield* session.startTurn({ turnId: "two", message: "normal again" });
        expect(yield* reader.until("turn.finished")).toMatchObject({
          outcome: { status: "completed" },
        });
      }),
  );
});

test("child death with approval pending: the response is denied before the broken outcome", async () => {
  const tools = [
    {
      name: "read",
      description: "read",
      inputSchema: schema,
      hints: {
        readOnly: true,
        destructive: false,
        idempotent: true,
        openWorld: false,
      },
      handle: () => Effect.succeed({ text: "test" }),
    },
  ];
  await sessionTest(
    [
      open,
      offer,
      {
        type: "permission.request",
        tool: "mcp__neuve__read",
        callId: "pending",
        input: { value: "test" },
      },
      { type: "runtime_exit" },
      out({
        type: "permission.response",
        check: (response) =>
          expect(response).toMatchObject({ behavior: "deny", interrupt: true }),
      }),
      close,
    ],
    (session, reader) =>
      Effect.gen(function* () {
        yield* session.startTurn(normal);
        expect(yield* reader.until("turn.finished")).toMatchObject({
          outcome: { status: "failed", disposition: "broken" },
        });
      }),
    { ...policy, approvalPolicy: "ask", tools },
  );
});

test("resume accounting: caller baseline excludes history from the first resumed turn", async () => {
  const fake = setup(
    [open, offer, inbound(result({ modelUsage: { a: usage(25, 8) } })), close],
    {
      identity: { resume: SESSION_ID },
      usageBaseline: new Map([
        [
          "a",
          {
            input: 20,
            output: 5,
            cacheRead: 3,
            cacheWrite5m: 4,
            cacheWrite1h: 0,
          },
        ],
      ]),
    },
  );
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* (yield* fake.runtime).openSession(
          account,
          policy,
        );
        const reader = yield* eventReader(session);
        yield* session.startTurn(normal);
        yield* reader.until("turn.finished");
        const continuation = yield* session.continuation;
        expect(continuation.sessionId).toBe(SESSION_ID);
        expect(continuation.usageBaseline.get("a")?.input).toBe(25);
        expect(
          reader.seen.filter((e) => e.type === "usage").map((e) => e.usage),
        ).toEqual([
          {
            input: 5,
            output: 3,
            cacheRead: 0,
            cacheWrite5m: 0,
            cacheWrite1h: 0,
          },
        ]);
      }),
    ).pipe(Effect.provide(fake.layer)),
  );
});

test("resume accounting: public resume opens without a prior ledger", async () => {
  const fake = setup([open, close], { identity: { resume: SESSION_ID } });
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* fake.runtime;
        const session = yield* runtime.openSession(account, policy);
        expect(session.nativeSessionId).toBe(SESSION_ID);
      }),
    ).pipe(Effect.provide(fake.layer)),
  );
});

test("initialization failure: a failed child is closed before openSession returns start-failed", async () => {
  const fake = setup([out({ type: "query.open", initFail: true }), close]);
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* fake.runtime;
        expect(
          yield* runtime.openSession(account, policy).pipe(Effect.flip),
        ).toMatchObject({ _tag: "RuntimeUnavailable", reason: "start-failed" });
      }),
    ).pipe(Effect.provide(fake.layer)),
  );
});

test("overload fallback: the first non-diagnostic provider error maps repeated 529 after retries", async () => {
  await sessionTest(
    [
      open,
      offer,
      inbound(
        errorResult("error_during_execution", {
          errors: [
            "[ede_diagnostic] ignore",
            "API Error: Repeated 529 Overloaded errors.",
          ],
        }),
      ),
      close,
    ],
    (session, reader) =>
      Effect.gen(function* () {
        yield* session.startTurn(normal);
        expect(yield* reader.until("turn.finished")).toMatchObject({
          outcome: {
            status: "failed",
            failure: { reason: "provider-unavailable" },
            disposition: "reusable",
          },
        });
      }),
  );
});

test("approval denial: the caller's denial reaches the SDK and cannot be answered twice", async () => {
  const tools = [
    {
      name: "read",
      description: "read",
      inputSchema: schema,
      hints: {
        readOnly: true,
        destructive: false,
        idempotent: true,
        openWorld: false,
      },
      handle: () => Effect.succeed({ text: "test" }),
    },
  ];
  await sessionTest(
    [
      open,
      offer,
      {
        type: "permission.request",
        tool: "mcp__neuve__read",
        callId: "denied",
        input: { value: "test" },
      },
      out({
        type: "permission.response",
        check: (response) =>
          expect(response).toEqual({
            behavior: "deny",
            message: "test denial",
          }),
      }),
      inbound(result()),
      close,
    ],
    (session, reader) =>
      Effect.gen(function* () {
        yield* session.startTurn(normal);
        const event = yield* reader.until("approval.requested");
        if (event.type !== "approval.requested")
          throw new Error("Missing approval");
        yield* session.respondToApproval({
          requestId: event.requestId,
          decision: "deny",
          message: "test denial",
        });
        expect(
          yield* session
            .respondToApproval({
              requestId: event.requestId,
              decision: "allow",
            })
            .pipe(Effect.flip),
        ).toMatchObject({ reason: "previous-turn-active" });
        yield* reader.until("turn.finished");
      }),
    { ...policy, approvalPolicy: "ask", tools },
  );
});

test("sign-in text fallback: root text without an error code is never inspected", async () => {
  await sessionTest(
    [
      open,
      offer,
      inbound(assistant(undefined, "Not logged in")),
      inbound(result({ is_error: true })),
      close,
    ],
    (session, reader) =>
      Effect.gen(function* () {
        yield* session.startTurn(normal);
        expect(yield* reader.until("turn.finished")).toMatchObject({
          outcome: {
            failure: { _tag: "TurnFailed", reason: "provider-failed" },
          },
        });
      }),
  );
});
