import { BOUNDARY_RULE, JUDGED_RULE } from "./coverage.ts";
import {
  HUB_K,
  MIN_HUB_OCCURRENCE,
  OFTEN_THRESHOLD,
  TOP_SHARE,
  armHubs,
  referenceHubness,
  splitRecall,
} from "./hubs.ts";
import {
  BUDGETS,
  RECALL_DEPTHS,
  SATURATION_POINTS,
  allowanceOf,
  familyMean,
  firstFlatStep,
  median,
  saturation,
  type HunkMetrics,
} from "./metrics.ts";
import {
  BOOTSTRAP_SEED,
  GUARD_POINTS,
  MARGIN,
  RESAMPLES,
  decide,
  familyBootstrap,
  familyPermutation,
  familyStatistic,
  type PairedUnit,
} from "./stats.ts";
import { ALLOWANCES, budgetLabel, type HunkGold, type Share } from "./types.ts";
import { type Ranking } from "../ranking.ts";
import type { Exclusion } from "./leakage.ts";
import type { VariantHunk } from "./variants.ts";

/**
 * Builds the dev report: per-arm curves, the real-share headline for Opus and Sol, saturation, rank
 * depth, hub measures, per kind, per scope stratum and per period, judged@k, costs and latency, the
 * input failures, the variants with their tuning, and the pre-registered comparisons with the 9.21
 * rule. Dev numbers select arms and settings; they are never the held-out result.
 */

export interface ReportHunk extends VariantHunk {
  readonly period: string;
  readonly scopeSource: string;
  readonly changeType: string;
  readonly tunedFile: boolean;
  readonly leakageTags: ReadonlyArray<string>;
  readonly graphTuningRange: boolean;
  readonly phase2Range: boolean;
}

export interface Comparison {
  readonly name: string;
  readonly other: string;
  readonly default: string;
  /** Leakage exclusions the two arms bring in by what they contain (9.47, leakage.ts). */
  readonly exclusions: ReadonlyArray<Exclusion>;
}

export const round = (value: number | null | undefined, digits = 4) =>
  value === null || value === undefined || Number.isNaN(value)
    ? null
    : Number(value.toFixed(digits));

/**
 * One arm's table entry. `poolOnly` names the hunks this arm is read at only its frozen top 50
 * (no deep ranking): they stay in the arm's own curve and saturation, so the entry lists them.
 */
