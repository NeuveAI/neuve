import { Context, Effect, Option } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import {
  PacketManifest,
  safeRead,
  type Lane,
  type RecordEvent,
  type StoredEvent,
} from "@neuve/records-schema";
import { BlobStore } from "./blobs.ts";
import { dispositionRows } from "./carried-relations.ts";
import { current as dispositionsNow, liveDisposition } from "./dispositions.ts";
import { get, toStored } from "./log.ts";
import { standingPacketId } from "./published-packets.ts";
import { assertCompatible } from "./store.ts";
import { isUnitEvent, unitRanges } from "./unit-ranges.ts";

/**
 * How an earlier unit reaches the units that now hold its work (`lineage.recorded@1`): an old
 * unit link resolves to its successors instead of reading as an unknown unit. A lineage event is
 * attributed to its successor first and then the earlier units, so the unit index finds it from
 * either side.
 */

export interface Successor {
  /** The unit that now holds sections of the earlier one. */
  readonly unitId: string;
  readonly cycleId: string;
  /** `unchanged` when every section of the successor is the same change in the earlier unit. */
  readonly relation: "unchanged" | "changed";
  /** The `lineage.recorded@1` that says so. */
  readonly eventId: string;
}

/**
 * Adds to `found` the successor a lineage event names for `unitId`, unless it is not a lineage
 * event this build reads, names `unitId` as its own successor, names a successor already found, or
 * does not name `unitId` as an earlier unit.
 */
const noteSuccessor = (
  found: Array<Successor>,
  unitId: string,
  held: Option.Option<StoredEvent>,
) => {
  if (Option.isNone(held) || held.value.event.kind !== "lineage.recorded@1")
    return;
  const event = held.value.event;
  const [successor] = event.attribution.unitIds;
  if (
    successor === undefined ||
    successor === unitId ||
    found.some((known) => known.unitId === successor)
  )
    return;
  const entry = event.payload.from.find((from) => from.unitId === unitId);
  if (entry === undefined) return;
  found.push({
    unitId: successor,
    cycleId: event.attribution.cycleId,
    relation: entry.relation,
    eventId: event.id,
  });
};

/**
 * The units lineage names as successors of `unitId`, newest lineage event first, each once, from
 * its newest event about `unitId`. Empty for an ID no lineage names as an earlier unit, including
 * a successor asked about itself. A build that does
 * not know the kind reads nothing here: `Log.get` skips it.
 */
export const successors = (unitId: string) =>
  Effect.gen(function* () {
    yield* assertCompatible;
    const sql = yield* SqlClient;
    const rows = yield* sql<{ id: string }>`SELECT e.id FROM event_units u
      JOIN events e ON e.seq = u.event_seq
      WHERE u.unit_id = ${unitId} AND e.kind = 'lineage.recorded@1'
      ORDER BY e.id DESC`;
    const found: Array<Successor> = [];
    for (const row of rows) noteSuccessor(found, unitId, yield* get(row.id));
    return found;
  }).pipe(Effect.withSpan("records.lineage.successors"));

/**
 * `successors` for each of `unitIds` at once, one read through the unit index per page of 500
 * units, each lineage event decoded once however many of the units it names. Every asked unit is a
 * key, holding exactly what `successors(unitId)` returns for it, in the same order; a unit no
 * lineage names as an earlier unit holds an empty list.
 */
export const successorsMany = (unitIds: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    yield* assertCompatible;
    const sql = yield* SqlClient;
    const asked = [...new Set(unitIds)];
    const found = new Map<string, Array<Successor>>(
      asked.map((unitId) => [unitId, []]),
    );
    const decoded = new Map<string, Option.Option<StoredEvent>>();
    for (const page of pages(asked)) {
      // `CROSS JOIN` drives from the unit index, as `linked` does below.
      const rows = yield* sql<{
        unitId: string;
        id: string;
        seq: number;
        recordedAt: string;
        kind: string;
        envelope: string;
      }>`SELECT u.unit_id, e.id, e.seq, e.recorded_at, e.kind, e.envelope
        FROM event_units u CROSS JOIN events e ON e.seq = u.event_seq
        WHERE ${sql.in("u.unit_id", page)} AND e.kind = 'lineage.recorded@1'
        ORDER BY u.unit_id, e.id DESC`;
      for (const row of rows) {
        let held = decoded.get(row.id);
        if (held === undefined) {
          held = yield* toStored(row);
          decoded.set(row.id, held);
        }
        noteSuccessor(found.get(row.unitId) ?? [], row.unitId, held);
      }
    }
    return found as ReadonlyMap<string, ReadonlyArray<Successor>>;
  }).pipe(Effect.withSpan("records.lineage.successors-many"));

/** An earlier packet a review compares its units with. */
export interface EarlierPacket {
  readonly packetId: string;
  readonly cycleId: string;
  /** In this cycle: the packet of record another sequence (configuration) published. */
  readonly sameCycle: boolean;
}

/** Whether `ancestor` is `descendant` or in its history; the caller runs git, records-core does not. */
export type IsAncestor<R> = (
  ancestor: string,
  descendant: string,
) => Effect.Effect<boolean, never, R>;

const sameItems = (a: string, b: string) => {
  const itemsOf = (json: string) => {
    try {
      const origin = JSON.parse(json) as {
        kind?: string;
        items?: ReadonlyArray<Record<string, unknown>>;
      };
      return origin.kind === "external"
        ? (origin.items ?? []).map(
            (item) =>
              `${String(item["provider"])}:${String(item["repo"]).toLowerCase()}:${String(item["kind"])}:${String(item["number"])}`,
          )
        : [];
    } catch {
      return [];
    }
  };
  const mine = itemsOf(a);
  return itemsOf(b).some((item) => mine.includes(item));
};

