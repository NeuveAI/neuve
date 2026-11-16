// Why: Map's model output crosses a file-ownership boundary. Bounds and repairs must
// retain every file and hunk exactly once, including large ranges and excluded-only changes.
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  buildMapManifest,
  renderMapManifest,
  repairMap,
  mapProblems,
  composeMap,
  fallbackMap,
  groupUnits,
  MapManifest,
  ReviewMap,
  type MapSubmission,
} from "../src/review-map.ts";
import { fallbackFrame } from "../src/frame.ts";
import { estimateTokens } from "../src/budget.ts";
import { hunk, manifest, realManifest } from "./fixtures/map-manifest.ts";
const frame = fallbackFrame(
  { candidates: [], snapshot: undefined },
  ["src"],
  1,
  { sectionsInlined: 0, sectionsListed: 0, commitsShown: 1, commitsTotal: 1 },
);
const invalid: MapSubmission = {
  groups: [
    {
      label: "one two three four five",
      why: "First. Second. Third. Fourth.",
      tier: "core",
      doneWhen: ["D1", "D5"],
      entries: ["f1", "f1", "bogus"],
    },
  ],
};
test("repair places every remaining entry once and marks code placements", () => {
  const m = buildMapManifest(
    manifest([hunk("src/a.ts"), hunk("src/b.ts"), hunk("tests/a.test.ts")]),
  );
  const fixed = repairMap(invalid, frame, m);
  expect(mapProblems(invalid, frame, m).length).toBeGreaterThan(0);
  expect(mapProblems(fixed, frame, m)).toEqual([]);
  const map = ReviewMap.parse(
    composeMap(fixed, frame, m, "frame", "repaired", invalid),
  );
  expect(map.groups.flatMap((g) => g.files)).toEqual([
    { path: "src/a.ts", placedBy: "map" },
    { path: "src/b.ts", placedBy: "code" },
    { path: "tests/a.test.ts", placedBy: "code" },
  ]);
  expect(map.groups.flatMap((g) => g.hunkIds).sort()).toEqual([
    "src/a.ts",
    "src/b.ts",
    "tests/a.test.ts",
  ]);
});
test("six groups repair omitted entries into the smallest and remove duplicates across groups", () => {
  const m = buildMapManifest(
    manifest(Array.from({ length: 8 }, (_, i) => hunk(`src/${i}.ts`))),
  );
  const original: MapSubmission = {
    groups: Array.from({ length: 6 }, (_, i) => ({
      label: `Group ${i}`,
      why: "A group.",
      tier: "core",
      doneWhen: [],
      entries: [`f${i + 1}`, "f1"],
    })),
  };
  const fixed = repairMap(original, frame, m);
  expect(fixed.groups).toHaveLength(6);
  expect(mapProblems(fixed, frame, m)).toEqual([]);
  expect(fixed.groups.flatMap((g) => g.entries).sort()).toEqual(
    m.entries.map((e) => e.id).sort(),
  );
});
test("excludes declared generated and lockfiles while generated path hints remain addressable", () => {
  const generated: ReturnType<typeof hunk> = {
    ...hunk("src/generated.ts"),
    declared: [{ kind: "generated", by: "owner declaration" }],
  };
  const m = buildMapManifest(
    manifest([
      hunk("nested/bun.lock"),
      generated,
      hunk("dist/app.min.js"),
      { ...hunk("image.png"), kind: "binary" },
    ]),
  );
  expect(m.excluded.map((f) => [f.path, f.reason])).toEqual([
    ["nested/bun.lock", "lockfile"],
    ["src/generated.ts", "declared-generated"],
  ]);
  expect(m.entries.map((e) => e.path)).toEqual([
    "dist/app.min.js",
    "image.png",
  ]);
  expect(m.entries[0]?.files[0]?.tags).toContain("generated");
  expect(renderMapManifest(m)).toContain("binary");
  const only = buildMapManifest(manifest([hunk("bun.lock")]));
  expect(ReviewMap.parse(fallbackMap(frame, only, "frame")).groups).toEqual([]);
  expect(fallbackMap(frame, only, "frame").excluded).toHaveLength(1);
});
test("roll-up respects both bounds and expands to all files and proximity units", () => {
  const hunks = Array.from(
    { length: 2001 },
    (_, i) =>
      ({
        ...hunk(`src/area${i % 20}/file${i}.ts`),
        enclosing: {
          side: "post",
          symbols: [`symbol${i}`],
          headingPath: [],
          capability: "ts",
          language: "typescript",
          limitation: null,
        },
      }) satisfies ReturnType<typeof hunk>,
  );
  const m = MapManifest.parse(
    buildMapManifest(manifest(hunks), { tokens: 1000, entries: 30 }),
  );
  expect(m.entries.length).toBeLessThanOrEqual(30);
  expect(m.tokens).toBeLessThanOrEqual(1000);
  expect(m.tokens).toBe(
    estimateTokens(Buffer.byteLength(renderMapManifest(m))),
  );
  expect(m.rolledUp.length).toBeGreaterThan(0);
  const map = fallbackMap(frame, m, "frame");
  expect(map.groups.length).toBeLessThanOrEqual(6);
  expect(
    new Set(map.groups.flatMap((g) => g.files.map((f) => f.path))).size,
  ).toBe(2001);
  const units = groupUnits(map, new Map(hunks.map((h) => [h.hunkId, h])));
  expect(new Set(units.flatMap((u) => u.hunkIds)).size).toBe(2001);
  expect(units.every((u) => u.id.startsWith(`${u.groupId}.u`))).toBe(true);
});
// Use this checkout's shared Git history, including when running in a worktree.
// Clones and uploaded source without the historical ranges skip these measurements.
const repository = resolve(import.meta.dir, "../../..");
const hasRange = (head: string) =>
  existsSync(repository) &&
  Bun.spawnSync(["git", "-C", repository, "cat-file", "-e", `${head}^{commit}`])
    .exitCode === 0;
