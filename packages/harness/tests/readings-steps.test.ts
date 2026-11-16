// Why: a stored assessment is found again by its key, so the key must hold exactly what the reading
// showed: the same content in another run or range, or under another goal, must find it, and any
// change to what was read must not. And a reading that failed must end as "not judged" for each
// section it did not answer, never as a judgement nobody made.
import { expect, test } from "bun:test";
import { Computations, sha256Hex } from "@neuve/records-core";
import { defaultConfig } from "../src/config.ts";
import { agentStageSpec } from "../src/pipeline.ts";
import {
  erased,
  type AgentResult,
  type AgentStep,
} from "../src/pi/stages/agent.ts";
import { LANE_REVIEW_READING_CHARS } from "../src/pi/stages/reading-task.ts";
import { zeroUsage } from "../src/route.ts";
import {
  ASSESS_ANSWER_VERSION,
  type AssessAnswer,
  type AssessJudgement,
  type LaneReviewAnswer,
} from "../src/readings/answers.ts";
import { decideSection, type ReadingOutcome } from "../src/readings/decide.ts";
import { composeUnits } from "../src/readings/units.ts";
import { planReadings } from "../src/readings/plan.ts";
import { ASSESS_PROMPT_VERSION } from "../src/readings/prompts.ts";
import { renderReading } from "../src/readings/reading.ts";
import {
  AssessStored,
  LaneReviewStored,
  READING_STORED_VERSION,
  assessOutcomes,
  assessStep,
  laneReviewOutcomes,
  laneReviewStep,
  offeredDigest,
  withOffered,
  worstCaseModelCalls,
} from "../src/readings/steps.ts";
import type { BlobStructure } from "../src/sections.ts";
import { PARSE_AFTER, inputFor, mixedRange } from "./fixtures/readings.ts";

const build = (options: Parameters<typeof mixedRange>[0] = {}) => {
  const range = mixedRange(options);
  const plan = planReadings({
    hunks: range.hunks,
    structures: range.structures,
    excluded: range.excluded,
  });
  const hunks = new Map(range.hunks.map((hunk) => [hunk.hunkId, hunk]));
  return { range, plan, hunks, group: plan.groups[0]!.id };
};

const assessOf = (
  built: ReturnType<typeof build>,
  proofs?: Parameters<typeof renderReading>[2]["proofs"],
  facts?: Parameters<typeof renderReading>[2]["facts"],
) =>
  assessStep({
    stage: "verify",
    reading: renderReading(built.plan, built.group, {
      for: "assess",
      hunks: built.hunks,
      structures: built.range.structures,
      proofs,
      facts,
    }),
  });

const reviewOf = (
  built: ReturnType<typeof build>,
  goal: string,
  manifest = "manifest-a",
  rows?: Parameters<typeof renderReading>[2]["rows"],
  listed: Pick<Parameters<typeof renderReading>[2], "proofs" | "facts"> = {},
) =>
  laneReviewStep({
    stage: "verify",
    reading: renderReading(built.plan, built.group, {
      for: "lane-review",
      hunks: built.hunks,
      structures: built.range.structures,
      rows,
      ...listed,
    }),
    goal: { goal, doneWhen: [] },
    tools: [],
    keys: { frame: "frame-a", manifest },
  });

/** The step's computation key, as the route joins it for every step. */
const keyOf = <O, S>(
  step: Pick<AgentStep<O, S>, "spec" | "op" | "opVersion" | "inputs">,
) =>
  Computations.computationKey(agentStageSpec(defaultConfig(), step.spec, step))
    .key;

