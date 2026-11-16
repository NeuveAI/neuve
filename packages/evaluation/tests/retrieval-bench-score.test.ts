import { expect, test } from "bun:test";
import { layeredRrf, rrf } from "../src/retrieval-bench/fusion.ts";
import { DENSE_IDS } from "../src/retrieval-bench/models.ts";
import { rerankArm } from "../src/retrieval-bench/rerank.ts";
import { describeArms } from "../src/retrieval-bench/run-pools.ts";
import {
  componentsOf,
  exclusionsFor,
} from "../src/retrieval-bench/score/leakage.ts";
import {
  attribution,
  credit,
  judgedAt,
  ndcg,
  recall,
  serve,
} from "../src/retrieval-bench/score/coverage.ts";
import {
  buildHunkGold,
  type GoldItem,
} from "../src/retrieval-bench/score/gold.ts";
import {
  bonferroniAlpha,
  decide,
  familyBootstrap,
} from "../src/retrieval-bench/score/stats.ts";
import {
  spanKey,
  type Item,
  type Ranking,
} from "../src/retrieval-bench/ranking.ts";

const item = (
  path: string,
  start: number,
  end: number,
  tokens: number,
): Item => ({
  key: spanKey(path, start, end),
  path,
  startLine: start,
  endLine: end,
  kind: "code",
  tokens,
  chunkId: null,
  hash: null,
});
const ranking = (items: ReadonlyArray<Item>): Ranking => ({
  items,
  scores: items.map((_, rank) => 1 / (rank + 1)),
});
const gold = (
  id: string,
  region: string,
  grade: GoldItem["grade"],
  availability = "base-committed",
  retrievalTarget = true,
): GoldItem => ({
  id,
  source: "pool",
  region,
  kind: "code",
  grade,
  status: "agreed",
  availability,
  retrievalTarget,
});

// Why: NR@B is the primary metric; double-counted overlaps or a wrong boundary cut would shift every
// arm's curve without any error.
test("fractional coverage unions served lines, cuts the boundary item by lines, and caps at 1", () => {
  const served = serve(
    ranking([
      item("a.ts", 1, 10, 100),
      item("a.ts", 6, 15, 100),
      item("b.ts", 1, 100, 1000),
    ]),
    300,
  );
  // The third item gets 100 of its 1000 tokens: its first 10 lines.
  expect(
    served.map((entry) => [entry.startLine, entry.endLine, entry.tokens]),
  ).toEqual([
    [1, 10, 100],
    [6, 15, 100],
    [1, 10, 100],
  ]);
  const target = { path: "a.ts", startLine: 1, endLine: 20 };
  expect(credit(target, served)).toBeCloseTo(15 / 20, 12);
  expect(credit(target, served, "anyLine")).toBe(1);
  expect(credit(target, served, "half")).toBe(1);
  expect(credit({ path: "a.ts", startLine: 5, endLine: 8 }, served)).toBe(1);
  expect(
    credit({ path: "b.ts", startLine: 1, endLine: 40 }, served, "half"),
  ).toBe(0);
  expect(
    credit({ path: "b.ts", startLine: 1, endLine: 40 }, served),
  ).toBeCloseTo(0.25, 12);
  expect(serve(ranking([item("c.ts", 1, 3, 5000)]), 1000)).toEqual([]);
});

// Why: same-batch regions, in-range changes, later commits and earlier commits must never enter pass 1
// recall, and unjudged items must never count as wrong attributions; either would bias every arm.
test("only base retrieval targets are scored, duplicates count once, unjudged is never irrelevant", () => {
  const hunk = buildHunkGold("case", "h-1", [
    gold("c1", "a.ts:1-10", "necessary"),
    gold("c2", "a.ts:1-10", "useful"),
    gold("c3", "b.ts:5-9", "necessary", "base-partly-same-batch"),
    gold("c4", "c.ts:1-3", "necessary", "base-same-batch", false),
    gold("c5", "range change d.ts:1-4", "necessary", "range-change", false),
    gold("c6", "commit abc", "useful", "commit-later", false),
    gold("c7", "commit def", "necessary", "commit-earlier", true),
    gold("c8", "e.ts:1-5", "misleading"),
    gold("c9", "f.ts:1-5", "irrelevant"),
  ]);
  expect(hunk.necessary.map((span) => span.id)).toEqual(["c1", "c3"]);
  expect(hunk.useful).toEqual([]);
  expect(hunk.duplicateSpans).toBe(1);
  expect(hunk.excluded).toEqual({
    "not a retrieval target: base-same-batch": 1,
    "not a retrieval target: range-change": 1,
    "not a retrieval target: commit-later": 1,
    "history: earlier commit (pass 2, M6)": 1,
  });
  const served = serve(
    ranking([
      item("c.ts", 1, 3, 10),
      item("e.ts", 1, 5, 10),
      item("f.ts", 1, 5, 10),
      item("g.ts", 1, 5, 10),
      item("a.ts", 1, 10, 10),
    ]),
    1000,
  );
  expect(recall(hunk.necessary, served)).toBe(0.5);
  // Judged targets served: e (misleading), f (irrelevant), a (necessary); c is a non-target, g unjudged.
  const shares = attribution(hunk, served);
  expect(shares.judged).toBe(3);
  expect(shares.misleadingShare).toBeCloseTo(1 / 3, 12);
  expect(shares.irrelevantShare).toBeCloseTo(1 / 3, 12);
});

