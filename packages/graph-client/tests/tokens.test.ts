import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  GraphSymbolsError,
  graphLeafAncestors,
  graphLeafFlags,
  graphLeafOpens,
  graphLeafPosition,
  graphLeafType,
  graphGapAfterLast,
  graphGapBefore,
  graphImportStatementsAt,
  graphLeavesTouchingLines,
  graphRefusesSourcePath,
  readGraphSymbols,
  type GraphFileTokens,
} from "../src/index.ts";
import { SymbolObservation } from "../src/symbol-observation.ts";
import {
  SYMBOL_FILE_TOKENS_BYTES,
  SYMBOL_TOKENS_BATCH_BYTES,
  parseSymbolStream,
  readSymbolBatches,
  type SymbolsRuntime,
} from "../src/symbols.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

const encoder = new TextEncoder();
const SOURCE = "function alpha() {}\n";
const CHAINS = ["0", "1", "2", "3"].map((digit) => digit.repeat(16));

/**
 * Engine rows for `pieces` laid end to end in `source`: each piece's text is found after the one
 * before, and its lines are counted from the bytes, as the engine counts them.
 */
const rowsFor = (
  source: string,
  pieces: readonly (readonly [
    type: number,
    text: string,
    flags: number,
    ancestors: number,
    opens: number,
  ])[],
) => {
  const bytes = encoder.encode(source);
  const lineOf = (offset: number) =>
    1 + bytes.subarray(0, offset).filter((byte) => byte === 10).length;
  let cursor = 0;
  return pieces.map(([type, text, flags, ancestors, opens]) => {
    const start = encoder.encode(
      source.slice(0, source.indexOf(text, cursor)),
    ).byteLength;
    const end = start + encoder.encode(text).byteLength;
    cursor = source.indexOf(text, cursor) + text.length;
    return [
      type,
      start,
      end,
      lineOf(start),
      end > start ? lineOf(end - 1) : lineOf(start),
      flags,
      ancestors,
      opens,
    ];
  });
};

const ALPHA_TOKENS = {
  record_type: "file_tokens",
  file_path: "src/a.ts",
  language: "TypeScript",
  status: "extracted",
  has_errors: false,
  identifier_names: ["alpha"],
  leaf_types: ["function", "identifier", "(", ")", "{", "}"],
  ancestors: CHAINS,
  leaves: rowsFor(SOURCE, [
    [0, "function", 0, 1, 2],
    [1, "alpha", 9, 1, 0],
    [2, "(", 0, 2, 1],
    [3, ")", 0, 2, 0],
    [4, "{", 0, 3, 1],
    [5, "}", 0, 3, 0],
  ]),
  import_bindings: "extracted",
  imports: [],
};

/**
 * A fake engine; `tokens` false leaves the capability out, `directives` false leaves out only the
 * directive flag's declaration (an engine from before it). It records each run's arguments.
 */
const engine = async (
  tokens = true,
  directives = true,
  indentation = directives,
) => {
  const root = await mkdtemp(join(tmpdir(), "tokens-test-"));
  roots.push(root);
  const executable = join(root, "engine");
  const argvFile = join(root, "argv.ndjson");
  await Bun.write(
    executable,
    `#!${process.execPath}
import { createHash } from "node:crypto";
import { readFileSync, appendFileSync } from "node:fs";
const args = process.argv.slice(2), repo = args[args.indexOf("--repo") + 1];
const emit = (row) => console.log(JSON.stringify(row));
if (args[0] === "version") emit({version:"fixture",provider:"entire-graph",identity_revision:"4",build_identity:createHash("sha256").update(readFileSync(import.meta.path)).digest("hex")});
else if (args[0] === "capabilities") emit({schema_version:"1.3",provider:"entire-graph",supported_file_extensions:[".ts"],supported_languages:["TypeScript"],semantic_languages:["TypeScript"],inventory_only_languages:[],supported_relation_types:["DEFINES"],relation_support_by_language:{},relation_support_by_profile:{"syntax-only":["DEFINES"]},heuristic_relation_types:[],parser_versions:{},unsupported_but_detected_language_hints:[],optional_local_only_features:{symbols_outline:true${tokens ? ",symbols_outline_tokens:true,symbols_outline_import_bindings:true" : ""}${tokens && directives ? ",symbols_outline_token_directives:true" : ""}${tokens && indentation ? ",symbols_outline_indentation_significant:true" : ""}},features_requiring_network_access:{}${tokens ? `,feature_languages:{symbols_outline_tokens:["TypeScript"],symbols_outline_import_bindings:["TypeScript"]${directives ? ',symbols_outline_token_directives:["TypeScript"]' : ""}${indentation ? ',symbols_outline_indentation_significant:["TypeScript"]' : ""}}` : ""}});
else {
  appendFileSync(${JSON.stringify(argvFile)}, JSON.stringify(args.filter((arg) => arg !== repo)) + "\\n");
  emit({schema_version:"1.3",provider:"entire-graph",provider_version:"fixture",identity_revision:"4",repo_root:repo,profile:"syntax-only"});
  emit({record_type:"file_outline",file_path:"src/a.ts",language:"TypeScript",top_level:[{start_line:1,end_line:1,type:"function_declaration"}],identifiers:[[1,"alpha"]]});
  if (args.includes("--tokens")) emit(${JSON.stringify(ALPHA_TOKENS)});
  emit({record_type:"symbol",id:"f",kind:"function",name:"alpha",qualified_name:"alpha",file_path:"src/a.ts",start_line:1,end_line:1,language:"TypeScript"});
  emit({record_type:"summary",partial_failures:[]});
}`,
  );
  await chmod(executable, 0o700);
  return {
    root,
    argv: async () =>
      (await readFile(argvFile, "utf8").catch(() => ""))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line): unknown => JSON.parse(line)),
    input: {
      executable,
      temporaryParent: root,
      cacheDirectory: join(root, "cache"),
      files: [{ path: "src/a.ts", bytes: encoder.encode(SOURCE) }],
    },
  };
};

const PLAIN_ARGV = [
  "symbols",
  "--repo",
  "--worktree",
  "--format",
  "ndjson",
  "--profile",
  "syntax-only",
  "--outline",
];

// Why: the option is the only way tokens reach a caller, and without it a stored outline
// observation and its key must not move: same command, same fields, nothing added.
test("tokens add the flag and a tokens value per file; without them the command and the observation are as before", async () => {
  const { input, argv } = await engine();
  const plain = await readGraphSymbols(input);
  const withTokens = await readGraphSymbols({ ...input, tokens: true });
  expect(await argv()).toEqual([PLAIN_ARGV, [...PLAIN_ARGV, "--tokens"]]);

  expect(Object.keys(plain).sort()).toEqual([
    "batchOutputBytes",
    "files",
    "outlinesAvailable",
    "provider",
  ]);
  expect(Object.keys(plain.files.get("src/a.ts") ?? {}).sort()).toEqual([
    "language",
    "outline",
    "partialFailure",
    "symbols",
  ]);
  expect(Object.keys(plain.provider.capabilities)).not.toContain(
    "featureLanguages",
  );
  expect(SymbolObservation.parse(plain)).toEqual(plain);

  const file = withTokens.files.get("src/a.ts");
  expect(file?.outline).toEqual(plain.files.get("src/a.ts")?.outline);
  expect(file?.symbols).toEqual(plain.files.get("src/a.ts")?.symbols);
  expect(withTokens.tokenCoverage).toEqual({
    languages: ["TypeScript"],
    importBindingLanguages: ["TypeScript"],
    directiveLanguages: ["TypeScript"],
    indentationSignificantLanguages: ["TypeScript"],
  });
  const tokens = file?.tokens;
  if (tokens?.status !== "available") throw new Error("no tokens");
  expect(tokens.identifierNames).toEqual(["alpha"]);
  expect<unknown>(tokens.leaves).toEqual(ALPHA_TOKENS.leaves);
  expect(tokens.imports).toEqual({ status: "extracted", statements: [] });
  expect(tokens.unknownFlagBits).toBe(0);
  expect(tokens.directivesFlagged).toBe(true);
  // The fake engine declares its one language indentation-significant.
  expect(tokens.indentationSignificant).toBe(true);
  // The publication schema holds the value as it is.
  expect(SymbolObservation.parse(withTokens)).toEqual(withTokens);
});