// Reason: carried assessments rest on this.
test("the Assess key holds only what was read; the Lane review key also holds the goal", () => {
  const base = build();
  const assess = assessOf(base);
  const key = keyOf(assess);
  expect(assess.op).toBe("harness.assess");
  expect(Object.keys(assess.inputs).sort()).toEqual([
    "answer",
    "listed",
    "offered",
    "proofs",
    "recipe",
    "sections",
    "stored",
    "task",
  ]);
  expect(assess.inputs.task).toBe(sha256Hex(assess.spec.task));
  // What it is offered besides the task: an edited system prompt keys apart, whatever its version.
  expect(assess.inputs.offered).toBe(offeredDigest(assess.spec));
  expect(
    keyOf(
      withOffered({
        ...assess,
        spec: { ...assess.spec, system: `${assess.spec.system} Edited.` },
      }),
    ),
  ).not.toBe(key);

  // Not the goal, the range or the run: another build, another goal and another manifest leave it.
  expect(keyOf(assessOf(build()))).toBe(key);
  const review = reviewOf(base, "Let callers count parsed items.");
  expect(keyOf(reviewOf(base, "Let callers count parsed items."))).toBe(
    keyOf(review),
  );
  expect(keyOf(reviewOf(base, "Make parsing stricter."))).not.toBe(
    keyOf(review),
  );
  expect(
    keyOf(reviewOf(base, "Let callers count parsed items.", "manifest-b")),
  ).not.toBe(keyOf(review));

  // A done-when row whose requirement names other kinds of proof: the task text shows only the
  // row's ID and text, so it is unchanged, but code's check of a met row reads the kinds.
  const rowsWith = (kinds: ReadonlyArray<string>) =>
    new Map([
      [
        "src/parse.ts",
        [
          {
            row: "D1",
            text: "Counting returns the number of items.",
            requirements: [
              { requirement: "count returns the length", kinds, proof: [] },
            ],
          },
        ],
      ],
    ]);
  const twoKinds = reviewOf(
    base,
    "Let callers count parsed items.",
    "manifest-a",
    rowsWith(["test-run", "static-analysis"]),
  );
  const threeKinds = reviewOf(
    base,
    "Let callers count parsed items.",
    "manifest-a",
    rowsWith(["test-run", "static-analysis", "log"]),
  );
  expect(threeKinds.spec.task).toBe(twoKinds.spec.task);
  expect(keyOf(threeKinds)).not.toBe(keyOf(twoKinds));

  // A changed row.
  const row = build({ parseAfter: PARSE_AFTER.replace("x + 2", "x + 3") });
  expect(keyOf(assessOf(row))).not.toBe(key);

  // A changed span, with the reading's text unchanged: the section's identity moves the key.
  const span = build({
    edit: (path, structure): BlobStructure =>
      path !== "src/parse.ts"
        ? structure
        : {
            ...structure,
            spans: structure.spans.map((s) =>
              s.name === "helper"
                ? { ...s, textSha256: sha256Hex("another span") }
                : s,
            ),
          },
  });
  const spanned = assessOf(span);
  expect(spanned.spec.task).toBe(assess.spec.task);
  expect(keyOf(spanned)).not.toBe(key);

  // The prompt version and the answer version.
  expect(assess.opVersion).toBe(ASSESS_PROMPT_VERSION);
  expect(keyOf({ ...assess, opVersion: assess.opVersion + 1 })).not.toBe(key);
  expect(assess.inputs.answer).toBe(ASSESS_ANSWER_VERSION);
  expect(
    keyOf({
      ...assess,
      inputs: { ...assess.inputs, answer: ASSESS_ANSWER_VERSION + 1 },
    }),
  ).not.toBe(key);
  // The stored form's version, in both steps' keys: what code stores around the answer.
  expect([assess.inputs.stored, review.inputs.stored]).toEqual([
    READING_STORED_VERSION,
    READING_STORED_VERSION,
  ]);
  expect(
    keyOf({
      ...assess,
      inputs: { ...assess.inputs, stored: READING_STORED_VERSION + 1 },
    }),
  ).not.toBe(key);

  // The proof list: a record for one of the group's files changes it; one for no file of the
  // group is not listed and does not.
  const proof = (path: string) => [
    {
      id: "p1",
      kind: "test-run" as const,
      requirement: "Counting returns the number of items.",
      currency: { [path]: "current" },
    },
  ];
  const proven = assessOf(base, proof("src/parse.ts"));
  expect(proven.inputs.proofs).toEqual(["p1"]);
  expect(keyOf(proven)).not.toBe(key);
  const elsewhere = assessOf(base, proof("src/elsewhere.ts"));
  expect(elsewhere.inputs.proofs).toEqual([]);
  expect(keyOf(elsewhere)).toBe(key);

  // Neither key moves with what the step never reads: a listed record's currency for a file
  // outside the group, or the order facts are given in across sections.
  const goal = "Let callers count parsed items.";
  const outside = [
    {
      ...proof("src/parse.ts")[0]!,
      currency: { "src/parse.ts": "current", "src/elsewhere.ts": "stale" },
    },
  ];
  expect(keyOf(assessOf(base, outside))).toBe(keyOf(proven));
  expect(
    keyOf(reviewOf(base, goal, "manifest-a", undefined, { proofs: outside })),
  ).toBe(
    keyOf(
      reviewOf(base, goal, "manifest-a", undefined, {
        proofs: proof("src/parse.ts"),
      }),
    ),
  );
  const [first, second] = base.plan.groups[0]!.keys;
  const facts = [
    { id: "f1", section: first!, statement: "Changes what helper returns." },
    { id: "f2", section: second!, statement: "Adds the exported count." },
    { id: "f3", section: first!, statement: "Keeps its signature." },
  ];
  const shuffled = [facts[1]!, facts[0]!, facts[2]!];
  expect(keyOf(assessOf(base, undefined, shuffled))).toBe(
    keyOf(assessOf(base, undefined, facts)),
  );
  expect(keyOf(assessOf(base, undefined, facts))).not.toBe(key);
  expect(
    keyOf(reviewOf(base, goal, "manifest-a", undefined, { facts: shuffled })),
  ).toBe(keyOf(reviewOf(base, goal, "manifest-a", undefined, { facts })));
});

