// Why: the two answers are model output, and the lane and verdict are computed from them, so code's
// checks must catch every hard problem (a missing or repeated section row, an index that names
// nothing, a cite that does not resolve, a request with no defect comment, an approval beside a
// defect comment or a not-met row, a comment off its section's lines, a row the file was not given,
// a met row on proof that does not converge, an answer that is not the schema), and repair must
// drop what cannot stand without ever turning a request for changes into an approval or the reverse.
import { expect, test } from "bun:test";
import {
  ANSWER_BOUNDS,
  AssessAnswer,
  PROBLEM_CLASSES,
  assessExpand,
  assessIssues,
  assessProblems,
  assessRepair,
  laneReviewExpand,
  laneReviewIssues,
  laneReviewProblems,
  laneReviewRepair,
  LaneReviewAnswer,
  LIST_CEILING,
  problemCounts,
  readingIndex,
  REPAIRED_WITHOUT_A_TURN,
  IMPACT_WORDS,
  MET_READING,
  StoredAssessAnswer,
  StoredLaneReviewAnswer,
} from "../src/readings/answers.ts";

const index = readingIndex({
  files: [
    {
      index: 0,
      path: "src/a.ts",
      rows: [{ row: "r1", text: "Empty lists parse.", requirements: [] }],
    },
  ],
  sections: [
    {
      index: 0,
      key: "k0",
      file: 0,
      owned: [{ side: "new", startLine: 10, endLine: 20 }],
    },
    {
      index: 1,
      key: "k1",
      file: 0,
      owned: [
        { side: "new", startLine: 30, endLine: 40 },
        { side: "old", startLine: 30, endLine: 35 },
      ],
    },
  ],
  facts: [{ id: "f1", section: 0 }],
  proofs: [
    {
      id: "p1",
      kind: "test-run",
      requirement: "Empty lists parse.",
      currency: { "src/a.ts": "current" },
    },
  ],
});

/** One Assess class: the sections it lists, its two levels and the rest as given. */
const cls = (
  S: ReadonlyArray<number>,
  c = "l",
  v = "e",
  more: Record<string, unknown> = {},
) => ({ S, c, v, F: [], R: [], person: null, gaps: null, ...more });

const assess = (
  classes: ReadonlyArray<unknown>,
  factorCites = ["0n12-14"],
) => ({
  factors: [{ f: "connections", t: "Two callers.", cites: factorCites }],
  requirements: [
    {
      t: "Empty lists parse.",
      kinds: ["test-run"],
      cites: ["0n12"],
      testable: true,
      untested: "",
      proof: ["p1"],
      agree: true,
    },
  ],
  impact: [
    { s: 1, effect: "narrowed", t: "Accepts fewer inputs.", cites: ["0o31"] },
  ],
  classes,
});

test("the cite form resolves lines on owned lines, facts and proof records, and nothing else", () => {
  expect(index.resolve("0n12-14")).toMatchObject({
    kind: "lines",
    stable: "src/a.ts:new:12-14",
    sections: [0],
  });
  expect(index.resolve("0o31")).toMatchObject({ kind: "lines", sections: [1] });
  expect(index.resolve("f1")).toEqual({
    kind: "fact",
    stable: "f1",
    section: 0,
  });
  expect(index.resolve("p1")).toEqual({ kind: "proof", stable: "p1" });
  for (const cite of ["0n50-60", "1n12", "0n14-12", "0o12", "zz", "0x12"])
    expect(index.resolve(cite)).toEqual({ kind: "unknown", cite });
});

test("Assess: a sound answer has no problems and expands to the stored form", () => {
  const answer = assess([
    cls([0], "h", "e", { F: [0], R: [0] }),
    cls([1], "h", "e", { person: { need: "no", why: "Tests cover it." } }),
  ]);
  expect(assessProblems(answer, index)).toEqual([]);
  const [first, second] = assessExpand(answer, index);
  expect(first!.key).toBe("k0");
  expect(first!.judgement.lean?.lane).toBe("human-suggested");
  expect(first!.judgement.complexity.factors).toEqual([
    {
      factor: "connections",
      finding: "Two callers.",
      cites: ["src/a.ts:new:12-14"],
      uncited: false,
    },
  ]);
  expect(first!.judgement.easeOfValidation.requirements[0]!.anchors).toEqual([
    { path: "src/a.ts", side: "new", startLine: 12, endLine: 12 },
  ]);
  expect(second!.judgement.lean).toEqual({
    lane: "agentic",
    reason: "Tests cover it.",
  });
  expect(second!.judgement.impact).toEqual([
    {
      effect: "narrowed",
      text: "Accepts fewer inputs.",
      cites: ["src/a.ts:old:31-31"],
    },
  ]);
  // Not complex and easy: no lean.
  const [low] = assessExpand(
    assess([cls([0], "l", "e"), cls([1], "l", "h")]),
    index,
  );
  expect(low!.judgement.lean).toBeNull();
});

test("Assess: missing and repeated sections, indices that name nothing and unknown cites are problems; repair drops them", () => {
  const missing = assess([cls([0])]);
  expect(assessProblems(missing, index)).toEqual([
    "Section 1 is in no class; list every section in exactly one class.",
  ]);
  expect(assessRepair(missing, index).unanswered).toEqual([1]);

  const repeated = assess([cls([0, 1]), cls([1], "h", "h")]);
  expect(assessProblems(repeated, index)).toEqual([
    "Section 1 is listed 2 times; list it once, in exactly one class.",
  ]);
  const repairedRepeated = assessRepair(repeated, index);
  expect(repairedRepeated.unanswered).toEqual([1]);
  expect(assessExpand(repeated, index).map((s) => s.key)).toEqual(["k0"]);

  const outOfRange = assess(
    [cls([0], "h", "h", { F: [0, 3], R: [0, 1] }), cls([1, 7])],
    ["0n50-60", "zz"],
  );
  const problems = assessProblems(
    {
      ...outOfRange,
      impact: [{ s: 9, effect: "disabled", t: "Gone.", cites: [] }],
    },
    index,
  );
  expect(problems).toEqual([
    "Class 1 lists section 7, which this reading does not list.",
    "Factor 0 cites 0n50-60, zz, which this reading does not list.",
    "Impact entry 0 names section 9, which this reading does not list.",
    "Class 0 names factor 3; there is 1 factor (numbered from 0).",
    "Class 0 names requirement 1; there is 1 requirement (numbered from 0).",
  ]);
  const repaired = assessRepair(outOfRange, index);
  expect(repaired.unanswered).toEqual([]);
  // The stray index judges nothing: it is taken out of its class.
  expect(repaired.answer!.classes as unknown).toEqual([
    { S: [0], c: "h", v: "h", F: [0], R: [0], person: null, gaps: null },
    cls([1]),
  ]);
  const [expanded] = assessExpand(outOfRange, index);
  // The factor's cites did not resolve: dropped, and the factor is uncited.
  expect(expanded!.judgement.complexity.factors[0]).toMatchObject({
    cites: [],
    uncited: true,
  });
  // A proof ID that is not the reading's is a problem, and is dropped.
  const unknownProof = assess([cls([0], "l", "e", { R: [0] }), cls([1])]);
  unknownProof.requirements[0]!.proof = ["p1", "p9"];
  expect(assessProblems(unknownProof, index)).toEqual([
    "Requirement 0 names p9, which is not a proof record of this reading.",
  ]);
  expect(
    assessRepair(unknownProof, index).answer!.requirements[0]!.proof,
  ).toEqual(["p1"]);
});

test("Assess: an answer that is not the schema is a problem and leaves every section unanswered", () => {
  for (const raw of [
    { classes: "all fine" },
    assess([cls([0, 1], "m")]),
    { ...assess([]), lane: "agentic" },
    // The row form of an earlier version is not the schema.
    {
      ...assess([]),
      sections: [
        { s: 0, c: "l", v: "e", F: [], R: [], person: null, gaps: null },
      ],
    },
  ]) {
    expect(assessProblems(raw, index).length).toBeGreaterThan(0);
    expect(assessRepair(raw, index)).toEqual({
      answer: null,
      unanswered: [0, 1],
    });
    expect(assessExpand(raw, index)).toEqual([]);
  }
});

