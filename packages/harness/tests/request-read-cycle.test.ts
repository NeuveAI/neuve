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
  isReviewRun,
  storeLocationIn,
} from "@neuve/records-core";
import { defaultConfig, PIPELINE_VERSION, runKeyFor } from "../src/config.ts";
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
  return { repository, location, base, head, commit, git, read, request, run };
};

const scopeJobs = Effect.gen(function* () {
  const queue = yield* JobQueue.JobQueue;
  const jobs = yield* queue.list({ states: ["waiting"], limit: 20 });
  return jobs.filter(
    (job) => job.kind === "scope.fetch" || job.kind === "scope.fetch@2",
  );
});

const reviewJobs = Effect.gen(function* () {
  const queue = yield* JobQueue.JobQueue;
  const jobs = yield* queue.list({ states: ["waiting"], limit: 20 });
  return jobs.filter((job) => isReviewRun(job.kind));
});

test.each(["feature", "other", "detached", "worktree"])(
  "joins the only branch ending at the head from the %s checkout",
  async (checkout) => {
    const repo = fixture();
    const read = await repo.run(repo.read());
    if (checkout === "other") repo.git("switch", "-c", "other", repo.base);
    if (checkout === "detached") repo.git("switch", "--detach", repo.head);
    let branchCheckout = repo.repository;
    if (checkout === "worktree") {
      branchCheckout = join(repo.repository, "review-worktree");
      repo.git("worktree", "add", "-b", "other", branchCheckout, repo.base);
    }
    const review = await repo.run(repo.request(repo.head, { branchCheckout }));
    expect(review.cycleId).toBe(read.cycleId);
    expect(review.openedCycle).toBe(false);
  },
);

test.each(["detached", "other"])(
  "names both branches at the review head from the %s checkout",
  async (checkout) => {
    const repo = fixture();
    repo.git("branch", "followup", repo.head);
    if (checkout === "detached") repo.git("switch", "--detach", repo.head);
    else repo.git("switch", "-c", "other", repo.base);
    await expect(repo.run(repo.request())).rejects.toThrow(
      '"feature" and "followup" end at this review\'s head, so pass --branch <name> with the branch to review.',
    );
  },
);

test.each(["feature", "followup"])(
  "accepts --branch %s when both branches end at the review head",
  async (branch) => {
    const repo = fixture();
    repo.git("branch", "followup", repo.head);
    if (branch === "feature") repo.git("switch", "followup");
    const wrongBranch = () =>
      repo.run(repo.request(repo.head, { branch: "other" }));
    const refusal =
      '--branch names no branch that ends at this review\'s head, so pass --branch with "feature" or "followup".';
    await expect(wrongBranch()).rejects.toThrow(refusal);
    const read = await repo.run(repo.read(branch));
    const review = await repo.run(repo.request(repo.head, { branch }));
    expect(review.cycleId).toBe(read.cycleId);
    expect(review.openedCycle).toBe(false);
    await expect(wrongBranch()).rejects.toThrow(refusal);
  },
);

test("refuses a named branch that contains the head when another branch ends there", async () => {
  const repo = fixture();
  repo.git("switch", "-c", "other");
  repo.commit("later tip");
  const read = await repo.run(repo.read());
  const wrongBranch = () =>
    repo.run(repo.request(repo.head, { branch: "other" }));
  const refusal =
    '--branch names no branch that ends at this review\'s head, so pass --branch with "feature" or leave it out.';
  await expect(wrongBranch()).rejects.toThrow(refusal);
  const review = await repo.run(repo.request());
  expect(review.cycleId).toBe(read.cycleId);
  await expect(wrongBranch()).rejects.toThrow(refusal);
});

test.each([undefined, "feature", "missing"])(
  "reviews a head inside a branch's history with branch %s",
  async (branch) => {
    const repo = fixture();
    repo.commit("later tip");
    if (branch === "missing") {
      await expect(
        repo.run(repo.request(repo.head, { branch })),
      ).rejects.toThrow(
        "--branch names no local branch that holds this review's head. Pass --branch <name> with a local branch that does.",
      );
      return;
    }
    const read = await repo.run(repo.read());
    const review = await repo.run(repo.request(repo.head, { branch }));
    if (branch === "feature") {
      expect(review.cycleId).toBe(read.cycleId);
      expect(review.openedCycle).toBe(false);
    } else {
      expect(review.cycleId).not.toBe(read.cycleId);
      expect(review.openedCycle).toBe(true);
    }
  },
);

