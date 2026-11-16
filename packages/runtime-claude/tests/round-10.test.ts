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
  type SessionStart,
  type ToolDefinition,
} from "@neuve/runtime";
import { Effect, Fiber, Layer, Queue, Stream } from "effect";
import { TestClock } from "effect/testing";
import { makeRuntime } from "../src/runtime.ts";
import {
  ClaudeExecutable,
  ClaudeProcess,
  ClaudeSdk,
  ClaudeSdkError,
} from "../src/services.ts";
import { TOOL_USE_ID_META } from "../src/tools.ts";
import { assistant, result, SESSION_ID, usage } from "../tests/frames.ts";

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
  const controls: unknown[] = [];
  const settingsFailure = { enabled: false, stall: false };
  const settingsStarted = Promise.withResolvers<void>();
  const modelStarted = Promise.withResolvers<void>();
  const modelRelease = Promise.withResolvers<void>();
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
            setModel: (model) =>
              Effect.sync(() => {
                controls.push(["model", model]);
                if (model === "model-a") modelStarted.resolve();
              }).pipe(
                Effect.andThen(
                  model === "model-a"
                    ? Effect.promise(() => modelRelease.promise)
                    : Effect.void,
                ),
              ),
            applyFlagSettings: (settings) =>
              Effect.sync(() => {
                controls.push(["flags", settings]);
                settingsStarted.resolve();
              }).pipe(
                Effect.andThen(
                  Effect.suspend(() =>
                    settingsFailure.stall
                      ? Effect.never
                      : settingsFailure.enabled
                        ? Effect.fail(
                            new ClaudeSdkError({ method: "applyFlagSettings" }),
                          )
                        : Effect.void,
                  ),
                ),
              ),
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
    controls,
    runtime,
    modelStarted,
    modelRelease,
    settingsFailure,
    settingsStarted,
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
  options: { policy?: SessionPolicy; start?: SessionStart } = {},
) {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const s = yield* f.runtime.openSession(
          account,
          options.policy ?? policy,
          options.start ?? { kind: "new" },
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
    ).pipe(Effect.timeout("3 seconds")),
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

// The two controls of one model selection must leave a coherent model/effort pair.
test("R8-F1 overlapping model switches serialize model and effort and save the last pair", () =>
  run(
    (f, s, events, next) =>
      Effect.gen(function* () {
        const a = yield* s
          .setModel({ id: "model-a", effort: "low" })
          .pipe(Effect.forkScoped);
        yield* Effect.promise(() => f.modelStarted.promise);
        const b = yield* s
          .setModel({ id: "model-b", effort: "high" })
          .pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        f.modelRelease.resolve();
        yield* Fiber.join(a);
        yield* Fiber.join(b);
        yield* s.startTurn({ ...start, final: true });
        expect(f.controls).toEqual([
          ["model", "model-a"],
          ["flags", { effortLevel: "low" }],
          ["model", "model-b"],
          ["flags", { effortLevel: "high" }],
        ]);
        expect(f.children[1]!.options.model).toBe("model-b");
      }).pipe(Effect.ensuring(Effect.sync(() => f.modelRelease.resolve()))),
    { policy: { ...policy, outputSchema: { type: "object" } } },
  ));

// A declared complete assistant response supplies final request usage without partial events.
test("R8-F2 a complete non-stream assistant response preserves its request usage", () =>
  run((f, s, events, next) =>
    Effect.gen(function* () {
      yield* s.startTurn(start);
      const frame = assistant(undefined);
      frame.message.usage.input_tokens = 17;
      frame.message.usage.output_tokens = 5;
      yield* send(f, [
        frame,
        result({ modelUsage: { "test-model": usage(17, 5) } }),
      ]);
      yield* next("turn.finished");
      expect(
        events.find((e) => e.type === "message.finished")?.usage,
      ).toMatchObject({ input: 17, output: 5 });
    }),
  ));

// Tool-capable sessions must keep steers out of the native command queue.
test("R8-F3 endTurn discards held steers and completes without offering another request", () =>
  run(
    (f, s, events, next) =>
      Effect.gen(function* () {
        const client = yield* connect(f);
        yield* s.startTurn(start);
        yield* send(f, [
          begin(),
          blockMessage("message-1", chain, [
            { id: "call-1", name: "mcp__neuve__work", input: {} },
          ]),
          end("tool_use"),
          stop(),
        ]);
        yield* next("tool.started");
        yield* s.steerTurn({ turnId: "one", message: "queued" });
        yield* Effect.promise(() =>
          client.callTool({
            name: "work",
            arguments: {},
            _meta: { [TOOL_USE_ID_META]: "call-1" },
          }),
        );
        yield* send(f, [
          result({
            user_message_uuid: f.sends[0]!.uuid!,
            user_message_uuids: [f.sends[0]!.uuid!],
            queued_turn_count: 0,
          }),
        ]);
        expect(yield* next("turn.finished")).toMatchObject({
          outcome: { status: "completed" },
        });
        expect(f.sends).toHaveLength(1);
        expect((yield* s.diagnostics).discardedSteers).toBe(1);
      }),
    {
      policy: {
        ...policy,
        tools: [
          definition(() => Effect.succeed({ text: "fixture", endTurn: true })),
        ],
      },
    },
  ));

// A rejected effort update must not leave a usable child with a selection lost at reopen.
test("R8-F1b partial model switch failure retires the child and preserves the previous pair", () =>
  run(
    (f, s, events, next) =>
      Effect.gen(function* () {
        f.settingsFailure.enabled = true;
        expect(
          yield* s
            .setModel({ id: "model-b", effort: "high" })
            .pipe(Effect.flip),
        ).toMatchObject({ reason: "provider-failed" });
        expect(f.controls).toEqual([
          ["model", "model-b"],
          ["flags", { effortLevel: "high" }],
        ]);
        expect(f.children[0]!.closed).toBe(true);
        yield* s.startTurn({ ...start, final: true });
        expect(f.children[1]!.options).toMatchObject({
          model: "initial-model",
          effort: "low",
        });
      }),
    {
      policy: {
        ...policy,
        model: { id: "initial-model", effort: "low" },
        outputSchema: { type: "object" },
      },
    },
  ));

// A frame after publication violates the contract and must not move its resume point.
test("R10 late assistant frame fails without moving the published checkpoint", () =>
  run((f, s, events, next) =>
    Effect.gen(function* () {
      yield* s.startTurn(start);
      yield* send(f, [
        begin(),
        blockMessage("message-1", chain),
        end(),
        stop(),
        blockMessage("message-1", lastChain),
        result(),
      ]);
      expect(yield* next("turn.finished")).toMatchObject({
        outcome: { status: "failed", failure: { reason: "protocol-error" } },
      });
      expect(events.filter((e) => e.type === "message.finished")).toEqual([
        expect.objectContaining({ resumePoint: chain }),
      ]);
      expect((yield* s.continuation).resumePoint).toBe(chain);
      expect(yield* s.diagnostics).not.toHaveProperty("lateAssistantFrames");
    }),
  ));

// Held sends must be delivered before the MCP result allows the next model round.
test("R10 a continuing handler offers held steers before returning its result", () =>
  run(
    (f, s, events, next) =>
      Effect.gen(function* () {
        const client = yield* connect(f);
        yield* s.startTurn(start);
        yield* s.steerTurn({ turnId: "one", message: "held" });
        expect(f.sends).toHaveLength(1);
        yield* send(f, [
          blockMessage("message-1", chain, [
            { id: "call-1", name: "mcp__neuve__work", input: {} },
          ]),
        ]);
        yield* next("tool.started");
        expect(
          yield* Effect.promise(() =>
            client.callTool({
              name: "work",
              arguments: {},
              _meta: { [TOOL_USE_ID_META]: "call-1" },
            }),
          ),
        ).toMatchObject({ content: [{ type: "text", text: "fixture" }] });
        expect(f.sends.map((m) => m.message.content)).toEqual([
          "fixture",
          "held",
        ]);
        expect(f.sends[1]!.priority).toBe("now");
        yield* send(f, [result()]);
        yield* next("turn.finished");
      }),
    {
      policy: {
        ...policy,
        tools: [definition(() => Effect.succeed({ text: "fixture" }))],
      },
    },
  ));

// A tool-capable session can also end a model round without invoking a handler.
test("R10 a no-tool response offers held steers and keeps the turn open", () =>
  run(
    (f, s, events, next) =>
      Effect.gen(function* () {
        yield* s.startTurn(start);
        yield* s.steerTurn({ turnId: "one", message: "held" });
        expect(f.sends).toHaveLength(1);
        yield* send(f, [
          blockMessage("message-1", chain),
          result({
            user_message_uuids: [f.sends[0]!.uuid!],
            queued_turn_count: 0,
          }),
          { ...begin("message-2"), user_message_uuid: f.sends[0]!.uuid! },
        ]);
        // A subsequent event provides an ordered pump barrier.
        yield* send(f, [
          {
            type: "rate_limit_event",
            session_id: SESSION_ID,
            uuid: crypto.randomUUID(),
            rate_limit_info: { status: "allowed" },
          },
        ]);
        yield* next("rate-limit");
        expect(f.sends.map((m) => m.message.content)).toEqual([
          "fixture",
          "held",
        ]);
        expect(events.filter((e) => e.type === "turn.finished")).toHaveLength(
          0,
        );
        yield* send(f, [
          blockMessage("message-2", lastChain),
          result({
            user_message_uuids: [f.sends[1]!.uuid!],
            queued_turn_count: 0,
          }),
        ]);
        expect(yield* next("turn.finished")).toMatchObject({
          outcome: { status: "completed" },
        });
      }),
    {
      policy: {
        ...policy,
        tools: [definition(() => Effect.succeed({ text: "unused" }))],
      },
    },
  ));

// Lifecycle replacement must not save a control result from the previous generation.
test("R10 a model switch cannot save its selection after the child reopens", () =>
  run(
    (f, s) =>
      Effect.gen(function* () {
        const switching = yield* s
          .setModel({ id: "model-a", effort: "high" })
          .pipe(Effect.forkScoped);
        yield* Effect.promise(() => f.modelStarted.promise);
        yield* s.startTurn({ ...start, final: true });
        f.modelRelease.resolve();
        expect(yield* Fiber.join(switching).pipe(Effect.flip)).toMatchObject({
          reason: "provider-failed",
        });
        expect(f.children[0]!.closed).toBe(true);
        expect(f.children[1]!.options).toMatchObject({
          model: "initial-model",
          effort: "low",
        });
      }).pipe(Effect.ensuring(Effect.sync(() => f.modelRelease.resolve()))),
    {
      policy: {
        ...policy,
        model: { id: "initial-model", effort: "low" },
        outputSchema: { type: "object" },
      },
    },
  ));

// A partial failure during a running turn must release that turn for the next start.
test("R10 a partial model switch failure ends an active turn and reopens coherently", () =>
  run(
    (f, s, events, next) =>
      Effect.gen(function* () {
        yield* s.startTurn(start);
        f.settingsFailure.enabled = true;
        expect(
          yield* s
            .setModel({ id: "model-b", effort: "high" })
            .pipe(Effect.flip),
        ).toMatchObject({ reason: "provider-failed" });
        expect(yield* next("turn.finished")).toMatchObject({
          outcome: {
            status: "failed",
            disposition: "reusable",
            failure: { reason: "provider-failed" },
          },
        });
        yield* s.startTurn({ ...start, turnId: "two" });
        expect(f.children[1]!.options).toMatchObject({
          model: "initial-model",
          effort: "low",
        });
        yield* send(f, [result()]);
        expect(yield* next("turn.finished")).toMatchObject({
          outcome: { status: "completed" },
        });
      }),
    { policy: { ...policy, model: { id: "initial-model", effort: "low" } } },
  ));

// Advance the real adapter's 25-second SDK deadline without waiting on wall time.
test("R10 an effort timeout retires a partially switched child", () =>
  run(
    (f, s) =>
      Effect.gen(function* () {
        f.settingsFailure.stall = true;
        const switching = yield* s
          .setModel({ id: "model-b", effort: "high" })
          .pipe(Effect.forkScoped);
        yield* Effect.promise(() => f.settingsStarted.promise);
        yield* TestClock.adjust("25 seconds");
        expect(yield* Fiber.join(switching).pipe(Effect.flip)).toMatchObject({
          reason: "provider-failed",
        });
        expect(f.children[0]!.closed).toBe(true);
        yield* s.startTurn({ ...start, final: true });
        expect(f.children[1]!.options).toMatchObject({
          model: "initial-model",
          effort: "low",
        });
      }).pipe(Effect.provide(TestClock.layer())),
    {
      policy: {
        ...policy,
        model: { id: "initial-model", effort: "low" },
        outputSchema: { type: "object" },
      },
    },
  ));
