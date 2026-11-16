import { expect, test } from "bun:test";
import type { GraphSnapshotCoverage, SourcePath } from "@neuve/graph-client";
import {
  CALLERS_PER_SYMBOL,
  MATCH_CLASSES,
  RelationsIndex,
  RelationsIndexBuilder,
  STANDING_BLIND_SPOTS,
  matchClassOf,
  relationCallerPaths,
  relationSliceViewsBuilt,
  relationSlices as slicesOf,
  type RelationSlice,
  type RelationsSide,
  type SliceCallers,
  type SliceSubject,
  type SliceTestFiles,
} from "../src/relations.ts";

/*
 * Small hand-built indexes, through the builder that applies the support rule, sliced by the pure
 * function. Ids are opaque strings here as they are from Graph.
 */

/**
 * `relationSlices`, with `relationCallerPaths` checked against it on every call in this file, so
 * every fixture here is a case of the property. Why: the readers read the declarations of exactly
 * the paths `relationCallerPaths` names and then slice once, so the two must agree per side: its
 * answer is exactly the set of paths the slices ask `tests` about, and the callers the slices list
 * are among them, all of them when no symbol has more callers than it lists. Every shown list is
 * also checked for the class order: the readers and the sections read the first rows, and a
 * trusted row must never sit behind a name-only one. And every call checks the shared view (one per
 * index object): the caller paths and a second slicing build no view, and give byte for byte what
 * a view built afresh from a copy of the index gives, as each call did before views were shared.
 * Every view is sealed when built, so a slice that changed one would throw here.
 */
const relationSlices = (
  sides: Readonly<{ base: RelationsSide; head: RelationsSide }>,
  subjects: readonly SliceSubject[],
  tests: SliceTestFiles,
): RelationSlice[] => {
  const asked = { base: new Set<string>(), head: new Set<string>() };
  const recorded = (side: "base" | "head") => (path: string) => {
    asked[side].add(path);
    return tests[side](path);
  };
  const slices = slicesOf(sides, subjects, {
    base: recorded("base"),
    head: recorded("head"),
  });
  const built = relationSliceViewsBuilt();
  const answer = relationCallerPaths(sides, subjects);
  const again = slicesOf(sides, subjects, tests);
  expect(relationSliceViewsBuilt()).toBe(built);
  expect(JSON.stringify(again)).toBe(JSON.stringify(slices));
  const copied = {
    base: structuredClone(sides.base),
    head: structuredClone(sides.head),
  };
  expect(JSON.stringify(slicesOf(copied, subjects, tests))).toBe(
    JSON.stringify(slices),
  );
  expect(relationCallerPaths(copied, subjects)).toEqual(answer);
  for (const side of ["base", "head"] as const) {
    expect(answer[side]).toEqual([...asked[side]].sort());
    const listed = new Set<string>();
    let capped = false;
    const list = (callers: SliceCallers | undefined) => {
      if (callers === undefined || callers.evidence === "none") return;
      if (callers.total > callers.shown.length) capped = true;
      for (const caller of callers.shown) listed.add(caller.caller.path);
      // The order's promise: shown rows run in class order, so a trusted row never follows a
      // name-only one, and one is shown first whenever any exists.
      const ranks = callers.shown.map((caller) =>
        MATCH_CLASSES.indexOf(caller.matched),
      );
      expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
      if (callers.trusted >= 1)
        expect(callers.shown[0]?.matched).not.toBe("name-only");
      // Within a class, a row that shows its place never follows one that does not, and one is
      // shown whenever `placed` says a trusted one exists.
      const placedRanks = callers.shown.map(
        (caller) =>
          MATCH_CLASSES.indexOf(caller.matched) * 2 +
          (caller.site !== null && caller.site.shows !== "caller" ? 0 : 1),
      );
      expect(placedRanks).toEqual([...placedRanks].sort((a, b) => a - b));
      const placedShown = callers.shown.filter(
        (caller) =>
          caller.matched !== "name-only" &&
          caller.site !== null &&
          caller.site.shows !== "caller",
      ).length;
      expect(placedShown).toBeLessThanOrEqual(callers.placed);
      if (callers.placed >= 1) expect(placedShown).toBeGreaterThanOrEqual(1);
      if (callers.total <= callers.shown.length)
        expect(placedShown).toBe(callers.placed);
    };
    for (const slice of slices)
      for (const symbol of slice[side].symbols) {
        list(symbol.callers);
        list(symbol.stillPointingOnBase);
      }
    for (const path of listed) expect(answer[side]).toContain(path);
    if (!capped) expect([...listed].sort()).toEqual([...answer[side]]);
  }
  return slices;
};

const coverage = (
  over: Partial<GraphSnapshotCoverage> = {},
): GraphSnapshotCoverage => ({
  provider: {
    name: "entire-graph",
    version: "fixture",
    identityRevision: "4",
    executable: { sha256: "e".repeat(64), buildIdentity: "verified" },
  },
  repoKey: "local/r",
  schema: { version: "1.3", newerMinor: false, skippedRows: 0 },
  commit: "1".repeat(40),
  tree: "2".repeat(40),
  profile: "full",
  relationSet: ["CALLS", "CONSTRUCTS", "IMPORTS"],
  skippedRelationFamilies: [],
  languageTiers: { JSON: "inventory-only", TypeScript: "semantic" },
  counts: { files: 0, parsedFiles: 0, symbols: 0, relations: 0, externals: 0 },
  partialFailures: [],
  warnings: [],
  gitlinksNotRead: [],
  goBuildExcluded: [],
  health: "ok",
  completenessLevel: "ok",
  ...over,
});

type SymbolSpec = Readonly<{
  id: string;
  path: string;
  start: number;
  end: number;
  name?: string;
  kind?: string;
  qualifiedName?: string;
  container?: string;
  language?: string;
}>;
type RelationSpec = Readonly<{
  from: string;
  to: string;
  resolution: string | null;
  type?: string;
  line?: number | null;
  /** The evidence kind; `call_site` unless given. */
  kind?: string;
  /** The entry's `form`, as an engine that declares call lines sets it. */
  form?: string;
}>;

const fileId = (path: string) => `file:${path}`;

const build = (spec: {
  files: readonly (readonly [string, string | null])[];
  symbols: readonly SymbolSpec[];
  relations?: readonly RelationSpec[];
  imports?: readonly (readonly [string, string])[];
  coverage?: Partial<GraphSnapshotCoverage>;
}) => {
  const builder = new RelationsIndexBuilder();
  for (const [path, language] of spec.files)
    builder.file({ id: fileId(path), path, language, bytes: 1 });
  for (const symbol of spec.symbols)
    builder.symbol({
      id: symbol.id,
      name: symbol.name ?? symbol.id,
      qualifiedName: symbol.qualifiedName ?? symbol.name ?? symbol.id,
      kind: symbol.kind ?? "function",
      language: symbol.language ?? "TypeScript",
      path: symbol.path,
      startLine: symbol.start,
      endLine: symbol.end,
      containerId: symbol.container ?? null,
      signature: null,
    });
  const pathOf = (id: string) =>
    id.startsWith("file:")
      ? id.slice(5)
      : (spec.symbols.find((symbol) => symbol.id === id)?.path ?? "");
  for (const relation of spec.relations ?? [])
    builder.relation({
      relation: relation.type ?? "CALLS",
      fromId: relation.from,
      toId: relation.to,
      targetKind: "symbol",
      resolution: relation.resolution,
      confidence: 0.8,
      scope: null,
      evidence: [
        {
          kind: relation.kind ?? "call_site",
          // `line: null` is a call site with no line, as Graph gives for many file-level calls.
          location:
            relation.line === null
              ? { kind: "path", path: pathOf(relation.from) as SourcePath }
              : {
                  kind: "point",
                  path: pathOf(relation.from) as SourcePath,
                  line: relation.line ?? 1,
                },
          detail: null,
          ...(relation.form === undefined ? {} : { form: relation.form }),
        },
      ],
      warningCodes: [],
      evidenceDropped: 0,
    });
  for (const [from, to] of spec.imports ?? [])
    builder.relation({
      relation: "IMPORTS",
      fromId: fileId(from),
      toId: fileId(to),
      targetKind: "file",
      resolution: "import_resolved",
      confidence: 0.9,
      scope: "module",
      evidence: [],
      warningCodes: [],
      evidenceDropped: 0,
    });
  return builder.finish(coverage(spec.coverage));
};

const noTests = { base: () => false, head: () => false };
const testsUnder = (path: string) => path.startsWith("tests/");
const testDirs = { base: testsUnder, head: testsUnder };

const range = (
  side: "old" | "new",
  path: string,
  startLine: number,
  lineCount = 1,
) => ({ side, path, startLine, lineCount });

const headSymbol = (slice: RelationSlice | undefined, id: string) =>
  slice?.head.symbols.find((entry) => entry.symbol.id === id);
const baseSymbol = (slice: RelationSlice | undefined, id: string) =>
  slice?.base.symbols.find((entry) => entry.symbol.id === id);

const callerPaths = (
  callers: RelationSlice["head"]["symbols"][number]["callers"],
) =>
  callers.evidence === "none"
    ? []
    : callers.shown.map((caller) => [caller.caller.path, caller.support]);

