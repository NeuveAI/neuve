import { accountReadRefused } from "@neuve/runtime";
import { z } from "zod";
import { safeRead } from "@neuve/records-schema";
import { readData } from "@neuve/records-core";
import { scopeFetchHandler } from "./scope.ts";
import { INDEX_BOUNDS } from "./search-index.ts";
import { withGitReadSnapshot } from "./git-read-snapshot.ts";
import { startLogSpan, scopedLogSpan } from "./log-span.ts";
import { jobBudget } from "./budget/local.ts";
import type { StopCause } from "./pi/control.ts";
import { CLEANUP_MARGIN_MS } from "./run-schedule.ts";
import {
  closeFailureRecord,
  publicCloseReason,
} from "./pi/capture/close-diagnostic.ts";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { TaskOutcome } from "@earendil-works/pi-durable";
import {
  Cause,
  Clock,
  Context,
  Data,
  Duration,
  Effect,
  Layer,
  Metric,
  Option,
} from "effect";
import { FileSystem } from "effect/FileSystem";
import { SqlClient } from "effect/sql/SqlClient";
import { JobKind } from "@neuve/records-schema";
import {
  Blobs,
  Computations,
  JOB_POLICIES,
  JobQueue,
  Log,
  Retention,
  isReviewRun,
  mintUlid,
  STORE_DIRECTORY_MODE,
  STORE_FILE_MODE,
  type StoreLocation,
  Worker,
} from "@neuve/records-core";
import {
  PIPELINE_VERSION,
  currentPipelineProblem,
  PipelineConfig,
  runConfig,
  runSpec,
  type CompletedRun,
} from "./config.ts";
import { readIntegrations, type Integrations } from "./integrations.ts";
import { McpClients, mcpClientsLayer } from "./mcp-client.ts";
import {
  RunContext,
  cutoffAt,
  type PipelineResult,
  type RecomposePolicy,
} from "./pipeline.ts";
import { SourceOwned, SourceOwnership } from "./pi/source-ownership.ts";
import { openAttempt, type OpenedAttempt } from "./pi/attempt.ts";
import type { CloseReceipt } from "./pi/capture/close.ts";
import type { StageStatus } from "./pi/capture/types.ts";
import { claimNonce, HostOpenFailed, type QueueClaim } from "./pi/host.ts";
import {
  contractHoldCorruption,
  contractHoldNeedsNewerBuild,
  contractHoldRecoversWhenReadable,
  heldFailure,
} from "./pi/failure-policy.ts";
import {
  beginNativeMeasurements,
  writeNativeMeasurements,
} from "./pi/measurements.ts";
import type { ReviewOutcome } from "./pi/review-task.ts";
import type { CloseMode } from "./pi/storage.ts";
import {
  buildReceipt,
  harnessActor,
  harnessRegistration,
  recordReceipt,
} from "./receipt.ts";
import { credentialName } from "./route.ts";
import {
  claudeUnavailableReason,
  routeReadiness,
  statusNeedsNewerBuild,
} from "./route-provider.ts";
import {
  AccountNeedsNewerBuild,
  AccountStoreRefused,
  RuntimeUnavailable,
} from "@neuve/runtime";
import { processRuntimes, processReadinessStatuses } from "./runtimes.ts";
import {
  captureFolder,
  deleteRunFolder,
  ensureRunFolder,
  listRunFolders,
  removeRunFolder,
  runFolder,
  runFolderExists,
} from "./run-folder.ts";
import {
  heldReviewsPath,
  readHeldReviews,
  HeldReview,
} from "./held-reviews.ts";
import { openRunLog, type RunLog } from "./run-log.ts";
import { unpublishedBatches } from "./publish-sections.ts";
import {
  otlpTarget,
  readSettings,
  tracerLayer,
  telemetryMode,
} from "./settings.ts";
import { withAttemptMetrics, withCompatibilityRun } from "./telemetry.ts";
import { searchRuntimeFrom, setSearchRuntime } from "./search-config.ts";

/**
 * The `review.run` job handler (10.13): the job queue alone owns the run's lifecycle. Each claim
 * opens the run's pi harness over `pi.sqlite` in the run folder (pi/host.ts), which admits the run's
 * one review task and resumes it: a later claim continues where the last one closed, a held step
 * included (10.17), and only a claim after a failed attempt admits a new review task, keeping the
 * old one as history. Every stage reuses what the computation store holds (5.4, 10.42).
 */

/** The attempt ran up to the job's deadline; the handler ends it itself so it can clean up. */
export class RunDeadlineExceeded extends Data.TaggedError(
  "RunDeadlineExceeded",
)<{
  readonly message: string;
}> {}

/**
 * The run's route lost its credential mid-run (10.17): the worker puts the job back to waiting with
 * its attempt uncounted (`hold: true`), as it does for a job it never admitted.
 */
export class JobHeld extends Data.TaggedError("JobHeld")<{
  readonly message: string;
  readonly hold: true;
}> {}

/** The job's event is not a review request; no attempt can succeed. */
export class NotAReviewRequest extends Data.TaggedError("NotAReviewRequest")<{
  readonly message: string;
  readonly retryable: false;
}> {}

/** No new execution semantics may enter an older frozen run. */
export class UnsupportedReviewPipeline extends Data.TaggedError(
  "UnsupportedReviewPipeline",
)<{
  readonly message: string;
  readonly retryable: false;
}> {}

/** The queue handed over a job without stamping its claim, which every claim does. */
export class ClaimUnstamped extends Data.TaggedError("ClaimUnstamped")<{
  readonly message: string;
  readonly retryable: false;
}> {}

/** A stage failed; `stageError` is the stage's own error tag, such as `AuthenticationError`. */
export class RunFailed extends Data.TaggedError("RunFailed")<{
  readonly stageError: string;
  readonly message: string;
  readonly status?: number;
  /** False when no later attempt can succeed, such as a key the provider refuses (401, 403). */
  readonly retryable: boolean;
}> {}

/**
 * A review task that ended without completing, as the run's failure: a stage's tagged failure keeps
 * its tag and whether a later attempt can succeed (`toStageFailure`); anything else is retried.
 */
