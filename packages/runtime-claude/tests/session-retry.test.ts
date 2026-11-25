// Reason: typed provider failure alone must never authorize replay of an uncertain tool effect.
import { expect, test } from "bun:test";
import {
  Account,
  RuntimeEvent,
  TurnLimit,
  type SessionPolicy,
} from "@neuve/runtime";
import { Effect, Layer, Stream } from "effect";
import { makeRuntime } from "../src/runtime.ts";
import { ClaudeExecutable, ClaudeProcess } from "../src/services.ts";
import { assistant, result, SESSION_ID } from "./frames.ts";
import { inbound, out, replay, type Entry } from "./replay.ts";

const account = Account.parse({
  name: "fixture",
  kind: "claude-subscription",
  runtime: "claude-code",
  credential: { kind: "claude-config-folder" },
});
async function run(entries: Entry[]) {
  let effects = 0;
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
  return { ended, effects };
}
const transient = () => result({ is_error: true, api_error_status: 503 });
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
  expect(ambiguous.ended.outcome).not.toHaveProperty("retry");
  const safe = await run([
    ...toolEntries(),
    inbound({
      type: "user",
      parent_tool_use_id: null,
      session_id: SESSION_ID,
      uuid: "00000000-0000-4000-8000-000000000002",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "effect", content: "recorded" },
        ],
      },
    }),
    inbound(transient()),
  ]);
  expect(safe.effects).toBe(1);
  expect(safe.ended).toMatchObject({
    resumePoint: "00000000-0000-4000-8000-000000000002",
    outcome: { retry: { kind: "transient-provider", continuation: "resume" } },
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
