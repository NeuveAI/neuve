// Why: a rule judgement tells a reader what code read and found about a section, and the readers
// lane decides from it what a reading may skip. A judgement that says more than was read, or holds
// where it cannot be sure, would let a section go unread for a wrong reason. Each test names the
// result or reason it holds; every result and reason is a different thing a reader is told. Inputs
// are real Graph structures of small files (as the section facts' tests build them) and hunks as Git
// prints them; two hunks are written by hand where Git's diff slides a line and the fixture's does
// not. The stored computation runs on a small real repository built here.
import { afterAll, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Layer } from "effect";
import {
  Blobs,
  Computations,
  Store,
  storeLocationIn,
} from "@neuve/records-core";

import { CpuWork } from "../src/budget/cpu.ts";
import { Scheduler } from "../src/budget/scheduler.ts";
import { CodeWork } from "../src/code-work.ts";
import { captureOutlineSource, readOutlines } from "../src/graph-outline.ts";
import { LINGUIST_STANDARD } from "../src/linguist/index.ts";
import type { ManifestHunk } from "../src/manifest.ts";
import { computeSectionFacts } from "../src/section-facts.ts";
import {
  SectionRuleJudgement,
  linguistMarkOf,
  sectionRulesOf,
  storedSectionRules,
  type AttributeValue,
  type FileSignals,
} from "../src/section-rules.ts";
import { computeBlobStructure, type BlobStructure } from "../src/sections.ts";
import { diff, manifestHunk, oidOf } from "./section-fixtures.ts";

const UNSPECIFIED: AttributeValue = { state: "unspecified", value: null };
const SET: AttributeValue = { state: "set", value: null };
const UNSET: AttributeValue = { state: "unset", value: null };
const FALSE: AttributeValue = { state: "value", value: "false" };

/** One file's change: its texts, and hand-written hunks where the fixture's diff would not slide. */
interface FileChange {
  readonly path: string;
  readonly before: string;
  readonly after: string;
  readonly hunks?: ReadonlyArray<ManifestHunk>;
  readonly declared?: ManifestHunk["declared"];
  /** False: no structure is given for its blobs (a file no capability reads, for the generated rule). */
  readonly structured?: boolean;
}

// --- Texts read from Graph once, for every test that needs a structure of code. -------------------

const BLANK_BASE = `function a() {
}

console.log(\`one

two\`);
`;
/** A function inserted before the statement: the fixture's diff gives its blank line to the statement. */
const BLANK_HEAD = `function a() {
}

function c() {
}

console.log(\`one

two\`);
`;

const NAMED_BASE = `export function a() {
  return 1;
}

export function b() {
  return 2;
}
`;
const NAMED_HEAD = `export function a() {
  return 1;
}

export function c() {
  return 3;
}

export function b() {
  return 2;
}
`;

const SLIDE_BASE = `export function a() {
  return 1;
}
export function b() {
  return 1;
}
`;
const SLIDE_HEAD = `export function a() {
  return 1;
}
export function c() {
  return 1;
}
export function b() {
  return 1;
}
`;

const INSIDE_TEXT = `export function a() {
  const x = 1;


  return x;
}
`;

const TEMPLATE_BASE = `export function before() {
  return 1;
}

console.log(\`first

third\`);
`;
const TEMPLATE_HEAD = `export function before() {
  return 1;
}

console.log(\`first


third\`);
`;

const HELPER = `
export function helper(x: number) {
  return x * 2;
}
`;
const KEEP = `export function keep() {
  return 0;
}
`;
const PARTIAL_BASE = `export function keep() {
  return 0;
}
`;
const PARTIAL_HEAD = `export function keep() {
  return 0;
}

export function helper(x: number) {
  return x * 2;
}
`;

const CODE = [
  BLANK_BASE,
  BLANK_HEAD,
  NAMED_BASE,
  NAMED_HEAD,
  SLIDE_BASE,
  SLIDE_HEAD,
  INSIDE_TEXT,
  TEMPLATE_BASE,
  TEMPLATE_HEAD,
  KEEP,
  `${KEEP}${HELPER}`,
  HELPER,
  PARTIAL_BASE,
  PARTIAL_HEAD,
];
const outlines = await readOutlines(
  [...new Set(CODE)].map((text, index) => ({
    path: `code/${index}.ts`,
    bytes: new TextEncoder().encode(text),
  })),
  captureOutlineSource(),
);
const outlineIndex = new Map(
  [...new Set(CODE)].map((text, index) => [text, index]),
);

/** A blob's stored structure: Graph's for code (read above), the heading cut for Markdown. */
const structureOf = (path: string, text: string): BlobStructure => {
  if (path.endsWith(".md") || path.endsWith(".mdx"))
    return computeBlobStructure(path, text, { kind: "unavailable" }).structure;
  const index = outlineIndex.get(text);
  if (index === undefined)
    throw new Error(`No outline read for a text of ${path}`);
  // The outline was read under another name; the language is the suffix's, as here.
  return computeBlobStructure(path, text, outlines.context(`code/${index}.ts`))
    .structure;
};

