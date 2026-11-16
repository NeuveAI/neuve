// Why: the token rules were built and reviewed on records made by hand; this file runs them on
// Graph's own records, through the real tokens read, and the stored rules through the real store.
// Real records differ from hand-built ones in ways a stand-in lexer cannot show (a byte-order mark
// outside every leaf, a line feed inside a block comment, Python's per-module statements, the
// engine's directive flags), and the stored key must keep a judgement read with tokens apart from
// one read without, and never keep a retryable one. Each test names the result it pins and why.
// Engine tests run where `NEUVE_GRAPH_OUTLINE_EXECUTABLE` names an engine that declares tokens.
import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Layer, Option } from "effect";
import {
  graphGapAfterLast,
  graphGapBefore,
  type GraphFileTokens,
} from "@neuve/graph-client";
import {
  Blobs,
  Computations,
  Store,
  storeLocationIn,
} from "@neuve/records-core";

import { graphTestPrerequisite } from "../../../scripts/graph-test-prerequisite.ts";
import { CpuWork } from "../src/budget/cpu.ts";
import { Scheduler } from "../src/budget/scheduler.ts";
import { CodeWork } from "../src/code-work.ts";
import {
  GRAPH_SOURCE_BINDING,
  captureOutlineSource,
  outlineReadKey,
  readOutlines,
  type OutlineBatch,
  type OutlineSource,
} from "../src/graph-outline.ts";
import type { ManifestHunk } from "../src/manifest.ts";
import { relationsRound, type RelationsRound } from "../src/relations.ts";
import { computeSectionFacts } from "../src/section-facts.ts";
import {
  linguistMarkOf,
  nearestManifest,
  SECTION_RULE_VERSIONS,
  sectionRulesOf,
  storedSectionRules,
  type FileSignals,
  type SectionRuleJudgement,
  type SectionRulesOptions,
} from "../src/section-rules.ts";
import {
  comparedStretches,
  type SectionRelations,
} from "../src/section-token-rules.ts";
import { computeBlobStructure, type BlobStructure } from "../src/sections.ts";
import { diff, oidOf } from "./section-fixtures.ts";

const encoder = new TextEncoder();
const source = captureOutlineSource();

