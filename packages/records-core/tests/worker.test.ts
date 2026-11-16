// Why: "exactly one worker per repository" (8.2) only holds across real processes, which race for
// SQLite's write lock and the OS socket; nothing in one process can show it. The first test starts
// two worker processes on one store at once and checks that exactly one claims, that the claimant
// ingests the spool and runs the queued job, and that its idle exit leaves no socket and no claim
// behind. The second pins when a socket file that refuses connections may be taken over.
// Binding a Unix socket needs a host that allows it; the Claude sandbox does not, so there the test
// is skipped and says so.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Deferred, Effect, Fiber, Layer, Logger } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { RecordEvent } from "@neuve/records-schema";
import {
  Blobs,
  Computations,
  JobQueue,
  Spool,
  Store,
  Worker,
} from "../src/index.ts";
import { serve } from "../src/worker-socket.ts";
import {
  commitEvent,
  freshLocation,
  removeTemporaryDirectories,
  runFs,
  runOn,
} from "./support.ts";

afterAll(removeTemporaryDirectories);

const fixture = join(import.meta.dir, "fixtures", "run-worker.ts");

const canBind = await Effect.runPromise(
  Effect.gen(function* () {
    const location = freshLocation();
    mkdirSync(location.directory, { recursive: true });
    const path = yield* Worker.socketPathFor(location);
    yield* Effect.scoped(serve(`${path}.probe`, () => ""));
    return true;
  }).pipe(Effect.catch(() => Effect.succeed(false))),
);
if (!canBind)
  console.warn(
    "worker.test.ts: this host forbids binding Unix sockets (sandbox); the singleton test is skipped",
  );

test.skipIf(!canBind)(
  "two workers started at once: one claims, ingests, runs the job and exits idle; the other exits",
  async () => {
    const location = freshLocation();
    await runOn(
      location,
      Effect.provide(
        JobQueue.JobQueue.use((queue) =>
          queue.enqueue({
            kind: "worker.probe",
            dedupeKey: "probe:singleton",
            payload: { sleepMs: 50 },
          }),
        ),
        JobQueue.layer,
      ),
    );
    await runFs(
      Spool.writeSpoolLine(
        location.spool,
        RecordEvent.parse(commitEvent("7".repeat(40))),
      ),
    );

    const start = () =>
      Bun.spawn(["bun", fixture, dirname(location.directory), "300"], {
        stdout: "pipe",
        stderr: "pipe",
      });
    const outputs = await Promise.all(
      [start(), start()].map(async (child) => {
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect(code, stderr).toBe(0);
        return stdout;
      }),
    );

    const winners = outputs.filter((out) => out.includes(" claimed "));
    const losers = outputs.filter((out) => !out.includes(" claimed "));
    expect(winners).toHaveLength(1);
    expect(losers[0]).toContain("exit another-worker");
    expect(winners[0]).toContain("spool ingested: 1 appended");
    expect(winners[0]).toContain("job 1 worker.probe completed");
    expect(winners[0]).toContain("exit idle");

    const after = await runOn(
      location,
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const [counts] = yield* sql<{
          events: number;
          claims: number;
        }>`SELECT (SELECT count(*) FROM events) AS events,
          (SELECT count(*) FROM worker_state) AS claims`;
        const jobs = yield* sql`SELECT kind, state FROM jobs ORDER BY job_seq`;
        return { counts, jobs };
      }),
    );
    expect(after.counts).toEqual({ events: 1, claims: 0 });
    // The commit's own job waits: this build has no handler for commit.prepare.
    expect(after.jobs).toEqual([
      { kind: "worker.probe", state: "completed" },
      { kind: "commit.prepare", state: "waiting" },
    ]);
    expect(
      readdirSync(location.spool).filter((name) => name.endsWith(".json")),
    ).toEqual([]);
    const socket = await Effect.runPromise(Worker.socketPathFor(location));
    expect(existsSync(socket)).toBe(false);
  },
);

