// Rebuild must neither destroy newer values nor hide that loss in stripped checksums.
import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import { readdirSync } from "node:fs";
import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import {
  Admin,
  Log,
  Store,
  canonicalJson,
  PROJECTOR_VERSION,
  mintUlid,
} from "../src/index.ts";
import { projectionChecksums, combinedChecksum } from "../src/rebuild.ts";
import { fingerprintOf } from "../src/codec.ts";
import {
  cycleEvents,
  freshLocation,
  removeTemporaryDirectories,
  runExisting,
  runOn,
} from "./support.ts";

afterAll(removeTemporaryDirectories);

test("an added projection column survives rebuild and changes to its stored value change the checksum", async () => {
  const location = freshLocation();
  const { events } = cycleEvents(1);
  const result = await runOn(
    location,
    Effect.gen(function* () {
      yield* Log.append(events);
      const sql = yield* SqlClient;
      yield* sql.unsafe(
        "ALTER TABLE projection_units ADD COLUMN future_column TEXT",
      );
      yield* sql`UPDATE projection_units SET future_column='newer data'`;
      const before = combinedChecksum(yield* projectionChecksums);
      const rebuilt = yield* Admin.rebuild;
      const rows = yield* sql`SELECT future_column FROM projection_units`;
      const checks = yield* Admin.fsck(location);
      yield* sql`UPDATE projection_units SET future_column='changed newer data'`;
      const changed = combinedChecksum(yield* projectionChecksums);
      return { before, rebuilt, rows, changed, checks };
    }),
  );
  expect(result.rebuilt.events).toBe(0);
  expect(result.rows).toEqual([{ futureColumn: "newer data" }]);
  expect(result.rebuilt.beforeCombined).toBe(result.before);
  expect(result.rebuilt.afterCombined).toBe(result.before);
  expect(result.changed).not.toBe(result.before);
  expect(
    result.checks.find(
      (check) => check.name === "projections equal a rebuild (rolled back)",
    )?.status,
  ).toBe("skipped");
});

test("an event requiring a compatible read leaves all projections untouched and opening twice does not retry migration", async () => {
  const location = freshLocation();
  const { events } = cycleEvents(1);
  await runOn(
    location,
    Effect.gen(function* () {
      yield* Log.append(events);
      const sql = yield* SqlClient;
      const [row] = yield* sql<{
        envelope: string;
        id: string;
      }>`SELECT id, envelope FROM events WHERE kind='unit.recorded@1'`;
      if (row === undefined) throw new Error("unit event absent");
      const newer = {
        ...JSON.parse(row.envelope),
        id: mintUlid(),
        idempotencyKey: "future-unit",
        future: true,
      };
      yield* sql`INSERT INTO events ${sql.insert({ id: newer.id, kind: newer.kind, idempotency_key: newer.idempotencyKey, fingerprint: fingerprintOf(newer), actor_id: newer.actor, occurred_at: newer.occurredAt, recorded_at: newer.occurredAt, envelope: canonicalJson(newer) })}`;
      // A previous build left this marker behind; do not repeatedly migrate this store.
      yield* sql`UPDATE records_meta SET value=0 WHERE key='projections_version'`;
    }),
  );
  const first = await runExisting(location, Store.migrate);
  const backups = () => {
    try {
      return readdirSync(Store.backupDirectory(location.database));
    } catch {
      return [];
    }
  };
  const copies = backups();
  await runExisting(
    location,
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      yield* sql.unsafe(
        "CREATE TRIGGER refuse_repeated_migration BEFORE UPDATE ON records_meta WHEN OLD.key IN ('min_writer_version', 'projector_version') BEGIN SELECT RAISE(ABORT, 'migration repeated'); END",
      );
    }),
  );
  const second = await runExisting(location, Store.prepareForRead);
  const after = await runExisting(
    location,
    Effect.gen(function* () {
      yield* Store.prepareForRead;
      const report = yield* Admin.rebuild;
      const state = yield* Store.readState;
      return { report, state };
    }),
  );
  expect(first.rebuilt).toBe(false);
  expect(second).toBeUndefined();
  expect(backups()).toEqual(copies);
  expect(after.report.events).toBe(0);
  expect(after.report.afterCombined).toBe(after.report.beforeCombined);
  expect(after.state).toMatchObject({
    projections: 0,
    projectionsDeferredAt: PROJECTOR_VERSION,
  });
});

test("newer fields inside origin_json defer rebuild before destructive replay, with the compatibility line", async () => {
  // A fresh process isolates the once-per-process disclosure from other compatible reads.
  const { spawnSync } = await import("node:child_process");
  const script = `
    import { Effect } from 'effect';
    import { SqlClient } from 'effect/sql/SqlClient';
    import { Admin, Log, mintUlid } from './packages/records-core/src/index.ts';
    import { actor, envelope, freshLocation, runOn, removeTemporaryDirectories } from './packages/records-core/tests/support.ts';
    try { await runOn(freshLocation(), Effect.gen(function* () {
      const sql = yield* SqlClient;
      const cycleId = mintUlid();
      const range = {baseRef:'main',baseOid:'a'.repeat(40),headOid:'b'.repeat(40)};
      const origin = {kind:'channel',host:'local',channel:'test',chat:1,items:[]};
      yield* Log.append([
        envelope('cycle.opened@1','cycle',actor,{cycleId,range},{}),
        envelope('review.origin-recorded@1','origin',actor,{cycleId,range},{identity:'a'.repeat(64),origin})
      ]);
      const newer = {...origin,future:{derived:'newer data'}};
      yield* sql\`UPDATE projection_review_origins SET origin_json=\${JSON.stringify(newer)}\`;
      const report = yield* Admin.rebuild;
      const [row] = yield* sql\`SELECT origin_json FROM projection_review_origins\`;
      if(report.events !== 0 || JSON.stringify(JSON.parse(row.originJson)) !== JSON.stringify(newer)) throw new Error('newer projection was lost');
    })); } finally {removeTemporaryDirectories();}
  `;
  const child = spawnSync(process.execPath, ["--no-env-file", "-e", script], {
    cwd: join(import.meta.dir, "../../.."),
    encoding: "utf8",
    timeout: 30_000,
  });
  expect(child.status).toBe(0);
  expect(child.stderr).toContain("leaving projection rebuild to a newer build");
  expect(child.stderr).toContain("projection_review_origins.originJson.future");
});

test("a newer projections_version defers rebuild even with no additive fields and keeps its version", async () => {
  const result = await runOn(
    freshLocation(),
    Effect.gen(function* () {
      yield* Log.append(cycleEvents(1).events);
      const sql = yield* SqlClient;
      yield* sql`UPDATE records_meta SET value=${PROJECTOR_VERSION + 1} WHERE key='projections_version'`;
      const report = yield* Admin.rebuild;
      return { report, state: yield* Store.readState };
    }),
  );
  expect(result.report.events).toBe(0);
  expect(result.report.afterCombined).toBe(result.report.beforeCombined);
  expect(result.state).toMatchObject({ projections: PROJECTOR_VERSION + 1 });
});
