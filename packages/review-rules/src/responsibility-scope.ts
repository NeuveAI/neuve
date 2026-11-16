import { z } from "zod";
import { SubmittedBranchReview } from "@neuve/records-schema";
import { extractDecisionRanges } from "./decision-ranges.ts";

const Identity = z.string().min(1).regex(/\S/);
const PositiveCoordinate = z.int().min(1).max(Number.MAX_SAFE_INTEGER);
export const ChangedResponsibilityMember = z
  .strictObject({
    kind: z.literal("changed-lines"),
    hunkId: Identity,
    side: z.enum(["old", "new"]),
    startLine: PositiveCoordinate,
    lineCount: PositiveCoordinate,
  })
  .refine(
    (member) => Number.isSafeInteger(member.startLine + member.lineCount),
    "Responsibility endpoint must be a safe integer",
  );
export type ChangedResponsibilityMember = z.infer<
  typeof ChangedResponsibilityMember
>;
export const WholeNontextResponsibilityMember = z.strictObject({
  kind: z.literal("whole-nontext"),
  hunkId: Identity,
});
export type WholeNontextResponsibilityMember = z.infer<
  typeof WholeNontextResponsibilityMember
>;
export const ResponsibilityMember = z.union([
  ChangedResponsibilityMember,
  WholeNontextResponsibilityMember,
]);
export type ResponsibilityMember = z.infer<typeof ResponsibilityMember>;
export const RangedResponsibilityScope = z.strictObject({
  kind: z.literal("changed-ranges"),
  members: z.array(ResponsibilityMember).min(1),
});
export type RangedResponsibilityScope = z.infer<
  typeof RangedResponsibilityScope
>;
export const RangedResponsibilityUnit = z.strictObject({
  unitId: Identity,
  revisionId: SubmittedBranchReview.shape.revisionId,
  responsibility: RangedResponsibilityScope,
});
export type RangedResponsibilityUnit = z.infer<typeof RangedResponsibilityUnit>;
type ResponsibilityScopeReason =
  | "input"
  | "duplicate-unit"
  | "revision"
  | "foreign-hunk"
  | "context-line"
  | "overlap"
  | "member-kind";
export class ResponsibilityScopeError extends Error {
  readonly _tag = "ResponsibilityScopeError";
  constructor(
    readonly reason: ResponsibilityScopeReason,
    readonly detail: string,
    readonly unitId: string | null = null,
    readonly hunkId: string | null = null,
  ) {
    super(detail);
    this.name = "ResponsibilityScopeError";
  }
}
const failure = (
  reason: ResponsibilityScopeReason,
  detail: string,
  unitId: string | null = null,
  hunkId: string | null = null,
) => new ResponsibilityScopeError(reason, detail, unitId, hunkId);
const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const compareMembers = (a: ResponsibilityMember, b: ResponsibilityMember) =>
  order(a.hunkId, b.hunkId) ||
  order(a.kind, b.kind) ||
  (a.kind === "changed-lines" && b.kind === "changed-lines"
    ? order(a.side, b.side) || a.startLine - b.startLine
    : 0);

/** Sorts members and merges adjacent changed lines; overlap is an error. */
function canonicalScope(
  scope: RangedResponsibilityScope,
): RangedResponsibilityScope {
  const members: ResponsibilityMember[] = [];
  for (const member of [...scope.members].sort(compareMembers)) {
    const prior = members.at(-1);
    if (prior?.hunkId === member.hunkId && prior.kind === member.kind) {
      if (prior.kind === "whole-nontext" && member.kind === "whole-nontext")
        throw failure(
          "overlap",
          "Duplicate nontext ownership",
          null,
          member.hunkId,
        );
      if (
        prior.kind === "changed-lines" &&
        member.kind === "changed-lines" &&
        prior.side === member.side
      ) {
        const end = prior.startLine + prior.lineCount;
        if (member.startLine < end)
          throw failure(
            "overlap",
            "Overlapping changed members",
            null,
            member.hunkId,
          );
        if (member.startLine === end) {
          members.pop();
          members.push({
            ...prior,
            lineCount: prior.lineCount + member.lineCount,
          });
          continue;
        }
      }
    }
    members.push(member);
  }
  const parsed = RangedResponsibilityScope.safeParse({
    kind: "changed-ranges",
    members,
  });
  if (!parsed.success)
    throw failure("input", "Invalid canonical responsibility");
  return parsed.data;
}

/** Throws ResponsibilityScopeError for an invalid or overlapping scope. */
export function canonicalizeResponsibilityScope(
  input: unknown,
): RangedResponsibilityScope {
  const parsed = RangedResponsibilityScope.safeParse(input);
  if (!parsed.success) throw failure("input", "Invalid responsibility scope");
  return canonicalScope(parsed.data);
}

export interface ResponsibilityAllocation {
  readonly repository: string;
  readonly revisionId: string;
  readonly mergeBaseRevisionId: string;
  readonly snapshotKind: "committed";
  readonly workingTreeDirty: boolean;
  readonly submissionLimitations: readonly string[];
  readonly units: readonly RangedResponsibilityUnit[];
  readonly unallocated: readonly ResponsibilityMember[];
  readonly sourceLimitations: ReturnType<
    typeof extractDecisionRanges
  >["limitations"];
  readonly changedInstances: number;
  readonly allocatedChangedInstances: number;
  readonly nontextObligations: number;
  readonly allocatedNontextObligations: number;
  readonly allocationComplete: boolean;
}

