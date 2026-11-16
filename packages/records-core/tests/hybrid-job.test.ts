// Why: `commit.hybrid` (10.118) is a job kind builds from before 12.24 cannot decode, so migration
// 14 declares writer 13 the stores' minimum, and the migrate must keep what the store holds; a
// write that skips opening the store is refused until it is migrated. Its payload is the commit `commit.prepare` hands over; a malformed one would fail every
// attempt, so the queue refuses it at enqueue. Its policy keeps it behind commit preparation, which
// reviews read first, and takes the newest head first; a wrong order is silent (a review's
// preparation would wait behind model work).
import { afterAll, expect, test } from "bun:test";
import { Cause, Data, Effect, Option } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import {
  JOB_POLICIES,
  JobQueue,
  Log,
  Store,
  Worker,
  MIN_WRITER_VERSION,
} from "../src/index.ts";
import {
  commitEvent,
  freshLocation,
  removeTemporaryDirectories,
  runExisting,
  runOn,
} from "./support.ts";

afterAll(removeTemporaryDirectories);

const exec = (statement: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    return yield* sql.unsafe<Record<string, unknown>>(statement);
  });
const failureTag = <A, E extends { _tag: string }>(
  effect: Effect.Effect<A, E, SqlClient>,
) => Effect.map(Effect.flip(effect), (error) => error._tag);
const withQueue = <A, E, R>(
  program: (queue: JobQueue.JobQueue["Service"]) => Effect.Effect<A, E, R>,
) => Effect.provide(JobQueue.JobQueue.use(program), JobQueue.layer);

const oid = (digit: string) => digit.repeat(40);

test("a store from before the hybrid job refuses writes until migrate records the current writer", async () => {
  const location = freshLocation();
  await runOn(location, Log.append([commitEvent(oid("1"))]));
  // The store as the previous build left it: migrations up to 13, writer 12 as its minimum, and no
  // record of its own projector beside the shared one.
  await runExisting(
    location,
    exec(`DELETE FROM records_migrations WHERE migration_id >= 14`),
  );
  await runExisting(
    location,
    exec(`DELETE FROM records_meta WHERE key = 'projections_version'`),
  );
  await runExisting(location, exec(`DROP TABLE projection_review_origins`));
  await runExisting(
    location,
    exec(`UPDATE records_meta SET value = 9 WHERE key = 'projector_version'`),
  );
  await runExisting(
    location,
    exec(`UPDATE records_meta SET value = 12 WHERE key = 'min_writer_version'`),
  );

  expect(
    await runExisting(
      location,
      failureTag(Log.append([commitEvent(oid("2"))])),
    ),
  ).toBe("MigrationRequired");
  expect(await runExisting(location, Store.migrate)).toEqual({
    applied: [
      "14_hybrid_job",
      "15_review_origins",
      "16_project_review_origins",
      "17_capture_lookup_indexes",
      "18_computation_operation_index",
      "19_worker_lock_and_job_notices",
      "20_evictable_outputs",
    ],
    rebuilt: true,
  });
  const writer = await runExisting(
    location,
    exec(`SELECT value FROM records_meta WHERE key = 'min_writer_version'`),
  );
  expect(MIN_WRITER_VERSION).toBe(13);
  expect(writer[0]?.["value"]).toBe(13);
  const events = await runExisting(
    location,
    exec(`SELECT count(*) AS n FROM events`),
  );
  expect(events[0]?.["n"]).toBe(1);
  // The migrated store takes the new kind.
  const enqueued = await runExisting(
    location,
    withQueue((queue) =>
      queue.enqueue({
        kind: "commit.hybrid",
        dedupeKey: `commit.hybrid:${oid("1")}`,
        payload: { oid: oid("1"), tree: oid("a"), parents: [] },
      }),
    ),
  );
  expect(enqueued.job.kind).toBe("commit.hybrid");
});

