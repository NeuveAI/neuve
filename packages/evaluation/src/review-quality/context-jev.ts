import * as Schema from "effect/Schema";
import {
  ContextSliceError,
  admitContextAnswer,
  contextDigest,
  contextTask,
  contextAttributionTask,
  citationQuestion,
  type FrozenSlice,
} from "./context-slice.ts";

type ChoiceQuestion = {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
};
export function compileFiniteJevContext(
  slice: FrozenSlice,
  optionOrder: "forward" | "reverse" = "forward",
) {
  if (slice.kind === "blocked")
    throw new ContextSliceError({
      reason: "budget",
      message: "Blocked context cannot become a provider request.",
    });
  const candidates = slice.citationCandidates;
  const ordered = (criteria: Record<string, string>) =>
    Object.fromEntries(
      optionOrder === "reverse"
        ? Object.entries(criteria).reverse()
        : Object.entries(criteria),
    );
  const questions: Record<string, ChoiceQuestion> = {
    action: {
      type: "choice",
      instructions: contextTask.instructions,
      criteria: ordered(contextTask.choices),
    },
  };
  const citations = candidates.map((citation, index) => ({
    questionKey: `citation_${index}`,
    citation,
  }));
  for (const { questionKey, citation } of citations)
    questions[questionKey] = {
      type: "choice",
      instructions: citationQuestion(citation),
      criteria: ordered(contextAttributionTask.choices),
    };
  // Facts stay in state. Frozen task/candidate semantics stay in questions, never duplicated as state instructions.
  const state = slice.factualState;
  const body = { model: "jev-1.13.0", state, questions };
  const wireRequest = JSON.stringify(body);
  return {
    body,
    wireRequest,
    wireSha256: contextDigest(wireRequest),
    logicalRequestSha256: slice.logicalRequestSha256,
    factualStateSha256: slice.factualStateSha256,
    taskContractSha256: slice.taskContractSha256,
    factualBytes: slice.factualBytes,
    questionsBytes: new TextEncoder().encode(JSON.stringify(questions))
      .byteLength,
    wireBytes: new TextEncoder().encode(wireRequest).byteLength,
    questionCount: Object.keys(questions).length,
    primaryQuestion: "action",
    citationQuestions: citations,
    optionOrder,
  };
}
const Answers = Schema.Record(
  Schema.String,
  Schema.Struct({
    type: Schema.Literal("choice"),
    choice: Schema.NonEmptyString,
  }),
);
export function normalizeFiniteJevAnswers(
  slice: FrozenSlice,
  rawAnswers: unknown,
) {
  const compiled = compileFiniteJevContext(slice);
  let answers: typeof Answers.Type;
  try {
    answers = Schema.decodeUnknownSync(Answers)(rawAnswers);
  } catch {
    throw new ContextSliceError({
      reason: "output",
      message:
        "Jev answers must be finite choices, not generated citation JSON or explanations.",
    });
  }
  if (
    Object.keys(answers).length !== compiled.questionCount ||
    Object.entries(compiled.body.questions).some(
      ([key, question]) =>
        !Object.hasOwn(question.criteria, answers[key]?.choice ?? ""),
    )
  )
    throw new ContextSliceError({
      reason: "output",
      message: "Missing, foreign or invalid Jev choice answer.",
    });
  const action = answers.action;
  if (!action)
    throw new ContextSliceError({
      reason: "output",
      message: "Primary Jev choice missing.",
    });
  const citations = compiled.citationQuestions.flatMap(
    ({ questionKey, citation }) =>
      answers[questionKey]?.choice === "cite" ? [citation] : [],
  );
  return admitContextAnswer(slice, { choice: action.choice, citations });
}
const Positive = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0));
const Receipt = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("unavailable"),
    reason: Schema.NonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal("exact"),
    tokenizer: Schema.NonEmptyString,
    wireSha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
    stateAndLongestQuestionTokens: Positive,
    stateAndAllQuestionsTokens: Positive,
  }),
]);
export function admitFiniteJevBudget(
  slice: FrozenSlice,
  wireRequest: string,
  rawReceipt: unknown,
  optionOrder: "forward" | "reverse" = "forward",
) {
  const compiled = compileFiniteJevContext(slice, optionOrder);
  if (wireRequest !== compiled.wireRequest)
    throw new ContextSliceError({
      reason: "budget",
      message:
        "Jev wire request differs from frozen state, question tasks, finite citation candidates or chosen option order.",
    });
  if (compiled.wireBytes > slice.maxLogicalBytes)
    return {
      kind: "blocked" as const,
      reason: "provider-envelope-exceeds-experimental-byte-tier",
    };
  let receipt: typeof Receipt.Type;
  try {
    receipt = Schema.decodeUnknownSync(Receipt, { onExcessProperty: "error" })(
      rawReceipt,
    );
  } catch {
    throw new ContextSliceError({
      reason: "budget",
      message: "Invalid Jev tokenizer qualification.",
    });
  }
  if (receipt.kind === "unavailable")
    return {
      kind: "blocked" as const,
      reason: "exact-Jev-token-count-unavailable",
      wireBytes: compiled.wireBytes,
      questionCount: compiled.questionCount,
    };
  if (
    receipt.wireSha256 !== compiled.wireSha256 ||
    receipt.stateAndAllQuestionsTokens < receipt.stateAndLongestQuestionTokens
  )
    throw new ContextSliceError({
      reason: "budget",
      message: "Jev token counts do not qualify this exact ordered request.",
    });
  if (
    receipt.stateAndLongestQuestionTokens > 32_000 ||
    receipt.stateAndAllQuestionsTokens > 64_000
  )
    return {
      kind: "blocked" as const,
      reason: "Jev-state-question-budget-exceeded",
    };
  return {
    kind: "admitted" as const,
    tokenizer: receipt.tokenizer,
    longestQuestionInputTokens: receipt.stateAndLongestQuestionTokens,
    allQuestionsInputTokens: receipt.stateAndAllQuestionsTokens,
    wireBytes: compiled.wireBytes,
    questionCount: compiled.questionCount,
    wireSha256: compiled.wireSha256,
    logicalRequestSha256: compiled.logicalRequestSha256,
  };
}
