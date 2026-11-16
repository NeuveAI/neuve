// Why (NEU-148): the finders' gate passes or fails a build on its rules, so each is pinned here. The
// catch rule: a miscounted catch (a dropped finding counted as caught, a wrong side or a near miss
// counted as overlapping, a cross-file catch named when it was not) passes or fails the gate falsely.
// The data-point rule: a review that failed, made no run or was killed must never count as a miss or
// lower the bar. The compare rule: the noise bar from two runs of the same build is the gate's whole
// meaning, so it is checked where the two baseline runs disagree, and runs of different builds or
// settings must fail. And a changed variant record, or a run of another range, must be refused.
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
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
  canonical,
  catchOf,
  categoryOf,
  reviewNotComplete,
  ExportFile,
  FindingsFile,
  compareRuns,
  meritPack,
  meritRead,
  readRun,
  readSet,
  scoreVariant,
  summarise,
  byCategory,
  type Plant,
  type RunScore,
  type StoredFinding,
} from "../src/harness-compare/full-test/finders-gate.ts";

const plant = (over: Partial<Plant> = {}): Plant => ({
  variant: 1,
  caseId: "planted:x",
  host: { caseId: "github:a/b:1" },
  problem: "guard-deletion",
  kind: "light-deletion-only",
  lines: [{ path: "src/a.ts", side: "old", startLine: 10, endLine: 12 }],
  mentions: ["guard"],
  ...over,
});
const finding = (
  status: StoredFinding["status"],
  anchor: Partial<StoredFinding["anchors"][number]> = {},
  over: Partial<StoredFinding> = {},
): StoredFinding => ({
  id: "correctness.1",
  lens: "correctness",
  kind: "defect",
  claim: "the bound check is gone",
  evidence: [],
  status,
  anchors: [
    { path: "src/a.ts", side: "old", startLine: 12, endLine: 14, ...anchor },
  ],
  ...over,
});

test("a kept finding overlapping a planted line by path, side and line is a catch; touching ends count, neighbours do not", () => {
  expect(catchOf([finding("kept")], plant()).outcome).toBe("caught");
  expect(
    catchOf([finding("kept", { startLine: 13, endLine: 20 })], plant()).outcome,
  ).toBe("missed");
  expect(
    catchOf([finding("kept", { startLine: 1, endLine: 9 })], plant()).outcome,
  ).toBe("missed");
  expect(catchOf([finding("kept", { side: "new" })], plant()).outcome).toBe(
    "missed",
  );
  expect(
    catchOf([finding("kept", { path: "src/b.ts" })], plant()).outcome,
  ).toBe("missed");
  expect(catchOf([finding("kept")], plant()).caughtBy).toEqual(["correctness"]);
});

test("a finding on the plant that Verify dropped, left unverified or never saw is found, not kept", () => {
  for (const status of [
    "dropped",
    "unverified",
    "deduplicated",
    "over-cap",
  ] as const)
    expect(catchOf([finding(status)], plant()).outcome).toBe("found-not-kept");
  // One kept finding on the plant outweighs a dropped one.
  expect(
    catchOf(
      [finding("dropped"), finding("kept", {}, { id: "tests.1" })],
      plant(),
    ).outcome,
  ).toBe("caught");
});

test("a cross-file catch is named only when its claim or evidence names a related file or a mention", () => {
  const cross = plant({
    problem: "cross-file",
    mentions: ["retryBudget"],
    related: [
      { path: "src/deep/limits.ts", side: "new", startLine: 4, endLine: 6 },
    ],
  });
  const named = (claim: string, evidence: string[] = []) =>
    catchOf([finding("kept", {}, { claim, evidence })], cross).named;
  expect(named("callers in limits.ts still pass the old shape")).toBe(true);
  expect(named("x", ["see src/deep/limits.ts:5"])).toBe(true);
  expect(named("the RETRYBUDGET is never read now")).toBe(true);
  expect(named("the retryBudgets list is fine")).toBe(false);
  expect(named("something else is wrong")).toBe(false);
  // Not a catch: naming is not asked.
  expect(
    catchOf([finding("dropped", {}, { claim: "limits.ts" })], cross).named,
  ).toBeNull();
  // A kept finding only on the related lines is not a catch and not off the plant.
  const related = catchOf(
    [
      finding("kept", {
        path: "src/deep/limits.ts",
        side: "new",
        startLine: 5,
        endLine: 5,
      }),
    ],
    cross,
  );
  // Since the beside level: caught beside the plant, still not the headline catch.
  expect(related.outcome).toBe("caught-beside");
  expect(related.keptOffPlant).toBe(0);
  expect(categoryOf(cross)).toBe("cross-file");
  expect(categoryOf(plant())).toBe("light-file");
});

