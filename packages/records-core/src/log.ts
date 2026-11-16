import { Clock, Effect, Option } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import type { Fragment } from "effect/sql/Statement";
import {
  StoredEvent,
  NewCaptureCounts,
  PublicRefusal,
  VENT_MEDIA_TYPE,
  type RecordEvent,
  type RecordEventKind,
} from "@neuve/records-schema";
import { canonicalJson } from "./canonical.ts";
import {
  decodeStoredEvent,
  fingerprintOf,
  newerEventRow,
  parseEvent,
} from "./codec.ts";
import {
  CorruptRecord,
  EventIdConflict,
  IdempotencyConflict,
  InvalidEvent,
} from "./errors.ts";
import { jobsFor } from "./jobs.ts";
import { project } from "./projectors.ts";
import { checkWorkflowRules } from "./rules.ts";
import { assertCompatible, markProjections } from "./store.ts";
import { VENT_KEY_SQL, VENT_KINDS_SQL } from "./vent-schema.ts";

/** Capture keys are reserved across all event kinds, including hook spool writers. */
export const captureEventKindForKey = (key: string) => {
  for (const kind of ["filed", "sealed", "marked"] as const)
    if (key.startsWith(`capture.${kind}:`)) return `capture.${kind}@1` as const;
  return undefined;
};

export interface AppendResult {
  /**
   * `existing`: the idempotency key already held this content. `kept-earlier`: a vent from an actor
   * that already vented under the same reconciliation ID, or the same session when there is none
   * (8.8, 8.16); `id` and `seq` name the earlier vent. Nothing was written in either case.
   */
  readonly status: "appended" | "existing" | "kept-earlier";
  readonly id: string;
  readonly seq: number;
}

/** What one vent is allowed per, with its actor (8.16): its reconciliation ID, else its session. */
export type VentKey =
  { readonly reconciliationId: string } | { readonly sessionId: string };

export const ventKeyOf = (vent: {
  readonly reconciliationId?: string | undefined;
  readonly sessionId: string;
}): VentKey =>
  vent.reconciliationId === undefined
    ? { sessionId: vent.sessionId }
    : { reconciliationId: vent.reconciliationId };

/** The key as the log's unique index computes it (`VENT_KEY_SQL`). */
const ventKeyText = (key: VentKey) =>
  "reconciliationId" in key
    ? `r:${key.reconciliationId}`
    : `s:${key.sessionId}`;

/**
 * The vent an actor already recorded under a key, if any. The log's unique index allows one per actor
 * and key (8.8, 8.16); appending checks here first, so a second vent from any producer (the CLI, MCP
 * or a spooled event) is an ordinary outcome, never a storage failure.
 */
export const earlierVent = (actorId: string, key: VentKey) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const [row] = yield* sql<{
      id: string;
      seq: number;
      recordedAt: string;
    }>`SELECT id, seq, recorded_at FROM events
      WHERE ${sql.literal(VENT_KINDS_SQL)} AND actor_id = ${actorId}
        AND ${sql.literal(VENT_KEY_SQL)} = ${ventKeyText(key)}`;
    return row;
  });

/**
 * A batch's producer may link its events through IDs it mints fresh on every attempt, so a retry names
 * the same causes by new IDs. `resolved` maps each incoming ID whose key the log holds to the ID the
 * log holds for it; links are rewritten through it before the event is compared or stored, so the
 * retry matches its stored content and new events point at the stored events (D4).
 */