test("takes the plan for each branch in a stack from the upper checkout", async () => {
  const repo = fixture();
  repo.git("switch", "-c", "followup");
  const tip = repo.commit("upper tip");
  writeFileSync(join(repo.repository, "lower.md"), "Plan A");
  writeFileSync(join(repo.repository, "upper.md"), "Plan B");
  const { lower, upper, feature, followup } = await repo.run(
    Effect.gen(function* () {
      const planB = yield* readLocalScope(repo.repository, repo.head, [
        "upper.md",
      ]);
      const followup = yield* repo.read("followup", repo.head, (cycleId) =>
        keepLocalScope({ location: repo.location, cycleId }, planB, () => {}),
      );
      const planA = yield* readLocalScope(repo.repository, repo.base, [
        "lower.md",
      ]);
      const feature = yield* repo.read("feature", repo.base, (cycleId) =>
        keepLocalScope({ location: repo.location, cycleId }, planA, () => {}),
      );
      const lower = yield* repo.request();
      const upper = yield* repo.request(tip, {
        range: `${repo.head}..${tip}`,
      });
      return { lower, upper, feature, followup };
    }),
  );
  expect(lower.cycleId).toBe(feature.cycleId);
  expect(upper.cycleId).toBe(followup.cycleId);
  expect(readScopeText(repo.location, lower.cycleId, "S1").text).toBe("Plan A");
  expect(readScopeText(repo.location, upper.cycleId, "S1").text).toBe("Plan B");
});

test.each(["same", "reordered", "different"] as const)(
  "requests the same range from two worktrees with the %s pinned plan",
  async (plans) => {
    const repo = fixture();
    const other = join(repo.repository, "other-checkout");
    repo.git("worktree", "add", "-b", "followup", other, repo.head);
    const otherPlan = plans === "reordered" ? "plan.md" : "other-plan.md";
    writeFileSync(join(repo.repository, "plan.md"), "Plan A");
    writeFileSync(join(repo.repository, "details.md"), "Details");
    writeFileSync(join(other, "details.md"), "Details");
    writeFileSync(
      join(other, otherPlan),
      plans === "different" ? "Plan B" : "Plan A",
    );
    const requestId = mintUlid();
    const { feature, followup, first, second, retry, jobs } = await repo.run(
      Effect.gen(function* () {
        const firstPlan = yield* readLocalScope(repo.repository, repo.base, [
          "plan.md",
          "details.md",
        ]);
        const feature = yield* repo.read("feature", repo.base, (cycleId) =>
          keepLocalScope(
            { location: repo.location, cycleId },
            firstPlan,
            () => {},
          ),
        );
        const secondPlan = yield* readLocalScope(
          other,
          repo.base,
          plans === "reordered"
            ? ["details.md", otherPlan]
            : [otherPlan, "details.md"],
        );
        const followup = yield* repo.read("followup", repo.base, (cycleId) =>
          keepLocalScope(
            { location: repo.location, cycleId },
            secondPlan,
            () => {},
          ),
        );
        writeFileSync(join(repo.repository, "plan.md"), "Live edit");
        const first = yield* repo.request(repo.head, { requestId });
        const second = yield* repo.request(repo.head, {
          repository: other,
        });
        const retry = yield* repo.request(repo.head, {
          branch: "feature",
          repository: other,
          requestId,
        });
        return {
          feature,
          followup,
          first,
          second,
          retry,
          jobs: yield* reviewJobs,
        };
      }),
    );
    expect(first.cycleId).toBe(feature.cycleId);
    expect(first.runKey).not.toBe(runKeyFor(first.range, defaultConfig()));
    expect(readScopeText(repo.location, first.cycleId, "S1").text).toBe(
      "Plan A",
    );
    expect(retry.cycleId).toBe(first.cycleId);
    expect(retry.dedupeKey).toBe(first.dedupeKey);
    expect(retry.events.map(({ id }) => id)).toEqual([requestId]);
    if (plans !== "different") {
      expect(second.cycleId).toBe(first.cycleId);
      expect(second.runKey).toBe(first.runKey);
      expect(second.dedupeKey).toBe(first.dedupeKey);
      expect(jobs.map((job) => job.dedupeKey)).toEqual([first.dedupeKey]);
    } else {
      expect(second.cycleId).toBe(followup.cycleId);
      expect(second.runKey).not.toBe(first.runKey);
      expect(readScopeText(repo.location, second.cycleId, "S1").text).toBe(
        "Plan B",
      );
      expect(jobs.map((job) => job.dedupeKey).sort()).toEqual(
        [first.dedupeKey, second.dedupeKey].sort(),
      );
    }
  },
);

