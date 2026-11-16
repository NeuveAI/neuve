/**
 * A second process for the relations tests: binds the given output under one commit's relations
 * key in the given store, as another process computing the same index would. Prints the store's
 * status for the run.
 *
 *   bun tests/fixtures/relations-publish.ts <records folder> <commit> <executable> <sha256> <output file>
 */
import { readFileSync } from "node:fs";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Layer, ManagedRuntime } from "effect";
import {
  Blobs,
  Computations,
  Store,
  storeLocationIn,
} from "@neuve/records-core";
import { relationsSpec } from "../../src/relations.ts";

const [records, commit, executable, sha256, output] = process.argv.slice(2);
if (
  records === undefined ||
  commit === undefined ||
  executable === undefined ||
  sha256 === undefined ||
  output === undefined
)
  throw new Error("usage: <records> <commit> <executable> <sha256> <output>");
const location = storeLocationIn(records);
const runtime = ManagedRuntime.make(
  Computations.layer.pipe(
    Layer.provideMerge(Blobs.layer(location)),
    Layer.provideMerge(
      Layer.effectDiscard(Store.prepareForWrite).pipe(
        Layer.provideMerge(Store.layer(location, { create: true })),
      ),
    ),
    Layer.provideMerge(BunFileSystem.layer),
  ),
);
const result = await runtime.runPromise(
  Effect.gen(function* () {
    const store = yield* Computations.ComputationStore;
    return yield* store.run(
      relationsSpec(commit, { executable, key: { sha256 } }),
      Effect.succeed({
        bytes: new Uint8Array(readFileSync(output)),
        mediaType: "application/json",
      }),
    );
  }),
);
console.log(result.status);
await runtime.dispose();
