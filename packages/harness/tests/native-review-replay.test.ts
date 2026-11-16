import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Layer } from "effect";
import {
  Blobs,
  Computations,
  JobQueue,
  Log,
  Store,
  mintUlid,
  storeLocationIn,
} from "@neuve/records-core";
import { defaultConfig } from "../src/config";
import { requestReview } from "../src/request";

// A lost admission reply must recover its original failed job, rather than request a retry generation.
const root = mkdtempSync(join(tmpdir(), "neuve-native-replay-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const git = (...args: string[]) => {
  const r = Bun.spawnSync(["git", "-C", root, ...args]);
  if (r.exitCode) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
};
git("init", "-qb", "main");
git("config", "user.email", "fixture@example.test");
git("config", "user.name", "Fixture");
for (const text of ["before", "after"]) {
  writeFileSync(join(root, "work.txt"), text);
  git("add", "work.txt");
  git("commit", "-qm", text);
}
const base = git("rev-parse", "HEAD^");
const head = git("rev-parse", "HEAD");
const location = storeLocationIn(join(root, "records"));
const run = <A, E>(
  program: Effect.Effect<
    A,
    E,
    | import("effect/sql/SqlClient").SqlClient
    | JobQueue.JobQueue
    | Computations.ComputationStore
    | Blobs.BlobStore
  >,
) =>
  Effect.runPromise(
    program.pipe(
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
const origin = {
  kind: "channel" as const,
  host: "fixture",
  channel: "one",
  chat: 0,
  items: [],
};
const frozenConfig = defaultConfig();
const args = {
  location,
  repository: root,
  range: `${base}..${head}`,
  requester: {
    _tag: "Agent" as const,
    harness: "neuve-pi",
    sessionId: "one",
    subagentId: "0",
  },
  frozenConfig,
  origin,
};

test("durable request ID recovers the exact original admission after failure and preserves fresh retries", async () => {
  const id = mintUlid();
  const result = await run(
    Effect.gen(function* () {
      yield* Store.prepareForWrite;
      const first = yield* requestReview({ ...args, requestId: id });
      const q = yield* JobQueue.JobQueue;
      const job = (yield* q.list({ states: ["waiting"], limit: 100 })).find(
        (job) => job.dedupeKey === first.dedupeKey,
      );
      if (!job) throw new Error("No admitted job");
      yield* q.drop(job.seq);
      const recovered = yield* requestReview({ ...args, requestId: id });
      const retry = yield* requestReview({ ...args, requestId: mintUlid() });
      const requested = yield* Log.history({
        kind: "review.requested@1",
        limit: 10,
      });
      const registered = yield* Log.history({
        kind: "actor.registered@1",
        limit: 10,
      });
      return { first, recovered, retry, requested, registered };
    }),
  );
  expect(result.recovered.events.map((e) => e.id)).toEqual([id]);
  expect(result.recovered.generation).toBe(0);
  expect(result.recovered.dedupeKey).toBe(result.first.dedupeKey);
  expect(result.recovered.cycleId).toBe(result.first.cycleId);
  expect(result.recovered.association).toBe(result.first.association);
  expect(result.retry.generation).toBe(1);
  expect(result.requested).toHaveLength(2);
  expect(result.registered).toHaveLength(1);
  expect(result.registered[0]?.event).toMatchObject({
    payload: {
      actorKind: "agent",
      harness: "neuve-pi",
      sessionId: "one",
      subagentId: "0",
    },
  });
});

test("identity reuse rejects configuration, actor, range and provenance changes without appending", async () => {
  const id = mintUlid();
  await run(
    Effect.gen(function* () {
      yield* Store.prepareForWrite;
      yield* requestReview({ ...args, requestId: id });
    }),
  );
  for (const change of [
    {
      frozenConfig: {
        ...frozenConfig,
        budgets: {
          ...frozenConfig.budgets,
          lifetimeMs: frozenConfig.budgets.lifetimeMs + 1,
        },
      },
    },
    { requester: { _tag: "Actor" as const, actorId: "a".repeat(64) } },
    { range: `${head}..${base}` },
    { origin: { ...origin, chat: 1 } },
  ])
    await expect(
      run(requestReview({ ...args, ...change, requestId: id })),
    ).rejects.toThrow("identity was reused");
});