// Why: an engine that cannot give tokens will refuse again, so the read must say so instead of
// returning outlines without tokens or a retryable failure.
test("an engine without the tokens capability is unsupported and never runs the read", async () => {
  const { input, argv } = await engine(false);
  await expect(
    readGraphSymbols({ ...input, tokens: true }),
  ).rejects.toMatchObject({ _tag: "GraphSymbolsError", reason: "unsupported" });
  expect(await argv()).toEqual([]);
  expect(
    (await readGraphSymbols(input)).files.get("src/a.ts")?.outline,
  ).not.toBeNull();
});

/** A stream for `parseSymbolStream` with the fake engine's provider. */
const stream = async () => {
  const { input } = await engine();
  const { provider } = await readGraphSymbols(input);
  const header = {
    schema_version: "1.3",
    provider: provider.name,
    provider_version: provider.version,
    identity_revision: provider.identityRevision,
    repo_root: "/fixture",
    profile: "syntax-only",
  };
  const outline = (path: string, language = "TypeScript") => ({
    record_type: "file_outline",
    file_path: path,
    language,
    top_level: [],
    identifiers: [],
  });
  const parse = (
    rows: readonly object[],
    files: Readonly<Record<string, string>> = { "src/a.ts": SOURCE },
    failures: readonly object[] = [],
  ) =>
    parseSymbolStream(
      [header, ...rows, { record_type: "summary", partial_failures: failures }]
        .map((row) => JSON.stringify(row))
        .join("\n"),
      Object.keys(files),
      provider,
      "/fixture",
      undefined,
      {
        bytes: new Map(
          Object.entries(files).map(([path, text]) => [
            path,
            encoder.encode(text),
          ]),
        ),
        coverage: {
          languages: ["TypeScript", "Go"],
          importBindingLanguages: ["TypeScript"],
          directiveLanguages: ["TypeScript"],
          indentationSignificantLanguages: [],
        },
      },
    );
  return { parse, outline };
};

/** A record whose leaves were not extracted, as the engine writes it; `extra` adds fields. */
const notExtracted = (
  path: string,
  status: "language_not_covered" | "over_size_limit",
  extra: object = {},
) => ({
  record_type: "file_tokens",
  file_path: path,
  language: "TypeScript",
  status,
  has_errors: false,
  import_bindings: "not_extracted",
  ...extra,
});

const withRow = (at: number, row: readonly number[]) => ({
  ...ALPHA_TOKENS,
  leaves: ALPHA_TOKENS.leaves.map((leaf, index) =>
    index === at ? [...row] : leaf,
  ),
});

// Why: the consumer slices text by these positions and compares runs of them, so a record that
// does not fit the bytes the engine was given must reject the read, as a bad outline does.
test("malformed tokens records reject the read", async () => {
  const { parse, outline } = await stream();
  const [first = [], second = []] = ALPHA_TOKENS.leaves;
  const cases: Record<string, readonly object[]> = {
    "type index outside the table": [
      outline("src/a.ts"),
      withRow(0, [6, ...first.slice(1)]),
    ],
    "ancestors index outside the table": [
      outline("src/a.ts"),
      withRow(0, [...first.slice(0, 6), 4, 2]),
    ],
    "rows out of order": [
      outline("src/a.ts"),
      {
        ...ALPHA_TOKENS,
        // A row that goes back to an earlier byte.
        leaves: [first, second, first, ...ALPHA_TOKENS.leaves.slice(3)],
      },
    ],
    "rows overlapping": [
      outline("src/a.ts"),
      withRow(1, [1, 7, 14, 1, 1, 9, 1, 0]),
    ],
    "a range past the file's end": [
      outline("src/a.ts"),
      withRow(5, [5, 18, 21, 1, 2, 0, 3, 0]),
    ],
    "lines that are not the lines of the bytes": [
      outline("src/a.ts"),
      withRow(1, [1, 9, 14, 2, 2, 9, 1, 0]),
    ],
    "a row that is not eight integers": [
      outline("src/a.ts"),
      withRow(1, [1, 9, 14, 1, 1, 9, 1]),
    ],
    "identifier names not distinct and sorted": [
      outline("src/a.ts"),
      { ...ALPHA_TOKENS, identifier_names: ["b", "a"] },
    ],
    "a record for a file not in the input": [
      outline("src/a.ts"),
      { ...ALPHA_TOKENS, file_path: "src/other.ts" },
    ],
    "a record before its outline": [ALPHA_TOKENS, outline("src/a.ts")],
    "a record after another file's outline": [
      outline("src/a.ts"),
      outline("src/b.ts"),
      ALPHA_TOKENS,
    ],
    "a repeated record": [outline("src/a.ts"), ALPHA_TOKENS, ALPHA_TOKENS],
    "a language other than its outline's": [
      outline("src/a.ts"),
      { ...ALPHA_TOKENS, language: "Go" },
    ],
    "bindings extracted outside the declared languages": [
      outline("src/a.ts", "Go"),
      { ...ALPHA_TOKENS, language: "Go" },
    ],
    "an outline without its record": [outline("src/a.ts")],
    "an undeclared language's outline without its record": [
      outline("src/a.ts"),
      ALPHA_TOKENS,
      outline("src/b.ts", "Lua"),
    ],
    "a record without a status": [
      outline("src/a.ts"),
      { ...ALPHA_TOKENS, status: undefined },
    ],
    "an extracted record missing a table": [
      outline("src/a.ts"),
      { ...ALPHA_TOKENS, leaf_types: undefined },
    ],
    "an extracted record missing its leaves": [
      outline("src/a.ts"),
      { ...ALPHA_TOKENS, leaves: undefined },
    ],
    "a record not extracted that carries leaves": [
      outline("src/a.ts"),
      notExtracted("src/a.ts", "over_size_limit", { leaves: [] }),
    ],
    "a record not extracted that carries names": [
      outline("src/a.ts"),
      notExtracted("src/a.ts", "over_size_limit", { identifier_names: [] }),
    ],
    "language_not_covered for a declared language": [
      outline("src/a.ts"),
      notExtracted("src/a.ts", "language_not_covered"),
    ],
    "over_size_limit for a language not declared": [
      outline("src/a.ts", "Lua"),
      notExtracted("src/a.ts", "over_size_limit", { language: "Lua" }),
    ],
    "extracted for a language not declared": [
      outline("src/a.ts", "Lua"),
      { ...ALPHA_TOKENS, language: "Lua" },
    ],
  };
  // The rule each case breaks, as the reader names it.
  const broken: Record<string, string> = {
    "type index outside the table": "type outside the table",
    "ancestors index outside the table": "ancestors outside the table",
    "rows out of order": "out of order or overlaps",
    "rows overlapping": "out of order or overlaps",
    "a range past the file's end": "bytes outside the file",
    "lines that are not the lines of the bytes": "not the lines of its bytes",
    "a row that is not eight integers": "not eight non-negative integers",
    "identifier names not distinct and sorted": "not distinct and sorted",
    "a record for a file not in the input":
      "does not follow its file's outline",
    "a record before its outline": "does not follow its file's outline",
    "a record after another file's outline":
      "does not follow its file's outline",
    "a repeated record": "does not follow its file's outline",
    "a language other than its outline's": "language differs",
    "bindings extracted outside the declared languages":
      "contradict the declared languages",
    "an outline without its record": "has no tokens record",
    "an undeclared language's outline without its record":
      "has no tokens record",
    "a record without a status": "status",
    "an extracted record missing a table": "leaf_types",
    "an extracted record missing its leaves": "leaves must be an array",
    "a record not extracted that carries leaves": "leaves",
    "a record not extracted that carries names": "identifier_names",
    "language_not_covered for a declared language":
      "contradicts the declared languages",
    "over_size_limit for a language not declared":
      "contradicts the declared languages",
    "extracted for a language not declared": "not declared",
  };
  expect(Object.keys(broken).sort()).toEqual(Object.keys(cases).sort());
  for (const [label, rows] of Object.entries(cases))
    await expect(
      parse(rows, { "src/a.ts": SOURCE, "src/b.ts": "" }),
      label,
    ).rejects.toMatchObject({
      reason: "invalid-output",
      cause: { message: expect.stringContaining(broken[label] ?? label) },
    });
  // Each case differs from this accepted one by its one defect.
  const accepted = await parse([outline("src/a.ts"), ALPHA_TOKENS]);
  expect(accepted.files.get("src/a.ts")?.tokens?.status).toBe("available");
});

