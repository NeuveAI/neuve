import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

/**
 * Migration 5: at most one vent per actor and session (8.8). The log itself holds the limit: a
 * partial unique index over vent events, so two appends racing past the check in `Vents.record`
 * cannot both commit, whatever idempotency keys their producers chose. `sessionId` is required on
 * every vent's attribution, so the indexed expression is never null.
 */
const statements = [
  `CREATE UNIQUE INDEX events_one_vent_per_session
    ON events (actor_id, json_extract(envelope, '$.attribution.sessionId'))
    WHERE kind = 'vent.recorded@1'`,
];

export const ventMigration = Effect.gen(function* () {
  const sql = yield* SqlClient;
  for (const statement of statements) yield* sql.unsafe(statement);
});

/**
 * The key one vent is allowed per, with the actor (8.16): the vent's reconciliation ID when it carries
 * one, otherwise its session. The prefixes keep a reconciliation ID from ever equalling a session ID.
 * `Log.earlierVent` queries the same expression, so the index serves it.
 */
export const VENT_KEY_SQL = `coalesce('r:' || json_extract(envelope, '$.payload.reconciliationId'), 's:' || json_extract(envelope, '$.attribution.sessionId'))`;

/** The vent kinds the limit covers: inline-text vents from before 8.17 and vents with a text blob. */
export const VENT_KINDS_SQL = `kind IN ('vent.recorded@1', 'vent.recorded@2')`;

/**
 * Migration 6, vent part: one vent per actor and reconciliation ID, falling back to the session
 * (8.16). Earlier vents carry no reconciliation ID, so their key stays their session and every store
 * that satisfied the old index satisfies this one.
 */
const reconciliationStatements = [
  `DROP INDEX events_one_vent_per_session`,
  `CREATE UNIQUE INDEX events_one_vent_per_reconciliation
    ON events (actor_id, ${VENT_KEY_SQL})
    WHERE ${VENT_KINDS_SQL}`,
];

export const ventReconciliationMigration = Effect.gen(function* () {
  const sql = yield* SqlClient;
  for (const statement of reconciliationStatements)
    yield* sql.unsafe(statement);
});
