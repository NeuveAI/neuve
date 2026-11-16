// Why (round 2f): the readings now write each distinct judgement once, as a class (Assess) or a list
// of sections by verdict (Lane review), and code writes the plan's own facts (size, declared kind,
// removal) into the stored judgement. The encoding must not change any decision, a section left out
// must never be judged by default, a stray number must judge nothing, the answer's rows part must
// stay small, and moving evidence from the model to code must not let a level through with none.
import { expect, test } from "bun:test";
import { recordedLane } from "../src/lane-rule.ts";
import {
  ANSWER_BOUNDS,
  AssessAnswer,
  LaneReviewAnswer,
  assessExpand,
  assessIssues,
  laneReviewExpand,
  laneReviewIssues,
  problemCounts,
  readingIndex,
  type AssessJudgement,
} from "../src/readings/answers.ts";
import { REMOVED_TEXT } from "../src/readings/code-facts.ts";
import { decideSection } from "../src/readings/decide.ts";
import { planReadings } from "../src/readings/plan.ts";
import { renderReading } from "../src/readings/reading.ts";
import {
  AssessStored,
  LaneReviewStored,
  assessOutcomes,
  assessStep,
  laneReviewOutcomes,
  laneReviewStep,
} from "../src/readings/steps.ts";
import type { AgentResult } from "../src/pi/stages/agent.ts";
import { zeroUsage } from "../src/route.ts";
import {
  FOUR_SECTIONS,
  ROW_FORM_ASSESS,
  ROW_FORM_EXPANDED,
  ROW_FORM_REVIEW,
  SHARED_TABLES,
  inputFor,
  judgementFor,
  mixedRange,
} from "./fixtures/readings.ts";

const four = readingIndex(
  FOUR_SECTIONS as unknown as Parameters<typeof readingIndex>[0],
);

/**
 * The class form of a row-form Assess answer: rows with the same judgement become one class, in
 * the order each judgement first appears. Test-local, so the conversion is not the code under test.
 */
const toClasses = (rows: ReadonlyArray<Record<string, unknown>>) => {
  const classes: Array<Record<string, unknown> & { S: Array<number> }> = [];
  for (const { s, ...judgement } of rows) {
    const same = classes.find(
      ({ S: _S, ...held }) =>
        JSON.stringify(held) === JSON.stringify(judgement),
    );
    if (same === undefined) classes.push({ S: [s as number], ...judgement });
    else same.S.push(s as number);
  }
  return classes;
};

/** The verdict lists of a row-form Lane review answer. */
const toLists = (
  rows: ReadonlyArray<{ readonly s: number; readonly v: string }>,
) => ({
  a: rows.filter((r) => r.v === "a").map((r) => r.s),
  r: rows.filter((r) => r.v === "r").map((r) => r.s),
  u: rows.filter((r) => r.v === "u").map((r) => r.s),
});

const decisionOf = (
  judgement: AssessJudgement,
  verdict: "approve" | "request-changes" | "unsure",
) =>
  decideSection({
    ...inputFor({}),
    assess: { judged: true, judgement },
    review: { judged: true, judgement: { verdict } },
  });

