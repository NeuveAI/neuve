// Why (10.109): agents will read every changed part of a review, several related files per reading,
// up to a bound. These tests hold what a reading may rely on: the same items always give the same
// groups, every bound is kept, an oversize part is read whole and alone, a large file is read in
// order across groups, a file reads with its test, and no part is read twice or never.
import { expect, test } from "bun:test";

import {
  DEFAULT_READING_BOUNDS,
  ReadingBoundsSchema,
  readingGroups,
  readingPathKeys,
  type ReadingItem,
} from "../src/reading-groups.ts";

const item = (
  key: string,
  path: string,
  characters = 10,
  position = 0,
  affinity?: ReadonlyArray<string>,
): ReadingItem =>
  affinity === undefined
    ? { key, path, characters, position }
    : { key, path, characters, position, affinity };

const keysOf = (items: ReadonlyArray<ReadingItem>, bounds = {}) =>
  readingGroups(items, bounds).groups.map((group) => group.keys);

/** A mixed review: affinity, several directories, a file and its test, a large file, an oversize part. */
const MIXED: ReadonlyArray<ReadingItem> = [
  item("a1", "src/a.ts", 20, 1, ["map-1"]),
  item("a2", "src/a.ts", 20, 2, ["map-1"]),
  item("at", "src/a.test.ts", 30, 1, ["map-1"]),
  item("b1", "src/b.ts", 40, 1),
  item("big", "src/b.ts", 500, 2),
  item("b3", "src/b.ts", 10, 3),
  ...Array.from({ length: 7 }, (_, index) =>
    item(`l${index}`, "lib/large.go", 15, index),
  ),
  item("lt", "lib/large_test.go", 15, 1),
  item("p1", "py/test_util.py", 25, 1, ["map-2"]),
  item("p2", "py/util.py", 25, 1, ["map-2"]),
  item("r1", "README.md", 60, 1),
];
const MIXED_BOUNDS = { maxFiles: 3, maxCharacters: 100, maxItems: 5 };

const permutations = (items: ReadonlyArray<ReadingItem>) => {
  // A fixed linear-congruential shuffle: varied orders, same on every run.
  let seed = 7;
  const shuffled = (): ReadingItem[] => {
    const copy = [...items];
    for (let index = copy.length - 1; index > 0; index--) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      const other = seed % (index + 1);
      [copy[index], copy[other]] = [copy[other]!, copy[index]!];
    }
    return copy;
  };
  return [
    [...items].reverse(),
    [...items.slice(5), ...items.slice(0, 5)],
    ...Array.from({ length: 20 }, shuffled),
  ];
};

test("the default bounds: 16 files, 48,000 characters and 40 items per group", () => {
  // Reason: the bounds are a setting's defaults, read from one schema.
  expect(DEFAULT_READING_BOUNDS).toEqual({
    maxFiles: 16,
    maxCharacters: 48_000,
    maxItems: 40,
  });
  expect(ReadingBoundsSchema.parse({ maxItems: 8 }).maxFiles).toBe(16);
});

test("any permutation of the same items gives the same groups, byte for byte", () => {
  // Reason: a reading's key will depend on the group.
  const expected = JSON.stringify(readingGroups(MIXED, MIXED_BOUNDS));
  for (const order of permutations(MIXED)) {
    expect(JSON.stringify(readingGroups(order, MIXED_BOUNDS))).toBe(expected);
  }
});

test("each bound alone closes a group: files, characters, items", () => {
  // Reason: the bounds are the input bounds of a model call.
  const four = ["a", "b", "c", "d"].map((name) => item(name, `src/${name}.ts`));
  expect(
    keysOf(four, { maxFiles: 3, maxCharacters: 1_000, maxItems: 40 }),
  ).toEqual([["a", "b", "c"], ["d"]]);
  expect(
    keysOf([item("a", "src/a.ts", 60), item("b", "src/b.ts", 60)], {
      maxFiles: 16,
      maxCharacters: 100,
      maxItems: 40,
    }),
  ).toEqual([["a"], ["b"]]);
  expect(
    keysOf(four, { maxFiles: 16, maxCharacters: 1_000, maxItems: 3 }),
  ).toEqual([["a", "b", "c"], ["d"]]);
  const groups = readingGroups(four, {
    maxFiles: 3,
    maxCharacters: 1_000,
    maxItems: 40,
  }).groups;
  expect(groups.map((group) => group.totals)).toEqual([
    { files: 3, characters: 30, items: 3 },
    { files: 1, characters: 10, items: 1 },
  ]);
});

