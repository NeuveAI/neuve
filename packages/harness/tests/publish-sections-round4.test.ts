// Why: the defects the independent review found in round 3. A person's acts are ordered by their
// full event IDs, never a millisecond; a retraction counts only when it withdrew the person's
// standing decision; a held refusal is about files, named only while one of them is missing; and
// the refusal named is the one handed in last.
import { expect, test } from "bun:test";
import { Effect } from "effect";
import {
  Dispositions,
  HumanCommands,
  Identity,
  Log,
  PublishedPackets,
  canonicalJson,
  mintUlid,
  sha256Hex,
} from "@neuve/records-core";
import type { RecordEvent } from "@neuve/records-schema";
import {
  publishSettled,
  publishSettledForTest,
  type SettledBatch,
} from "../src/publish-sections.ts";
import {
  atTime,
  comment,
  eventsOf,
  inputOf,
  scratch,
  threeBatches,
} from "./publish-sections-fixtures.ts";

type Packet = Extract<RecordEvent, { kind: "packet.published@2" }>;
type Gap = Extract<RecordEvent, { kind: "gap.disclosed@1" }>;

const ana = { email: "ana-r4@example.com" };
const anaId = Identity.humanFingerprint(ana.email);

/** Two cycles of one review (one chat) and helpers to publish configurations and find units. */
const review = () => {
  const s = scratch();
  const range = (head: string) => ({
    baseRef: "main",
    baseOid: "1".repeat(40),
    headOid: head,
  });
  const open = (cycleId: string, head: string) =>
    Log.append([
      {
        id: mintUlid(),
        kind: "cycle.opened@1",
        idempotencyKey: `test:cycle:${cycleId}`,
        actor: sha256Hex("opener"),
        occurredAt: new Date().toISOString(),
        attribution: { cycleId, range: range(head) },
        payload: {},
      },
      {
        id: mintUlid(),
        kind: "review.origin-recorded@1",
        idempotencyKey: `test:origin:${cycleId}`,
        actor: sha256Hex("opener"),
        occurredAt: new Date().toISOString(),
        attribution: { cycleId, range: range(head) },
        payload: {
          identity: sha256Hex(`origin:${cycleId}`),
          origin: {
            kind: "channel",
            host: "h",
            channel: "c",
            chat: 5,
            items: [],
          },
        },
      },
    ]);
  const { a } = threeBatches();
  const ONE = { batches: 1, sections: 2 };
  const cycle1 = mintUlid();
  const cycle2 = mintUlid();
  const unitOf = (cycleId: string) =>
    Effect.gen(function* () {
      const read = yield* PublishedPackets.readStanding(cycleId);
      if (read?.kind !== "packet.published@2") throw new Error("no packet");
      return read.batches[0]!.units.find(
        (u) => u.assessment?.payload.lane === "human-required",
      )!;
    });
  const first = Effect.gen(function* () {
    yield* open(cycle1, "2".repeat(40));
    yield* publishSettled(
      s.ctx({ cycleId: cycle1, range: range("2".repeat(40)) }),
      inputOf([a], { ending: true, totals: ONE }),
    );
    yield* open(cycle2, "3".repeat(40));
    return yield* unitOf(cycle1);
  });
  const configuration = (runKey: string) =>
    Effect.gen(function* () {
      yield* publishSettled(
        s.ctx({ cycleId: cycle2, range: range("3".repeat(40)), runKey }),
        inputOf([a], { ending: true, totals: ONE }),
      );
      return yield* unitOf(cycle2);
    });
  /** A third cycle of the same review, opened and published once. */
  const cycle3 = mintUlid();
  const nextCycle = Effect.gen(function* () {
    yield* open(cycle3, "4".repeat(40));
    yield* publishSettled(
      s.ctx({ cycleId: cycle3, range: range("4".repeat(40)) }),
      inputOf([a], { ending: true, totals: ONE }),
    );
    return yield* unitOf(cycle3);
  });
  /** The gaps the cycle's standing packet names, by kind. */
  const gapKinds = (cycleId: "cycle2" | "cycle3") =>
    Effect.gen(function* () {
      const read = yield* PublishedPackets.readStanding(
        cycleId === "cycle2" ? cycle2 : cycle3,
      );
      if (read?.kind !== "packet.published@2") throw new Error("no packet");
      return read.batches.flatMap((b) => b.gaps).map((g) => g.payload.kind);
    });
  return { s, first, configuration, nextCycle, gapKinds };
};

