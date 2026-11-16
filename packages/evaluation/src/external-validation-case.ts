type JsonRecord = Readonly<Record<string, unknown>>;

export type ExternalValidationEndpoint = Readonly<{
  path: string;
  symbol: string;
  selector:
    | Readonly<{ kind: "unqualified" }>
    | Readonly<{
        kind: "qualified";
        symbolKind: string;
        qualifiedName: string;
      }>;
}>;

export type RequiredRetrieval =
  | Readonly<{
      kind: "symbol";
      role: string;
      endpoint: ExternalValidationEndpoint;
    }>
  | Readonly<{
      kind: "region";
      role: string;
      path: string;
      startLine: number;
      endLine: number;
    }>;

export type RequiredRelationship = Readonly<{
  id: string;
  relation: "CALLS";
  resolution:
    | Readonly<{ kind: "one"; value: string }>
    | Readonly<{ kind: "accepted"; values: readonly string[] }>;
  from: ExternalValidationEndpoint;
  to: ExternalValidationEndpoint;
}>;

export type SourceAssertion =
  | Readonly<{
      kind: "file";
      id: string;
      path: string;
      expected: "present" | "absent";
    }>
  | Readonly<{
      kind: "literal";
      id: string;
      path: string;
      region: Readonly<{ startLine: number; endLine: number }>;
      literal: string;
      expected: "present" | "absent";
    }>;

export type RevisionControl = Readonly<{
  id: string;
  revision: string;
  sourceAssertions: readonly SourceAssertion[];
  retrieval: Readonly<{
    present: readonly string[];
    absent: readonly string[];
  }>;
  relationships: Readonly<{
    present: readonly string[];
    absent: readonly string[];
  }>;
}>;

export type ExternalValidationCase = Readonly<{
  id: string;
  language: string;
  positiveRevision: string;
  parentRevision: string;
  target: ExternalValidationEndpoint;
  authoritativeQuestion: string;
  sensitivityParaphrase: string;
  requiredRetrieval: readonly RequiredRetrieval[];
  requiredRelationships: readonly RequiredRelationship[];
  behavioralObligations: readonly string[];
  revisionControls: readonly RevisionControl[];
}>;

export type ExternalValidationManifest = Readonly<{
  id: string;
  language: string;
  cases: readonly string[];
  target: Readonly<{
    localDefault: string;
    sourceView: "pinned_committed_revision";
    ignoreCurrentWorktree: true;
  }>;
  engine: Readonly<{
    localDefault: string;
    upstreamRepository: string;
    upstreamBaselineRevision: string;
    neuveOwnedForkRequired: true;
    baselineTag: string;
    baselineTagTarget: string;
    upstreamRemoteName: string;
    upstreamRemoteUrl: string;
    upstreamPush: "disabled";
    originRemoteName: "origin";
    originRemoteUrl: string;
    hostedOrigin: string;
  }>;
  requiredRunIdentities: readonly (
    | "neuve_source_revision"
    | "neuve_binary_identity"
    | "engine_source_revision"
    | "engine_binary_identity"
    | "engine_fork_marker"
    | "target_repository_revision"
  )[];
  stageResults: readonly (
    "public_query" | "engine_query" | "structured_observations"
  )[];
}>;

export type ExternalValidationSuite = Readonly<{
  manifest: ExternalValidationManifest;
  cases: readonly ExternalValidationCase[];
}>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const record = (value: unknown, label: string): JsonRecord => {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  return value;
};

const exactKeys = (
  owner: JsonRecord,
  allowed: readonly string[],
  label: string,
): void => {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(owner).filter((key) => !allowedKeys.has(key));
  if (unknown.length > 0) {
    throw new Error(`${label} has unsupported fields: ${unknown.join(", ")}.`);
  }
};

const required = (owner: JsonRecord, key: string, label: string): unknown => {
  if (!(key in owner)) throw new Error(`${label}.${key} is required.`);
  return owner[key];
};