const exported = (over: Partial<ExportFile> = {}): ExportFile => ({
  finished: true,
  case: { base: "b".repeat(40), head: "h".repeat(40) },
  exit: 0,
  wallS: 300,
  outcome: "completed",
  timeoutReached: false,
  published: true,
  build: { commit: "abc" },
  env: {},
  settings: {},
  ...over,
});
const LENS_NAMES = ["scope-fit", "correctness", "risky-edges", "tests"];
const read = (
  findings: StoredFinding[],
  lenses: Record<
    string,
    { output: "found" | "none"; finderResult?: boolean; runLog?: string }
  > = {},
): FindingsFile => ({
  status: "read",
  findings,
  lenses: Object.fromEntries(
    LENS_NAMES.map((l) => [
      l,
      lenses[l] ?? { output: "found", runLog: "agrees" },
    ]),
  ),
  reads: null,
});

test("a review that failed, made no run, was killed, or lost a lens is not a data point; a cut-off the product reports is", () => {
  const ok = scoreVariant(plant(), read([finding("kept")]), exported());
  expect([ok.status, ok.outcome]).toEqual(["scored", "caught"]);
  const cases: Array<[FindingsFile | null, ExportFile | null, string]> = [
    [read([finding("kept")]), exported({ exit: 1 }), "failed"],
    [read([finding("kept")]), exported({ killedAfterGrace: true }), "failed"],
    [{ status: "no-run", reason: "no store" }, exported({ exit: 2 }), "failed"],
    [{ status: "unreadable", reason: "x" }, exported(), "unreadable"],
    [null, null, "missing"],
    // A lens with neither a Find output nor a finder result: the finder never ran.
    [
      read([finding("kept")], {
        tests: { output: "none", finderResult: false },
      }),
      exported(),
      "failed",
    ],
  ];
  for (const [findings, exp, status] of cases) {
    const v = scoreVariant(plant(), findings, exp);
    expect([v.status, v.outcome, v.kept] as unknown[]).toEqual([
      status,
      "unscored",
      0,
    ]);
    expect(v.notComplete.length).toBeGreaterThan(0);
  }
  // A lens that found nothing but reported a result is fine.
  expect(
    scoreVariant(
      plant(),
      read([], { tests: { output: "none", finderResult: true } }),
      exported(),
    ).status,
  ).toBe("scored");
  const cut = scoreVariant(
    plant(),
    read([finding("kept")]),
    exported({ exit: 1, timeoutReached: true, published: true }),
  );
  expect([cut.status, cut.cutOffByProduct, cut.outcome]).toEqual([
    "scored",
    true,
    "caught",
  ]);
  // Sums count only data points.
  const sums = summarise([
    ok,
    scoreVariant(plant(), read([finding("kept")]), exported({ exit: 1 })),
  ]);
  expect([sums.scored, sums.failed, sums.caught, sums.kept]).toEqual([
    1, 1, 1, 1,
  ]);
});

test("a review whose case did not end is not a data point for the gate either", () => {
  // Why (N19): the runner and the gate must agree; a group left alive, a process outside it, or a
  // listing that failed means the case's end is not known, whatever the exit code.
  for (const end of [
    { membersLeft: 1, outsideGroup: 0 },
    { membersLeft: 0, outsideGroup: 1 },
    { membersLeft: null, outsideGroup: null, listingFailed: true },
  ]) {
    const v = scoreVariant(
      plant(),
      read([finding("kept")]),
      ExportFile.parse(exported({ machine: { end } })),
    );
    expect([v.status, v.notComplete]).toEqual([
      "failed",
      ["the case did not end"],
    ]);
  }
  const ended = scoreVariant(
    plant(),
    read([finding("kept")]),
    exported({
      machine: {
        end: { membersLeft: 0, outsideGroup: 0, interruptedWhileEnding: true },
      },
    }),
  );
  expect(ended.status).toBe("scored");
});

test("a lens record's native check reads from its own field, and from the round 1c reader's string", () => {
  // Why (B5): the round 1c reader wrote `finderResult: "agrees"`; the gate threw on it.
  const parsed = FindingsFile.parse({
    status: "read",
    findings: [finding("kept")],
    reads: null,
    lenses: {
      "scope-fit": {
        output: "none",
        finderResult: true,
        nativeCheck: "absent",
      },
      correctness: {
        output: "found",
        runLog: "agrees",
        finderResult: "agrees",
      },
      "risky-edges": {
        output: "found",
        runLog: "agrees",
        nativeCheck: "unreadable",
      },
      tests: { output: "found", runLog: "agrees" },
    },
  });
  const v = scoreVariant(plant(), parsed, exported());
  expect([v.status, v.nativeCheck]).toEqual([
    "scored",
    {
      "scope-fit": "absent",
      correctness: "agrees",
      "risky-edges": "unreadable",
      tests: "not recorded",
    },
  ]);
  expect(
    FindingsFile.safeParse({
      ...parsed,
      lenses: {
        ...(parsed.status === "read" ? parsed.lenses : {}),
        tests: { output: "found", finderResult: "maybe" },
      },
    }).success,
  ).toBe(false);
});

