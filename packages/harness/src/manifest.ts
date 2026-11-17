import type { OutlineSource } from "./graph-outline.ts";
import { cpuKeyedPool, cpuConcurrency } from "./budget/cpu.ts";
import { timePrecomputeItem } from "./telemetry.ts";
import { codeCheckpoint } from "./code-work.ts";
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Metric,
  Option,
} from "effect";
import { z } from "zod";
import { Computations, sha256Hex } from "@neuve/records-core";
import type { SubmittedBranchReview } from "@neuve/records-schema";
import {
  DecisionRangesError,
  projectSubmittedChangedRanges,
  type AccountingQualification,
  type ChangedRange,
  type SubmittedHunkWithChangedRanges,
} from "@neuve/review-rules";
import { SqlClient } from "effect/sql/SqlClient";
import { ChangeFact, changeFacts } from "./change-facts.ts";
import { pendingHybrid } from "./commit-hybrid.ts";
import {
  DECLARATION_READERS,
  LINGUIST_READER_RECIPE,
  Suggestion,
  readDeclarations,
} from "./declarations.ts";
import {
  diffTrees,
  lsTree,
  mergeBase,
  treeOf,
  type DiffFile,
} from "./git-objects.ts";
import { HunkRecord, QUERY_RECIPE, describeHunks } from "./hunks.ts";
import {
  HunkLeads,
  LeadConcurrency,
  leadsSpec,
  legacyLeadsSpec,
  hunkLeads,
} from "./leads.ts";
import {
  DEFAULT_RETRIEVER,
  Bm25Config,
  RetrieverConfig,
  bm25Retriever,
  type Retriever,
} from "./retriever.ts";
import { GRAPH_WHOLE_ANSWER } from "./graph-search.ts";
import { GRAPH_DEADLINE_MS } from "./search-config.ts";
import { frozenKeyed } from "./frozen.ts";
import { indexOf, retrieverFor } from "./retrievers.ts";
import {
  INDEX_BOUNDS,
  indexRecipe,
  jsonComputation,
  storedOutputs,
} from "./search-index.ts";
import { METRICS, recordLate, step } from "./telemetry.ts";

export interface PrecomputeProgress {
  readonly phase: string;
  readonly files: number;
  readonly hunks: number;
}
export const ManifestProgress = Context.Reference<
  (progress: PrecomputeProgress) => void
>("@neuve/harness/ManifestProgress", { defaultValue: () => () => {} });

/**
 * The range manifest (PC1, PC13, 10.20, 10.22), computed once per range at the review request and
 * stored under its base, head and merge-base OIDs: the range diff's hunks against the merge base,
 * each with its owned ranges and sides from the shared review rules (10.21), its allowance (9.17
 * with the 9.23 floor, over 9.27's review lines), its declared kinds as suggestions (10.23) and its
 * Q1 query; and the change facts as citable facts (10.22). It is what the review's front path reads,
 * keyed by exactly that: no retriever. Each hunk's top leads, and what the base index searched, are
 * the range's leads (`RangeLeads` below), a computation of their own keyed by this manifest and the
 * retriever, which no review step waits for (NEU-148).
 */

/** 9.17's working share, pre-registered at 50% (proposal §2.2): the allowance share. */
export const ALLOWANCE_SHARE = 0.5;
/** 9.23's floor: every hunk gets at least this many tokens. */
export const ALLOWANCE_FLOOR = 4_000;

const Allowance = {
  allowanceShare: z.number().gt(0).max(1),
  allowanceFloor: z.int().min(0),
  /** The route's model window W, which 9.17 multiplies. */
  window: z.int().min(1),
};

/**
 * What the review's front path reads with the range manifest, beside the range and the recipes:
 * the allowance's terms and the BM25 parameters the agents' `search` tool ranks with.
 */
export const FrontSettings = z.strictObject({
  ...Allowance,
  /**
   * The `search` tool's BM25 (lookups.ts): the leads retriever's own when it is BM25, a frozen
   * candidate's fallback, else the default. It is the one part of the leads setting an agent
   * reads, so it is keyed here, through the manifest, and nothing else of it is.
   */
  search: Bm25Config,
});
export type FrontSettings = z.infer<typeof FrontSettings>;

/** What the range's leads depend on, beside the manifest and the index recipe. */
export const LeadSettings = z.strictObject({
  retriever: RetrieverConfig,
  /**
   * How long a round of Graph lead searches is waited for (0013) before a hunk takes the keyword
   * search's leads, set when the leads come from Graph; `GRAPH_DEADLINE_MS` for an older request.
   */
  graphWaitMs: z.int().min(1).max(600_000).optional(),
});
export type LeadSettings = z.infer<typeof LeadSettings>;

/** A request's Precompute settings, as the request freezes them: the allowance's and the leads'. */
export const ManifestSettings = z.strictObject({
  ...Allowance,
  ...LeadSettings.shape,
});
export type ManifestSettings = z.infer<typeof ManifestSettings>;

/** The BM25 the `search` tool ranks with for a leads retriever. */
export const searchRetriever = (leads: RetrieverConfig): Bm25Config =>
  leads.id === "bm25"
    ? leads
    : leads.id === "frozen"
      ? leads.fallback
      : DEFAULT_RETRIEVER;

/** The manifest's settings only, so its key and content never hold the leads' (NEU-148). */
export const frontSettings = (
  settings: ManifestSettings | FrontSettings,
): FrontSettings => ({
  allowanceShare: settings.allowanceShare,
  allowanceFloor: settings.allowanceFloor,
  window: settings.window,
  search:
    "retriever" in settings
      ? searchRetriever(settings.retriever)
      : settings.search,
});

/** The leads' settings only. */
export const leadSettings = (settings: LeadSettings): LeadSettings => ({
  retriever: settings.retriever,
  ...(settings.graphWaitMs === undefined
    ? {}
    : { graphWaitMs: settings.graphWaitMs }),
});

