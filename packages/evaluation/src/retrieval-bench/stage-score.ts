import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Effect } from "effect";
import { graphChunkVariant } from "./graph-chunk.ts";
import { loadDeepRankings } from "./deep-rankings.ts";
import { loadScoringInputs } from "./scoring-inputs.ts";
import {
  benchmarkRoot,
  parseChunker,
  stagePaths,
  refuseCommittedOutput,
} from "./stage-paths.ts";
import { benchStoreLayer } from "./views.ts";
import { parseSplit } from "./split.ts";
import { loadGold } from "./score/gold.ts";
import { evaluateHunk, familyMean, type HunkMetrics } from "./score/metrics.ts";
import { ALLOWANCES, budgetLabel } from "./score/types.ts";
import { familyBootstrap, BOOTSTRAP_SEED, RESAMPLES } from "./score/stats.ts";

// This scorer compares chunk variants of the frozen stage. It does not tune models or arms.
const { values } = parseArgs({
  options: {
    "output-root": { type: "string" },
    chunker: { type: "string" },
    executable: { type: "string" },
    split: { type: "string" },
    store: { type: "string" },
    work: { type: "string" },
    arms: { type: "string" },
    comparisons: { type: "string" },
  },
});
const chunker = parseChunker(values.chunker);
const split = parseSplit(values.split);
const paths = stagePaths({
  outputRoot: values["output-root"],
  chunker,
  splitFolder: split.folder,
  work: values.work,
  store: values.store,
});
if (paths === undefined) throw new Error("stage-score requires --output-root");
const comparisons = Number(values.comparisons ?? "5");
if (!Number.isInteger(comparisons) || comparisons < 1)
  throw new Error("--comparisons must be a positive integer");
const arms = (values.arms ?? "G-fork,L,E0,H3-E0,R(H3-E0)").split(",");
const scores = join(paths.output, "scores", split.folder);
refuseCommittedOutput(scores);
mkdirSync(scores, { recursive: true });

{
  const load = async () => {
    const output = paths.output;
    const variant = await graphChunkVariant(
      values.executable ??
        process.env.NEUVE_GRAPH_OUTLINE_EXECUTABLE ??
        "entire-graph",
      paths.work,
    );
    const inputs = await loadScoringInputs(split, { output, variant });
    for (const arm of new Set([...arms, "R(H3-E0)"]))
      if (!inputs.baseArms.includes(arm))
        throw new Error(
          `${output}: missing ${arm}; finish the stage or select --arms for a local-only report`,
        );
    const loaded = await Effect.runPromise(
      loadDeepRankings(inputs.deepInputs(console.error)).pipe(
        Effect.provide(benchStoreLayer(paths.store)),
      ),
    );
    const gold = await loadGold(
      join(benchmarkRoot, "labelling", split.folder),
      (id) => inputs.caseOfHunk.get(id)?.id,
    );
    const metrics = new Map<string, Map<string, HunkMetrics>>();
    for (const arm of new Set([...arms, "R(H3-E0)"])) {
      const rows = new Map<string, HunkMetrics>();
      for (const hunk of inputs.hunks) {
        const ranking = loaded.rankings.get(arm)?.get(hunk.hunkId);
        const labels = gold.get(hunk.hunkId);
        if (!ranking || !labels)
          throw new Error(
            `graph/${arm}: missing ranking or gold for ${hunk.hunkId}`,
          );
        rows.set(
          hunk.hunkId,
          evaluateHunk(labels, ranking, hunk, undefined, [
            ...ALLOWANCES,
            "opus",
          ]),
        );
      }
      metrics.set(arm, rows);
    }
    return { inputs, loaded, metrics };
  };
  const variant = await load();
  const baseline = variant;
  const hunks = baseline.inputs.hunks;
  if (
    JSON.stringify(hunks.map((h) => h.hunkId)) !==
    JSON.stringify(variant.inputs.hunks.map((h) => h.hunkId))
  )
    throw new Error("Variant and baseline hunk sets differ");
  const compare = (
    arm: string,
    pick: (m: HunkMetrics) => number | null | undefined,
  ) => {
    const pairs = hunks
      .map((hunk) => ({
        family: hunk.family,
        caseId: hunk.caseId,
        before: baseline.metrics.get("R(H3-E0)")?.get(hunk.hunkId),
        after: variant.metrics.get(arm)?.get(hunk.hunkId),
      }))
      .map((row) => ({
        ...row,
        left: row.before === undefined ? null : (pick(row.before) ?? null),
        right: row.after === undefined ? null : (pick(row.after) ?? null),
      }));
    const mean = (side: "left" | "right") =>
      familyMean(
        pairs.map((row) => ({
          family: row.family,
          caseId: row.caseId,
          value: row[side],
        })),
      ).mean;
    return {
      baseline: mean("left"),
      variant: mean("right"),
      pairedDelta: familyBootstrap(
        pairs.flatMap((row) =>
          row.left === null || row.right === null
            ? []
            : [
                {
                  family: row.family,
                  caseId: row.caseId,
                  delta: row.right - row.left,
                },
              ],
        ),
        { comparisons },
      ),
    };
  };
  const report = {
    split: split.name,
    chunker,
    baseline: "graph/R(H3-E0)",
    arms,
    statistics: {
      comparisons,
      seed: BOOTSTRAP_SEED,
      resamples: RESAMPLES,
      note: "Committed family/case paired bootstrap and family weighting. Intervals at each allowance are descriptive; this run does not authorize held-out or a product switch.",
    },
    results: Object.fromEntries(
      arms.map((arm) => [
        arm,
        {
          curve: Object.fromEntries(
            [...ALLOWANCES, "opus" as const].map((budget) => {
              const label = budgetLabel(budget);
              return [
                label,
                {
                  necessary: compare(
                    arm,
                    (m) => m.budgets[label]?.necessary.fractional,
                  ),
                  relevant: compare(
                    arm,
                    (m) => m.budgets[label]?.relevant.fractional,
                  ),
                  unjudgedTokens: compare(arm, (m) => {
                    const judged =
                      m.budgets[label]?.attribution.judgedTokenShare;
                    return judged == null ? null : 1 - judged;
                  }),
                },
              ];
            }),
          ),
          mrr: compare(arm, (m) => m.positions?.reciprocalRank),
          ndcg10: compare(arm, (m) => m.ndcg10),
          unjudged10: compare(arm, (m) =>
            m.judgedAt[10] == null ? null : 1 - m.judgedAt[10],
          ),
          depth: {
            baseline: baseline.loaded.depth["R(H3-E0)"],
            variant: variant.loaded.depth[arm],
          },
        },
      ]),
    ),
    integrity: {
      baseline: baseline.loaded.poolMismatches,
      variant: variant.loaded.poolMismatches,
    },
    graphFailures: {
      baseline: baseline.loaded.graphFailures,
      variant: variant.loaded.graphFailures,
    },
    perHunk: Object.fromEntries(
      arms.map((arm) => [
        arm,
        hunks.map((hunk) => ({
          hunkId: hunk.hunkId,
          family: hunk.family,
          caseId: hunk.caseId,
          baseline: baseline.metrics.get("R(H3-E0)")?.get(hunk.hunkId),
          variant: variant.metrics.get(arm)?.get(hunk.hunkId),
        })),
      ]),
    ),
  };
  refuseCommittedOutput(join(scores, "stage-comparison.json"));
  await Bun.write(
    join(scores, "stage-comparison.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.error(
    `scored ${hunks.length} hunks for ${arms.join(", ")} against Graph R(H3-E0) into ${scores}`,
  );
}
