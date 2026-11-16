import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * Reading groups: which changed parts of a review one agent reading takes together (10.109). A
 * reading holds several related files at once, up to a bound on files, characters and items. This is
 * pure code: no model call, no store, no Graph, no git, and nothing here goes into a prompt.
 *
 * Relatedness comes only from what a path says, plus the caller's affinity keys when given (for
 * example a Map group): files in one directory are related, and a file and its test, spec or story
 * (the same stem) are related more closely. `readingPathKeys` is the one place that rule lives.
 * Graph's relations are not available in bulk yet; this path ordering is their stand-in.
 *
 * Never part of unit identity (10.121): a group's id is a label for a reading, and a later step may
 * key a reading by it; nothing else may. Grouping never splits or merges review units.
 *
 * Packing is greedy over one total order, with one rule that bounds the shift when a file is added:
 * a group closes at a top-level boundary (a change of a file's first affinity key, or of its
 * directory when it has none) once it is at least half full on any bound. Packing runs left to
 * right, so adding one file leaves every group closed before that file's place unchanged, ids
 * included, and the change ends at the first later top-level boundary where the open group is at
 * least half full both before and after the addition: from there the two packings are the same.
 */

/** The bounds of one reading. Defaults now; a setting can supply them later. */
export const ReadingBoundsSchema = z.strictObject({
  maxFiles: z.number().int().positive().default(16),
  maxCharacters: z.number().int().positive().default(48_000),
  maxItems: z.number().int().positive().default(40),
});

export type ReadingBounds = z.output<typeof ReadingBoundsSchema>;

export const DEFAULT_READING_BOUNDS: ReadingBounds = ReadingBoundsSchema.parse(
  {},
);

/** One part to be read. `key` is opaque and unique; `position` orders a file's parts. */
export interface ReadingItem {
  readonly key: string;
  readonly path: string;
  readonly characters: number;
  readonly position: number;
  readonly affinity?: ReadonlyArray<string> | undefined;
}

const ReadingItemSchema = z.object({
  key: z.string().min(1),
  path: z.string().min(1),
  characters: z.number().int().nonnegative(),
  position: z.number(),
  affinity: z.array(z.string()).optional(),
});

/** What a group says about its members. A closed set; never prose. */
export type ReadingNote =
  /** This item is larger than the character bound and is read alone, whole. */
  | { readonly kind: "oversize"; readonly key: string; readonly path: string }
  /**
   * This file's items span several groups; this group is the `part`-th of the `parts` groups that
   * hold them, counted in group reading order. `part` is not a position in the file: an oversize item
   * can be read after later items of its file.
   */
  | {
      readonly kind: "continued";
      readonly path: string;
      readonly part: number;
      readonly parts: number;
    };

export interface ReadingGroup {
  /** A short hash of the member keys: says nothing about arrival order or the group's index. */
  readonly id: string;
  /** Member keys in reading order. */
  readonly keys: ReadonlyArray<string>;
  /** Distinct paths in reading order. */
  readonly paths: ReadonlyArray<string>;
  readonly totals: {
    readonly files: number;
    readonly characters: number;
    readonly items: number;
  };
  readonly notes: ReadonlyArray<ReadingNote>;
}

/** For telemetry. */
export interface ReadingSummary {
  readonly groups: number;
  readonly items: number;
  readonly oversizeItems: number;
  readonly continuedFiles: number;
  readonly largestGroupCharacters: number;
}

export interface ReadingGroups {
  readonly groups: ReadonlyArray<ReadingGroup>;
  readonly summary: ReadingSummary;
}

/** Name markers that make a file a companion of the file with the same stem. */
const COMPANION_SUFFIXES = [
  ".test",
  ".spec",
  ".stories",
  ".story",
  "_test",
  "_spec",
] as const;
const COMPANION_PREFIXES = ["test_"] as const;

/**
 * The relatedness rule, from a path alone: its directory (a `__tests__` directory counts as its
 * parent), its stem (the name without its last extension or a test, spec or story marker), and its
 * role (0 for the file, 1 for a companion), so `foo.ts` reads just before `foo.test.ts`,
 * `foo.go` before `foo_test.go`, and `foo.py` before `test_foo.py`.
 */
