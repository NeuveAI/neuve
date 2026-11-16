import { safeRead } from "@neuve/records-schema";
import { stopHeavyChild, workerParentArgs } from "../heavy-child.ts";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { setPriority, tmpdir } from "node:os";
import { join, posix } from "node:path";
import { Data, Effect, Exit, Metric, Option, Tracer } from "effect";
import { z } from "zod";
import {
  JobQueue,
  Log,
  Registry,
  STORE_DIRECTORY_MODE,
  STORE_FILE_MODE,
  Worker,
  resolveStoreLocation,
  type StoreLocation,
} from "@neuve/records-core";
import { runLogTracer, withTelemetry, type RunLog } from "../run-log.ts";
import { writeMetrics } from "../telemetry.ts";
import { StackFetchPayload, StackIndexPayload } from "@neuve/records-schema";
import { readSettings, settingsPath, telemetryMode } from "../settings.ts";
import { ECOSYSTEM_CAPABILITIES } from "./capability.ts";
import { resolveGitBinary } from "./git-store.ts";
import { readRepoStack } from "./repo-state.ts";
import {
  ResolvedStackSettings,
  resolveStackSettings,
  type ResolvedStackSettings as Resolved,
} from "./settings.ts";
import { stackStorePath } from "./store.ts";
import { scrubbedEnvironment } from "./transport.ts";
import {
  STACK_EVENTS,
  STACK_METRICS,
  STACK_SPANS,
  type StackEvent,
} from "./telemetry.ts";

/**
 * The worker's stack jobs (proposal SC1, SC6). `stack.fetch` and `stack.index` run in the
 * background slot; each handler waits at the heavy-work gate holding nothing, then starts a child
 * process of the worker (`neuve worker stack-fetch` or `stack-index`) at nice 10 in the scrubbed
 * environment, so the downloads, git fetches, extraction, ranking grep and index builds yield to
 * reviews and the user, and see none of the worker's credentials, proxies or git configuration.
 */

export class StackJobFailed extends Data.TaggedError("StackJobFailed")<{
  readonly message: string;
  readonly retryable?: false;
}> {}

/** What the worker passes its child: everything explicit, since the child's HOME is temporary. */
export const ChildFetchInput = z.strictObject({
  repository: z.string().min(1),
  storeDirectory: z.string().min(1),
  storeRoot: z.string().min(1),
  registryPath: z.string().min(1),
  gitPath: z.string().min(1),
  settings: ResolvedStackSettings,
  reason: z.enum(["setup", "commit", "review"]),
  revisions: z
    .array(z.string().regex(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/))
    .min(1)
    .max(4),
  baseRef: z.string().max(512).optional(),
  since: z.string().optional(),
});
export type ChildFetchInput = z.infer<typeof ChildFetchInput>;

export const ChildIndexInput = z.strictObject({
  storeRoot: z.string().min(1),
  registryPath: z.string().min(1),
  gitPath: z.string().min(1),
  settings: ResolvedStackSettings,
  trees: z.array(z.string()).max(1_000),
});
export type ChildIndexInput = z.infer<typeof ChildIndexInput>;

/** The child prints its report as one line with this prefix, after its log lines. */
export const REPORT_PREFIX = "neuve-stack-report ";

export interface HandlerOptions {
  readonly repository: string;
  readonly location: StoreLocation;
  /** The command that runs the CLI, such as `[execPath]` or `[bun, cli.ts]`. */
  readonly command: ReadonlyArray<string>;
  /** Tests: the user's home, for the store and settings paths. */
  readonly home?: string;
}

const resolvedSettings = (home?: string): Resolved => {
  const settings = readSettings(settingsPath(home));
  return resolveStackSettings(Option.getOrUndefined(settings)?.stack);
};

