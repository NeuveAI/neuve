// Why: the version gate decides whether a build may use a store at all (D2, 12.24). A store whose
// minimum writer is above this build must refuse it and stay untouched. Any other store must open:
// an older one is migrated on open, after a backup copy taken under the write lock, by exactly one
// of several processes opening it together; a newer one is used in compatibility mode. Migrating
// must leave the shared versions at what older builds accept while the changes are additive, and a
// failed backup must leave the store as it was. Opening an existing store must preserve its vacuum
// mode without waiting for a writer. Only real stores and real processes show that.
import {
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { DatabaseSync } from "node:sqlite";
import { afterAll, expect, test } from "bun:test";
import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import {
  Log,
  MIN_WRITER_VERSION,
  PROJECTOR_BASELINE,
  PROJECTOR_VERSION,
  SCHEMA_VERSION,
  Store,
  WRITER_VERSION,
  type StoreLocation,
} from "../src/index.ts";
import {
  commitEvent,
  freshLocation,
  runExisting,
  runOn,
  removeTemporaryDirectories,
} from "./support.ts";

afterAll(removeTemporaryDirectories);

const exec = (statement: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    return yield* sql.unsafe<Record<string, unknown>>(statement);
  });
const setMeta = (key: string, value: number) =>
  exec(`INSERT INTO records_meta (key, value) VALUES ('${key}', ${value})
    ON CONFLICT (key) DO UPDATE SET value = excluded.value`);
const eventCount = Effect.map(
  exec("SELECT count(*) AS n FROM events"),
  (rows) => rows[0]?.["n"],
);
const meta = Effect.map(
  exec("SELECT key, value FROM records_meta ORDER BY key"),
  (rows) => rows,
);
const schemaVersion = Effect.map(
  exec("SELECT max(migration_id) AS v FROM records_migrations"),
  (rows) => rows[0]?.["v"],
);
const failureTag = <A, E extends { _tag: string }>(
  effect: Effect.Effect<A, E, SqlClient>,
) => Effect.map(Effect.flip(effect), (error) => error._tag);

const backupsOf = (location: StoreLocation) => {
  try {
    return readdirSync(Store.backupDirectory(location.database)).sort();
  } catch {
    return [];
  }
};

/** The store as main's build (schema 14, projector 9, writer 13) leaves it. */
const asMainLeftIt = (location: StoreLocation) =>
  runExisting(
    location,
    Effect.gen(function* () {
      yield* exec("DROP TABLE projection_review_origins");
      yield* exec("DELETE FROM records_migrations WHERE migration_id >= 15");
      yield* exec("DELETE FROM records_meta WHERE key = 'projections_version'");
      yield* setMeta("projector_version", 9);
      yield* setMeta("min_writer_version", 13);
    }),
  );

const declared = [
  { key: "min_writer_version", value: MIN_WRITER_VERSION },
  { key: "projections_version", value: PROJECTOR_VERSION },
  { key: "projector_version", value: PROJECTOR_BASELINE },
];

test("a store whose minimum writer is above this build refuses it on open, on write and on migrate", async () => {
  const location = freshLocation();
  await runOn(location, Log.append([commitEvent("1".repeat(40))]));
  await runExisting(
    location,
    setMeta("min_writer_version", WRITER_VERSION + 1),
  );

  const operations: ReadonlyArray<
    Effect.Effect<void, { readonly _tag: string }, SqlClient>
  > = [
    Store.prepareForRead,
    Store.prepareForWrite,
    Effect.asVoid(Store.migrate),
    Effect.asVoid(Log.append([commitEvent("2".repeat(40))])),
  ];
  for (const effect of operations)
    expect(await runExisting(location, failureTag(effect))).toBe(
      "WriterTooOld",
    );
  expect(await runExisting(location, eventCount)).toBe(1);
  expect(backupsOf(location)).toEqual([]);
});

