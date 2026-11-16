import { safeRead } from "@neuve/records-schema";
import { Data, Effect, Option } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { JobRow, type Reference } from "@neuve/records-schema";
import {
  blobFileCheck,
  computationChecks,
  computationStats,
  type ComputationStats,
  type StoreCheck,
} from "./computation-admin.ts";
import { canonicalJson } from "./canonical.ts";
import {
  checkNewerRow,
  decodeStoredEvent,
  fingerprintOf,
  eventWithStoredFields,
  isKnownJobKind,
} from "./codec.ts";
import { jobsFor } from "./jobs.ts";
import {
  combinedChecksum,
  projectionChecksums,
  rebuildProjections,
  type ProjectionChecksum,
} from "./rebuild.ts";
import type { StoreLocation } from "./location.ts";
import { SCHEMA_VERSION, TABLE_ROLES, type TableRole } from "./schema.ts";
import { assertCompatible, readState } from "./store.ts";

export interface RebuildReport {
  readonly events: number;
  /** Events of kinds this build does not know, left to the newer build that wrote them (8.19). */
  readonly newerEvents: number;
  readonly before: ReadonlyArray<ProjectionChecksum>;
  readonly after: ReadonlyArray<ProjectionChecksum>;
  readonly beforeCombined: string;
  readonly afterCombined: string;
}

/** Rebuilds every projection from the log in one write transaction, with checksums before and after (D7). */
export const rebuild = Effect.gen(function* () {
  const sql = yield* SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* assertCompatible;
      const before = yield* projectionChecksums;
      const replay = yield* rebuildProjections;
      const after = yield* projectionChecksums;
      const report: RebuildReport = {
        events: replay.replayed,
        newerEvents: replay.newer,
        before,
        after,
        beforeCombined: combinedChecksum(before),
        afterCombined: combinedChecksum(after),
      };
      return report;
    }),
  );
});

export type FsckCheck = StoreCheck;

const status = (ok: boolean): FsckCheck["status"] => (ok ? "ok" : "fail");

class RollbackProbe extends Data.TaggedError("RollbackProbe")<{
  readonly checksum: string;
  readonly deferred: boolean;
}> {}

/**
 * Checks the store against itself: SQLite integrity and foreign keys, every envelope against its
 * schema, canonical form and fingerprint, index rows against attribution, jobs against the events
 * that enqueue them, projections against a rebuild in a savepoint that is rolled back, and the
 * computation store (references, bindings, inline blobs). All of that runs in one transaction, so
 * every check sees the same state. File blobs are then re-hashed outside it: they never change once
 * written, and reading them must not hold the write lock.
 */
export const fsck = (location: StoreLocation) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const { checks, blobs, removals } = yield* sql.withTransaction(fsckChecks);
    return [...checks, yield* blobFileCheck(location, blobs, removals)];
  });

