import type { Declarations } from "./declarations.ts";
import {
  CALL_FAMILIES,
  IMPORT_TARGET_KINDS,
  MATCH_CLASSES,
  SITE_SHOWS,
  SUPPORT_CLASSES,
  isRelationsGap,
  matchClassOf,
  type CallFamily,
  type MatchClass,
  type RelationsGap,
  type RelationsIndex,
  type RelationsSide,
  type SupportClass,
} from "./relations-index.ts";

/**
 * A relation slice per changed symbol at each side of a range (NEU-148 WP11): pure and
 * deterministic, no I/O and no clock. The lookups a slice reads are built once per index object and
 * shared, sealed, by every later call on it (`sideView`); they never change what a call returns. A subject is what the caller reviews as one thing (a section
 * or a hunk); its `old` ranges join the base index and its `new` ranges the head index, by path and
 * line overlap.
 *
 * The absence of an edge is no evidence, never "no callers", "unused" or "untested". A list of
 * callers exists only with `evidence: "supported"` and a total of at least one; with none, the slice
 * says `evidence: "none"` beside the coverage that says what was and was not read.
 *
 * Every row says how it was matched (`matched`, `MATCH_CLASSES`). `resolved` and `receiver-type`
 * rows may count as caller or test evidence; a `name-only` row is context only and must never count
 * as evidence that lifts a gap. `trusted` counts the rows that may count, past the cap too, so a
 * symbol whose only callers are name-only has `evidence: "supported"`, a total of at least one and
 * `trusted: 0`. Shown callers (`callers.shown`, `stillPointingOnBase.shown`) come in class order,
 * `resolved`, then `receiver-type`, then `name-only`: whenever `trusted` is at least one, `shown`
 * holds at least one row that is not name-only, and no such row follows a name-only one. Within a
 * class, rows whose site shows a place (`SliceSite`, `call` or `reference`) come first, and `placed`
 * counts the trusted ones past the cap.
 */

/**
 * What every slice says Graph's relations may not show, whatever the read covered: places where an
 * edge may be missing, or where the edge there is no evidence. Each key, as measured on the real
 * engine (the shared fixture `tests/fixtures/relations-real-fixture.ts`, engines `d592b44` and
 * `6082ab4`, and the measures report `neu-148/reports/graph-relations-measures.md`):
 * - `jsx-element-use`: a component used as a JSX element gets no call edge.
 * - `function-used-as-value`: a function passed by name as a call argument (`xs.map(double)`) DOES
 *   get an edge, matched as the call would be, and its site shows `reference` on an engine that
 *   declares call lines. Every other use as a value gets none: assigned, returned, held in an array
 *   or object literal, a JSX attribute (`onClick={handler}`), or an argument after a string literal
 *   (`test("case", handler)`). Before call lines this key was `function-passed-by-name`.
 * - `call-through-namespace`: a call through a namespace object may get no edge.
 * - `go-method-through-receiver`: a Go method called through a receiver gets an edge matched
 *   `receiver-type` in its own file and only `name-only` from another package, which is no
 *   evidence; Go recall was 30 of 41 calls (73%) on a small sample.
 * - `one-call-site-per-caller`: one edge per caller, target and call family, so one place: the
 *   caller's first call of the target, or a reference only when it never calls it. A row never
 *   says the caller has no other call.
 * - `call-to-function-declared-in-caller`: no call edge from a function to a function declared
 *   inside it, in any language.
 */
export const STANDING_BLIND_SPOTS = [
  "jsx-element-use",
  "function-used-as-value",
  "call-through-namespace",
  "go-method-through-receiver",
  "one-call-site-per-caller",
  "call-to-function-declared-in-caller",
] as const;

/** Callers shown per symbol; the total is always kept. */
export const CALLERS_PER_SYMBOL = 50;

/** How a symbol is paired with one on the other side, as every slice states it. */
export const COUNTERPART_RULE =
  "same id; else the same path, kind and qualified name with ids equal up to their last #sig: suffix; else none";

/**
 * The one member whose callers include the constructions Graph records on its container (`new X()`
 * is a `CONSTRUCTS` edge into the class): a member named exactly `constructor`, in TypeScript or
 * JavaScript. So narrow because a relation is used only where its trust was measured, and only this
 * case was (3 of 3 in the measures report). Any other member reads no container constructions.
 */
export const CONSTRUCTOR_READING = {
  name: "constructor",
  languages: ["TypeScript", "JavaScript"],
} as const;

export type SliceRange = Readonly<{
  side: "old" | "new";
  path: string;
  startLine: number;
  lineCount: number;
}>;
export type SliceSubject = Readonly<{
  key: string;
  ranges: readonly SliceRange[];
}>;

/** Which files the repository declares as tests, per side. The caller reads the declarations. */
export type SliceTestFiles = Readonly<{
  base: (path: string) => boolean;
  head: (path: string) => boolean;
}>;