// R3-3: a decision made in the same millisecond as the retraction before it is the later act.
test("a decision in the same millisecond as the person's retraction before it carries", async () => {
  const r = review();
  const result = await r.s.run(
    Effect.gen(function* () {
      const earlier = yield* r.first;
      yield* HumanCommands.recordDisposition({
        person: ana,
        unitId: earlier.unitId,
        verdict: "approve",
      });
      const onA = yield* r.configuration("a".repeat(64));
      const carried = onA.carriedDecisions[0]!;
      // One millisecond, two acts: the retraction, then the approval, in that order by full ID.
      // Minted, not built by hand, so both sort after every ID minted earlier in the process.
      let retraction = mintUlid();
      let approval = mintUlid();
      while (approval.slice(0, 10) !== retraction.slice(0, 10)) {
        retraction = approval;
        approval = mintUlid();
      }
      yield* Log.append([
        {
          id: retraction,
          kind: "disposition.retracted@1",
          idempotencyKey: `test:retract:${carried.id}`,
          actor: anaId,
          occurredAt: new Date().toISOString(),
          attribution: {
            cycleId: carried.attribution.cycleId,
            unitIds: [onA.unitId],
          },
          causation: { supersedes: carried.id },
          payload: {},
        },
        {
          id: approval,
          kind: "disposition.recorded@2",
          idempotencyKey: `test:approve:${onA.unitId}`,
          actor: anaId,
          occurredAt: new Date().toISOString(),
          attribution: {
            cycleId: carried.attribution.cycleId,
            unitIds: [onA.unitId],
          },
          payload: {
            verdict: "approve",
            reviewedHeadOid: "3".repeat(40),
            restsOn: [],
            proof: [],
          },
        },
      ]);
      const onB = yield* r.configuration("b".repeat(64));
      return { approval, onB, judged: yield* Dispositions.judge(onB.unitId) };
    }),
  );
  expect(
    result.onB.carriedDecisions.map((d) => [
      d.actor,
      d.payload.verdict,
      d.payload.from.judgement,
    ]),
  ).toEqual([[anaId, "approve", result.approval]]);
  expect(result.judged.closed).toBe(true);
}, 20_000);

// R3-2, the reviewer's probe: a retraction of a decision the person had already superseded
// withdrew nothing; their request for changes still carries.
test("a retraction of an already superseded approval leaves the request for changes carrying", async () => {
  const r = review();
  const result = await r.s.run(
    Effect.gen(function* () {
      const earlier = yield* r.first;
      const approved = yield* HumanCommands.recordDisposition({
        person: ana,
        unitId: earlier.unitId,
        verdict: "approve",
      });
      yield* HumanCommands.recordDisposition({
        person: ana,
        unitId: earlier.unitId,
        verdict: "request-changes",
        comments: [{ body: "The export needs a guard." }],
      });
      yield* HumanCommands.retractDisposition({
        person: ana,
        dispositionId: approved.dispositionId,
      });
      const decided = (yield* Dispositions.judge(earlier.unitId)).standing
        ?.verdict;
      const onA = yield* r.configuration("a".repeat(64));
      const onB = yield* r.configuration("b".repeat(64));
      return { decided, onA, onB };
    }),
  );
  expect(result.decided).toBe("request-changes");
  for (const unit of [result.onA, result.onB])
    expect(
      unit.carriedDecisions.map((d) => [d.actor, d.payload.verdict]),
    ).toEqual([[anaId, "request-changes"]]);
}, 20_000);

// R3-2: a retraction of the person's standing decision is their last act: nothing carries.
test("a retraction of the standing request for changes carries nothing", async () => {
  const r = review();
  const result = await r.s.run(
    Effect.gen(function* () {
      const earlier = yield* r.first;
      yield* HumanCommands.recordDisposition({
        person: ana,
        unitId: earlier.unitId,
        verdict: "approve",
      });
      const asked = yield* HumanCommands.recordDisposition({
        person: ana,
        unitId: earlier.unitId,
        verdict: "request-changes",
        comments: [{ body: "The export needs a guard." }],
      });
      yield* HumanCommands.retractDisposition({
        person: ana,
        dispositionId: asked.dispositionId,
      });
      const onA = yield* r.configuration("a".repeat(64));
      return { onA, judged: yield* Dispositions.judge(onA.unitId) };
    }),
  );
  expect(result.onA.carriedDecisions).toEqual([]);
  expect(result.judged.closed).toBe(false);
}, 20_000);

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * The time, in milliseconds, the process's ID generator stands at: that of an ID minted now. Times
 * ahead are built from it, never from the wall clock: `bun test` runs many files in one process and
 * `mintUlid` is one monotonic generator for all of them, so a test elsewhere that minted an ID
 * under a clock moved ahead leaves every later ID ahead of the wall clock, and a time "ahead of the
 * wall clock" can sort behind the IDs this file's commands mint.
 */
