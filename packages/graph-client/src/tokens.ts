import { z } from "zod";

/**
 * The syntax leaves and import bindings of one file, from `symbols --outline --tokens` ("File
 * tokens records" in Graph's `docs/snapshot-format.md`, written by `extractFileTokens` in
 * `internal/sem/tokens.go`). The reader validates each record against the bytes it gave the engine
 * and keeps the engine's compact form: per-file tables of leaf types and ancestor hashes and one
 * positional row per leaf. A file has about one leaf per five or six bytes of source, so rows are
 * never expanded into objects; the accessors below read one leaf at a time.
 */

/** The engine's capability keys; their languages are in `feature_languages`. */
export const GRAPH_TOKENS_FEATURE = "symbols_outline_tokens";
export const GRAPH_IMPORT_BINDINGS_FEATURE = "symbols_outline_import_bindings";
export const GRAPH_TOKEN_DIRECTIVES_FEATURE =
  "symbols_outline_token_directives";
export const GRAPH_INDENTATION_SIGNIFICANT_FEATURE =
  "symbols_outline_indentation_significant";

/** Leaf flag bits, as the engine writes them. */
export const GRAPH_LEAF_FLAGS = {
  identifier: 1,
  comment: 2,
  error: 4,
  named: 8,
  rewritten: 16,
  /** A comment leaf (always with `comment`) of a comment a compiler or tool reads or may read. */
  directive: 32,
} as const;
const KNOWN_FLAGS = 63;

/**
 * One leaf: index into `leafTypes`, start byte, end byte (exclusive), start line, end line (1-based,
 * `\n` only), flags, index into `ancestors`, opens.
 */
export type GraphLeafRow = readonly [
  type: number,
  startByte: number,
  endByte: number,
  startLine: number,
  endLine: number,
  flags: number,
  ancestors: number,
  opens: number,
];

export type GraphImportBinding = Readonly<{
  /** The name taken from the module, `default`, `*` for the whole module, `=` for `import x = require()`. */
  imported: string;
  /** Its name in this file. */
  local: string;
  /** Erased before the program runs (`import type`, `type` specifiers). */
  typeOnly: boolean;
  /** Go: the file does not spell the local name; it is the one the import path implies. */
  localInferred: boolean;
}>;
export type GraphImportStatement = Readonly<{
  startLine: number;
  endLine: number;
  /**
   * The statement's range in the bytes as given, end exclusive like a leaf's. The reader checks that
   * it is well formed against the bytes: in the file, in order, not cutting a character, its lines
   * the lines of its bytes, starting at the start of a leaf and ending at the end of a leaf, neither
   * of them a comment, and every leaf wholly inside or wholly outside it. That it is exactly one
   * import statement (code before or after it on its lines outside it) is the engine's fact, pinned
   * by the engine's tests; the reader cannot verify it. Python's `import a, b` gives both statements
   * the one range; in Go's grouped `import ( … )` each spec alone is a statement.
   */
  startByte: number;
  endByte: number;
  /** As written, without quotes; Python relative modules keep their dots. */
  specifier: string;
  bindings: readonly GraphImportBinding[];
  /** Brings in no name (`import "x"`, Go's `import _ "x"`). */
  sideEffectOnly: boolean;
  /** Brings in names the file does not spell out (`from x import *`, Go's `import . "x"`). */
  namesUnknown: boolean;
}>;
/** `not-extracted`: the language is outside the engine's binding coverage, never "no imports". */
export type GraphFileImports =
  | Readonly<{
      status: "extracted";
      statements: readonly GraphImportStatement[];
    }>
  | Readonly<{ status: "not-extracted" }>;

/**
 * Why a file has no tokens, with the outline's fallback vocabulary. Only `partial-failure` is
 * retryable: the others are what the same engine says again for the same bytes.
 */
export type GraphTokensUnavailableReason =
  /** The engine's own tokens size limit: a record that says its leaves were not extracted. */
  | "tokens-size-limit"
  | "unsupported-language"
  | "parse-error"
  | "source-not-parsed"
  | "outline-unavailable"
  | "partial-failure";

