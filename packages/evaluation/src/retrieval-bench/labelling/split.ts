import type { BenchSplit } from "../split.ts";

/**
 * The split a labelling run works on (`--split dev|held-out`, default dev), from the benchmark's
 * one split mapping (`../split.ts`). One run's private area holds one split, so every command
 * refuses hunks and page items from the other.
 */
export {
  parseSplit as labellingSplit,
  type BenchSplit as LabellingSplit,
} from "../split.ts";

/** Refuses any entry outside the run's split, so splits never mix in one private area. */
export const checkSplit = <
  T extends { readonly id: string; readonly split: string },
>(
  entries: ReadonlyArray<T>,
  split: BenchSplit,
) => {
  const other = entries.find((entry) => entry.split !== split.name);
  if (other !== undefined)
    throw new Error(
      `${other.id} is ${other.split}; this run labels ${split.name} (--split ${split.name})`,
    );
  return entries;
};

/**
 * Held-out gold is scored once (9.58), so it is exported only whole: every expected hunk key
 * (`caseId#hunkId`) must be present, and the error names the missing ones.
 */
export const checkComplete = (
  expected: ReadonlyArray<string>,
  present: ReadonlySet<string>,
  split: BenchSplit,
) => {
  const missing = expected.filter((key) => !present.has(key));
  if (missing.length > 0)
    throw new Error(
      `refusing a partial ${split.name} export: ${missing.length} of ${expected.length} hunks missing: ${missing.join(", ")}`,
    );
};
