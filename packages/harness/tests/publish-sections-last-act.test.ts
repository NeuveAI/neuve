// Why: what a new review carries of a person's decisions on an unchanged unit is decided by their
// last act, in the store's append order, on any earlier unit of the same unchanged change, never
// by following one decision's copies and replacements (the records lane's design, 12 November).
// Through the real publisher and the real commands: B5 (a 17th copy and deeper), B7 (two
// replacements of one decision on two units), Q1 (a first request for changes on a review that no
// longer stands), B6 (`decidedBy` and the publisher agree), the acts-read bound, the late review
// (R2b), and the orderings that must still carry.
import { expect, test } from "bun:test";
import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import {
  Dispositions,
  HumanCommands,
  Identity,
  Lineage,
  Log,
  PublishedPackets,
  mintUlid,
  sha256Hex,
} from "@neuve/records-core";
import {
  publishSettled,
  publishSettledForTest,
  type SettledBatch,
} from "../src/publish-sections.ts";
import {
  atTime,
  batchOf,
  inputOf,
  lines,
  scratch,
  section,
  threeBatches,
  unit as settledUnit,
} from "./publish-sections-fixtures.ts";

const ana = { email: "ana-last-act@example.com" };
const anaId = Identity.humanFingerprint(ana.email);
const ben = { email: "ben-last-act@example.com" };
const benId = Identity.humanFingerprint(ben.email);

const ONE = { batches: 1, sections: 2 };
const LATER = "later-decision-not-carried";
const NOT_READ = "earlier-decisions-not-read";

/**
 * How a review cuts `src/a.ts`'s two changes (section keys `a1` and `a2`) into units: `wide`, one
 * human-required unit holding both; `split`, `a1` alone as an agentic unit the review's agent
 * approves beside `a2` alone, human-required; `apart`, each alone, both human-required.
 */
type Cut = "wide" | "split" | "apart";
const cutOf = (cut: Cut): SettledBatch => {
  const { a1, a2 } = threeBatches().sections;
  const a1Required = section({
    label: "a1",
    path: "src/a.ts",
    name: "retry",
    where: { startLine: 1, endLine: 20 },
    ranges: a1.ownedRanges,
    lane: "human-required",
  });
  const units =
    cut === "wide"
      ? [settledUnit("src/a.ts", "human-required", [a1Required, a2])]
      : cut === "split"
        ? [
            settledUnit("src/a.ts", "agentic", [a1], {
              verdict: "approve",
              disposition: "approve",
            }),
            settledUnit("src/a.ts", "human-required", [a2]),
          ]
        : [
            settledUnit("src/a.ts", "human-required", [a1Required]),
            settledUnit("src/a.ts", "human-required", [a2]),
          ];
  return batchOf(
    "Retry policy",
    ["src/a.ts"],
    [cut === "split" ? a1 : a1Required, a2],
    units,
  );
};
const A1 = threeBatches().sections.a1.identity.key;
const A2 = threeBatches().sections.a2.identity.key;

/**
 * A file of three human-required changes `x`, `y` and `z` (`src/t.ts`), cut into units as
 * `groups` says: `[["x", "y"], ["z"]]` is a unit of X and Y beside a unit of Z.
 */
type Change = "x" | "y" | "z";
const threeSections = (["x", "y", "z"] as const).map((name, n) =>
  section({
    label: `three-${name}`,
    path: "src/t.ts",
    name,
    where: { startLine: n * 20 + 1, endLine: n * 20 + 10 },
    ranges: lines("src/t.ts", n * 20 + 2, 2),
    lane: "human-required",
  }),
);
const THREE_KEYS: Record<Change, string> = {
  x: threeSections[0]!.identity.key,
  y: threeSections[1]!.identity.key,
  z: threeSections[2]!.identity.key,
};
/** The same changes, agentic (same keys), for a unit the review's agent approves. */
const agenticSections = (["x", "y", "z"] as const).map((name, n) =>
  section({
    label: `three-${name}`,
    path: "src/t.ts",
    name,
    where: { startLine: n * 20 + 1, endLine: n * 20 + 10 },
    ranges: lines("src/t.ts", n * 20 + 2, 2),
    lane: "agentic",
  }),
);
/** `agentic`: the index of the group that is an agentic unit the review's agent approves. */
const threeCut = (
  groups: ReadonlyArray<ReadonlyArray<Change>>,
  agentic: number | null = null,
) => {
  const of = (name: Change, n: number) =>
    (n === agentic ? agenticSections : threeSections)[
      ["x", "y", "z"].indexOf(name)
    ]!;
  return batchOf(
    "Three changes",
    ["src/t.ts"],
    groups.flatMap((group, n) => group.map((name) => of(name, n))),
    groups.map((group, n) =>
      n === agentic
        ? settledUnit(
            "src/t.ts",
            "agentic",
            group.map((name) => of(name, n)),
            { verdict: "approve", disposition: "approve" },
          )
        : settledUnit(
            "src/t.ts",
            "human-required",
            group.map((name) => of(name, n)),
          ),
    ),
  );
};
const THREE = { batches: 1, sections: 3 };
/** The units of a three-change cut that hold each change. */
type Held = Readonly<Record<Change, Unit>>;

/** The units of a cut that hold `a1` and `a2` (the same unit for `wide`). */
type Parts = { readonly one: Unit; readonly two: Unit };

/**
 * One review (one chat): `cycle()` opens the next cycle and publishes its first configuration,
 * `configuration(key)` publishes another configuration of the newest cycle. Each returns the
 * human-required unit of the packet that then stands, which every configuration shares unchanged.
 * `cycleCut(cut)` and `configurationCut(key, cut)` publish `src/a.ts` cut as `cut` and return its
 * parts.
 */
