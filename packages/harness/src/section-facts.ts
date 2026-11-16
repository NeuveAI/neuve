import { Effect } from "effect";
import { z } from "zod";
import { Computations, canonicalJson, sha256Hex } from "@neuve/records-core";
import {
  blobStructures,
  hunkBlobEntries,
  structuresByBlob,
} from "./blob-structure.ts";
import { cpuWork } from "./budget/cpu.ts";
import type { OutlineSource } from "./graph-outline.ts";
import { hunkContentKey } from "./hunks.ts";
import type { ManifestHunk } from "./manifest.ts";
import { decodeJson } from "./search-index.ts";
import {
  SECTION_IDENTITY_RECIPE,
  sectionIdentities,
  type SectionIdentity,
  type SectionIdentityParts,
} from "./section-identity.ts";
import {
  BLOB_STRUCTURE_RECIPE,
  SECTIONS_RECIPE,
  StructureReason,
  asStructure,
  codePoints,
  declarationCounterparts,
  sectionPlace,
  sectionsOf,
  spanIndexAt,
  type BlobStructure,
  type Section,
  type Structure,
} from "./sections.ts";
import { repositoryOwner } from "./budget/owner.ts";

/**
 * Change facts per section: what happened to a section's declaration, read from the hunks, the
 * stored structures of both blobs and the repository's declarations. Facts are evidence (10.22):
 * nothing here scores, ranks or weighs them, and none is folded into another. Each fact names the
 * stored fields it was read from (`evidence`), and a fact that cannot be told from what is stored
 * says so (`value` null, with `reason`) and is never given a default.
 *
 * The facts, per section:
 * - `declaration`: `added` (the head has the span, it has no counterpart, and the base has no span
 *   of its kind and name left unmatched; an unnamed span only when every one of its lines is added
 *   here), `removed` (old side only, and the head has a structure with no span of its kind and name
 *   left unmatched, or the file is deleted), `changed` (a counterpart on both sides; the statement
 *   says how it was matched: by the same text, or by kind and name at the same position among
 *   them), or not known (`ambiguous-namesake` where several declarations share the name and one is
 *   left on each side). Counterparts are `declarationCounterparts`, the one rule `sectionsOf` pairs
 *   by.
 * - `old-side-only`: every row the section owns is on the old side.
 * - `declared-kind`: the kinds the repository declares the file as (`generated`, `test`, `doc`),
 *   from the hunks' `declared`; empty when undeclared.
 * - `size`: added and removed rows, changed characters (code points of the owned rows' text,
 *   without the sign), and the span's lines and characters on each side (null where that side has
 *   no span).
 * - `symbol`: Graph's kind and container of the symbol that names the span.
 * - `signature` (one per symbol present in both sides' spans, matched by kind, container, name and
 *   occurrence): whether Graph's signature differs. Not known where either side has no signature.
 * - `symbols-added`, `symbols-removed`: the span's symbols with no match on the other side.
 * - `body-changed`, for a declaration on both sides, over every Graph symbol of its span, of any
 *   name. False when the span's text is the same on both sides; when the whole declaration moved
 *   unchanged (`movedWhole`: the section owns every non-blank line of both spans, and they read the
 *   same in order); or when no non-blank row it owns lies inside the lines of any symbol of the span
 *   and none lies there blank either. Blank rows count for none of the rules below; where only
 *   blank rows changed inside a symbol's lines (or under a Markdown heading) the fact is not known
 *   (`blank-lines-only`), since a blank line in a template string, a heredoc or a code block is
 *   content. True when a member (a symbol with a
 *   container) was added or removed, or when a row it owns lies on a line after the first of a
 *   symbol whose signature is given and the same on both sides (Graph's `startLine`-`endLine`, on
 *   that row's side). Otherwise not known: a signature changed or is not given where the change is,
 *   the change is in a symbol on one side only, or only first lines changed (they hold the
 *   signature, and keywords it leaves out, such as `export`). A span with no symbols on either side
 *   is not known. A Markdown section's first line is its heading by construction (it has no
 *   symbols): its body changed exactly when a row it owns lies after that line. A change to a later
 *   line of a signature that Graph's signature string does not carry counts as body.
 *
 * Public names are not a fact here: Graph gives no visibility per symbol, so they could be read
 * only from the statement's text, which `lane-rule.ts`'s `publicSurface` already does. Evidence for
 * such a fact would have to come from Graph: an exported flag or visibility per symbol, containers
 * for class and function expressions inside a declaration, and symbols for constants, fields and
 * re-exports.
 *
 * Pure and synchronous, except `storedSectionFacts`, which reads the structures and stores the
 * result under `harness.section-facts@1`.
 */
/** 2: public names are no longer facts; the stored structure lost its default-export mark. */
export const SECTION_FACTS_RECIPE = "neuve-section-facts-v2";

export const SectionFactName = z.enum([
  "declaration",
  "old-side-only",
  "declared-kind",
  "size",
  "symbol",
  "signature",
  "symbols-added",
  "symbols-removed",
  "body-changed",
]);
export type SectionFactName = z.infer<typeof SectionFactName>;

