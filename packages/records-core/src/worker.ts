import { readData } from "./compatible-read.ts";
import { StoreChangedDuringRead } from "./read-only.ts";
import { writeSync, closeSync } from "node:fs";
import { dirname } from "node:path";
import {
  Cause,
  Clock,
  Context,
  Data,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  FiberSet,
  Latch,
  Option,
  Queue,
  Schedule,
  Scope,
} from "effect";
import { FileSystem } from "effect/FileSystem";
import { SqlClient } from "effect/sql/SqlClient";
import {
  JobSlot,
  WorkerProbePayload,
  type JobKind,
} from "@neuve/records-schema";
import type { BlobStore } from "./blobs.ts";
import { KNOWN_EVENT_KINDS } from "./codec.ts";
import { ComputationStore } from "./computations.ts";
import { ingestSpool, pendingSpoolFiles } from "./ingest.ts";
import { JOB_POLICIES, type JobPolicy } from "./jobs.ts";
import { STORE_DIRECTORY_MODE, type StoreLocation } from "./location.ts";
import {
  JobQueue,
  LocalJobPublication,
  deliverJobNotices,
  type AttemptFailure,
  type Job,
} from "./queue.ts";
import { pruneJob, schedulePrune } from "./retention.ts";
import { captureTranscript, claudeCodeProjectFolders } from "./transcripts.ts";
import {
  claimWorkerLock,
  requireCurrentWorkerClaim,
  startupMayAcknowledge,
  canReplaceListener,
  isLive,
  jobChanged,
  olderBuildWorkerMessage,
  olderWorkerMessage,
  OlderWorkerHeld,
  reachWorker,
  removeStaleLegacySocket,
  serve,
  watchRecordsDatabase,
  workerPathsFor,
} from "./worker-socket.ts";

/** What a job handler may use: the store, the file system, and the blob and computation stores. */
export type JobServices = SqlClient | FileSystem | BlobStore | ComputationStore;

/**
 * Runs one attempt of a job. A failure (typed error or defect) is handled by the kind's retry
 * policy. The worker interrupts the attempt at the kind's deadline, so a handler must be
 * interruptible: an effect that blocks the event loop synchronously cannot be stopped in-process.
 */
export type JobHandler = (
  job: Job,
) => Effect.Effect<unknown, unknown, JobServices>;

/** A handler with required finalization retains its worker and services until that handler exits. */
export const HandlerLifetime = Context.Reference<{
  readonly retain: Effect.Effect<void>;
}>("@neuve/records-core/HandlerLifetime", {
  defaultValue: () => ({ retain: Effect.void }),
});

/**
 * `spawn` prepares asynchronously, then checks the review latch and launches in one synchronous
 * turn. A wait repeats preparation, so memory and other freshness checks are not reused after a
 * review. A background job passes the gate before taking any process-wide shared build or slot,
 * never while holding one: a review may join that work. Shared work is admitted as a whole and
 * uses the admitted context until it releases ownership. Shared Graph work is admitted only at entry;
 * launches inside it are not re-gated if a review starts later. The Graph per-launch admission
 * follow-up will release/reacquire its slot and clone lock around waits. Unshared child starts use
 * `child`/`spawn`.
 */
/** True only within the long-lived worker loop and its jobs. */
export const Running = Context.Reference<boolean>(
  "@neuve/records-core/Worker/Running",
  {
    defaultValue: () => false,
  },
);

export interface HeavyWorkService {
  readonly start: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly spawn: <A, B, E, R>(
    prepare: Effect.Effect<A, E, R>,
    spawnSync: (prepared: A) => B,
  ) => Effect.Effect<B, E, R>;
  readonly child: <A, B, E, R, R2>(
    prepare: Effect.Effect<A, E, R>,
    spawnSync: (prepared: A) => B,
    stop: (child: B) => Effect.Effect<unknown, never, R2>,
  ) => Effect.Effect<B, E, R | R2 | Scope.Scope>;
}

const withScopedChild = (
  work: Omit<HeavyWorkService, "child">,
): HeavyWorkService => ({
  ...work,
  child: (prepare, spawnSync, stop) =>
    Effect.uninterruptibleMask(() =>
      Effect.gen(function* () {
        const child = yield* work.spawn(prepare, spawnSync);
        yield* Effect.addFinalizer(() => Effect.asVoid(stop(child)));
        return child;
      }),
    ),
});

export const HeavyWork = Context.Reference<HeavyWorkService>(
  "@neuve/records-core/HeavyWork",
  {
    defaultValue: () =>
      withScopedChild({
        start: (effect) => effect,
        spawn: (prepare, spawnSync) =>
          Effect.flatMap(Effect.interruptible(prepare), (prepared) =>
            Effect.sync(() => spawnSync(prepared)),
          ),
      }),
  },
);

/**
 * Waiting at the heavy-work gate is excluded from a background attempt's deadline (6.10, PC15), so a
 * long review never times out the commit preparation behind it. The exclusion is bounded by one
 * review run's deadline per attempt: past it, a wait counts, so an attempt's wall time is at most its
 * deadline plus that bound.
 */
export const GATE_ALLOWANCE = JOB_POLICIES["review.run"].deadline;

/** One attempt's deadline: its policy's duration, less the time excluded while paused at the gate. */
interface AttemptDeadline {
  pausedSince: number | null;
  excludedMs: number;
  /** Fails with a timeout once the attempt has used its deadline; never succeeds. */
  readonly expired: Effect.Effect<never, Cause.TimeoutError>;
  /** Ends a pause at `now`, adding it to the excluded time. */
  readonly resume: (now: number) => void;
}

const attemptDeadline = (policy: JobPolicy) =>
  Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis;
    const deadlineMs = Duration.toMillis(policy.deadline);
    const allowanceMs = Duration.toMillis(GATE_ALLOWANCE);
    const resumed = yield* Queue.unbounded<void>();
    const excludedAt = (now: number) =>
      Math.min(
        allowanceMs,
        state.excludedMs +
          (state.pausedSince === null ? 0 : now - state.pausedSince),
      );
    // While paused the deadline stands still until the allowance is used up; a resume wakes the
    // sleeper so it measures again from then.
    const expired = Effect.gen(function* () {
      for (;;) {
        const now = yield* Clock.currentTimeMillis;
        const left = deadlineMs + excludedAt(now) - (now - startedAt);
        if (left <= 0) return yield* Effect.fail(new Cause.TimeoutError());
        const wait =
          state.pausedSince === null
            ? left
            : left + Math.max(0, allowanceMs - excludedAt(now));
        yield* Effect.raceFirst(
          Effect.sleep(Duration.millis(wait)),
          Queue.take(resumed),
        );
      }
    });
    const state: AttemptDeadline = {
      pausedSince: null,
      excludedMs: 0,
      expired,
      resume: (now) => {
        if (state.pausedSince === null) return;
        state.excludedMs += now - state.pausedSince;
        state.pausedSince = null;
        Queue.offerUnsafe(resumed, undefined);
      },
    };
    return state;
  });