/** The sections by verdict, each list empty unless given. */
const V = (lists: {
  readonly a?: ReadonlyArray<number>;
  readonly r?: ReadonlyArray<number>;
  readonly u?: ReadonlyArray<number>;
}) => ({ a: [], r: [], u: [], ...lists });

const review = (
  sections: Parameters<typeof V>[0],
  comments: ReadonlyArray<Record<string, unknown>> = [],
  rows: ReadonlyArray<unknown> = [],
) => ({
  files: [{ f: 0, checked: "Read the parser and its callers.", rows }],
  sections: V(sections),
  comments: comments.map((c) => ({
    s: 0,
    side: "new",
    start: 12,
    end: 13,
    kind: "defect",
    effect: null,
    t: "Returns null on an empty list.",
    cites: ["0n12"],
    fails: "An empty list throws later.",
    row: null,
    ...c,
  })),
  unsure: [],
});

test("Lane review: a sound answer has no problems and expands per section", () => {
  const answer = review(
    V({ a: [1], r: [0] }),
    [{}],
    [{ row: "r1", status: "no-evidence", cites: [] }],
  );
  expect(laneReviewProblems(answer, index)).toEqual([]);
  const [first, second] = laneReviewExpand(answer, index);
  expect(first!.judgement).toMatchObject({
    verdict: "request-changes",
    checked: "Read the parser and its callers.",
    comments: [
      {
        path: "src/a.ts",
        side: "new",
        startLine: 12,
        endLine: 13,
        kind: "defect",
        cites: ["src/a.ts:new:12-12"],
        row: null,
      },
    ],
  });
  expect(second!.judgement.verdict).toBe("approve");
});

test("Lane review: a request with no defect, an approval beside one or beside a not-met row, become unsure", () => {
  const noDefect = review(V({ a: [1], r: [0] }), [{ kind: "risk" }]);
  expect(laneReviewProblems(noDefect, index)).toEqual([
    "Section 0 requests changes with no defect comment in it; a request rests on a defect you found, or mark it a (approve) or u (unsure).",
  ]);
  expect(laneReviewRepair(noDefect, index).answer!.sections as unknown).toEqual(
    V({ a: [1], u: [0] }),
  );

  const besideDefect = review(V({ a: [0, 1] }), [{}]);
  expect(laneReviewProblems(besideDefect, index)).toEqual([
    "Section 0 is approved beside a defect comment in it; request changes, or record the concern as a risk or a question.",
  ]);
  expect(laneReviewExpand(besideDefect, index)[0]!.judgement.verdict).toBe(
    "unsure",
  );

  const besideNotMet = review(
    V({ a: [1], r: [0] }),
    [{}],
    [{ row: "r1", status: "not-met", cites: ["0n33"] }],
  );
  expect(laneReviewProblems(besideNotMet, index)).toEqual([
    "Section 1 is approved, but row r1 is not met on its lines; request changes resting on the defect, or mark the row no-evidence.",
  ]);
  const repaired = laneReviewRepair(besideNotMet, index).answer!;
  // The request stands, the breaching approval is unsure; neither turns into the other.
  expect(repaired.sections as unknown).toEqual(V({ r: [0], u: [1] }));
});

test("Lane review: off-section comments, rows not given, met without converging proof, and missing rows", () => {
  const answer = review(
    V({ a: [0, 0] }),
    [
      { kind: "question", start: 30, end: 31 },
      { kind: "risk", row: "r9", cites: ["0n12", "nope"] },
    ],
    [
      { row: "r1", status: "met", cites: ["p1"] },
      { row: "r2", status: "met", cites: [] },
    ],
  );
  expect(laneReviewProblems(answer, index)).toEqual([
    "Section 0 is listed 2 times; list it once, under one of a, r or u.",
    "Section 1 has no verdict; list it once, under a, r or u.",
    "r1 is met only on two or more kinds of proof, current for this file, that agree; it cites only test-run. Mark it no-evidence, or not-met if the change fails it.",
    "File 0 judges row r2, which it was not given; its rows are r1.",
    "Comment 0 is on new lines 30-31, which are not lines section 0 owns; anchor it on that section's changed lines.",
    "Comment 1 names row r9, which section 0's file was not given.",
    "Comment 1 cites nope, which this reading does not list.",
  ]);
  const repaired = laneReviewRepair(answer, index);
  expect(repaired.unanswered).toEqual([0, 1]);
  // The refused met keeps its (empty) reading as code's words alone.
  expect(repaired.answer!.files[0]!.rows).toEqual([
    {
      row: "r1",
      status: "no-evidence",
      cites: ["p1"],
      reading: "The code reads as meeting this.",
    },
  ]);
  expect(repaired.answer!.comments).toEqual([
    {
      s: 0,
      side: "new",
      start: 12,
      end: 13,
      kind: "risk",
      effect: null,
      t: "Returns null on an empty list.",
      cites: ["0n12"],
      fails: "An empty list throws later.",
      row: null,
    },
  ]);
  expect(laneReviewExpand(answer, index)).toEqual([]);
});

test("Lane review: an answer that is not the schema is a problem and leaves every section unanswered", () => {
  for (const raw of [
    null,
    // The row form of an earlier version is not the schema.
    { ...review({}), sections: [{ s: 0, v: "a" }] },
    { ...review({}), verdict: "approve" },
    review(V({ a: [0] }), [{ kind: "nit" }]),
  ]) {
    expect(laneReviewProblems(raw, index).length).toBeGreaterThan(0);
    expect(laneReviewRepair(raw, index)).toEqual({
      answer: null,
      unanswered: [0, 1],
    });
  }
});

// Why (round 1 fixes): an approval must never survive the removal of the evidence against it.
// Every breach is judged on the answer as written; repair then drops what cannot stand, and an
// unanchorable defect stays as a question so it keeps a fate.
const one = readingIndex({
  files: [
    {
      index: 0,
      path: "src/a.ts",
      rows: [{ row: "r1", text: "Empty lists parse.", requirements: [] }],
    },
  ],
  sections: [
    {
      index: 0,
      key: "k0",
      file: 0,
      owned: [{ side: "new", startLine: 10, endLine: 20 }],
    },
  ],
  facts: [],
  proofs: [
    {
      id: "p1",
      kind: "test-run",
      requirement: "Empty lists parse.",
      currency: { "src/a.ts": "current" },
    },
  ],
});

const defect = (anchor: Record<string, unknown>) => ({
  s: 0,
  side: "new",
  start: 25,
  end: 26,
  kind: "defect",
  effect: null,
  t: "Returns null on an empty list.",
  cites: [],
  fails: "An empty list throws later.",
  row: null,
  ...anchor,
});

const verdictOf = (raw: unknown, at = one, section = 0) =>
  laneReviewExpand(raw, at).find((s) => s.section === section)?.judgement
    .verdict;

test("a defect comment off its section's lines still stops the approval, and stays as a question", () => {
  for (const [at, anchor, where] of [
    [one, { start: 25, end: 26 }, "new lines 25-26"],
    [one, { start: 15, end: 12 }, "new lines 15-12"],
    [one, { side: "old", start: 12, end: 13 }, "old lines 12-13"],
    [one, { start: 12, end: 10_000_001 }, "new lines 12-10000001"],
    [index, { start: 32, end: 33 }, "new lines 32-33"],
  ] as const) {
    const raw = {
      files: [{ f: 0, checked: "Read it.", rows: null }],
      sections: at === one ? V({ a: [0] }) : V({ a: [0, 1] }),
      comments: [defect(anchor)],
      unsure: [],
    };
    expect(laneReviewProblems(raw, at)).toContain(
      "Section 0 is approved beside a defect comment in it; request changes, or record the concern as a risk or a question.",
    );
    const [expanded] = laneReviewExpand(raw, at);
    expect(expanded!.judgement.verdict).toBe("unsure");
    // Section 0 owns no old lines, so a defect written on old lines moves to its new lines.
    expect(expanded!.judgement.comments).toEqual([
      {
        path: "src/a.ts",
        side: "new",
        startLine: 10,
        endLine: 20,
        kind: "question",
        text: `(Written on ${where}.) Returns null on an empty list.`,
        cites: [],
        fails: "An empty list throws later.",
        row: null,
      },
    ]);
  }
});

