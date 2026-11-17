import { existsSync } from "node:fs";
import { graphTestPrerequisite } from "../../../scripts/graph-test-prerequisite.ts";
import {
  captureOutlineSource,
  outlineExecutable,
} from "../src/graph-outline.ts";
// Why (10.109): lanes are assigned per changed line range, grouped by responsibility, and a file is
// one unit per lane. A mistake here is silent downstream: a new file judged as one thing, a line owned
// by two sections or by none, or one file's same-lane changes split into several units would each pass
// as a reviewed packet. These tests hold the cut (structure, not size), the exact ownership the review
// rules gave, the join by lane, and what each unit's review then reads.
import { expect, test } from "bun:test";

import type { ManifestHunk } from "../src/manifest.ts";

import { sectionIdentities } from "../src/section-identity.ts";
import {
  asStructure,
  computeBlobStructure,
  sectionPlace,
  sectionsOf,
  structureOf as graphStructureOf,
  type BlobStructure,
  type Section,
  type Structure,
} from "../src/sections.ts";
import {
  diff,
  manifestHunk,
  oidOf,
  unchangedFixture,
} from "./section-fixtures.ts";

import { readOutlines } from "../src/graph-outline.ts";

const SOURCE = `import { a } from "a";
import { b } from "b";

export const Schema = a();
export type Schema = typeof Schema;

describe("links", () => {
  test("a revoked link is refused", () => {
    expect(b()).toBe(1);
  });

  test("a live link opens", () => {
    expect(b()).toBe(2);
  });
});

class Cache {
  get() {
    return 1;
  }
  set() {
    return 2;
  }
}
`;

// The section tests use several source strings. Preload their Graph views before synchronous assertions.
const fixtureSource = SOURCE;
const fixtureOutline = await readOutlines(
  [{ path: "links.test.ts", bytes: new TextEncoder().encode(SOURCE) }],
  captureOutlineSource(),
);
const structureOf = (path: string, text: string) =>
  graphStructureOf(
    path,
    text,
    text === fixtureSource
      ? fixtureOutline.context("links.test.ts")
      : { kind: "unavailable" },
  );

// These cases read declarations from the built Graph engine; without it every structure is
// unavailable, so they need it (`bun run build:graph`).
const graphPrerequisite = graphTestPrerequisite({
  available: existsSync(outlineExecutable()),
  message:
    "Graph engine is missing at apps/neuve-graph/entire-graph. Run `bun run build:graph` from the workspace root.",
});

test("a file's structure: imports as one block, a declaration with its namesake, a suite opened into its tests, a class kept whole", () => {
  const structure = structureOf("links.test.ts", SOURCE);
  expect(structure.capability).toBe("graph-symbols");
  if (structure.capability === "none") return;
  expect(
    structure.spans.map((span) => [
      span.kind,
      span.start,
      span.end,
      span.name ?? "",
    ]),
  ).toEqual([
    ["imports", 1, 2, ""],
    ["declaration", 3, 5, "Schema"],
    ["head", 6, 7, '"links"'],
    ["member", 8, 10, '"a revoked link is refused"'],
    ["member", 11, 14, '"a live link opens"'],
    ["tail", 15, 15, '"links"'],
    // A class shares one state and lifecycle: it is one responsibility (round 1).
    ["declaration", 16, 24, "Cache"],
  ]);
  // A test's own body is one responsibility: it is not opened into its statements.
  expect(
    structure.spans.filter((span) => span.start > 8 && span.end < 10),
  ).toEqual([]);
  // Markdown is cut at its headings; a file no capability reads has no structure.
  const doc = structureOf(
    "plan.md",
    "# Plan\nintro\n## Done when\n- it works\n",
  );
  expect(
    doc.capability === "markdown-sections" && doc.spans.map((s) => s.name),
  ).toEqual(["Plan", "Done when"]);
  expect(structureOf("run.sh", "echo hi\n")).toEqual({
    capability: "none",
    reason: "capability-unavailable",
  });
});

