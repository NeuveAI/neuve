import {
  OVERLAP_RULES,
  attribution,
  judgedAt,
  ndcg,
  necessaryPositions,
  rankDepth,
  recall,
  serve,
  topK,
  type OverlapRule,
} from "./coverage.ts";
import { familyStatistic } from "./stats.ts";
import {
  ALLOWANCES,
  SHARES,
  budgetLabel,
  type Budget,
  type HunkGold,
  type Share,
} from "./types.ts";
import { type Ranking } from "../ranking.ts";

/**
 * Per-hunk metrics of one arm (proposal section 5, 9.14, 9.19) and their family-weighted means. The
 * arm's name is passed so its pooled items map to their judged candidates (coverage.ts).
 */

export const RECALL_DEPTHS = [5, 10, 20, 50] as const;
export const BUDGETS: ReadonlyArray<Budget> = [
  ...ALLOWANCES,
  ...SHARES,
  ...SHARES.map((share) => `computed-${share}` as const),
];

export interface HunkContext {
  readonly hunkId: string;
  readonly caseId: string;
  readonly family: string;
  readonly realShare: Readonly<Record<Share, number>>;
  readonly computedShare: Readonly<Record<Share, number>>;
}

export const allowanceOf = (budget: Budget, hunk: HunkContext) =>
  typeof budget === "number"
    ? budget
    : budget === "opus" || budget === "sol"
      ? hunk.realShare[budget]
      : hunk.computedShare[budget === "computed-opus" ? "opus" : "sol"];

type ByRule = Readonly<Record<OverlapRule, number | null>>;

export interface BudgetMetrics {
  readonly allowance: number;
  readonly necessary: ByRule;
  readonly useful: ByRule;
  /**
   * 9.54: relevant recall, the same fractional coverage over every retrieval target graded
   * necessary or useful, each target weighted equally.
   */
  readonly relevant: ByRule;
  readonly perKind: Readonly<Record<string, number | null>>;
  readonly attribution: ReturnType<typeof attribution>;
  readonly rankDepth: ReturnType<typeof rankDepth>;
  readonly servedTokens: number;
}

export interface HunkMetrics {
  readonly budgets: Readonly<Record<string, BudgetMetrics>>;
  readonly recallAt: Readonly<
    Record<
      number,
      { readonly necessary: number | null; readonly useful: number | null }
    >
  >;
  readonly ndcg10: number | null;
  readonly positions: ReturnType<typeof necessaryPositions>;
  readonly judgedAt: Readonly<Record<number, number | null>>;
  readonly rankedItems: number;
  readonly rankedTokens: number;
}

const byRule = (
  targets: HunkGold["necessary"],
  served: ReturnType<typeof serve>,
): ByRule =>
  Object.fromEntries(
    OVERLAP_RULES.map((rule) => [rule, recall(targets, served, rule)]),
  ) as Record<OverlapRule, number | null>;

export const evaluateBudget = (
  gold: HunkGold,
  ranking: Ranking,
  allowance: number,
  arm?: string,
): BudgetMetrics => {
  const served = serve(ranking, allowance);
  const kinds = [...new Set(gold.necessary.map((span) => span.kind))].sort();
  return {
    allowance,
    necessary: byRule(gold.necessary, served),
    useful: byRule(gold.useful, served),
    relevant: byRule([...gold.necessary, ...gold.useful], served),
    perKind: Object.fromEntries(
      kinds.map((kind) => [
        kind,
        recall(
          gold.necessary.filter((span) => span.kind === kind),
          served,
        ),
      ]),
    ),
    attribution: attribution(gold, served, arm),
    rankDepth: rankDepth(gold, served),
    servedTokens: served.reduce((sum, entry) => sum + entry.tokens, 0),
  };
};

export const evaluateHunk = (
  gold: HunkGold,
  ranking: Ranking,
  hunk: HunkContext,
  arm?: string,
  budgets: ReadonlyArray<Budget> = BUDGETS,
): HunkMetrics => ({
  budgets: Object.fromEntries(
    budgets.map((budget) => [
      budgetLabel(budget),
      evaluateBudget(gold, ranking, allowanceOf(budget, hunk), arm),
    ]),
  ),
  recallAt: Object.fromEntries(
    RECALL_DEPTHS.map((k) => {
      const served = topK(ranking, k);
      return [
        k,
        {
          necessary: recall(gold.necessary, served),
          useful: recall(gold.useful, served),
        },
      ];
    }),
  ),
  ndcg10: ndcg(gold, ranking, 10, arm),
  positions: necessaryPositions(gold, ranking),
  judgedAt: Object.fromEntries(
    RECALL_DEPTHS.map((k) => [k, judgedAt(gold, ranking, k, arm)]),
  ),
  rankedItems: ranking.items.length,
  rankedTokens: ranking.items.reduce((sum, item) => sum + item.tokens, 0),
});

/** Necessary recall (fractional) at a budget: the primary metric, NR@B. */
export const primary = (
  gold: HunkGold,
  ranking: Ranking,
  hunk: HunkContext,
  budget: Budget,
) => recall(gold.necessary, serve(ranking, allowanceOf(budget, hunk)));

/**
 * Family-weighted mean (proposal section 5, option A, ranges nested in families): hunks average
 * within their case, cases within their family, and families with equal weight, the same nesting as
 * the comparisons' paired statistic, so a comparison's delta over the same hunks is the difference of
 * its two arms' means. Null values are left out; `hunks` and `families` count what was averaged.
 */
export const familyMean = (
  values: ReadonlyArray<{
    readonly family: string;
    readonly caseId: string;
    readonly value: number | null;
  }>,
) => {
  const kept = values.flatMap(({ family, caseId, value }) =>
    value === null || Number.isNaN(value)
      ? []
      : [{ family, caseId, delta: value }],
  );
  return {
    mean: familyStatistic(kept),
    hunkMean:
      kept.length === 0
        ? null
        : kept.reduce((sum, entry) => sum + entry.delta, 0) / kept.length,
    hunks: kept.length,
    families: new Set(kept.map((entry) => entry.family)).size,
  };
};

export const median = (values: ReadonlyArray<number>) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
};

export const SATURATION_POINTS = 0.02;

/**
 * The literal 9.18 reading, shown beside the saturation point (9.40): the first allowance on the
 * doubling curve where doubling adds less than 2 points of necessary recall; null when every
 * doubling up to 512k still adds 2 points or more.
 */
export const firstFlatStep = (
  curve: ReadonlyArray<{
    readonly allowance: number;
    readonly value: number | null;
  }>,
) => {
  for (let index = 0; index + 1 < curve.length; index++) {
    const here = curve[index];
    const next = curve[index + 1];
    if (here?.value == null || next?.value == null) continue;
    if (next.allowance !== here.allowance * 2) continue;
    if (next.value - here.value < SATURATION_POINTS) return here.allowance;
  }
  return null;
};

/**
 * The saturation point (9.18 as read by 9.40): where the curve stays flat, the first allowance from
 * which no later doubling adds 2 points of necessary recall. Null ("not reached") when the last
 * doubling, up to the largest allowance, still adds 2 points or more.
 */
export const saturation = (
  curve: ReadonlyArray<{
    readonly allowance: number;
    readonly value: number | null;
  }>,
) => {
  let candidate: number | null = null;
  for (let index = 0; index + 1 < curve.length; index++) {
    const here = curve[index];
    const next = curve[index + 1];
    if (here?.value == null || next?.value == null) continue;
    if (next.value - here.value < SATURATION_POINTS)
      candidate ??= here.allowance;
    else candidate = null;
  }
  return candidate;
};
