import { createHash } from "node:crypto";
import type { z } from "zod";
import {
  graphImportStatementsAt,
  graphLeafAncestors,
  graphLeafFlags,
  graphLeafOpens,
  graphLeafPosition,
  graphLeafType,
  graphLeavesTouchingLines,
  type GraphFileTokens,
  type GraphImportBinding,
  type GraphImportStatement,
} from "@neuve/graph-client";
import type { ManifestHunk } from "./manifest.ts";
import type { ImportTargetAnswer, RelationSlice } from "./relations-slices.ts";
import type { SectionFactsResult } from "./section-facts.ts";
import type { SectionIdentity } from "./section-identity.ts";
import type { Section } from "./sections.ts";

/**
 * The section rules that read Graph's syntax leaves, import bindings and relation slices, and the
 * pattern families: pure functions from sections, hunks, blob bytes, tokens records and relations
 * answers to judgements. `sectionRulesOf` (`section-rules.ts`) joins the judgements in; nothing
 * here reads Git, Graph or the store. Absent inputs give nothing: no tokens, no judgement from the
 * token rules; no relations, none from `deletion-only`.
 *
 * Terms. A run is a maximal run of changed rows of one hunk with no context row inside; the runs of
 * a section are the runs holding a row it owns, read whole (rows other sections own included), so a
 * change split across two sections is judged as one. The leaves of a row are those
 * `graphLeavesTouchingLines` gives for its line on its side; a leaf's text is its bytes, sliced
 * from the blob's contents and compared as bytes.
 *
 * - `whitespace-only` and `comment-only`: a file present on both sides whose two blobs have tokens
 *   available. Directives are read where both records say Graph flags them and the flags reader
 *   gives every comment a boolean `directive`; then the compared sequence is every non-comment leaf
 *   with each directive in its place, and the file's directives must be the same in number and text
 *   on both sides (a flag set by position can change away from any run). Equal leaves are not
 *   enough, as the tree is not the compiler's, so the gaps between compared leaves are compared
 *   too: each keeps its kind (none, inline, newline), one holding any byte but a space or a line
 *   feed outside its comments is byte-identical, and the whitespace beside a directive is
 *   byte-identical (`runVerdict` says it all). `whitespace-only` holds when no token changed, every
 *   gap kept its kind and every comment is the same in its place; `comment-only` when only comments
 *   changed, none flagged as a directive, every gap kept its kind, and directives are read. A
 *   comment is counted once per section. Where directives are not read and a comment is in reach of
 *   a run (touching it, or in one of its compared stretches), `whitespace-only` is not evaluated, as
 *   the whitespace beside a directive cannot be checked. Unless a record declares its language
 *   free-form (`indentationSignificant` exactly `false`), a line's leading whitespace must be
 *   byte-identical: `true` says indentation is syntax, and `null` or an absent field says nothing,
 *   so the file is treated as if it were. Neither judges a
 *   section whose tokens changed, nor a language Graph does not declare for tokens. Both carry
 *   `indentationChanged`, say it in the statement, and carry fixed disclosures of what no leaf shows.
 * - `imports-only`: every non-comment leaf touching a changed row lies within the byte range of an
 *   import statement of its side, except a leaf of line feeds and carriage returns only (Go's
 *   statement-ending line feed, layout Graph models as a leaf), and every changed row touching no
 *   leaf is blank. Every binding of every statement that joins the comparison must fit its file: no
 *   whitespace in `imported` or `local`, and a `local` the file spells (not `localInferred`) among
 *   its blob's `identifierNames`; otherwise the rule is not evaluated (`binding-not-in-file`). A binding is its
 *   specifier, names and type-only mark, and where its statement sits: the ancestors hash of the
 *   statement's first leaf, so a statement moved into or out of a block is a removed and an added
 *   binding, and one with a new statement put before it is not. The bindings of the statements the
 *   section touches are compared as multisets, base against head; a touched statement's counterpart
 *   (the other side's statement starting on the line its first line corresponds to, where that line
 *   is unchanged anywhere in the file, by the file's line map) joins the comparison. A leaf touches
 *   every statement whose bytes hold it (Python's `import a, b` is one statement per module over
 *   the same bytes), and every statement starting on a counterpart line joins, each once. A directive comment on a changed row is a
 *   change; a prose comment is allowed.
 * - `deletion-only`: a section the facts call old-side-only, with what Graph's base read found; a
 *   removed symbol whose base callers are all matched by name only is recorded as such and is not
 *   counted as still called (`StillPointing`). Its result never depends on the callers.
 *
 * Read from the client's record: its `directivesFlagged` (`directivesFlaggedOf`), a leaf's
 * `directive` flag through `graphLeafFlags` (a boolean where the record says flagged, null
 * elsewhere; `isDirectiveFlag`), an import statement's `startByte` and `endByte`
 * (`importStatementBytes`) and the statements holding a leaf (`graphImportStatementsAt`). A record
 * that says `directivesFlagged` while the flags reader in use gives a comment no boolean
 * `directive` is taken as not flagged (`directivesReadable`). The stretch between compared leaves
 * is computed here from the bytes, not with `graphGapBefore`: it includes a left-out comment's own
 * bytes and a byte-order mark at the file's start, which the accessors leave out
 * (`comparedStretches` gives it for a test to set beside them).
 *
 * A blob with no record says why in `SectionTokensInput.notRead` (`blobTokens`'s gaps): a binary
 * blob, a submodule, a symlink or a tree is no text the rules apply to; any other gap (the engine
 * declares no tokens, Graph unavailable, a path Graph refuses, a blob over the size bound) makes
 * the token rules not evaluated, with the reason in the inputs.
 * - `sectionFamiliesOf`: sections whose changed leaves, identifiers replaced, hash alike.
 */

type Json = z.core.util.JSONType;

export const TOKEN_RULE_NAMES = [
  "whitespace-only",
  "comment-only",
  "imports-only",
  "deletion-only",
] as const;
export type TokenRuleName = (typeof TOKEN_RULE_NAMES)[number];

/** Reasons the token rules add; `contents-not-read` is the existing rules' own. */
export const TOKEN_RULE_REASONS = [
  // Tokens: no record given for a blob; a record unavailable (Graph's reason in the inputs); the
  // tree has errors; a leaf with the error flag touches a run.
  "tokens-not-read",
  "tokens-unavailable",
  "parse-errors",
  "error-leaf",
  // comment-only and imports-only: Graph does not flag directive comments for the file.
  "directives-not-flagged",
  // imports-only
  "imports-not-extracted",
  "file-deleted",
  // Graph gives the import statements no byte range: lines cannot tell an import from code.
  "import-ranges-not-given",
  // A comment Graph flags as a directive touches a changed row.
  "directive-comment-changed",
  "side-effect-import",
  "names-unknown",
  "removed-name-still-used",
  "removed-name-in-text",
  "unresolved",
  // A binding whose names hold whitespace, or whose spelled local name is no identifier of its
  // file: the record does not fit the file, so its names cannot be trusted.
  "binding-not-in-file",
  "package-not-nearest",
  "import-not-classified",
  "import-side-not-read",
  "import-file-not-read",
  "import-not-found",
  "import-classification-unavailable",
  // imports-only and deletion-only: no relations given, or the slice's base side is a gap.
  "relations-not-read",
  // deletion-only: Graph read the base, but not the section's file in it.
  "relations-file-not-read",
] as const;
export type TokenRuleReason =
  (typeof TOKEN_RULE_REASONS)[number] | "contents-not-read";

/** Why a blob has no tokens record (`BlobTokensGap` in `blob-tokens.ts`), and whether it may recover. */
export interface TokensGap {
  readonly reason: string;
  readonly retryable: boolean;
}

/** Gaps of blobs that are no text a token rule applies to: such a side gives no judgement. */
const NO_TEXT_GAPS: ReadonlySet<string> = new Set([
  "binary",
  "submodule",
  "symlink",
  "not-a-blob",
]);

/** Graph's tokens records, as `sectionRulesOf` takes them. */
export interface SectionTokensInput {
  /** Per blob object id, as the structures are keyed. */
  readonly byBlob: ReadonlyMap<string, GraphFileTokens>;
  /** Per blob object id with no record in `byBlob`: why none was read. Absent: not said. */
  readonly notRead?: ReadonlyMap<string, TokensGap>;
  /**
   * How a leaf's flags are read: `graphLeafFlags` when absent. A reader that knows the `directive`
   * flag before the client does (the tests) is given here. Whatever reader is in use must expose
   * `directive` wherever a record says `directivesFlagged`: one that drops the bit would hide every
   * directive, and the rules would take directives for prose.
   */
  readonly leafFlags?: (tokens: AvailableTokens, at: number) => LeafFlags;
}

/**
 * A leaf's flags as a reader gives them. The client will give `directive` as a boolean where the
 * engine declares the flag and null where it does not; a reader that has no `directive` at all
 * cannot tell a directive from prose.
 */
export type LeafFlags = Readonly<Record<string, boolean | null | undefined>>;

/** What the rules ask of Graph's relations; the wiring fills it from `Relations`. */
export interface SectionRelations {
  /** `Relations.importTarget` at that side's index. */
  readonly importTarget: (
    side: "base" | "head",
    path: string,
    specifier: string,
  ) => ImportTargetAnswer;
  /** The section's relation slice, by `Section.key`; undefined when none was cut. */
  readonly slice: (sectionKey: string) => RelationSlice | undefined;
  /**
   * Whether no other file named as `manifestPath` sits in a nearer ancestor folder of the
   * importer, in the head tree.
   */
  readonly manifestIsNearest: (
    importerPath: string,
    manifestPath: string,
  ) => boolean;
}

export interface TokenRulesInput {
  readonly tokens?: SectionTokensInput;
  /** Blob bytes by object id, where read. */
  readonly contents?: ReadonlyMap<string, Uint8Array>;
  readonly relations?: SectionRelations;
  /** Every hunk of the range (`sectionRulesOf` gives its own), for a file's line map. */
  readonly hunks?: ReadonlyArray<ManifestHunk>;
}

export interface TokenRuleOutcome {
  readonly rule: TokenRuleName;
  readonly result: "holds" | "not-held" | "not-evaluated";
  readonly reason: TokenRuleReason | null;
  readonly statement: string;
  readonly inputs: Record<string, Json>;
  readonly evidence: ReadonlyArray<string>;
}

