// Why: the web app's Reviews page lists every review of a repository, ten at a time, from this one
// read. These pin what the owner sees (newest run first, each review's state and its packet of
// record's batches in the manifest's order, a request that started nothing left out) and what keeps
// the page cheap as reviews accumulate: pages that never repeat a review, and one manifest blob read
// per review, never the whole packet. Since 10.127 a unit counts as decided once any person decided it
// (the page tracks no viewer's own share), so an agent's disposition must not count; feedback counts
// whoever gave it.
import { afterAll, expect, test } from "bun:test";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import {
  Blobs,
  HumanCommands,
  Identity,
  Log,
  ReviewList,
  mintUlid,
  sha256Hex,
  type StoreLocation,
} from "../src/index.ts";
import { receipt } from "./review-fixtures.ts";
import {
  agent,
  envelope,
  freshLocation,
  removeTemporaryDirectories,
  runOn,
} from "./support.ts";

afterAll(removeTemporaryDirectories);

const owner = { email: "owner@example.com", displayName: "Owner" };
const ownerId = Identity.humanFingerprint(owner.email);
const other = { email: "other@example.com", displayName: "Other" };

const counts = {
  batches: 0,
  units: 0,
  contextReferences: 0,
  assessments: 0,
  deliveries: 0,
  dispositions: 0,
  comments: 0,
  gaps: 0,
};

/** A cycle with its batches (each a title and the lanes of its units; null leaves a unit unassessed). */
const cycle = (
  label: string,
  batches: ReadonlyArray<{
    readonly title: string;
    readonly lanes: ReadonlyArray<string | null>;
  }>,
) => {
  const cycleId = mintUlid();
  const range = {
    baseRef: "refs/heads/main",
    baseOid: sha256Hex(`${label}:base`).slice(0, 40),
    headOid: sha256Hex(`${label}:head`).slice(0, 40),
  };
  const recorded = batches.map((batch) => ({
    batchId: mintUlid(),
    title: batch.title,
    units: batch.lanes.map((lane) => ({ unitId: mintUlid(), lane })),
  }));
  const unitEvents = new Map<string, string>();
  const structure = [
    envelope(
      "cycle.opened@1",
      `cycle:${cycleId}`,
      agent,
      { cycleId, range },
      {},
    ),
    ...recorded.flatMap((batch) => [
      envelope(
        "batch.recorded@1",
        `batch:${batch.batchId}`,
        agent,
        { cycleId, batchId: batch.batchId },
        { title: batch.title, focus: "Focus" },
      ),
      ...batch.units.flatMap(({ unitId, lane }, index) => {
        const unit = envelope(
          "unit.recorded@1",
          `unit:${unitId}`,
          agent,
          { cycleId, batchId: batch.batchId, unitIds: [unitId] },
          {
            title: `Unit ${index}`,
            ownedRanges: [
              { path: `src/${index}.ts`, startLine: 1, endLine: 9 },
            ],
          },
        );
        unitEvents.set(unitId, unit.id);
        return lane === null
          ? [unit]
          : [
              unit,
              envelope(
                "assessment.recorded@1",
                `assessment:${unitId}`,
                agent,
                { cycleId, unitIds: [unitId] },
                {
                  lane,
                  complexity: "low",
                  easeOfValidation: "easy",
                  rationale: "Fixture",
                },
              ),
            ];
      }),
    ]),
  ];
  const request = (runKeyLabel: string) =>
    envelope(
      "review.requested@1",
      `request:${mintUlid()}`,
      agent,
      { cycleId, range },
      {
        runKey: sha256Hex(runKeyLabel),
        generation: 0,
        pipeline: { version: 1, config: {} },
      },
    );
  const run = (runId: string) => ({ cycleId, range, runId });
  const completed = (
    runId: string,
    outcome: "completed" | "timed-out",
    endedAt: string,
  ) => {
    const base = receipt(sha256Hex(`run:${runId}`), 1);
    return envelope(
      "run.completed@1",
      `review:${runId}:run.completed`,
      agent,
      run(runId),
      { ...base, outcome, timing: { ...base.timing, endedAt } },
    );
  };
  /** Stores the manifest, listing the batches in `order`, and returns the packet naming it. */
  const packet = (runId: string, order: ReadonlyArray<number>) =>
    Effect.gen(function* () {
      const blobs = yield* Blobs.BlobStore;
      const manifest = {
        batches: order.map((index) => {
          const batch = recorded[index]!;
          return {
            batch: `b${index + 1}`,
            batchId: batch.batchId,
            units: batch.units.map((unit, u) => ({
              unit: `b${index + 1}.u${u + 1}`,
              unitId: unit.unitId,
            })),
            events: [],
          };
        }),
      };
      const stored = yield* blobs.put({
        bytes: new TextEncoder().encode(JSON.stringify(manifest)),
        mediaType: "application/json",
        retention: "durable",
      });
      return {
        hash: stored.blob.hash,
        event: {
          ...envelope(
            "packet.published@1",
            `review:${runId}:packet`,
            agent,
            run(runId),
            { complete: true, counts },
          ),
          refs: [{ ref: `blob:${stored.blob.hash}`, role: "manifest" }],
        },
      };
    });
  return {
    cycleId,
    batches: recorded,
    structure,
    unitEvents,
    request,
    completed,
    packet,
  };
};

