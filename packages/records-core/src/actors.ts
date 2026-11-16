import { safeRead } from "@neuve/records-schema";
import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { z } from "zod";
import { ActorActivityView, ActorView } from "@neuve/records-schema";
import { CorruptRecord } from "./errors.ts";
import { UNRESOLVED_ACTOR } from "./identity.ts";
import { assertCompatible } from "./store.ts";

/** An actor with its activity and, for a subagent, its parent's alias: the rows `neuve agents` shows. */
export const ActorSummary = ActorView.extend({
  parentAlias: z.string().nullable(),
  activity: ActorActivityView.omit({ actorId: true }),
});
export type ActorSummary = z.infer<typeof ActorSummary>;

const ACTIVITY_FIELDS = Object.keys(ActorActivityView.shape).filter(
  (field) => field !== "actorId",
);

/** Every actor read from the projections, in registration order (ULID), so parents precede children. */
export const list = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* assertCompatible;
  const rows = yield* sql<
    Record<string, unknown>
  >`SELECT a.*, p.alias AS parent_alias,
      coalesce(t.sessions_started, 0) AS sessions_started, coalesce(t.sessions_ended, 0) AS sessions_ended,
      coalesce(t.turns, 0) AS turns, coalesce(t.commits, 0) AS commits,
      coalesce(t.commits_declared, 0) AS commits_declared, t.model, t.model_event_id,
      coalesce(t.summaries, 0) AS summaries, coalesce(t.tokens_input, 0) AS tokens_input,
      coalesce(t.tokens_cache_creation, 0) AS tokens_cache_creation,
      coalesce(t.tokens_cache_read, 0) AS tokens_cache_read, coalesce(t.tokens_output, 0) AS tokens_output,
      coalesce(t.api_calls, 0) AS api_calls, coalesce(t.tool_calls, 0) AS tool_calls
    FROM projection_actors a
    LEFT JOIN projection_actors p ON p.actor_id = a.parent_actor
    LEFT JOIN projection_actor_activity t ON t.actor_id = a.actor_id
    ORDER BY a.registered_event_id, a.actor_id`;
  return yield* Effect.forEach(rows, (row) => {
    const activity = Object.fromEntries(
      ACTIVITY_FIELDS.map((field) => [field, row[field]]),
    );
    const actor = Object.fromEntries(
      Object.entries(row).filter(
        ([field]) =>
          !(ACTIVITY_FIELDS as ReadonlyArray<string>).includes(field),
      ),
    );
    const parsed = safeRead(ActorSummary, { ...actor, activity });
    return parsed.success
      ? Effect.succeed(parsed.data)
      : Effect.fail(
          new CorruptRecord({ message: `actors: ${parsed.error.message}` }),
        );
  });
});

/**
 * Commits whose actor is unknown, by why: the hook could not read the process table, several sessions
 * claimed it, or its override was invalid. They belong to no actor, so `list` cannot show them.
 */
export const unresolvedCommits = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* assertCompatible;
  return yield* sql<{
    link: string;
    commits: number;
  }>`SELECT json_extract(envelope, '$.payload.link') AS link, count(*) AS commits
    FROM events WHERE kind = 'commit.recorded@1' AND actor_id = ${UNRESOLVED_ACTOR}
    GROUP BY link ORDER BY link`;
});
