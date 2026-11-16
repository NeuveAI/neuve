import { z } from "zod";
import {
  CitationTarget,
  FindingKind,
  FindingAbout,
  FindingSignal,
  GuidedBasis,
} from "@neuve/records-schema";
import type { Lane } from "@neuve/records-schema";
import type {
  AssembledUnit,
  BatchInputs,
  ConfirmedBatch,
  Reference,
} from "./compose.ts";

const LEVELS = ["done-when", "scope", "gathered"] as const;

/** The most criteria one review holds (`UnitReview.criteria`); rows past it are disclosed. */
export const MAX_ROWS = 20;

/**
 * The rows a unit's Guided stop is judged on (10.67, DI5): the ticket's "Done when" items, else its
 * scope, else a gathered scope. The obligations of the unit's batch that name one of its hunks, and
 * those that name no hunk, which apply to all the batch's work (so a ticket's "Done when" item that
 * Understand mapped to no hunk is never hidden by an obligation that names one); then only those on
 * the strongest basis present, at most `MAX_ROWS`, the rest disclosed.
 */
export const unitGuidedBasis = (
  inputs: {
    readonly obligations: BatchInputs["behaviour"]["obligations"];
    readonly unlinked: boolean;
  },
  batch: Pick<ConfirmedBatch, "obligationIds">,
  unit: AssembledUnit,
): GuidedBasis => {
  const own = new Set(unit.hunkIds);
  const ofBatch = inputs.obligations.filter((o) =>
    batch.obligationIds.includes(o.id),
  );
  const pool = ofBatch.filter(
    (o) => o.hunkIds.length === 0 || o.hunkIds.some((h) => own.has(h)),
  );
  const level = LEVELS.find((basis) => pool.some((o) => o.basis === basis));
  const requirements = unit.assessment.validation.requirements;
  const chosen = pool.filter((o) => o.basis === level);
  const rows = chosen.slice(0, MAX_ROWS).map((o) => ({
    row: o.id,
    text: o.text,
    basis: o.basis,
    sectionId: o.sectionId,
    requirements: requirements
      .filter((r) => r.basis === o.id)
      .map((r) => ({
        requirement: r.requirement,
        kinds: [...r.kinds],
        proof: [...r.proof],
      })),
  }));
  const rowIds = new Set(rows.map((row) => row.row));
  return {
    level: level ?? "none",
    unlinked: inputs.unlinked,
    rows,
    omitted: chosen
      .slice(MAX_ROWS)
      .map((o) => ({ row: o.id, text: o.text, basis: o.basis })),
    implied: requirements
      .filter((r) => !rowIds.has(r.basis))
      .map((r) => ({
        requirement: r.requirement,
        kinds: [...r.kinds],
        proof: [...r.proof],
      })),
  };
};

/** Frame conditions and their group links supply the unit's Guided rows. */
export const guidedBasis = (
  inputs: {
    readonly behaviour: Pick<BatchInputs["behaviour"], "obligations">;
    readonly changeMap: Pick<BatchInputs["changeMap"], "unlinked">;
  },
  batch: Pick<ConfirmedBatch, "obligationIds">,
  unit: AssembledUnit,
): GuidedBasis =>
  unitGuidedBasis(
    {
      obligations: inputs.behaviour.obligations,
      unlinked: inputs.changeMap.unlinked,
    },
    batch,
    unit,
  );

/** A reference region's diff side: its stated revision, or its blob's place in head or base. */
const referenceSide = (
  source: Exclude<Reference["source"], { origin: "scope" }>,
  sideOf:
    ((path: string, blob: string) => "old" | "new" | undefined) | undefined,
) =>
  source.rev === "head"
    ? "new"
    : source.rev === "base"
      ? "old"
      : sideOf?.(source.path, source.blob);

export const overlaps = (
  a: { readonly startLine: number; readonly endLine: number },
  b: { readonly startLine: number; readonly endLine: number },
) => a.startLine <= b.endLine && b.startLine <= a.endLine;

/** Whether a finding's lines are this unit's owned lines or a region its references cite. */
export const anchorResolves = (
  anchor: {
    readonly path: string;
    readonly side: "old" | "new";
    readonly startLine: number;
    readonly endLine: number;
  },
  checks: {
    readonly unit: Pick<AssembledUnit, "ownedRanges">;
    readonly references: ReadonlyArray<Reference>;
    readonly sideOf?:
      ((path: string, blob: string) => "old" | "new" | undefined) | undefined;
  },
) => {
  if (anchor.endLine < anchor.startLine) return false;
  const owned = checks.unit.ownedRanges.some((range) =>
    range.kind === "lines"
      ? range.path === anchor.path &&
        range.side === anchor.side &&
        overlaps(range, anchor)
      : range.path === anchor.path && range.side === anchor.side,
  );
  if (owned) return true;
  return checks.references.some((reference) => {
    const source = reference.source;
    // A stack source is never under review (3.5, SC7): no finding anchors in its region.
    if (source.origin === "scope" || source.origin === "stack") return false;
    const side = referenceSide(source, checks.sideOf);
    return (
      side !== undefined &&
      source.path === anchor.path &&
      side === anchor.side &&
      anchor.startLine >= source.startLine &&
      anchor.endLine <= source.endLine
    );
  });
};