/** Test files as the repository's own declarations at each side name them (`declarations.ts`). */
export const declaredTestFiles = (
  base: Declarations,
  head: Declarations,
): SliceTestFiles => {
  const declared = (declarations: Declarations) => (path: string) =>
    declarations.byPath.get(path)?.some((entry) => entry.kind === "test") ===
    true;
  return { base: declared(base), head: declared(head) };
};

export type SliceSymbolRef = Readonly<{
  id: string;
  name: string;
  qualifiedName: string;
  kind: string;
  startLine: number;
  endLine: number;
}>;

/**
 * Where a row's site is and what its line shows (`shows`, decided when the index is built:
 * `SITE_SHOWS` in `relations-index.ts`):
 * - `call`: a call or construction of the target is written at `line` of `path` (the caller's
 *   file), the caller's first one. A reader may say "called here".
 * - `reference`: at `line` the caller hands the target over by name (`xs.map(double)`) and never
 *   calls it. A reader may say "used here", never "called here".
 * - `caller`: no place is shown: the engine declares no call lines for the caller's language (or at
 *   all), or could not tell where the call is. `line`, when not null, is the calling symbol's first
 *   line, not the call's; a file-level caller has none. A reader may say only "called from this
 *   function" (or file).
 */
export type SliceSite =
  | Readonly<{ path: string; line: number; shows: "call" | "reference" }>
  | Readonly<{ path: string; line: number | null; shows: "caller" }>;

/** The site shows where the target is called or used (`shows` is `call` or `reference`). */
export const showsPlace = (site: SliceSite | null) =>
  site !== null && site.shows !== "caller";

export type SliceCaller = Readonly<{
  caller:
    | Readonly<{
        kind: "symbol";
        id: string;
        path: string;
        /** Null when the caller's symbol is not in the index (a language that is not semantic). */
        symbol: SliceSymbolRef | null;
      }>
    | Readonly<{ kind: "file"; path: string }>;
  family: CallFamily;
  support: SupportClass;
  /**
   * How Graph matched the edge (for a `container-construction` row, the construction's edge).
   * `resolved` and `receiver-type` may count as evidence; `name-only` is context and never lifts a
   * gap. Always present on a slice this build makes.
   */
  matched: MatchClass;
  /**
   * The edge's site and what its line shows (`SliceSite`), or null when Graph recorded no location.
   * One per caller, target and family: a `call` is the caller's first call, so the caller may call
   * the target elsewhere too.
   */
  site: SliceSite | null;
  /** The caller's file is one the repository declares as a test. */
  test: boolean;
  /**
   * The subjects of this request whose changes include the caller, in input order: for a symbol,
   * those whose ranges touch it; for a file-level caller whose site shows a place (`call` or
   * `reference`), those whose ranges in its file cover that line; for one that shows none, those
   * with any range in its file (`changedFileLines`).
   */
  changedIn: readonly string[];
  /** `container-construction`: a construction of the constructor's container, as Graph records it. */
  via: "symbol" | "container-construction";
}>;

export type SliceCallers =
  | Readonly<{ evidence: "none" }>
  | Readonly<{
      evidence: "supported";
      /** At least one. */
      total: number;
      /**
       * The callers, of `total`, not matched by name only (`matched` is `resolved` or
       * `receiver-type`): those that may count as evidence. Zero when every caller is name-only.
       */
      trusted: number;
      /**
       * The `trusted` callers whose site shows a place (`shows` `call` or `reference`), counted
       * past the cap too, as `trusted` is.
       */
      placed: number;
      /**
       * At most `CALLERS_PER_SYMBOL`, in this order: by match class (`resolved`, `receiver-type`,
       * `name-only`); within a class, rows whose site shows a place (`call` or `reference`) before
       * rows that show none; then callers some subject changed first; then by path, site line,
       * caller id, family and `via`. Past the cap the first test row, the first other row and the
       * first trusted row that shows a place are always kept, and the rest is the order's prefix.
       * So with `trusted` at least one the first row is not name-only and no trusted row follows a
       * name-only one; with `placed` at least one a trusted row that shows its place is shown,
       * first among its class.
       */
      shown: readonly SliceCaller[];
    }>;

export type SliceTestCallers =
  | Readonly<{ evidence: "none" }>
  | Readonly<{
      evidence: "supported";
      /** At least one. */
      total: number;
      /** The test callers, of `total`, not matched by name only: those that may count as evidence. */
      trusted: number;
      /** The `trusted` test callers whose site shows a place (`call` or `reference`). */
      placed: number;
    }>;

export type SliceCounterpart = Readonly<{
  rule:
    | "same-id"
    | "same-declaration-other-signature"
    | "none"
    | "other-side-not-read"
    | "ids-not-comparable";
  symbol: SliceSymbolRef | null;
}>;

export type SliceChangedEdge = Readonly<{
  direction: "in" | "out";
  other: Readonly<{ id: string; subjects: readonly string[] }>;
  family: CallFamily;
  support: SupportClass;
  /** How Graph matched the edge, as on a caller row: `name-only` is context, never evidence. */
  matched: MatchClass;
}>;

