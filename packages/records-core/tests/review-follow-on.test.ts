import { afterAll, expect, test } from "bun:test";
import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import {
  Log,
  ReviewFollowOn,
  ReviewProgress,
  mintUlid,
  sha256Hex,
  type StoreLocation,
} from "../src/index.ts";
import { receipt } from "./review-fixtures.ts";
import {
  actor,
  agent,
  cycleEvents,
  envelope,
  freshLocation,
  headOid,
  removeTemporaryDirectories,
  runOn,
} from "./support.ts";

afterAll(removeTemporaryDirectories);

const range = { baseRef: "refs/heads/main", baseOid: "b".repeat(40), headOid };

/** A person's request, as the harness writes one: its own key, an intent and no `causedBy`. */
const personRequest = (cycleId: string, runKey: string, generation = 0) => ({
  id: mintUlid(),
  kind: "review.requested@1",
  idempotencyKey: `review.requested:${mintUlid()}`,
  causation: { correlationId: "neuve-review-intent:test" },
  actor,
  occurredAt: "2026-11-12T10:00:00.000Z",
  attribution: { cycleId, range },
  payload: {
    runKey,
    generation,
    pipeline: { version: 10, config: { tier: "test" } },
  },
});

/** A store with one cycle and a person's request in it. */
const requested = async (generation = 0) => {
  const location = freshLocation();
  const { events } = cycleEvents(1);
  const cycleId = (events[0]?.attribution as { cycleId: string }).cycleId;
  const runKey = sha256Hex(mintUlid());
  const asked = personRequest(cycleId, runKey, generation);
  await runOn(location, Log.append([...events, asked]));
  return { location, cycleId, runKey, asked };
};

const setReviewJob = (eventId: string, state: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql`UPDATE jobs SET state = ${state}
      WHERE event_id = ${eventId} AND kind = 'review.run@2'`;
  });

const jobsOf = (location: StoreLocation, eventId: string) =>
  runOn(
    location,
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      return yield* sql<{
        kind: string;
        dedupeKey: string;
        state: string;
      }>`SELECT kind, dedupe_key, state FROM jobs WHERE event_id = ${eventId} ORDER BY job_seq`;
    }),
  );

const ask = (location: StoreLocation, requestId: string, cap = 8) =>
  runOn(location, ReviewFollowOn.requestFollowOn({ requestId, cap }));

const followOnRequests = (location: StoreLocation, requestId: string) =>
  runOn(
    location,
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      return yield* sql<{
        id: string;
      }>`SELECT id FROM events WHERE idempotency_key = ${`review-follow-on:${requestId}`}`;
    }),
  );

test("the follow-on and its jobs are appended while request n's run is active", async () => {
  // Why: the follow-on exists so that no reader ever sees the cycle with no run going. It must be
  // appended, with its own review job, while n's job is still active, and the cycle must read as
  // going from then on, including once n has its receipt.
  const { location, cycleId, runKey, asked } = await requested();
  await runOn(location, setReviewJob(asked.id, "active"));
  const result = await ask(location, asked.id);
  expect(result).toMatchObject({
    _tag: "Requested",
    generation: 1,
    followOns: 1,
    appended: true,
  });
  if (result._tag !== "Requested") throw new Error("not requested");
  const stored = await runOn(location, Log.get(result.requestId));
  const event = stored._tag === "Some" ? stored.value.event : undefined;
  expect(event).toMatchObject({
    kind: "review.requested@1",
    idempotencyKey: `review-follow-on:${asked.id}`,
    causation: {
      causedBy: asked.id,
      correlationId: asked.causation.correlationId,
    },
    actor: asked.actor,
    attribution: asked.attribution,
    payload: { ...asked.payload, generation: 1 },
  });
  const jobs = await jobsOf(location, result.requestId);
  expect(jobs.filter((job) => job.kind !== "commit.prepare@2")).toEqual([
    {
      kind: "review.run@2",
      dedupeKey: `review.run:${runKey}:1`,
      state: "waiting",
    },
    {
      kind: "stack.fetch",
      dedupeKey: `stack.fetch:review:${runKey}:1`,
      state: "waiting",
    },
  ]);
  expect((await jobsOf(location, asked.id))[0]?.state).toBe("active");
  expect(await runOn(location, ReviewProgress.cycleRunGoing(cycleId))).toBe(
    true,
  );
  // n ends and writes its receipt; the follow-on's waiting job keeps the cycle going.
  await runOn(location, setReviewJob(asked.id, "completed"));
  await runOn(
    location,
    Log.append([
      envelope(
        "run.completed@1",
        `review:${asked.id}:run.completed`,
        agent,
        { cycleId, range, runId: asked.id },
        { ...receipt(runKey, 1), outcome: "timed-out" },
      ),
    ]),
  );
  expect(await runOn(location, ReviewProgress.cycleRunGoing(cycleId))).toBe(
    true,
  );
  expect(
    await runOn(
      location,
      ReviewFollowOn.followOnsOf({ requestId: result.requestId }),
    ),
  ).toBe(1);
  expect(
    await runOn(location, ReviewFollowOn.followOnsOf({ requestId: asked.id })),
  ).toBe(0);
});

