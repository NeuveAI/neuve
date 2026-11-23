import { z } from "zod";
import { GitOid, Instant, Ulid } from "./envelope.ts";
import { RecordEvent } from "./events.ts";

/**
 * One spooled event (D18): `.git/neuve/spool/<event id>.json` holds exactly one line, the canonical
 * JSON of this object followed by a newline. Hooks write it; ingestion appends `event` to the log.
 */
export const SpoolLine = z.strictObject({
  spool: z.literal(1),
  event: RecordEvent,
});

/**
 * `commit.prepare@2` discovers ranges and prepares code facts without hook attribution. Older builds
 * skip this kind (8.19); the hook-driven `commit.prepare` contract stays readable.
 *
 * Worker jobs (D16, 8.12). `commit.prepare` and `transcript.capture` are enqueued in the same
 * transaction as their event (a commit; a turn or session end with a transcript offset).
 * `retention.prune` is enqueued by the worker at start, at most once a day, when raw captures are
 * past retention or a retention sweep has something to clear, such as the harness's run folders
 * (5.8, 8.10). `worker.probe` is enqueued by hand (`neuve jobs enqueue`) to check that
 * a worker picks up, retries and bounds jobs; it does no product work. `review.run` is enqueued with
 * `review.requested@1` and runs the harness pipeline for one review request (10.13). `scope.fetch` is
 * enqueued with `cycle.opened@1` and fetches the cycle's scope snapshot once per cycle (3.12, 10.53).
 * `stack.fetch` fetches a repository's stack sources into the user-level stack store (11.15): enqueued
 * by `neuve setup stack`, by `commit.prepare` when a commit changes a declared lockfile, and with
 * `review.requested@1`; `stack.index` builds the store's index for the trees a fetch added.
 * `commit.hybrid` computes a prepared commit's hybrid leads (10.117, 10.118): chunk vectors for its
 * changed code and each hunk's fused, reranked candidates. `commit.prepare` enqueues it after a
 * commit is prepared, and only while the user's settings turn hybrid preparation on.
 * `review.run@2` is the same review run, enqueued by builds from 12.24 on under a kind builds before
 * it do not take: those builds claim jobs by kind, and would run this build's reviews with their own
 * pipeline or fail them. This build runs both.
 */
export const JobKind = z.enum([
  "capture.scan",
  "commit.prepare",
  "commit.prepare@2",
  "transcript.capture",
  "retention.prune",
  "worker.probe",
  "review.run",
  "review.run@2",
  "judgement.prepare@1",
  "scope.fetch",
  "scope.fetch@2",
  "stack.fetch",
  "stack.index",
  "commit.hybrid",
]);

/**
 * The worker's slots: `interactive` runs reviews, `capture` runs one scan, and `background` runs everything
 * else, at the same time, each taking its most urgent job first. A kind's slot and its priority
 * within the slot are policy (`JOB_POLICIES` in records-core), not stored on the job.
 */
export const JobSlot = z.enum(["interactive", "background", "capture"]);

/**
 * Dial-2 states (8.12). `delayed` waits for `runAt` before it is due again; `active` is held by the
 * single worker (8.2), with no lease or expiry: a job left active by a dead worker is recovered when
 * the next worker starts. `completed` and `failed` are final.
 */
export const JobState = z.enum([
  "waiting",
  "delayed",
  "active",
  "completed",
  "failed",
]);

/** Why an attempt failed, kept on the job; the cause of the last attempt stays on a failed job. */
export const JobCause = z.strictObject({
  /** The error's tag, `Defect`, `DeadlineExceeded`, `StallLimit` or `Dropped`. */
  tag: z.string().min(1),
  message: z.string(),
  attempt: z.int().min(0),
  at: Instant,
  /** The error's own fields, JSON-safe. */
  detail: z.unknown().optional(),
});

export const JobRow = z.strictObject({
  jobSeq: z.int().min(1),
  kind: JobKind,
  dedupeKey: z.string().min(1).max(512),
  /** The event that enqueued the job, or null for a job enqueued by hand. */
  eventId: Ulid.nullable(),
  /** The job's input as JSON text, or null. */
  payload: z.string().nullable(),
  state: JobState,
  /** When a `delayed` job is due; null otherwise. */
  runAt: Instant.nullable(),
  /** Attempts started, including one a dead worker left behind. */
  attempts: z.int().min(0),
  /** Times the job was found active at worker start and recovered. */
  stalls: z.int().min(0),
  enqueuedAt: Instant,
  startedAt: Instant.nullable(),
  finishedAt: Instant.nullable(),
  /** JSON of the last attempt's `JobCause`. */
  lastError: z.string().nullable(),
});

/** Input of a `worker.probe` job: sleep, then fail while `attempt <= failAttempts`. */
export const WorkerProbePayload = z.strictObject({
  sleepMs: z.int().min(0).max(86_400_000).default(0),
  failAttempts: z.int().min(0).max(100).default(0),
});

/** Input of a `retention.prune` job: none. The cutoff is taken when the job runs. */
export const RetentionPrunePayload = z.strictObject({});

/**
 * Input of a `stack.fetch` job enqueued by `neuve setup stack`, by `commit.prepare` or as a job's
 * continuation: the commits whose pins to fetch. One enqueued with `review.requested@1` carries none
 * and reads its event's range. A continuation carries when its chain started (`since`), so entries
 * the chain already found unavailable are not retried in it.
 */
export const StackFetchPayload = z.strictObject({
  reason: z.enum(["setup", "commit", "review"]),
  revisions: z.array(GitOid).min(1).max(4),
  baseRef: z.string().min(1).max(512).optional(),
  since: Instant.optional(),
});

/** Input of a `stack.index` job: the store trees to index. */
export const StackIndexPayload = z.strictObject({
  trees: z.array(GitOid).min(1).max(1_000),
});

/** Input of a `commit.hybrid` job: the prepared commit, as its `commit.recorded@1` event named it. */
export const CommitHybridPayload = z.strictObject({
  oid: GitOid,
  tree: GitOid,
  parents: z.array(GitOid).max(64),
});

/** Input of hookless preparation; discovery jobs instead read their event and have no payload. */
export const PreparationPayload = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("commit"),
    commit: z.strictObject({
      oid: GitOid,
      tree: GitOid,
      parents: z.array(GitOid),
    }),
  }),
  z.strictObject({
    kind: z.literal("range"),
    range: z.strictObject({
      baseOid: GitOid,
      headOid: GitOid,
    }),
  }),
]);

/** What the database declares about itself: a build below `minWriterVersion` refuses, and a store older than the build needs an explicit migrate (D2). */
export const StoreVersions = z.strictObject({
  schemaVersion: z.int().min(0),
  minWriterVersion: z.int().min(0),
  projectorVersion: z.int().min(0),
});

export type SpoolLine = z.infer<typeof SpoolLine>;
export type JobKind = z.infer<typeof JobKind>;
export type JobSlot = z.infer<typeof JobSlot>;
export type JobState = z.infer<typeof JobState>;
export type JobCause = z.infer<typeof JobCause>;
export type JobRow = z.infer<typeof JobRow>;
export type WorkerProbePayload = z.infer<typeof WorkerProbePayload>;
export type StoreVersions = z.infer<typeof StoreVersions>;