export type SliceSymbol = Readonly<{
  symbol: SliceSymbolRef;
  /** It is the innermost symbol of at least one of the subject's ranges. */
  innermost: boolean;
  counterpart: SliceCounterpart;
  callers: SliceCallers;
  testCallers: SliceTestCallers;
  /**
   * Base side, no counterpart on the head (removed, renamed or moved): its base callers that this
   * request did not change (`changedIn` empty). What still pointed at it at the base; not a
   * statement about the head.
   */
  stillPointingOnBase?: SliceCallers;
  /** Supported call-family edges to and from other changed symbols of this request. */
  changedEdges: readonly SliceChangedEdge[];
  /** Call-family matches into it that the support rule did not keep. */
  unsupportedMatchesNotUsed: number;
}>;

export type SlicePathCoverage = Readonly<{
  path: string;
  snapshot:
    | Readonly<{
        kind: "read";
        language: string | null;
        /** The language's tier as the summary gave it, or null for a file with no language. */
        tier: string | null;
        /** False when Graph reported a partial failure for the file: its relations are not evidence. */
        parsed: boolean;
        failures: readonly string[];
      }>
    | Readonly<{
        kind: "not-in-snapshot";
        reason: "under-gitlink" | "go-build-excluded" | "no-file-record";
      }>
    | Readonly<{ kind: "side-not-read" }>;
}>;

export type SliceRangeCoverage = SliceRange &
  Readonly<{
    match:
      | "symbol"
      | "outside-every-symbol"
      | "no-lines"
      | "file-not-read"
      | "side-not-read";
  }>;

export type SliceSide = Readonly<{
  read:
    | Readonly<{
        kind: "read";
        commit: string;
        tree: string;
        profile: string;
        engine: Readonly<{
          name: string;
          version: string;
          identityRevision: string;
          sha256: string;
        }>;
      }>
    | Readonly<{
        kind: "gap";
        gap: "over-bound" | "graph-unavailable" | "failed";
        tag: string | null;
      }>;
  paths: readonly SlicePathCoverage[];
  ranges: readonly SliceRangeCoverage[];
  /** Changed symbols, innermost first. */
  symbols: readonly SliceSymbol[];
}>;

export type RelationSlice = Readonly<{
  key: string;
  base: SliceSide;
  head: SliceSide;
  counterpartRule: typeof COUNTERPART_RULE;
  blindSpots: typeof STANDING_BLIND_SPOTS;
}>;

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The id up to its last `#sig:` suffix, or the whole id. Never split on `:`. */
const unsigned = (id: string) => {
  const at = id.lastIndexOf("#sig:");
  return at === -1 ? id : id.slice(0, at);
};

/** An index's files and their failures, which path coverage reads. */
class PathView {
  readonly text: (ref: number) => string;
  readonly files = new Map<string, string | null>();
  readonly failures = new Map<string, readonly string[]>();

  constructor(readonly index: RelationsIndex) {
    const strings = index.strings;
    this.text = (ref) => strings[ref] ?? "";
    index.files.path.forEach((path, at) => {
      const language = index.files.language[at] ?? -1;
      this.files.set(
        this.text(path),
        language === -1 ? null : this.text(language),
      );
    });
    for (const failure of index.coverage.partialFailures)
      if (failure.path !== null) this.failures.set(failure.path, failure.codes);
  }
}

/** One side's index with the lookups a slice needs, built once per call. */
class SideView extends PathView {
  readonly symbolsByPath = new Map<string, number[]>();
  readonly symbolsById = new Map<string, number[]>();
  readonly symbolsByUnsigned = new Map<string, number[]>();
  readonly edgesByTarget = new Map<string, number[]>();
  readonly edgesBySource = new Map<string, number[]>();
  readonly dropped = new Map<string, number>();

  constructor(index: RelationsIndex) {
    super(index);
    const push = (map: Map<string, number[]>, key: string, value: number) => {
      const list = map.get(key);
      if (list === undefined) map.set(key, [value]);
      else list.push(value);
    };
    index.symbols.id.forEach((id, at) => {
      const text = this.text(id);
      push(this.symbolsByPath, this.text(index.symbols.path[at] ?? 0), at);
      push(this.symbolsById, text, at);
      push(this.symbolsByUnsigned, unsigned(text), at);
    });
    index.edges.target.forEach((target, at) => {
      push(this.edgesByTarget, this.text(target), at);
      const source = index.edges.sourceSymbol[at] ?? -1;
      if (source !== -1) push(this.edgesBySource, this.text(source), at);
    });
    index.dropped.target.forEach((target, at) =>
      this.dropped.set(this.text(target), index.dropped.count[at] ?? 0),
    );
  }

  symbol(at: number): SliceSymbolRef {
    const symbols = this.index.symbols;
    return {
      id: this.text(symbols.id[at] ?? 0),
      name: this.text(symbols.name[at] ?? 0),
      qualifiedName: this.text(symbols.qualifiedName[at] ?? 0),
      kind: this.text(symbols.kind[at] ?? 0),
      startLine: symbols.startLine[at] ?? 1,
      endLine: symbols.endLine[at] ?? 1,
    };
  }

