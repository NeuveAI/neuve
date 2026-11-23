import type {
  GraphPreparedFailureReason,
  GraphProfile,
} from "@neuve/graph-client";
import type {
  ScopeSource,
  scopeStratum,
} from "../../../packages/harness/src/scope.ts";

export type PublicPreparedRead = Readonly<{
  policy_id: string;
  producer_build_id: string;
  source: Readonly<{ common_dir: string; scope: string }>;
  external_policy_origin: "serving-directory-captured";
  gitignore_origin: "target-commit";
}> &
  (
    | Readonly<{ artifact_family: "syntax-generation"; generation_id: string }>
    | Readonly<{ artifact_family: "search-snapshot"; generation_id?: never }>
  );

export type PublicReadQualification =
  | Readonly<{ profile?: never; prepared_read?: never }>
  | Readonly<{ profile: GraphProfile; prepared_read: PublicPreparedRead }>;

export type RepositoryPath = string & { readonly __brand: "RepositoryPath" };
export type Revision = string & { readonly __brand: "Revision" };
export type SourcePath = string & { readonly __brand: "SourcePath" };

export type QueryRequest = Readonly<{
  repository: RepositoryPath;
  revision: Revision;
  question: string;
  maxResults: number;
  maxContextBytes: number;
  relationships: readonly RelationshipRequest[];
  scope?: readonly string[];
  cache?: "reuse" | "refresh" | "prepared";
  profile?: GraphProfile;
}>;

export type RelationshipRequest = Readonly<{
  id: string;
  focus: Readonly<{ symbol: string }> &
    (
      | Readonly<{ path?: never; line?: never }>
      | Readonly<{ path: SourcePath; line?: number }>
    ) &
    (
      | Readonly<{ symbolKind?: never; qualifiedName?: never }>
      | Readonly<{ symbolKind: string; qualifiedName: string }>
    );
  relation: string;
  selection: "exact" | "family";
  direction: "in" | "out";
  depth: 1;
  limit: number;
  summary?: "frontier";
}>;

export type PublicDiagnostic =
  | Readonly<{ kind: "message"; message: string }>
  | Readonly<{
      kind: "provider";
      code: string;
      severity: string;
      file_path?: string;
      language?: string;
      effect_on_completeness: string;
      detail?: string;
    }>;

type PublicLimitationSubject =
  "query_result" | "relationship_focus" | "relationship_endpoint";

export type PublicLimitation =
  | Readonly<{
      kind: "unclassified_language";
      subject: PublicLimitationSubject;
    }>
  | Readonly<{
      kind: "undeclared_language" | "non_semantic_language";
      subject: PublicLimitationSubject;
      language: string;
    }>
  | Readonly<{
      kind: "unsupported_relation_for_language";
      subject: "relationship_focus" | "relationship_endpoint";
      language: string;
      relation: string;
    }>;

export type PublicRange = Readonly<{
  kind: "range";
  path: string;
  start_line: number;
  end_line: number;
}>;

export type PublicLocation =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "path"; path: string }>
  | Readonly<{ kind: "point"; path: string; line: number }>
  | PublicRange;

export type PublicEndpoint = Readonly<{
  id: string;
  name: string;
  qualified_name?: string;
  symbol_kind?: string;
  language?: string;
  location: PublicLocation;
  external: boolean;
}>;

export type PublicPartialSymbolMetadata =
  | Readonly<{
      symbol: string;
      symbol_kind?: never;
      qualified_name?: never;
    }>
  | Readonly<{
      symbol?: never;
      symbol_kind: string;
      qualified_name?: never;
    }>
  | Readonly<{
      symbol?: never;
      symbol_kind?: never;
      qualified_name: string;
    }>
  | Readonly<{
      symbol: string;
      symbol_kind: string;
      qualified_name?: never;
    }>
  | Readonly<{
      symbol: string;
      symbol_kind?: never;
      qualified_name: string;
    }>
  | Readonly<{
      symbol?: never;
      symbol_kind: string;
      qualified_name: string;
    }>;

export type PublicSymbol = Readonly<{
  kind: "symbol";
  language: string | null;
  source: PublicRange;
  symbol: string;
  symbol_kind: string;
  qualified_name: string;
}>;

export type PublicContainedCallables =
  | Readonly<{ status: "unavailable" }>
  | Readonly<{ status: "complete"; items: readonly PublicSymbol[] }>
  | Readonly<{
      status: "truncated";
      items: readonly PublicSymbol[];
      dropped: number;
    }>;

type PublicCandidateIdentity =
  | Readonly<{
      kind: "region";
      language: string | null;
      source: PublicRange;
    }>
  | (Readonly<{
      kind: "partial_symbol";
      language: string | null;
      source: PublicRange;
    }> &
      PublicPartialSymbolMetadata)
  | PublicSymbol;

export type PublicCandidate = PublicCandidateIdentity &
  Readonly<{ contained_callables: PublicContainedCallables }>;

export type PublicFocus =
  | Readonly<{ kind: "not_found" }>
  | Readonly<{ kind: "resolved"; symbol: PublicEndpoint }>
  | Readonly<{
      kind: "ambiguous";
      matches: readonly PublicEndpoint[];
      matches_truncated: boolean;
    }>;

export type PublicRelationObservation = Readonly<{
  direction: "in" | "out";
  relation: string;
  from: PublicEndpoint;
  to: PublicEndpoint;
  confidence: number;
  resolution?: string;
  reason?: string;
  evidence: readonly Readonly<{
    kind: string;
    location: PublicLocation;
    detail?: string;
  }>[];
  warning_codes: readonly string[];
  evidence_dropped: number;
}>;

