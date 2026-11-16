import { Effect, Layer } from "effect";
import { Blobs, Computations, type StoreLocation } from "../src/index.ts";
import type { StoredComputation, StoredContent } from "./review-fixtures.ts";

const bytes = (text: string) => new TextEncoder().encode(text);

/**
 * Stores what a new-shape review's refs name: its durable blobs and its computations. Labels in
 * `skip` are left out, so a test can make one missing.
 */
export const storeContent = (
  content: {
    readonly blobs: ReadonlyArray<StoredContent>;
    readonly computations: ReadonlyArray<StoredComputation>;
  },
  skip: ReadonlyArray<string> = [],
) =>
  Effect.gen(function* () {
    const blobs = yield* Blobs.BlobStore;
    const store = yield* Computations.ComputationStore;
    for (const blob of content.blobs)
      if (!skip.includes(blob.label))
        yield* blobs.put({
          bytes: bytes(blob.text),
          mediaType: "application/json",
          retention: "durable",
        });
    for (const computation of content.computations)
      if (!skip.includes(computation.label))
        yield* store.run(
          computation.spec,
          Effect.succeed({
            bytes: bytes(computation.text),
            mediaType: "application/json",
          }),
        );
  });

/** The blob and computation stores over the store at `location`. */
export const contentLayer = (location: StoreLocation) =>
  Computations.layer.pipe(Layer.provideMerge(Blobs.layer(location)));