const review = () => {
  const s = scratch();
  const { a } = threeBatches();
  const range = (n: number) => ({
    baseRef: "main",
    baseOid: "1".repeat(40),
    headOid: (n + 2).toString(16).padStart(40, "0"),
  });
  const cycles: Array<string> = [];
  const open = (cycleId: string, n: number) =>
    Log.append(
      (["cycle.opened@1", "review.origin-recorded@1"] as const).map((kind) => ({
        id: mintUlid(),
        kind,
        idempotencyKey: `test:${kind}:${cycleId}`,
        actor: sha256Hex("opener"),
        occurredAt: new Date().toISOString(),
        attribution: { cycleId, range: range(n) },
        payload:
          kind === "cycle.opened@1"
            ? {}
            : {
                identity: sha256Hex(`origin:${cycleId}`),
                origin: {
                  kind: "channel",
                  host: "h",
                  channel: "c",
                  chat: 5,
                  items: [],
                },
              },
      })),
    );
  const unitOf = (cycleId: string) =>
    Effect.gen(function* () {
      const read = yield* PublishedPackets.readStanding(cycleId);
      if (read?.kind !== "packet.published@2") throw new Error("no packet");
      return read.batches[0]!.units.find(
        (u) => u.assessment?.payload.lane === "human-required",
      )!;
    });
  const publish = (runKey: string) =>
    Effect.gen(function* () {
      const n = cycles.length - 1;
      yield* publishSettled(
        s.ctx({ cycleId: cycles[n]!, range: range(n), runKey }),
        inputOf([a], { ending: true, totals: ONE }),
      );
      return yield* unitOf(cycles[n]!);
    });
  const cycle = Effect.gen(function* () {
    const cycleId = mintUlid();
    cycles.push(cycleId);
    yield* open(cycleId, cycles.length - 1);
    return yield* publish("0".repeat(64));
  });
  const configuration = (key: string) => publish(key.repeat(64));
  const publishCut = (runKey: string, cut: Cut) =>
    Effect.gen(function* () {
      const n = cycles.length - 1;
      yield* publishSettled(
        s.ctx({ cycleId: cycles[n]!, range: range(n), runKey }),
        inputOf([cutOf(cut)], { ending: true, totals: ONE }),
      );
      const read = yield* PublishedPackets.readStanding(cycles[n]!);
      if (read?.kind !== "packet.published@2") throw new Error("no packet");
      const units = read.batches.flatMap((b) => b.units);
      const holding = (key: string) =>
        units.find((u) => u.sections.some((section) => section.key === key))!;
      return { one: holding(A1), two: holding(A2) } satisfies Parts;
    });
  const cycleCut = (cut: Cut) =>
    Effect.gen(function* () {
      const cycleId = mintUlid();
      cycles.push(cycleId);
      yield* open(cycleId, cycles.length - 1);
      return yield* publishCut("0".repeat(64), cut);
    });
  const configurationCut = (key: string, cut: Cut) =>
    publishCut(key.repeat(64), cut);
  const publishThree = (
    runKey: string,
    groups: ReadonlyArray<ReadonlyArray<Change>>,
    agentic: number | null = null,
  ) =>
    Effect.gen(function* () {
      const n = cycles.length - 1;
      yield* publishSettled(
        s.ctx({ cycleId: cycles[n]!, range: range(n), runKey }),
        inputOf([threeCut(groups, agentic)], { ending: true, totals: THREE }),
      );
      const read = yield* PublishedPackets.readStanding(cycles[n]!);
      if (read?.kind !== "packet.published@2") throw new Error("no packet");
      const units = read.batches.flatMap((b) => b.units);
      const holding = (key: string) =>
        units.find((u) => u.sections.some((section) => section.key === key))!;
      return {
        x: holding(THREE_KEYS.x),
        y: holding(THREE_KEYS.y),
        z: holding(THREE_KEYS.z),
      } satisfies Held;
    });
  const cycleThree = (
    groups: ReadonlyArray<ReadonlyArray<Change>>,
    agentic: number | null = null,
  ) =>
    Effect.gen(function* () {
      const cycleId = mintUlid();
      cycles.push(cycleId);
      yield* open(cycleId, cycles.length - 1);
      return yield* publishThree("0".repeat(64), groups, agentic);
    });
  const configurationThree = (
    key: string,
    groups: ReadonlyArray<ReadonlyArray<Change>>,
  ) => publishThree(key.repeat(64), groups);
  /** The gap kinds the newest cycle's standing packet names. */
  const gaps = Effect.gen(function* () {
    const read = yield* PublishedPackets.readStanding(cycles.at(-1)!);
    if (read?.kind !== "packet.published@2") throw new Error("no packet");
    return read.batches
      .flatMap((b) => b.gaps)
      .map((g) => ({
        ...g.payload,
        unitIds: (g.attribution as { unitIds?: ReadonlyArray<string> }).unitIds,
      }));
  });
  const newestCycle = () => cycles.at(-1)!;
  /** The gap kinds the newest cycle's standing packet names about `unit`. */
  const gapsOn = (unit: Unit) =>
    Effect.map(gaps, (all) =>
      all.filter((g) => g.unitIds?.includes(unit.unitId)).map((g) => g.kind),
    );
  return {
    s,
    cycle,
    configuration,
    cycleCut,
    configurationCut,
    cycleThree,
    configurationThree,
    gaps,
    gapsOn,
    newestCycle,
    range,
    open,
    cycles,
  };
};

type Unit = PublishedPackets.ReadUnit;

/** What a unit shows: its carried decisions as `[actor, verdict]`, whether it is closed. */
const shown = (unit: Unit) =>
  Effect.map(Dispositions.judge(unit.unitId), (judged) => ({
    carried: unit.carriedDecisions.map((d) => [d.actor, d.payload.verdict]),
    closed: judged.closed,
  }));

/** What a unit shows, with whether its packet names a later-decision or not-read gap. */
const shownWithGaps = (r: ReturnType<typeof review>, unit: Unit) =>
  Effect.gen(function* () {
    const kinds = (yield* r.gaps).map((g) => g.kind);
    return {
      ...(yield* shown(unit)),
      later: kinds.includes(LATER),
      notRead: kinds.includes(NOT_READ),
    };
  });

const OPEN = { carried: [], closed: false };
const OPEN_GAP = { carried: [], closed: false, later: true, notRead: false };
const OPEN_NO_GAP = {
  carried: [],
  closed: false,
  later: false,
  notRead: false,
};

const approve = (unit: Unit, person = ana) =>
  HumanCommands.recordDisposition({
    person,
    unitId: unit.unitId,
    verdict: "approve",
  });
const askChanges = (unit: Unit, person = ana) =>
  HumanCommands.recordDisposition({
    person,
    unitId: unit.unitId,
    verdict: "request-changes",
    comments: [{ body: "The export needs a guard." }],
  });
const retract = (dispositionId: string, person = ana) =>
  HumanCommands.retractDisposition({ person, dispositionId });
const copyOn = (unit: Unit) => unit.carriedDecisions[0]!.id;

/** Cycle 1 approved, then cycles 2 to 18 published once each, each carrying the approval on. */
const eighteenCycles = (r: ReturnType<typeof review>) =>
  Effect.gen(function* () {
    yield* approve(yield* r.cycle);
    let last: Unit | undefined;
    const carried: Array<number> = [];
    for (let n = 2; n <= 18; n++) {
      last = yield* r.cycle;
      carried.push(last.carriedDecisions.length);
    }
    return { onA: last!, carried };
  });

// B5, reproduction 1: the copy on cycle 18 is the 17th; its withdrawal is the person's last act.
test("an approval carried through 18 cycles and withdrawn on the 18th is carried by no later configuration", async () => {
  const r = review();
  const result = await r.s.run(
    Effect.gen(function* () {
      const { onA, carried } = yield* eighteenCycles(r);
      yield* retract(copyOn(onA));
      return {
        carried,
        b: yield* shown(yield* r.configuration("b")),
        c: yield* shown(yield* r.configuration("c")),
      };
    }),
  );
  expect(result.carried).toEqual(Array.from({ length: 17 }, () => 1));
  expect(result.b).toEqual(OPEN);
  expect(result.c).toEqual(OPEN);
}, 120_000);

// B5, reproduction 2: the 18th cycle's first copy replaced by a request after a second
// configuration carried the approval on.
test("an approval carried through 18 cycles and replaced by a request on the 18th is carried by no later configuration", async () => {
  const r = review();
  const result = await r.s.run(
    Effect.gen(function* () {
      const { onA } = yield* eighteenCycles(r);
      const b = yield* shown(yield* r.configuration("b"));
      yield* askChanges(onA);
      return {
        b,
        c: yield* shownWithGaps(r, yield* r.configuration("c")),
        d: yield* shownWithGaps(r, yield* r.configuration("d")),
      };
    }),
  );
  expect(result.b).toEqual({ carried: [[anaId, "approve"]], closed: true });
  expect(result.c).toEqual(OPEN_GAP);
  expect(result.d).toEqual(OPEN_GAP);
}, 120_000);

// B7, reproduction 1: two replacements of one decision, then a later act on the older one.
test("a second request on A after B's copy was replaced by an approval: nothing carries, with the gap", async () => {
  const r = review();
  const result = await r.s.run(
    Effect.gen(function* () {
      yield* approve(yield* r.cycle);
      const onA = yield* r.cycle;
      const onB = yield* r.configuration("b");
      yield* askChanges(onA);
      yield* approve(onB);
      yield* askChanges(onA);
      return {
        c: yield* shownWithGaps(r, yield* r.configuration("c")),
        d: yield* shownWithGaps(r, yield* r.configuration("d")),
        next: yield* shownWithGaps(r, yield* r.cycle),
      };
    }),
  );
  expect(result.c).toEqual(OPEN_GAP);
  expect(result.d).toEqual(OPEN_GAP);
  expect(result.next).toEqual(OPEN_GAP);
}, 60_000);

