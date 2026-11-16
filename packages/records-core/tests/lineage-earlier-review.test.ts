// Why: which earlier review a review compares with, and which earlier units people decided, are
// what carried decisions and the desk's earlier-decision notes rest on. At the records-core
// boundary: the review origin first, the ancestor fallback second, nothing else; a person's
// current decisions only, never an agent's, a retracted or a superseded one; old-shape units and
// unreadable blobs listed so a caller can tell they cannot be matched by key.
import { afterAll, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  Blobs,
  Lineage,
  Log,
  canonicalJson,
  mintUlid,
  sha256Hex,
} from "../src/index.ts";
import { contentLayer, storeContent } from "./new-shape-support.ts";
import { newShapeReview, reviewEvents } from "./review-fixtures.ts";
import {
  agent,
  freshLocation,
  headOid,
  human,
  removeTemporaryDirectories,
  runOn,
} from "./support.ts";

afterAll(removeTemporaryDirectories);

const range = { baseRef: "refs/heads/main", baseOid: "b".repeat(40), headOid };
const at = "2026-11-12T10:00:00.000Z";

const opened = (cycleId: string, head: string, baseRef = range.baseRef) => ({
  id: mintUlid(),
  kind: "cycle.opened@1",
  idempotencyKey: `cycle:${cycleId}`,
  actor: agent,
  occurredAt: at,
  attribution: { cycleId, range: { ...range, baseRef, headOid: head } },
  payload: {},
});
const origin = (cycleId: string, head: string, chat: number) => ({
  id: mintUlid(),
  kind: "review.origin-recorded@1",
  idempotencyKey: `origin:${cycleId}`,
  actor: agent,
  occurredAt: at,
  attribution: { cycleId, range: { ...range, headOid: head } },
  payload: {
    identity: sha256Hex(`origin:${cycleId}`),
    origin: { kind: "channel", host: "h", channel: "review", chat, items: [] },
  },
});
const decision = (
  actor: string,
  cycleId: string,
  unitId: string,
  supersedes?: string,
) => ({
  id: mintUlid(),
  kind: "disposition.recorded@2",
  idempotencyKey: `decide:${mintUlid()}`,
  actor,
  occurredAt: at,
  attribution: { cycleId, unitIds: [unitId] },
  ...(supersedes === undefined ? {} : { causation: { supersedes } }),
  payload: {
    verdict: "approve",
    reviewedHeadOid: headOid,
    restsOn: [],
    proof: [],
  },
});

/**
 * One store: an old-shape review (its own cycle, a manifest Records holds), then a new-shape one
 * (newer cycle) whose small unit's sections blob is not held, both opened on one base ref.
 */
const setup = async () => {
  const location = freshLocation();
  const old = reviewEvents();
  const events = [...old.structure, ...Object.values(old.comments)];
  const onUnit = (unitId: string) =>
    events
      .filter((e) =>
        (
          e.attribution as { unitIds?: ReadonlyArray<string> } | undefined
        )?.unitIds?.includes(unitId),
      )
      .map((e) => ({ kind: e.kind, id: e.id }));
  const fixture = newShapeReview();
  const packets = await runOn(
    location,
    Effect.gen(function* () {
      const blobs = yield* Blobs.BlobStore;
      const manifest = yield* blobs.put({
        bytes: new TextEncoder().encode(
          canonicalJson({
            batches: [
              {
                batch: "b1",
                batchId: old.batchId,
                units: old.units.map((unitId, n) => ({
                  unit: `b1.u${n + 1}`,
                  unitId,
                  events: onUnit(unitId),
                })),
                events: [],
              },
            ],
          }),
        ),
        mediaType: "application/json",
        retention: "durable",
      });
      const oldPacket = {
        ...old.packet,
        refs: [{ ref: `blob:${manifest.blob.hash}`, role: "manifest" }],
      };
      yield* storeContent(fixture, ["sections:Small file"]);
      yield* Log.append([
        ...old.registrations,
        ...old.structure,
        ...Object.values(old.comments),
        oldPacket,
        ...fixture.all.filter((e) => e.kind !== "actor.registered@1"),
      ]);
      return { old: oldPacket.id, fresh: fixture.events.second.id };
    }).pipe(Effect.provide(contentLayer(location))),
  );
  return { location, old, fixture, packets };
};

