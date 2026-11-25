// Reason: typed provider failure alone must never authorize replay of an uncertain tool effect.
import { expect, test } from "bun:test";
import {
  Account,
  RuntimeEvent,
  TurnLimit,
  type SessionPolicy,
} from "@neuve/runtime";
import { Effect, Layer, Logger, Stream } from "effect";
import type { SDKPartialAssistantMessage } from "@anthropic-ai/claude-agent-sdk";
import { makeRuntime } from "../src/runtime.ts";
import { ClaudeExecutable, ClaudeProcess } from "../src/services.ts";
import { assistant, errorResult, result, SESSION_ID } from "./frames.ts";
import { inbound, out, replay, type Entry } from "./replay.ts";

const account = Account.parse({
  name: "fixture",
  kind: "claude-subscription",
  runtime: "claude-code",
  credential: { kind: "claude-config-folder" },
});
async function run(entries: Entry[]) {
  let effects = 0;
  const diagnostics: unknown[] = [];
  const policy: SessionPolicy = {
    systemPrompt: "fixture",
    approvalPolicy: "allow",
    turnLimit: TurnLimit.parse(4),
    tools: [
      {
        name: "note",
        description: "fixture",
        hints: {
          readOnly: false,
          destructive: false,
          idempotent: false,
          openWorld: false,
        },
        inputSchema: {
          type: "object",
          properties: { value: { type: "string", minLength: 2 } },
          required: ["value"],
          additionalProperties: false,
        },
        handle: () =>
          Effect.sync(() => {
            effects++;
            return { text: "recorded" };
          }),
      },
    ],
  };
  const fake = replay([
    out({ type: "query.open" }),
    out({ type: "prompt.offer", message: "fixture" }),
    ...entries,
    out({ type: "query.close" }),
  ]);
  const events = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* makeRuntime({
          cwd: "/test",
          environment: {},
          identity: { sessionId: SESSION_ID },
        });
        const session = yield* runtime.openSession(account, policy);
        yield* session.startTurn({ turnId: "one", message: "fixture" });
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
          Logger.layer([
            Logger.make(({ message }) => {
              diagnostics.push(message);
            }),
          ]),
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
  const ended = events.findLast((event) => event.type === "turn.finished");
  if (ended?.type !== "turn.finished") throw new Error("No terminal event");
  return { ended, effects, diagnostics };
}
const transient = () => result({ is_error: true, api_error_status: 503 });
const malformedToolUse = () =>
  errorResult("error_during_execution", {
    terminal_reason: "malformed_tool_use_exhausted",
  });
const toolReply = () => {
  const reply = assistant(undefined);
  reply.message.stop_reason = "tool_use";
  reply.message.content = [
    {
      type: "tool_use",
      id: "effect",
      name: "mcp__neuve__note",
      input: { value: "ok" },
    },
  ];
  return reply;
};
const toolEntries = (): Entry[] => [
  inbound(toolReply()),
  {
    type: "tool.calls",
    dispatchOnly: true,
    calls: [{ name: "note", callId: "effect", input: { value: "ok" } }],
  },
];
const carrier = "00000000-0000-4000-8000-000000000002";
const savedResult = () =>
  inbound({
    type: "user",
    parent_tool_use_id: null,
    session_id: SESSION_ID,
    uuid: carrier,
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "effect", content: "recorded" },
      ],
    },
  });

test("typed transient result without tools permits safe request repetition", async () => {
  const { ended } = await run([inbound(transient())]);
  expect(ended.outcome).toMatchObject({
    status: "failed",
    disposition: "reusable",
    retry: { kind: "transient-provider", continuation: "repeat-request" },
  });
});

test("completed tool needs a saved provider result carrier before continuation can retry", async () => {
  const ambiguous = await run([...toolEntries(), inbound(transient())]);
  expect(ambiguous.effects).toBe(1);
  expect(ambiguous.ended.outcome.status).toBe("failed");
  expect(ambiguous.ended.outcome).toMatchObject({
    status: "failed",
    failure: { reason: "ambiguous-tool-effect" },
  });
  expect(ambiguous.ended.outcome).not.toHaveProperty("retry");
  const safe = await run([
    ...toolEntries(),
    savedResult(),
    inbound(transient()),
  ]);
  expect(safe.effects).toBe(1);
  expect(safe.ended).toMatchObject({
    resumePoint: carrier,
    outcome: { retry: { kind: "transient-provider", continuation: "resume" } },
  });
});