export const summarizeArm = (
  arm: string,
  metrics: ReadonlyMap<string, HunkMetrics>,
  hunks: ReadonlyArray<ReportHunk>,
  poolOnly: (hunkId: string) => boolean = () => false,
) => {
  const scored = hunks.filter((hunk) => metrics.has(hunk.hunkId));
  const mean = (
    pick: (entry: HunkMetrics, hunk: ReportHunk) => number | null | undefined,
  ) =>
    familyMean(
      scored.map((hunk) => ({
        family: hunk.family,
        caseId: hunk.caseId,
        value: pick(metrics.get(hunk.hunkId) as HunkMetrics, hunk) ?? null,
      })),
    );
  const curve = Object.fromEntries(
    BUDGETS.map((budget) => {
      const label = budgetLabel(budget);
      const at = (entry: HunkMetrics) => entry.budgets[label];
      const nr = mean((entry) => at(entry)?.necessary.fractional);
      let found = 0;
      const within: Record<number, number> = { 5: 0, 10: 0, 20: 0 };
      let shortRankings = 0;
      for (const hunk of scored) {
        const entry = metrics.get(hunk.hunkId) as HunkMetrics;
        const depth = at(entry)?.rankDepth;
        if (depth !== undefined) {
          found += depth.found;
          for (const k of [5, 10, 20])
            within[k] = (within[k] ?? 0) + (depth.within[k] ?? 0);
        }
        if (entry.rankedTokens < allowanceOf(budget, hunk)) shortRankings++;
      }
      return [
        label,
        {
          necessary: {
            fractional: round(nr.mean),
            anyLine: round(mean((entry) => at(entry)?.necessary.anyLine).mean),
            half: round(mean((entry) => at(entry)?.necessary.half).mean),
            hunkMean: round(nr.hunkMean),
            hunks: nr.hunks,
            families: nr.families,
          },
          /** 9.54: relevant recall (necessary and useful targets together), beside necessary recall. */
          relevant: (() => {
            const rr = mean((entry) => at(entry)?.relevant.fractional);
            return {
              fractional: round(rr.mean),
              hunks: rr.hunks,
              families: rr.families,
            };
          })(),
          useful: round(mean((entry) => at(entry)?.useful.fractional).mean),
          misleadingShare: round(
            mean((entry) => at(entry)?.attribution.misleadingShare).mean,
          ),
          /** The same share weighted by served tokens (the guard's form is an open owner question). */
          misleadingTokenShare: round(
            mean((entry) => at(entry)?.attribution.misleadingTokenShare).mean,
          ),
          irrelevantShare: round(
            mean((entry) => at(entry)?.attribution.irrelevantShare).mean,
          ),
          judgedTokenShare: round(
            mean((entry) => at(entry)?.attribution.judgedTokenShare).mean,
          ),
          servedTokens: round(mean((entry) => at(entry)?.servedTokens).mean, 0),
          rankDepth: {
            found,
            top5: found === 0 ? null : round((within[5] ?? 0) / found),
            top10: found === 0 ? null : round((within[10] ?? 0) / found),
            top20: found === 0 ? null : round((within[20] ?? 0) / found),
          },
          /** Hunks whose whole ranking holds fewer tokens than the allowance (deep cap or short answer). */
          shortRankings,
        },
      ];
    }),
  );
  const doublings = (pick: "necessary" | "relevant") =>
    ALLOWANCES.map((allowance) => ({
      allowance,
      value: (
        curve[budgetLabel(allowance)] as Record<
          "necessary" | "relevant",
          { fractional: number | null }
        >
      )[pick].fractional,
    }));
  const perKind: Record<string, number | null> = {};
  const kinds = new Set(
    scored.flatMap((hunk) =>
      Object.keys(
        metrics.get(hunk.hunkId)?.budgets["real-opus"]?.perKind ?? {},
      ),
    ),
  );
  for (const kind of [...kinds].sort())
    perKind[kind] = round(
      mean((entry) => entry.budgets["real-opus"]?.perKind[kind] ?? null).mean,
    );
  const positions = scored
    .map((hunk) => metrics.get(hunk.hunkId)?.positions)
    .filter((entry) => entry !== null && entry !== undefined);
  return {
    arm,
    /** Scored hunks read only at the frozen top 50: in this arm's curve and saturation, not past the pool. */
    poolOnlyHunks: scored
      .filter((hunk) => poolOnly(hunk.hunkId))
      .map((hunk) => hunk.hunkId),
    hunks: scored.length,
    curve,
    /** 9.40: the first allowance after which no doubling adds 2 points; null is "not reached". */
    saturation: saturation(doublings("necessary")),
    /** The literal 9.18 reading beside it: the first doubling that adds less than 2 points. */
    saturationFirstFlat: firstFlatStep(doublings("necessary")),
    /** 9.54: the same flat reading on relevant recall, reported beside (saturation stays on necessary). */
    relevantSaturation: saturation(doublings("relevant")),
    recallAt: Object.fromEntries(
      RECALL_DEPTHS.map((k) => [
        k,
        {
          necessary: round(mean((entry) => entry.recallAt[k]?.necessary).mean),
          useful: round(mean((entry) => entry.recallAt[k]?.useful).mean),
        },
      ]),
    ),
    ndcg10: round(mean((entry) => entry.ndcg10).mean),
    mrr: round(mean((entry) => entry.positions?.reciprocalRank ?? null).mean),
    tokensToFirstNecessary: {
      median: median(
        positions.flatMap((entry) =>
          entry?.tokensToFirst == null ? [] : [entry.tokensToFirst],
        ),
      ),
      reached: positions.filter((entry) => entry?.tokensToFirst != null).length,
      hunks: positions.length,
    },
    tokensToAllNecessary: {
      median: median(
        positions.flatMap((entry) =>
          entry?.tokensToAll == null ? [] : [entry.tokensToAll],
        ),
      ),
      reached: positions.filter((entry) => entry?.tokensToAll != null).length,
      hunks: positions.length,
    },
    judgedAt: Object.fromEntries(
      RECALL_DEPTHS.map((k) => [
        k,
        round(mean((entry) => entry.judgedAt[k]).mean),
      ]),
    ),
    perKind,
    strata: Object.fromEntries(
      (["scopeSource", "period", "changeType"] as const).map((field) => {
        const groups = [...new Set(scored.map((hunk) => hunk[field]))].sort();
        return [
          field,
          Object.fromEntries(
            groups.map((group) => {
              const members = scored.filter((hunk) => hunk[field] === group);
              const read = (
                share: Share,
                pick: "necessary" | "relevant" = "necessary",
              ) =>
                familyMean(
                  members.map((hunk) => ({
                    family: hunk.family,
                    caseId: hunk.caseId,
                    value:
                      metrics.get(hunk.hunkId)?.budgets[`real-${share}`]?.[pick]
                        .fractional ?? null,
                  })),
                );
              const opus = read("opus");
              return [
                group,
                {
                  opus: round(opus.mean),
                  sol: round(read("sol").mean),
                  relevantOpus: round(read("opus", "relevant").mean),
                  relevantSol: round(read("sol", "relevant").mean),
                  hunks: opus.hunks,
                  families: opus.families,
                },
              ];
            }),
          ),
        ];
      }),
    ),
  };
};