  container(at: number): string | null {
    const container = this.index.symbols.container[at] ?? -1;
    return container === -1 ? null : this.text(container);
  }

  pathOf(at: number) {
    return this.text(this.index.symbols.path[at] ?? 0);
  }
}

/**
 * Makes a view's maps read-only for good: their arrays are frozen, and `set`, `delete` and `clear`
 * throw. A view is shared by every slice and caller-path call on its index, so no call may change
 * it; this turns any attempt into an error rather than a wrong answer for the next caller.
 */
const sealMap = <K, V>(map: Map<K, V>) => {
  for (const value of map.values())
    if (Array.isArray(value)) Object.freeze(value);
  const refuse = () => {
    throw new TypeError("A relations slice view is read-only.");
  };
  for (const name of ["set", "delete", "clear"])
    Object.defineProperty(map, name, { value: refuse });
  Object.freeze(map);
};

/** Views built in this process (tests observe it, never a time). */
let viewsBuilt = 0;
export const relationSliceViewsBuilt = () => viewsBuilt;

/**
 * One view per index object, built on first use and shared by `relationSlices` and
 * `relationCallerPaths`, so a second call on the same index builds nothing. Sealed (`sealMap`) and
 * frozen once built. The index is never changed, and frozen only where the view shares an array
 * with it: each partial failure's `codes` (`PathView.failures`), which the seal freezes, so a
 * caller that changed one afterwards would throw rather than change other callers' answers.
 * Built synchronously, with nothing awaited between the lookup and the set, so callers that start
 * together on one index object build one view. Weakly held: it goes with its index.
 */
const sideViews = new WeakMap<RelationsIndex, SideView>();
const sideView = (index: RelationsIndex): SideView => {
  const held = sideViews.get(index);
  if (held !== undefined) return held;
  viewsBuilt++;
  const view = new SideView(index);
  for (const value of Object.values(view))
    if (value instanceof Map) sealMap(value);
  Object.freeze(view);
  sideViews.set(index, view);
  return view;
};

type SideName = "base" | "head";

/** A changed symbol of this request, on one side, with the subjects whose ranges touch it. */
type Changed = Map<string, string[]>;

const overlapping = (view: SideView, range: SliceRange) => {
  const last = range.startLine + range.lineCount - 1;
  return (view.symbolsByPath.get(range.path) ?? []).filter(
    (at) =>
      (view.index.symbols.startLine[at] ?? 0) <= last &&
      (view.index.symbols.endLine[at] ?? 0) >= range.startLine,
  );
};

const span = (view: SideView, at: number) =>
  (view.index.symbols.endLine[at] ?? 0) -
  (view.index.symbols.startLine[at] ?? 0);

/** Innermost first: the shortest span, then the later start, then the id. */
const inner = (view: SideView) => (a: number, b: number) =>
  span(view, a) - span(view, b) ||
  (view.index.symbols.startLine[b] ?? 0) -
    (view.index.symbols.startLine[a] ?? 0) ||
  byText(view.symbol(a).id, view.symbol(b).id) ||
  a - b;

const sideRanges = (subject: SliceSubject, side: SideName) =>
  subject.ranges.filter(
    (range) => range.side === (side === "base" ? "old" : "new"),
  );

/** Each changed symbol id on a side, with the keys of the subjects that touch it, in input order. */
const changedSymbols = (
  view: SideView | undefined,
  subjects: readonly SliceSubject[],
  side: SideName,
): Changed => {
  const changed: Changed = new Map();
  if (view === undefined) return changed;
  for (const subject of subjects)
    for (const range of sideRanges(subject, side)) {
      if (range.lineCount <= 0) continue;
      for (const at of overlapping(view, range)) {
        const id = view.symbol(at).id;
        const keys = changed.get(id) ?? [];
        if (!keys.includes(subject.key)) keys.push(subject.key);
        changed.set(id, keys);
      }
    }
  return changed;
};

/** The subjects, in input order, whose ranges on a side establish that a file-level caller changed. */
type ChangedFile = (path: string, line: number | null) => readonly string[];

/**
 * A file-level caller (a call outside every symbol, as Graph records a call inside a Bun `test`
 * callback) is no changed symbol, so its change is read from the ranges themselves: a range on this
 * side of its file that covers the call's line, or, when Graph gave no line, any range on this side
 * of its file. A range of no lines changes nothing on its side. So a caller is said not to have
 * changed only when no range of the request could have changed it.
 */
