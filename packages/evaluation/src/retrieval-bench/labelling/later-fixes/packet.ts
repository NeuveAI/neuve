import { Effect } from "effect";
import type { Case } from "../../corpus.ts";
import { gitText } from "../../git.ts";
import {
  carryLine,
  changedOldLines,
  parseHeaders,
  type LaterFix,
} from "../../../harness-compare/full-test/later-fixes.ts";

/**
 * The decide-only packet for one later-commit item (9.65, 2.16): the reviewed hunk's lines at the
 * range head with about 40 lines of context, the later commit's message, and its diff of the file
 * with the changes to the hunk's lines marked. It is built from git alone; of the listing it uses
 * only what locates the item (case, commit, path, hunk lines, head lines changed), never its key,
 * ids or note, and no harness run, review, finding or gold grade.
 */

export const CONTEXT_LINES = 40;

/** The listing fields a packet may use; everything else in the listing stays out. */
export type Locator = Pick<
  LaterFix,
  "caseId" | "commit" | "path" | "hunkLines" | "headLinesChanged"
>;

const DIFF = ["diff", "--no-color", "--no-renames", "--no-ext-diff"] as const;

/** Numbered lines of a file excerpt, with the reviewed hunk's lines marked `>`. */
export const headExcerpt = (
  text: string,
  [start, end]: readonly [number, number],
  context = CONTEXT_LINES,
) => {
  const lines = text.endsWith("\n")
    ? text.slice(0, -1).split("\n")
    : text.split("\n");
  const first = Math.max(1, start - context);
  const last = Math.min(lines.length, end + context);
  const width = String(last).length;
  const out: Array<string> = [];
  for (let line = first; line <= last; line++)
    out.push(
      `${line >= start && line <= end ? ">" : " "} ${String(line).padStart(width)} | ${lines[line - 1] ?? ""}`,
    );
  return out.join("\n");
};

/**
 * A unified diff with each line's old and new numbers, and `◆` on the removed and added lines of
 * every change that touched one of `touched` (old-side lines, as `changedOldLines` counts them).
 * The changes come from the zero-context diff (`-U0`) of the same commit and file: the printed diff's
 * hunks carry context, which merges nearby changes and would mark changes that only sit near
 * a touched line.
 */
export const markedDiff = (
  diff: string,
  zeroContext: string,
  touched: ReadonlySet<number>,
) => {
  const own = parseHeaders(zeroContext);
  const touching = own.filter((hunk) =>
    hunk.oldLines > 0
      ? Array.from(
          { length: hunk.oldLines },
          (_, index) => hunk.oldStart + index,
        ).some((line) => touched.has(line))
      : touched.has(hunk.oldStart),
  );
  const inOld = (line: number) =>
    touching.some(
      (hunk) =>
        hunk.oldLines > 0 &&
        line >= hunk.oldStart &&
        line < hunk.oldStart + hunk.oldLines,
    );
  const inNew = (line: number) =>
    touching.some(
      (hunk) =>
        hunk.newLines > 0 &&
        line >= hunk.newStart &&
        line < hunk.newStart + hunk.newLines,
    );
  let oldLine = 0;
  let newLine = 0;
  let marked = 0;
  const out: Array<string> = [];
  for (const line of diff.split("\n")) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header !== null) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      out.push(line);
      continue;
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      const mark = inOld(oldLine) ? "◆" : " ";
      if (mark === "◆") marked++;
      out.push(`${mark} ${String(oldLine).padStart(5)}       ${line}`);
      oldLine++;
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      const mark = inNew(newLine) ? "◆" : " ";
      if (mark === "◆") marked++;
      out.push(`${mark}       ${String(newLine).padStart(5)} ${line}`);
      newLine++;
    } else if (line.startsWith(" ")) {
      out.push(
        `  ${String(oldLine).padStart(5)} ${String(newLine).padStart(5)} ${line}`,
      );
      oldLine++;
      newLine++;
    } else if (line !== "") out.push(line);
  }
  return { text: out.join("\n"), marked, touching: touching.length };
};

