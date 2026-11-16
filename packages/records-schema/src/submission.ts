import { z } from "zod";
import { Lane } from "./events.ts";

/**
 * A branch submitted for review as committed source: its files, native diff
 * hunks and the lane inventory. These are inputs to the product rules
 * (decision ranges, responsibility allocation, comment anchors), not events.
 * Ported from the web backend's Effect Schema definitions, following the
 * zod-schemas architecture record
 * (architecture/decisions/0011-zod-schemas.md): zod is the only schema for
 * stored and wire types.
 */
const text = z.string().min(1);

export const SubmittedRevision = z
  .string()
  .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);

export const SubmittedRange = z.object({
  startLine: z.int().min(0),
  lineCount: z.int().min(0),
});

export const SubmittedHunk = z.object({
  hunkId: text,
  lane: Lane,
  kind: z.enum(["text", "metadata", "binary"]),
  path: text,
  oldPath: text.nullable(),
  newPath: text.nullable(),
  oldRange: SubmittedRange.nullable(),
  newRange: SubmittedRange.nullable(),
  text,
});

export const SubmittedFile = z.object({
  status: z.enum(["added", "deleted", "modified", "renamed", "type-changed"]),
  oldPath: text.nullable(),
  newPath: text.nullable(),
  oldMode: z.string().nullable(),
  newMode: z.string().nullable(),
  binary: z.boolean(),
  hunkIds: z.array(text),
});

export const SubmittedBranchReview = z.object({
  repository: text,
  branch: text,
  baseBranch: text,
  baseRevisionId: SubmittedRevision,
  mergeBaseRevisionId: SubmittedRevision,
  revisionId: SubmittedRevision,
  snapshotKind: z.literal("committed"),
  workingTreeDirty: z.boolean(),
  limitations: z.array(text),
  files: z.array(SubmittedFile),
  hunks: z.array(SubmittedHunk),
  inventory: z.object({
    revisionId: SubmittedRevision,
    hunks: z.array(z.object({ hunkId: text, lane: Lane })),
  }),
});

const DiffSide = z.enum(["additions", "deletions"]);
const PositiveLine = z.int().min(1);

/** A review comment anchored to exact lines of one submitted hunk. */
export const ReviewCommentAnchor = z.object({
  filePath: z
    .string()
    .min(1)
    .regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\0]+$/),
  range: z.object({
    start: PositiveLine,
    end: PositiveLine,
    side: DiffSide,
    endSide: DiffSide.optional(),
  }),
  hunk: z.object({ index: z.int().min(0), header: z.string() }),
  lines: z
    .array(
      z.object({ side: DiffSide, lineNumber: PositiveLine, text: z.string() }),
    )
    .min(1),
});

export type SubmittedRange = z.infer<typeof SubmittedRange>;
export type SubmittedHunk = z.infer<typeof SubmittedHunk>;
export type SubmittedFile = z.infer<typeof SubmittedFile>;
export type SubmittedBranchReview = z.infer<typeof SubmittedBranchReview>;
export type ReviewCommentAnchor = z.infer<typeof ReviewCommentAnchor>;
