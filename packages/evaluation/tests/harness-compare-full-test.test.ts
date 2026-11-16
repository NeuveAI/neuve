// Why: the full test (10.89) turns stored runs into the numbers the owner will choose hills from,
// with no model judge. Each piece below decides something the totals would hide if it were wrong:
// which leads row feeds which harness hunk (a wrong match silently swaps a hunk's arm), the
// pre-registered statistics (kappa, the adjusted Rand index, FT5's separability rule and its
// leave-one-family-out), the hunk-to-unit mapping the agreement figures rest on, the rule checks
// (10.9, 4.4, 10.55, 10.82, 10.83, 10.86, 10.69, 10.87), the known-case catch, the run order and
// stop classification, the sheet's bounded sample, and the planted cases' line rules. The inputs are
// stubs shaped like `review show --json` and the labelling side's leads rows; no model is called.
// The tests that run git have a longer limit than bun's default.
import { afterAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import {
  matchHunks,
  servedChunkIds,
} from "../src/harness-compare/harness-side.ts";
import {
  assertPinned,
  linkModules,
  understandComputed,
  understandDone,
} from "../src/harness-compare/runner.ts";
import { root } from "../src/harness-compare/common.ts";
import {
  leadDifferences,
  matchLeads,
  normaliseRow,
  rowsForRange,
  servedTop3Differ,
  type LeadsRow,
} from "../src/harness-compare/full-test/leads-file.ts";
import {
  approvalCatch,
  caughtDefect,
  citedRegions,
  dispositionChecks,
  hunkViews,
  laneChecks,
  referencesCover,
  rollUp,
  type AssessmentLite,
  type PacketUnitLite,
  type StoredRun,
} from "../src/harness-compare/full-test/packets.ts";
import {
  afterReRequest,
  failureOf,
  storeAfter,
  jobToDrop,
  latestRuns,
  planRuns,
  seedInputFor,
  writeHomeSettings,
  type PlannedRange,
} from "../src/harness-compare/full-test/phases.ts";
import {
  buildPlanted,
  checkKind,
  kindOf,
  plantFromBundles,
} from "../src/harness-compare/full-test/planted.ts";
import {
  carryLine,
  changedOldLines,
  parseHeaders,
} from "../src/harness-compare/full-test/later-fixes.ts";
import {
  attributeEntries,
  ft17Trigger,
  searchShareByFamily,
  type AttributableEntry,
  type SearchExposure,
} from "../src/harness-compare/full-test/search-attribution.ts";
import {
  SheetFile,
  drawMarginCards,
  marginCardKey,
  marginSheetItem,
  maskLaneWords,
  parseReferenceSummary,
  sampleSheet,
  stableId,
  unitSheetItem,
  type SheetUnit,
} from "../src/harness-compare/full-test/sheet.ts";
import { z } from "zod";
import {
  adjustedRandIndex,
  agreement,
  cohensKappa,
  matchGroups,
  matchObligations,
  separability,
  type PairedValue,
} from "../src/harness-compare/full-test/stats.ts";

const scratch = mkdtempSync(join(tmpdir(), "full-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// Leads rows

const row = (over: Partial<LeadsRow> = {}): LeadsRow => ({
  caseId: "neuve:a..b",
  hunkId: null,
  file: "main",
  path: "src/a.ts",
  oldPath: "src/a.ts",
  old: { start: 10, lines: 2 },
  new: { start: 10, lines: 3 },
  diffText: "@@ -10,2 +10,3 @@\n-a\n+b\n+c\n",
  queryText: "q",
  regions: [
    ["src/x.ts", 1, 10, null, "code", 40, 0.9],
    ["src/y.ts", 5, 9, null, "code", 20, 0.8],
    ["src/z.ts", 1, 3, null, "code", 10, 0.7],
    ["src/w.ts", 1, 3, null, "code", 10, 0.6],
  ],
  graph: "answered",
  ...over,
});

const harnessHunk = (
  hunkId: string,
  text: string,
  over: Record<string, unknown> = {},
) => ({
  hunkId,
  kind: "text",
  path: "src/a.ts",
  oldPath: "src/a.ts",
  oldStart: 10,
  oldLines: 2,
  newStart: 10,
  newLines: 3,
  text,
  ...over,
});

test("leads rows match harness hunks by diff text first, a trailing newline aside, and a row is used once", () => {
  const exact = row();
  const sameHeaderOtherText = row({
    diffText: "@@ -10,2 +10,3 @@\n-x\n+y\n+z\n",
    new: { start: 40, lines: 3 },
    old: { start: 40, lines: 2 },
  });
  const matches = matchLeads(
    [
      harnessHunk("h1", "@@ -10,2 +10,3 @@\n-a\n+b\n+c"),
      harnessHunk("h2", "different text", { oldStart: 40, newStart: 40 }),
      harnessHunk("h3", "no row has this", { oldStart: 90, newStart: 90 }),
    ],
    [exact, sameHeaderOtherText],
  );
  expect(matches.map((m) => [m.harnessHunkId, m.how])).toEqual([
    ["h1", "text"],
    ["h2", "exact"],
    ["h3", "none"],
  ]);
  expect(matches[0]!.row).toBe(exact);
});

test("the runner's seed matching prefers diff text over the header when the input carries it", () => {
  const records = [
    { ...harnessHunk("h1", "first"), kind: "text" as const },
    { ...harnessHunk("h2", "second"), kind: "text" as const },
  ];
  const [match] = matchHunks(
    [
      {
        hunkId: "m",
        path: "src/a.ts",
        oldPath: "src/a.ts",
        old: { start: 10, lines: 2 },
        new: { start: 10, lines: 3 },
        queryText: "",
        regions: [],
        diffText: "second\n",
      },
    ],
    records,
  );
  expect(match).toEqual({ m4HunkId: "m", harnessHunkId: "h2", how: "text" });
});

test("a seed input carries every row's diff text and only the top 10 regions", () => {
  const regions = Array.from(
    { length: 50 },
    (_, i) =>
      [
        "src/r.ts",
        i + 1,
        i + 1,
        null,
        "code",
        1,
        1 - i / 100,
      ] as LeadsRow["regions"][number],
  );
  const input = seedInputFor("R(H3-E0)", "b".repeat(40), "c".repeat(40), [
    row({ regions }),
  ]);
  expect(input.hunks[0]!.regions).toHaveLength(10);
  expect(input.hunks[0]!.diffText).toBe(row().diffText);
  expect(input.candidate).toBe("R(H3-E0)");
});

test("lead differences count top-3 and top-10 sets, and served top 3 compare harness chunks", () => {
  const a = new Map([["neuve:a..b", [row()]]]);
  const b = new Map([
    [
      "neuve:a..b",
      [
        row({
          regions: [
            row().regions[1]!,
            row().regions[0]!,
            row().regions[2]!,
            ["src/v.ts", 1, 2, null, "code", 5, 0.1],
          ],
        }),
      ],
    ],
  ]);
  const diff = leadDifferences(a, b);
  // Same top 3 in another order; the fourth differs.
  expect(diff.top3Differ).toBe(0);
  expect(diff.top10Differ).toBe(1);
  const served = servedTop3Differ(
    new Map([
      ["r\u0000h1", ["c1", "c2", "c3"]],
      ["r\u0000h2", ["c1", "c2", "c3"]],
      ["r\u0000h3", null],
    ]),
    new Map([
      ["r\u0000h1", ["c3", "c2", "c1"]],
      ["r\u0000h2", ["c1", "c2", "c9"]],
      ["r\u0000h3", null],
    ]),
  );
  expect(served).toEqual({ hunks: 3, differ: 1, share: 1 / 3 });
});

// Statistics

test("Cohen's kappa matches a worked example and is 1 on identical ratings", () => {
  // 50 items: 20 yes-yes, 5 yes-no, 10 no-yes, 15 no-no. po = 0.7, pe = 0.5*0.6 + 0.5*0.4 = 0.5.
  const pairs = [
    ...Array.from({ length: 20 }, () => ["yes", "yes"]),
    ...Array.from({ length: 5 }, () => ["yes", "no"]),
    ...Array.from({ length: 10 }, () => ["no", "yes"]),
    ...Array.from({ length: 15 }, () => ["no", "no"]),
  ].map(([x, y], i) => ({
    family: `f${i % 5}`,
    caseId: `c${i % 10}`,
    x: x!,
    y: y!,
  }));
  const k = cohensKappa(pairs);
  expect(k.observed).toBeCloseTo(0.7, 10);
  expect(k.kappa).toBeCloseTo(0.4, 10);
  expect(cohensKappa(pairs.map((p) => ({ ...p, y: p.x }))).kappa).toBe(1);
  const withCi = agreement(pairs, { resamples: 500 });
  expect(withCi.kappa).toBeCloseTo(0.4, 10);
  expect(withCi.kappaCi95[0]!).toBeLessThanOrEqual(0.4);
  expect(withCi.kappaCi95[1]!).toBeGreaterThanOrEqual(0.4);
});

test("the adjusted Rand index is 1 for the same partition under other names and matches a worked example", () => {
  const a = new Map([
    ["h1", "x"],
    ["h2", "x"],
    ["h3", "y"],
    ["h4", "y"],
  ]);
  const renamed = new Map([
    ["h1", "p"],
    ["h2", "p"],
    ["h3", "q"],
    ["h4", "q"],
  ]);
  expect(adjustedRandIndex(a, renamed).ari).toBe(1);
  // {1,2,3},{4,5,6} against {1,2},{3,4},{5,6}: index 2, row sums 6, column sums 3, pairs 15,
  // expected 1.2, max 4.5, ARI (2 - 1.2) / (4.5 - 1.2) = 0.2424…
  const left = new Map(
    ["1", "2", "3", "4", "5", "6"].map((h, i) => [h, i < 3 ? "a" : "b"]),
  );
  const right = new Map(
    ["1", "2", "3", "4", "5", "6"].map((h, i) => [h, `g${Math.floor(i / 2)}`]),
  );
  expect(adjustedRandIndex(left, right).ari).toBeCloseTo(0.8 / 3.3, 10);
  expect(
    adjustedRandIndex(new Map([["h1", "x"]]), new Map([["h1", "x"]])).ari,
  ).toBeNull();
});

test("groups match one to one by Jaccard at 0.5, and obligations by basis and normalised text", () => {
  const m = matchGroups(
    [
      { id: "a1", members: new Set(["h1", "h2"]) },
      { id: "a2", members: new Set(["h3"]) },
    ],
    [
      { id: "b1", members: new Set(["h1", "h2", "h3"]) },
      { id: "b2", members: new Set(["h4"]) },
    ],
  );
  // a1-b1 is 2/3; a2-b1 is 1/3, under the threshold; b1 is taken once.
  expect(m.pairs).toEqual([{ left: "a1", right: "b1", jaccard: 2 / 3 }]);
  expect(m.leftMatched).toBe(0.5);
  const o = matchObligations(
    [
      { basis: "plan", text: "Drops label regions, on empty files!" },
      { basis: "plan", text: "other" },
    ],
    [{ basis: "plan", text: "drops label regions on empty files" }],
  );
  expect(o.matched).toBe(1);
  expect(o.rightMatched).toBe(1);
});

const pairs = (deltas: ReadonlyArray<[string, number]>): Array<PairedValue> =>
  deltas.map(([family, delta], i) => ({
    hunkId: `h${i}`,
    family,
    caseId: `${family}-c`,
    a: 0.5 + delta,
    x: 0.5,
  }));

test("FT5: separable only when the interval excludes zero and mean |δ| clears the noise floor", () => {
  const families = ["f1", "f2", "f3", "f4", "f5", "f6"];
  const big = pairs(
    families.flatMap(
      (f) =>
        [
          [f, 0.3],
          [f, 0.25],
        ] as Array<[string, number]>,
    ),
  );
  const noise = pairs(
    families.flatMap(
      (f) =>
        [
          [f, 0.02],
          [f, -0.03],
        ] as Array<[string, number]>,
    ),
  );
  const result = separability(big, noise);
  expect(result.familyWeighted.excludesZero).toBe(true);
  expect(result.familyWeighted.separable).toBe(true);
  // The same difference against a floor as large as itself is not separable.
  const loud = pairs(
    families.flatMap(
      (f) =>
        [
          [f, 0.4],
          [f, -0.4],
        ] as Array<[string, number]>,
    ),
  );
  expect(separability(big, loud).familyWeighted.separable).toBe(false);
  // Without a floor (A′ did not cover these hunks) nothing is called separable.
  expect(separability(big, null).familyWeighted.separable).toBe(false);
}, 30_000);

test("FT5's leave-one-family-out names a family a result rests on", () => {
  const families = ["f1", "f2", "f3", "f4", "f5", "f6"];
  // Every family moves the same way, but only f1 by more than the noise.
  const lopsided = pairs(
    families.flatMap(
      (f) =>
        [
          [f, f === "f1" ? 0.9 : 0.01],
          [f, f === "f1" ? 0.9 : 0.01],
        ] as Array<[string, number]>,
    ),
  );
  const noise = pairs(
    families.flatMap(
      (f) =>
        [
          [f, 0.02],
          [f, -0.02],
        ] as Array<[string, number]>,
    ),
  );
  const result = separability(lopsided, noise);
  expect(result.familyWeighted.separable).toBe(true);
  expect(result.restsOn).toEqual(["f1"]);
  expect(
    result.leaveOneFamilyOut.find((entry) => entry.family === "f2")
      ?.losesSeparability,
  ).toBe(false);
}, 30_000);

// Packets

const assessment = (
  over: Partial<AssessmentLite["payload"]> = {},
): AssessmentLite => ({
  id: "01ASSESSMENT0000000000000",
  payload: {
    lane: "agentic",
    quadrant: "low-easy",
    complexity: { level: "low", factors: [{ cites: ["c1"] }] },
    easeOfValidation: {
      level: "easy",
      requirements: [
        { requirement: "r", cites: ["c1"], coverage: "missing", proof: [] },
      ],
    },
    movement: [],
    gaps: [],
    rationale: "r",
    ...over,
  },
});

const unit = (
  unitId: string,
  over: Partial<PacketUnitLite> = {},
): PacketUnitLite => ({
  unitId,
  recorded: {
    payload: {
      title: unitId,
      ownedRanges: [
        {
          kind: "lines",
          path: "src/a.ts",
          side: "new",
          startLine: 10,
          endLine: 12,
        },
      ],
    },
  },
  assessment: assessment(),
  content: {},
  references: [],
  comments: [],
  ...over,
});

const stored = (
  units: ReadonlyArray<PacketUnitLite>,
  hunks = [harnessHunk("h1", "t")],
): StoredRun => ({
  packet: { complete: true, batches: [{ batchId: "b1", units }], gaps: [] },
  manifest: { hunks: hunks.map((h) => ({ ...h, newPath: h.path })) },
});

test("a hunk takes the unit owning most of its changed lines; an unassessed unit says so", () => {
  const big = unit("u-big", {
    recorded: {
      payload: {
        title: "big",
        ownedRanges: [
          {
            kind: "lines",
            path: "src/a.ts",
            side: "new",
            startLine: 10,
            endLine: 11,
          },
        ],
      },
    },
  });
  const { assessment: _never, ...small } = unit("u-small", {
    recorded: {
      payload: {
        title: "small",
        ownedRanges: [
          {
            kind: "lines",
            path: "src/a.ts",
            side: "new",
            startLine: 12,
            endLine: 12,
          },
        ],
      },
    },
  });
  const [view] = hunkViews(stored([small, big]));
  expect(view).toMatchObject({
    hunkId: "h1",
    unitId: "u-big",
    owners: 2,
    assessed: true,
    lane: "agentic",
  });
  const [alone] = hunkViews(stored([small]));
  expect(alone).toMatchObject({
    unitId: "u-small",
    assessed: false,
    lane: null,
  });
});

test("lane checks flag 10.9, 4.4, 10.55 and 10.82, and count 10.55's case", () => {
  const pinned = unit("u1", {
    assessment: assessment({
      lane: "human-suggested",
      quadrant: "high-hard",
      complexity: { level: "high", factors: [{ cites: ["c"] }] },
      easeOfValidation: {
        level: "hard",
        requirements: [
          { requirement: "r", cites: ["c"], coverage: "missing", proof: [] },
        ],
      },
      gaps: [{ axis: "complexity", kind: "x" }],
    }),
  });
  const gapAgentic = unit("u2", {
    assessment: assessment({ gaps: [{ axis: "complexity", kind: "x" }] }),
  });
  const case1055 = unit("u3", {
    assessment: assessment({
      lane: "agentic",
      quadrant: "high-easy",
      complexity: { level: "high", factors: [{ cites: ["c"] }] },
      gaps: [{ axis: "ease-of-validation", kind: "x" }],
    }),
  });
  const staticOpen = unit("u4", {
    assessment: assessment({ lane: "static-automation" }),
  });
  const fine = unit("u5", {
    assessment: assessment({
      lane: "human-suggested",
      quadrant: "high-easy",
      complexity: { level: "high", factors: [{ cites: ["c"] }] },
      gaps: [{ axis: "ease-of-validation", kind: "x" }],
    }),
  });
  const result = laneChecks(
    stored([pinned, gapAgentic, case1055, staticOpen, fine]),
  );
  const rules = result.violations.map((v) => `${v.unitId}:${v.rule}`).sort();
  expect(rules).toEqual(
    ["u1:10.9", "u2:4.4", "u3:10.55", "u3:4.4", "u4:10.82"].sort(),
  );
  expect(result.case1055).toBe(2);
  expect(result.staticUnits).toBe(1);
});

const disposition = (
  verdict: "approve" | "request-changes",
  restsOn: ReadonlyArray<string> = [],
  proof: ReadonlyArray<string> = [],
) => ({
  id: "01DISPOSITION000000000000",
  payload: { verdict, restsOn, proof },
});

test("disposition checks flag 10.86, 10.83 and 10.69, and a digest roll-up that does not match its rows", () => {
  const approvedNotMet = unit("u1", {
    disposition: disposition("approve"),
    content: {
      guided: {
        rows: [
          {
            row: "g1",
            text: "t",
            basis: "b",
            scope: "this unit",
            required: true,
            status: "not-met",
            evidence: [],
          },
        ],
        proof: "Proof (10.83): proof is not recorded.",
      },
    },
  });
  const approvedSilent = unit("u2", {
    disposition: disposition("approve"),
    content: {
      guided: { rows: [], proof: "Proof (10.83): rests on nothing." },
    },
  });
  const request = unit("u3", {
    disposition: disposition("request-changes", ["01RISK00000000000000000000"]),
    comments: [
      {
        id: "01RISK00000000000000000000",
        payload: {
          body: "b",
          finding: { kind: "risk", about: "code", evidence: [] },
        },
      },
    ],
  });
  const run = stored([approvedNotMet, approvedSilent, request]);
  const withDigest: StoredRun = {
    ...run,
    packet: {
      ...run.packet!,
      batches: [
        {
          ...run.packet!.batches[0]!,
          digest: {
            obligations: [
              {
                row: "g1",
                overall: "met",
                units: [{ unit: "u1", status: "not-met", required: true }],
              },
            ],
          },
        },
      ],
    },
  };
  const result = dispositionChecks(withDigest);
  expect(result.violations.map((v) => `${v.unitId}:${v.rule}`).sort()).toEqual([
    "b1:10.87",
    "u1:10.86",
    "u2:10.83",
    "u3:10.69",
  ]);
  expect(result.counts).toMatchObject({
    approvals: 2,
    requests: 1,
    uncitedRequests: 0,
    approvalsWithoutProof: 2,
  });
  expect(
    rollUp([
      { status: "met", required: true },
      { status: "no-evidence", required: true },
    ]),
  ).toBe("met on 1 of 2 units");
});

test("a known defect counts as caught only through a request for changes resting on a defect at its lines", () => {
  const defect = [
    { path: "src/b.ts", side: "new" as const, startLine: 30, endLine: 34 },
  ];
  const at = (
    anchorLine: number | null,
    evidence: string | null,
    verdict: "approve" | "request-changes",
  ) =>
    stored([
      unit("u1", {
        disposition: disposition(
          verdict,
          verdict === "request-changes" ? ["01DEFECT000000000000000000"] : [],
        ),
        comments: [
          {
            id: "01DEFECT000000000000000000",
            payload: {
              body: "b",
              ...(anchorLine === null
                ? {}
                : {
                    anchor: {
                      path: "src/b.ts",
                      side: "new" as const,
                      startLine: anchorLine,
                      endLine: anchorLine,
                    },
                  }),
              finding: {
                kind: "defect",
                about: "code",
                evidence:
                  evidence === null
                    ? []
                    : [{ ref: "computation:x", entry: evidence }],
              },
            },
          },
        ],
      }),
    ]);
  expect(caughtDefect(at(31, null, "request-changes"), defect).caught).toBe(
    true,
  );
  expect(
    caughtDefect(at(null, "src/b.ts:33", "request-changes"), defect).hits[0]
      ?.how,
  ).toBe("evidence");
  expect(caughtDefect(at(80, null, "request-changes"), defect).caught).toBe(
    false,
  );
  const approved = caughtDefect(at(31, null, "approve"), defect);
  expect(approved).toMatchObject({
    caught: false,
    mentionedWithoutRequest: true,
  });
  const covered = stored([
    unit("u1", {
      references: [
        {
          id: "r",
          payload: {
            summary: "s",
            anchor: {
              path: "src/a.ts",
              side: "new",
              startLine: 10,
              endLine: 10,
            },
            stance: "supports",
            origin: "committed",
            provenance: {
              kind: "git",
              revision: "a".repeat(40),
              path: "src/b.ts",
              startLine: 1,
              endLine: 31,
            },
          },
        },
      ],
    }),
  ]);
  expect(referencesCover(covered, defect)).toBe(true);
  expect(referencesCover(stored([unit("u1")]), defect)).toBe(false);
});

// Runner

const range = (
  key: string,
  kind: PlannedRange["kind"],
  phases: PlannedRange["phases"],
  order: number,
  pilot = false,
): PlannedRange => ({
  key,
  order,
  caseId: `case-${key}`,
  kind,
  family: "f",
  source: "/repo",
  base: "b",
  head: "h",
  phases,
  gen0Only: kind === "probe",
  copyProofs: false,
  proofSource: null,
  named: false,
  pilot,
});

test("runs go phase by phase in the order A, C, A′, U′, B, each across its ranges; the pilot is the first 3", () => {
  const all = ["A", "C", "A2", "U2", "B"] as const;
  const ranges = [
    range("d2", "dev", all, 2, true),
    range("d1", "dev", all, 1, true),
    range("d4", "dev", all, 4),
    range("s1", "probe", ["A"], 100),
    range("k1", "known", ["A", "A2"], 200),
  ];
  const order = planRuns(ranges).map(
    ({ phase, range: r }) => `${phase.id}:${r.key}`,
  );
  expect(order).toEqual([
    "A:d1",
    "A:d2",
    "A:d4",
    "A:s1",
    "A:k1",
    "C:d1",
    "C:d2",
    "C:d4",
    "A2:d1",
    "A2:d2",
    "A2:d4",
    "A2:k1",
    "U2:d1",
    "U2:d2",
    "U2:d4",
    "B:d1",
    "B:d2",
    "B:d4",
  ]);
  expect(
    planRuns(ranges, { pilot: true, phases: ["A", "B"] }).map(
      ({ phase, range: r }) => `${phase.id}:${r.key}`,
    ),
  ).toEqual(["A:d1", "A:d2", "B:d1", "B:d2"]);
});

test("stop-after-Understand fires once the partition plan over the change map is recorded", () => {
  expect(
    understandDone([
      { type: "stage", stage: "understand", status: "computed" },
    ]),
  ).toBe(false);
  expect(understandDone([{ type: "investigate.plan", partitions: [] }])).toBe(
    true,
  );
});

test("failures that count toward FT14's systematic stop: every outcome a phase does not intend", () => {
  const base = {
    modelCalls: 5,
    outcome: "completed",
    stoppedByWatcher: false,
    packetPublished: true,
    stop: "full" as const,
    finished: false,
  };
  expect(failureOf(base)).toBeNull();
  expect(failureOf({ ...base, outcome: "timed-out" })).toBeNull();
  expect(failureOf({ ...base, modelCalls: 0 })).toBe("no-model-call");
  expect(failureOf({ ...base, outcome: "no receipt" })).toBe("no-receipt");
  expect(failureOf({ ...base, packetPublished: false })).toBe("no-packet");
  expect(failureOf({ ...base, outcome: "stopped" })).toBe("outcome:stopped");
  // A run stopped after Investigate has no receipt by design, and fails only when unfinished.
  expect(
    failureOf({
      ...base,
      outcome: "investigate-complete",
      stop: "after-investigate",
      finished: true,
    }),
  ).toBeNull();
  expect(
    failureOf({ ...base, outcome: "stopped", stop: "after-investigate" }),
  ).toBe("investigate-unfinished");
  expect(
    failureOf({ ...base, outcome: "stopped", stop: "after-understand" }),
  ).toBe("understand-unfinished");
  expect(failureOf({ ...base, understandRecomputed: true })).toBe(
    "understand-not-shared",
  );
});

test("each run is reported from its latest attempt; B's continuation stands apart", () => {
  const entry = (
    phase: string,
    caseId: string,
    gen0Outcome: string,
    at: string,
  ) => ({ phase, caseId, gen0Outcome, at });
  const latest = latestRuns([
    entry("A", "r1", "timed-out", "1"),
    entry("A", "r1", "completed", "2"),
    entry("B", "r1", "completed", "3"),
    entry("B", "r1", "continuation", "4"),
  ]);
  expect(latest.map((run) => `${run.phase}:${run.at}`).sort()).toEqual([
    "A:2",
    "B:3",
    "B:4",
  ]);
});

// The sheet

test("the sheet draws FT13's buckets in priority, caps approvals without proof at 6, and stops at 20 units", () => {
  const units: Array<SheetUnit> = [
    ...Array.from({ length: 10 }, (_, i) => ({
      caseId: "c",
      batchId: "b",
      unit: unit(`approve-${i}`, { disposition: disposition("approve") }),
    })),
    ...Array.from({ length: 16 }, (_, i) => ({
      caseId: "c",
      batchId: "b",
      unit: unit(`uncited-${i}`, {
        disposition: disposition("request-changes"),
      }),
    })),
  ];
  const { chosen, cut } = sampleSheet(units);
  expect(chosen).toHaveLength(20);
  expect(
    chosen.filter((entry) => entry.buckets.includes("uncited-request")),
  ).toHaveLength(16);
  expect(
    chosen.filter((entry) => entry.buckets.includes("approval-without-proof")),
  ).toHaveLength(4);
  expect(cut.every((entry) => entry.bucket === "approval-without-proof")).toBe(
    true,
  );
});

test("sheet.json keeps the question apart from the reveal, with empty answers, and validates against its schema", () => {
  const entry: SheetUnit = {
    caseId: "c",
    batchId: "b",
    unit: unit("u1", {
      content: { facts: { text: "Changes the label gate.", cites: ["c1"] } },
      disposition: disposition("request-changes", [
        "01DEFECT000000000000000000",
      ]),
      comments: [
        {
          id: "01DEFECT000000000000000000",
          payload: {
            body: "An empty file counts as undefined.",
            finding: { kind: "defect", about: "code", evidence: [] },
          },
        },
      ],
    }),
  };
  const item = unitSheetItem("C1", "h9", entry, ["uncited-request"]);
  const file = SheetFile.parse({
    schemaVersion: 1,
    seed: "s",
    builtAt: "2026-10-21T00:00:00.000Z",
    cut: [],
    marginPool: { candidates: 0, judged: 0, unjudged: 0 },
    items: [item],
  });
  const parsed = file.items[0]!;
  if (parsed.kind !== "unit") throw new Error("expected a unit item");
  // What the owner decides from never names the lane or the verdict.
  expect(JSON.stringify(parsed.question)).not.toMatch(
    /agentic|request-changes|approve/,
  );
  expect(parsed.reveal).toMatchObject({
    lane: "agentic",
    verdict: "request-changes",
  });
  expect(parsed.reveal.findings).toHaveLength(1);
  expect(parsed.answer.first.lane.value).toBeNull();
  expect(parsed.answer.findings).toEqual([
    { commentId: "01DEFECT000000000000000000", judged: null },
  ]);
  expect(parsed.briefing).toEqual({ text: null, by: null });
  expect(JSON.stringify(z.toJSONSchema(SheetFile))).toContain("briefing");
});

// Planted cases

const git = (cwd: string, ...args: Array<string>) => {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], {
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
};

test("planted cases build as commits with no checkout, and each kind's line rule is enforced", () => {
  const repo = join(scratch, "repo");
  git(scratch, "init", "-q", repo);
  const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join(
    "\n",
  );
  writeFileSync(join(repo, "a.ts"), `${lines}\n`);
  writeFileSync(join(repo, "b.ts"), `${lines}\n`);
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "base");
  const base = git(repo, "rev-parse", "HEAD");
  const changed = `${lines.replace("line 5", "line five")}\n`;
  const spec = {
    schemaVersion: 1 as const,
    cases: [
      {
        id: "omission",
        kind: "pure-omission" as const,
        base,
        message: "m",
        edits: [{ path: "a.ts", content: changed }],
        defect: [{ path: "b.ts", startLine: 20, endLine: 22 }],
        note: "n",
      },
      {
        id: "test",
        kind: "mocked-test" as const,
        base,
        message: "m",
        edits: [{ path: "a.ts", content: changed }],
        defect: [{ path: "a.ts", startLine: 5, endLine: 5 }],
        note: "n",
      },
      {
        id: "plain",
        kind: "changed-lines" as const,
        base,
        message: "m",
        edits: [{ path: "a.ts", content: changed }],
        defect: [{ path: "a.ts", startLine: 5, endLine: 5 }],
        note: "n",
      },
    ],
  };
  const entries = buildPlanted(repo, spec);
  expect(entries.map((entry) => entry.planted)).toEqual([
    "pure-omission",
    "mocked-test",
    "changed-lines",
  ]);
  expect(git(repo, "rev-parse", `${entries[0]!.head}^`)).toBe(base);
  expect(git(repo, "rev-parse", "refs/heads/planted/omission")).toBe(
    entries[0]!.head,
  );
  // The working tree is never touched.
  expect(git(repo, "status", "--porcelain")).toBe("");
  // A pure omission whose lines lie in the change is refused.
  expect(() =>
    buildPlanted(repo, {
      ...spec,
      cases: [
        {
          ...spec.cases[0]!,
          defect: [{ path: "a.ts", startLine: 4, endLine: 6 }],
        },
        spec.cases[1]!,
        spec.cases[2]!,
      ],
    }),
  ).toThrow(/pure omission/);
  expect(
    checkKind("changed-lines", new Map([["a.ts", [[5, 5]]]]), [
      { path: "a.ts", startLine: 9, endLine: 9 },
    ]),
  ).toMatch(/must be changed lines/);
}, 60_000);

// The measures added after the first review round

test("a later commit's changed lines are carried back onto the reviewed hunk's head lines", () => {
  // head..parent: two lines inserted after line 3, line 10 changed.
  const forward = parseHeaders(
    "@@ -3,0 +4,2 @@\n+a\n+b\n@@ -10 +12 @@\n-x\n+y\n",
  );
  expect(carryLine(forward, 2)).toBe(2);
  expect(carryLine(forward, 5)).toBe(7);
  expect(carryLine(forward, 10)).toBeNull();
  expect(carryLine(forward, 11)).toBe(13);
  const own = parseHeaders("@@ -7,2 +7 @@\n-p\n-q\n+r\n@@ -20,0 +20 @@\n+s\n");
  expect([...changedOldLines(own)].sort((a, b) => a - b)).toEqual([7, 8, 20]);
});

test("FT17: a lead keeps the credit over a later search; search counts by exposure or by chain; the trigger needs both runs", () => {
  const entry = (
    id: string,
    over: Partial<AttributableEntry> = {},
  ): AttributableEntry => ({
    id,
    agent: "p1",
    turn: 5,
    lookup: "read",
    followedFrom: null,
    touchesGold: true,
    path: "src/x.ts",
    startLine: 10,
    endLine: 20,
    ...over,
  });
  const exposures: Array<SearchExposure> = [
    { agent: "p1", turn: 2, path: "src/x.ts", startLine: 15, endLine: 30 },
    { agent: "p2", turn: 1, path: "src/y.ts", startLine: 1, endLine: 5 },
  ];
  const attributed = attributeEntries(
    [
      entry("e1"),
      entry("e2", { path: "src/y.ts", startLine: 1, endLine: 2 }),
      entry("e3", { path: "src/z.ts", followedFrom: "e1" }),
      entry("e4", { lookup: "preloaded-lead" }),
      entry("e5", { turn: 1 }),
    ],
    exposures,
    [],
  );
  const by = Object.fromEntries(attributed.map((a) => [a.id, a]));
  expect(by["e1"]?.byExposure).toBe("search");
  // Another agent's search never counts.
  expect(by["e2"]?.byExposure).toBe("other");
  expect(by["e3"]).toMatchObject({ byExposure: "other", byChain: "search" });
  expect(by["e4"]).toMatchObject({
    byExposure: "lead",
    bothLeadAndSearch: true,
  });
  // A search shown after the entry was recorded never counts.
  expect(by["e5"]?.byExposure).toBe("other");
  const rows = (share: number) =>
    Array.from({ length: 15 }, (_, i) => ({
      family: `f${i}`,
      touching: 10,
      search: i < share ? 2 : 0,
      share: i < share ? 0.2 : 0,
    }));
  expect(ft17Trigger(rows(8), rows(8)).fires).toBe(true);
  expect(ft17Trigger(rows(8), rows(7)).fires).toBe(false);
  const shares = searchShareByFamily(
    attributed.map((a) => ({ ...a, family: "f" })),
  );
  expect(shares).toEqual([{ family: "f", touching: 5, search: 2, share: 0.4 }]);
});

test("a range whose proof shows a requirement not met is caught only when no unit owning the failing lines is approved", () => {
  const defect = [
    { path: "src/a.ts", side: "new" as const, startLine: 11, endLine: 11 },
  ];
  expect(
    approvalCatch(
      stored([unit("u1", { disposition: disposition("approve") })]),
      defect,
    ),
  ).toMatchObject({ caught: false, approvedUnits: ["u1"] });
  expect(
    approvalCatch(
      stored([unit("u1", { disposition: disposition("request-changes") })]),
      defect,
    ),
  ).toMatchObject({ caught: true, requestCitesFailure: false });
  // No unit owns the lines: nothing was reviewed there, so nothing is caught.
  expect(
    approvalCatch(stored([unit("u1")]), [{ ...defect[0]!, path: "src/b.ts" }])
      .caught,
  ).toBe(false);
});

test("a seam phase's HOME names its frozen leads and keeps the search template, never the template's own leads", () => {
  const home = join(scratch, "home-seam");
  const path = writeHomeSettings(
    home,
    { graph: { executable: "/bin/graph" } },
    { candidate: "R(H3-E0)", file: "/leads.jsonl.gz" },
  );
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
    version: 1,
    search: {
      graph: { executable: "/bin/graph" },
      leads: { frozen: { candidate: "R(H3-E0)", file: "/leads.jsonl.gz" } },
    },
  });
  expect(
    JSON.parse(
      readFileSync(
        writeHomeSettings(join(scratch, "home-plain"), undefined, undefined),
        "utf8",
      ),
    ),
  ).toEqual({ version: 1 });
  // A template's own leads never apply: a BM25 phase's HOME names no leads source.
  const bm25 = writeHomeSettings(
    join(scratch, "home-bm25"),
    { graph: { executable: "/bin/graph" }, leads: "graph" },
    undefined,
  );
  expect(JSON.parse(readFileSync(bm25, "utf8"))).toEqual({
    version: 1,
    search: { graph: { executable: "/bin/graph" } },
  });
});

