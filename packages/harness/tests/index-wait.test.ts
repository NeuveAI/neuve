import { captureOutlineSource } from "../src/graph-outline.ts";
// Why: a review's lookups once waited with no bound on the one shared build of a tree's search
// index, and under load that wait outlasted the review (NEU-148, plant 108: 479 to 511 s per call).
// Each lookup now waits at most a short bound, and the build is one shared run that must carry on
// when its only waiter stops waiting (record 0016). Wrong here, a tool call would hang on the build
// again, or the bound would withdraw the build so a later call builds it a second time, or `uses`
// would answer differently by route, which the model would see and a replay would not reproduce.
// These tests hold the build itself (its first multi-key store read) with a deferred, so the wait
// is deterministic, and check each tool at its boundary:
// - `uses` git greps the tree with the reason `index-building` while the build is held, and a later
//   lookup takes the index the same build made;
// - `uses` waits at most one bound for the enclosing regions of the files it shows: a file whose
//   chunk computation is held shows its matches as ten-line windows with one bracketed line, the
//   computation runs once and completes, and a later call names the regions. Wrong here, a call
//   would hang behind a running build's Graph outlines again (the review of the first round);
// - with every shown file's chunks ready, `uses` answers byte for byte as before this bound, on
//   the git-grep route and the index route alike;
// - a failed build still answers `index-unavailable`;
// - `defs` and `search` answer with a disclosed gap, keep it for the same call in the attempt, and
//   give the real answer in a later turn once the build has ended;
// - `semantic_search` (E0) does the same, and gets the index once, under the bound: it once got it
//   a second time, with no bound, to build its retriever, so a tree whose index left the process's
//   cache between the two gets held the call on a rebuild (the review of the second round);
// - with the index ready, `semantic_search` answers as it did before that change.
import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Context, Deferred, Effect, Fiber, Layer, Tracer } from "effect";
import {
  Blobs,
  Computations,
  Store,
  Worker,
  storeLocationIn,
} from "@neuve/records-core";
import { benchChunkSpec, E0_DIMENSIONS } from "../src/e0.ts";
import * as L from "../src/lookups.ts";
import { defaultManifestSettings, rangeManifest } from "../src/manifest.ts";
import { runLogTracer, type RunLogRecord } from "../src/run-log.ts";
import {
  E0_RETRIEVER,
  searchRuntime,
  setSearchRuntime,
} from "../src/search-config.ts";
import type { TreeIndex } from "../src/search-index.ts";

const directory = mkdtempSync(join(tmpdir(), "harness-index-wait-"));
const runtimeBefore = searchRuntime();
afterAll(() => {
  setSearchRuntime(runtimeBefore);
  rmSync(directory, { recursive: true, force: true });
});

