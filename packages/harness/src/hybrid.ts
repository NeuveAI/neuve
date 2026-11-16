import { createHash } from "node:crypto";
import { Data, Effect, Metric, Option } from "effect";
import { z } from "zod";
import type { Blobs, Computations } from "@neuve/records-core";
import { cosineRanking } from "./e0.ts";
import { chunkTexts, type LocalTreeVectors } from "./hybrid-vectors.ts";
import {
  describeChunks,
  type HybridConfig,
  type RetrievalAnswer,
  type RetrievalQuery,
  type Retriever,
  type SearchResult,
} from "./retriever.ts";
import {
  bm25Ranking,
  indexRecipe,
  jsonComputation,
  storedOutput,
  type TreeIndex,
} from "./search-index.ts";

/**
 * Hybrid leads (9.61, 10.117): the benchmark's R(H3-E0), live. For one query:
 *
 * 1. BM25 and E0 (exact cosine over the tree's local vectors) rank every chunk; each list's head is
 *    cut at 256k tokens and no fewer than 50 items, its deep list at 512k (`retrieval-bench/run-
 *    pools.ts`, FUSION_INPUT_TOKENS and DEEP_TOKENS). Token counts are the chunks' own estimate;
 *    the benchmark counted with Qwen3's BPE, which only moves where a head ends far below the
 *    fused head the reranker reads.
 * 2. Graph's pool answer (top 50), projected onto the tree's chunks in its order
 *    (`projectToChunks`). If Graph has no answer, the fusion goes on without it and says so, as the
 *    benchmark's leads did.
 * 3. Layered reciprocal rank fusion, k = 60, Graph then BM25 then E0 (`fusion.ts`, `layeredRrf`):
 *    best first, ties by id.
 * 4. Qwen3-Reranker-0.6B over the fused list's top 50: by its score, ties by fused rank
 *    (`rerank.ts`, `rerankRow`). Each (query, document) score is stored under the benchmark's pair
 *    key with this machine's device, so a pair is scored once.
 *
 * Every result names its place in each source and the fused list (3.4). Each step is a span (10.97).
 */

export const RRF_K = 60;
const TAIL_STEP = 1e-9;

export interface Ranked {
  readonly id: string;
  readonly score: number;
}

const byCodepoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const order = (scores: Map<string, number>): Array<Ranked> =>
  [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || byCodepoint(a.id, b.id));

/** Reciprocal rank fusion, as `retrieval-bench/fusion.ts` `rrf` (unweighted). */
export const rrf = (
  lists: ReadonlyArray<ReadonlyArray<string>>,
  k = RRF_K,
): Array<Ranked> => {
  const scores = new Map<string, number>();
  for (const list of lists)
    list.forEach((id, rank) =>
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1)),
    );
  return order(scores);
};

/** `retrieval-bench/fusion.ts` `layeredRrf`: the fused heads, then the deeper lists' new items. */
export const layeredRrf = (
  heads: ReadonlyArray<ReadonlyArray<string>>,
  deeper: ReadonlyArray<ReadonlyArray<string>>,
  k = RRF_K,
): Array<Ranked> => {
  const head = rrf(heads, k);
  const seen = new Set(head.map((item) => item.id));
  let previous = head.at(-1)?.score ?? Number.POSITIVE_INFINITY;
  const tail: Array<Ranked> = [];
  for (const item of rrf(deeper, k)) {
    if (seen.has(item.id)) continue;
    previous = Math.min(previous - TAIL_STEP, item.score);
    tail.push({ id: item.id, score: previous });
  }
  return [...head, ...tail];
};

/** A ranked list cut where it holds `maxTokens` and at least `minItems` items (`chunkRegions`). */
export const cutByTokens = <T>(
  ranked: ReadonlyArray<T>,
  tokensOf: (item: T) => number,
  maxTokens: number,
  minItems: number,
): Array<T> => {
  const out: Array<T> = [];
  let total = 0;
  for (const item of ranked) {
    if (out.length >= minItems && total >= maxTokens) break;
    out.push(item);
    total += tokensOf(item);
  }
  return out;
};

