import * as Data from "effect/Data";
import * as Schema from "effect/Schema";
import {
  admitContextAnswer,
  contextDigest,
  contextTiers,
  selectContextSlice,
  type ContextCitation,
  type ContextSnapshot,
  type ContextTier,
  type FrozenSlice,
} from "./context-slice.ts";
import { snapshotDigest } from "./context-metrics.ts";

const Id = Schema.NonEmptyString;
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const Line = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const Citation = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("subject"),
    side: Schema.Literals(["old", "new"]),
    start: Line,
    end: Line,
  }),
  Schema.Struct({
    kind: Schema.Literal("context"),
    sourceKey: Id,
    start: Line,
    end: Line,
  }),
]);
const Choice = Schema.Literals([
  "inspect",
  "no-additional-signal",
  "abstain",
  "ask-human",
]);
const Answer = Schema.Struct({
  choice: Choice,
  citations: Schema.Array(Citation),
});
const Judgment = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("known"),
    acceptable: Schema.Boolean,
    rationale: Id,
  }),
  Schema.Struct({ kind: Schema.Literal("unknown"), rationale: Id }),
]);
const Identity = {
  schemaVersion: Schema.Literal(1),
  subjectKey: Id,
  snapshotSha256: Digest,
  logicalRequestSha256: Digest,
  answerSha256: Digest,
};
const Adjudication = Schema.Union([
  Schema.Struct({
    ...Identity,
    status: Schema.Literal("pending-independent-adjudication"),
  }),
  Schema.Struct({
    ...Identity,
    status: Schema.Literal("adjudicated"),
    action: Schema.Struct({ choice: Choice, judgment: Judgment }),
    responseJudgment: Judgment,
    citations: Schema.Array(
      Schema.Struct({
        citation: Citation,
        scopeRelevance: Schema.Literals(["material", "irrelevant", "unknown"]),
        chosenActionSupport: Schema.Literals([
          "supporting",
          "contrary",
          "irrelevant",
          "unknown",
        ]),
        rationale: Id,
      }),
    ),
    reviewer: Schema.Struct({
      identity: Id,
      evidence: Schema.NonEmptyArray(Id),
    }),
  }),
]);
export class ContextSupportError extends Data.TaggedError(
  "ContextSupportError",
)<{
  readonly reason: "invalid-answer" | "invalid-adjudication" | "scope-mismatch";
  readonly message: string;
}> {}
function fail(reason: ContextSupportError["reason"], message: string): never {
  throw new ContextSupportError({ reason, message });
}
export function citationSupportIdentity(citation: ContextCitation): string {
  return JSON.stringify(
    citation.kind === "subject"
      ? ["subject", citation.side, citation.start, citation.end]
      : ["context", citation.sourceKey, citation.start, citation.end],
  );
}
function decodeAnswer(raw: unknown) {
  try {
    return Schema.decodeUnknownSync(Answer, { onExcessProperty: "error" })(raw);
  } catch {
    return fail(
      "invalid-answer",
      "Semantic measurements need a well-shaped retained answer.",
    );
  }
}
export function contextSupportAnswerDigest(rawAnswer: unknown): string {
  const answer = decodeAnswer(rawAnswer);
  return contextDigest(
    JSON.stringify([
      answer.choice,
      answer.citations.map(citationSupportIdentity).sort(),
    ]),
  );
}
export function scoreContextSupport(
  snapshot: ContextSnapshot,
  slice: FrozenSlice,
  rawAnswer: unknown,
  rawAdjudication: unknown,
) {
  const answer = decodeAnswer(rawAnswer);
  let gold: typeof Adjudication.Type;
  try {
    gold = Schema.decodeUnknownSync(Adjudication, {
      onExcessProperty: "error",
    })(rawAdjudication);
  } catch {
    return fail(
      "invalid-adjudication",
      "Semantic labels must be separately retained with reviewer evidence.",
    );
  }
  if (
    slice.kind !== "selected" ||
    gold.subjectKey !== slice.subjectKey ||
    gold.snapshotSha256 !== snapshotDigest(snapshot) ||
    gold.logicalRequestSha256 !== slice.logicalRequestSha256 ||
    gold.answerSha256 !== contextSupportAnswerDigest(answer)
  )
    return fail(
      "scope-mismatch",
      "Labels must bind the exact snapshot, request and action/citation answer.",
    );
  const tier = (["tiny", "small", "medium"] satisfies ContextTier[]).find(
    (tier) => contextTiers[tier] === slice.maxLogicalBytes,
  );
  if (
    !tier ||
    JSON.stringify(selectContextSlice(snapshot, slice.subjectKey, tier)) !==
      JSON.stringify(slice)
  )
    return fail(
      "scope-mismatch",
      "Selected evidence must reproduce from the qualified full snapshot.",
    );
  if (gold.status !== "adjudicated")
    return {
      kind: "unscored" as const,
      reason: "pending-adjudication" as const,
      pendingCases: 1,
      finalDisposition: null,
      lane: null,
    };
  if (gold.action.choice !== answer.choice)
    return fail(
      "scope-mismatch",
      "Conditional citation support must qualify this exact chosen action.",
    );
  const candidates = new Set(
    slice.citationCandidates.map(citationSupportIdentity),
  );
  const labels = new Map<string, (typeof gold.citations)[number]>();
  for (const label of gold.citations) {
    const id = citationSupportIdentity(label.citation);
    if (
      !candidates.has(id) ||
      labels.has(id) ||
      ((label.chosenActionSupport === "supporting" ||
        label.chosenActionSupport === "contrary") &&
        label.scopeRelevance !== "material")
    )
      return fail(
        "invalid-adjudication",
        "Citation labels need unique exact candidates and consistent relevance/support.",
      );
    labels.set(id, label);
  }
  const supplied = answer.citations.map(citationSupportIdentity);
  const cited = new Set(supplied.filter((id) => candidates.has(id)));
  const invalidCitations = supplied.filter((id) => !candidates.has(id)).length;
  const duplicateCitations = supplied.length - new Set(supplied).size;
  const scope = {
    materialCited: 0,
    irrelevantCited: 0,
    unknownCited: 0,
    unannotatedCited: 0,
    materialOmitted: 0,
    irrelevantOmitted: 0,
    unknownOmitted: 0,
    unannotatedOmitted: 0,
  };
  const support = {
    supportingCited: 0,
    contraryCited: 0,
    irrelevantCited: 0,
    unknownCited: 0,
    unannotatedCited: 0,
    supportingOmitted: 0,
    contraryOmitted: 0,
    irrelevantOmitted: 0,
    unknownOmitted: 0,
    unannotatedOmitted: 0,
  };
  for (const id of candidates) {
    const suffix = cited.has(id) ? "Cited" : "Omitted";
    const label = labels.get(id);
    scope[`${label?.scopeRelevance ?? "unannotated"}${suffix}`]++;
    support[`${label?.chosenActionSupport ?? "unannotated"}${suffix}`]++;
  }
  const admission = admitContextAnswer(slice, answer);
  const policyRejected =
    admission.kind === "rejected" &&
    admission.reason === "required-context-unresolved";
  const acceptableAction =
    gold.action.judgment.kind === "known"
      ? gold.action.judgment.acceptable
      : null;
  const acceptableResponse =
    gold.responseJudgment.kind === "known"
      ? gold.responseJudgment.acceptable
      : null;
  if (acceptableAction === false && acceptableResponse === true)
    return fail(
      "invalid-adjudication",
      "An acceptable complete response cannot contain a known unacceptable action.",
    );
  const structurallyExcludedRejections =
    policyRejected && (invalidCitations > 0 || duplicateCitations > 0) ? 1 : 0;
  const eligiblePolicyRejection =
    policyRejected && structurallyExcludedRejections === 0;
  const policyRejectionDenominator =
    eligiblePolicyRejection && acceptableResponse !== null ? 1 : 0;
  const falseRejections =
    eligiblePolicyRejection && acceptableResponse === true ? 1 : 0;
  const knownCitedRelevance = scope.materialCited + scope.irrelevantCited;
  const materialCandidates = scope.materialCited + scope.materialOmitted;
  const knownCitedSupport =
    support.supportingCited + support.contraryCited + support.irrelevantCited;
  return {
    kind: "scored" as const,
    pendingCases: 0,
    admission,
    coverage: {
      evaluated: true,
      admitted: admission.kind === "admitted",
      answered:
        admission.kind === "admitted" &&
        answer.choice !== "abstain" &&
        answer.choice !== "ask-human",
    },
    action: {
      acceptable: acceptableAction,
      wrongChoice: acceptableAction === null ? null : !acceptableAction,
      acceptableActionRejectedByPolicy:
        acceptableAction === null ? null : policyRejected && acceptableAction,
    },
    response: { acceptable: acceptableResponse },
    policy: {
      rejected: policyRejected,
      adjudicatedRejections: policyRejectionDenominator,
      falseRejections,
      structurallyExcludedRejections,
      unadjudicatedRejections:
        eligiblePolicyRejection && acceptableResponse === null ? 1 : 0,
      falseRejectionRate:
        policyRejectionDenominator === 0
          ? null
          : falseRejections / policyRejectionDenominator,
    },
    attribution: {
      candidateCount: candidates.size,
      citedCandidateCount: cited.size,
      invalidCitations,
      duplicateCitations,
      scope: {
        ...scope,
        precisionDenominator: knownCitedRelevance,
        precision:
          knownCitedRelevance === 0
            ? null
            : scope.materialCited / knownCitedRelevance,
        recallDenominator: materialCandidates,
        recall:
          materialCandidates === 0
            ? null
            : scope.materialCited / materialCandidates,
      },
      chosenAction:
        acceptableAction === null
          ? {
              kind: "unscored" as const,
              reason: "action-judgment-unknown" as const,
              excludedCandidates: candidates.size,
            }
          : {
              kind: "scored" as const,
              ...support,
              precisionDenominator: knownCitedSupport,
              precision:
                knownCitedSupport === 0
                  ? null
                  : support.supportingCited / knownCitedSupport,
            },
    },
    finalDisposition: null,
    lane: null,
  };
}
