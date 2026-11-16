import type { OutlineSource } from "./graph-outline.ts";
import { repositoryOwner } from "./budget/owner.ts";
import { cpuWork } from "./budget/cpu.ts";
import { Effect } from "effect";
import { z } from "zod";
import type { Blobs, Computations } from "@neuve/records-core";
import { DeclaredKind } from "./declarations.ts";
import { CHUNK_RECIPE, splitLines } from "./chunker.ts";
import { readBlobs } from "./git-objects.ts";
import type { HunkRecord } from "./hunks.ts";
import {
  BM25,
  indexRecipe,
  bm25Ranking,
  chunkIdentifiers,
  specificIdentifiers,
  treeIndex,
  type TreeIndex,
} from "./search-index.ts";

/**
 * The retriever port (XC18, 10.25, 10.77): the shape of the benchmark's one retriever interface
 * (`packages/evaluation/src/retrieval-bench/retriever.ts`: a query in, ranked regions out, with the
 * arm's description and timing), without its path-derived `kind`, plus the metadata of 10.45 on
 * every result. BM25 is the default. 10.89 widens it to the retrievers of 9.61's stage: E0
 * (`e0.ts`), Graph's semantic query (`graph-search.ts`; never a structural tool, 10.10), and a
 * frozen candidate's leads file (`frozen.ts`), which the end-to-end
 * check serves under the candidate's own name instead of BM25's. 10.117 adds hybrid leads
 * (`hybrid.ts`): the three fused and reranked, computed at commit time and only read by a review. Every computation that uses a
 * retriever puts its `RetrieverConfig` in its key, so swapping it never reuses old leads, and each
 * config names the identities its results depend on (model revision and weights, vector backend,
 * engine build, the leads file's hash), never a path on this machine. `retrievers.ts` builds one.
 */

export const Bm25Config = z.strictObject({
  id: z.literal("bm25"),
  recipe: z.literal(BM25.recipe),
});
export type Bm25Config = z.infer<typeof Bm25Config>;

/**
 * E0 (9.61): untuned EmbeddingGemma 2 over the shared chunks, exact cosine. Chunk vectors come
 * from the benchmark's encoding contract (`documents`: the same model, revision, input recipe and
 * hardware as the benchmark's E0, so agents' searches and the seeded leads agree); queries are
 * encoded on this machine by `@neuve/semantic-client` (`queries`), whose drift against the
 * benchmark's query vectors is measured by the parity tool kept in the private archive.
 */
export const E0Config = z.strictObject({
  id: z.literal("e0"),
  model: z.strictObject({
    hfId: z.literal("google/embeddinggemma-2"),
    revision: z.string().regex(/^[0-9a-f]{40}$/),
    weightsSha256: z.string().regex(/^[0-9a-f]{64}$/),
    recipe: z.string().min(1),
  }),
  documents: z.strictObject({
    contract: z.literal("bench.encode-chunk@1"),
    device: z.string().min(1),
    dtype: z.literal("float32"),
    /**
     * Present when the chunk vectors are encoded on this machine (10.117) into the repository's own
     * store, under the same contract with this device in the model identity; absent for the
     * benchmark's own vectors. The two are never ranked together.
     */
    encoder: z
      .strictObject({
        name: z.literal("semantic-client-base"),
        workerSha256: z.string().regex(/^[0-9a-f]{64}$/),
      })
      .optional(),
  }),
  queries: z.strictObject({
    encoder: z.literal("semantic-client-base"),
    workerSha256: z.string().regex(/^[0-9a-f]{64}$/),
    /** The CPU for agents' E0 search; hybrid leads encode queries on their chunks' device. */
    device: z.enum(["cpu", "mps"]),
    dtype: z.literal("float32"),
  }),
});
export type E0Config = z.infer<typeof E0Config>;

/** Graph's semantic query (10.89) on the fork (9.62), over a complete full-profile base snapshot. */
export const GraphConfig = z.strictObject({
  id: z.literal("graph"),
  engine: z.strictObject({
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    provider: z.string().min(1),
    version: z.string().min(1),
    identityRevision: z.string().min(1),
  }),
  profile: z.literal("full"),
  topK: z.int().min(1).max(200),
});
export type GraphConfig = z.infer<typeof GraphConfig>;