/**
 * A doc's id in the fusion: the benchmark's chunk id (`corpus.ts` `chunkId`, path and lines), so
 * tied scores break in the benchmark's order and one blob at two paths is two items.
 */
export const fusionId = (index: TreeIndex, doc: number) => {
  const chunk = index.chunks[doc]!;
  return `${chunk.path}#L${chunk.startLine}-L${chunk.endLine}`;
};

/**
 * Graph's regions projected onto the tree's chunks, in Graph's order: every chunk on the region's
 * path that overlaps its lines, each once (`retriever.ts` `projectToChunks` in the benchmark).
 */
export const projectRegions = (
  index: TreeIndex,
  regions: ReadonlyArray<{
    readonly path: string;
    readonly startLine: number;
    readonly endLine: number;
  }>,
) => {
  const seen = new Set<number>();
  const out: Array<number> = [];
  for (const region of regions)
    for (const doc of index.byPath.get(region.path) ?? []) {
      const chunk = index.chunks[doc]!;
      if (
        chunk.startLine <= region.endLine &&
        chunk.endLine >= region.startLine &&
        !seen.has(doc)
      ) {
        seen.add(doc);
        out.push(doc);
      }
    }
  return out;
};

/** The reranker's model identity, as the benchmark keys its pair scores (`modelIdentity(MODELS.R)`). */
export const BENCH_R_IDENTITY = {
  hfId: "Qwen/Qwen3-Reranker-0.6B",
  revision: "e61197ed45024b0ed8a2d74b80b4d909f1255473",
  weights: {
    "model.safetensors":
      "27cd75a405b9c1b46b59abfd88aaa209e6fed2a1972cde9b70e7659537c5e65b",
  },
  adapter: null,
  recipe: "qwen3-reranker-model-card-v1",
  pooling: "softmax over the last position's no/yes logits",
  dimensions: 0,
  maxTokens: 8192,
  device: "cuda",
  dtype: "float32",
  rerank: {
    instruction:
      "Given a code change, retrieve the code and documentation a reviewer needs to judge it",
    prefix:
      '<|im_start|>system\nJudge whether the Document meets the requirements based on the Query and the Instruct provided. Note that the answer can only be "yes" or "no".<|im_end|>\n<|im_start|>user\n',
    suffix: "<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n",
  },
} as const;

/** The reranker's document: the benchmark's R format, the path then the chunk's text. */
export const rerankDocument = (path: string, text: string) =>
  `${path}\n${text}`;

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

/** One (query, document) score, keyed as the benchmark's `bench.rerank` with this machine's device. */
export const pairSpec = (
  querySha256: string,
  document: string,
  device: HybridConfig["reranker"]["runner"]["device"],
): Computations.ComputationSpec => ({
  op: "bench.rerank",
  opVersion: 1,
  inputs: {
    query: `blob:${querySha256}`,
    document: `blob:${sha256(document)}`,
  },
  config: { model: { ...BENCH_R_IDENTITY, device } },
});

const PairScore = z.number();

export class RerankerUnavailable extends Data.TaggedError(
  "RerankerUnavailable",
)<{ readonly message: string }> {}

/**
 * The reranker (port): Qwen3-Reranker-0.6B on this machine, scoring documents against one query
 * with the benchmark's prompt and yes-no softmax. A long-lived process; one call per hunk. Calls
 * may overlap (the job reranks `HYBRID_HUNK_CONCURRENCY` hunks at once): the runner queues them.
 */
export interface PairReranker {
  readonly device: HybridConfig["reranker"]["runner"]["device"];
  readonly workerSha256: string;
  readonly score: (
    query: string,
    documents: ReadonlyArray<string>,
  ) => Effect.Effect<
    {
      readonly scores: ReadonlyArray<number>;
      readonly truncated: ReadonlyArray<boolean>;
    },
    RerankerUnavailable
  >;
}