const stageFailure = (
  outcome: Exclude<TaskOutcome<ReviewOutcome>, { status: "completed" }>,
) => {
  const detail =
    outcome.status === "failed" || outcome.status === "faulted"
      ? outcome.error.detail
      : undefined;
  const tagged =
    typeof detail === "object" && detail !== null && !Array.isArray(detail)
      ? detail
      : {};
  const message =
    outcome.status === "failed" || outcome.status === "faulted"
      ? outcome.error.message
      : `the review task was ${outcome.status}${outcome.reason === undefined ? "" : `: ${outcome.reason}`}`;
  return {
    stageError: typeof tagged.tag === "string" ? tagged.tag : outcome.status,
    message,
    retryable: tagged.retryable !== false,
    ...(typeof tagged.status === "number" ? { status: tagged.status } : {}),
  };
};

/** How long before the job's deadline the handler stops, to leave time for its cleanup. */
const DEADLINE_MARGIN = Duration.millis(CLEANUP_MARGIN_MS);

/**
 * When the handler stops an attempt: the job's own deadline, its run's frozen lifetime (10 minutes
 * unless the requester's settings name a longer one), never past the queue's for the kind, less the
 * margin for cleanup.
 */
export const attemptStop = (config: PipelineConfig) =>
  Duration.subtract(
    Duration.min(
      Duration.millis(config.budgets.lifetimeMs),
      JOB_POLICIES["review.run"].deadline,
    ),
    DEADLINE_MARGIN,
  );

const isFinal = (job: JobQueue.Job, cause: Cause.Cause<unknown>) => {
  const error = Cause.findErrorOption(cause);
  const notRetryable =
    Option.isSome(error) &&
    typeof error.value === "object" &&
    error.value !== null &&
    (error.value as { retryable?: unknown }).retryable === false;
  return notRetryable || job.attempts >= JOB_POLICIES["review.run"].maxAttempts;
};

/** An unrecognised job still exists and belongs to its newer build. */
const knownRunJob = (seq: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const [row] = yield* sql<{
      kind: string;
    }>`SELECT kind FROM jobs WHERE job_seq=${seq}`;
    return row === undefined || JobKind.safeParse(row.kind).success;
  });

export interface HandlerOptions {
  readonly location: StoreLocation;
  readonly repository: string;
  /**
   * A recompose run (`recompose.ts`): stored outputs only, the model only where `allow` says.
   * With nothing allowed, the run gets no model, no client and no credential at all.
   */
  readonly recompose?: RecomposePolicy | undefined;
  /**
   * Where the route's requests go, for a test against a local endpoint; unset, the route's own
   * host. The credential is still the route's own.
   */
  readonly fetch?: typeof globalThis.fetch | undefined;
}

