// Why (design `records-evictable-outputs`): eviction deletes stored outputs, so each of its rules
// fails silently if wrong. Taking the newest instead of the oldest, going past the cap, leaving a
// row, attempt, blob, file or mark behind, taking the bytes another key still names, taking an
// output a caller was just told about, or answering a reader with corruption instead of a miss,
// all still read as a working store. These pin each, with the rerun under shared work (record
// 0016), an interrupted removal finished by the next pass with fsck clean throughout, the stats by
// kind, and the two places eviction runs: after a store, and in the daily retention job.
import { afterAll, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import {
  Admin,
  Blobs,
  Computations,
  Retention,
  type StoreLocation,
} from "../src/index.ts";
import { AFTER_STORE_LIMIT, evict } from "../src/evictable.ts";
import {
  FILE_SIZE,
  MINUTE,
  OP,
  OTHER,
  bytesOf,
  count,
  deletesStopped,
  eventNaming,
  outputOf,
  shifted,
  specOf,
  withStores,
} from "./evict-support.ts";
import { freshLocation, removeTemporaryDirectories } from "./support.ts";

afterAll(removeTemporaryDirectories);

const ago = (minutes: number) => shifted(-minutes * MINUTE);

const runAgo = (minutes: number, op: string, label: string, bytes = label) =>
  Effect.flatMap(Computations.ComputationStore, (store) =>
    ago(minutes)(store.run(specOf(op, label), outputOf(bytes))),
  );

const traces = (key: string, hash: string, location: StoreLocation) =>
  Effect.all({
    computation: count("SELECT count(*) AS n FROM computations WHERE key = ?", [
      key,
    ]),
    attempts: count(
      "SELECT count(*) AS n FROM computation_attempts WHERE key = ?",
      [key],
    ),
    blob: count("SELECT count(*) AS n FROM blobs WHERE hash = ?", [hash]),
    file: Effect.sync(() => existsSync(Blobs.blobPath(location, hash))),
  });

const marks = count("SELECT count(*) AS n FROM blob_removals");

const failed = (checks: ReadonlyArray<Admin.FsckCheck>) =>
  checks.filter((check) => check.status !== "ok").map((check) => check.name);

test("over the cap the oldest stored go first, the pass stops at the cap, every trace goes, and nothing stored in the last 15 minutes is taken", async () => {
  const location = freshLocation();
  const result = await withStores(
    location,
    Effect.gen(function* () {
      const store = yield* Computations.ComputationStore;
      yield* store.declareKind({ op: OP, capBytes: 1_000_000_000 });
      const a = yield* runAgo(60, OP, "a");
      const b = yield* runAgo(50, OP, "b");
      const c = yield* runAgo(40, OP, "c");
      const d = yield* runAgo(5, OP, "d");
      yield* store.declareKind({ op: OP, capBytes: 2 * FILE_SIZE + 10 });
      const first = yield* store.evict({ op: OP });
      const gone = {
        a: yield* traces(a.computation.key, a.computation.outputHash, location),
        b: yield* traces(b.computation.key, b.computation.outputHash, location),
        c: yield* traces(c.computation.key, c.computation.outputHash, location),
      };
      const marksAfter = yield* marks;
      yield* store.declareKind({ op: OP, capBytes: 0 });
      const second = yield* store.evict({ op: OP });
      const left = (yield* SqlClient)<{
        key: string;
      }>`SELECT key FROM computations WHERE op = ${OP}`;
      return {
        first,
        gone,
        marksAfter,
        second,
        left: (yield* left).map((row) => row.key),
        d: d.computation.key,
        checks: yield* Admin.fsck(location),
      };
    }),
  );
  expect(result.first).toMatchObject({
    declared: true,
    storedBytes: 4 * FILE_SIZE,
    remainingBytes: 2 * FILE_SIZE,
    outputs: 2,
    blobs: 2,
    bytes: 2 * FILE_SIZE,
    refused: 0,
    removed: 2,
    removalFailures: 0,
  });
  const none = { computation: 0, attempts: 0, blob: 0, file: false };
  expect(result.gone.a).toEqual(none);
  expect(result.gone.b).toEqual(none);
  expect(result.gone.c).toEqual({
    computation: 1,
    attempts: 1,
    blob: 1,
    file: true,
  });
  expect(result.marksAfter).toBe(0);
  // Over a cap of zero, the output stored 5 minutes ago stays.
  expect(result.second).toMatchObject({
    outputs: 1,
    remainingBytes: FILE_SIZE,
  });
  expect(result.left).toEqual([result.d]);
  expect(failed(result.checks)).toEqual([]);
}, 60_000);

test("a second key with identical bytes keeps the blob until it goes too, and an undeclared kind's row keeps it for good", async () => {
  const location = freshLocation();
  const result = await withStores(
    location,
    Effect.gen(function* () {
      const store = yield* Computations.ComputationStore;
      yield* store.declareKind({ op: OP, capBytes: 1_000_000_000 });
      const k1 = yield* runAgo(60, OP, "k1", "X");
      const k3 = yield* runAgo(55, OP, "k3", "Y");
      const k4 = yield* runAgo(50, OP, "k4", "W");
      const k2 = yield* runAgo(45, OP, "k2", "X");
      const other = yield* runAgo(40, OTHER, "o", "W");
      const x = k1.computation.outputHash;
      const w = k4.computation.outputHash;
      yield* store.declareKind({ op: OP, capBytes: 2 * FILE_SIZE + 10 });
      const first = yield* store.evict({ op: OP });
      const afterFirst = {
        k1: yield* traces(k1.computation.key, x, location),
        k3: yield* traces(
          k3.computation.key,
          k3.computation.outputHash,
          location,
        ),
        k2: (yield* store.run(specOf(OP, "k2"), Effect.die("must not compute")))
          .status,
      };
      yield* store.declareKind({ op: OP, capBytes: 0 });
      const second = yield* store.evict({ op: OP });
      return {
        sameBytes: k2.computation.outputHash === x,
        first,
        afterFirst,
        second,
        x: yield* traces(k2.computation.key, x, location),
        w: yield* traces(k4.computation.key, w, location),
        other: (yield* store.run(
          specOf(OTHER, "o"),
          Effect.die("must not compute"),
        )).output,
        otherBytes: other.output,
        marks: yield* marks,
        checks: yield* Admin.fsck(location),
      };
    }),
  );
  expect(result.sameBytes).toBe(true);
  // k1 freed nothing (k2 names X); k3 freed Y and brought the kind to its cap.
  expect(result.first).toMatchObject({
    storedBytes: 3 * FILE_SIZE,
    remainingBytes: 2 * FILE_SIZE,
    outputs: 2,
    blobs: 1,
  });
  expect(result.afterFirst).toEqual({
    k1: { computation: 0, attempts: 0, blob: 1, file: true },
    k3: { computation: 0, attempts: 0, blob: 0, file: false },
    k2: "reused",
  });
  // k4 and k2 go; X goes with k2, its last referrer; W stays, named by the undeclared kind.
  expect(result.second).toMatchObject({
    outputs: 2,
    blobs: 1,
    bytes: FILE_SIZE,
  });
  expect(result.x).toEqual({
    computation: 0,
    attempts: 0,
    blob: 0,
    file: false,
  });
  expect(result.w).toEqual({
    computation: 0,
    attempts: 0,
    blob: 1,
    file: true,
  });
  expect(result.other).toEqual(result.otherBytes);
  expect(result.marks).toBe(0);
  expect(failed(result.checks)).toEqual([]);
}, 60_000);

test("after eviction a run of the same key computes again as attempt 1, and a caller that subscribes gets the new output", async () => {
  const location = freshLocation();
  const result = await withStores(
    location,
    Effect.gen(function* () {
      const store = yield* Computations.ComputationStore;
      const spec = specOf(OP, "again");
      const before = yield* runAgo(30, OP, "again", "first");
      yield* store.declareKind({ op: OP, capBytes: 0 });
      const evicted = yield* store.evict({ op: OP });
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const holder = yield* Effect.forkChild(
        store.run(
          spec,
          Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
            return { bytes: bytesOf("second"), mediaType: "text/plain" };
          }),
        ),
      );
      yield* Deferred.await(started);
      const subscriber = yield* Effect.forkChild(
        store.run(spec, Effect.die("a subscriber must not compute")),
      );
      // The subscriber finds no stored output and joins the holder's run before it is released.
      yield* Effect.sleep("200 millis");
      yield* Deferred.succeed(release, undefined);
      const computed = yield* Fiber.join(holder);
      const shared = yield* Fiber.join(subscriber);
      const attempts = yield* (yield* SqlClient)<{
        n: number;
        outcome: string;
      }>`SELECT n, outcome FROM computation_attempts WHERE key = ${before.computation.key}`;
      return { before, evicted, computed, shared, attempts };
    }),
  );
  expect(result.evicted.outputs).toBe(1);
  expect(result.computed.status).toBe("computed");
  expect(result.computed.computation.key).toBe(result.before.computation.key);
  expect(result.computed.computation.attemptId).not.toBe(
    result.before.computation.attemptId,
  );
  expect(new TextDecoder().decode(result.computed.output).slice(0, 6)).toBe(
    "second",
  );
  expect(result.shared.status).toBe("shared");
  expect(result.shared.output).toEqual(result.computed.output);
  expect(result.attempts).toEqual([{ n: 1, outcome: "succeeded" }]);
}, 60_000);