/** Paired per-hunk deltas of one value between the comparison's two arms, where both have it. */
export const pairedUnits = (
  comparison: Comparison,
  values: (arm: string, hunkId: string) => number | null,
  hunks: ReadonlyArray<ReportHunk>,
) => {
  const units: Array<PairedUnit & { hunkId: string }> = [];
  for (const hunk of hunks) {
    const other = values(comparison.other, hunk.hunkId);
    const base = values(comparison.default, hunk.hunkId);
    if (other === null || base === null) continue;
    units.push({
      family: hunk.family,
      caseId: hunk.caseId,
      hunkId: hunk.hunkId,
      delta: other - base,
    });
  }
  return units;
};

/**
 * One pre-registered comparison at a real share (9.21). Hunks are left out by the comparison's own
 * exclusion rule, and where one arm was read only at its frozen top 50 while the other has a deep
 * ranking (a Graph deep answer that failed): such a pair is not like for like past the pool, so it is
 * listed and left out of the delta, the curve and the guard. A hunk where either arm has a recorded
 * failure (a Graph inspection that never finished or was refused) is left out and listed the same
 * way, so it never enters as 0 against 0 or 0 against a real answer; an arm that answered with
 * nothing scores 0. The guard is paired: it reads both arms'
 * misleading share over the same hunks, those where both served a judged item; with none it is not
 * measurable and the default arm is kept.
 */
