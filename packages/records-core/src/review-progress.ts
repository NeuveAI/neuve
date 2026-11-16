import { Data, Effect, Option } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { assertCompatible } from "./store.ts";
import { KNOWN_JOB_KINDS } from "./codec.ts";
import { isReviewRun, REVIEW_RUN_KINDS } from "./jobs.ts";

/**
 * How a requested review is getting on, for the web app's "Start a review" and its web events (M5
 * ST3, LV1): the newest review job, the stages its run has recorded as complete, and the log's
 * position counting only the events a person's screens show. Each is one indexed query, newest
 * first, so the cost does not grow with the queue or the log.
 */

/** The newest `review.run` job's sequence number, whatever its state. */
export const newestReviewJob = Effect.gen(function* () {
  yield* assertCompatible;
  const sql = yield* SqlClient;
  const [row] = yield* sql<{ seq: number }>`SELECT job_seq AS seq FROM jobs
    WHERE kind IN ('review.run', 'review.run@2') ORDER BY job_seq DESC LIMIT 1`;
  return Option.fromNullishOr(row?.seq);
}).pipe(Effect.withSpan("records.progress.newest-review-job"));

export interface OpenReviewJob {
  readonly seq: number;
  readonly state: string;
  readonly attempts: number;
}

/** The newest unfinished `review.run` jobs, newest first, at most `limit` of them. */
export const openReviewJobs = (limit: number) =>
  Effect.gen(function* () {
    yield* assertCompatible;
    const sql = yield* SqlClient;
    return yield* sql<OpenReviewJob>`SELECT job_seq AS seq, state, attempts FROM jobs
      WHERE kind IN ('review.run', 'review.run@2') AND state IN ('waiting', 'delayed', 'active')
      ORDER BY job_seq DESC LIMIT ${limit}`;
  }).pipe(Effect.withSpan("records.progress.open-review-jobs"));

/** The known job kinds that are never a review run: such a job says nothing about a cycle's run. */
const KNOWN_OTHER_JOB_KINDS = KNOWN_JOB_KINDS.filter(
  (kind) => !isReviewRun(kind),
);

/**
 * Whether a review run of `cycleId` is going or queued, for the desk's "not reviewed" count. Only
 * unfinished jobs (waiting, delayed or active) that are review runs or of a kind this build does not
 * know (8.19) are read; a known kind that is not a review run never changes the answer.
 *
 * - `true` when one of them is the newest review job of a `review.requested@1` event of the cycle
 *   and that request has no completed or timed-out receipt, which is how `ReviewList.reviews` reads
 *   a running run. This wins over `"unknown"`.
 * - `"unknown"` otherwise, when it cannot be told: one of them has no event or its event is in no
 *   cycle, so it may be this cycle's run; or it belongs to an event of the cycle whose kind is not
 *   `review.requested@1`, which may be a newer build's request; or it is of an unknown kind and
 *   belongs to a request of the cycle with no receipt, which may be a newer build's run. Also when
 *   the cycle has no `review.requested@1` event at all.
 * - `false` when none of that holds and the cycle has a `review.requested@1` event. A job whose
 *   event is in another cycle changes nothing here.
 *
 * Read from the jobs side, so the cost follows the unfinished jobs, not the cycle or the log: one
 * query over the queue's state index, each job's event, its cycle row (found by the cycle its
 * attribution names, as the append wrote it), receipt and any newer review job each through an
 * index; then, only when that settles nothing, whether the cycle has a request, which stops at the
 * cycle's first one.
 *
 * Any run of the cycle counts, each request read as the review list reads a run. The list itself
 * shows only the cycle's newest run, so the two differ when an older run is still active beside a
 * newer one that completed: the list shows "completed" and this answers `true`, because a run of
 * the cycle is still going and may still append to it.
 */
