import { canonicalJson, sha256Hex } from "@neuve/records-core";
import { Effect } from "effect";
import { z } from "zod";
import type { AgentStage } from "../budget.ts";
import type { ToolSpec } from "../toolkit.ts";
import type {
  AgentResult,
  AgentStep,
  ToolStateHolder,
} from "../pi/stages/agent.ts";
import { MAX_INVALID_SUBMISSIONS } from "../budget.ts";
import type { AgentSpec } from "../pi/stages/agent.ts";
import { declarationOf, submitShape } from "../pi/stages/tools.ts";
import {
  ASSESS_ANSWER_VERSION,
  ASSESS_TESTED_ANSWER_VERSION,
  AssessAnswer,
  AssessTestedAnswer,
  LANE_REVIEW_ANSWER_VERSION,
  LANE_REVIEW_SCOPED_ANSWER_VERSION,
  LaneReviewAnswer,
  LaneReviewScopedAnswer,
  ProblemCounts,
  REPAIRED_WITHOUT_A_TURN,
  StoredAssessAnswer,
  StoredLaneReviewAnswer,
  assessExpand,
  assessIssues,
  assessRepair,
  groupingOf,
  laneReviewExpand,
  laneReviewIssues,
  laneReviewRepair,
  problemCounts,
  showsTests,
  type AnyAssessAnswer,
  type AnyLaneReviewAnswer,
  type AssessJudgement,
  type LaneReviewJudgement,
  type Problem,
  type ReadingIndex,
} from "./answers.ts";
import type { ReadingOutcome } from "./decide.ts";
import {
  READING_RECIPE,
  READING_RECIPE_SCOPE_AND_TESTS,
  type ReadingPlan,
} from "./plan.ts";
import {
  ASSESS_PROMPT_VERSION,
  ASSESS_SUBMIT,
  ASSESS_TESTED_PROMPT_VERSION,
  LANE_REVIEW_PROMPT_VERSION,
  LANE_REVIEW_SCOPED_PROMPT_VERSION,
  LANE_REVIEW_SUBMIT,
  assessSystem,
  assessTask,
  assessTestedSystem,
  laneReviewScopedSystem,
  laneReviewSystem,
  laneReviewTask,
  type LaneReviewGoal,
} from "./prompts.ts";
import { ReadingListed, readingIndexOf, type Reading } from "./reading.ts";

/**
 * The two readings as agent steps, one per reading group, built the way `verifyStep` is: a spec,
 * a key (op, opVersion and content inputs, which `agentStageSpec` joins with the route), and a
 * composition that stores the answer as code repaired it with the sections it left unanswered.
 * A submission with hard problems is answered with them in plain words and sent back once
 * (`retries: 1`); past that, code's repair is taken. A problem code repairs without a turn
 * (`REPAIRED_WITHOUT_A_TURN`: an unknown cite dropped, text clipped, a list over its cap kept whole,
 * a comment over its bound withheld) is counted but never sent back: size is never a reason to
 * spend a turn.
 *
 * Assess has two turns. Lane review has four, with lookup tools on the first two. Both can resend
 * a refused answer through the submit tool. `worstCaseModelCalls` gives the maximum cost.
 *
 * No `partial`: a reading the run's cut-off interrupted stores nothing, so the next generation
 * finds it missing and reads it again.
 */

export const ASSESS_TURNS = 2;
export const LANE_REVIEW_TURNS = 4;
export const READING_RETRIES = 1;

/**
 * The version of what code stores for a reading step around its answer (`AssessStored`,
 * `LaneReviewStored`): one of both steps' key inputs (`stored`), so an output stored under an older
 * meaning is never reused as this one. Before it was an input, the stored form was version 1.
 * 2: `problems.first` counts the answers the schema refused before the checks judged one.
 * 3: it names the review and run that produced it (`by`), so a later review that reuses it records
 * the judgement as carried from them. It lands with the recipe's version 10, so a stored reading
 * misses once for both.
 */
export const READING_STORED_VERSION = 3;

/**
 * The review that produced a stored reading: its run key (what a packet calls its review), the run,
 * the cycle and the head it read. Stored with the output, never part of the key, so a later review
 * whose reading text is the same finds the output and can say whose judgement it carries.
 */
