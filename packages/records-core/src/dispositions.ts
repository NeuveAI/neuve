import { safeRead } from "@neuve/records-schema";
import {
  carriedDispositionRows,
  recordedDispositionRows,
} from "./carried-relations.ts";
import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import type { Fragment } from "effect/sql/Statement";
import { DispositionView, Lane } from "@neuve/records-schema";
import { CorruptRecord } from "./errors.ts";
import { assertCompatible } from "./store.ts";

/**
 * SQL that holds for a `projection_dispositions` row (under `alias`) whose own author has not
 * superseded it by a later disposition or a retraction. The one definition of a live disposition.
 * With `before`, an SQL expression for an event's `seq`, only superseding events the store appended
 * before that event count: the disposition was live on the store as it was just before it.
 *
 * Both checks read only what names the row, whatever the store holds: the first from the row's
 * supersession links, the second from the events on the row's unit. A carried copy's supersession
 * is read from the log, and a carried copy names one unit; the append rule `supersedes-other-unit`
 * refuses a copy whose target is on another unit, so every copy that supersedes the row is on the
 * row's unit. `alias` must name a row whose `unit_id` is its own unit, as every row of
 * `dispositionRows` does. `CROSS JOIN` keeps SQLite from leading with the log's actor or kind
 * index, which holds every event that actor or kind ever recorded.
 */
export const liveDisposition = (alias: string, before?: string) => {
  const bound = before === undefined ? "" : ` AND e.seq < ${before}`;
  return `NOT EXISTS (SELECT 1 FROM projection_supersessions s CROSS JOIN events e ON e.id = s.by_event_id
    WHERE s.target_id = ${alias}.event_id AND e.actor_id = ${alias}.actor_id
    AND e.kind IN ('disposition.recorded@1', 'disposition.recorded@2', 'disposition.retracted@1')${bound})
    AND NOT EXISTS (SELECT 1 FROM event_units u CROSS JOIN events e ON e.seq = u.event_seq
      WHERE u.unit_id = ${alias}.unit_id AND e.kind = 'disposition.carried@1' AND e.actor_id = ${alias}.actor_id
      AND json_extract(e.envelope, '$.causation.supersedes') = ${alias}.event_id${bound})`;
};

/**
 * The rows of `dispositionRows` that pass `recorded` (on `projection_dispositions`) and `carried`
 * (on the log's `disposition.carried@1` events). The filters sit inside the two halves: SQLite
 * materializes rows a statement reads twice once per statement, so a filter outside them would read
 * every disposition in the store first.
 */
const filteredDispositionRows = (
  sql: SqlClient,
  recorded: ReadonlyArray<Fragment>,
  carried: ReadonlyArray<Fragment>,
) =>
  sql`${sql.literal(recordedDispositionRows)} WHERE ${sql.and(recorded)}
      UNION ALL ${sql.literal(carriedDispositionRows)} AND ${sql.and(carried)}`;

/**
 * The rows of `dispositionRows` on `unitIds` (a page of at most `PAGE`, never empty): recorded ones
 * through the dispositions' (unit, cycle, actor) index, carried ones through the log's unit index.
 * A reader that compares a row with others of its unit and cycle reads these instead of every row.
 */
export const dispositionRowsOn = (
  sql: SqlClient,
  unitIds: ReadonlyArray<string>,
) =>
  filteredDispositionRows(
    sql,
    [sql.in("unit_id", unitIds)],
    [
      sql`seq IN (SELECT event_seq FROM event_units WHERE unit_id IN ${sql.in(unitIds)})`,
      sql`json_extract(envelope, '$.attribution.unitIds[0]') IN ${sql.in(unitIds)}`,
    ],
  );

/**
 * The statement `current` and `currentMany` run: the current dispositions among `rows`, filtered
 * rows of `dispositionRows`, in unit, cycle and actor order. A filter on units or a cycle keeps
 * every row of the same unit and cycle as a row it keeps, which is all the newest check compares a
 * row with, so filtering first changes no answer.
 */
const currentStatement = (sql: SqlClient, rows: Fragment) => {
  const live = (alias: string) => sql.literal(liveDisposition(alias));
  return sql<Record<string, unknown>>`WITH all_dispositions AS (${rows})
    SELECT d.event_id, d.unit_id, d.cycle_id, d.actor_id,
      d.verdict, d.reviewed_head_oid, d.rests_on_count, d.proof_count FROM all_dispositions d
    WHERE ${live("d")}
      AND d.event_id = (SELECT max(n.event_id) FROM all_dispositions n
        WHERE n.unit_id = d.unit_id AND n.cycle_id = d.cycle_id AND n.actor_id = d.actor_id AND ${live("n")})
    ORDER BY d.unit_id, d.cycle_id, d.actor_id`;
};