export type AvailableTokens = GraphFileTokens & { status: "available" };

/**
 * Carried by both layout rules, as a relation slice carries its blind spots: what no leaf shows.
 */
export const LAYOUT_DISCLOSURE =
  "positions the program can observe (a line-number macro, a stack trace asserted in a test) change with layout, and no leaf shows it";
/** Carried by `comment-only` beside the position disclosure. */
export const PROSE_TOOLS_DISCLOSURE =
  "tools also read prose comments (documentation tools, example outputs, licence checkers), and the directive flag cannot see those";
/** Carried by both layout rules: what the gaps' kinds cannot tell. */
export const INDENTATION_DISCLOSURE =
  "where indentation carries meaning, a change of indentation that the tree accepts can still be refused by the language";

const EVIDENCE = {
  ranges: "section.ranges",
  text: "hunk.text",
  leaves: "tokens.leaves",
  imports: "tokens.imports",
  names: "tokens.identifierNames",
  bytes: "blob.bytes",
  oldOnly: "fact.old-side-only",
  importTarget: "relations.importTarget",
  manifest: "relations.manifestIsNearest",
  slice: "relations.slice.base",
} as const;

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

/** A truthy `directive` on a leaf's flags: the engine's additive flag, read before the client types it. */
export const isDirectiveFlag = (flags: LeafFlags) => flags.directive === true;

/**
 * Whether Graph flags directive comments for this record's language: its `directivesFlagged`,
 * exactly `true`. A record from an engine without the flag reads as false.
 */
export const directivesFlaggedOf = (tokens: AvailableTokens) =>
  tokens.directivesFlagged === true;

/**
 * Whether a line's leading whitespace must be byte-identical in this record's file: everywhere but
 * where the engine declares the language free-form (`indentationSignificant` exactly `false`).
 * `true` declares indentation syntax (Python today); `null`, or a record without the field, says
 * nothing either way, so the file is treated as if it were.
 */
export const indentationSignificantOf = (tokens: AvailableTokens) =>
  (tokens as { readonly indentationSignificant?: boolean | null })
    .indentationSignificant !== false;

/**
 * An import statement's byte range in the given bytes (the statement node's own, as a leaf's
 * position). The client always gives both; a record built without them has none.
 */
export const importStatementBytes = (
  statement: GraphImportStatement,
): { readonly startByte: number; readonly endByte: number } | undefined => {
  const value = statement as GraphImportStatement & {
    readonly startByte?: unknown;
    readonly endByte?: unknown;
  };
  return typeof value.startByte === "number" &&
    typeof value.endByte === "number"
    ? { startByte: value.startByte, endByte: value.endByte }
    : undefined;
};

// ---------------------------------------------------------------------------------------------
// Rows and runs.

interface Row {
  readonly side: "old" | "new";
  readonly line: number;
  readonly text: string;
}

interface Run {
  readonly removed: Array<Row>;
  readonly added: Array<Row>;
  /** The line each side's rows start at, or, with none on a side, the line they would sit before. */
  readonly oldAt: number;
  readonly newAt: number;
}

/** A text hunk's changed rows in runs: a context row ends a run; Git's marker row does not. */
const runsOf = (hunk: ManifestHunk): ReadonlyArray<Run> => {
  const runs: Array<Run> = [];
  if (hunk.kind !== "text") return runs;
  let current: Run | undefined;
  // Git names the line before an empty side.
  let oldLine = hunk.oldLines === 0 ? hunk.oldStart + 1 : hunk.oldStart;
  let newLine = hunk.newLines === 0 ? hunk.newStart + 1 : hunk.newStart;
  for (const row of hunk.text.split("\n").slice(1)) {
    if (row === "" || row.startsWith("\\")) continue;
    if (row.startsWith("-") || row.startsWith("+")) {
      if (current === undefined)
        runs.push(
          (current = {
            removed: [],
            added: [],
            oldAt: oldLine,
            newAt: newLine,
          }),
        );
      if (row.startsWith("-"))
        current.removed.push({
          side: "old",
          line: oldLine++,
          text: row.slice(1),
        });
      else
        current.added.push({
          side: "new",
          line: newLine++,
          text: row.slice(1),
        });
      continue;
    }
    current = undefined;
    oldLine++;
    newLine++;
  }
  return runs;
};

const ownedKeys = (section: Section, hunk: ManifestHunk) => {
  const owned = new Set<string>();
  for (const range of section.ranges)
    if (range.hunkId === hunk.hunkId)
      for (let at = 0; at < range.lineCount; at++)
        owned.add(`${range.side}:${range.startLine + at}`);
  return owned;
};

/** The section's rows and the runs that hold them, across its hunks. */
const sectionRows = (section: Section, hunks: ReadonlyArray<ManifestHunk>) => {
  const rows: Array<Row> = [];
  const runs: Array<Run> = [];
  for (const hunk of hunks) {
    const owned = ownedKeys(section, hunk);
    for (const run of runsOf(hunk)) {
      const mine = [...run.removed, ...run.added].filter((row) =>
        owned.has(`${row.side}:${row.line}`),
      );
      if (mine.length === 0) continue;
      rows.push(...mine);
      runs.push(run);
    }
  }
  return { rows, runs };
};

const isBlank = (text: string) => text.trim() === "";

/** The one blob the section's hunks name on a side (`blobOn` in `section-rules.ts`). */
const blobOn = (
  section: Section,
  hunks: ReadonlyArray<ManifestHunk>,
  side: "old" | "new",
) => {
  const blobs = new Set(
    hunks.map((hunk) => (side === "new" ? hunk.newOid : hunk.oldOid)),
  );
  if (blobs.size !== 1)
    throw new Error(
      `Section of ${section.path} has hunks naming different ${side} blobs`,
    );
  const [blob] = blobs;
  return blob ?? null;
};

// ---------------------------------------------------------------------------------------------
// Leaves.

/** One side's tokens and bytes, with the flags reader. */
interface SideRead {
  readonly blob: string;
  readonly tokens: AvailableTokens;
  readonly bytes: Uint8Array | undefined;
  readonly flags: (at: number) => LeafFlags;
  readonly reader: (tokens: AvailableTokens, at: number) => LeafFlags;
}

/** The leaves touching any of `lines`, each once, in source order. */
const leavesTouching = (
  tokens: AvailableTokens,
  lines: ReadonlyArray<number>,
): Array<number> => {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const found = new Set<number>();
  for (let at = 0; at < sorted.length;) {
    let end = at;
    while (end + 1 < sorted.length && sorted[end + 1] === sorted[end]! + 1)
      end++;
    const { from, to } = graphLeavesTouchingLines(
      tokens,
      sorted[at]!,
      sorted[end]!,
    );
    for (let leaf = from; leaf < to; leaf++) found.add(leaf);
    at = end + 1;
  }
  return [...found].sort((a, b) => a - b);
};

/** A leaf's bytes. Tokens that do not fit the contents given for their blob are a wiring error. */
const leafBytes = (side: SideRead, at: number) => {
  const { startByte, endByte } = graphLeafPosition(side.tokens, at);
  if (side.bytes === undefined)
    throw new Error(`No contents given for blob ${side.blob}`);
  if (endByte > side.bytes.byteLength)
    throw new Error(
      `Tokens of blob ${side.blob} do not fit the contents given for it`,
    );
  return side.bytes.subarray(startByte, endByte);
};

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.byteLength === b.byteLength && a.every((byte, at) => byte === b[at]);

const decoder = new TextDecoder();

// ---------------------------------------------------------------------------------------------
// whitespace-only and comment-only.

/** Graph's word on a blob's tokens, as an input; with no record, why none was read. */
const tokensState = (
  tokens: GraphFileTokens | undefined,
  gap?: TokensGap,
): Json =>
  tokens === undefined
    ? gap === undefined
      ? { status: "not-read" }
      : { status: "not-read", reason: gap.reason, retryable: gap.retryable }
    : tokens.status === "available"
      ? { status: "available", hasErrors: tokens.hasErrors }
      : {
          status: "unavailable",
          reason: tokens.reason,
          retryable: tokens.retryable,
          codes: [...tokens.codes],
        };

interface RuleContext {
  readonly section: Section;
  readonly hunks: ReadonlyArray<ManifestHunk>;
  readonly rows: ReadonlyArray<Row>;
  readonly runs: ReadonlyArray<Run>;
  readonly input: TokenRulesInput;
}

const sideRead = (
  input: TokenRulesInput,
  tokens: SectionTokensInput,
  blob: string,
): SideRead | undefined => {
  const record = tokens.byBlob.get(blob);
  if (record?.status !== "available") return undefined;
  const reader = tokens.leafFlags ?? graphLeafFlags;
  return {
    blob,
    tokens: record,
    bytes: input.contents?.get(blob),
    flags: (at) => reader(record, at),
    reader,
  };
};

const readable = new WeakMap<object, WeakMap<AvailableTokens, boolean>>();

/**
 * Whether directives can be told from prose in this blob: its record says Graph flags them, and the
 * flags reader in use gives every comment leaf a boolean `directive`. A record that says flagged
 * read through a reader that drops the bit is taken as not flagged.
 */
const directivesReadable = (read: SideRead): boolean => {
  let byRecord = readable.get(read.reader);
  if (byRecord === undefined)
    readable.set(read.reader, (byRecord = new WeakMap()));
  let known = byRecord.get(read.tokens);
  if (known === undefined) {
    known = directivesFlaggedOf(read.tokens);
    for (let at = 0; known && at < read.tokens.leaves.length; at++) {
      const flags = read.flags(at);
      if (flags.comment === true && typeof flags.directive !== "boolean")
        known = false;
    }
    byRecord.set(read.tokens, known);
  }
  return known;
};

/** One blob's compared sequence and line starts, read once per record, reader and mode. */
interface FileLayout {
  /** File leaf indices of every non-comment leaf, and of each directive where they are read. */
  readonly compared: ReadonlyArray<number>;
  /** A file leaf's place in `compared`. */
  readonly place: ReadonlyMap<number, number>;
  /** The directive leaves of the whole file, where they are read. */
  readonly directives: ReadonlyArray<number>;
  /** Byte offset of each line's start. */
  readonly lineStarts: ReadonlyArray<number>;
}

const layouts = new WeakMap<
  object,
  WeakMap<AvailableTokens, Map<string, FileLayout>>
>();

