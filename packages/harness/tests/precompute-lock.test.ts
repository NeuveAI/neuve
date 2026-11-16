import { createHash } from "node:crypto";
import { indexRecipe } from "../src/search-index.ts";
import {
  captureOutlineSource,
  type OutlineSource,
} from "../src/graph-outline.ts";
import { runLogTracer } from "../src/run-log.ts";
// Why: a review must finish even when another process owns preparation's index lease.
// Adapted from review 2's real-Git/SQLite lock probe. The oracles are events (the lease holder still
// alive, a logged yield), not wall-clock aborts, so a loaded machine cannot fail them.
import { afterAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Deferred, Effect, Exit, Fiber, Layer, Logger, Tracer } from "effect";
import {
  Blobs,
  Computations,
  Store,
  storeLocationIn,
} from "@neuve/records-core";
import {
  CodeWork,
  REVIEW_MARKER_MAX_MS,
  withCodeWork,
} from "../src/code-work.ts";
import { treeIndex } from "../src/search-index.ts";
const root = mkdtempSync(join(tmpdir(), "precompute-lock-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
// Model only the old lease's on-disk name; current producers must ignore it.
const legacyBuildDirectory = (
  directory: string,
  tree: string,
  recipe: ReturnType<typeof indexRecipe>,
) =>
  join(
    directory,
    "code-work",
    "indexes",
    "build",
    createHash("sha256")
      .update(JSON.stringify({ version: 1, tree, recipe }))
      .digest("hex"),
  );
const repo = join(root, "repo");
const git = (...args: string[]) => {
  const r = Bun.spawnSync([
    "git",
    "-c",
    "core.hooksPath=/dev/null",
    "-C",
    repo,
    ...args,
  ]);
  if (r.exitCode) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
};
Bun.spawnSync(["git", "init", "-q", repo]);
writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
git("add", ".");
git(
  "-c",
  "user.name=t",
  "-c",
  "user.email=t@example.test",
  "commit",
  "-qm",
  "fixture",
);
const tree = git("rev-parse", "HEAD^{tree}");

// These legacy-lock oracles measure blocking, not Graph startup: exercise the real unavailable-provider path.
const legacySource = {
  executable: join(root, "missing-legacy-engine"),
  key: { unavailable: join(root, "missing-legacy-engine") },
} satisfies OutlineSource;
// A legacy lease holder lives ten minutes and must still be alive when the index returns. A build that
// waits on the lease waits for the holder or for the lock's own 120-second deadline; the bound sits far
// under both and far over a loaded run (under 0.4 s at a load of 23 to 26 on 12 cores).
const LEGACY_HOLDER_SECONDS = 600;
const LEGACY_BOUND_MS = 20_000;
const legacyHolder = () => Bun.spawn(["sleep", String(LEGACY_HOLDER_SECONDS)]);
const withinLegacyBound = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.timeoutOrElse(effect, {
    duration: LEGACY_BOUND_MS,
    orElse: () =>
      Effect.die(
        new Error(
          `the index did not return within ${LEGACY_BOUND_MS} ms while a legacy lease was held: it waited on the lease`,
        ),
      ),
  });
// Code work that yields to a review logs this line first (`codeCheckpoint`).
const YIELDED = "yielding code work to review Precompute";
/** Records every yield and ends it at once by removing the store's review markers, so a regression
 * fails fast on its assertion instead of waiting out a marker. */
const yieldWatch = (directory: string) => {
  const yields: string[] = [];
  const reviews = join(directory, "code-work", "reviews");
  const layer = Logger.layer([
    Logger.make(({ message }) => {
      for (const item of [message].flat())
        if (typeof item === "string" && item.includes(YIELDED)) {
          yields.push(item);
          for (const entry of readdirSync(reviews))
            rmSync(join(reviews, entry), { force: true });
        }
    }),
  ]);
  return { yields, layer };
};

test("a foreground index ignores another tree's held legacy global lease", async () => {
  const location = storeLocationIn(join(root, "store"));
  const holder = legacyHolder();
  const folder = join(location.directory, "code-work", "indexes", "build");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "lock"), `${holder.pid} other-tree-build\n`);
  try {
    const exit = await Effect.runPromiseExit(
      Effect.andThen(
        Store.prepareForWrite,
        treeIndex(repo, tree, legacySource).pipe(
          Effect.provideService(CodeWork, {
            directory: location.directory,
            background: false,
          }),
        ),
      ).pipe(
        Effect.provide(
          Computations.layer.pipe(Layer.provideMerge(Blobs.layer(location))),
        ),
        Effect.provide(Store.layer(location, { create: true })),
        Effect.provide(BunFileSystem.layer),
        withinLegacyBound,
      ),
    );
    expect(holder.exitCode).toBeNull();
    expect(Exit.isSuccess(exit) ? "returned" : String(exit.cause)).toBe(
      "returned",
    );
    if (Exit.isSuccess(exit))
      expect(exit.value.index.chunks.map((c) => c.path)).toEqual(["a.ts"]);
  } finally {
    holder.kill();
    await holder.exited;
  }
});