const text = (owner: JsonRecord, key: string, label: string): string => {
  const value = required(owner, key, label);
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label}.${key} must be a non-empty string.`);
  }
  return value;
};

const booleanLiteral = <Value extends boolean>(
  owner: JsonRecord,
  key: string,
  expected: Value,
  label: string,
): Value => {
  if (required(owner, key, label) !== expected) {
    throw new Error(`${label}.${key} must be ${String(expected)}.`);
  }
  return expected;
};

const literal = <Value extends string>(
  owner: JsonRecord,
  key: string,
  expected: Value,
  label: string,
): Value => {
  const value = text(owner, key, label);
  if (value !== expected)
    throw new Error(`${label}.${key} must be ${expected}.`);
  return expected;
};

const list = (
  owner: JsonRecord,
  key: string,
  label: string,
): readonly unknown[] => {
  const value = required(owner, key, label);
  if (!Array.isArray(value))
    throw new Error(`${label}.${key} must be an array.`);
  return value;
};

const stringList = (
  owner: JsonRecord,
  key: string,
  label: string,
): readonly string[] =>
  list(owner, key, label).map((value, index) => {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`${label}.${key}[${index}] must be a non-empty string.`);
    }
    return value;
  });

const unique = (values: readonly string[], label: string): void => {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value))
      throw new Error(`${label} contains duplicate ${value}.`);
    seen.add(value);
  }
};

const positiveInteger = (
  owner: JsonRecord,
  key: string,
  label: string,
): number => {
  const value = required(owner, key, label);
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label}.${key} must be a positive integer.`);
  }
  return value;
};

const revision = (value: string, label: string): string => {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) {
    throw new Error(`${label} must be a full lowercase Git object name.`);
  }
  return value;
};

const repositoryPath = (value: string, label: string): string => {
  if (
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    value
      .split("/")
      .some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw new Error(`${label} must be a repository-relative path.`);
  }
  return value;
};

const optionalText = (
  owner: JsonRecord,
  key: string,
  label: string,
): string | undefined =>
  !(key in owner) ? undefined : text(owner, key, label);

const endpoint = (
  value: unknown,
  label: string,
  allowedExtraKeys: readonly string[] = [],
): ExternalValidationEndpoint => {
  const item = record(value, label);
  exactKeys(
    item,
    ["path", "symbol", "kind", "qualified_name", ...allowedExtraKeys],
    label,
  );
  const kind = optionalText(item, "kind", label);
  const qualifiedName = optionalText(item, "qualified_name", label);
  if ((kind === undefined) !== (qualifiedName === undefined)) {
    throw new Error(
      `${label} must define both kind and qualified_name or neither.`,
    );
  }
  return {
    path: repositoryPath(text(item, "path", label), `${label}.path`),
    symbol: text(item, "symbol", label),
    selector:
      kind === undefined || qualifiedName === undefined
        ? { kind: "unqualified" }
        : { kind: "qualified", symbolKind: kind, qualifiedName },
  };
};

const parseResolution = (
  item: JsonRecord,
  label: string,
): RequiredRelationship["resolution"] => {
  const hasOne = "resolution" in item;
  const hasAccepted = "accepted_resolutions" in item;
  if (hasOne === hasAccepted)
    throw new Error(`${label} must define exactly one resolution form.`);
  if (hasOne) return { kind: "one", value: text(item, "resolution", label) };
  const values = stringList(item, "accepted_resolutions", label);
  if (values.length === 0)
    throw new Error(`${label}.accepted_resolutions must not be empty.`);
  unique(values, `${label}.accepted_resolutions`);
  return { kind: "accepted", values };
};

const parseSourceAssertion = (
  value: unknown,
  label: string,
): SourceAssertion => {
  const item = record(value, label);
  const kind = text(item, "kind", label);
  const expected = text(item, "expected", label);
  if (expected !== "present" && expected !== "absent") {
    throw new Error(`${label}.expected must be present or absent.`);
  }
  if (kind === "file") {
    exactKeys(item, ["id", "kind", "path", "expected"], label);
    return {
      kind,
      id: text(item, "id", label),
      path: repositoryPath(text(item, "path", label), `${label}.path`),
      expected,
    };
  }
  if (kind !== "literal")
    throw new Error(`${label}.kind must be file or literal.`);
  exactKeys(
    item,
    ["id", "kind", "path", "region", "literal", "expected"],
    label,
  );
  const regionValue = record(
    required(item, "region", label),
    `${label}.region`,
  );
  exactKeys(regionValue, ["start", "end"], `${label}.region`);
  const startLine = positiveInteger(regionValue, "start", `${label}.region`);
  const endLine = positiveInteger(regionValue, "end", `${label}.region`);
  if (endLine < startLine) throw new Error(`${label}.region must be ordered.`);
  return {
    kind,
    id: text(item, "id", label),
    path: repositoryPath(text(item, "path", label), `${label}.path`),
    region: { startLine, endLine },
    literal: text(item, "literal", label),
    expected,
  };
};

