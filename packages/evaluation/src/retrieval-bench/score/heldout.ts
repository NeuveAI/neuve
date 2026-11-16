import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { Ranking } from "../ranking.ts";
import { evaluateHunk, type HunkMetrics } from "./metrics.ts";
import {
  round,
  runComparison,
  type Comparison,
  type ReportHunk,
} from "./report.ts";
import type { DevComparison } from "./frozen.ts";
import type { HunkGold } from "./types.ts";

/**
 * The held-out report's additions (9.58), all beside the decision and never as it:
 * - the cross-family subset: the six comparisons rescored on gold that does not rest on Opus alone
 *   (gold.ts, `keepCrossFamily`), dropped targets unjudged;
 * - the Graph failure effect: each comparison where a recorded failure left hunks out, rescored with
 *   the failed arm's hunk counted as a miss (its empty answer, 0 recall) instead of left out;
 * - dev's reading of each comparison beside held-out's.
 */

type ComparisonOptions = Parameters<typeof runComparison>[3];
type ComparisonResult = ReturnType<typeof runComparison>;

/** The comparisons rescored on other gold; the arms are read from the same rankings. */
export const rescoreOnGold = (
  comparisons: ReadonlyArray<Comparison>,
  rankings: ReadonlyMap<string, ReadonlyMap<string, Ranking>>,
  hunks: ReadonlyArray<ReportHunk>,
  golds: ReadonlyMap<string, HunkGold>,
  options: ComparisonOptions,
) => {
  const goldHunks = hunks.filter((hunk) => golds.has(hunk.hunkId));
  const metrics = new Map<string, Map<string, HunkMetrics>>();
  for (const arm of new Set(
    comparisons.flatMap((comparison) => [comparison.other, comparison.default]),
  )) {
    const map = rankings.get(arm);
    if (map === undefined) throw new Error(`${arm} has no rankings`);
    const perHunk = new Map<string, HunkMetrics>();
    for (const hunk of goldHunks) {
      const ranking = map.get(hunk.hunkId);
      if (ranking !== undefined)
        perHunk.set(
          hunk.hunkId,
          evaluateHunk(golds.get(hunk.hunkId) as HunkGold, ranking, hunk, arm),
        );
    }
    metrics.set(arm, perHunk);
  }
  return comparisons.map((comparison) =>
    runComparison(comparison, metrics, goldHunks, options),
  );
};

/**
 * The Graph failure effect: each comparison whose decision left hunks out for a recorded failure,
 * rescored with those hunks in, the failed arm's answer read as the empty ranking it is (a miss).
 * A failed arm's hunk is read as deep for the mixed-depth rule, since an empty answer misses at any
 * depth; every other rule is the decision's.
 */
export const failuresAsMisses = (
  comparisons: ReadonlyArray<Comparison>,
  decisions: ReadonlyArray<ComparisonResult>,
  metrics: ReadonlyMap<string, ReadonlyMap<string, HunkMetrics>>,
  hunks: ReadonlyArray<ReportHunk>,
  options: ComparisonOptions,
) =>
  comparisons.flatMap((comparison, index) => {
    const decision = decisions[index] as ComparisonResult;
    if (decision.noAnswer.length === 0) return [];
    const failed = (arm: string, hunkId: string) =>
      options.failure(arm, hunkId) !== null;
    const result = runComparison(comparison, metrics, hunks, {
      ...options,
      failure: () => null,
      poolOnly: (arm, hunkId) =>
        !failed(arm, hunkId) && options.poolOnly(arm, hunkId),
    });
    return [
      {
        ...result,
        /** Each hunk the decision left out, with each failed arm's scored recall at the decision share. */
        countedAsMisses: decision.noAnswer.map((entry) => ({
          hunkId: entry.hunkId,
          failed: entry.failed.map((failure) => ({
            arm: failure.arm,
            scored: metrics.get(failure.arm)?.has(entry.hunkId) ?? false,
            necessary: round(
              metrics.get(failure.arm)?.get(entry.hunkId)?.budgets[
                `real-${options.share}`
              ]?.necessary.fractional,
            ),
          })),
        })),
      },
    ];
  });

/** Dev's reading of a comparison, as set beside held-out's. */
export const devBeside = (dev: ReadonlyArray<DevComparison>, name: string) => {
  const entry = dev.find((comparison) => comparison.name === name);
  if (entry === undefined)
    throw new Error(`the dev report has no comparison named ${name}`);
  return {
    other: entry.other,
    default: entry.default,
    excludedHunks: entry.excludedHunks,
    noAnswer: entry.noAnswer.length,
    hunksRemaining: entry.hunksRemaining,
    mixedDepth: entry.mixedDepth.length,
    pairedHunks: entry.pairedHunks,
    families: entry.families,
    delta: entry.delta,
    interval: entry.interval,
    relevant: {
      pairedHunks: entry.relevant.pairedHunks,
      delta: entry.relevant.delta,
      interval: entry.relevant.interval,
    },
    guard: entry.guard,
    decision: entry.decision,
  };
};

/** SHA-256 of a file's bytes. */
export const hashFile = async (path: string) =>
  createHash("sha256")
    .update(new Uint8Array(await Bun.file(path).arrayBuffer()))
    .digest("hex");

/**
 * One SHA-256 over a directory's files (or one file): each file's relative path and digest, in sorted
 * order. Identifies the frozen inputs a held-out run read (proposal: the configuration hash goes into
 * the results).
 */
export const hashFiles = async (path: string) => {
  const files: Array<string> = [];
  const walk = (current: string) => {
    if (statSync(current).isDirectory())
      for (const name of readdirSync(current).sort()) walk(join(current, name));
    else files.push(current);
  };
  walk(path);
  const digest = createHash("sha256");
  for (const file of files)
    digest.update(`${relative(path, file)}\u0000${await hashFile(file)}\n`);
  return { files: files.length, sha256: digest.digest("hex") };
};
