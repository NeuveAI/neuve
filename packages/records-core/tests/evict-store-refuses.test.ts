// Why (design `records-evictable-outputs`, decisions 8.10 and 12.45): eviction deletes rows, so the
// store itself, not only the code that evicts, must refuse every delete the design protects. Raw
// SQL, bypassing the code, tries each: an output of an undeclared kind, an output an event names,
// an output a model produced, and the blob of an output another row still names. The one delete
// the design allows goes through only in its order: row, attempts, then the marked blob. A mark
// cannot be pointed at another blob afterwards.
import { afterAll, expect, test } from "bun:test";
import { Effect } from "effect";
import { Computations } from "../src/index.ts";
import {
  OP,
  OTHER,
  attempt,
  count,
  eventNaming,
  outputOf,
  specOf,
  withStores,
} from "./evict-support.ts";
import { freshLocation, removeTemporaryDirectories } from "./support.ts";

afterAll(removeTemporaryDirectories);

test("raw deletes are refused for an undeclared kind, an event-named output and a model-produced output; the allowed one goes only in order", async () => {
  const location = freshLocation();
  const result = await withStores(
    location,
    Effect.gen(function* () {
      const store = yield* Computations.ComputationStore;
      const durable = yield* store.run(specOf(OTHER, "kept"), outputOf("kept"));
      // Declared before its rows exist, so the model-produced row below is the store's to refuse.
      yield* store.declareKind({ op: OP, capBytes: 0 });
      const named = yield* store.run(specOf(OP, "named"), outputOf("named"));
      yield* eventNaming(`computation:${named.computation.key}`);
      const modelled = yield* store.run(
        specOf(OP, "modelled"),
        Effect.succeed({
          ...(yield* outputOf("modelled")),
          model: "a-model",
          usage: { input: 1, cacheCreation: 0, cacheRead: 0, output: 1 },
        }),
      );
      const free = yield* store.run(specOf(OP, "free"), outputOf("free"));
      const ordered = yield* store.run(
        specOf(OP, "ordered"),
        outputOf("ordered"),
      );
      const blobNamed = yield* store.run(
        specOf(OP, "blob-named"),
        outputOf("blob-named"),
      );
      yield* eventNaming(`blob:${blobNamed.computation.outputHash}`);

      const deletes = (key: string, hash: string) =>
        Effect.all({
          attemptFirst: attempt(
            "DELETE FROM computation_attempts WHERE key = ?",
            [key],
          ),
          mark: attempt(
            "INSERT INTO blob_removals (hash, at) VALUES (?, '2026-11-13T00:00:00.000Z')",
            [hash],
          ),
          computation: attempt("DELETE FROM computations WHERE key = ?", [key]),
          attempts: attempt("DELETE FROM computation_attempts WHERE key = ?", [
            key,
          ]),
          blob: attempt("DELETE FROM blobs WHERE hash = ?", [hash]),
        });
      const undeclared = yield* deletes(
        durable.computation.key,
        durable.computation.outputHash,
      );
      const eventNamed = yield* deletes(
        named.computation.key,
        named.computation.outputHash,
      );
      const modelProduced = yield* deletes(
        modelled.computation.key,
        modelled.computation.outputHash,
      );
      // The allowed delete, out of order first: an unmarked blob, then in order.
      const unmarkedBlob = yield* Effect.all({
        computation: attempt("DELETE FROM computations WHERE key = ?", [
          free.computation.key,
        ]),
        attempts: attempt("DELETE FROM computation_attempts WHERE key = ?", [
          free.computation.key,
        ]),
        blob: attempt("DELETE FROM blobs WHERE hash = ?", [
          free.computation.outputHash,
        ]),
      });
      const inOrder = yield* Effect.all({
        mark: attempt(
          "INSERT INTO blob_removals (hash, at) VALUES (?, '2026-11-13T00:00:00.000Z')",
          [ordered.computation.outputHash],
        ),
        computation: attempt("DELETE FROM computations WHERE key = ?", [
          ordered.computation.key,
        ]),
        attempts: attempt("DELETE FROM computation_attempts WHERE key = ?", [
          ordered.computation.key,
        ]),
        blob: attempt("DELETE FROM blobs WHERE hash = ?", [
          ordered.computation.outputHash,
        ]),
      });
      // The mark `eventNamed` left on its blob, pointed at a blob nothing else would let go.
      const markChange = yield* attempt(
        "UPDATE blob_removals SET hash = ? WHERE hash = ?",
        [durable.computation.outputHash, named.computation.outputHash],
      );
      const blobEvent = yield* deletes(
        blobNamed.computation.key,
        blobNamed.computation.outputHash,
      );
      const left = yield* Effect.all({
        computations: count("SELECT count(*) AS n FROM computations"),
        attempts: count("SELECT count(*) AS n FROM computation_attempts"),
        blobs: count("SELECT count(*) AS n FROM blobs"),
      });
      return {
        undeclared,
        eventNamed,
        modelProduced,
        unmarkedBlob,
        inOrder,
        blobEvent,
        markChange,
        left,
      };
    }),
  );

  expect(result.undeclared).toEqual({
    attemptFirst:
      "not evictable: computation_attempts is append-only except for attempts of a kind declared recomputable",
    mark: "not evictable: a blob is marked for removal only while it is the output of a kind declared recomputable",
    computation:
      "not evictable: computations is append-only except for outputs of a kind declared recomputable",
    attempts:
      "not evictable: computation_attempts is append-only except for attempts of a kind declared recomputable",
    blob: "blobs keep their row",
  });
  expect(result.eventNamed).toEqual({
    attemptFirst:
      "not evictable: an attempt is deleted only after its computation",
    // Marking is allowed while a declared kind's row names the blob; the blob itself is still kept.
    mark: "done",
    computation:
      "not evictable: an event names this computation, so it is permanent",
    attempts: "not evictable: an attempt is deleted only after its computation",
    blob: "not evictable: a computation or attempt still names this blob",
  });
  expect(result.modelProduced).toEqual({
    attemptFirst:
      "not evictable: an attempt is deleted only after its computation",
    mark: "done",
    computation:
      "not evictable: a model produced this computation, so it is permanent",
    attempts: "not evictable: an attempt is deleted only after its computation",
    blob: "not evictable: a computation or attempt still names this blob",
  });
  expect(result.unmarkedBlob).toEqual({
    computation: "done",
    attempts: "done",
    blob: "blobs keep their row",
  });
  expect(result.markChange).toBe(
    "not evictable: a mark for removal is never changed",
  );
  expect(result.inOrder).toEqual({
    mark: "done",
    computation: "done",
    attempts: "done",
    blob: "done",
  });
  // Row and attempts go; the blob an event names stays, marked or not.
  expect(result.blobEvent).toEqual({
    attemptFirst:
      "not evictable: an attempt is deleted only after its computation",
    mark: "done",
    computation: "done",
    attempts: "done",
    blob: "not evictable: an event names this blob, so it is permanent",
  });
  // Every refused delete left its row: 6 outputs stored, 3 rows and 1 blob deleted as allowed.
  expect(result.left).toEqual({ computations: 3, attempts: 3, blobs: 5 });
}, 30_000);
