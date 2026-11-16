import type { OutlineSource } from "./graph-outline.ts";
import { Context, Effect } from "effect";
import { Worker, type Blobs, type Computations } from "@neuve/records-core";
import { e0Retriever, encodeQuery, treeVectors } from "./e0.ts";
import { frozenRetriever, loadFrozen, rowsForRange } from "./frozen.ts";
import { graphRetriever, prepareBase } from "./graph-search.ts";
import type { HunkRecord } from "./hunks.ts";
import { LEADS_PER_HUNK } from "./leads.ts";
import {
  bm25Retriever,
  type SearchedConfig,
  type Retriever,
  type RetrieverConfig,
} from "./retriever.ts";
import {
  GRAPH_DEADLINE_MS,
  searchRuntime,
  type SearchConfig,
  type SearchRuntime,
} from "./search-config.ts";
import { treeIndex, type TreeIndex } from "./search-index.ts";
/**
 * Builds the retriever a `RetrieverConfig` names over a range's base (the port, retriever.ts). A
 * retriever this machine cannot serve fails with `RetrieverUnavailable`, which every caller
 * discloses; none falls back to another retriever under the configured one's name.
 */

export class RetrieverUnavailable extends Error {
  readonly _tag = "RetrieverUnavailable";
}

export interface RetrieverScope {
  readonly repository: string;
  readonly source: OutlineSource;
  /** The tree the index is built from: the range's base tree. */
  readonly tree: string;
  /** The commit that tree is (Graph prepares and reads by commit). */
  readonly commit: string;
  /** The range, for a frozen candidate's rows. */
  readonly range?:
    | {
        readonly baseOid: string;
        readonly mergeBase: string;
        readonly headOid: string;
      }
    | undefined;
  /** The range's hunks, so a frozen candidate assigns its rows over the whole range at once. */
  readonly hunks?: ReadonlyArray<HunkRecord> | undefined;
  readonly runtime?: SearchRuntime | undefined;
  readonly graphDeadlineMs?: number | undefined;
}

/** Every caller reaches treeIndex's one source-bound cross-process run. */
export const indexOf = (
  repository: string,
  tree: string,
  source: OutlineSource,
) =>
  Effect.flatMap(Worker.HeavyWork, (gate) =>
    gate.start(
      treeIndex(repository, tree, source).pipe(
        Effect.provideService(
          Worker.HeavyWork,
          Worker.HeavyWork.defaultValue(),
        ),
      ),
    ),
  );

const member = (
  scope: RetrieverScope,
  index: TreeIndex,
  config: SearchedConfig,
): Effect.Effect<Retriever, unknown> => {
  const runtime = scope.runtime ?? searchRuntime();
  switch (config.id) {
    case "bm25":
      return Effect.succeed(bm25Retriever(scope.repository, index, config));
    case "e0":
      return runtime.e0 === undefined
        ? Effect.fail(
            new RetrieverUnavailable(
              runtime.problems["semantic_search"] ??
                "E0 is not set up on this machine (no search.e0 in the Neuve settings)",
            ),
          )
        : (() => {
            const e0 = runtime.e0;
            // The vectors are read first: which chunks have one is part of every E0 key.
            return Effect.map(treeVectors(index, e0), (vectors) =>
              e0Retriever(
                scope.repository,
                index,
                config,
                e0,
                vectors.coverage,
              ),
            );
          })();
    case "graph":
      return runtime.graph === undefined
        ? Effect.fail(
            new RetrieverUnavailable(
              runtime.problems["graph_search"] ??
                "Graph is not set up on this machine (no search.graph in the Neuve settings)",
            ),
          )
        : Effect.succeed(
            graphRetriever(
              scope.repository,
              index,
              scope.commit,
              config,
              runtime.graph,
              scope.graphDeadlineMs ?? GRAPH_DEADLINE_MS,
            ),
          );
  }
};

/** A tree's index as `indexOf` gives it. */
export type IndexOf = Effect.Success<ReturnType<typeof indexOf>>;

/**
 * The configured retriever over the scope's tree; the tree's index is built or taken from memory,
 * or is `indexed`, the scope's tree's index a caller already got (E0's ranked search gets it under
 * a bound first), so this gets it no second time.
 */
