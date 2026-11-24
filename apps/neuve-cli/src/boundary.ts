import { resolve } from "node:path";
import type {
  QueryRequest,
  RelationshipRequest,
  RepositoryPath,
  Revision,
  SourcePath,
} from "./domain.ts";
import { argumentRefusal, unknownOptionRefusal } from "./records-cli.ts";

const positiveInteger = (raw: string, name: string): number => {
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(argumentRefusal(name, "a positive integer"));
  }
  return value;
};

const repositoryPath = (raw: string): RepositoryPath => {
  if (!raw.startsWith("/") || raw.includes("\0")) {
    throw new Error(
      argumentRefusal("--repo", "an absolute path without null bytes"),
    );
  }
  return resolve(raw) as RepositoryPath;
};

const revision = (raw: string | undefined, preparedOnly: boolean): Revision => {
  const pattern = preparedOnly
    ? /^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/
    : /^[0-9a-fA-F]{7,64}$/;
  if (raw === undefined || !pattern.test(raw)) {
    const accepted = preparedOnly
      ? "an exact full commit OID with --prepared-only"
      : "a hexadecimal Git object name";
    throw new Error(
      argumentRefusal("--revision", accepted) +
        (raw === undefined ? " No value was supplied." : ""),
    );
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

const queryValues = {
  "--repo": "an absolute path",
  "--revision": "a hexadecimal Git object name",
  "--question": "non-empty text",
  "--max-results": "a positive integer",
  "--max-context-bytes": "a positive integer",
  "--relationship-plan": "a JSON array",
  "--branch": "a local branch name",
  "--profile": "full or syntax-only",
  "--scope": "a non-empty path without null bytes",
} as const;
const querySwitches = ["--refresh-cache", "--prepared-only", "--stream"];

type OptionName = keyof typeof queryValues;

const isOptionName = (value: string): value is OptionName =>
  Object.hasOwn(queryValues, value);

const record = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
};

const acceptedKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
  problems: string[],
): void => {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    problems.push(`${label} takes only these keys: ${keys.join(", ")}.`);
};

const text = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
};

type Check = <A>(parse: () => A) => A | undefined;

