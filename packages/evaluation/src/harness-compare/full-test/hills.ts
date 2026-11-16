import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDir } from "../common.ts";
import { FULL_TEST_RESULTS } from "./config.ts";
import { MEASUREMENTS_FILE, type Measurements } from "./measures.ts";

/**
 * The hills report (FT16), rendered from `measurements.json` so a rescore never leaves it stale:
 *
 * 1. Measurements: each stage's measures per phase, A against A′ (the noise floor), against C and
 *    against B under FT5's statistic, with the counts behind them and generation-0 outcomes apart.
 * 2. Gaps: each as stage, measure, size in its own unit, share affected, and whether it exceeds the
 *    noise floor; one inside the floor is listed as not separable.
 * 3. Fixability, one of three classes, from a pre-registered table of known levers (below); any gap
 *    not in the table is "cause unknown". The table is the agent's, written before the runs; the
 *    owner can move a gap between classes.
 * 4. Ranking: within each class, by size over the noise floor.
 * 5. Interpretation, under its own heading and labelled as the agent's reading (2.16), never mixed
 *    into the measurements. It states that Graph's structural lookups in agentic search were not
 *    measured (C7), nor Graph's semantic query as a search tool unless FT17's later phase ran.
 *
 * The owner chooses the hills; the report proposes none as decided.
 */

export type Fixability =
  "lever in reach" | "lever costs a round" | "cause unknown";

/** Known levers, pre-registered: a gap's id prefix to its class and the lever. */
export const LEVERS: ReadonlyArray<{
  readonly prefix: string;
  readonly fixability: Fixability;
  readonly lever: string;
}> = [
  {
    prefix: "ledger.drops",
    fixability: "lever in reach",
    lever: "lead drops (10.88's mitigation; a prompt or setting)",
  },
  {
    prefix: "receipts.timeouts",
    fixability: "lever in reach",
    lever:
      "migration snapshot JSON counted as review lines, declarable as generated (10.23); the lifetime is ruled and not a lever",
  },
  {
    prefix: "rules.",
    fixability: "lever in reach",
    lever: "a known defect against the slice owning the rule (H7, H8)",
  },
  {
    prefix: "retrieval.",
    fixability: "lever costs a round",
    lever: "an M4 round (9.64's weighted fusion) or a new source",
  },
  {
    prefix: "ledger.coverage",
    fixability: "lever costs a round",
    lever: "agentic Graph or E0 search (FT17), another model, or a new source",
  },
  { prefix: "references.coverage", fixability: "cause unknown", lever: "" },
];

export const fixabilityOf = (id: string) => {
  const lever = LEVERS.find((entry) => id.startsWith(entry.prefix));
  return lever === undefined
    ? { fixability: "cause unknown" as const, lever: "" }
    : { fixability: lever.fixability, lever: lever.lever };
};

export interface Gap {
  readonly id: string;
  readonly stage: string;
  readonly measure: string;
  /** Size in the measure's own unit. */
  readonly size: number;
  readonly unit: string;
  readonly affected: string;
  /** The noise floor in the same unit, or null when none applies (counts of rule violations). */
  readonly floor: number | null;
  readonly separable: boolean;
}

type Row = Record<string, unknown> & { mean?: number | null };

const metricOf = (row: Record<string, unknown>, metric: string) =>
  ((row[metric] as { mean: number | null } | undefined)?.mean ?? null) as
    number | null;