const nextTree = (n: number) => {
  writeFileSync(join(repo, "a.ts"), `export const a = ${n};\n`);
  git("add", ".");
  git(
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.test",
    "commit",
    "-qm",
    `fixture ${n}`,
  );
  return git("rev-parse", "HEAD^{tree}");
};
const inStore = <A, E, R>(
  name: string,
  effect: (
    location: ReturnType<typeof storeLocationIn>,
  ) => Effect.Effect<A, E, R>,
) => {
  const location = storeLocationIn(join(root, name));
  return Effect.andThen(Store.prepareForWrite, effect(location)).pipe(
    Effect.provide(
      Computations.layer.pipe(Layer.provideMerge(Blobs.layer(location))),
    ),
    Effect.provide(Store.layer(location, { create: true })),
    Effect.provide(BunFileSystem.layer),
  );
};
test("a foreground index ignores its exact legacy lease", async () => {
  const tree = nextTree(2);
  const result = await Effect.runPromise(
    inStore("fallback", (location) =>
      Effect.gen(function* () {
        const holder = legacyHolder();
        const folder = legacyBuildDirectory(
          location.directory,
          tree,
          indexRecipe(legacySource),
        );
        mkdirSync(folder, { recursive: true });
        writeFileSync(join(folder, "lock"), `${holder.pid} held\n`);
        try {
          const index = yield* treeIndex(repo, tree, legacySource).pipe(
            Effect.provideService(CodeWork, {
              directory: location.directory,
              background: false,
            }),
            withinLegacyBound,
          );
          expect(holder.exitCode).toBeNull();
          expect(existsSync(join(folder, "lock"))).toBe(true);
          return index.index.chunks.map((c) => c.path);
        } finally {
          holder.kill();
        }
      }),
    ),
  );
  expect(result).toEqual(["a.ts"]);
});
// A background build that yielded to this review would wait behind the review that waits on it.
test("a review subscribes to the claimed background index without waiting behind itself", async () => {
  const tree = nextTree(3);
  const watch = yieldWatch(storeLocationIn(join(root, "preempt")).directory);
  const result = await Effect.runPromise(
    inStore("preempt", (location) =>
      Effect.gen(function* () {
        const store = yield* Computations.ComputationStore;
        const started = yield* Deferred.make<void>(),
          resume = yield* Deferred.make<void>();
        const paused: Computations.ComputationStore["Service"] = {
          ...store,
          run: (spec, compute) =>
            store.run(
              spec,
              spec.op === "harness.blob-chunks"
                ? Effect.andThen(
                    Deferred.succeed(started, undefined),
                    Effect.andThen(Deferred.await(resume), compute),
                  )
                : compute,
            ),
        };
        return yield* withCodeWork(
          location,
          true,
          Effect.gen(function* () {
            const background = yield* Effect.forkChild(
              treeIndex(repo, tree, captureOutlineSource()).pipe(
                Effect.provideService(Computations.ComputationStore, paused),
              ),
            );
            yield* Deferred.await(started);
            const lock = join(
              legacyBuildDirectory(
                location.directory,
                tree,
                indexRecipe(captureOutlineSource()),
              ),
              "lock",
            );
            expect(existsSync(lock)).toBe(false);
            yield* withCodeWork(
              location,
              false,
              Effect.gen(function* () {
                yield* Deferred.succeed(resume, undefined);
                const foreground = yield* treeIndex(
                  repo,
                  tree,
                  captureOutlineSource(),
                );
                const completed = yield* Fiber.join(background);
                expect(foreground.index).toBe(completed.index);
                expect(existsSync(lock)).toBe(false);
              }),
            );
            return (yield* Fiber.join(background)).index.chunks.map(
              (c) => c.path,
            );
          }),
        );
      }),
    ).pipe(Effect.provide(watch.layer)),
  );
  expect(watch.yields).toEqual([]);
  expect(result).toEqual(["a.ts"]);
});

