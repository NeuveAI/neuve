import { expect, test } from "bun:test";
import type {
  Options,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  Account,
  TurnLimit,
  type RuntimeEvent,
  type SessionPolicy,
} from "@neuve/runtime";
import { Effect, Layer, Queue, Scope, Stream } from "effect";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { openClaudeSession } from "../src/session.ts";
import { ClaudeSdk } from "../src/services.ts";
import { assistant, result, usage } from "./frames.ts";

const parsedAccount = Account.parse({
  name: "test",
  kind: "claude-subscription",
  runtime: "claude-code",
  credential: { kind: "claude-config-folder" },
});
if (parsedAccount.kind !== "claude-subscription") throw new Error("fixture");
const account = parsedAccount;
const policy: SessionPolicy = {
  systemPrompt: "fixture",
  tools: [],
  approvalPolicy: "allow",
  turnLimit: TurnLimit.parse(5),
};
const config = { cwd: "/test", executable: "/test/claude", environment: {} };

function fixture() {
  const sends: SDKUserMessage[] = [];
  const children: Array<{
    frames: Queue.Queue<SDKMessage>;
    closed: boolean;
    options: Options;
    onClose: Promise<void>;
  }> = [];
  const layer = Layer.succeed(ClaudeSdk, {
    prefixes: { usage: ["You've hit your"], organization: [] },
    open: (options) =>
      Effect.gen(function* () {
        const closed = Promise.withResolvers<void>();
        const child = {
          frames: yield* Queue.unbounded<SDKMessage>(),
          closed: false,
          options,
          onClose: closed.promise,
        };
        children.push(child);
        const close = Effect.sync(() => {
          child.closed = true;
          closed.resolve();
        }).pipe(Effect.andThen(Queue.shutdown(child.frames)));
        yield* Effect.addFinalizer(() => close);
        return {
          messages: Stream.fromQueue(child.frames),
          close,
          offer: (message: SDKUserMessage) =>
            Effect.sync(() => {
              sends.push(message);
            }),
          interrupt: Effect.void,
          setModel: () => Effect.void,
          applyFlagSettings: () => Effect.void,
          initializationResult: Effect.succeed({ account: {} }),
        };
      }),
  });
  return { sends, children, layer };
}
function run(
  body: (
    f: ReturnType<typeof fixture>,
  ) => Effect.Effect<void, unknown, Scope.Scope | ClaudeSdk>,
) {
  const f = fixture();
  return Effect.runPromise(
    Effect.scoped(body(f)).pipe(
      Effect.provide(f.layer),
      Effect.timeout("2 seconds"),
    ),
  );
}
function reader(session: Effect.Success<ReturnType<typeof openClaudeSession>>) {
  return Effect.gen(function* () {
    const events: RuntimeEvent[] = [];
    const queue = yield* Queue.unbounded<RuntimeEvent>();
    yield* Stream.runForEach(session.events, (event) =>
      Effect.sync(() => {
        events.push(event);
        Queue.offerUnsafe(queue, event);
      }),
    ).pipe(Effect.forkScoped);
    const until = (...types: RuntimeEvent["type"][]) =>
      Effect.gen(function* () {
        while (true) {
          const event = yield* Queue.take(queue);
          if (types.includes(event.type)) return event;
        }
      });
    return { events, until };
  });
}

import { modelUsage } from "../src/mapping.ts";
import { toolServer, TOOL_USE_ID_META } from "../src/tools.ts";
import { z } from "zod";

test("R3-F1 drained singular stamp must finish coalesced sends", () =>
  run((f) =>
    Effect.gen(function* () {
      const session = yield* openClaudeSession(account, policy, config);
      const r = yield* reader(session);
      yield* session.startTurn({ turnId: "one", message: "fixture" });
      yield* session.steerTurn({ turnId: "one", message: "fixture" });
      yield* Queue.offer(
        f.children[0]!.frames,
        result({
          user_message_uuid: f.sends[1]!.uuid!,
          queued_turn_count: 0,
          modelUsage: { m: usage(10) },
        }),
      );
      yield* r.until("usage");
      const outcome = yield* r
        .until("turn.finished")
        .pipe(Effect.timeoutOption("50 millis"));
      expect(outcome._tag).toBe("Some");
    }),
  ));

test("R3-F2 partial cache lifetime fields preserve total writes", () => {
  const actual = modelUsage({
    ...usage(1),
    cacheCreationInputTokens: 100,
    cacheCreationEphemeral5mInputTokens: 20,
    cacheCreationEphemeral1hInputTokens: 30,
  });
  expect(actual.cacheWrite5m + actual.cacheWrite1h).toBe(100);
  expect(actual).toMatchObject({ cacheWrite5m: 70, cacheWrite1h: 30 });
});

