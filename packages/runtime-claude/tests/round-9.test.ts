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
  type ToolCall,
} from "@neuve/runtime";
import { Deferred, Effect, Fiber, Layer, Queue, Stream } from "effect";
import { makeRuntime } from "../src/runtime.ts";
import { FINAL_TURN_MESSAGES } from "../src/session.ts";
import { ClaudeExecutable, ClaudeProcess, ClaudeSdk } from "../src/services.ts";
import { TOOL_USE_ID_INPUT, TOOL_USE_ID_META } from "../src/tools.ts";
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
              }),
            applyFlagSettings: (settings) =>
              Effect.sync(() => {
                controls.push(["flags", settings]);
              }),
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
  return { children, sends, controls, runtime };
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

test("R9 continuation uses only resolved folder identity and distinguishes folders", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const folder = (value: string) =>
          Account.parse({
            ...account,
            credential: { kind: "claude-config-folder", folder: value },
          });
        expect(f.runtime.continuation(account)).toEqual({
          runtime: "claude-code",
          key: "default",
        });
        expect(f.runtime.continuation(folder("/test/one/../one"))).toEqual({
          runtime: "claude-code",
          key: "/test/one",
        });
        expect(f.runtime.continuation(folder("/test/two")).key).not.toBe(
          f.runtime.continuation(folder("/test/one")).key,
        );
      }),
    ),
  ));

test("R9 capabilities advertise the five newly supported operations", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        expect(yield* f.runtime.capabilities(account)).toEqual({
          ownsLoop: true,
          resume: true,
          fork: true,
          interrupt: true,
          modelSwitchInSession: true,
          structuredOutput: true,
          steering: true,
          approvals: true,
          nativeToolServer: true,
          statusProbe: true,
          internalRetries: true,
          perRequestTelemetry: false,
          byteExactCapture: false,
        });
      }),
    ),
  ));

test("R9 resume passes point and assigns the fork its own session id", () =>
  run(
    (f, s, _, next) =>
      Effect.gen(function* () {
        expect(f.children[0]!.options).toMatchObject({
          resume: SESSION_ID,
          resumeSessionAt: chain,
          forkSession: true,
        });
        expect(f.children[0]!.options.sessionId).toBe(s.nativeSessionId);
        expect(s.nativeSessionId).not.toBe(SESSION_ID);
        yield* s.startTurn(start);
        yield* send(f, [
          {
            type: "system",
            subtype: "init",
            session_id: lastChain,
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
          },
          result(),
        ]);
        yield* next("turn.finished");
        expect(s.nativeSessionId).toBe(lastChain);
      }),
    { start: { kind: "resume", session: SESSION_ID, at: chain, fork: true } },
  ));

test("R9 native id getter follows reset and the next child resumes that conversation", () =>
  run(
    (f, s, _, next) =>
      Effect.gen(function* () {
        yield* s.startTurn(start);
        yield* send(f, [
          {
            type: "conversation_reset",
            new_conversation_id: lastChain,
            session_id: lastChain,
            uuid: crypto.randomUUID(),
            trigger: "clear",
          },
          result(),
        ]);
        yield* next("turn.finished");
        expect(s.nativeSessionId).toBe(lastChain);
        yield* s.startTurn({ turnId: "two", message: "final", final: true });
        expect(f.children[1]!.options.resume).toBe(lastChain);
      }),
    { policy: { ...policy, outputSchema: { type: "object" } } },
  ));

test("R9 resumed first turn uses request streams then subtracts the established ledger", () =>
  run(
    (f, s, events, next) =>
      Effect.gen(function* () {
        yield* s.startTurn(start);
        yield* send(f, [
          begin(),
          blockMessage("message-1", chain),
          end(),
          stop(),
          result({ modelUsage: { "test-model": usage(111, 107) } }),
        ]);
        yield* next("turn.finished");
        expect(
          events.filter((e) => e.type === "usage").map((e) => e.usage),
        ).toEqual([
          {
            input: 11,
            output: 7,
            cacheRead: 3,
            cacheWrite5m: 1,
            cacheWrite1h: 3,
          },
        ]);
        expect(
          events.find((e) => e.type === "message.finished")?.usage,
        ).toEqual(events.find((e) => e.type === "usage")?.usage);
        yield* s.startTurn({ ...start, turnId: "two" });
        yield* send(f, [
          result({ modelUsage: { "test-model": usage(116, 110) } }),
        ]);
        yield* next("turn.finished");
        expect(
          events
            .filter((e) => e.type === "usage")
            .map((e) => [e.usage.input, e.usage.output]),
        ).toEqual([
          [11, 7],
          [5, 3],
        ]);
      }),
    { start: { kind: "resume", session: SESSION_ID, fork: false } },
  ));

test("R9 start and steer preserve text and base64 image media types", () =>
  run((f, s) =>
    Effect.gen(function* () {
      const content = [
        { type: "text" as const, text: "fixture" },
        {
          type: "image" as const,
          mimeType: "image/png" as const,
          data: "AQID",
        },
      ];
      yield* s.startTurn({ ...start, message: content });
      yield* s.steerTurn({ ...start, message: content });
      const expected: SDKUserMessage["message"]["content"] = [
        { type: "text", text: "fixture" },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "AQID" },
        },
      ];
      expect(f.sends.map((m) => m.message.content)).toEqual([
        expected,
        expected,
      ]);
      expect(f.sends[1]!.priority).toBe("now");
    }),
  ));

