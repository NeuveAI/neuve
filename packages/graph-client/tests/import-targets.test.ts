import { expect, test } from "bun:test";
import type { GraphProviderObservation } from "../src/domain.ts";
import type { GraphSnapshotRelation } from "../src/index.ts";
import { CompactSnapshotDecoder } from "../src/snapshot.ts";

/*
 * Import target entries through the compact decoder alone, one stream per case. The real engine's
 * entries are read end to end in the harness's relations-real test.
 */

const provider: GraphProviderObservation = {
  name: "entire-graph",
  version: "fixture",
  identityRevision: "4",
  executable: { sha256: "e".repeat(64), buildIdentity: "verified" },
  capabilities: {
    schemaVersion: "1.3",
    supportedFileExtensions: [".ts"],
    supportedLanguages: ["TypeScript"],
    semanticLanguages: ["TypeScript"],
    inventoryOnlyLanguages: [],
    supportedRelationTypes: ["IMPORTS"],
    relationSelectionModes: [],
    relationFamilies: {},
    relationSupportByLanguage: {},
    relationSupportByProfile: {},
    heuristicRelationTypes: [],
    parserVersions: {},
    unsupportedButDetectedLanguageHints: [],
    optionalLocalOnlyFeatures: {},
    featuresRequiringNetworkAccess: {},
  },
};
const COMMIT = "1".repeat(40);

// Dictionary: 1 file id, 2 its path, 3 language, 4 IMPORTS, 5 statement kind, 6.. targets.
const DICTIONARY = [
  "local/r:file:src/a.ts",
  "src/a.ts",
  "TypeScript",
  "IMPORTS",
  "import_statement",
  "external:import:x",
  "import_target_file",
  "import_target_declared_package",
  "import_target_builtin",
  "import_target_unresolved",
  "import_target_not_classified",
  "package.json",
  "go.mod",
  "pyproject.toml",
  "@scope/pkg/deep",
  "lodash/get",
  "github.com/a/b/c",
  "yaml.loader",
  "node:fs",
  "./gone",
  "CALLS",
  "src/b.ts",
  ".",
  ".x",
  "pkg/__init__.py",
  "Python",
  "..",
  "..sub",
  "pkg/sub/__init__.py",
];
const at = (text: string) => DICTIONARY.indexOf(text) + 1;

const decode = (
  evidence: readonly (readonly unknown[])[],
  options: Readonly<{
    relation?: string;
    languages?: string[] | null;
    /** The importing file's language; TypeScript unless given. */
    language?: string;
  }> = {},
) => {
  const relations: GraphSnapshotRelation[] = [];
  const decoder = new CompactSnapshotDecoder(
    {
      provider,
      revision: COMMIT,
      profile: "full",
      repository: "/repo",
      importTargetLanguages:
        options.languages === undefined
          ? ["TypeScript", "Go", "Python"]
          : options.languages,
    },
    { symbol: () => {}, relation: (relation) => relations.push(relation) },
  );
  const rows: unknown[] = [
    [
      "h",
      1,
      {
        schema_version: "1.3",
        provider: "entire-graph",
        provider_version: "fixture",
        identity_revision: "4",
        repo_root: "/repo",
        repo_key: "local/r",
        commit: COMMIT,
        tree: "2".repeat(40),
        profile: "full",
        relation_set: ["IMPORTS"],
        skipped_relation_families: [],
      },
    ],
    ["d", 1, DICTIONARY],
    [
      "f",
      at("local/r:file:src/a.ts"),
      at("src/a.ts"),
      0,
      at(options.language ?? "TypeScript"),
      10,
    ],
    [
      "r",
      at("local/r:file:src/a.ts"),
      at("external:import:x"),
      at(options.relation ?? "IMPORTS"),
      0.8,
      0,
      0,
      0,
      0,
      evidence,
      [],
    ],
    ["x", at("external:import:x"), 0, 0, 0, 0, 0, 0, 0, true, 0, 0],
    [
      "m",
      {
        record_type: "summary",
        languages: ["TypeScript"],
        language_tiers: { TypeScript: "semantic" },
        warnings: [],
        partial_failures: [],
        stats: {
          files: 1,
          parsed_files: 1,
          symbols: 0,
          relations: 1,
          partial_failures: 0,
          completeness_level: "ok",
        },
        completeness: {},
      },
    ],
  ];
  for (const row of rows) decoder.line(JSON.stringify(row));
  return { relations, coverage: decoder.finish() };
};

const entry = (kind: string, path: string, specifier: string) => [
  at(kind),
  path === "" ? 0 : at(path),
  0,
  0,
  at(specifier),
];