export const reviewRunHandler =
  (options: HandlerOptions): Worker.JobHandler =>
  (job) =>
    Effect.gen(function* () {
      yield* (yield* Worker.HandlerLifetime).retain;
      const { location, repository } = options;
      if (job.eventId === null)
        return yield* new NotAReviewRequest({
          message: "a review.run job is enqueued only by review.requested@1",
          retryable: false,
        });
      const stored = yield* Log.get(job.eventId);
      const event = Option.getOrUndefined(stored)?.event;
      if (event === undefined || event.kind !== "review.requested@1")
        return yield* new NotAReviewRequest({
          message: `job ${job.seq}'s event ${job.eventId} is not a review.requested@1`,
          retryable: false,
        });
      const compatibilityProblem = currentPipelineProblem(
        event.payload.pipeline.version,
        event.payload.pipeline.config,
      );
      if (compatibilityProblem !== undefined)
        return yield* new UnsupportedReviewPipeline({
          message: compatibilityProblem,
          retryable: false,
        });
      // This claim of the job (host.ts `QueueClaim`): a held job comes back with its attempt
      // uncounted and a new claim time, so its resume nonce differs from the claim that held.
      if (job.startedAt === null)
        return yield* new ClaimUnstamped({
          message: `job ${job.seq} reached its handler without a claim time; its resume identity would not be stable`,
          retryable: false,
        });
      const claim: QueueClaim = {
        jobSeq: job.seq,
        attempt: job.attempts,
        claimedAt: job.startedAt,
      };
      const runId = event.id;
      const { range, cycleId } = event.attribution;
      // A follow-on runs unheld: the test hold is a first run's only (`runConfig`).
      const config = runConfig(
        readData(PipelineConfig, event.payload.pipeline.config),
        event.payload.generation,
      );
      const ownership = yield* Effect.acquireRelease(
        Effect.try({
          try: () => SourceOwnership.acquire(runFolder(location, runId)),
          catch: (error) => error,
        }),
        (owner) => Effect.sync(() => owner.release()),
      );
      const settings = readSettings();
      const resolvedMode = telemetryMode(settings);
      // Recomposing keeps the switch's meaning, but never exports to a collector.
      const mode =
        options.recompose !== undefined && resolvedMode === "otlp"
          ? "logs"
          : resolvedMode;
      const log = openRunLog(location, runId, mode !== "off");
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => log.flush?.() ?? Promise.resolve()),
      );
      const endSetup = startLogSpan(log, "harness.run.setup");
      const measurementBoundary = beginNativeMeasurements(
        log,
        captureFolder(location, runId),
        claim,
      );
      const earlier = log
        .read()
        .filter((record) => record.type === "run.started");
      // The run's clock starts when its first attempt starts work (10.15: "from Precompute to
      // disposition"; queue wait is reported, not counted). It is stored once in the computation
      // store, keyed by the run, so a later attempt or a crash reads the same start. This is the one
      // computation keyed by a run ID: the value belongs to this run alone, never to reuse.
      // A claim reads a stored start here, and stores its own only once the open has admitted the
      // review task, which then runs Precompute (`anchorClock`, inside the open's acquire): a claim
      // released before the open, by a stopping worker or a hold, leaves no clock, so the next
      // claim gets the run's full time.
      // Not covered: a run that did work, lost its worker for long (a stopped worker, a sleeping
      // laptop) and is claimed again still reads its first start; it ends timed out with a
      // receipt, and the next request continues it as a new generation. Nor a crash in the instant
      // between the admission and the store: the next claim then starts a fresh clock while the
      // review task it continues keeps the cut-off it was created with.
      const store = yield* Computations.ComputationStore;
      const now = yield* Clock.currentTimeMillis;
      const clockSpec = {
        op: "review.run.started",
        opVersion: 1,
        inputs: { runId },
      };
      const storedClock = (startedAt: number) =>
        store.run(
          clockSpec,
          Effect.succeed({
            bytes: new TextEncoder().encode(JSON.stringify({ startedAt })),
            mediaType: "application/json",
          }),
        );
      const startedAt = Option.isNone(
        yield* store.lookup(Computations.computationKey(clockSpec).key),
      )
        ? now
        : (
            JSON.parse(
              new TextDecoder().decode((yield* storedClock(now)).output),
            ) as { startedAt: number }
          ).startedAt;
      // Store-once: a start already stored stays, so a crash or retry after work began keeps it.
      const anchorClock = storedClock(startedAt);
      // What this machine has for the run's search tools (10.89); read per run, never keyed.
      const search = searchRuntimeFrom(settings, location.directory);
      setSearchRuntime(search);
      const runLogStartedAt = yield* Clock.currentTimeMillis;
      log.write({
        type: "run.started",
        runId,
        runKey: event.payload.runKey,
        generation: event.payload.generation,
        jobSeq: job.seq,
        enqueuedAt: job.enqueuedAt,
        claimedAt: job.startedAt,
        queueWaitMs: Math.max(0, runLogStartedAt - Date.parse(job.enqueuedAt)),
        claimToRunStartMs: Math.max(
          0,
          runLogStartedAt - Date.parse(job.startedAt),
        ),
        // The run's own attempt: a stopped worker puts the job back uncounted, so the queue's
        // attempt number repeats on resume; the run log counts every start (`jobAttempt` is the queue's).
        attempt: earlier.length + 1,
        jobAttempt: job.attempts,
        pid: process.pid,
        range,
        resumed: earlier.length > 0,
        telemetry: mode,
        otlp: Option.getOrElse(otlpTarget(settings, mode), () => "off"),
        search: {
          graph: search.graph === undefined ? null : search.graph.executable,
          e0: search.e0 === undefined ? null : search.e0.vectorStore,
          frozen: search.frozen.size,
          problems: search.problems,
        },
      });
      yield* Effect.logInfo(
        `run ${runId} attempt ${job.attempts}: ${range.baseRef} ${range.baseOid.slice(0, 12)}..${range.headOid.slice(0, 12)}${earlier.length > 0 ? ` (resuming; first started ${earlier[0]?.at})` : ""}`,
      );
      yield* sweepEndedRuns(location, runId).pipe(
        Effect.provide(JobQueue.layer),
      );
      yield* ensureRunFolder(location, {
        runId,
        runKey: event.payload.runKey,
        pipelineVersion: event.payload.pipeline.version,
        range,
        jobSeq: job.seq,
      });

      const deadline = attemptStop(config);
      const finalAt = (retryable: boolean) =>
        !retryable || job.attempts >= JOB_POLICIES["review.run"].maxAttempts;
      // The receipt of this claim's ended close, and why the folder must stay when a close failed.
      let ended: CloseReceipt | undefined;
      let keep: string | undefined;

      const registry: Metric.MetricRegistry = new Map();
      const attempt = Effect.gen(function* () {
        const records = yield* Effect.context<Worker.JobServices>();
        // The attempt's tracer, metrics and run span, for the call slots' waits pi's requests make.
        const telemetry = yield* Effect.context<never>();
        const context = RunContext.of({
          location,
          repository,
          runId,
          runKey: event.payload.runKey,
          range,
          cycleId,
          config,
          log,
          startedAt,
          reconciliationId: `review-cycle:${cycleId}`,
          records,
          recompose: options.recompose,
        });
        // One MCP connection per server for the claim, closed when it ends (10.51). A recompose
        // reaches no integration server.
        const integrations: Integrations =
          options.recompose === undefined
            ? readIntegrations()
            : { status: "absent", path: "(a recompose reads no integrations)" };
        const clients = Context.get(
          yield* Layer.build(mcpClientsLayer(integrations)),
          McpClients,
        );

        /**
         * Closes the claim's harness once. Only an ended run gets `run.end`, captured before the
         * close so the export holds it; capture's hook ends the journal's session in every mode. A
         * failed close or export is disclosed and keeps the run folder; a capture that failed is a
         * run failure (10.148), after the harness has closed.
         */
        let cleanupStarted = false;
        const close = (
          opened: OpenedAttempt,
          mode: CloseMode,
          end?: StageStatus,
          stopCause?: StopCause,
        ) =>
          Effect.gen(function* () {
            if (cleanupStarted) return;
            using closeSpan = scopedLogSpan(log, "harness.close.handler", {
              "harness.mode": mode,
            });
            cleanupStarted = true;
            let runEndError: unknown;
            let result = yield* Effect.result(
              Effect.tryPromise({
                try: () =>
                  withCompatibilityRun(log, location.database, () =>
                    opened.host.cleanup(
                      {
                        mode,
                        stop: stopCause !== undefined,
                        ...(stopCause === undefined ? {} : { stopCause }),
                        withinMs: Duration.toMillis(DEADLINE_MARGIN),
                        beforeClose: (actualMode) => {
                          if (actualMode !== "ended" || end === undefined)
                            return;
                          try {
                            opened.journal.capture({
                              type: "run.end",
                              scope: { runId },
                              status: end,
                            });
                          } catch (error) {
                            runEndError = error;
                          }
                        },
                      },
                      BACKGROUND_CONTEXT,
                    ),
                  ),
                catch: (error) => error,
              }),
            );
            if (
              result._tag === "Success" &&
              result.success.kind === "pending"
            ) {
              const pending = result.success;
              log.write({
                type: "run.cleanup-pending",
                mode,
                phase: pending.phase,
                error: `the cleanup deadline elapsed while ${pending.phase}; awaiting terminal close with native source retained`,
              });
              result = yield* Effect.result(
                Effect.tryPromise({
                  try: () => pending.settled,
                  catch: (error) => error,
                }),
              );
            }
            if (result._tag === "Failure") {
              const record = closeFailureRecord(result.failure, mode);
              keep = record.error;
              log.write(record);
            } else if (result.success.kind === "closed") {
              const { receipt, mode: actualMode } = result.success;
              const { capture, snapshotId, complete, gaps, execution, backup } =
                receipt;
              log.write({
                type: "run.snapshot",
                ...(receipt.pendingScan === true ? { pendingScan: true } : {}),
                mode: actualMode,
                capture,
                snapshotId,
                complete,
                gaps,
                execution,
                backup: backup.status,
              });
              if (actualMode === "ended") ended = receipt;
              else if (mode === "ended")
                keep = `the requested ended close settled as ${actualMode}; native source retained`;
            }
            if (runEndError !== undefined)
              return yield* Effect.fail(runEndError);
          }).pipe(Effect.uninterruptible);

        const budget = yield* jobBudget;
        const opened = yield* Effect.acquireRelease(
          Effect.tryPromise({
            try: () =>
              withCompatibilityRun(log, location.database, () =>
                openAttempt({
                  budget,
                  ctx: context,
                  generation: event.payload.generation,
                  ownership,
                  claim,
                  integrations,
                  clients,
                  fetch: options.fetch,
                  runSlot: (effect, signal) =>
                    Effect.runPromiseWith(telemetry)(
                      effect,
                      signal === undefined ? undefined : { signal },
                    ),
                }),
              ),
            catch: (error) => {
              if (error instanceof HostOpenFailed)
                keep = `the harness did not close after a failed open: ${publicCloseReason(error)}`;
              if (
                error instanceof AccountNeedsNewerBuild ||
                error instanceof AccountStoreRefused
              )
                return new JobHeld({ message: error.message, hold: true });
              if (
                config.route.provider === "claude" &&
                error instanceof RuntimeUnavailable
              )
                return new JobHeld({
                  message: claudeUnavailableReason(error.account, error.reason),
                  hold: true,
                });
              return error;
            },
          }).pipe(
            Effect.withSpan("harness.pi.open"),
            // The clock is stored inside the acquire, which runs uninterruptibly: a stop during the
            // open lets it admit the review task, so the task's cut-off and the stored start are one
            // value. A failed store closes the opened host, as its release would.
            Effect.tap((opened) =>
              anchorClock.pipe(
                Effect.catchCause((cause) =>
                  close(opened, "interrupted").pipe(
                    Effect.ignore,
                    Effect.andThen(Effect.failCause(cause)),
                  ),
                ),
              ),
            ),
          ),
          // An interrupted claim (a drop, a stopping worker) closes without aborting anything, so a
          // later claim resumes it; a close already made is joined.
          (opened) => close(opened, "interrupted").pipe(Effect.ignore),
        );
        log.write({
          type: "run.admitted",
          taskId: opened.host.admission.taskId,
          admitted: opened.host.admission.admitted,
          resume: opened.host.resume,
          claim: claimNonce(claim),
        });

        const end = yield* Effect.promise(() =>
          withCompatibilityRun(log, location.database, () =>
            opened.host.ended(BACKGROUND_CONTEXT),
          ),
        ).pipe(
          Effect.timeoutOrElse({
            duration: Duration.millis(
              Math.max(
                0,
                now +
                  Duration.toMillis(deadline) -
                  (yield* Clock.currentTimeMillis),
              ),
            ),
            orElse: () => Effect.succeed({ kind: "deadline" } as const),
          }),
        );
        if (end.kind === "deadline") {
          log.write({
            type: "cutoff",
            point: "handler-stop",
            at: new Date(now + Duration.toMillis(deadline)).toISOString(),
            observedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
            cutoffAt: new Date(cutoffAt(context)).toISOString(),
          });
          const final = finalAt(true);
          yield* close(
            opened,
            final ? "ended" : "interrupted",
            final ? "aborted" : undefined,
            final ? "deadline" : undefined,
          );
          return yield* new RunDeadlineExceeded({
            message: `the attempt reached ${Duration.format(deadline)} of the job's deadline`,
          });
        }
        if (end.kind === "held") {
          log.write({
            type: "run.held",
            claim: claimNonce(claim),
            steps: end.steps.map((step) => ({
              taskId: step.taskId,
              conversationId: step.conversationId,
              failedSubmissionId: step.failedSubmissionId,
              failure: step.failure,
            })),
          });
          const detail = end.steps
            .map((step) => step.detail ?? step.reason)
            .join("; ");
          const corrupt = end.steps
            .map(contractHoldCorruption)
            .find((error) => error !== undefined);
          if (corrupt !== undefined) {
            yield* close(opened, "ended", "failed", "held-failure");
            return yield* new RunFailed({
              stageError: corrupt._tag,
              retryable: false,
              message: corrupt.message,
            });
          }
          if (end.steps.some(contractHoldNeedsNewerBuild)) {
            yield* close(opened, "held");
            return yield* new JobHeld({
              message: "This hold is not understood; leave it to a newer build",
              hold: true,
            });
          }
          // Even explicit provider holds must distinguish a refused account from an absent one.
          for (const step of end.steps) {
            if (step.engine !== "contract") continue;
            const result = yield* (yield* Effect.promise(processRuntimes))
              .capabilities(step.account)
              .pipe(Effect.result);
            if (
              result._tag === "Failure" &&
              accountReadRefused(result.failure)
            ) {
              yield* close(opened, "held");
              return yield* new JobHeld({
                message: result.failure.message,
                hold: true,
              });
            }
          }
          if (end.steps.some(contractHoldRecoversWhenReadable)) {
            yield* close(opened, "held");
            return yield* new JobHeld({
              message: "The job waits for the next claim.",
              hold: true,
            });
          }
          // One read of the credential decides (10.17): a run whose route lost it is held by the
          // worker (`JobHeld`), never recorded as failed. A recompose reads no credential.
          const explicitProviderHold = end.steps.some(
            (step) =>
              step.engine === "contract" &&
              step.recovery.kind === "explicit-account" &&
              ((step.failure._tag === "TurnFailed" &&
                (step.failure.reason === "provider-failed" ||
                  step.failure.reason === "provider-unavailable")) ||
                (step.failure._tag === "RuntimeUnavailable" &&
                  step.failure.reason === "start-failed")),
          );
          if (explicitProviderHold) {
            const read = yield* processReadinessStatuses().pipe(
              Effect.flatMap(({ service }) => service.read),
              Effect.result,
            );
            if (read._tag === "Failure") {
              yield* close(opened, "held");
              return yield* new JobHeld({
                message: "Neuve could not read account status.",
                hold: true,
              });
            }
            for (const status of read.success) {
              if (
                !end.steps.some(
                  (step) =>
                    step.engine === "contract" && step.account === status.name,
                )
              )
                continue;
              const newerBuild = statusNeedsNewerBuild(status);
              if (newerBuild !== undefined) {
                yield* close(opened, "held");
                return yield* new JobHeld({
                  message: newerBuild.message,
                  hold: true,
                });
              }
            }
          }
          if (options.recompose === undefined && !explicitProviderHold) {
            const readiness = yield* routeReadiness(
              config.route,
              yield* Effect.promise(processRuntimes),
              processReadinessStatuses(),
            );
            if (!readiness.ready) {
              yield* close(opened, "held");
              return yield* new JobHeld({
                message:
                  config.route.provider === "claude"
                    ? readiness.credential
                    : `${credentialName(config.route)} became unavailable during the run; the job waits for a worker that has it`,
                hold: true,
              });
            }
          }
          // The provider refused a credential this worker has, or failed after pi's own retries:
          // the kind it recorded on the failed turn decides, by the incumbent policy.
          const failure = heldFailure(end.steps);
          const final = finalAt(failure.retryable);
          if (failure.unclassified !== undefined)
            log.write({
              type: "gap",
              stage: "run",
              kind: "route-failure-unclassified",
              detail: failure.unclassified,
              cause: detail.slice(0, 500),
            });
          yield* close(
            opened,
            final ? "ended" : "interrupted",
            final ? "failed" : undefined,
            final ? "held-failure" : undefined,
          );
          return yield* new RunFailed({
            stageError: failure.tag,
            retryable: failure.retryable,
            message: `${failure.tag}: ${detail.slice(0, 500)}`,
          });
        }
        const outcome = end.task.state.outcome;
        if (outcome.status === "completed") {
          const stages = outcome.result.stages;
          yield* close(
            opened,
            "ended",
            stages.some((stage) => stage.status === "interrupted")
              ? "cutoff"
              : "completed",
          );
          return { stages } satisfies PipelineResult;
        }
        const failure = stageFailure(outcome);
        const final = finalAt(failure.retryable);
        yield* close(
          opened,
          final ? "ended" : "interrupted",
          final ? "failed" : undefined,
        );
        return yield* new RunFailed(failure);
      }).pipe(
        withGitReadSnapshot(repository, INDEX_BOUNDS.maxFileBytes),
        Effect.scoped,
        Effect.withSpan("harness.run", {
          attributes: {
            "harness.run_id": runId,
            "harness.attempt": job.attempts,
            "harness.range.base_oid": range.baseOid,
            "harness.range.head_oid": range.headOid,
            "harness.calls_in_flight": config.budgets.callsInFlight,
          },
        }),
        // The attempt's own metric registry: its `metric` records, and OTLP's when configured.
        withAttemptMetrics(log, registry),
        Effect.provide(tracerLayer(log, settings, registry, mode)),
        Effect.ensuring(
          Effect.sync(() => {
            using measurementSpan = scopedLogSpan(
              log,
              "harness.measurements.native",
              {},
            );
            writeNativeMeasurements(
              log,
              captureFolder(location, runId),
              config.route.effort,
              measurementBoundary,
            );
          }),
        ),
      );

      /**
       * An ended run's folder goes only after its close exported the native state and closed the
       * database: the removal takes that close's receipt and does not reopen `pi.sqlite`. A failed
       * close keeps it; a run this claim never closed as ended (a claim that failed before opening,
       * a folder from an earlier pipeline) falls back to capture's own reopening capture.
       */
      const endedRunCleanup = () =>
        Effect.gen(function* () {
          if (keep !== undefined)
            return { removed: false, captures: [] as ReadonlyArray<string> };
          const removed = yield* removeRunFolder(location, runId, {
            receipt: ended,
            ownership,
          });
          return { removed: removed.removed, captures: removed.captures };
        });

      endSetup();
      const result = yield* attempt.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.gen(function* () {
                const error = Cause.findErrorOption(cause);
                const held =
                  Option.isSome(error) && error.value instanceof JobHeld;
                const final = !held && isFinal(job, cause);
                log.write({
                  type: "run.attempt-failed",
                  attempt: earlier.length + 1,
                  jobAttempt: job.attempts,
                  final,
                  ...(held ? { held: true } : {}),
                  error: Cause.pretty(cause).split("\n")[0]?.slice(0, 500),
                });
                if (final) {
                  const removed = yield* endedRunCleanup().pipe(
                    Effect.orElseSucceed(() => ({
                      removed: false,
                      captures: [] as ReadonlyArray<string>,
                    })),
                  );
                  log.write({
                    type: "run.failed",
                    attempt: job.attempts,
                    runFolderRemoved: removed.removed,
                    captures: removed.captures,
                    ...(keep === undefined ? {} : { kept: keep }),
                  });
                  yield* Effect.logWarning(
                    `run ${runId}: final failure; run folder ${removed.removed ? "deleted" : keep === undefined ? "already gone or not captured" : "kept"} after filing ${removed.captures.length} capture(s)`,
                  );
                }
                return yield* Effect.failCause(cause);
              }),
        ),
      );

      // Publish's last steps (proposal §10.2): the receipt, then the cleanup, which deletes the run
      // folder only after the harness closed and exported its state.
      const endFinalize = startLogSpan(log, "harness.run.finalize");
      const receipt = buildReceipt({
        runId,
        runKey: event.payload.runKey,
        generation: event.payload.generation,
        jobSeq: job.seq,
        range,
        cycleId,
        config,
        enqueuedAt: job.enqueuedAt,
        startedAt,
        endedAt: yield* Clock.currentTimeMillis,
        stages: result.stages,
        records: log.read(),
      });
      yield* recordReceipt(log, receipt);
      // Only a run that published every stage is the range's review; a timed-out one is retried
      // by the next request as a new generation that reuses every stored stage (10.42).
      if (receipt.outcome === "completed") {
        const store = yield* Computations.ComputationStore;
        const completed: CompletedRun = {
          runId,
          generation: event.payload.generation,
          jobSeq: job.seq,
        };
        yield* store.run(
          runSpec(range, config),
          Effect.succeed({
            bytes: new TextEncoder().encode(JSON.stringify(completed)),
            mediaType: "application/json",
          }),
        );
      }
      const removed = yield* endedRunCleanup();
      endFinalize();
      yield* Effect.promise(() => log.flush?.() ?? Promise.resolve());
      log.write({
        type: "run.completed",
        outcome: receipt.outcome,
        runFolderRemoved: removed.removed,
        captures: removed.captures,
        ...(keep === undefined ? {} : { kept: keep }),
      });
      yield* Effect.logInfo(
        `run ${runId}: ${receipt.outcome}; ${receipt.totals.modelCalls} model call(s), ${receipt.totals.costUsd === null ? "USD unknown" : `$${receipt.totals.costUsd.toFixed(4)}`}; run folder ${removed.removed ? "deleted" : "kept"}`,
      );
      return receipt;
    }).pipe(Effect.scoped);