// Why: the consumer compares runs of leaves and reads the names to judge a removed import, so a
// leaf the record leaves out, a name it never shows as a leaf, or a row that cuts a character
// would turn into a wrong "no token changed" or a wrong "unused".
test("a record that does not tile its bytes or name its identifiers rejects the read", async () => {
  const { parse, outline } = await stream();
  const accepted = async (path: string, source: string, record: object) =>
    (await parse([outline(path), record], { [path]: source })).files.get(path)
      ?.tokens;
  const refused = (
    path: string,
    source: string,
    record: object,
    rule: string,
  ) =>
    expect(
      parse([outline(path), record], { [path]: source }),
      rule,
    ).rejects.toMatchObject({
      reason: "invalid-output",
      cause: { message: expect.stringContaining(rule) },
    });
  const leaves = ALPHA_TOKENS.leaves;
  // A leaf left out, between rows, before the first and after the last.
  await refused(
    "src/a.ts",
    SOURCE,
    { ...ALPHA_TOKENS, leaves: leaves.filter((_, at) => at !== 2) },
    "non-whitespace bytes before leaf 2",
  );
  await refused(
    "src/a.ts",
    SOURCE,
    { ...ALPHA_TOKENS, leaves: leaves.slice(1) },
    "non-whitespace bytes before leaf 0",
  );
  await refused(
    "src/a.ts",
    SOURCE,
    { ...ALPHA_TOKENS, leaves: leaves.slice(0, -1) },
    "after the last leaf",
  );
  // An identifier leaf whose text is not a name, and a name with no identifier leaf.
  await refused(
    "src/a.ts",
    SOURCE,
    { ...ALPHA_TOKENS, identifier_names: ["beta"] },
    "identifier leaf 1 is not in identifier_names",
  );
  await refused(
    "src/a.ts",
    SOURCE,
    { ...ALPHA_TOKENS, identifier_names: ["alpha", "zeta"] },
    'identifier name "zeta" has no identifier leaf',
  );
  // A leading byte-order mark is never a row; space, tab, CR and LF are layout.
  const bom = "\uFEFFa \té\r\n";
  const bomRecord = (rows: readonly number[][]) => ({
    ...ALPHA_TOKENS,
    file_path: "src/u.ts",
    identifier_names: ["é"],
    leaf_types: ["a", "name"],
    leaves: rows,
  });
  // Bytes: BOM 0-3, "a" 3-4, space 4, tab 5, "é" 6-8, "\r\n" 8-10.
  expect(
    await accepted(
      "src/u.ts",
      bom,
      bomRecord([
        [0, 3, 4, 1, 1, 0, 1, 1],
        [1, 6, 8, 1, 1, 9, 1, 0],
      ]),
    ),
  ).toMatchObject({ status: "available", identifierNames: ["é"] });
  // A row that ends inside "é", and one that starts inside it.
  await refused(
    "src/u.ts",
    bom,
    bomRecord([
      [0, 3, 4, 1, 1, 0, 1, 1],
      [1, 6, 7, 1, 1, 0, 1, 0],
      [1, 7, 8, 1, 1, 0, 1, 0],
    ]),
    "leaf 1 begins or ends inside a character",
  );
  // Any other byte between rows is a missing row: a no-break space, a form feed, a vertical tab.
  for (const other of ["\u00A0", "\f", "\v", "\u3000"])
    await refused(
      "src/w.ts",
      `a${other}b\n`,
      {
        ...ALPHA_TOKENS,
        file_path: "src/w.ts",
        identifier_names: [],
        leaf_types: ["a", "b"],
        leaves: [
          [0, 0, 1, 1, 1, 0, 1, 1],
          [
            1,
            1 + encoder.encode(other).byteLength,
            2 + encoder.encode(other).byteLength,
            1,
            1,
            0,
            1,
            0,
          ],
        ],
      },
      "non-whitespace bytes before leaf 1",
    );
  // The mark itself as a row's content is not layout: a row cannot begin after it if it is not one.
  await refused(
    "src/v.ts",
    "a\uFEFFb\n",
    {
      ...ALPHA_TOKENS,
      file_path: "src/v.ts",
      identifier_names: [],
      leaf_types: ["a", "b"],
      leaves: [
        [0, 0, 1, 1, 1, 0, 1, 1],
        [1, 4, 5, 1, 1, 0, 1, 0],
      ],
    },
    "non-whitespace bytes before leaf 1",
  );
});

// Why: the engine's docs do not make names_unknown and bindings exclusive, and the engine never
// sets both today; the reader keeps both as given, and the rule does not decide on names_unknown.
test("an import with names_unknown and explicit bindings is kept as given", async () => {
  const { parse, outline } = await stream();
  const source = "import x from 'm';\n";
  const parsed = await parse(
    [
      outline("src/i.ts"),
      {
        ...ALPHA_TOKENS,
        file_path: "src/i.ts",
        identifier_names: [],
        leaf_types: ["text"],
        leaves: [[0, 0, 18, 1, 1, 0, 1, 1]],
        imports: [
          {
            start_line: 1,
            end_line: 1,
            start_byte: 0,
            end_byte: 18,
            specifier: "m",
            bindings: [{ imported: "default", local: "x", type_only: false }],
            side_effect_only: false,
            names_unknown: true,
          },
        ],
      },
    ],
    { "src/i.ts": source },
  );
  const tokens = parsed.files.get("src/i.ts")?.tokens;
  if (tokens?.status !== "available") throw new Error("no tokens");
  expect(tokens.imports).toEqual({
    status: "extracted",
    statements: [
      {
        startLine: 1,
        endLine: 1,
        startByte: 0,
        endByte: 18,
        specifier: "m",
        bindings: [
          {
            imported: "default",
            local: "x",
            typeOnly: false,
            localInferred: false,
          },
        ],
        sideEffectOnly: false,
        namesUnknown: true,
      },
    ],
  });
});

// Why: the consumer reads which leaves an import statement holds by these bytes, so a range that
// does not fit the file, or cuts a leaf, would put a token on the wrong side of the statement.
test("import statement bytes are checked like a leaf's range", async () => {
  const { parse, outline } = await stream();
  const source = "import a from 'a';\nimport b from 'b';\n";
  const statement = (start_byte: number, end_byte: number, line = 1) => ({
    start_line: line,
    end_line: line,
    start_byte,
    end_byte,
    specifier: "a",
    bindings: [],
    side_effect_only: true,
    names_unknown: false,
  });
  const record = (imports: readonly object[]) => ({
    ...ALPHA_TOKENS,
    file_path: "src/s.ts",
    identifier_names: [],
    leaf_types: ["import", "rest", ";"],
    leaves: rowsFor(source, [
      [0, "import", 0, 1, 2],
      [1, "a from 'a'", 0, 1, 0],
      [2, ";", 0, 1, 0],
      [0, "import", 0, 1, 2],
      [1, "b from 'b'", 0, 1, 0],
      [2, ";", 0, 1, 0],
    ]),
    imports,
  });
  const read = (imports: readonly object[]) =>
    parse([outline("src/s.ts"), record(imports)], { "src/s.ts": source });
  const both = [statement(0, 18), statement(19, 37, 2)];
  const tokens = (await read(both)).files.get("src/s.ts")?.tokens;
  if (tokens?.status !== "available") throw new Error("no tokens");
  expect(
    tokens.leaves.map((_, at) =>
      graphImportStatementsAt(tokens, at).map((found) => found.startByte),
    ),
  ).toEqual([[0], [0], [0], [19], [19], [19]]);
  // Python's `import a, b` gives two statements the one range; both contain its leaves.
  const shared = (await read([statement(0, 18), statement(0, 18)])).files.get(
    "src/s.ts",
  )?.tokens;
  if (shared?.status !== "available") throw new Error("no tokens");
  expect(graphImportStatementsAt(shared, 0)).toHaveLength(2);
  expect(graphImportStatementsAt(shared, 3)).toEqual([]);
  const refused: [string, readonly object[], string][] = [
    ["past the end", [statement(19, 40, 2)], "bytes outside the file"],
    ["reversed", [statement(10, 5)], "bytes outside the file"],
    [
      "lines not its bytes",
      [statement(19, 37, 1)],
      "not the lines of its bytes",
    ],
    ["a leaf cut at its start", [statement(2, 18)], "straddles"],
    ["a leaf cut at its end", [statement(0, 10)], "straddles"],
    [
      "overlapping statements",
      [statement(0, 18), statement(7, 37)],
      "overlap or are out of order",
    ],
    [
      "out of order",
      [statement(19, 37, 2), statement(0, 18, 2)],
      "overlap or are out of order",
    ],
    [
      "a start between leaves",
      [statement(6, 18)],
      "does not start at the start of a leaf",
    ],
    [
      "an end between leaves",
      [statement(0, 19)],
      "does not end at the end of a leaf",
    ],
  ];
  for (const [label, imports, rule] of refused)
    await expect(read(imports), label).rejects.toMatchObject({
      reason: "invalid-output",
      cause: { message: expect.stringContaining(rule) },
    });
  // A range whose last leaf is a comment: the statement node never ends with one.
  const commented = "import a from 'a' // c\n";
  await expect(
    parse(
      [
        outline("src/c.ts"),
        {
          ...record([statement(0, 22)]),
          file_path: "src/c.ts",
          leaf_types: ["import", "rest", "comment"],
          leaves: rowsFor(commented, [
            [0, "import", 0, 1, 2],
            [1, "a from 'a'", 0, 1, 0],
            [2, "// c", 2, 1, 0],
          ]),
        },
      ],
      { "src/c.ts": commented },
    ),
  ).rejects.toMatchObject({
    cause: {
      message: expect.stringContaining("begins or ends with a comment"),
    },
  });
  // The limit of these checks, kept as a reviewer found it: a range that also takes the code
  // before the import on its line is well formed by position (it starts and ends at leaves, cuts
  // none, and its lines are its bytes' lines), so the reader accepts it. That a range is exactly
  // one import statement is the engine's fact, pinned by its own tests; the reader cannot know it.
  const before = "x(); import a from 'a';\n";
  const loose = await parse(
    [
      outline("src/x.ts"),
      {
        ...record([statement(0, 23)]),
        file_path: "src/x.ts",
        leaf_types: ["x", "(", ")", ";", "import", "rest"],
        leaves: rowsFor(before, [
          [0, "x", 0, 1, 2],
          [1, "(", 0, 1, 0],
          [2, ")", 0, 1, 0],
          [3, ";", 0, 1, 0],
          [4, "import", 0, 1, 1],
          [5, "a from 'a'", 0, 1, 0],
          [3, ";", 0, 1, 0],
        ]),
      },
    ],
    { "src/x.ts": before },
  );
  expect(loose.files.get("src/x.ts")?.tokens?.status).toBe("available");
  // Required: nothing with the earlier shape was released.
  const { start_byte: _s, end_byte: _e, ...old } = statement(0, 18);
  await expect(read([old])).rejects.toMatchObject({
    reason: "invalid-output",
  });
});