for (const [reason, expected] of [
  ["end_turn", "end-turn"],
  ["tool_use", "tool-use"],
  ["max_tokens", "max-tokens"],
  ["refusal", "refusal"],
  ["stop_sequence", "other"],
] as const) {
  test(`R9 message.finished maps ${reason} and keeps final block UUID and stream usage`, () =>
    run((f, s, events, next) =>
      Effect.gen(function* () {
        yield* s.startTurn(start);
        yield* send(f, [
          begin(),
          blockMessage("message-1", chain),
          blockMessage("message-1", lastChain),
          end(reason),
          stop(),
          result(),
        ]);
        yield* next("turn.finished");
        expect(events.filter((e) => e.type === "message.finished")).toEqual([
          {
            type: "message.finished",
            turnId: "one",
            at: expect.any(String),
            messageId: "message-1",
            resumePoint: lastChain,
            stopReason: expected,
            toolCalls: [],
            model: "test-model",
            usage: {
              input: 11,
              output: 7,
              cacheRead: 3,
              cacheWrite5m: 1,
              cacheWrite1h: 3,
            },
          },
        ]);
      }),
    ));
}

test("R9 tool.started occurs at completed model call before handler and never duplicates", () =>
  run(
    (f, s, events, next) =>
      Effect.gen(function* () {
        const client = yield* connect(f);
        yield* s.startTurn(start);
        const call = {
          id: "call-1",
          name: "mcp__neuve__work",
          input: { raw: 12 },
        };
        yield* send(f, [
          begin(),
          partial({
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "tool_use",
              id: call.id,
              name: call.name,
              input: {},
            },
          }),
          partial({
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: '{"raw":12}' },
          }),
          partial({ type: "content_block_stop", index: 0 }),
        ]);
        expect(yield* next("tool.started")).toMatchObject({
          callId: "call-1",
          toolName: "work",
          input: { raw: 12 },
        });
        yield* send(f, [
          blockMessage("message-1", chain, [call]),
          end("tool_use"),
          stop(),
        ]);
        yield* Effect.promise(() =>
          client.callTool({
            name: "work",
            arguments: { raw: 12 },
            _meta: { [TOOL_USE_ID_META]: "call-1" },
          }),
        );
        yield* send(f, [result()]);
        yield* next("turn.finished");
        expect(events.filter((e) => e.type === "tool.started")).toHaveLength(1);
        expect(
          events.filter((e) => e.type === "message.finished")[0]?.toolCalls,
        ).toEqual([{ callId: "call-1", toolName: "work", input: { raw: 12 } }]);
      }),
    {
      policy: {
        ...policy,
        tools: [definition(() => Effect.succeed({ text: "fixture" }))],
      },
    },
  ));

for (const route of ["meta", "hook"] as const) {
  test(`R9 ToolCall passes the ${route} native id and Stop aborts the handler signal`, () => {
    let call: ToolCall | undefined;
    const entered = Promise.withResolvers<void>();
    return run(
      (f, s, _, next) =>
        Effect.gen(function* () {
          const client = yield* connect(f);
          yield* s.startTurn(start);
          const input: Record<string, unknown> = { raw: 1 };
          if (route === "hook") {
            const hook =
              f.children[0]!.options.hooks?.PreToolUse?.[0]?.hooks[0];
            if (hook === undefined) throw new Error("fixture");
            yield* Effect.promise(() =>
              hook(
                {
                  hook_event_name: "PreToolUse",
                  session_id: SESSION_ID,
                  transcript_path: "/unused",
                  cwd: "/test",
                  tool_name: "mcp__neuve__work",
                  tool_input: input,
                  tool_use_id: "native-id",
                },
                "native-id",
                { signal: new AbortController().signal },
              ),
            );
            input[TOOL_USE_ID_INPUT] = "native-id";
          }
          const pending = client.callTool({
            name: "work",
            arguments: input,
            ...(route === "meta"
              ? { _meta: { [TOOL_USE_ID_META]: "native-id" } }
              : {}),
          });
          yield* Effect.promise(() => entered.promise);
          expect(call?.callId).toBe("native-id");
          expect(call?.signal.aborted).toBe(false);
          yield* s.interruptTurn({ turnId: "one", reason: "stop" });
          yield* next("turn.finished");
          expect(call?.signal.aborted).toBe(true);
          yield* Effect.promise(() => pending);
        }),
      {
        policy: {
          ...policy,
          tools: [
            definition((input, context) =>
              Effect.sync(() => {
                expect(input).toEqual({ raw: 1 });
                call = context;
                entered.resolve();
              }).pipe(Effect.andThen(Effect.never)),
            ),
          ],
        },
      },
    );
  });
}

