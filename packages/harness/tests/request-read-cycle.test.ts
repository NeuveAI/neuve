import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Deferred, Duration, Effect, Fiber, Layer } from "effect";
import type { FileSystem } from "effect/FileSystem";
import type { SqlClient } from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import {
  Blobs,
  Computations,
  Cycles,
  Identity,
  JobQueue,
  Log,
  mintUlid,
  Queries,
  Store,
  storeLocationIn,
} from "@neuve/records-core";
import { defaultConfig } from "../src/config.ts";
import { requestReview, type ReviewOptions } from "../src/request.ts";
import { keepLocalScope, readLocalScope, readScopeText } from "../src/scope.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const fixture = () => {
  const repository = mkdtempSync(join(tmpdir(), "neuve-request-cycle-"));
  roots.push(repository);
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", "-C", repository, ...args], {
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    });
    if (!result.success) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  git("init", "-q", "-b", "feature");
  git("config", "user.email", "git@example.test");
  git("config", "user.name", "Git User");
  const commit = (text: string) => {
    writeFileSync(join(repository, "file.txt"), text);
    git("add", "file.txt");
    git("commit", "-qm", text);
    return git("rev-parse", "HEAD");
  };
  const base = commit("base");
  const head = commit("review head");
  const tip = commit("later tip");
  git("branch", "followup", head);
  const location = storeLocationIn(join(repository, ".git"));
  const request = (target = head, overrides: Partial<ReviewOptions> = {}) =>
    requestReview({
      repository,
      location,
      range: `${base}..${target}`,
      requester: { _tag: "Unresolved" },
      frozenConfig: defaultConfig(),
      ...overrides,
    });
  const read = (
    branch = "feature",
    revision = base,
    selectScope?: Parameters<typeof Cycles.openOrJoinCycle<never, never>>[2],
  ) =>
    Cycles.openOrJoinCycle(
      {
        baseOid: revision,
        baseRef: revision,
        branch: branch,
        branchTipOid: git("rev-parse", "refs/heads/" + branch),
      },
      Identity.UNRESOLVED_ACTOR,
      selectScope,
    );
  const run = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      | SqlClient
      | FileSystem
      | Blobs.BlobStore
      | Computations.ComputationStore
      | JobQueue.JobQueue
    >,
  ) =>
    Effect.runPromise(
      Store.prepareForWrite.pipe(
        Effect.andThen(effect),
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
  return { repository, location, base, head, tip, git, read, request, run };
};

const scopeJobs = Effect.gen(function* () {
  const queue = yield* JobQueue.JobQueue;
  const jobs = yield* queue.list({ states: ["waiting"], limit: 20 });
  return jobs.filter(
    (job) => job.kind === "scope.fetch" || job.kind === "scope.fetch@2",
  );
});

// Read order must not let a stacked branch supply another task's plan.
test.each(["feature", "followup"])(
  "takes the checked-out branch's scope with %s reading first",
  async (first) => {
    const repo = fixture();
    const plans = { feature: "Plan A", followup: "Plan B" };
    const readPlan = (branch: keyof typeof plans) =>
      Effect.gen(function* () {
        const path = branch + ".md";
        const revision = branch === "feature" ? repo.head : repo.base;
        writeFileSync(join(repo.repository, path), plans[branch]);
        const read = yield* readLocalScope(repo.repository, revision, [path]);
        return yield* repo.read(branch, revision, (cycleId) =>
          keepLocalScope({ location: repo.location, cycleId }, read, () => {}),
        );
      });
    const result = await repo.run(
      Effect.gen(function* () {
        const firstRead =
          first === "followup" ? yield* readPlan("followup") : undefined;
        const feature = yield* readPlan("feature");
        const followup = firstRead ?? (yield* readPlan("followup"));
        const review = yield* repo.request();
        const jobs = yield* scopeJobs;
        const later = yield* repo.read("followup");
        return { feature, followup, review, jobs, later };
      }),
    );
    const cycleId = result.feature.cycleId;
    expect(result.review.cycleId).toBe(cycleId);
    expect(readScopeText(repo.location, result.review.cycleId, "S1").text).toBe(
      "Plan A",
    );
    expect(result.later).toEqual({
      cycleId: result.followup.cycleId,
      opened: false,
    });
    expect(
      result.jobs.filter((job) => job.dedupeKey === `scope.fetch:${cycleId}`),
    ).toMatchObject([{ kind: "scope.fetch@2" }]);
  },
);

// A detached checkout can still review a range when no branch has open scope for it.
test("opens and reuses a range cycle from a detached checkout without an earlier read", async () => {
  const repo = fixture();
  repo.git("switch", "--detach", repo.head);
  const { first, second, jobs } = await repo.run(
    Effect.gen(function* () {
      const first = yield* repo.request();
      const second = yield* repo.request();
      return { first, second, jobs: yield* scopeJobs };
    }),
  );
  expect(first.openedCycle).toBe(true);
  expect(first.events.map((event) => event.kind)).toEqual([
    "cycle.opened@1",
    "review.requested@1",
  ]);
  expect(second.cycleId).toBe(first.cycleId);
  expect(second.openedCycle).toBe(false);
  expect(jobs).toEqual([
    expect.objectContaining({
      kind: "scope.fetch",
      dedupeKey: `scope.fetch:${first.cycleId}`,
    }),
  ]);
});

const withBranchRead = async <A>(
  repo: ReturnType<typeof fixture>,
  branchRead: string,
  run: () => Promise<A>,
) => {
  const git = Bun.which("git");
  if (git === null) throw new Error("Git is required for the fixture");
  const bin = join(repo.repository, "git-fixture");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "git"),
    `#!${process.execPath}
import { Database } from "bun:sqlite";
const args = process.argv.slice(2);
if (args.includes("for-each-ref")) {
  ${branchRead}
}
const result = Bun.spawnSync([${JSON.stringify(git)}, ...args], {
  stdout: "inherit", stderr: "inherit",
});
process.exit(result.exitCode);
`,
    { mode: 0o755 },
  );
  const path = process.env.PATH ?? "";
  try {
    process.env.PATH = `${bin}:${path}`;
    return await run();
  } finally {
    process.env.PATH = path;
  }
};

