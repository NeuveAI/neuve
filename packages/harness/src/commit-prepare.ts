import type { OutlineSource } from "./graph-outline.ts";
import { captureOutlineSource } from "./graph-outline.ts";
import { readData } from "@neuve/records-core";
import { KeyHeld } from "@neuve/records-core/shared-work";
import { InsideSharedWorkGrant } from "@neuve/records-core/shared-work-effect";
import { acquireGrant } from "./budget/acquire.ts";
import { cpuJob } from "./budget/cpu.ts";
import { jobBudget, cpuChildSettings } from "./budget/local.ts";
import { availableParallelism } from "node:os";
import { timePrecomputeItem } from "./telemetry.ts";
import {
  CodeWork,
  codeCheckpoint,
  reviewPrecomputeActive,
  withCodeWork,
} from "./code-work.ts";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { stopHeavyChild, workerParentArgs } from "./heavy-child.ts";
import { getPriority, setPriority } from "node:os";
import { dirname, join } from "node:path";
import { Clock, Data, Effect, Exit, Option, Result } from "effect";
import { z } from "zod";
import { PreparationPayload } from "@neuve/records-schema";
import {
  type StoreLocation,
  Computations,
  Log,
  Worker,
  Store,
  Starter,
  JobQueue,
  resolveStoreLocation,
  storeLocationIn,
} from "@neuve/records-core";
import { refreshOnCommit } from "./stack/handler.ts";
import { enqueueHybrid } from "./commit-hybrid.ts";
import { ChangeFact, changeFacts } from "./change-facts.ts";
import { readDeclarations } from "./declarations.ts";
import { diffTrees, emptyTree, lsTree, treeOf } from "./git-objects.ts";
import { HunkRecord, QUERY_RECIPE } from "./hunks.ts";
import { hunkLeads } from "./leads.ts";
import {
  defaultManifestSettings,
  fileHunks,
  frontManifest,
  rangeManifest,
} from "./manifest.ts";
import { git } from "./git.ts";
import {
  DEFAULT_RETRIEVER,
  bm25RetrieverFor,
  type RetrieverConfig,
} from "./retriever.ts";
import { GRAPH_WHOLE_ANSWER } from "./graph-search.ts";
import { retrieverFor } from "./retrievers.ts";
import {
  resolveSearch,
  searchRuntimeFrom,
  setSearchRuntime,
} from "./search-config.ts";
import { readSettings } from "./settings.ts";
import { indexRecipe, jsonComputation } from "./search-index.ts";
import { defaultBranch } from "./graph-declare.ts";
import {
  relationsComputation,
  relationsGapOf,
  relationsGraphDirectory,
} from "./relations-index.ts";

/**
 * The `commit.prepare` handler (10.20, 10.75, PC13, PC15): code-only work as each commit lands, in
 * the worker's background slot, so a review starts from stored facts. No model work (PC16).
 *
 * 1. The commit's hunks against its first parent, with enclosing symbols, Q1 queries and change
 *    facts, as one computation keyed by the two trees; the chunks of every changed blob are
 *    computed on the way, keyed by blob (the search index's per-blob cache).
 * 2. Each hunk's top leads against the parent tree, keyed by its file's two blobs and query
 *    (`leads.ts`), which is what a later review reuses: from the retriever the user's settings name
 *    for leads, as a review's request resolves it (10.108), when it is BM25 or Graph. Graph's lead
 *    searches are the slow part of a review's preparation, so they are moved here, off the review's
 *    waiting path; within a time budget, so the job ends inside its deadline and leaves the rest to
 *    the review. E0 and frozen leads stay at the review: E0 is model work (PC16) and keyed on the
 *    base's vectors, a frozen candidate's on the range. Reviews subscribe to keys this child
 *    holds. This child is inside one background CPU grant, so it skips any key another caller
 *    holds and leaves the work to that caller.
 * 3. With the section readings on, the Graph relations of the commit and of its merge base with
 *    the default branch (`commitRelations`), the same stored computation a review's relations
 *    task reads, so a first review of the commit finds them stored. Never for a range preparation.
 *
 * Bursts coalesce by tree and blob: every computation is keyed by tree or blob OIDs, so commits of a
 * rebase that share trees, blobs or hunks compute each once, and the queue takes the newest head
 * first (`JOB_POLICIES`). Commits that only differ in their message reuse everything.
 *
 * Nice 10 (10.20, 6.10): both steps run in a child process of the worker, `neuve worker
 * prepare-commit`, started at nice 19 (`cpuChildSettings`); the child refuses to work below nice 10
 * (`requirePreparationPriority`). Only its CPU priority is lowered, so the chunking, parsing and BM25
 * build yield the CPU to the worker's review slot and to the user, not only the git subprocesses.
 * The handler in the worker starts it, relays its log lines, and kills it if the job is interrupted.
 *
 * `commit.prepare@2` discovers commits without recording author attribution. Historical commits
 * prepare their hunks and chunks; the newest range gets the squashed diff's BM25 leads once.
 * These jobs stay in the background position during reviews. They never enqueue model work.
 * They pause at code-work checkpoints while the same store has a review in Precompute. A tree
 * index under construction releases its lease before yielding; the review can also build locally
 * after a short lease wait. Completed indexes are shared through temporary IPC. The machine-wide budget is a separate service.
 */