const layoutOf = (read: SideRead, directives: boolean): FileLayout => {
  let byRecord = layouts.get(read.reader);
  if (byRecord === undefined)
    layouts.set(read.reader, (byRecord = new WeakMap()));
  let modes = byRecord.get(read.tokens);
  if (modes === undefined) byRecord.set(read.tokens, (modes = new Map()));
  const mode = String(directives);
  const known = modes.get(mode);
  if (known !== undefined) return known;
  const compared: Array<number> = [];
  const place = new Map<number, number>();
  const found: Array<number> = [];
  for (let at = 0; at < read.tokens.leaves.length; at++) {
    const flags = read.flags(at);
    const directive =
      directives && flags.comment === true && isDirectiveFlag(flags);
    if (directive) found.push(at);
    if (flags.comment !== true || directive) {
      place.set(at, compared.length);
      compared.push(at);
    }
  }
  const bytes = read.bytes!;
  const lineStarts = [0];
  for (let at = 0; at < bytes.byteLength; at++)
    if (bytes[at] === 10) lineStarts.push(at + 1);
  const layout = { compared, place, directives: found, lineStarts };
  modes.set(mode, layout);
  return layout;
};

/** A side as the layout rules read it. */
interface LayoutSide extends SideRead {
  readonly layout: FileLayout;
  readonly bytes: Uint8Array;
}

type GapClass = "none" | "inline" | "newline";

/** The bytes between two consecutive compared leaves (or a file's ends), and what they hold. */
interface Stretch {
  readonly bytes: Uint8Array;
  readonly kind: GapClass;
  /** Its whitespace (the bytes outside comment leaves) holds only U+0020 and U+000A. */
  readonly plain: boolean;
  /** The bytes after its last line feed outside comments, to the next leaf: a line's leading whitespace. */
  readonly indentation: Uint8Array | null;
  /** How many comment leaves lie in it. */
  readonly comments: number;
  /** The compared leaves on either side of it; -1 at a file's end. */
  readonly left: number;
  readonly right: number;
  /** Where it lies in the file's bytes, end exclusive. */
  readonly startByte: number;
  readonly endByte: number;
}

/** The stretch before compared place `at` of a side (after its last leaf when `at` is the length). */
const stretchBefore = (side: LayoutSide, at: number): Stretch => {
  const { compared } = side.layout;
  const left = at > 0 ? compared[at - 1]! : -1;
  const right = at < compared.length ? compared[at]! : -1;
  const start = left === -1 ? 0 : graphLeafPosition(side.tokens, left).endByte;
  const end =
    right === -1
      ? side.bytes.byteLength
      : graphLeafPosition(side.tokens, right).startByte;
  if (end > side.bytes.byteLength || start > end)
    throw new Error(
      `Tokens of blob ${side.blob} do not fit the contents given for it`,
    );
  const bytes = side.bytes.subarray(start, end);
  // The leaves between two compared leaves are comments the comparison does not read.
  let plain = true;
  let cursor = start;
  // The last line feed outside every comment, and where the next leaf starts after it.
  let feed = -1;
  const last = right === -1 ? side.tokens.leaves.length : right;
  const starts: Array<number> = [];
  const outside = (from: number, to: number) => {
    for (let at = from; at < to; at++) {
      const byte = side.bytes[at];
      if (byte === 0x0a) feed = at;
      else if (byte !== 0x20) plain = false;
    }
  };
  for (let leaf = left + 1; leaf < last; leaf++) {
    const position = graphLeafPosition(side.tokens, leaf);
    outside(cursor, position.startByte);
    starts.push(position.startByte);
    cursor = Math.max(cursor, position.endByte);
  }
  outside(cursor, end);
  const next = feed === -1 ? end : (starts.find((at) => at > feed) ?? end);
  return {
    bytes,
    kind:
      bytes.byteLength === 0
        ? "none"
        : bytes.includes(0x0a)
          ? "newline"
          : "inline",
    plain,
    indentation: feed === -1 ? null : side.bytes.subarray(feed + 1, next),
    comments: last - left - 1,
    left,
    right,
    startByte: start,
    endByte: end,
  };
};

/**
 * Every stretch of a file as the layout rules compute it from the bytes, before each compared leaf
 * and after the last, read with the client's flags (`directives`: directive comments are compared
 * leaves). For a test to set beside `graphGapBefore` and `graphGapAfterLast`: where a stretch holds
 * no comment the two give the same bytes, kind and plainness, except that this one starts at the
 * file's first byte, a byte-order mark included.
 */
export const comparedStretches = (
  tokens: AvailableTokens,
  bytes: Uint8Array,
  directives: boolean,
): ReadonlyArray<
  Pick<
    Stretch,
    "kind" | "plain" | "comments" | "left" | "right" | "startByte" | "endByte"
  >
> => {
  const read: SideRead = {
    blob: "",
    tokens,
    bytes,
    flags: (at) => graphLeafFlags(tokens, at),
    reader: graphLeafFlags,
  };
  const side: LayoutSide = {
    ...read,
    bytes,
    layout: layoutOf(read, directives),
  };
  return Array.from({ length: side.layout.compared.length + 1 }, (_, at) => {
    const { kind, plain, comments, left, right, startByte, endByte } =
      stretchBefore(side, at);
    return { kind, plain, comments, left, right, startByte, endByte };
  });
};

/** The bytes directly before (`before`) or after a leaf, to the nearest leaf of any kind. */
const besideLeaf = (side: LayoutSide, at: number, before: boolean) => {
  const position = graphLeafPosition(side.tokens, at);
  if (before) {
    const start = at === 0 ? 0 : graphLeafPosition(side.tokens, at - 1).endByte;
    return side.bytes.subarray(start, position.startByte);
  }
  const end =
    at + 1 < side.tokens.leaves.length
      ? graphLeafPosition(side.tokens, at + 1).startByte
      : side.bytes.byteLength;
  return side.bytes.subarray(position.endByte, end);
};

type RunVerdict =
  | { readonly kind: "changed" }
  | { readonly kind: "error-leaf" }
  | {
      readonly kind: "same";
      /** Every leaf, comments included in their place, is the same on both sides. */
      readonly layoutOnly: boolean;
      readonly removed: number;
      readonly added: number;
      /** Comment leaves that differ: base leaves removed, head leaves added, pairs changed. */
      readonly differing: {
        readonly removed: ReadonlyArray<number>;
        readonly added: ReadonlyArray<number>;
        readonly changed: ReadonlyArray<readonly [number, number]>;
      };
      /** A gap's bytes after its last line feed differ between the sides. */
      readonly indentationChanged: boolean;
      /** A comment leaf touches the run or lies in one of its compared stretches. */
      readonly commentsInReach: boolean;
    };

/**
 * The run's places in a side's compared sequence: those of the compared leaves touching its rows,
 * or, with none, the place where its rows sit (the first compared leaf at or after their start).
 */
const regionOf = (
  side: LayoutSide,
  lines: ReadonlyArray<number>,
  anchor: number,
) => {
  const places = leavesTouching(side.tokens, lines).flatMap((at) => {
    const place = side.layout.place.get(at);
    return place === undefined ? [] : [place];
  });
  if (places.length > 0)
    return { from: places[0]!, to: places[places.length - 1]! + 1 };
  const line = lines.length > 0 ? Math.min(...lines) : anchor;
  const byte = side.layout.lineStarts[line - 1] ?? side.bytes.byteLength;
  const { compared } = side.layout;
  let low = 0;
  let high = compared.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (graphLeafPosition(side.tokens, compared[middle]!).startByte < byte)
      low = middle + 1;
    else high = middle;
  }
  return { from: low, to: low };
};

/**
 * One run's verdict. `directives`: both blobs' directives are read, so each directive is compared
 * in its place among the non-comment leaves, by type and text. The run changes no token when:
 * - the compared leaves on its removed rows and on its added rows are equal pairwise (tokens in
 *   type, text, ancestors and opens);
 * - every gap between consecutive compared leaves, from the one before the run to the one after it,
 *   keeps its kind (none, inline, newline); a gap whose whitespace holds any byte but a space or a
 *   line feed, on either side, is byte-identical; the whitespace directly before and after a
 *   directive is byte-identical;
 * - a leaf reaching a line outside the run's own rows equals its pair in type, text, ancestors and
 *   opens, and a comment that differs or has no pair lies wholly within the run's rows;
 * - two comment leaves paired carry the same directive flag; and no leaf has the error flag.
 */
