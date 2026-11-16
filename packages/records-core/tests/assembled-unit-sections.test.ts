// Why (10.109): a unit can now hold several separate changes of one file, each with the lines it
// owns. Records decodes every stored assembled batch with today's schema (published-packets.ts); if
// the new field were required, or accepted malformed sections, every packet published before it
// would stop decoding strictly, or a section could claim lines with no shape the desk can draw.
import { expect, test } from "bun:test";
import { AssembledUnit } from "@neuve/records-schema";

const unit = {
  id: "b1.u1",
  batchId: "b1",
  path: "a.ts",
  hunkIds: ["h1"],
  changedLines: 4,
  from: ["b1.s1"],
  grouping: { gapLines: 0 },
  ownedRanges: [
    {
      kind: "lines",
      hunkId: "h1",
      path: "a.ts",
      side: "new",
      startLine: 1,
      endLine: 2,
    },
    {
      kind: "lines",
      hunkId: "h1",
      path: "a.ts",
      side: "new",
      startLine: 9,
      endLine: 10,
    },
  ],
  ownedPaths: ["a.ts"],
  title: "Two changes",
  group: "b1.g1",
  references: [],
  assessment: {
    status: "assessed",
    source: "agent",
    quadrant: "low-hard",
    lane: "human-suggested",
    laneNote: "low complexity, hard to validate: human-suggested",
    complexity: { level: "low", factors: [] },
    validation: { level: "hard", requirements: [] },
    movement: [],
    lean: null,
    gaps: [],
    rationale: "r",
    highComplexityValidationGap: false,
  },
  content: {
    source: "agent",
    facts: { text: "f", cites: [] },
    briefed: null,
    explained: null,
    verdictWords: 0,
    laneWords: 0,
  },
};

const sections = [
  {
    id: "b1.s1",
    title: "the reader",
    ownedRanges: [unit.ownedRanges[0]],
  },
  {
    id: "b1.s3",
    title: "the writer",
    ownedRanges: [unit.ownedRanges[1]],
  },
];

test("a unit assembled before sections still decodes, and one with sections decodes with them", () => {
  expect(AssembledUnit.safeParse(unit).success).toBe(true);
  const withSections = AssembledUnit.safeParse({ ...unit, sections });
  expect(withSections.success).toBe(true);
  expect(withSections.data?.sections?.map((section) => section.id)).toEqual([
    "b1.s1",
    "b1.s3",
  ]);
});

test("a section must name itself, its title and owned ranges in the units' own shape", () => {
  for (const bad of [
    [{ id: "b1.s1", title: "no ranges" }],
    [{ id: "b1.s1", ownedRanges: [] }],
    [
      {
        ...sections[0],
        ownedRanges: [
          {
            kind: "lines",
            path: "a.ts",
            side: "new",
            startLine: 0,
            endLine: 2,
          },
        ],
      },
    ],
    [{ ...sections[0], extra: true }],
  ])
    expect(AssembledUnit.safeParse({ ...unit, sections: bad }).success).toBe(
      false,
    );
});

// Why (pipeline 10): the desk reads each section's own content; older sections have none.
test("a section's own content is optional, and in the unit content's own shapes", () => {
  const content = {
    facts: { text: "It changes the reader.", cites: ["h1"] },
    briefed: "The [reader](h1) now checks its input.",
    explained: { before: "b", after: "a", terms: [], cites: ["h1"] },
  };
  const withContent = sections.map((section) => ({ ...section, content }));
  expect(
    AssembledUnit.safeParse({ ...unit, sections: withContent }).success,
  ).toBe(true);
  expect(
    AssembledUnit.safeParse({
      ...unit,
      sections: [
        {
          ...sections[0],
          content: { ...content, briefed: null, explained: null },
        },
      ],
    }).success,
  ).toBe(true);
  for (const bad of [
    { ...content, facts: { text: "x" } },
    { ...content, explained: { ...content.explained, terms: [1, 2, 3, 4] } },
    { ...content, extra: true },
  ])
    expect(
      AssembledUnit.safeParse({
        ...unit,
        sections: [{ ...sections[0], content: bad }],
      }).success,
    ).toBe(false);
});
