import { captureOutlineSource } from "../src/graph-outline.ts";
import { References } from "effect";
// Why: the queue must discover work without hooks, and immutable file facts must survive
// cycles, changed heads and older stores. Real Git and SQLite expose missed reuse and key drift.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Deferred, Effect, Exit, Fiber, Layer, Option, Logger } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import {
  Blobs,
  Computations,
  JobQueue,
  Log,
  Store,
  jobsFor,
  mintUlid,
  readData,
  storeLocationIn,
} from "@neuve/records-core";
import { PreparationPayload, RecordEvent } from "@neuve/records-schema";
import {
  commitPrepareHandler,
  enqueueRangePreparation,
} from "../src/commit-prepare.ts";
import {
  graphLeadsRound,
  defaultManifestSettings,
  fileHunks,
  leadsByHunk,
  rangeManifest,
} from "../src/manifest.ts";
import { diffTrees } from "../src/git-objects.ts";
import {
  cachedLeads,
  hunkLeads,
  HunkLeads,
  LEAD_CONCURRENCY,
  legacyLeadsSpec,
} from "../src/leads.ts";
import { DEFAULT_RETRIEVER, type Retriever } from "../src/retriever.ts";
import { indexRecipe, jsonComputation } from "../src/search-index.ts";

const directory = mkdtempSync(join(tmpdir(), "precompute-ahead-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const repository = join(directory, "repo");
const git = (...args: string[]) => {
  const result = Bun.spawnSync([
    "git",
    "-c",
    "core.hooksPath=/dev/null",
    "-C",
    repository,
    ...args,
  ]);
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
};
Bun.spawnSync(["git", "init", "-q", repository]);
const commit = (name: string) => {
  git("add", ".");
  git(
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.test",
    "commit",
    "-qm",
    name,
  );
  return git("rev-parse", "HEAD");
};
for (const name of ["one", "two"])
  writeFileSync(join(repository, `${name}.ts`), `export const ${name} = 1;\n`);
const base = commit("base");
for (const name of ["one", "two"])
  writeFileSync(join(repository, `${name}.ts`), `export const ${name} = 2;\n`);
const head = commit("both files");
writeFileSync(join(repository, "one.ts"), "export const one = 3;\n");
const next = commit("one file");

const inStore = <A, E, R>(name: string, effect: Effect.Effect<A, E, R>) => {
  const location = storeLocationIn(join(directory, name));
  return Effect.andThen(Store.prepareForWrite, effect).pipe(
    Effect.provide(
      Layer.mergeAll(
        JobQueue.layer,
        Computations.layer.pipe(Layer.provideMerge(Blobs.layer(location))),
      ),
    ),
    Effect.provide(Store.layer(location, { create: true })),
    Effect.provide(BunFileSystem.layer),
  );
};
const fileAttempts = Effect.gen(function* () {
  const sql = yield* SqlClient;
  return yield* sql<{
    n: number;
  }>`SELECT count(*) AS n FROM computations WHERE op = 'harness.file-hunks'`;
});

test("a second cycle reuses all file facts and a new head computes only the changed file", async () => {
  const result = await Effect.runPromise(
    inStore(
      "reuse",
      Effect.gen(function* () {
        const settings = defaultManifestSettings(1_000_000);
        const first = yield* rangeManifest(
          repository,
          { baseOid: base, headOid: head },
          settings,
          captureOutlineSource(),
        );
        const counts1 = yield* fileAttempts;
        // The stage wrapper fetches scope per cycle; the code manifest has no cycle identity.
        const cycle2 = yield* rangeManifest(
          repository,
          { baseOid: base, headOid: head },
          settings,
          captureOutlineSource(),
        );
        const counts2 = yield* fileAttempts;
        const changed = yield* rangeManifest(
          repository,
          { baseOid: base, headOid: next },
          settings,
          captureOutlineSource(),
        );
        const counts3 = yield* fileAttempts;
        return { first, cycle2, changed, counts1, counts2, counts3 };
      }),
    ),
  );
  expect(result.first.value.hunks.map((h) => [h.path, h.added])).toEqual([
    ["one.ts", 1],
    ["two.ts", 1],
  ]);
  expect(result.cycle2.status).toBe("reused");
  expect(result.cycle2.value).toEqual(result.first.value);
  expect(result.counts1).toEqual([{ n: 2 }]);
  expect(result.counts2).toEqual([{ n: 2 }]);
  expect(result.counts3).toEqual([{ n: 3 }]);
  expect(
    result.changed.value.hunks.find((h) => h.path === "one.ts")?.text,
  ).toContain("+export const one = 3;");
  const two = result.changed.value.hunks.find((h) => h.path === "two.ts");
  expect(
    two === undefined
      ? undefined
      : leadsByHunk(result.changed.leads.value).get(two.hunkId)?.source,
  ).toBe("cached");
  // Measured 2.876-5.243 s at load 7.93-17.90; 10x slowest, at least 30 s, rounded up to 5 s.
}, 55_000);

test("legacy lead keys remain readable without changing the old computation", async () => {
  const result = await Effect.runPromise(
    inStore(
      "legacy",
      Effect.gen(function* () {
        const hunks = yield* fileHunks(
          repository,
          yield* diffTrees(repository, base, head),
          captureOutlineSource(),
        );
        const hunk = hunks[0]!;
        const value: HunkLeads = {
          tree: "old-tree",
          querySha256: hunk.query!.sha256,
          results: [],
          millis: 7,
        };
        const saved = yield* jsonComputation(
          legacyLeadsSpec(
            hunk,
            DEFAULT_RETRIEVER,
            indexRecipe(captureOutlineSource()),
          ),
          HunkLeads,
          Effect.succeed(value),
        );
        const read = yield* cachedLeads(
          hunk,
          DEFAULT_RETRIEVER,
          indexRecipe(captureOutlineSource()),
        );
        return { read, value, saved };
      }),
    ),
  );
  expect(Option.getOrUndefined(result.read)).toEqual(result.value);
  expect(result.saved.status).toBe("computed");
  // Measured 0.908-2.673 s at load 7.93-17.90; 10x slowest, at least 30 s, rounded up to 5 s.
}, 30_000);

test("review admission queues discovery, and repeated range discovery queues each commit once", async () => {
  const event = RecordEvent.parse({
    id: mintUlid(),
    kind: "review.requested@1",
    actor: "a".repeat(64),
    idempotencyKey: "test:request",
    occurredAt: new Date().toISOString(),
    attribution: {
      cycleId: mintUlid(),
      range: { baseRef: "main", baseOid: base, headOid: next },
    },
    payload: {
      runKey: "b".repeat(64),
      generation: 0,
      pipeline: { version: 1, config: {} },
    },
  });
  expect(jobsFor(event).map((job) => job.kind)).toContain("commit.prepare@2");
  const result = await Effect.runPromise(
    inStore(
      "queue",
      Effect.gen(function* () {
        const initial = yield* enqueueRangePreparation(repository, {
          baseOid: base,
          headOid: head,
        });
        const first = yield* enqueueRangePreparation(repository, {
          baseOid: base,
          headOid: next,
        });
        const second = yield* enqueueRangePreparation(repository, {
          baseOid: base,
          headOid: next,
        });
        const queue = yield* JobQueue.JobQueue;
        return {
          initial,
          first,
          second,
          jobs: yield* queue.list({ states: ["waiting"], limit: 100 }),
        };
      }),
    ),
  );
  expect(result.initial).toBe(1);
  expect(result.first).toBe(1);
  expect(result.second).toBe(0);
  expect(result.jobs.map((job) => job.dedupeKey).sort()).toEqual(
    [
      `commit.prepare@2:commit:${head}`,
      `commit.prepare@2:commit:${next}`,
      `commit.prepare@2:range:${base}:${head}`,
      `commit.prepare@2:range:${base}:${next}`,
    ].sort(),
  );
});

// The event range includes baseRef, which is not part of a preparation job's payload.
test("the worker discovers valid preparation jobs from a review range with baseRef", async () => {
  const location = storeLocationIn(join(directory, "review-discovery"));
  const event = RecordEvent.parse({
    id: mintUlid(),
    kind: "review.requested@1",
    actor: "a".repeat(64),
    idempotencyKey: "test:review-discovery",
    occurredAt: new Date().toISOString(),
    attribution: {
      cycleId: mintUlid(),
      range: { baseRef: "refs/heads/main", baseOid: base, headOid: next },
    },
    payload: {
      runKey: "b".repeat(64),
      generation: 0,
      pipeline: { version: 1, config: {} },
    },
  });
  const handler = commitPrepareHandler({
    repository,
    location,
    command: [
      process.execPath,
      "--no-env-file",
      join(import.meta.dir, "../../../apps/neuve-cli/src/cli.ts"),
    ],
  });
  await Effect.runPromise(
    inStore(
      "review-discovery",
      Effect.gen(function* () {
        yield* Log.append([event]);
        const queue = yield* JobQueue.JobQueue;
        const discover = Option.getOrThrow(
          yield* queue.take(["commit.prepare@2"]),
        );
        expect(discover.eventId).toBe(event.id);
        expect(discover.payload).toBeNull();
        yield* handler(discover);
        yield* queue.complete(discover.seq, discover.attempts);

        const jobs = (yield* queue.list({
          states: ["waiting"],
          limit: 100,
        })).filter((job) => job.kind === "commit.prepare@2");
        expect(jobs.map((job) => job.dedupeKey).sort()).toEqual(
          [
            `commit.prepare@2:commit:${head}`,
            `commit.prepare@2:commit:${next}`,
            `commit.prepare@2:range:${base}:${next}`,
          ].sort(),
        );
        const range = jobs.find((job) => job.dedupeKey.includes(":range:"));
        expect(readData(PreparationPayload, range?.payload)).toEqual({
          kind: "range",
          range: { baseOid: base, headOid: next },
        });
        for (const { oid, parent } of [
          { oid: head, parent: base },
          { oid: next, parent: head },
        ]) {
          const job = jobs.find(
            (job) => job.dedupeKey === `commit.prepare@2:commit:${oid}`,
          );
          expect(readData(PreparationPayload, job?.payload)).toEqual({
            kind: "commit",
            commit: {
              oid,
              tree: git("rev-parse", `${oid}^{tree}`),
              parents: [parent],
            },
          });
        }
      }),
    ),
  );
});

// Why: an abort must leave completed file and lead computations reusable, without
// binding a partial answer as the immutable full leads of the range.
test("an interrupted lead round retains completed facts without caching partial leads", async () => {
  const controller = new AbortController();
  const exit = await Effect.runPromiseExit(
    inStore(
      "interrupted",
      Effect.gen(function* () {
        const store = yield* Computations.ComputationStore;
        return yield* rangeManifest(
          repository,
          { baseOid: base, headOid: head },
          defaultManifestSettings(1_000_000),
          captureOutlineSource(),
        ).pipe(
          Effect.provideService(Computations.ComputationStore, {
            ...store,
            // Each hunk's leads are stored; the range's leads are cut off before they are.
            run: (spec, compute) =>
              store.run(
                spec,
                spec.op === "harness.range-leads"
                  ? Effect.andThen(
                      compute,
                      Effect.andThen(
                        Effect.sync(() => controller.abort()),
                        Effect.never,
                      ),
                    )
                  : compute,
              ),
          }),
        );
      }),
    ),
    { signal: controller.signal },
  );
  expect(Exit.hasInterrupts(exit)).toBe(true);
  const result = await Effect.runPromise(
    inStore(
      "interrupted",
      Effect.gen(function* () {
        const manifest = yield* rangeManifest(
          repository,
          { baseOid: base, headOid: head },
          defaultManifestSettings(1_000_000),
          captureOutlineSource(),
        );
        return { manifest, files: yield* fileAttempts };
      }),
    ),
  );
  // The manifest was complete and is reused; the range's leads are computed again from the
  // hunks' leads the first attempt stored.
  expect(result.manifest.status).toBe("reused");
  expect(result.manifest.value.hunks).toHaveLength(2);
  expect(result.manifest.leads.status).toBe("computed");
  expect(result.manifest.leads.value.counts.cached).toBeGreaterThan(0);
  expect(result.files).toEqual([{ n: 2 }]);
}, 60_000);

// Why: a lead round may contain thousands of hunks. Controlled waits expose the
// number of active searches, including whether cancellation leaves the pool running.
test("Graph lead searches use a bounded pool and stop that pool on abort", async () => {
  let active = 0;
  let maximum = 0;
  let started = 0;
  const graph: Retriever = {
    tree: "test-tree",
    description: {
      id: "controlled",
      family: "graph",
      config: DEFAULT_RETRIEVER,
      index: indexRecipe(captureOutlineSource()),
    },
    search: () =>
      Effect.gen(function* () {
        active++;
        started++;
        maximum = Math.max(maximum, active);
        yield* Effect.sleep(25);
        return {
          results: [],
          millis: 25,
          coverage: { chunks: 0, excluded: {} },
        };
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            active--;
          }),
        ),
      ),
  };
  const budget = new Scheduler(LEAD_CONCURRENCY * 2, LEAD_CONCURRENCY, 4);
  const graphConcurrency = Math.max(1, LEAD_CONCURRENCY - 1);
  const keyword: Retriever = {
    ...graph,
    description: { ...graph.description, keyed: { arm: "keyword" } },
    search: () =>
      Effect.succeed({
        results: [],
        millis: 0,
        coverage: { chunks: 0, excluded: {} },
      }),
  };
  const managed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(CpuWork, {
        budget,
        priority: { class: "interactive", position: "understand", stage: 0 },
        inherited: false,
      }),
    );
  const round = (waitMs: number) =>
    Effect.gen(function* () {
      const hunks = yield* fileHunks(
        repository,
        yield* diffTrees(repository, base, head),
        captureOutlineSource(),
      );
      const sample = hunks[0]!;
      if (sample.query === null)
        throw new Error("The fixture must produce a query");
      const query = sample.query;
      const many = Array.from({ length: 12 }, (_, index) => ({
        ...sample,
        hunkId: `test-${index}`,
        query: { ...query, sha256: `query-${index}` },
      }));
      return yield* graphLeadsRound(
        waitMs,
        many,
        graph,
        keyword,
        DEFAULT_RETRIEVER,
      );
    });
  const result = await Effect.runPromise(
    inStore("bounded", managed(round(5_000))),
  );
  expect(result.leads.size).toBe(12);
  expect(maximum).toBe(graphConcurrency);
  expect(active).toBe(0);
  started = 0;
  const controller = new AbortController();
  // Cancel after the pool starts, rather than depending on disk scheduling.
  const interruptedGraph = {
    ...graph,
    search: () =>
      Effect.gen(function* () {
        started++;
        if (started === graphConcurrency) controller.abort();
        yield* Effect.sleep(10_000);
        return {
          results: [],
          millis: 0,
          coverage: { chunks: 0, excluded: {} },
        };
      }),
  };
  const exit = await Effect.runPromiseExit(
    inStore(
      "bounded-abort",
      managed(
        Effect.gen(function* () {
          const hunks = yield* fileHunks(
            repository,
            yield* diffTrees(repository, base, head),
            captureOutlineSource(),
          );
          return yield* graphLeadsRound(
            5_000,
            Array.from({ length: 12 }, (_, i) => ({
              ...hunks[0]!,
              hunkId: `abort-${i}`,
              query:
                hunks[0]!.query === null
                  ? null
                  : { ...hunks[0]!.query, sha256: `abort-${i}` },
            })),
            interruptedGraph,
            keyword,
            DEFAULT_RETRIEVER,
          );
        }),
      ),
    ),
    { signal: controller.signal },
  );
  expect(Exit.hasInterrupts(exit)).toBe(true);
  expect(started).toBe(graphConcurrency);
  // Measured 1.695-3.995 s at load 5-18; 10x slowest, at least 30 s, rounded up to 5 s.
}, 40_000);