test("statuses taken without a finder result to check them are flagged, and catches are also given by primary anchor", () => {
  const v = scoreVariant(
    plant(),
    read(
      [
        finding(
          "kept",
          {},
          {
            anchors: [
              { path: "src/z.ts", side: "new", startLine: 1, endLine: 1 },
              { path: "src/a.ts", side: "old", startLine: 11, endLine: 11 },
            ],
          },
        ),
      ],
      { tests: { output: "found", runLog: "no-finder-result" } },
    ),
    exported(),
  );
  expect([v.outcome, v.primaryOutcome, v.uncheckedLenses]).toEqual([
    "caught",
    "missed",
    ["tests"],
  ]);
  // The unchecked lens found nothing that decides the outcome; when it is the catching lens, it does.
  expect(v.uncheckedChangesOutcome).toBe(false);
  const decides = scoreVariant(
    plant(),
    read([finding("kept")], {
      correctness: { output: "found", runLog: "no-finder-result" },
    }),
    exported(),
  );
  expect([decides.outcome, decides.uncheckedChangesOutcome]).toEqual([
    "caught",
    true,
  ]);
});

test("beside lines give the second outcome level, below the headline catch", () => {
  const removed = plant({
    beside: [{ path: "src/a.ts", side: "new", startLine: 9, endLine: 10 }],
  });
  expect(
    catchOf(
      [finding("kept", { side: "new", startLine: 10, endLine: 10 })],
      removed,
    ).outcome,
  ).toBe("caught-beside");
  expect(
    catchOf(
      [
        finding("kept"),
        finding("kept", { side: "new", startLine: 10, endLine: 10 }),
      ],
      removed,
    ).outcome,
  ).toBe("caught");
  // A dropped finding beside the plant is not found-not-kept (that is on planted lines only).
  expect(
    catchOf(
      [finding("dropped", { side: "new", startLine: 10, endLine: 10 })],
      removed,
    ).outcome,
  ).toBe("missed");
  expect(
    catchOf(
      [finding("kept", { side: "new", startLine: 10, endLine: 10 })],
      removed,
    ).keptOffPlant,
  ).toBe(0);
});

/** One run over variants 1-6 of one category. */
const run = (
  name: string,
  caught: number[],
  over: {
    offPlant?: number[];
    failed?: number[];
    beside?: number[];
    exportOver?: Partial<ExportFile>;
    wallS?: number[];
    timing?: boolean;
    count?: number;
  } = {},
): RunScore => {
  const count = over.count ?? 4;
  const variants = Array.from({ length: count }, (_, i) => {
    const variant = i + 1;
    const p = plant({
      variant,
      beside: [{ path: "src/a.ts", side: "new", startLine: 50, endLine: 50 }],
    });
    const findings = [
      ...(caught.includes(variant) ? [finding("kept")] : []),
      ...(over.beside?.includes(variant)
        ? [
            finding(
              "kept",
              { side: "new", startLine: 50, endLine: 50 },
              { id: "b.1" },
            ),
          ]
        : []),
      ...Array.from({ length: over.offPlant?.[i] ?? 0 }, (_, k) =>
        finding(
          "kept",
          { startLine: 100 + k, endLine: 100 + k },
          { id: `tests.${k}` },
        ),
      ),
    ];
    const failed = over.failed?.includes(variant);
    return scoreVariant(
      p,
      failed ? { status: "no-run", reason: "no store" } : read(findings),
      exported({
        ...(failed ? { exit: 1 } : {}),
        ...(over.wallS === undefined ? {} : { wallS: over.wallS[i]! }),
        ...(over.timing === undefined
          ? {}
          : { timingsComparable: over.timing }),
        ...over.exportOver,
      }),
    );
  });
  const present = variants.filter((s) => s.status !== "missing");
  return {
    run: name,
    builds: [...new Set(present.map((s) => s.review.build))],
    configs: [...new Set(present.map((s) => s.config))],
    variants,
    byCategory: byCategory(variants),
    overall: summarise(variants),
    notMeasured: [],
  };
};

test("the noise bar comes from the two baseline runs: unstable variants never count, stable losses do", () => {
  // Variants 2 and 3 flip between the baselines; 1 is caught by both, 4 by neither.
  const baseline = run("b", [1, 2], { offPlant: [0, 1, 0, 1] });
  const again = run("b2", [1, 3], { offPlant: [1, 0, 0, 1] });
  const steady = compareRuns(
    baseline,
    again,
    run("c", [1, 2, 3], { offPlant: [0, 1, 0, 1] }),
  );
  const k = steady.categories["light-file"]!.catches;
  expect([k.flips, k.lost, k.gained, k.verdict, k.holds]).toEqual([
    2,
    0,
    0,
    "within noise",
    true,
  ]);
  expect(k.bothBaselinesCaught).toBe(1);
  expect(k.lossRateUpperBound).toBeCloseTo(0.95, 6);
  expect(steady.acceptance.passes).toBe(true);
  expect(steady.acceptance.thin).toEqual([
    { category: "light-file", variants: 4 },
  ]);
  const fewer = compareRuns(
    baseline,
    again,
    run("c", [1], { offPlant: [0, 1, 0, 1] }),
  );
  expect(fewer.categories["light-file"]!.catches.verdict).toBe("within noise");
  expect(fewer.acceptance.categoriesWithFewerCatches).toEqual(["light-file"]);
  expect(fewer.acceptance.passes).toBe(false);
  const lost = compareRuns(
    baseline,
    again,
    run("c", [2, 3], { offPlant: [0, 1, 0, 1] }),
  );
  expect(lost.categories["light-file"]!.catches.verdict).toBe("worse");
  expect(lost.categories["light-file"]!.catches.lossRateUpperBound).toBeNull();
  expect(
    compareRuns(baseline, again, run("c", [1, 4], { offPlant: [0, 1, 0, 1] }))
      .categories["light-file"]!.catches.verdict,
  ).toBe("better");
});