const changedFileLines = (
  subjects: readonly SliceSubject[],
  side: SideName,
): ChangedFile => {
  const byPath = new Map<
    string,
    { key: string; start: number; end: number }[]
  >();
  for (const subject of subjects)
    for (const range of sideRanges(subject, side)) {
      if (range.lineCount <= 0) continue;
      const list = byPath.get(range.path) ?? [];
      list.push({
        key: subject.key,
        start: range.startLine,
        end: range.startLine + range.lineCount - 1,
      });
      byPath.set(range.path, list);
    }
  return (path, line) => {
    const keys: string[] = [];
    for (const range of byPath.get(path) ?? [])
      if (
        (line === null || (line >= range.start && line <= range.end)) &&
        !keys.includes(range.key)
      )
        keys.push(range.key);
    return keys;
  };
};

const pathCoverage = (
  view: PathView | undefined,
  path: string,
): SlicePathCoverage => {
  if (view === undefined) return { path, snapshot: { kind: "side-not-read" } };
  if (!view.files.has(path)) {
    const coverage = view.index.coverage;
    return {
      path,
      snapshot: {
        kind: "not-in-snapshot",
        reason: coverage.gitlinksNotRead.some(
          (link) => path === link.path || path.startsWith(`${link.path}/`),
        )
          ? "under-gitlink"
          : coverage.goBuildExcluded.some((file) => file.path === path)
            ? "go-build-excluded"
            : "no-file-record",
      },
    };
  }
  const language = view.files.get(path) ?? null;
  const failures = view.failures.get(path) ?? [];
  return {
    path,
    snapshot: {
      kind: "read",
      language,
      tier:
        language === null
          ? null
          : (view.index.coverage.languageTiers[language] ?? null),
      parsed: failures.length === 0,
      failures: [...failures],
    },
  };
};

/**
 * Where one import of one file resolves at a side's commit, as Graph classified it. The five
 * targets are Graph's answers (`unresolved`: Graph looked and found nothing). The rest say why
 * there is no answer: the side was not read; the engine that built the index does not classify;
 * the importing file is not in the snapshot or Graph reported a failure for it (its path coverage,
 * as a slice gives it); or the file was read and has no import with that specifier, a mismatch
 * the caller must see and never read as unresolved.
 */
export type ImportTargetAnswer =
  | Readonly<{ kind: "file"; path: string }>
  | Readonly<{
      kind: "declared-package";
      name: string | null;
      manifest: string;
    }>
  | Readonly<{ kind: "builtin" }>
  | Readonly<{ kind: "unresolved" }>
  | Readonly<{ kind: "not-classified" }>
  | Readonly<{ kind: "side-not-read"; gap: RelationsGap }>
  | Readonly<{ kind: "classification-unavailable" }>
  | Readonly<{
      kind: "file-not-read";
      reason:
        | "under-gitlink"
        | "go-build-excluded"
        | "no-file-record"
        | "partial-failure";
      failures: readonly string[];
    }>
  | Readonly<{ kind: "not-found" }>;

/** An index's imports by file and specifier, with its path coverage; built once per index. */
class ImportView extends PathView {
  readonly imports = new Map<string, number>();

  constructor(index: RelationsIndex) {
    super(index);
    index.imports.path.forEach((path, at) => {
      const key = `${this.text(path)}\0${this.text(index.imports.specifier[at] ?? 0)}`;
      if (!this.imports.has(key)) this.imports.set(key, at);
    });
  }
}
const importViews = new WeakMap<RelationsIndex, ImportView>();

export const importTarget = (
  side: RelationsSide,
  path: string,
  specifier: string,
): ImportTargetAnswer => {
  if (isRelationsGap(side))
    return { kind: "side-not-read", gap: { gap: side.gap, tag: side.tag } };
  if (side.coverage.importTargets?.status !== "classified")
    return { kind: "classification-unavailable" };
  let view = importViews.get(side);
  if (view === undefined) {
    view = new ImportView(side);
    importViews.set(side, view);
  }
  const coverage = pathCoverage(view, path).snapshot;
  if (coverage.kind === "not-in-snapshot")
    return { kind: "file-not-read", reason: coverage.reason, failures: [] };
  if (coverage.kind === "read" && !coverage.parsed)
    return {
      kind: "file-not-read",
      reason: "partial-failure",
      failures: coverage.failures,
    };
  const at = view.imports.get(`${path}\0${specifier}`);
  if (at === undefined) return { kind: "not-found" };
  const imports = side.imports;
  const kind = IMPORT_TARGET_KINDS[imports.kind[at] ?? 0] ?? "not-classified";
  const target = view.text(imports.target[at] ?? 0);
  const name = imports.name[at] ?? -1;
  switch (kind) {
    case "file":
      return { kind, path: target };
    case "declared-package":
      return {
        kind,
        name: name === -1 ? null : view.text(name),
        manifest: target,
      };
    default:
      return { kind };
  }
};

/** The rows that may count as evidence: every one not matched by name only. */
const isTrusted = (caller: SliceCaller) => caller.matched !== "name-only";
const trustedOf = (callers: readonly SliceCaller[]) =>
  callers.filter(isTrusted).length;
/** The trusted rows whose site shows a place (`call` or `reference`). */
const isPlaced = (caller: SliceCaller) =>
  isTrusted(caller) && showsPlace(caller.site);