/** One run folder a sweep removed, and why. */
export interface SweptRun {
  readonly runId: string;
  readonly reason: string;
  readonly captures: ReadonlyArray<string>;
}

/**
 * The run folders a sweep removes now (proposal §1, 8.10): every folder older than 30 days, whatever
 * its run's state, and every folder whose run has no waiting, delayed or active job (the job ended,
 * or no longer exists). A folder is as old as its run ID's timestamp. A folder with no readable
 * manifest names no job, so only its age removes it.
 */
const dueRunFolders = (location: StoreLocation, except?: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const queue = yield* JobQueue.JobQueue;
    const cutoff =
      (yield* Clock.currentTimeMillis) -
      Duration.toMillis(Retention.RAW_CAPTURE_RETENTION);
    const due: Array<{
      readonly runId: string;
      readonly reason: string;
      readonly mask: boolean;
    }> = [];
    const folders = yield* listRunFolders(location).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterrupts(cause)) return Effect.failCause(cause);
        return Effect.as(
          Effect.logWarning(
            `run folder inventory deferred: ${publicCloseReason(Cause.squash(cause))}`,
          ),
          [],
        );
      }),
    );
    for (const folder of folders) {
      const result = yield* Effect.exit(
        Effect.gen(function* () {
          if (folder.runId === except) return;
          // A run folder is named by its run ID, the ULID of its request: its age is the run's. A name
          // that is not a ULID falls back to the folder's modification time, never its creation time,
          // which some file systems leave at the epoch. A folder another sweep removed is not due.
          const minted = Retention.mintedAt(folder.runId);
          const created = Option.isSome(minted)
            ? minted
            : yield* fs.stat(runFolder(location, folder.runId)).pipe(
                Effect.map((info) =>
                  Option.map(info.mtime, (at) => at.getTime()),
                ),
                Effect.catchTag("PlatformError", (error) =>
                  error.reason._tag === "NotFound"
                    ? Effect.succeed(Option.none<number>())
                    : Effect.fail(error),
                ),
              );
          if (Option.isSome(created) && created.value < cutoff) {
            // Past 8.10's bound: masking it now would start a new 30-day capture of old content.
            return {
              runId: folder.runId,
              reason: `older than 30 days (${Option.isSome(minted) ? "requested" : "last modified"} ${new Date(created.value).toISOString()})`,
              mask: false,
            };
          }
          if (folder.compatible || Option.isNone(folder.manifest)) return;
          if (!(yield* knownRunJob(folder.manifest.value.jobSeq))) return;
          const job = yield* queue.inspect(folder.manifest.value.jobSeq);
          // Refusal is not a terminal execution of this native state. Keep the original database
          // for a compatible build, even after the worker serializes the nonretryable failure.
          // Explicit drop and the age bound above remain authoritative.
          if (
            Option.isSome(job) &&
            job.value.state === "failed" &&
            job.value.lastError?.tag === "UnsupportedReviewPipeline"
          )
            return;
          if (
            Option.isSome(job) &&
            job.value.state !== "failed" &&
            job.value.state !== "completed"
          )
            return;
          return {
            runId: folder.runId,
            reason: Option.isSome(job)
              ? `job ${job.value.seq} is ${job.value.state}${job.value.lastError === null ? "" : ` (${job.value.lastError.tag})`}`
              : `job ${folder.manifest.value.jobSeq} no longer exists`,
            mask: true,
          };
        }),
      );
      if (result._tag === "Failure") {
        if (Cause.hasInterrupts(result.cause))
          return yield* Effect.failCause(result.cause);
        yield* Effect.logWarning(
          `run ${folder.runId}: cleanup deferred: ${publicCloseReason(Cause.squash(result.cause))}`,
        );
      } else if (result.value !== undefined) due.push(result.value);
    }
    return due;
  });

