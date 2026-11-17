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

const barrier = (f: Fixture) =>
  send(f, [
    {
      type: "rate_limit_event",
      session_id: SESSION_ID,
      uuid: crypto.randomUUID(),
      rate_limit_info: { status: "allowed" },
    },
  ]);

// Ruling 11 requires publication at message_stop even when no later frame arrives.
test("R9-F1 message_stop publishes before any later model frame or result", () =>
  run((f, s, events, next) =>
    Effect.gen(function* () {
      yield* s.startTurn(start);
      yield* send(f, [
        begin(),
        blockMessage("message-1", chain),
        end(),
        stop(),
      ]);
      yield* barrier(f);
      yield* next("rate-limit");
      expect(events.filter((e) => e.type === "message.finished")).toHaveLength(
        1,
      );
    }),
  ));

// A completed content block is not a completed model response. Stop must not promote it.
test("R9-F2 stopping an incomplete model response emits no message.finished", () =>
  run((f, s, events, next) =>
    Effect.gen(function* () {
      yield* s.startTurn(start);
      const before = (yield* s.continuation).resumePoint;
      yield* send(f, [begin(), blockMessage("message-1", chain)]);
      yield* barrier(f);
      yield* next("rate-limit");
      yield* s.interruptTurn({ turnId: "one", reason: "stop" });
      expect(yield* next("turn.finished")).toMatchObject({
        outcome: { status: "interrupted", reason: "stop" },
      });
      expect(events.filter((e) => e.type === "message.finished")).toHaveLength(
        0,
      );
      expect((yield* s.continuation).resumePoint).toBe(before);
    }),
  ));

// A continuing call must not expose steers that survive a sibling's endTurn.
test("R9-F3 mixed parallel tool outcomes discard the held steer before endTurn", () => {
  const bothStarted = Promise.withResolvers<void>();
  const continueRelease = Promise.withResolvers<void>();
  const endRelease = Promise.withResolvers<void>();
  let running = 0;
  return run(
    (f, s, events, next) =>
      Effect.gen(function* () {
        const client = yield* connect(f);
        yield* s.startTurn(start);
        yield* send(f, [
          begin(),
          blockMessage("message-1", chain, [
            { id: "call-continue", name: "mcp__neuve__work", input: {} },
            { id: "call-end", name: "mcp__neuve__work", input: {} },
          ]),
          end("tool_use"),
          stop(),
        ]);
        yield* next("tool.started");
        yield* next("tool.started");
        const invoke = (id: string) =>
          Effect.promise(() =>
            client.callTool({
              name: "work",
              arguments: {},
              _meta: { [TOOL_USE_ID_META]: id },
            }),
          ).pipe(Effect.forkScoped);
        const continuing = yield* invoke("call-continue");
        const ending = yield* invoke("call-end");
        yield* Effect.promise(() => bothStarted.promise);
        yield* s.steerTurn({ turnId: "one", message: "fixture" });
        expect(f.sends).toHaveLength(1);
        continueRelease.resolve();
        yield* Fiber.join(continuing);
        expect(f.sends).toHaveLength(1);
        endRelease.resolve();
        expect(yield* Fiber.join(ending)).toMatchObject({
          _meta: { "claude/endTurn": true },
        });
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
        expect(yield* s.diagnostics).toMatchObject({ discardedSteers: 1 });
      }),
    {
      policy: {
        ...policy,
        tools: [
          definition((_input, call) =>
            Effect.gen(function* () {
              if (++running === 2) bothStarted.resolve();
              const ending = call?.callId === "call-end";
              yield* Effect.promise(() =>
                ending ? endRelease.promise : continueRelease.promise,
              );
              return {
                text: "fixture",
                ...(ending ? { endTurn: true as const } : {}),
              };
            }),
          ),
        ],
      },
    },
  ).finally(() => {
    continueRelease.resolve();
    endRelease.resolve();
  });
});

