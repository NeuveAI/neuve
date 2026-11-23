import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { captureMigration, declaredLinkMigration } from "./capture-schema.ts";
import {
  computationStoreMigration,
  evictableOutputsMigration,
} from "./computation-schema.ts";
import { jobQueueMigration } from "./queue-schema.ts";
import {
  reviewProjectionMigration,
  unknownCostMigration,
} from "./review-schema.ts";
import { ventMigration, ventReconciliationMigration } from "./vent-schema.ts";

/**
 * Versions this build declares (D2, 12.24). `SCHEMA_VERSION` is the newest migration below.
 * `PROJECTOR_VERSION` changes whenever a projector's output changes, and a build ahead of the
 * store's projections rebuilds them on open. `MIN_WRITER_VERSION` is what migrating stores as the
 * minimum writer: the highest floor a breaking migration declares (`MIGRATION_MIN_WRITERS`). Builds
 * whose `WRITER_VERSION` is below a store's minimum writer refuse it; every other build uses it.
 */
export const SCHEMA_VERSION = 20;
// 20: additive evictable outputs: kinds declared recomputable, pending blob removals, and the
// "never delete" triggers made conditional; writer and projector floors stay unchanged.
// 19: additive worker ownership marker and durable terminal job notices.
// 18: additive computation operation lookup index; writer and projector floors stay unchanged.
// 17: additive capture lookup indexes; writer and projector floors stay unchanged.
// 16: channel review origins can omit lane when reviewing the connected project branch.
// 15: the review-origins projection, with a nullable lane (`review.origin-recorded@1`).
// 14: no table changes; migrating records writer 13 as the stores' minimum (the `commit.hybrid` job).
// 13: no table changes; migrating records writer 12 as the stores' minimum (`assessment.recorded@3`).
// 12: no table changes; migrating records writer 11 as the stores' minimum (`feedback.recorded@2`).
// 11: one row per feedback answer (`feedback.recorded@1`, M5 FB1).
// 10: no table changes; migrating records writer 9 as the stores' minimum (the stack job kinds).
// 5: commit link columns and the declared-commit count (8.13).
// 6: M3's event versions and their projections (proposal §10.2, PU5).
// 7: proof records (`proof.recorded@1`, slice H4b).
// 8: a stage's and a run's cost may be null, unknown (10.85).
export const PROJECTOR_VERSION = 11;
// 11: `unit.recorded@3` and `assessment.recorded@4` project into the units table as their older
// versions do; `packet.published@2` records only its supersession; `comment.recorded@3`,
// `lineage.recorded@1` and the packet itself are read from the log. No older kind's rows change,
// so the baseline stays 9.
// 10: `review.origin-recorded@1` projects into `projection_review_origins`; the cycle scope events
// project nothing. No older kind's rows change, so the baseline stays 9.
// 9: `feedback.recorded@1` projects into `projection_feedback`.
// 3: `turn.summarized@1`, transcript offsets on turn and session events, the computation store.
// 4: `vent.recorded@1` and the `retention.prune` job, which older builds cannot decode.
// 5: `vent.recorded@2`, the `declared` commit link and its `linkSource`, which older builds cannot
// decode, and the per-reconciliation vent index, which older builds do not check before appending.
// 6: `review.requested@1` and M3's event versions (unit, context, assessment, comment and
// disposition version 2; delivery, packet, gap, stage and run events), which older builds cannot
// decode, and the rule that a request for changes rests only on comments on its own unit.
// 7: `proof.recorded@1`, which older builds cannot decode or project.
// 8: receipts that name the Neuve sign-in instead of a key variable, and stage and run costs that
// are null (unknown, 10.85), which older builds cannot decode.
// 9: the `stack.fetch` and `stack.index` jobs (11.15), which older builds cannot decode.
// 10: `feedback.recorded@1` (M5 FB1), which older builds cannot decode or project, and the rules
// that check its target and corrections, which older builds do not check before appending.
// 11: `feedback.recorded@2` (10.107: the reference rubric and the harness's grade), which older
// builds cannot decode, project or check before appending.
// 12: `assessment.recorded@3` (11.16, 11.17: the checkpoints' anchors, kinds and sources), which
// older builds cannot decode or project.
// 13: the `commit.hybrid` job (10.118), which older builds cannot decode.
// 14, 15: the review-origin and cycle scope events, which older builds skip (12.24).
// 16: compatibility mode (12.24). Never stored as a floor; it tells this build apart from the
// transition build before it, which shares writer 15 but refuses stores this build leaves at the
// baseline main accepts.
// 17: `unit.recorded@3`, `assessment.recorded@4`, `comment.recorded@3`, `lineage.recorded@1` and
// `packet.published@2`, which older builds skip (12.24).
// 18: `review-list.cleared@1`, which older builds skip (12.24).
// 19: `query.recorded@1`, which older builds skip.
// 20: `cycle.opened@2` and `scope.fetch@2`, which older builds skip.
export const WRITER_VERSION = 20;