// Why: the measured rule keeps resolved edges and name or type matches only along a direct import
// or within one file; everything else was mostly wrong and must not read as a caller.
test("the support rule in each of its five cases", async () => {
  const files = [
    "t.ts",
    "a.ts",
    "b.ts",
    "c.ts",
    "d.ts",
    "e.ts",
    "f.ts",
    "g.ts",
  ].map((path) => [path, "TypeScript"] as const);
  const index = await build({
    files,
    symbols: [
      { id: "target", path: "t.ts", start: 1, end: 5 },
      { id: "same-file", path: "t.ts", start: 10, end: 12 },
      ...["a", "b", "c", "d", "e", "f", "g"].map((name) => ({
        id: name,
        path: `${name}.ts`,
        start: 1,
        end: 2,
      })),
    ],
    relations: [
      { from: "a", to: "target", resolution: "exact" },
      { from: "b", to: "target", resolution: "import_resolved" },
      { from: "c", to: "target", resolution: "package" },
      { from: "same-file", to: "target", resolution: "name_only" },
      { from: "d", to: "target", resolution: "type_inferred" },
      { from: "e", to: "target", resolution: "name_only" },
      { from: "f", to: "target", resolution: "type_inferred" },
      { from: "g", to: "target", resolution: "pattern" },
    ],
    // d imports the target's file directly; e and f do not.
    imports: [["d.ts", "t.ts"]],
  });
  const [slice] = relationSlices(
    { base: index, head: index },
    [{ key: "s", ranges: [range("new", "t.ts", 2)] }],
    noTests,
  );
  const target = headSymbol(slice, "target");
  expect(callerPaths(target?.callers ?? { evidence: "none" })).toEqual([
    ["a.ts", "resolved"],
    ["b.ts", "resolved"],
    ["c.ts", "resolved"],
    ["d.ts", "import-backed"],
    ["t.ts", "import-backed"],
  ]);
  expect(target?.unsupportedMatchesNotUsed).toBe(3);
});

// Why: a dropped match must be counted so nothing disappears, and never shown as a caller.
test("dropped edges are counted, never listed as callers", async () => {
  const index = await build({
    files: [
      ["t.ts", "TypeScript"],
      ["x.ts", "TypeScript"],
    ],
    symbols: [
      { id: "target", path: "t.ts", start: 1, end: 3 },
      { id: "x", path: "x.ts", start: 1, end: 3 },
    ],
    relations: [
      { from: "x", to: "target", resolution: "name_only" },
      { from: fileId("x.ts"), to: "target", resolution: "name_only" },
    ],
  });
  expect(index.edges.target).toEqual([]);
  const [slice] = relationSlices(
    { base: index, head: index },
    [{ key: "s", ranges: [range("new", "t.ts", 1)] }],
    noTests,
  );
  const target = headSymbol(slice, "target");
  expect(target?.callers).toEqual({ evidence: "none" });
  expect(target?.unsupportedMatchesNotUsed).toBe(2);
});

// Why: Graph records `new X()` on the class, so a constructor's callers are its class's constructions.
test("a constructor reads its class's constructions; another member does not", async () => {
  const index = await build({
    files: [
      ["box.ts", "TypeScript"],
      ["use.ts", "TypeScript"],
    ],
    symbols: [
      {
        id: "Box",
        name: "Box",
        kind: "class",
        path: "box.ts",
        start: 1,
        end: 9,
      },
      {
        id: "Box.constructor",
        name: "constructor",
        kind: "method",
        path: "box.ts",
        start: 2,
        end: 3,
        container: "Box",
      },
      {
        id: "Box.double",
        name: "double",
        kind: "method",
        path: "box.ts",
        start: 4,
        end: 5,
        container: "Box",
      },
      { id: "total", path: "use.ts", start: 1, end: 4 },
    ],
    relations: [
      {
        from: "total",
        to: "Box",
        type: "CONSTRUCTS",
        resolution: "import_resolved",
      },
    ],
  });
  const [slice] = relationSlices(
    { base: index, head: index },
    [{ key: "s", ranges: [range("new", "box.ts", 2, 4)] }],
    noTests,
  );
  const constructor = headSymbol(slice, "Box.constructor");
  expect(constructor?.callers).toMatchObject({
    evidence: "supported",
    total: 1,
    shown: [
      {
        caller: { kind: "symbol", id: "total", path: "use.ts" },
        family: "CONSTRUCTS",
        via: "container-construction",
      },
    ],
  });
  expect(headSymbol(slice, "Box.double")?.callers).toEqual({
    evidence: "none",
  });
  expect(headSymbol(slice, "Box")?.callers).toMatchObject({
    evidence: "supported",
    shown: [{ via: "symbol", family: "CONSTRUCTS" }],
  });
});

// Why: the container reading was measured only for a TypeScript `constructor`; anywhere else a
// construction of the class is not a call of the member, and reading it so would be false evidence.
test("only a TypeScript or JavaScript `constructor` reads its class's constructions", async () => {
  const member = (
    id: string,
    name: string,
    container: string,
    start: number,
    language = "TypeScript",
  ) => ({
    id,
    name,
    kind: "method",
    path:
      language === "Python"
        ? "box.py"
        : language === "JavaScript"
          ? "box.js"
          : "box.ts",
    start,
    end: start,
    container,
    language,
  });
  const index = await build({
    files: [
      ["box.ts", "TypeScript"],
      ["box.py", "Python"],
      ["use.ts", "TypeScript"],
      ["use.py", "Python"],
      ["box.js", "JavaScript"],
      ["use.js", "JavaScript"],
    ],
    symbols: [
      {
        id: "Box",
        name: "Box",
        kind: "class",
        path: "box.ts",
        start: 1,
        end: 9,
      },
      member("Box.init", "init", "Box", 2),
      member("Box.Box", "Box", "Box", 3),
      member("Box.constructor", "constructor", "Box", 4),
      {
        id: "PyBox",
        name: "PyBox",
        kind: "class",
        path: "box.py",
        start: 1,
        end: 9,
        language: "Python",
      },
      member("PyBox.__init__", "__init__", "PyBox", 2, "Python"),
      // Named `constructor` in a language the reading was not measured for.
      member("PyBox.constructor", "constructor", "PyBox", 3, "Python"),
      {
        id: "JsBox",
        name: "JsBox",
        kind: "class",
        path: "box.js",
        start: 1,
        end: 9,
        language: "JavaScript",
      },
      member("JsBox.constructor", "constructor", "JsBox", 2, "JavaScript"),
      { id: "total", path: "use.ts", start: 1, end: 4 },
      { id: "make", path: "use.py", start: 1, end: 4, language: "Python" },
      {
        id: "build",
        path: "use.js",
        start: 1,
        end: 4,
        language: "JavaScript",
      },
    ],
    relations: [
      {
        from: "total",
        to: "Box",
        type: "CONSTRUCTS",
        resolution: "import_resolved",
      },
      {
        from: "make",
        to: "PyBox",
        type: "CONSTRUCTS",
        resolution: "import_resolved",
      },
      {
        from: "build",
        to: "JsBox",
        type: "CONSTRUCTS",
        resolution: "import_resolved",
      },
    ],
    coverage: {
      languageTiers: {
        JavaScript: "semantic",
        Python: "semantic",
        TypeScript: "semantic",
      },
    },
  });
  const [slice] = relationSlices(
    { base: index, head: index },
    [
      {
        key: "s",
        ranges: [
          range("new", "box.ts", 2, 3),
          range("new", "box.py", 2, 2),
          range("new", "box.js", 2),
        ],
      },
    ],
    noTests,
  );
  // The name half of the rule: TypeScript members not named `constructor`, and Python's own name.
  // The language half: a member named `constructor` outside TypeScript and JavaScript.
  for (const id of [
    "Box.init",
    "Box.Box",
    "PyBox.__init__",
    "PyBox.constructor",
  ])
    expect(headSymbol(slice, id)?.callers).toEqual({ evidence: "none" });
  expect(headSymbol(slice, "Box.constructor")?.callers).toMatchObject({
    evidence: "supported",
    total: 1,
    shown: [{ via: "container-construction", caller: { id: "total" } }],
  });
  expect(headSymbol(slice, "JsBox.constructor")?.callers).toMatchObject({
    evidence: "supported",
    total: 1,
    shown: [{ via: "container-construction", caller: { id: "build" } }],
  });
});

// Why: no call-family edge into a kept symbol may vanish: each is kept, or counted as dropped,
// including one whose source has no file to judge support by (an external).
test("every call-family edge into a symbol is kept or counted", async () => {
  const index = await build({
    files: [
      ["t.ts", "TypeScript"],
      ["a.ts", "TypeScript"],
      ["b.ts", "TypeScript"],
    ],
    symbols: [
      { id: "target", path: "t.ts", start: 1, end: 3 },
      { id: "a", path: "a.ts", start: 1, end: 2 },
    ],
    relations: [
      { from: "a", to: "target", resolution: "exact" },
      { from: fileId("b.ts"), to: "target", resolution: "import_resolved" },
      { from: "a", to: "target", type: "ASYNC_CALLS", resolution: "name_only" },
      { from: "external:import:x", to: "target", resolution: "exact" },
      {
        from: fileId("b.ts"),
        to: "target",
        type: "CONSTRUCTS",
        resolution: "pattern",
      },
    ],
  });
  const kept = index.edges.target.length;
  const dropped = index.dropped.count.reduce((sum, count) => sum + count, 0);
  expect([kept, dropped]).toEqual([2, 3]);
  expect(kept + dropped).toBe(5);
});

