// Why: the reading plan decides which changed rows a model reads and in which order. A row nobody
// reads and nobody is told about is silent, so every owned row must land in exactly one section,
// read or unread with a cause. The plan is stored and keyed, so it must not move with input order;
// and its order must come from code's facts about the change, never from a model.
import { expect, test } from "bun:test";
import { posix } from "node:path";
import type { ManifestHunk } from "../src/manifest.ts";
import { planOfManifest } from "../src/readings/collect.ts";
import { buildMapManifest } from "../src/review-map.ts";
import {
  READING_RECIPE,
  READING_TOO_LARGE,
  ReadingPlan,
  planReadings,
  type PlanSection,
} from "../src/readings/plan.ts";
import { manifestOf, mapOf } from "./fixtures/link.ts";
import { mixedRange } from "./fixtures/readings.ts";

const planOf = (range: ReturnType<typeof mixedRange>) =>
  planReadings({
    hunks: range.hunks,
    structures: range.structures,
    excluded: range.excluded,
  });

/** Every changed row a hunk's owned ranges hold, as `hunk side line`. */
const ownedRows = (hunks: ReadonlyArray<ManifestHunk>) =>
  hunks.flatMap((hunk) =>
    hunk.ownedRanges
      .filter((range) => range.lineCount > 0 && range.startLine > 0)
      .flatMap((range) =>
        Array.from(
          { length: range.lineCount },
          (_, at) => `${hunk.hunkId} ${range.side} ${range.startLine + at}`,
        ),
      ),
  );

const sectionRows = (section: PlanSection) =>
  section.owned.flatMap((range) =>
    Array.from(
      { length: range.endLine - range.startLine + 1 },
      (_, at) => `${range.hunkId} ${range.side} ${range.startLine + at}`,
    ),
  );

// Reason: a row nobody reads and nobody is told about is silent.
test("every owned row is in exactly one section, each read section in exactly one group, and each unread one has its cause", () => {
  const range = mixedRange();
  const plan = planOf(range);
  expect(ReadingPlan.parse(plan)).toEqual(plan);
  expect(plan.recipe).toBe(READING_RECIPE);

  const all = [...plan.sections, ...plan.unread];
  const counts = new Map<string, number>();
  for (const row of all.flatMap(sectionRows))
    counts.set(row, (counts.get(row) ?? 0) + 1);
  const owned = ownedRows(range.hunks);
  expect(owned.length).toBeGreaterThan(1_800);
  for (const row of owned) expect([row, counts.get(row)]).toEqual([row, 1]);
  // No section claims a row the rules do not own.
  expect([...counts.keys()].sort()).toEqual([...new Set(owned)].sort());
  // A change with no text owns no rows: its hunk is in exactly one section.
  for (const hunk of range.hunks.filter((h) => h.kind !== "text"))
    expect(all.filter((s) => s.hunkIds.includes(hunk.hunkId))).toHaveLength(1);

  const grouped = plan.groups.flatMap((group) => group.keys);
  expect(grouped.slice().sort()).toEqual(
    plan.sections.map((s) => s.key).sort(),
  );
  expect(new Set(grouped).size).toBe(grouped.length);

  const causes = Object.fromEntries(
    plan.unread.map((section) => [section.path, section.cause]),
  );
  expect(causes).toEqual({
    "assets/logo.png": "unreadable",
    "bun.lock": "excluded",
    "data/big.txt": "too-large",
    "scripts/run.sh": "unreadable",
    "src/gen/api.ts": "excluded",
  });
  const big = plan.unread.find((s) => s.path === "data/big.txt")!;
  expect(big.characters).toBeGreaterThan(READING_TOO_LARGE);

  const read = (path: string) => plan.sections.filter((s) => s.path === path);
  // The pure removal is read, on the old side only, as the base's declaration.
  expect(read("src/old.ts")).toMatchObject([
    {
      name: "drop",
      span: { side: "old", startLine: 4, endLine: 6 },
      owned: [{ side: "old", startLine: 4, endLine: 6 }],
    },
  ]);
  // The rename is read at its new path; the file with no structure is read by its hunk.
  expect(read("docs/guide.md")).toMatchObject([
    { declared: "doc", boundaries: "structure", basis: "markdown-sections" },
  ]);
  expect(read("notes.txt")).toMatchObject([
    {
      kind: "hunk",
      boundaries: "fallback",
      basis: "unsupported-language",
      span: null,
    },
  ]);
  expect(read("src/parse.ts").map((s) => s.name)).toEqual(["helper", "count"]);
  expect(read("src/parse.test.ts")).toMatchObject([{ declared: "test" }]);
});

