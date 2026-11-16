// Why: `Lineage.lastActs` is the one answer the publisher carries from and a reader treats a unit
// as decided by. At the records-core boundary: a person's last act, in the store's append order,
// on any unit holding one of the new unit's changes decides (with no keys, on the units lineage
// connects), a copy is followed back to the decision it copies with no bound and fails safe when
// it cannot be, and past either bound nothing is known.
import { afterAll, expect, test } from "bun:test";
import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import {
  Blobs,
  Lineage,
  Log,
  canonicalJson,
  mintUlid,
  sha256Hex,
} from "../src/index.ts";
import { contentLayer, storeContent } from "./new-shape-support.ts";
import { newShapeReview } from "./review-fixtures.ts";
import {
  agent,
  cycleEvents,
  freshLocation,
  headOid,
  human,
  removeTemporaryDirectories,
  runOn,
  workflowEvents,
} from "./support.ts";

afterAll(removeTemporaryDirectories);

const at = "2026-11-12T10:00:00.000Z";

/** Runs `program` on a fresh store with its blob and computation stores. */
const withContent = <A, E>(
  program: Effect.Effect<A, E, Blobs.BlobStore | SqlClient>,
) => {
  const location = freshLocation();
  return runOn(location, program.pipe(Effect.provide(contentLayer(location))));
};

/** `lastActs` asked of each set of units with no section keys: every connected unit counts. */
const ask = (...sets: Array<Array<string>>) =>
  Lineage.lastActs(sets.map((units) => ({ units, sectionKeys: null })));

/** `count` recorded units of one cycle, and the person registered. */
const units = (count: number) => {
  const cycle = cycleEvents(count);
  const cycleId = (cycle.events[0]!.attribution as { cycleId: string }).cycleId;
  return {
    cycleId,
    unitIds: cycle.unitIds,
    events: [workflowEvents().registrations.human, ...cycle.events],
  };
};

/** `successor` is unchanged from each of `earlier`. */
const link = (cycleId: string, successor: string, earlier: Array<string>) => ({
  id: mintUlid(),
  kind: "lineage.recorded@1",
  idempotencyKey: `lineage:${successor}`,
  actor: agent,
  occurredAt: at,
  attribution: { cycleId, unitIds: [successor, ...earlier] },
  payload: {
    from: earlier.map((unitId) => ({
      unitId,
      cycleId,
      relation: "unchanged",
      unchanged: 1,
      changed: 0,
      lane: null,
    })),
  },
});

const decide = (
  cycleId: string,
  unitId: string,
  verdict: "approve" | "request-changes" = "approve",
  supersedes?: string,
  actor = human,
) => ({
  id: mintUlid(),
  kind: "disposition.recorded@2",
  idempotencyKey: `decide:${mintUlid()}`,
  actor,
  occurredAt: at,
  attribution: { cycleId, unitIds: [unitId] },
  ...(supersedes === undefined ? {} : { causation: { supersedes } }),
  payload: { verdict, reviewedHeadOid: headOid, restsOn: [], proof: [] },
});

const copy = (
  cycleId: string,
  unitId: string,
  judgement: string,
  id = mintUlid(),
) => ({
  id,
  kind: "disposition.carried@1",
  idempotencyKey: `carried:${id}`,
  actor: human,
  occurredAt: at,
  attribution: { cycleId, unitIds: [unitId] },
  payload: {
    verdict: "approve",
    reviewedHeadOid: headOid,
    restsOn: [],
    proof: [],
    lineage: "carried",
    from: {
      review: "earlier",
      cycle: cycleId,
      head: headOid,
      judgement,
      output: mintUlid(),
      savedMs: 0,
    },
  },
});

const retract = (cycleId: string, unitId: string, target: string) => ({
  id: mintUlid(),
  kind: "disposition.retracted@1",
  idempotencyKey: `retract:${target}`,
  actor: human,
  occurredAt: at,
  attribution: { cycleId, unitIds: [unitId] },
  causation: { supersedes: target },
  payload: {},
});

