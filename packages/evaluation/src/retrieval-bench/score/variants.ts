import { Effect } from "effect";
import { chunkText } from "../corpus.ts";
import { weightedFusion } from "../fusion.ts";
import { gitText } from "../git.ts";
import { DEEP_TOKENS, POOL_DEPTH } from "../retriever.ts";
import type { HubHunk } from "./hubs.ts";
import { familyMean } from "./metrics.ts";
import type { Item, Ranking } from "../ranking.ts";
import { hubScore, normalised, type Bank } from "../rescoring.ts";

/**
 * The hub variants of 9.32 (research/hub-signals.md), as post-processing over the frozen pools and
 * deep rankings; nothing is re-indexed and no model is called.
 * - V1: rescoring by retrieval frequency (NNN/CSLS style), in ../rescoring.ts, which the reranker
 *   job (V3b's pairs) shares.
 * - V2: duplicate collapse (identical text, line overlap, MinHash near-duplicates) over the top of
 *   the ranking, then xQuAD diversity over the identifiers of the hunk's changed lines.
 * - V3: the cross-encoder reranker over stored reranker scores. V3a is R itself; V3b is 9.32's
 *   order (9.48), V1 rescoring then R over the rescored top 50 (../rescore-rerank.ts).
 * - V4: dev-tuned convex fusion of normalised scores with a per-source popularity correction, set
 *   against RRF over the same lists.
 * Every knob is tuned on dev only by family-mean necessary recall at the Opus real share; the grids,
 * the choice and a leave-one-family-out estimate are recorded.
 */

export interface VariantHunk extends HubHunk {
  readonly base: string;
  readonly queryText: string;
}

// ---------------------------------------------------------------- V2

export const V2_WINDOW = 200;
export const V2_OVERLAP = 0.5;
export const V2_JACCARD = 0.8;
const MINHASHES = 64;
export const V2_GRID: ReadonlyArray<{ readonly lambda: number }> = [
  0, 0.1, 0.2, 0.3,
].map((lambda) => ({ lambda }));

const STOP = new Set(
  "const let var function return import export from await async yield true false null undefined this new type interface string number boolean void any unknown never class extends implements public private protected readonly static if else for while switch case break continue default throw try catch finally typeof instanceof keyof the and with that".split(
    " ",
  ),
);
export const identifiers = (text: string) =>
  new Set(
    (text.match(/[A-Za-z_$][A-Za-z0-9_$]{2,}/g) ?? []).filter(
      (word) => !STOP.has(word),
    ),
  );

/** The query's identifiers after its `path:` and `symbol:` header: the changed lines' aspects. */
export const aspectsOf = (queryText: string) => {
  const body = queryText.split("\n").slice(3).join("\n");
  return identifiers(body);
};

const hash32 = (text: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};

export const minhash = (text: string) => {
  const tokens = text.match(/\S+/g) ?? [];
  const signature = new Uint32Array(MINHASHES).fill(0xffffffff);
  const shingles =
    tokens.length < 5
      ? [tokens.join(" ")]
      : tokens.slice(4).map((_, i) => tokens.slice(i, i + 5).join(" "));
  for (const shingle of shingles) {
    const base = hash32(shingle);
    for (let j = 0; j < MINHASHES; j++) {
      const value =
        (Math.imul(base ^ (0x9e3779b9 * (j + 1)), 0x85ebca6b) ^
          (j * 0xc2b2ae35)) >>>
        0;
      if (value < (signature[j] as number)) signature[j] = value;
    }
  }
  return signature;
};

const similarity = (a: Uint32Array, b: Uint32Array) => {
  let same = 0;
  for (let j = 0; j < MINHASHES; j++) if (a[j] === b[j]) same++;
  return same / MINHASHES;
};

const lineOverlap = (a: Item, b: Item) => {
  if (a.path !== b.path) return 0;
  const shared =
    Math.min(a.endLine, b.endLine) - Math.max(a.startLine, b.startLine) + 1;
  if (shared <= 0) return 0;
  return (
    shared / Math.min(a.endLine - a.startLine + 1, b.endLine - b.startLine + 1)
  );
};

export type Texts = ReadonlyMap<string, string>;
const textKey = (hunk: VariantHunk, item: Item) =>
  `${hunk.repository}\u0000${hunk.base}\u0000${item.key}`;

