import { createHash } from "node:crypto";
import {
  graphReadsPath,
  isGraphCallable,
  type GraphFileObservation,
  type GraphFileSymbol,
  type GraphOutlineNode,
  type GraphProviderObservation,
} from "@neuve/graph-client";

/** Graph outlines define source chunks; Markdown uses headings and other files use line windows. */

/** Part of every chunk computation key: change it whenever chunk output would change. */
export const CHUNK_RECIPE = "neuve-graph-chunk-v6";
export const WINDOW_RECIPE = "utf8-line-window-4k-v2";
const MAX_CHUNK_BYTES = 4 * 1024;
const SMALL_UNIT_BYTES = 256;
const PACK_BYTES = 1024;

/**
 * A declared capability: what it is, the implementation behind it, and the paths it reads, keyed by
 * the final path suffix it declares, with the language it reports for them.
 */
export interface ChunkCapability {
  readonly id: "markdown-sections";
  readonly implementation: () => string;
  readonly reads: Readonly<Record<string, string>>;
  /** Whether the capability reports identifiers at code positions (10.46), not just structure. */
  readonly codePositions: boolean;
}

export const CAPABILITIES: ReadonlyArray<ChunkCapability> = [
  {
    id: "markdown-sections",
    codePositions: false,
    implementation: () => "atx-headings-1-3-v1",
    reads: { md: "md", mdx: "md", mdc: "md", markdown: "md" },
  },
];

export type CapabilityId =
  ChunkCapability["id"] | "graph-symbols" | typeof WINDOW_RECIPE;

/** Whether a stored chunking's capability declares identifiers at code positions (10.46). */
export const declaresCodePositions = (value: string | ChunkedFile): boolean =>
  typeof value === "string"
    ? value === "graph-symbols"
    : (value.codePositions ?? declaresCodePositions(value.capability));

/** The capability that declares it reads a path, and the language it reports for it. */
export const capabilityFor = (
  path: string,
  provider?: GraphProviderObservation,
): { readonly capability: CapabilityId; readonly language: string } => {
  const suffix = /\.([^./]+)$/.exec(path)?.[1]?.toLowerCase();
  for (const capability of CAPABILITIES) {
    const language =
      suffix === undefined ? undefined : capability.reads[suffix];
    if (language !== undefined) return { capability: capability.id, language };
  }
  if (provider !== undefined && graphReadsPath(provider, path))
    return { capability: "graph-symbols", language: "undeclared" };
  return { capability: WINDOW_RECIPE, language: "undeclared" };
};

export interface Chunk {
  readonly kind: "symbol" | "section" | "window";
  /** Symbol names (comma-joined) or the section's heading; absent for a window. */
  readonly symbol: string | undefined;
  /** For a section: its heading path, outermost first. */
  readonly headingPath: ReadonlyArray<string>;
  readonly startLine: number;
  readonly endLine: number;
  readonly textSha256: string;
  /** Identifiers at code positions in the chunk, where a parser read the file (10.46). */
  readonly identifiers: ReadonlyArray<string>;
  /** Names of functions and methods declared inside the chunk, where a parser read the file. */
  readonly callables: ReadonlyArray<string>;
}

export interface ChunkedFile {
  readonly codePositions?: boolean;
  readonly capability: CapabilityId;
  readonly language: string;
  /** A parse failure falls back to windows and says so. */
  readonly fallback:
    | "parse-error"
    | "partial-failure"
    | "outline-unavailable"
    | "source-not-parsed"
    | "capability-unavailable"
    | "unsupported-language"
    | undefined;
  readonly chunks: ReadonlyArray<Chunk>;
  /** Oversized outline leaves actually visited at the provider's emitted depth bound. */
  readonly outlineLimits?: readonly Readonly<{
    startLine: number;
    endLine: number;
  }>[];
}

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

/** Lines with their terminators. */
export const splitLines = (text: string) =>
  text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