// B7, reproduction 2 (Neuve's ordering): A's copy and B's copy each replaced by an approval, then
// A's replacement withdrawn.
test("an approval on A, an approval on B, the first withdrawn: nothing carries", async () => {
  const r = review();
  const result = await r.s.run(
    Effect.gen(function* () {
      yield* approve(yield* r.cycle);
      const onA = yield* r.cycle;
      const onB = yield* r.configuration("b");
      const onAgain = yield* approve(onA);
      yield* approve(onB);
      yield* retract(onAgain.dispositionId);
      return {
        c: yield* shown(yield* r.configuration("c")),
        d: yield* shown(yield* r.configuration("d")),
      };
    }),
  );
  expect(result.c).toEqual(OPEN);
  expect(result.d).toEqual(OPEN);
}, 60_000);

// B7, reproduction 3: through the ancestor. A request on A, an approval replacing the original on
// cycle 1, B carries that approval, then a second request on A.
test("a second request on A after the original was replaced on cycle 1: nothing carries, with the gap", async () => {
  const r = review();
  const result = await r.s.run(
    Effect.gen(function* () {
      const first = yield* r.cycle;
      yield* approve(first);
      const onA = yield* r.cycle;
      yield* askChanges(onA);
      const again = yield* approve(first);
      const onB = yield* r.configuration("b");
      yield* askChanges(onA);
      return {
        again: again.dispositionId,
        b: onB.carriedDecisions.map((d) => d.payload.from.judgement),
        c: yield* shownWithGaps(r, yield* r.configuration("c")),
        d: yield* shownWithGaps(r, yield* r.configuration("d")),
      };
    }),
  );
  expect(result.b).toEqual([result.again]);
  expect(result.c).toEqual(OPEN_GAP);
  expect(result.d).toEqual(OPEN_GAP);
}, 60_000);

// Q1: the person's first request for changes, on A after B stands, is their last act on the change.
test("a first request for changes on A after B carried an approval of cycle 1: C and D carry nothing, with the gap", async () => {
  const r = review();
  const result = await r.s.run(
    Effect.gen(function* () {
      const first = yield* r.cycle;
      const onA = yield* r.cycle;
      yield* approve(first);
      const b = yield* shown(yield* r.configuration("b"));
      yield* askChanges(onA);
      return {
        b,
        c: yield* shownWithGaps(r, yield* r.configuration("c")),
        d: yield* shownWithGaps(r, yield* r.configuration("d")),
      };
    }),
  );
  expect(result.b).toEqual({ carried: [[anaId, "approve"]], closed: true });
  expect(result.c).toEqual(OPEN_GAP);
  expect(result.d).toEqual(OPEN_GAP);
}, 60_000);

/**
 * The next configuration published after `before`, and what both readers said of it beforehand:
 * `Lineage.lastActs` for the units it is unchanged from, and `decidedBy` on the units of the
 * packets it compares with.
 */
const agreement = (r: ReturnType<typeof review>, key: string) =>
  Effect.gen(function* () {
    const packets = yield* Lineage.earlierReview({
      cycleId: r.newestCycle(),
      isAncestor: () => Effect.succeed(false),
    });
    const decided = yield* Lineage.personDecidedUnitsOf(packets);
    const unit = yield* r.configuration(key);
    const from = (unit.lineage?.payload.from ?? [])
      .filter((e) => e.relation === "unchanged")
      .map((e) => e.unitId);
    const [answer] = yield* Lineage.lastActs([
      { units: from, sectionKeys: unit.sections.map((s) => s.key) },
    ]);
    const gapKinds = (yield* r.gaps).map((g) => g.kind);
    return {
      from,
      answer: answer!,
      decided,
      carried: unit.carriedDecisions.map((d) => ({
        actorId: d.actor,
        judgement: d.payload.from.judgement,
      })),
      later: gapKinds.includes(LATER),
      closed: (yield* Dispositions.judge(unit.unitId)).closed,
    };
  });

/** The function and the publisher agree for every person, and `decidedBy` names no one else. */
const expectAgreement = (
  seen: Effect.Success<ReturnType<typeof agreement>>,
) => {
  expect(seen.answer.kind).toBe("known");
  if (seen.answer.kind !== "known") return;
  const carries = seen.answer.people.filter((p) => p.kind === "carry");
  expect(seen.carried).toEqual(
    carries.map((p) => ({ actorId: p.actorId, judgement: p.eventId })),
  );
  expect(seen.later).toBe(
    seen.answer.people.some((p) => p.kind === "withheld"),
  );
  for (const unit of seen.decided)
    for (const actorId of unit.decidedBy)
      expect(carries.map((p) => p.actorId)).toContain(actorId);
};

// B6, ordering 1: an approval on A, then on cycle 1, then A's withdrawn. The last act is the
// withdrawal: nothing carries, and no unit names the person (a change of rule, toward asking).
test("B6 ordering 1: the readers agree, and nothing carries after the withdrawal", async () => {
  const r = review();
  const seen = await r.s.run(
    Effect.gen(function* () {
      const first = yield* r.cycle;
      const onA = yield* r.cycle;
      const onAgain = yield* approve(onA);
      yield* approve(first);
      yield* retract(onAgain.dispositionId);
      return yield* agreement(r, "b");
    }),
  );
  expectAgreement(seen);
  expect(seen.carried).toEqual([]);
  expect(seen.decided.flatMap((u) => u.decidedBy)).toEqual([]);
  expect(seen.closed).toBe(false);
}, 60_000);

// B6, ordering 2: carried to A; a request replaces the original on cycle 1; A's copy withdrawn.
test("B6 ordering 2: the readers agree, and nothing carries after the withdrawal", async () => {
  const r = review();
  const seen = await r.s.run(
    Effect.gen(function* () {
      const first = yield* r.cycle;
      yield* approve(first);
      const onA = yield* r.cycle;
      yield* askChanges(first);
      yield* retract(copyOn(onA));
      return yield* agreement(r, "b");
    }),
  );
  expectAgreement(seen);
  expect(seen.carried).toEqual([]);
  expect(seen.decided.flatMap((u) => u.decidedBy)).toEqual([]);
  expect(seen.closed).toBe(false);
}, 60_000);

// B6, ordering 3: carried to A and B; an approval replaces B's copy; A's copy withdrawn.
test("B6 ordering 3: the readers agree, and nothing carries after the withdrawal", async () => {
  const r = review();
  const seen = await r.s.run(
    Effect.gen(function* () {
      yield* approve(yield* r.cycle);
      const onA = yield* r.cycle;
      const onB = yield* r.configuration("b");
      yield* approve(onB);
      yield* retract(copyOn(onA));
      return yield* agreement(r, "c");
    }),
  );
  expectAgreement(seen);
  expect(seen.carried).toEqual([]);
  expect(seen.decided.flatMap((u) => u.decidedBy)).toEqual([]);
  expect(seen.closed).toBe(false);
}, 60_000);

// B6, ordering 4: carried to A and B; an approval replaces B's copy; a request replaces A's copy.
test("B6 ordering 4: the readers agree, and the request withholds with the gap", async () => {
  const r = review();
  const seen = await r.s.run(
    Effect.gen(function* () {
      yield* approve(yield* r.cycle);
      const onA = yield* r.cycle;
      const onB = yield* r.configuration("b");
      yield* approve(onB);
      yield* askChanges(onA);
      return yield* agreement(r, "c");
    }),
  );
  expectAgreement(seen);
  expect(seen.answer).toMatchObject({
    kind: "known",
    people: [{ kind: "withheld", actorId: anaId }],
  });
  expect(seen.carried).toEqual([]);
  expect(seen.later).toBe(true);
  expect(seen.decided.flatMap((u) => u.decidedBy)).toEqual([]);
  expect(seen.closed).toBe(false);
}, 60_000);