/**
 * The oldest projector whose rows, for the event kinds it knows, are this build's (12.24). It is what
 * the store's shared `projector_version` holds, so an older build whose projector reaches it keeps
 * reading and writing; it rises only with a projector that changes the rows of kinds older builds
 * write. This build's own projector is recorded beside it, as `projections_version`.
 */
export const PROJECTOR_BASELINE = 9;

/**
 * The minimum writer each breaking migration declares: the oldest build that can still use the
 * store without corrupting it (12.24). An additive migration (a new table or nullable column, new
 * event or job kinds) is absent, and leaves the stored minimum writer alone. The floors up to 14 date
 * from before 12.24, when every new kind raised the floor; they stay, because the builds they keep
 * out have no compatibility mode and stop at the first kind they cannot decode.
 */
export const MIGRATION_MIN_WRITERS: Readonly<Record<number, number>> = {
  10: 9,
  11: 10,
  12: 11,
  13: 12,
  14: 13,
};
export const MIN_WRITER_VERSION = Math.max(
  ...Object.values(MIGRATION_MIN_WRITERS),
);

export const MIGRATIONS_TABLE = "records_migrations";

/** Every table Records owns and what kind of data it holds. `stats` reports any table not listed here. */
export const TABLE_ROLES = {
  events: "log",
  event_units: "index",
  event_cycles: "index",
  jobs: "jobs",
  worker_state: "jobs",
  worker_lock_claim: "jobs",
  job_notices: "jobs",
  blobs: "blobs",
  computations: "computations",
  computation_attempts: "computations",
  computation_kinds: "computations",
  blob_removals: "blobs",
  records_meta: "meta",
  [MIGRATIONS_TABLE]: "meta",
  projection_actors: "projection",
  projection_cycles: "projection",
  projection_batches: "projection",
  projection_units: "projection",
  projection_dispositions: "projection",
  projection_comments: "projection",
  projection_context_references: "projection",
  projection_commits: "projection",
  projection_actor_activity: "projection",
  projection_supersessions: "projection",
  projection_commit_rewrites: "projection",
  projection_deliveries: "projection",
  projection_packets: "projection",
  projection_gaps: "projection",
  projection_stages: "projection",
  projection_runs: "projection",
  projection_proofs: "projection",
  projection_feedback: "projection",
  projection_review_origins: "projection",
} as const;

export type TableRole = (typeof TABLE_ROLES)[keyof typeof TABLE_ROLES];

const appendOnly = (table: string) => [
  `CREATE TRIGGER ${table}_append_only_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END`,
  `CREATE TRIGGER ${table}_append_only_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END`,
];

