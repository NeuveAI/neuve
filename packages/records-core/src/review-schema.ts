import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

/**
 * Migration 7: projections for M3's event versions (proposal §10.2, PU5). Columns the new versions
 * add to units, comments, dispositions and context references, and one row per delivery content,
 * packet, disclosed gap, stage and run. Every column a version 1 event cannot set stays null (or 0
 * for counts), so old and new events project side by side. The projector version rises with this
 * migration, and migrate rebuilds every projection from the log.
 */
const statements = [
  // Unit grouping (10.70) and the assessment's axes and validation gap (10.55, 10.57).
  `ALTER TABLE projection_units ADD COLUMN grouping_gap_lines INTEGER`,
  `ALTER TABLE projection_units ADD COLUMN grouping_adjustment TEXT`,
  `ALTER TABLE projection_units ADD COLUMN quadrant TEXT`,
  `ALTER TABLE projection_units ADD COLUMN complexity TEXT`,
  `ALTER TABLE projection_units ADD COLUMN validation_gap INTEGER`,
  // A finding's kind and what it is about (10.63, 10.69).
  `ALTER TABLE projection_comments ADD COLUMN finding_kind TEXT`,
  `ALTER TABLE projection_comments ADD COLUMN finding_about TEXT`,
  `ALTER TABLE projection_comments ADD COLUMN finding_signal TEXT`,
  // How many comments a disposition rests on and how many proof records it names (10.62, 10.69);
  // null for version 1, which can name neither.
  `ALTER TABLE projection_dispositions ADD COLUMN rests_on_count INTEGER`,
  `ALTER TABLE projection_dispositions ADD COLUMN proof_count INTEGER`,
  // Stance and origin from 0006's contract.
  `ALTER TABLE projection_context_references ADD COLUMN stance TEXT`,
  `ALTER TABLE projection_context_references ADD COLUMN origin TEXT`,
  `CREATE TABLE projection_deliveries (
    event_id TEXT PRIMARY KEY, cycle_id TEXT NOT NULL, batch_id TEXT NOT NULL, unit_id TEXT,
    content TEXT NOT NULL, verdict_words INTEGER
  ) WITHOUT ROWID`,
  `CREATE TABLE projection_packets (
    event_id TEXT PRIMARY KEY, cycle_id TEXT NOT NULL, run_id TEXT NOT NULL, complete INTEGER NOT NULL,
    units INTEGER NOT NULL, gaps INTEGER NOT NULL
  ) WITHOUT ROWID`,
  `CREATE TABLE projection_gaps (
    event_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, cycle_id TEXT NOT NULL, stage TEXT,
    kind TEXT NOT NULL, unit_count INTEGER NOT NULL
  ) WITHOUT ROWID`,
  `CREATE INDEX projection_gaps_kind ON projection_gaps (kind)`,
  // Costs as integer micro-USD, so checksums never depend on floating-point formatting.
  `CREATE TABLE projection_stages (
    event_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, cycle_id TEXT NOT NULL, stage TEXT NOT NULL,
    agent TEXT NOT NULL, batch_id TEXT, status TEXT NOT NULL, wall_ms INTEGER NOT NULL,
    expected_ms INTEGER, model_calls INTEGER NOT NULL, tokens_input INTEGER NOT NULL,
    tokens_cache_write INTEGER NOT NULL, tokens_cache_read INTEGER NOT NULL,
    tokens_output INTEGER NOT NULL, cost_micro_usd INTEGER NOT NULL, turns_used INTEGER,
    turn_limit INTEGER, final_generation INTEGER, ended_by TEXT
  ) WITHOUT ROWID`,
  `CREATE INDEX projection_stages_run ON projection_stages (run_id)`,
  // Which review request enqueued a run's job, for neuve review show (an index only; the queue's
  // columns are unchanged).
  `CREATE INDEX jobs_event ON jobs (event_id)`,
  // One row per run, from its earliest receipt by ULID. Its stages and gaps are counted from
  // projection_stages and projection_gaps, which hold every one the run recorded.
  `CREATE TABLE projection_runs (
    run_id TEXT PRIMARY KEY, cycle_id TEXT NOT NULL, event_id TEXT NOT NULL, outcome TEXT NOT NULL,
    ended_at TEXT NOT NULL, wall_ms INTEGER NOT NULL, queue_wait_ms INTEGER NOT NULL,
    model_calls INTEGER NOT NULL, retries INTEGER NOT NULL, cost_micro_usd INTEGER NOT NULL,
    tokens_input INTEGER NOT NULL, tokens_output INTEGER NOT NULL,
    unit_count_10 INTEGER, unit_count_20 INTEGER, unit_count_40 INTEGER
  ) WITHOUT ROWID`,
];

/**
 * Migration 9: a stage's and a run's cost may be unknown (10.85: the ChatGPT plan has no per-token
 * price), so `cost_micro_usd` becomes nullable. Both tables are projections: they are recreated
 * empty, and the projector version rises with this migration, so migrate rebuilds them from the log.
 */
const unknownCostStatements = [
  `DROP TABLE projection_stages`,
  `CREATE TABLE projection_stages (
    event_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, cycle_id TEXT NOT NULL, stage TEXT NOT NULL,
    agent TEXT NOT NULL, batch_id TEXT, status TEXT NOT NULL, wall_ms INTEGER NOT NULL,
    expected_ms INTEGER, model_calls INTEGER NOT NULL, tokens_input INTEGER NOT NULL,
    tokens_cache_write INTEGER NOT NULL, tokens_cache_read INTEGER NOT NULL,
    tokens_output INTEGER NOT NULL, cost_micro_usd INTEGER, turns_used INTEGER,
    turn_limit INTEGER, final_generation INTEGER, ended_by TEXT
  ) WITHOUT ROWID`,
  `CREATE INDEX projection_stages_run ON projection_stages (run_id)`,
  `DROP TABLE projection_runs`,
  `CREATE TABLE projection_runs (
    run_id TEXT PRIMARY KEY, cycle_id TEXT NOT NULL, event_id TEXT NOT NULL, outcome TEXT NOT NULL,
    ended_at TEXT NOT NULL, wall_ms INTEGER NOT NULL, queue_wait_ms INTEGER NOT NULL,
    model_calls INTEGER NOT NULL, retries INTEGER NOT NULL, cost_micro_usd INTEGER,
    tokens_input INTEGER NOT NULL, tokens_output INTEGER NOT NULL,
    unit_count_10 INTEGER, unit_count_20 INTEGER, unit_count_40 INTEGER
  ) WITHOUT ROWID`,
];

export const unknownCostMigration = Effect.gen(function* () {
  const sql = yield* SqlClient;
  for (const statement of unknownCostStatements) yield* sql.unsafe(statement);
});

export const reviewProjectionMigration = Effect.gen(function* () {
  const sql = yield* SqlClient;
  for (const statement of statements) yield* sql.unsafe(statement);
});