/** Starts the child at nice 10 in the scrubbed environment and returns its report line. */
const runChild = (
  options: HandlerOptions,
  args: ReadonlyArray<string>,
  gitPath: string,
) =>
  Effect.gen(function* () {
    const gate = yield* Worker.HeavyWork;
    // Stopping the child is required finalization: a worker leaving for any reason waits for it.
    yield* (yield* Worker.HandlerLifetime).retain;
    return yield* Effect.acquireUseRelease(
      Effect.tryPromise(() => mkdtemp(join(tmpdir(), "neuve-stack-"))),
      (home) =>
        Effect.scoped(
          Effect.gen(function* () {
            const child = yield* gate.child(
              Effect.void,
              () => {
                const child = Bun.spawn([...options.command, ...args], {
                  stdin: "ignore",
                  stdout: "pipe",
                  stderr: "pipe",
                  env: scrubbedEnvironment({ gitPath, home }),
                });
                try {
                  setPriority(child.pid, 10);
                } catch {}
                return child;
              },
              (child) => Effect.promise(() => stopHeavyChild(child)),
            );
            return yield* Effect.tryPromise({
              try: async () => {
                const [stdout, stderr, exitCode] = await Promise.all([
                  new Response(child.stdout).text(),
                  new Response(child.stderr).text(),
                  child.exited,
                ]);
                return { stdout, stderr, exitCode };
              },
              catch: (cause) => cause,
            });
          }),
        ),
      (home) =>
        Effect.promise(() => rm(home, { recursive: true, force: true })),
    );
  }).pipe(
    Effect.catchDefect((cause) =>
      Effect.fail(
        new StackJobFailed({
          message: `could not run the stack child: ${String(cause).slice(0, 300)}`,
        }),
      ),
    ),
    Effect.mapError(
      (cause) =>
        new StackJobFailed({
          message: `could not run the stack child: ${String(cause).slice(0, 300)}`,
        }),
    ),
    Effect.tap(({ stderr }) =>
      Effect.forEach(
        stderr
          .split("\n")
          .filter((line) => line.trim() !== "")
          .slice(-40),
        (line) => Effect.logInfo(`stack child: ${line.slice(0, 600)}`),
        { discard: true },
      ),
    ),
    Effect.flatMap(({ stdout, stderr, exitCode }) => {
      const line = stdout
        .split("\n")
        .reverse()
        .find((entry) => entry.startsWith(REPORT_PREFIX));
      if (exitCode !== 0 || line === undefined)
        return Effect.fail(
          new StackJobFailed({
            message: `the stack child exited ${exitCode}: ${stderr.trim().split("\n").slice(-3).join(" | ").slice(0, 500)}`,
          }),
        );
      return Effect.succeed(
        JSON.parse(line.slice(REPORT_PREFIX.length)) as unknown,
      );
    }),
  );

/**
 * A stack job's log, `<store>/stack-logs/<kind>-<job seq>.jsonl`: the run-log tracer's sink for the
 * job's span and its events, and the job's metrics at its end (10.97), as the scope job keeps its
 * own log. Kept beside the repository's run logs, not among them, since no run owns it. Each new
 * job's log prunes those older than 30 days, raw captures' retention (8.10), so one file per job
 * never piles up.
 */
export const STACK_LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export const pruneStackLogs = (directory: string, now = Date.now()) => {
  let names: Array<string>;
  try {
    names = readdirSync(directory);
  } catch {
    return 0;
  }
  let pruned = 0;
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const path = join(directory, name);
    try {
      if (now - statSync(path).mtimeMs > STACK_LOG_RETENTION_MS) {
        rmSync(path, { force: true });
        pruned++;
      }
    } catch {
      // Gone meanwhile.
    }
  }
  return pruned;
};

export const stackJobLog = (
  location: StoreLocation,
  kind: "fetch" | "index",
  seq: number,
  telemetryEnabled = telemetryMode(readSettings()) !== "off",
): RunLog => {
  const directory = join(location.directory, "stack-logs");
  pruneStackLogs(directory);
  const path = join(directory, `${kind}-${seq}.jsonl`);
  return withTelemetry(
    {
      path,
      write: (record) => {
        mkdirSync(directory, { recursive: true, mode: STORE_DIRECTORY_MODE });
        appendFileSync(
          path,
          `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`,
          { mode: STORE_FILE_MODE },
        );
      },
      read: () => [],
    },
    telemetryEnabled,
  );
};

