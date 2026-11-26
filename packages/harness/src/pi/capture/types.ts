import { Data } from "effect";
import { z } from "zod";
import { PiUsage } from "./usage.ts";

/**
 * The capture boundary of a pi run (10.148, NEU-54). pi's durable storage already keeps the
 * transcript: every entry with its model messages, each assistant message's usage and timestamp,
 * the offered tool definitions in `pi.system` entries, tasks with their outcomes, child
 * conversations with their owner edge, compaction entries, the usage ledger in `pi.usage` and the
 * streamed partial in `pi.live`. These events add only what pi does not keep: the request as the
 * provider actually sent it, the HTTP response's metadata, the provider events worth keeping, how
 * each call ended, the join from pi's conversations to Neuve's run, stage, agent and computation, a
 * fate for every lead at every hand-off, durable external artifacts, and how each stage ended (a
 * cutoff included).
 *
 * One callback, `Capture`, takes every event. The route's provider emits the four `model.*` events;
 * the runtime and stages emit the rest. Capture never changes what the model sees: callers hand
 * over copies of what they sent or received. The provider retries model capture writes and records
 * capture loss when they run out. Invalid events and credential inspection failures stop the call.
 */

export const CAPTURE_VERSION = 1;
export const CREDENTIAL_INSPECTION_POLICY = "whole-source-credential-epochs-v1";
export const RETAINED_SDK_PIN =
  "@earendil-works/pi-ai@1.0.0:sha256:8c1e31ed5424f1e92ebf334e0f3284c97d9b47c475167a1152045e834d7ec759:partial-json@0.1.7";
export const RETAINED_SDK_ASSEMBLY_POLICY = "pinned-sdk-assemblies-v4";

/**
 * The byte budgets every capture path holds to, checked against a file's size before its bytes are
 * read. The journal's own limit falls back to the object limit. It counts against the whole dump's budget.
 */
export interface DumpLimits {
  readonly manifestBytes: number;
  readonly objectBytes: number;
  readonly totalBytes: number;
  readonly journalBytes?: number;
}

export const DEFAULT_LIMITS: DumpLimits = {
  manifestBytes: 16 * 1024 * 1024,
  objectBytes: 512 * 1024 * 1024,
  totalBytes: 4 * 1024 * 1024 * 1024,
  journalBytes: 2 * 1024 * 1024 * 1024,
};

export const JOURNAL_FILE = "events.jsonl";
export const CAPTURE_LOSS_FILE = "capture-loss.json";
export const CREDENTIAL_LOSS_RESERVE_FILE = "credential-loss.reserve";
export const CREDENTIAL_LOSS_RESERVE_BYTES = 4096;
export const OBJECTS_DIRECTORY = "objects";
export const RAW_JOURNAL_FILE = `journal/${JOURNAL_FILE}` as const;
export const journalObjectFile = (sha256: string) =>
  `journal/${OBJECTS_DIRECTORY}/${sha256}`;

export const captureFileLimit = (name: string, limits: DumpLimits) =>
  name === JOURNAL_FILE ||
  name === `capture/${JOURNAL_FILE}` ||
  name === RAW_JOURNAL_FILE
    ? Math.min(limits.journalBytes ?? limits.objectBytes, limits.totalBytes)
    : name === CAPTURE_LOSS_FILE || name === `capture/${CAPTURE_LOSS_FILE}`
      ? Math.min(limits.manifestBytes, limits.totalBytes)
      : name === CREDENTIAL_LOSS_RESERVE_FILE ||
          name === `capture/${CREDENTIAL_LOSS_RESERVE_FILE}`
        ? Math.min(CREDENTIAL_LOSS_RESERVE_BYTES, limits.totalBytes)
        : limits.objectBytes;

/** A JSON value as stored; anything JSON would drop or change (`undefined`, `NaN`) is refused. */
export type Json =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<Json>
  | { readonly [key: string]: Json };
export const Json: z.ZodType<Json> = z.json();

/** pi ids are numbers (`ConversationId`, `TaskId`, `EntryId` are branded numbers). */
const PiId = z.int().nonnegative();

/**
 * Where an event happened. `runId` always; the rest where the emitter knows it. The route's
 * provider knows the run, the agent and, through its route binding, the conversation.
 */
