// Shared inputs for the section pairing and section facts tests: hunks as Git prints them, from a
// line diff of two texts, with the owned ranges the review rules give (each side's runs of changed
// lines). Not a test file.
import { sha256Hex } from "@neuve/records-core";

import { hunkContentKey } from "../src/hunks.ts";
import type { ManifestHunk } from "../src/manifest.ts";

export const oidOf = (text: string) => sha256Hex(`blob\0${text}`).slice(0, 40);

const runs = (side: "old" | "new", lines: ReadonlyArray<number>) => {
  const out: Array<{
    side: "old" | "new";
    startLine: number;
    lineCount: number;
  }> = [];
  for (const line of lines) {
    const last = out.at(-1);
    if (last !== undefined && last.startLine + last.lineCount === line)
      last.lineCount++;
    else out.push({ side, startLine: line, lineCount: 1 });
  }
  return out;
};

/** A manifest hunk with the fields `sectionsOf` and the facts do not read filled in. */
export const manifestHunk = (
  fields: Pick<
    ManifestHunk,
    "path" | "text" | "oldStart" | "newStart" | "oldOid" | "newOid"
  > &
    Partial<ManifestHunk>,
): ManifestHunk => {
  const rows = fields.text.split("\n").slice(1);
  const oldLines: Array<number> = [];
  const newLines: Array<number> = [];
  let oldLine = fields.oldStart;
  let newLine = fields.newStart;
  for (const row of rows) {
    if (row === "" || row.startsWith("\\")) continue;
    if (row.startsWith("-")) oldLines.push(oldLine++);
    else if (row.startsWith("+")) newLines.push(newLine++);
    else {
      oldLine++;
      newLine++;
    }
  }
  // One cast, here only: the object names every field sections, identity and facts read, and
  // leaves out the hunk's leads, which are leaving the manifest hunk and which none of them reads.
  return {
    hunkId: `h${sha256Hex(`${fields.oldPath ?? fields.path}\0${fields.path}\0${fields.text}`).slice(0, 15)}`,
    contentKey: hunkContentKey({ path: fields.path, text: fields.text }),
    kind: "text",
    oldPath: fields.path,
    newPath: fields.path,
    status: "modified",
    oldMode: "100644",
    newMode: "100644",
    oldLines: oldLine - fields.oldStart,
    newLines: newLine - fields.newStart,
    added: newLines.length,
    deleted: oldLines.length,
    textSha256: sha256Hex(fields.text),
    enclosing: null,
    query: null,
    ownedRanges: [...runs("old", oldLines), ...runs("new", newLines)],
    qualifications: [],
    declared: [],
    countsTowardReviewLines: true,
    allowance: { tokens: 4_000, exactShare: 0, floored: true },
    ...fields,
  } as ManifestHunk;
};

/** The hunks of a line diff of two texts, with one line of context, as Git prints them. */
export const diff = (
  path: string,
  before: string,
  after: string,
  options: Partial<ManifestHunk> = {},
): ReadonlyArray<ManifestHunk> => {
  const a = before === "" ? [] : before.split("\n").slice(0, -1);
  const b = after === "" ? [] : after.split("\n").slice(0, -1);
  const lcs = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lcs[i]![j] =
        a[i] === b[j]
          ? lcs[i + 1]![j + 1]! + 1
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const ops: Array<{ sign: " " | "-" | "+"; text: string }> = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      ops.push({ sign: " ", text: a[i]! });
      i++;
      j++;
    } else if (
      j >= b.length ||
      (i < a.length && lcs[i + 1]![j]! >= lcs[i]![j + 1]!)
    ) {
      ops.push({ sign: "-", text: a[i]! });
      i++;
    } else {
      ops.push({ sign: "+", text: b[j]! });
      j++;
    }
  }
  // Line numbers of each op on each side, before the op.
  const positions: Array<{ old: number; new: number }> = [];
  let oldLine = 1;
  let newLine = 1;
  for (const op of ops) {
    positions.push({ old: oldLine, new: newLine });
    if (op.sign !== "+") oldLine++;
    if (op.sign !== "-") newLine++;
  }
  const changed = ops.flatMap((op, index) => (op.sign === " " ? [] : [index]));
  const groups: Array<[number, number]> = [];
  for (const index of changed) {
    const last = groups.at(-1);
    if (last !== undefined && index - last[1] <= 3) last[1] = index;
    else groups.push([index, index]);
  }
  return groups.map(([from, to]) => {
    const first = Math.max(0, from - 1);
    const rows = ops.slice(first, Math.min(ops.length, to + 2));
    const oldCount = rows.filter((row) => row.sign !== "+").length;
    const newCount = rows.filter((row) => row.sign !== "-").length;
    // As Git prints an empty side: the line before it.
    const oldStart =
      oldCount === 0 ? positions[first]!.old - 1 : positions[first]!.old;
    const newStart =
      newCount === 0 ? positions[first]!.new - 1 : positions[first]!.new;
    const text = `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n${rows
      .map((row) => `${row.sign}${row.text}`)
      .join("\n")}\n`;
    return manifestHunk({
      path,
      text,
      oldStart,
      newStart,
      oldOid: a.length === 0 ? null : oidOf(before),
      newOid: b.length === 0 ? null : oidOf(after),
      status:
        a.length === 0 ? "added" : b.length === 0 ? "deleted" : "modified",
      ...(a.length === 0 ? { oldPath: null, oldMode: null } : {}),
      ...(b.length === 0 ? { newPath: null, newMode: null } : {}),
      ...options,
    });
  });
};

/**
 * The fixture `sectionsOf` without structures is held to: replacements, pure removals, a renamed
 * file, an added file, a binary file, a mode change, and a hunk the review rules account
 * differently. Written once; the expected output was computed from `sections.ts` at `a96fc634`.
 */
export const unchangedFixture = (): ReadonlyArray<ManifestHunk> => [
  ...diff(
    "src/a.ts",
    "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\neleven\ntwelve\n",
    "one\n2\nthree\nfour\nfive\nsix\nseven\nnine\nten\nELEVEN\nELEVEN+\ntwelve\n",
  ),
  ...diff("src/gone.ts", "a\nb\nc\nd\n", "a\nd\n"),
  ...diff("src/new.ts", "", "x\ny\n"),
  ...diff("src/moved.ts", "keep\nold line\nkeep\n", "keep\nnew line\nkeep\n", {
    status: "renamed",
    oldPath: "src/was.ts",
  }),
  manifestHunk({
    path: "img/logo.png",
    kind: "binary",
    text: "Binary files a/img/logo.png and b/img/logo.png differ",
    oldStart: 0,
    newStart: 0,
    oldOid: oidOf("png-a"),
    newOid: oidOf("png-b"),
    ownedRanges: [{ side: "new", startLine: 1, lineCount: 1 }],
  }),
  manifestHunk({
    path: "bin/run.sh",
    kind: "metadata",
    text: "old mode 100644\nnew mode 100755",
    oldStart: 0,
    newStart: 0,
    oldOid: oidOf("run"),
    newOid: oidOf("run"),
    newMode: "100755",
    ownedRanges: [],
  }),
  {
    ...diff("src/odd.ts", "p\nq\nr\n", "p\nQ\nr\n")[0]!,
    ownedRanges: [{ side: "new", startLine: 2, lineCount: 1 }],
  },
];
