import { captureOutlineSource } from "../src/graph-outline.ts";
// Why: in a live run five parallel record_evidence calls on the head tree took 188–239 s each,
// because each built the whole tree's search index (every blob read and chunked) only to read one
// path's declared kinds. record_evidence now reads the kinds for that path alone, and a turn's
// parallel defs, outline and symbol_at calls share one index build. Neither change shows except as
// time, so this pins what they must keep: the kinds a record stores are the ones the tree index's
// declarations give (a declared test file and an undeclared file), and concurrent index requests
// for one tree get one build, not one each.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Layer } from "effect";
import {
  Blobs,
  Computations,
  Store,
  storeLocationIn,
} from "@neuve/records-core";
import { kindsOf, readDeclarations } from "../src/declarations.ts";
import {
  HandleRegistry,
  revisionViews,
  sharedTreeIndex,
  type LookupContext,
} from "../src/lookups.ts";
import { defaultManifestSettings, rangeManifest } from "../src/manifest.ts";
import { treeIndex } from "../src/search-index.ts";

const directory = mkdtempSync(join(tmpdir(), "harness-kinds-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const repository = join(directory, "repo");
const git = (...args: Array<string>) => {
  const result = Bun.spawnSync(["git", "-C", repository, ...args], {
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
};
const commit = (message: string, files: Record<string, string>) => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(repository, path, ".."), { recursive: true });
    writeFileSync(join(repository, path), text);
  }
  git("add", ".");
  git(
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.test",
    "commit",
    "-q",
    "-m",
    message,
  );
  return git("rev-parse", "HEAD");
};

test("a record's kinds match the tree index's declarations, and concurrent index requests share one build", async () => {
  Bun.spawnSync(["git", "init", "-q", repository]);
  const files = {
    "package.json": JSON.stringify({ scripts: { test: "bun test ./tests" } }),
    "tests/widget.test.ts":
      'import { widget } from "../src/widget.ts";\nwidget();\n',
    "src/widget.ts": "export const widget = () => 1;\n",
  };
  const base = commit("one", {
    ...files,
    "src/main.ts": "export const a = 1;\n",
  });
  const head = commit("two", {
    ...files,
    "src/main.ts": "export const a = 2;\n",
  });
  const location = storeLocationIn(join(directory, "store"));
  const result = await Effect.runPromise(
    Effect.andThen(
      Store.prepareForWrite,
      Effect.gen(function* () {
        const manifest = (yield* rangeManifest(
          repository,
          { baseOid: base, headOid: head },
          defaultManifestSettings(1_000_000),
          captureOutlineSource(),
        )).value;
        const views = yield* revisionViews(repository, manifest);
        const records = yield* Effect.context<
          Blobs.BlobStore | Computations.ComputationStore
        >();
        const ctx: LookupContext = {
          source: captureOutlineSource(),
          repository,
          location,
          cycleId: "cycle",
          manifest,
          head: views.head,
          base: views.base,
          hunks: new Map(manifest.hunks.map((hunk) => [hunk.hunkId, hunk])),
          commits: [],
          snapshot: undefined,
          records,
          handles: new HandleRegistry(),
        };
        const paths = ["tests/widget.test.ts", "src/widget.ts"];
        const declared = yield* readDeclarations({
          repository,
          revision: views.head.commit,
          tree: [...views.head.entries.values()],
          paths,
        });
        const kinds = paths.map(
          (path) => [path, kindsOf(declared, path)] as const,
        );
        // Three concurrent requests for a tree not yet indexed.
        const shared = yield* Effect.all(
          [1, 2, 3].map(() =>
            sharedTreeIndex(
              repository,
              views.head.tree,
              captureOutlineSource(),
            ),
          ),
          { concurrency: "unbounded" },
        );
        const index = yield* treeIndex(
          repository,
          views.head.tree,
          captureOutlineSource(),
        );
        return { kinds, shared, index };
      }),
    ).pipe(
      Effect.provide(
        Computations.layer.pipe(Layer.provideMerge(Blobs.layer(location))),
      ),
      Effect.provide(Store.layer(location, { create: true })),
      Effect.provide(BunFileSystem.layer),
    ),
  );
  const kinds = result.kinds;
  expect(kinds).toEqual([
    ["tests/widget.test.ts", ["test"]],
    ["src/widget.ts", "undeclared"],
  ]);
  for (const [path, kind] of kinds) {
    const indexed = kindsOf(result.index.index.declarations, path);
    expect(kind).toEqual(indexed === "undeclared" ? indexed : [...indexed]);
  }
  // One build: every caller holds the same index object.
  expect(new Set(result.shared.map((entry) => entry.index)).size).toBe(1);
}, 60_000);