/** A fresh repository per test: an index is published per repository and tree. */
const repositoryFor = (name: string) => {
  const repository = join(directory, name);
  const git = (...args: Array<string>) => {
    const result = Bun.spawnSync(["git", "-C", repository, ...args], {
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        // Fixed dates, so a test's commits, and the answers that name them, are the same each run.
        GIT_AUTHOR_DATE: "2026-11-13T12:00:00Z",
        GIT_COMMITTER_DATE: "2026-11-13T12:00:00Z",
      },
    });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  const commit = (message: string) => {
    git("add", "-A");
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
  Bun.spawnSync(["git", "init", "-q", repository]);
  mkdirSync(join(repository, "src"), { recursive: true });
  writeFileSync(
    join(repository, "src", "count.ts"),
    "export function widgetCount() {\n  return 1;\n}\n",
  );
  // The test's name in the trees: an index built in this process is kept in memory by tree.
  writeFileSync(
    join(repository, "README.md"),
    `# Widgets for ${name}\n\nNothing yet.\n`,
  );
  const base = commit("base");
  writeFileSync(
    join(repository, "src", "use.ts"),
    "import { widgetCount } from './count';\n\nexport const total = () => widgetCount() + 1;\n",
  );
  writeFileSync(
    join(repository, "README.md"),
    `# Widgets for ${name}\n\nCall \`widgetCount\` for the count.\n`,
  );
  const head = commit("use it");
  // A later commit no manifest names, so no lead search has built its tree's index, and a file
  // in it no index or range has stored chunks for.
  writeFileSync(
    join(repository, "src", "more.ts"),
    "import { widgetCount } from './count';\n\nexport const more = () => widgetCount() * 2;\n",
  );
  const later = commit("more");
  return {
    repository,
    base,
    head,
    later,
    laterTree: git("rev-parse", `${later}^{tree}`),
  };
};

class TreeReadFailed extends Error {
  readonly _tag = "TreeReadFailed";
  constructor() {
    super("tree read failed");
  }
}

/**
 * A store whose multi-key reads, which a tree's index build makes and a single file's chunks
 * never do, wait on `release` while `holding`, or fail while `failing`. Every multi-key read's
 * keys are kept, so a build that ran twice shows its first read twice. The chunk computation of the
 * blob at `chunkPath`, once it runs, waits on `chunkRelease`; `chunkRuns` counts its runs.
 */
const heldStore = (store: Computations.ComputationStore["Service"]) =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const chunkEntered = yield* Deferred.make<void>();
    const chunkRelease = yield* Deferred.make<void>();
    const hold = {
      holding: true,
      failing: false,
      reads: [] as Array<string>,
      entered,
      release,
      chunkPath: undefined as string | undefined,
      chunkRuns: 0,
      chunkEntered,
      chunkRelease,
    };
    const wrapped: Computations.ComputationStore["Service"] = {
      ...store,
      run: (spec, compute) =>
        spec.op === "harness.blob-chunks" &&
        hold.chunkPath !== undefined &&
        (spec.config as { path?: unknown }).path === hold.chunkPath
          ? store.run(
              spec,
              Effect.gen(function* () {
                hold.chunkRuns++;
                yield* Deferred.succeed(chunkEntered, undefined);
                yield* Deferred.await(chunkRelease);
                return yield* compute;
              }),
            )
          : store.run(spec, compute),
      lookupMany: (keys) =>
        keys.length < 2
          ? store.lookupMany(keys)
          : Effect.gen(function* () {
              hold.reads.push(JSON.stringify(keys));
              if (hold.failing)
                return yield* Effect.fail(new TreeReadFailed() as never);
              if (hold.holding) {
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
              }
              return yield* store.lookupMany(keys);
            }),
    };
    return { hold, wrapped };
  });

const storeLayer = (location: ReturnType<typeof storeLocationIn>) =>
  Computations.layer.pipe(
    Layer.provideMerge(Blobs.layer(location)),
    Layer.provideMerge(
      Layer.effectDiscard(Store.prepareForWrite).pipe(
        Layer.provideMerge(Store.layer(location, { create: true })),
      ),
    ),
    Layer.provideMerge(BunFileSystem.layer),
  );

/**
 * A lookup context over a held store, in one attempt of a run, with its gaps kept. The manifest's
 * lead search builds the base's index, so `unbuiltBase` sets the context's base to a later commit
 * whose index nothing has built.
 */