const runVerdict = (
  base: LayoutSide,
  head: LayoutSide,
  run: Run,
  directives: boolean,
  indentationIsSyntax: boolean,
): RunVerdict => {
  const lines = {
    old: new Set(run.removed.map((row) => row.line)),
    new: new Set(run.added.map((row) => row.line)),
  };
  const removed = leavesTouching(base.tokens, [...lines.old]);
  const added = leavesTouching(head.tokens, [...lines.new]);
  if (
    removed.some((at) => base.flags(at).error === true) ||
    added.some((at) => head.flags(at).error === true)
  )
    return { kind: "error-leaf" };
  const within = (side: LayoutSide, own: ReadonlySet<number>, at: number) => {
    const { startLine, endLine } = graphLeafPosition(side.tokens, at);
    for (let line = startLine; line <= endLine; line++)
      if (!own.has(line)) return false;
    return true;
  };
  const isComment = (side: LayoutSide, at: number) =>
    side.flags(at).comment === true;
  const flagged = (side: LayoutSide, at: number) =>
    isDirectiveFlag(side.flags(at));
  const isDirective = (side: LayoutSide, at: number) =>
    directives && isComment(side, at) && flagged(side, at);
  const sameText = (a: number, b: number) =>
    graphLeafType(base.tokens, a) === graphLeafType(head.tokens, b) &&
    sameBytes(leafBytes(base, a), leafBytes(head, b));
  const sameTree = (a: number, b: number) =>
    sameText(a, b) &&
    graphLeafAncestors(base.tokens, a) === graphLeafAncestors(head.tokens, b) &&
    graphLeafOpens(base.tokens, a) === graphLeafOpens(head.tokens, b);
  const reachesOut = (a: number, b: number) =>
    !within(base, lines.old, a) || !within(head, lines.new, b);
  /** Two leaves in one place: a token's tree and text; a comment's text and flag, and its tree where it reaches out. */
  const samePlace = (a: number, b: number) => {
    const comment = isComment(base, a);
    if (comment !== isComment(head, b)) return false;
    if (!comment) return sameTree(a, b);
    if (flagged(base, a) !== flagged(head, b)) return false;
    return reachesOut(a, b) ? sameTree(a, b) : sameText(a, b);
  };
  const counts = {
    removed: removed.filter((at) => !isComment(base, at)).length,
    added: added.filter((at) => !isComment(head, at)).length,
  };
  // The compared leaves, in place.
  const was = regionOf(base, [...lines.old], run.oldAt);
  const is = regionOf(head, [...lines.new], run.newAt);
  if (was.to - was.from !== is.to - is.from) return { kind: "changed" };
  for (let at = 0; at < was.to - was.from; at++) {
    const a = base.layout.compared[was.from + at]!;
    const b = head.layout.compared[is.from + at]!;
    if (isDirective(base, a) !== isDirective(head, b) || !samePlace(a, b))
      return { kind: "changed" };
  }
  // The gaps, from the one before the run's first compared leaf to the one after its last.
  let indentationChanged = false;
  let commentsInReach =
    removed.some((at) => isComment(base, at)) ||
    added.some((at) => isComment(head, at));
  for (let at = 0; at <= was.to - was.from; at++) {
    const x = stretchBefore(base, was.from + at);
    const y = stretchBefore(head, is.from + at);
    if (x.comments + y.comments > 0) commentsInReach = true;
    if (x.kind !== y.kind) return { kind: "changed" };
    // Where indentation is syntax, a line's leading whitespace is part of the program.
    if (
      indentationIsSyntax &&
      (x.indentation !== null || y.indentation !== null) &&
      (x.indentation === null ||
        y.indentation === null ||
        !sameBytes(x.indentation, y.indentation))
    )
      return { kind: "changed" };
    if ((!x.plain || !y.plain) && !sameBytes(x.bytes, y.bytes))
      return { kind: "changed" };
    for (const [one, other, before] of [
      [x.left, y.left, false],
      [x.right, y.right, true],
    ] as const) {
      const edge = (one === -1) !== (other === -1);
      if (edge) return { kind: "changed" };
      if (one === -1) continue;
      const a = isDirective(base, one);
      if (a !== isDirective(head, other)) return { kind: "changed" };
      if (
        a &&
        !sameBytes(
          besideLeaf(base, one, before),
          besideLeaf(head, other, before),
        )
      )
        return { kind: "changed" };
    }
    if (
      x.indentation !== null &&
      y.indentation !== null &&
      !sameBytes(x.indentation, y.indentation)
    )
      indentationChanged = true;
  }
  const prose = (side: LayoutSide, leaves: ReadonlyArray<number>) =>
    leaves.filter((at) => isComment(side, at) && !isDirective(side, at));
  const gone = prose(base, removed);
  const come = prose(head, added);
  const sameProse = (a: number, b: number) =>
    flagged(base, a) === flagged(head, b) && sameText(a, b);
  let prefix = 0;
  while (
    prefix < gone.length &&
    prefix < come.length &&
    sameProse(gone[prefix]!, come[prefix]!)
  )
    prefix++;
  let suffix = 0;
  while (
    suffix < gone.length - prefix &&
    suffix < come.length - prefix &&
    sameProse(gone[gone.length - 1 - suffix]!, come[come.length - 1 - suffix]!)
  )
    suffix++;
  const kept = [
    ...gone.slice(0, prefix).map((a, at) => [a, come[at]!] as const),
    ...gone
      .slice(gone.length - suffix)
      .map((a, at) => [a, come[come.length - suffix + at]!] as const),
  ];
  if (kept.some(([a, b]) => reachesOut(a, b) && !sameTree(a, b)))
    return { kind: "changed" };
  const left = gone.slice(prefix, gone.length - suffix);
  const right = come.slice(prefix, come.length - suffix);
  if (
    left.some((at) => !within(base, lines.old, at)) ||
    right.some((at) => !within(head, lines.new, at))
  )
    return { kind: "changed" };
  const paired = Math.min(left.length, right.length);
  const layoutOnly =
    removed.length === added.length &&
    removed.every((a, at) => samePlace(a, added[at]!));
  return {
    kind: "same",
    layoutOnly,
    ...counts,
    differing: layoutOnly
      ? { removed: [], added: [], changed: [] }
      : {
          removed: left.slice(paired),
          added: right.slice(paired),
          changed: left
            .slice(0, paired)
            .map((a, at) => [a, right[at]!] as const),
        },
    indentationChanged,
    commentsInReach,
  };
};

const layoutRules = (context: RuleContext): Array<TokenRuleOutcome> => {
  const { section, hunks, rows, runs, input } = context;
  const tokens = input.tokens;
  if (tokens === undefined || rows.length === 0) return [];
  if (hunks.some((hunk) => hunk.kind !== "text")) return [];
  const blobs = {
    old: blobOn(section, hunks, "old"),
    new: blobOn(section, hunks, "new"),
  };
  if (blobs.old === null || blobs.new === null) return [];
  const records = {
    old: tokens.byBlob.get(blobs.old),
    new: tokens.byBlob.get(blobs.new),
  };
  const gaps = {
    old: records.old === undefined ? tokens.notRead?.get(blobs.old) : undefined,
    new: records.new === undefined ? tokens.notRead?.get(blobs.new) : undefined,
  };
  // A language Graph does not declare for tokens, or a side that is no text: the rules do not apply.
  if (
    [records.old, records.new].some(
      (record) =>
        record?.status === "unavailable" &&
        record.reason === "unsupported-language",
    ) ||
    [gaps.old, gaps.new].some(
      (gap) => gap !== undefined && NO_TEXT_GAPS.has(gap.reason),
    )
  )
    return [];
  const evidence = [
    EVIDENCE.ranges,
    EVIDENCE.text,
    EVIDENCE.leaves,
    EVIDENCE.bytes,
  ];
  const base: Record<string, Json> = {
    blobs: { old: blobs.old, new: blobs.new },
    tokens: {
      old: tokensState(records.old, gaps.old),
      new: tokensState(records.new, gaps.new),
    },
    runs: runs.length,
    ownedRows: rows.length,
  };
  const disclosure = [LAYOUT_DISCLOSURE, INDENTATION_DISCLOSURE];
  const commentDisclosure = [
    LAYOUT_DISCLOSURE,
    PROSE_TOOLS_DISCLOSURE,
    INDENTATION_DISCLOSURE,
  ];
  const both = (
    reason: TokenRuleReason,
    statement: string,
  ): Array<TokenRuleOutcome> =>
    (["whitespace-only", "comment-only"] as const).map((rule) => ({
      rule,
      result: "not-evaluated",
      reason,
      statement,
      inputs: {
        ...base,
        disclosure: rule === "comment-only" ? commentDisclosure : disclosure,
      },
      evidence,
    }));
  if (records.old === undefined || records.new === undefined) {
    const known = [gaps.old, gaps.new].flatMap((gap) =>
      gap === undefined ? [] : [gap],
    );
    if (known.length > 0) base.retryable = known.some((gap) => gap.retryable);
    return both(
      "tokens-not-read",
      `Graph's syntax leaves of a side of the file were not read${known.length === 0 ? "" : ` (${[...new Set(known.map((gap) => gap.reason))].join(", ")})`}`,
    );
  }
  if (
    records.old.status === "unavailable" ||
    records.new.status === "unavailable"
  ) {
    const unavailable = [records.old, records.new].flatMap((record) =>
      record.status === "unavailable" ? [record] : [],
    );
    const retryable = unavailable.some((record) => record.retryable);
    base.retryable = retryable;
    return both(
      "tokens-unavailable",
      `Graph gave no syntax leaves for a side of the file (${unavailable.map((record) => record.reason).join(", ")}${retryable ? "; a later read may give them" : ""})`,
    );
  }
  if (!input.contents?.has(blobs.old) || !input.contents.has(blobs.new))
    return both(
      "contents-not-read",
      "the bytes of a side of the file were not read",
    );
  if (records.old.hasErrors || records.new.hasErrors)
    return both(
      "parse-errors",
      "Graph's tree of a side of the file holds an error or missing node",
    );
  const reads = {
    old: sideRead(input, tokens, blobs.old)!,
    new: sideRead(input, tokens, blobs.new)!,
  };
  const flagged = {
    old: directivesReadable(reads.old),
    new: directivesReadable(reads.new),
  };
  base.directivesFlagged = flagged;
  base.directivesDeclared = {
    old: directivesFlaggedOf(records.old),
    new: directivesFlaggedOf(records.new),
  };
  const directives = flagged.old && flagged.new;
  const side = (read: SideRead): LayoutSide => ({
    ...read,
    bytes: read.bytes!,
    layout: layoutOf(read, directives),
  });
  const baseSide = side(reads.old);
  const headSide = side(reads.new);
  // A flag set by position can change without its comment touching a run: the file's directives
  // must be the same in number and text, or neither rule judges any section of it.
  if (directives) {
    const a = baseSide.layout.directives;
    const b = headSide.layout.directives;
    if (
      a.length !== b.length ||
      a.some(
        (leaf, at) =>
          !sameBytes(leafBytes(baseSide, leaf), leafBytes(headSide, b[at]!)),
      )
    )
      return [];
  }
  const indentationIsSyntax =
    indentationSignificantOf(records.old) ||
    indentationSignificantOf(records.new);
  base.indentationSignificant = indentationIsSyntax;
  const verdicts = runs.map((run) =>
    runVerdict(baseSide, headSide, run, directives, indentationIsSyntax),
  );
  // A section whose tokens changed gets neither rule.
  if (verdicts.some((verdict) => verdict.kind === "changed")) return [];
  if (verdicts.some((verdict) => verdict.kind === "error-leaf"))
    return both(
      "error-leaf",
      "a leaf Graph flags as an error touches a run of changed rows the section is in",
    );
  const same = verdicts.flatMap((verdict) =>
    verdict.kind === "same" ? [verdict] : [],
  );
  const sum = (pick: (verdict: (typeof same)[number]) => number) =>
    same.reduce((total, verdict) => total + pick(verdict), 0);
  // A comment leaf is counted once per section, whatever number of runs it touches.
  const gone = new Set(same.flatMap((verdict) => verdict.differing.removed));
  const come = new Set(same.flatMap((verdict) => verdict.differing.added));
  const changedPairs = new Map(
    same.flatMap((verdict) => verdict.differing.changed),
  );
  const comments = {
    added: come.size,
    removed: gone.size,
    changed: changedPairs.size,
  };
  const startsFirst = (read: SideRead, at: number) =>
    graphLeafPosition(read.tokens, at).startLine === 1;
  const inputs: Record<string, Json> = {
    ...base,
    leaves: {
      removed: sum((verdict) => verdict.removed),
      added: sum((verdict) => verdict.added),
    },
    comments,
    // A run whose comments differ only in their place among the tokens.
    commentsMoved: same.some(
      (verdict) =>
        !verdict.layoutOnly &&
        verdict.differing.removed.length +
          verdict.differing.added.length +
          verdict.differing.changed.length ===
          0,
    ),
    firstLineCommentChanged:
      [...gone, ...changedPairs.keys()].some((at) =>
        startsFirst(reads.old, at),
      ) ||
      [...come, ...changedPairs.values()].some((at) =>
        startsFirst(reads.new, at),
      ),
    indentationChanged: same.some((verdict) => verdict.indentationChanged),
  };
  const runsText = plural(runs.length, "run");
  // Said in the statement itself, so a reader who sees only the statement sees it.
  const indented =
    inputs.indentationChanged === true
      ? "; the indentation of a line changed"
      : "";
  if (same.every((verdict) => verdict.layoutOnly)) {
    // Without readable directives a comment is no compared leaf, so the whitespace beside it is
    // only kind-checked; a directive's place can then change unseen.
    if (!directives && same.some((verdict) => verdict.commentsInReach))
      return [
        {
          rule: "whitespace-only",
          result: "not-evaluated",
          reason: "directives-not-flagged",
          statement: `in the ${runsText} of changed rows the section is in, no token changed and every gap between tokens kept its kind${indented}, but a comment is in reach of the change and directives are not flagged on both sides, so the whitespace beside a directive cannot be checked`,
          inputs: { ...inputs, disclosure },
          evidence,
        },
      ];
    return [
      {
        rule: "whitespace-only",
        result: "holds",
        reason: null,
        statement: `in the ${runsText} of changed rows the section is in, no token changed and every gap between tokens kept its kind${indented}`,
        inputs: { ...inputs, disclosure },
        evidence,
      },
    ];
  }
  const counted = `comment leaves ${comments.added} added, ${comments.removed} removed and ${comments.changed} changed${inputs.commentsMoved === true ? ", and comments moved among the tokens" : ""}`;
  if (!directives)
    return [
      {
        rule: "comment-only",
        result: "not-evaluated",
        reason: "directives-not-flagged",
        statement: `in the ${runsText} of changed rows the section is in, no token outside comments changed and every gap between tokens kept its kind${indented} (${counted}), but directives are not flagged on both sides, so a directive cannot be told from prose`,
        inputs: { ...inputs, disclosure: commentDisclosure },
        evidence,
      },
    ];
  return [
    {
      rule: "comment-only",
      result: "holds",
      reason: null,
      statement: `in the ${runsText} of changed rows the section is in, only comments changed, none flagged as a directive, and every gap between tokens kept its kind${indented} (${counted})`,
      inputs: { ...inputs, disclosure: commentDisclosure },
      evidence,
    },
  ];
};

