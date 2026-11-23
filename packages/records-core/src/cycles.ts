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

const SCOPE_COPY_IDLE_MS = 7 * 24 * 60 * 60 * 1_000;

export const isIdle = (now: number, lastRunAt: number) =>
  now - lastRunAt >= SCOPE_COPY_IDLE_MS;

export const lastRunActivity = (cycleId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const [row] = yield* sql<{
      at: string | null;
    }>`SELECT max(e.recorded_at) AS at
      FROM events e LEFT JOIN event_cycles c ON c.event_seq = e.seq
      WHERE c.cycle_id = ${cycleId} OR json_extract(e.envelope, '$.attribution.cycleId') = ${cycleId}`;
    return Option.map(Option.fromNullishOr(row?.at), Date.parse);
  });

type ReadCycle = { cycleId: string; taken: 0 | 1 };

const readCycles = (branches: readonly string[], limit = -1) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    return yield* sql<ReadCycle>`SELECT
      json_extract(e.envelope, '$.attribution.cycleId') AS cycle_id,
      p.cycle_id IS NOT NULL AS taken
    FROM events e
    LEFT JOIN projection_cycles p ON p.cycle_id = json_extract(e.envelope, '$.attribution.cycleId')
    WHERE e.kind = 'cycle.opened@2'
      AND json_extract(e.envelope, '$.payload.branch') IN ${sql.in(branches)}
    ORDER BY e.seq DESC LIMIT ${limit}`;
  });

const isOpen = (cycle: ReadCycle) =>
  Effect.gen(function* () {
    if (cycle.taken) return false;
    const last = yield* lastRunActivity(cycle.cycleId);
    const now = yield* Clock.currentTimeMillis;
    return Option.exists(last, (at) => !isIdle(now, at));
  });

export const newestOpenReadCycle = (branches: ReadonlySet<string>) =>
  Effect.gen(function* () {
    const cycles = yield* readCycles([...branches]);
    const open = yield* Effect.findFirst(cycles, isOpen);
    return Option.getOrUndefined(open)?.cycleId;
  });

export const openOrJoinCycle = <E = never, R = never>(
  payload: ReadOpening["payload"],
  actor: string,
  selectScope?: (
    cycleId: string,
  ) => Effect.Effect<LocalScopeSelection["payload"] | undefined, E, R>,
) =>
  Effect.gen(function* () {
    const [latest] = yield* readCycles([payload.branch], 1);
    if (latest !== undefined && (yield* isOpen(latest)))
      return { cycleId: latest.cycleId, opened: false };

    const cycleId = mintUlid();
    const id = mintUlid();
    const key = sha256Hex(
      canonicalJson([payload.branch, latest?.cycleId ?? null]),
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