test("R3-F3 hook plus native metadata must preserve original tool arguments", async () => {
  const seen: unknown[] = [];
  const definition = {
    name: "fixture",
    description: "fixture",
    inputSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
    hints: {
      readOnly: true,
      destructive: false,
      idempotent: true,
      openWorld: false,
    },
    handle: () => Effect.succeed({ text: "fixture" }),
  };
  const server = toolServer([definition], async (_definition, input) => {
    seen.push(input);
    const valid = z
      .strictObject({ value: z.string() })
      .safeParse(input).success;
    return { content: [], isError: !valid };
  });
  const client = new Client({ name: "fixture", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(ct), server.instance.connect(st)]);
    const stamped = await server.stampToolUseId(
      {
        hook_event_name: "PreToolUse",
        session_id: "fixture",
        transcript_path: "/unused",
        cwd: "/test",
        tool_name: "mcp__neuve__fixture",
        tool_use_id: "native-id",
        tool_input: { value: "fixture" },
      },
      "native-id",
      { signal: new AbortController().signal },
    );
    if (
      !("hookSpecificOutput" in stamped) ||
      stamped.hookSpecificOutput?.hookEventName !== "PreToolUse"
    )
      throw new Error("fixture");
    const response = await client.callTool({
      name: "fixture",
      arguments: stamped.hookSpecificOutput.updatedInput,
      _meta: { [TOOL_USE_ID_META]: "native-id" },
    });
    expect(response.isError).toBe(false);
    expect(seen).toEqual([{ value: "fixture" }]);
  } finally {
    await client.close();
    await server.instance.close();
  }
});

test("R3-F4 consumed steering finishes without a partial replay", () =>
  run((f) =>
    Effect.gen(function* () {
      const session = yield* openClaudeSession(account, policy, config);
      const r = yield* reader(session);
      yield* session.startTurn({ turnId: "one", message: "first-fixture" });
      yield* session.steerTurn({ turnId: "one", message: "steer-fixture" });
      yield* Queue.offer(
        f.children[0]!.frames,
        assistant(
          "server_error",
          "another Claude Code process is refreshing it",
        ),
      );
      yield* Queue.offer(
        f.children[0]!.frames,
        result({
          is_error: true,
          user_message_uuids: f.sends.map((s) => s.uuid!),
          queued_turn_count: 0,
          modelUsage: { m: usage(10) },
        }),
      );
      expect(yield* r.until("turn.finished")).toMatchObject({
        outcome: {
          status: "failed",
          disposition: "reusable",
          failure: { reason: "provider-failed" },
        },
      });
      expect(f.sends.map((s) => s.message.content)).toEqual([
        "first-fixture",
        "steer-fixture",
      ]);
    }),
  ));

test("R3-F5 malformed content block start is a protocol failure", () =>
  run((f) =>
    Effect.gen(function* () {
      const session = yield* openClaudeSession(account, policy, config);
      const r = yield* reader(session);
      yield* session.startTurn({ turnId: "one", message: "fixture" });
      const malformed: SDKMessage = JSON.parse(
        JSON.stringify({
          type: "stream_event",
          parent_tool_use_id: null,
          uuid: crypto.randomUUID(),
          session_id: "fixture",
          event: { type: "content_block_start", index: 0 },
        }),
      );
      yield* Queue.offer(f.children[0]!.frames, malformed);
      expect(yield* r.until("turn.finished")).toMatchObject({
        outcome: {
          status: "failed",
          disposition: "broken",
          failure: { reason: "protocol-error" },
        },
      });
    }),
  ));

for (const stamp of ["none", "first", "plural-capped"] as const) {
  test(`R3-F1 queue drainage finishes with ${stamp} stamps`, () =>
    run((f) =>
      Effect.gen(function* () {
        const session = yield* openClaudeSession(account, policy, config);
        const r = yield* reader(session);
        yield* session.startTurn({ turnId: "one", message: "fixture" });
        const steers = stamp === "plural-capped" ? 65 : 1;
        for (let i = 0; i < steers; i++)
          yield* session.steerTurn({ turnId: "one", message: "fixture" });
        yield* Queue.offer(
          f.children[0]!.frames,
          result({
            queued_turn_count: 0,
            ...(stamp === "first"
              ? { user_message_uuid: f.sends[0]!.uuid! }
              : {}),
            ...(stamp === "plural-capped"
              ? { user_message_uuids: f.sends.slice(-64).map((s) => s.uuid!) }
              : {}),
          }),
        );
        expect(yield* r.until("turn.finished")).toMatchObject({
          outcome: { status: "completed" },
        });
        expect(r.events.filter((e) => e.type === "turn.finished")).toHaveLength(
          1,
        );
        yield* session.startTurn({ turnId: "two", message: "fixture" });
        yield* Queue.offer(
          f.children[0]!.frames,
          result({ queued_turn_count: 0 }),
        );
        expect(yield* r.until("turn.finished")).toMatchObject({
          turnId: "two",
          outcome: { status: "completed" },
        });
      }),
    ));
}
for (const field of [
  "singular",
  "plural",
  "singular-with-valid-plural",
] as const) {
  test(`R3-F1 foreign ${field} stamp remains a protocol fault after drainage`, () =>
    run((f) =>
      Effect.gen(function* () {
        const session = yield* openClaudeSession(account, policy, config);
        const r = yield* reader(session);
        yield* session.startTurn({ turnId: "old", message: "fixture" });
        const oldId = f.sends[0]!.uuid!;
        yield* Queue.offer(
          f.children[0]!.frames,
          result({ queued_turn_count: 0 }),
        );
        yield* r.until("turn.finished");
        yield* session.startTurn({ turnId: "one", message: "fixture" });
        yield* Queue.offer(
          f.children[0]!.frames,
          result({
            queued_turn_count: 0,
            ...(field === "plural"
              ? { user_message_uuids: [oldId] }
              : { user_message_uuid: oldId }),
            ...(field === "singular-with-valid-plural"
              ? { user_message_uuids: [f.sends[1]!.uuid!] }
              : {}),
          }),
        );
        expect(yield* r.until("turn.finished")).toMatchObject({
          outcome: {
            status: "failed",
            disposition: "broken",
            failure: { reason: "protocol-error" },
          },
        });
      }),
    ));
}

