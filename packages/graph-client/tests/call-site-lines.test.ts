import { expect, test } from "bun:test";
import type { GraphProviderObservation } from "../src/domain.ts";
import type { GraphSnapshotRelation } from "../src/index.ts";
import { CompactSnapshotDecoder } from "../src/snapshot.ts";

/*
 * Call-site entries and their `form` (schema 1.4) through the compact decoder alone, one stream per
 * case, as import-targets.test.ts reads import targets. The real engine's entries are read end to
 * end in snapshot.test.ts and the harness's relations fixture.
 */

const COMMIT = "1".repeat(40);

const providerAt = (schemaVersion: string): GraphProviderObservation => ({
  name: "entire-graph",
  version: "fixture",
  identityRevision: "7",
  executable: { sha256: "e".repeat(64), buildIdentity: "verified" },
  capabilities: {
    schemaVersion,
    supportedFileExtensions: [".ts"],
    supportedLanguages: ["TypeScript"],
    semanticLanguages: ["TypeScript"],
    inventoryOnlyLanguages: [],
    supportedRelationTypes: ["CALLS", "IMPORTS"],
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
});

// Dictionary: 1 file id, 2 its path, 3 language, 4 symbol id, 5 kind, 6 name, then relation and
// evidence words.
const DICTIONARY = [
  "local/r:file:src/a.ts",
  "src/a.ts",
  "TypeScript",
  "local/r:TypeScript:src/a.ts:function:alpha",
  "function",
  "alpha",
  "CALLS",
  "IMPORTS",
  "call_site",
  "top_level_call_site",
  "import_statement",
  "reference",
  "spread",
];
const at = (text: string) => DICTIONARY.indexOf(text) + 1;

const decode = (
  evidence: readonly (readonly unknown[])[],
  options: Readonly<{
    schema?: string;
    relation?: string;
    /** The languages of `call_site_lines`; null when the engine does not declare it. */
    languages?: string[] | null;
  }> = {},
) => {
  const schema = options.schema ?? "1.4";
  const relations: GraphSnapshotRelation[] = [];
  const decoder = new CompactSnapshotDecoder(
    {
      provider: providerAt(schema),
      revision: COMMIT,
      profile: "full",
      repository: "/repo",
      importTargetLanguages: null,
      callSiteLineLanguages:
        options.languages === undefined
          ? ["TypeScript", "Go"]
          : options.languages,
    },
    { symbol: () => {}, relation: (relation) => relations.push(relation) },
  );
  const rows: unknown[] = [
    [
      "h",
      1,
      {
        schema_version: schema,
        provider: "entire-graph",
        provider_version: "fixture",
        identity_revision: "7",
        repo_root: "/repo",
        repo_key: "local/r",
        commit: COMMIT,
        tree: "2".repeat(40),
        profile: "full",
        relation_set: ["CALLS", "IMPORTS"],
        skipped_relation_families: [],
      },
    ],
    ["d", 1, DICTIONARY],
    ["f", at("local/r:file:src/a.ts"), at("src/a.ts"), 0, at("TypeScript"), 10],
    [
      "s",
      at("local/r:TypeScript:src/a.ts:function:alpha"),
      0,
      at("function"),
      at("alpha"),
      at("alpha"),
      at("src/a.ts"),
      1,
      3,
      0,
      0,
      at("TypeScript"),
      0,
      [],
    ],
    [
      "r",
      at("local/r:file:src/a.ts"),
      at("local/r:TypeScript:src/a.ts:function:alpha"),
      at(options.relation ?? "CALLS"),
      0.8,
      0,
      0,
      0,
      0,
      evidence,
      [],
    ],
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
          symbols: 1,
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

/** A call-site entry on line `line` of src/a.ts (0: no line), with a form slot when given. */
const entry = (kind: string, line: number, ...form: unknown[]) => [
  at(kind),
  at("src/a.ts"),
  line,
  line,
  at("alpha"),
  ...form,
];

// Why: a consumer may say "called here" or "used here" only from these two facts; each must arrive
// exactly as the engine wrote it, and the absence of a form must stay an absence.
test("an entry's line and form arrive as written, and an entry with no form has none", () => {
  const { relations } = decode([
    entry("top_level_call_site", 7, at("reference")),
    entry("call_site", 4),
    entry("call_site", 0),
  ]);
  expect<unknown>(relations[0]?.evidence).toEqual([
    {
      kind: "top_level_call_site",
      location: { kind: "range", path: "src/a.ts", startLine: 7, endLine: 7 },
      detail: "alpha",
      form: "reference",
    },
    {
      kind: "call_site",
      location: { kind: "range", path: "src/a.ts", startLine: 4, endLine: 4 },
      detail: "alpha",
    },
    {
      kind: "call_site",
      location: { kind: "path", path: "src/a.ts" },
      detail: "alpha",
    },
  ]);
  expect(relations[0]?.evidence[1]).not.toHaveProperty("form");
});

// Why: the languages decide what every line means; an engine that declares none gives an empty
// list, never a guess.
test("coverage carries the languages the engine declares for call lines, and none when it declares none", () => {
  expect(decode([]).coverage.callSiteLineLanguages).toEqual([
    "TypeScript",
    "Go",
  ]);
  expect(
    decode([], { languages: null }).coverage.callSiteLineLanguages,
  ).toEqual([]);
  // The pinned older engine: schema 1.3, no key, five-field entries.
  expect(
    decode([entry("call_site", 4)], { schema: "1.3", languages: null }).coverage
      .callSiteLineLanguages,
  ).toEqual([]);
});

// Why: the reader treats `form` as it treats the import target kinds, a closed set: through the
// schema it knows, a value it does not know, or a form where the engine promises none, is a wrong
// stream; reading it as a call would be the one claim the form exists to prevent.
test("a form the schema or the declaration does not allow rejects the stream", () => {
  const cases: [string, () => unknown][] = [
    [
      "an unknown value through schema 1.4",
      () => decode([entry("call_site", 4, at("spread"))]),
    ],
    [
      "a form before schema 1.4",
      () => decode([entry("call_site", 4, at("reference"))], { schema: "1.3" }),
    ],
    [
      "a form from an engine that declares no call lines",
      () =>
        decode([entry("call_site", 4, at("reference"))], { languages: null }),
    ],
    [
      "a form outside a call relation",
      () =>
        decode([entry("call_site", 4, at("reference"))], {
          relation: "IMPORTS",
        }),
    ],
    [
      "a form on an entry that is no call site",
      () => decode([entry("import_statement", 4, at("reference"))]),
    ],
    [
      "a form without a line",
      () => decode([entry("call_site", 0, at("reference"))]),
    ],
    ["an empty form slot", () => decode([entry("call_site", 4, 0)])],
    [
      "a form slot that is no index",
      () => decode([entry("call_site", 4, "x")]),
    ],
    [
      "a seventh field through schema 1.4",
      () => decode([entry("call_site", 4, at("reference"), 0)]),
    ],
  ];
  for (const [label, run] of cases)
    expect(run, label).toThrow(
      expect.objectContaining({ reason: "invalid-output" }),
    );
});

// Why: a newer minor may define another form; dropping it would make the entry read as a call, so
// it is passed as written for the consumer to refuse, and trailing fields are ignored as usual.
test("under a newer minor an unknown form is passed as written and a later field is ignored", () => {
  const { relations, coverage } = decode(
    [entry("call_site", 4, at("spread"), 9)],
    { schema: "1.9" },
  );
  expect(coverage.schema.newerMinor).toBe(true);
  expect(relations[0]?.evidence[0]?.form).toBe("spread");
  expect(() => decode([entry("call_site", 4, "x")], { schema: "1.9" })).toThrow(
    expect.objectContaining({ reason: "invalid-output" }),
  );
});