const lines = SOURCE.split("\n").length - 1;
const added = (id: string, path: string, oid: string): ManifestHunk =>
  ({
    hunkId: id,
    kind: "text",
    path,
    oldPath: null,
    newPath: path,
    oldOid: null,
    newOid: oid,
    status: "added",
    oldMode: null,
    newMode: "100644",
    oldStart: 0,
    oldLines: 0,
    newStart: 1,
    newLines: lines,
    added: lines,
    deleted: 0,
    text: `@@ -0,0 +1,${lines} @@\n${SOURCE.split("\n")
      .slice(0, lines)
      .map((line) => `+${line}`)
      .join("\n")}\n`,
    textSha256: id,
    enclosing: null,
    query: null,
    ownedRanges: [{ side: "new", startLine: 1, lineCount: lines }],
    qualifications: [],
    declared: [],
    countsTowardReviewLines: true,
    allowance: { tokens: 4_000, exactShare: 0, floored: true },
  }) as ManifestHunk;

const owned = (
  ranges: ReadonlyArray<{ side: string; startLine: number; lineCount: number }>,
) =>
  ranges.flatMap((range) =>
    Array.from(
      { length: range.lineCount },
      (_, i) => `${range.side}:${range.startLine + i}`,
    ),
  );

test("a newly added file is cut into its parts, and the parts own exactly the lines the review rules gave the hunk", () => {
  const oid = "b".repeat(40);
  const hunk = added("h1", "links.test.ts", oid);
  const structures = new Map<string, Structure>([
    [oid, structureOf("links.test.ts", SOURCE)],
  ]);
  const sections = sectionsOf([hunk], structures);
  // One hunk, seven parts: no part is the whole file.
  expect(sections.map((section) => [section.kind, section.name ?? ""])).toEqual(
    [
      ["imports", ""],
      ["declaration", "Schema"],
      ["head", '"links"'],
      ["member", '"a revoked link is refused"'],
      ["member", '"a live link opens"'],
      ["tail", '"links"'],
      ["declaration", "Cache"],
    ],
  );
  const all = sections.flatMap((section) => owned(section.ranges));
  expect(new Set(all).size).toBe(all.length);
  expect([...all].sort()).toEqual(owned(hunk.ownedRanges).sort());
  // Without a structure the file is one section, and says why: no capability reads it, or its
  // blob could not be read.
  const undeclared = sectionsOf(
    [hunk],
    new Map<string, Structure>([
      [oid, { capability: "none", reason: "unsupported-language" }],
    ]),
  );
  expect(undeclared.map((section) => [section.kind, section.basis])).toEqual([
    ["hunk", "unsupported-language"],
  ]);
  expect(sectionsOf([hunk], new Map()).map((section) => section.basis)).toEqual(
    ["unreadable"],
  );
  // A hunk whose changed rows the review rules account differently keeps the rules' ranges whole.
  const odd = {
    ...hunk,
    ownedRanges: [{ side: "new" as const, startLine: 1, lineCount: 3 }],
  };
  const kept = sectionsOf([odd], structures);
  expect(kept.map((section) => [section.basis, section.ranges])).toEqual([
    ["rules", [{ hunkId: "h1", side: "new", startLine: 1, lineCount: 3 }]],
  ]);
});

test("a replacement goes with its new lines; a removal between declarations goes with the removed declaration", () => {
  const head = "c".repeat(40);
  const base = "d".repeat(40);
  const structures = new Map<string, Structure>([
    [
      head,
      {
        capability: "graph-symbols",
        spans: [
          { start: 1, end: 10, name: "one", kind: "declaration" },
          { start: 11, end: 20, name: "two", kind: "declaration" },
        ],
      },
    ],
    [
      base,
      {
        capability: "graph-symbols",
        spans: [
          { start: 1, end: 10, name: "one", kind: "declaration" },
          { start: 11, end: 14, name: "gone", kind: "declaration" },
          { start: 15, end: 24, name: "two", kind: "declaration" },
        ],
      },
    ],
  ]);
  // Line 5 of `one` replaced; then `gone` (base 11-14) removed between `one` and `two`.
  const hunk = {
    ...added("h1", "a.ts", head),
    status: "modified",
    oldPath: "a.ts",
    oldOid: base,
    oldStart: 4,
    newStart: 4,
    text: "@@ -4,12 +4,8 @@\n ctx\n-old five\n+new five\n ctx\n ctx\n ctx\n ctx\n ctx\n-g1\n-g2\n-g3\n-g4\n ctx\n",
    ownedRanges: [
      { side: "old" as const, startLine: 5, lineCount: 1 },
      { side: "new" as const, startLine: 5, lineCount: 1 },
      { side: "old" as const, startLine: 11, lineCount: 4 },
    ],
  } as ManifestHunk;
  const sections = sectionsOf([hunk], structures);
  expect(
    sections.map((section) => [
      section.name,
      section.ranges.map((r) => [r.side, r.startLine, r.lineCount]),
    ]),
  ).toEqual([
    [
      "one",
      [
        ["old", 5, 1],
        ["new", 5, 1],
      ],
    ],
    ["gone", [["old", 11, 4]]],
  ]);
});