test("a request resting only on defects off its lines is unsure, and the moved question stays", () => {
  const raw = {
    files: [{ f: 0, checked: "Read it.", rows: null }],
    sections: V({ r: [0] }),
    comments: [defect({})],
    unsure: [],
  };
  expect(laneReviewProblems(raw, one)).toContain(
    "Section 0 requests changes, but none of its defect comments is on lines it owns; anchor the defect on the section's changed lines, or mark it u (unsure).",
  );
  const [expanded] = laneReviewExpand(raw, one);
  expect(expanded!.judgement.verdict).toBe("unsure");
  expect(expanded!.judgement.comments.map((c) => [c.kind, c.text])).toEqual([
    [
      "question",
      "(Written on new lines 25-26.) Returns null on an empty list.",
    ],
  ]);
  // One anchored defect is enough for the request to stand.
  expect(
    verdictOf({
      ...raw,
      comments: [defect({}), defect({ start: 12, end: 12 })],
    }),
  ).toBe("request-changes");
});

test("a moved defect anchors on its own side where the section owns lines there, and its note fits the bound", () => {
  const long = "x".repeat(400);
  const raw = {
    files: [{ f: 0, checked: "Read it.", rows: null }],
    sections: V({ u: [0, 1] }),
    comments: [
      defect({ s: 1, side: "old", start: 50, end: 50, t: long }),
      defect({ s: 1, side: "new", start: 50, end: 51 }),
    ],
    unsure: [],
  };
  const moved = laneReviewExpand(raw, index)[1]!.judgement.comments;
  expect(moved.map((c) => [c.side, c.startLine, c.endLine])).toEqual([
    ["old", 30, 35],
    ["new", 30, 40],
  ]);
  const note = "(Written on old line 50.) ";
  // One long word: cut at the bound, ending with the ellipsis the bound counts.
  expect(moved[0]!.text).toBe(
    `${note}${"x".repeat(400 - note.length - 1)}\u2026`,
  );
  expect(moved[0]!.text.length).toBe(400);
});

test("a moved defect is never cut by the three-comment cap", () => {
  const risks = [0, 1, 2].map(() =>
    defect({ kind: "risk", start: 12, end: 13, t: "A risk." }),
  );
  const offLines = defect({ start: 500, end: 501 });
  const approved = {
    files: [{ f: 0, checked: "Read it.", rows: null }],
    sections: V({ a: [0] }),
    comments: [...risks, offLines],
    unsure: [],
  };
  const [first] = laneReviewExpand(approved, one);
  expect(first!.judgement.verdict).toBe("unsure");
  expect(first!.judgement.comments.map((c) => c.kind)).toEqual([
    "risk",
    "risk",
    "risk",
    "question",
  ]);
  const defects = [0, 1, 2].map((i) => defect({ start: 12 + i, end: 12 + i }));
  const requested = {
    ...approved,
    sections: V({ r: [0] }),
    comments: [...defects, offLines],
  };
  const [second] = laneReviewExpand(requested, one);
  expect(second!.judgement.verdict).toBe("request-changes");
  expect(second!.judgement.comments.map((c) => c.kind)).toEqual([
    "defect",
    "defect",
    "defect",
    "question",
  ]);
});

test("a defect on a section that owns no lines keeps its words as an unsure note", () => {
  const bare = readingIndex({
    files: [{ index: 0, path: "src/a.ts", rows: [] }],
    sections: [{ index: 0, key: "k0", file: 0, owned: [] }],
    facts: [],
    proofs: [],
  });
  const [expanded] = laneReviewExpand(
    {
      files: [{ f: 0, checked: "Read it.", rows: null }],
      sections: V({ a: [0] }),
      comments: [defect({})],
      unsure: [],
    },
    bare,
  );
  expect(expanded!.judgement.verdict).toBe("unsure");
  expect(expanded!.judgement.comments).toEqual([]);
  expect(expanded!.judgement.unsure).toEqual([
    "(Written on new lines 25-26.) Returns null on an empty list.",
  ]);
});

test("an orphan defect or not-met row makes every approval unsure, and its words reach the first section", () => {
  for (const orphan of [
    { comments: [defect({ s: 7 })], files: [] },
    {
      comments: [],
      files: [
        {
          f: 5,
          checked: "Read it.",
          rows: [{ row: "r1", status: "not-met", cites: [] }],
        },
      ],
    },
  ]) {
    const raw = {
      files: [{ f: 0, checked: "Read it.", rows: null }, ...orphan.files],
      sections: V({ a: [0], r: [1] }),
      comments: [defect({ s: 1, start: 32, end: 32 }), ...orphan.comments],
      unsure: [],
    };
    expect(laneReviewProblems(raw, index)).toContain(
      "Section 0 is approved, but this answer holds a defect comment or a not-met row on a section or file this reading does not list; place it on a listed one, or mark the approvals u (unsure).",
    );
    const expanded = laneReviewExpand(raw, index);
    expect(expanded.map((s) => s.judgement.verdict)).toEqual([
      "unsure",
      "request-changes",
    ]);
    expect(expanded[0]!.judgement.unsure).toEqual([
      orphan.comments.length > 0
        ? "(Written for section 7, which this reading does not list.) Returns null on an empty list."
        : "Row r1 was marked not met on file 5, which this reading does not list.",
    ]);
  }
});

test("a not-met row stops the approvals it falls in, or every approval of its file when it falls in none", () => {
  for (const cites of [["0n900-910"], [], ["p1"], ["p3"], ["0n12-99999999"]]) {
    const raw = {
      files: [
        {
          f: 0,
          checked: "Read it.",
          rows: [{ row: "r1", status: "not-met", cites }],
        },
      ],
      sections: V({ a: [0] }),
      comments: [],
      unsure: [],
    };
    expect(laneReviewProblems(raw, one)).toContain(
      "Section 0 is approved, but row r1 is not met and its cites fall on no changed section of this file; an approval cannot sit beside a not-met row. Request changes resting on the defect, or mark the row no-evidence.",
    );
    expect(verdictOf(raw)).toBe("unsure");
  }
  // A row that falls in one section stops that section's approval only.
  const targeted = {
    files: [
      {
        f: 0,
        checked: "Read it.",
        rows: [{ row: "r1", status: "not-met", cites: ["0n33"] }],
      },
    ],
    sections: V({ a: [0, 1] }),
    comments: [],
    unsure: [],
  };
  expect(
    laneReviewExpand(targeted, index).map((s) => s.judgement.verdict),
  ).toEqual(["approve", "unsure"]);
});

test("a not-met row in a repeated row or a repeated file entry still stops the approval", () => {
  const twice = [
    { row: "r1", status: "no-evidence", cites: [] },
    { row: "r1", status: "not-met", cites: ["0n12"] },
  ];
  const rowTwice = {
    files: [{ f: 0, checked: "Read it.", rows: twice }],
    sections: V({ a: [0] }),
    comments: [],
    unsure: [],
  };
  expect(laneReviewProblems(rowTwice, one)).toEqual([
    "File 0 judges row r1 more than once.",
    "Section 0 is approved, but row r1 is not met on its lines; request changes resting on the defect, or mark the row no-evidence.",
  ]);
  expect(verdictOf(rowTwice)).toBe("unsure");
  const fileTwice = {
    files: [
      { f: 0, checked: "Read it.", rows: [] },
      {
        f: 0,
        checked: "Read it again.",
        rows: [{ row: "r1", status: "not-met", cites: ["0n12"] }],
      },
    ],
    sections: V({ a: [0] }),
    comments: [],
    unsure: [],
  };
  expect(laneReviewProblems(fileTwice, one)).toContain(
    "File 0 has more than one entry.",
  );
  expect(verdictOf(fileTwice)).toBe("unsure");
});

