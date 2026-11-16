import { expect, test } from "bun:test";
import type {
  Options,
  SDKAssistantMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  Account,
  RuntimeEvent,
  TurnLimit,
  RuntimeRegistry,
  runtimeRegistryLayer,
  inMemoryAccountDirectoryLayer,
  type SessionPolicy,
  type ToolDefinition,
  type ToolOutcome,
} from "@neuve/runtime";
import { Effect, Exit, Fiber, Layer, Queue, Scope, Stream } from "effect";
import { TestClock } from "effect/testing";
import { makeRuntime } from "../src/runtime.ts";
import { ClaudeExecutable, ClaudeProcess, ClaudeSdk } from "../src/services.ts";
import { TOOL_USE_ID_META } from "../src/tools.ts";
import { assistant, result, SESSION_ID } from "./frames.ts";

const parsed = Account.parse({
  name: "test",
  kind: "claude-subscription",
  runtime: "claude-code",
  credential: { kind: "claude-config-folder" },
});
if (parsed.kind !== "claude-subscription") throw new Error("fixture");
const account = parsed;
const policy: SessionPolicy = {
  systemPrompt: "fixture",
  tools: [],
  approvalPolicy: "allow",
  turnLimit: TurnLimit.parse(8),
};
const partial = (
  event: SDKPartialAssistantMessage["event"],
): SDKPartialAssistantMessage => ({
  type: "stream_event",
  parent_tool_use_id: null,
  uuid: crypto.randomUUID(),
  session_id: SESSION_ID,
  event,
});
const begin = (id = "message-1", input = 11) => {
  const message = assistant(undefined).message;
  return partial({
    type: "message_start",
    message: {
      ...message,
      id,
      content: [],
      stop_reason: null,
      usage: {
        ...message.usage,
        input_tokens: input,
        output_tokens: 0,
        output_tokens_details: null,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 4,
        cache_creation: {
          ephemeral_5m_input_tokens: 1,
          ephemeral_1h_input_tokens: 3,
        },
      },
    },
  });
};
const end = (
  reason:
    | "end_turn"
    | "tool_use"
    | "max_tokens"
    | "refusal"
    | "stop_sequence" = "end_turn",
  output = 7,
) =>
  partial({
    type: "message_delta",
    context_management: null,
    delta: {
      stop_reason: reason,
      stop_sequence: null,
      container: null,
      stop_details: null,
    },
    usage: {
      input_tokens: null,
      cache_read_input_tokens: null,
      cache_creation_input_tokens: null,
      output_tokens: output,
      output_tokens_details: null,
      fallback_credit: null,
      iterations: null,
      server_tool_use: null,
    },
  });
const stop = () => partial({ type: "message_stop" });
const blockMessage = (
  id: string,
  uuid: SDKAssistantMessage["uuid"],
  calls: Array<{ id: string; name: string; input: unknown }> = [],
) => {
  const frame = assistant(undefined);
  frame.message.id = id;
  frame.message.stop_reason = null;
  frame.uuid = uuid;
  frame.message.content = calls.length
    ? calls.map((call) => ({ type: "tool_use", ...call }))
    : [{ type: "text", text: "fixture", citations: [] }];
  return frame;
};
const definition = (handle: ToolDefinition["handle"]): ToolDefinition => ({
  name: "work",
  description: "fixture",
  inputSchema: { type: "object" },
  hints: {
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: false,
  },
  handle,
});