test("changes to several members of one class are one section, across hunks", async () => {
  const source = [
    "class Holder {",
    "  private inFlight = 0;",
    "  begin() {",
    "    this.inFlight++;",
    "  }",
    "  end() {",
    "    this.inFlight--;",
    "  }",
    "  close() {",
    "    return 1;",
    "  }",
    "}",
    "",
  ].join("\n");
  const outlines = await readOutlines(
    [{ path: "holder.ts", bytes: new TextEncoder().encode(source) }],
    captureOutlineSource(),
  );
  const structure = graphStructureOf(
    "holder.ts",
    source,
    outlines.context("holder.ts"),
  );
  // The cut keeps the span's text hash, which the counterpart rule matches unchanged spans by.
  expect(structure.capability === "graph-symbols" && structure.spans).toEqual([
    {
      start: 1,
      end: 12,
      name: "Holder",
      kind: "declaration",
      textSha256: expect.any(String),
    },
  ]);
  const oid = "e".repeat(40);
  const edit = (id: string, line: number): ManifestHunk =>
    ({
      ...added(id, "holder.ts", oid),
      status: "modified",
      oldPath: "holder.ts",
      oldOid: null,
      oldStart: line,
      newStart: line,
      text: `@@ -${line},1 +${line},1 @@\n-old\n+new\n`,
      ownedRanges: [
        { side: "old" as const, startLine: line, lineCount: 1 },
        { side: "new" as const, startLine: line, lineCount: 1 },
      ],
    }) as ManifestHunk;
  const sections = sectionsOf(
    [edit("h1", 4), edit("h2", 7), edit("h3", 10)],
    new Map([[oid, structure]]),
  );
  expect(sections.map((section) => [section.name, section.hunkIds])).toEqual([
    ["Holder", ["h1", "h2", "h3"]],
  ]);
  // It owns exactly the lines the review rules gave the three hunks, no more and none twice.
  expect(
    sections[0]!.ranges.map((range) => [
      range.hunkId,
      range.side,
      range.startLine,
      range.lineCount,
    ]),
  ).toEqual([
    ["h1", "old", 4, 1],
    ["h1", "new", 4, 1],
    ["h2", "old", 7, 1],
    ["h2", "new", 7, 1],
    ["h3", "old", 10, 1],
    ["h3", "new", 10, 1],
  ]);
});

// Graph may stop exposing children inside the nested suite. Its range stays whole until supplied.
test("nested describe and it calls use exposed outline ranges and never open class members", async () => {
  const text =
    'describe("outer", () => {\n describe("inner", () => {\n  it("nested", () => {\n   expect(1).toBe(1);\n  });\n });\n it("sibling", () => {\n  expect(2).toBe(2);\n });\n});\n';
  const outlines = await readOutlines(
    [
      { path: "nested.test.ts", bytes: new TextEncoder().encode(text) },
      { path: "a.unknown", bytes: new TextEncoder().encode("text\n") },
    ],
    captureOutlineSource(),
  );
  const structure = graphStructureOf(
    "nested.test.ts",
    text,
    outlines.context("nested.test.ts"),
  );
  expect(structure.capability).toBe("graph-symbols");
  if (structure.capability === "none") throw new Error("missing outline");
  expect(
    structure.spans.map((span) => [span.start, span.end, span.kind]),
  ).toEqual([
    [1, 1, "head"],
    [2, 6, "member"],
    [7, 9, "member"],
    [10, 10, "tail"],
  ]);
  expect(outlines.context("a.unknown").kind).toBe("available");
  expect(
    graphStructureOf("a.unknown", "text\n", outlines.context("a.unknown")),
  ).toEqual({ capability: "none", reason: "unsupported-language" });
});

