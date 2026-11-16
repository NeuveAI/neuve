import { captureOutlineSource } from "../src/graph-outline.ts";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Layer, Option } from "effect";
import {
  Blobs,
  Computations,
  Store,
  storeLocationIn,
} from "@neuve/records-core";
import {
  fakeExecutable,
  removeRoots,
} from "../../graph-client/tests/graph-client-support.ts";
import {
  frozenResults,
  frozenRetriever,
  type FrozenRow,
} from "../src/frozen.ts";
import { graphRetriever } from "../src/graph-search.ts";
import { GitReadSession } from "@neuve/graph-client/git-read-session";
import {
  GitReadSnapshot,
  withGitReadSnapshot,
} from "../src/git-read-snapshot.ts";
import { describeHunks, type HunkRecord } from "../src/hunks.ts";
import { diffTrees, parseDiff } from "../src/git-objects.ts";
import { DEFAULT_RETRIEVER, bm25Retriever } from "../src/retriever.ts";
import { graphConfigFor } from "../src/search-config.ts";
import { INDEX_BOUNDS, treeIndex } from "../src/search-index.ts";

const roots: string[] = [];
afterEach(async () => {
  await removeRoots();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "git-retrieval-"));
  roots.push(root);
  const command = (...args: string[]) => {
    const out = Bun.spawnSync(["git", "-C", root, ...args]);
    if (out.exitCode !== 0) throw new Error(out.stderr.toString());
    return out.stdout.toString().trim();
  };
  command("init", "-q");
  writeFileSync(
    join(root, "source.custom"),
    "alpha\nbeta\ngamma\ndelta\nepsilon\n",
  );
  writeFileSync(join(root, "other.custom"), "other text\n");
  command("add", ".");
  command(
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.test",
    "commit",
    "-qm",
    "base",
  );
  const commit = command("rev-parse", "HEAD");
  const tree = command("rev-parse", "HEAD^{tree}");
  const oid = command("rev-parse", "HEAD:source.custom");
  const removeBlob = () =>
    rmSync(join(root, ".git", "objects", oid.slice(0, 2), oid.slice(2)));
  const location = storeLocationIn(join(root, "store"));
  const layer = Computations.layer.pipe(
    Layer.provideMerge(Blobs.layer(location)),
    Layer.provideMerge(
      Layer.effectDiscard(Store.prepareForWrite).pipe(
        Layer.provideMerge(Store.layer(location, { create: true })),
      ),
    ),
    Layer.provideMerge(BunFileSystem.layer),
  );
  return { root, command, commit, tree, oid, removeBlob, layer };
};

// Why: a listed object unavailable without lazy fetching must disclose unreadable text, including fallback leads.
test("frozen retrieval distinguishes unreadable text from paths absent from the base", async () => {
  const f = fixture();
  await Effect.runPromise(
    Effect.gen(function* () {
      const { index } = yield* treeIndex(
        f.root,
        f.tree,
        captureOutlineSource(),
      );
      f.removeBlob();
      const hunk = (yield* describeHunks(
        f.root,
        parseDiff(
          `diff --git a/other.custom b/other.custom\nindex ${f.command("rev-parse", "HEAD:other.custom")}..${f.command("rev-parse", "HEAD:other.custom")} 100644\n--- a/other.custom\n+++ b/other.custom\n@@ -1 +1 @@\n-other text\n+other text\n`,
        ),
        captureOutlineSource(),
      ))[0];
      if (hunk === undefined || hunk.query === null)
        throw new Error("Missing test hunk");
      const row: FrozenRow = {
        caseId: `fixture:${f.commit}..${f.commit}`,
        path: hunk.path,
        diffText: hunk.text,
        regions: [["source.custom", 1, 2, null, "code", 1, 1]],
      };
      const config = {
        id: "frozen",
        candidate: "fixture",
        sha256: "a".repeat(64),
        fallback: DEFAULT_RETRIEVER,
      } as const;
      const leads = (regions: FrozenRow["regions"]) =>
        frozenRetriever(
          f.root,
          index,
          config,
          [{ ...row, regions }],
          bm25Retriever(f.root, index),
          5,
          { mergeBase: f.commit, headOid: f.commit },
          [hunk],
        ).leadsFor?.(hunk) ?? Effect.die("Missing leadsFor");
      yield* withGitReadSnapshot(
        f.root,
        INDEX_BOUNDS.maxFileBytes,
      )(
        Effect.gen(function* () {
          expect(
            yield* frozenResults(
              f.root,
              index,
              row,
              "fixture",
              hunk.query?.sha256 ?? "",
              5,
            ),
          ).toMatchObject({ results: [], skipped: 1, unreadable: 1 });
          expect(yield* leads(row.regions)).toEqual({
            note: "1 region(s) of fixture's row are in the base tree, but their text could not be read and they were skipped; these are bm25's leads",
          });
          const mixed = yield* leads([
            ...row.regions,
            ["absent.custom", 1, 1, null, "code", 1, 1],
            ["other.custom", 1, 1, null, "code", 1, 1],
          ]);
          expect(mixed?.results?.map((result) => result.identity.path)).toEqual(
            ["other.custom"],
          );
          expect(mixed?.note).toBe(
            "1 region(s) of fixture's row were not in the base tree and were skipped; 1 region(s) of fixture's row are in the base tree, but their text could not be read and they were skipped",
          );
        }),
      );
    }).pipe(Effect.provide(f.layer)),
  );
});

