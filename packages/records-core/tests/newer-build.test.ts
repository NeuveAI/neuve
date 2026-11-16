// Why (8.19): during the pi transition a newer build writes to the same store as main's installed
// copy, adding event kinds, a job kind (`review.run@3`), tables and migrations main does not know.
// Main must keep working there: every read that walks the log or the queue skips those rows and
// leaves them as they are, its worker never claims or recovers the newer build's jobs, and migrate
// changes nothing. Skipping must never hide corruption, so a row whose kind column disagrees with
// its envelope, a known kind that fails its schema and an envelope that is not JSON still fail.
import { afterAll, expect, test } from "bun:test";
import { Effect, Option } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import {
  Admin,
  Blobs,
  JobQueue,
  Log,
  ReviewList,
  ReviewProgress,
  ReviewStats,
  SCHEMA_VERSION,
  Store,
  canonicalJson,
  mintUlid,
  sha256Hex,
  type StoreLocation,
} from "../src/index.ts";
import { fingerprintOf } from "../src/codec.ts";
import {
  actor,
  cycleEvents,
  freshLocation,
  headOid,
  removeTemporaryDirectories,
  runOn,
} from "./support.ts";

afterAll(removeTemporaryDirectories);

const range = { baseRef: "refs/heads/main", baseOid: "b".repeat(40), headOid };

const withQueue = <A, E, R>(
  program: (queue: JobQueue.JobQueue["Service"]) => Effect.Effect<A, E, R>,
) => Effect.provide(JobQueue.JobQueue.use(program), JobQueue.layer);

const request = (cycleId: string, label: string) => ({
  id: mintUlid(),
  kind: "review.requested@1",
  idempotencyKey: `request:${mintUlid()}`,
  actor,
  occurredAt: "2026-11-01T10:00:00.000Z",
  attribution: { cycleId, range },
  payload: {
    runKey: sha256Hex(label),
    generation: 0,
    pipeline: { version: 10, config: {} },
  },
});

/** Inserts an event row as the newer build's append does: canonical envelope, fingerprint, index rows. */
const insertRow = (
  event: Record<string, unknown> & {
    id: string;
    idempotencyKey: string;
    actor: string;
    occurredAt: string;
    attribution?: { cycleId?: string; unitIds?: ReadonlyArray<string> };
  },
  column: string,
  envelope = canonicalJson(event),
  fingerprint = fingerprintOf(event as never),
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const [row] = yield* sql<{ seq: number }>`INSERT INTO events ${sql.insert({
      id: event.id,
      kind: column,
      idempotency_key: event.idempotencyKey,
      fingerprint,
      actor_id: event.actor,
      occurred_at: event.occurredAt,
      recorded_at: "2026-11-01T10:00:01.000Z",
      envelope,
    })} RETURNING seq`;
    const seq = row!.seq;
    for (const unit_id of event.attribution?.unitIds ?? [])
      yield* sql`INSERT INTO event_units ${sql.insert({ unit_id, event_seq: seq })}`;
    if (event.attribution?.cycleId !== undefined)
      yield* sql`INSERT INTO event_cycles ${sql.insert({ cycle_id: event.attribution.cycleId, event_seq: seq })}`;
    return seq;
  });

/** A store holding main's rows and the rows a newer build adds beside them. */
const mixedStore = async () => {
  const location = freshLocation();
  const { events, unitIds } = cycleEvents(2);
  const cycleId = (events[0] as { attribution: { cycleId: string } })
    .attribution.cycleId;
  const ours = request(cycleId, "main's run");
  const waiting = request(cycleId, "newer waiting run");
  const active = request(cycleId, "newer active run");
  await runOn(location, Log.append([...events, ours, waiting, active]));
  const origin = {
    id: mintUlid(),
    kind: "review.future-origin@1",
    idempotencyKey: `origin:${mintUlid()}`,
    actor,
    occurredAt: "2026-11-01T10:00:00.000Z",
    attribution: { cycleId, unitIds: [unitIds[0]!], range },
    payload: { identity: "chat:1", origin: { kind: "channel", host: "x" } },
  };
  await runOn(
    location,
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      yield* insertRow(origin, origin.kind);
      // The newer build enqueues its review under its own kind, with the key main's would have.
      yield* sql`UPDATE jobs SET kind = 'review.run@3'
        WHERE dedupe_key = ${`review.run:${waiting.payload.runKey}:0`}`;
      // Its worker died while running the other one.
      yield* sql`UPDATE jobs SET kind = 'review.run@3', state = 'active', attempts = 1,
        started_at = '2026-11-01T10:05:00.000Z'
        WHERE dedupe_key = ${`review.run:${active.payload.runKey}:0`}`;
      // Its migrations and its own projection table.
      yield* sql`INSERT INTO records_migrations (migration_id, name)
        VALUES (${SCHEMA_VERSION + 1}, 'future_origins'), (${SCHEMA_VERSION + 2}, 'project_future_origins')`;
      yield* sql`CREATE TABLE projection_future_origins (event_id TEXT PRIMARY KEY, cycle_id TEXT NOT NULL)`;
      yield* sql`INSERT INTO projection_future_origins ${sql.insert({ event_id: origin.id, cycle_id: cycleId })}`;
    }),
  );
  return { location, cycleId, origin, ours, waiting, active };
};