// Pairing removals with the declaration they were removed from (NEU-148). Inputs are real Graph
// structures of small TypeScript files (`computeBlobStructure`, as the stored structure is made),
// and hunks as Git prints them.

const PAIRING_BASE = `import { a } from "a";

export function alpha(x: number) {
  const y = x + 1;
  return a(y);
}

export function beta(y: number) {
  const z = y + 1;
  return z;
}

export function gamma(z: number) {
  return z * 2;
}

export function delta(w: number) {
  return w - 1;
}

export function epsilon() {
  return 5;
}
`;
/** `beta` deleted whole, and a comment added to `gamma` in the same block. */
const DELETED_INTO_NEIGHBOUR = PAIRING_BASE.replace(
  `export function beta(y: number) {
  const z = y + 1;
  return z;
}

export function gamma`,
  `// doubles
export function gamma`,
);
/** `delta` renamed `dagger` in place. */
const RENAMED = PAIRING_BASE.replace("function delta(", "function dagger(");
/** One line removed from inside `alpha`, nothing added. */
const REMOVED_INSIDE = PAIRING_BASE.replace("  const y = x + 1;\n", "");
/** All three at once. */
const MIXED = DELETED_INTO_NEIGHBOUR.replace(
  "function delta(",
  "function dagger(",
).replace("  const y = x + 1;\n", "");

const pairingTexts = {
  PAIRING_BASE,
  DELETED_INTO_NEIGHBOUR,
  RENAMED,
  REMOVED_INSIDE,
  MIXED,
};
const pairingOutlines = await readOutlines(
  Object.entries(pairingTexts).map(([name, text]) => ({
    path: `${name}/pairing.ts`,
    bytes: new TextEncoder().encode(text),
  })),
  captureOutlineSource(),
);
const storedOf = (text: string): BlobStructure => {
  const name = Object.entries(pairingTexts).find(
    ([, value]) => value === text,
  )![0];
  return computeBlobStructure(
    "src/pairing.ts",
    text,
    pairingOutlines.context(`${name}/pairing.ts`),
  ).structure;
};

/** The sections of one change, with both blobs' stored structures. */
const paired = (before: string, after: string) => {
  const hunks = diff("src/pairing.ts", before, after);
  const structures = new Map<string, BlobStructure>([
    [oidOf(before), storedOf(before)],
    [oidOf(after), storedOf(after)],
  ]);
  const sections = sectionsOf(
    hunks,
    new Map(
      [...structures].map(([oid, structure]) => [oid, asStructure(structure)]),
    ),
  );
  return { hunks, structures, sections };
};

const shape = (sections: ReadonlyArray<Section>) =>
  sections.map((section) => [
    section.name ?? null,
    sectionPlace(section).side,
    section.ranges.map(
      (range) => `${range.side}:${range.startLine}+${range.lineCount}`,
    ),
  ]);

