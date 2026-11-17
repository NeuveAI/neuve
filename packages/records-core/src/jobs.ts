import { Duration, Schedule } from "effect";
import type { JobKind, JobSlot, RecordEvent } from "@neuve/records-schema";

export interface JobRequest {
  readonly kind: JobKind;
  /** Unique across the queue; a second request with the same key is the same job. */
  readonly dedupeKey: string;
  /** Rebuildable preparation added after historical events were written. */
  readonly optionalForIntegrity?: true;
}

/** The jobs an event enqueues, in the event's own append transaction (D16, 8.12). */
export const jobsFor = (event: RecordEvent): ReadonlyArray<JobRequest> => {
  switch (event.kind) {
    case "capture.filed@1":
      return [
        {
          kind: "capture.scan",
          dedupeKey: `capture.scan:${event.payload.rawCapture}`,
        },
      ];
    case "commit.recorded@1":
      return [
        {
          kind: "commit.prepare",
          dedupeKey: `commit.prepare:${event.payload.oid}`,
        },
      ];
    case "commit.rewritten@1":
      return [
        {
          kind: "commit.prepare@2",
          dedupeKey: `commit.prepare@2:rewrite:${event.idempotencyKey}`,
          optionalForIntegrity: true,
        },
      ];
    case "turn.ended@1":
    case "session.ended@1":
      // Hooks before M2 S5 recorded no offset; such events have no segment to capture.
      return event.payload.transcriptPath !== undefined &&
        event.payload.transcriptOffset !== undefined
        ? [
            {
              kind: "transcript.capture",
              dedupeKey: `transcript.capture:${event.id}`,
            },
          ]
        : [];
    case "review.requested@1":
      // A second request for the same run key and generation is the same job (10.13). The stack
      // fetch refreshes the range's stack sources, within the head-only budget (11.15); it does
      // nothing where stack sources are not set up.
      return [
        {
          // Not `review.run`, which builds before 12.24 would take (see `REVIEW_RUN_KINDS`).
          kind: "review.run@2",
          dedupeKey: `review.run:${event.payload.runKey}:${event.payload.generation}`,
        },
        {
          kind: "stack.fetch",
          dedupeKey: `stack.fetch:review:${event.payload.runKey}:${event.payload.generation}`,
        },
        {
          kind: "commit.prepare@2",
          dedupeKey: `commit.prepare:discover:${event.attribution.range.baseOid}:${event.attribution.range.headOid}`,
          optionalForIntegrity: true,
        },
      ];
    case "judgement.preparation.requested@1":
      return [
        {
          kind: "judgement.prepare@1",
          dedupeKey: `judgement.prepare:${event.payload.runKey}`,
        },
      ];
    case "cycle.opened@1":
      // One scope snapshot per cycle (3.12, 10.53): a second opening event of the cycle joins it.
      return [
        {
          kind: "scope.fetch",
          dedupeKey: `scope.fetch:${event.attribution.cycleId}`,
        },
      ];
    default:
      return [];
  }
};

/**
 * How the queue treats one kind of job (8.12). Nothing here is a lease: `deadline` bounds one
 * attempt inside the worker, and `stallLimit` bounds how often a dead worker may leave the job
 * active before it fails. `slot`, `priority` and `order` decide which waiting job the worker takes
 * next (10.31); they are read when a job is taken, so changing them needs no migration.
 */
export interface JobPolicy {
  /** The worker slot that runs the kind: `interactive` for review runs, `background` otherwise. */
  readonly slot: JobSlot;
  /** Within its slot, a lower number is taken first: 1 is the most urgent. */
  readonly priority: number;
  /** Among waiting jobs of the kind: `oldest` first (enqueue order) or `newest` first. */
  readonly order: "oldest" | "newest";
  /** Attempts in total, counting a stalled attempt; the last failure is final. */
  readonly maxAttempts: number;
  /**
   * Delays between attempts: step `n` gives the delay after the `n`th failed attempt. The delay is
   * written to `run_at`, so it survives a worker restart. A schedule that ends stops retrying.
   */
  readonly backoff: Schedule.Schedule<unknown, unknown>;
  /** One attempt is interrupted and handled as a failure after this long. */
  readonly deadline: Duration.Duration;
  /** Recoveries allowed after a dead worker left the job active; one more fails the job. */
  readonly stallLimit: number;
  /**
   * The job reads its event's whole cycle, so a worker whose build does not know every kind in that
   * cycle holds it for a newer build instead of running without them (12.24).
   */
  readonly wholeCycle?: true;
}

