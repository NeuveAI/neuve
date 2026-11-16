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
import { observeSmokeSdk } from "../src/smoke-runtime.ts";
import { fixtureReplay, inbound, out, replay, type Entry } from "./replay.ts";
import { assistant, result, SESSION_ID, usage } from "./frames.ts";
import { fixtureSchema } from "../src/smoke-fixture-recorder.ts";
import fixture from "./fixtures/multi-round-parallel.fixture.json";

const account = Account.parse({
  name: "fixture",
  kind: "claude-subscription",
  runtime: "claude-code",
  credential: { kind: "claude-config-folder" },
});
const schema = { type: "object", properties: {}, additionalProperties: false };
const partial = (
  event: SDKPartialAssistantMessage["event"],
): SDKPartialAssistantMessage => ({
  type: "stream_event",
  event,
  parent_tool_use_id: null,
  uuid: crypto.randomUUID(),
  session_id: SESSION_ID,
});
const begin = (id: string) =>
  partial({
    type: "message_start",
    message: {
      ...assistant(undefined).message,
      id,
      content: [],
      stop_reason: null,
    },
  });
const toolReply = (id: string, callId: string, name = "note") => {
  const frame = assistant(undefined);
  frame.message.id = id;
  frame.message.stop_reason = null;
  frame.message.content = [
    { type: "tool_use", id: callId, name: `mcp__neuve__${name}`, input: {} },
  ];
  return frame;
};
const carrier = (callId: string): SDKMessage => ({
  type: "user",
  parent_tool_use_id: null,
  session_id: SESSION_ID,
  uuid: crypto.randomUUID(),
  message: {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: callId, content: "" }],
  },
});
const dispatch = (callId: string, name = "note"): Entry => ({
  type: "smoke.tool.calls",
  schemas: { note: schema, finish: schema },
  dispatchOnly: true,
  calls: [{ name, callId, input: {} }],
});

async function run(
  build: (state: {
    interrupt: () => Promise<void>;
    seen: RuntimeEvent[];
    handled: string[];
    waitFor: (predicate: (event: RuntimeEvent) => boolean) => Promise<void>;
  }) => Entry[],
  throwing = false,
) {
  let interrupt: () => Promise<void> = async () => {
    throw new Error("Session not open");
  };
  const seen: RuntimeEvent[] = [];
  const handled: string[] = [];
  const observers = new Set<(event: RuntimeEvent) => void>();
  const waitFor = (predicate: (event: RuntimeEvent) => boolean) => {
    if (seen.some(predicate)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const observe = (event: RuntimeEvent) => {
        if (!predicate(event)) return;
        observers.delete(observe);
        resolve();
      };
      observers.add(observe);
    });
  };
  const logs: unknown[] = [];
  const observation = diagnoseObservation({ tools: true });
  let diagnosis: ReturnType<typeof observation.event>;
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
      inputSchema: schema,
      handle: (_input, context) =>
        Effect.sync(() => {
          if (context === undefined) throw new Error("Missing context");
          handled.push(name);
          observation.handler(context.callId);
          return {
            text: "fixture",
            ...(name === "finish" ? { endTurn: true } : {}),
          };
        }),
    })),
  };
  const fake = replay(
    build({ seen, handled, waitFor, interrupt: () => interrupt() }),
  );
  await Effect.runPromise(
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
        const session = yield* runtime.openSession(account, policy);
        interrupt = () =>
          Effect.runPromise(
            session.interruptTurn({ turnId: "one", reason: "stop" }),
          );
        yield* session.startTurn({ turnId: "one", message: "fixture" });
        yield* Stream.runForEach(
          session.events.pipe(
            Stream.takeUntil((event) => event.type === "turn.finished"),
          ),
          (event) =>
            Effect.sync(() => {
              RuntimeEvent.parse(event);
              seen.push(event);
              for (const observe of observers) observe(event);
              diagnosis = observation.event(event) ?? diagnosis;
            }),
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
            Logger.make(({ message, logLevel }) => {
              if (logLevel !== "Warn") return;
              logs.push(...(Array.isArray(message) ? message : [message]));
              if (throwing) throw new Error("Logger failed");
            }),
          ]),
        ),
      ),
      Effect.timeout("3 seconds"),
    ),
  );
  return { seen, handled, logs, diagnosis };
}
const wrapped = (entries: Entry[]) => [
  out({ type: "query.open" }),
  out({ type: "prompt.offer", message: "fixture" }),
  ...entries,
  out({ type: "query.close" }),
];
const completed = (seen: RuntimeEvent[]) =>
  expect(seen.at(-1)).toMatchObject({
    type: "turn.finished",
    outcome: { status: "completed" },
  });