const setup = (name: string, unbuiltBase = false) =>
  Effect.gen(function* () {
    const { repository, base, head, later, laterTree } = repositoryFor(name);
    const location = storeLocationIn(join(directory, `${name}-store`));
    const manifest = (yield* rangeManifest(
      repository,
      { baseOid: base, headOid: head },
      defaultManifestSettings(1_000_000),
      captureOutlineSource(),
    )).value;
    const views = yield* L.revisionViews(
      repository,
      unbuiltBase
        ? {
            ...manifest,
            range: { ...manifest.range, mergeBase: later, baseTree: laterTree },
          }
        : manifest,
    );
    const records = yield* Effect.context<
      Blobs.BlobStore | Computations.ComputationStore
    >();
    const { hold, wrapped } = yield* heldStore(
      Context.get(records, Computations.ComputationStore),
    );
    const gaps: Array<string> = [];
    const ctx: L.LookupContext = {
      source: captureOutlineSource(),
      repository,
      location,
      cycleId: "cycle",
      manifest,
      head: views.head,
      base: views.base,
      hunks: new Map(manifest.hunks.map((hunk) => [hunk.hunkId, hunk])),
      commits: yield* L.rangeCommits(repository, manifest),
      snapshot: undefined,
      records: Context.add(records, Computations.ComputationStore, wrapped),
      handles: new L.HandleRegistry(),
      searchFrequency: new Map(),
      attempt: { runId: "run-1", agent: "find.correctness" },
      onGap: (detail) => gaps.push(detail),
    };
    /** The tree's index with no bound, joined as any other caller joins its one build. */
    const built = (tree: string) =>
      L.sharedTreeIndex(repository, tree, ctx.source).pipe(
        Effect.provide(ctx.records),
      );
    return { ctx, hold, gaps, built };
  });

const traced = <A extends object>(
  name: string,
  program: (
    records: Array<RunLogRecord>,
  ) => Effect.Effect<
    A,
    unknown,
    Blobs.BlobStore | Computations.ComputationStore
  >,
) => {
  const records: Array<RunLogRecord> = [];
  const log = {
    path: "",
    write: (record: RunLogRecord) => {
      records.push(JSON.parse(JSON.stringify(record)) as RunLogRecord);
    },
    read: () => records,
  };
  return Effect.runPromise(
    program(records).pipe(
      Effect.map((value) => ({ ...value, records })),
      Effect.provide(storeLayer(storeLocationIn(join(directory, name)))),
      Effect.provideService(Tracer.Tracer, runLogTracer(log)),
    ),
  );
};

/** A step that names itself when it hangs, so a held wait shows where it is. */
const step = <A, E, R>(label: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.timeoutOrElse({
      duration: 40_000,
      orElse: () => Effect.die(new Error(`hung at: ${label}`)),
    }),
  );

const spans = (records: Array<RunLogRecord>, name: string) =>
  records
    .filter((record) => record.type === "span" && record["name"] === name)
    .map((span) => span["attributes"] as Record<string, unknown>);