const setJob = (
  requestId: string,
  state: string,
  finishedAt: string | null = null,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql`UPDATE jobs SET state = ${state}, finished_at = ${finishedAt}
      WHERE event_id = ${requestId} AND kind IN ('review.run', 'review.run@2')`;
  });

/**
 * Four cycles, appended in this order: A completes; B times out; C's run fails before any packet;
 * D's only request joins B's job, so it starts nothing; then A runs again and is still running.
 */
const scenario = (location: StoreLocation) =>
  Effect.gen(function* () {
    const a = cycle("a", [
      { title: "First", lanes: ["human-required", "agentic"] },
      { title: "Second", lanes: [null] },
    ]);
    const b = cycle("b", [{ title: "Only", lanes: ["human-suggested"] }]);
    const c = cycle("c", []);
    const d = cycle("d", []);
    yield* Log.append([
      envelope("actor.registered@1", `actor:${agent}`, agent, undefined, {
        actorKind: "agent",
        harness: "neuve",
        sessionId: "s",
      }),
    ]);

    const a1 = a.request("a:1");
    yield* Log.append([...a.structure, a1]);
    // The manifest lists A's second batch first: packet order, not recording order.
    const aPacket = yield* a.packet(a1.id, [1, 0]);
    yield* Log.append([
      aPacket.event,
      a.completed(a1.id, "completed", "2026-10-20T09:00:00.000Z"),
    ]);
    yield* setJob(a1.id, "completed", "2026-10-20T09:00:01.000Z");

    const b1 = b.request("b:1");
    yield* Log.append([...b.structure, b1]);
    const bPacket = yield* b.packet(b1.id, [0]);
    yield* Log.append([
      bPacket.event,
      b.completed(b1.id, "timed-out", "2026-10-20T10:00:00.000Z"),
    ]);
    yield* setJob(b1.id, "completed", "2026-10-20T10:00:01.000Z");

    const c1 = c.request("c:1");
    yield* Log.append([...c.structure, c1]);
    yield* setJob(c1.id, "failed", "2026-10-20T11:00:00.000Z");

    // Same run key and generation as B's request: it joins B's job and enqueues nothing.
    const d1 = d.request("b:1");
    yield* Log.append([...d.structure, d1]);

    const a2 = a.request("a:2");
    yield* Log.append([a2]);

    return { a, b, c, d, a1, a2, b1, c1, hashes: [aPacket.hash, bPacket.hash] };
  }).pipe(Effect.provide(Blobs.layer(location)));

/** The blob store, counting each `get` by hash. */
const countingBlobs = (location: StoreLocation, gets: Map<string, number>) =>
  Layer.effect(
    Blobs.BlobStore,
    Effect.gen(function* () {
      const blobs = yield* Blobs.BlobStore;
      return Blobs.BlobStore.of({
        ...blobs,
        get: (hash) => {
          gets.set(hash, (gets.get(hash) ?? 0) + 1);
          return blobs.get(hash);
        },
      });
    }),
  ).pipe(Layer.provide(Blobs.layer(location)));