const relink = (
  incoming: RecordEvent,
  resolved: ReadonlyMap<string, string>,
): RecordEvent => {
  // The comments a request for changes rests on are links too (10.69).
  const event: RecordEvent =
    incoming.kind === "disposition.carried@1"
      ? {
          ...incoming,
          payload: {
            ...incoming.payload,
            restsOn: incoming.payload.restsOn.map(
              (id) => resolved.get(id) ?? id,
            ),
          },
        }
      : incoming.kind === "disposition.recorded@2"
        ? {
            ...incoming,
            payload: {
              ...incoming.payload,
              restsOn: incoming.payload.restsOn.map(
                (id) => resolved.get(id) ?? id,
              ),
            },
          }
        : incoming;
  const causation = event.causation;
  if (causation === undefined) return event;
  const map = (id: string | undefined) =>
    id === undefined ? undefined : (resolved.get(id) ?? id);
  const causedBy = map(causation.causedBy);
  const supersedes = map(causation.supersedes);
  if (causedBy === causation.causedBy && supersedes === causation.supersedes)
    return event;
  return {
    ...event,
    causation: {
      ...causation,
      ...(causedBy === undefined ? {} : { causedBy }),
      ...(supersedes === undefined ? {} : { supersedes }),
    },
  } as RecordEvent;
};

