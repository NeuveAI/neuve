// Why: migration 9 (10.85) recreates the stage and run projections so a run's cost can be null,
// unknown, on the ChatGPT plan. A store that already holds receipts must come through it with every
// receipt still projected, its cost kept, and its minimum writer raised, so an older CLI cannot
// write receipts it cannot read; only a real store at the previous version shows that.
import { afterAll, expect, test } from "bun:test";
import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { Log, MIN_WRITER_VERSION, Store, mintUlid } from "../src/index.ts";
import { receipt, reviewEvents } from "./review-fixtures.ts";
import {
  agent,
  envelope,
  freshLocation,
  removeTemporaryDirectories,
  runExisting,
  runOn,
} from "./support.ts";

afterAll(removeTemporaryDirectories);

const exec = (statement: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    return yield* sql.unsafe<Record<string, unknown>>(statement);
  });

/** The two tables as migration 7 created them, before costs could be unknown. */
const BEFORE_9 = [
  `DROP TABLE projection_stages`,
  `CREATE TABLE projection_stages (
    event_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, cycle_id TEXT NOT NULL, stage TEXT NOT NULL,
    agent TEXT NOT NULL, batch_id TEXT, status TEXT NOT NULL, wall_ms INTEGER NOT NULL,
    expected_ms INTEGER, model_calls INTEGER NOT NULL, tokens_input INTEGER NOT NULL,
    tokens_cache_write INTEGER NOT NULL, tokens_cache_read INTEGER NOT NULL,
    tokens_output INTEGER NOT NULL, cost_micro_usd INTEGER NOT NULL, turns_used INTEGER,
    turn_limit INTEGER, final_generation INTEGER, ended_by TEXT
  ) WITHOUT ROWID`,
  `CREATE INDEX projection_stages_run ON projection_stages (run_id)`,
  `DROP TABLE projection_runs`,
  `CREATE TABLE projection_runs (
    run_id TEXT PRIMARY KEY, cycle_id TEXT NOT NULL, event_id TEXT NOT NULL, outcome TEXT NOT NULL,
    ended_at TEXT NOT NULL, wall_ms INTEGER NOT NULL, queue_wait_ms INTEGER NOT NULL,
    model_calls INTEGER NOT NULL, retries INTEGER NOT NULL, cost_micro_usd INTEGER NOT NULL,
    tokens_input INTEGER NOT NULL, tokens_output INTEGER NOT NULL,
    unit_count_10 INTEGER, unit_count_20 INTEGER, unit_count_40 INTEGER
  ) WITHOUT ROWID`,
  // Later projections, which a store at migration 8 does not have yet.
  `DROP TABLE projection_feedback`,
  `DROP TABLE projection_review_origins`,
  `DELETE FROM records_migrations WHERE migration_id >= 9`,
  `UPDATE records_meta SET value = 7 WHERE key IN ('projector_version', 'min_writer_version')`,
  `DELETE FROM records_meta WHERE key = 'projections_version'`,
];

test("migration 9 over a store holding receipts keeps them, raises the writer, and admits unknown costs", async () => {
  const location = freshLocation();
  const fixture = reviewEvents();
  const events = fixture.all as ReadonlyArray<Record<string, unknown>>;
  await runOn(location, Log.append(fixture.all));
  const costs = () =>
    runExisting(
      location,
      Effect.all([
        exec(
          `SELECT run_id AS run, cost_micro_usd AS cost FROM projection_runs ORDER BY run_id`,
        ),
        exec(
          `SELECT count(*) AS n, sum(cost_micro_usd) AS total FROM projection_stages`,
        ),
      ]),
    );
  const projected = await costs();
  expect(projected[0].length).toBe(1);
  expect(projected[0][0]?.["cost"]).toBe(12_300);

  // The store as the previous build left it: projections without nullable costs, version 8.
  for (const statement of BEFORE_9)
    await runExisting(location, exec(statement));
  await runExisting(location, exec(`DELETE FROM projection_runs`));

  expect(await runExisting(location, Store.migrate)).toEqual({
    applied: [
      "9_unknown_costs",
      "10_stack_jobs",
      "11_feedback",
      "12_feedback_rubric",
      "13_checkpoint_anchors",
      "14_hybrid_job",
      "15_review_origins",
      "16_project_review_origins",
      "17_capture_lookup_indexes",
      "18_computation_operation_index",
      "19_worker_lock_and_job_notices",
      "20_evictable_outputs",
      "21_raw_capture_parts",
    ],
    rebuilt: true,
  });
  expect(await costs()).toEqual(projected);
  const writer = await runExisting(
    location,
    exec(`SELECT value FROM records_meta WHERE key = 'min_writer_version'`),
  );
  expect(writer[0]?.["value"]).toBe(MIN_WRITER_VERSION);

  // A receipt of the OpenAI route: the sign-in named, and no USD cost.
  const completed = events.find((e) => e["kind"] === "run.completed@1")!;
  const attribution = completed["attribution"] as Record<string, unknown>;
  const runId = mintUlid();
  const base = receipt("e".repeat(64), 1);
  const { credentialVariable: _key, ...route } = base.route;
  await runExisting(
    location,
    Log.append([
      envelope(
        "run.completed@1",
        `review:${runId}:run.completed`,
        agent,
        { ...attribution, runId },
        {
          ...base,
          route: { ...route, credentialSource: "neuve-sign-in", price: {} },
          stages: base.stages.map((stage) => ({ ...stage, costUsd: null })),
          totals: { ...base.totals, costUsd: null },
        },
      ),
    ] as never),
  );
  const unknown = await runExisting(
    location,
    exec(
      `SELECT cost_micro_usd AS cost FROM projection_runs WHERE run_id = '${runId}'`,
    ),
  );
  expect(unknown).toEqual([{ cost: null }]);
});