// Why: labellers judge B3's merged candidates, not each arm's own span; reading only exact spans left a
// sub-span of a misleading candidate unjudged, so the misleading guard read 0 and nDCG@10 read 1.
test("an item inside a merged judged candidate takes that candidate's grade", () => {
  const hunk = buildHunkGold(
    "case",
    "h-1",
    [
      gold("c001", "a.ts:1-40", "misleading"),
      gold("c002", "z.ts:1-10", "necessary"),
    ],
    [
      {
        id: "c001",
        sources: [
          { source: "X", rank: 1, startLine: 1, endLine: 20 },
          { source: "Y", rank: 2, startLine: 15, endLine: 40 },
        ],
      },
      {
        id: "c002",
        sources: [{ source: "Y", rank: 1, startLine: 1, endLine: 10 }],
      },
    ],
  );
  // An unpooled sub-span (a deep item) and a pooled item of arm X, both inside the merged candidate.
  for (const [arm, first] of [
    ["W", item("a.ts", 5, 30, 10)],
    ["X", item("a.ts", 1, 20, 10)],
  ] as const) {
    const list = ranking([
      first,
      item("z.ts", 1, 10, 10),
      item("a.ts", 41, 50, 10),
    ]);
    const shares = attribution(hunk, serve(list, 1000), arm);
    expect(shares.judged).toBe(2);
    expect(shares.misleadingShare).toBe(0.5);
    // Condensed gains [0, 2] against the ideal [2, 0].
    expect(ndcg(hunk, list, 10, arm)).toBeCloseTo(1 / Math.log2(3), 12);
    expect(judgedAt(hunk, list, 3, arm)).toBeCloseTo(2 / 3, 12);
  }
  // A necessary addition inside a misleading candidate keeps its own grade, or the guard counts it as misleading.
  const nested = buildHunkGold(
    "case",
    "h-2",
    [
      gold("c001", "b.ts:1-100", "misleading"),
      { ...gold("a001", "b.ts:10-20", "necessary"), source: "addition" },
    ],
    [
      {
        id: "c001",
        sources: [{ source: "X", rank: 1, startLine: 1, endLine: 100 }],
      },
    ],
  );
  const exact = ranking([item("b.ts", 10, 20, 10)]);
  expect(recall(nested.necessary, serve(exact, 1000))).toBe(1);
  expect(attribution(nested, serve(exact, 1000), "W")).toMatchObject({
    judged: 1,
    misleadingShare: 0,
  });
  expect(ndcg(nested, exact, 10, "W")).toBe(1);
});

// Why: the decision reads one quantile of 10,000 resamples; a seed or nesting change would move the
// bound silently between runs.
test("the family bootstrap is deterministic per seed and uses the Bonferroni level", () => {
  const units = [
    { family: "f1", caseId: "a", delta: 0.1 },
    { family: "f1", caseId: "b", delta: 0.3 },
    { family: "f2", caseId: "c", delta: -0.05 },
    { family: "f3", caseId: "d", delta: 0.2 },
    { family: "f3", caseId: "d", delta: 0.0 },
  ];
  const first = familyBootstrap(units, {
    comparisons: 5,
    resamples: 2000,
    seed: "s",
  });
  const again = familyBootstrap(units, {
    comparisons: 5,
    resamples: 2000,
    seed: "s",
  });
  expect(again).toEqual(first);
  const wide = Array.from({ length: 12 }, (_, index) => ({
    family: `g${index}`,
    caseId: `k${index}`,
    delta: ((index * 7) % 12) / 20 - 0.2,
  }));
  expect(
    familyBootstrap(wide, { comparisons: 5, resamples: 2000, seed: "t" }).lower,
  ).not.toBe(
    familyBootstrap(wide, { comparisons: 5, resamples: 2000, seed: "u" }).lower,
  );
  // Families weigh equally, cases within a family, hunks within a case: (0.2 + -0.05 + 0.1) / 3.
  expect(first.observed).toBeCloseTo(0.25 / 3, 12);
  expect(first.alpha).toBeCloseTo(0.01, 12);
  expect(bonferroniAlpha(6)).toBeCloseTo(0.05 / 6, 12);
  expect(first.families).toBe(3);
  expect(first.cases).toBe(4);
  expect(first.lower as number).toBeLessThanOrEqual(first.observed as number);
});

