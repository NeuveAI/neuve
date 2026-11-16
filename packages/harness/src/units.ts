import { posix } from "node:path";
import { estimateTokens } from "./budget.ts";
import type { ManifestHunk } from "./manifest.ts";
interface ProximityUnit {
  id: string;
  path: string;
  area: string;
  hunkIds: string[];
  changedLines: number;
  diffTokens: number;
}

/** AS1's unit rule: the unchanged gap within which hunks of one file join, and the size cap. */
export const UNIT_GAP_LINES = 20;
export const UNIT_MAX_CHANGED_LINES = 400;

/** The first and last changed line of a hunk on the new side (a deletion counts where it sits). */
export const changedSpan = (hunk: ManifestHunk) => {
  if (hunk.kind !== "text") return { first: 0, last: 0 };
  let line = hunk.newStart;
  let first: number | undefined;
  let last = hunk.newStart;
  for (const row of hunk.text.split("\n").slice(1)) {
    if (row === "" || row.startsWith("\\")) continue;
    if (row.startsWith("-")) {
      first ??= line;
      last = Math.max(last, line);
      continue;
    }
    if (row.startsWith("+")) {
      first ??= line;
      last = line;
    }
    line++;
  }
  return { first: first ?? hunk.newStart, last: Math.max(first ?? 0, last) };
};

/** The tokens of a hunk's diff as the agent sees it: its path line and the hunk with context (UN9). */
export const hunkTokens = (hunk: ManifestHunk) =>
  estimateTokens(Buffer.byteLength(`${hunk.path}\n${hunk.text}`));

/**
 * AS1's proximity units over one batch's hunks, in file order. `gap` is the unchanged-line gap
 * within which hunks join: 20 by default (10.59), and 10 and 40 for 10.70's telemetry.
 */
export const proximityUnits = (
  batchId: string,
  hunks: ReadonlyArray<ManifestHunk>,
  gap: number = UNIT_GAP_LINES,
): ReadonlyArray<ProximityUnit> => {
  const byFile = new Map<string, Array<ManifestHunk>>();
  for (const hunk of hunks)
    byFile.set(hunk.path, [...(byFile.get(hunk.path) ?? []), hunk]);
  const units: Array<ProximityUnit> = [];
  for (const path of [...byFile.keys()].sort()) {
    const sorted = [...(byFile.get(path) ?? [])].sort(
      (a, b) => changedSpan(a).first - changedSpan(b).first,
    );
    let current: Array<ManifestHunk> = [];
    let lines = 0;
    const flush = () => {
      if (current.length === 0) return;
      units.push({
        id: `${batchId}.u${units.length + 1}`,
        path,
        area: posix.dirname(path),
        hunkIds: current.map((hunk) => hunk.hunkId),
        changedLines: lines,
        diffTokens: current.reduce((sum, hunk) => sum + hunkTokens(hunk), 0),
      });
      current = [];
      lines = 0;
    };
    for (const hunk of sorted) {
      const changed = hunk.added + hunk.deleted;
      const previous = current.at(-1);
      const joins =
        previous !== undefined &&
        hunk.kind === "text" &&
        previous.kind === "text" &&
        changedSpan(hunk).first - changedSpan(previous).last - 1 <= gap &&
        lines + changed <= UNIT_MAX_CHANGED_LINES;
      if (!joins) flush();
      current.push(hunk);
      lines += changed;
    }
    flush();
  }
  return units;
};

/** The upper bracket of a unit group (10.60). */
export const GROUP_MAX_UNITS = 4;