test("an approval beside its own unsure entry, or with nothing said of what was checked, is unsure", () => {
  const withUnsure = {
    files: [{ f: 0, checked: "Read it.", rows: null }],
    sections: V({ a: [0] }),
    comments: [],
    unsure: [{ s: 0, t: "Could not see the caller." }],
  };
  expect(laneReviewProblems(withUnsure, one)).toEqual([
    "Section 0 is approved and also listed as unsure; mark it u, or remove its unsure entry.",
  ]);
  expect(verdictOf(withUnsure)).toBe("unsure");
  for (const files of [
    [],
    [{ f: 0, checked: "   ", rows: null }],
    [{ f: 0, checked: "", rows: null }],
  ]) {
    const unchecked = {
      files,
      sections: V({ a: [0] }),
      comments: [],
      unsure: [],
    };
    expect(laneReviewProblems(unchecked, one)).toEqual([
      // An empty checked line is counted, and still leaves nothing checked for the approval.
      ...(files.length === 0 ? [] : ["File entry 0's checked line is empty."]),
      "Section 0 is approved, but its file has no entry saying what was checked; add one.",
    ]);
    expect(verdictOf(unchecked)).toBe("unsure");
  }
  // A sound approval in the same reading stands.
  expect(
    verdictOf({
      files: [{ f: 0, checked: "Read it.", rows: null }],
      sections: V({ a: [0] }),
      comments: [],
      unsure: [],
    }),
  ).toBe("approve");
});

test("line numbers past the bound, or a range that ends before it starts, name nothing", () => {
  for (const cite of ["0n10-10000001", "0n10000001", "0n0", "0n20-10"])
    expect(one.resolve(cite)).toEqual({ kind: "unknown", cite });
  expect(one.resolve("0n10-10000000")).toMatchObject({ kind: "lines" });
});

// Why (follow-ups): a stored repaired answer is read again, so it must stay a valid answer: it
// parses under its own schema, and repairing or expanding it again gives the same judgements.
const bareSections = readingIndex({
  files: [{ index: 0, path: "src/a.ts", rows: [] }],
  sections: [
    { index: 0, key: "k0", file: 0, owned: [] },
    {
      index: 1,
      key: "k1",
      file: 0,
      owned: [{ side: "new", startLine: 10, endLine: 20 }],
    },
  ],
  facts: [],
  proofs: [],
});

const longDefect = (s: number) =>
  defect({ s, start: 500, end: 501, t: "y".repeat(400) });

test("a repaired Lane review answer parses, and repairing or expanding it again changes nothing", () => {
  const hostile: ReadonlyArray<readonly [unknown, typeof one]> = [
    // A 400-character defect on a section that owns no lines.
    [
      {
        files: [{ f: 0, checked: "Read it.", rows: null }],
        sections: V({ a: [0, 1] }),
        comments: [longDefect(0)],
        unsure: [],
      },
      bareSections,
    ],
    // The same on a section the reading does not list.
    [
      {
        files: [{ f: 0, checked: "Read it.", rows: null }],
        sections: V({ a: [0, 1] }),
        comments: [longDefect(9)],
        unsure: [],
      },
      bareSections,
    ],
    // Sixty orphan defects.
    [
      {
        files: [{ f: 0, checked: "Read it.", rows: null }],
        sections: V({ a: [0] }),
        comments: Array.from({ length: 60 }, () => longDefect(9)),
        unsure: [],
      },
      one,
    ],
    // Forty unsure entries and one such defect.
    [
      {
        files: [{ f: 0, checked: "Read it.", rows: null }],
        sections: V({ u: [0] }),
        comments: [longDefect(9)],
        unsure: Array.from({ length: 40 }, (_, i) => ({
          s: 0,
          t: `Note ${i}: ${"z".repeat(180)}`,
        })),
      },
      one,
    ],
    // Moved defects beside three risks, rows judged twice, met refused, cites that do not resolve.
    [
      {
        files: [
          {
            f: 0,
            checked: "Read it.",
            rows: [
              { row: "r1", status: "met", cites: ["p1", "nope"] },
              { row: "r1", status: "not-met", cites: [] },
              { row: "r9", status: "not-met", cites: [] },
            ],
          },
          { f: 0, checked: "Again.", rows: null },
          { f: 4, checked: "Elsewhere.", rows: null },
        ],
        sections: V({ a: [1, 1], r: [0] }),
        comments: [
          defect({ kind: "risk", start: 12, end: 12 }),
          defect({ kind: "risk", start: 13, end: 13 }),
          defect({ kind: "risk", start: 14, end: 14 }),
          defect({ start: 15, end: 15, cites: ["0n15", "zz"] }),
          defect({ side: "old", start: 600, end: 601, t: "w".repeat(400) }),
          defect({ s: 1, kind: "impact", start: 31, end: 31 }),
          defect({ s: 1, kind: "question", start: 1, end: 2 }),
        ],
        unsure: [{ s: 5, t: "Gone." }],
      },
      index,
    ],
  ];
  for (const [raw, at] of hostile) {
    const first = laneReviewRepair(raw, at);
    expect(first.answer).not.toBeNull();
    const parsed = LaneReviewAnswer.safeParse(first.answer);
    expect(parsed.success).toBe(true);
    expect(laneReviewRepair(first.answer, at)).toEqual(first);
    expect(laneReviewExpand(first.answer, at)).toEqual(
      laneReviewExpand(raw, at),
    );
  }
  // Past forty entries, the overflow is counted in the last, never dropped silently.
  const [, , sixty, forty] = hostile;
  const sixtyNotes = laneReviewRepair(sixty![0], one).answer!.unsure;
  expect(sixtyNotes.length).toBe(40);
  expect(sixtyNotes[39]!.t.endsWith(" (and 20 more notes)")).toBe(true);
  expect(sixtyNotes[0]!.t.startsWith("(Written for section 9, which")).toBe(
    true,
  );
  expect(sixtyNotes[0]!.t.length).toBe(200);
  const fortyNotes = laneReviewRepair(forty![0], one).answer!.unsure;
  expect(fortyNotes.length).toBe(40);
  expect(fortyNotes[39]!.t.endsWith(" (and 1 more note)")).toBe(true);
});

test("a repaired Assess answer parses, and repairing or expanding it again changes nothing", () => {
  const hostile = [
    assess(
      [
        cls([0], "h", "h", { F: [0, 3], R: [0, 1] }),
        cls([1]),
        cls([1], "h", "e"),
        cls([7]),
      ],
      ["0n50-60", "zz", "0n12"],
    ),
    {
      ...assess([
        cls([0], "h", "e", {
          F: [0],
          R: [0],
          person: { need: "no", why: "Covered." },
        }),
        cls([1], "l", "h", {
          gaps: [{ axis: "complexity", kind: "own", t: "Unclear." }],
        }),
      ]),
      impact: [
        { s: 9, effect: "narrowed", t: "Gone.", cites: [] },
        { s: 1, effect: "disabled", t: "Off.", cites: ["0o31", "0o99"] },
      ],
      requirements: [
        {
          t: "Empty lists parse.",
          kinds: ["test-run"],
          cites: ["f1", "f9"],
          testable: false,
          untested: "",
          proof: ["p1", "p9"],
          agree: false,
        },
      ],
    },
    // Text past every bound, clipped once and then left alone.
    {
      ...assess([
        cls([0, 1], "h", "e", {
          F: [0],
          person: { need: "yes", why: "w".repeat(120) },
          gaps: [
            { axis: "complexity", kind: "k".repeat(60), t: "g".repeat(90) },
          ],
        }),
      ]),
      factors: [{ f: "connections", t: "f".repeat(130), cites: ["0n12"] }],
    },
  ];
  for (const raw of hostile) {
    const first = assessRepair(raw, index);
    expect(AssessAnswer.safeParse(first.answer).success).toBe(true);
    expect(assessRepair(first.answer, index)).toEqual(first);
    expect(assessExpand(first.answer, index)).toEqual(assessExpand(raw, index));
  }
});

