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
import { Effect, Layer, Logger, Stream } from "effect";
import { makeRuntime } from "../src/runtime.ts";
import { ClaudeExecutable, ClaudeProcess, ClaudeSdk } from "../src/services.ts";
import { diagnoseObservation } from "../src/smoke-diagnose.ts";
import { toolsDiagnosis } from "../src/smoke-tools-diagnose.ts";
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
      ...assistant(undefined).message.usage,
      input_tokens: 11,
      output_tokens: 9,
    },
    context_management: null,
  });
const begin = (id: string) =>
  partial({
    type: "message_start",
    message: {
      ...assistant(undefined).message,
      id,
      content: [],
      stop_reason: null,
      usage: { ...assistant(undefined).message.usage, input_tokens: 11 },
    },
  });
const policy: SessionPolicy = {
  systemPrompt: "fixture",
  approvalPolicy: "allow",
  turnLimit: TurnLimit.parse(4),
  tools: [
    {
      name: "note",
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
      handle: () => Effect.succeed({ text: "fixture" }),
    },
  ],
};
const toolRound = (round: number, count: number, late: boolean): Entry[] => {
  const calls = Array.from({ length: count }, (_, index) => ({
    name: "note",
    callId: `call-${round}-${index}`,
    input: { value: "ok" },
  }));
  const reply = assistant(undefined);
  reply.message.id = `response-${round}`;
  reply.message.stop_reason = null;
  reply.message.content = calls.map((call) => ({
    type: "tool_use",
    id: call.callId,
    name: "mcp__neuve__note",
    input: call.input,
  }));
  const tail = [inbound(delta()), inbound(stop())];
  return [
    inbound(begin(reply.message.id)),
    inbound(reply),
    ...(!late ? tail : []),
    { type: "tool.calls", dispatchOnly: true, calls },
    inbound({
      type: "user",
      parent_tool_use_id: null,
      session_id: SESSION_ID,
      uuid: crypto.randomUUID(),
      message: {
        role: "user",
        content: calls.map((call) => ({
          type: "tool_result",
          tool_use_id: call.callId,
          content: "fixture",
        })),
      },
    }),
    ...(late ? tail : []),
  ];
};
async function run(entries: Entry[], turnLimit = 4) {
  const fake = replay([
    out({ type: "query.open" }),
    out({ type: "prompt.offer", message: "fixture" }),
    ...entries,
    out({ type: "query.close" }),
  ]);
  const observation = diagnoseObservation({ tools: true });
  const logs: unknown[] = [];
  const seen = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const sdk = yield* ClaudeSdk;
        const runtime = yield* makeRuntime({
          cwd: "/test",
          environment: {},
        }).pipe(
          Effect.provideService(ClaudeSdk, observeSmokeSdk(sdk, observation)),
        );
        observation.begin();
        observation.allowNormalSend();
        observation.toolPolicy(policy.tools);
        const session = yield* runtime.openSession(account, {
          ...policy,
          turnLimit: TurnLimit.parse(turnLimit),
        });
        yield* session.startTurn({ turnId: "one", message: "fixture" });
        return yield* Stream.runCollect(
          session.events.pipe(
            Stream.tap((event) =>
              Effect.sync(() => {
                RuntimeEvent.parse(event);
                observation.event(event);
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
          Logger.layer([
            observation.logger,
            Logger.make(({ message }) =>
              logs.push(...(Array.isArray(message) ? message : [message])),
            ),
          ]),
        ),
      ),
      Effect.timeout("3 seconds"),
    ),
  );
  return {
    seen,
    logs,
    ending: seen.findLast((event) => event.type === "turn.finished"),
    diagnosis: observation.partial(),
  };
}
for (const [variant, first, second] of [
  ["a", 1, 1],
  ["b", 1, 2],
  ["c", 3, 1],
] as const) {
  // Reason: a second tool round's late tail must allow an unstamped third streamed response after serial or parallel calls.
  test(`R25 replay ${variant} continues after two tool rounds`, async () => {
    const third = assistant(undefined, "fixture");
    third.message.id = "response-3";
    const { seen, logs, ending } = await run([
      ...toolRound(1, first, false),
      ...toolRound(2, second, true),
      inbound(begin("response-3")),
      inbound(
        partial({
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "", citations: [] },
        }),
      ),
      inbound(
        partial({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "fixture" },
        }),
      ),
      inbound(third),
      inbound(stop()),
      inbound(result({ modelUsage: { "test-model": usage(33, 18) } })),
    ]);
    expect(ending?.outcome).toEqual({ status: "completed" });
    expect(
      seen.filter((event) => event.type === "message.finished"),
    ).toHaveLength(3);
    expect(seen.filter((event) => event.type === "tool.finished")).toHaveLength(
      first + second,
    );
    expect(seen.filter((event) => event.type === "usage").at(-1)).toMatchObject(
      { usage: { input: 33, output: 18 } },
    );
    expect(logs).toEqual([]);
  });
}
// Reason: the limit-th response and late tail settle fully; only the third response reaches the reusable turn-limit boundary.
test("R25 replay d reaches the limit after round two", async () => {
  const { seen, logs, ending } = await run(
    [
      ...toolRound(1, 1, false),
      ...toolRound(2, 1, true),
      inbound(begin("response-3")),
    ],
    2,
  );
  expect(ending?.outcome).toMatchObject({
    status: "failed",
    disposition: "reusable",
    failure: { reason: "turn-limit-reached" },
  });
  expect(
    seen.filter((event) => event.type === "message.finished"),
  ).toHaveLength(2);
  expect(seen.filter((event) => event.type === "tool.finished")).toHaveLength(
    2,
  );
  expect(seen.filter((event) => event.type === "usage").at(-1)).toMatchObject({
    usage: { input: 22, output: 18 },
  });
  expect(logs).toEqual([]);
});