const generatorNow = () => {
  let time = 0;
  for (const char of mintUlid().slice(0, 10))
    time = time * 32 + CROCKFORD.indexOf(char);
  return time;
};

/** `minutes` ahead of the ID generator's clock, as a publisher's plan clock can be. */
const ahead = (minutes: number) => atTime(generatorNow() + minutes * 60_000);

// Why: the publisher mints a carried decision on its own clock, which can run ahead of the clock a
// person's command runs on, so their retraction of it can sort before it by ID. The retraction
// still withdrew it: nothing of theirs carries to the next configuration and the human-required
// unit is open; a fresh decision they record after the retraction stands and carries.
test("a retraction of a carried approval minted on a clock ahead withdraws it, and a fresh approval after it carries", async () => {
  const run = (approveAgain: boolean) => {
    const r = review();
    return r.s.run(
      Effect.gen(function* () {
        const earlier = yield* r.first;
        yield* HumanCommands.recordDisposition({
          person: ana,
          unitId: earlier.unitId,
          verdict: "approve",
        });
        const onA = yield* ahead(2)(r.configuration("a".repeat(64)));
        const carried = onA.carriedDecisions[0]!;
        const { retractionId } = yield* HumanCommands.retractDisposition({
          person: ana,
          dispositionId: carried.id,
        });
        const fresh = approveAgain
          ? yield* HumanCommands.recordDisposition({
              person: ana,
              unitId: onA.unitId,
              verdict: "approve",
            })
          : undefined;
        const onB = yield* ahead(4)(r.configuration("b".repeat(64)));
        return {
          carriedA: onA.carriedDecisions.length,
          carriedId: carried.id,
          retractionId,
          fresh: fresh?.dispositionId,
          onB,
          judged: yield* Dispositions.judge(onB.unitId),
        };
      }),
    );
  };
  const withdrawn = await run(false);
  // The scenario: one approval carried onto A, and the retraction sorts before it by ID.
  expect(withdrawn.carriedA).toBe(1);
  expect(withdrawn.retractionId < withdrawn.carriedId).toBeTrue();
  expect(withdrawn.onB.carriedDecisions).toEqual([]);
  expect(withdrawn.judged).toMatchObject({
    lane: "human-required",
    closed: false,
  });

  const reapproved = await run(true);
  expect(reapproved.retractionId < reapproved.carriedId).toBeTrue();
  expect(
    reapproved.onB.carriedDecisions.map((d) => [
      d.actor,
      d.payload.verdict,
      d.payload.from.judgement,
    ]),
  ).toEqual([[anaId, "approve", reapproved.fresh!]]);
  expect(reapproved.judged.closed).toBe(true);
}, 30_000);

/**
 * An event ID minted `minutes` ahead of the ID generator's clock, as a command run on a clock ahead
 * mints one. Built by hand: the process's own generator is monotonic, so one ID minted ahead with
 * it would carry every later ID of the process ahead too.
 */
const idAhead = (minutes: number) => {
  let time = generatorNow() + minutes * 60_000;
  let prefix = "";
  for (let n = 0; n < 10; n++) {
    prefix = CROCKFORD[time % 32]! + prefix;
    time = Math.floor(time / 32);
  }
  return `${prefix}${mintUlid().slice(10)}`;
};

/** Ana's registration as her first command appends it. */
const anaRegistered = () => {
  const payload = { actorKind: "human", harness: "git", email: ana.email };
  return {
    id: mintUlid(),
    kind: "actor.registered@1",
    idempotencyKey: `actor:${anaId}:${sha256Hex(canonicalJson(payload)).slice(0, 16)}`,
    actor: anaId,
    occurredAt: new Date().toISOString(),
    payload,
  };
};