export type GraphFileTokens =
  | Readonly<{
      status: "available";
      /** The tree holds an error or missing node somewhere in the file. */
      hasErrors: boolean;
      /** The distinct texts of every identifier leaf of the whole file, sorted by UTF-8 bytes. */
      identifierNames: readonly string[];
      leafTypes: readonly string[];
      /** 16 hex characters each: a hash of the ancestor chain from the root to a leaf's parent. */
      ancestors: readonly string[];
      /** In source order, not overlapping, each within the file; only whitespace lies between. */
      leaves: readonly GraphLeafRow[];
      /** Flag bits this reader does not know, ORed over the file's leaves; ignored by the accessors. */
      unknownFlagBits: number;
      /**
       * Whether the engine declares the `directive` flag for this file's language. When false, a
       * comment leaf without the flag says nothing about whether a tool reads it.
       */
      directivesFlagged: boolean;
      /**
       * Whether the engine declares this file's language as one where leading whitespace is syntax
       * and the tree accepts indentation the compiler rejects (`true`), or as free-form (`false`).
       * `null`: the engine does not declare the key at all, so nothing is known either way.
       */
      indentationSignificant: boolean | null;
      imports: GraphFileImports;
    }>
  | Readonly<{
      status: "unavailable";
      reason: GraphTokensUnavailableReason;
      retryable: boolean;
      /** The failure codes behind the reason, if any (`tokens-output-limit` for the per-file cap). */
      codes: readonly string[];
    }>;

/** The languages a tokens read covers, as the engine declared them. */
export type GraphTokenCoverage = Readonly<{
  languages: readonly string[];
  importBindingLanguages: readonly string[];
  /** Languages whose comment leaves carry the `directive` flag; empty for an engine without it. */
  directiveLanguages: readonly string[];
  /** Languages whose leading whitespace is syntax; null for an engine that does not declare the key. */
  indentationSignificantLanguages: readonly string[] | null;
}>;

/** A tokens record too large for one file's allowance: tokens unavailable, outline kept. */
export const TOKENS_OUTPUT_LIMIT = "tokens-output-limit";

const text = z.string();
const nonEmpty = z.string().min(1);
const line = z.int().positive();
// Provider payload: known fields validated, additive ones ignored. Leaves are checked by hand below,
// against the input's bytes, without copying the rows.
const ExtractedWire = z.object({
  record_type: z.literal("file_tokens"),
  file_path: text,
  language: text,
  status: z.literal("extracted"),
  has_errors: z.boolean(),
  identifier_names: z.array(text),
  leaf_types: z.array(text),
  ancestors: z.array(z.string().regex(/^[0-9a-f]{16}$/)),
  leaves: z.custom<readonly unknown[]>(
    (value) => Array.isArray(value),
    "leaves must be an array",
  ),
  import_bindings: z.enum(["extracted", "not_extracted"]),
  imports: z
    .array(
      z.object({
        start_line: line,
        end_line: line,
        start_byte: z.int().nonnegative(),
        end_byte: z.int().nonnegative(),
        specifier: text,
        bindings: z.array(
          z.object({
            imported: nonEmpty,
            local: nonEmpty,
            type_only: z.boolean(),
            local_inferred: z.boolean().optional(),
          }),
        ),
        side_effect_only: z.boolean(),
        names_unknown: z.boolean(),
      }),
    )
    .optional(),
});
/**
 * A record whose leaves were not extracted: the language is not declared, or the file is over the
 * engine's tokens limit (512 KiB of source or 100,000 rows). It carries no tables, leaves, names or
 * imports; one that does is malformed.
 */
const NotExtractedWire = z.object({
  record_type: z.literal("file_tokens"),
  file_path: text,
  language: text,
  status: z.enum(["language_not_covered", "over_size_limit"]),
  has_errors: z.boolean(),
  import_bindings: z.literal("not_extracted"),
  identifier_names: z.never().optional(),
  leaf_types: z.never().optional(),
  ancestors: z.never().optional(),
  leaves: z.never().optional(),
  imports: z.never().optional(),
});
/** A record without `status` is malformed. */
export const TokensWire = z.discriminatedUnion("status", [
  ExtractedWire,
  NotExtractedWire,
]);
export type TokensWire = z.infer<typeof TokensWire>;
type ExtractedWire = z.infer<typeof ExtractedWire>;

/**
 * A record's value, by its status against the declaration: `extracted` and `over_size_limit` only
 * for a declared language, `language_not_covered` only for one that is not.
 */