const initialSchema = [
  `CREATE TABLE records_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL) WITHOUT ROWID`,
  // Written in the migrator's transaction, so a store never exists with migrations but no versions.
  `INSERT INTO records_meta (key, value) VALUES ('min_writer_version', ${MIN_WRITER_VERSION}), ('projector_version', ${PROJECTOR_BASELINE}), ('projections_version', ${PROJECTOR_VERSION})`,
  // Each event is stored once (D6). `envelope` is the producer's event as canonical JSON;
  // `fingerprint` hashes the content the idempotency key is checked against (D4).
  `CREATE TABLE events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    fingerprint TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    envelope TEXT NOT NULL
  )`,
  `CREATE INDEX events_kind ON events (kind, seq)`,
  `CREATE INDEX events_actor ON events (actor_id, seq)`,
  `CREATE TABLE event_units (unit_id TEXT NOT NULL, event_seq INTEGER NOT NULL REFERENCES events (seq), PRIMARY KEY (unit_id, event_seq)) WITHOUT ROWID`,
  `CREATE TABLE event_cycles (cycle_id TEXT NOT NULL, event_seq INTEGER NOT NULL REFERENCES events (seq), PRIMARY KEY (cycle_id, event_seq)) WITHOUT ROWID`,
  ...appendOnly("events"),
  ...appendOnly("event_units"),
  ...appendOnly("event_cycles"),
  // Filled in the append transaction (D16). No lease or expiry column exists (8.2).
  `CREATE TABLE jobs (
    job_seq INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    dedupe_key TEXT NOT NULL UNIQUE,
    event_id TEXT NOT NULL REFERENCES events (id),
    state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'succeeded', 'failed')),
    not_before TEXT,
    attempts INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX jobs_state ON jobs (state, job_seq)`,
  // Projections: one row per entity, rebuilt from the log (D7).
  `CREATE TABLE projection_actors (
    actor_id TEXT PRIMARY KEY, actor_kind TEXT NOT NULL, harness TEXT NOT NULL, session_id TEXT,
    subagent_id TEXT, parent_actor TEXT, model TEXT, display_name TEXT, email TEXT, event_id TEXT NOT NULL
  ) WITHOUT ROWID`,
  `CREATE TABLE projection_cycles (
    cycle_id TEXT PRIMARY KEY, base_ref TEXT NOT NULL, base_oid TEXT NOT NULL, head_oid TEXT NOT NULL, event_id TEXT NOT NULL
  ) WITHOUT ROWID`,
  `CREATE TABLE projection_batches (
    batch_id TEXT PRIMARY KEY, cycle_id TEXT NOT NULL, title TEXT NOT NULL, event_id TEXT NOT NULL
  ) WITHOUT ROWID`,
  `CREATE TABLE projection_units (
    unit_id TEXT PRIMARY KEY, cycle_id TEXT, batch_id TEXT, title TEXT,
    owned_range_count INTEGER NOT NULL DEFAULT 0, recorded_event_id TEXT, lane TEXT, assessment_event_id TEXT,
    context_reference_count INTEGER NOT NULL DEFAULT 0, comment_count INTEGER NOT NULL DEFAULT 0
  ) WITHOUT ROWID`,
  `CREATE TABLE projection_dispositions (
    unit_id TEXT NOT NULL, cycle_id TEXT NOT NULL, actor_id TEXT NOT NULL, verdict TEXT NOT NULL,
    reviewed_head_oid TEXT NOT NULL, event_id TEXT NOT NULL, PRIMARY KEY (unit_id, cycle_id, actor_id)
  ) WITHOUT ROWID`,
  `CREATE TABLE projection_comments (
    event_id TEXT PRIMARY KEY, cycle_id TEXT NOT NULL, actor_id TEXT NOT NULL, anchor_path TEXT, unit_count INTEGER NOT NULL
  ) WITHOUT ROWID`,
  `CREATE TABLE projection_context_references (
    event_id TEXT PRIMARY KEY, cycle_id TEXT NOT NULL, marker_kind TEXT NOT NULL, source_kind TEXT NOT NULL, unit_count INTEGER NOT NULL
  ) WITHOUT ROWID`,
  `CREATE TABLE projection_commits (oid TEXT PRIMARY KEY, tree TEXT NOT NULL, event_id TEXT NOT NULL) WITHOUT ROWID`,
];

