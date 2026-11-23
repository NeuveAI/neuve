import { Clock, Effect, Option } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import type { RecordEvent } from "@neuve/records-schema";
import { canonicalJson, sha256Hex } from "./canonical.ts";
import { CorruptRecord } from "./errors.ts";
import { mintUlid } from "./ids.ts";
import { append, get } from "./log.ts";

type ReadOpening = Extract<RecordEvent, { kind: "cycle.opened@2" }>;

const readCycles = (baseOid: string, branch?: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    return yield* sql<{
      cycleId: string;
      branch: string;
      published: 0 | 1;
    }>`WITH openings AS (
      SELECT seq,
        json_extract(envelope, '$.attribution.cycleId') AS cycle_id,
        json_extract(envelope, '$.payload.branch') AS branch
      FROM events WHERE kind = 'cycle.opened@2'
        AND json_extract(envelope, '$.payload.baseOid') = ${baseOid}
    ), cycles AS (
      SELECT *, EXISTS (
        SELECT 1 FROM event_cycles c JOIN events p ON p.seq = c.event_seq
        WHERE c.cycle_id = openings.cycle_id
          AND p.kind IN ('packet.published@1', 'packet.published@2')
      ) AS published FROM openings
    )
    SELECT cycle_id, branch, published FROM cycles
    WHERE ${
      branch === undefined
        ? sql`published = 0 AND NOT EXISTS (
          SELECT 1 FROM projection_cycles p WHERE p.cycle_id = cycles.cycle_id
        )`
        : sql`branch = ${branch}`
    }
    ORDER BY seq DESC ${branch === undefined ? sql`` : sql`LIMIT 1`}`;
  });

/** Open cycles that can still be bound to a review's head, newest first. */
export const unboundReadCycles = (baseOid: string) => readCycles(baseOid);

/** A read joins the latest cycle for its base and branch until that cycle publishes. */
export const openOrJoinCycle = (
  payload: ReadOpening["payload"],
  actor: string,
) =>
  Effect.gen(function* () {
    const [latest] = yield* readCycles(payload.baseOid, payload.branch);
    if (latest?.published === 0)
      return { cycleId: latest.cycleId, opened: false };

    const cycleId = mintUlid();
    const id = mintUlid();
    const key = sha256Hex(
      canonicalJson([payload.baseOid, payload.branch, latest?.cycleId ?? null]),
    );
    const event: ReadOpening = {
      id,
      kind: "cycle.opened@2",
      idempotencyKey: `cycle.read:${key}`,
      actor,
      occurredAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
      attribution: { cycleId },
      payload,
    };
    return yield* append([event]).pipe(
      Effect.as({ cycleId, opened: true }),
      Effect.catchTag("IdempotencyConflict", (conflict) =>
        Effect.gen(function* () {
          const held = Option.getOrUndefined(
            yield* get(conflict.existingEventId),
          )?.event;
          if (
            held?.kind !== "cycle.opened@2" ||
            held.payload.baseOid !== payload.baseOid ||
            held.payload.branch !== payload.branch
          )
            return yield* new CorruptRecord({
              message: "The read cycle key is held by a different opening",
            });
          return { cycleId: held.attribution.cycleId, opened: false };
        }),
      ),
    );
  });
