import { z } from "zod";

declare const repositoryPathBrand: unique symbol;
declare const revisionBrand: unique symbol;
declare const sourcePathBrand: unique symbol;
declare const providerSymbolIdBrand: unique symbol;

export type RepositoryPath = string & {
  readonly [repositoryPathBrand]: "RepositoryPath";
};
export type FullRevision = string & {
  readonly [revisionBrand]: "FullRevision";
};
export type SourcePath = string & { readonly [sourcePathBrand]: "SourcePath" };
export type GraphProviderSymbolId = string & {
  readonly [providerSymbolIdBrand]: "GraphProviderSymbolId";
};

export type GraphDiagnostic =
  | Readonly<{ kind: "message"; message: string }>
  | Readonly<{
      kind: "provider";
      code: string;
      severity: string;
      filePath?: SourcePath;
      language?: string;
      effectOnCompleteness: string;
      detail?: string;
    }>;

export type SourceRange = Readonly<{
  kind: "range";
  path: SourcePath;
  startLine: number;
  endLine: number;
}>;

export type GraphLocation =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "path"; path: SourcePath }>
  | Readonly<{ kind: "point"; path: SourcePath; line: number }>
  | SourceRange;

export type GraphEndpoint = Readonly<{
  id: string;
  name: string;
  qualifiedName?: string;
  symbolKind?: string;
  language?: string;
  location: GraphLocation;
  external: boolean;
}>;

export type GraphEvidence = Readonly<{
  kind: string;
  location: GraphLocation;
  detail?: string;
}>;

export type GraphRelationObservation = Readonly<{
  direction: "in" | "out";
  relation: string;
  from: GraphEndpoint;
  to: GraphEndpoint;
  confidence: number;
  resolution?: string;
  reason?: string;
  evidence: readonly GraphEvidence[];
  warningCodes: readonly string[];
  evidenceDropped: number;
}>;

/*
 * The compact snapshot of one commit, as `readGraphSnapshot` normalizes it (snapshot.ts). The
 * reader builds these records itself after validating each positional row, so the schemas are the
 * contract for consumers that store or re-read them, not a second parse of every row.
 */

const SourcePathSchema = z.custom<SourcePath>(
  (value) => typeof value === "string" && value.length > 0,
);
const lineNumber = z.int().positive();

export const GraphLocationSchema: z.ZodType<GraphLocation> =
  z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("absent") }),
    z.strictObject({ kind: z.literal("path"), path: SourcePathSchema }),
    z.strictObject({
      kind: z.literal("point"),
      path: SourcePathSchema,
      line: lineNumber,
    }),
    z.strictObject({
      kind: z.literal("range"),
      path: SourcePathSchema,
      startLine: lineNumber,
      endLine: lineNumber,
    }),
  ]);

/** A file record: a path the snapshot read, whether or not it was parsed. */
export const GraphSnapshotFile = z.strictObject({
  id: z.string().min(1),
  path: z.string().min(1),
  language: z.string().nullable(),
  bytes: z.int().nonnegative(),
});
export type GraphSnapshotFile = z.infer<typeof GraphSnapshotFile>;

/** A symbol record. The id is opaque: compare it whole, never split it. */
export const GraphSnapshotSymbol = z.strictObject({
  id: z.string().min(1),
  name: z.string(),
  qualifiedName: z.string(),
  kind: z.string().min(1),
  language: z.string(),
  path: z.string().min(1),
  startLine: lineNumber,
  endLine: lineNumber,
  containerId: z.string().nullable(),
  signature: z.string().nullable(),
});
export type GraphSnapshotSymbol = z.infer<typeof GraphSnapshotSymbol>;

/**
 * Where one import specifier resolves in the snapshot's own tree, from an `import_target_*`
 * evidence entry ("Import targets" in Graph's `docs/snapshot-format.md`). `unresolved` means Graph
 * looked and found nothing. A declared package's `name` is the specifier's package part (`@scope/name`
 * or the first segment for TypeScript and JavaScript, the top-level module for Python); it is null
 * for Go, where the engine's rule is the required module that prefixes the path and the stream does
 * not carry the manifest's modules.
 */
