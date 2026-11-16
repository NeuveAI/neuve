// Why: the desk reloads only the pages of the reviews that changed between two review marks, and
// shows "N batches not reviewed" only while no run of the cycle is going. A wrong list reloads the
// wrong page or none; a wrong "going" shows a stopped review as running for ever, or the reverse.
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

/** A cycle's opening events; `withDisposition` false leaves out its one review event. */
const cycle = (withDisposition = true) => {
  const { events } = cycleEvents(1);
  const cycleId = (events[0]?.attribution as { cycleId: string }).cycleId;
  return { cycleId, events: withDisposition ? events : events.slice(0, -1) };
};

const stageStarted = (cycleId: string, agent: string) => ({
  id: mintUlid(),
  kind: "stage.started@1",
  idempotencyKey: `stage.started:${mintUlid()}`,
  actor,
  occurredAt: new Date().toISOString(),
  attribution: { cycleId, runId: "run", stage: "understand", range },
  payload: { agent },
});

const request = (cycleId: string) => ({
  id: mintUlid(),
  kind: "review.requested@1",
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

const mark = (location: StoreLocation) =>
  runOn(location, ReviewProgress.reviewSequence);
const changed = (location: StoreLocation, after: number, upTo: number) =>
  runOn(location, ReviewProgress.changedCycles(after, upTo));

test("events of two cycles between the marks give both cycles once; others are left out", async () => {
  const location = freshLocation();
  const before = cycle();
  await runOn(location, Log.append(before.events));
  const after = await mark(location);
  const first = cycle();
  const second = cycle();
  // A cycle whose events in the range are all of kinds the desk does not show.
  const quiet = cycle(false);
  await runOn(
    location,
    Log.append([
      ...first.events,
      ...second.events,
      ...quiet.events,
      stageStarted(first.cycleId, "a"),
      stageStarted(second.cycleId, "b"),
    ]),
  );
  const upTo = await mark(location);
  const later = cycle();
  await runOn(location, Log.append(later.events));
  expect(await changed(location, after, upTo)).toEqual(
    [first.cycleId, second.cycleId].sort(),
  );
  // The mark itself is the lower end's last event, outside the range.
  expect(await changed(location, after - 1, after)).toEqual([before.cycleId]);
});

test("a review event with no cycle gives all", async () => {
  const location = freshLocation();
  const { cycleId, events } = cycle();
  await runOn(location, Log.append(events));
  const after = await mark(location);
  const orphan = stageStarted(cycleId, "orphan");
  const { cycleId: _, ...attribution } = orphan.attribution;
  await runOn(
    location,
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      // A row with no cycle index entry, which no append of this build writes.
      yield* sql`INSERT INTO events ${sql.insert({
        id: orphan.id,
        kind: orphan.kind,
        idempotency_key: orphan.idempotencyKey,
        fingerprint: sha256Hex(orphan.id),
        actor_id: orphan.actor,
        occurred_at: orphan.occurredAt,
        recorded_at: orphan.occurredAt,
        envelope: canonicalJson({ ...orphan, attribution }),
      })}`;
    }),
  );
  expect(await changed(location, after, await mark(location))).toBe("all");
});

test("more review events than the bound give all; the bound itself still names the cycle", async () => {
  const location = freshLocation();
  const { cycleId, events } = cycle(false);
  await runOn(location, Log.append(events));
  const after = await mark(location);
  const bound = ReviewProgress.CHANGED_CYCLES_BOUND;
  await runOn(
    location,
    Log.append(
      Array.from({ length: bound }, (_, n) => stageStarted(cycleId, `a${n}`)),
    ),
  );
  const atBound = await mark(location);
  expect(await changed(location, after, atBound)).toEqual([cycleId]);
  // Spread over two kinds, so the bound counts across kinds.
  const other = cycle();
  await runOn(location, Log.append(other.events));
  expect(await changed(location, after, await mark(location))).toBe("all");
});

test("an empty range gives no cycles", async () => {
  const location = freshLocation();
  const { events } = cycle();
  await runOn(location, Log.append(events));
  const upTo = await mark(location);
  expect(await changed(location, upTo, upTo)).toEqual([]);
  expect(await changed(location, upTo + 1, upTo)).toEqual([]);
});