export const CaptureScope = z.strictObject({
  runId: z.string().min(1),
  stage: z.string().min(1).optional(),
  agent: z.string().min(1).optional(),
  conversationId: PiId.optional(),
  taskId: PiId.optional(),
  entryId: PiId.optional(),
});
export type CaptureScope = z.infer<typeof CaptureScope>;

/** Token counts as pi-ai's `Usage` reports them: `input` excludes cache reads and writes. */
export const TokenUsage = z.strictObject({
  input: z.int().nonnegative(),
  output: z.int().nonnegative(),
  cacheRead: z.int().nonnegative(),
  cacheWrite: z.int().nonnegative(),
  reasoning: z.int().nonnegative().optional(),
  totalTokens: z.int().nonnegative(),
});
export type TokenUsage = z.infer<typeof TokenUsage>;

/** pi-ai's `Usage` as a route hands it over: its token counts are kept, its `cost` and `cacheWrite1h` dropped. */
const UsageInput = TokenUsage.strip();

/**
 * Whether the route bills per token. A subscription route (the ChatGPT sign-in) has no per-token
 * price, so its cost stays unknown even where pi-ai's model table would price it.
 */
export const RoutePricing = z.enum(["subscription", "metered"]);
export type RoutePricing = z.infer<typeof RoutePricing>;

/**
 * A scored run is measured; a reading run (reasoning summaries on request) never is (10.10). A
 * coding run is the copied coding environment: never scored, never mixed into review metrics.
 */
export const RunKind = z.enum(["scored", "reading", "coding"]);
export type RunKind = z.infer<typeof RunKind>;

export const StageStatus = z.enum(["completed", "failed", "cutoff", "aborted"]);
export type StageStatus = z.infer<typeof StageStatus>;

/** Where a lead is handed on (10.145, 10.146), in pipeline order. */
export const LeadHandoff = z.enum([
  "find",
  "verify",
  "investigate",
  "rank",
  "assemble",
  "dispose",
  "publish",
]);
export type LeadHandoff = z.infer<typeof LeadHandoff>;

/**
 * A lead's fate at one hand-off. `handed-on` and `attached` (to a unit) keep it moving; the others
 * end its path. `below-cut` keeps its rank for the agent reader and evals (10.146).
 */
export const LeadFate = z.enum([
  "handed-on",
  "attached",
  "dropped",
  "below-cut",
  "published",
  "withheld",
]);
export type LeadFate = z.infer<typeof LeadFate>;

export const TERMINAL_FATES: ReadonlySet<LeadFate> = new Set([
  "dropped",
  "below-cut",
  "published",
  "withheld",
]);

/**
 * The request body as the provider sent it, parsed from the exact bytes on the wire after hooks,
 * pi-ai's conversion and the route's payload rewrite. A provider that could not read the body
 * (not a JSON string) says so: the call is then exported with a `request-missing` gap, never with
 * a body rebuilt from templates. The offered tool definitions are part of the body.
 */
export const RequestBody = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("sent"), json: Json }),
  z.strictObject({ status: z.literal("missing"), reason: z.string().min(1) }),
]);
export type RequestBody = z.infer<typeof RequestBody>;

/** A direct coding-model call made outside pi's native turn and usage ledger. */
export const AuxiliaryPurpose = z.enum(["caption", "recap"]);
export type AuxiliaryPurpose = z.infer<typeof AuxiliaryPurpose>;

