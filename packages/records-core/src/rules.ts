import { dispositionRows } from "./carried-relations.ts";
import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { FEEDBACK_TARGET_KINDS, type RecordEvent } from "@neuve/records-schema";
import { WorkflowRuleViolation } from "./errors.ts";

/**
 * Review-workflow rules checked inside the append transaction, against the projections as they stand
 * after every earlier event in the same transaction (5.5's "checked in the append transaction").
 *
 * - Only a human records an approval on a unit whose current lane is human-required (4.5, 0009). An
 *   approval appended before the unit became human-required is kept; whether it still closes the unit
 *   is judged on read against the current lane (`Dispositions.judge`, 4.13).
 * - A disposition that supersedes another, and every retraction, must name a disposition already in the
 *   log by the same author on the same unit and cycle: only the author retracts or replaces it.
 * - Every comment a request for changes rests on (`disposition.recorded@2`, 10.69) must be a comment
 *   already in the log on the same unit and cycle. Publish appends comments before dispositions.
 * - Feedback (`checkFeedbackRules`) is recorded only by a registered human, on a target of the kind
 *   it names with the target's own attribution, and corrects only that person's current answer on
 *   the same target, so it can never supersede a disposition, a packet or another person's answer.
 */
export const checkWorkflowRules = (event: RecordEvent) =>
  Effect.gen(function* () {
    if (event.kind === "cycle.external-context-selected@1") {
      const sql = yield* SqlClient;
      const [opened] = yield* sql<{
        n: number;
      }>`SELECT count(*) AS n FROM projection_cycles WHERE cycle_id = ${event.attribution.cycleId}`;
      const [selected] = yield* sql<{
        n: number;
      }>`SELECT count(*) AS n FROM events e JOIN event_cycles c ON c.event_seq = e.seq WHERE c.cycle_id = ${event.attribution.cycleId} AND e.kind = 'cycle.external-context-selected@1'`;
      if (opened?.n || 0 || selected?.n || 0)
        return yield* new WorkflowRuleViolation({
          eventId: event.id,
          rule: "cycle-scope-already-bound",
          message:
            "A cycle's external context is pinned once, before the cycle opens.",
        });
      return;
    }
    if (event.kind === "review.origin-recorded@1") {
      const sql = yield* SqlClient;
      const [cycle] = yield* sql<{
        base: string;
        head: string;
      }>`SELECT base_oid AS base, head_oid AS head FROM projection_cycles WHERE cycle_id = ${event.attribution.cycleId}`;
      if (
        !cycle ||
        cycle.base !== event.attribution.range.baseOid ||
        cycle.head !== event.attribution.range.headOid
      )
        return yield* new WorkflowRuleViolation({
          eventId: event.id,
          rule: "cycle-scope-already-bound",
          message:
            "A review origin must name an existing cycle's exact submitted range.",
        });
      return;
    }
    if (event.kind === "cycle.scope-selected@1") {
      const sql = yield* SqlClient;
      const cycleId = event.attribution.cycleId;
      const [opened] = yield* sql<{
        n: number;
      }>`SELECT count(*) AS n FROM projection_cycles WHERE cycle_id = ${cycleId}`;
      const [selected] = yield* sql<{
        n: number;
      }>`SELECT count(*) AS n FROM events e JOIN event_cycles c ON c.event_seq = e.seq WHERE c.cycle_id = ${cycleId} AND e.kind = 'cycle.scope-selected@1'`;
      if ((opened?.n || 0) > 0 || (selected?.n || 0) > 0)
        return yield* new WorkflowRuleViolation({
          eventId: event.id,
          rule: "cycle-scope-already-bound",
          message:
            "A cycle's explicit scope is selected once, before the cycle opens.",
        });
      return;
    }
    if (
      event.kind === "feedback.recorded@1" ||
      event.kind === "feedback.recorded@2"
    )
      return yield* checkFeedbackRules(event);
    if (
      event.kind !== "disposition.recorded@1" &&
      event.kind !== "disposition.recorded@2" &&
      event.kind !== "disposition.carried@1" &&
      event.kind !== "disposition.retracted@1"
    )
      return;
    const sql = yield* SqlClient;
    const unitId = event.attribution.unitIds[0];
    const cycleId = event.attribution.cycleId;
    const violation = (rule: WorkflowRuleViolation["rule"], message: string) =>
      new WorkflowRuleViolation({ eventId: event.id, rule, message });

    if (
      (event.kind === "disposition.recorded@1" ||
        event.kind === "disposition.recorded@2" ||
        event.kind === "disposition.carried@1") &&
      event.payload.verdict === "approve"
    ) {
      const [unit] = yield* sql<{
        lane: string | null;
      }>`SELECT lane FROM projection_units WHERE unit_id = ${unitId}`;
      if (unit?.lane === "human-required") {
        const [actor] = yield* sql<{
          actorKind: string;
        }>`SELECT actor_kind FROM projection_actors WHERE actor_id = ${event.actor}`;
        if (actor?.actorKind !== "human") {
          return yield* violation(
            "human-required-approval",
            `Unit ${unitId} is human-required; only a registered human actor approves it`,
          );
        }
      }
    }

    if (
      event.kind === "disposition.recorded@2" ||
      event.kind === "disposition.carried@1"
    ) {
      for (const commentId of event.payload.restsOn) {
        const [comment] = yield* sql<{
          kind: string;
          cycleId: string | null;
          onUnit: number;
        }>`SELECT e.kind, json_extract(e.envelope, '$.attribution.cycleId') AS cycle_id,
          EXISTS (SELECT 1 FROM event_units u WHERE u.event_seq = e.seq AND u.unit_id = ${unitId}) AS on_unit
          FROM events e WHERE e.id = ${commentId}`;
        if (
          comment === undefined ||
          (!comment.kind.startsWith("comment.recorded@") &&
            comment.kind !== "comment.carried@1") ||
          comment.cycleId !== cycleId ||
          comment.onUnit !== 1
        )
          return yield* violation(
            "rests-on-unknown-comment",
            `${commentId} is not a recorded comment on unit ${unitId} in cycle ${cycleId}`,
          );
      }
    }

    const target = event.causation?.supersedes;
    if (target === undefined) return;
    const [disposition] = yield* sql<{
      actorId: string;
      unitId: string;
      cycleId: string;
    }>`SELECT actor_id, unit_id, cycle_id FROM ${sql.literal(dispositionRows)} WHERE event_id = ${target}`;
    if (disposition === undefined) {
      return yield* violation(
        "supersedes-unknown-disposition",
        `${target} is not a recorded disposition`,
      );
    }
    if (disposition.actorId !== event.actor) {
      return yield* violation(
        "supersedes-other-author",
        `Only the author of disposition ${target} may retract or replace it`,
      );
    }
    if (disposition.unitId !== unitId || disposition.cycleId !== cycleId) {
      return yield* violation(
        "supersedes-other-unit",
        `Disposition ${target} belongs to another unit or cycle`,
      );
    }
  });

