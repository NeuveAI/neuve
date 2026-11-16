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
import { Effect, Exit, Fiber, Layer, Queue, Scope, Stream } from "effect";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { openClaudeSession } from "../src/session.ts";
import { ClaudeSdk } from "../src/services.ts";
import { TOOL_USE_ID_INPUT } from "../src/tools.ts";
import { assistant, errorResult, result, textDelta, usage } from "./frames.ts";

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

// Reason: a reset replaces the durable conversation that final turns resume.
test("R5 reset continuation and final reopen use the new conversation", () =>
  run((f) =>
    Effect.gen(function* () {
      const session = yield* openClaudeSession(
        account,
        { ...policy, outputSchema: { type: "object" } },
        config,
      );
      const r = yield* reader(session);
      yield* session.startTurn({ turnId: "one", message: "/clear" });
      const fresh = "00000000-0000-4000-8000-000000000099";
      yield* Queue.offer(f.children[0]!.frames, {
        type: "conversation_reset",
        new_conversation_id: fresh,
        session_id: fresh,
        uuid: crypto.randomUUID(),
        trigger: "clear",
      });
      yield* Queue.offer(
        f.children[0]!.frames,
        result({ queued_turn_count: 0 }),
      );
      yield* r.until("turn.finished");
      const saved = yield* session.continuation;
      yield* session.startTurn({
        turnId: "final",
        message: "fixture",
        final: true,
      });
      expect({
        continuation: saved.sessionId === fresh,
        resume: f.children[1]!.options.resume === fresh,
      }).toEqual({ continuation: true, resume: true });
    }),
  ));

// Reason: a declared producer may echo a singular id without queue depth or plural stamps.
test("R5 singular-only drained steering finishes", () =>
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
          modelUsage: { m: usage(10) },
        }),
      );
      yield* r.until("usage");
      const finished = yield* r
        .until("turn.finished")
        .pipe(Effect.timeoutOption("50 millis"));
      expect(finished._tag).toBe("Some");
    }),
  ));

// Reason: two callers may stop the same turn before either reaches child disposal.
test("R5 concurrent Stop shares cleanup until disposal completes", async () => {
  const closing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const children: Array<{ frames: Queue.Queue<SDKMessage>; closed: boolean }> =
    [];
  const layer = Layer.succeed(ClaudeSdk, {
    prefixes: { usage: [], organization: [] },
    open: () =>
      Effect.gen(function* () {
        const child = {
          frames: yield* Queue.unbounded<SDKMessage>(),
          closed: false,
        };
        children.push(child);
        const close = Effect.promise(async () => {
          if (children.indexOf(child) === 0) {
            closing.resolve();
            await release.promise;
          }
          child.closed = true;
        }).pipe(Effect.andThen(Queue.shutdown(child.frames)));
        yield* Effect.addFinalizer(() => close);
        return {
          messages: Stream.fromQueue(child.frames),
          close,
          offer: () => Effect.void,
          interrupt: Effect.void,
          setModel: () => Effect.void,
          applyFlagSettings: () => Effect.void,
          initializationResult: Effect.succeed({ account: {} }),
        };
      }),
  });
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* openClaudeSession(account, policy, {
          ...config,
          interruptTimeoutMs: 50,
        });
        const r = yield* reader(session);
        yield* session.startTurn({ turnId: "one", message: "fixture" });
        const stop1 = yield* session
          .interruptTurn({ turnId: "one", reason: "stop" })
          .pipe(Effect.exit, Effect.forkScoped);
        const stop2 = yield* session
          .interruptTurn({ turnId: "one", reason: "stop" })
          .pipe(Effect.exit, Effect.forkScoped);
        yield* Effect.promise(() => closing.promise);
        yield* Effect.sleep("5 millis");
        const earlyFinish = r.events.some((e) => e.type === "turn.finished");
        if (earlyFinish)
          yield* session.startTurn({ turnId: "two", message: "fixture" });
        const prematureChild = children.length > 1 && !children[0]!.closed;
        yield* Effect.sleep("75 millis");
        const interruptedNewTurn = r.events.some(
          (e) =>
            e.type === "turn.finished" &&
            e.turnId === "two" &&
            e.outcome.status === "interrupted",
        );
        release.resolve();
        yield* Fiber.join(stop1);
        yield* Fiber.join(stop2);
        expect({ earlyFinish, prematureChild, interruptedNewTurn }).toEqual({
          earlyFinish: false,
          prematureChild: false,
          interruptedNewTurn: false,
        });
      }).pipe(Effect.ensuring(Effect.sync(() => release.resolve()))),
    ).pipe(Effect.provide(layer), Effect.timeout("2 seconds")),
  );
});