export const SectionFact = z.strictObject({
  /** `<identity key>.<fact>`, and for a symbol's signature `<identity key>.signature:<symbol>`. */
  id: z.string(),
  about: z.strictObject({
    kind: z.literal("section"),
    /** The section's identity key (`sectionIdentities`). */
    key: z.string().regex(/^[0-9a-f]{64}$/),
    path: z.string(),
  }),
  fact: SectionFactName,
  /** Null exactly when the fact is not known. */
  value: z
    .union([
      z.number(),
      z.boolean(),
      z.string(),
      z.array(z.string()),
      z.record(z.string(), z.union([z.number(), z.string(), z.null()])),
    ])
    .nullable(),
  /** Why the value is not known; null when it is. */
  reason: z.string().nullable(),
  statement: z.string(),
  /** The stored fields the fact was read from. */
  evidence: z.array(z.string()),
});
export type SectionFact = z.infer<typeof SectionFact>;

type StoredSpan = BlobStructure["spans"][number];
type StoredSymbol = StoredSpan["symbols"][number];

const byCodeUnits = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The kinds the repository's own declarations give, and Linguist's lists that mark (`standard`). */
const declaredBy = (hunks: ReadonlyArray<Pick<ManifestHunk, "declared">>) => {
  const entries = hunks.flatMap((hunk) => hunk.declared);
  return {
    repository: [
      ...new Set(
        entries
          .filter((entry) => entry.standard === undefined)
          .map((entry) => entry.kind),
      ),
    ].sort(byCodeUnits),
    linguist: [
      ...new Set(
        entries.flatMap((entry) =>
          entry.standard === undefined ? [] : [entry.standard],
        ),
      ),
    ].sort(byCodeUnits),
  };
};

const EVIDENCE = {
  ranges: "section.ranges",
  text: "hunk.text",
  status: "hunk.status",
  declared: "hunk.declared[].kind",
  spanName: "structure.spans[].kind,name",
  spanText: "structure.spans[].textSha256",
  spanSize: "structure.spans[].lines,characters",
  symbols: "structure.spans[].symbols[].kind,name,container",
  qualified: "structure.spans[].symbols[].qualifiedName",
  signature: "structure.spans[].symbols[].signature",
  symbolLines: "structure.spans[].symbols[].startLine,endLine",
} as const;

/** One row a section owns, with its text. Counted as `changedBlocks` counts. */
const ownedRows = (section: Section, hunk: ManifestHunk) => {
  const owned = new Set<string>();
  for (const range of section.ranges)
    if (range.hunkId === hunk.hunkId)
      for (let at = 0; at < range.lineCount; at++)
        owned.add(`${range.side}:${range.startLine + at}`);
  const rows: Array<{
    side: "old" | "new";
    line: number;
    text: string;
    /** False only where Git's "no newline at end of file" marker follows the row. */
    newline: boolean;
  }> = [];
  if (hunk.kind !== "text") return rows;
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  // The row just before the current one, when this section owns it: the one a marker would end.
  let previous: (typeof rows)[number] | undefined;
  for (const row of hunk.text.split("\n").slice(1)) {
    if (row.startsWith("\\")) {
      if (previous !== undefined) previous.newline = false;
      previous = undefined;
      continue;
    }
    if (row === "") continue;
    previous = undefined;
    if (row.startsWith("-") || row.startsWith("+")) {
      const side = row.startsWith("-") ? "old" : "new";
      const line = side === "old" ? oldLine++ : newLine++;
      if (owned.has(`${side}:${line}`)) {
        previous = { side, line, text: row.slice(1), newline: true };
        rows.push(previous);
      }
      continue;
    }
    oldLine++;
    newLine++;
  }
  return rows;
};

/**
 * The symbols of two spans matched by kind, container, name and occurrence in Graph's order.
 * Exported for the readers' evidence check; a change to this rule changes `SECTION_FACTS_RECIPE`.
 */
export const matchSymbols = (
  base: ReadonlyArray<StoredSymbol>,
  head: ReadonlyArray<StoredSymbol>,
) => {
  const keyed = (symbols: ReadonlyArray<StoredSymbol>) => {
    const seen = new Map<string, number>();
    return symbols.map((symbol) => {
      // Each part encoded, so a name or container holding `:` cannot collide with another.
      const key = [symbol.kind, symbol.container ?? "", symbol.name]
        .map(encodeURIComponent)
        .join(":");
      const count = (seen.get(key) ?? 0) + 1;
      seen.set(key, count);
      return { key: `${key}:${count}`, symbol };
    });
  };
  const headKeyed = keyed(head);
  const headByKey = new Map(headKeyed.map((entry) => [entry.key, entry]));
  const baseKeys = new Set<string>();
  const matched: Array<{
    key: string;
    base: StoredSymbol;
    head: StoredSymbol;
  }> = [];
  const removed: Array<StoredSymbol> = [];
  for (const entry of keyed(base)) {
    baseKeys.add(entry.key);
    const other = headByKey.get(entry.key);
    if (other === undefined) removed.push(entry.symbol);
    else
      matched.push({ key: entry.key, base: entry.symbol, head: other.symbol });
  }
  const added = headKeyed
    .filter((entry) => !baseKeys.has(entry.key))
    .map((entry) => entry.symbol);
  return { matched, added, removed };
};

