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
 * A plain line comparison of the two versions follows each of the anchor's lines into this one.
 *
 * - `stays`: the comparison carries every one of the anchor's lines across unchanged and still
 *   adjacent, and the quote is inside them. `lines` are those lines at their numbers here.
 * - `ambiguous`: not every line was carried, but the quote is still inside the lines that took
 *   the passage's place. The comment is shown at its section and marked, never as unchanged.
 * - `changed`: otherwise. `removed` are lines of the anchor's version and `added` lines of this
 *   one: what the comparison took out of the passage and what it put in its place.
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

/**
 * Which line of `after` each line of `before` became, by a longest common subsequence of the two
 * versions; -1 for a line the comparison took out. The shared start and end are matched first, so
 * the table covers only the lines between them.
 */
function carried(
  before: readonly FileLine[],
  after: readonly FileLine[],
): Int32Array {
  const map = new Int32Array(before.length).fill(-1);
  let head = 0;
  while (
    head < before.length &&
    head < after.length &&
    before[head]!.text === after[head]!.text
  )
    map[head] = head++;
  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail]!.text ===
      after[after.length - 1 - tail]!.text
  ) {
    map[before.length - 1 - tail] = after.length - 1 - tail;
    tail++;
  }
  const rows = before.length - head - tail;
  const columns = after.length - head - tail;
  const width = columns + 1;
  const lengths = new Uint32Array((rows + 1) * width);
  for (let i = rows - 1; i >= 0; i--)
    for (let j = columns - 1; j >= 0; j--)
      lengths[i * width + j] =
        before[head + i]!.text === after[head + j]!.text
          ? lengths[(i + 1) * width + j + 1]! + 1
          : Math.max(
              lengths[(i + 1) * width + j]!,
              lengths[i * width + j + 1]!,
            );
  for (let i = 0, j = 0; i < rows && j < columns;) {
    if (before[head + i]!.text === after[head + j]!.text)
      map[head + i++] = head + j++;
    else if (lengths[(i + 1) * width + j]! >= lengths[i * width + j + 1]!) i++;
    else j++;
  }
  return map;
}

/**
 * Places anchors made on the version whose text is `anchorText` on the version `current`. The
 * comparison of the two versions runs once, here; the function it returns places each anchor.
 * The anchor's own lines are followed from their version to this one by a plain line comparison,
 * so a line inserted above moves them and a copy of them elsewhere does not take them.
 */
export function fileLinesPlacer(
  anchorText: string,
  current: { hash: string; text: string },
): (anchor: FileLinesAnchor) => FileLinesPlacement {
  const { hash } = current;
  const before = fileLines(anchorText);
  const file = fileLines(current.text);
  const map = carried(before, file);
  const placed = new Set(map);
  return (anchor) => {
    if (hash === anchor.hash)
      return { kind: "stays", hash, lines: anchor.lines };
    const first = anchor.lines[0]!.line - 1;
    const last = anchor.lines.at(-1)!.line - 1;
    const targets = Array.from(
      { length: last - first + 1 },
      (_, offset) => map[first + offset]!,
    );
    if (
      targets.every(
        (target, offset) => target >= 0 && target === targets[0]! + offset,
      )
    ) {
      const lines = file.slice(targets[0]!, targets[0]! + targets.length);
      if (contains(lines, anchor.quote)) return { kind: "stays", hash, lines };
    }
    // The lines the comparison kept just before and just after the passage bound where it was.
    let previous = first - 1;
    while (previous >= 0 && map[previous]! < 0) previous--;
    let next = last + 1;
    while (next < before.length && map[next]! < 0) next++;
    const from = previous >= 0 ? map[previous]! + 1 : 0;
    const to = next < before.length ? map[next]! : file.length;
    const place = file.slice(from, to);
    // A quote counts as surviving only in the lines that took the passage's place, so a deleted
    // passage whose words occur elsewhere in the plan is changed, not ambiguous.
    if (contains(place, anchor.quote))
      return { kind: "ambiguous", hash, section: anchor.section };
    return {
      kind: "changed",
      hash,
      removed: before
        .slice(previous + 1, next)
        .filter((line) => map[line.line - 1]! < 0),
      added: place.filter((line) => !placed.has(line.line - 1)),
    };
  };
}

/** Where `anchor`, made on the version whose text is `anchorText`, sits on the version `current`. */
export function placeFileLinesAnchor(
  anchor: FileLinesAnchor,
  anchorText: string,
  current: { hash: string; text: string },
): FileLinesPlacement {
  return fileLinesPlacer(anchorText, current)(anchor);
}