export const fileTokensRecord = (
  record: TokensWire,
  bytes: Uint8Array,
  coverage: GraphTokenCoverage,
): GraphFileTokens => {
  const declared = coverage.languages.includes(record.language);
  if (record.status !== "extracted") {
    if (declared !== (record.status === "over_size_limit"))
      return fail(`${record.status} contradicts the declared languages`);
    return record.status === "over_size_limit"
      ? unavailable("tokens-size-limit", [])
      : unavailable("unsupported-language", []);
  }
  if (!declared) return fail("extracted for a language not declared");
  return normalizeFileTokens(
    record,
    bytes,
    coverage.importBindingLanguages.includes(record.language),
    coverage.directiveLanguages.includes(record.language),
    coverage.indentationSignificantLanguages === null
      ? null
      : coverage.indentationSignificantLanguages.includes(record.language),
  );
};

/** Code-point (UTF-8 byte) order, the engine's `sort.Strings`; JS `<` compares UTF-16 units. */
const compareCodePoints = (a: string, b: string): number => {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const x = a.codePointAt(i) ?? 0;
    const y = b.codePointAt(j) ?? 0;
    if (x !== y) return x - y;
    i += x > 0xffff ? 2 : 1;
    j += y > 0xffff ? 2 : 1;
  }
  return a.length - i - (b.length - j);
};

/** Byte offsets where each line starts; line n (1-based) starts at `starts[n - 1]`. */
const lineStarts = (bytes: Uint8Array): Uint32Array => {
  let count = 1;
  for (const byte of bytes) if (byte === 10) count++;
  const starts = new Uint32Array(count);
  let at = 1;
  for (let index = 0; index < bytes.length; index++)
    if (bytes[index] === 10) starts[at++] = index + 1;
  return starts;
};

/** The 1-based line of a byte offset. */
const lineOf = (starts: Uint32Array, offset: number): number => {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if ((starts[middle] ?? 0) <= offset) low = middle;
    else high = middle - 1;
  }
  return low + 1;
};

const fail = (message: string): never => {
  throw new Error(`Invalid file tokens record: ${message}`);
};

const continuation = (byte: number | undefined): boolean =>
  byte !== undefined && (byte & 0xc0) === 0x80;

/** The well-formed UTF-8 character at `at` and its length, or -1 for an invalid byte. */
const decodeAt = (bytes: Uint8Array, at: number): readonly [number, number] => {
  const lead = bytes[at] ?? 0;
  const length =
    lead >= 0xc2 && lead <= 0xdf
      ? 2
      : lead >= 0xe0 && lead <= 0xef
        ? 3
        : lead >= 0xf0 && lead <= 0xf4
          ? 4
          : 0;
  if (length === 0) return [-1, 1];
  let code = lead & (0xff >> (length + 1));
  for (let next = 1; next < length; next++) {
    const byte = bytes[at + next];
    if (!continuation(byte)) return [-1, 1];
    code = (code << 6) | ((byte ?? 0) & 0x3f);
  }
  const minimum = [0, 0, 0x80, 0x800, 0x10000][length] ?? 0;
  return code < minimum || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)
    ? [-1, 1]
    : [code, length];
};

/** The engine's layout bytes, the only ones a row may leave out: space, tab, CR and LF. */
const isLayout = (byte: number): boolean =>
  byte === 0x20 || byte === 0x09 || byte === 0x0d || byte === 0x0a;

/** Whether `[from, to)` is only layout bytes, as the engine leaves between rows. */
const layout = (bytes: Uint8Array, from: number, to: number): boolean => {
  for (let at = from; at < to; at++)
    if (!isLayout(bytes[at] ?? 0)) return false;
  return true;
};

/** The length of a byte-order mark at byte 0, which is never a row. */
const bomLength = (bytes: Uint8Array): number =>
  bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;

/**
 * Whether a row boundary at `at` falls inside a well-formed multi-byte character: a lead byte
 * within the three before it whose sequence runs past it. A stray byte in a file that is not UTF-8
 * is no character, so a boundary beside one is not refused.
 */
const insideCharacter = (bytes: Uint8Array, at: number): boolean => {
  if (!continuation(bytes[at])) return false;
  for (let back = 1; back <= 3 && at - back >= 0; back++) {
    const byte = bytes[at - back] ?? 0;
    if (continuation(byte)) continue;
    const [code, length] = decodeAt(bytes, at - back);
    return code !== -1 && length > back;
  }
  return false;
};

