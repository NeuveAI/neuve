// Why (8.19): a newer build may run a range's review under its own job kind (`review.run@3`) with
// the key main's request would use. A request after that run ended must start the next generation,
// exactly as after main's own ended run, never join the ended job; it joins the newer build's job
// only while that job is queued, or once its run completed the review. The ended count is read by
// dedupe key and state, so it never decodes the newer build's rows.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import {
  Blobs,
  Computations,
  JobQueue,
  Store,
  storeLocationIn,
} from "@neuve/records-core";
import { runSpec } from "../src/config.ts";
import { requestReview } from "../src/request.ts";

const directory = mkdtempSync(join(tmpdir(), "harness-newer-build-"));
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

type Ended = "failed" | "completed-with-gaps" | "completed" | "waiting";

/** Requests a review, hands its job to the newer build in `state`, and requests it again. */
const again = (state: Ended, kind = "review.run@3") => {
  const location = storeLocationIn(join(directory, `store-${state}-${kind}`));
  const request = () =>
    requestReview({
      location,
      repository,
      range: "HEAD~1..HEAD",
      requester: { _tag: "Unresolved" },
      search: {},
      stack: undefined,
    });
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* Store.prepareForWrite;
      const first = yield* request();
      const sql = yield* SqlClient;
      const ended = state === "waiting" ? "waiting" : state.split("-")[0]!;
      yield* sql`UPDATE jobs SET kind = ${kind}, state = ${ended},
        attempts = ${ended === "waiting" ? 0 : 1}
        WHERE dedupe_key = ${first.dedupeKey}`;
      if (state === "completed") {
        // The newer build's run stored its completion as a worker does.
        const store = yield* Computations.ComputationStore;
        yield* store.run(
          runSpec(first.range, first.config),
          Effect.succeed({
            bytes: new TextEncoder().encode(
              JSON.stringify({
                runId: first.events.at(-1)!.id,
                generation: 0,
                jobSeq: 1,
              }),
            ),
            mediaType: "application/json",
          }),
        );
      }
      const second = yield* request();
      const held = yield* sql<{
        kind: string;
      }>`SELECT kind FROM jobs WHERE dedupe_key = ${second.dedupeKey}`;
      return {
        first: first.generation,
        second: second.generation,
        joined: second.dedupeKey === first.dedupeKey,
        kind: held[0]?.kind,
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
};

test("after a newer build's run of the key ended, a request starts the next generation", async () => {
  for (const state of ["failed", "completed-with-gaps"] as const) {
    for (const kind of ["review.run@3", "review.run@2"]) {
      expect({ state, ended: kind, ...(await again(state, kind)) }).toEqual({
        state,
        ended: kind,
        first: 0,
        second: 1,
        joined: false,
        // The next generation's job is main's own.
        kind: "review.run@2",
      });
    }
  }
});

test("a request joins a newer build's job only while it waits, or once its run completed", async () => {
  expect(await again("waiting")).toEqual({
    first: 0,
    second: 0,
    joined: true,
    kind: "review.run@3",
  });
  expect(await again("completed")).toEqual({
    first: 0,
    second: 0,
    joined: true,
    kind: "review.run@3",
  });
});
