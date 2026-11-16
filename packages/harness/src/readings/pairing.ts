import type { ManifestHunk } from "../manifest.ts";

/**
 * Pairing rows (NEU-148 WP6, round 10): for a section whose change removes rows, the other lines of
 * the same declaration that name what a removed row named, shown beside the section with their line
 * numbers. A removed line that released something (a listener, a timer, a handle, a reader) pairs
 * with the line that set it up; without that line a reading shows the removal and nothing it pairs
 * with, and a claim check, which reads one section with no tools, cannot judge a claim about it.
 *
 * Decided by code alone, once, when the plan is stored (`pairPlan` in `plan.ts`), from the
 * commit's trees: the texts of the blobs the range's hunks name, never the working tree. Every step
 * of a group renders the stored plan, so Assess, Lane review, a re-read and a claim check of a
 * section show the same rows. A row says nothing about whether the removal is right.
 *
 * The rule, for one section:
 * - What the removal takes away. Each changed block of the section's hunks (a run of changed rows,
 *   as the reading shows them) contributes the names its removed rows (the section's own) name and
 *   its added rows do not: a pure removal gives every name it names, a replacement only the names
 *   it drops. A name is an identifier outside string literals and comments (`namesOf`), not a
 *   keyword or literal constant of a common language (`NOT_NAMES`), and not made of `_` and `$`
 *   alone.
 * - Where its pairs are. The section's own declaration: its span as the sections lane cut it
 *   (`PlanSection.span`), on its side. A removal inside a declaration that still exists is a
 *   section on the head side, so its rows come from the head blob, numbered there; a declaration
 *   that is gone is a section on the base side, so they come from the base blob. Only code is
 *   paired: a section cut by Graph's symbols (`graph-symbols`). A section with no span (no
 *   structure, a fallback) or cut by Markdown headings (prose, whose words are no names) gets
 *   none. The span, not the innermost symbol: a class stays one section, and a release in one
 *   method (a remove-listener in a teardown) pairs with a line of another (the add-listener in the
 *   setup); and a listener is often set up in an enclosing function and released in a closure it
 *   returns. Lines changed on that side by any of the range's hunks are never rows: a pairing row
 *   is always an unchanged line.
 * - Common names pair with nothing. A name that more than `COMMON_ROWS` of those lines name (a
 *   receiver, `err`, a field every line touches) is left out: it would pair with most of the
 *   declaration.
 * - Which rows. Every line of the declaration that names one of the remaining names, rarest first
 *   (a line naming a name few lines name comes before one naming a frequent name), then the line
 *   naming more of them, then the earlier line; at most `PER_SECTION`, shown in line order, each
 *   line's text clipped to `ROW_TEXT` UTF-16 code units between code points.
 * - Per group, at most `PER_GROUP` rows, given to the group's sections in reading order.
 */

/**
 * At most this many pairing rows per section. Measured (round 10): the deleted-line plant whose
 * set-up line ranks lowest (a timer's `setTimeout`, named on five lines of its function) needs five;
 * on ladder 25 six rows per section grow the largest reading by about 1,200 characters.
 */
export const PER_SECTION = 6;

/**
 * At most this many pairing rows per reading group, given in reading order: four full sections. No
 * group of ladder 25 reaches it; it bounds a group's growth to about 4,500 characters, under a tenth
 * of the default group bound (48,000), which the plan's sizes do not count the rows in.
 */
export const PER_GROUP = 24;

/**
 * A name more lines of the declaration than this name is common, and pairs with nothing. The plants'
 * set-up names are named on at most five lines of their declaration (a timer's ID); eight leaves
 * that margin, and every value from six to twelve gave ladder 25 the same rows.
 */
export const COMMON_ROWS = 8;

/** A pairing row's text at most, in UTF-16 code units, cut between code points. */
export const ROW_TEXT = 160;

/** One pairing row: a line of the section's declaration on its side, and its text there. */
export interface PairedRow {
  readonly side: "old" | "new";
  readonly line: number;
  readonly text: string;
}

/**
 * Words that are never names here: the keywords and literal constants of the languages the reviews
 * read most (TypeScript and JavaScript, Go, Python, Rust, Java, C and C#, Ruby, Shell), and a
 * declaration's reference to itself (`this`, `self`, `super`). A built-in function or type (`len`,
 * `open`, `string`) is a name like any other: the common-name rule takes it out where many lines
 * name it, and keeps it where few do.
 */