const readCurrent = (rows: ReadonlyArray<Record<string, unknown>>) =>
  Effect.forEach(rows, (row) => {
    const parsed = safeRead(DispositionView, row);
    return parsed.success
      ? Effect.succeed(parsed.data)
      : Effect.fail(
          new CorruptRecord({
            message: `projection_dispositions: ${parsed.error.message}`,
          }),
        );
  });

export interface CurrentFilter {
  readonly unitId?: string | undefined;
  readonly cycleId?: string | undefined;
}

/**
 * The statement `current` runs for `filter`, so a test can read its plan. Each filter reads through
 * an index: a unit, with or without a cycle, through the dispositions' (unit, cycle, actor) index
 * and the log's unit index; a cycle alone through the log's cycle index, which names every
 * disposition's cycle as its projection row does, since that index cannot lead with a cycle. Only
 * no filter reads every row.
 */
export const currentQuery = (filter: CurrentFilter) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const { unitId, cycleId } = filter;
    const recorded: Array<Fragment> = [];
    const carried: Array<Fragment> = [];
    if (unitId !== undefined) {
      recorded.push(sql`unit_id = ${unitId}`);
      carried.push(
        sql`seq IN (SELECT event_seq FROM event_units WHERE unit_id = ${unitId})`,
        sql`json_extract(envelope, '$.attribution.unitIds[0]') = ${unitId}`,
      );
    }
    if (cycleId !== undefined) {
      recorded.push(sql`cycle_id = ${cycleId}`);
      carried.push(
        sql`json_extract(envelope, '$.attribution.cycleId') = ${cycleId}`,
      );
      if (unitId === undefined) {
        recorded.push(
          sql`event_id IN (SELECT e.id FROM event_cycles c JOIN events e ON e.seq = c.event_seq
            WHERE c.cycle_id = ${cycleId})`,
        );
        carried.push(
          sql`seq IN (SELECT event_seq FROM event_cycles WHERE cycle_id = ${cycleId})`,
        );
      }
    }
    return currentStatement(
      sql,
      filteredDispositionRows(sql, recorded, carried),
    );
  });

/**
 * Current dispositions: for each actor on each unit in each cycle, the newest disposition by ULID that
 * no disposition or retraction by the same author supersedes. It reads only the projections and the
 * log's identity columns, never `seq`, so the answer does not depend on append order.
 */
export const current = (filter: CurrentFilter) =>
  Effect.gen(function* () {
    const statement = yield* currentQuery(filter);
    return yield* readCurrent(yield* statement);
  });

/** Unit IDs per `IN` list, well under SQLite's bound on host parameters, as `Lineage` pages them. */
const PAGE = 500;

/**
 * `current({ unitId })` for each of `unitIds` at once: every actor's current disposition on each
 * unit (people's, agents' and unregistered actors'), in every cycle, read a page of units at a time
 * through the same indexes. Every asked unit is a key, holding exactly what `current({ unitId })`
 * returns for it, in the same order; a unit with none holds an empty list.
 */
export const currentMany = (unitIds: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const asked = [...new Set(unitIds)];
    const byUnit = new Map<string, Array<DispositionView>>(
      asked.map((unitId) => [unitId, []]),
    );
    for (let at = 0; at < asked.length; at += PAGE) {
      const page = asked.slice(at, at + PAGE);
      const rows = yield* readCurrent(
        yield* currentStatement(sql, dispositionRowsOn(sql, page)),
      );
      for (const row of rows) byUnit.get(row.unitId)?.push(row);
    }
    return byUnit as ReadonlyMap<string, ReadonlyArray<DispositionView>>;
  }).pipe(Effect.withSpan("records.dispositions.current-many"));

/** A current disposition with what its actor is: a registered human, an agent, or neither. */
export interface JudgedDisposition extends DispositionView {
  readonly actorKind: "human" | "agent" | "unregistered";
  /** Recorded before the unit's current assessment, or while it had none. */
  readonly beforeAssessment: boolean;
}

/**
 * What a unit's current lane needs before its dispositions are in (4.11, 4.13): nothing on static
 * automation, a disposition by any reviewer on agentic and human-suggested work, a human's on
 * human-required work. A recorded unit the review never assessed reads as human-suggested (4.4,
 * 10.42, 10.100), so it needs a disposition too; `an-assessment` is left only for a unit Records
 * holds no record of.
 */
export type Needs =
  "no-disposition" | "a-disposition" | "a-human-disposition" | "an-assessment";

