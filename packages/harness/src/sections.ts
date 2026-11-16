import { createHash } from "node:crypto";
import { z } from "zod";
import type { Computations } from "@neuve/records-core";
import { GRAPH_SOURCE_BINDING, type OutlineSource } from "./graph-outline.ts";
import {
  CHUNK_RECIPE,
  capabilityFor,
  graphFallback,
  headingStarts,
  retryableFallback,
  splitLines,
  type ChunkedFile,
  type GraphChunkContext,
} from "./chunker.ts";
import type { GraphOutlineNode, GraphFileSymbol } from "@neuve/graph-client";
import type { ManifestHunk } from "./manifest.ts";

/**
 * Responsibility sections (10.109): a hunk's changed lines cut at the file's own structure, an
 * import block, a declaration, a function, a test, a heading section, so each part of a change is
 * placed on the matrix by its own nature and impact. Boundaries come from the chunker's declared
 * capabilities and never from size or distance. A file no capability reads has one section per
 * hunk, and says so.
 */

/**
 * 2 (the lanes climb's round 1): a class stays one section. Opened into its members, a class's
 * lifecycle (a counter, its records, acquire, idle shutdown, closing each process) was placed member
 * by member, each one small and easy, while the owner sends the whole to a person.
 *
 * 4 (NEU-148): what a section is changed twice. A removed row goes to the declaration it was removed
 * from (`declarationCounterparts`), not to an added row of its block by index; and a span is named
 * after the outermost of the symbols on its first line, never Graph's `block` outside HCL
 * (`namingSymbol`), where the first in Graph's order named a Rust function after its body.
 */
export const SECTIONS_RECIPE = "neuve-sections-v4";

/**
 * The stored blob structure's own shape: change it whenever `BlobStructure`'s output would change.
 *
 * 2 (NEU-148): Graph's `block` symbols are left out outside HCL (Graph also emits a Rust function's
 * body as one, named after its content), and spans are named by `namingSymbol`.
 *
 * 3 (NEU-148): the span's default-export mark is gone again: public names are no fact of this lane
 * (`section-facts.ts` says why), and nothing else read it.
 */
export const BLOB_STRUCTURE_RECIPE = "neuve-blob-structure-v3";

/** One structural span of a file: lines `start` to `end` and what it is. */
export interface Span {
  readonly start: number;
  readonly end: number;
  readonly name: string | undefined;
  /**
   * SHA-256 of the span's text, kept from the stored structure (`asStructure`); absent from a
   * structure built by hand. `declarationCounterparts` matches unchanged spans by it.
   */
  readonly textSha256?: string;
  readonly kind:
    | "imports"
    | "declaration"
    | "statement"
    | "member"
    | "heading"
    | "head"
    | "tail";
}

/**
 * Every way a blob can have no structure, in one vocabulary with the chunker: Graph's fallback names
 * (`graphFallback`), the index's exclusions (`ExclusionReason`), and a blob that cannot be read.
 */
export const StructureReason = z.enum([
  "capability-unavailable",
  "partial-failure",
  "parse-error",
  "source-not-parsed",
  "unsupported-language",
  "outline-unavailable",
  "binary",
  "over-size",
  "symlink",
  "submodule",
  "not-a-blob",
  "unreadable",
  /**
   * One blob read under two paths whose structures differ: neither cut is taken for it. Decided
   * where a reader joins structures by blob (`structuresByBlob`); never retryable, never stored.
   */
  "conflicting-paths",
]);
export type StructureReason = z.infer<typeof StructureReason>;
// Every chunker fallback is a structure reason; the compiler holds it.
const chunkerFallbacks: ReadonlyArray<StructureReason> = [] as Array<
  NonNullable<ChunkedFile["fallback"]>
>;
void chunkerFallbacks;

/** A file's structure at one revision, or why there is none. */
export type Structure =
  | {
      readonly capability: "graph-symbols" | "markdown-sections";
      readonly spans: ReadonlyArray<Span>;
    }
  | {
      readonly capability: "none";
      readonly reason: StructureReason;
    };

const StructureSymbol = z.strictObject({
  name: z.string(),
  kind: z.string(),
  qualifiedName: z.string(),
  signature: z.string().nullable(),
  /** The name of the symbol's container, resolved from Graph's container ID; null at top level. */
  container: z.string().nullable(),
  startLine: z.int().min(1),
  endLine: z.int().min(1),
});

const StructureSpan = z.strictObject({
  start: z.int().min(1),
  end: z.int().min(1),
  kind: z.enum([
    "imports",
    "declaration",
    "statement",
    "member",
    "heading",
    "head",
    "tail",
  ]),
  name: z.string().nullable(),
  /**
   * The type of the Graph outline node that opened the span (a suite's member: the nested node
   * that opened it). A span joined from several nodes keeps the first node's type. Null where no
   * node opened it: a Markdown heading, a suite's head and tail.
   */
  nodeType: z.string().nullable(),
  /** SHA-256 of the span's text, and its size in characters (code points) and lines. */
  textSha256: z.string(),
  characters: z.int().min(0),
  lines: z.int().min(1),
  /** Graph's symbols that start inside the span, in Graph's order. */
  symbols: z.array(StructureSymbol),
});

