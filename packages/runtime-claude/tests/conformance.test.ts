import { expect, test } from "bun:test";
import type {
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  Account,
  RuntimeEvent,
  TurnLimit,
  type RuntimeSession,
  type SessionPolicy,
} from "@neuve/runtime";
import { Effect, Layer, Queue, Stream } from "effect";
import { makeRuntime } from "../src/runtime.ts";
import { ClaudeExecutable, ClaudeProcess } from "../src/services.ts";
import { assistant, result, SESSION_ID } from "./frames.ts";
import { inbound, out, replay, toolLifecycle, type Entry } from "./replay.ts";

const account = Account.parse({
  name: "test",
  kind: "claude-subscription",
  runtime: "claude-code",
  credential: { kind: "claude-config-folder" },
});
const policy: SessionPolicy = {
  systemPrompt: "fixture",
  tools: [],
  approvalPolicy: "allow",
  turnLimit: TurnLimit.parse(8),
};
const user = (
  content: SDKUserMessage["message"]["content"],
): SDKUserMessage => ({
  type: "user",
  parent_tool_use_id: null,
  uuid: crypto.randomUUID(),
  session_id: SESSION_ID,
  message: { role: "user", content },
});
const marker = (): SDKMessage => ({
  type: "rate_limit_event",
  uuid: crypto.randomUUID(),
  session_id: SESSION_ID,
  rate_limit_info: { status: "allowed" },
});
const reply = (id: string) => {
  const frame = assistant(undefined, "fixture");
  frame.message.id = id;
  return frame;
};
const read = (session: RuntimeSession) =>
  Effect.gen(function* () {
    const events: RuntimeEvent[] = [];
    const queue = yield* Queue.unbounded<RuntimeEvent>();
    const checkTools = toolLifecycle();
    yield* Stream.runForEach(session.events, (event) =>
      Effect.sync(() => {
        RuntimeEvent.parse(event);
        checkTools(event);
        events.push(event);
        Queue.offerUnsafe(queue, event);
      }),
    ).pipe(Effect.forkScoped);
    const next = (type: RuntimeEvent["type"]) =>
      Effect.gen(function* () {
        while (true) {
          const event = yield* Queue.take(queue);
          if (event.type === type) return event;
        }
      });
    return { events, next };
  });
function run(
  entries: Entry[],
  sessionPolicy: SessionPolicy,
  body: (
    session: RuntimeSession,
    reader: Effect.Success<ReturnType<typeof read>>,
  ) => Effect.Effect<void, unknown>,
) {
  const fake = replay(entries);
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* makeRuntime({ cwd: "/test", environment: {} });
        const session = yield* runtime.openSession(account, sessionPolicy, {
          kind: "new",
        });
        yield* body(session, yield* read(session));
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
}
const finished = (events: RuntimeEvent[]) =>
  events.filter((e) => e.type === "turn.finished");
const finalPoint = (events: RuntimeEvent[]) => {
  const end = events.findLast((e) => e.type === "turn.finished");
  return (
    end?.resumePoint ??
    events.findLast((e) => e.type === "message.finished")?.resumePoint
  );
};