export const GraphImportTarget = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("file"), path: SourcePathSchema }),
  z.strictObject({
    kind: z.literal("declared-package"),
    name: z.string().min(1).nullable(),
    manifest: SourcePathSchema,
  }),
  z.strictObject({ kind: z.literal("builtin") }),
  z.strictObject({ kind: z.literal("unresolved") }),
  z.strictObject({ kind: z.literal("not-classified") }),
]);
export type GraphImportTarget = z.infer<typeof GraphImportTarget>;

/** The call-site evidence kinds ("Call-site evidence" in Graph's `docs/snapshot-format.md`). */
export const GRAPH_CALL_SITE_KINDS = [
  "call_site",
  "imported_call_site",
  "async_call_site",
  "top_level_call_site",
] as const;

/**
 * `GraphEvidence` with an explicit null for an absent detail. An `import_target_*` entry also
 * carries its specifier (the detail) and its target, normalized.
 *
 * `form` (schema 1.4) is set only on a call-site entry (`GRAPH_CALL_SITE_KINDS`) with a line, from
 * an engine that declares `call_site_lines`: `reference` says the line hands the target over by name
 * (`xs.map(double)`) and the caller never calls it. Absent, a call or construction is written at
 * that line, for a caller in a language `call_site_lines` lists. `reference` is the one value
 * through schema 1.4 and the reader refuses any other there; under a newer minor another value is
 * passed as written, and a consumer reads it as neither a call nor a reference.
 */
export const GraphSnapshotEvidence = z.strictObject({
  kind: z.string(),
  location: GraphLocationSchema,
  detail: z.string().nullable(),
  importTarget: z
    .strictObject({ specifier: z.string(), target: GraphImportTarget })
    .optional(),
  form: z.string().min(1).optional(),
});
export type GraphSnapshotEvidence = z.infer<typeof GraphSnapshotEvidence>;

/** A relation record. Endpoints are symbol, file or external ids; empty strings read as null. */
export const GraphSnapshotRelation = z.strictObject({
  relation: z.string().min(1),
  fromId: z.string().min(1),
  toId: z.string().min(1),
  targetKind: z.string().nullable(),
  resolution: z.string().nullable(),
  confidence: z.number(),
  scope: z.string().nullable(),
  evidence: z.array(GraphSnapshotEvidence),
  warningCodes: z.array(z.string()),
  evidenceDropped: z.int().nonnegative(),
});
export type GraphSnapshotRelation = z.infer<typeof GraphSnapshotRelation>;

/**
 * What one snapshot read covered, taken from its header and its validated summary. A count here is
 * what Graph read or emitted, never a statement about the code: a symbol with no relation in the
 * snapshot has no evidence, not "no callers".
 */