const symbolLabel = (symbol: StoredSymbol) =>
  `${symbol.kind} ${symbol.qualifiedName}`;

/** The one blob all the section's hunks name on a side, and its structure. */
const sideOf = (
  section: Section,
  hunks: ReadonlyArray<ManifestHunk>,
  side: "old" | "new",
  structures: ReadonlyMap<string, BlobStructure>,
) => {
  const blobs = new Set(
    hunks.map((hunk) => (side === "new" ? hunk.newOid : hunk.oldOid)),
  );
  if (blobs.size !== 1)
    throw new Error(
      `Section of ${section.path} has hunks naming different ${side} blobs`,
    );
  const [blob] = blobs;
  return blob === null || blob === undefined
    ? { blob: null, structure: undefined }
    : { blob, structure: structures.get(blob) };
};

/** The index of the span at exactly `startLine`-`endLine`, which the section's place claims. */
const claimedSpan = (
  section: Section,
  structure: BlobStructure | undefined,
  side: "old" | "new",
  startLine: number,
  endLine: number,
) => {
  const index = spanIndexAt(structure, startLine);
  const span = index === undefined ? undefined : structure?.spans[index];
  if (index === undefined || span === undefined || span.end !== endLine)
    throw new Error(
      `Section of ${section.path} claims ${side}-side span ${startLine}-${endLine}, which its structure does not have`,
    );
  return index;
};

type OwnedRow = ReturnType<typeof ownedRows>[number];

/**
 * Whether the section moved a whole declaration unchanged: on each side the rows it owns there all
 * lie in that side's span, take in every non-blank line of the span, and leave out only empty lines
 * (told from the span's stored size: the lines it does not own hold one newline each); and the
 * non-blank rows read the same, in order, on both sides. A span's line it does not own that ends
 * the file is not told (its newline is not shown), and makes this false.
 */
const movedWhole = (
  base: StoredSpan,
  baseLines: number,
  head: StoredSpan,
  headLines: number,
  rows: ReadonlyArray<OwnedRow>,
) => {
  const whole = (span: StoredSpan, lines: number, side: "old" | "new") => {
    const own = rows.filter((row) => row.side === side);
    if (own.some((row) => row.line < span.start || row.line > span.end))
      return undefined;
    const covered = new Set(own.map((row) => row.line));
    const left = span.lines - covered.size;
    if (span.end === lines && !covered.has(span.end)) return undefined;
    const used = own.reduce(
      (sum, row) => sum + codePoints(row.text) + (row.newline ? 1 : 0),
      0,
    );
    if (span.characters - used !== left) return undefined;
    return own.filter((row) => row.text.trim() !== "").map((row) => row.text);
  };
  const was = whole(base, baseLines, "old");
  const is = whole(head, headLines, "new");
  return (
    was !== undefined &&
    is !== undefined &&
    was.length > 0 &&
    was.length === is.length &&
    was.every((text, index) => text === is[index])
  );
};

/**
 * Whether the declaration's body changed, by the definition in the module comment: from its text
 * hash, the rows it owns and their text, and every Graph symbol of its span on each side, with
 * their signatures and lines.
 */
