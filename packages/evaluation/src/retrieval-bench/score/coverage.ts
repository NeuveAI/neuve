import {
  pooledKey,
  type GoldSpan,
  type HunkGold,
  type JudgedLabel,
} from "./types.ts";
import { type Item, type Ranking } from "../ranking.ts";

/**
 * The scoring core (proposal section 5, decisions 9.9, 9.11, 9.14, 9.19). Everything here is pure.
 *
 * Serving: items are read in rank order until the allowance is spent. The item that crosses the
 * allowance is served in part, its leading lines in proportion to the tokens left, because the
 * harness would cut a long region rather than drop it; an item with no tokens left gets no lines.
 *
 * Coverage: a gold region's credit is the share of its lines covered by the union of served lines
 * (the overlap rule, fractional), capped at 1 by construction. Any-line and at-least-50% are the
 * sensitivity variants. Recall is the mean credit over the hunk's targets of one grade, and is null
 * when the hunk has none. Unjudged items never count as irrelevant: rank metrics read only judged
 * items, and wrong attribution is a share of judged items (see JUDGED_RULE for what is judged).
 */

export interface Served {
  readonly item: Item;
  readonly rank: number;
  readonly startLine: number;
  /** Last served line; below startLine when nothing of the item was served. */
  readonly endLine: number;
  readonly tokens: number;
  readonly partial: boolean;
}

export const BOUNDARY_RULE =
  "the item crossing the allowance is served in part: its leading lines in proportion to the tokens left";

export const serve = (ranking: Ranking, allowance: number): Array<Served> => {
  const out: Array<Served> = [];
  let left = allowance;
  for (const [rank, item] of ranking.items.entries()) {
    if (item.tokens <= left) {
      out.push({
        item,
        rank,
        startLine: item.startLine,
        endLine: item.endLine,
        tokens: item.tokens,
        partial: false,
      });
      left -= item.tokens;
      continue;
    }
    const lines = item.endLine - item.startLine + 1;
    const keep = Math.floor((lines * left) / item.tokens);
    if (keep > 0)
      out.push({
        item,
        rank,
        startLine: item.startLine,
        endLine: item.startLine + keep - 1,
        tokens: left,
        partial: true,
      });
    break;
  }
  return out;
};

/** Top k items in full, for recall@k and rank views (no token cut). */
export const topK = (ranking: Ranking, k: number): Array<Served> =>
  ranking.items.slice(0, k).map((item, rank) => ({
    item,
    rank,
    startLine: item.startLine,
    endLine: item.endLine,
    tokens: item.tokens,
    partial: false,
  }));

/** Lines of `gold` covered by the union of served spans on its path. */
export const coveredLines = (
  gold: Pick<GoldSpan, "path" | "startLine" | "endLine">,
  served: ReadonlyArray<
    Pick<Served, "startLine" | "endLine"> & {
      readonly item: Pick<Item, "path">;
    }
  >,
) => {
  const parts: Array<[number, number]> = [];
  for (const entry of served) {
    if (entry.item.path !== gold.path) continue;
    const start = Math.max(entry.startLine, gold.startLine);
    const end = Math.min(entry.endLine, gold.endLine);
    if (start <= end) parts.push([start, end]);
  }
  parts.sort((a, b) => a[0] - b[0]);
  let total = 0;
  let reach = gold.startLine - 1;
  for (const [start, end] of parts) {
    if (end <= reach) continue;
    total += end - Math.max(start, reach + 1) + 1;
    reach = end;
  }
  return total;
};

export const OVERLAP_RULES = ["fractional", "anyLine", "half"] as const;
export type OverlapRule = (typeof OVERLAP_RULES)[number];

export const credit = (
  gold: Pick<GoldSpan, "path" | "startLine" | "endLine">,
  served: ReadonlyArray<Served>,
  rule: OverlapRule = "fractional",
) => {
  const length = gold.endLine - gold.startLine + 1;
  const share = coveredLines(gold, served) / length;
  return rule === "fractional"
    ? share
    : rule === "anyLine"
      ? share > 0
        ? 1
        : 0
      : share >= 0.5
        ? 1
        : 0;
};

export const recall = (
  targets: ReadonlyArray<GoldSpan>,
  served: ReadonlyArray<Served>,
  rule: OverlapRule = "fractional",
): number | null =>
  targets.length === 0
    ? null
    : targets.reduce((sum, gold) => sum + credit(gold, served, rule), 0) /
      targets.length;

const touches = (item: Item, gold: GoldSpan) =>
  item.path === gold.path &&
  item.startLine <= gold.endLine &&
  item.endLine >= gold.startLine;

export const JUDGED_RULE =
  "an arm's pooled item (its rank and span among the candidate's pool.json sources) takes its merged candidate's grade; otherwise an item whose exact span was judged (a candidate or a labeller addition) takes that grade; otherwise an item whose span lies wholly inside a judged candidate's span on the same path takes that candidate's grade; anything else is unjudged";

/**
 * The judged grade of the item at `rank` (0-based) of `arm`'s ranking, or undefined when unjudged.
 * Labellers judge B3's merged candidates, so the item's own span is rarely the judged span itself.
 */