const fatalText = new TextDecoder("utf-8", { fatal: true });

const isIndex = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isRow = (value: unknown): value is GraphLeafRow =>
  Array.isArray(value) && value.length === 8 && value.every(isIndex);

/**
 * Validates one `file_tokens` record against the bytes the engine was given and returns its
 * available value. Every row must be eight non-negative integers whose table indices are in range,
 * whose bytes lie in the file in source order without overlap, and whose lines are the lines of
 * those bytes. The rows tile the file: only whitespace (Go's `unicode.IsSpace`) lies outside them,
 * besides a leading byte-order mark, and no row begins or ends inside a UTF-8 character. Every
 * identifier leaf's text is a name, and every name has an identifier leaf (unless a rewritten span
 * or a leaf that is not UTF-8 makes that unknowable). Unknown flag bits are kept and reported, not
 * refused: schema 1.x is additive. `names_unknown` beside bindings is kept: the docs do not make
 * them exclusive.
 */
export const normalizeFileTokens = (
  record: ExtractedWire,
  bytes: Uint8Array,
  importBindings: boolean,
  directives = false,
  indentationSignificant: boolean | null = null,
): GraphFileTokens & { status: "available" } => {
  const types = record.leaf_types.length;
  if (new Set(record.leaf_types).size !== types) fail("repeated leaf type");
  const chains = record.ancestors.length;
  if (new Set(record.ancestors).size !== chains) fail("repeated ancestors");
  for (let at = 1; at < record.identifier_names.length; at++)
    if (
      compareCodePoints(
        record.identifier_names[at - 1] ?? "",
        record.identifier_names[at] ?? "",
      ) >= 0
    )
      fail("identifier names are not distinct and sorted");
  const starts = lineStarts(bytes);
  const size = bytes.byteLength;
  // A byte-order mark at byte 0 is never a row.
  const bom = bomLength(bytes);
  let previousEnd = bom;
  let unknownFlagBits = 0;
  let rewritten = false;
  let undecodable = false;
  // An all-ASCII file is sliced from one decoded string; any other decodes per identifier leaf.
  let ascii = true;
  for (let at = 0; at < size; at++)
    if ((bytes[at] ?? 0) >= 0x80) {
      ascii = false;
      break;
    }
  const whole = ascii ? new TextDecoder().decode(bytes) : "";
  const names = new Set(record.identifier_names);
  const named = new Set<string>();
  const leaves: readonly unknown[] = Array.isArray(record.leaves)
    ? record.leaves
    : fail("leaves is not an array");
  for (let at = 0; at < leaves.length; at++) {
    const row = leaves[at];
    if (!isRow(row))
      return fail(`leaf ${at} is not eight non-negative integers`);
    const [type, start, end, startLine, endLine, flags, ancestors] = row;
    if (type >= types) fail(`leaf ${at} type outside the table`);
    if (ancestors >= chains) fail(`leaf ${at} ancestors outside the table`);
    if (start > end || end > size) fail(`leaf ${at} bytes outside the file`);
    if (start < previousEnd)
      fail(`leaf ${at} is out of order or overlaps the one before`);
    if (!layout(bytes, previousEnd, start))
      fail(`non-whitespace bytes before leaf ${at} are in no leaf`);
    if (insideCharacter(bytes, start) || insideCharacter(bytes, end))
      fail(`leaf ${at} begins or ends inside a character`);
    previousEnd = end;
    const firstLine = lineOf(starts, start);
    if (
      startLine !== firstLine ||
      endLine !== (end > start ? lineOf(starts, end - 1) : firstLine)
    )
      fail(`leaf ${at} lines are not the lines of its bytes`);
    unknownFlagBits |= flags & ~KNOWN_FLAGS;
    if ((flags & GRAPH_LEAF_FLAGS.directive) !== 0) {
      // The engine's invariant: a directive leaf is a comment leaf, and only where declared.
      if ((flags & GRAPH_LEAF_FLAGS.comment) === 0)
        fail(`leaf ${at} is a directive but not a comment`);
      if (!directives)
        fail(`leaf ${at} is a directive in a language not declared for them`);
    }
    if ((flags & GRAPH_LEAF_FLAGS.rewritten) !== 0) rewritten = true;
    if ((flags & GRAPH_LEAF_FLAGS.identifier) !== 0) {
      let text: string | undefined;
      if (ascii) text = whole.slice(start, end);
      else
        try {
          text = fatalText.decode(bytes.subarray(start, end));
        } catch {
          // Not UTF-8: Go's JSON and this decoder replace invalid bytes differently, so the
          // name cannot be compared.
          text = undefined;
          undecodable = true;
        }
      if (text !== undefined) {
        if (!names.has(text))
          fail(`identifier leaf ${at} is not in identifier_names`);
        named.add(text);
      }
    }
  }
  if (!layout(bytes, previousEnd, size))
    fail("non-whitespace bytes after the last leaf are in no leaf");
  // Names inside a rewritten span come from a second parse and have no leaf of their own; a file
  // with an identifier that could not be decoded may name it without a comparable leaf.
  if (!rewritten && !undecodable)
    for (const name of names)
      if (!named.has(name))
        fail(`identifier name ${JSON.stringify(name)} has no identifier leaf`);
  const extracted = record.import_bindings === "extracted";
  if (extracted !== importBindings)
    fail(
      `import bindings ${record.import_bindings} contradict the declared languages`,
    );
  if (!extracted && record.imports !== undefined)
    fail("imports on a record that extracts none");
  if (extracted && record.imports === undefined) fail("imports missing");
  const lines = starts.length;
  let previousLine = 1;
  let previousRange: readonly [number, number] = [0, 0];
  // Every row passed `isRow` above.
  const rows = leaves as readonly GraphLeafRow[];
  /** The index of the first leaf that starts at or after `at`. */
  const firstFrom = (at: number): number => {
    let low = 0;
    let high = rows.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((rows[middle]?.[1] ?? 0) < at) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  /** Whether a leaf begins before `at` and ends after it. */
  const straddled = (at: number): boolean =>
    (rows[firstFrom(at) - 1]?.[2] ?? 0) > at;
  const isComment = (leaf: GraphLeafRow | undefined) =>
    leaf !== undefined && (leaf[5] & GRAPH_LEAF_FLAGS.comment) !== 0;
  const statements = (record.imports ?? []).map(
    (statement): GraphImportStatement => {
      if (
        statement.end_line < statement.start_line ||
        statement.end_line > lines ||
        statement.start_line < previousLine
      )
        fail("import statement lines out of order or outside the file");
      previousLine = statement.start_line;
      const { start_byte: start, end_byte: end } = statement;
      if (start > end || end > size)
        fail("import statement bytes outside the file");
      // In order and apart, or the very range of the one before (Python's `import a, b`).
      const [before, after] = previousRange;
      if (start < after && !(start === before && end === after))
        fail("import statements overlap or are out of order");
      previousRange = [start, end];
      if (insideCharacter(bytes, start) || insideCharacter(bytes, end))
        fail("an import statement begins or ends inside a character");
      const firstLine = lineOf(starts, start);
      if (
        statement.start_line !== firstLine ||
        statement.end_line !==
          (end > start ? lineOf(starts, end - 1) : firstLine)
      )
        fail("import statement lines are not the lines of its bytes");
      if (straddled(start) || straddled(end))
        fail("a leaf straddles an import statement's boundary");
      // It starts at a leaf's start and ends at a leaf's end, and neither leaf is a comment.
      const first = rows[firstFrom(start)];
      if (first === undefined || first[1] !== start || first[2] > end)
        fail("an import statement does not start at the start of a leaf");
      const last = rows[firstFrom(end) - 1];
      if (last === undefined || last[2] !== end || last[1] < start)
        fail("an import statement does not end at the end of a leaf");
      if (isComment(first) || isComment(last))
        fail("an import statement begins or ends with a comment");
      if (statement.side_effect_only && statement.bindings.length > 0)
        fail("a side-effect-only import with bindings");
      return {
        startLine: statement.start_line,
        endLine: statement.end_line,
        startByte: start,
        endByte: end,
        specifier: statement.specifier,
        bindings: statement.bindings.map((binding) => ({
          imported: binding.imported,
          local: binding.local,
          typeOnly: binding.type_only,
          localInferred: binding.local_inferred === true,
        })),
        sideEffectOnly: statement.side_effect_only,
        namesUnknown: statement.names_unknown,
      };
    },
  );
  return {
    status: "available",
    hasErrors: record.has_errors,
    identifierNames: record.identifier_names,
    leafTypes: record.leaf_types,
    ancestors: record.ancestors,
    // Every row passed `isRow` above.
    leaves: leaves as readonly GraphLeafRow[],
    unknownFlagBits,
    directivesFlagged: directives,
    indentationSignificant,
    imports: extracted
      ? { status: "extracted", statements }
      : { status: "not-extracted" },
  };
};

/** Failure codes the outline's fallbacks treat as stable, by the reason they give. */
const STABLE_FAILURES = new Map<string, GraphTokensUnavailableReason>([
  ["E_PARSE_ERROR", "parse-error"],
  ["E_PARSE_DEPTH_EXCEEDED", "parse-error"],
  ["E_MINIFIED", "source-not-parsed"],
  ["E_FILE_TOO_LARGE", "source-not-parsed"],
  ["symbols-input-limit", "source-not-parsed"],
  ["E_UNSUPPORTED_LANGUAGE", "unsupported-language"],
]);

const unavailable = (
  reason: GraphTokensUnavailableReason,
  codes: readonly string[],
): GraphFileTokens => ({
  status: "unavailable",
  reason,
  retryable: reason === "partial-failure",
  codes,
});

/**
 * A file's tokens value. Its failures decide first, as they decide the outline's fallback: any
 * code the reader does not know is a retryable partial failure, then a parse error, then source
 * not parsed, then an unsupported language. Then a record over its allowance, then the record, then
 * the declaration: a language the engine does not list gives no tokens.
 */
export const fileTokensValue = (
  file: Readonly<{
    language: string | null;
    partialFailure: string | null;
    partialFailures?: readonly string[] | undefined;
  }>,
  read: GraphFileTokens | "over-limit" | undefined,
  coverage: GraphTokenCoverage,
): GraphFileTokens => {
  const codes =
    file.partialFailures ?? (file.partialFailure ? [file.partialFailure] : []);
  if (codes.some((code) => !STABLE_FAILURES.has(code)))
    return unavailable("partial-failure", codes);
  for (const reason of [
    "parse-error",
    "source-not-parsed",
    "unsupported-language",
  ] as const)
    if (codes.some((code) => STABLE_FAILURES.get(code) === reason))
      return unavailable(reason, codes);
  if (read === "over-limit")
    return unavailable("source-not-parsed", [TOKENS_OUTPUT_LIMIT]);
  if (read !== undefined) return read;
  if (file.language === null || !coverage.languages.includes(file.language))
    return unavailable("unsupported-language", []);
  return unavailable("outline-unavailable", []);
};

type Available = GraphFileTokens & { status: "available" };

/**
 * The leaves touching lines `startLine`..`endLine` (1-based, inclusive): every leaf with any line
 * in the range, so a multi-line leaf that begins before the range and runs into it is included. Rows
 * are in source order and do not overlap, so they are one run, `from` to `to` (exclusive), empty
 * when `from === to`.
 */
export const graphLeavesTouchingLines = (
  tokens: Available,
  startLine: number,
  endLine: number,
): Readonly<{ from: number; to: number }> => {
  const rows = tokens.leaves;
  // First row whose end line reaches the range, then the first whose start line is past it.
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((rows[middle]?.[4] ?? 0) < startLine) low = middle + 1;
    else high = middle;
  }
  const from = low;
  // An empty or inverted range touches no leaf.
  if (endLine < startLine) return { from, to: from };
  high = rows.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((rows[middle]?.[3] ?? 0) <= endLine) low = middle + 1;
    else high = middle;
  }
  return { from, to: Math.max(from, low) };
};