/** A `worker.probe` attempt failed on purpose, as its payload asked. */
export class ProbeFailed extends Data.TaggedError("ProbeFailed")<{
  readonly message: string;
  readonly attempt: number;
  readonly failAttempts: number;
}> {}

/** `worker.probe`: sleeps `sleepMs`, then fails while the attempt is at most `failAttempts`. */
export const probeHandler: JobHandler = (job) =>
  Effect.gen(function* () {
    const payload = readData(WorkerProbePayload, job.payload ?? {});
    if (payload.sleepMs > 0)
      yield* Effect.sleep(Duration.millis(payload.sleepMs));
    if (job.attempts <= payload.failAttempts)
      return yield* new ProbeFailed({
        message: `probe asked to fail attempt ${job.attempts} of the first ${payload.failAttempts}`,
        attempt: job.attempts,
        failAttempts: payload.failAttempts,
      });
  });

/**
 * Handlers this build has. A kind without one stays waiting for a build that has it, and does not
 * keep the worker alive: `commit.prepare` has no preparation to run until the M3 harness.
 */
export const defaultHandlers: Partial<Record<JobKind, JobHandler>> = {
  "transcript.capture": (job) => captureTranscript(job),
  "retention.prune": pruneJob,
  "worker.probe": probeHandler,
};

/**
 * The handlers a worker for the store at `location` runs: the defaults, with transcript capture told
 * where Claude Code keeps this repository's transcripts, for sessions whose start was missed (8.15).
 */
export const handlersFor = (
  location: StoreLocation,
): Partial<Record<JobKind, JobHandler>> => ({
  ...defaultHandlers,
  "transcript.capture": (job) =>
    captureTranscript(job, {
      claudeCodeProjects: claudeCodeProjectFolders(dirname(location.directory)),
    }),
});

export interface WorkerOptions {
  readonly location: StoreLocation;
  /** The version of the program this worker runs, said in its status reply. */
  readonly version?: string;
  readonly handlers?: Partial<Record<JobKind, JobHandler>>;
  /** Exit after this long with no jobs and no open ACP session (D19). Default 60 s. */
  readonly idleTimeout?: Duration.Input;
  /** External machine-wide grants can keep an otherwise idle worker alive. */
  readonly beforeIdleExit?: Effect.Effect<boolean>;
  /** Longest wait between scans when nothing wakes the worker. Default 1 s. */
  readonly pollInterval?: Duration.Input;
  /**
   * ACP sessions this worker holds open; the worker never idles out while one is open (D3). No
   * ACP session exists before M3, so the default reports none.
   */
  readonly openSessions?: Effect.Effect<number>;
  /**
   * Work a handler left running after its job ended, such as a Graph search a review stopped
   * waiting for, which finishes and keeps its answer; the worker never idles out while any runs.
   * Interrupting it would lose that work, so the worker waits instead. None by default.
   */
  readonly detachedWork?: Effect.Effect<number>;
  /**
   * Runs once this worker holds the claim and has recovered what a dead worker left (stalled jobs,
   * abandoned computations), before it takes a job. A failure is logged and the worker goes on.
   */
  readonly beforeComputationRecovery?: Effect.Effect<void, never>;
  readonly afterRecovery?: Effect.Effect<unknown, unknown, JobServices>;
  /**
   * Runs on every turn of the worker's loop, after it ingested and took what it could, such as
   * declaring the Graph cache's bases from the queue; it must be quick, throttling itself. A
   * failure is logged and the loop goes on.
   */
  readonly eachTurn?: Effect.Effect<unknown, unknown, JobServices>;
  /**
   * Whether this worker can run a job it took, decided per job (10.17): a review whose route's
   * credential this process lacks is held, not run. A held job goes back to waiting without its
   * attempt counting, is passed over for `HOLD_RECHECK` and does not keep the worker alive. A
   * handler holds a job it already took by failing with an error that carries `hold: true`. An
   * admission that itself fails admits the job.
   */
  readonly admit?: (job: Job) => Effect.Effect<boolean, unknown, JobServices>;
}

/** Whether a failed attempt's error asks for the job to be held rather than failed. */
const isHold = (error: Option.Option<unknown>) =>
  Option.isSome(error) &&
  typeof error.value === "object" &&
  error.value !== null &&
  (error.value as { hold?: unknown }).hold === true;

/** How long a held job is passed over before the worker asks again whether it can run it. */
export const HOLD_RECHECK = Duration.seconds(30);

export {
  holderGone,
  isLive,
  reachStoreWorker,
  reachWorker,
  socketPathFor,
  socketPathReadOnly,
  workerPathsFor,
  subscribeJob,
  stopWorker,
  WorkerSubscriptionLost,
  WorkerSocketUnavailable,
  recoverWorker,
  olderWorkerMessage,
  hasLegacyWorkerClaim,
  requireCurrentWorkerClaim,
  olderBuildWorkerMessage,
  type Reach,
  type WorkerPaths,
  type WorkerReach,
} from "./worker-socket.ts";

/**
 * The claim row records who bound the socket and its last progress. PID and claim time are
 * diagnostics. The socket connection decides ownership.
 */
export interface WorkerClaim {
  readonly pid: number;
  readonly socket: string;
  readonly startedAt: string;
  readonly lastProgressAt: string;
  readonly lastProgress: string;
}

export const readClaim = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const [row] =
    yield* sql<WorkerClaim>`SELECT pid, socket, started_at, last_progress_at,
    last_progress FROM worker_state WHERE id = 1`;
  return Option.fromNullishOr(row);
});

export type WorkerExit =
  | { readonly reason: "another-worker"; readonly pid: number | null }
  | { readonly reason: "idle" }
  | { readonly reason: "stopped" };

/** The job one slot runs. */
export interface SlotJob {
  readonly seq: number;
  readonly kind: JobKind;
  readonly attempt: number;
  readonly startedAt: string;
}

/** How long an ended attempt's handler is given to stop before the worker proceeds without it. */
// A heavy child has six seconds to finalize its own detached command groups.
const INTERRUPT_WAIT = Duration.seconds(8);

/** An attempt ended by its abort signal rather than by its handler (see `aborts` in `run`). */
class Aborted {
  constructor(readonly reason: "drop" | "stop") {}
}

/** What `neuve worker status` hears from a live worker over its socket. */
export interface WorkerStatusReply {
  readonly pid: number;
  /** The version of the program it runs; absent from a worker that doesn't say (an older build). */
  readonly version?: string;
  readonly startedAt: string;
  readonly socket: string;
  /** Each slot's running job, or null when the slot is free (10.31). */
  readonly slots: Readonly<Record<JobSlot, SlotJob | null>>;
  readonly lastProgressAt: string;
  readonly lastProgress: string;
}