export const ReadingProducer = z.strictObject({
  review: z.string().min(1),
  run: z.string().min(1),
  cycle: z.string().min(1),
  head: z.string().min(1),
});
export type ReadingProducer = z.infer<typeof ReadingProducer>;

/**
 * The most model calls one reading step can make, from how `pi/stages/agent-step.ts` and
 * `pi/stages/tools.ts` (`roundEnds`) treat a sent-back submission, the turn limit and `retries`:
 * - a failed submission is answered with its problems; the tool round ends only once more than
 *   `retries` have failed or the turn limit is reached (`roundEnds`). With more than `retries`
 *   failed, the running phase repairs the last one and stores it: no further call. So the submit
 *   tool takes at most `turnLimit` calls, and at most `retries + 1` answers through it;
 * - when the turns run out first (a turn without a submission: a text reply, a refusal, or the
 *   tool turn), the step asks for its final structured answer (`toFinal`). A final answer that
 *   fails its checks is refused and asked again until more than `retries` were refused
 *   (agent-step.ts, the `final` phase: `refusals > retries`), so up to `retries + 1` final calls.
 * The same `retries` bounds both, so with one retry the worst case is every turn, then two final
 * answers: `turnLimit + retries + 1`. Provider-level retries of one call (pi's transport retries)
 * are not model answers and are not counted; a re-read is a second step with its own budget.
 */
export const worstCaseModelCalls = (
  spec: Pick<AgentSpec<unknown>, "turnLimit" | "retries">,
) => spec.turnLimit + (spec.retries ?? MAX_INVALID_SUBMISSIONS) + 1;

const Source = z.enum(["agent", "final-generation", "backstop"]);

/**
 * What code's checks found, as counts per class of problem only (no cite, no text): of the first
 * answer the reading gave (`not-the-schema` with the number of answers the schema refused before
 * the checks judged one, as the step recorded them; else what the checks found in the first they
 * judged; null when none was judged and the step recorded no answer), of the last
 * answer the reading gave (before code's repair; one `not-the-schema` when it was outside the
 * schema and the backstop stands), and of the answer as code repaired it (what still holds, such
 * as a section left without a row).
 */
export const StoredProblems = z.strictObject({
  first: ProblemCounts.nullable(),
  given: ProblemCounts,
  repaired: ProblemCounts,
});
export type StoredProblems = z.infer<typeof StoredProblems>;

const storedShape = {
  /** The reading group's ID. */
  group: z.string().min(1),
  /** The group's section identity keys, in reading order (section 1 first). */
  sections: z.array(z.string()),
  /** The sections, by identity key, that the answer left unanswered; every one with the backstop. */
  unanswered: z.array(z.string()),
  /** The size in characters of the answer as the reading gave it (before code's repair); 0 for the backstop. */
  characters: z.int().min(0),
  /** The number of classes the answer as given wrote (Assess); null for Lane review and the backstop. */
  classes: z.int().min(0).nullable(),
  /** The sections outside the answer's largest class or verdict list, as given; null for the backstop. */
  outside: z.int().min(0).nullable(),
  source: Source,
  /** What the reading listed beyond the plan, so the index can be built again. */
  listed: ReadingListed,
  problems: StoredProblems,
  /** The review that produced it; absent when the step was built with none (tests). */
  by: ReadingProducer.optional(),
};

export const AssessStored = z.strictObject({
  ...storedShape,
  /**
   * The answer as code repaired it. A new one passed `AssessAnswer`; one an older version stored
   * may give an impact entry `added`, and still reads.
   */
  answer: StoredAssessAnswer,
});
export type AssessStored = z.infer<typeof AssessStored>;

export const LaneReviewStored = z.strictObject({
  ...storedShape,
  /** The answer as code repaired it, of either form (`LaneReviewScopedAnswer` with scope and tests on). */
  answer: StoredLaneReviewAnswer,
});
export type LaneReviewStored = z.infer<typeof LaneReviewStored>;

/**
 * The SHA-256 of everything the reading listed beyond the plan (facts, proof records, done-when
 * rows with their requirements), in canonical JSON. Code's checks read all of it through the index
 * (a row's requirements decide whether it may read met) though the task text shows only part, so
 * each key holds it whole.
 */
const listedDigest = (reading: Reading<"assess" | "lane-review">) =>
  sha256Hex(canonicalJson(reading.listed));