export const defaultManifestSettings = (window: number): ManifestSettings => ({
  retriever: DEFAULT_RETRIEVER,
  allowanceShare: ALLOWANCE_SHARE,
  allowanceFloor: ALLOWANCE_FLOOR,
  window,
});

const OwnedRange = z.strictObject({
  side: z.enum(["old", "new"]),
  startLine: z.int().min(0),
  lineCount: z.int().min(0),
});

export const ManifestHunk = z.strictObject({
  ...HunkRecord.shape,
  /** The changed ranges this hunk owns, with their side, from `@neuve/review-rules`. */
  ownedRanges: z.array(OwnedRange),
  /** The rules' accounting qualifications (binary, metadata, context-only). */
  qualifications: z.array(
    z.strictObject({ kind: z.string(), detail: z.string() }),
  ),
  declared: z.array(Suggestion),
  /** Whether its changed lines count in 9.27's review lines (declared generated files do not). */
  countsTowardReviewLines: z.boolean(),
  allowance: z.strictObject({
    tokens: z.int().min(0),
    /** The exact computed share before the floor, so each hunk can also be measured at it (9.17). */
    exactShare: z.number().min(0),
    floored: z.boolean(),
  }),
});
export type ManifestHunk = z.infer<typeof ManifestHunk>;

/**
 * The side a hunk is anchored on: a text hunk's changed side (old for a hunk that only deletes), and
 * for a hunk with no text lines (a binary or empty file, a mode change) the side its unit owns the
 * whole file on, new unless the file is deleted. Never the old side of an added file.
 */
export const hunkSide = (hunk: ManifestHunk): "old" | "new" =>
  hunk.kind === "text"
    ? hunk.added === 0
      ? "old"
      : "new"
    : hunk.status === "deleted"
      ? "old"
      : "new";

export const RangeManifest = z.strictObject({
  range: z.strictObject({
    baseOid: z.string(),
    headOid: z.string(),
    mergeBase: z.string(),
    baseTree: z.string(),
    headTree: z.string(),
  }),
  settings: FrontSettings,
  files: z.int().min(0),
  reviewLines: z.int().min(0),
  hunks: z.array(ManifestHunk),
  facts: z.array(ChangeFact),
  declarations: z.strictObject({
    readers: z.array(z.string()),
    gaps: z.array(z.string()),
  }),
  limitations: z.array(z.string()),
});
export type RangeManifest = z.infer<typeof RangeManifest>;

/**
 * The range manifest's computation. Version 2 holds no leads, no index and no retriever setting:
 * they moved to the range's leads (`rangeLeadsSpec`), which nothing on the review's path reads.
 * Version 3 uses canonical Git diff settings, excluding previously config-dependent hunks.
 */
export const manifestSpec = (
  range: { readonly baseOid: string; readonly headOid: string },
  merge: string,
  settings: ManifestSettings | FrontSettings,
  source: OutlineSource,
): Computations.ComputationSpec => ({
  op: "harness.range-manifest",
  opVersion: 3,
  inputs: {
    base: `git-commit:${range.baseOid}`,
    head: `git-commit:${range.headOid}`,
    mergeBase: `git-commit:${merge}`,
  },
  config: {
    settings: frontSettings(settings),
    // The hunks' enclosing symbols and Q1 queries depend on them (`fileHunksSpec`).
    index: indexRecipe(source),
    query: QUERY_RECIPE,
    // The `linguist` reader's pinned standard and rules: its marks are in the hunks' `declared`.
    linguist: LINGUIST_READER_RECIPE,
  } as never,
});

/** File facts share blob pairs across commits, range heads and cycles. Paths, modes and
 * Git's binary decision also matter for renames, metadata and attribute changes. */
export const fileHunksSpec = (
  file: DiffFile,
  source: OutlineSource,
): Computations.ComputationSpec => ({
  op: "harness.file-hunks",
  opVersion: 2,
  inputs: {
    oldBlob: file.oldOid,
    newBlob: file.newOid,
    oldPath: file.oldPath,
    newPath: file.newPath,
    oldMode: file.oldMode,
    newMode: file.newMode,
    status: file.status,
    binary: file.binary,
    diff: sha256Hex(JSON.stringify(file.hunks.map((hunk) => hunk.text))),
  },
  config: { index: indexRecipe(source), query: QUERY_RECIPE },
});

export const fileHunks = (
  repository: string,
  files: ReadonlyArray<DiffFile>,
  source: OutlineSource,
) =>
  Effect.gen(function* () {
    const concurrency = yield* cpuConcurrency(yield* LeadConcurrency);
    const cached = yield* storedOutputs(
      files.map((file) => fileHunksSpec(file, source)),
      z.array(HunkRecord),
    );
    const missing = files.filter((_, index) => Option.isNone(cached[index]!));
    // Batch the Git and blob reads for cold files. Storing per file must not mean one
    // cat-file process per file in a large cold range.
    yield* codeCheckpoint;
    const described =
      missing.length === 0
        ? []
        : yield* cpuKeyedPool("precompute.hunks", concurrency, () =>
            describeHunks(repository, missing, source),
          );
    const byFile = new Map<string, Array<HunkRecord>>();
    const fileKey = (file: Pick<DiffFile, "oldPath" | "newPath">) =>
      `${file.oldPath ?? ""}\0${file.newPath ?? ""}`;
    for (const hunk of described) {
      const key = fileKey(hunk);
      const list = byFile.get(key) ?? [];
      list.push(hunk);
      byFile.set(key, list);
    }
    const report = yield* ManifestProgress;
    let finished = 0;
    let hunkCount = 0;
    const results = yield* Effect.forEach(
      files,
      (file, index) => {
        const held = cached[index]!;
        const read = Option.isSome(held)
          ? Effect.succeed(held.value)
          : Effect.map(
              jsonComputation(
                fileHunksSpec(file, source),
                z.array(HunkRecord),
                Effect.succeed(byFile.get(fileKey(file)) ?? []),
              ),
              (result) => result.value,
            );
        return Effect.tap(
          Effect.andThen(
            codeCheckpoint,
            timePrecomputeItem("file-hunks", read, () =>
              Option.isSome(held) ? "cached" : "computed",
            ),
          ),
          (hunks) =>
            Effect.sync(() => {
              finished++;
              hunkCount += hunks.length;
              report({
                phase: "hunks",
                files: finished,
                hunks: hunkCount,
              });
            }),
        );
      },
      { concurrency },
    );
    yield* Effect.annotateCurrentSpan({
      "harness.files.computed": missing.length,
      "harness.files.reused": files.length - missing.length,
    });
    return results.flat();
  });