// Why: a successful Graph answer can name a listed blob the snapshot cannot read, without claiming that path is absent.
test("Graph retrieval discloses a listed blob whose text is unavailable", async () => {
  const f = fixture();
  const runtime = {
    executable: await fakeExecutable("prepared-valid"),
    workDirectory: join(f.root, "graph"),
  };
  await Effect.runPromise(
    Effect.gen(function* () {
      const { index } = yield* treeIndex(
        f.root,
        f.tree,
        captureOutlineSource(),
      );
      const config = yield* graphConfigFor(runtime);
      const retriever = graphRetriever(
        f.root,
        index,
        f.commit,
        config,
        runtime,
        30000,
      );
      const query = { text: "alpha", sha256: "a".repeat(64), limit: 5 };
      expect(
        (yield* retriever.search(query)).results.map(
          (result) => result.identity.path,
        ),
      ).toEqual(["source.custom"]);
      f.removeBlob();
      const answer = yield* withGitReadSnapshot(
        f.root,
        INDEX_BOUNDS.maxFileBytes,
      )(retriever.search(query));
      expect(answer.results).toEqual([]);
      expect(answer.gaps).toEqual([
        "1 Graph result(s) are in the base tree, but their text could not be read",
      ]);
    }).pipe(Effect.provide(f.layer)),
  );
}, 30000);

// Why: the shared hunk read must succeed for a 70 MiB changed text blob and still enrich the other file's hunk.
test("describeHunks keeps other files when a changed text blob exceeds the full-read bound", async () => {
  const f = fixture();
  // Repeated text compresses cheaply; avoid generating or diffing 70 MiB of lines.
  const large = Bun.spawnSync(
    [
      "git",
      "-C",
      f.root,
      "-c",
      "core.compression=1",
      "hash-object",
      "-w",
      "--stdin",
    ],
    { stdin: Buffer.alloc(70 * 1024 * 1024, 65) },
  );
  expect(large.exitCode).toBe(0);
  const largeOid = large.stdout.toString().trim();
  const smallOid = f.command("rev-parse", "HEAD:other.custom");
  const files = parseDiff(
    `diff --git a/large.custom b/large.custom\nnew file mode 100644\nindex ${"0".repeat(40)}..${largeOid}\n--- /dev/null\n+++ b/large.custom\n@@ -0,0 +1 @@\n+large text\n` +
      `diff --git a/other.custom b/other.custom\nnew file mode 100644\nindex ${"0".repeat(40)}..${smallOid}\n--- /dev/null\n+++ b/other.custom\n@@ -0,0 +1 @@\n+other text\n`,
  );
  const records = await Effect.runPromise(
    withGitReadSnapshot(
      f.root,
      INDEX_BOUNDS.maxFileBytes,
    )(describeHunks(f.root, files, captureOutlineSource())).pipe(
      Effect.provide(f.layer),
    ),
  );
  expect(records.map((record) => [record.path, record.text])).toEqual([
    ["large.custom", "@@ -0,0 +1 @@\n+large text\n"],
    ["other.custom", "@@ -0,0 +1 @@\n+other text\n"],
  ]);
  expect(records[0]?.query).toBeNull();
  expect(records[1]?.query?.text).toContain("other text");
  expect(records[1]?.enclosing).not.toBeNull();
}, 30000);