test("a hybrid job's payload is checked at enqueue, and it waits behind commit preparation, newest first", async () => {
  const location = freshLocation();
  const result = await runOn(
    location,
    withQueue((queue) =>
      Effect.gen(function* () {
        const invalid = yield* Effect.flip(
          queue.enqueue({
            kind: "commit.hybrid",
            dedupeKey: "hybrid:bad",
            payload: { oid: "not-an-oid", tree: oid("a"), parents: [] },
          }),
        );
        const hybrid = (digit: string) =>
          queue.enqueue({
            kind: "commit.hybrid",
            dedupeKey: `hybrid:${digit}`,
            payload: { oid: oid(digit), tree: oid("a"), parents: [oid("0")] },
          });
        yield* hybrid("1");
        yield* queue.enqueue({
          kind: "commit.prepare",
          dedupeKey: "prepare:1",
          payload: {},
        });
        yield* hybrid("2");
        const order: Array<string> = [];
        for (;;) {
          const job = yield* queue.take(["commit.hybrid", "commit.prepare"]);
          if (Option.isNone(job)) break;
          order.push(job.value.dedupeKey);
        }
        return { invalid: invalid._tag, order };
      }),
    ),
  );
  expect(result.invalid).toBe("InvalidJobPayload");
  expect(result.order).toEqual(["prepare:1", "hybrid:2", "hybrid:1"]);
  expect(JOB_POLICIES["commit.hybrid"]).toMatchObject({
    slot: "background",
    priority: 3,
    order: "newest",
  });
});

// Why: a hybrid job that pauses on the machine's disk or swap limit must wait and run again,
// never fail for good (the overseer's call): a pause is not a failed attempt. A pause that counted
// would end the job after three, leaving that commit's hunks on keyword leads; one that ignored its
// delay would spin the worker against a full disk.
test("a paused attempt waits its delay and is not counted, however often it pauses", async () => {
  const location = freshLocation();
  const result = await runOn(
    location,
    withQueue((queue) =>
      Effect.gen(function* () {
        yield* queue.enqueue({
          kind: "commit.hybrid",
          dedupeKey: "hybrid:paused",
          payload: { oid: oid("1"), tree: oid("a"), parents: [oid("0")] },
        });
        const sql = yield* SqlClient;
        const outcomes: Array<{
          state: string;
          attempts: number;
          waitMs: number;
        }> = [];
        for (
          let pause = 0;
          pause < JOB_POLICIES["commit.hybrid"].maxAttempts + 2;
          pause++
        ) {
          yield* sql`UPDATE jobs SET run_at = '2000-01-01T00:00:00.000Z' WHERE dedupe_key = 'hybrid:paused'`;
          const job = Option.getOrThrow(yield* queue.take(["commit.hybrid"]));
          const before = Date.now();
          const outcome = yield* queue.fail(job.seq, job.attempts, {
            tag: "HybridPaused",
            message: "swap in use is above its limit",
            detail: { pauseMs: 60_000 },
            pauseMs: 60_000,
          });
          outcomes.push({
            state: outcome.state,
            attempts: outcome.job.attempts,
            waitMs:
              outcome.state === "delayed"
                ? Date.parse(outcome.runAt) - before
                : -1,
          });
        }
        // A real failure afterwards still counts.
        yield* sql`UPDATE jobs SET run_at = '2000-01-01T00:00:00.000Z' WHERE dedupe_key = 'hybrid:paused'`;
        const job = Option.getOrThrow(yield* queue.take(["commit.hybrid"]));
        const failed = yield* queue.fail(job.seq, job.attempts, {
          tag: "Boom",
          message: "no",
        });
        return {
          outcomes,
          failedAttempts: failed.job.attempts,
          lastError: failed.job.lastError,
        };
      }),
    ),
  );
  for (const outcome of result.outcomes) {
    expect(outcome.state).toBe("delayed");
    expect(outcome.attempts).toBe(0);
    expect(outcome.waitMs).toBeGreaterThanOrEqual(59_000);
    expect(outcome.waitMs).toBeLessThanOrEqual(61_000);
  }
  expect(result.failedAttempts).toBe(1);
});

class Paused extends Data.TaggedError("HybridPaused")<{
  readonly message: string;
  readonly pauseMs: number;
}> {}

test("an error with a pause is described as a pause, kept with its delay", () => {
  const failure = Worker.describeFailure(
    Cause.fail(new Paused({ message: "paused", pauseMs: 120_000 })),
    JOB_POLICIES["commit.hybrid"],
  );
  expect(failure).toMatchObject({
    tag: "HybridPaused",
    pauseMs: 120_000,
    detail: { pauseMs: 120_000 },
  });
  expect(
    Worker.describeFailure(
      Cause.fail(new Paused({ message: "paused", pauseMs: 0 })),
      JOB_POLICIES["commit.hybrid"],
    ).pauseMs,
  ).toBeUndefined();
});