/** The gaps the measurements show, each against its noise floor where one applies. */
export const gapsFrom = (m: Measurements): Array<Gap> => {
  const gaps: Array<Gap> = [];
  const floorOf = (metric: string, view: string, source: string) => {
    const entry = m.noiseFloor.find(
      (row) =>
        row.metric === metric && row.view === view && row.source === source,
    );
    return entry?.delta.familyWeighted.absCi95[1] ?? null;
  };
  for (const row of m.ledger.summary as ReadonlyArray<Row>) {
    if (row["phase"] !== "A" || row["view"] !== "all") continue;
    const source = String(row["source"]);
    if (source === "ledger+top3") continue;
    for (const metric of ["necessary", "relevant"]) {
      const value = metricOf(row, metric);
      if (value === null) continue;
      const floor = floorOf(metric, "all", source);
      const size = 1 - value;
      gaps.push({
        id: `${source === "ledger" ? "ledger" : "references"}.coverage.${metric}`,
        stage: source === "ledger" ? "Investigate's ledger" : "context margin",
        measure: `${metric} coverage at depth (fractional, view all), phase A`,
        size,
        unit: "share of gold not covered",
        affected: `${String(row["hunks"])} scored hunks`,
        floor,
        separable: floor !== null && size > floor,
      });
    }
  }
  for (const entry of m.retrieval) {
    if (!("summary" in entry)) continue;
    const top10 = (entry.summary as ReadonlyArray<Row>).find(
      (row) => row["depth"] === "top10" && row["view"] === "all",
    );
    const value = top10 === undefined ? null : metricOf(top10, "necessary");
    if (value !== null)
      gaps.push({
        id: `retrieval.top10.${entry.arm}`,
        stage: "retrieval",
        measure: `${entry.arm}: necessary coverage of the 10 served leads (fractional, view all)`,
        size: 1 - value,
        unit: "share of gold not covered",
        affected: `${String(top10?.["hunks"] ?? 0)} scored hunks`,
        floor: null,
        separable: true,
      });
  }
  const violations = new Map<string, number>();
  for (const v of m.ruleViolations)
    violations.set(v.rule, (violations.get(v.rule) ?? 0) + 1);
  for (const [rule, count] of violations)
    gaps.push({
      id: `rules.${rule}`,
      stage: "lanes and dispositions",
      measure: `violations of ${rule}`,
      size: count,
      unit: "violations",
      affected: `${count} unit(s) or batch(es)`,
      floor: null,
      separable: true,
    });
  const drops = m.ledger.counts["A"]?.["droppedSeeded"] ?? 0;
  if (drops > 0)
    gaps.push({
      id: "ledger.drops",
      stage: "Investigate's ledger",
      measure: "seeded leads dropped, phase A",
      size: drops,
      unit: "drops",
      affected: `${m.ledger.counts["A"]?.["entries"] ?? 0} entries kept`,
      floor: null,
      separable: true,
    });
  for (const [phase, entry] of Object.entries(m.receipts.byPhase)) {
    const timed = (entry as { gen0TimedOut: ReadonlyArray<string> })
      .gen0TimedOut;
    if (timed.length > 0)
      gaps.push({
        id: `receipts.timeouts.${phase}`,
        stage: "receipts",
        measure: `generation-0 timeouts, phase ${phase}`,
        size: timed.length,
        unit: "runs",
        affected: timed.join(", "),
        floor: null,
        separable: true,
      });
  }
  for (const known of m.knownCases)
    if (known.ran && "caught" in known && known.caught === false)
      gaps.push({
        id: `rules.known.${known.caseId}.${known.phase}`,
        stage: "dispositions",
        measure: `known case not caught (${known.caseId}, ${known.phase})`,
        size: 1,
        unit: "missed defects",
        affected: known.caseId,
        floor: null,
        separable: true,
      });
  return gaps;
};

const pad = (value: number | null | undefined, digits = 3) =>
  value === null || value === undefined ? "n/a" : value.toFixed(digits);

