import { existsSync, writeFileSync } from "node:fs";
import { loadScoringInputs } from "../retrieval-bench/scoring-inputs.ts";
import {
  CANDIDATES,
  SELECTION_FILE,
  comparisonExclusions,
  ensureDir,
  excludedHunk,
  RESULTS,
  sha256,
} from "./common.ts";

/**
 * Step 1 (10.81): which 12 of M4's 23 dev ranges run through the harness, chosen before any model
 * call by a seeded, deterministic rule and written to `selection.json`, so nothing is picked after
 * seeing a result.
 *
 * The rule:
 * 1. The frame is every dev range with at least one hunk left after the comparison's 9.47
 *    exclusions. A range with none can add nothing to the comparison and would only spend.
 * 2. Strata are repository × hunk count, where hunk count is the range's scorable M4 hunks after
 *    the exclusions, read as one hunk or two or more (M4 picks at most four per range).
 * 3. Allocation is proportional to stratum size: each non-empty stratum gets max(1, floor(quota)),
 *    then the remaining places go by largest remainder (ties: the larger stratum, then its name).
 * 4. Within a stratum, ranges are ordered by SHA-256 of `<seed>:<caseId>` and the first n taken.
 * 5. The run order is the chosen ranges ordered by the same hash, so the first three measured for
 *    the cost projection (step 5) are fixed by the rule too.
 */

export const SEED = "neuve-10.81-harness-compare-2026-10-19";
export const TARGET = 12;

const bucketOf = (hunks: number) => (hunks <= 1 ? "1 hunk" : "2-4 hunks");

export const buildSelection = async () => {
  const inputs = await loadScoringInputs();
  const exclusions = comparisonExclusions(inputs.armsFile);
  const frame = inputs.cases.map((entry) => {
    const hunks = inputs.hunks.filter((hunk) => hunk.caseId === entry.id);
    const excluded = hunks.flatMap((hunk) => {
      const rules = excludedHunk(exclusions, hunk);
      return rules.length === 0
        ? []
        : [{ hunkId: hunk.hunkId, rules: rules.map((rule) => rule.rule) }];
    });
    const scorable = hunks.length - excluded.length;
    return {
      caseId: entry.id,
      repository: entry.repository,
      family: entry.family,
      base: entry.base,
      head: entry.head,
      changedLines: entry.changedLines,
      reviewLines: entry.reviewLines,
      m4Hunks: hunks.length,
      excluded,
      scorable,
      eligible: scorable > 0,
      stratum: `${entry.repository} / ${bucketOf(scorable)}`,
      hash: sha256(`${SEED}:${entry.id}`),
    };
  });
  const eligible = frame.filter((entry) => entry.eligible);
  const strata = new Map<string, Array<(typeof frame)[number]>>();
  for (const entry of eligible)
    strata.set(entry.stratum, [...(strata.get(entry.stratum) ?? []), entry]);
  const names = [...strata.keys()].sort();
  const allocation = new Map(
    names.map((name) => {
      const size = strata.get(name)!.length;
      const quota = (TARGET * size) / eligible.length;
      return [
        name,
        {
          size,
          quota,
          take: Math.min(size, Math.max(1, Math.floor(quota))),
        },
      ];
    }),
  );
  let placed = [...allocation.values()].reduce((sum, a) => sum + a.take, 0);
  while (placed < TARGET) {
    const next = names
      .filter((name) => allocation.get(name)!.take < allocation.get(name)!.size)
      .sort((a, b) => {
        const x = allocation.get(a)!;
        const y = allocation.get(b)!;
        return (
          y.quota - y.take - (x.quota - x.take) ||
          y.size - x.size ||
          (a < b ? -1 : 1)
        );
      })[0];
    if (next === undefined) break;
    allocation.get(next)!.take++;
    placed++;
  }
  if (placed !== TARGET)
    throw new Error(`allocation placed ${placed} ranges, not ${TARGET}`);
  const chosen = names.flatMap((name) =>
    [...strata.get(name)!]
      .sort((a, b) => (a.hash < b.hash ? -1 : 1))
      .slice(0, allocation.get(name)!.take),
  );
  const order = [...chosen].sort((a, b) => (a.hash < b.hash ? -1 : 1));
  return {
    schemaVersion: 1,
    decision:
      "10.81 (12 of 23 dev ranges, stratified by repository and hunk count; 50 USD stop)",
    candidates: [...CANDIDATES],
    seed: SEED,
    rule: [
      "Frame: every dev range with at least one M4 hunk left after the comparison's 9.47 exclusions (both candidates contain the Graph fork; R(H3-E1) contains the tuned adapter).",
      "Strata: repository x hunk count, hunk count being the range's scorable M4 hunks after exclusions, read as 1 hunk or 2-4 hunks.",
      "Allocation: proportional to stratum size; each non-empty stratum gets max(1, floor(quota)), the remaining places go by largest remainder (ties: larger stratum, then name).",
      "Within a stratum: ranges ordered by SHA-256 of '<seed>:<caseId>', first n taken.",
      "Run order: the chosen ranges ordered by the same hash; the first three are measured for the cost projection.",
    ],
    exclusions: exclusions.map((exclusion) => ({
      rule: exclusion.rule,
      because: exclusion.because,
    })),
    frame: frame.map(({ hash, ...entry }) => ({
      ...entry,
      hash: hash.slice(0, 16),
    })),
    strata: names.map((name) => ({
      stratum: name,
      ...allocation.get(name)!,
      quota: Number(allocation.get(name)!.quota.toFixed(4)),
    })),
    selected: order.map((entry, index) => ({
      order: index + 1,
      caseId: entry.caseId,
      repository: entry.repository,
      family: entry.family,
      stratum: entry.stratum,
      base: entry.base,
      head: entry.head,
      m4Hunks: entry.m4Hunks,
      scorable: entry.scorable,
      changedLines: entry.changedLines,
      reviewLines: entry.reviewLines,
    })),
  };
};

export type Selection = Awaited<ReturnType<typeof buildSelection>>;

/** Writes the selection once; a second call refuses to overwrite a different one. */
export const writeSelection = async () => {
  const selection = await buildSelection();
  const text = `${JSON.stringify(selection, null, 2)}\n`;
  ensureDir(RESULTS);
  if (existsSync(SELECTION_FILE)) {
    const held = await Bun.file(SELECTION_FILE).text();
    if (held !== text)
      throw new Error(
        `${SELECTION_FILE} exists and differs from the rule's output; the selection is frozen before any model call`,
      );
    return { selection, written: false };
  }
  writeFileSync(SELECTION_FILE, text);
  return { selection, written: true };
};

export const readSelection = async (): Promise<Selection> =>
  JSON.parse(await Bun.file(SELECTION_FILE).text()) as Selection;