/**
 * The earlier packets a review of `cycleId` compares its units with (records design, section 2):
 * the cycle's packet of record, when one stands (another sequence's, since a review asks this
 * before it publishes), and the packet of record of the newest earlier cycle of the same review.
 * The same review is the newest earlier cycle (by cycle ID) that shares a review origin with this
 * one (`review.origin-recorded@1`: the same host, channel and chat, or the same external item),
 * else the newest earlier cycle on the same base ref whose head `isAncestor` says is an ancestor of
 * this cycle's head. A cycle with no packet of record is passed over. The publisher's first plan
 * asks this once and stores the answer.
 */
export const earlierReview = <R>(input: {
  readonly cycleId: string;
  readonly isAncestor: IsAncestor<R>;
}) =>
  Effect.gen(function* () {
    yield* assertCompatible;
    const sql = yield* SqlClient;
    const packets: Array<EarlierPacket> = [];
    const standing = yield* standingPacketId(input.cycleId);
    if (standing !== undefined)
      packets.push({
        packetId: standing,
        cycleId: input.cycleId,
        sameCycle: true,
      });
    const origins = yield* sql<{
      host: string;
      channel: string | null;
      chat: number | null;
      originJson: string;
    }>`SELECT host, channel, chat, origin_json FROM projection_review_origins WHERE cycle_id = ${input.cycleId}`;
    const candidates = new Set<string>();
    for (const host of new Set(origins.map((origin) => origin.host))) {
      const rows = yield* sql<{
        cycleId: string;
        channel: string | null;
        chat: number | null;
        originJson: string;
      }>`SELECT cycle_id, channel, chat, origin_json FROM projection_review_origins
        WHERE host = ${host} AND cycle_id < ${input.cycleId}`;
      for (const row of rows)
        if (
          origins.some(
            (origin) =>
              origin.host === host &&
              ((origin.channel !== null &&
                origin.channel === row.channel &&
                origin.chat === row.chat) ||
                sameItems(origin.originJson, row.originJson)),
          )
        )
          candidates.add(row.cycleId);
    }
    for (const cycleId of [...candidates].sort().reverse()) {
      const packetId = yield* standingPacketId(cycleId);
      if (packetId !== undefined) {
        packets.push({ packetId, cycleId, sameCycle: false });
        return packets;
      }
    }
    const [cycle] = yield* sql<{
      baseRef: string;
      headOid: string;
    }>`SELECT base_ref, head_oid FROM projection_cycles WHERE cycle_id = ${input.cycleId}`;
    if (cycle === undefined) return packets;
    const cycles = yield* sql<{
      cycleId: string;
      headOid: string;
    }>`SELECT cycle_id, head_oid FROM projection_cycles
      WHERE base_ref = ${cycle.baseRef} AND cycle_id < ${input.cycleId}
      ORDER BY cycle_id DESC LIMIT 200`;
    for (const earlier of cycles) {
      const packetId = yield* standingPacketId(earlier.cycleId);
      if (packetId === undefined) continue;
      if (yield* input.isAncestor(earlier.headOid, cycle.headOid)) {
        packets.push({ packetId, cycleId: earlier.cycleId, sameCycle: false });
        return packets;
      }
    }
    return packets;
  }).pipe(Effect.withSpan("records.lineage.earlier-review"));

/**
 * The most of one person's acts `lastActs` reads for one new unit, newest first, without reaching
 * one about it. Each act read on a unit not read before costs one indexed query, one event and one
 * sections blob, once per call; 4,096 is more decisions and withdrawals than any person has made
 * across every review run so far. Past it nothing is carried for anyone to that unit
 * (`not-known`), and the publisher says so in a gap.
 */
export const ACTS_READ_MAX = 4_096;

/** `ACTS_READ_MAX`, which only the tests lower, to reach it without thousands of decisions. */
export const ActsReadMax = Context.Reference<number>(
  "@neuve/records-core/Lineage/ActsReadMax",
  { defaultValue: () => ACTS_READ_MAX },
);

/**
 * For a new unit whose section keys are not known only (an old-shape unit, which `decidedBy` asks
 * of; the publisher always asks with keys): the most units `lastActs` reads as one unchanged
 * change through lineage. A unit reviewed unchanged through C configurations of each of N cycles
 * is connected to about C × N units (more when a cut of the same lines splits it); 4,096 holds 64
 * configurations of 64 cycles, far past any review run so far, and reading that many costs one
 * indexed query per unit. Past it nothing is carried for anyone on a unit connected to them
 * (`not-known`).
 */
export const CONNECTED_UNITS_MAX = 4_096;

/** `CONNECTED_UNITS_MAX`, which only the tests lower, to reach it without thousands of reviews. */
export const ConnectedUnitsMax = Context.Reference<number>(
  "@neuve/records-core/Lineage/ConnectedUnitsMax",
  { defaultValue: () => CONNECTED_UNITS_MAX },
);

/** A decision a person recorded themselves, with its place in the store's append order. */
export interface RecordedDecision {
  readonly id: string;
  readonly seq: number;
}

/**
 * What one registered person's decisions bring to a new unit (`lastActs`). A person with nothing to
 * bring (no act on the change, or a withdrawal as their last act) is not listed.
 */
export type PersonAnswer =
  /**
   * Their last act is `decision`, and a unit the new unit is compared with holds it or a copy of it
   * that stands there: `eventId` on `unitId`, the decision itself when a compared unit holds it,
   * else the copy that entered the store last.
   */
  | {
      readonly kind: "carry";
      readonly actorId: string;
      readonly decision: RecordedDecision;
      readonly unitId: string;
      readonly eventId: string;
    }
  /**
   * Their last act is `decision`, and no compared unit holds it or a copy of it that can be
   * followed back to it: nothing of theirs is brought, and a person decides again.
   */
  | {
      readonly kind: "withheld";
      readonly actorId: string;
      readonly decision: RecordedDecision;
    };

