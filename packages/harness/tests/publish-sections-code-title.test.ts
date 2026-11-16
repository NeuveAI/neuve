// Why: a unit's title written by code is what a reviewer reads first on the desk. On real reviews
// it repeated the file ("snapshot.ts: CompactSnapshotDecoder in snapshot.ts"), listed every part
// in Records' order rather than line order (a lockfile's hunks have no span, so they fell back to
// their keys), and was cut mid-word at 512 characters. The file must appear once; the parts come
// in the order they start in the file (the new side's start, an old-only part where it was, a part
// with no lines first); the title names the first part and counts the rest ("and N more"); and it
// is at most 120 characters, ending at a word boundary with "…".
import { expect, test } from "bun:test";
import { Effect } from "effect";
import { PublishedPackets, mintUlid } from "@neuve/records-core";
import { publishSettled } from "../src/publish-sections.ts";
import {
  TITLE_MAX,
  boundTitle,
  codeTitle,
  codeTitles,
  unitSections,
} from "../src/publish-sections-input.ts";
import type { SettledSection } from "../src/publish-sections.ts";
import {
  batchOf,
  inputOf,
  lines,
  scratch,
  section,
  unit,
} from "./publish-sections-fixtures.ts";

const path = "src/records/snapshot.ts";

const titled = (
  title: string,
  label: string,
  startLine: number,
  name: string | null,
  kind = "function",
): SettledSection => ({
  ...section({
    label,
    path,
    kind,
    name,
    where: { startLine, endLine: startLine + 1 },
    ranges: lines(path, startLine, 1),
    lane: "agentic",
  }),
  title,
});

type Range = SettledSection["ownedRanges"][number];
const newLines = (startLine: number, endLine = startLine): Range => ({
  kind: "lines",
  path,
  side: "new",
  startLine,
  endLine,
});
const oldLines = (startLine: number, endLine = startLine): Range => ({
  kind: "lines",
  path,
  side: "old",
  startLine,
  endLine,
});

/** A section as the sections lane gives it, with the side, span and owned ranges a test names. */
const part = (
  title: string,
  options: {
    readonly label: string;
    readonly side: "new" | "old" | "none";
    readonly where: { startLine: number; endLine: number } | null;
    readonly ranges: ReadonlyArray<Range>;
    readonly key?: string;
    readonly file?: string;
  },
): SettledSection => {
  const base = section({
    label: options.label,
    path: options.file ?? path,
    kind: options.side === "none" ? "hunk" : "declaration",
    name: null,
    where: { startLine: 1, endLine: 1 },
    ranges: [...options.ranges],
    lane: "agentic",
    ...(options.key === undefined ? {} : { keyOverride: options.key }),
  });
  return {
    ...base,
    identity: {
      ...base.identity,
      parts: { ...base.identity.parts, side: options.side },
      where: options.where,
    },
    title,
  };
};

const blobOf = (
  settled: ReturnType<typeof unit>,
  sections: ReadonlyArray<SettledSection>,
) =>
  unitSections(
    settled,
    new Map(sections.map((s) => [s.identity.key, s] as const)),
  );

const titleOf = (sections: ReadonlyArray<SettledSection>, file = path) => {
  const settled = unit(file, "agentic", sections);
  return codeTitle(settled, blobOf(settled, sections));
};

/** The code titles of units of the file, each in its lane with its sections, made together. */
const titlesOf = (
  units: ReadonlyArray<
    readonly [ReturnType<typeof unit>["lane"], ReadonlyArray<SettledSection>]
  >,
) =>
  codeTitles(
    units.map(([lane, sections]) => {
      const settled = unit(path, lane, sections);
      return { unit: settled, blob: blobOf(settled, sections) };
    }),
  );

const LANE_WORDS = /agentic|human|static|automation|suggested|required/i;