// Why: a marked current holder released its lifetime lock; its recorded PID stays diagnostic.
test.skipIf(!canBind)(
  "a refused current listener with a released lifetime lock permits takeover regardless of its recorded PID",
  async () => {
    const claimWith = async (holderPid: number) => {
      const location = freshLocation();
      const socket = await Effect.runPromise(Worker.socketPathFor(location));
      await runOn(location, Effect.void);
      // A socket file nobody accepts on: its process bound it and exited without unlinking it.
      const binder = Bun.spawn([
        "bun",
        "-e",
        `require("node:net").createServer().listen(${JSON.stringify(socket)}, () => process.exit(0))`,
      ]);
      expect(await binder.exited).toBe(0);
      await runOn(
        location,
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          const at = new Date().toISOString();
          yield* sql`INSERT INTO worker_state ${sql.insert({
            id: 1,
            pid: holderPid,
            socket,
            started_at: at,
            last_progress_at: at,
            last_progress: "running",
          })}`;
          yield* sql`INSERT INTO worker_lock_claim(id) VALUES (1)`;
        }),
      );
      const child = Bun.spawn(
        ["bun", fixture, dirname(location.directory), "100"],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [stdout, code] = await Promise.all([
        new Response(child.stdout).text(),
        child.exited,
      ]);
      expect(code).toBe(0);
      return { stdout, socketKept: existsSync(socket) };
    };

    // A live diagnostic PID cannot retain a released lifetime lock.
    const alive = await claimWith(process.pid);
    expect(alive.stdout).toContain("exit idle");
    expect(alive.socketKept).toBe(false);

    // The holder has exited: the file is stale, so the worker claims, then idles out.
    const gone = Bun.spawn(["true"]);
    await gone.exited;
    const dead = await claimWith(gone.pid);
    expect(dead.stdout).toContain(" claimed ");
    expect(dead.stdout).toContain("exit idle");
    expect(dead.socketKept).toBe(false);
  },
  60_000,
);