const appendOne = (
  incoming: RecordEvent,
  recordedAt: string,
  resolved: Map<string, string>,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const event = relink(incoming, resolved);
    const captureKind = captureEventKindForKey(event.idempotencyKey);
    if (captureKind !== undefined && event.kind !== captureKind)
      return yield* Effect.fail(
        new InvalidEvent({
          message:
            "capture idempotency namespaces require the matching capture event kind",
        }),
      );
    const fingerprint = fingerprintOf(event);
    const [held] = yield* sql<{
      id: string;
      seq: number;
      fingerprint: string;
    }>`SELECT id, seq, fingerprint
      FROM events WHERE idempotency_key = ${event.idempotencyKey}`;
    if (held !== undefined && held.fingerprint === fingerprint) {
      resolved.set(incoming.id, held.id);
      const existing: AppendResult = {
        status: "existing",
        id: held.id,
        seq: held.seq,
      };
      return existing;
    }
    if (
      event.kind === "capture.filed@1" &&
      !NewCaptureCounts.safeParse(event.payload.counts).success
    )
      return yield* Effect.fail(
        new InvalidEvent({
          message: "invalid capture scan counts; filing refused",
        }),
      );
    if (
      (event.kind === "capture.sealed@1" ||
        event.kind === "capture.marked@1") &&
      event.payload.reason !== undefined &&
      !PublicRefusal.safeParse(event.payload.reason).success
    )
      return yield* new InvalidEvent({
        message: "capture scan reason is not public wording",
      });
    // Inline vent text could never expire (8.17): stored ones still decode, new ones are refused.
    if (event.kind === "vent.recorded@1")
      return yield* new InvalidEvent({
        message: `${event.id}: vent.recorded@1 keeps its text in the event, which never expires; vents now record their text as a raw capture (vent.recorded@2)`,
      });
    if (event.kind === "vent.recorded@2") {
      const earlier = yield* earlierVent(
        event.actor,
        ventKeyOf({
          reconciliationId: event.payload.reconciliationId,
          sessionId: event.attribution.sessionId,
        }),
      );
      if (earlier !== undefined) {
        resolved.set(incoming.id, earlier.id);
        const kept: AppendResult = {
          status: "kept-earlier",
          id: earlier.id,
          seq: earlier.seq,
        };
        return kept;
      }
    }
    if (event.kind === "vent.recorded@2") {
      const hash = event.refs[0].ref.slice("blob:".length);
      const [text] = yield* sql<{
        mediaType: string;
        retention: string;
      }>`SELECT media_type, retention FROM blobs WHERE hash = ${hash}`;
      if (text === undefined)
        return yield* new InvalidEvent({
          message: `${event.id}: the vent's text blob ${hash.slice(0, 12)} is not in the store`,
        });
      // The text must be a raw capture the pruner removes (8.17); a durable blob would never expire.
      if (
        text.retention !== "raw-capture" ||
        text.mediaType !== VENT_MEDIA_TYPE
      )
        return yield* new InvalidEvent({
          message: `${event.id}: the vent's text blob ${hash.slice(0, 12)} is ${text.retention} ${text.mediaType}; vent text must be a raw-capture ${VENT_MEDIA_TYPE} blob`,
        });
    }
    if (event.kind === "proof.recorded@1") {
      // A proof record must name stored bytes that are what it says they are (slice H4b).
      const hash = event.refs[0].ref.slice("blob:".length);
      const [artefact] = yield* sql<{
        mediaType: string;
        size: number;
        prunedAt: string | null;
      }>`SELECT media_type, size, pruned_at FROM blobs WHERE hash = ${hash}`;
      if (artefact === undefined)
        return yield* new InvalidEvent({
          message: `${event.id}: the proof's artefact blob ${hash.slice(0, 12)} is not in the store`,
        });
      if (artefact.prunedAt !== null)
        return yield* new InvalidEvent({
          message: `${event.id}: the proof's artefact blob ${hash.slice(0, 12)} was pruned; store the bytes again first`,
        });
      if (
        artefact.mediaType !== event.payload.artefact.mediaType ||
        artefact.size !== event.payload.artefact.bytes
      )
        return yield* new InvalidEvent({
          message: `${event.id}: the proof's artefact blob ${hash.slice(0, 12)} is ${artefact.mediaType}, ${artefact.size} bytes; the record says ${event.payload.artefact.mediaType}, ${event.payload.artefact.bytes} bytes`,
        });
    }
    if (held !== undefined)
      return yield* new IdempotencyConflict({
        idempotencyKey: event.idempotencyKey,
        existingEventId: held.id,
      });
    const [taken] = yield* sql<{
      seq: number;
    }>`SELECT seq FROM events WHERE id = ${event.id}`;
    if (taken !== undefined)
      return yield* new EventIdConflict({ eventId: event.id });
    yield* checkWorkflowRules(event);

    const [inserted] = yield* sql<{
      seq: number;
    }>`INSERT INTO events ${sql.insert({
      id: event.id,
      kind: event.kind,
      idempotency_key: event.idempotencyKey,
      fingerprint,
      actor_id: event.actor,
      occurred_at: event.occurredAt,
      recorded_at: recordedAt,
      envelope: canonicalJson(event),
    })} RETURNING seq`;
    if (inserted === undefined)
      return yield* new CorruptRecord({
        message: `No seq returned for ${event.id}`,
      });
    const seq = inserted.seq;

    // Index rows, not copies: one small row per attributed unit and cycle (D6).
    const unitIds = event.attribution?.unitIds ?? [];
    if (unitIds.length > 0) {
      yield* sql`INSERT INTO event_units ${sql.insert(unitIds.map((unit_id) => ({ unit_id, event_seq: seq })))}`;
    }
    const cycleId = event.attribution?.cycleId;
    if (cycleId !== undefined)
      yield* sql`INSERT INTO event_cycles ${sql.insert({ cycle_id: cycleId, event_seq: seq })}`;

    for (const job of jobsFor(event)) {
      yield* sql`INSERT INTO jobs ${sql.insert({ kind: job.kind, dedupe_key: job.dedupeKey, event_id: event.id })}
        ON CONFLICT (dedupe_key) DO UPDATE SET
          state = 'waiting', stalls = 0, run_at = NULL, started_at = NULL,
          finished_at = NULL, last_error = NULL, payload = NULL,
          enqueued_at = ${recordedAt}, event_id = excluded.event_id
        WHERE jobs.kind = 'commit.prepare@2' AND excluded.kind = jobs.kind AND jobs.state = 'failed'`;
    }
    yield* project(event);
    resolved.set(incoming.id, event.id);
    const appended: AppendResult = { status: "appended", id: event.id, seq };
    return appended;
  });

/**
 * Appends events in one write transaction: index rows, enqueued jobs and projections commit with
 * them or not at all. Idempotent by each event's key, including links between the batch's own events;
 * the version gate and the workflow rules are checked inside.
 */
export const append = (events: ReadonlyArray<unknown>) =>
  Effect.gen(function* () {
    const parsed = yield* Effect.forEach(events, parseEvent);
    const recordedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
    const sql = yield* SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* assertCompatible;
        yield* markProjections;
        // Every incoming ID whose key the log already holds maps to the stored ID before any event is
        // compared, so a link to a later event in the batch is rewritten as well as one to an earlier.
        const resolved = new Map<string, string>();
        for (const event of parsed) {
          const [held] = yield* sql<{
            id: string;
          }>`SELECT id FROM events WHERE idempotency_key = ${event.idempotencyKey}`;
          if (held !== undefined) resolved.set(event.id, held.id);
        }
        return yield* Effect.forEach(parsed, (event) =>
          appendOne(event, recordedAt, resolved),
        );
      }),
    );
  });

