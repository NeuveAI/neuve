// Why (NEU-148): the sections shape decides a unit's lane per section (lane rule 3), and the lanes
// eval's claim is that every stored lane is the harness's rule recomputed from the record. A trail
// that differs in any step, a unit lane its sections do not apply, a line two sections own or a
// not-decided count that disagrees would each let the eval measure a harness that never ran, so
// each is refused. A section no agent decided must count as human-required under the cause the run
// names (an open set), never be dropped. The per-line readers (key transfer, the owner's guard,
// the replay measures) must read the new shape through the unit's owned ranges and lane with the
// same results as today's shape on the same lines, and two runs of different shapes are rated on
// per-line measures only. The fixture follows `records-show-shape.md`; `recordedLane` is a stand-in
// through the one seam, since the harness's rule 3 is not on this branch.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { packetTarget } from "../src/harness-compare/full-test/key-transfer.ts";
import { replayTransfer } from "../src/harness-compare/full-test/key-transfer.ts";
import {
  candidateRule,
  candidatesFor,
  compareRuns,
  harnessRule,
  identity,
  NO_RECORDED_LANE,
  ownerRunUnits,
  recompute,
  recordedUnits,
  sectionsReport,
  shapeOf,
  describeSections,
  FLOORS_NOT_CHECKED,
  NO_FLOORS_OF,
  useFloorsOf,
  useRecordedLane,
  type FloorsOf,
  type LaneTrail,
  type LoadedCase,
  type LoadedSet,
  type RecordedLane,
} from "../src/harness-compare/full-test/lanes-eval.ts";
import {
  deskCalls,
  laneMeasures,
  type LaneCall,
} from "../src/harness-compare/full-test/lanes.ts";
import { readAfterMerge } from "../src/harness-compare/full-test/lanes-replay.ts";
import {
  isSectionsShape,
  packetBatches,
  packetUnits,
  READS_SECTIONS,
  readablePacket,
  UnreadableRun,
  unreadableParts,
  type PacketLite,
} from "../src/harness-compare/full-test/packets.ts";

type Range = {
  kind: "lines";
  path: string;
  side: "old" | "new";
  startLine: number;
  endLine: number;
};
const lines = (
  path: string,
  side: "old" | "new",
  startLine: number,
  endLine: number,
): Range => ({ kind: "lines", path, side, startLine, endLine });

/** As `newShapeReview` writes owned ranges: one line each, every other range on the old side. */
const alternating = (path: string, from: number, count: number) =>
  Array.from({ length: count }, (_, index) =>
    lines(
      path,
      index % 2 === 0 ? "new" : "old",
      from + index * 2,
      from + index * 2,
    ),
  );

const hex = (seed: string) => seed.padEnd(64, "0").slice(0, 64);
const [k1, k2, k3] = [hex("a1"), hex("b2"), hex("c3")];

/**
 * Floor inputs as the readers lane stores them (`decide.ts` `floorInputs`), and what the floor rule
 * gives for each, by the facts object: the floors stand-in reads this, never the rule itself.
 */
const floorsGiven = new WeakMap<
  object,
  ReadonlyArray<{ rule: string; to: string }>
>();
const floorInputs = (
  facts: {
    removesDeclaration: boolean;
    removesPublicName: boolean;
    effects: ReadonlyArray<string>;
  },
  options: Record<string, unknown>,
  gives: ReadonlyArray<{ rule: string; to: string }>,
) => {
  floorsGiven.set(facts, gives);
  return { facts, options };
};
const noFloors = () =>
  floorInputs(
    { removesDeclaration: false, removesPublicName: false, effects: [] },
    {},
    [],
  );

/** A section's judgement as `newShapeReview` writes it (`assessed`), joined to its blob entry. */
const assessedSection = (
  blobEntry: Record<string, unknown>,
  high: boolean,
  lane: Record<string, unknown>,
  inputs: ReturnType<typeof floorInputs> = noFloors(),
) => ({
  ...blobEntry,
  facts: { changed: 3 },
  floorInputs: inputs,
  assess: {
    complexity: {
      level: high ? "high" : "low",
      factors: [
        {
          factor: "connections",
          finding: "Twelve callers.",
          cites: ["p1.e3"],
          uncited: false,
        },
      ],
    },
    easeOfValidation: {
      level: "easy",
      requirements: [
        {
          requirement: "The change keeps retrying.",
          cites: ["p1.e4"],
          coverage: "solid",
          proof: ["01PROOF"],
          kinds: ["test-run", "log"],
          agree: true,
          testable: true,
          anchors: [
            { path: "src/large.ts", side: "new", startLine: 3, endLine: 5 },
          ],
          sources: [],
          proofState: "proven",
          proofNote: "As the rule saw it.",
        },
      ],
    },
    movement: [],
    lean: null,
    gaps: high
      ? [
          {
            axis: "ease-of-validation",
            kind: "scope-missing",
            detail: "Not fetched.",
          },
        ]
      : [],
  },
  review: { verdict: "approve" },
  lane,
  lineage: "fresh",
  impact: high
    ? [{ effect: "narrowed", text: "Retries stop sooner.", cites: [] }]
    : [],
  verdict: "approve",
  restsOn: [],
});

type Section = ReturnType<typeof assessedSection> & {
  key: string;
  ownedRanges: ReadonlyArray<Range>;
  lane: LaneTrail;
  undecided?: { cause: string; reading: string };
};

const blobSection = (
  key: string,
  parts: Record<string, unknown>,
  ownedRanges: ReadonlyArray<Range>,
  title: string,
  where: unknown = null,
  renamedFrom: string | null = null,
) => ({ key, parts, where, renamedFrom, title, ownedRanges });

/** The large unit's two sections and the small unit's one, as `review show --json` prints them. */
const sectionsOf = () => {
  const retry = assessedSection(
    blobSection(
      k1,
      { path: "src/large.ts", kind: "function", name: "retry", future: "kept" },
      alternating("src/large.ts", 1, 600),
      "The retry loop",
      { startLine: 1, endLine: 1_300 },
    ),
    true,
    {
      judged: "human-suggested",
      surfaced: "human-suggested",
      floors: [],
      applied: "human-suggested",
    },
  ) as unknown as Section;
  const entry = assessedSection(
    blobSection(
      k2,
      { path: "src/large.ts", kind: "function", name: "export" },
      alternating("src/large.ts", 1_401, 500),
      "The exported entry point",
      { startLine: 1_400, endLine: 2_500 },
      "src/old-large.ts",
    ),
    false,
    // As the readers lane's real `recordedLane` and `floorsOf` give it (low, easy, every
    // requirement solid; it removes a declaration, with the removal floor on): static automation,
    // raised by the removal floor to human-suggested.
    {
      judged: "static-automation",
      surfaced: "static-automation",
      floors: [{ rule: "removal", to: "human-suggested" }],
      applied: "human-suggested",
    },
    floorInputs(
      { removesDeclaration: true, removesPublicName: false, effects: [] },
      { removal: true },
      [{ rule: "removal", to: "human-suggested" }],
    ),
  ) as unknown as Section;
  const guard = {
    ...blobSection(
      k3,
      { path: "src/small.ts", kind: "block", name: null },
      [lines("src/small.ts", "new", 4, 6)],
      "A guard",
    ),
    assess: null,
    review: null,
    lane: {
      judged: null,
      surfaced: null,
      floors: [],
      applied: "human-required",
    },
    undecided: { cause: "failed", reading: "assess" },
    lineage: "fresh",
    floorInputs: noFloors(),
  } as unknown as Section;
  return { retry, entry, guard };
};

