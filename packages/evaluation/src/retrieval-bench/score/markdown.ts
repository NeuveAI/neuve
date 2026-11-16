import type { GraphFailure } from "../deep-rankings.ts";
import type { runComparison, summarizeArm } from "./report.ts";
import { ALLOWANCES, budgetLabel } from "./types.ts";

/** The readable summary of score.dev.json. Short tables; the JSON holds everything else. */

type Summary = ReturnType<typeof summarizeArm>;
type ComparisonResult = ReturnType<typeof runComparison>;
type Curve = Summary["curve"][string];

interface TruncatedHunk {
  readonly hunkId: string;
  readonly caseId: string | null;
  readonly pairs: number;
  readonly truncated: number;
  readonly fullyTruncated: boolean;
}

export interface MarkdownInput {
  readonly status: string;
  readonly generatedFrom: { readonly mode: string };
  readonly settings: {
    readonly decideAt: string;
    readonly comparisons: number;
    readonly resamples: number;
    readonly seed: string;
  };
  readonly rules: Readonly<Record<string, string>>;
  readonly gold: {
    readonly hunks: number;
    readonly devHunks: number;
    readonly families: number;
    readonly withNecessary: number;
    readonly necessaryTargets: number;
    readonly usefulTargets: number;
    readonly fromAdditions: {
      readonly necessary: number;
      readonly useful: number;
    };
    readonly misleadingJudged: number;
    readonly excluded: Readonly<Record<string, number>>;
    readonly duplicateSpans: number;
    readonly overlappingSpans: number;
    readonly provisionalOwnerItems: number;
  };
  readonly inputs: {
    readonly rebuiltPoolMismatches: Readonly<
      Record<string, ReadonlyArray<string>>
    >;
    readonly hunksAboveDeepCap: {
      readonly opus: ReadonlyArray<string>;
      readonly sol: ReadonlyArray<string>;
      readonly note: string;
    };
    readonly depthCoverage: Readonly<
      Record<
        string,
        {
          readonly reaches: number;
          readonly wholeBase: number;
          readonly short: ReadonlyArray<{ readonly hunkId: string }>;
        }
      >
    >;
    readonly chunkPopulation: number;
  };
  readonly selection: {
    readonly bestDense: string;
    readonly bestFusion: string;
    readonly bestTopology: string;
  };
  readonly arms: ReadonlyArray<Summary>;
  readonly hubs: {
    readonly k: number;
    readonly minHubOccurrence: number;
    readonly oftenThreshold: number;
    readonly goldTargets: number;
    readonly oftenTargets: number;
    readonly arms: Readonly<
      Record<
        string,
        {
          readonly skew: number | null;
          readonly skewAt10: number | null;
          readonly topChunks: number;
          readonly topThreshold: number;
          readonly topBudgetShare: number | null;
          readonly maxOccurrence: number;
          readonly necessaryRecall: {
            readonly often: {
              readonly mean: number | null;
              readonly targets: number;
            };
            readonly rare: {
              readonly mean: number | null;
              readonly targets: number;
            };
          };
        }
      >
    >;
  };
  readonly variants: {
    readonly ranking: ReadonlyArray<{
      readonly arm: string;
      readonly of: string;
      readonly leaveOneFamilyOutGain: number | null;
      readonly inSampleGain: number | null;
    }>;
    readonly list: ReadonlyArray<Record<string, unknown>>;
    readonly v3: {
      readonly scoredPools: ReadonlyArray<string>;
      readonly note: string;
    };
  };
  readonly comparisons: {
    readonly decideAt: string;
    readonly list: ReadonlyArray<ComparisonResult>;
    readonly otherShare: ReadonlyArray<ComparisonResult>;
    readonly previews: ReadonlyArray<ComparisonResult>;
    readonly previewsOtherShare: ReadonlyArray<ComparisonResult>;
  };
  readonly costs: {
    readonly arms: ReadonlyArray<{
      readonly arm: string;
      readonly latencyMillis: unknown;
      readonly poolTokens: unknown;
    }>;
    readonly encodingWallSeconds: Readonly<Record<string, number | null>>;
    readonly options957: ReadonlyArray<{
      readonly option: string;
      readonly label: string;
      readonly dimensions: number | null;
      readonly indexBytes: number | null;
      readonly chunkUnits: number | null;
      readonly chunkEncodeWallSeconds: number | null;
      readonly queryEncodeMillisPerQuery: number | null;
      readonly fusionWarmP50Millis: number | null;
      readonly rerankWarmP50Millis: number | null;
    }>;
    readonly graphPreparationSeconds: {
      readonly full: number;
      readonly syntax: number;
    };
  };
  readonly failures: {
    readonly graph: ReadonlyArray<GraphFailure>;
    readonly srefEmpty: ReadonlyArray<GraphFailure>;
    readonly rerankTruncation: {
      readonly aggregate: {
        readonly pairs: number;
        readonly truncatedPairs: number;
      } | null;
      readonly perHunk: ReadonlyArray<TruncatedHunk> | null;
      readonly others: ReadonlyArray<{
        readonly arm: string;
        readonly pairs: number;
        readonly truncatedPairs: number;
        readonly perHunk: ReadonlyArray<TruncatedHunk> | null;
      }>;
      readonly rescored: {
        readonly pairs: number;
        readonly truncatedPairs: number;
        readonly perHunk: ReadonlyArray<TruncatedHunk> | null;
      } | null;
    };
  };
}