// Reason: the encoding must not change any decision.
test("equivalence: the class form expands to exactly what round 2e's code made of the row form, and decides the same", () => {
  const classForm = {
    ...SHARED_TABLES,
    classes: toClasses(ROW_FORM_ASSESS.sections),
  };
  // Sections 0 and 2 share the first class; the other two differ.
  expect(classForm.classes.map((c) => c.S)).toEqual([[0, 2], [1], [3]]);
  expect(assessIssues(classForm, four)).toEqual([]);
  const assessed = assessExpand(classForm, four);
  // Round 2e's judgements, with the one field this round adds: code's factors, none here (the
  // index has no plan facts).
  const golden = ROW_FORM_EXPANDED.assess.map((entry) => ({
    ...entry,
    judgement: {
      ...entry.judgement,
      codeFactors: [],
    } as unknown as AssessJudgement,
  }));
  expect(assessed as unknown).toEqual(golden);

  const listForm = {
    ...ROW_FORM_REVIEW,
    sections: toLists(ROW_FORM_REVIEW.sections),
  };
  expect(listForm.sections).toEqual({ a: [1, 2], r: [0], u: [3] });
  expect(laneReviewIssues(listForm, four)).toEqual([]);
  const reviewed = laneReviewExpand(listForm, four);
  // Round 2e's judgements, with the fields the readers' round 30 adds: each row's reading, empty for
  // an answer that gave none, and the number of proof records the reading listed for the file.
  const goldenReview = ROW_FORM_EXPANDED.review.map((entry) => ({
    ...entry,
    judgement: {
      ...entry.judgement,
      rows: entry.judgement.rows.map((row) => ({ ...row, reading: "" })),
      fileProofs: four.proofs.filter(
        (proof) => proof.currency["src/a.ts"] !== undefined,
      ).length,
    },
  }));
  expect(reviewed as unknown).toEqual(goldenReview);

  // The stored entry, lane and verdict from each section's judgement are the same either way.
  for (const [at, entry] of assessed.entries()) {
    const verdict = reviewed[at]!.judgement.verdict;
    expect(decisionOf(entry.judgement, verdict)).toEqual(
      decisionOf(golden[at]!.judgement, verdict),
    );
  }
});

const build = () => {
  const range = mixedRange();
  const plan = planReadings({
    hunks: range.hunks,
    structures: range.structures,
    excluded: range.excluded,
  });
  const hunks = new Map(range.hunks.map((hunk) => [hunk.hunkId, hunk]));
  const group = plan.groups[0]!.id;
  const sources = { hunks, structures: range.structures };
  const assessReading = renderReading(plan, group, {
    for: "assess",
    ...sources,
  });
  const reviewReading = renderReading(plan, group, {
    for: "lane-review",
    ...sources,
  });
  const assess = assessStep({ stage: "verify", reading: assessReading });
  const review = laneReviewStep({
    stage: "verify",
    reading: reviewReading,
    goal: { goal: "Let callers count parsed items.", doneWhen: [] },
    tools: [],
    keys: { frame: "frame-a", manifest: "manifest-a" },
  });
  const numbers = assessReading.index.sections.map((s) => s.index);
  const files = reviewReading.index.files.map((f) => f.index);
  return {
    plan,
    assess,
    review,
    numbers,
    files,
    keys: [...assessReading.sectionKeys],
    assessIndex: assessReading.index,
    reviewIndex: reviewReading.index,
  };
};

const result = <O>(output: O): AgentResult<O> => ({
  agent: "reading.test",
  stage: "verify",
  status: "submitted",
  output,
  endedBy: "submit",
  turnsUsed: 1,
  turnLimit: 2,
  finalGeneration: false,
  usage: zeroUsage,
  costUsd: null,
  resumedTurns: 0,
  restarted: false,
  modelCalls: 1,
});

const cls = (S: ReadonlyArray<number>, c: "l" | "h" = "l") => ({
  S: [...S],
  c,
  v: "e" as const,
  F: [],
  R: [],
  person: null,
  gaps: null,
});

const reviewOf = (
  files: ReadonlyArray<number>,
  sections: { a: Array<number>; r: Array<number>; u: Array<number> },
) => ({
  files: files.map((f) => ({
    f,
    checked: "Read the rows and callers.",
    rows: null,
  })),
  sections,
  comments: [],
  unsure: [],
});