/** A hunk written by hand, as Git prints one: `rows` are the body lines with their signs. */
const handHunk = (
  path: string,
  before: string,
  after: string,
  oldStart: number,
  newStart: number,
  rows: ReadonlyArray<string>,
) => {
  const oldCount = rows.filter((row) => !row.startsWith("+")).length;
  const newCount = rows.filter((row) => !row.startsWith("-")).length;
  return manifestHunk({
    path,
    text: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n${rows.join("\n")}\n`,
    oldStart,
    newStart,
    oldOid: oidOf(before),
    newOid: oidOf(after),
  });
};

/** The signals of a path: attributes as given, and Linguist's mark of the given bytes (none: not read). */
const signalsOf = (
  path: string,
  options: {
    readonly generated?: AttributeValue;
    readonly vendored?: AttributeValue;
    readonly bytes?: Uint8Array | "not-read";
    readonly blob?: string | null;
  } = {},
): FileSignals => {
  const bytes = options.bytes ?? new Uint8Array();
  const read = bytes !== "not-read";
  return {
    attributes: {
      "linguist-generated": options.generated ?? UNSPECIFIED,
      "linguist-vendored": options.vendored ?? UNSPECIFIED,
    },
    blob: options.blob ?? null,
    read,
    mark: linguistMarkOf(path, read ? bytes : undefined),
  };
};

/** The rule judgements of a set of file changes, with what they were computed from. */
const rulesOf = (
  changes: ReadonlyArray<FileChange>,
  options: {
    readonly signals?: Readonly<Record<string, FileSignals>>;
    /** Markdown texts withheld (not read), or given as not text. */
    readonly texts?: (map: Map<string, string | null>) => void;
  } = {},
) => {
  const hunks = changes.flatMap((change) =>
    (change.hunks ?? diff(change.path, change.before, change.after)).map(
      (hunk) => ({
        ...hunk,
        declared: change.declared ?? hunk.declared,
      }),
    ),
  );
  const structures = new Map<string, BlobStructure>();
  const texts = new Map<string, string | null>();
  for (const change of changes)
    for (const text of [change.before, change.after]) {
      if (text === "") continue;
      if (change.structured !== false)
        structures.set(oidOf(text), structureOf(change.path, text));
      if (/\.mdx?$/.test(change.path)) texts.set(oidOf(text), text);
    }
  options.texts?.(texts);
  const files = new Map(
    changes.map((change) => [
      change.path,
      options.signals?.[change.path] ??
        signalsOf(change.path, {
          bytes: new TextEncoder().encode(change.after || change.before),
        }),
    ]),
  );
  const result = computeSectionFacts(hunks, structures);
  const rules = sectionRulesOf({ result, hunks, structures, files, texts });
  return { hunks, structures, files, texts, result, rules };
};

/** The judgements of one rule, with the section name each is about. */
const judgementsOf = (
  computed: ReturnType<typeof rulesOf>,
  rule: SectionRuleJudgement["rule"],
) => {
  const nameOf = new Map(
    computed.result.sections.map((section) => [
      computed.result.identities.get(section.key)!.key,
      section.name ?? null,
    ]),
  );
  return computed.rules
    .filter((judgement) => judgement.rule === rule)
    .map((judgement) => ({
      ...judgement,
      name: nameOf.get(judgement.about.key) ?? null,
    }));
};
const outcome = (judgement: { result: string; reason: string | null }) => [
  judgement.result,
  judgement.reason,
];

// --- generated ------------------------------------------------------------------------------------

const LOCK_BEFORE = '{\n  "lockfileVersion": 1,\n  "a": 1\n}\n';
const LOCK_AFTER = '{\n  "lockfileVersion": 1,\n  "a": 2\n}\n';
const lock: FileChange = {
  path: "bun.lock",
  before: LOCK_BEFORE,
  after: LOCK_AFTER,
  structured: false,
};
const plain = (path: string, extra: Partial<FileChange> = {}): FileChange => ({
  path,
  before: "one\ntwo\n",
  after: "one\nthree\n",
  structured: false,
  ...extra,
});
const generatedOf = (change: FileChange, signals?: FileSignals) => {
  const found = judgementsOf(
    rulesOf(
      [change],
      signals === undefined ? {} : { signals: { [change.path]: signals } },
    ),
    "generated",
  );
  return found;
};

test("a Linguist generated rule holds by the standard when the repository declares nothing (holds, by standard), carrying the standard as given", () => {
  const [judgement, ...rest] = generatedOf(lock);
  expect(rest).toEqual([]);
  expect(outcome(judgement!)).toEqual(["holds", null]);
  expect(judgement!.inputs.by).toBe("standard");
  expect(judgement!.inputs.lists).toEqual([
    { list: "generated", rule: "bun_lock?" },
  ]);
  expect(judgement!.inputs.standard).toEqual(
    JSON.parse(JSON.stringify(LINGUIST_STANDARD)),
  );
});

test("the repository's linguist-generated unset beats a Linguist rule, and false beats a generated header (not-held, repository-declares-not-generated: declarations win in both directions)", () => {
  const unset = generatedOf(
    lock,
    signalsOf("bun.lock", {
      generated: UNSET,
      bytes: new TextEncoder().encode(LOCK_AFTER),
    }),
  );
  expect(unset.map(outcome)).toEqual([
    ["not-held", "repository-declares-not-generated"],
  ]);
  const header = generatedOf(
    plain("src/gen.ts", {
      declared: [
        {
          kind: "generated",
          by: 'generated-marker: "@generated" in its first 1024 bytes',
        },
      ],
    }),
    signalsOf("src/gen.ts", { generated: FALSE }),
  );
  expect(header.map(outcome)).toEqual([
    ["not-held", "repository-declares-not-generated"],
  ]);
  expect(header[0]!.statement).toContain("generated-marker");
});

test("an attribute is read as Linguist reads it: set or any string but false marks the file by declaration, unset or false turns it off, unspecified leaves it to the rest", () => {
  // Linguist v9.7.0 `lazy_blob.rb`: when not nil, `attribute != "false" && attribute != false`.
  const path = "src/plain.ts";
  const value = (literal: string): AttributeValue => ({
    state: "value",
    value: literal,
  });
  const cases: ReadonlyArray<[AttributeValue, Array<Array<string | null>>]> = [
    [value("true"), [["holds", null]]],
    [value("maybe"), [["holds", null]]],
    [value("0"), [["holds", null]]],
    [value(""), [["holds", null]]],
    [SET, [["holds", null]]],
    [FALSE, [["not-held", "repository-declares-not-generated"]]],
    [UNSET, [["not-held", "repository-declares-not-generated"]]],
    [UNSPECIFIED, []],
  ];
  for (const [generated, expected] of cases) {
    const found = generatedOf(plain(path), signalsOf(path, { generated }));
    expect(found.map(outcome)).toEqual(expected);
    if (found[0]?.result === "holds")
      expect(found[0].inputs.readers).toEqual([
        `gitattributes: linguist-generated=${generated.state === "value" ? generated.value : generated.state}`,
      ]);
  }
  const maybe = generatedOf(
    plain(path),
    signalsOf(path, { vendored: value("maybe") }),
  );
  expect(maybe.map(outcome)).toEqual([["holds", null]]);
  expect(
    (maybe[0]!.inputs.attributes as Record<string, unknown>)[
      "linguist-vendored"
    ],
  ).toEqual({ ...value("maybe"), read: "value" });
});

test("linguist-generated set holds with nothing else true, and linguist-vendored set holds as a declaration (holds, by declaration)", () => {
  const set = generatedOf(
    plain("src/plain.ts"),
    signalsOf("src/plain.ts", { generated: SET }),
  );
  expect(set.map(outcome)).toEqual([["holds", null]]);
  expect(set[0]!.inputs.by).toBe("declaration");
  expect(set[0]!.inputs.readers).toEqual([
    "gitattributes: linguist-generated=set",
  ]);
  const vendored = generatedOf(
    plain("src/plain.ts"),
    signalsOf("src/plain.ts", { vendored: SET }),
  );
  expect(vendored.map(outcome)).toEqual([["holds", null]]);
  expect(vendored[0]!.inputs.readers).toEqual([
    "gitattributes: linguist-vendored=set",
  ]);
});

// The owner's ruling and the amendment's "declarations win in both directions", per list: both of
// Linguist's lists mark, and each list's attribute turns that list's marks off or on.
test("a path only the vendored list marks holds by the standard, naming the list and the pattern as Linguist wrote it; linguist-vendored unset turns it off (not-held, repository-declares-not-vendored)", () => {
  const path = "src/vendor/lib.ts";
  const alone = generatedOf(plain(path), signalsOf(path));
  expect(alone.map(outcome)).toEqual([["holds", null]]);
  expect(alone[0]!.inputs.by).toBe("standard");
  expect(alone[0]!.inputs.lists).toEqual([
    { list: "vendored", pattern: "(^|/)vendors?/" },
  ]);
  expect(alone[0]!.statement).toBe(
    `GitHub Linguist ${LINGUIST_STANDARD.version}'s vendored list matches this path by (^|/)vendors?/`,
  );
  const unset = generatedOf(plain(path), signalsOf(path, { vendored: UNSET }));
  expect(unset.map(outcome)).toEqual([
    ["not-held", "repository-declares-not-vendored"],
  ]);
  expect(unset[0]!.inputs.turnedOff).toEqual([
    {
      list: "vendored",
      by: "gitattributes: linguist-vendored=unset",
      over: ["(^|/)vendors?/"],
    },
  ]);
});

test("a path both lists mark records both, the generated rule first; with only one attribute off it still holds by the other list, saying which was turned off; with both off it is not held", () => {
  const path = "vendor/package-lock.json";
  const both = generatedOf(plain(path), signalsOf(path));
  expect(both.map(outcome)).toEqual([["holds", null]]);
  expect(both[0]!.inputs.lists).toEqual([
    { list: "generated", rule: "npm_shrinkwrap_or_package_lock?" },
    { list: "vendored", pattern: "(^|/)vendors?/" },
  ]);
  const generatedOff = generatedOf(
    plain(path),
    signalsOf(path, { generated: UNSET }),
  );
  expect(generatedOff.map(outcome)).toEqual([["holds", null]]);
  expect(generatedOff[0]!.inputs.lists).toEqual([
    { list: "vendored", pattern: "(^|/)vendors?/" },
  ]);
  expect(
    (generatedOff[0]!.inputs.turnedOff as Array<{ list: string }>).map(
      (entry) => entry.list,
    ),
  ).toEqual(["generated"]);
  const vendoredOff = generatedOf(
    plain(path),
    signalsOf(path, { vendored: FALSE }),
  );
  expect(vendoredOff.map(outcome)).toEqual([["holds", null]]);
  expect(vendoredOff[0]!.inputs.lists).toEqual([
    { list: "generated", rule: "npm_shrinkwrap_or_package_lock?" },
  ]);
  const bothOff = generatedOf(
    plain(path),
    signalsOf(path, { generated: UNSET, vendored: UNSET }),
  );
  expect(bothOff.map(outcome)).toEqual([
    ["not-held", "repository-declares-not-generated"],
  ]);
  expect(
    (bothOff[0]!.inputs.turnedOff as Array<{ list: string }>).map(
      (entry) => entry.list,
    ),
  ).toEqual(["generated", "vendored"]);
});

test("hand-written files the vendored list marks hold as any vendored file does: a .d.ts file and a tests/fixtures/ path", () => {
  for (const [path, pattern] of [
    ["types/api.d.ts", "(.*?)\\.d\\.ts$"],
    ["tests/fixtures/case.ts", "(^|/)[Tt]ests?/fixtures/"],
  ] as const) {
    const found = generatedOf(plain(path), signalsOf(path));
    expect(found.map(outcome)).toEqual([["holds", null]]);
    expect(found[0]!.inputs.lists).toEqual([{ list: "vendored", pattern }]);
  }
});

test("Linguist rules that need contents not read are not evaluated (contents-not-read); contents read with no answer say so (standard-not-answered); a file with no signal has no judgement", () => {
  expect(
    generatedOf(
      plain("src/plain.ts"),
      signalsOf("src/plain.ts", { bytes: "not-read" }),
    ).map(outcome),
  ).toEqual([["not-evaluated", "contents-not-read"]]);
  // Linguist raises on the first line of an empty `.frm` file: read, and unanswered.
  expect(
    generatedOf(plain("Form.frm"), signalsOf("Form.frm")).map(outcome),
  ).toEqual([["not-evaluated", "standard-not-answered"]]);
  expect(generatedOf(plain("src/plain.ts"))).toEqual([]);
});

test("a path decoded lossily is not given to Linguist (not-evaluated, path-not-utf8), and the repository's declaration still decides", () => {
  const path = "src/caf�.ts";
  expect(generatedOf(plain(path), signalsOf(path)).map(outcome)).toEqual([
    ["not-evaluated", "path-not-utf8"],
  ]);
  expect(
    generatedOf(plain(path), signalsOf(path, { generated: SET })).map(outcome),
  ).toEqual([["holds", null]]);
  expect(
    generatedOf(plain(path), signalsOf(path, { generated: UNSET })).map(
      outcome,
    ),
  ).toEqual([["not-evaluated", "path-not-utf8"]]);
  // The vendored list was not asked either: only both attributes off decide without it.
  expect(
    generatedOf(
      plain(path),
      signalsOf(path, { generated: UNSET, vendored: UNSET }),
    ).map(outcome),
  ).toEqual([["not-held", "repository-declares-not-generated"]]);
});