test("a mark that is not a log position is refused, not coerced", async () => {
  const location = freshLocation();
  for (const [after, upTo] of [
    [-1, 3],
    [0, -2],
    [1.5, 3],
    [0, Number.NaN],
    [0, Number.POSITIVE_INFINITY],
  ] as const) {
    const error = await runOn(
      location,
      Effect.flip(ReviewProgress.changedCycles(after, upTo)),
    );
    expect(error).toBeInstanceOf(ReviewProgress.InvalidReviewMark);
  }
});

const setJob = (requestId: string, state: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql`UPDATE jobs SET state = ${state},
      last_error = ${state === "failed" ? "test" : null}
      WHERE event_id = ${requestId} AND kind = 'review.run@2'`;
  });
const going = (location: StoreLocation, cycleId: string) =>
  runOn(location, ReviewProgress.cycleRunGoing(cycleId));

test("a cycle's run is going while its review job is waiting, delayed or active", async () => {
  const location = freshLocation();
  const { cycleId, events } = cycle();
  const asked = request(cycleId);
  await runOn(location, Log.append([...events, asked]));
  expect(await going(location, cycleId)).toBe(true);
  for (const state of ["delayed", "active"]) {
    await runOn(location, setJob(asked.id, state));
    expect(await going(location, cycleId)).toBe(true);
  }
});

test("an older run still active beside a newer completed one is going", async () => {
  const location = freshLocation();
  const { cycleId, events } = cycle();
  const older = request(cycleId);
  const newer = request(cycleId);
  await runOn(location, Log.append([...events, older, newer]));
  await runOn(location, setJob(older.id, "active"));
  await runOn(location, setJob(newer.id, "completed"));
  // The review list shows the newest run, completed; a run of the cycle is still going.
  expect(await going(location, cycleId)).toBe(true);
});

test("a cycle's run is not going once its job finished or failed, or its receipt is in", async () => {
  const location = freshLocation();
  const { cycleId, events } = cycle();
  const asked = request(cycleId);
  await runOn(location, Log.append([...events, asked]));
  for (const state of ["completed", "failed"]) {
    await runOn(location, setJob(asked.id, state));
    expect(await going(location, cycleId)).toBe(false);
  }
  // As the review list reads it, a completed receipt wins over a job still marked active.
  await runOn(
    location,
    Effect.gen(function* () {
      yield* setJob(asked.id, "active");
      const sql = yield* SqlClient;
      yield* sql`INSERT INTO projection_runs ${sql.insert({
        run_id: asked.id,
        cycle_id: cycleId,
        event_id: mintUlid(),
        outcome: "completed",
        ended_at: "2026-11-01T10:05:00.000Z",
        wall_ms: 1,
        queue_wait_ms: 0,
        model_calls: 0,
        retries: 0,
        tokens_input: 0,
        tokens_output: 0,
      })}`;
    }),
  );
  expect(await going(location, cycleId)).toBe(false);
});

test("a cycle with no review request, or with an unfinished job of an unknown kind, is unknown", async () => {
  const location = freshLocation();
  const { cycleId, events } = cycle();
  await runOn(location, Log.append(events));
  expect(await going(location, cycleId)).toBe("unknown");
  expect(await going(location, mintUlid())).toBe("unknown");
  const asked = request(cycleId);
  await runOn(location, Log.append([asked]));
  await runOn(
    location,
    Effect.gen(function* () {
      yield* setJob(asked.id, "failed");
      const sql = yield* SqlClient;
      // A newer build's run of the same request, under a kind this build does not know.
      yield* sql`INSERT INTO jobs ${sql.insert({
        kind: "review.run@9",
        dedupe_key: `review.run@9:${asked.id}`,
        event_id: asked.id,
        state: "active",
      })}`;
    }),
  );
  expect(await going(location, cycleId)).toBe("unknown");
  // Finished, it can no longer be a going run.
  await runOn(
    location,
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      yield* sql`UPDATE jobs SET state = 'completed' WHERE kind = 'review.run@9'`;
    }),
  );
  expect(await going(location, cycleId)).toBe(false);
});
