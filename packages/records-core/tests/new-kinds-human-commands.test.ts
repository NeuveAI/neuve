// Why: a `unit.recorded@3` keeps its owned lines in its sections blob, not in its payload, so until
// now a person's line comment on a new-shape unit, alone or in a request for changes, read the unit
// as owning no lines and was refused. Both now read the lines from the blob when the caller gives a
// blob store; with none, or a blob that cannot be read, a line comment is refused with why and
// nothing is appended. Commands that name no lines (a comment on the whole unit, an approval, a
// request resting on whole-unit comments) need no blob store, and an old-shape unit's line comment
// is decided exactly as before.
import { afterAll, expect, test } from "bun:test";
import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { HumanCommands, Log, mintUlid } from "../src/index.ts";
import { contentLayer, storeContent } from "./new-shape-support.ts";
import { newShapeReview } from "./review-fixtures.ts";
import {
  agent,
  envelope,
  freshLocation,
  removeTemporaryDirectories,
  runOn,
  workflowEvents,
} from "./support.ts";

afterAll(removeTemporaryDirectories);

const owner = { email: "owner@example.com", displayName: "Owner" };

/** A line the large unit owns (new side, line 1) and one it does not (line 3 is owned on old). */
const inside = {
  path: "src/large.ts",
  side: "new" as const,
  startLine: 1,
  endLine: 1,
};
const outside = { ...inside, startLine: 3, endLine: 3 };

const eventCount = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const [row] = yield* sql<{ n: number }>`SELECT count(*) AS n FROM events`;
  return row!.n;
});

/** A scratch store holding the new-shape review, with its content stored except `skip`. */
const newShape = async (skip: ReadonlyArray<string> = []) => {
  const fixture = newShapeReview();
  const location = freshLocation();
  await runOn(
    location,
    Effect.gen(function* () {
      yield* storeContent(fixture, skip);
      yield* Log.append(fixture.all);
    }).pipe(Effect.provide(contentLayer(location))),
  );
  return { fixture, location };
};

const comment = (unitId: string, anchor?: typeof inside) =>
  HumanCommands.recordComment({
    person: owner,
    unitId,
    comment: {
      body: "Check this line.",
      ...(anchor === undefined ? {} : { anchor }),
    },
  });

test("with the blob store, a comment inside the new unit's owned lines is recorded and one outside them is refused", async () => {
  const { fixture, location } = await newShape();
  const read = await runOn(
    location,
    Effect.gen(function* () {
      const recorded = yield* comment(fixture.units.large, inside);
      const refused = yield* Effect.flip(comment(fixture.units.large, outside));
      const stored = yield* Log.get(recorded.commentId);
      return { recorded, refused, stored };
    }).pipe(Effect.provide(contentLayer(location))),
  );
  expect(read.stored._tag === "Some" && read.stored.value.event).toMatchObject({
    kind: "comment.recorded@2",
    attribution: { unitIds: [fixture.units.large] },
    payload: { anchor: inside },
  });
  expect(read.refused).toMatchObject({
    _tag: "HumanCommandRefused",
    reason: "anchor-outside-owned-lines",
  });
});

test("a comment on the whole new unit is recorded with and without a blob store", async () => {
  const { fixture, location } = await newShape();
  const withStore = await runOn(
    location,
    comment(fixture.units.large).pipe(Effect.provide(contentLayer(location))),
  );
  const without = await runOn(location, comment(fixture.units.large));
  for (const id of [withStore.commentId, without.commentId]) {
    const stored = await runOn(location, Log.get(id));
    expect(stored._tag === "Some" && stored.value.event.payload).toEqual({
      body: "Check this line.",
    });
  }
});

test("with no blob store, a line comment on the new unit is refused because its lines could not be read, and nothing is appended", async () => {
  const { fixture, location } = await newShape();
  const read = await runOn(
    location,
    Effect.gen(function* () {
      const before = yield* eventCount;
      const refused = yield* Effect.flip(comment(fixture.units.large, inside));
      return { before, refused, after: yield* eventCount };
    }),
  );
  expect(read.refused).toMatchObject({
    _tag: "HumanCommandRefused",
    reason: "anchor-outside-owned-lines",
    message: expect.stringContaining(
      "could not be read (no blob store was given)",
    ),
  });
  expect(read.after).toBe(read.before);
});

test("with the new unit's blob missing, a line comment is refused the same way, and nothing is appended", async () => {
  const { fixture, location } = await newShape(["sections:Large file"]);
  const read = await runOn(
    location,
    Effect.gen(function* () {
      const before = yield* eventCount;
      const refused = yield* Effect.flip(comment(fixture.units.large, inside));
      return { before, refused, after: yield* eventCount };
    }).pipe(Effect.provide(contentLayer(location))),
  );
  expect(read.refused).toMatchObject({
    _tag: "HumanCommandRefused",
    reason: "anchor-outside-owned-lines",
    message: expect.stringContaining(
      "could not be read (the sections blob is not in this store)",
    ),
  });
  expect(read.after).toBe(read.before);
});

