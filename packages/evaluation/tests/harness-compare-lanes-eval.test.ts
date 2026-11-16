// Why (10.137): the lanes climb tunes the harness on a frozen replay set, offline. Three things would
// quietly corrupt that loop: a set whose files changed under it, or that leaks held-out cases into
// tuning; a recomputed lane that is not the lane the harness placed (then every delta is an artefact
// of the eval, not of the candidate); and a verdict that keeps a candidate on noise, or on a rise in
// over-escalation. The error-analysis set must name the misses a person reads, never reverts.
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  aimJudges,
  compare,
  compareRuns,
  candidateRule,
  flipRateFor,
  pairedInterval,
  describeSideBySide,
  evaluateCandidate,
  requireHunks,
  floorFor,
  freezeEvalSet,
  harnessRule,
  heldOutRead,
  identity,
  loadEvalSet,
  laneInputOf,
  liveRule,
  missesOf,
  noiseFloor,
  overallVerdict,
  ownerRunUnits,
  pinnedConsistency,
  pinnedFloor,
  recompute,
  runConsistency,
  writeEvalSet,
  type LaneRule,
  type LoadedCase,
} from "../src/harness-compare/full-test/lanes-eval.ts";
import { laneMeasures } from "../src/harness-compare/full-test/lanes.ts";

const caseRecord = (number: number, split: string, control: string | null) => ({
  version: 1,
  caseId: `github:example/repo:${number}`,
  source: "t3code",
  provider: "github",
  number,
  title: "t",
  url: "https://example.test/pr/1",
  author: "a",
  createdAt: "2026-01-01T00:00:00Z",
  outcome: "merged",
  family: `f${number}`,
  split,
  era: "2026",
  control,
  selection: { score: 1, reasons: [] },
  firstRevision: null,
  later: null,
  size: null,
  capture: { at: "2026-01-01T00:00:00Z", files: [] },
  clone: null,
  checks: null,
  unavailable: null,
});

const assessment = (
  lane: string,
  quadrant: string,
  overrides: Record<string, unknown> = {},
) => ({
  lane,
  quadrant,
  complexity: {
    level: quadrant.startsWith("high") ? "high" : "low",
    factors: [{ cites: [{ ref: "computation:x", entry: "h1" }] }],
  },
  easeOfValidation: {
    level: quadrant.endsWith("hard") ? "hard" : "easy",
    requirements: [{ cites: [], coverage: "missing", requirement: "it works" }],
  },
  movement: [],
  gaps: [],
  rationale: "r",
  ...overrides,
});

const unit = (
  id: string,
  path: string,
  lines: [number, number],
  recorded: ReturnType<typeof assessment>,
) => ({
  unitId: id,
  recorded: {
    kind: "unit.recorded@2",
    payload: {
      title: `title ${id}`,
      ownedRanges: [
        {
          kind: "lines",
          path,
          side: "new",
          startLine: lines[0],
          endLine: lines[1],
        },
      ],
    },
  },
  assessment: { kind: "assessment.recorded@3", payload: recorded },
});

/** A research tree with one case per entry, a batch file and an audit, in a scratch folder. */
const tree = (
  entries: ReadonlyArray<{
    number: number;
    split: string;
    control?: string | null;
    units: ReadonlyArray<ReturnType<typeof unit>>;
    lines: Record<string, unknown>;
    concerns?: ReadonlyArray<Record<string, unknown>>;
    afterMerge?: Record<string, unknown>;
    verdicts?: ReadonlyArray<Record<string, unknown>>;
  }>,
) => {
  const root = mkdtempSync(join(tmpdir(), "lanes-eval-"));
  for (const entry of entries) {
    const dir = join(root, "cases", "t3code", String(entry.number));
    mkdirSync(join(dir, "labels"), { recursive: true });
    mkdirSync(join(dir, "run"), { recursive: true });
    const record = caseRecord(entry.number, entry.split, entry.control ?? null);
    writeFileSync(join(dir, "case.json"), JSON.stringify(record));
    const range = `${String(entry.number).padStart(8, "a")}..bbbbbbbb`;
    writeFileSync(
      join(dir, "labels", "line-evidence.json"),
      JSON.stringify({
        version: 2,
        caseId: record.caseId,
        source: "t3code",
        era: "2026",
        split: entry.split,
        family: record.family,
        control: entry.control ?? null,
        range,
        runId: "01RUN",
        labelling: { passes: 2, rule: "majority", kappa: 0.8 },
        lines: entry.lines,
        disputed: 0,
      }),
    );
    writeFileSync(
      join(dir, "run", "show.json"),
      JSON.stringify({
        packet: {
          complete: true,
          gaps: [],
          batches: [{ batchId: "b1", units: entry.units }],
        },
      }),
    );
    if (entry.concerns !== undefined)
      writeFileSync(
        join(dir, "labels", "concerns.jsonl"),
        entry.concerns.map((c) => JSON.stringify(c)).join("\n"),
      );
    if (entry.afterMerge !== undefined)
      writeFileSync(
        join(dir, "labels", "aftermerge.json"),
        JSON.stringify({
          version: 1,
          caseId: record.caseId,
          failures: [],
          ...entry.afterMerge,
        }),
      );
    if (entry.verdicts !== undefined) {
      mkdirSync(join(root, "audit", `t3code-${entry.number}`), {
        recursive: true,
      });
      writeFileSync(
        join(root, "audit", `t3code-${entry.number}`, "verdicts.json"),
        JSON.stringify({ items: entry.verdicts }),
      );
    }
  }
  mkdirSync(join(root, "audit"), { recursive: true });
  writeFileSync(
    join(root, "audit", "report.json"),
    JSON.stringify({
      byKind: {
        "needs-person": { accuracy: 0.92, interval: [0.8, 0.98] },
        discussed: { accuracy: 0.5, interval: [0.1, 0.9] },
      },
    }),
  );
  writeFileSync(
    join(root, "batch.json"),
    JSON.stringify({
      cases: entries.map((e) => ({ source: "t3code", number: e.number })),
    }),
  );
  return root;
};

