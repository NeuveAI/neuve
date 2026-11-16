import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setPriority } from "node:os";
import { isAbsolute } from "node:path";
import * as Schema from "effect/Schema";

export const BASE_REVISION = "914f7f89142e33e77833254d9c9b90c3cef7303b";
export const BASE_WEIGHTS_SHA256 =
  "197a32965d4b1105faf060417baa899e193fb73cd401f42ec9295234d5553d79";
const ARTIFACT_SHA256 = {
  tokenizerSha256:
    "4d777ef5bdc1aa36227abdfb77c3e49e7b9c892d16e1b6bda41c393504828be4",
  tokenizerConfigSha256:
    "17bd5d6e9364ca49a534e1502076593317c298d4a663623091ed45388f004874",
  configSha256:
    "b8f1e9931b57fbc054acdb445c41765d55b0074c58d145fa82839941ad1b5bb3",
  sentenceTransformerConfigSha256:
    "031e56a498d33c349ab489a21885bcfe25b4fcba841149dc99e1e90d4a7c28f5",
  sentenceBertConfigSha256:
    "b1bcd9f2dce3ae863b359e87d0710b5dbc3314a59ecb4e2f97c7778fc8e4b228",
  processorConfigSha256:
    "168f6a08522f3ce5dea596d94d003af2fd691742d4f41fe1f9d8cce76bfbf69c",
  preprocessorConfigSha256:
    "ea2ae257e901064abdd98dceb19f2b0da06af600bed15e0f99f5c85c37ee9d78",
  poolingConfigSha256:
    "8759bdf7c77efc7df7723f64856a593c8943b71ee38baf2a88771fbaf78438f9",
  normalizeConfigSha256:
    "cdb09dfca347a56aa2d691744e38d5ad3c7cbc2834e7181272b9a15328b82524",
  modulesSha256:
    "3d02572a0455b832de67fb8e63a54981bc7e8b46e337c95e917bd8122a533bfd",
} as const;
export const WORKER_SHA256 =
  "440df7da7762fc090a345418f6509040bd05f1792cd4e291eeefa31fd2dc22f8";
/**
 * The reranker worker's SHA-256 (`reranker_worker.py`, hybrid leads, 10.117): the harness refuses
 * any other file, wherever it is installed.
 */
export const RERANKER_WORKER_SHA256 =
  "cbd2faf32a1edbbf69feb47caa8a02da07e95a8344b104ffdc7061ff0106d74d";
const MAX_ITEMS = 32;
const MAX_TEXT_BYTES = 32 * 1024;
const MAX_BATCH_BYTES = 256 * 1024;
const MAX_OUTPUT_LINE_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
const MAX_CACHE_ENTRIES = 256;

export type InputRole =
  | "code-query"
  | "document-query"
  | "document"
  | "classification"
  | "similarity";
export type SemanticInput = Readonly<{
  role: InputRole;
  text: string;
  title?: string;
}>;
export type BaseIdentity = Readonly<{
  modelId: "google/embeddinggemma-2";
  revision: typeof BASE_REVISION;
  weightsSha256: typeof BASE_WEIGHTS_SHA256;
  tokenizerSha256: string;
  tokenizerConfigSha256: string;
  configSha256: string;
  sentenceTransformerConfigSha256: string;
  sentenceBertConfigSha256: string;
  processorConfigSha256: string;
  preprocessorConfigSha256: string;
  poolingConfigSha256: string;
  normalizeConfigSha256: string;
  modulesSha256: string;
  workerSha256: string;
  python: string;
  numpy: string;
  torch: string;
  transformers: string;
  sentenceTransformers: string;
  device: "cpu" | "mps";
  dtype: "float32";
  dimension: 768;
  maxTokens: 8192;
  recipe: "embeddinggemma2-text-prefix-v1";
}>;
export type Encoded = Readonly<{
  kind: "base-vector";
  role: InputRole;
  formattedSha256: string;
  encoderFingerprint: string;
  identity: BaseIdentity;
  tokenCount: number;
  values: readonly number[];
}>;
export type Refusal = Readonly<{
  kind: "refusal";
  reason: string;
}>;
export type BatchResult =
  | Refusal
  | Readonly<{
      kind: "encoded";
      items: readonly Encoded[];
      usage: Readonly<{
        cacheHits: number;
        generated: number;
        encodeCalls: number;
        encodeMillis: number | null;
        nativeForwardCalls: null;
        loadMillis: number | null;
      }>;
    }>;
