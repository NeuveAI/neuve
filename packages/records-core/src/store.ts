import { CompatibilitySource } from "./compatibility-capture.ts";
import { sayOnce as sharedSayOnce } from "@neuve/records-schema";
import { chmodSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Effect, Layer, Logger, Option, Schedule, String as Str } from "effect";
import { FileSystem } from "effect/FileSystem";
import { SqlClient } from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import * as SqliteMigrator from "@effect/sql-sqlite-bun/SqliteMigrator";
import { StoreVersions } from "@neuve/records-schema";
import {
  BackupFailed,
  CorruptRecord,
  MigrationRequired,
  StoreMissing,
  StoreNewer,
  StoreNotInitialized,
  StoreWithoutLog,
  WriterTooOld,
} from "./errors.ts";
import { openStoreReader, walWithoutLog } from "./read-only.ts";
import {
  STORE_DIRECTORY_MODE,
  STORE_FILE_MODE,
  type StoreLocation,
} from "./location.ts";
import { rebuildProjections } from "./rebuild.ts";
import {
  MIGRATIONS_TABLE,
  MIN_WRITER_VERSION,
  PROJECTOR_BASELINE,
  PROJECTOR_VERSION,
  SCHEMA_VERSION,
  WRITER_VERSION,
  migrations,
} from "./schema.ts";

/** Storage and version-gate failures (D2, 12.24) that any operation on the store can meet. */
export type StoreError =
  | SqlError
  | BackupFailed
  | CorruptRecord
  | MigrationRequired
  | StoreNewer
  | StoreNotInitialized
  | StoreWithoutLog
  | WriterTooOld;

const CURRENT = {
  schemaVersion: SCHEMA_VERSION,
  projectorVersion: PROJECTOR_VERSION,
};

const isLockContention = (error: SqlError) =>
  error.reason._tag === "LockTimeoutError";

/** Whether SQLite refused a write because this process may only read the database. */
const isReadOnly = (error: SqlError) => {
  const cause = error.reason.cause;
  const code =
    typeof cause === "object" && cause !== null && "code" in cause
      ? String(cause.code)
      : "";
  return (
    code.startsWith("SQLITE_READONLY") ||
    /readonly database/i.test(String(cause))
  );
};

/**
 * Switching a new file to WAL needs an exclusive lock, and SQLite reports contention on it at once
 * instead of waiting for the busy timeout. When several processes open a new store together, the
 * file is switched here first, with retries, so the client's own WAL pragma finds WAL already set
 * and has nothing to change. On a store already in WAL mode this is a no-op.
 */
const ensureWal = (filename: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const schema = yield* sql`SELECT 1 FROM sqlite_schema LIMIT 1`;
    // Reapplying this takes a write lock, so enable space reclamation only for new stores.
    if (schema.length === 0) {
      yield* sql.unsafe("PRAGMA auto_vacuum = INCREMENTAL");
    }
    yield* sql.unsafe("PRAGMA journal_mode = WAL").pipe(
      Effect.retry({
        while: isLockContention,
        schedule: Schedule.spaced("20 millis"),
        times: 100,
      }),
    );
  }).pipe(
    // A process that may only read the store (another owner's, a read-only mount) changes neither,
    // and reads it in whatever mode it is in.
    Effect.catchTag("SqlError", (error) =>
      isReadOnly(error) ? Effect.void : Effect.fail(error),
    ),
    Effect.provide(SqliteClient.layer({ filename, disableWAL: true })),
  );

/**
 * Tightens a store made before its files were owner-only, on every open: the folder to 0700, the
 * database and its -wal and -shm files to 0600. A failure is logged, not fatal, so a store this user
 * can read but not change (another owner's) still opens.
 */
const restrictStore = (location: StoreLocation) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const targets: ReadonlyArray<readonly [string, number]> = [
      [location.directory, STORE_DIRECTORY_MODE],
      [location.database, STORE_FILE_MODE],
      [`${location.database}-wal`, STORE_FILE_MODE],
      [`${location.database}-shm`, STORE_FILE_MODE],
    ];
    for (const [path, mode] of targets) {
      const info = yield* Effect.option(fs.stat(path));
      if (Option.isNone(info) || (info.value.mode & 0o777) === mode) continue;
      yield* fs
        .chmod(path, mode)
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning(
              `could not restrict ${path} to ${mode.toString(8)}: ${error.message}`,
            ),
          ),
        );
    }
  });

/** Foreign keys are enforced per connection; the client holds one connection. */
const enforceForeignKeys = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql.unsafe("PRAGMA foreign_keys = ON");
  }),
);