// ---------------------------------------------------------------------------------------------
// imports-only.

const WORD = "[\\p{L}\\p{N}_$]";
const wholeWord = (name: string) =>
  new RegExp(
    `(?<!${WORD})${name.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&")}(?!${WORD})`,
    "u",
  );

const answerJson = (answer: ImportTargetAnswer): Json => {
  switch (answer.kind) {
    case "file":
      return { kind: answer.kind, path: answer.path };
    case "declared-package":
      return {
        kind: answer.kind,
        name: answer.name,
        manifest: answer.manifest,
      };
    case "side-not-read":
      return {
        kind: answer.kind,
        gap: { gap: answer.gap.gap, tag: answer.gap.tag },
      };
    case "file-not-read":
      return {
        kind: answer.kind,
        reason: answer.reason,
        failures: [...answer.failures],
      };
    default:
      return { kind: answer.kind };
  }
};

const UNKNOWN_TARGET: Partial<
  Record<ImportTargetAnswer["kind"], TokenRuleReason>
> = {
  "not-classified": "import-not-classified",
  "side-not-read": "import-side-not-read",
  "file-not-read": "import-file-not-read",
  "not-found": "import-not-found",
  "classification-unavailable": "import-classification-unavailable",
};

/** A statement with its byte range, once every statement of a side is known to have one. */
interface PlacedStatement {
  readonly statement: GraphImportStatement;
  readonly startByte: number;
  readonly endByte: number;
  /**
   * Where it sits in Graph's tree: its first non-comment leaf's ancestors hash, the chain of node
   * types above it; null with no such leaf. Not the leaf's opens: a statement put in front of it
   * changes those, not where it sits.
   */
  readonly place: string | null;
}

const placedStatements = (
  read: SideRead,
): ReadonlyArray<PlacedStatement> | undefined => {
  const imports = read.tokens.imports;
  if (imports.status !== "extracted") return undefined;
  const placed: Array<PlacedStatement> = [];
  for (const statement of imports.statements) {
    const bytes = importStatementBytes(statement);
    if (bytes === undefined) return undefined;
    const first = leavesTouching(read.tokens, [statement.startLine]).find(
      (at) => {
        const position = graphLeafPosition(read.tokens, at);
        return (
          !read.flags(at).comment &&
          position.startByte >= bytes.startByte &&
          position.endByte <= bytes.endByte
        );
      },
    );
    placed.push({
      statement,
      ...bytes,
      place:
        first === undefined ? null : graphLeafAncestors(read.tokens, first),
    });
  }
  return placed;
};

const placedBy = new WeakMap<
  ReadonlyArray<PlacedStatement>,
  ReadonlyMap<GraphImportStatement, PlacedStatement>
>();

/**
 * Every statement whose bytes hold a leaf (`graphImportStatementsAt`). Several can: Python's
 * `import a, b` is one statement object per module, all sharing the statement node's lines and
 * bytes. The accessor's test (the leaf's bytes wholly inside the statement's) is the one this rule
 * made itself before, so the answer is the same.
 */
const holding = (
  read: SideRead,
  statements: ReadonlyArray<PlacedStatement>,
  at: number,
): ReadonlyArray<PlacedStatement> => {
  let byStatement = placedBy.get(statements);
  if (byStatement === undefined)
    placedBy.set(
      statements,
      (byStatement = new Map(
        statements.map((placed) => [placed.statement, placed]),
      )),
    );
  const known = byStatement;
  return graphImportStatementsAt(read.tokens, at).flatMap((statement) => {
    const placed = known.get(statement);
    return placed === undefined ? [] : [placed];
  });
};

interface BindingEntry {
  readonly specifier: string;
  readonly imported: string;
  readonly local: string;
  readonly typeOnly: boolean;
  readonly place: PlacedStatement["place"];
}

/** A binding's identity: its names, and where its statement sits in the tree. */
const bindingKey = (binding: BindingEntry) =>
  JSON.stringify([
    binding.specifier,
    binding.imported,
    binding.local,
    binding.typeOnly,
    binding.place,
  ]);

const entriesOf = (placed: PlacedStatement): Array<BindingEntry> =>
  placed.statement.bindings.map((binding: GraphImportBinding) => ({
    specifier: placed.statement.specifier,
    imported: binding.imported,
    local: binding.local,
    typeOnly: binding.typeOnly,
    place: placed.place,
  }));

const bindingJson = (binding: BindingEntry): Json => ({
  specifier: binding.specifier,
  imported: binding.imported,
  local: binding.local,
  typeOnly: binding.typeOnly,
  place: binding.place,
});

const loadsValue = (statement: GraphImportStatement) =>
  statement.sideEffectOnly ||
  statement.bindings.some((binding) => !binding.typeOnly);

/** Specifiers of statements that load a value, in file order, each once. */
const valueOrder = (statements: ReadonlyArray<GraphImportStatement>) => {
  const order: Array<string> = [];
  for (const statement of statements)
    if (loadsValue(statement) && !order.includes(statement.specifier))
      order.push(statement.specifier);
  return order;
};

/** Each side's unchanged line to the other side's line; undefined for a changed row. */
interface LineMap {
  readonly old: (line: number) => number | undefined;
  readonly new: (line: number) => number | undefined;
}

/**
 * The line map of one file pair, from all of its hunks: inside a hunk a context row maps one to one
 * and a changed row maps to nothing; a line outside every hunk maps by the running offset of the
 * hunks before it (new line = old line + added rows so far − removed rows so far).
 */
const lineMapOf = (hunks: ReadonlyArray<ManifestHunk>): LineMap => {
  const context = {
    old: new Map<number, number>(),
    new: new Map<number, number>(),
  };
  const changed = { old: new Set<number>(), new: new Set<number>() };
  // Each hunk's last line on each side (the line before an empty side), and its added minus removed.
  const spans: Array<{ oldLast: number; newLast: number; delta: number }> = [];
  for (const hunk of hunks) {
    if (hunk.kind !== "text") continue;
    let oldLine = hunk.oldLines === 0 ? hunk.oldStart + 1 : hunk.oldStart;
    let newLine = hunk.newLines === 0 ? hunk.newStart + 1 : hunk.newStart;
    let delta = 0;
    for (const row of hunk.text.split("\n").slice(1)) {
      if (row === "" || row.startsWith("\\")) continue;
      if (row.startsWith("-")) {
        changed.old.add(oldLine++);
        delta--;
      } else if (row.startsWith("+")) {
        changed.new.add(newLine++);
        delta++;
      } else {
        context.old.set(oldLine, newLine);
        context.new.set(newLine, oldLine);
        oldLine++;
        newLine++;
      }
    }
    spans.push({ oldLast: oldLine - 1, newLast: newLine - 1, delta });
  }
  const outside = (side: "old" | "new", line: number) => {
    let offset = 0;
    for (const span of spans)
      if ((side === "old" ? span.oldLast : span.newLast) < line)
        offset += span.delta;
    return side === "old" ? line + offset : line - offset;
  };
  const map = (side: "old" | "new") => (line: number) =>
    changed[side].has(line)
      ? undefined
      : (context[side].get(line) ?? outside(side, line));
  return { old: map("old"), new: map("new") };
};