// The acts-read bound (it replaces the connected-units bound with the lineage walk), lowered for
// the test: the person approves `src/a.ts`'s unit, then asks for changes on three units of
// `src/t.ts`, which hold none of its changes. Asked of the next cycle's unit of `src/a.ts`, their
// walk reads three acts about other changes before the approval: past a bound of three nothing
// carries for anyone and a gap says so; at a bound of four the approval carries.
test("past the acts-read bound nothing carries and the gap says why", async () => {
  const run = (bound: number) => {
    const r = review();
    const both = (n: number) =>
      Effect.gen(function* () {
        yield* Effect.provideService(
          publishSettled(
            r.s.ctx({
              cycleId: r.cycles[n]!,
              range: r.range(n),
              runKey: "0".repeat(64),
            }),
            inputOf([threeBatches().a, threeCut([["x"], ["y"], ["z"]])], {
              ending: true,
              totals: { batches: 2, sections: 5 },
            }),
          ),
          Lineage.ActsReadMax,
          bound,
        );
        const read = yield* PublishedPackets.readStanding(r.cycles[n]!);
        if (read?.kind !== "packet.published@2") throw new Error("no packet");
        const units = read.batches.flatMap((b) => b.units);
        const holding = (key: string) =>
          units.find((u) => u.sections.some((s) => s.key === key))!;
        return {
          a: holding(A2),
          x: holding(THREE_KEYS.x),
          y: holding(THREE_KEYS.y),
          z: holding(THREE_KEYS.z),
        };
      });
    return r.s.run(
      Effect.gen(function* () {
        for (const n of [0, 1]) {
          const cycleId = mintUlid();
          r.cycles.push(cycleId);
          yield* r.open(cycleId, n);
        }
        const first = yield* both(0);
        yield* approve(first.a);
        for (const unit of [first.x, first.y, first.z]) yield* askChanges(unit);
        const next = yield* both(1);
        const words = (yield* r.gaps).find((g) => g.kind === NOT_READ)?.detail;
        return {
          a: yield* shownWithGaps(r, next.a),
          others: [next.x, next.y, next.z].map((u) =>
            u.carriedDecisions.map((d) => d.payload.verdict),
          ),
          words,
        };
      }),
    );
  };
  const past = await run(3);
  expect(past.a).toEqual({
    carried: [],
    closed: false,
    later: false,
    notRead: true,
  });
  expect(past.others).toEqual([
    ["request-changes"],
    ["request-changes"],
    ["request-changes"],
  ]);
  for (const word of [
    "section",
    "floor",
    "backstop",
    "reading group",
    "impact kind",
    "family",
  ])
    expect(past.words!.toLowerCase()).not.toContain(word);
  const at = await run(4);
  expect(at.a).toEqual({
    carried: [[anaId, "approve"]],
    closed: true,
    later: false,
    notRead: false,
  });
}, 60_000);

// The withheld gap's words are true when the later decision was made in the review of an earlier
// range: cycle 1's original replaced by a request after cycle 3 carried the approval on.
test("the later-decision gap is true for a decision made in the review of an earlier range", async () => {
  const r = review();
  const result = await r.s.run(
    Effect.gen(function* () {
      const first = yield* r.cycle;
      yield* approve(first);
      yield* r.cycle;
      yield* r.cycle;
      yield* askChanges(first);
      const b = yield* shownWithGaps(r, yield* r.configuration("b"));
      const words = (yield* r.gaps).find((g) => g.kind === LATER)?.detail;
      return { b, words };
    }),
  );
  expect(result.b).toEqual(OPEN_GAP);
  expect(result.words).not.toContain("this range");
  expect(result.words).toContain("earlier review");
}, 60_000);

// A change of rule, toward asking: a fresh approval on A after its copy was withdrawn and B
// stands is the person's last act, on a unit C does not compare with: withheld, with the gap.
test("a fresh approval on a unit the next configuration does not compare with is withheld with the gap", async () => {
  const r = review();
  const result = await r.s.run(
    Effect.gen(function* () {
      yield* approve(yield* r.cycle);
      const onA = yield* r.cycle;
      yield* r.configuration("b");
      yield* retract(copyOn(onA));
      yield* approve(onA);
      return {
        c: yield* shownWithGaps(r, yield* r.configuration("c")),
        d: yield* shownWithGaps(r, yield* r.configuration("d")),
      };
    }),
  );
  expect(result.c).toEqual(OPEN_GAP);
  expect(result.d).toEqual(OPEN_GAP);
}, 60_000);

// Controls: what must still carry.
test("two people's approvals carry through four configurations and two more cycles", async () => {
  const r = review();
  const result = await r.s.run(
    Effect.gen(function* () {
      const first = yield* r.cycle;
      yield* approve(first, ana);
      yield* approve(first, ben);
      const seen = [];
      seen.push(yield* shown(yield* r.cycle));
      for (const key of ["b", "c", "d"])
        seen.push(yield* shown(yield* r.configuration(key)));
      seen.push(yield* shown(yield* r.cycle));
      seen.push(yield* shown(yield* r.cycle));
      return seen;
    }),
  );
  const both = [
    [anaId, "approve"],
    [benId, "approve"],
  ].sort();
  expect(result).toHaveLength(6);
  for (const unit of result) {
    expect([...unit.carried].sort()).toEqual(both);
    expect(unit.closed).toBe(true);
  }
}, 90_000);

test("a request for changes with no later act carries with its comment through four configurations and two cycles", async () => {
  const r = review();
  const result = await r.s.run(
    Effect.gen(function* () {
      yield* askChanges(yield* r.cycle);
      const units: Array<Unit> = [yield* r.cycle];
      for (const key of ["b", "c", "d"])
        units.push(yield* r.configuration(key));
      units.push(yield* r.cycle);
      units.push(yield* r.cycle);
      return units.map((unit) => ({
        carried: unit.carriedDecisions.map((d) => [d.actor, d.payload.verdict]),
        comments: unit.comments.filter((c) => c.kind === "comment.carried@1")
          .length,
        restsOn: unit.carriedDecisions[0]?.payload.restsOn.length,
      }));
    }),
  );
  expect(result).toHaveLength(6);
  for (const unit of result)
    expect(unit).toEqual({
      carried: [[anaId, "request-changes"]],
      comments: 1,
      restsOn: 1,
    });
}, 90_000);

test("a fresh approval after a withdrawal, on a unit the next configuration compares with, carries", async () => {
  const r = review();
  const result = await r.s.run(
    Effect.gen(function* () {
      yield* approve(yield* r.cycle);
      const onA = yield* r.cycle;
      yield* retract(copyOn(onA));
      const fresh = yield* approve(onA);
      const onB = yield* r.configuration("b");
      return {
        fresh: fresh.dispositionId,
        judgements: onB.carriedDecisions.map((d) => d.payload.from.judgement),
        closed: (yield* shown(onB)).closed,
      };
    }),
  );
  expect(result.judgements).toEqual([result.fresh]);
  expect(result.closed).toBe(true);
}, 60_000);

// ---------------------------------------------------------------------------------------------
// Round 2: the same change is a section key (B8). A person's acts about a new unit are their acts
// on the connected units that hold at least one of its changes.
// ---------------------------------------------------------------------------------------------

/** A part as a reader sees it: carried decisions, carried comments, closed, its later gap. */
const part = (r: ReturnType<typeof review>, unit: Unit) =>
  Effect.gen(function* () {
    const judged = yield* Dispositions.judge(unit.unitId);
    return {
      carried: unit.carriedDecisions.map((d) => [d.actor, d.payload.verdict]),
      comments: unit.comments.filter((c) => c.kind === "comment.carried@1")
        .length,
      closed: judged.closed,
      standing: (judged.standing?.actorKind ?? null) as string | null,
      later: (yield* r.gapsOn(unit)).includes(LATER),
    };
  });