export const PACKET_TASK = [
  "# Does a later commit fix a defect in a reviewed change?",
  "",
  "A code change was reviewed (the reviewed change). Some time later, another commit changed some of the lines that the reviewed change had written. Decide whether that later commit fixes a defect that was already present in the reviewed change.",
  "",
  "- **fix**: the later commit corrects a defect that the reviewed change contained: a bug, wrong or missing behaviour, an error case it mishandled, a broken build or test, a security or data problem.",
  "- **not-a-fix**: the later commit is a feature change, a refactor, a rename or move, a cleanup, a style or wording change, a removal of code that was not wrong, or an adaptation to something that changed later. Changing the same lines is not enough to be a fix.",
  "- **unsure**: the material below does not let you tell.",
  "",
  "Judge only from this file. Give your answer and a short reason (one to three sentences) that names what was wrong, or why the change is not a correction.",
].join("\n");

/** The packet's `item.md` for one item, from git; throws when git cannot place the item. */
export const buildPacket = (
  repository: string,
  entry: Pick<Case, "head">,
  item: Locator,
) =>
  Effect.gen(function* () {
    const head = yield* gitText(repository, [
      "show",
      `${entry.head}:${item.path}`,
    ]);
    const forward = yield* gitText(repository, [
      ...DIFF,
      "-U0",
      entry.head,
      `${item.commit}^`,
      "--",
      item.path,
    ]);
    const own = yield* gitText(repository, [
      ...DIFF,
      "-U0",
      `${item.commit}^`,
      item.commit,
      "--",
      item.path,
    ]);
    const shown = yield* gitText(repository, [
      ...DIFF,
      `${item.commit}^`,
      item.commit,
      "--",
      item.path,
    ]);
    const message = yield* gitText(repository, [
      "log",
      "-1",
      "--format=%B",
      item.commit,
    ]);
    // The hunk's changed head lines, carried to the commit's parent as the listing carried them.
    const carried = parseHeaders(forward);
    const changed = changedOldLines(parseHeaders(own));
    const touched = new Set<number>();
    for (const line of item.headLinesChanged) {
      const at = carryLine(carried, line);
      if (at === null || !changed.has(at))
        throw new Error(
          `${item.path}:${line} does not carry to a line the commit changes`,
        );
      touched.add(at);
    }
    const diff = markedDiff(shown, own, touched);
    if (item.headLinesChanged.length > 0 && diff.touching === 0)
      throw new Error(
        `no change in the commit's diff of ${item.path} is marked`,
      );
    const text = [
      PACKET_TASK,
      "",
      `## 1. The reviewed change, in \`${item.path}\` as it stood after the reviewed change`,
      "",
      `Lines marked \`>\` (${item.hunkLines[0]}–${item.hunkLines[1]}) are the reviewed change's lines; the rest is surrounding context.`,
      "",
      "```",
      headExcerpt(head, item.hunkLines),
      "```",
      "",
      "## 2. The later commit's message",
      "",
      "```",
      message.trim(),
      "```",
      "",
      `## 3. The later commit's diff of \`${item.path}\``,
      "",
      "Each line shows its number before and after the commit. Lines marked `◆` belong to the commit's changes to lines the reviewed change had written; other changes in the file are shown for context. The file may have changed in other ways between the reviewed change and this commit.",
      "",
      "```",
      diff.text,
      "```",
      "",
    ].join("\n");
    return { text, marked: diff.marked, touching: diff.touching };
  });

/**
 * What a packet must never hold from the listing or the check's results: the item's key and ids,
 * its note, and any name of the results folder. Returns each leak found.
 */
export const packetLeaks = (
  text: string,
  item: Pick<LaterFix, "key" | "caseId" | "hunkId" | "itemId" | "note">,
) => {
  const word = (value: string) =>
    new RegExp(
      `(^|[^A-Za-z0-9_-])${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^A-Za-z0-9_-])`,
    );
  const leaks: Array<string> = [];
  for (const [field, value] of [
    ["key", item.key],
    ["caseId", item.caseId],
    ["hunkId", item.hunkId],
    ["itemId", item.itemId],
  ] as const)
    if (value !== "" && word(value).test(text)) leaks.push(field);
  if (item.note.trim() !== "" && text.includes(item.note.trim()))
    leaks.push("note");
  if (/full-test|later-fixes|harness-compare|sheet-answers/.test(text))
    leaks.push("results folder");
  return leaks;
};