const placedOf = (callers: readonly SliceCaller[]) =>
  callers.filter(isPlaced).length;

/**
 * A symbol's callers in their shown order. First by match class, in `MATCH_CLASSES` order
 * (`resolved`, `receiver-type`, then `name-only`); within a class, rows whose site shows a place
 * first; then callers some subject changed first, then by path, site line, caller id, family and
 * `via`. Because the class comes first and the cap keeps a prefix of this order beside its reserved
 * rows (the first test row, the first other row, the first trusted row that shows a place), `shown`
 * never puts a trusted row after a name-only one, its first row is trusted whenever `trusted` is at
 * least one, and a trusted row that shows its place is shown, first among its class, whenever
 * `placed` is at least one.
 */
const callersOf = (shown: SliceCaller[]): SliceCallers => {
  if (shown.length === 0) return { evidence: "none" };
  const order = (a: SliceCaller, b: SliceCaller) =>
    MATCH_CLASSES.indexOf(a.matched) - MATCH_CLASSES.indexOf(b.matched) ||
    Number(showsPlace(b.site)) - Number(showsPlace(a.site)) ||
    Number(b.changedIn.length > 0) - Number(a.changedIn.length > 0) ||
    byText(a.caller.path, b.caller.path) ||
    (a.site?.line ?? 0) - (b.site?.line ?? 0) ||
    byText(
      a.caller.kind === "symbol" ? a.caller.id : "",
      b.caller.kind === "symbol" ? b.caller.id : "",
    ) ||
    CALL_FAMILIES.indexOf(a.family) - CALL_FAMILIES.indexOf(b.family) ||
    byText(a.via, b.via);
  const sorted = [...shown].sort(order);
  const trusted = trustedOf(sorted);
  const placed = placedOf(sorted);
  if (sorted.length <= CALLERS_PER_SYMBOL)
    return {
      evidence: "supported",
      total: sorted.length,
      trusted,
      placed,
      shown: sorted,
    };
  // Both kinds represented: the first test caller and the first other caller are always kept, and
  // so is the first trusted caller that shows its place, which may sort past the cap (a resolved
  // class of many rows that show none ahead of a receiver-type row that shows one).
  const reserved = new Set(
    [
      sorted.find((caller) => caller.test),
      sorted.find((caller) => !caller.test),
      sorted.find(isPlaced),
    ].filter((caller): caller is SliceCaller => caller !== undefined),
  );
  const kept = new Set(reserved);
  for (const caller of sorted) {
    if (kept.size >= CALLERS_PER_SYMBOL) break;
    kept.add(caller);
  }
  return {
    evidence: "supported",
    total: sorted.length,
    trusted,
    placed,
    shown: sorted.filter((caller) => kept.has(caller)),
  };
};

const isConstructor = (view: SideView, at: number) => {
  const container = view.container(at);
  if (container === null) return null;
  const language = view.text(view.index.symbols.language[at] ?? 0);
  return view.symbol(at).name === CONSTRUCTOR_READING.name &&
    (CONSTRUCTOR_READING.languages as readonly string[]).includes(language)
    ? container
    : null;
};

/**
 * How each of a subject's ranges on a side meets the index, and the symbols they touch: each with
 * whether it is innermost for at least one range. A range of no lines, or in a file the side did
 * not read, touches nothing.
 */
const rangeMatches = (view: SideView, ranges: readonly SliceRange[]) => {
  const touched = new Map<number, boolean>();
  const coverage: SliceRangeCoverage[] = ranges.map((range) => {
    if (range.lineCount <= 0) return { ...range, match: "no-lines" };
    if (!view.files.has(range.path))
      return { ...range, match: "file-not-read" };
    const found = overlapping(view, range);
    const starts = view.index.symbols.startLine;
    const ends = view.index.symbols.endLine;
    // Innermost for this range: no other symbol the range touches lies strictly inside it.
    for (const at of found) {
      const nested = found.some(
        (other) =>
          other !== at &&
          (starts[other] ?? 0) >= (starts[at] ?? 0) &&
          (ends[other] ?? 0) <= (ends[at] ?? 0) &&
          span(view, other) < span(view, at),
      );
      touched.set(at, (touched.get(at) ?? false) || !nested);
    }
    return {
      ...range,
      match: found.length > 0 ? "symbol" : "outside-every-symbol",
    };
  });
  return { touched, coverage };
};

/**
 * Every kept edge that makes a caller of the symbol at `at`: the edges into it, then, for a
 * constructor (`CONSTRUCTOR_READING`), the constructions of its container.
 */
const callerEdges = (
  view: SideView,
  at: number,
): ReadonlyArray<readonly [edge: number, via: SliceCaller["via"]]> => {
  const id = view.symbol(at).id;
  const inbound = (view.edgesByTarget.get(id) ?? []).map(
    (edge) => [edge, "symbol"] as const,
  );
  const container = isConstructor(view, at);
  if (container === null) return inbound;
  return [
    ...inbound,
    ...(view.edgesByTarget.get(container) ?? [])
      .filter(
        (edge) =>
          CALL_FAMILIES[view.index.edges.family[edge] ?? 0] === "CONSTRUCTS",
      )
      .map((edge) => [edge, "container-construction"] as const),
  ];
};