test("a second attempt of the same job appends nothing and gets the same follow-on", async () => {
  // Why: a retried job asks again; it must not queue a second run.
  const { location, asked } = await requested();
  const first = await ask(location, asked.id);
  const second = await ask(location, asked.id);
  if (first._tag !== "Requested") throw new Error("not requested");
  expect(first.appended).toBe(true);
  expect(second).toEqual({ ...first, appended: false });
  // A retry that passes a lower cap still gets the follow-on it already asked for.
  expect(await ask(location, asked.id, 0)).toEqual({
    ...first,
    appended: false,
  });
  expect(await followOnRequests(location, asked.id)).toHaveLength(1);
  // A retried attempt of n may ask whatever state the follow-on's own job is in, n's own included;
  // it gets the same answer.
  await runOn(location, setReviewJob(asked.id, "completed"));
  for (const state of ["waiting", "delayed", "active", "completed", "failed"]) {
    await runOn(location, setReviewJob(first.requestId, state));
    expect({ state, answer: await ask(location, asked.id, 0) }).toEqual({
      state,
      answer: { ...first, appended: false },
    });
  }
  expect(await followOnRequests(location, asked.id)).toHaveLength(1);
});

const eventCount = (location: StoreLocation) =>
  runOn(
    location,
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const [row] = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM events`;
      return row?.n;
    }),
  );

/** N's follow-on written by hand as `requestFollowOn` writes it, with `patch` over it. */
const handWritten = (
  asked: ReturnType<typeof personRequest>,
  patch: Record<string, unknown> = {},
) => ({
  id: mintUlid(),
  kind: "review.requested@1",
  idempotencyKey: `review-follow-on:${asked.id}`,
  causation: {
    causedBy: asked.id,
    correlationId: asked.causation.correlationId,
  },
  actor: asked.actor,
  occurredAt: "2026-11-12T11:00:00.000Z",
  attribution: asked.attribution,
  payload: { ...asked.payload, generation: 1 },
  ...patch,
});

test("a hand-written copy of n's follow-on is answered as the repeat", async () => {
  // Why: the imitations below differ from this copy in one mark each; this shows the copy itself,
  // with its own ID and time, is what the function writes, so each refusal is that mark's.
  const { location, asked } = await requested();
  const copy = handWritten(asked);
  await runOn(location, Log.append([copy]));
  expect(await ask(location, asked.id)).toEqual({
    _tag: "Requested",
    requestId: copy.id,
    generation: 1,
    followOns: 1,
    appended: false,
  });
});

/** Asks again for n's follow-on: refused, naming `heldId`, with nothing appended. */
const refusedRepeat = async (
  location: StoreLocation,
  requestId: string,
  heldId: string,
) => {
  const before = await eventCount(location);
  const refused = await runOn(
    location,
    Effect.flip(ReviewFollowOn.requestFollowOn({ requestId, cap: 8 })),
  );
  expect(refused).toMatchObject({
    _tag: "IdempotencyConflict",
    idempotencyKey: `review-follow-on:${requestId}`,
    existingEventId: heldId,
  });
  expect(await eventCount(location)).toBe(before);
};

test("a copy of n's follow-on attributed to another cycle is refused", async () => {
  // Why: its job would run for the other cycle, and the asking cycle would have no run going.
  const { location, asked } = await requested();
  const other = cycleEvents(1).events;
  const otherCycleId = (other[0]?.attribution as { cycleId: string }).cycleId;
  const held = handWritten(asked, {
    attribution: { ...asked.attribution, cycleId: otherCycleId },
  });
  await runOn(location, Log.append([...other, held]));
  await refusedRepeat(location, asked.id, held.id);
});

test("a copy of n's follow-on that joined another request's job is refused", async () => {
  // Why: it has no review job of its own; the next generation's job runs for another request.
  const { location, cycleId, runKey, asked } = await requested();
  await runOn(location, Log.append([personRequest(cycleId, runKey, 1)]));
  const held = handWritten(asked);
  await runOn(location, Log.append([held]));
  await refusedRepeat(location, asked.id, held.id);
});

test("a copy of n's follow-on with another pipeline configuration is refused", async () => {
  // Why: its job would run a configuration n did not freeze.
  const { location, asked } = await requested();
  const held = handWritten(asked, {
    payload: {
      ...asked.payload,
      generation: 1,
      pipeline: { version: 10, config: { tier: "other" } },
    },
  });
  await runOn(location, Log.append([held]));
  await refusedRepeat(location, asked.id, held.id);
});

test("a copy of n's follow-on by another actor is refused", async () => {
  // Why: the follow-on continues n's request, so it is n's actor's.
  const { location, asked } = await requested();
  const held = handWritten(asked, {
    actor: sha256Hex("neuve-actor/1\u0000test\u0000other"),
  });
  await runOn(location, Log.append([held]));
  await refusedRepeat(location, asked.id, held.id);
});

test("a request under the follow-on key that is not n's follow-on is refused", async () => {
  // Why: a `Requested` answer must name a request whose own job will run as n's next generation.
  // (A) an unrelated request of another run key and cycle; (B) a request of n's run key and
  // generation, which joined n's job and has none of its own. Neither is n's follow-on.
  for (const input of ["unrelated", "joined"] as const) {
    const { location, cycleId, runKey, asked } = await requested();
    const idempotencyKey = `review-follow-on:${asked.id}`;
    let held;
    if (input === "unrelated") {
      const other = cycleEvents(1).events;
      const otherCycleId = (other[0]?.attribution as { cycleId: string })
        .cycleId;
      held = {
        ...personRequest(otherCycleId, sha256Hex(mintUlid()), 1),
        idempotencyKey,
      };
      await runOn(location, Log.append([...other, held]));
    } else {
      held = { ...personRequest(cycleId, runKey, 0), idempotencyKey };
      await runOn(location, Log.append([held]));
    }
    const before = await eventCount(location);
    const refused = await runOn(
      location,
      Effect.flip(
        ReviewFollowOn.requestFollowOn({ requestId: asked.id, cap: 8 }),
      ),
    );
    expect({ input, refused }).toMatchObject({
      input,
      refused: {
        _tag: "IdempotencyConflict",
        idempotencyKey,
        existingEventId: held.id,
      },
    });
    expect(await eventCount(location)).toBe(before);
  }
});

/** Asks for a follow-on that must fail with `InvalidEvent` and leave nothing appended. */
const refusedAsk = async (
  location: StoreLocation,
  requestId: string,
  because: string,
) => {
  const refused = await runOn(
    location,
    Effect.flip(ReviewFollowOn.requestFollowOn({ requestId, cap: 8 })),
  );
  expect(refused._tag).toBe("InvalidEvent");
  expect(refused.message).toContain(because);
  expect(await followOnRequests(location, requestId)).toHaveLength(0);
};

test("a request whose run is not going is refused, even when its next generation is taken", async () => {
  // Why (the reviewer's probe): after n completed, a person's request took generation n + 1 with
  // its own job. A follow-on of n would join that job and nothing of its own would run, so the ask
  // must fail and append nothing rather than answer `Requested`.
  const { location, cycleId, runKey, asked } = await requested();
  await runOn(location, setReviewJob(asked.id, "completed"));
  await runOn(location, Log.append([personRequest(cycleId, runKey, 1)]));
  await refusedAsk(location, asked.id, "no unfinished review job");
});

test("a request that joined another request's job is refused", async () => {
  // Why: a second request of the same key and generation joins the first one's job and has no job
  // row of its own; it is not the run that is going, so it may not ask.
  const { location, cycleId, runKey, asked } = await requested();
  await runOn(location, setReviewJob(asked.id, "active"));
  const joined = personRequest(cycleId, runKey, 0);
  await runOn(location, Log.append([joined]));
  expect(
    (await jobsOf(location, joined.id)).filter((job) =>
      job.kind.startsWith("review.run"),
    ),
  ).toEqual([]);
  await refusedAsk(location, joined.id, "no unfinished review job");
});

test("a going run whose next generation's job belongs to another request is refused", async () => {
  // Why: the probe's hazard with n still active. `request.ts` never writes that, but a hand-written
  // or older build's request could, and the free-key check alone must then refuse.
  const { location, cycleId, runKey, asked } = await requested();
  await runOn(location, setReviewJob(asked.id, "active"));
  await runOn(location, Log.append([personRequest(cycleId, runKey, 1)]));
  await refusedAsk(location, asked.id, "already belongs to another request");
});

test("the cap refuses the next follow-on, and a person's fresh request starts a new count", async () => {
  // Why: the cap is all that stops a run that never finishes from asking forever; it is counted
  // along the `causedBy` chain, so it must hold there and reset for a person's own request.
  const { location, cycleId, runKey, asked } = await requested();
  const first = await ask(location, asked.id, 2);
  if (first._tag !== "Requested") throw new Error("not requested");
  const second = await ask(location, first.requestId, 2);
  expect(second).toMatchObject({
    _tag: "Requested",
    generation: 2,
    followOns: 2,
  });
  if (second._tag !== "Requested") throw new Error("not requested");
  expect(await ask(location, second.requestId, 2)).toEqual({
    _tag: "CapReached",
    followOns: 2,
  });
  expect(await followOnRequests(location, second.requestId)).toHaveLength(0);
  const fresh = personRequest(cycleId, runKey, 3);
  await runOn(location, Log.append([fresh]));
  expect(await ask(location, fresh.id, 2)).toMatchObject({
    _tag: "Requested",
    generation: 4,
    followOns: 1,
  });
  // The schema's last generation has no next one.
  const last = await requested(1_000);
  expect(await ask(last.location, last.asked.id)).toEqual({
    _tag: "CapReached",
    followOns: 0,
  });
});

test("an event that is not a review request is refused", async () => {
  // Why: the handler passes an ID; anything but a review request must fail typed, not append.
  const location = freshLocation();
  const { events } = cycleEvents(1);
  await runOn(location, Log.append(events));
  for (const requestId of [events[0]!.id, mintUlid(), "not-an-id"]) {
    const refused = await runOn(
      location,
      Effect.flip(ReviewFollowOn.requestFollowOn({ requestId, cap: 8 })),
    );
    expect(refused._tag).toBe("InvalidEvent");
    const read = await runOn(
      location,
      Effect.flip(ReviewFollowOn.followOnsOf({ requestId })),
    );
    expect(read._tag).toBe("InvalidEvent");
  }
});

test("two concurrent callers append one follow-on", async () => {
  // Why: the count and the append are one write transaction; two connections asking at once must
  // record one request between them.
  const { location, asked } = await requested();
  const results = await Promise.all([
    ask(location, asked.id),
    ask(location, asked.id),
  ]);
  const ids = new Set(
    results.map((result) =>
      result._tag === "Requested" ? result.requestId : "",
    ),
  );
  expect(ids.size).toBe(1);
  expect(
    results
      .map((result) => result._tag === "Requested" && result.appended)
      .sort(),
  ).toEqual([false, true]);
  expect(await followOnRequests(location, asked.id)).toHaveLength(1);
});