test("reviews read newest run first, each with its state and its packet's batches, one manifest read per review", async () => {
  const location = freshLocation();
  const fixture = await runOn(location, scenario(location));
  const gets = new Map<string, number>();
  const page = await runOn(
    location,
    ReviewList.reviews({ limit: 10 }).pipe(
      Effect.provide(countingBlobs(location, gets)),
    ),
  );
  const { a, b, c } = fixture;

  // D's request started nothing; A's rerun puts A first.
  expect(page.reviews.map((review) => review.cycleId)).toEqual([
    a.cycleId,
    c.cycleId,
    b.cycleId,
  ]);
  expect(page.next).toBeUndefined();

  const [listedA, listedC, listedB] = page.reviews;
  // A runs again: its state and run are the rerun's, its batches still the standing packet's.
  expect(listedA).toMatchObject({
    state: "running",
    runId: fixture.a2.id,
    at: fixture.a2.occurredAt,
    manifestIssue: undefined,
  });
  expect(listedA?.batches).toEqual([
    {
      batchId: a.batches[1]!.batchId,
      title: "Second",
      units: [{ unitId: a.batches[1]!.units[0]!.unitId, lane: null }],
    },
    {
      batchId: a.batches[0]!.batchId,
      title: "First",
      units: [
        { unitId: a.batches[0]!.units[0]!.unitId, lane: "human-required" },
        { unitId: a.batches[0]!.units[1]!.unitId, lane: "agentic" },
      ],
    },
  ]);
  expect(listedC).toMatchObject({
    state: "failed",
    runId: fixture.c1.id,
    at: "2026-10-20T11:00:00.000Z",
    batches: [],
  });
  expect(listedB).toMatchObject({
    state: "timed-out",
    runId: fixture.b1.id,
    at: "2026-10-20T10:00:00.000Z",
  });
  expect(listedB?.range.baseRef).toBe("refs/heads/main");

  // One blob read per review with a packet, each its manifest; C has none to read.
  expect([...gets.entries()].sort()).toEqual(
    fixture.hashes.map((hash) => [hash, 1] as [string, number]).sort(),
  );
});

test("pages follow the cursor without repeating a review, and the last page has no cursor", async () => {
  const location = freshLocation();
  const fixture = await runOn(location, scenario(location));
  const read = (before?: number) =>
    runOn(
      location,
      ReviewList.reviews({ limit: 1, before }).pipe(
        Effect.provide(Blobs.layer(location)),
      ),
    );
  const first = await read();
  const second = await read(first.next);
  const third = await read(second.next);
  expect(
    [first, second, third].map((page) => page.reviews[0]?.cycleId),
  ).toEqual([fixture.a.cycleId, fixture.c.cycleId, fixture.b.cycleId]);
  expect(first.next).toBeNumber();
  expect(second.next).toBeNumber();
  expect(third.next).toBeUndefined();
  // The total counts what the read pages through: every review, or those older than the cursor.
  expect([first, second, third].map((page) => page.total)).toEqual([3, 2, 1]);

  // Numbered pages read by position: page 2 of one review each is C, page 3 is B and the last,
  // and a page past the end is empty but still knows the total.
  const at = (offset: number) =>
    runOn(
      location,
      ReviewList.reviews({ limit: 1, offset }).pipe(
        Effect.provide(Blobs.layer(location)),
      ),
    );
  const two = await at(1);
  const three = await at(2);
  const past = await at(3);
  expect(two.reviews.map((review) => review.cycleId)).toEqual([
    fixture.c.cycleId,
  ]);
  expect(three.reviews.map((review) => review.cycleId)).toEqual([
    fixture.b.cycleId,
  ]);
  expect(three.next).toBeUndefined();
  expect(past.reviews).toEqual([]);
  expect([two.total, three.total, past.total]).toEqual([3, 3, 3]);
  // Paging values from an address arrive unchecked: a limit outside 1 to LIMIT_MAX, or not a
  // number, is clamped, never unbounded or a failed query; a cursor that is not a number reads
  // the first page.
  const page = (options: { limit: number; before?: number; offset?: number }) =>
    runOn(
      location,
      ReviewList.reviews(options).pipe(Effect.provide(Blobs.layer(location))),
    );
  expect((await page({ limit: 10_000 })).reviews).toHaveLength(3);
  expect((await page({ limit: Number.NaN })).reviews).toHaveLength(3);
  expect((await page({ limit: 0 })).reviews).toHaveLength(1);
  expect(
    (await page({ limit: 1, offset: Number.NaN })).reviews[0]?.cycleId,
  ).toBe(fixture.a.cycleId);
  expect(
    (await page({ limit: 1, before: Number.NaN })).reviews[0]?.cycleId,
  ).toBe(fixture.a.cycleId);
});