/** Texts of the window's items: chunk text from the store, Graph regions from git at the base. */
export const fetchTexts = (
  rankings: ReadonlyArray<ReadonlyMap<string, Ranking>>,
  hunks: ReadonlyArray<VariantHunk>,
  repositories: Readonly<Record<string, string>>,
) =>
  Effect.gen(function* () {
    const texts = new Map<string, string>();
    const files = new Map<string, Array<string>>();
    for (const hunk of hunks)
      for (const map of rankings)
        for (const item of map.get(hunk.hunkId)?.items.slice(0, V2_WINDOW) ??
          []) {
          const key = textKey(hunk, item);
          if (texts.has(key)) continue;
          if (item.hash !== null) {
            texts.set(key, yield* chunkText(item.hash));
            continue;
          }
          const fileKey = `${hunk.repository}\u0000${hunk.base}\u0000${item.path}`;
          let lines = files.get(fileKey);
          if (lines === undefined) {
            const content = yield* gitText(
              repositories[hunk.repository] as string,
              ["cat-file", "blob", `${hunk.base}:${item.path}`],
            ).pipe(Effect.orElseSucceed(() => ""));
            lines = content.split("\n");
            files.set(fileKey, lines);
          }
          texts.set(
            key,
            lines.slice(item.startLine - 1, item.endLine).join("\n"),
          );
        }
    return texts;
  });

/** Collapse duplicates in the window: identical text, ≥ 50% line overlap, or MinHash ≥ 0.8. */
export const collapse = (ranking: Ranking, textOf: (item: Item) => string) => {
  const size = Math.min(V2_WINDOW, ranking.items.length);
  const keptItems: Array<Item> = [];
  const keptScores: Array<number> = [];
  const signatures: Array<Uint32Array> = [];
  const hashes = new Set<string>();
  let dropped = 0;
  for (let index = 0; index < size; index++) {
    const item = ranking.items[index] as Item;
    const text = textOf(item);
    const signature = minhash(text);
    const duplicate =
      (item.hash !== null && hashes.has(item.hash)) ||
      keptItems.some((kept) => lineOverlap(kept, item) >= V2_OVERLAP) ||
      signatures.some((other) => similarity(other, signature) >= V2_JACCARD);
    if (duplicate) {
      dropped++;
      continue;
    }
    if (item.hash !== null) hashes.add(item.hash);
    keptItems.push(item);
    keptScores.push(ranking.scores[index] ?? 0);
    signatures.push(signature);
  }
  return {
    window: { items: keptItems, scores: keptScores },
    tail: {
      items: ranking.items.slice(size),
      scores: ranking.scores.slice(size),
    },
    dropped,
  };
};

/**
 * xQuAD with binary aspect coverage: each step takes the item maximising
 * (1 − λ)·relevance + λ·(share of the hunk's aspects it covers that no chosen item covers yet).
 */
export const xquad = (
  window: Ranking,
  aspectSets: ReadonlyArray<ReadonlySet<string>>,
  aspects: ReadonlySet<string>,
  lambda: number,
): Ranking => {
  if (lambda === 0 || aspects.size === 0) return window;
  const relevance = normalised(window.scores);
  const weight = 1 / aspects.size;
  const gain = aspectSets.map(
    (set) => [...set].filter((aspect) => aspects.has(aspect)).length * weight,
  );
  const holders = new Map<string, Array<number>>();
  aspectSets.forEach((set, index) => {
    for (const aspect of set)
      if (aspects.has(aspect))
        holders.set(aspect, [...(holders.get(aspect) ?? []), index]);
  });
  const chosen = new Array<boolean>(window.items.length).fill(false);
  const items: Array<Item> = [];
  const scores: Array<number> = [];
  for (let step = 0; step < window.items.length; step++) {
    let best = -1;
    let bestValue = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < window.items.length; index++) {
      if (chosen[index]) continue;
      const value =
        (1 - lambda) * (relevance[index] ?? 0) + lambda * (gain[index] ?? 0);
      if (value > bestValue + 1e-15) {
        best = index;
        bestValue = value;
      }
    }
    chosen[best] = true;
    items.push(window.items[best] as Item);
    scores.push(bestValue);
    for (const aspect of aspectSets[best] ?? []) {
      const list = holders.get(aspect);
      if (list === undefined) continue;
      for (const other of list) gain[other] = (gain[other] ?? 0) - weight;
      holders.delete(aspect);
    }
  }
  return { items, scores };
};

export const v2 = (
  rankings: ReadonlyMap<string, Ranking>,
  hunks: ReadonlyArray<VariantHunk>,
  texts: Texts,
  lambda: number,
) => {
  const out = new Map<string, Ranking>();
  let dropped = 0;
  for (const hunk of hunks) {
    const ranking = rankings.get(hunk.hunkId);
    if (ranking === undefined) continue;
    const textOf = (item: Item) => texts.get(textKey(hunk, item)) ?? "";
    const collapsed = collapse(ranking, textOf);
    dropped += collapsed.dropped;
    const aspectSets = collapsed.window.items.map((item) =>
      identifiers(`${item.path}\n${textOf(item)}`),
    );
    const diversified = xquad(
      collapsed.window,
      aspectSets,
      aspectsOf(hunk.queryText),
      lambda,
    );
    out.set(hunk.hunkId, {
      items: [...diversified.items, ...collapsed.tail.items],
      scores: [
        ...diversified.scores,
        ...collapsed.tail.scores.map((_, index) => -2 - index * 1e-9),
      ],
    });
  }
  return { rankings: out, dropped };
};