/** Whether an engine declares an optional local feature (`capabilities --json`). */
const declares = (executable: string, feature: string) => {
  if (!existsSync(executable)) return false;
  const result = Bun.spawnSync([executable, "capabilities", "--json"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) return false;
  try {
    const parsed = JSON.parse(result.stdout.toString()) as {
      optional_local_only_features?: Record<string, unknown>;
    };
    return parsed.optional_local_only_features?.[feature] === true;
  } catch {
    return false;
  }
};
const graph = graphTestPrerequisite({
  available:
    "sha256" in source.key &&
    declares(source.executable, "symbols_outline_tokens"),
  message:
    "The Graph engine at NEUVE_GRAPH_OUTLINE_EXECUTABLE (or apps/neuve-graph/entire-graph) does not declare symbols_outline_tokens: build the engine with tokens, or point the variable at one.",
});
// The relations read needs exact-commit streams too, as `relations-real.test.ts` requires.
const relationsGraph = graphTestPrerequisite({
  available:
    !graph.skip && declares(source.executable, "exact_commit_bulk_streams"),
  message:
    "The Graph engine at NEUVE_GRAPH_OUTLINE_EXECUTABLE (or apps/neuve-graph/entire-graph) does not declare symbols_outline_tokens and exact_commit_bulk_streams.",
});

/**
 * An engine that declares outlines but no tokens, for the two tests of the `unsupported` outcome:
 * `NEUVE_GRAPH_ENGINE_WITHOUT_TOKENS`, else this worktree's own engine where it is built before
 * tokens. Where there is none (the submodule's engine declares tokens), those two tests skip in
 * every mode: they need a second engine, not a capability of the one under test.
 */
const OLDER_ENGINE =
  process.env.NEUVE_GRAPH_ENGINE_WITHOUT_TOKENS ??
  resolve(import.meta.dir, "../../../apps/neuve-graph/entire-graph");
const olderEngine =
  existsSync(OLDER_ENGINE) &&
  declares(OLDER_ENGINE, "symbols_outline") &&
  !declares(OLDER_ENGINE, "symbols_outline_tokens");
const sourceOf = (executable: string): OutlineSource => {
  const previous = process.env.NEUVE_GRAPH_OUTLINE_EXECUTABLE;
  process.env.NEUVE_GRAPH_OUTLINE_EXECUTABLE = executable;
  try {
    return captureOutlineSource();
  } finally {
    if (previous === undefined)
      delete process.env.NEUVE_GRAPH_OUTLINE_EXECUTABLE;
    else process.env.NEUVE_GRAPH_OUTLINE_EXECUTABLE = previous;
  }
};

const root = mkdtempSync(join(tmpdir(), "section-tokens-real-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

// --- One read of many texts, and the rules on a one-file change -------------------------------

interface Text {
  readonly path: string;
  readonly text: string;
}

/** One outline read with tokens of every text; each read path once. */
const readTokens = (texts: ReadonlyArray<Text>) =>
  readOutlines(
    texts.map((entry) => ({
      path: entry.path,
      bytes: encoder.encode(entry.text),
    })),
    source,
    undefined,
    (run) => run(1),
    false,
    undefined,
    { tokens: true },
  );

const tokensAt = (batch: OutlineBatch, path: string): GraphFileTokens => {
  const context = batch.context(path);
  if (context.kind !== "available" || context.observation?.tokens === undefined)
    throw new Error(`No tokens read for ${path}`);
  return context.observation.tokens;
};

const signals = (path: string): FileSignals => ({
  attributes: {
    "linguist-generated": { state: "unspecified", value: null },
    "linguist-vendored": { state: "unspecified", value: null },
  },
  blob: null,
  read: false,
  mark: linguistMarkOf(path),
});

/**
 * The judgements of one file's change, from the structures and tokens Graph read for its two texts
 * under `read.base` and `read.head` (any paths of the same suffix).
 */
const judge = (
  batch: OutlineBatch,
  change: {
    readonly path: string;
    readonly base: string;
    readonly head: string;
    readonly read: { readonly base: string; readonly head: string };
  },
  relations?: SectionRelations,
): ReadonlyArray<SectionRuleJudgement> => {
  const hunks = diff(change.path, change.base, change.head);
  const structures = new Map<string, BlobStructure>();
  const byBlob = new Map<string, GraphFileTokens>();
  const contents = new Map<string, Uint8Array>();
  for (const [text, read] of [
    [change.base, change.read.base],
    [change.head, change.read.head],
  ] as const) {
    const blob = oidOf(text);
    structures.set(
      blob,
      computeBlobStructure(change.path, text, batch.context(read)).structure,
    );
    byBlob.set(blob, tokensAt(batch, read));
    contents.set(blob, encoder.encode(text));
  }
  return sectionRulesOf({
    result: computeSectionFacts(hunks, structures),
    hunks,
    structures,
    files: new Map([[change.path, signals(change.path)]]),
    texts: new Map(),
    tokens: { byBlob },
    contents,
    ...(relations === undefined ? {} : { relations }),
  });
};

const outcomes = (
  rules: ReadonlyArray<SectionRuleJudgement>,
  rule: SectionRuleJudgement["rule"],
) =>
  rules
    .filter((judgement) => judgement.rule === rule)
    .map((judgement) => [judgement.result, judgement.reason]);

/** The layout rules that hold: a "no change" is one of them holding, a change is neither. */
const layoutHolding = (rules: ReadonlyArray<SectionRuleJudgement>) =>
  rules
    .filter(
      (judgement) =>
        (judgement.rule === "whitespace-only" ||
          judgement.rule === "comment-only") &&
        judgement.result === "holds",
    )
    .map((judgement) => judgement.rule);

// --- The layout reference, on real tokens ------------------------------------------------------

interface LayoutCase {
  readonly name: string;
  readonly path: string;
  readonly base: string;
  readonly head: string;
  readonly changesWithGaps: boolean | null;
}
/** The graph lane's reference cases (`census-1-reference/layout-cases.jsonl`), copied here. */
const LAYOUT_CASES: ReadonlyArray<LayoutCase> = readFileSync(
  join(import.meta.dir, "fixtures/layout-cases.jsonl"),
  "utf8",
)
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line) as LayoutCase);

const suffixOf = (path: string) => path.slice(path.lastIndexOf("."));
const readPath = (index: number, side: "base" | "head", path: string) =>
  `layout/${index}/${side}${suffixOf(path)}`;

const BOM = "﻿";
const BOM_CHANGES = [
  { path: "a.ts", base: "const a = 1;\n", head: `${BOM}const a = 1;\n` },
  { path: "a.ts", base: `${BOM}const a = 1;\n`, head: "const a = 1;\n" },
] as const;

/** Every text the layout tests read, in one read. */
const layoutTexts = (): Array<Text> => [
  ...LAYOUT_CASES.flatMap((layoutCase, index) => [
    { path: readPath(index, "base", layoutCase.path), text: layoutCase.base },
    { path: readPath(index, "head", layoutCase.path), text: layoutCase.head },
  ]),
  ...BOM_CHANGES.flatMap((change, index) => [
    { path: `bom/${index}/base.ts`, text: change.base },
    { path: `bom/${index}/head.ts`, text: change.head },
  ]),
];

let layoutBatch: Promise<OutlineBatch> | undefined;
const layoutRead = () => (layoutBatch ??= readTokens(layoutTexts()));

test.skipIf(graph.skip)(
  "the layout reference on real tokens: every case of a language Graph declares reads as its changesWithGaps column says",
  async () => {
    // Why: equal leaves are not equal behaviour; the gaps between tokens decide, and only the
    // engine's own leaves show where its tree puts them. A case of a language Graph does not
    // declare (JSON has no outline) gives no record and is no case here.
    graph.require();
    const batch = await layoutRead();
    const judged: Array<string> = [];
    const undeclared: Array<string> = [];
    for (const [index, layoutCase] of LAYOUT_CASES.entries()) {
      const read = {
        base: readPath(index, "base", layoutCase.path),
        head: readPath(index, "head", layoutCase.path),
      };
      const records = [tokensAt(batch, read.base), tokensAt(batch, read.head)];
      if (
        records.some(
          (record) =>
            record.status === "unavailable" &&
            record.reason === "unsupported-language",
        )
      ) {
        undeclared.push(layoutCase.name);
        continue;
      }
      expect([layoutCase.name, records.map((record) => record.status)]).toEqual(
        [layoutCase.name, ["available", "available"]],
      );
      const holding = layoutHolding(judge(batch, { ...layoutCase, read }));
      expect([layoutCase.name, holding.length > 0]).toEqual([
        layoutCase.name,
        layoutCase.changesWithGaps === false,
      ]);
      judged.push(layoutCase.name);
    }
    expect(undeclared.sort()).toEqual(["json-key-order", "json-reindented"]);
    expect(judged.length).toBe(LAYOUT_CASES.length - 2);
  },
  120_000,
);

test.skipIf(graph.skip)(
  "a line break inside a block comment between `return` and its value reads as a change in TypeScript and Go",
  async () => {
    // Why: TypeScript ends the return at a line break inside a comment, and Go inserts a semicolon
    // there, though the leaves are equal and the comment is prose; only a stretch that counts the
    // comment's own bytes sees it. The base, the same comment on one line, is the control.
    graph.require();
    const batch = await layoutRead();
    for (const name of [
      "ts-line-break-inside-block-comment",
      "go-line-break-inside-block-comment",
    ]) {
      const index = LAYOUT_CASES.findIndex((entry) => entry.name === name);
      const layoutCase = LAYOUT_CASES[index]!;
      const read = {
        base: readPath(index, "base", layoutCase.path),
        head: readPath(index, "head", layoutCase.path),
      };
      expect([
        name,
        layoutHolding(judge(batch, { ...layoutCase, read })),
      ]).toEqual([name, []]);
      // The same file with a prose comment changed on its one line is comment-only.
      const reworded = layoutCase.base.replace(
        "the note below",
        "the note above",
      );
      const control = await readTokens([
        {
          path: `control/base${suffixOf(layoutCase.path)}`,
          text: layoutCase.base,
        },
        { path: `control/head${suffixOf(layoutCase.path)}`, text: reworded },
      ]);
      expect([
        name,
        layoutHolding(
          judge(control, {
            path: layoutCase.path,
            base: layoutCase.base,
            head: reworded,
            read: {
              base: `control/base${suffixOf(layoutCase.path)}`,
              head: `control/head${suffixOf(layoutCase.path)}`,
            },
          }),
        ),
      ]).toEqual([name, ["comment-only"]]);
    }
  },
  120_000,
);

test.skipIf(graph.skip)(
  "a byte-order mark added at the file's start, or removed, reads as a change",
  async () => {
    // Why: the mark lies outside every leaf and every gap the client's accessors give, so equal
    // leaves and equal accessor gaps would call it layout; a tool can read it (a shebang after it
    // stops working). The rule's own stretch from the file's first byte sees it.
    graph.require();
    const batch = await layoutRead();
    for (const [index, change] of BOM_CHANGES.entries()) {
      const read = {
        base: `bom/${index}/base.ts`,
        head: `bom/${index}/head.ts`,
      };
      expect(layoutHolding(judge(batch, { ...change, read }))).toEqual([]);
    }
  },
  120_000,
);

test.skipIf(graph.skip)(
  "the rule's own stretches agree with graphGapBefore and graphGapAfterLast wherever both answer, and differ only by a byte-order mark",
  async () => {
    // Why: the rule computes each stretch from the bytes itself, so it sees a left-out comment's
    // bytes and a byte-order mark; where a stretch holds no comment the client's accessors answer
    // too, and the two must give the same bytes, kind and plainness, or one of them is wrong.
    graph.require();
    const batch = await layoutRead();
    let compared = 0;
    let marks = 0;
    for (const { path, text } of layoutTexts()) {
      const tokens = tokensAt(batch, path);
      if (tokens.status !== "available") continue;
      const bytes = encoder.encode(text);
      const mark = text.startsWith(BOM);
      for (const stretch of comparedStretches(
        tokens,
        bytes,
        tokens.directivesFlagged,
      )) {
        if (stretch.comments > 0) continue;
        const gap =
          stretch.right === -1
            ? graphGapAfterLast(tokens, bytes)
            : graphGapBefore(tokens, bytes, stretch.right);
        const own = {
          kind: stretch.kind,
          plain: stretch.plain,
          startByte: stretch.startByte,
          endByte: stretch.endByte,
        };
        const theirs = {
          kind: gap.kind,
          plain: gap.plain,
          startByte: gap.startByte,
          endByte: gap.endByte,
        };
        if (mark && stretch.left === -1) {
          // The mark's three bytes are the rule's and no accessor's.
          expect(own.startByte).toBe(0);
          expect(theirs.startByte).toBe(3);
          expect(own.plain).toBe(false);
          marks++;
        } else expect([path, own]).toEqual([path, theirs]);
        compared++;
      }
    }
    expect(marks).toBe(2);
    expect(compared).toBeGreaterThan(300);
  },
  120_000,
);

// --- imports-only on real tokens -----------------------------------------------------------------

/** Relations answering every added import with `answer`, as a slice-less round would. */
const relationsAnswering = (
  answer: ReturnType<SectionRelations["importTarget"]>,
  manifestIsNearest: SectionRelations["manifestIsNearest"] = () => true,
): SectionRelations => ({
  importTarget: () => answer,
  slice: () => undefined,
  manifestIsNearest,
});
const FILE_ANSWER = relationsAnswering({ kind: "file", path: "src/x.ts" });

const IMPORT_CHANGES = {
  typescript: {
    path: "src/a.ts",
    base: 'import { a } from "./a";\n\nexport const x = a;\n',
    head: 'import { a } from "./a";\nimport { b } from "./b";\n\nexport const x = a;\n',
  },
  python: {
    path: "src/a.py",
    base: "import a\n\nx = a.f()\n",
    head: "import a, b\n\nx = a.f()\n",
  },
  codeOnLine: {
    path: "src/a.ts",
    base: 'import { a } from "./a";\n\nexport const x = a;\n',
    head: 'import { a } from "./a"; f();\n\nexport const x = a;\n',
  },
  directiveOnLine: {
    path: "src/a.ts",
    base: 'import { a } from "./a";\nimport { b } from "./b";\n\nexport const x = a + b;\n',
    head: 'import { a } from "./a";\nimport { b } from "./b"; // eslint-disable-line no-unused-vars\n\nexport const x = a + b;\n',
  },
  proseOnLine: {
    path: "src/a.ts",
    base: 'import { a } from "./a";\nimport { b } from "./b";\n\nexport const x = a + b;\n',
    head: 'import { a } from "./a";\nimport { b } from "./b"; // the second of the two modules\n\nexport const x = a + b;\n',
  },
  manifest: {
    path: "packages/p/src/x.ts",
    base: 'import { a } from "./a";\n\nexport const x = a;\n',
    head: 'import { a } from "./a";\nimport pad from "left-pad";\n\nexport const x = a;\n',
  },
  goGrouped: {
    path: "a/a.go",
    base: 'package a\n\nimport (\n\t"fmt"\n)\n\nfunc F() { fmt.Println() }\n',
    head: 'package a\n\nimport (\n\t"fmt"\n\t"os"\n)\n\nfunc F() { fmt.Println() }\n',
  },
  goGroupedAlias: {
    path: "a/a.go",
    base: 'package a\n\nimport (\n\t"fmt"\n)\n\nfunc F() { fmt.Println() }\n',
    head: 'package a\n\nimport (\n\t"fmt"\n\tx "os"\n)\n\nfunc F() { fmt.Println() }\n',
  },
  goPlain: {
    path: "a/a.go",
    base: 'package a\n\nimport "fmt"\n\nfunc F() { fmt.Println() }\n',
    head: 'package a\n\nimport "fmt"\nimport "strings"\n\nfunc F() { fmt.Println() }\n',
  },
  goCodeAfter: {
    path: "a/a.go",
    base: 'package a\n\nimport "fmt"\n\nfunc F() { fmt.Println() }\n',
    head: 'package a\n\nimport "fmt"\nimport "strings"; var _ = strings.ToUpper\n\nfunc F() { fmt.Println() }\n',
  },
  tsRequire: {
    path: "src/a.ts",
    base: 'import { a } from "./a";\n\nexport const v = a;\n',
    head: 'import { a } from "./a";\nimport x = require("./x");\n\nexport const v = a;\n',
  },
  pyDotted: {
    path: "src/a.py",
    base: "import os\n\nv = os.sep\n",
    head: "import os\nimport a.b.c\n\nv = os.sep\n",
  },
  pySpaced: {
    path: "src/a.py",
    base: "import sys\n\nv = sys.argv\n",
    head: "import sys\nimport os . path\n\nv = sys.argv\n",
  },
  nameInString: {
    path: "src/a.ts",
    base: 'import { helper } from "./h";\n\nexport const s = "helper";\n',
    head: '\nexport const s = "helper";\n',
  },
} as const;

let importBatch: Promise<OutlineBatch> | undefined;
const importRead = () =>
  (importBatch ??= readTokens(
    Object.entries(IMPORT_CHANGES).flatMap(([name, change]) => [
      {
        path: `imports/${name}/base${suffixOf(change.path)}`,
        text: change.base,
      },
      {
        path: `imports/${name}/head${suffixOf(change.path)}`,
        text: change.head,
      },
    ]),
  ));
const importsOf = async (
  name: keyof typeof IMPORT_CHANGES,
  /** Null: no relations given. */
  relations: SectionRelations | null = FILE_ANSWER,
) => {
  const change = IMPORT_CHANGES[name];
  return outcomes(
    judge(
      await importRead(),
      {
        ...change,
        read: {
          base: `imports/${name}/base${suffixOf(change.path)}`,
          head: `imports/${name}/head${suffixOf(change.path)}`,
        },
      },
      relations ?? undefined,
    ),
    "imports-only",
  );
};

test.skipIf(graph.skip)(
  "imports-only on real tokens: an added TypeScript import and a module added to Python's `import a, b` hold; code on the import's line is no import section",
  async () => {
    // Why: real statement ranges decide where an import ends. TypeScript's range stops before code
    // on its line, so `f();` there is a token outside every import and the rule does not apply;
    // Python gives `import a, b` one statement per module over the same bytes.
    graph.require();
    expect(await importsOf("typescript")).toEqual([["holds", null]]);
    expect(await importsOf("python")).toEqual([["holds", null]]);
    expect(await importsOf("codeOnLine")).toEqual([]);
  },
  120_000,
);

test.skipIf(graph.skip)(
  "imports-only on real tokens: a directive added on an import's line is not held; a prose comment there is allowed",
  async () => {
    // Why: a directive (`eslint-disable-line`) is a comment a tool obeys, flagged by the engine;
    // a comment of several words is prose and changes no import.
    graph.require();
    expect(await importsOf("directiveOnLine")).toEqual([
      ["not-held", "directive-comment-changed"],
    ]);
    expect(await importsOf("proseOnLine")).toEqual([["holds", null]]);
  },
  120_000,
);

test.skipIf(graph.skip)(
  "imports-only on real tokens: a package declared only in a manifest that is not the importer's nearest is not held; from the nearest it holds",
  async () => {
    // Why: a package the importer's own manifest does not declare may not be installed where it
    // runs. The head tree here has a manifest nearer to the importer than the root one.
    graph.require();
    const paths = new Set([
      "package.json",
      "packages/p/package.json",
      "packages/p/src/x.ts",
    ]);
    const declaredIn = (manifest: string) =>
      relationsAnswering(
        { kind: "declared-package", name: "left-pad", manifest },
        nearestManifest(paths),
      );
    expect(await importsOf("manifest", declaredIn("package.json"))).toEqual([
      ["not-held", "package-not-nearest"],
    ]);
    expect(
      await importsOf("manifest", declaredIn("packages/p/package.json")),
    ).toEqual([["holds", null]]);
  },
  120_000,
);

test.skipIf(graph.skip)(
  "imports-only on real tokens: a removed import whose name is still written in a string is not held",
  async () => {
    // Why: Graph's identifier names leave out strings, and a string can name what it loads
    // (`require("helper")`, a lookup by name); the text search outside identifiers finds it.
    graph.require();
    expect(await importsOf("nameInString")).toEqual([
      ["not-held", "removed-name-in-text"],
    ]);
  },
  120_000,
);

test.skipIf(graph.skip)(
  'imports-only on real tokens: a Go import added to a grouped import, and a plain `import "x"` line added, reach a judgement; code after a Go import on its line still gets none',
  async () => {
    // Why: Go's statement-ending line feeds are leaves of whitespace only that lie outside every
    // import statement; as tokens they kept every Go import change from a judgement. They hold no
    // code, so they are layout here. Without relations: an unaliased Go import's local name is the
    // engine's guess from the path (\`localInferred\`), so it is not held (names-unknown); an
    // aliased one names its local, and where it leads is not read (relations-not-read); with
    // relations answering a file, it holds. Code after the import on its line is still a token
    // outside every import.
    graph.require();
    expect(await importsOf("goGrouped", null)).toEqual([
      ["not-held", "names-unknown"],
    ]);
    expect(await importsOf("goPlain", null)).toEqual([
      ["not-held", "names-unknown"],
    ]);
    expect(await importsOf("goGroupedAlias", null)).toEqual([
      ["not-evaluated", "relations-not-read"],
    ]);
    expect(await importsOf("goGroupedAlias")).toEqual([["holds", null]]);
    expect(await importsOf("goCodeAfter", null)).toEqual([]);
  },
  120_000,
);

test.skipIf(graph.skip)(
  "imports-only on real tokens: ordinary TypeScript, Python and Go bindings fit their files, `import x = require(...)` and Python's `import a.b.c` included; a binding Graph cuts from raw text is not evaluated",
  async () => {
    // Why: the rule now refuses a binding whose names hold whitespace or whose spelled local name
    // is no identifier of its file; the engine's ordinary records must pass that check, or the
    // rule would stop deciding real imports. Python's \`import os . path\` is the engine's known
    // defect: while its binding's local holds a space, the rule must not decide it.
    graph.require();
    for (const name of [
      "typescript",
      "tsRequire",
      "python",
      "pyDotted",
    ] as const)
      expect([name, await importsOf(name)]).toEqual([name, [["holds", null]]]);
    expect(await importsOf("goGroupedAlias")).toEqual([["holds", null]]);
    const spaced = tokensAt(await importRead(), "imports/pySpaced/head.py");
    const binding =
      spaced.status === "available" && spaced.imports.status === "extracted"
        ? spaced.imports.statements.find(
            (statement) => statement.specifier.replace(/\s/g, "") === "os.path",
          )?.bindings[0]
        : undefined;
    expect(binding).toBeDefined();
    expect(await importsOf("pySpaced")).toEqual(
      /\s/u.test(binding!.local) || /\s/u.test(binding!.imported)
        ? [["not-evaluated", "binding-not-in-file"]]
        : [["holds", null]],
    );
  },
  120_000,
);

test("the nearest manifest is told from the tree's paths: the importer's own folder first, then each folder above it", () => {
  // Why: a nearer manifest of the same name means the one named is not the importer's.
  const nearest = nearestManifest(
    new Set(["package.json", "packages/p/package.json", "tools/go.mod"]),
  );
  expect(nearest("packages/p/src/x.ts", "packages/p/package.json")).toBe(true);
  expect(nearest("packages/p/src/x.ts", "package.json")).toBe(false);
  expect(nearest("src/a.ts", "package.json")).toBe(true);
  expect(nearest("a.ts", "package.json")).toBe(true);
  // A manifest whose folder is no ancestor of the importer is no manifest of it.
  expect(nearest("src/a.ts", "packages/p/package.json")).toBe(false);
  expect(nearest("tools/x/main.go", "tools/go.mod")).toBe(true);
});

// --- The outline read without the option -------------------------------------------------------

test.skipIf(graph.skip)(
  "the outline read without the option is as before: its key is the old key and its observation has no tokens",
  async () => {
    // Why: every stored outline publication and structure was keyed and read without tokens; a
    // read without the option must find them and give the same observation.
    graph.require();
    const files = [
      { path: "a.ts", bytes: encoder.encode("export const a = 1;\n") },
    ];
    const inputs = files.map((file) => [
      file.path,
      createHash("sha256").update(file.bytes).digest("hex"),
    ]);
    // The key's formula before the option existed, written out.
    const before = createHash("sha256")
      .update(
        JSON.stringify({
          recipe: "graph-outline@3",
          source: source.key,
          binding: GRAPH_SOURCE_BINDING,
          files: inputs,
        }),
      )
      .digest("hex");
    expect(outlineReadKey(files, source).key).toBe(before);
    expect(outlineReadKey(files, source, { tokens: false }).key).toBe(before);
    expect(outlineReadKey(files, source, { tokens: true }).key).not.toBe(
      before,
    );

    const plain = await readOutlines(files, source);
    const context = plain.context("a.ts");
    expect(context.kind).toBe("available");
    expect(
      context.kind === "available" &&
        context.observation !== undefined &&
        "tokens" in context.observation,
    ).toBe(false);
    expect(plain.tokensUnsupported).toBe(false);
  },
  120_000,
);

test.skipIf(graph.skip || !olderEngine)(
  "an engine without tokens reads the outline without the option as before; with the option it is unsupported, stably",
  async () => {
    // Why: that engine refuses the option before it runs, so reading with it unchanged shows the
    // option is not passed without it; refusing again on a second read shows the outcome is kept
    // as stable, not as an outage.
    graph.require();
    const files = [
      { path: "a.ts", bytes: encoder.encode("export const a = 1;\n") },
    ];
    const older = sourceOf(OLDER_ENGINE);
    const withoutOption = await readOutlines(files, older);
    expect(withoutOption.context("a.ts").kind).toBe("available");
    expect(withoutOption.tokensUnsupported).toBe(false);
    for (let round = 0; round < 2; round++) {
      const withOption = await readOutlines(
        files,
        older,
        undefined,
        (run) => run(1),
        false,
        undefined,
        { tokens: true },
      );
      expect(withOption.tokensUnsupported).toBe(true);
      expect(withOption.context("a.ts").kind).toBe("unavailable");
    }
  },
  120_000,
);

// --- Stored: the key, a retryable read, an engine without tokens, relations ---------------------

const repository = join(root, "repo");
const git = (...args: Array<string>) => {
  const done = Bun.spawnSync(
    [
      "git",
      "-C",
      repository,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.test",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    },
  );
  if (done.exitCode !== 0) throw new Error(done.stderr.toString());
  return done.stdout.toString().trim();
};
const write = (files: Readonly<Record<string, string>>) => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(repository, path, ".."), { recursive: true });
    writeFileSync(join(repository, path), text);
  }
};

