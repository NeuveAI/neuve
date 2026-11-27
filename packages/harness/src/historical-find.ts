import { canonicalJson, sha256Hex } from "@neuve/records-core";
import { VerifySubmission } from "./verify.ts";
import { z } from "zod";
import { Finding, ScopeFitSubmission } from "./find-schema.ts";

/** Stored outputs from the whole-range finders. Used when reading old receipts. */
const Lens = z.enum(["scope-fit", "correctness", "risky-edges", "tests"]);
/** A finding as Find stores it: its position, lens and primary hunk, set by code. */
export const FoundFinding = Finding.extend({
  id: z.string(),
  lens: Lens,
  hunkId: z.string(),
});
export type FoundFinding = z.infer<typeof FoundFinding>;
/**
 * A finding of the finder's final list: also the Map group that owns its primary hunk, set by code
 * at dedupe (finder-task.ts), so Find reads no Map. Map never splits a file across groups.
 */
export const StoredFinding = FoundFinding.extend({ group: z.string() });
export type StoredFinding = z.infer<typeof StoredFinding>;
/** Find's own output, before its finder assigns groups and dedupes. */
export const FindOutput = z.strictObject({
  lens: Lens,
  source: z.enum(["agent", "final-generation", "backstop"]),
  findings: z.array(FoundFinding),
  conditions: ScopeFitSubmission.shape.conditions.optional(),
  notes: z.array(z.string()),
  reading: z.strictObject({ used: z.int().min(0), limit: z.int().min(0) }),
});
export type FindOutput = z.infer<typeof FindOutput>;
/** A finder's final list (its dedupe step's output), which Verify, Link and Publish read. */
export const FindStored = FindOutput.extend({
  findings: z.array(StoredFinding),
});
export type FindStored = z.infer<typeof FindStored>;

export const Claim = FoundFinding.pick({
  lens: true,
  claim: true,
  kind: true,
  doneWhen: true,
  anchors: true,
  hunkId: true,
});
export type Claim = z.infer<typeof Claim>;

/** A finding's claim, without what Verify does not read. */
export const claimOf = (finding: Claim): Claim => ({
  lens: finding.lens,
  claim: finding.claim,
  kind: finding.kind,
  doneWhen: finding.doneWhen,
  anchors: finding.anchors.map((anchor) => ({ ...anchor })),
  hunkId: finding.hunkId,
});

/**
 * The key of a claim read against one Frame, whose done-when text the Verify text holds: the name
 * of its Verify among its finder's children, and that Verify's computation input.
 */
export const claimKeyOf = (frameKey: string, finding: Claim) =>
  sha256Hex(canonicalJson({ frame: frameKey, claim: claimOf(finding) }));

export const VerifyStored = VerifySubmission.extend({
  /** The key of the claim it checked (`claimKeyOf`). */
  finding: z.string(),
  lens: Lens,
  source: z.enum(["agent", "final-generation", "backstop"]),
});
export type VerifyStored = z.infer<typeof VerifyStored>;