export const GraphSnapshotCoverage = z.strictObject({
  provider: z.strictObject({
    name: z.literal("entire-graph"),
    version: z.string(),
    identityRevision: z.string(),
    executable: z.strictObject({
      sha256: z.string(),
      buildIdentity: z.enum(["verified", "unreported"]),
    }),
  }),
  /** The engine's symbol-id namespace (`gh/<owner>/<name>` or `local/<basename>`), not an identity. */
  repoKey: z.string(),
  schema: z.strictObject({
    version: z.string(),
    /** The artifact declares a newer minor than this reader knows: additive facts were skipped. */
    newerMinor: z.boolean(),
    /** Rows with a data tag this reader does not know, skipped under a newer minor. */
    skippedRows: z.int().nonnegative(),
  }),
  commit: z.string(),
  tree: z.string(),
  profile: z.literal("full"),
  relationSet: z.array(z.string()),
  skippedRelationFamilies: z.array(z.string()),
  /** Each language present, `semantic` or `inventory-only`, from the summary. */
  languageTiers: z.record(z.string(), z.string()),
  counts: z.strictObject({
    files: z.int().nonnegative(),
    parsedFiles: z.int().nonnegative(),
    symbols: z.int().nonnegative(),
    relations: z.int().nonnegative(),
    externals: z.int().nonnegative(),
  }),
  /** Partial failures folded per file (`path` null for one that names no file), codes unique. */
  partialFailures: z.array(
    z.strictObject({
      path: z.string().nullable(),
      codes: z.array(z.string()),
    }),
  ),
  warnings: z.array(
    z.strictObject({ code: z.string(), count: z.int().positive() }),
  ),
  /** Submodule entries the tree has and the snapshot did not read (`W_SUBMODULE_NOT_READ`). */
  gitlinksNotRead: z.array(
    z.strictObject({ path: z.string(), commit: z.string().nullable() }),
  ),
  /** Go files outside the default build, with no file record (`W_GO_BUILD_EXCLUDED`). */
  goBuildExcluded: z.array(z.strictObject({ path: z.string() })),
  health: z.string().nullable(),
  completenessLevel: z.string(),
  /**
   * Whether the engine declares `import_target_classification`, and for which languages. The reader
   * always writes it; a coverage without it (built by hand, or before it existed) reads as an engine
   * that does not classify.
   */
  importTargets: z
    .union([
      z.strictObject({
        status: z.literal("classified"),
        languages: z.array(z.string()),
      }),
      z.strictObject({ status: z.literal("not-declared") }),
    ])
    .optional(),
  /**
   * The languages `call_site_lines` lists for the engine that wrote this snapshot, taken in the same
   * read from the same frozen copy as `importTargets`; empty when the engine does not declare the
   * key (`d592b44` and older). For a call relation whose caller's file is in one of them, a line on
   * its call-site entry is where the target's name is written in the caller; in any other language,
   * or with an empty list, a symbol caller's line is its own span and a file-level caller has none.
   * The reader always writes it; a coverage without it (built by hand, or before it existed) reads
   * as empty.
   */
  callSiteLineLanguages: z.array(z.string()).optional(),
});
export type GraphSnapshotCoverage = z.infer<typeof GraphSnapshotCoverage>;

export type GraphCapabilityLimitation =
  | Readonly<{
      kind: "unclassified_language";
      subject: "query_result" | "relationship_focus" | "relationship_endpoint";
    }>
  | Readonly<{
      kind: "undeclared_language" | "non_semantic_language";
      subject: "query_result" | "relationship_focus" | "relationship_endpoint";
      language: string;
    }>
  | Readonly<{
      kind: "unsupported_relation_for_language";
      subject: "relationship_focus" | "relationship_endpoint";
      language: string;
      relation: string;
    }>;

type GraphPartialSymbolMetadata =
  | Readonly<{
      symbol: string;
      symbolKind?: never;
      qualifiedName?: never;
    }>
  | Readonly<{
      symbol?: never;
      symbolKind: string;
      qualifiedName?: never;
    }>
  | Readonly<{
      symbol?: never;
      symbolKind?: never;
      qualifiedName: string;
    }>
  | Readonly<{
      symbol: string;
      symbolKind: string;
      qualifiedName?: never;
    }>
  | Readonly<{
      symbol: string;
      symbolKind?: never;
      qualifiedName: string;
    }>
  | Readonly<{
      symbol?: never;
      symbolKind: string;
      qualifiedName: string;
    }>;

export type GraphQueryResult =
  | Readonly<{ kind: "region"; language: string | null; source: SourceRange }>
  | (Readonly<{
      kind: "partial_symbol";
      language: string | null;
      source: SourceRange;
    }> &
      GraphPartialSymbolMetadata)
  | Readonly<{
      kind: "symbol";
      language: string | null;
      source: SourceRange;
      symbol: string;
      symbolKind: string;
      qualifiedName: string;
    }>;

/**
 * Provider-qualified identity for a complete callable already rendered inside
 * its owning primary source snippet. It adds attribution, not duplicate source.
 * The [retrieval context foundation](../../../foundations/11-retrieval-context-and-investigation.md)
 * separates source presence, identity coverage, and proposed allocation changes.
 */
export type GraphContainedCallable = Readonly<{
  providerId: GraphProviderSymbolId;
  kind: "symbol";
  language: string | null;
  source: SourceRange;
  symbol: string;
  symbolKind: string;
  qualifiedName: string;
}>;