// Why: 9.21 as amended by 9.54 is the pre-registered rule; inconclusive data, a relevant-recall bound
// that fails while necessary recall passes, a failed guard and a guard with no paired judged hunks
// must all keep the default.
test("the decision rule keeps the default unless both bounds clear +3 points and the guard holds", () => {
  expect(
    decide({
      lower: 0.03,
      relevantLower: 0.2,
      defaultMisleading: 0,
      otherMisleading: 0,
    }),
  ).toMatchObject({ winner: "default", failed: "necessary" });
  expect(
    decide({
      lower: 0.2,
      relevantLower: 0.03,
      defaultMisleading: 0,
      otherMisleading: 0,
    }),
  ).toMatchObject({
    winner: "default",
    outcome: "relevant-inconclusive",
    failed: "relevant",
  });
  expect(
    decide({
      lower: 0.031,
      relevantLower: 0.031,
      defaultMisleading: 0.1,
      otherMisleading: 0.15,
    }),
  ).toMatchObject({ winner: "other", failed: null });
  expect(
    decide({
      lower: 0.2,
      relevantLower: 0.2,
      defaultMisleading: 0.1,
      otherMisleading: 0.151,
    }),
  ).toMatchObject({
    winner: "default",
    outcome: "guard-failed",
    failed: "guard",
  });
  expect(
    decide({
      lower: 0.2,
      relevantLower: 0.2,
      defaultMisleading: null,
      otherMisleading: null,
    }),
  ).toMatchObject({ winner: "default", outcome: "guard-not-measurable" });
  expect(
    decide({
      lower: null,
      relevantLower: null,
      defaultMisleading: null,
      otherMisleading: null,
    }).outcome,
  ).toBe("no-data");
});

// Why: fusions now read past their inputs' 256k cut through layeredRrf. A tail that moved an item
// already ranked would silently change the frozen fusion pools' order, and a tail score at or above
// the one before it would let V1's and V2's re-sort by score reorder the deep ranking (a tied block
// is read by hub score alone); neither raises an error.
test("layered RRF keeps the head fusion exactly and appends deeper items with strictly decreasing scores", () => {
  const heads = [
    ["a", "b", "c"],
    ["c", "d"],
  ];
  // The deeper lists continue the heads; "b" also appears deep in the second list.
  const deeper = [
    ["a", "b", "c", "e", "f"],
    ["c", "d", "f", "g", "b"],
  ];
  const fused = layeredRrf(heads, deeper);
  const head = rrf(heads);
  expect(fused.slice(0, head.length)).toEqual(head);
  expect(fused.slice(head.length).map((item) => item.id)).toEqual([
    "f",
    "e",
    "g",
  ]);
  // Tail scores strictly decrease below the head's last score, so no block of them ties.
  for (let index = head.length; index < fused.length; index++)
    expect(fused[index]?.score).toBeLessThan(
      fused[index - 1]?.score ?? Number.POSITIVE_INFINITY,
    );
});

// Why: 9.47's exclusions are read from the arms' definitions; a missed component (a fusion, a
// topology, R over any fusion (9.57) or a variant over the tuned adapter or the fork) would
// silently keep leaked hunks in a comparison, with nothing else to catch it.
test("leakage exclusions follow what an arm contains through fusions, topologies, R and variants", () => {
  const definitions = new Map(
    [
      ...describeArms([...DENSE_IDS]),
      ...["H3-E2", "H3-E1", "H3-E3"].map((candidates) => ({
        arm: rerankArm(candidates),
        family: "rerank" as const,
        label: rerankArm(candidates),
        config: { candidates },
      })),
    ].map((entry) => [entry.arm, entry]),
  );
  const variants = new Map<string, ReadonlyArray<string>>([
    ["V1(E1)", ["E1"]],
    ["V4(E0)", ["G-fork", "L", "E0"]],
  ]);
  const contains = (arm: string) =>
    [...componentsOf(arm, definitions, variants)].sort();
  expect(contains("E1")).toEqual(["adapter"]);
  expect(contains("E1@kind-quota")).toEqual(["adapter"]);
  expect(contains("H1-E0")).toEqual([]);
  expect(contains("H2-E1")).toEqual(["adapter", "fork"]);
  expect(contains("G-fork-syntax")).toEqual(["fork"]);
  expect(contains("G-base")).toEqual([]);
  expect(contains("R")).toEqual(["fork"]);
  // 9.57: the E1 option carries the adapter through its fusion; both carry the fork.
  expect(contains("R(H3-E1)")).toEqual(["adapter", "fork"]);
  expect(contains("R(H3-E3)")).toEqual(["fork"]);
  expect(contains("V1(E1)")).toEqual(["adapter"]);
  expect(contains("V4(E0)")).toEqual(["fork"]);
  expect(
    exclusionsFor(["H3-E1", "E1"], definitions, variants).map((entry) => [
      entry.rule.slice(0, entry.rule.indexOf(":")),
      entry.because,
    ]),
  ).toEqual([
    ["tuned adapter", ["H3-E1", "E1"]],
    ["Graph fork", ["H3-E1"]],
  ]);
  expect(
    exclusionsFor(["R(H3-E3)", "R(H3-E1)"], definitions, variants).map(
      (entry) => [entry.rule.slice(0, entry.rule.indexOf(":")), entry.because],
    ),
  ).toEqual([
    ["tuned adapter", ["R(H3-E1)"]],
    ["Graph fork", ["R(H3-E3)", "R(H3-E1)"]],
  ]);
});
