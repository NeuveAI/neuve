import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

/**
 * Migration 2: projections for capture and identity (M2 S3), and dispositions that no longer depend
 * on append order. Projection tables are rebuilt from the log, so the changed ones are recreated
 * empty; the projector version rises with this migration, and migrate rebuilds them.
 */
const statements = [
  `DROP TABLE projection_actors`,
  // One row per actor. `registered_event_id` is the earliest registration and orders alias holders;
  // `label_event_id` is the newest registration carrying a display name or agent type.
  `CREATE TABLE projection_actors (
    actor_id TEXT PRIMARY KEY, actor_kind TEXT NOT NULL, harness TEXT NOT NULL, session_id TEXT,
    subagent_id TEXT, parent_actor TEXT, agent_type TEXT, display_name TEXT, email TEXT,
    alias_base TEXT NOT NULL, alias TEXT NOT NULL, registered_event_id TEXT NOT NULL, label_event_id TEXT,
    event_id TEXT NOT NULL
  ) WITHOUT ROWID`,
  `CREATE INDEX projection_actors_alias_base ON projection_actors (alias_base, registered_event_id)`,
  `CREATE TABLE projection_actor_activity (
    actor_id TEXT PRIMARY KEY, sessions_started INTEGER NOT NULL DEFAULT 0,
    sessions_ended INTEGER NOT NULL DEFAULT 0, turns INTEGER NOT NULL DEFAULT 0,
    commits INTEGER NOT NULL DEFAULT 0, model TEXT, model_event_id TEXT
  ) WITHOUT ROWID`,
  `DROP TABLE projection_dispositions`,
  `CREATE TABLE projection_dispositions (
    event_id TEXT PRIMARY KEY, unit_id TEXT NOT NULL, cycle_id TEXT NOT NULL, actor_id TEXT NOT NULL,
    verdict TEXT NOT NULL, reviewed_head_oid TEXT NOT NULL
  ) WITHOUT ROWID`,
  `CREATE INDEX projection_dispositions_key ON projection_dispositions (unit_id, cycle_id, actor_id)`,
  // Every `supersedes` link, kept even before its target arrives. Readers decide which links count.
  `CREATE TABLE projection_supersessions (
    target_id TEXT NOT NULL, by_event_id TEXT NOT NULL, PRIMARY KEY (target_id, by_event_id)
  ) WITHOUT ROWID`,
  `DROP TABLE projection_commits`,
  `CREATE TABLE projection_commits (
    oid TEXT PRIMARY KEY, tree TEXT NOT NULL, actor_id TEXT NOT NULL, session_id TEXT, event_id TEXT NOT NULL
  ) WITHOUT ROWID`,
  `CREATE TABLE projection_commit_rewrites (
    from_oid TEXT NOT NULL, to_oid TEXT NOT NULL, event_id TEXT NOT NULL, PRIMARY KEY (from_oid, to_oid)
  ) WITHOUT ROWID`,
];

export const captureMigration = Effect.gen(function* () {
  const sql = yield* SqlClient;
  for (const statement of statements) yield* sql.unsafe(statement);
});

/**
 * Migration 6, capture part: how each commit's actor was found, and a count of commits linked only by
 * a declared session ID (8.13). The projector version rises with it, so migrate rebuilds both tables.
 */
const declaredLinkStatements = [
  `ALTER TABLE projection_commits ADD COLUMN link TEXT NOT NULL DEFAULT 'none'`,
  `ALTER TABLE projection_commits ADD COLUMN link_source TEXT`,
  `ALTER TABLE projection_actor_activity ADD COLUMN commits_declared INTEGER NOT NULL DEFAULT 0`,
];

export const declaredLinkMigration = Effect.gen(function* () {
  const sql = yield* SqlClient;
  for (const statement of declaredLinkStatements) yield* sql.unsafe(statement);
});