test("a removal interrupted after the eviction's commit is finished by the next pass, a new store of the bytes keeps them, and fsck passes throughout", async () => {
  const location = freshLocation();
  const stored = await withStores(
    location,
    Effect.gen(function* () {
      const store = yield* Computations.ComputationStore;
      const old = yield* runAgo(30, OP, "old");
      const kept = yield* runAgo(30, OP, "kept");
      yield* store.declareKind({ op: OP, capBytes: 0 });
      return {
        old: old.computation,
        kept: kept.computation,
        checks: yield* Admin.fsck(location),
      };
    }),
  );
  const stopped = await withStores(
    location,
    Effect.gen(function* () {
      const store = yield* Computations.ComputationStore;
      return {
        report: yield* store.evict({ op: OP }),
        marks: yield* marks,
        old: yield* traces(stored.old.key, stored.old.outputHash, location),
        checks: yield* Admin.fsck(location),
      };
    }),
    deletesStopped(location),
  );
  // The same bytes stored again while the removal of `kept` is pending, its file still there: the
  // new row cancels that removal. Deletes still stop, so `old`'s removal stays pending.
  const restored = await withStores(
    location,
    Effect.gen(function* () {
      const store = yield* Computations.ComputationStore;
      const again = yield* store.run(specOf(OP, "kept"), outputOf("kept"));
      return { status: again.status, marks: yield* marks };
    }),
    deletesStopped(location),
  );
  const finished = await withStores(
    location,
    Effect.gen(function* () {
      const store = yield* Computations.ComputationStore;
      return {
        report: yield* store.evict({ op: OP }),
        marks: yield* marks,
        old: yield* traces(stored.old.key, stored.old.outputHash, location),
        kept: yield* traces(stored.kept.key, stored.kept.outputHash, location),
        read: (yield* store.run(
          specOf(OP, "kept"),
          Effect.die("must not compute"),
        )).status,
        checks: yield* Admin.fsck(location),
      };
    }),
  );
  expect(failed(stored.checks)).toEqual([]);
  expect(stopped.report).toMatchObject({
    outputs: 2,
    blobs: 2,
    removed: 0,
    removalFailures: 2,
  });
  expect(stopped.marks).toBe(2);
  expect(stopped.old).toEqual({
    computation: 0,
    attempts: 0,
    blob: 0,
    file: true,
  });
  expect(failed(stopped.checks)).toEqual([]);
  expect(
    stopped.checks.find(
      (c) => c.name === "blob files exist and hash to their names",
    )?.detail,
  ).toContain(
    "2 file(s) of evicted outputs whose removal was interrupted, which the next eviction removes",
  );
  expect(restored).toEqual({ status: "computed", marks: 1 });
  expect(finished.report).toMatchObject({ outputs: 0, removed: 1 });
  expect(finished.marks).toBe(0);
  expect(finished.old).toEqual({
    computation: 0,
    attempts: 0,
    blob: 0,
    file: false,
  });
  expect(finished.kept).toEqual({
    computation: 1,
    attempts: 1,
    blob: 1,
    file: true,
  });
  expect(finished.read).toBe("reused");
  expect(failed(finished.checks)).toEqual([]);
}, 60_000);