const fsckChecks = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* assertCompatible;
  const checks: Array<FsckCheck> = [];

  const integrity = yield* sql<{
    integrityCheck: string;
  }>`PRAGMA integrity_check`;
  const integrityOk =
    integrity.length === 1 && integrity[0]?.integrityCheck === "ok";
  const foreignKeys = yield* sql<
    Record<string, unknown>
  >`PRAGMA foreign_key_check`;
  checks.push({
    name: "sqlite foreign_key_check",
    status: status(foreignKeys.length === 0),
    detail:
      foreignKeys.length === 0
        ? "no violations"
        : `${foreignKeys.length} violation(s)`,
  });
  checks.push({
    name: "sqlite integrity_check",
    status: status(integrityOk),
    detail: integrity.map((r) => r.integrityCheck).join("; "),
  });

  const events = yield* sql<{
    seq: number;
    id: string;
    kind: string;
    idempotencyKey: string;
    fingerprint: string;
    actorId: string;
    envelope: string;
  }>`SELECT seq, id, kind, idempotency_key, fingerprint, actor_id, envelope FROM events ORDER BY seq`;
  const unitIndex = yield* sql<{
    eventSeq: number;
    unitId: string;
  }>`SELECT event_seq, unit_id FROM event_units`;
  const cycleIndex = yield* sql<{
    eventSeq: number;
    cycleId: string;
  }>`SELECT event_seq, cycle_id FROM event_cycles`;
  const jobRows = yield* sql<
    Record<string, unknown>
  >`SELECT job_seq, kind, dedupe_key, event_id, payload, state, run_at, attempts, stalls,
    enqueued_at, started_at, finished_at, last_error FROM jobs`;
  const jobs: Array<JobRow> = [];
  const jobProblems: Array<string> = [];
  // A newer build's job kinds are its own to check (8.19). This build counts them and keeps their
  // dedupe keys, so an event whose job that build enqueued under its own kind still has its job.
  const newerJobs = new Set<string>();
  for (const row of jobRows) {
    if (typeof row["kind"] === "string" && !isKnownJobKind(row["kind"])) {
      if (typeof row["dedupeKey"] === "string") newerJobs.add(row["dedupeKey"]);
      else jobProblems.push(`job ${String(row["jobSeq"])}: no dedupe key`);
      continue;
    }
    const parsed = safeRead(JobRow, row);
    if (parsed.success) jobs.push(parsed.data);
    else
      jobProblems.push(`job ${String(row["jobSeq"])}: ${parsed.error.message}`);
  }
  const key = (seq: number, id: string) => `${seq}\u0000${id}`;
  const indexedUnits = new Set(
    unitIndex.map((row) => key(row.eventSeq, row.unitId)),
  );
  const indexedCycles = new Set(
    cycleIndex.map((row) => key(row.eventSeq, row.cycleId)),
  );
  const jobKeys = new Map(jobs.map((job) => [job.dedupeKey, job.eventId]));

  const envelopeProblems: Array<string> = [];
  const indexProblems: Array<string> = [];
  let expectedUnitRows = 0;
  let expectedCycleRows = 0;
  const references: Array<{ seq: number; ref: Reference }> = [];
  const eventIds = new Set<string>();
  // A newer build's events (8.19): checked for what every envelope must hold, and indexed by their
  // attribution like any other event.
  const newerEvents = new Set<number>();
  const expectIndexed = (
    seq: number,
    unitIds: ReadonlyArray<string>,
    cycleId: string | undefined,
  ) => {
    for (const unitId of unitIds) {
      expectedUnitRows += 1;
      if (!indexedUnits.has(key(seq, unitId)))
        indexProblems.push(`seq ${seq}: unit ${unitId} not indexed`);
    }
    if (cycleId !== undefined) {
      expectedCycleRows += 1;
      if (!indexedCycles.has(key(seq, cycleId)))
        indexProblems.push(`seq ${seq}: cycle not indexed`);
    }
  };
  for (const row of events) {
    eventIds.add(row.id);
    const decoded = yield* Effect.result(
      decodeStoredEvent(row, `seq ${row.seq}`),
    );
    if (decoded._tag === "Failure") {
      envelopeProblems.push(decoded.failure.message);
      continue;
    }
    if (Option.isNone(decoded.success)) {
      newerEvents.add(row.seq);
      const newer = checkNewerRow(row, `seq ${row.seq}`);
      envelopeProblems.push(...newer.problems);
      expectIndexed(row.seq, newer.unitIds, newer.cycleId);
      continue;
    }
    const event = decoded.success.value;
    if (canonicalJson(eventWithStoredFields(row.envelope)) !== row.envelope)
      envelopeProblems.push(`seq ${row.seq}: envelope is not canonical`);
    if (fingerprintOf(eventWithStoredFields(row.envelope)) !== row.fingerprint)
      envelopeProblems.push(`seq ${row.seq}: fingerprint mismatch`);
    if (
      event.id !== row.id ||
      event.kind !== row.kind ||
      event.idempotencyKey !== row.idempotencyKey ||
      event.actor !== row.actorId
    ) {
      envelopeProblems.push(
        `seq ${row.seq}: columns disagree with the envelope`,
      );
    }
    expectIndexed(
      row.seq,
      event.attribution?.unitIds ?? [],
      event.attribution?.cycleId,
    );
    for (const job of jobsFor(event)) {
      // The newer build may have enqueued it under a kind of its own (`review.run@2`).
      if (
        job.optionalForIntegrity ||
        jobKeys.has(job.dedupeKey) ||
        newerJobs.has(job.dedupeKey)
      )
        continue;
      jobProblems.push(`seq ${row.seq}: job ${job.dedupeKey} missing`);
    }
    for (const ref of event.refs ?? []) references.push({ seq: row.seq, ref });
  }
  if (
    unitIndex.length !== expectedUnitRows ||
    cycleIndex.length !== expectedCycleRows
  ) {
    indexProblems.push(
      `index rows ${unitIndex.length}/${cycleIndex.length}, attribution implies ${expectedUnitRows}/${expectedCycleRows}`,
    );
  }
  const newerIndexRows = (rows: ReadonlyArray<{ eventSeq: number }>) =>
    rows.filter((row) => newerEvents.has(row.eventSeq)).length;
  for (const [dedupeKey, eventId] of jobKeys) {
    // A job enqueued by hand has no event.
    if (eventId !== null && !eventIds.has(eventId))
      jobProblems.push(`job ${dedupeKey} references missing event ${eventId}`);
  }
  const summarize = (problems: ReadonlyArray<string>, ok: string) =>
    problems.length === 0
      ? ok
      : `${problems.length} problem(s): ${problems.slice(0, 5).join("; ")}`;
  const left = (count: number) =>
    count === 0
      ? ""
      : `; ${count} of kinds this build does not know, left for a newer build`;
  checks.push({
    name: "envelopes parse, are canonical and match fingerprints",
    status: status(envelopeProblems.length === 0),
    detail: summarize(
      envelopeProblems,
      `${events.length - newerEvents.size} events${
        newerEvents.size === 0
          ? ""
          : `; ${newerEvents.size} of kinds this build does not know, left for a newer build after checking what every envelope holds`
      }`,
    ),
  });
  checks.push({
    name: "unit and cycle index rows match attribution",
    status: status(indexProblems.length === 0),
    detail: summarize(
      indexProblems,
      `${unitIndex.length} unit rows, ${cycleIndex.length} cycle rows${
        newerEvents.size === 0
          ? ""
          : `, ${newerIndexRows(unitIndex) + newerIndexRows(cycleIndex)} of them for events of kinds this build does not know, checked against their attribution`
      }`,
    ),
  });
  checks.push({
    name: "jobs match the events that enqueue them",
    status: status(jobProblems.length === 0),
    detail: summarize(
      jobProblems,
      `${jobs.length} jobs${left(newerJobs.size)}`,
    ),
  });

  const current = combinedChecksum(yield* projectionChecksums);
  const probe = yield* sql
    .withTransaction(
      Effect.gen(function* () {
        const replay = yield* rebuildProjections;
        return yield* new RollbackProbe({
          deferred: replay.deferred,
          checksum: combinedChecksum(yield* projectionChecksums),
        });
      }),
    )
    .pipe(Effect.flip);
  const rebuilt =
    probe._tag === "RollbackProbe"
      ? probe.checksum
      : `failed: ${probe.message}`;
  checks.push({
    name: "projections equal a rebuild (rolled back)",
    status:
      probe._tag === "RollbackProbe" && probe.deferred
        ? "skipped"
        : status(rebuilt === current),
    detail:
      probe._tag === "RollbackProbe" && probe.deferred
        ? "left to a newer build; stored projections unchanged"
        : rebuilt === current
          ? `checksum ${current}`
          : `stored ${current}, rebuilt ${rebuilt}`,
  });
  const store = yield* computationChecks(references);
  checks.push(...store.checks);
  return { checks, blobs: store.blobs, removals: store.removals };
});