const row = (tokens: Available, at: number): GraphLeafRow => {
  const found = tokens.leaves[at];
  if (found === undefined) throw new RangeError(`No leaf ${at}.`);
  return found;
};

/** The grammar's type of a leaf, named or anonymous. */
export const graphLeafType = (tokens: Available, at: number): string =>
  tokens.leafTypes[row(tokens, at)[0]] ?? "";

/** A leaf's bytes and lines in the file the engine was given. */
export const graphLeafPosition = (
  tokens: Available,
  at: number,
): Readonly<{
  startByte: number;
  endByte: number;
  startLine: number;
  endLine: number;
}> => {
  const [, startByte, endByte, startLine, endLine] = row(tokens, at);
  return { startByte, endByte, startLine, endLine };
};

/**
 * A leaf's known flags; bits this reader does not know are left out. `directive` is null where the engine does not declare the flag for the
 * file's language (`directivesFlagged` false): there its absence says nothing.
 */
export type GraphLeafFlags = Readonly<
  Record<Exclude<keyof typeof GRAPH_LEAF_FLAGS, "directive">, boolean> & {
    directive: boolean | null;
  }
>;

export const graphLeafFlags = (
  tokens: Available,
  at: number,
): GraphLeafFlags => {
  const flags = row(tokens, at)[5];
  return {
    identifier: (flags & GRAPH_LEAF_FLAGS.identifier) !== 0,
    comment: (flags & GRAPH_LEAF_FLAGS.comment) !== 0,
    error: (flags & GRAPH_LEAF_FLAGS.error) !== 0,
    named: (flags & GRAPH_LEAF_FLAGS.named) !== 0,
    rewritten: (flags & GRAPH_LEAF_FLAGS.rewritten) !== 0,
    directive: tokens.directivesFlagged
      ? (flags & GRAPH_LEAF_FLAGS.directive) !== 0
      : null,
  };
};