/**
 * Removes the due run folders (`dueRunFolders`), filing the working copies of ended runs as raw
 * captures first (10.14), as a final failure does. It runs when a worker with the review handler has
 * recovered stalled jobs, before each run, and in the daily `retention.prune` (`runFolderSweep`).
 * Two sweeps can meet the same folder (a review starting while the prune runs); a folder the other
 * removed first is skipped.
 */
export const sweepEndedRuns = (location: StoreLocation, except?: string) =>
  Effect.gen(function* () {
    const swept: Array<SweptRun> = [];
    for (const due of yield* dueRunFolders(location, except)) {
      const remove: Effect.Effect<
        { readonly removed: boolean; readonly captures: ReadonlyArray<string> },
        unknown,
        FileSystem | Blobs.BlobStore | SqlClient
      > = due.mask
        ? removeRunFolder(location, due.runId)
        : Effect.map(
            deleteRunFolder(location, due.runId, undefined, {
              retentionExpired: true,
            }),
            (deleted) => ({
              removed: deleted.removed,
              captures: [],
            }),
          );
      const result = yield* Effect.exit(remove);
      if (result._tag === "Failure") {
        if (Cause.hasInterrupts(result.cause))
          return yield* Effect.failCause(result.cause);
        const error = Cause.squash(result.cause);
        if (!(error instanceof SourceOwned))
          yield* Effect.logWarning(
            `run ${due.runId}: capture cleanup deferred: ${publicCloseReason(error)}`,
          );
        continue;
      }
      const removed = result.value;
      if (!removed.removed) continue;
      openRunLog(location, due.runId).write({
        type: "run.swept",
        reason: due.reason,
        runFolderRemoved: true,
        captures: removed.captures,
      });
      yield* Effect.logInfo(
        `run ${due.runId}: ${due.reason}; run folder deleted${due.mask ? ` after filing ${removed.captures.length} working cop${removed.captures.length === 1 ? "y" : "ies"}` : " without a new capture"}`,
      );
      swept.push({
        runId: due.runId,
        reason: due.reason,
        captures: removed.captures,
      });
    }
    return swept as ReadonlyArray<SweptRun>;
  }).pipe(Effect.provide(JobQueue.layer));