/**
 * The SHA-256 of what an agent step is offered besides its task, as the model is sent it: the
 * system prompt and each tool's declaration (its own tools, then the submit tool, each with its
 * description and parameters), in canonical JSON. The vent tool the agent step adds is the stage's,
 * the same for every step, so it is not here.
 */
export const offeredDigest = <O>(spec: AgentSpec<O>) =>
  sha256Hex(
    canonicalJson({
      system: spec.system,
      tools: [...spec.tools, submitShape(spec)].map((tool) =>
        declarationOf(tool, false),
      ),
    }),
  );

/**
 * The step with what it is offered among its key inputs (`offered`), so an edited system prompt,
 * tool description or answer schema never reuses an answer read under the old one, whatever the
 * prompt and answer versions say.
 */
export const withOffered = <O, S>(step: AgentStep<O, S>): AgentStep<O, S> => ({
  ...step,
  inputs: { ...step.inputs, offered: offeredDigest(step.spec) },
});

const emptyAssess = (): AssessAnswer => ({
  factors: [],
  requirements: [],
  impact: [],
  classes: [],
});

const emptyLaneReview = (): LaneReviewAnswer => ({
  files: [],
  sections: { a: [], r: [], u: [] },
  comments: [],
  unsure: [],
});

/** The backstop of the scoped form (scope and tests on): the empty answer, with no section not asked for. */
const emptyScopedReview = (): LaneReviewScopedAnswer => ({
  ...emptyLaneReview(),
  comments: [],
  notAsked: [],
  crossBatchClaims: [],
});

const sourceOf = (status: AgentResult<unknown>["status"]) =>
  status === "submitted"
    ? ("agent" as const)
    : status === "final-generation"
      ? ("final-generation" as const)
      : ("backstop" as const);

/**
 * Code's checks of one step, which remember the classes of the first answer they judged. The step's
 * agent is prepared once per task in a process and its submit tool judges each answer as it comes,
 * so the first call is the first answer; an answer outside the schema never reaches the checks,
 * and after a restart the first answer judged may be a later one.
 */
const checksOf = (
  issues: (raw: unknown, index: ReadingIndex) => ReadonlyArray<Problem>,
  index: ReadingIndex,
) => {
  let first: ProblemCounts | undefined;
  return {
    check: (answer: unknown) => {
      const found = issues(answer, index);
      first ??= problemCounts(found);
      return found
        .filter((p) => !REPAIRED_WITHOUT_A_TURN.has(p.class))
        .map((p) => p.text);
    },
    first: () => first ?? null,
  };
};

/** The stored value from a context's result, with one repair rule per kind. */
const composeWith =
  <A>(
    kind: "assess" | "lane-review",
    reading: Reading<"assess" | "lane-review">,
    backstop: () => A,
    repair: (
      raw: unknown,
      index: Reading<"assess">["index"],
    ) => {
      readonly answer: A | null;
      readonly unanswered: ReadonlyArray<number>;
    },
    issues: (raw: unknown, index: ReadingIndex) => ReadonlyArray<Problem>,
    first: () => ProblemCounts | null,
    by: ReadingProducer | undefined,
  ) =>
  (result: AgentResult<A>) => {
    const source = sourceOf(result.status);
    const given =
      source === "backstop" || result.output === undefined
        ? undefined
        : (result.repairedFrom ?? result.output);
    const repaired =
      source === "backstop" || result.output === undefined
        ? {
            answer: backstop(),
            unanswered: reading.index.sections.map((s) => s.index),
          }
        : repair(result.output, reading.index);
    // The answers the schema refused before the checks judged one, as the step recorded each answer
    // when it gave it (`AgentResult.submissions`): none of them reached the checks.
    const labels = result.submissions ?? [];
    const judged = labels.findIndex((label) => label !== "schema");
    const refusedFirst = judged === -1 ? labels.length : judged;
    // The backstop stands only where the last answer was outside the schema (agent-step.ts).
    const problems = {
      first: refusedFirst > 0 ? { "not-the-schema": refusedFirst } : first(),
      given:
        given === undefined
          ? { "not-the-schema": 1 }
          : problemCounts(issues(given, reading.index)),
      repaired: problemCounts(
        issues(repaired.answer ?? backstop(), reading.index),
      ),
    };
    const grouping =
      given === undefined ? null : groupingOf(kind, given, reading.index);
    const keyOf = new Map(reading.index.sections.map((s) => [s.index, s.key]));
    const unanswered = new Set(
      repaired.answer === null
        ? reading.index.sections.map((s) => s.index)
        : repaired.unanswered,
    );
    return {
      group: reading.groupId,
      sections: [...reading.sectionKeys],
      unanswered: reading.index.sections
        .filter((s) => unanswered.has(s.index))
        .map((s) => keyOf.get(s.index)!),
      characters: given === undefined ? 0 : JSON.stringify(given).length,
      classes: grouping?.classes ?? null,
      outside: grouping?.outside ?? null,
      source,
      listed: reading.listed,
      problems,
      ...(by === undefined ? {} : { by: { ...by } }),
      answer: repaired.answer ?? backstop(),
    };
  };