test("failed reviews in a baseline or the candidate are kept out of catches and pairs, counted, and fail acceptance", () => {
  // The reviewer's case: a baseline catches 6 of 6, baseline-again's reviews of 4-6 made no run, and
  // the candidate misses exactly those three. Before, that passed as "within noise".
  const baseline = run("b", [1, 2, 3, 4, 5, 6], { count: 6 });
  const again = run("b2", [1, 2, 3], { count: 6, failed: [4, 5, 6] });
  const result = compareRuns(
    baseline,
    again,
    run("c", [1, 2, 3], { count: 6 }),
  );
  const k = result.categories["light-file"]!.catches;
  expect([result.dataPoints, k.variants, k.flips, k.caught.baseline]).toEqual([
    3, 3, 0, 3,
  ]);
  expect(result.acceptance.passes).toBe(false);
  expect(
    result.acceptance.notDataPoints.map((n) => [n.run, n.variant]),
  ).toEqual([
    ["b2", 4],
    ["b2", 5],
    ["b2", 6],
  ]);
  expect(result.runs.map((r) => r.failed)).toEqual([0, 3, 0]);
  // Failed candidate reviews never make kept findings off the plant look better.
  const cand = compareRuns(
    run("b", [], { count: 6, offPlant: [2, 2, 2, 2, 2, 2] }),
    run("b2", [], { count: 6, offPlant: [2, 2, 2, 2, 2, 2] }),
    run("c", [], {
      count: 6,
      offPlant: [2, 0, 0, 0, 0, 0],
      failed: [2, 3, 4, 5, 6],
    }),
  );
  const off = cand.overall.measures.find((m) => m.measure === "keptOffPlant")!;
  expect([off.pairedVariants, off.verdict, cand.acceptance.passes]).toEqual([
    1,
    "within noise",
    false,
  ]);
  // A killed review is the same.
  const killed = compareRuns(
    baseline,
    run("b2", [1, 2, 3, 4, 5, 6], {
      count: 6,
      exportOver: { killedAfterGrace: true },
    }),
    run("c", [1, 2, 3, 4, 5, 6], { count: 6 }),
  );
  expect([killed.dataPoints, killed.acceptance.passes]).toEqual([0, false]);
});

test("runs of mixed builds or settings, baselines that differ, or a repeated run name fail acceptance", () => {
  const b = run("b", [1]);
  const same = run("b2", [1]);
  expect(compareRuns(b, same, run("c", [1])).acceptance.configuration).toEqual(
    [],
  );
  const twoBuilds: RunScore = { ...b, builds: ["abc", "def"] };
  expect(
    compareRuns(twoBuilds, same, run("c", [1])).acceptance.configuration,
  ).toContain("b: 2 builds in one run");
  const otherBuild = run("b2", [1], {
    exportOver: { build: { commit: "def" } },
  });
  expect(
    compareRuns(b, otherBuild, run("c", [1])).acceptance.configuration,
  ).toContain("the two baseline runs used different builds");
  // N9: a runner flag that changes the product or when a review is ended is part of the configuration.
  for (const over of [
    { deadlineMinutes: 20 },
    { graceMinutes: 5 },
    { wrapper: "none" },
    { batchLimitMinutes: 30 },
  ])
    expect(
      compareRuns(b, run("b2", [1], { exportOver: over }), run("c", [1]))
        .acceptance.configuration,
    ).toContain("the two baseline runs used different configurations");
  const otherEnv = run("b2", [1], {
    exportOver: { env: { NEUVE_UNIT_REVIEW_PACK_UNITS: "4" } },
  });
  const result = compareRuns(b, otherEnv, run("c", [1]));
  expect(result.acceptance.configuration).toContain(
    "the two baseline runs used different configurations",
  );
  expect(result.acceptance.passes).toBe(false);
  const unknown = run("c", [1], { exportOver: { build: { commit: null } } });
  expect(compareRuns(b, same, unknown).acceptance.configuration).toContain(
    "c: an unknown build",
  );
  expect(
    compareRuns(b, same, run("b", [1])).acceptance.configuration[0],
  ).toMatch(/not distinct/);
  // The candidate may differ in build and settings: that is what is compared.
  expect(
    compareRuns(
      b,
      same,
      run("c", [1], {
        exportOver: { build: { commit: "zzz" }, settings: { "review.x": 1 } },
      }),
    ).acceptance.passes,
  ).toBe(true);
});