const relationshipPlan = (
  value: readonly unknown[],
  check: Check,
  problems: string[],
): readonly RelationshipRequest[] => {
  const ids = new Set<string>();
  const plan: RelationshipRequest[] = [];
  for (const [index, item] of value.entries()) {
    const label = `--relationship-plan[${index}]`;
    const relationship = check(() => record(item, label));
    if (relationship === undefined) continue;
    acceptedKeys(
      relationship,
      [
        "request_id",
        "focus",
        "relation",
        "selection",
        "direction",
        "depth",
        "limit",
        "summary",
      ],
      label,
      problems,
    );

    const id = check(() =>
      text(relationship.request_id, `${label}.request_id`),
    );
    if (id !== undefined) {
      if (ids.has(id)) problems.push(`${label}.request_id must be unique.`);
      ids.add(id);
    }

    const focusLabel = `${label}.focus`;
    const focus = check(() => record(relationship.focus, focusLabel));
    let selector: RelationshipRequest["focus"] | undefined;
    if (focus !== undefined) {
      acceptedKeys(
        focus,
        ["symbol", "path", "line", "symbol_kind", "qualified_name"],
        focusLabel,
        problems,
      );
      const symbol = check(() => text(focus.symbol, `${focusLabel}.symbol`));
      const pathLabel = `${focusLabel}.path`;
      const path =
        focus.path === undefined
          ? undefined
          : check(() => sourcePath(text(focus.path, pathLabel), pathLabel));
      const line = focus.line;
      const lineValid =
        line === undefined ||
        (typeof line === "number" && Number.isSafeInteger(line) && line > 0);
      if (!lineValid)
        problems.push(`${focusLabel}.line must be a positive integer.`);
      if (line !== undefined && focus.path === undefined)
        problems.push(`${focusLabel}.line requires focus.path.`);
      const symbolKind =
        focus.symbol_kind === undefined
          ? undefined
          : check(() => text(focus.symbol_kind, `${focusLabel}.symbol_kind`));
      const qualifiedName =
        focus.qualified_name === undefined
          ? undefined
          : check(() =>
              text(focus.qualified_name, `${focusLabel}.qualified_name`),
            );
      if (
        (focus.symbol_kind === undefined) !==
        (focus.qualified_name === undefined)
      )
        problems.push(
          `${focusLabel}.symbol_kind and focus.qualified_name must appear together.`,
        );
      if (symbol !== undefined && lineValid)
        selector = {
          symbol,
          ...(path === undefined
            ? {}
            : { path, ...(line === undefined ? {} : { line }) }),
          ...(symbolKind === undefined || qualifiedName === undefined
            ? {}
            : { symbolKind, qualifiedName }),
        };
    }

    const relation = check(() =>
      text(relationship.relation, `${label}.relation`),
    );
    const { selection, direction, depth, limit, summary } = relationship;
    const selectionValid = selection === "exact" || selection === "family";
    const directionValid = direction === "in" || direction === "out";
    const summaryValid = summary === undefined || summary === "frontier";
    const limitValid =
      typeof limit === "number" && Number.isSafeInteger(limit) && limit > 0;
    if (!selectionValid)
      problems.push(`${label}.selection must be exact or family.`);
    if (!directionValid) problems.push(`${label}.direction must be in or out.`);
    if (!summaryValid)
      problems.push(`${label}.summary must be frontier when present.`);
    if (depth !== 1) problems.push(`${label}.depth must be 1.`);
    if (!limitValid)
      problems.push(`${label}.limit must be a positive integer.`);
    if (
      id !== undefined &&
      selector !== undefined &&
      relation !== undefined &&
      selectionValid &&
      directionValid &&
      summaryValid &&
      depth === 1 &&
      limitValid
    )
      plan.push({
        id,
        focus: selector,
        relation,
        selection,
        direction,
        depth,
        limit,
        ...(summary === undefined ? {} : { summary }),
      });
  }
  return plan;
};

export const QUERY_DEFAULTS = {
  "--repo": () => {
    const cwd = process.cwd();
    const git = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
      cwd,
      stderr: "ignore",
    });
    if (!git.success)
      throw new Error(
        `The current folder ${JSON.stringify(cwd)} is outside a Git repository. --repo takes an absolute path to a repository.`,
      );
    return git.stdout.toString().replace(/\r?\n$/, "");
  },
  "--relationship-plan": [],
  "--max-results": 8,
  "--max-context-bytes": 16_000,
} as const;

type AssumedQueryOptions = Readonly<
  Partial<{
    "--repo": string;
    "--relationship-plan": (typeof QUERY_DEFAULTS)["--relationship-plan"];
    "--max-results": number;
    "--max-context-bytes": number;
  }>
>;

export type QueryInvocation = Readonly<{
  request: QueryRequest & Readonly<{ branch?: string }>;
  output: "json" | "ndjson";
  assumedOptions?: AssumedQueryOptions;
}>;

export const assumedRepositoryLine = (repository: string) =>
  `--repo was assumed to be ${JSON.stringify(repository)}. Pass --repo to choose another repository.`;