const parseExpectedIds = (
  value: unknown,
  label: string,
): Readonly<{ present: readonly string[]; absent: readonly string[] }> => {
  const item = record(value, label);
  exactKeys(item, ["present", "absent"], label);
  const present = stringList(item, "present", label);
  const absent = stringList(item, "absent", label);
  unique([...present, ...absent], label);
  return { present, absent };
};

const sameMembers = (
  actual: readonly string[],
  expected: readonly string[],
): boolean =>
  actual.length === expected.length &&
  expected.every((value) => actual.includes(value));

export const parseExternalValidationCase = (
  value: unknown,
): ExternalValidationCase => {
  const root = record(value, "case");
  exactKeys(
    root,
    [
      "schema_version",
      "case_id",
      "status",
      "language",
      "target",
      "questions",
      "required_retrieval",
      "required_relationships",
      "behavioral_obligations",
      "revision_controls",
      "known_lexical_baseline",
    ],
    "case",
  );
  if (positiveInteger(root, "schema_version", "case") !== 1)
    throw new Error("case.schema_version must be 1.");
  literal(root, "status", "candidate", "case");
  const language = text(root, "language", "case");
  const target = record(required(root, "target", "case"), "case.target");
  exactKeys(
    target,
    ["positive_revision", "parent_revision", "file", "symbol"],
    "case.target",
  );
  const questions = record(
    required(root, "questions", "case"),
    "case.questions",
  );
  exactKeys(
    questions,
    ["authoritative", "sensitivity_paraphrase"],
    "case.questions",
  );
  if ("known_lexical_baseline" in root) {
    const baseline = record(
      root.known_lexical_baseline,
      "case.known_lexical_baseline",
    );
    exactKeys(baseline, ["verdict", "reason"], "case.known_lexical_baseline");
    literal(baseline, "verdict", "fail", "case.known_lexical_baseline");
    text(baseline, "reason", "case.known_lexical_baseline");
  }

  const requiredRetrieval = list(root, "required_retrieval", "case").map(
    (value, index) => {
      const label = `case.required_retrieval[${index}]`;
      const item = record(value, label);
      const hasSymbol = "symbol" in item;
      const hasLines = "lines" in item;
      if (hasSymbol === hasLines)
        throw new Error(
          `${label} must define exactly one locator: symbol or lines.`,
        );
      if (hasSymbol) {
        exactKeys(
          item,
          ["role", "path", "symbol", "kind", "qualified_name"],
          label,
        );
        return {
          kind: "symbol",
          role: text(item, "role", label),
          endpoint: endpoint(item, label, ["role"]),
        } satisfies RequiredRetrieval;
      }
      exactKeys(item, ["role", "path", "lines"], label);
      const lines = record(required(item, "lines", label), `${label}.lines`);
      exactKeys(lines, ["start", "end"], `${label}.lines`);
      const startLine = positiveInteger(lines, "start", `${label}.lines`);
      const endLine = positiveInteger(lines, "end", `${label}.lines`);
      if (endLine < startLine)
        throw new Error(`${label}.lines must be ordered.`);
      return {
        kind: "region",
        role: text(item, "role", label),
        path: repositoryPath(text(item, "path", label), `${label}.path`),
        startLine,
        endLine,
      } satisfies RequiredRetrieval;
    },
  );
  const retrievalRoles = requiredRetrieval.map(({ role }) => role);
  if (retrievalRoles.length === 0) {
    throw new Error("case.required_retrieval must not be empty.");
  }
  unique(retrievalRoles, "case.required_retrieval roles");

  const requiredRelationships = list(
    root,
    "required_relationships",
    "case",
  ).map((value, index) => {
    const label = `case.required_relationships[${index}]`;
    const item = record(value, label);
    exactKeys(
      item,
      ["id", "relation", "resolution", "accepted_resolutions", "from", "to"],
      label,
    );
    return {
      id: text(item, "id", label),
      relation: literal(item, "relation", "CALLS", label),
      resolution: parseResolution(item, label),
      from: endpoint(required(item, "from", label), `${label}.from`),
      to: endpoint(required(item, "to", label), `${label}.to`),
    } satisfies RequiredRelationship;
  });
  const relationshipIds = requiredRelationships.map(({ id }) => id);
  unique(relationshipIds, "case.required_relationships ids");

  const revisionControls = list(root, "revision_controls", "case").map(
    (value, index) => {
      const label = `case.revision_controls[${index}]`;
      const item = record(value, label);
      exactKeys(
        item,
        ["id", "revision", "source_assertions", "retrieval", "relationships"],
        label,
      );
      const sourceAssertions = list(item, "source_assertions", label).map(
        (assertion, assertionIndex) =>
          parseSourceAssertion(
            assertion,
            `${label}.source_assertions[${assertionIndex}]`,
          ),
      );
      if (sourceAssertions.length === 0) {
        throw new Error(`${label}.source_assertions must not be empty.`);
      }
      unique(
        sourceAssertions.map(({ id }) => id),
        `${label}.source_assertions ids`,
      );
      const retrieval = parseExpectedIds(
        required(item, "retrieval", label),
        `${label}.retrieval`,
      );
      const relationships = parseExpectedIds(
        required(item, "relationships", label),
        `${label}.relationships`,
      );
      if (
        !sameMembers(
          [...retrieval.present, ...retrieval.absent],
          retrievalRoles,
        )
      ) {
        throw new Error(
          `${label}.retrieval must classify every required retrieval role exactly once.`,
        );
      }
      if (
        !sameMembers(
          [...relationships.present, ...relationships.absent],
          relationshipIds,
        )
      ) {
        throw new Error(
          `${label}.relationships must classify every required relationship id exactly once.`,
        );
      }
      return {
        id: text(item, "id", label),
        revision: revision(text(item, "revision", label), `${label}.revision`),
        sourceAssertions,
        retrieval,
        relationships,
      } satisfies RevisionControl;
    },
  );
  unique(
    revisionControls.map(({ id }) => id),
    "case.revision_controls ids",
  );
  unique(
    revisionControls.map(({ revision: value }) => value),
    "case.revision_controls revisions",
  );
  if (revisionControls.length === 0) {
    throw new Error("case.revision_controls must not be empty.");
  }

  const behavioralObligations = stringList(
    root,
    "behavioral_obligations",
    "case",
  );
  if (behavioralObligations.length === 0) {
    throw new Error("case.behavioral_obligations must not be empty.");
  }

  const positiveRevision = revision(
    text(target, "positive_revision", "case.target"),
    "case.target.positive_revision",
  );
  const parentRevision = revision(
    text(target, "parent_revision", "case.target"),
    "case.target.parent_revision",
  );
  if (
    !revisionControls.some((control) => control.revision === parentRevision)
  ) {
    throw new Error(
      "case.revision_controls must include case.target.parent_revision.",
    );
  }
  if (
    revisionControls.some((control) => control.revision === positiveRevision)
  ) {
    throw new Error(
      "case.revision_controls must not duplicate the positive revision.",
    );
  }

  return {
    id: text(root, "case_id", "case"),
    language,
    positiveRevision,
    parentRevision,
    target: {
      path: repositoryPath(
        text(target, "file", "case.target"),
        "case.target.file",
      ),
      symbol: text(target, "symbol", "case.target"),
      selector: { kind: "unqualified" },
    },
    authoritativeQuestion: text(questions, "authoritative", "case.questions"),
    sensitivityParaphrase: text(
      questions,
      "sensitivity_paraphrase",
      "case.questions",
    ),
    requiredRetrieval,
    requiredRelationships,
    behavioralObligations,
    revisionControls,
  };
};

