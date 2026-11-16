import { captureOutlineSource } from "../src/graph-outline.ts";
import { hostBudget, closeWorkerBudget } from "../src/budget/local.ts";
import { INDEX_BOUNDS, type TreeIndex } from "../src/search-index.ts";
import { withGitReadSnapshot } from "../src/git-read-snapshot.ts";
// Why: a shared background build must deliver the index to the review's first attempt.
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect, Deferred, Tracer } from "effect";
import {
  JobQueue,
  Computations,
  Worker,
  storeLocationIn,
} from "@neuve/records-core";
import { indexOf } from "../src/retrievers.ts";
import { runIn, value } from "./pi/capture/fixture.ts";
import { slotsForTests } from "../src/graph-search.ts";
import { GitFailed } from "../src/git.ts";

test("review and background share a tree-index build", async () => {
  const root = mkdtempSync(join(tmpdir(), "gc-shared-"));
  const location = storeLocationIn(join(root, "store"));
  const previousBudget = process.env.NEUVE_BUDGET_DIRECTORY;
  const budgetDirectory = join(root, "budget");
  process.env.NEUVE_BUDGET_DIRECTORY = budgetDirectory;
  const host = await hostBudget({
    directory: budgetDirectory,
    threads: 2,
    fixed: 4,
  });
  if (!host) throw new Error("budget host missing");
  await host.claims.ready;
  const repo = join(root, "repo");
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const git = (...a: string[]) => {
    const r = Bun.spawnSync(["git", ...a], { env });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    return r.stdout.toString().trim();
  };
  git("init", "-q", repo);
  for (let d = 0; d < 6; d++) {
    mkdirSync(join(repo, `d${d}`));
    for (let f = 0; f < 100; f++)
      writeFileSync(
        join(repo, `d${d}`, `f${f}.md`),
        `# file ${d} ${f}\n\nsome words here ${d * 1000 + f}\n`,
      );
  }
  git("-C", repo, "add", "-A");
  git(
    "-C",
    repo,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.test",
    "commit",
    "-qm",
    "first",
  );
  const tree = git("-C", repo, "rev-parse", "HEAD^{tree}");
  const t0 = performance.now();
  const at = () => Math.round(performance.now() - t0);
  const events: string[] = [];
  const attempts: number[] = [];
  const failures: string[] = [];
  const reviewWaits: number[] = [];
  const indexes: Array<{ index: TreeIndex; cached: boolean }> = [];
  const buildOwners: string[] = [];
  const tracer = Tracer.make({
    span(options) {
      const span = Tracer.nativeTracer.span(options);
      if (span.name === "harness.index.tree") {
        let parent = span.parent;
        const ancestors: string[] = [];
        while (parent._tag === "Some" && parent.value._tag === "Span") {
          ancestors.push(parent.value.name);
          parent = parent.value.parent;
        }
        buildOwners.push(
          ancestors.find(
            (name) => name === "background.index" || name === "review.index",
          ) ?? "no owner",
        );
      }
      return span;
    },
  });
  let backgroundSucceeded = false;
  const recordFailure = (error: unknown) =>
    Effect.sync(() =>
      failures.push(error instanceof GitFailed ? "GitFailed" : "other"),
    );
  try {
    value(
      await runIn(location)(
        Effect.gen(function* () {
          const queue = yield* JobQueue.JobQueue;
          const started = yield* Deferred.make<void>();
          yield* queue.enqueue({
            kind: "commit.hybrid",
            dedupeKey: "h",
            payload: { oid: "a".repeat(40), tree, parents: [] },
          });
          yield* Effect.forkChild(
            Effect.gen(function* () {
              yield* Deferred.await(started);
              yield* queue.enqueue({ kind: "review.run", dedupeKey: "r" });
              events.push(`${at()} review enqueued`);
            }),
          );
          return yield* Worker.run({
            location,
            idleTimeout: "100 millis",
            pollInterval: "10 millis",
            handlers: {
              "review.run": (job) =>
                Effect.gen(function* () {
                  attempts.push(job.attempts);
                  const startedAt = at();
                  events.push(
                    `${at()} review started; asks for the same tree index`,
                  );
                  const r = yield* indexOf(
                    repo,
                    tree,
                    captureOutlineSource(),
                  ).pipe(
                    Effect.withSpan("review.index"),
                    Effect.tapError(recordFailure),
                    // Ends a deadlock only: a slow build under load is not one.
                    Effect.timeoutOption("30 seconds"),
                  );
                  if (r._tag === "Some") {
                    reviewWaits.push(at() - startedAt);
                    indexes.push(r.value);
                  }
                  events.push(
                    `${at()} review index: ${r._tag === "None" ? "TIMED OUT" : "got it"}`,
                  );
                }).pipe(withGitReadSnapshot(repo, INDEX_BOUNDS.maxFileBytes)),
              "commit.hybrid": () =>
                Effect.gen(function* () {
                  events.push(
                    `${at()} background starts building the tree index`,
                  );
                  yield* Deferred.succeed(started, undefined);
                  const r = yield* Effect.result(
                    indexOf(repo, tree, captureOutlineSource()).pipe(
                      Effect.withSpan("background.index"),
                      Effect.tapError(recordFailure),
                    ),
                  );
                  backgroundSucceeded = r._tag === "Success";
                  if (r._tag === "Success") indexes.push(r.success);
                  events.push(`${at()} background index done: ${r._tag}`);
                }),
            },
          });
        }).pipe(
          Effect.provide(JobQueue.layer),
          Effect.provide(Computations.layer),
          Effect.provideService(Tracer.Tracer, tracer),
        ),
      ),
    );

    expect(failures).toEqual([]);
    expect(attempts).toEqual([1]);
    expect(backgroundSucceeded).toBe(true);
    expect(reviewWaits).toHaveLength(1);
    // A separate call after completion returns a cached wrapper, not the owner's result.
    expect(indexes).toHaveLength(2);
    expect(indexes[0]?.cached).toBe(false);
    expect(indexes[0]).toBe(indexes[1]);
    expect(buildOwners).toEqual(["background.index"]);
    expect(events.some((e) => e.includes("TIMED OUT"))).toBe(false);
  } finally {
    await closeWorkerBudget(budgetDirectory);
    await host.close();
    if (previousBudget === undefined) delete process.env.NEUVE_BUDGET_DIRECTORY;
    else process.env.NEUVE_BUDGET_DIRECTORY = previousBudget;
    rmSync(root, { recursive: true, force: true });
  }
}, 60000);