// Why: cold hunk reads larger than the unretained-call limit must preserve every query and its original order.
test("describeHunks groups bodies and matches main with no map room", async () => {
  const f = fixture();
  const ids: string[] = [];
  for (let i = 0; i < 40; i++) {
    const bytes = Buffer.alloc(2 * 1024 * 1024, 65);
    bytes.write(`body ${i}\n`);
    const hashed = Bun.spawnSync(
      [
        "git",
        "-C",
        f.root,
        "-c",
        "core.compression=1",
        "hash-object",
        "-w",
        "--stdin",
      ],
      { stdin: bytes },
    );
    expect(hashed.exitCode).toBe(0);
    ids.push(hashed.stdout.toString().trim());
  }
  const files = parseDiff(
    ids
      .map(
        (oid, i) =>
          `diff --git a/file${i}.custom b/file${i}.custom\nnew file mode 100644\nindex ${"0".repeat(40)}..${oid}\n--- /dev/null\n+++ b/file${i}.custom\n@@ -0,0 +1 @@\n+body ${i}\n`,
      )
      .join(""),
  );
  const snapshot = await GitReadSession.open(f.root, { retainedBytes: 0 });
  try {
    const [main, actual] = await Effect.runPromise(
      Effect.gen(function* () {
        const main = yield* describeHunks(
          f.root,
          files,
          captureOutlineSource(),
        );
        const actual = yield* describeHunks(
          f.root,
          files,
          captureOutlineSource(),
        ).pipe(Effect.provideService(GitReadSnapshot, Option.some(snapshot)));
        return [main, actual] as const;
      }).pipe(Effect.provide(f.layer)),
    );
    expect(actual).toEqual(main);
    expect(actual.map((record) => record.path)).toEqual(
      ids.map((_, i) => `file${i}.custom`),
    );
    expect(actual.every((record) => record.query !== null)).toBe(true);
    expect(snapshot.counters.oversized).toBe(0);
    expect(snapshot.counters.unretained).toBe(40);
    expect(snapshot.counters.uniqueObjectsRead).toBe(40);
    expect(snapshot.retainedBytes).toBe(0);
  } finally {
    await snapshot.close();
  }
}, 30000);

// Why: a typechange can put an excluded symlink and its chunkable regular file on opposite sides of a read group.
test("describeHunks keeps the captured hunk and query data when a shared symlink blob straddles groups", async () => {
  const f = fixture();
  const content =
    "export function foo() { return 1; }\nexport function bar() { return 2; }\n";
  const available = 16 * 1024 * 1024 - Buffer.byteLength(content);
  const oldSize = Math.floor(available / 2) - 1;
  const newSize = available - oldSize;
  const line = "a".repeat(39) + "\n";
  const body = (size: number, tail: string) =>
    line.repeat(Math.floor((size - tail.length) / line.length)) +
    "b".repeat((size - tail.length) % line.length) +
    tail;
  writeFileSync(join(f.root, "aaa.txt"), body(oldSize, ""));
  symlinkSync(content, join(f.root, "z.ts"));
  f.command("add", ".");
  f.command(
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.test",
    "commit",
    "-qm",
    "symlink",
  );
  const base = f.command("rev-parse", "HEAD");
  writeFileSync(join(f.root, "aaa.txt"), body(newSize, "T\n"));
  rmSync(join(f.root, "z.ts"));
  writeFileSync(join(f.root, "z.ts"), content);
  f.command("add", ".");
  f.command(
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.test",
    "commit",
    "-qm",
    "regular",
  );
  const files = await Effect.runPromise(
    diffTrees(f.root, base, f.command("rev-parse", "HEAD")),
  );
  const snapshot = await GitReadSession.open(f.root);
  try {
    const run = describeHunks(f.root, files, captureOutlineSource());
    for (const work of [
      run,
      run.pipe(Effect.provideService(GitReadSnapshot, Option.some(snapshot))),
    ]) {
      const actual = await Effect.runPromise(
        work.pipe(Effect.provide(f.layer)),
      );
      expect(actual).toEqual(MAIN_STRADDLING_HUNKS);
      expect(
        actual
          .filter((record) => record.path === "z.ts")
          .every(
            (record) =>
              record.enclosing !== null && record.query?.symbols.length === 2,
          ),
      ).toBe(true);
    }
  } finally {
    await snapshot.close();
  }
}, 30000);