/** A unit of the sections shape as `review show --json` prints it (`codex/neu148-records-cli` 6eb58dc2). */
const newUnit = (
  id: string,
  local: string,
  title: string,
  lane: string,
  sections: ReadonlyArray<Section>,
  extra: { undecided?: Record<string, number>; raised?: number } & Record<
    string,
    unknown
  > = {},
) => {
  const counted: Record<string, number> = {};
  for (const s of sections)
    if (s.undecided !== undefined)
      counted[s.undecided.cause] = (counted[s.undecided.cause] ?? 0) + 1;
  const { undecided, raised, ...rest } = extra;
  // Raised as the publisher counts it: judged, and applied at another lane.
  const floored = sections.filter(
    (s) =>
      s.lane !== undefined &&
      s.lane.judged !== null &&
      s.lane.judged !== s.lane.applied,
  ).length;
  return {
    local,
    unitId: id,
    recorded: {
      kind: "unit.recorded@3",
      id: `r-${id}`,
      payload: {
        title,
        titleBy: "code",
        path: sections[0]!.ownedRanges[0]!.path,
        key: hex("e9"),
        sections: { count: sections.length },
        ranges: {
          count: sections.reduce((n, s) => n + s.ownedRanges.length, 0),
          lines: sections.reduce((n, s) => n + s.ownedRanges.length, 0),
        },
        ownedRanges: sections.flatMap((s) => s.ownedRanges),
      },
    },
    assessment: {
      kind: "assessment.recorded@4",
      id: `a-${id}`,
      payload: {
        lane,
        laneRule: 3,
        sections: {
          count: sections.length,
          raised: raised ?? floored,
          undecided: undecided ?? counted,
        },
      },
    },
    checkpoints: [],
    proofCurrency: {},
    content: {},
    sections,
    references: [],
    referenceDetails: {},
    comments: [],
    judgement: { lane, closed: false },
    citations: { cited: [], resolved: 0, unresolved: 0 },
    ...rest,
  };
};

/** The two units of `newShapeReview`: the large one (two sections, an impact finding, a lineage) and the small one. */
const fixture = () => {
  const sections = sectionsOf();
  const large = newUnit(
    "01LARGE",
    "b1.u1",
    "Large file",
    "human-suggested",
    [sections.retry, sections.entry],
    {
      comments: [
        {
          kind: "comment.recorded@3",
          id: "01IMPACT",
          payload: {
            body: "Retries stop sooner.",
            anchor: {
              path: "src/large.ts",
              side: "new",
              startLine: 3,
              endLine: 3,
            },
            finding: {
              kind: "impact",
              effect: "narrowed",
              about: "code",
              evidence: [],
            },
          },
        },
      ],
      lineage: {
        kind: "lineage.recorded@1",
        id: "01LINEAGE",
        payload: {
          from: [
            {
              unitId: "01EARLIER",
              cycleId: "01CYCLE",
              relation: "changed",
              unchanged: 1,
              changed: 2,
              lane: "agentic",
            },
          ],
        },
      },
    },
  );
  const small = newUnit("01SMALL", "b2.u1", "Small file", "human-required", [
    sections.guard,
  ]);
  return { sections, units: [large, small] };
};

/** The second publication's packet: two batches, nested counts, and a gap Records does not hold. */
const packetOf = (
  units: ReadonlyArray<unknown>,
  kind = "packet.published@2",
  undecoded: ReadonlyArray<unknown> = [
    {
      what: "gap 01MISSING",
      ref: "event:01MISSING",
      issue: "not held",
      part: "gap",
    },
  ],
) =>
  ({
    kind,
    eventId: "01PACKET2",
    supersedes: "01PACKET1",
    requestedPacket: "01PACKET2",
    manifest: hex("f0"),
    complete: true,
    ordinal: 2,
    counts: {
      batches: units.length,
      units: units.length,
      sections: (
        units as ReadonlyArray<{ sections: ReadonlyArray<Section> }>
      ).reduce((n, u) => n + (u.sections?.length ?? 0), 0),
      contextReferences: 0,
      assessments: 2,
      deliveries: 1,
      dispositions: 0,
      comments: 1,
      gaps: 3,
      pending: { batches: 0, sections: 0 },
      undecided: Object.fromEntries([
        ...(units as ReadonlyArray<{ sections: ReadonlyArray<Section> }>)
          .flatMap((u) => u.sections ?? [])
          .reduce((m, sec) => {
            if (sec.undecided !== undefined)
              m.set(sec.undecided.cause, (m.get(sec.undecided.cause) ?? 0) + 1);
            return m;
          }, new Map<string, number>()),
      ]),
    },
    added: { batches: 1, units: 1, sections: 1, undecided: { failed: 1 } },
    sequence: { runKey: hex("d4"), ordinal: 2, base: "01PACKET1" },
    unmatched: [],
    gaps: [],
    undecoded,
    batches: units.map((unit, index) => ({
      local: `b${index + 1}`,
      batchId: `01BATCH${index + 1}`,
      recorded: { kind: "batch.recorded@1" },
      key: hex(`b${index}`),
      publishedBy: { runId: "01RUN", ordinal: index + 1 },
      gaps: [],
      units: [unit],
    })),
  }) as unknown as PacketLite;

const hunks = [
  {
    kind: "text",
    path: "src/large.ts",
    newPath: "src/large.ts",
    newStart: 1_401,
    text: "@@ -1400,0 +1401,3 @@\n+export const retry = 1;\n+two\n+three",
  },
];

/** The same lines in today's shape: `unit.recorded@2` and an assessment its rule recomputes. */
const todayUnit = (
  id: string,
  lane: "human-required" | "agentic",
  owned: ReadonlyArray<Range>,
) => ({
  unitId: id,
  local: `b1.${id}`,
  recorded: {
    kind: "unit.recorded@2",
    payload: { title: `title ${id}`, ownedRanges: owned },
  },
  assessment: {
    kind: "assessment.recorded@3",
    payload: {
      lane,
      quadrant: lane === "human-required" ? "high-hard" : "low-easy",
      complexity: {
        level: lane === "human-required" ? "high" : "low",
        factors: [{ cites: [{ ref: "computation:x", entry: "h1" }] }],
      },
      easeOfValidation: {
        level: lane === "human-required" ? "hard" : "easy",
        requirements: [{ cites: [], coverage: "missing", requirement: "r" }],
      },
      movement: [],
      gaps: [],
    },
  },
  content: {},
  references: [],
  comments: [],
});