test("without structures, sections are exactly as at a96fc634 (with the switch off, a review's units must be byte-identical)", () => {
  // Computed from `sections.ts` at a96fc634 on `unchangedFixture()`: [key, path, name, kind,
  // basis, hunkIds, ranges, first].
  const expected = [
    [
      "bin/run.sh\u0000nontext:hafc420529077edf",
      "bin/run.sh",
      null,
      "nontext",
      "nontext",
      ["hafc420529077edf"],
      [],
      0,
    ],
    [
      "img/logo.png\u0000nontext:he94c921d2580442",
      "img/logo.png",
      null,
      "nontext",
      "nontext",
      ["he94c921d2580442"],
      [["he94c921d2580442", "new", 1, 1]],
      0,
    ],
    [
      "src/a.ts\u0000hunk:hae26eb94666352c",
      "src/a.ts",
      null,
      "hunk",
      "unreadable",
      ["hae26eb94666352c"],
      [
        ["hae26eb94666352c", "old", 2, 1],
        ["hae26eb94666352c", "new", 2, 1],
      ],
      2,
    ],
    [
      "src/a.ts\u0000hunk:he6de76e4eb43770",
      "src/a.ts",
      null,
      "hunk",
      "unreadable",
      ["he6de76e4eb43770"],
      [
        ["he6de76e4eb43770", "old", 8, 1],
        ["he6de76e4eb43770", "old", 11, 1],
        ["he6de76e4eb43770", "new", 10, 2],
      ],
      8,
    ],
    [
      "src/gone.ts\u0000hunk:h641b03c8400f71f",
      "src/gone.ts",
      null,
      "hunk",
      "unreadable",
      ["h641b03c8400f71f"],
      [["h641b03c8400f71f", "old", 2, 2]],
      2,
    ],
    [
      "src/moved.ts\u0000hunk:hf1ee9805daaaec4",
      "src/moved.ts",
      null,
      "hunk",
      "unreadable",
      ["hf1ee9805daaaec4"],
      [
        ["hf1ee9805daaaec4", "old", 2, 1],
        ["hf1ee9805daaaec4", "new", 2, 1],
      ],
      2,
    ],
    [
      "src/new.ts\u0000hunk:h6f9ae1811351a22",
      "src/new.ts",
      null,
      "hunk",
      "unreadable",
      ["h6f9ae1811351a22"],
      [["h6f9ae1811351a22", "new", 1, 2]],
      1,
    ],
    [
      "src/odd.ts\u0000hunk:hcd661b1e67c2cc6",
      "src/odd.ts",
      null,
      "hunk",
      "rules",
      ["hcd661b1e67c2cc6"],
      [["hcd661b1e67c2cc6", "new", 2, 1]],
      2,
    ],
  ];
  const sections = sectionsOf(unchangedFixture(), new Map());
  expect(
    sections.map((s) => [
      s.key,
      s.path,
      s.name ?? null,
      s.kind,
      s.basis,
      s.hunkIds,
      s.ranges.map((r) => [r.hunkId, r.side, r.startLine, r.lineCount]),
      s.first,
    ]),
  ).toEqual(expected);
  // Field names and order on `Section` are what compose reads.
  expect(sections.map((section) => Object.keys(section))).toEqual(
    sections.map(() => [
      "key",
      "path",
      "name",
      "kind",
      "basis",
      "hunkIds",
      "first",
      "ranges",
    ]),
  );
});

test.skipIf(graphPrerequisite.skip)(
  "a block that deletes all of one declaration and adds a line to its neighbour gives the removal to the deleted declaration (it was credited to the neighbour)",
  () => {
    graphPrerequisite.require();
    const { sections } = paired(PAIRING_BASE, DELETED_INTO_NEIGHBOUR);
    expect(shape(sections)).toEqual([
      // The blank line Git removed after `beta` was `gamma`'s; `beta`'s own lines are on the old side.
      ["gamma", "new", ["old:12+1", "new:8+1"]],
      ["beta", "old", ["old:8+4"]],
    ]);
  },
);

test.skipIf(graphPrerequisite.skip)(
  "a declaration renamed in place stays one section (the pairing must not split a replacement)",
  () => {
    graphPrerequisite.require();
    const { sections } = paired(PAIRING_BASE, RENAMED);
    expect(shape(sections)).toEqual([
      ["dagger", "new", ["old:17+1", "new:17+1"]],
    ]);
  },
);

test.skipIf(graphPrerequisite.skip)(
  "rows removed from inside a declaration with nothing added stay its own (the commonest removal)",
  () => {
    graphPrerequisite.require();
    const { sections } = paired(PAIRING_BASE, REMOVED_INSIDE);
    expect(shape(sections)).toEqual([["alpha", "new", ["old:4+1"]]]);
  },
);