const BASE_FILES = {
  "src/paths.ts":
    'export function home(): string {\n  return "/home";\n}\n\nexport function gone(): string {\n  return "/gone";\n}\n',
  "src/use.ts":
    'import { home, gone } from "./paths";\n\nexport function where() {\n  return home() + gone();\n}\n',
  "src/a.ts":
    'import { home } from "./paths";\n\nexport function f() {\nreturn home();\n}\n',
  "src/c.ts": "export const c = 1;\n",
} as const;
const HEAD_FILES = {
  // `gone` removed; its caller in src/use.ts is left unchanged.
  "src/paths.ts": 'export function home(): string {\n  return "/home";\n}\n',
  // An import added, and a body reindented.
  "src/a.ts":
    'import { home } from "./paths";\nimport { c } from "./c";\n\nexport function f() {\n    return home();\n}\n',
} as const;

mkdirSync(repository, { recursive: true });
git("init", "-q");
write(BASE_FILES);
git("add", "-A");
git("commit", "-qm", "base");
const baseCommit = git("rev-parse", "HEAD");
write(HEAD_FILES);
git("add", "-A");
git("commit", "-qm", "head");
const headCommit = git("rev-parse", "HEAD");
const blobOf = (text: string) =>
  Bun.spawnSync(["git", "-C", repository, "hash-object", "--stdin"], {
    stdin: encoder.encode(text),
  })
    .stdout.toString()
    .trim();