for (const scenario of [
  { name: "second ends", ends: true, between: false },
  { name: "both continue", ends: false, between: false },
  { name: "steer arrives between calls", ends: true, between: true },
]) {
  test(`R9-F3 serial calls: ${scenario.name}`, () =>
    run(
      (f, s, _events, next) =>
        Effect.gen(function* () {
          const client = yield* connect(f);
          yield* s.startTurn(start);
          yield* send(f, [
            begin(),
            blockMessage("message-1", chain, [
              { id: "call-continue", name: "mcp__neuve__work", input: {} },
              { id: "call-last", name: "mcp__neuve__work", input: {} },
            ]),
            end("tool_use"),
            stop(),
          ]);
          yield* next("tool.started");
          yield* next("tool.started");
          if (!scenario.between)
            yield* s.steerTurn({ turnId: "one", message: "held" });
          const invoke = (id: string) =>
            Effect.promise(() =>
              client.callTool({
                name: "work",
                arguments: {},
                _meta: { [TOOL_USE_ID_META]: id },
              }),
            );
          yield* invoke("call-continue");
          expect(f.sends).toHaveLength(1);
          if (scenario.between)
            yield* s.steerTurn({ turnId: "one", message: "held" });
          const reply = yield* invoke("call-last");
          expect(f.sends.map((m) => m.message.content)).toEqual(
            scenario.ends ? ["fixture"] : ["fixture", "held"],
          );
          if (scenario.ends)
            expect(reply).toMatchObject({ _meta: { "claude/endTurn": true } });
          yield* send(f, [
            result({
              user_message_uuid: f.sends[0]!.uuid!,
              user_message_uuids: [f.sends[0]!.uuid!],
              queued_turn_count: scenario.ends ? 0 : 1,
            }),
          ]);
          if (!scenario.ends)
            yield* send(f, [
              result({
                user_message_uuid: f.sends[1]!.uuid!,
                user_message_uuids: [f.sends[1]!.uuid!],
                queued_turn_count: 0,
              }),
            ]);
          expect(yield* next("turn.finished")).toMatchObject({
            outcome: { status: "completed" },
          });
          expect(yield* s.diagnostics).toMatchObject({
            discardedSteers: scenario.ends ? 1 : 0,
          });
        }),
      {
        policy: {
          ...policy,
          tools: [
            definition((_input, call) =>
              Effect.succeed({
                text: "fixture",
                ...(scenario.ends && call?.callId === "call-last"
                  ? { endTurn: true as const }
                  : {}),
              }),
            ),
          ],
        },
      },
    ));
}

// Why: any MCP error flag can override a sibling's endTurn. Tool failures stay in the text
// and runtime events, while only the ending result carries the marker.
for (const ending of [true, false])
  test(`errored tool result ${ending ? "ending" : "continuing"} the turn omits the MCP error flag`, () =>
    run(
      (f, s, events, next) =>
        Effect.gen(function* () {
          const client = yield* connect(f);
          yield* s.startTurn(start);
          yield* send(f, [
            begin(),
            blockMessage("message-1", chain, [
              { id: "call-refused", name: "mcp__neuve__work", input: {} },
            ]),
            end("tool_use"),
            stop(),
          ]);
          yield* next("tool.started");
          const reply = yield* Effect.promise(() =>
            client.callTool({
              name: "work",
              arguments: {},
              _meta: { [TOOL_USE_ID_META]: "call-refused" },
            }),
          );
          expect(reply).toEqual({
            content: [{ type: "text", text: "Not submitted." }],
            isError: false,
            ...(ending ? { _meta: { "claude/endTurn": true } } : {}),
          });
          expect(yield* next("tool.finished")).toMatchObject({
            callId: "call-refused",
            errored: true,
          });
          if (!ending) return;
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
          expect(
            events.filter((event) => event.type === "message.finished"),
          ).toHaveLength(1);
        }),
      {
        policy: {
          ...policy,
          tools: [
            definition(() =>
              Effect.succeed({
                text: "Not submitted.",
                error: "CheckFailed",
                ...(ending ? { endTurn: true as const } : {}),
              }),
            ),
          ],
        },
      },
    ));

// Why: Claude Code lets any errored sibling override claude/endTurn, even if it returned first.
for (const errorFirst of [true, false])
  test(`end-turn survives a failed sibling returned ${errorFirst ? "before" : "after"} it`, () =>
    run(
      (f, s, events, next) =>
        Effect.gen(function* () {
          const client = yield* connect(f);
          yield* s.startTurn(start);
          yield* send(f, [
            begin(),
            blockMessage("message-1", chain, [
              { id: "failed", name: "mcp__neuve__work", input: {} },
              { id: "ending", name: "mcp__neuve__work", input: {} },
            ]),
            end("tool_use"),
            stop(),
          ]);
          yield* next("message.finished");
          for (const callId of errorFirst
            ? ["failed", "ending"]
            : ["ending", "failed"]) {
            const reply = yield* Effect.promise(() =>
              client.callTool({
                name: "work",
                arguments: {},
                _meta: { [TOOL_USE_ID_META]: callId },
              }),
            );
            expect(reply).toEqual({
              content: [
                {
                  type: "text",
                  text: callId === "failed" ? "Lookup refused." : "Submitted.",
                },
              ],
              isError: false,
              ...(callId === "ending"
                ? { _meta: { "claude/endTurn": true } }
                : {}),
            });
          }
          yield* send(f, [result()]);
          expect(yield* next("turn.finished")).toMatchObject({
            outcome: { status: "completed" },
          });
          expect(
            events.filter((event) => event.type === "tool.finished"),
          ).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ callId: "failed", errored: true }),
              expect.objectContaining({ callId: "ending", errored: false }),
            ]),
          );
        }),
      {
        policy: {
          ...policy,
          tools: [
            definition((_input, call) =>
              Effect.succeed(
                call?.callId === "failed"
                  ? { text: "Lookup refused.", error: "LookupFailed" }
                  : { text: "Submitted.", endTurn: true },
              ),
            ),
          ],
        },
      },
    ));