/**
 * A person's current feedback answer on a target: the newest of theirs that no answer of theirs
 * supersedes. The one definition, used by the rules below and by the feedback command.
 */
export const currentFeedback = (actorId: string, targetEventId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const [row] = yield* sql<{ eventId: string }>`SELECT f.event_id
      FROM projection_feedback f WHERE f.target_event_id = ${targetEventId} AND f.actor_id = ${actorId}
        AND NOT EXISTS (SELECT 1 FROM projection_supersessions s
          JOIN projection_feedback b ON b.event_id = s.by_event_id AND b.actor_id = f.actor_id
          WHERE s.target_id = f.event_id)
      ORDER BY f.event_id DESC LIMIT 1`;
    return row?.eventId;
  });

/**
 * Feedback's rules (FB1, FB3). Feedback changes nothing in the review, and these keep it that way:
 * the only link it may carry is to the same person's current answer on the same target, so its
 * supersession can never retract a disposition or set aside a packet. One current answer per person
 * and target: a second answer must supersede the first, so first and final stay one chain.
 */
const checkFeedbackRules = (
  event: Extract<
    RecordEvent,
    { kind: "feedback.recorded@1" | "feedback.recorded@2" }
  >,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const violation = (rule: WorkflowRuleViolation["rule"], message: string) =>
      new WorkflowRuleViolation({ eventId: event.id, rule, message });
    const [actor] = yield* sql<{
      actorKind: string;
    }>`SELECT actor_kind FROM projection_actors WHERE actor_id = ${event.actor}`;
    if (actor?.actorKind !== "human")
      return yield* violation(
        "feedback-not-human",
        "Feedback is a person's answer; only a registered human actor records it",
      );

    const { on, target } = event.payload;
    const [held] = yield* sql<{
      kind: string;
      cycleId: string | null;
      batchId: string | null;
      unitIds: string | null;
    }>`SELECT kind, json_extract(envelope, '$.attribution.cycleId') AS cycle_id,
      json_extract(envelope, '$.attribution.batchId') AS batch_id,
      json_extract(envelope, '$.attribution.unitIds') AS unit_ids
      FROM events WHERE id = ${target}`;
    const kinds: ReadonlyArray<string> = FEEDBACK_TARGET_KINDS[on];
    if (held === undefined || !kinds.includes(held.kind))
      return yield* violation(
        "feedback-unknown-target",
        `${target} is not a recorded ${on} (${kinds.join(" or ")})`,
      );
    // json_extract returns an array as compact JSON text, as JSON.stringify writes it.
    const { cycleId, batchId, unitIds } = event.attribution;
    if (
      held.cycleId !== cycleId ||
      (held.batchId ?? null) !== (batchId ?? null) ||
      (held.unitIds ?? null) !==
        (unitIds === undefined ? null : JSON.stringify(unitIds))
    )
      return yield* violation(
        "feedback-attribution-mismatch",
        `Feedback on ${target} carries the target's own cycle, batch and units`,
      );

    const current = yield* currentFeedback(event.actor, target);
    const supersedes = event.causation?.supersedes;
    if (supersedes === undefined) {
      if (current !== undefined)
        return yield* violation(
          "feedback-not-superseding",
          `This person already answered on ${target} (${current}); a correction supersedes that answer`,
        );
      return;
    }
    if (current !== supersedes)
      return yield* violation(
        "feedback-supersedes-other",
        `${supersedes} is not this person's current answer on ${target}; feedback corrects only that`,
      );
  });