// Deliberately cross the declared SDK union at its untrusted IPC boundary.
const wire = (frame: unknown) => frame as SDKMessage;
for (const [name, frame, expected] of [
  [
    "invalid frame",
    wire({
      type: "assistant",
      message: {},
      content: "private-content",
      user_message_uuid: "private-stamp",
    }),
    "invalid-frame frame=assistant",
  ],
  [
    "unknown event",
    wire({ type: "stream_event", event: { type: "private_enum_like_value" } }),
    "invalid-frame frame=stream_event/other",
  ],
  [
    "unknown type",
    wire({ type: 42, subtype: "private-value" }),
    "invalid-frame frame=other",
  ],
  [
    "reply binding",
    { ...begin("response-1"), user_message_uuid: "private-stamp" },
    "reply-binding frame=stream_event/message_start",
  ],
] as const) {
  // Reason: each ingress fault needs one fixed warning, with only allowlisted frame tags and no provider values.
  test(`R25 site warning for ${name}`, async () => {
    const { logs, ending, diagnosis } = await run([inbound(frame)]);
    expect(ending?.outcome).toMatchObject({
      status: "failed",
      disposition: "broken",
      failure: { reason: "protocol-error" },
    });
    expect(logs).toEqual([`claude-runtime protocol-error site=${expected}`]);
    expect(diagnosis).toMatchObject({
      protocolError: { site: expected.split(" ")[0] },
    });
  });
}
// Reason: new content in a response already published by a non-ending tool must retain its protocol fault and name the exit.
test("R25 published content site", async () => {
  const { logs, ending } = await run([
    ...toolRound(1, 1, true),
    inbound(
      partial({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "private-content" },
      }),
    ),
  ]);
  expect(ending?.outcome).toMatchObject({
    status: "failed",
    disposition: "broken",
    failure: { reason: "protocol-error" },
  });
  expect(logs).toEqual([
    "claude-runtime protocol-error site=published-frame-open-turn frame=stream_event/content_block_delta",
  ]);
});
// Reason: collector input parsing can throw after valid ingress, so it needs a distinct warning without the rejected JSON.
test("R25 collector throw site", async () => {
  const { logs, ending } = await run([
    inbound(begin("response-1")),
    inbound(
      partial({
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "private-id",
          name: "mcp__neuve__note",
          input: {},
        },
      }),
    ),
    inbound(
      partial({
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json: "private-invalid-json",
        },
      }),
    ),
    inbound(partial({ type: "content_block_stop", index: 0 })),
  ]);
  expect(ending?.outcome).toMatchObject({
    status: "failed",
    disposition: "broken",
    failure: { reason: "protocol-error" },
  });
  expect(logs).toEqual([
    "claude-runtime protocol-error site=message-receive frame=stream_event/content_block_stop",
  ]);
});

