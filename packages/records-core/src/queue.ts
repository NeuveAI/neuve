import { preserveUnknown, safeRead } from "@neuve/records-schema";
import { dirname } from "node:path";
import { storeLocationIn } from "./location.ts";
import { jobChanged, reachStoreWorker } from "./worker-socket.ts";
import { captureMarkState } from "./capture-marks.ts";
import {
  Clock,
  Context,
  Data,
  Duration,
  Effect,
  Layer,
  Option,
  Schedule,
} from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { z } from "zod";
import type { SqlError } from "effect/sql/SqlError";
import {
  CommitHybridPayload,
  PreparationPayload,
  JobCause,
  JobRow,
  RetentionPrunePayload,
  StackFetchPayload,
  StackIndexPayload,
  TranscriptCapturePayload,
  WorkerProbePayload,
  type JobKind,
  type JobState,
} from "@neuve/records-schema";
import { canonicalJson } from "./canonical.ts";
import { KNOWN_JOB_KINDS, isKnownJobKind } from "./codec.ts";
import {
  CorruptRecord,
  MigrationRequired,
  StoreNewer,
  StoreNotInitialized,
  WriterTooOld,
} from "./errors.ts";
import { JOB_POLICIES, type JobPolicy } from "./jobs.ts";
import { assertCompatible } from "./store.ts";

/** A job as the queue reports it: the stored row with its payload and last cause decoded. */
export interface Job {
  readonly seq: number;
  readonly kind: JobKind;
  readonly dedupeKey: string;
  readonly eventId: string | null;
  readonly payload: unknown;
  readonly state: JobState;
  readonly runAt: string | null;
  readonly attempts: number;
  readonly stalls: number;
  readonly enqueuedAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly lastError: JobCause | null;
}

export interface EnqueueRequest {
  readonly kind: JobKind;
  /** A second request returns the existing job; failed commit.prepare@2 jobs are revived. */
  readonly dedupeKey: string;
  readonly payload?: unknown;
  /** The event that enqueues the job; absent for a job enqueued by hand. */
  readonly eventId?: string | undefined;
}

export interface EnqueueResult {
  readonly status: "enqueued" | "existing";
  readonly job: Job;
}

/** What a failed attempt led to: another attempt at `runAt`, or the final failed state. */
export type FailOutcome =
  | { readonly state: "delayed"; readonly runAt: string; readonly job: Job }
  | { readonly state: "failed"; readonly job: Job };

/** A job found active when the worker started, and what recovery did with it. */
export interface RecoveredJob {
  readonly job: Job;
  readonly state: "waiting" | "failed";
}

/** The worker's view of outstanding work, for its idle decision. */
export interface Outstanding {
  /** Waiting or delayed jobs of the kinds asked about. */
  readonly queued: number;
  readonly active: number;
  /** The earliest `runAt` among those delayed jobs. */
  readonly nextRunAt: string | null;
}

/** The cause of a failed attempt, before the queue stamps it with attempt and time. */
export interface AttemptFailure {
  readonly tag: string;
  readonly message: string;
  readonly detail?: unknown;
  /** No later attempt can succeed (the job's input is refused): fail at once, without retries. */
  readonly final?: boolean;
  /**
   * The attempt paused on the machine rather than failed (hybrid leads past their disk or swap
   * limit): the job waits this long and runs again, and the attempt is not counted, so a pause
   * never uses up the kind's attempts.
   */
  readonly pauseMs?: number;
}

export class JobNotFound extends Data.TaggedError("JobNotFound")<{
  readonly seq: number;
}> {}

/** The job is not in a state the operation applies to, for example dropping an active job. */
export class JobStateConflict extends Data.TaggedError("JobStateConflict")<{
  readonly seq: number;
  readonly state: JobState;
  readonly message: string;
}> {}

/**
 * A job this build leaves to the newer build: its kind is unknown (8.19), or replacing its
 * metadata would remove newer fields.
 */
export class JobHeldByNewerBuild extends Data.TaggedError(
  "JobHeldByNewerBuild",
)<{
  readonly seq: number;
  readonly kind: string;
  readonly state: string;
  readonly message: string;
}> {}

export class InvalidJobPayload extends Data.TaggedError("InvalidJobPayload")<{
  readonly kind: JobKind;
  readonly message: string;
}> {}

/** Storage and version-gate failures (D2) any queue operation can meet. */
export type QueueError =
  | JobHeldByNewerBuild
  | SqlError
  | CorruptRecord
  | MigrationRequired
  | StoreNewer
  | StoreNotInitialized
  | WriterTooOld;