export type PoolCandidate<Reference> = Readonly<{
  occurrenceId: string;
  reference: Reference;
  encoded: Encoded;
}>;
export type RankedCandidate<Reference> = PoolCandidate<Reference> &
  Readonly<{ score: number }>;
export type PoolResult<Reference> =
  | Refusal
  | Readonly<{
      kind: "ranked";
      selected: readonly RankedCandidate<Reference>[];
      omitted: readonly RankedCandidate<Reference>[];
      population: number;
      interpretation: "pool-local-cosine-only";
    }>;

export const BASE_RETRIEVAL_PAIR_RECIPE =
  "embeddinggemma2-base-retrieval-pair-v1";
export const BASE_EVIDENCE_PAIR_RECIPE =
  "embeddinggemma2-base-evidence-pair-v1";
export type RetrievalQueryRole = "code-query" | "document-query";

/** A caller may gate the exact synchronous process launch, after all queued preparation. */
export type SemanticSpawn = (
  launch: () => ChildProcessWithoutNullStreams,
) => Promise<ChildProcessWithoutNullStreams>;

export type SemanticClientConfig = Readonly<{
  pythonExecutable: string;
  snapshotPath: string;
  workerPath: string;
  variant:
    | Readonly<{ kind: "base" }>
    | Readonly<{ kind: "tuned"; artifactReference: string }>;
  startupTimeoutMs?: number;
  /** Scheduling priority for the worker process (6.10's bounded CPU: the harness passes 10). */
  niceness?: number;
  /** Where the model runs: the CPU (the default) or Apple's GPU (10.117). */
  device?: "cpu" | "mps";
  requestTimeoutMs?: number;
}>;

const IdentitySchema = Schema.Struct({
  modelId: Schema.Literal("google/embeddinggemma-2"),
  revision: Schema.Literal(BASE_REVISION),
  weightsSha256: Schema.Literal(BASE_WEIGHTS_SHA256),
  tokenizerSha256: Schema.String,
  tokenizerConfigSha256: Schema.String,
  configSha256: Schema.String,
  sentenceTransformerConfigSha256: Schema.String,
  sentenceBertConfigSha256: Schema.String,
  processorConfigSha256: Schema.String,
  preprocessorConfigSha256: Schema.String,
  poolingConfigSha256: Schema.String,
  normalizeConfigSha256: Schema.String,
  modulesSha256: Schema.String,
  workerSha256: Schema.String,
  python: Schema.String,
  numpy: Schema.String,
  torch: Schema.String,
  transformers: Schema.String,
  sentenceTransformers: Schema.String,
  device: Schema.Union([Schema.Literal("cpu"), Schema.Literal("mps")]),
  dtype: Schema.Literal("float32"),
  dimension: Schema.Literal(768),
  maxTokens: Schema.Literal(8192),
  recipe: Schema.Literal("embeddinggemma2-text-prefix-v1"),
});
const EncodedSchema = Schema.Struct({
  kind: Schema.Literal("base-vector"),
  role: Schema.Union([
    Schema.Literal("code-query"),
    Schema.Literal("document-query"),
    Schema.Literal("document"),
    Schema.Literal("classification"),
    Schema.Literal("similarity"),
  ]),
  formattedSha256: Schema.String,
  encoderFingerprint: Schema.String,
  identity: IdentitySchema,
  tokenCount: Schema.Number,
  values: Schema.Array(Schema.Number),
});
const BasePairSchema = Schema.Struct({
  kind: Schema.Literal("supported-base-pair"),
  schemaVersion: Schema.Literal(1),
  operation: Schema.Union([
    Schema.Literal("retrieval"),
    Schema.Literal("evidence-role"),
  ]),
  recipe: Schema.Union([
    Schema.Literal(BASE_RETRIEVAL_PAIR_RECIPE),
    Schema.Literal(BASE_EVIDENCE_PAIR_RECIPE),
  ]),
  compatibilityBasis: Schema.Literal("product-supported-base-v1"),
  queryRole: Schema.Union([
    Schema.Literal("code-query"),
    Schema.Literal("document-query"),
    Schema.Literal("classification"),
  ]),
  documentRole: Schema.Union([
    Schema.Literal("document"),
    Schema.Literal("classification"),
  ]),
  identity: IdentitySchema,
  modelFingerprint: Schema.String,
  queryRoleFingerprint: Schema.String,
  documentRoleFingerprint: Schema.String,
  dimension: Schema.Literal(768),
  normalization: Schema.Literal("l2-unit-1e-4"),
  pairId: Schema.String,
});
export type SupportedBasePair = Readonly<typeof BasePairSchema.Type>;