const decoder = titled(
  "CompactSnapshotDecoder in snapshot.ts",
  "class",
  10,
  "CompactSnapshotDecoder",
  "class",
);
const readSnapshot = titled(
  "readSnapshot in snapshot.ts",
  "fn",
  40,
  "readSnapshot",
);
const wholeFile = titled("snapshot.ts", "file", 1, null, "file");
const imports = titled("imports in snapshot.ts", "imports", 2, null, "imports");
const unnamed = titled("snapshot.ts at line 60", "block", 60, null, "block");
const elsewhere = titled("decode in codec.ts", "other", 80, "decode");

test("the title names the file once and its first part, then counts the others", () => {
  // None: the file alone. One: the file and that part. Two: "and 1 more". Many: "and N more".
  expect(titleOf([])).toBe("snapshot.ts");
  expect(titleOf([decoder])).toBe("snapshot.ts: CompactSnapshotDecoder");
  expect(titleOf([readSnapshot, decoder])).toBe(
    "snapshot.ts: CompactSnapshotDecoder and 1 more",
  );
  expect(
    titleOf([elsewhere, unnamed, readSnapshot, wholeFile, imports, decoder]),
  ).toBe("snapshot.ts: imports and 5 more");
});

test("a unit with only a file-level section is titled by its file", () => {
  expect(titleOf([wholeFile])).toBe("snapshot.ts");
  // A part titled by the file alone adds no name, but it is still one of the unit's parts.
  expect(titleOf([wholeFile, readSnapshot])).toBe(
    "snapshot.ts: readSnapshot and 1 more",
  );
});

test("a section naming another file, or a name that only ends like the file, keeps its title", () => {
  expect(titleOf([elsewhere])).toBe("snapshot.ts: decode in codec.ts");
  const lookalike = titled("parse in old-snapshot.ts", "lookalike", 5, "parse");
  expect(titleOf([lookalike])).toBe("snapshot.ts: parse in old-snapshot.ts");
});

test("parts come in the order they start in the file, whatever their side or kind", () => {
  // In the order they must come: a part with no lines; a hunk with no span, by its first new line;
  // a part only on the old side, by where it was; a span on the new side whose old lines sit far
  // below (old and new numbers are not compared as one); a hunk only on the old side; a new span
  // that owns only an old line, by where it starts on the new side.
  const inOrder = [
    part("header in snapshot.ts", {
      label: "file-level",
      side: "none",
      where: null,
      ranges: [{ kind: "whole-nontext", path, side: "new" }],
    }),
    part("snapshot.ts at line 3", {
      label: "hunk",
      side: "none",
      where: null,
      ranges: [newLines(3), oldLines(3)],
    }),
    part("removedHelper in snapshot.ts", {
      label: "old-only",
      side: "old",
      where: { startLine: 8, endLine: 12 },
      ranges: [oldLines(9, 12)],
    }),
    part("decode in snapshot.ts", {
      label: "new-span",
      side: "new",
      where: { startLine: 10, endLine: 20 },
      ranges: [newLines(15), oldLines(4000)],
    }),
    part("snapshot.ts at line 14", {
      label: "old-hunk",
      side: "none",
      where: null,
      ranges: [oldLines(14, 15)],
    }),
    part("encode in snapshot.ts", {
      label: "new-span-old-line",
      side: "new",
      where: { startLine: 30, endLine: 40 },
      ranges: [oldLines(1)],
    }),
  ];
  const nameOf = (s: SettledSection) =>
    s.title.replace(/ in snapshot\.ts$/, "").replace(/^snapshot\.ts at /, "");
  for (let i = 0; i < inOrder.length; i++)
    for (let j = i + 1; j < inOrder.length; j++)
      expect(titleOf([inOrder[j]!, inOrder[i]!])).toBe(
        `snapshot.ts: ${nameOf(inOrder[i]!)} and 1 more`,
      );
  expect(titleOf([...inOrder].reverse())).toBe(
    "snapshot.ts: header and 5 more",
  );
  // Parts that start on the same line keep today's tie order, by key.
  const tied = (key: string, title: string) =>
    part(title, {
      label: key,
      side: "new",
      where: { startLine: 5, endLine: 6 },
      ranges: [newLines(5)],
      key: key.repeat(64),
    });
  expect(
    titleOf([
      tied("b", "second in snapshot.ts"),
      tied("a", "first in snapshot.ts"),
    ]),
  ).toBe("snapshot.ts: first and 1 more");
});

