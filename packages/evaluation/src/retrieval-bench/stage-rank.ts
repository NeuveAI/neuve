import { join, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { parseArgs } from "node:util";
import { Effect } from "effect";
import { byCodepoint } from "./policy.ts";
import { loadScoringInputs } from "./scoring-inputs.ts";
import { loadDeepRankings } from "./deep-rankings.ts";
import { graphChunkVariant } from "./graph-chunk.ts";
import {
  benchmarkRoot,
  refuseCommittedOutput,
  checkBenchmarkWrites,
} from "./stage-paths.ts";
import { benchStoreLayer } from "./views.ts";
import { SPLITS } from "./split.ts";
import { loadGold } from "./score/gold.ts";
import { evaluateHunk, familyMean } from "./score/metrics.ts";
import {
  familyBootstrap,
  familyStatistic,
  type PairedUnit,
} from "./score/stats.ts";
import { coveredLines, topK, type Served } from "./score/coverage.ts";
import { budgetLabel, type GoldSpan } from "./score/types.ts";

/** Pool ceilings count each gold line once, including overlapping gold targets. */
export const distinctLineCoverage = (
  targets: ReadonlyArray<Pick<GoldSpan, "path" | "startLine" | "endLine">>,
  served: readonly Served[],
): number | null => {
  const merged: Array<{ path: string; startLine: number; endLine: number }> =
    [];
  for (const span of [...targets].sort(
    (a, b) => byCodepoint(a.path, b.path) || a.startLine - b.startLine,
  )) {
    const last = merged.at(-1);
    if (last && last.path === span.path && span.startLine <= last.endLine + 1)
      last.endLine = Math.max(last.endLine, span.endLine);
    else merged.push({ ...span });
  }
  const lines = merged.reduce(
    (sum, span) => sum + span.endLine - span.startLine + 1,
    0,
  );
  return lines === 0
    ? null
    : merged.reduce((sum, span) => sum + coveredLines(span, served), 0) / lines;
};

// Fixed variants have no fitted parameter: their out-of-family mean equals their family mean.
// Selection across variants is tested separately by selecting on the remaining families.
export const leaveOneFamilyOut = (
  variants: ReadonlyMap<string, readonly PairedUnit[]>,
) => {
  const families = [
    ...new Set([...variants.values()].flat().map((row) => row.family)),
  ].sort();
  const fixed = Object.fromEntries(
    [...variants].map(([name, rows]) => [
      name,
      {
        gain: familyStatistic(rows),
        folds: families.map((family) => ({
          family,
          trainingGain: familyStatistic(
            rows.filter((row) => row.family !== family),
          ),
          heldOutGain: familyStatistic(
            rows.filter((row) => row.family === family),
          ),
        })),
      },
    ]),
  );
  const selected = families.map((family) => {
    const candidates = [...variants]
      .map(([name, rows]) => ({
        name,
        gain: familyStatistic(rows.filter((row) => row.family !== family)),
      }))
      .filter((row): row is { name: string; gain: number } => row.gain !== null)
      .sort((a, b) => b.gain - a.gain || byCodepoint(a.name, b.name));
    const winner = candidates[0];
    const rows = winner
      ? (variants.get(winner.name)?.filter((row) => row.family === family) ??
        [])
      : [];
    return {
      family,
      variant: winner?.name ?? null,
      trainingGain: winner?.gain ?? null,
      heldOutGain: familyStatistic(rows),
    };
  });
  const values = selected.flatMap((fold) =>
    fold.heldOutGain === null ? [] : [fold.heldOutGain],
  );
  return {
    fixed,
    selected,
    gain: values.length
      ? values.reduce((a, b) => a + b, 0) / values.length
      : null,
  };
};

export const variantName = (path: string, arm: string) =>
  `${resolve(path)}/${arm}`;

const run = async () => {
  const { values } = parseArgs({
    options: {
      variant: { type: "string", multiple: true },
      baseline: { type: "string" },
      store: { type: "string" },
      work: { type: "string" },
      executable: { type: "string" },
      out: { type: "string" },
      arms: { type: "string" },
      "baseline-arm": { type: "string" },
    },
  });
  const out = resolve(values.out ?? "");
  if (!values.out) throw new Error("--out required");
  refuseCommittedOutput(out);
  const store = resolve(values.store ?? "");
  if (!values.store) throw new Error("--store required");
  const work = resolve(values.work ?? "");
  if (!values.work) throw new Error("--work required");
  checkBenchmarkWrites([store, work]);
  const load = async (path: string) => {
    const variant = await graphChunkVariant(
      values.executable ??
        process.env.NEUVE_GRAPH_OUTLINE_EXECUTABLE ??
        "entire-graph",
      work,
    );
    const inputs = await loadScoringInputs(SPLITS.dev, {
      output: path,
      variant,
    });
    const loaded = await Effect.runPromise(
      loadDeepRankings(inputs.deepInputs(console.error)).pipe(
        Effect.provide(benchStoreLayer(store)),
      ),
    );
    return { inputs, loaded };
  };
  const baseline = await load(
    values.baseline ??
      (() => {
        throw new Error("--baseline must name Graph output");
      })(),
  );
  const baseArm = values["baseline-arm"] ?? "R(H3-E0)";
  if (!baseline.inputs.pools.has(baseArm))
    throw new Error(`Baseline missing ${baseArm}`);
  const gold = await loadGold(
    join(benchmarkRoot, "labelling", "dev"),
    (id) => baseline.inputs.caseOfHunk.get(id)?.id,
  );
  const budgets = ["opus", 64_000, 256_000] as const;
  const baselinePool50 = new Map<
    string,
    { necessary: number | null; relevant: number | null }
  >();
  const baselineMetrics = new Map(
    baseline.inputs.hunks.map((h) => {
      const labels = gold.get(h.hunkId),
        ranking = baseline.loaded.rankings.get(baseArm)?.get(h.hunkId);
      if (!labels || !ranking) throw new Error(`Baseline missing ${h.hunkId}`);
      const served = topK(ranking, 50);
      baselinePool50.set(h.hunkId, {
        necessary: distinctLineCoverage(labels.necessary, served),
        relevant: distinctLineCoverage(
          [...labels.necessary, ...labels.useful],
          served,
        ),
      });
      return [h.hunkId, evaluateHunk(labels, ranking, h, baseArm, budgets)];
    }),
  );
  const rows = [];
  const pool50Variants = new Map<string, PairedUnit[]>();
  const completeByBudget = new Map<string, Set<string>>(
    budgets.map((b) => [budgetLabel(b), new Set()]),
  );
  const byBudget = new Map<string, Map<string, PairedUnit[]>>(
    budgets.map((b) => [budgetLabel(b), new Map()]),
  );
  for (const path of values.variant ?? []) {
    const current = await load(resolve(path));
    const arms = values.arms
      ? values.arms.split(",")
      : current.inputs.baseArms.filter(
          (arm) =>
            ["L", "G-fork", "H3-E0", "R(H3-E0)"].includes(arm) ||
            arm.includes("-depth"),
        );
    for (const arm of arms) {
      const name = variantName(path, arm);
      const perHunk = current.inputs.hunks.map((h) => {
        const labels = gold.get(h.hunkId),
          ranking = current.loaded.rankings.get(arm)?.get(h.hunkId),
          before = baselineMetrics.get(h.hunkId);
        if (!labels || !ranking || !before)
          throw new Error(`${name}: missing ${h.hunkId}`);
        const metrics = evaluateHunk(labels, ranking, h, undefined, budgets);
        return {
          hunkId: h.hunkId,
          family: h.family,
          caseId: h.caseId,
          before,
          beforeDepth50: baselinePool50.get(h.hunkId),
          after: metrics,
          depth50: {
            necessary: distinctLineCoverage(
              labels.necessary,
              topK(ranking, 50),
            ),
            relevant: distinctLineCoverage(
              [...labels.necessary, ...labels.useful],
              topK(ranking, 50),
            ),
          },
        };
      });
      const cells = Object.fromEntries(
        budgets.map((b) => {
          const label = budgetLabel(b);
          const deltas = perHunk.flatMap((row) => {
            const a = row.after.budgets[label]?.necessary.fractional,
              b = row.before.budgets[label]?.necessary.fractional;
            return a == null || b == null
              ? []
              : [{ family: row.family, caseId: row.caseId, delta: a - b }];
          });
          byBudget.get(label)?.set(name, deltas);
          const complete = perHunk.every((row) => {
            const before = row.before.budgets[label],
              after = row.after.budgets[label];
            return (
              (!baseline.loaded.poolOnlyHunks.get(baseArm)?.has(row.hunkId) ||
                (before !== undefined &&
                  row.before.rankedTokens >= before.allowance)) &&
              (!current.loaded.poolOnlyHunks.get(arm)?.has(row.hunkId) ||
                (after !== undefined &&
                  row.after.rankedTokens >= after.allowance))
            );
          });
          if (complete) completeByBudget.get(label)?.add(name);
          return [
            label,
            {
              complete,
              inSampleGain: complete ? familyStatistic(deltas) : null,
              unjudgedShare: familyMean(
                perHunk.map((row) => {
                  const judged =
                    row.after.budgets[label]?.attribution.judgedTokenShare;
                  return {
                    family: row.family,
                    caseId: row.caseId,
                    value: judged == null ? null : 1 - judged,
                  };
                }),
              ).mean,
            },
          ];
        }),
      );
      const poolDeltas = perHunk.flatMap((row) => {
        const left = row.beforeDepth50?.necessary,
          right = row.depth50.necessary;
        return left == null || right == null
          ? []
          : [{ family: row.family, caseId: row.caseId, delta: right - left }];
      });
      pool50Variants.set(name, poolDeltas);
      const pool50 = {
        metric: "distinct-gold-line-coverage",
        necessary: familyMean(
          perHunk.map((row) => ({
            family: row.family,
            caseId: row.caseId,
            value: row.depth50.necessary,
          })),
        ).mean,
        relevant: familyMean(
          perHunk.map((row) => ({
            family: row.family,
            caseId: row.caseId,
            value: row.depth50.relevant,
          })),
        ).mean,
        unjudgedShare: familyMean(
          perHunk.map((row) => ({
            family: row.family,
            caseId: row.caseId,
            value:
              row.after.judgedAt[50] == null
                ? null
                : 1 - row.after.judgedAt[50],
          })),
        ).mean,
        inSampleGain: familyStatistic(poolDeltas),
        leaveOneFamilyOutGain: familyStatistic(poolDeltas),
      };
      rows.push({
        name,
        pool50,
        path,
        arm,
        cells,
        depth: current.loaded.depth[arm],
        baselineDepth: baseline.loaded.depth[baseArm],
        perHunk,
        integrity: current.loaded.poolMismatches[arm] ?? [],
      });
    }
  }
  const lofo = Object.fromEntries(
    [...byBudget].map(([budget, variants]) => [
      budget,
      leaveOneFamilyOut(
        new Map(
          [...variants].filter(([name]) =>
            completeByBudget.get(budget)?.has(name),
          ),
        ),
      ),
    ]),
  );
  const rankings = Object.fromEntries(
    [...byBudget].map(([budget, variants]) => [
      budget,
      [...variants]
        .map(([variant, rows]) => ({
          variant,
          inSampleGain: completeByBudget.get(budget)?.has(variant)
            ? familyStatistic(rows)
            : null,
          leaveOneFamilyOutGain: completeByBudget.get(budget)?.has(variant)
            ? familyStatistic(rows)
            : null,
          complete: completeByBudget.get(budget)?.has(variant) ?? false,
        }))
        .sort(
          (a, b) =>
            (b.leaveOneFamilyOutGain ?? -Infinity) -
            (a.leaveOneFamilyOutGain ?? -Infinity),
        ),
    ]),
  );
  const scoredRows = rows.map((row) => ({
    ...row,
    pool50: {
      ...row.pool50,
      pairedInterval: familyBootstrap(pool50Variants.get(row.name) ?? [], {
        comparisons: Math.max(1, rows.length),
      }),
    },
    cells: Object.fromEntries(
      Object.entries(row.cells).map(([budget, cell]) => [
        budget,
        {
          ...cell,
          pairedInterval: cell.complete
            ? familyBootstrap(byBudget.get(budget)?.get(row.name) ?? [], {
                comparisons: Math.max(1, rows.length),
              })
            : null,
        },
      ]),
    ),
  }));
  const report = {
    split: "dev",
    baseline: {
      path:
        values.baseline ??
        (() => {
          throw new Error("--baseline must name Graph output");
        })(),
      arm: baseArm,
      depth: baseline.loaded.depth[baseArm],
      pool50: Object.fromEntries(
        (["necessary", "relevant"] as const).map((metric) => [
          metric,
          familyMean(
            baseline.inputs.hunks.map((h) => ({
              ...h,
              value: baselinePool50.get(h.hunkId)?.[metric] ?? null,
            })),
          ).mean,
        ]),
      ),
    },
    note: "Fixed configurations are evaluated on each omitted family without fitting. Selection LOFO chooses the best training configuration on the other families. Pool-only depths are disclosed; comparisons at budgets beyond an available ranking are incomplete, have no LOFO rank, and cannot enter selection.",
    pool50Selection: leaveOneFamilyOut(pool50Variants),
    rows: scoredRows,
    rankings,
    lofo,
  };
  refuseCommittedOutput(out);
  mkdirSync(join(out, ".."), { recursive: true });
  await Bun.write(out, JSON.stringify(report, null, 2) + "\n");
};
if (import.meta.main) await run();