for (const stray of [false, true]) {
  test(`R9 endTurn ${stray ? "closes stray root output and records a protocol fault" : "returns MCP metadata and completes at the result carrier"}`, () =>
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
          const reply = yield* Effect.promise(() =>
            client.callTool({
              name: "work",
              arguments: {},
              _meta: { [TOOL_USE_ID_META]: "call-1" },
            }),
          );
          expect(reply).toMatchObject({
            _meta: { "claude/endTurn": true },
            content: [{ type: "text", text: "fixture" }],
          });
          yield* send(f, [
            {
              type: "user",
              parent_tool_use_id: null,
              uuid: lastChain,
              session_id: SESSION_ID,
              message: {
                role: "user",
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: "call-1",
                    content: "fixture",
                  },
                ],
              },
            },
            ...(stray
              ? [begin("stray")]
              : [result({ modelUsage: { "test-model": usage(11, 7) } })]),
          ]);
          expect(yield* next("turn.finished")).toMatchObject({
            outcome: { status: "completed" },
          });
          expect(events.filter((e) => e.type === "turn.finished")).toHaveLength(
            1,
          );
          expect(
            events.filter((e) => e.type === "message.finished")[0]?.resumePoint,
          ).toBe(chain);
          expect((yield* s.continuation).resumePoint).toBe(lastChain);
          if (stray) {
            expect(f.children[0]!.closed).toBe(true);
            expect(
              yield* s.startTurn({ ...start, turnId: "two" }).pipe(Effect.flip),
            ).toMatchObject({ reason: "protocol-error" });
          }
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

test("R9 turnLimit counts completed messages, closes without maxTurns and stays reusable", () =>
  run(
    (f, s, events, next) =>
      Effect.gen(function* () {
        expect(f.children[0]!.options.maxTurns).toBeUndefined();
        yield* s.startTurn(start);
        yield* send(f, [
          begin(),
          blockMessage("message-1", chain),
          end(),
          stop(),
          begin("message-2", 13),
          blockMessage("message-2", lastChain),
          end(),
          stop(),
          begin("past-limit"),
        ]);
        expect(yield* next("turn.finished")).toMatchObject({
          outcome: {
            status: "failed",
            disposition: "reusable",
            failure: { reason: "turn-limit-reached" },
          },
        });
        expect(
          events.filter((e) => e.type === "message.finished"),
        ).toHaveLength(2);
        expect(f.children[0]!.closed).toBe(true);
        yield* s.startTurn({ ...start, turnId: "two" });
        expect(f.children).toHaveLength(2);
        expect(f.children[1]!.options.resume).toBe(s.nativeSessionId);
        yield* send(f, [
          begin("message-3", 5),
          blockMessage("message-3", lastChain),
          end(),
          stop(),
          result({ modelUsage: { "test-model": usage(29, 21) } }),
        ]);
        expect(yield* next("turn.finished")).toMatchObject({
          outcome: { status: "completed" },
        });
        expect(
          events
            .filter((event) => event.type === "usage")
            .map((event) => [event.turnId, event.usage.input]),
        ).toEqual([
          ["one", 24],
          ["two", 5],
        ]);
      }),
    { policy: { ...policy, turnLimit: TurnLimit.parse(2) } },
  ));

test("R9 setModel sends id then effort and stopped sessions fail", () =>
  run((f, s, _, next) =>
    Effect.gen(function* () {
      yield* s.setModel({ id: "next-model", effort: "high" });
      expect(f.controls).toEqual([
        ["model", "next-model"],
        ["flags", { effortLevel: "high" }],
      ]);
      yield* s.startTurn(start);
      yield* Queue.shutdown(f.children[0]!.frames);
      yield* next("turn.finished");
      expect(
        yield* s.setModel({ id: "other", effort: "low" }).pipe(Effect.flip),
      ).toMatchObject({ reason: "session-stopped" });
    }),
  ));

test("R9 cancellation of an MCP request aborts ToolCall without stopping the session", () => {
  let call: ToolCall | undefined;
  const entered = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  return run(
    (f, s, _, next) =>
      Effect.gen(function* () {
        const client = yield* connect(f);
        yield* s.startTurn(start);
        const controller = new AbortController();
        const pending = client
          .callTool(
            {
              name: "work",
              arguments: {},
              _meta: { [TOOL_USE_ID_META]: "cancelled-call" },
            },
            undefined,
            { signal: controller.signal },
          )
          .catch(() => undefined);
        yield* Effect.promise(() => entered.promise);
        controller.abort();
        yield* Effect.promise(() => cancelled.promise);
        expect(call?.signal.aborted).toBe(true);
        yield* Effect.promise(() => pending);
        yield* send(f, [result()]);
        expect(yield* next("turn.finished")).toMatchObject({
          outcome: { status: "completed" },
        });
      }),
    {
      policy: {
        ...policy,
        tools: [
          definition((_, context) =>
            Effect.sync(() => {
              call = context;
              entered.resolve();
            }).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Effect.sync(() => cancelled.resolve())),
            ),
          ),
        ],
      },
    },
  );
});

test("R9 session scope closure aborts an outstanding ToolCall and closes its child", () => {
  let call: ToolCall | undefined;
  let child: Fixture["children"][number] | undefined;
  let pending: Promise<unknown> | undefined;
  const entered = Promise.withResolvers<void>();
  return run(
    (f, s) =>
      Effect.gen(function* () {
        const client = yield* connect(f);
        yield* s.startTurn(start);
        child = f.children[0];
        pending = client
          .callTool({
            name: "work",
            arguments: {},
            _meta: { [TOOL_USE_ID_META]: "closing-call" },
          })
          .catch(() => undefined);
        yield* Effect.promise(() => entered.promise);
        expect(call?.signal.aborted).toBe(false);
      }),
    {
      policy: {
        ...policy,
        tools: [
          definition((_, context) =>
            Effect.sync(() => {
              call = context;
              entered.resolve();
            }).pipe(Effect.andThen(Effect.never)),
          ),
        ],
      },
    },
  ).then(async () => {
    expect(call?.signal.aborted).toBe(true);
    expect(child?.closed).toBe(true);
    await pending;
  });
});