/** Everything the newer build wrote, as stored, to show main left it untouched. */
const newerRows = (location: StoreLocation) =>
  runOn(
    location,
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      return {
        events:
          yield* sql`SELECT * FROM events WHERE kind = 'review.future-origin@1'`,
        jobs: yield* sql`SELECT * FROM jobs WHERE kind = 'review.run@3' ORDER BY job_seq`,
        table: yield* sql`SELECT * FROM projection_future_origins`,
        meta: yield* sql`SELECT * FROM records_meta ORDER BY key`,
        migrations:
          yield* sql`SELECT migration_id, name FROM records_migrations ORDER BY migration_id`,
      };
    }),
  );

test("main reads, checks, rebuilds and migrates a store a newer build also wrote, and leaves its rows", async () => {
  const store = await mixedStore();
  const before = await newerRows(store.location);
  expect(before.jobs).toHaveLength(2);

  // History and get leave the newer event out; the limit counts only events returned.
  const all = await runOn(store.location, Log.history({ limit: 1_000 }));
  expect(all.map((e) => e.event.kind)).not.toContain("review.future-origin@1");
  const cycle = await runOn(
    store.location,
    Log.history({ cycleId: store.cycleId, limit: 1_000 }),
  );
  expect(cycle.length).toBe(all.length);
  const last = await runOn(
    store.location,
    Log.history({ afterSeq: all.at(-2)!.seq, limit: 1 }),
  );
  expect(last.map((e) => e.event.id)).toEqual([all.at(-1)!.event.id]);
  expect(
    Option.isNone(await runOn(store.location, Log.get(store.origin.id))),
  ).toBe(true);
  expect(
    await runOn(store.location, Log.newerEventKind(store.origin.id)),
  ).toEqual(Option.some("review.future-origin@1"));

  // The queue lists, inspects and recovers only main's kinds.
  const queue = await runOn(
    store.location,
    withQueue((q) =>
      Effect.gen(function* () {
        const listed = yield* q.list({
          states: ["waiting", "delayed", "active", "completed", "failed"],
          limit: 1_000,
        });
        const newer = yield* JobQueue.newerJob({
          dedupeKey: `review.run:${store.waiting.payload.runKey}:0`,
        });
        const inspected = Option.isSome(newer)
          ? yield* q.inspect(newer.value.seq)
          : Option.none();
        const recovered = yield* q.recoverStalled;
        return { listed, newer, inspected, recovered };
      }),
    ),
  );
  expect(queue.listed.map((job) => job.kind)).not.toContain("review.run@3");
  expect(
    queue.listed.filter((job) => job.kind === "review.run@2"),
  ).toHaveLength(1);
  expect(Option.getOrUndefined(queue.newer)).toMatchObject({
    kind: "review.run@3",
    state: "waiting",
  });
  expect(Option.isNone(queue.inspected)).toBe(true);
  expect(queue.recovered).toEqual([]);

  // The review list, progress and latest run count main's review job only.
  const reviews = await runOn(
    store.location,
    ReviewList.reviews({ limit: 10 }).pipe(
      Effect.provide(Blobs.layer(store.location)),
    ),
  );
  expect(reviews.reviews.map((review) => review.runId)).toEqual([
    store.ours.id,
  ]);
  const open = await runOn(store.location, ReviewProgress.openReviewJobs(10));
  expect(open).toHaveLength(1);
  expect(await runOn(store.location, ReviewStats.latestRun())).toEqual(
    Option.some(store.ours.id),
  );

  // fsck passes, counting what it left for the newer build, including in its cross-checks.
  const checks = await runOn(store.location, Admin.fsck(store.location));
  expect(checks.filter((check) => check.status === "fail")).toEqual([]);
  const detail = (name: string) =>
    checks.find((check) => check.name.startsWith(name))?.detail;
  expect(detail("envelopes")).toContain(
    "1 of kinds this build does not know, left for a newer build",
  );
  expect(detail("unit and cycle")).toContain(
    "2 of them for events of kinds this build does not know, checked against their attribution",
  );
  expect(detail("jobs match")).toContain("2 of kinds this build does not know");

  // Rebuild leaves the projections to the newer build, including rows from unknown kinds.
  const rebuilt = await runOn(store.location, Admin.rebuild);
  expect(rebuilt.newerEvents).toBe(1);
  expect(rebuilt.events).toBe(0);
  expect(rebuilt.afterCombined).toBe(rebuilt.beforeCombined);

  // Stats reports the newer build's table as its own, not as undeclared.
  const stats = await runOn(store.location, Admin.stats(store.location));
  expect(stats.undeclaredTables).toEqual([]);
  expect(stats.newerTables).toEqual(["projection_future_origins"]);

  // Migrate changes nothing and says a newer build upgraded the store.
  const migrated = await runOn(store.location, Store.migrate);
  expect(migrated).toEqual({ applied: [], rebuilt: false });

  expect(await newerRows(store.location)).toEqual(before);
});