const make = (
  kind: Chunk["kind"],
  symbol: string | undefined,
  lines: ReadonlyArray<string>,
  start: number,
  end: number,
  headingPath: ReadonlyArray<string> = [],
): Chunk => ({
  kind,
  symbol,
  headingPath,
  startLine: start,
  endLine: end,
  textSha256: sha256(lines.slice(start - 1, end).join("")),
  identifiers: [],
  callables: [],
});

const isBlank = (lines: ReadonlyArray<string>, chunk: Chunk) =>
  lines
    .slice(chunk.startLine - 1, chunk.endLine)
    .join("")
    .trim() === "";

const windows = (
  lines: ReadonlyArray<string>,
  start: number,
  end: number,
): Array<Chunk> => {
  const chunks: Array<Chunk> = [];
  let from = start;
  let bytes = 0;
  for (let line = start; line <= end; line++) {
    const size = Buffer.byteLength(lines[line - 1] ?? "");
    if (size > MAX_CHUNK_BYTES) {
      if (line > from)
        chunks.push(make("window", undefined, lines, from, line - 1));
      chunks.push(make("window", undefined, lines, line, line));
      from = line + 1;
      bytes = 0;
      continue;
    }
    if (bytes + size > MAX_CHUNK_BYTES) {
      chunks.push(make("window", undefined, lines, from, line - 1));
      from = line;
      bytes = 0;
    }
    bytes += size;
  }
  if (end >= from) chunks.push(make("window", undefined, lines, from, end));
  return chunks;
};

interface Unit {
  start: number;
  end: number;
  symbol: string | undefined;
  graphIds?: readonly string[];
  outline?: GraphOutlineNode | undefined;
  outlineDepth?: number;
}

const packUnits = (
  lines: ReadonlyArray<string>,
  units: ReadonlyArray<Unit>,
  depth: number,
  graphChildren: (unit: Unit) => Array<Unit>,
  onOversized?: (unit: Unit) => void,
): Array<Chunk> => {
  const chunks: Array<Chunk> = [];
  const bytesOf = (start: number, end: number) =>
    Buffer.byteLength(lines.slice(start - 1, end).join(""));
  let pack:
    | { start: number; end: number; symbols: Array<string>; small: boolean }
    | undefined;
  const flush = () => {
    if (pack !== undefined)
      chunks.push(
        make(
          "symbol",
          pack.symbols.length > 0 ? pack.symbols.join(",") : undefined,
          lines,
          pack.start,
          pack.end,
        ),
      );
    pack = undefined;
  };
  for (const unit of units) {
    const size = bytesOf(unit.start, unit.end);
    if (size > MAX_CHUNK_BYTES) {
      onOversized?.(unit);
      flush();
      const inner = depth >= 4 ? [] : graphChildren(unit);
      if (inner.length === 0) {
        chunks.push(...windows(lines, unit.start, unit.end));
        continue;
      }
      const first = inner[0];
      const last = inner.at(-1);
      if (
        first === undefined ||
        last === undefined ||
        (first.start <= unit.start && last.end >= unit.end)
      ) {
        chunks.push(...windows(lines, unit.start, unit.end));
        continue;
      }
      const head: Unit = {
        start: unit.start,
        end: first.start - 1,
        symbol: unit.symbol,
      };
      const tail: Unit = {
        start: last.end + 1,
        end: unit.end,
        symbol: unit.symbol,
      };
      chunks.push(
        ...packUnits(
          lines,
          [head, ...inner, tail].filter((part) => part.end >= part.start),
          inner.filter(
            (part) => bytesOf(part.start, part.end) >= SMALL_UNIT_BYTES,
          ).length <= 1
            ? depth
            : depth + 1,
          graphChildren,
          onOversized,
        ),
      );
      continue;
    }
    const small = size < SMALL_UNIT_BYTES;
    if (
      pack !== undefined &&
      (!small || !pack.small || bytesOf(pack.start, unit.end) > PACK_BYTES)
    )
      flush();
    if (pack === undefined)
      pack = { start: unit.start, end: unit.end, symbols: [], small };
    pack.end = unit.end;
    if (unit.symbol !== undefined) pack.symbols.push(unit.symbol);
    if (!small) flush();
  }
  flush();
  return chunks.filter((chunk) => !isBlank(lines, chunk));
};

