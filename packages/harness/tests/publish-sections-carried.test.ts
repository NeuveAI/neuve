// Why: a carried decision closes work without a person looking again, so what carries, by whom,
// onto which unit and with which comments must be exact, and a replay must never pick up a
// decision made after its plan.
import { expect, test } from "bun:test";
import { Effect } from "effect";
import {
  Dispositions,
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
  batchOf,
  eventsOf,
  inputOf,
  keyedOf,
  lines,
  scratch,
  section,
  threeBatches,
  unit,
} from "./publish-sections-fixtures.ts";

type Of<K extends RecordEvent["kind"]> = Extract<RecordEvent, { kind: K }>;

const opener = sha256Hex("carried-test-opener");
const range = {
  baseRef: "main",
  baseOid: "1".repeat(40),
  headOid: "2".repeat(40),
};
const laterHead = "3".repeat(40);
const person = (name: string) =>
  sha256Hex(`neuve-actor/1\u0000human\u0000${name}@example.com`);
const ana = person("ana");
const ben = person("ben");

const registration = (actor: string, name: string) => ({
  id: mintUlid(),
  kind: "actor.registered@1",
  idempotencyKey: `actor:${actor}`,
  actor,
  occurredAt: new Date().toISOString(),
  payload: { actorKind: "human", harness: "git", email: `${name}@example.com` },
});

const opened = (cycleId: string, head: string) => [
  {
    id: mintUlid(),
    kind: "cycle.opened@1",
    idempotencyKey: `test:cycle:${cycleId}`,
    actor: opener,
    occurredAt: new Date().toISOString(),
    attribution: { cycleId, range: { ...range, headOid: head } },
    payload: {},
  },
  {
    id: mintUlid(),
    kind: "review.origin-recorded@1",
    idempotencyKey: `test:origin:${cycleId}`,
    actor: opener,
    occurredAt: new Date().toISOString(),
    attribution: { cycleId, range: { ...range, headOid: head } },
    payload: {
      identity: sha256Hex(`origin:${cycleId}`),
      origin: {
        kind: "channel",
        host: "host",
        channel: "review",
        chat: 7,
        items: [],
      },
    },
  },
];

/** A person's disposition on an earlier unit, as `neuve review decide` records one. */
const decision = (
  actor: string,
  cycleId: string,
  unitId: string,
  verdict: "approve" | "request-changes",
  restsOn: ReadonlyArray<string> = [],
) => ({
  id: mintUlid(),
  kind: "disposition.recorded@2",
  idempotencyKey: `test:decide:${mintUlid()}`,
  actor,
  occurredAt: new Date().toISOString(),
  attribution: { cycleId, unitIds: [unitId] },
  payload: {
    verdict,
    reviewedHeadOid: range.headOid,
    restsOn: [...restsOn],
    proof: [],
  },
});

/** A person's comment on an earlier unit, with an anchor or none. */
const remark = (
  actor: string,
  cycleId: string,
  unitId: string,
  anchor?: { startLine: number; endLine: number },
) => ({
  id: mintUlid(),
  kind: "comment.recorded@2",
  idempotencyKey: `test:comment:${mintUlid()}`,
  actor,
  occurredAt: new Date().toISOString(),
  attribution: { cycleId, unitIds: [unitId] },
  payload: {
    body: "This retry needs a bound.",
    ...(anchor === undefined
      ? {}
      : { anchor: { path: "src/a.ts", side: "new", ...anchor } }),
    finding: { kind: "defect", about: "code", evidence: [] },
  },
});

const T = Date.UTC(2026, 10, 12, 12, 0, 0);

/**
 * One store with two cycles of the same review (one chat): cycle 1 publishes `earlier`, people
 * then decide through `decide(units)`, and cycle 2 is opened for the caller to publish into.
 */