/**
 * The shared rules' input for the range. `SubmittedHunk` requires a lane, which no stage has
 * assessed at Precompute; the rules used here (changed ranges) never read it, and the manifest
 * never carries it.
 */
export const rulesSubmission = (
  range: RangeManifest["range"],
  hunks: ReadonlyArray<HunkRecord>,
): SubmittedBranchReview => {
  const files = new Map<string, Array<HunkRecord>>();
  for (const hunk of hunks) {
    const key = `${hunk.oldPath ?? ""}\0${hunk.newPath ?? ""}`;
    files.set(key, [...(files.get(key) ?? []), hunk]);
  }
  const lane = "agentic" as const;
  return {
    repository: "repository",
    branch: range.headOid,
    baseBranch: range.baseOid,
    baseRevisionId: range.baseOid,
    mergeBaseRevisionId: range.mergeBase,
    revisionId: range.headOid,
    snapshotKind: "committed",
    workingTreeDirty: false,
    limitations: [],
    files: [...files.values()].map((list) => {
      const first = list[0] as HunkRecord;
      return {
        status: first.status,
        oldPath: first.oldPath,
        newPath: first.newPath,
        oldMode: first.oldMode,
        newMode: first.newMode,
        binary: first.kind === "binary",
        hunkIds: list.map((hunk) => hunk.hunkId),
      };
    }),
    hunks: hunks.map((hunk) => ({
      hunkId: hunk.hunkId,
      lane,
      kind: hunk.kind,
      path: hunk.path,
      oldPath: hunk.oldPath,
      newPath: hunk.newPath,
      oldRange:
        hunk.kind === "text"
          ? { startLine: hunk.oldStart, lineCount: hunk.oldLines }
          : null,
      newRange:
        hunk.kind === "text"
          ? { startLine: hunk.newStart, lineCount: hunk.newLines }
          : null,
      text: hunk.text,
    })),
    inventory: {
      revisionId: range.headOid,
      hunks: hunks.map((hunk) => ({ hunkId: hunk.hunkId, lane })),
    },
  };
};

/** Each hunk's owned ranges and qualifications, or a limitation when the rules refuse the range. */
const ownership = (
  range: RangeManifest["range"],
  hunks: ReadonlyArray<HunkRecord>,
) => {
  try {
    const projected = projectSubmittedChangedRanges(
      rulesSubmission(range, hunks),
    );
    return {
      byHunk: new Map(projected.hunks.map((hunk) => [hunk.hunkId, hunk])),
      limitations: projected.source.unavailableSource.map(
        (entry) => `review rules: ${entry.kind}: ${entry.detail}`,
      ),
    };
  } catch (error) {
    if (!(error instanceof DecisionRangesError)) throw error;
    return {
      byHunk: new Map<string, SubmittedHunkWithChangedRanges>(),
      limitations: [
        `review rules refused the range (${error.reason}${error.hunkId === undefined ? "" : `, hunk ${error.hunkId}`}): ${error.detail}; no owned ranges`,
      ],
    };
  }
};

/**
 * The retriever with each answer's time recorded by who served it (`harness.leads.search.duration`,
 * by `harness.retriever`): the configured retriever's search under its config's id (a frozen
 * candidate's search is its fallback's), a frozen row under `frozen`.
 */
const timedRetriever = (retriever: Retriever): Retriever => {
  const config = retriever.description.config;
  const searchedBy = config.id === "frozen" ? config.fallback.id : config.id;
  const timed = <A, E, R>(label: string, effect: Effect.Effect<A, E, R>) =>
    Effect.suspend(() => {
      const started = performance.now();
      return Effect.ensuring(
        effect,
        // A Graph lead search can end after the review's attempt (0013): recorded either way.
        Effect.suspend(() =>
          recordLate(
            Metric.update(
              Metric.withAttributes(METRICS.leadsSearch, {
                "harness.retriever": label,
              }),
              (performance.now() - started) / 1_000,
            ),
          ),
        ),
      );
    });
  const leadsFor = retriever.leadsFor;
  return {
    ...retriever,
    search: (query) => timed(searchedBy, retriever.search(query)),
    ...(leadsFor === undefined
      ? {}
      : { leadsFor: (hunk: HunkRecord) => timed("frozen", leadsFor(hunk)) }),
  };
};

/** Why a hunk's Graph leads were replaced by the keyword search's. */
type LeadsFallback = "deadline" | "unavailable" | "failed";

/**
 * A range's round of Graph lead searches (architecture record 0013): missing hunk searches run
 * through a bounded pool, and the range's leads wait for the pool once, at most `waitMs`; no review
 * step waits for them (NEU-148). They queue for Graph's slot as background work; an agent's search
 * goes ahead of them. A hunk whose
 * Graph leads are ready by then gets them; any other gets the keyword search's leads, with a note
 * saying so and why, and is counted as a fallback. Graph's searches are never cut off: each keeps
 * running to its own end and stores its leads, so the next review of that hunk finds them ready.
 */
