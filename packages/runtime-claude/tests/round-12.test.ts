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
  type SessionPolicy,
  type ToolDefinition,
} from "@neuve/runtime";
import { Effect, Fiber, Layer, Queue, Stream } from "effect";
import { TestClock } from "effect/testing";
import { makeRuntime } from "../src/runtime.ts";
import { ClaudeExecutable, ClaudeProcess, ClaudeSdk } from "../src/services.ts";
import { TOOL_USE_ID_META } from "../src/tools.ts";
import { assistant, result, SESSION_ID, usage } from "./frames.ts";

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
  return {
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
  options: { policy?: SessionPolicy; testClock?: boolean } = {},
) {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const s = yield* f.runtime.openSession(
          account,
          options.policy ?? policy,
          { kind: "new" },
        );
        const events: RuntimeEvent[] = [];
        const queue = yield* Queue.unbounded<RuntimeEvent>();
        yield* Stream.runForEach(s.events, (event) =>
          Effect.sync(() => {
            RuntimeEvent.parse(event);
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

// A denied call never enters the MCP handler. It must not discard an accepted steer.
test("R10-F1 denied tool cannot strand a held steer", () =>
  run(
    (f, s, events, next) =>
      Effect.gen(function* () {
        yield* s.startTurn(start);
        yield* send(f, [
          begin(),
          blockMessage("message-1", chain, [
            { id: "denied-call", name: "mcp__neuve__work", input: {} },
          ]),
          end("tool_use"),
          stop(),
        ]);
        yield* next("message.finished");
        const permission = yield* Effect.promise(() =>
          f.children[0]!.options.canUseTool!(
            "mcp__neuve__work",
            {},
            {
              signal: new AbortController().signal,
              toolUseID: "denied-call",
              requestId: "permission-1",
            },
          ),
        ).pipe(Effect.forkScoped);
        const requested = yield* next("approval.requested");
        if (requested.type !== "approval.requested") throw new Error("fixture");
        yield* s.respondToApproval({
          requestId: requested.requestId,
          decision: "deny",
        });
        expect(yield* Fiber.join(permission)).toMatchObject({
          behavior: "deny",
        });
        yield* s.steerTurn({ turnId: "one", message: "held" });
        yield* send(f, [
          begin("message-2"),
          blockMessage("message-2", lastChain),
          end(),
          stop(),
          result({
            user_message_uuid: f.sends[0]!.uuid!,
            user_message_uuids: [f.sends[0]!.uuid!],
            queued_turn_count: 0,
          }),
        ]);
        while (
          f.sends.length === 1 &&
          !events.some((e) => e.type === "turn.finished")
        )
          yield* Effect.yieldNow;
        // The pending steer must be offered and keep this turn open until its result.
        expect(yield* s.diagnostics).toMatchObject({ discardedSteers: 0 });
        expect(f.sends.map((m) => m.message.content)).toEqual([
          "fixture",
          "held",
        ]);
        expect(events.filter((e) => e.type === "turn.finished")).toHaveLength(
          0,
        );
      }),
    {
      policy: {
        ...policy,
        approvalPolicy: "ask",
        tools: [definition(() => Effect.die("Denied handler must not run"))],
      },
    },
  ));

// MCP cancellation ends a call without producing ToolOutcome, and the session stays usable.
test("R10-F1 canceled tool cannot strand a held steer", () => {
  const entered = Promise.withResolvers<void>();
  const canceled = Promise.withResolvers<void>();
  return run(
    (f, s, events, next) =>
      Effect.gen(function* () {
        const client = yield* connect(f);
        yield* s.startTurn(start);
        yield* send(f, [
          begin(),
          blockMessage("message-1", chain, [
            { id: "canceled-call", name: "mcp__neuve__work", input: {} },
          ]),
          end("tool_use"),
          stop(),
        ]);
        yield* next("message.finished");
        const controller = new AbortController();
        const pending = client
          .callTool(
            {
              name: "work",
              arguments: {},
              _meta: { [TOOL_USE_ID_META]: "canceled-call" },
            },
            undefined,
            { signal: controller.signal },
          )
          .catch(() => undefined);
        yield* Effect.promise(() => entered.promise);
        yield* s.steerTurn({ turnId: "one", message: "held" });
        controller.abort();
        yield* Effect.promise(() => canceled.promise);
        yield* Effect.promise(() => pending);
        yield* next("tool.finished");
        yield* send(f, [
          begin("message-2"),
          blockMessage("message-2", lastChain),
          end(),
          stop(),
          result({
            user_message_uuid: f.sends[0]!.uuid!,
            user_message_uuids: [f.sends[0]!.uuid!],
            queued_turn_count: 0,
          }),
        ]);
        while (
          f.sends.length === 1 &&
          !events.some((e) => e.type === "turn.finished")
        )
          yield* Effect.yieldNow;
        expect(yield* s.diagnostics).toMatchObject({ discardedSteers: 0 });
        expect(f.sends.map((m) => m.message.content)).toEqual([
          "fixture",
          "held",
        ]);
        expect(events.filter((e) => e.type === "turn.finished")).toHaveLength(
          0,
        );
      }),
    {
      policy: {
        ...policy,
        tools: [
          definition(() =>
            Effect.sync(() => entered.resolve()).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Effect.sync(() => canceled.resolve())),
            ),
          ),
        ],
      },
    },
  );
});

// Check Neuve's negative-boundary coverage risk without changing the implementation.
test("R10 message_delta does not publish before message_stop", () =>
  run((f, s, events, next) =>
    Effect.gen(function* () {
      yield* s.startTurn(start);
      const before = (yield* s.continuation).resumePoint;
      yield* send(f, [begin(), blockMessage("message-1", chain), end()]);
      yield* barrier(f);
      yield* next("rate-limit");
      expect(events.filter((e) => e.type === "message.finished")).toHaveLength(
        0,
      );
      expect((yield* s.continuation).resumePoint).toBe(before);
      yield* send(f, [stop()]);
      yield* barrier(f);
      yield* next("rate-limit");
      expect(events.filter((e) => e.type === "message.finished")).toHaveLength(
        1,
      );
      expect((yield* s.continuation).resumePoint).toBe(chain);
    }),
  ));

// A handler defect becomes an MCP error reply. It must settle the call group too.
test("R10-F1 failed handler cannot strand a held steer", () =>
  run(
    (f, s, events, next) =>
      Effect.gen(function* () {
        const client = yield* connect(f);
        yield* s.startTurn(start);
        yield* send(f, [
          begin(),
          blockMessage("message-1", chain, [
            { id: "failed-call", name: "mcp__neuve__work", input: {} },
          ]),
          end("tool_use"),
          stop(),
        ]);
        yield* next("message.finished");
        yield* s.steerTurn({ turnId: "one", message: "held" });
        const reply = yield* Effect.promise(() =>
          client.callTool({
            name: "work",
            arguments: {},
            _meta: { [TOOL_USE_ID_META]: "failed-call" },
          }),
        );
        expect(reply).toMatchObject({ isError: true });
        yield* send(f, [
          begin("message-2"),
          blockMessage("message-2", lastChain),
          end(),
          stop(),
          result({
            user_message_uuid: f.sends[0]!.uuid!,
            user_message_uuids: [f.sends[0]!.uuid!],
            queued_turn_count: 0,
          }),
        ]);
        while (
          f.sends.length === 1 &&
          !events.some((e) => e.type === "turn.finished")
        )
          yield* Effect.yieldNow;
        expect(yield* s.diagnostics).toMatchObject({ discardedSteers: 0 });
        expect(f.sends.map((m) => m.message.content)).toEqual([
          "fixture",
          "held",
        ]);
      }),
    { policy: { ...policy, tools: [definition(() => Effect.die("fixture"))] } },
  ));

// A denial must settle only its own call; an ending sibling still discards the steer.
for (const denialFirst of [true, false]) {
  test(`R12 denied and endTurn siblings discard, denial first: ${denialFirst}`, () =>
    run(
      (f, s, events, next) =>
        Effect.gen(function* () {
          const client = yield* connect(f);
          yield* s.startTurn(start);
          yield* send(f, [
            begin(),
            blockMessage("message-1", chain, [
              { id: "denied-call", name: "mcp__neuve__work", input: {} },
              { id: "ending-call", name: "mcp__neuve__work", input: {} },
            ]),
            end("tool_use"),
            stop(),
          ]);
          yield* next("message.finished");
          yield* s.steerTurn({ turnId: "one", message: "held" });
          const denyCall = Effect.gen(function* () {
            const permission = yield* Effect.promise(() =>
              f.children[0]!.options.canUseTool!(
                "mcp__neuve__work",
                {},
                {
                  signal: new AbortController().signal,
                  toolUseID: "denied-call",
                  requestId: "permission-1",
                },
              ),
            ).pipe(Effect.forkScoped);
            const requested = yield* next("approval.requested");
            if (requested.type !== "approval.requested")
              throw new Error("fixture");
            yield* s.respondToApproval({
              requestId: requested.requestId,
              decision: "deny",
            });
            expect(yield* Fiber.join(permission)).toMatchObject({
              behavior: "deny",
            });
          });
          const endCall = Effect.promise(() =>
            client.callTool({
              name: "work",
              arguments: {},
              _meta: { [TOOL_USE_ID_META]: "ending-call" },
            }),
          );
          if (denialFirst) {
            yield* denyCall;
            expect(f.sends).toHaveLength(1);
            yield* endCall;
          } else {
            yield* endCall;
            expect(f.sends).toHaveLength(1);
            yield* denyCall;
          }
          yield* send(f, [result()]);
          expect(yield* next("turn.finished")).toMatchObject({
            outcome: { status: "completed" },
          });
          expect(f.sends.map((m) => m.message.content)).toEqual(["fixture"]);
          expect(yield* s.diagnostics).toMatchObject({ discardedSteers: 1 });
          expect(events.filter((e) => e.type === "turn.finished")).toHaveLength(
            1,
          );
        }),
      {
        policy: {
          ...policy,
          approvalPolicy: "ask",
          tools: [
            definition((_input, call) => {
              if (call?.callId !== "ending-call")
                return Effect.die("Denied handler must not run");
              return Effect.succeed({ text: "fixture", endTurn: true });
            }),
          ],
        },
      },
    ));
}

// Claude Code may emit a result without invoking any handler or permission callback.
test("R12 result settles uninvoked calls before releasing held steers", () =>
  run(
    (f, s, events, next) =>
      Effect.gen(function* () {
        yield* s.startTurn(start);
        yield* send(f, [
          begin(),
          blockMessage("message-1", chain, [
            { id: "uninvoked-call", name: "mcp__neuve__work", input: {} },
          ]),
          end("tool_use"),
          stop(),
        ]);
        yield* next("message.finished");
        yield* s.steerTurn({ turnId: "one", message: "held" });
        yield* send(f, [
          result({
            user_message_uuids: [f.sends[0]!.uuid!],
            queued_turn_count: 0,
          }),
        ]);
        while (
          f.sends.length === 1 &&
          !events.some((e) => e.type === "turn.finished")
        )
          yield* Effect.yieldNow;
        expect(f.sends.map((m) => m.message.content)).toEqual([
          "fixture",
          "held",
        ]);
        expect(events.filter((e) => e.type === "turn.finished")).toHaveLength(
          0,
        );
        expect(yield* s.diagnostics).toMatchObject({ discardedSteers: 0 });
        yield* send(f, [
          result({
            user_message_uuids: [f.sends[1]!.uuid!],
            queued_turn_count: 0,
          }),
        ]);
        expect(yield* next("turn.finished")).toMatchObject({
          outcome: { status: "completed" },
        });
        expect(events.filter((e) => e.type === "turn.finished")).toHaveLength(
          1,
        );
      }),
    {
      policy: {
        ...policy,
        tools: [definition(() => Effect.die("Uninvoked handler must not run"))],
      },
    },
  ));

// Ruling 18 removes the local deadline. A late outcome still settles before replying.
test("R12 tool outcome after 66 minutes settles its handler before replying", () => {
  const entered = Promise.withResolvers<void>();
  let finalized = 0;
  return run(
    (f, s, events, next) =>
      Effect.gen(function* () {
        const client = yield* connect(f);
        yield* s.startTurn(start);
        yield* send(f, [
          begin(),
          blockMessage("message-1", chain, [
            { id: "timeout-call", name: "mcp__neuve__work", input: {} },
          ]),
          end("tool_use"),
          stop(),
        ]);
        yield* next("message.finished");
        yield* s.steerTurn({ turnId: "one", message: "held" });
        const pending = client.callTool({
          name: "work",
          arguments: {},
          _meta: { [TOOL_USE_ID_META]: "timeout-call" },
        });
        yield* Effect.promise(() => entered.promise);
        yield* TestClock.adjust("66 minutes");
        expect(yield* Effect.promise(() => pending)).toMatchObject({
          isError: false,
        });
        expect(finalized).toBe(1);
        expect(f.sends.map((m) => m.message.content)).toEqual([
          "fixture",
          "held",
        ]);
        expect(events.filter((e) => e.type === "tool.finished")).toHaveLength(
          1,
        );
        expect(
          events.filter((e) => e.type === "tool.finished")[0],
        ).toMatchObject({ errored: false });
        expect(events.filter((e) => e.type === "turn.finished")).toHaveLength(
          0,
        );
        expect(yield* s.diagnostics).toMatchObject({ discardedSteers: 0 });
      }),
    {
      testClock: true,
      policy: {
        ...policy,
        tools: [
          definition(() =>
            Effect.sync(() => entered.resolve()).pipe(
              Effect.andThen(Effect.sleep("66 minutes")),
              Effect.as({ text: "fixture" }),
              Effect.ensuring(
                Effect.sync(() => {
                  finalized++;
                }),
              ),
            ),
          ),
        ],
      },
    },
  );
});

// Permission callbacks can finish before message_stop publishes the call group.
test("R12 an early denial stays settled when the completed response arrives", () =>
  run(
    (f, s, _events, next) =>
      Effect.gen(function* () {
        const client = yield* connect(f);
        yield* s.startTurn(start);
        yield* send(f, [
          begin(),
          blockMessage("message-1", chain, [
            { id: "denied-call", name: "mcp__neuve__work", input: {} },
            { id: "continuing-call", name: "mcp__neuve__work", input: {} },
          ]),
        ]);
        yield* next("tool.started");
        yield* next("tool.started");
        const permission = yield* Effect.promise(() =>
          f.children[0]!.options.canUseTool!(
            "mcp__neuve__work",
            {},
            {
              signal: new AbortController().signal,
              toolUseID: "denied-call",
              requestId: "permission-1",
            },
          ),
        ).pipe(Effect.forkScoped);
        const requested = yield* next("approval.requested");
        if (requested.type !== "approval.requested") throw new Error("fixture");
        yield* s.respondToApproval({
          requestId: requested.requestId,
          decision: "deny",
        });
        expect(yield* Fiber.join(permission)).toMatchObject({
          behavior: "deny",
        });
        yield* s.steerTurn({ turnId: "one", message: "held" });
        yield* send(f, [end("tool_use"), stop()]);
        yield* next("message.finished");
        expect(f.sends).toHaveLength(1);
        yield* Effect.promise(() =>
          client.callTool({
            name: "work",
            arguments: {},
            _meta: { [TOOL_USE_ID_META]: "continuing-call" },
          }),
        );
        expect(f.sends.map((m) => m.message.content)).toEqual([
          "fixture",
          "held",
        ]);
        expect(yield* s.diagnostics).toMatchObject({ discardedSteers: 0 });
      }),
    {
      policy: {
        ...policy,
        approvalPolicy: "ask",
        tools: [
          definition((_input, call) => {
            if (call?.callId !== "continuing-call")
              return Effect.die("Denied handler must not run");
            return Effect.succeed({ text: "fixture" });
          }),
        ],
      },
    },
  ));