test("a disposition on the new unit is recorded without a blob store", async () => {
  const { fixture, location } = await newShape();
  const recorded = await runOn(
    location,
    HumanCommands.recordDisposition({
      person: owner,
      unitId: fixture.units.small,
      verdict: "approve",
    }),
  );
  const stored = await runOn(location, Log.get(recorded.dispositionId));
  expect(stored._tag === "Some" && stored.value.event).toMatchObject({
    kind: "disposition.recorded@2",
    attribution: { unitIds: [fixture.units.small] },
    payload: { verdict: "approve" },
  });
});

// Why: a person asking for changes on particular lines of a new unit was refused, because the
// request checked its new comments' anchors against the payload, which holds no lines.
const requestChanges = (unitId: string, anchor?: typeof inside) =>
  HumanCommands.recordDisposition({
    person: owner,
    unitId,
    verdict: "request-changes",
    comments: [
      {
        body: "Change this.",
        ...(anchor === undefined ? {} : { anchor }),
      },
    ],
  });

test("a request for changes with a comment inside the new unit's owned lines is recorded and rests on it", async () => {
  const { fixture, location } = await newShape();
  const read = await runOn(
    location,
    Effect.gen(function* () {
      const request = yield* requestChanges(fixture.units.large, inside);
      return {
        request,
        disposition: yield* Log.get(request.dispositionId),
        comment: yield* Log.get(request.commentIds[0]!),
      };
    }).pipe(Effect.provide(contentLayer(location))),
  );
  expect(read.request.commentIds).toHaveLength(1);
  expect(
    read.disposition._tag === "Some" && read.disposition.value.event,
  ).toMatchObject({
    kind: "disposition.recorded@2",
    attribution: { unitIds: [fixture.units.large] },
    payload: { verdict: "request-changes", restsOn: read.request.commentIds },
  });
  expect(
    read.comment._tag === "Some" && read.comment.value.event.payload,
  ).toMatchObject({ anchor: inside });
});

test("a request for changes with a comment outside the new unit's owned lines is refused, and nothing is appended", async () => {
  const { fixture, location } = await newShape();
  const read = await runOn(
    location,
    Effect.gen(function* () {
      const before = yield* eventCount;
      const refused = yield* Effect.flip(
        requestChanges(fixture.units.large, outside),
      );
      return { before, refused, after: yield* eventCount };
    }).pipe(Effect.provide(contentLayer(location))),
  );
  expect(read.refused).toMatchObject({
    _tag: "HumanCommandRefused",
    reason: "anchor-outside-owned-lines",
    message: expect.not.stringContaining("could not be read"),
  });
  expect(read.after).toBe(read.before);
});

test("with no blob store, a request for changes with a line comment is refused because the lines could not be read, and nothing is appended", async () => {
  const { fixture, location } = await newShape();
  const read = await runOn(
    location,
    Effect.gen(function* () {
      const before = yield* eventCount;
      const refused = yield* Effect.flip(
        requestChanges(fixture.units.large, inside),
      );
      return { before, refused, after: yield* eventCount };
    }),
  );
  expect(read.refused).toMatchObject({
    _tag: "HumanCommandRefused",
    reason: "anchor-outside-owned-lines",
    message: expect.stringContaining(
      "could not be read (no blob store was given)",
    ),
  });
  expect(read.after).toBe(read.before);
});

test("a request for changes with a comment on the whole new unit is recorded without a blob store", async () => {
  const { fixture, location } = await newShape();
  const request = await runOn(location, requestChanges(fixture.units.large));
  const stored = await runOn(location, Log.get(request.dispositionId));
  expect(stored._tag === "Some" && stored.value.event.payload).toMatchObject({
    verdict: "request-changes",
    restsOn: request.commentIds,
  });
  expect(request.commentIds).toHaveLength(1);
});

test("an old-shape unit's line comment is decided as before, with no blob store", async () => {
  const w = workflowEvents();
  const unitId = mintUlid();
  const unit = envelope(
    "unit.recorded@2",
    `unit:${unitId}`,
    agent,
    { cycleId: w.cycleId, batchId: w.batchId, unitIds: [unitId] },
    {
      title: "Old shape",
      ownedRanges: [
        {
          kind: "lines",
          path: "src/a.ts",
          side: "new",
          startLine: 10,
          endLine: 20,
        },
      ],
      grouping: { gapLines: 20 },
    },
  );
  const location = freshLocation();
  await runOn(
    location,
    Log.append([
      w.registrations.agent,
      w.structure.cycle,
      w.structure.batch,
      unit,
    ]),
  );
  const anchor = {
    path: "src/a.ts",
    side: "new" as const,
    startLine: 12,
    endLine: 14,
  };
  const accepted = await runOn(
    location,
    HumanCommands.recordComment({
      person: owner,
      unitId,
      comment: { body: "Inside.", anchor },
    }),
  );
  const refused = await runOn(
    location,
    Effect.flip(
      HumanCommands.recordComment({
        person: owner,
        unitId,
        comment: {
          body: "Outside.",
          anchor: { ...anchor, startLine: 21, endLine: 21 },
        },
      }),
    ),
  );
  const stored = await runOn(location, Log.get(accepted.commentId));
  expect(stored._tag === "Some" && stored.value.event.payload).toMatchObject({
    anchor,
  });
  expect(refused).toMatchObject({
    _tag: "HumanCommandRefused",
    reason: "anchor-outside-owned-lines",
    message: expect.not.stringContaining("could not be read"),
  });
});