const result = <O>(
  status: AgentResult<O>["status"],
  output?: O,
): AgentResult<O> => ({
  agent: "assess.test",
  stage: "verify",
  status,
  output,
  endedBy: "submit",
  turnsUsed: 1,
  turnLimit: 1,
  finalGeneration: status === "final-generation",
  usage: zeroUsage,
  costUsd: null,
  resumedTurns: 0,
  restarted: false,
  modelCalls: status === "backstop" ? 0 : 1,
});

// Reason: a failed reading must end as "not judged", never as an approval.
test("a backstop leaves every section not judged, and an answer missing one section leaves exactly that one", () => {
  const base = build();
  const assess = assessOf(base);
  const review = reviewOf(base, "Let callers count parsed items.");
  const sections = assess.spec.task.match(/^Section \d+/gm)!.length;
  expect(sections).toBeGreaterThan(2);
  const keys = (assess.inputs.sections as ReadonlyArray<string>).slice();

  // The backstop, through the erased step the one agent task runs.
  const backstop = AssessStored.parse(
    erased(assess).compose(result("backstop")),
  );
  expect(backstop.source).toBe("backstop");
  expect(backstop.unanswered).toEqual(keys);
  expect(backstop.characters).toBe(0);
  expect(
    assessOutcomes(backstop, base.plan).map(({ outcome }) => outcome),
  ).toEqual(keys.map(() => ({ judged: false, cause: "failed" })));
  const reviewBackstop = LaneReviewStored.parse(
    erased(review).compose(result("backstop")),
  );
  expect(
    laneReviewOutcomes(reviewBackstop, base.plan).every(
      ({ outcome }) => !outcome.judged,
    ),
  ).toBe(true);

  // Section 2 has no row: checks say so, code's repair stands, and only section 2 is not judged.
  const numbers = Array.from({ length: sections }, (_, at) => at + 1);
  const answer: AssessAnswer = {
    factors: [],
    requirements: [],
    impact: [],
    classes: [
      {
        S: numbers.filter((s) => s !== 2),
        c: "l",
        v: "e",
        F: [],
        R: [],
        person: null,
        gaps: null,
      },
    ],
  };
  // No default: the section no class lists is sent back, never judged with the shared class.
  expect(assess.spec.check!(answer)).toContain(
    "Section 2 is in no class; list every section in exactly one class.",
  );
  const repaired = assess.spec.repair!(answer);
  expect(assess.spec.checkRepaired!(repaired)).toEqual([]);
  const stored = AssessStored.parse(
    assess.compose({ ...result("submitted", repaired), repairedFrom: answer }),
  );
  expect(stored.source).toBe("agent");
  expect(stored.unanswered).toEqual([keys[1]!]);
  expect(stored.characters).toBe(JSON.stringify(answer).length);
  const outcomes = assessOutcomes(stored, base.plan);
  expect(outcomes.map(({ key }) => key)).toEqual(keys);
  expect(outcomes[1]!.outcome).toEqual({ judged: false, cause: "failed" });
  for (const [at, { outcome }] of outcomes.entries())
    if (at !== 1) {
      expect(outcome.judged).toBe(true);
      if (outcome.judged)
        expect(outcome.judgement.complexity.level).toBe("low");
    }

  // A sound review: every file says what was checked, so each approval can stand.
  const fileNumbers = review.spec.task
    .match(/^File \d+$/gm)!
    .map((line) => Number(line.slice("File ".length)));
  expect(fileNumbers.length).toBeGreaterThan(1);
  const reviewAnswer: LaneReviewAnswer = {
    files: fileNumbers.map((f) => ({
      f,
      checked: "Read the changed rows and their callers.",
      rows: null,
    })),
    sections: { a: numbers.filter((s) => s !== 2), r: [], u: [] },
    comments: [],
    unsure: [],
  };
  const reviewed = LaneReviewStored.parse(
    review.compose(result("final-generation", reviewAnswer)),
  );
  expect(reviewed.source).toBe("final-generation");
  expect(reviewed.unanswered).toEqual([keys[1]!]);
  const verdicts = laneReviewOutcomes(reviewed, base.plan).map(({ outcome }) =>
    outcome.judged ? outcome.judgement.verdict : outcome.cause,
  );
  expect(verdicts).toEqual(
    numbers.map((s) => (s === 2 ? "failed" : "approve")),
  );
});