// Reason: an omitted section must never be approved by omission.
test("a section in no class, and one in two, are reported, sent back, and then not judged: never judged by default", () => {
  const { plan, assess, review, numbers, files, keys } = build();
  expect(numbers.length).toBeGreaterThan(3);
  // The first class is the default most sections share; section 2 is in none, section 3 in two.
  const answer = {
    factors: [],
    requirements: [],
    impact: [],
    classes: [cls(numbers.filter((s) => s !== 2)), cls([3], "h")],
  };
  expect(assess.spec.check!(answer)).toEqual([
    "Section 2 is in no class; list every section in exactly one class.",
    "Section 3 is listed 2 times; list it once, in exactly one class.",
  ]);
  // After the one resend, code's repair stands: both are unanswered, never given the default.
  const stored = AssessStored.parse(
    assess.compose({
      ...result(assess.spec.repair!(answer)),
      repairedFrom: answer,
    }),
  );
  expect(stored.problems.first).toEqual({
    "missing-row": 1,
    "duplicate-row": 1,
  });
  expect(stored.unanswered).toEqual([keys[1]!, keys[2]!]);
  const outcomes = assessOutcomes(stored, plan);
  expect(outcomes.map(({ outcome }) => outcome.judged)).toEqual(
    numbers.map((s) => s !== 2 && s !== 3),
  );
  expect(outcomes[1]!.outcome).toEqual({ judged: false, cause: "failed" });
  expect(outcomes[2]!.outcome).toEqual({ judged: false, cause: "failed" });

  // The Lane review: section 2 under no verdict, section 3 under two.
  const reviewAnswer = reviewOf(files, {
    a: numbers.filter((s) => s !== 2),
    r: [],
    u: [3],
  });
  expect(review.spec.check!(reviewAnswer)).toEqual([
    "Section 2 has no verdict; list it once, under a, r or u.",
    "Section 3 is listed 2 times; list it once, under one of a, r or u.",
  ]);
  const reviewed = LaneReviewStored.parse(
    review.compose({
      ...result(review.spec.repair!(reviewAnswer)),
      repairedFrom: reviewAnswer,
    }),
  );
  expect(reviewed.unanswered).toEqual([keys[1]!, keys[2]!]);
  expect(
    laneReviewOutcomes(reviewed, plan).map(({ outcome }) =>
      outcome.judged ? outcome.judgement.verdict : outcome.cause,
    ),
  ).toEqual(numbers.map((s) => (s === 2 || s === 3 ? "failed" : "approve")));
});

// Reason: a stray index must not land a judgement on another section.
test("an index that is not a section of the reading is reported and judges nothing", () => {
  const { plan, assess, review, numbers, files, assessIndex, reviewIndex } =
    build();
  const clean = {
    factors: [],
    requirements: [],
    impact: [],
    classes: [cls(numbers), cls([], "h")],
  };
  // A stray 99 in a class of its own and in the shared one, and a stray 0 (sections count from 1).
  const stray = {
    ...clean,
    classes: [cls([...numbers, 99]), cls([0, 99], "h")],
  };
  expect(
    assessIssues(stray, assessIndex).map((p) => [p.class, p.text]),
  ).toEqual([
    [
      "unknown-section",
      "Class 0 lists section 99, which this reading does not list.",
    ],
    [
      "unknown-section",
      "Class 1 lists section 0, which this reading does not list.",
    ],
    [
      "unknown-section",
      "Class 1 lists section 99, which this reading does not list.",
    ],
  ]);
  // Every listed section has the judgement of the class that lists it, and only those sections.
  expect(assessExpand(stray, assessIndex)).toEqual(
    assessExpand(clean, assessIndex),
  );
  expect(
    assessExpand(stray, assessIndex).every(
      (s) => s.judgement.complexity.level === "low",
    ),
  ).toBe(true);
  const stored = AssessStored.parse(
    assess.compose({
      ...result(assess.spec.repair!(stray)),
      repairedFrom: stray,
    }),
  );
  expect(stored.unanswered).toEqual([]);
  expect(assessOutcomes(stored, plan).every((o) => o.outcome.judged)).toBe(
    true,
  );

  const reviewClean = reviewOf(files, { a: numbers, r: [], u: [] });
  const reviewStray = reviewOf(files, { a: numbers, r: [99], u: [0] });
  expect(problemCounts(laneReviewIssues(reviewStray, reviewIndex))).toEqual({
    "unknown-section": 2,
  });
  expect(laneReviewExpand(reviewStray, reviewIndex)).toEqual(
    laneReviewExpand(reviewClean, reviewIndex),
  );
  expect(review.spec.check!(reviewStray).length).toBe(2);
});