export const graphLeadsRound = (
  waitMs: number,
  missing: ReadonlyArray<HunkRecord>,
  graph: Retriever,
  keyword: Retriever,
  config: RetrieverConfig,
) =>
  Effect.gen(function* () {
    const concurrency = yield* cpuConcurrency(yield* LeadConcurrency);
    const output = yield* Deferred.make<
      {
        leads: Map<string, HunkLeadsEntry>;
        fellBack: Set<string>;
        stored: number;
      },
      unknown
    >();
    const worker = yield* Effect.forkDetach(
      cpuKeyedPool("leads.graph-and-keyword", concurrency, (permits) =>
        Effect.gen(function* () {
          const graphConcurrency = Math.max(1, permits - 1);
          const keywordConcurrency = 1;
          // A single-permit machine prepares fallback first, so a slow Graph cannot block it.
          const eager =
            permits === 1
              ? yield* Effect.forEach(
                  missing,
                  (hunk) => hunkLeads(hunk, keyword),
                  { concurrency: 1 },
                )
              : undefined;
          const started = performance.now();
          yield* Metric.update(
            Metric.withAttributes(METRICS.graphCalls, {
              "harness.graph.caller": "leads",
            }),
            missing.length,
          );
          const completed = new Map<
            string,
            Exit.Exit<
              Effect.Success<ReturnType<typeof hunkLeads>>,
              Effect.Error<ReturnType<typeof hunkLeads>>
            >
          >();
          const round = yield* Effect.forkDetach(
            Effect.forEach(
              missing,
              (hunk) =>
                Effect.flatMap(
                  Effect.exit(
                    timePrecomputeItem(
                      "leads.graph-search",
                      hunkLeads(hunk, graph),
                      (value) =>
                        value?.status === "computed" ? "searched" : "cached",
                    ),
                  ),
                  (exit) =>
                    Effect.sync(() => {
                      completed.set(hunk.hunkId, exit);
                    }),
                ),
              { concurrency: graphConcurrency, discard: true },
            ),
          );
          yield* Fiber.await(round).pipe(
            Effect.timeoutOption(waitMs),
            Effect.onInterrupt(() => Fiber.interrupt(round)),
          );
          const result = yield* Effect.gen(function* () {
            const leads = new Map<string, HunkLeadsEntry>();
            const fellBack = new Set<string>();
            let stored = 0;
            yield* Effect.forEach(
              missing,
              (hunk, index) =>
                Effect.gen(function* () {
                  const exit = Option.fromUndefinedOr(
                    completed.get(hunk.hunkId),
                  );
                  if (Option.isSome(exit) && Exit.isSuccess(exit.value)) {
                    const result = exit.value.value;
                    if (result === undefined) return;
                    yield* Metric.update(
                      Metric.withAttributes(METRICS.leadsHunk, {
                        "harness.retriever": config.id,
                      }),
                      (performance.now() - started) / 1_000,
                    );
                    if (result.status !== "computed") stored++;
                    leads.set(hunk.hunkId, {
                      source:
                        result.status === "computed" ? "searched" : "cached",
                      ...result.value,
                    });
                    return;
                  }
                  const failure =
                    Option.isSome(exit) && Exit.isFailure(exit.value)
                      ? Cause.squash(exit.value.cause)
                      : undefined;
                  const reason: LeadsFallback =
                    failure === undefined
                      ? "deadline"
                      : (failure as { _tag?: unknown })._tag ===
                          "GraphUnavailable"
                        ? "unavailable"
                        : "failed";
                  const fallback = yield* timePrecomputeItem(
                    "leads.keyword-fallback",
                    eager === undefined
                      ? hunkLeads(hunk, keyword)
                      : Effect.succeed(eager[index]),
                    (value) =>
                      value?.status === "computed" ? "searched" : "cached",
                  );
                  yield* Metric.update(
                    Metric.withAttributes(METRICS.graphFallback, {
                      "harness.graph.caller": "leads",
                      "harness.graph.fallback_reason": reason,
                    }),
                    1,
                  );
                  if (fallback === undefined) return;
                  fellBack.add(hunk.hunkId);
                  leads.set(hunk.hunkId, {
                    source:
                      fallback.status === "computed" ? "searched" : "cached",
                    ...fallback.value,
                    note:
                      reason === "deadline"
                        ? `Graph's leads were not ready within ${Math.round(waitMs / 1000)} s, so these are the keyword search's; Graph's keep running and are stored for the next review`
                        : `Graph could not search this hunk (${reason}), so these are the keyword search's leads`,
                  });
                }),
              { concurrency: keywordConcurrency, discard: true },
            );
            return { leads, fellBack, stored };
          }).pipe(
            Effect.onExit((exit) =>
              Exit.isFailure(exit) ? Fiber.interrupt(round) : Effect.void,
            ),
          );
          yield* Deferred.succeed(output, result);
          // The caller can continue while Graph stores its leads. Keep its grant until that work ends.
          yield* Fiber.await(round).pipe(
            Effect.onInterrupt(() => Fiber.interrupt(round)),
          );
        }),
      ).pipe(
        Effect.onExit((exit) =>
          Exit.isFailure(exit)
            ? Deferred.failCause(output, exit.cause)
            : Effect.void,
        ),
      ),
    );
    return yield* Deferred.await(output).pipe(
      Effect.onInterrupt(() => Fiber.interrupt(worker)),
    );
  });