for (const [commits, head] of [
  [25, "d8af01b713b209e009d83493b062a28698669189"],
  [420, "de4a4832e6593b84c8a0dd1f8c7f06423e7ced5b"],
] as const)
  test.skipIf(!hasRange(head))(
    `manifest from the real ${commits}-commit range`,
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "front-real-manifest-"));
      try {
        const range = await realManifest(
          repository,
          "b192becfacbb2c57207bc661cbce744e8e37f9b3",
          head,
          directory,
        );
        const m = MapManifest.parse(buildMapManifest(range));
        expect(m.entries.length).toBeLessThanOrEqual(1000);
        expect(m.tokens).toBeLessThanOrEqual(30000);
        const paths = [
          ...m.entries.flatMap((e) => e.files.map((f) => f.path)),
          ...m.excluded.map((f) => f.path),
        ];
        expect(paths.sort()).toEqual(
          [...new Set(range.hunks.map((h) => h.path))].sort(),
        );
        expect(new Set(paths).size).toBe(paths.length);
        console.log(
          JSON.stringify({
            commits,
            files: range.files,
            entries: m.entries.length,
            tokens: m.tokens,
            bytes: Buffer.byteLength(renderMapManifest(m)),
            excluded: m.excluded.length,
            rolledUp: m.rolledUp.length,
          }),
        );
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
    // 420 commits: measured 47.634-51.680 s at load 6-16; 10x slowest, rounded up to 5 s. 25 commits: unchanged 60 s.
    commits === 420 ? 520_000 : 60_000,
  );

test("fallback links core areas to every condition and leaves test-only areas supporting", () => {
  const m = buildMapManifest(
    manifest([hunk("src/app/a.ts"), hunk("tests/app/a.test.ts")]),
  );
  const map = fallbackMap(frame, m, "frame");
  expect(map.groups.map((g) => [g.label, g.tier, g.doneWhen])).toEqual([
    ["src/app", "core", ["D1"]],
    ["tests/app", "supporting", []],
  ]);
  expect(
    map.groups.flatMap((g) => g.files).every((f) => f.placedBy === "code"),
  ).toBe(true);
});