test("the second line (caught or beside) is compared too, and its disagreement is said", () => {
  const baseline = run("b", [1, 2]);
  const again = run("b2", [1, 2]);
  // The candidate moves both catches beside the plant: the headline loses two, the second line none.
  const moved = compareRuns(baseline, again, run("c", [], { beside: [1, 2] }));
  const c = moved.categories["light-file"]!;
  expect([
    c.catches.verdict,
    c.catchesOrBeside.verdict,
    c.linesDisagree,
  ]).toEqual(["worse", "within noise", true]);
  expect(moved.acceptance.linesDisagree).toEqual(["light-file"]);
  expect(moved.acceptance.passes).toBe(false);
});

test("a numeric measure moves only past 2·sqrt(0.75·Σd²) of the baselines' paired differences", () => {
  const baseline = run("b", [1], { offPlant: [0, 1, 0, 1] });
  const again = run("b2", [1], { offPlant: [1, 0, 0, 1] });
  const off = (c: RunScore) =>
    compareRuns(baseline, again, c).overall.measures.find(
      (m) => m.measure === "keptOffPlant",
    )!;
  const within = off(run("c", [1], { offPlant: [1, 1, 1, 1] }));
  expect(within.bar).toBeCloseTo(2 * Math.sqrt(1.5), 9);
  expect([within.candidateShift, within.verdict]).toEqual([2, "within noise"]);
  expect(off(run("c", [1], { offPlant: [2, 2, 1, 2] })).verdict).toBe("worse");
  expect(
    compareRuns(baseline, again, run("c", [1], { offPlant: [2, 2, 1, 2] }))
      .acceptance.passes,
  ).toBe(false);
  expect(off(run("c", [1], { offPlant: [0, 0, 0, 0] })).verdict).toBe(
    "within noise",
  );
  const flat = run("f", [1]);
  const moved = compareRuns(
    flat,
    run("f2", [1]),
    run("c", [1], { offPlant: [0, 0, 0, 1] }),
  ).overall.measures.find((m) => m.measure === "keptOffPlant")!;
  expect([moved.bar, moved.verdict]).toEqual([0, "worse"]);
});

test("seconds are rated only when all three runs are timing runs; the numbers are still given", () => {
  const timed = (name: string, wallS: number[], comparable = true) =>
    run(name, [1], { wallS, timing: comparable });
  const wall = (c: RunScore, b = timed("b", [300, 300, 300, 300])) =>
    compareRuns(b, timed("b2", [300, 300, 300, 300]), c).overall.measures.find(
      (m) => m.measure === "wallS",
    )!;
  expect(wall(timed("c", [600, 600, 600, 600])).verdict).toBe("worse");
  const quality = wall(timed("c", [600, 600, 600, 600], false));
  expect(quality.verdict).toBe("not rated: not all timing runs");
  expect(quality.sums.candidate).toBe(2400);
  const mixed = compareRuns(
    timed("b", [300, 300, 300, 300], false),
    timed("b2", [300, 300, 300, 300]),
    timed("c", [300, 300, 300, 300]),
  );
  expect(mixed.timingsComparable).toBe(false);
  expect(
    mixed.overall.measures.find((m) => m.measure === "kept")!.verdict,
  ).toBe("within noise");
});

/** A full set B record (its strict schema applies) and a full set C one. */
const setB = (over: Record<string, unknown> = {}) => ({
  version: 1,
  caseId: "planted:guard-deletion:x",
  variant: 1,
  host: {
    caseId: "github:a/b:1",
    source: "b",
    number: 1,
    base: "b".repeat(40),
    head: "h".repeat(40),
  },
  problem: "guard-deletion",
  kind: "light-deletion-only",
  style: "check removed",
  bucket: "early",
  aimed: { rank: 1, units: 16, position: 1, order: "directory, path, line" },
  commit: "c".repeat(40),
  message: "m",
  description: "d",
  lines: [{ path: "src/a.ts", side: "old", startLine: 10, endLine: 12 }],
  lineKeys: ["src/a.ts:old:10", "src/a.ts:old:11", "src/a.ts:old:12"],
  mentions: ["guard"],
  expected:
    "a request for changes citing the planted lines, or a person's lane (human-suggested or human-required) with the plant named in what was checked",
  ...over,
});
const setC = (over: Record<string, unknown> = {}) => ({
  version: 1,
  set: "C",
  caseId: "planted:removed-behaviour:x:101",
  variant: 101,
  host: {
    caseId: "github:a/b:2",
    source: "b",
    number: 2,
    base: "b".repeat(40),
    head: "h".repeat(40),
  },
  hostSize: { units: 5, files: 4, size: "small" },
  problem: "removed-behaviour",
  category: "removed-behaviour",
  kind: "source-deletion",
  language: "Go",
  hostTouchesFile: true,
  commit: "c".repeat(40),
  message: "m",
  description: "d",
  lines: [{ path: "cmd/x.go", side: "old", startLine: 40, endLine: 44 }],
  lineKeys: ["cmd/x.go:old:40"],
  related: [{ path: "cmd/y.go", side: "new", startLine: 7, endLine: 9 }],
  beside: [{ path: "cmd/x.go", side: "new", startLine: 39, endLine: 40 }],
  mentions: ["retry"],
  expected:
    "a finding Verify keeps, anchored on the planted lines (for cross-file, naming the related file or a mention)",
  ...over,
});

