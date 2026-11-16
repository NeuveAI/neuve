import { byCodepoint } from "./policy.ts";
import type { SourceKind } from "./corpus.ts";

/**
 * Fusion and index topology over ranked chunk lists (proposal, section 4).
 * - Reciprocal rank fusion, k = 60, optionally weighted per list (H1, H2, H3, per-kind RRF).
 * - Weighted fusion of min-max normalised scores: the hook for the dev-tuned variant (9.32; Bruch,
 *   Gai and Ingber, 2023). B4 tunes the weights; B2 only provides the function.
 * - Per-kind token quotas: each kind's list in its own order, interleaved so that every prefix
 *   keeps each kind near its share of the tokens read so far.
 * Every output is best first with ties broken by chunk id.
 */

export const RRF_K = 60;

export interface Ranked {
  readonly id: string;
  readonly score: number;
}

const order = (scores: Map<string, number>): Array<Ranked> =>
  [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || byCodepoint(a.id, b.id));

export const rrf = (
  lists: ReadonlyArray<ReadonlyArray<string>>,
  options: {
    readonly k?: number;
    readonly weights?: ReadonlyArray<number>;
  } = {},
) => {
  const k = options.k ?? RRF_K;
  const scores = new Map<string, number>();
  lists.forEach((list, index) => {
    const weight = options.weights?.[index] ?? 1;
    list.forEach((id, rank) =>
      scores.set(id, (scores.get(id) ?? 0) + weight / (k + rank + 1)),
    );
  });
  return order(scores);
};

/** How far below the score before it a tied tail item is placed (RRF scores here are above 1e-5). */
const TAIL_STEP = 1e-9;

/**
 * RRF over input lists cut at a fixed depth (`heads`), extended by the same lists read deeper
 * (`deeper`, each a continuation of its head): the fused head keeps its exact order and scores, and
 * the items only the deeper lists hold follow in their RRF order over the deeper lists. Each tail
 * score is its RRF score where that is already below the score before it, else just below that
 * score: tail scores strictly decrease and stay below the head, so a re-sort by score (V1, V2)
 * keeps the tail's order instead of reading a tied block by hub score alone. This lets a fusion read
 * past its inputs' original cut without moving the items it already ranked.
 */
export const layeredRrf = (
  heads: ReadonlyArray<ReadonlyArray<string>>,
  deeper: ReadonlyArray<ReadonlyArray<string>>,
  options: { readonly k?: number } = {},
): Array<Ranked> => {
  const head = rrf(heads, options);
  const seen = new Set(head.map((item) => item.id));
  let previous = head.at(-1)?.score ?? Number.POSITIVE_INFINITY;
  const tail: Array<Ranked> = [];
  for (const item of rrf(deeper, options)) {
    if (seen.has(item.id)) continue;
    previous = Math.min(previous - TAIL_STEP, item.score);
    tail.push({ id: item.id, score: previous });
  }
  return [...head, ...tail];
};

/** Convex combination of each list's min-max normalised scores; an absent item scores 0 there. */
export const weightedFusion = (
  lists: ReadonlyArray<ReadonlyArray<Ranked>>,
  weights: ReadonlyArray<number>,
) => {
  const scores = new Map<string, number>();
  lists.forEach((list, index) => {
    if (list.length === 0) return;
    const values = list.map((item) => item.score);
    const low = Math.min(...values);
    const span = Math.max(...values) - low;
    const weight = weights[index] ?? 0;
    for (const item of list) {
      const normalised = span === 0 ? 1 : (item.score - low) / span;
      scores.set(item.id, (scores.get(item.id) ?? 0) + weight * normalised);
    }
  });
  return order(scores);
};

/**
 * Interleaves per-kind lists by token quota: the next item comes from the non-empty kind furthest
 * below its share (tokens taken ÷ share), ties in kind order. Kinds with no items give their share
 * to the rest.
 */
export const quotaInterleave = <T extends { readonly tokens: number }>(
  lists: ReadonlyMap<SourceKind, ReadonlyArray<T>>,
  shares: Readonly<Record<SourceKind, number>>,
  limit: number,
) => {
  const kinds = [...lists.keys()].filter(
    (kind) => (lists.get(kind)?.length ?? 0) > 0 && shares[kind] > 0,
  );
  const taken = new Map<SourceKind, number>(kinds.map((kind) => [kind, 0]));
  const position = new Map<SourceKind, number>(kinds.map((kind) => [kind, 0]));
  const out: Array<{ readonly kind: SourceKind; readonly item: T }> = [];
  while (out.length < limit) {
    let best: SourceKind | undefined;
    let bestRatio = Number.POSITIVE_INFINITY;
    for (const kind of kinds) {
      if ((position.get(kind) ?? 0) >= (lists.get(kind)?.length ?? 0)) continue;
      const ratio = (taken.get(kind) ?? 0) / shares[kind];
      if (ratio < bestRatio) {
        best = kind;
        bestRatio = ratio;
      }
    }
    if (best === undefined) break;
    const at = position.get(best) ?? 0;
    const item = lists.get(best)?.[at] as T;
    position.set(best, at + 1);
    taken.set(best, (taken.get(best) ?? 0) + Math.max(1, item.tokens));
    out.push({ kind: best, item });
  }
  return out;
};

/** Equal token shares: the untuned default; B4 tunes quotas on dev. */
export const EQUAL_SHARES: Readonly<Record<SourceKind, number>> = {
  code: 0.25,
  test: 0.25,
  doc: 0.25,
  plan: 0.25,
};

/** Extension point for additional graph-aware candidate arms before H3 reranking.
 * Both pool construction and deep reconstruction call this. New arms must supply
 * the same head/deep lists in both paths and name their recipes in the arm config.
 */
export const h3CandidateLists = <T>(
  graph: T,
  lexical: T,
  dense: T,
  extraGraph: readonly T[] = [],
): readonly T[] => [graph, lexical, dense, ...extraGraph];