const describeError = (error: unknown) => {
  if (typeof error === "object" && error !== null && "_tag" in error) {
    const message = (error as { message?: unknown }).message;
    return `${String((error as { _tag: unknown })._tag)}${typeof message === "string" && message !== "" ? `: ${message}` : ""}`;
  }
  return String(error);
};

const isLockContention = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  (error as { _tag?: unknown })._tag === "SqlError" &&
  (error as { reason?: { _tag?: unknown } }).reason?._tag ===
    "LockTimeoutError";

/**
 * Retries an operation that met SQLite's busy timeout: another process held the write lock for
 * longer than the client waits (a stopped CLI command, a long migrate). The worker keeps a finished
 * attempt's outcome instead of dying with the job still active.
 */
const contended = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.tapError((error) =>
      isLockContention(error)
        ? Effect.logWarning("the store's write lock is busy; retrying")
        : Effect.void,
    ),
    Effect.retry({
      while: isLockContention,
      schedule: Schedule.spaced("1 second"),
    }),
  );

/** The queue as the worker uses it: every operation waits out write-lock contention. */
const lockPatientQueue = (queue: JobQueue["Service"]): JobQueue["Service"] => ({
  ...queue,
  take: (kinds, except) => contended(queue.take(kinds, except)),
  complete: (seq, attempt) => contended(queue.complete(seq, attempt)),
  fail: (seq, attempt, failure) => contended(queue.fail(seq, attempt, failure)),
  release: (seq, attempt) => contended(queue.release(seq, attempt)),
  recoverStalled: contended(queue.recoverStalled),
  outstanding: (kinds, except) => contended(queue.outstanding(kinds, except)),
});

const iso = (millis: number) => new Date(millis).toISOString();

const jsonSafe = (value: unknown): unknown => {
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return String(value);
  }
};

/**
 * The structured cause of a failed attempt, kept on the job (8.12). An error carrying
 * `retryable: false` ends the job at once; one carrying a positive `pauseMs` pauses it that long
 * without counting the attempt.
 */
export const describeFailure = (
  cause: Cause.Cause<unknown>,
  policy: JobPolicy,
): AttemptFailure => {
  const error = Cause.findErrorOption(cause);
  if (Option.isNone(error)) {
    const defect = Cause.squash(cause);
    return {
      tag: "Defect",
      message: defect instanceof Error ? defect.message : String(defect),
    };
  }
  const value = error.value;
  if (Cause.isTimeoutError(value)) {
    const deadlineMs = Duration.toMillis(policy.deadline);
    return {
      tag: "DeadlineExceeded",
      message: `attempt ran past its ${Duration.format(policy.deadline)} deadline and was interrupted`,
      detail: { deadlineMs },
    };
  }
  if (typeof value === "object" && value !== null && "_tag" in value) {
    const {
      _tag,
      message,
      stack: _stack,
      retryable,
      ...fields
    } = value as {
      _tag: unknown;
      message?: unknown;
      stack?: unknown;
      retryable?: unknown;
    } & Record<string, unknown>;
    const pauseMs = fields["pauseMs"];
    return {
      tag: String(_tag),
      message: typeof message === "string" ? message : "",
      ...(Object.keys(fields).length === 0 ? {} : { detail: jsonSafe(fields) }),
      ...(retryable === false ? { final: true } : {}),
      ...(typeof pauseMs === "number" && Number.isFinite(pauseMs) && pauseMs > 0
        ? { pauseMs }
        : {}),
    };
  }
  if (value instanceof Error)
    return { tag: value.name, message: value.message };
  return { tag: "Failure", message: String(value) };
};

interface StartupClaim {
  readonly scope: Scope.Closeable;
  readonly inode: number;
  readonly accept: (
    command: (line: string) => string,
    held: (seq: number) => boolean,
    connection: Effect.Effect<void>,
  ) => Effect.Effect<void>;
}
const Startup = Context.Reference<StartupClaim | undefined>(
  "@neuve/records-core/Worker/Startup",
  {
    defaultValue: () => undefined,
  },
);

const acknowledgeStartup = Effect.sync(() => {
  if (process.env.NEUVE_WORKER_READY_FD !== "3") return;
  delete process.env.NEUVE_WORKER_READY_FD;
  try {
    writeSync(3, "ready\n");
    closeSync(3);
  } catch {
    /* The starter may have left. */
  }
});

/** Acquire and reserve before providing Store.layer. Socket clients wait for the acceptance commit. */
export const withStartup = <E, R>(
  location: StoreLocation,
  program: Effect.Effect<WorkerExit, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem;
      yield* fs.makeDirectory(location.directory, {
        recursive: true,
        mode: STORE_DIRECTORY_MODE,
      });
      const paths = yield* workerPathsFor(location);
      const path = paths.socket;
      const scope = yield* Scope.make();
      let inode: number | undefined;
      yield* Effect.addFinalizer((exit) =>
        Effect.gen(function* () {
          // Closing a Bun server unlinks its pathname, so never close another server's path.
          if (inode !== undefined) {
            const current = yield* fs.stat(path).pipe(Effect.option);
            if (
              Option.isSome(current) &&
              Option.getOrElse(current.value.ino, () => -1) !== inode
            )
              return;
          }
          yield* Scope.close(scope, exit);
        }),
      );
      const refused = Effect.gen(function* () {
        if (yield* startupMayAcknowledge(location, path, false))
          yield* acknowledgeStartup;
        return { reason: "another-worker", pid: null } satisfies WorkerExit;
      });
      const lock = yield* Effect.acquireRelease(
        claimWorkerLock(paths.lock),
        (lock) => Effect.sync(() => lock?.close()),
      ).pipe(Scope.provide(scope));
      // Two separate commands starting a worker in the same instant can still make one print:
      // The CLI prints "neuve: The background worker didn't finish starting.\nRun the command again."
      // A rerun works; tracked in NEU-152.
      if (lock === undefined) {
        // Every build takes this lock; say so when the holder is an older build's worker.
        const legacy = paths.legacy;
        if (
          legacy !== undefined &&
          isLive(yield* reachWorker(legacy, undefined, "500 millis"))
        )
          yield* Effect.logInfo(
            `worker ? holds ${path} (${olderBuildWorkerMessage(legacy)}); this start exits`,
          );
        return yield* refused;
      }
      const legacy = yield* Effect.result(requireCurrentWorkerClaim(location));
      if (legacy._tag === "Failure") {
        if (legacy.failure instanceof OlderWorkerHeld) {
          yield* Effect.logWarning(String(legacy.failure));
          return yield* refused;
        }
        if (!(legacy.failure instanceof StoreChangedDuringRead))
          return yield* Effect.fail(legacy.failure);
      }
      const reach = yield* reachWorker(path, undefined, "2 seconds");
      if (!canReplaceListener(reach)) return yield* refused;
      if (reach._tag === "Refused") yield* fs.remove(path);
      const accepted = yield* Deferred.make<void>();
      let command = (_line: string) => "unknown command";
      let held = (_seq: number) => false;
      let connection = Effect.void;
      yield* serve(
        path,
        (line) => command(line),
        (seq) => held(seq),
        Effect.andThen(
          Deferred.await(accepted),
          Effect.suspend(() => connection),
        ),
      ).pipe(Scope.provide(scope));
      inode = Option.getOrElse((yield* fs.stat(path)).ino, () => -1);
      const startup: StartupClaim = {
        scope,
        inode,
        accept: (onCommand, isHeld, onConnection) =>
          Effect.gen(function* () {
            command = onCommand;
            held = isHeld;
            connection = onConnection;
            yield* Deferred.succeed(accepted, undefined);
          }),
      };
      return yield* program.pipe(Effect.provideService(Startup, startup));
    }),
  );