test("endedAfter keeps the reviews whose newest run ended after a time, whenever it was requested, and counts and pages only them", async () => {
  // Why: the Reviews page's All, after a clear, lists every review run after it. The list orders
  // by request and the clear cuts on when a run ended, so a run requested early that ended after
  // the clear must still be found, and only a time comparison (not the stored text) decides it.
  const location = freshLocation();
  const cutoff = "2026-10-20T12:00:00.500Z";
  const ids = await runOn(
    location,
    Effect.gen(function* () {
      yield* Log.append([
        envelope("actor.registered@1", `actor:${agent}`, agent, undefined, {
          actorKind: "agent",
          harness: "neuve",
          sessionId: "s",
        }),
      ]);
      const ran = (label: string, endedAt?: string) =>
        Effect.gen(function* () {
          const review = cycle(label, []);
          const request = review.request(label);
          yield* Log.append([...review.structure, request]);
          if (endedAt)
            yield* Log.append([
              review.completed(request.id, "completed", endedAt),
            ]);
          return { cycleId: review.cycleId, requestId: request.id };
        });
      // Requested first, still running at the cutoff, ended after it.
      const early = yield* ran("early", "2026-10-20T12:00:05.000Z");
      // Ended half a second before the cutoff; as text it sorts after it.
      const justBefore = yield* ran("just-before", "2026-10-20T12:00:00Z");
      yield* ran("before", "2026-10-20T11:00:00.000Z");
      const late = yield* ran("late", "2026-10-20T13:00:00.000Z");
      // No receipt: its job's end decides.
      const finished = yield* ran("finished");
      yield* setJob(
        finished.requestId,
        "completed",
        "2026-10-20T14:00:00.000Z",
      );
      return { early, justBefore, late, finished };
    }),
  );
  const page = (options: { limit: number; offset?: number }) =>
    runOn(
      location,
      ReviewList.reviews({ ...options, endedAfter: cutoff }).pipe(
        Effect.provide(Blobs.layer(location)),
      ),
    );
  const first = await page({ limit: 2 });
  expect(first.reviews.map((review) => review.cycleId)).toEqual([
    ids.finished.cycleId,
    ids.late.cycleId,
  ]);
  const second = await page({ limit: 2, offset: 2 });
  expect(second.reviews.map((review) => review.cycleId)).toEqual([
    ids.early.cycleId,
  ]);
  const past = await page({ limit: 2, offset: 4 });
  expect(past.reviews).toEqual([]);
  expect([first.total, second.total, past.total]).toEqual([3, 3, 3]);
  // Without it, every review counts.
  const every = await runOn(
    location,
    ReviewList.reviews({ limit: 10 }).pipe(
      Effect.provide(Blobs.layer(location)),
    ),
  );
  expect(every.total).toBe(5);
});

