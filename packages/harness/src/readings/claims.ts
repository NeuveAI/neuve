import { sha256Hex } from "@neuve/records-core";
import { Effect } from "effect";
import { z } from "zod";
import { dataBlock } from "../data-block.ts";
import { blobTextOf } from "../lookups.ts";
import type { RangeView } from "../pipeline.ts";
import type { AgentStep } from "../pi/stages/agent.ts";
import {
  VERIFY_INPUT_CHARS,
  VerifySubmission,
  verifySystem,
} from "../verify.ts";
import type { Anchor, LaneReviewJudgement } from "./answers.ts";
import type { Claim } from "./decide.ts";
import type { Reading } from "./reading.ts";
import { withOffered } from "./steps.ts";

/**
 * A Lane review defect comment is a claim, and each distinct claim is checked once, with fresh
 * context and no tools. Identical claims (the same
 * lines and the same words, up to case and spacing) share one key, so one check serves them all.
 */

type Comment = LaneReviewJudgement["comments"][number];
type ClaimComment = Anchor &
  Pick<Comment, "text" | "fails" | "evidenceAnchors">;

export const claimAnchor = ({ path, side, startLine, endLine }: Anchor) => ({
  path,
  side,
  startLine,
  endLine,
});

/** A claim's text in its normal form: lower case, runs of white space as one space, trimmed. */
const normalised = (text: string) =>
  text.trim().toLowerCase().replace(/\s+/g, " ");

/** The claim's key: its anchor and the normal form of its words. */
export const claimKey = (
  comment: Pick<Comment, "path" | "side" | "startLine" | "endLine" | "text">,
) =>
  sha256Hex(
    JSON.stringify([
      "neuve-claim-v1",
      comment.path,
      comment.side,
      comment.startLine,
      comment.endLine,
      normalised(comment.text),
    ]),
  );

/**
 * A comment's own ID, for a comment that is not a defect claim: a hash of its anchor, kind and words
 * (in the claim's normal form), so the same words on the same lines give the same ID in every run.
 */
export const commentKey = (
  comment: Pick<Comment, "path" | "side" | "startLine" | "endLine" | "text"> & {
    readonly kind: string;
  },
) =>
  sha256Hex(
    JSON.stringify([
      "neuve-comment-v1",
      comment.path,
      comment.side,
      comment.startLine,
      comment.endLine,
      comment.kind,
      normalised(comment.text),
    ]),
  );

/** The form a comment's ID takes for Records: printable ASCII with no space, at most 128 characters. */
export const COMMENT_ID = /^[\x21-\x7e]{1,128}$/;

export const ClaimStored = VerifySubmission.extend({
  /** The claim's key. */
  claim: z.string().regex(/^[0-9a-f]{64}$/),
  /** The section identity key the claim is on. */
  section: z.string().min(1),
  source: z.enum(["agent", "final-generation", "backstop"]),
});
export type ClaimStored = z.infer<typeof ClaimStored>;

type Evidence = { readonly anchor: Anchor; readonly source: string | null };

export const claimEvidence = (
  repository: string,
  anchors: ReadonlyArray<Anchor>,
  view: Pick<RangeView, "head" | "base">,
) =>
  Effect.forEach(anchors, (anchor) => {
    const revision = anchor.side === "new" ? view.head : view.base;
    const blob = revision.entries.get(anchor.path);
    return Effect.map(
      blob?.type === "blob"
        ? blobTextOf(repository, blob.oid)
        : Effect.succeed(null),
      (source): Evidence => ({ anchor, source }),
    );
  });

const bounded = (text: string, room: number, marker: string) =>
  text.length <= room
    ? text
    : text.slice(0, Math.max(0, room - marker.length)) + marker;