test("an orphan's words land on the first answered section", () => {
  const four = readingIndex({
    files: [{ index: 0, path: "src/a.ts", rows: [] }],
    sections: [0, 1, 2, 3].map((i) => ({
      index: i,
      key: `k${i}`,
      file: 0,
      owned: [
        { side: "new" as const, startLine: 10 * i + 1, endLine: 10 * i + 5 },
      ],
    })),
    facts: [],
    proofs: [],
  });
  const raw = {
    files: [{ f: 0, checked: "Read it.", rows: null }],
    sections: V({ a: [1, 2, 3] }),
    comments: [defect({ s: 9 })],
    unsure: [],
  };
  const expanded = laneReviewExpand(raw, four);
  expect(expanded.map((s) => [s.section, s.judgement.verdict])).toEqual([
    [1, "unsure"],
    [2, "unsure"],
    [3, "unsure"],
  ]);
  expect(expanded.map((s) => s.judgement.unsure)).toEqual([
    [
      "(Written for section 9, which this reading does not list.) Returns null on an empty list.",
    ],
    [],
    [],
  ]);
  expect(laneReviewRepair(raw, four).unanswered).toEqual([0]);
});

// Reason: an impact entry is shown as a one-line summary, which the records refuse without a
// letter or digit; such text must go back to the reading once, and code's repair must drop it.
// Reason (round 2g fix): an impact entry with no words used to cost a turn and then lose its effect;
// now it costs neither, and keeps its effect and cites under code's words.
test("Assess: an impact entry whose text has no letter or digit is counted and kept in code's words for its effect", () => {
  const answer = {
    ...assess([cls([0, 1])]),
    impact: [
      { s: 1, effect: "narrowed", t: "Accepts fewer inputs.", cites: [] },
      { s: 1, effect: "disabled", t: "— —", cites: [] },
      { s: 0, effect: "changed", t: "新しい 2", cites: [] },
    ],
  };
  expect(assessProblems(answer, index)).toEqual([
    // Three entries for two sections: counted, kept, never sent back.
    "The impact table has 3 entries; at most 2. Every one is kept.",
    "Impact entry 1 has no letter or digit, so it is kept in code's words for its effect.",
  ]);
  const found = assessIssues(answer, index);
  expect(found.filter((p) => !REPAIRED_WITHOUT_A_TURN.has(p.class))).toEqual(
    [],
  );
  const repaired = assessRepair(answer, index).answer!;
  expect(repaired.impact).toEqual([
    { s: 1, effect: "narrowed", t: "Accepts fewer inputs.", cites: [] },
    { s: 1, effect: "disabled", t: IMPACT_WORDS.disabled, cites: [] },
    { s: 0, effect: "changed", t: "新しい 2", cites: [] },
  ]);
  // Every wordless form is kept the same way, the empty one included, and repair is stable.
  for (const t of ["", " ", "-", "— —"]) {
    const one = {
      ...assess([cls([0, 1])]),
      impact: [{ s: 1, effect: "narrowed", t, cites: ["0o31"] }],
    };
    expect(AssessAnswer.safeParse(one).success).toBe(true);
    expect(problemCounts(assessIssues(one, index))).toEqual({
      "empty-text": 1,
    });
    const kept = assessRepair(one, index).answer!;
    expect(kept.impact).toEqual([
      { s: 1, effect: "narrowed", t: IMPACT_WORDS.narrowed, cites: ["0o31"] },
    ]);
    expect(assessRepair(kept, index).answer).toEqual(kept);
    expect(problemCounts(assessIssues(kept, index))).toEqual({});
    const judged = assessExpand(one, index).find((j) => j.section === 1)!;
    expect(judged.judgement.impact).toContainEqual({
      effect: "narrowed",
      text: IMPACT_WORDS.narrowed,
      cites: ["src/a.ts:old:31-31"],
    });
  }
});

// Reason (round 2f, second amendment): a size slip must not cost a turn or a group. The caps keep
// an answer short in what the model is told, but text over its bound is clipped for storage and
// counted, and a list over its cap is kept whole and counted, never sent back; dropping a
// requirement nothing proves could let an approval through. Only past a list's sanity ceiling is
// an answer not the schema. The Lane review keeps its comment bound as a reason to withhold that
// comment alone.
test("bounds: over-long text is clipped and counted, an over-cap list is kept whole and counted, neither sent back", () => {
  const sound = assess([cls([0], "l", "e", { F: [0], R: [0] }), cls([1])]);
  expect(AssessAnswer.safeParse(sound).success).toBe(true);
  const factor = sound.factors[0]!;
  const requirement = sound.requirements[0]!;
  const impact = sound.impact[0]!;
  const cases: ReadonlyArray<readonly [unknown, "clipped-text" | "over-cap"]> =
    [
      [
        { ...sound, factors: [{ ...factor, t: "x".repeat(130) }] },
        "clipped-text",
      ],
      [
        { ...sound, requirements: [{ ...requirement, t: "x".repeat(121) }] },
        "clipped-text",
      ],
      [
        {
          ...sound,
          requirements: [{ ...requirement, untested: "u".repeat(81) }],
        },
        "clipped-text",
      ],
      [
        { ...sound, impact: [{ ...impact, t: "x".repeat(101) }] },
        "clipped-text",
      ],
      [
        {
          ...sound,
          classes: [
            cls([0], "h", "e", { person: { need: "no", why: "x".repeat(81) } }),
            cls([1]),
          ],
        },
        "clipped-text",
      ],
      [
        { ...sound, factors: Array.from({ length: 7 }, () => factor) },
        "over-cap",
      ],
      [
        {
          ...sound,
          requirements: Array.from({ length: 9 }, (_, i) => ({
            ...requirement,
            t: `Requirement ${i}.`,
          })),
          classes: [cls([0, 1], "l", "e", { R: [0, 1, 2, 3, 4, 5, 6, 7, 8] })],
        },
        "over-cap",
      ],
      // Impact is capped by the reading's sections (two here), not by a fixed number.
      [{ ...sound, impact: [impact, impact, impact] }, "over-cap"],
      [
        {
          ...sound,
          factors: [{ ...factor, cites: ["0n12", "0n13", "0n14", "0n15"] }],
        },
        "over-cap",
      ],
      [
        {
          ...sound,
          requirements: [
            {
              ...requirement,
              proof: Array.from({ length: 9 }, () => "p1"),
            },
          ],
        },
        "over-cap",
      ],
    ];
  for (const [raw, kind] of cases) {
    expect(AssessAnswer.safeParse(raw).success).toBe(true);
    const issues = assessIssues(raw, index);
    expect(issues.map((p) => p.class)).toContain(kind);
    expect(issues.map((p) => p.class)).not.toContain("not-the-schema");
    for (const p of issues.filter((p) => p.class === kind))
      expect(REPAIRED_WITHOUT_A_TURN.has(p.class)).toBe(true);
    const repaired = assessRepair(raw, index).answer!;
    const parsed = raw as typeof sound;
    // Never a requirement, a factor, a class or a section dropped to fit a cap.
    expect(repaired.factors.length).toBe(parsed.factors.length);
    expect(repaired.requirements.length).toBe(parsed.requirements.length);
    expect(repaired.classes.map((c) => c.S) as unknown).toEqual(
      (parsed.classes as ReadonlyArray<{ readonly S: unknown }>).map(
        (c) => c.S,
      ),
    );
    expect(assessExpand(raw, index).map((s) => s.key)).toEqual(["k0", "k1"]);
  }
  // Clipped to the bound for storage, and nothing else changed.
  const long = assessRepair(cases[0]![0], index).answer!;
  expect(long.factors[0] as unknown).toEqual({
    ...factor,
    t: `${"x".repeat(79)}\u2026`,
    cites: ["0n12-14"],
  });
  // Every requirement past the cap is kept, and each section still names all nine.
  const nine = assessExpand(cases[6]![0], index);
  expect(nine[0]!.judgement.easeOfValidation.requirements.length).toBe(9);
  // Past a list's sanity ceiling the answer is not the schema.
  expect(
    AssessAnswer.safeParse({
      ...sound,
      factors: Array.from({ length: LIST_CEILING + 1 }, () => factor),
    }).success,
  ).toBe(false);
  expect(ANSWER_BOUNDS).toMatchObject({
    factors: 4,
    requirements: 4,
    assessCites: 2,
    proof: 8,
    factorText: 80,
    requirementText: 90,
    impactText: 90,
    untestedText: 80,
    personWhy: 60,
    gapText: 60,
    checkedText: 80,
    cites: 6,
    commentsPerSection: 3,
    commentText: 400,
  });
  // A Lane review: a checked line over 80 is clipped; a comment over 400 is withheld alone.
  const checked = {
    ...review({ a: [1], r: [0] }, [{}]),
    files: [{ f: 0, checked: "c".repeat(90), rows: [] }],
  };
  expect(problemCounts(laneReviewIssues(checked, index))).toEqual({
    "clipped-text": 1,
  });
  expect(laneReviewRepair(checked, index).answer!.files[0]!.checked).toBe(
    `${"c".repeat(79)}\u2026`,
  );
  const atBound = review({ a: [1], r: [0] }, [
    {
      t: "y".repeat(400),
      cites: ["0n12", "0n13", "0n14", "0n15", "0n16", "0n17"],
    },
  ]);
  expect(laneReviewProblems(atBound, index)).toEqual([]);
  const tooLong = review({ a: [1], r: [0] }, [{ t: "y".repeat(401) }]);
  expect(LaneReviewAnswer.safeParse(tooLong).success).toBe(true);
  expect(problemCounts(laneReviewIssues(tooLong, index))).toEqual({
    "long-comment": 2,
  });
  // The request cannot rest on a withheld defect: it is unsure, and the defect's words remain.
  const [withheld] = laneReviewExpand(tooLong, index);
  expect(withheld!.judgement.verdict).toBe("unsure");
  expect(withheld!.judgement.comments).toEqual([]);
  expect(withheld!.judgement.unsure[0]).toMatch(
    /^\(Withheld: too long to show\.\) y+\u2026$/,
  );
  expect(withheld!.judgement.unsure[0]!.length).toBe(200);
});

