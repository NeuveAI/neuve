import { z } from "zod";

/** Actual prepared or returned source, not the reviewer's paraphrase of that source. */
export const ReviewEvidence = z.strictObject({
  reference: z.string().min(1),
  text: z.string(),
});
export type ReviewEvidence = z.infer<typeof ReviewEvidence>;

export const ReviewObservation = z.strictObject({
  anchor: z.strictObject({
    path: z.string().min(1),
    side: z.enum(["old", "new"]),
    startLine: z.int().min(1),
    endLine: z.int().min(1),
  }),
  kind: z.enum(["defect", "risk", "question"]),
  text: z.string().min(1).max(1200),
  fails: z.string().max(1200),
  /** Evidence references exposed by the prepared reading or returned by a lookup. */
  evidence: z.array(z.string().min(1)).min(1).max(8),
  row: z.string().nullable(),
});
export type ReviewObservation = z.infer<typeof ReviewObservation>;

/** Code-supplied source identity, retained verbatim so replay cannot reconstruct a different basis. */
export const ReviewClaimBasis = z.strictObject({
  producer: z.strictObject({
    review: z.string(),
    run: z.string(),
    cycle: z.string(),
    head: z.string(),
  }),
  source: z.strictObject({
    plan: z.string(),
    manifest: z.string(),
    frame: z.string(),
    map: z.string(),
    evidence: z.string().nullable(),
  }),
});
export type ReviewClaimBasis = z.infer<typeof ReviewClaimBasis>;

/** Retained independently of final section verdicts, including when investigation is interrupted. */
export const RecordedReviewClaim = z.strictObject({
  key: z.string().regex(/^[0-9a-f]{64}$/),
  observation: ReviewObservation,
  section: z.string().nullable(),
  ownership: z.enum(["owned", "cross-boundary", "unknown"]),
  evidence: z.array(ReviewEvidence),
  basis: ReviewClaimBasis.optional(),
});
export type RecordedReviewClaim = z.infer<typeof RecordedReviewClaim>;