/**
 * The longest lifetime a review run may be frozen with: research runs over large trees set up to
 * this in their settings (`review.deadline`), while the owner's reviews keep the 10-minute default.
 */
const REVIEW_RUN_MAX_DEADLINE = Duration.minutes(30);

/** Exponential delays from `base`, doubling, each jittered to between 80 % and 120 %. */
const exponentialWithJitter = (base: Duration.Input) =>
  Schedule.exponential(base, 2).pipe(Schedule.jittered);

/**
 * Both kinds a review run is enqueued under: `review.run` by builds before 12.24, which this build
 * still runs, and `review.run@2` by this build, which builds before it never take.
 */
export const REVIEW_RUN_KINDS = ["review.run", "review.run@2"] as const;
export const isReviewRun = (kind: string) =>
  (REVIEW_RUN_KINDS as ReadonlyArray<string>).includes(kind);

// One review run (10.13). Its deadline is the longest lifetime a run may be frozen with
// (`REVIEW_RUN_MAX_DEADLINE`); the handler stops each attempt at its own run's lifetime, 10
// minutes unless the requester's settings name a longer one (10.26), so this bounds only a
// handler that failed to stop. The run keeps its own clock from its first attempt and stops new
// work 15 s before its lifetime ends (10.42), so the handler's stop bounds an attempt that resumed
// late. A failed attempt is usually the provider (preflight, overload): a few spaced retries, each
// resuming the run from its stored stages and turns (10.14). The only interactive work: a review
// never waits behind background work (10.31).
const REVIEW_RUN_POLICY: JobPolicy = {
  slot: "interactive",
  priority: 1,
  order: "oldest",
  maxAttempts: 3,
  backoff: exponentialWithJitter("15 seconds"),
  deadline: REVIEW_RUN_MAX_DEADLINE,
  stallLimit: 2,
  wholeCycle: true,
};

const { wholeCycle: _reviewWholeCycle, ...BACKGROUND_JUDGEMENT_POLICY } =
  REVIEW_RUN_POLICY;