// B5 at the boundary: twenty copies in a row are one decision, followed to its end; a withdrawal
// of the last copy is the last act on every unit of the chain.
test("a decision copied twenty times is followed back to the one recorded, and its withdrawal reaches every unit", async () => {
  const { cycleId, unitIds, events } = units(21);
  const result = await withContent(
    Effect.gen(function* () {
      const recorded = decide(cycleId, unitIds[0]!);
      const chain: Array<Record<string, unknown>> = [recorded];
      let from = recorded.id;
      const copies: Array<string> = [];
      for (let n = 1; n <= 20; n++) {
        const carried = copy(cycleId, unitIds[n]!, from);
        chain.push(link(cycleId, unitIds[n]!, [unitIds[n - 1]!]), carried);
        copies.push(carried.id);
        from = carried.id;
      }
      yield* Log.append([...events, ...chain]);
      const before = yield* ask([unitIds[20]!], [unitIds[0]!]);
      yield* Log.append([retract(cycleId, unitIds[20]!, copies.at(-1)!)]);
      const after = yield* ask([unitIds[20]!], [unitIds[1]!]);
      return { recorded: recorded.id, last: copies.at(-1)!, before, after };
    }),
  );
  expect(result.before).toEqual([
    {
      kind: "known",
      people: [
        {
          kind: "carry",
          actorId: human,
          decision: { id: result.recorded, seq: expect.any(Number) },
          unitId: expect.any(String),
          eventId: result.last,
        },
      ],
    },
    {
      kind: "known",
      people: [
        {
          kind: "carry",
          actorId: human,
          decision: { id: result.recorded, seq: expect.any(Number) },
          unitId: expect.any(String),
          eventId: result.recorded,
        },
      ],
    },
  ]);
  expect(result.after).toEqual([
    { kind: "known", people: [] },
    { kind: "known", people: [] },
  ]);
});

// B7 at the boundary: every decision the person recorded on the change is an act, whichever unit
// or branch it is on; the newest decides, and where no given unit holds it, it is withheld.
test("the newest decision on any branch of the change is the last act", async () => {
  const { cycleId, unitIds, events } = units(3);
  const [u0, u1, u2] = unitIds as [string, string, string];
  const result = await withContent(
    Effect.gen(function* () {
      const recorded = decide(cycleId, u0);
      const onU1 = copy(cycleId, u1, recorded.id);
      const onU2 = copy(cycleId, u2, recorded.id);
      const asked = decide(cycleId, u1, "request-changes", onU1.id);
      const approved = decide(cycleId, u2, "approve", onU2.id);
      const askedAgain = decide(cycleId, u1, "request-changes", asked.id);
      yield* Log.append([
        ...events,
        recorded,
        link(cycleId, u1, [u0]),
        onU1,
        link(cycleId, u2, [u0]),
        onU2,
        asked,
        approved,
        askedAgain,
      ]);
      return {
        askedAgain: askedAgain.id,
        answers: yield* ask([u2, u0], [u1]),
      };
    }),
  );
  expect(result.answers).toEqual([
    {
      kind: "known",
      people: [
        {
          kind: "withheld",
          actorId: human,
          decision: { id: result.askedAgain, seq: expect.any(Number) },
        },
      ],
    },
    {
      kind: "known",
      people: [
        {
          kind: "carry",
          actorId: human,
          decision: { id: result.askedAgain, seq: expect.any(Number) },
          unitId: u1,
          eventId: result.askedAgain,
        },
      ],
    },
  ]);
});

// A copy is the decision it copies only when it can be followed back to it: one whose original
// cannot be read, or that names an event appended after it (as no publisher writes, and as a loop
// would), is not, and the person's decision is withheld rather than carried.
test("a copy that cannot be followed back to the decision is not that decision", async () => {
  const { cycleId, unitIds, events } = units(4);
  const [u0, u1, u2, u3] = unitIds as [string, string, string, string];
  const result = await withContent(
    Effect.gen(function* () {
      // u1: a copy of a decision the store does not hold.
      const lost = copy(cycleId, u1, mintUlid());
      // u2: a copy naming the person's decision appended after it.
      const ahead = copy(cycleId, u2, "");
      const later = decide(cycleId, u0);
      const aheadOfLater = {
        ...ahead,
        payload: {
          ...ahead.payload,
          from: { ...ahead.payload.from, judgement: later.id },
        },
      };
      // u3: two copies naming each other.
      const loopB = mintUlid();
      const loopA = copy(cycleId, u3, loopB);
      const loopAgain = copy(cycleId, u3, loopA.id, loopB);
      yield* Log.append([
        ...events,
        link(cycleId, u1, [u0]),
        link(cycleId, u2, [u0]),
        link(cycleId, u3, [u0]),
        lost,
        aheadOfLater,
        loopA,
        loopAgain,
        later,
      ]);
      return {
        later: later.id,
        answers: yield* ask([u1], [u2], [u3]),
      };
    }),
  );
  const withheld: Lineage.UnitAnswer = {
    kind: "known",
    people: [
      {
        kind: "withheld",
        actorId: human,
        decision: { id: result.later, seq: expect.any(Number) },
      },
    ],
  };
  expect(result.answers).toEqual([withheld, withheld, withheld]);
});

