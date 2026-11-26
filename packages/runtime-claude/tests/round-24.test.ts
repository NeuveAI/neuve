import { expect, test } from "bun:test";
import type {
  SDKMessage,
  SDKPartialAssistantMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  Account,
  RuntimeEvent,
  TurnLimit,
  type SessionPolicy,
} from "@neuve/runtime";
import { Cause, Effect, Exit, Layer, Queue, Stream } from "effect";
import { makeRuntime } from "../src/runtime.ts";
import { ClaudeExecutable, ClaudeProcess, ClaudeSdk } from "../src/services.ts";
import { diagnoseObservation } from "../src/smoke-diagnose.ts";
import { observeSmokeSdk } from "../src/smoke-runtime.ts";
import { assistant, result, SESSION_ID, usage } from "./frames.ts";
import { inbound, out, replay, type Entry } from "./replay.ts";

const account = Account.parse({
  name: "fixture",
  kind: "claude-subscription",
  runtime: "claude-code",
  credential: { kind: "claude-config-folder" },
});
const partial = (
  event: SDKPartialAssistantMessage["event"],
): SDKPartialAssistantMessage => ({
  type: "stream_event",
  parent_tool_use_id: null,
  uuid: crypto.randomUUID(),
  session_id: SESSION_ID,
  event,
});
const stop = () => partial({ type: "message_stop" });
const blockStop = () => partial({ type: "content_block_stop", index: 1 });
const delta = () =>
  partial({
    type: "message_delta",
    delta: {
      stop_reason: "tool_use",
      stop_sequence: null,
      container: null,
      stop_details: null,
    },
    usage: {
      output_tokens: 9,
      input_tokens: 11,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 4,
      fallback_credit: null,
      output_tokens_details: null,
      iterations: null,
      server_tool_use: null,
    },
    context_management: null,
  });
const begin = (id = "response") => {
  const frame = assistant(undefined);
  return partial({
    type: "message_start",
    message: {
      ...frame.message,
      id,
      content: [],
      stop_reason: null,
      usage: { ...frame.message.usage, input_tokens: 11 },
    },
  });
};
const init = (session_id: string): SDKMessage => ({
  type: "system",
  subtype: "init",
  session_id,
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
const carrier: SDKMessage = {
  type: "user",
  parent_tool_use_id: null,
  uuid: "00000000-0000-4000-8000-000000000024",
  session_id: SESSION_ID,
  message: {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "call", content: "fixture" }],
  },
};
type Fault =
  | "content delta"
  | "content start"
  | "assistant"
  | "duplicate stop"
  | "delta after stop"
  | "block stop after stop"
  | "new response";

