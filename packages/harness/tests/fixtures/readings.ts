import { sha256Hex } from "@neuve/records-core";
import type { Lane } from "@neuve/records-schema";
import type { Suggestion } from "../../src/declarations.ts";
import { hunkContentKey } from "../../src/hunks.ts";
import type { ManifestHunk } from "../../src/manifest.ts";
import {
  computeBlobStructure,
  noStructure,
  type BlobStructure,
} from "../../src/sections.ts";
import type { AssessJudgement } from "../../src/readings/answers.ts";
import type {
  Claim,
  DecideInput,
  ExcludedReason,
  NotJudgedCause,
} from "../../src/readings/decide.ts";
import type { NamedProof } from "../../src/proof-state.ts";
import type { Move } from "../../src/lane-rule.ts";

export const LANES: ReadonlyArray<Lane> = [
  "static-automation",
  "agentic",
  "human-suggested",
  "human-required",
];

const factor = {
  factor: "connections",
  finding: "Called from two places.",
  cites: ["a.ts:new:3-4"],
  uncited: false,
};

const requirement = (proof: ReadonlyArray<string>) => ({
  requirement: "Parsing an empty list returns no rows.",
  cites: ["a.ts:new:3-4"],
  proof,
  kinds: ["test-run", "static-analysis"] as const,
  agree: true,
  testable: true,
  untested: "",
  anchors: [{ path: "a.ts", side: "new", startLine: 3, endLine: 4 } as const],
});

/** Two current kinds that agree with a test run: Proven, so a low, easy section is static automation. */
export const RECORDS: ReadonlyMap<string, NamedProof> = new Map([
  ["p1", { kind: "test-run", currency: "current" }],
  ["p2", { kind: "static-analysis", currency: "current" }],
]);

/** An Assess judgement that rule 3 places in the given lane, for a section with relations shown. */
export const judgementFor = (lane: Lane): AssessJudgement => {
  const [complexity, ease, proof] = (
    {
      "static-automation": ["low", "easy", ["p1", "p2"]],
      agentic: ["low", "easy", []],
      "human-suggested": ["low", "hard", []],
      "human-required": ["high", "hard", []],
    } as const
  )[lane];
  return {
    complexity: { level: complexity, factors: [factor] },
    codeFactors: [],
    easeOfValidation: { level: ease, requirements: [requirement(proof)] },
    movement: [],
    lean: null,
    gaps: [],
    impact: [],
  };
};

export const inputFor = (options: {
  readonly lane?: Lane;
  readonly assess?: "judged" | NotJudgedCause;
  readonly review?: "approve" | "request-changes" | "unsure" | NotJudgedCause;
  readonly claims?: ReadonlyArray<Pick<Claim, "source" | "verify">>;
  readonly cap?: boolean;
  readonly relations?: boolean;
  readonly boundaries?: "structure" | "fallback";
  readonly removal?: boolean;
  readonly excluded?: ExcludedReason;
  /** The declaration or rule that fired, carried with `excluded`. */
  readonly excludedBy?: string;
  /** The moves the section's kept findings give; none by default. */
  readonly moves?: ReadonlyArray<Move>;
}): DecideInput => {
  const assess = options.assess ?? "judged";
  const review = options.review ?? "approve";
  return {
    ...(options.excluded === undefined
      ? {}
      : {
          excluded: {
            reason: options.excluded,
            ...(options.excludedBy === undefined
              ? {}
              : { by: options.excludedBy }),
          },
        }),
    section: {
      key: "section-a",
      path: "a.ts",
      declared: null,
      boundaries: options.boundaries ?? "structure",
      relations: options.relations ?? true,
      added: [{ path: "a.ts", line: 3, text: "const rows = [];" }],
      floorFacts: {
        removesDeclaration: options.removal ?? false,
        removesPublicName: false,
        effects: [],
      },
      moves: options.moves ?? [],
      facts: { opaque: true },
    },
    assess:
      assess === "judged"
        ? { judged: true, judgement: judgementFor(options.lane ?? "agentic") }
        : { judged: false, cause: assess },
    review:
      review === "approve" ||
      review === "request-changes" ||
      review === "unsure"
        ? { judged: true, judgement: { verdict: review } }
        : { judged: false, cause: review },
    claims: (options.claims ?? []).map((claim, i) => ({
      id: `claim-${i}`,
      ...claim,
    })),
    proof: { records: RECORDS, sources: [] },
    options: {
      floors: { removal: options.removal ?? false },
      capReached: options.cap ?? false,
    },
  };
};

