import {
  SubmittedBranchReview,
  type SubmittedHunk,
  type SubmittedRange,
} from "@neuve/records-schema";
import {
  extractDecisionRanges,
  DecisionRangesError,
} from "./decision-ranges.ts";

export interface ChangedRange extends SubmittedRange {
  readonly side: "old" | "new";
}
export interface AccountingQualification {
  readonly kind: "binary" | "metadata" | "missing-patch" | "context-only";
  readonly detail: string;
}
export interface SubmittedHunkWithChangedRanges extends SubmittedHunk {
  readonly changedRanges: readonly ChangedRange[];
  readonly qualifications: readonly AccountingQualification[];
}

/**
 * Each submitted hunk with the changed line ranges it carries and the
 * accounting qualifications that apply to it. The full submission is
 * validated before any hunk is projected. Throws DecisionRangesError.
 */
export function projectSubmittedChangedRanges(input: unknown) {
  const parsed = SubmittedBranchReview.safeParse(input);
  if (!parsed.success)
    throw new DecisionRangesError({
      reason: "input",
      detail: "Invalid retained submission",
    });
  const submission = parsed.data;
  const observation = extractDecisionRanges(submission);
  return {
    source: {
      repository: observation.repository,
      revisionId: observation.revisionId,
      mergeBaseRevisionId: observation.mergeBaseRevisionId,
      snapshotKind: observation.snapshotKind,
      workingTreeDirty: observation.workingTreeDirty,
      limitations: observation.submissionLimitations,
      unavailableSource: observation.limitations.filter(
        (limitation) =>
          limitation.hunkId === null ||
          !submission.hunks.some((hunk) => hunk.hunkId === limitation.hunkId),
      ),
    },
    hunks: submission.hunks.map((hunk): SubmittedHunkWithChangedRanges => ({
      ...hunk,
      changedRanges: observation.runs
        .filter((run) => run.hunkId === hunk.hunkId)
        .flatMap((run) => [
          ...(run.oldRange === null
            ? []
            : [{ side: "old" as const, ...run.oldRange }]),
          ...(run.newRange === null
            ? []
            : [{ side: "new" as const, ...run.newRange }]),
        ]),
      qualifications: observation.limitations
        .filter((limitation) => limitation.hunkId === hunk.hunkId)
        .map(({ kind, detail }) => ({ kind, detail })),
    })),
  };
}