export const JOB_POLICIES: Readonly<Record<JobKind, JobPolicy>> = {
  "judgement.prepare@1": {
    ...BACKGROUND_JUDGEMENT_POLICY,
    slot: "background",
    priority: 5,
    order: "newest",
  },
  "capture.scan": {
    slot: "capture",
    priority: 2,
    order: "oldest",
    maxAttempts: 3,
    backoff: exponentialWithJitter("5 seconds"),
    // Admission can use a minute before the full 30-minute scan, then child stop and sealing.
    deadline: Duration.minutes(33),
    stallLimit: 2,
  },
  // The harness's commit preparation (10.20, 10.75): hunks, symbols, the search index for changed
  // blobs, leads and change facts. The most urgent background work, because reviews read it
  // (10.15). A rebase lands a burst of commits: the newest head is prepared first, so older commits
  // reuse what it computed for the trees and blobs they share (PC15; the coalescing itself is the
  // handler's, through computations keyed by tree and blob).
  "commit.prepare": {
    slot: "background",
    priority: 1,
    order: "newest",
    maxAttempts: 5,
    backoff: exponentialWithJitter("5 seconds"),
    deadline: Duration.minutes(10),
    stallLimit: 2,
  },
  "commit.prepare@2": {
    slot: "background",
    priority: 1,
    order: "newest",
    maxAttempts: 5,
    backoff: exponentialWithJitter("5 seconds"),
    deadline: Duration.minutes(10),
    stallLimit: 2,
  },
  // Reads a local file and writes small rows: a failure is a missing or rewritten transcript or a
  // busy store, which a few spaced retries settle either way. Transcripts are append-only files,
  // so a capture can wait behind commit preparation without losing a segment.
  "transcript.capture": {
    slot: "background",
    priority: 2,
    order: "oldest",
    maxAttempts: 4,
    backoff: exponentialWithJitter("2 seconds"),
    deadline: Duration.minutes(2),
    stallLimit: 2,
  },
  // Pages through due raw captures, a few hundred rows per write transaction. A failure is a busy
  // or unwritable store; a retry or the next day's job prunes what this one left. Least urgent:
  // retention is 30 days plus at most one day either way.
  "retention.prune": {
    slot: "background",
    priority: 4,
    order: "oldest",
    maxAttempts: 3,
    backoff: exponentialWithJitter("30 seconds"),
    deadline: Duration.minutes(10),
    stallLimit: 2,
  },
  "review.run": REVIEW_RUN_POLICY,
  // The same review run under the kind this build enqueues, so builds before it never take it.
  "review.run@2": REVIEW_RUN_POLICY,

  // The cycle's scope snapshot (3.12, 10.53, 10.74): integration reads and git reads at the base,
  // no heavy subprocess. A review that finds it not ready runs the same keyed computation inside
  // Precompute, sharing an attempt already in flight, so it is fetched once; it is urgent for the same
  // reason commit preparation is. At the same priority, a commit burst's newest-first order sorts
  // ahead of it; a review that arrives first fetches the snapshot itself. A failure is a store or
  // spawn hiccup, retried a few times; a missing source is a disclosed gap, never a failure.
  "scope.fetch": {
    slot: "background",
    priority: 1,
    order: "oldest",
    maxAttempts: 3,
    backoff: exponentialWithJitter("10 seconds"),
    deadline: Duration.minutes(5),
    stallLimit: 2,
  },
  // Stack sources (11.15): downloads, git fetches and extraction in a child process at nice 10,
  // behind the heavy-work gate, and behind commit preparation and capture, which reviews read first.
  // The background slot runs one job at a time, so a job starts no new fetch after 3 minutes and
  // enqueues its continuation instead. What may still be in flight then is one download (2 minutes,
  // retries included) or one upstream tree (30 s each for its metadata and attestations, then a
  // fetch the watchdog kills at 5 minutes plus a 5 s grace, then its extraction), so an attempt ends
  // well within 15 minutes. Each attempt keeps what earlier ones stored, so a retry resumes.
  "stack.fetch": {
    slot: "background",
    priority: 3,
    order: "oldest",
    maxAttempts: 3,
    backoff: exponentialWithJitter("1 minute"),
    deadline: Duration.minutes(15),
    stallLimit: 2,
  },
  // The store-level index for the trees a fetch added: chunking and BM25 postings, in a child at
  // nice 10 behind the gate. A tree already indexed is skipped, so a retry resumes.
  "stack.index": {
    slot: "background",
    priority: 3,
    order: "oldest",
    maxAttempts: 3,
    backoff: exponentialWithJitter("1 minute"),
    deadline: Duration.minutes(30),
    stallLimit: 2,
  },
  // A prepared commit's hybrid leads (10.117, 10.118): chunk vectors for its changed code and each
  // hunk's reranked candidates, on the worker's long-lived model processes at nice 10, behind the
  // gate. Behind commit preparation and capture, which reviews read first; the newest head first,
  // as for its preparation, so a burst's older commits reuse its vectors. An attempt stops starting
  // hunks inside its deadline, and a hunk left is a disclosed keyword fallback at the review.
  "commit.hybrid": {
    slot: "background",
    priority: 3,
    order: "newest",
    maxAttempts: 3,
    backoff: exponentialWithJitter("30 seconds"),
    deadline: Duration.minutes(10),
    stallLimit: 2,
  },
  // A hand-enqueued check of the worker; it waits behind product work in its slot.
  "worker.probe": {
    slot: "background",
    priority: 3,
    order: "oldest",
    maxAttempts: 3,
    backoff: exponentialWithJitter("1 second"),
    deadline: Duration.seconds(15),
    stallLimit: 2,
  },
};