test("R9 a new session gets its own UUID", () =>
  run((f, s) =>
    Effect.gen(function* () {
      const second = yield* f.runtime.openSession(account, policy, {
        kind: "new",
      });
      expect(second.nativeSessionId).not.toBe(s.nativeSessionId);
      expect(f.children.map((child) => child.options.sessionId)).toEqual([
        s.nativeSessionId,
        second.nativeSessionId,
      ]);
    }),
  ));

test("R9 switched model and effort survive the final-query reopen", () =>
  run(
    (f, s, _, next) =>
      Effect.gen(function* () {
        yield* s.setModel({ id: "switched-model", effort: "low" });
        yield* s.startTurn(start);
        yield* send(f, [result()]);
        yield* next("turn.finished");
        yield* s.startTurn({ ...start, turnId: "final", final: true });
        expect(f.children[1]!.options).toMatchObject({
          model: "switched-model",
          effort: "low",
        });
      }),
    { policy: { ...policy, outputSchema: { type: "object" } } },
  ));

test("R9 subagent message streams do not count against the root backstop", () =>
  run(
    (f, s, events, next) =>
      Effect.gen(function* () {
        yield* s.startTurn(start);
        yield* send(
          f,
          [begin(), blockMessage("message-1", chain), end(), stop()].map(
            (frame) => ({ ...frame, parent_tool_use_id: "subagent" }),
          ),
        );
        yield* send(f, [result()]);
        expect(yield* next("turn.finished")).toMatchObject({
          outcome: { status: "completed" },
        });
        expect(
          events.filter((event) => event.type === "message.finished"),
        ).toHaveLength(0);
      }),
    { policy: { ...policy, turnLimit: TurnLimit.parse(1) } },
  ));

for (const boundary of [
  "assistant-id",
  "assistant-uuid",
  "stream-id",
  "json-delta",
  "carrier-uuid",
] as const) {
  test(`R9 malformed ${boundary} fails as a protocol fault before emitting invalid message data`, () =>
    run((f, s, _, next) =>
      Effect.gen(function* () {
        yield* s.startTurn(start);
        let frame: SDKMessage;
        if (boundary === "assistant-id" || boundary === "assistant-uuid") {
          frame = assistant(undefined);
          if (boundary === "assistant-id") Reflect.set(frame.message, "id", 17);
          else Reflect.deleteProperty(frame, "uuid");
        } else if (boundary === "stream-id") {
          frame = begin();
          if (frame.event.type === "message_start")
            Reflect.set(frame.event.message, "id", 17);
        } else if (boundary === "json-delta") {
          frame = partial({
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: "{}" },
          });
          if (frame.event.type === "content_block_delta")
            Reflect.set(frame.event.delta, "partial_json", {});
        } else {
          frame = {
            type: "user",
            parent_tool_use_id: null,
            uuid: crypto.randomUUID(),
            message: { role: "user", content: "fixture" },
          };
          Reflect.set(frame, "uuid", 17);
        }
        yield* send(f, [frame]);
        expect(yield* next("turn.finished")).toMatchObject({
          outcome: {
            status: "failed",
            disposition: "broken",
            failure: { reason: "protocol-error" },
          },
        });
      }),
    ));
}

test("R9 Stop still publishes a model message that completed before its handler result", () =>
  run((f, s, events, next) =>
    Effect.gen(function* () {
      yield* s.startTurn(start);
      yield* send(f, [
        begin(),
        blockMessage("message-1", chain),
        end(),
        stop(),
      ]);
      // A following non-model frame provides an ordered delivery barrier without a result ledger.
      yield* send(f, [
        {
          type: "rate_limit_event",
          session_id: SESSION_ID,
          uuid: crypto.randomUUID(),
          rate_limit_info: { status: "allowed" },
        },
      ]);
      yield* next("rate-limit");
      yield* s.interruptTurn({ turnId: "one", reason: "stop" });
      yield* next("turn.finished");
      expect(
        events.filter((event) => event.type === "message.finished"),
      ).toHaveLength(1);
      expect(
        events
          .filter((event) => event.type === "usage")
          .map((event) => event.usage.input),
      ).toEqual([11]);
    }),
  ));

test("R9 endTurn stays completed when disposal exceeds its deadline", () => {
  const release = Promise.withResolvers<void>();
  return run(
    (f, s, _, next) =>
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
        yield* Effect.promise(() =>
          client.callTool({
            name: "work",
            arguments: {},
            _meta: { [TOOL_USE_ID_META]: "call-1" },
          }),
        );
        f.children[0]!.closeWait = release.promise;
        yield* send(f, [begin("stray")]);
        expect(yield* next("turn.finished")).toMatchObject({
          outcome: { status: "completed" },
        });
        release.resolve();
      }),
    {
      policy: {
        ...policy,
        tools: [
          definition(() => Effect.succeed({ text: "fixture", endTurn: true })),
        ],
      },
    },
  ).finally(() => release.resolve());
});

