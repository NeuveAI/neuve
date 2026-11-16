import { join } from "node:path";
import { benchmark, root } from "../common.ts";

/**
 * The end-to-end harness check of 10.89, as process/proposals/full-test.md designs it, with the one
 * change 10.89 records: there is no token cap. Runs stop only on the plan's usage-limit error
 * (`QuotaExhaustedError`, runner.ts `usageLimitLine`) and on the proposal's other stop rules
 * (FT14: phase order, timeouts, systematic failure); every run's tokens are still recorded.
 *
 * Words (the proposal's, internal process words): an *arm* is one retrieval configuration's leads
 * fed to the harness; a *phase* is one arm's runs over every range; a *generation* is one run of a
 * request (a re-request after a timeout is the next generation, 10.42).
 */

export const FULL_TEST_RESULTS = join(benchmark, "results/full-test");
/** The labelling side's all-hunks leads files and their receipt (FT6, FT15). */
export const LEADS_DIR = join(FULL_TEST_RESULTS, "leads");
export const leadsFile = (arm: LeadsArm) => join(LEADS_DIR, `${arm}.jsonl.gz`);
/** The extra ranges' rows (the probe, the known cases and the proof ranges), in their own file. */
export const extraLeadsFile = (arm: LeadsArm) =>
  join(LEADS_DIR, "extra", `${arm}.jsonl.gz`);
export const LEADS_RECEIPT = join(LEADS_DIR, "leads.json");
export const FULL_TEST_SELECTION = join(FULL_TEST_RESULTS, "selection.json");
/** The named subset every measure is also reported on: the 9.57 and 10.84 runs' 12 ranges. */
export const NAMED_TWELVE_SELECTION = join(
  benchmark,
  "results/harness-compare/selection.json",
);
export { root };

/** M4's two frozen arms (9.61, 9.63). */
export const LEADS_ARMS = ["R(H3-E0)", "R(H1-E0)"] as const;
export type LeadsArm = (typeof LEADS_ARMS)[number];

/** Where a phase's leads come from: an arm's all-hunks leads file, or the harness's own BM25. */
export type LeadsSource =
  | { readonly kind: "frozen"; readonly arm: LeadsArm }
  | { readonly kind: "harness-bm25" };

export const PHASE_IDS = ["A", "C", "A2", "U2", "B"] as const;
/** A, C, A′, U′ and B; A′ and U′ are spelled A2 and U2 in files. */
export type PhaseId = (typeof PHASE_IDS)[number];

export interface Phase {
  readonly id: PhaseId;
  /** As the proposal writes it. */
  readonly label: string;
  readonly leads: LeadsSource;
  /**
   * What is copied into this phase's store before its run: Understand, its merge pass and the
   * cycle's scope snapshot from phase A's store ("understand"), or the scope snapshot alone, so
   * Understand is recomputed ("scope-only"). Phase A computes its own.
   */
  readonly copy: "none" | "understand" | "scope-only";
  /** Where the run stops: the whole pipeline, after Investigate (B), or after Understand (U′). */
  readonly stop: "full" | "after-investigate" | "after-understand";
  /** `neuve review` arguments of the phase's own (development settings need NEUVE_DEV_STUBS=1). */
  readonly requestArgs: ReadonlyArray<string>;
}

/**
 * FT14 rule 3: phases run in the order A, C, A′, U′, B, each across every range before the next,
 * so any stop leaves whole phases.
 *
 * B carries no stub hold: a stub setting is part of every stage's computation key (pipeline.ts
 * `agentStage`), so a held B would share neither A's Understand nor, on continuation, its own
 * Investigate. B therefore runs as A does and the watcher stops the worker once every Investigate
 * partition is done (runner.ts); Assemble work a batch started before that is lost and counted in
 * its tokens. U′'s hold on Investigate is wanted: its Understand is recomputed anyway.
 */
export const PHASES: ReadonlyArray<Phase> = [
  {
    id: "A",
    label: "A",
    leads: { kind: "frozen", arm: "R(H3-E0)" },
    copy: "none",
    stop: "full",
    requestArgs: [],
  },
  {
    id: "C",
    label: "C",
    leads: { kind: "harness-bm25" },
    copy: "understand",
    stop: "full",
    requestArgs: [],
  },
  {
    id: "A2",
    label: "A′",
    leads: { kind: "frozen", arm: "R(H3-E0)" },
    copy: "understand",
    stop: "full",
    requestArgs: [],
  },
  {
    id: "U2",
    label: "U′",
    leads: { kind: "harness-bm25" },
    copy: "scope-only",
    stop: "after-understand",
    requestArgs: ["--stub-hold", "investigate=3600"],
  },
  {
    id: "B",
    label: "B",
    leads: { kind: "frozen", arm: "R(H1-E0)" },
    copy: "understand",
    stop: "after-investigate",
    requestArgs: [],
  },
];

export const phaseOf = (id: string): Phase => {
  const phase = PHASES.find((entry) => entry.id === id);
  if (phase === undefined)
    throw new Error(
      `unknown phase ${id}; known: ${PHASES.map((entry) => entry.id).join(", ")}`,
    );
  return phase;
};

/** FT2: every dev range with more review lines than this by M4's count is excluded, pre-registered. */
export const REVIEW_LINES_LIMIT = 50_000;
/** The seed of the full test's run order (the pilot is its first 3). */
export const FULL_TEST_SEED = "neuve-10.89-full-test-2026-10-21";
export const PILOT_RANGES = 3;

/** FT8: generation 0, then at most two re-requests after a timeout. */
export const MAX_REREQUESTS = 2;
/** FT14 rule 6: the same failure on this many runs in a row stops the invocation. */
export const SYSTEMATIC_FAILURES = 3;
/** 10.79: a cycle's scope copy is reused within 7 days; a range's phases finish inside it. */
export const CYCLE_WINDOW_MS = 7 * 24 * 60 * 60_000;

/**
 * The known cases (FT11), in `known-cases.json` beside the results (known-cases.ts): the real one,
 * 9.59's empty-file omission on 0c874b72, in-sample for 10.86 (a regression check, not an
 * independent test), and the planted ones, built by planted.ts from a spec a separate session
 * authors in its own folder (2.16). The real case's range is fixed; its defect lines are confirmed
 * by the coordinator before the pilot.
 */
export const REAL_KNOWN_CASE = {
  id: "neuve:0c874b72~1..0c874b72",
  repository: "neuve",
  base: "0c874b72~1",
  head: "0c874b7256c0ad73aa34c10396f22ef7410ac35f",
} as const;
export const KNOWN_CASES_FILE = join(FULL_TEST_RESULTS, "known-cases.json");
/** Proof ranges (FT9): recent ranges of this repository with proof records, named before the pilot. */
export const PROOF_RANGES_FILE = join(FULL_TEST_RESULTS, "proof-ranges.json");

/** Known cases run in A and A′ only, so each has a repeat (FT11); proof ranges run in A only (FT9). */
export const KNOWN_CASE_PHASES: ReadonlyArray<PhaseId> = ["A", "A2"];
export const PROOF_RANGE_PHASES: ReadonlyArray<PhaseId> = ["A"];
