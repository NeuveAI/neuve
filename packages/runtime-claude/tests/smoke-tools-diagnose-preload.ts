import { expect, mock } from "bun:test";
import type {
  SDKMessage,
  SDKUserMessage,
  SDKUserMessageReplay,
} from "@anthropic-ai/claude-agent-sdk";
import { Context, Effect, Exit, Layer, Scope } from "effect";
import { makeRuntime } from "../src/runtime.ts";
import { ClaudeExecutable, ClaudeProcess, ClaudeSdk } from "../src/services.ts";
import { assistant, result, SESSION_ID } from "./frames.ts";
import { inbound, out, replay, type Entry } from "./replay.ts";

const mode = process.env.FIXTURE_FLAG_MODE ?? Bun.argv[5];
const replayed: SDKUserMessageReplay = {
  type: "user",
  parent_tool_use_id: null,
  uuid: "00000000-0000-4000-8000-000000000023",
  session_id: SESSION_ID,
  isReplay: true,
  isSynthetic: false,
  priority: "now",
  message: { role: "user", content: "private-steer-token" },
} satisfies SDKMessage;
const carrier = {
  type: "user",
  parent_tool_use_id: null,
  uuid: "00000000-0000-4000-8000-000000000024",
  session_id: SESSION_ID,
  tool_use_result: { private: "private-tool-output" },
  message: {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "private-call-id",
        content: "private-tool-output",
      },
    ],
  },
} satisfies SDKMessage;
let toolToken = "";
const end = result({ result: "private-result-text" });
const reply = assistant(undefined, "private-response-text");
reply.message.id = "private-second-request";
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
const open = () =>
  out({
    type: "query.open",
    models: [
      {
        value: "default",
        resolvedModel: "test-model",
        displayName: "fixture",
        description: "private-model-description",
      },
    ],
    check: (options) =>
      options.stderr?.("Error: --resume private-stderr-token\n"),
  });
const close = () => out({ type: "query.close" });
const entries: Entry[] = [
  open(),
  close(),
  open(),
  out({
    type: "prompt.offer",
    message:
      "Call note once, then finish once with the steerToken supplied while note runs.",
  }),
];
if (mode === "unknown" || mode === "structured") {
  entries.push(
    {
      type: "permission.request",
      tool: mode === "unknown" ? "private-unknown-tool" : "StructuredOutput",
      callId: "private-call-id",
      input: { private: "private-tool-input" },
    },
    out({
      type: "permission.response",
      check: (response) => expect(response.behavior).toBe("deny"),
    }),
  );
} else if (mode === "cap" || mode === "retry-cap") {
  if (mode === "cap") {
    for (let index = 0; index < 3; index++) {
      const frame = assistant(undefined, "private-response-text");
      frame.message.id = `private-request-${index}`;
      entries.push(inbound(frame));
    }
  } else {
    for (let index = 0; index < 3; index++)
      entries.push(
        inbound({
          type: "system",
          subtype: "api_retry",
          attempt: 1,
          max_retries: 4,
          retry_delay_ms: 0,
          error_status: 500,
          error: "server_error",
          uuid: crypto.randomUUID(),
          session_id: SESSION_ID,
        }),
      );
  }
} else {
  entries.push(
    {
      type: "permission.request",
      tool: "mcp__neuve__note",
      callId: "private-call-id",
      input: {},
    },
    out({
      type: "permission.response",
      check: (response) => expect(response.behavior).toBe("allow"),
    }),
  );
  entries.push(
    {
      type: "smoke.tool.calls",
      schemas,
      calls: [
        {
          name: "note",
          callId: "private-call-id",
          input: { private: "private-tool-input" },
        },
      ],
    },
    out({
      type: "prompt.offer",
      message: /^Use steerToken as /,
      priority: "now",
      check: (message: SDKUserMessage) => {
        replayed.message.content = message.message.content;
        toolToken =
          String(message.message.content).match(/as ([a-f0-9-]+)\./)?.[1] ?? "";
        replayed.uuid = message.uuid!;
        end.user_message_uuid = message.uuid!;
        end.user_message_uuids = [message.uuid!];
      },
    }),
  );
  if (mode === "rejected")
    Object.assign(replayed, { parent_tool_use_id: undefined });
  entries.push(
    inbound(
      mode === "published"
        ? {
            type: "stream_event",
            parent_tool_use_id: null,
            uuid: crypto.randomUUID(),
            session_id: SESSION_ID,
            event: { type: "message_stop" },
          }
        : replayed,
    ),
  );
  if (mode !== "rejected" && mode !== "published") {
    entries.push(inbound(carrier));
    if (mode === "frame-cap")
      for (let index = 0; index < 205; index++)
        entries.push(
          inbound({
            type: "system",
            subtype: "status",
            status: null,
            uuid: crypto.randomUUID(),
            session_id: SESSION_ID,
          }),
        );
    if (mode === "finish") {
      entries.push(
        {
          type: "smoke.tool.calls",
          schemas,
          calls: [
            {
              name: "finish",
              callId: "private-finish-call",
              get input() {
                return { steerToken: toolToken };
              },
            },
          ],
        },
        inbound({
          ...carrier,
          uuid: crypto.randomUUID(),
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "private-finish-call",
                content: "private-tool-output",
              },
            ],
          },
        }),
        inbound(end),
      );
    } else
      entries.push(
        inbound({
          type: "stream_event",
          parent_tool_use_id: "private-parent-id",
          uuid: crypto.randomUUID(),
          session_id: SESSION_ID,
          event: {
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "tool_use",
              id: "private-nested-call",
              name: "mcp__neuve__finish",
              input: { private: "private-tool-input" },
            },
          },
        }),
        inbound(reply),
        inbound(end),
      );
  }
}
entries.push(close());
if (mode === "recorder-getter") {
  const hostile = {
    type: "system",
    subtype: "status",
    status: null,
    uuid: crypto.randomUUID(),
    session_id: SESSION_ID,
  } satisfies SDKMessage;
  Object.defineProperty(hostile, "uuid", {
    get() {
      throw new Error("private-getter-error");
    },
  });
  entries.splice(entries.length - 2, 0, inbound(hostile));
}
const scope = Effect.runSync(Scope.make());
const context = Effect.runSync(
  Layer.buildWithScope(replay(entries).layer, scope),
);
process.once("beforeExit", () => Effect.runSync(Scope.close(scope, Exit.void)));
mock.module("../src/production.ts", () => ({
  executableLayer: Layer.succeed(ClaudeExecutable, {
    resolve: () => Effect.succeed("/test/claude"),
  }),
  processLayer: Layer.succeed(ClaudeProcess, {
    run: () => Effect.die("No process allowed"),
  }),
  sdkLayer: Layer.succeed(ClaudeSdk, Context.get(context, ClaudeSdk)),
}));

if (mode === "handler-error") {
  const original = makeRuntime;
  mock.module("../src/runtime.ts", () => ({
    makeRuntime: (config: Parameters<typeof makeRuntime>[0]) =>
      original({
        ...config,
        handleTool: (tool, input, call) =>
          tool.handle(input, call).pipe(
            Effect.map((outcome) => ({
              ...outcome,
              error: "private-handler-error",
            })),
          ),
      }),
  }));
}