const RegisteredBasePairSchema = Schema.Struct({
  kind: Schema.Literal("records-registered-base-pair"),
  artifactId: Schema.String,
  recordId: Schema.String,
  pair: BasePairSchema,
});
/** Records supplies this reference only after resolving its immutable registration. */
export type RegisteredBasePairRef = Readonly<
  typeof RegisteredBasePairSchema.Type
>;
const MessageSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("ready"),
    identity: IdentitySchema,
    loadMillis: Schema.Number,
  }),
  Schema.Struct({
    kind: Schema.Literal("encoded"),
    id: Schema.Number,
    vectors: Schema.Array(Schema.Array(Schema.Number)),
    formattedSha256: Schema.Array(Schema.String),
    tokenCounts: Schema.Array(Schema.Number),
    encodeMillis: Schema.Number,
  }),
  Schema.Struct({
    kind: Schema.Literal("refusal"),
    id: Schema.NullOr(Schema.Number),
    reason: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal("fatal"), reason: Schema.String }),
]);
type WorkerMessage = typeof MessageSchema.Type;

const sha256 = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");
const sha256Pattern = /^[a-f0-9]{64}$/;
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
};

function supportedBaseIdentity(input: unknown): BaseIdentity | null {
  let identity: typeof IdentitySchema.Type;
  try {
    identity = Schema.decodeUnknownSync(IdentitySchema, {
      onExcessProperty: "error",
    })(input);
  } catch {
    return null;
  }
  if (
    identity.tokenizerSha256 !== ARTIFACT_SHA256.tokenizerSha256 ||
    identity.tokenizerConfigSha256 !== ARTIFACT_SHA256.tokenizerConfigSha256 ||
    identity.configSha256 !== ARTIFACT_SHA256.configSha256 ||
    identity.sentenceTransformerConfigSha256 !==
      ARTIFACT_SHA256.sentenceTransformerConfigSha256 ||
    identity.sentenceBertConfigSha256 !==
      ARTIFACT_SHA256.sentenceBertConfigSha256 ||
    identity.processorConfigSha256 !== ARTIFACT_SHA256.processorConfigSha256 ||
    identity.preprocessorConfigSha256 !==
      ARTIFACT_SHA256.preprocessorConfigSha256 ||
    identity.poolingConfigSha256 !== ARTIFACT_SHA256.poolingConfigSha256 ||
    identity.normalizeConfigSha256 !== ARTIFACT_SHA256.normalizeConfigSha256 ||
    identity.modulesSha256 !== ARTIFACT_SHA256.modulesSha256 ||
    identity.workerSha256 !== WORKER_SHA256 ||
    identity.python !== "3.13.5" ||
    identity.numpy !== "2.5.3" ||
    identity.torch !== "2.14.1" ||
    identity.transformers !== "5.19.0" ||
    identity.sentenceTransformers !== "6.1.0"
  )
    return null;
  return identity;
}

export function fingerprintBaseIdentity(identity: BaseIdentity): string {
  return sha256(
    JSON.stringify([
      identity.modelId,
      identity.revision,
      identity.weightsSha256,
      identity.tokenizerSha256,
      identity.tokenizerConfigSha256,
      identity.configSha256,
      identity.sentenceTransformerConfigSha256,
      identity.sentenceBertConfigSha256,
      identity.processorConfigSha256,
      identity.preprocessorConfigSha256,
      identity.poolingConfigSha256,
      identity.normalizeConfigSha256,
      identity.modulesSha256,
      identity.workerSha256,
      identity.python,
      identity.numpy,
      identity.torch,
      identity.transformers,
      identity.sentenceTransformers,
      identity.device,
      identity.dtype,
      identity.dimension,
      identity.maxTokens,
      identity.recipe,
    ]),
  );
}

const roleFormatFingerprint = (role: InputRole) =>
  sha256(
    JSON.stringify(
      role === "document"
        ? [
            formatSemanticInput({ role, text: "pair-format-control" }),
            formatSemanticInput({
              role,
              text: "pair-format-control",
              title: "pair-title-control",
            }),
          ]
        : [formatSemanticInput({ role, text: "pair-format-control" })],
    ),
  );