const todayPacket = (
  units: ReadonlyArray<unknown>,
  undecoded: ReadonlyArray<unknown> = [],
) =>
  ({
    kind: "packet.published@1",
    complete: true,
    gaps: [],
    undecoded,
    batches: [{ batchId: "B1", recorded: { kind: "batch.recorded@1" }, units }],
  }) as unknown as PacketLite;

/** A stand-in for the harness's `recordedLane`: each section's trail by key, and every call kept. */
const standIn = (trails: ReadonlyMap<string, LaneTrail>) => {
  const calls: Array<{ entry: unknown; added: ReadonlyArray<unknown> }> = [];
  const fn: RecordedLane = (entry, added) => {
    calls.push({ entry, added });
    const trail = trails.get(entry.key)!;
    // Like the harness's rule, the floors it is handed come back, unless the table says otherwise.
    return {
      ...trail,
      floors: trail.floors ?? entry.lane.floors,
      quadrant: null,
      note: null,
    } as LaneTrail;
  };
  return { fn, calls };
};

const storedTrails = (
  units: ReadonlyArray<{ sections: ReadonlyArray<Section> }>,
) =>
  new Map<string, LaneTrail>(
    units.flatMap((u) =>
      u.sections.map((s) => {
        const { floors: _floors, ...trail } = s.lane;
        return [s.key, trail as unknown as LaneTrail] as const;
      }),
    ),
  );

let saved: RecordedLane | undefined;
let swapped = false;
const seam = (fn: RecordedLane | undefined) => {
  const was = useRecordedLane(fn);
  if (!swapped) {
    saved = was;
    swapped = true;
  }
};
afterEach(() => {
  if (swapped) useRecordedLane(saved);
  swapped = false;
  useFloorsOf(savedFloors);
});

/** The floors stand-in: what the fixture's floor inputs give, by facts object. */
const floorsStandIn: FloorsOf = (facts) =>
  (floorsGiven.get(facts as object) ?? []) as ReturnType<FloorsOf>;
const savedFloors = useFloorsOf(floorsStandIn);
beforeEach(() => {
  useFloorsOf(floorsStandIn);
});

const RANGE = "aaaaaaaa..bbbbbbbb";
const loaded = (packet: PacketLite, shape: LoadedCase["shape"]): LoadedCase =>
  ({
    meta: {
      caseId: "github:x/y:1",
      source: "t3code",
      number: 1,
      range: RANGE,
      era: "2026",
      split: "development",
      control: null,
    },
    evidence: {
      version: 2,
      caseId: "github:x/y:1",
      source: "t3code",
      era: "2026",
      split: "development",
      family: "f",
      control: null,
      range: RANGE,
      runId: "r",
      labelling: { passes: 2, rule: "majority", kappa: null },
      lines: {
        "src/small.ts:new:4": {
          class: "needs-person",
          strength: "strong",
          concerns: ["c1"],
        },
        "src/large.ts:new:1": {
          class: "needs-person",
          strength: "strong",
          concerns: ["c2"],
        },
        "src/large.ts:new:1401": {
          class: "agent-catchable",
          strength: "strong",
          concerns: ["c3"],
        },
      },
      disputed: 0,
    },
    packet,
    hunks,
    floorPacket: null,
    laneRule: shape === "sections" ? 3 : 1,
    shape,
    consistencyPacket: null,
    isPublicEntry: undefined,
    concerns: new Map(),
    audited: new Map(),
  }) as unknown as LoadedCase;

test("a rule-3 run reads per section: every stored trail recomputes, and the units keep their stored lanes and owned lines", () => {
  const { units } = fixture();
  const { fn, calls } = standIn(storedTrails(units));
  seam(fn);
  const packet = packetOf(units);
  const read = recordedUnits(packet, hunks, undefined, 3, "sections", "case c");
  expect(
    read.map((r) => [
      r.unit.unitId,
      r.recorded?.lane,
      r.recorded?.laneRule,
      r.recorded?.sections,
    ]),
  ).toEqual([
    ["01LARGE", "human-suggested", 3, 2],
    ["01SMALL", "human-required", 3, 1],
  ]);
  // Each entry is passed untouched, with the lines its own new-side ranges add.
  // Each section is read twice: its entry untouched, then with the floors its floor inputs give.
  expect(calls).toHaveLength(6);
  const untouched = calls.filter((c) =>
    units
      .flatMap((u) => u.sections as ReadonlyArray<unknown>)
      .includes(c.entry),
  );
  expect(untouched).toHaveLength(3);
  expect(untouched[1]!.entry).toBe(units[0]!.sections[1]);
  expect(
    untouched.map((c) => c.added.map((a) => (a as { line: number }).line)),
  ).toEqual([[], [1_401], []]);
  const entry = loaded(packet, "sections");
  expect(identity([entry])).toEqual([]);
  const computed = recompute(entry, harnessRule).calls;
  expect(computed.map((c) => [c.unit, c.harness, c.lines.length])).toEqual([
    ["01LARGE", "human-suggested", 1_100],
    ["01SMALL", "human-required", 3],
  ]);
  // The unit's lines are read from its own owned ranges, in today's form.
  expect(computed[1]!.lines).toEqual([
    "src/small.ts:new:4",
    "src/small.ts:new:5",
    "src/small.ts:new:6",
  ]);
  // The review shape is read from the packet's kind; older runs fall back to their stages.
  expect(shapeOf({ packet })).toBe("sections");
  expect(
    shapeOf({
      packet: { kind: "packet.published@1" },
      stages: [{ stage: "link" }],
    }),
  ).toBe("fixed");
  expect(shapeOf({ packet: {}, stages: [] })).toBe("older");
});

test("a stored trail that differs from the recomputed one in judged, surfaced, floors or applied is refused, naming the case, unit and section", () => {
  for (const [field, value] of [
    ["judged", "human-required"],
    ["surfaced", "human-suggested"],
    ["floors", []],
    ["applied", "agentic"],
  ] as const) {
    const { units } = fixture();
    const trails = storedTrails(units);
    trails.set(k2, { ...trails.get(k2)!, [field]: value } as LaneTrail);
    seam(standIn(trails).fn);
    expect(() =>
      recordedUnits(
        packetOf(units),
        hunks,
        undefined,
        3,
        "sections",
        "case github:x/y:1",
      ),
    ).toThrow(
      new RegExp(
        `^case github:x/y:1: the identity check failed: unit 01LARGE's section ${k2} recomputes ${field} `,
      ),
    );
  }
});