export const pct = (value: number | null | undefined) =>
  value === null || value === undefined ? "–" : (value * 100).toFixed(1);
export const tokens = (value: number | null | undefined) =>
  value === null || value === undefined
    ? "–"
    : value >= 1000
      ? `${(value / 1000).toFixed(1)}k`
      : String(value);
const row = (cells: ReadonlyArray<string | number>) =>
  `| ${cells.join(" | ")} |`;
export const table = (
  head: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string | number>>,
) => [row(head), row(head.map(() => "---")), ...rows.map(row)].join("\n");

/** The hunks an arm is read at only its frozen top 50, as a table cell. */
export const poolOnlyCell = (summary: Summary) =>
  summary.poolOnlyHunks.length === 0
    ? "–"
    : summary.poolOnlyHunks.length === summary.hunks
      ? `all ${summary.hunks}`
      : summary.poolOnlyHunks.join(", ");

export const latency = (value: unknown) => {
  const entry = value as { warm?: { p50?: number | null } } | undefined;
  const p50 = entry?.warm?.p50;
  return p50 === null || p50 === undefined
    ? "–"
    : p50 >= 1000
      ? `${(p50 / 1000).toFixed(1)} s`
      : `${p50.toFixed(0)} ms`;
};

const truncatedHunks = (perHunk: ReadonlyArray<TruncatedHunk>) =>
  perHunk.map(
    (entry) =>
      `${entry.hunkId} ${entry.truncated}/${entry.pairs}${entry.fullyTruncated ? " (**fully truncated**: the reranker's order for this hunk rests on cut texts only)" : ""}`,
  );

const rerankLine = (
  truncation: MarkdownInput["failures"]["rerankTruncation"],
) => {
  const total =
    truncation.aggregate === null
      ? "no reranker run recorded"
      : `${truncation.aggregate.truncatedPairs} of ${truncation.aggregate.pairs} pairs cut to the reranker's window`;
  const r =
    truncation.perHunk === null
      ? `- Reranker truncation (R): ${total}; no per-hunk record in arms.dev.json.`
      : `- Reranker truncation (R): ${total}${truncation.perHunk.length === 0 ? "." : `, per hunk: ${truncatedHunks(truncation.perHunk).join("; ")}.`}`;
  const others = truncation.others.map(
    (entry) =>
      `- Reranker truncation (${entry.arm}): ${entry.pairs === 0 ? "no Modal run recorded for this pool" : `${entry.truncatedPairs} of ${entry.pairs} pairs cut to the reranker's window`}${entry.perHunk === null || entry.perHunk.length === 0 ? "." : `, per hunk: ${truncatedHunks(entry.perHunk).join("; ")}.`}`,
  );
  const rescored = truncation.rescored;
  return [
    r,
    ...others,
    ...(rescored === null
      ? []
      : [
          `- Reranker truncation (V3b's own pairs): ${rescored.truncatedPairs} of ${rescored.pairs} pairs${rescored.perHunk === null || rescored.perHunk.length === 0 ? "." : `, per hunk: ${truncatedHunks(rescored.perHunk).join("; ")}.`}`,
        ]),
  ].join("\n");
};

