import {
  SubmittedBranchReview,
  type SubmittedRange,
} from "@neuve/records-schema";

export class DecisionRangesError extends Error {
  readonly _tag = "DecisionRangesError";
  readonly reason: "input" | "patch" | "overlap";
  readonly detail: string;
  readonly hunkId?: string;
  constructor(input: {
    readonly reason: "input" | "patch" | "overlap";
    readonly detail: string;
    readonly hunkId?: string;
  }) {
    super(input.detail);
    this.name = "DecisionRangesError";
    this.reason = input.reason;
    this.detail = input.detail;
    if (input.hunkId !== undefined) this.hunkId = input.hunkId;
  }
}

export interface ChangedRun {
  readonly hunkId: string;
  readonly path: string;
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly oldLines: readonly string[];
  readonly newLines: readonly string[];
  readonly runIndex: number;
  readonly oldRange: SubmittedRange | null;
  readonly newRange: SubmittedRange | null;
}
export interface DecisionRangeObservation {
  readonly repository: string;
  readonly snapshotKind: "committed";
  readonly workingTreeDirty: boolean;
  readonly submissionLimitations: readonly string[];
  readonly revisionId: string;
  readonly mergeBaseRevisionId: string;
  readonly runs: readonly ChangedRun[];
  readonly additions: number;
  readonly deletions: number;
  readonly limitations: readonly {
    hunkId: string | null;
    kind: "binary" | "metadata" | "missing-patch" | "context-only";
    detail: string;
  }[];
}

/**
 * Read-only source accounting; ranges confer neither ownership nor approval.
 * Throws DecisionRangesError for an invalid submission or patch.
 */