/** Attaches each code position to the chunk whose lines hold it. */
const attach = (
  chunks: ReadonlyArray<Chunk>,
  positions: Readonly<{
    identifiers: readonly { line: number; name: string }[];
    callables: readonly { line: number; name: string }[];
  }>,
): Array<Chunk> => {
  const byChunk = chunks.map(() => ({
    identifiers: new Set<string>(),
    callables: new Set<string>(),
  }));
  const find = (line: number) => {
    let low = 0;
    let high = chunks.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const chunk = chunks[middle] as Chunk;
      if (line < chunk.startLine) high = middle - 1;
      else if (line > chunk.endLine) low = middle + 1;
      else return middle;
    }
    return -1;
  };
  for (const { line, name } of positions.identifiers) {
    const at = find(line);
    if (at >= 0) byChunk[at]?.identifiers.add(name);
  }
  for (const { line, name } of positions.callables) {
    const at = find(line);
    if (at >= 0) byChunk[at]?.callables.add(name);
  }
  return chunks.map((chunk, index) => ({
    ...chunk,
    identifiers: [...(byChunk[index]?.identifiers ?? [])].sort(),
    callables: [...(byChunk[index]?.callables ?? [])].sort(),
  }));
};

/** Where ATX headings of levels 1 to 3 outside fenced code start sections, with their heading paths. */
export const headingStarts = (lines: ReadonlyArray<string>) => {
  const starts: Array<{
    line: number;
    title: string | undefined;
    path: ReadonlyArray<string>;
  }> = [{ line: 1, title: undefined, path: [] }];
  const stack: Array<{ level: number; title: string }> = [];
  let fence: string | undefined;
  lines.forEach((line, index) => {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker !== undefined) {
      if (fence === undefined) fence = marker[0];
      else if (marker[0] === fence) fence = undefined;
      return;
    }
    const heading =
      fence === undefined
        ? /^\s{0,3}(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line)
        : null;
    if (heading === null) return;
    const level = heading[1]?.length ?? 1;
    const title = heading[2] ?? "";
    while ((stack.at(-1)?.level ?? 0) >= level) stack.pop();
    stack.push({ level, title });
    const path = stack.map((entry) => entry.title);
    if (index > 0) starts.push({ line: index + 1, title, path });
    else starts[0] = { line: 1, title, path };
  });
  return starts;
};

/** ATX headings of levels 1 to 3 outside fenced code start sections; oversized sections use windows. */
const sectionChunks = (lines: ReadonlyArray<string>) => {
  const starts = headingStarts(lines);
  const chunks: Array<Chunk> = [];
  starts.forEach((section, index) => {
    const end = (starts[index + 1]?.line ?? lines.length + 1) - 1;
    if (end < section.line) return;
    const bytes = Buffer.byteLength(
      lines.slice(section.line - 1, end).join(""),
    );
    if (bytes > MAX_CHUNK_BYTES)
      chunks.push(
        ...windows(lines, section.line, end).map((chunk) => ({
          ...chunk,
          headingPath: section.path,
        })),
      );
    else
      chunks.push(
        make("section", section.title, lines, section.line, end, section.path),
      );
  });
  return chunks.filter((chunk) => !isBlank(lines, chunk));
};

export type GraphChunkContext =
  | Readonly<{
      kind: "available";
      provider: GraphProviderObservation;
      observation: GraphFileObservation | undefined;
    }>
  | Readonly<{ kind: "unavailable" }>;