/** Ana's approval of `unitId`, its ID minted on a clock two minutes ahead. */
const approvalAhead = (cycleId: string, unitId: string, head: string) => ({
  id: idAhead(2),
  kind: "disposition.recorded@2",
  idempotencyKey: `test:ahead:${unitId}`,
  actor: anaId,
  occurredAt: new Date().toISOString(),
  attribution: { cycleId, unitIds: [unitId] },
  payload: {
    verdict: "approve",
    reviewedHeadOid: head,
    restsOn: [],
    proof: [],
  },
});

/**
 * Cycle 1 published, Ana's approval of its human-required unit (minted ahead when `ahead`), and
 * configuration A published on the real clock with the approval carried onto it.
 */
const approvedThenA = (r: ReturnType<typeof review>, ahead: boolean) =>
  Effect.gen(function* () {
    const earlier = yield* r.first;
    const approval = ahead
      ? (yield* Log.append([
          anaRegistered(),
          approvalAhead(
            earlier.recorded!.attribution.cycleId,
            earlier.unitId,
            "2".repeat(40),
          ),
        ]))[1]!.id
      : (yield* HumanCommands.recordDisposition({
          person: ana,
          unitId: earlier.unitId,
          verdict: "approve",
        })).dispositionId;
    const onA = yield* r.configuration("a".repeat(64));
    expect(onA.carriedDecisions.map((d) => d.payload.from.judgement)).toEqual([
      approval,
    ]);
    return { approval, onA, carried: onA.carriedDecisions[0]! };
  });

// Why (the reviewer's X): a person's acts are ordered by when they entered the store. An approval
// minted on a clock ahead, carried onto A and withdrawn there by a retraction that sorts before it
// by ID, is withdrawn: nothing carries to B and the human-required unit stays open.
test("an approval minted on a clock ahead, withdrawn on the configuration it was carried to, does not carry again", async () => {
  const run = (ahead: boolean) => {
    const r = review();
    return r.s.run(
      Effect.gen(function* () {
        const { approval, onA, carried } = yield* approvedThenA(r, ahead);
        const { retractionId } = yield* HumanCommands.retractDisposition({
          person: ana,
          dispositionId: carried.id,
        });
        const openOnA = !(yield* Dispositions.judge(onA.unitId)).closed;
        const onB = yield* r.configuration("b".repeat(64));
        return {
          approval,
          carriedId: carried.id,
          retractionId,
          openOnA,
          onB,
          judged: yield* Dispositions.judge(onB.unitId),
        };
      }),
    );
  };
  // The control, the approval on the real clock: nothing carries.
  const control = await run(false);
  expect(control.onB.carriedDecisions).toEqual([]);
  expect(control.judged.closed).toBe(false);

  const result = await run(true);
  // The scenario: the retraction sorts after the carried copy and before the approval it copies.
  expect(result.carriedId < result.retractionId).toBeTrue();
  expect(result.retractionId < result.approval).toBeTrue();
  expect(result.openOnA).toBeTrue();
  expect(result.onB.carriedDecisions).toEqual([]);
  expect(result.judged).toMatchObject({
    lane: "human-required",
    closed: false,
  });
}, 30_000);

// Why (the reviewer's X3): the person's request for changes on A, replacing the approval carried
// there, is their later act whatever the approval's ID says: the request carries to B.
test("a request for changes replacing a carried approval minted on a clock ahead is what carries", async () => {
  const run = (ahead: boolean) => {
    const r = review();
    return r.s.run(
      Effect.gen(function* () {
        const { approval, onA } = yield* approvedThenA(r, ahead);
        const asked = yield* HumanCommands.recordDisposition({
          person: ana,
          unitId: onA.unitId,
          verdict: "request-changes",
          comments: [{ body: "The export needs a guard." }],
        });
        const onB = yield* r.configuration("b".repeat(64));
        return { approval, asked: asked.dispositionId, onB };
      }),
    );
  };
  const carriedOf = (onB: PublishedPackets.ReadUnit) =>
    onB.carriedDecisions.map((d) => [
      d.actor,
      d.payload.verdict,
      d.payload.from.judgement,
    ]);
  // The control, the approval on the real clock: the request carries.
  const control = await run(false);
  expect(carriedOf(control.onB)).toEqual([
    [anaId, "request-changes", control.asked],
  ]);

  const result = await run(true);
  expect(result.asked < result.approval).toBeTrue();
  expect(carriedOf(result.onB)).toEqual([
    [anaId, "request-changes", result.asked],
  ]);
}, 30_000);