const ASKED = {
  carried: [[anaId, "request-changes"]],
  comments: 1,
  closed: true,
  standing: "human",
  later: false,
};
const APPROVED = {
  carried: [[anaId, "approve"]],
  comments: 0,
  closed: true,
  standing: "human",
  later: false,
};
const UNDECIDED = {
  carried: [],
  comments: 0,
  closed: false,
  standing: null,
  later: false,
};

// B8's reproduction: cycle 1 holds both changes in one human-required unit; cycle 2 cuts them in
// two, and the person asks for changes on the agentic one and approves the other. Each decision
// is the person's last act on its own change: each carries to its own unit, on every later review.
test("B8: two units an earlier review held as one each carry their own decision", async () => {
  const r = review();
  const result = await r.s.run(
    Effect.gen(function* () {
      yield* r.cycleCut("wide");
      const second = yield* r.cycleCut("split");
      yield* askChanges(second.one);
      yield* approve(second.two);
      const seen = [];
      for (const next of [
        r.cycleCut("split"),
        r.configurationCut("b", "split"),
        r.cycleCut("split"),
      ]) {
        const parts = yield* next;
        seen.push({
          one: yield* part(r, parts.one),
          two: yield* part(r, parts.two),
        });
      }
      return seen;
    }),
  );
  expect(result).toEqual(
    Array.from({ length: 3 }, () => ({ one: ASKED, two: APPROVED })),
  );
}, 60_000);

// B8 inside one cycle: three configurations, the first holding both changes in one unit.
test("B8 in one cycle: after a wide first configuration, each part carries its own decision", async () => {
  const r = review();
  const result = await r.s.run(
    Effect.gen(function* () {
      yield* r.cycleCut("wide");
      const b = yield* r.configurationCut("b", "split");
      yield* askChanges(b.one);
      yield* approve(b.two);
      const c = yield* r.configurationCut("c", "split");
      return { one: yield* part(r, c.one), two: yield* part(r, c.two) };
    }),
  );
  expect(result).toEqual({ one: ASKED, two: APPROVED });
}, 60_000);

// Two human-required units decided apart (an approval of the first, then a request for changes
// on the second), then a review holding both as one unit, then apart again. The rule at each step:
// apart, each part carries its own decision; the wide unit is `changed` from each part (it holds
// a change the part does not), so nothing carries and it stays open, and since round 4 it is asked
// with no unit to carry from: the request on the second part is the person's last act on one of
// its changes, a decision, so it is withheld and the gap says so; apart again, each part is
// unchanged from the wide unit and from its own earlier part, and the acts about it are those on
// units holding its change: its own decision carries, on every later review, with no alternation.
test("decided apart, then held as one unit, then apart again: each part keeps its own decision", async () => {
  const r = review();
  const result = await r.s.run(
    Effect.gen(function* () {
      const first = yield* r.cycleCut("apart");
      yield* approve(first.one);
      yield* askChanges(first.two);
      const seen = [];
      const apart = yield* r.cycleCut("apart");
      seen.push({
        one: yield* part(r, apart.one),
        two: yield* part(r, apart.two),
      });
      const wide = yield* r.configurationCut("b", "wide");
      seen.push({ wide: yield* part(r, wide.one) });
      for (const next of [
        r.configurationCut("c", "apart"),
        r.cycleCut("apart"),
        r.cycleCut("apart"),
      ]) {
        const parts = yield* next;
        seen.push({
          one: yield* part(r, parts.one),
          two: yield* part(r, parts.two),
        });
      }
      return seen;
    }),
  );
  const both = { one: APPROVED, two: ASKED };
  expect(result).toEqual([
    both,
    { wide: { ...UNDECIDED, later: true } },
    both,
    both,
    both,
  ]);
}, 90_000);

// Neuve's second ordering: a wide unit approved, cut in two, the copy on one part withdrawn. The
// withdrawal is on a unit that holds none of the other part's changes: the other part's approval
// carries on the next two reviews; the withdrawn part is asked again.
test("a wide unit approved, cut in two, one part's copy withdrawn: the other part still carries", async () => {
  const r = review();
  const result = await r.s.run(
    Effect.gen(function* () {
      yield* approve((yield* r.cycleCut("wide")).one);
      const second = yield* r.cycleCut("apart");
      yield* retract(copyOn(second.one));
      const seen = [];
      for (const next of [
        r.cycleCut("apart"),
        r.configurationCut("b", "apart"),
      ]) {
        const parts = yield* next;
        seen.push({
          one: yield* part(r, parts.one),
          two: yield* part(r, parts.two),
        });
      }
      return seen;
    }),
  );
  expect(result).toEqual([
    { one: UNDECIDED, two: APPROVED },
    { one: UNDECIDED, two: APPROVED },
  ]);
}, 60_000);

// Controls, passing before and after.
test("one approval of a wide unit, then cut in two with no later act, carries to both parts", async () => {
  const r = review();
  const result = await r.s.run(
    Effect.gen(function* () {
      yield* approve((yield* r.cycleCut("wide")).one);
      const seen = [];
      for (const next of [r.cycleCut("apart"), r.cycleCut("apart")]) {
        const parts = yield* next;
        seen.push({
          one: yield* part(r, parts.one),
          two: yield* part(r, parts.two),
        });
      }
      return seen;
    }),
  );
  expect(result).toEqual([
    { one: APPROVED, two: APPROVED },
    { one: APPROVED, two: APPROVED },
  ]);
}, 60_000);

test("the same decisions with no wider unit anywhere carry through three reviews", async () => {
  const r = review();
  const result = await r.s.run(
    Effect.gen(function* () {
      const first = yield* r.cycleCut("apart");
      yield* approve(first.one);
      yield* askChanges(first.two);
      const seen = [];
      for (const next of [
        r.cycleCut("apart"),
        r.configurationCut("b", "apart"),
        r.cycleCut("apart"),
      ]) {
        const parts = yield* next;
        seen.push({
          one: yield* part(r, parts.one),
          two: yield* part(r, parts.two),
        });
      }
      return seen;
    }),
  );
  expect(result).toEqual(
    Array.from({ length: 3 }, () => ({ one: APPROVED, two: ASKED })),
  );
}, 90_000);

// A connected unit whose sections cannot be read (here an older-shape unit, recorded with ranges
// and no sections, that lineage names unchanged from the approved part) keeps its acts: not
// knowing its changes keeps them. A later withdrawal there still stops the carry.
test("a connected unit whose sections cannot be read keeps its acts", async () => {
  const r = review();
  const result = await r.s.run(
    Effect.gen(function* () {
      const first = yield* r.cycleCut("apart");
      yield* approve(first.two);
      const cycleId = r.cycles[0]!;
      const batchId = mintUlid();
      const older = mintUlid();
      const opener = sha256Hex("opener");
      const at = new Date().toISOString();
      yield* Log.append([
        {
          id: mintUlid(),
          kind: "batch.recorded@1",
          idempotencyKey: `test:batch:${batchId}`,
          actor: opener,
          occurredAt: at,
          attribution: { cycleId, batchId },
          payload: { title: "Older", focus: "Older shape" },
        },
        {
          id: mintUlid(),
          kind: "unit.recorded@1",
          idempotencyKey: `test:unit:${older}`,
          actor: opener,
          occurredAt: at,
          attribution: { cycleId, batchId, unitIds: [older] },
          payload: {
            title: "Older shape",
            ownedRanges: [{ path: "src/a.ts", startLine: 31, endLine: 33 }],
          },
        },
        {
          id: mintUlid(),
          kind: "lineage.recorded@1",
          idempotencyKey: `test:lineage:${older}`,
          actor: opener,
          occurredAt: at,
          attribution: { cycleId, unitIds: [older, first.two.unitId] },
          payload: {
            from: [
              {
                unitId: first.two.unitId,
                cycleId,
                relation: "unchanged",
                unchanged: 1,
                changed: 0,
                lane: "human-required",
              },
            ],
          },
        },
      ]);
      const onOlder = yield* HumanCommands.recordDisposition({
        person: ana,
        unitId: older,
        verdict: "approve",
      });
      yield* retract(onOlder.dispositionId);
      const next = yield* r.cycleCut("apart");
      return { two: yield* part(r, next.two) };
    }),
  );
  expect(result.two).toEqual(UNDECIDED);
}, 60_000);

