import { createHash } from "node:crypto";
import {
  HUNKS_PER_RANGE,
  REAL_SHARE,
  byCodepoint,
  isTunedFile,
} from "./policy.ts";

export interface DiffHunk {
  readonly path: string;
  /** Pre-image path; differs from `path` for renames, and is the only path of a deleted file. */
  readonly oldPath: string;
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly added: number;
  readonly deleted: number;
}

const HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Parses `git diff -U3` output into hunks with their added and deleted line counts. */
export const parseHunks = (diff: string): ReadonlyArray<DiffHunk> => {
  const hunks: Array<DiffHunk> = [];
  let oldPath = "";
  let newPath = "";
  let current: { -readonly [K in keyof DiffHunk]: DiffHunk[K] } | undefined;
  let inHeader = false;
  const flush = () => {
    if (current !== undefined) hunks.push(current);
    current = undefined;
  };
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flush();
      inHeader = true;
      continue;
    }
    if (inHeader) {
      if (line.startsWith("--- "))
        oldPath =
          line === "--- /dev/null" ? "" : line.slice(6).replace(/\t$/, "");
      else if (line.startsWith("+++ "))
        newPath =
          line === "+++ /dev/null" ? "" : line.slice(6).replace(/\t$/, "");
      else if (line.startsWith("rename from ")) oldPath = line.slice(12);
      else if (line.startsWith("rename to ")) newPath = line.slice(10);
      if (!line.startsWith("@@")) continue;
      inHeader = false;
    }
    const header = HEADER.exec(line);
    if (header !== null) {
      flush();
      current = {
        path: newPath || oldPath,
        oldPath: oldPath || newPath,
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        added: 0,
        deleted: 0,
      };
      continue;
    }
    if (current === undefined) continue;
    if (line.startsWith("+")) current.added++;
    else if (line.startsWith("-")) current.deleted++;
  }
  flush();
  return hunks;
};

const changed = (hunk: DiffHunk) => hunk.added + hunk.deleted;

/**
 * Up to four hunks spread across files: one per file in order of the file's changed lines (then
 * path), each file's largest hunk first (then position); further hunks round-robin when fewer than
 * four files changed. Returned in path and position order.
 */
export const selectHunks = (hunks: ReadonlyArray<DiffHunk>) => {
  const byFile = new Map<string, Array<DiffHunk>>();
  for (const hunk of hunks) {
    const list = byFile.get(hunk.path) ?? [];
    list.push(hunk);
    byFile.set(hunk.path, list);
  }
  const files = [...byFile.entries()]
    .map(([path, list]) => ({
      path,
      total: list.reduce((sum, hunk) => sum + changed(hunk), 0),
      queue: [...list].sort(
        (a, b) =>
          changed(b) - changed(a) ||
          a.oldStart - b.oldStart ||
          a.newStart - b.newStart,
      ),
    }))
    .sort((a, b) => b.total - a.total || byCodepoint(a.path, b.path));
  const picked: Array<DiffHunk> = [];
  while (
    picked.length < HUNKS_PER_RANGE &&
    files.some((file) => file.queue.length > 0)
  )
    for (const file of files) {
      const next = file.queue.shift();
      if (next !== undefined && picked.length < HUNKS_PER_RANGE)
        picked.push(next);
    }
  return picked.sort(
    (a, b) =>
      byCodepoint(a.path, b.path) ||
      a.oldStart - b.oldStart ||
      a.newStart - b.newStart,
  );
};

/** 9.17: the hunk's share of each model's window before the minimum, in tokens. */
export const computedShare = (hunkLines: number, reviewLines: number) => {
  const of = (window: number) =>
    Math.floor((window * REAL_SHARE.workingShare * hunkLines) / reviewLines);
  return { opus: of(REAL_SHARE.windows.opus), sol: of(REAL_SHARE.windows.sol) };
};

/** 9.17 with the 9.23 minimum applied after it. */
export const realShare = (hunkLines: number, reviewLines: number) => {
  const share = computedShare(hunkLines, reviewLines);
  return {
    opus: Math.max(REAL_SHARE.minimum, share.opus),
    sol: Math.max(REAL_SHARE.minimum, share.sol),
  };
};

export const describeHunk = (caseId: string, hunk: DiffHunk) => {
  const lines = changed(hunk);
  return {
    id: `h-${createHash("sha256")
      .update(
        `${caseId}\u0000${hunk.oldPath}\u0000${hunk.path}\u0000${hunk.oldStart},${hunk.oldLines}\u0000${hunk.newStart},${hunk.newLines}`,
      )
      .digest("hex")
      .slice(0, 12)}`,
    path: hunk.path,
    oldPath: hunk.oldPath,
    old: { start: hunk.oldStart, lines: hunk.oldLines },
    new: { start: hunk.newStart, lines: hunk.newLines },
    added: hunk.added,
    deleted: hunk.deleted,
    changedLines: lines,
    tunedFile: isTunedFile(hunk.path) || isTunedFile(hunk.oldPath),
  };
};
