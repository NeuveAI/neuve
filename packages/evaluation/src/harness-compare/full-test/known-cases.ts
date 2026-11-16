import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { ensureDir } from "../common.ts";
import { PLANTED_KINDS } from "./planted.ts";
import {
  KNOWN_CASES_FILE,
  PROOF_RANGES_FILE,
  REAL_KNOWN_CASE,
} from "./config.ts";

/**
 * The known cases (FT11) and the proof ranges (FT9), as files beside the results, so the runner and
 * the scorer read one list. Known cases run in A and A′, proof ranges in A only; none is in M4's
 * corpus, and their measures never mix with the dev measures.
 *
 * `source` names the repository a run clones: `neuve` (this repository, for 0c874b72 and the proof
 * ranges) or an absolute path to the scratch clone that holds the planted commits (planted.ts), which
 * lives in the run scratch folder and is never this repository.
 */

const Sided = z.strictObject({
  path: z.string().min(1),
  side: z.enum(["old", "new"]),
  startLine: z.int().min(1),
  endLine: z.int().min(1),
});

export const KnownCase = z.strictObject({
  id: z.string().min(1),
  kind: z.enum(["real", "planted"]),
  /** The planted kinds (FT11's three, and the light kinds); the real case has none. */
  planted: z.enum(PLANTED_KINDS).nullable(),
  source: z.string().min(1),
  base: z.string().min(1),
  head: z.string().min(1),
  /** The defect's lines; empty until confirmed, and the catch is then not measured. */
  defectLines: z.array(Sided),
  /** In-sample cases are regression checks, never independent tests (0c874b72 for 10.86). */
  inSample: z.boolean(),
  /** Whether the case's proof records are copied into its clones before the request. */
  copyProofs: z.boolean(),
  /**
   * Where its proof records are read from, relative to the full test's results folder: a bundle
   * (`.json`) or a store folder. Null uses the run's `--proof-source`.
   */
  proofSource: z.string().nullable().default(null),
  /**
   * What counts as caught: a request for changes resting on a defect at the defect's lines, or (for
   * a range whose recorded proof shows a requirement not met) no approval of a unit owning them.
   */
  catch: z.enum(["defect-lines", "no-approval"]).default("defect-lines"),
  note: z.string(),
});
export type KnownCase = z.output<typeof KnownCase>;

export const KnownCases = z.strictObject({
  schemaVersion: z.literal(1),
  cases: z.array(KnownCase),
});

export const ProofRange = z.strictObject({
  id: z.string().min(1),
  source: z.string().min(1),
  base: z.string().min(1),
  head: z.string().min(1),
  /** As for a known case: a bundle or store folder, relative to the results folder. */
  proofSource: z.string().nullable().default(null),
  note: z.string(),
});
export const ProofRanges = z.strictObject({
  schemaVersion: z.literal(1),
  ranges: z.array(ProofRange),
});
export type ProofRange = z.output<typeof ProofRange>;

/** The real case as it stands before its defect lines are confirmed. */
export const realCaseEntry = (): KnownCase => ({
  id: REAL_KNOWN_CASE.id,
  kind: "real",
  planted: null,
  source: REAL_KNOWN_CASE.repository,
  base: REAL_KNOWN_CASE.base,
  head: REAL_KNOWN_CASE.head,
  defectLines: [],
  inSample: true,
  copyProofs: true,
  proofSource: "known-cases/proofs-0c874b72.json",
  catch: "defect-lines",
  note: "9.59's empty-file omission, the M3 exit range; in-sample for 10.86. Defect lines to be confirmed before the pilot.",
});

export const readKnownCases = (path: string = KNOWN_CASES_FILE) =>
  existsSync(path)
    ? KnownCases.parse(JSON.parse(readFileSync(path, "utf8"))).cases
    : [realCaseEntry()];

export const readProofRanges = (path: string = PROOF_RANGES_FILE) =>
  existsSync(path)
    ? ProofRanges.parse(JSON.parse(readFileSync(path, "utf8"))).ranges
    : [];

/** Adds or replaces cases by id, keeping the rest. */
export const writeKnownCases = (
  cases: ReadonlyArray<KnownCase>,
  path: string = KNOWN_CASES_FILE,
) => {
  const held = readKnownCases(path).filter(
    (entry) => !cases.some((other) => other.id === entry.id),
  );
  ensureDir(dirname(path));
  writeFileSync(
    path,
    `${JSON.stringify({ schemaVersion: 1, cases: [...held, ...cases] }, null, 2)}\n`,
  );
};