// R1: a carried copy enters the store only with its unit's lineage. The batch's whole append is
// refused (another event already holds the lineage event's ID), so the publisher falls back to
// appending one event at a time; the lineage is refused, and neither the carried request for
// changes nor the comment it rests on may enter without it. Each refusal is disclosed.
test("a carried copy is never saved without its unit's lineage", async () => {
  const r = review();
  const T = Date.now() + 1_000;
  const runId = mintUlid();
  const startedAt = Date.now();
  const { a } = threeBatches();
  const second = () =>
    r.s.ctx({
      cycleId: r.cycles[1]!,
      range: r.range(1),
      runKey: "a".repeat(64),
      runId,
      startedAt,
    });
  await r.s.run(
    Effect.gen(function* () {
      yield* askChanges(yield* r.cycle);
      const cycleId = mintUlid();
      r.cycles.push(cycleId);
      yield* r.open(cycleId, 1);
      yield* Effect.exit(
        atTime(T)(
          publishSettledForTest(
            second(),
            inputOf([a], { ending: true, totals: ONE }),
            "plan",
          ),
        ),
      );
    }),
  );
  // The same plan written on a copy of the store names the lineage event's ID.
  const twin = r.s.copy();
  const lineageId = await twin.run(
    Effect.gen(function* () {
      yield* atTime(T + 10)(
        publishSettled(
          twin.ctx({
            cycleId: r.cycles[1]!,
            range: r.range(1),
            runKey: "a".repeat(64),
            runId,
            startedAt,
          }),
          inputOf([a], { ending: true, totals: ONE }),
        ),
      );
      const read = yield* PublishedPackets.readStanding(r.cycles[1]!);
      if (read?.kind !== "packet.published@2") throw new Error("no packet");
      const unit = read.batches[0]!.units.find(
        (u) => u.carriedDecisions.length > 0,
      )!;
      return unit.lineage!.id;
    }),
  );
  const result = await r.s.run(
    Effect.gen(function* () {
      yield* Log.append([
        {
          id: lineageId,
          kind: "cycle.opened@1",
          idempotencyKey: "test:holds-the-lineage-id",
          actor: sha256Hex("opener"),
          occurredAt: new Date().toISOString(),
          attribution: { cycleId: mintUlid(), range: r.range(9) },
          payload: {},
        },
      ]);
      yield* atTime(T + 10)(
        publishSettled(second(), inputOf([a], { ending: true, totals: ONE })),
      );
      const sql = yield* SqlClient;
      const copies = yield* sql<{
        unitId: string;
      }>`SELECT json_extract(envelope, '$.attribution.unitIds[0]') AS unit_id FROM events
        WHERE kind = 'disposition.carried@1'`;
      const comments = yield* sql<{
        unitId: string;
      }>`SELECT json_extract(envelope, '$.attribution.unitIds[0]') AS unit_id FROM events
        WHERE kind = 'comment.carried@1'`;
      const lineages = yield* sql<{
        unitId: string;
      }>`SELECT json_extract(envelope, '$.attribution.unitIds[0]') AS unit_id FROM events
        WHERE kind = 'lineage.recorded@1'`;
      const linked = new Set(lineages.map((row) => row.unitId));
      const gaps = (yield* r.gaps).map((g) => g.kind);
      return {
        unlinked: [...copies, ...comments].filter(
          (row) => !linked.has(row.unitId),
        ).length,
        copies: copies.length,
        comments: comments.length,
        refused: gaps.filter((kind) => kind === "publish-refused").length,
      };
    }),
  );
  expect(result.unlinked).toBe(0);
  expect(result.copies).toBe(0);
  expect(result.comments).toBe(0);
  // The lineage, the carried request and the carried comment.
  expect(result.refused).toBe(3);
}, 60_000);

// ---------------------------------------------------------------------------------------------
// Round 3: units that overlap are connected too (R2a). The walk follows every lineage entry that
// counts at least one unchanged change, so a unit of X and Y reaches a unit of Y and Z.
// ---------------------------------------------------------------------------------------------

const WITHHELD = {
  carried: [],
  comments: 0,
  closed: false,
  standing: null,
  later: true,
};

// R2a, first ordering: an approval of X and Y; a unit of Y and Z with a request for changes; X
// and Y again. The request is the last act on a unit holding Y, and X and Y is not unchanged
// from that unit: nothing carries, open, gap; on a third configuration and on cycle 3 too.
test("R2a: a request on an overlapping unit stops an approval of X and Y", async () => {
  const r = review();
  const result = await r.s.run(
    Effect.gen(function* () {
      yield* approve((yield* r.cycleThree([["x", "y"], ["z"]])).x);
      yield* askChanges((yield* r.cycleThree([["x"], ["y", "z"]])).y);
      const seen = [];
      for (const next of [
        r.configurationThree("b", [["x", "y"], ["z"]]),
        r.configurationThree("c", [["x", "y"], ["z"]]),
        r.cycleThree([["x", "y"], ["z"]]),
      ])
        seen.push(yield* part(r, (yield* next).x));
      return seen;
    }),
  );
  expect(result).toEqual([WITHHELD, WITHHELD, WITHHELD]);
}, 90_000);

// R2a, second ordering: X alone and Y-and-Z both approved; X-and-Y and Z alone, with a request
// for changes on X and Y; X alone and Y-and-Z again. X alone is wholly unchanged from the unit of
// X and Y it is compared with, which holds the request: the request carries. Y and Z share Y with
// it and are not unchanged from it: nothing carries, open, gap.
test("R2a: 1+2 approved, 2+1 with a request on the pair, 1+2 again", async () => {
  const r = review();
  const result = await r.s.run(
    Effect.gen(function* () {
      const first = yield* r.cycleThree([["x"], ["y", "z"]]);
      yield* approve(first.x);
      yield* approve(first.y);
      yield* askChanges((yield* r.cycleThree([["x", "y"], ["z"]])).x);
      const again = yield* r.configurationThree("b", [["x"], ["y", "z"]]);
      return { x: yield* part(r, again.x), yz: yield* part(r, again.y) };
    }),
  );
  expect(result).toEqual({ x: ASKED, yz: WITHHELD });
}, 60_000);

// The design's second row: after the ordering above, a unit of Y alone. In a review that compares
// with the unit of Y and Z it is wholly unchanged from it (`compareUnits`: every one of its
// changes is unchanged there), so the request carries; compared with X and Y again instead, it is
// not, and nothing carries, with the gap.
test("a unit of Y alone carries the request only where it is compared with the unit of Y and Z", async () => {
  const run = (compareWithRequest: boolean) => {
    const r = review();
    return r.s.run(
      Effect.gen(function* () {
        yield* approve((yield* r.cycleThree([["x", "y"], ["z"]])).x);
        yield* askChanges((yield* r.cycleThree([["x"], ["y", "z"]])).y);
        if (!compareWithRequest)
          yield* r.configurationThree("b", [["x", "y"], ["z"]]);
        const alone = yield* r.configurationThree("c", [["x"], ["y"], ["z"]]);
        return yield* part(r, alone.y);
      }),
    );
  };
  expect(await run(true)).toEqual(ASKED);
  expect(await run(false)).toEqual(WITHHELD);
}, 60_000);