/** The blob store, running `before.next` (once) ahead of a read, as an eviction racing it would. */
const racing = (
  location: StoreLocation,
  before: {
    next?:
      Effect.Effect<void, unknown, SqlClient | Blobs.BlobStore> | undefined;
  },
) =>
  Layer.effect(
    Blobs.BlobStore,
    Effect.gen(function* () {
      const blobs = yield* Blobs.BlobStore;
      const sql = yield* SqlClient;
      const hook = Effect.suspend(() => {
        const next = before.next;
        before.next = undefined;
        return next === undefined
          ? Effect.void
          : next.pipe(
              Effect.provideService(Blobs.BlobStore, blobs),
              Effect.provideService(SqlClient, sql),
              Effect.orDie,
            );
      });
      return Blobs.BlobStore.of({
        ...blobs,
        get: (hash) => Effect.andThen(hook, blobs.get(hash)),
      });
    }),
  ).pipe(Layer.provide(Blobs.layer(location)));

test("a reader holding the row when its blob is evicted gets a miss and computes; an undeclared kind's missing bytes are still an error", async () => {
  const location = freshLocation();
  const before: {
    next?:
      Effect.Effect<void, unknown, SqlClient | Blobs.BlobStore> | undefined;
  } = {};
  const result = await withStores(
    location,
    Effect.gen(function* () {
      const store = yield* Computations.ComputationStore;
      const old = yield* runAgo(30, OP, "raced", "first");
      const durable = yield* runAgo(30, OTHER, "raced", "durable");
      yield* store.declareKind({ op: OP, capBytes: 0 });
      // Between this run's row read and its blob read, the eviction commits and removes the file.
      before.next = Effect.asVoid(evict(OP));
      const raced = yield* store.run(specOf(OP, "raced"), outputOf("second"));
      // An undeclared kind's file gone under its row: what it read as before this change.
      before.next = Effect.sync(() =>
        rmSync(Blobs.blobPath(location, durable.computation.outputHash)),
      );
      const corrupt = yield* Effect.flip(
        store.run(specOf(OTHER, "raced"), Effect.die("must not compute")),
      );
      return { old, raced, corrupt: corrupt._tag };
    }),
    racing(location, before),
  );
  expect(result.raced.status).toBe("computed");
  expect(result.raced.computation.attemptId).not.toBe(
    result.old.computation.attemptId,
  );
  expect(new TextDecoder().decode(result.raced.output).slice(0, 6)).toBe(
    "second",
  );
  expect(result.corrupt).toBe("BlobCorrupt");
}, 60_000);

