// Why: a running review could not be stopped. `neuve jobs drop` refused an active job, and `neuve
// worker stop` waited on an attempt whose in-flight call could not be interrupted, past the CLI's
// wait. These pin, with a worker process whose handler ignores interruption for 6 s (a provider
// call with no cancel), that dropping an active review ends it dropped at once with its run folder
// gone (10.14), and that stopping a worker with an active job exits promptly and the job resumes at
// the next start. Workers run as their own processes, as in use. Binding the worker's Unix socket
// needs a host that allows it; the Claude sandbox does not, so there the tests are skipped.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Layer, Option } from "effect";
import {
  Blobs,
  Computations,
  JobQueue,
  Log,
  Store,
  Worker,
  mintUlid,
  storeLocationIn,
  type StoreLocation,
} from "@neuve/records-core";
import { dropActiveJob } from "../src/handler.ts";
import { runFolder } from "../src/run-folder.ts";

const directories: Array<string> = [];
afterAll(() => {
  for (const directory of directories)
    rmSync(directory, { recursive: true, force: true });
});
const freshLocation = () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-stop-"));
  directories.push(directory);
  return storeLocationIn(directory);
};

const canBind = (() => {
  const location = freshLocation();
  mkdirSync(location.directory, { recursive: true });
  try {
    const server = Bun.listen({
      unix: join(location.directory, "probe.sock"),
      socket: { data() {} },
    });
    server.stop(true);
    return true;
  } catch {
    return false;
  }
})();
if (!canBind)
  console.warn(
    "stop-and-drop.test.ts: this host forbids binding Unix sockets (sandbox); the tests are skipped",
  );

/** One store connection for one call, as a CLI command opens it. */
const runIn = <A, E, R>(
  location: StoreLocation,
  program: Effect.Effect<A, E, R>,
  write = false,
) =>
  Effect.runPromise(
    (write ? Effect.andThen(Store.prepareForWrite, program) : program).pipe(
      Effect.provide(
        Layer.mergeAll(
          JobQueue.layer,
          Computations.layer.pipe(Layer.provideMerge(Blobs.layer(location))),
        ).pipe(
          Layer.provideMerge(Store.layer(location, { create: true })),
          Layer.provideMerge(BunFileSystem.layer),
        ),
      ),
    ) as Effect.Effect<A, E, never>,
  );

const fixture = join(import.meta.dir, "fixtures", "stuck-worker.ts");
const startWorker = (location: StoreLocation, ...args: Array<string>) => {
  const child = Bun.spawn(
    ["bun", fixture, dirname(location.directory), ...args],
    {
      env: {
        ...process.env,
        HOME: dirname(location.directory),
        TMPDIR: dirname(location.directory),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  return {
    child,
    output: Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]),
  };
};

const jobOf = (location: StoreLocation, seq: number) =>
  runIn(
    location,
    JobQueue.JobQueue.use((queue) => queue.inspect(seq)).pipe(
      Effect.map(Option.getOrUndefined),
    ),
  );

const until = async (check: () => Promise<boolean>, ms = 15_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await Bun.sleep(50);
  }
  throw new Error("condition not met in time");
};

test.skipIf(!canBind)(
  "an active review dropped mid-stage ends dropped at once, never retried, with its run folder gone",
  async () => {
    const location = freshLocation();
    const runId = mintUlid();
    const cycleId = mintUlid();
    await runIn(
      location,
      Log.append([
        {
          id: runId,
          kind: "review.requested@1",
          idempotencyKey: `review:${runId}`,
          actor: "a".repeat(64),
          occurredAt: new Date().toISOString(),
          attribution: {
            cycleId,
            range: {
              baseRef: "main",
              baseOid: "1".repeat(40),
              headOid: "2".repeat(40),
            },
          },
          payload: {
            runKey: "f".repeat(64),
            generation: 0,
            pipeline: { version: 1, config: {} },
          },
        },
      ]),
      true,
    );
    const worker = startWorker(location, "stuck-review", runId, cycleId);
    try {
      await until(async () => (await jobOf(location, 1))?.state === "active");
      await until(async () => existsSync(runFolder(location, runId)));
      const started = Date.now();
      const result = await runIn(location, dropActiveJob(location, 1));
      // The handler's 2 s uninterruptible call is awaited (bounded at 5 s) before the job ends.
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(result.dropped).toBe(true);
      const job = await jobOf(location, 1);
      expect(job?.state).toBe("failed");
      expect(job?.lastError?.tag).toBe("Dropped");
      expect(job?.lastError?.message).toContain("dropped while active");
      expect(existsSync(runFolder(location, runId))).toBe(false);
      expect(result.dropped && result.abandoned.removed).toBe(true);
      // Dropped mid-Publish: a gap for the run says so in a reader's words; the batch it appended
      // is named by its handle only in the run log's cause.
      expect(result.dropped && result.interrupted).toHaveLength(1);
      expect(result.dropped && result.interrupted[0]).toContain("b1 (");
      const gaps = await runIn(
        location,
        Log.history({ kind: "gap.disclosed@1", limit: 10 }),
      );
      expect(
        gaps.map((g) =>
          g.event.kind === "gap.disclosed@1" ? g.event.payload : undefined,
        ),
      ).toEqual([
        expect.objectContaining({
          kind: "publish-interrupted",
          detail:
            "Publishing stopped partway: 1 batch(es) were saved, but no published review includes them.",
        }),
      ]);
    } finally {
      worker.child.kill();
      await worker.output;
    }
  },
  30_000,
);

test.skipIf(!canBind)(
  "a worker stopped with an active job exits within its wait, and the job resumes at the next start",
  async () => {
    const location = freshLocation();
    await runIn(
      location,
      JobQueue.JobQueue.use((queue) =>
        queue.enqueue({
          kind: "worker.probe",
          dedupeKey: "probe:stop",
          payload: { sleepMs: 0 },
        }),
      ),
      true,
    );
    const worker = startWorker(location, "stuck-probe");
    await until(async () => (await jobOf(location, 1))?.state === "active");
    const socket = await Effect.runPromise(Worker.socketPathFor(location));
    const started = Date.now();
    const reach = await Effect.runPromise(Worker.reachWorker(socket, "stop"));
    expect(reach._tag).toBe("Answered");
    const [stdout, stderr, code] = await worker.output;
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(code, stderr).toBe(0);
    expect(stdout).toContain("aborted: worker stopping; back to waiting");
    expect(stdout).toContain("exit stopped");
    // Back to waiting, its attempt uncounted: not a failure, not a stall.
    const held = await jobOf(location, 1);
    expect(held?.state).toBe("waiting");
    expect(held?.attempts).toBe(0);
    expect(held?.stalls).toBe(0);
    // The next start runs it to the end.
    const next = startWorker(location, "fast-probe");
    const [nextOut] = await next.output;
    expect(nextOut).toContain("job 1 worker.probe completed");
    const done = await jobOf(location, 1);
    expect(done?.state).toBe("completed");
    expect(done?.attempts).toBe(1);
  },
  30_000,
);
