// Why: batching must preserve immutable commit keys and the order of mixed cache hits/misses.
// It must also retain hash verification when persisted bytes cross back into the process.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { z } from "zod";
import {
  Blobs,
  Computations,
  Store,
  storeLocationIn,
} from "@neuve/records-core";
import { jsonComputation, storedOutputs } from "../src/search-index.ts";

const directory = mkdtempSync(join(tmpdir(), "store-batches-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const location = storeLocationIn(directory);
const layer = Computations.layer.pipe(
  Layer.provideMerge(Blobs.layer(location)),
  Layer.provideMerge(
    Layer.effectDiscard(Store.prepareForWrite).pipe(
      Layer.provideMerge(Store.layer(location, { create: true })),
    ),
  ),
  Layer.provideMerge(BunFileSystem.layer),
);

test("batch outputs stay keyed by commit and preserve duplicate hits and misses", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const spec = (commit: string): Computations.ComputationSpec => ({
        op: "test.commit",
        opVersion: 1,
        inputs: { commit },
      });
      const first = spec("a".repeat(40));
      const second = spec("b".repeat(40));
      yield* jsonComputation(first, z.string(), Effect.succeed("first commit"));
      yield* jsonComputation(
        second,
        z.string(),
        Effect.succeed("second commit"),
      );
      const outputs = yield* storedOutputs(
        [second, first, second, spec("c".repeat(40))],
        z.string(),
      );
      const repeated = yield* jsonComputation(
        first,
        z.string(),
        Effect.die("must reuse"),
      );
      return {
        outputs: outputs.map(Option.getOrNull),
        repeated: repeated.value,
        status: repeated.status,
      };
    }).pipe(Effect.provide(layer)),
  );
  expect(result).toEqual({
    outputs: ["second commit", "first commit", "second commit", null],
    repeated: "first commit",
    status: "reused",
  });
});

test("a batch read refuses persisted bytes that no longer hash to their name", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const blobs = yield* Blobs.BlobStore;
      const sql = yield* SqlClient;
      const { blob } = yield* blobs.put({
        bytes: new TextEncoder().encode("original"),
        mediaType: "text/plain",
        retention: "durable",
      });
      yield* sql`DROP TRIGGER blobs_guarded_update`;
      yield* sql`UPDATE blobs SET content = ${new TextEncoder().encode("tampered")} WHERE hash = ${blob.hash}`;
      return yield* Effect.flip(blobs.getMany([blob.hash]));
    }).pipe(Effect.provide(layer)),
  );
  expect(result._tag).toBe("BlobCorrupt");
});