const HUNKS: ReadonlyArray<ManifestHunk> = Object.entries(HEAD_FILES).flatMap(
  ([path, after]) => {
    const before = BASE_FILES[path as keyof typeof BASE_FILES];
    return diff(path, before, after).map((hunk) => ({
      ...hunk,
      oldOid: blobOf(before),
      newOid: blobOf(after),
    }));
  },
);

const runtimeOf = (name: string) => {
  const location = storeLocationIn(join(root, "stores", name));
  return Computations.layer.pipe(
    Layer.provideMerge(Blobs.layer(location)),
    Layer.provideMerge(
      Layer.effectDiscard(Store.prepareForWrite).pipe(
        Layer.provideMerge(Store.layer(location, { create: true })),
      ),
    ),
    Layer.provideMerge(BunFileSystem.layer),
  );
};
const inStore = <A, E>(
  name: string,
  effect: Effect.Effect<A, E, Computations.ComputationStore | Blobs.BlobStore>,
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provideService(CpuWork, {
        budget: new Scheduler(1),
        priority: { class: "interactive", position: "understand", stage: 0 },
        inherited: true,
      }),
      Effect.provideService(CodeWork, undefined),
      Effect.provide(runtimeOf(name)),
    ),
  );
const storedRules = (
  name: string,
  options: SectionRulesOptions = {},
  outline: OutlineSource = source,
) =>
  inStore(
    name,
    storedSectionRules(repository, headCommit, HUNKS, outline, options),
  );