/**
 * Migration 8: one row per proof record (slice H4b), for listing a range's records by the revision
 * they observed or the range they were recorded for, and for counting them by kind. The claim and
 * requirement text stay in the event, read by its ID; currency is decided when a record is read
 * (11.10), so nothing here goes stale.
 */
const proofProjection = [
  `CREATE TABLE projection_proofs (
    event_id TEXT PRIMARY KEY, kind TEXT NOT NULL, revision TEXT NOT NULL, base_oid TEXT NOT NULL,
    head_oid TEXT NOT NULL, cycle_id TEXT, actor_id TEXT NOT NULL, session_id TEXT NOT NULL,
    artefact_hash TEXT NOT NULL, media_type TEXT NOT NULL, bytes INTEGER NOT NULL, scope_item TEXT,
    worktree_head TEXT NOT NULL, worktree_scope TEXT NOT NULL, worktree_dirty INTEGER NOT NULL
  ) WITHOUT ROWID`,
  `CREATE INDEX projection_proofs_revision ON projection_proofs (revision)`,
  `CREATE INDEX projection_proofs_base ON projection_proofs (base_oid)`,
];

/**
 * Migration 11: one row per feedback answer (M5 FB1), for reading a person's answers on a target,
 * a unit or a cycle and which answer supersedes which. The scales and note stay in the event, read
 * by its ID. The projector version rises with it, so migrate fills it from the log.
 */
const feedbackProjection = [
  `CREATE TABLE projection_feedback (
    event_id TEXT PRIMARY KEY, cycle_id TEXT NOT NULL, actor_id TEXT NOT NULL,
    target_kind TEXT NOT NULL, target_event_id TEXT NOT NULL,
    harness_call_visible INTEGER NOT NULL, supersedes_event_id TEXT
  ) WITHOUT ROWID`,
  `CREATE INDEX projection_feedback_target ON projection_feedback (target_event_id, actor_id)`,
  `CREATE INDEX projection_feedback_cycle ON projection_feedback (cycle_id, actor_id)`,
];

/**
 * Migrations by `<id>_<name>`, run by the first build ahead of a store to open it (12.24), by an
 * explicit migrate, or when a database is first created. A breaking one declares its floor in
 * `MIGRATION_MIN_WRITERS`.
 */