/** The child's events, as span events on the job's span at the times they happened. */
const recordEvents = (events: ReadonlyArray<StackEvent> | undefined) =>
  Effect.gen(function* () {
    const span = Option.getOrUndefined(
      yield* Effect.option(Effect.currentSpan),
    );
    for (const event of events ?? []) {
      span?.event(event.name, BigInt(event.at) * 1_000_000n, {
        ...event.attributes,
      });
      if (
        event.name === STACK_EVENTS.packageFetched ||
        event.name === STACK_EVENTS.upstreamFetched
      )
        yield* Metric.update(
          Metric.withAttributes(STACK_METRICS.fetchedBytes, {
            "harness.stack.kind":
              event.name === STACK_EVENTS.packageFetched
                ? "package"
                : "upstream",
          }),
          Number(event.attributes["harness.stack.bytes"] ?? 0),
        );
      if (event.name === STACK_EVENTS.indexBuilt)
        yield* Metric.update(
          STACK_METRICS.indexDuration,
          Number(event.attributes["harness.stack.duration_ms"] ?? 0) / 1000,
        );
      const outcome =
        event.name === STACK_EVENTS.packageFetched
          ? "fetched"
          : event.name === STACK_EVENTS.packageReused
            ? "reused"
            : event.name === STACK_EVENTS.gap &&
                event.attributes["harness.stack.kind"] === "package"
              ? String(event.attributes["harness.stack.reason"])
              : undefined;
      if (outcome !== undefined)
        yield* Metric.update(
          Metric.withAttributes(STACK_METRICS.entries, {
            "harness.stack.outcome": outcome,
          }),
          1,
        );
    }
  });

/**
 * Runs one stack job inside its span (`harness.stack.fetch` or `harness.stack.index`), traced to
 * the job's log with its own metric registry, whose series are written there at the job's end.
 */
const traced =
  (location: StoreLocation, kind: "fetch" | "index", seq: number) =>
  <A, E, R>(body: Effect.Effect<A, E, R>) =>
    Effect.suspend(() => {
      const log = stackJobLog(location, kind, seq);
      const registry: Metric.MetricRegistry = new Map();
      const started = performance.now();
      return body.pipe(
        Effect.withSpan(
          kind === "fetch" ? STACK_SPANS.fetch : STACK_SPANS.index,
          {
            attributes: { "harness.stack.job": kind, "harness.job.seq": seq },
          },
        ),
        Effect.onExit((exit) =>
          Effect.gen(function* () {
            yield* Metric.update(
              Metric.withAttributes(STACK_METRICS.jobDuration, {
                "harness.stack.job": kind,
                "harness.status": Exit.isSuccess(exit)
                  ? "ok"
                  : Exit.hasInterrupts(exit)
                    ? "interrupted"
                    : "error",
              }),
              (performance.now() - started) / 1000,
            );
            writeMetrics(log, registry);
          }),
        ),
        Effect.provideService(Tracer.Tracer, runLogTracer(log)),
        Effect.provideService(Metric.MetricRegistry, registry),
      );
    });

const gitPathOf = () => {
  const path = resolveGitBinary();
  if (path === undefined)
    return Effect.fail(
      new StackJobFailed({
        message: "git is not on the worker's PATH",
        retryable: false,
      }),
    );
  return Effect.succeed(path);
};

/**
 * The trees a fetch left without an index get one `stack.index` job, keyed by the fetch job and
 * those trees: a later fetch that finds them still unindexed (an earlier index job failed, or the
 * recipe changed) enqueues again, and the index job skips trees already indexed.
 */
const enqueueIndex = (fetchJob: number, trees: ReadonlyArray<string>) =>
  trees.length === 0
    ? Effect.void
    : JobQueue.JobQueue.use((queue) =>
        queue.enqueue({
          kind: "stack.index",
          dedupeKey: `stack.index:${fetchJob}:${createHash("sha256")
            .update([...trees].sort().join("\n"))
            .digest("hex")
            .slice(0, 40)}`,
          payload: { trees: [...trees] },
        }),
      ).pipe(Effect.provide(JobQueue.layer));