/** The retrievers searched live, one at a time; `HybridConfig` fuses all three. */
export type SearchedConfig = Bm25Config | E0Config | GraphConfig;

/**
 * Qwen3-Reranker-0.6B as the benchmark's R arm ran it (`retrieval-bench/models.ts` `MODELS.R`,
 * its prompt and yes-no scoring), on this machine (10.117): the model's identity, where its scores
 * are computed, and how deep it reads the fused list (the benchmark's pool depth).
 */
export const RerankerConfig = z.strictObject({
  model: z.strictObject({
    hfId: z.literal("Qwen/Qwen3-Reranker-0.6B"),
    revision: z.string().regex(/^[0-9a-f]{40}$/),
    weightsSha256: z.string().regex(/^[0-9a-f]{64}$/),
    recipe: z.literal("qwen3-reranker-model-card-v1"),
    instruction: z.string().min(1),
  }),
  runner: z.strictObject({
    workerSha256: z.string().regex(/^[0-9a-f]{64}$/),
    device: z.enum(["cpu", "mps"]),
    dtype: z.literal("float32"),
  }),
  depth: z.literal(50),
});
export type RerankerConfig = z.infer<typeof RerankerConfig>;

/**
 * Hybrid leads (9.61, 10.117): Graph, BM25 and E0, each at the benchmark's depth, fused by
 * layered reciprocal rank fusion with k = 60 (`retrieval-bench/fusion.ts`, H3), then the reranker
 * over the fused list's head, as the benchmark's R(H3-E0) ranked the full test's leads. Computed at
 * commit time only (10.118); a review reads them stored and never waits for them.
 */
export const HybridConfig = z.strictObject({
  id: z.literal("hybrid"),
  members: z.strictObject({
    bm25: Bm25Config,
    e0: E0Config,
    graph: GraphConfig,
  }),
  fusion: z.strictObject({
    method: z.literal("layered-rrf"),
    k: z.literal(60),
    /** Each list's head is cut at this many tokens, and at no fewer than `minItems` items. */
    inputTokens: z.literal(256_000),
    deepTokens: z.literal(512_000),
    minItems: z.literal(50),
    /** The chunk's own estimate (`IndexedChunk.tokens`); the benchmark counted with Qwen3's BPE. */
    tokens: z.literal("chunk-estimate"),
  }),
  reranker: RerankerConfig,
});
export type HybridConfig = z.infer<typeof HybridConfig>;

/**
 * A frozen candidate's leads (the end-to-end check, 10.89): each matched hunk's ranking from a
 * leads file named by its SHA-256, under the candidate's own name; a hunk the file has no row for
 * gets the `fallback` retriever's leads, and its results name that retriever.
 */
export const FrozenConfig = z.strictObject({
  id: z.literal("frozen"),
  candidate: z.string().min(1).max(64),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  fallback: Bm25Config,
});
export type FrozenConfig = z.infer<typeof FrozenConfig>;

export const RetrieverConfig = z.discriminatedUnion("id", [
  Bm25Config,
  E0Config,
  GraphConfig,
  FrozenConfig,
  HybridConfig,
]);
export type RetrieverConfig = z.infer<typeof RetrieverConfig>;

export const DEFAULT_RETRIEVER: Bm25Config = {
  id: "bm25",
  recipe: BM25.recipe,
};

/** Where one source ranked a result. */
export const SourceRank = z.strictObject({
  rank: z.int().min(1),
  score: z.number(),
});

