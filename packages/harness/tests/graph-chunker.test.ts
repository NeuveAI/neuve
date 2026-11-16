import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { readGraphSymbols } from "@neuve/graph-client";
import type {
  GraphFileObservation,
  GraphFileSymbol,
  GraphProviderObservation,
} from "@neuve/graph-client";
import {
  chunkFile,
  retryableFallback,
  chunkerKey,
  declaresCodePositions,
  splitLines,
  WINDOW_RECIPE,
} from "../src/chunker.ts";

const provider: GraphProviderObservation = {
  name: "entire-graph",
  version: "fixture",
  identityRevision: "4",
  executable: { sha256: "a".repeat(64), buildIdentity: "verified" },
  capabilities: {
    schemaVersion: "1.3",
    relationSelectionModes: [],
    relationFamilies: {},
    supportedFileExtensions: [".ts", ".py", ".go"],
    supportedLanguages: ["TypeScript", "Python", "Go"],
    semanticLanguages: ["TypeScript", "Python", "Go"],
    inventoryOnlyLanguages: [],
    supportedRelationTypes: [],
    relationSupportByLanguage: {},
    relationSupportByProfile: {},
    heuristicRelationTypes: [],
    parserVersions: {},
    unsupportedButDetectedLanguageHints: [],
    optionalLocalOnlyFeatures: { symbols_outline: true },
    featuresRequiringNetworkAccess: {},
  },
};
const symbol = (
  name: string,
  startLine: number,
  endLine: number,
  containerId: string | null = null,
  kind = "function",
): GraphFileSymbol => ({
  id: name,
  name,
  qualifiedName: name,
  kind,
  startLine,
  endLine,
  containerId,
});
const observation = (
  topLevel: NonNullable<GraphFileObservation["outline"]>["topLevel"],
  symbols: readonly GraphFileSymbol[],
  language = "TypeScript",
): GraphFileObservation => ({
  language,
  symbols,
  partialFailure: null,
  outline: { topLevel, identifiers: [[1, "fromCode"]] },
});
const node = (startLine: number, endLine: number, type = "statement") => ({
  startLine,
  endLine,
  type,
  imports: type === "import_statement",
});
const run = (
  path: string,
  text: string,
  value: GraphFileObservation | undefined,
  engine = provider,
) =>
  chunkFile(path, text, {
    kind: "available",
    provider: engine,
    observation: value,
  });
const ranges = (value: ReturnType<typeof chunkFile>) =>
  value.chunks.map(({ startLine, endLine, kind }) => [
    startLine,
    endLine,
    kind,
  ]);

// These compare the new boundary source with the retained baseline and protect complete line coverage and bounded chunks.
test("outline imports and exported declarations keep declared boundaries", () => {
  const text =
    'import { a } from "a";\nimport { b } from "b";\n\nexport function first() {\n' +
    "  a(); b(); // body text\n".repeat(16) +
    "}\n\nexport function second() { return 2; }\n";
  const value = observation(
    [
      node(1, 1, "import_statement"),
      node(2, 2, "import_statement"),
      node(4, 21),
      node(23, 23),
    ],
    [symbol("first", 4, 21), symbol("second", 23, 23)],
  );
  const chunked = run("a.ts", text, value);
  expect(ranges(chunked)).toEqual([
    [1, 2, "symbol"],
    [3, 21, "symbol"],
    [22, 23, "symbol"],
  ]);
  expect(chunked.chunks.flatMap((chunk) => chunk.callables)).toEqual([
    "first",
    "second",
  ]);
  expect(chunked.chunks[0]?.identifiers).toEqual(["fromCode"]);
  expect(declaresCodePositions(chunked)).toBe(true);
  expect(declaresCodePositions("graph-symbols")).toBe(true);
});

test("merges overlapping units and joins gaps to the next unit", () => {
  const text =
    "// heading\nconst a = 1;\nconst b = 2;\n\n\nfunction c() {}\n// tail\n";
  const chunked = run(
    "a.ts",
    text,
    observation(
      [node(2, 3), node(3, 3), node(6, 6)],
      [
        symbol("a", 2, 2, null, "variable"),
        symbol("b", 3, 3, null, "variable"),
        symbol("c", 6, 6),
      ],
    ),
  );
  expect(chunked.chunks).toHaveLength(1);
  expect(chunked.chunks[0]?.symbol).toBe("a,b,c");
  expect(chunked.chunks[0]?.startLine).toBe(1);
  expect(chunked.chunks[0]?.endLine).toBe(7);
});

