import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  inspectGraph,
  type GraphCommandReceipt,
  type GraphEndpoint,
  type GraphInspection,
  type GraphLocation,
  type GraphQueryObservation,
  type GraphRelationObservation,
  type GraphRelationshipRequest,
} from "@neuve/graph-client";

import { parseQueryRequest } from "../../../apps/neuve-cli/src/boundary.ts";
import {
  graphCacheDirectory,
  toGraphInspectionRequest,
  toPublicQueryResult,
} from "../../../apps/neuve-cli/src/graph-query.ts";

import type {
  ExternalValidationCase,
  ExternalValidationEndpoint,
  RequiredRelationship,
  RevisionControl,
} from "./external-validation-case.ts";
import {
  evaluateProviderProvenance,
  evaluateQueryStage,
  evaluateRelationshipStage,
  evaluateSourceAssertion,
  type PresenceExpectations,
  type RelationshipPresenceObservation,
  type SourceObservation,
} from "./external-validation-evaluator.ts";
import type { CommandEvidence } from "./external-validation-report.ts";

export type ExternalCommandRunner = (
  argv: readonly string[],
  cwd: string,
  environment?: Readonly<Record<string, string>>,
) => Promise<CommandEvidence>;

const commandEvidence = (receipt: GraphCommandReceipt): CommandEvidence => ({
  stage: receipt.stage,
  argv: receipt.argv,
  cwd: receipt.cwd,
  stdout: receipt.stdout,
  stderr: receipt.stderr,
  exit_code: receipt.exitCode,
});

const registerOwnedGraphPaths = (
  register: ((path: string) => void) | undefined,
  view: string,
): void => {
  // Source lives at <inspection>/source/<repository>; its frozen executable
  // lives under the same inspection root, outside the source directory.
  register?.(dirname(dirname(view)));
  register?.(view);
};

const publicRecord = (
  value: unknown,
  label: string,
): Readonly<Record<string, unknown>> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Readonly<Record<string, unknown>>;
};

const publicExactKeys = (
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
  label: string,
): void => {
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(`${label} must contain exactly ${expected.join(", ")}.`);
  }
};

const publicText = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
};

const publicStringArray = (
  value: unknown,
  label: string,
): readonly string[] => {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array of strings.`);
  }
  return value.map((item, index) => publicText(item, `${label}[${index}]`));
};

const publicBoolean = (value: unknown, label: string): boolean => {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean.`);
  return value;
};