test("delivered planted ranges are fetched from their bundles into a scratch clone, never with their spec", () => {
  const source = join(scratch, "source");
  git(scratch, "init", "-q", source);
  writeFileSync(
    join(source, "a.ts"),
    `${Array.from({ length: 30 }, (_, i) => `l${i + 1}`).join("\n")}\n`,
  );
  writeFileSync(join(source, "b.ts"), "kept\n");
  git(source, "add", ".");
  git(source, "commit", "-q", "-m", "base");
  const base = git(source, "rev-parse", "HEAD");
  // The authoring side: a branch with the planted change, bundled against the base.
  const author = join(scratch, "author");
  git(scratch, "clone", "-q", source, author);
  git(author, "checkout", "-q", "-b", "planted");
  writeFileSync(
    join(author, "a.ts"),
    `${Array.from({ length: 30 }, (_, i) => (i === 4 ? "five" : `l${i + 1}`)).join("\n")}\n`,
  );
  git(author, "commit", "-q", "-am", "plant");
  const head = git(author, "rev-parse", "HEAD");
  const delivery = join(scratch, "delivery");
  const caseDir = join(delivery, "case-1");
  mkdirSync(caseDir, { recursive: true });
  git(
    author,
    "bundle",
    "create",
    "-q",
    join(caseDir, "range.bundle"),
    `${base}..refs/heads/planted`,
  );
  writeFileSync(
    join(caseDir, "spec.json"),
    JSON.stringify({
      caseId: "p1",
      kind: "omission-in-unchanged-code",
      repository: "neuve_effect",
      base,
      head,
      bundle: "range.bundle",
      bundleRef: "refs/heads/planted",
      defect: { path: "b.ts", startLine: 1, endLine: 1 },
    }),
  );
  const out = join(scratch, "plant-scratch");
  const entries = plantFromBundles(delivery, out, {
    neuve: source,
    neuve_effect: source,
  });
  expect(entries).toMatchObject([
    {
      id: "planted:p1",
      planted: "pure-omission",
      base,
      head,
      defectLines: [{ path: "b.ts", side: "new", startLine: 1, endLine: 1 }],
    },
  ]);
  expect(entries[0]!.source).toBe("scratch:planted-neuve_effect");
  const clone = join(out, "planted-neuve_effect");
  expect(git(clone, "rev-parse", "refs/heads/planted/p1")).toBe(head);
  // The spec never enters the clone: no file, no object holds its text.
  expect(
    Bun.spawnSync([
      "git",
      "-C",
      clone,
      "grep",
      "-I",
      "omission-in-unchanged-code",
      head,
    ]).exitCode,
  ).not.toBe(0);
  expect(kindOf("test-mocks-away-claimed-behaviour")).toBe("mocked-test");
  expect(kindOf("plain-defect-in-changed-lines (off-by-one boundary)")).toBe(
    "changed-lines",
  );
}, 60_000);