/** Source presence does not imply complete identity coverage. Preserve omissions. */
export type GraphContainedCallableManifest =
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{
      kind: "complete";
      items: readonly GraphContainedCallable[];
    }>
  | Readonly<{
      kind: "truncated";
      items: readonly GraphContainedCallable[];
      dropped: number;
    }>;

export type GraphQueryResultWithContainedCallables = GraphQueryResult &
  Readonly<{ containedCallables: GraphContainedCallableManifest }>;

/**
 * Caller-requested limits and provider-reported query-context accounting.
 * Bytes are not model tokens or a cap on the full inspection/event envelope.
 * Result count, byte use, and truncation do not establish evidence sufficiency.
 */
export type GraphQueryBudget = Readonly<{
  requestedTopK: number;
  requestedMaxContextBytes: number;
  returnedResults: number;
  providerContextBudgetBytes: number;
  providerResultBytes: number;
  queryConstraintsTruncated: boolean;
  resultsDroppedByBudget: number;
  snippetsTruncatedByBudget: number;
}>;

/**
 * A provider location the boundary corrected instead of refusing. Only one correction exists: a
 * query result range that ends exactly one line past its file's last line, which the Entire
 * baseline (5637039f) reports for a symbol ending at end of file. The range is clamped to the last
 * line; every other out-of-range location is still refused.
 */
export type GraphLocationNormalization = Readonly<{
  kind: "end-line-past-eof";
  resultIndex: number;
  path: SourcePath;
  reportedEndLine: number;
  endLine: number;
}>;

/**
 * Graph's own account of where one search's time and reads went, from its search `stats`, for
 * telemetry only: nothing ranks or decides on it. Each field is present only when the engine
 * reported it, so an engine that reports none reads as empty. The index phase's latency and cache
 * hit stay on `cache`.
 */
export type GraphSearchStats = Readonly<{
  preselectLatencyMs?: number;
  queryLatencyMs?: number;
  totalLatencyMs?: number;
  /** How candidate files were found, such as a tree scan or the text index; an open set. */
  preselectionBackend?: string;
  /** Why the text index was not used, when a search fell back to scanning; an open set. */
  preselectionFallbackReason?: string;
  preselectionPasses?: number;
  preselectionFilesExamined?: number;
  preselectionFilesRead?: number;
  preselectionPatterns?: number;
  preselectionBlobsRead?: number;
  preselectionBytesRead?: number;
  answerCacheHits?: number;
  answerCacheMisses?: number;
  answerCacheWaits?: number;
  textIndexLookups?: number;
  textIndexCandidates?: number;
}>;

/**
 * The shared Graph service's account of a call, when the engine reports one: a search's
 * `stats.service` block, or the top-level `service` block of an `index` receipt (a preparation or
 * its plan). Whether the service answered it, and if not why (`off`, `busy`, `unavailable` or
 * `mismatch`; an open set), its memory and snapshots, its CPU for the call with its `git`
 * children, and the call's wait in its queue. A preparation the service answered ran as a child
 * process of it: its CPU and memory are that child's alone, exact, and `snapshotHit` is absent
 * (it reads no snapshot). `snapshotHit` is present only when the call looked a snapshot up. Every field but `answered` may be absent. Telemetry only.
 */
export type GraphServiceStats = Readonly<{
  answered: boolean;
  reason?: string;
  /** The service's lane: `prepare` for a preparation's block; absent for a read's. */
  lane?: string;
  rssBytes?: number;
  maxRssBytes?: number;
  snapshotsHeld?: number;
  snapshotsLimit?: number;
  snapshotHit?: boolean;
  cpuUserMs?: number;
  cpuSystemMs?: number;
  queueWaitMs?: number;
  /** The bounded Graph store's size and cap, in bytes, when the service reports them. */
  cacheBytes?: number;
  cacheCapBytes?: number;
  /** The queue's class the call ran in (`interactive` or `background`). */
  class?: string;
  /** True when the service served an answer it kept from an earlier run (its CPU is then 0). */
  keptAnswer?: boolean;
  /** True only for the caller whose class moved an already queued search up. */
  movedUp?: boolean;
  /**
   * True when reads ran at once in the service: cpu* is then this read's estimated share (the
   * engine's CPU over its run divided by the reads running on average, plus its own git
   * children's, which are exact) and `snapshotHit` counts the whole service, so it may be wrong.
   * Absent, cpu* is exact.
   */
  cpuShared?: boolean;
}>;

