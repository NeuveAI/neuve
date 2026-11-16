type JsonRecord = Readonly<Record<string, unknown>>;

export type CommandEvidence = Readonly<{
  stage?: string;
  argv: readonly string[];
  cwd: string;
  environment?: Readonly<Record<string, string>>;
  stdout: string;
  stderr: string;
  exit_code: number;
}>;

export const externalValidationEvaluatorSourcePaths = [
  "packages/evaluation/scripts/verify-external-neuve-effect.ts",
  "apps/neuve-cli/src/boundary.ts",
  "apps/neuve-cli/src/domain.ts",
  "apps/neuve-cli/src/graph-query.ts",
  "packages/graph-client/src/domain.ts",
  "packages/graph-client/src/index.ts",
  "packages/graph-client/src/parse.ts",
  "packages/evaluation/src/external-validation-case.ts",
  "packages/evaluation/src/external-validation-evaluator.ts",
  "packages/evaluation/src/external-validation-report.ts",
  "packages/evaluation/src/external-validation-stages.ts",
  "packages/evaluation/src/observe-native-graph-preload.ts",
  "packages/evaluation/src/external-validation-suite.ts",
  "packages/evaluation/src/neuve-build.ts",
  "packages/evaluation/src/operational-fork-marker.ts",
];

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const pathBoundaryBefore = new Set([
  "\t",
  "\n",
  "\r",
  " ",
  '"',
  "'",
  "(",
  ",",
  ":",
  "<",
  "=",
  "[",
  "{",
  "`",
]);

const pathBoundaryAfter = new Set([
  "\t",
  "\n",
  "\r",
  " ",
  '"',
  "'",
  "(",
  ")",
  ",",
  "/",
  ":",
  ";",
  "<",
  ">",
  "[",
  "]",
  "\\",
  "{",
  "}",
  "`",
]);

const replaceRegisteredPaths = (
  value: string,
  substitutions: readonly (readonly [string, string])[],
): string => {
  let cursor = 0;
  let normalized = "";
  while (cursor < value.length) {
    let selected:
      | Readonly<{ match: number; source: string; replacement: string }>
      | undefined;
    for (const [source, replacement] of substitutions) {
      if (source.length === 0) continue;
      const match = value.indexOf(source, cursor);
      if (match === -1 || (selected !== undefined && match >= selected.match)) {
        continue;
      }
      selected = { match, source, replacement };
    }
    if (selected === undefined) return normalized + value.slice(cursor);
    const { match, source, replacement } = selected;
    const before = value[match - 1];
    const after = value[match + source.length];
    const startsAtBoundary =
      before === undefined || pathBoundaryBefore.has(before);
    const endsAtBoundary = after === undefined || pathBoundaryAfter.has(after);
    normalized += value.slice(cursor, match);
    normalized += startsAtBoundary && endsAtBoundary ? replacement : source;
    cursor = match + source.length;
  }
  return normalized;
};

const normalizeString = (
  value: string,
  substitutions: ReadonlyMap<string, string>,
): string => {
  let normalized = value;
  const ordered = [...substitutions].sort(
    ([left], [right]) => right.length - left.length,
  );
  return replaceRegisteredPaths(normalized, ordered);
};

const normalizeBuildSummary = (value: string): string =>
  value
    .replace(
      /^\s*\[\d+(?:\.\d+)?(?:ms|s)\]\s+bundle\s+(\d+)\s+modules$/gm,
      "[<build-telemetry>] bundle $1 modules",
    )
    .replace(
      /^\s*\[\d+(?:\.\d+)?(?:ms|s)\]\s+compile\s+([^\n]+)$/gm,
      "[<build-telemetry>] compile $1",
    );

const normalizeInstallSummary = (value: string): string =>
  value.replace(
    /\[(?:\d+(?:\.\d+)?)(?:ms|s)\](?=\s*$)/m,
    "[<install-telemetry>]",
  );

const telemetryKeys = new Set([
  "index_latency_ms",
  "indexLatencyMs",
  "preselect_latency_ms",
  "query_latency_ms",
  "search_latency_ms",
  "total_latency_ms",
]);

const normalizeJsonStreamValue = (
  value: unknown,
  substitutions: ReadonlyMap<string, string>,
): unknown => {
  if (typeof value === "string") return normalizeString(value, substitutions);
  if (Array.isArray(value)) {
    return value.map((item) => normalizeJsonStreamValue(item, substitutions));
  }
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    result[key] = telemetryKeys.has(key)
      ? "<telemetry>"
      : normalizeJsonStreamValue(value[key], substitutions);
  }
  return result;
};

const normalizeCommandStream = (
  value: string,
  substitutions: ReadonlyMap<string, string>,
  install: boolean,
): string => {
  const pathNormalized = normalizeString(value, substitutions);
  try {
    const parsed: unknown = JSON.parse(pathNormalized);
    const suffix = pathNormalized.endsWith("\n") ? "\n" : "";
    return `${JSON.stringify(normalizeJsonStreamValue(parsed, substitutions))}${suffix}`;
  } catch {
    return normalizeBuildSummary(
      install ? normalizeInstallSummary(pathNormalized) : pathNormalized,
    );
  }
};

const isCommandEvidence = (value: JsonRecord): boolean =>
  Array.isArray(value.argv) &&
  value.argv.every((item) => typeof item === "string") &&
  typeof value.cwd === "string" &&
  typeof value.stdout === "string" &&
  typeof value.stderr === "string" &&
  typeof value.exit_code === "number";

export const normalizeExternalValidationReport = (
  value: unknown,
  substitutions: ReadonlyMap<string, string>,
): unknown => {
  if (typeof value === "string") return normalizeString(value, substitutions);
  if (Array.isArray(value)) {
    return value.map((item) =>
      normalizeExternalValidationReport(item, substitutions),
    );
  }
  if (!isRecord(value)) return value;
  if (isCommandEvidence(value)) {
    const argv = value.argv;
    const cwd = value.cwd;
    const stdout = value.stdout;
    const stderr = value.stderr;
    if (
      !Array.isArray(argv) ||
      !argv.every((item) => typeof item === "string") ||
      typeof cwd !== "string" ||
      typeof stdout !== "string" ||
      typeof stderr !== "string"
    ) {
      throw new Error("Command evidence changed after validation.");
    }
    return {
      ...(typeof value.stage === "string" ? { stage: value.stage } : {}),
      argv: argv.map((item) => normalizeString(item, substitutions)),
      cwd: normalizeString(cwd, substitutions),
      ...(isRecord(value.environment)
        ? {
            environment: Object.fromEntries(
              Object.entries(value.environment)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([key, item]) => [
                  key,
                  typeof item === "string"
                    ? normalizeString(item, substitutions)
                    : item,
                ]),
            ),
          }
        : {}),
      exit_code: value.exit_code,
      stderr: normalizeCommandStream(
        stderr,
        substitutions,
        argv[0] === "bun" && argv[1] === "install",
      ),
      stdout: normalizeCommandStream(
        stdout,
        substitutions,
        argv[0] === "bun" && argv[1] === "install",
      ),
    };
  }
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    result[key] = telemetryKeys.has(key)
      ? "<telemetry>"
      : normalizeExternalValidationReport(value[key], substitutions);
  }
  return result;
};