/** Computes the manifest; `frontManifest` stores it. */
const computeManifest = (
  repository: string,
  range: { readonly baseOid: string; readonly headOid: string },
  merge: string,
  trees: RangeTrees,
  settings: ManifestSettings | FrontSettings,
  source: OutlineSource,
) =>
  Effect.gen(function* () {
    const report = yield* ManifestProgress;
    const { baseTree, headTree } = trees;
    // Each sub-step is a span under Precompute's (10.97): counts and labels only, never source.
    const files = yield* step(
      "harness.precompute.range-diff",
      diffTrees(repository, merge, range.headOid),
      (value) => ({ "harness.files": value.length }),
    );
    const hunks = yield* step(
      "harness.precompute.hunks",
      fileHunks(repository, files, source),
      (value) => ({ "harness.hunks": value.length }),
    );
    report({ phase: "hunks", files: files.length, hunks: hunks.length });
    const manifestRange = {
      baseOid: range.baseOid,
      headOid: range.headOid,
      mergeBase: merge,
      baseTree,
      headTree,
    };
    const { headListing, baseListing } = yield* step(
      "harness.precompute.listings",
      Effect.all({
        headListing: lsTree(repository, headTree),
        baseListing: lsTree(repository, baseTree),
      }),
      (value) => ({
        "harness.head_entries": value.headListing.length,
        "harness.base_entries": value.baseListing.length,
      }),
    );
    const atHead = hunks.filter((hunk) => hunk.newPath !== null);
    const deleted = hunks.filter((hunk) => hunk.newPath === null);
    const headPaths = new Set(atHead.map((hunk) => hunk.path));
    const { headDeclarations, baseDeclarations } = yield* step(
      "harness.precompute.declarations",
      Effect.all({
        headDeclarations: readDeclarations({
          repository,
          revision: headTree,
          tree: headListing,
          paths: [...new Set(atHead.map((hunk) => hunk.path))],
          linguist: true,
        }),
        baseDeclarations: readDeclarations({
          repository,
          revision: baseTree,
          tree: baseListing,
          paths: [...new Set(deleted.map((hunk) => hunk.path))],
          // A deleted file's attributes are the head's, as the `generated` rule reads them; and a
          // path the head side also has (a type change) is Linguist's to decide at the head only,
          // where the rule reads its head blob, "no mark" included.
          linguist: true,
          linguistAttributesAt: headTree,
          linguistPaths: [
            ...new Set(
              deleted
                .map((hunk) => hunk.path)
                .filter((path) => !headPaths.has(path)),
            ),
          ],
        }),
      }),
    );
    const declared = new Map([
      ...baseDeclarations.byPath,
      ...headDeclarations.byPath,
    ]);
    const suggestionsOf = (hunk: HunkRecord) => declared.get(hunk.path) ?? [];
    const counts = (hunk: HunkRecord) =>
      !suggestionsOf(hunk).some((entry) => entry.kind === "generated");
    const reviewLines = hunks
      .filter(counts)
      .reduce((sum, hunk) => sum + hunk.added + hunk.deleted, 0);
    // Owned ranges, allowances and change facts. Plain code, as one span: its failure ends it too.
    return yield* step(
      "harness.precompute.assembly",
      Effect.sync(() => {
        const { byHunk, limitations } = ownership(manifestRange, hunks);
        const manifestHunks = hunks.map((hunk): ManifestHunk => {
          const lines = hunk.added + hunk.deleted;
          const countsToward = counts(hunk);
          const exactShare =
            countsToward && reviewLines > 0
              ? (settings.window * settings.allowanceShare * lines) /
                reviewLines
              : 0;
          const owned = byHunk.get(hunk.hunkId);
          return {
            ...hunk,
            ownedRanges: (owned?.changedRanges ?? []).map(
              (range: ChangedRange) => ({
                side: range.side,
                startLine: range.startLine,
                lineCount: range.lineCount,
              }),
            ),
            qualifications: (owned?.qualifications ?? []).map(
              (entry: AccountingQualification) => ({
                kind: entry.kind,
                detail: entry.detail,
              }),
            ),
            declared: [...suggestionsOf(hunk)],
            countsTowardReviewLines: countsToward,
            allowance: {
              tokens: Math.max(settings.allowanceFloor, Math.floor(exactShare)),
              exactShare: Number(exactShare.toFixed(3)),
              floored: Math.floor(exactShare) < settings.allowanceFloor,
            },
          };
        });
        return {
          range: manifestRange,
          settings: frontSettings(settings),
          files: files.length,
          reviewLines,
          hunks: manifestHunks,
          facts: [...changeFacts(hunks, { byPath: declared }, reviewLines)],
          declarations: {
            readers: [...DECLARATION_READERS],
            // Both calls' gaps, standing and run-time, each once, head's first.
            gaps: [
              ...new Set([...headDeclarations.gaps, ...baseDeclarations.gaps]),
            ],
          },
          limitations: [
            ...limitations,
            ...hunks
              .filter((hunk) => hunk.kind === "text" && hunk.query === null)
              .map(
                (hunk) =>
                  `hunk ${hunk.hunkId} (${hunk.path}): no query, its side's text is not readable`,
              ),
          ],
        } satisfies RangeManifest;
      }),
    );
  });

/** The range's base (merge-base) and head trees: what the two tree indexes are built from. */
interface RangeTrees {
  readonly baseTree: string;
  readonly headTree: string;
}

/**
 * The range manifest the review's front path reads, computed once per base, head and merge base and
 * reused afterwards (5.4).
 */
export const frontManifest = (
  repository: string,
  range: { readonly baseOid: string; readonly headOid: string },
  settings: ManifestSettings | FrontSettings,
  source: OutlineSource,
) =>
  Effect.gen(function* () {
    const merge = yield* step(
      "harness.precompute.merge-base",
      mergeBase(repository, range.baseOid, range.headOid),
    );
    const report = yield* ManifestProgress;
    report({ phase: "trees", files: 0, hunks: 0 });
    const trees = yield* step(
      "harness.precompute.trees",
      Effect.all({
        baseTree: treeOf(repository, merge),
        headTree: treeOf(repository, range.headOid),
      }),
    );
    const manifest = yield* timePrecomputeItem(
      "range-manifest",
      jsonComputation(
        manifestSpec(range, merge, settings, source),
        RangeManifest,
        computeManifest(repository, range, merge, trees, settings, source),
      ),
      (value) => value.status,
    );
    yield* Effect.annotateCurrentSpan(
      "harness.computation.status",
      manifest.status,
    );
    return manifest;
  }).pipe(
    Effect.retry({
      times: 1,
      while: (error) => error instanceof Computations.SharedAttemptFailed,
    }),
    Effect.withSpan("harness.precompute.manifest", {
      attributes: {
        "harness.base": range.baseOid,
        "harness.head": range.headOid,
      },
    }),
  );

