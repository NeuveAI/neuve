import { readInstallation } from "./installation.ts";
import { viewFolder } from "./graph-views.ts";
import { Cause, Data, Effect, Layer, Option } from "effect";
import { isSqlError } from "effect/sql/SqlError";
import {
  Blobs,
  Computations,
  Log,
  mintUlid,
  Queries,
  type StoreLocation,
  StoreMissing,
} from "@neuve/records-core";
import { budgetDirectory } from "@neuve/records-core/budget-directory";
import type { QueryRecorded } from "@neuve/records-schema";
import {
  requesterAttribution,
  resolveRequester,
  type Requester,
} from "@neuve/harness/request";
import { resolveCommit } from "../../../packages/harness/src/git.ts";
import {
  AGENT_GUIDE,
  SCOPE_FETCH_BOUND_MS,
  keepLocalScope,
  queryLocalScope,
  queryUnheldLocalScope,
  readLocalScope,
  scopeStratum,
  type LocalScopeRead,
} from "../../../packages/harness/src/scope.ts";
import {
  openRunLog,
  type RunLog,
  type RunLogRecord,
} from "@neuve/harness/run-log";
import { describeFailure, withStore } from "./records-cli.ts";
import type { QueryInvocation } from "./boundary.ts";
import {
  openQueryCycle,
  readQueryBranch,
  type QueryBranch,
  warnQueryCycle,
} from "./query-cycle.ts";

import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  GitReadRefusal,
  assessLocalGitEnvironment,
  requireOfflineGitRead,
  observeGraphProvider,
  planGraphPreparation,
  runGraphInspection,
  type GraphCapabilityLimitation,
  type GraphContainedCallable,
  type GraphDiagnostic,
  type GraphEndpoint,
  type GraphEvidence,
  type GraphFrontierSummary,
  type GraphFocus,
  type GraphInspection,
  type GraphInspectionEvent,
  type GraphInspectionRequest,
  type GraphLocation,
  type GraphOutcome,
  type GraphQueryBudget,
  type GraphQueryObservation,
  type GraphPreparedRead,
  type GraphProviderObservation,
  type GraphReadQualification,
  type GraphQueryResultWithContainedCallables,
  type GraphRelationObservation,
  type GraphRelationshipOutcome,
  type GraphSymbolSelector,
} from "@neuve/graph-client";

import type {
  PublicCandidate,
  PublicContainedCallables,
  PublicCapabilities,
  PublicDiagnostic,
  PublicEndpoint,
  PublicFocus,
  PublicFrontierSummary,
  PublicLimitation,
  PublicLocation,
  PublicQueryResult,
  PublicQueryScopeSource,
  PublicQueryEvent,
  PublicQueryIdentity,
  PublicRange,
  RelationshipRequest,
  PublicRelationObservation,
  PublicRetrieval,
  PublicSymbol,
  PublicStructuralOutcome,
  PublicReadQualification,
  QueryRequest,
} from "./domain.ts";

const publicPreparedRead = (value: GraphPreparedRead) => {
  const base = {
    policy_id: value.policyId,
    producer_build_id: value.producerBuildId,
    source: {
      common_dir: value.source.commonDirectory,
      scope: value.source.scope,
    },
    external_policy_origin: value.externalPolicyOrigin,
    gitignore_origin: value.gitignoreOrigin,
  };
  return value.artifactFamily === "syntax-generation"
    ? {
        ...base,
        artifact_family: value.artifactFamily,
        generation_id: value.generationId,
      }
    : { ...base, artifact_family: value.artifactFamily };
};

const publicQualification = (
  value: GraphReadQualification,
): PublicReadQualification =>
  value.preparedRead === undefined
    ? {}
    : {
        profile: value.profile,
        prepared_read: publicPreparedRead(value.preparedRead),
      };

const capabilities = (
  value: GraphInspection["provider"]["capabilities"],
): PublicCapabilities => ({
  schema_version: value.schemaVersion,
  file_extensions: value.supportedFileExtensions,
  languages: {
    supported: value.supportedLanguages,
    semantic: value.semanticLanguages,
    inventory_only: value.inventoryOnlyLanguages,
    unsupported_detected_hints: value.unsupportedButDetectedLanguageHints,
  },
  relations: {
    selection_modes: value.relationSelectionModes,
    families: value.relationFamilies,
    supported: value.supportedRelationTypes,
    by_language: value.relationSupportByLanguage,
    by_profile: value.relationSupportByProfile,
    heuristic: value.heuristicRelationTypes,
  },
  parser_versions: value.parserVersions,
  optional_local_features: value.optionalLocalOnlyFeatures,
  features_requiring_network: value.featuresRequiringNetworkAccess,
});