// Reason (round 2h): the round's smaller caps and bounds must behave as round 2f's did: counted
// (`over-cap`, `clipped-text`), never a turn, nothing dropped; and an answer exactly at every cap and
// bound is counted for nothing.
test("Assess (round 2h): at each new cap and bound nothing is counted; one past it is counted, costs no turn and drops nothing", () => {
  const B = ANSWER_BOUNDS;
  const two = ["0n12", "0n13"];
  const factor = { f: "connections", t: "f".repeat(B.factorText), cites: two };
  const requirement = (i: number) => ({
    t: `${i}`.padEnd(B.requirementText, "r"),
    kinds: ["test-run"],
    cites: two,
    testable: true,
    untested: "",
    proof: [],
    agree: true,
  });
  const at = {
    factors: Array.from({ length: B.factors }, () => factor),
    requirements: Array.from({ length: B.requirements }, (_, i) =>
      requirement(i),
    ),
    impact: [
      {
        s: 1,
        effect: "narrowed",
        t: "i".repeat(B.impactText),
        cites: ["0o31", "0n31"],
      },
    ],
    classes: [
      cls([0], "h", "e", {
        F: [0, 1, 2, 3],
        R: [0, 1, 2, 3],
        person: { need: "no", why: "w".repeat(B.personWhy) },
        gaps: [
          { axis: "complexity", kind: "callers", t: "g".repeat(B.gapText) },
        ],
      }),
      cls([1]),
    ],
  };
  expect([B.factors, B.requirements, B.assessCites]).toEqual([4, 4, 2]);
  expect(problemCounts(assessIssues(at, index))).toEqual({});
  type At = typeof at;
  const past: ReadonlyArray<
    readonly [string, (a: At) => unknown, "over-cap" | "clipped-text"]
  > = [
    [
      "a fifth factor",
      (a) => ({ ...a, factors: [...a.factors, factor] }),
      "over-cap",
    ],
    [
      "a fifth requirement",
      (a) => ({ ...a, requirements: [...a.requirements, requirement(4)] }),
      "over-cap",
    ],
    [
      "a factor's third cite",
      (a) => ({
        ...a,
        factors: [
          { ...factor, cites: [...two, "0n14"] },
          ...a.factors.slice(1),
        ],
      }),
      "over-cap",
    ],
    [
      "a requirement's third cite",
      (a) => ({
        ...a,
        requirements: [
          { ...requirement(0), cites: [...two, "0n14"] },
          ...a.requirements.slice(1),
        ],
      }),
      "over-cap",
    ],
    [
      "an impact entry's third cite",
      (a) => ({
        ...a,
        impact: [{ ...a.impact[0]!, cites: ["0o31", "0n31", "0n32"] }],
      }),
      "over-cap",
    ],
    [
      "a factor's text",
      (a) => ({
        ...a,
        factors: [
          { ...factor, t: "f".repeat(B.factorText + 1) },
          ...a.factors.slice(1),
        ],
      }),
      "clipped-text",
    ],
    [
      "a requirement's text",
      (a) => ({
        ...a,
        requirements: [
          { ...requirement(0), t: "r".repeat(B.requirementText + 1) },
          ...a.requirements.slice(1),
        ],
      }),
      "clipped-text",
    ],
    [
      "an impact entry's text",
      (a) => ({
        ...a,
        impact: [{ ...a.impact[0]!, t: "i".repeat(B.impactText + 1) }],
      }),
      "clipped-text",
    ],
    [
      "a reason",
      (a) => ({
        ...a,
        classes: [
          {
            ...a.classes[0]!,
            person: { need: "no", why: "w".repeat(B.personWhy + 1) },
          },
          a.classes[1]!,
        ],
      }),
      "clipped-text",
    ],
    [
      "a gap's text",
      (a) => ({
        ...a,
        classes: [
          {
            ...a.classes[0]!,
            gaps: [
              {
                axis: "complexity",
                kind: "callers",
                t: "g".repeat(B.gapText + 1),
              },
            ],
          },
          a.classes[1]!,
        ],
      }),
      "clipped-text",
    ],
  ];
  for (const [what, make, kind] of past) {
    const raw = make(at) as At;
    expect({ what, parsed: AssessAnswer.safeParse(raw).success }).toEqual({
      what,
      parsed: true,
    });
    const found = assessIssues(raw, index);
    expect({ what, counts: problemCounts(found) }).toEqual({
      what,
      counts: { [kind]: 1 },
    });
    // No turn: the step's check sends back only what is not repaired without one.
    expect(found.filter((p) => !REPAIRED_WITHOUT_A_TURN.has(p.class))).toEqual(
      [],
    );
    // Nothing dropped: every entry and every resolving cite is kept, text clipped to its bound.
    const repaired = assessRepair(raw, index).answer!;
    expect(repaired.factors.length).toBe(raw.factors.length);
    expect(repaired.requirements.length).toBe(raw.requirements.length);
    expect(repaired.factors[0]!.cites).toEqual(raw.factors[0]!.cites);
    expect(repaired.requirements[0]!.cites).toEqual(raw.requirements[0]!.cites);
    expect(repaired.impact[0]!.cites).toEqual(raw.impact[0]!.cites);
    expect(repaired.factors[0]!.t.length).toBeLessThanOrEqual(B.factorText);
    expect(repaired.requirements[0]!.t.length).toBeLessThanOrEqual(
      B.requirementText,
    );
    expect(repaired.impact[0]!.t.length).toBeLessThanOrEqual(B.impactText);
    expect(repaired.classes[0]!.person!.why.length).toBe(B.personWhy);
    expect(repaired.classes[0]!.gaps![0]!.t.length).toBe(B.gapText);
    expect(assessExpand(raw, index).map((s) => s.key)).toEqual(["k0", "k1"]);
  }
});