// Why: two identical edges are one caller; counting both would inflate the total. A different
// family from the same source is a different fact and stays.
test("an exact duplicate edge is one caller, neither kept twice nor counted as dropped", async () => {
  const index = await build({
    files: [
      ["t.ts", "TypeScript"],
      ["a.ts", "TypeScript"],
      ["x.ts", "TypeScript"],
    ],
    symbols: [
      { id: "target", path: "t.ts", start: 1, end: 3 },
      { id: "a", path: "a.ts", start: 1, end: 2 },
      { id: "x", path: "x.ts", start: 1, end: 2 },
    ],
    relations: [
      { from: "a", to: "target", resolution: "import_resolved" },
      { from: "a", to: "target", resolution: "import_resolved", line: 2 },
      {
        from: "a",
        to: "target",
        type: "CONSTRUCTS",
        resolution: "import_resolved",
      },
      { from: "x", to: "target", resolution: "name_only" },
      { from: "x", to: "target", resolution: "name_only" },
    ],
  });
  const [slice] = relationSlices(
    { base: index, head: index },
    [{ key: "s", ranges: [range("new", "t.ts", 1)] }],
    noTests,
  );
  const target = headSymbol(slice, "target");
  expect(target?.callers).toMatchObject({ evidence: "supported", total: 2 });
  const shown =
    target?.callers.evidence === "supported" ? target.callers.shown : [];
  expect(shown.map((caller) => caller.family)).toEqual(["CALLS", "CONSTRUCTS"]);
  expect(shown[0]?.site?.line).toBe(1);
  expect(target?.unsupportedMatchesNotUsed).toBe(1);
});

// Why: the pairing rule is stated, exact and never a guess across files.
test("counterpart by id, by #sig suffix, and none", async () => {
  const base = await build({
    files: [["a.ts", "TypeScript"]],
    symbols: [
      { id: "a:f", name: "f", path: "a.ts", start: 1, end: 2 },
      { id: "a:g#sig:1", name: "g", path: "a.ts", start: 3, end: 4 },
      { id: "a:h", name: "h", path: "a.ts", start: 5, end: 6 },
    ],
  });
  const head = await build({
    files: [
      ["a.ts", "TypeScript"],
      ["b.ts", "TypeScript"],
    ],
    symbols: [
      { id: "a:f", name: "f", path: "a.ts", start: 10, end: 12 },
      { id: "a:g#sig:2", name: "g", path: "a.ts", start: 13, end: 14 },
      // Same name and kind in another file: not a counterpart.
      { id: "b:h", name: "h", path: "b.ts", start: 1, end: 2 },
    ],
  });
  const [slice] = relationSlices(
    { base, head },
    [{ key: "s", ranges: [range("old", "a.ts", 1, 6)] }],
    noTests,
  );
  expect(baseSymbol(slice, "a:f")?.counterpart).toMatchObject({
    rule: "same-id",
    symbol: { id: "a:f", startLine: 10 },
  });
  expect(baseSymbol(slice, "a:g#sig:1")?.counterpart).toMatchObject({
    rule: "same-declaration-other-signature",
    symbol: { id: "a:g#sig:2" },
  });
  expect(baseSymbol(slice, "a:h")?.counterpart).toEqual({
    rule: "none",
    symbol: null,
  });
  expect(slice?.counterpartRule).toContain("#sig:");
  const [gapped] = relationSlices(
    { base, head: { gap: "over-bound", tag: null } },
    [{ key: "s", ranges: [range("old", "a.ts", 1)] }],
    noTests,
  );
  expect(baseSymbol(gapped, "a:f")?.counterpart.rule).toBe(
    "other-side-not-read",
  );
});

// Why: what still points at a removed symbol is its base callers this request left alone, and
// only on the base side.
test("a removed symbol lists only its unchanged base callers", async () => {
  const base = await build({
    files: ["a.ts", "b.ts", "c.ts"].map(
      (path) => [path, "TypeScript"] as const,
    ),
    symbols: [
      { id: "gone", path: "a.ts", start: 1, end: 3 },
      { id: "changed-caller", path: "b.ts", start: 1, end: 3 },
      { id: "kept-caller", path: "c.ts", start: 1, end: 3 },
    ],
    relations: [
      { from: "changed-caller", to: "gone", resolution: "import_resolved" },
      { from: "kept-caller", to: "gone", resolution: "import_resolved" },
      {
        from: fileId("c.ts"),
        to: "gone",
        resolution: "import_resolved",
        line: 9,
      },
    ],
  });
  const head = await build({ files: [["c.ts", "TypeScript"]], symbols: [] });
  const slices = relationSlices(
    { base, head },
    [
      { key: "removal", ranges: [range("old", "a.ts", 1, 3)] },
      { key: "other", ranges: [range("old", "b.ts", 2)] },
    ],
    noTests,
  );
  const gone = baseSymbol(slices[0], "gone");
  expect(gone?.callers).toMatchObject({ evidence: "supported", total: 3 });
  expect(gone?.stillPointingOnBase).toMatchObject({
    evidence: "supported",
    total: 2,
    shown: [
      { caller: { kind: "symbol", id: "kept-caller" }, site: { line: 1 } },
      { caller: { kind: "file", path: "c.ts" }, site: { line: 9 } },
    ],
  });
  expect(slices[0]?.head.symbols).toEqual([]);
});

/** The reproduction's base: `gone` in a.ts, a top-level call in main.ts, a test file's call. */
const removalBase = () =>
  build({
    files: ["src/a.ts", "src/main.ts", "tests/a.test.ts"].map(
      (path) => [path, "TypeScript"] as const,
    ),
    symbols: [{ id: "gone", path: "src/a.ts", start: 1, end: 3 }],
    relations: [
      // File-level callers with no line, as Graph records a top-level call and a call inside a
      // Bun `test(...)` callback.
      {
        from: fileId("src/main.ts"),
        to: "gone",
        resolution: "import_resolved",
        line: null,
      },
      {
        from: fileId("tests/a.test.ts"),
        to: "gone",
        resolution: "import_resolved",
        line: null,
      },
    ],
  });

const stillPointing = (slice: RelationSlice | undefined) => {
  const still = baseSymbol(slice, "gone")?.stillPointingOnBase;
  return still === undefined || still.evidence === "none"
    ? []
    : still.shown.map((caller) => caller.caller.path);
};

// Why: a file-level caller is no changed symbol, so its change must come from the ranges; else a
// change that removes a function with its call and its test still lists both as pointing at it.
test("a file-level caller removed with the symbol is not still pointing at it; an untouched one is", async () => {
  const base = await removalBase();
  const head = await build({
    files: [["src/a.ts", "TypeScript"]],
    symbols: [],
  });
  const removals = relationSlices(
    { base, head },
    [
      { key: "function", ranges: [range("old", "src/a.ts", 1, 3)] },
      { key: "call", ranges: [range("old", "src/main.ts", 2)] },
      { key: "test", ranges: [range("old", "tests/a.test.ts", 3, 3)] },
    ],
    testDirs,
  );
  expect(baseSymbol(removals[0], "gone")?.counterpart.rule).toBe("none");
  expect(stillPointing(removals[0])).toEqual([]);
  expect(baseSymbol(removals[0], "gone")?.callers).toMatchObject({
    evidence: "supported",
    shown: [
      { caller: { path: "src/main.ts" }, changedIn: ["call"] },
      { caller: { path: "tests/a.test.ts" }, changedIn: ["test"] },
    ],
  });
  const functionOnly = relationSlices(
    { base, head },
    [{ key: "function", ranges: [range("old", "src/a.ts", 1, 3)] }],
    testDirs,
  );
  expect(stillPointing(functionOnly[0])).toEqual([
    "src/main.ts",
    "tests/a.test.ts",
  ]);
});