test("a title is at most 120 characters and ends at a word boundary with an ellipsis", () => {
  expect(TITLE_MAX).toBe(120);
  // "snapshot.ts: " is 13 characters, so a 107-character name makes a title exactly 120 long.
  const exact = `${"word ".repeat(21)}ab`;
  expect(exact.length).toBe(107);
  const atBound = titleOf([
    titled(`${exact} in snapshot.ts`, "exact", 5, exact),
  ]);
  expect(atBound).toBe(`snapshot.ts: ${exact}`);
  expect(atBound.length).toBe(120);
  // One character more: the last word that no longer fits goes, and "…" counts inside the 120.
  const words = `snapshot.ts: ${"word ".repeat(21).trimEnd()}…`;
  const over = `${exact}c`;
  const cut = titleOf([titled(`${over} in snapshot.ts`, "over", 5, over)]);
  expect(cut).toBe(words);
  expect(cut.length).toBeLessThanOrEqual(120);
  // The count of other parts is part of the title, so it is bounded with it.
  const long = titled(`${exact} in snapshot.ts`, "long", 5, exact);
  expect(titleOf([long, readSnapshot])).toBe(words);
  // A single word longer than the room is cut, and ends with "…".
  const word = "x".repeat(200);
  const oneWord = titleOf([titled(`${word} in snapshot.ts`, "word", 5, word)]);
  expect(oneWord).toBe(`snapshot.ts: ${"x".repeat(106)}…`);
  expect(oneWord.length).toBe(120);
  expect(boundTitle("y".repeat(300))).toBe(`${"y".repeat(119)}…`);
  // Never cut inside a word that would fit on its own, nor inside a surrogate pair.
  expect(boundTitle("alpha beta gamma", 13)).toBe("alpha beta…");
  expect(boundTitle("alpha beta  gamma", 12)).toBe("alpha beta…");
  expect(boundTitle(`${"a".repeat(8)}😀😀`, 10)).toBe(`${"a".repeat(8)}…`);
  expect(boundTitle("short")).toBe("short");
});

test("the real reviews' worst cases read as a file, a first part and a count", () => {
  // A lockfile whose eight hunks have no span: Records gave them in key order (100, 212, 1687,
  // 140, 164, 2821, 14, 1427), and the title listed them so. Keys here follow that order.
  const lock = "deps.lock";
  const hunkAt = (line: number, n: number) =>
    part(`${lock} at line ${line}`, {
      label: `lock-${line}`,
      side: "none",
      where: null,
      file: lock,
      ranges:
        line === 2821
          ? [{ ...oldLines(line, line + 1), path: lock }]
          : [
              { ...newLines(line), path: lock },
              { ...oldLines(line), path: lock },
            ],
      key: n.toString(16).padStart(64, "0"),
    });
  const hunks = [100, 212, 1687, 140, 164, 2821, 14, 1427].map((line, n) =>
    hunkAt(line, n + 1),
  );
  expect(titleOf(hunks, lock)).toBe("deps.lock: line 14 and 7 more");

  // A test file of eleven parts whose title ran past 512 characters and was cut mid-word.
  const file = "packages/client/tests/client-identity.test.ts";
  const base = "client-identity.test.ts";
  const spans: ReadonlyArray<readonly [string, number, number]> = [
    ["engine in", 15, 35],
    [
      '"concurrent cold inspections hash each configured file identity once" in',
      141,
      165,
    ],
    ['"cold inspections share version and capabilities" in', 80, 99],
    [`${base} at line 6`, 6, 12],
    ['"different digests run provider commands independently" in', 166, 195],
    [`${base} at line 100`, 100, 118],
    ["imports in", 1, 5],
    ["paired in", 36, 79],
    ['"cancelling every subscriber stops the provider run" in', 127, 140],
    ['"cancelling the holder preserves a live subscriber" in', 119, 126],
    [`${base} at line 13`, 13, 14],
  ];
  const parts = spans.map(([title, startLine, endLine], n) =>
    part(title.endsWith(" in") ? `${title} ${base}` : title, {
      label: `identity-${n}`,
      side: "new",
      where: { startLine, endLine },
      file,
      ranges: [{ ...newLines(startLine, endLine), path: file }],
    }),
  );
  const title = titleOf(parts, file);
  expect(title).toBe("client-identity.test.ts: imports and 10 more");
  expect(title.length).toBeLessThanOrEqual(120);
});