const SdkCostRates = z.strictObject({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
});
export const SdkCost = SdkCostRates.extend({
  tiers: z
    .array(SdkCostRates.extend({ inputTokensAbove: z.number() }))
    .optional(),
});
export const SdkCompat = z.strictObject({
  supportsDeveloperRole: z.boolean().optional(),
  supportsMidConvoSystemMessages: z.boolean().optional(),
  sessionAffinityFormat: z
    .enum(["openai", "openai-nosession", "openrouter"])
    .optional(),
  supportsLongCacheRetention: z.boolean().optional(),
  supportsStrictMode: z.boolean().optional(),
  supportsOpenAIGrammarTools: z.boolean().optional(),
  supportsAdditionalTools: z.boolean().optional(),
  supportsToolSearch: z.boolean().optional(),
  supportsExplicitPromptCacheMode: z.boolean().optional(),
  supportsMaxOutputTokens: z.boolean().optional(),
  supportsEagerToolInputStreaming: z.boolean().optional(),
  sendSessionAffinityHeaders: z.boolean().optional(),
  supportsCacheControlOnTools: z.boolean().optional(),
  supportsTemperature: z.boolean().optional(),
  forceAdaptiveThinking: z.boolean().optional(),
  allowEmptySignature: z.boolean().optional(),
  supportsStrictTools: z.boolean().optional(),
  supportsMidConvoEffort: z.boolean().optional(),
  supportsMidConvoToolChanges: z.boolean().optional(),
  allowedFallbackModels: z
    .array(
      z.strictObject({
        provider: z.string(),
        model: z.string(),
        cost: SdkCost,
      }),
    )
    .optional(),
});
const SdkCommonOptions = z.strictObject({
  temperature: z.number().optional(),
  maxTokens: z.number().optional(),
  cacheRetention: z.enum(["none", "short", "long"]).optional(),
  sessionId: z.string().optional(),
  metadata: z.strictObject({ user_id: z.string().optional() }).optional(),
  samplingParams: z.record(z.string(), Json).optional(),
});
export const SdkInvocation = z.discriminatedUnion("api", [
  z.strictObject({
    version: z.literal(1),
    api: z.literal("openai-responses"),
    options: SdkCommonOptions.extend({
      reasoningEffort: z
        .enum(["minimal", "low", "medium", "high", "xhigh", "max"])
        .optional(),
      reasoningSummary: z
        .enum(["auto", "detailed", "concise"])
        .nullable()
        .optional(),
      serviceTier: z
        .enum(["auto", "default", "flex", "scale", "priority"])
        .nullable()
        .optional(),
      toolChoice: z
        .union([
          z.enum(["auto", "none", "required"]),
          z.strictObject({ type: z.literal("function"), name: z.string() }),
        ])
        .optional(),
    }),
  }),
  z.strictObject({
    version: z.literal(1),
    api: z.literal("anthropic-messages"),
    authMode: z.enum(["non-oauth", "oauth", "unknown"]),
    options: SdkCommonOptions.extend({
      thinkingEnabled: z.boolean().optional(),
      thinkingBudgetTokens: z.number().optional(),
      effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
      thinkingDisplay: z.enum(["summarized", "omitted"]).optional(),
      interleavedThinking: z.boolean().optional(),
      toolChoice: z
        .union([
          z.enum(["auto", "any", "none"]),
          z.strictObject({ type: z.literal("tool"), name: z.string() }),
        ])
        .optional(),
    }),
  }),
]);
export type SdkInvocation = z.infer<typeof SdkInvocation>;
export const SdkInvocationEnd = z.strictObject({
  version: z.literal(1),
  callId: z.string().min(1),
  callbacks: z.int().nonnegative(),
  abort: z.discriminatedUnion("status", [
    z.strictObject({ status: z.literal("not-aborted") }),
    z.strictObject({
      status: z.literal("aborted"),
      afterCallbacks: z.int().nonnegative(),
      boundary: z.literal("unresolved"),
      reason: z.discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("string"), value: z.string() }),
        z.strictObject({
          kind: z.literal("error"),
          name: z.string(),
          message: z.string(),
        }),
        z.strictObject({ kind: z.literal("unsupported") }),
      ]),
    }),
  ]),
});
export type SdkInvocationEnd = z.infer<typeof SdkInvocationEnd>;
export const SdkContext = z.strictObject({
  version: z.literal(1),
  sdkPin: z.literal(RETAINED_SDK_PIN),
  callId: z.string().min(1),
  stage: z.literal("provider-input"),
  model: z.strictObject({
    id: z.string(),
    provider: z.string(),
    api: z.enum(["openai-responses", "anthropic-messages"]),
    reasoning: z.boolean(),
    cost: SdkCost.optional(),
    input: z.array(z.enum(["text", "image"])).optional(),
    compat: SdkCompat.optional(),
  }),
  messages: z.array(Json),
  invocation: SdkInvocation.optional(),
  unavailableReason: z.string().min(1).optional(),
});
export type SdkContext = z.infer<typeof SdkContext>;

