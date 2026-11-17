import { expect, mock } from "bun:test";
import type { RuntimeEvent } from "@neuve/runtime";
import { Context, Effect, Exit, Layer, Scope, Stream } from "effect";
import { makeRuntime } from "../src/runtime.ts";
import { ClaudeExecutable, ClaudeProcess, ClaudeSdk } from "../src/services.ts";
import { assistant, errorResult, result, usage, SESSION_ID } from "./frames.ts";
import { inbound, out, replay, type Entry } from "./replay.ts";

const mode = Bun.argv[4];
let messageToken = "";
let steerToken = "";
let toolToken = "";
let forkId: string | undefined;
const first = result({ queued_turn_count: mode === "folded-steer" ? 0 : 1 });
const second = result();
const resumed = result();
const forked = result();
const normalReply = assistant(undefined);
normalReply.message.id = "normal";
const finalReply = assistant(undefined);
finalReply.message.id = "final";
const firstReply = assistant(undefined);
firstReply.message.id = "first";
const secondReply = assistant(undefined);
secondReply.message.id = "second";
const resumedReply = assistant(undefined);
resumedReply.message.id = "resumed";
const forkReply = assistant(undefined);
forkReply.message.id = "fork";
const refusedFinalReply = assistant(undefined);
refusedFinalReply.message.id = "refused-final";
const modelUsage = { "test-model": usage(10) };
const recall =
  "Return the remembered messageToken and steerToken in the requested schema.";
const schemas = {
  note: { type: "object", properties: {}, additionalProperties: false },
  finish: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: { steerToken: { type: "string" } },
    required: ["steerToken"],
    additionalProperties: false,
  },
};
const refusedSchemas = {
  submit: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: { ok: { type: "boolean" } },
    required: ["ok"],
    additionalProperties: false,
  },
};
const entries: Entry[] = [
  out({
    type: "query.open",
    models: [
      {
        value: "default",
        resolvedModel: "test-model",
        displayName: "fixture",
        description: "fixture",
      },
    ],
  }),
  out({ type: "query.close" }),
  out({ type: "query.open" }),
  out({ type: "prompt.offer", message: "Reply briefly." }),
  inbound(normalReply),
  inbound(
    mode === "normal-failed"
      ? errorResult("error_max_turns", { modelUsage })
      : result({ modelUsage }),
  ),
  out({ type: "query.close" }),
  out({ type: "query.open" }),
  out({ type: "prompt.offer", message: "Return ok as true." }),
  inbound(finalReply),
  inbound(
    mode === "final-failed"
      ? errorResult("error_max_turns", { modelUsage })
      : result({
          modelUsage,
          structured_output:
            mode === "final-invalid"
              ? { ok: "true" }
              : mode === "final-missing"
                ? undefined
                : { ok: true },
        }),
  ),
  out({ type: "query.close" }),
  out({ type: "query.open" }),
  out({
    type: "prompt.offer",
    message: /^Remember messageToken as /,
    check: (message) => {
      messageToken =
        String(message.message.content).match(/as ([a-f0-9-]+)\./)?.[1] ?? "";
      first.user_message_uuids = [message.uuid!];
    },
  }),
  out({
    type: "prompt.offer",
    message: /^Remember steerToken as /,
    priority: "now",
    check: (message) => {
      steerToken =
        String(message.message.content).match(/as ([a-f0-9-]+)\./)?.[1] ?? "";
      second.user_message_uuids = [message.uuid!];
      if (mode === "folded-steer")
        first.user_message_uuids?.push(message.uuid!);
      resumed.structured_output = forked.structured_output = {
        messageToken: mode === "message-missing" ? "absent" : messageToken,
        steerToken: mode === "steer-missing" ? "absent" : steerToken,
      };
    },
  }),
  inbound(firstReply),
  inbound(first),
  ...(mode === "folded-steer" ? [] : [inbound(secondReply), inbound(second)]),
  out({ type: "query.close" }),
  out({ type: "query.open" }),
  out({ type: "query.close" }),
  out({ type: "query.open" }),
  out({ type: "prompt.offer", message: recall }),
  inbound(resumedReply),
  inbound(resumed),
  out({ type: "query.close" }),
  out({
    type: "query.open",
    check: (options) => {
      forkId = options.sessionId;
      forkReply.session_id = forked.session_id = forkId ?? SESSION_ID;
    },
  }),
  out({ type: "query.close" }),
  out({ type: "query.open" }),
  out({ type: "prompt.offer", message: recall }),
  inbound(forkReply),
  inbound(forked),
  out({ type: "query.close" }),
  out({ type: "query.open" }),
  out({
    type: "prompt.offer",
    message:
      "Call note once, then finish once with the steerToken supplied while note runs.",
  }),
  {
    type: "smoke.tool.calls",
    schemas,
    calls: [{ name: "note", callId: "note", input: {} }],
  },
  out({
    type: "prompt.offer",
    message: /^Use steerToken as /,
    priority: "now",
    check: (message) => {
      toolToken =
        String(message.message.content).match(/as ([a-f0-9-]+)\./)?.[1] ?? "";
    },
  }),
  {
    type: "smoke.tool.calls",
    schemas,
    calls: [
      {
        name: "finish",
        callId: "finish",
        get input() {
          return { steerToken: toolToken };
        },
      },
    ],
  },
  inbound({
    type: "user",
    uuid: crypto.randomUUID(),
    session_id: SESSION_ID,
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "finish", content: "fixture" },
      ],
    },
  }),
  inbound(mode === "tool-extra" ? assistant(undefined) : result()),
  out({ type: "query.close" }),
  out({ type: "query.open" }),
  out({
    type: "prompt.offer",
    message: "Call submit once with ok set to true.",
  }),
  {
    type: "smoke.tool.calls",
    schemas: refusedSchemas,
    calls: [{ name: "submit", callId: "refused", input: { ok: true } }],
  },
  inbound({
    type: "user",
    uuid: crypto.randomUUID(),
    session_id: SESSION_ID,
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "refused",
          content: "fixture",
          is_error: false,
        },
      ],
    },
  }),
  inbound(result()),
  out({ type: "query.close" }),
  out({ type: "query.open" }),
  out({ type: "prompt.offer", message: /turn limit/ }),
  inbound(refusedFinalReply),
  inbound(result({ modelUsage, structured_output: { ok: true } })),
  out({ type: "query.close" }),
];