/**
 * Checks that proposed units own disjoint changed lines and nontext hunks of
 * one submission, and reports what remains unallocated. Throws
 * DecisionRangesError or ResponsibilityScopeError.
 */
export function assessResponsibilityAllocation(input: {
  readonly submission: unknown;
  readonly units: unknown;
}): ResponsibilityAllocation {
  const source = extractDecisionRanges(input.submission);
  const parsedUnits = z.array(RangedResponsibilityUnit).safeParse(input.units);
  if (!parsedUnits.success)
    throw failure("input", "Invalid ranged review units");
  const proposed = parsedUnits.data;
  const changed = new Map<
    string,
    { hunkId: string; side: "old" | "new"; line: number }
  >();
  const memberKey = (hunkId: string, side: "old" | "new", line: number) =>
    JSON.stringify([hunkId, side, line]);
  const available = new Map<string, Set<number>>();
  const sideKey = (hunkId: string, side: "old" | "new") =>
    JSON.stringify([hunkId, side]);
  for (const run of source.runs) {
    for (const side of ["old", "new"] as const) {
      const range = side === "old" ? run.oldRange : run.newRange;
      const lines = side === "old" ? run.oldLines : run.newLines;
      if (!range) continue;
      const positions =
        available.get(sideKey(run.hunkId, side)) ?? new Set<number>();
      for (const [offset] of lines.entries()) {
        const line = range.startLine + offset;
        positions.add(line);
        changed.set(memberKey(run.hunkId, side, line), {
          hunkId: run.hunkId,
          side,
          line,
        });
      }
      available.set(sideKey(run.hunkId, side), positions);
    }
  }
  const nontext = new Set(
    source.limitations.flatMap((limitation) =>
      (limitation.kind === "binary" || limitation.kind === "metadata") &&
      limitation.hunkId !== null
        ? [limitation.hunkId]
        : [],
    ),
  );
  const knownHunks = new Set([
    ...source.runs.map((run) => run.hunkId),
    ...source.limitations.flatMap((limitation) =>
      limitation.hunkId === null ? [] : [limitation.hunkId],
    ),
  ]);
  const owned = new Set<string>();
  const ownedNontext = new Set<string>();
  const units: RangedResponsibilityUnit[] = [];
  const unitIds = new Set<string>();
  for (const unit of proposed) {
    if (unitIds.has(unit.unitId))
      throw failure(
        "duplicate-unit",
        "Unit identity appears twice",
        unit.unitId,
      );
    if (unit.revisionId !== source.revisionId)
      throw failure(
        "revision",
        "Unit belongs to another submitted revision",
        unit.unitId,
      );
    unitIds.add(unit.unitId);
    const responsibility = canonicalScope(unit.responsibility);
    for (const member of responsibility.members) {
      if (!knownHunks.has(member.hunkId))
        throw failure(
          "foreign-hunk",
          "Member is outside the retained source",
          unit.unitId,
          member.hunkId,
        );
      if (member.kind === "whole-nontext") {
        if (!nontext.has(member.hunkId))
          throw failure(
            "member-kind",
            "Whole ownership requires retained nontext source",
            unit.unitId,
            member.hunkId,
          );
        if (ownedNontext.has(member.hunkId))
          throw failure(
            "overlap",
            "Nontext obligation already has an owner",
            unit.unitId,
            member.hunkId,
          );
        ownedNontext.add(member.hunkId);
        continue;
      }
      const positions = available.get(sideKey(member.hunkId, member.side));
      if (!positions || member.lineCount > positions.size)
        throw failure(
          "context-line",
          "Range is outside changed source instances",
          unit.unitId,
          member.hunkId,
        );
      for (let offset = 0; offset < member.lineCount; offset++) {
        const line = member.startLine + offset;
        if (!positions.has(line))
          throw failure(
            "context-line",
            "Range includes context or unavailable source",
            unit.unitId,
            member.hunkId,
          );
        const key = memberKey(member.hunkId, member.side, line);
        if (owned.has(key))
          throw failure(
            "overlap",
            "Changed source instance already has an owner",
            unit.unitId,
            member.hunkId,
          );
        owned.add(key);
      }
    }
    units.push({ ...unit, responsibility });
  }
  const unallocated: ResponsibilityMember[] = [...changed.entries()]
    .filter(([key]) => !owned.has(key))
    .map<ResponsibilityMember>(([, member]) => ({
      kind: "changed-lines",
      hunkId: member.hunkId,
      side: member.side,
      startLine: member.line,
      lineCount: 1,
    }));
  for (const hunkId of nontext)
    if (!ownedNontext.has(hunkId))
      unallocated.push({ kind: "whole-nontext", hunkId });
  const [first, ...rest] = unallocated;
  const remainder =
    first === undefined
      ? []
      : canonicalScope({
          kind: "changed-ranges",
          members: [first, ...rest],
        }).members;
  return {
    repository: source.repository,
    revisionId: source.revisionId,
    mergeBaseRevisionId: source.mergeBaseRevisionId,
    snapshotKind: source.snapshotKind,
    workingTreeDirty: source.workingTreeDirty,
    submissionLimitations: source.submissionLimitations,
    units: units.sort((a, b) => order(a.unitId, b.unitId)),
    unallocated: remainder,
    sourceLimitations: source.limitations,
    changedInstances: changed.size,
    allocatedChangedInstances: owned.size,
    nontextObligations: nontext.size,
    allocatedNontextObligations: ownedNontext.size,
    allocationComplete:
      remainder.length === 0 &&
      !source.limitations.some(
        (value) =>
          value.kind === "missing-patch" || value.kind === "context-only",
      ),
  };
}
