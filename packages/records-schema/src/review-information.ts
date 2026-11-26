import { z } from "zod";
import { Sha256 } from "./computations.ts";
import { Ulid } from "./envelope.ts";

/** Source facts only: recording this information never records a review disposition. */
export const ReviewInformationDestination = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("owned"),
    assignmentId: z.string().min(1).max(512),
    sectionKey: Sha256,
    batchId: z.string().min(1).max(512),
  }),
  z.strictObject({
    kind: z.literal("unassigned"),
    reason: z.string().min(1).max(2_048),
    sectionKeys: z.array(Sha256).max(4_096),
  }),
]);

export const ReviewInformationFact = z.strictObject({
  runKey: Sha256,
  claim: z.string().min(1).max(512),
  producer: z.strictObject({
    assignment: z.string().min(1).max(512),
    task: z.int().nonnegative(),
  }),
  anchor: z
    .strictObject({
      path: z.string().min(1).max(4_096),
      side: z.enum(["old", "new"]),
      startLine: z.int().positive(),
      endLine: z.int().positive(),
    })
    .refine(
      (anchor) => anchor.endLine >= anchor.startLine,
      "endLine precedes startLine",
    ),
  destination: ReviewInformationDestination,
  verify: z.strictObject({
    task: z.int().nonnegative().nullable(),
    computation: z.string().min(1).max(512).nullable(),
    outcome: z.enum(["confirmed", "refuted", "unconfirmed"]),
  }),
  classification: z.enum([
    "incoming",
    "later-review-information",
    "unknown-ownership",
  ]),
});

/** A bounded read request, not a new attribution or decision. Filters precede paging. */
export const ReviewInformationReadQuery = z.strictObject({
  cycleId: Ulid,
  runKey: Sha256,
  afterSeq: z.int().nonnegative().optional(),
  limit: z.int().min(1).max(1_000).optional(),
  detailsBytes: z.int().min(0).max(1_048_576).optional(),
  classifications: z
    .array(ReviewInformationFact.shape.classification)
    .min(1)
    .max(3)
    .optional(),
  destination: z
    .discriminatedUnion("kind", [
      z.strictObject({
        kind: z.literal("owned"),
        sectionKeys: z.array(Sha256).min(1).max(4_096),
      }),
      // Unknown ownership is a separate query; candidate sections never imply an owner.
      z.strictObject({ kind: z.literal("unassigned") }),
    ])
    .optional(),
});
export type ReviewInformationReadQuery = z.infer<
  typeof ReviewInformationReadQuery
>;

/** Retained permanently, independently of the producer's native/capture lifetime. */
export const ReviewInformationDetails = z.strictObject({
  report: z.record(z.string(), z.json()),
  source: z.record(z.string(), z.json()),
});
export type ReviewInformationFact = z.infer<typeof ReviewInformationFact>;
export type ReviewInformationDetails = z.infer<typeof ReviewInformationDetails>;