test("Graph entry admission leaves the shared slot free for the running review", async () => {
  const root = mkdtempSync(join(tmpdir(), "graph-entry-gate-")),
    location = storeLocationIn(join(root, "store"));
  let reviewGotSlot = false,
    reviewing = false;
  const launches: boolean[] = [];
  try {
    value(
      await runIn(location)(
        Effect.gen(function* () {
          const queue = yield* JobQueue.JobQueue;
          yield* queue.enqueue({ kind: "review.run", dedupeKey: "r" });
          yield* queue.enqueue({
            kind: "commit.hybrid",
            dedupeKey: "h",
            payload: { oid: "a".repeat(40), tree: "b".repeat(40), parents: [] },
          });
          yield* Worker.run({
            location,
            idleTimeout: "100 millis",
            pollInterval: "10 millis",
            handlers: {
              "commit.hybrid": () =>
                slotsForTests.withSlot(() => false)(
                  Effect.gen(function* () {
                    const gate = yield* Worker.HeavyWork;
                    const child = yield* gate.spawn(Effect.void, () => {
                      launches.push(reviewing);
                      return Bun.spawn(["true"], {
                        stdout: "ignore",
                        stderr: "ignore",
                      });
                    });
                    yield* Effect.promise(() => child.exited);
                  }),
                ),
              "review.run": () =>
                Effect.gen(function* () {
                  reviewing = true;
                  yield* Effect.sleep("100 millis");
                  expect(launches).toEqual([]);
                  yield* slotsForTests
                    .withSlot(() => true)(
                      Effect.sync(() => {
                        reviewGotSlot = true;
                      }),
                    )
                    .pipe(Effect.timeout("500 millis"));
                  reviewing = false;
                }),
            },
          });
        }).pipe(
          Effect.provide(JobQueue.layer),
          Effect.provide(Computations.layer),
        ),
      ),
    );
    expect(reviewGotSlot).toBe(true);
    expect(launches).toEqual([false]);
    expect(slotsForTests.state().inUse).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);

test.todo(
  "Graph per-launch admission follow-up: defer a launch when a review starts after shared Graph entry admission",
  () => {},
);