const twoCycles = (options: {
  readonly earlier: ReadonlyArray<SettledBatch>;
  readonly ids?: { cycle1: string; cycle2: string; run1: string; run2: string };
}) => {
  const ids = options.ids ?? {
    cycle1: mintUlid(),
    cycle2: mintUlid(),
    run1: mintUlid(),
    run2: mintUlid(),
  };
  const store = scratch({ cycleId: ids.cycle1 });
  const first = store.ctx({ runId: ids.run1, startedAt: T - 1_000 });
  const second = store.ctx({
    cycleId: ids.cycle2,
    runId: ids.run2,
    startedAt: T - 1_000,
    range: { ...range, headOid: laterHead },
  });
  const setup = Effect.gen(function* () {
    yield* Log.append([
      registration(ana, "ana"),
      registration(ben, "ben"),
      ...opened(ids.cycle1, range.headOid),
    ]);
    yield* atTime(T)(
      publishSettled(
        first,
        inputOf(options.earlier, {
          ending: true,
          totals: {
            batches: options.earlier.length,
            sections: options.earlier.reduce(
              (n, b) => n + b.sections.length,
              0,
            ),
          },
        }),
      ),
    );
    yield* Log.append(opened(ids.cycle2, laterHead));
    const read = yield* PublishedPackets.readStanding(ids.cycle1);
    if (read?.kind !== "packet.published@2") throw new Error("no packet");
    // Earlier units by their first section's title.
    return Object.fromEntries(
      read.batches.flatMap((batch) =>
        batch.units.map((u) => [u.sections[0]!.title, u.unitId]),
      ),
    ) as Record<string, string>;
  });
  const publishLater = (batches: ReadonlyArray<SettledBatch>, at = T + 100) =>
    atTime(at)(
      publishSettled(
        second,
        inputOf(batches, {
          ending: true,
          totals: {
            batches: batches.length,
            sections: batches.reduce((n, b) => n + b.sections.length, 0),
          },
        }),
      ),
    );
  const laterUnits = Effect.gen(function* () {
    const read = yield* PublishedPackets.readStanding(ids.cycle2);
    if (read?.kind !== "packet.published@2") throw new Error("no packet");
    return {
      read,
      units: Object.fromEntries(
        read.batches.flatMap((batch) =>
          batch.units.map((u) => [u.sections[0]!.title, u]),
        ),
      ),
    };
  });
  return { ids, store, first, second, setup, publishLater, laterUnits };
};

const required = "The exported change";
const agentic = "The retry change";

/** `a.ts`'s human-required section moved down by `offset` lines, its text unchanged. */
const movedA = (offset: number) => {
  const { a } = threeBatches();
  const a2 = section({
    label: "a2",
    path: "src/a.ts",
    name: "exported",
    where: { startLine: 30 + offset, endLine: 50 + offset },
    ranges: lines("src/a.ts", 31 + offset, 2),
    lane: "human-required",
    judged: "agentic",
  });
  return batchOf(
    "Retry policy",
    ["src/a.ts"],
    [a.sections[0]!, a2],
    [a.units[0]!, unit("src/a.ts", "human-required", [a2])],
  );
};

test("an unchanged human-required unit a person approved carries the approval and closes", async () => {
  const { a } = threeBatches();
  const review = twoCycles({ earlier: [a] });
  const result = await review.store.run(
    Effect.gen(function* () {
      const earlier = yield* review.setup;
      const approved = decision(
        ana,
        review.ids.cycle1,
        earlier[required]!,
        "approve",
      );
      yield* Log.append([approved]);
      const summary = yield* review.publishLater([a]);
      const { units, read } = yield* review.laterUnits;
      const now = units[required]!;
      return {
        approved,
        summary,
        read,
        now,
        judged: yield* Dispositions.judge(now.unitId),
        earlierStill: yield* Dispositions.current({
          unitId: earlier[required]!,
          cycleId: review.ids.cycle1,
        }),
      };
    }),
  );
  // The reader keeps `disposition` for the review's own (none here) and returns the person's
  // decision in `carriedDecisions`; `judgement` closes on it, standing by the person.
  expect(result.now.disposition).toBeUndefined();
  expect(result.now.carriedDecisions).toHaveLength(1);
  const carried = result.now.carriedDecisions[0];
  expect(carried?.kind).toBe("disposition.carried@1");
  expect(carried?.actor).toBe(ana);
  expect(carried?.payload.verdict).toBe("approve");
  expect(carried?.payload.reviewedHeadOid).toBe(laterHead);
  if (carried?.kind === "disposition.carried@1")
    expect(carried.payload.from).toMatchObject({
      cycle: review.ids.cycle1,
      head: range.headOid,
      judgement: result.approved.id,
      output: result.now.lineage!.id,
      savedMs: 0,
    });
  expect(result.now.lineage?.payload.from[0]?.relation).toBe("unchanged");
  expect(result.judged).toMatchObject({ lane: "human-required", closed: true });
  expect(result.judged.standing?.actorId).toBe(ana);
  expect(result.judged.standing?.eventId).toBe(carried!.id);
  expect(result.now.judgement.closed).toBe(true);
  expect(result.now.judgement.standing?.eventId).toBe(carried!.id);
  // The earlier decision stands on the earlier unit, untouched.
  expect(result.earlierStill.map((d) => d.eventId)).toEqual([
    result.approved.id,
  ]);
  expect(result.summary.carried).toEqual({ dispositions: 1, comments: 0 });
});