/** The E0 query vector (port): `e0.ts` `queryVector` over the semantic client in the product. */
export type QueryVector = (text: string) => Effect.Effect<
  {
    readonly vector: Float32Array;
    readonly cut: ReadonlyArray<string>;
    /** Computed now rather than read back (a job's progress). */
    readonly encoded?: boolean | undefined;
  },
  unknown,
  Computations.ComputationStore | Blobs.BlobStore
>;

/** Graph's pool answer for a query, or why there is none (the fusion goes on without it). */
export type GraphPool = (
  query: RetrievalQuery,
) => Effect.Effect<
  | { readonly kind: "answered"; readonly results: ReadonlyArray<SearchResult> }
  | { readonly kind: "failed" | "timeout"; readonly reason: string },
  never,
  Computations.ComputationStore | Blobs.BlobStore
>;

export interface HybridParts {
  readonly vectors: LocalTreeVectors;
  readonly queryVector: QueryVector;
  readonly graph: GraphPool;
  readonly reranker: PairReranker;
}

/** Hybrid timings (10.97): one value per hunk and step, by `harness.hybrid.step`. */
export const HYBRID_METRICS = {
  step: Metric.histogram("harness.hybrid.step.duration", {
    description: "One step of a hunk's hybrid leads",
    boundaries: [
      0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120,
    ],
  }),
  /** Reranker pairs by `harness.hybrid.pair` (`stored`, read back; `scored`, by the model now). */
  pairs: Metric.counter("harness.hybrid.rerank.pairs", {
    description: "Reranker pairs read back or scored",
    incremental: true,
  }),
} as const;

const timedStep = <A, E, R>(
  name: string,
  effect: Effect.Effect<A, E, R>,
  attributes?: (value: A) => Record<string, unknown>,
) =>
  Effect.suspend(() => {
    const started = performance.now();
    return effect.pipe(
      Effect.tap((value) =>
        Effect.andThen(
          attributes === undefined
            ? Effect.void
            : Effect.annotateCurrentSpan(attributes(value)),
          Metric.update(
            Metric.withAttributes(HYBRID_METRICS.step, {
              "harness.hybrid.step": name,
            }),
            (performance.now() - started) / 1_000,
          ),
        ),
      ),
      Effect.withSpan(`harness.hybrid.${name}`),
    );
  });

export interface HybridRanking {
  /** Fused docs with their rank and score in each source and the fusion, and their rerank score. */
  readonly ranked: ReadonlyArray<{
    readonly doc: number;
    readonly score: number;
    readonly sources: NonNullable<SearchResult["retrieval"]["sources"]>;
  }>;
  readonly graph: "answered" | "failed" | "timeout";
  readonly gaps: ReadonlyArray<string>;
}