// ---------------------------------------------------------------------------------------------
// Ranges for the reading plan and its readings
// ---------------------------------------------------------------------------------------------

export const oidOf = (text: string) => sha256Hex(`blob\0${text}`).slice(0, 40);

const lineRuns = (lines: ReadonlyArray<number>, side: "old" | "new") => {
  const out: Array<{
    side: "old" | "new";
    startLine: number;
    lineCount: number;
  }> = [];
  for (const line of lines) {
    const last = out.at(-1);
    if (last !== undefined && last.startLine + last.lineCount === line)
      last.lineCount++;
    else out.push({ side, startLine: line, lineCount: 1 });
  }
  return out;
};

const hunkBase = (path: string, text: string) => ({
  hunkId: `h${sha256Hex(`${path}\0${text}`).slice(0, 15)}`,
  textSha256: sha256Hex(text),
  enclosing: null,
  query: null,
  qualifications: [],
  countsTowardReviewLines: true,
  allowance: { tokens: 4_000, exactShare: 0, floored: true },
  leads: null,
});

/**
 * Hunks as Git prints them (one line of context, or `context` lines: Git's default is three), from
 * a line diff of two texts, with the owned ranges the review rules give: each side's runs of changed
 * lines.
 */
export const diff = (
  path: string,
  before: string,
  after: string,
  options: {
    readonly status?: ManifestHunk["status"];
    readonly oldPath?: string;
    readonly declared?: ReadonlyArray<Suggestion>;
    readonly context?: number;
  } = {},
): Array<ManifestHunk> => {
  const context = options.context ?? 1;
  const a = before.split("\n").slice(0, -1);
  const b = after.split("\n").slice(0, -1);
  const lcs = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lcs[i]![j] =
        a[i] === b[j]
          ? lcs[i + 1]![j + 1]! + 1
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const ops: Array<{
    sign: " " | "-" | "+";
    text: string;
    old: number;
    new: number;
  }> = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j])
      ops.push({ sign: " ", text: a[i]!, old: ++i, new: ++j });
    else if (
      j >= b.length ||
      (i < a.length && lcs[i + 1]![j]! >= lcs[i]![j + 1]!)
    )
      ops.push({ sign: "-", text: a[i]!, old: ++i, new: j });
    else ops.push({ sign: "+", text: b[j]!, old: i, new: ++j });
  }
  const changed = ops.flatMap((op, index) => (op.sign === " " ? [] : [index]));
  const groups: Array<[number, number]> = [];
  for (const index of changed) {
    const last = groups.at(-1);
    // Two changes join one hunk when their context rows would meet, as Git joins them.
    if (last !== undefined && index - last[1] <= 2 * context + 1)
      last[1] = index;
    else groups.push([index, index]);
  }
  return groups.map(([from, to]) => {
    const rows = ops.slice(
      Math.max(0, from - context),
      Math.min(ops.length, to + 1 + context),
    );
    const oldRows = rows.filter((row) => row.sign !== "+");
    const newRows = rows.filter((row) => row.sign !== "-");
    const oldStart = oldRows[0]?.old ?? rows[0]!.old;
    const newStart = newRows[0]?.new ?? rows[0]!.new;
    const text = `@@ -${oldStart},${oldRows.length} +${newStart},${newRows.length} @@\n${rows
      .map((row) => `${row.sign}${row.text}`)
      .join("\n")}\n`;
    return {
      ...hunkBase(path, text),
      contentKey: hunkContentKey({ path, text }),
      kind: "text",
      path,
      oldPath: options.oldPath ?? path,
      newPath: path,
      oldOid: oidOf(before),
      newOid: oidOf(after),
      status: options.status ?? "modified",
      oldMode: "100644",
      newMode: "100644",
      oldStart,
      oldLines: oldRows.length,
      newStart,
      newLines: newRows.length,
      added: rows.filter((row) => row.sign === "+").length,
      deleted: rows.filter((row) => row.sign === "-").length,
      text,
      ownedRanges: [
        ...lineRuns(
          rows.filter((r) => r.sign === "-").map((r) => r.old),
          "old",
        ),
        ...lineRuns(
          rows.filter((r) => r.sign === "+").map((r) => r.new),
          "new",
        ),
      ],
      declared: [...(options.declared ?? [])],
    } satisfies ManifestHunk;
  });
};

