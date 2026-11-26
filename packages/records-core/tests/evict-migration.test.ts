// Why (decisions 12.24, 12.56): migration 20 changes triggers on three tables of every shared store,
// and the store is shared with builds that do not know it. A store at version 19 holding outputs
// must come through it with every row, file and binding it held, backed up first. A build that does
// not know the migration must keep reading and writing there: as `newer-build.test.ts` does, this
// build stands in for it by finding the store ahead of its own schema (compatibility mode), and the
// statements it runs to compute, reuse, fail, capture and prune are the same ones the older build
// runs. Its writes must pass the new triggers, and its blob insert must cancel a pending removal of
// the same bytes, which is what keeps an evicted output's re-stored file from being removed.
import { afterAll, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { Data, Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import {
  Admin,
  Blobs,
  Computations,
  Retention,
  SCHEMA_VERSION,
  Store,
  type StoreLocation,
} from "../src/index.ts";
import {
  MINUTE,
  OP,
  OTHER,
  bytesOf,
  count,
  deletesStopped,
  outputOf,
  shifted,
  specOf,
  withStores,
} from "./evict-support.ts";
import {
  freshLocation,
  removeTemporaryDirectories,
  runExisting,
  runOn,
} from "./support.ts";

afterAll(removeTemporaryDirectories);

class Refused extends Data.TaggedError("Refused")<{
  readonly message: string;
}> {}

const exec = (statement: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    return yield* sql.unsafe<Record<string, unknown>>(statement);
  });

const BEFORE_20 = [
  `DROP TRIGGER raw_capture_parts_guard`,
  `DROP TABLE raw_capture_parts`,
  `DROP TRIGGER computations_evict_only`,
  `DROP TRIGGER computation_attempts_evict_only`,
  `DROP TRIGGER blobs_evict_only`,
  `DROP TRIGGER blob_removals_evicted_output`,
  `DROP TRIGGER blob_removals_cancel`,
  `DROP INDEX computations_output`,
  `DROP INDEX computation_attempts_output`,
  `DROP INDEX computation_attempts_cause`,
  `DROP TABLE computation_kinds`,
  `DROP TABLE blob_removals`,
  `CREATE TRIGGER blobs_no_delete BEFORE DELETE ON blobs BEGIN SELECT RAISE(ABORT, 'blobs keep their row; pruning sets pruned_at'); END`,
  `CREATE TRIGGER computation_attempts_no_delete BEFORE DELETE ON computation_attempts
    BEGIN SELECT RAISE(ABORT, 'computation_attempts is append-only'); END`,
  `CREATE TRIGGER computations_append_only_delete BEFORE DELETE ON computations BEGIN SELECT RAISE(ABORT, 'computations is append-only'); END`,
  `DELETE FROM records_migrations WHERE migration_id >= 20`,
];

const rows = Effect.all({
  computations: exec(
    `SELECT key, op, output_hash, attempt_id, completed_at FROM computations ORDER BY key`,
  ),
  attempts: exec(
    `SELECT attempt_id, key, n, outcome, output_hash, error_tag FROM computation_attempts ORDER BY attempt_id`,
  ),
  blobs: exec(
    `SELECT hash, size, retention, placement, pruned_at FROM blobs ORDER BY hash`,
  ),
});

const deleteTriggers = exec(
  `SELECT name FROM sqlite_master WHERE type = 'trigger'
    AND tbl_name IN ('computations', 'computation_attempts', 'blobs', 'blob_removals') AND sql LIKE '%DELETE%'
    ORDER BY name`,
);

const schemaVersion = Effect.map(
  exec(`SELECT max(migration_id) AS version FROM records_migrations`),
  (found) => found[0]?.["version"],
);

/** A store with outputs of two kinds, a failed attempt, inline and file blobs and a raw capture. */
const storeWithOutputs = (location: StoreLocation) =>
  withStores(
    location,
    Effect.gen(function* () {
      const store = yield* Computations.ComputationStore;
      const blobs = yield* Blobs.BlobStore;
      yield* shifted(-60 * MINUTE)(
        Effect.gen(function* () {
          yield* store.run(specOf(OP, "file"), outputOf("file"));
          yield* store.run(specOf(OP, "inline"), outputOf("inline", 64));
          yield* Effect.flip(
            store.run(
              specOf(OP, "failed"),
              Effect.fail(new Refused({ message: "fails once" })),
            ),
          );
          yield* store.run(specOf(OTHER, "file"), outputOf("other"));
          yield* blobs.put({
            bytes: bytesOf("raw capture", 64),
            mediaType: "application/jsonl",
            retention: "raw-capture",
          });
        }),
      );
    }),
  );

test("a store at version 19 with outputs migrates with everything it held, backed up first", async () => {
  const location = freshLocation();
  await storeWithOutputs(location);
  const held = await runExisting(location, rows);
  for (const statement of BEFORE_20)
    await runExisting(location, exec(statement));
  const before = await runExisting(
    location,
    Effect.all({ version: schemaVersion, triggers: deleteTriggers }),
  );
  const migrated = await runExisting(location, Store.migrate);
  const after = await runOn(
    location,
    Effect.all({
      version: schemaVersion,
      triggers: deleteTriggers,
      rows,
      checks: Admin.fsck(location),
    }),
  );
  // Everything it held reads back, and the migrated store evicts as declared.
  const used = await withStores(
    location,
    Effect.gen(function* () {
      const store = yield* Computations.ComputationStore;
      const reused = yield* Effect.forEach(["file", "inline"], (label) =>
        Effect.map(
          store.run(specOf(OP, label), Effect.die("must not compute")),
          (result) => result.status,
        ),
      );
      yield* store.declareKind({ op: OP, capBytes: 0 });
      const evicted = yield* store.evict({ op: OP });
      return {
        reused,
        evicted: evicted.outputs,
        other: (yield* store.run(
          specOf(OTHER, "file"),
          Effect.die("must not compute"),
        )).status,
      };
    }),
  );
  expect(before.version).toBe(19);
  expect(before.triggers.map((row) => row["name"])).toEqual([
    "blobs_no_delete",
    "computation_attempts_no_delete",
    "computations_append_only_delete",
  ]);
  expect(migrated).toEqual({
    applied: ["20_evictable_outputs", "21_raw_capture_parts"],
    rebuilt: false,
  });
  expect(readdirSync(`${location.directory}/backups`)).toHaveLength(1);
  expect(after.version).toBe(SCHEMA_VERSION);
  // `blob_removals_cancel` deletes a pending mark when a blob row is inserted again.
  expect(after.triggers.map((row) => row["name"])).toEqual([
    "blob_removals_cancel",
    "blobs_evict_only",
    "computation_attempts_evict_only",
    "computations_evict_only",
  ]);
  expect(after.rows).toEqual(held);
  expect(after.checks.filter((check) => check.status !== "ok")).toEqual([]);
  expect(used).toEqual({
    reused: ["reused", "reused"],
    evicted: 2,
    other: "reused",
  });
}, 60_000);

test("a build behind the store's schema still computes, reuses, fails, captures and prunes there, and its blob insert cancels a pending removal", async () => {
  const location = freshLocation();
  await storeWithOutputs(location);
  // An eviction whose file removal stopped: the mark is pending and the file is still there.
  const pending = await withStores(
    location,
    Effect.gen(function* () {
      const store = yield* Computations.ComputationStore;
      const sql = yield* SqlClient;
      yield* store.declareKind({ op: OP, capBytes: 0 });
      const [row] = yield* sql<{
        outputHash: string;
      }>`SELECT output_hash FROM computations WHERE material LIKE '%"file"%' AND op = ${OP}`;
      yield* store.evict({ op: OP });
      return row!.outputHash;
    }),
    deletesStopped(location),
  );
  // A newer build's migration on top: this build now finds the store ahead of its schema, as a
  // build without migration 20 finds a store at 20.
  await runExisting(
    location,
    exec(
      `INSERT INTO records_migrations (migration_id, name) VALUES (${SCHEMA_VERSION + 1}, 'future')`,
    ),
  );
  const older = await withStores(
    location,
    Effect.gen(function* () {
      const store = yield* Computations.ComputationStore;
      const blobs = yield* Blobs.BlobStore;
      const sql = yield* SqlClient;
      const reused = (yield* store.run(
        specOf(OTHER, "file"),
        Effect.die("must not compute"),
      )).status;
      const computed = (yield* store.run(specOf(OTHER, "new"), outputOf("new")))
        .status;
      const failed = (yield* Effect.flip(
        store.run(
          specOf(OTHER, "fails"),
          Effect.fail(new Refused({ message: "fails" })),
        ),
      ))._tag;
      const captured = (yield* blobs.put({
        bytes: bytesOf("another capture", 64),
        mediaType: "application/jsonl",
        retention: "raw-capture",
      })).status;
      const pruned = (yield* shifted(40 * 24 * 60 * MINUTE)(Retention.prune))
        .pruned.blobs;
      // The older build's put of the evicted bytes: it stores the file ahead and inserts the row
      // with no look at `blob_removals`, which it does not know.
      const marksBefore = yield* count(
        "SELECT count(*) AS n FROM blob_removals",
      );
      yield* sql`INSERT INTO blobs ${sql.insert({
        hash: pending,
        size: bytesOf("file").byteLength,
        media_type: "text/plain",
        retention: "durable",
        placement: "file",
        captured_at: new Date().toISOString(),
        pruned_at: null,
        content: null,
      })}`;
      const marksAfter = yield* count(
        "SELECT count(*) AS n FROM blob_removals",
      );
      return {
        reused,
        computed,
        failed,
        captured,
        pruned,
        marksBefore,
        marksAfter,
        checks: yield* Admin.fsck(location),
      };
    }),
  );
  // The newer build's next pass finds no removal left, so the re-stored file stays.
  const next = await withStores(
    location,
    Effect.gen(function* () {
      const store = yield* Computations.ComputationStore;
      return (yield* store.evict({ op: OP })).removed;
    }),
  );
  expect(older).toMatchObject({
    reused: "reused",
    computed: "computed",
    failed: "Refused",
    captured: "stored",
    pruned: 2,
    marksBefore: 1,
    marksAfter: 0,
  });
  expect(older.checks.filter((check) => check.status !== "ok")).toEqual([]);
  expect(next).toBe(0);
  expect(existsSync(Blobs.blobPath(location, pending))).toBe(true);
}, 60_000);