/**
 * The SQLite connection for one store. Rows come back camel-cased so they parse directly into the
 * `@neuve/records-schema` read models. Writable transactions use `BEGIN IMMEDIATE`.
 */
export const layer = (
  location: StoreLocation,
  options: { readonly create: boolean },
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem;
      if (!(yield* fs.exists(location.database))) {
        if (!options.create)
          return yield* new StoreMissing({ path: location.database });
        yield* fs.makeDirectory(location.directory, {
          recursive: true,
          mode: STORE_DIRECTORY_MODE,
        });
        // Created owner-only before SQLite opens it; SQLite gives its -wal and -shm the same mode.
        yield* fs.writeFile(location.database, new Uint8Array(0), {
          flag: "a",
          mode: STORE_FILE_MODE,
        });
      }
      // SQLite can't read this at all if it can't create the WAL, so say why rather than its error.
      if (
        walWithoutLog(location.database) &&
        !(yield* fs.access(location.directory, { writable: true }).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        ))
      )
        return yield* new StoreWithoutLog({ path: location.database });
      yield* restrictStore(location);
      // Also for an existing file: another process may have created it and not yet switched it.
      yield* ensureWal(location.database);
      return enforceForeignKeys.pipe(
        Layer.provideMerge(
          Layer.succeed(CompatibilitySource)(location.database),
        ),
        Layer.provideMerge(
          SqliteClient.layer({
            filename: location.database,
            transformResultNames: Str.snakeToCamel,
          }),
        ),
      );
    }),
  );

/** What the database holds: nothing of Records, migrations without versions, or a full store. */
type StoreState =
  | { readonly _tag: "Fresh" }
  | { readonly _tag: "Incomplete" }
  | {
      readonly _tag: "Ready";
      readonly versions: StoreVersions;
      /**
       * The projector whose output the projections hold (`projections_version`, 12.24). Builds from
       * before 12.24 never write it; a store without it holds the shared `projector_version`'s.
       */
      readonly projections: number;
      readonly projectionsDeferredAt?: number;
    };

type Ready = Extract<StoreState, { readonly _tag: "Ready" }>;

export const readState = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const tables = yield* sql<{
    name: string;
  }>`SELECT name FROM sqlite_master WHERE type = 'table'
    AND name IN ('records_meta', ${MIGRATIONS_TABLE})`;
  const has = (name: string) => tables.some((table) => table.name === name);
  if (!has(MIGRATIONS_TABLE)) return { _tag: "Fresh" } as StoreState;
  if (!has("records_meta")) return { _tag: "Incomplete" } as StoreState;
  const [schema] = yield* sql<{
    version: number | null;
  }>`SELECT max(migration_id) AS version FROM ${sql(MIGRATIONS_TABLE)}`;
  const meta = yield* sql<{
    key: string;
    value: number;
  }>`SELECT key, value FROM records_meta`;
  const value = (key: string) => meta.find((row) => row.key === key)?.value;
  const minWriterVersion = value("min_writer_version");
  const projectorVersion = value("projector_version");
  if (minWriterVersion === undefined || projectorVersion === undefined) {
    return { _tag: "Incomplete" } as StoreState;
  }
  const parsed = StoreVersions.safeParse({
    schemaVersion: schema?.version ?? 0,
    minWriterVersion,
    projectorVersion,
  });
  if (!parsed.success)
    return yield* new CorruptRecord({
      message: `Store versions: ${parsed.error.message}`,
    });
  const projections = value("projections_version") ?? projectorVersion;
  if (!Number.isInteger(projections) || projections < 0)
    return yield* new CorruptRecord({
      message: `Store versions: projections_version ${projections}`,
    });
  const deferred = value("projections_deferred_at");
  if (deferred !== undefined && (!Number.isInteger(deferred) || deferred < 0))
    return yield* new CorruptRecord({
      message: "Store versions: invalid projections_deferred_at",
    });
  return {
    _tag: "Ready",
    versions: parsed.data,
    projections,
    ...(deferred === undefined ? {} : { projectionsDeferredAt: deferred }),
  } as StoreState;
});

const pair = (versions: StoreVersions) => ({
  schemaVersion: versions.schemaVersion,
  projectorVersion: versions.projectorVersion,
});

/**
 * Whether a newer build left the store past this one (12.24): a newer schema, a newer baseline
 * projector, or projections a newer projector built. This build then runs in compatibility mode: it
 * reads what it understands, writes the kinds it knows, and skips the rest.
 */