/** A `commit.prepare` job without its commit's event; no attempt can succeed. */
export class NotACommit extends Data.TaggedError("NotACommit")<{
  readonly message: string;
  readonly retryable: false;
}> {}

/** At most this many hunks of one commit get leads; beyond it the rest wait for the review. */
export const MAX_LEAD_HUNKS = 500;

export const CommitHunks = z.strictObject({
  fromTree: z.string(),
  toTree: z.string(),
  hunks: z.array(HunkRecord),
  facts: z.array(ChangeFact),
});
export type CommitHunks = z.infer<typeof CommitHunks>;

/** The key of a commit's hunks (`commitHunks`). */
export const commitHunksSpec = (
  fromTree: string,
  toTree: string,
  source: OutlineSource,
): Computations.ComputationSpec => ({
  op: "harness.commit-hunks",
  opVersion: 2,
  inputs: { from: `git-tree:${fromTree}`, to: `git-tree:${toTree}` },
  config: { index: indexRecipe(source), query: QUERY_RECIPE } as never,
});

/** Step 1: the hunks of `fromTree..toTree`, their symbols, queries and facts. */
export const commitHunks = (
  repository: string,
  fromTree: string,
  toTree: string,
  source: OutlineSource,
) =>
  jsonComputation(
    commitHunksSpec(fromTree, toTree, source),
    CommitHunks,
    Effect.gen(function* () {
      const files = yield* diffTrees(repository, fromTree, toTree);
      const hunks = yield* fileHunks(repository, files, source);
      const tree = yield* lsTree(repository, toTree);
      const declarations = yield* readDeclarations({
        repository,
        revision: toTree,
        tree,
        paths: [...new Set(hunks.map((hunk) => hunk.path))],
      });
      const lines = hunks.reduce(
        (sum, hunk) => sum + hunk.added + hunk.deleted,
        0,
      );
      return {
        fromTree,
        toTree,
        hunks: [...hunks],
        facts: [...changeFacts(hunks, declarations, lines)],
      } satisfies CommitHunks;
    }),
  );

/** Resolve exactly the settings an ordinary review freezes, without credentials or model calls. */
const commitManifestSettings = (storeDirectory: string | undefined) =>
  Effect.gen(function* () {
    if (storeDirectory === undefined) return defaultManifestSettings(1_000_000);
    // Loaded here for the same module cycle as commitRelations' request import below.
    const { prepareReviewConfig, settingsRoute } = yield* Effect.tryPromise(
      () => import("./request.ts"),
    );
    const config = yield* prepareReviewConfig({
      location: storeLocationIn(dirname(storeDirectory)),
      route: settingsRoute(),
    });
    return config.precompute ?? defaultManifestSettings(config.route.window);
  });

/** The first-parent range a review can read directly, without warming empty or root commits. */
export const prepareCommitManifest = (
  repository: string,
  commit: {
    readonly oid: string;
    readonly parents: ReadonlyArray<string>;
    readonly tree: string;
  },
  source: OutlineSource,
  storeDirectory?: string,
) =>
  Effect.gen(function* () {
    const parent = commit.parents[0];
    if (parent === undefined) return Option.none();
    if ((yield* treeOf(repository, parent)) === commit.tree)
      return Option.none();
    const manifest = yield* frontManifest(
      repository,
      { baseOid: parent, headOid: commit.oid },
      yield* commitManifestSettings(storeDirectory),
      source,
    );
    yield* Effect.logInfo({
      type: "commit.prepare.manifest",
      commit: commit.oid,
      key: manifest.key,
      status: manifest.status,
      hunks: manifest.value.hunks.length,
    });
    return Option.some(manifest);
  });

/**
 * Graph's lead searches stop starting past this much of a preparation, so the job (10 minutes)
 * ends with what it stored even when its last search waits on a base preparation (at most 300 s)
 * and then runs to its own deadline (`GRAPH_SEARCH_DEADLINE_MS`); the review searches the rest.
 */
export const GRAPH_LEADS_BUDGET_MS = 2 * 60_000;
/** After this many Graph lead searches in a row fail, the rest are left to the review. */
export const GRAPH_LEADS_FAILURES = 3;

export interface PrepareOptions {
  readonly repository: string;
  /** The leads retriever; when absent, the one the user's settings name (`storeDirectory`), else BM25. */
  readonly retriever?: RetrieverConfig | undefined;
  /** The Records store's folder, where Graph keeps its clones and snapshots (search-config.ts). */
  readonly storeDirectory?: string | undefined;
}

/**
 * Where this child keeps Graph's clone and views: apart from the worker's (`<store>/graph`).
 * Preparing moves a clone's HEAD, so the worker's review and this child sharing a clone would break
 * each other's preparations. The cache is the store's one Graph cache, the worker's: Graph makes
 * one cache safe for several processes (atomic renames, keyed reads, locks), and the two share its
 * per-file extractions and remembered answers (their snapshots stay apart, keyed by the clone).
 */
