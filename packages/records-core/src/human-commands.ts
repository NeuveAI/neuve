import { Clock, Data, Effect, Option } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import {
  FEEDBACK_TARGET_KINDS,
  FeedbackAnswerV2,
  type OwnedRange,
  type RecordEvent,
} from "@neuve/records-schema";
import { BlobStore } from "./blobs.ts";
import { canonicalJson, sha256Hex } from "./canonical.ts";
import { dispositionRows } from "./carried-relations.ts";
import { liveDisposition } from "./dispositions.ts";
import { humanFingerprint, normalizeEmail } from "./identity.ts";
import { mintUlid } from "./ids.ts";
import { append, get } from "./log.ts";
import { currentFeedback } from "./rules.ts";
import { unitRanges } from "./unit-ranges.ts";

/**
 * A person's review work on a published packet (M5 §1.3, ID1): record a disposition, retract it, and
 * record a review comment on a unit's owned lines. Each command takes the person as git names them
 * (10.5), registers them as a human actor (idempotent, so once), and appends in one transaction, so
 * the append transaction's workflow rules decide as they do for every writer: only a registered
 * human approves human-required work, and only a disposition's author replaces or retracts it.
 * Callers (the web app's BFF) decide nothing else. Identity is attribution, not access (0009).
 */

/** The person acting, as git names them: `user.email` and, when set, `user.name`. */
export interface Person {
  readonly email: string;
  readonly displayName?: string | undefined;
}

/** A command refused before anything was appended, with why in the words a screen shows. */
export class HumanCommandRefused extends Data.TaggedError(
  "HumanCommandRefused",
)<{
  readonly reason:
    | "no-email"
    | "unknown-unit"
    | "anchor-outside-owned-lines"
    | "request-without-comment"
    | "unknown-disposition"
    | "invalid-feedback"
    | "unknown-feedback-target";
  readonly message: string;
}> {}

/** Lines on one side of the diff a comment is anchored to. */
export interface Anchor {
  readonly path: string;
  readonly side: "old" | "new";
  readonly startLine: number;
  readonly endLine: number;
}

/**
 * A new review comment: its text and, when it is about particular lines, the owned lines it is
 * anchored to. Without an anchor it is on the whole unit (10.102).
 */
export interface NewComment {
  readonly body: string;
  readonly anchor?: Anchor | undefined;
}

const registration = (person: Person) =>
  Effect.gen(function* () {
    const email = person.email.trim();
    if (email === "" || !email.includes("@"))
      return yield* new HumanCommandRefused({
        reason: "no-email",
        message:
          "git names no email here (git config user.email), so Neuve cannot record who decided",
      });
    const actor = humanFingerprint(email);
    const name = person.displayName?.trim() ?? "";
    const payload = {
      actorKind: "human",
      harness: "git",
      email: normalizeEmail(email),
      ...(name === "" ? {} : { displayName: name }),
    };
    return {
      actor,
      event: {
        id: mintUlid(),
        kind: "actor.registered@1",
        // The same key as a review request's registration (harness request.ts), so a person is
        // registered once whichever path names them first.
        idempotencyKey: `actor:${actor}:${sha256Hex(canonicalJson(payload)).slice(0, 16)}`,
        actor,
        occurredAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
        payload,
      },
    };
  });

/** The recorded unit a command acts on: its cycle, the cycle's head and its owned ranges. */
const recordedUnit = (unitId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const [row] = yield* sql<{
      cycleId: string | null;
      recordedEventId: string | null;
      headOid: string | null;
    }>`SELECT u.cycle_id, u.recorded_event_id, c.head_oid FROM projection_units u
      LEFT JOIN projection_cycles c ON c.cycle_id = u.cycle_id WHERE u.unit_id = ${unitId}`;
    const recorded =
      row?.recordedEventId === null || row?.recordedEventId === undefined
        ? Option.none()
        : yield* get(row.recordedEventId);
    if (
      row === undefined ||
      row.cycleId === null ||
      row.headOid === null ||
      Option.isNone(recorded)
    )
      return yield* new HumanCommandRefused({
        reason: "unknown-unit",
        message: `Records holds no review unit ${unitId} in a review cycle`,
      });
    const event = recorded.value.event;
    const ranges: ReadonlyArray<HeldRange> =
      event.kind === "unit.recorded@2"
        ? event.payload.ownedRanges
        : event.kind === "unit.recorded@1"
          ? event.payload.ownedRanges.map((range) => ({
              kind: "lines" as const,
              side: undefined,
              ...range,
            }))
          : [];
    return {
      cycleId: row.cycleId,
      headOid: row.headOid,
      ranges,
      event,
    };
  });