const isAhead = (state: Ready) =>
  state.versions.schemaVersion > SCHEMA_VERSION ||
  state.versions.projectorVersion > PROJECTOR_VERSION ||
  state.projections > PROJECTOR_VERSION;

/**
 * Whether opening the store with this build migrates it (12.24): its schema is older, its
 * projections are older than this build's projector, or its shared versions are not the ones this
 * build's declarations give. The last repairs a store an earlier build raised for an additive change,
 * and touches only what this build fully knows: a store whose schema or baseline is past this build's
 * is left as it is.
 */
const needsUpgrade = (state: Ready) => {
  const { schemaVersion, minWriterVersion, projectorVersion } = state.versions;
  if (schemaVersion > SCHEMA_VERSION || projectorVersion > PROJECTOR_VERSION)
    return false;
  return (
    schemaVersion < SCHEMA_VERSION ||
    (state.projections < PROJECTOR_VERSION &&
      state.projectionsDeferredAt !== PROJECTOR_VERSION) ||
    minWriterVersion !== MIN_WRITER_VERSION ||
    projectorVersion !== PROJECTOR_BASELINE
  );
};

/**
 * The version gate (D2, 12.24) that every read and write runs. Only a store whose minimum writer is
 * above this build refuses it: that floor rises only with a migration that declares older writers
 * would corrupt the store. A store a newer build left ahead is used in compatibility mode. A store
 * whose schema is older than this build fails until it is migrated, which opening it with
 * `prepareForRead` or `prepareForWrite` does; projections behind this build's projector are rebuilt
 * on that open too, and meanwhile reads see this build's own events projected as they are appended.
 */
export const checkVersions = (versions: StoreVersions) =>
  Effect.gen(function* () {
    if (versions.minWriterVersion > WRITER_VERSION) {
      return yield* new WriterTooOld({
        writerVersion: WRITER_VERSION,
        minWriterVersion: versions.minWriterVersion,
      });
    }
    if (
      versions.schemaVersion < SCHEMA_VERSION ||
      versions.projectorVersion < PROJECTOR_BASELINE
    ) {
      return yield* new MigrationRequired({
        stored: pair(versions),
        current: CURRENT,
      });
    }
  });

/** Fails unless the store is initialized and passes the gate. Runs inside every read and write. */
export const assertCompatible = Effect.gen(function* () {
  const state = yield* readState;
  switch (state._tag) {
    case "Fresh":
      return yield* new StoreNotInitialized();
    case "Incomplete":
      return yield* new MigrationRequired({
        stored: undefined,
        current: CURRENT,
      });
    case "Ready":
      return yield* checkVersions(state.versions);
  }
});

/**
 * In an append transaction: when the store's baseline projector is past this build's, the rows this
 * build projects for its events are not the newer build's, so the projections are marked as this
 * build's for the newer build to rebuild when it next opens the store (12.24). Otherwise this build's
 * rows are the newer build's too, and nothing is marked.
 */
export const markProjections = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql`INSERT INTO records_meta (key, value)
    SELECT 'projections_version', ${PROJECTOR_VERSION} FROM records_meta
      WHERE key = 'projector_version' AND value > ${PROJECTOR_VERSION}
    ON CONFLICT (key) DO UPDATE SET value = min(value, excluded.value)`;
});

export interface MigrateResult {
  readonly applied: ReadonlyArray<string>;
  readonly rebuilt: boolean;
}

/**
 * Applies pending migrations inside the caller's write transaction (the migrator's own transaction
 * nests as a savepoint), and records the versions this build's declarations give: the minimum
 * writer its breaking migrations declare, its baseline projector, and the projections' projector.
 * It rebuilds when the projections are older than this build's projector or the store's versions
 * were missing.
 */