// The connected-units bound, for units asked with no keys: past it, nothing is known for any unit
// of that change, in the same call as a change under it, which is answered as usual.
test("a change past the connected-units bound is not known; another under it is answered", async () => {
  const { cycleId, unitIds, events } = units(6);
  const result = await withContent(
    Effect.gen(function* () {
      const recorded = decide(cycleId, unitIds[0]!);
      const chain: Array<Record<string, unknown>> = [recorded];
      for (let n = 1; n <= 4; n++)
        chain.push(link(cycleId, unitIds[n]!, [unitIds[n - 1]!]));
      const apart = decide(cycleId, unitIds[5]!);
      yield* Log.append([...events, ...chain, apart]);
      const asked = ask([unitIds[4]!], [unitIds[0]!], [unitIds[5]!]);
      return {
        bounded: yield* Effect.provideService(
          asked,
          Lineage.ConnectedUnitsMax,
          3,
        ),
        unbounded: yield* asked,
      };
    }),
  );
  expect(result.bounded.map((a) => a.kind)).toEqual([
    "not-known",
    "not-known",
    "known",
  ]);
  expect(result.bounded[2]).toMatchObject({
    people: [{ kind: "carry", actorId: human }],
  });
  expect(result.unbounded.map((a) => a.kind)).toEqual([
    "known",
    "known",
    "known",
  ]);
  expect(Lineage.CONNECTED_UNITS_MAX).toBe(4_096);
});

// The acts-read bound, for units asked with keys: past it, nothing is known for a unit whose
// person has more acts newer than any about it, in the same call as a unit whose person's newest
// act is about it, which is answered as usual. At the bound exactly, the oldest act is still read.
test("a unit past the acts-read bound is not known; another under it is answered", async () => {
  const keys = [1, 2, 3, 4].map((n) => sha256Hex(`section:bound-${n}`));
  const { cycleId, unitIds, store, events } = sectionUnits(
    keys.map((key) => [key]),
  );
  const result = await withContent(
    Effect.gen(function* () {
      yield* store;
      yield* Log.append([
        ...events,
        ...unitIds.map((unitId) => decide(cycleId, unitId)),
      ]);
      const asked = Lineage.lastActs([
        { units: [unitIds[0]!], sectionKeys: [keys[0]!] },
        { units: [unitIds[3]!], sectionKeys: [keys[3]!] },
      ]);
      return {
        bounded: yield* Effect.provideService(asked, Lineage.ActsReadMax, 3),
        atBound: yield* Effect.provideService(asked, Lineage.ActsReadMax, 4),
        unbounded: yield* asked,
      };
    }),
  );
  expect(result.bounded.map((a) => a.kind)).toEqual(["not-known", "known"]);
  expect(result.bounded[1]).toMatchObject({
    people: [{ kind: "carry", actorId: human }],
  });
  for (const answers of [result.atBound, result.unbounded])
    expect(answers).toMatchObject([
      { kind: "known", people: [{ kind: "carry", actorId: human }] },
      { kind: "known", people: [{ kind: "carry", actorId: human }] },
    ]);
  expect(Lineage.ACTS_READ_MAX).toBe(4_096);
});