// --- blank-rows-only ------------------------------------------------------------------------------

test("a blank row beside an unchanged declaration, outside its symbol's lines, holds (holds)", () => {
  const computed = rulesOf([
    { path: "named.ts", before: NAMED_BASE, after: NAMED_HEAD },
  ]);
  const found = judgementsOf(computed, "blank-rows-only");
  expect(
    found.map((judgement) => [judgement.name, ...outcome(judgement)]),
  ).toEqual([["b", "holds", null]]);
  expect(found[0]!.inputs.rows).toEqual([
    { side: "new", line: 8, blank: true },
  ]);
});

test("an unchanged declaration that owns a non-blank row is not held (owns-non-blank-rows): a slid closing line", () => {
  // Git can slide the inserted function's first lines into the one before it.
  const hunks = [
    handHunk("slide.ts", SLIDE_BASE, SLIDE_HEAD, 1, 1, [
      " export function a() {",
      "+  return 1;",
      "+}",
      "+export function c() {",
      "   return 1;",
      " }",
      " export function b() {",
    ]),
  ];
  const found = judgementsOf(
    rulesOf([
      { path: "slide.ts", before: SLIDE_BASE, after: SLIDE_HEAD, hunks },
    ]),
    "blank-rows-only",
  );
  expect(
    found.map((judgement) => [judgement.name, ...outcome(judgement)]),
  ).toEqual([["a", "not-held", "owns-non-blank-rows"]]);
});

test("a blank row inside the declaration's symbol lines is not held (row-inside-declaration): a blank line can be content", () => {
  // One blank line slid within the function: removed above its twin, added below it.
  const hunks = [
    handHunk("inside.ts", INSIDE_TEXT, INSIDE_TEXT, 2, 2, [
      "   const x = 1;",
      "-",
      " ",
      "+",
      "   return x;",
    ]),
  ];
  const found = judgementsOf(
    rulesOf([
      { path: "inside.ts", before: INSIDE_TEXT, after: INSIDE_TEXT, hunks },
    ]),
    "blank-rows-only",
  );
  expect(
    found.map((judgement) => [judgement.name, ...outcome(judgement)]),
  ).toEqual([["a", "not-held", "row-inside-declaration"]]);
});

test("a blank row before a top-level statement holding a multi-line template is not evaluated (no-symbols): Graph gives the expression statement no symbols to tell its own lines by", () => {
  const found = judgementsOf(
    rulesOf([{ path: "blank.ts", before: BLANK_BASE, after: BLANK_HEAD }]),
    "blank-rows-only",
  );
  expect(
    found.map((judgement) => [judgement.name, ...outcome(judgement)]),
  ).toEqual([[null, "not-evaluated", "no-symbols"]]);
});

test("a blank row added inside a neighbouring statement's multi-line template is no blank-rows judgement: the statement's text changed", () => {
  const computed = rulesOf([
    { path: "template.ts", before: TEMPLATE_BASE, after: TEMPLATE_HEAD },
  ]);
  expect(judgementsOf(computed, "blank-rows-only")).toEqual([]);
  expect(
    computed.result.sections.map((section) => [
      section.kind,
      section.name ?? null,
    ]),
  ).toEqual([["statement", null]]);
});

// --- moved-unchanged ------------------------------------------------------------------------------

const moveFrom = (path: string): FileChange => ({
  path,
  before: `${KEEP}${HELPER}`,
  after: KEEP,
});
const moveTo = (path: string): FileChange => ({
  path,
  before: "",
  after: HELPER,
});

test("a declaration removed from one path and added byte-identical in another hold as a pair, each naming the other (holds)", () => {
  const computed = rulesOf([moveFrom("src/a.ts"), moveTo("src/b.ts")]);
  const found = judgementsOf(computed, "moved-unchanged");
  expect(
    found.map((judgement) => [judgement.about.path, ...outcome(judgement)]),
  ).toEqual([
    ["src/a.ts", "holds", null],
    ["src/b.ts", "holds", null],
  ]);
  expect((found[0]!.inputs.other as { path: string }).path).toBe("src/b.ts");
  expect((found[1]!.inputs.other as { key: string }).key).toBe(
    found[0]!.about.key,
  );
  expect(found[1]!.statement).toContain("removed from src/a.ts");
  // The inputs carry what made each section a candidate, so "owns the whole declaration" can be
  // told again from them: the fact, the span's size and the owned rows' sizes.
  expect(found[0]!.inputs).toMatchObject({
    fact: { "old-side-only": true },
    span: { lines: 4 },
  });
  expect(found[1]!.inputs).toMatchObject({
    fact: { declaration: "added" },
    fileLines: 4,
  });
  expect((found[1]!.inputs.rows as Array<{ blank: boolean }>).length).toBe(4);
});

test("two added and one removed of the same text are ambiguous for all three (not-held, ambiguous)", () => {
  const found = judgementsOf(
    rulesOf([moveFrom("src/a.ts"), moveTo("src/b.ts"), moveTo("src/c.ts")]),
    "moved-unchanged",
  );
  expect(
    found.map((judgement) => [judgement.about.path, ...outcome(judgement)]),
  ).toEqual([
    ["src/a.ts", "not-held", "ambiguous"],
    ["src/b.ts", "not-held", "ambiguous"],
    ["src/c.ts", "not-held", "ambiguous"],
  ]);
});

test("equal text under different names is no pair: the group is kind, name and text", () => {
  const computed = rulesOf([moveFrom("src/a.ts"), moveTo("src/b.ts")]);
  const renamed = new Map(
    [...computed.result.identities].map(([key, identity]) => [
      key,
      identity.parts.path === "src/b.ts"
        ? { ...identity, parts: { ...identity.parts, name: "other" } }
        : identity,
    ]),
  );
  const rules = sectionRulesOf({
    result: { ...computed.result, identities: renamed },
    hunks: computed.hunks,
    structures: computed.structures,
    files: computed.files,
    texts: computed.texts,
  });
  expect(
    rules.filter((judgement) => judgement.rule === "moved-unchanged"),
  ).toEqual([]);
});

test("a pair in one path is not held (same-path)", () => {
  // A real diff cannot give this: one file's same declaration is its own counterpart. The input is
  // the cross-file pair with the added file's sections and hunks put under the other path.
  const computed = rulesOf([moveFrom("src/a.ts"), moveTo("src/b.ts")]);
  const sections = computed.result.sections.map((section) =>
    section.path === "src/b.ts"
      ? {
          ...section,
          path: "src/a.ts",
          key: section.key.replace(/^src\/b\.ts\0/, "src/a.ts\0"),
        }
      : section,
  );
  const identities = new Map(
    [...computed.result.identities].map(([key, identity]) => [
      key.replace(/^src\/b\.ts\0/, "src/a.ts\0"),
      identity,
    ]),
  );
  const hunks = computed.hunks.map((hunk) =>
    hunk.path === "src/b.ts"
      ? { ...hunk, path: "src/a.ts", newPath: "src/a.ts" }
      : hunk,
  );
  const found = sectionRulesOf({
    result: { ...computed.result, sections, identities },
    hunks,
    structures: computed.structures,
    files: computed.files,
    texts: computed.texts,
  }).filter((judgement) => judgement.rule === "moved-unchanged");
  expect(found.map(outcome)).toEqual([
    ["not-held", "same-path"],
    ["not-held", "same-path"],
  ]);
});

test("a declaration that only partly changed is no candidate, so its byte-identical twin removed elsewhere has no partner and no judgement", () => {
  // The added function's closing line is matched to an existing one.
  const hunks = [
    handHunk("src/b.ts", PARTIAL_BASE, PARTIAL_HEAD, 1, 1, [
      " export function keep() {",
      "   return 0;",
      "+}",
      "+",
      "+export function helper(x: number) {",
      "+  return x * 2;",
      " }",
    ]),
  ];
  const computed = rulesOf([
    moveFrom("src/a.ts"),
    { path: "src/b.ts", before: PARTIAL_BASE, after: PARTIAL_HEAD, hunks },
  ]);
  expect(judgementsOf(computed, "moved-unchanged")).toEqual([]);
});

// --- markdown-prose -------------------------------------------------------------------------------

const markdownOf = (
  path: string,
  before: string,
  after: string,
  texts?: (map: Map<string, string | null>) => void,
) =>
  judgementsOf(
    rulesOf([{ path, before, after }], texts === undefined ? {} : { texts }),
    "markdown-prose",
  ).map(outcome);

test("a changed prose row outside any fence holds, and says only that no fenced row changed (holds)", () => {
  const before = "# Title\n\nSome words.\n\n```sh\nrun\n```\n";
  const found = judgementsOf(
    rulesOf([
      {
        path: "doc.md",
        before,
        after: before.replace("Some words.", "Other words."),
      },
    ]),
    "markdown-prose",
  );
  expect(found.map(outcome)).toEqual([["holds", null]]);
  expect(found[0]!.inputs).toMatchObject({
    ownedRows: 2,
    fencedRows: 0,
    indentedRows: 0,
  });
});

