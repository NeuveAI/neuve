import { expect, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  Account,
  TurnLimit,
  type RuntimeEvent,
  type SessionPolicy,
} from "@neuve/runtime";
import { Effect, Exit, Fiber, Layer, Queue, Scope, Stream } from "effect";
import { openClaudeSession } from "../src/session.ts";
import { ClaudeExecutable, ClaudeProcess, ClaudeSdk } from "../src/services.ts";
import { makeRuntime } from "../src/runtime.ts";
import { result } from "./frames.ts";

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

// Reason: cancelling Stop must return before disposal can finish.
test("R4-F3 cancelling Stop still settles the started turn", async () => {
  const closing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const frames = await Effect.runPromise(Queue.unbounded<SDKMessage>());
  let closeCalls = 0;
  const watchdog = setTimeout(() => release.resolve(), 2100);
  const layer = Layer.succeed(ClaudeSdk, {
    prefixes: { usage: [], organization: [] },
    open: () =>
      Effect.gen(function* () {
        const close = Effect.promise(async () => {
          closeCalls++;
          closing.resolve();
          await release.promise;
        }).pipe(Effect.andThen(Queue.shutdown(frames)));
        yield* Effect.addFinalizer(() => close);
        return {
          messages: Stream.fromQueue(frames),
          close,
          offer: () => Effect.void,
          interrupt: Effect.void,
          setModel: () => Effect.void,
          applyFlagSettings: () => Effect.void,
          initializationResult: Effect.succeed({ account: {} }),
        };
      }),
  });
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* openClaudeSession(account, policy, config);
          const r = yield* reader(session);
          yield* session.startTurn({ turnId: "one", message: "fixture" });
          const fiber = yield* session
            .interruptTurn({ turnId: "one", reason: "stop" })
            .pipe(Effect.forkScoped);
          yield* Effect.promise(() => closing.promise);
          yield* Fiber.interrupt(fiber);
          release.resolve();
          const finished = yield* r
            .until("turn.finished")
            .pipe(Effect.timeoutOption("50 millis"));
          expect(finished._tag).toBe("Some");
          expect(
            r.events.filter((e) => e.type === "turn.finished"),
          ).toHaveLength(1);
        }),
      ).pipe(Effect.provide(layer), Effect.timeout("2 seconds")),
    );
  } finally {
    clearTimeout(watchdog);
    release.resolve();
  }
});

function stalledDisposal() {
  const closing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let opens = 0;
  let finalized = 0;
  let closeWaitsCancelled = 0;
  let frames: Queue.Queue<SDKMessage>;
  const layer = Layer.succeed(ClaudeSdk, {
    prefixes: { usage: [], organization: [] },
    open: () =>
      Effect.gen(function* () {
        opens++;
        frames = yield* Queue.unbounded<SDKMessage>();
        const close = Effect.promise(() => {
          closing.resolve();
          return release.promise;
        }).pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              closeWaitsCancelled++;
            }),
          ),
          Effect.andThen(Queue.shutdown(frames)),
        );
        yield* Effect.addFinalizer(() =>
          close.pipe(
            Effect.andThen(
              Effect.sync(() => {
                finalized++;
              }),
            ),
          ),
        );
        return {
          messages: Stream.fromQueue(frames),
          close,
          offer: () => Effect.void,
          interrupt: Effect.void,
          setModel: () => Effect.void,
          applyFlagSettings: () => Effect.void,
          initializationResult: Effect.succeed({ account: {} }),
        };
      }),
  });
  const emit = (frame: SDKMessage) =>
    Effect.suspend(() => Queue.offer(frames, frame));
  async function run(
    body: Effect.Effect<void, unknown, Scope.Scope | ClaudeSdk>,
  ) {
    // Failure cleanup also releases pre-fix uninterruptible disposal waits.
    const watchdog = setTimeout(() => release.resolve(), 2100);
    try {
      await Effect.runPromise(
        Effect.scoped(
          body.pipe(Effect.ensuring(Effect.sync(() => release.resolve()))),
        ).pipe(Effect.provide(layer), Effect.timeout("2 seconds")),
      );
    } finally {
      clearTimeout(watchdog);
      release.resolve();
    }
    expect(finalized).toBe(opens);
  }
  return {
    closing,
    release,
    emit,
    run,
    get opens() {
      return opens;
    },
    get finalized() {
      return finalized;
    },
    get closeWaitsCancelled() {
      return closeWaitsCancelled;
    },
  };
}