// Why (the mirror): a retraction minted on a clock ahead, then a fresh approval by command on the
// real clock. The approval entered the store after the retraction, so it is the person's last act
// and carries to B.
test("a fresh approval after a retraction minted on a clock ahead carries", async () => {
  const r = review();
  const result = await r.s.run(
    Effect.gen(function* () {
      const { onA, carried } = yield* approvedThenA(r, false);
      const retractionId = idAhead(2);
      yield* Log.append([
        {
          id: retractionId,
          kind: "disposition.retracted@1",
          idempotencyKey: `test:retract-ahead:${carried.id}`,
          actor: anaId,
          occurredAt: new Date().toISOString(),
          attribution: {
            cycleId: carried.attribution.cycleId,
            unitIds: [onA.unitId],
          },
          causation: { supersedes: carried.id },
          payload: {},
        },
      ]);
      const fresh = yield* HumanCommands.recordDisposition({
        person: ana,
        unitId: onA.unitId,
        verdict: "approve",
      });
      const onB = yield* r.configuration("b".repeat(64));
      return {
        retractionId,
        fresh: fresh.dispositionId,
        onB,
        judged: yield* Dispositions.judge(onB.unitId),
      };
    }),
  );
  expect(result.fresh < result.retractionId).toBeTrue();
  expect(
    result.onB.carriedDecisions.map((d) => [
      d.actor,
      d.payload.verdict,
      d.payload.from.judgement,
    ]),
  ).toEqual([[anaId, "approve", result.fresh]]);
  expect(result.judged.closed).toBe(true);
}, 30_000);

const ben = { email: "ben-r4@example.com" };
const benId = Identity.humanFingerprint(ben.email);

/** A unit's carried decisions as `[actor, verdict]`. */
const carriedOf = (unit: PublishedPackets.ReadUnit) =>
  unit.carriedDecisions.map((d) => [d.actor, d.payload.verdict]);

/** Whether the unit is closed, as Records judges it now. */
const closed = (unit: PublishedPackets.ReadUnit) =>
  Effect.map(Dispositions.judge(unit.unitId), (judged) => judged.closed);

// Why (the reviewer's B4): a person's decision and all its carried copies are one decision. A
// withdrawal of the copy on configuration A withdraws it for every later configuration, though C
// and D compare only with B and cycle 1, which hold no act of theirs.
test("an approval withdrawn on the configuration it was carried to is not carried by any later configuration", async () => {
  const r = review();
  const result = await r.s.run(
    Effect.gen(function* () {
      const earlier = yield* r.first;
      yield* HumanCommands.recordDisposition({
        person: ana,
        unitId: earlier.unitId,
        verdict: "approve",
      });
      const onA = yield* r.configuration("a".repeat(64));
      yield* HumanCommands.retractDisposition({
        person: ana,
        dispositionId: onA.carriedDecisions[0]!.id,
      });
      const shown = [];
      for (const key of ["b", "c", "d"]) {
        const unit = yield* r.configuration(key.repeat(64));
        shown.push({ carried: carriedOf(unit), closed: yield* closed(unit) });
      }
      return { carriedA: carriedOf(onA), shown };
    }),
  );
  expect(result.carriedA).toEqual([[anaId, "approve"]]);
  expect(result.shown).toEqual([
    { carried: [], closed: false },
    { carried: [], closed: false },
    { carried: [], closed: false },
  ]);
}, 30_000);

// Why (B4b): a request for changes that replaced the approval carried to A is the person's later
// decision. It sits on A, which C does not compare with, so C must never carry the approval past
// it: it carries nothing of theirs and says a person decides again.
test("an approval replaced on A by a request for changes is not carried by a later configuration", async () => {
  const r = review();
  const result = await r.s.run(
    Effect.gen(function* () {
      const earlier = yield* r.first;
      yield* HumanCommands.recordDisposition({
        person: ana,
        unitId: earlier.unitId,
        verdict: "approve",
      });
      const onA = yield* r.configuration("a".repeat(64));
      const onB = yield* r.configuration("b".repeat(64));
      yield* HumanCommands.recordDisposition({
        person: ana,
        unitId: onA.unitId,
        verdict: "request-changes",
        comments: [{ body: "The export needs a guard." }],
      });
      const onC = yield* r.configuration("c".repeat(64));
      return {
        carriedB: carriedOf(onB),
        carriedC: carriedOf(onC),
        closedC: yield* closed(onC),
        gaps: yield* r.gapKinds("cycle2"),
      };
    }),
  );
  expect(result.carriedB).toEqual([[anaId, "approve"]]);
  expect(result.carriedC).toEqual([]);
  expect(result.closedC).toBe(false);
  expect(result.gaps).toContain("later-decision-not-carried");
}, 30_000);