const fixture = Effect.gen(function* () {
  const children: Array<{
    options: Options;
    frames: Queue.Queue<SDKMessage>;
    closed: boolean;
    closeWait: Promise<void>;
  }> = [];
  const sends: SDKUserMessage[] = [];
  const layer = Layer.mergeAll(
    Layer.succeed(ClaudeExecutable, {
      resolve: () => Effect.succeed("/test/claude"),
    }),
    Layer.succeed(ClaudeProcess, {
      run: () => Effect.die("No process allowed"),
    }),
    Layer.succeed(ClaudeSdk, {
      prefixes: { usage: [], organization: [] },
      open: (options) =>
        Effect.gen(function* () {
          const child = {
            options,
            frames: yield* Queue.unbounded<SDKMessage>(),
            closed: false,
            closeWait: Promise.resolve(),
          };
          children.push(child);
          const close = Effect.sync(() => {
            child.closed = true;
          }).pipe(
            Effect.andThen(Effect.promise(() => child.closeWait)),
            Effect.andThen(Queue.shutdown(child.frames)),
          );
          yield* Effect.addFinalizer(() => close);
          return {
            messages: Stream.fromQueue(child.frames),
            close,
            offer: (message: SDKUserMessage) =>
              Effect.sync(() => {
                sends.push(message);
              }),
            interrupt: Effect.die("Stop must close"),
            setModel: () => Effect.void,
            applyFlagSettings: () => Effect.void,
            initializationResult: Effect.succeed({ account: {} }),
          };
        }),
    }),
  );
  const runtime = yield* makeRuntime({
    cwd: "/test",
    environment: {},
    interruptTimeoutMs: 100,
  }).pipe(Effect.provide(layer));
  const sessionScope = yield* Scope.fork(yield* Effect.scope);
  return {
    sessionScope,
    children,
    sends,
    runtime,
  };
});
type Fixture = Effect.Success<typeof fixture>;
function run(
  body: (
    f: Fixture,
    s: Effect.Success<ReturnType<Fixture["runtime"]["openSession"]>>,
    events: RuntimeEvent[],
    next: (type: RuntimeEvent["type"]) => Effect.Effect<RuntimeEvent>,
  ) => Effect.Effect<void, unknown, import("effect").Scope.Scope>,
  options: {
    policy?: SessionPolicy;
    testClock?: boolean;
    onEvent?: (event: RuntimeEvent) => void;
  } = {},
) {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const s = yield* f.runtime
          .openSession(account, options.policy ?? policy, { kind: "new" })
          .pipe(Effect.provideService(Scope.Scope, f.sessionScope));
        const events: RuntimeEvent[] = [];
        const queue = yield* Queue.unbounded<RuntimeEvent>();
        yield* Stream.runForEach(s.events, (event) =>
          Effect.sync(() => {
            RuntimeEvent.parse(event);
            options.onEvent?.(event);
            events.push(event);
            Queue.offerUnsafe(queue, event);
          }),
        ).pipe(Effect.forkScoped);
        const next = (
          type: RuntimeEvent["type"],
        ): Effect.Effect<RuntimeEvent> =>
          Effect.gen(function* () {
            while (true) {
              const event = yield* Queue.take(queue);
              if (event.type === type) return event;
            }
          });
        yield* body(f, s, events, next);
      }),
    ).pipe(
      (program) =>
        options.testClock
          ? program.pipe(Effect.provide(TestClock.layer()))
          : program,
      Effect.timeout("3 seconds"),
    ),
  );
}
const send = (f: Fixture, frames: SDKMessage[]) =>
  Effect.forEach(
    frames,
    (frame) => Queue.offer(f.children.at(-1)!.frames, frame),
    { discard: true },
  );
const connect = (f: Fixture) =>
  Effect.gen(function* () {
    const server = f.children.at(-1)!.options.mcpServers?.neuve;
    if (server?.type !== "sdk") throw new Error("fixture");
    const client = new Client({ name: "fixture", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    yield* Effect.promise(() =>
      Promise.all([client.connect(a), server.instance.connect(b)]),
    );
    yield* Effect.addFinalizer(() => Effect.promise(() => client.close()));
    return client;
  });
const start = { turnId: "one", message: "fixture" };
const chain = "00000000-0000-4000-8000-000000000011";
const lastChain = "00000000-0000-4000-8000-000000000012";

const barrier = (f: Fixture) =>
  send(f, [
    {
      type: "rate_limit_event",
      session_id: SESSION_ID,
      uuid: crypto.randomUUID(),
      rate_limit_info: { status: "allowed" },
    },
  ]);

const callFrame = (id = "call-1") =>
  blockMessage("message-1", chain, [
    { id, name: "mcp__neuve__work", input: {} },
  ]);
const carrier = (id = "call-1"): SDKMessage => ({
  type: "user",
  parent_tool_use_id: null,
  uuid: lastChain,
  session_id: SESSION_ID,
  message: {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: id, content: "fixture" }],
  },
});
const invoke = (client: Client, callId = "call-1") =>
  Effect.promise(() =>
    client.callTool(
      {
        name: "work",
        arguments: {},
        _meta: { [TOOL_USE_ID_META]: callId },
      },
      undefined,
      { timeout: 2147483647 },
    ),
  );
const permission = (f: Fixture, signal = new AbortController().signal) =>
  Effect.promise(() =>
    f.children[0]!.options.canUseTool!(
      "mcp__neuve__work",
      {},
      {
        signal,
        toolUseID: "call-1",
        requestId: "fixture",
      },
    ),
  );
const publishCall = (
  f: Fixture,
  next: (type: RuntimeEvent["type"]) => Effect.Effect<RuntimeEvent>,
) =>
  send(f, [begin(), callFrame(), end("tool_use"), stop()]).pipe(
    Effect.andThen(next("message.finished")),
  );
