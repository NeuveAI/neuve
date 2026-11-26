import { z } from "zod";
import { canonicalJson, sha256Hex } from "@neuve/records-core";
import { SECTION_IDENTITY_RECIPE } from "../section-identity.ts";
import type { ManifestHunk } from "../manifest.ts";
import { mapExclusion, type ReviewMap } from "../review-map.ts";
import {
  ReadingPlan,
  PlanGroup,
  packReadingSections,
  pairPlan,
  pairingBlobs,
  planReadings,
  type PlanInput,
  READING_TOO_LARGE,
  type PlanSection,
} from "./plan.ts";
import { PER_GROUP, PER_SECTION, ROW_TEXT } from "./pairing.ts";

/** A new execution contract, not a change to section or unit identity. */
export const ASSIGNMENT_RECIPE = "neuve-owned-readings-v1";
const Key = z.string().min(1);
const Batch = z.strictObject({
  /** Map group identity; the publisher retains its existing durable batch identity. */
  id: Key,
  hunkIds: z.array(Key),
  doneWhen: z.array(Key),
});
const Context = z.strictObject({
  /** The owned section this reference helps explain. */
  anchorKey: Key,
  /** Another changed section, read or unread. This is not another assignment. */
  sectionKey: Key,
  reason: z.string().trim().min(1),
  approval: z.literal("none"),
});
export const AssignmentGroup = PlanGroup.extend({
  batchId: Key,
  context: z.array(Context),
});
export type AssignmentGroup = z.infer<typeof AssignmentGroup>;

/**
 * Prepared ownership, not coverage evidence or a decision. Retained scope/proof/relation inputs,
 * prompts, schemas, offered tools and configuration must ALSO key the review computation. Neither
 * this recipe nor a group label alone identifies a completed investigation.
 *
 * The schema checks shape. Read retained input with `validateAssignments(value, hunks)` to check
 * actual changed-row coverage and membership against the immutable manifest as well.
 */
export const AssignmentPlan = z.strictObject({
  ...ReadingPlan.shape,
  recipe: z.literal(ASSIGNMENT_RECIPE),
  source: z.strictObject({ manifestKey: Key, frameKey: Key, mapKey: Key }),
  batches: z.array(Batch),
  groups: z.array(AssignmentGroup),
});
export type AssignmentPlan = z.infer<typeof AssignmentPlan>;

/** Historical plans remain readable; new runs must explicitly require AssignmentPlan. */
export const RetainedReadingPlan = z.union([AssignmentPlan, ReadingPlan]);
export type RetainedReadingPlan = z.infer<typeof RetainedReadingPlan>;
export const isAssignmentPlan = (
  plan: RetainedReadingPlan,
): plan is AssignmentPlan => plan.recipe === ASSIGNMENT_RECIPE;