const ModelRequest = z
  .strictObject({
    type: z.literal("model.request"),
    scope: CaptureScope,
    purpose: AuxiliaryPurpose.optional(),
    /** Unique per provider call within the run; the route's provider mints it. */
    callId: z.string().min(1),
    /** Neuve's route name (`chatgpt`, `anthropic`). */
    route: z.string().min(1),
    /** The provider and model the request physically went to; datasets attribute turns to these. */
    provider: z.string().min(1),
    model: z.string().min(1),
    /** The stable logical provider route of the agent conversation (provider-runtime binding); provenance only. */
    logicalRoute: z.string().min(1).optional(),
    api: z.string().min(1).optional(),
    /** The URL path only; never the query or host credentials. */
    path: z.string().optional(),
    /** Request header names only. There is no field for header values. */
    headerNames: z.array(z.string()),
    credentialCoverage: z.enum(["required", "none"]).optional(),
    body: RequestBody,
    sdkContext: SdkContext.optional(),
  })
  .refine(
    (request) =>
      request.purpose === undefined ||
      request.scope.conversationId !== undefined,
    {
      message: "an auxiliary request names its native conversation",
      path: ["scope", "conversationId"],
    },
  );

const ModelResponse = z.strictObject({
  type: z.literal("model.response"),
  scope: CaptureScope,
  callId: z.string().min(1),
  status: z.int(),
  requestId: z.string().optional(),
  /** The response ID as soon as the provider gives it (`response.created`), so a call cut off mid-stream still joins its partial turn. */
  responseId: z.string().optional(),
});

/**
 * A provider stream event the route keeps, as the provider sent it: lifecycle (created, completed,
 * failed), rate limits, `response.output_item.done` for each function call (whose `arguments`
 * string is the model's raw text beside pi's parsed arguments), and the parsed deltas, so a call
 * cut off mid-stream or by a crash is still whole up to its last event. Reasoning summary and
 * thinking deltas and signatures are kept too: the restricted capture holds them exactly and never
 * prints them, and a portable copy withholds them.
 */
const ModelEvent = z.strictObject({
  type: z.literal("model.event"),
  scope: CaptureScope,
  callId: z.string().min(1),
  name: z.string().min(1),
  data: Json,
});

const ModelEnd = z.strictObject({
  type: z.literal("model.end"),
  scope: CaptureScope,
  callId: z.string().min(1),
  outcome: z.enum(["completed", "failed", "aborted"]),
  /** The provider's response ID; pi stores the same one on the assistant message, which is the join. */
  responseId: z.string().optional(),
  /**
   * The `timestamp` of the assistant message the provider handed pi. pi stores that message as is,
   * so this joins a call that has no response ID (one that failed before the provider answered) to
   * its stored turn exactly.
   */
  messageTimestamp: z.number().optional(),
  stopReason: z.string().optional(),
  usage: UsageInput.optional(),
  /** SDK accounting, distinct from the route's actual billing. */
  sdkUsage: PiUsage.optional(),
  error: z
    .strictObject({ type: z.string().optional(), message: z.string() })
    .optional(),
});

/**
 * The reviewed head commit, or, for a coding run in a project that is not a Git repository, why
 * there is none. A revision is never invented.
 */
export const SourceRevision = z.union([
  z.string().min(1),
  z.strictObject({
    status: z.literal("not-applicable"),
    reason: z.string().min(1),
  }),
]);
export type SourceRevision = z.infer<typeof SourceRevision>;

const RunStart = z
  .strictObject({
    type: z.literal("run.start"),
    scope: CaptureScope,
    runKind: RunKind,
    sourceRevision: SourceRevision,
    /** The Neuve commit the harness ran from, where known. */
    harnessRevision: z.string().min(1).optional(),
    route: z.string().min(1),
    pricing: RoutePricing,
  })
  .refine(
    (start) =>
      start.runKind === "coding" || typeof start.sourceRevision === "string",
    {
      message: "a review run names its source revision",
      path: ["sourceRevision"],
    },
  );

/**
 * Binds one pi conversation to Neuve's identities; task-owned children inherit it through pi's
 * owner edge. A review conversation names its stage and agent; a coding conversation may name
 * neither, and none is guessed.
 */