/**
 * The Assess step of one reading group. With scope and tests on (`scopeAndTests`), the reading must
 * have been rendered with it too; the step then holds the answer to `AssessTestedAnswer` and runs
 * on its own system prompt, prompt version, recipe and answer version, so it keys apart. Off, the
 * step is exactly as before.
 */
export const assessStep = (p: {
  /** The scheduler's reading stage; `"verify"` until it exists. */
  readonly stage: AgentStage;
  readonly reading: Reading<"assess">;
  /** Scope and tests (`ReadingsConfig.scopeAndTests`): absent or false, the base step. */
  readonly scopeAndTests?: boolean | undefined;
  /** The review this step runs in, stored with its output (`ReadingProducer`). */
  readonly by?: ReadingProducer | undefined;
}): AgentStep<AnyAssessAnswer, AssessStored> => {
  const { reading } = p;
  const tested = p.scopeAndTests === true;
  const task = assessTask(reading);
  const issues = (raw: unknown, index: ReadingIndex) =>
    assessIssues(raw, index, tested);
  const repair = (raw: unknown, index: ReadingIndex) =>
    assessRepair(raw, index, tested);
  const checks = checksOf(issues, reading.index);
  return withOffered({
    spec: {
      stage: p.stage,
      agent: `assess.${reading.groupId}`,
      turnLimit: ASSESS_TURNS,
      retries: READING_RETRIES,
      // A reading the provider could not answer is "not judged", never a held review.
      unanswered: "fail",
      system: tested ? assessTestedSystem : assessSystem,
      task,
      tools: [],
      submit: {
        name: ASSESS_SUBMIT,
        description:
          "Submit the assessment: the factor, requirement and impact tables, and the classes, which together list every numbered section exactly once.",
        schema: (tested
          ? AssessTestedAnswer
          : AssessAnswer) as z.ZodType<AnyAssessAnswer>,
      },
      check: checks.check,
      repair: (answer) => repair(answer, reading.index).answer ?? emptyAssess(),
      // Code's repair stands as it is: a section still without a row is stored as unanswered.
      checkRepaired: () => [],
      backstop: emptyAssess,
    },
    op: "harness.assess",
    opVersion: tested ? ASSESS_TESTED_PROMPT_VERSION : ASSESS_PROMPT_VERSION,
    inputs: {
      sections: [...reading.sectionKeys],
      recipe: tested ? READING_RECIPE_SCOPE_AND_TESTS : READING_RECIPE,
      answer: tested ? ASSESS_TESTED_ANSWER_VERSION : ASSESS_ANSWER_VERSION,
      stored: READING_STORED_VERSION,
      task: sha256Hex(task),
      proofs: [...reading.proofIds].sort(),
      listed: listedDigest(reading),
    },
    compose: composeWith<AnyAssessAnswer>(
      "assess",
      reading,
      emptyAssess,
      repair,
      issues,
      checks.first,
      p.by,
    ),
    schema: AssessStored,
    note: (stored) =>
      `${stored.sections.length - stored.unanswered.length} of ${stored.sections.length} sections answered; source ${stored.source}`,
  });
};