/** A file change with no text hunk: a binary file, or a mode-only change. */
export const nontext = (
  path: string,
  kind: "binary" | "metadata",
): ManifestHunk => {
  const text =
    kind === "binary" ? `Binary files differ: ${path}` : `mode change: ${path}`;
  return {
    ...hunkBase(path, text),
    kind,
    path,
    oldPath: path,
    newPath: path,
    oldOid: oidOf(`${path} before`),
    newOid:
      kind === "binary" ? oidOf(`${path} after`) : oidOf(`${path} before`),
    status: "modified",
    oldMode: "100644",
    newMode: kind === "binary" ? "100644" : "100755",
    oldStart: 0,
    oldLines: 0,
    newStart: 0,
    newLines: 0,
    added: 0,
    deleted: 0,
    text,
    ownedRanges: [],
    declared: [],
  };
};

/** A Graph-like structure from declared spans, each with its symbol, as the stored structure has it. */
export const symbolStructure = (
  text: string,
  spans: ReadonlyArray<{
    readonly start: number;
    readonly end: number;
    readonly kind: "imports" | "declaration";
    readonly name?: string;
    readonly signature?: string;
    readonly symbol?: string;
    readonly members?: ReadonlyArray<string>;
  }>,
): BlobStructure => {
  const lines = text.split("\n").slice(0, -1);
  return {
    capability: "graph-symbols",
    language: "typescript",
    lines: lines.length,
    reason: null,
    spans: spans.map((span) => {
      const body = lines.slice(span.start - 1, span.end).join("\n");
      return {
        start: span.start,
        end: span.end,
        kind: span.kind,
        name: span.name ?? null,
        nodeType:
          span.kind === "imports" ? "import_statement" : "function_declaration",
        textSha256: sha256Hex(body),
        characters: body.length,
        lines: span.end - span.start + 1,
        symbols:
          span.name === undefined
            ? []
            : [
                {
                  name: span.name,
                  kind: span.symbol ?? "function",
                  qualifiedName: span.name,
                  signature: span.signature ?? null,
                  container: null,
                  startLine: span.start,
                  endLine: span.end,
                },
                ...(span.members ?? []).map((member, at) => ({
                  name: member,
                  kind: "method",
                  qualifiedName: `${span.name}.${member}`,
                  signature: null,
                  container: span.name!,
                  startLine: span.start + at + 1,
                  endLine: span.start + at + 1,
                })),
              ],
      };
    }),
  };
};