test("a large class opens into methods with head and tail; a large describe without nested symbols uses windows", () => {
  const classText =
    "export class Service {\n  first() {\n" +
    "    doWork(); // padding for a method\n".repeat(72) +
    "  }\n  second() {\n" +
    "    doMore(); // padding for a method\n".repeat(72) +
    "  }\n}\n";
  const klass = run(
    "a.ts",
    classText,
    observation(
      [node(1, 150)],
      [
        symbol("Service", 1, 150, null, "class"),
        symbol("first", 2, 75, "Service", "method"),
        symbol("second", 76, 149, "Service", "method"),
      ],
    ),
  );
  expect(klass.chunks.some((chunk) => chunk.symbol === "first")).toBe(true);
  expect(klass.chunks.some((chunk) => chunk.symbol === "second")).toBe(true);
  const describe =
    'describe("large", () => {\n' +
    '  it("works", () => expect(true).toBe(true));\n'.repeat(150) +
    "});\n";
  const chunked = run("a.ts", describe, observation([node(1, 152)], []));
  expect(chunked.chunks.every((chunk) => chunk.kind === "window")).toBe(true);
  for (const result of [klass, chunked])
    for (const chunk of result.chunks) {
      const lines = splitLines(result === klass ? classText : describe);
      expect(
        Buffer.byteLength(
          lines.slice(chunk.startLine - 1, chunk.endLine).join(""),
        ),
      ).toBeLessThanOrEqual(4096);
    }
  expect(chunked.chunks[0]?.startLine).toBe(1);
  expect(chunked.chunks.at(-1)?.endLine).toBe(152);
});

// Four grammar edges must still reach statements; the same-line wrapper
// overlaps cannot trigger windows before the useful list is visited.
test("outline children pass through dominant wrappers without requiring symbols", () => {
  const text =
    'describe("large", () => {\n' +
    '  it("works", () => expect(true).toBe(true));\n'.repeat(150) +
    "});\n";
  const statements = Array.from({ length: 150 }, (_, index) =>
    node(index + 2, index + 2),
  );
  const body = { ...node(1, 152), children: statements };
  const arrow = { ...node(1, 152), children: [node(1, 1), body] };
  const args = { ...node(1, 152), children: [node(1, 1), arrow] };
  const root = { ...node(1, 152), children: [node(1, 1), args] };
  const chunked = run("a.ts", text, observation([root], []));
  expect(ranges(chunked)).toEqual([
    [1, 22, "symbol"],
    [23, 44, "symbol"],
    [45, 66, "symbol"],
    [67, 88, "symbol"],
    [89, 110, "symbol"],
    [111, 132, "symbol"],
    [133, 152, "symbol"],
  ]);
  const limitedBody = { ...body, children: [node(2, 150), node(151, 151)] };
  const limitedArrow = { ...arrow, children: [node(1, 1), limitedBody] };
  const limitedArgs = { ...args, children: [node(1, 1), limitedArrow] };
  let limitedRoot = { ...root, children: [node(1, 1), limitedArgs] };
  for (let i = 0; i < 12; i++)
    limitedRoot = { ...root, children: [node(1, 1), limitedRoot] };
  expect(
    run("a.ts", text, observation([limitedRoot], [])).outlineLimits,
  ).toEqual([{ startLine: 2, endLine: 150 }]);
  expect(
    run("a.ts", text, observation([node(1, 152)], [])).chunks.every(
      (chunk) => chunk.kind === "window",
    ),
  ).toBe(true);
});

test("Python and Go use Graph's reported language and callable positions", () => {
  for (const [path, text, language] of [
    ["a.py", "def greet():\n    return 1\n", "Python"],
    ["a.go", "package main\nfunc greet() int { return 1 }\n", "Go"],
  ]) {
    if (!path || !text || !language) throw new Error("Invalid fixture");
    const value = run(
      path,
      text,
      observation(
        [node(1, 2)],
        [symbol("greet", path.endsWith("go") ? 2 : 1, 2)],
        language,
      ),
    );
    expect(value.language).toBe(language);
    expect(value.capability).toBe("graph-symbols");
    expect(value.chunks[0]?.callables).toEqual(["greet"]);
  }
});