// Reason: the round exists to cut this number; a later change must not grow it unnoticed.
test("size: for a 27-section reading in two classes, the rows part stays under its derived bound", () => {
  const numbers = Array.from({ length: 27 }, (_, at) => at + 1);
  const odd = [5, 17];
  // Measured as the strict answer schema reads it, inside a whole answer: a required key added to a
  // class grows the measured figure, and a value the schema refuses fails here.
  const classes = AssessAnswer.parse({
    ...SHARED_TABLES,
    classes: [
      { ...cls(numbers.filter((s) => !odd.includes(s))), F: [0], R: [0] },
      { ...cls(odd, "h"), v: "h", F: [0, 1], R: [0, 1] },
    ],
  }).classes;
  // The bound, derived: each class's skeleton {"S":[],"c":"l","v":"e","F":[],"R":[],"person":null,
  // "gaps":null} is 64 characters, two of them 128; at most two positions each in F and R, a digit
  // and a comma each, 8 a class, 16 in all; 27 section numbers, 9 of one digit and 18 of two, 45
  // digits and 25 commas, 70; the outer brackets and the comma between classes, 3. 217 characters,
  // about 54 tokens at four characters a token: 2.0 tokens per section, reasoning not counted.
  const BOUND = 217;
  const skeleton = JSON.stringify({
    S: [],
    c: "l",
    v: "e",
    F: [],
    R: [],
    person: null,
    gaps: null,
  });
  expect(skeleton.length).toBe(64);
  const written = JSON.stringify(classes).length;
  expect(written).toBeLessThanOrEqual(BOUND);
  expect(BOUND / 4 / numbers.length).toBeLessThan(2.1);
  // The same judgements in round 2e's row form, for comparison: about 16.7 tokens per section.
  const rows = numbers.map((s) => {
    const { S: _S, ...judgement } = odd.includes(s) ? classes[1]! : classes[0]!;
    return { s, ...judgement };
  });
  expect(JSON.stringify(rows).length).toBe(1809);
  expect(written * 8).toBeLessThan(JSON.stringify(rows).length);

  // The Lane review's lists: {"a":[],"r":[],"u":[]} is 22 characters, then 45 digits and at most 25
  // commas: 92 characters, 23 tokens, 0.85 tokens per section.
  const listsOf = (sections: unknown) =>
    LaneReviewAnswer.parse({
      files: [],
      sections,
      comments: [],
      unsure: [],
    }).sections;
  const lists = listsOf({
    a: numbers.filter((s) => !odd.includes(s)),
    r: [5],
    u: [17],
  });
  expect(JSON.stringify(lists).length).toBeLessThanOrEqual(92);
  expect(
    JSON.stringify(
      listsOf({ a: numbers.filter((s) => s !== 5), r: [5], u: [] }),
    ).length,
  ).toBeLessThanOrEqual(92);
});

