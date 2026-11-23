import { Clock, Effect, Option } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import type { RecordEvent } from "@neuve/records-schema";
import { canonicalJson, sha256Hex } from "./canonical.ts";
import { CorruptRecord } from "./errors.ts";
import { mintUlid } from "./ids.ts";
import { append, get } from "./log.ts";

type ReadOpening = Extract<RecordEvent, { kind: "cycle.opened@2" }>;
type LocalScopeSelection = Extract<
  RecordEvent,
  { kind: "cycle.local-scope-selected@1" }
>;

export const unboundReadCycles = (baseOid: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    return yield* sql<{ cycleId: string; branch: string }>`WITH openings AS (
      SELECT seq,
        json_extract(envelope, '$.attribution.cycleId') AS cycle_id,
        json_extract(envelope, '$.payload.branch') AS branch
      FROM events WHERE kind = 'cycle.opened@2'
        AND json_extract(envelope, '$.payload.baseOid') = ${baseOid}
    )
    SELECT cycle_id, branch FROM openings
    WHERE NOT EXISTS (
        SELECT 1 FROM event_cycles c JOIN events p ON p.seq = c.event_seq
        WHERE c.cycle_id = openings.cycle_id
          AND p.kind IN ('packet.published@1', 'packet.published@2')
      ) AND NOT EXISTS (
        SELECT 1 FROM projection_cycles p WHERE p.cycle_id = openings.cycle_id
      )
    ORDER BY seq DESC`;
  });

const latestReadCycle = (baseOid: string, branch: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const [latest] = yield* sql<{ cycleId: string; published: 0 | 1 }>`SELECT
      json_extract(e.envelope, '$.attribution.cycleId') AS cycle_id,
      EXISTS (
        SELECT 1 FROM event_cycles c JOIN events p ON p.seq = c.event_seq
        WHERE c.cycle_id = json_extract(e.envelope, '$.attribution.cycleId')
          AND p.kind IN ('packet.published@1', 'packet.published@2')
      ) AS published
    FROM events e
    WHERE e.kind = 'cycle.opened@2'
      AND json_extract(e.envelope, '$.payload.baseOid') = ${baseOid}
      AND json_extract(e.envelope, '$.payload.branch') = ${branch}
    ORDER BY e.seq DESC LIMIT 1`;
    return latest;
  });

export const openOrJoinCycle = <E = never, R = never>(
  payload: ReadOpening["payload"],
  actor: string,
  selectScope?: (
    cycleId: string,
  ) => Effect.Effect<LocalScopeSelection["payload"] | undefined, E, R>,
) =>
  Effect.gen(function* () {
    const latest = yield* latestReadCycle(payload.baseOid, payload.branch);
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
    const selection =
      selectScope === undefined ? undefined : yield* selectScope(cycleId);
    const events: Array<ReadOpening | LocalScopeSelection> = [];
    if (selection !== undefined)
      events.push({
        id: mintUlid(),
        kind: "cycle.local-scope-selected@1",
        idempotencyKey: `cycle.local-scope:${cycleId}`,
        actor,
        occurredAt: event.occurredAt,
        attribution: event.attribution,
        payload: selection,
      });
    events.push(event);
    return yield* append(events).pipe(
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