// Reason: a bound malformed-tool result can repeat its single request before any tool runs.
test("exhausted malformed tool use permits a protocol retry before tool execution", async () => {
  const { ended } = await run([inbound(malformedToolUse())]);
  expect(ended.outcome).toEqual({
    status: "failed",
    disposition: "reusable",
    failure: {
      _tag: "TurnFailed",
      account: account.name,
      reason: "protocol-error",
    },
    retry: { kind: "protocol", continuation: "repeat-request" },
  });
});

// Reason: after a tool runs, a protocol retry needs its saved result in the provider session.
test("exhausted malformed tool use resumes from a saved result carrier", async () => {
  const { ended, effects } = await run([
    ...toolEntries(),
    savedResult(),
    inbound(malformedToolUse()),
  ]);
  expect(effects).toBe(1);
  expect(ended).toMatchObject({
    resumePoint: carrier,
    outcome: {
      status: "failed",
      disposition: "reusable",
      failure: { reason: "protocol-error" },
      retry: { kind: "protocol", continuation: "resume" },
    },
  });
});

// Reason: a tool that ran without a saved result might repeat its side effect on protocol retry.
test("exhausted malformed tool use with an unsaved tool result ends the turn", async () => {
  const { ended, effects } = await run([
    ...toolEntries(),
    inbound(malformedToolUse()),
  ]);
  expect(effects).toBe(1);
  expect(ended.outcome).toEqual({
    status: "failed",
    disposition: "reusable",
    failure: {
      _tag: "TurnFailed",
      account: account.name,
      reason: "ambiguous-tool-effect",
    },
  });
});

// Reason: a result attributed to a foreign send breaks the stream's turn binding.
test("an unbound malformed-tool result leaves the session broken", async () => {
  const { ended } = await run([
    inbound({ ...malformedToolUse(), user_message_uuid: "foreign-send" }),
  ]);
  expect(ended.outcome).toEqual({
    status: "failed",
    disposition: "broken",
    failure: {
      _tag: "TurnFailed",
      account: account.name,
      reason: "protocol-error",
    },
  });
});

test("displayed transient-looking text and terminal account or refusal outcomes do not authorize retries", async () => {
  const textOnly = result({
    is_error: true,
    result: "server error retry connection lost 503",
  });
  const refusal = assistant(undefined);
  refusal.message.stop_reason = "refusal";
  for (const entries of [
    [inbound(textOnly)],
    [
      inbound(assistant("authentication_failed", "Not signed in")),
      inbound(result({ is_error: true })),
    ],
    [
      inbound(assistant("rate_limit", "TEST_USAGE_LIMIT")),
      inbound(result({ is_error: true, api_error_status: 429 })),
    ],
    [inbound(refusal), inbound(transient())],
  ]) {
    const { ended } = await run(entries);
    expect(ended.outcome).not.toHaveProperty("retry");
  }
});

// Reason: the exceptional skip must be observable without leaking the provider body.
// Recorded-order reconstruction from the worker warning, not the retained November incident.
test("skipped closing-frame diagnostic contains only shape, reason and logical turn", async () => {
  const partial = (
    event: SDKPartialAssistantMessage["event"],
  ): SDKPartialAssistantMessage => ({
    type: "stream_event",
    event,
    parent_tool_use_id: null,
    uuid: crypto.randomUUID(),
    session_id: SESSION_ID,
  });
  const reply = assistant(undefined, "private-provider-body");
  const { ended, diagnostics } = await run([
    inbound(
      partial({
        type: "message_start",
        message: { ...reply.message, stop_reason: null, content: [] },
      }),
    ),
    inbound(
      partial({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "", citations: [] },
      }),
    ),
    inbound(reply),
    inbound(partial({ type: "content_block_stop", index: 0 })),
    inbound(partial({ type: "message_stop" })),
    inbound(partial({ type: "content_block_stop", index: 0 })),
    inbound(result()),
  ]);
  expect(ended.outcome).toEqual({ status: "completed" });
  expect(diagnostics).toEqual([
    [
      "claude-runtime skipped-frame",
      {
        turn: "one",
        reason: "closed-response",
        frame: "stream_event/content_block_stop",
      },
    ],
  ]);
  expect(JSON.stringify(diagnostics)).not.toContain("private-provider-body");
});