/** The judgements of one rule by the path and first owned line of their section. */
const byPlace = (
  stored: Awaited<ReturnType<typeof storedRules>>,
  rule: SectionRuleJudgement["rule"],
) => {
  const placeOf = new Map(
    stored.sections.map((section) => [
      stored.identities.get(section.key)!.key,
      `${section.path}:${section.ranges[0]?.side}${section.ranges[0]?.startLine}`,
    ]),
  );
  return Object.fromEntries(
    stored.rules
      .filter((judgement) => judgement.rule === rule)
      .map((judgement) => [
        placeOf.get(judgement.about.key)!,
        [judgement.result, judgement.reason],
      ]),
  );
};

test.skipIf(graph.skip)(
  "stored: judgements read with tokens take another key than those without, are reused under it, and leave the key without tokens as it was",
  async () => {
    // Why: a judgement or a family read with tokens differs from one read without; sharing a key
    // would hand one caller the other's answer.
    graph.require();
    const without = await storedRules("key");
    const withTokens = await storedRules("key", { tokens: true });
    const again = await storedRules("key", { tokens: true });
    const withoutAgain = await storedRules("key");
    expect(without.rulesStatus).toBe("computed");
    expect(
      without.rules.filter((judgement) =>
        ["whitespace-only", "comment-only", "imports-only"].includes(
          judgement.rule,
        ),
      ),
    ).toEqual([]);
    expect(withTokens.rulesKey).not.toBe(without.rulesKey);
    expect(withTokens.rulesStatus).toBe("computed");
    expect(withTokens.rulesRetryable).toEqual([]);
    expect(withTokens.tokensRead?.counts).toMatchObject({
      asked: 4,
      sent: 4,
      available: 4,
      retryable: 0,
      graphReads: 2,
    });
    expect(byPlace(withTokens, "whitespace-only")).toEqual({
      "src/a.ts:old4": ["holds", null],
    });
    // No relations given: where the added import leads was not read.
    expect(byPlace(withTokens, "imports-only")).toEqual({
      "src/a.ts:new2": ["not-evaluated", "relations-not-read"],
    });
    expect(withTokens.families).toEqual([]);
    expect([again.rulesStatus, again.rulesKey, again.tokensRead]).toEqual([
      "reused",
      withTokens.rulesKey,
      null,
    ]);
    expect(again.rules).toEqual(withTokens.rules);
    expect([withoutAgain.rulesStatus, withoutAgain.rulesKey]).toEqual([
      "reused",
      without.rulesKey,
    ]);
  },
  180_000,
);