test("uses answers within its bounds while the build and a shown file's chunks are held, and both carry on", async () => {
  const result = await traced("uses-layer", () =>
    Effect.gen(function* () {
      // The base is the later commit, whose index nothing has built.
      const { ctx, hold, built } = yield* setup("uses", true);
      // In neither the range nor an index built so far, so nothing stored its chunks: the call
      // reads them itself. The other files' chunks are stored.
      hold.chunkPath = "src/more.ts";
      const tool = L.usesTool(ctx);
      const uses = (params: Record<string, unknown>) =>
        tool
          .handle(tool.input?.parse(params))
          .pipe(Effect.withSpan("harness.test.ask"));
      // The tree's build is held inside its own run, and so is the one file's chunk computation;
      // the lookup answers without either.
      const started = Date.now();
      const asked = yield* Effect.forkChild(
        uses({ identifier: "widgetCount", rev: "base" }),
        { startImmediately: true },
      );
      yield* step("build held", Deferred.await(hold.entered));
      const held = yield* step("held answer", Fiber.join(asked));
      const heldMs = Date.now() - started;
      // The chunk computation the call stopped waiting on still runs, and is held.
      yield* step("chunks held", Deferred.await(hold.chunkEntered));
      const stillHeld =
        !(yield* Deferred.isDone(hold.release)) &&
        !(yield* Deferred.isDone(hold.chunkRelease));
      const firstRead = hold.reads[0];
      // Released, the same build and the same chunk computation end; joining starts no second one.
      hold.holding = false;
      yield* Deferred.succeed(hold.release, undefined);
      yield* Deferred.succeed(hold.chunkRelease, undefined);
      yield* step("build ended", built(ctx.base.tree));
      const indexed = yield* step(
        "later call",
        uses({ identifier: "widgetCount", rev: "base" }),
      );
      const buildReads = hold.reads.filter((keys) => keys === firstRead);
      // A failed build still answers by git grep, saying the index is unavailable (a base whose
      // index the manifest's lead search has not built).
      const other = yield* setup("uses-failed", true);
      other.hold.holding = false;
      other.hold.failing = true;
      const otherTool = L.usesTool(other.ctx);
      const failed = yield* otherTool.handle(
        otherTool.input?.parse({ identifier: "more", rev: "base" }),
      );
      return {
        held,
        heldMs,
        stillHeld,
        indexed,
        failed,
        buildReads: buildReads.length,
        chunkRuns: hold.chunkRuns,
      };
    }),
  );
  expect(result.stillHeld).toBe(true);
  // Within the two bounds, with room for the grep and a loaded machine.
  expect(result.heldMs).toBeLessThan(
    L.USES_INDEX_WAIT_MS + L.USES_ENCLOSING_WAIT_MS + 5_000,
  );
  expect(result.held.error).toBeUndefined();
  expect(result.indexed.error).toBeUndefined();
  // The held file's match is the ten lines around it, with no capability or enclosing name, and
  // one bracketed line says how many files were not ready; the later call names the region.
  const NOTE =
    "[enclosing regions not ready yet in 1 file(s): their matches show ten lines around them; ask again later for the enclosing symbol]";
  expect(result.held.text).toMatch(
    /\nsrc\/more\.ts\n {2}1 h[0-9a-z]+: import \{ widgetCount \} from '\.\/count';\n {2}3 h[0-9a-z]+: export const more = \(\) => widgetCount\(\) \* 2;\n/,
  );
  expect(result.held.text).toContain(NOTE);
  expect(result.indexed.text).toMatch(
    /\nsrc\/more\.ts \(parsed by [^)\n]+\)\n {2}1 [^\n]+\n {2}3 in more h[0-9a-z]+: export const more = \(\) => widgetCount\(\) \* 2;\n/,
  );
  expect(result.indexed.text).not.toContain("not ready yet");
  // Every other file's lines are the same, byte for byte, with their enclosing regions. The data
  // block's tag names a hash of its body, so it is left out with the held file's lines.
  const others = (text: string) => {
    let held = false;
    return text.split("\n").filter((line) => {
      if (!line.startsWith("  ")) held = line.startsWith("src/more.ts");
      return !held && line !== NOTE && !/^<\/?data-/.test(line);
    });
  };
  expect(others(result.held.text)).toEqual(others(result.indexed.text));
  expect(result.held.text).toContain("src/count.ts (parsed by");
  expect(result.held.text).toContain("1 in widgetCount");
  // One build and one chunk computation, each run once and completed.
  expect(result.buildReads).toBe(1);
  expect(result.chunkRuns).toBe(1);
  expect(spans(result.records, L.USES_SPAN)).toHaveLength(3);
  expect(spans(result.records, L.USES_SPAN)[0]).toMatchObject({
    "harness.lookup.route": "git-grep",
    "harness.lookup.fallback_reason": "index-building",
  });
  expect(spans(result.records, L.USES_SPAN)[1]).toMatchObject({
    "harness.lookup.route": "index",
  });
  expect(spans(result.records, L.USES_SPAN)[2]).toMatchObject({
    "harness.lookup.route": "git-grep",
    "harness.lookup.fallback_reason": "index-unavailable",
  });
  expect(spans(result.records, "harness.test.ask")[0]).toMatchObject({
    "harness.lookup.enclosing_not_ready": 1,
  });
  expect(spans(result.records, "harness.test.ask")[1]).not.toHaveProperty(
    "harness.lookup.enclosing_not_ready",
  );
  expect(result.failed.text).toContain("1 occurrence(s) of more");
  expect(result.failed.text).toContain("src/more.ts");
}, 90_000);

