import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

/**
 * Migration 3: the dial-2 job queue (8.12) and the worker's claim (8.2). SQLite cannot change a
 * CHECK constraint in place, so `jobs` is rebuilt: S1's states map to the dial-2 ones, and the new
 * columns get defaults, so the append transaction's insert of (kind, dedupe_key, event_id) is
 * unchanged. Timestamps are ISO-8601 UTC text, as `Date.prototype.toISOString` writes them, so they
 * order as text.
 */
const statements = [
  `CREATE TABLE jobs_next (
    job_seq INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    dedupe_key TEXT NOT NULL UNIQUE,
    event_id TEXT REFERENCES events (id),
    payload TEXT,
    state TEXT NOT NULL DEFAULT 'waiting'
      CHECK (state IN ('waiting', 'delayed', 'active', 'completed', 'failed')),
    run_at TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    stalls INTEGER NOT NULL DEFAULT 0,
    enqueued_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    started_at TEXT,
    finished_at TEXT,
    last_error TEXT
  )`,
  // A queued job with `not_before` keeps its delay as a delayed job. S1 kept no cause, so a failed
  // job gets one saying so: the failed state always carries its cause (8.12).
  `INSERT INTO jobs_next (job_seq, kind, dedupe_key, event_id, state, run_at, attempts, enqueued_at,
      last_error)
    SELECT j.job_seq, j.kind, j.dedupe_key, j.event_id,
      CASE j.state
        WHEN 'queued' THEN CASE WHEN j.not_before IS NULL THEN 'waiting' ELSE 'delayed' END
        WHEN 'running' THEN 'active' WHEN 'succeeded' THEN 'completed' ELSE 'failed' END,
      CASE WHEN j.state = 'queued' THEN j.not_before END,
      j.attempts, e.recorded_at,
      CASE WHEN j.state NOT IN ('queued', 'running', 'succeeded') THEN json_object(
        'tag', 'Migrated', 'message', 'failed before the job queue kept causes',
        'attempt', j.attempts, 'at', e.recorded_at) END
    FROM jobs j JOIN events e ON e.id = j.event_id`,
  `DROP TABLE jobs`,
  `ALTER TABLE jobs_next RENAME TO jobs`,
  `CREATE INDEX jobs_due ON jobs (state, run_at, job_seq)`,
  // The live worker's claim, written under the write lock that serializes starters (8.2). The OS
  // socket is the claim; this row only says which process bound it, for status and stop.
  `CREATE TABLE worker_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    pid INTEGER NOT NULL,
    socket TEXT NOT NULL,
    started_at TEXT NOT NULL,
    last_progress_at TEXT NOT NULL,
    last_progress TEXT NOT NULL
  )`,
];

export const jobQueueMigration = Effect.gen(function* () {
  const sql = yield* SqlClient;
  for (const statement of statements) yield* sql.unsafe(statement);
});