/** An index over the given records, each pinned by hash, in a fresh folder. */
const indexOf = (
  dir: string,
  records: ReadonlyArray<Record<string, unknown>>,
) => {
  const sha = (path: string) =>
    createHash("sha256").update(readFileSync(path)).digest("hex");
  const pin = (path: string) => ({ path, sha256: sha(path) });
  const variants = records.map((r) => {
    const planted = join(dir, `planted-${String(r["variant"])}.json`);
    const kase = join(dir, `case-${String(r["variant"])}.json`);
    writeFileSync(planted, JSON.stringify(r));
    writeFileSync(
      kase,
      JSON.stringify({
        source: "planted",
        number: r["variant"],
        firstRevision: { base: "b".repeat(40), head: "h".repeat(40) },
      }),
    );
    return { variant: r["variant"], planted: pin(planted), case: pin(kase) };
  });
  const index = join(dir, "set.json");
  writeFileSync(index, JSON.stringify({ variants }));
  return index;
};

test("a variant whose record changed since the index was built is refused, and a run of another range too", () => {
  const dir = mkdtempSync(join(tmpdir(), "finders-gate-"));
  try {
    const index = indexOf(dir, [setB()]);
    const [v] = readSet(index);
    expect(v!.plant.variant).toBe(1);
    // A run whose export names another range than the pinned case is refused, never scored.
    const folder = join(dir, "root", "planted", "1", "run", "r");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "findings.json"), JSON.stringify(read([])));
    writeFileSync(join(folder, "export.json"), JSON.stringify(exported()));
    expect(readRun(join(dir, "root"), v!, "r").exported).not.toBeNull();
    writeFileSync(
      join(folder, "export.json"),
      JSON.stringify(
        exported({ case: { base: "b".repeat(40), head: "x".repeat(40) } }),
      ),
    );
    expect(() => readRun(join(dir, "root"), v!, "r")).toThrow(
      /pinned case's range/,
    );
    // A review recorded but not yet read is not a run.
    writeFileSync(
      join(folder, "export.json"),
      JSON.stringify({ reviewed: true, finished: false }),
    );
    expect(readRun(join(dir, "root"), v!, "r")).toEqual({
      findings: null,
      exported: null,
    });
    writeFileSync(
      join(dir, "planted-1.json"),
      JSON.stringify(setB({ problem: "doc-misleads" })),
    );
    expect(() => readSet(index)).toThrow(/changed since/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a set C record reads through its own schema and scores in its category; one it rejects is an error, not a dropped variant", () => {
  const dir = mkdtempSync(join(tmpdir(), "finders-gate-"));
  try {
    const [b, c] = readSet(indexOf(dir, [setB(), setC()]));
    expect([categoryOf(b!.plant), categoryOf(c!.plant)]).toEqual([
      "light-file",
      "removed-behaviour",
    ]);
    expect(b!.plant.beside).toBeUndefined();
    const scored = scoreVariant(
      c!.plant,
      read([
        finding("kept", {
          path: "cmd/x.go",
          side: "old",
          startLine: 44,
          endLine: 46,
        }),
      ]),
      exported(),
    );
    expect([
      scored.category,
      scored.outcome,
      scored.set,
      scored.language,
      scored.hostSize,
      scored.hostTouchesFile,
    ]).toEqual(["removed-behaviour", "caught", "C", "Go", "small", true]);
    // A new-side anchor at the deletion point is beside the plant; on the related lines too.
    expect(
      scoreVariant(
        c!.plant,
        read([
          finding("kept", {
            path: "cmd/x.go",
            side: "new",
            startLine: 40,
            endLine: 44,
          }),
        ]),
        exported(),
      ).outcome,
    ).toBe("caught-beside");
    expect(
      scoreVariant(
        c!.plant,
        read([
          finding("kept", {
            path: "cmd/y.go",
            side: "new",
            startLine: 8,
            endLine: 8,
          }),
        ]),
        exported(),
      ).outcome,
    ).toBe("caught-beside");
    expect(
      scoreVariant(
        c!.plant,
        read([
          finding("kept", {
            path: "cmd/x.go",
            side: "new",
            startLine: 60,
            endLine: 61,
          }),
        ]),
        exported(),
      ).outcome,
    ).toBe("missed");
    // Without `beside` (records before the rebuild) it still reads.
    const plain = setC();
    delete (plain as Record<string, unknown>)["beside"];
    expect(
      readSet(
        indexOf(mkdtempSync(join(tmpdir(), "finders-gate-")), [plain]),
      )[0]!.plant.beside,
    ).toBeUndefined();
    const broken = mkdtempSync(join(tmpdir(), "finders-gate-"));
    try {
      const bad = setC();
      delete (bad as Record<string, unknown>)["hostTouchesFile"];
      expect(() => readSet(indexOf(broken, [bad]))).toThrow();
      expect(() => readSet(indexOf(broken, [setC({ set: "D" })]))).toThrow(
        /unknown set/,
      );
    } finally {
      rmSync(broken, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the merit pack holds only kept findings off the plant, and the key turns marks into a false rate per run", () => {
  const variant = {
    plant: plant(),
    source: "planted",
    number: 1,
    index: "i",
    casePath: "c",
    base: "b",
    head: "h",
  };
  const off = finding(
    "kept",
    { startLine: 50, endLine: 50 },
    { id: "tests.1" },
  );
  const { pack, key } = meritPack(
    [
      {
        run: "a",
        variant,
        findings: [
          finding("kept"),
          off,
          finding("dropped", { startLine: 60, endLine: 60 }),
        ],
      },
      { run: "b", variant, findings: [off, { ...off, id: "tests.2" }] },
    ],
    () => [{ n: 50, text: "line" }],
  );
  expect(pack.items).toHaveLength(3);
  expect(JSON.stringify(pack)).not.toContain('"run"');
  const [first, second, third] = pack.items.map((i) => i.item);
  const rates = meritRead(
    {
      packId: pack.packId,
      marks: { [first!]: "false", [second!]: "real", [third!]: "false" },
    },
    key,
  );
  expect(Object.values(rates.runs).reduce((t, r) => t + r.false, 0)).toBe(2);
  expect(rates.runs["a"]!.items + rates.runs["b"]!.items).toBe(3);
  expect(() => meritRead({ packId: "other", marks: {} }, key)).toThrow(
    /another pack/,
  );
});

const lensRecords = () =>
  Object.fromEntries(
    LENS_NAMES.map((l) => [l, { output: "found" as const, runLog: "agrees" }]),
  );
const delivery = (
  state: "recorded" | "none" | "not measured",
  opening: { added: number; deleted: number } | null,
  fetched: { added: number; deleted: number },
) => ({
  openingState: state,
  opening,
  fetched,
  seen:
    opening === null
      ? null
      : {
          added: Math.min(10, opening.added + fetched.added),
          deleted: Math.min(4, opening.deleted + fetched.deleted),
        },
});

test("what the finders were shown and what they fetched are kept apart, for the range and for the plant", () => {
  // Why (round 2): on slice B much of the change is in the opening; one number for both would show a
  // loss or a gain that is not one.
  const reads = {
    correctness: {
      read: [] as Array<[string, "old" | "new", number, number]>,
      diff: [] as Array<[string, "old" | "new", number, number]>,
      opening: [["src/a.ts", "old", 9, 13]] as Array<
        [string, "old" | "new", number, number]
      >,
      openingState: "recorded" as const,
    },
    tests: {
      read: [["src/z.ts", "new", 1, 2]] as Array<
        [string, "old" | "new", number, number]
      >,
      diff: [["src/a.ts", "old", 11, 11]] as Array<
        [string, "old" | "new", number, number]
      >,
      opening: [] as Array<[string, "old" | "new", number, number]>,
      openingState: "none" as const,
    },
  };
  const v = scoreVariant(
    plant({
      beside: [{ path: "src/b.ts", side: "new", startLine: 4, endLine: 4 }],
    }),
    {
      status: "read",
      findings: [],
      lenses: lensRecords(),
      reads,
    },
    exported({
      rangeLines: {
        added: 10,
        deleted: 4,
        allFinders: delivery(
          "recorded",
          { added: 0, deleted: 3 },
          { added: 2, deleted: 1 },
        ),
      },
    }),
  );
  expect(v.plantViews).toEqual({
    opening: true,
    fetched: true,
    seen: true,
    finders: { correctness: "opening", tests: "fetched" },
  });
  expect(v.nearViews).toEqual({
    opening: false,
    fetched: false,
    seen: false,
    finders: { correctness: "", tests: "" },
  });
  expect([v.delivery.state, v.delivery.opening, v.delivery.fetched]).toEqual([
    "recorded",
    { added: 0, deleted: 3 },
    { added: 2, deleted: 1 },
  ]);
  // An opening not measured makes "in the opening" and "seen" unknown, never 0.
  const unknown = scoreVariant(
    plant(),
    {
      status: "read",
      findings: [],
      lenses: lensRecords(),
      reads: {
        correctness: {
          ...reads.correctness,
          opening: null,
          openingState: "not measured",
        },
      },
    },
    exported(),
  );
  expect([unknown.plantViews?.opening, unknown.plantViews?.seen]).toEqual([
    null,
    null,
  ]);
});

test("a reader before round 2 gives only fetched, and a finding dropped for want of a group was never judged", () => {
  const old = scoreVariant(
    plant(),
    read([finding("no-group")]),
    exported({
      rangeLines: {
        added: 10,
        deleted: 4,
        anyFinder: { newRead: 6, oldRead: 2 },
      },
    }),
  );
  expect([old.delivery.state, old.delivery.fetched, old.delivery.seen]).toEqual(
    ["not recorded", { added: 6, deleted: 2 }, null],
  );
  expect([old.outcome, old.notSent, old.findings]).toEqual([
    "found-not-kept",
    1,
    0,
  ]);
});

test("compare rates only what means the same when the change reaches the finders differently", () => {
  const withDelivery = (name: string, d: ReturnType<typeof delivery>) =>
    run(name, [1, 2], {
      exportOver: { rangeLines: { added: 10, deleted: 4, allFinders: d } },
    });
  const lookups = delivery(
    "none",
    { added: 0, deleted: 0 },
    { added: 6, deleted: 2 },
  );
  const opening = delivery(
    "recorded",
    { added: 8, deleted: 4 },
    { added: 2, deleted: 0 },
  );
  const result = compareRuns(
    withDelivery("b", lookups),
    withDelivery("b2", lookups),
    withDelivery("c", opening),
  );
  expect([
    result.delivery.baseline,
    result.delivery.candidate,
    result.delivery.differs,
  ]).toEqual(["lookups", "opening", true]);
  const verdict = (name: string) =>
    result.overall.measures.find((m) => m.measure === name)!.verdict;
  expect(verdict("rangeFetchedShare")).toBe(
    "not rated: the change reaches the finders differently",
  );
  expect(verdict("rangeOpeningShare")).toBe(
    "not rated: the change reaches the finders differently",
  );
  expect(verdict("rangeSeenShare")).toBe("better"); // 8/14 against 10/14 seen, a bar of 0
  expect(verdict("kept")).toBe("within noise");
  // The same delivery on all three: every measure is rated.
  const same = compareRuns(
    withDelivery("b", opening),
    withDelivery("b2", opening),
    withDelivery("c", opening),
  );
  expect(same.delivery.differs).toBe(false);
  expect(
    same.overall.measures.find((m) => m.measure === "rangeFetchedShare")!
      .verdict,
  ).toBe("within noise");
});

test("compare says when the runs' findings were written by different readers", () => {
  const withReader = (name: string, reader?: Record<string, string>) => {
    const r = run(name, [1]);
    const variants = r.variants.map((v) => ({
      ...v,
      reader: reader === undefined ? null : JSON.stringify(reader),
    }));
    return { ...r, variants, overall: summarise(variants) };
  };
  const a = { "store_findings.py": "aaa" };
  expect(
    compareRuns(withReader("b", a), withReader("b2", a), withReader("c", a))
      .readers.differ,
  ).toBe(false);
  const mixed = compareRuns(
    withReader("b"),
    withReader("b2", a),
    withReader("c", a),
  );
  expect([mixed.readers.differ, mixed.readers.baseline]).toEqual([
    true,
    [null],
  ]);
});

test("an export written by the reader before round 2 is read, as not recorded", () => {
  // Why (B1): the round 2 schema refused `rangeLines.byFinder` as the older reader writes it, so `score`
  // and `compare` crashed on every finished real review. The shape below is copied from a real export of
  // that reader (planted/104, base-1): counts only.
  const older = {
    status: "ok",
    native: "snapshot",
    unknownContexts: {},
    added: 103,
    deleted: 6,
    anyFinder: { oldRead: 6, newRead: 103 },
    byFinder: {
      correctness: { oldRead: 4, newRead: 103 },
      "risky-edges": { oldRead: 4, newRead: 103 },
      "scope-fit": { oldRead: 6, newRead: 103 },
      tests: { oldRead: 4, newRead: 103 },
    },
  };
  const exported_ = ExportFile.parse({ ...exported(), rangeLines: older });
  const v = scoreVariant(plant(), read([finding("kept")]), exported_);
  expect([v.status, v.outcome, v.delivery.state]).toEqual([
    "scored",
    "caught",
    "not recorded",
  ]);
  expect([
    v.delivery.fetched,
    v.delivery.opening,
    v.delivery.seen,
    v.delivery.byFinder,
  ]).toEqual([{ added: 103, deleted: 6 }, null, null, {}]);
  // A round 2 reader that found no manifest is not "an older reader" (N35).
  const noManifest = scoreVariant(
    plant(),
    read([finding("kept")]),
    ExportFile.parse({
      ...exported(),
      rangeLines: {
        status: "no-manifest",
        native: "live",
        unknownContexts: {},
        openingRow: "absent",
      },
    }),
  );
  expect(noManifest.delivery.state).toBe("no manifest");
});

test("the exports the readings gate shares: canonical, and the completion check without the finder lenses", () => {
  expect(canonical({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe(
    canonical({ a: [2, { c: 4, d: 3 }], b: 1 }),
  );
  expect(canonical({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  expect(reviewNotComplete(exported())).toEqual([]);
  expect(
    reviewNotComplete(exported({ exit: 1, killedAfterGrace: true })),
  ).toEqual(["exit 1", "killed after grace"]);
  // No lens part: a findings record that lost a lens leaves the export-only check untouched.
  expect(
    reviewNotComplete(exported({ machine: { end: { membersLeft: 1 } } })),
  ).toEqual(["the case did not end"]);
});
