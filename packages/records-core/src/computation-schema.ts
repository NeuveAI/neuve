import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

/**
 * Migration 4: the computation store (M2 S5, proposal §3). Blobs are content-addressed by sha256;
 * a blob up to `INLINE_MAX_BYTES` keeps its bytes in `content`, a larger one in a file under
 * `<store>/blobs/` (D11). A pruned raw capture keeps its row, without bytes, as its tombstone.
 * Computations are keyed by the hash of their inputs (D9) and bind the output of their first
 * successful attempt permanently, so the table is append-only; every attempt is kept (D12), and a
 * finished attempt never changes. Actor activity gains the token totals of `turn.summarized`; the
 * projector version rises with this migration, so migrate rebuilds it.
 */
const statements = [
  // `content` is the last column, so reading metadata never touches a large blob's overflow pages.
  `CREATE TABLE blobs (
    hash TEXT PRIMARY KEY,
    size INTEGER NOT NULL CHECK (size >= 0),
    media_type TEXT NOT NULL,
    retention TEXT NOT NULL CHECK (retention IN ('durable', 'raw-capture')),
    placement TEXT NOT NULL CHECK (placement IN ('inline', 'file')),
    captured_at TEXT NOT NULL,
    pruned_at TEXT,
    content BLOB,
    CHECK (placement = 'inline' OR content IS NULL),
    CHECK (pruned_at IS NULL OR content IS NULL),
    CHECK (pruned_at IS NULL OR retention = 'raw-capture')
  )`,
  `CREATE INDEX blobs_retention ON blobs (retention, captured_at) WHERE pruned_at IS NULL`,
  `CREATE TRIGGER blobs_no_delete BEFORE DELETE ON blobs BEGIN SELECT RAISE(ABORT, 'blobs keep their row; pruning sets pruned_at'); END`,
  // A blob's identity never changes, and durable bytes never become prunable. Bytes come and go only
  // with the tombstone: pruning clears them, and a new capture of pruned bytes restores them with a
  // new capture time. The only other change is a raw capture becoming durable.
  `CREATE TRIGGER blobs_guarded_update BEFORE UPDATE ON blobs
    WHEN NEW.hash IS NOT OLD.hash OR NEW.size IS NOT OLD.size OR NEW.media_type IS NOT OLD.media_type
      OR NEW.placement IS NOT OLD.placement
      OR (OLD.retention = 'durable' AND NEW.retention <> 'durable')
      OR (NEW.pruned_at IS OLD.pruned_at AND (NEW.content IS NOT OLD.content OR NEW.captured_at IS NOT OLD.captured_at))
      OR (NEW.pruned_at IS NOT NULL AND OLD.pruned_at IS NOT NULL)
      OR (NEW.pruned_at IS NOT NULL AND (NEW.captured_at IS NOT OLD.captured_at OR NEW.retention IS NOT OLD.retention))
    BEGIN SELECT RAISE(ABORT, 'a blob changes only by pruning, restoring, or becoming durable'); END`,
  `CREATE TABLE computation_attempts (
    attempt_id TEXT PRIMARY KEY,
    key TEXT NOT NULL,
    n INTEGER NOT NULL CHECK (n >= 1),
    op TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    outcome TEXT NOT NULL CHECK (outcome IN ('running', 'succeeded', 'failed', 'abandoned')),
    error_tag TEXT,
    error_message TEXT,
    cause_blob TEXT REFERENCES blobs (hash),
    output_hash TEXT REFERENCES blobs (hash),
    usage TEXT,
    model TEXT,
    UNIQUE (key, n)
  )`,
  `CREATE INDEX computation_attempts_running ON computation_attempts (outcome) WHERE outcome = 'running'`,
  `CREATE TRIGGER computation_attempts_finished BEFORE UPDATE ON computation_attempts
    WHEN OLD.outcome <> 'running' BEGIN SELECT RAISE(ABORT, 'a finished attempt never changes'); END`,
  `CREATE TRIGGER computation_attempts_identity BEFORE UPDATE ON computation_attempts
    WHEN NEW.attempt_id IS NOT OLD.attempt_id OR NEW.key IS NOT OLD.key OR NEW.n IS NOT OLD.n
      OR NEW.op IS NOT OLD.op OR NEW.started_at IS NOT OLD.started_at
    BEGIN SELECT RAISE(ABORT, 'an attempt keeps its key, number, operation and start'); END`,
  `CREATE TRIGGER computation_attempts_no_delete BEFORE DELETE ON computation_attempts
    BEGIN SELECT RAISE(ABORT, 'computation_attempts is append-only'); END`,
  `CREATE TABLE computations (
    key TEXT PRIMARY KEY,
    op TEXT NOT NULL,
    op_version INTEGER NOT NULL CHECK (op_version >= 1),
    material TEXT NOT NULL,
    output_hash TEXT NOT NULL REFERENCES blobs (hash),
    attempt_id TEXT NOT NULL UNIQUE REFERENCES computation_attempts (attempt_id),
    completed_at TEXT NOT NULL
  )`,
  `CREATE TRIGGER computations_append_only_update BEFORE UPDATE ON computations BEGIN SELECT RAISE(ABORT, 'computations is append-only'); END`,
  `CREATE TRIGGER computations_append_only_delete BEFORE DELETE ON computations BEGIN SELECT RAISE(ABORT, 'computations is append-only'); END`,
  ...[
    "summaries",
    "tokens_input",
    "tokens_cache_creation",
    "tokens_cache_read",
    "tokens_output",
    "api_calls",
    "tool_calls",
  ].map(
    (column) =>
      `ALTER TABLE projection_actor_activity ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`,
  ),
];

