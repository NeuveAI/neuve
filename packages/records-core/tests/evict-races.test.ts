// Why (design `records-evictable-outputs`, records review 10): eviction removes files after its
// commits and works through a page of candidates read before them, so three interleavings decide
// whether it ever takes what it must not. A row the pass selected, evicted and computed again by
// another process before the pass reaches it, is a fresh output: the 15-minute rule keeps it. A
// put of bytes whose removal is pending must store them where no removal can run in between, or
// its new row lacks its file. A mark left beside a live blob must lose the mark, never the file.
// Each uses a real second connection to the store, paused or interleaved without sleeping.
import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, rmSync } from "node:fs";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import {
  Blobs,
  ByteStorage,
  Computations,
  type StoreLocation,
} from "../src/index.ts";
import {
  FILE_SIZE,
  MINUTE,
  OP,
  bytesOf,
  count,
  deletesStopped,
  outputOf,
  shifted,
  specOf,
  withStores,
} from "./evict-support.ts";
import { freshLocation, removeTemporaryDirectories } from "./support.ts";

afterAll(removeTemporaryDirectories);

const marks = count("SELECT count(*) AS n FROM blob_removals");

/** The blob store, pausing the pass at its first file removal after a commit until `resume`. */
const pausing = (
  location: StoreLocation,
  gate: {
    readonly paused: PromiseWithResolvers<void>;
    readonly resume: PromiseWithResolvers<void>;
  },
) =>
  Layer.effect(
    Blobs.BlobStore,
    Effect.gen(function* () {
      const blobs = yield* Blobs.BlobStore;
      let paused = false;
      return Blobs.BlobStore.of({
        ...blobs,
        removeEvicted: (hashes) =>
          hashes === undefined || paused
            ? blobs.removeEvicted(hashes)
            : Effect.andThen(
                Effect.promise(async () => {
                  paused = true;
                  gate.paused.resolve();
                  await gate.resume.promise;
                }),
                blobs.removeEvicted(hashes),
              ),
      });
    }),
  ).pipe(Layer.provide(Blobs.layer(location)));

test("a selected row that another process evicts and a caller computes again before the pass reaches it survives the pass", async () => {
  const location = freshLocation();
  const before = await withStores(
    location,
    Effect.gen(function* () {
      const store = yield* Computations.ComputationStore;
      const keys: Record<string, Computations.Computation> = {};
      for (const [index, label] of ["k1", "k2", "k3", "k4", "k5"].entries())
        keys[label] = (yield* shifted((index - 60) * MINUTE)(
          store.run(specOf(OP, label), outputOf(label)),
        )).computation;
      yield* store.declareKind({ op: OP, capBytes: 3 * FILE_SIZE + 10 });
      return keys;
    }),
  );
  const gate = {
    paused: Promise.withResolvers<void>(),
    resume: Promise.withResolvers<void>(),
  };
  // The first pass reads its page (k1 to k5), evicts k1 and stops before removing k1's file.
  const first = withStores(
    location,
    Effect.flatMap(Computations.ComputationStore, (store) =>
      store.evict({ op: OP }),
    ),
    pausing(location, gate),
  );
  await gate.paused.promise;
  // Meanwhile, on its own connection: another pass takes k2, and a caller computes k2 again. Its
  // store is over the cap again, so its own pass after the store takes k3.
  const other = await withStores(
    location,
    Effect.gen(function* () {
      const store = yield* Computations.ComputationStore;
      const report = yield* store.evict({ op: OP });
      const again = yield* store.run(specOf(OP, "k2"), outputOf("k2 again"));
      return { report, again: again.computation, status: again.status };
    }),
  );
  gate.resume.resolve();
  const resumed = await first;
  const after = await withStores(
    location,
    Effect.flatMap(Computations.ComputationStore, (store) =>
      store.lookupMany(
        ["k1", "k2", "k3", "k4", "k5"].map((label) => before[label]!.key),
      ),
    ),
  );
  expect(other.report.outputs).toBe(1);
  expect(other.status).toBe("computed");
  // The first pass took only k1: k2 is no longer the row it selected, and k3 was already gone.
  expect(resumed.outputs).toBe(1);
  expect(after.get(before["k2"]!.key)?.attemptId).toBe(other.again.attemptId);
  expect(after.has(before["k1"]!.key)).toBe(false);
  expect(after.has(before["k3"]!.key)).toBe(false);
  expect(after.has(before["k4"]!.key)).toBe(true);
  expect(after.has(before["k5"]!.key)).toBe(true);
}, 60_000);