const sideSlice = (
  side: SideName,
  sideInput: RelationsSide,
  view: SideView | undefined,
  other: SideView | undefined,
  subject: SliceSubject,
  changed: Changed,
  changedFile: ChangedFile,
  isTest: (path: string) => boolean,
): SliceSide => {
  const ranges = sideRanges(subject, side);
  const paths = [...new Set(ranges.map((range) => range.path))];
  const read: SliceSide["read"] =
    view === undefined
      ? isRelationsGap(sideInput)
        ? { kind: "gap", gap: sideInput.gap, tag: sideInput.tag }
        : { kind: "gap", gap: "failed", tag: null }
      : {
          kind: "read",
          commit: view.index.coverage.commit,
          tree: view.index.coverage.tree,
          profile: view.index.coverage.profile,
          engine: {
            name: view.index.coverage.provider.name,
            version: view.index.coverage.provider.version,
            identityRevision: view.index.coverage.provider.identityRevision,
            sha256: view.index.coverage.provider.executable.sha256,
          },
        };
  if (view === undefined)
    return {
      read,
      paths: paths.map((path) => pathCoverage(undefined, path)),
      ranges: ranges.map((range) => ({ ...range, match: "side-not-read" })),
      symbols: [],
    };
  const { touched, coverage: rangeCoverage } = rangeMatches(view, ranges);
  const order = inner(view);
  const comparable =
    other !== undefined &&
    other.index.coverage.repoKey === view.index.coverage.repoKey;
  const changedIn = (id: string) => changed.get(id) ?? [];
  const callerOf = (edge: number, via: SliceCaller["via"]): SliceCaller => {
    const edges = view.index.edges;
    const sourceRef = edges.sourceSymbol[edge] ?? -1;
    const path = view.text(edges.sourcePath[edge] ?? 0);
    const sitePath = edges.sitePath[edge] ?? -1;
    const siteLine = edges.siteLine[edge] ?? 0;
    const shows = SITE_SHOWS[edges.siteShows[edge] ?? -1] ?? "caller";
    // The index sets `call` and `reference` only with a line in the caller's file.
    const site: SliceSite | null =
      sitePath === -1
        ? null
        : shows !== "caller" && siteLine > 0
          ? { path: view.text(sitePath), line: siteLine, shows }
          : {
              path: view.text(sitePath),
              line: siteLine === 0 ? null : siteLine,
              shows: "caller",
            };
    const sourceId = sourceRef === -1 ? null : view.text(sourceRef);
    const stored =
      sourceId === null ? undefined : view.symbolsById.get(sourceId)?.[0];
    return {
      caller:
        sourceId === null
          ? { kind: "file", path }
          : {
              kind: "symbol",
              id: sourceId,
              path,
              symbol: stored === undefined ? null : view.symbol(stored),
            },
      family: CALL_FAMILIES[edges.family[edge] ?? 0] ?? "CALLS",
      support: SUPPORT_CLASSES[edges.support[edge] ?? 0] ?? "resolved",
      matched: matchClassOf(view.text(edges.resolution[edge] ?? 0)),
      site,
      test: isTest(path),
      // A file-level caller is changed by a range over the line where it calls or uses the
      // target; a line that shows no place establishes nothing, so then any range in its file does.
      changedIn:
        sourceId === null
          ? changedFile(
              path,
              site !== null && site.shows !== "caller" && site.path === path
                ? site.line
                : null,
            )
          : changedIn(sourceId),
      via,
    };
  };
  const symbols = [...touched.keys()].sort(order).map((at): SliceSymbol => {
    const symbol = view.symbol(at);
    let counterpart: SliceCounterpart;
    if (other === undefined)
      counterpart = { rule: "other-side-not-read", symbol: null };
    else if (!comparable)
      counterpart = { rule: "ids-not-comparable", symbol: null };
    else {
      const same = other.symbolsById.get(symbol.id)?.[0];
      const kin =
        same === undefined
          ? (other.symbolsByUnsigned.get(unsigned(symbol.id)) ?? []).filter(
              (candidate) => {
                const found = other.symbol(candidate);
                return (
                  other.pathOf(candidate) === view.pathOf(at) &&
                  found.kind === symbol.kind &&
                  found.qualifiedName === symbol.qualifiedName
                );
              },
            )
          : [];
      counterpart =
        same !== undefined
          ? { rule: "same-id", symbol: other.symbol(same) }
          : kin.length === 1 && kin[0] !== undefined
            ? {
                rule: "same-declaration-other-signature",
                symbol: other.symbol(kin[0]),
              }
            : { rule: "none", symbol: null };
    }
    const all = callerEdges(view, at).map(([edge, via]) => callerOf(edge, via));
    const testRows = all.filter((caller) => caller.test);
    const tests = testRows.length;
    const changedEdges: SliceChangedEdge[] = [];
    const edgeOf = (edge: number, direction: "in" | "out", otherId: string) => {
      if (otherId === symbol.id || !changed.has(otherId)) return;
      changedEdges.push({
        direction,
        other: { id: otherId, subjects: changedIn(otherId) },
        family: CALL_FAMILIES[view.index.edges.family[edge] ?? 0] ?? "CALLS",
        support:
          SUPPORT_CLASSES[view.index.edges.support[edge] ?? 0] ?? "resolved",
        matched: matchClassOf(
          view.text(view.index.edges.resolution[edge] ?? 0),
        ),
      });
    };
    for (const edge of view.edgesByTarget.get(symbol.id) ?? []) {
      const source = view.index.edges.sourceSymbol[edge] ?? -1;
      if (source !== -1) edgeOf(edge, "in", view.text(source));
    }
    for (const edge of view.edgesBySource.get(symbol.id) ?? [])
      edgeOf(edge, "out", view.text(view.index.edges.target[edge] ?? 0));
    changedEdges.sort(
      (a, b) =>
        byText(a.direction, b.direction) ||
        byText(a.other.id, b.other.id) ||
        CALL_FAMILIES.indexOf(a.family) - CALL_FAMILIES.indexOf(b.family) ||
        byText(a.support, b.support) ||
        byText(a.matched, b.matched),
    );
    return {
      symbol,
      innermost: touched.get(at) === true,
      counterpart,
      callers: callersOf(all),
      testCallers:
        tests === 0
          ? { evidence: "none" }
          : {
              evidence: "supported",
              total: tests,
              trusted: trustedOf(testRows),
              placed: placedOf(testRows),
            },
      ...(side === "base" && counterpart.rule === "none"
        ? {
            stillPointingOnBase: callersOf(
              all.filter((caller) => caller.changedIn.length === 0),
            ),
          }
        : {}),
      changedEdges,
      unsupportedMatchesNotUsed: view.dropped.get(symbol.id) ?? 0,
    };
  });
  return {
    read,
    paths: paths.map((path) => pathCoverage(view, path)),
    ranges: rangeCoverage,
    symbols,
  };
};