/** One hunk's top leads: `cached` were stored before (commit preparation, PC13); `searched` now. */
export const HunkLeadsEntry = z.strictObject({
  source: z.enum(["cached", "searched"]),
  ...HunkLeads.shape,
});
export type HunkLeadsEntry = z.infer<typeof HunkLeadsEntry>;

/**
 * The range's leads (PC13, 10.108, 0013): each hunk's top leads from the configured retriever over
 * the range's base index, and what that index held. Keyed by the range manifest, the retriever
 * settings and the index recipe; no review step reads them (NEU-148). `neuve review show`, the
 * harness comparison's evaluations and later reviews of the same hunks (through each hunk's own
 * leads key, `leads.ts`) do.
 */
export const RangeLeads = z.strictObject({
  /** The range manifest these are the leads of. */
  manifest: z.string(),
  settings: LeadSettings,
  /** What the base index searched; null when every hunk's leads were already stored. */
  index: z
    .strictObject({
      tree: z.string(),
      chunks: z.int().min(0),
      excluded: z.record(z.string(), z.int()),
      bounds: z.string(),
    })
    .nullable(),
  counts: z.strictObject({
    cached: z.int().min(0),
    searched: z.int().min(0),
    /** Cached leads whose file at that path differs in the base tree. */
    stale: z.int().min(0),
    /** Hybrid leads only: hunks whose hybrid leads were not ready, which hold BM25's (10.118). */
    fallback: z.int().min(0).optional(),
  }),
  /** Every manifest hunk, in its order; null for one with no query or no leads. */
  hunks: z.array(
    z.strictObject({ hunkId: z.string(), leads: HunkLeadsEntry.nullable() }),
  ),
});
export type RangeLeads = z.infer<typeof RangeLeads>;

/** The range's leads' computation: the manifest's key, the leads' settings and the index recipe. */
export const rangeLeadsSpec = (
  manifestKey: string,
  settings: LeadSettings,
  source: OutlineSource,
): Computations.ComputationSpec => ({
  op: "harness.range-leads",
  opVersion: 1,
  inputs: { manifest: `computation:${manifestKey}` },
  config: {
    retriever: settings.retriever,
    index: indexRecipe(source),
    // A Graph round's leads may be the keyword search's past the round's wait (0013).
    ...(settings.retriever.id === "graph"
      ? {
          graphLeads: {
            waitMs: settings.graphWaitMs ?? GRAPH_DEADLINE_MS,
            fallback: DEFAULT_RETRIEVER,
          },
        }
      : {}),
    // Hybrid leads are read stored, never computed here (10.118); a hunk without them gets BM25's.
    ...(settings.retriever.id === "hybrid"
      ? { hybridLeads: { fallback: DEFAULT_RETRIEVER } }
      : {}),
  } as never,
});

/**
 * A range manifest as version 1 stored it, with each hunk's leads and the index inline: what a run
 * from before NEU-148 left. Readers only (`neuve review show`); nothing computes it any more.
 */
export const legacyManifestSpec = (
  range: { readonly baseOid: string; readonly headOid: string },
  merge: string,
  settings: ManifestSettings,
  source: OutlineSource,
): Computations.ComputationSpec => ({
  op: "harness.range-manifest",
  opVersion: 1,
  inputs: {
    base: `git-commit:${range.baseOid}`,
    head: `git-commit:${range.headOid}`,
    mergeBase: `git-commit:${merge}`,
  },
  config: {
    settings,
    index: indexRecipe(source),
    query: QUERY_RECIPE,
    ...(settings.retriever.id === "graph"
      ? {
          graphLeads: {
            waitMs: settings.graphWaitMs ?? GRAPH_DEADLINE_MS,
            fallback: DEFAULT_RETRIEVER,
          },
        }
      : {}),
    ...(settings.retriever.id === "hybrid"
      ? { hybridLeads: { fallback: DEFAULT_RETRIEVER } }
      : {}),
  } as never,
});
export const LegacyRangeManifest = z.strictObject({
  ...RangeManifest.shape,
  settings: ManifestSettings,
  hunks: z.array(
    z.strictObject({
      ...ManifestHunk.shape,
      leads: HunkLeadsEntry.nullable(),
    }),
  ),
  index: RangeLeads.shape.index,
  leads: RangeLeads.shape.counts,
});
export type LegacyRangeManifest = z.infer<typeof LegacyRangeManifest>;

/** An older manifest as the two it is now: the manifest, and its leads. */
export const splitLegacyManifest = (
  key: string,
  legacy: LegacyRangeManifest,
): { manifest: RangeManifest; leads: RangeLeads } => ({
  manifest: {
    range: legacy.range,
    settings: frontSettings(legacy.settings),
    files: legacy.files,
    reviewLines: legacy.reviewLines,
    hunks: legacy.hunks.map(({ leads: _leads, ...hunk }) => hunk),
    facts: legacy.facts,
    declarations: legacy.declarations,
    limitations: legacy.limitations,
  },
  leads: {
    manifest: key,
    settings: leadSettings(legacy.settings),
    index: legacy.index,
    counts: legacy.leads,
    hunks: legacy.hunks.map((hunk) => ({
      hunkId: hunk.hunkId,
      leads: hunk.leads,
    })),
  },
});

/** A range's leads by hunk. */
export const leadsByHunk = (leads: RangeLeads) =>
  new Map(leads.hunks.map((entry) => [entry.hunkId, entry.leads]));