test("uses with every shown file's chunks ready answers as before, on both routes", async () => {
  const result = await traced("ready-layer", () =>
    Effect.gen(function* () {
      const { ctx, hold, built } = yield* setup("ready");
      const tool = L.usesTool(ctx);
      // Both files are in the range, so the manifest stored their chunks: nothing waits on Graph.
      const uses = () =>
        tool.handle(
          tool.input?.parse({
            identifier: "widgetCount",
            paths: ["src/use.ts", "README.md"],
          }),
        );
      const asked = yield* Effect.forkChild(uses(), {
        startImmediately: true,
      });
      yield* step("build held", Deferred.await(hold.entered));
      const grepped = yield* step("held answer", Fiber.join(asked));
      hold.holding = false;
      yield* Deferred.succeed(hold.release, undefined);
      yield* step("build ended", built(ctx.head.tree));
      const indexed = yield* step("later call", uses());
      return { grepped, indexed };
    }),
  );
  // What `a52a4846`, before the bound on enclosing regions, answered for this call on this fixture.
  const before = {
    text: [
      '<data-315ba123e37cbf3e064ec1bc91a80d588937d9d2df27f0c0bff05f5649d3c595 kind="occurrences" identifier="widgetCount">',
      "3 occurrence(s) of widgetCount in 2 file(s) at head a6ac8d465d2e:",
      "README.md (parsed by markdown-sections)",
      "  3 in Widgets for ready h0d8cd3c13: Call `widgetCount` for the count.",
      "src/use.ts (parsed by graph-symbols)",
      "  1 in total h5e4d02d4c: import { widgetCount } from './count';",
      "  3 in total h5e4d02d4c: export const total = () => widgetCount() + 1;",
      "</data-315ba123e37cbf3e064ec1bc91a80d588937d9d2df27f0c0bff05f5649d3c595>",
    ].join("\n"),
    paged: false,
  };
  expect(result.grepped).toEqual(before);
  expect(result.indexed).toEqual(before);
  expect(spans(result.records, L.USES_SPAN)).toHaveLength(2);
  expect(spans(result.records, L.USES_SPAN)[0]).toMatchObject({
    "harness.lookup.route": "git-grep",
    "harness.lookup.fallback_reason": "index-building",
  });
  expect(spans(result.records, L.USES_SPAN)[1]).toMatchObject({
    "harness.lookup.route": "index",
  });
}, 90_000);

test("defs answers a disclosed gap while the build runs, keeps it for the call, and answers in a later turn", async () => {
  const result = await traced("defs-layer", () =>
    Effect.gen(function* () {
      const { ctx, hold, gaps, built } = yield* setup("defs");
      const tool = L.defsTool(ctx);
      const defs = () =>
        tool
          .handle(tool.input?.parse({ identifier: "widgetCount" }))
          .pipe(Effect.withSpan("harness.test.ask"));
      const asked = yield* Effect.forkChild(defs(), {
        startImmediately: true,
      });
      yield* step("build held", Deferred.await(hold.entered));
      const first = yield* step("held answer", Fiber.join(asked));
      const stillHeld = !(yield* Deferred.isDone(hold.release));
      hold.holding = false;
      yield* Deferred.succeed(hold.release, undefined);
      yield* step("build ended", built(ctx.head.tree));
      // The same call in the same turn, after the build: what the model saw.
      const again = yield* step("same call", defs());
      ctx.handles.turn = 1;
      const later = yield* step("later turn", defs());
      return {
        first,
        again,
        later,
        stillHeld,
        gaps: [...gaps],
      };
    }),
  );
  expect(result.stillHeld).toBe(true);
  expect(result.first.error).toBe("IndexPending");
  expect(result.first.text).toContain("is still being built");
  expect(result.first.text).toContain("use uses");
  expect(result.again).toEqual(result.first);
  expect(result.later.error).toBeUndefined();
  expect(result.later.text).toContain("1 declaration(s) of widgetCount");
  expect(result.later.text).toContain("src/count.ts");
  expect(result.gaps).toHaveLength(1);
  expect(result.gaps[0]).toContain("defs: the index for head");
  expect(spans(result.records, "harness.test.ask")[0]).toMatchObject({
    "harness.lookup.fallback_reason": "index-building",
  });
  expect(spans(result.records, "harness.test.ask")[2]).not.toHaveProperty(
    "harness.lookup.fallback_reason",
  );
}, 90_000);