const parseKnownList = <Value extends string>(
  owner: JsonRecord,
  key: string,
  label: string,
  allowed: readonly Value[],
): readonly Value[] => {
  const values = stringList(owner, key, label);
  unique(values, `${label}.${key}`);
  return values.map((value, index) => {
    const matched = allowed.find((candidate) => candidate === value);
    if (matched === undefined)
      throw new Error(`${label}.${key}[${index}] is unsupported: ${value}.`);
    return matched;
  });
};

export const parseExternalValidationManifest = (
  value: unknown,
): ExternalValidationManifest => {
  const root = record(value, "manifest");
  exactKeys(
    root,
    [
      "schema_version",
      "suite_id",
      "status",
      "language",
      "repositories",
      "required_run_identities",
      "stage_results",
      "cases",
    ],
    "manifest",
  );
  if (positiveInteger(root, "schema_version", "manifest") !== 1)
    throw new Error("manifest.schema_version must be 1.");
  literal(root, "status", "candidate", "manifest");
  const language = text(root, "language", "manifest");
  const repositories = record(
    required(root, "repositories", "manifest"),
    "manifest.repositories",
  );
  exactKeys(repositories, ["target", "engine"], "manifest.repositories");
  const target = record(
    required(repositories, "target", "manifest.repositories"),
    "manifest.repositories.target",
  );
  exactKeys(
    target,
    [
      "runtime_argument",
      "local_default",
      "source_view",
      "ignore_current_worktree",
    ],
    "manifest.repositories.target",
  );
  literal(
    target,
    "runtime_argument",
    "required",
    "manifest.repositories.target",
  );
  const engine = record(
    required(repositories, "engine", "manifest.repositories"),
    "manifest.repositories.engine",
  );
  exactKeys(
    engine,
    [
      "runtime_argument",
      "local_default",
      "upstream_repository",
      "upstream_baseline_revision",
      "neuve_owned_fork_required",
      "required_fork_marker",
      "hosted_origin",
    ],
    "manifest.repositories.engine",
  );
  literal(
    engine,
    "runtime_argument",
    "required",
    "manifest.repositories.engine",
  );
  const marker = record(
    required(engine, "required_fork_marker", "manifest.repositories.engine"),
    "manifest.repositories.engine.required_fork_marker",
  );
  exactKeys(
    marker,
    [
      "baseline_tag",
      "baseline_tag_target",
      "upstream_fetch_remote",
      "upstream_push",
      "origin_remote",
    ],
    "manifest.repositories.engine.required_fork_marker",
  );
  const fetchRemote = record(
    required(
      marker,
      "upstream_fetch_remote",
      "manifest.repositories.engine.required_fork_marker",
    ),
    "manifest.repositories.engine.required_fork_marker.upstream_fetch_remote",
  );
  exactKeys(
    fetchRemote,
    ["name", "url"],
    "manifest.repositories.engine.required_fork_marker.upstream_fetch_remote",
  );
  const originRemote = record(
    required(
      marker,
      "origin_remote",
      "manifest.repositories.engine.required_fork_marker",
    ),
    "manifest.repositories.engine.required_fork_marker.origin_remote",
  );
  exactKeys(
    originRemote,
    ["name", "url"],
    "manifest.repositories.engine.required_fork_marker.origin_remote",
  );
  const cases = stringList(root, "cases", "manifest").map((value, index) =>
    repositoryPath(value, `manifest.cases[${index}]`),
  );
  unique(cases, "manifest.cases");
  if (cases.length === 0) throw new Error("manifest.cases must not be empty.");
  const requiredRunIdentities = parseKnownList(
    root,
    "required_run_identities",
    "manifest",
    [
      "neuve_source_revision",
      "neuve_binary_identity",
      "engine_source_revision",
      "engine_binary_identity",
      "engine_fork_marker",
      "target_repository_revision",
    ],
  );
  if (
    !sameMembers(requiredRunIdentities, [
      "neuve_source_revision",
      "neuve_binary_identity",
      "engine_source_revision",
      "engine_binary_identity",
      "engine_fork_marker",
      "target_repository_revision",
    ])
  ) {
    throw new Error(
      "manifest.required_run_identities must contain every required identity.",
    );
  }
  const stageResults = parseKnownList(root, "stage_results", "manifest", [
    "public_query",
    "engine_query",
    "structured_observations",
  ]);
  if (
    !sameMembers(stageResults, [
      "public_query",
      "engine_query",
      "structured_observations",
    ])
  ) {
    throw new Error(
      "manifest.stage_results must contain all three live stages.",
    );
  }
  const upstreamRepository = text(
    engine,
    "upstream_repository",
    "manifest.repositories.engine",
  );
  const upstreamRemoteUrl = text(
    fetchRemote,
    "url",
    "manifest.repositories.engine.required_fork_marker.upstream_fetch_remote",
  );
  if (upstreamRepository !== upstreamRemoteUrl) {
    throw new Error(
      "manifest engine upstream repository and fetch remote URL must match.",
    );
  }
  const hostedOrigin = text(
    engine,
    "hosted_origin",
    "manifest.repositories.engine",
  );
  const originRemoteUrl = text(
    originRemote,
    "url",
    "manifest.repositories.engine.required_fork_marker.origin_remote",
  );
  if (hostedOrigin !== originRemoteUrl) {
    throw new Error(
      "manifest engine hosted origin and origin remote URL must match.",
    );
  }
  const upstreamBaselineRevision = revision(
    text(engine, "upstream_baseline_revision", "manifest.repositories.engine"),
    "manifest.repositories.engine.upstream_baseline_revision",
  );
  const baselineTagTarget = revision(
    text(
      marker,
      "baseline_tag_target",
      "manifest.repositories.engine.required_fork_marker",
    ),
    "manifest.repositories.engine.required_fork_marker.baseline_tag_target",
  );
  if (upstreamBaselineRevision !== baselineTagTarget) {
    throw new Error(
      "manifest engine baseline revision and tag target must match.",
    );
  }
  return {
    id: text(root, "suite_id", "manifest"),
    language,
    cases,
    target: {
      localDefault: text(
        target,
        "local_default",
        "manifest.repositories.target",
      ),
      sourceView: literal(
        target,
        "source_view",
        "pinned_committed_revision",
        "manifest.repositories.target",
      ),
      ignoreCurrentWorktree: booleanLiteral(
        target,
        "ignore_current_worktree",
        true,
        "manifest.repositories.target",
      ),
    },
    engine: {
      localDefault: text(
        engine,
        "local_default",
        "manifest.repositories.engine",
      ),
      upstreamRepository,
      upstreamBaselineRevision,
      neuveOwnedForkRequired: booleanLiteral(
        engine,
        "neuve_owned_fork_required",
        true,
        "manifest.repositories.engine",
      ),
      baselineTag: text(
        marker,
        "baseline_tag",
        "manifest.repositories.engine.required_fork_marker",
      ),
      baselineTagTarget,
      upstreamRemoteName: text(
        fetchRemote,
        "name",
        "manifest.repositories.engine.required_fork_marker.upstream_fetch_remote",
      ),
      upstreamRemoteUrl,
      upstreamPush: literal(
        marker,
        "upstream_push",
        "disabled",
        "manifest.repositories.engine.required_fork_marker",
      ),
      originRemoteName: literal(
        originRemote,
        "name",
        "origin",
        "manifest.repositories.engine.required_fork_marker.origin_remote",
      ),
      originRemoteUrl,
      hostedOrigin,
    },
    requiredRunIdentities,
    stageResults,
  };
};

export const assembleExternalValidationSuite = (
  manifest: ExternalValidationManifest,
  caseFiles: readonly Readonly<{
    filename: string;
    validationCase: ExternalValidationCase;
  }>[],
): ExternalValidationSuite => {
  if (caseFiles.length !== manifest.cases.length)
    throw new Error("Discovered case count does not match manifest.cases.");
  const filenames = caseFiles.map(({ filename }) => filename);
  unique(filenames, "discovered case filenames");
  if (
    !manifest.cases.every((filename, index) => filenames[index] === filename)
  ) {
    throw new Error(
      "Cases must be discovered in manifest order with no substitutions.",
    );
  }
  const cases = caseFiles.map(({ validationCase }) => validationCase);
  unique(
    cases.map(({ id }) => id),
    "discovered case ids",
  );
  for (const validationCase of cases) {
    if (validationCase.language !== manifest.language) {
      throw new Error(
        `Case ${validationCase.id} language ${validationCase.language} does not match suite language ${manifest.language}.`,
      );
    }
  }
  return { manifest, cases };
};
