// Why: "never recompute" (5.4) and content addressing fail silently: a store that recomputes, binds
// a second output, loses a failed attempt's record, or serves bytes that no longer match their hash
// still returns plausible results. These cases pin lookup-before-run, attempt history, one shared
// in-flight attempt, the permanent binding, and that tampered bytes are refused on read and by fsck.
import { afterAll, expect, test } from "bun:test";
import { Data, Effect, Layer, Ref } from "effect";
import type { FileSystem } from "effect/FileSystem";
import { SqlClient } from "effect/sql/SqlClient";
import { Admin, Blobs, Computations } from "../src/index.ts";
import { freshLocation, removeTemporaryDirectories, runOn } from "./support.ts";
import type { StoreLocation } from "../src/index.ts";

afterAll(removeTemporaryDirectories);

class Flaky extends Data.TaggedError("Flaky")<{ readonly message: string }> {}

const withStores = <A, E>(
  location: StoreLocation,
  program: Effect.Effect<
    A,
    E,
    Computations.ComputationStore | Blobs.BlobStore | SqlClient | FileSystem
  >,
) =>
  runOn(
    location,
    Effect.provide(
      program,
      Computations.layer.pipe(Layer.provideMerge(Blobs.layer(location))),
    ),
  );

const spec = {
  op: "test.echo",
  opVersion: 1,
  inputs: { range: { base: "b".repeat(40), head: "a".repeat(40) } },
};

const encode = (text: string) => ({
  bytes: new TextEncoder().encode(text),
  mediaType: "text/plain",
});

test("a finished computation is looked up, never recomputed; failed attempts stay; concurrent requests share one attempt", async () => {
  const location = freshLocation();
  const result = await withStores(
    location,
    Effect.gen(function* () {
      const store = yield* Computations.ComputationStore;
      const sql = yield* SqlClient;
      const calls = yield* Ref.make(0);
      const compute = (fail: boolean) =>
        Effect.gen(function* () {
          yield* Ref.update(calls, (n) => n + 1);
          yield* Effect.sleep("20 millis");
          if (fail) return yield* new Flaky({ message: "first try fails" });
          return {
            ...encode("output"),
            usage: { input: 1, cacheCreation: 0, cacheRead: 2, output: 3 },
          };
        });
      const failed = yield* Effect.flip(store.run(spec, compute(true)));
      const [first, second] = yield* Effect.all(
        [store.run(spec, compute(false)), store.run(spec, compute(false))],
        { concurrency: "unbounded" },
      );
      const again = yield* store.run(spec, compute(false));
      const attempts = yield* sql<{
        n: number;
        outcome: string;
        errorTag: string | null;
        usage: string | null;
      }>`SELECT n, outcome, error_tag, usage FROM computation_attempts ORDER BY n`;
      const rewrite = yield* Effect.flip(
        sql`UPDATE computations SET output_hash = output_hash`,
      );
      return {
        failed: failed._tag,
        statuses: [first.status, second.status, again.status],
        outputs: [first, second, again].map((r) =>
          new TextDecoder().decode(r.output),
        ),
        keys: new Set([first, second, again].map((r) => r.computation.key))
          .size,
        calls: yield* Ref.get(calls),
        attempts,
        rewrite: rewrite.reason._tag,
      };
    }),
  );
  expect(result.failed).toBe("Flaky");
  expect(result.statuses.sort()).toEqual(["computed", "reused", "shared"]);
  expect(result.outputs).toEqual(["output", "output", "output"]);
  expect(result.keys).toBe(1);
  // One failed attempt plus one shared successful attempt; the third request computed nothing.
  expect(result.calls).toBe(2);
  expect(result.attempts).toEqual([
    { n: 1, outcome: "failed", errorTag: "Flaky", usage: null },
    {
      n: 2,
      outcome: "succeeded",
      errorTag: null,
      usage: '{"cacheCreation":0,"cacheRead":2,"input":1,"output":3}',
    },
  ]);
  // The binding is permanent: the append-only trigger refuses any rewrite.
  expect(result.rewrite).toBe("ConstraintError");
});