test("a store a newer build left ahead opens in compatibility mode and keeps its versions", async () => {
  const cases = [
    {
      ahead: exec(
        `INSERT INTO records_migrations (migration_id, name) VALUES (${SCHEMA_VERSION + 1}, 'future')`,
      ),
      marked: false,
    },
    {
      ahead: setMeta("projections_version", PROJECTOR_VERSION + 1),
      marked: false,
    },
    // A newer baseline: this build's rows for its own events are not the newer build's, so its
    // appends mark the projections as this build's, for the newer build to rebuild.
    {
      ahead: Effect.andThen(
        setMeta("projector_version", PROJECTOR_VERSION + 1),
        setMeta("projections_version", PROJECTOR_VERSION + 1),
      ),
      marked: true,
    },
  ];
  for (const { ahead, marked } of cases) {
    const location = freshLocation();
    await runOn(location, Log.append([commitEvent("1".repeat(40))]));
    await runExisting(location, ahead);
    const before = await runExisting(location, meta);

    await runExisting(location, Store.prepareForWrite);
    await runExisting(location, Log.append([commitEvent("2".repeat(40))]));
    expect(await runExisting(location, Store.migrate)).toEqual({
      applied: [],
      rebuilt: false,
    });
    expect(await runExisting(location, eventCount)).toBe(2);
    expect(backupsOf(location)).toEqual([]);
    expect(await runExisting(location, meta)).toEqual(
      before.map((row) =>
        marked && row["key"] === "projections_version"
          ? { ...row, value: PROJECTOR_VERSION }
          : row,
      ),
    );
  }
});

test("main's store migrates on open after a backup, and keeps the versions main's gate accepts", async () => {
  const location = freshLocation();
  await runOn(location, Log.append([commitEvent("1".repeat(40))]));
  await asMainLeftIt(location);

  // An operation that skips opening the store is refused until it is migrated.
  expect(
    await runExisting(
      location,
      failureTag(Log.append([commitEvent("2".repeat(40))])),
    ),
  ).toBe("MigrationRequired");

  await runExisting(location, Store.prepareForRead);
  expect(await runExisting(location, schemaVersion)).toBe(SCHEMA_VERSION);
  expect(await runExisting(location, meta)).toEqual([
    { key: "min_writer_version", value: 13 },
    { key: "projections_version", value: PROJECTOR_VERSION },
    { key: "projector_version", value: 9 },
  ]);
  expect(
    await runExisting(
      location,
      exec("SELECT count(*) AS n FROM projection_commits"),
    ),
  ).toEqual([{ n: 1 }]);

  // One copy, owner-only, holding the store as it was before the migration.
  const copies = backupsOf(location);
  expect(copies).toHaveLength(1);
  expect(copies[0]).toMatch(/^records-.*-schema14-projector9\.sqlite$/);
  const directory = Store.backupDirectory(location.database);
  const copy = join(directory, copies[0]!);
  expect(statSync(directory).mode & 0o777).toBe(0o700);
  expect(statSync(copy).mode & 0o777).toBe(0o600);
  const backup = new Database(copy, { readonly: true });
  try {
    expect(
      backup
        .query("SELECT max(migration_id) AS v FROM records_migrations")
        .get(),
    ).toEqual({ v: 14 });
    expect(backup.query("SELECT count(*) AS n FROM events").get()).toEqual({
      n: 1,
    });
  } finally {
    backup.close();
  }

  // Opening it again changes nothing and copies nothing.
  await runExisting(location, Store.prepareForWrite);
  expect(backupsOf(location)).toHaveLength(1);
  await runExisting(location, Log.append([commitEvent("3".repeat(40))]));
  expect(await runExisting(location, eventCount)).toBe(2);
});

// Why: the copy before a migration is taken on a read-only connection, which Apple's SQLite refuses
// for a store with no WAL. The writer's own connection has made one by then, so the copy still works.
test("a store closed with no WAL still takes its copy before migrating", async () => {
  const location = freshLocation();
  await runOn(location, Log.append([commitEvent("1".repeat(40))]));
  await asMainLeftIt(location);
  const settling = new DatabaseSync(location.database);
  settling.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  settling.close();
  rmSync(`${location.database}-wal`, { force: true });
  rmSync(`${location.database}-shm`, { force: true });

  await runExisting(location, Store.prepareForRead);
  expect(await runExisting(location, schemaVersion)).toBe(SCHEMA_VERSION);
  expect(backupsOf(location)).toHaveLength(1);
});

test("a store an earlier build raised for an additive change is brought back to the declared versions", async () => {
  const location = freshLocation();
  await runOn(location, Log.append([commitEvent("1".repeat(40))]));
  // As the transition build before 12.24 left it: writer 15 and projector 10 shared.
  await runExisting(
    location,
    Effect.gen(function* () {
      yield* exec("DELETE FROM records_meta WHERE key = 'projections_version'");
      yield* setMeta("projector_version", 10);
      yield* setMeta("min_writer_version", 15);
    }),
  );

  await runExisting(location, Store.prepareForWrite);
  expect(await runExisting(location, meta)).toEqual(declared);
  // Only three numbers changed: no copy, so the copies taken before real migrations are kept.
  expect(backupsOf(location)).toEqual([]);
});