// Reason: an Assess answer sent back with no turn left went to the structured final answer, which
// the first probe run lost to a refused request; the extra turn lets the corrected answer come again
// through the submit tool. Its cost must be known: the turn limits and retries are in the step's key
// (as every step's are), and the worst case of model calls follows from them.
test("Assess has two turns and Lane review three, one retry each, in their keys; the worst case is four and five calls", () => {
  const base = build();
  const assess = assessOf(base);
  const review = reviewOf(base, "Let callers count parsed items.");
  expect([assess.spec.turnLimit, assess.spec.retries]).toEqual([2, 1]);
  expect([review.spec.turnLimit, review.spec.retries]).toEqual([3, 1]);
  // Every turn (a sent-back answer, then a turn with no submission), then the final answer and one
  // refused final answer asked again: turnLimit + retries + 1.
  expect(worstCaseModelCalls(assess.spec)).toBe(4);
  expect(worstCaseModelCalls(review.spec)).toBe(5);
  // In each step's key, as every step's turn limit and retries are; another turn limit is another key.
  const keyed = [
    [
      assess.spec,
      agentStageSpec(defaultConfig(), assess.spec, assess),
      keyOf(assess),
      keyOf({ ...assess, spec: { ...assess.spec, turnLimit: 1 } }),
    ],
    [
      review.spec,
      agentStageSpec(defaultConfig(), review.spec, review),
      keyOf(review),
      keyOf({ ...review, spec: { ...review.spec, turnLimit: 1 } }),
    ],
  ] as const;
  for (const [spec, computation, key, other] of keyed) {
    expect(computation.config).toMatchObject({
      turnLimit: spec.turnLimit,
      retries: 1,
    });
    expect(key).not.toBe(other);
  }
});

// Reason: the probe could not say why an answer was sent back. The step's stored output keeps the
// counts per class of what its checks found in the first answer, in the answer the reading gave
// last and in the answer as code repaired it; no cite and no text of the answer.
test("a sent-back answer's problem classes are stored as counts, with no cite or text", () => {
  const base = build();
  const assess = assessOf(base);
  const numbers = assess.spec.task
    .match(/^Section \d+/gm)!
    .map((line) => Number(line.slice("Section ".length)));
  const cls = (S: ReadonlyArray<number>) => ({
    S: [...S],
    c: "l" as const,
    v: "e" as const,
    F: [],
    R: [],
    person: null,
    gaps: null,
  });
  // The first answer: a class listing a section the reading does not list, one section left out,
  // a factor citing lines no section owns.
  const first: AssessAnswer = {
    factors: [
      { f: "connections", t: "FIRST-TEXT-MARK two callers.", cites: ["9n99"] },
    ],
    requirements: [],
    impact: [],
    classes: [cls([...numbers.slice(1), 99])],
  };
  const sentBack = assess.spec.check!(first);
  expect(sentBack.length).toBeGreaterThan(0);
  // The corrected answer passes and is accepted.
  const corrected: AssessAnswer = {
    factors: [],
    requirements: [],
    impact: [],
    classes: [cls(numbers)],
  };
  expect(assess.spec.check!(corrected)).toEqual([]);
  // An unknown cite alone is dropped and counted, never sent back (round 2f): it costs no turn.
  expect(
    assess.spec.check!({
      ...corrected,
      factors: [{ f: "connections", t: "Two callers.", cites: ["9n99"] }],
    }),
  ).toEqual([]);
  const stored = AssessStored.parse(
    erased(assess).compose(result("submitted", corrected)),
  );
  expect(stored.problems).toEqual({
    first: { "missing-row": 1, "unknown-section": 1, "unknown-cite": 1 },
    given: {},
    repaired: {},
  });
  const written = JSON.stringify(stored.problems);
  expect(written).not.toContain("9n99");
  expect(written).not.toContain("FIRST-TEXT-MARK");

  // The backstop stands only on an answer outside the schema; nothing was judged by the checks.
  const fresh = assessOf(base);
  expect(
    AssessStored.parse(erased(fresh).compose(result("backstop"))).problems,
  ).toEqual({
    first: null,
    given: { "not-the-schema": 1 },
    repaired: { "missing-row": numbers.length },
  });

  // A Lane review repaired by code: what the last answer broke, and what the repair left.
  const review = reviewOf(base, "Let callers count parsed items.");
  const approved: LaneReviewAnswer = {
    files: [],
    sections: { a: numbers, r: [], u: [] },
    comments: [],
    unsure: [],
  };
  const repaired = review.spec.repair!(approved);
  const reviewed = LaneReviewStored.parse(
    erased(review).compose({
      ...result("submitted", repaired),
      repairedFrom: approved,
    }),
  );
  expect(reviewed.problems).toEqual({
    first: null,
    given: { "nothing-checked": numbers.length },
    repaired: {},
  });
});