const bodyChange = (
  base: StoredSpan,
  baseLines: number,
  head: StoredSpan,
  headLines: number,
  capability: BlobStructure["capability"],
  rows: ReadonlyArray<OwnedRow>,
): { value: boolean | null; statement: string; reason?: string } => {
  if (base.textSha256 === head.textSha256)
    return {
      value: false,
      statement: "the span's text is the same on both sides",
    };
  if (movedWhole(base, baseLines, head, headLines, rows))
    return {
      value: false,
      statement:
        "the whole declaration moved unchanged: every non-blank line of it was removed in one place and added in another, in the same order",
    };
  // Blank rows change no body: the rules below read the others.
  const marked = rows.filter((row) => row.text.trim() !== "");
  const after = (side: "old" | "new", first: number, last: number) =>
    marked.some(
      (row) => row.side === side && row.line > first && row.line <= last,
    );
  if (capability === "markdown-sections") {
    // A heading section's first line is its heading, by construction; the rest is its body.
    const changed =
      after("old", base.start, base.end) || after("new", head.start, head.end);
    if (changed)
      return { value: true, statement: "a line under its heading changed" };
    // A blank line under a heading can be inside a code block, where it is content.
    if (
      rows.some(
        (row) =>
          row.text.trim() === "" &&
          (row.side === "old"
            ? row.line > base.start && row.line <= base.end
            : row.line > head.start && row.line <= head.end),
      )
    )
      return {
        value: null,
        statement: "not known: only blank lines changed under its heading",
        reason: "blank-lines-only",
      };
    return { value: false, statement: "only its heading line changed" };
  }
  if (base.symbols.length === 0 && head.symbols.length === 0)
    return {
      value: null,
      statement: "not known: Graph gives the span no symbols",
      reason: "no-symbols",
    };
  const holds = (symbol: StoredSymbol, line: number) =>
    line >= symbol.startLine && line <= symbol.endLine;
  const inSymbol = marked.some((row) =>
    (row.side === "old" ? base : head).symbols.some((symbol) =>
      holds(symbol, row.line),
    ),
  );
  if (!inSymbol) {
    // A blank line inside a declaration can be content (in a template string, a heredoc).
    if (
      rows.some(
        (row) =>
          row.text.trim() === "" &&
          (row.side === "old" ? base : head).symbols.some((symbol) =>
            holds(symbol, row.line),
          ),
      )
    )
      return {
        value: null,
        statement: "not known: only blank lines changed inside the declaration",
        reason: "blank-lines-only",
      };
    return {
      value: false,
      statement:
        "no changed line but blank ones is inside any symbol Graph gives the span",
    };
  }
  const { matched, added, removed } = matchSymbols(base.symbols, head.symbols);
  if ([...added, ...removed].some((symbol) => symbol.container !== null))
    return {
      value: true,
      statement: "a member was added to or removed from it",
    };
  const steady = (pair: (typeof matched)[number]) =>
    pair.base.signature !== null &&
    pair.head.signature !== null &&
    pair.base.signature === pair.head.signature;
  if (
    matched.some(
      (pair) =>
        steady(pair) &&
        (after("old", pair.base.startLine, pair.base.endLine) ||
          after("new", pair.head.startLine, pair.head.endLine)),
    )
  )
    return {
      value: true,
      statement:
        "a line of one of its symbols after the symbol's first changed, and Graph's signature string for that symbol is unchanged",
    };
  // Why it cannot be told, from the symbols that hold a changed row.
  const holding = matched.filter((pair) =>
    marked.some((row) =>
      holds(row.side === "old" ? pair.base : pair.head, row.line),
    ),
  );
  if (
    holding.some(
      (pair) =>
        pair.base.signature !== null &&
        pair.head.signature !== null &&
        !steady(pair),
    )
  )
    return {
      value: null,
      statement:
        "not known: Graph's signature string changed where the change is",
      reason: "signature-changed",
    };
  if (
    holding.some(
      (pair) => pair.base.signature === null || pair.head.signature === null,
    )
  )
    return {
      value: null,
      statement: "not known: Graph gives no signature where the change is",
      reason: "signature-not-given",
    };
  if (
    marked.some((row) =>
      (row.side === "old" ? removed : added).some((symbol) =>
        holds(symbol, row.line),
      ),
    )
  )
    return {
      value: null,
      statement:
        "not known: a changed line is in a top-level symbol found on one side only",
      reason: "symbols-added-or-removed",
    };
  return {
    value: null,
    statement:
      "not known: only first lines of its symbols changed, which hold their signatures",
    reason: "first-line-only",
  };
};

/** Whether a span has a name of its own to be found by: an import block, or a named span that is not a suite's head or tail. */
const ownName = (span: StoredSpan) =>
  span.kind === "imports" ||
  (span.name !== null &&
    span.name !== "" &&
    span.kind !== "head" &&
    span.kind !== "tail");

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

/**
 * The change facts of each section, in the sections' order. `identities` is `sectionIdentities`'s
 * output for the same sections, `hunks` the sections' hunks by hunk id and `structures` each blob's
 * stored structure by object id, as `sectionsOf` was given them. A section without an identity, or
 * one that claims a span its structure does not have, throws.
 */