const yes = () => Effect.succeed(true);
const no = () => Effect.succeed(false);

test("the earlier review is the newest cycle sharing the review origin, else an ancestor on the same base", async () => {
  const { location, fixture, old, packets } = await setup();
  const result = await runOn(
    location,
    Effect.gen(function* () {
      // The new-shape cycle shares a chat with a later cycle; the old-shape one does not.
      yield* Log.append([origin(fixture.cycleId, headOid, 7)]);
      const byOrigin = mintUlid();
      yield* Log.append([
        opened(byOrigin, "c".repeat(40)),
        origin(byOrigin, "c".repeat(40), 7),
      ]);
      const byAncestry = mintUlid();
      yield* Log.append([opened(byAncestry, "d".repeat(40))]);
      const elsewhere = mintUlid();
      yield* Log.append([
        opened(elsewhere, "e".repeat(40), "refs/heads/other"),
      ]);
      const asked: Array<[string, string]> = [];
      const recording = (ancestor: string, descendant: string) =>
        Effect.sync(() => {
          asked.push([ancestor, descendant]);
          return true;
        });
      return {
        byOrigin: yield* Lineage.earlierReview({
          cycleId: byOrigin,
          isAncestor: no,
        }),
        byAncestry: yield* Lineage.earlierReview({
          cycleId: byAncestry,
          isAncestor: recording,
        }),
        asked,
        notAncestor: yield* Lineage.earlierReview({
          cycleId: byAncestry,
          isAncestor: no,
        }),
        elsewhere: yield* Lineage.earlierReview({
          cycleId: elsewhere,
          isAncestor: yes,
        }),
        sameCycle: yield* Lineage.earlierReview({
          cycleId: fixture.cycleId,
          isAncestor: yes,
        }),
      };
    }).pipe(Effect.provide(contentLayer(location))),
  );
  expect(result.byOrigin).toEqual([
    { packetId: packets.fresh, cycleId: fixture.cycleId, sameCycle: false },
  ]);
  expect(result.byAncestry).toEqual([
    { packetId: packets.fresh, cycleId: fixture.cycleId, sameCycle: false },
  ]);
  expect(result.asked).toEqual([[headOid, "d".repeat(40)]]);
  expect(result.notAncestor).toEqual([]);
  expect(result.elsewhere).toEqual([]);
  // In its own cycle: the packet of record it would supersede, then the old-shape cycle before it.
  expect(result.sameCycle).toEqual([
    { packetId: packets.fresh, cycleId: fixture.cycleId, sameCycle: true },
    { packetId: packets.old, cycleId: old.cycleId, sameCycle: false },
  ]);
});