export const readingPathKeys = (
  path: string,
): {
  readonly directory: string;
  readonly stem: string;
  readonly role: 0 | 1;
} => {
  const slash = path.lastIndexOf("/");
  const rawDirectory = slash === -1 ? "" : path.slice(0, slash);
  const base = slash === -1 ? path : path.slice(slash + 1);
  const directory =
    rawDirectory === "__tests__"
      ? ""
      : rawDirectory.endsWith("/__tests__")
        ? rawDirectory.slice(0, -"/__tests__".length)
        : rawDirectory;
  const dot = base.lastIndexOf(".");
  const name = dot > 0 ? base.slice(0, dot) : base;
  for (const suffix of COMPANION_SUFFIXES) {
    if (name.length > suffix.length && name.endsWith(suffix)) {
      return { directory, stem: name.slice(0, -suffix.length), role: 1 };
    }
  }
  for (const prefix of COMPANION_PREFIXES) {
    if (name.length > prefix.length && name.startsWith(prefix)) {
      return { directory, stem: name.slice(prefix.length), role: 1 };
    }
  }
  return { directory, stem: name, role: rawDirectory === directory ? 0 : 1 };
};

/** Code-unit order: the same everywhere, never locale-dependent. */
const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const compareLists = (
  left: ReadonlyArray<string>,
  right: ReadonlyArray<string>,
): number => {
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index++) {
    const order = compareText(left[index]!, right[index]!);
    if (order !== 0) return order;
  }
  return left.length - right.length;
};

interface ReadingFile {
  readonly path: string;
  /** The smallest affinity list among the file's items, so a file's items stay together. */
  readonly affinity: ReadonlyArray<string>;
  readonly directory: string;
  readonly stem: string;
  readonly role: number;
  /** A file's first affinity key, or its directory when it has none. */
  readonly topLevel: string;
  readonly items: ReadonlyArray<ReadingItem>;
}

const compareFiles = (left: ReadingFile, right: ReadingFile): number =>
  compareLists(left.affinity, right.affinity) ||
  compareText(left.directory, right.directory) ||
  compareText(left.stem, right.stem) ||
  left.role - right.role ||
  compareText(left.path, right.path);

const compareItems = (left: ReadingItem, right: ReadingItem): number =>
  left.position - right.position || compareText(left.key, right.key);

const groupId = (keys: ReadonlyArray<string>): string =>
  `rg_${createHash("sha256")
    .update(JSON.stringify([...keys].sort(compareText)))
    .digest("hex")
    .slice(0, 16)}`;

interface Draft {
  readonly items: ReadingItem[];
  readonly paths: Set<string>;
  characters: number;
  readonly oversize: boolean;
}

const emptyDraft = (oversize = false): Draft => ({
  items: [],
  paths: new Set(),
  characters: 0,
  oversize,
});

/**
 * Packs items into reading groups. Order: the file's affinity keys, its path keys
 * (`readingPathKeys`), its path, then each item's position and key. A file's items stay in one group
 * where they fit; a file larger than a group continues in the next groups in file order. An item
 * larger than the character bound gets a group of its own, placed after the group that was open when
 * it was met, so it can be read after later items of its own file (`d/f.ts` p0..p5 with p1 oversize,
 * at 100 characters and 2 items, reads `[p0,p2]`, `[p1]`, `[p3,p4]`, `[p5]`). It never takes room in
 * another group and no bound is broken for it; it still counts toward its file's affinity, so an
 * oversize item with a smaller affinity list can move its file in the order. Any permutation of the
 * same items gives the same groups. Two items with the same key are refused.
 */