const publicNumber = (value: unknown, label: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number.`);
  }
  return value;
};

const publicInteger = (value: unknown, label: string): number => {
  const result = publicNumber(value, label);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return result;
};

const publicPositiveInteger = (value: unknown, label: string): number => {
  const result = publicInteger(value, label);
  if (result < 1) throw new Error(`${label} must be a positive integer.`);
  return result;
};

const publicStringMap = (value: unknown, label: string): void => {
  const result = publicRecord(value, label);
  for (const [key, item] of Object.entries(result)) {
    publicText(item, `${label}.${key}`);
  }
};

const publicStringArrayMap = (value: unknown, label: string): void => {
  const result = publicRecord(value, label);
  for (const [key, item] of Object.entries(result)) {
    publicStringArray(item, `${label}.${key}`);
  }
};

const publicBooleanMap = (value: unknown, label: string): void => {
  const result = publicRecord(value, label);
  for (const [key, item] of Object.entries(result)) {
    publicBoolean(item, `${label}.${key}`);
  }
};

const publicLocation = (value: unknown, label: string): void => {
  const location = publicRecord(value, label);
  if (location.kind === "absent") {
    publicExactKeys(location, ["kind"], label);
    return;
  }
  if (location.kind === "path") {
    publicExactKeys(location, ["kind", "path"], label);
    publicText(location.path, `${label}.path`);
    return;
  }
  if (location.kind === "point") {
    publicExactKeys(location, ["kind", "path", "line"], label);
    publicText(location.path, `${label}.path`);
    publicPositiveInteger(location.line, `${label}.line`);
    return;
  }
  if (location.kind === "range") {
    publicExactKeys(
      location,
      ["kind", "path", "start_line", "end_line"],
      label,
    );
    publicText(location.path, `${label}.path`);
    const start = publicPositiveInteger(
      location.start_line,
      `${label}.start_line`,
    );
    const end = publicPositiveInteger(location.end_line, `${label}.end_line`);
    if (end < start) throw new Error(`${label} must be an ordered range.`);
    return;
  }
  throw new Error(`${label}.kind is invalid.`);
};

const publicRange = (value: unknown, label: string): void => {
  const range = publicRecord(value, label);
  if (range.kind !== "range") throw new Error(`${label}.kind must be range.`);
  publicLocation(range, label);
};

const publicEndpoint = (value: unknown, label: string): void => {
  const endpoint = publicRecord(value, label);
  publicExactKeys(
    endpoint,
    [
      "id",
      "name",
      ...(endpoint.qualified_name === undefined ? [] : ["qualified_name"]),
      ...(endpoint.symbol_kind === undefined ? [] : ["symbol_kind"]),
      ...(endpoint.language === undefined ? [] : ["language"]),
      "location",
      "external",
    ],
    label,
  );
  publicText(endpoint.id, `${label}.id`);
  publicText(endpoint.name, `${label}.name`);
  for (const key of ["qualified_name", "symbol_kind", "language"] as const) {
    if (endpoint[key] !== undefined)
      publicText(endpoint[key], `${label}.${key}`);
  }
  publicLocation(endpoint.location, `${label}.location`);
  publicBoolean(endpoint.external, `${label}.external`);
};

const publicDiagnostic = (value: unknown, label: string): void => {
  const diagnostic = publicRecord(value, label);
  if (diagnostic.kind === "message") {
    publicExactKeys(diagnostic, ["kind", "message"], label);
    publicText(diagnostic.message, `${label}.message`);
    return;
  }
  if (diagnostic.kind !== "provider")
    throw new Error(`${label}.kind is invalid.`);
  publicExactKeys(
    diagnostic,
    [
      "kind",
      "code",
      "severity",
      ...(diagnostic.file_path === undefined ? [] : ["file_path"]),
      ...(diagnostic.language === undefined ? [] : ["language"]),
      "effect_on_completeness",
      ...(diagnostic.detail === undefined ? [] : ["detail"]),
    ],
    label,
  );
  publicText(diagnostic.code, `${label}.code`);
  publicText(diagnostic.severity, `${label}.severity`);
  publicText(
    diagnostic.effect_on_completeness,
    `${label}.effect_on_completeness`,
  );
  for (const key of ["file_path", "language", "detail"] as const) {
    if (diagnostic[key] !== undefined)
      publicText(diagnostic[key], `${label}.${key}`);
  }
};

const publicLimitation = (value: unknown, label: string): void => {
  const limitation = publicRecord(value, label);
  const subject = publicText(limitation.subject, `${label}.subject`);
  if (
    subject !== "query_result" &&
    subject !== "relationship_focus" &&
    subject !== "relationship_endpoint"
  ) {
    throw new Error(`${label}.subject is invalid.`);
  }
  if (limitation.kind === "unclassified_language") {
    publicExactKeys(limitation, ["kind", "subject"], label);
    return;
  }
  if (
    limitation.kind !== "undeclared_language" &&
    limitation.kind !== "non_semantic_language" &&
    limitation.kind !== "unsupported_relation_for_language"
  ) {
    throw new Error(`${label}.kind is invalid.`);
  }
  publicText(limitation.language, `${label}.language`);
  if (limitation.kind === "unsupported_relation_for_language") {
    if (subject === "query_result")
      throw new Error(`${label}.subject is invalid.`);
    publicText(limitation.relation, `${label}.relation`);
    publicExactKeys(
      limitation,
      ["kind", "subject", "language", "relation"],
      label,
    );
    return;
  }
  publicExactKeys(limitation, ["kind", "subject", "language"], label);
};

const publicArrayItems = (
  value: unknown,
  label: string,
  validate: (item: unknown, itemLabel: string) => void,
): void => {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  value.forEach((item, index) => validate(item, `${label}[${index}]`));
};

const publicSymbol = (value: unknown, label: string): void => {
  const symbol = publicRecord(value, label);
  if (symbol.language !== null && typeof symbol.language !== "string") {
    throw new Error(`${label}.language must be a string or null.`);
  }
  if (typeof symbol.language === "string") {
    publicText(symbol.language, `${label}.language`);
  }
  publicRange(symbol.source, `${label}.source`);
  publicText(symbol.symbol, `${label}.symbol`);
  publicText(symbol.symbol_kind, `${label}.symbol_kind`);
  publicText(symbol.qualified_name, `${label}.qualified_name`);
  if (symbol.kind !== "symbol") throw new Error(`${label}.kind is invalid.`);
  publicExactKeys(
    symbol,
    ["kind", "language", "source", "symbol", "symbol_kind", "qualified_name"],
    label,
  );
};

const publicContainedCallables = (value: unknown, label: string): void => {
  const manifest = publicRecord(value, label);
  if (manifest.status === "unavailable") {
    publicExactKeys(manifest, ["status"], label);
    return;
  }
  if (manifest.status !== "complete" && manifest.status !== "truncated") {
    throw new Error(`${label}.status is invalid.`);
  }
  publicArrayItems(manifest.items, `${label}.items`, publicSymbol);
  if (manifest.status === "complete") {
    publicExactKeys(manifest, ["status", "items"], label);
    return;
  }
  if (
    typeof manifest.dropped !== "number" ||
    !Number.isSafeInteger(manifest.dropped) ||
    manifest.dropped < 1
  ) {
    throw new Error(`${label}.dropped must be a positive integer.`);
  }
  publicExactKeys(manifest, ["status", "items", "dropped"], label);
};

const publicCandidate = (value: unknown, label: string): void => {
  const candidate = publicRecord(value, label);
  if (candidate.language !== null && typeof candidate.language !== "string") {
    throw new Error(`${label}.language must be a string or null.`);
  }
  if (typeof candidate.language === "string") {
    publicText(candidate.language, `${label}.language`);
  }
  publicRange(candidate.source, `${label}.source`);
  publicContainedCallables(
    candidate.contained_callables,
    `${label}.contained_callables`,
  );
  const identities = [
    candidate.symbol,
    candidate.symbol_kind,
    candidate.qualified_name,
  ];
  for (const [index, item] of identities.entries()) {
    if (item !== undefined) {
      publicText(
        item,
        `${label}.${["symbol", "symbol_kind", "qualified_name"][index]}`,
      );
    }
  }
  const identityCount = identities.filter((item) => item !== undefined).length;
  const commonKeys = ["kind", "language", "source", "contained_callables"];
  const identityKeys = [
    ...(candidate.symbol === undefined ? [] : ["symbol"]),
    ...(candidate.symbol_kind === undefined ? [] : ["symbol_kind"]),
    ...(candidate.qualified_name === undefined ? [] : ["qualified_name"]),
  ];
  if (candidate.kind === "region" && identityCount === 0) {
    publicExactKeys(candidate, commonKeys, label);
    return;
  }
  if (
    candidate.kind === "partial_symbol" &&
    (identityCount === 1 || identityCount === 2)
  ) {
    publicExactKeys(candidate, [...commonKeys, ...identityKeys], label);
    return;
  }
  if (candidate.kind === "symbol" && identityCount === 3) {
    publicExactKeys(candidate, [...commonKeys, ...identityKeys], label);
    return;
  }
  throw new Error(
    `${label} has an invalid ${String(candidate.kind)} identity shape.`,
  );
};

const publicDiagnostics = (
  owner: Readonly<Record<string, unknown>>,
  label: string,
): void => {
  publicArrayItems(owner.warnings, `${label}.warnings`, publicDiagnostic);
  publicArrayItems(
    owner.partial_failures,
    `${label}.partial_failures`,
    publicDiagnostic,
  );
  publicArrayItems(owner.limitations, `${label}.limitations`, publicLimitation);
};

const publicSectionStatus = (value: unknown, label: string): "ok" | "error" => {
  const section = publicRecord(value, label);
  if (section.status !== "ok" && section.status !== "error") {
    throw new Error(`${label}.status must be ok or error.`);
  }
  if (section.status === "error") publicText(section.error, `${label}.error`);
  return section.status;
};

const validatePublicRetrieval = (
  value: unknown,
  label: string,
): "ok" | "error" => {
  const retrieval = publicRecord(value, label);
  const status = publicSectionStatus(retrieval, label);
  if (status === "error") {
    publicExactKeys(retrieval, ["status", "error"], label);
    return status;
  }
  publicExactKeys(
    retrieval,
    [
      "status",
      "coverage",
      "contained_callable_coverage",
      "candidates",
      "warnings",
      "partial_failures",
      "limitations",
      "budget",
    ],
    label,
  );
  publicText(retrieval.coverage, `${label}.coverage`);
  if (
    retrieval.contained_callable_coverage !== "unavailable" &&
    retrieval.contained_callable_coverage !== "complete" &&
    retrieval.contained_callable_coverage !== "truncated"
  ) {
    throw new Error(`${label}.contained_callable_coverage is invalid.`);
  }
  publicArrayItems(
    retrieval.candidates,
    `${label}.candidates`,
    publicCandidate,
  );
  publicDiagnostics(retrieval, label);
  const budget = publicRecord(retrieval.budget, `${label}.budget`);
  publicExactKeys(
    budget,
    [
      "requested_top_k",
      "requested_max_context_bytes",
      "returned_results",
      "provider_context_budget_bytes",
      "provider_result_bytes",
      "query_constraints_truncated",
      "results_dropped_by_budget",
      "snippets_truncated_by_budget",
    ],
    `${label}.budget`,
  );
  for (const key of [
    "returned_results",
    "provider_context_budget_bytes",
    "provider_result_bytes",
    "results_dropped_by_budget",
    "snippets_truncated_by_budget",
  ] as const) {
    publicInteger(budget[key], `${label}.budget.${key}`);
  }
  publicPositiveInteger(
    budget.requested_top_k,
    `${label}.budget.requested_top_k`,
  );
  publicPositiveInteger(
    budget.requested_max_context_bytes,
    `${label}.budget.requested_max_context_bytes`,
  );
  publicBoolean(
    budget.query_constraints_truncated,
    `${label}.budget.query_constraints_truncated`,
  );
  return status;
};

type PublicStructuralSummary =
  | Readonly<{ request_id: string; status: "error" }>
  | Readonly<{
      request_id: string;
      status: "unavailable";
      selection: "exact" | "family";
      relation: string;
    }>
  | Readonly<{
      request_id: string;
      status: "ok";
      selection: "exact" | "family";
      selected_relations: readonly string[];
    }>;

const validatePublicStructuralOutcome = (
  value: unknown,
  label: string,
): PublicStructuralSummary => {
  const outcome = publicRecord(value, label);
  const requestId = publicText(outcome.request_id, `${label}.request_id`);
  if (outcome.status === "unavailable") {
    publicExactKeys(
      outcome,
      ["request_id", "status", "reason", "selection", "relation"],
      label,
    );
    if (
      outcome.reason !== "unsupported_selection" ||
      (outcome.selection !== "exact" && outcome.selection !== "family")
    )
      throw new Error(`${label} has an invalid unavailable selection.`);
    const relation = publicText(outcome.relation, `${label}.relation`);
    return {
      request_id: requestId,
      status: "unavailable",
      selection: outcome.selection,
      relation,
    };
  }
  const status = publicSectionStatus(outcome, label);
  if (status === "error") {
    publicExactKeys(outcome, ["request_id", "status", "error"], label);
    return { request_id: requestId, status };
  }
  publicExactKeys(
    outcome,
    [
      "request_id",
      "status",
      "selection",
      "selected_relations",
      "focus",
      "observations",
      "truncated",
      "focus_matches_truncated",
      "warnings",
      "partial_failures",
      "limitations",
    ],
    label,
  );
  if (outcome.selection !== "exact" && outcome.selection !== "family")
    throw new Error(`${label}.selection is invalid.`);
  const selectedRelations = publicStringArray(
    outcome.selected_relations,
    `${label}.selected_relations`,
  );
  if (
    selectedRelations.length === 0 ||
    new Set(selectedRelations).size !== selectedRelations.length
  ) {
    throw new Error(`${label}.selected_relations must be nonempty and unique.`);
  }
  const focus = publicRecord(outcome.focus, `${label}.focus`);
  if (focus.kind === "resolved") {
    publicExactKeys(focus, ["kind", "symbol"], `${label}.focus`);
    publicEndpoint(focus.symbol, `${label}.focus.symbol`);
  } else if (focus.kind === "ambiguous") {
    publicExactKeys(
      focus,
      ["kind", "matches", "matches_truncated"],
      `${label}.focus`,
    );
    publicArrayItems(focus.matches, `${label}.focus.matches`, publicEndpoint);
    publicBoolean(focus.matches_truncated, `${label}.focus.matches_truncated`);
  } else if (focus.kind === "not_found") {
    publicExactKeys(focus, ["kind"], `${label}.focus`);
  } else {
    throw new Error(`${label}.focus.kind is invalid.`);
  }
  if (
    focus.kind !== "resolved" &&
    (!Array.isArray(outcome.observations) || outcome.observations.length !== 0)
  )
    throw new Error(`${label}.unresolved focus must have no observations.`);
  if (
    focus.kind === "ambiguous" &&
    focus.matches_truncated !== outcome.focus_matches_truncated
  )
    throw new Error(
      `${label}.ambiguous focus truncation must match its envelope.`,
    );
  publicArrayItems(
    outcome.observations,
    `${label}.observations`,
    (item, itemLabel) => {
      const observation = publicRecord(item, itemLabel);
      publicExactKeys(
        observation,
        [
          "direction",
          "relation",
          "from",
          "to",
          "confidence",
          ...(observation.resolution === undefined ? [] : ["resolution"]),
          ...(observation.reason === undefined ? [] : ["reason"]),
          "evidence",
          "warning_codes",
          "evidence_dropped",
        ],
        itemLabel,
      );
      if (observation.direction !== "in" && observation.direction !== "out") {
        throw new Error(`${itemLabel}.direction is invalid.`);
      }
      const relation = publicText(
        observation.relation,
        `${itemLabel}.relation`,
      );
      if (!selectedRelations.includes(relation))
        throw new Error(
          `${itemLabel}.relation is outside the selected relations.`,
        );
      publicEndpoint(observation.from, `${itemLabel}.from`);
      publicEndpoint(observation.to, `${itemLabel}.to`);
      const confidence = publicNumber(
        observation.confidence,
        `${itemLabel}.confidence`,
      );
      if (confidence < 0 || confidence > 1) {
        throw new Error(`${itemLabel}.confidence must be between 0 and 1.`);
      }
      for (const key of ["resolution", "reason"] as const) {
        if (observation[key] !== undefined)
          publicText(observation[key], `${itemLabel}.${key}`);
      }
      publicArrayItems(
        observation.evidence,
        `${itemLabel}.evidence`,
        (evidence, evidenceLabel) => {
          const item = publicRecord(evidence, evidenceLabel);
          publicExactKeys(
            item,
            [
              "kind",
              "location",
              ...(item.detail === undefined ? [] : ["detail"]),
            ],
            evidenceLabel,
          );
          publicText(item.kind, `${evidenceLabel}.kind`);
          publicLocation(item.location, `${evidenceLabel}.location`);
          if (item.detail !== undefined)
            publicText(item.detail, `${evidenceLabel}.detail`);
        },
      );
      publicStringArray(
        observation.warning_codes,
        `${itemLabel}.warning_codes`,
      );
      publicInteger(
        observation.evidence_dropped,
        `${itemLabel}.evidence_dropped`,
      );
    },
  );
  publicBoolean(outcome.truncated, `${label}.truncated`);
  publicBoolean(
    outcome.focus_matches_truncated,
    `${label}.focus_matches_truncated`,
  );
  publicDiagnostics(outcome, label);
  return {
    request_id: requestId,
    status,
    selection: outcome.selection,
    selected_relations: selectedRelations,
  };
};

const publicQueryObservation = (
  value: unknown,
  expected: Readonly<{
    repository: string;
    revision: string;
    validationCase: ExternalValidationCase;
  }>,
) => {
  const root = publicRecord(value, "public query response");
  publicExactKeys(
    root,
    [
      "schema_version",
      "provider",
      "query",
      "source",
      "retrieval",
      "structural_observations",
    ],
    "public query response",
  );
  const provider = publicRecord(
    root.provider,
    "public query response.provider",
  );
  publicExactKeys(
    provider,
    ["name", "version", "identity_revision", "capabilities"],
    "public query response.provider",
  );
  const capabilities = publicRecord(
    provider.capabilities,
    "public query response.provider.capabilities",
  );
  const languages = publicRecord(
    capabilities.languages,
    "public query response.provider.capabilities.languages",
  );
  const relations = publicRecord(
    capabilities.relations,
    "public query response.provider.capabilities.relations",
  );
  publicExactKeys(
    capabilities,
    [
      "schema_version",
      "file_extensions",
      "languages",
      "relations",
      "parser_versions",
      "optional_local_features",
      "features_requiring_network",
    ],
    "public query response.provider.capabilities",
  );
  publicExactKeys(
    languages,
    ["supported", "semantic", "inventory_only", "unsupported_detected_hints"],
    "public query response.provider.capabilities.languages",
  );
  publicExactKeys(
    relations,
    [
      "supported",
      "by_language",
      "by_profile",
      "heuristic",
      "selection_modes",
      "families",
    ],
    "public query response.provider.capabilities.relations",
  );
  publicText(
    capabilities.schema_version,
    "public query response.provider.capabilities.schema_version",
  );
  publicStringArray(
    capabilities.file_extensions,
    "public query response.provider.capabilities.file_extensions",
  );
  publicStringArray(
    languages.supported,
    "public query response.provider.capabilities.languages.supported",
  );
  publicStringArray(
    languages.semantic,
    "public query response.provider.capabilities.languages.semantic",
  );
  publicStringArray(
    languages.inventory_only,
    "public query response.provider.capabilities.languages.inventory_only",
  );
  publicStringArray(
    languages.unsupported_detected_hints,
    "public query response.provider.capabilities.languages.unsupported_detected_hints",
  );
  publicStringArray(
    relations.supported,
    "public query response.provider.capabilities.relations.supported",
  );
  publicStringArray(
    relations.selection_modes,
    "public query response.provider.capabilities.relations.selection_modes",
  );
  if (
    !Array.isArray(relations.selection_modes) ||
    relations.selection_modes.some(
      (mode) => mode !== "exact" && mode !== "family",
    ) ||
    new Set(relations.selection_modes).size !== relations.selection_modes.length
  )
    throw new Error(
      "public query response.provider.capabilities.relations.selection_modes is invalid.",
    );
  publicStringArrayMap(
    relations.families,
    "public query response.provider.capabilities.relations.families",
  );
  publicStringArrayMap(
    relations.by_language,
    "public query response.provider.capabilities.relations.by_language",
  );
  publicStringArrayMap(
    relations.by_profile,
    "public query response.provider.capabilities.relations.by_profile",
  );
  publicStringArray(
    relations.heuristic,
    "public query response.provider.capabilities.relations.heuristic",
  );
  publicStringMap(
    capabilities.parser_versions,
    "public query response.provider.capabilities.parser_versions",
  );
  publicBooleanMap(
    capabilities.optional_local_features,
    "public query response.provider.capabilities.optional_local_features",
  );
  publicBooleanMap(
    capabilities.features_requiring_network,
    "public query response.provider.capabilities.features_requiring_network",
  );
  const source = publicRecord(root.source, "public query response.source");
  publicExactKeys(
    source,
    ["repository", "revision"],
    "public query response.source",
  );
  if (!Array.isArray(root.structural_observations)) {
    throw new Error(
      "public query response.structural_observations must be an array.",
    );
  }
  const structuralOutcomes = root.structural_observations.map((item, index) =>
    validatePublicStructuralOutcome(
      item,
      `public query response.structural_observations[${index}]`,
    ),
  );
  const retrievalStatus = validatePublicRetrieval(
    root.retrieval,
    "public query response.retrieval",
  );
  const checks = {
    schema_version: root.schema_version === 2,
    provider: provider.name === "entire-graph",
    provider_capabilities: typeof capabilities.schema_version === "string",
    question_unchanged:
      root.query === expected.validationCase.authoritativeQuestion,
    repository: source.repository === resolve(expected.repository),
    revision: source.revision === expected.revision,
    structural_request:
      structuralOutcomes.length ===
        expected.validationCase.requiredRelationships.length &&
      structuralOutcomes.every((outcome, index) => {
        const requirement =
          expected.validationCase.requiredRelationships[index];
        if (requirement === undefined || outcome.request_id !== requirement.id)
          return false;
        if (outcome.status === "error") return true;
        if (outcome.selection !== "exact") return false;
        return outcome.status === "unavailable"
          ? outcome.relation === requirement.relation
          : isDeepStrictEqual(outcome.selected_relations, [
              requirement.relation,
            ]);
      }),
  };
  return {
    checks,
    provider: {
      name: provider.name,
      version: publicText(
        provider.version,
        "public query response.provider.version",
      ),
      identity_revision: publicText(
        provider.identity_revision,
        "public query response.provider.identity_revision",
      ),
      capabilities,
    },
    query: root.query,
    source,
    retrieval_status: retrievalStatus,
    structural_outcomes: structuralOutcomes,
  };
};

type GraphInvocation = Readonly<{
  target: string;
  executable: string;
  executable_sha256: string;
  argv: readonly string[];
  exit_code: number;
  repository?: string;
  repository_revision?: string;
  repository_owned?: boolean;
}>;

const readGraphInvocations = async (
  path: string,
): Promise<readonly GraphInvocation[]> => {
  if (!(await Bun.file(path).exists())) return [];
  return (await Bun.file(path).text())
    .split("\n")
    .filter(Boolean)
    .map((line, index) => {
      const value: unknown = JSON.parse(line);
      const item = publicRecord(value, `graph invocation ${index}`);
      if (
        typeof item.target !== "string" ||
        !Array.isArray(item.argv) ||
        !item.argv.every((value) => typeof value === "string") ||
        typeof item.exit_code !== "number" ||
        typeof item.executable !== "string" ||
        typeof item.executable_sha256 !== "string" ||
        (item.repository !== undefined &&
          typeof item.repository !== "string") ||
        (item.repository_revision !== undefined &&
          typeof item.repository_revision !== "string") ||
        (item.repository_owned !== undefined &&
          typeof item.repository_owned !== "boolean")
      ) {
        throw new Error(`graph invocation ${index} is malformed.`);
      }
      return {
        target: item.target,
        argv: item.argv,
        exit_code: item.exit_code,
        executable: item.executable,
        executable_sha256: item.executable_sha256,
        ...(item.repository === undefined
          ? {}
          : { repository: item.repository }),
        ...(item.repository_revision === undefined
          ? {}
          : { repository_revision: item.repository_revision }),
        ...(item.repository_owned === undefined
          ? {}
          : { repository_owned: item.repository_owned }),
      };
    });
};

const invocationObservation = (
  values: readonly GraphInvocation[],
  expectedTarget: string,
  expectedSha256: string,
  expected: Readonly<{
    repository: string;
    revision: string;
    invocations: readonly Omit<
      GraphInvocation,
      "executable" | "executable_sha256"
    >[];
  }>,
) => {
  const view = values.find(
    ({ repository }) => repository !== undefined,
  )?.repository;
  const expectedView = expected.invocations.find(
    ({ repository }) => repository !== undefined,
  )?.repository;
  const normalizedExpected = expected.invocations.map((invocation) => ({
    ...invocation,
    argv: invocation.argv.map((value) =>
      view !== undefined && value === expectedView ? view : value,
    ),
  }));
  const exactAt = (index: number): boolean => {
    const actual = values[index];
    const wanted = normalizedExpected[index];
    return (
      actual !== undefined &&
      wanted !== undefined &&
      isDeepStrictEqual(actual.argv, wanted.argv)
    );
  };
  const queryIndex = normalizedExpected.findIndex(
    ({ argv }) => argv[0] === "query",
  );
  const neighborIndexes = normalizedExpected.flatMap(({ argv }, index) =>
    argv[0] === "neighbors" ? [index] : [],
  );
  const focusAt = (position: number): boolean => {
    const index = neighborIndexes[position];
    if (index !== undefined) return exactAt(index);
    return (
      values.filter(({ argv }) => argv[0] === "neighbors").length <= position
    );
  };
  const checks = {
    invoked: values.length > 0,
    exact_executable: values.every(
      ({ target, executable_sha256 }) =>
        target === expectedTarget && executable_sha256 === expectedSha256,
    ),
    exact_exit_codes:
      values.length === normalizedExpected.length &&
      values.every(
        ({ exit_code }, index) =>
          exit_code === normalizedExpected[index]?.exit_code,
      ),
    exact_version: exactAt(0),
    exact_capabilities: exactAt(1),
    exact_query: queryIndex >= 0 && exactAt(queryIndex),
    exact_focus_resolution: focusAt(0),
    exact_focus_observation: focusAt(1),
    exact_command_trace:
      values.length === normalizedExpected.length &&
      values.every(({ argv }, index) =>
        isDeepStrictEqual(argv, normalizedExpected[index]?.argv),
      ),
    no_extra_commands: values.length === normalizedExpected.length,
    revision_bound_view:
      view !== undefined &&
      resolve(view) !== resolve(expected.repository) &&
      values
        .filter(({ argv }) => argv[0] === "query" || argv[0] === "neighbors")
        .every(
          ({ repository, repository_revision, repository_owned }) =>
            repository === view &&
            repository_revision === expected.revision &&
            repository_owned === true,
        ),
  };
  return {
    usable: Object.values(checks).every(Boolean),
    checks,
    invocations: values,
  };
};

const retrievedRoles = (
  validationCase: ExternalValidationCase,
  query: GraphQueryObservation,
): ReadonlySet<string> =>
  new Set(
    validationCase.requiredRetrieval.flatMap((requirement) => {
      const candidates = query.results.flatMap((result) => [
        result,
        ...(result.containedCallables.kind === "unavailable"
          ? []
          : result.containedCallables.items),
      ]);
      const found = candidates.some((result) => {
        if (result.language !== validationCase.language) return false;
        if (requirement.kind === "region") {
          return (
            result.source.path === requirement.path &&
            result.source.startLine <= requirement.startLine &&
            result.source.endLine >= requirement.endLine
          );
        }
        return (
          result.source.path === requirement.endpoint.path &&
          result.kind === "symbol" &&
          result.symbol === requirement.endpoint.symbol &&
          (requirement.endpoint.selector.kind === "unqualified" ||
            (result.symbolKind === requirement.endpoint.selector.symbolKind &&
              result.qualifiedName ===
                requirement.endpoint.selector.qualifiedName))
        );
      });
      return found ? [requirement.role] : [];
    }),
  );

const relationshipRequest = (
  relationship: RequiredRelationship,
): GraphRelationshipRequest => ({
  id: relationship.id,
  focus: {
    name: relationship.from.symbol,
    path: relationship.from.path,
    ...(relationship.from.selector.kind === "qualified"
      ? {
          symbolKind: relationship.from.selector.symbolKind,
          qualifiedName: relationship.from.selector.qualifiedName,
        }
      : {}),
  },
  relation: relationship.relation,
  selection: "exact",
  direction: "out",
  depth: 1,
  limit: 50,
});

const publicQueryArgs = (input: {
  repository: string;
  revision: string;
  question: string;
  validationCase: ExternalValidationCase;
}): readonly string[] => [
  "--repo",
  input.repository,
  "--revision",
  input.revision,
  "--question",
  input.question,
  "--max-results",
  "8",
  "--max-context-bytes",
  "16384",
  "--relationship-plan",
  JSON.stringify(
    input.validationCase.requiredRelationships.map((relationship) => ({
      request_id: relationship.id,
      focus: {
        symbol: relationship.from.symbol,
        path: relationship.from.path,
        ...(relationship.from.selector.kind === "qualified"
          ? {
              symbol_kind: relationship.from.selector.symbolKind,
              qualified_name: relationship.from.selector.qualifiedName,
            }
          : {}),
      },
      relation: relationship.relation,
      selection: "exact",
      direction: "out",
      depth: 1,
      limit: 8,
    })),
  ),
];

const locationPath = (location: GraphLocation): string | undefined =>
  location.kind === "absent" ? undefined : location.path;

const sameEndpoint = (
  actual: GraphEndpoint,
  expected: ExternalValidationEndpoint,
  expectedLanguage: string,
): boolean =>
  actual.language === expectedLanguage &&
  locationPath(actual.location) === expected.path &&
  actual.name === expected.symbol &&
  (expected.selector.kind === "unqualified" ||
    (actual.symbolKind === expected.selector.symbolKind &&
      actual.qualifiedName === expected.selector.qualifiedName));

const acceptedResolution = (
  relationship: RequiredRelationship,
  value: string | undefined,
): boolean =>
  value !== undefined &&
  (relationship.resolution.kind === "one"
    ? value === relationship.resolution.value
    : relationship.resolution.values.includes(value));

const evidenceQualifiesCall = (
  observation: GraphRelationObservation,
  requirement: RequiredRelationship,
): boolean => {
  if (observation.from.location.kind !== "range") return false;
  const caller = observation.from.location;
  return observation.evidence.some(({ kind, location }) => {
    if (kind !== "call_site" || location.kind === "absent") return false;
    if (location.path !== requirement.from.path || location.kind === "path") {
      return false;
    }
    const start =
      location.kind === "point" ? location.line : location.startLine;
    const end = location.kind === "point" ? location.line : location.endLine;
    return start >= caller.startLine && end <= caller.endLine;
  });
};

export const createExternalValidationStageRunner = (
  run: ExternalCommandRunner,
  cwd: string,
) => {
  const inspect = async (
    input: Readonly<{
      binary: string;
      repository: string;
      revision: string;
      question: string;
      relationships: readonly RequiredRelationship[];
      evidence: CommandEvidence[];
      temporaryParent?: string;
      registerTemporaryView?: (path: string) => void;
    }>,
  ): Promise<GraphInspection> =>
    inspectGraph(
      {
        executable: input.binary,
        repository: input.repository,
        revision: input.revision,
        question: input.question,
        limits: { topK: 8, maxContextBytes: 16_384 },
        relationships: input.relationships.map(relationshipRequest),
      },
      {
        onCommand: (receipt) => input.evidence.push(commandEvidence(receipt)),
        ...(input.registerTemporaryView === undefined
          ? {}
          : {
              onTemporaryView: ({ path }) =>
                registerOwnedGraphPaths(input.registerTemporaryView, path),
            }),
        ...(input.temporaryParent === undefined
          ? {}
          : { temporaryParent: input.temporaryParent }),
      },
    );

  const graphEvidence = (
    evidence: readonly CommandEvidence[],
    owner: "query" | "relationships",
  ): readonly CommandEvidence[] =>
    evidence.filter(({ stage }) => {
      const sharedSourceQualification = stage?.includes(":source:") ?? false;
      return owner === "relationships"
        ? sharedSourceQualification || !stage?.startsWith("query")
        : sharedSourceQualification || !stage?.startsWith("relationship:");
    });

  const capabilitySupportsCaseRelation = (
    inspection: GraphInspection,
    language: string,
    relation: string,
  ): boolean =>
    inspection.provider.capabilities.supportedLanguages.includes(language) &&
    inspection.provider.capabilities.semanticLanguages.includes(language) &&
    (
      inspection.provider.capabilities.relationSupportByLanguage[language] ?? []
    ).includes(relation) &&
    (
      inspection.provider.capabilities.relationSupportByProfile.full ?? []
    ).includes(relation);

  const mapQuery = (
    inspection: GraphInspection,
    input: Readonly<{
      repository: string;
      revision: string;
      validationCase: ExternalValidationCase;
      expectations: PresenceExpectations;
      acceptanceEffect?: "none";
    }>,
    evidence: readonly CommandEvidence[],
  ): Readonly<Record<string, unknown>> => {
    if (inspection.query.kind === "error") {
      return {
        status: "error",
        evidence,
        error: inspection.query.error.message,
        ...(input.acceptanceEffect === undefined
          ? {}
          : { acceptance_effect: input.acceptanceEffect }),
      };
    }
    const query = inspection.query.value;
    const present = retrievedRoles(input.validationCase, query);
    const provenance = evaluateProviderProvenance({
      expectedRevision: input.revision,
      observedRevision: inspection.source.revision,
      expectedRepository: input.repository,
      observedRepository: inspection.source.repository,
    });
    const capabilityComplete = !query.limitations.some(
      (limitation) =>
        limitation.kind === "unclassified_language" ||
        ("language" in limitation &&
          limitation.language === input.validationCase.language),
    );
    const evaluation = evaluateQueryStage({
      expectations: input.expectations,
      observedPresent: present,
      provenance,
      coverage: query.coverage,
      partialFailureCount: query.partialFailures.length,
      queryConstraintsTruncated: query.budget.queryConstraintsTruncated,
      resultsDroppedByBudget: query.budget.resultsDroppedByBudget,
      containedCallablesComplete:
        query.containedCallableCoverage === "complete",
      capabilityComplete,
    });
    return {
      status: evaluation.passed ? "passed" : "failed",
      evidence,
      observation: query,
      provider: inspection.provider,
      present_roles: [...present],
      evaluation,
      ...(input.acceptanceEffect === undefined
        ? {}
        : { acceptance_effect: input.acceptanceEffect }),
    };
  };

  const mapRelationships = (
    inspection: GraphInspection,
    input: Readonly<{
      validationCase: ExternalValidationCase;
      expectations: PresenceExpectations;
    }>,
    evidence: readonly CommandEvidence[],
  ): Readonly<Record<string, unknown>> => {
    const observations = input.validationCase.requiredRelationships.map(
      (requirement) => {
        const section = inspection.relationships.find(
          ({ requestId }) => requestId === requirement.id,
        );
        if (section === undefined) {
          return {
            id: requirement.id,
            kind: "error" as const,
            observed_present: false,
            observation_valid: false,
            coverage_complete: false,
            matching_observations: 0,
            errored: true,
            error: `Graph inspection omitted relationship ${requirement.id}.`,
          };
        }
        if (section.outcome.kind === "error") {
          return {
            id: requirement.id,
            kind: "error" as const,
            observed_present: false,
            observation_valid: false,
            coverage_complete: false,
            matching_observations: 0,
            errored: true,
            error: section.outcome.error.message,
          };
        }
        if (section.outcome.kind === "unavailable")
          return {
            id: requirement.id,
            kind: "unavailable" as const,
            observed_present: false,
            observation_valid: false,
            coverage_complete: false,
            matching_observations: 0,
            errored: false,
            unavailable: section.outcome,
          };
        const result = section.outcome.value;
        const exactCalls = result.observations.filter(
          ({ relation }) => relation === requirement.relation,
        );
        const candidateMatches = exactCalls.filter(
          (observation) =>
            sameEndpoint(
              observation.from,
              requirement.from,
              input.validationCase.language,
            ) &&
            sameEndpoint(
              observation.to,
              requirement.to,
              input.validationCase.language,
            ),
        );
        const endpointMatches = candidateMatches.filter((observation) =>
          acceptedResolution(requirement, observation.resolution),
        );
        const matching = endpointMatches.filter((observation) =>
          evidenceQualifiesCall(observation, requirement),
        );
        const unexpectedRelations = result.observations
          .filter(({ relation }) => relation !== requirement.relation)
          .map(({ relation }) => relation);
        const valid =
          (result.focus.kind === "resolved"
            ? sameEndpoint(
                result.focus.symbol,
                requirement.from,
                input.validationCase.language,
              )
            : result.observations.length === 0) &&
          capabilitySupportsCaseRelation(
            inspection,
            input.validationCase.language,
            requirement.relation,
          ) &&
          unexpectedRelations.length === 0;
        const complete =
          valid &&
          result.focus.kind !== "ambiguous" &&
          !result.truncated &&
          !result.focusMatchesTruncated &&
          result.warnings.length === 0 &&
          result.partialFailures.length === 0 &&
          result.limitations.length === 0 &&
          result.observations.every(
            (observation) =>
              observation.evidenceDropped === 0 &&
              observation.warningCodes.length === 0,
          ) &&
          candidateMatches.length === matching.length;
        return {
          id: requirement.id,
          kind: "observed" as const,
          observed_present: valid && matching.length > 0,
          observation_valid: valid,
          coverage_complete: complete,
          matching_observations: matching.length,
          errored: false,
          focus: result.focus,
          diagnostics: {
            truncated: result.truncated,
            focus_matches_truncated: result.focusMatchesTruncated,
            warnings: result.warnings,
            partial_failures: result.partialFailures,
            limitations: result.limitations,
            unexpected_relations: unexpectedRelations,
            missing_qualified_call_site_evidence:
              endpointMatches.length - matching.length,
            unaccepted_resolution_candidates:
              candidateMatches.length - endpointMatches.length,
            warning_count: result.warnings.length,
            partial_failure_count: result.partialFailures.length,
          },
        };
      },
    );
    const evaluation = evaluateRelationshipStage(
      input.expectations,
      observations.map((observation): RelationshipPresenceObservation => {
        if (
          observation.kind === "error" ||
          observation.kind === "unavailable"
        ) {
          return { id: observation.id, kind: observation.kind };
        }
        if (!observation.observation_valid)
          return { id: observation.id, kind: "invalid" };
        return {
          id: observation.id,
          kind: "observed",
          present: observation.observed_present,
          coverage: observation.coverage_complete ? "complete" : "incomplete",
        };
      }),
    );
    return {
      status: evaluation.errored
        ? "error"
        : evaluation.passed
          ? "passed"
          : "failed",
      evidence,
      relationships: observations,
      present_relationship_ids: [...evaluation.present],
      evaluation: {
        passed: evaluation.passed,
        errored: evaluation.errored,
        complete: evaluation.complete,
        expectation: evaluation.expectation,
        requirements: evaluation.requirements,
      },
    };
  };

  const runGraph = async (
    input: Readonly<{
      binary: string;
      repository: string;
      revision: string;
      validationCase: ExternalValidationCase;
      question: string;
      queryExpectations: PresenceExpectations;
      relationshipExpectations: PresenceExpectations;
      acceptanceEffect?: "none";
      includePublicInspection?: boolean;
      temporaryParent?: string;
      registerTemporaryView?: (path: string) => void;
    }>,
  ): Promise<
    Readonly<{
      engineQuery: Readonly<Record<string, unknown>>;
      structuredObservations: Readonly<Record<string, unknown>>;
      inspection?: GraphInspection;
      publicInspection?: GraphInspection;
      publicCommandTrace?: readonly CommandEvidence[];
    }>
  > => {
    const evidence: CommandEvidence[] = [];
    try {
      const inspection = await inspect({
        ...input,
        relationships: input.validationCase.requiredRelationships,
        evidence,
      });
      const publicCommandTrace: CommandEvidence[] = [];
      const publicInspection = input.includePublicInspection
        ? await inspectGraph(
            toGraphInspectionRequest(
              parseQueryRequest(publicQueryArgs(input)),
              input.binary,
            ),
            {
              // As `neuve query` runs it (graph-query.ts): on the machine's shared Graph cache.
              cacheDirectory: graphCacheDirectory(),
              onCommand: (receipt) =>
                publicCommandTrace.push(commandEvidence(receipt)),
              ...(input.registerTemporaryView === undefined
                ? {}
                : {
                    onTemporaryView: ({ path }) =>
                      registerOwnedGraphPaths(
                        input.registerTemporaryView,
                        path,
                      ),
                  }),
              ...(input.temporaryParent === undefined
                ? {}
                : { temporaryParent: input.temporaryParent }),
            },
          )
        : undefined;
      return {
        inspection,
        ...(publicInspection === undefined ? {} : { publicInspection }),
        ...(publicInspection === undefined ? {} : { publicCommandTrace }),
        engineQuery: mapQuery(
          inspection,
          { ...input, expectations: input.queryExpectations },
          graphEvidence(evidence, "query"),
        ),
        structuredObservations: mapRelationships(
          inspection,
          { ...input, expectations: input.relationshipExpectations },
          graphEvidence(evidence, "relationships"),
        ),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        engineQuery: {
          status: "error",
          evidence: graphEvidence(evidence, "query"),
          error: message,
          ...(input.acceptanceEffect === undefined
            ? {}
            : { acceptance_effect: input.acceptanceEffect }),
        },
        structuredObservations: {
          status: "error",
          evidence: graphEvidence(evidence, "relationships"),
          error: message,
        },
      };
    }
  };

  const runQuery = async (
    input: Readonly<{
      binary: string;
      repository: string;
      revision: string;
      validationCase: ExternalValidationCase;
      question: string;
      expectations: PresenceExpectations;
      acceptanceEffect?: "none";
      temporaryParent?: string;
      registerTemporaryView?: (path: string) => void;
    }>,
  ): Promise<Readonly<Record<string, unknown>>> => {
    const result = await runGraph({
      ...input,
      validationCase: { ...input.validationCase, requiredRelationships: [] },
      queryExpectations: input.expectations,
      relationshipExpectations: { present: [], absent: [] },
    });
    return result.engineQuery;
  };

  const runPublicQuery = async (input: {
    binary: string;
    engineBinary: string;
    repository: string;
    revision: string;
    validationCase: ExternalValidationCase;
    expectedInspection?: GraphInspection;
    expectedCommandTrace?: readonly CommandEvidence[];
    temporaryParent?: string;
    registerTemporaryPath?: (path: string) => void;
    registerTemporaryView?: (path: string) => void;
  }): Promise<Readonly<Record<string, unknown>>> => {
    const temporaryRoot = await mkdtemp(
      join(input.temporaryParent ?? tmpdir(), "neuve-public-graph-"),
    );
    const candidateTemporaryRoot = join(temporaryRoot, "candidate-tmp");
    const log = join(temporaryRoot, "invocations.jsonl");
    try {
      input.registerTemporaryPath?.(temporaryRoot);
      await mkdir(candidateTemporaryRoot);
      const engineSha256 = createHash("sha256")
        .update(
          new Uint8Array(await Bun.file(input.engineBinary).arrayBuffer()),
        )
        .digest("hex");
      const preload = join(import.meta.dir, "observe-native-graph-preload.ts");
      const preloadCode = new Bun.Transpiler({ loader: "ts" }).transformSync(
        await Bun.file(preload).text(),
      );
      const bunOptions = [
        process.env.BUN_OPTIONS,
        `--preload=data:text/javascript;base64,${Buffer.from(preloadCode).toString("base64")}`,
      ]
        .filter(Boolean)
        .join(" ");
      const command = await run(
        [
          input.binary,
          "query",
          ...publicQueryArgs({
            ...input,
            question: input.validationCase.authoritativeQuestion,
          }),
        ],
        cwd,
        {
          NEUVE_GRAPH_BINARY: input.engineBinary,
          BUN_OPTIONS: bunOptions,
          NEUVE_EVALUATION_GRAPH_OBSERVER: JSON.stringify({
            engineBinary: input.engineBinary,
            sha256: engineSha256,
            log,
            ownedRoot: candidateTemporaryRoot,
          }),
          TMPDIR: candidateTemporaryRoot,
          TMP: candidateTemporaryRoot,
          TEMP: candidateTemporaryRoot,
        },
      );
      let envelope: Readonly<Record<string, unknown>>;
      try {
        const response: unknown = JSON.parse(command.stdout);
        const observation = publicQueryObservation(response, {
          repository: input.repository,
          revision: input.revision,
          validationCase: input.validationCase,
        });
        const request = parseQueryRequest(
          publicQueryArgs({
            ...input,
            question: input.validationCase.authoritativeQuestion,
          }),
        );
        const responseProvenance =
          input.expectedInspection !== undefined &&
          isDeepStrictEqual(
            response,
            toPublicQueryResult(request, input.expectedInspection),
          );
        const checks = {
          ...observation.checks,
          response_provenance: responseProvenance,
        };
        envelope = {
          valid: Object.values(checks).every(Boolean),
          observation: { ...observation, checks },
        };
      } catch (error) {
        envelope = {
          valid: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      let invocation: ReturnType<typeof invocationObservation>;
      let invocationError: string | undefined;
      try {
        const recordedInvocations = await readGraphInvocations(log);
        invocation = invocationObservation(
          recordedInvocations,
          input.engineBinary,
          engineSha256,
          {
            repository: input.repository,
            revision: input.revision,
            invocations: (input.expectedCommandTrace ?? [])
              .filter(
                ({ stage }) =>
                  stage === "version" ||
                  stage === "capabilities" ||
                  stage === "index" ||
                  stage === "query" ||
                  (stage?.startsWith("relationship:") &&
                    !stage.includes(":source:")),
              )
              .map(({ argv, exit_code }) => {
                const forwarded = argv.slice(1);
                const repositoryIndex = forwarded.indexOf("--repo");
                const repository =
                  repositoryIndex < 0
                    ? undefined
                    : forwarded[repositoryIndex + 1];
                return {
                  target: input.engineBinary,
                  argv: forwarded,
                  exit_code,
                  ...(repository === undefined ? {} : { repository }),
                  ...(repository === undefined
                    ? {}
                    : { repository_revision: input.revision }),
                };
              }),
          },
        );
        for (const repository of new Set(
          recordedInvocations.flatMap((item) =>
            item.repository_owned === true && item.repository !== undefined
              ? [item.repository]
              : [],
          ),
        )) {
          registerOwnedGraphPaths(input.registerTemporaryView, repository);
        }
      } catch (error) {
        invocationError =
          error instanceof Error ? error.message : String(error);
        invocation = {
          usable: false,
          checks: {
            invoked: false,
            exact_executable: false,
            exact_exit_codes: false,
            exact_version: false,
            exact_capabilities: false,
            exact_query: false,
            exact_focus_resolution: false,
            exact_focus_observation: false,
            exact_command_trace: false,
            no_extra_commands: false,
            revision_bound_view: false,
          },
          invocations: [],
        };
      }
      const invocationUsable = invocation.usable && command.exit_code === 0;
      return {
        status:
          envelope.valid === true && invocationUsable ? "passed" : "failed",
        evidence: [command],
        envelope,
        invocation: {
          ...invocation,
          usable: invocationUsable,
          ...(invocationError === undefined ? {} : { error: invocationError }),
        },
        ...(command.exit_code === 0
          ? {}
          : {
              error:
                command.stderr.trim() ||
                command.stdout.trim() ||
                `Public query exited with ${command.exit_code}.`,
            }),
      };
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  };

  const runSourceAssertions = async (
    targetRepository: string,
    control: RevisionControl,
  ): Promise<Readonly<Record<string, unknown>>> => {
    const results = [];
    for (const assertion of control.sourceAssertions) {
      const objectName = `${control.revision}:${assertion.path}`;
      const treeLookup = await run(
        [
          "git",
          "-C",
          targetRepository,
          "ls-tree",
          "-z",
          "--format=%(objecttype)",
          control.revision,
          "--",
          assertion.path,
        ],
        cwd,
      );
      let source: CommandEvidence | undefined;
      let observation: SourceObservation | undefined;
      let operationalError: string | undefined;
      if (treeLookup.exit_code !== 0) {
        operationalError =
          treeLookup.stderr.trim() ||
          treeLookup.stdout.trim() ||
          `Git tree lookup exited with ${treeLookup.exit_code}.`;
      } else {
        const objectTypes = treeLookup.stdout.split("\0").filter(Boolean);
        if (objectTypes.length === 0) observation = { kind: "missing_file" };
        else if (objectTypes.length === 1 && objectTypes[0] === "blob") {
          source = await run(
            ["git", "-C", targetRepository, "show", objectName],
            cwd,
          );
          if (source.exit_code === 0) {
            observation = { kind: "file", lines: source.stdout.split("\n") };
          } else {
            operationalError =
              source.stderr.trim() ||
              source.stdout.trim() ||
              `Git source read exited with ${source.exit_code}.`;
          }
        } else {
          operationalError = `${objectName} resolved to ${objectTypes.join(", ")}, not one blob.`;
        }
      }
      if (operationalError !== undefined || observation === undefined) {
        results.push({
          id: assertion.id,
          passed: false,
          expected: assertion.expected,
          observed: "operational_error",
          path: assertion.path,
          evidence: [treeLookup, ...(source === undefined ? [] : [source])],
          error: operationalError ?? "Source observation was not constructed.",
        });
        continue;
      }
      results.push({
        ...evaluateSourceAssertion(assertion, observation),
        path: assertion.path,
        evidence: [treeLookup, ...(source === undefined ? [] : [source])],
        ...(assertion.kind === "literal"
          ? { region: assertion.region, literal: assertion.literal }
          : {}),
      });
    }
    return {
      status: results.some((result) => "error" in result)
        ? "error"
        : results.every(({ passed }) => passed)
          ? "passed"
          : "failed",
      assertions: results,
    };
  };

  return { runGraph, runPublicQuery, runQuery, runSourceAssertions };
};