const finishedCalls = (events: RuntimeEvent[]) =>
  events.filter((e) => e.type === "tool.finished");
const expectBalanced = (events: RuntimeEvent[], duration: boolean) => {
  expect(events.filter((e) => e.type === "tool.started")).toHaveLength(1);
  expect(finishedCalls(events)).toHaveLength(1);
  const event = finishedCalls(events)[0]!;
  expect(event).toMatchObject({
    callId: "call-1",
    toolName: "work",
    errored: true,
  });
  expect(event.durationMs !== undefined).toBe(duration);
  const endIndex = events.findIndex((e) => e.type === "turn.finished");
  expect(endIndex).toBeGreaterThan(events.indexOf(event));
};

// A fork through the registry must read the current SDK identity rather than its open-time copy.
test("R13 registry native id follows fork init and conversation reset", () =>
  run((f, _s, _events, _next) =>
    Effect.gen(function* () {
      const registry = yield* RuntimeRegistry.pipe(
        Effect.provide(
          runtimeRegistryLayer([f.runtime]).pipe(
            Layer.provide(inMemoryAccountDirectoryLayer([account])),
          ),
        ),
      );
      const s = yield* registry.openSession(account.name, policy, {
        kind: "resume",
        session: SESSION_ID,
        at: chain,
        fork: true,
      });
      expect(s.nativeSessionId).not.toBe(SESSION_ID);
      expect(f.children.at(-1)!.options.sessionId).toBe(s.nativeSessionId);
      const events = yield* Queue.unbounded<RuntimeEvent>();
      yield* Stream.runForEach(s.events, (e) => Queue.offer(events, e)).pipe(
        Effect.forkScoped,
      );
      const frames = f.children.at(-1)!.frames;
      yield* s.startTurn(start);
      yield* Queue.offer(frames, {
        type: "system",
        subtype: "init",
        session_id: chain,
        uuid: crypto.randomUUID(),
        apiKeySource: "none",
        claude_code_version: "fixture",
        cwd: "/test",
        tools: [],
        mcp_servers: [],
        model: "test-model",
        permissionMode: "default",
        slash_commands: [],
        output_style: "default",
        skills: [],
        plugins: [],
      });
      yield* Queue.offer(frames, result());
      while ((yield* Queue.take(events)).type !== "turn.finished") {}
      expect(s.nativeSessionId).toBe(chain);
      yield* s.startTurn({ turnId: "two", message: "fixture" });
      yield* Queue.offer(frames, {
        type: "conversation_reset",
        new_conversation_id: lastChain,
        session_id: lastChain,
        uuid: crypto.randomUUID(),
        trigger: "clear",
      });
      yield* Queue.offer(frames, result());
      while ((yield* Queue.take(events)).type !== "turn.finished") {}
      expect(s.nativeSessionId).toBe(lastChain);
    }),
  ));

// The public turn point must preserve tool results and agree with continuation and query reopen.
for (const final of [false, true]) {
  test(`R13 carrier resumePoint is public, final=${final}`, () =>
    run(
      (f, s, events, next) =>
        Effect.gen(function* () {
          yield* s.startTurn({ ...start, ...(final ? { final: true } : {}) });
          const client = yield* connect(f);
          if (!final) {
            yield* publishCall(f, next);
            yield* invoke(client);
          } else {
            const frame = blockMessage("message-1", chain);
            frame.message.content = [
              {
                type: "tool_use",
                id: "call-1",
                name: "StructuredOutput",
                input: {},
              },
            ];
            yield* send(f, [begin(), frame, end("tool_use"), stop()]);
            yield* next("message.finished");
          }
          yield* send(f, [
            carrier(),
            result(final ? { structured_output: {} } : {}),
          ]);
          expect(yield* next("turn.finished")).toMatchObject({
            resumePoint: lastChain,
            outcome: { status: "completed" },
          });
          expect((yield* s.continuation).resumePoint).toBe(lastChain);
          expect(
            events
              .filter((e) => e.type === "message.finished")
              .map((e) => e.resumePoint),
          ).toEqual([chain]);
          yield* s.startTurn({
            turnId: "two",
            message: "fixture",
            ...(!final ? { final: true } : {}),
          });
          expect(f.children.at(-1)!.options.resumeSessionAt).toBe(lastChain);
        }),
      {
        policy: {
          ...policy,
          outputSchema: { type: "object" },
          tools: [
            definition(() =>
              Effect.succeed({ text: "fixture", endTurn: true }),
            ),
          ],
        },
      },
    ));
}