// Reason (round 2h): the `added` effect leaves the model's list without breaking what is stored. A
// stored Assess value of the older version whose answer gives an impact entry `added` still reads
// and is judged, and the entry decides nothing: the floors read only a removal, disabling or
// narrowing, so the lane, verdict and unit are the ones the same judgement has without it.
test("a stored Assess value of the older version with an `added` impact entry still reads, and the entry changes no decision", () => {
  const base = build();
  const assess = assessOf(base);
  const count = assess.spec.task.match(/^Section \d+/gm)!.length;
  const numbers = Array.from({ length: count }, (_, at) => at + 1);
  const answer: AssessAnswer = {
    factors: [],
    requirements: [],
    impact: [],
    classes: [
      { S: numbers, c: "l", v: "e", F: [], R: [], person: null, gaps: null },
    ],
  };
  const fresh = AssessStored.parse(assess.compose(result("submitted", answer)));
  const older = {
    ...fresh,
    answer: {
      ...fresh.answer,
      impact: [
        {
          s: 1,
          effect: "added",
          t: "Adds a count of parsed items.",
          cites: [],
        },
      ],
    },
  };
  // The submit tool holds a new answer to the schema without it.
  expect(assess.spec.submit.schema.safeParse(older.answer).success).toBe(false);
  const stored = AssessStored.parse(older);
  const [withAdded] = assessOutcomes(stored, base.plan);
  const [without] = assessOutcomes(fresh, base.plan);
  if (!withAdded!.outcome.judged || !without!.outcome.judged)
    throw new Error("expected both judged");
  expect(withAdded!.outcome.judgement.impact[0]).toEqual({
    effect: "added",
    text: "Adds a count of parsed items.",
    cites: [],
  });
  expect({
    ...withAdded!.outcome.judgement,
    impact: withAdded!.outcome.judgement.impact.filter(
      (entry) => entry.effect !== "added",
    ),
  } as unknown).toEqual(without!.outcome.judgement);
  for (const removal of [false, true])
    for (const verdict of ["approve", "request-changes"] as const) {
      const decide = (outcome: ReadingOutcome<AssessJudgement>) =>
        decideSection({
          ...inputFor({ removal }),
          assess: outcome,
          review: { judged: true, judgement: { verdict } },
          claims:
            verdict === "request-changes"
              ? [{ id: "claim-0", source: "lane-review", verify: "confirmed" }]
              : [],
        });
      const a = decide(withAdded!.outcome);
      const b = decide(without!.outcome);
      if (!a.settled || !b.settled) throw new Error("expected settled");
      expect(a.entry.lane).toEqual(b.entry.lane);
      expect([a.verdict, a.restsOn]).toEqual([b.verdict, b.restsOn]);
      expect(composeUnits([{ path: "a.ts", order: 0, decision: a }])).toEqual(
        composeUnits([{ path: "a.ts", order: 0, decision: b }]),
      );
    }
});

// Reason (readers round 14): the reading budget its tools are given decides how much text a Lane
// review is shown, so it is in the step's key: a changed budget is a new step, never a stored
// answer read under another budget.
test("the Lane review key holds its reading budget", () => {
  const built = build();
  const step = (readingChars?: number) =>
    laneReviewStep({
      stage: "verify",
      reading: renderReading(built.plan, built.group, {
        for: "lane-review",
        hunks: built.hunks,
        structures: built.range.structures,
      }),
      goal: { goal: "Count only filled items.", doneWhen: [] },
      tools: [],
      readingChars,
      keys: { frame: "frame-a", manifest: "manifest-a" },
    });
  const at = step(LANE_REVIEW_READING_CHARS);
  expect(at.inputs).toMatchObject({ readingChars: LANE_REVIEW_READING_CHARS });
  expect(keyOf(step(LANE_REVIEW_READING_CHARS + 1))).not.toBe(keyOf(at));
  expect(keyOf(step(LANE_REVIEW_READING_CHARS))).toBe(keyOf(at));
});