// A branch lookup must leave the Records writer free for another process.
test("joins a read cycle while Git can acquire the store's write lock", async () => {
  const repo = fixture();
  const read = await repo.run(repo.read());
  const review = await withBranchRead(
    repo,
    `using db = new Database(${JSON.stringify(repo.location.database)});
     db.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE; ROLLBACK");`,
    () => repo.run(repo.request()),
  );
  expect(review.cycleId).toBe(read.cycleId);
  expect(review.openedCycle).toBe(false);
});

// An unreadable branch list can silently open a duplicate review cycle.
test("refuses to open a review cycle when Git cannot list local branches", async () => {
  const repo = fixture();
  await repo.run(repo.read());
  const { request, openings } = await withBranchRead(
    repo,
    'console.error("fixture branch read failed"); process.exit(2);',
    () =>
      repo.run(
        Effect.gen(function* () {
          const request = yield* Effect.result(repo.request());
          const openings = yield* Log.history({ kind: "cycle.opened@1" });
          return { request, openings };
        }),
      ),
  );
  expect(request).toMatchObject({
    _tag: "Failure",
    failure: {
      cause: { _tag: "GitFailed", exitCode: 2 },
    },
  });
  expect(openings).toEqual([]);
});

// A second review could revive older scope written by a build that opened cycles per revision.
test("never takes an older read cycle after the newest one is taken", async () => {
  const repo = fixture();
  const { older, newest, first, second } = await repo.run(
    Effect.gen(function* () {
      const older = yield* repo.read();
      const newest = mintUlid();
      yield* Log.append([
        {
          id: mintUlid(),
          kind: "cycle.opened@2",
          idempotencyKey: `cycle.read:${newest}`,
          actor: Identity.UNRESOLVED_ACTOR,
          occurredAt: new Date().toISOString(),
          attribution: { cycleId: newest },
          payload: {
            baseRef: repo.head,
            baseOid: repo.head,
            branch: "feature",
            branchTipOid: repo.tip,
          },
        },
      ]);
      const first = yield* repo.request();
      const second = yield* repo.request(repo.tip);
      return { older, newest, first, second };
    }),
  );
  expect(first.cycleId).toBe(newest);
  expect(second.openedCycle).toBe(true);
  expect(second.cycleId).not.toBe(older.cycleId);
});

// A request that has yet to publish can silently absorb the next round's scope.
test("the next read starts a cycle that a review of the newer head joins", async () => {
  const repo = fixture();
  const { read, first, nextRead, second } = await repo.run(
    Effect.gen(function* () {
      const read = yield* repo.read();
      const first = yield* repo.request();
      const nextRead = yield* repo.read();
      const second = yield* repo.request(repo.tip);
      return { read, first, nextRead, second };
    }),
  );
  expect(first.cycleId).toBe(read.cycleId);
  expect(nextRead.opened).toBe(true);
  expect(nextRead.cycleId).not.toBe(read.cycleId);
  expect(second.cycleId).toBe(nextRead.cycleId);
  expect(second.openedCycle).toBe(false);
  expect(second.events[0]).toMatchObject({
    kind: "cycle.opened@1",
    attribution: { range: { headOid: repo.tip } },
  });
});