// Reason (round 2h): the `added` effect leaves the model's list without breaking what is stored. A
// new answer that gives it is not the schema (as a code-only effect or factor kind was in round
// 2f): the strict submit tool's constrained sampling cannot write it, and on a route without that it
// costs the one send-back any value off the list costs, never a decision. A stored answer of the
// older version that holds one still reads, and expands as it did.
test("Assess (round 2h): an `added` impact entry is not the schema for a new answer; a stored older answer holding one still reads, as it did", () => {
  const added = {
    ...assess([cls([0]), cls([1])]),
    impact: [
      { s: 0, effect: "added", t: "Adds a parser for lists.", cites: ["0n12"] },
    ],
  };
  expect(AssessAnswer.safeParse(added).success).toBe(false);
  const found = assessIssues(added, index);
  expect(found.map((p) => p.class)).toEqual(["not-the-schema"]);
  expect(found[0]!.text).toMatch(/^impact\.0\.effect: /);
  expect(REPAIRED_WITHOUT_A_TURN.has("not-the-schema")).toBe(false);
  expect(assessRepair(added, index)).toEqual({
    answer: null,
    unanswered: [0, 1],
  });
  // Every other effect a new answer may give still reads.
  for (const effect of ["narrowed", "disabled", "changed"])
    expect(
      AssessAnswer.safeParse({
        ...added,
        impact: [{ ...added.impact[0]!, effect }],
      }).success,
    ).toBe(true);
  // Stored by the older version: it reads, and the entry expands as round 2g expanded it.
  expect(StoredAssessAnswer.safeParse(added).success).toBe(true);
  const [first, second] = assessExpand(added, index);
  expect(first!.judgement.impact).toEqual([
    {
      effect: "added",
      text: "Adds a parser for lists.",
      cites: ["src/a.ts:new:12-12"],
    },
  ]);
  // Apart from that entry, the judgement is the one the same answer gives without it.
  expect([
    { ...first!, judgement: { ...first!.judgement, impact: [] } },
    second,
  ]).toEqual([...assessExpand({ ...added, impact: [] }, index)]);
});

// Reason: the probe could not say why its first Assess answer was sent back; each problem must carry
// a class from a closed list, the same words still going to the reading, and counts by class hold
// no cite or text of the answer.
test("each problem has a class from the closed list, and the counts carry no cite or text", () => {
  const bad = {
    ...assess(
      [cls([0], "h", "h", { F: [0, 3], R: [0, 1] }), cls([7, 7])],
      ["0n50-60", "zz"],
    ),
    impact: [{ s: 9, effect: "disabled", t: "— —", cites: [] }],
  };
  bad.requirements[0]!.proof = ["p9"];
  const issues = assessIssues(bad, index);
  expect(issues.map((p) => p.text)).toEqual([...assessProblems(bad, index)]);
  expect(problemCounts(issues)).toEqual({
    "missing-row": 1,
    "unknown-section": 3,
    "index-out-of-range": 2,
    "unknown-cite": 1,
    "unknown-proof": 1,
    "empty-text": 1,
  });
  expect(JSON.stringify(problemCounts(issues))).not.toMatch(/0n50|zz|p9|— —/);

  const reviewIssues = laneReviewIssues(
    review(
      V({ a: [0, 0] }),
      [
        { kind: "question", start: 30, end: 31 },
        { kind: "risk", row: "r9", cites: ["0n12", "nope"] },
        { kind: "impact" },
        { kind: "risk", effect: "removed" },
      ],
      [
        { row: "r1", status: "met", cites: ["p1"] },
        { row: "r2", status: "met", cites: [] },
      ],
    ),
    index,
  );
  expect(problemCounts(reviewIssues)).toEqual({
    "missing-row": 1,
    "duplicate-row": 1,
    "unknown-cite": 1,
    "row-not-given": 2,
    "met-refused": 1,
    "comment-off-lines": 1,
    "impact-without-effect": 1,
    "effect-off-impact": 1,
    "too-many-comments": 1,
  });
  expect(problemCounts(laneReviewIssues({ sections: "fine" }, index))).toEqual({
    "not-the-schema": 4,
  });
  for (const issue of [...issues, ...reviewIssues])
    expect(PROBLEM_CLASSES).toContain(issue.class);
});

// Reason (round 2g): an empty string used to make zod refuse the whole answer, and that refusal was
// counted nowhere. Now it is accepted, counted, and never sent back, and an empty field never helps
// the reading: no empty reason, line, comment or note can turn a refusal into an approval.
test("Assess: an empty cite, text, reason, gap or proof ID is counted, never sent back, and never lowers a section's lane", () => {
  const answer = {
    factors: [{ f: "connections", t: "", cites: ["0n12", ""] }],
    requirements: [
      {
        t: "",
        kinds: ["test-run"],
        cites: [""],
        testable: true,
        untested: "",
        proof: ["", "p1"],
        agree: true,
      },
    ],
    impact: [],
    classes: [
      cls([0], "h", "e", {
        F: [0],
        R: [0],
        person: { need: "no", why: "" },
        gaps: [{ axis: "complexity", kind: "", t: "" }],
      }),
      cls([1]),
    ],
  };
  expect(AssessAnswer.safeParse(answer).success).toBe(true);
  const found = assessIssues(answer, index);
  expect(problemCounts(found)).toEqual({
    "unknown-cite": 3,
    "empty-text": 5,
  });
  // Nothing of it is sent back: each class is one code repairs without a turn.
  expect(found.filter((p) => !REPAIRED_WITHOUT_A_TURN.has(p.class))).toEqual(
    [],
  );
  const [judged] = assessExpand(answer, index);
  // A "no" with no reason is no answer, which counts as yes: a person is suggested, in code's words.
  expect(judged!.judgement.lean).toEqual({
    lane: "human-suggested",
    reason:
      "The reading did not say whether a person is needed, so one is suggested.",
  });
  // The factor keeps its one real cite; the requirement and the gap stay, as they decide.
  expect(judged!.judgement.complexity.factors).toEqual([
    {
      factor: "connections",
      finding: "",
      cites: ["src/a.ts:new:12-12"],
      uncited: false,
    },
  ]);
  expect(judged!.judgement.easeOfValidation.requirements).toMatchObject([
    { requirement: "", cites: [], proof: ["p1"] },
  ]);
  expect(judged!.judgement.gaps).toEqual([
    { axis: "complexity", kind: "", detail: "" },
  ]);
  // Repair is stable on it.
  const repaired = assessRepair(answer, index).answer!;
  expect(assessRepair(repaired, index).answer).toEqual(repaired);
  expect(repaired.classes[0]!.person).toBeNull();

  // An impact entry with no text is accepted too, and kept in code's words (the impact test).
  expect(
    AssessAnswer.safeParse({
      ...answer,
      impact: [{ s: 1, effect: "narrowed", t: "", cites: [] }],
    }).success,
  ).toBe(true);
});