// A streamed handler may await publication only after the producer independently delivers message_stop.
for (const mode of ["stream-stop", "stream-handler", "no-stream"] as const) {
  const streamed = mode !== "no-stream";
  test(`R9b a handler waiting on its message.finished completes with ${mode}`, () => {
    const published = Promise.withResolvers<void>();
    return run(
      (f, s, events, next) =>
        Effect.gen(function* () {
          const client = yield* connect(f);
          yield* s.startTurn(start);
          yield* send(f, [
            ...(streamed ? [begin()] : []),
            blockMessage("message-1", chain, [
              { id: "call-1", name: "mcp__neuve__work", input: {} },
            ]),
            ...(streamed ? [end("tool_use")] : []),
            ...(mode === "stream-stop" ? [stop()] : []),
          ]);
          yield* next("tool.started");
          const reply = yield* Effect.forkScoped(
            Effect.promise(() =>
              client.callTool({
                name: "work",
                arguments: {},
                _meta: { [TOOL_USE_ID_META]: "call-1" },
              }),
            ),
          );
          if (mode === "stream-handler") yield* send(f, [stop()]);
          expect(yield* next("message.finished")).toMatchObject({
            messageId: "message-1",
            resumePoint: chain,
            stopReason: "tool-use",
            toolCalls: [{ callId: "call-1", toolName: "work", input: {} }],
          });
          published.resolve();
          expect(yield* Fiber.join(reply)).toMatchObject({
            content: [{ type: "text", text: "released" }],
          });
          yield* send(f, [result()]);
          yield* next("turn.finished");
          expect(
            events.filter((e) => e.type === "message.finished"),
          ).toHaveLength(1);
        }),
      {
        policy: {
          ...policy,
          tools: [
            definition(() =>
              Effect.promise(() => published.promise).pipe(
                Effect.as({ text: "released" }),
              ),
            ),
          ],
        },
      },
    ).finally(() => published.resolve());
  });
}

// A frame of a published response is a protocol error even after the next response starts.
test("R9b message_stop publishes and a late block after the next message_start fails the turn", () =>
  run((f, s, events, next) =>
    Effect.gen(function* () {
      yield* s.startTurn(start);
      yield* send(f, [
        begin(),
        blockMessage("message-1", chain),
        end(),
        stop(),
        begin("message-2"),
      ]);
      expect(yield* next("message.finished")).toMatchObject({
        resumePoint: chain,
      });
      yield* send(f, [blockMessage("message-1", lastChain)]);
      expect(yield* next("turn.finished")).toMatchObject({
        outcome: { status: "failed", failure: { reason: "protocol-error" } },
      });
      expect((yield* s.continuation).resumePoint).toBe(chain);
      expect(yield* s.diagnostics).not.toHaveProperty("lateAssistantFrames");
      expect(events.filter((e) => e.type === "message.finished")).toHaveLength(
        1,
      );
      expect(f.children[0]!.closed).toBe(true);
    }),
  ));

// Repeated handler entries and later message completion must not replay an event.
test("R9b parallel calls publish each root message exactly once", () =>
  run(
    (f, s, events, next) =>
      Effect.gen(function* () {
        const client = yield* connect(f);
        yield* s.startTurn(start);
        yield* send(f, [
          blockMessage("message-1", chain, [
            { id: "call-1", name: "mcp__neuve__work", input: { first: true } },
          ]),
          blockMessage("message-1", lastChain, [
            { id: "call-2", name: "mcp__neuve__work", input: { first: false } },
          ]),
        ]);
        yield* next("tool.started");
        yield* next("tool.started");
        yield* Effect.promise(() =>
          Promise.all(
            ["call-1", "call-2"].map((callId) =>
              client.callTool({
                name: "work",
                arguments: {},
                _meta: { [TOOL_USE_ID_META]: callId },
              }),
            ),
          ),
        );
        expect(yield* next("message.finished")).toMatchObject({
          messageId: "message-1",
          resumePoint: lastChain,
          toolCalls: [
            { callId: "call-1", toolName: "work", input: { first: true } },
            { callId: "call-2", toolName: "work", input: { first: false } },
          ],
        });
        yield* send(f, [
          begin("message-2"),
          blockMessage("message-2", chain),
          end(),
          stop(),
          result(),
        ]);
        yield* next("turn.finished");
        expect(
          events
            .filter((e) => e.type === "message.finished")
            .map((e) => e.messageId),
        ).toEqual(["message-1", "message-2"]);
      }),
    {
      policy: {
        ...policy,
        tools: [definition(() => Effect.succeed({ text: "fixture" }))],
      },
    },
  ));

// The id guard must survive moving to another root message, including end-turn handlers.
for (const endedByTool of [false, true]) {
  test(`R9b a late assistant frame after handler publication fails the turn with endTurn=${endedByTool}`, () =>
    run(
      (f, s, events, next) =>
        Effect.gen(function* () {
          const client = yield* connect(f);
          yield* s.startTurn(start);
          yield* send(f, [
            blockMessage("message-1", chain, [
              { id: "call-1", name: "mcp__neuve__work", input: {} },
            ]),
          ]);
          yield* next("tool.started");
          yield* Effect.promise(() =>
            client.callTool({
              name: "work",
              arguments: {},
              _meta: { [TOOL_USE_ID_META]: "call-1" },
            }),
          );
          yield* next("message.finished");
          yield* send(f, [
            ...(!endedByTool ? [begin("message-2")] : []),
            blockMessage("message-1", lastChain),
          ]);
          expect(yield* next("turn.finished")).toMatchObject({
            outcome: {
              status: "failed",
              failure: { reason: "protocol-error" },
            },
          });
          expect((yield* s.continuation).resumePoint).toBe(chain);
          expect(yield* s.diagnostics).not.toHaveProperty(
            "lateAssistantFrames",
          );
          expect(
            events.filter((e) => e.type === "message.finished"),
          ).toHaveLength(1);
          expect(f.children[0]!.closed).toBe(true);
        }),
      {
        policy: {
          ...policy,
          tools: [
            definition(() =>
              Effect.succeed({
                text: "fixture",
                ...(endedByTool ? { endTurn: true as const } : {}),
              }),
            ),
          ],
        },
      },
    ));
}

