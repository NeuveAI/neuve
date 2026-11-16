import type {
  PublicCandidate,
  PublicPartialSymbolMetadata,
  RelationshipRequest,
  SourcePath,
} from "../src/domain.ts";

const validPartialMetadata = [
  { symbol: "symbol" },
  { symbol_kind: "function" },
  { qualified_name: "scope.symbol" },
  { symbol: "symbol", symbol_kind: "function" },
  { symbol: "symbol", qualified_name: "scope.symbol" },
  { symbol_kind: "function", qualified_name: "scope.symbol" },
] as const satisfies readonly PublicPartialSymbolMetadata[];

void validPartialMetadata;

// @ts-expect-error A partial symbol must expose at least one identity field.
const missingIdentity: PublicPartialSymbolMetadata = {};

// @ts-expect-error A partial symbol cannot expose the complete identity triple.
const completeIdentity: PublicPartialSymbolMetadata = {
  symbol: "symbol",
  symbol_kind: "function",
  qualified_name: "scope.symbol",
};

const completePartialCandidate: PublicCandidate = {
  kind: "partial_symbol",
  language: "Fixture",
  source: {
    kind: "range",
    path: "source.fixture",
    start_line: 1,
    end_line: 1,
  },
  symbol: "symbol",
  symbol_kind: "function",
  // @ts-expect-error A partial candidate cannot expose the complete identity triple.
  qualified_name: "scope.symbol",
};

void missingIdentity;
void completeIdentity;
void completePartialCandidate;

const relationshipBase = {
  id: "calls",
  relation: "CALLS",
  selection: "family",
  direction: "out",
  depth: 1,
  limit: 5,
} as const;

const validRelationshipSelectors = [
  { ...relationshipBase, focus: { symbol: "target" } },
  {
    ...relationshipBase,
    focus: { symbol: "target", path: "source.ts" as SourcePath, line: 2 },
  },
  {
    ...relationshipBase,
    focus: {
      symbol: "target",
      symbolKind: "function",
      qualifiedName: "target",
    },
    summary: "frontier",
  },
] as const satisfies readonly RelationshipRequest[];

void validRelationshipSelectors;

const lineWithoutPath: RelationshipRequest = {
  ...relationshipBase,
  // @ts-expect-error A relationship line requires a source path.
  focus: { symbol: "target", line: 2 },
};

const kindWithoutQualifiedName: RelationshipRequest = {
  ...relationshipBase,
  // @ts-expect-error A relationship symbol kind requires a qualified name.
  focus: { symbol: "target", symbolKind: "function" },
};

const qualifiedNameWithoutKind: RelationshipRequest = {
  ...relationshipBase,
  // @ts-expect-error A relationship qualified name requires a symbol kind.
  focus: { symbol: "target", qualifiedName: "target" },
};

const invalidSummary: RelationshipRequest = {
  ...relationshipBase,
  focus: { symbol: "target" },
  // @ts-expect-error Frontier is the only relationship summary in this slice.
  summary: "impact",
};

void lineWithoutPath;
void kindWithoutQualifiedName;
void qualifiedNameWithoutKind;
void invalidSummary;