test("decided reads every person's standing decision, never an agent's; feedbackGiven anyone's", async () => {
  const location = freshLocation();
  const fixture = await runOn(location, scenario(location));
  const { a, b } = fixture;
  const [u1, u2] = a.batches[0]!.units.map((unit) => unit.unitId);
  const u3 = a.batches[1]!.units[0]!.unitId;
  const bUnit = b.batches[0]!.units[0]!.unitId;
  await runOn(
    location,
    Effect.gen(function* () {
      // u1: another person approved; then the viewer approved and replaced that with a request
      // for changes, the newest person's decision.
      yield* HumanCommands.recordDisposition({
        person: other,
        unitId: u1!,
        verdict: "approve",
      });
      yield* HumanCommands.recordDisposition({
        person: owner,
        unitId: u1!,
        verdict: "approve",
      });
      yield* HumanCommands.recordDisposition({
        person: owner,
        unitId: u1!,
        verdict: "request-changes",
        comments: [{ body: "Name the retry limit." }],
      });
      // u2: approved, then retracted.
      const approved = yield* HumanCommands.recordDisposition({
        person: owner,
        unitId: u2!,
        verdict: "approve",
      });
      yield* HumanCommands.retractDisposition({
        person: owner,
        dispositionId: approved.dispositionId,
      });
      // ...and then only an agent decided it.
      yield* Log.append([
        envelope(
          "disposition.recorded@1",
          `disposition:agent:${u2}`,
          agent,
          { cycleId: a.cycleId, unitIds: [u2!] },
          {
            verdict: "request-changes",
            reviewedHeadOid: sha256Hex("a:head").slice(0, 40),
          },
        ),
      ]);
      // u3: another person decided; B's unit: the viewer decided, but it is asked about with the
      // wrong cycle.
      yield* HumanCommands.recordDisposition({
        person: other,
        unitId: u3,
        verdict: "approve",
      });
      // An agent's later disposition on u3 leaves the person's decision standing.
      yield* Log.append([
        envelope(
          "disposition.recorded@1",
          `disposition:agent:${u3}`,
          agent,
          { cycleId: a.cycleId, unitIds: [u3] },
          {
            verdict: "request-changes",
            reviewedHeadOid: sha256Hex("a:head").slice(0, 40),
          },
        ),
      ]);
      yield* HumanCommands.recordDisposition({
        person: owner,
        unitId: bUnit,
        verdict: "approve",
      });
      // Feedback: the viewer's on A, another person's on B.
      yield* HumanCommands.recordFeedback({
        person: owner,
        answer: {
          on: "unit",
          target: a.unitEvents.get(u1!)!,
          harnessCallVisible: true,
          note: "Lane looks right.",
        },
      });
      yield* HumanCommands.recordFeedback({
        person: other,
        answer: {
          on: "unit",
          target: b.unitEvents.get(bUnit)!,
          harnessCallVisible: true,
          note: "Lane looks right.",
        },
      });
    }),
  );
  const read = await runOn(
    location,
    Effect.gen(function* () {
      return {
        decided: yield* ReviewList.decided([
          { unitId: u1!, cycleId: a.cycleId },
          { unitId: u2!, cycleId: a.cycleId },
          { unitId: u3, cycleId: a.cycleId },
          // A pairing with the wrong cycle answers nothing.
          { unitId: bUnit, cycleId: a.cycleId },
        ]),
        feedback: yield* ReviewList.feedbackGiven([
          a.cycleId,
          b.cycleId,
          fixture.c.cycleId,
        ]),
      };
    }),
  );
  expect(read.decided).toEqual([
    { unitId: u1!, cycleId: a.cycleId, verdict: "request-changes" },
    { unitId: u3, cycleId: a.cycleId, verdict: "approve" },
  ]);
  // C had none.
  expect([...read.feedback].sort()).toEqual([a.cycleId, b.cycleId].sort());
});

// Why (22 November 2026, NEU-460): "Clear" on the Reviews page is a person's event, never a deletion,
// and the repository's latest clear or its undo decides the default list. The event must pass the
// log's strict parse as appended, and the read must follow the latest one: a clear's time, then
// nothing once undone, then a later clear's time.
test("the default list's latest clear decides, and an undo restores it", async () => {
  const location = freshLocation();
  const steps = await runOn(
    location,
    Effect.gen(function* () {
      const never = yield* ReviewList.cleared;
      const first = yield* HumanCommands.clearReviewList({ person: owner });
      const afterFirst = yield* ReviewList.cleared;
      const appended = yield* Log.get(first.eventId);
      yield* HumanCommands.clearReviewList({ person: owner, restore: true });
      const afterUndo = yield* ReviewList.cleared;
      const second = yield* HumanCommands.clearReviewList({ person: other });
      const afterSecond = yield* ReviewList.cleared;
      return {
        never,
        first,
        afterFirst,
        appended,
        afterUndo,
        second,
        afterSecond,
      };
    }),
  );
  expect(steps.never).toBeUndefined();
  expect(steps.afterFirst).toBe(steps.first.occurredAt);
  const event = Option.getOrThrow(steps.appended).event;
  expect(event.kind).toBe("review-list.cleared@1");
  expect(event.actor).toBe(ownerId);
  expect(steps.afterUndo).toBeUndefined();
  expect(steps.afterSecond).toBe(steps.second.occurredAt);
});