const SessionBind = z.strictObject({
  type: z.literal("session.bind"),
  scope: CaptureScope.required({ conversationId: true }),
  computationId: z.string().min(1).optional(),
});

const LeadFateEvent = z.strictObject({
  type: z.literal("lead.fate"),
  scope: CaptureScope.required({ stage: true }),
  leadId: z.string().min(1),
  handoff: LeadHandoff,
  fate: LeadFate,
  reason: z.string().optional(),
  rank: z.int().nonnegative().optional(),
  cut: z.int().nonnegative().optional(),
  unitId: z.string().optional(),
  findId: z.string().optional(),
  publicationId: z.string().optional(),
  /**
   * A retained capture's context-reference target. A lead attached
   * to several units has one per target; fates before Publish name none.
   */
  referenceId: z.string().min(1).optional(),
});

const StageEnd = z.strictObject({
  type: z.literal("stage.end"),
  scope: CaptureScope.required({ stage: true }),
  status: StageStatus,
  reason: z.string().optional(),
});

const RunEnd = z.strictObject({
  type: z.literal("run.end"),
  scope: CaptureScope,
  status: StageStatus,
  publicationId: z.string().optional(),
});

/** A durable external output, as the journal stores it: its bytes are kept under their hash. */
const ArtifactStored = z.strictObject({
  type: z.literal("artifact"),
  scope: CaptureScope,
  name: z.string().min(1),
  mediaType: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size: z.int().nonnegative(),
});

export const CredentialCertificate = z
  .strictObject({
    type: z.literal("credential.inspection"),
    scope: CaptureScope.pick({ runId: true }),
    callId: z.string().min(1),
    version: z.literal(3),
    epochId: z.string().min(1),
    calls: z.array(z.string().min(1)).min(1),
    retainedPrefixCalls: z.array(z.string().min(1)),
    administration: z.literal("canonical-inspected-v1"),
    administrationHash: z.string().regex(/^[0-9a-f]{64}$/),
    sourceHash: z.string().regex(/^[0-9a-f]{64}$/),
    sourceHashes: z.array(z.string().regex(/^[0-9a-f]{64}$/)),
    safe: z.boolean(),
  })
  .refine(
    (event) =>
      event.calls.includes(event.callId) &&
      new Set(event.calls).size === event.calls.length &&
      event.retainedPrefixCalls.every((call) => event.calls.includes(call)) &&
      new Set(event.retainedPrefixCalls).size ===
        event.retainedPrefixCalls.length,
    "invalid credential epoch membership",
  );
export type CredentialCertificate = z.infer<typeof CredentialCertificate>;

/** An event an emitter hands over, as the journal stores it. */
export const CapturedEvent = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("native.import"),
    scope: CaptureScope.pick({ runId: true }),
    origin: z.enum(["external-seed", "detached-backup", "inherited-native"]),
  }),
  z.strictObject({
    type: z.literal("credential.registration"),
    scope: CaptureScope.pick({ runId: true }),
    callId: z.string().min(1),
    epochId: z.string().min(1),
    policy: z.literal(CREDENTIAL_INSPECTION_POLICY),
  }),
  z.strictObject({
    type: z.literal("credential.guard"),
    scope: CaptureScope.pick({ runId: true }),
    callId: z.string().min(1),
    status: z.enum(["pending", "observed", "exposed"]),
  }),
  z.discriminatedUnion("version", [
    z.strictObject({
      type: z.literal("credential.inspection"),
      scope: CaptureScope.pick({ runId: true }),
      callId: z.string().min(1),
      version: z.literal(2),
      sourceHash: z.string().regex(/^[0-9a-f]{64}$/),
      sourceHashes: z.array(z.string().regex(/^[0-9a-f]{64}$/)),
      safe: z.boolean(),
    }),
    CredentialCertificate,
  ]),
  ModelRequest,
  ModelResponse,
  ModelEvent,
  ModelEnd,
  RunStart,
  SessionBind,
  z.strictObject({
    type: z.literal("findings.returned"),
    scope: CaptureScope.required({ stage: true }),
    findingIds: z.array(z.string().min(1)),
  }),
  LeadFateEvent,
  StageEnd,
  RunEnd,
  ArtifactStored,
]);
export type CapturedEvent = z.infer<typeof CapturedEvent>;

