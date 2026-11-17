// Why: the job queue's state lives in SQLite and outlives every process that touches it, so its
// transitions are a contract between the CLI, hooks and successive workers (8.12). These tests pin
// the transitions a later worker relies on and cannot observe going wrong: de-duplication, backoff
// written to run_at, the final failed state with its cause, stall recovery with its limit, and the
// migration that turns S1 job rows into dial-2 rows.
import { afterAll, expect, test } from "bun:test";
import { Effect, Option } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import * as SqliteMigrator from "@effect/sql-sqlite-bun/SqliteMigrator";
import { CommitRecorded, type JobKind } from "@neuve/records-schema";
import { canonicalJson, JobQueue, Store } from "../src/index.ts";
import { fingerprintOf } from "../src/codec.ts";
import { MIGRATIONS_TABLE, migrations } from "../src/schema.ts";
import {
  commitEvent,
  freshLocation,
  removeTemporaryDirectories,
  runFs,
  runOn,
} from "./support.ts";

afterAll(removeTemporaryDirectories);

const withQueue = <A, E, R>(
  program: (queue: JobQueue.JobQueue["Service"]) => Effect.Effect<A, E, R>,
) => Effect.provide(JobQueue.JobQueue.use(program), JobQueue.layer);

const makeDue = (seq: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql`UPDATE jobs SET run_at = '2000-01-01T00:00:00.000Z' WHERE job_seq = ${seq}`;
  });

const delayMs = (outcome: JobQueue.FailOutcome, before: number) =>
  outcome.state === "delayed" ? Date.parse(outcome.runAt) - before : -1;

test("a job is de-duplicated, retried with exponential jittered backoff, then failed with its cause", async () => {
  const location = freshLocation();
  const result = await runOn(
    location,
    withQueue((queue) =>
      Effect.gen(function* () {
        const first = yield* queue.enqueue({
          kind: "worker.probe",
          dedupeKey: "probe:a",
          payload: { failAttempts: 9 },
        });
        const again = yield* queue.enqueue({
          kind: "worker.probe",
          dedupeKey: "probe:a",
          payload: { sleepMs: 5 },
        });
        const invalid = yield* Effect.flip(
          queue.enqueue({
            kind: "worker.probe",
            dedupeKey: "probe:b",
            payload: { sleepMs: "x" },
          }),
        );
        const failure = { tag: "ProbeFailed", message: "no" };
        const delays: Array<number> = [];
        const takes: Array<number> = [];
        let outcome: JobQueue.FailOutcome | undefined;
        let staleOutcome: unknown;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          const job = Option.getOrThrow(yield* queue.take(["worker.probe"]));
          takes.push(job.attempts);
          // An earlier attempt's outcome must never land on the current one (it would if a second
          // worker ever ran the job): the queue refuses it.
          if (attempt === 2)
            staleOutcome = (yield* Effect.flip(
              queue.complete(first.job.seq, 1),
            ))._tag;
          const before = Date.now();
          outcome = yield* queue.fail(first.job.seq, job.attempts, failure);
          if (outcome.state === "delayed") {
            delays.push(delayMs(outcome, before));
            // Not due yet: nothing to take until run_at passes.
            expect(Option.isNone(yield* queue.take(["worker.probe"]))).toBe(
              true,
            );
            yield* makeDue(first.job.seq);
          }
        }
        const dropFinal = yield* Effect.flip(queue.drop(first.job.seq));
        return {
          first,
          again,
          invalid,
          delays,
          takes,
          outcome,
          dropFinal,
          staleOutcome,
        };
      }),
    ),
  );

  expect(result.first.status).toBe("enqueued");
  expect(result.again).toMatchObject({
    status: "existing",
    job: {
      seq: result.first.job.seq,
      payload: { sleepMs: 0, failAttempts: 9 },
    },
  });
  expect(result.invalid._tag).toBe("InvalidJobPayload");
  expect(result.takes).toEqual([1, 2, 3]);
  expect(result.staleOutcome).toBe("JobStateConflict");
  // worker.probe: 1 s doubling, each jittered to 80-120 %; a little slack for the clock between calls.
  expect(result.delays).toHaveLength(2);
  expect(result.delays[0]).toBeGreaterThanOrEqual(790);
  expect(result.delays[0]).toBeLessThanOrEqual(1_210);
  expect(result.delays[1]).toBeGreaterThanOrEqual(1_590);
  expect(result.delays[1]).toBeLessThanOrEqual(2_410);
  expect(result.outcome).toMatchObject({
    state: "failed",
    job: {
      state: "failed",
      attempts: 3,
      runAt: null,
      lastError: { tag: "ProbeFailed", message: "no", attempt: 3 },
    },
  });
  expect(result.dropFinal._tag).toBe("JobStateConflict");
});