/** An interval level as a percentage: 99 for 0.99, 99.17 for 1 - 0.05 / 6. */
export const level = (value: number | null | undefined) =>
  `${Number(((value ?? 0) * 100).toFixed(2))}%`;

export const comparisonTable = (
  list: ReadonlyArray<ComparisonResult>,
  outcome = "Dev outcome",
) =>
  table(
    [
      "Comparison",
      "NR: other − default",
      "NR interval",
      "RR delta",
      "RR interval",
      "Permutation p",
      "Misleading (default → other)",
      "Hunks (families)",
      "Excluded (rule: arms; hunks)",
      "No answer",
      "Mixed depth",
      outcome,
    ],
    list.map((entry) => [
      entry.name,
      `${entry.other} − ${entry.default}: ${pct(entry.delta)}`,
      `${level(entry.interval.level)}: ${pct(entry.interval.lower)} … ${pct(entry.interval.upper)}`,
      pct(entry.relevant.delta),
      `${pct(entry.relevant.interval.lower)} … ${pct(entry.relevant.interval.upper)}`,
      entry.permutationP === null ? "–" : entry.permutationP.toFixed(3),
      entry.guard.measurable
        ? `${pct(entry.guard.defaultMisleading)} → ${pct(entry.guard.otherMisleading)} (${entry.guard.hunks})`
        : "not measurable",
      `NR ${entry.pairedHunks} (${entry.families}), RR ${entry.relevant.pairedHunks} (${entry.relevant.families})`,
      entry.exclusions.length === 0
        ? "none"
        : `${entry.excludedHunks}: ${entry.exclusions.map((exclusion) => `${exclusion.rule.slice(0, exclusion.rule.indexOf(":"))} (${exclusion.because.join(", ")}; ${exclusion.hunks})`).join("; ")}; ${entry.hunksRemaining} remain`,
      entry.noAnswer.length === 0
        ? "0"
        : `${entry.noAnswer.length}: ${entry.noAnswer.map((hunk) => `${hunk.hunkId} (${hunk.failed.map((failure) => failure.arm).join(", ")} failed)`).join(", ")}`,
      entry.mixedDepth.length === 0
        ? "0"
        : `${entry.mixedDepth.length}: ${entry.mixedDepth.map((hunk) => hunk.hunkId).join(", ")}`,
      `${entry.decision.outcome}: ${entry.decision.winner === "default" ? entry.default : entry.other}${entry.decision.failed === null ? "" : ` (failed: ${entry.decision.failed})`}`,
    ]),
  );

const depthLine = (coverage: MarkdownInput["inputs"]["depthCoverage"]) => {
  const entries = Object.entries(coverage);
  if (entries.length === 0)
    return "- Ranking depth: not read (pool-only mode).";
  const short = entries.filter(([, entry]) => entry.short.length > 0);
  const wholeBase = Math.max(...entries.map(([, entry]) => entry.wholeBase));
  return `- Rankings holding each dev hunk's Opus real share: ${entries.length - short.length} of ${entries.length} arms for every hunk${wholeBase > 0 ? ` (counting up to ${wholeBase} hunks whose whole base is smaller than the share)` : ""}. Short of it: ${
    short.length === 0
      ? "none"
      : short.map(([arm, entry]) => `${arm} ${entry.short.length}`).join(", ")
  } (hunks listed in the JSON, \`inputs.depthCoverage\`).`;
};

type Costs = ReadonlyMap<string, { readonly latencyMillis: unknown }>;
const at = (summary: Summary, label: string) => summary.curve[label] as Curve;