/** The run folders as a sweep of the daily `retention.prune` job (8.10, proposal §1). */
export const runFolderSweep = (
  location: StoreLocation,
): Retention.RetentionSweep => ({
  name: "run folders",
  wanted: Effect.map(dueRunFolders(location), (due) => due.length > 0).pipe(
    Effect.provide(JobQueue.layer),
  ),
  sweep: Effect.map(sweepEndedRuns(location), (swept) =>
    swept.map(
      (run) =>
        `removed ${runFolder(location, run.runId)} (${run.reason}; ${run.captures.length} working cop${run.captures.length === 1 ? "y" : "ies"} filed as raw captures)`,
    ),
  ),
});

/**
 * What a starting worker does once it holds the claim and has recovered stalled jobs (the worker's
 * `afterRecovery`): it clears the previous holder's held-review record (10.17), so a worker that
 * lost the claim never overwrites the holder's, and sweeps the folders of runs whose job ended
 * without its handler (stall-limit failures).
 */
export const onClaim = (location: StoreLocation) =>
  Effect.gen(function* () {
    writeHeldReviews(location, []);
    return yield* sweepEndedRuns(location);
  });

/**
 * Drops an active job (`neuve jobs drop` on a running review): asks the worker over its socket to
 * abort the attempt, which then ends failed with cause Dropped, never retried; waits for that, up to
 * `wait`; then, for a review, deletes its run folder as a dropped waiting job's is (10.14). A packet
 * Publish already appended stays, and an attempt aborted before Publish leaves none. A drop that
 * lands mid-Publish, after some batches were appended and before `packet.published@1`, leaves those
 * batches without a packet: a gap for the dropped run says so, and its cause names them (`interruptedPublish`). When the
 * job has not left active within `wait`, the drop stands requested and the attempt is still ending
 * (`pending`).
 */
