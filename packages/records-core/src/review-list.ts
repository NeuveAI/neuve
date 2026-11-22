import { Effect, Option } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { Lane } from "@neuve/records-schema";
import { dispositionRowsOn, liveDisposition } from "./dispositions.ts";
import { CorruptRecord } from "./errors.ts";
import { toStored } from "./log.ts";
import { standingManifest } from "./published-packets.ts";
import { assertCompatible } from "./store.ts";

/**
 * The repository's reviews for the web app's Reviews page: every cycle a run was started for,
 * newest run first, with where its newest run stands and its packet of record's batches and units.
 * Each listed cycle costs indexed lookups and one manifest blob read, never the whole packet.
 * Choosing a page groups every counted review request in the store (through the events' kind
 * index), so that step grows with the requests ever made; a page's other work does not. People's
 * standing decisions and whether anyone gave feedback are read apart.
 */

/** Where a review's newest run stands. */
export type ReviewState = "running" | "completed" | "timed-out" | "failed";

export interface ListedUnit {
  readonly unitId: string;
  /** Its current lane; null while the review never assessed it. */
  readonly lane: Lane | null;
}

export interface ListedBatch {
  readonly batchId: string;
  /** Undefined when Records holds no `batch.recorded` for it. */
  readonly title: string | undefined;
  /** In the manifest's order. */
  readonly units: ReadonlyArray<ListedUnit>;
}

export interface ListedReview {
  readonly cycleId: string;
  readonly range: {
    readonly baseRef: string;
    readonly baseOid: string;
    readonly headOid: string;
  };
  /** The newest run's ID: the review request that started it. */
  readonly runId: string;
  readonly state: ReviewState;
  /**
   * When that run ended (its receipt, or its job's end when it failed), started, or was requested,
   * whichever is the latest it has.
   */
  readonly at: string;
  /** The packet of record's batches in the manifest's order; empty while the cycle has none. */
  readonly batches: ReadonlyArray<ListedBatch>;
  /** Why the packet of record's manifest could not be read, when it could not. */
  readonly manifestIssue: string | undefined;
  /**
   * Batches and sections still being judged, from the packet of record's `counts.pending` when it
   * is a `packet.published@2`; 0 for a `packet.published@1` or no packet. Always set by `reviews`;
   * optional only so callers that build a listed review themselves need not change.
   */
  readonly pendingBatches?: number;
  readonly pendingSections?: number;
}

/** The most reviews one read returns. */
export const LIMIT_MAX = 200;

/** IDs per `IN` list, well under SQLite's bound on host parameters. */
const PAGE = 500;

const pages = <T>(items: ReadonlyArray<T>) =>
  Array.from({ length: Math.ceil(items.length / PAGE) }, (_, index) =>
    items.slice(index * PAGE, (index + 1) * PAGE),
  );

const stateOf = (
  receipt: { readonly outcome: string } | undefined,
  job: { readonly state: string } | undefined,
): ReviewState | undefined => {
  if (receipt?.outcome === "completed" || receipt?.outcome === "timed-out")
    return receipt.outcome;
  if (job === undefined) return undefined;
  if (job.state === "failed") return "failed";
  // A finished job whose receipt is not in yet still has work to append.
  return job.state === "completed" ? "completed" : "running";
};

const corrupt = (message: string) =>
  Effect.fail(new CorruptRecord({ message: `review list: ${message}` }));

export interface ReviewPage {
  readonly reviews: ReadonlyArray<ListedReview>;
  /** Pass as `before` for the next, older page; undefined on the last page. */
  readonly next: number | undefined;
  /** How many reviews this read pages through: every one, or those older than `before`. */
  readonly total: number;
}

/**
 * Reviews newest run first, a page of at most `limit` (1 to `LIMIT_MAX`), older than the cursor
 * `before` when one is given. A review request counts as a run only when it enqueued the run's job
 * or has a receipt, as `ReviewStats.latestRun` reads it: a request that joined a running job or
 * found its range reviewed starts nothing. A review whose newest run started after the first page
 * was read moves to the top, so a later page never repeats it. `offset` skips that many reviews
 * first, for numbered pages; it pages by position, so a review re-run between two reads shifts the
 * others by one. A `limit` that is not a finite number reads one page of `LIMIT_MAX`; a `before` or
 * `offset` that is not one reads from the newest. `cycleId` reads that one review, wherever it
 * stands.
 */
