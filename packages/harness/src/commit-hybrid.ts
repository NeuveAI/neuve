import { indexRecipe } from "./search-index.ts";
import { captureOutlineSource } from "./graph-outline.ts";
import { readData } from "@neuve/records-core";
import { cpuJob } from "./budget/cpu.ts";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, statfsSync } from "node:fs";
import { join } from "node:path";
import { Clock, Data, Effect, Fiber, Metric, Option, Tracer } from "effect";
import { spanClock } from "./telemetry.ts";
import {
  JobQueue,
  STORE_DIRECTORY_MODE,
  STORE_FILE_MODE,
  Worker,
} from "@neuve/records-core";
import { CommitHybridPayload } from "@neuve/records-schema";
import { commitHunks, MAX_LEAD_HUNKS } from "./commit-prepare.ts";
import { queryVector, type E0Runtime, type QueryEncoder } from "./e0.ts";
import { mergeBase, treeOf } from "./git-objects.ts";
import { git } from "./git.ts";
import {
  graphRetriever,
  GraphPending,
  GRAPH_WHOLE_ANSWER,
  prepareBase,
  type GraphRuntime,
} from "./graph-search.ts";
import { cachedLeads, hunkLeads } from "./leads.ts";
import {
  encodeChunks,
  localTreeVectors,
  missingAmong,
  type ChunkEncoder,
  type LocalTreeVectors,
} from "./hybrid-vectors.ts";
import {
  hybridRetriever,
  type GraphPool,
  type HybridParts,
  type PairReranker,
} from "./hybrid.ts";
import type { HybridConfig } from "./retriever.ts";
import { indexOf } from "./retrievers.ts";
import {
  graphConfigFor,
  GRAPH_TOP_K,
  hybridConfigFor,
  searchRuntimeFrom,
  type HybridRuntime,
} from "./search-config.ts";
import type { TreeIndex } from "./search-index.ts";
import {
  readRunLog,
  runLogTracer,
  withTelemetry,
  type RunLog,
} from "./run-log.ts";
import { readSettings, telemetryMode } from "./settings.ts";
import { writeMetrics } from "./telemetry.ts";

/**
 * The `commit.hybrid` job (10.117, 10.118): a prepared commit's hybrid leads, in the worker's
 * background slot behind the heavy-work gate, on the worker's long-lived model processes (their
 * own processes at nice 10). It runs only while the settings turn hybrid preparation on
 * (`search.hybrid.prepare`), which stays off outside measured slots.
 *
 * 1. The commit's parent tree must have a vector for every encodable chunk. A tree missing only
 *    the chunks of a commit or two (`HYBRID_ENCODE_CAP`) is completed here; one missing more has
 *    not had its first pass over the whole tree (run in a measured slot), so no hunk gets hybrid
 *    leads and the job says so. A review then uses the keyword search's leads, disclosed and counted.
 * 2. Each hunk's hybrid leads against the parent tree, at most `HYBRID_HUNK_CONCURRENCY` at once
 *    (the reranker's bound), stored under the leads key a review looks up (`leads.ts`). Hunks are
 *    not started past `HYBRID_BUDGET_MS`, so an attempt ends inside its deadline.
 * 3. The commit's own changed chunks, so the next commit's parent tree is ready.
 *
 * Every step is a span (10.97); the job's span carries the counts.
 */

/**
 * Where commit-time hybrid work writes its spans and metrics (10.97): one JSON-lines log per commit
 * job or first pass, beside the store's run logs, as a review's run log holds its own. Small: span
 * metadata and counts only, never source.
 */
export const hybridLogDirectory = (storeDirectory: string) =>
  join(storeDirectory, "hybrid-logs");

export const openHybridLog = (
  storeDirectory: string,
  name: string,
  telemetryEnabled = telemetryMode(readSettings()) !== "off",
): RunLog => {
  const directory = hybridLogDirectory(storeDirectory);
  mkdirSync(directory, { recursive: true, mode: STORE_DIRECTORY_MODE });
  const path = join(directory, `${name}.jsonl`);
  return withTelemetry(
    {
      path,
      write: (record) => {
        appendFileSync(
          path,
          `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`,
          { mode: STORE_FILE_MODE },
        );
      },
      read: () => readRunLog(path),
    },
    telemetryEnabled,
  );
};