/**
 * The lines a unit owns, for a comment anchored to lines. A `unit.recorded@3` keeps them in its
 * sections blob, read only here so that commands which name no lines need no blob store. When the
 * caller gave none, or the blob cannot be read, the comment is refused rather than anchored to
 * lines nobody could check; a comment on the whole unit needs neither.
 */
const anchorRanges = (
  unitId: string,
  unit: {
    readonly ranges: ReadonlyArray<HeldRange>;
    readonly event: RecordEvent;
  },
) =>
  Effect.gen(function* () {
    const event = unit.event;
    if (event.kind !== "unit.recorded@3") return unit.ranges;
    const blobs = yield* Effect.serviceOption(BlobStore);
    const read = Option.isNone(blobs)
      ? undefined
      : yield* unitRanges(event).pipe(
          Effect.provideService(BlobStore, blobs.value),
        );
    if (read?._tag === "Ranges") return read.ranges;
    return yield* new HumanCommandRefused({
      reason: "anchor-outside-owned-lines",
      message: `The lines unit ${unitId} owns could not be read (${read === undefined ? "no blob store was given" : read.issue}), so a comment can't be anchored to lines of it; comment on the whole unit instead`,
    });
  });

/** A comment anchors only to lines the unit owns (vocabulary: Review comment, Owned range). */
/** An owned range; a version 1 unit's ranges carry no side, and match either. */
type HeldRange =
  | OwnedRange
  | {
      readonly kind: "lines";
      readonly side: undefined;
      readonly path: string;
      readonly startLine: number;
      readonly endLine: number;
    };

const ownsAnchor = (ranges: ReadonlyArray<HeldRange>, anchor: Anchor) =>
  anchor.endLine >= anchor.startLine &&
  ranges.some(
    (range) =>
      range.path === anchor.path &&
      (range.side === undefined || range.side === anchor.side) &&
      (range.kind === "whole-nontext" ||
        (anchor.startLine >= range.startLine &&
          anchor.endLine <= range.endLine)),
  );

const outsideOwned = (anchor: Anchor, unitId: string) =>
  `${anchor.path} ${anchor.side} ${anchor.startLine}-${anchor.endLine} is not a line unit ${unitId} owns`;

const commentEvent = (
  actor: string,
  unitId: string,
  cycleId: string,
  comment: NewComment,
  occurredAt: string,
) => {
  const id = mintUlid();
  return {
    id,
    kind: "comment.recorded@2",
    idempotencyKey: `human:${actor}:comment:${id}`,
    actor,
    occurredAt,
    attribution: { cycleId, unitIds: [unitId] },
    payload: {
      body: comment.body,
      ...(comment.anchor === undefined
        ? {}
        : { anchor: { ...comment.anchor } }),
    },
  };
};

/**
 * The person's current disposition on the unit and cycle, which a new one replaces: over the rows
 * `Dispositions.current` reads, so a decision of theirs carried onto the unit
 * (`disposition.carried@1`) is replaced by name, never by which ID sorts later.
 */
const currentOwn = (actor: string, unitId: string, cycleId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const [row] = yield* sql<{ eventId: string }>`SELECT d.event_id FROM
      ${sql.literal(dispositionRows)} d WHERE d.unit_id = ${unitId} AND d.cycle_id = ${cycleId}
      AND d.actor_id = ${actor} AND ${sql.literal(liveDisposition("d"))}
      ORDER BY d.event_id DESC LIMIT 1`;
    return row?.eventId;
  });

const appended = (events: ReadonlyArray<Record<string, unknown>>) =>
  Effect.map(append(events), (results) => results.map((result) => result.id));

/**
 * Records a person's disposition on a unit's owned work in its cycle: an approval, or a request for
 * changes resting on the comments it names and the new comments it records first (10.69). It
 * replaces the person's own current disposition on the unit, if any. On human-required work the
 * append transaction refuses an approval unless the actor is a registered human (4.5).
 */