test("an oversize item gets a group of its own with a note, takes no room in another group, and breaks no bound", () => {
  // Reason: it must be read, and it must not push other parts over a bound.
  const bounds = { maxFiles: 2, maxCharacters: 100, maxItems: 40 };
  const neighbours = [
    item("a", "src/a.ts", 30),
    item("c", "src/c.ts", 30),
    item("d", "src/d.ts", 30),
  ];
  const withBig = [...neighbours, item("big", "src/b.ts", 500)];
  const { groups, summary } = readingGroups(withBig, bounds);
  const oversize = groups.filter((group) =>
    group.notes.some((note) => note.kind === "oversize"),
  );
  expect(oversize).toHaveLength(1);
  expect(oversize[0]!.keys).toEqual(["big"]);
  expect(oversize[0]!.totals).toEqual({
    files: 1,
    characters: 500,
    items: 1,
  });
  expect(oversize[0]!.notes).toEqual([
    { kind: "oversize", key: "big", path: "src/b.ts" },
  ]);
  expect(
    groups.filter((group) => group !== oversize[0]).map((group) => group.keys),
  ).toEqual(keysOf(neighbours, bounds));
  expect(summary.oversizeItems).toBe(1);
  expect(summary.largestGroupCharacters).toBe(500);
});

test("a file larger than a group continues across groups in file order, and each group says so", () => {
  // Reason: no part of a file may be lost or read out of order.
  const parts = [5, 3, 1, 4, 2, 0].map((position) =>
    item(`p${position}`, "src/large.ts", 10, position),
  );
  const { groups, summary } = readingGroups(parts, {
    maxFiles: 16,
    maxCharacters: 1_000,
    maxItems: 4,
  });
  expect(groups.map((group) => group.keys)).toEqual([
    ["p0", "p1", "p2", "p3"],
    ["p4", "p5"],
  ]);
  expect(groups.map((group) => group.notes)).toEqual([
    [{ kind: "continued", path: "src/large.ts", part: 1, parts: 2 }],
    [{ kind: "continued", path: "src/large.ts", part: 2, parts: 2 }],
  ]);
  expect(summary.continuedFiles).toBe(1);
});

test("a continued note's part counts groups in reading order, not positions in the file", () => {
  // Reason: an oversize item is read after the group open when it was met, so it can follow later
  // items of its file; a later step must not read `part` as file order.
  const parts = [0, 1, 2, 3, 4, 5].map((position) =>
    item(`p${position}`, "d/f.ts", position === 1 ? 500 : 10, position),
  );
  const { groups } = readingGroups(parts, {
    maxFiles: 16,
    maxCharacters: 100,
    maxItems: 2,
  });
  expect(groups.map((group) => group.keys)).toEqual([
    ["p0", "p2"],
    ["p1"],
    ["p3", "p4"],
    ["p5"],
  ]);
  expect(groups.map((group) => group.notes)).toEqual([
    [{ kind: "continued", path: "d/f.ts", part: 1, parts: 4 }],
    [
      { kind: "oversize", key: "p1", path: "d/f.ts" },
      { kind: "continued", path: "d/f.ts", part: 2, parts: 4 },
    ],
    [{ kind: "continued", path: "d/f.ts", part: 3, parts: 4 }],
    [{ kind: "continued", path: "d/f.ts", part: 4, parts: 4 }],
  ]);
});