/** The hybrid ranking of one query over the tree's index: fused, then reranked at the head. */
export const hybridRanking = (
  repository: string,
  index: TreeIndex,
  config: HybridConfig,
  parts: HybridParts,
  query: RetrievalQuery,
) =>
  Effect.gen(function* () {
    const { fusion } = config;
    const tokensOf = (doc: number) => index.chunks[doc]?.tokens ?? 0;
    const lists = (ranked: ReadonlyArray<{ doc: number; score: number }>) => {
      const docs = ranked.map((item) => item.doc);
      return {
        scores: new Map(ranked.map((item) => [item.doc, item.score])),
        head: cutByTokens(docs, tokensOf, fusion.inputTokens, fusion.minItems),
        deep: cutByTokens(docs, tokensOf, fusion.deepTokens, fusion.minItems),
      };
    };
    const bm25 = yield* timedStep(
      "search.bm25",
      Effect.sync(() => lists(bm25Ranking(index, query.text))),
      (value) => ({ "harness.items": value.deep.length }),
    );
    const e0 = yield* timedStep(
      "search.e0",
      Effect.map(parts.queryVector(query.text), (encoded) =>
        lists(cosineRanking(parts.vectors, encoded.vector)),
      ),
      (value) => ({ "harness.items": value.deep.length }),
    );
    const graphAnswer = yield* timedStep(
      "search.graph",
      parts.graph(query),
      (value) => ({ "harness.graph.status": value.kind }),
    );
    const graphDocs =
      graphAnswer.kind === "answered"
        ? projectRegions(
            index,
            graphAnswer.results.map((result) => result.identity),
          )
        : [];
    const gaps: Array<string> = [];
    if (graphAnswer.kind !== "answered")
      gaps.push(
        `Graph had no answer (${graphAnswer.kind}: ${graphAnswer.reason}), so the fusion is keyword search and E0 only`,
      );
    if (parts.vectors.refused.length > 0)
      gaps.push(
        `${parts.vectors.refused.length} of ${index.chunks.length} chunks are over E0's 8,192 tokens and have no vector; E0 did not search them`,
      );
    const id = (doc: number) => fusionId(index, doc);
    const docOf = new Map<string, number>();
    for (const doc of [...graphDocs, ...bm25.deep, ...e0.deep])
      docOf.set(id(doc), doc);
    const fused = yield* timedStep(
      "fuse",
      Effect.sync(() =>
        layeredRrf(
          [graphDocs.map(id), bm25.head.map(id), e0.head.map(id)],
          [graphDocs.map(id), bm25.deep.map(id), e0.deep.map(id)],
          fusion.k,
        ),
      ),
      (value) => ({ "harness.items": value.length }),
    );
    const head = fused.slice(0, config.reranker.depth);
    const headDocs = head.map((item) => docOf.get(item.id)!);
    const texts = yield* chunkTexts(
      repository,
      headDocs.map((doc) => index.chunks[doc]!),
    );
    const documents = headDocs.map((doc) => {
      const chunk = index.chunks[doc]!;
      return rerankDocument(chunk.path, texts.get(chunk) ?? "");
    });
    const scores = yield* rerankHead(
      parts.reranker,
      query,
      documents,
      config.reranker.runner.device,
    );
    const rankIn = (list: ReadonlyArray<number>) =>
      new Map(list.map((doc, at) => [doc, at + 1]));
    const bm25Rank = rankIn(bm25.deep);
    const e0Rank = rankIn(e0.deep);
    const graphRank = rankIn(graphDocs);
    const sourceOf = (
      doc: number,
      ranks: ReadonlyMap<number, number>,
      scoreOf: (doc: number) => number,
    ) => {
      const rank = ranks.get(doc);
      return rank === undefined
        ? null
        : { rank, score: Number(scoreOf(doc).toPrecision(9)) };
    };
    const reordered = headDocs
      .map((_, at) => at)
      .sort((a, b) => (scores[b] ?? 0) - (scores[a] ?? 0) || a - b);
    return {
      ranked: reordered.map((at) => {
        const doc = headDocs[at]!;
        return {
          doc,
          score: scores[at] ?? 0,
          sources: {
            bm25: sourceOf(doc, bm25Rank, (d) => bm25.scores.get(d) ?? 0),
            e0: sourceOf(doc, e0Rank, (d) => e0.scores.get(d) ?? 0),
            // Graph's order is its score: a projected chunk takes its place in that order.
            graph: sourceOf(doc, graphRank, (d) => 1 / (graphRank.get(d) ?? 1)),
            fused: {
              rank: at + 1,
              score: Number(head[at]!.score.toPrecision(9)),
            },
            rerank: { score: Number((scores[at] ?? 0).toPrecision(9)) },
          },
        };
      }),
      graph: graphAnswer.kind,
      gaps,
    } satisfies HybridRanking;
  });

/**
 * The reranker's scores for the head's documents: stored pairs read back, the rest scored in one
 * call and stored. A span with how many were read back, scored and truncated by the model's window.
 */