export const sectionFactsOf = (
  sections: ReadonlyArray<Section>,
  identities: ReadonlyMap<string, SectionIdentity>,
  hunks: ReadonlyMap<string, ManifestHunk>,
  structures: ReadonlyMap<string, BlobStructure>,
): ReadonlyArray<SectionFact> => {
  const facts: Array<SectionFact> = [];
  for (const section of sections) {
    const identity = identities.get(section.key);
    if (identity === undefined)
      throw new Error(`Section of ${section.path} has no identity given`);
    const about = {
      kind: "section" as const,
      key: identity.key,
      path: section.path,
    };
    const add = (
      fact: SectionFactName,
      value: SectionFact["value"],
      statement: string,
      evidence: ReadonlyArray<string>,
      options: {
        readonly reason?: string;
        readonly id?: string;
      } = {},
    ) =>
      facts.push({
        id: `${identity.key}.${options.id ?? fact}`,
        about,
        fact,
        value,
        reason: value === null ? (options.reason ?? "not-known") : null,
        statement,
        evidence: [...evidence],
      });
    const own = section.hunkIds.map((hunkId) => {
      const hunk = hunks.get(hunkId);
      if (hunk === undefined || hunk.path !== section.path)
        throw new Error(
          `Section of ${section.path} names hunk ${hunkId}, which is not given for it`,
        );
      return hunk;
    });
    const place = sectionPlace(section);
    const head = sideOf(section, own, "new", structures);
    const base = sideOf(section, own, "old", structures);
    const counterparts = declarationCounterparts(
      base.structure,
      head.structure,
    );
    const headIndex =
      place.side === "new"
        ? claimedSpan(
            section,
            head.structure,
            "new",
            place.startLine,
            place.endLine,
          )
        : undefined;
    const baseIndex =
      place.side === "old"
        ? claimedSpan(
            section,
            base.structure,
            "old",
            place.startLine,
            place.endLine,
          )
        : headIndex === undefined
          ? undefined
          : counterparts.toBase[headIndex];
    const headSpan =
      headIndex === undefined ? undefined : head.structure?.spans[headIndex];
    const baseSpan =
      baseIndex === undefined ? undefined : base.structure?.spans[baseIndex];
    const rows = own.flatMap((hunk) => ownedRows(section, hunk));
    const added = rows.filter((row) => row.side === "new");
    const removed = rows.filter((row) => row.side === "old");
    const noSpan = `section-basis:${section.basis}`;
    const noSpanWhy = `the section has no span (${section.basis})`;

    // What happened to the declaration.
    if (place.side === "none")
      add("declaration", null, `not known: ${noSpanWhy}`, [EVIDENCE.ranges], {
        reason: noSpan,
      });
    else if (place.side === "old") {
      if (head.blob === null)
        add("declaration", "removed", "removed: the file is deleted", [
          EVIDENCE.status,
          EVIDENCE.spanName,
        ]);
      else if (
        head.structure === undefined ||
        head.structure.capability === "none"
      )
        add(
          "declaration",
          null,
          "not known: the head has no structure to look for the declaration in",
          [EVIDENCE.spanName],
          {
            reason:
              head.structure === undefined
                ? "structure-missing"
                : `structure:${head.structure.reason ?? "outline-unavailable"}`,
          },
        );
      else if (baseSpan !== undefined && !ownName(baseSpan))
        // A span with no name of its own has no counterpart rule but its exact text: that it is not
        // in the head does not show it was removed (a blank line removed from it changes its text).
        add(
          "declaration",
          null,
          "not known: the span has no name to find it by in the head",
          [EVIDENCE.spanName, EVIDENCE.spanText],
          { reason: "unnamed-span" },
        );
      else if (
        baseIndex !== undefined &&
        counterparts.baseNamesakes[baseIndex] === true
      )
        add(
          "declaration",
          null,
          "not known: several declarations share its kind and name, and the head keeps one with no counterpart, so which was removed cannot be told",
          [EVIDENCE.spanName, EVIDENCE.spanText],
          { reason: "ambiguous-namesake" },
        );
      else
        add(
          "declaration",
          "removed",
          "removed: the head has no declaration of its kind and name left unmatched",
          [EVIDENCE.ranges, EVIDENCE.spanName, EVIDENCE.spanText],
        );
    } else if (base.blob === null)
      add("declaration", "added", "added: the file is new", [EVIDENCE.status]);
    else if (
      base.structure === undefined ||
      base.structure.capability === "none"
    )
      add(
        "declaration",
        null,
        "not known: the base has no structure to look for the declaration in",
        [EVIDENCE.spanName],
        {
          reason:
            base.structure === undefined
              ? "structure-missing"
              : `structure:${base.structure.reason ?? "outline-unavailable"}`,
        },
      );
    else if (baseSpan !== undefined)
      add(
        "declaration",
        "changed",
        headIndex !== undefined && counterparts.matchedBy[headIndex] === "text"
          ? "changed: matched to a base span of the same text"
          : headIndex !== undefined &&
              counterparts.matchedBy[headIndex] === "imports"
            ? "changed: matched to the base's import block by position"
            : "changed: matched to the base's declaration of the same kind and name, by position among them",
        [EVIDENCE.spanName, EVIDENCE.spanText],
      );
    else if (
      headIndex !== undefined &&
      counterparts.headNamesakes[headIndex] === true
    )
      add(
        "declaration",
        null,
        "not known: several declarations share its kind and name, and the base keeps one with no counterpart, so whether this one is new cannot be told",
        [EVIDENCE.spanName, EVIDENCE.spanText],
        { reason: "ambiguous-namesake" },
      );
    else if (headSpan !== undefined && ownName(headSpan))
      add(
        "declaration",
        "added",
        headSpan.kind === "imports"
          ? "added: the base has no import block in its place"
          : "added: the base has no declaration of this kind and name left unmatched",
        [EVIDENCE.spanName, EVIDENCE.spanText],
      );
    else if (
      headSpan !== undefined &&
      new Set(added.map((row) => row.line)).size ===
        headSpan.end - headSpan.start + 1 &&
      added.every(
        (row) => row.line >= headSpan.start && row.line <= headSpan.end,
      )
    )
      add(
        "declaration",
        "added",
        "added: every line of this unnamed span is added",
        [EVIDENCE.spanName, EVIDENCE.text],
      );
    else
      add(
        "declaration",
        null,
        "not known: the span has no name to find it by in the base",
        [EVIDENCE.spanName],
        { reason: "unnamed-span" },
      );

    // Old side only.
    const oldOnly =
      section.ranges.length > 0 &&
      section.ranges.every((range) => range.side === "old");
    add(
      "old-side-only",
      oldOnly,
      oldOnly
        ? "every line it owns is on the old side"
        : "it owns lines on the new side",
      [EVIDENCE.ranges],
    );

    // Declared file kind.
    const kinds = [
      ...new Set(
        own.flatMap((hunk) => hunk.declared.map((entry) => entry.kind)),
      ),
    ].sort(byCodeUnits);
    // A kind only GitHub Linguist's lists give (the `linguist` reader's suggestions carry
    // `standard`) is worded as Linguist's mark, not as the repository's declaration.
    const { repository: ownKinds, linguist: lists } = declaredBy(own);
    add(
      "declared-kind",
      kinds,
      kinds.length === 0
        ? "the repository declares no kind for the file"
        : [
            ...(ownKinds.length === 0
              ? []
              : [`the repository declares the file ${ownKinds.join(", ")}`]),
            ...(lists.length === 0
              ? []
              : [
                  `GitHub Linguist's ${lists.map((list) => (list === "linguist-vendored" ? "vendored" : "generated")).join(" and ")} ${lists.length === 1 ? "list marks" : "lists mark"} it`,
                ]),
          ].join("; "),
      [EVIDENCE.declared],
    );

    // Size.
    const changedCharacters = rows.reduce(
      (sum, row) => sum + codePoints(row.text),
      0,
    );
    add(
      "size",
      {
        addedRows: added.length,
        removedRows: removed.length,
        changedCharacters,
        headLines: headSpan?.lines ?? null,
        headCharacters: headSpan?.characters ?? null,
        baseLines: baseSpan?.lines ?? null,
        baseCharacters: baseSpan?.characters ?? null,
      },
      `${plural(added.length, "added row")}, ${plural(removed.length, "removed row")}, ${plural(changedCharacters, "changed character")}${headSpan === undefined ? "" : `; the head span has ${plural(headSpan.lines, "line")}`}${baseSpan === undefined ? "" : `; the base span has ${plural(baseSpan.lines, "line")}`}`,
      [EVIDENCE.text, EVIDENCE.ranges, EVIDENCE.spanSize],
    );

    // The symbol that names the span.
    const span = place.side === "old" ? baseSpan : headSpan;
    if (span === undefined)
      add("symbol", null, `not known: ${noSpanWhy}`, [EVIDENCE.ranges], {
        reason: noSpan,
      });
    else {
      const named =
        span.name === null
          ? undefined
          : span.symbols.find((symbol) => symbol.name === span.name);
      if (named === undefined)
        add(
          "symbol",
          null,
          span.name === null
            ? "not known: the span has no name"
            : "not known: Graph gives no symbol of the span's name",
          [EVIDENCE.spanName, EVIDENCE.symbols],
          { reason: span.name === null ? "unnamed-span" : "no-symbol" },
        );
      else
        add(
          "symbol",
          { kind: named.kind, container: named.container },
          `a ${named.kind}${named.container === null ? " at top level" : ` in ${named.container}`}`,
          [EVIDENCE.symbols],
        );
    }

    // Signatures, symbols added and removed, and the body.
    if (headSpan === undefined || baseSpan === undefined) {
      const why =
        place.side === "none"
          ? noSpanWhy
          : "the declaration is not on both sides";
      const reason = place.side === "none" ? noSpan : "no-counterpart";
      for (const fact of [
        "symbols-added",
        "symbols-removed",
        "body-changed",
      ] as const)
        add(fact, null, `not known: ${why}`, [EVIDENCE.spanName], { reason });
    } else {
      const {
        matched,
        added: newSymbols,
        removed: oldSymbols,
      } = matchSymbols(baseSpan.symbols, headSpan.symbols);
      for (const pair of matched) {
        const known =
          pair.base.signature !== null && pair.head.signature !== null;
        add(
          "signature",
          known ? pair.base.signature !== pair.head.signature : null,
          known
            ? pair.base.signature === pair.head.signature
              ? `${symbolLabel(pair.head)}: Graph's signature string is unchanged`
              : `${symbolLabel(pair.head)}: Graph's signature string changed`
            : `${symbolLabel(pair.head)}: not known, Graph gives no signature on ${pair.base.signature === null && pair.head.signature === null ? "either side" : pair.base.signature === null ? "the base" : "the head"}`,
          [EVIDENCE.symbols, EVIDENCE.signature],
          { id: `signature:${pair.key}`, reason: "signature-not-given" },
        );
      }
      add(
        "symbols-added",
        newSymbols.map(symbolLabel),
        newSymbols.length === 0
          ? "Graph gives no symbol in the head span that the base span lacks"
          : `Graph gives these symbols in the head span and not the base span: ${newSymbols.map(symbolLabel).join(", ")}`,
        [EVIDENCE.symbols, EVIDENCE.qualified],
      );
      add(
        "symbols-removed",
        oldSymbols.map(symbolLabel),
        oldSymbols.length === 0
          ? "Graph gives no symbol in the base span that the head span lacks"
          : `Graph gives these symbols in the base span and not the head span: ${oldSymbols.map(symbolLabel).join(", ")}`,
        [EVIDENCE.symbols, EVIDENCE.qualified],
      );
      const body = bodyChange(
        baseSpan,
        base.structure!.lines,
        headSpan,
        head.structure!.lines,
        base.structure!.capability,
        rows,
      );
      add(
        "body-changed",
        body.value,
        body.statement,
        [
          EVIDENCE.spanText,
          EVIDENCE.symbols,
          EVIDENCE.signature,
          EVIDENCE.symbolLines,
          EVIDENCE.text,
        ],
        body.reason === undefined ? {} : { reason: body.reason },
      );
    }
  }
  return facts;
};