export type PublicFrontierCount = Readonly<{
  relation: string;
  resolution: string | null;
  edges: number;
}>;

export type PublicFrontierEndpoint =
  | Readonly<{
      kind: "indexed";
      endpoint_id: string;
      counts: readonly PublicFrontierCount[];
      external_edges: number;
      missing_endpoint_edges: number;
      returns_to_focus: number;
      self_edges: number;
    }>
  | Readonly<{
      kind: "unavailable";
      endpoint_id: string;
      reason:
        | "external_endpoint"
        | "inventory_only_endpoint"
        | "unclassified_endpoint";
    }>;

export type PublicFrontierSummary =
  | Readonly<{ kind: "unavailable"; reason: "unsupported_provider" }>
  | Readonly<{ kind: "unresolved_focus" }>
  | Readonly<{
      kind: "observed";
      expanded_depth: 1;
      indexed_coverage: string;
      direct: Readonly<{
        eligible_edges: number;
        emitted_edges: number;
        omitted_edges: number;
        missing_endpoint_edges: number;
      }>;
      frontier: readonly PublicFrontierEndpoint[];
    }>;

type PublicFrontierSummaryExtension =
  Readonly<{ summary?: never }> | Readonly<{ summary: PublicFrontierSummary }>;

export type PublicRetrieval =
  | Readonly<{
      status: "error";
      error: string;
      prepared_failure?: GraphPreparedFailureReason;
    }>
  | (Readonly<{
      status: "ok";
      analysis_scope?: "complete-prepared";
      coverage: string;
      contained_callable_coverage: "unavailable" | "complete" | "truncated";
      candidates: readonly PublicCandidate[];
      warnings: readonly PublicDiagnostic[];
      partial_failures: readonly PublicDiagnostic[];
      limitations: readonly PublicLimitation[];
      budget: Readonly<{
        requested_top_k: number;
        requested_max_context_bytes: number;
        returned_results: number;
        provider_context_budget_bytes: number;
        provider_result_bytes: number;
        query_constraints_truncated: boolean;
        results_dropped_by_budget: number;
        snippets_truncated_by_budget: number;
      }>;
    }> &
      PublicReadQualification);

export type PublicStructuralOutcome =
  | Readonly<{
      request_id: string;
      status: "unavailable";
      reason: "unsupported_selection";
      selection: "exact" | "family";
      relation: string;
    }>
  | Readonly<{
      request_id: string;
      status: "error";
      error: string;
      prepared_failure?: GraphPreparedFailureReason;
    }>
  | (Readonly<{
      request_id: string;
      status: "ok";
      analysis_scope?: "complete-prepared";
      selection: "exact" | "family";
      selected_relations: readonly string[];
      focus: PublicFocus;
      observations: readonly PublicRelationObservation[];
      truncated: boolean;
      focus_matches_truncated: boolean;
      warnings: readonly PublicDiagnostic[];
      partial_failures: readonly PublicDiagnostic[];
      limitations: readonly PublicLimitation[];
    }> &
      PublicReadQualification &
      PublicFrontierSummaryExtension);

export type PublicCapabilities = Readonly<{
  schema_version: string;
  file_extensions: readonly string[];
  languages: Readonly<{
    supported: readonly string[];
    semantic: readonly string[];
    inventory_only: readonly string[];
    unsupported_detected_hints: readonly string[];
  }>;
  relations: Readonly<{
    selection_modes: readonly ("exact" | "family")[];
    families: Readonly<Record<string, readonly string[]>>;
    supported: readonly string[];
    by_language: Readonly<Record<string, readonly string[]>>;
    by_profile: Readonly<Record<string, readonly string[]>>;
    heuristic: readonly string[];
  }>;
  parser_versions: Readonly<Record<string, string>>;
  optional_local_features: Readonly<Record<string, boolean>>;
  features_requiring_network: Readonly<Record<string, boolean>>;
}>;

export type PublicQueryEnvelope = Readonly<{ schema_version: 2 }>;

export type PublicQueryScopeSource = Omit<
  ScopeSource,
  "contextOnly" | "stratum"
> &
  Readonly<{
    stratum: ReturnType<typeof scopeStratum>;
    text?: string;
    text_omitted?: "max-context-bytes";
  }>;

type PublicQueryScope = Readonly<{
  cycle_id?: string;
  scope_gaps?: readonly string[];
}>;

export type PublicQueryResult = Readonly<{
  provider: Readonly<{
    name: "entire-graph";
    version: string;
    identity_revision: string;
    capabilities: PublicCapabilities;
  }>;
  query: string;
  source: Readonly<{
    repository: string;
    revision: string;
  }>;
  retrieval: PublicRetrieval;
  structural_observations: readonly PublicStructuralOutcome[];
  scope?: readonly PublicQueryScopeSource[];
}> &
  PublicQueryEnvelope &
  PublicQueryScope;

export type PublicQueryIdentity = Readonly<{
  provider: PublicQueryResult["provider"];
  source: PublicQueryResult["source"];
}>;

type PublicQueryEventBase = Readonly<{
  sequence: number;
  identity: PublicQueryIdentity;
}> &
  PublicQueryEnvelope;

export type PublicQueryEvent =
  | (PublicQueryEventBase &
      Readonly<{
        kind: "retrieval";
        query: string;
        retrieval: PublicRetrieval;
      }>)
  | (PublicQueryEventBase &
      Readonly<{
        kind: "relationship";
        outcome: PublicStructuralOutcome;
      }>)
  | (PublicQueryEventBase &
      Readonly<{
        kind: "scope";
        source: PublicQueryScopeSource;
      }>)
  | (PublicQueryEventBase &
      Readonly<{
        kind: "complete";
        relationship_count: number;
      }> &
      PublicQueryScope);