test("a changed row an indented code block could hold is counted for the reader, and the result does not change (holds, indentedRows)", () => {
  const before = "# T\n\nwords\n\n    run one\n";
  const found = judgementsOf(
    rulesOf([{ path: "doc.md", before, after: before.replace("one", "two") }]),
    "markdown-prose",
  );
  expect(found.map(outcome)).toEqual([["holds", null]]);
  expect(found[0]!.inputs).toMatchObject({ indentedRows: 2 });
});

test("a changed row inside a fence, a fence line, a tilde fence, a longer closing fence and an unclosed fence are not held (fenced-row-changed): code blocks are commands people run", () => {
  const notHeld = [["not-held", "fenced-row-changed"]];
  expect(
    markdownOf(
      "a.md",
      "# T\n\n```sh\nrun one\n```\n",
      "# T\n\n```sh\nrun two\n```\n",
    ),
  ).toEqual(notHeld);
  expect(
    markdownOf(
      "b.md",
      "# T\n\n```sh\nrun\n```\n",
      "# T\n\n```bash\nrun\n```\n",
    ),
  ).toEqual(notHeld);
  expect(
    markdownOf(
      "c.md",
      "# T\n\n~~~\nrun one\n~~~\n",
      "# T\n\n~~~\nrun two\n~~~\n",
    ),
  ).toEqual(notHeld);
  // A shorter fence does not close a longer one: the row after it is still inside.
  expect(
    markdownOf(
      "d.md",
      "# T\n\n````\n```\nrun one\n````\n",
      "# T\n\n````\n```\nrun two\n````\n",
    ),
  ).toEqual(notHeld);
  expect(
    markdownOf(
      "e.md",
      "# T\n\n```\nrun\n\nend one\n",
      "# T\n\n```\nrun\n\nend two\n",
    ),
  ).toEqual(notHeld);
});

test("what the fence scan does not account for is not evaluated: front matter, a fence in a quote, an MDX file, a side not read, a side not text", () => {
  expect(
    markdownOf(
      "f.md",
      "---\ntitle: a\n---\n# T\n",
      "---\ntitle: b\n---\n# T\n",
    ),
  ).toEqual([["not-evaluated", "front-matter"]]);
  expect(
    markdownOf(
      "g.md",
      "# T\n\n> ```\n> run\n> ```\n\nwords one\n",
      "# T\n\n> ```\n> run\n> ```\n\nwords two\n",
    ),
  ).toEqual([["not-evaluated", "fence-in-container"]]);
  expect(
    markdownOf("h.mdx", "# T\n\nwords one\n", "# T\n\nwords two\n"),
  ).toEqual([["not-evaluated", "mdx"]]);
  const before = "# T\n\nwords one\n";
  const after = "# T\n\nwords two\n";
  expect(
    markdownOf("i.md", before, after, (map) => map.delete(oidOf(before))),
  ).toEqual([["not-evaluated", "contents-not-read"]]);
  expect(
    markdownOf("j.md", before, after, (map) => map.set(oidOf(after), null)),
  ).toEqual([["not-evaluated", "not-text"]]);
});

// Each case below is a kind CommonMark (markdown-it's `commonmark` preset, run in a throwaway
// probe outside the repository) reads as a fenced block where the old scan held: written out by
// hand, so a code block a person runs is never passed as prose.
test("a fence in a list item closed by a dedented fence refuses the side (fence-in-container): the scan reads only column-0 fences", () => {
  const before = "# T\n\n- item\n\n  ```\n  code\n```\nreal one\n```\n";
  expect(
    markdownOf("list.md", before, before.replace("real one", "real two")),
  ).toEqual([["not-evaluated", "fence-in-container"]]);
});

test("a fence indented by one to three spaces refuses the side (fence-in-container)", () => {
  const before = "# T\n\n  ```\nrun one\n  ```\n";
  expect(
    markdownOf("indented.md", before, before.replace("one", "two")),
  ).toEqual([["not-evaluated", "fence-in-container"]]);
});

test("an HTML block holding a fence-like line refuses the side (html-block): CommonMark does not read an HTML block for fences", () => {
  const comment = "# T\n\n<!--\n```\n-->\n\n```\ncode one\n```\n";
  expect(
    markdownOf("comment.md", comment, comment.replace("code one", "code two")),
  ).toEqual([["not-evaluated", "html-block"]]);
  const tag = "# T\n\n<div>\n```\n</div>\n\nwords one\n";
  expect(
    markdownOf("tag.md", tag, tag.replace("words one", "words two")),
  ).toEqual([["not-evaluated", "html-block"]]);
});

test("a front matter with no fence-like line is left out, so the real fence after it is found (fenced-row-changed): the scan starts after the front matter", () => {
  const before = "---\nnote: plain\n---\n# T\n\n```\ncode one\n```\n";
  expect(
    markdownOf("front.md", before, before.replace("code one", "code two")),
  ).toEqual([["not-held", "fenced-row-changed"]]);
});

test("a fence-like line in front matter refuses the side (fence-in-front-matter): a renderer that does not strip the block reads it as a fence", () => {
  // Read with the block left in, `code two` is inside the fence the block's ``` opens.
  const bare = "---\n```\n---\ncode one\n```\n";
  expect(
    markdownOf("front-bare.md", bare, bare.replace("code one", "code two")),
  ).toEqual([["not-evaluated", "fence-in-front-matter"]]);
  // The reviewer's earlier case: an indented one in a YAML block scalar.
  const indented = "---\nnote: |\n  ```\n---\n# T\n\n```\ncode one\n```\n";
  expect(
    markdownOf(
      "front-indented.md",
      indented,
      indented.replace("code one", "code two"),
    ),
  ).toEqual([["not-evaluated", "fence-in-front-matter"]]);
});

test("a carriage return not followed by a line feed refuses the side (bare-carriage-return): CommonMark ends a line there, so one row can hide fence lines", () => {
  // The owned row holds both fence lines and the changed code.
  const code = "# T\n\nwords\r```\rcode one\r```\n";
  expect(
    markdownOf("cr-code.md", code, code.replace("code one", "code two")),
  ).toEqual([["not-evaluated", "bare-carriage-return"]]);
  // The owned row holds prose, a fence line and the fence's content.
  const words = "# T\n\nwords one\r```\rcode\r```\n";
  expect(
    markdownOf("cr-words.md", words, words.replace("words one", "words two")),
  ).toEqual([["not-evaluated", "bare-carriage-return"]]);
  // A CRLF file is read as before.
  const crlf = "# T\r\n\r\nwords one\r\n";
  expect(
    markdownOf("crlf.md", crlf, crlf.replace("words one", "words two")),
  ).toEqual([["holds", null]]);
});

test("a column-0 fence after a list is read as a fence: a list item cannot hold it (fenced-row-changed)", () => {
  const before = "# T\n\n- item\n\n```\ncode one\n```\n";
  expect(
    markdownOf("after-list.md", before, before.replace("code one", "code two")),
  ).toEqual([["not-held", "fenced-row-changed"]]);
});

// --- Every rule together --------------------------------------------------------------------------

const everything: ReadonlyArray<FileChange> = [
  lock,
  { path: "named.ts", before: NAMED_BASE, after: NAMED_HEAD },
  moveFrom("src/a.ts"),
  moveTo("src/b.ts"),
  { path: "doc.md", before: "# T\n\nwords one\n", after: "# T\n\nwords two\n" },
];

test("the same hunks in another order give the same judgements, every judgement parses with the schema, and a rule that does not apply gives none", () => {
  const computed = rulesOf(everything);
  const reversed = sectionRulesOf({
    result: computeSectionFacts(
      [...computed.hunks].reverse(),
      new Map([...computed.structures].reverse()),
    ),
    hunks: [...computed.hunks].reverse(),
    structures: new Map([...computed.structures].reverse()),
    files: new Map([...computed.files].reverse()),
    texts: new Map([...computed.texts].reverse()),
  });
  expect(reversed).toEqual(computed.rules);
  for (const judgement of computed.rules)
    expect(SectionRuleJudgement.parse(judgement)).toEqual(judgement);
  // Per path: which rules gave judgements. A rule that does not apply to a section is absent.
  const rulesByPath = new Map<string, Set<string>>();
  for (const judgement of computed.rules)
    rulesByPath.set(
      judgement.about.path,
      (rulesByPath.get(judgement.about.path) ?? new Set()).add(judgement.rule),
    );
  expect(
    Object.fromEntries(
      [...rulesByPath].map(([path, rules]) => [path, [...rules]]),
    ),
  ).toEqual({
    "bun.lock": ["generated"],
    "named.ts": ["blank-rows-only"],
    "src/a.ts": ["moved-unchanged"],
    "src/b.ts": ["moved-unchanged"],
    "doc.md": ["markdown-prose"],
  });
  // The changed `c` and the blank row's neighbours have none: only `b`'s section is judged.
  expect(
    judgementsOf(computed, "blank-rows-only").map(
      (judgement) => judgement.name,
    ),
  ).toEqual(["b"]);
});

// --- Stored ---------------------------------------------------------------------------------------