async function scenario({
  late,
  endTurn,
  resumed = false,
  fault,
  afterResult = false,
  streamOnly = false,
  reset = false,
  tailStamp,
  reinitialize,
}: {
  late: boolean;
  endTurn: boolean;
  resumed?: boolean;
  fault?: Fault;
  afterResult?: boolean;
  streamOnly?: boolean;
  reset?: boolean;
  tailStamp?: "foreign" | "empty";
  reinitialize?: "same" | "changed";
}) {
  const entered = Promise.withResolvers<void>();
  const finalizing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const observation = diagnoseObservation({ tools: true });
  const modelReply = assistant(undefined);
  modelReply.message.id = "response";
  modelReply.message.stop_reason = null;
  modelReply.message.content = [
    {
      type: "tool_use",
      id: "call",
      name: "mcp__neuve__finish",
      input: { value: "ok" },
    },
  ];
  if (afterResult)
    modelReply.message.content.push({
      type: "tool_use",
      id: "slow",
      name: "mcp__neuve__finish",
      input: { value: "wait" },
    });
  const next = assistant(undefined, "next");
  next.message.id = "next-response";
  const extra: Record<Fault, SDKMessage[]> = {
    "content delta": [
      partial({
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: "{}" },
      }),
    ],
    "content start": [
      partial({
        type: "content_block_start",
        index: 2,
        content_block: { type: "text", text: "extra", citations: [] },
      }),
    ],
    assistant: [modelReply],
    "duplicate stop": [stop()],
    "delta after stop": [delta()],
    "block stop after stop": [blockStop()],
    "new response": [result(), begin("forbidden-response")],
  };
  const entries: Entry[] = [
    out({ type: "query.open" }),
    out({ type: "prompt.offer", message: "fixture" }),
    ...(reinitialize === undefined ? [] : [inbound(init(SESSION_ID))]),
    inbound(begin()),
    inbound(
      partial({
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "", signature: "" },
      }),
    ),
    inbound(
      partial({
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "thinking_delta",
          thinking: "fixture",
          estimated_tokens: 2,
        },
      }),
    ),
    inbound(partial({ type: "content_block_stop", index: 0 })),
    inbound(
      partial({
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "tool_use",
          id: "call",
          name: "mcp__neuve__finish",
          input: {},
        },
      }),
    ),
    ...["{", '"value"', ":", '"', "ok", '"', "}"].map((partial_json) =>
      inbound(
        partial({
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json },
        }),
      ),
    ),
    inbound(modelReply),
    ...(late ? [] : [inbound(blockStop()), inbound(delta()), inbound(stop())]),
    {
      type: "tool.calls",
      dispatchOnly: true,
      calls: [{ name: "finish", callId: "call", input: { value: "ok" } }],
    },
    ...(late && fault === undefined && !afterResult
      ? [inbound(blockStop())]
      : []),
    inbound(carrier),
    ...(reinitialize === undefined
      ? []
      : [
          inbound(
            init(
              reinitialize === "same"
                ? SESSION_ID
                : "00000000-0000-4000-8000-000000000025",
            ),
          ),
        ]),
    ...(reset
      ? [
          inbound({
            type: "conversation_reset",
            new_conversation_id: "00000000-0000-4000-8000-000000000025",
            session_id: "00000000-0000-4000-8000-000000000025",
            uuid: crypto.randomUUID(),
            trigger: "clear",
          }),
        ]
      : []),
    ...(afterResult
      ? [
          {
            type: "tool.calls",
            dispatchOnly: true,
            background: true,
            calls: [
              { name: "finish", callId: "slow", input: { value: "wait" } },
            ],
          } satisfies Entry,
          { type: "pause", until: entered.promise } satisfies Entry,
          inbound(
            result({
              modelUsage: {
                "test-model": usage(resumed ? 111 : 11, resumed ? 109 : 9),
              },
            }),
          ),
          { type: "pause", until: finalizing.promise } satisfies Entry,
        ]
      : []),
    ...(afterResult && late ? [inbound(blockStop())] : []),
    ...(fault === undefined
      ? late
        ? [
            inbound({
              ...delta(),
              ...(tailStamp === "foreign"
                ? { user_message_uuid: "unsent-message" }
                : tailStamp === "empty"
                  ? { user_message_uuids: [] }
                  : {}),
            }),
            inbound(stop()),
          ]
        : []
      : extra[fault].map(inbound)),
    ...(afterResult
      ? [
          {
            type: "pause",
            get until() {
              release.resolve();
              return Promise.resolve();
            },
          } satisfies Entry,
        ]
      : []),
    ...((fault === undefined || fault === "block stop after stop") &&
    !afterResult
      ? [
          ...(!endTurn ? [inbound(next)] : []),
          inbound(
            result({
              modelUsage: streamOnly
                ? {}
                : {
                    "test-model": {
                      ...usage(
                        resumed ? 111 : endTurn ? 11 : 18,
                        resumed ? 109 : endTurn ? 9 : 13,
                      ),
                      cacheCreationEphemeral1hInputTokens: 2,
                      thinkingTokens: 2,
                    },
                  },
            }),
          ),
        ]
      : []),
    out({ type: "query.close" }),
  ];
  const fake = replay(entries);
  let handled = 0;
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const sdk = yield* ClaudeSdk;
        const runtime = yield* makeRuntime({
          cwd: "/test",
          environment: {},
          ...(resumed ? { identity: { resume: SESSION_ID } } : {}),
        }).pipe(
          Effect.provideService(ClaudeSdk, observeSmokeSdk(sdk, observation)),
        );
        const policy: SessionPolicy = {
          systemPrompt: "fixture",
          approvalPolicy: "allow",
          turnLimit: TurnLimit.parse(3),
          tools: [
            {
              name: "finish",
              description: "fixture",
              hints: {
                readOnly: true,
                destructive: false,
                idempotent: true,
                openWorld: false,
              },
              inputSchema: {
                type: "object",
                properties: { value: { type: "string", minLength: 2 } },
                required: ["value"],
                additionalProperties: false,
              },
              handle: (_input, context) => {
                if (context === undefined)
                  throw new Error("Missing tool context");
                observation.handler(context.callId);
                if (context?.callId === "slow")
                  return Effect.sync(() => entered.resolve()).pipe(
                    Effect.andThen(Effect.never),
                    Effect.ensuring(
                      Effect.promise(() => {
                        finalizing.resolve();
                        return release.promise;
                      }),
                    ),
                  );
                return Effect.sync(() => {
                  handled++;
                  return {
                    text: "fixture",
                    ...(endTurn ? { endTurn: true } : {}),
                  };
                });
              },
            },
          ],
        };
        const session = yield* runtime.openSession(account, policy);
        observation.begin();
        observation.allowNormalSend();
        observation.toolPolicy(policy.tools);
        const seen: RuntimeEvent[] = [];
        const queue = yield* Queue.unbounded<RuntimeEvent>();
        yield* Stream.runForEach(session.events, (event) =>
          Effect.sync(() => {
            RuntimeEvent.parse(event);
            seen.push(event);
            observation.event(event);
            Queue.offerUnsafe(queue, event);
          }),
        ).pipe(Effect.forkScoped);
        yield* Effect.exit(
          session.startTurn({ turnId: "one", message: "fixture" }),
        );
        let ending: Extract<RuntimeEvent, { type: "turn.finished" }>;
        while (true) {
          const event = yield* Queue.take(queue);
          if (event.type === "turn.finished") {
            ending = event;
            break;
          }
        }
        const ledger = (yield* session.continuation).usageBaseline;
        const diagnosis = observation.event(ending);
        const nextStart =
          fault === "new response"
            ? yield* Effect.exit(
                session.startTurn({ turnId: "two", message: "fixture" }),
              )
            : undefined;
        return { seen, ending, ledger, diagnosis, handled, nextStart };
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
  ).finally(() => release.resolve());
}
const totals = (seen: RuntimeEvent[]) =>
  seen.filter((e) => e.type === "usage").map(({ at: _, ...event }) => event);

