import { resolve } from "node:path";

import type { SourceAssertion } from "./external-validation-case.ts";

export type PresenceExpectations = Readonly<{
  present: readonly string[];
  absent: readonly string[];
}>;

export type PresenceEvaluation = Readonly<{
  passed: boolean;
  missingExpectedPresent: readonly string[];
  unexpectedlyPresent: readonly string[];
}>;

export const evaluatePresence = (
  expectations: PresenceExpectations,
  observedPresent: ReadonlySet<string>,
): PresenceEvaluation => {
  const missingExpectedPresent = expectations.present.filter(
    (id) => !observedPresent.has(id),
  );
  const unexpectedlyPresent = expectations.absent.filter((id) =>
    observedPresent.has(id),
  );
  return {
    passed:
      missingExpectedPresent.length === 0 && unexpectedlyPresent.length === 0,
    missingExpectedPresent,
    unexpectedlyPresent,
  };
};

export type ProviderProvenanceEvaluation = Readonly<{
  passed: boolean;
  revisionMatches: boolean;
  repositoryMatches: boolean;
  expectedRevision: string;
  observedRevision: string;
  expectedRepository: string;
  observedRepository: string;
}>;

export const evaluateProviderProvenance = (
  input: Readonly<{
    expectedRevision: string;
    observedRevision: string;
    expectedRepository: string;
    observedRepository: string;
  }>,
): ProviderProvenanceEvaluation => {
  const revisionMatches = input.observedRevision === input.expectedRevision;
  const expectedRepository = resolve(input.expectedRepository);
  const observedRepository = resolve(input.observedRepository);
  const repositoryMatches = observedRepository === expectedRepository;
  return {
    passed: revisionMatches && repositoryMatches,
    revisionMatches,
    repositoryMatches,
    expectedRevision: input.expectedRevision,
    observedRevision: input.observedRevision,
    expectedRepository,
    observedRepository,
  };
};

export type StageEvaluation = Readonly<{
  passed: boolean;
  expectation: PresenceEvaluation;
  provenance: ProviderProvenanceEvaluation;
  complete: boolean;
}>;

export const evaluateQueryStage = (
  input: Readonly<{
    expectations: PresenceExpectations;
    observedPresent: ReadonlySet<string>;
    provenance: ProviderProvenanceEvaluation;
    coverage: string;
    partialFailureCount: number;
    queryConstraintsTruncated: boolean;
    resultsDroppedByBudget: number;
    containedCallablesComplete: boolean;
    capabilityComplete: boolean;
  }>,
): StageEvaluation => {
  const expectation = evaluatePresence(
    input.expectations,
    input.observedPresent,
  );
  const absenceProvable =
    input.expectations.absent.length === 0 ||
    (!input.queryConstraintsTruncated &&
      input.resultsDroppedByBudget === 0 &&
      input.containedCallablesComplete);
  const complete =
    input.coverage === "ok" &&
    input.partialFailureCount === 0 &&
    input.capabilityComplete &&
    absenceProvable;
  return {
    passed: expectation.passed && input.provenance.passed && complete,
    expectation,
    provenance: input.provenance,
    complete,
  };
};

export type RelationshipPresenceObservation =
  | Readonly<{ id: string; kind: "error" | "unavailable" | "invalid" }>
  | Readonly<{
      id: string;
      kind: "observed";
      present: boolean;
      coverage: "complete" | "incomplete";
    }>;

type RelationshipExpectationEvaluation = Readonly<{
  id: string;
  expected: "present" | "absent";
  observed:
    "present" | "absent" | "unknown" | "invalid" | "error" | "unavailable";
  passed: boolean;
}>;

export const evaluateRelationshipStage = (
  expectations: PresenceExpectations,
  observations: readonly RelationshipPresenceObservation[],
): Readonly<{
  passed: boolean;
  errored: boolean;
  complete: boolean;
  expectation: PresenceEvaluation;
  present: ReadonlySet<string>;
  requirements: readonly RelationshipExpectationEvaluation[];
}> => {
  const requirements = (["present", "absent"] as const).flatMap((expected) =>
    expectations[expected].map((id): RelationshipExpectationEvaluation => {
      const matches = observations.filter(
        (observation) => observation.id === id,
      );
      const observation = matches.length === 1 ? matches[0] : undefined;
      const observed =
        observation === undefined
          ? "invalid"
          : observation.kind !== "observed"
            ? observation.kind
            : observation.present
              ? "present"
              : observation.coverage === "complete"
                ? "absent"
                : "unknown";
      return { id, expected, observed, passed: observed === expected };
    }),
  );
  const present = new Set(
    requirements.flatMap(({ id, observed }) =>
      observed === "present" ? [id] : [],
    ),
  );
  const expectation = evaluatePresence(expectations, present);
  const errored = observations.some(
    (observation) => observation.kind === "error",
  );
  const complete = requirements.every(({ id }) => {
    const matches = observations.filter((item) => item.id === id);
    const observation = matches.length === 1 ? matches[0] : undefined;
    return (
      observation?.kind === "observed" && observation.coverage === "complete"
    );
  });
  return {
    passed: requirements.every(({ passed }) => passed) && !errored,
    errored,
    complete,
    expectation,
    present,
    requirements,
  };
};

export type SourceObservation =
  | Readonly<{ kind: "missing_file" }>
  | Readonly<{ kind: "file"; lines: readonly string[] }>;

export type SourceAssertionEvaluation = Readonly<{
  id: string;
  passed: boolean;
  expected: "present" | "absent";
  observed: "present" | "absent" | "missing_file" | "region_out_of_bounds";
}>;

export const evaluateSourceAssertion = (
  assertion: SourceAssertion,
  observation: SourceObservation,
): SourceAssertionEvaluation => {
  const observed: SourceAssertionEvaluation["observed"] = (() => {
    if (assertion.kind === "file") {
      return observation.kind === "file" ? "present" : "absent";
    }
    if (observation.kind === "missing_file") return "missing_file";
    if (assertion.region.endLine > observation.lines.length) {
      return "region_out_of_bounds";
    }
    const selected = observation.lines.slice(
      assertion.region.startLine - 1,
      assertion.region.endLine,
    );
    return selected.join("\n").includes(assertion.literal)
      ? "present"
      : "absent";
  })();
  return {
    id: assertion.id,
    passed:
      (assertion.expected === "present" && observed === "present") ||
      (assertion.expected === "absent" && observed === "absent"),
    expected: assertion.expected,
    observed,
  };
};
