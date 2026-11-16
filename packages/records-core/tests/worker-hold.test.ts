// Why: 10.17 says a review job whose route's credential the worker lacks waits, says why, and is
// never failed for good; 10.85 makes that a per-job question, since each request freezes its own
// route. Only the worker loop and the queue together decide whether such a job is taken, counted,
// failed or left waiting, and whether it keeps the worker alive. This runs the real loop on a real
// store with an `admit` that refuses, and one that starts refusing after an attempt fails.
// Binding the worker's Unix socket needs a host that allows it; the Claude sandbox does not.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Data, Effect, Layer, Logger, Option } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import {
  Blobs,
  Computations,
  JobQueue,
  Log,
  Store,
  Worker,
  mintUlid,
} from "../src/index.ts";
import { serve } from "../src/worker-socket.ts";
import { actor, freshLocation, removeTemporaryDirectories } from "./support.ts";

afterAll(removeTemporaryDirectories);

const canBind = await Effect.runPromise(
  Effect.gen(function* () {
    const location = freshLocation();
    mkdirSync(location.directory, { recursive: true });
    const path = yield* Worker.socketPathFor(location);
    yield* Effect.scoped(serve(`${path}.probe`, () => ""));
    return true;
  }).pipe(Effect.catch(() => Effect.succeed(false))),
);

class CredentialGone extends Data.TaggedError("CredentialGone")<{
  readonly hold: true;
}> {}

const runWorker = (
  location: ReturnType<typeof freshLocation>,
  options: Pick<Worker.WorkerOptions, "handlers" | "admit">,
  keys: ReadonlyArray<string> = ["r1"],
) =>
  Effect.runPromise(
    Effect.andThen(
      Store.prepareForWrite,
      Effect.gen(function* () {
        const queue = yield* JobQueue.JobQueue;
        const jobs = [];
        for (const dedupeKey of keys)
          jobs.push(
            (yield* queue.enqueue({ kind: "review.run", dedupeKey })).job,
          );
        const exit = yield* Worker.run({
          location,
          ...options,
          idleTimeout: "300 millis",
          pollInterval: "50 millis",
        });
        const all = new Map<string, JobQueue.Job>();
        for (const job of jobs)
          all.set(
            job.dedupeKey,
            Option.getOrThrow(yield* queue.inspect(job.seq)),
          );
        return { exit, after: all.get(keys[0]!)!, all };
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          JobQueue.layer,
          Computations.layer.pipe(Layer.provideMerge(Blobs.layer(location))),
        ),
      ),
      Effect.provide(Store.layer(location, { create: true })),
      Effect.provide(
        Layer.merge(BunFileSystem.layer, Logger.layer([Logger.make(() => {})])),
      ),
    ),
  );

test.skipIf(!canBind)(
  "a job the worker cannot run is held: never run, never counted, and the worker still idles out",
  async () => {
    let runs = 0;
    let asked = 0;
    const { exit, after } = await runWorker(freshLocation(), {
      handlers: { "review.run": () => Effect.sync(() => (runs += 1)) },
      admit: () => Effect.sync(() => (asked += 1) < 0),
    });
    expect(exit.reason).toBe("idle");
    expect(runs).toBe(0);
    // Asked once, then passed over (no take-and-release spin) until the recheck.
    expect(asked).toBe(1);
    expect(after.state).toBe("waiting");
    expect(after.attempts).toBe(0);
  },
);

test.skipIf(!canBind)(
  "a handler that reports the credential gone (hold: true) has the job held, not failed",
  async () => {
    let asked = 0;
    const { after } = await runWorker(freshLocation(), {
      handlers: {
        "review.run": () => Effect.fail(new CredentialGone({ hold: true })),
      },
      admit: () => Effect.sync(() => (asked += 1) > 0),
    });
    expect(after.state).toBe("waiting");
    expect(after.attempts).toBe(0);
    expect(after.lastError).toBeNull();
    // The handler's own check decided; admission was asked only before the run.
    expect(asked).toBe(1);
  },
);

test.skipIf(!canBind)("a held job leaves the other jobs runnable", async () => {
  const ran: Array<string> = [];
  const { all } = await runWorker(
    freshLocation(),
    {
      handlers: {
        "review.run": (job) => Effect.sync(() => ran.push(job.dedupeKey)),
      },
      admit: (job) => Effect.succeed(job.dedupeKey !== "held"),
    },
    ["held", "r2", "r3"],
  );
  expect(ran.sort()).toEqual(["r2", "r3"]);
  expect(all.get("held")?.state).toBe("waiting");
  expect(all.get("r2")?.state).toBe("completed");
  expect(all.get("r3")?.state).toBe("completed");
});