export type GraphQueryObservation = Readonly<{
  cache: GraphCacheObservation;
  stats: GraphSearchStats;
  /** Present only when the engine reported the shared service's block. */
  service?: GraphServiceStats;
  /** Present only when a result location was normalized. */
  normalizations?: readonly GraphLocationNormalization[];
  /** Provider-reported query population, not exhaustive coverage. Null when absent. */
  indexedFileCount: number | null;
  coverage: string;
  containedCallableCoverage: "unavailable" | "complete" | "truncated";
  warnings: readonly GraphDiagnostic[];
  partialFailures: readonly GraphDiagnostic[];
  results: readonly GraphQueryResultWithContainedCallables[];
  budget: GraphQueryBudget;
  limitations: readonly GraphCapabilityLimitation[];
}> &
  GraphReadQualification;

export type GraphFocus =
  | Readonly<{ kind: "not_found" }>
  | Readonly<{
      kind: "ambiguous";
      matches: readonly GraphEndpoint[];
      matchesTruncated: boolean;
    }>
  | Readonly<{ kind: "resolved"; symbol: GraphEndpoint }>;

/** One provider-selected relationship-record count at a retained boundary. */
export type GraphFrontierCount = Readonly<{
  relation: string;
  resolution: string | null;
  edges: number;
}>;

export type GraphFrontierEndpoint =
  | Readonly<{
      kind: "indexed";
      endpointId: GraphEndpoint["id"];
      counts: readonly GraphFrontierCount[];
      externalEdges: number;
      missingEndpointEdges: number;
      returnsToFocus: number;
      selfEdges: number;
    }>
  | Readonly<{
      kind: "unavailable";
      endpointId: GraphEndpoint["id"];
      reason:
        | "external_endpoint"
        | "inventory_only_endpoint"
        | "unclassified_endpoint";
    }>;

export type GraphFrontierSummary =
  | Readonly<{ kind: "unavailable"; reason: "unsupported_provider" }>
  | Readonly<{ kind: "unresolved_focus" }>
  | Readonly<{
      kind: "observed";
      expandedDepth: 1;
      indexedCoverage: string;
      direct: Readonly<{
        eligibleEdges: number;
        emittedEdges: number;
        omittedEdges: number;
        missingEndpointEdges: number;
      }>;
      frontier: readonly GraphFrontierEndpoint[];
    }>;

type GraphFrontierSummaryExtension =
  Readonly<{ summary?: never }> | Readonly<{ summary: GraphFrontierSummary }>;

type GraphRelationshipObservationBase = Readonly<{
  cache: GraphCacheObservation;
  /** Present only when the engine reported the shared service's block for the neighbor read. */
  service?: GraphServiceStats;
  selection: "exact" | "family";
  selectedRelations: readonly string[];
  focus: GraphFocus;
  observations: readonly GraphRelationObservation[];
  truncated: boolean;
  focusMatchesTruncated: boolean;
  warnings: readonly GraphDiagnostic[];
  partialFailures: readonly GraphDiagnostic[];
  limitations: readonly GraphCapabilityLimitation[];
}> &
  GraphReadQualification;

export type GraphRelationshipObservation = GraphRelationshipObservationBase &
  GraphFrontierSummaryExtension;

export type GraphPreparedFailureReason =
  | "unsupported-provider"
  | "unconfirmed-prepared-read"
  | "incompatible-read-options"
  | "source-unavailable"
  | "policy-unavailable"
  | "artifact-unavailable"
  | "missing"
  | "invalid-artifact"
  | "incompatible-artifact"
  | "revision-not-prepared"
  | "source-changed-during-read";

export type GraphProfile = "full" | "syntax-only";

export type GraphReadQualification =
  | Readonly<{ profile?: never; preparedRead?: never }>
  | Readonly<{ profile: GraphProfile; preparedRead: GraphPreparedRead }>;