test("search answers a disclosed gap while the base build runs, keeps it for the call, and answers in a later turn", async () => {
  const result = await traced("search-layer", () =>
    Effect.gen(function* () {
      const { ctx, hold, gaps, built } = yield* setup("search", true);
      const tool = L.searchTool(ctx);
      const search = () =>
        tool
          .handle({ query: "widget count", k: 3 })
          .pipe(Effect.withSpan("harness.test.ask"));
      const asked = yield* Effect.forkChild(search(), {
        startImmediately: true,
      });
      yield* step("build held", Deferred.await(hold.entered));
      const first = yield* step("held answer", Fiber.join(asked));
      const stillHeld = !(yield* Deferred.isDone(hold.release));
      hold.holding = false;
      yield* Deferred.succeed(hold.release, undefined);
      yield* step("build ended", built(ctx.base.tree));
      const again = yield* step("same call", search());
      ctx.handles.turn = 1;
      const later = yield* step("later turn", search());
      return {
        first,
        again,
        later,
        stillHeld,
        gaps: [...gaps],
      };
    }),
  );
  expect(result.stillHeld).toBe(true);
  expect(result.first.error).toBe("SearchUnavailable");
  expect(result.first.text).toContain(
    'search has not answered "widget count" yet: the index for base',
  );
  expect(result.first.text).toContain("This is a gap, not an empty result.");
  expect(result.again).toEqual(result.first);
  expect(result.later.error).toBeUndefined();
  expect(result.later.text).toContain("result(s) at base");
  expect(result.gaps).toHaveLength(1);
  expect(spans(result.records, "harness.test.ask")[0]).toMatchObject({
    "harness.lookup.fallback_reason": "index-building",
  });
}, 90_000);

/** A deterministic unit vector per seed, as the benchmark's stored vectors are. */
const unit = (seed: string) => {
  const values = new Float32Array(E0_DIMENSIONS);
  let state = createHash("sha256").update(seed).digest();
  for (let at = 0; at < E0_DIMENSIONS; at++) {
    if (at % 32 === 0)
      state = createHash("sha256").update(state).update(String(at)).digest();
    values[at] = (state[at % 32]! - 127.5) / 127.5;
  }
  const norm = Math.hypot(...values);
  return values.map((value) => value / norm);
};

/**
 * E0 set up with no encoder over a vector store of its own, as `search-tools` drives it: `vectors`
 * stores a vector for every chunk of an index (in a run of its own, since a layer provided inside
 * the test's run would reuse that run's store), and `query` stores the query's vector in the
 * lookup's store, pointed at a chunk, so no encoder runs.
 */
