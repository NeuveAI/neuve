import type { GraphFailure } from "../deep-rankings.ts";
import type { FrozenVariant } from "./frozen.ts";
import type { devBeside, failuresAsMisses } from "./heldout.ts";
import {
  comparisonTable,
  curveTable,
  headlineTable,
  level,
  pct,
  table,
} from "./markdown.ts";
import type { runComparison, summarizeArm } from "./report.ts";

/** The readable summary of score.heldout.json. Short tables; the JSON holds everything else. */

type Summary = ReturnType<typeof summarizeArm>;
type ComparisonResult = ReturnType<typeof runComparison>;
type DevReading = ReturnType<typeof devBeside> & { readonly name: string };
type Tally = {
  readonly targets: number;
  readonly kept: number;
  readonly dropped: number;
  readonly droppedByStatus: Readonly<Record<string, number>>;
};

export interface HeldOutMarkdownInput {
  readonly split: string;
  readonly status: string;
  readonly generatedFrom: {
    readonly mode: string;
    readonly sha256: { readonly devReport: string };
  };
  readonly frozen: {
    readonly devReport: { readonly path: string; readonly sha256: string };
    readonly selection: {
      readonly bestDense: string;
      readonly bestFusion: string;
      readonly bestTopology: string;
    };
    readonly variants: ReadonlyArray<FrozenVariant>;
  };
  readonly settings: {
    readonly decideAt: string;
    readonly comparisons: number;
    readonly resamples: number;
    readonly seed: string;
  };
  readonly rules: Readonly<Record<string, string>>;
  readonly gold: {
    readonly hunks: number;
    readonly splitHunks: number;
    readonly families: number;
    readonly withNecessary: number;
    readonly necessaryTargets: number;
    readonly usefulTargets: number;
    readonly misleadingJudged: number;
    readonly excluded: Readonly<Record<string, number>>;
    readonly duplicateSpans: number;
  };
  readonly arms: ReadonlyArray<Summary>;
  readonly variants: {
    readonly note: string;
    readonly heldOut: ReadonlyArray<{
      readonly arm: string;
      readonly of?: string;
      readonly heldOutGain?: number | null;
    }>;
    readonly list: ReadonlyArray<Record<string, unknown>>;
    readonly notScored: {
      readonly reason: string;
      readonly arms: ReadonlyArray<{
        readonly arm: string;
        readonly scoredHunks: number;
        readonly hunks: number;
      }>;
    };
  };
  readonly comparisons: {
    readonly decideAt: string;
    readonly list: ReadonlyArray<ComparisonResult>;
    readonly otherShare: ReadonlyArray<ComparisonResult>;
    readonly previews: ReadonlyArray<ComparisonResult>;
    readonly dev: ReadonlyArray<DevReading>;
    readonly devOtherShare: ReadonlyArray<DevReading>;
  };
  readonly crossFamily: {
    readonly items: Tally;
    readonly devItems: Tally;
    readonly scoredTargets: {
      readonly full: { readonly necessary: number; readonly useful: number };
      readonly kept: { readonly necessary: number; readonly useful: number };
    };
    readonly list: ReadonlyArray<ComparisonResult>;
    readonly otherShare: ReadonlyArray<ComparisonResult>;
  };
  readonly graphFailureEffect: {
    readonly list: ReturnType<typeof failuresAsMisses>;
  };
  readonly costs: {
    readonly arms: ReadonlyArray<{
      readonly arm: string;
      readonly latencyMillis: unknown;
    }>;
  };
  readonly failures: {
    readonly graph: ReadonlyArray<GraphFailure>;
    readonly srefEmpty: ReadonlyArray<GraphFailure>;
  };
}

const outcome = (entry: {
  readonly default: string;
  readonly other: string;
  readonly decision: { readonly outcome: string; readonly winner: string };
}) =>
  `${entry.decision.outcome}: ${entry.decision.winner === "default" ? entry.default : entry.other}`;

const reading = (entry: {
  readonly delta: number | null;
  readonly interval: {
    readonly lower: number | null;
    readonly upper: number | null;
  };
}) =>
  `${pct(entry.delta)} (${pct(entry.interval.lower)} … ${pct(entry.interval.upper)})`;

const tally = (entry: Tally) =>
  `${entry.kept} of ${entry.targets} kept, ${entry.dropped} dropped${
    entry.dropped === 0
      ? ""
      : ` (${Object.entries(entry.droppedByStatus)
          .map(([status, count]) => `${status} ${count}`)
          .join(", ")})`
  }`;

/** A sensitivity's rule as a sentence under its heading, which already says what it is. */
const sentence = (rule: string | undefined) => {
  const text = (rule ?? "").replace(/^sensitivity, never the decision: /, "");
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
};