test("units people decided are listed with what matches them; agents', retracted and superseded decisions are not", async () => {
  const { location, fixture, old, packets } = await setup();
  const result = await runOn(
    location,
    Effect.gen(function* () {
      const [u1, u2, u3] = old.units;
      const first = decision(human, old.cycleId, u1);
      const replaced = decision(human, old.cycleId, u1, first.id);
      const kept = decision(human, old.cycleId, u2);
      const retractedOne = decision(human, old.cycleId, u3);
      const retractionId = mintUlid();
      const large = decision(human, fixture.cycleId, fixture.units.large);
      // The person's newer decision supersedes `large`; their later retraction of the old one
      // withdraws nothing, so it is not an act.
      const largeNewer = {
        ...decision(human, fixture.cycleId, fixture.units.large, large.id),
        payload: {
          verdict: "request-changes",
          reviewedHeadOid: headOid,
          restsOn: [],
          proof: [],
        },
      };
      const stale = {
        id: mintUlid(),
        kind: "disposition.retracted@1",
        idempotencyKey: `retract:${large.id}`,
        actor: human,
        occurredAt: at,
        attribution: {
          cycleId: fixture.cycleId,
          unitIds: [fixture.units.large],
        },
        causation: { supersedes: large.id },
        payload: {},
      };
      const small = decision(human, fixture.cycleId, fixture.units.small);
      yield* Log.append([
        first,
        replaced,
        kept,
        retractedOne,
        {
          id: retractionId,
          kind: "disposition.retracted@1",
          idempotencyKey: `retract:${retractedOne.id}`,
          actor: human,
          occurredAt: at,
          attribution: { cycleId: old.cycleId, unitIds: [u3] },
          causation: { supersedes: retractedOne.id },
          payload: {},
        },
        large,
        largeNewer,
        stale,
        small,
      ]);
      const listed = yield* Lineage.personDecidedUnitsOf([
        { packetId: packets.fresh, cycleId: fixture.cycleId, sameCycle: false },
        { packetId: packets.old, cycleId: old.cycleId, sameCycle: false },
      ]);
      return {
        listed,
        replaced,
        kept,
        large,
        largeNewer,
        small,
        u1,
        u2,
        u3,
        retractedOne,
        retractionId,
      };
    }).pipe(Effect.provide(contentLayer(location))),
  );
  const byUnit = Object.fromEntries(
    result.listed.map((unit) => [unit.unitId, unit]),
  );
  // The old shape's u1 (a person's decision superseded by their own newer one), u2, u3 (whose
  // only person's decision was retracted: listed with the retraction and no decision), and both
  // new-shape units.
  expect(Object.keys(byUnit).sort()).toEqual(
    [
      result.u1,
      result.u2,
      result.u3,
      fixture.units.large,
      fixture.units.small,
    ].sort(),
  );
  expect(byUnit[result.u3]).toMatchObject({
    decisions: [],
    decidedBy: [],
    retractions: [
      {
        retractionId: result.retractionId,
        actorId: human,
        retracted: result.retractedOne.id,
      },
    ],
  });
  // Each decision and counted retraction with its place in the store's append order.
  expect(byUnit[result.u1]!.decisions).toEqual([
    {
      dispositionId: result.replaced.id,
      actorId: human,
      verdict: "approve",
      seq: expect.any(Number),
      recorded: { id: result.replaced.id, seq: expect.any(Number) },
    },
  ]);
  expect(byUnit[result.u3]!.retractions[0]!.seq).toBeGreaterThan(
    byUnit[result.u2]!.decisions[0]!.seq,
  );
  expect(byUnit[result.u2]).toEqual({
    unitId: result.u2,
    cycleId: old.cycleId,
    path: "src/b.ts",
    key: null,
    sectionKeys: [],
    lane: "human-suggested",
    judgements: null,
    sections: null,
    decisions: [
      {
        dispositionId: result.kept.id,
        actorId: human,
        verdict: "approve",
        seq: expect.any(Number),
        recorded: { id: result.kept.id, seq: expect.any(Number) },
      },
    ],
    retractions: [],
    decidedBy: [human],
  });
  // The stale retraction is not listed; the person's newer decision is current there. They are
  // not named on it (the store-wide rule, round 13): their decision on `small` is newer, and
  // `small`'s sections blob is not in this store, so the store cannot show that decision is about
  // other code. It counts as their last act about `large`'s changes, and `large` does not hold it.
  expect(byUnit[fixture.units.large]).toMatchObject({
    decisions: [
      {
        dispositionId: result.largeNewer.id,
        actorId: human,
        verdict: "request-changes",
      },
    ],
    retractions: [],
    decidedBy: [],
  });
  expect(byUnit[fixture.units.large]).toMatchObject({
    cycleId: fixture.cycleId,
    path: "src/large.ts",
    key: (fixture.events.units.large.payload as { key: string }).key,
    sectionKeys: [fixture.sectionKeys.k1, fixture.sectionKeys.k2],
    lane: "human-suggested",
    judgements: fixture.events.assessments.large.refs[0]!.ref,
    sections: fixture.events.units.large.refs[0]!.ref,
  });
  // A blob this store does not hold: listed, with no section keys to match by.
  expect(byUnit[fixture.units.small]).toMatchObject({
    sectionKeys: [],
    sections: fixture.events.units.small.refs[0]!.ref,
    lane: "human-required",
  });
});

const retraction = (
  actor: string,
  cycleId: string,
  unitId: string,
  target: string,
) => ({
  id: mintUlid(),
  kind: "disposition.retracted@1",
  idempotencyKey: `retract:${target}`,
  actor,
  occurredAt: at,
  attribution: { cycleId, unitIds: [unitId] },
  causation: { supersedes: target },
  payload: {},
});