// Counting from the opening can discard active scope, and waiting past seven days can reuse swept scope.
test("a recorded query resets the seven-day idle window", async () => {
  const repo = fixture();
  const { first, inside, expired, jobs } = await repo.run(
    Effect.gen(function* () {
      const now = Date.UTC(2026, 10, 1);
      const day = Duration.toMillis(Duration.days(1));
      yield* TestClock.setTime(now);
      const first = yield* repo.read();
      yield* TestClock.setTime(now + day);
      yield* Queries.record({
        actor: Identity.UNRESOLVED_ACTOR,
        attribution: { cycleId: first.cycleId },
        question: "What is the scope?",
        payload: {
          revision: repo.base,
          maxResults: 1,
          maxContextBytes: 1_000,
          cache: "reuse",
          profile: "full",
          relationshipPlanSize: 0,
          outcome: "completed",
          candidatesReturned: 0,
          relationships: 0,
          resultBytes: 0,
          resultsDroppedByBudget: 0,
          snippetsTruncatedByBudget: 0,
          startedAt: new Date(now + day).toISOString(),
          elapsedMs: 0,
        },
      });
      yield* TestClock.setTime(now + 8 * day - 1);
      const inside = yield* repo.read();
      yield* TestClock.setTime(now + 8 * day);
      const expired = yield* repo.read();
      return { first, inside, expired, jobs: yield* scopeJobs };
    }).pipe(Effect.provide(TestClock.layer())),
  );
  expect(inside).toEqual({ cycleId: first.cycleId, opened: false });
  expect(expired.opened).toBe(true);
  expect(expired.cycleId).not.toBe(first.cycleId);
  expect(jobs.map((job) => job.dedupeKey)).toEqual([
    `scope.fetch:${first.cycleId}`,
    `scope.fetch:${expired.cycleId}`,
  ]);
});

// Racing first reads at different revisions can silently split a branch's scope.
test("racing first reads at different revisions share one cycle", async () => {
  const repo = fixture();
  const { first, second, openings, jobs } = await repo.run(
    Effect.gen(function* () {
      const selecting = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const first = yield* Effect.forkChild(
        repo.read("feature", repo.base, () =>
          Deferred.succeed(selecting, undefined).pipe(
            Effect.andThen(Deferred.await(resume)),
            Effect.as(undefined),
          ),
        ),
      );
      yield* Deferred.await(selecting);
      const second = yield* repo.read("feature", repo.head);
      yield* Deferred.succeed(resume, undefined);
      return {
        first: yield* Fiber.join(first),
        second,
        openings: yield* Log.history({ kind: "cycle.opened@2" }),
        jobs: yield* scopeJobs,
      };
    }),
  );
  expect(second.opened).toBe(true);
  expect(first).toEqual({ cycleId: second.cycleId, opened: false });
  expect(openings.map(({ event }) => event)).toEqual([
    expect.objectContaining({
      attribution: { cycleId: second.cycleId },
      payload: expect.objectContaining({ baseOid: repo.head }),
    }),
  ]);
  expect(jobs.map((job) => job.dedupeKey)).toEqual([
    `scope.fetch:${second.cycleId}`,
  ]);
});

// A detached ticket review needs its own cycle even when read scope is open.
test("opens a separate cycle for explicitly selected scope from a detached checkout", async () => {
  const repo = fixture();
  const { read, review } = await repo.run(
    Effect.gen(function* () {
      const read = yield* repo.read();
      repo.git("switch", "--detach", repo.head);
      const review = yield* repo.request(repo.head, {
        scopeSource: { server: "linear", item: "WORK-7", workspace: null },
        scopeIntegrations: {
          status: "configured",
          path: join(repo.repository, "fixture-integrations.json"),
          file: {
            version: 1,
            servers: {
              linear: {
                transport: { type: "stdio", command: "/usr/bin/false" },
                variables: [],
                tools: ["issue"],
                fetch: { tool: "issue", argument: "id" },
                identifiers: {},
              },
            },
          },
        },
      });
      return { read, review };
    }),
  );
  expect(review.cycleId).not.toBe(read.cycleId);
  expect(review.events.map((event) => event.kind)).toEqual([
    "cycle.scope-selected@1",
    "cycle.opened@1",
    "review.requested@1",
  ]);
});