// Why: the consumer's layout rule compares the whitespace between leaves; these accessors are all it
// reads, so each kind and plainness must be exact, and the bytes must be the caller's own.
test("gap accessors give each gap's kind, plainness and bytes", async () => {
  const { parse, outline } = await stream();
  const gapsOf = async (source: string, pieces: readonly string[]) => {
    const parsed = await parse(
      [
        outline("src/g.ts"),
        {
          ...ALPHA_TOKENS,
          file_path: "src/g.ts",
          identifier_names: [],
          leaf_types: ["leaf"],
          leaves: rowsFor(
            source,
            pieces.map((piece) => [0, piece, 0, 1, 0] as const),
          ),
        },
      ],
      { "src/g.ts": source },
    );
    const tokens = parsed.files.get("src/g.ts")?.tokens;
    if (tokens?.status !== "available") throw new Error("no tokens");
    const bytes = encoder.encode(source);
    return [
      ...tokens.leaves.map((_, at) => graphGapBefore(tokens, bytes, at)),
      graphGapAfterLast(tokens, bytes),
    ];
  };
  const nth = <T>(list: readonly T[], at: number): T => {
    const found = list[at];
    if (found === undefined) throw new Error(`no item ${at}`);
    return found;
  };
  const shape = (gap: { kind: string; plain: boolean }) => [
    gap.kind,
    gap.plain,
  ];
  // An indented directive comment: still a line break, no longer plain.
  expect((await gapsOf("a\n//go:x\n", ["a", "//go:x"]))[1]).toEqual({
    kind: "newline",
    plain: true,
    startByte: 1,
    endByte: 2,
  });
  expect(shape(nth(await gapsOf("a\n\t//go:x\n", ["a", "//go:x"]), 1))).toEqual(
    ["newline", false],
  );
  // A blank line between a comment and the next token: same kind, more bytes.
  const tight = nth(await gapsOf("// c\nx\n", ["// c", "x"]), 1);
  const spaced = nth(await gapsOf("// c\n\nx\n", ["// c", "x"]), 1);
  expect([shape(tight), shape(spaced)]).toEqual([
    ["newline", true],
    ["newline", true],
  ]);
  expect(spaced.endByte - spaced.startByte).toBe(2);
  // A tab against eight spaces: same kind, plainness differs.
  expect(shape(nth(await gapsOf("if\n\tx\n", ["if", "x"]), 1))).toEqual([
    "newline",
    false,
  ]);
  expect(shape(nth(await gapsOf("if\n        x\n", ["if", "x"]), 1))).toEqual([
    "newline",
    true,
  ]);
  // A re-wrapped call: the kind changes.
  expect(
    (await gapsOf("f(a)\n", ["f", "(", "a", ")"])).map((gap) => gap.kind),
  ).toEqual(["none", "none", "none", "none", "newline"]);
  expect((await gapsOf("f(\n  a)\n", ["f", "(", "a", ")"]))[2]?.kind).toBe(
    "newline",
  );
  // Reindented with spaces: kind and plainness the same, bytes differ.
  const two = nth(await gapsOf("{\n  b\n}\n", ["{", "b", "}"]), 1);
  const four = nth(await gapsOf("{\n    b\n}\n", ["{", "b", "}"]), 1);
  expect(shape(two)).toEqual(shape(four));
  expect([two.endByte - two.startByte, four.endByte - four.startByte]).toEqual([
    3, 5,
  ]);
  // A carriage return is not plain; a leading byte-order mark is no gap.
  expect(shape(nth(await gapsOf("a\r\nb\n", ["a", "b"]), 1))).toEqual([
    "newline",
    false,
  ]);
  expect((await gapsOf("﻿a\n", ["a"]))[0]).toEqual({
    kind: "none",
    plain: true,
    startByte: 3,
    endByte: 3,
  });
  expect((await gapsOf(" a", ["a"])).map(shape)).toEqual([
    ["inline", true],
    ["none", true],
  ]);
  // Bytes that are not the file's are refused, not read past their end.
  const { parse: again, outline: line } = await stream();
  const tokens = (await again([line("src/a.ts"), ALPHA_TOKENS])).files.get(
    "src/a.ts",
  )?.tokens;
  if (tokens?.status !== "available") throw new Error("no tokens");
  expect(() => graphGapBefore(tokens, encoder.encode("x"), 3)).toThrow(
    RangeError,
  );
  // Long enough but not the file: a gap that holds anything but layout bytes is refused too.
  expect(() =>
    graphGapBefore(tokens, encoder.encode("functionXalpha() {}\n"), 1),
  ).toThrow(RangeError);
  expect(graphGapBefore(tokens, encoder.encode(SOURCE), 1)).toMatchObject({
    kind: "inline",
  });
});

// Why: a newer engine may add a flag bit; the additive schema rule keeps the read and says so.
test("an unknown flag bit is kept, reported and left out of the accessors", async () => {
  const { parse, outline } = await stream();
  const [, alpha = []] = ALPHA_TOKENS.leaves;
  const parsed = await parse([
    outline("src/a.ts"),
    withRow(1, [...alpha.slice(0, 5), 9 | 64, ...alpha.slice(6)]),
  ]);
  const tokens = parsed.files.get("src/a.ts")?.tokens;
  if (tokens?.status !== "available") throw new Error("no tokens");
  expect(tokens.unknownFlagBits).toBe(64);
  expect(graphLeafFlags(tokens, 1)).toEqual({
    identifier: true,
    comment: false,
    error: false,
    named: true,
    rewritten: false,
    directive: false,
  });
});

