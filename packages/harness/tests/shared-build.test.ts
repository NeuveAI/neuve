import { captureOutlineSource } from "../src/graph-outline.ts";
import { References } from "effect";
import { expect, test } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  statSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import {
  Blobs,
  Computations,
  Store,
  Worker,
  storeLocationIn,
} from "@neuve/records-core";
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Logger } from "effect";
import { sharedTreeIndex } from "../src/lookups.ts";
import { treeVectors } from "../src/e0.ts";
import { indexOf } from "../src/retrievers.ts";

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), "shared-tree-"));
  const repository = join(root, "repo");
  const location = storeLocationIn(join(root, "store"));
  const git = (...args: string[]) => {
    const child = Bun.spawnSync([
      "git",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ]);
    if (child.exitCode) throw new Error(child.stderr.toString());
    return child.stdout.toString().trim();
  };
  git("init", "-q", repository);
  writeFileSync(join(repository, "readme.md"), `# Shared tree\n\n${root}\n`);
  git("-C", repository, "add", ".");
  const tree = git("-C", repository, "write-tree");
  const run = <A, E>(
    program: Effect.Effect<
      A,
      E,
      Computations.ComputationStore | Blobs.BlobStore
    >,
  ) =>
    Effect.runPromise(
      Effect.andThen(Store.prepareForWrite, program).pipe(
        Effect.scoped,
        Effect.provide(Computations.layer),
        Effect.provide(
          Blobs.layer(location).pipe(
            Layer.provideMerge(Store.layer(location, { create: true })),
            Layer.provideMerge(BunFileSystem.layer),
          ),
        ),
      ),
    );
  return {
    root,
    repository,
    tree,
    git,
    run,
    location,
    close: () => rmSync(root, { recursive: true, force: true }),
  };
};

// Why: structural lookups and retrieval must enter the same operation, not two private maps.
test("lookups and retrievers share one tree-index entry point and result", async () => {
  const s = setup();
  try {
    expect(sharedTreeIndex).toBe(indexOf);
    const results = await s.run(
      Effect.all(
        [
          indexOf(s.repository, s.tree, captureOutlineSource()),
          sharedTreeIndex(s.repository, s.tree, captureOutlineSource()),
        ],
        { concurrency: "unbounded" },
      ),
    );
    expect(results[0].index).toBe(results[1].index);
    expect(results[0].index.chunks.map((chunk) => chunk.path)).toEqual([
      "readme.md",
    ]);
  } finally {
    s.close();
  }
}, 60_000);

// Why: a recorded failure must reach every subscriber once, leaving retry to its caller.
test("tree-index subscribers receive the same failure without retrying", async () => {
  const s = setup();
  try {
    await s.run(
      Effect.gen(function* () {
        const store = yield* Computations.ComputationStore;
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let reads = 0;
        const call = () =>
          indexOf(s.repository, s.tree, captureOutlineSource()).pipe(
            Effect.provideService(Computations.ComputationStore, {
              ...store,
              lookupMany: () =>
                Effect.gen(function* () {
                  reads++;
                  yield* Deferred.succeed(entered, undefined);
                  yield* Deferred.await(release);
                  return yield* Effect.die("tree read failed");
                }),
            }),
          );
        const first = yield* Effect.forkChild(call(), {
          startImmediately: true,
        });
        yield* Deferred.await(entered);
        const joined = yield* Deferred.make<void>();
        const second = yield* Effect.forkChild(
          call().pipe(
            Effect.provideService(References.MinimumLogLevel, "Debug"),
            Effect.provide(
              Logger.layer([
                Logger.make(({ message }) => {
                  if (
                    [message]
                      .flat()
                      .some(
                        (item) =>
                          typeof item === "object" &&
                          item !== null &&
                          "role" in item &&
                          (item.role === "waiter" || item.role === "floor"),
                      )
                  )
                    Deferred.doneUnsafe(joined, Effect.void);
                }),
              ]),
            ),
          ),
          { startImmediately: true },
        );
        yield* Deferred.await(joined);
        yield* Deferred.succeed(release, undefined);
        const exits = yield* Effect.all([
          Fiber.await(first),
          Fiber.await(second),
        ]);
        expect(reads).toBe(1);
        for (const exit of exits) {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit))
            expect(Cause.squash(exit.cause)).toBe("tree read failed");
        }
        expect(
          (yield* indexOf(s.repository, s.tree, captureOutlineSource())).index
            .tree,
        ).toBe(s.tree);
      }),
    );
  } finally {
    s.close();
  }
}, 60_000);

