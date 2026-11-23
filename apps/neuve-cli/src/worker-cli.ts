import { InsideSharedWorkGrant } from "@neuve/records-core/shared-work-effect";
import {
  workerBudget,
  closeWorkerBudget,
} from "../../../packages/harness/src/budget/local.ts";
import { withCodeWork } from "../../../packages/harness/src/code-work.ts";
import {
  captureScanHandler,
  runScanChild,
  captureCheckpointSweep,
  captureStartupRecovery,
  capturePruneHandler,
} from "@neuve/harness/session-dump";
import { closeSync, openSync, writeSync } from "node:fs";
import { stopRunningCommands } from "@neuve/graph-client";

import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  Cause,
  Duration,
  Effect,
  Exit,
  Layer,
  Logger,
  Option,
  References,
} from "effect";
import type { SqlClient } from "effect/sql/SqlClient";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import { z } from "zod";
import { JobKind, JobState } from "@neuve/records-schema";
import {
  Blobs,
  Computations,
  JOB_POLICIES,
  JobQueue,
  Launchd,
  Log,
  Registry,
  Retention,
  Starter,
  Store,
  Sweep,
  Systemd,
  Worker,
  isReviewRun,
  mintUlid,
  resolveStoreLocation,
  storeLocationIn,
  type StoreLocation,
} from "@neuve/records-core";
import {
  CommitHybrid as HarnessCommitHybrid,
  CommitPrepare as HarnessCommitPrepare,
  GraphDeclare as HarnessGraphDeclare,
  GraphSearch as HarnessGraphSearch,
  Handler as HarnessHandler,
  HeavyChild,
  HybridModels as HarnessHybridModels,
  Relations as HarnessRelations,
  Scope as HarnessScope,
  Stack as HarnessStack,
} from "@neuve/harness";
import * as HarnessRuntimes from "@neuve/harness/runtimes";
import { heldForAccount, readHeldReviews } from "@neuve/harness/held-reviews";
import { argumentRefusal, execute, withStore, write } from "./records-cli.ts";
import { thisBuild } from "./review-worker.ts";
import { prepareWorkerStore, warnIfPaused } from "./installed-copy.ts";
import { runStackFetchChild, runStackIndexChild } from "./stack-cli.ts";
import { CLI_VERSION } from "./cli-version.ts";

export const WORKER_HELP = `Usage:
  neuve worker run [--repo <path> | --store <Records dir>] [--idle-seconds <n>]
              Run the repository's worker in the foreground. Exits at once when another worker
              holds the socket, and after <n> seconds (default 60) with no jobs.
  neuve worker start [--repo <path> | --store <Records dir>]
              Wake the running worker, or spawn one in the background (output in worker.log).
  neuve worker status [--json] [--repo <path> | --store <Records dir>]
              Show whether a worker holds the socket, its PID, each slot's job and last progress.
  neuve worker stop [--repo <path> | --store <Records dir>]
              Ask the worker to stop; an active job goes back to waiting.
  neuve worker recover [--repo <path> | --store <Records dir>]
              Release an older worker's claim only with exclusive Records access. Refuses while
              a worker or another Records connection is live. Close other Neuve commands first.
  neuve worker sweep
              Start workers for registered repositories with spooled events, queued jobs or raw
              captures due for pruning.
  neuve worker install-agent [--no-load]
              Set up ${Launchd.AGENT_LABEL}, which starts background workers at login and every
              5 minutes: a launchd agent on macOS, a systemd user timer on Linux.
              --no-load writes its files without loading them.
  neuve worker uninstall-agent [--no-load]
              Unload and remove that launchd agent or systemd timer.`;

export const JOBS_HELP = `Usage:
  neuve jobs [list] [--all | --state <state>...] [--limit <n>] [--json] [--repo <path>]
              List jobs: by default waiting, delayed and active, with ID, kind, the worker slot
              that runs it and its priority there (1 runs first), state, attempts, stalls and how
              long each has run or waited.
  neuve jobs inspect <id> [--json] [--repo <path>]
              Show one job with its payload, timestamps and last error cause.
  neuve jobs drop <id> [--json] [--repo <path>]
              End a waiting or delayed job as failed with cause Dropped. Active jobs are refused.
  neuve jobs enqueue <kind> [payload-json] [--key <dedupe-key>] [--no-start] [--json] [--repo <path>]
              Enqueue a job and start the worker. A second enqueue with the same key returns the
              existing job. Kinds: ${JobKind.options.join(", ")}.

States: ${JobState.options.join(", ")}.`;

const JobId = z.coerce.number().int().min(1);
const jobId = (value: string | undefined) => {
  const parsed = JobId.safeParse(value);
  if (!parsed.success)
    throw new Error(argumentRefusal("Job ID", "a positive integer", value));
  return parsed.data;
};

/** Runs a queue program against the repository's store; `create` makes a missing store. */
const withQueue = <A, E>(
  repository: string,
  mode: "read" | "write" | "create",
  program: Effect.Effect<A, E, JobQueue.JobQueue | SqlClient>,
) => withStore(repository, mode, Effect.provide(program, JobQueue.layer));

