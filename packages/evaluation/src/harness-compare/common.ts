import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DENSE_IDS } from "../retrieval-bench/models.ts";
import { describeArms } from "../retrieval-bench/run-pools.ts";
import type { ArmDescription } from "../retrieval-bench/retriever.ts";
import { exclusionsFor } from "../retrieval-bench/score/leakage.ts";
import {
  benchmark,
  root,
  type ArmsFile,
  type DevHunk,
} from "../retrieval-bench/scoring-inputs.ts";

/**
 * The 9.57 end-to-end comparison through the M3 harness (10.78, 10.81): shared names, paths and the
 * comparison's 9.47 exclusions. The two candidates are M4's frozen reranked arms; the harness sees
 * them only as the leads its retriever port supplies.
 */

export const CANDIDATES = ["R(H3-E1)", "R(H3-E3)"] as const;
export type Candidate = (typeof CANDIDATES)[number];
/** 9.21's simpler arm, as comparison 6 reads it: the delta is E3 minus E1. */
export const DEFAULT_CANDIDATE: Candidate = "R(H3-E1)";
/** A file-system-safe label for each candidate. */
export const SLUG: Record<Candidate, string> = {
  "R(H3-E1)": "e1",
  "R(H3-E3)": "e3",
};

export const RESULTS = join(benchmark, "results/harness-compare");
export const SELECTION_FILE = join(RESULTS, "selection.json");
/** The 10.84 re-run's outputs, beside the committed comparison's and never over them. */
export const STICKY_RESULTS = join(RESULTS, "sticky-leads");
export const runDir = (caseId: string, results: string = RESULTS) =>
  join(results, "runs", caseId.replace(/[^A-Za-z0-9._-]/g, "_"));

export { benchmark, root };

export const ensureDir = (path: string) => mkdirSync(path, { recursive: true });

export const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

/** The arm definitions the B4 scorer reads 9.47's components from (score/cli.ts). */
export const armDefinitions = (armsFile: ArmsFile) =>
  new Map<string, ArmDescription>(
    [
      ...describeArms([...DENSE_IDS]),
      ...[
        ...(armsFile.rerank === undefined
          ? []
          : ([["R", armsFile.rerank]] as const)),
        ...Object.entries(armsFile.reranks ?? {}),
      ].map(([arm, entry]) => ({
        arm,
        family: "rerank" as const,
        label: entry.label ?? arm,
        config: entry.config as never,
      })),
    ].map((entry) => [entry.arm, entry]),
  );

/** 9.47 for the two candidates: both contain the Graph fork, R(H3-E1) also the tuned adapter. */
export const comparisonExclusions = (armsFile: ArmsFile) =>
  exclusionsFor([...CANDIDATES], armDefinitions(armsFile), new Map());

export const excludedHunk = (
  exclusions: ReturnType<typeof comparisonExclusions>,
  hunk: DevHunk,
) => exclusions.filter((exclusion) => exclusion.applies(hunk));