const applyMigrations = (state: StoreState) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const stored = state._tag === "Ready" ? state : undefined;
    const applied = yield* SqliteMigrator.run({
      loader: SqliteMigrator.fromRecord(migrations),
      table: MIGRATIONS_TABLE,
    });
    for (const [key, value] of [
      ["min_writer_version", MIN_WRITER_VERSION],
      ["projector_version", PROJECTOR_BASELINE],
    ] as const) {
      yield* sql`INSERT INTO records_meta (key, value) VALUES (${key}, ${value})
        ON CONFLICT (key) DO UPDATE SET value = excluded.value`;
    }
    // A new database got `projections_version` from its first migration, and a rebuild records it.
    // Otherwise the projections' version is written as read, since the shared one may have changed.
    const needsRebuild =
      state._tag === "Incomplete" ||
      (stored !== undefined &&
        (stored.projections < PROJECTOR_VERSION ||
          stored.versions.projectorVersion < PROJECTOR_BASELINE));
    const replay = needsRebuild ? yield* rebuildProjections : undefined;
    const rebuilt = replay !== undefined && !replay.deferred;
    if (!needsRebuild && stored !== undefined)
      yield* sql`INSERT INTO records_meta (key, value) VALUES ('projections_version', ${stored.projections})
        ON CONFLICT (key) DO UPDATE SET value = excluded.value`;
    return {
      applied: applied.map(([id, name]) => `${id}_${name}`),
      rebuilt,
      projections:
        rebuilt || stored === undefined
          ? PROJECTOR_VERSION
          : stored.projections,
    };
  });

/** How many backup copies a store keeps beside it; the oldest beyond this are removed. */
export const BACKUPS_KEPT = 3;

/** Where a store's backup copies live: `<store>/backups/`, owner-only like the store. */
export const backupDirectory = (database: string) =>
  join(dirname(database), "backups");

const describeVersions = (versions: {
  readonly schemaVersion: number;
  readonly minWriterVersion: number;
  readonly projectorVersion: number;
  readonly projections: number;
}) =>
  `schema ${versions.schemaVersion}, minimum writer ${versions.minWriterVersion}, baseline projector ${versions.projectorVersion}, projections by projector ${versions.projections}`;

const describeState = (state: StoreState) =>
  state._tag === "Ready"
    ? describeVersions({ ...state.versions, projections: state.projections })
    : "unfinished initialization";

/**
 * Copies the database with `VACUUM INTO` on a second, read-only connection. The caller holds the
 * write lock, so the copy is exactly the store about to be migrated: no writer can commit between
 * the copy and the migration. The copy is owner-only, in an owner-only folder, and only the newest
 * `BACKUPS_KEPT` copies are kept.
 */
const backUp = (state: StoreState) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const [main] = yield* sql<{
      file: string;
    }>`SELECT file FROM pragma_database_list WHERE name = 'main'`;
    const database = main?.file ?? "";
    if (database === "")
      return yield* new BackupFailed({
        path: "",
        message: "the store has no database file to back up",
      });
    const directory = backupDirectory(database);
    const prefix = `${basename(database, ".sqlite")}-`;
    const versions =
      state._tag === "Ready"
        ? `schema${state.versions.schemaVersion}-projector${state.projections}`
        : "incomplete";
    const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
    const target = join(directory, `${prefix}${stamp}-${versions}.sqlite`);
    return yield* Effect.try({
      try: () => {
        mkdirSync(directory, { recursive: true, mode: STORE_DIRECTORY_MODE });
        // VACUUM INTO creates the file with the default mode; the folder is owner-only, so no one
        // else can open the copy before it is restricted too.
        chmodSync(directory, STORE_DIRECTORY_MODE);
        try {
          const copy = openStoreReader(database);
          try {
            copy.run("VACUUM INTO ?", [target]);
          } finally {
            copy.close();
          }
          chmodSync(target, STORE_FILE_MODE);
        } catch (cause) {
          rmSync(target, { force: true });
          throw cause;
        }
        const copies = readdirSync(directory)
          .filter((name) => name.startsWith(prefix) && name.endsWith(".sqlite"))
          .sort();
        for (const name of copies.slice(0, -BACKUPS_KEPT))
          rmSync(join(directory, name), { force: true });
        return target;
      },
      catch: (cause) =>
        new BackupFailed({
          path: target,
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    });
  });

/** One line on stderr, or in the worker's log where its logger is installed. */
const say = (line: string) =>
  Effect.logWarning(line).pipe(Effect.provideService(Logger.LogToStderr, true));
const sayOnce = (key: string, line: string) =>
  Effect.suspend(() => sharedSayOnce(key, line, say) ?? Effect.void);

/**
 * The migrate (12.24), in one write transaction: a crash leaves the store as it was. Under the write
 * lock (`BEGIN IMMEDIATE`) it reads the store's state, so of several processes opening an old store
 * together one migrates and the others find nothing left to do; waiting for the lock is bounded, and
 * a long migration in another process is waited out by retrying. It refuses a store whose minimum
 * writer is above this build, leaves one a newer build left ahead as it is, and backs up any other
 * store it changes, under the same lock, before changing it. Opening a store with `prepareForRead`
 * or `prepareForWrite` runs it, so `neuve records migrate` is needed only to migrate without use.
 */
