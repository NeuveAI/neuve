// Why (10.139): a title candidate is kept only on a rise its baseline would not show by chance, read
// on the same cases recomposed twice. A comparison that paired runs placed differently would credit
// the title step with a placement change; a rubric that told judges which arm wrote a title, or
// judged a title both arms share twice, would bias the score.
import { expect, test } from "bun:test";
import {
  checkPairs,
  pairRubricChunks,
  pairRubricComparison,
  pairRuns,
  titleComparison,
  titlePairRubricSample,
} from "../src/harness-compare/full-test/titles-compare.ts";

const range = (start: number, end: number, hunkId: string) => ({
  kind: "lines",
  hunkId,
  startLine: start,
  endLine: end,
});

/** One case's shown run: a joined unit of two sections and a one-change unit. */
const shown = (joinedTitle: string, lane = "agentic") => ({
  changeMap: { hunkRoles: [] },
  assembled: [
    {
      units: [
        {
          id: "b1.u1",
          title: joinedTitle,
          hunkIds: ["h1", "h2"],
          ownedRanges: [],
          ownedPaths: ["src/cache.ts"],
          assessment: { lane },
          sections: [
            {
              id: "b1.s1",
              title: "Report store usage from cache declarations",
              ownedRanges: [range(1, 30, "h1")],
              content: { briefed: "The declarations report store usage." },
            },
            {
              id: "b1.s2",
              title: "Carry the usage in the receipt",
              ownedRanges: [range(40, 50, "h2")],
              content: { briefed: "The receipt carries it." },
            },
          ],
        },
        {
          id: "b1.u3",
          title: "Qualify cache receipts",
          hunkIds: ["h3"],
          ownedRanges: [range(1, 9, "h3")],
          ownedPaths: ["src/receipt.ts"],
          assessment: { lane: "agentic" },
        },
      ],
    },
  ],
});

const run = (caseId: string, value: Record<string, unknown>) => ({
  caseId,
  source: "t3code",
  shown: value,
});

test("a candidate placed differently from its baseline is refused, and so is a case in one arm only", () => {
  expect(() =>
    checkPairs(
      pairRuns(
        [run("c1", shown("Report store usage"))],
        [run("c1", shown("Report store usage", "human-required"))],
      ),
    ),
  ).toThrow("placed units differently");
  // Lines moved between sections, with the same IDs and lanes, are a placement change too: they
  // would move the title check's main change in one arm only.
  const moved = shown("Report store usage");
  const sections = moved.assembled[0]!.units[0]!.sections as Array<{
    ownedRanges: Array<ReturnType<typeof range>>;
  }>;
  sections[0]!.ownedRanges = [range(1, 5, "h1")];
  sections[1]!.ownedRanges = [range(6, 50, "h2")];
  expect(() =>
    checkPairs(
      pairRuns([run("c1", shown("Report store usage"))], [run("c1", moved)]),
    ),
  ).toThrow("placed units differently");
  const quadrant = shown("Report store usage") as ReturnType<typeof shown> & {
    assembled: Array<{ units: Array<{ assessment: Record<string, unknown> }> }>;
  };
  quadrant.assembled[0]!.units[0]!.assessment = {
    lane: "agentic",
    quadrant: "high-easy",
  };
  expect(() =>
    checkPairs(
      pairRuns([run("c1", shown("Report store usage"))], [run("c1", quadrant)]),
    ),
  ).toThrow("placed units differently");
  expect(() =>
    pairRuns(
      [run("c1", shown("a")), run("c2", shown("a"))],
      [run("c1", shown("a"))],
    ),
  ).toThrow("in one arm only");
});

