import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Data, Schema } from "effect";

import type {
  FullRevision,
  GraphCapabilities,
  GraphCacheObservation,
  GraphCacheDeclaration,
  GraphStoreUsage,
  GraphSearchStats,
  GraphServiceStats,
  GraphDiagnostic,
  GraphEndpoint,
  GraphEvidence,
  GraphFrontierSummary,
  GraphLocation,
  GraphProviderSymbolId,
  GraphQueryResult,
  GraphQueryObservation,
  GraphProfile,
  GraphPreparedRead,
  GraphSyntaxGenerationSelection,
  GraphGenerationPreparation,
  GraphReadQualification,
  GraphRelationObservation,
  SourcePath,
  SourceRange,
} from "./domain.ts";

type JsonRecord = Readonly<Record<string, unknown>>;

const digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const preparedFields = {
  policy_id: digest,
  producer_build_id: digest,
  source: Schema.Struct({ common_dir: Schema.String, scope: Schema.String }),
  external_policy_origin: Schema.Literal("serving-directory-captured"),
  gitignore_origin: Schema.Literal("target-commit"),
};
const PreparedRead = Schema.Union([
  Schema.Struct({
    ...preparedFields,
    artifact_family: Schema.Literal("syntax-generation"),
    generation_id: digest,
  }),
  Schema.Struct({
    ...preparedFields,
    artifact_family: Schema.Literal("search-snapshot"),
    generation_id: Schema.optionalKey(Schema.Never),
  }),
]);

export class PreparedReceiptError extends Data.TaggedError(
  "PreparedReceiptError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export type PreparedQualification = Readonly<{
  commonDirectory: string;
  scope: string;
  producerBuildId: string;
}>;

export const parsePreparedRead = (
  root: JsonRecord,
  profile: GraphProfile,
  expected: PreparedQualification,
): GraphPreparedRead => {
  let value: typeof PreparedRead.Type;
  try {
    value = Schema.decodeUnknownSync(PreparedRead)(root.prepared_read);
  } catch (cause) {
    throw new PreparedReceiptError({
      message: "Invalid prepared receipt.",
      cause,
    });
  }
  if (
    value.producer_build_id !== expected.producerBuildId ||
    value.source.common_dir !== expected.commonDirectory ||
    value.source.scope !== expected.scope ||
    (value.artifact_family === "syntax-generation" && profile !== "syntax-only")
  ) {
    throw new PreparedReceiptError({
      message: "Prepared receipt qualification mismatch.",
    });
  }
  const common = {
    policyId: value.policy_id,
    producerBuildId: value.producer_build_id,
    source: {
      commonDirectory: value.source.common_dir,
      scope: value.source.scope,
    },
    externalPolicyOrigin: value.external_policy_origin,
    gitignoreOrigin: value.gitignore_origin,
  };
  return value.artifact_family === "syntax-generation"
    ? {
        ...common,
        artifactFamily: value.artifact_family,
        generationId: value.generation_id,
      }
    : { ...common, artifactFamily: value.artifact_family };
};

// This constructor is deliberately private to the raw provider boundary. The validated string may
// be preserved or compared downstream, but no caller can manufacture or interpret provider IDs.
const graphProviderSymbolId = (value: string): GraphProviderSymbolId =>
  value as GraphProviderSymbolId;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const record = (value: unknown, label: string): JsonRecord => {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  return value;
};

const required = (owner: JsonRecord, key: string, label: string): unknown => {
  if (!(key in owner)) throw new Error(`${label}.${key} is required.`);
  return owner[key];
};

export const text = (owner: JsonRecord, key: string, label: string): string => {
  const value = required(owner, key, label);
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label}.${key} must be a non-empty string.`);
  }
  return value;
};

const optionalText = (
  owner: JsonRecord,
  key: string,
  label: string,
): string | undefined => {
  if (!(key in owner)) return undefined;
  const value = owner[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label}.${key} must be a non-empty string when present.`);
  }
  return value;
};

const nullableText = (
  owner: JsonRecord,
  key: string,
  label: string,
): string | null => {
  const value = required(owner, key, label);
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label}.${key} must be null or a non-empty string.`);
  }
  return value;
};

const number = (owner: JsonRecord, key: string, label: string): number => {
  const value = required(owner, key, label);
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label}.${key} must be a finite number.`);
  }
  return value;
};

const nonNegativeInteger = (
  owner: JsonRecord,
  key: string,
  label: string,
): number => {
  const value = number(owner, key, label);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label}.${key} must be a non-negative integer.`);
  }
  return value;
};

const positiveInteger = (
  owner: JsonRecord,
  key: string,
  label: string,
): number => {
  const value = number(owner, key, label);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label}.${key} must be a positive integer.`);
  }
  return value;
};

const optionalPositiveInteger = (
  owner: JsonRecord,
  key: string,
  label: string,
): number | undefined =>
  !(key in owner) ? undefined : positiveInteger(owner, key, label);

const boolean = (owner: JsonRecord, key: string, label: string): boolean => {
  const value = required(owner, key, label);
  if (typeof value !== "boolean") {
    throw new Error(`${label}.${key} must be boolean.`);
  }
  return value;
};

const optionalBoolean = (
  owner: JsonRecord,
  key: string,
  label: string,
): boolean => (!(key in owner) ? false : boolean(owner, key, label));

const optionalNonNegativeInteger = (
  owner: JsonRecord,
  key: string,
  label: string,
): number => (!(key in owner) ? 0 : nonNegativeInteger(owner, key, label));

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

const optionalList = (
  owner: JsonRecord,
  key: string,
  label: string,
): readonly unknown[] => (!(key in owner) ? [] : list(owner, key, label));

const stringList = (
  owner: JsonRecord,
  key: string,
  label: string,
): readonly string[] =>
  list(owner, key, label).map((value, index) => {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`${label}.${key}[${index}] must be a non-empty string.`);
    }
    return value;
  });

const stringListRecord = (
  owner: JsonRecord,
  key: string,
  label: string,
): Readonly<Record<string, readonly string[]>> => {
  const value = record(required(owner, key, label), `${label}.${key}`);
  return Object.fromEntries(
    Object.entries(value).map(([name, item]) => {
      if (!Array.isArray(item)) {
        throw new Error(`${label}.${key}.${name} must be an array.`);
      }
      const values = item.map((entry, index) => {
        if (typeof entry !== "string" || entry.length === 0) {
          throw new Error(
            `${label}.${key}.${name}[${index}] must be a non-empty string.`,
          );
        }
        return entry;
      });
      return [name, values];
    }),
  );
};

const booleanRecord = (
  owner: JsonRecord,
  key: string,
  label: string,
): Readonly<Record<string, boolean>> => {
  const value = record(required(owner, key, label), `${label}.${key}`);
  return Object.fromEntries(
    Object.entries(value).map(([name, item]) => {
      if (typeof item !== "boolean") {
        throw new Error(`${label}.${key}.${name} must be boolean.`);
      }
      return [name, item];
    }),
  );
};