// Main at 95e5710e captured this exact blob fixture; Graph replaces only the parser capability and language labels.
const MAIN_STRADDLING_HUNKS: ReadonlyArray<HunkRecord> = [
  {
    path: "aaa.txt",
    oldPath: "aaa.txt",
    newPath: "aaa.txt",
    oldOid: "ba0efe19f730d26a67ea0c63acd14b1074239a2d",
    newOid: "57d288d213d5a75967ade8637953a0be31d21ae5",
    status: "modified",
    oldMode: "100644",
    newMode: "100644",
    hunkId: "hdb9301286812e19",
    contentKey:
      "37088a4274fd5bdb3b10e38906a7ef75ecdc986073e52a624eb793486d31ffe9",
    kind: "text",
    oldStart: 209712,
    oldLines: 4,
    newStart: 209712,
    newLines: 4,
    added: 1,
    deleted: 1,
    text: "@@ -209712,4 +209712,4 @@ aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n-bbbbbbbbbbb\n\\ No newline at end of file\n+bbbbbbbbbbbT\n",
    textSha256:
      "837eed11ac33fab12f43c1f614ad492ed3e9141bcb269ab24999d4509cc10115",
    enclosing: null,
    query: {
      recipe: "q1-path-symbol-hunk-v1",
      side: "post",
      path: "aaa.txt",
      startLine: 209712,
      endLine: 209715,
      symbols: [],
      droppedLines: 0,
      text: "path: aaa.txt\n\naaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\naaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\naaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nbbbbbbbbbbbT",
      sha256:
        "45e05fbcdf7ab5b593ca85c4d0875d46c54dfb734674d4b73920d8a988b311a3",
    },
  },
  {
    path: "z.ts",
    oldPath: "z.ts",
    newPath: null,
    oldOid: "5d147fd6748a6e92c3afa6031b4446ee661bac5e",
    newOid: null,
    status: "deleted",
    oldMode: "120000",
    newMode: null,
    hunkId: "h8fff609f4baee27",
    contentKey:
      "e8fa1504eed261c726a906c62f461c41f57d7a0726633fb6a957330c4e607d7a",
    kind: "text",
    oldStart: 1,
    oldLines: 2,
    newStart: 0,
    newLines: 0,
    added: 0,
    deleted: 2,
    text: "@@ -1,2 +0,0 @@\n-export function foo() { return 1; }\n-export function bar() { return 2; }\n",
    textSha256:
      "bbb5199c8cbb89bb8f3da00a3ecea1e5be4515ddbd2a35d990eb86720aeaf3e7",
    enclosing: {
      side: "pre",
      symbols: ["foo", "bar"],
      headingPath: [],
      capability: "graph-symbols",
      language: "TypeScript",
      limitation: null,
    },
    query: {
      recipe: "q1-path-symbol-hunk-v1",
      side: "pre",
      path: "z.ts",
      startLine: 1,
      endLine: 2,
      symbols: ["foo", "bar"],
      droppedLines: 0,
      text: "path: z.ts\nsymbol: foo, bar\n\nexport function foo() { return 1; }\nexport function bar() { return 2; }",
      sha256:
        "755979e1e45d5e9145b40aa01d4cb328201c3494621f67953ff7974666ccb1a4",
    },
  },
  {
    path: "z.ts",
    oldPath: null,
    newPath: "z.ts",
    oldOid: null,
    newOid: "5d147fd6748a6e92c3afa6031b4446ee661bac5e",
    status: "added",
    oldMode: null,
    newMode: "100644",
    hunkId: "h89858435225b877",
    contentKey:
      "2bad584876d51e4c054efac7da892e1c12abf0b79eeaceaedd972655d5dc0dfd",
    kind: "text",
    oldStart: 0,
    oldLines: 0,
    newStart: 1,
    newLines: 2,
    added: 2,
    deleted: 0,
    text: "@@ -0,0 +1,2 @@\n+export function foo() { return 1; }\n+export function bar() { return 2; }\n",
    textSha256:
      "98392c6d9bb811d35d6951ac5ec833cd0ffcf0b95b8e3496961627cd45fa159b",
    enclosing: {
      side: "post",
      symbols: ["foo", "bar"],
      headingPath: [],
      capability: "graph-symbols",
      language: "TypeScript",
      limitation: null,
    },
    query: {
      recipe: "q1-path-symbol-hunk-v1",
      side: "post",
      path: "z.ts",
      startLine: 1,
      endLine: 2,
      symbols: ["foo", "bar"],
      droppedLines: 0,
      text: "path: z.ts\nsymbol: foo, bar\n\nexport function foo() { return 1; }\nexport function bar() { return 2; }",
      sha256:
        "755979e1e45d5e9145b40aa01d4cb328201c3494621f67953ff7974666ccb1a4",
    },
  },
];