test("stats count each kind's outputs, its bytes once per blob, the evictable share, the cap, and the oldest and newest stored", async () => {
  const location = freshLocation();
  const stats = await withStores(
    location,
    Effect.gen(function* () {
      const store = yield* Computations.ComputationStore;
      yield* store.declareKind({ op: OP, capBytes: 1_000_000_000 });
      yield* runAgo(60, OP, "k1", "X");
      yield* runAgo(50, OP, "k2", "X");
      yield* runAgo(40, OP, "k3", "Y");
      yield* ago(30)(
        store.run(
          specOf(OP, "modelled"),
          Effect.succeed({ ...(yield* outputOf("M")), model: "a-model" }),
        ),
      );
      const named = yield* runAgo(20, OP, "named", "N");
      yield* eventNaming(`computation:${named.computation.key}`);
      yield* runAgo(10, OTHER, "o", "O");
      return yield* Admin.stats(location);
    }),
  );
  const at = (row: { oldestStoredAt: string | null }) => row.oldestStoredAt;
  expect(stats.store.computations.kinds.map((kind) => kind.op)).toEqual([
    OP,
    OTHER,
  ]);
  const [ours, other] = stats.store.computations.kinds;
  expect(ours).toMatchObject({
    outputs: 5,
    bytes: 4 * FILE_SIZE,
    evictable: { outputs: 3, bytes: 2 * FILE_SIZE },
    capBytes: 1_000_000_000,
  });
  expect(at(ours!)! < ours!.newestStoredAt!).toBe(true);
  expect(other).toMatchObject({
    outputs: 1,
    bytes: FILE_SIZE,
    evictable: { outputs: 0, bytes: 0 },
    capBytes: null,
  });
  expect(other!.oldestStoredAt).toBe(other!.newestStoredAt);
  expect(stats.store.computations.pendingRemovals).toBe(0);
  expect(stats.undeclaredTables).toEqual([]);
}, 60_000);

test("storing an output of a declared kind brings it back under its cap, and the daily retention job evicts every declared kind", async () => {
  const location = freshLocation();
  const result = await withStores(
    location,
    Effect.gen(function* () {
      const store = yield* Computations.ComputationStore;
      yield* store.declareKind({ op: OP, capBytes: FILE_SIZE + 10 });
      const old = yield* runAgo(60, OP, "old");
      const durable = yield* runAgo(60, OTHER, "durable");
      // Over the cap with `old`; storing `new` evicts it, after the binding.
      yield* store.run(specOf(OP, "new"), outputOf("new"));
      const afterStore = yield* Effect.all({
        old: count("SELECT count(*) AS n FROM computations WHERE key = ?", [
          old.computation.key,
        ]),
        ours: count("SELECT count(*) AS n FROM computations WHERE op = ?", [
          OP,
        ]),
        other: count("SELECT count(*) AS n FROM computations WHERE key = ?", [
          durable.computation.key,
        ]),
      });
      // A day later, the retention job takes what is now past the cap.
      yield* store.declareKind({ op: OP, capBytes: 0 });
      yield* shifted(24 * 60 * MINUTE)(Retention.pruneJob(undefined));
      const afterJob = yield* Effect.all({
        ours: count("SELECT count(*) AS n FROM computations WHERE op = ?", [
          OP,
        ]),
        other: count("SELECT count(*) AS n FROM computations WHERE op = ?", [
          OTHER,
        ]),
      });
      return { afterStore, afterJob };
    }),
  );
  expect(result.afterStore).toEqual({ old: 0, ours: 1, other: 1 });
  expect(result.afterJob).toEqual({ ours: 0, other: 1 });
}, 60_000);