// Why: the consumer asks where an import resolves; each kind must arrive with its specifier and
// path intact, and a declared package's name must be the one Graph's rule matched on.
test("each import target arrives with its specifier, path and kind, and a declared package with its name", () => {
  const read = (kind: string, path: string, specifier: string) =>
    decode([
      [at("import_statement"), at("src/a.ts"), 0, 0, at(specifier)],
      entry(kind, path, specifier),
    ]).relations[0]?.evidence[1];
  expect<unknown>(read("import_target_file", "src/b.ts", "./gone")).toEqual({
    kind: "import_target_file",
    location: { kind: "path", path: "src/b.ts" },
    detail: "./gone",
    importTarget: {
      specifier: "./gone",
      target: { kind: "file", path: "src/b.ts" },
    },
  });
  const declared = (manifest: string, specifier: string) =>
    read("import_target_declared_package", manifest, specifier)?.importTarget
      ?.target;
  expect<unknown>(declared("package.json", "@scope/pkg/deep")).toEqual({
    kind: "declared-package",
    name: "@scope/pkg",
    manifest: "package.json",
  });
  expect<unknown>(declared("package.json", "lodash/get")).toMatchObject({
    name: "lodash",
  });
  expect<unknown>(declared("pyproject.toml", "yaml.loader")).toMatchObject({
    name: "yaml",
  });
  // Go's rule is the required module that prefixes the path, which the stream does not carry.
  expect<unknown>(declared("go.mod", "github.com/a/b/c")).toMatchObject({
    name: null,
  });
  for (const [kind, target] of [
    ["import_target_builtin", "builtin"],
    ["import_target_unresolved", "unresolved"],
    ["import_target_not_classified", "not-classified"],
  ] as const)
    expect<unknown>(read(kind, "", "node:fs")).toEqual({
      kind,
      location: { kind: "absent" },
      detail: "node:fs",
      importTarget: { specifier: "node:fs", target: { kind: target } },
    });
  // Other evidence is as it was.
  expect<unknown>(
    decode([[at("import_statement"), at("src/a.ts"), 0, 0, at("node:fs")]])
      .relations[0]?.evidence,
  ).toEqual([
    {
      kind: "import_statement",
      location: { kind: "path", path: "src/a.ts" },
      detail: "node:fs",
    },
  ]);
});

// Why: a consumer must tell an engine that classifies from one that does not.
test("coverage says whether the engine classifies, and with which languages", () => {
  expect(decode([]).coverage.importTargets).toEqual({
    status: "classified",
    languages: ["TypeScript", "Go", "Python"],
  });
  expect(decode([], { languages: null }).coverage.importTargets).toEqual({
    status: "not-declared",
  });
});