const ordered = (seen: RuntimeEvent[]) => {
  for (const [index, event] of seen.entries()) {
    if (event.type !== "tool.finished") continue;
    expect(
      seen
        .slice(0, index)
        .some(
          (started) =>
            started.type === "tool.started" && started.callId === event.callId,
        ),
    ).toBe(true);
  }
};

// Reason: stream failure must discard an unannounced settlement without replacing the provider failure.
test("R25e unannounced settlement on stream failure preserves event order", async () => {
  const output = await run(() =>
    wrapped([
      inbound(begin("early-fault")),
      dispatch("unannounced"),
      inbound(carrier("unannounced")),
      { type: "stream_failure" },
    ]),
  );
  expect(output.handled).toEqual(["note"]);
  expect(output.seen.at(-1)).toMatchObject({
    type: "turn.finished",
    outcome: {
      status: "failed",
      disposition: "broken",
      failure: { reason: "provider-failed" },
    },
  });
  ordered(output.seen);
  expect(output.seen.map((event) => event.type)).toEqual([
    "turn.started",
    "turn.finished",
  ]);
});

// Reason: interrupting before announcement must discard the settlement and preserve the requested interruption.
test("R25e unannounced settlement on interrupt preserves event order", async () => {
  let pending: Promise<void> | undefined;
  const output = await run(({ interrupt }) =>
    wrapped([
      inbound(begin("early-interrupt")),
      dispatch("unannounced"),
      inbound(carrier("unannounced")),
      {
        type: "pause",
        get until() {
          pending = interrupt();
          return Promise.resolve();
        },
      },
    ]),
  );
  await pending;
  expect(output.handled).toEqual(["note"]);
  expect(output.seen.at(-1)).toMatchObject({
    type: "turn.finished",
    outcome: { status: "interrupted", reason: "stop" },
  });
  ordered(output.seen);
  expect(output.seen.map((event) => event.type)).toEqual([
    "turn.started",
    "turn.finished",
  ]);
});

const invalid = { type: 42 } as unknown as SDKMessage;
const foreign = { ...assistant(undefined), user_message_uuid: "unsent" };
const published = assistant(undefined);
published.message.id = "closed";
for (const [site, frames, line] of [
  ["invalid-frame", [invalid], "other"],
  ["reply-binding", [foreign], "assistant"],
  [
    "published-frame-open-turn",
    [begin("closed"), published, partial({ type: "message_stop" }), published],
    "assistant",
  ],
] as const) {
  for (const throwing of [false, true]) {
    // Reason: logger callbacks must not replace the protocol failure or duplicate its site warning.
    test(`R25c ${site} preserves protocol-error with ${throwing ? "throwing" : "normal"} logger`, async () => {
      const output = await run(() => wrapped(frames.map(inbound)), throwing);
      expect(output.seen.at(-1)).toMatchObject({
        type: "turn.finished",
        outcome: {
          status: "failed",
          disposition: "broken",
          failure: { reason: "protocol-error" },
        },
      });
      expect(output.logs).toEqual([
        `claude-runtime protocol-error site=${site} frame=${line}`,
      ]);
    });
  }
}

// Reason: the recorded last frame must remain in its open response and expose the second parallel call.
test("R25c recorded parallel response survives an early tool result", async () => {
  const restored = fixtureSchema.parse(structuredClone(fixture));
  const finish = toolReply("msg_3", "toolu_4", "finish");
  restored.frames.push(
    {
      type: "stream_event",
      parent_tool_use_id: null,
      event: { type: "content_block_stop", index: 1 },
    },
    {
      type: "user",
      parent_tool_use_id: null,
      uuid: "uuid_23",
      message: {
        content: [{ type: "tool_result", tool_use_id: "toolu_3", content: "" }],
      },
    },
    structuredClone(restored.frames[10]!),
    {
      type: "stream_event",
      parent_tool_use_id: null,
      event: { type: "message_stop" },
    },
    JSON.parse(JSON.stringify(finish)),
    {
      type: "user",
      parent_tool_use_id: null,
      uuid: "uuid_31",
      message: {
        content: [{ type: "tool_result", tool_use_id: "toolu_4", content: "" }],
      },
    },
    JSON.parse(
      JSON.stringify(
        result({
          modelUsage: {
            "claude-opus-5-5": {
              ...usage(4, 64),
              cacheReadInputTokens: 2396,
              cacheCreationInputTokens: 0,
            },
          },
        }),
      ),
    ),
  );
  const output = await run(({ handled, seen, waitFor }) => {
    const entries = fixtureReplay(restored, { note: schema, finish: schema });
    let received = 0;
    const boundary = entries.findIndex(
      (entry) =>
        entry.type === "emit_inbound" &&
        ++received === fixture.frames.length + 1,
    );
    entries.splice(boundary, 0, {
      type: "pause",
      get until() {
        return waitFor(
          () =>
            seen.filter((event) => event.type === "tool.finished").length === 2,
        ).then(() => {
          expect(handled).toEqual(["note", "note"]);
          expect(
            seen.filter((event) => event.type === "message.finished"),
          ).toHaveLength(1);
          expect(
            seen.filter((event) => event.type === "tool.finished"),
          ).toHaveLength(2);
        });
      },
    });
    return entries;
  });
  completed(output.seen);
  ordered(output.seen);
  expect(output.handled).toEqual(["note", "note", "note", "finish"]);
  expect(
    output.seen
      .filter((event) => event.type === "message.finished")
      .map((event) => event.toolCalls.length),
  ).toEqual([1, 2, 1]);
  expect(
    output.seen.filter((event) => event.type === "usage").at(-1),
  ).toMatchObject({ usage: { input: 4, output: 64, cacheRead: 2396 } });
  expect(output.seen.filter((event) => event.type === "usage")).toHaveLength(1);
  expect(output.logs).toEqual([]);
  expect(output.diagnosis?.firedPath).toBe("none");
});

