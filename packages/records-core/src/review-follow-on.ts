import { Clock, Effect, Option } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { Ulid, type RecordEvent } from "@neuve/records-schema";
import { fingerprintOf, parseEvent } from "./codec.ts";
import { CorruptRecord, IdempotencyConflict, InvalidEvent } from "./errors.ts";
import { mintUlid } from "./ids.ts";
import { append, get } from "./log.ts";
import { REVIEW_RUN_KINDS } from "./jobs.ts";
import { assertCompatible } from "./store.ts";

/**
 * A review run too large for one run publishes what it decided and asks for its follow-on run: the
 * next generation of the same request, a new `review.requested@1` with the same run key and
 * `generation + 1`, whose append enqueues its own `review.run:<runKey>:<generation>` job (`jobs.ts`).
 * The run asks before it writes its receipt, so no reader sees a moment with no run of the cycle
 * going. The follow-on is marked by `causation.causedBy` naming the request it continues; the length
 * of that chain is how many follow-ons lie behind a request, which bounds the sequence.
 *
 * Only the run that is going may ask: request n must have an unfinished review job of its own, and
 * the next generation's job key must be free, so a `Requested` answer always names a request whose
 * own job will run. A repeat ask holds to the same: the event under the key must be the follow-on
 * this module writes for n, and the next generation's review job must be that event's own.
 *
 * The worker runs one review at a time, so the follow-on does not start while an attempt of n is
 * running. It can start before n ends: when an attempt of n fails, n waits in `delayed` for its
 * retry and the freed slot takes the follow-on first. That order is safe for the records because
 * the publisher's batches are frozen and the run's plans are stored: n's retry replays what is
 * stored rather than deciding again.
 *
 * Nothing here wakes the worker. The worker that runs the asking job also runs the follow-on: its
 * review slot frees when that attempt ends, which wakes its loop (`startInSlot`), and its other
 * slots find the stack fetch on their next scan. `LocalJobPublication` publishes only jobs that
 * ended, so a waiting job has nothing to publish.
 */

type ReviewRequested = Extract<RecordEvent, { kind: "review.requested@1" }>;

/** The schema's largest generation (`review.requested@1`). */
const MAX_GENERATION = 1_000;

export type FollowOn =
  | {
      readonly _tag: "Requested";
      /** The follow-on request's event ID. */
      readonly requestId: string;
      readonly generation: number;
      /** Follow-ons behind the new request, counting it. */
      readonly followOns: number;
      /** False when the follow-on was already recorded: a second attempt of the same job. */
      readonly appended: boolean;
    }
  | { readonly _tag: "CapReached"; readonly followOns: number };

/** Request `requestId`, refused unless it is a `review.requested@1` this build reads. */
const reviewRequest = (requestId: string) =>
  Effect.gen(function* () {
    const id = Ulid.safeParse(requestId);
    const stored = id.success ? yield* get(id.data) : Option.none();
    if (
      Option.isNone(stored) ||
      stored.value.event.kind !== "review.requested@1"
    )
      return yield* new InvalidEvent({
        message: `${requestId} is not a review request in this store`,
      });
    return stored.value.event;
  });

/**
 * The follow-on of `request` as `requestFollowOn` appends it: n's actor, attribution, refs and
 * payload, the next generation, caused by n and keeping n's correlation. One construction for the
 * append and for recognising a repeat, so the two cannot drift apart.
 */
const followOnOf = (
  request: ReviewRequested,
  id: string,
  occurredAt: string,
) => {
  const correlationId = request.causation?.correlationId;
  return {
    id,
    kind: "review.requested@1",
    idempotencyKey: `review-follow-on:${request.id}`,
    causation: {
      causedBy: request.id,
      ...(correlationId === undefined ? {} : { correlationId }),
    },
    actor: request.actor,
    occurredAt,
    attribution: request.attribution,
    ...(request.refs === undefined ? {} : { refs: request.refs }),
    payload: { ...request.payload, generation: request.payload.generation + 1 },
  } as const;
};

/**
 * How many follow-ons lie behind `request`: the `causedBy` links back through requests of its run
 * key and cycle. Each follow-on is one generation later than the request it continues, so the count
 * never passes the request's own generation; `bound` stops the walk sooner.
 */
const countBehind = (request: ReviewRequested, bound: number) =>
  Effect.gen(function* () {
    const limit = Math.min(bound, request.payload.generation);
    let count = 0;
    let current = request;
    while (count < limit) {
      const causedBy = current.causation?.causedBy;
      if (causedBy === undefined) break;
      const earlier = yield* get(causedBy);
      if (Option.isNone(earlier)) break;
      const event = earlier.value.event;
      if (
        event.kind !== "review.requested@1" ||
        event.payload.runKey !== request.payload.runKey ||
        event.attribution.cycleId !== request.attribution.cycleId
      )
        break;
      count += 1;
      current = event;
    }
    return count;
  });