// Why: with the call's line known, only a range covering it establishes the change; another range
// in the same file does not. A line the engine does not declare as the call's establishes nothing,
// so then any range in the file still does, as for a caller with no line.
test("a file-level caller with a known line is changed only by a range that covers it", async () => {
  const baseWith = (callSiteLineLanguages: string[]) =>
    build({
      files: [
        ["src/a.ts", "TypeScript"],
        ["src/main.ts", "TypeScript"],
      ],
      symbols: [{ id: "gone", path: "src/a.ts", start: 1, end: 3 }],
      relations: [
        {
          from: fileId("src/main.ts"),
          to: "gone",
          resolution: "import_resolved",
          line: 20,
          kind: "top_level_call_site",
        },
      ],
      coverage: { callSiteLineLanguages },
    });
  const base = await baseWith(["TypeScript"]);
  const undeclared = await baseWith([]);
  const head = await build({
    files: [["src/a.ts", "TypeScript"]],
    symbols: [],
  });
  const elsewhere = relationSlices(
    { base, head },
    [
      { key: "function", ranges: [range("old", "src/a.ts", 1, 3)] },
      { key: "other lines", ranges: [range("old", "src/main.ts", 2, 5)] },
    ],
    noTests,
  );
  expect(stillPointing(elsewhere[0])).toEqual(["src/main.ts"]);
  const covering = relationSlices(
    { base, head },
    [
      { key: "function", ranges: [range("old", "src/a.ts", 1, 3)] },
      { key: "the call", ranges: [range("old", "src/main.ts", 18, 4)] },
    ],
    noTests,
  );
  expect(stillPointing(covering[0])).toEqual([]);
  expect(baseSymbol(covering[0], "gone")?.callers).toMatchObject({
    shown: [
      {
        caller: { path: "src/main.ts" },
        changedIn: ["the call"],
        site: { path: "src/main.ts", line: 20, shows: "call" },
      },
    ],
  });
  // The same line from an engine that declares no call lines for TypeScript: any range in the file.
  const undeclaredElsewhere = relationSlices(
    { base: undeclared, head },
    [
      { key: "function", ranges: [range("old", "src/a.ts", 1, 3)] },
      { key: "other lines", ranges: [range("old", "src/main.ts", 2, 5)] },
    ],
    noTests,
  );
  expect(stillPointing(undeclaredElsewhere[0])).toEqual([]);
  expect(baseSymbol(undeclaredElsewhere[0], "gone")?.callers).toMatchObject({
    shown: [
      {
        changedIn: ["other lines"],
        site: { path: "src/main.ts", line: 20, shows: "caller" },
      },
    ],
  });
});

// Why: a row may say "called here" only where the engine that wrote the snapshot promises the line
// is the call's, for the caller's language, and "used here" only where it marks a reference; any
// other line is the caller's own and must say so, whatever the line is.
test("a site shows a call, a reference or only the caller, by the read's declaration and the caller's language", async () => {
  const files = [
    ["t.ts", "TypeScript"],
    ["call.ts", "TypeScript"],
    ["ref.ts", "TypeScript"],
    ["noline.ts", "TypeScript"],
    ["other.ts", "TypeScript"],
    ["k.kt", "Kotlin"],
    ["tests/t.test.ts", "TypeScript"],
  ] as const;
  const spec = (callSiteLineLanguages?: string[]) =>
    build({
      files,
      symbols: [
        { id: "target", path: "t.ts", start: 1, end: 3 },
        { id: "call", path: "call.ts", start: 1, end: 9 },
        { id: "ref", path: "ref.ts", start: 1, end: 9 },
        { id: "noline", path: "noline.ts", start: 1, end: 9 },
        { id: "other", path: "other.ts", start: 1, end: 9 },
        { id: "k", path: "k.kt", start: 1, end: 9, language: "Kotlin" },
      ],
      relations: [
        { from: "call", to: "target", resolution: "import_resolved", line: 4 },
        {
          from: "ref",
          to: "target",
          resolution: "import_resolved",
          line: 5,
          form: "reference",
        },
        {
          from: "noline",
          to: "target",
          resolution: "import_resolved",
          line: null,
        },
        // Not a call-site entry: its line shows no place.
        {
          from: "other",
          to: "target",
          resolution: "import_resolved",
          line: 6,
          kind: "route_endpoint_match",
        },
        // A language the engine does not list: the caller's own first line.
        { from: "k", to: "target", resolution: "exact", line: 1 },
        {
          from: fileId("tests/t.test.ts"),
          to: "target",
          resolution: "import_resolved",
          line: 7,
          kind: "top_level_call_site",
        },
      ],
      ...(callSiteLineLanguages === undefined
        ? {}
        : { coverage: { callSiteLineLanguages } }),
    });
  const sitesOf = (index: RelationsIndex) => {
    const [slice] = relationSlices(
      { base: index, head: index },
      [{ key: "s", ranges: [range("new", "t.ts", 2)] }],
      testDirs,
    );
    const target = headSymbol(slice, "target");
    return {
      sites: Object.fromEntries(
        (target?.callers.evidence === "supported"
          ? target.callers.shown
          : []
        ).map((row) => [row.caller.path, row.site]),
      ),
      callers: target?.callers,
      testCallers: target?.testCallers,
    };
  };
  const declared = sitesOf(await spec(["TypeScript", "Go"]));
  expect(declared.sites).toEqual({
    "call.ts": { path: "call.ts", line: 4, shows: "call" },
    "ref.ts": { path: "ref.ts", line: 5, shows: "reference" },
    "noline.ts": { path: "noline.ts", line: null, shows: "caller" },
    "other.ts": { path: "other.ts", line: 6, shows: "caller" },
    "k.kt": { path: "k.kt", line: 1, shows: "caller" },
    "tests/t.test.ts": { path: "tests/t.test.ts", line: 7, shows: "call" },
  });
  expect(declared.callers).toMatchObject({ total: 6, trusted: 6, placed: 3 });
  expect(declared.testCallers).toEqual({
    evidence: "supported",
    total: 1,
    trusted: 1,
    placed: 1,
  });
  // The same edges from an engine that declares no call lines (or a coverage built before the
  // field): every site shows only its caller, with the same line.
  for (const undeclared of [await spec([]), await spec()]) {
    const read = sitesOf(undeclared);
    for (const [path, site] of Object.entries(declared.sites))
      expect([path, read.sites[path]]).toEqual([
        path,
        site === null ? null : { ...site, shows: "caller" },
      ]);
    expect(read.callers).toMatchObject({ total: 6, trusted: 6, placed: 0 });
    expect(read.testCallers).toMatchObject({ trusted: 1, placed: 0 });
  }
});

// Why: the stored index is decoded by its schema; a place claimed with no line in the caller's own
// file is a damaged index, never a row that says "called here" about nothing.
test("an index whose site shows a place without a line in the caller's file is refused", async () => {
  const index = await build({
    files: [
      ["t.ts", "TypeScript"],
      ["a.ts", "TypeScript"],
    ],
    symbols: [
      { id: "target", path: "t.ts", start: 1, end: 3 },
      { id: "a", path: "a.ts", start: 1, end: 3 },
    ],
    relations: [
      { from: "a", to: "target", resolution: "import_resolved", line: 2 },
    ],
    coverage: { callSiteLineLanguages: ["TypeScript"] },
  });
  expect(index.edges.siteShows).toEqual([0]);
  expect(RelationsIndex.safeParse(index).success).toBe(true);
  const noLine = structuredClone(index);
  noLine.edges.siteLine[0] = 0;
  expect(RelationsIndex.safeParse(noLine).success).toBe(false);
  const otherFile = structuredClone(index);
  otherFile.edges.sitePath[0] = otherFile.strings.indexOf("t.ts");
  expect(RelationsIndex.safeParse(otherFile).success).toBe(false);
  const caller = structuredClone(noLine);
  caller.edges.siteShows[0] = 2;
  expect(RelationsIndex.safeParse(caller).success).toBe(true);
});

// Why: a reader looks at the first rows; within a class, a row that shows where the target is called
// or used must come before one that cannot, whatever the path order, and the cap must never hide
// the only trusted row that shows its place.
test("rows that show a place come first in their class, and the cap keeps the first trusted one", async () => {
  const many = 60;
  const callers = Array.from(
    { length: many },
    (_, at) => `a${String(at).padStart(2, "0")}`,
  );
  const index = await build({
    files: [
      ["t.ts", "TypeScript"],
      ...callers.map((id) => [`${id}.ts`, "TypeScript"] as const),
      ["z.ts", "TypeScript"],
      ["y.ts", "TypeScript"],
      ["k.kt", "Kotlin"],
    ],
    symbols: [
      { id: "target", path: "t.ts", start: 1, end: 3 },
      ...callers.map((id) => ({ id, path: `${id}.ts`, start: 1, end: 3 })),
      { id: "z", path: "z.ts", start: 1, end: 9 },
      { id: "y", path: "y.ts", start: 1, end: 9 },
      { id: "k", path: "k.kt", start: 1, end: 9, language: "Kotlin" },
    ],
    // Sixty resolved callers that show no place (a language not listed would do; here, no line),
    // one receiver-type caller in the last path that shows its call, and one that shows nothing.
    relations: [
      ...callers.map((id) => ({
        from: id,
        to: "target",
        resolution: "import_resolved",
        line: null,
      })),
      { from: "z", to: "target", resolution: "type_inferred", line: 5 },
      { from: "y", to: "target", resolution: "type_inferred", line: null },
      { from: "k", to: "target", resolution: "exact", line: 1 },
    ],
    imports: [
      ["z.ts", "t.ts"],
      ["y.ts", "t.ts"],
    ],
    coverage: { callSiteLineLanguages: ["TypeScript"] },
  });
  const [slice] = relationSlices(
    { base: index, head: index },
    [{ key: "s", ranges: [range("new", "t.ts", 2)] }],
    noTests,
  );
  const target = headSymbol(slice, "target");
  expect(target?.callers).toMatchObject({
    evidence: "supported",
    total: many + 3,
    trusted: many + 3,
    placed: 1,
  });
  const shown =
    target?.callers.evidence === "supported" ? target.callers.shown : [];
  expect(shown).toHaveLength(CALLERS_PER_SYMBOL);
  // Past the cap by class and path, the one placed row is kept, first among the receiver-type rows.
  const receiverType = shown.filter((row) => row.matched === "receiver-type");
  expect(receiverType[0]?.caller.path).toBe("z.ts");
  expect(receiverType[0]?.site).toEqual({
    path: "z.ts",
    line: 5,
    shows: "call",
  });
  // The class order still comes first: the resolved rows that show no place lead.
  expect(shown[0]?.matched).toBe("resolved");
  expect(shown[0]?.site?.shows).toBe("caller");
});

