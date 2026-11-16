// Why: a build behind its store must keep working in compatibility mode (12.24): every reader of
// the whole log or queue meets a newer build's event and job kinds, and must skip them instead of
// failing, while still finding its own. And a store this build migrates or creates must pass the
// gate of main's unchanged build (b192becf), whose rule is copied here, because main keeps writing
// to stores the transition build has opened.
import { afterAll, expect, test } from "bun:test";
import { Effect, Option } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { canonicalJson } from "../src/canonical.ts";
import {
  Admin,
  JobQueue,
  Log,
  PROJECTOR_VERSION,
  sha256Hex,
  Store,
  mintUlid,
  type StoreLocation,
} from "../src/index.ts";
import {
  actor,
  commitEvent,
  cycleEvents,
  freshLocation,
  removeTemporaryDirectories,
  runExisting,
  runFs,
  runOn,
} from "./support.ts";

afterAll(removeTemporaryDirectories);

const exec = (statement: string, params: ReadonlyArray<unknown> = []) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    return yield* sql.unsafe<Record<string, unknown>>(statement, params);
  });
const withQueue = <A, E, R>(
  program: (queue: JobQueue.JobQueue["Service"]) => Effect.Effect<A, E, R>,
) => Effect.provide(JobQueue.JobQueue.use(program), JobQueue.layer);

/** An event of a kind no build knows yet, stored as a newer build would store it, in a cycle. */
const newerEvent = (cycleId: string) =>
  Effect.gen(function* () {
    const id = mintUlid();
    const content = {
      kind: "review.future-recorded@1",
      actor,
      attribution: { cycleId },
      payload: { anything: true },
    };
    const envelope = canonicalJson({
      ...content,
      id,
      idempotencyKey: `future:${id}`,
      occurredAt: "2026-11-01T09:00:00.000Z",
    });
    const [row] = yield* exec(
      `INSERT INTO events (id, kind, idempotency_key, fingerprint, actor_id, occurred_at, recorded_at, envelope)
        VALUES (?, 'review.future-recorded@1', ?, ?, ?, '2026-11-01T09:00:00.000Z', '2026-11-01T09:00:00.000Z', ?)
        RETURNING seq`,
      [id, `future:${id}`, sha256Hex(canonicalJson(content)), actor, envelope],
    );
    yield* exec(
      `INSERT INTO event_cycles (cycle_id, event_seq) VALUES (?, ?)`,
      [cycleId, row?.["seq"]],
    );
    // And a job of a newer kind it enqueued, one left active by that build's worker.
    yield* exec(
      `INSERT INTO jobs (kind, dedupe_key, event_id, state, started_at)
        VALUES ('review.future', ?, ?, 'active', '2026-11-01T09:00:01.000Z')`,
      [`future:${id}`, id],
    );
    return id;
  });

const fsckOf = (location: StoreLocation) =>
  runFs(
    Admin.fsck(location).pipe(
      Effect.provide(Store.layer(location, { create: false })),
    ),
  );

test("a newer build's event and job kinds are skipped by every reader of the log and the queue", async () => {
  const location = freshLocation();
  const cycle = cycleEvents(2);
  await runOn(location, Log.append(cycle.events));
  const cycleId = (cycle.events[0]!.attribution as { cycleId: string }).cycleId;
  const newer = await runExisting(location, newerEvent(cycleId));

  // History and get leave it out; a limit counts only what is returned.
  const inCycle = await runExisting(location, Log.history({ cycleId }));
  expect(inCycle.map((stored) => stored.event.kind)).not.toContain(
    "review.future-recorded@1",
  );
  expect(inCycle).toHaveLength(cycle.events.length);
  expect(
    await runExisting(location, Log.history({ cycleId, limit: 2 })),
  ).toHaveLength(2);
  expect(Option.isNone(await runExisting(location, Log.get(newer)))).toBeTrue();

  // A rebuild leaves newer projection data untouched.
  const report = await runExisting(location, Admin.rebuild);
  expect(report.events).toBe(0);
  expect(report.afterCombined).toBe(report.beforeCombined);
  expect(
    await runExisting(
      location,
      exec(`SELECT value FROM records_meta WHERE key = 'projections_version'`),
    ),
  ).toEqual([{ value: PROJECTOR_VERSION }]);

  // fsck checks what it knows and names what it left to the newer build.
  const checks = await fsckOf(location);
  const byName = new Map(checks.map((check) => [check.name, check]));
  for (const name of [
    "envelopes parse, are canonical and match fingerprints",
    "unit and cycle index rows match attribution",
    "jobs match the events that enqueue them",
  ])
    expect(byName.get(name)?.status).toBe("ok");
  expect(byName.get("projections equal a rebuild (rolled back)")?.status).toBe(
    "skipped",
  );
  expect(
    byName.get("envelopes parse, are canonical and match fingerprints")?.detail,
  ).toContain("1 of kinds this build does not know, left for a newer build");

  // The queue lists only its own kinds and leaves the newer build's active job as it was.
  const listed = await runExisting(
    location,
    withQueue((queue) =>
      queue.list({ states: ["waiting", "active"], limit: 100 }),
    ),
  );
  expect(listed.map((job) => job.kind)).not.toContain("review.future");
  const recovered = await runExisting(
    location,
    withQueue((queue) => queue.recoverStalled),
  );
  expect(recovered.map((entry) => entry.job.kind)).not.toContain(
    "review.future",
  );
  expect(
    await runExisting(
      location,
      exec(`SELECT state FROM jobs WHERE kind = 'review.future'`),
    ),
  ).toEqual([{ state: "active" }]);

  // And this build still writes beside it.
  await runExisting(location, Log.append([commitEvent("9".repeat(40))]));
});