const e0 = (name: string) => {
  const vectorStore = join(directory, `${name}-vectors`);
  setSearchRuntime({
    e0: {
      python: "/nonexistent/python",
      snapshot: "/nonexistent/snapshot",
      worker: "/nonexistent/worker.py",
      vectorStore,
    },
    frozen: new Map(),
    problems: {},
  });
  const vectors = (index: TreeIndex) =>
    Effect.promise(() =>
      Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Computations.ComputationStore;
          for (const chunk of index.chunks)
            yield* store.run(
              benchChunkSpec(chunk.textSha256, chunk.path),
              Effect.succeed({
                bytes: new Uint8Array(unit(chunk.textSha256).buffer),
                mediaType: "application/octet-stream",
              }),
            );
        }).pipe(Effect.provide(storeLayer(storeLocationIn(vectorStore)))),
      ),
    );
  const query = (ctx: L.LookupContext, text: string, toward: string) =>
    Effect.gen(function* () {
      const store = yield* Computations.ComputationStore;
      yield* store.run(
        {
          op: "harness.e0-query",
          opVersion: 2,
          inputs: { query: createHash("sha256").update(text).digest("hex") },
          config: { model: E0_RETRIEVER.model, queries: E0_RETRIEVER.queries },
        },
        Effect.succeed({
          bytes: new TextEncoder().encode(
            JSON.stringify({
              values: [...unit(toward)],
              cut: [],
              keptCharacters: text.length,
            }),
          ),
          mediaType: "application/json",
        }),
      );
    }).pipe(Effect.provide(ctx.records));
  return { vectors, query };
};

/**
 * The admission gate a tree's index get passes (`indexOf` starts it there), counting the gets that
 * return an index. While `holdLater`, every get after the first in `gets` waits on `release`: it
 * stands for a get of a tree whose index left this process's cache after the first get (another
 * tree took its place, or `forgetDegradedIndexes` dropped it), which joins a rebuild.
 */
const indexGate = () =>
  Effect.gen(function* () {
    const release = yield* Deferred.make<void>();
    const base = Worker.HeavyWork.defaultValue();
    const gate = { gets: 0, holdLater: false, release };
    const service: Worker.HeavyWorkService = {
      ...base,
      start: (effect) =>
        Effect.tap(effect, (value) => {
          const isIndex =
            typeof value === "object" &&
            value !== null &&
            "index" in value &&
            "cached" in value;
          if (!isIndex) return Effect.void;
          gate.gets++;
          return gate.holdLater && gate.gets > 1
            ? Deferred.await(release)
            : Effect.void;
        }),
    };
    return { gate, service };
  });

test("semantic_search answers a disclosed gap while the base build runs, gets the index once under the bound, and answers in a later turn", async () => {
  const result = await traced("e0-layer", () =>
    Effect.gen(function* () {
      const { ctx, hold, gaps, built } = yield* setup("e0", true);
      const { vectors, query } = e0("e0");
      const { gate, service } = yield* indexGate();
      const text = "where is the widget count";
      const tool = L.semanticSearchTool(ctx, E0_RETRIEVER, {
        withVectors: 0,
        chunks: 0,
      });
      const search = () =>
        tool
          .handle({ query: text, k: 3 })
          .pipe(
            Effect.provideService(Worker.HeavyWork, service),
            Effect.withSpan("harness.test.ask"),
          );
      const started = Date.now();
      const asked = yield* Effect.forkChild(search(), {
        startImmediately: true,
      });
      yield* step("build held", Deferred.await(hold.entered));
      const first = yield* step("held answer", Fiber.join(asked));
      const heldMs = Date.now() - started;
      const stillHeld = !(yield* Deferred.isDone(hold.release));
      const firstRead = hold.reads[0];
      hold.holding = false;
      yield* Deferred.succeed(hold.release, undefined);
      const { index } = yield* step("build ended", built(ctx.base.tree));
      const target = index.chunks.find(
        (chunk) => chunk.path === "src/count.ts",
      )!;
      yield* vectors(index);
      yield* query(ctx, text, target.textSha256);
      // The same call in the same turn, after the build: what the model saw.
      const again = yield* step("same call", search());
      // A later turn: any index get after the call's first waits until the end of the test.
      ctx.handles.turn = 1;
      gate.gets = 0;
      gate.holdLater = true;
      const laterStarted = Date.now();
      const later = yield* step("later turn", search());
      const laterMs = Date.now() - laterStarted;
      const laterGets = gate.gets;
      yield* Deferred.succeed(gate.release, undefined);
      return {
        first,
        again,
        later,
        heldMs,
        laterMs,
        laterGets,
        stillHeld,
        buildReads: hold.reads.filter((keys) => keys === firstRead).length,
        target: `src/count.ts:${target.startLine}-${target.endLine}`,
        gaps: [...gaps],
      };
    }),
  );
  expect(result.stillHeld).toBe(true);
  expect(result.heldMs).toBeLessThan(L.INDEX_GAP_WAIT_MS + 5_000);
  expect(result.first.error).toBe("SearchUnavailable");
  expect(result.first.text).toContain(
    'semantic_search has not answered "where is the widget count" yet: the index for base',
  );
  expect(result.first.text).toContain("is still being built");
  expect(result.first.text).toContain("This is a gap, not an empty result.");
  expect(result.again).toEqual(result.first);
  // E0's real answer, with one index get and no wait on a second.
  expect(result.later.error).toBeUndefined();
  expect(result.later.text).toMatch(
    new RegExp(
      `1\\. h[0-9a-f]{9} ${result.target.replace(/[.]/g, "\\.")} @base`,
    ),
  );
  expect(result.later.text).toContain("· via e0, score");
  expect(result.laterGets).toBe(1);
  expect(result.laterMs).toBeLessThan(L.INDEX_GAP_WAIT_MS + 5_000);
  // One build, run once and completed.
  expect(result.buildReads).toBe(1);
  expect(result.gaps).toHaveLength(1);
  expect(result.gaps[0]).toContain("semantic_search: the index for base");
  expect(spans(result.records, "harness.test.ask")[0]).toMatchObject({
    "harness.lookup.fallback_reason": "index-building",
  });
  expect(spans(result.records, "harness.test.ask")[2]).not.toHaveProperty(
    "harness.lookup.fallback_reason",
  );
}, 90_000);