export interface AssignmentInput extends PlanInput {
  readonly source: AssignmentPlan["source"];
  readonly batches: ReadonlyArray<
    Pick<ReviewMap["groups"][number], "id" | "hunkIds" | "doneWhen">
  >;
  readonly context?: ReadonlyArray<{
    readonly anchorKey: string;
    readonly sectionKey: string;
    readonly reason: string;
  }>;
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const fail: (message: string) => never = (message) => {
  throw new RangeError(`reading assignments: ${message}`);
};
const unique = (values: ReadonlyArray<string>, what: string) => {
  if (new Set(values).size !== values.length) fail(`duplicate ${what}`);
};

/** Sorted, merged intervals; overlapping ownership is always an error, even in one section. */
const intervals = (
  ranges: ReadonlyArray<{ startLine: number; endLine: number }>,
) => {
  const sorted = [...ranges].sort(
    (a, b) => a.startLine - b.startLine || a.endLine - b.endLine,
  );
  const result: Array<{ startLine: number; endLine: number }> = [];
  for (const range of sorted) {
    if (
      !Number.isSafeInteger(range.startLine) ||
      !Number.isSafeInteger(range.endLine) ||
      range.startLine < 1 ||
      range.endLine < range.startLine
    )
      fail("invalid owned range");
    const last = result.at(-1);
    if (last !== undefined && range.startLine <= last.endLine)
      fail("overlapping changed-row ownership");
    if (last !== undefined && range.startLine === last.endLine + 1)
      last.endLine = range.endLine;
    else result.push({ startLine: range.startLine, endLine: range.endLine });
  }
  return result;
};

/**
 * Fail closed on duplicate, omitted or invented rows, including unread sections. No row expansion:
 * a huge removal costs work proportional to its intervals, not to its number of lines.
 */
export const validateAssignments = (
  value: unknown,
  manifest: ReadonlyArray<ManifestHunk>,
): AssignmentPlan => {
  const plan = AssignmentPlan.parse(value);
  unique(
    manifest.map((hunk) => hunk.hunkId),
    "manifest hunk",
  );
  const hunks = new Map(manifest.map((hunk) => [hunk.hunkId, hunk]));
  const sections = [...plan.sections, ...plan.unread];
  const pathHunks = new Map<string, ManifestHunk[]>();
  for (const hunk of manifest)
    pathHunks.set(hunk.path, [...(pathHunks.get(hunk.path) ?? []), hunk]);
  const exclusions = new Map(
    [...pathHunks].map(([path, own]) => [path, mapExclusion(path, own)]),
  );
  // Repeating a source row under different hunk IDs must not create two primary owners.
  for (const own of pathHunks.values())
    for (const side of ["old", "new"] as const)
      intervals(
        own.flatMap((hunk) =>
          hunk.ownedRanges
            .filter((range) => range.side === side && range.lineCount > 0)
            .map((range) => ({
              startLine: range.startLine,
              endLine: range.startLine + range.lineCount - 1,
            })),
        ),
      );
  unique(
    sections.map((section) => section.key),
    "section key",
  );
  const byKey = new Map(sections.map((section) => [section.key, section]));
  const unread = new Map(plan.unread.map((section) => [section.key, section]));
  const excluded = new Set(
    plan.unread.filter((s) => s.cause === "excluded").flatMap((s) => s.hunkIds),
  );
  unique(
    plan.batches.map((batch) => batch.id),
    "batch identity",
  );
  const batchOf = new Map<string, string>();
  for (const batch of plan.batches) {
    unique(batch.doneWhen, "applicable requirement");
    for (const id of batch.hunkIds) {
      if (!hunks.has(id)) fail("batch names an unknown hunk");
      if (excluded.has(id)) fail("excluded hunk has batch ownership");
      if (batchOf.has(id)) fail("hunk belongs to more than one batch");
      batchOf.set(id, batch.id);
    }
  }
  for (const hunk of manifest) {
    if (!excluded.has(hunk.hunkId) && !batchOf.has(hunk.hunkId))
      fail("hunk has no batch owner");
    const members = sections.filter((section) =>
      section.hunkIds.includes(hunk.hunkId),
    );
    if (members.length === 0) fail("hunk has no section or explicit exclusion");
    if (hunk.kind !== "text" && members.length !== 1)
      fail("nontext hunk has more than one section");
    for (const side of ["old", "new"] as const) {
      const expected = intervals(
        hunk.ownedRanges
          .filter((r) => r.side === side && r.lineCount > 0)
          .map((r) => ({
            startLine: r.startLine,
            endLine: r.startLine + r.lineCount - 1,
          })),
      );
      const actual = intervals(
        members.flatMap((s) =>
          s.owned.filter((r) => r.hunkId === hunk.hunkId && r.side === side),
        ),
      );
      if (JSON.stringify(actual) !== JSON.stringify(expected))
        fail("changed rows are missing or invented");
    }
  }
  const sectionBatch = new Map<string, string>();
  for (const section of sections) {
    const cause = unread.get(section.key)?.cause;
    if ((exclusions.get(section.path) !== undefined) !== (cause === "excluded"))
      fail("section exclusion disagrees with manifest rules");
    if (cause === "unreadable" && section.kind !== "nontext")
      fail("readable section marked unreadable");
    if (cause === "too-large" && section.characters <= READING_TOO_LARGE)
      fail("bounded section marked too large");
    if (
      cause === undefined &&
      (section.kind === "nontext" || section.characters > READING_TOO_LARGE)
    )
      fail("unreadable or oversized section assigned");
    if (
      section.identity.key !== section.key ||
      section.key !==
        sha256Hex(
          canonicalJson([SECTION_IDENTITY_RECIPE, section.identity.parts]),
        ) ||
      section.identity.parts.path !== section.path ||
      section.identity.parts.kind !== section.kind ||
      section.identity.parts.name !== section.name
    )
      fail("section identity changed");
    const expectedSpan =
      section.identity.parts.side === "none" || section.identity.where === null
        ? null
        : { side: section.identity.parts.side, ...section.identity.where };
    if (canonicalJson(section.span) !== canonicalJson(expectedSpan))
      fail("section source span disagrees with identity");
    if (section.paired !== undefined) {
      if (section.paired.length > PER_SECTION)
        fail("pairing exceeds section context bound");
      unique(
        section.paired.map((row) => `${row.side}:${row.line}`),
        "pairing row",
      );
      for (const row of section.paired) {
        if (
          row.text.length > ROW_TEXT ||
          section.basis !== "graph-symbols" ||
          section.span === null ||
          row.side !== section.span.side ||
          row.line < section.span.startLine ||
          row.line > section.span.endLine
        )
          fail("pairing row is outside section source context");
        if (
          manifest.some(
            (hunk) =>
              hunk.path === section.path &&
              hunk.ownedRanges.some(
                (range) =>
                  range.side === row.side &&
                  range.startLine <= row.line &&
                  row.line < range.startLine + range.lineCount,
              ),
          )
        )
          fail("pairing row is changed work, not context");
      }
    }
    if (section.hunkIds.length === 0) fail("section has no source hunk");
    if (section.kind !== "nontext" && section.owned.length === 0)
      fail("text section owns no changed rows");
    unique(section.hunkIds, "section hunk");
    for (const id of section.hunkIds) {
      const hunk = hunks.get(id);
      if (hunk === undefined || hunk.path !== section.path)
        fail("section has an unknown source hunk or path");
    }
    const renamed = section.hunkIds
      .map((id) => hunks.get(id)!)
      .find((hunk) => hunk.status === "renamed");
    if (section.identity.renamedFrom !== (renamed?.oldPath ?? null))
      fail("renamed source disagrees with manifest");
    for (const range of section.owned) {
      if (!section.hunkIds.includes(range.hunkId))
        fail("owned range is outside section hunks");
    }
    const batches = new Set(section.hunkIds.map((id) => batchOf.get(id)));
    if (unread.get(section.key)?.cause === "excluded") {
      if (batches.size !== 1 || !batches.has(undefined))
        fail("excluded section has batch ownership");
    } else {
      if (batches.size !== 1 || batches.has(undefined))
        fail("section crosses batch ownership");
      sectionBatch.set(section.key, [...batches][0]!);
    }
  }
  unique(
    plan.groups.map((group) => group.id),
    "assignment identity",
  );
  const assigned = new Set<string>();
  for (const group of plan.groups) {
    if (group.keys.length === 0) fail("empty assignment");
    const members = group.keys.map((key) => {
      const section = byKey.get(key);
      if (section === undefined || unread.has(key))
        fail("assignment names an unknown or unread section");
      if (assigned.has(key))
        fail("section has more than one primary assignment");
      assigned.add(key);
      if (sectionBatch.get(key) !== group.batchId)
        fail("assignment crosses batch ownership");
      return section;
    });
    if (
      members.reduce((sum, section) => sum + (section.paired?.length ?? 0), 0) >
      PER_GROUP
    )
      fail("pairing exceeds final assignment context bound");
    const paths = [...new Set(members.map((s) => s.path))];
    const characters = members.reduce((sum, s) => sum + s.characters, 0);
    if (
      JSON.stringify(paths) !== JSON.stringify(group.paths) ||
      group.totals.files !== paths.length ||
      group.totals.items !== members.length ||
      group.totals.characters !== characters
    )
      fail("assignment totals do not match owned sections");
    if (
      paths.length > plan.bounds.maxFiles ||
      members.length > plan.bounds.maxItems ||
      (characters > plan.bounds.maxCharacters && members.length !== 1)
    )
      fail("assignment exceeds execution bounds");
    unique(
      group.context.map((ref) =>
        JSON.stringify([ref.anchorKey, ref.sectionKey, ref.reason]),
      ),
      "context reference",
    );
    for (const ref of group.context) {
      if (
        !group.keys.includes(ref.anchorKey) ||
        !byKey.has(ref.sectionKey) ||
        group.keys.includes(ref.sectionKey)
      )
        fail("context is not an attributed reference outside owned work");
    }
  }
  if (plan.sections.some((section) => !assigned.has(section.key)))
    fail("readable section has no primary assignment");
  return plan;
};

/** Inputs already prepared once by the source/structure/rule boundary. */
export type PreparedAssignmentInput = Pick<
  AssignmentInput,
  "hunks" | "batches" | "source" | "affinity" | "split" | "context"
> & {
  /**
   * Cached immutable texts for `pairingBlobs`, not another source-preparation pass. A caller
   * adopting a previously paired plan supplies these even if the old group bound left no rows
   * on a section. Pairing is recomputed only after FINAL assignment packing, so merged groups
   * remain bounded and split groups recover rows an old group clipped.
   *
   * Absent means unpaired planning. Already retained paired rows cannot be adopted without text.
   */
  readonly pairingTexts?: ReadonlyMap<string, string> | undefined;
};

/**
 * Reuse prepared sections verbatim; settle membership then pack each batch independently.
 * Source preparation, section identity and rule decisions remain owned by the existing planner.
 */
export const assignPreparedReadings = (
  prepared: ReadingPlan,
  input: PreparedAssignmentInput,
): AssignmentPlan => {
  const reading = ReadingPlan.parse(prepared);
  if (
    input.pairingTexts === undefined &&
    reading.sections.some((section) => section.paired !== undefined)
  )
    fail(
      "prepared pairing requires cached source texts for final assignment groups",
    );
  const hunks = new Map(input.hunks.map((hunk) => [hunk.hunkId, hunk]));
  const batches = input.batches
    .map((batch) => ({
      id: batch.id,
      hunkIds: [...batch.hunkIds].sort(compare),
      doneWhen: [...batch.doneWhen].sort(compare),
    }))
    .sort((a, b) => compare(a.id, b.id));
  const context = (input.context ?? [])
    .map((ref) => ({ ...ref, approval: "none" as const }))
    .sort(
      (a, b) =>
        compare(a.anchorKey, b.anchorKey) ||
        compare(a.sectionKey, b.sectionKey) ||
        compare(a.reason, b.reason),
    );
  const groups = batches.flatMap((batch) => {
    const ids = new Set(batch.hunkIds);
    return packReadingSections(
      reading.sections.filter((section) =>
        section.hunkIds.some((id) => ids.has(id)),
      ),
      hunks,
      reading.bounds,
      input,
    ).map((group) => ({
      ...group,
      batchId: batch.id,
      context: context.filter((ref) => group.keys.includes(ref.anchorKey)),
    }));
  });
  // Validate the prepared source before pairing reads it. Old paired rows are not authority:
  // they were clipped under obsolete groups and will be regenerated from the cached source.
  const unpaired = reading.sections.map(
    ({ paired: _paired, ...section }) => section,
  );
  validateAssignments(
    {
      ...reading,
      sections: unpaired,
      recipe: ASSIGNMENT_RECIPE,
      source: input.source,
      batches,
      groups,
    },
    input.hunks,
  );
  // Keep the legacy reading recipe on this rendering view; no assignment/reading recipe cast.
  const finalReading = ReadingPlan.parse({
    ...reading,
    sections: unpaired,
    groups: groups.map(
      ({ batchId: _batch, context: _context, ...group }) => group,
    ),
  });
  if (input.pairingTexts !== undefined)
    for (const blob of pairingBlobs(finalReading, hunks))
      if (!input.pairingTexts.has(blob))
        fail("missing cached pairing source text");
  const paired =
    input.pairingTexts === undefined
      ? finalReading
      : pairPlan(finalReading, hunks, input.pairingTexts);
  const plan = validateAssignments(
    {
      ...paired,
      recipe: ASSIGNMENT_RECIPE,
      source: input.source,
      batches,
      groups,
    },
    input.hunks,
  );
  // Invalid references must not vanish just because their purported owner was never assigned.
  if (
    context.some(
      (ref) =>
        !plan.groups.some((group) =>
          group.context.some(
            (entry) =>
              entry.anchorKey === ref.anchorKey &&
              entry.sectionKey === ref.sectionKey &&
              entry.reason === ref.reason.trim(),
          ),
        ),
    )
  )
    fail("context reference has no primary assignment");
  return plan;
};

/** Prepare an unpaired plan, then use the same assignment contract as stored prepared readings. */
export const planAssignments = (input: AssignmentInput): AssignmentPlan => {
  const pathHunks = new Map<string, ManifestHunk[]>();
  for (const hunk of input.hunks)
    pathHunks.set(hunk.path, [...(pathHunks.get(hunk.path) ?? []), hunk]);
  const excluded = [...pathHunks].flatMap(([path, own]) => {
    const reason = mapExclusion(path, own);
    return reason === undefined ? [] : [{ path, reason }];
  });
  return assignPreparedReadings(planReadings({ ...input, excluded }), input);
};

export interface AssignmentAnchor {
  readonly path: string;
  readonly side: "old" | "new";
  readonly startLine: number;
  readonly endLine: number;
}
export type AssignmentOwnership =
  | {
      readonly status: "owned";
      readonly assignmentId: string;
      readonly sectionKey: string;
      readonly batchId: string;
    }
  | {
      readonly status: "unassigned";
      readonly reason: "unknown" | "ambiguous" | "unread";
      readonly sectionKeys: ReadonlyArray<string>;
    };

/** Route a primary changed anchor, never contextual references; unknown/unread work stays explicit. */
export const assignmentOwner = (
  value: AssignmentPlan,
  anchor: AssignmentAnchor,
  manifest: ReadonlyArray<ManifestHunk>,
): AssignmentOwnership => {
  const plan = validateAssignments(value, manifest);
  const hunks = new Map(manifest.map((hunk) => [hunk.hunkId, hunk]));
  if (
    !Number.isSafeInteger(anchor.startLine) ||
    !Number.isSafeInteger(anchor.endLine) ||
    anchor.startLine < 1 ||
    anchor.endLine < anchor.startLine
  )
    fail("invalid primary anchor");
  const matches = (section: PlanSection) =>
    section.owned.some((range) => {
      const hunk = hunks.get(range.hunkId)!;
      const pathMatches =
        hunk.path === anchor.path ||
        (anchor.side === "old" &&
          hunk.status === "renamed" &&
          hunk.oldPath === anchor.path);
      return (
        pathMatches &&
        range.side === anchor.side &&
        range.startLine <= anchor.endLine &&
        anchor.startLine <= range.endLine
      );
    });
  const sections = [...plan.sections, ...plan.unread].filter(matches);
  const sectionKeys = sections.map((section) => section.key).sort(compare);
  if (sections.length !== 1)
    return {
      status: "unassigned",
      reason: sections.length === 0 ? "unknown" : "ambiguous",
      sectionKeys,
    };
  const sectionKey = sections[0]!.key;
  const group = plan.groups.find((candidate) =>
    candidate.keys.includes(sectionKey),
  );
  return group === undefined
    ? { status: "unassigned", reason: "unread", sectionKeys }
    : {
        status: "owned",
        assignmentId: group.id,
        sectionKey,
        batchId: group.batchId,
      };
};