// Why (B4c, the reviewer's note 8): the copy on A withdrawn after B carried the approval on.
// B's copy is the same decision, so C does not carry it.
test("an approval withdrawn on A after B carried it is not carried by C", async () => {
  const r = review();
  const result = await r.s.run(
    Effect.gen(function* () {
      const earlier = yield* r.first;
      yield* HumanCommands.recordDisposition({
        person: ana,
        unitId: earlier.unitId,
        verdict: "approve",
      });
      const onA = yield* r.configuration("a".repeat(64));
      const onB = yield* r.configuration("b".repeat(64));
      yield* HumanCommands.retractDisposition({
        person: ana,
        dispositionId: onA.carriedDecisions[0]!.id,
      });
      const onC = yield* r.configuration("c".repeat(64));
      return {
        carriedB: carriedOf(onB),
        carriedC: carriedOf(onC),
        closedC: yield* closed(onC),
      };
    }),
  );
  expect(result.carriedB).toEqual([[anaId, "approve"]]);
  expect(result.carriedC).toEqual([]);
  expect(result.closedC).toBe(false);
}, 30_000);

// Controls: what must still carry.

test("a fresh approval after a withdrawal on A, recorded before B, carries to B and C", async () => {
  const r = review();
  const result = await r.s.run(
    Effect.gen(function* () {
      const earlier = yield* r.first;
      yield* HumanCommands.recordDisposition({
        person: ana,
        unitId: earlier.unitId,
        verdict: "approve",
      });
      const onA = yield* r.configuration("a".repeat(64));
      yield* HumanCommands.retractDisposition({
        person: ana,
        dispositionId: onA.carriedDecisions[0]!.id,
      });
      const fresh = yield* HumanCommands.recordDisposition({
        person: ana,
        unitId: onA.unitId,
        verdict: "approve",
      });
      const onB = yield* r.configuration("b".repeat(64));
      const onC = yield* r.configuration("c".repeat(64));
      return {
        fresh: fresh.dispositionId,
        onB,
        onC,
        closedC: yield* closed(onC),
      };
    }),
  );
  expect(
    result.onB.carriedDecisions.map((d) => d.payload.from.judgement),
  ).toEqual([result.fresh]);
  expect(carriedOf(result.onC)).toEqual([[anaId, "approve"]]);
  expect(result.closedC).toBe(true);
}, 30_000);

const ALL = { batches: 3, sections: 5 };

const packetsOf = (cycleId: string) =>
  Effect.map(eventsOf(cycleId, "packet.published@2"), (events) =>
    (events as Array<Packet>).sort((x, y) => (x.id < y.id ? -1 : 1)),
  );

const refusalsNamed = (packetId: string) =>
  Effect.map(PublishedPackets.readExact(packetId), (read) =>
    read?.kind === "packet.published@2"
      ? read.gaps
          .filter((g) => g.payload.kind === "batch-not-published")
          .map((g) => g.payload.detail)
      : [],
  );

/** Batch `b` refused for a comment ID with a space. */
const bRefused = (): SettledBatch => {
  const { b } = threeBatches();
  return {
    ...b,
    units: [{ ...b.units[0]!, comments: [comment("has space")] }],
  };
};
/** Batch `c` refused by the lane check (X) or by a bad comment ID (Y). */
const cByLane = (): SettledBatch => {
  const { c } = threeBatches();
  return { ...c, units: [{ ...c.units[0]!, lane: "human-required" }] };
};
const cById = (): SettledBatch => {
  const { c } = threeBatches();
  return {
    ...c,
    units: [{ ...c.units[0]!, comments: [comment("has space")] }],
  };
};