// A trailing assistant supersedes the carrier; ordinary turns have no turn-level point.
for (const withCarrier of [false, true]) {
  test(`R13 trailing assistant leaves turn resumePoint unset, carrier=${withCarrier}`, () =>
    run((f, s, _events, next) =>
      Effect.gen(function* () {
        yield* s.startTurn(start);
        yield* send(f, [
          ...(withCarrier ? [carrier()] : []),
          begin(),
          blockMessage("message-1", chain),
          end(),
          stop(),
          result(),
        ]);
        expect(yield* next("turn.finished")).not.toHaveProperty("resumePoint");
        expect((yield* s.continuation).resumePoint).toBe(chain);
      }),
    ));
}

// Every frame after publication violates the response boundary, including streamed deltas.
for (const frame of [
  blockMessage("message-1", lastChain),
  end(),
  stop(),
  partial({
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "late" },
  }),
  begin(),
]) {
  test(`R13 late published response frame fails: ${frame.type === "stream_event" ? frame.event.type : frame.type}`, () =>
    run((f, s, events, next) =>
      Effect.gen(function* () {
        yield* s.startTurn(start);
        yield* send(f, [
          begin(),
          blockMessage("message-1", chain),
          end(),
          stop(),
        ]);
        yield* next("message.finished");
        yield* send(f, [frame]);
        expect(yield* next("turn.finished")).toMatchObject({
          outcome: {
            status: "failed",
            failure: { _tag: "TurnFailed", reason: "protocol-error" },
          },
        });
        expect((yield* s.continuation).resumePoint).toBe(chain);
        expect(
          events.filter((e) => e.type === "message.finished"),
        ).toHaveLength(1);
        expect(events.filter((e) => e.type === "text")).toHaveLength(0);
        expect(yield* s.diagnostics).not.toHaveProperty("lateAssistantFrames");
      }),
    ));
}

// A question can wait beyond 65 minutes without letting Claude continue without its outcome.
test("R13 handler outcome after 66 simulated minutes is delivered", () => {
  const entered = Promise.withResolvers<void>();
  return run(
    (f, s, events, next) =>
      Effect.gen(function* () {
        const client = yield* connect(f);
        yield* s.startTurn(start);
        yield* publishCall(f, next);
        const pending = yield* invoke(client).pipe(Effect.forkScoped);
        yield* Effect.promise(() => entered.promise);
        yield* TestClock.adjust("66 minutes");
        expect(yield* Fiber.join(pending)).toMatchObject({
          content: [{ type: "text", text: "delayed outcome" }],
          isError: false,
        });
        yield* send(f, [result()]);
        yield* next("turn.finished");
        expect(finishedCalls(events)).toEqual([
          expect.objectContaining({
            errored: false,
            durationMs: expect.any(Number),
          }),
        ]);
      }),
    {
      testClock: true,
      policy: {
        ...policy,
        tools: [
          definition(() =>
            Effect.sync(() => entered.resolve()).pipe(
              Effect.andThen(Effect.sleep("66 minutes")),
              Effect.as({ text: "delayed outcome" }),
            ),
          ),
        ],
      },
    },
  );
});

// A person's late answer still controls permission; there is no autonomous timeout denial.
test("R13 permission answer after 66 simulated minutes is honoured", () =>
  run(
    (f, s, _events, next) =>
      Effect.gen(function* () {
        yield* s.startTurn(start);
        yield* publishCall(f, next);
        const pending = yield* permission(f).pipe(Effect.forkScoped);
        const request = yield* next("approval.requested");
        if (request.type !== "approval.requested") throw new Error("fixture");
        yield* TestClock.adjust("66 minutes");
        yield* s.respondToApproval({
          requestId: request.requestId,
          decision: "allow",
        });
        expect(yield* Fiber.join(pending)).toMatchObject({
          behavior: "allow",
          updatedInput: {},
        });
      }),
    {
      testClock: true,
      policy: {
        ...policy,
        approvalPolicy: "ask",
        tools: [definition(() => Effect.succeed({ text: "fixture" }))],
      },
    },
  ));

// A handler's self-interruption must abort the signal before MCP receives the fallback reply.
test("R13 interrupted handler aborts its signal before call settles", () => {
  let signal: AbortSignal | undefined;
  return run(
    (f, s, _events, next) =>
      Effect.gen(function* () {
        const client = yield* connect(f);
        yield* s.startTurn(start);
        yield* publishCall(f, next);
        expect(yield* invoke(client)).toMatchObject({ isError: true });
        expect(signal?.aborted).toBe(true);
      }),
    {
      policy: {
        ...policy,
        tools: [
          definition((_input, call) =>
            Effect.sync(() => {
              signal = call?.signal;
            }).pipe(Effect.andThen(Effect.interrupt)),
          ),
        ],
      },
    },
  );
});