// Controls, passing before and after.
test("another person's request on an overlapping unit leaves the first person's approval carrying", async () => {
  const r = review();
  const result = await r.s.run(
    Effect.gen(function* () {
      yield* approve((yield* r.cycleThree([["x", "y"], ["z"]])).x, ana);
      yield* askChanges((yield* r.cycleThree([["x"], ["y", "z"]])).y, ben);
      const again = yield* r.configurationThree("b", [["x", "y"], ["z"]]);
      return yield* shown(again.x);
    }),
  );
  expect(result).toEqual({ carried: [[anaId, "approve"]], closed: true });
}, 60_000);

test("a decision on Z alone, connected through an overlap, leaves an approval of X and Y carrying", async () => {
  const r = review();
  const result = await r.s.run(
    Effect.gen(function* () {
      yield* approve((yield* r.cycleThree([["x", "y"], ["z"]])).x);
      yield* r.cycleThree([["x"], ["y", "z"]]);
      yield* askChanges(
        (yield* r.configurationThree("b", [["x", "y"], ["z"]])).z,
      );
      const again = yield* r.configurationThree("c", [["x", "y"], ["z"]]);
      return yield* part(r, again.x);
    }),
  );
  expect(result).toEqual(APPROVED);
}, 60_000);

// The reviewer's probe, as a test: a wide unit of three changes approved; cut 1+2 (both carry);
// a request on the pair; cut 2+1: the single, wholly in the pair, carries the request, and the
// pair sharing one change with it is open with the gap; 1+2: the single the request does not
// touch carries the approval, the pair is open with the gap; the wide unit: open, gap.
test("three changes cut 1+2, then 2+1, then 1+2, then wide, with a request on the pair", async () => {
  const r = review();
  const result = await r.s.run(
    Effect.gen(function* () {
      yield* approve((yield* r.cycleThree([["x", "y", "z"]])).x);
      const a = yield* r.cycleThree([["x"], ["y", "z"]]);
      const first = { x: yield* part(r, a.x), yz: yield* part(r, a.y) };
      yield* askChanges(a.y);
      const b = yield* r.configurationThree("b", [["x", "y"], ["z"]]);
      const second = { xy: yield* part(r, b.x), z: yield* part(r, b.z) };
      const c = yield* r.configurationThree("c", [["x"], ["y", "z"]]);
      const third = { x: yield* part(r, c.x), yz: yield* part(r, c.y) };
      const d = yield* r.configurationThree("d", [["x", "y", "z"]]);
      return { first, second, third, wide: yield* part(r, d.x) };
    }),
  );
  expect(result).toEqual({
    first: { x: APPROVED, yz: APPROVED },
    second: { xy: WITHHELD, z: ASKED },
    third: { x: APPROVED, yz: WITHHELD },
    wide: WITHHELD,
  });
}, 90_000);

// The reviewer's probe, as a test: a unit left out for one new unit and counted for the next.
// The copy on X alone withdrawn: Y-and-Z carries the approval (the withdrawal holds no change of
// it); the wide unit counts it (it holds X): nothing carries; Y-and-Z again carries.
test("a withdrawal left out for one new unit, counted for the next, left out again", async () => {
  const r = review();
  const result = await r.s.run(
    Effect.gen(function* () {
      yield* approve((yield* r.cycleThree([["x", "y", "z"]])).x);
      const a = yield* r.cycleThree([["x"], ["y", "z"]]);
      yield* retract(copyOn(a.x));
      const b = yield* r.configurationThree("b", [["x"], ["y", "z"]]);
      const first = { x: yield* part(r, b.x), yz: yield* part(r, b.y) };
      const c = yield* r.configurationThree("c", [["x", "y", "z"]]);
      const wide = yield* part(r, c.x);
      const d = yield* r.configurationThree("d", [["x"], ["y", "z"]]);
      const last = { x: yield* part(r, d.x), yz: yield* part(r, d.y) };
      return { first, wide, last };
    }),
  );
  expect(result).toEqual({
    first: { x: UNDECIDED, yz: APPROVED },
    wide: UNDECIDED,
    last: { x: UNDECIDED, yz: APPROVED },
  });
}, 90_000);

// ---------------------------------------------------------------------------------------------
// Round 4: a new unit wholly unchanged from no compared unit is asked too, with no unit to carry
// from. A person whose last act on one of its changes is a decision is withheld, and a gap says
// so, in words true whether the unit is open or the review's agent closed it.
// ---------------------------------------------------------------------------------------------

/** A unit's later-decision gap: its sentence, or undefined when none is written on it. */
const laterGapOn = (r: ReturnType<typeof review>, unit: Unit) =>
  Effect.map(
    r.gaps,
    (all) =>
      all.find((g) => g.kind === LATER && g.unitIds?.includes(unit.unitId))
        ?.detail,
  );

// The reproduction: cycle 1 holds a unit of Y and Z, and a person asks for changes on it. Cycle 2
// holds a unit of X and Y, agentic, approved by the review's agent. The unit is wholly unchanged
// from no compared unit; the request is the person's last act on Y: withheld, the gap is written;
// the agent's approval, the unit's lane and what is carried are untouched.
test("a unit unchanged from nothing, approved by the review's agent, says a person's later decision on one of its changes", async () => {
  const r = review();
  const result = await r.s.run(
    Effect.gen(function* () {
      yield* askChanges((yield* r.cycleThree([["y", "z"], ["x"]])).y);
      const second = yield* r.cycleThree([["x", "y"], ["z"]], 0);
      const judged = yield* Dispositions.judge(second.x.unitId);
      return {
        carried: second.x.carriedDecisions.length,
        lane: second.x.assessment?.payload.lane,
        closed: judged.closed,
        standing: judged.standing?.actorKind,
        verdict: judged.standing?.verdict,
        gap: yield* laterGapOn(r, second.x),
      };
    }),
  );
  expect(result).toEqual({
    carried: 0,
    lane: "agentic",
    closed: true,
    standing: "agent",
    verdict: "approve",
    gap: expect.any(String),
  });
  expect(result.gap).toContain("A person's latest decision on a change in");
  expect(result.gap).toContain("It can be made again here.");
  expect(result.gap).not.toContain("decides it again");
}, 60_000);

// The same with a human-required unit of X and Y: open, the gap written.
test("a human-required unit unchanged from nothing is open with the later-decision gap", async () => {
  const r = review();
  const result = await r.s.run(
    Effect.gen(function* () {
      yield* askChanges((yield* r.cycleThree([["y", "z"], ["x"]])).y);
      const second = yield* r.cycleThree([["x", "y"], ["z"]]);
      return yield* part(r, second.x);
    }),
  );
  expect(result).toEqual(WITHHELD);
}, 60_000);

// Controls, passing before and after.
test("a unit sharing a change whose only act by a person was withdrawn gets no gap", async () => {
  const r = review();
  const result = await r.s.run(
    Effect.gen(function* () {
      const first = yield* r.cycleThree([["y", "z"], ["x"]]);
      const asked = yield* askChanges(first.y);
      yield* retract(asked.dispositionId);
      const second = yield* r.cycleThree([["x", "y"], ["z"]]);
      return yield* part(r, second.x);
    }),
  );
  expect(result).toEqual(UNDECIDED);
}, 60_000);

test("a unit sharing no change with any decided unit gets no gap", async () => {
  const r = review();
  const result = await r.s.run(
    Effect.gen(function* () {
      const first = yield* r.cycleThree([["x"], ["y"], ["z"]]);
      yield* askChanges(first.z);
      const second = yield* r.cycleThree([["x", "y"], ["z"]]);
      return { xy: yield* part(r, second.x), z: yield* part(r, second.z) };
    }),
  );
  expect(result).toEqual({ xy: UNDECIDED, z: ASKED });
}, 60_000);