// A post-turn query and a fork must retain the tool result rather than its assistant call.
test("R9b the public end-turn carrier checkpoint drives resume and fork", () =>
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
        yield* Effect.promise(() =>
          client.callTool({
            name: "work",
            arguments: {},
            _meta: { [TOOL_USE_ID_META]: "call-1" },
          }),
        );
        yield* send(f, [
          {
            type: "user",
            parent_tool_use_id: null,
            uuid: lastChain,
            session_id: SESSION_ID,
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "call-1",
                  content: "fixture",
                },
              ],
            },
          },
          result(),
        ]);
        expect(yield* next("turn.finished")).toMatchObject({
          resumePoint: lastChain,
        });
        expect(
          events
            .filter((e) => e.type === "message.finished")
            .map((e) => e.resumePoint),
        ).toEqual([chain]);
        const saved = yield* s.continuation;
        expect(saved.resumePoint).toBe(lastChain);
        const fork = yield* f.runtime.openSession(account, policy, {
          kind: "resume",
          session: saved.sessionId,
          at: saved.resumePoint,
          fork: true,
        });
        expect(f.children[1]!.options).toMatchObject({
          resume: saved.sessionId,
          resumeSessionAt: lastChain,
          forkSession: true,
        });
        expect(fork.nativeSessionId).not.toBe(saved.sessionId);
        expect(f.children[1]!.options.sessionId).toBe(fork.nativeSessionId);
        yield* s.startTurn({ turnId: "two", message: "final", final: true });
        expect(f.children[2]!.options).toMatchObject({
          resume: saved.sessionId,
          resumeSessionAt: lastChain,
          outputFormat: { type: "json_schema" },
        });
      }),
    {
      policy: {
        ...policy,
        outputSchema: { type: "object" },
        tools: [
          definition(() => Effect.succeed({ text: "fixture", endTurn: true })),
        ],
      },
    },
  ));

// Result is the completion fallback when a producer supplies only block frames.
test("R9b result completes a root message without a stop event or handler", () =>
  run((f, s, events, next) =>
    Effect.gen(function* () {
      yield* s.startTurn(start);
      yield* send(f, [blockMessage("message-1", chain), result()]);
      yield* next("turn.finished");
      expect(events.filter((e) => e.type === "message.finished")).toEqual([
        expect.objectContaining({ messageId: "message-1", resumePoint: chain }),
      ]);
    }),
  ));

// Completion cannot invent a resumable chain id from a stream-event envelope.
test("R9b a result without any assistant chain frame ends with protocol-error", () =>
  run((f, s, events, next) =>
    Effect.gen(function* () {
      yield* s.startTurn(start);
      yield* send(f, [begin(), end(), stop(), result()]);
      expect(yield* next("turn.finished")).toMatchObject({
        outcome: {
          status: "failed",
          disposition: "broken",
          failure: { reason: "protocol-error" },
        },
      });
      expect(events.filter((e) => e.type === "message.finished")).toHaveLength(
        0,
      );
      expect(f.children[0]!.closed).toBe(true);
    }),
  ));

// Ruling 30: a one-round stage must execute its submit before the backstop can end it.
test("R18 turnLimit one admits the submit and completes with its carrier", () => {
  let submitted = 0;
  return run(
    (f, s, events, next) =>
      Effect.gen(function* () {
        const client = yield* connect(f);
        yield* s.startTurn(start);
        yield* send(f, [
          begin(),
          blockMessage("message-1", chain, [
            { id: "submit", name: "mcp__neuve__work", input: {} },
          ]),
          end("tool_use"),
          stop(),
        ]);
        yield* next("message.finished");
        const reply = yield* Effect.promise(() =>
          client.callTool({
            name: "work",
            arguments: {},
            _meta: { [TOOL_USE_ID_META]: "submit" },
          }),
        );
        expect(submitted).toBe(1);
        expect(reply).toMatchObject({
          content: [{ type: "text", text: "submitted" }],
          isError: false,
        });
        yield* send(f, [
          {
            type: "user",
            parent_tool_use_id: null,
            uuid: lastChain,
            session_id: SESSION_ID,
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "submit",
                  content: "submitted",
                },
              ],
            },
          },
          result(),
        ]);
        expect(yield* next("turn.finished")).toMatchObject({
          outcome: { status: "completed" },
          resumePoint: lastChain,
        });
        expect((yield* s.continuation).resumePoint).toBe(lastChain);
        expect(
          events.filter((event) => event.type === "turn.finished"),
        ).toHaveLength(1);
      }),
    {
      policy: {
        ...policy,
        turnLimit: TurnLimit.parse(1),
        tools: [
          definition(() =>
            Effect.sync(() => {
              submitted++;
              return { text: "submitted", endTurn: true };
            }),
          ),
        ],
      },
    },
  );
});