/** The worker's `stack.fetch` handler for one repository. */
export const stackFetchHandler =
  (options: HandlerOptions): Worker.JobHandler =>
  (job) =>
    Effect.gen(function* () {
      let request: {
        reason: "setup" | "commit" | "review";
        revisions: Array<string>;
        baseRef?: string;
        since?: string;
      };
      if (job.eventId !== null) {
        const stored = yield* Log.get(job.eventId);
        const event = Option.getOrUndefined(stored)?.event;
        if (event?.kind !== "review.requested@1")
          return yield* new StackJobFailed({
            message: `job ${job.seq} has no review.requested@1 event`,
            retryable: false,
          });
        request = {
          reason: "review",
          revisions: [
            event.attribution.range.baseOid,
            event.attribution.range.headOid,
          ],
          baseRef: event.attribution.range.baseRef,
        };
      } else {
        const parsed = safeRead(StackFetchPayload, job.payload);
        if (!parsed.success)
          return yield* new StackJobFailed({
            message: `job ${job.seq}: ${parsed.error.message.slice(0, 300)}`,
            retryable: false,
          });
        const { reason, revisions, baseRef, since } = parsed.data;
        request = {
          reason,
          revisions: [...revisions],
          ...(baseRef === undefined ? {} : { baseRef }),
          ...(since === undefined ? {} : { since }),
        };
      }
      // Nothing to do (and no child to start) where stack sources are off or never set up.
      const state = yield* Effect.promise(() =>
        readRepoStack(options.location.directory).catch(() => undefined),
      );
      const settings = resolvedSettings(options.home);
      if (state === undefined || !state.enabled || !settings.enabled) {
        yield* Effect.logInfo(
          `stack.fetch job ${job.seq}: skipped, stack sources are ${state === undefined ? "not set up here" : "off"}`,
        );
        return;
      }
      // From here the job does work: its span, events and metrics go to its log (10.97).
      yield* Effect.gen(function* () {
        const gitPath = yield* gitPathOf();
        const input: ChildFetchInput = {
          repository: options.repository,
          storeDirectory: options.location.directory,
          storeRoot: stackStorePath(options.home),
          registryPath: Registry.registryPath(options.home),
          gitPath,
          settings,
          ...request,
        };
        // The gate is passed before the child starts, holding nothing (as commit.prepare does).
        const report = (yield* runChild(
          options,
          [
            "worker",
            "stack-fetch",
            "--input",
            JSON.stringify(input),
            ...workerParentArgs(),
          ],
          gitPath,
        )) as {
          unindexed?: Array<string>;
          fetched?: Array<string>;
          upstream?: Array<string>;
          gaps?: Array<unknown>;
          remaining?: boolean;
          skipped?: string;
          events?: Array<StackEvent>;
          usage?: { total?: number };
        };
        yield* recordEvents(report.events);
        yield* Effect.annotateCurrentSpan({
          "harness.stack.reason": request.reason,
          "harness.stack.fetched": report.fetched?.length ?? 0,
          "harness.stack.upstream": report.upstream?.length ?? 0,
          "harness.stack.gaps": report.gaps?.length ?? 0,
          "harness.stack.remaining": report.remaining === true,
          ...(report.skipped === undefined
            ? {}
            : { "harness.stack.skipped": true }),
        });
        if (report.usage?.total !== undefined)
          yield* Metric.update(STACK_METRICS.storeBytes, report.usage.total);
        yield* Effect.logInfo(
          report.skipped !== undefined
            ? `stack.fetch job ${job.seq}: skipped, ${report.skipped}`
            : `stack.fetch job ${job.seq}: ${report.fetched?.length ?? 0} fetched, ${report.gaps?.length ?? 0} gap(s), ${report.unindexed?.length ?? 0} tree(s) to index${report.remaining === true ? "; the rest continues in a new job" : ""}`,
        );
        yield* enqueueIndex(job.seq, report.unindexed ?? []);
        if (report.remaining === true)
          yield* JobQueue.JobQueue.use((queue) =>
            queue.enqueue({
              kind: "stack.fetch",
              dedupeKey: `stack.fetch:continue:${job.seq}`,
              payload: {
                ...request,
                since:
                  request.since ?? job.startedAt ?? new Date().toISOString(),
              },
            }),
          ).pipe(Effect.provide(JobQueue.layer));
      }).pipe(traced(options.location, "fetch", job.seq));
    });