// A review arriving exactly after the build must reuse the finished snapshot. The review's marker lives
// as long as the marker schema allows, so a yield after the build would wait for it; the yield watch
// records any such yield and ends it, and the assertion names it.
test("a completed background index publishes before yielding to a new review", async () => {
  const tree = nextTree(4);
  const watch = yieldWatch(storeLocationIn(join(root, "completed")).directory);
  await Effect.runPromise(
    inStore("completed", (location) =>
      withCodeWork(
        location,
        true,
        Effect.gen(function* () {
          let reviewStarted = false;
          const observe = (record: {
            readonly type: string;
            readonly [key: string]: unknown;
          }) => {
            if (
              record.type !== "span" ||
              record["name"] !== "harness.index.tree"
            )
              return;
            reviewStarted = true;
            const now = Date.now();
            writeFileSync(
              join(location.directory, "code-work", "reviews", "arrived"),
              JSON.stringify({
                pid: process.pid,
                start: null,
                createdAt: now,
                expiresAt: now + REVIEW_MARKER_MAX_MS,
              }),
            );
          };
          const result = yield* treeIndex(
            repo,
            tree,
            captureOutlineSource(),
          ).pipe(
            Effect.provideService(
              Tracer.Tracer,
              runLogTracer({
                path: "",
                write: observe,
                enqueue: observe,
                read: () => [],
              }),
            ),
          );
          expect(reviewStarted).toBe(true);
          expect(watch.yields).toEqual([]);
          expect(result.index.tree).toBe(tree);
          expect(
            readdirSync(
              join(location.directory, "code-work", "indexes"),
            ).filter((name) => name.endsWith(".index")),
          ).toHaveLength(1);
        }),
      ),
    ).pipe(Effect.provide(watch.layer)),
  );
});

// Cache replacement and eviction must preserve newer formats, including temporaries of live writers.
test("tree-index writes and eviction keep newer snapshots and unknown or live temporary files", async () => {
  const { createHash, randomUUID } = await import("node:crypto");
  const { readFileSync, utimesSync } = await import("node:fs");
  const { serialize } = await import("node:v8");
  const { indexRecipe } = await import("../src/search-index.ts");
  const firstTree = nextTree(91);
  const secondTree = nextTree(92);
  await Effect.runPromise(
    inStore("newer-snapshots", (location) =>
      withCodeWork(
        location,
        true,
        Effect.gen(function* () {
          const folder = join(location.directory, "code-work/indexes");
          mkdirSync(folder, { recursive: true });
          const key = (tree: string) =>
            createHash("sha256")
              .update(
                JSON.stringify({
                  version: 1,
                  tree,
                  recipe: indexRecipe(captureOutlineSource()),
                }),
              )
              .digest("hex");
          const incompatible = join(folder, `${key(firstTree)}.index`);
          writeFileSync(incompatible, "newer format");
          const first = yield* treeIndex(
            repo,
            firstTree,
            captureOutlineSource(),
          );
          expect(first.index.tree).toBe(firstTree);
          expect(readFileSync(incompatible, "utf8")).toBe("newer format");
          const compatible = join(folder, "newer.index");
          writeFileSync(
            compatible,
            serialize({ ...first.index, future: { derived: true } }),
          );
          utimesSync(compatible, 1, 1);
          const unknownTmp = join(folder, "newer.tmp");
          const liveTmp = join(
            folder,
            `${"a".repeat(64)}.${process.pid}.${randomUUID()}.tmp`,
          );
          writeFileSync(unknownTmp, "unknown");
          writeFileSync(liveTmp, "live");
          yield* treeIndex(repo, secondTree, captureOutlineSource());
          expect(existsSync(compatible)).toBe(true);
          expect(readFileSync(unknownTmp, "utf8")).toBe("unknown");
          expect(readFileSync(liveTmp, "utf8")).toBe("live");
          rmSync(liveTmp);
        }),
      ),
    ),
  );
});