test("one matcher feeds the seed: two rows never land on one harness hunk", () => {
  const records = [{ ...harnessHunk("h1", "only"), kind: "text" as const }];
  const row = (id: string, diffText?: string) => ({
    hunkId: id,
    path: "src/a.ts",
    oldPath: "src/a.ts",
    old: { start: 10, lines: 2 },
    new: { start: 10, lines: 3 },
    queryText: "",
    regions: [],
    ...(diffText === undefined ? {} : { diffText }),
  });
  // The second row matches by text, so it keeps the hunk even though the first matched by header.
  const matches = matchHunks(
    [row("by-header"), row("by-text", "only")],
    records,
  );
  expect(matches).toEqual([
    { m4HunkId: "by-header", harnessHunkId: null, how: "none" },
    { m4HunkId: "by-text", harnessHunkId: "h1", how: "text" },
  ]);
});

test("the known-defect catch tests the cited range's overlap, and resolves event and ledger-entry citations to lines", () => {
  const defect = [
    { path: "src/b.ts", side: "new" as const, startLine: 30, endLine: 34 },
  ];
  const withEvidence = (
    evidence: ReadonlyArray<{ ref: string; entry?: string }>,
    extra: Partial<StoredRun> = {},
  ) => ({
    ...stored([
      unit("u1", {
        disposition: disposition("request-changes", [
          "01DEFECT000000000000000000",
        ]),
        comments: [
          {
            id: "01DEFECT000000000000000000",
            payload: {
              body: "b",
              finding: { kind: "defect", about: "code", evidence },
            },
          },
        ],
        references: [
          {
            id: "01REFERENCE000000000000000",
            payload: {
              summary: "s",
              anchor: {
                path: "src/a.ts",
                side: "new",
                startLine: 10,
                endLine: 10,
              },
              stance: "supports",
              origin: "committed",
              provenance: {
                kind: "git",
                revision: "a".repeat(40),
                path: "src/b.ts",
                startLine: 33,
                endLine: 40,
              },
            },
          },
        ],
      }),
    ]),
    ...extra,
  });
  // A cited range that starts before the defect and runs into it.
  expect(
    caughtDefect(
      withEvidence([{ ref: "computation:x", entry: "src/b.ts:20-31" }]),
      defect,
    ).caught,
  ).toBe(true);
  expect(
    caughtDefect(
      withEvidence([{ ref: "computation:x", entry: "src/b.ts:20-29" }]),
      defect,
    ).caught,
  ).toBe(false);
  // A context reference cited by event.
  expect(
    caughtDefect(
      withEvidence([{ ref: "event:01REFERENCE000000000000000" }]),
      defect,
    ).caught,
  ).toBe(true);
  // A ledger entry, through Assemble's citation index naming its partition.
  const ledgerKey = `computation:${"f".repeat(64)}`;
  const ledgerRun = withEvidence([{ ref: ledgerKey, entry: "e7" }], {
    assembled: [
      {
        citations: {
          "p2.e7": { kind: "ledger-entry", ref: ledgerKey, entry: "e7" },
        },
      },
    ],
    ledgers: [
      {
        partition: { id: "p1" },
        entries: [
          {
            id: "e7",
            source: {
              origin: "repository",
              path: "src/b.ts",
              startLine: 1,
              endLine: 5,
            },
          },
        ],
      },
      {
        partition: { id: "p2" },
        entries: [
          {
            id: "e7",
            source: {
              origin: "repository",
              path: "src/b.ts",
              startLine: 28,
              endLine: 31,
            },
          },
        ],
      },
    ],
  });
  expect(citedRegions(ledgerRun, { ref: ledgerKey, entry: "e7" })).toEqual([
    { path: "src/b.ts", startLine: 28, endLine: 31 },
  ]);
  expect(caughtDefect(ledgerRun, defect).caught).toBe(true);
});