test("blobs are content-addressed inline or as files, re-hashed on read, and fsck reports tampered bytes", async () => {
  const location = freshLocation();
  const small = new TextEncoder().encode("small blob");
  const large = new Uint8Array(Blobs.INLINE_MAX_BYTES + 1).fill(7);
  const stored = await withStores(
    location,
    Effect.gen(function* () {
      const blobs = yield* Blobs.BlobStore;
      const inline = yield* blobs.put({
        bytes: small,
        mediaType: "text/plain",
        retention: "raw-capture",
      });
      const file = yield* blobs.put({
        bytes: large,
        mediaType: "application/octet-stream",
        retention: "raw-capture",
      });
      // The same bytes as a durable output keep one blob, now durable.
      const repeat = yield* blobs.put({
        bytes: small,
        mediaType: "text/plain",
        retention: "durable",
      });
      const read = yield* blobs.get(file.blob.hash);
      return {
        placements: [inline.blob.placement, file.blob.placement],
        repeat: [repeat.status, repeat.blob.retention],
        readBack: read._tag === "Present" ? read.bytes.byteLength : -1,
        checks: yield* Admin.fsck(location),
        hashes: [inline.blob.hash, file.blob.hash],
      };
    }),
  );
  expect(stored.placements).toEqual(["inline", "file"]);
  expect(stored.repeat).toEqual(["existing", "durable"]);
  expect(stored.readBack).toBe(large.byteLength);
  expect(stored.checks.filter((c) => c.status !== "ok")).toEqual([]);

  const [inlineHash, fileHash] = stored.hashes as [string, string];
  await Bun.write(
    Blobs.blobPath(location, fileHash),
    new Uint8Array(large.byteLength).fill(8),
  );
  const tampered = await withStores(
    location,
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const tamper = sql`UPDATE blobs SET content = ${new TextEncoder().encode("SMALL BLOB")} WHERE hash = ${inlineHash}`;
      // Records itself cannot rewrite live bytes; corruption from outside it is simulated without the guard.
      const guarded = (yield* Effect.flip(tamper)).reason._tag;
      yield* sql`DROP TRIGGER blobs_guarded_update`;
      yield* tamper;
      const blobs = yield* Blobs.BlobStore;
      const reads = yield* Effect.forEach([inlineHash, fileHash], (hash) =>
        Effect.flip(blobs.get(hash)),
      );
      return {
        guarded,
        reads: reads.map((error) => error._tag),
        failed: (yield* Admin.fsck(location))
          .filter((c) => c.status === "fail")
          .map((c) => c.name),
      };
    }),
  );
  expect(tampered.guarded).toBe("ConstraintError");
  expect(tampered.reads).toEqual(["BlobCorrupt", "BlobCorrupt"]);
  expect(tampered.failed).toEqual([
    "inline blobs hash to their names",
    "blob files exist and hash to their names",
  ]);
});

// Why: callers must find completed related work without depending on Records' SQL layout.
test("matchingInputs returns only completed computations matching an operation and all named inputs", async () => {
  const location = freshLocation();
  const result = await withStores(
    location,
    Effect.gen(function* () {
      const store = yield* Computations.ComputationStore;
      yield* store.run(
        {
          op: "test.related",
          opVersion: 1,
          inputs: { map: "wanted", batch: "b1" },
        },
        Effect.succeed(encode("one")),
      );
      yield* store.run(
        {
          op: "test.related",
          opVersion: 1,
          inputs: { map: "other", batch: "b2" },
        },
        Effect.succeed(encode("two")),
      );
      yield* store.run(
        {
          op: "test.partial",
          opVersion: 1,
          inputs: { run: "current", agent: "p1" },
        },
        Effect.succeed(encode("partial")),
      );
      yield* Effect.result(
        store.run(
          {
            op: "test.related",
            opVersion: 1,
            inputs: { map: "wanted", batch: "failed" },
          },
          Effect.fail(new Flaky({ message: "no output" })),
        ),
      );
      return {
        matched: (yield* Computations.matchingInputs([
          { op: "test.related", inputs: { map: "wanted", batch: "b1" } },
          { op: "test.partial", inputs: { run: "current" } },
        ])).map((row) => row.inputs),
        empty: yield* Computations.matchingInputs([]),
      };
    }),
  );
  expect(result.matched).toContainEqual({ map: "wanted", batch: "b1" });
  expect(result.matched).toContainEqual({ run: "current", agent: "p1" });
  expect(result.matched).toHaveLength(2);
  expect(result.empty).toEqual([]);
});

// The operation filter must use an index as the immutable store grows.
test("computation matching uses the operation index", async () => {
  const rows = await runOn(
    freshLocation(),
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      return yield* sql<{
        detail: string;
      }>`EXPLAIN QUERY PLAN SELECT key FROM computations WHERE op = ${"harness.investigate"}`;
    }),
  );
  expect(
    rows.some((row) => /USING INDEX computations_op/.test(row.detail)),
  ).toBe(true);
});

// Why: a success acknowledges both the durable output and its permanent binding. A failure at
// the last write must roll back both, while the already-committed attempt start remains recoverable.
test("a computation success commits its blob and binding together or leaves neither", async () => {
  const location = freshLocation();
  const result = await withStores(
    location,
    Effect.gen(function* () {
      const store = yield* Computations.ComputationStore;
      const sql = yield* SqlClient;
      const attempt = yield* store.start(spec);
      yield* sql`CREATE TRIGGER reject_success BEFORE UPDATE ON computation_attempts
      WHEN NEW.outcome = 'succeeded' BEGIN SELECT RAISE(ABORT, 'injected failure'); END`;
      const failed = yield* Effect.result(
        store.succeed(attempt, encode("atomic output")),
      );
      const afterFailure = yield* sql`SELECT
      (SELECT count(*) FROM blobs) AS blobs,
      (SELECT count(*) FROM computations) AS computations,
      (SELECT outcome FROM computation_attempts) AS outcome`;
      yield* sql`DROP TRIGGER reject_success`;
      yield* store.succeed(attempt, encode("atomic output"));
      const afterSuccess = yield* sql`SELECT
      (SELECT count(*) FROM blobs) AS blobs,
      (SELECT count(*) FROM computations) AS computations,
      (SELECT outcome FROM computation_attempts) AS outcome`;
      return { failed: failed._tag, afterFailure, afterSuccess };
    }),
  );
  expect(result).toEqual({
    failed: "Failure",
    afterFailure: [{ blobs: 0, computations: 0, outcome: "running" }],
    afterSuccess: [{ blobs: 1, computations: 1, outcome: "succeeded" }],
  });
});