// Why: a retraction of an older decision that did not stand withdrew nothing, so the person's
// newer decision, the one that stood, must still reach the unchanged unit of the next review.
test("a person's standing decision carries after they retract an older one that did not stand", async () => {
  const { a } = threeBatches();
  const review = twoCycles({ earlier: [a] });
  const result = await review.store.run(
    Effect.gen(function* () {
      const earlier = yield* review.setup;
      const unitId = earlier[required]!;
      // Two decisions, neither replacing the other, then a retraction of the older.
      const older = decision(ana, review.ids.cycle1, unitId, "request-changes");
      const newer = decision(ana, review.ids.cycle1, unitId, "approve");
      yield* Log.append([
        older,
        newer,
        {
          id: mintUlid(),
          kind: "disposition.retracted@1",
          idempotencyKey: `test:retract:${older.id}`,
          actor: ana,
          occurredAt: new Date().toISOString(),
          attribution: { cycleId: review.ids.cycle1, unitIds: [unitId] },
          causation: { supersedes: older.id },
          payload: {},
        },
      ]);
      const summary = yield* review.publishLater([a]);
      const { units } = yield* review.laterUnits;
      return { newer, summary, now: units[required]! };
    }),
  );
  expect(result.now.carriedDecisions).toHaveLength(1);
  const carried = result.now.carriedDecisions[0];
  expect(carried?.actor).toBe(ana);
  expect(carried?.payload.verdict).toBe("approve");
  if (carried?.kind === "disposition.carried@1")
    expect(carried.payload.from.judgement).toBe(result.newer.id);
  expect(result.now.judgement.closed).toBe(true);
  expect(result.summary.carried).toEqual({ dispositions: 1, comments: 0 });
});

test("a changed unit carries nothing; lineage says changed", async () => {
  const { a } = threeBatches();
  const changed = section({
    label: "a2-touched",
    path: "src/a.ts",
    name: "exported",
    where: { startLine: 30, endLine: 52 },
    ranges: lines("src/a.ts", 31, 3),
    lane: "human-required",
  });
  const later = batchOf(
    "Retry policy",
    ["src/a.ts"],
    [a.sections[0]!, changed],
    [a.units[0]!, unit("src/a.ts", "human-required", [changed])],
  );
  const review = twoCycles({ earlier: [a] });
  const result = await review.store.run(
    Effect.gen(function* () {
      const earlier = yield* review.setup;
      yield* Log.append([
        decision(ana, review.ids.cycle1, earlier[required]!, "approve"),
      ]);
      yield* review.publishLater([later]);
      const { units } = yield* review.laterUnits;
      return {
        now: units[required]!,
        carried: yield* eventsOf(review.ids.cycle2, "disposition.carried@1"),
      };
    }),
  );
  expect(result.carried).toEqual([]);
  expect(result.now.disposition).toBeUndefined();
  expect(result.now.carriedDecisions).toEqual([]);
  expect(result.now.lineage?.payload.from[0]?.relation).toBe("changed");
  expect(result.now.judgement.closed).toBe(false);
});

test("an agent's approval on the earlier unit is never carried", async () => {
  const { c } = threeBatches();
  const review = twoCycles({ earlier: [c] });
  const result = await review.store.run(
    Effect.gen(function* () {
      yield* review.setup;
      yield* review.publishLater([c]);
      const { units } = yield* review.laterUnits;
      return {
        now: units["The table change"]!,
        carried: yield* eventsOf(review.ids.cycle2, "disposition.carried@1"),
      };
    }),
  );
  expect(result.carried).toEqual([]);
  expect(result.now.lineage?.payload.from[0]?.relation).toBe("unchanged");
  expect(result.now.disposition?.kind).toBe("disposition.recorded@2");
  expect(result.now.carriedDecisions).toEqual([]);
});

