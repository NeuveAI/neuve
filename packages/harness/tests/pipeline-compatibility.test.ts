// Why: a new scheduler must not reinterpret queued/interrupted legacy work or permit the old
// readings-off setting to bypass its only reviewer. The guard is exercised through real Records
// admission/readback and the handler, not just an isolated version-number assertion.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  defaultConfig,
  runSpec,
} from "../src/config.ts";
import { reviewRunHandler, sweepEndedRuns } from "../src/handler.ts";
import { prepareReviewConfig, readingsConfig } from "../src/request.ts";
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
