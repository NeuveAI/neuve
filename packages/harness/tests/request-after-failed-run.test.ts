// Why (plant 108, 10.42, record 0016): a review job can still fail on every attempt (a publisher or
// store error, a failed stage task), and then the handler writes `run.failed` with no receipt and
// no gap. The range must stay reviewable: while the job retries, a person's request for the same
// review joins it (one run per key); once the queue's policy ends it failed, the next request starts
// the next generation instead of joining the failed job. The job fails through the queue's own
// `take`/`fail` and its review policy (three attempts), not by writing its state.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import {
  Blobs,
  Computations,
  JobQueue,
  Store,
  storeLocationIn,
} from "@neuve/records-core";
import { requestReview } from "../src/request.ts";

const directory = mkdtempSync(join(tmpdir(), "harness-failed-run-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const repository = join(directory, "repo");
const git = (...args: Array<string>) => {
  const result = Bun.spawnSync(["git", "-C", repository, ...args], {
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
};
Bun.spawnSync(["git", "init", "-q", repository]);
git("config", "user.email", "dev@example.test");
git("config", "user.name", "Dev");
for (const text of ["one\n", "two\n"]) {
  writeFileSync(join(repository, "file.txt"), text);
  git("add", ".");
  git("commit", "-q", "-m", text.trim());
}

test("a review whose job fails on every attempt leaves the next request a new generation", async () => {
  const location = storeLocationIn(join(directory, "store"));
  const request = () =>
    requestReview({
      location,
      repository,
      range: "HEAD~1..HEAD",
      requester: { _tag: "Unresolved" },
      search: {},
      stack: undefined,
    });
  const seen = await Effect.runPromise(
    Effect.gen(function* () {
      yield* Store.prepareForWrite;
      const queue = yield* JobQueue.JobQueue;
      const sql = yield* SqlClient;
      const first = yield* request();
      const joins: Array<{ generation: number; joined: boolean }> = [];
      const states: Array<string> = [];
      for (let attempt = 0; attempt < 10; attempt++) {
        const taken = yield* queue.take(["review.run@2"]);
        if (Option.isNone(taken)) break;
        const job = taken.value;
        const failed = yield* queue.fail(job.seq, job.attempts, {
          tag: "RunFailed",
          message: "a follow-on run reached Publish with no batches to publish",
        });
        states.push(failed.state);
        if (failed.state === "failed") break;
        // While it waits for its next attempt, a request for the same review joins it.
        const during = yield* request();
        joins.push({
          generation: during.generation,
          joined: during.dedupeKey === first.dedupeKey,
        });
        // The backoff is the queue's; the test only lets its time pass.
        yield* sql`UPDATE jobs SET run_at = '1970-01-01T00:00:00.000Z'
          WHERE job_seq = ${job.seq} AND state = 'delayed'`;
      }
      const after = yield* request();
      const waiting = yield* sql<{
        state: string;
      }>`SELECT state FROM jobs WHERE dedupe_key = ${after.dedupeKey}`;
      return {
        first: first.generation,
        states,
        joins,
        after: after.generation,
        joinedAfter: after.dedupeKey === first.dedupeKey,
        next: waiting.map((row) => row.state),
      };
    }).pipe(
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
  expect(seen).toEqual({
    first: 0,
    // The review policy's three attempts: two retries, then the job ends failed.
    states: ["delayed", "delayed", "failed"],
    joins: [
      { generation: 0, joined: true },
      { generation: 0, joined: true },
    ],
    after: 1,
    joinedAfter: false,
    next: ["waiting"],
  });
});
