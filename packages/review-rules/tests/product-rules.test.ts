import { expect, test } from "bun:test";
import type { SubmittedBranchReview } from "@neuve/records-schema";
import { matchesOwnedSourceAnchor } from "../src/comment-anchor.ts";
import {
  DecisionRangesError,
  extractDecisionRanges,
} from "../src/decision-ranges.ts";
import {
  ResponsibilityScopeError,
  assessResponsibilityAllocation,
  canonicalizeResponsibilityScope,
} from "../src/responsibility-scope.ts";
import { projectSubmittedChangedRanges } from "../src/submitted-hunks.ts";

// Why: these rules moved from Effect Schema and Effect.gen to zod and plain
// functions in M2 S2. This pins the accepted and rejected inputs the ported
// rules must keep: line accounting, overlap refusal, allocation completeness
// and anchor matching on one small committed submission.

const revision = "a".repeat(40);
const submission: SubmittedBranchReview = {
  repository: "/repo",
  branch: "feature",
  baseBranch: "main",
  baseRevisionId: "b".repeat(40),
  mergeBaseRevisionId: "b".repeat(40),
  revisionId: revision,
  snapshotKind: "committed",
  workingTreeDirty: false,
  limitations: [],
  files: [
    {
      status: "modified",
      oldPath: "src/a.ts",
      newPath: "src/a.ts",
      oldMode: "100644",
      newMode: "100644",
      binary: false,
      hunkIds: ["h1"],
    },
  ],
  hunks: [
    {
      hunkId: "h1",
      lane: "agentic",
      kind: "text",
      path: "src/a.ts",
      oldPath: "src/a.ts",
      newPath: "src/a.ts",
      oldRange: { startLine: 1, lineCount: 3 },
      newRange: { startLine: 1, lineCount: 4 },
      text: "@@ -1,3 +1,4 @@\n keep\n-old\n+new\n+added\n tail\n",
    },
  ],
  inventory: {
    revisionId: revision,
    hunks: [{ hunkId: "h1", lane: "agentic" }],
  },
};

test("decision ranges count changed lines and keep native coordinates", () => {
  const observation = extractDecisionRanges(submission);
  expect(observation.additions).toBe(2);
  expect(observation.deletions).toBe(1);
  expect(observation.runs).toEqual([
    expect.objectContaining({
      hunkId: "h1",
      oldRange: { startLine: 2, lineCount: 1 },
      newRange: { startLine: 2, lineCount: 2 },
    }),
  ]);
  expect(observation.limitations).toEqual([]);
});

test("decision ranges refuse a header that contradicts stored ranges", () => {
  const hunk = {
    ...submission.hunks[0]!,
    newRange: { startLine: 1, lineCount: 5 },
  };
  expect(() => extractDecisionRanges({ ...submission, hunks: [hunk] })).toThrow(
    DecisionRangesError,
  );
  expect(() => extractDecisionRanges({})).toThrow(DecisionRangesError);
});

test("changed-range projection attaches ranges to each hunk", () => {
  const projected = projectSubmittedChangedRanges(submission);
  expect(projected.hunks[0]?.changedRanges).toEqual([
    { side: "old", startLine: 2, lineCount: 1 },
    { side: "new", startLine: 2, lineCount: 2 },
  ]);
});

const member = (side: "old" | "new", startLine: number, lineCount: number) => ({
  kind: "changed-lines" as const,
  hunkId: "h1",
  side,
  startLine,
  lineCount,
});

test("scopes merge adjacent members and refuse overlap or excess keys", () => {
  expect(
    canonicalizeResponsibilityScope({
      kind: "changed-ranges",
      members: [member("new", 3, 1), member("new", 2, 1)],
    }).members,
  ).toEqual([member("new", 2, 2)]);
  expect(() =>
    canonicalizeResponsibilityScope({
      kind: "changed-ranges",
      members: [member("new", 2, 2), member("new", 3, 1)],
    }),
  ).toThrow(ResponsibilityScopeError);
  expect(() =>
    canonicalizeResponsibilityScope({
      kind: "changed-ranges",
      members: [{ ...member("new", 2, 1), extra: true }],
    }),
  ).toThrow(ResponsibilityScopeError);
});

test("allocation is complete only when every changed line has one owner", () => {
  const unit = (members: ReturnType<typeof member>[]) => ({
    unitId: "u1",
    revisionId: revision,
    responsibility: { kind: "changed-ranges", members },
  });
  const partial = assessResponsibilityAllocation({
    submission,
    units: [unit([member("new", 2, 2)])],
  });
  expect(partial.allocationComplete).toBe(false);
  expect(partial.unallocated).toEqual([member("old", 2, 1)]);
  const complete = assessResponsibilityAllocation({
    submission,
    units: [unit([member("new", 2, 2), member("old", 2, 1)])],
  });
  expect(complete.allocationComplete).toBe(true);
  expect(() =>
    assessResponsibilityAllocation({
      submission,
      units: [unit([member("new", 1, 1)])],
    }),
  ).toThrow(ResponsibilityScopeError);
});

test("anchors match only the unit's own canonical hunk lines", () => {
  const anchor = {
    filePath: "src/a.ts",
    range: { start: 2, end: 2, side: "additions" as const },
    hunk: { index: 0, header: "@@ -1,3 +1,4 @@" },
    lines: [{ side: "additions" as const, lineNumber: 2, text: "new" }],
  };
  expect(
    matchesOwnedSourceAnchor(anchor, { hunkIds: ["h1"] }, submission),
  ).toBe(true);
  expect(matchesOwnedSourceAnchor(anchor, { hunkIds: [] }, submission)).toBe(
    false,
  );
  expect(
    matchesOwnedSourceAnchor(
      { ...anchor, lines: [{ ...anchor.lines[0]!, text: "other" }] },
      { hunkIds: ["h1"] },
      submission,
    ),
  ).toBe(false);
});