export const COMMIT_GRAPH_DIRECTORY = "graph-commit";

/**
 * The leads retriever a review's request would freeze, from the user's settings, with this
 * machine's search runtime set for it; undefined, with the reason logged, when the settings cannot
 * be read or name a retriever this machine cannot serve, as the request would refuse (no BM25
 * under another's name). The hunks are prepared either way.
 */
const settingsLeads = (storeDirectory: string) =>
  Effect.gen(function* () {
    const resolved = yield* Effect.result(
      Effect.gen(function* () {
        const settings = yield* Effect.try(() => readSettings());
        const runtime = searchRuntimeFrom(settings, storeDirectory);
        setSearchRuntime({
          ...runtime,
          ...(runtime.graph === undefined
            ? {}
            : {
                graph: {
                  ...runtime.graph,
                  workDirectory: join(storeDirectory, COMMIT_GRAPH_DIRECTORY),
                  cacheDirectory: join(runtime.graph.workDirectory, "cache"),
                },
              }),
        });
        // The engine's identity, not its folder, is in the key: the same as the review's.
        return (yield* resolveSearch(runtime, settings)).leads;
      }),
    );
    if (resolved._tag === "Success") return resolved.success;
    yield* Effect.logWarning(
      `commit.prepare: no leads: ${String((resolved.failure as { message?: unknown }).message ?? resolved.failure).slice(0, 300)}`,
    );
    return undefined;
  });

/**
 * A relations read starts only within this much of a preparation: then its read (at most graph-
 * client's 300 s snapshot deadline) ends inside the job's 10-minute deadline, after the leads'
 * own budget and a last search's overrun. A read not started is left to the review's own task.
 */
export const RELATIONS_START_BUDGET_MS = 4 * 60_000;

/** How one relations read of the step ended, or why it was not started. */
export type CommitRelationsRead = Readonly<
  | {
      commit: string;
      outcome:
        | "read"
        | "already-stored"
        | "joined"
        | "held"
        | "graph-unavailable"
        | "failed";
      /** The failure's tag (`RelationsReadFailed`'s reason, or the error's tag), never its text. */
      tag: string | null;
      ms: number;
    }
  | { skipped: string }
>;

/** What the step did: nothing with readings off, else the commit's read and its merge base's. */
export type CommitRelations =
  | Readonly<{ readings: false }>
  | Readonly<{
      readings: true;
      commit: CommitRelationsRead;
      mergeBase: CommitRelationsRead;
    }>;

/** A read not started, and why: built as its own shape, never merged with a read's. */
const skippedRead = (skipped: string): CommitRelationsRead => ({ skipped });

/** A read that ran, and how it ended. */
const ranRead = (
  commit: string,
  outcome: Exclude<CommitRelationsRead, { skipped: string }>["outcome"],
  tag: string | null,
  ms: number,
): CommitRelationsRead => ({ commit, outcome, tag, ms });

const describeRead = (read: CommitRelationsRead) => {
  if ("skipped" in read) return `skipped: ${read.skipped}`;
  const at = `${read.commit.slice(0, 12)} `;
  switch (read.outcome) {
    case "read":
      return `${at}read in ${read.ms} ms`;
    case "already-stored":
      return `${at}already stored`;
    case "joined":
      return `${at}joined another caller's read, stored after ${read.ms} ms`;
    case "held":
      return `${at}held by another caller's read; left to it`;
    case "graph-unavailable":
      return `${at}skipped: the Graph engine lacks the exact-commit capability`;
    case "failed":
      return `${at}failed (${read.tag ?? "unknown"}); left to the review`;
  }
};

/**
 * Whether `commit` is still where a review would start from: the tip of a local branch
 * (`for-each-ref --points-at`) or this worktree's `HEAD`. False for an amended or rebased-away
 * commit and for an earlier commit of a quick sequence. Wrong either way costs little: a commit
 * skipped here is read by the review's own task; one read here and never reviewed costs one read.
 */
const isTip = (repository: string, commit: string) =>
  Effect.gen(function* () {
    const branches = yield* git(repository, [
      "for-each-ref",
      `--points-at=${commit}`,
      "--format=%(refname)",
      "refs/heads/",
    ]);
    if (branches.trim() !== "") return true;
    const head = yield* git(repository, [
      "rev-parse",
      "--verify",
      "--quiet",
      "HEAD",
    ]).pipe(Effect.orElseSucceed(() => ""));
    return head.trim() === commit;
  });

/**
 * The commit's one merge base with the default branch (`defaultBranch`, the rule the worker
 * declares active branches' bases by), from local refs only, or why there is none to read: no
 * default branch known, no common history, several merge bases, or the commit itself (a commit on
 * the default branch, whose review base is not known here).
 */
type MergeBase = Readonly<{ skipped: string } | { base: string }>;
const noMergeBase = (skipped: string): MergeBase => ({ skipped });