export const reviews = (options: {
  readonly limit: number;
  readonly before?: number | undefined;
  readonly offset?: number | undefined;
  readonly cycleId?: string | undefined;
}) =>
  Effect.gen(function* () {
    yield* assertCompatible;
    const sql = yield* SqlClient;
    const limit = Number.isFinite(options.limit)
      ? Math.max(1, Math.min(LIMIT_MAX, Math.trunc(options.limit)))
      : LIMIT_MAX;
    const before =
      options.before !== undefined && Number.isFinite(options.before)
        ? options.before
        : null;
    const offset =
      options.offset !== undefined && Number.isFinite(options.offset)
        ? Math.max(0, Math.trunc(options.offset))
        : 0;
    const cycle = options.cycleId ?? null;
    // One row more than the page tells whether an older page exists; the window counts every
    // review the read pages through, in the same grouping pass.
    const runs = yield* sql<{
      cycleId: string;
      seq: number;
      total: number;
    }>`SELECT json_extract(e.envelope, '$.attribution.cycleId') AS cycle_id, max(e.seq) AS seq,
        count(*) OVER () AS total
      FROM events e
      WHERE e.kind = 'review.requested@1'
        AND (EXISTS (SELECT 1 FROM jobs j WHERE j.event_id = e.id AND j.kind IN ('review.run', 'review.run@2'))
          OR EXISTS (SELECT 1 FROM projection_runs r WHERE r.run_id = e.id))
        AND (${cycle} IS NULL OR json_extract(e.envelope, '$.attribution.cycleId') = ${cycle})
      GROUP BY cycle_id HAVING ${before} IS NULL OR max(e.seq) < ${before}
      ORDER BY seq DESC LIMIT ${limit + 1} OFFSET ${offset}`;
    const page = runs.slice(0, limit);
    // Past the last review no row carries the window's count, so it is read on its own.
    const total =
      runs[0]?.total ??
      (offset === 0
        ? 0
        : ((yield* sql<{
            total: number;
          }>`SELECT count(*) AS total FROM (SELECT max(e.seq) AS seq FROM events e
              WHERE e.kind = 'review.requested@1'
                AND (EXISTS (SELECT 1 FROM jobs j WHERE j.event_id = e.id AND j.kind IN ('review.run', 'review.run@2'))
                  OR EXISTS (SELECT 1 FROM projection_runs r WHERE r.run_id = e.id))
                AND (${cycle} IS NULL OR json_extract(e.envelope, '$.attribution.cycleId') = ${cycle})
              GROUP BY json_extract(e.envelope, '$.attribution.cycleId')
              HAVING ${before} IS NULL OR max(e.seq) < ${before})`)[0]?.total ??
          0));
    const listed: Array<ListedReview> = [];
    for (const { cycleId, seq } of page) {
      const [request] = yield* sql<{
        id: string;
        occurredAt: string;
        baseRef: string;
        baseOid: string;
        headOid: string;
      }>`SELECT id, occurred_at,
          json_extract(envelope, '$.attribution.range.baseRef') AS base_ref,
          json_extract(envelope, '$.attribution.range.baseOid') AS base_oid,
          json_extract(envelope, '$.attribution.range.headOid') AS head_oid
        FROM events WHERE seq = ${seq}`;
      if (request === undefined) return yield* corrupt(`no event at ${seq}`);
      const [receipt] = yield* sql<{
        outcome: string;
        endedAt: string;
      }>`SELECT outcome, ended_at FROM projection_runs WHERE run_id = ${request.id}`;
      const [job] = yield* sql<{
        state: string;
        startedAt: string | null;
        finishedAt: string | null;
      }>`SELECT state, started_at, finished_at FROM jobs
        WHERE event_id = ${request.id} AND kind IN ('review.run', 'review.run@2') ORDER BY job_seq DESC LIMIT 1`;
      const state = stateOf(receipt, job);
      if (state === undefined)
        return yield* corrupt(
          `run ${request.id} has neither a job nor a receipt`,
        );
      const at =
        receipt?.endedAt ??
        job?.finishedAt ??
        job?.startedAt ??
        request.occurredAt;
      const standing = yield* standingManifest(cycleId);
      const manifest = standing?.manifest;
      const manifestBatches = manifest?.batches ?? [];
      const batchIds = manifestBatches.map((batch) => batch.batchId);
      const unitIds = manifestBatches.flatMap((batch) =>
        batch.units.map((unit) => unit.unitId),
      );
      const titles = new Map<string, string>();
      for (const page of pages(batchIds)) {
        const rows = yield* sql<{
          batchId: string;
          title: string;
        }>`SELECT batch_id, title FROM projection_batches WHERE ${sql.in("batch_id", page)}`;
        for (const row of rows) titles.set(row.batchId, row.title);
      }
      const lanes = new Map<string, Lane | null>();
      for (const page of pages(unitIds)) {
        const rows = yield* sql<{
          unitId: string;
          lane: string | null;
        }>`SELECT unit_id, lane FROM projection_units WHERE ${sql.in("unit_id", page)}`;
        for (const row of rows) {
          if (row.lane === null) {
            lanes.set(row.unitId, null);
            continue;
          }
          const lane = Lane.safeParse(row.lane);
          if (!lane.success)
            return yield* corrupt(`unit ${row.unitId} has lane ${row.lane}`);
          lanes.set(row.unitId, lane.data);
        }
      }
      listed.push({
        cycleId,
        range: {
          baseRef: request.baseRef,
          baseOid: request.baseOid,
          headOid: request.headOid,
        },
        runId: request.id,
        state,
        at,
        batches: manifestBatches.map((batch) => ({
          batchId: batch.batchId,
          title: titles.get(batch.batchId),
          units: batch.units.map((unit) => ({
            unitId: unit.unitId,
            lane: lanes.get(unit.unitId) ?? null,
          })),
        })),
        manifestIssue: standing?.issue,
        pendingBatches:
          standing?.packet.kind === "packet.published@2"
            ? standing.packet.payload.counts.pending.batches
            : 0,
        pendingSections:
          standing?.packet.kind === "packet.published@2"
            ? standing.packet.payload.counts.pending.sections
            : 0,
      });
    }
    return {
      reviews: listed,
      next: runs.length > limit ? page.at(-1)?.seq : undefined,
      total,
    } satisfies ReviewPage;
  }).pipe(Effect.withSpan("records.review-list.reviews"));