test("main's worker never claims or recovers the newer build's review jobs", async () => {
  const store = await mixedStore();
  const before = await newerRows(store.location);
  const taken = await runOn(
    store.location,
    withQueue((q) =>
      Effect.gen(function* () {
        const recovered = yield* q.recoverStalled;
        const claimed: Array<string> = [];
        // Every kind main runs, until the queue has nothing left for it.
        for (;;) {
          const job = yield* q.take([
            "review.run@2",
            "stack.fetch",
            "scope.fetch",
          ]);
          if (Option.isNone(job)) break;
          claimed.push(job.value.kind);
          yield* q.complete(job.value.seq, job.value.attempts);
        }
        return { recovered, claimed };
      }),
    ),
  );
  expect(taken.recovered).toEqual([]);
  expect(taken.claimed.filter((kind) => kind === "review.run@2")).toHaveLength(
    1,
  );
  expect(taken.claimed).not.toContain("review.run@3");
  expect(await newerRows(store.location)).toEqual(before);
});

test("skipping newer kinds never hides corrupt rows", async () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly insert: (
      cycleId: string,
    ) => Effect.Effect<number, unknown, SqlClient>;
    readonly message: string;
  }> = [
    {
      name: "a newer kind in the envelope under a known kind column",
      insert: (cycleId) => {
        const event = {
          id: mintUlid(),
          kind: "review.future-origin@1",
          idempotencyKey: `bad:${mintUlid()}`,
          actor,
          occurredAt: "2026-11-01T10:00:00.000Z",
          attribution: { cycleId },
          payload: {},
        };
        return insertRow(event, "cycle.opened@1");
      },
      message:
        "the kind column says cycle.opened@1, the envelope review.future-origin@1",
    },
    {
      name: "a known kind in the envelope under a newer kind column",
      insert: (cycleId) => {
        const event = {
          id: mintUlid(),
          kind: "cycle.opened@1",
          idempotencyKey: `bad:${mintUlid()}`,
          actor,
          occurredAt: "2026-11-01T10:00:00.000Z",
          attribution: { cycleId: mintUlid(), range },
          payload: {},
        };
        void cycleId;
        return insertRow(event, "cycle.opened@2");
      },
      message:
        "the kind column says cycle.opened@2, the envelope cycle.opened@1",
    },
    {
      name: "a known kind with an invalid required field and an additive key",
      insert: (cycleId) => {
        const event = {
          id: mintUlid(),
          kind: "cycle.opened@1",
          idempotencyKey: `bad:${mintUlid()}`,
          actor,
          occurredAt: "not a timestamp",
          attribution: { cycleId, range },
          payload: { unexpected: true },
        };
        return insertRow(event, event.kind);
      },
      message: "occurredAt",
    },
    {
      name: "an envelope that is not JSON",
      insert: (cycleId) => {
        const event = {
          id: mintUlid(),
          kind: "review.future-origin@1",
          idempotencyKey: `bad:${mintUlid()}`,
          actor,
          occurredAt: "2026-11-01T10:00:00.000Z",
          payload: {},
        };
        void cycleId;
        return insertRow(event, event.kind, "{not json");
      },
      message: "envelope is not JSON",
    },
  ];
  for (const corrupt of cases) {
    const store = await mixedStore();
    await runOn(store.location, corrupt.insert(store.cycleId));
    const checks = await runOn(store.location, Admin.fsck(store.location));
    const envelopes = checks.find((check) =>
      check.name.startsWith("envelopes"),
    );
    expect({ name: corrupt.name, status: envelopes?.status }).toEqual({
      name: corrupt.name,
      status: "fail",
    });
    expect(envelopes?.detail).toContain(corrupt.message);
    const rebuild = await runOn(store.location, Effect.flip(Admin.rebuild));
    expect({ name: corrupt.name, tag: rebuild._tag }).toEqual({
      name: corrupt.name,
      tag: "CorruptRecord",
    });
    const history = await runOn(
      store.location,
      Effect.flip(Log.history({ limit: 1_000 })),
    );
    expect({ name: corrupt.name, tag: history._tag }).toEqual({
      name: corrupt.name,
      tag: "CorruptRecord",
    });
  }

  // Kind-independent envelope rules hold for skipped rows too: a misspelt known kind whose
  // fingerprint was copied from the event it imitates, a kind that is not the shape of one, an
  // envelope without the fields every kind carries, and a missing index row.
  const imitated = request(mintUlid(), "imitated");
  const misspelt = { ...imitated, kind: "review.requsted@1" };
  const skipped: ReadonlyArray<{
    readonly name: string;
    readonly insert: (
      cycleId: string,
    ) => Effect.Effect<unknown, unknown, SqlClient>;
    readonly message: string;
  }> = [
    {
      name: "a misspelt kind with a copied fingerprint",
      insert: () =>
        insertRow(
          misspelt,
          misspelt.kind,
          canonicalJson(misspelt),
          fingerprintOf(imitated as never),
        ),
      message: "fingerprint mismatch",
    },
    {
      name: "a kind that is not the shape of one",
      insert: () => {
        const event = { ...request(mintUlid(), "shape"), kind: "garbage" };
        return insertRow(event, event.kind);
      },
      message: "garbage is not the shape of an event kind",
    },
    {
      name: "an envelope without the fields every kind carries",
      insert: () => {
        const event = {
          ...request(mintUlid(), "fields"),
          kind: "review.future-origin@1",
          actor: "not an actor",
        };
        return insertRow(event, event.kind);
      },
      message: "an envelope no kind may have",
    },
    {
      name: "a skipped event whose cycle is not indexed",
      insert: (cycleId) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          const event = {
            ...request(cycleId, "unindexed"),
            kind: "review.future-origin@1",
          };
          const [row] = yield* sql<{
            seq: number;
          }>`INSERT INTO events ${sql.insert({
            id: event.id,
            kind: event.kind,
            idempotency_key: event.idempotencyKey,
            fingerprint: fingerprintOf(event as never),
            actor_id: event.actor,
            occurred_at: event.occurredAt,
            recorded_at: "2026-11-01T10:00:01.000Z",
            envelope: canonicalJson(event),
          })} RETURNING seq`;
          return row?.seq;
        }),
      message: "cycle not indexed",
    },
  ];
  for (const corrupt of skipped) {
    const store = await mixedStore();
    await runOn(store.location, corrupt.insert(store.cycleId));
    const checks = await runOn(store.location, Admin.fsck(store.location));
    const failed = checks.filter((check) => check.status === "fail");
    expect({ name: corrupt.name, failed: failed.length > 0 }).toEqual({
      name: corrupt.name,
      failed: true,
    });
    expect(failed.map((check) => check.detail).join(" ")).toContain(
      corrupt.message,
    );
  }

  // A job of a known kind with bad data is still corrupt.
  const store = await mixedStore();
  await runOn(
    store.location,
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      yield* sql`UPDATE jobs SET last_error = '{not json' WHERE kind = 'review.run@2'`;
    }),
  );
  const listed = await runOn(
    store.location,
    withQueue((q) => Effect.flip(q.list({ states: ["waiting"], limit: 10 }))),
  );
  expect(listed._tag).toBe("CorruptRecord");
  // Alone 0.83-0.93 s; 10x slowest, at least 30 s; SQLite and capture I/O under load.
}, 30_000);