// Reason: Claude Code may run an endTurn tool before closing that response's stream.
test("R24 live endTurn order completes with the same usage and ledger", async () => {
  const conventional = await scenario({ late: false, endTurn: true });
  const late = await scenario({ late: true, endTurn: true });
  expect(late.ending.outcome).toEqual({ status: "completed" });
  expect(late.ending.resumePoint).toBe(carrier.uuid);
  expect(late.handled).toBe(1);
  expect(late.seen.filter((e) => e.type === "message.finished")).toHaveLength(
    1,
  );
  expect(late.seen.filter((e) => e.type === "tool.started")).toHaveLength(1);
  expect(late.seen.filter((e) => e.type === "tool.finished")).toHaveLength(1);
  expect(late.seen.filter((e) => e.type === "text")).toHaveLength(0);
  expect(totals(late.seen)).toEqual(totals(conventional.seen));
  expect(late.ledger).toEqual(conventional.ledger);
});

// Reason: accepting a continuing tool's tail must leave the next request in the same turn usable.
test("R24 open turn accepts a late tail and continues", async () => {
  const conventional = await scenario({ late: false, endTurn: false });
  const late = await scenario({ late: true, endTurn: false });
  expect(late.ending.outcome).toEqual({ status: "completed" });
  expect(late.seen.filter((e) => e.type === "message.finished")).toHaveLength(
    2,
  );
  expect(late.handled).toBe(1);
  expect(totals(late.seen)).toEqual(totals(conventional.seen));
  expect(late.ledger).toEqual(conventional.ledger);
});