// Reason: the plan is stored and keyed, and risk order must be code's.
test("the same input in another order gives the same plan, and removals and public names outrank a plain test section", () => {
  const range = mixedRange();
  const plan = planOf(range);
  const reversed = planReadings({
    hunks: [...range.hunks].reverse(),
    structures: new Map([...range.structures].reverse()),
    excluded: [...range.excluded].reverse(),
  });
  expect(reversed).toEqual(plan);
  expect(JSON.stringify(reversed)).toBe(JSON.stringify(plan));

  const rank = (path: string, name: string | null) =>
    plan.sections.find((s) => s.path === path && s.name === name)!.rank;
  const test = plan.sections.find((s) => s.path === "src/parse.test.ts")!.rank;
  const removal = rank("src/old.ts", "drop");
  const publicName = rank("src/parse.ts", "count");
  const plain = rank("src/parse.ts", "helper");
  expect(removal).toBeGreaterThan(test);
  expect(publicName).toBeGreaterThan(test);
  // Within undeclared source, both facts lift a section above a plain replacement.
  expect(removal).toBeGreaterThan(plain);
  expect(publicName).toBeGreaterThan(plain);
  // Undeclared source above tests above documentation.
  expect(plain).toBeGreaterThan(test);
  expect(test).toBeGreaterThan(rank("docs/guide.md", "Usage"));
  for (const group of plan.groups)
    expect(group.rank).toBe(
      Math.max(
        ...group.keys.map(
          (key) => plan.sections.find((s) => s.key === key)!.rank,
        ),
      ),
    );
});

// Reason: the plan must not depend on a model's answer. It is made from the range manifest alone:
// the excluded files by the Map manifest's own code, and the reading groups by directory, never by
// the Map's groups, so the readings can be planned before the Map exists and plan alike every run.
test("the plan made from the manifest alone excludes what the Map-fed plan excluded, and its groups follow directories, not Map groups", () => {
  const range = mixedRange();
  const hunks = range.hunks.map((hunk) => {
    const { leads: _leads, ...rest } = hunk as typeof hunk & {
      leads?: unknown;
    };
    return rest;
  });
  const manifest = manifestOf(hunks as Array<ManifestHunk>);
  // A Map whose two groups cut across directories, and whose excluded list is the fixture's.
  const map = mapOf(hunks as Array<ManifestHunk>, 2);
  const affinity = new Map<string, Array<string>>();
  for (const group of map.groups)
    for (const file of group.files)
      affinity.set(file.path, [...(affinity.get(file.path) ?? []), group.id]);
  // The code that makes the Map's excluded list gives the fixture's list.
  expect(
    buildMapManifest(manifest).excluded.map(({ path, reason }) => ({
      path,
      reason,
    })),
  ).toEqual([...range.excluded].sort((a, b) => a.path.localeCompare(b.path)));
  // Two files per reading, so a group closes at a change of directory once it holds one.
  for (const bounds of [
    { maxFiles: 16, maxCharacters: 48_000, maxItems: 40 },
    { maxFiles: 2, maxCharacters: 48_000, maxItems: 40 },
  ]) {
    const plan = planOfManifest({
      manifest,
      structures: range.structures,
      bounds,
    });
    // As the plan was made from the Map before this round.
    const fed = planReadings({
      hunks: range.hunks,
      structures: range.structures,
      bounds,
      excluded: range.excluded,
      affinity,
    });
    const excluded = (p: typeof plan) =>
      p.unread.filter((section) => section.cause === "excluded");
    expect(excluded(plan)).toEqual(excluded(fed));
    expect(
      excluded(plan)
        .map((s) => s.path)
        .sort(),
    ).toEqual(["bun.lock", "src/gen/api.ts"]);
    expect(plan.unread).toEqual(fed.unread);
    expect(plan.sections.map((s) => s.key).sort()).toEqual(
      fed.sections.map((s) => s.key).sort(),
    );
    // The groups are the directory fallback's: no affinity at all.
    expect(plan).toEqual(
      planReadings({
        hunks: range.hunks,
        structures: range.structures,
        bounds,
        excluded: range.excluded,
      }),
    );
    if (bounds.maxFiles === 2) {
      const directories = (p: typeof plan) =>
        p.groups.map((group) => [
          ...new Set(group.paths.map((path) => posix.dirname(path))),
        ]);
      // Every group holds one directory; the Map-fed plan mixed them where the Map did.
      expect(directories(plan).every((dirs) => dirs.length === 1)).toBe(true);
      expect(directories(fed).some((dirs) => dirs.length > 1)).toBe(true);
    }
  }
});
