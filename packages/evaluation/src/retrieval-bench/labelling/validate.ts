import type { Case } from "../corpus.ts";
import type { Grade, HunkPool, LabelItem, LabellerOutput } from "./schema.ts";

/**
 * Checks one labeller's output against the hunk's pool and the case (brief, changes 4, 5, 7 and 8):
 * every candidate graded exactly once, regions that exist, and each item placed where the benchmark
 * may use it. Errors reject the output; warnings are kept for the owner.
 */

export type Availability =
  | "base-committed"
  | "base-same-batch"
  | "base-partly-same-batch"
  | "range-doc-scope"
  | "range-doc-hindsight"
  | "range-doc-other"
  | "range-change"
  | "commit-earlier"
  | "commit-in-range"
  | "commit-later"
  | "unknown";

export interface CheckedItem {
  readonly index: number;
  readonly item: LabelItem;
  readonly availability: Availability;
  readonly problems: ReadonlyArray<string>;
  /** 9.59: the item's region is on a binary or line-less file, so it is set aside with a warning. */
  readonly dropped: boolean;
}

export interface Lookups {
  /** Line count of a base path, or undefined when the path is not in the base. */
  readonly baseLines: (path: string) => number | undefined;
  /** Changed base lines of the range inside a span. */
  readonly changedBaseLines: (
    path: string,
    start: number,
    end: number,
  ) => number;
  /** Changed head lines of the range inside a span of a file the range changes. */
  readonly changedHeadLines: (
    path: string,
    start: number,
    end: number,
  ) => number;
  /** Line count of a document added or edited in the range (its head version). */
  readonly rangeDocLines: (path: string) => number | undefined;
  /** Head line count of a file the range changes, or undefined when the range does not change it. */
  readonly rangeChangeLines: (path: string) => number | undefined;
  /** Whether the range changes the path as a binary file (`git diff --numstat` shows `-`). */
  readonly binaryInRange: (path: string) => boolean;
  /** Where a commit sits relative to the case, or undefined if it does not resolve. */
  readonly commitTiming: (
    sha: string,
  ) => "earlier" | "in-range" | "later" | undefined;
}

export interface Validation {
  readonly errors: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<string>;
  /** The grade each candidate received: the strongest item covering it, or irrelevant. */
  readonly grades: ReadonlyMap<string, Grade>;
  readonly items: ReadonlyArray<CheckedItem>;
}

/**
 * The files a range changes, from `git diff --numstat -z -M`: `changed` holds each head path (a
 * rename's new path), including changes with no text lines such as an added empty file; `binary`
 * holds the paths changed as binary files (`-` for both counts), a rename's old and new paths both.
 */
export const rangeChanges = (numstat: string) => {
  const changed = new Set<string>();
  const binary = new Set<string>();
  const fields = numstat.split("\0");
  for (let index = 0; index < fields.length; index++) {
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(fields[index]!);
    if (match === null) continue;
    const named =
      match[3] === ""
        ? [fields[++index] ?? "", fields[++index] ?? ""]
        : [match[3]!];
    const head = named.at(-1)!;
    if (head !== "") changed.add(head);
    if (match[1] === "-" && match[2] === "-")
      for (const path of named) if (path !== "") binary.add(path);
  }
  return { changed, binary };
};

/**
 * 9.59: labels may not cite a binary or line-less file. A base or range-change region on a file the
 * range changes as binary, or on a file with no lines, is dropped with a warning; the rest of the
 * output stands.
 */
const droppedRegion = (region: LabelItem["region"], lookups: Lookups) => {
  if (region.path === null) return null;
  if (region.source !== "base" && region.source !== "range-change") return null;
  if (lookups.binaryInRange(region.path)) return "a binary file";
  const lines =
    region.source === "base"
      ? lookups.baseLines(region.path)
      : lookups.rangeChangeLines(region.path);
  return lines === 0 ? "a file with no lines" : null;
};

const RANK: Record<Grade, number> = {
  necessary: 3,
  useful: 2,
  misleading: 1,
  irrelevant: 0,
};
export const strongest = (a: Grade, b: Grade) => (RANK[a] >= RANK[b] ? a : b);