export const renderHeldOutMarkdown = (report: HeldOutMarkdownInput) => {
  const gold = report.gold;
  const list = report.comparisons.list;
  const dev = new Map(
    report.comparisons.dev.map((entry) => [entry.name, entry]),
  );
  const devOther = new Map(
    report.comparisons.devOtherShare.map((entry) => [entry.name, entry]),
  );
  const cross = new Map(
    report.crossFamily.list.map((entry) => [entry.name, entry]),
  );
  const costs = new Map(report.costs.arms.map((entry) => [entry.arm, entry]));
  const levelText = level(list[0]?.interval.level);
  const lines: Array<string> = [
    report.split === "held-out"
      ? "# M4 benchmark: held-out scoring (9.58)"
      : "# M4 benchmark: dev replay of the held-out path (a check, not a result)",
    "",
    `> **${report.status}**`,
    "",
    `Frozen configuration, read back from the dev report \`${report.frozen.devReport.path.slice(report.frozen.devReport.path.indexOf("validation/"))}\` (SHA-256 \`${report.frozen.devReport.sha256.slice(0, 16)}…\`): dense **${report.frozen.selection.bestDense}**, fusion **${report.frozen.selection.bestFusion}**, topology **${report.frozen.selection.bestTopology}**, and each variant's dev setting. The rule is read at the **${report.settings.decideAt}** real share with ${report.settings.comparisons} comparisons (Bonferroni, ${levelText} intervals), ${report.settings.resamples} resamples, seed \`${report.settings.seed}\`, as on dev. Rankings: ${report.generatedFrom.mode}.`,
    "",
    `Gold covers **${gold.hunks} of ${gold.splitHunks} ${report.split} hunks** in ${gold.families} families (${gold.withNecessary} with necessary gold): ${gold.necessaryTargets} necessary and ${gold.usefulTargets} useful retrieval targets. ${gold.misleadingJudged} judged spans are misleading.`,
    "",
    "## Verdicts",
    "",
    `Necessary recall (NR) and relevant recall (RR) deltas, other arm minus default, at the ${report.comparisons.decideAt} real share, with the Bonferroni-adjusted interval in brackets. The other arm wins only when both lower bounds exceed +3 points and the misleading guard holds (9.21, 9.54). Dev's reading of the same comparison is beside it.`,
    "",
    table(
      [
        "Comparison",
        "NR delta",
        "RR delta",
        "Held-out outcome",
        "Dev NR delta",
        "Dev RR delta",
        "Dev outcome",
        `Sol share (dev)`,
      ],
      list.map((entry, index) => {
        const before = dev.get(entry.name) as DevReading;
        const sol = report.comparisons.otherShare[index] as ComparisonResult;
        return [
          entry.name,
          reading(entry),
          reading(entry.relevant),
          `**${outcome(entry)}**`,
          reading(before),
          reading(before.relevant),
          outcome(before),
          `${outcome(sol)} (${outcome(devOther.get(entry.name) as DevReading)})`,
        ];
      }),
    ),
    "",
    "## Pre-registered comparisons in full",
    "",
    comparisonTable(list, "Held-out outcome"),
    "",
    `At the other share: ${report.comparisons.otherShare.map((entry) => `${entry.name} NR ${reading(entry)}, RR ${reading(entry.relevant)} → ${entry.decision.outcome}`).join("; ")}.`,
    "",
    "## Hunks each rule removed, held-out against dev",
    "",
    "Leakage exclusions follow what either arm contains (9.47); no answer is a recorded failure of either arm (left out and listed); mixed depth is one arm read only at its frozen top 50 (a failed deep answer) against a deep ranking (left out). Each cell is held-out / dev.",
    "",
    table(
      [
        "Comparison",
        "Leakage",
        "No answer",
        "Mixed depth",
        "Paired (NR)",
        "Families",
      ],
      list.map((entry) => {
        const before = dev.get(entry.name) as DevReading;
        return [
          entry.name,
          `${entry.excludedHunks} / ${before.excludedHunks}`,
          `${entry.noAnswer.length} / ${before.noAnswer}`,
          `${entry.mixedDepth.length} / ${before.mixedDepth}`,
          `${entry.pairedHunks} / ${before.pairedHunks}`,
          `${entry.families} / ${before.families}`,
        ];
      }),
    ),
    "",
    "## Cross-family subset (sensitivity, never the decision)",
    "",
    `${sentence(report.rules["crossFamily"])}.`,
    "",
    `- Relevant retrieval-target items on held-out: ${tally(report.crossFamily.items)}. The same rule on dev's gold: ${tally(report.crossFamily.devItems)}.`,
    `- Scored pass 1 targets: ${report.crossFamily.scoredTargets.kept.necessary} of ${report.crossFamily.scoredTargets.full.necessary} necessary and ${report.crossFamily.scoredTargets.kept.useful} of ${report.crossFamily.scoredTargets.full.useful} useful remain.`,
    "",
    table(
      [
        "Comparison",
        "NR delta",
        "RR delta",
        "Outcome on the subset",
        "Decision (full gold)",
        "Paired (NR, RR)",
      ],
      list.map((entry) => {
        const subset = cross.get(entry.name) as ComparisonResult;
        return [
          entry.name,
          reading(subset),
          reading(subset.relevant),
          outcome(subset),
          outcome(entry),
          `${subset.pairedHunks}, ${subset.relevant.pairedHunks}`,
        ];
      }),
    ),
    "",
    `At the other share on the subset: ${report.crossFamily.otherShare.map((entry) => `${entry.name} → ${entry.decision.outcome}`).join("; ")}.`,
    "",
    "## Graph failure effect (sensitivity, never the decision)",
    "",
    `${sentence(report.rules["graphFailureEffect"])}.`,
    "",
    ...(report.graphFailureEffect.list.length === 0
      ? ["No comparison left a hunk out for a recorded failure.", ""]
      : [
          table(
            [
              "Comparison",
              "NR delta",
              "RR delta",
              "Outcome with failures as misses",
              "Decision (left out)",
              "Paired (NR)",
              "Counted as misses",
            ],
            report.graphFailureEffect.list.map((entry) => {
              const decision = list.find(
                (item) => item.name === entry.name,
              ) as ComparisonResult;
              return [
                entry.name,
                reading(entry),
                reading(entry.relevant),
                outcome(entry),
                outcome(decision),
                `${entry.pairedHunks} (decision ${decision.pairedHunks})`,
                entry.countedAsMisses
                  .map(
                    (hunk) =>
                      `${hunk.hunkId} (${hunk.failed.map((failure) => `${failure.arm} NR ${failure.scored ? pct(failure.necessary) : "unscored"}`).join(", ")})`,
                  )
                  .join("; "),
              ];
            }),
          ),
          "",
        ]),
    ...(report.comparisons.previews.length === 0
      ? []
      : [
          "## Previews beside comparison 6 (descriptive)",
          "",
          "As on dev: read like the comparisons on comparison 6's hunks, not pre-registered, adding nothing to the Bonferroni count and deciding nothing.",
          "",
          comparisonTable(
            report.comparisons.previews,
            "Reading (not a decision)",
          ),
          "",
        ]),
    "## Headline at the real share",
    "",
    "Descriptive, as on dev: necessary and relevant recall at each hunk's real share, the misleading share, and the saturation point (9.40, first flat step in brackets). Pool only names hunks an arm is read at only its frozen top 50.",
    "",
    headlineTable(report.arms, costs),
    "",
    "## Allowance curve",
    "",
    "Necessary recall / relevant recall at each fixed allowance.",
    "",
    curveTable(report.arms),
    "",
    "## Variants at dev's settings (descriptive)",
    "",
    report.variants.note,
    "",
    ...(report.variants.notScored.arms.length === 0
      ? []
      : [
          `Not scored on ${report.split}, and left out of the headline, curve and gain tables: ${report.variants.notScored.arms.map((entry) => `${entry.arm} (${entry.scoredHunks} of ${entry.hunks} hunks)`).join(", ")}; ${report.variants.notScored.reason}.`,
          "",
        ]),
    table(
      ["Variant", "Over", "Dev setting", "Gain over its base (NR, Opus share)"],
      report.variants.heldOut.map((entry) => [
        entry.arm,
        entry.of ?? "–",
        `\`${JSON.stringify(report.frozen.variants.find((variant) => variant.arm === entry.arm)?.chosen ?? null)}\``,
        pct(entry.heldOutGain ?? null),
      ]),
    ),
    "",
    "## Failures in the inputs",
    "",
    report.failures.graph.length === 0
      ? "- No Graph failures."
      : report.failures.graph
          .map(
            (failure) =>
              `- ${failure.arm} ${failure.depth} answer, ${failure.hunkId} (${failure.caseId}): ${failure.error}`,
          )
          .join("\n"),
    `- S-ref returned nothing for ${report.failures.srefEmpty.length} hunks (listed in the JSON).`,
    `- Gold kept out of pass 1 scoring: ${
      Object.entries(gold.excluded)
        .map(([reason, count]) => `${reason} ${count}`)
        .join("; ") || "none"
    }. Identical relevant spans listed twice: ${gold.duplicateSpans} (kept once).`,
    "",
    "## Rules",
    "",
    ...Object.entries(report.rules).map(
      ([name, text]) => `- **${name}**: ${text}`,
    ),
    "",
  ];
  return lines.join("\n");
};