/** The headline table: each arm at the real share. */
export const headlineTable = (arms: ReadonlyArray<Summary>, costs: Costs) =>
  table(
    [
      "Arm",
      "NR Opus",
      "NR Sol",
      "RR Opus",
      "RR Sol",
      "any-line",
      "≥50%",
      "UR Opus",
      "Misleading",
      "Misleading tokens",
      "Judged tokens",
      "Saturation (first flat step)",
      "RR saturation",
      "MRR",
      "nDCG@10",
      "Warm p50",
      "Pool only",
    ],
    arms.map((summary) => {
      const opus = at(summary, "real-opus");
      const sol = at(summary, "real-sol");
      return [
        summary.arm,
        pct(opus.necessary.fractional),
        pct(sol.necessary.fractional),
        pct(opus.relevant.fractional),
        pct(sol.relevant.fractional),
        pct(opus.necessary.anyLine),
        pct(opus.necessary.half),
        pct(opus.useful),
        pct(opus.misleadingShare),
        pct(opus.misleadingTokenShare),
        pct(opus.judgedTokenShare),
        `${summary.saturation === null ? "not reached" : tokens(summary.saturation)} (${summary.saturationFirstFlat === null ? "none" : tokens(summary.saturationFirstFlat)})`,
        summary.relevantSaturation === null
          ? "not reached"
          : tokens(summary.relevantSaturation),
        summary.mrr === null ? "–" : summary.mrr.toFixed(3),
        summary.ndcg10 === null ? "–" : summary.ndcg10.toFixed(3),
        latency(costs.get(summary.arm)?.latencyMillis),
        poolOnlyCell(summary),
      ];
    }),
  );

/** Necessary / relevant recall at each fixed allowance. */
export const curveTable = (arms: ReadonlyArray<Summary>) =>
  table(
    [
      "Arm",
      ...ALLOWANCES.map((allowance) => budgetLabel(allowance)),
      "computed Opus",
      "computed Sol",
      "Pool only",
    ],
    arms.map((summary) => {
      const both = (label: string) =>
        `${pct(at(summary, label).necessary.fractional)} / ${pct(at(summary, label).relevant.fractional)}`;
      return [
        summary.arm,
        ...ALLOWANCES.map((allowance) => both(budgetLabel(allowance))),
        both("computed-opus"),
        both("computed-sol"),
        poolOnlyCell(summary),
      ];
    }),
  );