const isExecutableFile = async (path: string): Promise<boolean> => {
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

export const discoverGraphBinary = async (
  input: Readonly<{ override: string | undefined; executable: string }> = {
    override: process.env.NEUVE_GRAPH_BINARY,
    executable: process.execPath,
  },
): Promise<string> => {
  const override = input.override;
  if (override !== undefined) {
    if (!(await isExecutableFile(override))) {
      throw new Error(
        `NEUVE_GRAPH_BINARY does not name an executable file: ${override}`,
      );
    }
    return resolve(override);
  }

  const executableDirectory = dirname(await realpath(input.executable));
  // `bun run install:cli` copies the engine beside the installed command
  // (<prefix>/bin/neuve with <prefix>/lib/neuve/entire-graph).
  const installed = resolve(executableDirectory, "../lib/neuve/entire-graph");
  if (await isExecutableFile(installed)) return installed;
  // A workspace build (apps/neuve-cli/dist/neuve) uses the sibling Graph checkout.
  const sibling = resolve(
    executableDirectory,
    "../../neuve-graph/entire-graph",
  );
  if (await isExecutableFile(sibling)) return sibling;
  const source = resolve(import.meta.dir, "../../neuve-graph/entire-graph");
  if (!Bun.main.startsWith("/$bunfs/") && (await isExecutableFile(source)))
    return source;
  throw new Error(
    `Neuve Graph binary is unavailable at ${installed}, ${sibling}, or ${source} (when running from source). Run bun run install:cli, build it, or set NEUVE_GRAPH_BINARY.`,
  );
};

const diagnostic = (value: GraphDiagnostic): PublicDiagnostic =>
  value.kind === "message"
    ? { kind: value.kind, message: value.message }
    : {
        kind: value.kind,
        code: value.code,
        severity: value.severity,
        ...(value.filePath === undefined
          ? {}
          : { file_path: String(value.filePath) }),
        ...(value.language === undefined ? {} : { language: value.language }),
        effect_on_completeness: value.effectOnCompleteness,
        ...(value.detail === undefined ? {} : { detail: value.detail }),
      };

const limitation = (value: GraphCapabilityLimitation): PublicLimitation => {
  if (value.kind === "unclassified_language") {
    return { kind: value.kind, subject: value.subject };
  }
  if (value.kind === "unsupported_relation_for_language") {
    return {
      kind: value.kind,
      subject: value.subject,
      language: value.language,
      relation: value.relation,
    };
  }
  return {
    kind: value.kind,
    subject: value.subject,
    language: value.language,
  };
};

const location = (value: GraphLocation): PublicLocation => {
  if (value.kind === "absent") return { kind: "absent" };
  if (value.kind === "path") return { kind: "path", path: String(value.path) };
  if (value.kind === "point")
    return { kind: "point", path: String(value.path), line: value.line };
  return {
    kind: "range",
    path: String(value.path),
    start_line: value.startLine,
    end_line: value.endLine,
  };
};

const range = (
  value: GraphQueryResultWithContainedCallables["source"],
): PublicRange => ({
  kind: "range",
  path: String(value.path),
  start_line: value.startLine,
  end_line: value.endLine,
});

const endpoint = (value: GraphEndpoint): PublicEndpoint => ({
  id: value.id,
  name: value.name,
  ...(value.qualifiedName === undefined
    ? {}
    : { qualified_name: value.qualifiedName }),
  ...(value.symbolKind === undefined ? {} : { symbol_kind: value.symbolKind }),
  ...(value.language === undefined ? {} : { language: value.language }),
  location: location(value.location),
  external: value.external,
});

const evidence = (
  value: GraphEvidence,
): PublicRelationObservation["evidence"][number] => ({
  kind: value.kind,
  location: location(value.location),
  ...(value.detail === undefined ? {} : { detail: value.detail }),
});

const relation = (
  value: GraphRelationObservation,
): PublicRelationObservation => ({
  direction: value.direction,
  relation: value.relation,
  from: endpoint(value.from),
  to: endpoint(value.to),
  confidence: value.confidence,
  ...(value.resolution === undefined ? {} : { resolution: value.resolution }),
  ...(value.reason === undefined ? {} : { reason: value.reason }),
  evidence: value.evidence.map(evidence),
  warning_codes: value.warningCodes,
  evidence_dropped: value.evidenceDropped,
});

const focus = (value: GraphFocus): PublicFocus => {
  if (value.kind === "not_found") return { kind: value.kind };
  if (value.kind === "resolved")
    return { kind: value.kind, symbol: endpoint(value.symbol) };
  return {
    kind: value.kind,
    matches: value.matches.map(endpoint),
    matches_truncated: value.matchesTruncated,
  };
};

const frontierSummary = (
  value: GraphFrontierSummary,
): PublicFrontierSummary => {
  if (value.kind !== "observed") return value;
  return {
    kind: value.kind,
    expanded_depth: value.expandedDepth,
    indexed_coverage: value.indexedCoverage,
    direct: {
      eligible_edges: value.direct.eligibleEdges,
      emitted_edges: value.direct.emittedEdges,
      omitted_edges: value.direct.omittedEdges,
      missing_endpoint_edges: value.direct.missingEndpointEdges,
    },
    frontier: value.frontier.map((entry) =>
      entry.kind === "unavailable"
        ? {
            kind: entry.kind,
            endpoint_id: entry.endpointId,
            reason: entry.reason,
          }
        : {
            kind: entry.kind,
            endpoint_id: entry.endpointId,
            counts: entry.counts,
            external_edges: entry.externalEdges,
            missing_endpoint_edges: entry.missingEndpointEdges,
            returns_to_focus: entry.returnsToFocus,
            self_edges: entry.selfEdges,
          },
    ),
  };
};

const containedSymbol = (value: GraphContainedCallable): PublicSymbol => ({
  kind: "symbol",
  language: value.language,
  source: range(value.source),
  symbol: value.symbol,
  symbol_kind: value.symbolKind,
  qualified_name: value.qualifiedName,
});

const containedCallables = (
  value: GraphQueryResultWithContainedCallables["containedCallables"],
): PublicContainedCallables => {
  if (value.kind === "unavailable") return { status: value.kind };
  const items = value.items.map(containedSymbol);
  return value.kind === "complete"
    ? { status: value.kind, items }
    : { status: value.kind, items, dropped: value.dropped };
};

const candidate = (
  value: GraphQueryResultWithContainedCallables,
): PublicCandidate => {
  const base = {
    language: value.language,
    source: range(value.source),
    contained_callables: containedCallables(value.containedCallables),
  };
  if (value.kind === "region") return { kind: value.kind, ...base };
  if (value.kind === "symbol") {
    return {
      kind: value.kind,
      ...base,
      symbol: value.symbol,
      symbol_kind: value.symbolKind,
      qualified_name: value.qualifiedName,
    };
  }
  const symbol = value.symbol;
  const symbolKind = value.symbolKind;
  const qualifiedName = value.qualifiedName;
  if (symbol !== undefined && symbolKind !== undefined) {
    return {
      kind: value.kind,
      ...base,
      symbol,
      symbol_kind: symbolKind,
    };
  }
  if (symbol !== undefined && qualifiedName !== undefined) {
    return {
      kind: value.kind,
      ...base,
      symbol,
      qualified_name: qualifiedName,
    };
  }
  if (symbolKind !== undefined && qualifiedName !== undefined) {
    return {
      kind: value.kind,
      ...base,
      symbol_kind: symbolKind,
      qualified_name: qualifiedName,
    };
  }
  if (symbol !== undefined) return { kind: value.kind, ...base, symbol };
  if (symbolKind !== undefined) {
    return { kind: value.kind, ...base, symbol_kind: symbolKind };
  }
  if (qualifiedName !== undefined) {
    return { kind: value.kind, ...base, qualified_name: qualifiedName };
  }
  throw new Error("Graph partial symbol has no identity metadata.");
};

const queryOutcome = (
  outcome: GraphOutcome<GraphQueryObservation>,
): PublicRetrieval => {
  if (outcome.kind === "error")
    return {
      status: "error",
      error: outcome.error.message,
      ...(outcome.error.preparedFailure === undefined
        ? {}
        : { prepared_failure: outcome.error.preparedFailure }),
    };
  const value = outcome.value;
  return {
    status: "ok",
    ...publicQualification(value),
    ...(value.cache.analysisScope === undefined
      ? {}
      : { analysis_scope: value.cache.analysisScope }),
    coverage: value.coverage,
    contained_callable_coverage: value.containedCallableCoverage,
    candidates: value.results.map(candidate),
    warnings: value.warnings.map(diagnostic),
    partial_failures: value.partialFailures.map(diagnostic),
    limitations: value.limitations.map(limitation),
    budget: {
      requested_top_k: value.budget.requestedTopK,
      requested_max_context_bytes: value.budget.requestedMaxContextBytes,
      returned_results: value.budget.returnedResults,
      provider_context_budget_bytes: value.budget.providerContextBudgetBytes,
      provider_result_bytes: value.budget.providerResultBytes,
      query_constraints_truncated: value.budget.queryConstraintsTruncated,
      results_dropped_by_budget: value.budget.resultsDroppedByBudget,
      snippets_truncated_by_budget: value.budget.snippetsTruncatedByBudget,
    },
  };
};

const relationshipOutcome = (
  requestId: string,
  outcome: GraphRelationshipOutcome,
): PublicStructuralOutcome => {
  if (outcome.kind === "unavailable")
    return {
      request_id: requestId,
      status: "unavailable",
      reason: outcome.reason,
      selection: outcome.selection,
      relation: outcome.relation,
    };
  if (outcome.kind === "error")
    return {
      request_id: requestId,
      status: "error",
      error: outcome.error.message,
      ...(outcome.error.preparedFailure === undefined
        ? {}
        : { prepared_failure: outcome.error.preparedFailure }),
    };
  const value = outcome.value;
  const result = {
    request_id: requestId,
    status: "ok",
    ...publicQualification(value),
    ...(value.cache.analysisScope === undefined
      ? {}
      : { analysis_scope: value.cache.analysisScope }),
    selection: value.selection,
    selected_relations: value.selectedRelations,
    focus: focus(value.focus),
    observations: value.observations.map(relation),
    truncated: value.truncated,
    focus_matches_truncated: value.focusMatchesTruncated,
    warnings: value.warnings.map(diagnostic),
    partial_failures: value.partialFailures.map(diagnostic),
    limitations: value.limitations.map(limitation),
  } as const;
  return value.summary === undefined
    ? result
    : { ...result, summary: frontierSummary(value.summary) };
};

export const toPublicQueryResult = (
  request: QueryRequest,
  inspection: GraphInspection,
): PublicQueryResult => {
  return {
    schema_version: 2,
    provider: {
      name: inspection.provider.name,
      version: inspection.provider.version,
      identity_revision: inspection.provider.identityRevision,
      capabilities: capabilities(inspection.provider.capabilities),
    },
    query: request.question,
    source: {
      repository: String(inspection.source.repository),
      revision: String(inspection.source.revision),
    },
    retrieval: queryOutcome(inspection.query),
    structural_observations: inspection.relationships.map((item) =>
      relationshipOutcome(item.requestId, item.outcome),
    ),
  };
};

const graphFocus = (
  focus: RelationshipRequest["focus"],
): GraphSymbolSelector => {
  if (focus.symbolKind === undefined) {
    return focus.path === undefined
      ? { name: focus.symbol }
      : {
          name: focus.symbol,
          path: focus.path,
          ...(focus.line === undefined ? {} : { line: focus.line }),
        };
  }
  return focus.path === undefined
    ? {
        name: focus.symbol,
        symbolKind: focus.symbolKind,
        qualifiedName: focus.qualifiedName,
      }
    : {
        name: focus.symbol,
        path: focus.path,
        ...(focus.line === undefined ? {} : { line: focus.line }),
        symbolKind: focus.symbolKind,
        qualifiedName: focus.qualifiedName,
      };
};

export const toGraphInspectionRequest = (
  request: QueryRequest,
  executable: string,
): GraphInspectionRequest => ({
  executable,
  repository: request.repository,
  revision: request.revision,
  question: request.question,
  ...(request.cache === undefined ? {} : { cache: request.cache }),
  ...(request.profile === undefined ? {} : { profile: request.profile }),
  limits: {
    topK: request.maxResults,
    maxContextBytes: request.maxContextBytes,
  },
  relationships: request.relationships.map((relationship) => ({
    id: relationship.id,
    focus: graphFocus(relationship.focus),
    relation: relationship.relation,
    selection: relationship.selection,
    direction: relationship.direction,
    depth: relationship.depth,
    limit: relationship.limit,
    ...(relationship.summary === undefined
      ? {}
      : { summary: relationship.summary }),
  })),
});

const publicIdentity = (
  value: GraphInspectionEvent["identity"],
): PublicQueryIdentity => ({
  provider: {
    name: value.provider.name,
    version: value.provider.version,
    identity_revision: value.provider.identityRevision,
    capabilities: capabilities(value.provider.capabilities),
  },
  source: {
    repository: String(value.source.repository),
    revision: String(value.source.revision),
  },
});

export const toPublicQueryEvent = (
  request: QueryRequest,
  event: GraphInspectionEvent,
): PublicQueryEvent => {
  const base = {
    schema_version: 2 as const,
    sequence: event.sequence,
    identity: publicIdentity(event.identity),
  };
  if (event.kind === "retrieval") {
    return {
      ...base,
      kind: "retrieval",
      query: request.question,
      retrieval: queryOutcome(event.outcome),
    };
  }
  if (event.kind === "relationship") {
    return {
      ...base,
      kind: "relationship",
      outcome: relationshipOutcome(event.requestId, event.outcome),
    };
  }
  return {
    ...base,
    kind: "complete",
    relationship_count: event.relationshipCount,
  };
};

export const collectPublicQueryResult = (
  events: readonly PublicQueryEvent[],
): PublicQueryResult => {
  const retrieval = events.find((event) => event.kind === "retrieval");
  const complete = events.at(-1);
  if (retrieval?.kind !== "retrieval" || complete?.kind !== "complete") {
    throw new Error("Public query event stream is incomplete.");
  }
  const scope = events.flatMap((event) =>
    event.kind === "scope" ? [event.source] : [],
  );
  return {
    schema_version: 2,
    provider: retrieval.identity.provider,
    query: retrieval.query,
    source: retrieval.identity.source,
    retrieval: retrieval.retrieval,
    structural_observations: events.flatMap((event) =>
      event.kind === "relationship" ? [event.outcome] : [],
    ),
    ...(complete.scope_gaps === undefined
      ? {}
      : { scope, scope_gaps: complete.scope_gaps }),
    ...(complete.cycle_id === undefined ? {} : { cycle_id: complete.cycle_id }),
  };
};

/** The request a query ran for; source evidence is read against it. */
export type QuerySourceContext = Readonly<
  {
    request: QueryRequest;
  } & (
    | { kind: "unrecorded"; state: { kind: "not_recorded"; reason: string } }
    | {
        kind: "recorded";
        eventId: string;
        state:
          | { kind: "cycle_opened" | "cycle_joined"; cycle_id: string }
          | { kind: "not_joined"; reason: string };
      }
  )
>;

type QueryScopeAnswer = Effect.Success<ReturnType<typeof queryLocalScope>>;
const localScopeGap = "Retry neuve query to read local scope.";
type RecordedQuery =
  | {
      eventId: string;
      cycle?: { cycleId: string; opened: boolean };
      scope?: QueryScopeAnswer;
      scopeGap?: string;
      reason?: never;
    }
  | {
      eventId?: never;
      cycle?: never;
      scope?: never;
      scopeGap?: never;
      reason: string;
    };

type QueryDiagnostics = {
  location?: StoreLocation;
  eventId?: string;
  log?: RunLog;
};

const writeDiagnostic = (
  diagnostics: QueryDiagnostics,
  record: RunLogRecord,
) => {
  if (diagnostics.location === undefined) return;
  try {
    diagnostics.log ??= openRunLog(
      diagnostics.location,
      diagnostics.eventId ?? mintUlid(),
      false,
    );
    diagnostics.log.write(record);
    return diagnostics.log.path;
  } catch {}
};

const storeLocked = (error: unknown) =>
  isSqlError(error) && error.reason._tag === "LockTimeoutError";

const recordQuery = async (
  request: QueryRequest,
  payload: QueryRecorded["payload"],
  diagnostics: QueryDiagnostics,
  cycle?: QueryBranch & { onFailure: (error: unknown) => void },
  local?: LocalScopeRead,
  explicitRequester?: Requester,
): Promise<RecordedQuery> => {
  const scopeWriteFailures: RunLogRecord[] = [];
  const result = await Effect.runPromiseExit(
    withStore(request.repository, "write", (location) => {
      diagnostics.location = location;
      return Effect.gen(function* () {
        const requester =
          explicitRequester ??
          (yield* resolveRequester(location, request.repository));
        const { actor, registration } = requesterAttribution(requester);
        const revision =
          payload.revision ??
          (yield* resolveCommit(request.repository, request.revision).pipe(
            Effect.orElseSucceed(() => null),
          ));
        if (registration !== undefined) yield* Log.append([registration]);
        const selectScope =
          local === undefined
            ? undefined
            : (cycleId: string) =>
                keepLocalScope({ location, cycleId }, local, (path, cause) =>
                  scopeWriteFailures.push({
                    type: "query.scope-write-failed",
                    path,
                    cause,
                  }),
                );
        const readCycle =
          revision !== null && cycle !== undefined
            ? yield* openQueryCycle(
                request.repository,
                location,
                {
                  baseRef: request.revision,
                  baseOid: revision,
                  branch: cycle.branch,
                  branchTipOid: cycle.branchTipOid,
                },
                actor,
                cycle.onFailure,
                selectScope,
              )
            : undefined;
        const cycleId = readCycle?.cycleId;
        const sessionId =
          requester._tag === "Actor" || requester._tag === "Agent"
            ? requester.sessionId
            : undefined;
        const eventId = yield* Queries.record({
          actor,
          attribution:
            sessionId === undefined && cycleId === undefined
              ? undefined
              : { sessionId, cycleId },
          question: request.question,
          payload: { ...payload, revision },
        });
        diagnostics.eventId = eventId;
        if (readCycle === undefined) return { eventId };
        const recorded = { eventId, cycle: readCycle };
        if (local === undefined) return recorded;
        const scope = yield* Effect.exit(
          queryLocalScope(request.repository, local, {
            location,
            cycleId: readCycle.cycleId,
          }).pipe(
            Effect.timeout(SCOPE_FETCH_BOUND_MS),
            Effect.provideService(Computations.FloorReporter, (notice) =>
              writeDiagnostic(diagnostics, notice),
            ),
          ),
        );
        if (scope._tag === "Failure")
          writeDiagnostic(diagnostics, {
            type: "query.scope-failed",
            cause: Cause.pretty(scope.cause),
          });
        return scope._tag === "Success"
          ? { ...recorded, scope: scope.value }
          : {
              ...recorded,
              scopeGap: localScopeGap,
            };
      }).pipe(
        Effect.provide(
          Computations.layer.pipe(Layer.provideMerge(Blobs.layer(location))),
        ),
      );
    }),
  );
  for (const failure of scopeWriteFailures)
    writeDiagnostic(diagnostics, failure);
  if (result._tag === "Success") return result.value;
  const error = Option.getOrUndefined(Cause.findErrorOption(result.cause));
  if (error instanceof StoreMissing) {
    delete diagnostics.location;
    return { reason: "no Records store was found" };
  }
  const logPath = writeDiagnostic(diagnostics, {
    type: "query.record-failed",
    cause: Cause.pretty(result.cause),
  });
  const locked = storeLocked(error);
  if (explicitRequester === undefined) {
    const message = locked
      ? "The Records store is locked. Run neuve query again."
      : describeFailure(
          error,
          logPath === undefined
            ? "The query was not recorded."
            : `The query was not recorded. See the run log at ${JSON.stringify(logPath)}.`,
        );
    await Bun.write(Bun.stderr, `neuve: ${message}\n`).catch(() => undefined);
  }
  return {
    reason: locked
      ? "the Records store is locked"
      : explicitRequester === undefined
        ? "the query could not be recorded"
        : describeFailure(error, "the Records write failed"),
  };
};

const inspectQuery = async (
  request: QueryRequest,
  emit: (event: GraphInspectionEvent) => Promise<void>,
  signal: AbortSignal | undefined,
) => {
  signal?.throwIfAborted();
  const installation = await readInstallation(request.repository);
  // The engine setup recorded, while it still runs; else the one beside this CLI.
  const recorded =
    installation !== undefined &&
    (await isExecutableFile(installation.graphBinary))
      ? installation.graphBinary
      : undefined;
  const binary = await discoverGraphBinary({
    override: process.env.NEUVE_GRAPH_BINARY ?? recorded,
    executable: process.execPath,
  });
  // A prepared read makes no view; a refresh gets a folder of its own (graph-views.ts).
  const views =
    request.cache === "prepared"
      ? undefined
      : await viewFolder(request.repository);
  try {
    await runGraphInspection(toGraphInspectionRequest(request, binary), {
      // The machine's shared Graph cache, as the reviews' Graph reads use it (graph-client's
      // `readGraphSnapshot`): one private copy of the engine for every repository, and snapshots
      // keyed by each repository's Git common directory.
      cacheDirectory: graphCacheDirectory(),
      emit,
      ...(signal === undefined ? {} : { signal }),
      ...(views === undefined ? {} : { temporaryParent: views.parent }),
    });
  } catch (error) {
    // The last place for the view is inside the Git folder, where Graph refuses a repository that
    // commits a link leaving its disk. Say that, and what to change, instead of Graph's own words.
    if (
      views?.store === true &&
      error instanceof Error &&
      error.message.includes("refuse Git subprocesses for unsafe")
    )
      throw new Error(VIEW_REFUSED);
    throw error;
  } finally {
    await views?.release();
  }
};

export const runQueryGraph = async (
  request: QueryInvocation["request"],
  input: Readonly<{
    emit: (event: PublicQueryEvent) => Promise<void>;
    signal?: AbortSignal;
    requester?: Requester;
    checkedScope?: boolean;
  }>,
): Promise<QuerySourceContext> => {
  try {
    request = structuredClone(request);
  } catch {
    throw new QueryInputError({
      message: "Query requests must contain cloneable data.",
    });
  }
  const branch = readQueryBranch(request.repository, request.branch);
  const startedAt = new Date().toISOString();
  const start = performance.now();
  let revision: string | null = null;
  let budget: GraphQueryBudget | undefined;
  let relationships = 0;
  let outcome: QueryRecorded["payload"]["outcome"] = "failed";
  let complete: Extract<PublicQueryEvent, { kind: "complete" }> | undefined;
  let recorded: RecordedQuery;
  let local: LocalScopeRead | undefined;
  const diagnostics: QueryDiagnostics = {};
  const localRead = Effect.runPromiseExit(
    readLocalScope(
      request.repository,
      request.revision,
      request.scope ?? [],
      input.checkedScope,
    ),
    { signal: input.signal },
  );
  let cycleFailure: string | undefined;
  try {
    await inspectQuery(
      request,
      async (event) => {
        revision = event.identity.source.revision;
        if (event.kind === "retrieval" && event.outcome.kind === "success")
          budget = event.outcome.value.budget;
        if (event.kind === "relationship" && event.outcome.kind === "success")
          relationships += event.outcome.value.observations.length;
        const publicEvent = toPublicQueryEvent(request, event);
        if (publicEvent.kind === "complete") complete = publicEvent;
        else await input.emit(publicEvent);
      },
      input.signal,
    );
    if (budget !== undefined) outcome = "completed";
  } catch (error) {
    if (
      input.signal?.aborted &&
      (error === input.signal.reason ||
        (error instanceof DOMException && error.name === "AbortError"))
    )
      outcome = "interrupted";
    throw error;
  } finally {
    cycleFailure =
      outcome === "completed" && "reason" in branch ? branch.reason : undefined;
    const elapsedMs = Math.round(performance.now() - start);
    const read = complete === undefined ? undefined : await localRead;
    if (read?._tag === "Success" && revision === read.value.base)
      local = read.value;
    recorded = await recordQuery(
      request,
      {
        revision,
        maxResults: request.maxResults,
        maxContextBytes: request.maxContextBytes,
        cache: request.cache ?? "reuse",
        profile: request.profile ?? "full",
        relationshipPlanSize: request.relationships.length,
        outcome,
        candidatesReturned: budget?.returnedResults ?? 0,
        relationships,
        resultBytes: budget?.providerResultBytes ?? 0,
        resultsDroppedByBudget: budget?.resultsDroppedByBudget ?? 0,
        snippetsTruncatedByBudget: budget?.snippetsTruncatedByBudget ?? 0,
        startedAt,
        elapsedMs,
      },
      diagnostics,
      outcome === "completed" && "branch" in branch
        ? {
            ...branch,
            onFailure: (error) => {
              cycleFailure = storeLocked(error)
                ? "the Records store is locked"
                : "the review cycle could not be opened";
              writeDiagnostic(diagnostics, {
                type: "query.cycle-failed",
                cause: describeFailure(error),
              });
            },
          }
        : undefined,
      local,
      input.requester,
    );
    if (
      cycleFailure !== undefined &&
      "reason" in branch &&
      branch.cause !== undefined
    )
      writeDiagnostic(diagnostics, {
        type: "query.branch-read-failed",
        cause: branch.cause,
      });
    if (read?._tag === "Failure")
      writeDiagnostic(diagnostics, {
        type: "query.local-read-failed",
        cause: Cause.pretty(read.cause),
      });
    else if (read?._tag === "Success")
      for (const failure of read.value.readFailures)
        writeDiagnostic(diagnostics, {
          type: "query.local-read-failed",
          ...failure,
        });
    if (
      input.requester === undefined &&
      recorded.eventId !== undefined &&
      cycleFailure !== undefined
    )
      await warnQueryCycle(cycleFailure);
  }
  if (complete !== undefined) {
    const namedScope = (request.scope?.length ?? 0) > 0;
    const mightHaveScope = namedScope || local?.entries.has(AGENT_GUIDE.path);
    let scope = recorded.scope;
    let gap = recorded.scopeGap;
    if (local !== undefined && recorded.cycle === undefined && mightHaveScope) {
      const fallback = await Effect.runPromise(
        Effect.exit(
          queryUnheldLocalScope(
            request.repository,
            local,
            recorded.reason ??
              cycleFailure ??
              "the Graph read did not complete",
          ).pipe(Effect.timeout(SCOPE_FETCH_BOUND_MS)),
        ),
      );
      if (fallback._tag === "Success") scope = fallback.value;
      else {
        writeDiagnostic(diagnostics, {
          type: "query.scope-failed",
          cause: Cause.pretty(fallback.cause),
        });
        gap = localScopeGap;
      }
    } else if (local === undefined && namedScope) {
      gap = "The named local scope could not be read at the resolved revision.";
    }
    for (const cause of scope?.causes ?? [])
      writeDiagnostic(diagnostics, {
        type: "query.scope-read-failed",
        ...cause,
      });
    const gaps =
      scope?.gaps ?? (gap !== undefined && mightHaveScope ? [gap] : []);
    const sources = scope?.sources ?? [];
    if (sources.length === 0 && gaps.length === 0) await input.emit(complete);
    else {
      let sequence = complete.sequence;
      let remaining = request.maxContextBytes;
      for (const item of sources) {
        const { text, ...record } = item;
        const citation: PublicQueryScopeSource = {
          ...record,
          stratum: scopeStratum(item),
        };
        let source = citation;
        if (text !== undefined) {
          const bytes = Buffer.byteLength(text);
          if (bytes <= remaining) {
            remaining -= bytes;
            source = { ...citation, text };
          } else source = { ...citation, text_omitted: "max-context-bytes" };
        }
        await input.emit({
          schema_version: complete.schema_version,
          sequence: sequence++,
          identity: complete.identity,
          kind: "scope",
          source,
        });
      }
      await input.emit({
        ...complete,
        sequence,
        scope_gaps: gaps,
        ...(recorded.cycle === undefined
          ? {}
          : { cycle_id: recorded.cycle.cycleId }),
      });
    }
  }
  const { eventId, cycle, reason } = recorded;
  return eventId === undefined
    ? { kind: "unrecorded", request, state: { kind: "not_recorded", reason } }
    : {
        kind: "recorded",
        request,
        eventId,
        state:
          cycle === undefined
            ? {
                kind: "not_joined",
                reason: cycleFailure ?? "the Graph read did not complete",
              }
            : {
                kind: cycle.opened ? "cycle_opened" : "cycle_joined",
                cycle_id: cycle.cycleId,
              },
      };
};

/**
 * Setup's check that the Graph engine can work on this repository, without indexing anything: the
 * engine's identity and capabilities, graph-client's qualification of the repository's Git
 * metadata, and the engine's preparation plan for `revision`. It uses the shared engine copy and
 * writes no snapshot. A review builds what it reads under its own keys (commit preparation's
 * outlines, keyword index and relations), so an index made here would be read by nobody.
 *
 * graph-client's qualification refuses a repository whose objects live in another repository
 * (`objects/info/alternates`, from `git clone --shared` or `--reference`;
 * `packages/graph-client/src/git-read-qualification.ts`). Reviews don't go through it: they read
 * their own `--shared` clone, which the engine reads through its alternates. So for that one
 * refusal the check confirms the engine's identity and capabilities alone and records why.
 */
export const checkGraphEngine = async (
  repository: string,
  executable: string,
  revision: string,
) => {
  const git = await assessLocalGitEnvironment(repository);
  try {
    requireOfflineGitRead(git);
  } catch (error) {
    if (!(error instanceof GitReadRefusal)) throw error;
    return {
      schemaVersion: 1,
      check: "graph-engine",
      status: "error",
      revision,
      git,
      error: error.detail,
    } as const;
  }
  const plan = await Effect.runPromise(
    Effect.result(
      planGraphPreparation(
        { executable, repository, revision },
        { cacheDirectory: graphCacheDirectory() },
      ),
    ),
  );
  const ok = (
    provider: GraphProviderObservation,
    plan: "planned" | "alternates",
  ) =>
    ({
      schemaVersion: 1,
      check: "graph-engine",
      status: "ok",
      revision,
      git,
      plan,
      engine: {
        version: provider.version,
        identityRevision: provider.identityRevision,
        sha256: provider.executable.sha256,
      },
    }) as const;
  if (plan._tag === "Success") return ok(plan.success.provider, "planned");
  const failure = plan.failure as {
    message?: unknown;
    reason?: unknown;
    cause?: unknown;
  };
  if (
    failure.cause instanceof GitReadRefusal &&
    failure.cause.reason === "unsupported-store" &&
    failure.cause.detail === "alternates"
  ) {
    const provider = await Effect.runPromise(
      Effect.result(observeGraphProvider({ executable })),
    );
    if (provider._tag === "Success") return ok(provider.success, "alternates");
    return {
      schemaVersion: 1,
      check: "graph-engine",
      status: "error",
      revision,
      git,
      error: String(
        (provider.failure as { message?: unknown }).message ?? provider.failure,
      ).slice(0, 500),
    } as const;
  }
  return {
    schemaVersion: 1,
    check: "graph-engine",
    status: "error",
    revision,
    git,
    error:
      `${String(failure.message ?? plan.failure)}${failure.reason === undefined ? "" : ` (${String(failure.reason)})`}`.slice(
        0,
        500,
      ),
  } as const;
};
export type GraphEngineCheck = Awaited<ReturnType<typeof checkGraphEngine>>;

/** What `neuve query` says when Graph refuses its view in the last place it can go. */
export const VIEW_REFUSED =
  "Neuve found no folder of its own on this repository's disk for Graph's temporary view, and Graph refuses one inside the Git folder because the repository commits a link that leaves the disk. Set TMPDIR to a folder on the same disk as the repository, or make the disk's top folder writable for you, then run this again.";

/** The machine's one Graph cache: `<budget directory>/graph/cache`. */
export const graphCacheDirectory = () =>
  join(budgetDirectory(), "graph", "cache");

export class QueryInputError extends Data.TaggedError("QueryInputError")<{
  readonly message: string;
}> {}

export const queryGraph = async (
  request: QueryRequest,
): Promise<PublicQueryResult> => {
  const events: PublicQueryEvent[] = [];
  await runQueryGraph(request, {
    emit: async (event) => {
      events.push(event);
    },
  });
  return collectPublicQueryResult(events);
};