const root = mkdtempSync(join(tmpdir(), "section-rules-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const storedRulesIn = (
  name: string,
  repository: string,
  revision: string,
  hunks: ReadonlyArray<ManifestHunk>,
) => {
  const location = storeLocationIn(join(root, name));
  const layer = Computations.layer.pipe(
    Layer.provideMerge(Blobs.layer(location)),
    Layer.provideMerge(
      Layer.effectDiscard(Store.prepareForWrite).pipe(
        Layer.provideMerge(Store.layer(location, { create: true })),
      ),
    ),
    Layer.provideMerge(BunFileSystem.layer),
  );
  return Effect.runPromise(
    storedSectionRules(
      repository,
      revision,
      hunks,
      captureOutlineSource(),
    ).pipe(
      Effect.provideService(CpuWork, {
        budget: new Scheduler(1),
        priority: { class: "interactive", position: "understand", stage: 0 },
        inherited: true,
      }),
      Effect.provideService(CodeWork, undefined),
      Effect.provide(layer),
    ),
  );
};

test("stored: a second call is reused; a changed .gitattributes value changes the key and the result; a blob over the size bound is not evaluated, not an error", async () => {
  const repository = join(root, "repo");
  const run = (...args: Array<string>) => {
    const done = Bun.spawnSync(["git", "-C", repository, ...args], {
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    });
    if (done.exitCode !== 0) throw new Error(done.stderr.toString());
    return done.stdout.toString().trim();
  };
  Bun.spawnSync(["git", "init", "-q", repository]);
  const commit = (files: Readonly<Record<string, string>>) => {
    for (const [path, text] of Object.entries(files))
      writeFileSync(join(repository, path), text);
    run("add", "-A");
    run("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "c");
    return run("rev-parse", "HEAD");
  };
  // Over the bound: 1 MiB and more in two long lines, a TypeScript file whose Linguist rule needs it.
  const bigBefore = `${"x".repeat(600_000)}\n${"y".repeat(600_000)}\n`;
  const bigAfter = `${"x".repeat(600_000)}\n${"z".repeat(600_000)}\n`;
  const docBefore = "# T\n\nwords one\n";
  const docAfter = "# T\n\nwords two\n";
  const files = {
    "bun.lock": LOCK_AFTER,
    "big.ts": bigAfter,
    "doc.md": docAfter,
  };
  for (const text of [LOCK_BEFORE, bigBefore, docBefore])
    Bun.spawnSync(["git", "-C", repository, "hash-object", "-w", "--stdin"], {
      stdin: new TextEncoder().encode(text),
    });
  const first = commit({ ...files, ".gitattributes": "*.md text\n" });
  const second = commit({ ".gitattributes": "bun.lock -linguist-generated\n" });
  const blobOf = (text: string) =>
    Bun.spawnSync(["git", "-C", repository, "hash-object", "--stdin"], {
      stdin: new TextEncoder().encode(text),
    })
      .stdout.toString()
      .trim();
  const hunks = [
    ["bun.lock", LOCK_BEFORE, LOCK_AFTER],
    ["big.ts", bigBefore, bigAfter],
    ["doc.md", docBefore, docAfter],
  ].flatMap(([path, before, after]) =>
    diff(path!, before!, after!).map((hunk) => ({
      ...hunk,
      oldOid: blobOf(before!),
      newOid: blobOf(after!),
    })),
  );
  const generatedByPath = (rules: ReadonlyArray<SectionRuleJudgement>) =>
    Object.fromEntries(
      rules
        .filter((judgement) => judgement.rule === "generated")
        .map((judgement) => [judgement.about.path, outcome(judgement)]),
    );

  const once = await storedRulesIn("store", repository, first, hunks);
  const again = await storedRulesIn("store", repository, first, hunks);
  expect([once.rulesStatus, again.rulesStatus]).toEqual(["computed", "reused"]);
  expect(again.rulesKey).toBe(once.rulesKey);
  expect(again.rules).toEqual(once.rules);
  expect(generatedByPath(once.rules)).toEqual({
    "big.ts": ["not-evaluated", "contents-not-read"],
    "bun.lock": ["holds", null],
  });
  expect(
    once.rules
      .filter((judgement) => judgement.rule === "markdown-prose")
      .map(outcome),
  ).toEqual([["holds", null]]);

  const changed = await storedRulesIn("store", repository, second, hunks);
  expect(changed.rulesStatus).toBe("computed");
  expect(changed.rulesKey).not.toBe(once.rulesKey);
  expect(changed.key).toBe(once.key);
  expect(generatedByPath(changed.rules)["bun.lock"]).toEqual([
    "not-held",
    "repository-declares-not-generated",
  ]);

  // The declared readers are in the key: one added keeps the facts' key (it keeps kinds only)
  // and gives another rules key, whose judgement names it. A `gitattributes:` reader the commit
  // does not carry is left out and listed; the marker still holds, so the statement does not say.
  const marker = {
    kind: "generated" as const,
    by: 'generated-marker: "@generated" in its first 1024 bytes',
  };
  const declare = (declared: ManifestHunk["declared"]) =>
    hunks.map((hunk) =>
      hunk.path === "bun.lock" ? { ...hunk, declared } : hunk,
    );
  const header = await storedRulesIn(
    "store",
    repository,
    first,
    declare([marker]),
  );
  const both = await storedRulesIn(
    "store",
    repository,
    first,
    declare([marker, { kind: "generated", by: "gitattributes: -diff" }]),
  );
  expect(both.key).toBe(header.key);
  expect(both.rulesKey).not.toBe(header.rulesKey);
  expect(both.rulesStatus).toBe("computed");
  const statementOf = (rules: ReadonlyArray<SectionRuleJudgement>) =>
    rules.find(
      (judgement) =>
        judgement.rule === "generated" && judgement.about.path === "bun.lock",
    )!.statement;
  expect(statementOf(header.rules)).not.toContain("-diff");
  expect(statementOf(both.rules)).toBe(statementOf(header.rules));
  const lockOf = (rules: ReadonlyArray<SectionRuleJudgement>) =>
    rules.find(
      (judgement) =>
        judgement.rule === "generated" && judgement.about.path === "bun.lock",
    )!;
  expect(lockOf(both.rules).inputs.declaredNotVouched).toEqual([
    "gitattributes: -diff",
  ]);
  expect(lockOf(both.rules).inputs.declared).toEqual([marker.by]);
}, 120_000);

// --- Stored: what the attribute read cannot be sure of -------------------------------------------
// Why: `git check-attr` prints `unset` for `-attr` and for `attr=unset`, and `unspecified` for no
// attribute and for `attr=unspecified`; and Git reads files and settings no commit holds (a local
// `info/attributes`, the system file, configuration, `GIT_*` variables). A judgement that took
// either for the repository's declaration would say more than was read.

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

/** A small real repository, its commits, and hunks whose blobs it holds. */
const scratchRepository = (name: string) => {
  const repository = join(root, name);
  const run = (...args: Array<string>) => {
    const done = Bun.spawnSync(["git", "-C", repository, ...args], {
      env: GIT_ENV,
    });
    if (done.exitCode !== 0) throw new Error(done.stderr.toString());
    return done.stdout.toString().trim();
  };
  Bun.spawnSync(["git", "init", "-q", repository], { env: GIT_ENV });
  const write = (files: Readonly<Record<string, string>>) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(repository, path)), { recursive: true });
      writeFileSync(join(repository, path), text);
    }
  };
  const commit = (files: Readonly<Record<string, string>>) => {
    write(files);
    run("add", "-A");
    run("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "c");
    return run("rev-parse", "HEAD");
  };
  const blobOf = (text: string) => {
    const done = Bun.spawnSync(
      ["git", "-C", repository, "hash-object", "-w", "--stdin"],
      { stdin: new TextEncoder().encode(text), env: GIT_ENV },
    );
    return done.stdout.toString().trim();
  };
  const hunksOf = (changes: ReadonlyArray<readonly [string, string, string]>) =>
    changes.flatMap(([path, before, after]) =>
      diff(path, before, after).map((hunk) => ({
        ...hunk,
        oldOid: blobOf(before),
        newOid: blobOf(after),
      })),
    );
  const infoAttributes = (text: string | null) => {
    const file = join(repository, ".git", "info", "attributes");
    rmSync(file, { recursive: true, force: true });
    if (text !== null) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text);
    }
  };
  const infoDirectory = () => {
    const file = join(repository, ".git", "info", "attributes");
    rmSync(file, { recursive: true, force: true });
    mkdirSync(file, { recursive: true });
  };
  const link = (path: string, target: string) => {
    mkdirSync(dirname(join(repository, path)), { recursive: true });
    symlinkSync(target, join(repository, path));
  };
  /** A commit built from blobs and paths as bytes, past the file system's normalisation. */
  const commitPaths = (files: Readonly<Record<string, string>>) => {
    for (const [path, text] of Object.entries(files))
      run(
        "-c",
        "core.precomposeUnicode=false",
        "update-index",
        "--add",
        "--cacheinfo",
        `100644,${blobOf(text)},${path}`,
      );
    const tree = run("-c", "core.precomposeUnicode=false", "write-tree");
    const created = run(
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit-tree",
      tree,
      "-m",
      "c",
    );
    run("update-ref", "HEAD", created);
    return created;
  };
  return {
    repository,
    run,
    commit,
    commitPaths,
    blobOf,
    hunksOf,
    infoAttributes,
    infoDirectory,
    link,
  };
};