/** What a new unit is brought from the people's decisions on the change it is unchanged from. */
export type UnitAnswer =
  /** Each person with something to bring, by actor ID. */
  | { readonly kind: "known"; readonly people: ReadonlyArray<PersonAnswer> }
  /**
   * A person has more than `ActsReadMax` acts newer than any about the unit, or (keys not known)
   * more than `ConnectedUnitsMax` units are connected: nothing is brought for anyone.
   */
  | { readonly kind: "not-known" };

/** A new unit as `lastActs` is asked of it. */
export interface NewUnit {
  /**
   * The compared units it is wholly unchanged from, each of which holds all its changes: the only
   * units a decision may be carried from.
   */
  readonly units: ReadonlyArray<string>;
  /**
   * The other compared units in which it has at least one unchanged change (they hold some of its
   * changes, or more besides): nothing is carried from them. With `sectionKeys` known, which acts
   * count does not depend on them; without, the connected walk starts from them too. Absent: none.
   */
  readonly sharing?: ReadonlyArray<string> | undefined;
  /**
   * Its section keys: its changes. A person's acts about it are those on every unit in the store
   * that holds at least one of them. Null or empty when not known: the acts on the units connected
   * to `units` and `sharing` through lineage count.
   */
  readonly sectionKeys: ReadonlyArray<string> | null;
  /**
   * The files its changes are in. With `sectionKeys` known, an act on an older-shape unit (owned
   * ranges, no sections) counts only when one of its ranges is in one of these files. Absent, null
   * or empty: every older-shape unit counts.
   */
  readonly paths?: ReadonlyArray<string> | null | undefined;
}

type Act = {
  readonly kind: "decision" | "retraction";
  readonly id: string;
  readonly seq: number;
  /** For a retraction, the disposition it retracted. */
  readonly target: string | null;
  readonly unitId: string;
  readonly cycleId: string;
};

/** One person's acts as read so far, newest first, and where the next page starts. */
type ActsRead = {
  readonly list: Array<Act>;
  /** The `seq` the next page reads below; null once every act is read. */
  below: number | null;
};

/** The units lineage connects (keys not known only), read once, with their acts once read. */
type Component = {
  readonly units: Array<string>;
  known: boolean;
  /** Each registered person's acts on these units, oldest first; read once. */
  acts?: ReadonlyMap<string, ReadonlyArray<Act>>;
};

/** What the store shows a unit holds, for deciding whether an act on it is about a new unit. */
type Holds =
  | { readonly kind: "keys"; readonly keys: ReadonlySet<string> }
  | { readonly kind: "paths"; readonly paths: ReadonlySet<string> }
  | { readonly kind: "not-known" };

/** What a person's walk of their acts for one new unit ends with. */
type Walked =
  | { readonly kind: "act"; readonly act: Act }
  | { readonly kind: "none" }
  | { readonly kind: "not-known" };

const PAGE = 500;
/** A person's acts are read this many at a time, newest first, and only as a walk needs them. */
const ACTS_PAGE = 256;

const pages = <A>(items: ReadonlyArray<A>) => {
  const out: Array<ReadonlyArray<A>> = [];
  for (let n = 0; n < items.length; n += PAGE)
    out.push(items.slice(n, n + PAGE));
  return out;
};

/**
 * The reads `lastActs` and `personDecidedUnitsOf` share within one call, each done once: which
 * actors are registered people, whether a retraction counted, the recorded decision behind each
 * disposition, each person's acts as far as a walk has read them, each unit's section keys, and
 * each unit's current dispositions.
 */