/** Runs `effect` with its spans and its metrics, at the end, written to `log`. */
export const withHybridLog = <A, E, R>(
  log: RunLog,
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.suspend(() => {
    const registry: Metric.MetricRegistry = new Map();
    return effect.pipe(
      Effect.provideService(Tracer.Tracer, runLogTracer(log)),
      Effect.provideService(Metric.MetricRegistry, registry),
      Effect.ensuring(Effect.sync(() => writeMetrics(log, registry))),
    );
  });

/** At most this many missing chunks are encoded by one job; beyond it the base needs its first pass. */
export const HYBRID_ENCODE_CAP = 4_000;
/** Hunks reranked at once: the reranker's bound (the overseer's call, 24 October 2026). */
export const HYBRID_HUNK_CONCURRENCY = 2;
/** No hunk starts past this much of an attempt, so it ends within the 10-minute deadline. */
export const HYBRID_BUDGET_MS = 7 * 60_000;

/** The worker's model processes: the chunk encoder and the reranker (ports; `hybrid-models.ts`). */
export interface HybridWorkers {
  readonly encoder: ChunkEncoder;
  readonly reranker: PairReranker;
  /** E0 queries on the encoder's own process (one E0 process, the overseer's call). */
  readonly encodeQuery?: QueryEncoder | undefined;
  /** Closes the encoder, so the reranker runs within the resident limit. */
  readonly releaseEncoder?: (() => Effect.Effect<void>) | undefined;
  /** The model processes' CPU so far, in seconds, for a job's span; absent for fakes. */
  readonly cpuSeconds?: (() => number) | undefined;
}

export class HybridUnavailable extends Data.TaggedError("HybridUnavailable")<{
  readonly message: string;
}> {}

/** What one commit's hybrid preparation did. */
export interface HybridReport {
  /** `paused`: free disk or swap passed its limit before a hunk; the job resumes on retry. */
  readonly status:
    | "prepared"
    | "off"
    | "not-ready"
    | "root"
    | "paused"
    /** Its budget ran out with hunks left: the job requeues and carries on. */
    | "continues";
  /** Hunks the budget left for the next run (`continues`). */
  readonly left?: number | undefined;
  readonly reason?: string | undefined;
  readonly encoded: { readonly parent: number; readonly commit: number };
  readonly leads: {
    readonly computed: number;
    readonly reused: number;
    readonly failed: number;
    readonly deferred: number;
  };
}

export interface HybridEnvironment {
  readonly repository: string;
  readonly config: HybridConfig;
  readonly e0: E0Runtime;
  readonly graph: GraphRuntime;
  readonly workers: HybridWorkers;
  /** Graph's pool answer for the parent commit; the product asks the shared Graph service. */
  readonly graphPool?:
    ((index: TreeIndex, commit: string) => GraphPool) | undefined;
  readonly queryVector?: HybridParts["queryVector"] | undefined;
  /** `HYBRID_ENCODE_CAP` unless given. */
  readonly encodeCap?: number | undefined;
  /** Model processes resident at once; 2 (concurrent phases) unless given. */
  readonly models?: number | undefined;
  /** When set, each hunk waits on a free-disk and swap check (`readResources`). */
  readonly limits?: HybridRuntime["limits"] | undefined;
  /** Where free disk is read: the Records store's folder. */
  readonly storeDirectory?: string | undefined;
  /** For tests: what the check reads. */
  readonly resources?: (() => Resources) | undefined;
  /** `HYBRID_BUDGET_MS` unless given. */
  readonly budgetMs?: number | undefined;
  /**
   * Prepares Graph's base for this commit, which the next commit's job searches as its parent;
   * `prepareBase` over the hybrid Graph runtime unless given.
   */
  readonly prepareNext?:
    | ((
        commit: string,
      ) => Effect.Effect<
        { readonly made: boolean; readonly cache?: string },
        unknown
      >)
    | undefined;
}

/** Free disk and swap in use, where the machine reports them; unknown is never a reason to pause. */
export interface Resources {
  readonly freeBytes?: number | undefined;
  readonly swapUsedBytes?: number | undefined;
}

export const readResources = (directory: string): Resources => {
  let freeBytes: number | undefined;
  try {
    const stats = statfsSync(directory);
    freeBytes = Number(stats.bavail) * Number(stats.bsize);
  } catch {
    freeBytes = undefined;
  }
  let swapUsedBytes: number | undefined;
  try {
    if (process.platform === "darwin") {
      const text =
        spawnSync("sysctl", ["-n", "vm.swapusage"], { encoding: "utf8" })
          .stdout ?? "";
      const used = /used = ([\d.]+)M/.exec(text)?.[1];
      if (used !== undefined) swapUsedBytes = Number(used) * 1024 ** 2;
    } else {
      const info = readFileSync("/proc/meminfo", "utf8");
      const kb = (field: string) =>
        Number(new RegExp(`^${field}:\\s+(\\d+)`, "m").exec(info)?.[1]);
      const used = kb("SwapTotal") - kb("SwapFree");
      if (Number.isFinite(used)) swapUsedBytes = used * 1024;
    }
  } catch {
    swapUsedBytes = undefined;
  }
  return { freeBytes, swapUsedBytes };
};

/** Why a hunk must wait, or undefined when it may start. */
export const overLimits = (
  resources: Resources,
  limits: HybridRuntime["limits"],
) =>
  resources.freeBytes !== undefined &&
  resources.freeBytes < limits.minFreeDiskBytes
    ? `free disk ${(resources.freeBytes / 1024 ** 3).toFixed(1)} GiB is below ${(limits.minFreeDiskBytes / 1024 ** 3).toFixed(0)} GiB`
    : resources.swapUsedBytes !== undefined &&
        resources.swapUsedBytes > limits.maxSwapUsedBytes
      ? `swap in use ${(resources.swapUsedBytes / 1024 ** 3).toFixed(1)} GiB is above ${(limits.maxSwapUsedBytes / 1024 ** 3).toFixed(0)} GiB`
      : undefined;

/**
 * A job that paused on the machine's limits: the queue runs it again after `pauseMs`, without
 * counting the attempt, and it resumes where it was (everything it stored is reused). A pause
 * never fails the job for good (the overseer's call, 24 October 2026).
 */
export class HybridPaused extends Data.TaggedError("HybridPaused")<{
  readonly message: string;
  readonly pauseMs: number;
}> {}

/**
 * A job that reached its budget with hunks left: the queue runs it again after a short delay,
 * without counting the attempt, and it carries on from what it stored (the overseer's call, 25
 * October 2026). Keyword fallback at a review then only means "not ready yet".
 */
export class HybridContinues extends Data.TaggedError("HybridContinues")<{
  readonly message: string;
  readonly pauseMs: number;
  readonly left: number;
}> {}

/** Long enough for the queue to take commit preparation and capture first. */
export const CONTINUE_DELAY_MS = 5_000;

export const FIRST_PAUSE_MS = 2 * 60_000;
export const LONGEST_PAUSE_MS = 30 * 60_000;

/** The next pause: 2 minutes after a run that did not pause, then doubling, at most 30. */
export const nextPauseMs = (
  lastError: {
    readonly tag: string;
    readonly detail?: unknown;
  } | null,
) => {
  const previous =
    lastError?.tag === "HybridPaused"
      ? Number((lastError.detail as { pauseMs?: unknown } | undefined)?.pauseMs)
      : Number.NaN;
  return Number.isFinite(previous) && previous > 0
    ? Math.min(previous * 2, LONGEST_PAUSE_MS)
    : FIRST_PAUSE_MS;
};

/** Graph's pool answer at its full depth, waiting for the whole answer (background work). */
export const graphPoolFor =
  (
    repository: string,
    config: HybridConfig,
    runtime: GraphRuntime,
  ): ((index: TreeIndex, commit: string) => GraphPool) =>
  (index, commit) =>
  (query) =>
    Effect.map(
      Effect.result(
        graphRetriever(
          repository,
          index,
          commit,
          config.members.graph,
          runtime,
          GRAPH_WHOLE_ANSWER,
        ).search({ ...query, limit: GRAPH_TOP_K }),
      ),
      (result) =>
        result._tag === "Success"
          ? { kind: "answered" as const, results: result.success.results }
          : {
              kind:
                result.failure instanceof GraphPending
                  ? ("timeout" as const)
                  : ("failed" as const),
              reason: String(
                (result.failure as { message?: unknown }).message ??
                  result.failure,
              ).slice(0, 300),
            },
    );

const missingChunks = (index: TreeIndex, vectors: LocalTreeVectors) =>
  vectors.missingDocs.map((doc) => index.chunks[doc]!);

/** One commit's hybrid preparation (the job's work, behind the gate). */
export const prepareHybrid = (
  environment: HybridEnvironment,
  commit: {
    readonly oid: string;
    readonly parents: ReadonlyArray<string>;
    readonly tree: string;
  },
) =>
  Effect.gen(function* () {
    const source = captureOutlineSource();
    const { repository, config, workers } = environment;
    const cap = environment.encodeCap ?? HYBRID_ENCODE_CAP;
    const budget = environment.budgetMs ?? HYBRID_BUDGET_MS;
    const device = config.reranker.runner.device;
    const started = yield* Clock.currentTimeMillis;
    const parent = commit.parents[0];
    const none = { computed: 0, reused: 0, failed: 0, deferred: 0 };
    if (parent === undefined)
      return {
        status: "root",
        encoded: { parent: 0, commit: 0 },
        leads: none,
      } satisfies HybridReport;
    const fromTree = yield* treeOf(repository, parent);
    const hunks = (yield* commitHunks(
      repository,
      fromTree,
      commit.tree,
      source,
    )).value.hunks;
    const { index } = yield* indexOf(repository, fromTree, source);
    // 1. The parent tree's vectors: completed when only a commit or two's chunks are missing.
    let vectors = yield* localTreeVectors(index, device);
    let encodedParent = 0;
    if (vectors.missing > cap)
      return {
        status: "not-ready",
        reason: `the parent tree ${fromTree.slice(0, 12)} has ${vectors.missing} of ${index.chunks.length} chunks without a vector: its first pass over the whole tree has not run`,
        encoded: { parent: 0, commit: 0 },
        leads: none,
      } satisfies HybridReport;
    if (vectors.missing > 0) {
      encodedParent = (yield* encodeChunks(
        repository,
        missingChunks(index, vectors),
        workers.encoder,
      )).encoded;
      vectors = yield* localTreeVectors(index, device);
      if (vectors.missing > 0)
        return {
          status: "not-ready",
          reason: `${vectors.missing} chunk(s) of the parent tree could not be read back to encode`,
          encoded: { parent: encodedParent, commit: 0 },
          leads: none,
        } satisfies HybridReport;
    }
    const wanted = hunks
      .filter((hunk) => hunk.query !== null)
      .slice(0, MAX_LEAD_HUNKS);
    const counts = { computed: 0, reused: 0, failed: 0, deferred: 0 };
    const elapsed = () =>
      Effect.map(Clock.currentTimeMillis, (now) => now - started);
    // 2. While the encoder is up: the commit's own changed chunks (so the next commit's parent is
    // ready) and every hunk's query vector, on the same process (one E0 process).
    let encodedCommit = 0;
    const changed = new Set(
      hunks.flatMap((hunk) => (hunk.newOid === null ? [] : [hunk.newOid])),
    );
    // Within the budget, as before: past it, the next commit's job completes its parent.
    if ((yield* elapsed()) <= budget) {
      const { index: next } = yield* indexOf(repository, commit.tree, source);
      const pending = (yield* missingAmong(
        next.chunks.filter((chunk) => changed.has(chunk.blobOid)),
        device,
      )).slice(0, cap);
      if (pending.length > 0)
        encodedCommit = (yield* encodeChunks(
          repository,
          pending,
          workers.encoder,
        )).encoded;
    }
    const queryVectorOf: HybridParts["queryVector"] =
      environment.queryVector ??
      ((text) =>
        Effect.map(
          queryVector(
            config.members.e0,
            environment.e0,
            text,
            workers.encodeQuery,
          ),
          (encoded) => ({
            vector: encoded.vector,
            cut: encoded.cut,
            encoded: encoded.encoded,
          }),
        ));
    const unencoded = new Set<string>();
    let queried = 0;
    yield* Effect.forEach(
      wanted,
      (hunk) =>
        Effect.gen(function* () {
          // A hunk whose leads are stored needs no query vector.
          if (
            (yield* cachedLeads(hunk, config, indexRecipe(source)))._tag ===
            "Some"
          )
            return;
          const result = yield* Effect.result(queryVectorOf(hunk.query!.text));
          if (result._tag === "Failure") unencoded.add(hunk.hunkId);
          else if (result.success.encoded === true) queried++;
        }),
      { discard: true },
    ).pipe(
      Effect.withSpan("harness.hybrid.queries", {
        attributes: { "harness.hunks": wanted.length },
      }),
    );
    // 3. Within the resident limit, the encoder closes before the reranker starts.
    const models = environment.models ?? 2;
    if (models < 2 && workers.releaseEncoder !== undefined)
      yield* workers.releaseEncoder();
    // 4. Each hunk's leads: one at a time under a one-model limit, none started past the budget,
    // and none while free disk or swap is past its limit (the job pauses, disclosed and resumed).
    const parts: HybridParts = {
      vectors,
      queryVector: queryVectorOf,
      graph: (
        environment.graphPool ??
        graphPoolFor(repository, config, environment.graph)
      )(index, parent),
      reranker: workers.reranker,
    };
    const retriever = hybridRetriever(repository, index, config, parts);
    const limits = environment.limits;
    const readNow =
      environment.resources ??
      (() =>
        environment.storeDirectory === undefined
          ? {}
          : readResources(environment.storeDirectory));
    const now = yield* spanClock;
    const span = Option.getOrUndefined(
      yield* Effect.option(Effect.currentSpan),
    );
    let paused: string | undefined;
    let checks = 0;
    let outOfBudget = 0;
    yield* Effect.forEach(
      wanted,
      (hunk) =>
        Effect.gen(function* () {
          if (paused !== undefined) {
            counts.deferred++;
            return;
          }
          if ((yield* elapsed()) > budget) {
            counts.deferred++;
            outOfBudget++;
            return;
          }
          if (unencoded.has(hunk.hunkId)) {
            counts.failed++;
            return;
          }
          if (limits !== undefined) {
            const resources = readNow();
            checks++;
            const over = overLimits(resources, limits);
            span?.event("harness.hybrid.resources.check", now(), {
              ...(resources.freeBytes === undefined
                ? {}
                : { "harness.hybrid.free_bytes": resources.freeBytes }),
              ...(resources.swapUsedBytes === undefined
                ? {}
                : {
                    "harness.hybrid.swap_used_bytes": resources.swapUsedBytes,
                  }),
              ...(over === undefined ? {} : { "harness.hybrid.paused": over }),
            });
            if (over !== undefined) {
              paused = over;
              counts.deferred++;
              return;
            }
          }
          // A hunk that fails is left to the review's keyword fallback; nothing is stored for it.
          const outcome = yield* Effect.result(hunkLeads(hunk, retriever));
          if (outcome._tag === "Failure") {
            counts.failed++;
            yield* Effect.logWarning(
              `commit.hybrid ${commit.oid.slice(0, 12)} hunk ${hunk.hunkId}: ${String((outcome.failure as { message?: unknown }).message ?? outcome.failure).slice(0, 300)}`,
            );
          } else if (outcome.success?.status === "computed") counts.computed++;
          else if (outcome.success !== undefined) counts.reused++;
        }),
      {
        concurrency: models < 2 ? 1 : HYBRID_HUNK_CONCURRENCY,
        discard: true,
      },
    );
    yield* Effect.annotateCurrentSpan({
      "harness.hybrid.models": models,
      "harness.hybrid.resources.checks": checks,
    });
    if (paused !== undefined)
      return {
        status: "paused",
        reason: paused,
        encoded: { parent: encodedParent, commit: encodedCommit },
        leads: counts,
      } satisfies HybridReport;
    // Out of budget with hunks left: carry on in the next run, as long as this one moved forward
    // (a run that stored nothing would only repeat itself).
    const progressed =
      counts.computed + encodedParent + encodedCommit + queried > 0;
    if (outOfBudget > 0 && progressed) {
      span?.event("harness.hybrid.continued", now(), {
        "harness.hybrid.left": outOfBudget,
      });
      return {
        status: "continues",
        left: outOfBudget,
        encoded: { parent: encodedParent, commit: encodedCommit },
        leads: counts,
      } satisfies HybridReport;
    }
    // The next commit's job searches this commit as its parent: Graph prepares it now, in the
    // background, after this run's own searches (a preparation holds Graph's one query slot).
    // Only on a run that finishes: never on a pause, when the machine is short, nor before a
    // continuation, whose own next run would wait behind it. Never waited on past a moment, never
    // failing the job. Graph keeps one preparation per commit, so a second ask joins or finds it ready.
    yield* Effect.annotateCurrentSpan({
      "harness.hybrid.next_base": yield* prepareNextBase(
        environment,
        commit.oid,
      ),
    });
    return {
      status: "prepared",
      encoded: { parent: encodedParent, commit: encodedCommit },
      leads: counts,
    } satisfies HybridReport;
  }).pipe(
    Effect.tap((report) =>
      Effect.annotateCurrentSpan({
        "harness.hybrid.status": report.status,
        "harness.hybrid.encoded.parent": report.encoded.parent,
        "harness.hybrid.encoded.commit": report.encoded.commit,
        "harness.leads.computed": report.leads.computed,
        "harness.leads.reused": report.leads.reused,
        "harness.leads.failed": report.leads.failed,
        "harness.leads.deferred": report.leads.deferred,
        ...(report.left === undefined
          ? {}
          : { "harness.hybrid.left": report.left }),
      }),
    ),
    Effect.withSpan("harness.commit.hybrid", {
      attributes: { "harness.commit": commit.oid },
    }),
  );

/** How long a job waits to learn whether the next base was already prepared. */
const NEXT_BASE_GLANCE_MS = 1_000;

/**
 * Starts Graph's preparation of `commit` and says what happened: `already-prepared` (Graph had
 * it), `ready` (prepared within a moment), `started` (still preparing, in the background) or
 * `failed`. The preparation keeps running past the job either way.
 */
export const prepareNextBase = (
  environment: HybridEnvironment,
  commit: string,
) =>
  Effect.gen(function* () {
    const prepare =
      environment.prepareNext ??
      ((oid: string) =>
        prepareBase(
          environment.repository,
          oid,
          environment.graph,
          environment.config.members.graph.engine.sha256,
          // Nobody waits on the next base yet: it never goes ahead of a search.
          () => false,
        ));
    const fiber = yield* Effect.forkDetach(Effect.result(prepare(commit)));
    const glance = yield* Fiber.await(fiber).pipe(
      Effect.timeoutOption(NEXT_BASE_GLANCE_MS),
    );
    if (Option.isNone(glance)) return "started";
    const exit = glance.value;
    if (exit._tag !== "Success" || exit.value._tag === "Failure")
      return "failed";
    const prepared = exit.value.success;
    return !prepared.made || prepared.cache === "hit"
      ? "already-prepared"
      : "ready";
  }).pipe(Effect.catchCause(() => Effect.succeed("failed")));

/** The hybrid setup the settings give this machine, or why there is none (or it is off). */
export const hybridSetup = (storeDirectory: string) =>
  Effect.gen(function* () {
    const settings = yield* Effect.try(() => readSettings());
    const runtime = searchRuntimeFrom(settings, storeDirectory);
    const hybrid: HybridRuntime | undefined = runtime.hybrid;
    if (hybrid === undefined)
      return {
        kind: "unavailable" as const,
        reason:
          runtime.problems["hybrid"] ??
          "no search.hybrid in the Neuve settings",
      };
    const graph = yield* graphConfigFor(hybrid.graph);
    return {
      kind: "ready" as const,
      prepare: hybrid.prepare,
      runtime: hybrid,
      e0: hybrid.e0,
      graph: hybrid.graph,
      config: hybridConfigFor(hybrid, graph),
    };
  });

/**
 * Enqueues a prepared commit's hybrid job, only while hybrid preparation is on in the settings.
 * Never fails: a commit's preparation does not depend on it (the overseer's condition).
 */
export const enqueueHybrid = (commit: {
  readonly oid: string;
  readonly parents: ReadonlyArray<string>;
  readonly tree: string;
}) =>
  Effect.gen(function* () {
    const settings = yield* Effect.try(() => readSettings());
    if (Option.getOrUndefined(settings)?.search?.hybrid?.prepare !== true)
      return false;
    yield* JobQueue.JobQueue.use((queue) =>
      queue.enqueue({
        kind: "commit.hybrid",
        dedupeKey: `commit.hybrid:${commit.oid}`,
        payload: CommitHybridPayload.parse({
          oid: commit.oid,
          tree: commit.tree,
          parents: [...commit.parents],
        }),
      }),
    ).pipe(Effect.provide(JobQueue.layer));
    return true;
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.as(
        Effect.logWarning(
          `commit.hybrid for ${commit.oid.slice(0, 12)} not enqueued: ${String(cause).slice(0, 300)}`,
        ),
        false,
      ),
    ),
  );

/**
 * The worker's `commit.hybrid` handler. `workers` gives the worker's model processes, started on
 * first need; a job that finds hybrid preparation off ends at once and does nothing.
 */
export const commitHybridHandler =
  (options: {
    readonly repository: string;
    readonly storeDirectory: string;
    readonly workers: (setup: {
      readonly runtime: HybridRuntime;
      readonly e0: E0Runtime;
    }) => Effect.Effect<HybridWorkers, HybridUnavailable>;
  }): Worker.JobHandler =>
  (job) =>
    Effect.gen(function* () {
      const commit = readData(CommitHybridPayload, job.payload);
      const setup = yield* hybridSetup(options.storeDirectory);
      if (setup.kind !== "ready" || !setup.prepare) {
        yield* Effect.logInfo(
          `commit.hybrid ${commit.oid.slice(0, 12)}: skipped (${setup.kind === "ready" ? "search.hybrid.prepare is off" : setup.reason})`,
        );
        return;
      }
      const work = yield* Worker.HeavyWork;
      const log = openHybridLog(options.storeDirectory, `commit-${commit.oid}`);
      const queuedMs = Date.now() - Date.parse(job.enqueuedAt);
      const outcome = yield* withHybridLog(
        log,
        Effect.gen(function* () {
          const workers = yield* Effect.result(
            options.workers({ runtime: setup.runtime, e0: setup.e0 }),
          );
          // Without its model processes the job cannot do anything a retry would change.
          if (workers._tag === "Failure") return workers;
          const cpu = {
            worker: process.cpuUsage(),
            models: workers.success.cpuSeconds?.(),
          };
          // Resident work may continue; encoder and reranker starts gate their actual process creation.
          const report = yield* work.start(
            prepareHybrid(
              {
                repository: options.repository,
                config: setup.config,
                e0: setup.e0,
                graph: setup.graph,
                workers: workers.success,
                models: setup.runtime.models,
                limits: setup.runtime.limits,
                storeDirectory: options.storeDirectory,
              },
              commit,
            ),
          );
          const used = process.cpuUsage(cpu.worker);
          const models = workers.success.cpuSeconds?.();
          yield* Effect.annotateCurrentSpan({
            "harness.hybrid.job.queue_wait_ms": queuedMs,
            "harness.hybrid.job.attempt": job.attempts,
            "harness.hybrid.job.cpu_seconds": (used.user + used.system) / 1e6,
            ...(models === undefined || cpu.models === undefined
              ? {}
              : { "harness.hybrid.models.cpu_seconds": models - cpu.models }),
          });
          return { _tag: "Success" as const, success: report };
        }).pipe(Effect.withSpan("harness.commit.hybrid.job")),
      );
      if (outcome._tag === "Failure") {
        yield* Effect.logWarning(
          `commit.hybrid ${commit.oid.slice(0, 12)}: no model processes (${outcome.failure.message}); its hunks fall back to keyword leads`,
        );
        return;
      }
      const report = outcome.success;
      log.write({ type: "hybrid.report", commit: commit.oid, ...report });
      // Out of budget: requeued shortly, behind commit preparation and capture (priorities 1 and
      // 2 in the background slot; reviews have their own), without the attempt counting.
      if (report.status === "continues")
        return yield* new HybridContinues({
          message: `commit.hybrid ${commit.oid.slice(0, 12)} reached its ${Math.round(HYBRID_BUDGET_MS / 60_000)}-minute budget with ${report.left} hunk(s) left; it carries on in ${CONTINUE_DELAY_MS / 1000} s`,
          pauseMs: CONTINUE_DELAY_MS,
          left: report.left ?? 0,
        });
      // Paused on the machine's limits: the queue retries later, and stored leads are reused.
      if (report.status === "paused") {
        const pauseMs = nextPauseMs(job.lastError);
        return yield* new HybridPaused({
          message: `commit.hybrid ${commit.oid.slice(0, 12)} paused before ${report.leads.deferred} hunk(s): ${report.reason}; it runs again in ${Math.round(pauseMs / 60_000)} min`,
          pauseMs,
        });
      }
      yield* Effect.logInfo(
        `commit.hybrid ${commit.oid.slice(0, 12)}: ${report.status}${report.reason === undefined ? "" : ` (${report.reason})`}; encoded ${report.encoded.parent} parent and ${report.encoded.commit} commit chunk(s); leads ${report.leads.computed} computed, ${report.leads.reused} reused${report.leads.failed > 0 ? `, ${report.leads.failed} failed` : ""}${report.leads.deferred > 0 ? `, ${report.leads.deferred} left for the review's fallback` : ""}; log ${log.path}`,
      );
    }).pipe((work) =>
      cpuJob({ class: "preparation", position: "new", stage: 0 }, work),
    );

/**
 * The first pass over a tree (`neuve hybrid prepare`): every chunk without a vector or a refusal
 * is encoded, a slice at a time, each stored as it lands, so a stopped pass resumes where it was.
 * Run only in a measured slot: it is the heavy one (Neuve's base is about 26,000 chunks).
 */
export const prepareTreeVectors = (
  repository: string,
  revision: string,
  encoder: ChunkEncoder,
  progress: (done: number, total: number) => Effect.Effect<void> = () =>
    Effect.void,
) =>
  Effect.gen(function* () {
    const source = captureOutlineSource();
    const tree = yield* treeOf(repository, revision);
    const { index } = yield* indexOf(repository, tree, source);
    const before = yield* localTreeVectors(index, encoder.device);
    const missing = missingChunks(index, before);
    const SLICE = 256;
    let encoded = 0;
    let refused = 0;
    let unreadable = 0;
    for (let at = 0; at < missing.length; at += SLICE) {
      const report = yield* encodeChunks(
        repository,
        missing.slice(at, at + SLICE),
        encoder,
      );
      encoded += report.encoded;
      refused += report.refused;
      unreadable += report.unreadable;
      yield* progress(Math.min(at + SLICE, missing.length), missing.length);
    }
    const after = yield* localTreeVectors(index, encoder.device);
    return {
      tree,
      chunks: index.chunks.length,
      before: { withVectors: before.docs.length, missing: before.missing },
      encoded,
      refused,
      unreadable,
      after: {
        withVectors: after.docs.length,
        refused: after.refused.length,
        missing: after.missing,
      },
    };
  }).pipe(
    Effect.tap((report) =>
      Effect.annotateCurrentSpan({
        "harness.tree": report.tree,
        "harness.chunks": report.chunks,
        "harness.hybrid.encoded": report.encoded,
        "harness.hybrid.refused": report.refused,
        "harness.hybrid.missing": report.after.missing,
      }),
    ),
    Effect.withSpan("harness.hybrid.first-pass", {
      attributes: {
        "harness.revision": revision,
        "harness.device": encoder.device,
      },
    }),
  );

/**
 * How many of a range's commits (merge base to head) still have a `commit.hybrid` job waiting,
 * delayed or running: hunks of those commits may get keyword leads in a review requested now. A
 * measured hybrid review is requested only once this is zero (the overseer's call, 24 October
 * 2026); the request prints it and the review's Precompute span records it.
 */
export const pendingHybrid = (
  repository: string,
  range: { readonly baseOid: string; readonly headOid: string },
) =>
  Effect.gen(function* () {
    const merge = yield* mergeBase(repository, range.baseOid, range.headOid);
    const commits = new Set(
      (yield* git(repository, ["rev-list", `${merge}..${range.headOid}`]))
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== ""),
    );
    const open = yield* JobQueue.JobQueue.use((queue) =>
      queue.list({ states: ["waiting", "delayed", "active"], limit: 10_000 }),
    ).pipe(Effect.provide(JobQueue.layer));
    const prefix = "commit.hybrid:";
    const pending = open.filter(
      (job) =>
        job.kind === "commit.hybrid" &&
        job.dedupeKey.startsWith(prefix) &&
        commits.has(job.dedupeKey.slice(prefix.length)),
    ).length;
    return { commits: commits.size, pending };
  });
