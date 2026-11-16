import { z } from "zod";

/**
 * The replay dataset's line evidence: the second answer key the lanes measure reads beside the
 * owner's (10.124, 10.128). This file is its one schema authority, at version 2 (10.135): the
 * labelling pipeline writes these records and exports its JSON Schema from here, and the lanes
 * reader parses them with it, refusing every other version. Which lane each evidence class means is decided (10.128) and lives
 * as one table in the lanes reader, not here.
 *
 * One record per replayed case, `labels/line-evidence.json` on the research volume. Keys are the
 * lanes measure's own: `range` is `rangeIdentity` (the first 8 hex digits of the case's base and
 * first head) and each line is `<path>:<side>:<line>`, or `<path>:<side>:whole` for a non-text
 * file, as `ownedLineKeys` writes them.
 *
 * A line with no evidence is absent: silence is not a label (10.128). Each thread's class on its
 * line is the majority of the labelling passes' own classes (10.135): two passes, and a third where
 * they differ; so a line never takes a class no pass gave. A line where a thread has no majority is
 * held back, absent and only counted in `disputed`, unless it already needs a person, which no
 * thread can raise further.
 */

export const REPLAY_EVIDENCE_VERSION = 2;

/**
 * How a line's `concerns` cites a commit that changed it after the change landed: this prefix, then
 * the commit. The labelling writes it and the lanes reader parses it, both from here.
 */
export const AFTER_MERGE_PREFIX = "after-merge:";

export const EvidenceClass = z.enum([
  /** A person's substantive concern led to a change or a recorded design decision, or the line was reverted or fixed within 90 days of merge. */
  "needs-person",
  /** Substantive discussion by a person, and nothing changed. */
  "discussed",
  /** Its only concerns were bot findings a maintainer confirmed, or nits. */
  "agent-catchable",
  /** Generated, dependency or formatting-only change. */
  "mechanical",
]);
export type EvidenceClass = z.infer<typeof EvidenceClass>;

export const LineEvidence = z.strictObject({
  class: EvidenceClass,
  /** Strong: a fix, revert or decision links to it; weak: inferred from region or timing alone. */
  strength: z.enum(["strong", "weak"]),
  /** Concern ids in the case's `labels/concerns.jsonl` (evaluator-only). */
  concerns: z.array(z.string().min(1)),
});
export type LineEvidence = z.infer<typeof LineEvidence>;

/**
 * A label the label audit (10.136) found wrong, every auditor agreeing, corrected without labelling
 * the case again: the citation (a thread, an after-merge commit or a mechanical path) no longer gives
 * its lines a class, and each line takes what its other evidence gives, if any. The audit's accuracy
 * stays as it measured, before the correction.
 */
export const AuditOverride = z.strictObject({
  /** The audit that found it, as `audits/<name>` names it. */
  audit: z.string().min(1),
  origin: z.enum(["review", "after-merge", "path"]),
  cite: z.string().min(1),
  /** The lines the label covered. */
  lines: z.array(z.string().min(1)).min(1),
  was: EvidenceClass,
  /** What the auditors said it should be: today only none (no class from this citation). */
  now: z.literal("none"),
  /** Each auditor's verdict on it, all "wrong". */
  verdicts: z.array(z.literal("wrong")).min(3),
  reasons: z.array(z.string()),
});
export type AuditOverride = z.infer<typeof AuditOverride>;

export const ReplayLineEvidence = z.strictObject({
  version: z.literal(REPLAY_EVIDENCE_VERSION),
  caseId: z.string().min(1),
  source: z.enum([
    "devtools-frontend",
    "go",
    "react-compiler",
    "react-core",
    "entire-cli",
    "t3code",
  ]),
  era: z.enum(["pre-2022", "2024-2025", "2026"]),
  split: z.enum(["pilot", "development", "held-out"]),
  /** Stacks and relands share a family; agreement is grouped by it. */
  family: z.string().min(1),
  control: z.enum(["quiet", "abandoned", "reverted", "mechanical"]).nullable(),
  range: z.string().regex(/^[0-9a-f]{8}\.\.[0-9a-f]{8}$/),
  /** The replay run whose packet was labelled. */
  runId: z.string().min(1),
  labelling: z.strictObject({
    /** 3 when a third pass broke ties in this case, else 2. */
    passes: z.union([z.literal(2), z.literal(3)]),
    /** How the passes' classes combine: the majority (10.135). */
    rule: z.literal("majority"),
    /**
     * Agreement between the first two passes over the case's lines, a minor quality signal; null
     * when it cannot be computed.
     */
    kappa: z.number().min(-1).max(1).nullable(),
  }),
  lines: z.record(z.string().regex(/^.+:(new|old):(\d+|whole)$/), LineEvidence),
  /** Lines held back because a thread on them has no majority class. */
  disputed: z.int().min(0),
  /** Labels the audit found wrong, corrected (absent when none). */
  auditOverrides: z.array(AuditOverride).optional(),
});
export type ReplayLineEvidence = z.infer<typeof ReplayLineEvidence>;