const defaultMergeBase = (repository: string, commit: string) =>
  Effect.gen(function* () {
    const target = yield* defaultBranch(repository);
    if (target === undefined) return noMergeBase("no default branch known");
    const bases = (yield* git(repository, [
      "merge-base",
      "--all",
      target,
      commit,
    ]).pipe(Effect.orElseSucceed(() => "")))
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
    if (bases.length === 0) return noMergeBase(`no merge base with ${target}`);
    if (bases.length > 1)
      return noMergeBase(`${bases.length} merge bases with ${target}`);
    const [base = commit] = bases;
    if (base === commit) return noMergeBase(`the commit is on ${target}`);
    const found: MergeBase = { base };
    return found;
  });

/**
 * Step 3, only while the user's settings turn the section readings on (`readingsConfig`, the rule
 * a review's request freezes them by): the relations of the recorded commit and of its merge base
 * with the default branch, so a review of either finds them stored. Each read is
 * `relationsComputation`, the same computation and key as a review's (`relationsSpec`): a review
 * that asks while it runs joins it, one that asks later reads it stored, and one already reading it
 * holds it (this child is inside a grant, so it does not wait: the key is left to that caller).
 *
 * The commit is read only while it is still a branch tip or `HEAD` (`isTip`); the merge base after
 * it, only when there is exactly one other than the commit; each only within
 * `RELATIONS_START_BUDGET_MS` of the preparation's start. The engine reads the store's one Graph
 * clone (`relationsGraphDirectory`, the review's): an exact-commit read never reads its HEAD.
 * A failed read leaves nothing stored and is the review's to read again.
 */
export const commitRelations = (
  input: Readonly<{
    repository: string;
    storeDirectory: string;
    commit: string;
    source: OutlineSource;
    /** When the preparation started (`Clock` milliseconds). */
    started: number;
  }>,
) =>
  Effect.gen(function* () {
    return yield* relationsStep(input).pipe(
      Effect.withSpan("harness.commit.relations", {
        attributes: { "harness.commit": input.commit },
      }),
    );
  }).pipe(
    // Hunks and leads are what the job is for: nothing here fails it, and nothing is stored.
    Effect.catch((error) =>
      Effect.as(
        Effect.logWarning(
          `commit.prepare relations ${input.commit.slice(0, 12)}: skipped: ${String((error as { _tag?: unknown })._tag ?? "error")}`,
        ),
        { readings: false } satisfies CommitRelations as CommitRelations,
      ),
    ),
  );

/** The step's reads, once the readings are known to be on (`commitRelations`). */
const relationsStep = (
  input: Readonly<{
    repository: string;
    storeDirectory: string;
    commit: string;
    source: OutlineSource;
    started: number;
  }>,
) =>
  Effect.gen(function* () {
    const graphDirectory = relationsGraphDirectory({
      directory: input.storeDirectory,
    });
    const within = Effect.map(
      Clock.currentTimeMillis,
      (now) => now - input.started <= RELATIONS_START_BUDGET_MS,
    );
    const read = (commit: string) =>
      Effect.gen(function* () {
        if (!(yield* within))
          return skippedRead(
            `past ${RELATIONS_START_BUDGET_MS / 1000} s of the preparation`,
          );
        const begun = yield* Clock.currentTimeMillis;
        const exit = yield* Effect.exit(
          relationsComputation(
            input.repository,
            commit,
            input.source,
            graphDirectory,
          ),
        );
        const ms = (yield* Clock.currentTimeMillis) - begun;
        if (Exit.isSuccess(exit)) {
          const status = exit.value.read.status;
          return ranRead(
            commit,
            status === "computed"
              ? "read"
              : status === "reused"
                ? "already-stored"
                : "joined",
            null,
            ms,
          );
        }
        const gap = relationsGapOf(exit.cause);
        return ranRead(
          commit,
          gap.tag === "KeyHeld"
            ? "held"
            : gap.gap === "graph-unavailable"
              ? "graph-unavailable"
              : "failed",
          gap.tag,
          ms,
        );
      });
    type Ran = Extract<CommitRelations, { readings: true }>;
    const notRead = (skipped: string): Ran => ({
      readings: true,
      commit: skippedRead(skipped),
      mergeBase: skippedRead("the commit was not read"),
    });
    const done: Ran = !("sha256" in input.source.key)
      ? notRead("no Graph engine")
      : !(yield* isTip(input.repository, input.commit))
        ? notRead("no longer a branch tip nor HEAD")
        : yield* Effect.gen(function* () {
            const commit = yield* read(input.commit);
            const found = yield* defaultMergeBase(
              input.repository,
              input.commit,
            );
            // Asked again after the commit's own read: a newer commit recorded meanwhile waits
            // behind this job in the worker's one background slot, so this commit's is not read.
            const mergeBase =
              "skipped" in found
                ? skippedRead(found.skipped)
                : !(yield* isTip(input.repository, input.commit))
                  ? skippedRead("the commit is no longer a branch tip nor HEAD")
                  : yield* read(found.base);
            const ran: Ran = { readings: true, commit, mergeBase };
            return ran;
          });
    yield* Effect.logInfo(
      `commit.prepare relations ${input.commit.slice(0, 12)}: commit ${describeRead(done.commit)}; merge base ${describeRead(done.mergeBase)}`,
    );
    return done;
  });