/**
 * The dial-2 job queue (8.12) over the Records `jobs` table. Callers see only this service, so a
 * shared or hosted setup can put `PersistedQueue` or BullMQ behind it. Every operation is one write
 * transaction (`BEGIN IMMEDIATE`). There is no lock, lease or visibility timeout: only the singleton
 * worker (8.2) takes jobs, so a job is active exactly while that worker runs it, and a job left active
 * by a dead worker is recovered by `recoverStalled` when the next worker starts.
 */
export class JobQueue extends Context.Service<
  JobQueue,
  {
    readonly enqueue: (
      request: EnqueueRequest,
    ) => Effect.Effect<
      EnqueueResult,
      QueueError | InvalidJobPayload | JobHeldByNewerBuild
    >;
    /**
     * Makes due delayed jobs waiting, then moves the most urgent waiting job of `kinds` to active:
     * the lowest `JOB_POLICIES` priority first, then oldest or newest first as the kind's order says.
     * The worker asks once per slot, with that slot's kinds (10.31). Jobs in `except` are passed
     * over: the worker holds them while what they need is missing (10.17).
     */
    readonly take: (
      kinds: ReadonlyArray<JobKind>,
      except?: ReadonlyArray<number>,
    ) => Effect.Effect<Option.Option<Job>, QueueError>;
    /**
     * Records the outcome of attempt `attempt`, the `attempts` value `take` returned. Each outcome
     * applies only while the job is active in that same attempt, so the outcome of an earlier attempt
     * can never overwrite a later one; a mismatch is a `JobStateConflict`.
     */
    readonly complete: (
      seq: number,
      attempt: number,
    ) => Effect.Effect<Job, QueueError | JobNotFound | JobStateConflict>;
    /**
     * Applies the kind's policy: delayed by its backoff, or failed with the cause kept. A `final`
     * failure ends the job at once.
     */
    readonly fail: (
      seq: number,
      attempt: number,
      failure: AttemptFailure,
    ) => Effect.Effect<
      FailOutcome,
      QueueError | JobNotFound | JobStateConflict
    >;
    /**
     * Puts an active job back to waiting when the worker is asked to stop: the interrupted attempt
     * is not counted, and it is not a stall.
     */
    readonly release: (
      seq: number,
      attempt: number,
    ) => Effect.Effect<Job, QueueError | JobNotFound | JobStateConflict>;
    /**
     * At worker start: every active job was left by a dead worker (8.2). Each goes back to waiting,
     * or fails when it is past its stall limit or the stalled attempt was its last.
     */
    readonly recoverStalled: Effect.Effect<
      ReadonlyArray<RecoveredJob>,
      QueueError
    >;
    readonly list: (filter: {
      readonly states: ReadonlyArray<JobState>;
      readonly limit: number;
    }) => Effect.Effect<ReadonlyArray<Job>, QueueError>;
    readonly inspect: (
      seq: number,
    ) => Effect.Effect<Option.Option<Job>, QueueError>;
    /** Ends a waiting or delayed job as failed with cause `Dropped`; an active job is refused. */
    readonly drop: (
      seq: number,
    ) => Effect.Effect<Job, QueueError | JobNotFound | JobStateConflict>;
    /** Explicitly return a failed scan to waiting after its cause has been fixed. */
    readonly retryFailedScan: (
      seq: number,
      rawFileHashes: ReadonlyArray<string>,
      recoveryMark?: string,
    ) => Effect.Effect<Job, QueueError | JobNotFound | JobStateConflict>;
    readonly failedScans: (
      afterSeq: number,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<Job>, QueueError>;
    /** Waiting and delayed jobs of `kinds`, except the held ones in `except`. */
    readonly outstanding: (
      kinds: ReadonlyArray<JobKind>,
      except?: ReadonlyArray<number>,
    ) => Effect.Effect<Outstanding, QueueError>;
  }
>()("@neuve/records-core/JobQueue") {}

/**
 * Payload schemas for jobs enqueued through this service (by hand); a kind without one takes any JSON
 * value. Jobs an event enqueues in its append transaction carry no payload: they read their event.
 */
const PAYLOAD_SCHEMAS: Partial<Record<JobKind, z.ZodType>> = {
  "transcript.capture": TranscriptCapturePayload,
  "retention.prune": RetentionPrunePayload,
  "worker.probe": WorkerProbePayload,
  "stack.fetch": StackFetchPayload,
  "stack.index": StackIndexPayload,
  "commit.hybrid": CommitHybridPayload,
  "commit.prepare@2": PreparationPayload,
};

/**
 * The take query's kind filter and ordering, read from `JOB_POLICIES` rather than stored on the row
 * (10.31): priority ascending, then sequence, negated for kinds taken newest first. Every value is
 * a bound parameter.
 */
const takeOrder = (kinds: ReadonlyArray<JobKind>) => {
  const newest = kinds.filter((kind) => JOB_POLICIES[kind].order === "newest");
  const marks = (count: number) =>
    Array.from({ length: count }, () => "?").join(", ");
  return {
    kinds: marks(kinds.length),
    by: [
      `CASE kind ${kinds.map(() => "WHEN ? THEN ?").join(" ")} END`,
      newest.length === 0
        ? "job_seq"
        : `CASE WHEN kind IN (${marks(newest.length)}) THEN -job_seq ELSE job_seq END`,
    ].join(", "),
    params: [
      ...kinds,
      ...kinds.flatMap((kind) => [kind, JOB_POLICIES[kind].priority]),
      ...newest,
    ],
  };
};

const parseJson = (text: string, what: string) =>
  Effect.try({
    try: () => JSON.parse(text) as unknown,
    catch: () => new CorruptRecord({ message: `${what} is not JSON` }),
  });

const decode = (row: unknown) =>
  Effect.gen(function* () {
    const parsed = safeRead(JobRow, row);
    if (!parsed.success)
      return yield* new CorruptRecord({
        message: `job row: ${parsed.error.message}`,
      });
    const stored = parsed.data;
    let payload =
      stored.payload === null
        ? null
        : yield* parseJson(stored.payload, `job ${stored.jobSeq} payload`);
    const schema = PAYLOAD_SCHEMAS[stored.kind];
    if (schema !== undefined && stored.payload !== null) {
      const read = safeRead(schema, payload ?? {});
      if (!read.success)
        return yield* new CorruptRecord({
          message: `job ${stored.jobSeq} payload: ${read.error.message}`,
        });
      payload = read.data;
    }
    let lastError: JobCause | null = null;
    if (stored.lastError !== null) {
      const cause = safeRead(
        JobCause,
        yield* parseJson(stored.lastError, `job ${stored.jobSeq} last error`),
      );
      if (!cause.success)
        return yield* new CorruptRecord({
          message: `job ${stored.jobSeq} last error: ${cause.error.message}`,
        });
      lastError = cause.data;
    }
    const job: Job = {
      seq: stored.jobSeq,
      kind: stored.kind,
      dedupeKey: stored.dedupeKey,
      eventId: stored.eventId,
      payload,
      state: stored.state,
      runAt: stored.runAt,
      attempts: stored.attempts,
      stalls: stored.stalls,
      enqueuedAt: stored.enqueuedAt,
      startedAt: stored.startedAt,
      finishedAt: stored.finishedAt,
      lastError,
    };
    return job;
  });

const COLUMNS =
  "job_seq, kind, dedupe_key, event_id, payload, state, run_at, attempts, stalls, enqueued_at, started_at, finished_at, last_error";

const nowIso = Effect.map(Clock.currentTimeMillis, (millis) =>
  new Date(millis).toISOString(),
);

/**
 * The delay after the `attempts`th failed attempt: the policy's schedule stepped that many times.
 * `None` when the schedule ends first, which stops retrying.
 */
export const backoffDelay = (policy: JobPolicy, attempts: number) =>
  Effect.gen(function* () {
    const step = yield* Schedule.toStep(policy.backoff);
    const now = yield* Clock.currentTimeMillis;
    let delay = Duration.zero;
    for (let n = 0; n < attempts; n += 1) {
      const result = yield* Effect.result(step(now, undefined));
      if (result._tag === "Failure") return Option.none<Duration.Duration>();
      delay = result.success[1];
    }
    return Option.some(delay);
  });

const cause = (failure: AttemptFailure, attempt: number, at: string) =>
  canonicalJson({
    tag: failure.tag,
    message: failure.message,
    attempt,
    at,
    ...(failure.detail === undefined ? {} : { detail: failure.detail }),
  });

/**
 * How many runs of a key have ended, whatever their job kind, as the dedupe key prefix and state
 * say: a newer build's run of the key (`review.run@2`) is an earlier generation too (8.19). Unknown
 * rows are counted, never decoded.
 */
export const endedWithPrefix = (prefix: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const [row] = yield* sql<{ n: number }>`SELECT count(*) AS n FROM jobs
      WHERE state IN ('failed', 'completed')
        AND substr(dedupe_key, 1, ${prefix.length}) = ${prefix}`;
    return row?.n ?? 0;
  });