/** Computes the range's leads; `rangeLeads` stores them. */
const computeLeads = (
  repository: string,
  manifestKey: string,
  manifest: RangeManifest,
  settings: LeadSettings,
  source: OutlineSource,
) =>
  Effect.gen(function* () {
    const concurrency = yield* cpuConcurrency(yield* LeadConcurrency);
    const { hunks } = manifest;
    const merge = manifest.range.mergeBase;
    const baseTree = manifest.range.baseTree;
    const range = manifest.range;
    // Leads: reused where PC13's key matches; the base index is built only for the rest.
    const leads = new Map<string, HunkLeadsEntry>();
    /** Hunks whose Graph leads were not ready in time: they hold the keyword search's (0013). */
    const fellBack = new Set<string>();
    const missing: Array<HunkRecord> = [];
    yield* step(
      "harness.leads.lookup",
      Effect.gen(function* () {
        const candidates = hunks.filter((hunk) => hunk.query !== null);
        // E0's keys depend on vector coverage, known only by the retriever below.
        if (settings.retriever.id === "e0") {
          missing.push(...candidates);
          return;
        }
        const keyed =
          settings.retriever.id === "frozen"
            ? frozenKeyed({ mergeBase: merge, headOid: range.headOid })
            : undefined;
        const lookup = (specs: ReadonlyArray<Computations.ComputationSpec>) =>
          timePrecomputeItem(
            "leads.lookup",
            storedOutputs(specs, HunkLeads),
            (values) => (values.every(Option.isSome) ? "cached" : "missing"),
          );
        const current = yield* lookup(
          candidates.map((hunk) =>
            leadsSpec(hunk, settings.retriever, indexRecipe(source), keyed),
          ),
        );
        const older: Array<HunkRecord> = [];
        for (const [index, hunk] of candidates.entries()) {
          const cached = current[index] ?? Option.none<HunkLeads>();
          if (Option.isSome(cached))
            leads.set(hunk.hunkId, { source: "cached", ...cached.value });
          else older.push(hunk);
        }
        const legacy = yield* lookup(
          older.map((hunk) =>
            legacyLeadsSpec(
              hunk,
              settings.retriever,
              indexRecipe(source),
              keyed,
            ),
          ),
        );
        for (const [index, hunk] of older.entries()) {
          const cached = legacy[index] ?? Option.none<HunkLeads>();
          if (Option.isSome(cached))
            leads.set(hunk.hunkId, { source: "cached", ...cached.value });
          else missing.push(hunk);
        }
      }),
      () => ({ "harness.hunks": hunks.length, "harness.cached": leads.size }),
    );
    let index: RangeLeads["index"] = null;
    if (missing.length > 0) {
      // The tree's index first, on its own, so its build is told apart from the retriever's setup
      // (E0's vectors, a frozen table); `retrieverFor` then takes it from memory. In a review the
      // build is already running, prefetched beside this computation by the leads task, so this
      // span is the wait for it. The build's own steps are `harness.index.*` spans (search-index.ts).
      yield* step(
        "harness.leads.tree-index",
        timePrecomputeItem(
          "tree-index",
          indexOf(repository, baseTree, source),
          (value) => (value.cached ? "cached" : "computed"),
        ),
        ({ index: built, cached }) => ({
          "harness.index.from_memory": cached,
          "harness.index.chunks": built.chunks.length,
        }),
      );
      // Hybrid leads not stored by commit preparation are not ready: the keyword search's leads,
      // disclosed on the hunk and counted as fallbacks (10.118).
      const hybrid = settings.retriever.id === "hybrid";
      const built = yield* step(
        "harness.leads.retriever",
        hybrid
          ? Effect.map(
              indexOf(repository, baseTree, source),
              ({ index: tree }) => ({
                retriever: bm25Retriever(repository, tree, DEFAULT_RETRIEVER),
                index: tree,
              }),
            )
          : retrieverFor(
              {
                repository,
                source,
                tree: baseTree,
                commit: merge,
                range: {
                  baseOid: range.baseOid,
                  mergeBase: merge,
                  headOid: range.headOid,
                },
                hunks,
                // Graph's lead searches run to their own end, so their leads are stored even when the
                // round stops waiting (below).
                graphDeadlineMs: GRAPH_WHOLE_ANSWER,
              },
              settings.retriever,
            ),
        (value) => ({
          "harness.retriever": settings.retriever.id,
          "harness.retriever.family": value.retriever.description.family,
        }),
      );
      index = {
        tree: baseTree,
        chunks: built.index.chunks.length,
        excluded: { ...built.index.excluded },
        bounds: INDEX_BOUNDS.id,
      };
      const retriever = timedRetriever(built.retriever);
      let stored = 0;
      // The round of searches; each search is its own `harness.leads.search` span (leads.ts).
      yield* step(
        "harness.leads.round",
        Effect.gen(function* () {
          if (settings.retriever.id === "graph") {
            const round = yield* graphLeadsRound(
              settings.graphWaitMs ?? GRAPH_DEADLINE_MS,
              missing,
              retriever,
              bm25Retriever(repository, built.index, DEFAULT_RETRIEVER),
              settings.retriever,
            );
            stored = round.stored;
            for (const [hunkId, entry] of round.leads) leads.set(hunkId, entry);
            for (const hunkId of round.fellBack) fellBack.add(hunkId);
            return;
          }
          yield* cpuKeyedPool("leads.search", concurrency, (concurrency) =>
            Effect.forEach(
              missing,
              (hunk) =>
                Effect.gen(function* () {
                  const started = performance.now();
                  const result = yield* timePrecomputeItem(
                    "leads.search",
                    hunkLeads(hunk, retriever),
                    (value) =>
                      value?.status === "computed" ? "searched" : "cached",
                  );
                  if (hybrid && result !== undefined) {
                    fellBack.add(hunk.hunkId);
                    leads.set(hunk.hunkId, {
                      source:
                        result.status === "computed" ? "searched" : "cached",
                      ...result.value,
                      note: "Hybrid leads were not ready for this hunk (they are computed in the background after each commit), so these are the keyword search's",
                    });
                    return;
                  }
                  yield* Metric.update(
                    Metric.withAttributes(METRICS.leadsHunk, {
                      "harness.retriever": settings.retriever.id,
                    }),
                    (performance.now() - started) / 1_000,
                  );
                  if (result !== undefined) {
                    if (result.status !== "computed") stored++;
                    leads.set(hunk.hunkId, {
                      source:
                        result.status === "computed" ? "searched" : "cached",
                      ...result.value,
                    });
                  }
                  yield* Effect.yieldNow;
                }),
              { concurrency, discard: true },
            ),
          );
        }),
        () => ({
          "harness.retriever": settings.retriever.id,
          "harness.hunks": missing.length,
          // Hunks whose leads were already stored under this key: no retriever ran for them.
          "harness.from_store": stored,
          ...(settings.retriever.id === "graph" || hybrid
            ? { "harness.leads.fallback": fellBack.size }
            : {}),
        }),
      );
    }
    // Leads found ready (stored by commit preparation or an earlier review), computed by the
    // review, or the keyword search's in place of Graph's not ready in time (10.108, 0013).
    for (const source of ["ready", "computed", "fallback"] as const) {
      const count = [...leads].filter(([hunkId, entry]) =>
        fellBack.has(hunkId)
          ? source === "fallback"
          : source !== "fallback" &&
            (entry.source === "searched") === (source === "computed"),
      ).length;
      if (count > 0)
        yield* Metric.update(
          Metric.withAttributes(METRICS.leadsSource, {
            "harness.leads.source": source,
            "harness.retriever": settings.retriever.id,
          }),
          count,
        );
    }
    // A cached lead searched in another tree is stale when its file differs in the base tree: the
    // base listing is read only when such a lead exists.
    const elsewhere = [...leads.values()].some(
      (entry) => entry.tree !== baseTree,
    );
    const baseListing = elsewhere ? yield* lsTree(repository, baseTree) : [];
    // Stale marks and frequencies. Plain code, as one span: its failure ends the span too.
    return yield* step(
      "harness.leads.assembly",
      Effect.sync(() => {
        const baseBlobs = new Map(
          baseListing.map((entry) => [entry.path, entry.oid]),
        );
        let stale = 0;
        const frequency = new Map<string, number>();
        for (const entry of leads.values())
          for (const result of entry.results)
            frequency.set(
              result.identity.chunkId,
              (frequency.get(result.identity.chunkId) ?? 0) + 1,
            );
        for (const [hunkId, entry] of leads)
          leads.set(hunkId, {
            ...entry,
            results: entry.results.map((result) => {
              const isStale =
                entry.tree !== baseTree &&
                baseBlobs.get(result.identity.path) !== result.identity.blobOid;
              if (isStale) stale++;
              return {
                ...result,
                retrieval: {
                  ...result.retrieval,
                  frequency: frequency.get(result.identity.chunkId) ?? 0,
                },
                coverage: { ...result.coverage, stale: isStale },
              };
            }),
          });
        const cachedCount = [...leads.values()].filter(
          (entry) => entry.source === "cached",
        ).length;
        return {
          manifest: manifestKey,
          settings: leadSettings(settings),
          index,
          counts: {
            cached: cachedCount,
            searched: leads.size - cachedCount,
            stale,
            ...(settings.retriever.id === "hybrid"
              ? { fallback: fellBack.size }
              : {}),
          },
          hunks: hunks.map((hunk) => ({
            hunkId: hunk.hunkId,
            leads: leads.get(hunk.hunkId) ?? null,
          })),
        } satisfies RangeLeads;
      }),
    );
  });