export type GraphPreparedRead = Readonly<{
  policyId: string;
  producerBuildId: string;
  source: Readonly<{ commonDirectory: string; scope: string }>;
  externalPolicyOrigin: "serving-directory-captured";
  gitignoreOrigin: "target-commit";
}> &
  (
    | Readonly<{ artifactFamily: "syntax-generation"; generationId: string }>
    | Readonly<{ artifactFamily: "search-snapshot"; generationId?: never }>
  );

export type GraphSyntaxGenerationSelection = Extract<
  GraphPreparedRead,
  { artifactFamily: "syntax-generation" }
>;

/**
 * The bounded Graph store's account of its cache folder (an index's `cache` block, or a `cache`
 * command's), in bytes: as last measured, and what the measuring prune removed. `freeBytes` is
 * absent when the engine could not tell the folder's free space.
 */
export type GraphStoreUsage = Readonly<{
  bytes: number;
  capBytes: number;
  minFreeBytes: number;
  freeBytes?: number;
  declaredBytes: number;
  pinnedBytes: number;
  families: Readonly<Record<string, number>>;
  evictedBytes: number;
  evictedEntries: number;
  measuredAt?: string;
}>;

/** The bases the store now keeps whatever their last use, as `cache declare` replaced them. */
export type GraphCacheDeclaration = Readonly<{
  commits: readonly FullRevision[];
  trees: readonly FullRevision[];
  usage: GraphStoreUsage;
}>;

export type GraphPreparationRequest = Readonly<{
  executable: string;
  repository: string;
  revision: string;
}>;

/** The provider an executable reports, observed through a frozen copy of it. */
export type GraphProviderObservation = GraphInspection["provider"];

/**
 * A complete full-profile committed-tree snapshot for an exact commit, prepared so later
 * `cache: "prepared"` reads with `profile: "full"` can read it by commit. The engine indexes the
 * committed tree at HEAD, so the repository's HEAD must already be that commit; nothing is checked
 * out and no worktree is created.
 */
export type GraphSnapshotPreparation = Readonly<{
  provider: GraphProviderObservation;
  source: GraphInspection["source"] & Readonly<{ tree: FullRevision }>;
  profile: "full";
  cache: GraphCacheObservation;
  /** Present only when the engine reported its bounded store's `cache` block. */
  store?: GraphStoreUsage;
  /** Present only when the engine reported the shared service's block (the setting on). */
  service?: GraphServiceStats;
  counts: Readonly<{
    files: number | null;
    symbols: number | null;
    relations: number | null;
    partialFailures: number | null;
    completeness: string | null;
  }>;
}>;

export type GraphPreparationPlan = Readonly<{
  provider: GraphInspection["provider"];
  source: GraphInspection["source"] & Readonly<{ tree: FullRevision }>;
  profile: "syntax-only";
  selection: GraphSyntaxGenerationSelection;
  availability: "ready" | "absent";
  /**
   * Present only when the engine reported the shared service's block (the setting on). A plan's
   * never has the cache's size.
   */
  service?: GraphServiceStats;
}>;

export type GraphGenerationPreparation = Omit<
  GraphPreparationPlan,
  "availability"
> &
  Readonly<{
    coverage: string;
    warnings: readonly GraphDiagnostic[];
    partialFailures: readonly GraphDiagnostic[];
    work: Readonly<{
      alreadyPublished: boolean;
      extractedFiles: number;
      reusedFiles: number;
      uncacheableFiles: number;
      supportedRelationTypes: readonly string[];
      relationshipResolution: string;
      unchangedContentIdentification: string;
      sourceEnumeration: string;
    }>;
  }>;

export type GraphSectionError = Readonly<{
  message: string;
  preparedFailure?: GraphPreparedFailureReason;
  /**
   * The caller's deadline (`serviceDeadlineMs`) passed while it waited for the shared Graph
   * service (the engine's exit 75). The search goes on in the service, and an exact-commit read
   * keeps its answer, so asking again soon returns it.
   */
  serviceDeadline?: true;
}>;
export type GraphOutcome<Value> =
  | Readonly<{ kind: "success"; value: Value }>
  | Readonly<{ kind: "error"; error: GraphSectionError }>;