// ---------------------------------------------------------------- V4

export interface V4Params {
  readonly weights: readonly [number, number, number];
  readonly beta: number;
}
/** Weights for [G-fork projected, L, dense] on the simplex in steps of 0.1, and the correction. */
export const V4_GRID: ReadonlyArray<V4Params> = (() => {
  const out: Array<V4Params> = [];
  for (const beta of [0, 0.25, 0.5])
    for (let g = 0; g <= 10; g++)
      for (let l = 0; l + g <= 10; l++)
        out.push({ weights: [g / 10, l / 10, (10 - g - l) / 10], beta });
  return out;
})();

export const v4 = (
  sources: ReadonlyArray<ReadonlyMap<string, Ranking>>,
  banks: ReadonlyArray<Bank>,
  hunks: ReadonlyArray<VariantHunk>,
  params: V4Params,
) => {
  const out = new Map<string, Ranking>();
  for (const hunk of hunks) {
    const byKey = new Map<string, Item>();
    const lists = sources.map((source, index) => {
      const ranking = source.get(hunk.hunkId);
      if (ranking === undefined) return [];
      const values = normalised(ranking.scores);
      return ranking.items.map((item, rank) => {
        byKey.set(item.key, item);
        const hub =
          params.beta === 0
            ? 0
            : hubScore(
                banks[index] as Bank,
                `${hunk.repository}\u0000${item.key}`,
                hunk.family,
                10,
              );
        return { id: item.key, score: (values[rank] ?? 0) - params.beta * hub };
      });
    });
    const fused = weightedFusion(lists, params.weights);
    const items: Array<Item> = [];
    const scores: Array<number> = [];
    let total = 0;
    for (const entry of fused) {
      if (items.length >= POOL_DEPTH && total >= DEEP_TOKENS) break;
      const item = byKey.get(entry.id) as Item;
      total += item.tokens;
      items.push(item);
      scores.push(entry.score);
    }
    out.set(hunk.hunkId, { items, scores });
  }
  return out;
};

// ---------------------------------------------------------------- tuning

/**
 * Grid search on dev by a per-hunk objective. The grid is ordered simplest first, so ties keep the
 * simpler setting. A leave-one-family-out estimate chooses on the other families and scores the
 * left-out one, which says how much of the in-sample gain is selection.
 */
export const tune = <P>(
  grid: ReadonlyArray<P>,
  evaluate: (params: P) => ReadonlyMap<string, number | null>,
  hunks: ReadonlyArray<{
    readonly hunkId: string;
    readonly family: string;
    readonly caseId: string;
  }>,
) => {
  const scored = grid.map((params) => {
    const values = evaluate(params);
    return {
      params,
      values,
      mean: familyMean(
        hunks.map((hunk) => ({
          family: hunk.family,
          caseId: hunk.caseId,
          value: values.get(hunk.hunkId) ?? null,
        })),
      ).mean,
    };
  });
  const best = (keep: (hunk: { readonly family: string }) => boolean) => {
    let chosen = scored[0];
    let value = Number.NEGATIVE_INFINITY;
    for (const entry of scored) {
      const mean = familyMean(
        hunks.filter(keep).map((hunk) => ({
          family: hunk.family,
          caseId: hunk.caseId,
          value: entry.values.get(hunk.hunkId) ?? null,
        })),
      ).mean;
      if (mean !== null && mean > value + 1e-12) {
        chosen = entry;
        value = mean;
      }
    }
    return chosen;
  };
  const chosen = best(() => true);
  const families = [...new Set(hunks.map((hunk) => hunk.family))].sort();
  const crossValidated: Array<{
    family: string;
    caseId: string;
    value: number | null;
  }> = [];
  const picks: Record<string, P> = {};
  for (const family of families) {
    const pick =
      families.length > 1 ? best((hunk) => hunk.family !== family) : scored[0];
    if (pick === undefined) continue;
    picks[family] = pick.params;
    for (const hunk of hunks.filter((entry) => entry.family === family))
      crossValidated.push({
        family,
        caseId: hunk.caseId,
        value: pick.values.get(hunk.hunkId) ?? null,
      });
  }
  return {
    chosen: chosen?.params as P,
    inSample: chosen?.mean ?? null,
    leaveOneFamilyOut: familyMean(crossValidated).mean,
    picks,
    grid: scored.map((entry) => ({ params: entry.params, mean: entry.mean })),
  };
};