export const runComparison = (
  comparison: Comparison,
  metrics: ReadonlyMap<string, ReadonlyMap<string, HunkMetrics>>,
  hunks: ReadonlyArray<ReportHunk>,
  options: {
    readonly comparisons: number;
    readonly share: Share;
    readonly resamples: number;
    readonly seed: string;
    /** Whether the arm's ranking for the hunk is only the frozen top 50. */
    readonly poolOnly: (arm: string, hunkId: string) => boolean;
    /** The arm's recorded failure for the hunk (its cause), or null when it answered. */
    readonly failure: (arm: string, hunkId: string) => string | null;
  },
) => {
  const label = `real-${options.share}`;
  const metric = (arm: string, hunkId: string) => metrics.get(arm)?.get(hunkId);
  const afterExclusions = hunks.filter(
    (hunk) =>
      !comparison.exclusions.some((exclusion) => exclusion.applies(hunk)),
  );
  const noAnswer = afterExclusions.flatMap((hunk) => {
    const failed = [comparison.other, comparison.default].flatMap((arm) => {
      const cause = options.failure(arm, hunk.hunkId);
      return cause === null ? [] : [{ arm, cause }];
    });
    return failed.length === 0
      ? []
      : [{ hunkId: hunk.hunkId, caseId: hunk.caseId, failed }];
  });
  const unanswered = new Set(noAnswer.map((entry) => entry.hunkId));
  const kept = afterExclusions.filter((hunk) => !unanswered.has(hunk.hunkId));
  const mixedDepth = kept
    .filter(
      (hunk) =>
        metric(comparison.other, hunk.hunkId) !== undefined &&
        metric(comparison.default, hunk.hunkId) !== undefined &&
        options.poolOnly(comparison.other, hunk.hunkId) !==
          options.poolOnly(comparison.default, hunk.hunkId),
    )
    .map((hunk) => ({
      hunkId: hunk.hunkId,
      caseId: hunk.caseId,
      poolOnly: [comparison.other, comparison.default].filter((arm) =>
        options.poolOnly(arm, hunk.hunkId),
      ),
    }));
  const mixed = new Set(mixedDepth.map((entry) => entry.hunkId));
  const scored = kept.filter((hunk) => !mixed.has(hunk.hunkId));
  const recallAt =
    (budget: string, pick: "necessary" | "relevant" = "necessary") =>
    (arm: string, hunkId: string) =>
      metric(arm, hunkId)?.budgets[budget]?.[pick].fractional ?? null;
  const units = pairedUnits(comparison, recallAt(label), scored);
  const seed = `${options.seed}:${comparison.name}`;
  const bootstrap = familyBootstrap(units, {
    comparisons: options.comparisons,
    resamples: options.resamples,
    seed,
  });
  // 9.54: the relevant-recall delta at the same adjusted level, with the same seed and resampling
  // scheme, over the kept hunks where relevant recall is defined (any relevant gold); necessary
  // recall stays on the hunks with necessary gold. Each reports its own hunk count.
  const relevantUnits = pairedUnits(
    comparison,
    recallAt(label, "relevant"),
    scored,
  );
  const relevantBootstrap = familyBootstrap(relevantUnits, {
    comparisons: options.comparisons,
    resamples: options.resamples,
    seed,
  });
  const permutation = familyPermutation(units, {
    resamples: options.resamples,
    seed,
  });
  const paired = new Set(units.map((unit) => unit.hunkId));
  const attributionOf = (arm: string, hunkId: string) =>
    metric(arm, hunkId)?.budgets[label]?.attribution;
  const guardHunks = scored.filter(
    (hunk) =>
      paired.has(hunk.hunkId) &&
      attributionOf(comparison.other, hunk.hunkId)?.misleadingShare != null &&
      attributionOf(comparison.default, hunk.hunkId)?.misleadingShare != null,
  );
  const guard = (
    arm: string,
    pick: "misleadingShare" | "misleadingTokenShare",
  ) =>
    familyMean(
      guardHunks.map((hunk) => ({
        family: hunk.family,
        caseId: hunk.caseId,
        value: attributionOf(arm, hunk.hunkId)?.[pick] ?? null,
      })),
    ).mean;
  const defaultMisleading = guard(comparison.default, "misleadingShare");
  const otherMisleading = guard(comparison.other, "misleadingShare");
  return {
    name: comparison.name,
    other: comparison.other,
    default: comparison.default,
    /** Each exclusion that applied, the arms containing its component, and the hunks it drops. */
    exclusions: comparison.exclusions.map((exclusion) => ({
      rule: exclusion.rule,
      because: exclusion.because,
      hunks: hunks.filter((hunk) => exclusion.applies(hunk)).length,
    })),
    excludedHunks: hunks.length - afterExclusions.length,
    /** Hunks where either arm has a recorded failure: left out and listed with the cause. */
    noAnswer,
    /** Hunks left after the exclusions and the no-answer rule, before the mixed-depth rule. */
    hunksRemaining: kept.length,
    /** Hunks where one arm is read only at its frozen top 50 and the other deep: left out. */
    mixedDepth,
    pairedHunks: units.length,
    families: bootstrap.families,
    cases: bootstrap.cases,
    delta: round(bootstrap.observed),
    interval: {
      level: round(bootstrap.level, 5),
      lower: round(bootstrap.lower),
      upper: round(bootstrap.upper),
    },
    permutationP: round(permutation.p),
    /** 9.54: the relevant-recall delta and its interval at the same adjusted level. */
    relevant: {
      pairedHunks: relevantUnits.length,
      families: relevantBootstrap.families,
      delta: round(relevantBootstrap.observed),
      interval: {
        level: round(relevantBootstrap.level, 5),
        lower: round(relevantBootstrap.lower),
        upper: round(relevantBootstrap.upper),
      },
    },
    /** The paired deltas at each fixed allowance, over the same hunks as the real-share deltas. */
    curve: Object.fromEntries(
      ALLOWANCES.map((allowance) => {
        const at = pairedUnits(
          comparison,
          recallAt(budgetLabel(allowance)),
          scored,
        );
        const relevantAt = pairedUnits(
          comparison,
          recallAt(budgetLabel(allowance), "relevant"),
          scored,
        );
        return [
          budgetLabel(allowance),
          {
            delta: round(familyStatistic(at)),
            hunks: at.length,
            relevantDelta: round(familyStatistic(relevantAt)),
            relevantHunks: relevantAt.length,
          },
        ];
      }),
    ),
    guard: {
      measurable: guardHunks.length > 0,
      /** Paired hunks where both arms served a judged item: what the guard rests on. */
      hunks: guardHunks.length,
      defaultMisleading: round(defaultMisleading),
      otherMisleading: round(otherMisleading),
      defaultMisleadingTokens: round(
        guard(comparison.default, "misleadingTokenShare"),
      ),
      otherMisleadingTokens: round(
        guard(comparison.other, "misleadingTokenShare"),
      ),
    },
    decision: decide({
      lower: bootstrap.lower,
      relevantLower: relevantBootstrap.lower,
      defaultMisleading,
      otherMisleading,
    }),
  };
};