// Every observed call must close even if permission or lifecycle stops it before dispatch.
for (const path of [
  "denied",
  "permission aborted",
  "turn ended",
  "turn stopped",
  "session closed",
  "outstanding at result",
] as const) {
  test(`R13 uninvoked call finishes once: ${path}`, () =>
    run(
      (f, s, events, next) =>
        Effect.gen(function* () {
          yield* s.startTurn(start);
          yield* publishCall(f, next);
          if (path === "denied" || path === "permission aborted") {
            const controller = new AbortController();
            const pending = yield* permission(f, controller.signal).pipe(
              Effect.forkScoped,
            );
            const request = yield* next("approval.requested");
            if (request.type !== "approval.requested")
              throw new Error("fixture");
            if (path === "denied")
              yield* s.respondToApproval({
                requestId: request.requestId,
                decision: "deny",
              });
            else controller.abort();
            expect(yield* Fiber.join(pending)).toMatchObject({
              behavior: "deny",
            });
            yield* next("tool.finished");
            expect(finishedCalls(events)).toHaveLength(1);
            yield* send(f, [result()]);
          } else if (path === "turn stopped")
            yield* s.interruptTurn({ turnId: "one", reason: "stop" });
          else if (path === "session closed")
            yield* Scope.close(f.sessionScope, Exit.void);
          else if (path === "turn ended")
            yield* Queue.shutdown(f.children[0]!.frames);
          else yield* send(f, [result()]);
          yield* next("turn.finished");
          expectBalanced(events, false);
        }),
      {
        policy: {
          ...policy,
          approvalPolicy: "ask",
          tools: [definition(() => Effect.die("Never dispatched"))],
        },
      },
    ));
}

// Failures and defects both lack ToolOutcome, while an error outcome is still a delivered result.
for (const path of ["interruption", "defect", "error outcome"] as const) {
  test(`R13 dispatched call finishes once: ${path}`, () =>
    run(
      (f, s, events, next) =>
        Effect.gen(function* () {
          const client = yield* connect(f);
          yield* s.startTurn(start);
          yield* publishCall(f, next);
          expect(yield* invoke(client)).toMatchObject({ isError: true });
          yield* send(f, [result()]);
          yield* next("turn.finished");
          expectBalanced(events, true);
        }),
      {
        policy: {
          ...policy,
          tools: [
            definition(() =>
              path === "interruption"
                ? Effect.interrupt
                : path === "defect"
                  ? Effect.die("fixture")
                  : Effect.succeed({ text: "failure", error: "fixture" }),
            ),
          ],
        },
      },
    ));
}

// Result settlement can beat an active handler; its finalizer must not publish a duplicate.
for (const path of ["MCP cancelled", "result", "stop", "close"] as const) {
  test(`R13 active handler finishes once: ${path}`, () => {
    const entered = Promise.withResolvers<void>();
    let signal: AbortSignal | undefined;
    return run(
      (f, s, events, next) =>
        Effect.gen(function* () {
          const client = yield* connect(f);
          yield* s.startTurn(start);
          yield* publishCall(f, next);
          const controller = new AbortController();
          const pending = client
            .callTool(
              {
                name: "work",
                arguments: {},
                _meta: { [TOOL_USE_ID_META]: "call-1" },
              },
              undefined,
              { signal: controller.signal },
            )
            .catch(() => undefined);
          yield* Effect.promise(() => entered.promise);
          if (path === "MCP cancelled") {
            controller.abort();
            yield* next("tool.finished");
            yield* send(f, [result()]);
          } else if (path === "result") yield* send(f, [result()]);
          else if (path === "stop")
            yield* s.interruptTurn({ turnId: "one", reason: "stop" });
          else yield* Scope.close(f.sessionScope, Exit.void);
          yield* next("turn.finished");
          yield* Effect.promise(() => pending);
          expect(signal?.aborted).toBe(true);
          expectBalanced(events, true);
        }),
      {
        policy: {
          ...policy,
          tools: [
            definition((_input, call) =>
              Effect.sync(() => {
                signal = call?.signal;
                entered.resolve();
              }).pipe(Effect.andThen(Effect.never)),
            ),
          ],
        },
      },
    );
  });
}