export const recordDisposition = (input: {
  readonly person: Person;
  readonly unitId: string;
  readonly verdict: "approve" | "request-changes";
  readonly note?: string | undefined;
  /** Comments already recorded on the unit in its cycle that a request for changes rests on. */
  readonly restsOn?: ReadonlyArray<string> | undefined;
  /** New comments a request for changes records and rests on, appended before it. */
  readonly comments?: ReadonlyArray<NewComment> | undefined;
}) =>
  Effect.gen(function* () {
    const { actor, event: registered } = yield* registration(input.person);
    const unit = yield* recordedUnit(input.unitId);
    const comments = input.comments ?? [];
    const restsOn = input.restsOn ?? [];
    if (
      input.verdict === "request-changes" &&
      comments.length + restsOn.length === 0
    )
      return yield* new HumanCommandRefused({
        reason: "request-without-comment",
        message:
          "a request for changes rests on at least one comment saying what to change",
      });
    if (input.verdict === "approve" && comments.length + restsOn.length > 0)
      return yield* new HumanCommandRefused({
        reason: "request-without-comment",
        message: "only a request for changes rests on comments",
      });
    // Read the unit's lines only when a comment names lines: an approval needs no blob store.
    const anchored = comments.some((comment) => comment.anchor !== undefined);
    const ranges = anchored ? yield* anchorRanges(input.unitId, unit) : [];
    for (const comment of comments)
      if (comment.anchor !== undefined && !ownsAnchor(ranges, comment.anchor))
        return yield* new HumanCommandRefused({
          reason: "anchor-outside-owned-lines",
          message: outsideOwned(comment.anchor, input.unitId),
        });
    const occurredAt = new Date(yield* Clock.currentTimeMillis).toISOString();
    const built = comments.map((comment) =>
      commentEvent(actor, input.unitId, unit.cycleId, comment, occurredAt),
    );
    const replaces = yield* currentOwn(actor, input.unitId, unit.cycleId);
    const id = mintUlid();
    const disposition = {
      id,
      kind: "disposition.recorded@2",
      idempotencyKey: `human:${actor}:disposition:${id}`,
      actor,
      occurredAt,
      attribution: { cycleId: unit.cycleId, unitIds: [input.unitId] },
      ...(replaces === undefined
        ? {}
        : { causation: { supersedes: replaces } }),
      payload: {
        verdict: input.verdict,
        reviewedHeadOid: unit.headOid,
        ...(input.note === undefined || input.note.trim() === ""
          ? {}
          : { note: input.note }),
        restsOn: [...restsOn, ...built.map((comment) => comment.id)],
        proof: [],
      },
    };
    const ids = yield* appended([registered, ...built, disposition]);
    return {
      actor,
      dispositionId: ids[ids.length - 1]!,
      commentIds: ids.slice(1, -1),
      replaced: replaces,
    };
  }).pipe(
    Effect.withSpan("records.human.disposition", {
      attributes: {
        "neuve.unit.id": input.unitId,
        "neuve.disposition.verdict": input.verdict,
      },
    }),
  );

/** Retracts a person's own disposition (undo): history keeps it; only its author may retract it. */
export const retractDisposition = (input: {
  readonly person: Person;
  readonly dispositionId: string;
  readonly reason?: string | undefined;
}) =>
  Effect.gen(function* () {
    const { actor, event: registered } = yield* registration(input.person);
    const held = yield* get(input.dispositionId);
    const target = Option.getOrUndefined(held)?.event;
    if (
      target === undefined ||
      (target.kind !== "disposition.recorded@1" &&
        target.kind !== "disposition.recorded@2" &&
        target.kind !== "disposition.carried@1")
    )
      return yield* new HumanCommandRefused({
        reason: "unknown-disposition",
        message: `${input.dispositionId} is not a recorded disposition`,
      });
    // A decision carried onto a unit is the person's own only when it was recorded under their
    // actor; one carried under another actor, an agent's included, is not theirs to undo. A
    // recorded target's author is held by the append rule (`supersedes-other-author`), which
    // holds a carried target too.
    if (target.kind === "disposition.carried@1" && target.actor !== actor)
      return yield* new HumanCommandRefused({
        reason: "unknown-disposition",
        message: `${input.dispositionId} is a decision carried onto the unit for someone else, not one of yours`,
      });
    const attribution = target.attribution as Extract<
      RecordEvent,
      { kind: "disposition.recorded@2" }
    >["attribution"];
    const id = mintUlid();
    const ids = yield* appended([
      registered,
      {
        id,
        kind: "disposition.retracted@1",
        idempotencyKey: `human:${actor}:retraction:${input.dispositionId}`,
        actor,
        occurredAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
        attribution: {
          cycleId: attribution.cycleId,
          unitIds: [attribution.unitIds[0]],
        },
        causation: { supersedes: input.dispositionId },
        payload:
          input.reason === undefined || input.reason.trim() === ""
            ? {}
            : { reason: input.reason },
      },
    ]);
    return { actor, retractionId: ids[1]! };
  }).pipe(
    Effect.withSpan("records.human.retraction", {
      attributes: { "neuve.disposition.id": input.dispositionId },
    }),
  );

/**
 * Records a person's review comment on lines the unit owns, or on the whole unit when it names no
 * lines (10.102); informational until a disposition rests on it.
 */