export interface HistoryFilter {
  readonly unitId?: string | undefined;
  readonly cycleId?: string | undefined;
  readonly kind?: RecordEventKind | undefined;
  readonly actorId?: string | undefined;
  readonly afterSeq?: number | undefined;
  readonly limit?: number | undefined;
}

/** A stored row as a `StoredEvent`; none for a newer build's kind, which the reader leaves out. */
export const toStored = (row: {
  seq: number;
  recordedAt: string;
  kind: string;
  envelope: string;
}) =>
  Effect.gen(function* () {
    const event = yield* decodeStoredEvent(row, `event seq ${row.seq}`);
    if (Option.isNone(event)) return Option.none<StoredEvent>();
    const stored = StoredEvent.safeParse({
      seq: row.seq,
      recordedAt: row.recordedAt,
      event: event.value,
    });
    if (!stored.success)
      return yield* new CorruptRecord({
        message: `event seq ${row.seq}: ${stored.error.message}`,
      });
    return Option.some(stored.data);
  });

/**
 * Events in `seq` order, filtered through the unit and cycle indexes. A newer build's events are
 * left out in the query (8.19), so a limit counts only events returned.
 */
export const history = (filter: HistoryFilter) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const where: Array<Fragment> = [
      sql`e.seq > ${filter.afterSeq ?? 0}`,
      sql`NOT ${newerEventRow(sql, "e")}`,
    ];
    if (filter.unitId !== undefined) {
      where.push(
        sql`e.seq IN (SELECT event_seq FROM event_units WHERE unit_id = ${filter.unitId})`,
      );
    }
    if (filter.cycleId !== undefined) {
      where.push(
        sql`e.seq IN (SELECT event_seq FROM event_cycles WHERE cycle_id = ${filter.cycleId})`,
      );
    }
    if (filter.kind !== undefined) where.push(sql`e.kind = ${filter.kind}`);
    if (filter.actorId !== undefined)
      where.push(sql`e.actor_id = ${filter.actorId}`);
    const rows = yield* sql<{
      seq: number;
      recordedAt: string;
      kind: string;
      envelope: string;
    }>`SELECT e.seq, e.recorded_at, e.kind,
      e.envelope FROM events e WHERE ${sql.and(where)} ORDER BY e.seq LIMIT ${filter.limit ?? 100}`;
    const events = yield* Effect.forEach(rows, toStored);
    return events.flatMap((event) =>
      Option.isSome(event) ? [event.value] : [],
    );
  });

/** One event by its ULID; none when it is absent or a newer build's kind (8.19). */
export const get = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const [row] = yield* sql<{
      seq: number;
      recordedAt: string;
      kind: string;
      envelope: string;
    }>`SELECT seq, recorded_at, kind, envelope
      FROM events WHERE id = ${id}`;
    if (row === undefined) return Option.none<StoredEvent>();
    return yield* toStored(row);
  });

/** The kind of the event with this ULID when it is a newer build's, which `get` leaves out (8.19). */
export const newerEventKind = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const [row] = yield* sql<{
      kind: string;
    }>`SELECT kind FROM events WHERE id = ${id} AND ${newerEventRow(sql)}`;
    return Option.fromNullishOr(row?.kind);
  });

/**
 * The log's current sequence: the highest `seq` appended, 0 for an empty log. A reader that saw a
 * value learns that Records changed when it moves (8.3); one indexed read.
 */
export const currentSequence = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const [row] = yield* sql<{
    seq: number | null;
  }>`SELECT max(seq) AS seq FROM events`;
  return row?.seq ?? 0;
}).pipe(Effect.withSpan("records.log.sequence"));