test("a unit whose lane a section does not apply, a line two sections own, owned lines that are not the sections' and counts that disagree are each refused", () => {
  seam(standIn(new Map()).fn);
  const refused = (units: ReadonlyArray<unknown>, pattern: RegExp) => {
    const packet = packetOf(units);
    expect(
      unreadableParts(packet, READS_SECTIONS).some((p) => pattern.test(p)),
    ).toBe(true);
    expect(() =>
      recordedUnits(packet, hunks, undefined, 3, "sections", "case c"),
    ).toThrow(UnreadableRun);
  };
  const { retry, entry, guard } = sectionsOf();
  // The unit says human-required; its sections apply human-suggested.
  refused(
    [newUnit("01LARGE", "b1.u1", "t", "human-required", [retry, entry])],
    new RegExp(
      `unit 01LARGE \\(b1\\.u1\\)'s section ${k1} applied human-suggested, but the unit's lane is human-required`,
    ),
  );
  // Two sections owning src/large.ts:new:1.
  const twice = {
    ...entry,
    ownedRanges: [lines("src/large.ts", "new", 1, 1)],
  } as Section;
  refused(
    [newUnit("01LARGE", "b1.u1", "t", "human-suggested", [retry, twice])],
    new RegExp(
      `section ${k2} owns src/large\\.ts:new:1, which section ${k1} owns too`,
    ),
  );
  // The unit owns a line no section owns.
  const unit = newUnit("01SMALL", "b2.u1", "t", "human-required", [guard]);
  (unit.recorded.payload.ownedRanges as Array<Range>).push(
    lines("src/small.ts", "new", 40, 40),
  );
  refused(
    [unit],
    /owned lines are not its sections' lines \(1 only the unit owns, first src\/small\.ts:new:40/,
  );
  // The unit counts a cause its sections do not hold.
  refused(
    [
      newUnit("01SMALL", "b2.u1", "t", "human-required", [guard], {
        undecided: { failed: 1, unsure: 1 },
      }),
    ],
    /counts 1 unsure section\(s\) not decided, but its sections hold 0 unsure/,
  );
  // A section with no lane trail.
  refused(
    [
      newUnit("01SMALL", "b2.u1", "t", "human-required", [
        { ...guard, lane: undefined } as never,
      ]),
    ],
    new RegExp(`section ${k3} holds no key or no lane trail`),
  );
  // Rule 3 is read from `assessment.recorded@4` only, and @4 only under rule 3.
  const rule2 = newUnit("01SMALL", "b2.u1", "t", "human-required", [guard]);
  (rule2.assessment.payload as { laneRule: number }).laneRule = 2;
  refused([rule2], /is assessment\.recorded@4 but declares lane rule 2, not 3/);
  // Rule 4 (the matrix, decision 14.28) is stored in the same shape and read the same way.
  const rule4 = newUnit("01SMALL", "b2.u1", "t", "human-required", [guard]);
  (rule4.assessment.payload as { laneRule: number }).laneRule = 4;
  const rule4Packet = packetOf([rule4]);
  expect(
    unreadableParts(rule4Packet, READS_SECTIONS).filter((p) =>
      /lane rule/.test(p),
    ),
  ).toEqual([]);
  seam(standIn(storedTrails([rule4])).fn);
  expect(() =>
    recordedUnits(rule4Packet, hunks, undefined, 4, "sections", "case c"),
  ).not.toThrow();
  // Rule 5 (decision 14.34) is rule 4 with a Verify-confirmed request for changes moving both
  // axes, stored in the same shape: it reads with no lane-rule problem and keeps its own number,
  // so a rule-5 run is not read back as rule 3.
  const rule5 = newUnit("01SMALL", "b2.u1", "t", "human-required", [guard]);
  (rule5.assessment.payload as { laneRule: number }).laneRule = 5;
  const rule5Packet = packetOf([rule5]);
  expect(
    unreadableParts(rule5Packet, READS_SECTIONS).filter((p) =>
      /lane rule/.test(p),
    ),
  ).toEqual([]);
  seam(standIn(storedTrails([rule5])).fn);
  const read5 = recordedUnits(
    rule5Packet,
    hunks,
    undefined,
    5,
    "sections",
    "case c",
  );
  expect(read5.map((u) => u.recorded?.laneRule)).toEqual([5]);
  // A lane rule the eval has no reader for is still refused.
  const rule6 = newUnit("01SMALL", "b2.u1", "t", "human-required", [guard]);
  (rule6.assessment.payload as { laneRule: number }).laneRule = 6;
  expect(
    unreadableParts(packetOf([rule6]), READS_SECTIONS).some((p) =>
      /declares lane rule 6, which the eval has no reader for/.test(p),
    ),
  ).toBe(true);
});

test("a section no agent decided reads as human-required under the cause the run names, an unknown cause counted, never dropped", () => {
  const { units } = fixture();
  const novel = {
    ...sectionsOf().guard,
    key: hex("d5"),
    ownedRanges: [lines("src/other.ts", "new", 1, 4)],
    undecided: { cause: "a-cause-named-later", reading: "verify" },
  } as Section;
  const all = [
    ...units,
    newUnit("01NOVEL", "b3.u1", "Other file", "human-required", [novel]),
  ];
  seam(standIn(storedTrails(all)).fn);
  const entry = loaded(packetOf(all), "sections");
  expect(
    recompute(entry, harnessRule).calls.find((c) => c.unit === "01NOVEL")
      ?.harness,
  ).toBe("human-required");
  expect(sectionsReport([entry])).toEqual({
    cases: 1,
    units: 3,
    sections: 4,
    undecided: {
      "a-cause-named-later": { sections: 1, lines: 4 },
      failed: { sections: 1, lines: 3 },
    },
    unitsCountUndecided: { "a-cause-named-later": 1, failed: 1 },
    excluded: {},
    raised: { removal: 1 },
    floorsNotChecked: null,
    humanSuggested: {
      withGap: { units: 1, lines: 1_100 },
      withoutGap: { units: 0, lines: 0 },
    },
  });
  // Today's shape reports no sections.
  expect(
    sectionsReport([
      loaded(
        todayPacket([todayUnit("t1", "agentic", [lines("a.ts", "new", 1, 2)])]),
        "older",
      ),
    ]),
  ).toBeNull();
});