/**
 * One slice per subject, in input order. `old` ranges join `sides.base` and `new` ranges
 * `sides.head`; a side that is a gap still gives every subject its coverage. Test callers are the
 * callers whose file `tests` says the repository declares as a test at that side.
 */
export const relationSlices = (
  sides: Readonly<{ base: RelationsSide; head: RelationsSide }>,
  subjects: readonly SliceSubject[],
  tests: SliceTestFiles,
): RelationSlice[] => {
  const base = isRelationsGap(sides.base) ? undefined : sideView(sides.base);
  const head = isRelationsGap(sides.head) ? undefined : sideView(sides.head);
  const changed = {
    base: changedSymbols(base, subjects, "base"),
    head: changedSymbols(head, subjects, "head"),
  };
  const changedFiles = {
    base: changedFileLines(subjects, "base"),
    head: changedFileLines(subjects, "head"),
  };
  return subjects.map((subject) => ({
    key: subject.key,
    base: sideSlice(
      "base",
      sides.base,
      base,
      head,
      subject,
      changed.base,
      changedFiles.base,
      tests.base,
    ),
    head: sideSlice(
      "head",
      sides.head,
      head,
      base,
      subject,
      changed.head,
      changedFiles.head,
      tests.head,
    ),
    counterpartRule: COUNTERPART_RULE,
    blindSpots: STANDING_BLIND_SPOTS,
  }));
};

/**
 * Per side, the paths of every caller the slices of these subjects would name, sorted: exactly the
 * paths `relationSlices` asks `tests` about for that side, so a caller can read those files'
 * declarations and then slice once. It counts callers past the per-symbol cap
 * (`CALLERS_PER_SYMBOL`), which a slice counts but does not list. Every caller of any match class
 * (`matched`) is named, name-only ones too. Pure: no slice is built and no test is marked; a side
 * that is a gap has none. It builds the view of each index that `relationSlices` then reuses
 * (one view per index object), so the pair costs one view build per index.
 */
export const relationCallerPaths = (
  sides: Readonly<{ base: RelationsSide; head: RelationsSide }>,
  subjects: readonly SliceSubject[],
): Readonly<{ base: readonly string[]; head: readonly string[] }> => {
  const pathsOf = (side: SideName) => {
    const input = sides[side];
    if (isRelationsGap(input)) return [];
    const view = sideView(input);
    const paths = new Set<string>();
    const touched = new Set<number>();
    for (const subject of subjects)
      for (const at of rangeMatches(
        view,
        sideRanges(subject, side),
      ).touched.keys())
        touched.add(at);
    for (const at of touched)
      for (const [edge] of callerEdges(view, at))
        paths.add(view.text(view.index.edges.sourcePath[edge] ?? 0));
    return [...paths].sort(byText);
  };
  return { base: pathsOf("base"), head: pathsOf("head") };
};
