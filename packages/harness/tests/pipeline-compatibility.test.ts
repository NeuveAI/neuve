// Why: a new scheduler must not reinterpret queued/interrupted legacy work or permit the old
// readings-off setting to bypass its only reviewer. The guard is exercised through real Records
// admission/readback and the handler, not just an isolated version-number assertion.
import { afterAll, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Cause, Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import {
  Blobs,
  Computations,
  JobQueue,
  JOB_POLICIES,
  Log,
  ReviewFollowOn,
  Store,
  Worker,
  mintUlid,
  storeLocationIn,
} from "@neuve/records-core";
import {
  PIPELINE_VERSION,
  PipelineConfig,
  REVIEW_OWNERSHIP,
  currentPipelineProblem,
  runKeyFor,
  defaultConfig,
  runSpec,
} from "../src/config.ts";
import { reviewRunHandler, sweepEndedRuns } from "../src/handler.ts";
import {
  prepareReviewConfig,
  readingsConfig,
  requestReview,
} from "../src/request.ts";
import { recompose } from "../src/recompose.ts";
import { ensureRunFolder, runFolder } from "../src/run-folder.ts";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Settings, reviewResponsibilitySections } from "../src/settings.ts";

const root = mkdtempSync(join(tmpdir(), "owned-review-compat-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const legacy = () => {
  const {
    ownership: _ownership,
    readings: _readings,
    sections: _sections,
    ...config
  } = defaultConfig();
  return config;
};

test("new default/admission cannot disable comprehensive review; historical JSON still parses unchanged", async () => {
  const config = defaultConfig();
  expect(config.ownership).toBe(REVIEW_OWNERSHIP);
  expect(currentPipelineProblem(PIPELINE_VERSION, config)).toBeUndefined();
  const old = legacy();
  expect(PipelineConfig.parse(old)).toEqual(old);
  expect(currentPipelineProblem(12, old)).toContain("compatible build");
  expect(currentPipelineProblem(PIPELINE_VERSION, old)).toContain(
    "cannot execute",
  );
  const settings = Option.some(
    Settings.parse({
      version: 1,
      review: {
        sectionReadings: "off",
        responsibilitySections: false,
        sectionReadingsScopeAndTests: false,
      },
    }),
  );
  expect(readingsConfig(settings).scopeAndTests).toBe(true);
  expect(reviewResponsibilitySections(settings)).toBe(true);
  const prepared = await Effect.runPromise(
    prepareReviewConfig({
      location: storeLocationIn(join(root, "config")),
      search: {},
      stack: undefined,
      sections: undefined,
      readings: undefined,
    }),
  );
  expect(currentPipelineProblem(PIPELINE_VERSION, prepared)).toBeUndefined();
  expect(prepared.readings?.scopeAndTests).toBe(true);
  expect(prepared.budgets.turnLimits.find).toBeUndefined();
  const spec = runSpec(
    { baseRef: "main", baseOid: "a".repeat(40), headOid: "b".repeat(40) },
    prepared,
  );
  expect(spec.opVersion).toBe(13);
  expect(spec.config).toMatchObject({ ownership: REVIEW_OWNERSHIP });
});

test("legacy queued/resumed requests and follow-ons refuse before native execution, while frozen state stays unchanged", async () => {
  const location = storeLocationIn(join(root, "state"));
  const runId = mintUlid();
  const cycleId = mintUlid();
  const folder = runFolder(location, runId);
  mkdirSync(folder, { recursive: true });
  const sentinel = join(folder, "pi.sqlite");
  await (await openNodeSqliteStorage(sentinel)).close(context);
  const originalNative = readFileSync(sentinel);
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      yield* Store.prepareForWrite;
      const frozen = { version: 12, config: legacy() };
      yield* Log.append([
        {
          id: runId,
          kind: "review.requested@1",
          actor: "a".repeat(64),
          occurredAt: new Date().toISOString(),
          idempotencyKey: `review.requested:${runId}`,
          attribution: {
            cycleId,
            range: {
              baseRef: "main",
              baseOid: "a".repeat(40),
              headOid: "b".repeat(40),
            },
          },
          payload: { generation: 0, runKey: "c".repeat(64), pipeline: frozen },
        },
      ]);
      const queue = yield* JobQueue.JobQueue;
      const job = Option.getOrThrow(yield* queue.take(["review.run@2"]));
      const follow = yield* ReviewFollowOn.requestFollowOn({
        requestId: runId,
        cap: 8,
      });
      yield* ensureRunFolder(location, {
        runId,
        runKey: "c".repeat(64),
        pipelineVersion: 12,
        range: {
          baseRef: "main",
          baseOid: "a".repeat(40),
          headOid: "b".repeat(40),
        },
        jobSeq: job.seq,
      });
      const failure = yield* Effect.exit(
        reviewRunHandler({ location, repository: join(root, "no-repository") })(
          job,
        ),
      );
      if (failure._tag === "Failure")
        yield* queue.fail(
          job.seq,
          job.attempts,
          Worker.describeFailure(failure.cause, JOB_POLICIES[job.kind]),
        );
      const sql = yield* SqlClient;
      const rows = yield* sql<{
        envelope: string;
      }>`SELECT envelope FROM events WHERE kind='review.requested@1' ORDER BY seq`;
      const before = yield* sql<{
        n: number;
      }>`SELECT count(*) AS n FROM events`;
      const recomposed = yield* Effect.result(
        recompose({ location, repository: root, runId, allowModel: [] }),
      );
      const after = yield* sql<{ n: number }>`SELECT count(*) AS n FROM events`;
      return {
        follow,
        failure,
        rows: rows.map((row) => JSON.parse(row.envelope)),
        recomposed,
        before,
        after,
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
  expect(result.failure._tag).toBe("Failure");
  if (result.failure._tag === "Failure")
    expect(
      Option.getOrThrow(Cause.findErrorOption(result.failure.cause)),
    ).toMatchObject({ _tag: "UnsupportedReviewPipeline", retryable: false });
  // A new worker/store connection runs this sweep before its next v13 review opens. The typed
  // serialized refusal must not turn preserved native state into an ended-run deletion.
  const swept = await Effect.runPromise(
    sweepEndedRuns(location).pipe(
      Effect.provide(JobQueue.layer),
      Effect.provide(Blobs.layer(location)),
      Effect.provide(Store.layer(location, { create: false })),
      Effect.provide(BunFileSystem.layer),
    ),
  );
  expect(swept).toEqual([]);
  expect(result.rows).toHaveLength(2);
  expect(result.rows[1].payload.pipeline).toEqual(
    result.rows[0].payload.pipeline,
  );
  expect(result.rows[1].payload.runKey).toBe(result.rows[0].payload.runKey);
  expect(result.rows[1].payload.generation).toBe(1);
  expect(readFileSync(sentinel)).toEqual(originalNative);
  expect(result.recomposed._tag).toBe("Failure");
  expect(result.after).toEqual(result.before);
});

test("new public requests remain admitted after parsing and ignore obsolete finder-only controls", async () => {
  const repository = join(root, "current-request-repo");
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", "-C", repository, ...args], {
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  };
  mkdirSync(repository);
  git("init", "-q");
  for (const text of ["before", "after"]) {
    writeFileSync(join(repository, "file.txt"), text);
    git("add", "file.txt");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-qm",
      text,
    );
  }
  const location = storeLocationIn(join(root, "current-request-store"));
  const base = defaultConfig();
  const controls = { ...base.route, stepEffort: { find: "high" as const } };
  expect(
    runKeyFor(
      { baseRef: "main", baseOid: "a".repeat(40), headOid: "b".repeat(40) },
      defaultConfig({ hold: { stage: "find", seconds: 1 } }, controls),
    ),
  ).toBe(
    runKeyFor(
      { baseRef: "main", baseOid: "a".repeat(40), headOid: "b".repeat(40) },
      base,
    ),
  );
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      yield* Store.prepareForWrite;
      const options = {
        location,
        repository,
        range: "HEAD~1..HEAD",
        requester: { _tag: "Unresolved" as const },
        route: base.route,
        search: {},
        stack: undefined,
        deadline: undefined,
      };
      const first = yield* requestReview(options);
      const repeated = yield* requestReview({
        ...options,
        route: controls,
        stub: { hold: { stage: "find", seconds: 1 } },
      });
      const parsed = PipelineConfig.parse(first.config);
      const bad = [
        {
          ...parsed,
          budgets: {
            ...parsed.budgets,
            turnLimits: { ...parsed.budgets.turnLimits, find: 11 },
          },
        },
        { ...parsed, route: controls },
        { ...parsed, stub: { hold: { stage: "find" as const, seconds: 1 } } },
      ];
      const sql = yield* SqlClient;
      const count = () =>
        sql<{
          n: number;
        }>`SELECT count(*) AS n FROM events WHERE kind='review.requested@1'`;
      const before = yield* count();
      for (const frozenConfig of bad) {
        const snapshot = JSON.stringify(frozenConfig);
        expect(currentPipelineProblem(13, frozenConfig)).toContain(
          "retired finder-only",
        );
        const refused = yield* Effect.result(
          requestReview({ ...options, frozenConfig }),
        );
        expect(refused._tag).toBe("Failure");
        expect(JSON.stringify(frozenConfig)).toBe(snapshot);
      }
      return { first, repeated, parsed, before, after: yield* count() };
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
  expect(result.repeated.dedupeKey).toBe(result.first.dedupeKey);
  expect(result.parsed).toEqual(result.first.config);
  expect(currentPipelineProblem(13, result.parsed)).toBeUndefined();
  expect(Object.hasOwn(result.parsed.budgets.turnLimits, "find")).toBe(false);
  expect(result.repeated.config.route).toEqual(base.route);
  expect(result.repeated.config.stub).toBeUndefined();
  expect(result.after).toEqual(result.before);
});

test("preparation deadline names the shared existing bound rather than a second finder budget", async () => {
  const { preparationDeadline, findDeadline } =
    await import("../src/budget.ts");
  expect(findDeadline).toBe(preparationDeadline);
  expect(preparationDeadline(1_000, 1_000_000)).toBe(271_000);
  expect(preparationDeadline(1_000, 100_000)).toBe(25_000);
});