test("the no-approval catch counts a suggested approval as an approval and needs every owning unit decided", () => {
  const defect = [
    { path: "src/a.ts", side: "new" as const, startLine: 11, endLine: 11 },
  ];
  const humanRequired = assessment({
    lane: "human-required",
    quadrant: "high-hard",
  });
  const suggested = (verdict: "approve" | "request-changes") =>
    stored([
      unit("u1", {
        assessment: humanRequired,
        content: { guided: { rows: [], suggestion: { verdict } } },
      }),
    ]);
  expect(approvalCatch(suggested("approve"), defect)).toMatchObject({
    caught: false,
    approvedUnits: ["u1"],
  });
  expect(approvalCatch(suggested("request-changes"), defect).caught).toBe(true);
  // An owning unit never disposed is not a catch.
  expect(approvalCatch(stored([unit("u1")]), defect)).toMatchObject({
    caught: false,
    undecidedUnits: ["u1"],
  });
});

test("a margin card's question holds only the region and the hunk; the harness's grade and text wait in the reveal; one reference cited by two units is two cards", () => {
  const card = {
    caseId: "neuve:aaaa..bbbb",
    unitId: "01UNITA",
    referenceId: "01REF",
    unitTitle: "Scrape through a breaker",
    unitFacts: "Wraps each fetch; human-required checks pass.",
    summary: "b1.r7 (useful): The breaker reopens on half-open failure.",
    region: { path: "src/breaker.ts", startLine: 336, endLine: 409 },
    goldGrade: "necessary",
    hunkId: "h-1",
    hunk: {
      path: "src/service.ts",
      old: { start: 0, lines: 0 },
      new: { start: 1, lines: 517 },
    },
  };
  const item = marginSheetItem(card);
  if (item.kind !== "margin-card") throw new Error("expected a margin card");
  expect(item.question).toEqual({
    region: "src/breaker.ts 336-409",
    hunk: "src/service.ts old lines none, new lines 1-517",
    // The citing unit's Facts are question-side, masked as a unit item's are.
    citingUnit: {
      title: "Scrape through a breaker",
      facts: "Wraps each fetch; [masked] checks pass.",
    },
  });
  expect(JSON.stringify(item.question)).not.toMatch(
    /useful|necessary|b1\.r7|breaker reopens/,
  );
  expect(item.reveal).toEqual({
    harness: {
      handle: "b1.r7",
      grade: "useful",
      summary: "The breaker reopens on half-open failure.",
    },
    goldGrade: "necessary",
  });
  // A summary in any other form keeps its whole text, with no grade parsed out.
  expect(parseReferenceSummary("No handle here.")).toEqual({
    handle: null,
    grade: null,
    summary: "No handle here.",
  });
  // The same Records reference listed under another unit, or in another range, is its own card.
  const ids = new Set([
    item.id,
    marginSheetItem({ ...card, unitId: "01UNITB" }).id,
    marginSheetItem({ ...card, caseId: "neuve:cccc..dddd" }).id,
  ]);
  expect(ids.size).toBe(3);
  expect(marginSheetItem(card).id).toBe(item.id);
  expect(marginCardKey(card)).toBe("neuve:aaaa..bbbb:01UNITA:01REF");
});

