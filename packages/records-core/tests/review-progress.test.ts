// Why: the web app's running state and its web events read the newest review job, and a read that
// lists jobs oldest first with a limit returns the oldest once the queue passes it (a store gathered
// 1,374 jobs in one day). These pin newest-first reads past the limit, with other kinds interleaved.
import { afterAll, expect, test } from "bun:test";
import { Effect, Option } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { ReviewProgress } from "../src/index.ts";
import { freshLocation, removeTemporaryDirectories, runOn } from "./support.ts";

afterAll(removeTemporaryDirectories);

const insertJobs = Effect.gen(function* () {
  const sql = yield* SqlClient;
  for (let n = 1; n <= 30; n += 1) {
    yield* sql`INSERT INTO jobs (kind, dedupe_key, state)
      VALUES ('review.run', ${`review.run:${n}`}, ${n % 3 === 0 ? "waiting" : "completed"})`;
    yield* sql`INSERT INTO jobs (kind, dedupe_key, state)
      VALUES ('scope.fetch', ${`scope.fetch:${n}`}, 'waiting')`;
  }
});

test("the newest review job and the newest open ones are read newest first, past any limit", async () => {
  const location = freshLocation();
  const result = await runOn(
    location,
    Effect.gen(function* () {
      yield* insertJobs;
      return {
        newest: yield* ReviewProgress.newestReviewJob,
        open: yield* ReviewProgress.openReviewJobs(2),
        sequence: yield* ReviewProgress.reviewSequence,
      };
    }),
  );
  // Review jobs take the odd sequence numbers 1..59; the 30th is job 59.
  expect(Option.getOrUndefined(result.newest)).toBe(59);
  // Waiting review jobs are every third one: 30th (59) and 27th (53) are the newest two.
  expect(result.open.map((job) => job.seq)).toEqual([59, 53]);
  expect(result.open[0]).toMatchObject({ state: "waiting", attempts: 0 });
  expect(result.sequence).toBe(0);
});

const progressFixture = async () => {
  const { Log, mintUlid } = await import("../src/index.ts");
  const { cycleEvents } = await import("./support.ts");
  const { RecordEvent } = await import("@neuve/records-schema");
  const location = freshLocation();
  const cycle = cycleEvents(1);
  const runId = mintUlid();
  await runOn(location, Log.append(cycle.events));
  const source = RecordEvent.parse(cycle.events[0]);
  const cycleId = source.attribution?.cycleId;
  if (cycleId === undefined) throw new Error("Fixture has no cycle");
  const event = (
    kind: "stage.started@1" | "stage.completed@1",
    stage: string,
    agent: string,
  ) =>
    RecordEvent.parse({
      id: mintUlid(),
      kind,
      idempotencyKey: `${kind}:${agent}`,
      actor: source.actor,
      occurredAt: new Date().toISOString(),
      attribution: {
        cycleId,
        runId,
        stage,
        range: {
          baseRef: "refs/heads/main",
          baseOid: "b".repeat(40),
          headOid: "a".repeat(40),
        },
      },
      payload:
        kind === "stage.started@1"
          ? { agent }
          : {
              stage,
              agent,
              status: "computed",
              wallMs: 10,
              modelCalls: 0,
              usage: {
                input: 0,
                cacheWrite5m: 0,
                cacheWrite1h: 0,
                cacheRead: 0,
                output: 0,
              },
              costUsd: null,
            },
    });
  const stages = [
    "precompute",
    "understand",
    "investigate",
    "assemble",
    "dispose",
    "publish",
  ];
  return { location, runId, event, stages, Log };
};

// Why: the card must advance on a start, and parallel agents' partial completions are not a completed stage.
test("stage starts name live work and completed stages count only after all started agents settle", async () => {
  const { location, runId, event, stages, Log } = await progressFixture();
  await runOn(
    location,
    Log.append([
      event("stage.completed@1", "precompute", "precompute"),
      event("stage.started@1", "understand", "u1"),
      event("stage.started@1", "understand", "u2"),
    ]),
  );
  expect(
    await runOn(location, ReviewProgress.stageProgress(runId, stages)),
  ).toEqual({ name: "understand", done: 1, of: 6 });
  await runOn(
    location,
    Log.append([event("stage.completed@1", "understand", "u1")]),
  );
  expect(
    await runOn(location, ReviewProgress.stageProgress(runId, stages)),
  ).toEqual({ name: "understand", done: 1, of: 6 });
  await runOn(
    location,
    Log.append([event("stage.completed@1", "understand", "u2")]),
  );
  expect(
    await runOn(location, ReviewProgress.stageProgress(runId, stages)),
  ).toEqual({ name: "understand", done: 2, of: 6 });
});

test("later agents cannot reduce the completed-stage count or invent the next stage", async () => {
  const { location, runId, event, stages, Log } = await progressFixture();
  const snapshots = [];
  for (const [kind, agent] of [
    ["stage.started@1", "u1"],
    ["stage.completed@1", "u1"],
    ["stage.started@1", "u2"],
    ["stage.completed@1", "u2"],
  ] as const) {
    await runOn(location, Log.append([event(kind, "understand", agent)]));
    snapshots.push(
      await runOn(location, ReviewProgress.stageProgress(runId, stages)),
    );
  }
  expect(snapshots.map((state) => state?.done)).toEqual([0, 1, 1, 1]);
  expect(snapshots.map((state) => state?.name)).toEqual([
    "understand",
    "understand",
    "understand",
    "understand",
  ]);
});

test("an active job without stage evidence names no stage", async () => {
  const { location, runId, stages } = await progressFixture();
  expect(
    await runOn(location, ReviewProgress.stageProgress(runId, stages)),
  ).toBeNull();
});

// Coverage belongs to Precompute and must not appear as an unknown stage in progress.
test("coverage progress keeps the Precompute stage name", async () => {
  const { location, runId, event, stages, Log } = await progressFixture();
  await runOn(
    location,
    Log.append([event("stage.started@1", "precompute", "precompute.coverage")]),
  );
  expect(
    await runOn(location, ReviewProgress.stageProgress(runId, stages)),
  ).toEqual({ name: "precompute", done: 0, of: 6 });
  await runOn(
    location,
    Log.append([
      event("stage.completed@1", "precompute", "precompute.coverage"),
      event("stage.started@1", "precompute", "precompute"),
    ]),
  );
  expect(
    await runOn(location, ReviewProgress.stageProgress(runId, stages)),
  ).toEqual({ name: "precompute", done: 1, of: 6 });
});