const graphUnits = (
  nodes: readonly (GraphOutlineNode | GraphFileSymbol)[],
  symbols: readonly GraphFileSymbol[],
  outlineDepth = 0,
): Array<Unit> => {
  const units: Array<Unit> = [];
  for (const node of [...nodes].sort(
    (a, b) => a.startLine - b.startLine || a.endLine - b.endLine,
  )) {
    const previous = units.at(-1);
    if (previous && node.startLine <= previous.end) {
      previous.end = Math.max(previous.end, node.endLine);
      previous.outline = undefined;
      continue;
    }
    units.push({
      start: previous ? previous.end + 1 : node.startLine,
      end: node.endLine,
      symbol: undefined,
      outline: "type" in node ? node : undefined,
      outlineDepth,
    });
  }
  for (const unit of units) {
    const inside = symbols.filter(
      (symbol) =>
        symbol.startLine >= unit.start && symbol.startLine <= unit.end,
    );
    unit.symbol = inside.map((symbol) => symbol.name).join(",") || undefined;
    unit.graphIds = inside.map((symbol) => symbol.id);
  }
  return units;
};

/** Known deterministic failures are reusable only for the same executable and source recipe. */
const stableFailures = new Map<string, NonNullable<ChunkedFile["fallback"]>>([
  ["E_PARSE_ERROR", "parse-error"],
  ["E_PARSE_DEPTH_EXCEEDED", "parse-error"],
  ["E_MINIFIED", "source-not-parsed"],
  ["E_FILE_TOO_LARGE", "source-not-parsed"],
  ["symbols-input-limit", "source-not-parsed"],
  ["E_UNSUPPORTED_LANGUAGE", "unsupported-language"],
]);
const stableFallbacks = new Set([
  "parse-error",
  "source-not-parsed",
  "outline-unavailable",
  "unsupported-language",
]);
/** Unknown reasons stay retryable; time/output limits and I/O failures must recover. */
export const retryableFallback = (
  fallback: string | null | undefined,
): boolean => fallback != null && !stableFallbacks.has(fallback);

const fallbackReasons = new Map<string, string>([
  ["parse-error", "Graph reports a deterministic parse error"],
  ["source-not-parsed", "Graph deliberately skips parsing this source"],
  ["outline-unavailable", "Graph returns no usable outline for this path"],
  ["unsupported-language", "Graph does not parse this language"],
  ["capability-unavailable", "Graph is unavailable"],
  ["partial-failure", "Graph reports a retryable partial failure"],
]);
export const fallbackLimitation = (fallback: string | null | undefined) =>
  `${fallbackReasons.get(fallback ?? "") ?? "Graph outline is unavailable"}; line windows only (${fallback ?? "outline-unavailable"})`;

/** The fallback name and its reuse policy apply equally to chunks, snapshots and outlines. */
export const graphFallback = (
  path: string,
  context: GraphChunkContext,
): ChunkedFile["fallback"] => {
  if (capabilityFor(path).capability === "markdown-sections") return undefined;
  if (context.kind === "unavailable") return "capability-unavailable";
  const observation = context.observation;
  const failures =
    observation?.partialFailures ??
    (observation?.partialFailure ? [observation.partialFailure] : []);
  if (failures.some((code) => !stableFailures.has(code)))
    return "partial-failure";
  if (failures.some((code) => stableFailures.get(code) === "parse-error"))
    return "parse-error";
  if (failures.some((code) => stableFailures.get(code) === "source-not-parsed"))
    return "source-not-parsed";
  if (
    failures.length ||
    !graphReadsPath(context.provider, path) ||
    (observation?.language != null &&
      !context.provider.capabilities.semanticLanguages.includes(
        observation.language,
      ))
  )
    return "unsupported-language";
  if (
    !observation ||
    !context.provider.capabilities.optionalLocalOnlyFeatures[
      "symbols_outline"
    ] ||
    observation.outline === null
  )
    return "outline-unavailable";
  return undefined;
};