// R3-1, probe p8: a refused batch published under another key stops being named once its files
// are in the packet, and a complete packet names no refusal.
test("a refused batch published with an extra file is not named by the complete packet", async () => {
  const store = scratch();
  const { a, b, c } = threeBatches();
  const wider: SettledBatch = { ...b, paths: [...b.paths, "src/b-extra.ts"] };
  const result = await store.run(
    Effect.gen(function* () {
      const ctx = store.ctx();
      yield* publishSettled(ctx, inputOf([a], { totals: ALL }));
      yield* publishSettled(ctx, inputOf([bRefused()], { totals: ALL }));
      yield* publishSettled(
        ctx,
        inputOf([wider, c], { ending: true, totals: ALL }),
      );
      const packets = yield* packetsOf(ctx.cycleId);
      return {
        last: packets.at(-1)!,
        named: yield* refusalsNamed(packets.at(-1)!.id),
      };
    }),
  );
  expect(result.last.payload.complete).toBe(true);
  expect(result.last.payload.counts.pending).toEqual({
    batches: 0,
    sections: 0,
  });
  expect(result.named).toEqual([]);
}, 20_000);

// Note: the refusal named is the one handed in last: X, then Y, then X names X.
test("refused by X, then Y, then X: the packet names X, and a repeat appends nothing", async () => {
  const store = scratch();
  const { a, b } = threeBatches();
  const result = await store.run(
    Effect.gen(function* () {
      const ctx = store.ctx();
      yield* publishSettled(ctx, inputOf([a], { totals: ALL }));
      yield* publishSettled(ctx, inputOf([cByLane()], { totals: ALL }));
      yield* publishSettled(ctx, inputOf([cById()], { totals: ALL }));
      yield* publishSettled(ctx, inputOf([cByLane()], { totals: ALL }));
      const held = () =>
        Effect.map(eventsOf(ctx.cycleId, "gap.disclosed@1"), (events) =>
          (events as Array<Gap>).filter(
            (g) => g.payload.kind === "batch-not-published",
          ),
        );
      const before = (yield* held()).length;
      yield* publishSettled(ctx, inputOf([cByLane()], { totals: ALL }));
      const after = (yield* held()).length;
      yield* publishSettled(ctx, inputOf([b], { totals: ALL }));
      const packets = yield* packetsOf(ctx.cycleId);
      return { before, after, named: yield* refusalsNamed(packets.at(-1)!.id) };
    }),
  );
  expect(result.before).toBe(3);
  expect(result.after).toBe(3);
  expect(result.named).toHaveLength(1);
  expect(result.named[0]).toContain("review lane");
}, 20_000);

// Note: a packet naming the last of a series, stopped after its plan and replayed, writes the
// same manifest, even with another refusal handed in between.
test("a packet naming the last held refusal replays to the same manifest", async () => {
  const T = Date.UTC(2026, 10, 12, 18, 0, 0);
  const cycleId = mintUlid();
  const runId = mintUlid();
  const { a, b } = threeBatches();
  const once = (stopped: boolean) => {
    const store = scratch({ cycleId });
    return store.run(
      Effect.gen(function* () {
        const ctx = store.ctx({ runId, startedAt: T - 1_000 });
        yield* atTime(T)(publishSettled(ctx, inputOf([a], { totals: ALL })));
        yield* atTime(T + 10)(
          publishSettled(ctx, inputOf([cByLane()], { totals: ALL })),
        );
        yield* atTime(T + 20)(
          publishSettled(ctx, inputOf([cById()], { totals: ALL })),
        );
        if (stopped) {
          yield* Effect.exit(
            atTime(T + 30)(
              publishSettledForTest(ctx, inputOf([b], { totals: ALL }), "plan"),
            ),
          );
          yield* atTime(T + 40)(
            publishSettled(ctx, inputOf([cByLane()], { totals: ALL })),
          );
        }
        yield* atTime(T + 30)(
          publishSettled(ctx, inputOf([b], { totals: ALL })),
        );
        const packets = yield* packetsOf(cycleId);
        return {
          packets: packets.map((p) => [p.id, p.refs[0].ref]),
          named: yield* refusalsNamed(packets.at(-1)!.id),
        };
      }),
    );
  };
  const reference = await once(false);
  const replayed = await once(true);
  expect(replayed).toEqual(reference);
  expect(replayed.named[0]).toContain("no usable ID");
}, 20_000);