test("without the harness's recordedLane, every command that recomputes a rule-3 run stops with one sentence; the paths that need no rule still read it", () => {
  const { units } = fixture();
  seam(undefined);
  const packet = packetOf(units);
  expect(() =>
    recordedUnits(packet, hunks, undefined, 3, "sections", "case c"),
  ).toThrow(NO_RECORDED_LANE);
  expect(() => identity([loaded(packet, "sections")])).toThrow(
    NO_RECORDED_LANE,
  );
  expect(() =>
    ownerRunUnits({ packet, manifest: { hunks } }, "run", "r", harnessRule, {
      repository: ".",
      candidate: false,
      laneRule: 3,
    }),
  ).toThrow(NO_RECORDED_LANE);
  // Ownership and stored lanes need no rule.
  expect(packetTarget(packet).map((t) => t.lines.size)).toEqual([1_100, 3]);
  expect(deskCalls({ packet }, {}, "r").map((c) => c.harness)).toEqual([
    "human-suggested",
    "human-required",
  ]);
});

test("the stated rule and the record agree, and lane candidates are refused on a rule-3 unit", () => {
  const { units } = fixture();
  seam(standIn(storedTrails(units)).fn);
  expect(() =>
    recordedUnits(packetOf(units), hunks, undefined, 2, "sections", "case c"),
  ).toThrow(
    /unit 01LARGE records lane rule 3 \(assessment\.recorded@4\), but the run is read as lane rule 2/,
  );
  const today = todayPacket([
    todayUnit("t1", "agentic", [lines("a.ts", "new", 1, 2)]),
  ]);
  expect(() =>
    recordedUnits(today, hunks, undefined, 3, "older", "case c"),
  ).toThrow(
    /assessment is assessment\.recorded@3, which holds no sections, but the run is read as lane rule 3/,
  );
  const [first] = recordedUnits(
    packetOf(units),
    hunks,
    undefined,
    3,
    "sections",
    "case c",
  );
  expect(() => candidateRule("public-surface-entry")(first!.recorded!)).toThrow(
    /lane candidate public-surface-entry is not defined per section/,
  );
});

test("key transfer and the owner's guard give the same line results on a new-shape run as on the same lines in today's shape", () => {
  const { units, sections } = fixture();
  seam(standIn(storedTrails(units)).fn);
  const fresh = packetOf(units);
  const today = todayPacket([
    todayUnit("t1", "agentic", [
      ...sections.retry.ownedRanges,
      ...sections.entry.ownedRanges,
    ]),
    todayUnit("t2", "human-required", sections.guard.ownedRanges),
  ]);
  // Key transfer reads ownership only.
  expect(packetTarget(fresh).map((t) => [...t.lines])).toEqual(
    packetTarget(today).map((t) => [...t.lines]),
  );
  const asSet = (entry: LoadedCase) =>
    ({
      set: {},
      cases: [entry],
      afterMerge: new Map(),
      kinds: {},
    }) as unknown as LoadedSet;
  const target = packetTarget(today);
  const strip = (rows: ReturnType<typeof replayTransfer>) =>
    rows.map(
      ({
        ranges,
        needsPerson,
        olderLabelledUnits,
        olderOnly,
        olderUnits,
        joining,
      }) => ({
        ranges,
        needsPerson,
        olderLabelledUnits,
        olderOnly,
        olderUnits,
        joining,
      }),
    );
  expect(
    strip(replayTransfer(asSet(loaded(fresh, "sections")), () => target)),
  ).toEqual(strip(replayTransfer(asSet(loaded(today, "older")), () => target)));
  // The owner's guard: one owner key, judged line by line, on each shape's own calls. The owner
  // sends the guarded lines to a person; both shapes keep them there.
  const owner: Array<LaneCall> = [
    {
      unit: "o1",
      title: "o1",
      range: "r",
      harness: "human-required",
      owner: "human-required",
      lines: ["src/small.ts:new:4", "src/small.ts:new:5"],
    },
  ];
  const carried = Object.fromEntries(
    owner.flatMap((c) => c.lines.map((l) => [`r|${l}`, c.owner!])),
  );
  const ownerUnits = owner.map(({ range, unit, title, lines }) => ({
    range,
    unit,
    title,
    lines,
  }));
  const callsOf = (packet: PacketLite, laneRule: 1 | 3) =>
    ownerRunUnits({ packet, manifest: { hunks } }, "run", "r", harnessRule, {
      repository: ".",
      candidate: false,
      laneRule,
    }).calls;
  const freshCalls = callsOf(fresh, 3);
  const todayCalls = callsOf(today, 1);
  expect(freshCalls.map((c) => c.lines)).toEqual(
    todayCalls.map((c) => c.lines),
  );
  const measured = (calls: ReadonlyArray<LaneCall>) => {
    const m = laneMeasures(calls, carried, ownerUnits);
    return { guard: m.guard, lineAgreement: m.lineAgreement };
  };
  expect(measured(freshCalls)).toEqual(measured(todayCalls));
  expect(measured(freshCalls).guard.holds).toBe(true);
});

test("two runs of different shapes are rated on per-line measures only, per-unit ones shown as not comparable", () => {
  const { units, sections } = fixture();
  seam(standIn(storedTrails(units)).fn);
  const today = todayPacket([
    todayUnit("t1", "human-required", sections.retry.ownedRanges),
    todayUnit("t2", "agentic", sections.entry.ownedRanges),
    todayUnit("t3", "human-required", sections.guard.ownedRanges),
  ]);
  const set = (entry: LoadedCase) =>
    ({
      set: {},
      cases: [entry],
      afterMerge: readAfterMerge([]).kinds,
      kinds: {},
    }) as unknown as LoadedSet;
  const result = compareRuns(
    set(loaded(today, "older")),
    set(loaded(packetOf(units), "sections")),
    null,
  );
  expect(result.comparable).toBe(false);
  expect(result.shapes).toEqual({ baseline: "today", candidate: "sections" });
  expect(
    Object.keys(result.comparison["2026 development"]!.keys).sort(),
  ).toEqual([
    "lineAgreement",
    "linesRequired",
    "linesSuggestedOrHigher",
    "overEscalatedLines",
    "threadLinesRequired",
    "threadLinesSuggestedOrHigher",
  ]);
  expect(result.perUnitNotComparable).not.toBeNull();
  expect(result.sections.baseline).toBeNull();
  expect(result.sections.candidate?.undecided).toEqual({
    failed: { sections: 1, lines: 3 },
  });
  // The same shape on both arms is compared as today, per unit.
  const same = compareRuns(
    set(loaded(packetOf(units), "sections")),
    set(loaded(packetOf(units), "sections")),
    null,
  );
  expect(same.comparable).toBe(true);
  expect(same.perUnitNotComparable).toBeNull();
  expect(Object.keys(same.comparison["2026 development"]!.keys)).toContain(
    "threadUnitsRequired",
  );
});

