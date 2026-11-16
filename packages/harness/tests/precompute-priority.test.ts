import { hostBudget } from "../src/budget/local.ts";
// Preparation starts at nice 19 and enforces its own nice floor before CPU work.
import { afterAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Fiber, Layer } from "effect";
import {
  Blobs,
  Computations,
  JobQueue,
  Store,
  storeLocationIn,
} from "@neuve/records-core";
import { withCodeWork } from "../src/code-work.ts";
import { commitPrepareHandler } from "../src/commit-prepare.ts";
const root = mkdtempSync(join(tmpdir(), "preparation-priority-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const repository = join(root, "repo");
Bun.spawnSync(["git", "init", "-q", repository]);
const git = (...args: string[]) => {
  const child = Bun.spawnSync([
    "git",
    "-c",
    "core.hooksPath=/dev/null",
    "-C",
    repository,
    ...args,
  ]);
  if (child.exitCode) throw new Error(child.stderr.toString());
  return child.stdout.toString().trim();
};
const commit = () => {
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
  return git("rev-parse", "HEAD");
};
writeFileSync(join(repository, "file.ts"), "export const n = 1;\n");
const baseOid = commit();
writeFileSync(join(repository, "file.ts"), "export const n = 2;\n");
const headOid = commit();

const priorityProbe = Bun.spawnSync([
  "/usr/bin/nice",
  "-n",
  "10",
  process.execPath,
  "-e",
  'import {getPriority} from "node:os"; process.stdout.write(String(getPriority()));',
]);
const canLowerPriority =
  priorityProbe.exitCode === 0 && Number(priorityProbe.stdout.toString()) >= 10;

test.skipIf(!canLowerPriority)(
  "hookless range preparation runs in its lowered-priority child",
  async () => {
    const location = storeLocationIn(join(root, "child-store"));
    const marker = join(root, "child.json");
    const script = join(root, "child.ts");
    const preparation = join(import.meta.dir, "../src/commit-prepare.ts");
    writeFileSync(
      script,
      `import { getPriority } from "node:os";
       import { requirePreparationPriority } from ${JSON.stringify(preparation)};
       requirePreparationPriority();
       await Bun.write(${JSON.stringify(marker)}, JSON.stringify({pid:process.pid,nice:getPriority()}));`,
    );
    await Effect.runPromise(
      Effect.andThen(
        Store.prepareForWrite,
        Effect.gen(function* () {
          const queue = yield* JobQueue.JobQueue;
          const queued = yield* queue.enqueue({
            kind: "commit.prepare@2",
            dedupeKey: "range",
            payload: { kind: "range", range: { baseOid, headOid } },
          });
          yield* commitPrepareHandler({
            repository,
            location,
            command: [process.execPath, script],
          })(queued.job);
        }),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            JobQueue.layer,
            Computations.layer.pipe(Layer.provideMerge(Blobs.layer(location))),
          ),
        ),
        Effect.provide(Store.layer(location, { create: true })),
        Effect.provide(BunFileSystem.layer),
      ),
    );
    expect(existsSync(marker)).toBe(true);
    const value = JSON.parse(readFileSync(marker, "utf8"));
    expect(value.pid).not.toBe(process.pid);
    expect(value.nice).toBeGreaterThanOrEqual(19);
  },
  // A nice-10 child can wait under machine load; this asserts priority and process, not speed.
  30_000,
);

// Why: a live review must be able to take CPU precedence without killing preparation.
test.skipIf(!canLowerPriority)(
  "a preparation child yields to review Precompute and resumes after it",
  async () => {
    const location = storeLocationIn(join(root, "paused-store"));
    const marker = join(root, "paused-child.json");
    const queued = { kind: "range", range: { baseOid, headOid } };
    const fixture = join(import.meta.dir, "fixtures/precompute-code.ts");
    await Effect.runPromise(
      Effect.andThen(
        Store.prepareForWrite,
        Effect.gen(function* () {
          const queue = yield* JobQueue.JobQueue;
          const job = yield* queue.enqueue({
            kind: "commit.prepare@2",
            dedupeKey: "paused",
            payload: queued,
          });
          let fiber: Fiber.Fiber<unknown, unknown> | undefined;
          yield* withCodeWork(
            location,
            false,
            Effect.gen(function* () {
              fiber = yield* Effect.forkDetach(
                commitPrepareHandler({
                  repository,
                  location,
                  command: [
                    process.execPath,
                    fixture,
                    "prepare",
                    repository,
                    join(root, "paused-store"),
                    marker,
                    JSON.stringify(queued),
                  ],
                })(job.job),
              );
              yield* Effect.sleep(100);
              expect(existsSync(marker)).toBe(false);
              expect(fiber.pollUnsafe()).toBeUndefined();
            }),
          );
          if (!fiber) throw new Error("Child not started");
          yield* Fiber.join(fiber);
          expect(existsSync(marker)).toBe(true);
        }),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            JobQueue.layer,
            Computations.layer.pipe(Layer.provideMerge(Blobs.layer(location))),
          ),
        ),
        Effect.provide(Store.layer(location, { create: true })),
        Effect.provide(BunFileSystem.layer),
      ),
    );
  },
  // This integration case starts a child and real Graph commands after the review releases CPU.
  30_000,
);