test("a rebuild alone takes no copy and says nothing", async () => {
  const location = freshLocation();
  await runOn(location, Log.append([commitEvent("1".repeat(40))]));
  await runExisting(location, setMeta("projections_version", 0));
  expect(await runExisting(location, Store.migrate)).toEqual({
    applied: [],
    rebuilt: true,
  });
  expect(backupsOf(location)).toEqual([]);
});

test("only the newest backups are kept", async () => {
  const location = freshLocation();
  await runOn(location, Log.append([commitEvent("1".repeat(40))]));
  for (let round = 0; round < Store.BACKUPS_KEPT + 2; round += 1) {
    await runExisting(
      location,
      exec(
        `DELETE FROM records_migrations WHERE migration_id = ${SCHEMA_VERSION}`,
      ),
    );
    await runExisting(location, Store.prepareForWrite);
    await Bun.sleep(2);
  }
  expect(backupsOf(location)).toHaveLength(Store.BACKUPS_KEPT);
});

test("a process that can only read an older store is told it needs migrating, not SQLite's error", async () => {
  const location = freshLocation();
  await runOn(location, Log.append([commitEvent("1".repeat(40))]));
  await asMainLeftIt(location);
  // Immutable to its owner too, as another owner's store or a read-only mount is.
  Bun.spawnSync(["chflags", "uchg", location.database]);
  try {
    const failure = await runExisting(
      location,
      Effect.flip(Store.prepareForRead),
    );
    expect(failure._tag).toBe("MigrationRequired");
    expect(failure).toMatchObject({
      stored: { schemaVersion: 14, projectorVersion: 9 },
    });
  } finally {
    Bun.spawnSync(["chflags", "nouchg", location.database]);
  }
  expect(await runExisting(location, schemaVersion)).toBe(14);
});

test("a failed backup leaves the store as it was and is reported", async () => {
  const location = freshLocation();
  await runOn(location, Log.append([commitEvent("1".repeat(40))]));
  await asMainLeftIt(location);
  const before = await runExisting(location, meta);
  // A file where the backup folder belongs.
  writeFileSync(Store.backupDirectory(location.database), "not a folder");

  expect(await runExisting(location, failureTag(Store.prepareForWrite))).toBe(
    "BackupFailed",
  );
  expect(await runExisting(location, meta)).toEqual(before);
  expect(await runExisting(location, schemaVersion)).toBe(14);
});

test("several processes opening an old store together: one migrates and backs up, the others wait", async () => {
  const location = freshLocation();
  await runOn(location, Log.append([commitEvent("1".repeat(40))]));
  await asMainLeftIt(location);
  const fixture = join(import.meta.dir, "fixtures/open-store.ts");
  const children = Array.from({ length: 4 }, () =>
    Bun.spawn([process.execPath, fixture, dirname(location.directory)], {
      stdout: "pipe",
      stderr: "pipe",
    }),
  );
  const results = await Promise.all(
    children.map(async (child) => ({
      code: await child.exited,
      stdout: await new Response(child.stdout).text(),
      stderr: await new Response(child.stderr).text(),
    })),
  );
  for (const result of results) {
    expect(result.code).toBe(0);
    // Records' line goes to stderr, never into the command's output.
    expect(result.stdout).toBe("opened\n");
  }
  const said = results.filter((result) =>
    result.stderr.includes(
      `migrated the Records store from schema 14, minimum writer 13, baseline projector 9, projections by projector 9 to schema ${SCHEMA_VERSION}, minimum writer 13, baseline projector 9, projections by projector ${PROJECTOR_VERSION} (rebuilt)`,
    ),
  );
  expect(said).toHaveLength(1);
  expect(backupsOf(location)).toHaveLength(1);
  expect(await runExisting(location, schemaVersion)).toBe(SCHEMA_VERSION);
  expect(await runExisting(location, meta)).toEqual([
    { key: "min_writer_version", value: 13 },
    { key: "projections_version", value: PROJECTOR_VERSION },
    { key: "projector_version", value: 9 },
  ]);
});

test("a store whose initialization was cut short is completed on open", async () => {
  const location = freshLocation();
  await runOn(location, Log.append([commitEvent("5".repeat(40))]));
  await runExisting(location, exec("DELETE FROM records_meta"));
  await runExisting(location, exec("DELETE FROM projection_commits"));

  expect(
    await runExisting(
      location,
      failureTag(Log.append([commitEvent("6".repeat(40))])),
    ),
  ).toBe("MigrationRequired");
  await runExisting(location, Store.prepareForRead);
  expect(await runExisting(location, meta)).toEqual(declared);
  expect(
    await runExisting(
      location,
      exec("SELECT count(*) AS n FROM projection_commits"),
    ),
  ).toEqual([{ n: 1 }]);
  expect(backupsOf(location)[0]).toMatch(/-incomplete\.sqlite$/);
  // Decision 12.24 completed it on open: a migrate after that finds nothing to do.
  expect(await runExisting(location, Store.migrate)).toEqual({
    applied: [],
    rebuilt: false,
  });
});