// Why: two units of other files can be given one code-built title (two manifests' "package.json:
// line 20"); the publisher tells the second apart with " (2)", and that number must not carry the
// title past its bound.
test("a code-built title told apart by its number stays within 120 characters", async () => {
  // "package.json: " is 14 characters, so this 106-character name makes a title exactly 120 long.
  const name = `${"word ".repeat(21)}a`;
  const sections = ["a/package.json", "b/package.json"].map((file, n) => ({
    ...section({
      label: `manifest-${n}`,
      path: file,
      name,
      where: { startLine: 20, endLine: 21 },
      ranges: lines(file, 20, 1),
      lane: "agentic",
    }),
    title: `${name} in package.json`,
  }));
  const units = sections.map((s) =>
    unit(s.identity.parts.path, "agentic", [s]),
  );
  const batch = batchOf(
    "Manifests",
    ["a/package.json", "b/package.json"],
    sections,
    units,
  );
  const cycleId = mintUlid();
  const store = scratch({ cycleId });
  const titles = await store.run(
    Effect.gen(function* () {
      yield* publishSettled(store.ctx(), inputOf([batch], { ending: true }));
      const read = yield* PublishedPackets.readStanding(cycleId);
      return read?.kind === "packet.published@2"
        ? read.batches[0]!.units.map((u) => u.recorded?.payload.title)
        : [];
    }),
  );
  expect(titles.sort()).toEqual([
    `package.json: ${name}`,
    `package.json: ${"word ".repeat(20).trimEnd()}… (2)`,
  ]);
  expect(titles.map((title) => title!.length)).toEqual([120, 118]);
});

// Why: the owner, on the desk: a unit's title must not name its lane ("(human required)"); the
// lane is already the track it sits in. Two units of one file are told apart by the parts their
// titles name, never by the lane; a file with one unit keeps today's title.
test("two units of one file in different lanes are told apart by their parts, never their lane", () => {
  const titles = titlesOf([
    ["agentic", [decoder, imports]],
    ["human-required", [readSnapshot]],
  ]);
  expect(titles).toEqual([
    "snapshot.ts: imports and 1 more",
    "snapshot.ts: readSnapshot",
  ]);
  for (const title of titles) expect(title).not.toMatch(LANE_WORDS);
  // A file with one unit: the same title as `codeTitle` alone gives it, as before.
  expect(titlesOf([["human-required", [decoder, readSnapshot]]])).toEqual([
    "snapshot.ts: CompactSnapshotDecoder and 1 more",
  ]);
  // Units of other files are never given lines, even when their titles read the same.
  const elsewhereUnit = unit("lib/snapshot.ts", "agentic", [decoder]);
  const hereUnit = unit(path, "human-required", [decoder]);
  expect(
    codeTitles([
      { unit: hereUnit, blob: blobOf(hereUnit, [decoder]) },
      { unit: elsewhereUnit, blob: blobOf(elsewhereUnit, [decoder]) },
    ]),
  ).toEqual([
    "snapshot.ts: CompactSnapshotDecoder",
    "snapshot.ts: CompactSnapshotDecoder",
  ]);
});