/** What a result says about where to look next (10.45). */
export const SearchResult = z.strictObject({
  identity: z.strictObject({
    /** The tree the index was built from: the revision the result was read at. */
    tree: z.string(),
    blobOid: z.string(),
    path: z.string(),
    startLine: z.int().min(1),
    endLine: z.int().min(1),
    chunkId: z.string(),
    recipe: z.string(),
  }),
  /** Declared kinds (10.23) or `undeclared`; never inferred from a name. */
  kind: z.union([z.array(DeclaredKind), z.literal("undeclared")]),
  /** The language the chunker's capability declares for the path, or `undeclared`. */
  language: z.string(),
  capability: z.string(),
  enclosing: z.strictObject({
    kind: z.enum(["symbol", "section", "window"]),
    name: z.string().nullable(),
    headingPath: z.array(z.string()),
  }),
  /** Functions and methods declared inside the chunk, where a parser read the file. */
  callables: z.array(z.string()),
  /** At most 8 specific identifiers (10.46), with how they were taken. */
  identifiers: z.strictObject({
    specific: z.array(z.string()).max(8),
    from: z.enum(["code-positions", "word-tokens"]),
  }),
  neighbours: z.strictObject({
    previous: z.string().nullable(),
    next: z.string().nullable(),
    outline: z.string(),
  }),
  retrieval: z.strictObject({
    retriever: z.string(),
    querySha256: z.string(),
    rank: z.int().min(1),
    score: z.number(),
    tokens: z.int().min(0),
    /** How many of the range's queries put this chunk in their top results (9.32's hub measure). */
    frequency: z.int().min(0).optional(),
    /**
     * A hybrid lead's provenance per source (3.4): where each member ranked the chunk (null when it
     * did not), its place in the fused list, and the reranker's score. `rank` and `score` above
     * are the reranker's.
     */
    sources: z
      .strictObject({
        bm25: SourceRank.nullable(),
        e0: SourceRank.nullable(),
        graph: SourceRank.nullable(),
        fused: SourceRank,
        rerank: z.strictObject({ score: z.number() }),
      })
      .optional(),
  }),
  coverage: z.strictObject({
    /** Vectors are not part of BM25; a dense retriever reports stale or missing ones here. */
    vectors: z.enum(["not-applicable", "current", "stale", "missing"]),
    /** Set when the result was reused from another tree and is no longer at that path in this one. */
    stale: z.boolean(),
  }),
});
export type SearchResult = z.infer<typeof SearchResult>;

export interface RetrievalQuery {
  readonly text: string;
  readonly sha256: string;
  readonly limit: number;
  /** Declared kinds to put first; filtering by kind only reorders, never excludes (10.45). */
  readonly kinds?: ReadonlyArray<DeclaredKind> | undefined;
}

export interface RetrievalAnswer {
  readonly results: ReadonlyArray<SearchResult>;
  readonly millis: number;
  /** Chunks the index searched, and what it left out by its safety bounds. */
  readonly coverage: {
    readonly chunks: number;
    readonly excluded: Readonly<Record<string, number>>;
  };
  /** What the retriever could not search this time (a member that failed, chunks with no vector). */
  readonly gaps?: ReadonlyArray<string> | undefined;
}

export interface Retriever {
  readonly description: {
    readonly id: string;
    readonly family: "lexical" | "dense" | "graph" | "frozen" | "hybrid";
    readonly config: RetrieverConfig;
    readonly index: ReturnType<typeof indexRecipe>;
    /**
     * What else this retriever's answers depend on here, beyond its config: E0's vector coverage
     * of the tree, a frozen candidate's range. Every computation keyed on the config also takes it.
     */
    readonly keyed?: Readonly<Record<string, string>> | undefined;
  };
  readonly tree: string;
  /** Runs in the caller's Records store, where a dense retriever keeps its query vectors. */
  readonly search: (
    query: RetrievalQuery,
  ) => Effect.Effect<
    RetrievalAnswer,
    unknown,
    Computations.ComputationStore | Blobs.BlobStore
  >;
  /**
   * A retriever that ranks by hunk rather than by query (a frozen candidate): the hunk's leads, or
   * undefined when it has none for the hunk and `search` answers instead.
   */
  readonly leadsFor?: (hunk: HunkRecord) => Effect.Effect<
    | {
        /** Absent: `search` answers instead, and `note` says why. */
        readonly results?: ReadonlyArray<SearchResult> | undefined;
        readonly note?: string | undefined;
      }
    | undefined,
    unknown
  >;
}

export const reorderByKind = <
  T extends { readonly kind: ReadonlyArray<DeclaredKind> | "undeclared" },