export type GraphRelationshipOutcome =
  | GraphOutcome<GraphRelationshipObservation>
  | Readonly<{
      kind: "unavailable";
      reason: "unsupported_selection";
      selection: "exact" | "family";
      relation: string;
    }>;

export type GraphCapabilities = Readonly<{
  schemaVersion: string;
  supportedFileExtensions: readonly string[];
  supportedLanguages: readonly string[];
  semanticLanguages: readonly string[];
  inventoryOnlyLanguages: readonly string[];
  supportedRelationTypes: readonly string[];
  relationSelectionModes: readonly ("exact" | "family")[];
  relationFamilies: Readonly<Record<string, readonly string[]>>;
  relationSupportByLanguage: Readonly<Record<string, readonly string[]>>;
  relationSupportByProfile: Readonly<Record<string, readonly string[]>>;
  heuristicRelationTypes: readonly string[];
  parserVersions: Readonly<Record<string, string>>;
  unsupportedButDetectedLanguageHints: readonly string[];
  optionalLocalOnlyFeatures: Readonly<Record<string, boolean>>;
  featuresRequiringNetworkAccess: Readonly<Record<string, boolean>>;
}>;

export type GraphInspection = Readonly<{
  provider: Readonly<{
    name: "entire-graph";
    version: string;
    identityRevision: string;
    executable: Readonly<{
      sha256: string;
      buildIdentity: "verified" | "unreported";
    }>;
    capabilities: GraphCapabilities;
  }>;
  source: Readonly<{ repository: RepositoryPath; revision: FullRevision }>;
  query: GraphOutcome<GraphQueryObservation>;
  relationships: readonly Readonly<{
    requestId: string;
    outcome: GraphRelationshipOutcome;
  }>[];
}>;

export type GraphInspectionIdentity = Readonly<{
  provider: GraphInspection["provider"];
  source: GraphInspection["source"];
}>;

type GraphInspectionEventBase = Readonly<{
  sequence: number;
  identity: GraphInspectionIdentity;
}>;

export type GraphInspectionEvent =
  | (GraphInspectionEventBase &
      Readonly<{
        kind: "retrieval";
        outcome: GraphOutcome<GraphQueryObservation>;
      }>)
  | (GraphInspectionEventBase &
      Readonly<{
        kind: "relationship";
        requestId: string;
        outcome: GraphRelationshipOutcome;
      }>)
  | (GraphInspectionEventBase &
      Readonly<{
        kind: "complete";
        relationshipCount: number;
      }>);

type GraphSelectorLocation =
  | Readonly<{ path?: never; line?: never }>
  | Readonly<{ path: string; line?: number }>;

type GraphSelectorIdentity =
  | Readonly<{ symbolKind?: never; qualifiedName?: never }>
  | Readonly<{ symbolKind: string; qualifiedName: string }>;

export type GraphSymbolSelector = Readonly<{ name: string }> &
  GraphSelectorLocation &
  GraphSelectorIdentity;

/**
 * Explicit direct-edge observation, independent of retrieval relevance ranking.
 * The optional frontier is a same-view count summary for retained endpoints. It
 * does not emit another hop or establish a safe stopping depth.
 */
export type GraphRelationshipRequest = Readonly<{
  id: string;
  focus: GraphSymbolSelector;
  relation: string;
  selection: "exact" | "family";
  direction: "in" | "out";
  depth: 1;
  limit: number;
  summary?: "frontier";
}>;

export type GraphInspectionRequest = Readonly<{
  executable: string;
  repository: string;
  revision: string;
  question: string;
  limits: Readonly<{ topK: number; maxContextBytes: number }>;
  relationships: readonly GraphRelationshipRequest[];
  cache?: "reuse" | "refresh" | "prepared";
  profile?: GraphProfile;
}>;

export type GraphCacheObservation = Readonly<{
  status: "hit" | "miss" | "unreported";
  indexLatencyMs: number | null;
  analysisScope?: "complete-prepared";
}>;