test("a known kind that fails its schema is still corrupt, not skipped", async () => {
  const location = freshLocation();
  await runOn(location, Log.append([commitEvent("1".repeat(40))]));
  await runExisting(
    location,
    Effect.gen(function* () {
      yield* exec("DROP TRIGGER events_append_only_update");
      yield* exec(
        `UPDATE events SET envelope = json_set(envelope, '$.payload.oid', 'not-an-oid')`,
      );
    }),
  );
  const failure = await runExisting(location, Effect.flip(Log.history({})));
  expect(failure._tag).toBe("CorruptRecord");
});

test("a row whose kind column disagrees with its envelope is corrupt, not a newer kind", async () => {
  const location = freshLocation();
  await runOn(location, Log.append([commitEvent("1".repeat(40))]));
  await runExisting(
    location,
    Effect.gen(function* () {
      yield* exec("DROP TRIGGER events_append_only_update");
      yield* exec(`UPDATE events SET kind = 'review.future-recorded@1'`);
    }),
  );
  const failure = await runExisting(location, Effect.flip(Admin.rebuild));
  expect(failure._tag).toBe("CorruptRecord");
  expect(String((failure as { message?: string }).message)).toContain(
    "the kind column says review.future-recorded@1, the envelope commit.recorded@1",
  );
  const checks = await fsckOf(location);
  const envelopes = checks.find(
    (check) =>
      check.name === "envelopes parse, are canonical and match fingerprints",
  );
  expect(envelopes?.status).toBe("fail");
  expect(envelopes?.detail).toContain("the kind column says");
});

/** Main's gate at b192becf, as its `checkVersions` decides: schema 14, projector 9, writer 13. */
const mainAccepts = (versions: {
  readonly minWriterVersion: number;
  readonly projectorVersion: number;
  readonly schemaVersion: number;
}) =>
  versions.minWriterVersion <= 13 &&
  versions.projectorVersion <= 9 &&
  versions.schemaVersion >= 14 &&
  versions.projectorVersion >= 9;

const versionsOf = (location: StoreLocation) =>
  runExisting(
    location,
    Effect.map(Store.readState, (state) => {
      if (state._tag !== "Ready") throw new Error(state._tag);
      return state.versions;
    }),
  );

test("main's gate accepts every store this build migrates or creates while the changes are additive", async () => {
  const created = freshLocation();
  await runOn(created, Log.append([commitEvent("1".repeat(40))]));
  expect(mainAccepts(await versionsOf(created))).toBeTrue();

  const migrated = freshLocation();
  await runOn(migrated, Log.append([commitEvent("2".repeat(40))]));
  await runExisting(
    migrated,
    Effect.gen(function* () {
      yield* exec("DROP TABLE projection_review_origins");
      yield* exec("DELETE FROM records_migrations WHERE migration_id >= 15");
      yield* exec("DELETE FROM records_meta WHERE key = 'projections_version'");
      yield* exec(
        "UPDATE records_meta SET value = 9 WHERE key = 'projector_version'",
      );
    }),
  );
  await runExisting(migrated, Store.prepareForWrite);
  expect(mainAccepts(await versionsOf(migrated))).toBeTrue();
});