for (const endTurn of [true, false]) {
  // Reason: resumed usage comes from stream frames, so only message_delta can supply output tokens.
  test(`R24 resumed ${endTurn ? "ending" : "continuing"} usage parity includes delta-only output`, async () => {
    const conventional = await scenario({
      late: false,
      endTurn,
      resumed: true,
    });
    const late = await scenario({ late: true, endTurn, resumed: true });
    expect(late.ending.outcome).toEqual({ status: "completed" });
    expect(totals(late.seen)).toEqual(totals(conventional.seen));
    expect(totals(late.seen).at(-1)).toMatchObject({
      usage: {
        input: 11,
        output: 9,
        cacheRead: 3,
        cacheWrite5m: 4,
        cacheWrite1h: 0,
        thinking: 0,
      },
    });
    expect(late.ledger).toEqual(conventional.ledger);
    expect(late.ledger.get("test-model")).toMatchObject({
      input: 111,
      output: 109,
    });
  });
}

for (const fault of [
  "content delta",
  "content start",
  "assistant",
  "duplicate stop",
  "delta after stop",
] satisfies Fault[]) {
  // Reason: publication follows message_stop; further blocks fault only after that response closes.
  test(`R24 still faults on ${fault} after the tool`, async () => {
    const capture = await scenario({ late: false, endTurn: true, fault });
    expect(capture.ending.outcome).toMatchObject({
      status: "failed",
      disposition: "broken",
      failure: { reason: "protocol-error" },
    });
    expect(capture.diagnosis?.firedPath).toBe("publishedFrameAfterEnding");
  });
}

// Reason: a known, content-free block closure after publication must preserve the completed turn.
test("a late block stop preserves the completed tool turn", async () => {
  const capture = await scenario({
    late: false,
    endTurn: true,
    fault: "block stop after stop",
  });
  expect(capture.ending.outcome).toEqual({ status: "completed" });
  expect(capture.handled).toBe(1);
  expect(
    capture.seen.filter((event) => event.type === "message.finished"),
  ).toHaveLength(1);
  expect(capture.diagnosis?.firedPath).toBe("none");
});

// Reason: new output after endTurn poisons the session; this guard passes before the fix.
test("R24 new response after endTurn keeps the protocol fault", async () => {
  const capture = await scenario({
    late: false,
    endTurn: true,
    fault: "new response",
  });
  expect(capture.ending.outcome).toEqual({ status: "completed" });
  expect(capture.nextStart).toBeDefined();
  if (capture.nextStart === undefined || Exit.isSuccess(capture.nextStart))
    throw new Error("Expected protocol failure");
  expect(Cause.squash(capture.nextStart.cause)).toMatchObject({
    _tag: "TurnFailed",
    reason: "protocol-error",
  });
});

// Reason: the diagnose collector must apply the same published-tail rule as the adapter.
test("R24 diagnose mirror accepts the live order", async () => {
  const capture = await scenario({ late: true, endTurn: true });
  expect(capture.diagnosis?.firedPath).toBe("none");
  expect(capture.diagnosis?.observerError).toBe(false);
});

for (const resumed of [false, true]) {
  // Reason: a tail during endTurn result cleanup must correct stream totals without adding to ledger totals twice.
  test(`R24 tail during cleanup preserves ${resumed ? "stream" : "ledger"} usage`, async () => {
    const conventional = await scenario({
      late: false,
      endTurn: true,
      resumed,
      afterResult: true,
    });
    const late = await scenario({
      late: true,
      endTurn: true,
      resumed,
      afterResult: true,
    });
    expect(late.ending.outcome).toEqual({ status: "completed" });
    expect(late.ending.resumePoint).toBe(carrier.uuid);
    expect(totals(late.seen).at(-1)).toEqual(totals(conventional.seen).at(-1));
    expect(late.ledger).toEqual(conventional.ledger);
    expect(late.diagnosis?.firedPath).toBe("none");
    expect(late.seen.filter((e) => e.type === "message.finished")).toHaveLength(
      1,
    );
  });
}

