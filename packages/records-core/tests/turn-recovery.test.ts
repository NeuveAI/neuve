// Why: retry budget, chosen time, queue/event atomicity and stale deliveries must survive a new store connection.
import { afterAll, expect, test } from "bun:test";
import { Effect, Option } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { JobQueue, Log, TurnRecovery } from "../src/index.ts";
import { freshLocation, removeTemporaryDirectories, runOn } from "./support.ts";

afterAll(removeTemporaryDirectories);
const checkpoint = {
  id: "checkpoint",
  generation: "generation",
  account: "claude",
  session: "session",
  continuation: "claude-code:account",
  transcriptDigest: "a".repeat(64),
  resultsDigest: "b".repeat(64),
  continuationMode: "repeat-request" as const,
};
const withQueue = <A, E, R>(
  program: (queue: JobQueue.JobQueue["Service"]) => Effect.Effect<A, E, R>,
) => Effect.provide(JobQueue.JobQueue.use(program), JobQueue.layer);
const begin = (turn = "turn", chat = "chat") =>
  TurnRecovery.begin({ turn, chat, checkpoint });
const schedule = (
  state: TurnRecovery.RecoveryState,
  nextAt = "2000-01-01T00:00:00.000Z",
) =>
  TurnRecovery.schedule({
    turn: state.value.turn,
    expected: state.event,
    nextAt,
    reason: "temporary-provider-failure",
    checkpoint,
  });

test("a schedule and its delayed job commit together, and another writer keeps the chosen time", async () => {
  const location = freshLocation();
  const scheduled = await runOn(
    location,
    Effect.gen(function* () {
      return yield* schedule(yield* begin(), "2030-01-01T00:00:00.000Z");
    }),
  );
  const result = await runOn(
    location,
    withQueue((queue) =>
      Effect.gen(function* () {
        const joined = yield* schedule(scheduled, "2040-01-01T00:00:00.000Z");
        const jobs = yield* queue.list({ states: ["delayed"], limit: 10 });
        return { joined, jobs };
      }),
    ),
  );
  expect(result.joined).toEqual(scheduled);
  expect(result.jobs).toHaveLength(1);
  expect(result.jobs[0]).toMatchObject({
    kind: "chat.turn-retry@1",
    runAt: scheduled.value.nextAt,
    eventId: scheduled.event,
    attempts: 0,
  });
});

test("a failed append rolls back both status and queue insertion", async () => {
  const location = freshLocation();
  await runOn(
    location,
    Effect.gen(function* () {
      const failed = yield* Effect.result(
        TurnRecovery.schedule({
          turn: "turn",
          first: { chat: "chat", checkpoint },
          nextAt: "not-an-instant",
          reason: "temporary-provider-failure",
          checkpoint,
        }),
      );
      expect(failed._tag).toBe("Failure");
      expect(yield* TurnRecovery.current("turn")).toBeUndefined();
      const sql = yield* SqlClient;
      const [row] = yield* sql<{
        n: number;
      }>`SELECT count(*) AS n FROM jobs WHERE kind='chat.turn-retry@1'`;
      expect(row?.n).toBe(0);
    }),
  );
});

test("five durable retries after initial attempt; reopening never resets budget, and duplicate job starts do nothing", async () => {
  const location = freshLocation();
  let state = await runOn(location, begin());
  for (let retry = 1; retry <= 5; retry++) {
    state = await runOn(location, schedule(state));
    expect(state.value.attempt).toBe(retry);
    state = await runOn(
      location,
      withQueue((queue) =>
        Effect.gen(function* () {
          const taken = yield* queue.take(["chat.turn-retry@1"]);
          expect(Option.isSome(taken)).toBe(true);
          if (Option.isNone(taken)) throw new Error("Missing queued retry");
          const started = yield* TurnRecovery.start(taken.value);
          expect(started?.value.state).toBe("started");
          expect(yield* TurnRecovery.start(taken.value)).toBeUndefined();
          yield* queue.complete(taken.value.seq, taken.value.attempts);
          return started!;
        }),
      ),
    );
  }
  const terminal = await runOn(location, schedule(state));
  expect(terminal.value).toMatchObject({
    state: "terminal",
    attempt: 5,
    reason: "retry-budget-exhausted",
  });
  const jobs = await runOn(
    location,
    withQueue((q) =>
      q.list({ states: ["completed", "waiting", "delayed"], limit: 20 }),
    ),
  );
  expect(jobs).toHaveLength(5);
});

test("pending retry prevents overtaking and cancelled queued delivery cannot restart it", async () => {
  const location = freshLocation();
  await runOn(
    location,
    withQueue((queue) =>
      Effect.gen(function* () {
        const waiting = yield* schedule(yield* begin());
        const overtaking = yield* Effect.result(begin("later"));
        expect(overtaking._tag).toBe("Failure");
        const cancelled = yield* TurnRecovery.cancel("turn");
        const taken = yield* queue.take(["chat.turn-retry@1"]);
        if (Option.isNone(taken)) throw new Error("Missing queued retry");
        expect(yield* TurnRecovery.start(taken.value)).toBeUndefined();
        const stale = yield* TurnRecovery.settle({
          turn: "turn",
          expected: waiting.event,
          state: "recovered",
        });
        expect(stale).toEqual(cancelled!);
        expect((yield* begin("later")).value.turn).toBe("later");
      }),
    ),
  );
});

test("process loss after dispatch is terminal, but a persisted scheduled retry survives reconciliation", async () => {
  const location = freshLocation();
  let state = await runOn(location, schedule(await runOn(location, begin())));
  expect(await runOn(location, TurnRecovery.reconcile("turn"))).toEqual(state);
  state = await runOn(
    location,
    withQueue((queue) =>
      Effect.gen(function* () {
        const job = yield* queue.take(["chat.turn-retry@1"]);
        if (Option.isNone(job)) throw new Error("Missing queued retry");
        return (yield* TurnRecovery.start(job.value))!;
      }),
    ),
  );
  const reconciled = await runOn(location, TurnRecovery.reconcile("turn"));
  expect(reconciled?.value).toMatchObject({
    state: "terminal",
    reason: "unsafe-continuation",
    attempt: 1,
  });
  const history = await runOn(
    location,
    Log.history({ kind: "turn.recovery-recorded@1", limit: 20 }),
  );
  expect(history.length).toBe(4);
});