export type GraphCommandStage =
  | "snapshot"
  | "symbols"
  | "symbols_init"
  | "git_revision"
  | "git_tree"
  | "git_common_directory"
  | "git_scope"
  | "worktree_add"
  | "version"
  | "capabilities"
  | "index"
  | "query"
  | "worktree_remove"
  | "worktree_prune"
  | "cache_declare"
  | `relationship:${string}:resolution`
  | `relationship:${string}:observation`
  | `query:source:${string}:metadata`
  | `query:source:${string}:content`
  | `relationship:${string}:source:${string}:metadata`
  | `relationship:${string}:source:${string}:content`;

export type GraphCommandReceipt = Readonly<{
  stage: GraphCommandStage;
  argv: readonly string[];
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number;
}>;

/**
 * What one command this boundary started used, once it ended, cancelled ones included. CPU is the
 * process's own and that of the children it waited on (the engine's `git` processes), from the
 * operating system's resource usage; null where the runtime reports none.
 */
export type GraphCommandUsage = Readonly<{
  stage: GraphCommandStage;
  wallMs: number;
  cpu: Readonly<{ userMs: number; systemMs: number }> | null;
  aborted: boolean;
}>;

/**
 * How the engine reaches the shared Graph service (`ENTIRE_GRAPH_SERVICE`): `auto` uses it when it
 * runs and otherwise does the work itself, `require` fails without it (for diagnosis), `off` never
 * uses it.
 */
export type GraphServiceMode = "auto" | "require" | "off";

export type GraphTemporaryViewRegistration = Readonly<{ path: string }>;
export type GraphInspectionEvidence = Readonly<{
  /** Threads assigned by the caller's CPU grant, per command. */
  cpuThreads?: number;
  spawnProcess?: (
    launch: () => Bun.Subprocess<"ignore" | "pipe", "pipe", "pipe">,
    signal?: AbortSignal,
  ) => Promise<Bun.Subprocess<"ignore" | "pipe", "pipe", "pipe">>;
  /**
   * The shared Graph service's mode for every engine command this boundary starts; when unset, the
   * process's own `ENTIRE_GRAPH_SERVICE`, else `auto`.
   */
  service?: GraphServiceMode;
  onCommand?: (receipt: GraphCommandReceipt) => void;
  onCommandUsage?: (usage: GraphCommandUsage) => void;
  onTemporaryView?: (registration: GraphTemporaryViewRegistration) => void;
  temporaryParent?: string;
  /**
   * Scheduling priority for the engine and Git commands this boundary starts (6.10's bounded CPU:
   * the harness passes 10). Their own children, such as the engine's `git grep`, inherit it.
   * Unset leaves the caller's priority.
   */
  niceness?: number;
  /**
   * The shared Graph service's queue class for this inspection's engine calls: `interactive` for
   * a caller waiting on the answer (a review), `background` otherwise. Unset leaves the engine's
   * default (background). Passed only while the service setting is on.
   */
  serviceClass?: "interactive" | "background";
  /**
   * How long, from the inspection's start, its engine calls wait for the shared service at most;
   * past it a call ends with a `serviceDeadline` error while the service carries on. It bounds
   * only the wait for the service: a call the engine runs in its own process ignores it. Passed
   * only while the service setting is on.
   */
  serviceDeadlineMs?: number;
  /**
   * For a caller that runs many inspections (the harness): the engine's hash, version and
   * capabilities are taken once per engine build in this process, not per inspection, and an
   * unchanged file (same device, inode, size and change time) is not hashed again. Each
   * inspection then records no `version` or `capabilities` command of its own, so it is off by
   * default, and evidence that compares every inspection's commands keeps them.
   */
  reuseIdentity?: boolean;
}>;

export type GraphInspectionRun = GraphInspectionEvidence &
  Readonly<{
    emit: (event: GraphInspectionEvent) => Promise<void>;
    signal?: AbortSignal;
    /** Explicit evaluator-owned cache. Production defaults to the store's Graph folder. */
    cacheDirectory?: string;
    /** Run-only experiment: overlap the first relationship with query, retain one
     * outcome, and deliver retrieval first. Parallel qualification has separate
     * per-operation caches. Neither the CLI nor product requests select this. */
    experimentalScheduling?: "serial" | "parallel";
  }>;