test("discloses unavailable, failed, missing outline, empty parse, and symbols-only observations", () => {
  const text = "function alpha() {}\n";
  const value = observation([node(1, 1)], [symbol("alpha", 1, 1)]);
  expect(chunkFile("a.ts", text, { kind: "unavailable" }).fallback).toBe(
    "capability-unavailable",
  );
  expect(
    run("a.ts", text, { ...value, partialFailure: "E_PARSE_ERROR" }).fallback,
  ).toBe("parse-error");
  expect(run("a.ts", text, { ...value, outline: null }).fallback).toBe(
    "outline-unavailable",
  );
  expect(run("a.ts", text, undefined).capability).toBe(WINDOW_RECIPE);
  const empty = run("a.ts", "// only a comment\n", observation([], []));
  expect(empty.chunks[0]?.kind).toBe("window");
  expect(empty.fallback).toBeUndefined();
  const oldProvider = {
    ...provider,
    capabilities: { ...provider.capabilities, optionalLocalOnlyFeatures: {} },
  };
  const old = run("a.ts", text, { ...value, outline: null }, oldProvider);
  expect(old.fallback).toBe("outline-unavailable");
  expect(old.chunks[0]?.kind).toBe("window");
  expect(declaresCodePositions(old)).toBe(false);
  expect(run("a.md", "# Hello\n", undefined).capability).toBe(
    "markdown-sections",
  );
});

test("keys include provider identity before parsing, and keep unavailable keys separate", () => {
  expect(chunkerKey(provider)).not.toEqual(
    chunkerKey({ ...provider, identityRevision: "next" }),
  );
  expect(chunkerKey(provider)).not.toEqual(
    chunkerKey({
      ...provider,
      executable: { ...provider.executable, sha256: "b".repeat(64) },
    }),
  );
  expect(chunkerKey(provider)).not.toEqual(chunkerKey(null));
});

// Run against the lane's real outline binary when available, to check the parser contract independently.
const outlineExecutable = process.env["NEUVE_GRAPH_OUTLINE_EXECUTABLE"];
test.skipIf(!outlineExecutable)(
  "real outlines agree with top-level spans across representative TS and parse Python and Go",
  async () => {
    if (!outlineExecutable) throw new Error("Outline executable required");
    const files = [
      {
        path: "imports.ts",
        text: 'import { a } from "a";\nimport { b } from "b";\n',
      },
      {
        path: "exports.ts",
        text: "export function alpha() {\n return 1;\n}\nexport const beta = () => 2;\n",
      },
      {
        path: "describe.ts",
        text:
          'describe("ignoredString", () => {\n' +
          ' it("case", () => expect(true).toBe(true));\n'.repeat(150) +
          "});\n",
      },
      {
        path: "class.ts",
        text:
          "export class Service {\n first() {\n" +
          "  doWork(); // ignoredComment\n".repeat(90) +
          " }\n second() {\n" +
          "  doMore(); // ignoredComment\n".repeat(90) +
          " }\n}\n",
      },
      { path: "a.py", text: "def alpha():\n    return 1\n" },
      { path: "a.go", text: "package main\nfunc alpha() int { return 1 }\n" },
    ];
    const result = await readGraphSymbols({
      executable: outlineExecutable,
      temporaryParent: tmpdir(),
      files: files.map((file) => ({
        path: file.path,
        bytes: new TextEncoder().encode(file.text),
      })),
    });
    expect(result.outlinesAvailable).toBe(true);
    for (const file of files) {
      const observed = result.files.get(file.path);
      expect(observed?.partialFailure).toBeNull();
      if (!observed?.outline) throw new Error(`No outline for ${file.path}`);
      if (file.path.endsWith(".ts")) {
        const chunked = chunkFile(file.path, file.text, {
          kind: "available",
          provider: result.provider,
          observation: observed,
        });
        expect(chunked.chunks.length).toBeGreaterThan(0);
        expect(chunked.chunks[0]?.startLine).toBe(1);
        expect(chunked.chunks.at(-1)?.endLine).toBe(
          splitLines(file.text).length,
        );
      } else
        expect(observed.symbols.some((symbol) => symbol.name === "alpha")).toBe(
          true,
        );
      const identifiers = observed.outline.identifiers.flatMap(
        ([, ...names]) => names,
      );
      expect(identifiers).not.toContain("ignoredString");
      expect(identifiers).not.toContain("ignoredComment");
    }
  },
);

