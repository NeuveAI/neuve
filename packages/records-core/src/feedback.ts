import { Effect, Option } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import type { FeedbackTarget, RecordEvent } from "@neuve/records-schema";
import { decodeEnvelope } from "./codec.ts";
import { get } from "./log.ts";
import { assertCompatible } from "./store.ts";

/**
 * Reading a person's feedback back (M5 FB5): their answers per target, first and final, and the
 * export in the end-to-end check's sheet answers' shape, marked as desk answers, so each climb reads
 * desk answers the way it read the sheet. Feedback is recorded by `HumanCommands.recordFeedback`.
 */

/** Both versions: a version 1 answer reads as version 2 with the reference rubric blank (10.107). */
type Recorded = Extract<
  RecordEvent,
  { kind: "feedback.recorded@1" | "feedback.recorded@2" }
>;

/** One answer as recorded: its event, when the person gave it, and what they answered. */
export interface Answer {
  readonly eventId: string;
  readonly at: string;
  readonly payload: Recorded["payload"];
}

/** A person's answers on one target: the first, and the final when a correction superseded it. */
export interface TargetAnswers {
  readonly on: FeedbackTarget;
  readonly target: string;
  readonly cycleId: string;
  readonly batchId: string | undefined;
  readonly unitIds: ReadonlyArray<string>;
  readonly first: Answer;
  /** The newest answer nothing supersedes, when it is not the first. */
  readonly final: Answer | undefined;
}

/**
 * A person's answers, grouped by target in the order the targets were first answered. The first
 * answer is the one that supersedes nothing; the final is the newest that no answer of the same
 * person supersedes (the append rules keep that one chain). Reads projections and events by ID only,
 * never `seq`, so the answer does not depend on append order.
 */
export const answers = (filter: {
  readonly actorId: string;
  readonly cycleId?: string | undefined;
  readonly unitId?: string | undefined;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* assertCompatible;
    const rows = yield* sql<{
      eventId: string;
      supersedesEventId: string | null;
      superseded: number;
      envelope: string;
    }>`SELECT f.event_id, f.supersedes_event_id, e.envelope,
      EXISTS (SELECT 1 FROM projection_supersessions s
        JOIN projection_feedback b ON b.event_id = s.by_event_id AND b.actor_id = f.actor_id
        WHERE s.target_id = f.event_id) AS superseded
      FROM projection_feedback f JOIN events e ON e.id = f.event_id
      WHERE f.actor_id = ${filter.actorId}
        AND (${filter.cycleId ?? null} IS NULL OR f.cycle_id = ${filter.cycleId ?? null})
        AND (${filter.unitId ?? null} IS NULL OR e.seq IN
          (SELECT event_seq FROM event_units WHERE unit_id = ${filter.unitId ?? null}))
      ORDER BY f.event_id`;
    const byTarget = new Map<
      string,
      { first?: Answer; final?: Answer; event: Recorded }
    >();
    for (const row of rows) {
      const event = yield* decodeEnvelope(row.envelope, `event ${row.eventId}`);
      if (
        event.kind !== "feedback.recorded@1" &&
        event.kind !== "feedback.recorded@2"
      )
        continue;
      const answer: Answer = {
        eventId: event.id,
        at: event.occurredAt,
        payload: event.payload,
      };
      const held = byTarget.get(event.payload.target) ?? { event };
      // Rows come in ULID order: the earliest answer superseding nothing is the first, and the
      // newest one nothing supersedes is the final.
      if (row.supersedesEventId === null && held.first === undefined)
        held.first = answer;
      if (row.superseded === 0) held.final = answer;
      byTarget.set(event.payload.target, held);
    }
    const grouped: Array<TargetAnswers> = [];
    for (const [target, held] of byTarget) {
      const first = held.first ?? held.final;
      if (first === undefined) continue;
      const attribution = held.event.attribution;
      grouped.push({
        on: held.event.payload.on,
        target,
        cycleId: attribution.cycleId,
        batchId: attribution.batchId,
        unitIds: attribution.unitIds ?? [],
        first,
        final:
          held.final === undefined || held.final.eventId === first.eventId
            ? undefined
            : held.final,
      });
    }
    return grouped;
  }).pipe(Effect.withSpan("records.feedback.answers"));