export const computationStoreMigration = Effect.gen(function* () {
  const sql = yield* SqlClient;
  for (const statement of statements) yield* sql.unsafe(statement);
});

/**
 * Whether an event names `<prefix><id>` anywhere in its envelope. Events keep their references in
 * the envelope's `refs` (`computation:<key>`, `blob:<hash>`), and no table or index holds them, so
 * the store finds them by scanning the log. Matching the whole envelope, not only `refs`, is never
 * weaker: an event that names the identity anywhere keeps it.
 */
export const eventNames = (prefix: "computation:" | "blob:", id: string) =>
  `EXISTS (SELECT 1 FROM events WHERE instr(envelope, '${prefix}' || ${id}) > 0)`;

/**
 * Migration 20: outputs of a kind its producer declares recomputable may be evicted under a byte
 * cap for that kind (design `records-evictable-outputs`). Additive: two tables, three lookup
 * indexes, and the three "never delete" triggers replaced by conditional ones in the same
 * transaction. A build that does not know it never deletes, so the triggers allow it nothing new.
 *
 * A delete is allowed only in the order eviction runs: the computation row first (it names its
 * attempt), then the key's attempts, then the blob, which must already be marked in
 * `blob_removals`. Every condition is checked here, so raw SQL is refused as the code is:
 * - the kind is declared recomputable in `computation_kinds`;
 * - no attempt of the key holds a model or usage (decision 12.45);
 * - no event names `computation:<key>` (see `eventNames`);
 * - an attempt goes only once its key has no computation row, and never while running;
 * - a blob goes only when marked for removal, durable and unpruned, named by no computation or
 *   attempt, and by no event as `blob:<hash>`. It can be marked only while it is the output of a
 *   declared kind, and a mark is never changed.
 * A blob row inserted again cancels its pending removal, so its new bytes are never removed.
 */
