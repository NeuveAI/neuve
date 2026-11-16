import { expect, test } from "bun:test";
import {
  Account,
  RuntimeEvent,
  TurnLimit,
  type SessionPolicy,
} from "@neuve/runtime";
import { Effect, Layer, Stream } from "effect";
import { z } from "zod";
import { makeRuntime } from "../src/runtime.ts";
import { ClaudeExecutable, ClaudeProcess, ClaudeSdk } from "../src/services.ts";
import { recordFixture } from "../src/smoke-fixture-recorder.ts";
import { observeSmokeSdk } from "../src/smoke-runtime.ts";
import { fixtureReplay, replay, inbound, out, type Entry } from "./replay.ts";
import type {
  SDKMessage,
  SDKPartialAssistantMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { assistant, result, SESSION_ID, usage } from "./frames.ts";
const multiRoundSchemas = {
  note: { type: "object", properties: {}, additionalProperties: false },
  finish: { type: "object", properties: {}, additionalProperties: false },
};

const account = Account.parse({
  name: "fixture",
  kind: "claude-subscription",
  runtime: "claude-code",
  credential: { kind: "claude-config-folder" },
});
async function run(entries: Entry[]) {
  const frames: unknown[] = [];
  const sends: string[] = [];
  const policy: SessionPolicy = {
    systemPrompt: "fixture",
    approvalPolicy: "allow",
    turnLimit: TurnLimit.parse(4),
    tools: ["note", "finish"].map((name) => ({
      name,
      description: "fixture",
      hints: {
        readOnly: true,
        destructive: false,
        idempotent: true,
        openWorld: false,
      },
      inputSchema: multiRoundSchemas.note,
      handle: () =>
        Effect.succeed({
          text: "fixture",
          ...(name === "finish" ? { endTurn: true } : {}),
        }),
    })),
  };
  const fake = replay(entries);
  const events = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const sdk = yield* ClaudeSdk;
        const runtime = yield* makeRuntime({
          cwd: "/test",
          environment: {},
        }).pipe(
          Effect.provideService(
            ClaudeSdk,
            observeSmokeSdk(sdk, {
              offered: (message) => {
                sends.push(message.uuid!);
              },
              receive: (frame) => frames.push(frame),
            }),
          ),
        );
        const session = yield* runtime.openSession(account, policy);
        yield* session.startTurn({ turnId: "fixture", message: "fixture" });
        return yield* Stream.runCollect(
          session.events.pipe(
            Stream.tap((event) =>
              Effect.sync(() => {
                RuntimeEvent.parse(event);
              }),
            ),
            Stream.takeUntil((event) => event.type === "turn.finished"),
          ),
        );
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          fake.layer,
          Layer.succeed(ClaudeExecutable, {
            resolve: () => Effect.succeed("/test/claude"),
          }),
          Layer.succeed(ClaudeProcess, {
            run: () => Effect.die("No process allowed"),
          }),
        ),
      ),
      Effect.timeout("3 seconds"),
    ),
  );
  return { events, frames, sends };
}

// Reason: a sanitized recording must reproduce production tool lifecycle, publication and usage.
test("shape fixture round trip preserves multi-round outcome, event types and usage totals", async () => {
  const original = await run(multiRoundFixture());
  const fixture = recordFixture(original.frames, original.sends);
  const restored = await run(
    fixtureReplay(JSON.parse(JSON.stringify(fixture)), multiRoundSchemas),
  );
  expect(original.events.at(-1)).toMatchObject({
    type: "turn.finished",
    outcome: { status: "completed" },
  });
  expect(restored.events.at(-1)).toMatchObject({
    type: "turn.finished",
    outcome: { status: "completed" },
  });
  expect(restored.events.map((event) => event.type)).toEqual(
    original.events.map((event) => event.type),
  );
  const totals = (events: RuntimeEvent[]) =>
    events
      .filter((event) => event.type === "usage")
      .map((event) => event.usage);
  expect(totals(original.events).length).toBeGreaterThan(0);
  expect(totals(restored.events)).toEqual(totals(original.events));
  expect(totals(restored.events)).toEqual([
    { input: 33, output: 27, cacheRead: 3, cacheWrite5m: 4, cacheWrite1h: 0 },
  ]);
  expect(restored.sends[0]).not.toBe(original.sends[0]);
  expect(JSON.stringify(restored.frames)).not.toContain("msg_1");
  expect(JSON.stringify(fixture)).not.toContain("private-tool-output");
  const messages = restored.events.filter(
    (event) => event.type === "message.finished",
  );
  expect(messages.map((event) => event.toolCalls.length)).toEqual([1, 2, 1]);
});