// Inventory-only languages must preserve the baseline's exact-data boundaries.
test("JSON under 4 KiB stays one window despite Graph key outlines", () => {
  const text =
    JSON.stringify(
      { name: "fixture", exports: { main: "./index.ts" } },
      null,
      2,
    ) + "\n";
  const engine: GraphProviderObservation = {
    ...provider,
    capabilities: {
      ...provider.capabilities,
      supportedFileExtensions: [".json"],
      inventoryOnlyLanguages: ["JSON"],
    },
  };
  const data = run(
    "package.json",
    text,
    observation([node(1, 2), node(3, 6)], [], "JSON"),
    engine,
  );
  expect(data.chunks).toEqual(
    chunkFile("package.json", text, { kind: "unavailable" }).chunks,
  );
  expect(data.capability).toBe(WINDOW_RECIPE);
  expect(data.fallback).toBe("unsupported-language");
  expect(declaresCodePositions(data)).toBe(false);
});

// These cases guard the disclosed boundary for any non-empty source, including one huge line.
for (const [name, path, context, fallback] of [
  ["unavailable", "a.ts", { kind: "unavailable" }, "capability-unavailable"],
  [
    "unsupported",
    "a.unknown",
    { kind: "available", provider, observation: undefined },
    "unsupported-language",
  ],
  [
    "partial",
    "a.ts",
    {
      kind: "available",
      provider,
      observation: { ...observation([], []), partialFailure: "parse" },
    },
    "partial-failure",
  ],
] satisfies readonly [
  string,
  string,
  import("../src/chunker.ts").GraphChunkContext,
  import("../src/chunker.ts").ChunkedFile["fallback"],
][]) {
  test(`fallback ${name} is named and never loses a non-empty file`, () => {
    for (const text of ["const x = 1;\n", "x".repeat(5000), "  \n"]) {
      const chunked = chunkFile(path, text, context);
      expect(chunked.fallback).toBe(fallback);
      expect(chunked.capability).toBe(WINDOW_RECIPE);
      expect(chunked.chunks.length).toBeGreaterThan(0);
      expect(chunked.chunks[0]?.startLine).toBe(1);
      expect(chunked.chunks.at(-1)?.endLine).toBe(splitLines(text).length);
    }
  });
}

// Stable parser/policy results must be reusable; limits and I/O failures must recover.
test("fallback reuse distinguishes deterministic results from transient failures", () => {
  const value = observation([node(1, 1)], [symbol("alpha", 1, 1)]);
  for (const [code, name] of [
    ["E_PARSE_ERROR", "parse-error"],
    ["E_PARSE_DEPTH_EXCEEDED", "parse-error"],
    ["E_MINIFIED", "source-not-parsed"],
    ["E_FILE_TOO_LARGE", "source-not-parsed"],
    ["E_UNSUPPORTED_LANGUAGE", "unsupported-language"],
  ] satisfies readonly [
    string,
    NonNullable<import("../src/chunker.ts").ChunkedFile["fallback"]>,
  ][]) {
    const chunked = run("a.ts", "function alpha() {}\n", {
      ...value,
      partialFailure: code,
    });
    expect(chunked.fallback).toBe(name);
    expect(retryableFallback(chunked.fallback)).toBe(false);
  }
  for (const code of [
    "E_PARSE_TIMEOUT",
    "E_FILE_READ",
    "symbols-output-limit",
    "future-failure",
  ]) {
    const chunked = run("a.ts", "function alpha() {}\n", {
      ...value,
      partialFailure: code,
    });
    expect(chunked.fallback).toBe("partial-failure");
    expect(retryableFallback(chunked.fallback)).toBe(true);
  }
  const missing = run("a.ts", "function alpha() {}\n", undefined);
  expect(missing.fallback).toBe("outline-unavailable");
  expect(retryableFallback(missing.fallback)).toBe(false);
  const mixed = run("a.ts", "function alpha() {}\n", {
    ...value,
    partialFailure: "E_PARSE_ERROR",
    partialFailures: ["E_PARSE_TIMEOUT", "E_PARSE_ERROR"],
  });
  expect(mixed.fallback).toBe("partial-failure");
  expect(retryableFallback(mixed.fallback)).toBe(true);
  expect(retryableFallback("future-fallback")).toBe(true);
});