/**
 * A job a newer build enqueued under a kind this build does not know (8.19), by its dedupe key or
 * sequence: its sequence, kind and state, which is all this build reads of it. A request whose job
 * key that build already holds joins its job, which that build's worker runs.
 */
export const newerJob = (
  by: { readonly dedupeKey: string } | { readonly seq: number },
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const [row] = yield* sql<{
      seq: number;
      kind: string;
      state: string;
    }>`SELECT job_seq AS seq, kind, state FROM jobs
      WHERE ${"seq" in by ? sql`job_seq = ${by.seq}` : sql`dedupe_key = ${by.dedupeKey}`}
        AND NOT ${sql.in("kind", KNOWN_JOB_KINDS)}`;
    return Option.fromNullishOr(row);
  });

/** The worker schedules its one notice drain; other writers poke its socket after committing. */
export const LocalJobPublication = Context.Reference<
  Effect.Effect<void> | undefined
>("@neuve/records-core/LocalJobPublication", {
  defaultValue: () => undefined,
});

/** Drain only on a worker event. Pushes are idempotent if the delivery transaction rolls back. */
export const deliverJobNotices = (path: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    // Linux can report the WAL write before its writer publishes the commit in shared memory.
    // BEGIN IMMEDIATE waits behind that writer before taking the read snapshot. With no DML,
    // this transaction changes no bytes, so a quiet notification cannot wake its own drain.
    const pending = yield* sql.withTransaction(
      sql`SELECT job_seq FROM job_notices LIMIT 1`,
    );
    const delivered =
      pending.length === 0
        ? 0
        : yield* sql.withTransaction(
            Effect.gen(function* () {
              const notices = yield* sql<{
                jobSeq: number;
              }>`SELECT job_seq FROM job_notices`;
              for (const notice of notices) jobChanged(path, notice.jobSeq);
              if (notices.length > 0) yield* sql`DELETE FROM job_notices`;
              return notices.length;
            }),
          );
    yield* Effect.logDebug("job notices drained", {
      type: "job.notices-drained",
      delivered,
    });
  });