export const chunkFile = (
  path: string,
  text: string,
  context: GraphChunkContext,
): ChunkedFile => {
  const lines = splitLines(text);
  const markdown = CAPABILITIES.find(
    (entry) => entry.id === "markdown-sections",
  );
  const suffix = /\.([^./]+)$/.exec(path)?.[1]?.toLowerCase() ?? "";
  const markdownLanguage = markdown?.reads[suffix];
  if (markdownLanguage)
    return {
      capability: "markdown-sections",
      language: markdownLanguage,
      fallback: undefined,
      codePositions: false,
      chunks: sectionChunks(lines).length
        ? sectionChunks(lines)
        : windows(lines, 1, lines.length),
    };
  const observation =
    context.kind === "available" ? context.observation : undefined;
  const language = observation?.language ?? "undeclared";
  const fallback = graphFallback(path, context);
  if (fallback || !observation)
    return {
      capability: WINDOW_RECIPE,
      language,
      fallback,
      codePositions: false,
      chunks: windows(lines, 1, lines.length),
    };
  const roots = observation.symbols.filter(
    (symbol) => symbol.containerId === null,
  );
  const units = graphUnits(observation.outline?.topLevel ?? roots, roots);
  const first = units[0];
  const last = units.at(-1);
  if (first) first.start = 1;
  if (last) last.end = lines.length;
  const children = new Map<string, GraphFileSymbol[]>();
  for (const symbol of observation.symbols)
    if (symbol.containerId !== null) {
      const list = children.get(symbol.containerId) ?? [];
      list.push(symbol);
      children.set(symbol.containerId, list);
    }
  const outlineLimits: Array<{ startLine: number; endLine: number }> = [];
  const chunks = units.length
    ? packUnits(
        lines,
        units,
        0,
        (unit) => {
          let nodes = unit.outline?.children;
          let outlineDepth = (unit.outlineDepth ?? 0) + 1;
          // Tree-sitter may expose callee/arguments or params/body before the
          // statement list used for chunks. Exactly one child of at least 256 bytes
          // and all other children under 256 bytes form a pass-through. Descend
          // before merging line
          // overlaps and keep the original unit's head and tail. Use the same
          // small-unit threshold as packing, and count only real splits above.
          while (nodes?.length) {
            const substantial = nodes.filter(
              (node) =>
                Buffer.byteLength(
                  lines.slice(node.startLine - 1, node.endLine).join(""),
                ) >= SMALL_UNIT_BYTES,
            );
            const dominant =
              substantial.length === 1 ? substantial[0] : undefined;
            if (!dominant?.children?.length) break;
            nodes = dominant.children;
            outlineDepth++;
          }
          if (nodes !== undefined)
            return graphUnits(nodes, observation.symbols, outlineDepth);
          const nested = (unit.graphIds ?? [])
            .flatMap((id) => children.get(id) ?? [])
            .filter(
              (child) =>
                child.startLine >= unit.start && child.endLine <= unit.end,
            );
          return graphUnits(nested, nested);
        },
        (unit) => {
          if (unit.outline && unit.outlineDepth === 16)
            outlineLimits.push({
              startLine: unit.outline.startLine,
              endLine: unit.outline.endLine,
            });
        },
      )
    : windows(lines, 1, lines.length);
  return {
    capability: "graph-symbols",
    language,
    outlineLimits,
    fallback: undefined,
    codePositions: observation.outline !== null,
    chunks: attach(chunks, {
      identifiers: (observation.outline?.identifiers ?? []).flatMap(
        ([line, ...names]) => names.map((name) => ({ line, name })),
      ),
      callables: observation.symbols
        .filter((symbol) => isGraphCallable(symbol.kind))
        .map((symbol) => ({ line: symbol.startLine, name: symbol.name })),
    }),
  };
};

/** Provider identity is part of every chunk computation key. */
export const chunkerKey = (provider: GraphProviderObservation | null) => ({
  recipe: CHUNK_RECIPE,
  provider:
    provider === null
      ? "unavailable"
      : {
          version: provider.version,
          identityRevision: provider.identityRevision,
          sha256: provider.executable.sha256,
          outlines:
            provider.capabilities.optionalLocalOnlyFeatures[
              "symbols_outline"
            ] === true,
        },
  implementations: CAPABILITIES.map((capability) =>
    capability.implementation(),
  ),
});