// Acts are the person's own: an agent's decision and a carried copy are not, and a retraction
// that withdrew nothing (its target already superseded) is not; their newer decision decides.
test("an agent's decision, a copy and a retraction that withdrew nothing are not acts", async () => {
  const { cycleId, unitIds, events } = units(2);
  const [u0, u1] = unitIds as [string, string];
  const result = await withContent(
    Effect.gen(function* () {
      const first = decide(cycleId, u0);
      const newer = decide(cycleId, u0, "request-changes", first.id);
      yield* Log.append([
        ...events,
        decide(cycleId, u1, "approve", undefined, agent),
        first,
        newer,
        retract(cycleId, u0, first.id),
        link(cycleId, u1, [u0]),
      ]);
      return {
        newer: newer.id,
        answers: yield* ask([u1], [u0]),
      };
    }),
  );
  expect(result.answers).toEqual([
    {
      kind: "known",
      people: [
        {
          kind: "withheld",
          actorId: human,
          decision: { id: result.newer, seq: expect.any(Number) },
        },
      ],
    },
    {
      kind: "known",
      people: [
        {
          kind: "carry",
          actorId: human,
          decision: { id: result.newer, seq: expect.any(Number) },
          unitId: u0,
          eventId: result.newer,
        },
      ],
    },
  ]);
});

// ---------------------------------------------------------------------------------------------
// Round 2: the same change is a section key. A person's acts about a new unit are those on the
// connected units that hold at least one of its section keys.
// ---------------------------------------------------------------------------------------------

/** A version 3 unit holding `keys`, its sections blob stored, in a fresh cycle and batch. */
const sectionUnits = (shapes: ReadonlyArray<ReadonlyArray<string>>) => {
  const cycleId = mintUlid();
  const batchId = mintUlid();
  const texts: Array<string> = [];
  const units = shapes.map((keys) => {
    const unitId = mintUlid();
    const text = canonicalJson({
      sections: keys.map((key, n) => ({
        key,
        parts: {
          path: "src/x.ts",
          kind: "function",
          name: `f${key.slice(0, 6)}`,
        },
        where: { startLine: n * 10 + 1, endLine: n * 10 + 5 },
        renamedFrom: null,
        title: "A change",
        ownedRanges: [
          {
            kind: "lines",
            path: "src/x.ts",
            side: "new",
            startLine: n * 10 + 2,
            endLine: n * 10 + 2,
          },
        ],
      })),
    });
    texts.push(text);
    return {
      unitId,
      event: {
        id: mintUlid(),
        kind: "unit.recorded@3",
        idempotencyKey: `unit:${unitId}`,
        actor: agent,
        occurredAt: at,
        attribution: { cycleId, batchId, unitIds: [unitId] },
        payload: {
          title: "A unit",
          titleBy: "code",
          path: "src/x.ts",
          key: sha256Hex(keys.join(",")),
          sections: { count: keys.length },
          ranges: { count: keys.length, lines: keys.length },
        },
        refs: [{ ref: `blob:${sha256Hex(text)}`, role: "sections" }],
      },
    };
  });
  const store = Effect.gen(function* () {
    const blobs = yield* Blobs.BlobStore;
    for (const text of texts)
      yield* blobs.put({
        bytes: new TextEncoder().encode(text),
        mediaType: "application/json",
        retention: "durable",
      });
  });
  const events = [
    workflowEvents().registrations.human,
    {
      id: mintUlid(),
      kind: "cycle.opened@1",
      idempotencyKey: `cycle:${cycleId}`,
      actor: agent,
      occurredAt: at,
      attribution: {
        cycleId,
        range: { baseRef: "refs/heads/main", baseOid: "b".repeat(40), headOid },
      },
      payload: {},
    },
    {
      id: mintUlid(),
      kind: "batch.recorded@1",
      idempotencyKey: `batch:${batchId}`,
      actor: agent,
      occurredAt: at,
      attribution: { cycleId, batchId },
      payload: { title: "Batch", focus: "Focus" },
    },
    ...units.map((u) => u.event),
  ];
  return {
    cycleId,
    unitIds: units.map((u) => u.unitId),
    store,
    events,
  };
};

const K1 = sha256Hex("section:k1");
const K2 = sha256Hex("section:k2");