export interface Decided {
  readonly unitId: string;
  readonly cycleId: string;
  readonly verdict: string;
}

/**
 * The statement `decided` runs for a page of unit IDs (at most 500, never empty), so a test can
 * read its plan: each person's current dispositions on those units, in every cycle.
 */
export const decidedQuery = (unitIds: ReadonlyArray<string>) =>
  Effect.map(SqlClient, (sql) => {
    const live = (alias: string) => sql.literal(liveDisposition(alias));
    return sql<
      Decided & { eventId: string }
    >`WITH all_dispositions AS (${dispositionRowsOn(sql, unitIds)})
      SELECT d.unit_id, d.cycle_id, d.verdict, d.event_id
      FROM all_dispositions d
      JOIN projection_actors a ON a.actor_id = d.actor_id AND a.actor_kind = 'human'
      WHERE ${live("d")}
        AND d.event_id = (SELECT max(n.event_id) FROM all_dispositions n
          WHERE n.unit_id = d.unit_id AND n.cycle_id = d.cycle_id AND n.actor_id = d.actor_id
            AND ${live("n")})`;
  });

/**
 * The standing human decision on each of `units` in its cycle (10.127): among the current
 * dispositions of registered people, the newest by ULID. A person's current disposition is their
 * newest that they neither superseded nor retracted, as `Dispositions.current` reads it, over the
 * same rows: recorded ones and the decisions carried onto a unit (`disposition.carried@1`), so a
 * unit a person's carried decision closes is not listed as waiting. An agent's
 * or an unregistered actor's disposition is not one. Rows are found by unit inside the rows the
 * statement shares (`Dispositions.dispositionRowsOn`), through the dispositions' (unit, cycle,
 * actor) index and the log's unit index; a unit no person decided is absent. Each unit belongs to
 * one cycle, so `units` names each unit once; the answer keeps their order.
 */
export const decided = (
  units: ReadonlyArray<{ readonly unitId: string; readonly cycleId: string }>,
) =>
  Effect.gen(function* () {
    yield* assertCompatible;
    const cycleOf = new Map(units.map((unit) => [unit.unitId, unit.cycleId]));
    const standing = new Map<string, Decided & { readonly eventId: string }>();
    for (const page of pages([...cycleOf.keys()])) {
      const rows = yield* yield* decidedQuery(page);
      for (const row of rows) {
        if (cycleOf.get(row.unitId) !== row.cycleId) continue;
        const known = standing.get(row.unitId);
        if (known === undefined || row.eventId > known.eventId)
          standing.set(row.unitId, row);
      }
    }
    // In the order `units` names them.
    return [...cycleOf.keys()].flatMap((unitId): Array<Decided> => {
      const row = standing.get(unitId);
      return row === undefined
        ? []
        : [{ unitId, cycleId: row.cycleId, verdict: row.verdict }];
    });
  }).pipe(Effect.withSpan("records.review-list.decided"));

/**
 * The cycles among `cycleIds` where anyone gave feedback (10.100, 10.127), read through the
 * feedback projection's (cycle, actor) index.
 */
export const feedbackGiven = (cycleIds: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    yield* assertCompatible;
    const sql = yield* SqlClient;
    const given = new Set<string>();
    for (const page of pages([...new Set(cycleIds)])) {
      const rows = yield* sql<{
        cycleId: string;
      }>`SELECT DISTINCT cycle_id FROM projection_feedback
        WHERE ${sql.in("cycle_id", page)}`;
      for (const row of rows) given.add(row.cycleId);
    }
    return given;
  }).pipe(Effect.withSpan("records.review-list.feedback-given"));

/**
 * When the repository's default list was last cleared ("Clear"), as its event's `occurredAt`; none
 * when it never was, or the latest clear was undone (`restore`). One read through the events' kind
 * index.
 */
export const cleared = Effect.gen(function* () {
  yield* assertCompatible;
  const sql = yield* SqlClient;
  const [row] = yield* sql<{
    seq: number;
    recordedAt: string;
    kind: string;
    envelope: string;
  }>`SELECT seq, recorded_at, kind, envelope FROM events
    WHERE kind = 'review-list.cleared@1' ORDER BY seq DESC LIMIT 1`;
  if (row === undefined) return undefined;
  const stored = yield* toStored(row);
  if (Option.isNone(stored)) return undefined;
  const event = stored.value.event;
  if (event.kind !== "review-list.cleared@1" || event.payload.restore)
    return undefined;
  return event.occurredAt;
}).pipe(Effect.withSpan("records.review-list.cleared"));