export const NOT_NAMES: ReadonlySet<string> = new Set([
  // Shared and C-family
  "if",
  "else",
  "for",
  "while",
  "do",
  "switch",
  "case",
  "default",
  "break",
  "continue",
  "return",
  "goto",
  "try",
  "catch",
  "finally",
  "throw",
  "throws",
  "new",
  "delete",
  "class",
  "struct",
  "enum",
  "interface",
  "union",
  "extends",
  "implements",
  "import",
  "export",
  "from",
  "as",
  "in",
  "is",
  "of",
  "void",
  "static",
  "const",
  "public",
  "private",
  "protected",
  "internal",
  "final",
  "abstract",
  "override",
  "virtual",
  "readonly",
  "volatile",
  "extern",
  "sizeof",
  "typedef",
  "unsigned",
  "signed",
  "auto",
  "register",
  "using",
  "namespace",
  "package",
  "true",
  "false",
  "null",
  "this",
  "super",
  // TypeScript and JavaScript
  "let",
  "var",
  "function",
  "async",
  "await",
  "yield",
  "typeof",
  "instanceof",
  "keyof",
  "declare",
  "type",
  "undefined",
  "satisfies",
  "infer",
  "get",
  "set",
  "with",
  // Go
  "func",
  "defer",
  "go",
  "chan",
  "select",
  "range",
  "map",
  "fallthrough",
  "nil",
  "iota",
  // Python
  "def",
  "lambda",
  "pass",
  "elif",
  "except",
  "raise",
  "global",
  "nonlocal",
  "assert",
  "del",
  "not",
  "and",
  "or",
  "None",
  "True",
  "False",
  "self",
  "cls",
  // Rust
  "fn",
  "mut",
  "impl",
  "pub",
  "use",
  "mod",
  "crate",
  "match",
  "loop",
  "where",
  "trait",
  "dyn",
  "ref",
  "move",
  "unsafe",
  "Self",
  // Ruby and Shell
  "end",
  "begin",
  "rescue",
  "ensure",
  "unless",
  "until",
  "then",
  "fi",
  "esac",
  "done",
  "local",
]);