test("jobs left active by a dead worker go back to waiting, then fail past the stall limit or at their last attempt; a stop does not count", async () => {
  const location = freshLocation();
  const result = await runOn(
    location,
    withQueue((queue) =>
      Effect.gen(function* () {
        const { job } = yield* queue.enqueue({
          kind: "worker.probe",
          dedupeKey: "probe:stalls",
        });
        const recoveries: Array<ReadonlyArray<JobQueue.RecoveredJob>> = [];
        for (let round = 0; round < 3; round += 1) {
          yield* queue.take(["worker.probe"]);
          recoveries.push(yield* queue.recoverStalled);
        }
        const other = yield* queue.enqueue({
          kind: "worker.probe",
          dedupeKey: "probe:released",
        });
        const taken = Option.getOrThrow(yield* queue.take(["worker.probe"]));
        const released = yield* queue.release(other.job.seq, taken.attempts);
        yield* queue.drop(other.job.seq);
        // A stalled attempt counts toward maxAttempts: two failures, then a stall at attempt 3.
        const last = yield* queue.enqueue({
          kind: "worker.probe",
          dedupeKey: "probe:last-attempt",
        });
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          yield* queue.take(["worker.probe"]);
          yield* queue.fail(last.job.seq, attempt, { tag: "T", message: "" });
          yield* makeDue(last.job.seq);
        }
        yield* queue.take(["worker.probe"]);
        const lastRecovery = yield* queue.recoverStalled;
        const final = Option.getOrThrow(yield* queue.inspect(job.seq));
        return { recoveries, released, final, lastRecovery };
      }),
    ),
  );

  expect(
    result.recoveries.map((round) =>
      round.map((r) => [r.state, r.job.stalls, r.job.attempts]),
    ),
  ).toEqual([[["waiting", 1, 1]], [["waiting", 2, 2]], [["failed", 3, 3]]]);
  expect(result.final.lastError?.tag).toBe("StallLimit");
  expect(
    result.lastRecovery.map((r) => [
      r.state,
      r.job.attempts,
      r.job.lastError?.tag,
    ]),
  ).toEqual([["failed", 3, "Stalled"]]);
  expect(result.released).toMatchObject({
    state: "waiting",
    attempts: 0,
    stalls: 0,
  });
});

// Why: which job a slot takes next is read from JOB_POLICIES, not stored (10.31). A wrong order is
// silent: a review would wait behind a burst, or a burst would drain oldest commit first. This pins
// priority across kinds, newest first for commit preparation, oldest first otherwise, and that a
// slot never takes another slot's kind.
test("each slot takes its most urgent job: priority first, then the kind's order", async () => {
  const location = freshLocation();
  const taken = await runOn(
    location,
    withQueue((queue) =>
      Effect.gen(function* () {
        const enqueue = (kind: JobKind, dedupeKey: string) =>
          queue.enqueue({ kind, dedupeKey, payload: {} });
        yield* enqueue("worker.probe", "probe:1");
        yield* enqueue("retention.prune", "prune:1");
        yield* enqueue("commit.prepare", "prepare:1");
        yield* enqueue("commit.prepare", "prepare:2");
        yield* enqueue("review.run", "review:1");
        yield* enqueue("worker.probe", "probe:2");
        yield* enqueue("commit.prepare", "prepare:3");
        yield* enqueue("review.run", "review:2");
        const background = [
          "commit.prepare",
          "retention.prune",
          "worker.probe",
        ] as const;
        const order: Array<string> = [];
        for (;;) {
          const job = yield* queue.take(background);
          if (Option.isNone(job)) break;
          order.push(job.value.dedupeKey);
        }
        const interactive: Array<string> = [];
        for (;;) {
          const job = yield* queue.take(["review.run"]);
          if (Option.isNone(job)) break;
          interactive.push(job.value.dedupeKey);
        }
        return { order, interactive };
      }),
    ),
  );
  expect(taken.order).toEqual([
    "prepare:3",
    "prepare:2",
    "prepare:1",
    "probe:1",
    "probe:2",
    "prune:1",
  ]);
  expect(taken.interactive).toEqual(["review:1", "review:2"]);
});