// The split shape (B8): a wide unit of two changes, then each change alone, unchanged from it.
// A request for changes on the first part, then an approval of the second: each new unit's acts
// are those on units holding its change, so each part carries its own decision. Asked with no
// keys, every connected unit counts and the first part's request is passed over.
test("split: each part's own decision is its last act about it", async () => {
  const { cycleId, unitIds, store, events } = sectionUnits([
    [K1, K2],
    [K1],
    [K2],
  ]);
  const [wide, one, two] = unitIds as [string, string, string];
  const result = await withContent(
    Effect.gen(function* () {
      yield* store;
      const asked = decide(cycleId, one, "request-changes");
      const approved = decide(cycleId, two);
      yield* Log.append([
        ...events,
        link(cycleId, one, [wide]),
        link(cycleId, two, [wide]),
        asked,
        approved,
      ]);
      return {
        asked: asked.id,
        approved: approved.id,
        keyed: yield* Lineage.lastActs([
          { units: [one], sectionKeys: [K1] },
          { units: [two], sectionKeys: [K2] },
        ]),
        unkeyed: yield* ask([one]),
      };
    }),
  );
  expect(result.keyed).toEqual([
    {
      kind: "known",
      people: [
        {
          kind: "carry",
          actorId: human,
          decision: { id: result.asked, seq: expect.any(Number) },
          unitId: unitIds[1]!,
          eventId: result.asked,
        },
      ],
    },
    {
      kind: "known",
      people: [
        {
          kind: "carry",
          actorId: human,
          decision: { id: result.approved, seq: expect.any(Number) },
          unitId: unitIds[2]!,
          eventId: result.approved,
        },
      ],
    },
  ]);
  expect(result.unkeyed).toEqual([
    {
      kind: "known",
      people: [
        {
          kind: "withheld",
          actorId: human,
          decision: { id: result.approved, seq: expect.any(Number) },
        },
      ],
    },
  ]);
});

// The merged shape: a part and the wide unit share a change. An approval of the wide unit after a
// request on the part is the last act about the wide unit and about the part; a request on the
// part after the approval is the last act about both, held only by the part.
test("merged: an act on a unit sharing one change counts for both", async () => {
  const run = (requestFirst: boolean) => {
    const { cycleId, unitIds, store, events } = sectionUnits([[K1, K2], [K1]]);
    const [wide, partUnit] = unitIds as [string, string];
    return withContent(
      Effect.gen(function* () {
        yield* store;
        const approved = decide(cycleId, wide);
        const asked = decide(cycleId, partUnit, "request-changes");
        yield* Log.append([
          ...events,
          link(cycleId, partUnit, [wide]),
          ...(requestFirst ? [asked, approved] : [approved, asked]),
        ]);
        const answers = yield* Lineage.lastActs([
          { units: [wide], sectionKeys: [K1, K2] },
          { units: [partUnit], sectionKeys: [K1] },
        ]);
        return {
          approved: approved.id,
          asked: asked.id,
          answers: answers.map((a) =>
            a.kind === "known"
              ? a.people.map((p) => [p.kind, p.decision.id])
              : a.kind,
          ),
        };
      }),
    );
  };
  const approvalLast = await run(true);
  expect(approvalLast.answers).toEqual([
    [["carry", approvalLast.approved]],
    [["withheld", approvalLast.approved]],
  ]);
  const requestLast = await run(false);
  expect(requestLast.answers).toEqual([
    [["withheld", requestLast.asked]],
    [["carry", requestLast.asked]],
  ]);
});

// `decidedBy` is `lastActs` asked of the unit alone with its own section keys: an act on a
// connected unit that holds none of them does not unname the person.
test("decidedBy equals lastActs asked of the unit alone with its own keys", async () => {
  const location = freshLocation();
  const fixture = newShapeReview();
  const result = await runOn(
    location,
    Effect.gen(function* () {
      yield* storeContent(fixture);
      yield* Log.append([...fixture.all]);
      const { large, small } = fixture.units;
      const approved = decide(fixture.cycleId, large);
      const asked = decide(fixture.cycleId, small, "request-changes");
      yield* Log.append([
        link(fixture.cycleId, small, [large]),
        approved,
        asked,
      ]);
      const listed = yield* Lineage.personDecidedUnitsOf([
        {
          packetId: fixture.events.second.id,
          cycleId: fixture.cycleId,
          sameCycle: false,
        },
      ]);
      const alone = yield* Lineage.lastActs(
        listed.map((unit) => ({
          units: [unit.unitId],
          sectionKeys: unit.sectionKeys,
        })),
      );
      return {
        listed: listed.map((unit) => [unit.unitId, unit.decidedBy]),
        alone: alone.map((a) =>
          a.kind === "known"
            ? a.people.filter((p) => p.kind === "carry").map((p) => p.actorId)
            : [],
        ),
        large,
        small,
      };
    }).pipe(Effect.provide(contentLayer(location))),
  );
  expect(result.listed.map(([, by]) => by)).toEqual(result.alone);
  expect(Object.fromEntries(result.listed)).toEqual({
    [result.large]: [human],
    [result.small]: [human],
  });
});