/** The Lane review step of one reading group. */
export const laneReviewStep = (p: {
  /** The scheduler's reading stage; `"verify"` until it exists. */
  readonly stage: AgentStage;
  readonly reading: Reading<"lane-review">;
  readonly goal: LaneReviewGoal;
  /** The tools it may call in its first two turns, supplied by the caller. */
  readonly tools: ReadonlyArray<ToolSpec<unknown>>;
  /** What the tools hold between calls, when they hold anything. */
  readonly state?: ToolStateHolder | undefined;
  /**
   * The reading budget the tools were given, in characters (`LANE_REVIEW_READING_CHARS`): it decides
   * how much text the review is shown, so it is in the key. Given by the caller that gives the tools.
   */
  readonly readingChars?: number | undefined;
  /** The Frame computation's key and the range manifest's key. */
  readonly keys: { readonly frame: string; readonly manifest: string };
  /**
   * Scope and tests (`ReadingsConfig.scopeAndTests`): the reading must have been rendered with it
   * too; the step holds the answer to `LaneReviewScopedAnswer` and runs on its own system prompt,
   * prompt version, recipe and answer version. Absent or false, the step is exactly as before.
   */
  readonly scopeAndTests?: boolean | undefined;
  /** The review this step runs in, stored with its output (`ReadingProducer`). */
  readonly by?: ReadingProducer | undefined;
}): AgentStep<AnyLaneReviewAnswer, LaneReviewStored> => {
  const { reading } = p;
  const scoped = p.scopeAndTests === true;
  const task = laneReviewTask(reading, p.goal);
  const issues = (raw: unknown, index: ReadingIndex) =>
    laneReviewIssues(raw, index, scoped);
  const repair = (raw: unknown, index: ReadingIndex) =>
    laneReviewRepair(raw, index, scoped);
  const backstop = scoped ? emptyScopedReview : emptyLaneReview;
  const checks = checksOf(issues, reading.index);
  let turn = 0;
  const tools = p.tools.map((tool): ToolSpec<unknown> => ({
    ...tool,
    handle: (input) =>
      turn > 2
        ? Effect.succeed({
            text: `The tools were for your first two turns. Answer now by calling ${LANE_REVIEW_SUBMIT}.`,
            error: "ToolsSpent",
          })
        : tool.handle(input),
  }));
  return withOffered({
    spec: {
      stage: p.stage,
      agent: `lane-review.${reading.groupId}`,
      turnLimit: LANE_REVIEW_TURNS,
      retries: READING_RETRIES,
      // A reading the provider could not answer is "not judged", never a held review.
      unanswered: "fail",
      system: scoped ? laneReviewScopedSystem : laneReviewSystem,
      task,
      tools,
      submit: {
        name: LANE_REVIEW_SUBMIT,
        description:
          "Submit the review: what you checked per file, every numbered section listed once under a, r or u, and the comments.",
        schema: (scoped
          ? LaneReviewScopedAnswer
          : LaneReviewAnswer) as z.ZodType<AnyLaneReviewAnswer>,
      },
      check: checks.check,
      repair: (answer) => repair(answer, reading.index).answer ?? backstop(),
      checkRepaired: () => [],
      backstop,
      state: {
        load: (held, at) => {
          turn = at;
          p.state?.load(held, at);
        },
        save: () => p.state?.save() ?? {},
      },
    },
    op: "harness.lane-review",
    opVersion: scoped
      ? LANE_REVIEW_SCOPED_PROMPT_VERSION
      : LANE_REVIEW_PROMPT_VERSION,
    inputs: {
      sections: [...reading.sectionKeys],
      recipe: scoped ? READING_RECIPE_SCOPE_AND_TESTS : READING_RECIPE,
      answer: scoped
        ? LANE_REVIEW_SCOPED_ANSWER_VERSION
        : LANE_REVIEW_ANSWER_VERSION,
      stored: READING_STORED_VERSION,
      frame: `computation:${p.keys.frame}`,
      manifest: `computation:${p.keys.manifest}`,
      task: sha256Hex(task),
      tools: tools.map((tool) => tool.name),
      ...(p.readingChars === undefined ? {} : { readingChars: p.readingChars }),
      listed: listedDigest(reading),
    },
    compose: composeWith<AnyLaneReviewAnswer>(
      "lane-review",
      reading,
      backstop,
      repair,
      issues,
      checks.first,
      p.by,
    ),
    schema: LaneReviewStored,
    note: (stored) =>
      `${stored.sections.length - stored.unanswered.length} of ${stored.sections.length} sections answered; source ${stored.source}`,
  });
};