test("an undecoded sections body or judgement leaves a sections-shape run unread; a unit's facts stop and a gap the manifest names do not", () => {
  const { units } = fixture();
  const at = (part: string) =>
    unreadableParts(
      packetOf(units, "packet.published@2", [
        {
          what: `${part} of b1.u1`,
          ref: "computation:x",
          issue: "i",
          part,
          batch: "b1",
          unit: "b1.u1",
          section: k1,
        },
      ]),
      READS_SECTIONS,
    );
  for (const part of ["judgements", "unit-sections", "manifest"])
    expect(at(part)).toEqual([
      expect.stringContaining(
        `could not decode ${part} of b1.u1 (${part}, unit b1.u1, section ${k1})`,
      ),
    ]);
  expect(at("gap")).toEqual([]);
  expect(at("guided")).toEqual([]);
  // `facts` is a unit's Facts delivery stop in the records read model, not a section's data.
  expect(at("facts")).toEqual([]);
  // Today's shape keeps today's list: an undecoded delivery stop of facts still reads, a gap does not.
  const today = (part: string) =>
    unreadableParts(
      todayPacket(
        [todayUnit("t1", "agentic", [lines("a.ts", "new", 1, 2)])],
        [{ what: `${part} of b1.t1`, part, unit: "b1.t1" }],
      ),
      READS_SECTIONS,
    );
  expect(today("facts")).toEqual([]);
  expect(today("gap")).toHaveLength(1);
});

test("every path with no rule-3 reader keeps refusing the sections shape", () => {
  const { units } = fixture();
  const packet = packetOf(units);
  // packetUnits and packetBatches with no reads named, as the measures, sheet, briefings, later
  // fixes, parity and pr-replay readers call them.
  expect(() => packetUnits(packet)).toThrow(UnreadableRun);
  expect(() => packetBatches(packet)).toThrow(
    /the packet is packet\.published@2, which the eval has no reader for here/,
  );
  expect(() => readablePacket(packet, "case c")).toThrow(UnreadableRun);
  expect(() => packetUnits(packet, { reads: READS_SECTIONS })).not.toThrow();
});

test("round 3b: a repeated section key, an unexplained unjudged section, a raised count, the packet's counts and a line two units own are each held to the record", () => {
  seam(standIn(new Map()).fn);
  const refusedBy = (packet: PacketLite, pattern: RegExp) => {
    const problems = unreadableParts(packet, READS_SECTIONS);
    expect({ pattern: String(pattern), problems }).toEqual({
      pattern: String(pattern),
      problems: expect.arrayContaining([expect.stringMatching(pattern)]),
    });
  };
  const { retry, entry, guard } = sectionsOf();
  // The same section listed twice, with the count raised to match.
  refusedBy(
    packetOf([
      newUnit("01LARGE", "b1.u1", "t", "human-suggested", [
        retry,
        entry,
        retry,
      ]),
    ]),
    new RegExp(`section ${k1} is listed twice in the unit`),
  );
  // Two keys for one section's lines would read as a line in two sections; one key twice is the
  // repeated key, refused even when the copy owns other lines.
  const copy = {
    ...retry,
    ownedRanges: [lines("src/large.ts", "new", 4_000, 4_000)],
  } as Section;
  refusedBy(
    packetOf([
      newUnit("01LARGE", "b1.u1", "t", "human-suggested", [retry, entry, copy]),
    ]),
    new RegExp(`section ${k1} is listed twice`),
  );
  // A section with no assessment and no cause it was not decided.
  const silent = { ...guard, undecided: undefined } as unknown as Section;
  refusedBy(
    packetOf([newUnit("01SMALL", "b2.u1", "t", "human-required", [silent])]),
    new RegExp(
      `section ${k3} holds no assessment, no cause it was not decided and no reason it was excluded`,
    ),
  );
  // The unit's raised count against its sections applied at a lane other than the one judged.
  refusedBy(
    packetOf([
      newUnit("01LARGE", "b1.u1", "t", "human-suggested", [retry, entry], {
        raised: 7,
      }),
    ]),
    /counts 7 section\(s\) raised, but 1 of its sections apply a lane other than the one judged/,
  );
  // Raised is counted as the publisher counts it (judged != applied), not by floors: a section
  // assessed, then left undecided and applied human-required with no floor, is raised; a floor that
  // leaves the judged lane as it was raises nothing. Real packets of the second release hold both.
  const leftUndecided = {
    ...retry,
    lane: { ...retry.lane, floors: [], applied: "human-required" },
    undecided: { cause: "failed", reading: "review" },
  } as unknown as Section;
  const asJudged = {
    ...retry,
    lane: {
      judged: "human-required",
      surfaced: "human-required",
      floors: [{ rule: "finding", to: "human-required" }],
      applied: "human-required",
    },
  } as unknown as Section;
  const raisedOf = (sections: ReadonlyArray<Section>, raised: number) =>
    unreadableParts(
      packetOf([
        newUnit("01SMALL", "b2.u1", "t", "human-required", sections, {
          raised,
        }),
      ]),
      READS_SECTIONS,
    ).filter((problem) => problem.includes("raised"));
  // Each alone, so the floors rule (0 for the first, 1 for the second) would be refused both times.
  expect(raisedOf([leftUndecided], 1)).toEqual([]);
  expect(raisedOf([asJudged], 0)).toEqual([]);
  expect(raisedOf([leftUndecided, asJudged], 2)).toEqual([
    expect.stringMatching(
      /counts 2 section\(s\) raised, but 1 of its sections apply a lane other than the one judged/,
    ),
  ]);
  // The unit's section count (the check the round-3 test named but did not exercise).
  const counted = newUnit("01SMALL", "b2.u1", "t", "human-required", [guard]);
  (counted.assessment.payload.sections as { count: number }).count = 2;
  refusedBy(
    packetOf([counted]),
    /assessment counts 2 section\(s\), but it holds 1/,
  );
  // The packet's own counts, where printed, against its units.
  const { units } = fixture();
  const wrongSections = packetOf(units) as unknown as {
    counts: { sections: number };
  };
  wrongSections.counts.sections = 9;
  refusedBy(
    wrongSections as unknown as PacketLite,
    /the packet counts 9 section\(s\), but its units hold 3/,
  );
  const wrongCauses = packetOf(units) as unknown as {
    counts: { undecided: Record<string, number> };
  };
  wrongCauses.counts.undecided = { failed: 1, unsure: 2 };
  refusedBy(
    wrongCauses as unknown as PacketLite,
    /the packet counts 2 unsure section\(s\) not decided, but its units hold 0 unsure/,
  );
  // A line two units own, on the sections shape.
  const other = {
    ...guard,
    key: hex("e5"),
    ownedRanges: [lines("src/large.ts", "new", 1, 1)],
  } as Section;
  refusedBy(
    packetOf([
      ...units,
      newUnit("01OTHER", "b3.u1", "t", "human-required", [other]),
    ]),
    /unit 01OTHER owns src\/large\.ts:new:1, which unit 01LARGE owns too/,
  );
  // Today's shape is left as it is: two units may own one line there.
  expect(
    unreadableParts(
      todayPacket([
        todayUnit("t1", "agentic", [lines("a.ts", "new", 1, 2)]),
        todayUnit("t2", "agentic", [lines("a.ts", "new", 2, 3)]),
      ]),
      READS_SECTIONS,
    ),
  ).toEqual([]);
  // And the fixture as printed reads whole.
  expect(unreadableParts(packetOf(units), READS_SECTIONS)).toEqual([]);
});