/** Prepares one commit by OID; what the handler runs for the job's commit. */
export const prepareCommit = (
  options: PrepareOptions,
  commit: {
    readonly oid: string;
    readonly parents: ReadonlyArray<string>;
    readonly tree: string;
  },
) =>
  Effect.gen(function* () {
    const source = captureOutlineSource();
    const { repository } = options;
    const config =
      options.retriever ??
      (options.storeDirectory === undefined
        ? DEFAULT_RETRIEVER
        : yield* settingsLeads(options.storeDirectory));
    const started = yield* Clock.currentTimeMillis;
    const parent = commit.parents[0];
    const fromTree =
      parent === undefined
        ? yield* emptyTree(repository)
        : yield* treeOf(repository, parent);
    const step1 = yield* commitHunks(
      repository,
      fromTree,
      commit.tree,
      source,
    ).pipe(
      Effect.map(Option.some),
      Effect.catch((error) =>
        error instanceof KeyHeld
          ? Effect.succeed(Option.none())
          : Effect.fail(error),
      ),
    );
    if (Option.isNone(step1)) {
      yield* Effect.logInfo(
        "commit.prepare: hunks held by another caller; skipped",
      );
      return {
        hunks: 0,
        leads: { computed: 0, reused: 0, failed: 0, deferred: 0 },
      };
    }
    const hunks = step1.value.value.hunks;
    yield* prepareCommitManifest(
      repository,
      commit,
      source,
      options.storeDirectory,
    ).pipe(
      Effect.catch((error) =>
        error instanceof KeyHeld ? Effect.void : Effect.fail(error),
      ),
    );
    const queried = hunks.filter((hunk) => hunk.query !== null);
    const wanted = queried.slice(0, MAX_LEAD_HUNKS);
    let leads = { computed: 0, reused: 0, failed: 0, deferred: 0 };
    let index: { chunks: number; cached: boolean; buildMs: number } | undefined;
    // Commit time is code work only (10.75): BM25's and Graph's leads.
    if (
      parent !== undefined &&
      wanted.length > 0 &&
      (config?.id === "bm25" || config?.id === "graph")
    ) {
      const step2 = yield* Effect.gen(function* () {
        const built =
          config.id === "bm25"
            ? yield* bm25RetrieverFor(repository, fromTree, source, config)
            : yield* retrieverFor(
                // Background work waits for Graph's whole answer: nothing waits on it.
                {
                  repository,
                  source,
                  tree: fromTree,
                  commit: parent,
                  graphDeadlineMs: GRAPH_WHOLE_ANSWER,
                },
                config,
              );
        const counts = { computed: 0, reused: 0, failed: 0, deferred: 0 };
        let failing = 0;
        for (const [at, hunk] of wanted.entries()) {
          if (config.id === "graph") {
            const elapsed = (yield* Clock.currentTimeMillis) - started;
            if (
              elapsed > GRAPH_LEADS_BUDGET_MS ||
              failing >= GRAPH_LEADS_FAILURES
            ) {
              counts.deferred = wanted.length - at;
              break;
            }
          }
          // A BM25 failure fails the job, to be retried; a Graph search that fails is left to the
          // review, which discloses it, and nothing is stored for it.
          const searched = hunkLeads(hunk, built.retriever);
          const outcome = yield* searched.pipe(
            Effect.map(Result.succeed),
            Effect.catch((error) =>
              error instanceof KeyHeld
                ? Effect.succeed(Result.succeed(undefined))
                : Effect.fail(error),
            ),
            Effect.catch((error) =>
              config.id === "graph"
                ? Effect.succeed(Result.fail(error))
                : Effect.fail(error),
            ),
          );
          if (outcome._tag === "Failure") {
            counts.failed++;
            failing++;
            continue;
          }
          failing = 0;
          if (outcome.success?.status === "computed") counts.computed++;
          else if (outcome.success !== undefined) counts.reused++;
          yield* Effect.yieldNow;
        }
        yield* Effect.annotateCurrentSpan({
          "harness.retriever": config.id,
          "harness.leads.computed": counts.computed,
          "harness.leads.reused": counts.reused,
          "harness.leads.failed": counts.failed,
          "harness.leads.deferred": counts.deferred,
        });
        return {
          leads: counts,
          index: {
            chunks: built.index.chunks.length,
            cached: built.cached,
            buildMs: built.index.buildMs,
          },
        };
      }).pipe(
        Effect.withSpan("harness.commit.leads"),
        Effect.map(Option.some),
        Effect.catch((error) =>
          error instanceof KeyHeld
            ? Effect.succeed(Option.none())
            : Effect.fail(error),
        ),
      );
      if (Option.isSome(step2)) {
        leads = step2.value.leads;
        index = step2.value.index;
      } else leads.deferred = wanted.length;
    }
    const files = new Set(hunks.map((hunk) => hunk.path)).size;
    yield* Effect.logInfo(
      `commit.prepare ${commit.oid.slice(0, 12)}: ${hunks.length} hunk(s) in ${files} file(s) (${step1.value.status}); ` +
        (parent === undefined
          ? "root commit: no parent index, no leads"
          : `parent index ${fromTree.slice(0, 12)} ${index === undefined ? "not needed" : `${index.cached ? "in memory" : `built in ${index.buildMs} ms`}, ${index.chunks} chunks`}; ${config === undefined ? "no leads" : `${config.id} leads`} ${leads.computed} searched, ${leads.reused} reused${leads.failed > 0 ? `, ${leads.failed} failed` : ""}${leads.deferred > 0 ? `, ${leads.deferred} left for the review` : ""}${queried.length > wanted.length ? `, ${queried.length - wanted.length} hunk(s) past the ${MAX_LEAD_HUNKS}-hunk bound left for the review` : ""}`) +
        `; ${(yield* Clock.currentTimeMillis) - started} ms`,
    );
    // Step 3, after what the job is for: the relations, only with readings on (`commitRelations`).
    // Not reached when the hunks are held, on purpose: their holder is a review, with its relations task.
    if (options.storeDirectory !== undefined)
      yield* commitRelations({
        repository,
        storeDirectory: options.storeDirectory,
        commit: commit.oid,
        source,
        started,
      });
    return { hunks: hunks.length, leads };
  }).pipe(
    (work) => cpuJob({ class: "preparation", position: "new", stage: 0 }, work),
    Effect.withSpan("harness.commit.prepare", {
      attributes: { "harness.commit": commit.oid },
    }),
  );