test("reading an uninitialized database refuses; writing creates it at this build's versions", async () => {
  const location = freshLocation();
  mkdirSync(location.directory, { recursive: true, mode: 0o700 });
  writeFileSync(location.database, new Uint8Array(0), { mode: 0o600 });

  expect(await runExisting(location, failureTag(Store.prepareForRead))).toBe(
    "StoreNotInitialized",
  );
  await runExisting(location, Store.prepareForWrite);
  expect(await runExisting(location, meta)).toEqual(declared);
  expect(backupsOf(location)).toEqual([]);
});

test("new stores use incremental vacuum and reopening preserves the mode without waiting for a writer", async () => {
  const location = freshLocation();
  const autoVacuum = exec("PRAGMA auto_vacuum");
  expect(await runOn(location, autoVacuum)).toEqual([{ autoVacuum: 2 }]);

  const older = freshLocation();
  mkdirSync(older.directory, { recursive: true, mode: 0o700 });
  const oldDatabase = new Database(older.database);
  try {
    oldDatabase.exec("PRAGMA journal_mode = WAL");
    oldDatabase.exec("CREATE TABLE legacy_data (id INTEGER PRIMARY KEY)");
  } finally {
    oldDatabase.close();
  }
  expect(await runOn(older, autoVacuum)).toEqual([{ autoVacuum: 0 }]);
  expect(await runExisting(older, autoVacuum)).toEqual([{ autoVacuum: 0 }]);

  const writer = new Database(location.database);
  try {
    writer.exec("BEGIN IMMEDIATE");
    try {
      writer.exec(
        "INSERT INTO records_meta (key, value) VALUES ('uncommitted', 1)",
      );

      const started = performance.now();
      const committed = await runExisting(
        location,
        Effect.andThen(Store.prepareForRead, meta),
      );
      expect(performance.now() - started).toBeLessThan(2000);
      expect(committed).toEqual(declared);
    } finally {
      writer.exec("ROLLBACK");
    }
  } finally {
    writer.close();
  }
}, 15000);

// A newer schema that still admits this build is a newer build's upgrade (8.19): migrate changes
// nothing. Decision 12.24 also admits a newer projector and marks this build's writes.
test("a newer schema leaves this build's migrate a no-op; a newer projector stays compatible and marks writes", async () => {
  const location = freshLocation();
  await runOn(location, Log.append([commitEvent("1".repeat(40))]));

  await runExisting(
    location,
    exec(
      `INSERT INTO records_migrations (migration_id, name) VALUES (${SCHEMA_VERSION + 1}, 'future')`,
    ),
  );
  const stored = await runExisting(location, meta);
  expect(await runExisting(location, Store.migrate)).toEqual({
    applied: [],
    rebuilt: false,
  });
  expect(await runExisting(location, meta)).toEqual(stored);

  await runExisting(
    location,
    exec(`DELETE FROM records_migrations WHERE name = 'future'`),
  );
  await runExisting(
    location,
    setMeta("projector_version", PROJECTOR_VERSION + 1),
  );
  expect(await runExisting(location, Store.migrate)).toEqual({
    applied: [],
    rebuilt: false,
  });
  await runExisting(location, Log.append([commitEvent("2".repeat(40))]));
  expect(await runExisting(location, eventCount)).toBe(2);
  expect(await runExisting(location, meta)).toEqual([
    { key: "min_writer_version", value: MIN_WRITER_VERSION },
    { key: "projections_version", value: PROJECTOR_VERSION },
    { key: "projector_version", value: PROJECTOR_VERSION + 1 },
  ]);
});

test("an older store refuses until migrate, which rebuilds it", async () => {
  const location = freshLocation();
  await runOn(location, Log.append([commitEvent("1".repeat(40))]));
  await runExisting(location, setMeta("projector_version", 0));

  expect(
    await runExisting(
      location,
      failureTag(Log.append([commitEvent("3".repeat(40))])),
    ),
  ).toBe("MigrationRequired");
  expect(await runExisting(location, eventCount)).toBe(1);

  await runExisting(
    location,
    exec(`UPDATE records_meta SET value = 1 WHERE key = 'min_writer_version'`),
  );
  expect(await runExisting(location, Store.migrate)).toEqual({
    applied: [],
    rebuilt: true,
  });
  await runExisting(location, Log.append([commitEvent("4".repeat(40))]));
  expect(await runExisting(location, eventCount)).toBe(2);
});