/** The index a stored output was read against, checked to be the plan's group as it was read. */
const storedIndex = (
  stored: Pick<AssessStored, "group" | "sections" | "listed">,
  plan: ReadingPlan,
) => {
  // A re-read stores only the sections it read: its index is built over those alone.
  const index = readingIndexOf(
    plan,
    stored.group,
    stored.listed,
    stored.sections,
  );
  const keys = index.sections.map((s) => s.key);
  if (
    keys.length !== stored.sections.length ||
    keys.some((key, at) => key !== stored.sections[at])
  )
    throw new Error(
      `The stored reading of group ${stored.group} names other sections than the plan's group`,
    );
  return index;
};

/** One section's outcome, by identity key, in reading order. */
export interface SectionOutcome<J> {
  readonly key: string;
  readonly outcome: ReadingOutcome<J>;
}

const outcomesOf = <J>(
  stored: Pick<AssessStored, "sections" | "unanswered">,
  judged: ReadonlyArray<{ readonly key: string; readonly judgement: J }>,
): ReadonlyArray<SectionOutcome<J>> => {
  const unanswered = new Set(stored.unanswered);
  const byKey = new Map(judged.map((entry) => [entry.key, entry.judgement]));
  return stored.sections.map((key) => {
    const judgement = byKey.get(key);
    return {
      key,
      outcome:
        unanswered.has(key) || judgement === undefined
          ? { judged: false, cause: "failed" }
          : { judged: true, judgement },
    };
  });
};

/** Each section's Assess outcome from a stored step output and the plan: an unanswered section is not judged (`failed`). */
export const assessOutcomes = (
  stored: AssessStored,
  plan: ReadingPlan,
): ReadonlyArray<SectionOutcome<AssessJudgement>> =>
  outcomesOf(stored, assessExpand(stored.answer, storedIndex(stored, plan)));

/** Each section's Lane review outcome from a stored step output and the plan: an unanswered section is not judged (`failed`). */
export const laneReviewOutcomes = (
  stored: LaneReviewStored,
  plan: ReadingPlan,
): ReadonlyArray<SectionOutcome<LaneReviewJudgement>> =>
  outcomesOf(
    stored,
    laneReviewExpand(stored.answer, storedIndex(stored, plan)),
  );

/**
 * Scope and tests' count of one stored Assess reading, numbers only, for its run-log row: null
 * where its reading showed no test row (no section of a file declared test, `showsTests`);
 * otherwise its requirements, the testable ones, and of those the ones whose `testedBy` is empty.
 * A count is all it is: nothing that decides reads `testedBy`.
 */
export const testedByCounts = (
  stored: AssessStored,
  plan: ReadingPlan,
): {
  readonly requirements: number;
  readonly testable: number;
  readonly empty: number;
} | null => {
  if (!showsTests(storedIndex(stored, plan))) return null;
  const requirements = stored.answer.requirements;
  const testable = requirements.filter((r) => r.testable);
  return {
    requirements: requirements.length,
    testable: testable.length,
    empty: testable.filter(
      (r) => r.testedBy !== undefined && r.testedBy.length === 0,
    ).length,
  };
};

/**
 * Scope and tests' count of one stored Lane review reading, a number only: the sections it listed
 * as not asked for (the repaired `notAsked`, each also under `u`); 0 for an answer of the base form.
 */
export const notAskedCount = (stored: LaneReviewStored): number =>
  stored.answer.notAsked?.length ?? 0;

/**
 * Scope and tests: the identity keys of the sections one stored Lane review reading listed as not
 * asked for, in the reading's order. Each number maps to its key through the reading's index, built
 * again from the plan and the stored sections (`storedIndex`), as `laneReviewOutcomes` maps the
 * verdict lists' numbers: a re-read's numbers are among its own sections. Keys only; empty for an
 * answer of the base form.
 */
export const notAskedKeys = (
  stored: LaneReviewStored,
  plan: ReadingPlan,
): Array<string> => {
  const listed = new Set(stored.answer.notAsked ?? []);
  if (listed.size === 0) return [];
  return storedIndex(stored, plan)
    .sections.filter((section) => listed.has(section.index))
    .map((section) => section.key);
};