test("reuses the key and queued job of a review written before plans joined the key", async () => {
  const repo = fixture();
  writeFileSync(join(repo.repository, "plan.md"), "Plan A");
  const range = { baseRef: repo.base, baseOid: repo.base, headOid: repo.head };
  const config = defaultConfig();
  const runKey = runKeyFor(range, config);
  const { read, oldJobs, review, jobs } = await repo.run(
    Effect.gen(function* () {
      const plan = yield* readLocalScope(repo.repository, repo.base, [
        "plan.md",
      ]);
      const read = yield* repo.read("feature", repo.base, (cycleId) =>
        keepLocalScope({ location: repo.location, cycleId }, plan, () => {}),
      );
      const attribution = { cycleId: read.cycleId, range };
      const occurredAt = new Date().toISOString();
      const requestId = mintUlid();
      yield* Log.append([
        {
          id: mintUlid(),
          kind: "cycle.opened@1",
          idempotencyKey: `cycle:${read.cycleId}`,
          actor: Identity.UNRESOLVED_ACTOR,
          occurredAt,
          attribution,
          payload: {},
        },
        {
          id: requestId,
          kind: "review.requested@1",
          idempotencyKey: `review.requested:${requestId}`,
          actor: Identity.UNRESOLVED_ACTOR,
          occurredAt,
          attribution,
          payload: {
            runKey,
            generation: 0,
            pipeline: { version: PIPELINE_VERSION, config },
          },
        },
      ]);
      const oldJobs = yield* reviewJobs;
      const review = yield* repo.request();
      return { read, oldJobs, review, jobs: yield* reviewJobs };
    }),
  );
  expect(review.cycleId).toBe(read.cycleId);
  expect(review.runKey).toBe(runKey);
  expect(jobs).toMatchObject([{ dedupeKey: review.dedupeKey }]);
  expect(jobs.map((job) => job.seq)).toEqual(oldJobs.map((job) => job.seq));
});

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

test.each([false, true])(
  "reviews from a branch cut at the implementer's tip with reviewer read %s",
  async (reviewerRead) => {
    const repo = fixture();
    const implementer = await repo.run(repo.read());
    repo.git("switch", "-c", "reviewer");
    if (reviewerRead) {
      const reviewer = await repo.run(repo.read("reviewer"));
      const review = await repo.run(repo.request());
      expect(review.cycleId).toBe(reviewer.cycleId);
      expect(review.openedCycle).toBe(false);
    } else {
      const review = await repo.run(repo.request());
      expect(review.cycleId).not.toBe(implementer.cycleId);
      expect(review.openedCycle).toBe(true);
    }
  },
);

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
      message:
        "Git could not list the local branches: fixture branch read failed",
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
            branchTipOid: repo.head,
          },
        },
      ]);
      const first = yield* repo.request();
      const second = yield* repo.request(repo.commit("later tip"));
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
  const { read, first, nextRead, second, tip } = await repo.run(
    Effect.gen(function* () {
      const read = yield* repo.read();
      const first = yield* repo.request();
      const tip = repo.commit("later tip");
      const nextRead = yield* repo.read();
      const second = yield* repo.request(tip);
      return { read, first, nextRead, second, tip };
    }),
  );
  expect(first.cycleId).toBe(read.cycleId);
  expect(nextRead.opened).toBe(true);
  expect(nextRead.cycleId).not.toBe(read.cycleId);
  expect(second.cycleId).toBe(nextRead.cycleId);
  expect(second.openedCycle).toBe(false);
  expect(second.events[0]).toMatchObject({
    kind: "cycle.opened@1",
    attribution: { range: { headOid: tip } },
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

test("opens a ticket review's own cycle even when branches share the head", async () => {
  const repo = fixture();
  repo.git("branch", "followup", repo.head);
  const scope: Partial<ReviewOptions> = {
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
  };
  await expect(
    repo.run(repo.request(repo.head, { ...scope, branch: "missing" })),
  ).rejects.toThrow(
    "A review with its own ticket or sources opens its own cycle, so omit --branch.",
  );
  const { read, review } = await repo.run(
    Effect.gen(function* () {
      const read = yield* repo.read();
      repo.git("switch", "--detach", repo.head);
      const review = yield* repo.request(repo.head, scope);
      return { read, review };
    }),
  );
  expect(review.openedCycle).toBe(true);
  expect(review.cycleId).not.toBe(read.cycleId);
  expect(review.events.map((event) => event.kind)).toEqual([
    "cycle.scope-selected@1",
    "cycle.opened@1",
    "review.requested@1",
  ]);
});
