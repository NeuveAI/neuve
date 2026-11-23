import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Layer } from "effect";
import type { FileSystem } from "effect/FileSystem";
import type { SqlClient } from "effect/sql/SqlClient";
import {
  Blobs,
  Computations,
  Cycles,
  Identity,
  JobQueue,
  Log,
  Store,
  storeLocationIn,
} from "@neuve/records-core";
import { defaultConfig } from "../src/config.ts";
import { workerHandlers } from "../src/handler.ts";
import { requestReview, type ReviewOptions } from "../src/request.ts";
import { cycleSnapshot } from "../src/scope.ts";
import { mcpClientsLayer } from "../src/mcp-client.ts";

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
  git("init", "-q", "-b", "work");
  git("config", "user.email", "git@example.test");
  git("config", "user.name", "Git User");
  const commit = (text: string) => {
    writeFileSync(join(repository, "file.txt"), text);
    git("add", "file.txt");
    git("commit", "-qm", text);
    return git("rev-parse", "HEAD");
  };
  const base = commit("base");
  git("branch", "unrelated");
  const head = commit("review head");
  const tip = commit("later tip");
  git("branch", "earlier");
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
  const read = (branch = "work") =>
    Cycles.openOrJoinCycle(
      { baseOid: base, baseRef: base, branch },
      Identity.UNRESOLVED_ACTOR,
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
  return { repository, location, base, head, tip, read, request, run };
};

const scopeJobs = Effect.gen(function* () {
  const queue = yield* JobQueue.JobQueue;
  const jobs = yield* queue.list({ states: ["waiting"], limit: 20 });
  return jobs.filter(
    (job) => job.kind === "scope.fetch" || job.kind === "scope.fetch@2",
  );
});

// A request can join a read even after the branch advances, and the binding preserves its first fetch.
test("binds the newest eligible read cycle without adding a second scope job", async () => {
  const repo = fixture();
  const result = await repo.run(
    Effect.gen(function* () {
      yield* repo.read("earlier");
      const read = yield* repo.read();
      yield* repo.read("unrelated");
      const review = yield* repo.request();
      const events = yield* Log.history({ cycleId: read.cycleId });
      const jobs = yield* scopeJobs;
      return { read, review, events, jobs };
    }),
  );
  const cycleId = result.read.cycleId;
  expect(result.review.cycleId).toBe(cycleId);
  expect(result.review.openedCycle).toBe(false);
  expect(result.events.map(({ event }) => event.kind)).toEqual([
    "cycle.opened@2",
    "cycle.opened@1",
    "review.requested@1",
  ]);
  expect(result.events[1]?.event).toMatchObject({
    idempotencyKey: `cycle:${cycleId}`,
    attribution: { cycleId, range: { baseOid: repo.base, headOid: repo.head } },
  });
  expect(
    result.jobs.filter((job) => job.dedupeKey === `scope.fetch:${cycleId}`),
  ).toEqual([
    expect.objectContaining({
      kind: "scope.fetch@2",
      eventId: result.events[0]?.event.id,
    }),
  ]);
});

// Review-only callers still open and reuse a range cycle with the legacy scope job.
test("opens the same range cycle as before when there was no read", async () => {
  const repo = fixture();
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

// A second head must keep its own range even when both heads belong to the read's branch.
test("opens a separate cycle when the read cycle is bound to another head", async () => {
  const repo = fixture();
  const { read, first, second } = await repo.run(
    Effect.gen(function* () {
      const read = yield* repo.read();
      const first = yield* repo.request();
      const second = yield* repo.request(repo.tip);
      return { read, first, second };
    }),
  );
  expect(first.cycleId).toBe(read.cycleId);
  expect(second.cycleId).not.toBe(read.cycleId);
  expect(second.openedCycle).toBe(true);
  expect(second.events[0]).toMatchObject({
    kind: "cycle.opened@1",
    attribution: { range: { headOid: repo.tip } },
  });
});

// An explicit scope selection must be recorded before its own opening.
test("keeps explicitly selected scope out of a read-opened cycle", async () => {
  const repo = fixture();
  const { read, review } = await repo.run(
    Effect.gen(function* () {
      const read = yield* repo.read();
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

// The review and the queued job must use the same base snapshot whichever reaches it first.
test.each(["review", "scope job"])(
  "reads the base snapshot with %s first",
  async (first) => {
    const repo = fixture();
    const integrations = {
      status: "absent",
      path: join(repo.repository, "integrations.json"),
    } as const;
    const snapshot = await repo.run(
      Effect.gen(function* () {
        yield* repo.read();
        const review = yield* repo.request();
        if (first === "scope job") {
          const [job] = yield* scopeJobs;
          const handler = workerHandlers(repo)["scope.fetch@2"];
          if (job === undefined || handler === undefined)
            throw new Error("Missing scope job or handler");
          expect(yield* handler(job)).toBe("computed");
        }
        return yield* cycleSnapshot({
          repository: repo.repository,
          location: repo.location,
          cycleId: review.cycleId,
          range: review.range,
          integrations,
        }).pipe(Effect.provide(mcpClientsLayer(integrations)));
      }),
    );
    expect(snapshot.status).toBe(first === "scope job" ? "reused" : "computed");
    expect(snapshot.value.range).toEqual({
      baseOid: repo.base,
      headOid: repo.base,
      mergeBase: repo.base,
    });
    expect(
      snapshot.value.sources.filter((source) => source.kind === "commit-text"),
    ).toEqual([]);
  },
);