export interface UnitJudgement {
  readonly unitId: string;
  readonly cycleId: string | null;
  /** The current lane: human-suggested for a recorded unit the review never assessed (10.100). */
  readonly lane: Lane | null;
  readonly assessmentEventId: string | null;
  /** Whether Records holds an assessment for the unit; when it does not, the lane is read, not assessed. */
  readonly assessed: boolean;
  readonly needs: Needs;
  /** Whether every needed disposition is in, judged against the current lane only. */
  readonly closed: boolean;
  /** The current dispositions that close the unit under its current lane. */
  readonly closing: ReadonlyArray<JudgedDisposition>;
  /**
   * Current dispositions that do not close the unit under its current lane and reach its human
   * reviewer as context: on human-required work, every disposition not given by a human, including
   * approvals given before the unit was assessed or reassessed. They stay in the log as history;
   * there is no separate "no longer counts" state (4.13). On a unit Records holds no record of,
   * every disposition. On a recorded unit never assessed, none: it reads as human-suggested and the
   * agent's disposition applies (10.100 narrows 4.13 there).
   */
  readonly context: ReadonlyArray<JudgedDisposition>;
  /**
   * The disposition whose verdict stands, among those that close the unit: a person's current
   * disposition overrides an agent's (vocabulary: Decision dock, Agree; M5 RD6), and the newest
   * stands among several of the same kind. Null while nothing closes the unit by a disposition.
   */
  readonly standing: JudgedDisposition | null;
}

const LANE_NEEDS: Record<Lane, Needs> = {
  "static-automation": "no-disposition",
  agentic: "a-disposition",
  "human-suggested": "a-disposition",
  "human-required": "a-human-disposition",
};

/**
 * Judges a unit's current dispositions against its current lane (4.13). Pure, so the rule reads in
 * one place: earlier dispositions are never rewritten, only read differently when the lane changes.
 */
export const judgeDispositions = (
  unit: {
    readonly unitId: string;
    readonly cycleId: string | null;
    readonly lane: Lane | null;
    readonly assessmentEventId: string | null;
    /** Whether Records holds the unit's `unit.recorded`; false for an ID it knows nothing of. */
    readonly recorded?: boolean | undefined;
  },
  dispositions: ReadonlyArray<JudgedDisposition>,
): UnitJudgement => {
  const { recorded = true, ...identity } = unit;
  // 4.4, 10.42, 10.100: a recorded unit the review never assessed reads as human-suggested.
  const lane = unit.lane ?? (recorded ? ("human-suggested" as const) : null);
  const needs = lane === null ? "an-assessment" : LANE_NEEDS[lane];
  const counts = (disposition: JudgedDisposition) => {
    switch (needs) {
      case "an-assessment":
      case "no-disposition":
        return false;
      case "a-disposition":
        return true;
      case "a-human-disposition":
        return disposition.actorKind === "human";
    }
  };
  const closing = dispositions.filter(counts);
  const context =
    needs === "a-human-disposition" || needs === "an-assessment"
      ? dispositions.filter((disposition) => !counts(disposition))
      : [];
  const newest = (among: ReadonlyArray<JudgedDisposition>) =>
    among.reduce<JudgedDisposition | null>(
      (best, d) => (best === null || d.eventId > best.eventId ? d : best),
      null,
    );
  const byPeople = closing.filter((d) => d.actorKind === "human");
  return {
    ...identity,
    lane,
    assessed: unit.assessmentEventId !== null,
    needs,
    closed:
      needs === "no-disposition" ||
      (needs !== "an-assessment" && closing.length > 0),
    closing,
    context,
    standing: newest(byPeople.length > 0 ? byPeople : closing),
  };
};

/**
 * Whether a unit's needed dispositions are in under its current lane assessment (4.11, 4.13), with
 * the dispositions that close it and those that reach the human reviewer as context. Only current
 * dispositions count: a retracted one or one its author replaced is history. Read-side only: the
 * append-time rule (only a registered human approves a unit that is human-required when the approval
 * is appended) stays in `checkWorkflowRules`.
 */
export const judge = (unitId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* assertCompatible;
    const [unit] = yield* sql<{
      cycleId: string | null;
      lane: string | null;
      assessmentEventId: string | null;
      recordedEventId: string | null;
    }>`SELECT cycle_id, lane, assessment_event_id, recorded_event_id FROM projection_units WHERE unit_id = ${unitId}`;
    const lane = Lane.nullable().safeParse(unit?.lane ?? null);
    if (!lane.success)
      return yield* new CorruptRecord({
        message: `projection_units ${unitId}: ${lane.error.message}`,
      });
    const assessmentEventId = unit?.assessmentEventId ?? null;
    const dispositions = yield* current({
      unitId,
      cycleId: unit?.cycleId ?? undefined,
    });
    const judged: Array<JudgedDisposition> = [];
    for (const disposition of dispositions) {
      const [actor] = yield* sql<{
        actorKind: string;
      }>`SELECT actor_kind FROM projection_actors WHERE actor_id = ${disposition.actorId}`;
      judged.push({
        ...disposition,
        actorKind:
          actor?.actorKind === "human"
            ? "human"
            : actor?.actorKind === "agent"
              ? "agent"
              : "unregistered",
        beforeAssessment:
          assessmentEventId === null || disposition.eventId < assessmentEventId,
      });
    }
    return judgeDispositions(
      {
        unitId,
        cycleId: unit?.cycleId ?? null,
        lane: lane.data,
        assessmentEventId,
        recorded: (unit?.recordedEventId ?? null) !== null,
      },
      judged,
    );
  });