test("margin cards are drawn only from references the gold has judged, in a fixed seeded order", () => {
  const candidate = (i: number, goldGrade: string | null) => ({
    caseId: "neuve:aaaa..bbbb",
    unitId: `01UNIT${i}`,
    referenceId: `01REF${i}`,
    unitTitle: "t",
    unitFacts: null,
    summary: "b1.r1 (useful): text",
    region: { path: "src/a.ts", startLine: i, endLine: i + 1 },
    goldGrade,
    hunkId: "h-1",
    hunk: {
      path: "src/a.ts",
      old: { start: 1, lines: 1 },
      new: { start: 1, lines: 1 },
    },
  });
  const pool = Array.from({ length: 40 }, (_, i) =>
    candidate(i, i % 3 === 0 ? null : "useful"),
  );
  const { cards, pool: counts } = drawMarginCards(pool);
  expect(counts).toEqual({ candidates: 40, judged: 26, unjudged: 14 });
  expect(cards).toHaveLength(20);
  expect(cards.every((card) => card.goldGrade === "useful")).toBe(true);
  // The order depends only on the seed and each card's key, never on the input order.
  expect(drawMarginCards([...pool].reverse()).cards.map(marginCardKey)).toEqual(
    cards.map(marginCardKey),
  );
});

test("sheet IDs come from what an item is about; lane and verdict words are masked before answering", () => {
  expect(stableId("C", "01UNIT")).toBe(stableId("C", "01UNIT"));
  expect(stableId("C", "01UNIT")).not.toBe(stableId("C", "01OTHER"));
  expect(stableId("C", "01UNIT")).toMatch(/^C-[0-9a-f]{10}$/);
  expect(
    maskLaneWords(
      "Agentic review; approve once human-required checks pass, or request changes.",
    ),
  ).toBe("[masked] review; [masked] once [masked] checks pass, or [masked].");
  const item = unitSheetItem(
    "C-x",
    "h9",
    {
      caseId: "c",
      batchId: "b",
      unit: unit("u1", {
        content: {
          facts: { text: "Approved by static automation", cites: [] },
        },
      }),
    },
    [],
  );
  if (item.kind !== "unit") throw new Error("unit item expected");
  expect(item.question.facts).toBe("[masked] by [masked]");
});