/**
 * One blob's structure as stored (`harness.blob-structure@1`): a function of the blob's content,
 * its path and the outline source only. Graph's symbol IDs are left out: they name the temporary
 * repository and batch Graph was given.
 */
export const BlobStructure = z.strictObject({
  capability: z.enum(["graph-symbols", "markdown-sections", "none"]),
  /** The language Graph reported; null where Graph reported none or was not asked (Markdown). */
  language: z.string().nullable(),
  lines: z.int().min(0),
  reason: StructureReason.nullable(),
  spans: z.array(StructureSpan),
});
export type BlobStructure = z.infer<typeof BlobStructure>;

/**
 * The stable key of a blob's structure. A retryable outcome is keyed by its reason instead, so it
 * never takes the stable key and the next call computes it again (as chunks do).
 */
export const blobStructureSpec = (
  blob: string,
  path: string,
  source: OutlineSource,
  retryable?: StructureReason,
): Computations.ComputationSpec => ({
  op: "harness.blob-structure",
  opVersion: 1,
  inputs: { blob: `git-blob:${blob}` },
  config: {
    recipe: BLOB_STRUCTURE_RECIPE,
    chunker: CHUNK_RECIPE,
    sections: SECTIONS_RECIPE,
    source: source.key,
    sourceBinding: GRAPH_SOURCE_BINDING,
    path,
    ...(retryable === undefined ? {} : { retryable }),
  },
});

/** A structure with nothing in it, and why. */
export const noStructure = (
  reason: StructureReason,
  language: string | null = null,
  lines = 0,
): BlobStructure => ({
  capability: "none",
  language,
  lines,
  reason,
  spans: [],
});

/** Test-suite boundaries come only from the outline, never from text matching. */
const callbackStatements = (
  node: GraphOutlineNode,
): readonly GraphOutlineNode[] | undefined => {
  if (node.type !== "expression_statement") return undefined;
  const argumentsNode = node.children?.find(
    (child) => child.type === "arguments",
  );
  const callback = argumentsNode?.children?.at(-1);
  if (
    !callback ||
    !["arrow_function", "function_expression"].includes(callback.type)
  )
    return undefined;
  return callback.children?.find((child) => child.type === "statement_block")
    ?.children;
};

type OpenedSpan = Span & { readonly nodeType: string | null };

/**
 * The symbol a span is named after, among Graph's symbols that start on its node's first line and
 * end inside it: the first in Graph's order that is not inside another of them (its container is one
 * of them). Graph's `block` symbols are never a name outside HCL, but a symbol inside one is still
 * inside (a one-line Rust `impl Thing { pub fn new() … }` holds `new` in Graph's block for `Thing`).
 */
const namingSymbol = (
  candidates: ReadonlyArray<GraphFileSymbol>,
  keepBlocks: boolean,
) => {
  const ids = new Set(candidates.map((symbol) => symbol.id));
  return candidates.find(
    (symbol) =>
      (keepBlocks || symbol.kind !== "block") &&
      (symbol.containerId === null || !ids.has(symbol.containerId)),
  );
};