test("semantic_search with the index ready answers as before", async () => {
  const result = await traced("e0-ready-layer", () =>
    Effect.gen(function* () {
      // The manifest's lead search built the base's index.
      const { ctx, hold, built } = yield* setup("e0-ready");
      hold.holding = false;
      const { vectors, query } = e0("e0-ready");
      const text = "where is the widget count";
      const { index } = yield* built(ctx.base.tree);
      const target = index.chunks.find(
        (chunk) => chunk.path === "src/count.ts",
      )!;
      yield* vectors(index);
      yield* query(ctx, text, target.textSha256);
      const tool = L.semanticSearchTool(ctx, E0_RETRIEVER, {
        withVectors: index.chunks.length,
        chunks: index.chunks.length,
      });
      return {
        answer: yield* step("ready", tool.handle({ query: text, k: 3 })),
      };
    }),
  );
  // What `f110188f`, which got the index a second time to build E0's retriever, answered for this
  // call on this fixture.
  const before = {
    text: [
      '<data-3bed925473a14b6751d24e083d884a2b83f63b7dfad92f1b2ce5bd8d2ffd00cf kind="results">',
      "2 result(s) at base daf2b75fc549 from E0 over 2 chunks:",
      "1. hb5623b001 src/count.ts:1-3 @base · symbol widgetCount · undeclared · TypeScript, parsed by graph-symbols · via e0, score 1.00 · 20 tokens · returned for 1 query this run",
      "    identifiers (code-positions): widgetCount · callables: widgetCount",
      "    | export function widgetCount() {",
      "    |   return 1;",
      "    | }",
      "2. hfb4fa2e68 README.md:1-3 @base · section Widgets for e0-ready · undeclared · md, parsed by markdown-sections · via e0, score -0.01 · 17 tokens · returned for 1 query this run",
      "    identifiers (word-tokens): Nothing, Widgets, for, ready, yet",
      "    | # Widgets for e0-ready",
      "    | Nothing yet.",
      "</data-3bed925473a14b6751d24e083d884a2b83f63b7dfad92f1b2ce5bd8d2ffd00cf>",
    ].join("\n"),
    paged: false,
  };
  expect(result.answer).toEqual(before);
}, 90_000);
