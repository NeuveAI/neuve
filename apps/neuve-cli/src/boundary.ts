import { resolve } from "node:path";
import type {
  QueryRequest,
  RelationshipRequest,
  RepositoryPath,
  Revision,
  SourcePath,
} from "./domain.ts";
import { argumentRefusal } from "./records-cli.ts";

const positiveInteger = (raw: string, name: string): number => {
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(argumentRefusal(name, "a positive integer", raw));
  }
  return value;
};

const repositoryPath = (raw: string): RepositoryPath => {
  if (!raw.startsWith("/") || raw.includes("\0")) {
    throw new Error(
      argumentRefusal("--repo", "an absolute path without null bytes", raw),
    );
  }
  return resolve(raw) as RepositoryPath;
};

const revision = (raw: string | undefined, preparedOnly: boolean): Revision => {
  const pattern = preparedOnly
    ? /^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/
    : /^[0-9a-fA-F]{7,64}$/;
  if (raw === undefined || !pattern.test(raw)) {
    throw new Error(
      argumentRefusal(
        "--revision",
        preparedOnly
          ? "an exact full commit OID with --prepared-only"
          : "a hexadecimal Git object name",
        raw,
      ),
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

const relationshipPlan = (
  value: readonly unknown[],
): readonly RelationshipRequest[] => {
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
      problems.push(
        `Unknown query option ${JSON.stringify(name)}${hasValue ? ` with value ${JSON.stringify(value)}` : ""}. Run neuve query --help for accepted options.`,
      );
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
      if (name === "--scope") problems.push("--scope requires a value.");
      else if (name !== "--revision" && name !== "--question")
        problems.push(argumentRefusal(name, queryValues[name], undefined));
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

  const check = <A>(parse: () => A): A | undefined => {
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
    problems.push(
      argumentRefusal("--profile", queryValues["--profile"], profile),
    );
  if (profile === "syntax-only" && !preparedOnly)
    problems.push(
      '--profile "syntax-only" requires --prepared-only, which was omitted.',
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
      argumentRefusal("--question", queryValues["--question"], question),
    );
  if (branch !== undefined && branch.trim().length === 0)
    problems.push(argumentRefusal("--branch", queryValues["--branch"], branch));
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
      throw new Error(
        argumentRefusal(
          "--relationship-plan",
          queryValues["--relationship-plan"],
          relationships,
        ),
      );
    try {
      return relationshipPlan(parsed);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      throw new Error(
        `${error.message} Received ${JSON.stringify(relationships)}.`,
      );
    }
  });
  if (
    problems.length > 0 ||
    repository === undefined ||
    commit === undefined ||
    question === undefined ||
    count === undefined ||
    bytes === undefined ||
    plan === undefined
  )
    throw new Error(problems.join("\n"));

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