test("Lane review: an empty checked line, comment, note, row ID or cite is counted and never stands an approval", () => {
  // An empty checked line: counted, and the approval still has nothing checked, so it is unsure.
  const unchecked = {
    ...review(V({ a: [0] })),
    files: [{ f: 0, checked: "", rows: null }],
  };
  expect(LaneReviewAnswer.safeParse(unchecked).success).toBe(true);
  expect(problemCounts(laneReviewIssues(unchecked, one))).toEqual({
    "empty-text": 1,
    "nothing-checked": 1,
  });
  expect(verdictOf(unchecked)).toBe("unsure");

  // An empty defect beside an approval: the approval is in breach and becomes unsure; the empty
  // comment is dropped.
  const beside = review(V({ a: [0] }), [{ t: "", cites: [""] }]);
  expect(problemCounts(laneReviewIssues(beside, one))).toEqual({
    "empty-text": 1,
    "unknown-cite": 1,
    "approval-beside-defect": 1,
  });
  const besideJudged = laneReviewExpand(beside, one)[0]!.judgement;
  expect(besideJudged.verdict).toBe("unsure");
  expect(besideJudged.comments).toEqual([]);

  // A request whose only defect is empty rests on none, as one resting only on withheld defects:
  // it is unsure in the first repair, never confirmed, and no turn is spent on it. Repairing the
  // stored answer again changes nothing and counts nothing (N2).
  const request = review(V({ r: [0] }), [{ t: "" }]);
  const requestIssues = laneReviewIssues(request, one);
  expect(
    requestIssues.filter((p) => !REPAIRED_WITHOUT_A_TURN.has(p.class)),
  ).toEqual([]);
  expect(problemCounts(requestIssues)).toEqual({ "empty-text": 2 });
  const requested = laneReviewExpand(request, one)[0]!.judgement;
  expect(requested.verdict).toBe("unsure");
  expect(requested.comments).toEqual([]);
  const once = laneReviewRepair(request, one).answer!;
  const twice = laneReviewRepair(once, one).answer!;
  expect(twice).toEqual(once);
  expect(problemCounts(laneReviewIssues(once, one))).toEqual({});
  expect(laneReviewExpand(once, one)).toEqual(laneReviewExpand(request, one));
  // Beside a real defect the empty one is only dropped: the request rests on the real one.
  const mixed = review(V({ r: [0] }), [{ t: "" }, {}]);
  expect(verdictOf(mixed)).toBe("request-changes");
  const mixedOnce = laneReviewRepair(mixed, one).answer!;
  expect(laneReviewRepair(mixedOnce, one).answer).toEqual(mixedOnce);

  // An empty unsure note is dropped; an empty row ID judges no row, but a not-met one still stops
  // the approval beside it; an empty row on a comment names none.
  const rows = {
    ...review(
      V({ a: [0] }),
      [{ kind: "risk", row: "" }],
      [{ row: "", reading: "", status: "not-met", cites: ["0n12"] }],
    ),
    unsure: [{ s: 0, t: "" }],
  };
  expect(LaneReviewAnswer.safeParse(rows).success).toBe(true);
  expect(problemCounts(laneReviewIssues(rows, one))).toEqual({
    "empty-text": 3,
    "approval-beside-not-met-row": 1,
    "approval-beside-unsure": 1,
  });
  const rowsJudged = laneReviewExpand(rows, one)[0]!.judgement;
  expect(rowsJudged.verdict).toBe("unsure");
  expect(rowsJudged.rows).toEqual([]);
  expect(rowsJudged.unsure).toEqual([]);
  expect(rowsJudged.comments).toMatchObject([{ kind: "risk", row: null }]);
  const repaired = laneReviewRepair(rows, one).answer!;
  expect(laneReviewRepair(repaired, one).answer).toEqual(repaired);
});

// Reason: the round 30 ruling. Each row gives its reading beside its status; a met code refuses
// keeps that reading behind code's words, never as a status, and repair stays idempotent.
test("Lane review: a row's reading is kept and clipped, and a met code refuses keeps it behind code's words", () => {
  const met = review(
    V({ a: [0, 1] }),
    [],
    [
      {
        row: "r1",
        reading: "The parser returns no rows for an empty list (0n12).",
        status: "met",
        cites: ["0n12", "p1"],
      },
    ],
  );
  const once = laneReviewRepair(met, index).answer!;
  expect(once.files[0]!.rows).toEqual([
    {
      row: "r1",
      reading: `${MET_READING}: The parser returns no rows for an empty list (0n12).`,
      status: "no-evidence",
      cites: ["0n12", "p1"],
    },
  ]);
  expect(laneReviewRepair(once, index).answer).toEqual(once);
  // The expanded judgement carries the reading with the row's stable cites.
  expect(laneReviewExpand(met, index)[0]!.judgement.rows).toEqual([
    {
      row: "r1",
      status: "no-evidence",
      cites: ["src/a.ts:new:12-12", "p1"],
      reading: `${MET_READING}: The parser returns no rows for an empty list (0n12).`,
    },
  ]);

  // A long refused met is clipped with code's words kept; its prefix is never given twice.
  const long = review(
    V({ a: [0, 1] }),
    [],
    [
      {
        row: "r1",
        reading: `${MET_READING}: ${"each line splits ".repeat(30)}`,
        status: "met",
        cites: ["p1"],
      },
    ],
  );
  const clipped = laneReviewRepair(long, index).answer!.files[0]!.rows![0]!;
  expect(clipped.reading.length).toBeLessThanOrEqual(ANSWER_BOUNDS.readingText);
  expect(clipped.reading.startsWith(`${MET_READING}: each`)).toBe(true);
  expect(clipped.reading.split(MET_READING)).toHaveLength(2);

  // Any other status keeps its reading as written, clipped past its bound and counted.
  const notMet = review(
    V({ r: [0], a: [1] }),
    [{}],
    [
      {
        row: "r1",
        reading: "x ".repeat(ANSWER_BOUNDS.readingText),
        status: "not-met",
        cites: ["0n12"],
      },
    ],
  );
  expect(problemCounts(laneReviewIssues(notMet, index))).toMatchObject({
    "clipped-text": 1,
  });
  const kept = laneReviewRepair(notMet, index).answer!.files[0]!.rows![0]!;
  expect(kept.status).toBe("not-met");
  expect(kept.reading.length).toBeLessThanOrEqual(ANSWER_BOUNDS.readingText);
  expect(kept.reading.startsWith(MET_READING)).toBe(false);
});

// Reason: the round 30 keys. Answers stored before readings must still read, as they did, with no
// reading; and the Missing state reads how many proof records the reading listed for the file.
test("Lane review: an answer stored before readings reads as it did, and each judgement counts its file's proof records", () => {
  const old = review(
    V({ a: [0, 1] }),
    [],
    [{ row: "r1", status: "no-evidence", cites: [] }],
  );
  expect(StoredLaneReviewAnswer.safeParse(old).success).toBe(true);
  expect(LaneReviewAnswer.safeParse(old).success).toBe(false);
  const [first, second] = laneReviewExpand(old, index);
  expect(first!.judgement.rows).toEqual([
    { row: "r1", status: "no-evidence", cites: [], reading: "" },
  ]);
  expect(first!.judgement.verdict).toBe("approve");
  // p1 is current for src/a.ts: one record listed for the file.
  expect([first!.judgement.fileProofs, second!.judgement.fileProofs]).toEqual([
    1, 1,
  ]);
  // A record listed for another file only is not the file's.
  const elsewhere = readingIndex({
    files: index.files,
    sections: index.sections,
    facts: index.facts,
    proofs: [{ ...index.proofs[0]!, currency: { "src/b.ts": "current" } }],
  });
  expect(laneReviewExpand(old, elsewhere)[0]!.judgement.fileProofs).toBe(0);
});

// Main stored scoped answers before cross-batch claims were part of the answer.
test("Lane review expands a stored scoped answer from main", () => {
  const old = {
    ...review(V({ u: [0], a: [1] }), [{ kind: "risk" }]),
    notAsked: [0],
  };
  expect(laneReviewExpand(old, index)).toEqual([
    expect.objectContaining({
      key: "k0",
      judgement: expect.objectContaining({
        verdict: "unsure",
        notAsked: true,
        comments: [expect.objectContaining({ kind: "risk" })],
      }),
    }),
    expect.objectContaining({
      key: "k1",
      judgement: expect.objectContaining({ verdict: "approve" }),
    }),
  ]);
});