// A reachable authority must push one real build to both processes, even for a retryable index.
test("two processes reuse one index build through the bounded temporary cache", async () => {
  const directory = join(root, "shared-host");
  const host = await hostBudget({ directory, threads: 2, fixed: 4 });
  if (!host) throw new Error("Fixture shared-work host did not start");
  await host.claims.ready;
  const fixture = join(import.meta.dir, "fixtures/precompute-code.ts");
  const tree = git("rev-parse", `${baseOid}^{tree}`);
  const children: ReturnType<typeof Bun.spawn>[] = [];
  try {
    for (const retryable of [false, true]) {
      const storeRoot = join(
        root,
        retryable ? "retryable-index-store" : "shared-index-store",
      );
      const location = storeLocationIn(storeRoot);
      await Effect.runPromise(
        Store.prepareForWrite.pipe(
          Effect.provide(Store.layer(location, { create: true })),
          Effect.provide(BunFileSystem.layer),
        ),
      );
      const marker = (number: number) =>
        join(root, `${retryable ? "retryable" : "stable"}-${number}`);
      const start = (number: number, gated: boolean) => {
        const child = Bun.spawn(
          [
            process.execPath,
            fixture,
            "index",
            repository,
            storeRoot,
            marker(number),
            tree,
          ],
          {
            env: {
              ...process.env,
              NEUVE_BUDGET_DIRECTORY: directory,
              NEUVE_TEST_INDEX_GATE: gated ? "1" : "0",
              ...(retryable
                ? {
                    NEUVE_GRAPH_OUTLINE_EXECUTABLE: join(
                      root,
                      "missing-engine",
                    ),
                  }
                : {}),
            },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        children.push(child);
        const finished = Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]).then(([stdout, stderr, exit]) => {
          expect(exit, stderr).toBe(0);
          expect(stderr).not.toContain('"type":"shared-work.floor"');
          return JSON.parse(stdout.trim());
        });
        void finished.catch(() => {});
        return { child, finished };
      };
      const first = start(0, true),
        second = start(1, true);
      try {
        for (
          let i = 0;
          [0, 1].some((n) => !existsSync(marker(n))) && i < 1000;
          i++
        )
          await Bun.sleep(10);
        for (const n of [0, 1]) {
          expect(existsSync(marker(n))).toBe(true);
          writeFileSync(`${marker(n)}.go`, "go");
        }
        for (
          let i = 0;
          (![0, 1].some((n) => existsSync(`${marker(n)}.waiter`)) ||
            ![0, 1].some((n) => existsSync(`${marker(n)}.building`))) &&
          i < 1000;
          i++
        )
          await Bun.sleep(10);
        expect(
          [0, 1].filter((n) => existsSync(`${marker(n)}.waiter`)),
        ).toHaveLength(1);
        expect(
          [0, 1].filter((n) => existsSync(`${marker(n)}.building`)),
        ).toHaveLength(1);
      } finally {
        for (const n of [0, 1]) writeFileSync(`${marker(n)}.continue`, "go");
      }
      const results = await Promise.all([first.finished, second.finished]);
      expect(results.map((result) => result.cached).sort()).toEqual([
        false,
        true,
      ]);
      expect(results.map((result) => result.tree)).toEqual([tree, tree]);
      expect(results.reduce((sum, result) => sum + result.builds, 0)).toBe(1);
      expect(
        readdirSync(join(location.directory, "code-work", "indexes")).filter(
          (name) => name.endsWith(".index"),
        ),
      ).toEqual([]);
      if (!retryable)
        for (const result of results)
          expect(result.fallback ?? null).toBe(null);
      if (retryable) {
        expect(results.map((result) => result.fallback)).toEqual([
          "capability-unavailable",
          "capability-unavailable",
        ]);
        const next = start(2, false);
        for (let i = 0; !existsSync(marker(2)) && i < 1000; i++)
          await Bun.sleep(10);
        writeFileSync(`${marker(2)}.go`, "go");
        const rebuilt = await next.finished;
        expect(rebuilt.cached).toBe(false);
        expect(rebuilt.builds).toBe(1);
      }
    }
  } finally {
    for (const child of children) child.kill();
    await Promise.all(children.map((child) => child.exited));
    await host.close();
  }
  // Includes real Graph's cold build plus process startup and subscription; no assertion is relaxed.
}, 30_000);