/** The hash of a leaf's ancestor chain, from the root to its parent. */
export const graphLeafAncestors = (tokens: Available, at: number): string =>
  tokens.ancestors[row(tokens, at)[6]] ?? "";

/** How many of a leaf's ancestors begin at it (it is their first leaf). */
export const graphLeafOpens = (tokens: Available, at: number): number =>
  row(tokens, at)[7];

/**
 * The import statements that contain a leaf (its bytes wholly inside the statement's range): none,
 * one, or for Python's `import a, b` each object of that one statement. Empty for a file whose
 * bindings are not extracted.
 */
export const graphImportStatementsAt = (
  tokens: Available,
  at: number,
): readonly GraphImportStatement[] => {
  const [, start, end] = row(tokens, at);
  if (tokens.imports.status !== "extracted") return [];
  return tokens.imports.statements.filter(
    (statement) => statement.startByte <= start && end <= statement.endByte,
  );
};

/**
 * The bytes between two leaves, read from the caller's own copy of the file. `none`: no byte;
 * `inline`: no line feed; `newline`: at least one. `plain`: only spaces and line feeds (no tab and
 * no carriage return), so two plain gaps of one kind differ only in how many of each they hold. No
 * language knowledge: what a gap means is the consumer's rule.
 */
export type GraphGap = Readonly<{
  kind: "none" | "inline" | "newline";
  plain: boolean;
  startByte: number;
  endByte: number;
}>;