export const judgedGrade = (
  gold: HunkGold,
  item: Item,
  arm?: string,
  rank?: number,
): JudgedLabel | undefined => {
  if (arm !== undefined && rank !== undefined) {
    const candidate = gold.pooled.get(pooledKey(arm, rank + 1, item.key));
    const label =
      candidate === undefined ? undefined : gold.judged.get(candidate);
    if (label !== undefined) return label;
  }
  // An exact judged span (such as an addition inside a candidate) outranks the enclosing candidate.
  const exact = gold.judged.get(item.key);
  if (exact !== undefined) return exact;
  return gold.candidates
    .get(item.path)
    ?.find(
      (candidate) =>
        candidate.startLine <= item.startLine &&
        item.endLine <= candidate.endLine,
    );
};

/**
 * Wrong attribution (9.9) among the served items whose span was judged and is a retrieval target:
 * the misleading share (the guard metric) and the irrelevant share, by count and by tokens.
 */
export const attribution = (
  gold: HunkGold,
  served: ReadonlyArray<Served>,
  arm?: string,
) => {
  let judged = 0;
  let misleading = 0;
  let irrelevant = 0;
  let judgedTokens = 0;
  let misleadingTokens = 0;
  let servedTokens = 0;
  for (const entry of served) {
    servedTokens += entry.tokens;
    const label = judgedGrade(gold, entry.item, arm, entry.rank);
    if (label === undefined || !label.target) continue;
    judged++;
    judgedTokens += entry.tokens;
    if (label.grade === "misleading") {
      misleading++;
      misleadingTokens += entry.tokens;
    }
    if (label.grade === "irrelevant") irrelevant++;
  }
  return {
    judged,
    served: served.length,
    misleadingShare: judged === 0 ? null : misleading / judged,
    irrelevantShare: judged === 0 ? null : irrelevant / judged,
    misleadingTokenShare:
      judgedTokens === 0 ? null : misleadingTokens / judgedTokens,
    /** Share of served tokens on judged spans: the pooling-bias check at an allowance. */
    judgedTokenShare: servedTokens === 0 ? null : judgedTokens / servedTokens,
  };
};

/** judged@k: the share of the top k items that are judged (any grade or status). */
export const judgedAt = (
  gold: HunkGold,
  ranking: Ranking,
  k: number,
  arm?: string,
) => {
  const head = ranking.items.slice(0, k);
  return head.length === 0
    ? null
    : head.filter(
        (item, rank) => judgedGrade(gold, item, arm, rank) !== undefined,
      ).length / head.length;
};

const GAIN = { necessary: 2, useful: 1, misleading: 0, irrelevant: 0 } as const;

/** nDCG@k on the condensed list: unjudged items and non-targets are removed before ranking. */
export const ndcg = (
  gold: HunkGold,
  ranking: Ranking,
  k = 10,
  arm?: string,
) => {
  const gains: Array<number> = [];
  for (const [rank, item] of ranking.items.entries()) {
    const label = judgedGrade(gold, item, arm, rank);
    if (label === undefined || !label.target) continue;
    gains.push(GAIN[label.grade]);
    if (gains.length === k) break;
  }
  const ideal = [...gold.judged.values()]
    .filter((label) => label.target)
    .map((label) => GAIN[label.grade])
    .sort((a, b) => b - a)
    .slice(0, k);
  const dcg = (values: ReadonlyArray<number>) =>
    values.reduce((sum, gain, index) => sum + gain / Math.log2(index + 2), 0);
  const best = dcg(ideal);
  return best === 0 ? null : dcg(gains) / best;
};

/**
 * Rank and token positions of necessary gold in the full ranking: MRR (first item touching any
 * necessary target), and the tokens read up to and including the item that first touches the first
 * target and every target (9.19). A target never touched leaves "all" null.
 */
export const necessaryPositions = (gold: HunkGold, ranking: Ranking) => {
  if (gold.necessary.length === 0) return null;
  const firstTouch = new Map<string, { rank: number; tokens: number }>();
  let tokens = 0;
  for (const [rank, item] of ranking.items.entries()) {
    tokens += item.tokens;
    for (const target of gold.necessary)
      if (!firstTouch.has(target.id) && touches(item, target))
        firstTouch.set(target.id, { rank, tokens });
    if (firstTouch.size === gold.necessary.length) break;
  }
  const touched = [...firstTouch.values()];
  const first = touched.reduce<{ rank: number; tokens: number } | null>(
    (best, entry) => (best === null || entry.rank < best.rank ? entry : best),
    null,
  );
  return {
    reciprocalRank: first === null ? 0 : 1 / (first.rank + 1),
    tokensToFirst: first?.tokens ?? null,
    tokensToAll:
      touched.length === gold.necessary.length
        ? Math.max(...touched.map((entry) => entry.tokens))
        : null,
    touched: touched.length,
    targets: gold.necessary.length,
  };
};

/**
 * Rank-depth view at an allowance (9.19): of the necessary targets found (touched by a served item),
 * how many are first touched within the top 5, 10 and 20 ranks.
 */
export const rankDepth = (
  gold: HunkGold,
  served: ReadonlyArray<Served>,
  depths: ReadonlyArray<number> = [5, 10, 20],
) => {
  let found = 0;
  const within = depths.map(() => 0);
  for (const target of gold.necessary) {
    const first = served.find(
      (entry) =>
        entry.endLine >= entry.startLine &&
        entry.item.path === target.path &&
        entry.startLine <= target.endLine &&
        entry.endLine >= target.startLine,
    );
    if (first === undefined) continue;
    found++;
    depths.forEach((depth, index) => {
      if (first.rank < depth) within[index] = (within[index] ?? 0) + 1;
    });
  }
  return {
    found,
    within: Object.fromEntries(
      depths.map((depth, index) => [depth, within[index] ?? 0]),
    ),
  };
};
