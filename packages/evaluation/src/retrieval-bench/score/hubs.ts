import { serve } from "./coverage.ts";
import { allowanceOf, familyMean, type HunkContext } from "./metrics.ts";
import type { GoldSpan, HunkGold, Share } from "./types.ts";
import type { Ranking } from "../ranking.ts";
import { recall } from "./coverage.ts";

/**
 * The generic hub measure of 9.32 (research/hub-signals.md): for each chunk, its k-occurrence, the
 * number of development queries that put it in their top k (Radovanović et al., 2010). Reported per
 * arm: the skew of the k-occurrence over the chunk population, and the share of the arm's served
 * tokens at the real share spent on the most-retrieved 1% of chunks. Necessary recall is split
 * between gold in often-retrieved and rarely-retrieved places by one reference measure shared by
 * every arm, so a correction can be read as "raises the second without losing the first".
 */

/**
 * "Near the top" is the pool depth, the top 50 the labellers saw: with 71 dev queries a top 10 is too
 * sparse to separate hubs (no chunk reaches more than a handful of queries). The skew is also given
 * at k = 10.
 */
export const HUB_K = 50;
export const TOP_SHARE = 0.01;
/** A chunk reached by a single query is never a hub, whatever the 1% rank falls on. */
export const MIN_HUB_OCCURRENCE = 2;
/**
 * Pre-registered, not tuned: a gold target is in an often-retrieved place when an item overlapping
 * it is in the top HUB_K of at least this many other-family dev queries, averaged over the
 * reference arms.
 */
export const OFTEN_THRESHOLD = 2;

export interface HubHunk extends HunkContext {
  readonly repository: string;
}

const itemKey = (repository: string, key: string) =>
  `${repository}\u0000${key}`;