const lineMaps = new WeakMap<
  ReadonlyArray<ManifestHunk>,
  Map<string, LineMap>
>();

/** The line map of the section's file pair, built once per file from every hunk given for it. */
const fileLineMap = (
  input: TokenRulesInput,
  own: ReadonlyArray<ManifestHunk>,
): LineMap => {
  const all = input.hunks ?? own;
  const pair = (hunk: ManifestHunk) =>
    JSON.stringify([hunk.oldPath ?? null, hunk.newPath ?? null, hunk.path]);
  const key = pair(own[0]!);
  let byFile = lineMaps.get(all);
  if (byFile === undefined) lineMaps.set(all, (byFile = new Map()));
  let map = byFile.get(key);
  if (map === undefined)
    byFile.set(
      key,
      (map = lineMapOf(all.filter((hunk) => pair(hunk) === key))),
    );
  return map;
};

/**
 * A non-comment leaf whose bytes are all line feeds and carriage returns: layout Graph models as a
 * leaf (Go's statement-ending line feed), not a token. It holds no code, so in `imports-only` it
 * need not lie within an import statement's bytes. A leaf of spaces or tabs is not exempt (string
 * and template whitespace can be leaves). Without the blob's bytes it is taken as a token; a leaf
 * of no bytes is one too.
 */
const isLayoutLeaf = (read: SideRead, at: number) => {
  if (read.bytes === undefined) return false;
  const { startByte, endByte } = graphLeafPosition(read.tokens, at);
  if (endByte > read.bytes.byteLength)
    throw new Error(
      `Tokens of blob ${read.blob} do not fit the contents given for it`,
    );
  if (endByte === startByte) return false;
  for (let byte = startByte; byte < endByte; byte++) {
    const value = read.bytes[byte];
    if (value !== 0x0d && value !== 0x0a) return false;
  }
  return true;
};