// Why: even an unbound socket file in the store makes Neuve Graph refuse the repository, so a
// starting worker that holds the lifetime lock removes a stale one there, as it does a stale one in
// its own socket directory; a live one is never removed.
test.skipIf(!canBind)(
  "a starting worker removes stale sockets outside and inside the store",
  async () => {
    const location = freshLocation();
    await runOn(location, Effect.void);
    const paths = await Effect.runPromise(Worker.workerPathsFor(location));
    for (const path of [paths.socket, paths.legacy!]) {
      const binder = Bun.spawn([
        "bun",
        "-e",
        `require("node:net").createServer().listen(${JSON.stringify(path)}, () => process.exit(0))`,
      ]);
      expect(await binder.exited).toBe(0);
      expect(existsSync(path)).toBe(true);
    }
    const child = Bun.spawn(
      ["bun", fixture, dirname(location.directory), "100"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, code] = await Promise.all([
      new Response(child.stdout).text(),
      child.exited,
    ]);
    expect(code).toBe(0);
    expect(stdout).toContain(` claimed ${paths.socket}`);
    expect(stdout).toContain("exit idle");
    expect(existsSync(paths.socket)).toBe(false);
    expect(existsSync(paths.legacy!)).toBe(false);
  },
  60_000,
);

// Why: a worker of an older build binds the store's legacy socket and holds the lifetime lock every
// build takes. A worker of this build must not start beside it, must say why and how to stop it, and
// must leave its live socket alone.
test.skipIf(!canBind)(
  "a new worker refuses while an older build's worker is live on the legacy socket",
  async () => {
    const location = freshLocation();
    await runOn(location, Effect.void);
    const paths = await Effect.runPromise(Worker.workerPathsFor(location));
    const older = Bun.spawn(
      [
        "bun",
        "-e",
        `const db = new (require("bun:sqlite").Database)(${JSON.stringify(paths.lock)}, { create: true });
db.exec("PRAGMA busy_timeout=0"); db.exec("BEGIN IMMEDIATE");
require("node:net").createServer((s) => s.on("data", () => s.write("ok\\n")))
  .listen(${JSON.stringify(paths.legacy)}, () => console.log("ready"));`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    try {
      const reader = older.stdout.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain(
        "ready",
      );
      reader.releaseLock();
      const child = Bun.spawn(
        ["bun", fixture, dirname(location.directory), "100"],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [stdout, code] = await Promise.all([
        new Response(child.stdout).text(),
        child.exited,
      ]);
      expect(code).toBe(0);
      expect(stdout).toContain(
        `a worker of an older Neuve build is running on ${paths.legacy}, inside the repository. Stop it with neuve worker stop`,
      );
      expect(stdout).toContain("exit another-worker");
      expect(existsSync(paths.legacy!)).toBe(true);
      expect(existsSync(paths.socket)).toBe(false);
    } finally {
      older.kill("SIGKILL");
      await older.exited;
    }
  },
  60_000,
);

// Why: the two slots (10.31). A review enqueued behind a commit burst must start at once in the
// interactive slot while the burst drains in the background slot, newest commit first, and commit
// preparation's heavy work is never held behind the review (it prepares during the review). Nothing
// fails when this regresses; a review just waits. The order is pinned by events, never by clock
// readings: the first preparation waits for the review to start, and the review waits for every
// preparation's heavy work to start. A regression turns either wait into its 10-second timeout and
// the order below fails.
test.skipIf(!canBind)(
  "a review starts at once beside a commit burst, which keeps preparing during the review",
  async () => {
    const location = freshLocation();
    const marks: Array<string> = [];
    const mark = (what: string) => Effect.sync(() => void marks.push(what));
    const reviewStarted = Effect.runSync(Deferred.make<void>());
    const allHeavy = Effect.runSync(Deferred.make<void>());
    let heavyStarted = 0;
    const wait = (deferred: Deferred.Deferred<void>) =>
      Deferred.await(deferred).pipe(Effect.timeoutOption("10 seconds"));
    const prepare: Worker.JobHandler = (job) =>
      Effect.gen(function* () {
        yield* mark(`prepare ${job.dedupeKey} start`);
        // The burst's first job runs while the review starts beside it, or waits out the timeout.
        if (job.dedupeKey === "c4") yield* wait(reviewStarted);
        const heavy = yield* Worker.HeavyWork;
        yield* heavy.start(
          Effect.gen(function* () {
            yield* mark(`prepare ${job.dedupeKey} heavy`);
            if (++heavyStarted === 4)
              yield* Deferred.succeed(allHeavy, undefined);
          }),
        );
        yield* mark(`prepare ${job.dedupeKey} end`);
      });
    const review: Worker.JobHandler = () =>
      Effect.gen(function* () {
        yield* mark("review start");
        yield* Deferred.succeed(reviewStarted, undefined);
        // The review stays active until every preparation's heavy work has started.
        yield* wait(allHeavy);
        yield* mark("review end");
      });
    const exit = await Effect.runPromise(
      Effect.andThen(
        Store.prepareForWrite,
        Effect.gen(function* () {
          const queue = yield* JobQueue.JobQueue;
          for (const key of ["c1", "c2", "c3", "c4"])
            yield* queue.enqueue({ kind: "commit.prepare@2", dedupeKey: key });
          yield* queue.enqueue({ kind: "review.run", dedupeKey: "r1" });
          return yield* Worker.run({
            location,
            handlers: { "commit.prepare@2": prepare, "review.run": review },
            idleTimeout: "200 millis",
            pollInterval: "50 millis",
          });
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
            Logger.layer([Logger.make(() => {})]),
          ),
        ),
      ),
    );
    expect(exit.reason).toBe("idle");
    const at = (what: string) => {
      const found = marks.indexOf(what);
      if (found < 0) throw new Error(`no mark ${what}`);
      return found;
    };
    const starts = marks
      .filter((what) => what.endsWith(" start") && what.startsWith("prepare"))
      .map((what) => what.split(" ")[1]);
    expect(starts).toEqual(["c4", "c3", "c2", "c1"]);
    // The review was taken before the burst's first job ended, and the burst ran beside it.
    expect(at("review start")).toBeLessThan(at("prepare c4 end"));
    expect(at("prepare c4 start")).toBeLessThan(at("review end"));
    // Commit preparation's heavy work is never held behind the interactive review.
    for (const key of ["c1", "c2", "c3", "c4"])
      expect(at(`prepare ${key} heavy`)).toBeLessThan(at("review end"));
  },
);

// Why: a retry that falls due while every slot that could take it is busy must not wake the loop
// (6.10). Only a free slot's `take` promotes it, so waking for it spun the loop every 10 ms for the
// rest of the running job, up to its 10-minute deadline. Nothing fails; the CPU just burns, so the
// loop's turns are counted here through the queue it scans each turn.
test.skipIf(!canBind)(
  "a retry due while both slots are busy does not spin the loop",
  async () => {
    const location = freshLocation();
    let scans = 0;
    const countingQueue = Layer.effect(
      JobQueue.JobQueue,
      Effect.gen(function* () {
        const queue = yield* JobQueue.JobQueue;
        return JobQueue.JobQueue.of({
          ...queue,
          outstanding: (kinds) => {
            scans += 1;
            return queue.outstanding(kinds);
          },
        });
      }),
    ).pipe(Layer.provide(JobQueue.layer));
    const busy: Worker.JobHandler = () => Effect.sleep("1500 millis");
    let scansWhileBusy = 0;
    const exit = await Effect.runPromise(
      Effect.andThen(
        Store.prepareForWrite,
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          const queue = yield* JobQueue.JobQueue;
          yield* queue.enqueue({ kind: "commit.prepare", dedupeKey: "c1" });
          yield* queue.enqueue({ kind: "review.run", dedupeKey: "r1" });
          // A retry of a background kind, due 200 ms after the worker starts, when both slots run.
          const { job } = yield* queue.enqueue({
            kind: "worker.probe",
            dedupeKey: "retry",
          });
          const due = new Date(Date.now() + 200).toISOString();
          yield* sql`UPDATE jobs SET state = 'delayed', run_at = ${due} WHERE job_seq = ${job.seq}`;
          const worker = yield* Effect.forkChild(
            Worker.run({
              location,
              handlers: {
                "commit.prepare": busy,
                "review.run": busy,
                "worker.probe": Worker.probeHandler,
              },
              idleTimeout: "200 millis",
              pollInterval: "500 millis",
            }),
          );
          yield* Effect.sleep("1300 millis");
          scansWhileBusy = scans;
          return yield* Fiber.join(worker);
        }),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            countingQueue,
            Computations.layer.pipe(Layer.provideMerge(Blobs.layer(location))),
          ),
        ),
        Effect.provide(Store.layer(location, { create: true })),
        Effect.provide(
          Layer.merge(
            BunFileSystem.layer,
            Logger.layer([Logger.make(() => {})]),
          ),
        ),
      ),
    );
    expect(exit.reason).toBe("idle");
    // 1.3 s with both slots busy at a 500 ms poll is a handful of turns; spinning made it ~100.
    expect(scansWhileBusy).toBeLessThan(15);
  },
);

