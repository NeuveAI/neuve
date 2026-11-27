// Why:
// 4. A unit's verdict follows the two-keys rule: any request for changes wins, only all approvals
//    approve, and one undecided section beside approving ones never makes an approving unit in
//    another lane.
// 5. A section in each of static automation, agentic, human-suggested and human-required, with an
//    approval and with a request for changes, gets the disposition `applyLane` defines: the dock's
//    per-lane rule.
// A confirmed defect a request for changes rests on is always shown, even behind three impact
// comments: a request must never reach a person without the defect it rests on.
// A requirement nothing proves must not be hidden by a sibling section's proof: the unit's proof
// text keeps every distinct state, whatever the sections' order.
import { expect, test } from "bun:test";
import { applyLane } from "../src/disposition.ts";
import { decideSection } from "../src/readings/decide.ts";
import {
  composeUnits,
  rankComments,
  unitVerdict,
  type UnitComment,
} from "../src/readings/units.ts";
import { inputFor, LANES } from "./fixtures/readings.ts";

const section = (
  key: string,
  order: number,
  options: Parameters<typeof inputFor>[0],
) => {
  const input = inputFor(options);
  return {
    path: "a.ts",
    order,
    decision: decideSection({
      ...input,
      section: { ...input.section, key },
    }),
  };
};

test("a unit requests changes if any section does, approves only if all do, and an undecided section never joins an approving unit", () => {
  expect(unitVerdict(["approve", "request-changes", null])).toBe(
    "request-changes",
  );
  expect(unitVerdict(["approve", "approve"])).toBe("approve");
  expect(unitVerdict(["approve", null])).toBeNull();
  expect(unitVerdict([])).toBeNull();

  const units = composeUnits([
    section("one", 0, { lane: "agentic" }),
    section("two", 1, {
      lane: "agentic",
      claims: [{ source: "lane-review", verify: "unconfirmed" }],
    }),
    section("three", 2, { lane: "agentic" }),
    section("four", 3, { lane: "human-required" }),
    section("five", 4, {
      lane: "agentic",
      review: "request-changes",
      claims: [{ source: "lane-review", verify: "confirmed" }],
    }),
  ]);
  expect(
    units.map((unit) => ({
      lane: unit.lane,
      keys: unit.sectionKeys,
      verdict: unit.verdict,
      undecided: unit.undecided,
    })),
  ).toEqual([
    // Agentic: two approvals.
    {
      lane: "agentic",
      keys: ["one", "three"],
      verdict: "approve",
      undecided: {},
    },
    // Human-required: the undecided section, an approving one and the confirmed request for
    // changes, which lane rule 5 makes human-required (14.34), one unit; no verdict while a
    // section is undecided.
    {
      lane: "human-required",
      keys: ["two", "four", "five"],
      verdict: null,
      undecided: { unconfirmed: 1 },
    },
  ]);
  // An approval and a request in one unit: the request wins.
  const requesting = composeUnits([
    section("four", 0, { lane: "human-required" }),
    section("five", 1, {
      lane: "agentic",
      review: "request-changes",
      claims: [{ source: "lane-review", verify: "confirmed" }],
    }),
  ]);
  expect(
    requesting.map((unit) => [unit.lane, unit.sectionKeys, unit.verdict]),
  ).toEqual([["human-required", ["four", "five"], "request-changes"]]);
  const approving = composeUnits([
    section("one", 0, { lane: "agentic" }),
    section("two", 1, { lane: "agentic" }),
    section("three", 2, { lane: "agentic", review: "unsure" }),
  ]);
  expect(approving.map((unit) => [unit.lane, unit.verdict])).toEqual([
    ["agentic", "approve"],
    ["human-required", null],
  ]);
});