const generatedIn = (rules: ReadonlyArray<SectionRuleJudgement>) =>
  rules.filter((judgement) => judgement.rule === "generated");
const generatedByPathIn = (rules: ReadonlyArray<SectionRuleJudgement>) =>
  Object.fromEntries(
    generatedIn(rules).map((judgement) => [
      judgement.about.path,
      outcome(judgement),
    ]),
  );
const generatedAt = (
  rules: ReadonlyArray<SectionRuleJudgement>,
  path: string,
) => generatedIn(rules).find((judgement) => judgement.about.path === path)!;

const TEXT_BEFORE = "one\ntwo\n";
const TEXT_AFTER = "one\nthree\n";
const AMBIGUOUS = ["not-evaluated", "attribute-value-ambiguous"];

test("stored: a value spelled like a state is not read as the state: bun.lock linguist-generated=unset and plain.ts linguist-generated=unspecified are not evaluated (attribute-value-ambiguous); -linguist-generated, =maybe and no line read as before", async () => {
  const repo = scratchRepository("ambiguous-words");
  const hunks = repo.hunksOf([
    ["bun.lock", LOCK_BEFORE, LOCK_AFTER],
    ["plain.ts", TEXT_BEFORE, TEXT_AFTER],
  ]);
  const files = { "bun.lock": LOCK_AFTER, "plain.ts": TEXT_AFTER };
  const literal = repo.commit({
    ...files,
    ".gitattributes":
      "bun.lock linguist-generated=unset\nplain.ts linguist-generated=unspecified\n",
  });
  const words = await storedRulesIn("words", repo.repository, literal, hunks);
  expect(generatedByPathIn(words.rules)).toEqual({
    "bun.lock": AMBIGUOUS,
    "plain.ts": AMBIGUOUS,
  });
  const lock = generatedAt(words.rules, "bun.lock");
  expect(lock.inputs.ambiguous).toEqual([
    {
      attribute: "linguist-generated",
      word: "unset",
      files: [".gitattributes"],
      unread: [],
    },
  ]);
  expect(
    (lock.inputs.attributes as Record<string, unknown>)["linguist-generated"],
  ).toEqual({ state: "unset", value: null, read: "ambiguous" });
  expect(lock.statement).toContain("linguist-generated=unset");
  expect(generatedAt(words.rules, "plain.ts").statement).toContain(
    "linguist-generated=unspecified",
  );

  const states = repo.commit({
    ".gitattributes":
      "bun.lock -linguist-generated\nplain.ts linguist-generated=maybe\n",
  });
  const read = await storedRulesIn("words", repo.repository, states, hunks);
  expect(generatedByPathIn(read.rules)).toEqual({
    "bun.lock": ["not-held", "repository-declares-not-generated"],
    "plain.ts": ["holds", null],
  });
  expect(
    (
      generatedAt(read.rules, "bun.lock").inputs.attributes as Record<
        string,
        unknown
      >
    )["linguist-generated"],
  ).toEqual({ state: "unset", value: null, read: "state" });
  expect(generatedAt(read.rules, "plain.ts").inputs.by).toBe("declaration");

  // No line for either path, and no token: Linguist's lockfile rule holds; plain.ts gets nothing.
  const none = repo.commit({ ".gitattributes": "*.md text\n" });
  const silent = await storedRulesIn("words", repo.repository, none, hunks);
  expect(generatedByPathIn(silent.rules)).toEqual({
    "bun.lock": ["holds", null],
  });

  // The key: the same printed values (unspecified for plain.ts) with a token now over the path.
  const token = repo.commit({
    ".gitattributes": "*.md text\nother.txt linguist-generated=unspecified\n",
  });
  const keyed = await storedRulesIn("words", repo.repository, token, hunks);
  expect(keyed.rulesKey).not.toBe(silent.rulesKey);
  expect(keyed.rulesStatus).toBe("computed");
  // Both print unspecified under the root file: Linguist's lockfile rule is not weighed either.
  expect(generatedByPathIn(keyed.rules)).toEqual({
    "bun.lock": AMBIGUOUS,
    "plain.ts": AMBIGUOUS,
  });
}, 120_000);

test("stored: a token in a subfolder's .gitattributes covers that folder only; a root macro carrying it covers every path; a token in a comment line changes nothing", async () => {
  const repo = scratchRepository("ambiguous-scope");
  const paths = ["top.ts", "sub/a.ts", "sub/deep/b.ts"];
  const hunks = repo.hunksOf(
    paths.map((path) => [path, TEXT_BEFORE, TEXT_AFTER] as const),
  );
  const files = Object.fromEntries(paths.map((path) => [path, TEXT_AFTER]));
  const folder = repo.commit({
    ...files,
    "sub/.gitattributes": "a.ts linguist-generated=unspecified\n",
  });
  const scoped = await storedRulesIn("scope", repo.repository, folder, hunks);
  expect(generatedByPathIn(scoped.rules)).toEqual({
    "sub/a.ts": AMBIGUOUS,
    "sub/deep/b.ts": AMBIGUOUS,
  });
  expect(generatedAt(scoped.rules, "sub/deep/b.ts").inputs.ambiguous).toEqual([
    {
      attribute: "linguist-generated",
      word: "unspecified",
      files: ["sub/.gitattributes"],
      unread: [],
    },
  ]);

  const macro = repo.commit({
    "sub/.gitattributes": "*.md text\n",
    ".gitattributes": "[attr]odd linguist-generated=unspecified\n",
  });
  const everywhere = await storedRulesIn(
    "scope",
    repo.repository,
    macro,
    hunks,
  );
  expect(generatedByPathIn(everywhere.rules)).toEqual({
    "top.ts": AMBIGUOUS,
    "sub/a.ts": AMBIGUOUS,
    "sub/deep/b.ts": AMBIGUOUS,
  });

  const comment = repo.commit({
    ".gitattributes":
      "# top.ts linguist-generated=unspecified\n  # x linguist-vendored=unspecified\n",
  });
  const commented = await storedRulesIn(
    "scope",
    repo.repository,
    comment,
    hunks,
  );
  expect(generatedByPathIn(commented.rules)).toEqual({});
}, 120_000);

test("stored: the same for linguist-vendored: =unset and =unspecified are not evaluated (attribute-value-ambiguous) where they reach, -linguist-vendored is still not held, and a vendor path out of reach holds by the standard", async () => {
  const repo = scratchRepository("ambiguous-vendored");
  const paths = ["vendor/a.ts", "vendor/b.ts", "lib/c.ts", "lib/d.ts"];
  const hunks = repo.hunksOf(
    paths.map((path) => [path, TEXT_BEFORE, TEXT_AFTER] as const),
  );
  const files = Object.fromEntries(paths.map((path) => [path, TEXT_AFTER]));
  const literal = repo.commit({
    ...files,
    ".gitattributes": "vendor/b.ts linguist-vendored=unset\n",
    "lib/.gitattributes": "c.ts linguist-vendored=unspecified\n",
  });
  const words = await storedRulesIn(
    "vendored",
    repo.repository,
    literal,
    hunks,
  );
  expect(generatedByPathIn(words.rules)).toEqual({
    // Printed unspecified, and the root's token is `=unset`: read as before.
    "vendor/a.ts": ["holds", null],
    "vendor/b.ts": AMBIGUOUS,
    "lib/c.ts": AMBIGUOUS,
    "lib/d.ts": AMBIGUOUS,
  });
  expect(generatedAt(words.rules, "vendor/b.ts").inputs.ambiguous).toEqual([
    {
      attribute: "linguist-vendored",
      word: "unset",
      files: [".gitattributes"],
      unread: [],
    },
  ]);

  const states = repo.commit({
    ".gitattributes": "vendor/b.ts -linguist-vendored\n",
    "lib/.gitattributes": "*.md text\n",
  });
  const read = await storedRulesIn("vendored", repo.repository, states, hunks);
  expect(generatedByPathIn(read.rules)).toEqual({
    "vendor/a.ts": ["holds", null],
    "vendor/b.ts": ["not-held", "repository-declares-not-vendored"],
  });
}, 120_000);