/** The order a set of hunks is computed in, whatever order it is given in. */
const canonicalHunks = (hunks: ReadonlyArray<ManifestHunk>) => {
  const byId = new Map<string, ManifestHunk>();
  for (const hunk of hunks) {
    const held = byId.get(hunk.hunkId);
    if (held !== undefined && canonicalJson(held) !== canonicalJson(hunk))
      throw new Error(`Two different hunks share the id ${hunk.hunkId}`);
    byId.set(hunk.hunkId, hunk);
  }
  return [...byId.values()].sort(
    (a, b) =>
      byCodeUnits(a.path, b.path) ||
      a.newStart - b.newStart ||
      a.oldStart - b.oldStart ||
      byCodeUnits(a.hunkId, b.hunkId),
  );
};

/** The text hunks' blobs, each once, in code-unit order. */
const blobsOf = (hunks: ReadonlyArray<ManifestHunk>) =>
  [
    ...new Set(
      hunks.flatMap((hunk) =>
        hunk.kind === "text"
          ? [hunk.oldOid, hunk.newOid].filter(
              (oid): oid is string => oid !== null,
            )
          : [],
      ),
    ),
  ].sort(byCodeUnits);

/**
 * The key of a set of hunks' section facts: exactly what the computation reads. Each hunk's id (its
 * paths and full text), content key, kind, paths, blobs, status, modes, owned ranges and declared
 * kinds; each text blob's structure as a SHA-256 of its canonical JSON (so a blob whose structure
 * changes, from a structure with none such as `conflicting-paths` or a retryable outcome to a cut,
 * gives another key), or null where the map given has none (a direct caller's map; through
 * `storedSectionFacts` every text blob has one); and the recipes of
 * sections, the stored structure, identity and these facts. Hunks and blobs are sorted, so the order
 * they are given in does not move the key.
 */