// Reason (round 32, the owner's ruling): "all units for a file that are on a certain lane for a
// certain batch will be presented as one unit for that file. Always." A file splits only across
// lanes; decided and undecided sections of one lane are one unit, with no verdict (it would also
// stand for the sections no agent judged), so applyLane gives no disposition or suggestion.
test("a file's decided and undecided sections in one lane are one unit with no verdict; a file across two lanes is two units", () => {
  const units = composeUnits([
    section("decided-1", 0, { lane: "human-required" }),
    section("undecided-1", 1, { lane: "human-required", review: "unsure" }),
    section("decided-2", 2, { lane: "human-required" }),
    section("undecided-2", 3, { assess: "failed" }),
    section("agentic-1", 4, { lane: "agentic" }),
    section("agentic-2", 5, { lane: "agentic" }),
  ]);
  expect(
    units.map((unit) => ({
      lane: unit.lane,
      keys: unit.sectionKeys,
      verdict: unit.verdict,
      disposition: unit.disposition,
      suggestion: unit.suggestion,
      undecided: unit.undecided,
    })),
  ).toEqual([
    {
      lane: "human-required",
      keys: ["decided-1", "undecided-1", "decided-2", "undecided-2"],
      verdict: null,
      disposition: undefined,
      suggestion: false,
      undecided: { unsure: 1, failed: 1 },
    },
    {
      lane: "agentic",
      keys: ["agentic-1", "agentic-2"],
      verdict: "approve",
      disposition: "approve",
      suggestion: false,
      undecided: {},
    },
  ]);
});

// Reason (round 32): an undecided section can still request changes (a confirmed claim beside an
// unconfirmed one); joined with a decided section, the unit still has no verdict, never a request
// that would stand for a section no agent judged.
test("an undecided section that requests changes gives its unit no verdict", () => {
  const undecided = section("undecided", 1, {
    lane: "human-required",
    review: "request-changes",
    claims: [
      { source: "lane-review", verify: "confirmed" },
      { source: "lane-review", verify: "unconfirmed" },
    ],
  });
  expect(undecided.decision.settled && undecided.decision.entry).toMatchObject({
    verdict: "request-changes",
    undecided: { cause: "unconfirmed" },
  });
  const [unit, ...rest] = composeUnits([
    section("decided", 0, { lane: "human-required" }),
    undecided,
  ]);
  expect(rest).toEqual([]);
  expect(unit).toMatchObject({
    lane: "human-required",
    sectionKeys: ["decided", "undecided"],
    verdict: null,
    disposition: undefined,
    suggestion: false,
    undecided: { unconfirmed: 1 },
  });
});

test("each lane's approval and request become the disposition applyLane defines", () => {
  const expected = {
    "static-automation": {
      approve: { disposition: undefined, suggestion: false },
      "request-changes": { disposition: "request-changes", suggestion: false },
    },
    agentic: {
      approve: { disposition: "approve", suggestion: false },
      "request-changes": { disposition: "request-changes", suggestion: false },
    },
    "human-suggested": {
      approve: { disposition: "approve", suggestion: false },
      "request-changes": { disposition: "request-changes", suggestion: false },
    },
    "human-required": {
      approve: { disposition: undefined, suggestion: true },
      "request-changes": { disposition: "request-changes", suggestion: true },
    },
  } as const;
  for (const lane of LANES)
    for (const verdict of ["approve", "request-changes"] as const) {
      const [unit] = composeUnits([
        section("one", 0, {
          lane,
          review: verdict,
          claims:
            verdict === "approve"
              ? []
              : [{ source: "lane-review", verify: "confirmed" }],
        }),
      ]);
      // A request for changes on a confirmed claim is human-required in every lane (14.34).
      const unitLane = verdict === "approve" ? lane : "human-required";
      expect({ lane, verdict, unitLane: unit!.lane }).toEqual({
        lane,
        verdict,
        unitLane,
      });
      expect({
        lane,
        verdict,
        disposition: unit!.disposition,
        suggestion: unit!.suggestion,
      }).toEqual({ lane, verdict, ...expected[unitLane][verdict] });
      expect(applyLane(lane, verdict)).toEqual(expected[lane][verdict]);
    }
  // The proof text rests on the unit's sections' requirements.
  const [proven] = composeUnits([
    section("one", 0, { lane: "static-automation" }),
  ]);
  expect(proven!.proof).toEqual({
    proof: ["p1", "p2"],
    text: 'Proof: "Parsing an empty list returns no rows." rests on 2 proof record(s) (solid).',
  });
});