export const hubSection = (
  arms: ReadonlyArray<string>,
  rankings: ReadonlyMap<string, ReadonlyMap<string, Ranking>>,
  reference: ReadonlyArray<string>,
  hunks: ReadonlyArray<ReportHunk>,
  golds: ReadonlyMap<string, HunkGold>,
  populationSize: number,
) => {
  const hubness = referenceHubness(
    reference.flatMap((arm) => {
      const map = rankings.get(arm);
      return map === undefined ? [] : [map];
    }),
    hunks,
    golds,
  );
  const gold = [...hubness.values()];
  return {
    k: HUB_K,
    topShare: TOP_SHARE,
    minHubOccurrence: MIN_HUB_OCCURRENCE,
    oftenThreshold: OFTEN_THRESHOLD,
    referenceArms: reference,
    goldTargets: gold.length,
    oftenTargets: gold.filter((value) => value >= OFTEN_THRESHOLD).length,
    arms: Object.fromEntries(
      arms.flatMap((arm) => {
        const map = rankings.get(arm);
        if (map === undefined) return [];
        const hubs = armHubs(map, hunks, populationSize);
        const split = splitRecall(map, hunks, golds, hubness);
        return [
          [
            arm,
            {
              ...hubs,
              skew: round(hubs.skew, 3),
              skewAt10: round(hubs.skewAt10, 3),
              topBudgetShare: round(hubs.topBudgetShare),
              necessaryRecall: {
                often: {
                  mean: round(split.often.mean),
                  targets: split.often.targets,
                  hunks: split.often.hunks,
                },
                rare: {
                  mean: round(split.rare.mean),
                  targets: split.rare.targets,
                  hunks: split.rare.hunks,
                },
              },
            },
          ],
        ];
      }),
    ),
  };
};

export const RULES = {
  overlap:
    "fractional coverage: a gold region's credit is the covered share of its lines (union of served lines), capped at 1; any-line and at-least-50% are sensitivity readings",
  boundary: BOUNDARY_RULE,
  targets:
    "retrieval targets only: base regions outside the range's changes (committed, partly same-batch); earlier commits are pass 2 (M6); same-batch regions, the range's changes, in-range documents and later commits (hindsight, 9.12) are never targets",
  unjudged: `unjudged items never count as irrelevant: nDCG@10 is condensed over judged target spans, wrong attribution is a share of judged served items. Labellers judge B3's merged pool candidates, so ${JUDGED_RULE}`,
  touch:
    "MRR, rank depth and tokens to first/all necessary use any-line contact with a necessary target",
  aggregation:
    "hunks average within their case (range), cases within their family, families weigh equally (proposal section 5, option A); arm tables and comparison deltas use the same nesting",
  depth:
    "a comparison leaves out, and lists, each hunk where either arm has a recorded failure (an arm that answered with nothing scores 0), and each hunk where one arm is read only at its frozen top 50 (no deep ranking) and the other deep",
  leakage:
    "9.47: a comparison drops the hunks a tuned component could have seen whenever either arm contains it, read from the arms' definitions (fusion lists, R's candidates, variant inputs): the tuned adapter drops adapter-training-adjacent cases and ranges touching a phase 2 training file; the Graph fork drops Graph-tuning ranges, graph-tuning-adjacent cases and tuned-file hunks",
  sixth:
    "9.46: no variant reaches held-out automatically; the dev report ranks variants by leave-one-family-out gain and the owner names any sixth comparison",
  saturation: `9.18 as read by 9.40: where the curve stays flat, the first allowance after which no doubling up to ${Math.max(...ALLOWANCES) / 1000}k adds ${SATURATION_POINTS * 100} points of necessary recall; a retriever still climbing at the largest allowance reads "not reached". The literal first-flat-step reading (the first doubling that adds less than ${SATURATION_POINTS * 100} points) is shown beside it`,
  relevant:
    "9.54: relevant recall is the same fractional coverage over every retrieval target graded necessary or useful (their union), each target weighted equally; it is reported beside necessary recall in the arm tables, the curve, the strata and every comparison, and saturation stays on necessary recall with the relevant-recall reading beside it",
  decision: `9.21 as amended by 9.54: the default arm wins unless the other's Bonferroni-adjusted lower bound on the necessary-recall delta at the real share exceeds +${MARGIN * 100} points, its lower bound on the relevant-recall delta at the same adjusted level also exceeds +${MARGIN * 100} points, and its misleading share is at most ${GUARD_POINTS * 100} points above the default's. Requiring both bounds is an intersection-union test, so no further multiplicity correction is needed. The guard is paired over the hunks where both arms served a judged item; with none it is not measurable and the default wins`,
  bootstrap: `paired, families resampled with cases nested inside them, ${RESAMPLES} resamples, seed ${BOOTSTRAP_SEED}; a paired sign-flip permutation over family means as a cross-check`,
} as const;