// Ruling 30: final generation must consume the result following its allowed StructuredOutput message.
test("R18 turnLimit one final message returns structured output", () =>
  run(
    (f, s, events, next) =>
      Effect.gen(function* () {
        yield* s.startTurn({ ...start, final: true });
        yield* send(f, [
          begin(),
          blockMessage("message-1", chain, [
            {
              id: "structured",
              name: "StructuredOutput",
              input: { answer: 3 },
            },
          ]),
          end("tool_use"),
          stop(),
          result({
            structured_output: { answer: 3 },
            modelUsage: { "test-model": usage(11, 7) },
          }),
        ]);
        expect(yield* next("turn.finished")).toMatchObject({
          outcome: { status: "completed", structuredOutput: { answer: 3 } },
        });
        expect(
          events.filter((event) => event.type === "message.finished"),
        ).toHaveLength(1);
        expect(events.filter((event) => event.type === "usage")).toMatchObject([
          { usage: { input: 11, output: 7 } },
        ]);
      }),
    {
      policy: {
        ...policy,
        turnLimit: TurnLimit.parse(1),
        outputSchema: { type: "object" },
      },
    },
  ));

const answer = (id: string, uuid: SDKAssistantMessage["uuid"]) => [
  begin(id),
  blockMessage(id, uuid),
  end(),
  stop(),
];
const structured = (id: string, uuid: SDKAssistantMessage["uuid"]) => [
  begin(id),
  blockMessage(id, uuid, [
    { id: `${id}-call`, name: "StructuredOutput", input: { answer: 3 } },
  ]),
  end("tool_use"),
  stop(),
];
const chainAt = (n: number): SDKAssistantMessage["uuid"] =>
  `00000000-0000-4000-8000-${String(100 + n).padStart(12, "0")}`;

// Why: live, Claude Code often answers a final turn in text and only then calls StructuredOutput,
// so a final turn of a one-turn session must take that second message.
test("R18 turnLimit one final turn takes a text answer, then its StructuredOutput call", () =>
  run(
    (f, s, events, next) =>
      Effect.gen(function* () {
        yield* s.startTurn({ ...start, final: true });
        yield* send(f, [
          ...answer("message-1", chain),
          ...structured("message-2", lastChain),
          result({
            structured_output: { answer: 3 },
            modelUsage: { "test-model": usage(11, 7) },
          }),
        ]);
        expect(yield* next("turn.finished")).toMatchObject({
          outcome: { status: "completed", structuredOutput: { answer: 3 } },
        });
        expect(
          events.filter((event) => event.type === "message.finished"),
        ).toHaveLength(2);
      }),
    {
      policy: {
        ...policy,
        turnLimit: TurnLimit.parse(1),
        outputSchema: { type: "object" },
      },
    },
  ));

// Why: short final turns allow structured-output retries, while longer stages retain their limit.
for (const limit of [1, 3, 8])
  test(`final turn at turnLimit ${limit} stops at its message backstop`, () =>
    run(
      (f, s, events, next) =>
        Effect.gen(function* () {
          yield* s.startTurn({ ...start, final: true });
          for (let n = 1; n <= Math.max(limit, FINAL_TURN_MESSAGES); n++)
            yield* send(f, answer(`message-${n}`, chainAt(n)));
          yield* send(f, [
            {
              type: "rate_limit_event",
              uuid: crypto.randomUUID(),
              session_id: SESSION_ID,
              rate_limit_info: { status: "allowed" },
            },
          ]);
          yield* next("rate-limit");
          expect(
            events.filter((event) => event.type === "turn.finished"),
          ).toHaveLength(0);
          yield* send(f, [begin("forbidden-message")]);
          expect(yield* next("turn.finished")).toMatchObject({
            outcome: {
              status: "failed",
              disposition: "reusable",
              failure: { reason: "turn-limit-reached" },
            },
          });
          expect(
            events.filter((event) => event.type === "message.finished"),
          ).toHaveLength(Math.max(limit, FINAL_TURN_MESSAGES));
        }),
      {
        policy: {
          ...policy,
          turnLimit: TurnLimit.parse(limit),
          outputSchema: { type: "object" },
        },
      },
    ));

// Ruling 30: further output must close all admitted calls and leave the session reusable.
test("R18 turnLimit one rejects a second root after delivering a tool result", () => {
  let handled = 0;
  return run(
    (f, s, events, next) =>
      Effect.gen(function* () {
        const client = yield* connect(f);
        yield* s.startTurn(start);
        yield* send(f, [
          begin(),
          blockMessage("message-1", chain, [
            { id: "delivered", name: "mcp__neuve__work", input: {} },
            { id: "undispatched", name: "mcp__neuve__work", input: {} },
          ]),
          end("tool_use"),
          stop(),
        ]);
        yield* next("message.finished");
        const reply = yield* Effect.promise(() =>
          client.callTool({
            name: "work",
            arguments: {},
            _meta: { [TOOL_USE_ID_META]: "delivered" },
          }),
        );
        expect(handled).toBe(1);
        expect(reply).toMatchObject({
          content: [{ type: "text", text: "delivered" }],
          isError: false,
        });
        yield* send(f, [begin("forbidden-message")]);
        expect(yield* next("turn.finished")).toMatchObject({
          outcome: {
            status: "failed",
            disposition: "reusable",
            failure: { reason: "turn-limit-reached" },
          },
        });
        expect(
          events
            .filter((event) => event.type === "tool.started")
            .map((event) => event.callId),
        ).toEqual(["delivered", "undispatched"]);
        expect(
          events
            .filter((event) => event.type === "tool.finished")
            .map((event) => [event.callId, event.errored]),
        ).toEqual([
          ["delivered", false],
          ["undispatched", true],
        ]);
        expect(
          events.filter((event) => event.type === "message.finished"),
        ).toHaveLength(1);
        expect(f.children[0]!.closed).toBe(true);
        yield* s.startTurn({ ...start, turnId: "two" });
        expect(f.children).toHaveLength(2);
        yield* send(f, [
          begin("next-turn"),
          blockMessage("next-turn", lastChain),
          end(),
          stop(),
          result({ modelUsage: { "test-model": usage(29, 21) } }),
        ]);
        expect(yield* next("turn.finished")).toMatchObject({
          outcome: { status: "completed" },
        });
        expect(
          events
            .filter((event) => event.type === "usage")
            .map((event) => [event.turnId, event.usage.input]),
        ).toEqual([
          ["one", 11],
          ["two", 11],
        ]);
      }),
    {
      policy: {
        ...policy,
        turnLimit: TurnLimit.parse(1),
        tools: [
          definition(() =>
            Effect.sync(() => {
              handled++;
              return { text: "delivered" };
            }),
          ),
        ],
      },
    },
  );
});