export const readingGroups = (
  input: ReadonlyArray<ReadingItem>,
  boundsInput: z.input<typeof ReadingBoundsSchema> = DEFAULT_READING_BOUNDS,
): ReadingGroups => {
  const bounds = ReadingBoundsSchema.parse(boundsInput);
  const items = z.array(ReadingItemSchema).parse(input);

  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.key)) {
      throw new RangeError(
        `reading groups: duplicate item key ${JSON.stringify(item.key)}`,
      );
    }
    seen.add(item.key);
  }

  const byPath = new Map<string, ReadingItem[]>();
  for (const item of items) {
    const list = byPath.get(item.path);
    if (list === undefined) byPath.set(item.path, [item]);
    else list.push(item);
  }
  const files: ReadingFile[] = [...byPath].map(([path, members]) => {
    const affinity = members
      .map((item) => item.affinity ?? [])
      .reduce((least, next) => (compareLists(next, least) < 0 ? next : least));
    const { directory, stem, role } = readingPathKeys(path);
    return {
      path,
      affinity,
      directory,
      stem,
      role,
      topLevel:
        affinity[0] === undefined ? `d:${directory}` : `a:${affinity[0]}`,
      items: [...members].sort(compareItems),
    };
  });
  files.sort(compareFiles);

  const closed: Draft[] = [];
  let open = emptyDraft();
  let pending: Draft[] = [];
  let previousTopLevel: string | undefined;

  const close = () => {
    if (open.items.length > 0) closed.push(open);
    closed.push(...pending);
    open = emptyDraft();
    pending = [];
  };
  const fits = (draft: Draft, path: string, count: number, size: number) =>
    draft.paths.size + (draft.paths.has(path) ? 0 : 1) <= bounds.maxFiles &&
    draft.characters + size <= bounds.maxCharacters &&
    draft.items.length + count <= bounds.maxItems;
  const add = (item: ReadingItem) => {
    open.items.push(item);
    open.paths.add(item.path);
    open.characters += item.characters;
  };
  const halfFull = (draft: Draft) =>
    draft.paths.size * 2 >= bounds.maxFiles ||
    draft.characters * 2 >= bounds.maxCharacters ||
    draft.items.length * 2 >= bounds.maxItems;

  for (const file of files) {
    const regular = file.items.filter(
      (item) => item.characters <= bounds.maxCharacters,
    );
    const size = regular.reduce((sum, item) => sum + item.characters, 0);
    if (
      regular.length > 0 &&
      previousTopLevel !== undefined &&
      file.topLevel !== previousTopLevel &&
      halfFull(open)
    ) {
      close();
    }
    if (
      regular.length > 0 &&
      open.items.length > 0 &&
      !fits(open, file.path, regular.length, size)
    ) {
      close();
    }
    for (const item of file.items) {
      if (item.characters > bounds.maxCharacters) {
        const alone = emptyDraft(true);
        alone.items.push(item);
        alone.paths.add(item.path);
        alone.characters = item.characters;
        pending.push(alone);
        continue;
      }
      if (!fits(open, item.path, 1, item.characters)) close();
      add(item);
    }
    if (regular.length > 0) previousTopLevel = file.topLevel;
  }
  close();

  const groupsByPath = new Map<string, number[]>();
  closed.forEach((draft, index) => {
    for (const path of draft.paths) {
      const list = groupsByPath.get(path);
      if (list === undefined) groupsByPath.set(path, [index]);
      else list.push(index);
    }
  });

  const groups: ReadingGroup[] = closed.map((draft, index) => {
    const keys = draft.items.map((item) => item.key);
    const paths = [...new Set(draft.items.map((item) => item.path))];
    const notes: ReadingNote[] = [];
    if (draft.oversize) {
      const [item] = draft.items;
      notes.push({ kind: "oversize", key: item!.key, path: item!.path });
    }
    for (const path of paths) {
      const spans = groupsByPath.get(path)!;
      if (spans.length > 1) {
        notes.push({
          kind: "continued",
          path,
          part: spans.indexOf(index) + 1,
          parts: spans.length,
        });
      }
    }
    return {
      id: groupId(keys),
      keys,
      paths,
      totals: {
        files: paths.length,
        characters: draft.characters,
        items: keys.length,
      },
      notes,
    };
  });

  return {
    groups,
    summary: {
      groups: groups.length,
      items: items.length,
      oversizeItems: closed.filter((draft) => draft.oversize).length,
      continuedFiles: [...groupsByPath.values()].filter(
        (spans) => spans.length > 1,
      ).length,
      largestGroupCharacters: groups.reduce(
        (largest, group) => Math.max(largest, group.totals.characters),
        0,
      ),
    },
  };
};