export const sectionFactsSpec = (
  hunks: ReadonlyArray<ManifestHunk>,
  structures: ReadonlyMap<string, BlobStructure>,
): Computations.ComputationSpec => {
  const ordered = canonicalHunks(hunks);
  return {
    op: "harness.section-facts",
    opVersion: 1,
    inputs: {
      hunks: [...ordered]
        .sort((a, b) => byCodeUnits(a.hunkId, b.hunkId))
        .map((hunk) => ({
          hunkId: hunk.hunkId,
          contentKey: hunk.contentKey ?? hunkContentKey(hunk),
          kind: hunk.kind,
          path: hunk.path,
          oldPath: hunk.oldPath,
          newPath: hunk.newPath,
          oldBlob: hunk.oldOid === null ? null : `git-blob:${hunk.oldOid}`,
          newBlob: hunk.newOid === null ? null : `git-blob:${hunk.newOid}`,
          status: hunk.status,
          oldMode: hunk.oldMode,
          newMode: hunk.newMode,
          ownedRanges: hunk.ownedRanges.map((range) => ({
            side: range.side,
            startLine: range.startLine,
            lineCount: range.lineCount,
          })),
          declared: [...new Set(hunk.declared.map((entry) => entry.kind))].sort(
            byCodeUnits,
          ),
          // Only where Linguist's lists mark the file, so every other key is what it was: the
          // `declared-kind` statement words the repository's kinds and Linguist's lists apart.
          ...(hunk.declared.some((entry) => entry.standard !== undefined)
            ? { declaredBy: declaredBy([hunk]) }
            : {}),
        })),
      structures: blobsOf(ordered).map((blob) => {
        const structure = structures.get(blob);
        return [
          `git-blob:${blob}`,
          structure === undefined ? null : sha256Hex(canonicalJson(structure)),
        ];
      }),
    },
    config: {
      recipe: SECTION_FACTS_RECIPE,
      sections: SECTIONS_RECIPE,
      blobStructure: BLOB_STRUCTURE_RECIPE,
      identity: SECTION_IDENTITY_RECIPE,
    },
  };
};

const StoredRange = z.strictObject({
  hunkId: z.string(),
  side: z.enum(["old", "new"]),
  startLine: z.int().min(0),
  lineCount: z.int().min(0),
});

const StoredSection = z.strictObject({
  key: z.string(),
  path: z.string(),
  name: z.string().nullable(),
  kind: z.enum([
    "imports",
    "declaration",
    "statement",
    "member",
    "heading",
    "head",
    "tail",
    "hunk",
    "nontext",
  ]),
  basis: z.enum([
    "graph-symbols",
    "markdown-sections",
    ...StructureReason.options,
    "undeclared",
    "rules",
    "nontext",
  ]),
  hunkIds: z.array(z.string()),
  ranges: z.array(StoredRange),
  first: z.number(),
});

const StoredIdentity = z.strictObject({
  section: z.string(),
  key: z.string(),
  parts: z.strictObject({
    path: z.string(),
    side: z.enum(["new", "old", "none"]),
    kind: StoredSection.shape.kind,
    name: z.string().nullable(),
    spanSha256: z.string().nullable(),
    counterpartSha256: z.string().nullable(),
    hunkContentKeys: z.array(z.string()),
    changeSha256: z.string(),
    ordinal: z.int().min(1),
  }),
  where: z.strictObject({ startLine: z.int(), endLine: z.int() }).nullable(),
  renamedFrom: z.string().nullable(),
});