// Publication still binds a response while turn cleanup waits for a handler finalizer.
for (const late of [blockMessage("message-1", lastChain), end()]) {
  test(`R13 late frame during result cleanup fails the turn: ${late.type}`, () => {
    const entered = Promise.withResolvers<void>();
    const finalizing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    return run(
      (f, s, _events, next) =>
        Effect.gen(function* () {
          const client = yield* connect(f);
          yield* s.startTurn(start);
          yield* publishCall(f, next);
          const pending = invoke(client).pipe(Effect.forkScoped);
          yield* pending;
          yield* Effect.promise(() => entered.promise);
          yield* send(f, [result()]);
          yield* Effect.promise(() => finalizing.promise);
          yield* send(f, [late]);
          while (!f.children[0]!.closed) yield* Effect.yieldNow;
          release.resolve();
          expect(yield* next("turn.finished")).toMatchObject({
            outcome: {
              status: "failed",
              failure: { _tag: "TurnFailed", reason: "protocol-error" },
            },
          });
        }).pipe(Effect.ensuring(Effect.sync(() => release.resolve()))),
      {
        policy: {
          ...policy,
          tools: [
            definition(() =>
              Effect.sync(() => entered.resolve()).pipe(
                Effect.andThen(Effect.never),
                Effect.ensuring(
                  Effect.promise(() => {
                    finalizing.resolve();
                    return release.promise;
                  }),
                ),
              ),
            ),
          ],
        },
      },
    ).finally(() => release.resolve());
  });
}

// A malformed newly-consumed user carrier must fail at the protocol boundary, not as provider death.
test("R13-F1 malformed user message maps to protocol-error", () =>
  run((f, s, events, next) =>
    Effect.gen(function* () {
      yield* s.startTurn(start);
      const frame = JSON.parse(JSON.stringify(carrier()));
      delete frame.message;
      yield* send(f, [frame]);
      expect(yield* next("turn.finished")).toMatchObject({
        outcome: { status: "failed", failure: { reason: "protocol-error" } },
      });
    }),
  ));

// SDK permission/handler callbacks and the message pump are independent ingress paths.
test("R13-F2 a successful handler preceding its frame retains the delivered outcome", () =>
  run(
    (f, s, events, next) =>
      Effect.gen(function* () {
        const client = yield* connect(f);
        yield* s.startTurn(start);
        expect(yield* invoke(client)).toMatchObject({ isError: false });
        expect(
          events.filter((event) => event.type === "message.finished"),
        ).toHaveLength(0);
        yield* publishCall(f, next);
        yield* send(f, [carrier(), result()]);
        yield* next("turn.finished");
        expect(finishedCalls(events)).toEqual([
          expect.objectContaining({
            callId: "call-1",
            errored: false,
            durationMs: expect.any(Number),
          }),
        ]);
      }),
    {
      policy: {
        ...policy,
        tools: [definition(() => Effect.succeed({ text: "fixture" }))],
      },
    },
  ));

// The carrier scanner reads the container and every block's type, even for unrelated blocks.
for (const content of [{}, null, [null], [{}], [{ type: 17 }]]) {
  test(`R13-F1 malformed user content maps to protocol-error: ${JSON.stringify(content)}`, () =>
    run((f, s, _events, next) =>
      Effect.gen(function* () {
        yield* s.startTurn(start);
        const frame = JSON.parse(JSON.stringify(carrier()));
        frame.message.content = content;
        yield* send(f, [frame, result()]);
        expect(yield* next("turn.finished")).toMatchObject({
          outcome: { status: "failed", failure: { reason: "protocol-error" } },
        });
      }),
    ));
}

// A declared string carrier remains valid without tool-result blocks.
test("R13-F1 string user content remains valid", () =>
  run((f, s, _events, next) =>
    Effect.gen(function* () {
      yield* s.startTurn(start);
      const frame = carrier();
      if (frame.type !== "user") throw new Error("fixture");
      frame.message.content = "fixture";
      yield* send(f, [frame, result()]);
      expect(yield* next("turn.finished")).toMatchObject({
        outcome: { status: "completed" },
      });
    }),
  ));