export const layer = Layer.effect(
  JobQueue,
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const [main] = yield* sql<{
      file: string;
    }>`SELECT file FROM pragma_database_list WHERE name = 'main'`;
    const location = storeLocationIn(dirname(dirname(main?.file ?? "")));
    const publish = (job: Job) =>
      Effect.gen(function* () {
        if (job.state !== "completed" && job.state !== "failed") return;
        const local = yield* LocalJobPublication;
        if (local !== undefined) yield* local;
        else
          yield* reachStoreWorker(location, `publish ${job.seq}`, "500 millis");
      }).pipe(Effect.ignore);
    const write = <A, E, R>(program: Effect.Effect<A, E, R>) =>
      sql.withTransaction(Effect.andThen(assertCompatible, program));

    /** A job by its sequence; none when absent or of a newer build's kind, left to it (8.19). */
    const read = (seq: number) =>
      Effect.gen(function* () {
        const [row] = yield* sql`SELECT ${sql.literal(COLUMNS)} FROM jobs
          WHERE job_seq = ${seq} AND ${sql.in("kind", KNOWN_JOB_KINDS)}`;
        if (row === undefined) return Option.none<Job>();
        return Option.some(yield* decode(row));
      });

    const readExisting = (seq: number) =>
      Effect.flatMap(read(seq), (job) =>
        Option.isSome(job)
          ? Effect.succeed(job.value)
          : Effect.fail(new JobNotFound({ seq })),
      );

    const updateCause = (seq: number, next: string | null) =>
      Effect.gen(function* () {
        const [row] = yield* sql<{
          lastError: string | null;
          kind: string;
          state: string;
        }>`SELECT last_error, kind, state FROM jobs WHERE job_seq=${seq}`;
        const stored = row?.lastError;
        if (stored == null || row === undefined) return next;
        const original = yield* parseJson(stored, `job ${seq} last error`);
        const read = safeRead(JobCause, original);
        if (!read.success)
          return yield* new CorruptRecord({
            message: `job ${seq} last error: ${read.error.message}`,
          });
        return yield* Effect.try({
          try: () => {
            const merged = preserveUnknown(
              JobCause.nullable(),
              original,
              next === null ? null : JSON.parse(next),
            );
            return merged === null ? null : canonicalJson(merged);
          },
          catch: () =>
            new JobHeldByNewerBuild({
              seq,
              kind: row.kind,
              state: row.state,
              message: `job ${seq}: this update cannot preserve newer last-error fields; leave it to a newer build`,
            }),
        });
      });

    const activeJob = (seq: number, attempt: number) =>
      Effect.gen(function* () {
        const job = yield* readExisting(seq);
        if (job.state !== "active")
          return yield* new JobStateConflict({
            seq,
            state: job.state,
            message: `job ${seq} is ${job.state}, not active in attempt ${attempt}`,
          });
        if (job.attempts !== attempt)
          return yield* new JobStateConflict({
            seq,
            state: job.state,
            message: `job ${seq} is active in attempt ${job.attempts}, not ${attempt}`,
          });
        return job;
      });

    const enqueue = (request: EnqueueRequest) =>
      Effect.gen(function* () {
        const schema = PAYLOAD_SCHEMAS[request.kind];
        let payload = request.payload;
        if (
          schema !== undefined &&
          !(request.kind === "commit.prepare@2" && payload === undefined)
        ) {
          const parsed = schema.safeParse(payload ?? {});
          if (!parsed.success)
            return yield* new InvalidJobPayload({
              kind: request.kind,
              message: z.prettifyError(parsed.error),
            });
          payload = parsed.data;
        }
        const at = yield* nowIso;
        return yield* write(
          Effect.gen(function* () {
            // Looked up first, inside the write lock, so a duplicate does not consume a job ID.
            const [prior] = yield* sql<{
              jobSeq: number;
              kind: string;
              state: string;
              payload: string | null;
            }>`SELECT job_seq, kind, state, payload FROM jobs WHERE dedupe_key = ${request.dedupeKey}`;
            if (prior !== undefined && !isKnownJobKind(prior.kind))
              return yield* new JobHeldByNewerBuild({
                seq: prior.jobSeq,
                kind: prior.kind,
                state: prior.state,
                message: `job ${prior.jobSeq} already holds the key ${request.dedupeKey} as ${prior.kind} (${prior.state}), a kind this build does not know; it is the newer build's job, which this build leaves to it`,
              });
            const revive =
              prior?.kind === "commit.prepare@2" &&
              request.kind === prior.kind &&
              prior.state === "failed";
            // Preserve the monotonic attempt number so a late old attempt cannot finish the retry.
            if (revive) {
              const original =
                prior.payload === null
                  ? null
                  : yield* parseJson(
                      prior.payload,
                      `job ${prior.jobSeq} payload`,
                    );
              const checked = safeRead(PreparationPayload.nullable(), original);
              if (!checked.success)
                return yield* new CorruptRecord({
                  message: `job ${prior.jobSeq} payload: ${checked.error.message}`,
                });
              const revivedPayload = yield* Effect.try({
                try: () =>
                  preserveUnknown(
                    PreparationPayload.nullable(),
                    original,
                    payload ?? null,
                  ),
                catch: () =>
                  new JobHeldByNewerBuild({
                    seq: prior.jobSeq,
                    kind: prior.kind,
                    state: prior.state,
                    message: `job ${prior.jobSeq}: revival cannot preserve newer payload fields; leave it to a newer build`,
                  }),
              });
              const lastError = yield* updateCause(prior.jobSeq, null);
              yield* sql`UPDATE jobs SET state = 'waiting', stalls = 0,
              run_at = NULL, started_at = NULL, finished_at = NULL, last_error = ${lastError},
              enqueued_at = ${at}, event_id = ${request.eventId ?? null},
              payload = ${revivedPayload === null ? null : canonicalJson(revivedPayload)}
              WHERE job_seq = ${prior.jobSeq}`;
            }
            const status: EnqueueResult["status"] =
              prior === undefined || revive ? "enqueued" : "existing";
            const [held] =
              prior !== undefined
                ? [prior]
                : yield* sql<{ jobSeq: number }>`INSERT INTO jobs ${sql.insert({
                    kind: request.kind,
                    dedupe_key: request.dedupeKey,
                    event_id: request.eventId ?? null,
                    payload:
                      payload === undefined ? null : canonicalJson(payload),
                    enqueued_at: at,
                  })} RETURNING job_seq`;
            if (held === undefined)
              return yield* new CorruptRecord({
                message: `job ${request.dedupeKey} returned no ID`,
              });
            const job = yield* readExisting(held.jobSeq).pipe(
              Effect.catchTag("JobNotFound", () =>
                Effect.fail(
                  new CorruptRecord({ message: `job ${held.jobSeq} missing` }),
                ),
              ),
            );
            const result: EnqueueResult = { status, job };
            return result;
          }),
        );
      });

    const take = (
      kinds: ReadonlyArray<JobKind>,
      except: ReadonlyArray<number> = [],
    ) =>
      Effect.gen(function* () {
        if (kinds.length === 0) return Option.none<Job>();
        const at = yield* nowIso;
        return yield* write(
          Effect.gen(function* () {
            yield* sql`UPDATE jobs SET state = 'waiting', run_at = NULL
              WHERE state = 'delayed' AND run_at <= ${at} AND ${sql.in("kind", KNOWN_JOB_KINDS)}`;
            const order = takeOrder(kinds);
            const [next] = (yield* sql.unsafe(
              `SELECT job_seq FROM jobs WHERE state = 'waiting' AND kind IN (${order.kinds})${except.length === 0 ? "" : ` AND job_seq NOT IN (${except.map(() => "?").join(", ")})`}
                ORDER BY ${order.by} LIMIT 1`,
              [
                ...order.params.slice(0, kinds.length),
                ...except,
                ...order.params.slice(kinds.length),
              ],
            )) as ReadonlyArray<{ jobSeq: number }>;
            if (next === undefined) return Option.none<Job>();
            yield* sql`UPDATE jobs SET state = 'active', attempts = attempts + 1,
              started_at = ${at}, finished_at = NULL WHERE job_seq = ${next.jobSeq}`;
            return yield* read(next.jobSeq);
          }),
        );
      });

    /** Every outcome update repeats the attempt check in SQL, so it cannot touch a later attempt. */
    const sameAttempt = (seq: number, attempt: number) =>
      sql`job_seq = ${seq} AND state = 'active' AND attempts = ${attempt}`;

    const complete = (seq: number, attempt: number) =>
      Effect.gen(function* () {
        const at = yield* nowIso;
        return yield* write(
          Effect.gen(function* () {
            yield* activeJob(seq, attempt);
            yield* sql`UPDATE jobs SET state = 'completed', finished_at = ${at}
              WHERE ${sameAttempt(seq, attempt)}`;
            return yield* readExisting(seq);
          }),
        );
      });

    const fail = (seq: number, attempt: number, failure: AttemptFailure) =>
      Effect.gen(function* () {
        const at = yield* nowIso;
        const now = yield* Clock.currentTimeMillis;
        return yield* write(
          Effect.gen(function* () {
            const job = yield* activeJob(seq, attempt);
            const policy = JOB_POLICIES[job.kind];
            const lastError = yield* updateCause(
              seq,
              cause(failure, job.attempts, at),
            );
            if (
              failure.final !== true &&
              failure.pauseMs !== undefined &&
              failure.pauseMs > 0
            ) {
              const runAt = new Date(now + failure.pauseMs).toISOString();
              yield* sql`UPDATE jobs SET state = 'delayed', run_at = ${runAt},
                started_at = NULL, attempts = max(attempts - 1, 0),
                last_error = ${lastError} WHERE ${sameAttempt(seq, attempt)}`;
              const outcome: FailOutcome = {
                state: "delayed",
                runAt,
                job: yield* readExisting(seq),
              };
              return outcome;
            }
            const delay =
              failure.final !== true && job.attempts < policy.maxAttempts
                ? yield* backoffDelay(policy, job.attempts)
                : Option.none<Duration.Duration>();
            if (Option.isSome(delay)) {
              const runAt = new Date(
                now + Duration.toMillis(delay.value),
              ).toISOString();
              yield* sql`UPDATE jobs SET state = 'delayed', run_at = ${runAt},
                last_error = ${lastError} WHERE ${sameAttempt(seq, attempt)}`;
              const outcome: FailOutcome = {
                state: "delayed",
                runAt,
                job: yield* readExisting(seq),
              };
              return outcome;
            }
            yield* sql`UPDATE jobs SET state = 'failed', run_at = NULL, finished_at = ${at},
              last_error = ${lastError} WHERE ${sameAttempt(seq, attempt)}`;
            const outcome: FailOutcome = {
              state: "failed",
              job: yield* readExisting(seq),
            };
            return outcome;
          }),
        );
      });

    const release = (seq: number, attempt: number) =>
      write(
        Effect.gen(function* () {
          yield* activeJob(seq, attempt);
          yield* sql`UPDATE jobs SET state = 'waiting', started_at = NULL,
            attempts = max(attempts - 1, 0) WHERE ${sameAttempt(seq, attempt)}`;
          return yield* readExisting(seq);
        }),
      );

    const recoverStalled = Effect.gen(function* () {
      const at = yield* nowIso;
      return yield* write(
        Effect.gen(function* () {
          // A newer build's active job is its own to recover (8.19), as its worker left it.
          const rows = yield* sql`SELECT ${sql.literal(COLUMNS)} FROM jobs
            WHERE state = 'active' AND ${sql.in("kind", KNOWN_JOB_KINDS)} ORDER BY job_seq`;
          const recovered: Array<RecoveredJob> = [];
          for (const row of rows) {
            const job = yield* decode(row);
            const policy = JOB_POLICIES[job.kind];
            const stalls = job.stalls + 1;
            // A stalled attempt counts (see `JobPolicy.maxAttempts`): at the last one, none remain.
            const failure =
              stalls > policy.stallLimit
                ? {
                    tag: "StallLimit",
                    message: `left active by a dead worker ${stalls} times; the limit is ${policy.stallLimit}`,
                  }
                : job.attempts >= policy.maxAttempts
                  ? {
                      tag: "Stalled",
                      message: `attempt ${job.attempts} of ${policy.maxAttempts} was left active by a dead worker; no attempts remain`,
                    }
                  : undefined;
            if (failure !== undefined) {
              const lastError = yield* updateCause(
                job.seq,
                cause(failure, job.attempts, at),
              );
              yield* sql`UPDATE jobs SET state = 'failed', stalls = ${stalls}, run_at = NULL,
                finished_at = ${at}, last_error = ${lastError} WHERE job_seq = ${job.seq}`;
              recovered.push({
                job: yield* readExisting(job.seq),
                state: "failed",
              });
            } else {
              yield* sql`UPDATE jobs SET state = 'waiting', stalls = ${stalls}, started_at = NULL
                WHERE job_seq = ${job.seq}`;
              recovered.push({
                job: yield* readExisting(job.seq),
                state: "waiting",
              });
            }
          }
          return recovered as ReadonlyArray<RecoveredJob>;
        }),
      ).pipe(
        Effect.catchTag("JobNotFound", (error) =>
          Effect.fail(
            new CorruptRecord({ message: `job ${error.seq} vanished` }),
          ),
        ),
      );
    });

    const list = (filter: {
      readonly states: ReadonlyArray<JobState>;
      readonly limit: number;
    }) =>
      Effect.gen(function* () {
        yield* assertCompatible;
        if (filter.states.length === 0) return [];
        // A newer build's job kinds are not listed: this build cannot decode or run them (8.19).
        const rows = yield* sql`SELECT ${sql.literal(COLUMNS)} FROM jobs
          WHERE ${sql.in("state", filter.states)} AND ${sql.in("kind", KNOWN_JOB_KINDS)}
          ORDER BY job_seq LIMIT ${filter.limit}`;
        return yield* Effect.forEach(rows, decode);
      });

    const inspect = (seq: number) =>
      Effect.andThen(assertCompatible, read(seq));

    const drop = (seq: number) =>
      Effect.gen(function* () {
        const at = yield* nowIso;
        return yield* write(
          Effect.gen(function* () {
            const job = yield* readExisting(seq);
            if (job.state !== "waiting" && job.state !== "delayed")
              return yield* new JobStateConflict({
                seq,
                state: job.state,
                message:
                  job.state === "active"
                    ? `job ${seq} is active; the worker owns it until it ends or meets its deadline`
                    : `job ${seq} is already ${job.state}`,
              });
            const lastError = yield* updateCause(
              seq,
              cause(
                {
                  tag: "Dropped",
                  message: `dropped while ${job.state}`,
                },
                job.attempts,
                at,
              ),
            );
            yield* sql`UPDATE jobs SET state = 'failed', run_at = NULL, finished_at = ${at},
              last_error = ${lastError} WHERE job_seq = ${seq}`;
            return yield* readExisting(seq);
          }),
        );
      });

    const retryFailedScan = (
      seq: number,
      rawFileHashes: ReadonlyArray<string>,
      recoveryMark?: string,
    ) =>
      write(
        Effect.gen(function* () {
          const job = yield* readExisting(seq);
          const refuse = (message: string) =>
            Effect.fail(
              new JobStateConflict({ seq, state: job.state, message }),
            );
          if (
            job.kind !== "capture.scan" ||
            (job.state !== "failed" &&
              !(job.state === "completed" && recoveryMark !== undefined)) ||
            job.eventId === null
          )
            return yield* refuse(
              "only failed capture.scan jobs can be sent back",
            );
          const [filing] = yield* sql<{
            rawCapture: string;
          }>`SELECT json_extract(envelope,'$.payload.rawCapture') AS raw_capture FROM events WHERE id=${job.eventId} AND kind='capture.filed@1'`;
          if (
            filing === undefined ||
            !rawFileHashes.includes(filing.rawCapture)
          )
            return yield* refuse(
              "raw capture inventory is required before sending back",
            );
          const state = yield* captureMarkState(filing.rawCapture);
          if (state.mark !== undefined && recoveryMark === undefined)
            return yield* refuse("capture already has a scan mark");
          if (
            recoveryMark !== undefined &&
            (!state.conflicted || state.mark?.id !== recoveryMark)
          )
            return yield* refuse(
              "capture mark recovery requires the current conflicted mark",
            );
          const [pending] =
            yield* sql`SELECT 1 FROM jobs WHERE kind='capture.scan' AND event_id=${job.eventId} AND state IN ('waiting','delayed','active') LIMIT 1`;
          if (pending !== undefined)
            return yield* refuse("capture already has a pending scan job");
          for (let i = 0; i < rawFileHashes.length; i += 128) {
            const batch = rawFileHashes.slice(i, i + 128);
            const rows = yield* sql<{
              hash: string;
            }>`SELECT hash FROM blobs WHERE ${sql.in("hash", batch)} AND pruned_at IS NULL`;
            if (
              new Set(rows.map((row) => row.hash)).size !== new Set(batch).size
            )
              return yield* refuse(
                "raw capture was pruned; it cannot be sent back",
              );
          }
          const [newer] =
            yield* sql`SELECT 1 FROM jobs WHERE kind='capture.scan' AND event_id=${job.eventId} AND job_seq>${job.seq} LIMIT 1`;
          if (newer !== undefined)
            return yield* refuse(
              "capture scan was already sent back; use its latest failed job",
            );
          const key = `capture.scan:${job.eventId}:requeue:${job.seq}`;
          const [inserted] = yield* sql<{
            jobSeq: number;
          }>`INSERT INTO jobs(kind,dedupe_key,event_id,payload) VALUES('capture.scan',${key},${job.eventId},${recoveryMark === undefined ? null : JSON.stringify({ recoveryMark })}) ON CONFLICT(dedupe_key) DO UPDATE SET dedupe_key=excluded.dedupe_key RETURNING job_seq`;
          if (inserted === undefined)
            return yield* refuse("capture scan requeue returned no job");
          return yield* readExisting(inserted.jobSeq);
        }),
      );
    const failedScans = (afterSeq: number, limit: number) =>
      Effect.gen(function* () {
        yield* assertCompatible;
        const rows =
          yield* sql`SELECT ${sql.literal(COLUMNS)} FROM jobs WHERE kind = 'capture.scan'
        AND state = 'failed' AND NOT EXISTS (SELECT 1 FROM jobs newer WHERE newer.kind='capture.scan' AND newer.event_id=jobs.event_id AND newer.job_seq>jobs.job_seq) AND job_seq > ${afterSeq} ORDER BY job_seq LIMIT ${Math.min(256, Math.max(1, limit))}`;
        return yield* Effect.forEach(rows, decode);
      });

    const outstanding = (
      kinds: ReadonlyArray<JobKind>,
      except: ReadonlyArray<number> = [],
    ) =>
      Effect.gen(function* () {
        const [active] = yield* sql<{
          n: number;
        }>`SELECT count(*) AS n FROM jobs WHERE state = 'active'`;
        if (kinds.length === 0)
          return { queued: 0, active: active?.n ?? 0, nextRunAt: null };
        const [queued] = yield* sql<{
          n: number;
          nextRunAt: string | null;
        }>`SELECT count(*) AS n, min(CASE WHEN state = 'delayed' THEN run_at END) AS next_run_at
          FROM jobs WHERE state IN ('waiting', 'delayed') AND ${sql.in("kind", kinds)}
            AND ${except.length === 0 ? sql.literal("1 = 1") : sql`NOT ${sql.in("job_seq", except)}`}`;
        const result: Outstanding = {
          queued: queued?.n ?? 0,
          active: active?.n ?? 0,
          nextRunAt: queued?.nextRunAt ?? null,
        };
        return result;
      });

    const bound =
      <Args extends ReadonlyArray<unknown>, A, E>(
        f: (...args: Args) => Effect.Effect<A, E, SqlClient>,
      ) =>
      (...args: Args) =>
        Effect.provideService(f(...args), SqlClient, sql);
    return JobQueue.of({
      enqueue: bound(enqueue),
      take: bound(take),
      complete: (seq, attempt) =>
        bound(complete)(seq, attempt).pipe(
          Effect.tap(publish),
          Effect.uninterruptible,
        ),
      fail: (seq, attempt, failure) =>
        bound(fail)(seq, attempt, failure).pipe(
          Effect.tap((outcome) => publish(outcome.job)),
          Effect.uninterruptible,
        ),
      release: bound(release),
      recoverStalled: Effect.provideService(
        recoverStalled,
        SqlClient,
        sql,
      ).pipe(
        Effect.tap((jobs) => Effect.forEach(jobs, ({ job }) => publish(job))),
        Effect.uninterruptible,
      ),
      list: bound(list),
      inspect: bound(inspect),
      drop: (seq) =>
        bound(drop)(seq).pipe(Effect.tap(publish), Effect.uninterruptible),
      outstanding: bound(outstanding),
      retryFailedScan: bound(retryFailedScan),
      failedScans: bound(failedScans),
    });
  }),
);