const reading = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const max = yield* ActsReadMax;
  const connectedMax = yield* ConnectedUnitsMax;

  const humanOf = new Map<string, boolean>();
  const isHuman = (actorId: string) =>
    Effect.gen(function* () {
      const known = humanOf.get(actorId);
      if (known !== undefined) return known;
      const [row] = yield* sql<{
        actorKind: string;
      }>`SELECT actor_kind FROM projection_actors WHERE actor_id = ${actorId}`;
      const human = row?.actorKind === "human";
      humanOf.set(actorId, human);
      return human;
    });

  // A retraction is an act only when it withdrew the person's standing decision: the one
  // `Dispositions.current` would have named for them on its unit on the store as it was just
  // before the retraction was appended. That is the newest by ID of their decisions (carried
  // ones included) appended before it that nothing of theirs appended before it superseded.
  // "Before" is the store's append order (`seq`), not ID order: a carried decision is minted on
  // the publisher's clock, which can run ahead of the clock the person's retraction is minted
  // on, while a retraction is appended only after its target. A retraction of any other
  // decision withdrew nothing.
  const countedOf = new Map<string, boolean>();
  const counts = (actorId: string, act: Act) =>
    Effect.gen(function* () {
      const known = countedOf.get(act.id);
      if (known !== undefined) return known;
      let result = false;
      if (act.target !== null) {
        const [standing] = yield* sql<{
          standing: string | null;
        }>`WITH all_dispositions AS ${sql.literal(dispositionRows)}, retraction AS (SELECT ${act.seq} AS seq)
          SELECT max(d.event_id) AS standing FROM all_dispositions d
            JOIN events de ON de.id = d.event_id, retraction r
          WHERE d.unit_id = ${act.unitId} AND d.cycle_id = ${act.cycleId} AND d.actor_id = ${actorId}
            AND de.seq < r.seq AND ${sql.literal(liveDisposition("d", "r.seq"))}`;
        result = standing?.standing === act.target;
      }
      countedOf.set(act.id, result);
      return result;
    });

  // The recorded decision behind a disposition: itself, or through each carried copy's
  // `from.judgement` the one it copies, followed to its end. A copy enters the store after what it
  // copies, so each step goes to a smaller `seq` and the walk ends; a step that does not, an event
  // that cannot be read, or one that is not a decision, means it is no recorded decision (null).
  const behind = new Map<
    string,
    { readonly seq: number | null; readonly recorded: RecordedDecision | null }
  >();
  const recordedOf = (id: string) =>
    Effect.gen(function* () {
      const path: Array<{ readonly id: string; readonly seq: number }> = [];
      let at = id;
      let result: RecordedDecision | null;
      for (;;) {
        const below = path.at(-1)?.seq;
        const known = behind.get(at);
        if (known !== undefined) {
          result =
            below !== undefined && (known.seq === null || known.seq >= below)
              ? null
              : known.recorded;
          break;
        }
        const held = yield* get(at);
        if (Option.isNone(held)) {
          behind.set(at, { seq: null, recorded: null });
          result = null;
          break;
        }
        const { event, seq } = held.value;
        if (below !== undefined && seq >= below) {
          result = null;
          break;
        }
        if (
          event.kind === "disposition.recorded@1" ||
          event.kind === "disposition.recorded@2"
        ) {
          result = { id: at, seq };
          behind.set(at, { seq, recorded: result });
          break;
        }
        if (event.kind !== "disposition.carried@1") {
          behind.set(at, { seq, recorded: null });
          result = null;
          break;
        }
        path.push({ id: at, seq });
        at = event.payload.from.judgement;
      }
      for (const step of path)
        behind.set(step.id, { seq: step.seq, recorded: result });
      return result;
    });

  // The registered people, by actor ID: only their own decisions and retractions are acts.
  let peopleRead: ReadonlyArray<string> | undefined;
  const everyone = Effect.gen(function* () {
    if (peopleRead !== undefined) return peopleRead;
    const rows = yield* sql<{
      actorId: string;
    }>`SELECT actor_id FROM projection_actors WHERE actor_kind = 'human'`;
    peopleRead = rows.map((row) => row.actorId).sort();
    for (const actorId of peopleRead) humanOf.set(actorId, true);
    return peopleRead;
  });

  // A person's acts, newest first in the store's append order (`seq`): the decisions they recorded
  // themselves and their retractions, on any unit, read from the event log by actor and kind a
  // page at a time, and only as far as a walk asks. A carried copy is never an act: the publisher
  // wrote it. An act whose attribution names no unit or cycle is about no unit and is skipped.
  //
  // Why every withdrawal of a copy is found: a copy stands on its own unit, and withdrawing it is
  // an act on that unit (`counts`: it withdrew what stood for the person there). The copy's unit
  // holds the new unit's section keys exactly when the copy is about the same change, since the
  // publisher carries a decision only to a unit every section of which has the same key in the
  // unit it was carried from. So the withdrawal is read for every new unit about that change,
  // whether or not any lineage entry joins the units.
  const actsOf = new Map<string, ActsRead>();
  const actAt = (actorId: string, n: number) =>
    Effect.gen(function* () {
      let acts = actsOf.get(actorId);
      if (acts === undefined) {
        acts = { list: [], below: Number.MAX_SAFE_INTEGER };
        actsOf.set(actorId, acts);
      }
      while (acts.list.length <= n && acts.below !== null) {
        const rows = yield* sql<{
          id: string;
          seq: number;
          kind: string;
          target: string | null;
          unitId: string | null;
          cycleId: string | null;
        }>`SELECT e.id, e.seq, e.kind,
            json_extract(e.envelope, '$.causation.supersedes') AS target,
            json_extract(e.envelope, '$.attribution.unitIds[0]') AS unit_id,
            json_extract(e.envelope, '$.attribution.cycleId') AS cycle_id
          FROM events e
          WHERE e.actor_id = ${actorId}
            AND e.kind IN ('disposition.recorded@1', 'disposition.recorded@2', 'disposition.retracted@1')
            AND e.seq < ${acts.below}
          ORDER BY e.seq DESC LIMIT ${ACTS_PAGE}`;
        for (const row of rows)
          if (row.unitId !== null && row.cycleId !== null)
            acts.list.push({
              kind:
                row.kind === "disposition.retracted@1"
                  ? "retraction"
                  : "decision",
              id: row.id,
              seq: row.seq,
              target: row.target,
              unitId: row.unitId,
              cycleId: row.cycleId,
            });
        acts.below = rows.length < ACTS_PAGE ? null : rows.at(-1)!.seq;
      }
      return acts.list[n];
    });
  // Keys not known only. Why the walk stays for this path alone: an old-shape unit has no section
  // keys to match on, so the store-wide rule cannot tell which units hold its change, and the
  // publisher always asks with keys, so it never comes here. The change is then the units
  // connected to the given ones, as before the store-wide rule: through lineage links that count
  // at least one unchanged change (`unchanged >= 1`, whatever the entry's `relation`), both ways:
  // a `lineage.recorded@1` is attributed to its successor and then its earlier units, so the unit
  // index finds it from either side. Each unit belongs to one set, read once; a set past
  // `connectedMax` is not known, and so is one that meets a set already cut short. A copy's
  // withdrawal is found here because the publisher writes a unit's lineage and its copies in one
  // append and refuses a copy whose unit's lineage was refused (`appendSettled`,
  // packages/harness/src/publish-sections.ts), so a copy's unit is connected to the unit it copies.
  //
  // Each read here drives from the unit index (`CROSS JOIN` fixes the join order): with a page of
  // unit IDs, SQLite otherwise starts from `events_kind` and reads every event of the kind in the
  // store, so the walk's cost would grow with the store rather than with the change.
  const componentOf = new Map<string, Component>();
  const linked = (units: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const found = new Map<string, Set<string>>();
      for (const page of pages(units)) {
        const rows = yield* sql<{
          unitId: string;
          successor: string | null;
          fromJson: string | null;
        }>`SELECT u.unit_id, json_extract(e.envelope, '$.attribution.unitIds[0]') AS successor,
            json_extract(e.envelope, '$.payload.from') AS from_json
          FROM event_units u CROSS JOIN events e ON e.seq = u.event_seq
          WHERE ${sql.in("u.unit_id", page)} AND e.kind = 'lineage.recorded@1'`;
        for (const row of rows) {
          if (row.successor === null || row.fromJson === null) continue;
          let from: ReadonlyArray<{ unitId?: unknown; unchanged?: unknown }>;
          try {
            const parsed = JSON.parse(row.fromJson) as unknown;
            from = Array.isArray(parsed) ? parsed : [];
          } catch {
            continue;
          }
          const unchanged = from.flatMap((entry) =>
            typeof entry.unchanged === "number" &&
            entry.unchanged >= 1 &&
            typeof entry.unitId === "string"
              ? [entry.unitId]
              : [],
          );
          const next = found.get(row.unitId) ?? new Set<string>();
          if (row.successor === row.unitId)
            for (const earlier of unchanged) next.add(earlier);
          else if (unchanged.includes(row.unitId)) next.add(row.successor);
          found.set(row.unitId, next);
        }
      }
      return found;
    });
  const connect = (start: string) =>
    Effect.gen(function* () {
      if (componentOf.has(start)) return;
      const component: Component = { units: [start], known: true };
      componentOf.set(start, component);
      let frontier: Array<string> = [start];
      while (frontier.length > 0 && component.known) {
        const next: Array<string> = [];
        const links = yield* linked(frontier);
        for (const unitId of frontier)
          for (const other of links.get(unitId) ?? []) {
            const held = componentOf.get(other);
            if (held === component) continue;
            if (held !== undefined) {
              held.known = false;
              component.known = false;
              continue;
            }
            if (component.units.length >= connectedMax) {
              component.known = false;
              break;
            }
            componentOf.set(other, component);
            component.units.push(other);
            next.push(other);
          }
        frontier = next;
      }
    });

  // A set's acts: the decisions registered people recorded themselves on its units and their
  // retractions there, in the store's append order. A carried copy is never an act: the publisher
  // wrote it. One indexed read per page of units.
  const componentActs = (component: Component) =>
    Effect.gen(function* () {
      if (component.acts !== undefined) return component.acts;
      const byActor = new Map<string, Array<Act>>();
      const seen = new Set<string>();
      for (const page of pages(component.units)) {
        const rows = yield* sql<{
          id: string;
          seq: number;
          kind: string;
          actorId: string;
          target: string | null;
          unitId: string | null;
          cycleId: string | null;
        }>`SELECT e.id, e.seq, e.kind, e.actor_id,
            json_extract(e.envelope, '$.causation.supersedes') AS target,
            json_extract(e.envelope, '$.attribution.unitIds[0]') AS unit_id,
            json_extract(e.envelope, '$.attribution.cycleId') AS cycle_id
          FROM event_units u CROSS JOIN events e ON e.seq = u.event_seq
          WHERE ${sql.in("u.unit_id", page)}
            AND e.kind IN ('disposition.recorded@1', 'disposition.recorded@2', 'disposition.retracted@1')`;
        for (const row of rows) {
          if (seen.has(row.id) || row.unitId === null || row.cycleId === null)
            continue;
          seen.add(row.id);
          if (!(yield* isHuman(row.actorId))) continue;
          const list = byActor.get(row.actorId) ?? [];
          list.push({
            kind:
              row.kind === "disposition.retracted@1"
                ? "retraction"
                : "decision",
            id: row.id,
            seq: row.seq,
            target: row.target,
            unitId: row.unitId,
            cycleId: row.cycleId,
          });
          byActor.set(row.actorId, list);
        }
      }
      for (const list of byActor.values()) list.sort((a, b) => a.seq - b.seq);
      component.acts = byActor;
      return byActor;
    });
  // What the store shows a unit holds, from its newest recording: a version 3 unit's section keys,
  // from its sections blob; an older-shape unit's files (`unit.recorded@1`/`@2` carry their owned
  // ranges in the event, so no blob is read); otherwise nothing known (no recording, or a version
  // 3 unit whose blob is missing, pruned or undecodable: store damage). Read once per unit per
  // call, and only for units a walk reaches. The read drives from the unit index (`CROSS JOIN`
  // fixes the join order): SQLite otherwise starts from `events_kind` and reads every recording in
  // the store.
  const holdsOf = new Map<string, Holds>();
  const readHolds = (units: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const wanted = [...new Set(units)].filter((u) => !holdsOf.has(u));
      for (const page of pages(wanted)) {
        const rows = yield* sql<{
          unitId: string;
          id: string;
          first: string | null;
        }>`SELECT u.unit_id, e.id, json_extract(e.envelope, '$.attribution.unitIds[0]') AS first
          FROM event_units u CROSS JOIN events e ON e.seq = u.event_seq
          WHERE ${sql.in("u.unit_id", page)}
            AND e.kind IN ('unit.recorded@1', 'unit.recorded@2', 'unit.recorded@3')`;
        const newest = new Map<string, string>();
        for (const row of rows)
          if (
            row.first === row.unitId &&
            (newest.get(row.unitId) ?? "") < row.id
          )
            newest.set(row.unitId, row.id);
        for (const unitId of page) {
          let holds: Holds = { kind: "not-known" };
          const id = newest.get(unitId);
          const held = id === undefined ? Option.none() : yield* get(id);
          if (Option.isSome(held) && isUnitEvent(held.value.event)) {
            const event = held.value.event;
            const ranges = yield* unitRanges(event);
            if (ranges._tag === "Ranges")
              if (event.kind === "unit.recorded@3") {
                if (ranges.sections !== undefined)
                  holds = {
                    kind: "keys",
                    keys: new Set(
                      ranges.sections.map((section) => section.key),
                    ),
                  };
              } else
                holds = {
                  kind: "paths",
                  paths: new Set(ranges.ranges.map((range) => range.path)),
                };
          }
          holdsOf.set(unitId, holds);
        }
      }
    });

  // A person's last act about a new unit: walking their acts newest first, the first decision or
  // counted retraction on a unit that may hold one of the new unit's changes. A unit is passed
  // over only when the store shows it holds none: a version 3 unit whose section keys share none
  // with `keys` (`unchanged` is decided on the same key equality, so an act on it is about changes
  // the new unit does not hold), or an older-shape unit none of whose owned ranges is in a file of
  // `paths` (null: the new unit's files are not given, so it counts). A unit whose holdings cannot
  // be read counts: the store cannot show it does not hold the change. A unit is read only as the
  // walk reaches it, and the walk stops at the first act about the new unit, so older acts are
  // never read. Past `max` acts read without one, the answer is not known.
  const lastOf = (
    actorId: string,
    keys: ReadonlySet<string>,
    paths: ReadonlySet<string> | null,
  ) =>
    Effect.gen(function* () {
      for (let n = 0; ; n++) {
        const act = yield* actAt(actorId, n);
        if (act === undefined) return { kind: "none" } as Walked;
        if (n >= max) return { kind: "not-known" } as Walked;
        yield* readHolds([act.unitId]);
        const holds = holdsOf.get(act.unitId)!;
        if (
          holds.kind === "keys" &&
          ![...holds.keys].some((key) => keys.has(key))
        )
          continue;
        if (
          holds.kind === "paths" &&
          paths !== null &&
          ![...holds.paths].some((path) => paths.has(path))
        )
          continue;
        if (act.kind === "decision" || (yield* counts(actorId, act)))
          return { kind: "act", act } as Walked;
      }
    });

  const currentOf = new Map<
    string,
    ReadonlyArray<{ readonly eventId: string; readonly actorId: string }>
  >();
  const currentOn = (unitId: string) =>
    Effect.gen(function* () {
      const known = currentOf.get(unitId);
      if (known !== undefined) return known;
      const now = (yield* dispositionsNow({ unitId })).map((d) => ({
        eventId: d.eventId,
        actorId: d.actorId,
      }));
      currentOf.set(unitId, now);
      return now;
    });

  // Keys not known: a person's last act over the connected sets, their newest decision or counted
  // retraction there.
  const lastConnected = (components: ReadonlyArray<Component>) =>
    Effect.gen(function* () {
      const last = new Map<string, Act>();
      for (const component of components)
        for (const [actorId, acts] of yield* componentActs(component))
          for (let n = acts.length - 1; n >= 0; n--) {
            const act = acts[n]!;
            const known = last.get(actorId);
            if (known !== undefined && known.seq >= act.seq) break;
            if (act.kind === "decision" || (yield* counts(actorId, act))) {
              last.set(actorId, act);
              break;
            }
          }
      return last;
    });

  /** See `lastActs`. */
  const answer = (asked: ReadonlyArray<NewUnit>) =>
    Effect.gen(function* () {
      const keysOf = (sectionKeys: ReadonlyArray<string> | null) =>
        sectionKeys === null || sectionKeys.length === 0
          ? null
          : new Set(sectionKeys);
      // Keys not known: every set is connected first, so a set cut short is known as such before
      // any answer.
      for (const { units, sharing = [], sectionKeys } of asked)
        if (keysOf(sectionKeys) === null)
          for (const unitId of [...units, ...sharing]) yield* connect(unitId);
      const answers: Array<UnitAnswer> = [];
      for (const { units, sharing = [], sectionKeys, paths: files } of asked) {
        const keys = keysOf(sectionKeys);
        const paths =
          files === undefined || files === null || files.length === 0
            ? null
            : new Set(files);
        // Each person's last act about the new unit, by actor ID; null when not known.
        let lasts: Array<readonly [string, Act]> | null = [];
        if (keys === null) {
          const components = [
            ...new Set(
              [...units, ...sharing].map((unitId) => componentOf.get(unitId)!),
            ),
          ];
          if (components.some((component) => !component.known)) lasts = null;
          else
            lasts = [...(yield* lastConnected(components))].sort(([a], [b]) =>
              a < b ? -1 : a > b ? 1 : 0,
            );
        } else
          for (const actorId of yield* everyone) {
            const walked = yield* lastOf(actorId, keys, paths);
            if (walked.kind === "not-known") {
              lasts = null;
              break;
            }
            if (walked.kind === "act") lasts.push([actorId, walked.act]);
          }
        if (lasts === null) {
          answers.push({ kind: "not-known" });
          continue;
        }
        const people: Array<PersonAnswer> = [];
        for (const [actorId, last] of lasts) {
          if (last.kind === "retraction") continue;
          const decision = { id: last.id, seq: last.seq };
          // Where a compared unit holds it: the decision itself first, else the copy that entered
          // the store last, so the choice never follows reading order.
          let held:
            | { unitId: string; eventId: string; own: boolean; seq: number }
            | undefined;
          for (const unitId of units)
            for (const d of yield* currentOn(unitId)) {
              if (d.actorId !== actorId) continue;
              const recorded = yield* recordedOf(d.eventId);
              if (recorded?.id !== decision.id) continue;
              const candidate = {
                unitId,
                eventId: d.eventId,
                own: d.eventId === decision.id,
                seq: behind.get(d.eventId)?.seq ?? -1,
              };
              if (
                held === undefined ||
                (candidate.own && !held.own) ||
                (candidate.own === held.own && candidate.seq > held.seq)
              )
                held = candidate;
            }
          people.push(
            held === undefined
              ? { kind: "withheld", actorId, decision }
              : {
                  kind: "carry",
                  actorId,
                  decision,
                  unitId: held.unitId,
                  eventId: held.eventId,
                },
          );
        }
        answers.push({ kind: "known", people });
      }
      return answers;
    });

  return { isHuman, counts, recordedOf, answer };
});