test.skipIf(graphPrerequisite.skip)(
  "every row the review rules own is in exactly one section, on a change mixing all of the above (ownership is the rules', 10.21)",
  () => {
    graphPrerequisite.require();
    const { hunks, sections } = paired(PAIRING_BASE, MIXED);
    expect(shape(sections)).toEqual([
      ["alpha", "new", ["old:4+1"]],
      ["gamma", "new", ["old:12+1", "new:7+1"]],
      ["beta", "old", ["old:8+4"]],
      ["dagger", "new", ["old:17+1", "new:12+1"]],
    ]);
    const all = sections.flatMap((section) =>
      owned(
        section.ranges.map((range) => ({
          ...range,
          side: `${range.hunkId}:${range.side}`,
        })),
      ),
    );
    expect(new Set(all).size).toBe(all.length);
    expect([...all].sort()).toEqual(
      hunks
        .flatMap((hunk) =>
          owned(
            hunk.ownedRanges.map((range) => ({
              ...range,
              side: `${hunk.hunkId}:${range.side}`,
            })),
          ),
        )
        .sort(),
    );
  },
);

test.skipIf(graphPrerequisite.skip)(
  "section identities are given for the new pairing's output: an old-side-only section, a renamed declaration, a renamed file and a mode change (two lanes read identities from it)",
  () => {
    graphPrerequisite.require();
    const { hunks, structures, sections } = paired(PAIRING_BASE, MIXED);
    const moved = diff("src/moved.ts", PAIRING_BASE, RENAMED, {
      status: "renamed",
      oldPath: "src/was.ts",
    });
    const mode = manifestHunk({
      path: "bin/run.sh",
      kind: "metadata",
      text: "old mode 100644\nnew mode 100755",
      oldStart: 0,
      newStart: 0,
      oldOid: oidOf("run"),
      newOid: oidOf("run"),
      newMode: "100755",
      ownedRanges: [],
    });
    const all = [...hunks, ...moved, mode];
    structures.set(oidOf(RENAMED), storedOf(RENAMED));
    const allSections = sectionsOf(
      all,
      new Map(
        [...structures].map(([oid, structure]) => [
          oid,
          asStructure(structure),
        ]),
      ),
    );
    const identities = sectionIdentities(
      allSections,
      new Map(all.map((hunk) => [hunk.hunkId, hunk])),
      structures,
    );
    expect(identities.size).toBe(allSections.length);
    expect(allSections.length).toBe(sections.length + 2);
    const beta = [...identities.values()].find(
      (identity) => identity.parts.name === "beta",
    )!;
    expect([beta.parts.side, beta.where]).toEqual([
      "old",
      { startLine: 7, endLine: 11 },
    ]);
    const dagger = [...identities.values()].filter(
      (identity) => identity.parts.name === "dagger",
    );
    expect(
      dagger.map((identity) => [identity.parts.path, identity.renamedFrom]),
    ).toEqual([
      ["src/moved.ts", "src/was.ts"],
      ["src/pairing.ts", null],
    ]);
    expect(
      [...identities.values()].filter(
        (identity) => identity.parts.kind === "nontext",
      ),
    ).toHaveLength(1);
  },
);

test.skipIf(graphPrerequisite.skip)(
  "deleting one of two Rust functions whose bodies end alike gives the removal to the deleted function (spans were named after Graph's body block, `a` for both, so the pairing matched the other function)",
  async () => {
    graphPrerequisite.require();
    const before =
      "fn first(a: i32) -> i32 {\n    let b = a + 1;\n    a\n}\n\nfn second(a: i32) -> i32 {\n    let b = a + 2;\n    a\n}\n";
    const after = "fn second(a: i32) -> i32 {\n    let b = a + 2;\n    a\n}\n";
    const outlines = await readOutlines(
      [
        { path: "base/lib.rs", bytes: new TextEncoder().encode(before) },
        { path: "head/lib.rs", bytes: new TextEncoder().encode(after) },
      ],
      captureOutlineSource(),
    );
    const structures = new Map<string, Structure>([
      [
        oidOf(before),
        graphStructureOf("lib.rs", before, outlines.context("base/lib.rs")),
      ],
      [
        oidOf(after),
        graphStructureOf("lib.rs", after, outlines.context("head/lib.rs")),
      ],
    ]);
    const names = (text: string) => {
      const structure = structures.get(oidOf(text))!;
      return structure.capability === "none"
        ? []
        : structure.spans.map((span) => span.name);
    };
    expect([names(before), names(after)]).toEqual([
      ["first", "second"],
      ["second"],
    ]);
    const sections = sectionsOf(diff("src/lib.rs", before, after), structures);
    // The blank line after `first` is the start of `second`'s span, so it stays `second`'s.
    expect(shape(sections)).toEqual([
      ["first", "old", ["old:1+4"]],
      ["second", "new", ["old:5+1"]],
    ]);
  },
);