test("a confirmed defect a request rests on is shown even behind three impact comments", () => {
  const at = (startLine: number) => ({
    path: "a.ts",
    side: "new" as const,
    startLine,
    endLine: startLine,
  });
  const comments: ReadonlyArray<UnitComment> = [
    {
      id: "q",
      source: "lane-review",
      kind: "question",
      anchor: at(1),
      cites: 0,
    },
    {
      id: "added",
      source: "lane-review",
      kind: "impact",
      effect: "added",
      anchor: at(2),
      cites: 0,
    },
    {
      id: "removed",
      source: "lane-review",
      kind: "impact",
      effect: "removed",
      anchor: at(3),
      cites: 0,
    },
    {
      id: "disabled",
      source: "lane-review",
      kind: "impact",
      effect: "disabled",
      anchor: at(4),
      cites: 0,
    },
    {
      id: "narrowed",
      source: "lane-review",
      kind: "impact",
      effect: "narrowed",
      anchor: at(5),
      cites: 0,
    },
    {
      id: "defect",
      source: "lane-review",
      kind: "defect",
      verify: "confirmed",
      anchor: at(60),
      cites: 0,
    },
    {
      id: "refuted",
      source: "lane-review",
      kind: "defect",
      verify: "refuted",
      anchor: at(70),
      cites: 0,
    },
    {
      id: "changed",
      source: "lane-review",
      kind: "impact",
      effect: "changed",
      anchor: at(6),
      cites: 0,
    },
  ];
  const ranked = rankComments(comments, { restsOn: ["defect"] });
  expect(ranked.map((c) => [c.id, c.rank, c.fate])).toEqual([
    ["removed", 1, "shown"],
    ["disabled", 2, "shown"],
    ["narrowed", 3, "shown"],
    ["defect", 4, "shown"],
    ["refuted", 5, "refuted"],
    ["changed", 6, "below-cut"],
    ["added", 7, "below-cut"],
    ["q", 8, "below-cut"],
  ]);
  // Without the request resting on it, the cut applies to it like any other.
  expect(rankComments(comments).find((c) => c.id === "defect")!.fate).toBe(
    "below-cut",
  );
});

test("a requirement nothing proves is not hidden by a sibling section's proof", () => {
  const withProof = (
    key: string,
    order: number,
    proof: ReadonlyArray<string>,
  ) => {
    const input = inputFor({ lane: "agentic" });
    if (!input.assess.judged) throw new Error("expected an assessment");
    const judgement = input.assess.judgement;
    return {
      path: "a.ts",
      order,
      decision: decideSection({
        ...input,
        section: { ...input.section, key },
        assess: {
          judged: true,
          judgement: {
            ...judgement,
            easeOfValidation: {
              ...judgement.easeOfValidation,
              requirements: judgement.easeOfValidation.requirements.map(
                (r) => ({ ...r, proof }),
              ),
            },
          },
        },
      }),
    };
  };
  const proofs = [
    [withProof("a", 0, ["p1"]), withProof("b", 1, [])],
    [withProof("b", 0, []), withProof("a", 1, ["p1"])],
  ].map((sections) => {
    const units = composeUnits(sections);
    expect(units.map((unit) => [unit.lane, unit.verdict])).toEqual([
      ["agentic", "approve"],
    ]);
    return units[0]!.proof;
  });
  expect(proofs[0]).toEqual({
    proof: ["p1"],
    text: 'Proof: "Parsing an empty list returns no rows.": proof is not recorded. "Parsing an empty list returns no rows." rests on 1 proof record(s) (shallow).',
  });
  expect(proofs[1]).toEqual(proofs[0]);
});