test("the snapshot's node_modules link workspace packages into the snapshot, and an unpinned snapshot is refused", () => {
  const snap = join(scratch, "snap");
  mkdirSync(join(snap, "packages/harness/src"), { recursive: true });
  linkModules(
    join(root, "packages/harness/node_modules"),
    join(snap, "packages/harness/node_modules"),
    snap,
  );
  expect(
    readlinkSync(
      join(snap, "packages/harness/node_modules/@neuve/records-core"),
    ),
  ).toBe(join(snap, "packages/records-core"));
  expect(
    readlinkSync(join(snap, "packages/harness/node_modules/effect")).startsWith(
      join(root, "node_modules/.bun/"),
    ),
  ).toBe(true);
  // A snapshot whose package links still point at the working tree is refused.
  const unpinned = join(scratch, "unpinned");
  mkdirSync(join(unpinned, "packages/harness/src"), { recursive: true });
  mkdirSync(join(unpinned, "packages/harness/node_modules/@neuve"), {
    recursive: true,
  });
  symlinkSync(
    join(root, "packages/records-core"),
    join(unpinned, "packages/harness/node_modules/@neuve/records-core"),
  );
  expect(() => assertPinned(unpinned)).toThrow(/not pinned/);
}, 60_000);

// Fix round 2