const stringRecord = (
  owner: JsonRecord,
  key: string,
  label: string,
): Readonly<Record<string, string>> => {
  const value = record(required(owner, key, label), `${label}.${key}`);
  return Object.fromEntries(
    Object.entries(value).map(([name, item]) => {
      if (typeof item !== "string" || item.length === 0) {
        throw new Error(`${label}.${key}.${name} must be a non-empty string.`);
      }
      return [name, item];
    }),
  );
};

const sourcePath = (value: string, label: string): SourcePath => {
  if (
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    value
      .split("/")
      .some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw new Error(`${label} must be a repository-relative source path.`);
  }
  return value as SourcePath;
};

export const fullRevision = (value: string, label: string): FullRevision => {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) {
    throw new Error(`${label} must be a full lowercase Git object name.`);
  }
  return value as FullRevision;
};

const range = (owner: JsonRecord, label: string): SourceRange => {
  const startLine = positiveInteger(owner, "start_line", label);
  const endLine = positiveInteger(owner, "end_line", label);
  if (endLine < startLine)
    throw new Error(`${label} must have an ordered line range.`);
  return {
    kind: "range",
    path: sourcePath(text(owner, "file_path", label), `${label}.file_path`),
    startLine,
    endLine,
  };
};

const location = (owner: JsonRecord, label: string): GraphLocation => {
  const filePath = optionalText(owner, "file_path", label);
  const hasStart = "start_line" in owner;
  const hasEnd = "end_line" in owner;
  if (filePath === undefined && !hasStart && !hasEnd) {
    return { kind: "absent" };
  }
  if (filePath === undefined || (!hasStart && hasEnd)) {
    throw new Error(
      `${label} must associate line bounds with a source path when present.`,
    );
  }
  const path = sourcePath(filePath, `${label}.file_path`);
  if (!hasStart) return { kind: "path", path };
  const startLine = positiveInteger(owner, "start_line", label);
  if (!hasEnd) return { kind: "point", path, line: startLine };
  const endLine = positiveInteger(owner, "end_line", label);
  if (endLine < startLine)
    throw new Error(`${label} must have an ordered line range.`);
  return { kind: "range", path, startLine, endLine };
};

const diagnostics = (
  values: readonly unknown[],
  label: string,
): readonly GraphDiagnostic[] =>
  values.map((value, index) => {
    const itemLabel = `${label}[${index}]`;
    if (typeof value === "string") {
      if (value.length === 0)
        throw new Error(`${itemLabel} must not be empty.`);
      return { kind: "message", message: value };
    }
    const item = record(value, itemLabel);
    const filePath = optionalText(item, "file_path", itemLabel);
    const language = optionalText(item, "language", itemLabel);
    const detail = optionalText(item, "detail", itemLabel);
    return {
      kind: "provider",
      code: text(item, "code", itemLabel),
      severity: text(item, "severity", itemLabel),
      ...(filePath === undefined
        ? {}
        : { filePath: sourcePath(filePath, `${itemLabel}.file_path`) }),
      ...(language === undefined ? {} : { language }),
      effectOnCompleteness: text(
        item,
        "effect_on_semantic_completeness",
        itemLabel,
      ),
      ...(detail === undefined ? {} : { detail }),
    };
  });