// Why: a handler can leave work running after its job ends (a Graph search a review stopped
// waiting for), which finishes and keeps its answer. A worker that idled out under it would end
// that work with the process and lose the answer, and nothing else would show it.
test.skipIf(!canBind)(
  "a worker does not idle out while work its handler left running still runs",
  async () => {
    const location = freshLocation();
    let detached = 0;
    let finishedAt = 0;
    const review: Worker.JobHandler = () =>
      Effect.gen(function* () {
        detached++;
        yield* Effect.forkDetach(
          Effect.sleep("800 millis").pipe(
            Effect.ensuring(
              Effect.sync(() => {
                detached--;
                finishedAt = performance.now();
              }),
            ),
          ),
        );
      });
    const exit = await Effect.runPromise(
      Effect.andThen(
        Store.prepareForWrite,
        Effect.gen(function* () {
          const queue = yield* JobQueue.JobQueue;
          yield* queue.enqueue({ kind: "review.run", dedupeKey: "r1" });
          return yield* Worker.run({
            location,
            handlers: { "review.run": review },
            idleTimeout: "200 millis",
            pollInterval: "50 millis",
            detachedWork: Effect.sync(() => detached),
          });
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
            Logger.layer([Logger.make(() => {})]),
          ),
        ),
      ),
    );
    const exitedAt = performance.now();
    expect(exit.reason).toBe("idle");
    // The work ended before the worker did, and the idle period ran after it.
    expect(detached).toBe(0);
    expect(finishedAt).toBeGreaterThan(0);
    expect(exitedAt - finishedAt).toBeGreaterThanOrEqual(150);
  },
  30_000,
);