export const parseQueryInvocation = (
  args: readonly string[],
): QueryInvocation => {
  const values = new Map<OptionName, string>();
  const seen = new Set<string>();
  const scope: string[] = [];
  const problems: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index]!;

    const takesValue = isOptionName(name);
    if (!takesValue && !querySwitches.includes(name)) {
      const value = args[index + 1];
      const hasValue =
        name.startsWith("--") && value !== undefined && !value.startsWith("--");
      if (hasValue) index += 1;
      problems.push(unknownOptionRefusal(name, "neuve query"));
      continue;
    }
    const duplicate = seen.has(name) && name !== "--scope";
    if (duplicate)
      problems.push(
        `${name} takes one occurrence, but was supplied more than once.`,
      );
    seen.add(name);
    if (!takesValue) continue;

    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      if (name !== "--revision" && name !== "--question")
        problems.push(
          `${argumentRefusal(name, queryValues[name])} No value was supplied.`,
        );
      continue;
    }
    index += 1;
    if (name === "--scope") {
      if (value.length === 0 || value.includes("\0"))
        problems.push("--scope must be a non-empty path without null bytes.");
      else scope.push(value);
    } else if (!values.has(name)) {
      values.set(name, value);
    }
  }

  const check: Check = (parse) => {
    try {
      return parse();
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      problems.push(error.message);
      return undefined;
    }
  };
  const preparedOnly = seen.has("--prepared-only");
  const refreshCache = seen.has("--refresh-cache");
  if (refreshCache && preparedOnly)
    problems.push(
      "--prepared-only and --refresh-cache were both supplied. Use only one.",
    );

  const profile = values.get("--profile");
  if (profile !== undefined && profile !== "full" && profile !== "syntax-only")
    problems.push(argumentRefusal("--profile", queryValues["--profile"]));
  if (profile === "syntax-only" && !preparedOnly)
    problems.push(
      "--profile requires --prepared-only for syntax-only. Use full without it.",
    );

  const repo = values.get("--repo");
  const maxResults = values.get("--max-results");
  const maxContextBytes = values.get("--max-context-bytes");
  const relationships = values.get("--relationship-plan");
  const branch = values.get("--branch");
  const question = values.get("--question");
  const repository = check(() =>
    repositoryPath(repo ?? QUERY_DEFAULTS["--repo"]()),
  );
  const commit = check(() => revision(values.get("--revision"), preparedOnly));
  if (question === undefined || question.trim().length === 0)
    problems.push(
      argumentRefusal("--question", queryValues["--question"]) +
        (question === undefined ? " No value was supplied." : ""),
    );
  if (branch !== undefined && branch.trim().length === 0)
    problems.push(argumentRefusal("--branch", queryValues["--branch"]));
  const count = check(() =>
    maxResults === undefined
      ? QUERY_DEFAULTS["--max-results"]
      : positiveInteger(maxResults, "--max-results"),
  );
  const bytes = check(() =>
    maxContextBytes === undefined
      ? QUERY_DEFAULTS["--max-context-bytes"]
      : positiveInteger(maxContextBytes, "--max-context-bytes"),
  );
  const plan = check(() => {
    if (relationships === undefined)
      return QUERY_DEFAULTS["--relationship-plan"];
    let parsed: unknown;
    try {
      parsed = JSON.parse(relationships);
    } catch {}
    if (!Array.isArray(parsed))
      throw new Error("--relationship-plan takes a JSON array.");
    return relationshipPlan(parsed, check, problems);
  });
  if (
    problems.length > 0 ||
    repository === undefined ||
    commit === undefined ||
    question === undefined ||
    count === undefined ||
    bytes === undefined ||
    plan === undefined
  ) {
    if (repo === undefined && repository !== undefined)
      problems.push(assumedRepositoryLine(repository));
    throw new Error(problems.join("\n"));
  }

  const assumedOptions: AssumedQueryOptions = {
    ...(repo === undefined ? { "--repo": repository } : {}),
    ...(relationships === undefined
      ? { "--relationship-plan": QUERY_DEFAULTS["--relationship-plan"] }
      : {}),
    ...(maxResults === undefined ? { "--max-results": count } : {}),
    ...(maxContextBytes === undefined ? { "--max-context-bytes": bytes } : {}),
  };
  return {
    output: seen.has("--stream") ? "ndjson" : "json",
    ...(Object.keys(assumedOptions).length === 0 ? {} : { assumedOptions }),
    request: {
      repository,
      revision: commit,
      question,
      maxResults: count,
      maxContextBytes: bytes,
      relationships: plan,
      ...(scope.length === 0 ? {} : { scope }),
      ...(branch === undefined ? {} : { branch }),
      ...(profile === "full" || profile === "syntax-only" ? { profile } : {}),
      ...(preparedOnly
        ? { cache: "prepared" }
        : refreshCache
          ? { cache: "refresh" }
          : {}),
    },
  };
};

export const parseQueryRequest = (
  args: readonly string[],
): QueryInvocation["request"] => parseQueryInvocation(args).request;