// Early settlement must preserve timing and the outcome's effect on held steers.
for (const scenario of [
  {
    name: "continuing",
    outcome: { text: "fixture" },
    errored: false,
    ends: false,
  },
  {
    name: "endTurn",
    outcome: { text: "fixture", endTurn: true },
    errored: false,
    ends: true,
  },
  {
    name: "error",
    outcome: { text: "fixture", error: "fixture error" },
    errored: true,
    ends: false,
  },
] satisfies Array<{
  name: string;
  outcome: ToolOutcome;
  errored: boolean;
  ends: boolean;
}>) {
  test(`R13-F2 kept ${scenario.name} outcome controls held steers and timing`, () => {
    let handlerStart = 0;
    let handlerEnd = 0;
    return run(
      (f, s, events, next) =>
        Effect.gen(function* () {
          const client = yield* connect(f);
          yield* s.startTurn(start);
          yield* s.steerTurn({ turnId: "one", message: "held" });
          expect(yield* invoke(client)).toMatchObject({
            isError: scenario.errored,
          });
          expect(f.sends).toHaveLength(1);
          yield* publishCall(f, next);
          yield* Effect.yieldNow;
          expect(f.sends.map((m) => m.message.content)).toEqual(
            scenario.ends ? ["fixture"] : ["fixture", "held"],
          );
          expect(yield* s.diagnostics).toMatchObject({
            discardedSteers: scenario.ends ? 1 : 0,
          });
          if (!scenario.ends) expect(f.sends[1]!.priority).toBe("now");
          yield* send(f, [carrier(), result()]);
          expect(yield* next("turn.finished")).toMatchObject({
            outcome: { status: "completed" },
          });
          expect(
            events.filter((event) => event.type === "tool.started"),
          ).toHaveLength(1);
          expect(finishedCalls(events)).toEqual([
            expect.objectContaining({
              callId: "call-1",
              errored: scenario.errored,
              durationMs: expect.any(Number),
            }),
          ]);
          expect(finishedCalls(events)[0]!.durationMs).toBeGreaterThanOrEqual(
            handlerEnd - handlerStart,
          );
          expect(yield* invoke(client)).toMatchObject({ isError: true });
          expect(finishedCalls(events)).toHaveLength(1);
        }),
      {
        policy: {
          ...policy,
          tools: [
            definition(() =>
              Effect.gen(function* () {
                handlerStart = Date.now();
                yield* Effect.sleep("15 millis");
                handlerEnd = Date.now();
                return scenario.outcome;
              }),
            ),
          ],
        },
      },
    );
  });
}

// A handler may precede its assistant frame and still be running when that frame arrives.
// A result must abort an undelivered call before publishing tool.finished, even when a steer keeps the turn open.
test("R13b early handler is aborted at result settlement before a queued steer finishes", () => {
  const entered = Promise.withResolvers<void>();
  let signal: AbortSignal | undefined;
  const abortedAtFinish: boolean[] = [];
  return run(
    (f, s, events, next) =>
      Effect.gen(function* () {
        const client = yield* connect(f);
        yield* s.startTurn(start);
        yield* s.steerTurn({ turnId: "one", message: "held" });
        const pending = yield* invoke(client).pipe(Effect.forkScoped);
        yield* Effect.promise(() => entered.promise);
        yield* publishCall(f, next);
        yield* send(f, [result()]);
        yield* next("tool.finished");
        yield* Effect.yieldNow;
        expect(f.sends).toHaveLength(2);
        expect(events.filter((e) => e.type === "turn.finished")).toHaveLength(
          0,
        );
        expect(finishedCalls(events)).toMatchObject([
          { callId: "call-1", errored: true },
        ]);
        expect(signal?.aborted).toBe(true);
        yield* send(f, [result()]);
        yield* next("turn.finished");
        yield* Fiber.join(pending);
        expect(abortedAtFinish).toEqual([true]);
        expectBalanced(events, true);
      }),
    {
      onEvent: (event) => {
        if (event.type === "tool.finished")
          abortedAtFinish.push(signal?.aborted === true);
      },
      policy: {
        ...policy,
        tools: [
          definition((_input, call) =>
            Effect.sync(() => {
              signal = call?.signal;
              entered.resolve();
            }).pipe(Effect.andThen(Effect.never)),
          ),
        ],
      },
    },
  );
});

