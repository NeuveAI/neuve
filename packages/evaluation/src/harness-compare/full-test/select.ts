import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { loadScoringInputs } from "../../retrieval-bench/scoring-inputs.ts";
import { exclusionsFor } from "../../retrieval-bench/score/leakage.ts";
import { armDefinitions, ensureDir, sha256 } from "../common.ts";
import {
  FULL_TEST_RESULTS,
  FULL_TEST_SEED,
  FULL_TEST_SELECTION,
  LEADS_ARMS,
  NAMED_TWELVE_SELECTION,
  PILOT_RANGES,
  REVIEW_LINES_LIMIT,
} from "./config.ts";

/**
 * FT2's pre-registered range rule, written once to `full-test/selection.json` before any run:
 * every dev range except those over 50,000 review lines by M4's count (only `neuve/stress`), in
 * the order of SHA-256 of `<seed>:<caseId>`; the first 3 are the pilot (FT14 rule 1); the excluded
 * range is the scale probe, run once in phase A and reported apart. The 12 ranges of the 9.57 and
 * 10.84 runs are marked so every measure can also be read on them alone. The scored hunks are M4's
 * dev hunks left after 9.47's exclusions for both arms (the Graph fork's, since both contain Graph's
 * fusion; with E0 in both the tuned-adapter exclusion lifts).
 */

export const buildFullTestSelection = async () => {
  const inputs = await loadScoringInputs();
  const exclusions = exclusionsFor(
    [...LEADS_ARMS],
    armDefinitions(inputs.armsFile),
    new Map(),
  );
  const named = existsSync(NAMED_TWELVE_SELECTION)
    ? new Set(
        (
          JSON.parse(readFileSync(NAMED_TWELVE_SELECTION, "utf8")) as {
            selected: ReadonlyArray<{ caseId: string }>;
          }
        ).selected.map((entry) => entry.caseId),
      )
    : new Set<string>();
  const frame = inputs.cases.map((entry) => {
    const hunks = inputs.hunks.filter((hunk) => hunk.caseId === entry.id);
    const excluded = hunks.flatMap((hunk) => {
      const rules = exclusions.filter((exclusion) => exclusion.applies(hunk));
      return rules.length === 0
        ? []
        : [{ hunkId: hunk.hunkId, rules: rules.map((rule) => rule.rule) }];
    });
    return {
      caseId: entry.id,
      repository: entry.repository,
      family: entry.family,
      base: entry.base,
      head: entry.head,
      reviewLines: entry.reviewLines,
      m4Hunks: hunks.length,
      scoredHunks: hunks
        .map((hunk) => hunk.hunkId)
        .filter((id) => !excluded.some((entry) => entry.hunkId === id)),
      excluded,
      named: named.has(entry.id),
      overLimit: entry.reviewLines > REVIEW_LINES_LIMIT,
      hash: sha256(`${FULL_TEST_SEED}:${entry.id}`),
    };
  });
  const order = frame
    .filter((entry) => !entry.overLimit)
    .sort((a, b) => (a.hash < b.hash ? -1 : 1));
  return {
    schemaVersion: 1,
    decision:
      "10.89 (process/proposals/full-test.md FT2: 22 dev ranges, the largest excluded by name and run once as a scale probe)",
    seed: FULL_TEST_SEED,
    rule: [
      `Frame: every dev range of M4's manifest. A range with more than ${REVIEW_LINES_LIMIT.toLocaleString("en")} review lines by M4's count is excluded and run once in phase A as the scale probe.`,
      "Run order: SHA-256 of '<seed>:<caseId>'; the first 3 are the pilot.",
      "Scored hunks: M4's dev hunks left after 9.47's exclusions for R(H3-E0) and R(H1-E0).",
      "Named subset: the 12 ranges of the 9.57 comparison and the 10.84 runs.",
    ],
    exclusions: exclusions.map((exclusion) => ({
      rule: exclusion.rule,
      because: exclusion.because,
    })),
    selected: order.map((entry, index) => ({
      order: index + 1,
      pilot: index < PILOT_RANGES,
      ...entry,
      hash: entry.hash.slice(0, 16),
    })),
    probe: frame
      .filter((entry) => entry.overLimit)
      .map((entry) => ({ ...entry, hash: entry.hash.slice(0, 16) })),
  };
};

export type FullTestSelection = Awaited<
  ReturnType<typeof buildFullTestSelection>
>;
export type SelectedRange = FullTestSelection["selected"][number];

/** Writes the selection once; a later call refuses to overwrite a different one. */
export const writeFullTestSelection = async () => {
  const selection = await buildFullTestSelection();
  const text = `${JSON.stringify(selection, null, 2)}\n`;
  ensureDir(FULL_TEST_RESULTS);
  if (existsSync(FULL_TEST_SELECTION)) {
    if (readFileSync(FULL_TEST_SELECTION, "utf8") !== text)
      throw new Error(
        `${FULL_TEST_SELECTION} exists and differs from the rule's output; the selection is frozen before any run`,
      );
    return { selection, written: false };
  }
  writeFileSync(FULL_TEST_SELECTION, text);
  return { selection, written: true };
};

export const readFullTestSelection = (): FullTestSelection =>
  JSON.parse(readFileSync(FULL_TEST_SELECTION, "utf8")) as FullTestSelection;