export const PARSE_BEFORE = `import { split } from "./split";

function helper(x: number) {
  return x + 1;
}

export function parse(text: string) {
  return split(text);
}
`;
export const PARSE_AFTER = `import { split } from "./split";

function helper(x: number) {
  return x + 2;
}

export function parse(text: string) {
  return split(text);
}

export function count(text: string) {
  return parse(text).length;
}
`;
export const OLD_BEFORE = `export function keep() {
  return 1;
}
export function drop() {
  return 2;
}
`;
export const OLD_AFTER = `export function keep() {
  return 1;
}
`;
export const NOTES_BEFORE = "one\ntwo\nthree\nfour\nfive\n";
export const NOTES_AFTER = "one\ntwo\nthree\nfour changed\nfive\n";
export const TEST_BEFORE = `it("parses", () => {
  expect(parse("a")).toEqual(["a"]);
});
`;
export const TEST_AFTER = `it("parses", () => {
  expect(parse("a")).toEqual(["a"]);
});
it("counts", () => {
  expect(count("a,b")).toBe(2);
});
`;
export const DOC_BEFORE =
  "# Guide\n\nRead the parser.\n\n# Usage\n\nCall parse.\n";
export const DOC_AFTER =
  "# Guide\n\nRead the parser.\n\n# Usage\n\nCall parse, then count.\n";
const BIG_AFTER =
  Array.from(
    { length: 1_800 },
    (_, at) => `row ${String(at).padStart(4, "0")} ${"x".repeat(90)}`,
  ).join("\n") + "\n";

/** One function of the realistic file: eight lines, its signature on its first. */
const realisticFunction = (n: number, edit: "same" | "body" | "signature") =>
  [
    edit === "signature"
      ? `export function f${n}(input: string, limit: number, strict = false): string {`
      : `export function f${n}(input: string, limit: number): string {`,
    `  const trimmed = input.trim();`,
    `  if (trimmed.length > limit) {`,
    `    return trimmed.slice(0, limit);`,
    `  }`,
    edit === "body"
      ? `  return trimmed.toLowerCase(); // f${n}`
      : `  return trimmed.toUpperCase(); // f${n}`,
    `}`,
    ``,
  ].join("\n");

/**
 * A realistic change for the reading's size: one TypeScript file of eight functions, its hunks as
 * Git prints them (three lines of context), where six bodies change one line each, one signature
 * changes, and one function is removed whole. Each function is its own section.
 */