export const retrieverFor = (
  scope: RetrieverScope,
  config: RetrieverConfig,
  indexed?: IndexOf,
) =>
  Effect.gen(function* () {
    const { index, cached } =
      indexed ?? (yield* indexOf(scope.repository, scope.tree, scope.source));
    const runtime = scope.runtime ?? searchRuntime();
    let retriever: Retriever;
    switch (config.id) {
      case "bm25":
      case "e0":
      case "graph":
        retriever = yield* member(scope, index, config);
        break;
      case "frozen": {
        const path = runtime.frozen.get(config.sha256);
        if (path === undefined)
          return yield* Effect.fail(
            new RetrieverUnavailable(
              `no frozen leads file with SHA-256 ${config.sha256.slice(0, 12)} is named in the Neuve settings`,
            ),
          );
        const table = yield* Effect.try({
          try: () => loadFrozen(path, config.sha256),
          catch: (cause) => new RetrieverUnavailable(String(cause)),
        });
        if (scope.range === undefined)
          return yield* Effect.fail(
            new RetrieverUnavailable(
              "a frozen candidate's leads need the range",
            ),
          );
        retriever = frozenRetriever(
          scope.repository,
          index,
          config,
          rowsForRange(table, scope.range),
          bm25Retriever(scope.repository, index, config.fallback),
          LEADS_PER_HUNK,
          scope.range,
          scope.hunks ?? [],
        );
        break;
      }
      case "hybrid":
        // 10.118: hybrid leads are computed at commit time (`commit-hybrid.ts`) and only read here.
        return yield* Effect.fail(
          new RetrieverUnavailable(
            "hybrid leads are computed at commit time and read stored; a review never searches them",
          ),
        );
    }
    return { retriever, index, cached };
  });

/** How many of the base's chunks have a stored E0 vector, and which (the key's coverage). */
export const e0CoverageOf = (scope: RetrieverScope) =>
  Effect.gen(function* () {
    const runtime = scope.runtime ?? searchRuntime();
    if (runtime.e0 === undefined)
      return yield* Effect.fail(
        new RetrieverUnavailable(
          runtime.problems["semantic_search"] ??
            "E0 is not set up on this machine (no search.e0 in the Neuve settings)",
        ),
      );
    const { index } = yield* indexOf(
      scope.repository,
      scope.tree,
      scope.source,
    );
    const vectors = yield* treeVectors(index, runtime.e0);
    return {
      withVectors: vectors.docs.length,
      chunks: index.chunks.length,
      coverage: vectors.coverage,
    };
  });

/**
 * Starts the slow parts of the run's search tools in the background once the range is known, so
 * they are ready by Investigate: Graph's base snapshot (up to about a minute on the benchmark's
 * bases) and E0's vectors and model (about 12 s to load). Each step is a `harness.prewarm` span
 * (10.97) in a child fiber of the caller's: it reaches the run's tracer, and it ends with the run,
 * so its span ends before the run's exporters close. It reports its failure; nothing waits on it,
 * and a search that comes first waits on the same work.
 */
export const prewarmSearch = (
  scope: RetrieverScope,
  search: SearchConfig,
  records: Context.Context<Computations.ComputationStore | Blobs.BlobStore>,
  report: (record: Record<string, unknown>) => void,
) =>
  Effect.gen(function* () {
    const runtime = scope.runtime ?? searchRuntime();
    const timed = <A, E>(step: string, work: Effect.Effect<A, E>) =>
      Effect.forkChild(
        Effect.gen(function* () {
          const result = yield* Effect.result(
            work.pipe(
              Effect.withSpan("harness.prewarm", {
                attributes: { "harness.prewarm.step": step },
              }),
            ),
          );
          report({
            type: "search.prewarm",
            step,
            ...(result._tag === "Success"
              ? { ok: true }
              : {
                  ok: false,
                  error: String(
                    (result.failure as { message?: unknown }).message ??
                      result.failure,
                  ).slice(0, 300),
                }),
          });
        }),
      );
    if (search.graph !== null && runtime.graph !== undefined)
      yield* timed(
        "graph-snapshot",
        prepareBase(
          scope.repository,
          scope.commit,
          runtime.graph,
          search.graph.engine.sha256,
        ),
      );
    const e0 = runtime.e0;
    if (search.e0 !== null && e0 !== undefined) {
      yield* timed(
        "e0-vectors",
        Effect.gen(function* () {
          const { index } = yield* indexOf(
            scope.repository,
            scope.tree,
            scope.source,
          );
          const vectors = yield* treeVectors(index, e0);
          report({
            type: "search.e0-vectors",
            tree: index.tree,
            chunks: index.chunks.length,
            withVectors: vectors.docs.length,
            missing: vectors.missing,
            loadMs: vectors.loadMs,
          });
        }).pipe(Effect.provide(records)),
      );
      yield* timed(
        "e0-encoder",
        Effect.tryPromise(async () => {
          const encoded = await encodeQuery(e0, "warm up");
          if (encoded.kind === "refusal")
            throw new Error(`the E0 encoder refused: ${encoded.reason}`);
        }),
      );
    }
  });