// ---------------------------------------------------------------------------------------------
// The export in the sheet answers' shape, whose historical example is kept in the private archive.
// ---------------------------------------------------------------------------------------------

type Of<On extends FeedbackTarget> = Extract<
  Extract<RecordEvent, { kind: "feedback.recorded@2" }>["payload"],
  { on: On }
>;

const unitAnswer = (answer: Answer) => {
  const p = answer.payload as Of<"unit">;
  return {
    complexity: p.complexity ?? null,
    easeOfValidation: p.easeOfValidation ?? null,
    lane: p.lane ?? null,
    note: p.note ?? null,
    verdict: p.verdict ?? null,
    harnessCallVisible: p.harnessCallVisible,
  };
};

const findingAnswer = (answer: Answer) => {
  const p = answer.payload as Of<"finding">;
  return {
    judged: p.judged ?? null,
    note: p.note ?? null,
    harnessCallVisible: p.harnessCallVisible,
    at: answer.at,
  };
};

const rubric = (answer: Answer) => {
  const p = answer.payload as Of<"digest">;
  return {
    accurate: p.accurate ?? null,
    complete: p.complete ?? null,
    misleadingClaim: p.misleadingClaim ?? null,
    neutralBeforeVerdict: p.neutralBeforeVerdict ?? null,
    note: p.note ?? null,
  };
};

/**
 * A reference answer's note rubric (10.107). A row the person left unanswered, and every row of a
 * version 1 answer, is null: blank, never yes.
 */
const referenceRubric = (answer: Answer) => {
  const p = answer.payload as Of<"reference">;
  return {
    saysWhy: p.saysWhy ?? null,
    tiedToLines: p.tiedToLines ?? null,
    checkActionable: p.checkActionable ?? null,
    accurate: p.accurate ?? null,
    length: p.length ?? null,
  };
};

interface UnitEntry {
  kind: "unit";
  unitId: string;
  cycleId: string;
  target: string | null;
  first: ReturnType<typeof unitAnswer> | null;
  firstAt: string | null;
  final?: ReturnType<typeof unitAnswer>;
  finalAt?: string;
  findings: Array<Record<string, unknown>>;
}

const NOTES = [
  "Desk answers, not decide-then-reveal: the review desk does not hide the harness's call, so each answer records whether that call was visible when the person answered (harnessCallVisible). Keep them apart from the sheets' blind answers.",
  "first is a target's first answer; final, when present, is the newest correction that superseded it. Findings and digests carry their current answer, with first when it was corrected.",
  "A finding is listed under every unit its comment is attributed to; a unit answered only through its findings has first null.",
  "A margin card's firstRubric and finalRubric are the note's rubric (10.107); a row the person left unanswered is null, never yes, and answers recorded before the rubric have every row null. harnessGrade is the harness's grade the card showed, null when it was not visible or the answer predates it.",
];

/**
 * A person's feedback in the sheet answers' shape: units with first and final answers and their
 * judged findings, margin cards (context references) with an in-between second grade, the note's
 * rubric and the harness's grade the card showed (10.107), and batch and
 * unit digests with their rubric. Every answer records whether the harness's call was visible, and
 * the whole is marked as desk answers (`method: "desk"`, `decideThenReveal: false`).
 */