test.skipIf(graph.skip)(
  "stored: a retryable tokens read is never stored under the stable key; the next call reads Graph again",
  async () => {
    // Why: Graph unavailable is an outage, not the files' answer; judgements made without their
    // tokens under the stable key would be served for good. The structures are stored first, so
    // only the tokens read meets the outage. The outage: Graph's working folders (its shared
    // outline answers and its private engine copy, under the budget directory) cannot be made, as
    // a file stands where the folder would go; the temporary root, which the attribute read uses
    // too, is left alone.
    graph.require();
    await storedRules("retryable");
    const blocked = join(root, "budget-blocked");
    writeFileSync(blocked, "");
    const previous = process.env.NEUVE_BUDGET_DIRECTORY;
    let failed;
    try {
      process.env.NEUVE_BUDGET_DIRECTORY = join(blocked, "budget");
      failed = await storedRules("retryable", { tokens: true });
    } finally {
      if (previous === undefined) delete process.env.NEUVE_BUDGET_DIRECTORY;
      else process.env.NEUVE_BUDGET_DIRECTORY = previous;
    }
    expect(failed.rulesRetryable).toEqual(["graph-unavailable"]);
    // Round 9b: what is built from these judgements keys on the key they are stored under, which
    // names each blob that went without; the stable key holds none of them.
    expect(failed.rulesRunKey).not.toBe(failed.rulesKey);
    expect(failed.tokensRead?.counts).toMatchObject({
      available: 0,
      retryable: 4,
    });
    const layout = failed.rules.filter(
      (judgement) => judgement.rule === "whitespace-only",
    );
    expect(
      layout.map((judgement) => [judgement.result, judgement.reason]),
    ).toEqual(layout.map(() => ["not-evaluated", "tokens-not-read"]));
    expect(layout[0]?.inputs).toMatchObject({
      retryable: true,
      tokens: {
        old: {
          status: "not-read",
          reason: "graph-unavailable",
          retryable: true,
        },
      },
    });
    // The rules that need no tokens are as before.
    const plain = await storedRules("retryable");
    const without = (rules: ReadonlyArray<SectionRuleJudgement>) =>
      rules.filter(
        (judgement) =>
          !["whitespace-only", "comment-only", "imports-only"].includes(
            judgement.rule,
          ),
      );
    expect(without(failed.rules)).toEqual(without(plain.rules));
    const recovered = await storedRules("retryable", { tokens: true });
    expect(recovered.rulesStatus).toBe("computed");
    expect(recovered.rulesKey).toBe(failed.rulesKey);
    expect(recovered.rulesRetryable).toEqual([]);
    expect(recovered.rulesRunKey).toBe(recovered.rulesKey);
    expect(byPlace(recovered, "whitespace-only")).toEqual({
      "src/a.ts:old4": ["holds", null],
    });
  },
  180_000,
);

