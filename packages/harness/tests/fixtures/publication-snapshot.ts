import { Effect, Layer } from "effect";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import {
  Blobs,
  Computations,
  Store,
  storeLocationIn,
} from "@neuve/records-core";
import { treeIndex } from "../../src/search-index.ts";
import { CodeWork } from "../../src/code-work.ts";
const [repository, tree, work] = Bun.argv.slice(2);
if (!repository || !tree || !work) throw new Error("Arguments required");
const executable = repository + "/missing-engine",
  source = { executable, key: { unavailable: executable } };
const location = storeLocationIn(repository + "/seed-records");
const layer = Computations.layer.pipe(
  Layer.provideMerge(Blobs.layer(location)),
  Layer.provideMerge(
    Layer.effectDiscard(Store.prepareForWrite).pipe(
      Layer.provideMerge(Store.layer(location, { create: true })),
    ),
  ),
  Layer.provideMerge(BunFileSystem.layer),
);
await Effect.runPromise(
  treeIndex(repository, tree, source).pipe(
    Effect.provideService(CodeWork, { directory: work, background: false }),
    Effect.provide(layer),
  ),
);