const importsRule = (context: RuleContext): Array<TokenRuleOutcome> => {
  const { section, hunks, rows, input } = context;
  const tokens = input.tokens;
  if (tokens === undefined || rows.length === 0) return [];
  if (hunks.some((hunk) => hunk.kind !== "text")) return [];
  const blobs = {
    old: blobOn(section, hunks, "old"),
    new: blobOn(section, hunks, "new"),
  };
  const owned = (["old", "new"] as const).filter((side) =>
    rows.some((row) => row.side === side),
  );
  // A side with no record for a reason other than not being text: whether its rows are imports is
  // not known, and the rule says so.
  const unread = owned.flatMap((side) => {
    const blob = blobs[side]!;
    const gap = tokens.byBlob.has(blob) ? undefined : tokens.notRead?.get(blob);
    return gap === undefined ? [] : [gap];
  });
  if (unread.some((gap) => NO_TEXT_GAPS.has(gap.reason))) return [];
  if (unread.length > 0)
    return [
      {
        rule: "imports-only",
        result: "not-evaluated",
        reason: "tokens-not-read",
        statement: `Graph's syntax leaves of a side the section owns rows on were not read (${[...new Set(unread.map((gap) => gap.reason))].join(", ")}), so whether its changed rows are imports is not known`,
        inputs: {
          blobs: { old: blobs.old, new: blobs.new },
          ownedRows: rows.length,
          tokens: Object.fromEntries(
            owned.map((side) => [
              side,
              tokensState(
                tokens.byBlob.get(blobs[side]!),
                tokens.notRead?.get(blobs[side]!),
              ),
            ]),
          ),
          retryable: unread.some((gap) => gap.retryable),
        },
        evidence: [EVIDENCE.ranges, EVIDENCE.leaves],
      },
    ];
  // Looked at only where every side it owns rows on has leaves and import statements.
  const reads = new Map<"old" | "new", SideRead>();
  for (const side of owned) {
    const read = sideRead(input, tokens, blobs[side]!);
    if (read === undefined || read.tokens.imports.status !== "extracted")
      return [];
    reads.set(side, read);
  }
  const statementsOf = (side: "old" | "new") => {
    const imports = reads.get(side)?.tokens.imports;
    return imports?.status === "extracted" ? imports.statements : [];
  };
  /**
   * The leaves touching a changed row: code (non-comment leaves that are tokens), comments, and
   * layout (non-comment leaves whose bytes are all whitespace, as Go's statement-ending line feeds).
   */
  const leavesOf = (row: Row) => {
    const read = reads.get(row.side)!;
    const leaves = leavesTouching(read.tokens, [row.line]);
    const comment = (at: number) => read.flags(at).comment === true;
    return {
      read,
      code: leaves.filter((at) => !comment(at) && !isLayoutLeaf(read, at)),
      comments: leaves.filter(comment),
      layout: leaves.filter((at) => !comment(at) && isLayoutLeaf(read, at)),
    };
  };
  // First by lines: every non-comment leaf on a changed row lies within an import statement's lines,
  // and a row touching no leaf is blank. Only such a section is looked at.
  let code = 0;
  for (const row of rows) {
    const found = leavesOf(row);
    if (found.code.length + found.comments.length === 0) {
      if (isBlank(row.text)) continue;
      return [];
    }
    code += found.code.length;
    for (const at of found.code) {
      const { startLine, endLine } = graphLeafPosition(found.read.tokens, at);
      if (
        !statementsOf(row.side).some(
          (statement) =>
            startLine >= statement.startLine && endLine <= statement.endLine,
        )
      )
        return [];
    }
  }
  if (code === 0) return [];

  const evidence = [
    EVIDENCE.ranges,
    EVIDENCE.text,
    EVIDENCE.leaves,
    EVIDENCE.imports,
    EVIDENCE.names,
    EVIDENCE.bytes,
    EVIDENCE.importTarget,
    EVIDENCE.manifest,
  ];
  const addedFile = blobs.old === null;
  const base: Record<string, Json> = {
    blobs: { old: blobs.old, new: blobs.new },
    ownedRows: rows.length,
    addedFile,
  };
  const outcome = (
    result: TokenRuleOutcome["result"],
    reason: TokenRuleReason | null,
    statement: string,
    extra: Record<string, Json> = {},
  ): Array<TokenRuleOutcome> => [
    {
      rule: "imports-only",
      result,
      reason,
      statement,
      inputs: { ...base, ...extra },
      evidence,
    },
  ];
  const noRanges = (side: "old" | "new") =>
    outcome(
      "not-evaluated",
      "import-ranges-not-given",
      `the changed rows the section owns lie on the lines of import statements, but Graph gives the ${side === "old" ? "base" : "head"} file's import statements no byte range, and lines cannot tell an import from code on its line`,
    );
  const placed = new Map<"old" | "new", ReadonlyArray<PlacedStatement>>();
  for (const side of owned) {
    const statements = placedStatements(reads.get(side)!);
    if (statements === undefined) return noRanges(side);
    placed.set(side, statements);
  }
  // Then by bytes: the rule applies only where every non-comment leaf on a changed row lies within
  // an import statement's own bytes.
  for (const row of rows) {
    const found = leavesOf(row);
    if (
      found.code.some(
        (at) => holding(found.read, placed.get(row.side)!, at).length === 0,
      )
    )
      return [];
  }
  const prefix =
    "every token on the changed rows the section owns lies within the bytes of an import statement";
  if (blobs.new === null)
    return outcome(
      "not-held",
      "file-deleted",
      `${prefix}, but the file is deleted`,
    );
  // The file's other side is read too: added bindings are told against the base file's imports,
  // removed ones against the head file's.
  for (const side of ["old", "new"] as const) {
    const blob = blobs[side];
    if (blob === null || reads.has(side)) continue;
    const record = tokens.byBlob.get(blob);
    const gap = record === undefined ? tokens.notRead?.get(blob) : undefined;
    base.tokens = {
      ...(base.tokens as object),
      [side]: tokensState(record, gap),
    };
    const name = side === "old" ? "base" : "head";
    if (record === undefined)
      return outcome(
        "not-evaluated",
        "tokens-not-read",
        `${prefix}, but Graph's leaves of the file's ${name} side were not read${gap === undefined ? "" : ` (${gap.reason})`}`,
        gap === undefined ? {} : { retryable: gap.retryable },
      );
    if (record.status === "unavailable")
      return outcome(
        "not-evaluated",
        "tokens-unavailable",
        `${prefix}, but Graph gave no leaves for the file's ${name} side (${record.reason})`,
      );
    if (record.imports.status !== "extracted")
      return outcome(
        "not-evaluated",
        "imports-not-extracted",
        `${prefix}, but Graph gave no import statements for the file's ${name} side`,
      );
    const read = sideRead(input, tokens, blob)!;
    const statements = placedStatements(read);
    if (statements === undefined) return noRanges(side);
    reads.set(side, read);
    placed.set(side, statements);
  }
  const head = reads.get("new")!;
  if (
    [...reads.values()].some((read) => read.tokens.hasErrors) ||
    rows.some((row) => {
      const found = leavesOf(row);
      return [...found.code, ...found.comments, ...found.layout].some(
        (at) => found.read.flags(at).error,
      );
    })
  )
    return outcome(
      "not-evaluated",
      "parse-errors",
      `${prefix}, but Graph's tree of a side holds an error or missing node`,
    );
  // Comments on a changed row: prose is allowed, a directive is a change a tool obeys, and where
  // directives are not flagged the two cannot be told apart.
  const commented = rows.flatMap((row) => {
    const found = leavesOf(row);
    return found.comments.map((at) => ({ read: found.read, at }));
  });
  if (
    commented.some(
      ({ read, at }) =>
        directivesReadable(read) && isDirectiveFlag(read.flags(at)),
    )
  )
    return outcome(
      "not-held",
      "directive-comment-changed",
      `${prefix}, but a comment Graph flags as a directive, which a tool obeys, touches a changed row`,
    );
  if (commented.some(({ read }) => !directivesReadable(read)))
    return outcome(
      "not-evaluated",
      "directives-not-flagged",
      `${prefix}, but a comment touches a changed row and Graph does not flag directives for the file, so it cannot be told from prose`,
    );
  const placedOf = (side: "old" | "new") => placed.get(side) ?? [];
  const touchedOn = (side: "old" | "new") => {
    const held = new Set<PlacedStatement>();
    for (const row of rows.filter((entry) => entry.side === side)) {
      const found = leavesOf(row);
      for (const at of found.code)
        for (const statement of holding(found.read, placedOf(side), at))
          held.add(statement);
    }
    return held;
  };
  const held = { old: touchedOn("old"), new: touchedOn("new") };
  // A touched statement's counterpart joins the comparison: the other side's statement that starts
  // on the line its first line corresponds to, where that line is unchanged anywhere in the file.
  // Every statement of the other side starting on that line is a counterpart, and a counterpart's
  // own counterparts join too, until none is new: each statement joins once.
  const unchanged = fileLineMap(input, hunks);
  const queue: Array<readonly ["old" | "new", PlacedStatement]> = [
    ...[...held.old].map((statement) => ["old", statement] as const),
    ...[...held.new].map((statement) => ["new", statement] as const),
  ];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const [side, statement] = next;
    const other = side === "old" ? "new" : "old";
    const line = unchanged[side](statement.statement.startLine);
    if (line === undefined) continue;
    for (const counterpart of placedOf(other))
      if (
        counterpart.statement.startLine === line &&
        !held[other].has(counterpart)
      ) {
        held[other].add(counterpart);
        queue.push([other, counterpart]);
      }
  }
  // In file order: by bytes, then as Graph listed them.
  const inOrder = (
    side: "old" | "new",
    statements: ReadonlySet<PlacedStatement>,
  ) => placedOf(side).filter((statement) => statements.has(statement));
  const touched = {
    old: inOrder("old", held.old),
    new: inOrder("new", held.new),
  };
  const touchedStatements = [...touched.old, ...touched.new].map(
    (entry) => entry.statement,
  );
  // A binding record that does not fit its file (a name cut from raw text, as `"os "` from
  // `import os . path`) could hide a removed, still-used name: none is trusted. A local name the
  // file spells is an identifier leaf of the statement binding it; an inferred one (Go, no alias)
  // is not spelled and already keeps the rule from deciding. `default`, `*` and `=` are no names,
  // so `imported` gets the whitespace check only.
  const unfit = (["old", "new"] as const).flatMap((side) => {
    const names = reads.get(side)?.tokens.identifierNames ?? [];
    return touched[side].flatMap((placed) =>
      placed.statement.bindings
        .filter(
          (binding) =>
            /\s/u.test(binding.local) ||
            /\s/u.test(binding.imported) ||
            (!binding.localInferred && !names.includes(binding.local)),
        )
        .map((binding) => ({
          side,
          specifier: placed.statement.specifier,
          imported: binding.imported,
          local: binding.local,
          localInferred: binding.localInferred,
        })),
    );
  });
  if (unfit.length > 0)
    return outcome(
      "not-evaluated",
      "binding-not-in-file",
      `${prefix}, but Graph gives ${plural(unfit.length, "binding")} that ${unfit.length === 1 ? "does" : "do"} not fit the file (a name holding whitespace, or a local name that is no identifier of the file)`,
      { unfit },
    );
  const sideEffectOn = (side: "old" | "new", specifier: string) =>
    statementsOf(side).some(
      (statement) =>
        statement.sideEffectOnly && statement.specifier === specifier,
    );
  const bare = touchedStatements.filter(
    (statement) =>
      statement.sideEffectOnly &&
      !(
        sideEffectOn("old", statement.specifier) &&
        sideEffectOn("new", statement.specifier)
      ),
  );
  if (bare.length > 0)
    return outcome(
      "not-held",
      "side-effect-import",
      `${prefix}, but an import that loads a module for its effects alone is on one side only (${[...new Set(bare.map((statement) => statement.specifier))].join(", ")})`,
    );
  if (
    touchedStatements.some(
      (statement) =>
        statement.namesUnknown ||
        statement.bindings.some((binding) => binding.localInferred),
    )
  )
    return outcome(
      "not-held",
      "names-unknown",
      `${prefix}, but one of them brings in names the file does not spell out`,
    );
  // The touched statements' bindings, compared as multisets: statements the section does not touch
  // are the same on both sides, and one of two equal imports removed is still a removal.
  const minus = (
    from: ReadonlyArray<BindingEntry>,
    take: ReadonlyArray<BindingEntry>,
  ) => {
    const left = new Map<string, number>();
    for (const binding of take) {
      const key = bindingKey(binding);
      left.set(key, (left.get(key) ?? 0) + 1);
    }
    return from.filter((binding) => {
      const key = bindingKey(binding);
      const count = left.get(key) ?? 0;
      if (count === 0) return true;
      left.set(key, count - 1);
      return false;
    });
  };
  const baseBindings = touched.old.flatMap(entriesOf);
  const headBindings = touched.new.flatMap(entriesOf);
  const added = minus(headBindings, baseBindings);
  const removed = minus(baseBindings, headBindings);
  const valueSpecifiers = (side: "old" | "new") =>
    new Set(
      statementsOf(side)
        .filter(loadsValue)
        .map((statement) => statement.specifier),
    );
  const baseValues = valueSpecifiers("old");
  const headValues = valueSpecifiers("new");
  const once = (values: ReadonlyArray<string>) => [...new Set(values)];
  const baseOrder = valueOrder(statementsOf("old"));
  const headOrder = valueOrder(statementsOf("new"));
  const keptBase = baseOrder.filter((specifier) =>
    headOrder.includes(specifier),
  );
  const keptHead = headOrder.filter((specifier) =>
    keptBase.includes(specifier),
  );
  const changed = [...added, ...removed];
  Object.assign(base, {
    removed: removed.map(bindingJson),
    // A value binding from a module the base file loaded no value from: a new module load.
    newModuleLoads: once(
      added
        .filter(
          (binding) => !binding.typeOnly && !baseValues.has(binding.specifier),
        )
        .map((binding) => binding.specifier),
    ),
    // A removed value binding of a module the head file loads nothing from: no longer loaded here.
    droppedModuleLoads: once(
      removed
        .filter(
          (binding) => !binding.typeOnly && !headValues.has(binding.specifier),
        )
        .map((binding) => binding.specifier),
    ),
    typeOnlyChangesOnly:
      changed.length > 0 && changed.every((binding) => binding.typeOnly),
    valueImportOrderChanged: keptBase.join("\0") !== keptHead.join("\0"),
  });
  const addedPlain = { added: added.map(bindingJson) };
  const stillNamed = removed.filter((binding) =>
    head.tokens.identifierNames.includes(binding.local),
  );
  if (stillNamed.length > 0)
    return outcome(
      "not-held",
      "removed-name-still-used",
      `${prefix}, but a removed binding's name is still an identifier in the head file (${once(stillNamed.map((binding) => binding.local)).join(", ")})`,
      addedPlain,
    );
  if (removed.length > 0) {
    if (!input.contents?.has(blobs.new))
      return outcome(
        "not-evaluated",
        "contents-not-read",
        `${prefix}, but the head file's bytes, where a removed name could still be written, were not read`,
        addedPlain,
      );
    const text = decoder.decode(input.contents.get(blobs.new));
    const written = removed.filter((binding) =>
      wholeWord(binding.local).test(text),
    );
    if (written.length > 0)
      return outcome(
        "not-held",
        "removed-name-in-text",
        `${prefix}, but a removed binding's name is still written in the head file outside every identifier, where a string or a comment may use it (${once(written.map((binding) => binding.local)).join(", ")})`,
        addedPlain,
      );
  }
  const specifiers = once(added.map((binding) => binding.specifier));
  if (specifiers.length > 0 && input.relations === undefined)
    return outcome(
      "not-evaluated",
      "relations-not-read",
      `${prefix}, but where the added imports lead was not read`,
      addedPlain,
    );
  const answers = new Map(
    specifiers.map((specifier) => [
      specifier,
      input.relations!.importTarget("head", section.path, specifier),
    ]),
  );
  const nearest = new Map(
    [...answers].map(([specifier, answer]) => [
      specifier,
      answer.kind === "declared-package"
        ? input.relations!.manifestIsNearest(section.path, answer.manifest)
        : null,
    ]),
  );
  base.added = added.map((binding): Json => {
    const entry: Record<string, Json> = {
      ...(bindingJson(binding) as Record<string, Json>),
      target: answerJson(answers.get(binding.specifier)!),
    };
    const near = nearest.get(binding.specifier);
    if (near !== null && near !== undefined) entry.nearestManifest = near;
    return entry;
  });
  const where = (
    kinds: (answer: ImportTargetAnswer, specifier: string) => boolean,
  ) =>
    specifiers.filter((specifier) => kinds(answers.get(specifier)!, specifier));
  const unresolved = where((answer) => answer.kind === "unresolved");
  if (unresolved.length > 0)
    return outcome(
      "not-held",
      "unresolved",
      `${prefix}, but Graph found nothing an added import leads to (${unresolved.join(", ")})`,
    );
  const far = where(
    (answer, specifier) =>
      answer.kind === "declared-package" && nearest.get(specifier) === false,
  );
  if (far.length > 0)
    return outcome(
      "not-held",
      "package-not-nearest",
      `${prefix}, but an added import names a package declared in a manifest that is not the file's nearest (${far.join(", ")})`,
    );
  for (const specifier of specifiers) {
    const reason = UNKNOWN_TARGET[answers.get(specifier)!.kind];
    if (reason !== undefined)
      return outcome(
        "not-evaluated",
        reason,
        `${prefix}, but Graph gave no answer for where an added import leads (${specifier}: ${answers.get(specifier)!.kind})`,
      );
  }
  return outcome(
    "holds",
    null,
    `${prefix}${addedFile ? " of the added file" : ""}; it adds ${plural(added.length, "binding")} and removes ${removed.length} (a binding includes where its statement sits in the tree), every added module is a file, a builtin or a package of the file's nearest manifest, and no removed name is left in the head file`,
  );
};

// ---------------------------------------------------------------------------------------------
// deletion-only.

/**
 * What still pointed at a removed symbol at the base, as an input. A caller matched by name only
 * may not be a caller at all, so it is context and never counts: `name-only` is a symbol whose
 * every caller is matched by name only, and `supported` one with at least one caller that is not
 * (`trusted`). `first` is the first shown caller not matched by name only, read from `matched`
 * rather than from the order of `shown`; null when none of the shown callers is.
 */
type StillPointing =
  | { readonly evidence: "none" }
  | { readonly evidence: "name-only"; readonly total: number }
  | {
      readonly evidence: "supported";
      readonly total: number;
      readonly trusted: number;
      readonly first: {
        readonly path: string;
        readonly line: number | null;
      } | null;
    };