export const dropActiveJob = (
  location: StoreLocation,
  seq: number,
  wait: Duration.Input = "15 seconds",
) =>
  Effect.gen(function* () {
    const { reach } = yield* Worker.reachStoreWorker(location, `drop ${seq}`);
    if (reach._tag !== "Answered" || reach.reply !== "dropping")
      return {
        dropped: false as const,
        reason:
          reach._tag === "Answered"
            ? `the worker answered "${reach.reply}"`
            : "no worker answered on its socket",
      };
    const queue = yield* JobQueue.JobQueue;
    const until =
      (yield* Clock.currentTimeMillis) +
      Duration.toMillis(Duration.fromInputUnsafe(wait));
    while (true) {
      const job = Option.getOrUndefined(yield* queue.inspect(seq));
      if (job !== undefined && job.state !== "active") {
        const abandoned = yield* abandonDroppedRun(location, job);
        const interrupted = yield* interruptedPublish(location, job);
        return { dropped: true as const, job, abandoned, interrupted };
      }
      if ((yield* Clock.currentTimeMillis) >= until)
        return {
          dropped: false as const,
          pending: true as const,
          reason: `the drop was requested and job ${seq}'s attempt is still ending after ${Duration.format(Duration.fromInputUnsafe(wait))}; it ends dropped when its handler stops, and \`neuve jobs\` shows it then`,
        };
      yield* Effect.sleep("100 millis");
    }
  });

/**
 * A dropped review whose Publish had begun: the batches this run appended (since its first start,
 * under its run key in its cycle) while no `packet.published@1` of this run exists, and the
 * batches the new publisher (`publish-sections.ts`) appended for this run that no packet of its
 * sequence names. Each is named in one gap for the dropped run, so a partial packet is never
 * silent (2.5); none, nothing. A new-publisher chain that cannot be read never fails the drop: the
 * job is already dropped and its run folder gone, so the gap is still written, with today's
 * batches, and its run-log cause says the chain could not be read.
 */
const UNREADABLE_CHAIN = "the new publisher's chain could not be read";