/** The sections of one change in any language, with both sides' stored structures from Graph. */
const pairedOnGraph = async (path: string, before: string, after: string) => {
  const outlines = await readOutlines(
    [
      { path: `base/${path}`, bytes: new TextEncoder().encode(before) },
      { path: `head/${path}`, bytes: new TextEncoder().encode(after) },
    ],
    captureOutlineSource(),
  );
  const structures = new Map<string, Structure>([
    [
      oidOf(before),
      asStructure(
        computeBlobStructure(path, before, outlines.context(`base/${path}`))
          .structure,
      ),
    ],
    [
      oidOf(after),
      asStructure(
        computeBlobStructure(path, after, outlines.context(`head/${path}`))
          .structure,
      ),
    ],
  ]);
  return sectionsOf(diff(path, before, after), structures);
};

test.skipIf(graphPrerequisite.skip)(
  "deleting a test from the first of two suites that both have a test of that name gives the rows to the deleted test, not to the other suite's (same-named declarations were matched by occurrence)",
  async () => {
    graphPrerequisite.require();
    const before = `describe("a", () => {
  it("works", () => {
    expect(1).toBe(1);
  });
  it("fails", () => {
    expect(2).toBe(2);
  });
});
describe("b", () => {
  it("works", () => {
    expect(3).toBe(3);
  });
});
`;
    const after = before.replace(
      `  it("works", () => {
    expect(1).toBe(1);
  });
`,
      "",
    );
    const sections = await pairedOnGraph("suite.test.ts", before, after);
    expect(shape(sections)).toEqual([['"works"', "old", ["old:2+3"]]]);
  },
);

test("deleting the first of two Markdown sections of one name gives the rows to the deleted one (they landed in the second)", () => {
  const before =
    "## Usage\nfirst use\n\n## Other\nother\n\n## Usage\nsecond use\n";
  const after = "## Other\nother\n\n## Usage\nsecond use\n";
  const structures = new Map<string, Structure>(
    [before, after].map((text) => [
      oidOf(text),
      asStructure(
        computeBlobStructure("guide.md", text, { kind: "unavailable" })
          .structure,
      ),
    ]),
  );
  const sections = sectionsOf(diff("guide.md", before, after), structures);
  expect(shape(sections)).toEqual([["Usage", "old", ["old:1+3"]]]);
});

test.skipIf(graphPrerequisite.skip)(
  "deleting one of two Go methods of one name gives the rows to the deleted method (they landed in the other type's method)",
  async () => {
    graphPrerequisite.require();
    const before = `package p

func (a A) String() string {
	return "a"
}

func other() {}

func (b B) String() string {
	return "b"
}
`;
    const after = `package p

func other() {}

func (b B) String() string {
	return "b"
}
`;
    const sections = await pairedOnGraph("names.go", before, after);
    // The blank line Git removed after the method is the start of `other`'s span.
    expect(shape(sections)).toEqual([
      ["other", "new", ["old:6+1"]],
      ["String", "old", ["old:3+3"]],
    ]);
  },
);

test.skipIf(graphPrerequisite.skip)(
  "a TypeScript declaration of several names is named after the first, as Graph orders them (the greatest extent renamed it after a later one)",
  async () => {
    graphPrerequisite.require();
    const text = "export const a = 1, b = () => {\n  return 1;\n};\n";
    const outlines = await readOutlines(
      [{ path: "names.ts", bytes: new TextEncoder().encode(text) }],
      captureOutlineSource(),
    );
    const structure = graphStructureOf(
      "names.ts",
      text,
      outlines.context("names.ts"),
    );
    expect(
      structure.capability === "none" ? [] : structure.spans.map((s) => s.name),
    ).toEqual(["a"]);
  },
);