// Why: a directive is a comment a tool reads; the consumer compares those, so the flag must mean
// what the engine documents and its absence must never stand for "no directives" where undeclared.
test("directive leaves are comments in a declared language, and each file says whether it is flagged", async () => {
  const { parse, outline } = await stream();
  const source = "// @ts-expect-error x\nconst a = 1;\n";
  const record = (flags: number, language = "TypeScript") => ({
    ...ALPHA_TOKENS,
    file_path: "src/d.ts",
    language,
    identifier_names: ["a"],
    leaf_types: ["comment", "const", "identifier", "=", "number", ";"],
    ...(language === "TypeScript"
      ? {}
      : { import_bindings: "not_extracted", imports: undefined }),
    leaves: rowsFor(source, [
      [0, "// @ts-expect-error x", flags, 1, 1],
      [1, "const", 0, 2, 1],
      [2, "a", 9, 3, 1],
      [3, "=", 0, 3, 0],
      [4, "1", 8, 3, 0],
      [5, ";", 0, 2, 0],
    ]),
  });
  const read = (flags: number, language?: string) =>
    parse([outline("src/d.ts", language), record(flags, language)], {
      "src/d.ts": source,
    });
  const tokens = (await read(2 | 8 | 32)).files.get("src/d.ts")?.tokens;
  if (tokens?.status !== "available") throw new Error("no tokens");
  expect(tokens.directivesFlagged).toBe(true);
  expect(graphLeafFlags(tokens, 0)).toMatchObject({
    comment: true,
    directive: true,
  });
  expect(graphLeafFlags(tokens, 1).directive).toBe(false);
  // Go is declared for tokens here, not for directives: its leaves say nothing either way.
  const go = (await read(2 | 8, "Go")).files.get("src/d.ts")?.tokens;
  expect(go).toMatchObject({ status: "available", directivesFlagged: false });
  // There the accessor says null, never "no directive", even for a comment leaf.
  if (go?.status !== "available") throw new Error("no tokens");
  expect(graphLeafFlags(go, 0)).toMatchObject({
    comment: true,
    directive: null,
  });
  await expect(read(8 | 32)).rejects.toMatchObject({
    cause: {
      message: expect.stringContaining("a directive but not a comment"),
    },
  });
  await expect(read(2 | 8 | 32, "Go")).rejects.toMatchObject({
    cause: {
      message: expect.stringContaining("a language not declared for them"),
    },
  });
});

// Why: an engine from before the directive flag still gives tokens; it simply declares none.
test("an engine without the directive capability still reads, with no directive language", async () => {
  const { input } = await engine(true, false);
  const result = await readGraphSymbols({ ...input, tokens: true });
  expect(result.tokenCoverage?.directiveLanguages).toEqual([]);
  expect(result.files.get("src/a.ts")?.tokens).toMatchObject({
    status: "available",
    directivesFlagged: false,
  });
});

// Why: where leading whitespace is syntax the consumer must not call a reindentation layout; an
// engine from before the key declares no such language, which means "not declared", not "free-form".
test("indentation significance is the declaration's, and an engine without the key reads with none", async () => {
  const declared = await engine(true, true, true);
  const withKey = await readGraphSymbols({ ...declared.input, tokens: true });
  expect(withKey.tokenCoverage?.indentationSignificantLanguages).toEqual([
    "TypeScript",
  ]);
  expect(withKey.files.get("src/a.ts")?.tokens).toMatchObject({
    status: "available",
    indentationSignificant: true,
  });
  const older = await engine(true, true, false);
  const withoutKey = await readGraphSymbols({ ...older.input, tokens: true });
  // Not declared: null, never false, so it cannot read as "free-form".
  expect(withoutKey.tokenCoverage?.indentationSignificantLanguages).toBeNull();
  expect(withoutKey.files.get("src/a.ts")?.tokens).toMatchObject({
    status: "available",
    directivesFlagged: true,
    indentationSignificant: null,
  });
});

// Why: the consumer must tell "not evaluated by declaration" and stable failures from a retryable
// one, exactly as the outline's fallbacks do.
test("files without tokens say why, stable or retryable", async () => {
  const { parse, outline } = await stream();
  const parsed = await parse(
    [
      outline("src/a.ts"),
      ALPHA_TOKENS,
      outline("notes/c.lua", "Lua"),
      notExtracted("notes/c.lua", "language_not_covered", { language: "Lua" }),
      outline("src/large.ts"),
      notExtracted("src/large.ts", "over_size_limit"),
    ],
    {
      "src/a.ts": SOURCE,
      "notes/c.lua": "x = 1\n",
      "src/large.ts": "x\n",
      "docs/b.md": "# b\n",
      "src/broken.ts": "function (\n",
      "src/slow.ts": "x\n",
    },
    [
      { code: "E_PARSE_ERROR", file_path: "src/broken.ts" },
      { code: "E_PARSE_TIMEOUT", file_path: "src/slow.ts" },
    ],
  );
  const reason = (path: string) => {
    const tokens = parsed.files.get(path)?.tokens;
    return tokens?.status === "unavailable"
      ? [tokens.reason, tokens.retryable]
      : tokens?.status;
  };
  expect(reason("src/a.ts")).toBe("available");
  // Lua has an outline; the engine does not list it for tokens and its record says so.
  expect(reason("notes/c.lua")).toEqual(["unsupported-language", false]);
  // Over the engine's own limit: stable, and the outline is kept.
  expect(reason("src/large.ts")).toEqual(["tokens-size-limit", false]);
  expect(parsed.files.get("src/large.ts")?.outline).not.toBeNull();
  expect(reason("docs/b.md")).toEqual(["unsupported-language", false]);
  expect(reason("src/broken.ts")).toEqual(["parse-error", false]);
  expect(reason("src/slow.ts")).toEqual(["partial-failure", true]);
});

