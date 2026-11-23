import type {
  QueryRequest,
  RelationshipRequest,
  RepositoryPath,
  Revision,
  SourcePath,
} from "./domain.ts";

const positiveInteger = (raw: string, name: string): number => {
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a positive integer.`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
};

const repositoryPath = (raw: string): RepositoryPath => {
  if (!raw.startsWith("/") || raw.includes("\0")) {
    throw new Error("--repo must be an absolute path without null bytes.");
  }
  return raw as RepositoryPath;
};

const revision = (raw: string): Revision => {
  if (!/^[0-9a-fA-F]{7,64}$/.test(raw)) {
    throw new Error("--revision must be a hexadecimal Git object name.");
  }
  return raw as Revision;
};

const sourcePath = (raw: string, label: string): SourcePath => {
  const hasParentComponent = raw
    .split("/")
    .some((component) => component === "..");
  if (
    raw.startsWith("/") ||
    hasParentComponent ||
    raw.includes("\0") ||
    raw.length === 0
  ) {
    throw new Error(`${label} must be a non-empty repository-relative path.`);
  }
  return raw as SourcePath;
};

const optionNames = [
  "--repo",
  "--revision",
  "--question",
  "--max-results",
  "--max-context-bytes",
  "--relationship-plan",
] as const;

type OptionName = (typeof optionNames)[number] | "--branch";

const isOptionName = (value: string): value is OptionName =>
  value === "--branch" || optionNames.some((name) => name === value);

const record = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
};

const exactKeys = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void => {
  const actual = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  const missing = required.filter((key) => !(key in value));
  const extra = actual.filter((key) => !allowed.has(key));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `${label} has invalid keys; missing ${missing.join(", ") || "none"}, extra ${extra.join(", ") || "none"}.`,
    );
  }
};

const text = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
};

const relationshipPlan = (raw: string): readonly RelationshipRequest[] => {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("--relationship-plan must be a JSON array.");
  }
  if (!Array.isArray(value)) {
    throw new Error("--relationship-plan must be a JSON array.");
  }
  const ids = new Set<string>();
  return value.map((item, index) => {
    const label = `--relationship-plan[${index}]`;
    const relationship = record(item, label);
    exactKeys(
      relationship,
      [
        "request_id",
        "focus",
        "relation",
        "selection",
        "direction",
        "depth",
        "limit",
      ],
      ["summary"],
      label,
    );
    const id = text(relationship.request_id, `${label}.request_id`);
    if (ids.has(id)) {
      throw new Error(`${label}.request_id must be unique.`);
    }
    ids.add(id);
    const focus = record(relationship.focus, `${label}.focus`);
    exactKeys(
      focus,
      ["symbol"],
      ["path", "line", "symbol_kind", "qualified_name"],
      `${label}.focus`,
    );
    const symbol = text(focus.symbol, `${label}.focus.symbol`);
    const path =
      focus.path === undefined
        ? undefined
        : sourcePath(
            text(focus.path, `${label}.focus.path`),
            `${label}.focus.path`,
          );
    const line =
      focus.line === undefined
        ? undefined
        : typeof focus.line === "number" && Number.isSafeInteger(focus.line)
          ? positiveInteger(String(focus.line), `${label}.focus.line`)
          : (() => {
              throw new Error(
                `${label}.focus.line must be a positive integer.`,
              );
            })();
    const symbolKind =
      focus.symbol_kind === undefined
        ? undefined
        : text(focus.symbol_kind, `${label}.focus.symbol_kind`);
    const qualifiedName =
      focus.qualified_name === undefined
        ? undefined
        : text(focus.qualified_name, `${label}.focus.qualified_name`);
    if (line !== undefined && path === undefined) {
      throw new Error(`${label}.focus.line requires focus.path.`);
    }
    if ((symbolKind === undefined) !== (qualifiedName === undefined)) {
      throw new Error(
        `${label}.focus.symbol_kind and focus.qualified_name must appear together.`,
      );
    }
    const direction = relationship.direction;
    const selection = relationship.selection;
    const summary = relationship.summary;
    if (selection !== "exact" && selection !== "family")
      throw new Error(`${label}.selection must be exact or family.`);
    if (direction !== "in" && direction !== "out") {
      throw new Error(`${label}.direction must be in or out.`);
    }
    if (summary !== undefined && summary !== "frontier") {
      throw new Error(`${label}.summary must be frontier when present.`);
    }
    if (relationship.depth !== 1) {
      throw new Error(`${label}.depth must be 1.`);
    }
    if (
      typeof relationship.limit !== "number" ||
      !Number.isSafeInteger(relationship.limit)
    ) {
      throw new Error(`${label}.limit must be a positive integer.`);
    }
    const selectorLocation =
      path === undefined
        ? {}
        : { path, ...(line === undefined ? {} : { line }) };
    const selectorIdentity =
      symbolKind === undefined || qualifiedName === undefined
        ? {}
        : { symbolKind, qualifiedName };
    return {
      id,
      focus: { symbol, ...selectorLocation, ...selectorIdentity },
      relation: text(relationship.relation, `${label}.relation`),
      selection,
      direction,
      depth: 1,
      limit: positiveInteger(String(relationship.limit), `${label}.limit`),
      ...(summary === undefined ? {} : { summary }),
    };
  });
};

export type QueryInvocation = Readonly<{
  request: QueryRequest & Readonly<{ branch?: string }>;
  output: "json" | "ndjson";
}>;

export const parseQueryInvocation = (
  args: readonly string[],
): QueryInvocation => {
  const values = new Map<OptionName, string>();
  const scope: string[] = [];
  let output: QueryInvocation["output"] = "json";
  let refreshCache = false;
  let preparedOnly = false;
  let profile: QueryRequest["profile"];
  for (let index = 0; index < args.length;) {
    const name = args[index];
    if (name === "--profile") {
      if (profile !== undefined)
        throw new Error("--profile may be supplied only once.");
      const selected = args[index + 1];
      if (selected !== "full" && selected !== "syntax-only")
        throw new Error("--profile must be full or syntax-only.");
      profile = selected;
      index += 2;
      continue;
    }
    if (name === "--refresh-cache") {
      if (refreshCache)
        throw new Error("--refresh-cache may be supplied only once.");
      refreshCache = true;
      index += 1;
      continue;
    }
    if (name === "--prepared-only") {
      if (preparedOnly)
        throw new Error("--prepared-only may be supplied only once.");
      preparedOnly = true;
      index += 1;
      continue;
    }
    if (name === "--stream") {
      if (output === "ndjson") {
        throw new Error("--stream may be supplied only once.");
      }
      output = "ndjson";
      index += 1;
      continue;
    }
    const value = args[index + 1];
    if (name === undefined || (name !== "--scope" && !isOptionName(name))) {
      throw new Error(`Unknown query option: ${name ?? "<missing>"}.`);
    }
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${name} requires a value.`);
    }
    if (name === "--scope") {
      if (value.length === 0 || value.includes("\0"))
        throw new Error("--scope must be a non-empty path without null bytes.");
      scope.push(value);
    } else if (values.has(name)) {
      throw new Error(`${name} may be supplied only once.`);
    } else {
      values.set(name, value);
    }
    index += 2;
  }

  if (refreshCache && preparedOnly)
    throw new Error("--prepared-only cannot be combined with --refresh-cache.");
  if (profile === "syntax-only" && !preparedOnly)
    throw new Error("syntax-only requires --prepared-only.");
  for (const name of optionNames) {
    if (!values.has(name)) {
      throw new Error(`Missing required option ${name}.`);
    }
  }

  const repo = values.get("--repo");
  const revisionValue = values.get("--revision");
  const question = values.get("--question");
  const maxResults = values.get("--max-results");
  const maxContextBytes = values.get("--max-context-bytes");
  const relationships = values.get("--relationship-plan");
  const branch = values.get("--branch");
  if (
    repo === undefined ||
    revisionValue === undefined ||
    question === undefined ||
    maxResults === undefined ||
    maxContextBytes === undefined ||
    relationships === undefined
  ) {
    throw new Error("Internal option parsing error.");
  }
  if (question.trim().length === 0) {
    throw new Error("--question must not be empty.");
  }
  if (
    preparedOnly &&
    !/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(revisionValue)
  )
    throw new Error("--prepared-only requires an exact full commit OID.");

  return {
    output,
    request: {
      repository: repositoryPath(repo),
      revision: revision(revisionValue),
      question,
      maxResults: positiveInteger(maxResults, "--max-results"),
      maxContextBytes: positiveInteger(maxContextBytes, "--max-context-bytes"),
      relationships: relationshipPlan(relationships),
      ...(scope.length === 0 ? {} : { scope }),
      ...(branch === undefined ? {} : { branch: text(branch, "--branch") }),
      ...(profile === undefined ? {} : { profile }),
      ...(preparedOnly
        ? { cache: "prepared" as const }
        : refreshCache
          ? { cache: "refresh" as const }
          : {}),
    },
  };
};

export const parseQueryRequest = (
  args: readonly string[],
): QueryInvocation["request"] => parseQueryInvocation(args).request;