/**
 * The journal's own marks, never emitted by a caller. Each process that opens the journal starts a
 * session with `journal.open` and ends it with `journal.close` only while every capture succeeded.
 * A session with no close (a crash, or a capture that failed) is disclosed; `journal.failed` adds
 * the reason when the failure left the journal writable.
 */
export const JournalMark = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("journal.open"),
    scope: CaptureScope.pick({ runId: true }),
    credentialLossReserve: z.literal(true).optional(),
  }),
  z.strictObject({
    type: z.literal("journal.close"),
    scope: CaptureScope.pick({ runId: true }),
  }),
  z.strictObject({
    type: z.literal("journal.failed"),
    scope: CaptureScope.pick({ runId: true }),
    reason: z.string(),
  }),
]);
export type JournalMark = z.infer<typeof JournalMark>;

/** A journal line: the event or mark, its order in the run and when it was recorded (epoch ms). */
export const JournalLine = z.strictObject({
  v: z.literal(CAPTURE_VERSION),
  seq: z.int().positive(),
  at: z.number(),
  event: z.union([CapturedEvent, JournalMark]),
});
export type JournalLine = z.infer<typeof JournalLine>;

export type ModelCaptureEvent = Extract<
  CapturedEvent,
  { type: `model.${string}` | "credential.registration" | "credential.guard" }
>;

/** Synchronous artifact admission privately persists bytes before returning; the caller may then reuse its buffer. */
export interface ArtifactCapture {
  readonly type: "artifact";
  readonly scope: CaptureScope;
  readonly name: string;
  /** A JSON media type (`application/json`, `…+json`) must carry JSON; it is masked as JSON on export. */
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

export type CaptureEvent =
  Exclude<CapturedEvent, { type: "artifact" }> | ArtifactCapture;

/**
 * Why an event was not kept. `invalid`: it failed its schema or belongs to another run (an
 * emitter's defect). `io`: the bytes could not be written. `full`: the capture reached a byte limit.
 * `failed`: an earlier capture in this process failed, so nothing more is accepted.
 */
export class CaptureFailed extends Data.TaggedError("CaptureFailed")<{
  readonly kind: "invalid" | "io" | "full" | "failed";
  readonly event: string;
  readonly detail: string;
  readonly journalFull?: boolean;
  readonly writeCode?: string;
}> {
  override get message(): string {
    return this.detail;
  }

  get lossReason(): CaptureLoss["reason"] {
    if (this.kind === "full")
      return this.journalFull ? "journal limit" : "object limit";
    switch (this.writeCode) {
      case "EACCES":
      case "EPERM":
        return "permission denied";
      case "ENOSPC":
      case "SQLITE_FULL":
        return "disk full";
      default:
        return "I/O error";
    }
  }
}

/** Appends synchronously or throws `CaptureFailed`. */
export type Capture = ModelCapture & ((event: CaptureEvent) => void);

const CaptureLossFields = z.strictObject({
  kind: z.enum(["io", "full"]),
  reason: z.enum([
    "journal limit",
    "object limit",
    "permission denied",
    "disk full",
    "I/O error",
  ]),
  at: z.iso.datetime(),
});
export const CaptureLoss = z.discriminatedUnion("event", [
  CaptureLossFields.extend({
    event: z.literal("journal.open"),
    sessionId: z.uuid(),
  }),
  CaptureLossFields.extend({
    callId: z.uuid(),
    event: z.enum([
      "credential.registration",
      "model.request",
      "model.response",
      "model.event",
      "model.end",
    ]),
    credentialCoverage: z.literal("required").optional(),
    epochId: z.uuid().optional(),
  }),
]);
export type CaptureLoss = z.infer<typeof CaptureLoss>;

export const captureLossId = (loss: CaptureLoss) =>
  loss.event === "journal.open" ? loss.sessionId : loss.callId;

export type ModelCapture = ((event: ModelCaptureEvent) => void) & {
  readonly recordLoss?: (
    loss: CaptureLoss,
    journalFull: boolean,
    privateRegistrationFailed?: boolean,
  ) => void;
  readonly journalFull?: () => boolean;
  readonly allowCredentialLoss?: () => boolean;
};