for (const steerCount of [1, 2]) {
  for (const stop of [false, true]) {
    // Reason: accepting held steers is not storage; only their consumed result permits completion.
    // Stop must keep the last consumed checkpoint and cannot acknowledge the queued steers.
    test(`${stop ? "Stop preserves the consumed head before held steers are consumed" : "completion and its resume point follow consumption of held steers"}: ${steerCount}`, () => {
      const entered = Promise.withResolvers<void>();
      const releaseTool = Promise.withResolvers<void>();
      const releaseReplies = Promise.withResolvers<void>();
      const releaseResult = Promise.withResolvers<void>();
      let settled = false;
      const offered: string[] = [];
      const initial = user("message");
      const steers = Array.from({ length: steerCount }, (_, i) =>
        user(`steer-${i}`),
      );
      const firstResult = result({ queued_turn_count: steerCount });
      const covered = result({ queued_turn_count: 0, user_message_uuids: [] });
      const toolReply = reply("tool-call");
      const carrier = user([
        { type: "tool_result", tool_use_id: "call", content: "done" },
      ]);
      const beforeSteers = reply("before-steers");
      const afterSteers = reply("after-steers");
      const chain = [
        initial,
        toolReply,
        carrier,
        beforeSteers,
        ...steers,
        afterSteers,
      ];
      const entries: Entry[] = [
        out({ type: "query.open" }),
        out({
          type: "prompt.offer",
          message: "message",
          check: (message) => {
            if (message.uuid === undefined)
              throw new Error("Missing send uuid");
            initial.uuid = message.uuid;
            firstResult.user_message_uuids = [message.uuid!];
            offered.push("message");
          },
        }),
        inbound(initial),
        {
          type: "tool.calls",
          message: toolReply,
          calls: [{ name: "work", callId: "call", input: { value: "ok" } }],
          check: (results) => {
            expect(results).toMatchObject([
              { content: [{ type: "text", text: "done" }] },
            ]);
            expect(settled).toBe(true);
          },
        },
        ...steers.map((frame, i) =>
          out({
            type: "prompt.offer",
            message: `steer-${i}`,
            priority: "now",
            check: (message) => {
              expect(settled).toBe(true);
              if (message.uuid === undefined)
                throw new Error("Missing send uuid");
              frame.uuid = message.uuid;
              covered.user_message_uuids!.push(message.uuid!);
              offered.push(`steer-${i}`);
            },
          }),
        ),
        inbound(carrier),
        inbound(beforeSteers),
        inbound(firstResult),
        inbound(marker()),
        ...(stop
          ? []
          : [
              { type: "pause", until: releaseReplies.promise } satisfies Entry,
              ...steers.map(inbound),
              inbound(afterSteers),
              inbound(marker()),
              { type: "pause", until: releaseResult.promise } satisfies Entry,
              inbound(covered),
            ]),
        out({ type: "query.close" }),
      ];
      return run(
        entries,
        {
          ...policy,
          tools: [
            {
              name: "work",
              description: "fixture",
              inputSchema: {
                type: "object",
                properties: { value: { type: "string", minLength: 2 } },
                required: ["value"],
                additionalProperties: false,
              },
              hints: {
                readOnly: true,
                destructive: false,
                idempotent: true,
                openWorld: false,
              },
              handle: () =>
                Effect.gen(function* () {
                  entered.resolve();
                  yield* Effect.promise(() => releaseTool.promise);
                  settled = true;
                  return { text: "done" };
                }),
            },
          ],
        },
        (session, { events, next }) =>
          Effect.gen(function* () {
            yield* session.startTurn({ turnId: "turn", message: "message" });
            yield* Effect.promise(() => entered.promise);
            for (let i = 0; i < steerCount; i++)
              yield* session.steerTurn({
                turnId: "turn",
                message: `steer-${i}`,
              });
            expect(offered).toEqual(["message"]);
            expect(finished(events)).toHaveLength(0);
            releaseTool.resolve();
            yield* next("rate-limit");
            expect(offered).toEqual([
              "message",
              ...steers.map((_, i) => `steer-${i}`),
            ]);
            expect(finished(events)).toHaveLength(0);
            if (stop) {
              yield* session.interruptTurn({ turnId: "turn", reason: "stop" });
              expect(yield* next("turn.finished")).toMatchObject({
                outcome: { status: "interrupted", reason: "stop" },
              });
              expect(finalPoint(events)).toBe(beforeSteers.uuid);
              const lastConsumed = chain.indexOf(beforeSteers);
              for (const event of events) {
                if (
                  (event.type === "message.finished" ||
                    event.type === "turn.finished") &&
                  event.resumePoint !== undefined
                ) {
                  const index = chain.findIndex(
                    (frame) => frame.uuid === event.resumePoint,
                  );
                  expect(index).toBeGreaterThanOrEqual(0);
                  expect(index).toBeLessThanOrEqual(lastConsumed);
                }
              }
            } else {
              releaseReplies.resolve();
              yield* next("rate-limit");
              // Even a trailing assistant is not a receipt for the pending sends without its result.
              expect(finished(events)).toHaveLength(0);
              expect(covered.user_message_uuids).toEqual(
                steers.map((frame) => frame.uuid!),
              );
              releaseResult.resolve();
              expect(yield* next("turn.finished")).toMatchObject({
                outcome: { status: "completed" },
              });
              expect(finalPoint(events)).toBe(afterSteers.uuid);
              const pointIndex = chain.findIndex(
                (frame) => frame.uuid === finalPoint(events),
              );
              for (const input of [initial, carrier, ...steers])
                expect(pointIndex).toBeGreaterThan(chain.indexOf(input));
            }
            expect(finished(events)).toHaveLength(1);
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                releaseTool.resolve();
                releaseReplies.resolve();
                releaseResult.resolve();
              }),
            ),
          ),
      );
    });
  }
}

// Reason: the message-only path must wait for the result and publish a point after its input.
test("message-only completion waits for its result and resumes after the message", () => {
  const initial = user("message");
  const response = reply("plain");
  const covered = result({ user_message_uuids: [] });
  const release = Promise.withResolvers<void>();
  return run(
    [
      out({ type: "query.open" }),
      out({
        type: "prompt.offer",
        message: "message",
        check: (message) => {
          if (message.uuid === undefined) throw new Error("Missing send uuid");
          initial.uuid = message.uuid;
          covered.user_message_uuids = [message.uuid!];
        },
      }),
      inbound(initial),
      inbound(response),
      inbound(marker()),
      { type: "pause", until: release.promise },
      inbound(covered),
      out({ type: "query.close" }),
    ],
    policy,
    (session, { events, next }) =>
      Effect.gen(function* () {
        yield* session.startTurn({ turnId: "plain", message: "message" });
        yield* next("rate-limit");
        expect(finished(events)).toHaveLength(0);
        release.resolve();
        expect(yield* next("turn.finished")).toMatchObject({
          outcome: { status: "completed" },
        });
        expect(finished(events)).toHaveLength(1);
        expect(finalPoint(events)).toBe(response.uuid);
        expect(
          [initial.uuid, response.uuid].findIndex(
            (uuid) => uuid === finalPoint(events),
          ),
        ).toBeGreaterThan(0);
      }).pipe(Effect.ensuring(Effect.sync(() => release.resolve()))),
  );
});