/**
 * The range's leads, computed once per manifest, retriever and index recipe, and reused afterwards.
 * One run per key (record 0016, through the computation store): a second caller subscribes.
 */
export const rangeLeads = (
  repository: string,
  manifest: { readonly key: string; readonly value: RangeManifest },
  settings: LeadSettings,
  source: OutlineSource,
) => {
  const spec = rangeLeadsSpec(manifest.key, settings, source);
  return Effect.gen(function* () {
    // A hybrid review records how many of the range's commits still had their hybrid leads
    // queued or running when it read them (the overseer's call): a measured one shows zero.
    if (settings.retriever.id === "hybrid") {
      const sql = yield* Effect.serviceOption(SqlClient);
      if (Option.isSome(sql)) {
        const pending = yield* Effect.result(
          Effect.provideService(
            pendingHybrid(repository, manifest.value.range),
            SqlClient,
            sql.value,
          ),
        );
        yield* Effect.annotateCurrentSpan(
          pending._tag === "Success"
            ? {
                "harness.hybrid.range_commits": pending.success.commits,
                "harness.hybrid.pending_commits": pending.success.pending,
              }
            : {
                "harness.hybrid.pending_error": String(
                  (pending.failure as { message?: unknown }).message ??
                    pending.failure,
                ).slice(0, 300),
              },
        );
      }
    }
    const leads = yield* jsonComputation(
      spec,
      RangeLeads,
      computeLeads(repository, manifest.key, manifest.value, settings, source),
    );
    yield* Effect.annotateCurrentSpan({
      "harness.computation.status": leads.status,
      "harness.leads.cached": leads.value.counts.cached,
      "harness.leads.searched": leads.value.counts.searched,
    });
    return leads;
  }).pipe(
    Effect.retry({
      times: 1,
      while: (error) => error instanceof Computations.SharedAttemptFailed,
    }),
    Effect.withSpan("harness.leads", {
      attributes: {
        "harness.computation.key": Computations.computationKey(spec).key,
        "harness.manifest": manifest.key,
        "harness.retriever": settings.retriever.id,
      },
    }),
  );
};

/**
 * A range's preparation outside a review (commit preparation's range job, scripts): its manifest,
 * then its leads, awaited, both stored. A review never calls this; its front path reads only the
 * manifest, and its leads run in the background (`pipeline.ts`).
 */
export const rangeManifest = (
  repository: string,
  range: { readonly baseOid: string; readonly headOid: string },
  settings: ManifestSettings,
  source: OutlineSource,
) =>
  Effect.gen(function* () {
    const manifest = yield* frontManifest(repository, range, settings, source);
    const leads = yield* rangeLeads(repository, manifest, settings, source);
    return { ...manifest, leads };
  });