// Why: a reviewer needs to see which other changed parts call into this one.
test("edges between changed symbols name the other subject", async () => {
  const index = await build({
    files: [
      ["a.ts", "TypeScript"],
      ["b.ts", "TypeScript"],
    ],
    symbols: [
      { id: "f", path: "a.ts", start: 1, end: 3 },
      { id: "g", path: "b.ts", start: 1, end: 3 },
    ],
    relations: [{ from: "f", to: "g", resolution: "import_resolved" }],
  });
  const [first, second] = relationSlices(
    { base: index, head: index },
    [
      { key: "A", ranges: [range("new", "a.ts", 2)] },
      { key: "B", ranges: [range("new", "b.ts", 2)] },
    ],
    noTests,
  );
  expect(headSymbol(first, "f")?.changedEdges).toEqual([
    {
      direction: "out",
      other: { id: "g", subjects: ["B"] },
      family: "CALLS",
      support: "resolved",
      matched: "resolved",
    },
  ]);
  expect(headSymbol(second, "g")?.changedEdges).toEqual([
    {
      direction: "in",
      other: { id: "f", subjects: ["A"] },
      family: "CALLS",
      support: "resolved",
      matched: "resolved",
    },
  ]);
  expect(headSymbol(second, "g")?.callers).toMatchObject({
    shown: [{ changedIn: ["A"] }],
  });
});

// Why: every reason a range has no relation evidence must be said, so no gap reads as "none".
test("every coverage state: side gap, file not in snapshot, not parsed, non-semantic, outside every symbol", async () => {
  const head = await build({
    files: [
      ["a.ts", "TypeScript"],
      ["min.ts", "TypeScript"],
      ["data.json", "JSON"],
    ],
    symbols: [
      { id: "f", path: "a.ts", start: 5, end: 9 },
      {
        id: "key",
        kind: "property",
        path: "data.json",
        start: 1,
        end: 3,
        language: "JSON",
      },
    ],
    coverage: {
      partialFailures: [{ path: "min.ts", codes: ["E_MINIFIED"] }],
      gitlinksNotRead: [{ path: "vendor/lib", commit: "b".repeat(40) }],
      goBuildExcluded: [{ path: "x_windows.go" }],
    },
  });
  const [slice] = relationSlices(
    { base: { gap: "failed", tag: "deadline" }, head },
    [
      {
        key: "s",
        ranges: [
          range("old", "a.ts", 1),
          range("new", "a.ts", 1, 2),
          range("new", "a.ts", 6),
          range("new", "min.ts", 1),
          range("new", "data.json", 2),
          range("new", "vendor/lib/x.ts", 1),
          range("new", "x_windows.go", 1),
          range("new", "bun.lock", 1),
          range("new", "a.ts", 3, 0),
        ],
      },
    ],
    noTests,
  );
  expect(slice?.base).toEqual({
    read: { kind: "gap", gap: "failed", tag: "deadline" },
    paths: [{ path: "a.ts", snapshot: { kind: "side-not-read" } }],
    ranges: [{ ...range("old", "a.ts", 1), match: "side-not-read" }],
    symbols: [],
  });
  expect(slice?.head.read).toMatchObject({
    kind: "read",
    commit: "1".repeat(40),
    profile: "full",
    engine: { name: "entire-graph", sha256: "e".repeat(64) },
  });
  expect(slice?.head.paths).toEqual([
    {
      path: "a.ts",
      snapshot: {
        kind: "read",
        language: "TypeScript",
        tier: "semantic",
        parsed: true,
        failures: [],
      },
    },
    {
      path: "min.ts",
      snapshot: {
        kind: "read",
        language: "TypeScript",
        tier: "semantic",
        parsed: false,
        failures: ["E_MINIFIED"],
      },
    },
    {
      path: "data.json",
      snapshot: {
        kind: "read",
        language: "JSON",
        tier: "inventory-only",
        parsed: true,
        failures: [],
      },
    },
    {
      path: "vendor/lib/x.ts",
      snapshot: { kind: "not-in-snapshot", reason: "under-gitlink" },
    },
    {
      path: "x_windows.go",
      snapshot: { kind: "not-in-snapshot", reason: "go-build-excluded" },
    },
    {
      path: "bun.lock",
      snapshot: { kind: "not-in-snapshot", reason: "no-file-record" },
    },
  ]);
  expect(slice?.head.ranges.map((entry) => entry.match)).toEqual([
    "outside-every-symbol",
    "symbol",
    "outside-every-symbol",
    "outside-every-symbol",
    "file-not-read",
    "file-not-read",
    "file-not-read",
    "no-lines",
  ]);
});

// Why: with no supported edge the slice must say "no evidence", never a count of zero callers.
test("a subject with no evidence has no caller count and carries its coverage and the blind spots", async () => {
  const index = await build({
    files: [["a.ts", "TypeScript"]],
    symbols: [{ id: "lonely", path: "a.ts", start: 1, end: 3 }],
  });
  const [slice] = relationSlices(
    { base: index, head: index },
    [{ key: "s", ranges: [range("new", "a.ts", 2)] }],
    testDirs,
  );
  const lonely = headSymbol(slice, "lonely");
  expect(lonely?.callers).toEqual({ evidence: "none" });
  expect(lonely?.testCallers).toEqual({ evidence: "none" });
  // The list is pinned, in order: a slice must carry every standing blind spot.
  expect(slice?.blindSpots).toEqual([
    "jsx-element-use",
    "function-used-as-value",
    "call-through-namespace",
    "go-method-through-receiver",
    "one-call-site-per-caller",
    "call-to-function-declared-in-caller",
  ]);
  expect(slice?.blindSpots).toEqual(STANDING_BLIND_SPOTS);
  expect(slice?.head.paths).toHaveLength(1);
  const text = JSON.stringify(slice);
  expect(text).not.toMatch(/"total":0\b/);
  expect(text).not.toMatch(/"callers":0\b/);
});

// Why: one widely called symbol must not make a slice unbounded, and the cut must not depend on
// stream order or hide that tests call it.
test("the cap keeps the total, keeps a test caller and is deterministic", async () => {
  const callers = Array.from({ length: 60 }, (_, at) => ({
    id: `c${String(at).padStart(2, "0")}`,
    // The test callers sort last by path, so only the reservation keeps one.
    path:
      at < 55
        ? `src/c${String(at).padStart(2, "0")}.ts`
        : `tests/t${at}.test.ts`,
    start: 1,
    end: 2,
  }));
  const files = [
    ["t.ts", "TypeScript"] as const,
    ...callers.map((caller) => [caller.path, "TypeScript"] as const),
  ];
  const symbols = [{ id: "hub", path: "t.ts", start: 1, end: 9 }, ...callers];
  const relations = callers.map((caller) => ({
    from: caller.id,
    to: "hub",
    resolution: "import_resolved",
  }));
  const forward = await build({ files, symbols, relations });
  const backward = await build({
    files,
    symbols,
    relations: [...relations].reverse(),
  });
  const subjects = [{ key: "s", ranges: [range("new", "t.ts", 1)] }];
  const [one] = relationSlices(
    { base: forward, head: forward },
    subjects,
    testDirs,
  );
  const [two] = relationSlices(
    { base: backward, head: backward },
    subjects,
    testDirs,
  );
  const hub = headSymbol(one, "hub");
  expect(hub?.callers).toMatchObject({ evidence: "supported", total: 60 });
  const shown = hub?.callers.evidence === "supported" ? hub.callers.shown : [];
  expect(shown).toHaveLength(CALLERS_PER_SYMBOL);
  expect(shown.filter((caller) => caller.test)).toHaveLength(1);
  expect(hub?.testCallers).toEqual({
    evidence: "supported",
    total: 5,
    trusted: 5,
    placed: 0,
  });
  expect(headSymbol(two, "hub")?.callers).toEqual(hub?.callers);
});

// Why: a range across two declarations changes both, and a member inside a class is innermost.
test("a range touching two symbols lists both, innermost first", async () => {
  const index = await build({
    files: [["a.ts", "TypeScript"]],
    symbols: [
      { id: "Outer", kind: "class", path: "a.ts", start: 1, end: 20 },
      {
        id: "first",
        kind: "method",
        path: "a.ts",
        start: 2,
        end: 6,
        container: "Outer",
      },
      {
        id: "second",
        kind: "method",
        path: "a.ts",
        start: 7,
        end: 9,
        container: "Outer",
      },
    ],
  });
  const [slice] = relationSlices(
    { base: index, head: index },
    [{ key: "s", ranges: [range("new", "a.ts", 5, 3)] }],
    noTests,
  );
  expect(
    slice?.head.symbols.map((entry) => [entry.symbol.id, entry.innermost]),
  ).toEqual([
    ["second", true],
    ["first", true],
    ["Outer", false],
  ]);
});