test("a person's request for changes carries with its comments, anchors moved by the span's offset", async () => {
  const { a } = threeBatches();
  const review = twoCycles({ earlier: [a] });
  const result = await review.store.run(
    Effect.gen(function* () {
      const earlier = yield* review.setup;
      const on = earlier[required]!;
      const anchored = remark(ana, review.ids.cycle1, on, {
        startLine: 31,
        endLine: 31,
      });
      const whole = remark(ana, review.ids.cycle1, on);
      const lost = remark(ana, review.ids.cycle1, on, {
        startLine: 100,
        endLine: 101,
      });
      const asked = decision(ana, review.ids.cycle1, on, "request-changes", [
        anchored.id,
        whole.id,
        lost.id,
      ]);
      yield* Log.append([anchored, whole, lost, asked]);
      const summary = yield* review.publishLater([movedA(5)]);
      const { units } = yield* review.laterUnits;
      return {
        anchored,
        whole,
        lost,
        summary,
        now: units[required]!,
        read: yield* review.laterUnits,
      };
    }),
  );
  const carried = result.now.comments.filter(
    (c): c is Of<"comment.carried@1"> => c.kind === "comment.carried@1",
  );
  const byOrigin = Object.fromEntries(
    carried.map((c) => [c.payload.from.judgement, c]),
  );
  expect(carried).toHaveLength(3);
  expect(byOrigin[result.anchored.id]!.payload.anchor).toEqual({
    path: "src/a.ts",
    side: "new",
    startLine: 36,
    endLine: 36,
  });
  expect(byOrigin[result.whole.id]!.payload.anchor).toBeUndefined();
  expect(byOrigin[result.lost.id]!.payload.anchor).toBeUndefined();
  expect(carried.every((c) => c.actor === ana)).toBe(true);
  expect(result.now.disposition).toBeUndefined();
  const disposition = result.now.carriedDecisions[0];
  expect(disposition?.kind).toBe("disposition.carried@1");
  expect(disposition?.payload.verdict).toBe("request-changes");
  expect([...disposition!.payload.restsOn].sort()).toEqual(
    carried.map((c) => c.id).sort(),
  );
  // The anchor that could not be placed is said, naming the unit.
  const batch = result.read.read.batches[0]!;
  const unanchored = batch.gaps.filter(
    (g) => g.payload.kind === "carried-comment-unanchored",
  );
  expect(unanchored.map((g) => g.attribution.unitIds)).toEqual([
    [result.now.unitId],
  ]);
  expect(unanchored[0]!.payload.detail).toContain(
    "shown on the unit as a whole",
  );
  expect(result.summary.carried).toEqual({ dispositions: 1, comments: 3 });
});

test("two people's approvals both carry", async () => {
  const { a } = threeBatches();
  const review = twoCycles({ earlier: [a] });
  const result = await review.store.run(
    Effect.gen(function* () {
      const earlier = yield* review.setup;
      yield* Log.append([
        decision(ana, review.ids.cycle1, earlier[required]!, "approve"),
        decision(ben, review.ids.cycle1, earlier[required]!, "approve"),
      ]);
      yield* review.publishLater([a]);
      const { units } = yield* review.laterUnits;
      return {
        now: units[required]!,
        carried: (yield* eventsOf(
          review.ids.cycle2,
          "disposition.carried@1",
        )) as Array<Of<"disposition.carried@1">>,
      };
    }),
  );
  expect(result.carried.map((d) => d.actor).sort()).toEqual([ana, ben].sort());
  expect(
    result.carried.every((d) => d.attribution.unitIds[0] === result.now.unitId),
  ).toBe(true);
  expect(result.now.judgement.closing.map((d) => d.actorId).sort()).toEqual(
    [ana, ben].sort(),
  );
});

test("a disputed unit carries no earlier approval: this review asks for changes, or places it higher", async () => {
  const { a, c } = threeBatches();
  // `c.ts`'s section unchanged, now in a higher lane; `a.ts`'s agentic unit asks for changes.
  const c1 = section({
    label: "c1",
    path: "src/c.ts",
    name: "table",
    where: { startLine: 1, endLine: 2_400 },
    ranges: lines("src/c.ts", 1, 1_100),
    lane: "human-required",
  });
  const higher = batchOf(
    "Lookup table",
    ["src/c.ts"],
    [c1],
    [unit("src/c.ts", "human-required", [c1])],
  );
  const review = twoCycles({ earlier: [a, c] });
  const result = await review.store.run(
    Effect.gen(function* () {
      const earlier = yield* review.setup;
      yield* Log.append([
        decision(ana, review.ids.cycle1, earlier[agentic]!, "approve"),
        decision(
          ana,
          review.ids.cycle1,
          earlier["The table change"]!,
          "approve",
        ),
      ]);
      yield* review.publishLater([a, higher]);
      const { units, read } = yield* review.laterUnits;
      const asks = units[agentic]!;
      const placed = units["The table change"]!;
      return {
        read,
        asks,
        placed,
        judgedAsks: yield* Dispositions.judge(asks.unitId),
        judgedPlaced: yield* Dispositions.judge(placed.unitId),
        carried: yield* eventsOf(review.ids.cycle2, "disposition.carried@1"),
      };
    }),
  );
  expect(result.carried).toEqual([]);
  expect(result.asks.lineage?.payload.from[0]?.relation).toBe("unchanged");
  expect(result.placed.lineage?.payload.from[0]?.relation).toBe("unchanged");
  const gaps = result.read.batches.flatMap((b) => b.gaps);
  const notCarried = gaps.filter(
    (g) => g.payload.kind === "earlier-approval-not-carried",
  );
  expect(
    notCarried.map((g) => [g.attribution.unitIds?.[0], g.payload.detail]),
  ).toEqual([
    [
      result.asks.unitId,
      expect.stringContaining(
        "because this review asks for changes to it. A person decides it again.",
      ),
    ],
    [
      result.placed.unitId,
      expect.stringContaining(
        "places it in a higher review lane (human required)",
      ),
    ],
  ]);
  expect(result.judgedAsks.closing.some((d) => d.actorId === ana)).toBe(false);
  expect(result.judgedPlaced.closed).toBe(false);
});