const frozen = (root: string) => {
  const set = freezeEvalSet({
    laneRule: 1,
    name: "t",
    batch: join(root, "batch.json"),
    cases: join(root, "cases"),
    audit: join(root, "audit"),
  });
  return writeEvalSet(set, join(root, "sets"));
};

test("a frozen set pins every file it reads, reads held-out only when asked and once per round, and is never rewritten", () => {
  const root = tree([
    {
      number: 1,
      split: "development",
      units: [unit("u1", "a.ts", [1, 2], assessment("agentic", "low-easy"))],
      lines: {},
    },
    {
      number: 2,
      split: "held-out",
      units: [unit("v1", "b.ts", [1, 1], assessment("agentic", "low-easy"))],
      lines: {},
    },
  ]);
  try {
    const path = frozen(root);
    expect(loadEvalSet(path).cases.map((c) => c.meta.number)).toEqual([1]);
    expect(
      loadEvalSet(path, { heldOut: true }).cases.map((c) => c.meta.number),
    ).toEqual([1, 2]);
    // Under the audit's floor a kind is flagged; above it, not.
    expect(loadEvalSet(path).kinds).toMatchObject({
      "needs-person": { flagged: false },
      discussed: { flagged: true },
    });
    expect(() => frozen(root)).toThrow("never rewritten");
    heldOutRead(path, "r2");
    expect(() => heldOutRead(path, "r2")).toThrow("once per round");
    expect(() => heldOutRead(path, "r3")).not.toThrow();
    // A file that moved after the freeze refuses the set.
    writeFileSync(
      join(root, "cases", "t3code", "1", "run", "show.json"),
      JSON.stringify({ packet: null }),
    );
    expect(() => loadEvalSet(path)).toThrow("changed since the set was frozen");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a batch with a case lacking its evidence or packet is not frozen", () => {
  const root = tree([
    { number: 1, split: "development", units: [], lines: {} },
  ]);
  try {
    rmSync(join(root, "cases", "t3code", "1", "run", "show.json"));
    expect(() => frozen(root)).toThrow("not ready to freeze");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a batch case the replay could not run is left out only by name, with why, and a ready one never is", () => {
  const units = [unit("u1", "a.ts", [1, 2], assessment("agentic", "low-easy"))];
  const root = tree([
    { number: 1, split: "development", units, lines: {} },
    { number: 2, split: "development", units, lines: {} },
  ]);
  try {
    const dir = join(root, "cases", "t3code", "2");
    rmSync(join(dir, "run", "show.json"));
    rmSync(join(dir, "labels", "line-evidence.json"));
    const freeze = (leaveOut: Array<string>) =>
      freezeEvalSet({
        laneRule: 1,
        name: "t",
        batch: join(root, "batch.json"),
        cases: join(root, "cases"),
        leaveOut,
      });
    const set = freeze(["t3code/2=leakage checks failed"]);
    expect(set.cases.map((c) => c.number)).toEqual([1]);
    expect(set.leftOut).toEqual([
      { source: "t3code", number: 2, reason: "leakage checks failed" },
    ]);
    expect(() => freeze(["t3code/1"])).toThrow("has its evidence or run");
    expect(() => freeze(["t3code/9"])).toThrow("not cases of the batch");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const loadedCase = (
  units: ReadonlyArray<ReturnType<typeof unit>>,
): LoadedCase =>
  ({
    meta: { caseId: "c", range: "aaaaaaaa..bbbbbbbb" },
    packet: { complete: true, gaps: [], batches: [{ batchId: "b", units }] },
  }) as unknown as LoadedCase;

test("the harness's rule recomputes each stored lane from the recorded assessment, and a lane it would not give is caught", () => {
  const units = [
    unit("u1", "a.ts", [1, 1], assessment("agentic", "low-easy")),
    unit("u2", "a.ts", [2, 2], assessment("human-required", "high-hard")),
    unit("u3", "a.ts", [3, 3], assessment("human-suggested", "low-hard")),
    // A gap sends a low-easy unit to human-suggested.
    unit(
      "u4",
      "a.ts",
      [4, 4],
      assessment("human-suggested", "low-easy", {
        gaps: [{ axis: "complexity", kind: "k", detail: "d" }],
      }),
    ),
    // High and easy follows the lean; a record without it gives the lean back from its lane.
    unit("u5", "a.ts", [5, 5], assessment("human-suggested", "high-easy")),
    unit(
      "u6",
      "a.ts",
      [6, 6],
      assessment("agentic", "high-easy", {
        lean: { lane: "agentic", reason: "r" },
      }),
    ),
  ];
  expect(identity([loadedCase(units)])).toEqual([]);
  const wrong = [
    unit("w1", "a.ts", [1, 1], assessment("human-required", "low-easy")),
  ];
  expect(identity([loadedCase(wrong)])).toMatchObject([
    { unit: "w1", from: "human-required", to: "agentic" },
  ]);
  // A candidate's moves are named with the joined unit's section count.
  const raise: LaneRule = (u) =>
    harnessRule(u) === "agentic" ? "human-suggested" : harnessRule(u);
  const { calls, moved } = recompute(loadedCase(units), raise);
  expect(moved.map((m) => [m.unit, m.from, m.to])).toEqual([
    ["u1", "agentic", "human-suggested"],
    ["u6", "agentic", "human-suggested"],
  ]);
  expect(calls.find((c) => c.unit === "u1")?.lines).toEqual(["a.ts:new:1"]);
});

test("a candidate is kept only when its aim clears the scaled bar with an interval above 0, and no guard rises at all", () => {
  const base = {
    "2026 development": {
      threadUnitsSuggestedOrHigher: 0.5,
      threadUnitsRequired: 0.3,
      overEscalatedUnits: 0.2,
      "controls quiet": 0.1,
      sentToPerson: 0.3,
    },
  };
  // The raw floor is shown beside each row and decides nothing.
  const floor = {
    "2026 development": {
      threadUnitsSuggestedOrHigher: 0,
      threadUnitsRequired: 0,
    },
  };
  type Groups = Record<string, Record<string, number | null>>;
  type Judge = NonNullable<Parameters<typeof compare>[3]>[string];
  const judge = (
    overrides: Partial<NonNullable<Judge["threadUnitsRequired"]>> = {},
  ) => ({
    n: 100,
    f: 0.13,
    fFrom: "2026",
    bar: 0.071,
    interval: [0.05, 0.3] as const,
    ...overrides,
  });
  const judges = (
    suggested = judge(),
    required = judge({ interval: [-0.05, 0.05] }),
  ) => ({
    "2026 development": {
      threadUnitsSuggestedOrHigher: suggested,
      threadUnitsRequired: required,
    },
  });
  const at = (overrides: Record<string, number | null>): Groups => ({
    "2026 development": { ...base["2026 development"], ...overrides },
  });
  const verdict = (
    overrides: Record<string, number | null>,
    options: { aims?: ReturnType<typeof judges> | {}; base?: Groups } = {},
  ) =>
    compare(
      options.base ?? base,
      at(overrides),
      floor,
      options.aims ?? judges(),
    )["2026 development"]!.verdict;
  // The aim clears the bar and its interval excludes 0; sending more to a person does not gate it.
  expect(
    verdict({ threadUnitsSuggestedOrHigher: 0.6, sentToPerson: 0.5 }),
  ).toBe("keep");
  // Within the bar is noise, though the raw floor of 0 would have kept it.
  expect(verdict({ threadUnitsSuggestedOrHigher: 0.55 })).toBe("no gain");
  // Beyond the bar, but the bootstrap interval reaches 0: not kept.
  expect(
    verdict(
      { threadUnitsSuggestedOrHigher: 0.6 },
      { aims: judges(judge({ interval: [0, 0.2] })) },
    ),
  ).toBe("no gain");
  // Any rise in over-escalation or a control blocks it: both are read from the same runs.
  expect(
    verdict({ threadUnitsSuggestedOrHigher: 0.6, overEscalatedUnits: 0.21 }),
  ).toBe("blocked");
  expect(
    verdict({ threadUnitsSuggestedOrHigher: 0.6, "controls quiet": 0.14 }),
  ).toBe("blocked");
  // A guard the baseline had no value for blocks when the candidate gives it one.
  expect(
    verdict(
      { threadUnitsSuggestedOrHigher: 0.6, overEscalatedUnits: 0.8 },
      {
        base: {
          "2026 development": {
            ...base["2026 development"],
            overEscalatedUnits: null,
          },
        },
      },
    ),
  ).toBe("blocked");
  // Required recall falling beyond its bar blocks a gain in suggested-or-higher; within it, not.
  expect(
    verdict({ threadUnitsSuggestedOrHigher: 0.6, threadUnitsRequired: 0.2 }),
  ).toBe("blocked");
  expect(
    verdict({ threadUnitsSuggestedOrHigher: 0.6, threadUnitsRequired: 0.25 }),
  ).toBe("keep");
  // No bar (no flip rate, or no thread-backed unit): no floor, and any fall blocks.
  const barless = judges(judge({ bar: null }), judge({ bar: null }));
  expect(
    verdict({ threadUnitsSuggestedOrHigher: 0.6 }, { aims: barless }),
  ).toBe("no floor");
  expect(verdict({ threadUnitsRequired: 0.29 }, { aims: barless })).toBe(
    "blocked",
  );
  expect(verdict({ threadUnitsSuggestedOrHigher: 0.6 }, { aims: {} })).toBe(
    "no floor",
  );
  // The owner's desk guard decides over every group; a kept gain must repeat on the second run.
  const kept = compare(
    base,
    at({ threadUnitsSuggestedOrHigher: 0.6 }),
    floor,
    judges(),
  );
  const aim = (cases: number, gone = false) => ({ cases, gone });
  const holds = {
    byAim: {
      threadUnitsSuggestedOrHigher: aim(3),
      threadUnitsRequired: aim(0),
    },
  };
  expect(overallVerdict(kept, { guard: { holds: true } }, holds)).toBe("keep");
  expect(overallVerdict(kept, { guard: { holds: false } }, holds)).toBe(
    "do not keep",
  );
  expect(overallVerdict(kept, null, holds)).toContain("no verdict");
  // Only the aim that earned the keep is checked: required recall earned nothing here.
  expect(kept["2026 development"]!.earned).toEqual([
    "threadUnitsSuggestedOrHigher",
  ]);
  expect(
    overallVerdict(
      kept,
      { guard: { holds: true } },
      {
        byAim: {
          threadUnitsSuggestedOrHigher: aim(3, true),
          threadUnitsRequired: aim(0),
        },
      },
    ),
  ).toContain("falls back");
  // The earning aim untested is no verdict, though another aim was tested and repeated.
  expect(
    overallVerdict(
      kept,
      { guard: { holds: true } },
      {
        byAim: {
          threadUnitsSuggestedOrHigher: aim(0),
          threadUnitsRequired: aim(2),
        },
      },
    ),
  ).toContain("untested");
  expect(overallVerdict(kept, { guard: { holds: true } }, null)).toContain(
    "no second run was read",
  );
});

test("the paired case bootstrap resamples cases, seeded, and its interval is the delta's own", () => {
  const paired = (units: number, base: number, next: number) => ({
    group: "2026 development",
    units,
    base: { required: base, suggestedOrHigher: base },
    next: { required: next, suggestedOrHigher: next },
  });
  // Every case gains one unit of ten: the delta is 0.1 in every draw.
  const steady = Array.from({ length: 12 }, () => paired(10, 4, 5));
  expect(pairedInterval(steady, "threadUnitsSuggestedOrHigher")).toEqual([
    0.1, 0.1,
  ]);
  // One case carries the whole gain: the interval reaches 0, so it cannot keep.
  const one = [
    paired(10, 2, 8),
    ...Array.from({ length: 11 }, () => paired(10, 4, 4)),
  ];
  const interval = pairedInterval(one, "threadUnitsSuggestedOrHigher")!;
  expect(interval[0]).toBe(0);
  expect(interval[1]).toBeGreaterThan(0.05);
  // Seeded: the same cases give the same interval; no thread-backed unit gives none.
  expect(pairedInterval(one, "threadUnitsSuggestedOrHigher")).toEqual(interval);
  expect(pairedInterval([paired(0, 0, 0)], "threadUnitsRequired")).toBeNull();
});

test("two runs whose units differ are compared on each run's own share, never the baseline's count", () => {
  // A split gives the candidate's run more thread-backed units: 6 of 12 kept against 4 of 10.
  const cases = Array.from({ length: 8 }, () => ({
    group: "pre-2022 development",
    units: 10,
    unitsNext: 12,
    base: { required: 0, suggestedOrHigher: 4 },
    next: { required: 0, suggestedOrHigher: 6 },
  }));
  expect(pairedInterval(cases, "threadUnitsSuggestedOrHigher")).toEqual([
    0.1, 0.1,
  ]);
  // Without a count of its own, the candidate's units are the baseline's, as before.
  const same = cases.map(({ unitsNext: _units, ...entry }) => entry);
  expect(pairedInterval(same, "threadUnitsSuggestedOrHigher")).toEqual([
    0.2, 0.2,
  ]);
});

test("a group's bar is 1.96 × √(f / n), with its era's flip rate from 30 matched units and the pooled one below", () => {
  const flips = {
    byEra: {
      "pre-2022": { matched: 40, flipped: 8 },
      "2026": { matched: 10, flipped: 5 },
    },
    pooled: { matched: 50, flipped: 13 },
  };
  expect(flipRateFor(flips, "pre-2022 development")).toEqual({
    from: "pre-2022",
    f: 0.2,
  });
  expect(flipRateFor(flips, "2026 held-out")).toEqual({
    from: "pooled",
    f: 0.26,
  });
  expect(flipRateFor(flips, "2024-2025 development")?.from).toBe("pooled");
  expect(flipRateFor(null, "2026 development")).toBeNull();
  const cases = [
    {
      group: "pre-2022 development",
      units: 80,
      base: { required: 10, suggestedOrHigher: 40 },
      next: { required: 10, suggestedOrHigher: 48 },
    },
  ];
  const judged = aimJudges(cases, flips)["pre-2022 development"]!;
  expect(judged.threadUnitsSuggestedOrHigher).toMatchObject({
    n: 80,
    f: 0.2,
    fFrom: "pre-2022",
    bar: Math.round(1.96 * Math.sqrt(0.2 / 80) * 1_000) / 1_000,
  });
  // A group with no thread-backed unit has no bar.
  expect(
    aimJudges([{ ...cases[0]!, units: 0 }], flips)["pre-2022 development"]!
      .threadUnitsRequired.bar,
  ).toBeNull();
});

test("the noise floor reads two runs of the same cases, held-out included at the round's end, each case once", () => {
  const units = [unit("u1", "a.ts", [1, 2], assessment("agentic", "low-easy"))];
  const root = tree([
    { number: 1, split: "development", units, lines: {} },
    { number: 2, split: "held-out", units, lines: {} },
  ]);
  try {
    const loaded = loadEvalSet(frozen(root), { heldOut: true });
    const second = (entry: (typeof loaded.cases)[number]) => ({
      range: entry.meta.range,
      packet: entry.packet,
    });
    const floor = noiseFloor(loaded, loaded.cases.map(second));
    expect(Object.keys(floor.moved).sort()).toEqual([
      "2026 development",
      "2026 held-out",
      "pooled",
    ]);
    expect(() =>
      noiseFloor(loaded, [second(loaded.cases[0]!), second(loaded.cases[0]!)]),
    ).toThrow("more than once");
    // A second run whose stored lanes the rule would not give is refused.
    const moved = {
      range: loaded.cases[0]!.meta.range,
      packet: {
        complete: true,
        gaps: [],
        batches: [
          {
            batchId: "b",
            units: [
              unit(
                "x1",
                "a.ts",
                [1, 2],
                assessment("human-required", "low-easy"),
              ),
            ],
          },
        ],
      },
    } as unknown as Parameters<typeof noiseFloor>[1][number];
    expect(() => noiseFloor(loaded, [moved])).toThrow("recomputes");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a high-easy record without a lean gets one back only when no gap decided its lane", () => {
  const gapped = unit(
    "g1",
    "a.ts",
    [1, 1],
    assessment("human-suggested", "high-easy", {
      gaps: [{ axis: "complexity", kind: "k", detail: "d" }],
    }),
  );
  expect(identity([loadedCase([gapped])])).toEqual([]);
  // A rule that reads the lean sees none: no lean is invented where a gap decided the lane.
  const seen: Array<unknown> = [];
  recompute(loadedCase([gapped]), (u) => {
    seen.push(laneInputOf(u.assessment!).lean);
    return harnessRule(u);
  });
  expect(seen).toEqual([null]);
});

test("the error-analysis set names thread-backed misses and over-escalated units, with summaries and audit verdicts, never reverts", () => {
  const range = "aaaaaaa1..bbbbbbbb";
  const np = (concerns: Array<string>) => ({
    class: "needs-person",
    strength: "strong",
    concerns,
  });
  const root = tree([
    {
      number: 1,
      split: "development",
      units: [
        unit("u1", "a.ts", [1, 3], assessment("agentic", "low-easy")),
        unit("u2", "b.ts", [1, 4], assessment("human-required", "high-hard")),
      ],
      lines: {
        "a.ts:new:1": np(["thread-1"]),
        "a.ts:new:2": np(["after-merge:V"]),
        "b.ts:new:1": {
          class: "agent-catchable",
          strength: "weak",
          concerns: ["thread-2"],
        },
        "b.ts:new:2": {
          class: "mechanical",
          strength: "weak",
          concerns: ["path"],
        },
      },
      concerns: [
        {
          id: "thread-1",
          agreed: true,
          a: {
            category: "design",
            designDecision: true,
            rationale: "A person chose the option's name.",
          },
        },
        { id: "thread-2", agreed: false, label: null },
      ],
      afterMerge: {
        commits: [
          {
            commit: "V",
            subject: "Revert",
            a: "revert",
            b: "revert",
            kind: "revert",
          },
        ],
      },
      verdicts: [
        { cite: "thread-1", lines: ["a.ts:new:1"], verdict: "right" },
        // The audit names a mechanical line by its file; a split audit has no majority verdict.
        { cite: "b.ts", lines: ["b.ts:new:2"], verdict: null },
      ],
    },
  ]);
  try {
    const loaded = loadEvalSet(frozen(root));
    expect(loaded.cases[0]!.meta.range).toBe(range);
    const [only] = missesOf(loaded, harnessRule);
    expect(only!.lower).toEqual([
      {
        unit: "u1",
        title: "title u1",
        lane: "agentic",
        // The revert line is not a miss the lanes climb can act on.
        lines: ["a.ts:new:1"],
        owned: 3,
        concerns: [
          {
            id: "thread-1",
            category: "design",
            designDecision: true,
            summary: "A person chose the option's name.",
            audit: "right",
          },
        ],
      },
    ]);
    expect(only!.overEscalated).toMatchObject([
      {
        unit: "u2",
        lines: ["b.ts:new:1", "b.ts:new:2"],
        owned: 4,
        concerns: [
          { id: "thread-2", summary: null, audit: "not audited" },
          { id: "path", audit: "unsure" },
        ],
      },
    ]);
    // The candidate path runs the identity check first and measures the same cases.
    const result = evaluateCandidate(loaded, harnessRule);
    expect(result.moved).toEqual([]);
    expect(result.flaggedKinds).toEqual(["discussed"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a held-out group's raw floor is its era's development one, and a group with no floor case shows the pooled one", () => {
  const values = { threadUnitsSuggestedOrHigher: 0.05 };
  const floor = {
    "2026 development": values,
    pooled: { threadUnitsSuggestedOrHigher: 0.1 },
  };
  expect(floorFor(floor, "2026 development")?.from).toBe("2026 development");
  expect(floorFor(floor, "2026 held-out")?.from).toBe("2026 development");
  expect(floorFor(floor, "pre-2022 held-out")?.from).toBe("pooled");
  expect(floorFor(floor, "2024-2025 development")?.from).toBe("pooled");
  expect(floorFor(null, "2026 held-out")).toBeNull();
});

test("the live rule reads the lines each unit adds from its run's own hunks, and a run placed with it passes the identity check", () => {
  const units = [
    unit("u1", "src/a.ts", [11, 11], assessment("agentic", "low-easy")),
    unit("u2", "src/a.ts", [12, 12], assessment("agentic", "low-easy")),
  ];
  const entry = {
    ...loadedCase(units),
    hunks: [
      {
        kind: "text",
        path: "src/a.ts",
        newPath: "src/a.ts",
        newStart: 10,
        text: "@@ -10,1 +10,3 @@\n keep\n+export const one = 1;\n+const two = 2;\n",
      },
    ],
  } as LoadedCase;
  const { moved } = recompute(entry, liveRule);
  // Only the unit whose own lines add the export moves.
  expect(moved.map((m) => [m.unit, m.to])).toEqual([["u1", "human-suggested"]]);
  // Placed with rule 1, the stored lanes are laneOf's: identity holds and the live rule moves u1.
  expect(identity([entry])).toEqual([]);
  // A run placed with the live rule (rule 2) stores u1 raised: identity holds there too.
  const raisedUnits = [
    unit("u1", "src/a.ts", [11, 11], assessment("human-suggested", "low-easy")),
    units[1]!,
  ];
  const placed = {
    ...entry,
    ...loadedCase(raisedUnits),
    hunks: entry.hunks,
    laneRule: 2,
  } as LoadedCase;
  expect(identity([placed])).toEqual([]);
  // Read with the wrong rule, the identity check catches it.
  expect(identity([{ ...placed, laneRule: 1 } as LoadedCase])).toHaveLength(1);
  // The kept rule is live, so it is no longer a candidate a round could apply twice.
  expect(() => candidateRule("public-surface")).toThrow("no lane candidate");
  expect(() => candidateRule("no-such-rule")).toThrow("no lane candidate");
  // A name every object has is still not a candidate.
  expect(() => candidateRule("constructor")).toThrow("no lane candidate");
  // A run with no hunks would let a candidate fire nowhere: refused when a candidate is measured.
  expect(() => requireHunks([], "r1", true)).toThrow("no manifest hunks");
  expect(() => requireHunks([], "r1", false)).not.toThrow();
});

test("two candidates in one report are compared on recall per unit, the share sent to a person and the owner's line agreement", () => {
  const result = (recall: number, sent: number) =>
    ({
      comparison: {
        "2026 development": {
          verdict: "keep",
          floorFrom: "2026 development",
          earned: ["threadUnitsSuggestedOrHigher"],
          keys: {
            threadUnitsSuggestedOrHigher: { candidate: recall },
            sentToPerson: { candidate: sent },
          },
        },
      },
      consistency: {
        byAim: {
          threadUnitsSuggestedOrHigher: { cases: 1, gone: false },
          threadUnitsRequired: { cases: 1, gone: false },
        },
      },
    }) as unknown as Parameters<typeof describeSideBySide>[0][number]["result"];
  const owner = (share: number) =>
    ({
      guard: { holds: true },
      lineAgreement: { share },
    }) as unknown as Parameters<typeof describeSideBySide>[0][number]["owner"];
  const text = describeSideBySide([
    { name: "wide", result: result(0.7, 0.45), owner: owner(0.959) },
    { name: "narrow", result: result(0.62, 0.37), owner: owner(1) },
  ]).join("\n");
  expect(text).toContain(
    "thread recall per unit (suggested or higher) wide 70%, narrow 62%; sent to a person wide 45%, narrow 37%",
  );
  expect(text).toContain("Owner's line agreement: wide 95.9%, narrow 100%.");
  expect(text).toContain("Overall: wide keep; narrow keep.");
});

test("end to end, a case's package entry is read from its own clone at the packet's head, and an owner run's at its own", () => {
  const root = mkdtempSync(join(tmpdir(), "lanes-eval-clone-"));
  try {
    const dir = join(root, "cases", "t3code", "7");
    const clone = join(dir, "replay");
    mkdirSync(join(clone, "src"), { recursive: true });
    const git = (...args: Array<string>) =>
      execFileSync("git", ["-C", clone, ...args], {
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
        },
      }).trim();
    execFileSync("git", ["init", "-q", clone]);
    writeFileSync(
      join(clone, "package.json"),
      JSON.stringify({ exports: { ".": "./src/index.ts" } }),
    );
    writeFileSync(join(clone, "src/index.ts"), 'export * from "./a.ts";\n');
    writeFileSync(join(clone, "src/a.ts"), "export const a = 1;\n");
    writeFileSync(join(clone, "src/b.ts"), "export const b = 1;\n");
    git("add", ".");
    git(
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "-q",
      "-m",
      "first",
    );
    const head = git("rev-parse", "HEAD");
    const range = "aaaaaaa7..bbbbbbbb";
    const hunk = (path: string, text: string) => ({
      kind: "text",
      path,
      newPath: path,
      newStart: 1,
      text: `@@ -0,0 +1,1 @@\n+${text}\n`,
    });
    const shown = {
      range: { baseOid: "a".repeat(40), headOid: head },
      manifest: {
        hunks: [
          hunk("src/a.ts", "export const a = 1;"),
          hunk("src/b.ts", "export const b = 1;"),
        ],
      },
      packet: {
        complete: true,
        gaps: [],
        batches: [
          {
            batchId: "b1",
            units: [
              unit("u1", "src/a.ts", [1, 1], assessment("agentic", "low-easy")),
              unit("u2", "src/b.ts", [1, 1], assessment("agentic", "low-easy")),
            ],
          },
        ],
      },
    };
    mkdirSync(join(dir, "labels"), { recursive: true });
    mkdirSync(join(dir, "run"), { recursive: true });
    const record = caseRecord(7, "development", null);
    writeFileSync(join(dir, "case.json"), JSON.stringify(record));
    writeFileSync(
      join(dir, "labels", "line-evidence.json"),
      JSON.stringify({
        version: 2,
        caseId: record.caseId,
        source: "t3code",
        era: "2026",
        split: "development",
        family: record.family,
        control: null,
        range,
        runId: "01RUN",
        labelling: { passes: 2, rule: "majority", kappa: 0.8 },
        lines: {},
        disputed: 0,
      }),
    );
    writeFileSync(join(dir, "run", "show.json"), JSON.stringify(shown));
    writeFileSync(
      join(root, "batch.json"),
      JSON.stringify({ cases: [{ source: "t3code", number: 7 }] }),
    );
    const loaded = loadEvalSet(
      writeEvalSet(
        freezeEvalSet({
          laneRule: 1,
          name: "e2e",
          batch: join(root, "batch.json"),
          cases: join(root, "cases"),
        }),
        join(root, "sets"),
      ),
    );
    const rule = candidateRule("public-surface-entry");
    // a.ts is re-exported from the package's entry at the head; b.ts is not.
    const { moved } = recompute(loaded.cases[0]!, rule);
    expect(moved.map((m) => [m.unit, m.to])).toEqual([
      ["u1", "human-suggested"],
    ]);
    // The owner's runs read the same way, each at its own head in the repository named.
    const owner = ownerRunUnits(shown as never, "r1", range, rule, {
      repository: clone,
      candidate: true,
    });
    expect(owner.calls.map((c) => [c.unit, c.harness])).toEqual([
      ["u1", "human-suggested"],
      ["u2", "agentic"],
    ]);
    expect(owner.truncated).toEqual([]);
    // A run read with a lane rule it was not placed with is refused: under rule 2, u1's export
    // would have been raised, so its stored agentic lane is not that rule's.
    expect(() =>
      ownerRunUnits(shown as never, "r1", range, rule, {
        repository: clone,
        candidate: true,
        laneRule: 2,
      }),
    ).toThrow("was not placed with lane rule 2");
    // A repository without the run's head fails loudly, not as every export non-public.
    expect(() =>
      ownerRunUnits(
        { ...shown, range: { headOid: "0".repeat(40) } } as never,
        "r1",
        range,
        rule,
        { repository: clone, candidate: true },
      ),
    ).toThrow("holds no commit");
    expect(() =>
      ownerRunUnits({ ...shown, manifest: null } as never, "r1", range, rule, {
        repository: clone,
        candidate: true,
      }),
    ).toThrow("no manifest hunks");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the noise floor's second runs are pinned with the set and read as its floor, a moved one refused", () => {
  const units = [unit("u1", "a.ts", [1, 2], assessment("agentic", "low-easy"))];
  const root = tree([
    { number: 1, split: "development", units, lines: {} },
    { number: 2, split: "development", units, lines: {} },
  ]);
  try {
    // The first case is one of the floor's; the second is run again for consistency only.
    const second = (number: number, run: string, runId = "second") => {
      const folder = join(root, "cases", "t3code", String(number), "run", run);
      mkdirSync(folder, { recursive: true });
      writeFileSync(
        join(folder, "show.json"),
        JSON.stringify({
          runId,
          packet: {
            complete: true,
            gaps: [],
            batches: [{ batchId: "b1", units }],
          },
        }),
      );
      return folder;
    };
    const repeat = second(1, "cloud-2");
    second(2, "cloud-3");
    const freeze = (
      name: string,
      runs: { floorRun?: string; consistencyRun?: string },
    ) =>
      freezeEvalSet({
        laneRule: 1,
        name,
        batch: join(root, "batch.json"),
        cases: join(root, "cases"),
        ...runs,
      });
    const path = writeEvalSet(
      freeze("floor", { floorRun: "cloud-2", consistencyRun: "cloud-3" }),
      join(root, "sets"),
    );
    const loaded = loadEvalSet(path);
    const floor = pinnedFloor(loaded);
    expect(floor.map((entry) => entry.range)).toEqual(["aaaaaaa1..bbbbbbbb"]);
    expect(noiseFloor(loaded, floor).cases).toBe(1);
    // The consistency runs stay apart from the floor, so they never change its flip rate.
    expect(pinnedConsistency(loaded).map((entry) => entry.range)).toEqual([
      "aaaaaaa2..bbbbbbbb",
    ]);
    // A run name no case has, a case with both kinds, and a case's own run renamed are refused.
    expect(() => freeze("none", { floorRun: "cloud-9" })).toThrow(
      "no case of the batch has run/cloud-9",
    );
    second(1, "cloud-3");
    expect(() =>
      freeze("both", { floorRun: "cloud-2", consistencyRun: "cloud-3" }),
    ).toThrow("kept apart from the floor");
    const own = join(root, "cases", "t3code", "1", "run", "own");
    mkdirSync(own, { recursive: true });
    writeFileSync(
      join(own, "show.json"),
      readFileSync(join(root, "cases", "t3code", "1", "run", "show.json")),
    );
    expect(() => freeze("own", { floorRun: "own" })).toThrow(
      "the case's own run",
    );
    writeFileSync(join(repeat, "show.json"), JSON.stringify({ packet: null }));
    expect(() => loadEvalSet(path)).toThrow("changed since the set was frozen");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("run consistency reads the candidate's gain on the floor cases' stored and second runs, and the floor counts unit flips", () => {
  const np = {
    class: "needs-person",
    strength: "strong",
    concerns: ["thread-1"],
  };
  const root = tree([
    {
      number: 1,
      split: "development",
      units: [
        unit("u1", "a.ts", [1, 2], assessment("agentic", "low-easy")),
        unit("u2", "b.ts", [1, 2], assessment("agentic", "low-easy")),
      ],
      lines: { "a.ts:new:1": np },
    },
  ]);
  try {
    const loaded = loadEvalSet(frozen(root));
    const entry = loaded.cases[0]!;
    const raise: LaneRule = (u) =>
      harnessRule(u) === "agentic" ? "human-suggested" : harnessRule(u);
    const same = [{ range: entry.meta.range, packet: entry.packet }];
    const repeated = runConsistency(loaded, raise, same);
    expect(repeated.pooled.threadUnitsSuggestedOrHigher).toEqual({
      first: 1,
      second: 1,
      units: { first: 1, second: 1 },
    });
    // One case moves one thread-backed unit, and moves it again on the second run.
    expect(repeated.byAim.threadUnitsSuggestedOrHigher).toEqual({
      cases: 1,
      moves: 1,
      repeated: 1,
      gone: false,
    });
    // A second run whose units no longer own the thread-backed line: the gain cannot be seen there.
    const elsewhere = {
      range: entry.meta.range,
      packet: {
        complete: true,
        gaps: [],
        batches: [
          {
            batchId: "b1",
            units: [
              unit("x1", "a.ts", [2, 2], assessment("agentic", "low-easy")),
              unit("x2", "b.ts", [1, 2], assessment("agentic", "low-easy")),
            ],
          },
        ],
      },
    } as unknown as Parameters<typeof runConsistency>[2][number];
    const gone = runConsistency(loaded, raise, [elsewhere]);
    expect(gone.pooled.threadUnitsSuggestedOrHigher.second).toBeNull();
    expect(gone.byAim.threadUnitsSuggestedOrHigher).toMatchObject({
      cases: 1,
      repeated: 0,
      gone: true,
    });
    // A rule with no gain on the cases run twice has nothing to repeat.
    expect(
      runConsistency(loaded, harnessRule, [elsewhere]).byAim
        .threadUnitsSuggestedOrHigher,
    ).toMatchObject({ cases: 0, moves: 0, gone: false });
    // The floor's flips: both units matched by their lines, both in the same lane.
    expect(noiseFloor(loaded, [elsewhere]).flips).toEqual({
      byEra: { "2026": { matched: 2, flipped: 0 } },
      pooled: { matched: 2, flipped: 0 },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Why (NEU-148): the unit review step publishes fixed-shape packets. Two reader boundaries would
// misreport them silently: a fixed-shape unit's code sections read as lanes joined (so exact moves
// show as approximations), and a pack that fails leaves its units with no assessment, which every
// measure skips, so a run could pass the guard by not assessing the units that need a person.
test("a fixed-shape run counts no lane joins, and lines only unassessed units own are reported, never judged", () => {
  const sectioned = (u: ReturnType<typeof unit>) => ({
    ...u,
    sections: [{ id: "s1" }, { id: "s2" }],
  });
  const needs = { class: "needs-person", strength: "strong", concerns: ["c1"] };
  const assessed = sectioned(
    unit("u1", "a.ts", [1, 2], assessment("agentic", "low-easy")),
  );
  const root = tree([
    {
      number: 1,
      split: "development",
      units: [assessed],
      lines: { "a.ts:new:1": needs, "a.ts:new:9": needs },
    },
  ]);
  const elsewhere = mkdtempSync(join(tmpdir(), "lanes-eval-root-"));
  try {
    const path = frozen(root);
    const write = (folder: string, shown: Record<string, unknown>) => {
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, "show.json"), JSON.stringify(shown));
    };
    const packet = (units: ReadonlyArray<unknown>) => ({
      complete: true,
      gaps: [],
      batches: [{ batchId: "b1", units }],
    });
    // The older shape beside the pinned packet; the fixed shape under another root, its second
    // unit published without an assessment.
    write(join(root, "cases", "t3code", "1", "run", "older"), {
      stages: [{ stage: "assemble" }],
      packet: packet([
        assessed,
        unit("u2", "a.ts", [9, 9], assessment("human-required", "high-hard")),
      ]),
    });
    const { assessment: _none, ...bare } = unit(
      "u2",
      "a.ts",
      [9, 9],
      assessment("human-required", "high-hard"),
    );
    write(join(elsewhere, "t3code", "1", "run", "fixed"), {
      stages: [{ stage: "link" }, { stage: "publish" }],
      packet: packet([assessed, bare]),
    });
    const older = loadEvalSet(path, { run: "older" });
    const fixed = loadEvalSet(path, { run: "fixed", runRoot: elsewhere });
    expect([older.cases[0]!.shape, fixed.cases[0]!.shape]).toEqual([
      "older",
      "fixed",
    ]);
    expect(() => loadEvalSet(path, { runRoot: elsewhere })).toThrow(
      "name the run too",
    );
    const raise: LaneRule = (u) =>
      harnessRule(u) === "agentic" ? "human-suggested" : harnessRule(u);
    expect(recompute(older.cases[0]!, raise).moved[0]!.sections).toBe(2);
    expect(recompute(fixed.cases[0]!, raise).moved[0]!.sections).toBe(1);
    // The fixed run's unassessed unit holds the needs-a-person line 9: reported, not judged.
    const result = compareRuns(older, fixed, null);
    expect(result.unassessed).toEqual({
      baseline: { units: 0, needsPersonLines: 0 },
      candidate: { units: 1, needsPersonLines: 1 },
    });
    // The owner's guard reports the same: a key line only an unassessed unit owns.
    const measured = laneMeasures(
      [
        {
          unit: "u2",
          title: "t",
          range: "r",
          harness: null,
          owner: null,
          lines: ["a.ts:new:9"],
        },
      ],
      { "r|a.ts:new:9": "human-required" },
    );
    expect(measured.guard).toMatchObject({ holds: true, unassessedLines: 1 });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});