function multiRoundFixture(): Entry[] {
  const partial = (
    event: SDKPartialAssistantMessage["event"],
  ): SDKPartialAssistantMessage => ({
    type: "stream_event",
    event,
    parent_tool_use_id: null,
    session_id: SESSION_ID,
    uuid: crypto.randomUUID(),
  });
  let sent = "";
  const entries: Entry[] = [
    out({ type: "query.open" }),
    out({
      type: "prompt.offer",
      message: "fixture",
      check: (message) => {
        sent = message.uuid!;
      },
    }),
  ];
  entries.push(
    inbound({
      type: "system",
      subtype: "api_retry",
      attempt: 2,
      max_retries: 3,
      retry_delay_ms: 0,
      error_status: 500,
      error: "server_error",
      uuid: crypto.randomUUID(),
      session_id: SESSION_ID,
    }),
    inbound({
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed_warning" },
      uuid: crypto.randomUUID(),
      session_id: SESSION_ID,
    }),
  );
  for (const [index, names] of [
    [0, ["note"]],
    [1, ["note", "note"]],
    [2, ["finish"]],
  ] as const) {
    const reply = assistant(undefined);
    reply.message.id = `response-${index}`;
    reply.message.model = "claude-sonnet-4-5-20250929";
    reply.message.stop_reason = null;
    const calls = names.map((name, position) => ({
      name,
      callId: `call-${index}-${position}`,
      input: {},
    }));
    reply.message.content = calls.map((call) => ({
      type: "tool_use",
      id: call.callId,
      name: `mcp__neuve__${call.name}`,
      input: {},
    }));
    const start = partial({
      type: "message_start",
      message: {
        ...reply.message,
        content: [],
        usage: { ...reply.message.usage, input_tokens: 11, output_tokens: 0 },
      },
    });
    entries.push(
      {
        type: "emit_inbound",
        get frame() {
          return {
            ...start,
            user_message_uuid: sent,
            user_message_uuids: [sent],
          };
        },
      },
      inbound(reply),
    );
    const tail = [
      inbound(
        partial({
          type: "message_delta",
          delta: {
            stop_reason: "tool_use",
            stop_sequence: null,
            container: null,
            stop_details: null,
          },
          usage: { ...reply.message.usage, input_tokens: 11, output_tokens: 9 },
          context_management: null,
        }),
      ),
      inbound(partial({ type: "message_stop" })),
    ];
    if (index !== 1) entries.push(...tail);
    entries.push({
      type: "smoke.tool.calls",
      schemas: multiRoundSchemas,
      dispatchOnly: true,
      calls,
    });
    const carrier: SDKMessage = {
      type: "user",
      parent_tool_use_id: null,
      session_id: SESSION_ID,
      uuid: crypto.randomUUID(),
      message: {
        role: "user",
        content: calls.map((call) => ({
          type: "tool_result",
          tool_use_id: call.callId,
          content: "private-tool-output",
        })),
      },
    };
    entries.push(inbound(carrier));
    if (index === 1) entries.push(...tail);
  }
  entries.push(
    {
      type: "emit_inbound",
      get frame() {
        return result({
          modelUsage: { "claude-sonnet-4-5-20250929": usage(33, 27) },
          user_message_uuid: sent,
          user_message_uuids: [sent],
        });
      },
    },
    out({ type: "query.close" }),
  );
  return entries;
}

// Reason: additional sends and foreign stamps must stay distinct when ids change on replay.
test("fixture loader binds every scheduled send stamp and preserves foreign equality", async () => {
  const fixture = recordFixture(
    [
      {
        type: "system",
        subtype: "status",
        uuid: "old-uuid",
        session_id: "old-session",
        user_message_uuid: "second",
        user_message_uuids: ["first", "second", "foreign", "foreign"],
      },
    ],
    ["first", "second"],
  );
  const entries = fixtureReplay(fixture, {}, [
    { beforeFrame: 0 },
    { beforeFrame: 0, priority: "now" },
  ]);
  const fake = replay(entries);
  const first = crypto.randomUUID();
  const second = crypto.randomUUID();
  const frames = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const sdk = yield* ClaudeSdk;
        const query = yield* sdk.open({});
        yield* query.offer({
          type: "user",
          parent_tool_use_id: null,
          uuid: first,
          message: { role: "user", content: "fixture" },
        });
        yield* query.offer({
          type: "user",
          parent_tool_use_id: null,
          uuid: second,
          priority: "now",
          message: { role: "user", content: "fixture" },
        });
        const frames = yield* Stream.runCollect(
          query.messages.pipe(Stream.take(1)),
        );
        yield* query.close;
        return frames;
      }),
    ).pipe(Effect.provide(fake.layer), Effect.timeout("3 seconds")),
  );
  const stamps = z
    .object({
      user_message_uuid: z.string(),
      user_message_uuids: z.array(z.string()),
    })
    .parse(frames[0]);
  expect(stamps.user_message_uuid).toBe(second);
  expect(stamps.user_message_uuids.slice(0, 2)).toEqual([first, second]);
  expect(stamps.user_message_uuids[2]).toBe(stamps.user_message_uuids[3]);
  expect(stamps.user_message_uuids[2]).not.toBe(first);
  expect(frames[0]?.uuid).not.toBe("old-uuid");
  expect(frames[0]?.session_id).not.toBe("old-session");
  expect(() => fixtureReplay(fixture, {})).toThrow("schedule");
});