// Reason: each of three handlers can finish while later blocks of the same response are still arriving.
test("R25c three mid-stream tool results settle before message publication", async () => {
  const output = await run(({ seen, handled, waitFor }) => {
    const entries: Entry[] = [inbound(begin("parallel"))];
    for (let index = 0; index < 3; index++) {
      const id = `call-${index}`;
      entries.push(
        inbound(
          partial({
            type: "content_block_start",
            index,
            content_block: {
              type: "tool_use",
              id,
              name: "mcp__neuve__note",
              input: {},
            },
          }),
        ),
        inbound(
          partial({
            type: "content_block_delta",
            index,
            delta: { type: "input_json_delta", partial_json: "{}" },
          }),
        ),
        inbound(toolReply("parallel", id)),
        inbound(partial({ type: "content_block_stop", index })),
        dispatch(id),
        inbound(carrier(id)),
        {
          type: "pause",
          get until() {
            return waitFor(
              (event) => event.type === "tool.finished" && event.callId === id,
            ).then(() => {
              expect(handled).toHaveLength(index + 1);
              expect(
                seen.some((event) => event.type === "message.finished"),
              ).toBe(false);
              expect(
                seen.filter((event) => event.type === "tool.finished"),
              ).toHaveLength(index + 1);
            });
          },
        },
      );
    }
    entries.push(
      inbound(partial({ type: "message_stop" })),
      inbound(toolReply("final", "finish", "finish")),
      dispatch("finish", "finish"),
      inbound(carrier("finish")),
      inbound(result()),
    );
    return wrapped(entries);
  });
  completed(output.seen);
  ordered(output.seen);
  expect(output.handled).toEqual(["note", "note", "note", "finish"]);
  expect(
    output.seen
      .filter((event) => event.type === "message.finished")
      .map((event) => event.toolCalls.length),
  ).toEqual([3, 1]);
  expect(
    output.seen.filter((event) => event.type === "tool.finished"),
  ).toHaveLength(4);
  expect(output.logs).toEqual([]);
  expect(output.diagnosis?.firedPath).toBe("none");
});

// Reason: parallel calls settle independently while their shared response is still streaming.
test("R25c2 parallel mid-stream results settle after announcement and publish once at message_stop", async () => {
  const output = await run(({ seen, waitFor }) => {
    const reply = toolReply("parallel", "first");
    reply.message.content.push({
      type: "tool_use",
      id: "second",
      name: "mcp__neuve__note",
      input: {},
    });
    return wrapped([
      inbound(begin("parallel")),
      inbound(reply),
      dispatch("second"),
      inbound(carrier("second")),
      dispatch("first"),
      inbound(carrier("first")),
      {
        type: "pause",
        get until() {
          return waitFor(
            (event) =>
              event.type === "tool.finished" && event.callId === "first",
          ).then(() => {
            expect(
              seen.map((event) =>
                "callId" in event ? [event.type, event.callId] : [event.type],
              ),
            ).toEqual([
              ["turn.started"],
              ["tool.started", "first"],
              ["tool.started", "second"],
              ["tool.finished", "second"],
              ["tool.finished", "first"],
            ]);
          });
        },
      },
      inbound(partial({ type: "message_stop" })),
      {
        type: "pause",
        get until() {
          return waitFor((event) => event.type === "message.finished").then(
            () => {
              expect(seen.map((event) => event.type)).toEqual([
                "turn.started",
                "tool.started",
                "tool.started",
                "tool.finished",
                "tool.finished",
                "message.finished",
              ]);
            },
          );
        },
      },
      inbound(result()),
    ]);
  });
  completed(output.seen);
  expect(
    output.seen.filter((event) => event.type === "message.finished"),
  ).toMatchObject([
    {
      messageId: "parallel",
      toolCalls: [{ callId: "first" }, { callId: "second" }],
    },
  ]);
  expect(output.logs).toEqual([]);
});