/**
 * What each registered person's decisions bring to each new unit asked of (the earlier units it
 * is unchanged from, the compared units, and its section keys), in the order given. The one
 * answer the publisher carries from and a reader treats a unit as decided by.
 *
 * The rule: a person's last act, in the store's append order (`events.seq`), on the same unchanged
 * change decides. The same change is a section key: their acts about the new unit are those on
 * every unit in the store that holds at least one of its section keys, whether or not any lineage
 * entry joins that unit to the given ones (lineage is written against what was published before,
 * so the order reviews were published in must not decide whose acts count). An older-shape unit
 * (owned ranges, no sections) counts when one of its ranges is in a file of the new unit's
 * `paths` (every one counts when they are not given); a version 3 unit whose sections cannot be
 * read counts, since the store cannot show it does not hold the change. A new unit asked with no keys (an old-shape unit, which only `decidedBy`
 * asks of; the publisher always asks with keys) has nothing to match on: its acts are those on
 * the units connected to `units` and `sharing` through lineage links that count at least one
 * unchanged change, either way, as before this rule. Their acts are the decisions
 * they recorded themselves and their retractions that withdrew what stood for them on its unit
 * just before it; a carried copy is not an act. A withdrawal as the last act, or no act, brings
 * nothing. A decision as the last act is `carry` when one of `units` (never `sharing`) holds it or
 * a standing copy of it, else `withheld`. Never an older decision. A person with more than
 * `ActsReadMax` acts newer than any about the new unit makes its answer `not-known`; so do more
 * than `ConnectedUnitsMax` connected units for a unit asked with no keys.
 *
 * Cost: the registered people once per call; per person, their acts by actor and kind, newest
 * first, a page at a time and only as far as a walk reaches (shared by every new unit of the
 * call); per unit a walk reaches, one read of its recordings and one event, and for a version 3
 * unit one sections blob, once per call; per person with a decision as their last act, one read of each given unit's
 * current dispositions (shared) and one read per copy followed back; one count query per
 * retraction about the new unit. With no keys: one read of lineage per page of units reached and
 * one of acts per connected set, each from the unit index and shared by the call.
 */
