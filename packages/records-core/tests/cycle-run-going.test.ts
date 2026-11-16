// Why: the desk says "N batches not reviewed" only when `cycleRunGoing` answers a definite `false`,
// so a wrong `false` is a wrong statement to a person. A newer build may ask for a review under a
// request kind this build cannot read, and a queued job may have no event or an event in no cycle
// (8.19); either may be this cycle's run, so the answer must be "unknown", never `false`. The cases
// that must not turn into "unknown" are here too, so the guard does not hide every real `false`.
import { afterAll, expect, test } from "bun:test";
import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import {
  Log,
  ReviewProgress,
  canonicalJson,
  mintUlid,
  sha256Hex,
  type StoreLocation,
} from "../src/index.ts";
import { fingerprintOf } from "../src/codec.ts";
import {
  actor,
  cycleEvents,
  freshLocation,
  headOid,
  removeTemporaryDirectories,
  runOn,
} from "./support.ts";

afterAll(removeTemporaryDirectories);

const range = { baseRef: "refs/heads/main", baseOid: "b".repeat(40), headOid };

const openCycle = () => {
  const { events } = cycleEvents(1);
  const cycleId = (events[0]?.attribution as { cycleId: string }).cycleId;
  return { cycleId, events };
};

const request = (cycleId: string, kind = "review.requested@1") => ({
  id: mintUlid(),
  kind,
  idempotencyKey: `request:${mintUlid()}`,
  actor,
  occurredAt: "2026-11-01T10:00:00.000Z",
  attribution: { cycleId, range },
  payload: {
    runKey: sha256Hex(mintUlid()),
    generation: 0,
    pipeline: { version: 10, config: {} },
  },
});

/**
 * Writes an event row as a newer build's append does, since this build's append refuses a kind it
 * does not know: the canonical envelope, its fingerprint and, unless `indexed` is false, the cycle
 * row its attribution names.
 */
const insertNewerEvent = (event: ReturnType<typeof request>, indexed = true) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const [row] = yield* sql<{ seq: number }>`INSERT INTO events ${sql.insert({
      id: event.id,
      kind: event.kind,
      idempotency_key: event.idempotencyKey,
      fingerprint: fingerprintOf(event),
      actor_id: event.actor,
      occurred_at: event.occurredAt,
      recorded_at: "2026-11-01T10:00:01.000Z",
      envelope: canonicalJson(event),
    })} RETURNING seq`;
    if (indexed)
      yield* sql`INSERT INTO event_cycles ${sql.insert({ cycle_id: event.attribution.cycleId, event_seq: row!.seq })}`;
  });

const insertJob = (kind: string, eventId: string | null, state = "waiting") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql`INSERT INTO jobs ${sql.insert({
      kind,
      dedupe_key: `${kind}:${mintUlid()}`,
      event_id: eventId,
      state,
    })}`;
  });

const finishReviewJobs = (requestId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql`UPDATE jobs SET state = 'completed'
      WHERE event_id = ${requestId} AND kind = 'review.run@2'`;
  });

/** A cycle whose one readable request's review job has completed: on its own it answers `false`. */
const finishedCycle = async () => {
  const location = freshLocation();
  const { cycleId, events } = openCycle();
  const asked = request(cycleId);
  await runOn(location, Log.append([...events, asked]));
  await runOn(location, finishReviewJobs(asked.id));
  expect(await going(location, cycleId)).toBe(false);
  return { location, cycleId, asked };
};

const going = (location: StoreLocation, cycleId: string) =>
  runOn(location, ReviewProgress.cycleRunGoing(cycleId));

test("a newer build's request of the cycle with an unfinished job is unknown, not false", async () => {
  // Its job may be a review run this build knows or a kind only the newer build knows.
  for (const kind of ["review.run@2", "review.run@9"]) {
    const { location, cycleId } = await finishedCycle();
    const newer = request(cycleId, "review.requested@2");
    await runOn(location, insertNewerEvent(newer));
    await runOn(location, insertJob(kind, newer.id, "active"));
    expect(await going(location, cycleId)).toBe("unknown");
  }
});

test("an unfinished run that cannot be tied to a cycle is unknown, not false", async () => {
  // No event at all, and an event the cycle index does not hold.
  const untied = [
    () => insertJob("review.run@2", null),
    () =>
      Effect.gen(function* () {
        const orphan = request(mintUlid(), "review.requested@2");
        yield* insertNewerEvent(orphan, false);
        yield* insertJob("review.run@9", orphan.id, "delayed");
      }),
  ];
  for (const plant of untied) {
    const { location, cycleId } = await finishedCycle();
    await runOn(location, plant());
    expect(await going(location, cycleId)).toBe("unknown");
  }
});

test("an unfinished job of another cycle's event, or a known job that is not a review, leaves false", async () => {
  const { location, cycleId } = await finishedCycle();
  const other = openCycle();
  const elsewhere = request(other.cycleId);
  await runOn(location, Log.append([...other.events, elsewhere]));
  await runOn(location, insertJob("review.run@9", elsewhere.id, "active"));
  // Another cycle's run is going; this cycle's answer does not move.
  expect(await going(location, other.cycleId)).toBe(true);
  expect(await going(location, cycleId)).toBe(false);
  // A stack fetch tied to no cycle is never a review run.
  await runOn(location, insertJob("stack.fetch", null));
  expect(await going(location, cycleId)).toBe(false);
});

test("a going run still answers true beside an untied job", async () => {
  const location = freshLocation();
  const { cycleId, events } = openCycle();
  await runOn(location, Log.append([...events, request(cycleId)]));
  await runOn(location, insertJob("review.run@9", null, "active"));
  expect(await going(location, cycleId)).toBe(true);
});
