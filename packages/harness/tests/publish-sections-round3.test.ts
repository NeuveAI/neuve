// Why: the defects the independent review found in round 2. A refusal held for a batch must be
// named once, only by packets that do not publish that batch, whichever run or call held it; and
// a person's last act on the code counts, a retraction included, so a review never brings back
// a decision the person took back.
import { expect, test } from "bun:test";
import { Effect } from "effect";
import {
  Dispositions,
  HumanCommands,
  Identity,
  Log,
  PublishedPackets,
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
  keyedOf,
  scratch,
  threeBatches,
} from "./publish-sections-fixtures.ts";

type Packet = Extract<RecordEvent, { kind: "packet.published@2" }>;
type Gap = Extract<RecordEvent, { kind: "gap.disclosed@1" }>;

const ALL = { batches: 3, sections: 5 };

/** Batch `c` refused by the lane check: its unit says human-required, its section agentic. */
const laneRefused = (): SettledBatch => {
  const { c } = threeBatches();
  return { ...c, units: [{ ...c.units[0]!, lane: "human-required" }] };
};
/** Batch `c` refused by another check: a comment ID with a space. */
const idRefused = (): SettledBatch => {
  const { c } = threeBatches();
  return {
    ...c,
    units: [{ ...c.units[0]!, comments: [comment("has space")] }],
  };
};

const packetsOf = (cycleId: string) =>
  Effect.map(eventsOf(cycleId, "packet.published@2"), (events) =>
    (events as Array<Packet>).sort((x, y) => (x.id < y.id ? -1 : 1)),
  );

/** The refusal gaps a packet names, by detail. */
const refusalsNamed = (packetId: string) =>
  Effect.map(PublishedPackets.readExact(packetId), (read) =>
    read?.kind === "packet.published@2"
      ? read.gaps
          .filter((g) => g.payload.kind === "batch-not-published")
          .map((g) => g.payload.detail)
      : [],
  );

// R2-1, probe p5: held once whoever holds it, named only while the batch is missing.
test("a refusal held by a repeat and a follow-on run is one gap, named only while its batch is missing", async () => {
  const store = scratch();
  const { a, b, c } = threeBatches();
  const result = await store.run(
    Effect.gen(function* () {
      const first = store.ctx();
      yield* publishSettled(first, inputOf([a], { totals: ALL }));
      yield* publishSettled(first, inputOf([laneRefused()], { totals: ALL }));
      yield* publishSettled(first, inputOf([laneRefused()], { totals: ALL }));
      const later = store.ctx();
      yield* publishSettled(later, inputOf([laneRefused()], { totals: ALL }));
      const held = (yield* eventsOf(
        first.cycleId,
        "gap.disclosed@1",
      )) as Array<Gap>;
      // A packet that does not publish `c` names its refusal, once.
      yield* publishSettled(later, inputOf([b], { totals: ALL }));
      // `c` fixed: the packet holding it names no refusal of it.
      yield* publishSettled(later, inputOf([c], { ending: true, totals: ALL }));
      const packets = yield* packetsOf(first.cycleId);
      const named = [];
      for (const packet of packets) named.push(yield* refusalsNamed(packet.id));
      return { held, packets, named };
    }),
  );
  expect(
    result.held.filter((g) => g.payload.kind === "batch-not-published"),
  ).toHaveLength(1);
  expect(result.packets).toHaveLength(3);
  expect(result.named[0]).toEqual([]);
  expect(result.named[1]).toHaveLength(1);
  expect(result.named[1]![0]).toContain('"Lookup table"');
  expect(result.named[2]).toEqual([]);
  expect(result.packets[2]!.payload.complete).toBe(true);
  expect(result.packets[1]!.payload.counts.pending).toEqual({
    batches: 1,
    sections: 1,
  });
}, 20_000);

// R2-1: a batch refused one way, then another, is named by its newest refusal only.
test("two different refusals of one batch over time name the newest only", async () => {
  const store = scratch();
  const { a, b } = threeBatches();
  const result = await store.run(
    Effect.gen(function* () {
      const ctx = store.ctx();
      yield* atTime(Date.now())(
        publishSettled(ctx, inputOf([a], { totals: ALL })),
      );
      yield* atTime(Date.now() + 1_000)(
        publishSettled(ctx, inputOf([laneRefused()], { totals: ALL })),
      );
      yield* atTime(Date.now() + 2_000)(
        publishSettled(ctx, inputOf([idRefused()], { totals: ALL })),
      );
      yield* atTime(Date.now() + 3_000)(
        publishSettled(ctx, inputOf([b], { totals: ALL })),
      );
      const packets = yield* packetsOf(ctx.cycleId);
      return yield* refusalsNamed(packets.at(-1)!.id);
    }),
  );
  expect(result).toHaveLength(1);
  expect(result[0]).toContain("no usable ID");
}, 20_000);