/**
 * Asks for the follow-on of request `requestId` (the running generation's own request), unless
 * `cap` follow-ons already lie behind it. In one write transaction (`BEGIN IMMEDIATE`), so two
 * callers cannot both append; under the key `review-follow-on:<requestId>`, so a second attempt of
 * the same job asks once and gets the same event back, whatever cap it passes. The held event is
 * that repeat only when it is the follow-on this function writes for n, field for field apart from
 * its ID and time, and the next generation's review job is its own; anything else under the key is
 * refused with `IdempotencyConflict`.
 *
 * Refused with `InvalidEvent`, appending nothing, when request n has no unfinished review job of its
 * own (it is not the run that is going, or it joined another request's job), or when the next
 * generation's job key already belongs to another request: the append would then enqueue nothing.
 */
export const requestFollowOn = (options: {
  readonly requestId: string;
  readonly cap: number;
}) =>
  Effect.gen(function* () {
    if (!Number.isInteger(options.cap) || options.cap < 0)
      return yield* new InvalidEvent({
        message: `a follow-on cap must be a whole number of at least 0, not ${options.cap}`,
      });
    const sql = yield* SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* assertCompatible;
        const request = yield* reviewRequest(options.requestId);
        const occurredAt = new Date(
          yield* Clock.currentTimeMillis,
        ).toISOString();
        const idempotencyKey = `review-follow-on:${request.id}`;
        const generation = request.payload.generation + 1;
        const jobKey = `review.run:${request.payload.runKey}:${generation}`;
        // A repeat of the same ask is recognised first, so a lower cap on a retry still gets it.
        const [held] = yield* sql<{
          id: string;
          fingerprint: string;
        }>`SELECT id, fingerprint FROM events WHERE idempotency_key = ${idempotencyKey}`;
        if (held !== undefined) {
          // The held event is the repeat only when it is the follow-on the append below would write
          // for n. Compared as the log compares a retried append (`fingerprintOf`): everything but
          // the event ID and `occurredAt`, which two asks mint afresh (the key is equal by the
          // query). A generation past the schema's last does not decode, and is no follow-on.
          const expected = yield* Effect.option(
            parseEvent(followOnOf(request, held.id, occurredAt)),
          );
          // Its review job must be its own. Job rows are never deleted (a missing one fails
          // `fsck`), so the row is always there; its state is not checked: a retried attempt of n
          // may ask after the follow-on's job has started or ended, and must get the same answer.
          const [job] = yield* sql<{
            eventId: string | null;
          }>`SELECT event_id FROM jobs
            WHERE dedupe_key = ${jobKey} AND ${sql.in("kind", REVIEW_RUN_KINDS)}`;
          const stored = yield* get(held.id);
          if (
            Option.isNone(expected) ||
            fingerprintOf(expected.value) !== held.fingerprint ||
            job?.eventId !== held.id ||
            Option.isNone(stored) ||
            stored.value.event.kind !== "review.requested@1"
          )
            return yield* new IdempotencyConflict({
              idempotencyKey,
              existingEventId: held.id,
            });
          const repeat: FollowOn = {
            _tag: "Requested",
            requestId: held.id,
            generation: stored.value.event.payload.generation,
            followOns: yield* countBehind(stored.value.event, MAX_GENERATION),
            appended: false,
          };
          return repeat;
        }
        const [own] = yield* sql<{
          seq: number;
        }>`SELECT job_seq AS seq FROM jobs
          WHERE event_id = ${request.id} AND ${sql.in("kind", REVIEW_RUN_KINDS)}
            AND state IN ('waiting', 'delayed', 'active') LIMIT 1`;
        if (own === undefined)
          return yield* new InvalidEvent({
            message: `${request.id} has no unfinished review job of its own; only the run that is going may ask for its follow-on`,
          });
        const [taken] = yield* sql<{
          seq: number;
        }>`SELECT job_seq AS seq FROM jobs WHERE dedupe_key = ${jobKey}`;
        if (taken !== undefined)
          return yield* new InvalidEvent({
            message: `the next generation's review job of ${request.id} already belongs to another request`,
          });
        const behind = yield* countBehind(request, options.cap + 1);
        if (behind >= options.cap || generation > MAX_GENERATION) {
          const capped: FollowOn = { _tag: "CapReached", followOns: behind };
          return capped;
        }
        const [result] = yield* append([
          followOnOf(request, mintUlid(), occurredAt),
        ]);
        if (result === undefined)
          return yield* new CorruptRecord({
            message: `the follow-on of ${request.id} returned no append result`,
          });
        // The append leaves an existing job of the key alone; failing here rolls the event back.
        const [job] = yield* sql<{
          eventId: string | null;
        }>`SELECT event_id FROM jobs WHERE dedupe_key = ${jobKey}`;
        if (job?.eventId !== result.id)
          return yield* new CorruptRecord({
            message: `the follow-on of ${request.id} was appended without a review job of its own`,
          });
        const requested: FollowOn = {
          _tag: "Requested",
          requestId: result.id,
          generation,
          followOns: behind + 1,
          appended: result.status === "appended",
        };
        return requested;
      }),
    );
  });

/** How many follow-ons lie behind request `requestId`: 0 for a person's own request. Read-only. */
export const followOnsOf = (options: { readonly requestId: string }) =>
  Effect.gen(function* () {
    yield* assertCompatible;
    const request = yield* reviewRequest(options.requestId);
    return yield* countBehind(request, MAX_GENERATION);
  });
