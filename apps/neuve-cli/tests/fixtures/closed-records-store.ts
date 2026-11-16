import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Layer } from "effect";
import {
  Blobs,
  Computations,
  JobQueue,
  Store,
  storeLocationIn,
} from "@neuve/records-core";

/** A real Records store with one waiting review and one shared computation. It runs as its own process so no connection stays. */
const location = storeLocationIn(Bun.argv[2]!);
await Effect.runPromise(
  Effect.andThen(
    Store.prepareForWrite,
    Effect.gen(function* () {
      const queue = yield* JobQueue.JobQueue;
      yield* queue.enqueue({ kind: "review.run@2", dedupeKey: "waiting" });
      const store = yield* Computations.ComputationStore;
      yield* store.run(
        Computations.ComputationSpec.parse({
          op: "harness.scope-snapshot",
          opVersion: 1,
          inputs: { fixture: true },
        }),
        Effect.succeed({
          bytes: new TextEncoder().encode("SHARED-OUTPUT"),
          mediaType: "text/plain",
        }),
      );
    }),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        JobQueue.layer,
        Computations.layer.pipe(Layer.provideMerge(Blobs.layer(location))),
      ),
    ),
    Effect.provide(Store.layer(location, { create: true })),
    Effect.provide(BunFileSystem.layer),
  ),
);
process.exit(0);