// Reason: every declared stamp shape must consume the merged ordered batch.
for (const shape of ["singular", "plural", "both", "none"] as const) {
  for (const queued of [0, undefined]) {
    for (const status of ["success", "error"] as const) {
      test(`R5 batch binding: ${shape}, queued=${queued}, ${status}`, () =>
        run((f) =>
          Effect.gen(function* () {
            const session = yield* openClaudeSession(account, policy, config);
            const r = yield* reader(session);
            yield* session.startTurn({ turnId: "one", message: "fixture" });
            for (let n = 0; n < 2; n++)
              yield* session.steerTurn({ turnId: "one", message: "fixture" });
            const fields = {
              ...(queued === undefined ? {} : { queued_turn_count: queued }),
              ...(shape === "singular" || shape === "both"
                ? { user_message_uuid: f.sends[2]!.uuid! }
                : {}),
              ...(shape === "plural" || shape === "both"
                ? { user_message_uuids: f.sends.slice(1).map((s) => s.uuid!) }
                : {}),
            };
            yield* Queue.offer(
              f.children[0]!.frames,
              status === "success"
                ? result(fields)
                : errorResult("error_max_turns", fields),
            );
            expect(yield* r.until("turn.finished")).toMatchObject({
              turnId: "one",
              outcome: {
                status: status === "success" ? "completed" : "failed",
              },
            });
            expect(
              r.events.filter((e) => e.type === "turn.finished"),
            ).toHaveLength(1);
          }),
        ));
    }
  }
}

// Reason: reset must also change the identity used after a Stop, not only final reopen.
test("R5 reset identity survives Stop and resume", () =>
  run((f) =>
    Effect.gen(function* () {
      const session = yield* openClaudeSession(account, policy, config);
      const r = yield* reader(session);
      yield* session.startTurn({ turnId: "one", message: "fixture" });
      const fresh = crypto.randomUUID();
      yield* Queue.offer(f.children[0]!.frames, {
        type: "conversation_reset",
        new_conversation_id: fresh,
        session_id: crypto.randomUUID(),
        uuid: crypto.randomUUID(),
      });
      yield* Queue.offer(f.children[0]!.frames, textDelta("fixture"));
      yield* r.until("text");
      yield* session.interruptTurn({ turnId: "one", reason: "stop" });
      yield* r.until("turn.finished");
      yield* session.startTurn({ turnId: "two", message: "fixture" });
      expect(f.children[1]!.options.resume).toBe(fresh);
      expect((yield* session.continuation).sessionId).toBe(fresh);
    }),
  ));

// Reason: later Stops join even after live is cleared; a new child waits for both.
test("R5 Stop callers wait for one disposal before a later turn", async () => {
  const closing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const children: Array<{
    frames: Queue.Queue<SDKMessage>;
    closed: boolean;
    closes: number;
  }> = [];
  const layer = Layer.succeed(ClaudeSdk, {
    prefixes: { usage: [], organization: [] },
    open: () =>
      Effect.gen(function* () {
        const child = {
          frames: yield* Queue.unbounded<SDKMessage>(),
          closed: false,
          closes: 0,
        };
        children.push(child);
        const close = Effect.promise(async () => {
          child.closes++;
          if (children.indexOf(child) === 0) {
            closing.resolve();
            await release.promise;
          }
          child.closed = true;
        }).pipe(Effect.andThen(Queue.shutdown(child.frames)));
        yield* Effect.addFinalizer(() => close);
        return {
          messages: Stream.fromQueue(child.frames),
          close,
          offer: () => Effect.void,
          interrupt: Effect.void,
          setModel: () => Effect.void,
          applyFlagSettings: () => Effect.void,
          initializationResult: Effect.succeed({ account: {} }),
        };
      }),
  });
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* openClaudeSession(account, policy, {
          ...config,
          interruptTimeoutMs: 100,
        });
        const r = yield* reader(session);
        yield* session.startTurn({ turnId: "one", message: "fixture" });
        let returned = 0;
        const stop = (reason: "stop" | "cutoff") =>
          session.interruptTurn({ turnId: "one", reason }).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                returned++;
              }),
            ),
            Effect.forkScoped,
          );
        const stop1 = yield* stop("stop");
        yield* Effect.promise(() => closing.promise);
        const stop2 = yield* stop("cutoff");
        yield* Effect.sleep("5 millis");
        expect(
          yield* session
            .startTurn({ turnId: "two", message: "fixture" })
            .pipe(Effect.flip),
        ).toMatchObject({ reason: "previous-turn-active" });
        expect(children).toHaveLength(1);
        expect(children[0]!.closes).toBe(1);
        expect(returned).toBe(0);
        expect(r.events.filter((e) => e.type === "turn.finished")).toHaveLength(
          0,
        );
        release.resolve();
        yield* Fiber.join(stop1);
        yield* Fiber.join(stop2);
        expect(returned).toBe(2);
        expect(yield* r.until("turn.finished")).toMatchObject({
          outcome: { status: "interrupted", reason: "stop" },
        });
        yield* session.startTurn({ turnId: "two", message: "fixture" });
        expect(children).toHaveLength(2);
        expect(children[0]!.closed).toBe(true);
        yield* Effect.sleep("125 millis");
        expect(
          r.events.filter(
            (e) => e.type === "turn.finished" && e.turnId === "two",
          ),
        ).toHaveLength(0);
        yield* Queue.offer(children[1]!.frames, result());
        expect(yield* r.until("turn.finished")).toMatchObject({
          turnId: "two",
          outcome: { status: "completed" },
        });
      }).pipe(Effect.ensuring(Effect.sync(() => release.resolve()))),
    ).pipe(Effect.provide(layer), Effect.timeout("2 seconds")),
  );
});
