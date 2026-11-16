// Why (10.137, 10.139): recompose scores candidates by running a completed review again on a scratch
// copy of its store. A networkless one must have no model, client or sign-in to reach, or a stored
// output that is missing would quietly cost a call; a step it cannot reuse must stop it as a
// refusal, never a retry; and it must refuse a run whose stages are not all stored, and a store
// whose waiting review job it would run in its own place.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Layer } from "effect";
import {
  Blobs,
  Computations,
  JobQueue,
  Store,
  storeLocationIn,
} from "@neuve/records-core";
import { runSpec } from "../src/config.ts";
import { needsModel, StageFailure } from "../src/pipeline.ts";
import {
  inGitDirectory,
  recompose,
  RECOMPOSE_STEPS,
} from "../src/recompose.ts";
import { requestReview } from "../src/request.ts";
import { Schema } from "effect";

test("a step a recompose cannot reuse stops the run as a refusal naming it, never a retry", () => {
  const failure = needsModel("harness.frame", "frame");
  expect(Schema.is(StageFailure)(failure)).toBe(true);
  expect(failure).toMatchObject({ tag: "NeedsModel", retryable: false });
  expect(failure.message).toContain("frame");
  expect(RECOMPOSE_STEPS).toEqual({
    frame: "harness.frame",
    map: "harness.map",
    find: "harness.find",
    verify: "harness.verify",
  });
});

const directory = mkdtempSync(join(tmpdir(), "harness-recompose-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

test("recompose refuses an unknown run, a run that did not complete, and a store with a review job waiting", async () => {
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
  for (const text of ["one\n", "two\n"]) {
    writeFileSync(join(repository, "file.txt"), text);
    git("add", ".");
    git(
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "-q",
      "-m",
      text,
    );
  }
  const location = storeLocationIn(join(directory, "store"));
  const refusals = await Effect.runPromise(
    Effect.gen(function* () {
      yield* Store.prepareForWrite;
      const request = yield* requestReview({
        location,
        repository,
        range: "HEAD~1..HEAD",
        requester: { _tag: "Unresolved" },
        search: {},
        stack: undefined,
        deadline: undefined,
      });
      const runId = request.events.at(-1)!.id;
      const attempt = (id: string) =>
        Effect.flip(
          recompose({ location, repository, runId: id, allowModel: [] }),
        ).pipe(Effect.map((error) => String((error as Error).message)));
      const unknown = yield* attempt("01JUNKNOWNRUN0000000000000");
      const incomplete = yield* attempt(runId);
      // The run's completion stored as a worker stores it; its job still waits in the queue.
      const store = yield* Computations.ComputationStore;
      yield* store.run(
        runSpec(request.range, request.config),
        Effect.succeed({
          bytes: new TextEncoder().encode(
            JSON.stringify({ runId, generation: 0, jobSeq: 1 }),
          ),
          mediaType: "application/json",
        }),
      );
      const waiting = yield* attempt(runId);
      return { unknown, incomplete, waiting };
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
  expect(refusals.unknown).toContain("is no review request");
  expect(refusals.incomplete).toContain("did not complete");
  expect(refusals.waiting).toContain("review job(s) waiting or running");
});

// Why (27 October): a recompose appends the reviews it redoes as its own generation's records, which
// only a scratch copy may hold; a repository's own store must be refused first, and so must a store
// whose place git cannot answer for. The run asked for is unknown: its refusal would say so.
test("recompose refuses a store in a git directory before it looks up the run, and refuses when git cannot answer", async () => {
  const repository = join(directory, "own");
  Bun.spawnSync(["git", "init", "-q", repository]);
  const location = storeLocationIn(join(repository, ".git"));
  const refusal = await Effect.runPromise(
    Effect.flip(
      recompose({
        location,
        repository,
        runId: "01JUNKNOWNRUN0000000000000",
        allowModel: ["verify"],
      }),
    ).pipe(
      Effect.map((error) => String((error as Error).message)),
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
  expect(refusal).toContain("is in a git directory");
  // A scratch copy outside any git directory is not refused for its place.
  const scratch = join(directory, "scratch", "neuve");
  mkdirSync(scratch, { recursive: true });
  expect(inGitDirectory(scratch)).toBe(false);
  // With no git to ask, the same scratch copy is refused.
  const path = process.env["PATH"];
  process.env["PATH"] = join(directory, "no-git");
  try {
    expect(inGitDirectory(scratch)).toBe(true);
  } finally {
    process.env["PATH"] = path;
  }
});
