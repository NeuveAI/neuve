// Why: replay runs over large trees get a longer lifetime while the owner's reviews keep 10 minutes.
// The lifetime comes from a settings file, so a settings file without it must freeze exactly the
// budgets it froze before (the owner's run keys stay put); one with it must reach the frozen run and
// move its cut-off with it; a run with more time must never join a shorter run's key, yet reuse its
// completed stages, the partition plan and so Investigate among them; and the attempt must stop at
// its own run's lifetime, never past the job's bound.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Duration, Effect, Layer, Option } from "effect";
import {
  Blobs,
  Computations,
  JobQueue,
  Log,
  Store,
  storeLocationIn,
} from "@neuve/records-core";
import { PipelineConfig, defaultConfig, runKeyFor } from "../src/config.ts";
import { attemptStop } from "../src/handler.ts";
import { agentStageSpec } from "../src/pipeline.ts";
import { requestReview } from "../src/request.ts";
import { Settings, reviewDeadline } from "../src/settings.ts";

const settings = (review?: unknown) =>
  Option.some(
    Settings.parse({ version: 1, ...(review === undefined ? {} : { review }) }),
  );

const range = {
  baseRef: "main",
  baseOid: "a".repeat(40),
  headOid: "b".repeat(40),
};

const frozen = (review?: unknown) =>
  defaultConfig(
    undefined,
    undefined,
    undefined,
    undefined,
    reviewDeadline(settings(review)),
  );

test("without a deadline setting, the budgets are the 10-minute lifetime and its 9:10 cut-off", () => {
  expect(reviewDeadline(Option.none())).toBeUndefined();
  expect(frozen().budgets).toMatchObject({
    lifetimeMs: 600_000,
    cutoffMs: 550_000,
  });
  expect(runKeyFor(range, frozen({}))).toBe(runKeyFor(range, defaultConfig()));
  // The default named outright is the same run.
  expect(runKeyFor(range, frozen({ deadline: 10 }))).toBe(
    runKeyFor(range, defaultConfig()),
  );
});

test("a longer deadline moves the cut-off with it and is a run of its own", () => {
  const long = frozen({ deadline: 20 });
  expect(long.budgets).toMatchObject({
    lifetimeMs: 1_200_000,
    cutoffMs: 1_150_000,
  });
  expect(runKeyFor(range, long)).not.toBe(runKeyFor(range, defaultConfig()));
});

test("runs of two lifetimes reuse completed Frame steps but keep separate run keys", () => {
  const stageKey = (config: PipelineConfig) =>
    Computations.computationKey(
      agentStageSpec(
        config,
        { stage: "frame", turnLimit: 1, agent: "frame" },
        { op: "harness.frame", opVersion: 1, inputs: { precompute: "p" } },
      ),
    ).key;
  expect(stageKey(frozen({ deadline: 20 }))).toBe(stageKey(defaultConfig()));
  expect(stageKey(defaultConfig({ turnLimit: 5 }))).not.toBe(
    stageKey(defaultConfig()),
  );
});

test("a deadline outside 10 to 30 whole minutes is refused", () => {
  expect(() => settings({ deadline: 9 })).toThrow();
  expect(() => settings({ deadline: 31 })).toThrow();
  expect(() => settings({ deadline: 12.5 })).toThrow();
  expect(() => settings({ deadline: "20" })).toThrow();
  expect(() => settings({ deadline: 30 })).not.toThrow();
});

test("the attempt stops at its own run's lifetime, never past the review job's bound", () => {
  expect(Duration.toMillis(attemptStop(defaultConfig()))).toBe(595_000);
  expect(Duration.toMillis(attemptStop(frozen({ deadline: 20 })))).toBe(
    1_195_000,
  );
  // A frozen request longer than the job allows, such as one hand-written into a log.
  const config = defaultConfig();
  const tooLong = PipelineConfig.parse({
    ...config,
    budgets: { ...config.budgets, lifetimeMs: 3_600_000 },
  });
  expect(Duration.toMillis(attemptStop(tooLong))).toBe(1_795_000);
});

const directory = mkdtempSync(join(tmpdir(), "harness-deadline-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

test("the request freezes the deadline it is given into the logged configuration", async () => {
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
  const logged = await Effect.runPromise(
    Effect.gen(function* () {
      yield* Store.prepareForWrite;
      const request = yield* requestReview({
        location,
        repository,
        range: "HEAD~1..HEAD",
        requester: { _tag: "Unresolved" },
        search: {},
        stack: undefined,
        deadline: Duration.minutes(20),
      });
      const [event] = yield* Log.history({
        kind: "review.requested@1",
        limit: 1,
      });
      return { request, event };
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
  expect(logged.request.config.budgets.lifetimeMs).toBe(1_200_000);
  const payload =
    logged.event?.event.kind === "review.requested@1"
      ? logged.event.event.payload
      : undefined;
  expect(PipelineConfig.parse(payload?.pipeline.config).budgets).toMatchObject({
    lifetimeMs: 1_200_000,
    cutoffMs: 1_150_000,
  });
  expect(payload?.runKey).toBe(logged.request.runKey);
});

// Why: internal deadline fixtures shorter than the publication reserve still need valid budgets.
test("a short internal lifetime keeps a valid cut-off and its original handler deadline", () => {
  const config = defaultConfig(
    undefined,
    undefined,
    undefined,
    undefined,
    Duration.millis(15_050),
  );
  expect(PipelineConfig.parse(config).budgets.cutoffMs).toBe(1);
  expect(Duration.toMillis(attemptStop(config))).toBe(10_050);
});