// A reusable limit failure must reopen at the reported carrier so tool results survive.
test("R18b turnLimit failure resumes the next child at its tool-result carrier", () =>
  run(
    (f, s, _, next) =>
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
        yield* next("message.finished");
        expect(
          yield* Effect.promise(() =>
            client.callTool({
              name: "work",
              arguments: {},
              _meta: { [TOOL_USE_ID_META]: "call-1" },
            }),
          ),
        ).toMatchObject({
          content: [{ type: "text", text: "delivered" }],
          isError: false,
        });
        yield* send(f, [
          {
            type: "user",
            parent_tool_use_id: null,
            uuid: lastChain,
            session_id: SESSION_ID,
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "call-1",
                  content: "delivered",
                },
              ],
            },
          },
          begin("forbidden-message"),
        ]);
        expect(yield* next("turn.finished")).toMatchObject({
          resumePoint: lastChain,
          outcome: {
            status: "failed",
            disposition: "reusable",
            failure: { reason: "turn-limit-reached" },
          },
        });
        expect(f.children[0]!.closed).toBe(true);
        yield* s.startTurn({ ...start, turnId: "two" });
        expect(f.children).toHaveLength(2);
        expect(f.children[1]!.options.resumeSessionAt).toBe(lastChain);
        yield* send(f, [
          begin("next-turn"),
          blockMessage("next-turn", crypto.randomUUID()),
          end(),
          stop(),
          result(),
        ]);
        expect(yield* next("turn.finished")).toMatchObject({
          outcome: { status: "completed" },
        });
      }),
    {
      policy: {
        ...policy,
        turnLimit: TurnLimit.parse(1),
        tools: [definition(() => Effect.succeed({ text: "delivered" }))],
      },
    },
  ));

// Admission can complete the limit-th message before message_stop and must still run its submit.
test("R18b turnLimit one admits an endTurn handler before message_stop", () => {
  let submitted = 0;
  return run(
    (f, s, events, next) =>
      Effect.gen(function* () {
        const client = yield* connect(f);
        yield* s.startTurn(start);
        yield* send(f, [
          begin(),
          blockMessage("message-1", chain, [
            { id: "submit", name: "mcp__neuve__work", input: {} },
          ]),
        ]);
        yield* next("tool.started");
        const reply = yield* Effect.promise(() =>
          client.callTool({
            name: "work",
            arguments: {},
            _meta: { [TOOL_USE_ID_META]: "submit" },
          }),
        );
        expect(submitted).toBe(1);
        expect(reply).toMatchObject({
          content: [{ type: "text", text: "submitted" }],
          isError: false,
        });
        // Reason: an early endTurn handler does not close its still-streaming response.
        yield* send(f, [stop()]);
        expect(yield* next("message.finished")).toMatchObject({
          messageId: "message-1",
          resumePoint: chain,
        });
        yield* send(f, [result()]);
        expect(yield* next("turn.finished")).toMatchObject({
          outcome: { status: "completed" },
        });
        expect(
          events.filter((event) => event.type === "turn.finished"),
        ).toHaveLength(1);
      }),
    {
      policy: {
        ...policy,
        turnLimit: TurnLimit.parse(1),
        tools: [
          definition(() =>
            Effect.sync(() => {
              submitted++;
              return { text: "submitted", endTurn: true };
            }),
          ),
        ],
      },
    },
  );
});

// Why: a longer stage can reach structured output after the short-stage allowance is exhausted.
test("final turn with a larger policy limit can submit structured output after three messages", () =>
  run(
    (f, s, events, next) =>
      Effect.gen(function* () {
        yield* s.startTurn({ ...start, final: true });
        for (let n = 1; n <= FINAL_TURN_MESSAGES; n++)
          yield* send(f, answer(`message-${n}`, chainAt(n)));
        yield* send(f, [
          ...structured("message-4", lastChain),
          result({ structured_output: { answer: 3 } }),
        ]);
        expect(yield* next("turn.finished")).toMatchObject({
          outcome: { status: "completed", structuredOutput: { answer: 3 } },
        });
        expect(
          events.filter((event) => event.type === "message.finished"),
        ).toHaveLength(4);
      }),
    {
      policy: {
        ...policy,
        turnLimit: TurnLimit.parse(8),
        outputSchema: { type: "object" },
      },
    },
  ));