/** The child process failed; its last lines say why. */
export class CommitPrepareFailed extends Data.TaggedError(
  "CommitPrepareFailed",
)<{
  readonly message: string;
}> {}

export interface HandlerOptions {
  readonly repository: string;
  /** The command that runs the CLI, such as `[execPath]` or `[bun, cli.ts]`. */
  readonly command: ReadonlyArray<string>;
  readonly location?: StoreLocation;
}

/** The child's arguments for one commit: `neuve worker prepare-commit`. */
export const prepareCommitArgs = (
  repository: string,
  commit: {
    readonly oid: string;
    readonly parents: ReadonlyArray<string>;
    readonly tree: string;
  },
) => [
  "worker",
  "prepare-commit",
  "--repo",
  repository,
  "--oid",
  commit.oid,
  "--tree",
  commit.tree,
  ...commit.parents.flatMap((parent) => ["--parent", parent]),
  ...workerParentArgs(),
];

/** Starts the child at nice 19, relays its output as log lines, and kills it on interruption. */
export const runPreparationChild = (
  options: HandlerOptions,
  args: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const location =
      options.location ?? (yield* resolveStoreLocation(options.repository));
    const gate = yield* Worker.HeavyWork;
    const budget = yield* jobBudget;
    // Stopping the child is required finalization: a worker leaving for any reason waits for it.
    yield* (yield* Worker.HandlerLifetime).retain;
    const priority = {
      class: "preparation",
      position: "new",
      stage: 0,
    } as const;
    for (;;) {
      // A stopped child has released every CPU grant before this wait or the next admission.
      yield* codeCheckpoint.pipe(
        Effect.provideService(CodeWork, {
          directory: location.directory,
          background: true,
        }),
      );
      const lines: Array<string> = [];
      const outcome = yield* Effect.scoped(
        Effect.gen(function* () {
          const child = yield* gate
            .child(
              Effect.acquireRelease(
                acquireGrant(
                  budget,
                  {
                    owner: "commit.prepare",
                    priority,
                    resource: { kind: "cpu", permits: availableParallelism() },
                  },
                  (signal) =>
                    new Promise<void>((resolve, reject) => {
                      const timer = setTimeout(done, 1000);
                      function done() {
                        signal.removeEventListener("abort", abort);
                        resolve();
                      }
                      function abort() {
                        clearTimeout(timer);
                        signal.removeEventListener("abort", abort);
                        reject(signal.reason);
                      }
                      signal.addEventListener("abort", abort, { once: true });
                      if (signal.aborted) abort();
                    }),
                ),
                (grant) =>
                  Effect.promise(async () => {
                    await grant.release();
                  }),
              ),
              (grant) => {
                const settings = cpuChildSettings(grant, priority);
                const child = Bun.spawn(
                  [...settings.prefix, ...options.command, ...args],
                  {
                    stdin: "ignore",
                    stdout: "pipe",
                    stderr: "pipe",
                    env: { ...process.env, ...settings.env },
                    ...(settings.descriptor === undefined
                      ? {}
                      : {
                          stdio: [
                            "ignore",
                            "pipe",
                            "pipe",
                            settings.descriptor,
                          ] as const,
                        }),
                  },
                );
                const stop = () => {
                  void stopHeavyChild(child);
                };
                grant.signal?.addEventListener("abort", stop, { once: true });
                if (grant.signal?.aborted) stop();
                void child.exited.finally(() =>
                  grant.signal?.removeEventListener("abort", stop),
                );
                return child;
              },
              (child) => Effect.promise(() => stopHeavyChild(child)),
            )
            .pipe(
              Effect.catchDefect((cause) =>
                Effect.fail(
                  new CommitPrepareFailed({
                    message: `could not run the preparation: ${String(cause).slice(0, 300)}`,
                  }),
                ),
              ),
            );
          const completed = Effect.tryPromise({
            try: async () => {
              const collect = async (stream: ReadableStream<Uint8Array>) => {
                for (const part of (await new Response(stream).text()).split(
                  "\n",
                ))
                  if (part.trim() !== "") lines.push(part);
              };
              await Promise.all([collect(child.stdout), collect(child.stderr)]);
              return child.exited;
            },
            catch: (cause) =>
              new CommitPrepareFailed({
                message: `could not run the preparation: ${String(cause).slice(0, 300)}`,
              }),
          });
          const reviewStarted = Effect.gen(function* () {
            while (!reviewPrecomputeActive(location.directory))
              yield* Effect.sleep(25);
            return { kind: "yielded" } as const;
          });
          return yield* Effect.raceFirst(
            Effect.map(
              completed,
              (exitCode) => ({ kind: "exited", exitCode }) as const,
            ),
            reviewStarted,
          );
        }),
      );
      for (const line of lines.slice(-20))
        yield* Effect.logInfo(`commit.prepare child: ${line.slice(0, 600)}`);
      if (outcome.kind === "yielded") continue;
      if (outcome.exitCode !== 0)
        return yield* new CommitPrepareFailed({
          message: `exited ${outcome.exitCode}: ${lines.slice(-3).join(" | ").slice(0, 500)}`,
        });
      return;
    }
  });