// Reason: a result without modelUsage must preserve output reported only by the request's delta.
test("R24 delta-only output survives late publication on resume", async () => {
  const conventional = await scenario({
    late: false,
    endTurn: true,
    resumed: true,
    streamOnly: true,
  });
  const late = await scenario({
    late: true,
    endTurn: true,
    resumed: true,
    streamOnly: true,
  });
  expect(late.ending.outcome).toEqual({ status: "completed" });
  expect(totals(late.seen)).toEqual(totals(conventional.seen));
  expect(totals(late.seen).at(-1)).toMatchObject({
    usage: { input: 11, output: 9 },
  });
  expect(late.ledger).toEqual(conventional.ledger);
});

// Reason: a new request after an ending result must remain visible to the diagnose mirror.
test("R24 diagnose mirror still faults on a new response after endTurn", async () => {
  const capture = await scenario({
    late: false,
    endTurn: true,
    fault: "new response",
  });
  expect(capture.diagnosis?.firedPath).toBe("publishedFrameAfterEnding");
});

// Reason: resetting the conversation invalidates the old published response's stream position.
test("review R24 rejects a stale published tail after conversation_reset", async () => {
  const capture = await scenario({ late: true, endTurn: true, reset: true });
  expect(capture.ending.outcome).toMatchObject({
    status: "failed",
    disposition: "broken",
    failure: { reason: "protocol-error" },
  });
  expect(capture.diagnosis?.firedPath).toBe("publishedFrameAfterEnding");
  expect(capture.diagnosis?.observerError).toBe(false);
});

// Reason: an unsent prompt's reply cannot bind to a turn that is cleaning up its result.
test("review R24 rejects a foreign-stamped tail during result cleanup", async () => {
  const capture = await scenario({
    late: true,
    endTurn: true,
    afterResult: true,
    tailStamp: "foreign",
  });
  expect(capture.ending.outcome).toMatchObject({
    status: "failed",
    disposition: "broken",
    failure: { reason: "protocol-error" },
  });
  expect(capture.diagnosis?.firedPath).toBe("stampNotSent");
  expect(capture.diagnosis?.observerError).toBe(false);
});

for (const afterResult of [false, true]) {
  // Reason: an explicitly empty binding must fault both before and during result cleanup.
  test(`R24b rejects an empty-stamped tail ${afterResult ? "during cleanup" : "in the open turn"}`, async () => {
    const capture = await scenario({
      late: true,
      endTurn: true,
      afterResult,
      tailStamp: "empty",
    });
    expect(capture.ending.outcome).toMatchObject({
      status: "failed",
      disposition: "broken",
      failure: { reason: "protocol-error" },
    });
    expect(capture.diagnosis?.firedPath).toBe("emptyStampArray");
    expect(capture.diagnosis?.observerError).toBe(false);
  });
}

// Reason: reset also invalidates stream position while the ending result's cleanup is held open.
test("R24b rejects a reset tail during result cleanup", async () => {
  const capture = await scenario({
    late: true,
    endTurn: true,
    afterResult: true,
    reset: true,
  });
  expect(capture.ending.outcome).toMatchObject({
    status: "failed",
    disposition: "broken",
    failure: { reason: "protocol-error" },
  });
  expect(capture.diagnosis?.firedPath).toBe("publishedFrameAfterEnding");
  expect(capture.diagnosis?.observerError).toBe(false);
});

// Reason: an init frame that replaces session identity invalidates the preceding published stream.
test("R24b rejects a stale tail after init replaces the session", async () => {
  const capture = await scenario({
    late: true,
    endTurn: true,
    reinitialize: "changed",
  });
  expect(capture.ending.outcome).toMatchObject({
    status: "failed",
    disposition: "broken",
    failure: { reason: "protocol-error" },
  });
  expect(capture.diagnosis?.firedPath).toBe("publishedFrameAfterEnding");
  expect(capture.diagnosis?.observerError).toBe(false);
});

// Reason: another init for the same session does not replace the published response's identity.
test("R24b preserves tail eligibility for init with the same session", async () => {
  const capture = await scenario({
    late: true,
    endTurn: true,
    reinitialize: "same",
  });
  expect(capture.ending.outcome).toEqual({ status: "completed" });
  expect(capture.diagnosis?.firedPath).toBe("none");
  expect(capture.diagnosis?.observerError).toBe(false);
});