export const cycleRunGoing = (cycleId: string) =>
  Effect.gen(function* () {
    yield* assertCompatible;
    const sql = yield* SqlClient;
    const jobs = yield* sql<{
      kind: string;
      eventKind: string | null;
      cycleId: string | null;
      outcome: string | null;
      superseded: number;
    }>`SELECT j.kind, e.kind AS event_kind, c.cycle_id, r.outcome,
        EXISTS (SELECT 1 FROM jobs n WHERE n.event_id = j.event_id
          AND ${sql.in("n.kind", REVIEW_RUN_KINDS)} AND n.job_seq > j.job_seq) AS superseded
      FROM jobs j
      LEFT JOIN events e ON e.id = j.event_id
      LEFT JOIN event_cycles c ON c.event_seq = e.seq AND c.cycle_id =
        CASE WHEN json_valid(e.envelope) THEN json_extract(e.envelope, '$.attribution.cycleId') END
      LEFT JOIN projection_runs r ON r.run_id = j.event_id
      WHERE j.state IN ('waiting', 'delayed', 'active')
        AND NOT ${sql.in("j.kind", KNOWN_OTHER_JOB_KINDS)}`;
    let unknown = false;
    for (const job of jobs) {
      // No event, or an event in no cycle: it may be this cycle's run.
      if (job.cycleId === null) unknown = true;
      else if (job.cycleId !== cycleId) continue;
      else if (job.eventKind !== "review.requested@1") unknown = true;
      else if (job.outcome === "completed" || job.outcome === "timed-out")
        continue;
      else if (!isReviewRun(job.kind)) unknown = true;
      else if (job.superseded === 0) return true;
    }
    if (unknown) return "unknown" as const;
    // CROSS JOIN keeps SQLite on the cycle's own index rows, which reach the cycle's first request
    // after its opening events, rather than on every request in the log through the kind index.
    const [request] = yield* sql<{ found: number }>`SELECT 1 AS found
      FROM event_cycles c CROSS JOIN events e ON e.seq = c.event_seq
      WHERE c.cycle_id = ${cycleId} AND e.kind = 'review.requested@1' LIMIT 1`;
    return request === undefined ? ("unknown" as const) : false;
  }).pipe(Effect.withSpan("records.progress.cycle-run-going"));

export interface StageCompletions {
  /** The stage as the run attributed it: `investigate` for `investigate.plan` and each partition. */
  readonly stage: string;
  readonly completions: number;
  /** The log position of its first and its latest completion. */
  readonly firstSeq: number;
  readonly lastSeq: number;
}

/**
 * Each stage a run has recorded a completion for (`stage.completed@1`), in the order its first
 * completion was appended. A stage's work is recorded in parts (a plan step, then each partition),
 * so one completion does not mean the stage is done. `stageProgress` joins these completions to
 * starts when deciding which work is still running.
 */
export const stageCompletions = (runId: string) =>
  Effect.gen(function* () {
    yield* assertCompatible;
    const sql = yield* SqlClient;
    return yield* sql<StageCompletions>`SELECT
        json_extract(envelope, '$.attribution.stage') AS stage,
        count(*) AS completions, min(seq) AS first_seq, max(seq) AS last_seq
      FROM events
      WHERE kind = 'stage.completed@1'
        AND json_extract(envelope, '$.attribution.runId') = ${runId}
      GROUP BY stage ORDER BY first_seq`;
  }).pipe(Effect.withSpan("records.progress.stage-completions"));

/** Started work wins over completed work; legacy completions advance to the next known stage. */
export const stageProgress = (runId: string, stages: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    yield* assertCompatible;
    const sql = yield* SqlClient;
    const rows = yield* sql<{
      kind: string;
      stage: string;
      agent: string;
      seq: number;
      status: string | null;
    }>`
      SELECT kind, json_extract(envelope, '$.attribution.stage') AS stage,
        json_extract(envelope, '$.payload.agent') AS agent, json_extract(envelope, '$.payload.status') AS status, seq
      FROM events WHERE kind IN ('stage.started@1', 'stage.completed@1')
        AND json_extract(envelope, '$.attribution.runId') = ${runId} ORDER BY seq`;
    const active = new Map<string, string>();
    const successful = new Set<string>();
    const incomplete = new Set<string>();
    const completed = new Set<string>();
    let started: string | undefined;
    let legacy: string | undefined;
    for (const row of rows) {
      if (row.kind === "stage.started@1") {
        active.set(row.agent, row.stage);
        started = row.stage;
      } else {
        active.delete(row.agent);
        if (row.status === "skipped" || row.status === "interrupted")
          incomplete.add(row.stage);
        else {
          successful.add(row.stage);
          legacy = row.stage;
        }
      }
      // Replay the high-water mark. Later dynamically created agents cannot undo recorded progress.
      if (
        successful.has(row.stage) &&
        !incomplete.has(row.stage) &&
        ![...active.values()].includes(row.stage)
      )
        completed.add(row.stage);
    }
    const name = started ?? legacy;
    return name === undefined
      ? null
      : {
          name,
          done: stages.filter((stage) => completed.has(stage)).length,
          of: stages.length,
        };
  }).pipe(Effect.withSpan("records.progress.stage-progress"));