// Why: two units of one file can name the same parts (two "imports" sections, one per lane). The
// ruling: only then, the named part's lines tell them apart, as "lines 40–88" with an en dash;
// still no lane. The lines are kept whole when the title is cut at its bound.
test("two units of one file whose parts read the same are told apart by the named part's lines", () => {
  const importsAt = (
    label: string,
    startLine: number,
    endLine: number,
  ): SettledSection => {
    const s = titled(
      "imports in snapshot.ts",
      label,
      startLine,
      null,
      "imports",
    );
    return { ...s, identity: { ...s.identity, where: { startLine, endLine } } };
  };
  const titles = titlesOf([
    ["agentic", [importsAt("imports-a", 1, 1), readSnapshot]],
    [
      "human-required",
      [
        importsAt("imports-b", 40, 88),
        titled("encode in snapshot.ts", "encode", 120, "encode"),
      ],
    ],
  ]);
  expect(titles).toEqual([
    "snapshot.ts: imports (line 1) and 1 more",
    "snapshot.ts: imports (lines 40–88) and 1 more",
  ]);
  for (const title of titles) expect(title).not.toMatch(LANE_WORDS);
  // Only the units that share a title gain lines; a third unit of the file keeps its own.
  expect(
    titlesOf([
      ["agentic", [importsAt("imports-a", 1, 1)]],
      ["human-suggested", [importsAt("imports-b", 40, 88)]],
      ["human-required", [readSnapshot]],
    ]),
  ).toEqual([
    "snapshot.ts: imports (line 1)",
    "snapshot.ts: imports (lines 40–88)",
    "snapshot.ts: readSnapshot",
  ]);
  // A name too long to fit is cut before the lines, so the lines that tell the units apart stay.
  const word = "x".repeat(200);
  const long = (label: string, line: number) =>
    titled(`${word} in snapshot.ts`, label, line, word);
  const cut = titlesOf([
    ["agentic", [long("long-a", 5)]],
    ["human-required", [long("long-b", 70)]],
  ]);
  expect(cut).toEqual([
    `snapshot.ts: ${"x".repeat(106 - " (lines 5–6)".length)}… (lines 5–6)`,
    `snapshot.ts: ${"x".repeat(106 - " (lines 70–71)".length)}… (lines 70–71)`,
  ]);
  expect(cut.map((title) => title.length)).toEqual([120, 120]);
});

// Why: the publisher titles a batch's units together, so the lines reach what Records holds, and
// the number it adds stays for titles that still repeat.
test("the publisher records two same-named units of one file by their lines, with no lane", async () => {
  const file = "src/a.ts";
  const sections = [
    { label: "first", lane: "agentic" as const, startLine: 1, endLine: 9 },
    {
      label: "second",
      lane: "human-required" as const,
      startLine: 40,
      endLine: 88,
    },
  ].map(({ label, lane, startLine, endLine }) =>
    section({
      label,
      path: file,
      name: "imports",
      where: { startLine, endLine },
      ranges: lines(file, startLine, 1),
      lane,
    }),
  );
  const units = sections.map((s, n) =>
    unit(file, n === 0 ? "agentic" : "human-required", [s]),
  );
  const batch = batchOf("Imports", [file], sections, units);
  const cycleId = mintUlid();
  const store = scratch({ cycleId });
  const titles = await store.run(
    Effect.gen(function* () {
      yield* publishSettled(store.ctx(), inputOf([batch], { ending: true }));
      const read = yield* PublishedPackets.readStanding(cycleId);
      return read?.kind === "packet.published@2"
        ? read.batches[0]!.units.map((u) => u.recorded?.payload.title)
        : [];
    }),
  );
  expect(titles).toEqual([
    "a.ts: The imports change (lines 1–9)",
    "a.ts: The imports change (lines 40–88)",
  ]);
});