// Why: a review reads its whole cycle (12.24). A worker whose build does not know every kind in that
// cycle would review it with events missing, so it must leave the job waiting for a newer build,
// say so once, and still run reviews of cycles it fully knows.
test.skipIf(!canBind)(
  "a review whose cycle holds a newer build's kinds is left waiting, with one line",
  async () => {
    const location = freshLocation();
    const ran: Array<string> = [];
    const lines: Array<string> = [];
    const opened = (cycleId: string) => ({
      id: mintUlid(),
      kind: "cycle.opened@1",
      idempotencyKey: `cycle:${cycleId}`,
      actor,
      occurredAt: "2026-11-01T09:00:00.000Z",
      attribution: {
        cycleId,
        range: {
          baseRef: "refs/heads/main",
          baseOid: "b".repeat(40),
          headOid: "a".repeat(40),
        },
      },
      payload: {},
    });
    const newer = opened(mintUlid());
    const known = opened(mintUlid());
    const all = await Effect.runPromise(
      Effect.andThen(
        Store.prepareForWrite,
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          yield* Log.append([newer, known]);
          // A newer build's event in the first cycle.
          const futureId = mintUlid();
          const [row] = yield* sql.unsafe<{ seq: number }>(
            `INSERT INTO events (id, kind, idempotency_key, fingerprint, actor_id, occurred_at, recorded_at, envelope)
              VALUES (?, 'review.future-recorded@1', ?, ?, ?, '2026-11-01T09:00:01.000Z', '2026-11-01T09:00:01.000Z', ?)
              RETURNING seq`,
            [
              futureId,
              `future:${futureId}`,
              "f".repeat(64),
              actor,
              JSON.stringify({
                id: futureId,
                kind: "review.future-recorded@1",
              }),
            ],
          );
          yield* sql.unsafe(
            `INSERT INTO event_cycles (cycle_id, event_seq) VALUES (?, ?)`,
            [newer.attribution.cycleId, row?.seq],
          );
          const queue = yield* JobQueue.JobQueue;
          const jobs = [];
          for (const [dedupeKey, eventId] of [
            ["newer", newer.id],
            ["known", known.id],
          ] as const) {
            const { job } = yield* queue.enqueue({
              kind: "review.run",
              dedupeKey,
            });
            yield* sql.unsafe(
              `UPDATE jobs SET event_id = ? WHERE job_seq = ?`,
              [eventId, job.seq],
            );
            jobs.push(job);
          }
          yield* Worker.run({
            location,
            handlers: {
              "review.run": (job) => Effect.sync(() => ran.push(job.dedupeKey)),
            },
            idleTimeout: "300 millis",
            pollInterval: "50 millis",
          });
          const after = new Map<string, JobQueue.Job>();
          for (const job of jobs)
            after.set(
              job.dedupeKey,
              Option.getOrThrow(yield* queue.inspect(job.seq)),
            );
          return after;
        }),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            JobQueue.layer,
            Computations.layer.pipe(Layer.provideMerge(Blobs.layer(location))),
          ),
        ),
        Effect.provide(Store.layer(location, { create: true })),
        Effect.provide(
          Layer.merge(
            BunFileSystem.layer,
            Logger.layer([
              Logger.make((options) => lines.push(String(options.message))),
            ]),
          ),
        ),
      ),
    );
    expect(ran).toEqual(["known"]);
    expect(all.get("newer")?.state).toBe("waiting");
    expect(all.get("newer")?.attempts).toBe(0);
    expect(all.get("known")?.state).toBe("completed");
    expect(
      lines.filter((line) => line.includes("left for a newer build")),
    ).toHaveLength(1);
  },
);

// Why: the whole-cycle check guards a review against running without every event of its cycle, so
// when the check itself cannot be made, the review must wait, not run (fail closed), and say so once.
test.skipIf(!canBind)(
  "a review whose cycle cannot be checked is held, with one line",
  async () => {
    const location = freshLocation();
    const ran: Array<string> = [];
    const lines: Array<string> = [];
    const cycleId = mintUlid();
    const opened = {
      id: mintUlid(),
      kind: "cycle.opened@1",
      idempotencyKey: `cycle:${cycleId}`,
      actor,
      occurredAt: "2026-11-01T09:00:00.000Z",
      attribution: {
        cycleId,
        range: {
          baseRef: "refs/heads/main",
          baseOid: "b".repeat(40),
          headOid: "a".repeat(40),
        },
      },
      payload: {},
    };
    const after = await Effect.runPromise(
      Effect.andThen(
        Store.prepareForWrite,
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          yield* Log.append([opened]);
          const queue = yield* JobQueue.JobQueue;
          const { job } = yield* queue.enqueue({
            kind: "review.run@2",
            dedupeKey: "unreadable",
          });
          yield* sql.unsafe(`UPDATE jobs SET event_id = ? WHERE job_seq = ?`, [
            opened.id,
            job.seq,
          ]);
          // The cycle index is gone, so the check's query fails.
          yield* sql.unsafe(`DROP TABLE event_cycles`);
          yield* Worker.run({
            location,
            handlers: {
              "review.run@2": (job) =>
                Effect.sync(() => ran.push(job.dedupeKey)),
            },
            idleTimeout: "300 millis",
            pollInterval: "50 millis",
          });
          return Option.getOrThrow(yield* queue.inspect(job.seq));
        }),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            JobQueue.layer,
            Computations.layer.pipe(Layer.provideMerge(Blobs.layer(location))),
          ),
        ),
        Effect.provide(Store.layer(location, { create: true })),
        Effect.provide(
          Layer.merge(
            BunFileSystem.layer,
            Logger.layer([
              Logger.make((options) => lines.push(String(options.message))),
            ]),
          ),
        ),
      ),
    );
    expect(ran).toEqual([]);
    expect(after.state).toBe("waiting");
    expect(after.attempts).toBe(0);
    expect(
      lines.filter((line) => line.includes("its cycle could not be checked")),
    ).toHaveLength(1);
  },
);