test("joined titles are compared per case with a bootstrap interval; one-concern titles stay as they are", () => {
  // The baseline's joined title names only the receipt change, which is not the main one.
  const cases = Array.from({ length: 12 }, (_, index) => `c${index}`);
  const pairs = pairRuns(
    cases.map((id) => run(id, shown("Carry it in the receipt"))),
    cases.map((id) =>
      run(
        id,
        shown("Report store usage from cache declarations, with its receipt"),
      ),
    ),
  );
  const result = titleComparison(pairs);
  expect(result.buckets.joined.units).toBe(12);
  expect(result.buckets.joined.namesMain).toMatchObject({
    baseline: 0,
    candidate: 1,
    delta: 1,
    interval: [1, 1],
  });
  expect(result.buckets.single.allRules).toMatchObject({
    baseline: 1,
    candidate: 1,
    delta: 0,
  });
});

test("the paired rubric is blind, judges a shared title once for both arms, and reads each arm's yes share", () => {
  const pairs = pairRuns(
    [
      run("c1", shown("Carry the usage in the receipt")),
      run("c2", shown("Same title")),
    ],
    [
      run(
        "c1",
        shown("Report store usage from cache declarations, with its receipt"),
      ),
      run("c2", shown("Same title")),
    ],
  );
  const sample = titlePairRubricSample(pairs, "seed");
  // c1's two titles are two items; c2's shared title is one; one-concern units are left out.
  expect(sample.items).toHaveLength(3);
  for (const item of sample.items)
    expect(Object.keys(item).sort()).toEqual([
      "changes",
      "id",
      "paths",
      "title",
    ]);
  expect(JSON.stringify(sample.items)).not.toMatch(/baseline|candidate/);
  const shared = Object.entries(sample.key).find(
    ([, entry]) => entry.caseId === "c2",
  )!;
  expect(shared[1].arms).toEqual(["baseline", "candidate"]);
  expect(titlePairRubricSample(pairs, "seed")).toEqual(sample);
  const answer = (id: string, value: "yes" | "no") => ({
    id,
    namesMain: value,
    coversRest: value,
    oneStatement: "yes" as const,
    whereToLook: value,
    reason: "",
  });
  const decided = {
    version: 1 as const,
    answers: Object.entries(sample.key).map(([id, entry]) =>
      answer(
        id,
        entry.caseId === "c2" || entry.arms.includes("candidate")
          ? "yes"
          : "no",
      ),
    ),
  };
  const read = pairRubricComparison(decided, sample.key);
  expect(read.questions.namesMain).toMatchObject({
    judged: { baseline: 2, candidate: 2 },
    baseline: 0.5,
    candidate: 1,
    delta: 0.5,
  });
  expect(read.unanswered).toBe(0);
});

test("a unit's two titles never share a rubric call, and the calls are drawn the same from the same seed", () => {
  const cases = Array.from({ length: 30 }, (_, index) => `c${index}`);
  const pairs = pairRuns(
    cases.map((id) => run(id, shown("Carry it in the receipt"))),
    cases.map((id, index) =>
      run(
        id,
        shown(
          index % 3 === 0
            ? "Carry it in the receipt"
            : `Report store usage ${index}`,
        ),
      ),
    ),
  );
  const sample = titlePairRubricSample(pairs, "seed");
  // 20 units wrote two titles, 10 wrote one shared by both arms.
  expect(sample.items).toHaveLength(50);
  const chunks = pairRubricChunks(sample.items, sample.key, "seed");
  expect(chunks.flat()).toHaveLength(50);
  expect(chunks.every((call) => call.length <= 25)).toBe(true);
  for (const call of chunks) {
    const units = call.map((item) => sample.key[item.id]!.caseId);
    expect(new Set(units).size).toBe(units.length);
  }
  expect(pairRubricChunks(sample.items, sample.key, "seed")).toEqual(chunks);
  // Even a sample small enough for one call is split, so its pairs sit apart.
  const two = titlePairRubricSample(pairs.slice(1, 3), "seed");
  const split = pairRubricChunks(two.items, two.key, "seed");
  expect(split).toHaveLength(2);
});