// Why: preparation and a review share computations in the worker. Cancelling the
// preparation must not fail a still-running review that joined its attempt.
test("a review retains shared code facts after the preparation subscriber is cancelled", async () => {
  const result = await Effect.runPromise(
    inStore(
      "cancelled-owner",
      Effect.gen(function* () {
        const store = yield* Computations.ComputationStore;
        const started = yield* Deferred.make<void>();
        const neverFinish = yield* Deferred.make<void>();
        const held: Computations.ComputationStore["Service"] = {
          ...store,
          run: (spec, compute) =>
            store.run(
              spec,
              spec.op === "harness.range-manifest"
                ? Effect.andThen(
                    Deferred.succeed(started, undefined),
                    Effect.andThen(Deferred.await(neverFinish), compute),
                  )
                : compute,
            ),
        };
        const owner = yield* Effect.forkChild(
          rangeManifest(
            repository,
            { baseOid: base, headOid: head },
            defaultManifestSettings(1_000_000),
            captureOutlineSource(),
          ).pipe(Effect.provideService(Computations.ComputationStore, held)),
        );
        yield* Deferred.await(started);
        const joined = yield* Deferred.make<void>();
        const consumer = yield* Effect.forkChild(
          rangeManifest(
            repository,
            { baseOid: base, headOid: head },
            defaultManifestSettings(1_000_000),
            captureOutlineSource(),
          ).pipe(
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
        );
        yield* Deferred.await(joined);
        yield* Fiber.interrupt(owner);
        yield* Deferred.succeed(neverFinish, undefined);
        return yield* Fiber.join(consumer);
      }),
    ),
  );
  expect(result.value.hunks.map((h) => h.path)).toEqual(["one.ts", "two.ts"]);
  expect(result.status).toBe("shared");
}, 60_000);

// Why: a rewritten branch may expose arbitrarily many historical commits. Admission
// must bound historical work while still preparing the exact review range.
test("a history above 58 commits queues only the range facts", async () => {
  const commands = Array.from(
    { length: 59 },
    (_, at) =>
      `commit refs/heads/capped\nmark :${at + 1}\ncommitter t <t@example.test> ${1700000000 + at} +0000\ndata 7\nfixture\nfrom ${at === 0 ? base : `:${at}`}\n\n`,
  ).join("");
  const imported = Bun.spawnSync(
    ["git", "-C", repository, "fast-import", "--quiet"],
    { stdin: Buffer.from(commands) },
  );
  expect(imported.exitCode, imported.stderr.toString()).toBe(0);
  const cappedHead = git("rev-parse", "refs/heads/capped");
  const result = await Effect.runPromise(
    inStore(
      "cap",
      Effect.gen(function* () {
        const queued = yield* enqueueRangePreparation(repository, {
          baseOid: base,
          headOid: cappedHead,
        });
        const queue = yield* JobQueue.JobQueue;
        return {
          queued,
          jobs: yield* queue.list({ states: ["waiting"], limit: 1000 }),
        };
      }),
    ),
  );
  expect(result.queued).toBe(0);
  expect(result.jobs.map((job) => job.dedupeKey)).toEqual([
    `commit.prepare@2:range:${base}:${cappedHead}`,
  ]);
});

import { CpuWork, cpuWork } from "../src/budget/cpu.ts";
import { Scheduler } from "../src/budget/scheduler.ts";
import { LeadConcurrency } from "../src/leads.ts";

test("Graph waits without CPU permits while keyword fallback runs and keeps its finished leads", async () => {
  const budget = new Scheduler(8, 4, 8);
  const preparation = await budget.admit({
    owner: "other-preparation",
    priority: { class: "preparation", position: "new", stage: 0 },
    resource: { kind: "cpu", permits: 4 },
  });
  const owners: string[] = [];
  const admit = budget.admit.bind(budget);
  budget.admit = (request, signal) => {
    owners.push(request.owner);
    return admit(request, signal);
  };
  let graphFinished = false;
  const releaseGraph = Promise.withResolvers<void>();
  const make = (slow: boolean): Retriever => ({
    tree: "round3-tree",
    description: {
      id: "round3",
      family: slow ? "graph" : "lexical",
      config: DEFAULT_RETRIEVER,
      index: indexRecipe(captureOutlineSource()),
      keyed: { arm: slow ? "graph" : "keyword" },
    },
    search: () =>
      Effect.gen(function* () {
        if (slow) {
          yield* Effect.promise(() => releaseGraph.promise);
          graphFinished = true;
        }
        return yield* cpuWork(
          "fixture.search",
          Effect.succeed({
            results: [],
            millis: 0,
            coverage: { chunks: 0, excluded: {} },
          }),
        );
      }),
  });
  try {
    const result = await Effect.runPromise(
      inStore(
        "shared-grant",
        Effect.gen(function* () {
          const hunks = yield* fileHunks(
            repository,
            yield* diffTrees(repository, base, head),
            captureOutlineSource(),
          );
          const result = yield* graphLeadsRound(
            20,
            hunks,
            make(true),
            make(false),
            DEFAULT_RETRIEVER,
          ).pipe(
            Effect.provideService(LeadConcurrency, 3),
            Effect.provideService(CpuWork, {
              budget,
              priority: {
                class: "interactive",
                position: "understand",
                stage: 0,
              },
              inherited: false,
            }),
            Effect.timeoutOption(300),
          );
          expect(Option.getOrUndefined(result)?.fellBack.size).toBe(2);
          expect(graphFinished).toBe(false);
          expect(owners).toHaveLength(2);
          expect((yield* Effect.promise(() => budget.observe())).held).toBe(4);
          releaseGraph.resolve();
          yield* Effect.forEach(hunks, (hunk) => hunkLeads(hunk, make(true)));
          const stored = yield* cachedLeads(
            hunks[0]!,
            DEFAULT_RETRIEVER,
            indexRecipe(captureOutlineSource()),
            {
              arm: "graph",
            },
          );
          return Option.isSome(stored);
        }),
      ),
    );
    expect(result).toBe(true);
    expect((await budget.observe()).held).toBe(4);
  } finally {
    releaseGraph.resolve();
    await preparation.release();
  }
}, 10000);

// A fallback storage failure must settle its Graph sibling and leave no CPU grant held.
test("a failed keyword fallback stops Graph and leaves no CPU grant held", async () => {
  const budget = new Scheduler(6, 4, 4);
  let active = 0;
  const graph: Retriever = {
    tree: "failure-tree",
    description: {
      id: "slow",
      family: "graph",
      config: DEFAULT_RETRIEVER,
      index: indexRecipe(captureOutlineSource()),
      keyed: { arm: "slow" },
    },
    search: () =>
      Effect.gen(function* () {
        active++;
        yield* Effect.sleep(1000);
        return {
          results: [],
          millis: 0,
          coverage: { chunks: 0, excluded: {} },
        };
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            active--;
          }),
        ),
      ),
  };
  const keyword: Retriever = {
    ...graph,
    description: { ...graph.description, keyed: { arm: "failed" } },
    search: () => Effect.fail(new Error("storage failed")),
  };
  const exit = await Effect.runPromiseExit(
    inStore(
      "failed-fallback",
      Effect.gen(function* () {
        const hunks = yield* fileHunks(
          repository,
          yield* diffTrees(repository, base, head),
          captureOutlineSource(),
        );
        return yield* graphLeadsRound(
          20,
          hunks,
          graph,
          keyword,
          DEFAULT_RETRIEVER,
        ).pipe(
          Effect.provideService(LeadConcurrency, 3),
          Effect.provideService(CpuWork, {
            budget,
            priority: {
              class: "interactive",
              position: "understand",
              stage: 0,
            },
            inherited: false,
          }),
        );
      }),
    ),
  );
  expect(Exit.isFailure(exit)).toBe(true);
  expect(active).toBe(0);
  expect((await budget.observe()).held).toBe(0);
});