type RemovedSymbol = {
  readonly name: string;
  readonly kind: string;
  readonly stillPointingOnBase: StillPointing;
};

const deletionRule = (
  context: RuleContext,
  oldSideOnly: boolean,
): Array<TokenRuleOutcome> => {
  const { section, hunks, input } = context;
  if (!oldSideOnly || input.relations === undefined) return [];
  const evidence = [EVIDENCE.oldOnly, EVIDENCE.slice];
  const slice = input.relations.slice(section.key);
  if (slice === undefined)
    return [
      {
        rule: "deletion-only",
        result: "not-evaluated",
        reason: "relations-not-read",
        statement:
          "only rows were removed, but no relation slice was cut for the section",
        inputs: { slice: null },
        evidence,
      },
    ];
  const read = slice.base.read;
  if (read.kind === "gap")
    return [
      {
        rule: "deletion-only",
        result: "not-evaluated",
        reason: "relations-not-read",
        statement: `only rows were removed, but Graph's base read is a gap (${read.gap})`,
        inputs: { gap: { gap: read.gap, tag: read.tag } },
        evidence,
      },
    ];
  const paths = new Set(hunks.map((hunk) => hunk.oldPath ?? hunk.path));
  const coverage = slice.base.paths.filter((entry) => paths.has(entry.path));
  const coverageJson = coverage.map((entry): Json => ({
    path: entry.path,
    snapshot:
      entry.snapshot.kind === "read"
        ? {
            kind: "read",
            parsed: entry.snapshot.parsed,
            failures: [...entry.snapshot.failures],
          }
        : entry.snapshot.kind === "not-in-snapshot"
          ? { kind: entry.snapshot.kind, reason: entry.snapshot.reason }
          : { kind: entry.snapshot.kind },
  }));
  if (
    coverage.length !== paths.size ||
    coverage.some(
      (entry) => entry.snapshot.kind !== "read" || !entry.snapshot.parsed,
    )
  )
    return [
      {
        rule: "deletion-only",
        result: "not-evaluated",
        reason: "relations-file-not-read",
        statement:
          "only rows were removed, but Graph's base read did not read the section's file",
        inputs: { paths: coverageJson },
        evidence,
      },
    ];
  const gone = slice.base.symbols.filter(
    (entry) => entry.counterpart.rule === "none",
  );
  const unknown = slice.base.symbols.filter(
    (entry) =>
      entry.counterpart.rule === "other-side-not-read" ||
      entry.counterpart.rule === "ids-not-comparable",
  );
  const removed = gone.map((entry): RemovedSymbol => {
    const still = entry.stillPointingOnBase ?? { evidence: "none" as const };
    const stillPointingOnBase = ((): StillPointing => {
      if (still.evidence === "none") return { evidence: "none" };
      if (still.trusted === 0)
        return { evidence: "name-only", total: still.total };
      const first = still.shown.find((row) => row.matched !== "name-only");
      return {
        evidence: "supported",
        total: still.total,
        trusted: still.trusted,
        first:
          first === undefined
            ? null
            : {
                path: first.site?.path ?? first.caller.path,
                line: first.site?.line ?? null,
              },
      };
    })();
    return {
      name: entry.symbol.name,
      kind: entry.symbol.kind,
      stillPointingOnBase,
    };
  });
  const count = (evidence: StillPointing["evidence"]) =>
    removed.filter((entry) => entry.stillPointingOnBase.evidence === evidence)
      .length;
  const pointed = count("supported");
  const nameOnly = count("name-only");
  const unseen = count("none");
  const clauses = [
    pointed === 0
      ? null
      : `${pointed} still had callers at the base that this change did not touch`,
    nameOnly === 0
      ? null
      : `for ${nameOnly} only name matches were found at the base, which may not be callers`,
    unseen === 0
      ? null
      : `for ${unseen} no supported caller was found, which is not proof that there is none`,
  ].filter((clause) => clause !== null);
  const found =
    gone.length === 0
      ? "Graph's base read finds no changed symbol without a counterpart at the head"
      : `Graph's base read finds ${plural(gone.length, "changed symbol")} without a counterpart at the head: ${
          clauses.length === 1
            ? clauses[0]
            : `${clauses.slice(0, -1).join(", ")}, and ${clauses.at(-1)}`
        }`;
  return [
    {
      rule: "deletion-only",
      result: "holds",
      reason: null,
      statement: `only rows were removed; ${found}${unknown.length === 0 ? "" : `; for ${plural(unknown.length, "symbol")} Graph could not tell a counterpart`}`,
      inputs: {
        removed,
        counterpartNotTold: unknown.map((entry) => ({
          name: entry.symbol.name,
          kind: entry.symbol.kind,
          rule: entry.counterpart.rule,
        })),
        paths: coverageJson,
        blindSpots: [...slice.blindSpots],
      },
      evidence,
    },
  ];
};

/**
 * The token rules' outcomes for one section, given its own hunks and whether the facts call it
 * old-side-only. Rules that do not apply give nothing.
 */
export const sectionTokenRules = (
  section: Section,
  hunks: ReadonlyArray<ManifestHunk>,
  oldSideOnly: boolean,
  input: TokenRulesInput,
): ReadonlyArray<TokenRuleOutcome> => {
  if (input.tokens === undefined && input.relations === undefined) return [];
  const { rows, runs } = sectionRows(section, hunks);
  const context: RuleContext = { section, hunks, rows, runs, input };
  return [
    ...layoutRules(context),
    ...importsRule(context),
    ...deletionRule(context, oldSideOnly),
  ];
};

// ---------------------------------------------------------------------------------------------
// Pattern families.

export const SECTION_FAMILIES_RECIPE = "neuve-section-families-v1";
/** The coordinator's ruling: below this many non-comment leaves a section takes no part. */
export const FAMILY_MIN_TOKENS = 21;
/** A family is this many sections or more with the same hash. */
export const FAMILY_MIN_MEMBERS = 3;

export interface SectionFamily {
  /** The hash the members share. */
  readonly family: string;
  /** The first member in file order. */
  readonly representative: string;
  /** The members' identity keys, by path and then by place in the file. */
  readonly members: ReadonlyArray<string>;
  readonly kind: Section["kind"];
  /** Non-comment leaves in each member's sequence. */
  readonly tokens: number;
}

export interface SectionFamiliesInput {
  readonly result: SectionFactsResult;
  readonly hunks: ReadonlyArray<ManifestHunk>;
  readonly tokens?: SectionTokensInput;
  readonly contents?: ReadonlyMap<string, Uint8Array>;
}

const byCodeUnits = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Pattern families. A section takes part when every side it owns rows on has tokens available
 * without errors and its bytes read, and no leaf of its sequence has the error flag. Its sequence:
 * `-`, each leaf touching its removed rows in base order, `+`, each leaf touching its added rows in
 * head order, each leaf once per side; an identifier leaf is one placeholder, every other leaf
 * (comments too) its type and bytes. The hash is of the section's kind and that sequence. Only
 * sections with at least `FAMILY_MIN_TOKENS` non-comment leaves take part; a family is
 * `FAMILY_MIN_MEMBERS` or more of them with one hash. The same input in any order gives the same
 * output, families ordered by their representative.
 */
export const sectionFamiliesOf = (
  input: SectionFamiliesInput,
): ReadonlyArray<SectionFamily> => {
  const tokens = input.tokens;
  if (tokens === undefined) return [];
  const hunks = new Map(input.hunks.map((hunk) => [hunk.hunkId, hunk]));
  const hashed = new Map<
    string,
    Array<{ section: Section; identity: SectionIdentity; tokens: number }>
  >();
  for (const section of input.result.sections) {
    const identity = input.result.identities.get(section.key);
    if (identity === undefined)
      throw new Error(`Section of ${section.path} has no identity given`);
    const own = section.hunkIds.map((hunkId) => {
      const hunk = hunks.get(hunkId);
      if (hunk === undefined || hunk.path !== section.path)
        throw new Error(
          `Section of ${section.path} names hunk ${hunkId}, which is not given for it`,
        );
      return hunk;
    });
    if (own.some((hunk) => hunk.kind !== "text")) continue;
    const { rows } = sectionRows(section, own);
    const hash = createHash("sha256");
    const field = (bytes: Uint8Array | string) => {
      const value =
        typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
      hash.update(`${value.byteLength}:`);
      hash.update(value);
    };
    field(SECTION_FAMILIES_RECIPE);
    field(section.kind);
    let count = 0;
    let usable = rows.length > 0;
    for (const side of ["old", "new"] as const) {
      if (!usable) break;
      field(side === "old" ? "-" : "+");
      const lines = rows
        .filter((row) => row.side === side)
        .map((row) => row.line);
      if (lines.length === 0) continue;
      const blob = blobOn(section, own, side);
      const read = blob === null ? undefined : sideRead(input, tokens, blob);
      if (
        read === undefined ||
        read.tokens.hasErrors ||
        read.bytes === undefined
      ) {
        usable = false;
        break;
      }
      for (const at of leavesTouching(read.tokens, lines)) {
        const flags = read.flags(at);
        if (flags.error) {
          usable = false;
          break;
        }
        if (!flags.comment) count++;
        if (flags.identifier) field("I");
        else {
          field("L");
          field(graphLeafType(read.tokens, at));
          field(leafBytes(read, at));
        }
      }
    }
    if (!usable || count < FAMILY_MIN_TOKENS) continue;
    const key = hash.digest("hex");
    const members = hashed.get(key) ?? [];
    members.push({ section, identity, tokens: count });
    hashed.set(key, members);
  }
  const byPlace = (
    a: { section: Section; identity: SectionIdentity },
    b: { section: Section; identity: SectionIdentity },
  ) =>
    byCodeUnits(a.section.path, b.section.path) ||
    a.section.first - b.section.first ||
    byCodeUnits(a.identity.key, b.identity.key);
  const families = [...hashed]
    .filter(([, members]) => members.length >= FAMILY_MIN_MEMBERS)
    .map(([family, members]) => {
      members.sort(byPlace);
      return { family, members };
    })
    .sort((a, b) => byPlace(a.members[0]!, b.members[0]!));
  return families.map(({ family, members }) => ({
    family,
    representative: members[0]!.identity.key,
    members: members.map((member) => member.identity.key),
    kind: members[0]!.section.kind,
    tokens: members[0]!.tokens,
  }));
};