/** Ten seconds is a starting allowance for optional historical warming after a head change:
 * keep catch-up bursts short while ordinary small branches can still warm commit facts. Larger
 * histories always get the range facts. This is an engineering choice, not a measured optimum.
 * At the measured 420 commits / 71.325 s, floor(420 * 10 / 71.325) gives 58 commits.
 * This bounds job count, not elapsed time. */
export const MAX_PREPARED_COMMITS = 58;

const enqueueDiscoveredCommits = (records: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const queue = yield* JobQueue.JobQueue;
    let queued = 0;
    for (const record of records) {
      const [oid, tree, parents] = record.trim().split("\0");
      if (!oid || !tree) continue;
      const result = yield* queue.enqueue({
        kind: "commit.prepare@2",
        dedupeKey: `commit.prepare@2:commit:${oid}`,
        payload: {
          kind: "commit",
          commit: { oid, tree, parents: parents ? parents.split(" ") : [] },
        },
      });
      if (result.status === "enqueued") queued++;
    }
    return queued;
  });

/** Discover commits without hooks, without changing commit or author attribution. */
export const enqueueRangePreparation = (
  repository: string,
  range: { readonly baseOid: string; readonly headOid: string },
) =>
  Effect.gen(function* () {
    const output = yield* git(repository, [
      "log",
      `--max-count=${MAX_PREPARED_COMMITS + 1}`,
      "--reverse",
      "--format=%H%x00%T%x00%P%x1e",
      `${range.baseOid}..${range.headOid}`,
    ]);
    const queue = yield* JobQueue.JobQueue;
    const records = output
      .split("\x1e")
      .filter((record) => record.trim() !== "");
    if (records.length > MAX_PREPARED_COMMITS)
      yield* Effect.logInfo(
        `commit.prepare: history exceeds ${MAX_PREPARED_COMMITS}-commit cap; preparing range facts only (${range.baseOid}..${range.headOid})`,
      );
    const queued = yield* enqueueDiscoveredCommits(
      records.length > MAX_PREPARED_COMMITS ? [] : records,
    );
    yield* queue.enqueue({
      kind: "commit.prepare@2",
      dedupeKey: `commit.prepare@2:range:${range.baseOid}:${range.headOid}`,
      payload: {
        kind: "range",
        range: { baseOid: range.baseOid, headOid: range.headOid },
      },
    });
    return queued;
  }).pipe(Effect.provide(JobQueue.layer));