const spansOf = (
  nodes: readonly GraphOutlineNode[],
  symbolsAt: ReadonlyMap<number, readonly GraphFileSymbol[]>,
  lines: readonly string[],
  from: number,
  to: number,
  depth: number,
  keepBlocks: boolean,
): OpenedSpan[] => {
  const spans: OpenedSpan[] = [];
  let next = from;
  for (const node of nodes) {
    const start = node.startLine;
    const end = node.endLine;
    const last = spans.at(-1);
    if (last && start <= last.end) {
      spans[spans.length - 1] = { ...last, end: Math.max(last.end, end) };
      next = Math.max(next, end + 1);
      continue;
    }
    if (node.imports && last?.kind === "imports") {
      spans[spans.length - 1] = { ...last, end };
      next = end + 1;
      continue;
    }
    const symbol = namingSymbol(
      symbolsAt.get(start)?.filter((symbol) => symbol.endLine <= end) ?? [],
      keepBlocks,
    );
    // Text supplies a display label only. All cuts use Graph's line ranges.
    const label =
      /^\s*(?:describe|it|test)(?:\.[\w]+)*\(\s*(["'`])(.+?)\1/.exec(
        lines[start - 1] ?? "",
      );
    const name =
      symbol?.name ?? (label ? `"${label[2]?.slice(0, 80)}"` : undefined);
    const inner = depth < 3 && label ? callbackStatements(node) : undefined;
    if (
      inner?.some((child) =>
        /^\s*(?:describe|it|test)(?:\.[\w]+)*\(/.test(
          lines[child.startLine - 1] ?? "",
        ),
      )
    ) {
      const first = inner[0];
      const lastChild = inner.at(-1);
      if (first && lastChild) {
        if (first.startLine > next)
          spans.push({
            start: next,
            end: first.startLine - 1,
            name,
            kind: "head",
            nodeType: null,
          });
        spans.push(
          ...spansOf(
            inner,
            symbolsAt,
            lines,
            Math.max(next, first.startLine),
            lastChild.endLine,
            depth + 1,
            keepBlocks,
          ).map((span) => ({
            ...span,
            kind:
              span.kind === "declaration" || span.kind === "statement"
                ? ("member" as const)
                : span.kind,
          })),
        );
        if (end > lastChild.endLine)
          spans.push({
            start: lastChild.endLine + 1,
            end,
            name,
            kind: "tail",
            nodeType: null,
          });
        next = end + 1;
        continue;
      }
    }
    spans.push({
      start: next,
      end,
      name: node.imports ? undefined : name,
      kind: node.imports
        ? "imports"
        : /declaration|definition|export|lexical/.test(node.type)
          ? "declaration"
          : "statement",
      nodeType: node.type,
    });
    next = end + 1;
  }
  const last = spans.at(-1);
  if (last && last.end < to) spans[spans.length - 1] = { ...last, end: to };
  const joined: OpenedSpan[] = [];
  for (const span of spans) {
    const previous = joined.at(-1);
    if (
      previous &&
      span.name !== undefined &&
      previous.name === span.name &&
      previous.kind === span.kind
    )
      joined[joined.length - 1] = { ...previous, end: span.end };
    else joined.push(span);
  }
  return joined.filter((span) => span.end >= span.start);
};

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

/** The number of characters (code points) in `text`, as the stored structure counts them. */
export const codePoints = (text: string) => {
  let count = 0;
  for (let at = 0; at < text.length; at++) {
    const unit = text.charCodeAt(at);
    // A high surrogate followed by a low one is one character.
    if (unit >= 0xd800 && unit <= 0xdbff && at + 1 < text.length) {
      const low = text.charCodeAt(at + 1);
      if (low >= 0xdc00 && low <= 0xdfff) at++;
    }
    count++;
  }
  return count;
};

/** Each span with its text's identity and size, and Graph's symbols that start inside it. */
const describeSpans = (
  spans: ReadonlyArray<OpenedSpan>,
  lines: ReadonlyArray<string>,
  symbols: ReadonlyArray<GraphFileSymbol>,
  keepBlocks = false,
): BlobStructure["spans"] => {
  // Containers resolve against every symbol, a left-out block included.
  const names = new Map<string, string>();
  for (const symbol of symbols) names.set(symbol.id, symbol.name);
  symbols = symbols.filter((symbol) => keepBlocks || symbol.kind !== "block");
  const inside = spans.map(
    () => [] as Array<BlobStructure["spans"][number]["symbols"][number]>,
  );
  for (const symbol of symbols) {
    let low = 0;
    let high = spans.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const span = spans[middle]!;
      if (symbol.startLine < span.start) high = middle - 1;
      else if (symbol.startLine > span.end) low = middle + 1;
      else {
        inside[middle]!.push({
          name: symbol.name,
          kind: symbol.kind,
          qualifiedName: symbol.qualifiedName,
          signature: symbol.signature ?? null,
          container:
            symbol.containerId === null
              ? null
              : (names.get(symbol.containerId) ?? null),
          startLine: symbol.startLine,
          endLine: symbol.endLine,
        });
        break;
      }
    }
  }
  return spans.map((span, index) => {
    const text = lines.slice(span.start - 1, span.end).join("");
    return {
      start: span.start,
      end: span.end,
      kind: span.kind,
      name: span.name ?? null,
      nodeType: span.nodeType,
      textSha256: sha256(text),
      characters: codePoints(text),
      lines: span.end - span.start + 1,
      symbols: inside[index] ?? [],
    };
  });
};

/**
 * The context of a blob whose path Graph refuses (`graphRefusesSourcePath`): it is kept out of every
 * outline read, so one such path no longer costs its batch, and its structure is `outline-unavailable`
 * (its chunks fall back the same way), stable: the same path is refused again. Markdown, which needs
 * no Graph, is cut at its headings as ever.
 */
export const REFUSED_PATH = { kind: "refused" } as const;
/** Graph's outline context of a blob, or `REFUSED_PATH` for one never sent to Graph. */
export type StructureContext = GraphChunkContext | typeof REFUSED_PATH;

/**
 * The reason a blob's structure must not take the stable key, if any: the chunker's fallback for
 * the same context where `retryableFallback` says it may recover. Binary content, Markdown and a
 * path Graph refuses need no Graph and are never retryable.
 */
export const structureRetryable = (
  path: string,
  binary: boolean,
  graph: StructureContext,
): StructureReason | undefined => {
  if (binary || graph.kind === "refused") return undefined;
  const fallback = graphFallback(path, graph);
  return retryableFallback(fallback) ? fallback : undefined;
};

/**
 * A blob's structure from its text (undefined when binary) and Graph's outline context, and the
 * reason it must not take the stable key, if any. Graph's outline defines structure in every
 * language it parses; classes stay whole. Markdown is cut at its headings and needs no Graph. A
 * file Graph does not structure carries the chunker's fallback name for the same context, and is
 * retryable exactly when the chunker's fallback is (`retryableFallback`).
 */
export const computeBlobStructure = (
  path: string,
  text: string | undefined,
  graph: StructureContext,
): { structure: BlobStructure; retryable: StructureReason | undefined } => {
  if (text === undefined)
    return { structure: noStructure("binary"), retryable: undefined };
  const lines = splitLines(text);
  if (capabilityFor(path).capability === "markdown-sections") {
    const starts = headingStarts(lines);
    const spans = starts
      .map((start, index) => ({
        start: start.line,
        end: (starts[index + 1]?.line ?? lines.length + 1) - 1,
        name: start.title,
        kind: "heading" as const,
        nodeType: null,
      }))
      .filter((span) => span.end >= span.start);
    return {
      structure: {
        capability: "markdown-sections",
        language: null,
        lines: lines.length,
        reason: null,
        spans: describeSpans(spans, lines, []),
      },
      retryable: undefined,
    };
  }
  if (graph.kind === "refused")
    return {
      structure: noStructure("outline-unavailable", null, lines.length),
      retryable: undefined,
    };
  const observation =
    graph.kind === "available" ? graph.observation : undefined;
  const language = observation?.language ?? null;
  const fallback = graphFallback(path, graph);
  if (fallback !== undefined || !observation?.outline)
    return {
      structure: noStructure(
        fallback ?? "outline-unavailable",
        language,
        lines.length,
      ),
      retryable: structureRetryable(path, false, graph),
    };
  const symbolsAt = new Map<number, Array<GraphFileSymbol>>();
  for (const symbol of observation.symbols) {
    const list = symbolsAt.get(symbol.startLine) ?? [];
    list.push(symbol);
    symbolsAt.set(symbol.startLine, list);
  }
  // Graph's `block` symbols are HCL's blocks; elsewhere Graph emits one for a Rust function's body.
  const keepBlocks = language === "HCL";
  const spans = spansOf(
    observation.outline.topLevel,
    symbolsAt,
    lines,
    1,
    lines.length,
    0,
    keepBlocks,
  );
  return {
    structure: {
      capability: "graph-symbols",
      language,
      lines: lines.length,
      reason: null,
      spans: describeSpans(
        spans.length
          ? spans
          : [
              {
                start: 1,
                end: Math.max(1, lines.length),
                name: undefined,
                kind: "statement",
                nodeType: null,
              },
            ],
        lines,
        observation.symbols,
        keepBlocks,
      ),
    },
    retryable: undefined,
  };
};

/**
 * The stored bytes of a blob's structure. The pass that chunks a blob and the reader's fallback
 * both encode through here, so the two producers of one key store the same bytes.
 */
export const encodeBlobStructure = (
  path: string,
  text: string | undefined,
  graph: StructureContext,
) => {
  const { structure, retryable } = computeBlobStructure(path, text, graph);
  return {
    output: {
      bytes: new TextEncoder().encode(JSON.stringify(structure)),
      mediaType: "application/json",
    },
    retryable,
  };
};

/** The cut `sectionsOf` reads from a stored structure. */
export const asStructure = (stored: BlobStructure): Structure =>
  stored.capability === "none"
    ? { capability: "none", reason: stored.reason ?? "outline-unavailable" }
    : {
        capability: stored.capability,
        spans: stored.spans.map((span) => ({
          start: span.start,
          end: span.end,
          name: span.name ?? undefined,
          kind: span.kind,
          textSha256: span.textSha256,
        })),
      };

/** A file's structure from its text and Graph's outline context (see `computeBlobStructure`). */
export const structureOf = (
  path: string,
  text: string,
  graph: GraphChunkContext,
): Structure => asStructure(computeBlobStructure(path, text, graph).structure);

/** A structure's spans, either cut (`Structure`) or stored (`BlobStructure`); none without one. */
const spanList = (
  structure: Structure | BlobStructure | undefined,
): ReadonlyArray<{
  readonly start: number;
  readonly end: number;
  readonly kind: Span["kind"];
  readonly name: string | null | undefined;
  readonly textSha256?: string | undefined;
}> =>
  structure === undefined || structure.capability === "none"
    ? []
    : structure.spans;

/** The index of the span holding `line`, if any. */
export const spanIndexAt = (
  structure: Structure | BlobStructure | undefined,
  line: number,
) => {
  const spans = spanList(structure);
  let low = 0;
  let high = spans.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const span = spans[middle]!;
    if (line < span.start) high = middle - 1;
    else if (line > span.end) low = middle + 1;
    else return middle;
  }
  return undefined;
};

const spanAt = (structure: Structure | undefined, line: number) => {
  if (structure === undefined || structure.capability === "none")
    return undefined;
  const index = spanIndexAt(structure, line);
  return index === undefined ? undefined : structure.spans[index];
};

/** For each span of one side, the index of the same declaration's span on the other side, if any. */
export interface Counterparts {
  readonly toHead: ReadonlyArray<number | undefined>;
  readonly toBase: ReadonlyArray<number | undefined>;
  /** For each head span with a counterpart, the step that matched it. */
  readonly matchedBy: ReadonlyArray<"imports" | "text" | "name" | undefined>;
  /**
   * For each span with no counterpart, whether the other side has a span of the same kind and name
   * with none either: several declarations share the name, and which (if any) it is cannot be told.
   */
  readonly baseNamesakes: ReadonlyArray<boolean>;
  readonly headNamesakes: ReadonlyArray<boolean>;
}

/** What a span is matched by: its kind and name; an import block by kind alone; else nothing. */
const matchKey = (span: {
  readonly kind: Span["kind"];
  readonly name: string | null | undefined;
}) => {
  if (span.kind === "imports") return "imports";
  // A suite's head and tail carry the suite's name, not their own.
  if (span.kind === "head" || span.kind === "tail") return undefined;
  if (span.name === undefined || span.name === null || span.name === "")
    return undefined;
  return `${span.kind}\0${span.name}`;
};

const counterpartsHeld = new WeakMap<object, WeakMap<object, Counterparts>>();

/**
 * The same declaration on the other side: the one rule, read by `sectionsOf`'s pairing and by the
 * section facts. Spans are matched in two steps, each by occurrence in file order and only where
 * both sides hold the same number (where the numbers differ, which one changed or went cannot be
 * told, and none of them is matched in that step).
 * 1. Unchanged spans, by kind, name and text (`textSha256`): an unchanged declaration is its own
 *    counterpart wherever it moved. Unnamed spans take part in this step only. A span with no text
 *    hash (a structure built by hand) skips it.
 * 2. The spans still unmatched, by kind and name: where the counts differ, none of them has a
 *    counterpart.
 * Import blocks are matched to import blocks by occurrence, and are not in either step. A span left
 * with no name of its own (a statement, unnamed code; a suite's head and tail carry the suite's name)
 * matches nothing in step 2. A side with no structure matches nothing.
 */
export const declarationCounterparts = (
  base: Structure | BlobStructure | undefined,
  head: Structure | BlobStructure | undefined,
): Counterparts => {
  const held =
    base !== undefined && head !== undefined
      ? counterpartsHeld.get(base)?.get(head)
      : undefined;
  if (held !== undefined) return held;
  const baseSpans = spanList(base);
  const headSpans = spanList(head);
  const toHead = new Array<number | undefined>(baseSpans.length).fill(
    undefined,
  );
  const toBase = new Array<number | undefined>(headSpans.length).fill(
    undefined,
  );
  // A group is matched by occurrence only when both sides hold as many of it.
  const sameCount = (a: number, b: number) => (a === b ? a : 0);
  /** Pairs the base and head indexes of each group by occurrence, where `when` allows. */
  const matchedBy = new Array<Counterparts["matchedBy"][number]>(
    headSpans.length,
  ).fill(undefined);
  const pairGroups = (
    step: "imports" | "text" | "name",
    keyOf: (span: (typeof baseSpans)[number]) => string | undefined,
    when: (base: number, head: number) => number,
  ) => {
    const groups = new Map<string, { base: number[]; head: number[] }>();
    const collect = (
      spans: typeof baseSpans,
      taken: Array<number | undefined>,
      side: "base" | "head",
    ) =>
      spans.forEach((span, index) => {
        if (taken[index] !== undefined) return;
        const key = keyOf(span);
        if (key === undefined) return;
        const group = groups.get(key) ?? { base: [], head: [] };
        group[side].push(index);
        groups.set(key, group);
      });
    collect(baseSpans, toHead, "base");
    collect(headSpans, toBase, "head");
    for (const group of groups.values()) {
      const count = when(group.base.length, group.head.length);
      for (let at = 0; at < count; at++) {
        toHead[group.base[at]!] = group.head[at]!;
        toBase[group.head[at]!] = group.base[at]!;
        matchedBy[group.head[at]!] = step;
      }
    }
  };
  pairGroups(
    "imports",
    (span) => (span.kind === "imports" ? "imports" : undefined),
    Math.min,
  );
  pairGroups(
    "text",
    (span) =>
      span.kind === "imports" || span.textSha256 === undefined
        ? undefined
        : `${span.kind}\0${span.name ?? ""}\0${span.textSha256}`,
    sameCount,
  );
  pairGroups(
    "name",
    (span) => (span.kind === "imports" ? undefined : matchKey(span)),
    sameCount,
  );
  // What is left unmatched, by kind and name, on each side.
  const left = (
    spans: typeof baseSpans,
    matched: ReadonlyArray<number | undefined>,
  ) =>
    new Set(
      spans.flatMap((span, index) => {
        const key = matched[index] === undefined ? matchKey(span) : undefined;
        return key === undefined ? [] : [key];
      }),
    );
  const baseLeft = left(baseSpans, toHead);
  const headLeft = left(headSpans, toBase);
  const namesakes = (
    spans: typeof baseSpans,
    matched: ReadonlyArray<number | undefined>,
    other: ReadonlySet<string>,
  ) =>
    spans.map((span, index) => {
      const key = matched[index] === undefined ? matchKey(span) : undefined;
      return key !== undefined && other.has(key);
    });
  const counterparts: Counterparts = {
    toHead,
    toBase,
    matchedBy,
    baseNamesakes: namesakes(baseSpans, toHead, headLeft),
    headNamesakes: namesakes(headSpans, toBase, baseLeft),
  };
  if (base !== undefined && head !== undefined) {
    const forBase = counterpartsHeld.get(base) ?? new WeakMap();
    forBase.set(head, counterparts);
    counterpartsHeld.set(base, forBase);
  }
  return counterparts;
};

/** One changed line of a hunk: its side and line, and the new-side line a deletion sits at. */
interface Row {
  readonly side: "old" | "new";
  readonly line: number;
  readonly at: number;
}

/** The changed rows of a text hunk, in order, grouped into blocks of consecutive changed rows. */
export const changedBlocks = (
  hunk: Pick<ManifestHunk, "text" | "oldStart" | "newStart">,
) => {
  const blocks: Array<Array<Row>> = [];
  let current: Array<Row> = [];
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  for (const row of hunk.text.split("\n").slice(1)) {
    if (row === "" || row.startsWith("\\")) continue;
    if (row.startsWith("-")) {
      current.push({ side: "old", line: oldLine, at: newLine });
      oldLine++;
      continue;
    }
    if (row.startsWith("+")) {
      current.push({ side: "new", line: newLine, at: newLine });
      newLine++;
      continue;
    }
    if (current.length > 0) blocks.push(current);
    current = [];
    oldLine++;
    newLine++;
  }
  if (current.length > 0) blocks.push(current);
  return blocks;
};

/** A section: one file's changed lines in one span, across the batch's hunks. */
export interface Section {
  readonly key: string;
  readonly path: string;
  readonly name: string | undefined;
  readonly kind: Span["kind"] | "hunk" | "nontext";
  /**
   * Where its boundaries came from: a capability, or one section per hunk with the reason: the
   * structure's reason, `undeclared` where a structure has no span for the line, `rules` where the
   * review rules' ranges are kept whole.
   */
  readonly basis:
    | "graph-symbols"
    | "markdown-sections"
    | StructureReason
    | "undeclared"
    | "rules"
    | "nontext";
  readonly hunkIds: ReadonlyArray<string>;
  /** Changed ranges it owns, as the review rules shape them: side, first line, count. */
  readonly ranges: ReadonlyArray<{
    readonly hunkId: string;
    readonly side: "old" | "new";
    readonly startLine: number;
    readonly lineCount: number;
  }>;
  readonly first: number;
}

const spanKey = (side: "old" | "new", span: Span) =>
  `${side}:${span.start}-${span.end}`;

/** Where a section sits: a span of the head blob, a span only the base blob has, or no span. */
export type SectionPlace =
  | {
      readonly side: "new" | "old";
      readonly startLine: number;
      readonly endLine: number;
    }
  | { readonly side: "none" };

/**
 * A section's place, read from the key `sectionsOf` gave it, so no other module reads `Section.key`.
 * A key `sectionsOf` could not have made throws.
 */
export const sectionPlace = (
  section: Pick<Section, "key" | "path">,
): SectionPlace => {
  const prefix = `${section.path}\0`;
  const local = section.key.startsWith(prefix)
    ? section.key.slice(prefix.length)
    : undefined;
  const span =
    local === undefined ? null : /^(new|old):(\d+)-(\d+)$/.exec(local);
  if (span !== null)
    return {
      side: span[1] as "new" | "old",
      startLine: Number(span[2]),
      endLine: Number(span[3]),
    };
  if (local !== undefined && /^(?:hunk|nontext):./.test(local))
    return { side: "none" };
  throw new Error(`Not a section key of ${section.path}: ${section.key}`);
};

/**
 * Each changed row's section key and span, within one text hunk.
 *
 * An added row belongs to the head span it sits in, else to the hunk.
 *
 * A removed row, where both sides have a structure with spans and the base has a span for the row
 * (its declaration, X):
 * 1. If the head has the same declaration (`declarationCounterparts`: the same unchanged span, else
 *    the same kind and name where both sides have as many of them; an import block by occurrence),
 *    the row belongs to that head span, whether or not the block added rows to it.
 * 2. Else, if the block adds rows in head spans that have no counterpart in the base (a new
 *    declaration, or unnamed code), X was replaced or renamed: the row goes with those rows by
 *    index, the n-th such removed row of the block with the n-th such added row (the last one when
 *    there are fewer).
 * 3. Else X is gone from the head. The row belongs to the head span H that holds both of the
 *    block's neighbours (the head lines just before and just after the block) when H has no
 *    counterpart in the base: H is X under another name, or unnamed code the row was removed from.
 *    Otherwise the row belongs to X, on the old side. A head span with a counterpart is another
 *    declaration that survived; that the removal sits inside its lines (a span takes in the blank
 *    lines and comments before it) does not make the removal its.
 *
 * Every other removed row (no structure on either side, or no base span for the row) keeps the
 * rule from before: with added rows in the block, it goes with the added row at the same index in
 * the block; without, a row removed inside one head span belongs to it, and a row removed between
 * head spans to its base span, on the old side.
 */
const rowKeys = (
  hunk: ManifestHunk,
  head: Structure | undefined,
  base: Structure | undefined,
) => {
  const keyed: Array<{ row: Row; key: string; span: Span | undefined }> = [];
  const headSpans: ReadonlyArray<Span> =
    head === undefined || head.capability === "none" ? [] : head.spans;
  const baseSpans: ReadonlyArray<Span> =
    base === undefined || base.capability === "none" ? [] : base.spans;
  const counterparts =
    headSpans.length > 0 && baseSpans.length > 0
      ? declarationCounterparts(base, head)
      : undefined;
  for (const block of changedBlocks(hunk)) {
    const added = block.filter((row) => row.side === "new");
    const removed = block.filter((row) => row.side === "old");
    const placed = new Map<Row, { key: string; span: Span | undefined }>();
    for (const row of added) {
      const span = spanAt(head, row.line);
      const entry = {
        key: span === undefined ? `hunk:${hunk.hunkId}` : spanKey("new", span),
        span,
      };
      placed.set(row, entry);
      keyed.push({ row, ...entry });
    }
    // Added rows in head spans with no counterpart in the base: a new declaration, or unnamed code.
    const unmatched =
      counterparts === undefined
        ? []
        : added.filter((row) => {
            const index = spanIndexAt(head, row.line);
            return (
              index !== undefined && counterparts.toBase[index] === undefined
            );
          });
    let replaced = 0;
    removed.forEach((row, index) => {
      const push = (key: string, span: Span | undefined) =>
        keyed.push({ row, key, span });
      const baseIndex =
        counterparts === undefined ? undefined : spanIndexAt(base, row.line);
      if (counterparts !== undefined && baseIndex !== undefined) {
        const headIndex = counterparts.toHead[baseIndex];
        if (headIndex !== undefined) {
          const span = headSpans[headIndex]!;
          push(spanKey("new", span), span);
          return;
        }
        if (unmatched.length > 0) {
          const partner = placed.get(
            unmatched[Math.min(replaced++, unmatched.length - 1)]!,
          )!;
          push(partner.key, partner.span);
          return;
        }
        // The block's neighbours on the head side: the line before it and the line after it.
        const start = block[0]!.at;
        const before = spanIndexAt(head, start - 1);
        const after = spanIndexAt(head, start + added.length);
        if (
          before !== undefined &&
          before === after &&
          counterparts.toBase[before] === undefined
        ) {
          const span = headSpans[before]!;
          push(spanKey("new", span), span);
          return;
        }
        const span = baseSpans[baseIndex]!;
        push(spanKey("old", span), span);
        return;
      }
      if (added.length > 0) {
        // A replacement: the removed line goes with the added line at the same place in the block.
        const partner = placed.get(added[Math.min(index, added.length - 1)]!)!;
        push(partner.key, partner.span);
        return;
      }
      // A removal inside one declaration belongs to it; a removal between declarations is the
      // removed declaration's, as the base revision's structure has it.
      const before = spanAt(head, row.at - 1);
      const after = spanAt(head, row.at);
      if (before !== undefined && before === after) {
        push(spanKey("new", before), before);
        return;
      }
      const span = spanAt(base, row.line);
      push(
        span === undefined ? `hunk:${hunk.hunkId}` : spanKey("old", span),
        span,
      );
    });
  }
  return keyed;
};

const runsOf = (lines: ReadonlyArray<number>) => {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const runs: Array<{ startLine: number; lineCount: number }> = [];
  for (const line of sorted) {
    const last = runs.at(-1);
    if (last !== undefined && last.startLine + last.lineCount === line)
      last.lineCount++;
    else runs.push({ startLine: line, lineCount: 1 });
  }
  return runs;
};

const lineSet = (
  ranges: ReadonlyArray<{ side: string; startLine: number; lineCount: number }>,
) => {
  const set = new Set<string>();
  for (const range of ranges)
    for (
      let line = range.startLine;
      line < range.startLine + range.lineCount;
      line++
    )
      set.add(`${range.side}:${line}`);
  return set;
};

/**
 * A batch's sections, in file order then line order. `structures` holds each blob's structure by
 * its object ID. A hunk whose changed rows do not match the review rules' owned ranges keeps the
 * rules' ranges as one section, so ownership is always exactly the rules' (10.21).
 */
export const sectionsOf = (
  hunks: ReadonlyArray<ManifestHunk>,
  structures: ReadonlyMap<string, Structure>,
): ReadonlyArray<Section> => {
  const byKey = new Map<
    string,
    {
      key: string;
      path: string;
      name: string | undefined;
      kind: Section["kind"];
      basis: Section["basis"];
      hunkIds: Array<string>;
      rows: Array<{ hunkId: string; side: "old" | "new"; line: number }>;
      first: number;
    }
  >();
  const add = (
    key: string,
    hunk: ManifestHunk,
    meta: {
      name: string | undefined;
      kind: Section["kind"];
      basis: Section["basis"];
      first: number;
    },
    rows: ReadonlyArray<{ side: "old" | "new"; line: number }>,
  ) => {
    const full = `${hunk.path}\0${key}`;
    const held = byKey.get(full) ?? {
      key: full,
      path: hunk.path,
      ...meta,
      hunkIds: [],
      rows: [],
    };
    if (!held.hunkIds.includes(hunk.hunkId)) held.hunkIds.push(hunk.hunkId);
    held.rows.push(...rows.map((row) => ({ hunkId: hunk.hunkId, ...row })));
    held.first = Math.min(held.first, meta.first);
    byKey.set(full, held);
  };
  for (const hunk of hunks) {
    const owned = hunk.ownedRanges.filter(
      (range) => range.lineCount > 0 && range.startLine > 0,
    );
    if (hunk.kind !== "text") {
      add(
        `nontext:${hunk.hunkId}`,
        hunk,
        { name: undefined, kind: "nontext", basis: "nontext", first: 0 },
        owned.flatMap((range) =>
          Array.from({ length: range.lineCount }, (_, i) => ({
            side: range.side,
            line: range.startLine + i,
          })),
        ),
      );
      continue;
    }
    const head = hunk.newOid === null ? undefined : structures.get(hunk.newOid);
    const base = hunk.oldOid === null ? undefined : structures.get(hunk.oldOid);
    const keyed = rowKeys(hunk, head, base);
    const rules = lineSet(owned);
    const rows = lineSet(
      keyed.map(({ row }) => ({
        side: row.side,
        startLine: row.line,
        lineCount: 1,
      })),
    );
    const matches =
      rules.size === rows.size && [...rules].every((entry) => rows.has(entry));
    const fallbackBasis: Section["basis"] = !matches
      ? "rules"
      : (head ?? base)?.capability === "none"
        ? ((head ?? base) as { reason: Section["basis"] }).reason
        : head === undefined && base === undefined
          ? "unreadable"
          : "undeclared";
    if (!matches) {
      add(
        `hunk:${hunk.hunkId}`,
        hunk,
        {
          name: undefined,
          kind: "hunk",
          basis: "rules",
          first: keyed[0]?.row.at ?? hunk.newStart,
        },
        owned.flatMap((range) =>
          Array.from({ length: range.lineCount }, (_, i) => ({
            side: range.side,
            line: range.startLine + i,
          })),
        ),
      );
      continue;
    }
    for (const entry of keyed) {
      const structural = entry.span !== undefined;
      const capability = entry.key.startsWith("old:") ? base : head;
      add(
        entry.key,
        hunk,
        structural
          ? {
              name: entry.span!.name,
              kind: entry.span!.kind,
              basis: (capability as { capability: Section["basis"] })
                .capability,
              first: entry.key.startsWith("old:")
                ? entry.row.at
                : entry.span!.start,
            }
          : {
              name: undefined,
              kind: "hunk",
              basis: fallbackBasis,
              first: entry.row.at,
            },
        [{ side: entry.row.side, line: entry.row.line }],
      );
    }
  }
  return [...byKey.values()]
    .map((held) => ({
      key: held.key,
      path: held.path,
      name: held.name,
      kind: held.kind,
      basis: held.basis,
      hunkIds: held.hunkIds,
      first: held.first,
      ranges: held.hunkIds.flatMap((hunkId) =>
        (["old", "new"] as const).flatMap((side) =>
          runsOf(
            held.rows
              .filter((row) => row.hunkId === hunkId && row.side === side)
              .map((row) => row.line),
          ).map((run) => ({ hunkId, side, ...run })),
        ),
      ),
    }))
    .sort((a, b) =>
      a.path === b.path ? a.first - b.first : a.path < b.path ? -1 : 1,
    );
};

/** A section's plain name for a reader: its declaration or heading, else where it sits. */
export const sectionLabel = (
  section: Pick<Section, "name" | "kind" | "path" | "ranges">,
) => {
  const file = section.path.split("/").at(-1) ?? section.path;
  if (section.kind === "imports") return `imports in ${file}`;
  if (section.name !== undefined && section.name !== "")
    return `${section.name} in ${file}`;
  const first =
    section.ranges.find((range) => range.side === "new") ?? section.ranges[0];
  return first === undefined ? file : `${file} at line ${first.startLine}`;
};