test("a decision recorded between two attempts of a publication is not in the replay's writes", async () => {
  const { a } = threeBatches();
  const ids = {
    cycle1: mintUlid(),
    cycle2: mintUlid(),
    run1: mintUlid(),
    run2: mintUlid(),
  };
  // The same human decision event in both stores, so the carried events can match byte for byte.
  const approvalOf = (unitId: string) => ({
    ...decision(ana, ids.cycle1, unitId, "approve"),
    id: "01M7ANAAPPR0VA1000000000AA",
    idempotencyKey: "test:decide:ana",
  });
  const once = async (between: boolean) => {
    const review = twoCycles({ earlier: [a], ids });
    return review.store.run(
      Effect.gen(function* () {
        const earlier = yield* review.setup;
        yield* Log.append([approvalOf(earlier[required]!)]);
        if (between) {
          const stopped = yield* Effect.exit(
            atTime(T + 100)(
              publishSettledForTest(
                review.second,
                inputOf([a], {
                  ending: true,
                  totals: { batches: 1, sections: 2 },
                }),
                "plan",
              ),
            ),
          );
          expect(stopped._tag).toBe("Failure");
          yield* Log.append([
            decision(ben, ids.cycle1, earlier[required]!, "approve"),
          ]);
        }
        yield* review.publishLater([a], T + 100);
        const packets = (yield* eventsOf(
          ids.cycle2,
          "packet.published@2",
        )) as Array<Of<"packet.published@2">>;
        return {
          keyed: yield* keyedOf(ids.cycle2, review.second.runKey),
          manifests: packets.map((p) => p.refs[0].ref),
          carried: (
            (yield* eventsOf(ids.cycle2, "disposition.carried@1")) as Array<
              Of<"disposition.carried@1">
            >
          ).map((d) => d.actor),
        };
      }),
    );
  };
  const reference = await once(false);
  const replayed = await once(true);
  expect(replayed.carried).toEqual([ana]);
  expect(replayed.keyed).toEqual(reference.keyed);
  expect(replayed.manifests).toEqual(reference.manifests);
});

test("a person's request for changes carries even when this review disputes the unit", async () => {
  const { a } = threeBatches();
  const review = twoCycles({ earlier: [a] });
  const result = await review.store.run(
    Effect.gen(function* () {
      const earlier = yield* review.setup;
      const note = remark(ana, review.ids.cycle1, earlier[agentic]!, {
        startLine: 3,
        endLine: 3,
      });
      yield* Log.append([
        note,
        decision(ana, review.ids.cycle1, earlier[agentic]!, "request-changes", [
          note.id,
        ]),
      ]);
      yield* review.publishLater([a]);
      const { units } = yield* review.laterUnits;
      return {
        now: units[agentic]!,
        judged: yield* Dispositions.judge(units[agentic]!.unitId),
      };
    }),
  );
  const kinds = result.now.comments.map((c) => c.kind);
  expect(kinds.filter((k) => k === "comment.carried@1")).toHaveLength(1);
  expect(result.judged.closing.map((d) => d.actorId)).toContain(ana);
  // The review's own request for changes stays `disposition`; the person's is carried beside it.
  expect(result.now.disposition?.actor).not.toBe(ana);
  expect(result.now.carriedDecisions.map((d) => d.actor)).toEqual([ana]);
});