// R2-1: which held refusals a packet names is fixed in its plan; a replay names the same ones,
// even when another refusal is held between the stop and the replay.
test("a packet naming a held refusal, stopped after its plan and replayed, writes the same bytes", async () => {
  const T = Date.UTC(2026, 10, 12, 16, 0, 0);
  const cycleId = mintUlid();
  const runId = mintUlid();
  const { a, b } = threeBatches();
  const once = async (stopped: boolean) => {
    const store = scratch({ cycleId });
    return store.run(
      Effect.gen(function* () {
        const ctx = store.ctx({ runId, startedAt: T - 1_000 });
        yield* atTime(T)(publishSettled(ctx, inputOf([a], { totals: ALL })));
        yield* atTime(T + 10)(
          publishSettled(ctx, inputOf([laneRefused()], { totals: ALL })),
        );
        if (stopped) {
          expect(
            (yield* Effect.exit(
              atTime(T + 20)(
                publishSettledForTest(
                  ctx,
                  inputOf([b], { totals: ALL }),
                  "plan",
                ),
              ),
            ))._tag,
          ).toBe("Failure");
          // Held after the plan was made: the replayed packet does not name it.
          yield* atTime(T + 30)(
            publishSettled(ctx, inputOf([idRefused()], { totals: ALL })),
          );
        }
        yield* atTime(T + 20)(
          publishSettled(ctx, inputOf([b], { totals: ALL })),
        );
        const packets = yield* packetsOf(cycleId);
        return {
          packets: packets.map((p) => [p.id, p.refs[0].ref]),
          named: yield* refusalsNamed(packets.at(-1)!.id),
          keyed: Object.fromEntries(
            Object.entries(yield* keyedOf(cycleId, ctx.runKey)).filter(
              ([key]) => !key.includes(":gap:refused:"),
            ),
          ),
        };
      }),
    );
  };
  const reference = await once(false);
  const replayed = await once(true);
  expect(replayed.packets).toEqual(reference.packets);
  expect(replayed.named).toEqual(reference.named);
  expect(replayed.named).toHaveLength(1);
  expect(replayed.keyed).toEqual(reference.keyed);
}, 20_000);

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
  return { s, first, configuration };
};

const ana = { email: "ana-r3@example.com" };
const ben = { email: "ben-r3@example.com" };
const anaId = Identity.humanFingerprint(ana.email);
const benId = Identity.humanFingerprint(ben.email);

// R2-2, the reviewer's probe: a retraction of a carried approval is the person's last act.
test("a person's retraction of a carried approval is not undone by the next configuration", async () => {
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
      const onB = yield* r.configuration("b".repeat(64));
      return { onA, onB, judged: yield* Dispositions.judge(onB.unitId) };
    }),
  );
  expect(result.onA.carriedDecisions.map((d) => d.actor)).toEqual([anaId]);
  expect(result.onB.carriedDecisions).toEqual([]);
  expect(result.judged.closed).toBe(false);
}, 20_000);

// R2-2: an approval after the retraction is the last act again, and carries.
test("a person who retracts and then approves again on configuration A carries the approval to B", async () => {
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
      const again = yield* HumanCommands.recordDisposition({
        person: ana,
        unitId: onA.unitId,
        verdict: "approve",
      });
      const onB = yield* r.configuration("b".repeat(64));
      return { again, onB, judged: yield* Dispositions.judge(onB.unitId) };
    }),
  );
  expect(
    result.onB.carriedDecisions.map((d) => [
      d.actor,
      d.payload.verdict,
      d.payload.from.judgement,
    ]),
  ).toEqual([[anaId, "approve", result.again.dispositionId]]);
  expect(result.judged.closed).toBe(true);
}, 20_000);

// R2-2 guard: a retraction on the earlier cycle's own unit leaves nothing to carry.
test("a retraction on the earlier cycle's own unit carries nothing", async () => {
  const r = review();
  const result = await r.s.run(
    Effect.gen(function* () {
      const earlier = yield* r.first;
      const decided = yield* HumanCommands.recordDisposition({
        person: ana,
        unitId: earlier.unitId,
        verdict: "approve",
      });
      yield* HumanCommands.retractDisposition({
        person: ana,
        dispositionId: decided.dispositionId,
      });
      const onA = yield* r.configuration("a".repeat(64));
      return { onA, judged: yield* Dispositions.judge(onA.unitId) };
    }),
  );
  expect(result.onA.carriedDecisions).toEqual([]);
  expect(result.judged.closed).toBe(false);
}, 20_000);

// R2-2: one person's retraction takes back only their own decision.
test("of two people, only the one who did not retract carries", async () => {
  const r = review();
  const result = await r.s.run(
    Effect.gen(function* () {
      const earlier = yield* r.first;
      yield* HumanCommands.recordDisposition({
        person: ana,
        unitId: earlier.unitId,
        verdict: "approve",
      });
      yield* HumanCommands.recordDisposition({
        person: ben,
        unitId: earlier.unitId,
        verdict: "approve",
      });
      const onA = yield* r.configuration("a".repeat(64));
      const anas = onA.carriedDecisions.find((d) => d.actor === anaId)!;
      yield* HumanCommands.retractDisposition({
        person: ana,
        dispositionId: anas.id,
      });
      const onB = yield* r.configuration("b".repeat(64));
      return { onA, onB };
    }),
  );
  expect(result.onA.carriedDecisions.map((d) => d.actor).sort()).toEqual(
    [anaId, benId].sort(),
  );
  expect(result.onB.carriedDecisions.map((d) => d.actor)).toEqual([benId]);
}, 20_000);