/**
 * The event kinds a person's screens show: a review's request, its stages and receipt, the published
 * packet, and people's and agents' dispositions, comments and feedback. Agent turns, vents and
 * telemetry move the log without changing any of them.
 */
export const REVIEW_EVENT_KINDS = [
  "review.requested@1",
  "stage.started@1",
  "stage.completed@1",
  "run.completed@1",
  "packet.published@1",
  "packet.published@2",
  "disposition.recorded@1",
  "disposition.recorded@2",
  "disposition.carried@1",
  "disposition.retracted@1",
  "comment.recorded@1",
  "comment.recorded@2",
  "comment.carried@1",
  "comment.recorded@3",
  "feedback.recorded@1",
  "feedback.recorded@2",
] as const;

/** The log's position counting only `REVIEW_EVENT_KINDS`; 0 before any of them. */
export const reviewSequence = Effect.gen(function* () {
  yield* assertCompatible;
  const sql = yield* SqlClient;
  // One indexed lookup per kind (events_kind is on kind, seq), never a scan of the log.
  const latest = yield* Effect.forEach(REVIEW_EVENT_KINDS, (kind) =>
    Effect.map(
      sql<{
        seq: number | null;
      }>`SELECT max(seq) AS seq FROM events WHERE kind = ${kind}`,
      ([row]) => row?.seq ?? 0,
    ),
  );
  return Math.max(0, ...latest);
}).pipe(Effect.withSpan("records.progress.review-sequence"));

/** A review mark that is not a log position: negative, fractional or not a number. */
export class InvalidReviewMark extends Data.TaggedError("InvalidReviewMark")<{
  readonly message: string;
}> {}

/**
 * Past this many review events between two marks, `changedCycles` answers `"all"`. Each kind's read
 * is one range of the kind index, limited to the events still allowed, and each event found costs
 * one envelope read and one lookup in the cycle index, so a call reads at most this many events
 * plus one per kind whatever the log holds. A wake that moved more of them than this is a whole
 * review landing (its stages, packet and dispositions), when reloading every page costs less than
 * naming them.
 */
export const CHANGED_CYCLES_BOUND = 256;

/**
 * The distinct cycles of the `REVIEW_EVENT_KINDS` events with `seq` in `(after, upTo]`, the two
 * marks `reviewSequence` gave; `"all"` when one of them has no cycle or there are more than
 * `CHANGED_CYCLES_BOUND`, never a partial list. A cycle is the event's `event_cycles` row. That
 * table's key leads with the cycle, so the row is found by the cycle the event's attribution names
 * (the value the append wrote to it) and its seq; an event without that row has no cycle.
 */
export const changedCycles = (after: number, upTo: number) =>
  Effect.gen(function* () {
    for (const [name, mark] of [
      ["after", after],
      ["upTo", upTo],
    ] as const)
      if (!Number.isSafeInteger(mark) || mark < 0)
        return yield* new InvalidReviewMark({
          message: `${name} must be a log position (a non-negative integer), not ${mark}`,
        });
    yield* assertCompatible;
    if (after >= upTo) return [] as ReadonlyArray<string>;
    const sql = yield* SqlClient;
    const cycles = new Set<string>();
    let found = 0;
    for (const kind of REVIEW_EVENT_KINDS) {
      // One range of events_kind (kind, seq), one more row than the bound still allows.
      const rows = yield* sql<{ cycleId: string | null }>`SELECT c.cycle_id
        FROM events e LEFT JOIN event_cycles c
          ON c.cycle_id = json_extract(e.envelope, '$.attribution.cycleId') AND c.event_seq = e.seq
        WHERE e.kind = ${kind} AND e.seq > ${after} AND e.seq <= ${upTo}
        LIMIT ${CHANGED_CYCLES_BOUND - found + 1}`;
      found += rows.length;
      if (found > CHANGED_CYCLES_BOUND) return "all" as const;
      for (const row of rows) {
        if (row.cycleId === null) return "all" as const;
        cycles.add(row.cycleId);
      }
    }
    return [...cycles].sort() as ReadonlyArray<string>;
  }).pipe(Effect.withSpan("records.progress.changed-cycles"));