export const renderMarkdown = (report: MarkdownInput) => {
  const costs = new Map(report.costs.arms.map((entry) => [entry.arm, entry]));
  const lines: Array<string> = [];
  const gold = report.gold;
  lines.push(
    "# M4 benchmark: development scoring (B4)",
    "",
    `> **${report.status}**`,
    "",
    `Gold covers **${gold.hunks} of ${gold.devHunks} dev hunks** in ${gold.families} families (${gold.withNecessary} with necessary gold): ${gold.necessaryTargets} necessary and ${gold.usefulTargets} useful retrieval targets, of which ${gold.fromAdditions.necessary} necessary and ${gold.fromAdditions.useful} useful came from labeller additions (9.16). ${gold.misleadingJudged} judged spans are misleading. ${gold.provisionalOwnerItems} relevant items still carry a provisional grade awaiting the owner (9.36).`,
    "",
    `Rankings: ${report.generatedFrom.mode}. The rule is read at the **${report.settings.decideAt}** real share with ${report.settings.comparisons} comparisons (Bonferroni), ${report.settings.resamples} resamples, seed \`${report.settings.seed}\`.`,
    "",
    "## Headline at the real share",
    "",
    "Necessary recall (fractional coverage, family-weighted) at each hunk's real share for Opus and Sol, with the any-line and at-least-50% sensitivity readings at the Opus share, relevant recall (RR: necessary and useful targets together, 9.54), useful recall, the misleading share of judged served items by count and by tokens, and the saturation point: where the curve stays flat (9.40), with the literal first flat step (9.18) in brackets, and the same flat reading on relevant recall beside it. Pool only names the scored hunks this arm is read at only its frozen top 50 (no deep ranking): they stay in this arm's own numbers and curve, and comparisons leave them out.",
    "",
    headlineTable(report.arms, costs),
    "",
    "## Allowance curve",
    "",
    "Necessary recall / relevant recall at each fixed allowance (9.14, 9.54). A dash means no hunk with that gold. Past the pool, a pool-only hunk adds nothing to its arm's curve.",
    "",
    curveTable(report.arms),
    "",
    "## Rank depth and tokens to necessary context",
    "",
    "Of the necessary targets found within the Opus real share, the share first reached in the top 5, 10 and 20 (9.19); and per hunk, the tokens read up to the first necessary item and up to all of them (median, with how many hunks reached them in the whole ranking).",
    "",
    table(
      [
        "Arm",
        "Found",
        "Top 5",
        "Top 10",
        "Top 20",
        "Tokens to first",
        "Tokens to all",
        "Recall@10 N",
        "Recall@10 U",
        "Judged@10",
        "Judged@50",
      ],
      report.arms.map((summary) => {
        const depth = at(summary, "real-opus").rankDepth;
        return [
          summary.arm,
          depth.found,
          pct(depth.top5),
          pct(depth.top10),
          pct(depth.top20),
          `${tokens(summary.tokensToFirstNecessary.median)} (${summary.tokensToFirstNecessary.reached}/${summary.tokensToFirstNecessary.hunks})`,
          `${tokens(summary.tokensToAllNecessary.median)} (${summary.tokensToAllNecessary.reached}/${summary.tokensToAllNecessary.hunks})`,
          pct(summary.recallAt[10]?.necessary),
          pct(summary.recallAt[10]?.useful),
          pct(summary.judgedAt[10]),
          pct(summary.judgedAt[50]),
        ];
      }),
    ),
    "",
  );
  const focus = [
    "L",
    report.selection.bestDense,
    report.selection.bestFusion,
    report.selection.bestTopology,
    "G-fork",
    "G-base",
    "R",
    "H3-E1",
    "R(H3-E1)",
    "H3-E3",
    "R(H3-E3)",
  ].filter((arm, index, list) => list.indexOf(arm) === index);
  const focusSummaries = report.arms.filter((summary) =>
    focus.includes(summary.arm),
  );
  const strata = (
    field: "scopeSource" | "period" | "changeType",
    title: string,
  ) => {
    const groups = [
      ...new Set(
        focusSummaries.flatMap((summary) =>
          Object.keys(summary.strata[field] ?? {}),
        ),
      ),
    ].sort();
    lines.push(
      `### ${title}`,
      "",
      table(
        ["Arm", ...groups],
        focusSummaries.map((summary) => [
          summary.arm,
          ...groups.map((group) => {
            const entry = (
              summary.strata[field] as Record<
                string,
                {
                  opus: number | null;
                  relevantOpus: number | null;
                  hunks: number;
                }
              >
            )[group];
            return entry === undefined
              ? "–"
              : `${pct(entry.opus)} / ${pct(entry.relevantOpus)} (${entry.hunks})`;
          }),
        ]),
      ),
      "",
    );
  };
  lines.push(
    "## By kind, scope stratum, period and change type",
    "",
    `Necessary recall at the Opus real share for the selected arms; the scope, period and change-type tables show necessary / relevant recall (hunks in brackets). Selected on dev: dense ${report.selection.bestDense}, fusion ${report.selection.bestFusion}, topology ${report.selection.bestTopology}.`,
    "",
  );
  const kinds = [
    ...new Set(
      focusSummaries.flatMap((summary) => Object.keys(summary.perKind)),
    ),
  ].sort();
  lines.push(
    "### Per kind of necessary gold",
    "",
    table(
      ["Arm", ...kinds],
      focusSummaries.map((summary) => [
        summary.arm,
        ...kinds.map((kind) => pct(summary.perKind[kind])),
      ]),
    ),
    "",
  );
  strata("scopeSource", "Per scope stratum (9.13)");
  strata("period", "Per period (9.28)");
  strata("changeType", "Per change type");
  lines.push(
    "## Hub measure (9.32)",
    "",
    `k-occurrence: how many dev queries put a chunk in their top ${report.hubs.k}. Skew is over the chunk population (${report.inputs.chunkPopulation} chunks over the dev bases); hub chunks are the most-retrieved 1% of that population, ties included and never fewer than ${report.hubs.minHubOccurrence} queries, and the top-1% share is the share of served tokens at the Opus real share spent on them. Necessary recall is split by a reference measure shared by every arm: a target is often-retrieved when an overlapping item is in the top ${report.hubs.k} of at least ${report.hubs.oftenThreshold} other-family dev queries on average over the reference arms (${report.hubs.oftenTargets} of ${report.hubs.goldTargets} relevant targets).`,
    "",
    table(
      [
        "Arm",
        "Skew k=50",
        "Skew k=10",
        "Max",
        "Hub chunks",
        "Top-1% share",
        "NR often",
        "NR rare",
      ],
      Object.entries(report.hubs.arms).map(([arm, entry]) => [
        arm,
        entry.skew === null ? "–" : entry.skew.toFixed(2),
        entry.skewAt10 === null ? "–" : entry.skewAt10.toFixed(2),
        entry.maxOccurrence,
        `${entry.topChunks} (≥ ${entry.topThreshold})`,
        pct(entry.topBudgetShare),
        `${pct(entry.necessaryRecall.often.mean)} (${entry.necessaryRecall.often.targets})`,
        `${pct(entry.necessaryRecall.rare.mean)} (${entry.necessaryRecall.rare.targets})`,
      ]),
    ),
    "",
    "## Variants (9.32)",
    "",
    `Tuned on dev only, ranked by leave-one-family-out gain over the base arm (necessary recall at the Opus real share, points), with the in-sample gain beside it. In-sample is the tuned setting's own score; leave-one-family-out chooses on the other families. No variant reaches held-out automatically: the owner names any sixth comparison (9.46). ${report.variants.v3.note}`,
    "",
    table(
      [
        "Variant",
        "Over",
        "LOFO gain",
        "In-sample gain",
        "Chosen",
        "In-sample NR",
        "LOFO NR",
        "Base NR",
        "ms/hunk",
        "Note",
      ],
      report.variants.ranking.map((ranked) => {
        const entry = report.variants.list.find(
          (variant) => variant["arm"] === ranked.arm,
        ) as Record<string, unknown>;
        const tuning = entry["tuning"] as {
          chosen?: unknown;
          inSample?: number | null;
          leaveOneFamilyOut?: number | null;
        } | null;
        const base = report.arms.find((summary) => summary.arm === entry["of"]);
        return [
          String(entry["arm"]),
          String(entry["of"]),
          pct(ranked.leaveOneFamilyOutGain),
          pct(ranked.inSampleGain),
          tuning === null ? "–" : `\`${JSON.stringify(tuning.chosen)}\``,
          pct(tuning?.inSample ?? null),
          pct(tuning?.leaveOneFamilyOut ?? null),
          pct(
            base === undefined
              ? null
              : at(base, "real-opus").necessary.fractional,
          ),
          String(entry["postProcessMillisPerHunk"] ?? "–"),
          (
            (entry["fullyTruncatedHunks"] as
              ReadonlyArray<string> | undefined) ?? []
          ).length === 0
            ? ""
            : `reranker pairs fully truncated for ${(entry["fullyTruncatedHunks"] as ReadonlyArray<string>).join(", ")}: its order there rests on cut texts only`,
        ];
      }),
    ),
    "",
    `## Pre-registered comparisons (9.21), read at the ${report.comparisons.decideAt} real share`,
    "",
    "The default (simpler) arm wins unless the other's adjusted lower bounds on both the necessary-recall (NR) and the relevant-recall (RR) delta exceed +3 points and the misleading guard holds (9.21, 9.54); the outcome names the first condition that failed. The guard is paired over the hunks where both arms served a judged item (count in brackets). Leakage exclusions follow what either arm contains (9.47): the tuned adapter or the Graph fork, with the arms that bring each in and the hunks it drops. Hunks where either arm has a recorded failure are left out (no answer; causes in the JSON and below), and so are hunks where one arm is read only at its frozen top 50 and the other deep (mixed depth). These are dev previews; the rule decides only on held-out.",
    "",
    ...(report.comparisons.list.some((entry) => entry.name.startsWith("6. "))
      ? [
          "Comparison 6 is the owner's sixth under 9.46 (9.57): Graph, keyword search and one embedding model fused, then the reranker over the fusion's top 50 with the fusion's deeper ranking below it, with E1 against the same with E3. Its default is the E1 combination, the smaller and cheaper model, since 9.21 keeps the simpler arm on an inconclusive result.",
          "",
        ]
      : []),
    comparisonTable(report.comparisons.list),
    "",
    `At the other share: ${report.comparisons.otherShare.map((entry) => `${entry.name} → ${entry.decision.outcome}`).join("; ")}.`,
    "",
    ...(report.comparisons.previews.length === 0
      ? []
      : [
          "### Dev previews beside comparison 6 (9.57)",
          "",
          "Read like the comparisons, at the same adjusted level and with the same depth rules, on comparison 6's hunks: each carries the leakage exclusions of all four arms (9.47), so the deltas are comparable with each other and with comparison 6. They are not pre-registered, add nothing to the Bonferroni count and decide nothing. P1 is the two combinations before the reranker; P2 and P3 are the reranker's gain on each.",
          "",
          comparisonTable(report.comparisons.previews),
          "",
          `At the other share: ${report.comparisons.previewsOtherShare.map((entry) => `${entry.name} ${pct(entry.delta)} (${level(entry.interval.level)}: ${pct(entry.interval.lower)} … ${pct(entry.interval.upper)}), RR ${pct(entry.relevant.delta)}`).join("; ")}.`,
          "",
        ]),
    "## Costs",
    "",
    `Encoding wall time on Modal (seconds): ${Object.entries(
      report.costs.encodingWallSeconds,
    )
      .map(([model, seconds]) => `${model} ${seconds}`)
      .join(
        ", ",
      )}. Graph preparation, first measured: ${report.costs.graphPreparationSeconds.full.toFixed(0)} s full, ${report.costs.graphPreparationSeconds.syntax.toFixed(0)} s syntax-only over the dev bases. Per-arm latency and pool tokens are in the JSON (\`costs.arms\`).`,
    "",
    ...(report.costs.options957.length === 0
      ? []
      : [
          "The two 9.57 options, per hunk where it applies. The fusion's latency is this machine's (Graph dominates it, and is the same for both); the reranker's is Modal seconds for the 50 pairs of a hunk, after the fusion.",
          "",
          table(
            [
              "Option",
              "Embedding model",
              "Dimensions",
              "Dense index (dev bases)",
              "Chunk encoding on Modal",
              "Query encoding on Modal",
              "Fusion p50",
              "Reranker p50",
            ],
            report.costs.options957.map((entry) => [
              entry.option,
              entry.label,
              entry.dimensions ?? "–",
              entry.indexBytes === null
                ? "–"
                : `${(entry.indexBytes / 1e9).toFixed(2)} GB`,
              entry.chunkEncodeWallSeconds === null
                ? "–"
                : `${entry.chunkEncodeWallSeconds} s${entry.chunkUnits === null ? "" : ` (${entry.chunkUnits} units)`}`,
              entry.queryEncodeMillisPerQuery === null
                ? "–"
                : `${entry.queryEncodeMillisPerQuery} ms per query, batched`,
              latency({ warm: { p50: entry.fusionWarmP50Millis } }),
              latency({ warm: { p50: entry.rerankWarmP50Millis } }),
            ]),
          ),
          "",
        ]),
    "## Failures and gaps in the inputs",
    "",
    report.failures.graph.length === 0
      ? "- No Graph failures."
      : report.failures.graph
          .map(
            (failure) =>
              `- ${failure.arm} ${failure.depth} answer, ${failure.hunkId} (${failure.caseId}): ${failure.error}`,
          )
          .join("\n"),
    `- S-ref returned nothing for ${report.failures.srefEmpty.length} hunks (listed in the JSON with each relationship's outcome).`,
    rerankLine(report.failures.rerankTruncation),
    `- Hunks whose real share exceeds the deep rankings: Opus ${report.inputs.hunksAboveDeepCap.opus.length}, Sol ${report.inputs.hunksAboveDeepCap.sol.length}. ${report.inputs.hunksAboveDeepCap.note}`,
    depthLine(report.inputs.depthCoverage),
    `- Rebuilt rankings that differ from their frozen pools: ${Object.keys(report.inputs.rebuiltPoolMismatches).length === 0 ? "none" : JSON.stringify(report.inputs.rebuiltPoolMismatches)}.`,
    `- Gold kept out of pass 1 scoring: ${
      Object.entries(gold.excluded)
        .map(([reason, count]) => `${reason} ${count}`)
        .join("; ") || "none"
    }. Identical relevant spans listed twice: ${gold.duplicateSpans} (kept once). Overlapping relevant spans of one grade: ${gold.overlappingSpans} (kept).`,
    "",
    "## Rules",
    "",
    ...Object.entries(report.rules).map(
      ([name, text]) => `- **${name}**: ${text}`,
    ),
    "",
  );
  return lines.join("\n");
};