test.skipIf(graph.skip || !olderEngine)(
  "stored: an engine that does not declare tokens gives the stable unsupported outcome: the token rules are not evaluated with its reason, and the result is reused",
  async () => {
    // Why: the same engine refuses again, so this is no outage to retry; and a tokens read that
    // fails altogether must not fail the call or change the rules that need no tokens.
    graph.require();
    const older = sourceOf(OLDER_ENGINE);
    const first = await storedRules("unsupported", { tokens: true }, older);
    const second = await storedRules("unsupported", { tokens: true }, older);
    expect(first.rulesRetryable).toEqual([]);
    expect(first.tokensRead?.counts).toMatchObject({
      notRead: { "engine-unsupported": 4 },
      retryable: 0,
    });
    expect(byPlace(first, "whitespace-only")).toEqual({
      "src/a.ts:new2": ["not-evaluated", "tokens-not-read"],
      "src/a.ts:old4": ["not-evaluated", "tokens-not-read"],
      "src/paths.ts:old4": ["not-evaluated", "tokens-not-read"],
    });
    expect(byPlace(first, "imports-only")).toEqual({
      "src/a.ts:new2": ["not-evaluated", "tokens-not-read"],
      "src/a.ts:old4": ["not-evaluated", "tokens-not-read"],
      "src/paths.ts:old4": ["not-evaluated", "tokens-not-read"],
    });
    expect(
      first.rules.find((judgement) => judgement.rule === "whitespace-only")
        ?.inputs.tokens,
    ).toMatchObject({
      old: {
        status: "not-read",
        reason: "engine-unsupported",
        retryable: false,
      },
    });
    expect([second.rulesStatus, second.rules]).toEqual(["reused", first.rules]);
  },
  180_000,
);

const GAP_ROUND: RelationsRound = {
  base: { gap: "over-bound", tag: null },
  head: { gap: "over-bound", tag: null },
  outcomes: { base: "over-bound", head: "over-bound" },
};

test.skipIf(graph.skip)(
  "stored: relations given as a gap leave imports-only and deletion-only not evaluated, with the reason, under a key of their own",
  async () => {
    // Why: a side Graph did not read says nothing about where an import leads or who still calls a
    // removed function; and a later round that reads them must not find this answer.
    graph.require();
    const gap = await storedRules("gap", {
      tokens: true,
      relations: GAP_ROUND,
    });
    const none = await storedRules("gap", { tokens: true });
    expect(gap.rulesKey).not.toBe(none.rulesKey);
    expect(byPlace(gap, "imports-only")).toEqual({
      "src/a.ts:new2": ["not-evaluated", "import-side-not-read"],
    });
    expect(byPlace(gap, "deletion-only")).toEqual({
      "src/paths.ts:old4": ["not-evaluated", "relations-not-read"],
    });
    expect(
      gap.rules.find((judgement) => judgement.rule === "deletion-only")?.inputs,
    ).toEqual({ gap: { gap: "over-bound", tag: null } });
  },
  180_000,
);

