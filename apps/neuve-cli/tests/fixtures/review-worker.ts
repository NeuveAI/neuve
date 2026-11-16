import "../../../../packages/records-core/tests/fixture-worker-lifetime.ts";
// A Records worker for the review-worker test. `older <repo> <idle ms> <marker>` stands in for a
// build before 12.24: it takes only `review.run` and idles out. `<…> worker run --repo <repo>`, as
// `Starter.ensureWorker` runs it, stands in for this build's worker: it takes `review.run@2` and
// writes the marker file, so the test sees which worker ran the job.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Duration, Effect, Layer, Logger } from "effect";
import {
  Blobs,
  Computations,
  JobQueue,
  Store,
  Worker,
  resolveStoreLocation,
} from "@neuve/records-core";

const args = Bun.argv.slice(2);
const older = args[0] === "older";
const repository = older ? args[1] : args[args.indexOf("--repo") + 1];
const idle = older ? Number(args[2]) : 1_000;
const marker = older ? args[3] : process.env["REVIEW_WORKER_MARKER"];
if (repository === undefined || marker === undefined)
  throw new Error(
    "usage: review-worker.ts older <repo> <idle ms> <marker> | worker run --repo <repo>",
  );
const record = (who: string) => (job: JobQueue.Job) =>
  Effect.sync(() => appendFileSync(marker, `${who} ${job.kind} ${job.seq}\n`));
const location = await Effect.runPromise(resolveStoreLocation(repository));
appendFileSync(marker, `${older ? "older" : "this build"} started\n`);
// `REVIEW_WORKER_HOLD=1`: this build's worker lacks the route's credential, and holds the review
// as the harness's admission does, recording it in held-reviews.json.
const hold =
  !older && process.env["REVIEW_WORKER_HOLD"] === "1"
    ? (job: JobQueue.Job) =>
        Effect.sync(() => {
          mkdirSync(join(location.directory, "harness"), { recursive: true });
          writeFileSync(
            join(location.directory, "harness/held-reviews.json"),
            JSON.stringify([
              {
                seq: job.seq,
                pid: process.pid,
                at: new Date().toISOString(),
                provider: "openai",
                route: "openai/stand-in",
                credential: "the Neuve sign-in",
              },
            ]),
          );
          return false;
        })
    : undefined;
await Effect.runPromise(
  Effect.andThen(
    Store.prepareForWrite,
    Worker.run({
      location,
      handlers: older
        ? { "review.run": record("older") }
        : {
            "review.run": record("this build"),
            "review.run@2": record("this build"),
          },
      ...(hold === undefined ? {} : { admit: hold }),
      idleTimeout: Duration.millis(hold === undefined ? idle : 5_000),
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
    Effect.provide(
      Layer.merge(BunFileSystem.layer, Logger.layer([Logger.make(() => {})])),
    ),
  ),
);
appendFileSync(marker, `${older ? "older" : "this build"} exited\n`);
process.exit(0);