export const fingerprintBaseRole = (identity: BaseIdentity, role: InputRole) =>
  sha256(
    JSON.stringify([
      "base-role-encoder-v1",
      fingerprintBaseIdentity(identity),
      role,
      roleFormatFingerprint(role),
      identity.dimension,
      "l2-unit-1e-4",
    ]),
  );

const makeSupportedBasePair = (
  identity: BaseIdentity,
  operation: SupportedBasePair["operation"],
  queryRole: SupportedBasePair["queryRole"],
): SupportedBasePair => {
  const documentRole =
    operation === "retrieval" ? "document" : "classification";
  const body: Omit<SupportedBasePair, "pairId"> = {
    kind: "supported-base-pair" as const,
    schemaVersion: 1 as const,
    operation,
    recipe:
      operation === "retrieval"
        ? BASE_RETRIEVAL_PAIR_RECIPE
        : BASE_EVIDENCE_PAIR_RECIPE,
    compatibilityBasis: "product-supported-base-v1" as const,
    queryRole,
    documentRole,
    identity,
    modelFingerprint: fingerprintBaseIdentity(identity),
    queryRoleFingerprint: fingerprintBaseRole(identity, queryRole),
    documentRoleFingerprint: fingerprintBaseRole(identity, documentRole),
    dimension: 768 as const,
    normalization: "l2-unit-1e-4" as const,
  };
  return { ...body, pairId: sha256(canonical(body)) };
};

/** Check the pinned BASE vector before it can qualify a product recipe. */
export const validBaseVector = (value: Encoded): boolean => {
  const identity = supportedBaseIdentity(value.identity);
  return (
    value.kind === "base-vector" &&
    identity !== null &&
    value.encoderFingerprint === fingerprintBaseIdentity(identity) &&
    sha256Pattern.test(value.formattedSha256) &&
    Number.isSafeInteger(value.tokenCount) &&
    value.tokenCount > 0 &&
    value.tokenCount <= 8192 &&
    Array.isArray(value.values) &&
    value.values.length === 768 &&
    value.values.every(Number.isFinite) &&
    Math.abs(Math.hypot(...value.values) - 1) <= 0.0001
  );
};

/** Decode retained JSON without trusting its claimed BASE identity or values. */
export const validateRecordedBaseVector = (input: unknown): Encoded | null => {
  let decoded: typeof EncodedSchema.Type;
  try {
    decoded = Schema.decodeUnknownSync(EncodedSchema, {
      onExcessProperty: "error",
    })(input);
  } catch {
    return null;
  }
  return validBaseVector(decoded) ? decoded : null;
};

/** A product-owned BASE recipe candidate; Records must register it before use. */
export const qualifySupportedBasePair = (
  input: Readonly<{
    observedDocument: Encoded;
    queryRole: RetrievalQueryRole;
  }>,
): SupportedBasePair | Refusal =>
  input.observedDocument.role === "document" &&
  validBaseVector(input.observedDocument)
    ? makeSupportedBasePair(
        input.observedDocument.identity,
        "retrieval",
        input.queryRole,
      )
    : { kind: "refusal", reason: "unqualified-base-document-observation" };

/** Evidence-role templates use their own symmetric classification recipe. */
export const qualifySupportedBaseEvidencePair = (
  observedClassification: Encoded,
): SupportedBasePair | Refusal =>
  observedClassification.role === "classification" &&
  validBaseVector(observedClassification)
    ? makeSupportedBasePair(
        observedClassification.identity,
        "evidence-role",
        "classification",
      )
    : {
        kind: "refusal",
        reason: "unqualified-base-classification-observation",
      };

/** Reconstruct the supported recipe; an edited or unequal caller pair refuses. */
export const validateSupportedBasePair = (
  input: unknown,
): SupportedBasePair | null => {
  let pair: typeof BasePairSchema.Type;
  try {
    pair = Schema.decodeUnknownSync(BasePairSchema, {
      onExcessProperty: "error",
    })(input);
  } catch {
    return null;
  }
  if (
    supportedBaseIdentity(pair.identity) === null ||
    (pair.operation === "retrieval" &&
      pair.queryRole !== "code-query" &&
      pair.queryRole !== "document-query") ||
    (pair.operation === "evidence-role" && pair.queryRole !== "classification")
  )
    return null;
  const expected = makeSupportedBasePair(
    pair.identity,
    pair.operation,
    pair.queryRole,
  );
  return canonical(pair) === canonical(expected) ? pair : null;
};

