// Why (10.139): the title step writes a joined unit's lead line with its title, so a title candidate
// changes both. A lead that only restates the title is the owner's "1:1 repetition"; a rubric that
// showed judges a unit's two leads side by side, or read them without the sections they summarise,
// could not judge whether a lead is supported.
import { expect, test } from "bun:test";
import {
  leadComparison,
  leadOf,
  leadPairRubricSample,
  leadRubricComparison,
} from "../src/harness-compare/full-test/leads-compare.ts";
import {
  pairRubricChunks,
  pairRuns,
} from "../src/harness-compare/full-test/titles-compare.ts";

const range = (start: number, end: number, hunkId: string) => ({
  kind: "lines",
  hunkId,
  startLine: start,
  endLine: end,
});

const shown = (lead: string) => ({
  changeMap: { hunkRoles: [] },
  assembled: [
    {
      units: [
        {
          id: "b1.u1",
          title: "Report store usage from cache declarations",
          hunkIds: ["h1", "h2"],
          ownedRanges: [],
          assessment: { lane: "agentic" },
          content: {
            briefed: `${lead}\n\nReport: It reports.\n\nReceipt: It carries.`,
          },
          sections: [
            {
              id: "b1.s1",
              title: "Report",
              ownedRanges: [range(1, 9, "h1")],
              content: { facts: { text: "The declarations report usage." } },
            },
            {
              id: "b1.s2",
              title: "Receipt",
              ownedRanges: [range(20, 29, "h2")],
              content: { facts: { text: "The receipt carries it." } },
            },
          ],
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

const restating = "Report store usage from cache declarations.";
const together =
  "Two changes: the declarations report usage and the receipt carries it.";

test("a lead that restates the unit's title is counted per arm, with a bootstrap interval", () => {
  expect(leadOf(shown(together).assembled[0]!.units[0]!)).toBe(together);
  const cases = Array.from({ length: 10 }, (_, index) => `c${index}`);
  const result = leadComparison(
    pairRuns(
      cases.map((id) => run(id, shown(restating))),
      cases.map((id) => run(id, shown(together))),
    ),
  );
  expect(result.units).toBe(10);
  expect(result.repeatsTitle).toMatchObject({
    baseline: 1,
    candidate: 0,
    delta: -1,
    interval: [-1, -1],
  });
});

test("the lead rubric is blind, carries the sections' titles and Facts, and keeps a unit's two leads apart", () => {
  const pairs = pairRuns(
    [run("c1", shown(restating)), run("c2", shown(together))],
    [run("c1", shown(together)), run("c2", shown(together))],
  );
  const sample = leadPairRubricSample(pairs, "seed");
  expect(sample.items).toHaveLength(3);
  expect(JSON.stringify(sample.items)).not.toMatch(/baseline|candidate/);
  expect(sample.items[0]!.sections).toEqual([
    { title: "Report", facts: "The declarations report usage." },
    { title: "Receipt", facts: "The receipt carries it." },
  ]);
  for (const call of pairRubricChunks(sample.items, sample.key, "seed")) {
    const units = call.map((item) => sample.key[item.id]!.caseId);
    expect(new Set(units).size).toBe(units.length);
  }
  const decided = {
    version: 1 as const,
    answers: Object.entries(sample.key).map(([id, entry]) => ({
      id,
      together:
        entry.caseId === "c1" && entry.arms.includes("baseline")
          ? ("no" as const)
          : ("yes" as const),
      supported: "yes" as const,
      addsNothing: "yes" as const,
      reason: "",
    })),
  };
  const read = leadRubricComparison(decided, sample.key);
  expect(read.questions.together).toMatchObject({
    baseline: 0.5,
    candidate: 1,
    delta: 0.5,
  });
  expect(read.questions.supported).toMatchObject({ baseline: 1, candidate: 1 });
});
