// Runs one worker process against a store directory, for the singleton test. Logs go to stdout.
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Duration, Effect, Layer, Logger } from "effect";
import {
  Blobs,
  Computations,
  JobQueue,
  Store,
  Worker,
  storeLocationIn,
} from "../../src/index.ts";

import "../fixture-worker-lifetime.ts";
const [commonDirectory, idleMillis] = Bun.argv.slice(2);
if (commonDirectory === undefined || idleMillis === undefined)
  throw new Error("usage: run-worker.ts <common directory> <idle millis>");
const location = storeLocationIn(commonDirectory);
const logger = Logger.make((options) => {
  process.stdout.write(`${String(options.message)}\n`);
});
const exit = await Effect.runPromise(
  Effect.andThen(
    Store.prepareForWrite,
    Worker.run({
      location,
      idleTimeout: Duration.millis(Number(idleMillis)),
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
    (program) =>
      (Worker.withStartup ?? ((_location, effect) => effect))(
        location,
        program,
      ),
    Effect.provide(Layer.merge(BunFileSystem.layer, Logger.layer([logger]))),
  ),
);
process.stdout.write(`exit ${exit.reason}\n`);

process.exit(0);