const fakeRuntime = async (
  output: (
    names: readonly string[],
    repo: string,
    tokens: boolean,
  ) => readonly object[] | "overflow",
) => {
  const { input } = await engine();
  const { provider } = await readGraphSymbols(input);
  const calls: { names: string[]; bytes: number; tokens: boolean }[] = [];
  const runtime: SymbolsRuntime = {
    provider,
    featureLanguages: {
      symbols_outline_tokens: ["TypeScript"],
      symbols_outline_import_bindings: ["TypeScript"],
    },
    init: async () => {},
    run: async (repo, _outlines, _signal, tokens) => {
      const names = (await readdir(repo)).sort();
      let bytes = 0;
      for (const name of names)
        bytes += (await readFile(join(repo, name))).byteLength;
      calls.push({ names, bytes, tokens });
      const rows = output(names, repo, tokens);
      if (rows === "overflow")
        throw new GraphSymbolsError({
          reason: "invalid-output",
          message: "Graph command exceeded its output byte bound.",
        });
      return [
        {
          schema_version: "1.3",
          provider: provider.name,
          provider_version: provider.version,
          identity_revision: provider.identityRevision,
          repo_root: repo,
          profile: "syntax-only",
        },
        ...rows,
        { record_type: "summary", partial_failures: [] },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n");
    },
  };
  return { input, runtime, calls };
};

const emptyTokens = (path: string) => ({
  ...ALPHA_TOKENS,
  file_path: path,
  identifier_names: [],
  leaves: [],
});
const outlineOf = (path: string) => ({
  record_type: "file_outline",
  file_path: path,
  language: "TypeScript",
  top_level: [],
  identifiers: [],
});

// Why: a file's tokens are about 7 bytes per source byte; one too large for its allowance loses
// its tokens with a named stable reason, never its outline.
test("a tokens record over the per-file allowance gives source-not-parsed and keeps the outline", async () => {
  const { input, runtime } = await fakeRuntime((names) =>
    names.flatMap((path) => [
      outlineOf(path),
      path === "big.ts"
        ? {
            ...emptyTokens(path),
            padding: "x".repeat(SYMBOL_FILE_TOKENS_BYTES),
          }
        : emptyTokens(path),
    ]),
  );
  const result = await readSymbolBatches(
    {
      ...input,
      tokens: true,
      files: [
        { path: "big.ts", bytes: new Uint8Array() },
        { path: "small.ts", bytes: new Uint8Array() },
      ],
    },
    runtime,
  );
  expect(result.files.get("big.ts")?.outline).not.toBeNull();
  expect(result.files.get("big.ts")?.partialFailure).toBeNull();
  expect(result.files.get("big.ts")?.tokens).toEqual({
    status: "unavailable",
    reason: "source-not-parsed",
    retryable: false,
    codes: ["tokens-output-limit"],
  });
  expect(result.files.get("small.ts")?.tokens?.status).toBe("available");
});

// Why: with tokens the stream is about ten times the source, so batches are cut at the tokens
// bound and a normal tree does not overflow the 64 MiB command bound and re-split every time.
test("tokens batches stay under the command bound at the measured density", async () => {
  // Overflows above 3.2 MiB of source: twenty bytes of output per source byte, twice the
  // measured average, which a 4 MiB batch would pass.
  const { input, runtime, calls } = await fakeRuntime((names) =>
    (calls.at(-1)?.bytes ?? 0) * 20 > 64 * 1024 * 1024
      ? "overflow"
      : names.flatMap((path) => [outlineOf(path), emptyTokens(path)]),
  );
  const files = Array.from({ length: 16 }, (_, index) => ({
    path: `f${index}.ts`,
    // Whitespace only, so a record with no leaves fits it.
    bytes: new Uint8Array(512 * 1024).fill(0x20),
  }));
  const result = await readSymbolBatches(
    { ...input, tokens: true, files },
    runtime,
  );
  expect(calls.every((call) => call.tokens)).toBe(true);
  expect(Math.max(...calls.map((call) => call.bytes))).toBe(
    SYMBOL_TOKENS_BATCH_BYTES,
  );
  expect(calls).toHaveLength(4);
  expect(
    [...result.files.values()].every(
      (file) => file.tokens?.status === "available",
    ),
  ).toBe(true);
});

// Why: one file whose tokens overflow the whole command must still give its outline.
test("a single file whose tokens overflow the command is read again without them", async () => {
  const { input, runtime, calls } = await fakeRuntime((names, _repo, tokens) =>
    tokens && names.includes("dense.ts")
      ? "overflow"
      : names.flatMap((path) =>
          tokens ? [outlineOf(path), emptyTokens(path)] : [outlineOf(path)],
        ),
  );
  const result = await readSymbolBatches(
    {
      ...input,
      tokens: true,
      files: [
        { path: "dense.ts", bytes: encoder.encode(" ") },
        { path: "plain.ts", bytes: encoder.encode(" ") },
      ],
    },
    runtime,
  );
  expect(calls.map((call) => [call.names, call.tokens])).toEqual([
    [["dense.ts", "plain.ts"], true],
    [["dense.ts"], true],
    [["dense.ts"], false],
    [["plain.ts"], true],
  ]);
  expect(result.files.get("dense.ts")?.outline).not.toBeNull();
  expect(result.files.get("dense.ts")?.tokens).toMatchObject({
    status: "unavailable",
    reason: "source-not-parsed",
    codes: ["tokens-output-limit"],
  });
  expect(result.files.get("plain.ts")?.tokens?.status).toBe("available");
  expect(result.tokenCoverage?.languages).toEqual(["TypeScript"]);
});

// Why: the consumer reads leaves only through these, by line ranges of changed rows.
test("the accessors read one leaf at a time, and a range takes a multi-line leaf that runs into it", async () => {
  const { parse, outline } = await stream();
  const source = "const a = `x\ny\nz`;\nconst b = 1;\n";
  const parsed = await parse(
    [
      outline("src/m.ts"),
      {
        ...ALPHA_TOKENS,
        file_path: "src/m.ts",
        identifier_names: ["a", "b"],
        leaf_types: [
          "const",
          "identifier",
          "=",
          "template_string",
          ";",
          "number",
        ],
        leaves: rowsFor(source, [
          [0, "const", 0, 1, 2],
          [1, "a", 9, 2, 0],
          [2, "=", 0, 2, 0],
          [3, "`x\ny\nz`", 8, 2, 0],
          [4, ";", 0, 1, 0],
          [0, "const", 0, 1, 2],
          [1, "b", 9, 2, 0],
          [2, "=", 0, 2, 0],
          [5, "1", 8, 2, 0],
          [4, ";", 0, 1, 0],
        ]),
      },
    ],
    { "src/m.ts": source },
  );
  const tokens = parsed.files.get("src/m.ts")?.tokens;
  if (tokens?.status !== "available") throw new Error("no tokens");
  const types = (range: { from: number; to: number }) =>
    tokens.leaves
      .slice(range.from, range.to)
      .map((_, offset) => graphLeafType(tokens, range.from + offset));
  // Line 2 lies inside the template string, which begins on line 1.
  expect(types(graphLeavesTouchingLines(tokens, 2, 2))).toEqual([
    "template_string",
  ]);
  expect(types(graphLeavesTouchingLines(tokens, 3, 4))).toEqual([
    "template_string",
    ";",
    "const",
    "identifier",
    "=",
    "number",
    ";",
  ]);
  expect(graphLeavesTouchingLines(tokens, 5, 9)).toEqual({ from: 10, to: 10 });
  // An empty or inverted range touches nothing, even inside the template string.
  expect(graphLeavesTouchingLines(tokens, 3, 2)).toEqual({ from: 3, to: 3 });
  expect(graphLeavesTouchingLines(tokens, 2, 1)).toEqual({ from: 3, to: 3 });
  expect(graphLeafPosition(tokens, 3)).toEqual({
    startByte: 10,
    endByte: 17,
    startLine: 1,
    endLine: 3,
  });
  expect(graphLeafFlags(tokens, 6)).toMatchObject({
    identifier: true,
    named: true,
    comment: false,
  });
  expect(graphLeafFlags(tokens, 0).named).toBe(false);
  expect(graphLeafAncestors(tokens, 1)).toBe(CHAINS[2] ?? "");
  expect(graphLeafOpens(tokens, 5)).toBe(2);
  expect(() => graphLeafType(tokens, 10)).toThrow(RangeError);
});

test("graphRefusesSourcePath is the rule every read applies", () => {
  for (const path of ["", "/a", "a/../b", "a//b", ".git/x", "a\\b", "C:/a"])
    expect(graphRefusesSourcePath(path)).toBe(true);
  expect(graphRefusesSourcePath("src/a.ts")).toBe(false);
});

/** The file rebuilt from its leaves and only the whitespace between them. */
const rebuild = (bytes: Uint8Array, tokens: GraphFileTokens) => {
  if (tokens.status !== "available") throw new Error("no tokens");
  const decoder = new TextDecoder();
  let text = "";
  let at = 0;
  for (const [, start, end] of tokens.leaves) {
    const gap = decoder.decode(bytes.subarray(at, start));
    expect(gap).toMatch(/^[\s\uFEFF]*$/);
    text += gap + decoder.decode(bytes.subarray(start, end));
    at = end;
  }
  const tail = decoder.decode(bytes.subarray(at));
  expect(tail).toMatch(/^\s*$/);
  return text + tail;
};

// Why: the whole contract on real Graph output: positions that tile the file, identifier names
// that see a type position and JSX, and import statements as the fixture declares them.
test.skipIf(!process.env.NEUVE_GRAPH_OUTLINE_EXECUTABLE)(
  "the real engine's tokens rebuild TypeScript and Go files and name their imports",
  async () => {
    const executable = process.env.NEUVE_GRAPH_OUTLINE_EXECUTABLE;
    if (!executable) throw new Error("Graph executable required");
    const root = await mkdtemp(join(tmpdir(), "tokens-real-"));
    roots.push(root);
    const tsx = [
      'import "./polyfill";',
      'import type { Props } from "./props";',
      'import React, { useState as useLocal, type FC } from "react";',
      'import * as path from "node:path";',
      'import { Button } from "./button";',
      "// a comment",
      "export const Panel: FC = (props: Props, extra: OnlyAsType) => {",
      "  const [open] = useLocal(false);",
      "  return <Button label={`a ${path.sep}",
      "  b`} open={open}><OnlyInJsx /></Button>;",
      "};",
      "",
    ].join("\n");
    const go = [
      "package main",
      "",
      "import (",
      '\t"fmt"',
      '\t_ "embed"',
      '\t. "strings"',
      '\talias "os"',
      ")",
      "",
      'func main() { fmt.Println(alias.Args, ToUpper("x")) }',
      "",
    ].join("\n");
    const tsxBytes = encoder.encode(tsx);
    const goBytes = encoder.encode(go);
    // A file over the engine's 512 KiB tokens limit, and a language it does not declare.
    const large = encoder.encode(
      "// filler line\n".repeat(40_000) + "export const last = 1;\n",
    );
    const files = [
      { path: "src/panel.tsx", bytes: tsxBytes },
      { path: "cmd/main.go", bytes: goBytes },
      { path: "src/large.ts", bytes: large },
      { path: "scripts/x.lua", bytes: encoder.encode("local x = 1\n") },
      {
        path: "src/directives.ts",
        bytes: encoder.encode(
          "// @ts-expect-error a reason\n// This loop retries.\nconst a: number = f();\n",
        ),
      },
    ];
    const result = await readGraphSymbols({
      executable,
      temporaryParent: root,
      cacheDirectory: join(root, "cache"),
      files,
      tokens: true,
    });
    const panel = result.files.get("src/panel.tsx")?.tokens;
    const main = result.files.get("cmd/main.go")?.tokens;
    if (panel?.status !== "available" || main?.status !== "available")
      throw new Error("no tokens");
    expect(rebuild(tsxBytes, panel)).toBe(tsx);
    expect(rebuild(goBytes, main)).toBe(go);
    // `OnlyAsType` occurs once, in a type position, and `OnlyInJsx` once, as a JSX element; neither
    // is imported or declared, so only those leaves can put them in the names.
    expect(panel.identifierNames).toEqual(
      expect.arrayContaining(["OnlyAsType", "OnlyInJsx", "Props", "Button"]),
    );
    const identifierLines = (name: string) =>
      panel.leaves
        .map((_, at) => at)
        .filter(
          (at) =>
            graphLeafFlags(panel, at).identifier &&
            new TextDecoder().decode(
              tsxBytes.subarray(
                graphLeafPosition(panel, at).startByte,
                graphLeafPosition(panel, at).endByte,
              ),
            ) === name,
        )
        .map((at) => graphLeafPosition(panel, at).startLine);
    expect(identifierLines("OnlyAsType")).toEqual([7]);
    expect(identifierLines("OnlyInJsx")).toEqual([10]);
    const comments = panel.leaves
      .map((_, at) => at)
      .filter((at) => graphLeafFlags(panel, at).comment);
    expect(
      comments.map((at) => graphLeafPosition(panel, at).startLine),
    ).toEqual([6]);
    // The template string's text runs from line 9 into line 10; the range of line 10 takes it.
    const line10 = graphLeavesTouchingLines(panel, 10, 10);
    expect(graphLeafPosition(panel, line10.from)).toMatchObject({
      startLine: 9,
      endLine: 10,
    });
    // Each statement's bytes are the statement itself, and its leaves lie inside it.
    const statementText = (tokens: typeof panel, bytes: Uint8Array) =>
      tokens.imports.status === "extracted"
        ? tokens.imports.statements.map((statement) =>
            new TextDecoder().decode(
              bytes.subarray(statement.startByte, statement.endByte),
            ),
          )
        : [];
    expect(statementText(panel, tsxBytes)).toEqual(tsx.split("\n").slice(0, 5));
    expect(statementText(main, goBytes)).toEqual([
      '"fmt"',
      '_ "embed"',
      '. "strings"',
      'alias "os"',
    ]);
    const firstImportLeaf = panel.leaves.findIndex(
      (_, at) => graphLeafPosition(panel, at).startLine === 3,
    );
    expect(
      graphImportStatementsAt(panel, firstImportLeaf).map(
        (statement) => statement.specifier,
      ),
    ).toEqual(["react"]);
    const commentLeaf = panel.leaves.findIndex(
      (_, at) => graphLeafFlags(panel, at).comment,
    );
    expect(graphImportStatementsAt(panel, commentLeaf)).toEqual([]);
    const withoutBytes = (imports: typeof panel.imports) =>
      imports.status === "extracted"
        ? {
            ...imports,
            statements: imports.statements.map(
              ({ startByte: _start, endByte: _end, ...rest }) => rest,
            ),
          }
        : imports;
    expect(withoutBytes(panel.imports)).toEqual({
      status: "extracted",
      statements: [
        {
          startLine: 1,
          endLine: 1,
          specifier: "./polyfill",
          bindings: [],
          sideEffectOnly: true,
          namesUnknown: false,
        },
        {
          startLine: 2,
          endLine: 2,
          specifier: "./props",
          bindings: [
            {
              imported: "Props",
              local: "Props",
              typeOnly: true,
              localInferred: false,
            },
          ],
          sideEffectOnly: false,
          namesUnknown: false,
        },
        {
          startLine: 3,
          endLine: 3,
          specifier: "react",
          bindings: [
            {
              imported: "default",
              local: "React",
              typeOnly: false,
              localInferred: false,
            },
            {
              imported: "useState",
              local: "useLocal",
              typeOnly: false,
              localInferred: false,
            },
            {
              imported: "FC",
              local: "FC",
              typeOnly: true,
              localInferred: false,
            },
          ],
          sideEffectOnly: false,
          namesUnknown: false,
        },
        {
          startLine: 4,
          endLine: 4,
          specifier: "node:path",
          bindings: [
            {
              imported: "*",
              local: "path",
              typeOnly: false,
              localInferred: false,
            },
          ],
          sideEffectOnly: false,
          namesUnknown: false,
        },
        {
          startLine: 5,
          endLine: 5,
          specifier: "./button",
          bindings: [
            {
              imported: "Button",
              local: "Button",
              typeOnly: false,
              localInferred: false,
            },
          ],
          sideEffectOnly: false,
          namesUnknown: false,
        },
      ],
    });
    expect(withoutBytes(main.imports)).toEqual({
      status: "extracted",
      statements: [
        {
          startLine: 4,
          endLine: 4,
          specifier: "fmt",
          bindings: [
            {
              imported: "*",
              local: "fmt",
              typeOnly: false,
              localInferred: true,
            },
          ],
          sideEffectOnly: false,
          namesUnknown: false,
        },
        {
          startLine: 5,
          endLine: 5,
          specifier: "embed",
          bindings: [],
          sideEffectOnly: true,
          namesUnknown: false,
        },
        {
          startLine: 6,
          endLine: 6,
          specifier: "strings",
          bindings: [],
          sideEffectOnly: false,
          namesUnknown: true,
        },
        {
          startLine: 7,
          endLine: 7,
          specifier: "os",
          bindings: [
            {
              imported: "*",
              local: "alias",
              typeOnly: false,
              localInferred: false,
            },
          ],
          sideEffectOnly: false,
          namesUnknown: false,
        },
      ],
    });
    expect(result.files.get("src/large.ts")?.outline).not.toBeNull();
    expect(result.files.get("src/large.ts")?.tokens).toEqual({
      status: "unavailable",
      reason: "tokens-size-limit",
      retryable: false,
      codes: [],
    });
    expect(result.files.get("scripts/x.lua")?.outline).not.toBeNull();
    expect(result.files.get("scripts/x.lua")?.tokens).toMatchObject({
      reason: "unsupported-language",
      retryable: false,
    });
    expect(result.tokenCoverage?.languages).not.toContain("Lua");
    // A comment a tool obeys is a directive; a prose comment is not.
    expect(result.tokenCoverage?.directiveLanguages).toContain("TypeScript");
    const directives = result.files.get("src/directives.ts")?.tokens;
    if (directives?.status !== "available") throw new Error("no tokens");
    expect(directives.directivesFlagged).toBe(true);
    const commentFlags = directives.leaves
      .map((_, at) => graphLeafFlags(directives, at))
      .filter((flags) => flags.comment)
      .map((flags) => flags.directive);
    expect(commentFlags).toEqual([true, false]);
    expect(SymbolObservation.parse(result)).toEqual(result);
    expect(await readdir(root)).toEqual(["cache"]);
  },
  60_000,
);

// Why: the consumer's "layout only" rule must be decidable through these accessors alone. This
// applies it once, here and nowhere in the library: leaves equal as before, every gap between
// compared leaves of one kind on both sides, a gap that is not plain on either side byte-identical,
// and the gaps around each directive comment byte-identical.
test.skipIf(!process.env.NEUVE_GRAPH_OUTLINE_EXECUTABLE)(
  "the real engine's leaves and gaps decide layout-only pairs through the accessors alone",
  async () => {
    const executable = process.env.NEUVE_GRAPH_OUTLINE_EXECUTABLE;
    if (!executable) throw new Error("Graph executable required");
    const root = await mkdtemp(join(tmpdir(), "tokens-layout-"));
    roots.push(root);
    const pairs: readonly (readonly [
      name: string,
      extension: string,
      base: string,
      head: string,
      changes: boolean,
    ])[] = [
      [
        "go-generate-indented",
        "go",
        "package main\n\n//go:generate x\nfunc main() {}\n",
        "package main\n\n\t//go:generate x\nfunc main() {}\n",
        true,
      ],
      [
        "cgo-preamble-spaced",
        "go",
        'package main\n\n// #include <stdio.h>\nimport "C"\n\nfunc main() {}\n',
        'package main\n\n// #include <stdio.h>\n\nimport "C"\n\nfunc main() {}\n',
        true,
      ],
      [
        "abstract-wrapped",
        "ts",
        "abstract class A {}\n",
        "abstract\nclass A {}\n",
        true,
      ],
      [
        "async-wrapped",
        "ts",
        "const f = async (x) => x;\n",
        "const f = async\n(x) => x;\n",
        true,
      ],
      [
        "python-tab",
        "py",
        "if a:\n        b()\n        c()\n",
        "if a:\n        b()\n\tc()\n",
        true,
      ],
      [
        "shebang-moved",
        "py",
        "#!/usr/bin/env python\nprint(1)\n",
        " #!/usr/bin/env python\nprint(1)\n",
        true,
      ],
      [
        "reindented-block",
        "ts",
        "if (a) {\n  b();\n}\n",
        "if (a) {\n    b();\n}\n",
        false,
      ],
      [
        "trailing-spaces",
        "ts",
        "const a = 1;  \nconst b = 2;\n",
        "const a = 1;\nconst b = 2;\n",
        false,
      ],
      [
        "blank-line-added",
        "ts",
        "const a = 1;\nconst b = 2;\n",
        "const a = 1;\n\nconst b = 2;\n",
        false,
      ],
      // A line break inside a left-out block comment ends the statement: tsc parses two, and the
      // Go version does not compile. Its bytes are in no gap, so the stretch must scan them.
      [
        "ts-return-comment-line-break",
        "ts",
        "function f(){ return /* see the note below */ 1; }\n",
        "function f(){ return /* see the note\nbelow */ 1; }\n",
        true,
      ],
      [
        "go-return-comment-line-break",
        "go",
        "package main\n\nfunc f() int {\n\treturn /* see the note below */ 1\n}\n",
        "package main\n\nfunc f() int {\n\treturn /* see the note\nbelow */ 1\n}\n",
        true,
      ],
    ];
    // A dedent CPython rejects (`y()` indented by two spaces after a block of four) that the
    // tree accepts: checked apart, below, since only the declaration lets a consumer refuse it.
    const dedent = {
      base: "if a:\n    x()\ny()\n",
      head: "if a:\n    x()\n  y()\n",
    };
    const files = [
      ...pairs.flatMap(([name, extension, base, head]) => [
        { path: `${name}/base.${extension}`, bytes: encoder.encode(base) },
        { path: `${name}/head.${extension}`, bytes: encoder.encode(head) },
      ]),
      { path: "python-dedent/base.py", bytes: encoder.encode(dedent.base) },
      { path: "python-dedent/head.py", bytes: encoder.encode(dedent.head) },
    ];
    const result = await readGraphSymbols({
      executable,
      temporaryParent: root,
      cacheDirectory: join(root, "cache"),
      files,
      tokens: true,
    });
    const decoder = new TextDecoder();
    type Read = Readonly<{ tokens: GraphFileTokens; bytes: Uint8Array }>;
    const side = (path: string): Read => {
      const tokens = result.files.get(path)?.tokens;
      const bytes = files.find((file) => file.path === path)?.bytes;
      if (tokens?.status !== "available" || bytes === undefined)
        throw new Error(`no tokens for ${path}`);
      return { tokens, bytes };
    };
    /** The compared leaves: every leaf but a comment that is not a directive. */
    const compared = ({ tokens }: Read) => {
      if (tokens.status !== "available") return [];
      return tokens.leaves
        .map((_, at) => at)
        .filter((at) => {
          const flags = graphLeafFlags(tokens, at);
          return !flags.comment || flags.directive === true;
        });
    };
    const text = (bytes: Uint8Array, start: number, end: number) =>
      decoder.decode(bytes.subarray(start, end));
    /**
     * The stretch before each compared leaf, and after the last: the gaps up to it and the bytes of
     * every left-out comment between them. A line feed anywhere in it, a comment's own included,
     * makes it a line break, and a tab or carriage return anywhere makes it not plain. The bytes
     * compared for identity are the gaps'.
     */
    const gaps = (read: Read) => {
      const { tokens, bytes } = read;
      if (tokens.status !== "available") return [];
      const kept = compared(read);
      const pieces = (from: number, to: number) =>
        Array.from({ length: to - from }, (_, offset) =>
          graphGapBefore(tokens, bytes, from + offset),
        );
      const join = (parts: readonly ReturnType<typeof graphGapBefore>[]) => {
        // The whole stretch, left-out comments included: from the first gap's start to the last's end.
        const stretch = bytes.subarray(
          parts[0]?.startByte ?? 0,
          parts.at(-1)?.endByte ?? 0,
        );
        return {
          kind: stretch.includes(0x0a)
            ? "newline"
            : stretch.length > 0
              ? "inline"
              : "none",
          plain: !stretch.includes(0x09) && !stretch.includes(0x0d),
          text: parts
            .map((part) => text(bytes, part.startByte, part.endByte))
            .join("\u0000"),
        };
      };
      return [
        ...kept.map((at, index) =>
          join(pieces(index === 0 ? 0 : (kept[index - 1] ?? 0) + 1, at + 1)),
        ),
        join([
          ...pieces((kept.at(-1) ?? -1) + 1, tokens.leaves.length),
          graphGapAfterLast(tokens, bytes),
        ]),
      ];
    };
    const sameLeaves = (base: Read, head: Read): boolean => {
      const key = ({ tokens, bytes }: Read, at: number) => {
        if (tokens.status !== "available") return "";
        const position = graphLeafPosition(tokens, at);
        return [
          graphLeafType(tokens, at),
          text(bytes, position.startByte, position.endByte),
          graphLeafAncestors(tokens, at),
          graphLeafOpens(tokens, at),
        ].join("\u0000");
      };
      const left = compared(base).map((at) => key(base, at));
      const right = compared(head).map((at) => key(head, at));
      return (
        left.length === right.length &&
        left.every((value, index) => value === right[index])
      );
    };
    const changes = (base: Read, head: Read): boolean => {
      if (!sameLeaves(base, head)) return true;
      const before = gaps(base);
      const after = gaps(head);
      const directives = compared(base).map(
        (at) =>
          base.tokens.status === "available" &&
          graphLeafFlags(base.tokens, at).directive === true,
      );
      return before.some((gap, index) => {
        const other = after[index];
        if (other === undefined || gap.kind !== other.kind) return true;
        if ((!gap.plain || !other.plain) && gap.text !== other.text)
          return true;
        // Around a directive: the gap before it and the gap after it.
        const aroundDirective =
          directives[index] === true || directives[index - 1] === true;
        return aroundDirective && gap.text !== other.text;
      });
    };
    const read = pairs.map(
      ([name, extension]) =>
        [
          name,
          side(`${name}/base.${extension}`),
          side(`${name}/head.${extension}`),
        ] as const,
    );
    // Every pair has equal leaves, so each verdict below is the gaps' alone.
    expect(
      read
        .filter(([, base, head]) => !sameLeaves(base, head))
        .map(([name]) => name),
    ).toEqual([]);
    const verdicts = read.map(([name, base, head], index) => [
      name,
      changes(base, head),
      pairs[index]?.[4],
    ]);
    expect(verdicts.filter(([, got, expected]) => got !== expected)).toEqual(
      [],
    );
    // The tree accepts the bad dedent: equal leaves and gaps of the same kinds, so the gap rule
    // alone reads no change. The tokens value says Python is indentation-significant, which is
    // what lets a consumer refuse to call a change of leading whitespace layout there.
    const dedentBase = side("python-dedent/base.py");
    const dedentHead = side("python-dedent/head.py");
    expect(sameLeaves(dedentBase, dedentHead)).toBe(true);
    expect(gaps(dedentBase).map((gap) => gap.kind)).toEqual(
      gaps(dedentHead).map((gap) => gap.kind),
    );
    expect(changes(dedentBase, dedentHead)).toBe(false);
    expect(dedentHead.tokens).toMatchObject({ indentationSignificant: true });
    expect(result.tokenCoverage?.indentationSignificantLanguages).toEqual([
      "Python",
    ]);
    expect(side("reindented-block/head.ts").tokens).toMatchObject({
      indentationSignificant: false,
    });
  },
  60_000,
);