export const kOccurrence = (
  rankings: ReadonlyMap<string, Ranking>,
  hunks: ReadonlyArray<HubHunk>,
  k = HUB_K,
) => {
  const counts = new Map<string, number>();
  for (const hunk of hunks) {
    const ranking = rankings.get(hunk.hunkId);
    if (ranking === undefined) continue;
    for (const item of new Set(
      ranking.items.slice(0, k).map((entry) => entry.key),
    )) {
      const key = itemKey(hunk.repository, item);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
};

/** Sample skewness (third standardized moment) of the counts over the population, zeros included. */
export const skewness = (
  counts: ReadonlyMap<string, number>,
  populationSize: number,
) => {
  const n = Math.max(populationSize, counts.size);
  if (n === 0) return null;
  let sum = 0;
  for (const value of counts.values()) sum += value;
  const mu = sum / n;
  let m2 = 0;
  let m3 = 0;
  for (const value of counts.values()) {
    m2 += (value - mu) ** 2;
    m3 += (value - mu) ** 3;
  }
  const zeros = n - counts.size;
  m2 += zeros * mu ** 2;
  m3 += zeros * (-mu) ** 3;
  m2 /= n;
  m3 /= n;
  return m2 === 0 ? null : m3 / m2 ** 1.5;
};

export const armHubs = (
  rankings: ReadonlyMap<string, Ranking>,
  hunks: ReadonlyArray<HubHunk>,
  populationSize: number,
  share: Share = "opus",
) => {
  const counts = kOccurrence(rankings, hunks);
  const sorted = [...counts.values()].sort((a, b) => b - a);
  const n = Math.max(populationSize, counts.size);
  const rank = Math.max(1, Math.ceil(TOP_SHARE * n));
  // The 1% rank's count, ties included, and never below MIN_HUB_OCCURRENCE.
  const threshold = Math.max(MIN_HUB_OCCURRENCE, sorted[rank - 1] ?? 0);
  const top = new Set(
    [...counts.entries()]
      .filter(([, value]) => value >= threshold)
      .map(([key]) => key),
  );
  let servedTokens = 0;
  let topTokens = 0;
  for (const hunk of hunks) {
    const ranking = rankings.get(hunk.hunkId);
    if (ranking === undefined) continue;
    for (const entry of serve(ranking, allowanceOf(share, hunk))) {
      servedTokens += entry.tokens;
      if (top.has(itemKey(hunk.repository, entry.item.key)))
        topTokens += entry.tokens;
    }
  }
  return {
    k: HUB_K,
    queries: hunks.filter((hunk) => rankings.has(hunk.hunkId)).length,
    population: n,
    retrievedChunks: counts.size,
    maxOccurrence: sorted[0] ?? 0,
    skew: skewness(counts, n),
    skewAt10: skewness(kOccurrence(rankings, hunks, 10), n),
    topChunks: top.size,
    topThreshold: threshold,
    topBudgetShare: servedTokens === 0 ? null : topTokens / servedTokens,
  };
};

/**
 * The reference hub score of every gold target: the largest, over items overlapping it, of the
 * number of other-family dev queries that put the item in their top k, averaged over the reference
 * arms. Other-family only, so the target's own query (and its family's) never makes it a hub.
 */
export const referenceHubness = (
  reference: ReadonlyArray<ReadonlyMap<string, Ranking>>,
  hunks: ReadonlyArray<HubHunk>,
  golds: ReadonlyMap<string, HunkGold>,
  k = HUB_K,
) => {
  // repository + path → items seen in any top k, with the families of the queries per arm.
  const seen = new Map<
    string,
    Map<
      string,
      { startLine: number; endLine: number; families: Map<string, number> }
    >
  >();
  for (const rankings of reference)
    for (const hunk of hunks) {
      const ranking = rankings.get(hunk.hunkId);
      if (ranking === undefined) continue;
      for (const item of ranking.items.slice(0, k)) {
        const pathKey = itemKey(hunk.repository, item.path);
        const byKey = seen.get(pathKey) ?? new Map();
        const entry = byKey.get(item.key) ?? {
          startLine: item.startLine,
          endLine: item.endLine,
          families: new Map<string, number>(),
        };
        entry.families.set(
          hunk.family,
          (entry.families.get(hunk.family) ?? 0) + 1,
        );
        byKey.set(item.key, entry);
        seen.set(pathKey, byKey);
      }
    }
  const out = new Map<string, number>();
  const arms = Math.max(1, reference.length);
  for (const hunk of hunks) {
    const gold = golds.get(hunk.hunkId);
    if (gold === undefined) continue;
    for (const target of [...gold.necessary, ...gold.useful]) {
      let best = 0;
      for (const entry of seen
        .get(itemKey(hunk.repository, target.path))
        ?.values() ?? []) {
        if (
          entry.startLine > target.endLine ||
          entry.endLine < target.startLine
        )
          continue;
        let other = 0;
        for (const [family, count] of entry.families)
          if (family !== hunk.family) other += count;
        best = Math.max(best, other / arms);
      }
      out.set(`${hunk.hunkId}\u0000${target.id}`, best);
    }
  }
  return out;
};

/** Necessary recall at the real share, split by the reference hubness of each target. */
export const splitRecall = (
  rankings: ReadonlyMap<string, Ranking>,
  hunks: ReadonlyArray<HubHunk>,
  golds: ReadonlyMap<string, HunkGold>,
  hubness: ReadonlyMap<string, number>,
  share: Share = "opus",
) => {
  type Value = { family: string; caseId: string; value: number | null };
  const often: Array<Value> = [];
  const rare: Array<Value> = [];
  let oftenTargets = 0;
  let rareTargets = 0;
  for (const hunk of hunks) {
    const gold = golds.get(hunk.hunkId);
    const ranking = rankings.get(hunk.hunkId);
    if (gold === undefined || ranking === undefined) continue;
    const served = serve(ranking, allowanceOf(share, hunk));
    const split = (often: boolean) =>
      gold.necessary.filter(
        (target: GoldSpan) =>
          (hubness.get(`${hunk.hunkId}\u0000${target.id}`) ?? 0) >=
            OFTEN_THRESHOLD ===
          often,
      );
    const oftenList = split(true);
    const rareList = split(false);
    oftenTargets += oftenList.length;
    rareTargets += rareList.length;
    const { family, caseId } = hunk;
    often.push({ family, caseId, value: recall(oftenList, served) });
    rare.push({ family, caseId, value: recall(rareList, served) });
  }
  return {
    often: { ...familyMean(often), targets: oftenTargets },
    rare: { ...familyMean(rare), targets: rareTargets },
  };
};