export const migrations = {
  "1_initial": Effect.gen(function* () {
    const sql = yield* SqlClient;
    for (const statement of initialSchema) yield* sql.unsafe(statement);
  }),
  "2_capture": captureMigration,
  "3_job_queue": jobQueueMigration,
  "4_computation_store": computationStoreMigration,
  "5_vent_limit": ventMigration,
  "6_reconciliation_and_declared_links": Effect.gen(function* () {
    yield* ventReconciliationMigration;
    yield* declaredLinkMigration;
  }),
  "7_review_projections": reviewProjectionMigration,
  "8_proof_records": Effect.gen(function* () {
    const sql = yield* SqlClient;
    for (const statement of proofProjection) yield* sql.unsafe(statement);
  }),
  "9_unknown_costs": unknownCostMigration,
  // Nothing to change: migrating is what recorded the new minimum writer (the stack job kinds).
  "10_stack_jobs": Effect.void,
  "11_feedback": Effect.gen(function* () {
    const sql = yield* SqlClient;
    for (const statement of feedbackProjection) yield* sql.unsafe(statement);
  }),
  // Nothing to change: `feedback.recorded@2` projects into migration 11's table; migrating is what
  // recorded the new minimum writer.
  "12_feedback_rubric": Effect.void,
  // Nothing to change: `assessment.recorded@3` projects into the units table as version 2 does;
  // migrating is what recorded the new minimum writer.
  "13_checkpoint_anchors": Effect.void,
  // Nothing to change: migrating is what recorded the new minimum writer (the `commit.hybrid` job).
  "14_hybrid_job": Effect.void,
  // Additive: a new table with a nullable lane. Older builds skip the events that fill it.
  "15_review_origins": Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql`CREATE TABLE projection_review_origins (
      event_id TEXT PRIMARY KEY, identity TEXT NOT NULL UNIQUE, cycle_id TEXT NOT NULL,
      host TEXT NOT NULL, channel TEXT, chat INTEGER, lane TEXT, origin_json TEXT NOT NULL,
      base_oid TEXT NOT NULL, head_oid TEXT NOT NULL, occurred_at TEXT NOT NULL
    ) WITHOUT ROWID`;
    yield* sql`CREATE INDEX projection_review_origins_channel ON projection_review_origins (channel, chat)`;
    yield* sql`CREATE INDEX projection_review_origins_cycle ON projection_review_origins (cycle_id)`;
  }),
  // Nothing to change: migration 15's lane is already nullable; a lane-less origin is a payload
  // change older builds skip with the kind. Additive.
  "16_project_review_origins": Effect.void,
  "17_capture_lookup_indexes": Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql`CREATE INDEX IF NOT EXISTS events_capture_marks_raw ON events (json_extract(envelope,'$.payload.rawCapture'),json_extract(envelope,'$.payload.detectorVersion'),seq) WHERE kind='capture.marked@1'`;
    yield* sql`CREATE INDEX IF NOT EXISTS events_capture_seals_raw ON events (json_extract(envelope,'$.payload.rawCapture'),json_extract(envelope,'$.payload.detectorVersion'),seq) WHERE kind='capture.sealed@1'`;
    yield* sql`CREATE INDEX IF NOT EXISTS events_capture_seals_record ON events (json_extract(envelope,'$.payload.record'),json_extract(envelope,'$.payload.detectorVersion'),seq) WHERE kind='capture.sealed@1'`;
  }),
  "18_computation_operation_index": Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql`CREATE INDEX IF NOT EXISTS computations_op ON computations (op)`;
  }),
  "19_worker_lock_and_job_notices": Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql`CREATE TABLE IF NOT EXISTS worker_lock_claim (id INTEGER PRIMARY KEY CHECK (id = 1))`;
    // Every older build's claim write invalidates the marker, even if its values are unchanged.
    yield* sql`CREATE TRIGGER IF NOT EXISTS worker_claim_insert AFTER INSERT ON worker_state
      BEGIN DELETE FROM worker_lock_claim; END`;
    yield* sql`CREATE TRIGGER IF NOT EXISTS worker_claim_update AFTER UPDATE OF pid, socket, started_at ON worker_state
      BEGIN DELETE FROM worker_lock_claim; END`;
    yield* sql`CREATE TRIGGER IF NOT EXISTS worker_claim_delete AFTER DELETE ON worker_state
      BEGIN DELETE FROM worker_lock_claim; END`;
    yield* sql`CREATE TABLE IF NOT EXISTS job_notices (job_seq INTEGER PRIMARY KEY REFERENCES jobs(job_seq) ON DELETE CASCADE)`;
    // Capture all terminal writers, including older builds, in the state update's transaction.
    yield* sql`CREATE TRIGGER IF NOT EXISTS job_terminal_notice AFTER UPDATE OF state ON jobs
      WHEN NEW.state IN ('completed', 'failed')
      BEGIN INSERT OR IGNORE INTO job_notices(job_seq) VALUES (NEW.job_seq); END`;
  }),
  // Additive: older builds never delete, so the conditional triggers allow them nothing new.
  "20_evictable_outputs": evictableOutputsMigration,
};