/** The host uses the same queue and worker as admission, without installing hooks. */
export const requestRangePreparation = async (
  repository: string,
  range: { readonly baseOid: string; readonly headOid: string },
): Promise<number> => {
  return Effect.runPromise(
    Effect.gen(function* () {
      const location = yield* resolveStoreLocation(repository);
      yield* Effect.andThen(
        Store.prepareForWrite,
        enqueueRangePreparation(repository, range),
      ).pipe(
        Effect.provide(JobQueue.layer),
        Effect.provide(Store.layer(location, { create: true })),
      );
      const command = Bun.main.startsWith("/$bunfs/")
        ? [process.execPath]
        : [
            process.execPath,
            ...Starter.sourceRunFlags(),
            join(import.meta.dir, "../../../apps/neuve-cli/src/cli.ts"),
          ];
      yield* Starter.ensureWorkerAt(location, { repository, command });
      return yield* Effect.gen(function* () {
        const queue = yield* JobQueue.JobQueue;
        const held = yield* queue.enqueue({
          kind: "commit.prepare@2",
          dedupeKey: `commit.prepare@2:range:${range.baseOid}:${range.headOid}`,
          // Only the fields the payload schema declares, as enqueueRangePreparation sends.
          payload: {
            kind: "range",
            range: { baseOid: range.baseOid, headOid: range.headOid },
          },
        });
        return held.job.seq;
      }).pipe(
        Effect.provide(JobQueue.layer),
        Effect.provide(Store.layer(location, { create: true })),
      );
    }).pipe(Effect.provide(BunFileSystem.layer)),
  );
};

/** The worker's `commit.prepare` handler for one repository. */
export const commitPrepareHandler =
  (options: HandlerOptions): Worker.JobHandler =>
  (job) =>
    Effect.gen(function* () {
      const stored =
        job.eventId === null ? Option.none() : yield* Log.get(job.eventId);
      const event = Option.getOrUndefined(stored)?.event;
      if (job.kind === "commit.prepare@2") {
        if (event?.kind === "commit.rewritten@1") {
          const replacements = [
            ...new Set(event.payload.mappings.map(({ to }) => to)),
          ];
          const output = yield* git(options.repository, [
            "log",
            "--no-walk",
            "--format=%H%x00%T%x00%P%x1e",
            ...replacements,
          ]);
          yield* enqueueDiscoveredCommits(
            output.split("\x1e").filter((record) => record.trim() !== ""),
          ).pipe(Effect.provide(JobQueue.layer));
          return;
        }
        if (event?.kind === "review.requested@1") {
          yield* enqueueRangePreparation(
            options.repository,
            event.attribution.range,
          );
          return;
        }
        const input = yield* Effect.try(() =>
          readData(PreparationPayload, job.payload),
        );
        const location =
          options.location ?? (yield* resolveStoreLocation(options.repository));
        yield* runPreparationChild(options, [
          "worker",
          "prepare-code",
          "--repo",
          options.repository,
          "--store",
          location.directory,
          "--input",
          JSON.stringify(input),
          ...workerParentArgs(),
        ]);
        return;
      }
      if (event?.kind !== "commit.recorded@1")
        return yield* new NotACommit({
          message: `job ${job.seq} has no commit.recorded@1 event`,
          retryable: false,
        });
      // A commit that changes a declared lockfile refreshes its stack sources (11.15); never fails.
      yield* refreshOnCommit(options.repository, event.payload);
      // The gate is passed before the child starts, holding nothing (see the module comment).
      yield* runPreparationChild(
        options,
        prepareCommitArgs(options.repository, event.payload),
      );
      // The commit's hybrid leads run as their own job (10.118), only while the settings turn
      // hybrid preparation on; enqueueing never fails the preparation.
      yield* enqueueHybrid(event.payload);
    });

/** The private lowered-priority child's code-only entry, also used by executable fixtures. */
export const prepareCode = (
  repository: string,
  location: StoreLocation,
  payload: unknown,
) =>
  withCodeWork(
    location,
    true,
    Effect.gen(function* () {
      yield* Effect.sync(requirePreparationPriority);
      const source = captureOutlineSource();
      const input = yield* Effect.try(() =>
        readData(PreparationPayload, payload),
      );
      yield* codeCheckpoint;
      if (input.kind === "range") {
        return yield* timePrecomputeItem(
          "preparation.range",
          rangeManifest(
            repository,
            input.range,
            defaultManifestSettings(1_000_000),
            source,
          ),
          (result) => result.status,
        ).pipe(Effect.withSpan("harness.preparation.range"));
      }
      const parent = input.commit.parents[0];
      const from =
        parent === undefined
          ? yield* emptyTree(repository)
          : yield* treeOf(repository, parent);
      const hunks = yield* timePrecomputeItem(
        "preparation.commit",
        commitHunks(repository, from, input.commit.tree, source),
        (result) => result.status,
      ).pipe(Effect.withSpan("harness.preparation.commit"));
      yield* prepareCommitManifest(
        repository,
        input.commit,
        source,
        location.directory,
      );
      return hunks;
    }),
  ).pipe(
    (work) => cpuJob({ class: "preparation", position: "new", stage: 0 }, work),
    Effect.provideService(InsideSharedWorkGrant, true),
    Effect.catch((error) =>
      error instanceof KeyHeld
        ? Effect.logInfo("commit.prepare: item held by another caller; skipped")
        : Effect.fail(error),
    ),
    Effect.withSpan("harness.preparation.job"),
  );

/** A restricted OS must refuse preparation rather than silently run CPU work at normal priority. */
export const requirePreparationPriority = () => {
  if (getPriority() < 10) setPriority(10);
  if (getPriority() < 10)
    throw new Error("Code preparation requires nice 10 or lower priority");
};