// Why: a retraction counts as the person's last act only when it withdrew the decision that stood
// for them, the one `Dispositions.current` names; a retraction of an older decision that did not
// stand must leave the newer one deciding the unit, or the next review asks the person again.
test("a retraction of a person's decision that did not stand is no act; one of the decision that stood is", async () => {
  const { location, old, packets } = await setup();
  const result = await runOn(
    location,
    Effect.gen(function* () {
      const [u1, u2, u3] = old.units;
      // On u1: two decisions, neither replacing the other, then a retraction of the older.
      const a1 = decision(human, old.cycleId, u1);
      const a2 = decision(human, old.cycleId, u1);
      const aRetract = retraction(human, old.cycleId, u1, a1.id);
      // On u2: two decisions that both replace the first, then a retraction of the older of them.
      const b0 = decision(human, old.cycleId, u2);
      const b1 = decision(human, old.cycleId, u2, b0.id);
      const b2 = decision(human, old.cycleId, u2, b0.id);
      const bRetract = retraction(human, old.cycleId, u2, b1.id);
      // On u3: two decisions, then a retraction of the newer, the one that stood.
      const c1 = decision(human, old.cycleId, u3);
      const c2 = decision(human, old.cycleId, u3);
      const cRetract = retraction(human, old.cycleId, u3, c2.id);
      yield* Log.append([
        a1,
        a2,
        aRetract,
        b0,
        b1,
        b2,
        bRetract,
        c1,
        c2,
        cRetract,
      ]);
      const listed = yield* Lineage.personDecidedUnitsOf([
        { packetId: packets.old, cycleId: old.cycleId, sameCycle: false },
      ]);
      return { listed, u1, u2, u3, a2, b2, c1, cRetract, c2 };
    }).pipe(Effect.provide(contentLayer(location))),
  );
  const byUnit = Object.fromEntries(
    result.listed.map((unit) => [unit.unitId, unit]),
  );
  expect(byUnit[result.u1]).toMatchObject({
    decisions: [
      { dispositionId: result.a2.id, actorId: human, verdict: "approve" },
    ],
    retractions: [],
    decidedBy: [human],
  });
  expect(byUnit[result.u2]).toMatchObject({
    decisions: [
      { dispositionId: result.b2.id, actorId: human, verdict: "approve" },
    ],
    retractions: [],
    decidedBy: [human],
  });
  // The retraction withdrew the decision that stood: it is the person's last act, so they have
  // not decided the unit, though their older decision is still current.
  expect(byUnit[result.u3]).toMatchObject({
    decisions: [
      { dispositionId: result.c1.id, actorId: human, verdict: "approve" },
    ],
    retractions: [
      {
        retractionId: result.cRetract.id,
        actorId: human,
        retracted: result.c2.id,
      },
    ],
    decidedBy: [],
  });
});

/** Three IDs minted in one millisecond, in ID order, each after every ID minted before them. */
const sameMillisecond = () => {
  for (;;) {
    const ids = [mintUlid(), mintUlid(), mintUlid()] as const;
    if (ids.every((id) => id.slice(0, 10) === ids[0].slice(0, 10))) return ids;
  }
};