const gapOf = (
  bytes: Uint8Array,
  startByte: number,
  endByte: number,
): GraphGap => {
  if (startByte > endByte || endByte > bytes.byteLength)
    throw new RangeError("These are not the bytes the leaves were read from.");
  let newline = false;
  let plain = true;
  for (let at = startByte; at < endByte; at++) {
    const byte = bytes[at] ?? 0;
    // A gap holds only layout bytes in the file the leaves were read from.
    if (!isLayout(byte))
      throw new RangeError(
        "These are not the bytes the leaves were read from.",
      );
    if (byte === 0x0a) newline = true;
    else if (byte !== 0x20) plain = false;
  }
  return {
    kind: startByte === endByte ? "none" : newline ? "newline" : "inline",
    plain,
    startByte,
    endByte,
  };
};

/**
 * The gap before a leaf: from the previous leaf's end, or the file's start after a byte-order mark.
 * The accessors give the whitespace between rows only. A consumer that leaves a comment out of a
 * comparison must count that comment's own bytes in the stretch between the leaves it compares: a
 * line feed inside the comment is a line break there, though no gap holds it (a block comment with
 * a line break between `return` and its value ends the statement in TypeScript and Go).
 */
export const graphGapBefore = (
  tokens: Available,
  bytes: Uint8Array,
  at: number,
): GraphGap =>
  gapOf(
    bytes,
    at === 0 ? bomLength(bytes) : row(tokens, at - 1)[2],
    row(tokens, at)[1],
  );

/** The gap from the last leaf (or the file's start, after a byte-order mark) to the file's end. */
export const graphGapAfterLast = (
  tokens: Available,
  bytes: Uint8Array,
): GraphGap =>
  gapOf(bytes, tokens.leaves.at(-1)?.[2] ?? bomLength(bytes), bytes.byteLength);
