import { expect, test } from "bun:test";
import type {
  GraphImportTarget,
  GraphSnapshotCoverage,
  SourcePath,
} from "@neuve/graph-client";
import {
  RelationsIndex,
  RelationsIndexBuilder,
  importTarget,
  type RelationsIndex as Index,
} from "../src/relations.ts";

/*
 * `importTarget` on small hand-built indexes, through the builder that stores the imports. The real
 * engine's targets are read in relations-real.test.ts.
 */

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
  relationSet: ["IMPORTS"],
  skippedRelationFamilies: [],
  languageTiers: { TypeScript: "semantic", Python: "semantic" },
  counts: { files: 0, parsedFiles: 0, symbols: 0, relations: 0, externals: 0 },
  partialFailures: [],
  warnings: [],
  gitlinksNotRead: [{ path: "vendor/lib", commit: null }],
  goBuildExcluded: [],
  health: "ok",
  completenessLevel: "ok",
  importTargets: {
    status: "classified",
    languages: ["Go", "JavaScript", "Python", "TypeScript"],
  },
  ...over,
});

const path = (value: string) => value as SourcePath;

/** One IMPORTS relation per specifier, each carrying its target as graph-client gives it. */
const build = (
  imports: readonly (readonly [
    from: string,
    specifier: string,
    target: GraphImportTarget,
  ])[],
  over: Partial<GraphSnapshotCoverage> = {},
): Promise<Index> => {
  const builder = new RelationsIndexBuilder();
  for (const [file, language] of [
    ["src/a.ts", "TypeScript"],
    ["src/b.ts", "TypeScript"],
    ["src/broken.ts", "TypeScript"],
    ["pkg/mod.py", "Python"],
  ] as const)
    builder.file({ id: `file:${file}`, path: file, language, bytes: 1 });
  for (const [from, specifier, target] of imports)
    builder.relation({
      relation: "IMPORTS",
      fromId: `file:${from}`,
      toId: target.kind === "file" ? `file:${target.path}` : `x:${specifier}`,
      targetKind: target.kind === "file" ? "file" : "external",
      resolution: "import_resolved",
      confidence: 0.9,
      scope: "module",
      evidence: [
        {
          kind: "import_statement",
          location: { kind: "path", path: path(from) },
          detail: specifier,
        },
        {
          kind: `import_target_${target.kind.replace("-", "_")}`,
          location: { kind: "absent" },
          detail: specifier,
          importTarget: { specifier, target },
        },
      ],
      warningCodes: [],
      evidenceDropped: 0,
    });
  return builder.finish(coverage(over));
};

const FIVE = [
  ["src/a.ts", "./b", { kind: "file", path: path("src/b.ts") }],
  [
    "src/a.ts",
    "@scope/pkg/deep",
    {
      kind: "declared-package",
      name: "@scope/pkg",
      manifest: path("package.json"),
    },
  ],
  ["src/a.ts", "node:fs", { kind: "builtin" }],
  ["src/a.ts", "./gone", { kind: "unresolved" }],
  ["pkg/mod.py", "yaml", { kind: "not-classified" }],
  ["src/broken.ts", "./b", { kind: "file", path: path("src/b.ts") }],
] as const;