// Why: a retraction is appended only after its target, but its ID can sort before it (minted in
// the same millisecond on another process, or on a clock behind the publisher's). Which decision
// stood when the person retracted, and whether their last act is a decision, must follow the
// order the store appended them, or a withdrawn decision decides the unit again.
test("a retraction whose ID sorts before the decision it withdrew still withdraws it", async () => {
  const { location, old, packets } = await setup();
  const result = await runOn(
    location,
    Effect.gen(function* () {
      const [u1, u2] = old.units;
      // On u1: two live approvals, then a retraction of the newer whose ID sorts between them.
      const [a1, aRetract, a2] = sameMillisecond();
      // On u2: the same, the retraction's ID sorting before both approvals.
      const [bRetract, b1, b2] = sameMillisecond();
      yield* Log.append([
        { ...decision(human, old.cycleId, u1), id: a1 },
        { ...decision(human, old.cycleId, u1), id: a2 },
        { ...retraction(human, old.cycleId, u1, a2), id: aRetract },
        { ...decision(human, old.cycleId, u2), id: b1 },
        { ...decision(human, old.cycleId, u2), id: b2 },
        { ...retraction(human, old.cycleId, u2, b2), id: bRetract },
      ]);
      const listed = yield* Lineage.personDecidedUnitsOf([
        { packetId: packets.old, cycleId: old.cycleId, sameCycle: false },
      ]);
      return { listed, u1, u2, a1, a2, aRetract, b1, b2, bRetract };
    }).pipe(Effect.provide(contentLayer(location))),
  );
  const byUnit = Object.fromEntries(
    result.listed.map((unit) => [unit.unitId, unit]),
  );
  // The retraction withdrew the decision that stood: the person's last act on each unit.
  expect(byUnit[result.u1]).toMatchObject({
    decisions: [{ dispositionId: result.a1, actorId: human }],
    retractions: [
      { retractionId: result.aRetract, actorId: human, retracted: result.a2 },
    ],
    decidedBy: [],
  });
  expect(byUnit[result.u2]).toMatchObject({
    decisions: [{ dispositionId: result.b1, actorId: human }],
    retractions: [
      { retractionId: result.bRetract, actorId: human, retracted: result.b2 },
    ],
    decidedBy: [],
  });
});

// Why: a person's last act on the same unchanged change decides. Withdrawn through its copy on a
// later review's unit that lineage names unchanged from it, the decision no longer decides the
// unit it was recorded on, so a reader of that unit asks the person again rather than treating it
// as decided.
test("a decision withdrawn through its carried copy no longer decides the unit it was recorded on", async () => {
  const { location, old, fixture, packets } = await setup();
  const result = await runOn(
    location,
    Effect.gen(function* () {
      const [u1] = old.units;
      const approved = decision(human, old.cycleId, u1);
      const copy = {
        id: mintUlid(),
        kind: "disposition.carried@1",
        idempotencyKey: `carried:${approved.id}`,
        actor: human,
        occurredAt: at,
        attribution: {
          cycleId: fixture.cycleId,
          unitIds: [fixture.units.large],
        },
        payload: {
          verdict: "approve",
          reviewedHeadOid: headOid,
          restsOn: [],
          proof: [],
          lineage: "carried",
          from: {
            review: "earlier",
            cycle: old.cycleId,
            head: headOid,
            judgement: approved.id,
            output: mintUlid(),
            savedMs: 0,
          },
        },
      };
      // The lineage the publisher writes with every copy: the later unit is unchanged from u1.
      const linked = {
        id: mintUlid(),
        kind: "lineage.recorded@1",
        idempotencyKey: `lineage:${fixture.units.large}:${u1}`,
        actor: agent,
        occurredAt: at,
        attribution: {
          cycleId: fixture.cycleId,
          unitIds: [fixture.units.large, u1],
        },
        payload: {
          from: [
            {
              unitId: u1,
              cycleId: old.cycleId,
              relation: "unchanged",
              unchanged: 1,
              changed: 0,
              lane: null,
            },
          ],
        },
      };
      const withdrawal = retraction(
        human,
        fixture.cycleId,
        fixture.units.large,
        copy.id,
      );
      yield* Log.append([approved, linked, copy, withdrawal]);
      const listed = yield* Lineage.personDecidedUnitsOf([
        { packetId: packets.old, cycleId: old.cycleId, sameCycle: false },
      ]);
      return { listed, u1, approved, withdrawal };
    }).pipe(Effect.provide(contentLayer(location))),
  );
  const onU1 = result.listed.find((unit) => unit.unitId === result.u1);
  expect(onU1).toMatchObject({
    decisions: [
      {
        dispositionId: result.approved.id,
        recorded: { id: result.approved.id },
      },
    ],
    decidedBy: [],
  });
});

test("an agent's decision alone lists no unit", async () => {
  const { location, old, packets } = await setup();
  const listed = await runOn(
    location,
    Effect.gen(function* () {
      yield* Log.append([decision(agent, old.cycleId, old.units[1])]);
      return yield* Lineage.personDecidedUnitsOf([
        { packetId: packets.old, cycleId: old.cycleId, sameCycle: false },
      ]);
    }).pipe(Effect.provide(contentLayer(location))),
  );
  expect(listed).toEqual([]);
});