test("round 3b: the shape has one authority, the units' records, and the packet's kind must agree with it", () => {
  const { units } = fixture();
  // The sections shape's records under today's packet kind, or with no kind printed, are refused.
  for (const kind of ["packet.published@1", undefined]) {
    const packet = packetOf(units) as unknown as Record<string, unknown>;
    if (kind === undefined) delete packet["kind"];
    else packet["kind"] = kind;
    expect(
      unreadableParts(packet as unknown as PacketLite, READS_SECTIONS),
    ).toContain(
      `the packet holds units of the sections shape (unit.recorded@3 or assessment.recorded@4) but ${kind === undefined ? "prints no kind" : `is ${kind}`}, not packet.published@2`,
    );
  }
  // `shapeOf` reads the same authority: the units, not the kind alone.
  expect(shapeOf({ packet: packetOf(units) })).toBe("sections");
  const todayUnderV2 = packetOf(
    [todayUnit("t1", "agentic", [lines("a.ts", "new", 1, 2)])],
    "packet.published@2",
  );
  expect(shapeOf({ packet: todayUnderV2, stages: [] })).toBe("older");
  expect(isSectionsShape(todayUnderV2)).toBe(false);
});

test("round 3b: the sections reader refuses a record with no kind, and a trail is compared field by field", () => {
  const { units } = fixture();
  const kindless = structuredClone(units);
  delete (kindless[1]!.recorded as { kind?: string }).kind;
  expect(unreadableParts(packetOf(kindless), READS_SECTIONS)).toContainEqual(
    expect.stringContaining(
      "01SMALL (b2.u1)'s record is a record with no kind",
    ),
  );
  // A floor whose keys come in another order is the same floor.
  const trails = storedTrails(units);
  trails.set(k2, {
    ...trails.get(k2)!,
    floors: [{ to: "human-suggested", rule: "removal" } as never],
  });
  seam(standIn(trails).fn);
  expect(() =>
    recordedUnits(packetOf(units), hunks, undefined, 3, "sections", "case c"),
  ).not.toThrow();
});

test("round 3b: naming a lane candidate on a rule-3 set is refused before anything is read, as the CLI calls it", () => {
  const { units } = fixture();
  const set = {
    set: { laneRule: 3 },
    cases: [],
    afterMerge: new Map(),
    kinds: {},
  } as unknown as LoadedSet;
  expect(() => candidatesFor(set, ["public-surface-entry"])).toThrow(
    "--candidate is refused on a lane rule 3 set: lane candidates are not yet defined per section",
  );
  const bySections = {
    set: {},
    cases: [loaded(packetOf(units), "sections")],
    afterMerge: new Map(),
    kinds: {},
  } as unknown as LoadedSet;
  expect(() => candidatesFor(bySections, ["public-surface-entry"])).toThrow(
    /--candidate is refused/,
  );
  expect(candidatesFor(bySections, []).map((c) => c.named)).toEqual([false]);
  expect(
    candidatesFor(
      {
        set: {},
        cases: [],
        afterMerge: new Map(),
        kinds: {},
      } as unknown as LoadedSet,
      ["public-surface-entry"],
    ).map((c) => c.name),
  ).toEqual(["public-surface-entry"]);
});

/** A file no reading reads, as the readers lane writes it (`decide.ts`): human-suggested by the rule. */
const excludedSection = (
  key: string,
  ownedRanges: ReadonlyArray<unknown>,
  reason: string,
) =>
  ({
    ...blobSection(
      key,
      { path: "yarn.lock", kind: "file", name: null },
      ownedRanges as ReadonlyArray<Range>,
      "The lockfile",
    ),
    facts: { changed: 1 },
    assess: null,
    review: null,
    lane: {
      judged: null,
      surfaced: null,
      floors: [],
      applied: "human-suggested",
    },
    excluded: { reason },
    impact: [],
    verdict: null,
    restsOn: [],
    lineage: "fresh",
    floorInputs: noFloors(),
  }) as unknown as Section;

test("round 4: an excluded file reads as human-suggested and is counted under its reason, apart from the backstop; an entry of none or two kinds is refused", () => {
  const { units } = fixture();
  const lock = excludedSection(
    hex("f1"),
    [lines("yarn.lock", "new", 1, 5)],
    "lockfile",
  );
  const later = excludedSection(
    hex("f2"),
    [lines("gen/out.ts", "new", 1, 2)],
    "a-reason-named-later",
  );
  const all = [
    ...units,
    newUnit("01LOCK", "b3.u1", "Lockfile", "human-suggested", [lock]),
    newUnit("01GEN", "b4.u1", "Generated", "human-suggested", [later]),
  ];
  seam(standIn(storedTrails(all)).fn);
  const entry = loaded(packetOf(all), "sections");
  expect(
    recompute(entry, harnessRule)
      .calls.filter((c) => c.unit === "01LOCK" || c.unit === "01GEN")
      .map((c) => c.harness),
  ).toEqual(["human-suggested", "human-suggested"]);
  const report = sectionsReport([entry])!;
  expect(report.excluded).toEqual({
    "a-reason-named-later": { sections: 1, lines: 2 },
    lockfile: { sections: 1, lines: 5 },
  });
  // Not in the backstop: only the undecided section is counted there.
  expect(report.undecided).toEqual({ failed: { sections: 1, lines: 3 } });
  const refused = (section: Section, pattern: RegExp) =>
    expect(
      unreadableParts(
        packetOf([newUnit("01X", "b1.u1", "t", "human-suggested", [section])]),
        READS_SECTIONS,
      ),
    ).toContainEqual(expect.stringMatching(pattern));
  refused(
    { ...lock, excluded: undefined } as unknown as Section,
    /holds no assessment, no cause it was not decided and no reason it was excluded/,
  );
  refused(
    { ...lock, undecided: { cause: "failed", reading: "assess" } } as Section,
    /is excluded but also undecided, which the harness never writes/,
  );
  refused(
    { ...lock, assess: sectionsOf().retry.assess } as Section,
    /is excluded but also assessed, which the harness never writes/,
  );
  refused(
    { ...lock, excluded: { reason: "" } } as unknown as Section,
    /is excluded with no reason/,
  );
});