export const rerankHead = (
  reranker: PairReranker,
  query: RetrievalQuery,
  documents: ReadonlyArray<string>,
  device: HybridConfig["reranker"]["runner"]["device"],
) =>
  timedStep(
    "rerank",
    Effect.gen(function* () {
      const scores: Array<number> = [];
      const missing: Array<number> = [];
      for (const [at, document] of documents.entries()) {
        const stored = yield* storedOutput(
          pairSpec(query.sha256, document, device),
          PairScore,
        );
        if (Option.isSome(stored)) scores[at] = stored.value;
        else missing.push(at);
      }
      let truncated = 0;
      if (missing.length > 0) {
        const scored = yield* reranker.score(
          query.text,
          missing.map((at) => documents[at]!),
        );
        if (scored.scores.length !== missing.length)
          return yield* new RerankerUnavailable({
            message: `the reranker scored ${scored.scores.length} of ${missing.length} documents`,
          });
        for (const [position, at] of missing.entries()) {
          const score = scored.scores[position]!;
          if (!Number.isFinite(score))
            return yield* new RerankerUnavailable({
              message: "the reranker returned a score that is not a number",
            });
          scores[at] = score;
          if (scored.truncated[position] === true) truncated++;
          yield* jsonComputation(
            pairSpec(query.sha256, documents[at]!, device),
            PairScore,
            Effect.succeed(score),
          );
        }
      }
      yield* Metric.update(
        Metric.withAttributes(HYBRID_METRICS.pairs, {
          "harness.hybrid.pair": "stored",
        }),
        documents.length - missing.length,
      );
      yield* Metric.update(
        Metric.withAttributes(HYBRID_METRICS.pairs, {
          "harness.hybrid.pair": "scored",
        }),
        missing.length,
      );
      return {
        scores,
        stored: documents.length - missing.length,
        scored: missing.length,
        truncated,
      };
    }),
    (value) => ({
      "harness.hybrid.pairs.stored": value.stored,
      "harness.hybrid.pairs.scored": value.scored,
      "harness.hybrid.pairs.truncated": value.truncated,
      "harness.device": device,
    }),
  ).pipe(Effect.map((value) => value.scores));

/**
 * The hybrid retriever over a tree whose local vectors are complete. Commit time only (10.118): a
 * review reads its leads stored and never runs it. Its results are the tree's chunks, so every
 * lead is citable by path and lines (3.4).
 */
export const hybridRetriever = (
  repository: string,
  index: TreeIndex,
  config: HybridConfig,
  parts: HybridParts,
): Retriever => ({
  description: {
    id: "hybrid",
    family: "hybrid",
    config,
    index: indexRecipe(index.source),
  },
  tree: index.tree,
  search: (query) =>
    Effect.gen(function* () {
      const started = Date.now();
      const ranking = yield* hybridRanking(
        repository,
        index,
        config,
        parts,
        query,
      );
      const described = yield* describeChunks(
        repository,
        index,
        ranking.ranked,
        query,
        "hybrid",
        "current",
      );
      const byChunk = new Map(
        ranking.ranked.map((item) => [
          `${index.chunks[item.doc]!.chunkId}\0${index.chunks[item.doc]!.path}`,
          item.sources,
        ]),
      );
      const results = described.map((result) => {
        const sources = byChunk.get(
          `${result.identity.chunkId}\0${result.identity.path}`,
        );
        return sources === undefined
          ? result
          : { ...result, retrieval: { ...result.retrieval, sources } };
      });
      return {
        results,
        millis: Date.now() - started,
        coverage: {
          chunks: parts.vectors.docs.length,
          excluded: {
            ...index.excluded,
            ...(parts.vectors.refused.length > 0
              ? { "over-token-limit": parts.vectors.refused.length }
              : {}),
          },
        },
        gaps: ranking.gaps,
      } satisfies RetrievalAnswer;
    }).pipe(
      Effect.withSpan("harness.retriever.search", {
        attributes: {
          "harness.retriever": "hybrid",
          "harness.tree": index.tree,
        },
      }),
    ),
});