export const parseJson = (source: string, label: string): unknown => {
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(
      `${label} did not return JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

export const parseVersion = (
  value: unknown,
): Readonly<{
  provider: "entire-graph";
  version: string;
  identityRevision: string;
  buildIdentity: string | null;
}> => {
  const root = record(value, "Neuve Graph version");
  if (text(root, "provider", "Neuve Graph version") !== "entire-graph") {
    throw new Error("Neuve Graph version.provider must be entire-graph.");
  }
  const buildIdentity = optionalText(
    root,
    "build_identity",
    "Neuve Graph version",
  );
  if (buildIdentity !== undefined && !/^[0-9a-f]{64}$/.test(buildIdentity)) {
    throw new Error(
      "Neuve Graph version.build_identity must be a lowercase SHA256 digest.",
    );
  }
  return {
    provider: "entire-graph",
    version: text(root, "version", "Neuve Graph version"),
    identityRevision: text(root, "identity_revision", "Neuve Graph version"),
    buildIdentity: buildIdentity ?? null,
  };
};

const parseCache = (
  root: JsonRecord,
  label: string,
): GraphCacheObservation => ({
  ...(optionalText(root, "analysis_scope", label) === "complete-prepared"
    ? { analysisScope: "complete-prepared" as const }
    : {}),
  status:
    "index_cache_hit" in root
      ? boolean(root, "index_cache_hit", label)
        ? "hit"
        : "miss"
      : "unreported",
  indexLatencyMs:
    "index_latency_ms" in root
      ? nonNegativeInteger(root, "index_latency_ms", label)
      : null,
});

/** Graph's search `stats` fields that `GraphSearchStats` carries, by their engine names. */
const SEARCH_STAT_COUNTS = [
  ["preselectLatencyMs", "preselect_latency_ms"],
  ["queryLatencyMs", "query_latency_ms"],
  ["totalLatencyMs", "total_latency_ms"],
  ["preselectionPasses", "preselection_passes"],
  ["preselectionFilesExamined", "preselection_files_examined"],
  ["preselectionFilesRead", "files_content_read_during_preselection"],
  ["preselectionPatterns", "preselection_patterns"],
  ["preselectionBlobsRead", "preselection_blobs_read"],
  ["preselectionBytesRead", "preselection_bytes_read"],
  ["answerCacheHits", "answer_cache_hits"],
  ["answerCacheMisses", "answer_cache_misses"],
  ["answerCacheWaits", "answer_cache_waits"],
  ["textIndexLookups", "text_index_lookups"],
  ["textIndexCandidates", "text_index_candidates"],
] as const satisfies ReadonlyArray<readonly [keyof GraphSearchStats, string]>;

const parseSearchStats = (
  stats: JsonRecord,
  label: string,
): GraphSearchStats => {
  const parsed: {
    -readonly [K in keyof GraphSearchStats]: GraphSearchStats[K];
  } = {};
  for (const [field, key] of SEARCH_STAT_COUNTS)
    if (key in stats) parsed[field] = nonNegativeInteger(stats, key, label);
  const backend = optionalText(stats, "preselection_backend", label);
  if (backend !== undefined) parsed.preselectionBackend = backend;
  const fallback = optionalText(stats, "preselection_fallback_reason", label);
  if (fallback !== undefined) parsed.preselectionFallbackReason = fallback;
  return parsed;
};

/**
 * The shared service's block under `owner` (a read's `stats`, or an `index` receipt's top level),
 * when the engine reports one. Older engines report none, and every field but `answered` may be
 * absent (snapshots_held and snapshots_limit when zero, a plan's cache size, a read's lane).
 */
const parseServiceStats = (
  owner: JsonRecord,
  label: string,
): GraphServiceStats | undefined => {
  if (!("service" in owner)) return undefined;
  const at = `${label}.service`;
  const service = record(owner["service"], at);
  const parsed: {
    -readonly [K in keyof GraphServiceStats]: GraphServiceStats[K];
  } = { answered: boolean(service, "answered", at) };
  const reason = optionalText(service, "reason", at);
  if (reason !== undefined) parsed.reason = reason;
  const lane = optionalText(service, "lane", at);
  if (lane !== undefined) parsed.lane = lane;
  for (const [field, key] of [
    ["rssBytes", "rss_bytes"],
    ["maxRssBytes", "max_rss_bytes"],
    ["snapshotsHeld", "snapshots_held"],
    ["snapshotsLimit", "snapshots_limit"],
    ["cacheBytes", "cache_bytes"],
    ["cacheCapBytes", "cache_cap_bytes"],
  ] as const)
    if (key in service) parsed[field] = nonNegativeInteger(service, key, at);
  for (const [field, key] of [
    ["cpuUserMs", "cpu_user_ms"],
    ["cpuSystemMs", "cpu_system_ms"],
    ["queueWaitMs", "queue_wait_ms"],
  ] as const)
    if (key in service) parsed[field] = nonNegativeNumber(service, key, at);
  if ("snapshot_hit" in service)
    parsed.snapshotHit = boolean(service, "snapshot_hit", at);
  const queueClass = optionalText(service, "class", at);
  if (queueClass !== undefined) parsed.class = queueClass;
  if ("kept_answer" in service)
    parsed.keptAnswer = boolean(service, "kept_answer", at);
  if ("moved_up" in service) parsed.movedUp = boolean(service, "moved_up", at);
  if ("cpu_shared" in service)
    parsed.cpuShared = boolean(service, "cpu_shared", at);
  return parsed;
};

const nonNegativeNumber = (
  owner: JsonRecord,
  key: string,
  label: string,
): number => {
  const value = number(owner, key, label);
  if (!Number.isFinite(value) || value < 0)
    throw new Error(`${label}.${key} must be a non-negative number.`);
  return value;
};

export const parseRefresh = (
  value: unknown,
  expectedRepository: string,
  expectedRevision: FullRevision,
  expectedTree: FullRevision,
  expectedVersion: string,
): void => {
  const label = "Neuve Graph cache refresh";
  const root = record(value, label);
  if (number(root, "format_version", label) !== 1) {
    throw new Error(`${label}.format_version must be 1.`);
  }
  verifyProvenance(
    root,
    label,
    expectedRepository,
    expectedRevision,
    expectedTree,
  );
  if (
    text(root, "provider", label) !== "entire-graph" ||
    text(root, "provider_version", label) !== expectedVersion ||
    text(root, "profile", label) !== "full"
  ) {
    throw new Error(
      `${label} provider, version and profile must match the inspection.`,
    );
  }
  if (parseCache(root, label).status !== "miss") {
    throw new Error(`${label} must report a rebuilt snapshot.`);
  }
};

/** A bounded Graph store's `cache` block; a present malformed field is refused. */
export const parseStoreUsage = (
  value: unknown,
  label: string,
): GraphStoreUsage => {
  const usage = record(value, label);
  const families = record(usage["families"] ?? {}, `${label}.families`);
  const free = number(usage, "free_bytes", label);
  if (!Number.isSafeInteger(free) || free < -1)
    throw new Error(
      `${label}.free_bytes must be a byte count, or -1 when unknown.`,
    );
  const measuredAt = optionalText(usage, "measured_at", label);
  return {
    bytes: nonNegativeInteger(usage, "bytes", label),
    capBytes: nonNegativeInteger(usage, "cap_bytes", label),
    minFreeBytes: nonNegativeInteger(usage, "min_free_bytes", label),
    ...(free === -1 ? {} : { freeBytes: free }),
    declaredBytes: nonNegativeInteger(usage, "declared_bytes", label),
    pinnedBytes: nonNegativeInteger(usage, "pinned_bytes", label),
    families: Object.fromEntries(
      Object.keys(families).map((family) => [
        family,
        nonNegativeInteger(families, family, `${label}.families`),
      ]),
    ),
    evictedBytes: nonNegativeInteger(usage, "evicted_bytes", label),
    evictedEntries: nonNegativeInteger(usage, "evicted_entries", label),
    ...(measuredAt === undefined ? {} : { measuredAt }),
  };
};

/** `cache declare`'s receipt: the declared set must be the one asked for. */
export const parseCacheDeclaration = (
  value: unknown,
  expectedCommits: readonly string[],
): GraphCacheDeclaration => {
  const label = "Neuve Graph cache declaration";
  const root = record(value, label);
  if (number(root, "format_version", label) !== 1)
    throw new Error(`${label}.format_version must be 1.`);
  if (text(root, "action", label) !== "declare")
    throw new Error(`${label}.action must be declare.`);
  const declared = record(root["declared"], `${label}.declared`);
  const oids = (key: string) => {
    const list = declared[key] ?? [];
    if (!Array.isArray(list))
      throw new Error(`${label}.declared.${key} must be a list.`);
    return list.map((oid, at) =>
      fullRevision(oid, `${label}.declared.${key}[${at}]`),
    );
  };
  const commits = oids("commits");
  if (!isDeepStrictEqual([...commits].sort(), [...expectedCommits].sort()))
    throw new Error(`${label} declared other commits than were asked for.`);
  return {
    commits,
    trees: oids("trees"),
    usage: parseStoreUsage(root["cache"], `${label}.cache`),
  };
};

/**
 * The receipt of `index --head --profile full` for an exact commit: provenance, provider, version,
 * profile and cache state are checked; a hit (the tree was already prepared) and a miss (it was
 * built now) are both valid preparations. Counts are optional provider telemetry.
 */
export const parseSnapshotPreparation = (
  value: unknown,
  expectedRepository: string,
  expectedRevision: FullRevision,
  expectedTree: FullRevision,
  expectedVersion: string,
): Readonly<{
  cache: GraphCacheObservation;
  store?: GraphStoreUsage;
  service?: GraphServiceStats;
  counts: Readonly<{
    files: number | null;
    symbols: number | null;
    relations: number | null;
    partialFailures: number | null;
    completeness: string | null;
  }>;
}> => {
  const label = "Neuve Graph snapshot preparation";
  const root = record(value, label);
  if (number(root, "format_version", label) !== 1) {
    throw new Error(`${label}.format_version must be 1.`);
  }
  verifyProvenance(
    root,
    label,
    expectedRepository,
    expectedRevision,
    expectedTree,
  );
  if (
    text(root, "provider", label) !== "entire-graph" ||
    text(root, "provider_version", label) !== expectedVersion ||
    text(root, "profile", label) !== "full"
  ) {
    throw new Error(
      `${label} provider, version and profile must match the request.`,
    );
  }
  const cache = parseCache(root, label);
  if (cache.status === "unreported") {
    throw new Error(
      `${label} must report whether the snapshot was reused or built.`,
    );
  }
  const counts = isRecord(root.counts) ? root.counts : {};
  const count = (key: string) =>
    key in counts ? nonNegativeInteger(counts, key, `${label}.counts`) : null;
  const service = parseServiceStats(root, label);
  return {
    cache,
    ...("cache" in root
      ? { store: parseStoreUsage(root["cache"], `${label}.cache`) }
      : {}),
    ...(service === undefined ? {} : { service }),
    counts: {
      files: count("files"),
      symbols: count("symbols"),
      relations: count("relations"),
      partialFailures: count("partial_failures"),
      completeness:
        optionalText(counts, "completeness_level", `${label}.counts`) ?? null,
    },
  };
};

export const parsePreparation = (
  value: unknown,
  expected: Readonly<{
    repository: string;
    revision: FullRevision;
    tree: FullRevision;
    version: string;
    qualification: PreparedQualification;
    generation?: string;
  }>,
): Readonly<{
  root: JsonRecord;
  selection: GraphSyntaxGenerationSelection;
  service?: GraphServiceStats;
}> => {
  const label = "Neuve Graph preparation";
  const root = record(value, label);
  if (
    number(root, "format_version", label) !== 1 ||
    text(root, "provider", label) !== "entire-graph" ||
    text(root, "provider_version", label) !== expected.version ||
    text(root, "profile", label) !== "syntax-only"
  )
    throw new PreparedReceiptError({
      message: "Preparation envelope mismatch.",
    });
  verifyProvenance(
    root,
    label,
    expected.repository,
    expected.revision,
    expected.tree,
  );
  const selection = parsePreparedRead(
    root,
    "syntax-only",
    expected.qualification,
  );
  if (
    selection.artifactFamily !== "syntax-generation" ||
    (expected.generation !== undefined &&
      selection.generationId !== expected.generation)
  )
    throw new PreparedReceiptError({
      message: "Preparation selection mismatch.",
    });
  const service = parseServiceStats(root, label);
  return { root, selection, ...(service === undefined ? {} : { service }) };
};

export const parsePreparationAvailability = (
  root: JsonRecord,
): "ready" | "absent" => {
  const label = "Neuve Graph preparation plan";
  const plan = record(root.preparation_plan, label);
  const availability = text(plan, "availability", label);
  if (availability !== "ready" && availability !== "absent")
    throw new PreparedReceiptError({
      message: "Invalid preparation availability.",
    });
  if (
    [
      "counts",
      "completeness",
      "incremental_preparation",
      "index_cache_hit",
    ].some((key) => key in root)
  )
    throw new PreparedReceiptError({
      message: "Preparation plan cannot report performed work.",
    });
  return availability;
};

export const parsePreparationWork = (
  root: JsonRecord,
  selection: GraphSyntaxGenerationSelection,
): Pick<
  GraphGenerationPreparation,
  "work" | "coverage" | "warnings" | "partialFailures"
> => {
  const label = "Neuve Graph preparation work";
  const work = record(root.incremental_preparation, label);
  if (
    text(work, "generation_id", label) !== selection.generationId ||
    "preparation_plan" in root
  )
    throw new PreparedReceiptError({
      message: "Preparation work selection mismatch.",
    });
  const relations = stringList(work, "supported_relation_types", label);
  if (
    new Set(relations).size !== relations.length ||
    relations.some((value) => value !== "DEFINES" && value !== "CONTAINS")
  )
    throw new PreparedReceiptError({
      message: "Unsupported syntax-generation relation coverage.",
    });
  const completeness = record(root.completeness, label);
  const health = record(completeness.health, label);
  return {
    coverage: text(health, "status", label),
    warnings: diagnostics(list(root, "warnings", label), label),
    partialFailures: diagnostics(list(root, "partial_failures", label), label),
    work: {
      alreadyPublished: boolean(root, "index_cache_hit", label),
      extractedFiles: nonNegativeInteger(work, "extracted_files", label),
      reusedFiles: nonNegativeInteger(work, "reused_files", label),
      uncacheableFiles: nonNegativeInteger(work, "uncacheable_files", label),
      supportedRelationTypes: relations,
      relationshipResolution: text(work, "relationship_resolution", label),
      unchangedContentIdentification: text(
        work,
        "unchanged_content_identification",
        label,
      ),
      sourceEnumeration: text(work, "source_enumeration", label),
    },
  };
};

export const parseCapabilities = (value: unknown): GraphCapabilities => {
  const root = record(value, "Neuve Graph capabilities");
  const schemaVersion = text(
    root,
    "schema_version",
    "Neuve Graph capabilities",
  );
  if (!/^1\.\d+$/.test(schemaVersion)) {
    throw new Error(
      "Neuve Graph capabilities.schema_version must be compatible with 1.x.",
    );
  }
  if (text(root, "provider", "Neuve Graph capabilities") !== "entire-graph") {
    throw new Error("Neuve Graph capabilities.provider must be entire-graph.");
  }
  const modes =
    "relation_selection_modes" in root
      ? stringList(root, "relation_selection_modes", "Neuve Graph capabilities")
      : [];
  const relationSelectionModes: ("exact" | "family")[] = [];
  for (const mode of modes) {
    if (mode !== "exact" && mode !== "family")
      throw new Error(
        "Neuve Graph capabilities.relation_selection_modes contains an invalid mode.",
      );
    if (relationSelectionModes.includes(mode))
      throw new Error(
        "Neuve Graph capabilities.relation_selection_modes contains a duplicate mode.",
      );
    relationSelectionModes.push(mode);
  }
  const relationFamilies =
    "relation_families" in root
      ? stringListRecord(root, "relation_families", "Neuve Graph capabilities")
      : {};
  const supportedRelations = stringList(
    root,
    "supported_relation_types",
    "Neuve Graph capabilities",
  );
  for (const [relation, members] of Object.entries(relationFamilies)) {
    if (
      !supportedRelations.includes(relation) ||
      members.length === 0 ||
      !members.includes(relation) ||
      new Set(members).size !== members.length ||
      members.some((member) => !supportedRelations.includes(member))
    )
      throw new Error(
        "Neuve Graph capabilities.relation_families contains an invalid family.",
      );
  }
  if (
    relationSelectionModes.includes("family") &&
    supportedRelations.some(
      (relation) => relationFamilies[relation] === undefined,
    )
  )
    throw new Error(
      "Neuve Graph capabilities.relation_families must declare every supported relation.",
    );
  return {
    relationSelectionModes,
    relationFamilies,
    schemaVersion,
    supportedFileExtensions: stringList(
      root,
      "supported_file_extensions",
      "Neuve Graph capabilities",
    ),
    supportedLanguages: stringList(
      root,
      "supported_languages",
      "Neuve Graph capabilities",
    ),
    semanticLanguages: stringList(
      root,
      "semantic_languages",
      "Neuve Graph capabilities",
    ),
    inventoryOnlyLanguages: stringList(
      root,
      "inventory_only_languages",
      "Neuve Graph capabilities",
    ),
    supportedRelationTypes: stringList(
      root,
      "supported_relation_types",
      "Neuve Graph capabilities",
    ),
    relationSupportByLanguage: stringListRecord(
      root,
      "relation_support_by_language",
      "Neuve Graph capabilities",
    ),
    relationSupportByProfile: stringListRecord(
      root,
      "relation_support_by_profile",
      "Neuve Graph capabilities",
    ),
    heuristicRelationTypes: stringList(
      root,
      "heuristic_relation_types",
      "Neuve Graph capabilities",
    ),
    parserVersions: stringRecord(
      root,
      "parser_versions",
      "Neuve Graph capabilities",
    ),
    unsupportedButDetectedLanguageHints: stringList(
      root,
      "unsupported_but_detected_language_hints",
      "Neuve Graph capabilities",
    ),
    optionalLocalOnlyFeatures: booleanRecord(
      root,
      "optional_local_only_features",
      "Neuve Graph capabilities",
    ),
    featuresRequiringNetworkAccess: booleanRecord(
      root,
      "features_requiring_network_access",
      "Neuve Graph capabilities",
    ),
  };
};

/**
 * The languages each optional feature covers (`feature_languages` of `capabilities --json`), kept
 * apart from `GraphCapabilities` so every observation that publishes the provider stays as it was.
 * An engine that does not report it covers no language by declaration.
 */
export const parseFeatureLanguages = (
  value: unknown,
): Readonly<Record<string, readonly string[]>> => {
  const root = record(value, "Neuve Graph capabilities");
  return "feature_languages" in root && root.feature_languages !== null
    ? stringListRecord(root, "feature_languages", "Neuve Graph capabilities")
    : {};
};

export const verifyProvenance = (
  root: JsonRecord,
  label: string,
  expectedRepository: string,
  expectedRevision: FullRevision,
  expectedTree: FullRevision,
): void => {
  const observedRepository = resolve(text(root, "repo_root", label));
  if (observedRepository !== resolve(expectedRepository)) {
    throw new Error(
      `${label}.repo_root ${observedRepository} does not match isolated view ${resolve(expectedRepository)}.`,
    );
  }
  const observedRevision = fullRevision(
    text(root, "commit", label),
    `${label}.commit`,
  );
  if (observedRevision !== expectedRevision) {
    throw new Error(
      `${label}.commit ${observedRevision} does not match requested revision ${expectedRevision}.`,
    );
  }
  const observedTree = fullRevision(text(root, "tree", label), `${label}.tree`);
  if (observedTree !== expectedTree) {
    throw new Error(
      `${label}.tree ${observedTree} does not match requested tree ${expectedTree}.`,
    );
  }
};

export const parseQuery = (
  value: unknown,
  expectedRepository: string,
  expectedRevision: FullRevision,
  expectedTree: FullRevision,
  expectedQuestion: string,
  requestedLimits: Readonly<{ topK: number; maxContextBytes: number }>,
  expectedProfile: GraphProfile = "full",
  preparedQualification?: PreparedQualification,
): GraphQueryObservation => {
  const label = "Neuve Graph query";
  const root = record(value, label);
  if (number(root, "format_version", label) !== 1) {
    throw new Error(`${label}.format_version must be 1.`);
  }
  verifyProvenance(
    root,
    label,
    expectedRepository,
    expectedRevision,
    expectedTree,
  );
  if (text(root, "query", label) !== expectedQuestion) {
    throw new Error(
      `${label}.query does not match the unchanged requested question.`,
    );
  }
  if (text(root, "profile", label) !== expectedProfile) {
    if (preparedQualification !== undefined) {
      throw new PreparedReceiptError({
        message: `${label}.profile must match the requested profile.`,
      });
    }
    throw new Error(`${label}.profile must match the requested profile.`);
  }
  const completeness = record(
    required(root, "completeness", label),
    `${label}.completeness`,
  );
  const health = record(
    required(completeness, "health", `${label}.completeness`),
    `${label}.completeness.health`,
  );
  const stats = record(required(root, "stats", label), `${label}.stats`);
  const containedStatus = optionalText(
    stats,
    "contained_callables_status",
    `${label}.stats`,
  );
  if (
    containedStatus !== undefined &&
    containedStatus !== "complete" &&
    containedStatus !== "truncated"
  ) {
    throw new Error(
      `${label}.stats.contained_callables_status must be complete or truncated.`,
    );
  }
  const rawResults = list(root, "results", label);
  const resultRecords = rawResults.map((value, index) => {
    const itemLabel = `${label}.results[${index}]`;
    const item = record(value, itemLabel);
    if (positiveInteger(item, "rank", itemLabel) !== index + 1) {
      throw new Error(`${label}.results ranks must be contiguous from 1.`);
    }
    return item;
  });
  const topLevelProviderIds = new Set(
    resultRecords.flatMap((item, index) => {
      const providerId = optionalText(
        item,
        "symbol_id",
        `${label}.results[${index}]`,
      );
      return providerId === undefined ? [] : [providerId];
    }),
  );
  const rawDropLedger = optionalList(
    stats,
    "contained_callables_dropped_by_result",
    `${label}.stats`,
  );
  if (
    containedStatus === undefined &&
    ("contained_callables_emitted" in stats ||
      "contained_callables_dropped_by_budget" in stats ||
      "contained_callables_dropped_by_result" in stats)
  ) {
    throw new Error(
      `${label}.stats contained callable counters require a support status.`,
    );
  }
  const expectedContainedEmitted =
    containedStatus === undefined
      ? 0
      : nonNegativeInteger(
          stats,
          "contained_callables_emitted",
          `${label}.stats`,
        );
  const expectedContainedDropped =
    containedStatus === undefined
      ? 0
      : nonNegativeInteger(
          stats,
          "contained_callables_dropped_by_budget",
          `${label}.stats`,
        );
  const droppedByRank = new Map<number, number>();
  let previousDroppedRank = 0;
  let observedContainedDropped = 0;
  for (const [index, value] of rawDropLedger.entries()) {
    const dropLabel = `${label}.stats.contained_callables_dropped_by_result[${index}]`;
    const drop = record(value, dropLabel);
    const rank = positiveInteger(drop, "rank", dropLabel);
    const dropped = positiveInteger(drop, "dropped", dropLabel);
    if (rank <= previousDroppedRank || rank > resultRecords.length) {
      throw new Error(
        `${label}.stats contained callable omission ranks must be ascending, unique, and identify returned results.`,
      );
    }
    droppedByRank.set(rank, dropped);
    previousDroppedRank = rank;
    observedContainedDropped += dropped;
  }
  let observedContainedEmitted = 0;
  const seenContainedProviderIds = new Set<string>();
  const results = resultRecords.map((item, index) => {
    const itemLabel = `${label}.results[${index}]`;
    const source = range(item, itemLabel);
    const language = optionalText(item, "language", itemLabel) ?? null;
    const symbol = optionalText(item, "symbol_name", itemLabel);
    const symbolKind = optionalText(item, "kind", itemLabel);
    const qualifiedName = optionalText(item, "qualified_name", itemLabel);
    let parsed: GraphQueryResult;
    if (
      symbol === undefined &&
      symbolKind === undefined &&
      qualifiedName === undefined
    ) {
      parsed = { kind: "region" as const, language, source };
    } else if (
      symbol !== undefined &&
      symbolKind !== undefined &&
      qualifiedName !== undefined
    ) {
      parsed = {
        kind: "symbol" as const,
        language,
        source,
        symbol,
        symbolKind,
        qualifiedName,
      };
    } else {
      const shared = { kind: "partial_symbol" as const, language, source };
      if (symbol !== undefined && symbolKind !== undefined) {
        parsed = { ...shared, symbol, symbolKind };
      } else if (symbol !== undefined && qualifiedName !== undefined) {
        parsed = { ...shared, symbol, qualifiedName };
      } else if (symbolKind !== undefined && qualifiedName !== undefined) {
        parsed = { ...shared, symbolKind, qualifiedName };
      } else if (symbol !== undefined) {
        parsed = { ...shared, symbol };
      } else if (symbolKind !== undefined) {
        parsed = { ...shared, symbolKind };
      } else if (qualifiedName !== undefined) {
        parsed = { ...shared, qualifiedName };
      } else {
        throw new Error(`${itemLabel} partial symbol metadata disappeared.`);
      }
    }

    const rawContained = optionalList(item, "contained_callables", itemLabel);
    if (containedStatus === undefined) {
      if (rawContained.length > 0) {
        throw new Error(
          `${itemLabel} contained callables require an available response status.`,
        );
      }
      return {
        ...parsed,
        containedCallables: { kind: "unavailable" as const },
      };
    }
    const snippetStart = positiveInteger(item, "snippet_start_line", itemLabel);
    const snippetEnd = positiveInteger(item, "snippet_end_line", itemLabel);
    let previousContained:
      | Readonly<{ startLine: number; endLine: number; providerId: string }>
      | undefined;
    const contained = rawContained.map((entry, containedIndex) => {
      const containedLabel = `${itemLabel}.contained_callables[${containedIndex}]`;
      const callable = record(entry, containedLabel);
      const startLine = positiveInteger(callable, "start_line", containedLabel);
      const endLine = positiveInteger(callable, "end_line", containedLabel);
      if (
        endLine < startLine ||
        startLine < snippetStart ||
        endLine > snippetEnd
      ) {
        throw new Error(
          `${containedLabel} range must be ordered and contained by the owning snippet.`,
        );
      }
      const rawProviderId = text(callable, "symbol_id", containedLabel);
      if (
        topLevelProviderIds.has(rawProviderId) ||
        seenContainedProviderIds.has(rawProviderId)
      ) {
        throw new Error(
          `${containedLabel}.symbol_id must be unique and must not identify a top-level result.`,
        );
      }
      if (
        previousContained !== undefined &&
        (startLine < previousContained.startLine ||
          (startLine === previousContained.startLine &&
            endLine < previousContained.endLine) ||
          (startLine === previousContained.startLine &&
            endLine === previousContained.endLine &&
            rawProviderId <= previousContained.providerId))
      ) {
        throw new Error(
          `${itemLabel}.contained_callables must be in stable range and provider identity order.`,
        );
      }
      previousContained = { startLine, endLine, providerId: rawProviderId };
      seenContainedProviderIds.add(rawProviderId);
      observedContainedEmitted++;
      return {
        providerId: graphProviderSymbolId(rawProviderId),
        kind: "symbol" as const,
        language: optionalText(callable, "language", containedLabel) ?? null,
        source: {
          kind: "range" as const,
          path: source.path,
          startLine,
          endLine,
        },
        symbol: text(callable, "symbol_name", containedLabel),
        symbolKind: text(callable, "kind", containedLabel),
        qualifiedName: text(callable, "qualified_name", containedLabel),
      };
    });
    const dropped = droppedByRank.get(index + 1) ?? 0;
    return {
      ...parsed,
      containedCallables:
        dropped > 0
          ? { kind: "truncated" as const, items: contained, dropped }
          : { kind: "complete" as const, items: contained },
    };
  });
  if (
    observedContainedEmitted !== expectedContainedEmitted ||
    observedContainedDropped !== expectedContainedDropped
  ) {
    throw new Error(
      `${label} contained callable result counts do not match provider stats.`,
    );
  }
  if (
    (containedStatus === "complete" && expectedContainedDropped !== 0) ||
    (containedStatus === "truncated" && expectedContainedDropped === 0) ||
    (containedStatus === "complete" && rawDropLedger.length > 0)
  ) {
    throw new Error(
      `${label} contained callable status contradicts its counts.`,
    );
  }
  const observation: Omit<GraphQueryObservation, "profile" | "preparedRead"> = {
    coverage: text(health, "status", `${label}.completeness.health`),
    cache: parseCache(stats, `${label}.stats`),
    stats: parseSearchStats(stats, `${label}.stats`),
    ...(() => {
      const service = parseServiceStats(stats, `${label}.stats`);
      return service === undefined ? {} : { service };
    })(),
    indexedFileCount:
      "files_indexed" in stats
        ? nonNegativeInteger(stats, "files_indexed", `${label}.stats`)
        : null,
    containedCallableCoverage: containedStatus ?? "unavailable",
    warnings: diagnostics(
      optionalList(root, "warnings", label),
      `${label}.warnings`,
    ),
    partialFailures: diagnostics(
      list(root, "partial_failures", label),
      `${label}.partial_failures`,
    ),
    results,
    budget: {
      requestedTopK: requestedLimits.topK,
      requestedMaxContextBytes: requestedLimits.maxContextBytes,
      returnedResults: results.length,
      providerContextBudgetBytes: optionalNonNegativeInteger(
        stats,
        "context_budget_bytes",
        `${label}.stats`,
      ),
      providerResultBytes: optionalNonNegativeInteger(
        stats,
        "result_bytes",
        `${label}.stats`,
      ),
      queryConstraintsTruncated: optionalBoolean(
        stats,
        "query_constraints_truncated",
        `${label}.stats`,
      ),
      resultsDroppedByBudget: optionalNonNegativeInteger(
        stats,
        "results_dropped_by_budget",
        `${label}.stats`,
      ),
      snippetsTruncatedByBudget: optionalNonNegativeInteger(
        stats,
        "snippets_truncated_by_budget",
        `${label}.stats`,
      ),
    },
    limitations: [],
  };
  if (preparedQualification === undefined) return observation;
  return {
    ...observation,
    profile: expectedProfile,
    preparedRead: parsePreparedRead(
      root,
      expectedProfile,
      preparedQualification,
    ),
  };
};

const endpoint = (value: unknown, label: string): GraphEndpoint => {
  const item = record(value, label);
  const externalValue =
    "external" in item ? boolean(item, "external", label) : false;
  const qualifiedName = optionalText(item, "qualified_name", label);
  const symbolKind = optionalText(item, "kind", label);
  const language = optionalText(item, "language", label);
  const parsedLocation = location(item, label);
  return {
    id: text(item, "id", label),
    name: text(item, "name", label),
    ...(qualifiedName === undefined ? {} : { qualifiedName }),
    ...(symbolKind === undefined ? {} : { symbolKind }),
    ...(language === undefined ? {} : { language }),
    location: parsedLocation,
    external: externalValue,
  };
};

const evidence = (value: unknown, label: string): GraphEvidence => {
  const item = record(value, label);
  const parsedLocation = location(item, label);
  const detail = optionalText(item, "detail", label);
  return {
    kind: text(item, "kind", label),
    location: parsedLocation,
    ...(detail === undefined ? {} : { detail }),
  };
};

export type ParsedNeighborEnvelope = Readonly<{
  cache: GraphCacheObservation;
  service?: GraphServiceStats;
  matches: readonly Readonly<{
    symbol: GraphEndpoint;
    observations: readonly GraphRelationObservation[];
  }>[];
  truncated: boolean;
  focusMatchesTruncated: boolean;
  disambiguationRequired: boolean;
  warnings: readonly GraphDiagnostic[];
  partialFailures: readonly GraphDiagnostic[];
  summary?: Exclude<
    GraphFrontierSummary,
    Readonly<{ kind: "unavailable"; reason: "unsupported_provider" }>
  >;
}> &
  GraphReadQualification;

type ParsedProviderFrontierSummary = NonNullable<
  ParsedNeighborEnvelope["summary"]
>;

const parseFrontierSummary = (
  value: unknown,
  expected: Readonly<{
    selection: "exact" | "family";
    selectedRelations: readonly string[];
    direction: "in" | "out";
    indexedCoverage: string;
    truncated: boolean;
  }>,
): ParsedProviderFrontierSummary => {
  const label = "Neuve Graph neighbors.summary";
  const summary = record(value, label);
  if (text(summary, "mode", label) !== "frontier") {
    throw new Error(`${label}.mode must be frontier.`);
  }
  if (text(summary, "selection", label) !== expected.selection) {
    throw new Error(`${label}.selection does not match the request.`);
  }
  const selectedRelations = stringList(summary, "selected_relations", label);
  if (
    selectedRelations.length !== expected.selectedRelations.length ||
    selectedRelations.some(
      (relation, index) => relation !== expected.selectedRelations[index],
    )
  ) {
    throw new Error(`${label}.selected_relations does not match the request.`);
  }
  if (text(summary, "direction", label) !== expected.direction) {
    throw new Error(`${label}.direction does not match the request.`);
  }
  if (positiveInteger(summary, "depth", label) !== 1) {
    throw new Error(`${label}.depth must be 1.`);
  }
  const indexedCoverage = text(summary, "indexed_coverage", label);
  if (indexedCoverage !== expected.indexedCoverage) {
    throw new Error(
      `${label}.indexed_coverage does not match the enclosing completeness health.`,
    );
  }
  const kind = text(summary, "kind", label);
  if (kind === "unresolved_focus") {
    if ("direct" in summary || "frontier" in summary) {
      throw new Error(
        `${label} unresolved focus must not contain direct or frontier data.`,
      );
    }
    return { kind };
  }
  if (kind !== "observed") {
    throw new Error(`${label}.kind must be unresolved_focus or observed.`);
  }
  const directValue = record(
    required(summary, "direct", label),
    `${label}.direct`,
  );
  const eligibleEdges = nonNegativeInteger(
    directValue,
    "eligible_edges",
    `${label}.direct`,
  );
  const emittedEdges = nonNegativeInteger(
    directValue,
    "emitted_edges",
    `${label}.direct`,
  );
  const omittedEdges = nonNegativeInteger(
    directValue,
    "omitted_edges",
    `${label}.direct`,
  );
  const missingEndpointEdges = nonNegativeInteger(
    directValue,
    "missing_endpoint_edges",
    `${label}.direct`,
  );
  if (
    !Number.isSafeInteger(emittedEdges + omittedEdges) ||
    eligibleEdges !== emittedEdges + omittedEdges
  ) {
    throw new Error(
      `${label}.direct eligible edges must equal emitted plus omitted edges.`,
    );
  }
  if (omittedEdges > 0 && !expected.truncated) {
    throw new Error(
      `${label}.direct omitted edges require an enclosing truncated response.`,
    );
  }
  let previousEndpointId: string | undefined;
  const frontier = list(summary, "frontier", label).map((value, index) => {
    const entryLabel = `${label}.frontier[${index}]`;
    const entry = record(value, entryLabel);
    const endpointId = text(entry, "endpoint_id", entryLabel);
    if (previousEndpointId !== undefined && endpointId <= previousEndpointId) {
      throw new Error(
        `${label}.frontier must have unique endpoint ids in ascending order.`,
      );
    }
    previousEndpointId = endpointId;
    const entryKind = text(entry, "kind", entryLabel);
    if (entryKind === "unavailable") {
      if (
        [
          "counts",
          "external_edges",
          "missing_endpoint_edges",
          "returns_to_focus",
          "self_edges",
        ].some((key) => key in entry)
      ) {
        throw new Error(
          `${entryLabel} unavailable endpoint must not contain indexed counts.`,
        );
      }
      const reason = text(entry, "reason", entryLabel);
      if (
        reason !== "external_endpoint" &&
        reason !== "inventory_only_endpoint" &&
        reason !== "unclassified_endpoint"
      ) {
        throw new Error(`${entryLabel}.reason is not supported.`);
      }
      return { kind: entryKind, endpointId, reason } as const;
    }
    if (entryKind !== "indexed") {
      throw new Error(`${entryLabel}.kind must be indexed or unavailable.`);
    }
    if ("reason" in entry) {
      throw new Error(
        `${entryLabel} indexed endpoint must not contain a reason.`,
      );
    }
    let previousCount:
      Readonly<{ relation: string; resolution: string | null }> | undefined;
    let countedEdges = 0;
    const counts = list(entry, "counts", entryLabel).map(
      (countValue, countIndex) => {
        const countLabel = `${entryLabel}.counts[${countIndex}]`;
        const count = record(countValue, countLabel);
        const relation = text(count, "relation", countLabel);
        if (!expected.selectedRelations.includes(relation)) {
          throw new Error(
            `${countLabel}.relation is outside the requested selection.`,
          );
        }
        const resolution = nullableText(count, "resolution", countLabel);
        if (
          previousCount !== undefined &&
          (relation < previousCount.relation ||
            (relation === previousCount.relation &&
              (resolution ?? "") <= (previousCount.resolution ?? "")))
        ) {
          throw new Error(
            `${entryLabel}.counts must be unique and sorted by relation then resolution.`,
          );
        }
        previousCount = { relation, resolution };
        const edges = positiveInteger(count, "edges", countLabel);
        countedEdges += edges;
        if (!Number.isSafeInteger(countedEdges)) {
          throw new Error(`${entryLabel}.counts edge total must be safe.`);
        }
        return { relation, resolution, edges };
      },
    );
    const externalEdges = nonNegativeInteger(
      entry,
      "external_edges",
      entryLabel,
    );
    const frontierMissingEndpointEdges = nonNegativeInteger(
      entry,
      "missing_endpoint_edges",
      entryLabel,
    );
    const returnsToFocus = nonNegativeInteger(
      entry,
      "returns_to_focus",
      entryLabel,
    );
    const selfEdges = nonNegativeInteger(entry, "self_edges", entryLabel);
    if (
      externalEdges > countedEdges ||
      returnsToFocus > countedEdges ||
      selfEdges > countedEdges
    ) {
      throw new Error(
        `${entryLabel} subset counts must not exceed counted edges.`,
      );
    }
    return {
      kind: entryKind,
      endpointId,
      counts,
      externalEdges,
      missingEndpointEdges: frontierMissingEndpointEdges,
      returnsToFocus,
      selfEdges,
    } as const;
  });
  return {
    kind,
    expandedDepth: 1,
    indexedCoverage,
    direct: {
      eligibleEdges,
      emittedEdges,
      omittedEdges,
      missingEndpointEdges,
    },
    frontier,
  };
};

export const parseNeighbors = (
  value: unknown,
  expectedRepository: string,
  expectedRevision: FullRevision,
  expectedTree: FullRevision,
  expected: Readonly<{
    query: string;
    file?: string;
    line?: number;
    relation: string;
    selection: "exact" | "family";
    selectedRelations: readonly string[];
    direction: "in" | "out";
    summary?: "frontier";
  }>,
  expectedProfile: GraphProfile = "full",
  preparedQualification?: PreparedQualification,
): ParsedNeighborEnvelope => {
  const label = "Neuve Graph neighbors";
  const root = record(value, label);
  if (number(root, "format_version", label) !== 1) {
    throw new Error(`${label}.format_version must be 1.`);
  }
  verifyProvenance(
    root,
    label,
    expectedRepository,
    expectedRevision,
    expectedTree,
  );
  if (text(root, "profile", label) !== expectedProfile) {
    if (preparedQualification !== undefined) {
      throw new PreparedReceiptError({
        message: `${label}.profile must match the requested profile.`,
      });
    }
    throw new Error(`${label}.profile must match the requested profile.`);
  }
  if (text(root, "query", label) !== expected.query) {
    throw new Error(`${label}.query does not match ${expected.query}.`);
  }
  const observedFile = optionalText(root, "file", label);
  if (observedFile !== expected.file) {
    throw new Error(
      `${label}.file does not match ${expected.file ?? "the omitted file selector"}.`,
    );
  }
  const observedLine = optionalPositiveInteger(root, "line", label);
  if (observedLine !== expected.line) {
    throw new Error(
      `${label}.line does not match ${expected.line ?? "the omitted line selector"}.`,
    );
  }
  if (text(root, "relation", label) !== expected.relation) {
    throw new Error(`${label}.relation does not match ${expected.relation}.`);
  }
  if (text(root, "selection", label) !== expected.selection)
    throw new Error(`${label}.selection does not match ${expected.selection}.`);
  const selectedRelations = stringList(root, "selected_relations", label);
  if (
    selectedRelations.length !== expected.selectedRelations.length ||
    new Set(selectedRelations).size !== selectedRelations.length ||
    selectedRelations.some(
      (relation) => !expected.selectedRelations.includes(relation),
    )
  )
    throw new Error(
      `${label}.selected_relations does not match the declared selection.`,
    );
  if (text(root, "direction", label) !== expected.direction) {
    throw new Error(`${label}.direction does not match ${expected.direction}.`);
  }
  const matches = list(root, "matches", label).map((value, matchIndex) => {
    const matchLabel = `${label}.matches[${matchIndex}]`;
    const match = record(value, matchLabel);
    const symbol = endpoint(
      required(match, "symbol", matchLabel),
      `${matchLabel}.symbol`,
    );
    if (symbol.external || symbol.location.kind !== "range") {
      throw new Error(
        `${matchLabel}.symbol must be a source-backed internal symbol.`,
      );
    }
    const observations: GraphRelationObservation[] = [];
    for (const direction of ["in", "out"] as const) {
      const values = list(
        match,
        direction === "in" ? "incoming" : "outgoing",
        matchLabel,
      );
      if (direction !== expected.direction && values.length > 0) {
        throw new Error(
          `${matchLabel} contains ${direction} edges for a ${expected.direction} request.`,
        );
      }
      for (const [edgeIndex, edgeValue] of values.entries()) {
        const edgeLabel = `${matchLabel}.${direction === "in" ? "incoming" : "outgoing"}[${edgeIndex}]`;
        const edge = record(edgeValue, edgeLabel);
        const relation = text(edge, "relation", edgeLabel);
        if (!selectedRelations.includes(relation))
          throw new Error(
            `${edgeLabel}.relation is outside the declared selection.`,
          );
        if (text(edge, "direction", edgeLabel) !== direction) {
          throw new Error(
            `${edgeLabel}.direction does not match ${direction}.`,
          );
        }
        const adjacent = endpoint(
          required(edge, "endpoint", edgeLabel),
          `${edgeLabel}.endpoint`,
        );
        const confidence = number(edge, "confidence", edgeLabel);
        if (confidence < 0 || confidence > 1) {
          throw new Error(`${edgeLabel}.confidence must be between 0 and 1.`);
        }
        const resolution = optionalText(edge, "resolution", edgeLabel);
        const reason = optionalText(edge, "reason", edgeLabel);
        const warningCodes =
          "warning_codes" in edge
            ? stringList(edge, "warning_codes", edgeLabel)
            : [];
        const evidenceDropped =
          "evidence_dropped" in edge
            ? nonNegativeInteger(edge, "evidence_dropped", edgeLabel)
            : 0;
        observations.push({
          direction,
          relation,
          from: direction === "out" ? symbol : adjacent,
          to: direction === "out" ? adjacent : symbol,
          confidence,
          ...(resolution === undefined ? {} : { resolution }),
          ...(reason === undefined ? {} : { reason }),
          evidence: optionalList(edge, "evidence", edgeLabel).map(
            (item, index) => evidence(item, `${edgeLabel}.evidence[${index}]`),
          ),
          warningCodes,
          evidenceDropped,
        });
      }
    }
    return { symbol, observations };
  });
  const truncated = boolean(root, "truncated", label);
  let summary: ParsedProviderFrontierSummary | undefined;
  if (expected.summary === "frontier") {
    const completeness = record(
      required(root, "completeness", label),
      `${label}.completeness`,
    );
    const health = record(
      required(completeness, "health", `${label}.completeness`),
      `${label}.completeness.health`,
    );
    summary = parseFrontierSummary(required(root, "summary", label), {
      ...expected,
      indexedCoverage: text(health, "status", `${label}.completeness.health`),
      truncated,
    });
  } else if ("summary" in root) {
    throw new Error(`${label}.summary was not requested.`);
  }
  const observation: Omit<ParsedNeighborEnvelope, "profile" | "preparedRead"> =
    {
      matches,
      cache: parseCache(root, label),
      ...(() => {
        // The shared service's block, in the neighbor read's `stats` when the engine reports it.
        const service =
          "stats" in root
            ? parseServiceStats(
                record(root["stats"], `${label}.stats`),
                `${label}.stats`,
              )
            : undefined;
        return service === undefined ? {} : { service };
      })(),
      truncated,
      focusMatchesTruncated: boolean(root, "focus_matches_truncated", label),
      disambiguationRequired:
        "disambiguation_required" in root
          ? boolean(root, "disambiguation_required", label)
          : false,
      warnings: diagnostics(
        optionalList(root, "warnings", label),
        `${label}.warnings`,
      ),
      partialFailures: diagnostics(
        list(root, "partial_failures", label),
        `${label}.partial_failures`,
      ),
      ...(summary === undefined ? {} : { summary }),
    };
  if (preparedQualification === undefined) return observation;
  return {
    ...observation,
    profile: expectedProfile,
    preparedRead: parsePreparedRead(
      root,
      expectedProfile,
      preparedQualification,
    ),
  };
};
