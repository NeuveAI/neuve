// Why: the harness comparison credits a ledger region only where it lands on the base revision, and
// keeps a gold target in the cross-family view only by its status and the final council round. A
// shift that is off by one hunk would silently move every head read onto the wrong base lines, and a
// filter that counts a split council as agreed would mislabel the subset; neither would show up in
// the totals. These cases pin the boundaries: lines before, inside and after a hunk, a renamed file,
// an added file, a scope section, and a council where one Sol member dissented.
import { expect, test } from "bun:test";
import {
  placeEntry,
  type LedgerEntryLite,
  type ManifestHunkLite,
} from "../src/harness-compare/ledgers.ts";
import { opusAgrees } from "../src/harness-compare/score.ts";
import {
  keepCrossFamily,
  type RawGoldItem,
} from "../src/retrieval-bench/score/gold.ts";

const hunk = (
  over: Partial<ManifestHunkLite> & Pick<ManifestHunkLite, "hunkId">,
): ManifestHunkLite => ({
  kind: "text",
  path: "src/a.ts",
  oldPath: "src/a.ts",
  newPath: "src/a.ts",
  oldStart: 10,
  oldLines: 2,
  newStart: 10,
  newLines: 5,
  ...over,
});

const entry = (
  rev: string,
  path: string,
  startLine: number,
  endLine: number,
): LedgerEntryLite => ({
  id: "e1",
  anchors: [{ hunk: "h1" }],
  source: { origin: "repository", rev, path, startLine, endLine },
  retrieval: { rank: null, retriever: null },
  lineage: { lookup: "read" },
  grade: "necessary",
  tokens: 10,
  ungraded: false,
});

// One hunk turns base lines 10-11 into head lines 10-14 (three lines added).
const manifest = [hunk({ hunkId: "h1" })];

test("base reads stay as they are", () => {
  expect(placeEntry(entry("base", "src/a.ts", 40, 50), manifest)).toEqual({
    placement: "base",
    region: { path: "src/a.ts", startLine: 40, endLine: 50 },
  });
});

test("head reads of a changed file shift by the hunks before them and snap inside one", () => {
  expect(placeEntry(entry("head", "src/a.ts", 1, 5), manifest).region).toEqual({
    path: "src/a.ts",
    startLine: 1,
    endLine: 5,
  });
  expect(
    placeEntry(entry("head", "src/a.ts", 20, 25), manifest).region,
  ).toEqual({ path: "src/a.ts", startLine: 17, endLine: 22 });
  // From inside the hunk to after it: the start snaps to the hunk's old lines, the end shifts.
  expect(
    placeEntry(entry("head", "src/a.ts", 12, 20), manifest).region,
  ).toEqual({ path: "src/a.ts", startLine: 10, endLine: 17 });
});

test("an add-only or delete-only hunk names the line before the change, so lines after it shift by its size", () => {
  // `@@ -4,0 +5,2 @@`: two lines inserted after base line 4; head 7-8 are base 5-6.
  const addOnly = [
    hunk({ hunkId: "h1", oldStart: 4, oldLines: 0, newStart: 5, newLines: 2 }),
  ];
  expect(placeEntry(entry("head", "src/a.ts", 7, 8), addOnly).region).toEqual({
    path: "src/a.ts",
    startLine: 5,
    endLine: 6,
  });
  // `@@ -5,2 +4,0 @@`: base lines 5-6 deleted after head line 4; head 5-6 are base 7-8.
  const deleteOnly = [
    hunk({ hunkId: "h1", oldStart: 5, oldLines: 2, newStart: 4, newLines: 0 }),
  ];
  expect(
    placeEntry(entry("head", "src/a.ts", 5, 6), deleteOnly).region,
  ).toEqual({ path: "src/a.ts", startLine: 7, endLine: 8 });
  // Lines before either hunk do not move.
  expect(
    placeEntry(entry("head", "src/a.ts", 1, 4), deleteOnly).region,
  ).toEqual({ path: "src/a.ts", startLine: 1, endLine: 4 });
});

test("a renamed file takes its old path; an added file and a scope section are lost", () => {
  const renamed = [
    hunk({ hunkId: "h1", oldPath: "src/old.ts", newPath: "src/a.ts" }),
  ];
  expect(placeEntry(entry("head", "src/a.ts", 1, 3), renamed)).toEqual({
    placement: "head-through-diff",
    region: { path: "src/old.ts", startLine: 1, endLine: 3 },
  });
  const added = [
    hunk({
      hunkId: "h1",
      oldPath: null,
      oldStart: 0,
      oldLines: 0,
      newStart: 1,
    }),
  ];
  expect(placeEntry(entry("head", "src/a.ts", 1, 3), added).placement).toBe(
    "lost-added-file",
  );
  expect(
    placeEntry(
      {
        ...entry("head", "x", 1, 1),
        source: { origin: "scope", sectionId: "S1" },
      },
      manifest,
    ).placement,
  ).toBe("lost-scope");
  expect(
    placeEntry(entry("head", "src/other.ts", 3, 4), manifest).placement,
  ).toBe("head-unchanged-file");
});

const council = (votes: Record<string, string>, grade = "useful") => ({
  id: "c1",
  grade,
  status: "council-decided",
  retrievalTarget: true,
  labels: { codex: "necessary", opus: "necessary" },
  owner: {
    council: { votes: [{ votes: { "sol-medium": "necessary" } }, { votes }] },
  },
});

// The comparison's cross-family view reads the M4 scorer's rule (7.11).
const crossFamily = (item: object) =>
  keepCrossFamily(item as unknown as RawGoldItem);

test("the cross-family view keeps a council decision only when both Sol members voted it last", () => {
  expect(
    crossFamily(
      council({
        "opus-high": "necessary",
        "sol-medium": "useful",
        "sol-high": "useful",
      }),
    ),
  ).toBe(true);
  expect(
    crossFamily(council({ "sol-medium": "useful", "sol-high": "necessary" })),
  ).toBe(false);
  expect(
    crossFamily({ ...council({}), status: "agreed", owner: undefined }),
  ).toBe(true);
  expect(crossFamily({ ...council({}), status: "lower-grade" })).toBe(false);
  // Opus labelled it necessary; the final grade is useful.
  expect(opusAgrees(council({}))).toBe(false);
});