/** Shape and recipe check only; Records must prove the reference exists. */
export const validateRegisteredBasePairRef = (
  input: unknown,
): RegisteredBasePairRef | null => {
  let registration: typeof RegisteredBasePairSchema.Type;
  try {
    registration = Schema.decodeUnknownSync(RegisteredBasePairSchema, {
      onExcessProperty: "error",
    })(input);
  } catch {
    return null;
  }
  return registration.artifactId.length > 0 &&
    registration.recordId.length > 0 &&
    validateSupportedBasePair(registration.pair)
    ? registration
    : null;
};

/** Mechanical vector check; it does not qualify the declaration as authority. */
export const matchesDeclaredVectorPair = (
  declaration: Readonly<{
    queryRole: InputRole;
    documentRole: InputRole;
    queryRoleFingerprint: string;
    documentRoleFingerprint: string;
    dimension: number;
    normalization: string;
  }>,
  query: Readonly<{
    role: InputRole;
    fingerprint: string;
    dimension: number;
    normalization: string;
  }>,
  document: Readonly<{
    role: InputRole;
    fingerprint: string;
    dimension: number;
    normalization: string;
  }>,
) =>
  query.role === declaration.queryRole &&
  document.role === declaration.documentRole &&
  query.fingerprint === declaration.queryRoleFingerprint &&
  document.fingerprint === declaration.documentRoleFingerprint &&
  query.dimension === declaration.dimension &&
  document.dimension === declaration.dimension &&
  query.normalization === declaration.normalization &&
  document.normalization === declaration.normalization &&
  Number.isSafeInteger(declaration.dimension) &&
  declaration.dimension > 0;
const validPositiveTimeout = (value: number) =>
  Number.isSafeInteger(value) && value > 0 && value <= 10 * 60 * 1000;

export function formatSemanticInput(input: SemanticInput): string {
  if (
    typeof input.text !== "string" ||
    !input.text ||
    Buffer.byteLength(input.text) > MAX_TEXT_BYTES
  )
    throw new Error("invalid-text");
  switch (input.role) {
    case "document":
      if (
        input.title !== undefined &&
        (!input.title ||
          Buffer.byteLength(input.title) > 1024 ||
          input.title.includes("\n"))
      )
        throw new Error("invalid-title");
      return `title: ${input.title ?? "none"} | text: ${input.text}`;
    case "code-query":
    case "document-query":
    case "classification":
    case "similarity": {
      if (input.title !== undefined) throw new Error("unexpected-title");
      const prefix = {
        "code-query": "task: code retrieval | query: ",
        "document-query": "task: search result | query: ",
        classification: "task: classification | query: ",
        similarity: "task: sentence similarity | query: ",
      }[input.role];
      return prefix + input.text;
    }
    default: {
      const exhaustive: never = input.role;
      throw new Error(`unsupported-role:${exhaustive}`);
    }
  }
}

function compatible(query: InputRole, document: InputRole): boolean {
  return (
    ((query === "code-query" || query === "document-query") &&
      document === "document") ||
    (query === "classification" && document === "classification") ||
    (query === "similarity" && document === "similarity")
  );
}

export function scorePool<Reference>(
  input: Readonly<{
    query: Encoded;
    candidates: readonly PoolCandidate<Reference>[];
    limit: number;
  }>,
): PoolResult<Reference> {
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.candidates.length > 1024
  )
    return { kind: "refusal", reason: "invalid-pool-limit" };
  if (
    new Set(input.candidates.map((item) => item.occurrenceId)).size !==
    input.candidates.length
  )
    return { kind: "refusal", reason: "duplicate-occurrence" };
  if (!validBaseVector(input.query))
    return { kind: "refusal", reason: "invalid-query-vector" };
  for (const candidate of input.candidates) {
    if (!validBaseVector(candidate.encoded))
      return { kind: "refusal", reason: "invalid-candidate-vector" };
    if (
      !compatible(input.query.role, candidate.encoded.role) ||
      input.query.encoderFingerprint !== candidate.encoded.encoderFingerprint
    )
      return { kind: "refusal", reason: "incompatible-vector-space" };
  }
  const ranked = input.candidates.map((candidate) => ({
    ...candidate,
    score: candidate.encoded.values.reduce(
      (sum, value, index) => sum + value * (input.query.values[index] ?? 0),
      0,
    ),
  }));
  ranked.sort(
    (left, right) =>
      right.score - left.score ||
      (left.occurrenceId < right.occurrenceId
        ? -1
        : left.occurrenceId > right.occurrenceId
          ? 1
          : 0),
  );
  return {
    kind: "ranked",
    selected: ranked.slice(0, input.limit),
    omitted: ranked.slice(input.limit),
    population: ranked.length,
    interpretation: "pool-local-cosine-only",
  };
}