// Why: Python's scanner reads `from . import x` as `.x`, so the engine adds an entry for `.` itself
// on the relation of the first imported name with a kind of its own. That is the one exception to
// one kind per relation, and only for a Python file; anywhere else a dot-only entry is ordinary.
// `from . import *` makes `.` a specifier with a relation of its own, which other specifiers reaching
// its file join, so one relation can carry several relative modules, but never one of them twice.
test("only a Python relation may carry relative-module entries of their own kind, each module once", () => {
  const read = (
    evidence: readonly (readonly unknown[])[],
    language = "Python",
  ) =>
    decode(evidence, { language }).relations[0]?.evidence.map(
      (item) => item.importTarget,
    );
  expect<unknown>(
    read([
      entry("import_target_file", "src/b.ts", ".x"),
      entry("import_target_unresolved", "", "."),
    ]),
  ).toEqual([
    { specifier: ".x", target: { kind: "file", path: "src/b.ts" } },
    { specifier: ".", target: { kind: "unresolved" } },
  ]);
  expect<unknown>(
    read([
      entry("import_target_unresolved", "", "./gone"),
      entry("import_target_file", "pkg/__init__.py", "."),
    ]),
  ).toEqual([
    { specifier: "./gone", target: { kind: "unresolved" } },
    { specifier: ".", target: { kind: "file", path: "pkg/__init__.py" } },
  ]);
  // A TypeScript `"."` sharing its relation's kind is an ordinary entry.
  expect<unknown>(
    read(
      [
        entry("import_target_file", "src/b.ts", "./gone"),
        entry("import_target_file", "src/b.ts", "."),
      ],
      "TypeScript",
    ),
  ).toEqual([
    { specifier: "./gone", target: { kind: "file", path: "src/b.ts" } },
    { specifier: ".", target: { kind: "file", path: "src/b.ts" } },
  ]);
  // `from . import *` and `from .. import sub` in `pkg/sub/mod.py`: `.` and `..sub` reach
  // `pkg/sub/__init__.py`, and `..` rides on `..sub`, so the relation carries two relative modules.
  expect<unknown>(
    read([
      entry("import_target_file", "pkg/sub/__init__.py", "..sub"),
      entry("import_target_file", "pkg/sub/__init__.py", "."),
      entry("import_target_file", "pkg/__init__.py", ".."),
    ]),
  ).toEqual([
    {
      specifier: "..sub",
      target: { kind: "file", path: "pkg/sub/__init__.py" },
    },
    { specifier: ".", target: { kind: "file", path: "pkg/sub/__init__.py" } },
    { specifier: "..", target: { kind: "file", path: "pkg/__init__.py" } },
  ]);
  // The same without `pkg/__init__.py`: the two relative modules differ in kind.
  expect<unknown>(
    read([
      entry("import_target_file", "pkg/sub/__init__.py", "..sub"),
      entry("import_target_file", "pkg/sub/__init__.py", "."),
      entry("import_target_unresolved", "", ".."),
    ]),
  ).toEqual([
    {
      specifier: "..sub",
      target: { kind: "file", path: "pkg/sub/__init__.py" },
    },
    { specifier: ".", target: { kind: "file", path: "pkg/sub/__init__.py" } },
    { specifier: "..", target: { kind: "unresolved" } },
  ]);
  const refused: [string, () => unknown][] = [
    [
      "TypeScript: a builtin beside an unresolved `.`",
      () =>
        read(
          [
            entry("import_target_builtin", "", "node:fs"),
            entry("import_target_unresolved", "", "."),
          ],
          "TypeScript",
        ),
    ],
    [
      "TypeScript: a declared package beside a file `.`",
      () =>
        read(
          [
            entry(
              "import_target_declared_package",
              "package.json",
              "@scope/pkg/deep",
            ),
            entry("import_target_file", "pkg/__init__.py", "."),
          ],
          "TypeScript",
        ),
    ],
    [
      "TypeScript: `.` twice with two kinds",
      () =>
        read(
          [
            entry("import_target_file", "src/b.ts", "."),
            entry("import_target_unresolved", "", "."),
          ],
          "TypeScript",
        ),
    ],
    [
      "TypeScript: `.` and `..` of two kinds",
      () =>
        read(
          [
            entry("import_target_file", "src/b.ts", "."),
            entry("import_target_unresolved", "", ".."),
          ],
          "TypeScript",
        ),
    ],
    [
      "Python: one relative module twice with one target",
      () =>
        read([
          entry("import_target_file", "src/b.ts", ".x"),
          entry("import_target_file", "pkg/__init__.py", "."),
          entry("import_target_file", "pkg/__init__.py", "."),
        ]),
    ],
    [
      "Python: one relative module twice with two kinds",
      () =>
        read([
          entry("import_target_file", "pkg/sub/__init__.py", "..sub"),
          entry("import_target_file", "pkg/__init__.py", ".."),
          entry("import_target_unresolved", "", "."),
          entry("import_target_unresolved", "", ".."),
        ]),
    ],
    [
      "Python: a relative module as a builtin",
      () =>
        read([
          entry("import_target_file", "src/b.ts", ".x"),
          entry("import_target_builtin", "", "."),
        ]),
    ],
    [
      "Python: a second relative module as not classified",
      () =>
        read([
          entry("import_target_file", "src/b.ts", ".x"),
          entry("import_target_unresolved", "", "."),
          entry("import_target_not_classified", "", ".."),
        ]),
    ],
  ];
  for (const [label, run] of refused)
    expect(run, label).toThrow(
      expect.objectContaining({ reason: "invalid-output" }),
    );
});

// Why: an entry that contradicts its relation or the engine's declaration is a malformed stream.
test("import targets that do not fit their relation or the declaration reject the stream", () => {
  const cases: [string, () => unknown][] = [
    [
      "outside an IMPORTS relation",
      () =>
        decode([entry("import_target_builtin", "", "node:fs")], {
          relation: "CALLS",
        }),
    ],
    [
      "from an engine that declares none",
      () =>
        decode([entry("import_target_builtin", "", "node:fs")], {
          languages: null,
        }),
    ],
    [
      "of two kinds on one relation",
      () =>
        decode([
          entry("import_target_builtin", "", "node:fs"),
          entry("import_target_unresolved", "", "./gone"),
        ]),
    ],
    [
      "a file target without its path",
      () => decode([entry("import_target_file", "", "./gone")]),
    ],
    [
      "a builtin with a path",
      () => decode([entry("import_target_builtin", "src/b.ts", "node:fs")]),
    ],
    [
      "a target with lines",
      () =>
        decode([
          [at("import_target_file"), at("src/b.ts"), 1, 1, at("./gone")],
        ]),
    ],
  ];
  for (const [label, run] of cases)
    expect(run, label).toThrow(
      expect.objectContaining({ reason: "invalid-output" }),
    );
});