// Stop and session closure must abort an early handler before publishing its one tool.finished.
for (const path of ["Stop", "session close"] as const) {
  test(`R13c early handler is aborted before tool.finished at ${path}`, () => {
    const entered = Promise.withResolvers<void>();
    let signal: AbortSignal | undefined;
    const abortedAtFinish: boolean[] = [];
    return run(
      (f, s, events, next) =>
        Effect.gen(function* () {
          const client = yield* connect(f);
          yield* s.startTurn(start);
          const pending = yield* invoke(client).pipe(
            Effect.exit,
            Effect.forkScoped,
          );
          yield* Effect.promise(() => entered.promise);
          yield* publishCall(f, next);
          expect(signal?.aborted).toBe(false);
          if (path === "Stop")
            yield* s.interruptTurn({ turnId: "one", reason: "stop" });
          else yield* Scope.close(f.sessionScope, Exit.void);
          yield* next("turn.finished");
          yield* Fiber.join(pending);
          expect(signal?.aborted).toBe(true);
          expect(abortedAtFinish).toEqual([true]);
          expectBalanced(events, true);
        }),
      {
        onEvent: (event) => {
          if (event.type === "tool.finished")
            abortedAtFinish.push(signal?.aborted === true);
        },
        policy: {
          ...policy,
          tools: [
            definition((_input, call) =>
              Effect.sync(() => {
                signal = call?.signal;
                entered.resolve();
              }).pipe(Effect.andThen(Effect.never)),
            ),
          ],
        },
      },
    );
  });
}

// A fork uses the parent's chain-entry UUID unchanged, then extends that chain.
test("R14 a fork accepts a parent point and extends the same chain", () =>
  run((f, s, _events, next) =>
    Effect.gen(function* () {
      yield* s.startTurn(start);
      yield* send(f, [blockMessage("parent-message", chain), result()]);
      const parent = yield* next("message.finished");
      if (parent.type !== "message.finished") throw new Error("fixture");
      yield* next("turn.finished");
      const fork = yield* f.runtime.openSession(account, policy, {
        kind: "resume",
        session: s.nativeSessionId,
        at: parent.resumePoint,
        fork: true,
      });
      expect(f.children.at(-1)!.options).toMatchObject({
        resume: s.nativeSessionId,
        resumeSessionAt: chain,
        forkSession: true,
      });
      expect(fork.nativeSessionId).not.toBe(s.nativeSessionId);
      const messages = yield* Queue.unbounded<RuntimeEvent>();
      yield* Stream.runForEach(fork.events, (e) =>
        Queue.offer(messages, e),
      ).pipe(Effect.forkScoped);
      yield* fork.startTurn({ turnId: "fork-turn", message: "fixture" });
      yield* send(f, [blockMessage("fork-message", lastChain), result()]);
      let forkPoint: string | undefined;
      while (true) {
        const event = yield* Queue.take(messages);
        RuntimeEvent.parse(event);
        if (event.type === "message.finished") forkPoint = event.resumePoint;
        if (event.type === "turn.finished") break;
      }
      expect(forkPoint).toBe(lastChain);
      for (const at of [parent.resumePoint, forkPoint]) {
        const resumed = yield* f.runtime.openSession(account, policy, {
          kind: "resume",
          session: fork.nativeSessionId,
          at,
          fork: true,
        });
        expect(f.children.at(-1)!.options).toMatchObject({
          resume: fork.nativeSessionId,
          resumeSessionAt: at,
          forkSession: true,
        });
        expect(resumed.nativeSessionId).not.toBe(fork.nativeSessionId);
      }
    }),
  ));

for (const count of [1, 2])
  for (const heldSteer of [false, true]) {
    test(`R14 endTurn publishes last carrier, calls=${count}, held steer=${heldSteer}`, () =>
      run(
        (f, s, _events, next) =>
          Effect.gen(function* () {
            yield* s.startTurn(start);
            const client = yield* connect(f);
            const calls = Array.from({ length: count }, (_, i) => ({
              id: `call-${i + 1}`,
              name: "mcp__neuve__work",
              input: {},
            }));
            yield* send(f, [
              begin(),
              blockMessage("message-1", chain, calls),
              end("tool_use"),
              stop(),
            ]);
            yield* next("message.finished");
            if (heldSteer)
              yield* s.steerTurn({ turnId: "one", message: "held fixture" });
            for (const call of calls) yield* invoke(client, call.id);
            const frame = carrier();
            if (frame.type !== "user") throw new Error("fixture");
            frame.message.content = calls.map((call) => ({
              type: "tool_result",
              tool_use_id: call.id,
              content: "fixture",
            }));
            yield* send(f, [frame, result()]);
            expect(yield* next("turn.finished")).toMatchObject({
              resumePoint: lastChain,
              outcome: { status: "completed" },
            });
            expect((yield* s.continuation).resumePoint).toBe(lastChain);
            expect((yield* s.diagnostics).discardedSteers).toBe(
              heldSteer ? 1 : 0,
            );
            expect(f.sends).toHaveLength(1);
          }),
        {
          policy: {
            ...policy,
            tools: [
              definition(() =>
                Effect.succeed({ text: "fixture", endTurn: true }),
              ),
            ],
          },
        },
      ));
  }