type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
}>;
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

type Ready = Extract<WorkerMessage, { kind: "ready" }>;

export class SemanticClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready: Deferred<Ready> | null = null;
  private response: Deferred<WorkerMessage> | null = null;
  private startup: Promise<Ready> | null = null;
  private stdout = Buffer.alloc(0);
  private stderr = "";
  private tail: Promise<void> = Promise.resolve();
  private sequence = 0;
  private closed = false;
  private cache = new Map<string, Encoded>();
  private counters = {
    loads: 0,
    encodeCalls: 0,
    cacheHits: 0,
    generated: 0,
    refusals: 0,
  };
  private lastLoadMillis: number | null = null;

  constructor(private readonly config: SemanticClientConfig) {
    if (
      !isAbsolute(config.pythonExecutable) ||
      !isAbsolute(config.snapshotPath) ||
      !isAbsolute(config.workerPath)
    )
      throw new Error("absolute-python-snapshot-worker-required");
    if (
      !validPositiveTimeout(config.startupTimeoutMs ?? 120_000) ||
      !validPositiveTimeout(config.requestTimeoutMs ?? 120_000)
    )
      throw new Error("invalid-timeout");
    if (config.variant.kind === "tuned" && !config.variant.artifactReference)
      throw new Error("tuned-artifact-reference-required");
  }

  stats() {
    return {
      ...this.counters,
      nativeForwardCalls: null,
      cacheEntries: this.cache.size,
      loadMillis: this.lastLoadMillis,
      /** The worker process, while one runs: for its memory, read by the caller. */
      pid: this.child?.pid ?? null,
    };
  }

  private stop(reason: string) {
    const error = new Error(reason);
    this.closed = true;
    this.child?.kill("SIGKILL");
    this.ready?.reject(error);
    this.response?.reject(error);
    this.ready = null;
    this.response = null;
  }

  private acceptLine(line: string) {
    let message: WorkerMessage;
    try {
      message = Schema.decodeUnknownSync(MessageSchema)(JSON.parse(line));
    } catch {
      this.stop("invalid-worker-protocol");
      return;
    }
    if (message.kind === "fatal") {
      this.stop(`native-load-refused:${message.reason}`);
      return;
    }
    if (message.kind === "ready") {
      if (this.ready === null || this.response !== null) {
        this.stop("unexpected-worker-ready");
        return;
      }
      this.ready.resolve(message);
      this.ready = null;
      return;
    }
    if (this.response === null) {
      this.stop("unexpected-worker-response");
      return;
    }
    this.response.resolve(message);
    this.response = null;
  }

  private acceptChunk(chunk: Buffer) {
    this.stdout = Buffer.concat([this.stdout, chunk]);
    if (this.stdout.length > MAX_OUTPUT_LINE_BYTES) {
      this.stop("worker-output-limit");
      return;
    }
    while (true) {
      const end = this.stdout.indexOf(10);
      if (end < 0) return;
      const line = this.stdout.subarray(0, end).toString("utf8");
      this.stdout = this.stdout.subarray(end + 1);
      this.acceptLine(line);
      if (this.closed) return;
    }
  }

  private async deadline<T>(
    work: Promise<T>,
    milliseconds: number,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) {
      this.stop("semantic-request-aborted");
      throw new Error("semantic-request-aborted");
    }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.stop("semantic-worker-timeout");
        reject(new Error("semantic-worker-timeout"));
      }, milliseconds);
      const abort = () => {
        this.stop("semantic-request-aborted");
        reject(new Error("semantic-request-aborted"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      };
      work.then(
        (value) => {
          cleanup();
          resolve(value);
        },
        (error) => {
          cleanup();
          reject(error);
        },
      );
    });
  }

  private async start(
    signal?: AbortSignal,
    spawnProcess?: SemanticSpawn,
  ): Promise<Ready> {
    if (this.startup !== null) return this.startup;
    if (this.closed) return Promise.reject(new Error("semantic-client-closed"));
    const launch = () => {
      if (this.closed || signal?.aborted)
        throw new Error("semantic-request-aborted");
      const child = spawn(
        this.config.pythonExecutable,
        [
          "-u",
          this.config.workerPath,
          "--snapshot",
          this.config.snapshotPath,
          "--device",
          this.config.device ?? "cpu",
        ],
        {
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            ...process.env,
            HF_HUB_OFFLINE: "1",
            TRANSFORMERS_OFFLINE: "1",
            TOKENIZERS_PARALLELISM: "false",
          },
        },
      );
      this.child = child;
      return child;
    };
    const child =
      spawnProcess === undefined ? launch() : await spawnProcess(launch);
    const ready = deferred<Ready>();
    this.ready = ready;
    if (this.config.niceness !== undefined && child.pid !== undefined)
      try {
        setPriority(child.pid, this.config.niceness);
      } catch {
        // A worker that already exited, or a priority the system refuses: it still runs.
      }
    child.stdout.on("data", (chunk: Buffer) => this.acceptChunk(chunk));
    child.stdin.on("error", () => this.stop("semantic-worker-input-failed"));
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString("utf8")).slice(
        -MAX_STDERR_BYTES,
      );
    });
    child.on("error", () => this.stop("semantic-worker-spawn-failed"));
    child.on("exit", () => {
      if (!this.closed) this.stop("semantic-worker-exited");
    });
    this.startup = this.deadline(
      ready.promise,
      this.config.startupTimeoutMs ?? 120_000,
      signal,
    ).then(async (result) => {
      const expectedWorker = createHash("sha256")
        .update(await readFile(this.config.workerPath))
        .digest("hex");
      if (
        expectedWorker !== WORKER_SHA256 ||
        supportedBaseIdentity(result.identity) === null ||
        result.identity.device !== (this.config.device ?? "cpu") ||
        !Number.isFinite(result.loadMillis) ||
        result.loadMillis < 0
      ) {
        this.stop("semantic-artifact-identity-mismatch");
        throw new Error("semantic-artifact-identity-mismatch");
      }
      this.counters.loads += 1;
      this.lastLoadMillis = result.loadMillis;
      return result;
    });
    return this.startup;
  }

  async encodeBatch(
    inputs: readonly SemanticInput[],
    signal?: AbortSignal,
    spawnProcess?: SemanticSpawn,
  ): Promise<BatchResult> {
    const work = this.tail
      .then(() => this.encodeBatchNow(inputs, signal, spawnProcess))
      .then((result) => {
        if (result.kind === "refusal") this.counters.refusals += 1;
        return result;
      });
    this.tail = work.then(
      () => undefined,
      () => undefined,
    );
    return work;
  }

  private async encodeBatchNow(
    inputs: readonly SemanticInput[],
    signal?: AbortSignal,
    spawnProcess?: SemanticSpawn,
  ): Promise<BatchResult> {
    if (this.config.variant.kind === "tuned")
      return {
        kind: "refusal",
        reason: "tuned-artifact-unqualified-for-production",
      };
    if (this.closed)
      return { kind: "refusal", reason: "semantic-client-closed" };
    if (signal?.aborted)
      return { kind: "refusal", reason: "semantic-request-aborted" };
    if (inputs.length < 1 || inputs.length > MAX_ITEMS)
      return { kind: "refusal", reason: "invalid-batch-size" };
    let formatted: string[];
    try {
      formatted = inputs.map(formatSemanticInput);
    } catch (error) {
      return {
        kind: "refusal",
        reason: error instanceof Error ? error.message : "invalid-input",
      };
    }
    if (
      formatted.reduce((sum, item) => sum + Buffer.byteLength(item), 0) >
      MAX_BATCH_BYTES
    )
      return { kind: "refusal", reason: "batch-too-large" };
    const alreadyStarted = this.startup !== null;
    let ready: Ready;
    try {
      ready = await this.start(signal, spawnProcess);
    } catch (error) {
      return {
        kind: "refusal",
        reason: error instanceof Error ? error.message : "native-load-failed",
      };
    }
    const fingerprint = fingerprintBaseIdentity(ready.identity);
    const keys = formatted.map(
      (item, index) => `${fingerprint}:${inputs[index]?.role}:${sha256(item)}`,
    );
    const misses = new Map<
      string,
      { input: SemanticInput; formattedSha256: string }
    >();
    let cacheHits = 0;
    keys.forEach((key, index) => {
      if (this.cache.has(key)) cacheHits += 1;
      else if (misses.has(key)) cacheHits += 1;
      else {
        const input = inputs[index];
        const item = formatted[index];
        if (input !== undefined && item !== undefined)
          misses.set(key, { input, formattedSha256: sha256(item) });
      }
    });
    let encodeMillis: number | null = null;
    if (misses.size > 0) {
      const response = deferred<WorkerMessage>();
      this.response = response;
      const id = ++this.sequence;
      const batch = [...misses.values()];
      const payload =
        JSON.stringify({
          op: "encode",
          id,
          items: batch.map((value) => value.input),
        }) + "\n";
      if (Buffer.byteLength(payload) > 512 * 1024) {
        this.response = null;
        return { kind: "refusal", reason: "request-too-large" };
      }
      try {
        if (this.child === null || this.closed)
          throw new Error("semantic-worker-unavailable");
        this.child.stdin.write(payload);
      } catch {
        this.stop("semantic-worker-input-failed");
        return { kind: "refusal", reason: "semantic-worker-input-failed" };
      }
      let output: WorkerMessage;
      try {
        output = await this.deadline(
          response.promise,
          this.config.requestTimeoutMs ?? 120_000,
          signal,
        );
      } catch (error) {
        return {
          kind: "refusal",
          reason:
            error instanceof Error ? error.message : "native-inference-failed",
        };
      }
      if (output.kind === "refusal")
        return { kind: "refusal", reason: output.reason };
      if (
        output.kind !== "encoded" ||
        output.id !== id ||
        output.vectors.length !== batch.length ||
        output.formattedSha256.length !== batch.length ||
        output.tokenCounts.length !== batch.length ||
        !Number.isFinite(output.encodeMillis) ||
        output.encodeMillis < 0
      ) {
        this.stop("invalid-worker-result");
        return { kind: "refusal", reason: "invalid-worker-result" };
      }
      const entries = [...misses.entries()];
      const created = new Map<string, Encoded>();
      for (let index = 0; index < entries.length; index++) {
        const pair = entries[index];
        const vector = output.vectors[index];
        const digest = output.formattedSha256[index];
        const tokens = output.tokenCounts[index];
        if (
          !pair ||
          !vector ||
          !digest ||
          tokens === undefined ||
          digest !== pair[1].formattedSha256 ||
          vector.length !== 768 ||
          !vector.every(Number.isFinite) ||
          Math.abs(Math.hypot(...vector) - 1) > 0.0001 ||
          !Number.isSafeInteger(tokens) ||
          tokens < 1 ||
          tokens > 8192
        ) {
          this.stop("invalid-worker-vector");
          return { kind: "refusal", reason: "invalid-worker-vector" };
        }
        created.set(
          pair[0],
          Object.freeze({
            kind: "base-vector" as const,
            role: pair[1].input.role,
            formattedSha256: digest,
            encoderFingerprint: fingerprint,
            identity: ready.identity,
            tokenCount: tokens,
            values: Object.freeze([...vector]),
          }),
        );
      }
      const active = new Set(keys);
      for (const [key, value] of created) {
        this.cache.set(key, value);
        if (this.cache.size > MAX_CACHE_ENTRIES) {
          const evict = [...this.cache.keys()].find(
            (candidate) => !active.has(candidate),
          );
          if (evict !== undefined) this.cache.delete(evict);
        }
      }
      this.counters.encodeCalls += 1;
      this.counters.generated += misses.size;
      encodeMillis = output.encodeMillis;
    }
    this.counters.cacheHits += cacheHits;
    const items = keys.map((key) => this.cache.get(key));
    if (items.some((item) => item === undefined))
      return { kind: "refusal", reason: "cache-result-unavailable" };
    return {
      kind: "encoded",
      items: items.filter((item): item is Encoded => item !== undefined),
      usage: {
        cacheHits,
        generated: misses.size,
        encodeCalls: misses.size > 0 ? 1 : 0,
        encodeMillis,
        nativeForwardCalls: null,
        loadMillis: alreadyStarted ? null : this.lastLoadMillis,
      },
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.ready?.reject(new Error("semantic-client-closed"));
    this.response?.reject(new Error("semantic-client-closed"));
    this.ready = null;
    this.response = null;
    this.child?.stdin.end();
    if (this.child?.exitCode === null) {
      const child = this.child;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 2000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    this.cache.clear();
  }
}