const evictableStatements = [
  `CREATE TABLE IF NOT EXISTS computation_kinds (
    op TEXT PRIMARY KEY,
    recomputable INTEGER NOT NULL CHECK (recomputable IN (0, 1)),
    cap_bytes INTEGER NOT NULL CHECK (cap_bytes >= 0),
    declared_at TEXT NOT NULL
  ) WITHOUT ROWID`,
  // A blob whose row an eviction deleted, until its file is removed after the commit.
  `CREATE TABLE IF NOT EXISTS blob_removals (hash TEXT PRIMARY KEY, at TEXT NOT NULL) WITHOUT ROWID`,
  `CREATE INDEX IF NOT EXISTS computations_output ON computations (output_hash)`,
  `CREATE INDEX IF NOT EXISTS computation_attempts_output ON computation_attempts (output_hash) WHERE output_hash IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS computation_attempts_cause ON computation_attempts (cause_blob) WHERE cause_blob IS NOT NULL`,
  `DROP TRIGGER IF EXISTS computations_append_only_delete`,
  `DROP TRIGGER IF EXISTS computation_attempts_no_delete`,
  `DROP TRIGGER IF EXISTS blobs_no_delete`,
  // Each body raises at the first condition that fails, cheapest first.
  `CREATE TRIGGER IF NOT EXISTS computations_evict_only BEFORE DELETE ON computations BEGIN
    SELECT RAISE(ABORT, 'not evictable: computations is append-only except for outputs of a kind declared recomputable')
      WHERE NOT EXISTS (SELECT 1 FROM computation_kinds WHERE op = OLD.op AND recomputable = 1);
    SELECT RAISE(ABORT, 'not evictable: a model produced this computation, so it is permanent')
      WHERE EXISTS (SELECT 1 FROM computation_attempts WHERE key = OLD.key AND (model IS NOT NULL OR usage IS NOT NULL));
    SELECT RAISE(ABORT, 'not evictable: an event names this computation, so it is permanent')
      WHERE ${eventNames("computation:", "OLD.key")};
  END`,
  `CREATE TRIGGER IF NOT EXISTS computation_attempts_evict_only BEFORE DELETE ON computation_attempts BEGIN
    SELECT RAISE(ABORT, 'not evictable: computation_attempts is append-only except for attempts of a kind declared recomputable')
      WHERE NOT EXISTS (SELECT 1 FROM computation_kinds WHERE op = OLD.op AND recomputable = 1);
    SELECT RAISE(ABORT, 'not evictable: a running attempt is never deleted')
      WHERE OLD.outcome = 'running';
    SELECT RAISE(ABORT, 'not evictable: an attempt is deleted only after its computation')
      WHERE EXISTS (SELECT 1 FROM computations WHERE key = OLD.key);
    SELECT RAISE(ABORT, 'not evictable: a model produced this attempt, so it is permanent')
      WHERE OLD.model IS NOT NULL OR OLD.usage IS NOT NULL;
    SELECT RAISE(ABORT, 'not evictable: an event names this computation, so it is permanent')
      WHERE ${eventNames("computation:", "OLD.key")};
  END`,
  `CREATE TRIGGER IF NOT EXISTS blobs_evict_only BEFORE DELETE ON blobs BEGIN
    SELECT RAISE(ABORT, 'blobs keep their row; pruning sets pruned_at, and only an evicted output''s blob marked for removal is deleted')
      WHERE NOT EXISTS (SELECT 1 FROM blob_removals WHERE hash = OLD.hash);
    SELECT RAISE(ABORT, 'not evictable: only a durable, unpruned blob is deleted')
      WHERE OLD.retention <> 'durable' OR OLD.pruned_at IS NOT NULL;
    SELECT RAISE(ABORT, 'not evictable: a computation or attempt still names this blob')
      WHERE EXISTS (SELECT 1 FROM computations WHERE output_hash = OLD.hash)
        OR EXISTS (SELECT 1 FROM computation_attempts WHERE output_hash = OLD.hash)
        OR EXISTS (SELECT 1 FROM computation_attempts WHERE cause_blob = OLD.hash);
    SELECT RAISE(ABORT, 'not evictable: an event names this blob, so it is permanent')
      WHERE ${eventNames("blob:", "OLD.hash")};
  END`,
  `CREATE TRIGGER IF NOT EXISTS blob_removals_evicted_output BEFORE INSERT ON blob_removals BEGIN
    SELECT RAISE(ABORT, 'not evictable: a blob is marked for removal only while it is the output of a kind declared recomputable')
      WHERE NOT EXISTS (SELECT 1 FROM computations c JOIN computation_kinds k ON k.op = c.op
        WHERE c.output_hash = NEW.hash AND k.recomputable = 1);
  END`,
  // A mark names one blob for good: changing its hash would point a pending removal elsewhere.
  `CREATE TRIGGER IF NOT EXISTS blob_removals_no_update BEFORE UPDATE ON blob_removals BEGIN
    SELECT RAISE(ABORT, 'not evictable: a mark for removal is never changed');
  END`,
  `CREATE TRIGGER IF NOT EXISTS blob_removals_cancel AFTER INSERT ON blobs BEGIN
    DELETE FROM blob_removals WHERE hash = NEW.hash;
  END`,
];

export const evictableOutputsMigration = Effect.gen(function* () {
  const sql = yield* SqlClient;
  for (const statement of evictableStatements) yield* sql.unsafe(statement);
});