/**
 * The singleton worker for one repository (8.2, D17, D19).
 *
 * Claim the separate lifetime database's write lock first. Under the Records write transaction,
 * refuse a live old listener, then bind the socket and record worker_state before committing.
 * The lifetime lock remains held until after the server closes. Neither a refused socket nor an
 * absent path displaces a current worker, even when stopped. Nothing expires or probes a PID.
 *
 * Then: recover jobs a dead worker left active, run `afterRecovery`, and loop over spool ingestion
 * and the queue. The loop fills two slots (10.31): the interactive slot runs review runs and the
 * capture slot one scan and background slot everything else, one job each at a time, so a review never waits behind a burst
 * of background work. Each free slot takes its most urgent waiting job (`JobQueue.take`); only this
 * loop takes jobs and decides idleness, so the idle exit never races a slot. While a review runs,
 * code preparation keeps running; other background heavy starts wait at `HeavyWork`. After `idleTimeout` with all
 * slots free, no job queued and no open ACP session, release the socket under the write lock, scan
 * the spool and jobs once more, and exit only if both are empty; otherwise claim again.
 *
 * A worker that finds its path taken by another socket when releasing leaves its own server open
 * rather than close it (closing unlinks the path), so its process must exit when `run` ends.
 */
export const run = (options: WorkerOptions) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const fs = yield* FileSystem;
    let startup = yield* Startup;
    const queue = lockPatientQueue(yield* JobQueue);
    const computations = yield* ComputationStore;
    const handlers = options.handlers ?? handlersFor(options.location);
    const handling = yield* FiberSet.make<unknown, unknown>();
    const kinds = Object.keys(handlers) as Array<JobKind>;
    const slotKinds = (slot: JobSlot) =>
      kinds.filter((kind) => JOB_POLICIES[kind].slot === slot);
    const idleTimeout = Duration.toMillis(
      Duration.fromInputUnsafe(options.idleTimeout ?? "60 seconds"),
    );
    const pollInterval = Duration.toMillis(
      Duration.fromInputUnsafe(options.pollInterval ?? "1 second"),
    );
    const openSessions = options.openSessions ?? Effect.succeed(0);
    const detachedWork = options.detachedWork ?? Effect.succeed(0);
    const paths = yield* workerPathsFor(options.location);
    const path = paths.socket;
    const notices = yield* Queue.dropping<void>(1);
    const requestNotices = Effect.asVoid(Queue.offer(notices, undefined));
    const pid = process.pid;
    const wake = yield* Queue.unbounded<void>();
    const stop = yield* Deferred.make<void>();

    // Claim time and PID are diagnostic, never liveness evidence.
    const now = yield* Clock.currentTimeMillis;
    const startedAt = iso(now);
    const slots: Record<JobSlot, SlotJob | null> = {
      interactive: null,
      background: null,
      capture: null,
    };
    /**
     * Each running attempt's abort signal: `drop` ends the job as dropped (`neuve jobs drop` on an
     * active job), `stop` puts it back to waiting, uncounted, so it resumes later (`neuve worker
     * stop`). Either ends the attempt at once; the handler is interrupted without waiting on it.
     */
    const aborts: Record<
      JobSlot,
      {
        readonly seq: number;
        readonly signal: Deferred.Deferred<"drop" | "stop">;
      } | null
    > = { interactive: null, background: null, capture: null };
    const abortAll = (reason: "drop" | "stop") => {
      for (const slot of JobSlot.options) {
        const running = aborts[slot];
        if (running !== null)
          Deferred.doneUnsafe(running.signal, Effect.succeed(reason));
      }
    };
    /** Open while the interactive slot is free: the background slot's heavy starts wait on it. */
    const interactiveFree = yield* Latch.make(true);
    // Each non-interactive attempt owns its deadline. A cancelled wait cannot pause a later job.
    const heavyWorkFor = (
      deadline: AttemptDeadline,
      prepareDuringReview = false,
    ): HeavyWorkService => {
      const awaitInteractive = Effect.gen(function* () {
        while (!prepareDuringReview && !Latch.isOpen(interactiveFree)) {
          yield* Effect.logInfo(
            "background heavy subprocess waits for the interactive review to end",
          );
          if (deadline !== undefined)
            deadline.pausedSince = yield* Clock.currentTimeMillis;
          yield* interactiveFree.await.pipe(
            Effect.ensuring(
              Effect.map(Clock.currentTimeMillis, (now) =>
                deadline?.resume(now),
              ),
            ),
          );
        }
      });
      const spawnHeavy = <A, B, E, R>(
        prepare: Effect.Effect<A, E, R>,
        spawnSync: (prepared: A) => B,
      ): Effect.Effect<B, E, R> =>
        Effect.suspend(() => {
          const attempt = (): Effect.Effect<B, E, R> =>
            Effect.gen(function* () {
              const prepared = yield* Effect.interruptible(prepare);
              // The final latch read and process creation share one synchronous JavaScript turn.
              const result = yield* Effect.sync(() =>
                prepareDuringReview || Latch.isOpen(interactiveFree)
                  ? { ready: true as const, value: spawnSync(prepared) }
                  : { ready: false as const },
              );
              if (result.ready) return result.value;
              yield* Effect.interruptible(awaitInteractive);
              return yield* attempt();
            });
          return attempt();
        });
      return withScopedChild({
        start: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          Effect.andThen(awaitInteractive, effect),
        spawn: spawnHeavy,
      });
    };
    let lastProgressAt = iso(now);
    let lastProgress = "started";
    /** The bound server's scope and the inode of the socket file it created. */
    let held:
      { readonly scope: Scope.Closeable; readonly inode: number } | undefined;

    const onCommand = (command: string): string => {
      switch (command) {
        case "wake":
          Queue.offerUnsafe(wake, undefined);
          return "ok";
        case "stop":
          // Release active attempts; required handler finalization drains before worker exit.
          abortAll("stop");
          Deferred.doneUnsafe(stop, Effect.void);
          return "stopping";
        case "status": {
          const reply: WorkerStatusReply = {
            pid,
            ...(options.version === undefined
              ? {}
              : { version: options.version }),
            startedAt,
            socket: path,
            slots: { ...slots },
            lastProgressAt,
            lastProgress,
          };
          return JSON.stringify(reply);
        }
        default: {
          const drop = /^drop (\d+)$/.exec(command);
          if (drop !== null) {
            const seq = Number(drop[1]);
            const slot = JobSlot.options.find((s) => aborts[s]?.seq === seq);
            if (slot === undefined) return "not running";
            Deferred.doneUnsafe(aborts[slot]!.signal, Effect.succeed("drop"));
            return "dropping";
          }
          return "unknown command";
        }
      }
    };

    const progress = (text: string) =>
      Effect.gen(function* () {
        lastProgressAt = iso(yield* Clock.currentTimeMillis);
        lastProgress = text;
        yield* contended(sql`UPDATE worker_state SET last_progress_at = ${lastProgressAt},
          last_progress = ${text} WHERE pid = ${pid}`);
      });

    const removeSocketFile = fs
      .remove(path)
      .pipe(
        Effect.catchTag("PlatformError", (error) =>
          error.reason._tag === "NotFound" ? Effect.void : Effect.fail(error),
        ),
      );

    /** The inode at the socket path, or `None` when nothing is there. */
    const socketInode = fs.stat(path).pipe(
      Effect.map((info) => Option.some(Option.getOrElse(info.ino, () => -1))),
      Effect.catchTag("PlatformError", (error) =>
        error.reason._tag === "NotFound"
          ? Effect.succeed(Option.none<number>())
          : Effect.fail(error),
      ),
    );

    type Claim =
      | { readonly claimed: true; readonly holder: number }
      | {
          readonly claimed: false;
          readonly holder: number | null;
          readonly evidence: string;
        };

    const claim = Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const initial = startup;
        startup = undefined;
        const scope = initial?.scope ?? (yield* Scope.make());
        let inode = initial?.inode ?? -1;
        const result = yield* Effect.exit(
          Effect.gen(function* () {
            const lock =
              initial ??
              (yield* Effect.acquireRelease(
                claimWorkerLock(paths.lock),
                (lock) => Effect.sync(() => lock?.close()),
              ).pipe(Scope.provide(scope)));
            if (lock === undefined) {
              // Every build takes this lock; say so when the holder is an older build's worker.
              const legacy = paths.legacy;
              const older =
                legacy !== undefined &&
                isLive(yield* reachWorker(legacy, undefined, "500 millis"));
              return {
                claimed: false,
                holder: null,
                evidence: older
                  ? olderBuildWorkerMessage(legacy)
                  : "its lifetime SQLite write lock is held",
              } satisfies Claim;
            }
            return yield* restore(
              contended(
                sql.withTransaction(
                  Effect.gen(function* () {
                    const [recorded] = yield* sql<{
                      pid: number;
                      socket: string;
                      startedAt: string;
                    }>`SELECT pid, socket, started_at FROM worker_state WHERE id = 1`;
                    const holder =
                      recorded !== undefined && recorded.pid !== pid
                        ? recorded
                        : undefined;
                    const reach =
                      initial === undefined
                        ? yield* reachWorker(path, undefined, "2 seconds")
                        : { _tag: "Absent" as const };
                    const legacy =
                      paths.legacy === undefined
                        ? undefined
                        : {
                            path: paths.legacy,
                            reach: yield* reachWorker(
                              paths.legacy,
                              undefined,
                              "2 seconds",
                            ),
                          };
                    const [marker] = yield* sql<{
                      n: number;
                    }>`SELECT count(*) AS n FROM worker_lock_claim`;
                    if (recorded !== undefined && (marker?.n ?? 0) === 0) {
                      const message = olderWorkerMessage(
                        options.location.directory,
                      );
                      yield* Effect.logWarning(message);
                      return {
                        claimed: false,
                        holder: recorded.pid,
                        evidence: message,
                      } satisfies Claim;
                    }
                    if (isLive(reach)) {
                      const refused: Claim = {
                        claimed: false,
                        holder: holder?.pid ?? null,
                        evidence: "its socket accepted a connection",
                      };
                      return refused;
                    }
                    if (legacy !== undefined && isLive(legacy.reach)) {
                      const refused: Claim = {
                        claimed: false,
                        holder: holder?.pid ?? null,
                        evidence: olderBuildWorkerMessage(legacy.path),
                      };
                      return refused;
                    }
                    if (!canReplaceListener(reach)) {
                      const refused: Claim = {
                        claimed: false,
                        holder: holder?.pid ?? null,
                        evidence: `its socket ${reach._tag === "Refused" ? `refused the connection (${reach.code})` : "is absent"} and its listener is not shown gone`,
                      };
                      return refused;
                    }
                    if (
                      legacy !== undefined &&
                      !canReplaceListener(legacy.reach)
                    ) {
                      const refused: Claim = {
                        claimed: false,
                        holder: holder?.pid ?? null,
                        evidence: `the store's legacy socket ${legacy.path} refused the connection (${legacy.reach._tag === "Refused" ? legacy.reach.code : "?"}) and its listener is not shown gone`,
                      };
                      return refused;
                    }
                    // The lifetime lock is ours and no old listener accepts connections. Even an
                    // unbound socket file in the store makes Neuve Graph refuse the repository.
                    if (reach._tag === "Refused") yield* removeSocketFile;
                    if (legacy?.reach._tag === "Refused")
                      yield* removeStaleLegacySocket(legacy.path);
                    const bound = Effect.gen(function* () {
                      if (initial === undefined)
                        yield* serve(
                          path,
                          onCommand,
                          (seq) => heldJobs.has(seq),
                          requestNotices,
                        ).pipe(Scope.provide(scope));
                      const inode = yield* socketInode;
                      if (
                        initial !== undefined &&
                        (Option.isNone(inode) || inode.value !== initial.inode)
                      )
                        return yield* Effect.fail(
                          new Error("Worker socket changed before acceptance"),
                        );
                      yield* sql`INSERT INTO worker_state ${sql.insert({
                        id: 1,
                        pid,
                        socket: path,
                        started_at: startedAt,
                        last_progress_at: iso(yield* Clock.currentTimeMillis),
                        last_progress: "claimed",
                      })} ON CONFLICT (id) DO UPDATE SET pid = excluded.pid, socket = excluded.socket,
              started_at = excluded.started_at, last_progress_at = excluded.last_progress_at,
              last_progress = excluded.last_progress`;
                      yield* sql`INSERT INTO worker_lock_claim(id) VALUES (1)`;
                      return Option.getOrElse(inode, () => -1);
                    });
                    // Closing unlinks the path; on a failed bind the path is not ours and Bun leaves it alone.
                    inode = yield* bound;
                    const claimed: Claim = { claimed: true, holder: pid };
                    return claimed;
                  }),
                ),
              ),
            );
          }),
        );
        if (Exit.isSuccess(result) && result.value.claimed) {
          held = { scope, inode };
          if (initial !== undefined)
            yield* initial.accept(
              onCommand,
              (seq) => heldJobs.has(seq),
              requestNotices,
            );
        } else if (initial === undefined) yield* Scope.close(scope, result);
        return yield* result;
      }),
    );

    /**
     * Unbinds under the write lock, so no starter sees a half-released claim. The server is closed,
     * which unlinks the socket path, only while the claim row still names this process and the path
     * is still this server's own socket file; otherwise the path belongs to someone else.
     */
    const release = contended(
      sql.withTransaction(
        Effect.gen(function* () {
          const bound = held;
          if (bound === undefined) return;
          const [recorded] = yield* sql<{
            pid: number;
          }>`SELECT pid FROM worker_state WHERE id = 1`;
          const named = recorded?.pid === pid;
          const inode = yield* socketInode;
          const ownsPath = Option.isNone(inode) || inode.value === bound.inode;
          if (named && ownsPath) yield* Scope.close(bound.scope, Exit.void);
          else
            yield* Effect.logWarning(
              `not closing the server: ${named ? `${path} is another socket file now` : `the claim names worker ${recorded?.pid ?? "(none)"}`}; it stays unreachable until this process exits`,
            );
          if (named) yield* sql`DELETE FROM worker_state WHERE id = 1`;
          held = undefined;
        }),
      ),
    );

    /** Jobs this worker holds (10.17), by sequence, with when to ask about each again. */
    const heldJobs = new Map<number, number>();
    const heldSeqs = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      for (const [seq, until] of heldJobs)
        if (until <= now) heldJobs.delete(seq);
      return [...heldJobs.keys()];
    });
    /**
     * Newer kinds in the cycle of a job that reads its whole cycle (12.24). Such a job is held, once
     * logged, so a newer build's worker runs it with every event. A check that cannot be made holds
     * the job too: it never runs on a cycle this worker could not read.
     */
    const newerInCycle = new Set<number>();
    const cycleKnown = (job: Job) =>
      Effect.gen(function* () {
        if (JOB_POLICIES[job.kind].wholeCycle !== true || job.eventId === null)
          return true;
        const [row] = yield* sql<{
          n: number;
        }>`SELECT count(*) AS n FROM events e JOIN event_cycles c ON c.event_seq = e.seq
          WHERE c.cycle_id IN (SELECT ec.cycle_id FROM event_cycles ec JOIN events r ON r.seq = ec.event_seq
            WHERE r.id = ${job.eventId})
            AND NOT ${sql.in("e.kind", KNOWN_EVENT_KINDS)}`;
        if ((row?.n ?? 0) === 0) return true;
        if (!newerInCycle.has(job.seq)) {
          newerInCycle.add(job.seq);
          yield* Effect.logWarning(
            `job ${job.seq} ${job.kind} left for a newer build: its cycle holds ${row?.n} event(s) of kinds this build does not know`,
          );
        }
        return false;
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            if (!newerInCycle.has(job.seq)) {
              newerInCycle.add(job.seq);
              yield* Effect.logWarning(
                `job ${job.seq} ${job.kind} held: its cycle could not be checked for kinds this build does not know (${Cause.pretty(cause).split("\n")[0]})`,
              );
            }
            return false;
          }),
        ),
      );
    const admitted = (job: Job) =>
      Effect.gen(function* () {
        if (!(yield* cycleKnown(job))) return false;
        return options.admit === undefined
          ? true
          : yield* options
              .admit(job)
              .pipe(Effect.catch(() => Effect.succeed(true)));
      });
    /** Puts a job this worker cannot run back to waiting, its attempt uncounted, and passes it over. */
    const hold = (job: Job) =>
      Effect.gen(function* () {
        const released = yield* Effect.result(
          queue.release(job.seq, job.attempts),
        );
        heldJobs.set(
          job.seq,
          (yield* Clock.currentTimeMillis) + Duration.toMillis(HOLD_RECHECK),
        );
        jobChanged(path, job.seq, true);
        yield* Effect.logInfo(
          `job ${job.seq} ${job.kind} held: this worker cannot run it now${released._tag === "Success" ? "; back to waiting" : ""} (asked again in ${Duration.format(HOLD_RECHECK)})`,
        );
      });

    const runJob = (job: Job, slot: JobSlot) =>
      Effect.gen(function* () {
        const handler = handlers[job.kind];
        if (handler === undefined) return;
        const policy = JOB_POLICIES[job.kind];
        slots[slot] = {
          seq: job.seq,
          kind: job.kind,
          attempt: job.attempts,
          startedAt: job.startedAt ?? iso(yield* Clock.currentTimeMillis),
        };
        yield* Effect.logInfo(
          `job ${job.seq} ${job.kind} attempt ${job.attempts}/${policy.maxAttempts} started in the ${slot} slot (priority ${policy.priority}, stalls ${job.stalls}, deadline ${Duration.format(policy.deadline)})`,
        );
        yield* progress(
          `running job ${job.seq} attempt ${job.attempts} (${slot})`,
        );
        const deadline = yield* attemptDeadline(policy);
        const signal = yield* Deferred.make<"drop" | "stop">();
        aborts[slot] = { seq: job.seq, signal };
        // The handler runs in a fiber of its own, so an abort or the deadline ends the attempt at
        // once, and whatever its in-flight calls return is discarded. After a drop or the deadline
        // the handler's interruption is awaited, bounded (`INTERRUPT_WAIT`), before the slot is
        // freed and the job's outcome recorded, so a straggler in an uninterruptible region rarely
        // overlaps the next job or recreates a deleted run folder. A stop releases the slot at once;
        // explicitly retained handlers still drain before the worker releases its services.
        const handlerFiber: Fiber.Fiber<unknown, unknown> =
          yield* Effect.forkDetach(
            Effect.provideService(
              slot !== "interactive"
                ? Effect.provideService(
                    handler(job),
                    HeavyWork,
                    heavyWorkFor(
                      deadline,
                      job.kind === "commit.prepare" ||
                        job.kind === "commit.prepare@2",
                    ),
                  )
                : handler(job),
              HandlerLifetime,
              {
                retain: Effect.sync(() =>
                  FiberSet.addUnsafe(handling, handlerFiber),
                ),
              },
            ),
            { startImmediately: false },
          );
        const attempt = Effect.raceFirst(
          Effect.raceFirst(Fiber.join(handlerFiber), deadline.expired),
          Effect.map(Deferred.await(signal), (reason) => new Aborted(reason)),
        ).pipe(
          Effect.onInterrupt(() =>
            Effect.asVoid(Effect.forkDetach(Fiber.interrupt(handlerFiber))),
          ),
        );
        const exit = yield* Effect.exit(attempt);
        const aborted =
          Exit.isSuccess(exit) && exit.value instanceof Aborted
            ? exit.value.reason
            : undefined;
        if (aborted === "stop")
          yield* Effect.forkDetach(Fiber.interrupt(handlerFiber));
        else {
          const stopped = yield* Fiber.interrupt(handlerFiber).pipe(
            Effect.timeoutOption(INTERRUPT_WAIT),
          );
          if (Option.isNone(stopped))
            yield* Effect.logWarning(
              `job ${job.seq} ${job.kind}: its handler did not stop within ${Duration.format(INTERRUPT_WAIT)} of the attempt ending (an uninterruptible call); proceeding`,
            );
        }
        aborts[slot] = null;
        slots[slot] = null;
        if (aborted === "stop") {
          // Not final: back to waiting, its attempt uncounted, so it resumes at the next start.
          yield* queue.release(job.seq, job.attempts);
          yield* Effect.logInfo(
            `job ${job.seq} ${job.kind} attempt ${job.attempts} aborted: worker stopping; back to waiting`,
          );
          return;
        }
        if (aborted === "drop") {
          // Dropped (`neuve jobs drop`): failed with cause Dropped, never retried.
          yield* queue.fail(job.seq, job.attempts, {
            tag: "Dropped",
            message: `dropped while active (attempt ${job.attempts}); the attempt was aborted`,
            final: true,
          });
          yield* Effect.logWarning(
            `job ${job.seq} ${job.kind} attempt ${job.attempts} dropped while active; its attempt was aborted`,
          );
          yield* progress(`job ${job.seq} dropped`);
          return;
        }
        if (Exit.isSuccess(exit)) {
          yield* queue.complete(job.seq, job.attempts);
          yield* Effect.logInfo(`job ${job.seq} ${job.kind} completed`);
          yield* progress(`completed job ${job.seq}`);
          return;
        }
        if (Cause.hasInterruptsOnly(exit.cause)) return yield* Effect.interrupt;
        // A handler that says the job must wait (an error carrying `hold: true`, such as a credential
        // lost mid-run, 10.17) has it held instead of spending its attempts. The handler's own check
        // decides; admission is not asked again, so the two can never disagree.
        if (isHold(Cause.findErrorOption(exit.cause))) {
          yield* hold(job);
          yield* progress(`job ${job.seq} held`);
          return;
        }
        const failure = describeFailure(exit.cause, policy);
        const outcome = yield* queue.fail(job.seq, job.attempts, failure);
        yield* Effect.logWarning(
          outcome.state === "delayed"
            ? `job ${job.seq} ${job.kind} attempt ${job.attempts} failed: ${failure.tag}: ${failure.message}; retry at ${outcome.runAt}`
            : `job ${job.seq} ${job.kind} attempt ${job.attempts} failed: ${failure.tag}: ${failure.message}; final state failed${failure.final === true ? " (not retried: no attempt can succeed)" : ""}`,
        );
        yield* progress(`job ${job.seq} ${outcome.state}`);
      }).pipe(
        Effect.onInterrupt(() =>
          Effect.gen(function* () {
            slots[slot] = null;
            aborts[slot] = null;
            const released = yield* Effect.result(
              queue.release(job.seq, job.attempts),
            );
            if (released._tag === "Success")
              yield* Effect.logInfo(
                `job ${job.seq} released back to waiting (worker stopping)`,
              );
          }),
        ),
      );

    const ingest = Effect.gen(function* () {
      const report = yield* Effect.result(ingestSpool(options.location));
      if (report._tag === "Failure") {
        yield* Effect.logWarning(
          `spool ingestion stopped; files stay for the next scan: ${describeError(report.failure)}`,
        );
        return;
      }
      const { appended, existing, keptEarlier, rejected } = report.success;
      if (appended + existing + keptEarlier + rejected.length > 0)
        yield* Effect.logInfo(
          `spool ingested: ${appended} appended, ${existing} already recorded, ${keptEarlier} second vent(s) answered with the earlier one kept, ${rejected.length} rejected${rejected.map((r) => `; ${r.file}: ${r.reason}`).join("")}`,
        );
    });

    /** Waits for a wake message, the next delayed job, or the poll interval. */
    const pause = (nextRunAt: string | null) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const untilDue =
          nextRunAt === null ? pollInterval : Date.parse(nextRunAt) - now;
        const wait = Math.max(10, Math.min(pollInterval, untilDue));
        yield* Effect.raceFirst(
          Effect.sleep(Duration.millis(wait)),
          Queue.take(wake),
        );
        yield* Queue.clear(wake);
      });

    /**
     * Retention needs no timer: the worker asks at start, and again whenever it finds no job on a new
     * day, whether raw captures are due (one prune key per day, see `Retention`). Hooks, the CLI and
     * the launchd sweep start the worker, and the sweep starts one when a prune is wanted.
     */
    let retentionCheckedDay = "";
    const checkRetention = Effect.gen(function* () {
      if (handlers["retention.prune"] === undefined) return;
      const day = iso(yield* Clock.currentTimeMillis).slice(0, 10);
      if (day === retentionCheckedDay) return;
      retentionCheckedDay = day;
      const scheduled = yield* contended(schedulePrune(queue));
      if (Option.isSome(scheduled))
        yield* Effect.logInfo(
          `${scheduled.value.reason}: enqueued retention.prune as job ${scheduled.value.seq}`,
        );
    });

    /** Errors a slot's job can end the worker with: the queue's, past write-lock contention. */
    type SlotError = Effect.Error<ReturnType<typeof runJob>>;

    /** Whether each slot runs a job; only the loop sets a slot busy, and only its job frees it. */
    const busy: Record<JobSlot, boolean> = {
      interactive: false,
      background: false,
      capture: false,
    };

    /**
     * Starts `job` in `slot` as a fiber of `running`. When the job ends the slot is free again and
     * the loop wakes, so the slot takes its next job at once. A review closes the latch for its run.
     */
    const startInSlot = (
      running: FiberSet.FiberSet<void, SlotError>,
      slot: JobSlot,
      job: Job,
    ) =>
      Effect.gen(function* () {
        busy[slot] = true;
        if (slot === "interactive") yield* interactiveFree.close;
        yield* FiberSet.run(running)(
          runJob(job, slot).pipe(
            Effect.ensuring(
              Effect.gen(function* () {
                busy[slot] = false;
                if (slot === "interactive") yield* interactiveFree.open;
                yield* Queue.offer(wake, undefined);
              }),
            ),
          ),
        );
      });

    const loop = (running: FiberSet.FiberSet<void, SlotError>) =>
      Effect.gen(function* () {
        let idleSince = yield* Clock.currentTimeMillis;
        while (true) {
          yield* ingest;
          for (const slot of JobSlot.options) {
            if (busy[slot]) continue;
            const job = yield* queue.take(slotKinds(slot), yield* heldSeqs);
            if (Option.isSome(job)) {
              if (yield* admitted(job.value))
                yield* startInSlot(running, slot, job.value);
              else yield* hold(job.value);
            } else if (slot === "background") yield* checkRetention;
          }
          if (options.eachTurn !== undefined)
            yield* options.eachTurn.pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning(
                  `the loop turn's own work did not finish: ${Cause.pretty(cause).split("\n")[0]}`,
                ),
              ),
            );
          const except = yield* heldSeqs;
          const outstanding = yield* queue.outstanding(kinds, except);
          // The next wake is due only for a slot that could take the job: a busy slot's retry waits
          // for its job to end, which wakes the loop (`startInSlot`), so it never spins the loop.
          const freeKinds = JobSlot.options.flatMap((slot) =>
            busy[slot] ? [] : slotKinds(slot),
          );
          const nextRunAt =
            freeKinds.length === 0
              ? null
              : (yield* queue.outstanding(freeKinds, except)).nextRunAt;
          const sessions = yield* openSessions;
          const now = yield* Clock.currentTimeMillis;
          const working =
            busy.interactive ||
            busy.background ||
            busy.capture ||
            (yield* FiberSet.size(handling)) > 0 ||
            (yield* detachedWork) > 0;
          if (working || outstanding.queued > 0 || sessions > 0)
            idleSince = now;
          else if (now - idleSince >= idleTimeout) {
            if (options.beforeIdleExit && !(yield* options.beforeIdleExit)) {
              idleSince = now;
              continue;
            }
            yield* release;
            yield* Effect.logInfo(
              `idle for ${Duration.format(Duration.millis(idleTimeout))}: socket released under the write lock; rescanning spool and jobs`,
            );
            const spool = yield* pendingSpoolFiles(options.location);
            const queued = (yield* queue.outstanding(kinds, yield* heldSeqs))
              .queued;
            if (spool.length === 0 && queued === 0) {
              const exit: WorkerExit = { reason: "idle" };
              return exit;
            }
            yield* Effect.logInfo(
              `rescan found ${spool.length} spool file(s) and ${queued} job(s); claiming again`,
            );
            const again = yield* claim;
            if (!again.claimed) {
              yield* Effect.logInfo(
                `worker ${again.holder ?? "?"} claimed the socket meanwhile (${again.evidence}); exiting`,
              );
              const exit: WorkerExit = {
                reason: "another-worker",
                pid: again.holder,
              };
              return exit;
            }
            idleSince = yield* Clock.currentTimeMillis;
            continue;
          }
          yield* Effect.logDebug(
            `loop turn: interactive ${busy.interactive ? "busy" : "free"}, background ${busy.background ? "busy" : "free"}, ${outstanding.queued} queued, next due for a free slot ${nextRunAt ?? "none"}`,
          );
          yield* pause(nextRunAt);
        }
      });

    yield* Effect.addFinalizer(() =>
      held === undefined ? Effect.void : Effect.ignore(release),
    );
    const reserved = startup !== undefined;
    const first = yield* claim;
    if (
      (first.claimed || !reserved) &&
      (yield* startupMayAcknowledge(options.location, path, first.claimed))
    )
      yield* acknowledgeStartup;
    if (!first.claimed) {
      yield* Effect.logInfo(
        `worker ${first.holder ?? "?"} holds ${path} (${first.evidence}); this start exits`,
      );
      const exit: WorkerExit = { reason: "another-worker", pid: first.holder };
      return exit;
    }
    return yield* Effect.gen(function* () {
      yield* Effect.logInfo(`worker ${pid} claimed ${path}`);
      yield* contended(deliverJobNotices(path));
      const draining = yield* Effect.forkScoped(
        Effect.forever(
          Effect.andThen(
            Queue.take(notices),
            contended(deliverJobNotices(path)),
          ),
        ),
      );
      const observer = yield* Effect.acquireRelease(
        Effect.try(() =>
          watchRecordsDatabase(options.location.database, () =>
            Queue.offerUnsafe(notices, undefined),
          ),
        ),
        (observer) => Effect.promise(() => observer.close()),
      );
      yield* Effect.tryPromise(() => observer.ready);
      yield* requestNotices;
      for (const recovered of yield* queue.recoverStalled) {
        const { job, state } = recovered;
        yield* Effect.logWarning(
          state === "waiting"
            ? `job ${job.seq} ${job.kind} was left active by a dead worker: back to waiting (stall ${job.stalls} of limit ${JOB_POLICIES[job.kind].stallLimit})`
            : `job ${job.seq} ${job.kind} was left active by a dead worker: stall ${job.stalls} is past limit ${JOB_POLICIES[job.kind].stallLimit}; failed`,
        );
      }
      if (options.beforeComputationRecovery)
        yield* options.beforeComputationRecovery;
      yield* checkRetention;
      for (const attempt of yield* contended(computations.recoverAbandoned))
        yield* Effect.logWarning(
          `computation attempt ${attempt.attemptId} (key ${attempt.key.slice(0, 12)}) was left running by a dead worker: abandoned`,
        );
      if (options.afterRecovery !== undefined)
        yield* options.afterRecovery.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning(
              `start-up after recovery did not finish: ${Cause.pretty(cause).split("\n")[0]}`,
            ),
          ),
        );
      // Closing this scope interrupts both slots, which put their jobs back to waiting, before the
      // socket is released. A slot's job that fails the worker (a store error) ends the race.
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const running = yield* FiberSet.make<void, SlotError>();
          return yield* Effect.raceFirst(
            Effect.raceFirst(
              Effect.raceFirst(
                loop(running),
                Effect.andThen(FiberSet.join(running), Effect.never),
              ),
              Effect.as(Deferred.await(stop), {
                reason: "stopped",
              } as WorkerExit),
            ),
            Effect.raceFirst(
              Effect.andThen(Fiber.join(draining), Effect.never),
              Effect.flatMap(
                Effect.promise(() => observer.failed),
                Effect.fail,
              ),
            ),
          );
        }),
      );
    }).pipe(
      Effect.provideService(LocalJobPublication, requestNotices),
      Effect.ensuring(
        Effect.gen(function* () {
          yield* Fiber.interruptAll(handling);
          if (held === undefined) return;
          yield* Effect.ignore(release);
          yield* Effect.logInfo(`worker ${pid} released ${path}`);
        }),
      ),
    );
  }).pipe(Effect.scoped, Effect.provideService(Running, true));

/** Writes the worker's exit for logs. */
export const describeExit = (exit: WorkerExit) => {
  switch (exit.reason) {
    case "another-worker":
      return `exiting: worker ${exit.pid ?? "(unknown pid)"} holds the socket`;
    case "idle":
      return "exiting after idling with no work";
    case "stopped":
      return "exiting: stopped on request";
  }
};
