import { expect, test } from "bun:test";
import {
  ContextSupportError,
  contextSupportAnswerDigest,
  scoreContextSupport,
} from "../src/review-quality/context-support.ts";
import { snapshotDigest } from "../src/review-quality/context-metrics.ts";
import {
  contextDigest,
  decodeContextSnapshot,
  selectContextSlice,
  type ContextCitation,
} from "../src/review-quality/context-slice.ts";

const changedCall = {
  kind: "subject",
  side: "new",
  start: 10,
  end: 10,
} satisfies ContextCitation;
const oldCall = {
  kind: "subject",
  side: "old",
  start: 10,
  end: 10,
} satisfies ContextCitation;
const noise = {
  kind: "context",
  sourceKey: "noise",
  start: 80,
  end: 80,
} satisfies ContextCitation;
const retained = {
  kind: "context",
  sourceKey: "retained",
  start: 400,
  end: 400,
} satisfies ContextCitation;
const known = (acceptable: boolean) => ({
  kind: "known",
  acceptable,
  rationale: "Literal native control, not benchmark gold.",
});
const unknown = {
  kind: "unknown",
  rationale: "Reviewer has not resolved this judgment.",
};
function fixture(missing = false) {
  const text = "fn queue(ptr) { retained.push(ptr); }\n";
  const noiseText = "theme = blue;\n";
  const snapshot = decodeContextSnapshot({
    schemaVersion: 2,
    revisionIdentity: "synthetic-fixture",
    base: "a".repeat(40),
    head: "b".repeat(40),
    changed: [
      {
        ref: { hunkId: "h1", path: "main/source", side: "old", line: 10 },
        text: "queue(item);",
      },
      {
        ref: { hunkId: "h1", path: "main/source", side: "new", line: 10 },
        text: "queue(item.release());",
      },
      {
        ref: { hunkId: "h2", path: "other/source", side: "new", line: 4 },
        text: "type Scope = Read;",
      },
    ],
    subjects: [
      {
        subjectKey: "call",
        path: "main/source",
        hunkId: "h1",
        old: [{ start: 10, end: 10 }],
        new: [{ start: 10, end: 10 }],
        obligations: [
          {
            sourceKey: "retained",
            origin: "Caller annotation awaiting independent necessity review.",
          },
        ],
        contexts: [
          {
            sourceKey: "retained",
            path: "ownership/source",
            range: { start: 400, end: 400 },
            relation: "ownership",
            provenance: {
              kind: "synthetic",
              captureSha256: contextDigest(text),
            },
            trust: "fixture-only",
            evidence: missing
              ? {
                  kind: "missing",
                  detail: "Drop and retained lifetime capture missing.",
                }
              : { kind: "available", text },
          },
          {
            sourceKey: "noise",
            path: "theme/source",
            range: { start: 80, end: 80 },
            relation: "adjacency",
            provenance: {
              kind: "synthetic",
              captureSha256: contextDigest(noiseText),
            },
            trust: "fixture-only",
            evidence: { kind: "available", text: noiseText },
          },
        ],
      },
    ],
  });
  const slice = selectContextSlice(snapshot, "call", "medium");
  if (slice.kind !== "selected") throw Error("Literal control must fit");
  return { snapshot, slice };
}
function identity(f: ReturnType<typeof fixture>, answer: unknown) {
  return {
    schemaVersion: 1,
    subjectKey: "call",
    snapshotSha256: snapshotDigest(f.snapshot),
    logicalRequestSha256: f.slice.logicalRequestSha256,
    answerSha256: contextSupportAnswerDigest(answer),
  };
}
function adjudication(
  f: ReturnType<typeof fixture>,
  answer: { choice: string },
  action: unknown,
  responseJudgment: unknown,
  citations: unknown[],
) {
  return {
    ...identity(f, answer),
    status: "adjudicated",
    action: { choice: answer.choice, judgment: action },
    responseJudgment,
    citations,
    reviewer: {
      identity: "literal-native-review-control",
      evidence: [
        "Literal expectations establish arithmetic only, not independent fixture quality.",
      ],
    },
  };
}
function label(
  citation: ContextCitation,
  scopeRelevance: string,
  chosenActionSupport: string,
) {
  return {
    citation,
    scopeRelevance,
    chosenActionSupport,
    rationale: "Explicit literal semantic expectation.",
  };
}
function scored(
  f: ReturnType<typeof fixture>,
  answer: { choice: string },
  action: unknown,
  response: unknown,
  citations: unknown[],
) {
  const result = scoreContextSupport(
    f.snapshot,
    f.slice,
    answer,
    adjudication(f, answer, action, response, citations),
  );
  if (result.kind !== "scored") throw Error("Expected adjudicated control");
  return result;
}
test("theme citation can pass containment while failing semantic relevance and action support", () => {
  const f = fixture(true);
  const answer = { choice: "inspect", citations: [noise] };
  const result = scored(f, answer, known(true), known(false), [
    label(noise, "irrelevant", "irrelevant"),
  ]);
  expect(result.admission.kind).toBe("admitted");
  expect(result.action.wrongChoice).toBe(false);
  expect(result.response.acceptable).toBe(false);
  expect(result.attribution.scope).toMatchObject({
    irrelevantCited: 1,
    materialCited: 0,
    precisionDenominator: 1,
    precision: 0,
  });
  expect(result.attribution.chosenAction).toMatchObject({
    kind: "scored",
    irrelevantCited: 1,
    precision: 0,
  });
  expect(result.policy.falseRejectionRate).toBeNull();
  expect(result.finalDisposition).toBeNull();
  expect(result.lane).toBeNull();
});
test("changed call can support investigation despite missing Drop without establishing quiet", () => {
  const f = fixture(true);
  const inspect = { choice: "inspect", citations: [changedCall] };
  const investigation = scored(f, inspect, known(true), known(true), [
    label(changedCall, "material", "supporting"),
  ]);
  expect(investigation.admission.kind).toBe("admitted");
  expect(investigation.attribution.scope.precision).toBe(1);
  expect(investigation.attribution.chosenAction).toMatchObject({
    kind: "scored",
    supportingCited: 1,
    precision: 1,
  });
  expect(investigation.coverage).toEqual({
    evaluated: true,
    admitted: true,
    answered: true,
  });
  const quiet = { choice: "no-additional-signal", citations: [changedCall] };
  const rejection = scored(f, quiet, known(false), known(false), [
    label(changedCall, "material", "contrary"),
  ]);
  expect(rejection.admission).toEqual({
    kind: "rejected",
    reason: "required-context-unresolved",
  });
  expect(rejection.action.wrongChoice).toBe(true);
  expect(rejection.policy).toEqual({
    rejected: true,
    adjudicatedRejections: 1,
    falseRejections: 0,
    structurallyExcludedRejections: 0,
    unadjudicatedRejections: 0,
    falseRejectionRate: 0,
  });
});
test("material evidence contrary to the chosen action is relevant without becoming supporting attribution", () => {
  const f = fixture();
  const answer = { choice: "no-additional-signal", citations: [retained] };
  const result = scored(f, answer, known(false), known(false), [
    label(retained, "material", "contrary"),
  ]);
  expect(result.attribution.scope.precision).toBe(1);
  expect(result.attribution.chosenAction).toMatchObject({
    kind: "scored",
    contraryCited: 1,
    supportingCited: 0,
    precision: 0,
  });
  expect(result.action.wrongChoice).toBe(true);
});
test("unknown and unannotated candidates never become correct omissions or zero-error denominators", () => {
  const f = fixture();
  const answer = { choice: "inspect", citations: [retained, changedCall] };
  const result = scored(f, answer, known(true), unknown, [
    label(retained, "unknown", "unknown"),
    label(oldCall, "unknown", "unknown"),
  ]);
  expect(result.attribution.scope).toEqual({
    materialCited: 0,
    irrelevantCited: 0,
    unknownCited: 1,
    unannotatedCited: 1,
    materialOmitted: 0,
    irrelevantOmitted: 0,
    unknownOmitted: 1,
    unannotatedOmitted: 1,
    precisionDenominator: 0,
    precision: null,
    recallDenominator: 0,
    recall: null,
  });
  expect(result.attribution.chosenAction).toMatchObject({
    unknownCited: 1,
    unannotatedCited: 1,
    unknownOmitted: 1,
    unannotatedOmitted: 1,
    precisionDenominator: 0,
    precision: null,
  });
});
test("known material omission affects recall while unknown omissions stay excluded", () => {
  const f = fixture();
  const answer = { choice: "inspect", citations: [changedCall] };
  const result = scored(f, answer, known(true), unknown, [
    label(changedCall, "material", "supporting"),
    label(retained, "material", "supporting"),
    label(noise, "unknown", "unknown"),
  ]);
  expect(result.attribution.scope).toMatchObject({
    materialCited: 1,
    materialOmitted: 1,
    unknownOmitted: 1,
    unannotatedOmitted: 1,
    recallDenominator: 2,
    recall: 0.5,
    precision: 1,
  });
});
test("acceptable action rejected for absent attribution is not a whole-response false rejection", () => {
  const f = fixture(true);
  const answer = { choice: "inspect", citations: [] };
  const result = scored(f, answer, known(true), known(false), []);
  expect(result.action).toEqual({
    acceptable: true,
    wrongChoice: false,
    acceptableActionRejectedByPolicy: true,
  });
  expect(result.policy).toEqual({
    rejected: true,
    adjudicatedRejections: 1,
    falseRejections: 0,
    structurallyExcludedRejections: 0,
    unadjudicatedRejections: 0,
    falseRejectionRate: 0,
  });
  expect(result.coverage).toEqual({
    evaluated: true,
    admitted: false,
    answered: false,
  });
});
test("whole-response false rejection requires its own independent judgment, not a caller gap", () => {
  const f = fixture(true);
  const answer = { choice: "no-additional-signal", citations: [] };
  const rejected = scored(
    f,
    answer,
    known(true),
    {
      kind: "known",
      acceptable: true,
      rationale:
        "Literal counterexample: independent reviewer judges caller's missing-source obligation unnecessary, and complete quiet response acceptable.",
    },
    [],
  );
  expect(rejected.policy).toEqual({
    rejected: true,
    adjudicatedRejections: 1,
    falseRejections: 1,
    structurallyExcludedRejections: 0,
    unadjudicatedRejections: 0,
    falseRejectionRate: 1,
  });
  const unresolved = scored(f, answer, unknown, unknown, []);
  expect(unresolved.action.wrongChoice).toBeNull();
  expect(unresolved.policy).toEqual({
    rejected: true,
    adjudicatedRejections: 0,
    falseRejections: 0,
    structurallyExcludedRejections: 0,
    unadjudicatedRejections: 1,
    falseRejectionRate: null,
  });
});
test("pending case and unknown action support are excluded explicitly rather than awarded accuracy", () => {
  const f = fixture();
  const answer = { choice: "inspect", citations: [changedCall] };
  expect(
    scoreContextSupport(f.snapshot, f.slice, answer, {
      ...identity(f, answer),
      status: "pending-independent-adjudication",
    }),
  ).toEqual({
    kind: "unscored",
    reason: "pending-adjudication",
    pendingCases: 1,
    finalDisposition: null,
    lane: null,
  });
  const result = scored(f, answer, unknown, unknown, [
    label(changedCall, "material", "unknown"),
  ]);
  expect(result.attribution.scope.precision).toBe(1);
  expect(result.attribution.chosenAction).toEqual({
    kind: "unscored",
    reason: "action-judgment-unknown",
    excludedCandidates: 4,
  });
  expect(result.action.wrongChoice).toBeNull();
});
test("labels cannot transfer between snapshots, requests, actions, or cited ranges", () => {
  const f = fixture();
  const answer = { choice: "inspect", citations: [changedCall] };
  const gold = adjudication(f, answer, known(true), known(true), [
    label(changedCall, "material", "supporting"),
  ]);
  for (const field of [
    "snapshotSha256",
    "logicalRequestSha256",
    "answerSha256",
  ]) {
    expect(() =>
      scoreContextSupport(f.snapshot, f.slice, answer, {
        ...gold,
        [field]: "0".repeat(64),
      }),
    ).toThrow(ContextSupportError);
  }
  expect(() =>
    scoreContextSupport(
      f.snapshot,
      f.slice,
      { ...answer, choice: "abstain" },
      gold,
    ),
  ).toThrow(ContextSupportError);
  expect(() =>
    scoreContextSupport(
      f.snapshot,
      f.slice,
      { ...answer, citations: [oldCall] },
      gold,
    ),
  ).toThrow(ContextSupportError);
  expect(() =>
    scoreContextSupport(f.snapshot, f.slice, answer, {
      ...gold,
      action: { choice: "abstain", judgment: known(true) },
    }),
  ).toThrow(ContextSupportError);
  const changed = decodeContextSnapshot({
    ...f.snapshot,
    subjects: f.snapshot.subjects.map((subject) => ({
      ...subject,
      contexts: [],
      obligations: [],
    })),
  });
  expect(() =>
    scoreContextSupport(changed, f.slice, answer, {
      ...gold,
      snapshotSha256: snapshotDigest(changed),
    }),
  ).toThrow(ContextSupportError);
});
test("foreign, duplicated or contradictory semantic labels fail with typed errors", () => {
  const f = fixture();
  const answer = { choice: "inspect", citations: [changedCall] };
  const good = label(changedCall, "material", "supporting");
  for (const labels of [
    [good, good],
    [label({ ...changedCall, start: 9 }, "material", "supporting")],
    [label(changedCall, "irrelevant", "supporting")],
  ]) {
    expect(() => scored(f, answer, known(true), known(true), labels)).toThrow(
      ContextSupportError,
    );
  }
  expect(() =>
    scoreContextSupport(
      f.snapshot,
      f.slice,
      { ...answer, lane: "automated" },
      {},
    ),
  ).toThrow(ContextSupportError);
  expect(() =>
    scoreContextSupport(f.snapshot, f.slice, answer, {
      ...adjudication(f, answer, known(true), known(true), []),
      approved: true,
    }),
  ).toThrow(ContextSupportError);
});
test("duplicate and foreign citations retain structural rejection counts without becoming policy false rejections", () => {
  const f = fixture();
  const answer = {
    choice: "inspect",
    citations: [
      changedCall,
      changedCall,
      { ...retained, start: 500, end: 500 },
    ],
  };
  const result = scored(f, answer, known(true), known(false), [
    label(changedCall, "material", "supporting"),
  ]);
  expect(result.admission).toEqual({
    kind: "rejected",
    reason: "invalid-citation",
  });
  expect(result.attribution).toMatchObject({
    citedCandidateCount: 1,
    invalidCitations: 1,
    duplicateCitations: 1,
  });
  expect(result.policy).toMatchObject({
    rejected: false,
    adjudicatedRejections: 0,
    falseRejections: 0,
    falseRejectionRate: null,
  });
  expect(result.coverage.answered).toBe(false);
});
test("mixed citation failures preserve first admission reason while staying outside policy denominators", () => {
  const f = fixture(true);
  const foreign = { ...noise, start: 81, end: 81 };
  for (const { citations, invalid, duplicates } of [
    { citations: [foreign], invalid: 1, duplicates: 0 },
    { citations: [noise, noise], invalid: 0, duplicates: 1 },
    { citations: [foreign, noise, noise], invalid: 1, duplicates: 1 },
  ]) {
    const answer = { choice: "no-additional-signal", citations };
    for (const response of [known(true), known(false), unknown]) {
      const result = scored(f, answer, known(true), response, []);
      expect(result.admission).toEqual({
        kind: "rejected",
        reason: "required-context-unresolved",
      });
      expect(result.policy).toEqual({
        rejected: true,
        adjudicatedRejections: 0,
        falseRejections: 0,
        structurallyExcludedRejections: 1,
        unadjudicatedRejections: 0,
        falseRejectionRate: null,
      });
      expect(result.attribution.invalidCitations).toBe(invalid);
      expect(result.attribution.duplicateCitations).toBe(duplicates);
      expect(result.coverage).toEqual({
        evaluated: true,
        admitted: false,
        answered: false,
      });
    }
  }
});
test("known unacceptable action contradicts acceptable whole response with typed adjudication failure", () => {
  const f = fixture();
  const answer = { choice: "inspect", citations: [changedCall] };
  try {
    scored(f, answer, known(false), known(true), []);
    throw Error("Contradictory labels must fail");
  } catch (error) {
    expect(error).toBeInstanceOf(ContextSupportError);
    if (!(error instanceof ContextSupportError)) throw error;
    expect(error.reason).toBe("invalid-adjudication");
  }
  const coarse = scored(f, answer, unknown, known(true), [
    label(changedCall, "material", "unknown"),
  ]);
  expect(coarse.response.acceptable).toBe(true);
  expect(coarse.action.wrongChoice).toBeNull();
  expect(coarse.attribution.chosenAction).toEqual({
    kind: "unscored",
    reason: "action-judgment-unknown",
    excludedCandidates: 4,
  });
});
