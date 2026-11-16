// Why (10.139): a batch-digest candidate is kept only on a rise its baseline would not show by chance,
// and never at the cost of accuracy. A comparison that let other fields change would credit the
// digest with them; a rubric that showed judges a batch's two digests side by side, or counted
// "some misleading claim" as good, would point the climb the wrong way.
import { expect, test } from "bun:test";
import {
  checkDigestPairs,
  digestComparison,
  digestPairRubricSample,
  digestRubricComparison,
} from "../src/harness-compare/full-test/digests-compare.ts";
import {
  pairRubricChunks,
  pairRuns,
} from "../src/harness-compare/full-test/titles-compare.ts";

const shown = (
  digest: string,
  verification = "Proof is thin.",
  title = "Report store usage",
) => ({
  changeMap: {
    hunkRoles: [],
    behaviours: [
      {
        obligations: [
          {
            id: "b1.o1",
            text: "Report store usage.",
            basis: "scope",
            hunkIds: ["h1"],
          },
        ],
      },
    ],
  },
  assembled: [
    {
      batches: [
        {
          id: "b1",
          title: "Report usage",
          focus: "Check the usage.",
          obligationIds: ["b1.o1"],
          digest: { digest, verification, uncertainty: [], limitations: [] },
        },
      ],
      references: [{ id: "b1.r1", entries: ["p1.e4"], unitIds: ["b1.u1"] }],
      units: [
        {
          id: "b1.u1",
          batchId: "b1",
          title,
          hunkIds: ["h1"],
          ownedRanges: [
            { kind: "lines", hunkId: "h1", startLine: 1, endLine: 9 },
          ],
          path: "src/cache.ts",
          content: {
            facts: {
              text: "The declarations report store usage.",
              cites: ["h1"],
            },
          },
          assessment: {
            lane: "agentic",
            validation: {
              requirements: [
                {
                  requirement: "Usage is reported",
                  coverage: "missing",
                  proof: [],
                },
              ],
            },
          },
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

const plain =
  "The batch reports usage. The receipt carries it. Callers read it.";
const led =
  "The batch reports usage.\n\n**Receipt:** it carries the usage.\n\n**Callers:** they read it.";

test("a digest candidate that changed anything but the batch digests is refused", () => {
  expect(() =>
    checkDigestPairs(
      pairRuns(
        [run("c1", shown(plain))],
        [run("c1", shown(led, "Proof is thin.", "Another title"))],
      ),
    ),
  ).toThrow("changed more than the batch digests");
  expect(
    checkDigestPairs(
      pairRuns([run("c1", shown(plain))], [run("c1", shown(led))]),
    ),
  ).toHaveLength(1);
});

test("composed batches listed in another order are the same pair, matched by ID", () => {
  const two = (first: string, second: string) => ({
    changeMap: { hunkRoles: [], behaviours: [] },
    assembled: [first, second].map((id) => ({
      batches: [
        {
          id,
          digest: { digest: plain, verification: "Proof is thin." },
        },
      ],
      units: [
        {
          id: `${id}.u1`,
          batchId: id,
          title: "t",
          hunkIds: [],
          ownedRanges: [],
          assessment: { lane: "agentic" },
        },
      ],
      references: [],
    })),
  });
  const pairs = pairRuns(
    [run("c1", two("b1a", "b1b"))],
    [run("c1", two("b1b", "b1a"))],
  );
  expect(checkDigestPairs(pairs)).toHaveLength(1);
  // Each batch's two digests are the same text here: one item per batch.
  expect(digestPairRubricSample(pairs, "seed").items).toHaveLength(2);
});

test("digests disclosed over their budget are counted per arm, and a run holding an ID twice is refused", () => {
  const disclosed = (gap: string | undefined) => {
    const value = shown(led) as ReturnType<typeof shown> & {
      assembled: Array<{ gaps?: Array<string> }>;
    };
    if (gap !== undefined) value.assembled[0]!.gaps = [gap];
    return value;
  };
  const result = digestComparison(
    pairRuns(
      [run("c1", disclosed(undefined))],
      [
        run(
          "c1",
          disclosed(
            "Batch b1's digest runs 140 words, over its budget of 97 for 1 unit(s).",
          ),
        ),
      ],
    ),
  );
  expect(result.overBudget).toEqual({ baseline: 0, candidate: 1 });
  const twice = shown(plain) as ReturnType<typeof shown> & {
    assembled: Array<{ units: Array<unknown> }>;
  };
  twice.assembled.push(structuredClone(twice.assembled[0]!) as never);
  expect(() =>
    checkDigestPairs(pairRuns([run("c1", twice)], [run("c1", twice)])),
  ).toThrow("twice");
});

test("led shares are compared per case with a bootstrap interval, and words per arm", () => {
  const cases = Array.from({ length: 10 }, (_, index) => `c${index}`);
  const result = digestComparison(
    pairRuns(
      cases.map((id) => run(id, shown(plain))),
      cases.map((id) => run(id, shown(led))),
    ),
  );
  expect(result.led.whatChangedLed).toMatchObject({
    batches: 10,
    baseline: 0,
    candidate: 1,
    delta: 1,
    interval: [1, 1],
  });
  // "Proof is thin." is one sentence in both arms: led by the one-paragraph rule.
  expect(result.led.whatToCheckLed).toMatchObject({ delta: 0 });
  expect(result.words.baseline.n).toBe(10);
  expect(result.words.candidate.p50).toBeGreaterThan(0);
});

test("the digest rubric is blind, keeps a batch's two digests in different calls, and reads none as good for misleading claims", () => {
  const pairs = pairRuns(
    [run("c1", shown(plain)), run("c2", shown(plain))],
    [run("c1", shown(led)), run("c2", shown(plain))],
  );
  const sample = digestPairRubricSample(pairs, "seed");
  // c1's two digests are two items; c2's shared one is one, counted for both arms.
  expect(sample.items).toHaveLength(3);
  expect(JSON.stringify(sample.items)).not.toMatch(/baseline|candidate/);
  // The judge gets what the digest's writer had: the batch, its obligations, each unit's ID,
  // facts and requirements.
  expect(sample.items[0]).toMatchObject({
    batch: { title: "Report usage", focus: "Check the usage." },
    obligations: [
      {
        id: "b1.o1",
        text: "Report store usage.",
        basis: "scope",
        hunkIds: ["h1"],
      },
    ],
    units: [
      {
        id: "b1.u1",
        path: "src/cache.ts",
        hunkIds: ["h1"],
        title: "Report store usage",
        facts: "The declarations report store usage.",
        factsCites: ["h1"],
        references: [{ id: "b1.r1", entries: ["p1.e4"], units: [] }],
        requirements: [
          { requirement: "Usage is reported", coverage: "missing", proof: [] },
        ],
      },
    ],
  });
  for (const call of pairRubricChunks(sample.items, sample.key, "seed")) {
    const batches = call.map(
      (item) => `${sample.key[item.id]!.caseId}|${sample.key[item.id]!.unit}`,
    );
    expect(new Set(batches).size).toBe(batches.length);
  }
  const decided = {
    version: 1 as const,
    answers: Object.entries(sample.key).map(([id, entry]) => ({
      id,
      accurate: "yes" as const,
      complete: "yes" as const,
      // The candidate's c1 digest is judged misleading; the shared c2 digest is not.
      misleadingClaim:
        entry.caseId === "c1" && entry.arms.includes("candidate")
          ? ("some" as const)
          : ("none" as const),
      neutralBeforeVerdict: "yes" as const,
      reason: "",
    })),
  };
  const read = digestRubricComparison(decided, sample.key);
  expect(read.questions.misleadingClaim).toMatchObject({
    judged: { baseline: 2, candidate: 2 },
    baseline: 1,
    candidate: 0.5,
    delta: -0.5,
  });
  expect(read.questions.accurate).toMatchObject({ baseline: 1, candidate: 1 });
});