// Why: the slice is a pure function of its input: same answer every time, input untouched.
test("the function is pure", async () => {
  const base = await build({
    files: [
      ["a.ts", "TypeScript"],
      ["tests/a.test.ts", "TypeScript"],
    ],
    symbols: [{ id: "f", path: "a.ts", start: 1, end: 3 }],
    relations: [
      {
        from: fileId("tests/a.test.ts"),
        to: "f",
        resolution: "import_resolved",
      },
    ],
  });
  const head: RelationsSide = { gap: "over-bound", tag: null };
  const subjects: SliceSubject[] = [
    { key: "s", ranges: [range("old", "a.ts", 2), range("new", "a.ts", 2)] },
  ];
  const before = structuredClone({ base, head, subjects });
  const first = relationSlices({ base, head }, subjects, testDirs);
  const second = relationSlices({ base, head }, subjects, testDirs);
  expect(second).toEqual(first);
  expect({ base, head, subjects }).toEqual(before);
  expect(RelationsIndex.safeParse(base).success).toBe(true);
  expect(baseSymbol(first[0], "f")?.testCallers).toEqual({
    evidence: "supported",
    total: 1,
    trusted: 1,
    placed: 0,
  });
});

// Why: the readers read the declarations of these paths before they slice once; a caller past the
// per-symbol cap still counts toward the test callers, so its path must be named too, and a side
// that is a gap or a range that touches no symbol names none.
test("the caller paths name every caller the slices would ask about, past the cap too", async () => {
  const callers = Array.from({ length: 60 }, (_, at) => ({
    id: `c${String(at).padStart(2, "0")}`,
    path: `src/c${String(at).padStart(2, "0")}.ts`,
    start: 1,
    end: 2,
  }));
  const index = await build({
    files: [
      ["t.ts", "TypeScript"] as const,
      ["u.ts", "TypeScript"] as const,
      ...callers.map((caller) => [caller.path, "TypeScript"] as const),
    ],
    symbols: [
      { id: "hub", path: "t.ts", start: 1, end: 9 },
      { id: "quiet", path: "u.ts", start: 1, end: 9 },
      ...callers,
    ],
    relations: callers.map((caller) => ({
      from: caller.id,
      to: "hub",
      resolution: "import_resolved",
    })),
  });
  const gap: RelationsSide = { gap: "over-bound", tag: "not-stored" };
  const subjects: SliceSubject[] = [
    { key: "s", ranges: [range("new", "t.ts", 1), range("old", "t.ts", 1)] },
  ];
  const paths = relationCallerPaths({ base: gap, head: index }, subjects);
  expect(paths.base).toEqual([]);
  expect(paths.head).toEqual(callers.map((caller) => caller.path));
  // Checked against the slices by the wrapper above, past the cap.
  relationSlices({ base: gap, head: index }, subjects, noTests);
  // A range of no lines, one in a file the side did not read, and one on a symbol nobody calls.
  expect(
    relationCallerPaths({ base: index, head: index }, [
      {
        key: "s",
        ranges: [
          range("new", "t.ts", 1, 0),
          range("new", "missing.ts", 1),
          range("new", "u.ts", 1),
        ],
      },
    ]),
  ).toEqual({ base: [], head: [] });
});

/** Each shown caller's path with how it was matched. */
const matchedRows = (callers: SliceCallers | undefined) =>
  callers === undefined || callers.evidence === "none"
    ? []
    : callers.shown.map((caller) => [caller.caller.path, caller.matched]);

// Why: the readers lift a section's missing-evidence gap only on rows matched by the engine or by
// the receiver's type; a name-only row is context. So every row must say which it is, from the
// engine's own resolution, on every kind of row a consumer reads.
test("every caller row, changed edge and still-pointing row says how it was matched", async () => {
  const files = [
    "t.ts",
    "exact.ts",
    "imported.ts",
    "package.ts",
    "typed.ts",
    "named.ts",
  ].map((path) => [path, "TypeScript"] as const);
  const symbols = [
    { id: "target", path: "t.ts", start: 1, end: 5 },
    { id: "same-file", path: "t.ts", start: 10, end: 12 },
    { id: "exact", path: "exact.ts", start: 1, end: 2 },
    { id: "imported", path: "imported.ts", start: 1, end: 2 },
    { id: "package", path: "package.ts", start: 1, end: 2 },
    { id: "typed", path: "typed.ts", start: 1, end: 2 },
    { id: "named", path: "named.ts", start: 1, end: 2 },
  ];
  const relations = [
    { from: "exact", to: "target", resolution: "exact" },
    { from: "imported", to: "target", resolution: "import_resolved" },
    { from: "package", to: "target", resolution: "package" },
    { from: "typed", to: "target", resolution: "type_inferred" },
    { from: "named", to: "target", resolution: "name_only" },
    { from: "same-file", to: "target", resolution: "name_only" },
  ];
  const imports = [
    ["typed.ts", "t.ts"],
    ["named.ts", "t.ts"],
  ] as const;
  const index = await build({ files, symbols, relations, imports });
  const [slice] = relationSlices(
    { base: index, head: index },
    [{ key: "s", ranges: [range("new", "t.ts", 2)] }],
    noTests,
  );
  const target = headSymbol(slice, "target");
  // In class order (resolved, receiver type, name only), by path within a class.
  expect(matchedRows(target?.callers)).toEqual([
    ["exact.ts", "resolved"],
    ["imported.ts", "resolved"],
    ["package.ts", "resolved"],
    ["typed.ts", "receiver-type"],
    ["named.ts", "name-only"],
    ["t.ts", "name-only"],
  ]);
  // `support` is unchanged beside it: both import-path classes stay `import-backed`.
  expect(
    target?.callers.evidence === "supported"
      ? target.callers.shown.map((caller) => caller.support)
      : [],
  ).toEqual([
    "resolved",
    "resolved",
    "resolved",
    "import-backed",
    "import-backed",
    "import-backed",
  ]);
  expect(target?.callers).toMatchObject({ total: 6, trusted: 4 });

  // Changed edges: every caller is a changed symbol of another subject.
  const callerKeys = ["exact", "imported", "package", "typed", "named"];
  const changed = relationSlices(
    { base: index, head: index },
    [
      { key: "s", ranges: [range("new", "t.ts", 2), range("new", "t.ts", 11)] },
      ...callerKeys.map((key) => ({
        key,
        ranges: [range("new", `${key}.ts`, 1)],
      })),
    ],
    noTests,
  );
  expect(
    headSymbol(changed[0], "target")?.changedEdges.map((edge) => [
      edge.direction,
      edge.other.id,
      edge.matched,
    ]),
  ).toEqual([
    ["in", "exact", "resolved"],
    ["in", "imported", "resolved"],
    ["in", "named", "name-only"],
    ["in", "package", "resolved"],
    ["in", "same-file", "name-only"],
    ["in", "typed", "receiver-type"],
  ]);
  expect(
    headSymbol(changed[1], "exact")?.changedEdges.map((edge) => [
      edge.direction,
      edge.other.id,
      edge.matched,
    ]),
  ).toEqual([["out", "target", "resolved"]]);

  // Still pointing on the base: the head has no counterpart, and no caller changed.
  const head = await build({ files: [["t.ts", "TypeScript"]], symbols: [] });
  const [removed] = relationSlices(
    { base: index, head },
    [{ key: "s", ranges: [range("old", "t.ts", 2)] }],
    noTests,
  );
  const gone = baseSymbol(removed, "target");
  expect(gone?.counterpart.rule).toBe("none");
  expect(matchedRows(gone?.stillPointingOnBase)).toEqual(
    matchedRows(target?.callers),
  );
  expect(gone?.stillPointingOnBase).toMatchObject({ total: 6, trusted: 4 });
});

// Why: a constructor's callers are its class's constructions, so each such row is as trusted as
// the construction edge under it, no more.
test("a constructor's construction rows carry the construction edge's match class", async () => {
  const index = await build({
    files: [
      ["box.ts", "TypeScript"],
      ["a.ts", "TypeScript"],
      ["b.ts", "TypeScript"],
      ["c.ts", "TypeScript"],
    ],
    symbols: [
      {
        id: "Box",
        name: "Box",
        kind: "class",
        path: "box.ts",
        start: 1,
        end: 9,
      },
      {
        id: "Box.constructor",
        name: "constructor",
        kind: "method",
        path: "box.ts",
        start: 2,
        end: 3,
        container: "Box",
      },
      { id: "a", path: "a.ts", start: 1, end: 2 },
      { id: "b", path: "b.ts", start: 1, end: 2 },
      { id: "c", path: "c.ts", start: 1, end: 2 },
    ],
    relations: [
      {
        from: "a",
        to: "Box",
        type: "CONSTRUCTS",
        resolution: "import_resolved",
      },
      { from: "b", to: "Box", type: "CONSTRUCTS", resolution: "type_inferred" },
      { from: "c", to: "Box", type: "CONSTRUCTS", resolution: "name_only" },
    ],
    imports: [
      ["b.ts", "box.ts"],
      ["c.ts", "box.ts"],
    ],
  });
  const [slice] = relationSlices(
    { base: index, head: index },
    [{ key: "s", ranges: [range("new", "box.ts", 2)] }],
    noTests,
  );
  const constructor = headSymbol(slice, "Box.constructor");
  expect(
    constructor?.callers.evidence === "supported"
      ? constructor.callers.shown.map((caller) => [
          caller.caller.path,
          caller.via,
          caller.matched,
        ])
      : [],
  ).toEqual([
    ["a.ts", "container-construction", "resolved"],
    ["b.ts", "container-construction", "receiver-type"],
    ["c.ts", "container-construction", "name-only"],
  ]);
  expect(constructor?.callers).toMatchObject({ total: 3, trusted: 2 });
});