/** The claim, its own section and the pinned source it cites elsewhere. */
export const claimTask = (
  comment: ClaimComment,
  reading: Pick<Reading<"lane-review">, "text">,
  evidence: ReadonlyArray<Evidence> = [],
) => {
  const wrap = (body: string) => dataBlock("verify-evidence", {}, body);
  const body = [
    `${JSON.stringify({
      claim: comment.text,
      fails: comment.fails,
      anchor: claimAnchor(comment),
    })}\n`,
    `The changed section the claim is about, as the reviewer read it\n${reading.text}\n`,
  ].join("");
  const room = VERIFY_INPUT_CHARS - wrap("").length;
  if (evidence.length === 0)
    return wrap(bounded(body, room, "\n[evidence truncated]\n"));

  const excerpts = evidence.map(({ anchor, source }) => {
    const { path, side, startLine, endLine } = anchor;
    const first = Math.max(1, startLine - 8);
    const lines = source?.split("\n");
    const text =
      lines === undefined || endLine < startLine || endLine > lines.length
        ? "Unavailable at the cited revision."
        : lines
            .slice(first - 1, endLine + 8)
            .map((line, i) => `${first + i}: ${line}`)
            .join("\n");
    return {
      heading: `${path} (${side}) lines ${startLine}-${endLine}, context 8\n`,
      text: `${text}\n`,
    };
  });
  const marker = "\n[context truncated]\n";
  const textRoom =
    room - excerpts.reduce((size, { heading }) => size + heading.length, 0);
  const section = bounded(
    body,
    Math.min(Math.floor(room / 2), textRoom - excerpts.length * marker.length),
    "\n[evidence truncated]\n",
  );
  const perAnchor = Math.floor((textRoom - section.length) / excerpts.length);
  return wrap(
    section +
      excerpts
        .map(({ heading, text }) => heading + bounded(text, perAnchor, marker))
        .join(""),
  );
};

/**
 * The step that checks one claim. Keyed by the claim key, the section's identity key, the task it
 * is shown and what it is offered (`withOffered`). No partial: a check the cut-off interrupted stores nothing, and its
 * claim stays unconfirmed.
 */
export const claimVerifyStep = (p: {
  readonly key: string;
  readonly section: string;
  readonly comment: ClaimComment;
  /** The section's reading as the reviewer saw it. */
  readonly reading: Pick<Reading<"lane-review">, "text">;
  readonly evidence?: ReadonlyArray<Evidence> | undefined;
  readonly turnLimit: number;
}): AgentStep<VerifySubmission, ClaimStored> => {
  const task = claimTask(p.comment, p.reading, p.evidence);
  const fallback = (): VerifySubmission => ({
    decision: "drop",
    reason: "The claim was not checked.",
  });
  return withOffered({
    spec: {
      stage: "verify",
      agent: `verify.claim.${p.key.slice(0, 12)}`,
      turnLimit: p.turnLimit,
      // A claim check the provider could not answer leaves the claim unconfirmed, never a held review.
      unanswered: "fail",
      system: verifySystem,
      task,
      tools: [],
      submit: {
        description: "Decide whether the cited evidence supports this claim.",
        schema: VerifySubmission,
      },
      backstop: fallback,
    },
    op: "harness.verify-claim",
    opVersion: 1,
    inputs: { claim: p.key, section: p.section, task: sha256Hex(task) },
    compose: (r) => ({
      ...(r.output ?? fallback()),
      claim: p.key,
      section: p.section,
      source:
        r.status === "submitted"
          ? "agent"
          : r.status === "final-generation"
            ? "final-generation"
            : "backstop",
    }),
    schema: ClaimStored,
    note: (o) => `${o.decision}; source ${o.source}`,
  });
};

/**
 * A claim's outcome from its stored check, as the deciding code reads it: keep is confirmed, drop
 * is refuted, and a backstop or a check that never finished is unconfirmed, never confirmed.
 */
export const claimVerdict = (
  stored: ClaimStored | undefined,
): Claim["verify"] =>
  stored === undefined || stored.source === "backstop"
    ? "unconfirmed"
    : stored.decision === "keep"
      ? "confirmed"
      : "refuted";