// ---------------------------------------------------------------------------------------------
// The lane, applied after the verdict (10.33; 4.5, 4.13, 4.14)
// ---------------------------------------------------------------------------------------------

interface LaneOutcome {
  /** The verdict recorded as the agent's disposition, or none. */
  readonly disposition: "approve" | "request-changes" | undefined;
  /** The verdict shown as a suggested review at the Guided stop (human-required work only). */
  readonly suggestion: boolean;
}

/**
 * What a lane-blind verdict becomes (4.5, 4.14; vocabulary: decision dock): on agentic and
 * human-suggested work, a disposition; on human-required work, a suggested review, and a request
 * for changes also recorded as the agent's disposition, which reaches the person as context; on
 * static-automation work, which closes without a disposition, only a request for changes.
 */
export const applyLane = (
  lane: Lane,
  verdict: "approve" | "request-changes",
): LaneOutcome => {
  switch (lane) {
    case "agentic":
    case "human-suggested":
      return { disposition: verdict, suggestion: false };
    case "human-required":
      return {
        disposition: verdict === "request-changes" ? verdict : undefined,
        suggestion: true,
      };
    case "static-automation":
      return {
        disposition: verdict === "request-changes" ? verdict : undefined,
        suggestion: false,
      };
  }
};

/**
 * The proof an approval cites (10.83): for each validation requirement, the proof records it rests
 * on with their coverage, or a plain statement that proof is not recorded. Written by code from the
 * assessment, after the lane-blind review, so the reviewer never saw the coverage grades.
 */
export const approvalProof = (unit: AssembledUnit) =>
  requirementsProof(unit.assessment.validation.requirements);

/**
 * The proof text over any unit's requirements: an assembled unit's, or the requirements of the
 * sections a unit holds. The same words and records as `approvalProof`.
 */
export const requirementsProof = (
  requirements: ReadonlyArray<{
    readonly requirement: string;
    readonly coverage: "missing" | "shallow" | "solid";
    readonly proof: ReadonlyArray<string>;
  }>,
) => {
  const proof = [
    ...new Set(
      requirements
        .filter((r) => r.coverage !== "missing")
        .flatMap((r) => r.proof),
    ),
  ];
  const lines =
    requirements.length === 0
      ? [
          "No validation requirement is stated for this unit; proof is not recorded.",
        ]
      : requirements.map((r) =>
          r.coverage === "missing" || r.proof.length === 0
            ? `"${r.requirement.slice(0, 120)}": proof is not recorded.`
            : `"${r.requirement.slice(0, 120)}" rests on ${r.proof.length} proof record(s) (${r.coverage}).`,
        );
  // The records themselves are the disposition's `proof` citations (10.83).
  return { proof, text: `Proof: ${lines.join(" ")}` };
};

/** Link writes the existing Dispose citation envelope for Records' packet reader. */
export const LinkedReview = z.strictObject({
  unit: z.string(),
  source: z.literal("agent"),
  uncited: z.boolean(),
  withheld: z.boolean(),
  notes: z.array(z.string()),
  guided: GuidedBasis,
  citations: z.record(z.string(), CitationTarget),
  review: z.strictObject({
    verdict: z.enum(["approve", "request-changes"]),
    criteria: z
      .array(
        z.strictObject({
          row: z.string(),
          status: z.enum(["met", "not-met", "no-evidence"]),
          does: z.string().min(1).max(200),
          evidence: z.array(z.string()).max(8),
        }),
      )
      .max(20),
    outside: z.array(
      z.strictObject({
        item: z.string(),
        does: z.string(),
        evidence: z.array(z.string()),
      }),
    ),
    findings: z
      .array(
        z.strictObject({
          // Retained reviews predate the finding ledger (12.41).
          id: z.string().min(1).optional(),
          anchor: z.strictObject({
            path: z.string(),
            side: z.enum(["old", "new"]),
            startLine: z.int().min(1),
            endLine: z.int().min(1),
          }),
          kind: FindingKind,
          about: FindingAbout,
          signal: FindingSignal.nullable(),
          text: z.string().min(1).max(400),
          evidence: z.array(z.string()).max(8),
          row: z.string().nullable(),
        }),
      )
      .max(20),
    message: z.string().min(1).max(1200),
    gaps: z.array(z.string()),
  }),
});
export type LinkedReview = z.infer<typeof LinkedReview>;