// Why: each answer means something different to the imports-only rule; "unresolved" must be
// only Graph's own answer, and every reason there is no answer must be told apart from it.
test("importTarget gives each of Graph's five answers and every reason for none", async () => {
  const index = await build(FIVE, {
    partialFailures: [{ path: "src/broken.ts", codes: ["E_PARSE_ERROR"] }],
  });
  // The stored form round-trips through its schema.
  expect(RelationsIndex.parse(JSON.parse(JSON.stringify(index)))).toEqual(
    index,
  );
  expect(importTarget(index, "src/a.ts", "./b")).toEqual({
    kind: "file",
    path: "src/b.ts",
  });
  expect(importTarget(index, "src/a.ts", "@scope/pkg/deep")).toEqual({
    kind: "declared-package",
    name: "@scope/pkg",
    manifest: "package.json",
  });
  expect(importTarget(index, "src/a.ts", "node:fs")).toEqual({
    kind: "builtin",
  });
  expect(importTarget(index, "src/a.ts", "./gone")).toEqual({
    kind: "unresolved",
  });
  expect(importTarget(index, "pkg/mod.py", "yaml")).toEqual({
    kind: "not-classified",
  });
  // A file that was read and has no such import: a mismatch, never "unresolved".
  expect(importTarget(index, "src/b.ts", "./a")).toEqual({ kind: "not-found" });
  expect(importTarget(index, "src/a.ts", "./B")).toEqual({ kind: "not-found" });
  // Files the snapshot did not read, or read with a failure, as a slice's path coverage says.
  expect(importTarget(index, "src/new.ts", "./b")).toEqual({
    kind: "file-not-read",
    reason: "no-file-record",
    failures: [],
  });
  expect(importTarget(index, "vendor/lib/x.ts", "./b")).toEqual({
    kind: "file-not-read",
    reason: "under-gitlink",
    failures: [],
  });
  expect(importTarget(index, "src/broken.ts", "./b")).toEqual({
    kind: "file-not-read",
    reason: "partial-failure",
    failures: ["E_PARSE_ERROR"],
  });
  // A side that is a gap.
  expect(
    importTarget({ gap: "over-bound", tag: null }, "src/a.ts", "./b"),
  ).toEqual({ kind: "side-not-read", gap: { gap: "over-bound", tag: null } });
});

// Why: an engine that does not classify must never read as one that found nothing.
test("an index from an engine that does not classify answers classification-unavailable", async () => {
  for (const importTargets of [{ status: "not-declared" } as const, undefined])
    expect(
      importTarget(await build([], { importTargets }), "src/a.ts", "./b"),
    ).toEqual({ kind: "classification-unavailable" });
});

// Why: a specifier Graph classified twice for one file (two statements) is one fact.
test("a repeated specifier of one file keeps its first answer", async () => {
  const index = await build([
    ["src/a.ts", "./b", { kind: "file", path: path("src/b.ts") }],
    ["src/a.ts", "./b", { kind: "unresolved" }],
  ]);
  expect(index.imports.path).toHaveLength(1);
  expect(importTarget(index, "src/a.ts", "./b").kind).toBe("file");
});

// Why: a Python `from . import x` statement's specifier is `.` in the tokens record. The engine
// classifies `.` itself (the package's `__init__.py`, or unresolved) on the relation of the first
// imported name, beside `.x`, with its own kind; the index keeps both specifiers of that relation.
test("a Python relative from-import answers for `.` and for its module, from one relation", async () => {
  const relative = async (dot: GraphImportTarget) => {
    const builder = new RelationsIndexBuilder();
    builder.file({
      id: "file:pkg/mod.py",
      path: "pkg/mod.py",
      language: "Python",
      bytes: 1,
    });
    builder.relation({
      relation: "IMPORTS",
      fromId: "file:pkg/mod.py",
      toId: "file:pkg/x.py",
      targetKind: "file",
      resolution: "import_resolved",
      confidence: 0.9,
      scope: "module",
      evidence: [
        {
          kind: "import_target_file",
          location: { kind: "path", path: path("pkg/x.py") },
          detail: ".x",
          importTarget: {
            specifier: ".x",
            target: { kind: "file", path: path("pkg/x.py") },
          },
        },
        {
          kind: `import_target_${dot.kind}`,
          location: { kind: "absent" },
          detail: ".",
          importTarget: { specifier: ".", target: dot },
        },
      ],
      warningCodes: [],
      evidenceDropped: 0,
    });
    return builder.finish(coverage());
  };
  const package_ = await relative({
    kind: "file",
    path: path("pkg/__init__.py"),
  });
  expect(package_.imports.path).toHaveLength(2);
  expect(importTarget(package_, "pkg/mod.py", ".")).toEqual({
    kind: "file",
    path: "pkg/__init__.py",
  });
  expect(importTarget(package_, "pkg/mod.py", ".x")).toEqual({
    kind: "file",
    path: "pkg/x.py",
  });
  expect(
    importTarget(await relative({ kind: "unresolved" }), "pkg/mod.py", "."),
  ).toEqual({ kind: "unresolved" });
  // `..` was never imported here: a mismatch, not unresolved.
  expect(importTarget(package_, "pkg/mod.py", "..")).toEqual({
    kind: "not-found",
  });
});