test("migration 3 turns S1 job rows into dial-2 rows", async () => {
  const location = freshLocation();
  const events = ["1", "2", "3", "4"].map((digit) =>
    CommitRecorded.parse(commitEvent(digit.repeat(40))),
  );
  // A store as S1 left it: only migration 1, with one queued and one succeeded job.
  await runFs(
    Effect.gen(function* () {
      yield* SqliteMigrator.run({
        loader: SqliteMigrator.fromRecord({
          "1_initial": migrations["1_initial"],
        }),
        table: MIGRATIONS_TABLE,
      });
      const sql = yield* SqlClient;
      for (const [index, event] of events.entries()) {
        yield* sql`INSERT INTO events ${sql.insert({
          id: event.id,
          kind: event.kind,
          idempotency_key: event.idempotencyKey,
          fingerprint: fingerprintOf(event),
          actor_id: event.actor,
          occurred_at: event.occurredAt,
          recorded_at: `2026-10-17T09:00:0${index + 1}.000Z`,
          envelope: canonicalJson(event),
        })}`;
        yield* sql`INSERT INTO jobs ${sql.insert({
          kind: "commit.prepare",
          dedupe_key: `commit.prepare:${event.payload.oid}`,
          event_id: event.id,
          state: ["queued", "succeeded", "queued", "failed"][index],
          not_before: index === 2 ? "2026-10-17T10:00:00.000Z" : null,
          attempts: index === 3 ? 2 : 0,
        })}`;
      }
    }).pipe(Effect.provide(Store.layer(location, { create: true }))),
  );

  const jobs = await runFs(
    Effect.gen(function* () {
      yield* Store.migrate;
      const sql = yield* SqlClient;
      return yield* sql`SELECT job_seq, state, run_at, attempts, stalls, enqueued_at, event_id,
        last_error FROM jobs ORDER BY job_seq`;
    }).pipe(Effect.provide(Store.layer(location, { create: false }))),
  );
  const row = (
    index: number,
    state: string,
    fields: { runAt?: string; attempts?: number; lastError?: string } = {},
  ) => ({
    jobSeq: index + 1,
    state,
    runAt: fields.runAt ?? null,
    attempts: fields.attempts ?? 0,
    stalls: 0,
    enqueuedAt: `2026-10-17T09:00:0${index + 1}.000Z`,
    eventId: events[index]?.id,
    lastError: fields.lastError ?? null,
  });
  expect(jobs).toEqual([
    row(0, "waiting"),
    row(1, "completed"),
    // A queued job's not_before survives as a delayed job's run_at.
    row(2, "delayed", { runAt: "2026-10-17T10:00:00.000Z" }),
    // The failed state always carries a cause the queue can decode.
    row(3, "failed", {
      attempts: 2,
      lastError: JSON.stringify({
        tag: "Migrated",
        message: "failed before the job queue kept causes",
        attempt: 2,
        at: "2026-10-17T09:00:04.000Z",
      }),
    }),
  ]);
});

// Why: a WAL event may arrive before commit. The notification must wait for the in-flight writer,
// even when the first committed snapshot has no notices; otherwise there is no second wake-up.
test("a notice drain waits for the writer that raised its WAL event", async () => {
  const location = freshLocation();
  await runOn(
    location,
    withQueue((queue) =>
      queue.enqueue({
        kind: "worker.probe",
        dedupeKey: "commit-fence",
        payload: {},
      }),
    ),
  );
  await runOn(
    location,
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const written = Promise.withResolvers<void>();
      const child = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          "--eval",
          `
      const { Database } = require("bun:sqlite");
      const db = new Database(process.argv.at(-1));
      db.exec("PRAGMA busy_timeout=5000; BEGIN IMMEDIATE");
      db.exec("UPDATE jobs SET state='failed', run_at=NULL");
      process.send("uncommitted");
      setTimeout(() => { db.exec("COMMIT"); db.close(); process.exit(0); }, 250);
    `,
          location.database,
        ],
        {
          stdout: "ignore",
          stderr: "pipe",
          ipc(message: unknown) {
            if (message === "uncommitted") written.resolve();
          },
        },
      );
      const detail = new Response(child.stderr).text();
      void child.exited.then(async (code) =>
        written.reject(new Error(`writer exited ${code}: ${await detail}`)),
      );
      try {
        yield* Effect.promise(() => written.promise);
        yield* JobQueue.deliverJobNotices("/unused-test-socket");
        const pending = yield* sql`SELECT job_seq FROM job_notices`;
        expect(pending).toEqual([]);
        expect(yield* sql`SELECT state FROM jobs`).toEqual([
          { state: "failed" },
        ]);
        expect(yield* Effect.promise(() => child.exited)).toBe(0);
      } finally {
        child.kill();
        yield* Effect.promise(() => child.exited);
      }
    }),
  );
});