/** The sections of a Markdown change: its structure needs no Graph. */
const pairedMarkdown = (before: string, after: string) => {
  const structures = new Map<string, Structure>(
    [before, after].map((text) => [
      oidOf(text),
      asStructure(
        computeBlobStructure("steps.md", text, { kind: "unavailable" })
          .structure,
      ),
    ]),
  );
  return sectionsOf(diff("steps.md", before, after), structures);
};

// Why: two declarations of one name are told apart by their text first, then by occurrence only
// where both sides hold as many; any other matching credits one twin's change to the other.
test("twins of one name with only the first changed: the first matches the first, the second the second", () => {
  expect(
    shape(pairedMarkdown("# Step\nA\n# Step\nA\n", "# Step\nA1\n# Step\nA\n")),
  ).toEqual([["Step", "new", ["old:2+1", "new:2+1"]]]);
  expect(
    sectionPlace(
      pairedMarkdown("# Step\nA\n# Step\nA\n", "# Step\nA1\n# Step\nA\n")[0]!,
    ),
  ).toEqual({ side: "new", startLine: 1, endLine: 2 });
});

test("twins of one name with only the second changed: the change is the second's", () => {
  const sections = pairedMarkdown(
    "# Step\nA\n# Step\nA\n",
    "# Step\nA\n# Step\nA2\n",
  );
  expect(shape(sections)).toEqual([["Step", "new", ["old:4+1", "new:4+1"]]]);
  expect(sectionPlace(sections[0]!)).toEqual({
    side: "new",
    startLine: 3,
    endLine: 4,
  });
});

test("twins of one name both changed: each is matched by occurrence", () => {
  const sections = pairedMarkdown(
    "# Step\nA\n# Step\nB\n",
    "# Step\nA1\n# Step\nB2\n",
  );
  expect(sections.map((section) => sectionPlace(section))).toEqual([
    { side: "new", startLine: 1, endLine: 2 },
    { side: "new", startLine: 3, endLine: 4 },
  ]);
  expect(shape(sections).map(([, , ranges]) => ranges)).toEqual([
    ["old:2+1", "new:2+1"],
    ["old:4+1", "new:4+1"],
  ]);
});

test("one of two identical declarations deleted: neither has a counterpart, the removed rows are an old-side section of their own, the survivor forms none", () => {
  expect(
    shape(pairedMarkdown("# Step\nA\n# Step\nA\n", "# Step\nA\n")),
  ).toEqual([["Step", "old", ["old:3+2"]]]);
});

test("the first of two same-named declarations with different text deleted: the survivor matches itself by text, the deleted one has no counterpart", () => {
  // Git aligns the survivor's heading with the first one's: the base heading it removed is the
  // survivor's, so that row stays the survivor's, and the deleted body is the deleted one's.
  expect(
    shape(pairedMarkdown("# Step\nA\n# Step\nB\n", "# Step\nB\n")),
  ).toEqual([
    ["Step", "new", ["old:3+1"]],
    ["Step", "old", ["old:2+1"]],
  ]);
});

test("a same-named declaration inserted before an existing one: the existing one keeps its counterpart, the inserted one has none", () => {
  const sections = pairedMarkdown("# Step\nB\n", "# Step\nA\n# Step\nB\n");
  expect(
    sections.map((section) => [
      sectionPlace(section),
      section.ranges.map((range) => `${range.side}:${range.startLine}`),
    ]),
  ).toEqual([
    [{ side: "new", startLine: 1, endLine: 2 }, ["new:2"]],
    [{ side: "new", startLine: 3, endLine: 4 }, ["new:3"]],
  ]);
});

test("a declaration moved unchanged is its own counterpart: its removed and added rows are one section", () => {
  expect(shape(pairedMarkdown("# A\na\n# B\nb\n", "# B\nb\n# A\na\n"))).toEqual(
    [["A", "new", ["old:1+2", "new:3+2"]]],
  );
});