export const lastActs = (asked: ReadonlyArray<NewUnit>) =>
  Effect.gen(function* () {
    yield* assertCompatible;
    const read = yield* reading;
    return yield* read.answer(asked);
  }).pipe(Effect.withSpan("records.lineage.last-acts"));

/** A unit of an earlier packet that holds a registered human's current disposition. */
export interface PersonDecidedUnit {
  readonly unitId: string;
  readonly cycleId: string;
  /** Its file: a version 3 unit's path, else the first path its ranges name; null when none. */
  readonly path: string | null;
  /** A version 3 unit's key; null for a unit of the old shape. */
  readonly key: string | null;
  /** From its sections blob; empty for an old-shape unit or a blob that cannot be read. */
  readonly sectionKeys: ReadonlyArray<string>;
  /** As its newest recorded assessment says; null when it has none. */
  readonly lane: Lane | null;
  /** `computation:<hash>` of its version 4 assessment's judgements; null otherwise. */
  readonly judgements: string | null;
  /** `blob:<hash>` of its version 3 sections blob; null for an old-shape unit. */
  readonly sections: string | null;
  readonly decisions: ReadonlyArray<{
    readonly dispositionId: string;
    readonly actorId: string;
    readonly verdict: "approve" | "request-changes";
    /**
     * The decision's place in the store's append order (`events.seq`): when it entered the store.
     * The order of a person's acts is this order, never their IDs'.
     */
    readonly seq: number;
    /**
     * The decision the person actually recorded that this one is or copies (through each carried
     * decision's `from.judgement`, to its end), with its place in the store's order; the
     * disposition itself when the copies cannot be followed back to one.
     */
    readonly recorded: RecordedDecision;
  }>;
  /**
   * Registered people's retractions on the unit that count as acts, oldest first in the store's
   * append order: those that withdrew the person's own standing decision. A retraction of a
   * decision the same person had already superseded withdrew nothing and is not listed.
   */
  readonly retractions: ReadonlyArray<{
    readonly retractionId: string;
    readonly actorId: string;
    /** The disposition it retracted. */
    readonly retracted: string;
    /** The retraction's place in the store's append order (`events.seq`). */
    readonly seq: number;
  }>;
  /**
   * The registered people `lastActs` asked of this unit alone answers `carry` for: their last act
   * on any unit holding one of its section keys is a decision that stands on it, itself or a copy.
   * Kept for compatibility; a reader deciding what a new unit carries asks `lastActs` with every
   * unit the new unit is unchanged from, and never `decisions.length`: a unit is listed for a
   * retraction too.
   */
  readonly decidedBy: ReadonlyArray<string>;
}