test("round 4: the stored floors are held to the floors the section's floor inputs give, in both directions", () => {
  const { units } = fixture();
  seam(standIn(storedTrails(units)).fn);
  expect(() =>
    recordedUnits(packetOf(units), hunks, undefined, 3, "sections", "case c"),
  ).not.toThrow();
  // A stored floor the inputs do not give.
  const { units: again } = fixture();
  const stored = again[0]!.sections[1] as unknown as {
    floorInputs: { facts: object };
  };
  floorsGiven.set(stored.floorInputs.facts, []);
  expect(() =>
    recordedUnits(packetOf(again), hunks, undefined, 3, "sections", "case c"),
  ).toThrow(
    new RegExp(
      `^case c: the identity check failed: unit 01LARGE's section ${k2}'s floor inputs give floors \\[\\] where the run stored \\[\\{"rule":"removal","to":"human-suggested"\\}\\]`,
    ),
  );
  // A floor the inputs give that the run does not store.
  const { units: third } = fixture();
  const retry = third[0]!.sections[0] as unknown as {
    floorInputs: { facts: object };
  };
  floorsGiven.set(retry.floorInputs.facts, [
    { rule: "removal", to: "human-required" },
  ]);
  expect(() =>
    recordedUnits(packetOf(third), hunks, undefined, 3, "sections", "case c"),
  ).toThrow(
    new RegExp(
      `unit 01LARGE's section ${k1}'s floor inputs give floors \\[\\{"rule":"removal","to":"human-required"\\}\\] where the run stored \\[\\]`,
    ),
  );
  // Without the harness's floor rule, a run with floor inputs stops with one sentence.
  useFloorsOf(undefined);
  expect(() =>
    recordedUnits(
      packetOf(fixture().units),
      hunks,
      undefined,
      3,
      "sections",
      "case c",
    ),
  ).toThrow(NO_FLOORS_OF);
});

test("each run's floors are judged by the lane rule stored with it: rule 3 keeps the finding floor, rule 4 reads the finding as a move", () => {
  // The harness's floor rule as rule 4 has it: a kept finding gives no floor (the stand-in gives []).
  const withFinding = (laneRule: 3 | 4, storedFinding: boolean) => {
    const { units } = fixture();
    for (const unit of units)
      (unit.assessment.payload as { laneRule: number }).laneRule = laneRule;
    const retry = units[0]!.sections[0] as unknown as {
      floorInputs: { facts: Record<string, unknown> };
      lane: { floors: Array<unknown> };
    };
    // A finder finding Verify kept sits on the retry loop.
    retry.floorInputs.facts["keptFinding"] = true;
    if (storedFinding) {
      // The floor keeps the judged lane (human-suggested), so the unit's raised count is unchanged.
      retry.lane.floors = [{ rule: "finding", to: "human-suggested" }];
    }
    seam(standIn(storedTrails(units)).fn);
    return () =>
      recordedUnits(
        packetOf(units),
        hunks,
        undefined,
        laneRule,
        "sections",
        "case c",
      );
  };
  // A stored rule 3 run whose kept finding raised the floor reads, and its unit stays rule 3.
  const rule3 = withFinding(3, true)();
  expect(
    rule3.find((u) => u.recorded?.unitId === "01LARGE")?.recorded?.laneRule,
  ).toBe(3);
  // A rule 4 run holds no finding floor, so the same kept finding stores none and reads.
  const rule4 = withFinding(4, false)();
  expect(
    rule4.find((u) => u.recorded?.unitId === "01LARGE")?.recorded?.laneRule,
  ).toBe(4);
  // Each the other way round is refused: a rule 4 run storing the finding floor, a rule 3 run missing it.
  expect(withFinding(4, true)).toThrow(
    new RegExp(
      `section ${k1}'s floor inputs give floors \\[\\] where the run stored \\[\\{"rule":"finding","to":"human-suggested"\\}\\]`,
    ),
  );
  expect(withFinding(3, false)).toThrow(
    new RegExp(
      `section ${k1}'s floor inputs give floors \\[\\{"rule":"finding","to":"human-suggested"\\}\\] where the run stored \\[\\]`,
    ),
  );
  // An older harness whose own floor rule still gives the finding floor is not given it twice.
  const facts = withFinding(3, true);
  useFloorsOf((f, o) => [
    ...floorsStandIn(f, o),
    ...((f as { keptFinding?: boolean }).keptFinding === true
      ? [{ rule: "finding", to: "human-suggested" as const }]
      : []),
  ]);
  expect(facts).not.toThrow();
});

test("round 4: a run that prints no floor inputs is reported as not checked, never as checked", () => {
  const { units } = fixture();
  const bare = structuredClone(units);
  for (const unit of bare)
    for (const section of unit.sections)
      delete (section as { floorInputs?: unknown }).floorInputs;
  seam(standIn(storedTrails(bare)).fn);
  useFloorsOf(undefined);
  const entry = loaded(packetOf(bare), "sections");
  // Nothing to hold the floors to, so the floor rule is not needed and the run reads.
  expect(identity([entry])).toEqual([]);
  const report = sectionsReport([entry])!;
  expect(report.floorsNotChecked).toEqual({
    sections: 3,
    note: FLOORS_NOT_CHECKED,
  });
  expect(describeSections("candidate", report).join("\n")).toContain(
    "floors not checked: the run prints no floor inputs (3 section(s))",
  );
  expect(
    sectionsReport([loaded(packetOf(units), "sections")])!.floorsNotChecked,
  ).toBeNull();
});

test("round 4: an unreadable mode-only change, a section owning no line, a unit listed twice and an empty packet of the sections shape", () => {
  const { units } = fixture();
  // A mode-only change: the section owns the file whole, or no line at all; the line checks hold.
  const modeOnly = {
    ...sectionsOf().guard,
    key: hex("a7"),
    ownedRanges: [{ kind: "whole-nontext", path: "bin/run", side: "new" }],
    undecided: { cause: "unreadable", reading: "assess" },
  } as unknown as Section;
  const noLine = {
    ...modeOnly,
    key: hex("a8"),
    ownedRanges: [],
  } as unknown as Section;
  const odd = newUnit("01MODE", "b3.u1", "Mode", "human-required", [
    modeOnly,
    noLine,
  ]);
  (
    odd.recorded.payload as { ownedRanges: ReadonlyArray<unknown> }
  ).ownedRanges = [{ kind: "whole-nontext", path: "bin/run", side: "new" }];
  const withMode = [...units, odd];
  expect(unreadableParts(packetOf(withMode), READS_SECTIONS)).toEqual([]);
  seam(standIn(storedTrails(withMode)).fn);
  expect(
    sectionsReport([loaded(packetOf(withMode), "sections")])!.undecided,
  ).toEqual({
    failed: { sections: 1, lines: 3 },
    unreadable: { sections: 2, lines: 1 },
  });
  // One unit listed twice under one ID.
  expect(
    unreadableParts(packetOf([...units, units[1]!]), READS_SECTIONS),
  ).toContainEqual("unit 01SMALL is listed twice in the packet");
  // A `packet.published@2` with no units yet reads past the gap the read model names for it.
  expect(unreadableParts(packetOf([]), READS_SECTIONS)).toEqual([]);
});