export interface TableStats {
  readonly table: string;
  /** `newer`: a table this build does not declare, in a store a newer build's schema upgraded. */
  readonly role: TableRole | "sqlite" | "undeclared" | "newer";
  readonly rows: number;
  readonly bytes: number;
}

export interface StoreStats {
  readonly events: number;
  readonly envelopeBytes: number;
  readonly bytesPerEvent: {
    readonly envelope: number;
    readonly logPages: number;
    readonly allPages: number;
  };
  readonly unitIndexRows: number;
  readonly cycleIndexRows: number;
  readonly jobs: number;
  readonly tables: ReadonlyArray<TableStats>;
  readonly undeclaredTables: ReadonlyArray<string>;
  /**
   * Tables this build does not declare in a store whose schema is newer than this build's: the newer
   * build's own (8.19), which it checks; not a failure here.
   */
  readonly newerTables: ReadonlyArray<string>;
  /** Projection tables whose row count exceeds the distinct entities their key names; must be empty. */
  readonly stateCopies: ReadonlyArray<string>;
  /** Database size, blobs, computations, transcripts and token totals per agent. */
  readonly store: ComputationStats;
}

/** Entity-key counts per projection table, from the log; a projection with more rows is a state copy. */
const ENTITY_COUNTS: Readonly<Record<string, string>> = {
  projection_actors: `SELECT count(DISTINCT actor_id) AS n FROM events WHERE kind = 'actor.registered@1'`,
  projection_cycles: `SELECT count(*) AS n FROM events WHERE kind = 'cycle.opened@1'`,
  projection_batches: `SELECT count(DISTINCT json_extract(envelope, '$.attribution.batchId')) AS n FROM events WHERE kind = 'batch.recorded@1'`,
  projection_units: `SELECT count(DISTINCT unit_id) AS n FROM event_units`,
  projection_actor_activity: `SELECT count(DISTINCT actor_id) AS n FROM events WHERE kind IN
    ('session.started@1', 'session.ended@1', 'turn.started@1', 'turn.ended@1', 'turn.summarized@1',
    'commit.recorded@1')`,
  projection_dispositions: `SELECT count(*) AS n FROM events WHERE kind IN ('disposition.recorded@1', 'disposition.recorded@2')`,
  projection_supersessions: `SELECT count(*) AS n FROM events WHERE json_extract(envelope, '$.causation.supersedes') IS NOT NULL`,
  projection_comments: `SELECT count(*) AS n FROM events WHERE kind IN ('comment.recorded@1', 'comment.recorded@2')`,
  projection_context_references: `SELECT count(*) AS n FROM events WHERE kind IN ('context.referenced@1', 'context.referenced@2')`,
  projection_deliveries: `SELECT count(*) AS n FROM events WHERE kind = 'delivery.recorded@1'`,
  projection_feedback: `SELECT count(*) AS n FROM events WHERE kind IN ('feedback.recorded@1', 'feedback.recorded@2')`,
  projection_review_origins: `SELECT count(*) AS n FROM events WHERE kind = 'review.origin-recorded@1'`,
  projection_proofs: `SELECT count(*) AS n FROM events WHERE kind = 'proof.recorded@1'`,
  projection_packets: `SELECT count(*) AS n FROM events WHERE kind = 'packet.published@1'`,
  projection_gaps: `SELECT count(*) AS n FROM events WHERE kind = 'gap.disclosed@1'`,
  projection_stages: `SELECT count(*) AS n FROM events WHERE kind = 'stage.completed@1'`,
  projection_runs: `SELECT count(DISTINCT json_extract(envelope, '$.attribution.runId')) AS n FROM events WHERE kind = 'run.completed@1'`,
  projection_commits: `SELECT count(DISTINCT json_extract(envelope, '$.payload.oid')) AS n FROM events WHERE kind = 'commit.recorded@1'`,
  projection_commit_rewrites: `SELECT count(*) AS n FROM (SELECT DISTINCT json_extract(m.value, '$.from'), json_extract(m.value, '$.to')
    FROM events e, json_each(e.envelope, '$.payload.mappings') m WHERE e.kind = 'commit.rewritten@1')`,
};