/**
 * The units of these packets where a registered human acted: their current dispositions (carried
 * ones included; a retracted or superseded one is not current) and the retractions that count as
 * acts, with what a caller needs to match the units by section and to read their judgements.
 * `decidedBy` names the people `lastActs` would carry from the unit; what a new unit carries is
 * `lastActs`'s answer.
 */
export const personDecidedUnitsOf = (packets: ReadonlyArray<EarlierPacket>) =>
  Effect.gen(function* () {
    yield* assertCompatible;
    const sql = yield* SqlClient;
    const blobs = yield* BlobStore;
    const read = yield* reading;
    const found: Array<Omit<PersonDecidedUnit, "decidedBy">> = [];
    // Each found unit's files, for `lastActs`: its path and every path its ranges name.
    const filesOf: Array<ReadonlyArray<string>> = [];
    for (const { packetId } of packets) {
      const held = yield* get(packetId);
      if (Option.isNone(held)) continue;
      const packet = held.value.event;
      if (
        packet.kind !== "packet.published@1" &&
        packet.kind !== "packet.published@2"
      )
        continue;
      const ref = packet.refs[0].ref;
      if (!ref.startsWith("blob:")) continue;
      const blob = yield* Effect.result(blobs.get(ref.slice("blob:".length)));
      if (blob._tag === "Failure" || blob.success._tag === "Pruned") continue;
      let json: unknown;
      try {
        json = JSON.parse(new TextDecoder().decode(blob.success.bytes));
      } catch {
        continue;
      }
      const manifest = safeRead(PacketManifest, json);
      if (!manifest.success) continue;
      const cycleId = packet.attribution.cycleId;
      for (const batch of manifest.data.batches) {
        const events: Array<RecordEvent> = [];
        const seen = new Set<string>();
        for (const named of [
          ...batch.events,
          ...batch.units.flatMap((unit) => unit.events ?? []),
        ]) {
          if (typeof named.id !== "string" || seen.has(named.id)) continue;
          seen.add(named.id);
          const event = yield* get(named.id);
          if (Option.isSome(event)) events.push(event.value.event);
        }
        for (const unit of batch.units) {
          const current = yield* dispositionsNow({
            unitId: unit.unitId,
            cycleId,
          });
          const retracted = yield* sql<{
            id: string;
            seq: number;
            actorId: string;
            target: string | null;
          }>`SELECT e.id, e.seq, e.actor_id, json_extract(e.envelope, '$.causation.supersedes') AS target
            FROM event_units u JOIN events e ON e.seq = u.event_seq
            WHERE u.unit_id = ${unit.unitId} AND e.kind = 'disposition.retracted@1'
              AND json_extract(e.envelope, '$.attribution.cycleId') = ${cycleId}
            ORDER BY e.seq`;
          if (current.length === 0 && retracted.length === 0) continue;
          const decisions: Array<PersonDecidedUnit["decisions"][number]> = [];
          for (const d of current) {
            if (!(yield* read.isHuman(d.actorId))) continue;
            const [row] = yield* sql<{
              seq: number;
            }>`SELECT seq FROM events WHERE id = ${d.eventId}`;
            if (row === undefined) continue;
            decisions.push({
              dispositionId: d.eventId,
              actorId: d.actorId,
              verdict: d.verdict,
              seq: row.seq,
              recorded: (yield* read.recordedOf(d.eventId)) ?? {
                id: d.eventId,
                seq: row.seq,
              },
            });
          }
          const retractions: Array<PersonDecidedUnit["retractions"][number]> =
            [];
          for (const r of retracted) {
            if (!(yield* read.isHuman(r.actorId)) || r.target === null)
              continue;
            if (
              yield* read.counts(r.actorId, {
                kind: "retraction",
                id: r.id,
                seq: r.seq,
                target: r.target,
                unitId: unit.unitId,
                cycleId,
              })
            )
              retractions.push({
                retractionId: r.id,
                actorId: r.actorId,
                retracted: r.target,
                seq: r.seq,
              });
          }
          if (decisions.length === 0 && retractions.length === 0) continue;
          const on = events.filter(
            (e) =>
              (e.attribution as { unitIds?: ReadonlyArray<string> } | undefined)
                ?.unitIds?.[0] === unit.unitId,
          );
          const newest = <E extends RecordEvent>(list: ReadonlyArray<E>) =>
            list.reduce<E | undefined>(
              (best, e) => (best === undefined || e.id > best.id ? e : best),
              undefined,
            );
          const recording = newest(on.filter(isUnitEvent));
          const assessment = newest(
            on.filter(
              (
                e,
              ): e is Extract<
                RecordEvent,
                {
                  kind:
                    | "assessment.recorded@1"
                    | "assessment.recorded@2"
                    | "assessment.recorded@3"
                    | "assessment.recorded@4";
                }
              > => e.kind.startsWith("assessment.recorded@"),
            ),
          );
          const ranges =
            recording === undefined ? undefined : yield* unitRanges(recording);
          const v3 =
            recording?.kind === "unit.recorded@3" ? recording : undefined;
          filesOf.push([
            ...new Set([
              ...(v3 === undefined ? [] : [v3.payload.path]),
              ...(ranges?._tag === "Ranges"
                ? ranges.ranges.map((range) => range.path)
                : []),
            ]),
          ]);
          found.push({
            unitId: unit.unitId,
            cycleId,
            path:
              v3?.payload.path ??
              (ranges?._tag === "Ranges"
                ? ranges.ranges[0]?.path
                : undefined) ??
              null,
            key: v3?.payload.key ?? null,
            sectionKeys:
              v3 !== undefined && ranges?._tag === "Ranges"
                ? (ranges.sections ?? []).map((section) => section.key)
                : [],
            lane: assessment?.payload.lane ?? null,
            judgements:
              assessment?.kind === "assessment.recorded@4"
                ? assessment.refs[0].ref
                : null,
            sections: v3?.refs[0].ref ?? null,
            decisions,
            retractions,
          });
        }
      }
    }
    // Each unit asked alone with its own section keys and files, so a person is named on a unit only when
    // their last act about its changes is a decision that stands on it: never where `lastActs`
    // would carry nothing of theirs from it.
    const answers = yield* read.answer(
      found.map((unit, n) => ({
        units: [unit.unitId],
        sectionKeys: unit.sectionKeys.length === 0 ? null : unit.sectionKeys,
        paths: filesOf[n]!,
      })),
    );
    return found.map((unit, n): PersonDecidedUnit => ({
      ...unit,
      decidedBy:
        answers[n]!.kind === "known"
          ? answers[n]!.people.flatMap((person) =>
              person.kind === "carry" ? [person.actorId] : [],
            )
          : [],
    }));
  }).pipe(Effect.withSpan("records.lineage.person-decided-units"));

/**
 * The units of the earlier packets a review of `cycleId` compares with (`earlierReview`) that a
 * registered human has a current disposition on: for the readers lane, which shows earlier
 * decisions beside the units that now hold their sections. What a new unit carries from them is
 * `lastActs`'s answer for the units it is unchanged from.
 */
export const personDecidedUnits = <R>(input: {
  readonly cycleId: string;
  readonly isAncestor: IsAncestor<R>;
}) =>
  Effect.flatMap(earlierReview(input), (packets) =>
    personDecidedUnitsOf(packets),
  );