export const sheetAnswers = (input: {
  readonly actorId: string;
  readonly cycleId?: string | undefined;
  readonly readAt: string;
}) =>
  Effect.gen(function* () {
    const grouped = yield* answers({
      actorId: input.actorId,
      cycleId: input.cycleId,
    });
    const entries: Record<string, Record<string, unknown>> = {};
    const units = new Map<string, UnitEntry>();
    const unitEntry = (unitId: string, cycleId: string) => {
      const held = units.get(unitId);
      if (held !== undefined) return held;
      const entry: UnitEntry = {
        kind: "unit",
        unitId,
        cycleId,
        target: null,
        first: null,
        firstAt: null,
        findings: [],
      };
      units.set(unitId, entry);
      entries[`unit:${unitId}`] = entry as unknown as Record<string, unknown>;
      return entry;
    };
    let findings = 0;
    for (const t of grouped) {
      const last = t.final ?? t.first;
      switch (t.on) {
        case "unit": {
          const unitId = t.unitIds[0];
          if (unitId === undefined) break;
          const entry = unitEntry(unitId, t.cycleId);
          entry.target = t.target;
          entry.first = unitAnswer(t.first);
          entry.firstAt = t.first.at;
          if (t.final !== undefined) {
            entry.final = unitAnswer(t.final);
            entry.finalAt = t.final.at;
          }
          break;
        }
        case "finding": {
          findings += 1;
          const finding = {
            commentId: t.target,
            ...findingAnswer(last),
            ...(t.final === undefined ? {} : { first: findingAnswer(t.first) }),
          };
          for (const unitId of t.unitIds)
            unitEntry(unitId, t.cycleId).findings.push(finding);
          break;
        }
        case "reference": {
          const first = t.first.payload as Of<"reference">;
          const final = t.final?.payload as Of<"reference"> | undefined;
          entries[`reference:${t.target}`] = {
            kind: "margin-card",
            referenceId: t.target,
            cycleId: t.cycleId,
            unitIds: t.unitIds,
            first: first.grade ?? null,
            firstBetween: first.between ?? null,
            firstRubric: referenceRubric(t.first),
            // The reference is frozen once published (5.5), so its grade is one value, recorded
            // with whichever answer saw it.
            harnessGrade: first.harnessGrade ?? final?.harnessGrade ?? null,
            firstAt: t.first.at,
            note: first.note ?? null,
            harnessCallVisible: first.harnessCallVisible,
            ...(final === undefined || t.final === undefined
              ? {}
              : {
                  final: final.grade ?? null,
                  finalBetween: final.between ?? null,
                  finalRubric: referenceRubric(t.final),
                  finalAt: t.final.at,
                  finalNote: final.note ?? null,
                  finalHarnessCallVisible: final.harnessCallVisible,
                }),
          };
          break;
        }
        case "digest": {
          const held = Option.getOrUndefined(yield* get(t.target))?.event;
          const content =
            held?.kind === "delivery.recorded@1"
              ? held.payload.content
              : undefined;
          entries[`digest:${t.target}`] = {
            kind: content === "batch-digest" ? "batch-digest" : "unit-digest",
            deliveryId: t.target,
            content: content ?? null,
            cycleId: t.cycleId,
            batchId: t.batchId ?? null,
            unitId: t.unitIds[0] ?? null,
            at: last.at,
            rubric: rubric(last),
            harnessCallVisible: last.payload.harnessCallVisible,
            ...(t.final === undefined
              ? {}
              : {
                  first: {
                    at: t.first.at,
                    rubric: rubric(t.first),
                    harnessCallVisible: t.first.payload.harnessCallVisible,
                  },
                }),
          };
          break;
        }
      }
    }
    const answered = Object.values(entries).filter(
      (entry) => entry["kind"] !== "unit" || entry["first"] !== null,
    ).length;
    return {
      schemaVersion: 1,
      source: `the review desk's feedback in Records, read ${input.readAt}`,
      method: "desk",
      decideThenReveal: false,
      actorId: input.actorId,
      cycleId: input.cycleId ?? null,
      notes: NOTES,
      answered,
      findings,
      answers: entries,
    };
  }).pipe(
    Effect.withSpan("records.feedback.export", {
      attributes: { "neuve.cycle.id": input.cycleId ?? "" },
    }),
  );

/**
 * The delivery event a digest answer names (FB1): a batch's digest, or one unit's delivery stop,
 * the newest Records holds for it. The packet read model carries a batch's and a unit's content,
 * not these event IDs.
 */
export const deliveryTarget = (input: {
  readonly batchId: string;
  readonly content: string;
  readonly unitId?: string | undefined;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const [row] = yield* sql<{
      eventId: string;
    }>`SELECT event_id FROM projection_deliveries
      WHERE batch_id = ${input.batchId} AND content = ${input.content}
        AND ((${input.unitId ?? null} IS NULL AND unit_id IS NULL) OR unit_id = ${input.unitId ?? null})
      ORDER BY event_id DESC LIMIT 1`;
    return row?.eventId;
  });