// Reason: the diagnose arm must drive a single three-response turn through the real tool server and retain ordered tail and permission decisions.
test("R25 multi-round tools diagnosis through the production adapter", async () => {
  const diagnosis = toolsDiagnosis({ multiRound: true });
  const schemas = {
    note: { type: "object", properties: {}, additionalProperties: false },
    finish: { type: "object", properties: {}, additionalProperties: false },
  };
  const calls = (ids: string[], name = "note"): Entry => ({
    type: "smoke.tool.calls",
    schemas,
    calls: ids.map((callId) => ({ name, callId, input: {} })),
  });
  const permission = (callId: string): Entry[] => [
    { type: "permission.request", tool: "mcp__neuve__note", callId, input: {} },
    out({
      type: "permission.response",
      check: (decision) => expect(decision.behavior).toBe("allow"),
    }),
  ];
  const roundOne = assistant(undefined);
  roundOne.message.id = "response-1";
  roundOne.message.stop_reason = null;
  roundOne.message.content = [
    { type: "tool_use", id: "one", name: "mcp__neuve__note", input: {} },
  ];
  const roundTwo = assistant(undefined);
  roundTwo.message.id = "response-2";
  roundTwo.message.stop_reason = null;
  roundTwo.message.content = ["two", "three"].map((id) => ({
    type: "tool_use",
    id,
    name: "mcp__neuve__note",
    input: {},
  }));
  const carrier = (ids: string[]): SDKMessage => ({
    type: "user",
    parent_tool_use_id: null,
    session_id: SESSION_ID,
    uuid: crypto.randomUUID(),
    message: {
      role: "user",
      content: ids.map((id) => ({
        type: "tool_result",
        tool_use_id: id,
        content: "private-tool-output",
      })),
    },
  });
  const fake = replay([
    out({ type: "query.open" }),
    out({ type: "query.close" }),
    out({ type: "query.open" }),
    out({
      type: "prompt.offer",
      message: /^Call note once in your first response\./,
    }),
    inbound(begin("response-1")),
    inbound(roundOne),
    inbound(delta()),
    inbound(stop()),
    ...permission("one"),
    {
      type: "smoke.tool.calls",
      schemas,
      dispatchOnly: true,
      calls: [{ name: "note", callId: "one", input: {} }],
    },
    inbound(carrier(["one"])),
    inbound(begin("response-2")),
    inbound(roundTwo),
    ...permission("two"),
    ...permission("three"),
    {
      type: "smoke.tool.calls",
      schemas,
      dispatchOnly: true,
      calls: ["two", "three"].map((callId) => ({
        name: "note",
        callId,
        input: {},
      })),
    },
    inbound(carrier(["two", "three"])),
    inbound(delta()),
    inbound(stop()),
    calls(["finish"], "finish"),
    inbound(carrier(["finish"])),
    inbound(result()),
    out({ type: "query.close" }),
  ]);
  const logs: unknown[] = [];
  const output = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const sdk = yield* ClaudeSdk;
        const runtime = yield* makeRuntime({
          cwd: "/test",
          environment: {},
        }).pipe(
          Effect.provideService(
            ClaudeSdk,
            observeSmokeSdk(sdk, diagnosis.observation),
          ),
        );
        return yield* diagnosis.run(runtime, account);
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
          Logger.layer([Logger.make(({ message }) => logs.push(message))]),
        ),
      ),
      Effect.timeout("3 seconds"),
    ),
  );
  expect(output).toMatchObject({
    mode: "diagnose-tools-multi-round",
    requestsStarted: 3,
    requestsCompleted: 3,
    expectedRequests: 3,
    withinPlan: true,
    stoppedAtCap: false,
    tools: {
      firedPath: "none",
      outcome: { status: "completed" },
      checks: {
        toolsCompleted: true,
        noteCalls: 3,
        finishCalls: 1,
        threeResponses: true,
        roundOneSingle: true,
        roundTwoParallel: true,
        roundThreeFinish: true,
        protocolError: false,
      },
      handlers: {
        note: { calls: 3, returnedError: false },
        finish: { calls: 1, returnedError: false },
      },
      canUseTool: [
        { tool: "note", behavior: "allow" },
        { tool: "note", behavior: "allow" },
        { tool: "note", behavior: "allow" },
      ],
    },
  });
  const tail = output.tools.frames?.filter(
    (frame) => frame.subtype === "message_delta",
  );
  expect(tail?.map((frame) => frame.publishedTail)).toEqual([false, false]);
  expect(output.tools.protocolError).toBeUndefined();
  expect(logs).toEqual([]);
  const json = JSON.stringify(output);
  expect(json).not.toContain("private-");
  expect(json).not.toContain(SESSION_ID);
});