// Reason (round 2h): the round exists to cut the whole Assess answer, not only its classes (probe run
// 3: about 5,230 characters a reading, 44% of it one `added` impact line per section, and tables
// filled to their caps); a later change must not grow it unnoticed.
test("size: a typical whole Assess answer for a 27-section reading, its texts at their bounds, stays under its derived bound", () => {
  const numbers = Array.from({ length: 27 }, (_, at) => at + 1);
  const odd = [5, 17];
  // Cites as long as a reading of 16 files with four-digit lines gives them, two an item (the cap).
  const cites = ["12n1200-1240", "12n1300-1340"];
  const text = (bound: number) => "x".repeat(bound);
  const B = ANSWER_BOUNDS;
  // Parsed through the strict answer schema: a required key added anywhere grows the figure, and a
  // value the schema refuses fails here.
  const answer = AssessAnswer.parse({
    factors: [
      { f: "dependency-position", t: text(B.factorText), cites },
      { f: "architectural-role", t: text(B.factorText), cites },
    ],
    requirements: Array.from({ length: 3 }, () => ({
      t: text(B.requirementText),
      kinds: ["test-run", "static-analysis"],
      cites,
      testable: true,
      untested: "",
      proof: [],
      agree: true,
    })),
    impact: [{ s: 17, effect: "narrowed", t: text(B.impactText), cites }],
    classes: [
      { ...cls(numbers.filter((s) => !odd.includes(s))), F: [0], R: [0, 1] },
      {
        ...cls(odd, "h"),
        v: "h",
        F: [0, 1],
        R: [0, 1, 2],
        gaps: [
          {
            axis: "ease-of-validation",
            kind: text(B.gapKind),
            t: text(B.gapText),
          },
        ],
      },
    ],
  });
  // The bound, derived, in characters of the compact JSON:
  // - two cites: 2 x (12 + 2 quotes) + 1 comma = 29;
  // - a factor: {"f":"","t":"","cites":[]} is 26, + a kind of at most 19 + 80 + 29 = 154; two in
  //   brackets with a comma, 311;
  // - a requirement: {"t":"","kinds":[],"cites":[],"testable":true,"untested":"","proof":[],
  //   "agree":true} is 84, + 90 + two kinds (28) + 29 = 231; three, 697;
  // - the impact entry: {"s":17,"effect":"narrowed","t":"","cites":[]} is 46, + 90 + 29 = 165; in
  //   brackets, 167;
  // - the classes: the shared one 64 (its skeleton) + 25 section numbers (42 digits, 24 commas) +
  //   F's 1 + R's 3 = 134; the other 64 - 4 (null) + the gap in brackets (2 + 46 + 40 + 60) + S's 4
  //   + F's 3 + R's 5 = 220; in brackets with a comma, 357;
  // - the answer: {"factors":[],"requirements":[],"impact":[],"classes":[]} is 57, less the 8
  //   characters of its empty brackets, + 311 + 697 + 167 + 357 = 1,581.
  // 1,581 characters is about 395 tokens at four characters a token: 14.6 tokens per section,
  // reasoning not counted (probe run 3: about 60 a section).
  const BOUND = 1581;
  const written = JSON.stringify(answer).length;
  expect(written).toBeLessThanOrEqual(BOUND);
  // The derivation is not slack: the answer measured is within a character of it.
  expect(BOUND - written).toBeLessThanOrEqual(1);
  expect(BOUND / 4 / numbers.length).toBeLessThan(14.7);
  // Nothing in it is over a cap or a bound, and every cite resolves: it is a typical answer, read
  // whole, not a clipped one.
  const index = readingIndex({
    files: Array.from({ length: 16 }, (_, at) => ({
      index: at + 1,
      path: `src/f${at + 1}.ts`,
      rows: [],
    })),
    sections: numbers.map((s) => ({
      index: s,
      key: `k${s}`,
      file: 12,
      owned: [{ side: "new" as const, startLine: 1200, endLine: 1400 }],
    })),
    facts: [],
    proofs: [],
  });
  expect(problemCounts(assessIssues(answer, index))).toEqual({});
});

