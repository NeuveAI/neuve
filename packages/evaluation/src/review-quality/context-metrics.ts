import * as Schema from "effect/Schema";
import * as Data from "effect/Data";
import {
  admitContextAnswer,
  contextDigest,
  type ContextSnapshot,
  type FrozenSlice,
} from "./context-slice.ts";

const Id = Schema.NonEmptyString;
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const Choice = Schema.Literals([
  "inspect",
  "no-additional-signal",
  "abstain",
  "ask-human",
]);
const SelectionGold = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("pending-independent-adjudication"),
    subjectKey: Id,
    snapshotSha256: Digest,
  }),
  Schema.Struct({
    status: Schema.Literal("adjudicated"),
    subjectKey: Id,
    snapshotSha256: Digest,
    necessarySources: Schema.Array(Id),
    relevantSources: Schema.Array(Id),
    reviewerEvidence: Schema.NonEmptyArray(Id),
  }),
]);
const ClassificationGold = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("pending-independent-adjudication"),
    subjectKey: Id,
    logicalRequestSha256: Digest,
  }),
  Schema.Struct({
    status: Schema.Literal("adjudicated"),
    subjectKey: Id,
    logicalRequestSha256: Digest,
    acceptedChoices: Schema.NonEmptyArray(Choice),
    investigationRequired: Schema.Boolean,
    reviewerEvidence: Schema.NonEmptyArray(Id),
  }),
]);
export class ContextMetricError extends Data.TaggedError("ContextMetricError")<{
  readonly reason: "invalid-gold" | "pending-gold" | "scope-mismatch";
  readonly message: string;
}> {}
export const snapshotDigest = (snapshot: ContextSnapshot) =>
  contextDigest(JSON.stringify(snapshot));
export function scoreContextSelection(
  snapshot: ContextSnapshot,
  slice: FrozenSlice,
  rawGold: unknown,
) {
  let gold: typeof SelectionGold.Type;
  try {
    gold = Schema.decodeUnknownSync(SelectionGold, {
      onExcessProperty: "error",
    })(rawGold);
  } catch {
    throw new ContextMetricError({
      reason: "invalid-gold",
      message: "Invalid separate selection adjudication.",
    });
  }
  if (
    gold.subjectKey !== slice.subjectKey ||
    gold.snapshotSha256 !== snapshotDigest(snapshot)
  )
    throw new ContextMetricError({
      reason: "scope-mismatch",
      message: "Selection label does not qualify this complete candidate pool.",
    });
  if (gold.status !== "adjudicated")
    throw new ContextMetricError({
      reason: "pending-gold",
      message:
        "Selection quality needs independent source-necessity adjudication.",
    });
  const necessary = new Set(gold.necessarySources);
  const relevant = new Set(gold.relevantSources);
  if (
    necessary.size !== gold.necessarySources.length ||
    relevant.size !== gold.relevantSources.length ||
    [...necessary].some((key) => !relevant.has(key))
  )
    throw new ContextMetricError({
      reason: "invalid-gold",
      message: "Necessary/relevant source sets are inconsistent.",
    });
  const selected = new Set(slice.selected.map((source) => source.sourceKey));
  const subject = snapshot.subjects.find(
    (subject) => subject.subjectKey === slice.subjectKey,
  );
  if (!subject)
    throw new ContextMetricError({
      reason: "scope-mismatch",
      message: "No corresponding source candidate pool.",
    });
  const pool = new Map(
    subject.contexts.map((source) => [source.sourceKey, source]),
  );
  const retrievalMisses = [...necessary].filter((key) => !pool.has(key));
  const unavailableNecessarySources = [...necessary].flatMap((key) => {
    const source = pool.get(key);
    return source && source.evidence.kind !== "available"
      ? [{ sourceKey: key, status: source.evidence.kind }]
      : [];
  });
  const selectableNecessary = [...necessary].filter(
    (key) => pool.get(key)?.evidence.kind === "available",
  );
  const selectorOmissions = selectableNecessary.filter(
    (key) => !selected.has(key),
  );
  const selectedNecessary = [...necessary].filter((key) => selected.has(key));
  return {
    necessarySourceCount: necessary.size,
    necessarySourcesSelected: selectedNecessary.length,
    candidatePoolNecessaryCount: necessary.size - retrievalMisses.length,
    candidatePoolRecall:
      necessary.size === 0
        ? null
        : (necessary.size - retrievalMisses.length) / necessary.size,
    retrievalMisses,
    unavailableNecessarySources,
    selectableNecessaryCount: selectableNecessary.length,
    selectorOmissions,
    selectorRecall:
      selectableNecessary.length === 0
        ? null
        : (selectableNecessary.length - selectorOmissions.length) /
          selectableNecessary.length,
    endToEndNecessarySourceCoverage:
      necessary.size === 0 ? null : selectedNecessary.length / necessary.size,
    unrelatedSourcesSelected: [...selected].filter((key) => !relevant.has(key)),
    logicalBytes: slice.logicalBytes,
    maxLogicalBytes: slice.maxLogicalBytes,
    capturedByteFidelity:
      "schema-validated range/text/hash; committed Git blob fidelity not independently verified",
  };
}
export function scoreContextClassification(
  slice: FrozenSlice,
  rawAnswer: unknown,
  rawGold: unknown,
) {
  let gold: typeof ClassificationGold.Type;
  try {
    gold = Schema.decodeUnknownSync(ClassificationGold, {
      onExcessProperty: "error",
    })(rawGold);
  } catch {
    throw new ContextMetricError({
      reason: "invalid-gold",
      message: "Invalid separate classification adjudication.",
    });
  }
  if (
    slice.kind === "blocked" ||
    gold.subjectKey !== slice.subjectKey ||
    gold.logicalRequestSha256 !== slice.logicalRequestSha256
  )
    throw new ContextMetricError({
      reason: "scope-mismatch",
      message:
        "Classification labels must qualify identical selected request bytes.",
    });
  if (gold.status !== "adjudicated")
    throw new ContextMetricError({
      reason: "pending-gold",
      message: "Classifier quality needs independently adjudicated choices.",
    });
  const admitted = admitContextAnswer(slice, rawAnswer);
  if (admitted.kind === "rejected")
    return {
      admission: "rejected" as const,
      reason: admitted.reason,
      answered: false,
      unsafeFalseNegative: false,
      wrongChoice: null,
      finalDisposition: null,
    };
  const choice = admitted.answer.choice;
  const answered = choice !== "abstain" && choice !== "ask-human";
  return {
    admission: "admitted" as const,
    answered,
    choice,
    unsafeFalseNegative:
      gold.investigationRequired && choice === "no-additional-signal",
    wrongChoice: !gold.acceptedChoices.includes(choice),
    finalDisposition: null,
  };
}