export const realisticRange = () => {
  const edits: ReadonlyArray<"same" | "body" | "signature"> = [
    "body",
    "body",
    "signature",
    "body",
    "body",
    "same",
    "body",
    "body",
  ];
  const before =
    edits.map((_, at) => realisticFunction(at + 1, "same")).join("\n") + "\n";
  const after =
    edits
      .map((edit, at) => realisticFunction(at + 1, edit))
      // The sixth function is removed whole.
      .filter((_, at) => at !== 5)
      .join("\n") + "\n";
  const spans = (text: string) =>
    symbolStructure(
      text,
      text
        .split("\n")
        .flatMap((line, at) => {
          const name = /^export function (f\d+)\(/.exec(line)?.[1];
          return name === undefined
            ? []
            : [{ name, start: at + 1, signature: line.slice(0, -2) }];
        })
        .map((span) => ({
          start: span.start,
          end: span.start + 6,
          kind: "declaration" as const,
          name: span.name,
          signature: span.signature,
        })),
    );
  const hunks = diff("src/strings.ts", before, after, { context: 3 });
  const structures = new Map<string, BlobStructure>([
    [oidOf(before), spans(before)],
    [oidOf(after), spans(after)],
  ]);
  return { hunks, structures, before, after };
};

/** A range with every kind of section the plan must account for, and its stored structures. */
export const mixedRange = (
  options: {
    readonly parseAfter?: string;
    readonly edit?: (path: string, structure: BlobStructure) => BlobStructure;
  } = {},
) => {
  const parseAfter = options.parseAfter ?? PARSE_AFTER;
  const generated: ReadonlyArray<Suggestion> = [
    { kind: "generated", by: "gitattributes: linguist-generated=true" },
  ];
  const hunks: Array<ManifestHunk> = [
    // Replacements in one declaration, and an addition that exports a name.
    ...diff("src/parse.ts", PARSE_BEFORE, parseAfter),
    // A pure removal of a declaration.
    ...diff("src/old.ts", OLD_BEFORE, OLD_AFTER),
    // A test, declared.
    ...diff("src/parse.test.ts", TEST_BEFORE, TEST_AFTER, {
      declared: [{ kind: "test", by: "package-scripts-bun-test" }],
    }),
    // A file no capability structures.
    ...diff("notes.txt", NOTES_BEFORE, NOTES_AFTER),
    // A rename with a change, declared documentation.
    ...diff("docs/guide.md", DOC_BEFORE, DOC_AFTER, {
      status: "renamed",
      oldPath: "docs/old-guide.md",
      declared: [{ kind: "doc", by: "fixture" }],
    }),
    // A declared-generated file and a lockfile: the map excludes both.
    ...diff(
      "src/gen/api.ts",
      "export const a = 1;\n",
      "export const a = 2;\n",
      {
        declared: generated,
      },
    ),
    ...diff("bun.lock", "{ a: 1 }\n", "{ a: 2 }\n"),
    // A binary file and a mode-only change.
    nontext("assets/logo.png", "binary"),
    nontext("scripts/run.sh", "metadata"),
    // A section too large to be read whole.
    ...diff("data/big.txt", "", BIG_AFTER),
  ];
  const edit =
    options.edit ?? ((_path: string, structure: BlobStructure) => structure);
  const markdown = (path: string, text: string) =>
    computeBlobStructure(path, text, { kind: "unavailable" }).structure;
  const none = noStructure("unsupported-language", null, 0);
  const structures = new Map<string, BlobStructure>([
    [
      oidOf(PARSE_BEFORE),
      edit(
        "src/parse.ts",
        symbolStructure(PARSE_BEFORE, [
          { start: 1, end: 2, kind: "imports" },
          {
            start: 3,
            end: 6,
            kind: "declaration",
            name: "helper",
            signature: "function helper(x: number)",
          },
          {
            start: 7,
            end: 9,
            kind: "declaration",
            name: "parse",
            signature: "export function parse(text: string)",
          },
        ]),
      ),
    ],
    [
      oidOf(parseAfter),
      edit(
        "src/parse.ts",
        symbolStructure(parseAfter, [
          { start: 1, end: 2, kind: "imports" },
          {
            start: 3,
            end: 6,
            kind: "declaration",
            name: "helper",
            signature: "function helper(x: number)",
          },
          {
            start: 7,
            end: 9,
            kind: "declaration",
            name: "parse",
            signature: "export function parse(text: string)",
          },
          {
            start: 10,
            end: 13,
            kind: "declaration",
            name: "count",
            signature: "export function count(text: string)",
          },
        ]),
      ),
    ],
    [
      oidOf(OLD_BEFORE),
      symbolStructure(OLD_BEFORE, [
        {
          start: 1,
          end: 3,
          kind: "declaration",
          name: "keep",
          signature: "export function keep()",
        },
        {
          start: 4,
          end: 6,
          kind: "declaration",
          name: "drop",
          signature: "export function drop()",
        },
      ]),
    ],
    [
      oidOf(OLD_AFTER),
      symbolStructure(OLD_AFTER, [
        {
          start: 1,
          end: 3,
          kind: "declaration",
          name: "keep",
          signature: "export function keep()",
        },
      ]),
    ],
    [oidOf(TEST_BEFORE), none],
    [oidOf(TEST_AFTER), none],
    [oidOf(NOTES_BEFORE), none],
    [oidOf(NOTES_AFTER), none],
    [oidOf(DOC_BEFORE), markdown("docs/old-guide.md", DOC_BEFORE)],
    [oidOf(DOC_AFTER), markdown("docs/guide.md", DOC_AFTER)],
    [oidOf(BIG_AFTER), none],
    [oidOf(""), none],
  ]);
  const excluded = [
    { path: "src/gen/api.ts", reason: "declared-generated" as const },
    { path: "bun.lock", reason: "lockfile" as const },
  ];
  return { hunks, structures, excluded };
};

/**
 * A range for effort by risk, read one section per group (`maxItems: 1`): nine
 * functions of one undeclared source file, where the first one's signature changes (an added
 * exported line: public surface, so flagged, and the highest rank) and the other eight change one
 * body line each (neither flagged nor, but for one, in the top quarter); and a declared test file
 * that removes a declaration whole (flagged, at a test's lower rank). Ten groups, a top quarter of
 * two.
 */
export const riskRange = () => {
  const edits: ReadonlyArray<"body" | "signature"> = [
    "signature",
    ...Array.from({ length: 8 }, () => "body" as const),
  ];
  const before =
    edits.map((_, at) => realisticFunction(at + 1, "same")).join("\n") + "\n";
  const after =
    edits.map((edit, at) => realisticFunction(at + 1, edit)).join("\n") + "\n";
  const spans = (text: string) =>
    symbolStructure(
      text,
      text.split("\n").flatMap((line, at) => {
        const name = /^export function (f\d+)\(/.exec(line)?.[1];
        return name === undefined
          ? []
          : [
              {
                start: at + 1,
                end: at + 7,
                kind: "declaration" as const,
                name,
                signature: line.slice(0, -2),
              },
            ];
      }),
    );
  const hunks = [
    ...diff("src/strings.ts", before, after, { context: 3 }),
    ...diff("src/old.test.ts", OLD_BEFORE, OLD_AFTER, {
      declared: [{ kind: "test", by: "package-scripts-bun-test" }],
    }),
  ];
  const structures = new Map<string, BlobStructure>([
    [oidOf(before), spans(before)],
    [oidOf(after), spans(after)],
    [
      oidOf(OLD_BEFORE),
      symbolStructure(OLD_BEFORE, [
        { start: 1, end: 3, kind: "declaration", name: "keep" },
        { start: 4, end: 6, kind: "declaration", name: "drop" },
      ]),
    ],
    [
      oidOf(OLD_AFTER),
      symbolStructure(OLD_AFTER, [
        { start: 1, end: 3, kind: "declaration", name: "keep" },
      ]),
    ],
  ]);
  return { hunks, structures };
};

// ---------------------------------------------------------------------------------------------
// Answers in round 2e's row form, and what round 2e's code made of them
// ---------------------------------------------------------------------------------------------

/** A four-section reading of one file, with a change fact and a proof record. */
export const FOUR_SECTIONS = {
  files: [
    {
      index: 0,
      path: "src/a.ts",
      rows: [{ row: "r1", text: "Empty lists parse.", requirements: [] }],
    },
  ],
  sections: [
    {
      index: 0,
      key: "k0",
      file: 0,
      owned: [{ side: "new", startLine: 10, endLine: 20 }],
    },
    {
      index: 1,
      key: "k1",
      file: 0,
      owned: [
        { side: "new", startLine: 30, endLine: 40 },
        { side: "old", startLine: 30, endLine: 35 },
      ],
    },
    {
      index: 2,
      key: "k2",
      file: 0,
      owned: [{ side: "new", startLine: 50, endLine: 60 }],
    },
    {
      index: 3,
      key: "k3",
      file: 0,
      owned: [{ side: "new", startLine: 70, endLine: 80 }],
    },
  ],
  facts: [{ id: "f1", section: 0 }],
  proofs: [
    {
      id: "p1",
      kind: "test-run",
      requirement: "Empty lists parse.",
      currency: { "src/a.ts": "current" },
    },
  ],
} as const;

/** The tables both forms share: two factors, two requirements, one impact entry. */
export const SHARED_TABLES = {
  factors: [
    { f: "connections", t: "Two callers.", cites: ["0n12-14", "0n52"] },
    { f: "security", t: "Parses untrusted input.", cites: ["0n33"] },
  ],
  requirements: [
    {
      t: "Empty lists parse.",
      kinds: ["test-run"],
      cites: ["0n12", "0n55-58"],
      testable: true,
      untested: "",
      proof: ["p1"],
      agree: true,
    },
    {
      t: "Errors keep their message.",
      kinds: ["log"],
      cites: ["0n72"],
      testable: false,
      untested: "No error path is reachable.",
      proof: [],
      agree: false,
    },
  ],
  impact: [
    { s: 1, effect: "narrowed", t: "Accepts fewer inputs.", cites: ["0o31"] },
  ],
} as const;

/** Round 2e's Assess row form: one row per section; sections 0 and 2 share a judgement. */
export const ROW_FORM_ASSESS = {
  ...SHARED_TABLES,
  sections: [
    { s: 0, c: "l", v: "e", F: [0], R: [0], person: null, gaps: null },
    {
      s: 1,
      c: "h",
      v: "e",
      F: [0, 1],
      R: [0],
      person: { need: "no", why: "Tests cover it." },
      gaps: null,
    },
    { s: 2, c: "l", v: "e", F: [0], R: [0], person: null, gaps: null },
    {
      s: 3,
      c: "l",
      v: "h",
      F: [],
      R: [1],
      person: null,
      gaps: [
        {
          axis: "ease-of-validation",
          kind: "callers",
          t: "The caller is not shown.",
        },
      ],
    },
  ],
} as const;

/** Round 2e's Lane review row form. */
export const ROW_FORM_REVIEW = {
  files: [
    {
      f: 0,
      checked: "Read the parser and its callers.",
      rows: [{ row: "r1", status: "no-evidence", cites: [] }],
    },
  ],
  sections: [
    { s: 0, v: "r" },
    { s: 1, v: "a" },
    { s: 2, v: "a" },
    { s: 3, v: "u" },
  ],
  comments: [
    {
      s: 0,
      side: "new",
      start: 12,
      end: 13,
      kind: "defect",
      effect: null,
      t: "Returns null on an empty list.",
      cites: ["0n12"],
      fails: "An empty list throws later.",
      row: null,
    },
    {
      s: 2,
      side: "new",
      start: 51,
      end: 51,
      kind: "impact",
      effect: "changed",
      t: "Counts differently.",
      cites: [],
      fails: "",
      row: null,
    },
  ],
  unsure: [{ s: 3, t: "Could not see the caller." }],
} as const;

/**
 * What round 2e's code (commit 89dc511b, `assessExpand` and `laneReviewExpand`) made of the two
 * row-form answers over `FOUR_SECTIONS`: computed once by that code, before this round changed it,
 * and kept as data so the class form can be held to it.
 */
export const ROW_FORM_EXPANDED = {
  assess: [
    {
      section: 0,
      key: "k0",
      judgement: {
        complexity: {
          level: "low",
          factors: [
            {
              factor: "connections",
              finding: "Two callers.",
              cites: ["src/a.ts:new:12-14", "src/a.ts:new:52-52"],
              uncited: false,
            },
          ],
        },
        easeOfValidation: {
          level: "easy",
          requirements: [
            {
              requirement: "Empty lists parse.",
              cites: ["src/a.ts:new:12-12", "src/a.ts:new:55-58"],
              proof: ["p1"],
              kinds: ["test-run"],
              agree: true,
              testable: true,
              untested: "",
              anchors: [
                {
                  path: "src/a.ts",
                  side: "new",
                  startLine: 12,
                  endLine: 12,
                },
              ],
            },
          ],
        },
        movement: [],
        lean: null,
        gaps: [],
        impact: [],
      },
    },
    {
      section: 1,
      key: "k1",
      judgement: {
        complexity: {
          level: "high",
          factors: [
            {
              factor: "connections",
              finding: "Two callers.",
              cites: ["src/a.ts:new:12-14", "src/a.ts:new:52-52"],
              uncited: false,
            },
            {
              factor: "security",
              finding: "Parses untrusted input.",
              cites: ["src/a.ts:new:33-33"],
              uncited: false,
            },
          ],
        },
        easeOfValidation: {
          level: "easy",
          requirements: [
            {
              requirement: "Empty lists parse.",
              cites: ["src/a.ts:new:12-12", "src/a.ts:new:55-58"],
              proof: ["p1"],
              kinds: ["test-run"],
              agree: true,
              testable: true,
              untested: "",
              anchors: [],
            },
          ],
        },
        movement: [],
        lean: {
          lane: "agentic",
          reason: "Tests cover it.",
        },
        gaps: [],
        impact: [
          {
            effect: "narrowed",
            text: "Accepts fewer inputs.",
            cites: ["src/a.ts:old:31-31"],
          },
        ],
      },
    },
    {
      section: 2,
      key: "k2",
      judgement: {
        complexity: {
          level: "low",
          factors: [
            {
              factor: "connections",
              finding: "Two callers.",
              cites: ["src/a.ts:new:12-14", "src/a.ts:new:52-52"],
              uncited: false,
            },
          ],
        },
        easeOfValidation: {
          level: "easy",
          requirements: [
            {
              requirement: "Empty lists parse.",
              cites: ["src/a.ts:new:12-12", "src/a.ts:new:55-58"],
              proof: ["p1"],
              kinds: ["test-run"],
              agree: true,
              testable: true,
              untested: "",
              anchors: [
                {
                  path: "src/a.ts",
                  side: "new",
                  startLine: 55,
                  endLine: 58,
                },
              ],
            },
          ],
        },
        movement: [],
        lean: null,
        gaps: [],
        impact: [],
      },
    },
    {
      section: 3,
      key: "k3",
      judgement: {
        complexity: {
          level: "low",
          factors: [],
        },
        easeOfValidation: {
          level: "hard",
          requirements: [
            {
              requirement: "Errors keep their message.",
              cites: ["src/a.ts:new:72-72"],
              proof: [],
              kinds: ["log"],
              agree: false,
              testable: false,
              untested: "No error path is reachable.",
              anchors: [
                {
                  path: "src/a.ts",
                  side: "new",
                  startLine: 72,
                  endLine: 72,
                },
              ],
            },
          ],
        },
        movement: [],
        lean: null,
        gaps: [
          {
            axis: "ease-of-validation",
            kind: "callers",
            detail: "The caller is not shown.",
          },
        ],
        impact: [],
      },
    },
  ],
  review: [
    {
      section: 0,
      key: "k0",
      judgement: {
        verdict: "request-changes",
        comments: [
          {
            path: "src/a.ts",
            side: "new",
            startLine: 12,
            endLine: 13,
            kind: "defect",
            text: "Returns null on an empty list.",
            cites: ["src/a.ts:new:12-12"],
            fails: "An empty list throws later.",
            row: null,
          },
        ],
        checked: "Read the parser and its callers.",
        rows: [
          {
            row: "r1",
            status: "no-evidence",
            cites: [],
          },
        ],
        unsure: [],
      },
    },
    {
      section: 1,
      key: "k1",
      judgement: {
        verdict: "approve",
        comments: [],
        checked: "Read the parser and its callers.",
        rows: [
          {
            row: "r1",
            status: "no-evidence",
            cites: [],
          },
        ],
        unsure: [],
      },
    },
    {
      section: 2,
      key: "k2",
      judgement: {
        verdict: "approve",
        comments: [
          {
            path: "src/a.ts",
            side: "new",
            startLine: 51,
            endLine: 51,
            kind: "impact",
            effect: "changed",
            text: "Counts differently.",
            cites: [],
            fails: "",
            row: null,
          },
        ],
        checked: "Read the parser and its callers.",
        rows: [
          {
            row: "r1",
            status: "no-evidence",
            cites: [],
          },
        ],
        unsure: [],
      },
    },
    {
      section: 3,
      key: "k3",
      judgement: {
        verdict: "unsure",
        comments: [],
        checked: "Read the parser and its callers.",
        rows: [
          {
            row: "r1",
            status: "no-evidence",
            cites: [],
          },
        ],
        unsure: ["Could not see the caller."],
      },
    },
  ],
} as const;