>(
  ranked: ReadonlyArray<T>,
  kinds: ReadonlyArray<DeclaredKind> | undefined,
) => {
  if (kinds === undefined || kinds.length === 0) return ranked;
  const wanted = (entry: T) =>
    entry.kind !== "undeclared" &&
    entry.kind.some((kind) => kinds.includes(kind));
  return [
    ...ranked.filter(wanted),
    ...ranked.filter((entry) => !wanted(entry)),
  ];
};

/** Results for ranked chunks of an index, with their metadata, named by `retriever`. */
export const describeChunks = (
  repository: string,
  index: TreeIndex,
  ranked: ReadonlyArray<{ readonly doc: number; readonly score: number }>,
  query: RetrievalQuery,
  retriever: string,
  vectors: SearchResult["coverage"]["vectors"] = "not-applicable",
) =>
  Effect.gen(function* () {
    const chunks = ranked.flatMap(({ doc, score }) => {
      const chunk = index.chunks[doc];
      return chunk === undefined
        ? []
        : [{ chunk, score, kind: chunk.declared }];
    });
    const ordered = reorderByKind(chunks, query.kinds).slice(0, query.limit);
    const bytes = yield* readBlobs(
      repository,
      ordered.map(({ chunk }) => chunk.blobOid),
    );
    return ordered.map(({ chunk, score }, position): SearchResult => {
      const content = bytes.get(chunk.blobOid);
      const text =
        content === undefined
          ? ""
          : splitLines(new TextDecoder().decode(content))
              .slice(chunk.startLine - 1, chunk.endLine)
              .join("");
      return {
        identity: {
          tree: index.tree,
          blobOid: chunk.blobOid,
          path: chunk.path,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          chunkId: chunk.chunkId,
          recipe: CHUNK_RECIPE,
        },
        kind:
          chunk.declared === "undeclared" ? "undeclared" : [...chunk.declared],
        language: chunk.language,
        capability: chunk.capability,
        enclosing: {
          kind: chunk.kind,
          name: chunk.symbol,
          headingPath: [...chunk.headingPath],
        },
        callables: [...chunk.callables],
        identifiers: {
          specific: specificIdentifiers(index, chunkIdentifiers(chunk, text)),
          from:
            chunk.parsedIdentifiers === null ? "word-tokens" : "code-positions",
        },
        neighbours: {
          previous: chunk.previous,
          next: chunk.next,
          outline: `${chunk.path}@${index.tree}`,
        },
        retrieval: {
          retriever,
          querySha256: query.sha256,
          rank: position + 1,
          score: Number(score.toPrecision(9)),
          tokens: chunk.tokens,
        },
        coverage: { vectors, stale: false },
      };
    });
  });

/** BM25 over a tree's index. */
export const bm25Retriever = (
  repository: string,
  index: TreeIndex,
  config: Bm25Config = DEFAULT_RETRIEVER,
): Retriever => ({
  description: {
    id: config.id,
    family: "lexical",
    config,
    index: indexRecipe(index.source),
  },
  tree: index.tree,
  search: (query) =>
    Effect.gen(function* () {
      const started = Date.now();
      const ranked = yield* cpuWork(
        repositoryOwner(repository),
        Effect.sync(() => bm25Ranking(index, query.text)),
      );
      // Reordering by kind may pull a lower result up, so it looks past the limit, never cuts it.
      const window = query.kinds === undefined ? query.limit : query.limit * 10;
      const results = yield* describeChunks(
        repository,
        index,
        ranked.slice(0, window),
        query,
        config.id,
      );
      return {
        results,
        millis: Date.now() - started,
        coverage: { chunks: index.chunks.length, excluded: index.excluded },
      };
    }).pipe(
      Effect.withSpan("harness.retriever.search", {
        attributes: {
          "harness.retriever": config.id,
          "harness.tree": index.tree,
        },
      }),
    ),
});

/** BM25 over a tree; the index is built or taken from memory. `retrievers.ts` builds any config. */
export const bm25RetrieverFor = (
  repository: string,
  tree: string,
  source: OutlineSource,
  config: Bm25Config = DEFAULT_RETRIEVER,
) =>
  Effect.map(treeIndex(repository, tree, source), ({ index, cached }) => ({
    retriever: bm25Retriever(repository, index, config),
    index,
    cached,
  }));