// Why: on a one-thread machine keyword fallback must finish before Graph occupies that thread.
test("one-thread Graph leads prepare fallback before starting Graph CPU work", async () => {
  const budget = new Scheduler(1, 1, 4);
  const release = Promise.withResolvers<void>();
  let keywordFinished = false;
  const make = (graph: boolean): Retriever => ({
    tree: "single-thread-tree",
    description: {
      id: "single-thread",
      family: graph ? "graph" : "lexical",
      config: DEFAULT_RETRIEVER,
      index: indexRecipe(captureOutlineSource()),
      keyed: { arm: graph ? "graph" : "keyword" },
    },
    search: () =>
      cpuWork(
        "single-thread.search",
        Effect.gen(function* () {
          if (graph) {
            expect(keywordFinished).toBe(true);
            yield* Effect.promise(() => release.promise);
          } else keywordFinished = true;
          return {
            results: [],
            millis: 0,
            coverage: { chunks: 0, excluded: {} },
          };
        }),
      ),
  });
  try {
    await Effect.runPromise(
      inStore(
        "single-thread",
        Effect.gen(function* () {
          const hunks = yield* fileHunks(
            repository,
            yield* diffTrees(repository, base, head),
            captureOutlineSource(),
          );
          const graph = make(true);
          const result = yield* graphLeadsRound(
            20,
            hunks,
            graph,
            make(false),
            DEFAULT_RETRIEVER,
          ).pipe(
            Effect.provideService(LeadConcurrency, 4),
            Effect.provideService(CpuWork, {
              budget,
              priority: {
                class: "interactive",
                position: "understand",
                stage: 0,
              },
              inherited: false,
            }),
          );
          expect(result.fellBack.size).toBe(2);
          release.resolve();
          yield* Effect.forEach(hunks, (hunk) => hunkLeads(hunk, graph));
        }),
      ),
    );
    expect((await budget.observe()).held).toBe(0);
  } finally {
    release.resolve();
  }
}, 60_000);