test("Stop bounds stalled disposal, settles once, ends events and rejects later turns", () => {
  // Reason: a child that never exits must not keep Stop or the event consumer waiting.
  const f = stalledDisposal();
  return f.run(
    Effect.gen(function* () {
      const runtime = yield* makeRuntime({
        ...config,
        interruptTimeoutMs: 50,
      }).pipe(
        Effect.provideService(ClaudeExecutable, {
          resolve: () => Effect.succeed(config.executable),
        }),
        Effect.provideService(ClaudeProcess, {
          run: () => Effect.die("Stop must not run an auth process"),
        }),
      );
      const session = yield* runtime.openSession(account, policy);
      const events: RuntimeEvent[] = [];
      const consumer = yield* Stream.runForEach(session.events, (e) =>
        Effect.sync(() => {
          events.push(e);
        }),
      ).pipe(Effect.forkScoped);
      yield* session.startTurn({ turnId: "one", message: "fixture" });
      const started = performance.now();
      yield* session.interruptTurn({ turnId: "one", reason: "cutoff" });
      const elapsed = performance.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(40);
      expect(elapsed).toBeLessThan(250);
      yield* Fiber.join(consumer).pipe(Effect.timeout("50 millis"));
      expect(events.map((e) => e.type)).toEqual([
        "turn.started",
        "turn.finished",
      ]);
      expect(events[1]).toMatchObject({
        outcome: { status: "interrupted", reason: "cutoff" },
      });
      expect(
        yield* session
          .startTurn({ turnId: "two", message: "fixture" })
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "TurnFailed", reason: "session-stopped" });
      expect(
        yield* session
          .steerTurn({ turnId: "one", message: "fixture" })
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "TurnFailed", reason: "session-stopped" });
      expect(f.finalized).toBe(0);
      f.release.resolve();
    }),
  );
});

test("Scope closure interrupts session-owned Stop cleanup and finishes the turn once", () => {
  // Reason: closing the session must own cleanup after Stop's caller has been cancelled.
  const f = stalledDisposal();
  return f.run(
    Effect.gen(function* () {
      const scope = yield* Scope.fork(yield* Effect.scope);
      const session = yield* openClaudeSession(account, policy, config).pipe(
        Effect.provideService(Scope.Scope, scope),
      );
      const events: RuntimeEvent[] = [];
      const consumer = yield* Stream.runForEach(session.events, (e) =>
        Effect.sync(() => {
          events.push(e);
        }),
      ).pipe(Effect.forkScoped);
      yield* session.startTurn({ turnId: "one", message: "fixture" });
      const stop = yield* session
        .interruptTurn({ turnId: "one", reason: "stop" })
        .pipe(Effect.forkScoped);
      yield* Effect.promise(() => f.closing.promise);
      yield* Fiber.interrupt(stop);
      const closure = yield* Scope.close(scope, Exit.void).pipe(
        Effect.forkScoped,
      );
      yield* Fiber.join(consumer).pipe(Effect.timeout("50 millis"));
      expect(events.map((e) => e.type)).toEqual([
        "turn.started",
        "turn.finished",
      ]);
      expect(events[1]).toMatchObject({
        outcome: { status: "interrupted", reason: "shutdown" },
      });
      // Let the scope cancel the cleanup's wait before releasing the child finalizer.
      yield* Effect.yieldNow;
      expect(f.closeWaitsCancelled).toBe(1);
      f.release.resolve();
      yield* Fiber.join(closure);
      expect(events.filter((e) => e.type === "turn.finished")).toHaveLength(1);
    }),
  );
});

test("Final-turn reopen uses the disposal bound and never starts another child after timeout", () => {
  // Reason: switching output formats must not bypass the Stop disposal deadline.
  const f = stalledDisposal();
  return f.run(
    Effect.gen(function* () {
      const session = yield* openClaudeSession(
        account,
        { ...policy, outputSchema: { type: "object" } },
        { ...config, interruptTimeoutMs: 50 },
      );
      const r = yield* reader(session);
      yield* session.startTurn({ turnId: "one", message: "fixture" });
      yield* f.emit(result());
      yield* r.until("turn.finished");
      const started = performance.now();
      expect(
        yield* session
          .startTurn({ turnId: "final", message: "fixture", final: true })
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "TurnFailed", reason: "session-stopped" });
      expect(performance.now() - started).toBeLessThan(250);
      expect(f.opens).toBe(1);
      yield* r.until("turn.finished");
      expect(
        r.events.filter(
          (e) => e.type === "turn.finished" && e.turnId === "final",
        ),
      ).toHaveLength(1);
      f.release.resolve();
    }),
  );
});

test("Protocol-fault disposal uses the same deadline", () => {
  // Reason: a malformed reply must not leave the protocol-fault close waiting forever.
  const f = stalledDisposal();
  return f.run(
    Effect.gen(function* () {
      const session = yield* openClaudeSession(account, policy, {
        ...config,
        interruptTimeoutMs: 50,
      });
      const r = yield* reader(session);
      yield* session.startTurn({ turnId: "one", message: "fixture" });
      yield* f.emit({ ...result(), user_message_uuids: [] });
      const finished = yield* r.until("turn.finished");
      expect(finished).toMatchObject({
        outcome: {
          status: "failed",
          disposition: "broken",
          failure: { reason: "protocol-error" },
        },
      });
      yield* Effect.sleep("100 millis");
      expect(f.closeWaitsCancelled).toBeGreaterThanOrEqual(1);
      expect(r.events.filter((e) => e.type === "turn.finished")).toHaveLength(
        1,
      );
      f.release.resolve();
    }),
  );
});