export const recordComment = (input: {
  readonly person: Person;
  readonly unitId: string;
  readonly comment: NewComment;
}) =>
  Effect.gen(function* () {
    const { actor, event: registered } = yield* registration(input.person);
    const unit = yield* recordedUnit(input.unitId);
    const anchor = input.comment.anchor;
    if (
      anchor !== undefined &&
      !ownsAnchor(yield* anchorRanges(input.unitId, unit), anchor)
    )
      return yield* new HumanCommandRefused({
        reason: "anchor-outside-owned-lines",
        message: outsideOwned(anchor, input.unitId),
      });
    const occurredAt = new Date(yield* Clock.currentTimeMillis).toISOString();
    const ids = yield* appended([
      registered,
      commentEvent(
        actor,
        input.unitId,
        unit.cycleId,
        input.comment,
        occurredAt,
      ),
    ]);
    return { actor, commentId: ids[1]! };
  }).pipe(
    Effect.withSpan("records.human.comment", {
      attributes: { "neuve.unit.id": input.unitId },
    }),
  );

/**
 * Records a person's feedback (vocabulary: Feedback; M5 FB1–FB4): one answer on the sheet's scales
 * on a unit, a finding, a context reference or a digest, named by its event ID, with whether the
 * harness's call was visible. It is attributed to the target's own cycle, batch and units. A second
 * answer on the same target is a correction: it supersedes the person's current answer, so the
 * first answer and the final one are both kept. Feedback is never a disposition and changes nothing
 * in the review (FB3): this appends only the registration and one `feedback.recorded@2`, whose
 * answer on a reference may carry the note's rubric and the harness's grade the person saw (10.107).
 *
 * Not idempotent across calls: each call mints a fresh event ID and keys the event by it, so a
 * retried or double submit records a second answer, which supersedes the first as a correction.
 * Callers (the desk's controls) must prevent double submits, for example by disabling a control
 * while its command runs, and must not retry a call that may already have appended.
 */
export const recordFeedback = (input: {
  readonly person: Person;
  readonly answer: FeedbackAnswerV2;
}) =>
  Effect.gen(function* () {
    const parsed = FeedbackAnswerV2.safeParse(input.answer);
    if (!parsed.success)
      return yield* new HumanCommandRefused({
        reason: "invalid-feedback",
        message: parsed.error.issues[0]?.message ?? parsed.error.message,
      });
    const answer = parsed.data;
    const { actor, event: registered } = yield* registration(input.person);
    const held = Option.getOrUndefined(yield* get(answer.target))?.event;
    const kinds: ReadonlyArray<string> = FEEDBACK_TARGET_KINDS[answer.on];
    if (held === undefined || !kinds.includes(held.kind))
      return yield* new HumanCommandRefused({
        reason: "unknown-feedback-target",
        message: `Records holds no ${answer.on} ${answer.target}`,
      });
    const target = held.attribution as {
      readonly cycleId: string;
      readonly batchId?: string | undefined;
      readonly unitIds?: ReadonlyArray<string> | undefined;
    };
    const replaces = yield* currentFeedback(actor, answer.target);
    const id = mintUlid();
    const ids = yield* appended([
      registered,
      {
        id,
        kind: "feedback.recorded@2",
        // A fresh key per call: a repeat is a correction, never deduplicated (see above).
        idempotencyKey: `human:${actor}:feedback:${id}`,
        actor,
        occurredAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
        attribution: {
          cycleId: target.cycleId,
          ...(target.batchId === undefined ? {} : { batchId: target.batchId }),
          ...(target.unitIds === undefined
            ? {}
            : { unitIds: [...target.unitIds] }),
        },
        ...(replaces === undefined
          ? {}
          : { causation: { supersedes: replaces } }),
        payload: answer,
      },
    ]);
    return { actor, feedbackId: ids[1]!, replaced: replaces };
  }).pipe(
    Effect.withSpan("records.human.feedback", {
      attributes: {
        "neuve.feedback.on": input.answer.on,
        "neuve.feedback.target": input.answer.target,
        "neuve.feedback.harness_call_visible": input.answer.harnessCallVisible,
      },
    }),
  );

/**
 * Clears the repository's default review list ("Clear"), or undoes the most recent clear still
 * standing (`restore`), as the person git names (10.5). Nothing is deleted: the clears still
 * standing decide what "Waiting on you" holds (`ReviewList.cleared`). Each call is a new event, so
 * a repeat is a later clear.
 */
export const clearReviewList = (input: {
  readonly person: Person;
  readonly restore?: boolean | undefined;
}) =>
  Effect.gen(function* () {
    const { actor, event: registered } = yield* registration(input.person);
    const id = mintUlid();
    const occurredAt = new Date(yield* Clock.currentTimeMillis).toISOString();
    yield* appended([
      registered,
      {
        id,
        kind: "review-list.cleared@1",
        idempotencyKey: `human:${actor}:review-list:${id}`,
        actor,
        occurredAt,
        attribution: {},
        payload: input.restore ? { restore: true } : {},
      },
    ]);
    return { actor, eventId: id, occurredAt };
  }).pipe(
    Effect.withSpan("records.human.clear-review-list", {
      attributes: { "neuve.review_list.restore": input.restore === true },
    }),
  );