/** A row's code with its string literals and comments taken out. */
const codeOf = (text: string) =>
  text
    // A line that continues or ends a block comment.
    .replace(/^\s*\*(?:\s|\/|$).*$/, "")
    // String and character literals on one line, escapes included.
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, " ")
    // A block comment on one line, then a line comment of the C family.
    .replace(/\/\*.*?\*\//g, " ")
    .replace(/\/\/.*$/, "")
    // A comment that starts with `#` at the line's start or after white space.
    .replace(/(^|\s)#.*$/, "$1");

const IDENTIFIER = /[\p{L}_$][\p{L}\p{N}_$]*/gu;

/** The names a row's code names, each once, in order. */
export const namesOf = (text: string): Array<string> => {
  const out = new Set<string>();
  for (const [name] of codeOf(text).matchAll(IDENTIFIER))
    if (!NOT_NAMES.has(name) && /[^_$]/.test(name)) out.add(name);
  return [...out];
};

const clip = (text: string, limit: number) => {
  let out = "";
  for (const point of text) {
    if (out.length + point.length > limit) break;
    out += point;
  }
  return out;
};

/** What `sectionPairing` reads of a section: as the plan holds it. */
export interface PairingSection {
  /** How its boundaries were cut: only a declaration Graph's symbols cut is code to pair in. */
  readonly basis: string;
  readonly span: {
    readonly side: "old" | "new";
    readonly startLine: number;
    readonly endLine: number;
  } | null;
  readonly owned: ReadonlyArray<{
    readonly hunkId: string;
    readonly side: "old" | "new";
    readonly startLine: number;
    readonly endLine: number;
  }>;
  readonly hunkIds: ReadonlyArray<string>;
}

/** The limits of one section's rows; the defaults are the module's. */
export interface PairingLimits {
  readonly perSection: number;
  readonly common: number;
}

/** A hunk's rows with their marks and line numbers, counted as the reading counts them. */
const hunkRows = (hunk: ManifestHunk) => {
  const rows: Array<{
    readonly mark: "-" | "+" | " ";
    readonly old: number;
    readonly new: number;
    readonly text: string;
  }> = [];
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  for (const row of hunk.text.split("\n").slice(1)) {
    if (row.startsWith("\\") || row === "") continue;
    if (row.startsWith("-"))
      rows.push({
        mark: "-",
        old: oldLine++,
        new: newLine,
        text: row.slice(1),
      });
    else if (row.startsWith("+"))
      rows.push({
        mark: "+",
        old: oldLine,
        new: newLine++,
        text: row.slice(1),
      });
    else
      rows.push({
        mark: " ",
        old: oldLine++,
        new: newLine++,
        text: row.slice(1),
      });
  }
  return rows;
};

/**
 * The names the section's removal takes away: per changed block of its hunks, what its owned
 * removed rows name and the block's added rows do not.
 */
export const removedNames = (
  section: Pick<PairingSection, "owned" | "hunkIds">,
  hunks: ReadonlyMap<string, ManifestHunk>,
): Set<string> => {
  const out = new Set<string>();
  for (const hunkId of section.hunkIds) {
    const hunk = hunks.get(hunkId);
    if (hunk === undefined || hunk.kind !== "text") continue;
    const owns = (line: number) =>
      section.owned.some(
        (range) =>
          range.hunkId === hunkId &&
          range.side === "old" &&
          line >= range.startLine &&
          line <= range.endLine,
      );
    const rows = hunkRows(hunk);
    let at = 0;
    while (at < rows.length) {
      if (rows[at]!.mark === " ") {
        at++;
        continue;
      }
      const removed = new Set<string>();
      const added = new Set<string>();
      for (; at < rows.length && rows[at]!.mark !== " "; at++) {
        const row = rows[at]!;
        if (row.mark === "+")
          for (const name of namesOf(row.text)) added.add(name);
        else if (owns(row.old))
          for (const name of namesOf(row.text)) removed.add(name);
      }
      for (const name of removed) if (!added.has(name)) out.add(name);
    }
  }
  return out;
};

/** Every line a blob has changed in any of the range's text hunks, by blob. */
export const changedLines = (
  hunks: ReadonlyMap<string, ManifestHunk>,
): Map<string, Set<number>> => {
  const out = new Map<string, Set<number>>();
  const mark = (oid: string | null, line: number) => {
    if (oid === null) return;
    let held = out.get(oid);
    if (held === undefined) {
      held = new Set();
      out.set(oid, held);
    }
    held.add(line);
  };
  for (const hunk of hunks.values()) {
    if (hunk.kind !== "text") continue;
    for (const row of hunkRows(hunk))
      if (row.mark === "-") mark(hunk.oldOid, row.old);
      else if (row.mark === "+") mark(hunk.newOid, row.new);
  }
  return out;
};

/**
 * The blob a section's pairing rows are read from: its first hunk's blob on its span's side, for a
 * section cut by Graph's symbols that removes at least one row; null for any other.
 */
export const pairingBlob = (
  section: PairingSection,
  hunks: ReadonlyMap<string, ManifestHunk>,
): string | null => {
  if (section.span === null || section.basis !== "graph-symbols") return null;
  if (!section.owned.some((range) => range.side === "old")) return null;
  const hunk = hunks.get(section.hunkIds[0] ?? "");
  if (hunk === undefined || hunk.kind !== "text") return null;
  return (section.span.side === "new" ? hunk.newOid : hunk.oldOid) ?? null;
};

/**
 * One section's pairing rows by the rule (see the module comment), before the group's bound: none
 * when it removes no row, is not code cut by Graph's symbols, or its blob's text is not given.
 */
export const sectionPairing = (
  section: PairingSection,
  hunks: ReadonlyMap<string, ManifestHunk>,
  /** Each blob's text, by object ID. */
  texts: ReadonlyMap<string, string>,
  /** Every changed line by blob (`changedLines`), computed once per range. */
  changed: ReadonlyMap<string, ReadonlySet<number>>,
  limits: PairingLimits = { perSection: PER_SECTION, common: COMMON_ROWS },
): Array<PairedRow> => {
  const blob = pairingBlob(section, hunks);
  const text = blob === null ? undefined : texts.get(blob);
  if (blob === null || text === undefined || section.span === null) return [];
  const { side, startLine, endLine } = section.span;
  const wanted = removedNames(section, hunks);
  if (wanted.size === 0) return [];
  const lines = text.split("\n");
  const skip = changed.get(blob) ?? new Set<number>();
  const candidates: Array<{ line: number; names: Array<string> }> = [];
  const count = new Map<string, number>();
  const last = Math.min(endLine, lines.length);
  for (let line = startLine; line <= last; line++) {
    if (skip.has(line)) continue;
    const names = namesOf(lines[line - 1]!).filter((name) => wanted.has(name));
    if (names.length === 0) continue;
    candidates.push({ line, names });
    for (const name of names) count.set(name, (count.get(name) ?? 0) + 1);
  }
  const kept = candidates.flatMap(({ line, names }) => {
    const own = names.filter((name) => count.get(name)! <= limits.common);
    return own.length === 0
      ? []
      : [
          {
            line,
            names: own.length,
            rarest: Math.min(...own.map((name) => count.get(name)!)),
          },
        ];
  });
  kept.sort(
    (a, b) => a.rarest - b.rarest || b.names - a.names || a.line - b.line,
  );
  return kept
    .slice(0, limits.perSection)
    .sort((a, b) => a.line - b.line)
    .map(({ line }) => ({
      side,
      line,
      text: clip(lines[line - 1]!, ROW_TEXT),
    }));
};

/**
 * A group's sections' rows under the group's bound: each section, in reading order, keeps its rows
 * while the group has room, and the first section past it keeps what is left. A section with none
 * is not in the result.
 */
export const groupPairing = <K>(
  ordered: ReadonlyArray<K>,
  rowsOf: (key: K) => ReadonlyArray<PairedRow>,
  perGroup: number = PER_GROUP,
): Map<K, Array<PairedRow>> => {
  const out = new Map<K, Array<PairedRow>>();
  let room = perGroup;
  for (const key of ordered) {
    if (room <= 0) break;
    const rows = rowsOf(key).slice(0, room);
    room -= rows.length;
    if (rows.length > 0) out.set(key, [...rows]);
  }
  return out;
};