test("Understand counts as recomputed only when one of its agents computed, never its change-map code step", () => {
  // The committed 10.84 Sol runs (spend.json `understand`, from the run logs' stage records).
  const committed = JSON.parse(
    readFileSync(
      join(import.meta.dir, "fixtures/understand-stage-statuses.json"),
      "utf8",
    ),
  ) as { runs: ReadonlyArray<{ understand: string }> };
  const asRecords = (understand: string) =>
    understand
      .split(",")
      .filter(Boolean)
      .map((pair) => {
        const [agent, status] = pair.split(":");
        return { type: "stage", stage: "understand", agent, status };
      });
  const shared = committed.runs.find(
    (run) =>
      run.understand === "understand:reused,understand.change-map:computed",
  );
  const own = committed.runs.find(
    (run) =>
      run.understand === "understand:computed,understand.change-map:computed",
  );
  expect(shared).toBeDefined();
  expect(own).toBeDefined();
  expect(understandComputed(asRecords(shared!.understand))).toBe(false);
  expect(understandComputed(asRecords(own!.understand))).toBe(true);
  expect(
    understandComputed(
      asRecords(
        "understand.p1:reused,understand.p2:reused,understand.merge:computed,understand.change-map:computed",
      ),
    ),
  ).toBe(true);
});

test("a unit static automation closed on the failing lines is not a catch (10.82 rules static out beside a not-met requirement)", () => {
  const defect = [
    { path: "src/a.ts", side: "new" as const, startLine: 11, endLine: 11 },
  ];
  const closed = stored([
    unit("u1", { assessment: assessment({ lane: "static-automation" }) }),
  ]);
  expect(approvalCatch(closed, defect)).toMatchObject({
    caught: false,
    approvedUnits: ["u1"],
  });
});

test("ledger-entry and reference citations match the defect's side; another side counts only in a file the range leaves alone", () => {
  const defect = [
    { path: "src/a.ts", side: "new" as const, startLine: 11, endLine: 11 },
  ];
  const key = `computation:${"e".repeat(64)}`;
  const run = (rev: string) => ({
    ...stored([
      unit("u1", {
        disposition: disposition("request-changes", [
          "01DEFECT000000000000000000",
        ]),
        comments: [
          {
            id: "01DEFECT000000000000000000",
            payload: {
              body: "b",
              finding: {
                kind: "defect",
                about: "code",
                evidence: [{ ref: key, entry: "e1" }],
              },
            },
          },
        ],
      }),
    ]),
    assembled: [
      {
        citations: { "p1.e1": { kind: "ledger-entry", ref: key, entry: "e1" } },
      },
    ],
    ledgers: [
      {
        partition: { id: "p1" },
        entries: [
          {
            id: "e1",
            source: {
              origin: "repository",
              rev,
              path: "src/a.ts",
              startLine: 10,
              endLine: 12,
            },
          },
        ],
      },
    ],
    measurement: { baseOid: "b".repeat(40), headOid: "c".repeat(40) },
  });
  // src/a.ts is changed in the range (the stub manifest's hunk), so base lines are not head lines.
  expect(caughtDefect(run("head"), defect).caught).toBe(true);
  expect(caughtDefect(run("base"), defect).caught).toBe(false);
  expect(citedRegions(run("base"), { ref: key, entry: "e1" })[0]?.side).toBe(
    "old",
  );
});