test("an output an event names, or a model produced, is skipped and the pass goes on; a blob an event names stays when its row goes", async () => {
  const location = freshLocation();
  const result = await withStores(
    location,
    Effect.gen(function* () {
      const store = yield* Computations.ComputationStore;
      yield* store.declareKind({ op: OP, capBytes: 1_000_000_000 });
      const named = yield* runAgo(60, OP, "named");
      yield* eventNaming(`computation:${named.computation.key}`);
      const modelled = yield* ago(55)(
        store.run(
          specOf(OP, "modelled"),
          Effect.succeed({
            ...(yield* outputOf("modelled")),
            model: "a-model",
          }),
        ),
      );
      const cited = yield* runAgo(50, OP, "cited");
      yield* eventNaming(`blob:${cited.computation.outputHash}`);
      const plain = yield* runAgo(45, OP, "plain");
      yield* store.declareKind({ op: OP, capBytes: 0 });
      const report = yield* store.evict({ op: OP });
      return {
        report,
        named: yield* traces(
          named.computation.key,
          named.computation.outputHash,
          location,
        ),
        modelled: yield* traces(
          modelled.computation.key,
          modelled.computation.outputHash,
          location,
        ),
        cited: yield* traces(
          cited.computation.key,
          cited.computation.outputHash,
          location,
        ),
        plain: yield* traces(
          plain.computation.key,
          plain.computation.outputHash,
          location,
        ),
        marks: yield* marks,
      };
    }),
  );
  expect(result.report).toMatchObject({
    outputs: 2,
    blobs: 1,
    refused: 2,
    remainingBytes: 2 * FILE_SIZE,
  });
  const kept = { computation: 1, attempts: 1, blob: 1, file: true };
  expect(result.named).toEqual(kept);
  expect(result.modelled).toEqual(kept);
  expect(result.cited).toEqual({
    computation: 0,
    attempts: 0,
    blob: 1,
    file: true,
  });
  expect(result.plain).toEqual({
    computation: 0,
    attempts: 0,
    blob: 0,
    file: false,
  });
  expect(result.marks).toBe(0);
}, 60_000);

test("the pass after a store evicts at most its bound, so a backlog shrinks by that much a store, and the daily job clears the rest", async () => {
  const location = freshLocation();
  const result = await withStores(
    location,
    Effect.gen(function* () {
      const store = yield* Computations.ComputationStore;
      yield* store.declareKind({ op: OP, capBytes: 1_000_000_000 });
      for (let index = 0; index < 10; index++)
        yield* runAgo(60 - index, OP, `old-${index}`);
      yield* store.declareKind({ op: OP, capBytes: FILE_SIZE + 10 });
      const old = count(
        "SELECT count(*) AS n FROM computations WHERE op = ? AND material LIKE '%old-%'",
        [OP],
      );
      const backlog = yield* old;
      yield* store.run(specOf(OP, "new-1"), outputOf("new-1"));
      const afterFirst = yield* old;
      yield* store.run(specOf(OP, "new-2"), outputOf("new-2"));
      const afterSecond = yield* old;
      yield* Retention.pruneJob(undefined);
      return {
        backlog,
        afterFirst,
        afterSecond,
        afterJob: yield* old,
        fresh: yield* count(
          "SELECT count(*) AS n FROM computations WHERE op = ? AND material LIKE '%new-%'",
          [OP],
        ),
      };
    }),
  );
  expect(AFTER_STORE_LIMIT).toBe(4);
  expect(result).toEqual({
    backlog: 10,
    afterFirst: 6,
    afterSecond: 2,
    afterJob: 0,
    // Both stored in the last 15 minutes: over the cap, and kept.
    fresh: 2,
  });
}, 60_000);