// Reason: a fact written for every section must not turn the "cited evidence" rule into a
// constant, and moving facts from the model to code must not let a level through with no evidence.
test("code's factors are stored beside the model's with their fact cites, and never count as evidence for a level", () => {
  const { plan, assess, numbers, assessIndex } = build();
  const sectionOf = (path: string, name: string) => {
    const section = plan.sections.find(
      (s) => s.path === path && s.name === name,
    )!;
    return assessIndex.sections.find((s) => s.key === section.key)!;
  };
  const drop = sectionOf("src/old.ts", "drop");
  const helper = sectionOf("src/parse.ts", "helper");
  const answer = {
    factors: [],
    requirements: [],
    impact: [],
    classes: [cls(numbers)],
  };
  const stored = AssessStored.parse(assess.compose(result(answer)));
  // The stored answer holds only what the model wrote: code's factors are not in it.
  expect(JSON.stringify(stored.answer)).not.toContain(".size");
  const outcome = (key: string) =>
    assessOutcomes(stored, plan).find((o) => o.key === key)!.outcome;
  const dropped = outcome(drop.key);
  if (!dropped.judged) throw new Error("drop was not judged");
  // In their own field, with their plan-fact cites; the factors the lane rule reads hold only the
  // model's (none here).
  expect(dropped.judgement.codeFactors).toEqual([
    {
      factor: "size",
      finding: "0 lines added and 3 lines removed.",
      cites: [`${drop.key}.size`],
    },
    {
      factor: "removal",
      finding: "It removes a declaration that only the base has.",
      cites: [`${drop.key}.declaration`, `${drop.key}.old-side-only`],
    },
  ]);
  expect(dropped.judgement.complexity.factors).toEqual([]);
  expect(dropped.judgement.impact).toEqual([
    {
      effect: "removed",
      text: REMOVED_TEXT,
      cites: [`${drop.key}.declaration`, `${drop.key}.old-side-only`],
    },
  ]);
  const helped = outcome(helper.key);
  if (!helped.judged) throw new Error("helper was not judged");
  expect(helped.judgement.codeFactors.map((f) => f.factor)).toEqual(["size"]);
  expect(helped.judgement.impact).toEqual([]);

  // The evidence rule: a section judged high and hard with a gap stays human-required only when
  // cited evidence places it there; otherwise the gap lowers it to human-suggested, as in round 2e.
  const base = judgementFor("human-required");
  const highHard = (
    factors: AssessJudgement["complexity"]["factors"],
    codeFactors: AssessJudgement["codeFactors"],
  ): AssessJudgement => ({
    ...base,
    complexity: { level: "high", factors },
    codeFactors,
    gaps: [{ axis: "complexity", kind: "callers", detail: "Not shown." }],
  });
  const laneWith = (judgement: AssessJudgement) => {
    const decided = decisionOf(judgement, "approve");
    if (!decided.settled) throw new Error("not settled");
    return {
      lane: decided.entry.lane.applied,
      note: recordedLane(decided.entry, inputFor({}).section.added).note,
    };
  };
  // Model factors uncited or absent: lowered, whatever code's factors say.
  const bare = readingIndex({
    files: [{ index: 1, path: "src/a.ts", rows: [] }],
    sections: [
      {
        index: 1,
        key: "k1",
        file: 1,
        owned: [{ side: "new", startLine: 1, endLine: 2 }],
      },
    ],
    facts: [],
    proofs: [],
  });
  const [uncited] = assessExpand(
    {
      factors: [{ f: "connections", t: "Two callers.", cites: ["9n99"] }],
      requirements: [],
      impact: [],
      classes: [{ ...cls([1], "h"), v: "h", F: [0] }],
    },
    bare,
  );
  expect(uncited!.judgement.complexity.factors).toEqual([
    {
      factor: "connections",
      finding: "Two callers.",
      cites: [],
      uncited: true,
    },
  ]);
  for (const factors of [uncited!.judgement.complexity.factors, []])
    for (const codeFactors of [[], dropped.judgement.codeFactors]) {
      const lowered = laneWith(highHard(factors, codeFactors));
      expect(lowered.lane).toBe("human-suggested");
      expect(lowered.note).not.toContain("cited evidence");
    }
  // The model wrote a cited size factor, as the reason the class is high: it stays human-required.
  const [sized] = assessExpand(
    {
      factors: [
        { f: "size", t: "Rewrites the whole parser.", cites: ["1n1-2"] },
      ],
      requirements: [],
      impact: [],
      classes: [{ ...cls([1], "h"), v: "h", F: [0] }],
    },
    bare,
  );
  expect(sized!.judgement.complexity.factors).toEqual([
    {
      factor: "size",
      finding: "Rewrites the whole parser.",
      cites: ["src/a.ts:new:1-2"],
      uncited: false,
    },
  ]);
  const held = laneWith(highHard(sized!.judgement.complexity.factors, []));
  expect(held.lane).toBe("human-required");
  expect(held.note).toContain("cited evidence places it high and hard");
});