export const migrate = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const outcome = yield* sql
    .withTransaction(
      Effect.gen(function* () {
        const state = yield* readState;
        if (state._tag === "Ready") {
          if (state.versions.minWriterVersion > WRITER_VERSION)
            return yield* new WriterTooOld({
              writerVersion: WRITER_VERSION,
              minWriterVersion: state.versions.minWriterVersion,
            });
          if (!needsUpgrade(state)) return undefined;
        }
        // Only a schema migration changes what the store holds, so only it is backed up: a rebuild
        // replays the log, and a version reset changes three numbers. A database Records never
        // initialized holds nothing to keep.
        const changesSchema =
          state._tag === "Incomplete" ||
          (state._tag === "Ready" &&
            state.versions.schemaVersion < SCHEMA_VERSION);
        const backup = changesSchema
          ? yield* backUp(state).pipe(
              Effect.withSpan("harness.admission.store-backup"),
            )
          : undefined;
        const result = yield* applyMigrations(state).pipe(
          Effect.withSpan("harness.admission.store-migrations"),
        );
        return { state, backup, result };
      }),
    )
    .pipe(
      Effect.retry({
        while: (error) => error._tag === "SqlError" && isLockContention(error),
        schedule: Schedule.spaced("100 millis"),
        times: 24,
      }),
    );
  const unchanged: MigrateResult = { applied: [], rebuilt: false };
  if (outcome === undefined) return unchanged;
  if (outcome.backup !== undefined)
    yield* say(
      `neuve: migrated the Records store from ${describeState(outcome.state)} to ${describeVersions(
        {
          schemaVersion: SCHEMA_VERSION,
          minWriterVersion: MIN_WRITER_VERSION,
          projectorVersion: PROJECTOR_BASELINE,
          projections: outcome.result.projections,
        },
      )}${outcome.result.rebuilt ? " (rebuilt)" : ""}; backup at ${outcome.backup}`,
    );
  return { applied: outcome.result.applied, rebuilt: outcome.result.rebuilt };
});

/**
 * The migrate on open. A process that can only read the store (another owner's, a read-only
 * mount) cannot migrate it, and is told so as the gate tells an older store, not with SQLite's error.
 */
const migrateOnOpen = (state: StoreState) =>
  migrate.pipe(
    Effect.catchTag(
      "SqlError",
      (error): Effect.Effect<never, SqlError | MigrationRequired> =>
        isReadOnly(error)
          ? Effect.fail(
              new MigrationRequired({
                stored:
                  state._tag === "Ready" ? pair(state.versions) : undefined,
                current: CURRENT,
              }),
            )
          : Effect.fail(error),
    ),
  );

const prepare = (create: boolean) =>
  Effect.gen(function* () {
    const state = yield* readState;
    switch (state._tag) {
      case "Fresh":
        if (!create) return yield* new StoreNotInitialized();
        yield* migrate;
        return;
      case "Incomplete":
        yield* migrateOnOpen(state);
        return;
      case "Ready": {
        if (state.versions.minWriterVersion > WRITER_VERSION)
          return yield* new WriterTooOld({
            writerVersion: WRITER_VERSION,
            minWriterVersion: state.versions.minWriterVersion,
          });
        if (needsUpgrade(state)) {
          yield* migrateOnOpen(state);
          return;
        }
        if (state.projectionsDeferredAt === PROJECTOR_VERSION)
          yield* sayOnce(
            "compatible-read",
            "neuve: compatibility mode; leaving projection rebuild to a newer build; stored projections are unchanged",
          );
        if (isAhead(state))
          yield* sayOnce(
            "compatible-read",
            `neuve: this build (schema ${SCHEMA_VERSION}, projector ${PROJECTOR_VERSION}) runs in compatibility mode on a store a newer build left at ${describeState(state)}: it reads and writes the event kinds it knows and leaves newer ones to that build`,
          );
        return;
      }
    }
  });

/**
 * Prepares a store for writing (12.24): a database Records has never initialized is created at this
 * build's versions; an older one is migrated after a backup copy; a newer one is used in
 * compatibility mode. Only a store whose minimum writer is above this build refuses it.
 */
export const prepareForWrite = prepare(true);

/** Prepares a store for reading: it must be initialized; otherwise as `prepareForWrite`. */
export const prepareForRead = prepare(false);

/** The store's one public observer; see `watchChanges` in `store-watch.ts`. */
export {
  PROBE_WRITES_MAX,
  watchChanges,
  type StoreWatch,
} from "./store-watch.ts";