test("another person's decision on an overlapping unit is counted in the gap, not carried", async () => {
  const r = review();
  const result = await r.s.run(
    Effect.gen(function* () {
      yield* approve((yield* r.cycleThree([["x", "y"], ["z"]])).x, ana);
      yield* askChanges((yield* r.cycleThree([["x"], ["y", "z"]])).y, ben);
      const again = yield* r.configurationThree("b", [["x", "y"], ["z"]]);
      return {
        shown: yield* shown(again.x),
        gap: yield* laterGapOn(r, again.x),
      };
    }),
  );
  expect(result.shown).toEqual({
    carried: [[anaId, "approve"]],
    closed: true,
  });
  expect(result.gap).toStartWith("A person's latest decision on a change in");
}, 60_000);

// ---------------------------------------------------------------------------------------------
// Round 5: the late review (R2b). A review of an earlier range published after a later range's
// only review: no lineage entry joins their units. A person's acts about a new unit are those on
// every unit in the store that holds one of its changes, joined by lineage or not.
// ---------------------------------------------------------------------------------------------

/**
 * Opens `count` cycles of the review, oldest first, publishing none. `publishOn(n)` then publishes
 * the first configuration of the nth (`src/a.ts`, its human-required unit returned) and
 * `publishThreeOn(n, groups)` the three changes cut as `groups`, in any order: an earlier range's
 * review published after a later range's.
 */
const opened = (r: ReturnType<typeof review>, count: number) =>
  Effect.gen(function* () {
    const start = r.cycles.length;
    for (let n = 0; n < count; n++) {
      const cycleId = mintUlid();
      r.cycles.push(cycleId);
      yield* r.open(cycleId, start + n);
    }
    const standing = (n: number) =>
      Effect.gen(function* () {
        const read = yield* PublishedPackets.readStanding(r.cycles[n]!);
        if (read?.kind !== "packet.published@2") throw new Error("no packet");
        return read.batches.flatMap((b) => b.units);
      });
    const publishOn = (n: number) =>
      Effect.gen(function* () {
        const { a } = threeBatches();
        yield* publishSettled(
          r.s.ctx({
            cycleId: r.cycles[n]!,
            range: r.range(n),
            runKey: "0".repeat(64),
          }),
          inputOf([a], { ending: true, totals: ONE }),
        );
        return (yield* standing(n)).find(
          (u) => u.assessment?.payload.lane === "human-required",
        )!;
      });
    const publishThreeOn = (
      n: number,
      groups: ReadonlyArray<ReadonlyArray<Change>>,
    ) =>
      Effect.gen(function* () {
        yield* publishSettled(
          r.s.ctx({
            cycleId: r.cycles[n]!,
            range: r.range(n),
            runKey: "0".repeat(64),
          }),
          inputOf([threeCut(groups)], { ending: true, totals: THREE }),
        );
        const units = yield* standing(n);
        const holding = (key: string) =>
          units.find((u) => u.sections.some((s) => s.key === key))!;
        return {
          x: holding(THREE_KEYS.x),
          y: holding(THREE_KEYS.y),
          z: holding(THREE_KEYS.z),
        } satisfies Held;
      });
    return { publishOn, publishThreeOn };
  });

/** The units `unit`'s lineage names: empty when no lineage entry joins it to an earlier unit. */
const joinedTo = (unit: Unit) =>
  (unit.lineage?.payload.from ?? []).map((entry) => entry.unitId);

// The reviewer's reproduction: cycle 2 publishes first, then cycle 1; the person approves cycle
// 2's unit, then asks for changes on cycle 1's. Cycle 3 is wholly unchanged from cycle 2's unit.
// The request is the person's last act about the change, and no compared unit holds it: nothing
// carries, the unit stays open, and the gap says a person decides again.
test("the late review: a request on the earlier range's unit after an approval of the later one's stops the carry", async () => {
  const r = review();
  const result = await r.s.run(
    Effect.gen(function* () {
      const { publishOn } = yield* opened(r, 2);
      const later = yield* publishOn(1);
      const late = yield* publishOn(0);
      yield* approve(later);
      yield* askChanges(late);
      const third = yield* r.cycle;
      return {
        joined: [...joinedTo(later), ...joinedTo(late)],
        from: joinedTo(third),
        later: later.unitId,
        third: yield* shownWithGaps(r, third),
        again: yield* shownWithGaps(r, yield* r.configuration("b")),
      };
    }),
  );
  expect(result.joined).toEqual([]);
  expect(result.from).toEqual([result.later]);
  expect(result.third).toEqual(OPEN_GAP);
  expect(result.again).toEqual(OPEN_GAP);
}, 60_000);

// The mirror: a request on cycle 2's unit, then an approval of cycle 1's as the last act. Cycle 3
// compares with cycle 2's unit, which holds neither the approval nor a copy of it: by the rule (a
// decision carries only from a compared unit that holds it) the approval is withheld, the request
// is not carried either (never an older decision), and the gap is written.
test("the late review's mirror: an approval of the earlier range's unit as the last act is withheld with the gap", async () => {
  const r = review();
  const result = await r.s.run(
    Effect.gen(function* () {
      const { publishOn } = yield* opened(r, 2);
      const later = yield* publishOn(1);
      const late = yield* publishOn(0);
      yield* askChanges(later);
      yield* approve(late);
      return yield* shownWithGaps(r, yield* r.cycle);
    }),
  );
  expect(result).toEqual(OPEN_GAP);
}, 60_000);

// Three cycles published newest first, so no lineage entry joins any two of their units. The
// person approves the newest's unit, asks for changes on the middle one's, then on the oldest's:
// that request is the last act, and the next cycle (compared with the newest) carries nothing,
// with the gap. When the person then withdraws it, the withdrawal is the last act: nothing
// carries and no gap is written; the middle request, older, is not a fallback.
test("three late reviews joined by no lineage: the last act on the oldest decides, a withdrawal brings nothing", async () => {
  const run = (withdraw: boolean) => {
    const r = review();
    return r.s.run(
      Effect.gen(function* () {
        const { publishOn } = yield* opened(r, 3);
        const newest = yield* publishOn(2);
        const middle = yield* publishOn(1);
        const oldest = yield* publishOn(0);
        yield* approve(newest);
        yield* askChanges(middle);
        const asked = yield* askChanges(oldest);
        if (withdraw) yield* retract(asked.dispositionId);
        const next = yield* r.cycle;
        return {
          joined: [newest, middle, oldest].flatMap(joinedTo),
          from: joinedTo(next),
          newest: newest.unitId,
          next: yield* shownWithGaps(r, next),
        };
      }),
    );
  };
  const asked = await run(false);
  expect(asked.joined).toEqual([]);
  expect(asked.from).toEqual([asked.newest]);
  expect(asked.next).toEqual(OPEN_GAP);
  const withdrawn = await run(true);
  expect(withdrawn.joined).toEqual([]);
  expect(withdrawn.from).toEqual([withdrawn.newest]);
  expect(withdrawn.next).toEqual(OPEN_NO_GAP);
}, 90_000);

// An act on a late unit that holds none of the new unit's changes is passed over: a request on the
// late review's unit of Z leaves the approval of X and Y carrying to the next cycle's unit of X and
// Y. It is the last act about Z, which no compared unit holds: Z is withheld, with the gap.
test("the late review: a request on a unit sharing no change leaves the approval carrying", async () => {
  const r = review();
  const result = await r.s.run(
    Effect.gen(function* () {
      const { publishThreeOn } = yield* opened(r, 2);
      const later = yield* publishThreeOn(1, [["x", "y"], ["z"]]);
      const late = yield* publishThreeOn(0, [["x", "y"], ["z"]]);
      yield* approve(later.x);
      yield* askChanges(late.z);
      const next = yield* r.cycleThree([["x", "y"], ["z"]]);
      return { xy: yield* part(r, next.x), z: yield* part(r, next.z) };
    }),
  );
  expect(result).toEqual({ xy: APPROVED, z: WITHHELD });
}, 60_000);