// Why: admission must happen before ownership, and different immutable trees must stay separate.
test("tree builds preserve HeavyWork admission and isolate trees", async () => {
  const s = setup();
  try {
    writeFileSync(join(s.repository, "other.md"), "# Other\n");
    s.git("-C", s.repository, "add", ".");
    const other = s.git("-C", s.repository, "write-tree");
    await s.run(
      Effect.gen(function* () {
        const admit = yield* Deferred.make<void>();
        const gate = Worker.HeavyWork.defaultValue();
        const background = yield* Effect.forkChild(
          indexOf(s.repository, s.tree, captureOutlineSource()).pipe(
            Effect.provideService(Worker.HeavyWork, {
              ...gate,
              start: (work) => Effect.andThen(Deferred.await(admit), work),
            }),
          ),
          { startImmediately: true },
        );
        const results = yield* Effect.all(
          [
            indexOf(s.repository, s.tree, captureOutlineSource()),
            indexOf(s.repository, other, captureOutlineSource()),
          ],
          { concurrency: "unbounded" },
        );
        expect(results.map((r) => r.index.tree)).toEqual([s.tree, other]);
        yield* Deferred.succeed(admit, undefined);
        expect((yield* Fiber.join(background)).index.tree).toBe(s.tree);
      }),
    );
  } finally {
    s.close();
  }
}, 60_000);

// Why: a store generation change must not join a matrix still loading the previous generation.
test("E0 matrices share one generation and separate a changed store stamp", async () => {
  const s = setup();
  try {
    await s.run(
      Effect.gen(function* () {
        const built = yield* indexOf(
          s.repository,
          s.tree,
          captureOutlineSource(),
        );
        const chunk = built.index.chunks[0];
        if (!chunk) return yield* Effect.die("fixture chunk missing");
        const index = {
          ...built.index,
          chunks: Array.from({ length: 1536 }, () => chunk),
        };
        const runtime = {
          python: "unused",
          snapshot: "unused",
          worker: "unused",
          vectorStore: join(s.root, "store"),
        };
        const entered = yield* Deferred.make<void>();
        const original = statSync(s.location.database);
        const first = yield* Effect.forkChild(
          treeVectors(index, runtime).pipe(
            Effect.provideService(References.MinimumLogLevel, "Debug"),
            Effect.provide(
              Logger.layer([
                Logger.make(({ message }) => {
                  if (
                    [message]
                      .flat()
                      .some(
                        (item) =>
                          typeof item === "object" &&
                          item !== null &&
                          "role" in item &&
                          item.role === "holder",
                      )
                  ) {
                    utimesSync(
                      s.location.database,
                      original.atime,
                      new Date(original.mtimeMs + 10000),
                    );
                    Deferred.doneUnsafe(entered, Effect.void);
                  }
                }),
              ]),
            ),
          ),
          { startImmediately: true },
        );
        yield* Deferred.await(entered);
        const second = yield* treeVectors(index, runtime);
        const old = yield* Fiber.join(first);
        expect(second).not.toBe(old);
        expect(second.missing).toBe(1536);
        expect(yield* treeVectors(index, runtime)).toBe(second);
      }),
    );
  } finally {
    s.close();
  }
}, 60_000);