test("stored: a file no commit holds must not decide what the repository declares: info/attributes naming the attribute, a quoted macro of the root file, -diff or binary, or a directory in its place, changes nothing (same key, same judgements), from a linked worktree too", async () => {
  const repo = scratchRepository("local-file");
  const hunks = repo.hunksOf([
    ["bun.lock", LOCK_BEFORE, LOCK_AFTER],
    ["plain.ts", TEXT_BEFORE, TEXT_AFTER],
  ]);
  // Git takes a C-quoted first token as the name: these define the macros gen, " gen2" and oct.
  const revision = repo.commit({
    "bun.lock": LOCK_AFTER,
    "plain.ts": TEXT_AFTER,
    ".gitattributes":
      '"[attr]gen" linguist-generated\n"[attr] gen2" linguist-generated\n"\\133attr]oct" linguist-vendored\n',
  });
  const without = await storedRulesIn(
    "local",
    repo.repository,
    revision,
    hunks,
  );
  expect(generatedByPathIn(without.rules)).toEqual({
    "bun.lock": ["holds", null],
  });
  const unchanged = async (label: string) => {
    const found = await storedRulesIn(
      "local",
      repo.repository,
      revision,
      hunks,
    );
    expect([label, found.rulesKey]).toEqual([label, without.rulesKey]);
    expect(found.rules).toEqual(without.rules);
  };
  for (const text of [
    "plain.ts linguist-generated\n* linguist-vendored\n",
    "plain.ts gen gen2 oct\n",
    "* -diff\n",
    "* binary\n",
  ]) {
    repo.infoAttributes(text);
    await unchanged(text);
  }
  repo.infoDirectory();
  await unchanged("a directory at info/attributes");

  // A linked worktree: its info/attributes is the common directory's.
  repo.infoAttributes("* linguist-generated -diff\n");
  const worktree = join(root, "local-file-worktree");
  repo.run("worktree", "add", "-q", "--detach", worktree, revision);
  const linked = await storedRulesIn("local", worktree, revision, hunks);
  expect(linked.rulesKey).toBe(without.rulesKey);
  expect(linked.rules).toEqual(without.rules);

  // The manifest's own reader still reads the local file (`declarations.ts`): its `-diff` there is
  // not what the commit gives, so it is left out, and plain.ts has no signal left.
  const declared = hunks.map((hunk) =>
    hunk.path === "plain.ts"
      ? {
          ...hunk,
          declared: [
            { kind: "generated" as const, by: "gitattributes: -diff" },
          ],
        }
      : hunk,
  );
  const fromManifest = await storedRulesIn(
    "local",
    repo.repository,
    revision,
    declared,
  );
  expect(generatedByPathIn(fromManifest.rules)).toEqual({
    "bun.lock": ["holds", null],
  });
  repo.infoAttributes(null);
}, 120_000);

test("stored: the scan reads what Git reads: a .gitattributes committed as a symbolic link, text up to a NUL, a quoted pattern with no blank after it, and a file too large to read are ambiguous (attribute-value-ambiguous)", async () => {
  const repo = scratchRepository("scan-reads");
  const paths = ["bun.lock", "link/bun.lock", "q.ts", "big/x.ts", "top.ts"];
  const hunks = repo.hunksOf(
    paths.map((path) => [path, TEXT_BEFORE, TEXT_AFTER] as const),
  );
  // Git reads a link's target text as attribute lines on a tree read; `git grep` skipped it.
  repo.link("link/.gitattributes", "bun.lock linguist-generated=unset");
  const revision = repo.commit({
    ...Object.fromEntries(paths.map((path) => [path, TEXT_AFTER])),
    // Git ends an attributes blob at its first NUL: the token ends there.
    ".gitattributes":
      '"q.ts"linguist-vendored=unset\n/bun.lock linguist-vendored=unset\0junk\n',
    // Over the read bound: not read, so whether it holds a token is not known.
    "big/.gitattributes": `# ${"x".repeat(1_100_000)}\n`,
  });
  const stored = await storedRulesIn("scan", repo.repository, revision, hunks);
  expect(generatedByPathIn(stored.rules)).toEqual({
    "bun.lock": AMBIGUOUS,
    "link/bun.lock": AMBIGUOUS,
    "q.ts": AMBIGUOUS,
    "big/x.ts": AMBIGUOUS,
  });
  expect(generatedAt(stored.rules, "link/bun.lock").inputs.ambiguous).toEqual([
    {
      attribute: "linguist-generated",
      word: "unset",
      files: ["link/.gitattributes"],
      unread: [],
    },
  ]);
  // Every attribute Git printed unspecified for under the unread file is in doubt.
  expect(
    (
      generatedAt(stored.rules, "big/x.ts").inputs.ambiguous as Array<{
        attribute: string;
        unread: Array<string>;
      }>
    ).map((entry) => [entry.attribute, entry.unread]),
  ).toEqual([
    ["linguist-generated", ["big/.gitattributes"]],
    ["linguist-vendored", ["big/.gitattributes"]],
    ["diff", ["big/.gitattributes"]],
  ]);
  expect(generatedAt(stored.rules, "big/x.ts").statement).toContain("not read");
}, 120_000);

test("stored: the rule vouches for attribute readers itself: a committed -diff holds by declaration from its own read, a committed diff=unset is ambiguous, and a manifest reader the commit does not carry is left out and listed while the marker is taken", async () => {
  const repo = scratchRepository("vouched");
  const paths = ["x.ts", "lit/y.ts", "plain.ts"];
  const marker = {
    kind: "generated" as const,
    by: 'generated-marker: "@generated" in its first 1024 bytes',
  };
  const hunks = repo
    .hunksOf(paths.map((path) => [path, TEXT_BEFORE, TEXT_AFTER] as const))
    .map((hunk) =>
      hunk.path === "plain.ts"
        ? {
            ...hunk,
            declared: [
              marker,
              {
                kind: "generated" as const,
                by: "gitattributes: linguist-generated=set",
              },
            ],
          }
        : hunk,
    );
  const revision = repo.commit({
    ...Object.fromEntries(paths.map((path) => [path, TEXT_AFTER])),
    ".gitattributes": "x.ts -diff\n",
    "lit/.gitattributes": "y.ts diff=unset\n",
  });
  const stored = await storedRulesIn(
    "vouched",
    repo.repository,
    revision,
    hunks,
  );
  expect(generatedByPathIn(stored.rules)).toEqual({
    "x.ts": ["holds", null],
    "lit/y.ts": AMBIGUOUS,
    "plain.ts": ["holds", null],
  });
  const x = generatedAt(stored.rules, "x.ts");
  expect(x.inputs.readers).toEqual(["gitattributes: -diff"]);
  expect((x.inputs.attributes as Record<string, unknown>).diff).toEqual({
    state: "unset",
    value: null,
    read: "state",
  });
  const plainJudgement = generatedAt(stored.rules, "plain.ts");
  expect(plainJudgement.inputs.readers).toEqual([marker.by]);
  expect(plainJudgement.inputs.declaredNotVouched).toEqual([
    "gitattributes: linguist-generated=set",
  ]);
  // The result is the same without it: the statement does not mention it.
  expect(plainJudgement.statement).not.toContain("not taken");
}, 120_000);

test("a manifest attribute reader the rule's read does not give is named in the statement where taking it would change the result", () => {
  const found = generatedOf(
    plain("Form.frm", {
      declared: [
        { kind: "generated", by: "gitattributes: linguist-generated=true" },
      ],
    }),
    signalsOf("Form.frm"),
  );
  expect(found.map(outcome)).toEqual([
    ["not-evaluated", "standard-not-answered"],
  ]);
  expect(found[0]!.statement).toContain(
    "the declared gitattributes: linguist-generated=true is not what the commit's attributes give, so it is not taken",
  );
});

test("stored: GIT_DIR, GIT_ATTR_SOURCE and GIT_LITERAL_PATHSPECS in the caller's environment do not reach the read", async () => {
  const repo = scratchRepository("environment");
  const other = scratchRepository("environment-other");
  const elsewhere = other.commit({
    "bun.lock": LOCK_AFTER,
    "plain.ts": TEXT_AFTER,
    ".gitattributes": "* linguist-generated\n",
  });
  // Read there, the other repository's local file would mark every path.
  other.infoAttributes("* linguist-vendored\n");
  const hunks = repo.hunksOf([
    ["bun.lock", LOCK_BEFORE, LOCK_AFTER],
    ["sub/plain.ts", TEXT_BEFORE, TEXT_AFTER],
  ]);
  const revision = repo.commit({
    "bun.lock": LOCK_AFTER,
    "sub/plain.ts": TEXT_AFTER,
    "sub/.gitattributes": "plain.ts linguist-generated=unspecified\n",
  });
  const plainRead = await storedRulesIn(
    "env",
    repo.repository,
    revision,
    hunks,
  );
  const saved = {
    GIT_DIR: process.env.GIT_DIR,
    GIT_ATTR_SOURCE: process.env.GIT_ATTR_SOURCE,
    GIT_LITERAL_PATHSPECS: process.env.GIT_LITERAL_PATHSPECS,
  };
  let misled;
  try {
    process.env.GIT_DIR = join(other.repository, ".git");
    process.env.GIT_ATTR_SOURCE = elsewhere;
    process.env.GIT_LITERAL_PATHSPECS = "1";
    misled = await storedRulesIn("env", repo.repository, revision, hunks);
  } finally {
    for (const [name, value] of Object.entries(saved))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  }
  expect(generatedByPathIn(plainRead.rules)).toEqual({
    "bun.lock": ["holds", null],
    "sub/plain.ts": AMBIGUOUS,
  });
  expect(misled.rulesKey).toBe(plainRead.rulesKey);
  expect(misled.rules).toEqual(plainRead.rules);
}, 120_000);