// Why: the worker declares the Graph cache's bases from its loop (`eachTurn`), so the hook must run
// on the loop's turns, and its failure (Graph or git unavailable) must never stop the worker or
// the jobs it runs.
test.skipIf(!canBind)(
  "a worker runs its turn's own work on every turn, and a failure of it stops nothing",
  async () => {
    const location = freshLocation();
    let turns = 0;
    let ran = 0;
    const exit = await Effect.runPromise(
      Effect.andThen(
        Store.prepareForWrite,
        Effect.gen(function* () {
          const queue = yield* JobQueue.JobQueue;
          yield* queue.enqueue({ kind: "review.run", dedupeKey: "r1" });
          return yield* Worker.run({
            location,
            handlers: { "review.run": () => Effect.sync(() => void ran++) },
            idleTimeout: "200 millis",
            pollInterval: "50 millis",
            eachTurn: Effect.suspend(() => {
              turns++;
              return Effect.fail(new Error("Graph is unavailable"));
            }),
          });
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
            Logger.layer([Logger.make(() => {})]),
          ),
        ),
      ),
    );
    expect(exit.reason).toBe("idle");
    expect(ran).toBe(1);
    // 200 ms idle at a 50 ms poll is several turns.
    expect(turns).toBeGreaterThan(2);
  },
  30_000,
);

// Required finalization drains on shutdown; unrelated noncooperative handlers keep bounded stop.
test.skipIf(!canBind).each([false, true])(
  "worker shutdown drains only explicitly retained handler finalization (%s)",
  async (retain) => {
    const location = freshLocation();
    let entered = false;
    let exited = false;
    let settled = false;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handler: Worker.JobHandler = () =>
      Effect.gen(function* () {
        if (retain) yield* (yield* Worker.HandlerLifetime).retain;
        entered = true;
        yield* Effect.promise(() => gate);
        settled = true;
      }).pipe(Effect.uninterruptible);
    const observation = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Store.prepareForWrite;
        const queue = yield* JobQueue.JobQueue;
        yield* queue.enqueue({ kind: "review.run", dedupeKey: "shutdown" });
        const worker = yield* Effect.forkChild(
          Worker.run({
            location,
            handlers: { "review.run": handler },
            pollInterval: "5 millis",
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                exited = true;
              }),
            ),
          ),
        );
        while (!entered) yield* Effect.sleep("5 millis");
        yield* Worker.reachWorker(
          yield* Worker.socketPathFor(location),
          "stop",
        );
        yield* Effect.sleep("100 millis");
        const beforeRelease = { exited, settled };
        release();
        yield* Fiber.join(worker);
        while (!settled) yield* Effect.sleep("5 millis");
        return beforeRelease;
      }).pipe(
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
            Logger.layer([Logger.make(() => {})]),
          ),
        ),
        Effect.ensuring(Effect.sync(() => release())),
      ),
    );
    expect(observation).toEqual({ exited: !retain, settled: false });
    expect(exited).toBe(true);
    expect(settled).toBe(true);
  },
  10_000,
);

// The budget's host must survive an otherwise idle repository while other jobs hold grants.
test.skipIf(!canBind)(
  "an idle worker consults its external grant owner before exiting",
  async () => {
    const location = freshLocation();
    let checked = 0;
    const exit = await Effect.runPromise(
      Effect.andThen(
        Store.prepareForWrite,
        Worker.run({
          location,
          idleTimeout: "50 millis",
          pollInterval: "20 millis",
          beforeIdleExit: Effect.sync(() => ++checked > 1),
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
            Logger.layer([Logger.make(() => {})]),
          ),
        ),
      ),
    );
    expect(exit.reason).toBe("idle");
    expect(checked).toBe(2);
  },
  30000,
);
