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