export const validateOutput = (
  output: LabellerOutput,
  pool: HunkPool,
  entry: Case,
  lookups: Lookups,
): Validation => {
  const errors: Array<string> = [];
  const warnings: Array<string> = [];
  if (output.caseId !== pool.caseId || output.hunkId !== pool.hunkId)
    errors.push(
      `output is for ${output.caseId}/${output.hunkId}, pool is ${pool.caseId}/${pool.hunkId}`,
    );
  const known = new Set(pool.candidates.map((candidate) => candidate.id));
  const grades = new Map<string, Grade>();
  const inItems = new Set<string>();
  const items: Array<CheckedItem> = [];

  output.items.forEach((item, index) => {
    const dropped = droppedRegion(item.region, lookups);
    if (dropped !== null) {
      warnings.push(
        `item ${index}: dropped, ${item.region.source} region ${item.region.path} is on ${dropped} (9.59)`,
      );
      items.push({
        index,
        item,
        availability: "unknown",
        problems: [],
        dropped: true,
      });
      return;
    }
    const problems: Array<string> = [];
    for (const id of item.candidateIds) {
      if (!known.has(id)) problems.push(`unknown candidate ${id}`);
      else {
        inItems.add(id);
        grades.set(id, strongest(grades.get(id) ?? "irrelevant", item.grade));
      }
    }
    if (item.added !== (item.candidateIds.length === 0))
      problems.push("added must be true exactly when no candidate is covered");
    if (
      item.grade !== "misleading" &&
      (item.whyItApplies === null || item.checkBeforeDeciding === null)
    )
      problems.push(
        "necessary and useful items need why it applies and what to check",
      );
    if (item.grade === "misleading" && item.whyItMisleads === null)
      warnings.push(`item ${index}: misleading without a reason`);
    if (item.kind === "history" && item.historyTiming === null)
      warnings.push(`item ${index}: history item without timing`);

    let availability: Availability = "unknown";
    const region = item.region;
    if (region.source === "base") {
      const lines =
        region.path === null ? undefined : lookups.baseLines(region.path);
      if (
        region.path === null ||
        region.startLine === null ||
        region.endLine === null
      )
        problems.push("base region needs path and lines");
      else if (lines === undefined)
        problems.push(`${region.path} is not in the base`);
      else if (region.startLine > region.endLine || region.endLine > lines)
        problems.push(
          `${region.path}:${region.startLine}-${region.endLine} is outside the file (${lines} lines)`,
        );
      else {
        const changed = lookups.changedBaseLines(
          region.path,
          region.startLine,
          region.endLine,
        );
        const size = region.endLine - region.startLine + 1;
        availability =
          changed === 0
            ? "base-committed"
            : changed >= size
              ? "base-same-batch"
              : "base-partly-same-batch";
        if (size < 3)
          warnings.push(
            `item ${index}: ${size}-line region, check it is at least a call site (9.7)`,
          );
      }
    } else if (region.source === "range-doc") {
      const doc = entry.inRangeDocs.find(
        (candidate) => candidate.path === region.path,
      );
      if (doc === undefined || doc.status === "deleted")
        problems.push(
          `${region.path} is not a document added or edited in the range`,
        );
      else {
        availability =
          doc.class === "scope"
            ? "range-doc-scope"
            : doc.class === "hindsight"
              ? "range-doc-hindsight"
              : "range-doc-other";
        const lines = lookups.rangeDocLines(doc.path);
        if (
          region.startLine !== null &&
          region.endLine !== null &&
          lines !== undefined &&
          region.endLine > lines
        )
          problems.push(
            `${region.path}:${region.endLine} is past the end (${lines} lines)`,
          );
      }
    } else if (region.source === "range-change") {
      const lines =
        region.path === null
          ? undefined
          : lookups.rangeChangeLines(region.path);
      if (
        region.path === null ||
        region.startLine === null ||
        region.endLine === null
      )
        problems.push("range-change region needs path and head lines");
      else if (lines === undefined)
        problems.push(`${region.path} is not a file the range changes`);
      else if (region.startLine > region.endLine || region.endLine > lines)
        problems.push(
          `${region.path}:${region.startLine}-${region.endLine} is outside the head file (${lines} lines)`,
        );
      else if (
        lookups.changedHeadLines(
          region.path,
          region.startLine,
          region.endLine,
        ) === 0
      )
        problems.push(
          `${region.path}:${region.startLine}-${region.endLine} holds no line the range changes; label unchanged code by its base lines`,
        );
      else availability = "range-change";
    } else {
      const timing =
        region.commit === null
          ? undefined
          : lookups.commitTiming(region.commit);
      if (timing === undefined)
        problems.push(`commit ${region.commit} does not resolve`);
      else {
        availability =
          timing === "earlier"
            ? "commit-earlier"
            : timing === "in-range"
              ? "commit-in-range"
              : "commit-later";
        if (timing === "in-range")
          warnings.push(
            `item ${index}: the range's own commit ${region.commit} is scope (commit text), not an item (brief, change 10)`,
          );
        if (
          item.historyTiming !== null &&
          (item.historyTiming === "earlier") !== (timing === "earlier")
        )
          warnings.push(
            `item ${index}: history timing ${item.historyTiming} but the commit is ${timing}`,
          );
      }
    }
    if (item.added && availability === "range-doc-hindsight")
      warnings.push(
        `item ${index}: added hindsight document, kept for grading only`,
      );
    if (problems.length > 0)
      errors.push(...problems.map((problem) => `item ${index}: ${problem}`));
    items.push({ index, item, availability, problems, dropped: false });
  });

  const irrelevant = new Set<string>();
  for (const id of output.irrelevant) {
    if (!known.has(id)) errors.push(`irrelevant lists unknown candidate ${id}`);
    else if (inItems.has(id))
      errors.push(`${id} is both graded and listed irrelevant`);
    else if (irrelevant.has(id))
      errors.push(`${id} is listed irrelevant twice`);
    irrelevant.add(id);
    if (!grades.has(id)) grades.set(id, "irrelevant");
  }
  const missing = [...known].filter((id) => !grades.has(id));
  if (missing.length > 0)
    errors.push(`ungraded candidates: ${missing.join(", ")}`);
  return { errors, warnings, grades, items };
};