// The stored identity names exactly `SectionIdentityParts`'s fields; the compiler holds it both ways.
type SameKeys<A, B> = [keyof A] extends [keyof B]
  ? [keyof B] extends [keyof A]
    ? true
    : false
  : false;
const identityPartsStored: SameKeys<
  z.infer<typeof StoredIdentity>["parts"],
  SectionIdentityParts
> = true;
void identityPartsStored;

/** What `harness.section-facts@1` stores: the sections, their identities and their facts. */
export const SectionFactsOutput = z.strictObject({
  sections: z.array(StoredSection),
  identities: z.array(StoredIdentity),
  facts: z.array(SectionFact),
});
export type SectionFactsOutput = z.infer<typeof SectionFactsOutput>;

export interface SectionFactsResult {
  readonly sections: ReadonlyArray<Section>;
  readonly identities: ReadonlyMap<string, SectionIdentity>;
  readonly facts: ReadonlyArray<SectionFact>;
}

/** The sections, identities and facts of a set of hunks, whatever order they are given in. */
export const computeSectionFacts = (
  hunks: ReadonlyArray<ManifestHunk>,
  structures: ReadonlyMap<string, BlobStructure>,
): SectionFactsResult => {
  const ordered = canonicalHunks(hunks);
  const sections = sectionsOf(
    ordered,
    new Map<string, Structure>(
      [...structures].map(([blob, structure]) => [
        blob,
        asStructure(structure),
      ]),
    ),
  );
  const byId = new Map(ordered.map((hunk) => [hunk.hunkId, hunk]));
  const identities = sectionIdentities(sections, byId, structures);
  return {
    sections,
    identities,
    facts: sectionFactsOf(sections, identities, byId, structures),
  };
};

const encodeOutput = (result: SectionFactsResult): SectionFactsOutput => ({
  sections: result.sections.map((section) => ({
    key: section.key,
    path: section.path,
    name: section.name ?? null,
    kind: section.kind,
    basis: section.basis,
    hunkIds: [...section.hunkIds],
    ranges: section.ranges.map((range) => ({ ...range })),
    first: section.first,
  })),
  identities: [...result.identities].map(([section, identity]) => ({
    section,
    key: identity.key,
    parts: {
      ...identity.parts,
      hunkContentKeys: [...identity.parts.hunkContentKeys],
    },
    where: identity.where,
    renamedFrom: identity.renamedFrom,
  })),
  facts: [...result.facts],
});

const decodeOutput = (output: SectionFactsOutput): SectionFactsResult => ({
  sections: output.sections.map((section): Section => ({
    ...section,
    name: section.name ?? undefined,
  })),
  identities: new Map(
    output.identities.map(({ section, ...identity }) => [section, identity]),
  ),
  facts: output.facts,
});

/**
 * The section facts of a manifest's hunks, stored as `harness.section-facts@1` under
 * `sectionFactsSpec`. Each text hunk's blobs' structures are read through `blobStructures` (stored,
 * or read from Graph once and stored); a blob read under two paths with different structures is
 * given none. Sections, identities and facts are computed off the event loop, once per key. Not
 * wired into any stage.
 */
export const storedSectionFacts = (
  repository: string,
  hunks: ReadonlyArray<ManifestHunk>,
  source: OutlineSource,
) =>
  Effect.gen(function* () {
    const store = yield* Computations.ComputationStore;
    const entries = hunkBlobEntries(hunks);
    const read = yield* blobStructures(
      repository,
      [...entries.values()],
      source,
    );
    // Joining and hashing structures is CPU work: one job, off the event loop. A blob read under two
    // paths with different structures is given, with none (`conflicting-paths`).
    const { byBlob, conflicting, spec } = yield* cpuWork(
      repositoryOwner(repository),
      Effect.sync(() => {
        const joined = structuresByBlob(entries.values(), read.structures);
        return {
          byBlob: joined.byBlob,
          conflicting: joined.conflicting,
          spec: sectionFactsSpec(hunks, joined.byBlob),
        };
      }),
    );
    const result = yield* store.run(
      spec,
      cpuWork(
        repositoryOwner(repository),
        Effect.sync(() => ({
          bytes: new TextEncoder().encode(
            JSON.stringify(encodeOutput(computeSectionFacts(hunks, byBlob))),
          ),
          mediaType: "application/json",
        })),
      ),
    );
    const output = yield* cpuWork(
      repositoryOwner(repository),
      Effect.sync(() =>
        decodeOutput(decodeJson(result.output, SectionFactsOutput)),
      ),
    );
    yield* Effect.annotateCurrentSpan({
      "harness.section_facts.status": result.status,
      "harness.section_facts.sections": output.sections.length,
      "harness.section_facts.facts": output.facts.length,
      "harness.section_facts.structures": byBlob.size,
      "harness.section_facts.conflicting": conflicting,
    });
    return {
      ...output,
      key: Computations.computationKey(spec).key,
      status: result.status,
      structures: read.counts,
    };
  }).pipe(Effect.withSpan("harness.section-facts"));