/**
 * Sizes from SQLite's `dbstat` pages, per table including its indexes, the state-copy proof, and the
 * computation store: database and blob file sizes, transcripts as referenced blobs, token totals.
 */
export const stats = (location: StoreLocation) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* assertCompatible;
    const tables = yield* sql<{
      name: string;
    }>`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`;
    const pages = yield* sql<{
      tbl: string;
      bytes: number;
    }>`SELECT m.tbl_name AS tbl, sum(d.pgsize) AS bytes
    FROM dbstat d JOIN sqlite_master m ON m.name = d.name GROUP BY m.tbl_name`;
    const pageBytes = new Map(pages.map((row) => [row.tbl, row.bytes]));
    const roles: Readonly<Record<string, TableRole>> = TABLE_ROLES;
    const state = yield* readState;
    const newerSchema =
      state._tag === "Ready" && state.versions.schemaVersion > SCHEMA_VERSION;
    const tableStats: Array<TableStats> = [];
    const stateCopies: Array<string> = [];
    for (const { name } of tables) {
      const [count] = yield* sql.unsafe<{ n: number }>(
        `SELECT count(*) AS n FROM "${name}"`,
      );
      const rows = count?.n ?? 0;
      const role =
        roles[name] ??
        (name.startsWith("sqlite_")
          ? "sqlite"
          : newerSchema
            ? "newer"
            : "undeclared");
      tableStats.push({
        table: name,
        role,
        rows,
        bytes: pageBytes.get(name) ?? 0,
      });
      const entityQuery = ENTITY_COUNTS[name];
      if (role === "projection") {
        if (entityQuery === undefined) {
          stateCopies.push(`${name}: no entity count declared`);
          continue;
        }
        const [entities] = yield* sql.unsafe<{ n: number }>(entityQuery);
        if (rows > (entities?.n ?? 0))
          stateCopies.push(
            `${name}: ${rows} rows for ${entities?.n ?? 0} entities`,
          );
      }
    }
    const [log] = yield* sql<{
      events: number;
      envelopeBytes: number | null;
    }>`SELECT count(*) AS events,
    sum(length(CAST(envelope AS BLOB))) AS envelope_bytes FROM events`;
    const events = log?.events ?? 0;
    const envelopeBytes = log?.envelopeBytes ?? 0;
    const byRole = (role: string) =>
      tableStats
        .filter((t) => t.role === role)
        .reduce((sum, t) => sum + t.bytes, 0);
    const perEvent = (bytes: number) =>
      events === 0 ? 0 : Math.round(bytes / events);
    const find = (table: string) =>
      tableStats.find((t) => t.table === table)?.rows ?? 0;
    const report: StoreStats = {
      events,
      envelopeBytes,
      bytesPerEvent: {
        envelope: perEvent(envelopeBytes),
        logPages: perEvent(byRole("log") + byRole("index")),
        allPages: perEvent(tableStats.reduce((sum, t) => sum + t.bytes, 0)),
      },
      unitIndexRows: find("event_units"),
      cycleIndexRows: find("event_cycles"),
      jobs: find("jobs"),
      tables: tableStats,
      undeclaredTables: tableStats
        .filter((t) => t.role === "undeclared")
        .map((t) => t.table),
      newerTables: tableStats
        .filter((t) => t.role === "newer")
        .map((t) => t.table),
      stateCopies,
      store: yield* computationStats(location),
    };
    return report;
  });