// Why: a consumer decides from the counts without walking rows; a symbol called only by name is
// still supported (it has rows to show) but has nothing that may count, for callers and for tests.
test("the counts say how many callers and test callers may count, and none when all are name-only", async () => {
  const files = [
    "t.ts",
    "u.ts",
    "src/typed.ts",
    "src/named.ts",
    "tests/resolved.test.ts",
    "tests/typed.test.ts",
    "tests/named.test.ts",
  ].map((path) => [path, "TypeScript"] as const);
  const index = await build({
    files,
    symbols: [
      { id: "mixed", path: "t.ts", start: 1, end: 5 },
      { id: "only-named", path: "u.ts", start: 1, end: 5 },
      { id: "typed", path: "src/typed.ts", start: 1, end: 2 },
      { id: "named", path: "src/named.ts", start: 1, end: 2 },
    ],
    relations: [
      { from: "typed", to: "mixed", resolution: "type_inferred" },
      { from: "named", to: "mixed", resolution: "name_only" },
      {
        from: fileId("tests/resolved.test.ts"),
        to: "mixed",
        resolution: "import_resolved",
      },
      {
        from: fileId("tests/typed.test.ts"),
        to: "mixed",
        resolution: "type_inferred",
      },
      {
        from: fileId("tests/named.test.ts"),
        to: "mixed",
        resolution: "name_only",
      },
      { from: "named", to: "only-named", resolution: "name_only" },
      {
        from: fileId("tests/named.test.ts"),
        to: "only-named",
        resolution: "name_only",
      },
    ],
    imports: [
      ["src/typed.ts", "t.ts"],
      ["src/named.ts", "t.ts"],
      ["src/named.ts", "u.ts"],
      ["tests/typed.test.ts", "t.ts"],
      ["tests/named.test.ts", "t.ts"],
      ["tests/named.test.ts", "u.ts"],
    ],
  });
  const [slice] = relationSlices(
    { base: index, head: index },
    [
      {
        key: "s",
        ranges: [range("new", "t.ts", 2), range("new", "u.ts", 2)],
      },
    ],
    testDirs,
  );
  const mixed = headSymbol(slice, "mixed");
  expect(mixed?.callers).toMatchObject({
    evidence: "supported",
    total: 5,
    trusted: 3,
  });
  expect(mixed?.testCallers).toEqual({
    evidence: "supported",
    total: 3,
    trusted: 2,
    placed: 0,
  });
  const onlyNamed = headSymbol(slice, "only-named");
  expect(onlyNamed?.callers).toMatchObject({
    evidence: "supported",
    total: 2,
    trusted: 0,
  });
  expect(onlyNamed?.testCallers).toEqual({
    evidence: "supported",
    total: 1,
    trusted: 0,
    placed: 0,
  });
});

// Why: a consumer that reads the first shown rows must meet a trusted caller whenever one exists:
// trusted callers that would sort past the cap by path are shown first, and still counted.
test("trusted callers that sort past the cap by path are shown first and counted", async () => {
  const named = Array.from({ length: 55 }, (_, at) => ({
    id: `a${String(at).padStart(2, "0")}`,
    path: `src/a${String(at).padStart(2, "0")}.ts`,
    start: 1,
    end: 2,
  }));
  // These sort after every name-only caller by path; by class they come first.
  const typed = Array.from({ length: 5 }, (_, at) => ({
    id: `z${at}`,
    path: `src/z${at}.ts`,
    start: 1,
    end: 2,
  }));
  const callers = [...named, ...typed];
  const index = await build({
    files: [
      ["t.ts", "TypeScript"] as const,
      ...callers.map((caller) => [caller.path, "TypeScript"] as const),
    ],
    symbols: [{ id: "hub", path: "t.ts", start: 1, end: 9 }, ...callers],
    relations: [
      ...named.map((caller) => ({
        from: caller.id,
        to: "hub",
        resolution: "name_only",
      })),
      ...typed.map((caller) => ({
        from: caller.id,
        to: "hub",
        resolution: "type_inferred",
      })),
    ],
    imports: callers.map((caller) => [caller.path, "t.ts"] as const),
  });
  const [slice] = relationSlices(
    { base: index, head: index },
    [{ key: "s", ranges: [range("new", "t.ts", 1)] }],
    noTests,
  );
  const hub = headSymbol(slice, "hub");
  expect(hub?.callers).toMatchObject({
    evidence: "supported",
    total: 60,
    trusted: 5,
  });
  const shown = hub?.callers.evidence === "supported" ? hub.callers.shown : [];
  expect(shown).toHaveLength(CALLERS_PER_SYMBOL);
  expect(shown.map((caller) => [caller.caller.path, caller.matched])).toEqual([
    ...typed.map((caller) => [caller.path, "receiver-type"]),
    ...named.slice(0, 45).map((caller) => [caller.path, "name-only"]),
  ]);
});

// Why: Graph's name-only match of a TypeScript receiver call to a method of the caller's own file
// was right 2 times of 10 by hand, while name-only matches of other shapes along an import were
// mostly right; the support rule drops exactly that shape, counts it, and keeps every other.
test("a TypeScript name-only match to a method of the caller's own file is dropped and counted; every other shape is kept", async () => {
  const index = await build({
    files: [
      ["k.ts", "TypeScript"],
      ["use.ts", "TypeScript"],
      ["k.go", "Go"],
    ],
    symbols: [
      { id: "K", name: "K", kind: "class", path: "k.ts", start: 1, end: 20 },
      {
        id: "K.go",
        name: "go",
        kind: "method",
        path: "k.ts",
        start: 2,
        end: 4,
        container: "K",
      },
      {
        id: "K.run",
        name: "run",
        kind: "method",
        path: "k.ts",
        start: 5,
        end: 7,
        container: "K",
      },
      {
        id: "K.typed",
        name: "typed",
        kind: "method",
        path: "k.ts",
        start: 8,
        end: 10,
        container: "K",
      },
      { id: "helper", path: "k.ts", start: 21, end: 23 },
      { id: "local", path: "k.ts", start: 24, end: 26 },
      { id: "user", path: "use.ts", start: 1, end: 5 },
      {
        id: "T.walk",
        name: "walk",
        kind: "method",
        path: "k.go",
        start: 1,
        end: 3,
        container: "T",
        language: "Go",
      },
      {
        id: "T.step",
        name: "step",
        kind: "method",
        path: "k.go",
        start: 4,
        end: 6,
        container: "T",
        language: "Go",
      },
    ],
    relations: [
      // Dropped: name only, TypeScript, a method of the caller's own file, from a symbol and from
      // the file itself.
      { from: "K.run", to: "K.go", resolution: "name_only" },
      { from: fileId("k.ts"), to: "K.go", resolution: "name_only" },
      // Kept: the same method matched by the receiver's type, or resolved.
      { from: "K.run", to: "K.typed", resolution: "type_inferred" },
      { from: "local", to: "K.typed", resolution: "exact" },
      // Kept: name only to a function of the same file.
      { from: "local", to: "helper", resolution: "name_only" },
      // Kept: name only, along an import, to a method and to a function of another file.
      { from: "user", to: "K.go", resolution: "name_only" },
      { from: "user", to: "helper", resolution: "name_only" },
      // Kept: name only to a Go method of the caller's own file.
      { from: "T.step", to: "T.walk", resolution: "name_only" },
    ],
    imports: [["use.ts", "k.ts"]],
    coverage: {
      languageTiers: { Go: "semantic", TypeScript: "semantic" },
    },
  });
  const [slice] = relationSlices(
    { base: index, head: index },
    [
      {
        key: "s",
        ranges: [
          range("new", "k.ts", 3),
          range("new", "k.ts", 9),
          range("new", "k.ts", 22),
          range("new", "k.go", 2),
        ],
      },
    ],
    noTests,
  );
  const rows = (id: string) => matchedRows(headSymbol(slice, id)?.callers);
  expect(rows("K.go")).toEqual([["use.ts", "name-only"]]);
  expect(headSymbol(slice, "K.go")?.callers).toMatchObject({
    total: 1,
    trusted: 0,
  });
  expect(headSymbol(slice, "K.go")?.unsupportedMatchesNotUsed).toBe(2);
  expect(rows("K.typed")).toEqual([
    ["k.ts", "resolved"],
    ["k.ts", "receiver-type"],
  ]);
  expect(headSymbol(slice, "K.typed")?.unsupportedMatchesNotUsed).toBe(0);
  expect(rows("helper")).toEqual([
    ["k.ts", "name-only"],
    ["use.ts", "name-only"],
  ]);
  expect(headSymbol(slice, "helper")?.unsupportedMatchesNotUsed).toBe(0);
  expect(rows("T.walk")).toEqual([["k.go", "name-only"]]);
  expect(headSymbol(slice, "T.walk")?.unsupportedMatchesNotUsed).toBe(0);
  // Every call-family edge is kept or counted: 6 kept, 2 dropped.
  expect(index.edges.target).toHaveLength(6);
  expect(index.dropped.count.reduce((sum, count) => sum + count, 0)).toBe(2);
});