/** The worker's `stack.index` handler. */
export const stackIndexHandler =
  (options: HandlerOptions): Worker.JobHandler =>
  (job) =>
    Effect.gen(function* () {
      const parsed = safeRead(StackIndexPayload, job.payload);
      if (!parsed.success)
        return yield* new StackJobFailed({
          message: `job ${job.seq}: ${parsed.error.message.slice(0, 300)}`,
          retryable: false,
        });
      const settings = resolvedSettings(options.home);
      if (!settings.enabled) return;
      yield* Effect.gen(function* () {
        const gitPath = yield* gitPathOf();
        const input: ChildIndexInput = {
          storeRoot: stackStorePath(options.home),
          registryPath: Registry.registryPath(options.home),
          gitPath,
          settings,
          trees: [...parsed.data.trees],
        };
        const report = (yield* runChild(
          options,
          [
            "worker",
            "stack-index",
            "--input",
            JSON.stringify(input),
            ...workerParentArgs(),
          ],
          gitPath,
        )) as {
          built?: Array<string>;
          deferred?: Array<{ tree: string; reason: string }>;
          events?: Array<StackEvent>;
          usage?: { total?: number };
        };
        yield* recordEvents(report.events);
        yield* Effect.annotateCurrentSpan({
          "harness.stack.trees": input.trees.length,
          "harness.stack.built": report.built?.length ?? 0,
          "harness.stack.deferred": report.deferred?.length ?? 0,
        });
        yield* Effect.logInfo(
          `stack.index job ${job.seq}: ${report.built?.length ?? 0} built, ${report.deferred?.length ?? 0} deferred; deferred trees wait for a later fetch`,
        );
        if (report.usage?.total !== undefined)
          yield* Metric.update(STACK_METRICS.storeBytes, report.usage.total);
      }).pipe(traced(options.location, "index", job.seq));
    });

/** Whether a changed path is one a capability reads: a lockfile or committed registry configuration. */
export const isDeclaredStackFile = (path: string) => {
  const name = posix.basename(path);
  return ECOSYSTEM_CAPABILITIES.some(
    (capability) =>
      capability.lockfiles.includes(name) ||
      capability.registryConfigs.includes(name),
  );
};

/**
 * The refresh from `commit.prepare` (SC1): when a commit changes a file a capability declares, a
 * `stack.fetch` for that commit, keyed by the declared files' blobs, so a rebase that carries one
 * lockfile through many commits fetches once. Every fetch path draws on the same head-only budget,
 * which the fetch itself applies. Never fails the commit's preparation.
 */
export const refreshOnCommit = (
  repository: string,
  commit: { readonly oid: string; readonly parents: ReadonlyArray<string> },
) =>
  Effect.gen(function* () {
    const location = yield* resolveStoreLocation(repository);
    const state = yield* Effect.promise(() =>
      readRepoStack(location.directory).catch(() => undefined),
    );
    if (state === undefined || !state.enabled) return;
    const run = (args: ReadonlyArray<string>) =>
      Effect.promise(async () => {
        const child = Bun.spawn(["git", "-C", repository, ...args], {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "ignore",
        });
        const [out, code] = await Promise.all([
          new Response(child.stdout).text(),
          child.exited,
        ]);
        return code === 0 ? out : "";
      });
    const parent = commit.parents[0];
    const changed = (yield* run(
      parent === undefined
        ? [
            "diff-tree",
            "-r",
            "--root",
            "--no-commit-id",
            "--name-only",
            "-z",
            commit.oid,
          ]
        : [
            "diff-tree",
            "-r",
            "--no-commit-id",
            "--name-only",
            "-z",
            parent,
            commit.oid,
          ],
    ))
      .split("\0")
      .filter((path) => path !== "" && isDeclaredStackFile(path));
    if (changed.length === 0) return;
    const blobs = (yield* run([
      "ls-tree",
      "-z",
      "--full-tree",
      commit.oid,
      "--",
      ...changed,
    ]))
      .split("\0")
      .filter((line) => line !== "")
      .map((line) => line.split(/\s+/)[2] ?? "")
      .sort();
    const key = createHash("sha256")
      .update(blobs.join("\n"))
      .digest("hex")
      .slice(0, 40);
    yield* JobQueue.JobQueue.use((queue) =>
      queue.enqueue({
        kind: "stack.fetch",
        dedupeKey: `stack.fetch:lock:${key}`,
        payload: { reason: "commit", revisions: [commit.oid] },
      }),
    ).pipe(Effect.provide(JobQueue.layer));
    yield* Effect.logInfo(
      `commit ${commit.oid.slice(0, 12)} changes ${changed.join(", ")}: stack.fetch enqueued`,
    );
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning(
        `stack refresh for ${commit.oid.slice(0, 12)} skipped: ${String(cause).slice(0, 300)}`,
      ),
    ),
  );