test("stored: paths go to check-attr as arguments as stdin carried them (a leading dash, a space and a non-ASCII character); the read runs in its own Git directory with GIT_ATTR_NOSYSTEM=1, which is gone after the read, whether it succeeds or fails", async () => {
  // The system attributes file sits at Git's compiled-in prefix and no variable moves it, so the
  // test does not write one: a git wrapper first on PATH records, for each check-attr, the
  // directory it runs in and the variable, and fails it where asked. Bun gives a child the PATH
  // changed here only where the call passes its own environment, as the isolated read does.
  const repo = scratchRepository("argument-paths");
  const paths = ["-dash.ts", "sp ace é.ts", "plain.ts"];
  const hunks = repo.hunksOf(
    paths.map((path) => [path, TEXT_BEFORE, TEXT_AFTER] as const),
  );
  const revision = repo.commit({
    ...Object.fromEntries(paths.map((path) => [path, TEXT_AFTER])),
    ".gitattributes":
      "-dash.ts linguist-generated\nsp?ace* linguist-vendored\n",
  });
  const bin = join(root, "wrapper-bin");
  const log = join(root, "wrapper.log");
  const fail = join(root, "wrapper.fail");
  mkdirSync(bin, { recursive: true });
  writeFileSync(log, "");
  const real = Bun.which("git")!;
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh\ncase " $* " in *" check-attr "*) printf '%s\\t%s\\n' "$2" "\${GIT_ATTR_NOSYSTEM-absent}" >> '${log}'; if [ -e '${fail}' ]; then exit 7; fi ;; esac\nexec '${real}' "$@"\n`,
  );
  chmodSync(join(bin, "git"), 0o755);
  const path = process.env.PATH;
  const seen = () =>
    readFileSync(log, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => line.split("\t") as [string, string]);
  process.env.PATH = `${bin}:${path ?? ""}`;
  let stored;
  let succeeded: Array<[string, string]> = [];
  let failed: unknown;
  try {
    stored = await storedRulesIn("arguments", repo.repository, revision, hunks);
    succeeded = seen();
    writeFileSync(log, "");
    writeFileSync(fail, "");
    // Another store: the first one's key would be reused without a read.
    failed = await storedRulesIn(
      "arguments-failing",
      repo.repository,
      revision,
      hunks,
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
  } finally {
    process.env.PATH = path;
    rmSync(fail, { force: true });
  }
  expect(generatedByPathIn(stored.rules)).toEqual({
    "-dash.ts": ["holds", null],
    "sp ace é.ts": ["holds", null],
  });
  expect(generatedAt(stored.rules, "-dash.ts").inputs.readers).toEqual([
    "gitattributes: linguist-generated=set",
  ]);
  expect(generatedAt(stored.rules, "sp ace é.ts").inputs.readers).toEqual([
    "gitattributes: linguist-vendored=set",
  ]);
  expect(failed).toBeDefined();
  const failing = seen();
  expect([succeeded.length > 0, failing.length > 0]).toEqual([true, true]);
  for (const [directory, variable] of [...succeeded, ...failing]) {
    expect(variable).toBe("1");
    expect(directory.startsWith(join(tmpdir(), "neuve-attributes-"))).toBe(
      true,
    );
    expect(existsSync(directory)).toBe(false);
  }
}, 120_000);

// --- Fix round 2: what still reached the read -----------------------------------------------------

test("stored: a partial clone's .gitattributes blob is fetched before the isolated read, so the first call already reads -linguist-generated (not-held, repository-declares-not-generated), and the second is reused", async () => {
  // Why: the isolated directory has no remote; an attributes blob it cannot see reads as absent,
  // and the answer would change once some other read fetched it.
  const source = scratchRepository("partial-source");
  source.run("config", "uploadpack.allowFilter", "true");
  source.commit({ "bun.lock": LOCK_BEFORE });
  const revision = source.commit({
    "bun.lock": LOCK_AFTER,
    ".gitattributes": "bun.lock -linguist-generated\n",
  });
  const hunks = source.hunksOf([["bun.lock", LOCK_BEFORE, LOCK_AFTER]]);
  const clone = join(root, "partial-clone");
  const cloned = Bun.spawnSync(
    [
      "git",
      "clone",
      "-q",
      "--filter=blob:none",
      "--no-checkout",
      `file://${source.repository}`,
      clone,
    ],
    { env: GIT_ENV },
  );
  expect(cloned.exitCode).toBe(0);
  const attributesBlob = source.run("rev-parse", `${revision}:.gitattributes`);
  const present = () =>
    Bun.spawnSync(["git", "-C", clone, "cat-file", "-e", attributesBlob], {
      env: { ...GIT_ENV, GIT_NO_LAZY_FETCH: "1" },
    }).exitCode === 0;
  expect(present()).toBe(false);
  const first = await storedRulesIn("partial", clone, revision, hunks);
  const second = await storedRulesIn("partial", clone, revision, hunks);
  expect(generatedByPathIn(first.rules)).toEqual({
    "bun.lock": ["not-held", "repository-declares-not-generated"],
  });
  expect([second.rulesStatus, second.rulesKey]).toEqual([
    "reused",
    first.rulesKey,
  ]);
  expect(present()).toBe(true);
}, 120_000);

test("stored: a .gitattributes blob the isolated read cannot see fails the call (AttributesUnreadable): an attributes file Git cannot find reads as absent, which must not answer", async () => {
  const repo = scratchRepository("missing-object");
  const hunks = repo.hunksOf([["bun.lock", LOCK_BEFORE, LOCK_AFTER]]);
  const revision = repo.commit({
    "bun.lock": LOCK_AFTER,
    ".gitattributes": "bun.lock -linguist-generated\n",
  });
  const oid = repo.run("rev-parse", `${revision}:.gitattributes`);
  rmSync(
    join(repo.repository, ".git", "objects", oid.slice(0, 2), oid.slice(2)),
  );
  const failed = await storedRulesIn(
    "missing",
    repo.repository,
    revision,
    hunks,
  ).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(String(failed)).toContain("cannot see .gitattributes");
}, 120_000);

test("stored: a decomposed path is answered as it was asked, beside its composed neighbour: both not-held (repository-declares-not-vendored), and a set attribute on a decomposed name holds by declaration", async () => {
  // Why: `git init` writes `precomposeunicode = true` on this Mac; a decomposed argument would be
  // composed, its answer would come back under another path, and the rule would read no answer.
  const repo = scratchRepository("decomposed");
  const decomposed = "vendor/é.ts";
  const composed = "vendor/é.ts";
  const generatedName = "gen/é.ts";
  const paths = [decomposed, composed, generatedName];
  const hunks = repo.hunksOf(
    paths.map((path) => [path, TEXT_BEFORE, TEXT_AFTER] as const),
  );
  const revision = repo.commitPaths({
    ...Object.fromEntries(paths.map((path) => [path, TEXT_AFTER])),
    ".gitattributes":
      "vendor/** -linguist-vendored\ngen/** linguist-generated\n",
  });
  expect(
    repo
      .run(
        "-c",
        "core.quotePath=false",
        "ls-tree",
        "-r",
        "--name-only",
        revision,
      )
      .split("\n"),
  ).toEqual([".gitattributes", generatedName, decomposed, composed].sort());
  const stored = await storedRulesIn(
    "decomposed",
    repo.repository,
    revision,
    hunks,
  );
  expect(generatedByPathIn(stored.rules)).toEqual({
    [decomposed]: ["not-held", "repository-declares-not-vendored"],
    [composed]: ["not-held", "repository-declares-not-vendored"],
    [generatedName]: ["holds", null],
  });
  expect(generatedAt(stored.rules, generatedName).inputs.readers).toEqual([
    "gitattributes: linguist-generated=set",
  ]);
}, 120_000);

test("stored: patterns match with case, as GitHub matches them: PLAIN.TS does not mark plain.ts, plain.ts does (holds, by declaration)", async () => {
  // Why: `git init` writes `ignorecase = true` on this Mac; the commit's declaration is read as
  // GitHub reads it.
  const repo = scratchRepository("case");
  const hunks = repo.hunksOf([["plain.ts", TEXT_BEFORE, TEXT_AFTER]]);
  const upper = repo.commit({
    "plain.ts": TEXT_AFTER,
    ".gitattributes": "PLAIN.TS linguist-generated\n",
  });
  const lower = repo.commit({
    ".gitattributes": "plain.ts linguist-generated\n",
  });
  const other = await storedRulesIn("case", repo.repository, upper, hunks);
  const same = await storedRulesIn("case", repo.repository, lower, hunks);
  expect(generatedByPathIn(other.rules)).toEqual({});
  expect(generatedByPathIn(same.rules)).toEqual({
    "plain.ts": ["holds", null],
  });
  expect(generatedAt(same.rules, "plain.ts").inputs.by).toBe("declaration");
}, 120_000);

test("stored: the scan reads the commit's true objects, as the isolated read does: a .gitattributes blob replaced in refs/replace is scanned as committed (attribute-value-ambiguous)", async () => {
  // Why: the isolated read has no refs and sees the committed blob; a scan that followed the
  // replacement would read another text than the one Git answered from.
  const repo = scratchRepository("replaced");
  const hunks = repo.hunksOf([["bun.lock", LOCK_BEFORE, LOCK_AFTER]]);
  const committed = "bun.lock linguist-generated=unset\n";
  const revision = repo.commit({
    "bun.lock": LOCK_AFTER,
    ".gitattributes": committed,
  });
  const original = repo.run("rev-parse", `${revision}:.gitattributes`);
  repo.run("replace", original, repo.blobOf("*.md text\n"));
  expect(repo.run("cat-file", "blob", original)).toBe("*.md text");
  const stored = await storedRulesIn(
    "replaced",
    repo.repository,
    revision,
    hunks,
  );
  expect(generatedByPathIn(stored.rules)).toEqual({ "bun.lock": AMBIGUOUS });
}, 120_000);