export const hillsMarkdown = (m: Measurements) => {
  const lines: Array<string> = [
    "# The full test: hills report",
    "",
    `Measured ${m.measuredAt} on snapshot ${m.snapshot ?? "not pinned"}: ${m.scoredHunks} scored hunks in ${m.scoredFamilies} families. Runs missing: ${m.missingRuns.length === 0 ? "none" : m.missingRuns.join(", ")}.`,
    "",
    "## Departures from the proposal as ruled",
    "",
    ...m.deviations.map((line) => `- ${line}`),
    "",
    "## Measurements",
    "",
    "### Retrieval: the served leads",
    "",
    "| arm | depth | view | hunks | necessary | relevant | necessary, any line | relevant, any line |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const entry of m.retrieval) {
    if (!("summary" in entry)) {
      lines.push(`| ${entry.arm} | leads file not landed | | | | | | |`);
      continue;
    }
    for (const row of entry.summary as ReadonlyArray<Row>)
      lines.push(
        `| ${entry.arm} | ${String(row["depth"])} | ${String(row["view"])} | ${String(row["hunks"])} | ${pad(metricOf(row, "necessary"))} | ${pad(metricOf(row, "relevant"))} | ${pad(metricOf(row, "necessaryAny"))} | ${pad(metricOf(row, "relevantAny"))} |`,
      );
  }
  if (m.leadDifferences !== null)
    lines.push(
      "",
      `Lead differences over all hunks: top 3 differ on ${m.leadDifferences.top3Differ} of ${m.leadDifferences.hunks}, top 10 on ${m.leadDifferences.top10Differ}.`,
    );
  lines.push(
    "",
    "### Investigate's ledger and the context margin, at depth",
    "",
    "Family-weighted mean (B4's nesting).",
    "",
    "| phase | source | view | hunks | necessary | relevant | necessary, any line | relevant, any line |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...(m.ledger.summary as ReadonlyArray<Row>).map(
      (row) =>
        `| ${String(row["phase"])} | ${String(row["source"])} | ${String(row["view"])} | ${String(row["hunks"])} | ${pad(metricOf(row, "necessary"))} | ${pad(metricOf(row, "relevant"))} | ${pad(metricOf(row, "necessaryAny"))} | ${pad(metricOf(row, "relevantAny"))} |`,
    ),
    "",
    "Judged-only precision (9.49):",
    "",
    "| phase | view | precision | unjudged share |",
    "| --- | --- | --- | --- |",
    ...m.ledger.precision.map(
      (row) =>
        `| ${row.phase} | ${row.view} | ${pad(row.precision)} | ${pad(row.unjudgedShare)} |`,
    ),
    "",
    "### Against the noise floor (FT5)",
    "",
    'δ = A − X per hunk; separable only when the 95% interval excludes zero and mean |δ| exceeds the upper 95% bound of A against A′\'s mean |δ|. "Rests on" names families whose removal loses separability or flips the sign.',
    "",
    "| comparison | source | view | measure | hunks | δ [95%] | mean abs δ | floor | separable | rests on |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...m.separability.map(
      (row) =>
        `| ${row.comparison} | ${row.source} | ${row.view} | ${row.metric} | ${row.hunks} | ${pad(row.delta.familyWeighted.delta)} [${pad(row.delta.familyWeighted.ci95[0])}, ${pad(row.delta.familyWeighted.ci95[1])}] | ${pad(row.delta.familyWeighted.absDelta)} | ${pad(row.familyWeighted.floor)} | ${row.familyWeighted.separable ? "yes" : "no"} | ${row.restsOn.join(", ") || "none"} |`,
    ),
    "",
    "### Lanes and verdicts: agreement between runs (hunk level)",
    "",
    "| comparison | measure | hunks | agreement [95%] | kappa [95%] | unpaired |",
    "| --- | --- | --- | --- | --- | --- |",
    ...m.agreement.flatMap((row) =>
      (["lane", "complexity", "ease", "verdict"] as const).map((key) => {
        const a = row[key];
        return `| ${row.comparison} | ${key} | ${a.items} | ${pad(a.agreement)} [${pad(a.agreementCi95[0])}, ${pad(a.agreementCi95[1])}] | ${pad(a.kappa)} [${pad(a.kappaCi95[0])}, ${pad(a.kappaCi95[1])}] | ${a.unpaired} |`;
      }),
    ),
    "",
    "Unit-level check (units matched by owned changed lines, Jaccard at least 0.5):",
    "",
    ...m.unitMatching.map(
      (row) =>
        `- ${row.comparison}: ${row.matched} matched of ${row.unitsA} and ${row.unitsOther}; lane agreement ${pad(row.laneAgreement)}, verdict agreement ${pad(row.verdictAgreement)}.`,
    ),
    "",
    "### Rule checks",
    "",
    m.ruleViolations.length === 0
      ? "No violation."
      : `${m.ruleViolations.length} violation(s):`,
    ...m.ruleViolations.map(
      (v) =>
        `- ${v.phase} ${v.caseId}, rule ${v.rule}, ${v.unitId}: ${v.detail}`,
    ),
    "",
    "### Known cases (reported apart, never mixed with dev measures)",
    "",
    ...m.knownCases.map(
      (k) =>
        `- ${k.caseId}, ${k.phase}: ${!k.ran ? "not run" : "caught" in k ? (k.caught === null ? "defect lines not confirmed" : k.caught ? "caught" : "not caught") : ""}${"inSample" in k && k.inSample === true ? " (in-sample, a regression check)" : ""}${"referencesCoverDefect" in k && k.referencesCoverDefect === false ? "; no reference covered the defect's lines" : ""}`,
    ),
    `- Planted cases: ${m.plantedCases.measured ? m.plantedCases.cases.join(", ") : m.plantedCases.note}.`,
    "",
    "### Proof (FT9)",
    "",
    ...(m.proofRanges.measured
      ? m.proofRanges.ranges.map((r) =>
          "proof" in r
            ? `- ${r.caseId}: requirements ${JSON.stringify(r.proof.requirements)}, ${r.proof.disagreements} proof disagreement(s), ${r.proof.staleProofFindings} stale-proof finding(s), static automation reached on ${r.proof.staticReached} unit(s).`
            : `- ${r.caseId}: ${r.note}.`,
        )
      : [`- Proof ranges: ${m.proofRanges.note}.`]),
    "",
    "### Understand's own variation (U′)",
    "",
    `Over ${m.understand.summary.ranges} range(s): adjusted Rand index ${pad(m.understand.summary.meanCandidateBatchARI)} over candidate batches and ${pad(m.understand.summary.meanPartitionARI)} over Investigate partitions; behaviours matched ${pad(m.understand.summary.behavioursMatchedShare.a)} of A's and ${pad(m.understand.summary.behavioursMatchedShare.u)} of U′'s; obligations ${pad(m.understand.summary.obligationsMatchedShare.a)} and ${pad(m.understand.summary.obligationsMatchedShare.u)}.`,
    "",
    "### Receipts and tokens",
    "",
    "Each run's latest attempt; the last two columns count every attempt, aborted and superseded ones too.",
    "",
    "| phase | runs | stored | input tokens | output tokens | cache-read share | generations | timed out in generation 0 | all attempts | input tokens, all attempts |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...Object.entries(m.receipts.byPhase).map(([phase, e]) => {
      const r = e as {
        runs: number;
        stored: number;
        input: number;
        output: number;
        cacheReadShare: number | null;
        generations: number;
        gen0TimedOut: ReadonlyArray<string>;
        allAttempts: { runs: number; input: number };
      };
      return `| ${phase} | ${r.runs} | ${r.stored} | ${r.input.toLocaleString("en")} | ${r.output.toLocaleString("en")} | ${pad(r.cacheReadShare)} | ${r.generations} | ${r.gen0TimedOut.join(", ") || "none"} | ${r.allAttempts.runs} | ${r.allAttempts.input.toLocaleString("en")} |`;
    }),
    "",
    `B's pre-registered rule (FT4): served top 3 differ on ${m.bContinuation.servedTop3.differ} of ${m.bContinuation.servedTop3.hunks} harness hunks; ledger separates on both measures: ${m.bContinuation.ledgerCondition ? "yes" : "no"}; B ${m.bContinuation.go ? "goes on" : "stays at Investigate"}.`,
    "",
  );
  const lost = (
    m.receipts.byPhase as Record<
      string,
      { lostAfterInvestigate?: { input: number; output: number } }
    >
  )["B"]?.lostAfterInvestigate;
  lines.push(
    "### Misleading share by item (9.42's guard)",
    "",
    "Among judged retrieval targets an arm kept as context (the ledger) or published (references), the share the gold grades misleading, and irrelevant; family-weighted mean [plain mean].",
    "",
    "| phase | source | view | hunks with judged items | misleading | irrelevant |",
    "| --- | --- | --- | --- | --- | --- |",
    ...m.misleadingShare.summary.map(
      (row) =>
        `| ${row.phase} | ${row.source} | ${row.view} | ${row.hunksWithJudgedItems} | ${pad(row.misleadingShare.mean)} [${pad(row.misleadingShare.hunkMean)}] | ${pad(row.irrelevantShare.mean)} [${pad(row.irrelevantShare.hunkMean)}] |`,
    ),
    "",
    "### Look-alikes and misleading drops against the gold (9.9, 10.49)",
    "",
    "| phase | look-alikes (gold misleading / irrelevant / relevant / unjudged) | misleading drops (same) | kept entries the gold grades misleading | gold misleading targets |",
    "| --- | --- | --- | --- | --- |",
    ...Object.entries(m.lookAlikes).map(([phase, t]) => {
      const cell = (c: Record<string, number>) =>
        `${c["total"]} (${c["misleading"]} / ${c["irrelevant"]} / ${c["relevant"]} / ${c["unjudged"]})`;
      return `| ${phase} | ${cell(t.lookAlikes)} | ${cell(t.misleadingDrops)} | ${t.keptMisleading} | ${t.goldMisleadingTargets} |`;
    }),
    "",
    "### Later fixes in the gold (FT11)",
    "",
    m.laterFixes.measured
      ? `${m.laterFixes.confirmed} confirmed fix(es): ${
          m.laterFixes.results
            .map(
              (r) =>
                `${r.key} (${Object.entries(r.byPhase)
                  .map(
                    ([phase, raised]) =>
                      `${phase} ${raised === null ? "not run" : raised ? "raised" : "missed"}`,
                  )
                  .join(", ")})`,
            )
            .join("; ") || "none"
        }.`
      : `${m.laterFixes.note}.`,
    "",
    "### Investigate's own search (FT17)",
    "",
    `${m.searchAttribution.note}.`,
    "",
    `Assemble and Dispose work B started before it was stopped after Investigate, lost: ${lost === undefined ? "none recorded" : `${lost.input.toLocaleString("en")} input and ${lost.output.toLocaleString("en")} output tokens`}.`,
    "",
  );
  const gaps = gapsFrom(m).map((gap) => ({ ...gap, ...fixabilityOf(gap.id) }));
  lines.push(
    "## Gaps",
    "",
    "| stage | measure | size | unit | affected | noise floor | exceeds the floor |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...gaps.map(
      (gap) =>
        `| ${gap.stage} | ${gap.measure} | ${pad(gap.size)} | ${gap.unit} | ${gap.affected} | ${pad(gap.floor)} | ${gap.floor === null ? "no floor applies" : gap.separable ? "yes" : "no: not separable"} |`,
    ),
    "",
    "## Fixability and ranking",
    "",
    "Within each class, by size over the noise floor (size alone where no floor applies). The classes come from a table of known levers written before the runs; the owner can move any gap.",
    "",
  );
  for (const fixability of [
    "lever in reach",
    "lever costs a round",
    "cause unknown",
  ] as const) {
    const ranked = gaps
      .filter((gap) => gap.fixability === fixability)
      .sort((a, b) => b.size - (b.floor ?? 0) - (a.size - (a.floor ?? 0)));
    lines.push(
      `### ${fixability}`,
      "",
      ...(ranked.length === 0
        ? ["None."]
        : ranked.map(
            (gap, index) =>
              `${index + 1}. ${gap.stage}: ${gap.measure}, ${pad(gap.size)} ${gap.unit}${gap.floor === null ? "" : ` (floor ${pad(gap.floor)})`}${gap.lever === "" ? "" : `; lever: ${gap.lever}`}`,
          )),
      "",
    );
  }
  lines.push(
    "## Interpretation (the agent's reading of the measurements above, not a measurement)",
    "",
    "- Graph's structural lookups in agentic search were not measured (C7): the harness has no Graph structural tool (10.10), so 9.63's comparison is read as a comparison of starting leads only.",
    "- Graph's semantic query and E0 as search tools were measured only if FT17's later phase ran; otherwise they were not.",
    `- ${m.separability.filter((row) => row.familyWeighted.separable).length} of ${m.separability.length} comparisons are separable from the noise floor; a difference inside the floor is not evidence of an effect.`,
    "",
    "The owner chooses the hills; nothing here is decided.",
  );
  return `${lines.join("\n")}\n`;
};

export const writeHills = () => {
  if (!existsSync(MEASUREMENTS_FILE))
    throw new Error("no measurements.json: run `full-test score` first");
  const m = JSON.parse(readFileSync(MEASUREMENTS_FILE, "utf8")) as Measurements;
  ensureDir(FULL_TEST_RESULTS);
  const text = hillsMarkdown(m);
  writeFileSync(join(FULL_TEST_RESULTS, "hills.md"), text);
  return text;
};