const interruptedPublish = (location: StoreLocation, job: JobQueue.Job) =>
  Effect.gen(function* () {
    if (!isReviewRun(job.kind) || job.eventId === null) return [];
    const request = Option.getOrUndefined(yield* Log.get(job.eventId))?.event;
    if (request?.kind !== "review.requested@1") return [];
    const runId = job.eventId;
    const { cycleId, range } = request.attribution;
    const namespace = `review:${cycleId}:${request.payload.runKey}:`;
    const sql = yield* SqlClient;
    const [packet] = yield* sql<{ id: string }>`SELECT id FROM events
      WHERE idempotency_key = ${`${namespace}packet:${runId}`}`;
    // The new publisher keys packets by their content, not the run: it names the batches this run
    // appended that no packet of the sequence holds. Any failure or defect reading its chain
    // (damaged bytes, a missing blob, a corrupt record, a store error) leaves it unknown, never
    // the drop failed; only an interruption passes through.
    const settled = yield* unpublishedBatches({
      cycleId,
      runKey: request.payload.runKey,
      runId,
    }).pipe(
      Effect.provide(
        Computations.layer.pipe(Layer.provideMerge(Blobs.layer(location))),
      ),
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.interrupt
          : Effect.succeed(undefined),
      ),
    );
    const unreadable = settled === undefined;
    const log = openRunLog(location, runId);
    const since = log.read().find((r) => r.type === "run.started")?.at;
    const batches =
      packet !== undefined || since === undefined
        ? []
        : yield* sql<{
            id: string;
            key: string;
          }>`SELECT id, idempotency_key AS key
      FROM events WHERE kind = 'batch.recorded@1' AND recorded_at >= ${since}
        AND idempotency_key >= ${`${namespace}batch:`}
        AND idempotency_key < ${`${namespace}batch:\u{10FFFF}`}
      ORDER BY seq`;
    if (batches.length === 0 && (settled ?? []).length === 0 && !unreadable)
      return [];
    const named = [
      ...batches.map((b) => {
        const local = b.key.slice(`${namespace}batch:`.length).split("#")[0]!;
        return `${local} (${b.id})`;
      }),
      ...(settled ?? []).map((b) => `${b.batch} (${b.eventId})`),
    ];
    const detail =
      named.length === 0
        ? "Publishing may have stopped partway; which batches were saved could not be read."
        : `Publishing stopped partway: ${named.length} batch(es) were saved, but no published review includes them.`;
    // Which batches, by handle and event ID, and whether the new chain was unreadable (a closed
    // label, never the error's message): for the run log, not the reader.
    const cause = [...(unreadable ? [UNREADABLE_CHAIN] : []), named.join(", ")]
      .filter((part) => part !== "")
      .join("; ")
      .slice(0, 2_000);
    const occurredAt = new Date(yield* Clock.currentTimeMillis).toISOString();
    const session = `review:${cycleId}:${request.payload.runKey}`;
    yield* Log.append([
      harnessRegistration(session, "publish", occurredAt),
      {
        id: mintUlid(),
        kind: "gap.disclosed@1",
        idempotencyKey: `review:${runId}:gap:publish:dropped-mid-publish`,
        actor: harnessActor(session, "publish"),
        occurredAt,
        attribution: { cycleId, range, runId, stage: "publish" },
        payload: { kind: "publish-interrupted", detail },
      },
    ]);
    log.write({
      type: "gap",
      stage: "publish",
      agent: "publish",
      kind: "publish-interrupted",
      detail,
      cause,
    });
    return named;
  });

/** Records that a dropped review job abandoned its run, and deletes its folder (proposal §1). */
export const abandonDroppedRun = (location: StoreLocation, job: JobQueue.Job) =>
  Effect.gen(function* () {
    if (!isReviewRun(job.kind) || job.eventId === null)
      return { removed: false };
    const removed = yield* deleteRunFolder(location, job.eventId);
    openRunLog(location, job.eventId).write({
      type: "run.abandoned",
      reason: `job ${job.seq} dropped`,
      runFolderRemoved: removed.removed,
    });
    return {
      removed: removed.removed,
      folder: runFolder(location, job.eventId),
    };
  });

const writeHeldReviews = (
  location: StoreLocation,
  entries: ReadonlyArray<HeldReview>,
) => {
  const path = heldReviewsPath(location);
  if (existsSync(path)) {
    try {
      const held = safeRead(
        z.array(HeldReview),
        JSON.parse(readFileSync(path, "utf8")),
      );
      if (!held.success || held.droppedKeys.length > 0) return;
    } catch {
      return;
    }
  }
  mkdirSync(join(location.directory, "harness"), {
    recursive: true,
    mode: STORE_DIRECTORY_MODE,
  });
  writeFileSync(heldReviewsPath(location), `${JSON.stringify(entries)}\n`, {
    mode: STORE_FILE_MODE,
  });
};

/** The route a review job's request froze, or none when its event cannot be read as one. */
const frozenRoute = (job: JobQueue.Job) =>
  Effect.gen(function* () {
    if (job.eventId === null) return undefined;
    const event = Option.getOrUndefined(yield* Log.get(job.eventId))?.event;
    if (event === undefined || event.kind !== "review.requested@1")
      return undefined;
    const config = safeRead(PipelineConfig, event.payload.pipeline.config);
    return config.success ? config.data.route : undefined;
  });

/**
 * The worker's per-job admission (10.17, 10.85): a review job runs only when this process has the
 * credential of the route its request froze. Otherwise it is held, waiting, and recorded with its
 * reason; a worker that has the credential (a shell with the key, or after `neuve auth login
 * openai`) picks it up. A job whose request cannot be read is admitted, so its handler reports why.
 */
export const admitReview =
  (
    location: StoreLocation,
    runtimes?: import("@neuve/runtime").RuntimeRegistryShape,
    statuses = processReadinessStatuses(),
  ) =>
  (job: JobQueue.Job) =>
    Effect.gen(function* () {
      if (!isReviewRun(job.kind)) return true;
      const route = yield* frozenRoute(job);
      if (route === undefined) return true;
      const { ready, credential } = yield* routeReadiness(
        route,
        runtimes ?? (yield* Effect.promise(processRuntimes)),
        statuses,
      );
      const others = readHeldReviews(location).filter(
        (entry) => entry.pid === process.pid && entry.seq !== job.seq,
      );
      writeHeldReviews(
        location,
        ready
          ? others
          : [
              ...others,
              {
                seq: job.seq,
                pid: process.pid,
                at: new Date().toISOString(),
                provider: route.provider,
                route: `${route.provider}/${route.model}`,
                credential,
              },
            ],
      );
      return ready;
    });

/**
 * The handlers the harness adds to a worker. Both review kinds are always registered: `review.run@2`
 * this build enqueues, and `review.run` builds before 12.24 enqueued. Whether this worker can run a
 * given review job is decided per job by `admitReview`, from the route its request froze.
 */
export const workerHandlers = (
  options: HandlerOptions,
): Partial<Record<JobKind, Worker.JobHandler>> => {
  const handler = reviewRunHandler(options);
  return {
    "review.run": handler,
    "review.run@2": handler,
    "scope.fetch@2": scopeFetchHandler(options),
    // Complete queued trial-era preparation jobs without starting a review.
    "judgement.prepare@1": () => Effect.void,
  };
};

export type { RunLog };