const span = (from: string | null, to: number) => {
  if (from === null) return "-";
  const seconds = Math.max(0, Math.round((to - Date.parse(from)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60)
    return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
};

/** Runtime for an active job, queue time for a waiting one, time to its retry for a delayed one. */
const timing = (job: JobQueue.Job, now: number) => {
  switch (job.state) {
    case "active":
      return `running ${span(job.startedAt, now)}`;
    case "waiting":
      return `queued ${span(job.enqueuedAt, now)}`;
    case "delayed":
      return job.runAt !== null && Date.parse(job.runAt) > now
        ? `retry in ${span(new Date(now).toISOString(), Date.parse(job.runAt))}`
        : "retry due";
    case "completed":
    case "failed":
      return `ended ${span(job.finishedAt, now)} ago`;
  }
};

const formatJobs = (
  jobs: ReadonlyArray<JobQueue.Job>,
  notes: ReadonlyMap<number, string> = new Map(),
) => {
  if (jobs.length === 0) return "No jobs.";
  const now = Date.now();
  const rows = jobs.map((job) => [
    String(job.seq),
    job.kind,
    JOB_POLICIES[job.kind].slot,
    String(JOB_POLICIES[job.kind].priority),
    job.state,
    `${job.attempts}/${JOB_POLICIES[job.kind].maxAttempts}`,
    String(job.stalls),
    timing(job, now),
    job.lastError === null
      ? ""
      : `${job.lastError.tag}: ${job.lastError.message}`,
    notes.get(job.seq) ?? "",
  ]);
  const header = [
    "ID",
    "KIND",
    "SLOT",
    "PRIORITY",
    "STATE",
    "ATTEMPTS",
    "STALLS",
    "TIME",
    "LAST ERROR",
    "NOTE",
  ];
  const widths = header.map((title, index) =>
    Math.max(title.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  return [header, ...rows]
    .map((row) =>
      row
        .map((cell, index) =>
          index === row.length - 1 ? cell : cell.padEnd(widths[index] ?? 0),
        )
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
};

const formatJob = (job: JobQueue.Job) => {
  const policy = JOB_POLICIES[job.kind];
  const lines = [
    `job ${job.seq}`,
    `kind         ${job.kind}`,
    `slot         ${policy.slot}, priority ${policy.priority} (1 runs first), ${policy.order} first within the kind`,
    `state        ${job.state}`,
    `dedupe key   ${job.dedupeKey}`,
    `event        ${job.eventId ?? "- (enqueued by hand)"}`,
    `attempts     ${job.attempts} of ${policy.maxAttempts}`,
    `stalls       ${job.stalls} (limit ${policy.stallLimit})`,
    `deadline     ${Duration.format(policy.deadline)} per attempt`,
    `enqueued at  ${job.enqueuedAt}`,
    `started at   ${job.startedAt ?? "-"}`,
    `run at       ${job.runAt ?? "-"}`,
    `finished at  ${job.finishedAt ?? "-"}`,
    `payload      ${job.payload === null ? "-" : JSON.stringify(job.payload)}`,
    `last error   ${job.lastError === null ? "-" : JSON.stringify(job.lastError)}`,
  ];
  return lines.join("\n");
};

const describeQueueError = (error: unknown) => {
  if (typeof error === "object" && error !== null && "_tag" in error) {
    const tagged = error as { _tag: string; message?: string; seq?: number };
    if (tagged._tag === "JobNotFound") return `No job ${tagged.seq}.`;
    if (
      tagged._tag === "JobStateConflict" ||
      tagged._tag === "InvalidJobPayload" ||
      tagged._tag === "JobHeldByNewerBuild"
    )
      return tagged.message ?? tagged._tag;
  }
  return undefined;
};

/** Like `execute`, but queue refusals print as plain sentences with exit code 1. */
const executeQueue = async <A>(
  effect: Effect.Effect<A, unknown, never>,
): Promise<A | { readonly refused: string }> => {
  const result = await Effect.runPromise(Effect.result(effect));
  if (result._tag === "Success") return result.success;
  const refused = describeQueueError(result.failure);
  if (refused !== undefined) return { refused };
  return execute(Effect.fail(result.failure));
};

const isRefused = (value: unknown): value is { readonly refused: string } =>
  typeof value === "object" && value !== null && "refused" in value;

/**
 * What `neuve jobs` says about review jobs: the range each one reviews, and why a waiting one waits
 * when the running worker lacks its route's credential (10.17).
 */
const reviewNotes = (repository: string, jobs: ReadonlyArray<JobQueue.Job>) =>
  Effect.gen(function* () {
    const notes = new Map<number, string>();
    const reviews = jobs.filter((job) => isReviewRun(job.kind));
    if (reviews.length === 0) return notes;
    const location = yield* resolveStoreLocation(repository);
    const claim = yield* Worker.readClaim;
    const holder = Option.getOrUndefined(claim)?.pid;
    const heldBy = new Map(
      readHeldReviews(location)
        .filter((entry) => entry.pid === holder)
        .map((entry) => [entry.seq, entry]),
    );
    for (const job of reviews) {
      const stored =
        job.eventId === null ? Option.none() : yield* Log.get(job.eventId);
      const event = Option.getOrUndefined(stored)?.event;
      const range =
        event?.kind === "review.requested@1"
          ? `review ${event.attribution.range.baseRef} ${event.attribution.range.baseOid.slice(0, 10)}..${event.attribution.range.headOid.slice(0, 10)}, run ${event.id}`
          : "";
      notes.set(
        job.seq,
        [
          range,
          job.state === "waiting" && heldBy.has(job.seq)
            ? heldForAccount(heldBy.get(job.seq)!)
              ? `held: worker pid ${holder} holds it for ${heldBy.get(job.seq)!.route}. ${heldBy.get(job.seq)!.credential}`
              : `held: worker pid ${holder} lacks ${heldBy.get(job.seq)!.credential} for ${heldBy.get(job.seq)!.route}; a worker that has it picks the job up`
            : undefined,
        ]
          .filter((part) => part !== undefined && part !== "")
          .join("; "),
      );
    }
    return notes;
  });

export const runJobsCli = async (args: readonly string[]): Promise<number> => {
  const [first, ...others] = args;
  if (first === "--help" || first === "help") {
    await write(JOBS_HELP);
    return 0;
  }
  const subcommand =
    first === undefined || first.startsWith("--") ? "list" : first;
  const rest = subcommand === "list" && first !== "list" ? args : others;
  const { values, positionals } = parseArgs({
    args: [...rest],
    allowPositionals: subcommand !== "list",
    strict: true,
    options: {
      repo: { type: "string" },
      store: { type: "string" },
      capture: { type: "string" },
      work: { type: "string" },
      json: { type: "boolean" },
      all: { type: "boolean" },
      state: { type: "string", multiple: true },
      limit: { type: "string" },
      key: { type: "string" },
      "no-start": { type: "boolean" },
    },
  });
  const repository = resolve(values.repo ?? process.cwd());
  const json = values.json === true;
  await warnIfPaused(repository);
  const refuse = async (refused: { readonly refused: string }) => {
    await Bun.write(Bun.stderr, `neuve: ${refused.refused}\n`);
    return 1;
  };

  switch (subcommand) {
    case "list": {
      const states =
        values.all === true
          ? JobState.options
          : values.state !== undefined
            ? z.array(JobState).parse(values.state)
            : (["waiting", "delayed", "active"] as const);
      const limit = z.coerce
        .number()
        .int()
        .min(1)
        .max(10_000)
        .parse(values.limit ?? 100);
      const { jobs, notes } = await execute(
        withQueue(
          repository,
          "read",
          Effect.gen(function* () {
            const jobs = yield* JobQueue.JobQueue.use((queue) =>
              queue.list({ states, limit }),
            );
            return { jobs, notes: yield* reviewNotes(repository, jobs) };
          }),
        ),
      );
      await write(
        json
          ? JSON.stringify(
              jobs.map((job) => ({
                ...job,
                slot: JOB_POLICIES[job.kind].slot,
                priority: JOB_POLICIES[job.kind].priority,
                ...(notes.has(job.seq) ? { note: notes.get(job.seq) } : {}),
              })),
              null,
              2,
            )
          : formatJobs(jobs, notes),
      );
      return 0;
    }
    case "inspect": {
      const seq = jobId(positionals[0]);
      const job = await execute(
        withQueue(
          repository,
          "read",
          JobQueue.JobQueue.use((queue) => queue.inspect(seq)),
        ),
      );
      if (Option.isNone(job)) {
        const newer = await execute(
          withQueue(repository, "read", JobQueue.newerJob({ seq })),
        );
        return refuse({
          refused: Option.isSome(newer)
            ? `Job ${seq} is ${newer.value.kind} (${newer.value.state}), a kind this build does not know; the newer build that queued it runs and shows it.`
            : `No job ${seq}.`,
        });
      }
      await write(
        json
          ? JSON.stringify(
              {
                ...job.value,
                slot: JOB_POLICIES[job.value.kind].slot,
                priority: JOB_POLICIES[job.value.kind].priority,
              },
              null,
              2,
            )
          : formatJob(job.value),
      );
      return 0;
    }
    case "drop": {
      const seq = jobId(positionals[0]);
      const dropped = await executeQueue(
        withQueue(
          repository,
          "write",
          JobQueue.JobQueue.use((queue) => queue.drop(seq)),
        ),
      );
      if (isRefused(dropped)) {
        // An active job: the worker aborts its attempt, which ends dropped (never retried).
        const active = await executeQueue(
          withQueue(
            repository,
            "read",
            JobQueue.JobQueue.use((queue) => queue.inspect(seq)),
          ),
        );
        if (
          isRefused(active) ||
          Option.isNone(active) ||
          active.value.state !== "active"
        )
          return refuse(dropped);
        const result = await execute(
          withQueue(
            repository,
            "write",
            Effect.gen(function* () {
              const location = yield* resolveStoreLocation(repository);
              return yield* HarnessHandler.dropActiveJob(location, seq);
            }).pipe(Effect.provide(BunFileSystem.layer)),
          ),
        );
        if (!result.dropped) {
          if ("pending" in result) {
            // Requested, not refused: the attempt ends dropped once its handler stops.
            await write(
              `Drop requested for active job ${seq}: ${result.reason}.`,
            );
            return 0;
          }
          return refuse({
            refused: `job ${seq} is active and could not be dropped: ${result.reason}`,
          });
        }
        await write(
          json
            ? JSON.stringify(
                { ...result.job, abandoned: result.abandoned },
                null,
                2,
              )
            : `Dropped active job ${seq} (${result.job.kind}): its attempt was aborted and it is now failed with cause Dropped.${!isReviewRun(result.job.kind) ? "" : result.abandoned.removed ? " Its run folder was deleted." : " It had no run folder."}${result.interrupted.length === 0 ? "" : ` It was dropped mid-Publish: ${result.interrupted.length} batch(es) were appended with no packet, disclosed as a gap.`}`,
        );
        return 0;
      }
      // A dropped review abandons its run: its run folder goes (proposal §1).
      const abandoned = isReviewRun(dropped.kind)
        ? await execute(
            Effect.gen(function* () {
              const location = yield* resolveStoreLocation(repository);
              return yield* HarnessHandler.abandonDroppedRun(location, dropped);
            }).pipe(Effect.provide(BunFileSystem.layer)),
          )
        : undefined;
      await write(
        json
          ? JSON.stringify(
              { ...dropped, ...(abandoned === undefined ? {} : { abandoned }) },
              null,
              2,
            )
          : `Dropped job ${dropped.seq} (${dropped.kind}); it is now failed with cause Dropped.${abandoned === undefined ? "" : abandoned.removed ? " Its run folder was deleted." : " It had no run folder."}`,
      );
      return 0;
    }
    case "enqueue": {
      const parsedKind = JobKind.safeParse(positionals[0]);
      const problems = parsedKind.success
        ? []
        : [
            argumentRefusal(
              "Job kind",
              JobKind.options.join(", "),
              positionals[0],
            ),
          ];
      const payloadText = positionals[1];
      let payload: unknown;
      if (payloadText !== undefined) {
        try {
          payload = JSON.parse(payloadText);
        } catch {
          problems.push(argumentRefusal("Job payload", "JSON", payloadText));
        }
      }
      if (!parsedKind.success || problems.length > 0)
        return refuse({ refused: problems.join("\n") });
      const kind = parsedKind.data;
      const dedupeKey = values.key ?? `${kind}:manual:${mintUlid()}`;
      const result = await executeQueue(
        withQueue(
          repository,
          "create",
          JobQueue.JobQueue.use((queue) =>
            queue.enqueue({ kind, dedupeKey, payload }),
          ),
        ),
      );
      if (isRefused(result)) return refuse(result);
      const { job } = result;
      const ended = job.state === "completed" || job.state === "failed";
      // The job is committed now; failing to reach or spawn a worker (for example a sandbox that may
      // not create the socket directory) leaves it queued for the next start or sweep.
      const started =
        values["no-start"] === true || ended
          ? undefined
          : await Effect.runPromise(
              Effect.result(
                Starter.ensureWorker({
                  repository,
                  command: Starter.currentCliCommand(),
                }),
              ),
            );
      const startError =
        started?._tag === "Failure"
          ? await execute(Effect.fail(started.failure)).catch(
              (error: unknown) =>
                error instanceof Error ? error.message : String(error),
            )
          : undefined;
      if (json) {
        await write(
          JSON.stringify(
            {
              ...result,
              worker: started?._tag === "Success" ? started.success : null,
              ...(startError === undefined ? {} : { workerError: startError }),
            },
            null,
            2,
          ),
        );
        return 0;
      }
      if (ended) {
        await write(
          `Not requeued: job ${job.seq} ${job.kind} with key ${job.dedupeKey} already ended ${job.state}${job.lastError === null ? "" : ` (${job.lastError.tag}: ${job.lastError.message})`}. Enqueue with another --key to run it again.`,
        );
        return 0;
      }
      const worker =
        values["no-start"] === true
          ? "worker not started (--no-start)"
          : started === undefined || started._tag === "Failure"
            ? `queued without waking a worker (${startError}); it runs at the next worker start or sweep`
            : started.success.status === "running"
              ? "signalled the running worker"
              : `spawned a worker (pid ${started.success.pid ?? "?"}, log ${started.success.log})`;
      await write(
        `${result.status === "enqueued" ? "Enqueued" : "Already queued:"} job ${job.seq} ${job.kind} (${job.state}, key ${job.dedupeKey}); ${worker}.`,
      );
      return 0;
    }
    default:
      throw new Error(
        `Unknown jobs command: ${subcommand}. Run neuve jobs --help for usage.`,
      );
  }
};

const logLine = (date: Date, level: string, message: string) => {
  try {
    // Synchronous, so every line is out before the process exits.
    writeSync(
      1,
      `${date.toISOString()} worker[${process.pid}] ${level.toUpperCase().padEnd(7)} ${message}\n`,
    );
  } catch {
    // A child's output closes with its worker; a lost line must never end or strand the process.
  }
};

/** One line per log entry: time, worker PID, level, message. */
const workerLogger = Logger.make((options) => {
  logLine(options.date, options.logLevel, String(options.message));
});

/**
 * `neuve worker prepare-commit` (not in the help: the worker runs it): one commit's preparation in
 * a child process of the worker, at nice 10, over the same store (10.20, 6.10).
 */
const prepareCommitChild = (
  repository: string,
  commit: {
    readonly oid: string;
    readonly tree: string;
    readonly parents: ReadonlyArray<string>;
  },
): Promise<number> => {
  HarnessCommitPrepare.requirePreparationPriority();
  return runWorkerMain(
    Effect.gen(function* () {
      const location = yield* resolveStoreLocation(repository);
      return yield* Effect.andThen(
        Store.prepareForWrite,
        withCodeWork(
          location,
          true,
          HarnessCommitPrepare.prepareCommit(
            { repository, storeDirectory: location.directory },
            commit,
          ).pipe(Effect.provideService(InsideSharedWorkGrant, true)),
        ),
      ).pipe(
        Effect.provide(
          Computations.layer.pipe(Layer.provideMerge(Blobs.layer(location))),
        ),
        Effect.provide(Store.layer(location, { create: true })),
      );
    }).pipe(
      Effect.provide(
        Layer.merge(BunFileSystem.layer, Logger.layer([workerLogger])),
      ),
    ),
    143,
  );
};

/** Coding stores have no Git repository. Wake their current worker before starting another. */
export const startCaptureWorker = (
  location: StoreLocation,
  command: readonly string[],
) =>
  Effect.gen(function* () {
    yield* Worker.requireCurrentWorkerClaim(location);
    const { reach } = yield* Worker.reachStoreWorker(
      location,
      "wake",
      "500 millis",
    );
    if (Worker.isLive(reach)) return;
    yield* Effect.try({
      try: () => {
        const log = openSync(
          join(location.directory, "worker.log"),
          "a",
          0o600,
        );
        try {
          const child = Bun.spawn(
            [...command, "worker", "run", "--store", location.directory],
            {
              cwd: location.directory,
              stdin: "ignore",
              stdout: log,
              stderr: log,
              detached: true,
              env: {
                PATH: process.env["PATH"] ?? "/usr/bin:/bin",
                HOME: location.directory,
                TMPDIR: location.directory,
              },
            },
          );
          child.unref();
        } finally {
          closeSync(log);
        }
      },
      catch: () => new Error("capture worker could not start"),
    });
  });

/** Keep the worker's existing failure prefix and the bounded cause chain on one log line. */
const workerFailureLine = (message: string, failure: unknown): string => {
  const oneLine = (value: string) =>
    value.replace(/[\r\n\u0000-\u001f\u007f]/g, " ");
  let line = oneLine(message).slice(0, 2048);
  const seen = new Set<unknown>();
  let current = failure;
  while (
    typeof current === "object" &&
    current !== null &&
    "cause" in current
  ) {
    current = current.cause;
    if (current === undefined || seen.has(current)) break;
    seen.add(current);
    const description = oneLine(
      current instanceof Error
        ? `${current.name}: ${current.message}`
        : String(current),
    );
    const remaining = 2048 - line.length - 11;
    if (remaining <= 0) break;
    line += ` (cause: ${description.slice(-remaining)})`;
  }
  return `neuve: ${line}\n`;
};

const runWorkerMain = <A, E>(
  program: Effect.Effect<A, E>,
  interruptedExitCode = 0,
) => {
  return new Promise<number>(() => {
    BunRuntime.runMain(program, {
      disableErrorReporting: true,
      teardown: (exit) => {
        if (Exit.isSuccess(exit)) process.exit(0);
        if (Cause.hasInterruptsOnly(exit.cause)) {
          logLine(new Date(), "info", "worker stopped by signal");
          process.exit(interruptedExitCode);
        }
        void execute(Effect.failCause(exit.cause)).catch((error: unknown) => {
          try {
            writeSync(
              2,
              workerFailureLine(
                error instanceof Error ? error.message : String(error),
                Option.getOrUndefined(Cause.findErrorOption(exit.cause)),
              ),
            );
          } finally {
            // Bun's event loop spins with this process still alive if a failed write skips the exit.
            process.exit(2);
          }
        });
      },
    });
  });
};

/**
 * Runs the worker as this process's main fiber: SIGINT and SIGTERM interrupt it, so it releases its
 * job and socket before exiting. The process then exits explicitly, because a worker that found its
 * socket path taken by another process leaves its own server open (see `Worker.run`).
 */
const joinMachineBudget = Effect.tryPromise(() => workerBudget()).pipe(
  Effect.catch(() =>
    Effect.logWarning(
      "machine budget unavailable at startup; jobs will retry admission",
    ),
  ),
);

const runForeground = (
  repository: string,
  location: StoreLocation,
  idleSeconds: number,
): Promise<number> => {
  const program = Effect.gen(function* () {
    HarnessRuntimes.configureProcessRuntimes(
      HarnessRuntimes.workerRuntimeOptions(undefined, thisBuild()),
    );
    yield* Effect.logInfo(
      `worker starting for ${repository} (idle exit after ${idleSeconds}s)`,
    );
    yield* Registry.registerRepository(location, repository).pipe(
      Effect.catch((error) =>
        Effect.logWarning(
          `could not register the repository: ${String(error)}`,
        ),
      ),
    );
    // Each review job runs only where its route's credential is available: the key variable for
    // the Anthropic route, the Neuve sign-in for the OpenAI route; otherwise it is held (10.17).
    const review = HarnessHandler.workerHandlers({ location, repository });
    yield* Effect.logInfo(
      "review.run jobs are admitted per job: each runs only when this worker has its route's credential (values not read)",
    );
    // Precompute's background work (10.20, 10.53): commit preparation and the cycle's scope fetch.
    // Neither needs a model key, so every worker runs them.
    const precompute = {
      "commit.prepare": HarnessCommitPrepare.commitPrepareHandler({
        repository,
        command: Starter.currentCliCommand(),
      }),
      "commit.prepare@2": HarnessCommitPrepare.commitPrepareHandler({
        repository,
        location,
        command: Starter.currentCliCommand(),
      }),
      // Hybrid leads (10.118): only while search.hybrid.prepare is on; behind the gate.
      "commit.hybrid": HarnessCommitHybrid.commitHybridHandler({
        repository,
        storeDirectory: location.directory,
        workers: HarnessHybridModels.hybridWorkers,
      }),
      "scope.fetch": HarnessScope.scopeFetchHandler({ repository, location }),
      // Stack sources (11.15): fetch and index in children at nice 10, behind the gate.
      "stack.fetch": HarnessStack.stackFetchHandler({
        repository,
        location,
        command: Starter.currentCliCommand(),
      }),
      "stack.index": HarnessStack.stackIndexHandler({
        repository,
        location,
        command: Starter.currentCliCommand(),
      }),
    };
    const exit = yield* Effect.andThen(
      prepareWorkerStore(location),
      // Once this worker holds the socket and has recovered stalled jobs, it records whether it can
      // run review jobs and sweeps the run folders of review jobs that ended without it. The daily
      // prune also sweeps run folders (8.10).
      Worker.run({
        location,
        version: CLI_VERSION,
        idleTimeout: `${idleSeconds} seconds`,
        beforeIdleExit: Effect.promise(() => closeWorkerBudget()),
        handlers: {
          ...Worker.handlersFor(location),
          "retention.prune": capturePruneHandler(
            location,
            Worker.handlersFor(location)["retention.prune"],
          ),
          ...review,
          ...precompute,
          "capture.scan": captureScanHandler({
            location,
            command: Starter.currentCliCommand(),
          }),
        },
        beforeComputationRecovery: joinMachineBudget,
        afterRecovery: Effect.andThen(
          Effect.void,
          captureStartupRecovery(
            captureCheckpointSweep(location).sweep,
            HarnessHandler.onClaim(location),
          ),
        ),
        // Graph searches and relations reads a review stopped waiting for finish and keep their
        // answers (0013).
        detachedWork: Effect.zipWith(
          HarnessGraphSearch.graphSearchesInFlight,
          HarnessRelations.relationsReadsInFlight,
          (searches, relations) => searches + relations,
        ),
        // The Graph cache keeps the queue's and the active branches' bases (10.115).
        eachTurn: HarnessGraphDeclare.graphBasesTurn(location, repository),
        admit: HarnessHandler.admitReview(location),
      }).pipe(
        Effect.provideService(Retention.RetentionSweeps, [
          HarnessHandler.runFolderSweep(location),
          HarnessScope.scopeCopySweep(location),
          captureCheckpointSweep(location),
        ]),
      ),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          JobQueue.layer,
          Computations.layer.pipe(Layer.provideMerge(Blobs.layer(location))),
        ),
      ),
      Effect.provide(Store.layer(location, { create: true })),
      (program) => Worker.withStartup(location, program),
    );
    yield* Effect.logInfo(Worker.describeExit(exit));
    return exit;
  }).pipe(
    Effect.provide(
      Layer.merge(BunFileSystem.layer, Logger.layer([workerLogger])),
    ),
    // NEUVE_WORKER_DEBUG=1 also logs each loop turn: the slots, the queue and the next wake.
    Effect.provideService(
      References.MinimumLogLevel,
      process.env["NEUVE_WORKER_DEBUG"] === "1" ? "Debug" : "Info",
    ),
  );
  return runWorkerMain(program);
};

/** One status line for a slot's job. */
const describeSlotJob = (job: Worker.SlotJob | null | undefined) =>
  job === null || job === undefined
    ? "free"
    : `job ${job.seq} ${job.kind} attempt ${job.attempt}, since ${job.startedAt}`;

/**
 * The status lines for the worker's jobs: one per slot, or, from a worker on a build before the two
 * slots (10.31), its single current job. A worker that did not answer shows none.
 */
const slotLines = (live: unknown): ReadonlyArray<string> => {
  if (typeof live !== "object" || live === null) return ["jobs           -"];
  const reply = live as {
    readonly slots?: Partial<Record<string, Worker.SlotJob | null>>;
    readonly current?: Worker.SlotJob | null;
  };
  if (reply.slots === undefined)
    return [
      `current job    ${reply.current === null || reply.current === undefined ? "none" : describeSlotJob(reply.current)}`,
    ];
  const slots = reply.slots;
  return (["interactive", "background"] as const).map(
    (slot) => `${slot.padEnd(15)}${describeSlotJob(slots[slot])}`,
  );
};

export const runWorkerCli = async (
  args: readonly string[],
): Promise<number> => {
  const [subcommand, ...rest] = args;
  if (
    subcommand === undefined ||
    subcommand === "--help" ||
    subcommand === "help"
  ) {
    await write(WORKER_HELP);
    return 0;
  }
  const { values } = parseArgs({
    args: [...rest],
    strict: true,
    options: {
      repo: { type: "string" },
      store: { type: "string" },
      capture: { type: "string" },
      work: { type: "string" },
      json: { type: "boolean" },
      "idle-seconds": { type: "string" },
      "scan-parent": { type: "string" },
      "parent-pid": { type: "string" },
      observe: { type: "boolean" },
      "no-load": { type: "boolean" },
      oid: { type: "string" },
      tree: { type: "string" },
      parent: { type: "string", multiple: true },
      input: { type: "string" },
    },
  });
  const repository = resolve(values.repo ?? process.cwd());
  const selectedLocation = () =>
    values.store === undefined
      ? resolveStoreLocation(repository)
      : Effect.succeed(storeLocationIn(dirname(resolve(values.store))));

  /**
   * A worker names itself to its heavy child, because by the time the child gets here its parent may
   * already be init. A worker from before a reinstall names no one, so its child watches its own
   * parent, unless that is init already, which means the worker has gone.
   */
  const guardChild = () => {
    const named = values["parent-pid"];
    if (named === undefined && process.ppid === 1) process.exit(143);
    process.once("SIGTERM", stopRunningCommands);
    HeavyChild.guardWorkerChild(
      z.coerce
        .number()
        .int()
        .min(1)
        .parse(named ?? process.ppid),
    );
  };

  switch (subcommand) {
    case "capture-scan":
      return runScanChild({
        location: storeLocationIn(
          dirname(resolve(z.string().parse(values.store))),
        ),
        rawCapture: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .parse(values.capture),
        workDirectory: resolve(z.string().parse(values.work)),
        observe: values.observe === true,
        parentPid: z.coerce.number().int().min(2).parse(values["scan-parent"]),
      });
    case "prepare-code": {
      guardChild();
      HarnessCommitPrepare.requirePreparationPriority();
      return runWorkerMain(
        Effect.gen(function* () {
          const location = yield* selectedLocation();
          const payload: unknown = JSON.parse(z.string().parse(values.input));
          return yield* Effect.andThen(
            Store.prepareForWrite,
            HarnessCommitPrepare.prepareCode(repository, location, payload),
          ).pipe(
            Effect.provide(
              Computations.layer.pipe(
                Layer.provideMerge(Blobs.layer(location)),
              ),
            ),
            Effect.provide(Store.layer(location, { create: true })),
          );
        }).pipe(
          Effect.provide(
            Layer.merge(BunFileSystem.layer, Logger.layer([workerLogger])),
          ),
        ),
        143,
      );
    }
    case "prepare-commit":
      guardChild();
      return prepareCommitChild(repository, {
        oid: z
          .string()
          .regex(/^[0-9a-f]{40,64}$/)
          .parse(values.oid),
        tree: z
          .string()
          .regex(/^[0-9a-f]{40,64}$/)
          .parse(values.tree),
        parents: z
          .array(z.string().regex(/^[0-9a-f]{40,64}$/))
          .parse(values.parent ?? []),
      });
    case "stack-fetch":
      guardChild();
      return runStackFetchChild(values.input);
    case "stack-index":
      guardChild();
      return runStackIndexChild(values.input);
    case "run": {
      const idleSeconds = z.coerce
        .number()
        .int()
        .min(1)
        .parse(values["idle-seconds"] ?? 60);
      if (values.store !== undefined) {
        HarnessRuntimes.configureProcessRuntimes(
          HarnessRuntimes.workerRuntimeOptions(undefined, thisBuild()),
        );
        const location = storeLocationIn(dirname(resolve(values.store)));
        const program = Effect.andThen(
          prepareWorkerStore(location),
          Worker.run({
            location,
            version: CLI_VERSION,
            idleTimeout: `${idleSeconds} seconds`,
            beforeIdleExit: Effect.promise(() => closeWorkerBudget()),
            beforeComputationRecovery: joinMachineBudget,
            afterRecovery: Effect.andThen(
              Effect.void,
              captureCheckpointSweep(location).sweep,
            ),
            handlers: {
              ...Worker.handlersFor(location),
              "retention.prune": capturePruneHandler(
                location,
                Worker.handlersFor(location)["retention.prune"],
              ),
              "capture.scan": captureScanHandler({
                location,
                command: Starter.currentCliCommand(),
              }),
            },
          }),
        ).pipe(
          Effect.provideService(Retention.RetentionSweeps, [
            captureCheckpointSweep(location),
          ]),
          Effect.provide(
            Layer.mergeAll(
              JobQueue.layer,
              Computations.layer.pipe(
                Layer.provideMerge(Blobs.layer(location)),
              ),
            ),
          ),
          Effect.provide(Store.layer(location, { create: true })),
          (program) => Worker.withStartup(location, program),
          Effect.provide(BunFileSystem.layer),
        );
        return runWorkerMain(program);
      }
      const location = await execute(selectedLocation());
      return runForeground(repository, location, idleSeconds);
    }
    case "start": {
      if (values.store !== undefined) {
        const location = await execute(selectedLocation());
        await execute(
          withStore(
            repository,
            "create",
            startCaptureWorker(location, Starter.currentCliCommand()),
            location,
          ),
        );
        await write("Capture worker started or signalled.");
        return 0;
      }
      const started = await execute(
        Starter.ensureWorker({
          repository,
          command: Starter.currentCliCommand(),
        }),
      );
      await write(
        started.status === "running"
          ? `A worker is running on ${started.socket}; signalled it.`
          : `Spawned a worker (pid ${started.pid ?? "?"}); output in ${started.log}.`,
      );
      return 0;
    }
    case "status": {
      if (values.store === undefined) await warnIfPaused(repository);
      const location = await execute(selectedLocation());
      const { socket, reach } = await execute(
        Worker.reachStoreWorker(location, "status"),
      );
      const claim = await execute(
        withStore(repository, "read", Worker.readClaim, location),
      ).catch(() => Option.none<Worker.WorkerClaim>());
      const row = Option.getOrUndefined(claim);
      const olderWorker = await execute(Worker.hasLegacyWorkerClaim(location));
      const live =
        reach._tag === "Answered"
          ? (JSON.parse(reach.reply) as Worker.WorkerStatusReply)
          : undefined;
      // The lifetime lock and connection evidence decide ownership; PID is diagnostic.
      const holderAlive = !(await execute(
        Worker.holderGone(location, reach, olderWorker),
      ));
      const socketState = Worker.isLive(reach)
        ? "live"
        : holderAlive
          ? "unreachable"
          : reach._tag === "Refused"
            ? "stale"
            : "absent";
      const running = socketState === "live" || socketState === "unreachable";
      const status = {
        socket,
        socketState,
        ...(reach._tag === "Refused" ? { connectError: reach.code } : {}),
        responding: live !== undefined,
        worker: live ?? row ?? null,
        ...(olderWorker
          ? { message: Worker.olderWorkerMessage(location.directory) }
          : {}),
      };
      if (values.json === true) {
        await write(JSON.stringify(status, null, 2));
        return running ? 0 : 3;
      }
      if (olderWorker) {
        await write(Worker.olderWorkerMessage(location.directory));
        return 1;
      }
      if (!running) {
        await write(
          `No worker is running (socket ${socketState === "stale" ? "left by a dead worker" : "absent"}: ${socket}).`,
        );
        return 3;
      }
      const silence =
        socketState === "unreachable"
          ? ` but this process cannot connect (${reach._tag === "Refused" ? reach.code : "no socket"}): its backlog may be full (stopped or busy), or this process is sandboxed`
          : live === undefined
            ? " but did not answer within 1 s (stopped or busy)"
            : "";
      const lines = [
        `Worker pid ${live?.pid ?? row?.pid ?? "?"} holds ${socket}${silence}.`,
        `started at     ${live?.startedAt ?? row?.startedAt ?? "-"}`,
        ...slotLines(live),
        `last progress  ${live?.lastProgressAt ?? row?.lastProgressAt ?? "-"} ${live?.lastProgress ?? row?.lastProgress ?? ""}`,
      ];
      await write(lines.join("\n"));
      return 0;
    }
    case "recover": {
      const result = await execute(
        Worker.recoverWorker(await execute(selectedLocation())),
      );
      await write(
        values.json === true ? JSON.stringify(result) : result.message,
      );
      return result.recovered ? 0 : 1;
    }
    case "stop": {
      const location = await execute(selectedLocation());
      // A worker of an older build is stopped on its legacy socket in the store.
      const found = await execute(Worker.reachStoreWorker(location));
      const deadline = AbortSignal.timeout(10_000);
      let reach: Worker.Reach = found.reach;
      try {
        if (Worker.isLive(found.reach))
          reach = await Worker.stopWorker(found.socket, deadline);
      } catch (error) {
        if (!deadline.aborted) throw error;
        await Bun.write(
          Bun.stderr,
          "neuve: the worker did not stop within 10 s.\n",
        );
        return 1;
      }
      if (reach._tag === "Absent" || reach._tag === "Refused") {
        await write(
          reach._tag === "Absent"
            ? "No worker is running."
            : `No worker accepted the connection (${reach.code}). Check \`neuve worker status\`.`,
        );
        return 0;
      }
      if (reach._tag === "Unanswered") {
        await Bun.write(
          Bun.stderr,
          "neuve: the worker connection ended before acknowledging stop.\n",
        );
        return 1;
      }
      await write("Worker stopped.");
      return 0;
    }
    case "sweep": {
      const entries = await execute(
        Sweep.sweep({ command: Starter.currentCliCommand() }).pipe(
          Effect.provide(BunFileSystem.layer),
        ),
      );
      const at = new Date().toISOString();
      await write(
        entries.length === 0
          ? `${at} sweep: no registered repositories`
          : entries
              .map(
                (entry) =>
                  `${at} sweep ${entry.repository}: ${entry.spoolFiles} spool file(s), ${entry.queuedJobs} job(s)${entry.pruneWanted ? ", raw captures due for pruning" : ""}; ${entry.outcome.status}${"message" in entry.outcome ? ` ${entry.outcome.message}` : ""}`,
              )
              .join("\n"),
      );
      return 0;
    }
    case "install-agent": {
      if (process.platform === "linux") {
        if (
          values["no-load"] !== true &&
          !(await Systemd.userSystemdAvailable())
        ) {
          await write(Systemd.NO_USER_SYSTEMD);
          return 0;
        }
        const [command, ...args] = Starter.currentCliCommand();
        if (!command || args.length)
          throw new Error(
            "Run neuve worker install-agent from an installed neuve, not from source.",
          );
        await write(
          await Systemd.installAgent({
            command,
            ...(process.env.NEUVE_INSTALL_AGENT_RECEIPT
              ? { receipt: process.env.NEUVE_INSTALL_AGENT_RECEIPT }
              : {}),
            load: values["no-load"] !== true,
          }),
        );
        return 0;
      }
      const command = Starter.currentCliCommand();
      const installed = await execute(
        Launchd.installAgent({
          command,
          load: values["no-load"] !== true,
        }).pipe(Effect.provide(BunFileSystem.layer)),
      );
      await write(
        `Wrote ${installed.path}${installed.loaded ? " and loaded it" : " (not loaded: --no-load)"}. It runs \`${[...command, "worker", "sweep"].join(" ")}\` at login and every ${Launchd.SWEEP_INTERVAL_SECONDS / 60} minutes.`,
      );
      return 0;
    }
    case "uninstall-agent": {
      if (process.platform === "linux") {
        const [command, ...args] = Starter.currentCliCommand();
        if (!command || args.length)
          throw new Error(
            "Run neuve worker uninstall-agent from an installed neuve, not from source.",
          );
        const message = await (process.env.NEUVE_ROLLBACK_AGENT_RECEIPT
          ? Systemd.rollbackAgent({
              command,
              load: values["no-load"] !== true,
              receipt: process.env.NEUVE_ROLLBACK_AGENT_RECEIPT,
            })
          : Systemd.uninstallAgent({
              command,
              load: values["no-load"] !== true,
            }));
        await write(message);
        return [
          Systemd.FOREIGN,
          Systemd.UNSAFE,
          Systemd.ROLLBACK_REFUSED,
        ].includes(message)
          ? 1
          : 0;
      }
      const removed = await execute(
        Launchd.uninstallAgent({ load: values["no-load"] !== true }).pipe(
          Effect.provide(BunFileSystem.layer),
        ),
      );
      await write(
        removed.removed
          ? `Removed ${removed.path}${removed.unloaded ? " after unloading it" : ""}.`
          : `No agent at ${removed.path}.`,
      );
      return 0;
    }
    default:
      throw new Error(
        `Unknown worker command: ${subcommand}. Run neuve worker --help for usage.`,
      );
  }
};
