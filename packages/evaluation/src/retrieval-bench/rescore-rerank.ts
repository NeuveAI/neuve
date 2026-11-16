import { Effect, Option } from "effect";
import { chunkText } from "./corpus.ts";
import { DENSE_IDS, type ModelEntry } from "./models.ts";
import type { HunkQuery } from "./queries.ts";
import { storedPairScore } from "./rerank.ts";
import { POOL_DEPTH } from "./retriever.ts";
import type { Item, Ranking } from "./ranking.ts";
import { V1_GRID, buildBank, v1, type RescoreHunk } from "./rescoring.ts";

/**
 * V3b (9.48): 9.32's reranker variant in its own order. Frequency rescoring (V1) runs first, then R
 * reranks the top 50 of the rescored list; the rest of the V1 list follows below every reranker
 * score, as for R. V1's setting is tuned on dev with the other variants, and the arm it runs over is
 * chosen on dev gold, so the reranker pairs are scored ahead for every V1 grid setting over every
 * chunk list V1 can run on (Graph regions are not chunks R reads): L, each dense arm and each
 * dense arm's G-fork + L + D fusion. Scores live under R's pair key (model identity, query hash,
 * document hash), so a pair R already scored is never scored again.
 */

export const rescoreRerankBases = (
  dense: ReadonlyArray<string> = DENSE_IDS,
): Array<string> => ["L", ...dense, ...dense.map((id) => `H3-${id}`)];

/**
 * The distinct items in any V1 grid setting's top 50 over any of the bases, per hunk (keyed by
 * span), in first-seen order: the reranker pairs V3b can need before dev selection. One bank per
 * base, as the scorer builds it; only the top 50s are kept.
 */
export const headItems = (
  rankings: ReadonlyMap<string, ReadonlyMap<string, Ranking>>,
  hunks: ReadonlyArray<RescoreHunk>,
  bases: ReadonlyArray<string>,
): Map<string, Map<string, Item>> => {
  const out = new Map<string, Map<string, Item>>();
  for (const base of bases) {
    const map = rankings.get(base);
    if (map === undefined) continue;
    const bank = buildBank(map, hunks);
    for (const params of V1_GRID)
      for (const [hunkId, ranking] of v1(map, hunks, params, { bank })) {
        const items = out.get(hunkId) ?? new Map<string, Item>();
        for (const item of ranking.items.slice(0, POOL_DEPTH))
          if (item.hash !== null && !items.has(item.key))
            items.set(item.key, item);
        out.set(hunkId, items);
      }
  }
  return out;
};

/** A chunk item as the reranker's document: the model's format over its path and stored text. */
export const itemDocument = (model: ModelEntry, item: Item) =>
  Effect.map(chunkText(item.hash as string), (text) =>
    model.format.document(item.path, text),
  );

/** Stored reranker scores for the items, by span key; unscored items are absent. */
export const storedScores = (
  model: ModelEntry,
  query: HunkQuery,
  items: Iterable<Item>,
) =>
  Effect.gen(function* () {
    const out = new Map<string, number>();
    for (const item of items) {
      const stored = yield* storedPairScore(
        model,
        query,
        yield* itemDocument(model, item),
      );
      if (Option.isSome(stored)) out.set(item.key, stored.value);
    }
    return out;
  });

/**
 * R over each hunk's top 50: the head sorted by reranker score (ties by the list's own rank), then
 * the rest of the list with scores below every reranker score. A hunk with an unscored head item is
 * left out and counted, never ranked on a guess.
 */
export const rerankHeads = (
  lists: ReadonlyMap<string, Ranking>,
  scores: ReadonlyMap<string, ReadonlyMap<string, number>>,
) => {
  const out = new Map<string, Ranking>();
  const unscored: Array<string> = [];
  for (const [hunkId, ranking] of lists) {
    const head = ranking.items.slice(0, POOL_DEPTH);
    const byKey = scores.get(hunkId);
    const headScores = head.map((item) => byKey?.get(item.key));
    if (headScores.some((score) => score === undefined)) {
      unscored.push(hunkId);
      continue;
    }
    const order = head
      .map((_, index) => index)
      .sort(
        (a, b) =>
          (headScores[b] as number) - (headScores[a] as number) || a - b,
      );
    const floor = Math.min(0, ...(headScores as Array<number>)) - 1;
    const tail = ranking.items.slice(POOL_DEPTH);
    out.set(hunkId, {
      items: [...order.map((index) => head[index] as Item), ...tail],
      scores: [
        ...order.map((index) => headScores[index] as number),
        ...tail.map((_, index) => floor - index * 1e-9),
      ],
    });
  }
  return { rankings: out, unscored };
};