// Why (8.19): a hand enqueue whose key a newer build's job holds must name that job instead of
// reporting the store as corrupt, and the ended count a request takes its generation from must see
// the newer build's ended jobs without decoding them.
test("a hand enqueue names the newer build's job, and ended runs count whatever their kind", async () => {
  const store = await mixedStore();
  const waitingKey = `review.run:${store.waiting.payload.runKey}:0`;
  const result = await runOn(
    store.location,
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const held = yield* withQueue((q) =>
        Effect.flip(q.enqueue({ kind: "review.run@2", dedupeKey: waitingKey })),
      );
      const prefix = (label: string) => `review.run:${sha256Hex(label)}:`;
      const before = yield* JobQueue.endedWithPrefix(
        prefix("newer waiting run"),
      );
      yield* sql`UPDATE jobs SET state = 'failed' WHERE dedupe_key = ${waitingKey}`;
      const after = yield* JobQueue.endedWithPrefix(
        prefix("newer waiting run"),
      );
      const ours = yield* JobQueue.endedWithPrefix(prefix("main's run"));
      return { held, before, after, ours };
    }),
  );
  expect(result.held).toMatchObject({
    _tag: "JobHeldByNewerBuild",
    kind: "review.run@3",
    state: "waiting",
  });
  expect(result.held.message).toContain(
    "a kind this build does not know; it is the newer build's job, which this build leaves to it",
  );
  expect([result.before, result.after, result.ours]).toEqual([0, 1, 0]);
});