test.skipIf(relationsGraph.skip)(
  "stored: relations read: a removed function with an unchanged caller shows it, and an added import of a file holds",
  async () => {
    // Why: deletion-only states what still pointed at a removed symbol at the base; the caller in
    // src/use.ts is unchanged by the range, so it is shown. The import added in src/a.ts leads to
    // src/c.ts, a file, so imports-only holds.
    relationsGraph.require();
    const round = await inStore(
      "relations",
      relationsRound({
        repository,
        graphDirectory: join(root, "stores", "relations", "graph"),
        base: baseCommit,
        head: headCommit,
        source,
        waitMs: 120_000,
      }),
    );
    expect(round.outcomes).toEqual({ base: "computed", head: "computed" });
    const stored = await storedRules("relations", {
      tokens: true,
      relations: round,
    });
    expect(byPlace(stored, "imports-only")).toEqual({
      "src/a.ts:new2": ["holds", null],
    });
    expect(byPlace(stored, "deletion-only")).toEqual({
      "src/paths.ts:old4": ["holds", null],
    });
    const deletion = stored.rules.find(
      (judgement) => judgement.rule === "deletion-only",
    )!;
    expect(deletion.inputs.removed).toEqual([
      {
        name: "gone",
        kind: "function",
        stillPointingOnBase: {
          evidence: "supported",
          total: 1,
          trusted: 1,
          // The site's line: the call's own (`return home() + gone();`) on an engine that declares
          // call lines for TypeScript, as this one does; the caller's first line (3) before.
          first: { path: "src/use.ts", line: 4 },
        },
      },
    ]);
    expect(deletion.statement).toContain(
      "1 still had callers at the base that this change did not touch",
    );

    // The rule versions are in what the stored key hashes, so a new deletion-only version takes a
    // new key and no judgement stored under the old one is served.
    const computation = await inStore(
      "relations",
      Effect.gen(function* () {
        const store = yield* Computations.ComputationStore;
        return yield* store.lookup(stored.rulesKey);
      }),
    );
    const material = JSON.parse(Option.getOrThrow(computation).material) as {
      op: string;
      opVersion: number;
      inputs: Computations.ComputationSpec["inputs"];
      config: { versions: Record<string, number> };
      route: null;
    };
    expect(material.route).toBeNull();
    expect(material.config.versions).toEqual({ ...SECTION_RULE_VERSIONS });
    const specWith = (versions: Record<string, number>) =>
      ({
        op: material.op,
        opVersion: material.opVersion,
        inputs: material.inputs,
        config: { ...material.config, versions },
      }) as Computations.ComputationSpec;
    expect(
      Computations.computationKey(specWith(material.config.versions)).key,
    ).toBe(stored.rulesKey);
    expect(
      Computations.computationKey(
        specWith({ ...material.config.versions, "deletion-only": 1 }),
      ).key,
    ).not.toBe(stored.rulesKey);

    // The same round under another index recipe, its calls dropped: another read, so another key,
    // computed afresh, and its own deletion-only inputs.
    // The base was read (its outcome is "computed" above), so it is an index with edges.
    const { edges } = round.base as unknown as {
      edges: Record<string, unknown>;
    };
    const otherRecipe = {
      ...round,
      base: {
        ...round.base,
        format: "neuve-graph-relations-v0",
        edges: Object.fromEntries(Object.keys(edges).map((key) => [key, []])),
      },
    } as unknown as RelationsRound;
    const other = await storedRules("relations", {
      tokens: true,
      relations: otherRecipe,
    });
    expect(other.rulesKey).not.toBe(stored.rulesKey);
    expect(other.rulesStatus).toBe("computed");
    expect(
      other.rules.find((judgement) => judgement.rule === "deletion-only")!
        .inputs.removed,
    ).toEqual([
      {
        name: "gone",
        kind: "function",
        stillPointingOnBase: { evidence: "none" },
      },
    ]);
  },
  240_000,
);

// --- `unsupported` with a stand-in engine ------------------------------------------------------

/**
 * A stand-in engine that declares outlines and no tokens, as the client's tests build one: its
 * symbols read gives no file record, so every structure is a stable `outline-unavailable`.
 */
const STAND_IN = join(root, "stand-in-engine");
writeFileSync(
  STAND_IN,
  `#!${process.execPath}
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
const args = process.argv.slice(2), repo = args[args.indexOf("--repo") + 1];
const emit = (row) => console.log(JSON.stringify(row));
if (args[0] === "version") emit({version:"fixture",provider:"entire-graph",identity_revision:"4",build_identity:createHash("sha256").update(readFileSync(import.meta.path)).digest("hex")});
else if (args[0] === "capabilities") emit({schema_version:"1.3",provider:"entire-graph",supported_file_extensions:[".ts"],supported_languages:["TypeScript"],semantic_languages:["TypeScript"],inventory_only_languages:[],supported_relation_types:["DEFINES"],relation_support_by_language:{},relation_support_by_profile:{"syntax-only":["DEFINES"]},heuristic_relation_types:[],parser_versions:{},unsupported_but_detected_language_hints:[],optional_local_only_features:{symbols_outline:true},features_requiring_network_access:{}});
else {
  emit({schema_version:"1.3",provider:"entire-graph",provider_version:"fixture",identity_revision:"4",repo_root:repo,profile:"syntax-only"});
  emit({record_type:"summary",partial_failures:[]});
}
`,
);
chmodSync(STAND_IN, 0o700);

test("with an engine that declares no tokens (a stand-in), the read with tokens is the stable unsupported outcome and the stored judgements are not evaluated with its reason, under the stable key", async () => {
  // Why: once the submodule's engine declares tokens, no real engine without them is at hand; the
  // stand-in makes \`readGraphSymbols\` reject with reason \`unsupported\`, as such an engine does.
  // That outcome is the engine's answer, not an outage, so it must be kept under the stable key.
  const standIn = sourceOf(STAND_IN);
  const files = [
    { path: "a.ts", bytes: encoder.encode("export const a = 1;\n") },
  ];
  for (let round = 0; round < 2; round++) {
    const read = await readOutlines(
      files,
      standIn,
      undefined,
      (run) => run(1),
      false,
      undefined,
      { tokens: true },
    );
    expect(read.tokensUnsupported).toBe(true);
    expect(read.context("a.ts").kind).toBe("unavailable");
  }
  const plain = await readOutlines(files, standIn);
  expect([plain.tokensUnsupported, plain.context("a.ts").kind]).toEqual([
    false,
    "available",
  ]);

  const first = await storedRules("stand-in", { tokens: true }, standIn);
  const second = await storedRules("stand-in", { tokens: true }, standIn);
  expect(first.rulesRetryable).toEqual([]);
  expect(first.rulesStatus).toBe("computed");
  expect(first.tokensRead?.counts).toMatchObject({
    notRead: { "engine-unsupported": 4 },
    retryable: 0,
  });
  const layout = first.rules.filter(
    (judgement) => judgement.rule === "whitespace-only",
  );
  expect(layout.length).toBeGreaterThan(0);
  expect(
    layout.map((judgement) => [judgement.result, judgement.reason]),
  ).toEqual(layout.map(() => ["not-evaluated", "tokens-not-read"]));
  expect(layout[0]!.inputs.tokens).toMatchObject({
    old: { status: "not-read", reason: "engine-unsupported", retryable: false },
  });
  expect(
    first.rules
      .filter((judgement) => judgement.rule === "imports-only")
      .map((judgement) => [judgement.result, judgement.reason]),
  ).toEqual(
    first.rules
      .filter((judgement) => judgement.rule === "imports-only")
      .map(() => ["not-evaluated", "tokens-not-read"]),
  );
  // Reused under the stable key: the outcome was stored, not kept off it as an outage.
  expect([second.rulesStatus, second.rulesKey, second.rules]).toEqual([
    "reused",
    first.rulesKey,
    first.rules,
  ]);
}, 120_000);