test("bad bounds and bad items are refused", () => {
  // Reason: bad input at the module's boundary must not reach the packing.
  const one = [item("a", "src/a.ts")];
  for (const bounds of [
    { maxFiles: 0 },
    { maxCharacters: -1 },
    { maxItems: 2.5 },
  ]) {
    expect(() => readingGroups(one, bounds)).toThrow();
  }
  expect(() => readingGroups([item("", "src/a.ts")])).toThrow();
  expect(() => readingGroups([item("a", "src/a.ts", -1)])).toThrow();
  expect(() =>
    readingGroups([item("a", "src/a.ts", 10, Number.POSITIVE_INFINITY)]),
  ).toThrow();
});

test("a file and its test land in the same group when they fit", () => {
  // Reason: that is what "related" means here; plain path order would part them.
  const twoFiles = { maxFiles: 2, maxCharacters: 1_000, maxItems: 40 };
  expect(
    keysOf(
      [
        item("goo", "lib/goo.py"),
        item("test", "lib/test_foo.py"),
        item("foo", "lib/foo.py"),
      ],
      twoFiles,
    ),
  ).toEqual([["foo", "test"], ["goo"]]);
  expect(
    keysOf(
      [
        item("bar", "pkg/foo_bar.go"),
        item("test", "pkg/foo_test.go"),
        item("foo", "pkg/foo.go"),
      ],
      twoFiles,
    ),
  ).toEqual([["foo", "test"], ["bar"]]);
  expect(
    keysOf(
      [
        item("utils", "src/foo-utils.ts"),
        item("story", "src/foo.stories.tsx"),
        item("foo", "src/foo.tsx"),
      ],
      twoFiles,
    ),
  ).toEqual([["foo", "story"], ["utils"]]);
  expect(readingPathKeys("src/__tests__/foo.spec.ts")).toEqual({
    directory: "src",
    stem: "foo",
    role: 1,
  });
});

test("every input key appears in exactly one group, and every regular group keeps the bounds", () => {
  // Reason: a part read twice or never is silent.
  const { groups, summary } = readingGroups(MIXED, MIXED_BOUNDS);
  const read = groups.flatMap((group) => group.keys);
  expect([...read].sort()).toEqual(MIXED.map((part) => part.key).sort());
  expect(new Set(read).size).toBe(read.length);
  expect(summary.items).toBe(MIXED.length);
  for (const group of groups) {
    if (group.notes.some((note) => note.kind === "oversize")) continue;
    expect(group.totals.files).toBeLessThanOrEqual(MIXED_BOUNDS.maxFiles);
    expect(group.totals.characters).toBeLessThanOrEqual(
      MIXED_BOUNDS.maxCharacters,
    );
    expect(group.totals.items).toBeLessThanOrEqual(MIXED_BOUNDS.maxItems);
  }
  expect(new Set(groups.map((group) => group.id)).size).toBe(groups.length);
});

test("duplicate keys are refused", () => {
  // Reason: a caller error must not corrupt a group.
  expect(() =>
    readingGroups([item("a", "src/a.ts"), item("a", "src/b.ts")]),
  ).toThrow('reading groups: duplicate item key "a"');
});

test("a file added in one directory leaves the next directory's group and id unchanged once the group before it is half full", () => {
  // Reason: the module states this bound on the shift; a reading keyed by group id relies on it.
  const bounds = { maxFiles: 4, maxCharacters: 1_000, maxItems: 40 };
  const before = [
    item("a1", "a/one.ts"),
    item("a2", "a/two.ts"),
    item("b1", "b/one.ts"),
    item("b2", "b/two.ts"),
    item("b3", "b/three.ts"),
  ];
  const after = [...before, item("a3", "a/three.ts")];
  const old = readingGroups(before, bounds).groups;
  const next = readingGroups(after, bounds).groups;
  expect(old.map((group) => group.keys)).toEqual([
    ["a1", "a2"],
    ["b1", "b3", "b2"],
  ]);
  expect(next.map((group) => group.keys)).toEqual([
    ["a1", "a3", "a2"],
    ["b1", "b3", "b2"],
  ]);
  expect(next[1]!.id).toBe(old[1]!.id);
});