// Why: the readers call `relationCallerPaths` and then `relationSlices` on the same stored index for
// every reading group; the view behind both is built once per index object, not once per call.
test("the caller paths and then the slices of one index build one view, and a copy of the index its own", async () => {
  const index = await build({
    files: [
      ["t.ts", "TypeScript"],
      ["a.ts", "TypeScript"],
    ],
    symbols: [
      { id: "target", path: "t.ts", start: 1, end: 3 },
      { id: "a", path: "a.ts", start: 1, end: 2 },
    ],
    relations: [{ from: "a", to: "target", resolution: "import_resolved" }],
  });
  const subjects = [{ key: "s", ranges: [range("new", "t.ts", 2)] }];
  const before = relationSliceViewsBuilt();
  // The same index object on both sides is one view.
  relationCallerPaths({ base: index, head: index }, subjects);
  expect(relationSliceViewsBuilt()).toBe(before + 1);
  slicesOf({ base: index, head: index }, subjects, noTests);
  relationCallerPaths({ base: index, head: index }, subjects);
  expect(relationSliceViewsBuilt()).toBe(before + 1);
  // Another object, equal in value, is another view: a view is held by object, never by value.
  slicesOf({ base: index, head: structuredClone(index) }, subjects, noTests);
  expect(relationSliceViewsBuilt()).toBe(before + 2);
  // Slicing never changes the index it reads.
  expect(Object.isFrozen(index)).toBe(false);
  expect(RelationsIndex.safeParse(index).success).toBe(true);
});

/** `count` callers of `hub` in their own files, named `prefix` and a number. */
const callersNamed = (prefix: string, count: number, folder = "src") =>
  Array.from({ length: count }, (_, at) => ({
    id: `${prefix}${String(at).padStart(2, "0")}`,
    path: `${folder}/${prefix}${String(at).padStart(2, "0")}.ts`,
    start: 1,
    end: 2,
  }));

// Why: `trusted` must count every trusted caller, not the shown ones: with more trusted callers
// than the cap shows, a count taken from the shown rows would stop at the cap.
test("trusted counts every trusted caller past the cap, not the rows shown", async () => {
  const resolved = callersNamed("r", 60);
  const named = callersNamed("n", 5);
  const callers = [...resolved, ...named];
  const index = await build({
    files: [
      ["t.ts", "TypeScript"] as const,
      ...callers.map((caller) => [caller.path, "TypeScript"] as const),
    ],
    symbols: [{ id: "hub", path: "t.ts", start: 1, end: 9 }, ...callers],
    relations: [
      ...resolved.map((caller) => ({
        from: caller.id,
        to: "hub",
        resolution: "import_resolved",
      })),
      ...named.map((caller) => ({
        from: caller.id,
        to: "hub",
        resolution: "name_only",
      })),
    ],
    imports: named.map((caller) => [caller.path, "t.ts"] as const),
  });
  const [slice] = relationSlices(
    { base: index, head: index },
    [{ key: "s", ranges: [range("new", "t.ts", 1)] }],
    noTests,
  );
  const hub = headSymbol(slice, "hub");
  expect(hub?.callers).toMatchObject({ total: 65, trusted: 60 });
  const shown = hub?.callers.evidence === "supported" ? hub.callers.shown : [];
  expect(shown).toHaveLength(CALLERS_PER_SYMBOL);
  expect(shown.every((caller) => caller.matched === "resolved")).toBe(true);
});

// Why: past the cap the first test caller is kept by reservation; when it is name-only it must still
// come after every trusted row, so it can never be the first row shown while a trusted one exists.
test("a reserved name-only test caller never comes before a trusted caller", async () => {
  const resolved = callersNamed("r", 55);
  const [tester] = callersNamed("t", 1, "tests");
  if (tester === undefined) throw new Error("no test caller");
  const index = await build({
    files: [
      ["t.ts", "TypeScript"] as const,
      ...[...resolved, tester].map(
        (caller) => [caller.path, "TypeScript"] as const,
      ),
    ],
    symbols: [
      { id: "hub", path: "t.ts", start: 1, end: 9 },
      ...resolved,
      tester,
    ],
    relations: [
      ...resolved.map((caller) => ({
        from: caller.id,
        to: "hub",
        resolution: "import_resolved",
      })),
      { from: tester.id, to: "hub", resolution: "name_only" },
    ],
    imports: [[tester.path, "t.ts"]],
  });
  const [slice] = relationSlices(
    { base: index, head: index },
    [{ key: "s", ranges: [range("new", "t.ts", 1)] }],
    testDirs,
  );
  const hub = headSymbol(slice, "hub");
  expect(hub?.callers).toMatchObject({ total: 56, trusted: 55 });
  const shown = hub?.callers.evidence === "supported" ? hub.callers.shown : [];
  expect(shown).toHaveLength(CALLERS_PER_SYMBOL);
  // The reservation kept the test caller, and it is last: every trusted row comes before it.
  expect(shown[0]?.matched).toBe("resolved");
  expect(shown.at(-1)).toMatchObject({
    caller: { path: tester.path },
    matched: "name-only",
    test: true,
  });
  expect(shown.filter((caller) => caller.matched === "name-only")).toHaveLength(
    1,
  );
  expect(hub?.testCallers).toEqual({
    evidence: "supported",
    total: 1,
    trusted: 0,
    placed: 0,
  });
});

// Why: the support rule never keeps a resolution it does not know, but a stored index is data; a
// resolution no rule names must read as `name-only`, never as evidence.
test("an edge with a resolution no rule names reads as name-only", async () => {
  const built = await build({
    files: [
      ["t.ts", "TypeScript"],
      ["a.ts", "TypeScript"],
    ],
    symbols: [
      { id: "target", path: "t.ts", start: 1, end: 3 },
      { id: "a", path: "a.ts", start: 1, end: 2 },
    ],
    relations: [{ from: "a", to: "target", resolution: "import_resolved" }],
  });
  // By hand: the kept edge's resolution is one the engine never gives.
  const index = structuredClone(built);
  const at = index.edges.resolution[0];
  if (at === undefined) throw new Error("no edge");
  index.strings[at] = "guessed_by_a_newer_engine";
  expect(RelationsIndex.safeParse(index).success).toBe(true);
  expect(matchClassOf("guessed_by_a_newer_engine")).toBe("name-only");
  const [slice] = relationSlices(
    { base: index, head: index },
    [{ key: "s", ranges: [range("new", "t.ts", 2)] }],
    noTests,
  );
  const target = headSymbol(slice, "target");
  expect(matchedRows(target?.callers)).toEqual([["a.ts", "name-only"]]);
  expect(target?.callers).toMatchObject({ total: 1, trusted: 0 });
});

// Why: a view is shared by every caller on its index, so a consumer that changed in place an array
// the view holds would change other callers' answers; the seal turns that into an error. The one
// array a view shares with its index is each partial failure's `codes`.
test("changing in place an array a slicing view holds throws once the view is built", async () => {
  const index = await build({
    files: [["min.ts", "TypeScript"]],
    symbols: [{ id: "f", path: "min.ts", start: 1, end: 2 }],
    coverage: {
      partialFailures: [{ path: "min.ts", codes: ["E_MINIFIED"] }],
    },
  });
  const codes = index.coverage.partialFailures[0]?.codes as
    string[] | undefined;
  if (codes === undefined) throw new Error("no failure");
  expect(Object.isFrozen(codes)).toBe(false);
  const [slice] = relationSlices(
    { base: index, head: index },
    [{ key: "s", ranges: [range("new", "min.ts", 1)] }],
    noTests,
  );
  expect(slice?.head.paths[0]?.snapshot).toMatchObject({
    parsed: false,
    failures: ["E_MINIFIED"],
  });
  expect(() => codes.push("E_LATER")).toThrow(TypeError);
  expect(() => {
    codes[0] = "E_CHANGED";
  }).toThrow(TypeError);
  // The answer a later caller gets is unchanged.
  const [again] = relationSlices(
    { base: index, head: index },
    [{ key: "s", ranges: [range("new", "min.ts", 1)] }],
    noTests,
  );
  expect(again?.head.paths[0]?.snapshot).toMatchObject({
    failures: ["E_MINIFIED"],
  });
  // The slice's own copy is the consumer's to change.
  const failures = slice?.head.paths[0]?.snapshot;
  if (failures?.kind !== "read") throw new Error("not read");
  expect(Object.isFrozen(failures.failures)).toBe(false);
});