/**
 * Local byte storage that, right after it stores an object the first time, runs a removal pass
 * on a second connection, as another process's eviction would: only when that connection can take
 * the write lock at once, since no pass can run while the put holds it.
 */
const removalAfterStore = (location: StoreLocation, ran: { value: boolean }) =>
  Blobs.layerOnStorage(location).pipe(
    Layer.provide(
      Layer.effect(
        ByteStorage.ByteStorage,
        Effect.gen(function* () {
          const local = yield* ByteStorage.ByteStorage;
          let once = false;
          return ByteStorage.ByteStorage.of({
            ...local,
            put: (object) =>
              Effect.andThen(
                local.put(object),
                Effect.sync(() => {
                  if (once) return;
                  once = true;
                  const other = new Database(location.database);
                  try {
                    other.exec("PRAGMA busy_timeout = 0");
                    try {
                      other.exec("BEGIN IMMEDIATE");
                    } catch {
                      return;
                    }
                    const marked = other
                      .query("SELECT 1 FROM blob_removals WHERE hash = ?")
                      .get(object.hash);
                    const row = other
                      .query("SELECT 1 FROM blobs WHERE hash = ?")
                      .get(object.hash);
                    if (marked !== null && row === null) {
                      rmSync(Blobs.blobPath(location, object.hash));
                      other
                        .query("DELETE FROM blob_removals WHERE hash = ?")
                        .run(object.hash);
                      ran.value = true;
                    }
                    other.exec("COMMIT");
                  } finally {
                    other.close();
                  }
                }),
              ),
          });
        }),
      ).pipe(Layer.provide(ByteStorage.localFileSystem(location))),
    ),
  );

test("a put of bytes whose removal is pending stores them under its lock, so a removal cannot take them before its row commits", async () => {
  const location = freshLocation();
  const hash = await withStores(
    location,
    Effect.gen(function* () {
      const store = yield* Computations.ComputationStore;
      const old = yield* shifted(-60 * MINUTE)(
        store.run(specOf(OP, "pending"), outputOf("pending")),
      );
      yield* store.declareKind({ op: OP, capBytes: 0 });
      return old.computation.outputHash;
    }),
  );
  // Evicted with its file removal stopped: the mark is pending and the file still there.
  await withStores(
    location,
    Effect.flatMap(Computations.ComputationStore, (store) =>
      store.evict({ op: OP }),
    ),
    deletesStopped(location),
  );
  const ran = { value: false };
  const result = await withStores(
    location,
    Effect.gen(function* () {
      const blobs = yield* Blobs.BlobStore;
      const marked = yield* marks;
      const put = yield* blobs.put({
        bytes: bytesOf("pending"),
        mediaType: "text/plain",
        retention: "durable",
      });
      const read = yield* Effect.result(blobs.get(hash));
      return {
        marked,
        status: put.status,
        read: read._tag === "Success" ? read.success._tag : read.failure._tag,
        marks: yield* marks,
      };
    }),
    removalAfterStore(location, ran),
  );
  expect(result).toEqual({
    marked: 1,
    status: "stored",
    read: "Present",
    marks: 0,
  });
  expect(ran.value).toBe(false);
  expect(existsSync(Blobs.blobPath(location, hash))).toBe(true);
}, 60_000);

test("a mark left beside a blob whose row is back loses the mark, never the file", async () => {
  const location = freshLocation();
  const result = await withStores(
    location,
    Effect.gen(function* () {
      const store = yield* Computations.ComputationStore;
      const blobs = yield* Blobs.BlobStore;
      const sql = yield* SqlClient;
      yield* store.declareKind({ op: OP, capBytes: 1_000_000_000 });
      const live = yield* store.run(specOf(OP, "live"), outputOf("live"));
      const hash = live.computation.outputHash;
      yield* sql`INSERT INTO blob_removals (hash, at) VALUES (${hash}, '2026-11-13T00:00:00.000Z')`;
      const removed = yield* blobs.removeEvicted();
      return {
        removed,
        marks: yield* marks,
        file: existsSync(Blobs.blobPath(location, hash)),
        read: (yield* store.run(
          specOf(OP, "live"),
          Effect.die("must not compute"),
        )).status,
      };
    }),
  );
  expect(result).toEqual({
    removed: 0,
    marks: 0,
    file: true,
    read: "reused",
  });
}, 60_000);