// Round 3: units that overlap without one holding the other are connected through the lineage
// entry that counts their shared change (`changed`, `unchanged: 1`), and a unit given as
// `sharing` is a start of the walk but never a unit a decision is carried from.
test("overlapping units are connected, and nothing is carried from a sharing unit", async () => {
  const K3 = sha256Hex("section:k3");
  const { cycleId, unitIds, store, events } = sectionUnits([
    [K1, K2],
    [K2, K3],
  ]);
  const [pair, overlap] = unitIds as [string, string];
  const result = await withContent(
    Effect.gen(function* () {
      yield* store;
      const approved = decide(cycleId, pair);
      const asked = decide(cycleId, overlap, "request-changes");
      yield* Log.append([
        ...events,
        approved,
        {
          ...link(cycleId, overlap, [pair]),
          payload: {
            from: [
              {
                unitId: pair,
                cycleId,
                relation: "changed",
                unchanged: 1,
                changed: 0,
                lane: null,
              },
            ],
          },
        },
        asked,
      ]);
      const answers = yield* Lineage.lastActs([
        { units: [pair], sectionKeys: [K1, K2] },
        { units: [], sharing: [overlap], sectionKeys: [K2, K3] },
        { units: [pair], sectionKeys: [K1] },
      ]);
      return {
        approved: approved.id,
        asked: asked.id,
        answers: answers.map((a) =>
          a.kind === "known"
            ? a.people.map((p) => [p.kind, p.decision.id])
            : a.kind,
        ),
      };
    }),
  );
  expect(result.answers).toEqual([
    [["withheld", result.asked]],
    [["withheld", result.asked]],
    [["carry", result.approved]],
  ]);
});

// Round 13: an older-shape unit (owned ranges, no section keys) counts for a new unit whose keys
// are known only when one of its ranges is in a file the new unit holds. A person's later
// decision on one in another file does not withhold their approval; in the same file, or with the
// new unit's files not given, it is their last act about the change and withholds it.
test("an act on an older-shape unit counts only in a file the new unit holds", async () => {
  const run = (path: string, given: ReadonlyArray<string> | undefined) => {
    const { cycleId, unitIds, store, events } = sectionUnits([[K1]]);
    const [keyed] = unitIds as [string];
    const batchId = mintUlid();
    const older = mintUlid();
    return withContent(
      Effect.gen(function* () {
        yield* store;
        const approved = decide(cycleId, keyed);
        const asked = decide(cycleId, older, "request-changes");
        yield* Log.append([
          ...events,
          approved,
          {
            id: mintUlid(),
            kind: "batch.recorded@1",
            idempotencyKey: `batch:${batchId}`,
            actor: agent,
            occurredAt: at,
            attribution: { cycleId, batchId },
            payload: { title: "Older", focus: "Older shape" },
          },
          {
            id: mintUlid(),
            kind: "unit.recorded@1",
            idempotencyKey: `unit:${older}`,
            actor: agent,
            occurredAt: at,
            attribution: { cycleId, batchId, unitIds: [older] },
            payload: {
              title: "Older shape",
              ownedRanges: [{ path, startLine: 40, endLine: 42 }],
            },
          },
          asked,
        ]);
        const [answer] = yield* Lineage.lastActs([
          { units: [keyed], sectionKeys: [K1], paths: given },
        ]);
        return {
          approved: approved.id,
          asked: asked.id,
          people:
            answer!.kind === "known"
              ? answer!.people.map((p) => [p.kind, p.decision.id])
              : answer!.kind,
        };
      }),
    );
  };
  const elsewhere = await run("src/other.ts", ["src/x.ts"]);
  expect(elsewhere.people).toEqual([["carry", elsewhere.approved]]);
  const same = await run("src/x.ts", ["src/x.ts"]);
  expect(same.people).toEqual([["withheld", same.asked]]);
  const notGiven = await run("src/other.ts", undefined);
  expect(notGiven.people).toEqual([["withheld", notGiven.asked]]);
});
