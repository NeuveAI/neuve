/**
 * A comment anchored to lines of one version of a text file, such as a plan. Beside the diff
 * anchor, and on the same principle: an anchor holds only where the stored text matches exactly.
 */

/** One line of a file version: its 1-based number and its exact text, without the line break. */
export type FileLine = { line: number; text: string };

export type FileLinesAnchor = {
  /** The version the comment was made on: the SHA-256 of the file's bytes, in lowercase hex. */
  hash: string;
  /** The consecutive lines the comment covers, in order, with their text in that version. */
  lines: FileLine[];
  /**
   * The words the person selected, as the screen showed them, inside those lines. It is compared
   * with lines' text with Markdown's inline marks and line prefixes left out and each run of
   * whitespace taken as one space, so rendered words match the file's text.
   */
  quote: string;
  /** The heading the first line sits under in that version, without its marks; empty when none. */
  section: string;
};

/**
 * Where an anchor sits on a later version of the file, found by content, not by line number.
 *
 * - `stays`: the anchor's lines occur, consecutive and with the same text, exactly once in the
 *   version, and the quote is inside them. `lines` are those lines at their numbers there.
 * - `changed`: the anchor's lines occur nowhere in the version and the quote occurs nowhere.
 *   `removed` are lines of the anchor's version and `added` lines of this one, from a plain
 *   line comparison of the two: what was taken out of the passage and what replaced it.
 * - `ambiguous`: the quote occurs in the version, but the anchor's lines do not occur exactly
 *   once. The comment is shown at its section and marked, never as unchanged.
 */
export type FileLinesPlacement =
  | { kind: "stays"; hash: string; lines: FileLine[] }
  | { kind: "changed"; hash: string; removed: FileLine[]; added: FileLine[] }
  | { kind: "ambiguous"; hash: string; section: string };

/** A file version's lines, 1-based, without their line breaks. */
export function fileLines(text: string): FileLine[] {
  return text
    .split(/\r?\n/)
    .map((line, index) => ({ line: index + 1, text: line }));
}

const LINE_PREFIX =
  /^\s*(?:>\s?)*\s*(?:#{1,6}\s+|(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)?/;
const LINK = /!?\[([^\]]*)\]\([^)]*\)/g;
const EMPHASIS = /(?<![\p{L}\p{N}])[*_]+|[*_]+(?![\p{L}\p{N}])/gu;
const CODE_OR_STRIKE = /`+|~~/g;

/**
 * Text as the plan tab shows it, for comparing a quote with a file's lines. This lane's rule, not
 * the design's: the design says the quote must match, and a selection on screen is rendered text,
 * so both sides are compared after leaving out each line's Markdown prefix (heading, list, task and
 * quotation marks), link targets, code and strike marks, and emphasis marks at a word's edge, and
 * after taking each run of whitespace as one space. A mark inside a word, as in `snake_case`, stays.
 */
export function plainText(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(LINE_PREFIX, "")
        .replace(LINK, "$1")
        .replace(CODE_OR_STRIKE, "")
        .replace(EMPHASIS, ""),
    )
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function contains(lines: readonly FileLine[], quote: string): boolean {
  const words = plainText(quote);
  return (
    words !== "" &&
    plainText(lines.map((line) => line.text).join("\n")).includes(words)
  );
}

/**
 * Whether `lines` are consecutive lines of `text` with exactly that text, and `quote` is inside
 * them: what the host checks before it keeps a comment.
 */
export function matchesFileLines(
  text: string,
  lines: readonly FileLine[],
  quote: string,
): boolean {
  const file = fileLines(text);
  return (
    lines.length > 0 &&
    lines.every(
      (line, index) =>
        line.line === lines[0]!.line + index &&
        file[line.line - 1]?.text === line.text,
    ) &&
    contains(lines, quote)
  );
}

/** The heading at or above `line`, as the plan tab shows it; empty when there is none. */
export function fileLinesSection(text: string, line: number): string {
  const file = fileLines(text).slice(0, line);
  const heading = file
    .reverse()
    .find((candidate) => /^\s*#{1,6}\s/.test(candidate.text));
  return heading ? plainText(heading.text.replace(/\s#+\s*$/, "")) : "";
}

/** Indices in `file` where `run` occurs as consecutive lines with the same text. */
function occurrences(
  file: readonly FileLine[],
  run: readonly FileLine[],
): number[] {
  const found: number[] = [];
  for (let start = 0; start + run.length <= file.length; start++)
    if (run.every((line, offset) => file[start + offset]!.text === line.text))
      found.push(start);
  return found;
}

/** Pairs of equal lines in a longest common subsequence of two versions, in order. */
function commonLines(
  before: readonly FileLine[],
  after: readonly FileLine[],
): Array<[number, number]> {
  const lengths = Array.from({ length: before.length + 1 }, () =>
    new Array<number>(after.length + 1).fill(0),
  );
  for (let i = before.length - 1; i >= 0; i--)
    for (let j = after.length - 1; j >= 0; j--)
      lengths[i]![j] =
        before[i]!.text === after[j]!.text
          ? lengths[i + 1]![j + 1]! + 1
          : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!);
  const pairs: Array<[number, number]> = [];
  for (let i = 0, j = 0; i < before.length && j < after.length;) {
    if (before[i]!.text === after[j]!.text) pairs.push([i++, j++]);
    else if (lengths[i + 1]![j]! >= lengths[i]![j + 1]!) i++;
    else j++;
  }
  return pairs;
}

/**
 * Where `anchor`, made on the version whose text is `anchorText`, sits on the version `current`.
 * Always computed from the anchor's own version, never from an earlier placement.
 */
export function placeFileLinesAnchor(
  anchor: FileLinesAnchor,
  anchorText: string,
  current: { hash: string; text: string },
): FileLinesPlacement {
  const { hash } = current;
  if (hash === anchor.hash) return { kind: "stays", hash, lines: anchor.lines };
  const file = fileLines(current.text);
  const found = occurrences(file, anchor.lines);
  if (found.length === 1) {
    const lines = file.slice(found[0]!, found[0]! + anchor.lines.length);
    if (contains(lines, anchor.quote)) return { kind: "stays", hash, lines };
  }
  if (found.length > 0 || contains(file, anchor.quote))
    return { kind: "ambiguous", hash, section: anchor.section };
  // The passage is gone: what the comparison took out around it, and what it put in its place.
  const before = fileLines(anchorText);
  const pairs = commonLines(before, file);
  const first = anchor.lines[0]!.line - 1;
  const last = anchor.lines.at(-1)!.line - 1;
  const previous = pairs.filter(([index]) => index < first).at(-1) ?? [-1, -1];
  const next = pairs.find(([index]) => index > last) ?? [
    before.length,
    file.length,
  ];
  const kept = new Set(pairs.map(([index]) => index));
  const placed = new Set(pairs.map(([, index]) => index));
  return {
    kind: "changed",
    hash,
    removed: before
      .slice(previous[0] + 1, next[0])
      .filter((line) => !kept.has(line.line - 1)),
    added: file
      .slice(previous[1] + 1, next[1])
      .filter((line) => !placed.has(line.line - 1)),
  };
}