for (const [five, hour, expectedFive, expectedHour] of [
  [120, 30, 70, 30],
  [20, 130, 0, 100],
  [120, 130, 0, 100],
  [150, 0, 100, 0],
] satisfies Array<[number, number, number, number]>) {
  test(`R3-F2 excessive cache subsets clamp safely: ${five}, ${hour}`, () => {
    const actual = modelUsage({
      ...usage(1),
      cacheCreationInputTokens: 100,
      cacheCreationEphemeral5mInputTokens: five,
      cacheCreationEphemeral1hInputTokens: hour,
    });
    expect(actual).toMatchObject({
      cacheWrite5m: expectedFive,
      cacheWrite1h: expectedHour,
    });
    expect(actual.cacheWrite5m + actual.cacheWrite1h).toBe(100);
  });
}

for (const stamp of ["none", "first", "steer"] as const) {
  test(`R3-F4 a drained refresh failure after steering never replays: ${stamp} stamps`, () =>
    run((f) =>
      Effect.gen(function* () {
        const session = yield* openClaudeSession(account, policy, config);
        const r = yield* reader(session);
        yield* session.startTurn({ turnId: "one", message: "first-fixture" });
        yield* session.steerTurn({ turnId: "one", message: "steer-fixture" });
        yield* Queue.offer(
          f.children[0]!.frames,
          assistant(
            "server_error",
            "another Claude Code process is refreshing it",
          ),
        );
        yield* Queue.offer(
          f.children[0]!.frames,
          result({
            is_error: true,
            queued_turn_count: 0,
            ...(stamp === "none"
              ? {}
              : {
                  user_message_uuid: f.sends[stamp === "first" ? 0 : 1]!.uuid!,
                }),
          }),
        );
        expect(yield* r.until("turn.finished")).toMatchObject({
          outcome: {
            status: "failed",
            disposition: "reusable",
            failure: { reason: "provider-failed" },
          },
        });
        expect(f.sends).toHaveLength(2);
      }),
    ));
}

const malformedEvents = [
  { type: "content_block_delta", index: 0 },
  { type: "content_block_start", index: 0, content_block: null },
  { type: "content_block_start", index: 0, content_block: {} },
  {
    type: "content_block_start",
    index: 0,
    content_block: { type: "tool_use" },
  },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta" } },
];
for (const [index, event] of malformedEvents.entries()) {
  test(`R3-F5 malformed consumed event ${index} is a protocol failure`, () =>
    run((f) =>
      Effect.gen(function* () {
        const session = yield* openClaudeSession(account, policy, config);
        const r = yield* reader(session);
        yield* session.startTurn({ turnId: "one", message: "fixture" });
        const malformed: SDKMessage = JSON.parse(
          JSON.stringify({
            type: "stream_event",
            parent_tool_use_id: null,
            event,
          }),
        );
        yield* Queue.offer(f.children[0]!.frames, malformed);
        expect(yield* r.until("turn.finished")).toMatchObject({
          outcome: {
            status: "failed",
            disposition: "broken",
            failure: { reason: "protocol-error" },
          },
        });
      }),
    ));
}
for (const block of [{ type: "text" }, { type: "tool_use" }]) {
  test(`R3-F5 malformed assistant ${block.type} block is a protocol failure`, () =>
    run((f) =>
      Effect.gen(function* () {
        const session = yield* openClaudeSession(account, policy, config);
        const r = yield* reader(session);
        yield* session.startTurn({ turnId: "one", message: "fixture" });
        const malformed: SDKMessage = JSON.parse(
          JSON.stringify({
            ...assistant(undefined),
            message: { content: [block] },
          }),
        );
        yield* Queue.offer(f.children[0]!.frames, malformed);
        expect(yield* r.until("turn.finished")).toMatchObject({
          outcome: {
            status: "failed",
            disposition: "broken",
            failure: { reason: "protocol-error" },
          },
        });
      }),
    ));
}
