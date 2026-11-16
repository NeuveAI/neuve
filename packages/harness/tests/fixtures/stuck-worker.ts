// Runs one worker process for stop-and-drop.test.ts, with a handler stuck in a call it cannot
// cancel (an uninterruptible 6 s sleep, as a provider call with no cancel would be). Usage:
//   bun stuck-worker.ts <common directory> <stuck-review <run id> <cycle id> | stuck-probe | fast-probe>
// The review stand-in starts its run, appends one batch as Publish would, then sticks for 2 s.
// Logs go to stdout; the last line is the worker's exit reason.
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Layer, Logger } from "effect";
import {
  Blobs,
  Computations,
  JobQueue,
  Log,
  Store,
  Worker,
  mintUlid,
  storeLocationIn,
} from "@neuve/records-core";
import { ensureRunFolder } from "../../src/run-folder.ts";
import { openRunLog } from "../../src/run-log.ts";

const [commonDirectory, mode, runId, cycleId] = Bun.argv.slice(2);
if (commonDirectory === undefined || mode === undefined)
  throw new Error("usage: stuck-worker.ts <common directory> <mode> [run id]");
const location = storeLocationIn(commonDirectory);

const stuck = Effect.uninterruptible(Effect.sleep("6 seconds"));
const handlers: Partial<Record<string, Worker.JobHandler>> =
  mode === "stuck-review"
    ? {
        "review.run": (job) =>
          Effect.gen(function* () {
            // The review's run folder, as its first stage would hold it, then a stuck call.
            yield* ensureRunFolder(location, {
              runId: runId!,
              runKey: "f".repeat(64),
              pipelineVersion: 1,
              range: {
                baseRef: "main",
                baseOid: "1".repeat(40),
                headOid: "2".repeat(40),
              },
              jobSeq: job.seq,
            });
            openRunLog(location, runId!).write({ type: "run.started" });
            // Publish began: one batch appended under the run key's positions, no packet yet.
            yield* Log.append([
              {
                id: mintUlid(),
                kind: "batch.recorded@1",
                idempotencyKey: `review:${cycleId}:${"f".repeat(64)}:batch:b1#0123456789abcdef`,
                actor: "a".repeat(64),
                occurredAt: new Date().toISOString(),
                attribution: { cycleId: cycleId!, batchId: mintUlid() },
                payload: { title: "Batch one", focus: "f" },
              },
            ]);
            yield* Effect.logInfo("review: run folder ready; stuck in a call");
            yield* Effect.uninterruptible(Effect.sleep("2 seconds"));
          }),
      }
    : mode === "stuck-probe"
      ? { "worker.probe": () => stuck }
      : { "worker.probe": () => Effect.void };
// A review request enqueues `review.run@2`; the same handler runs either kind.
if (handlers["review.run"] !== undefined)
  handlers["review.run@2"] = handlers["review.run"];

const logger = Logger.make((options) => {
  process.stdout.write(`${String(options.message)}\n`);
});
const exit = await Effect.runPromise(
  Effect.andThen(
    Store.prepareForWrite,
    Worker.run({
      location,
      handlers: handlers as never,
      idleTimeout: "1 second",
      pollInterval: "50 millis",
    }),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        JobQueue.layer,
        Computations.layer.pipe(Layer.provideMerge(Blobs.layer(location))),
      ),
    ),
    Effect.provide(Store.layer(location, { create: true })),
    Effect.provide(Layer.merge(BunFileSystem.layer, Logger.layer([logger]))),
  ) as Effect.Effect<Worker.WorkerExit, unknown, never>,
);
process.stdout.write(`exit ${exit.reason}\n`);
process.exit(0);
