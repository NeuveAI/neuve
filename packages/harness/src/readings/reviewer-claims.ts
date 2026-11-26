import { canonicalJson, sha256Hex } from "@neuve/records-core";
import { Effect } from "effect";
import { z } from "zod";
import { dataBlock } from "../data-block.ts";
import {
  defineTool,
  READ_ONLY,
  RECORDS,
  type ChildRequest,
  type ToolSpec,
} from "../toolkit.ts";
import type { ToolStateHolder } from "../pi/stages/agent.ts";

import {
  ReviewEvidence,
  ReviewObservation,
  ReviewClaimBasis,
  RecordedReviewClaim,
} from "./reviewer-claim-schema.ts";
export {
  ReviewEvidence,
  ReviewObservation,
  ReviewClaimBasis,
  RecordedReviewClaim,
} from "./reviewer-claim-schema.ts";

/** A failure path is part of identity: two failures at the same anchor are not one concern. */
export const reviewClaimKey = (observation: ReviewObservation) =>
  sha256Hex(
    canonicalJson({
      version: "comprehensive-claim-v1",
      anchor: observation.anchor,
      kind: observation.kind,
      text: observation.text,
      fails: observation.fails,
      row: observation.row,
    }),
  );

/**
 * One assignment's retained observations and exact lookup results. The runtime commits this state
 * with the tool's answer and its Verify child. A reopened task loads it, not a second ledger.
 * There is no finding quota. Lookup text is already bounded by the caller's reading budget.
 */
export const reviewerClaims = (p: {
  readonly initial: ReadonlyArray<ReviewEvidence>;
  readonly assignment?: Readonly<Record<string, unknown>>;
  readonly basis?: ReviewClaimBasis;
  readonly resolve: (anchor: ReviewObservation["anchor"]) => {
    readonly section: string | null;
    readonly ownership: RecordedReviewClaim["ownership"];
  };
  readonly child: (claim: RecordedReviewClaim) => ChildRequest;
}) => {
  const initial = p.initial.map((entry) => ({ ...entry }));
  let evidence = [...initial];
  let claims: Array<RecordedReviewClaim> = [];
  const state: ToolStateHolder = {
    save: () => ({ reviewEvidence: evidence, reviewClaims: claims }),
    load: (held) => {
      evidence =
        held?.reviewEvidence === undefined
          ? [...initial]
          : z.array(ReviewEvidence).parse(held.reviewEvidence);
      claims =
        held?.reviewClaims === undefined
          ? []
          : z.array(RecordedReviewClaim).parse(held.reviewClaims);
    },
  };
  return {
    state,
    claims: (): ReadonlyArray<RecordedReviewClaim> => claims,
    evidence: (): ReadonlyArray<ReviewEvidence> => evidence,
    /** Wrap only the budgeted read tools: observation recording must never spend the read budget. */
    readingTools: (tools: ReadonlyArray<ToolSpec<unknown>>) =>
      tools.map((tool): ToolSpec<unknown> => ({
        ...tool,
        handle: (input, call) =>
          tool.handle(input, call).pipe(
            Effect.map((result) => {
              if (result.error !== undefined) return result;
              const reference = `lookup.${sha256Hex(canonicalJson([tool.name, input, result.text])).slice(0, 24)}`;
              if (!evidence.some((entry) => entry.reference === reference))
                evidence.push({ reference, text: result.text });
              return {
                ...result,
                text: `Evidence reference: ${reference}\n${result.text}`,
              };
            }),
          ),
      })),
    stateTool: defineTool({
      name: "review_state",
      description:
        "Read this assignment's prepared source references and its own retained concern state, paged. No sibling verdicts, approvals or implementer conclusions are included.",
      input: z.strictObject({ page: z.int().min(1) }),
      hints: READ_ONLY,
      handle: ({ page }) =>
        Effect.sync(() => {
          const start = (page - 1) * 8;
          return {
            text: dataBlock(
              "review-state",
              {},
              JSON.stringify({
                assignment: p.assignment ?? null,
                claims: claims.slice(start, start + 8).map((claim) => ({
                  key: claim.key,
                  anchor: claim.observation.anchor,
                  ownership: claim.ownership,
                  state: "retained, not verification or resolution",
                })),
                more: Math.max(claims.length, initial.length) > start + 8,
                sourceReferences: initial
                  .slice(start, start + 8)
                  .map((entry) => entry.reference),
              }),
            ),
            paged: Math.max(claims.length, initial.length) > start + 8,
          };
        }),
    }),
    tool: defineTool({
      name: "record_claim",
      description:
        "Record a supported concern as soon as it is supported, including outside your owned work. Give an exact primary changed anchor and evidence references from section evidence or lookups. Recording retains the original source and starts a fresh-context claim check, not another general review. No finding quota.",
      input: ReviewObservation,
      hints: RECORDS,
      handle: (observation) =>
        Effect.sync(() => {
          if (
            observation.anchor.endLine < observation.anchor.startLine ||
            observation.text.trim() === "" ||
            (observation.kind === "defect" && observation.fails.trim() === "")
          )
            return {
              text: "A concern needs an ordered anchor, meaningful text and, for a defect, a concrete failure path.",
              error: "InvalidClaim",
            };
          const refs = [...new Set(observation.evidence)];
          const basis = refs.flatMap((ref) =>
            evidence.filter((entry) => entry.reference === ref),
          );
          if (basis.length !== refs.length)
            return {
              text: "Use only evidence references the prepared reading or lookup tools actually exposed.",
              error: "UnknownEvidence",
            };
          const key = reviewClaimKey(observation);
          const existing = claims.find((claim) => claim.key === key);
          if (existing !== undefined)
            return {
              text: `Already retained: ${key}.`,
              child: p.child(existing),
            };
          const claim = RecordedReviewClaim.parse({
            key,
            observation,
            ...p.resolve(observation.anchor),
            evidence: basis,
            ...(p.basis === undefined ? {} : { basis: p.basis }),
          });
          claims.push(claim);
          return {
            text: `Retained ${claim.ownership} concern: ${key}. Recording is not verification, approval or resolution.`,
            child: p.child(claim),
          };
        }),
    }),
  };
};

/** The verifier sees the original concern and exact source basis, never another reviewer's verdict. */
export const recordedClaimTask = (claim: RecordedReviewClaim) =>
  dataBlock(
    "verify-evidence",
    {},
    JSON.stringify({
      claim: claim.observation.text,
      kind: claim.observation.kind,
      fails: claim.observation.fails,
      anchor: claim.observation.anchor,
      evidence: claim.evidence,
    }),
  );