if (mode === "fork-failure") {
  const forkReplyIndex = entries.findIndex(
    (entry) => entry.type === "emit_inbound" && entry.frame === forkReply,
  );
  entries.splice(
    forkReplyIndex - 2,
    entries.length - forkReplyIndex + 2,
    out({ type: "query.open", initFail: true }),
    out({ type: "query.close" }),
  );
}

if (mode === "options-guard") {
  let index = 0;
  for (const entry of entries) {
    if (entry.type !== "expect_outbound" || entry.frame.type !== "query.open")
      continue;
    const check = entry.frame.check;
    const expected = index === 2 || index === 5 || index === 7 || index === 10;
    index++;
    entry.frame.check = (options) => {
      check?.(options);
      expect(options.outputFormat !== undefined).toBe(expected);
    };
  }
  expect(index).toBe(11);
}

const replayScope = Effect.runSync(Scope.make());
const replayContext = Effect.runSync(
  Layer.buildWithScope(replay(entries).layer, replayScope),
);
process.once("beforeExit", () =>
  Effect.runSync(Scope.close(replayScope, Exit.void)),
);

// Every open, prompt, tool call and close is replayed. No production process or SDK layer is available.
mock.module("../src/production.ts", () => ({
  executableLayer: Layer.succeed(ClaudeExecutable, {
    resolve: () => Effect.succeed("/test/claude"),
  }),
  processLayer: Layer.succeed(ClaudeProcess, {
    run: () => Effect.die("Smoke must not start an auth process"),
  }),
  sdkLayer: Layer.succeed(ClaudeSdk, Context.get(replayContext, ClaudeSdk)),
}));

// Reason: exercise the entrypoint's count limits with excess observed responses while retaining the replayed sessions.
const originalMakeRuntime = makeRuntime;
if (mode?.startsWith("plan-")) {
  mock.module("../src/runtime.ts", () => ({
    makeRuntime: (config: Parameters<typeof makeRuntime>[0]) =>
      originalMakeRuntime(config).pipe(
        Effect.map((runtime) => ({
          ...runtime,
          openSession: (...args: Parameters<typeof runtime.openSession>) =>
            runtime.openSession(...args).pipe(
              Effect.map((session) => {
                let duplicated = false;
                let omitted = false;
                return new Proxy(session, {
                  get(target, key) {
                    if (key !== "events") return Reflect.get(target, key);
                    return target.events.pipe(
                      Stream.flatMap((event): Stream.Stream<RuntimeEvent> => {
                        const step =
                          event.turnId === "smoke-normal"
                            ? "turns"
                            : event.turnId === "smoke-resumed-inputs"
                              ? "inputs"
                              : event.turnId === "smoke-fork"
                                ? "fork"
                                : event.turnId === "smoke-tools"
                                  ? "tools"
                                  : undefined;
                        if (event.type !== "message.finished")
                          return Stream.succeed(event);
                        // Offset each isolated overrun so only that step's plan can fail the run.
                        const offset =
                          mode === "plan-inputs"
                            ? event.turnId === "smoke-fork"
                            : mode !== "plan-total" &&
                              event.turnId === "smoke-inputs";
                        if (offset && !omitted) {
                          omitted = true;
                          return Stream.empty;
                        }
                        if (
                          step !== undefined &&
                          !duplicated &&
                          (mode === `plan-${step}` || mode === "plan-total")
                        ) {
                          duplicated = true;
                          return Stream.fromIterable([
                            event,
                            { ...event, messageId: `${event.messageId}-extra` },
                          ]);
                        }
                        return Stream.succeed(event);
                      }),
                    );
                  },
                });
              }),
            ),
        })),
      ),
  }));
}