export function extractDecisionRanges(
  input: unknown,
): DecisionRangeObservation {
  const parsed = SubmittedBranchReview.safeParse(input);
  if (!parsed.success)
    throw new DecisionRangesError({
      reason: "input",
      detail: "Invalid retained submission",
    });
  const submission = parsed.data;
  const associationError = (detail: string, hunkId?: string) =>
    new DecisionRangesError({
      reason: "input",
      detail,
      ...(hunkId === undefined ? {} : { hunkId }),
    });
  if (submission.inventory.revisionId !== submission.revisionId)
    throw associationError("Inventory belongs to a different revision");
  const inventory = new Set<string>();
  for (const registered of submission.inventory.hunks) {
    if (inventory.has(registered.hunkId))
      throw associationError("Duplicate inventory identity", registered.hunkId);
    inventory.add(registered.hunkId);
  }
  const membership = new Map<string, (typeof submission.files)[number]>();
  for (const file of submission.files) {
    for (const id of file.hunkIds) {
      if (!inventory.has(id))
        throw associationError(
          "File refers to unregistered responsibility",
          id,
        );
      if (membership.has(id))
        throw associationError("Hunk belongs to multiple file entries", id);
      membership.set(id, file);
    }
  }
  for (const hunk of submission.hunks) {
    const file = membership.get(hunk.hunkId);
    if (!inventory.has(hunk.hunkId) || !file)
      throw associationError(
        "Retained hunk lacks registered file responsibility",
        hunk.hunkId,
      );
    if (
      file.oldPath !== hunk.oldPath ||
      file.newPath !== hunk.newPath ||
      hunk.path !== (hunk.newPath ?? hunk.oldPath)
    )
      throw associationError(
        "Retained hunk paths contradict file attribution",
        hunk.hunkId,
      );
  }
  const runs: ChangedRun[] = [];
  const limitations: Array<DecisionRangeObservation["limitations"][number]> =
    [];
  const seen = new Set<string>();
  let additions = 0;
  let deletions = 0;
  for (const hunk of submission.hunks) {
    if (seen.has(hunk.hunkId))
      throw new DecisionRangesError({
        reason: "input",
        hunkId: hunk.hunkId,
        detail: "Duplicate retained hunk identity",
      });
    seen.add(hunk.hunkId);
    if (hunk.kind !== "text") {
      limitations.push({
        hunkId: hunk.hunkId,
        kind: hunk.kind,
        detail:
          "Nontext change remains a separate review obligation; line accounting cannot discharge it",
      });
      continue;
    }
    const lines = hunk.text.split("\n");
    if (lines.at(-1) === "") lines.pop();
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(
      lines.shift() ?? "",
    );
    const invalid = (detail: string) =>
      new DecisionRangesError({
        reason: "patch",
        hunkId: hunk.hunkId,
        detail,
      });
    if (!header || !hunk.oldRange || !hunk.newRange)
      throw invalid("Text hunk requires native coordinates");
    let oldLine = Number(header[1]);
    let newLine = Number(header[3]);
    const oldCount = Number(header[2] ?? 1);
    const newCount = Number(header[4] ?? 1);
    if (
      oldLine !== hunk.oldRange.startLine ||
      newLine !== hunk.newRange.startLine ||
      oldCount !== hunk.oldRange.lineCount ||
      newCount !== hunk.newRange.lineCount
    )
      throw invalid("Stored range differs from native patch header");
    if (
      ![
        oldLine,
        newLine,
        oldCount,
        newCount,
        oldLine + oldCount,
        newLine + newCount,
      ].every(Number.isSafeInteger) ||
      (oldCount > 0 && oldLine === 0) ||
      (newCount > 0 && newLine === 0)
    )
      throw invalid("Invalid native source coordinates");
    let consumedOld = 0;
    let consumedNew = 0;
    let active:
      | {
          oldStart: number;
          newStart: number;
          oldCount: number;
          newCount: number;
          oldLines: string[];
          newLines: string[];
        }
      | undefined;
    let runIndex = 0;
    const flush = () => {
      if (!active) return;
      runs.push({
        hunkId: hunk.hunkId,
        path: hunk.path,
        oldPath: hunk.oldPath,
        newPath: hunk.newPath,
        runIndex: runIndex++,
        oldLines: active.oldLines,
        newLines: active.newLines,
        oldRange: active.oldCount
          ? { startLine: active.oldStart, lineCount: active.oldCount }
          : null,
        newRange: active.newCount
          ? { startLine: active.newStart, lineCount: active.newCount }
          : null,
      });
      active = undefined;
    };
    let precedingSide: "old" | "new" | "both" | undefined;
    let endedOld = false;
    let endedNew = false;
    for (const line of lines) {
      if (line === "\\ No newline at end of file") {
        if (!precedingSide)
          throw invalid("No-newline marker requires a preceding source line");
        if (precedingSide === "old" || precedingSide === "both")
          endedOld = true;
        if (precedingSide === "new" || precedingSide === "both")
          endedNew = true;
        precedingSide = undefined;
        continue;
      }
      const touchesOld = line.startsWith("-") || line.startsWith(" ");
      const touchesNew = line.startsWith("+") || line.startsWith(" ");
      if ((touchesOld && endedOld) || (touchesNew && endedNew))
        throw invalid("Source line follows that side's no-newline end marker");
      precedingSide = line.startsWith(" ")
        ? "both"
        : line.startsWith("-")
          ? "old"
          : line.startsWith("+")
            ? "new"
            : undefined;
      if (line.startsWith(" ")) {
        flush();
        oldLine++;
        newLine++;
        consumedOld++;
        consumedNew++;
      } else if (line.startsWith("-") || line.startsWith("+")) {
        active ??= {
          oldStart: oldLine,
          newStart: newLine,
          oldCount: 0,
          newCount: 0,
          oldLines: [],
          newLines: [],
        };
        if (line.startsWith("-")) {
          active.oldLines.push(line.slice(1));
          active.oldCount++;
          oldLine++;
          consumedOld++;
          deletions++;
        } else {
          active.newLines.push(line.slice(1));
          active.newCount++;
          newLine++;
          consumedNew++;
          additions++;
        }
      } else throw invalid("Unexpected native patch line");
    }
    flush();
    if (runIndex === 0)
      limitations.push({
        hunkId: hunk.hunkId,
        kind: "context-only",
        detail:
          "Retained text hunk has no changed lines; it cannot discharge a changed obligation",
      });
    if (consumedOld !== oldCount || consumedNew !== newCount)
      throw invalid("Patch body does not account for native range counts");
    if (
      (hunk.oldPath === null && consumedOld !== 0) ||
      (hunk.newPath === null && consumedNew !== 0)
    )
      throw invalid("Absent source side contains patch lines");
  }
  for (const registered of submission.inventory.hunks) {
    if (!seen.has(registered.hunkId))
      limitations.push({
        hunkId: registered.hunkId,
        kind: "missing-patch",
        detail: "Registered responsibility has no retained patch",
      });
  }
  for (const file of submission.files) {
    if (file.hunkIds.length === 0 || file.hunkIds.some((id) => !seen.has(id)))
      limitations.push({
        hunkId: null,
        kind: "missing-patch",
        detail: "A submitted file has missing retained patch obligations",
      });
  }
  // Coordinate overlap across different hunks must not count a changed line twice.
  for (const side of ["oldRange", "newRange"] as const) {
    const byPath = new Map<
      string,
      Array<{ start: number; end: number; hunkId: string }>
    >();
    for (const run of runs) {
      const range = run[side];
      if (!range) continue;
      const path = side === "oldRange" ? run.oldPath : run.newPath;
      if (
        !path ||
        range.startLine < 1 ||
        !Number.isSafeInteger(range.startLine + range.lineCount)
      )
        throw new DecisionRangesError({
          reason: "patch",
          hunkId: run.hunkId,
          detail: "Changed lines require positive safe source coordinates",
        });
      const intervals = byPath.get(path) ?? [];
      intervals.push({
        start: range.startLine,
        end: range.startLine + range.lineCount,
        hunkId: run.hunkId,
      });
      byPath.set(path, intervals);
    }
    for (const intervals of byPath.values()) {
      intervals.sort((a, b) => a.start - b.start);
      let previous: (typeof intervals)[number] | undefined;
      for (const interval of intervals) {
        if (previous && interval.start < previous.end)
          throw new DecisionRangesError({
            reason: "overlap",
            hunkId: interval.hunkId,
            detail:
              "Retained hunks assign a changed source line more than once",
          });
        previous = interval;
      }
    }
  }
  return {
    repository: submission.repository,
    snapshotKind: submission.snapshotKind,
    workingTreeDirty: submission.workingTreeDirty,
    submissionLimitations: submission.limitations,
    revisionId: submission.revisionId,
    mergeBaseRevisionId: submission.mergeBaseRevisionId,
    runs,
    additions,
    deletions,
    limitations,
  };
}
