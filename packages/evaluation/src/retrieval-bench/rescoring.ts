import type { Item, Ranking } from "./ranking.ts";

/**
 * V1 (9.32, research/hub-signals.md): rescoring by retrieval frequency (NNN/CSLS style). Each item's
 * min-max normalised score minus alpha times its hub score, the mean of its top m normalised scores
 * over a bank of other-family dev queries (an item absent from a bank query's ranking scores 0
 * there). B4 tunes it on dev; the reranker job enumerates its grid to score pairs ahead.
 */

/** What V1 reads about a hunk: its id, family and repository. */
export interface RescoreHunk {
  readonly hunkId: string;
  readonly family: string;
  readonly repository: string;
}

export const normalised = (scores: ReadonlyArray<number>) => {
  if (scores.length === 0) return [];
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (const score of scores) {
    if (score < low) low = score;
    if (score > high) high = score;
  }
  const span = high - low;
  return scores.map((score) => (span === 0 ? 1 : (score - low) / span));
};

/** Re-sort by new scores, ties by the original rank. */
const resort = (
  items: ReadonlyArray<Item>,
  scores: ReadonlyArray<number>,
): Ranking => {
  const order = items
    .map((_, index) => index)
    .sort((a, b) => (scores[b] ?? 0) - (scores[a] ?? 0) || a - b);
  return {
    items: order.map((index) => items[index] as Item),
    scores: order.map((index) => scores[index] ?? 0),
  };
};

export interface V1Params {
  readonly alpha: number;
  readonly m: number;
}
export const V1_GRID: ReadonlyArray<V1Params> = [0, 0.25, 0.5, 0.75, 1].flatMap(
  (alpha) => [3, 10].map((m) => ({ alpha, m })),
);

export type Bank = Map<string, Array<{ family: string; value: number }>>;

/** Normalised scores of every item in every dev query's ranking (its head only, when given). */
export const buildBank = (
  rankings: ReadonlyMap<string, Ranking>,
  hunks: ReadonlyArray<RescoreHunk>,
  head = Number.POSITIVE_INFINITY,
): Bank => {
  const bank: Bank = new Map();
  for (const hunk of hunks) {
    const ranking = rankings.get(hunk.hunkId);
    if (ranking === undefined) continue;
    const size = Math.min(head, ranking.items.length);
    const values = normalised(ranking.scores.slice(0, size));
    for (let index = 0; index < size; index++) {
      const key = `${hunk.repository}\u0000${(ranking.items[index] as Item).key}`;
      const list = bank.get(key) ?? [];
      list.push({ family: hunk.family, value: values[index] ?? 0 });
      bank.set(key, list);
    }
  }
  for (const list of bank.values()) list.sort((a, b) => b.value - a.value);
  return bank;
};

export const hubScore = (
  bank: Bank,
  key: string,
  family: string,
  m: number,
) => {
  const list = bank.get(key);
  if (list === undefined) return 0;
  let sum = 0;
  let taken = 0;
  for (const entry of list) {
    if (entry.family === family) continue;
    sum += entry.value;
    if (++taken === m) break;
  }
  return sum / m;
};

export const v1 = (
  rankings: ReadonlyMap<string, Ranking>,
  hunks: ReadonlyArray<RescoreHunk>,
  params: V1Params,
  options: { readonly head?: number; readonly bank?: Bank } = {},
) => {
  const head = options.head ?? Number.POSITIVE_INFINITY;
  const bank = options.bank ?? buildBank(rankings, hunks, head);
  const out = new Map<string, Ranking>();
  for (const hunk of hunks) {
    const ranking = rankings.get(hunk.hunkId);
    if (ranking === undefined) continue;
    if (params.alpha === 0) {
      out.set(hunk.hunkId, ranking);
      continue;
    }
    const size = Math.min(head, ranking.items.length);
    const values = normalised(ranking.scores.slice(0, size));
    const rescored = values.map(
      (value, index) =>
        value -
        params.alpha *
          hubScore(
            bank,
            `${hunk.repository}\u0000${(ranking.items[index] as Item).key}`,
            hunk.family,
            params.m,
          ),
    );
    const top = resort(ranking.items.slice(0, size), rescored);
    out.set(hunk.hunkId, {
      items: [...top.items, ...ranking.items.slice(size)],
      scores: [
        ...top.scores,
        ...ranking.scores.slice(size).map((_, index) => -2 - index * 1e-9),
      ],
    });
  }
  return out;
};