test("the search-tools template becomes valid harness settings in a seam phase's HOME", async () => {
  // A real search-tools template when NEUVE_SEARCH_SETTINGS_TEMPLATE names one, a stub otherwise.
  const template = process.env["NEUVE_SEARCH_SETTINGS_TEMPLATE"];
  const { Settings } = await import("../../harness/src/settings.ts");
  const search =
    template !== undefined && (await Bun.file(template).exists())
      ? (
          JSON.parse(readFileSync(template, "utf8")) as {
            search: Record<string, unknown>;
          }
        ).search
      : {
          graph: { executable: "/bin/graph" },
          e0: { python: "/p", snapshot: "/s", vectorStore: "/v" },
        };
  const path = writeHomeSettings(join(scratch, "home-template"), search, {
    candidate: "R(H3-E0)",
    file: "/leads/R(H3-E0).jsonl.gz",
  });
  const parsed = Settings.parse(JSON.parse(readFileSync(path, "utf8")));
  expect(parsed.search?.leads).toEqual({
    frozen: { candidate: "R(H3-E0)", file: "/leads/R(H3-E0).jsonl.gz" },
  });
  expect(parsed.search?.graph).toBeDefined();
  expect(parsed.search?.e0).toBeDefined();
});

// Fix round 3

test("FT4's served top 3 compare harness chunks: two benchmark spans in one harness chunk are the same handle", () => {
  // The base index's chunks on each path (search-index.ts), as the runner reads them from the clone.
  const chunks: Record<
    string,
    ReadonlyArray<{ chunkId: string; startLine: number; endLine: number }>
  > = {
    "x.ts": [
      { chunkId: "X1", startLine: 1, endLine: 40 },
      { chunkId: "X2", startLine: 41, endLine: 80 },
    ],
    "y.ts": [{ chunkId: "Y1", startLine: 1, endLine: 30 }],
  };
  const lead = (path: string, startLine: number, endLine: number) => ({
    identity: { tree: "t".repeat(40), path, startLine, endLine },
  });
  const hunks = (
    leads: Record<string, ReadonlyArray<ReturnType<typeof lead>> | null>,
  ) => [
    ...Object.entries(leads).map(([hunkId, results]) => ({
      hunkId,
      kind: "text",
      leads: results === null ? null : { results },
    })),
    { hunkId: "bin", kind: "binary", leads: null },
  ];
  const chunksOn = (path: string) => chunks[path] ?? [];
  // A serves x.ts:5-12, B serves x.ts:20-35: different spans, one harness chunk (X1).
  const a = servedChunkIds(
    hunks({
      h1: [lead("x.ts", 5, 12), lead("y.ts", 2, 9)],
      h2: [lead("x.ts", 1, 5)],
      h3: null,
    }),
    chunksOn,
  );
  const b = servedChunkIds(
    hunks({
      h1: [lead("y.ts", 10, 20), lead("x.ts", 20, 35)],
      h2: [lead("x.ts", 50, 60)],
      h3: null,
    }),
    chunksOn,
  );
  expect(a["h1"]).toEqual(["X1", "Y1"]);
  expect(b["h1"]).toEqual(["Y1", "X1"]);
  expect(a["h3"]).toBeNull();
  expect("bin" in a).toBe(false);
  // A lead on no indexed chunk keeps its own span.
  expect(
    servedChunkIds(hunks({ h1: [lead("z.ts", 1, 2)] }), chunksOn)["h1"],
  ).toEqual(["z.ts:1-2"]);
  const differ = servedTop3Differ(
    new Map(Object.entries(a)),
    new Map(Object.entries(b)),
  );
  // h1 is the same in chunks; h2 moves from X1 to X2; h3 has none in either.
  expect(differ).toEqual({ hunks: 3, differ: 1, share: 1 / 3 });
});

test("each re-request sets the job, so the continuation drops the one the stopped worker left", () => {
  // B's own request queued job 42; two re-requests after timeouts queued 43 and 44.
  let state = { job: "42", jobs: ["42"] as ReadonlyArray<string> };
  state = afterReRequest(state.jobs, { job: "43" });
  state = afterReRequest(state.jobs, { job: "44" });
  expect(state).toEqual({ job: "44", jobs: ["42", "43", "44"] });
  expect(jobToDrop({ measurement: state }, { job: "11" })).toBe("44");
});

test("B's continuation drops B's own job when B requested its own run (the seam path), else the pristine one", () => {
  const pristine = { job: "11" };
  expect(jobToDrop({ measurement: { job: "42" } }, pristine)).toBe("42");
  expect(jobToDrop({ measurement: {} }, pristine)).toBe("11");
  expect(jobToDrop(undefined, pristine)).toBe("11");
});

test("a run is stored only after its served file is written; a failing served stores nothing", async () => {
  const dir = join(scratch, "store-after");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "A.json.gz");
  await expect(
    storeAfter(path, { run: 1 }, async (pending) => {
      expect(existsSync(pending)).toBe(true);
      throw new Error("served failed");
    }),
  ).rejects.toThrow("served failed");
  expect(existsSync(path)).toBe(false);
  expect(existsSync(join(dir, "A.pending.json.gz"))).toBe(false);
  let read: unknown;
  await storeAfter(path, { run: 2 }, async (pending) => {
    read = JSON.parse(gunzipSync(readFileSync(pending)).toString("utf8"));
  });
  expect(read).toEqual({ run: 2 });
  expect(JSON.parse(gunzipSync(readFileSync(path)).toString("utf8"))).toEqual({
    run: 2,
  });
  // With nothing to wait for, the file is written at once.
  await storeAfter(join(dir, "C.json.gz"), { run: 3 });
  expect(existsSync(join(dir, "C.json.gz"))).toBe(true);
});

test("the delivered row format reads as one spelling, and a range's rows are found by its revisions", () => {
  // As leads.json's rowFormat describes a row.
  const delivered = {
    caseId: "neuve:13e5e2a6..0c874b72",
    hunkId: "h-1",
    picked: false,
    path: "src/a.ts",
    oldPath: "src/a.ts",
    old: { start: 1, lines: 2 },
    new: { start: 1, lines: 3 },
    added: 1,
    deleted: 0,
    diff: "@@ -1,2 +1,3 @@\n a\n+b\n c\n",
    query: { text: "q", sha256: "s" },
    sources: { graph: { status: "not-used" }, keyword: { status: "answered" } },
    regions: [["src/x.ts", 1, 10, "src/x.ts#L1-L10", "code", 40, 0.9]],
  };
  const parsed = normaliseRow(delivered, "extra");
  expect(parsed).toMatchObject({
    hunkId: "h-1",
    diffText: delivered.diff,
    queryText: "q",
    graph: "not-used",
    file: "extra",
  });
  // The known case `neuve:0c874b72~1..0c874b72` resolves to these revisions; its name never matches.
  const byCase = new Map([[parsed.caseId, [parsed]]]);
  expect(
    rowsForRange(byCase, {
      baseOid: "13e5e2a6" + "0".repeat(32),
      headOid: "0c874b72" + "1".repeat(32),
    }),
  ).toHaveLength(1);
  expect(
    rowsForRange(byCase, {
      baseOid: "ffffffff" + "0".repeat(32),
      headOid: "0c874b72" + "1".repeat(32),
    }),
  ).toHaveLength(0);
});
