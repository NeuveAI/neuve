import { z } from "zod";
import { PiUsage } from "./usage.ts";
import { ContractContextCapture } from "./contract-types.ts";
import {
  AuxiliaryPurpose,
  CaptureScope,
  Json,
  RAW_JOURNAL_FILE,
  LeadFate,
  LeadHandoff,
  RequestBody,
  SdkContext,
  RoutePricing,
  RunKind,
  SourceRevision,
  StageStatus,
  TokenUsage,
} from "./types.ts";

/**
 * The session dump's files (10.148, review parity §7): `run.json`, one `sessions/<id>.json` per pi
 * conversation (root and task-owned children alike), `calls/unjoined.json` for calls no stored turn
 * answers, each artifact under `artifacts/<n>` (its original beside it as `artifacts/<n>.original`),
 * pi's native SQLite backup as `native/pi.sqlite` and the capture journal's exact bytes as
 * `journal/events.jsonl`. Session files carry pi's own records (entries, tasks, documents) with
 * identifiers masked in their content and provider continuation kept, and add what is derived from
 * them and the capture journal: turns with their usage, times and call, the tool definitions
 * offered, the binding to Neuve's identities, and totals. Those JSON files are the sanitized
 * inspection form; the originals are the native backup (pi's state) and the raw journal (the
 * requests and provider events as captured), which only a restricted capture carries.
 */

const PiId = z.int().nonnegative();
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

/** A rate an estimate was made with, named and versioned so an estimate is never mistaken for a price. */
export const PriceRate = z.strictObject({
  name: z.string().min(1),
  version: z.int().positive(),
  currency: z.literal("USD"),
  /** Where the rate was read and when; an unchecked rate says so. */
  source: z.string().min(1),
  perMillionTokens: z.strictObject({
    input: z.number().nonnegative(),
    cacheRead: z.number().nonnegative(),
    cacheWrite: z.number().nonnegative(),
    output: z.number().nonnegative(),
  }),
});
export type PriceRate = z.infer<typeof PriceRate>;

export const Cost = z.strictObject({
  recorded: z.discriminatedUnion("status", [
    z.strictObject({ status: z.literal("unknown"), reason: z.string() }),
    z.strictObject({
      status: z.literal("recorded"),
      total: z.number(),
      currency: z.literal("USD"),
    }),
  ]),
  estimate: z.strictObject({ rate: z.string(), total: z.number() }).nullable(),
});
export type Cost = z.infer<typeof Cost>;

export const Totals = z.strictObject({ tokens: TokenUsage, cost: Cost });
export type Totals = z.infer<typeof Totals>;

/** How a call was matched to what pi stored. */
export const CallRole = z.enum([
  /** It produced a stored turn, matched by response ID or by the message's exact timestamp. */
  "turn",
  /** A declared caption/recap, or a compaction summary pi's usage ledger accounts for exactly. */
  "non-turn",
  /** pi holds only its live partial (`pi.live`), matched by response ID: work in flight, not lost. */
  "in-flight",
  /** Nothing pi stored accounts for it. */
  "unjoined",
]);
export type CallRole = z.infer<typeof CallRole>;

/** One model call from the journal, its body and events masked; `run.journal` keeps them as captured. */
export const CallRecord = z
  .strictObject({
    callId: z.string(),
    role: CallRole,
    scope: CaptureScope,
    /** Caller-declared auxiliary purpose; absent for native turns and inferred compaction. */
    purpose: AuxiliaryPurpose.optional(),
    route: z.string(),
    logicalRoute: z.string().optional(),
    provider: z.string(),
    model: z.string(),
    api: z.string().optional(),
    path: z.string().optional(),
    headerNames: z.array(z.string()),
    credentialCoverage: z.enum(["required", "none"]),
    body: RequestBody,
    sdkContext: SdkContext.optional(),
    requestedAt: z.number(),
    response: z
      .strictObject({
        at: z.number(),
        scope: CaptureScope.optional(),
        status: z.int(),
        requestId: z.string().optional(),
        responseId: z.string().optional(),
      })
      .nullable(),
    events: z.array(
      z.strictObject({
        at: z.number(),
        scope: CaptureScope.optional(),
        name: z.string(),
        data: Json,
      }),
    ),
    end: z
      .strictObject({
        at: z.number(),
        scope: CaptureScope.optional(),
        outcome: z.enum(["completed", "failed", "aborted"]),
        responseId: z.string().optional(),
        messageTimestamp: z.number().optional(),
        stopReason: z.string().optional(),
        usage: TokenUsage.optional(),
        sdkUsage: PiUsage.optional(),
        error: z
          .strictObject({ type: z.string().optional(), message: z.string() })
          .optional(),
      })
      .nullable(),
  })
  .refine(
    (call) =>
      call.purpose === undefined ||
      (call.scope.conversationId !== undefined && call.role === "non-turn"),
    {
      message:
        "an auxiliary call is non-turn and names its native conversation",
    },
  );
export type CallRecord = z.infer<typeof CallRecord>;

/** One model response pi stored, with its usage, its times and the call that produced it where captured. */
export const Turn = z.strictObject({
  entryId: PiId,
  /** The generation task that appended it; absent for a partial pi converted outside a task. */
  taskId: PiId.optional(),
  provider: z.string(),
  model: z.string(),
  responseId: z.string().optional(),
  stopReason: z.string(),
  errorMessage: z.string().optional(),
  /** The message's own timestamp, set by the provider as the response began. */
  messageTimestamp: z.number(),
  /** When the call was dispatched, answered and settled, from the journal; null when no call joined. */
  requestedAt: z.number().nullable(),
  respondedAt: z.number().nullable(),
  endedAt: z.number().nullable(),
  tokens: TokenUsage,
  cost: Cost,
  callId: z.string().nullable(),
  join: z.enum(["response-id", "message-timestamp"]).nullable(),
  /** Each tool call with the entry holding its result; null while no result is stored. */
  toolCalls: z.array(
    z.strictObject({
      id: z.string(),
      name: z.string(),
      resultEntryId: PiId.nullable(),
    }),
  ),
});
export type Turn = z.infer<typeof Turn>;

/** A review conversation's binding names its stage and agent; a coding conversation's may name neither. */
export const Binding = z.strictObject({
  stage: z.string().optional(),
  agent: z.string().optional(),
  taskId: PiId.optional(),
  computationId: z.string().optional(),
  /** Set on a child conversation, which takes its binding from the conversation that owns it. */
  inheritedFrom: PiId.optional(),
});
export type Binding = z.infer<typeof Binding>;

export const StoredDocument = z.strictObject({
  kind: z.string(),
  key: z.string().optional(),
  version: z.int(),
  value: Json,
});
export type StoredDocument = z.infer<typeof StoredDocument>;

export const SessionDump = z.strictObject({
  conversationId: PiId,
  parent: z.strictObject({ conversationId: PiId, at: PiId }).optional(),
  owner: z.strictObject({ conversationId: PiId, taskId: PiId }).optional(),
  binding: Binding.nullable(),
  /** How the stage that ran it ended; `unknown` when no `stage.end` was captured. */
  status: z.union([StageStatus, z.literal("unknown")]),
  /** pi's entries this conversation appended, oldest first; a fork's inherited ones stay with its parent. */
  entries: z.array(Json),
  tasks: z.array(Json),
  documents: z.array(StoredDocument),
  taskDocuments: z.array(
    z.strictObject({ taskId: PiId, documents: z.array(StoredDocument) }),
  ),
  /** Every tool change a `pi.system` entry made, with the complete definitions it offered. */
  offeredTools: z.array(
    z.strictObject({
      entryId: PiId,
      added: z.array(Json),
      removed: z.array(z.string()),
    }),
  ),
  turns: z.array(Turn),
  compactions: z.array(
    z.strictObject({
      entryId: PiId,
      head: PiId.optional(),
      reason: z.string().optional(),
    }),
  ),
  /** `pi.live`'s run, generation and tool round when the capture found work still running: the partial answer and tool output. */
  inFlight: Json.nullable(),
  /** Calls that produced stored turns, plus declared direct caption and recap calls. */
  calls: z.array(CallRecord),
  totals: z.strictObject({
    /** Summed over this conversation's stored turns. */
    turns: Totals,
    /** pi's own ledger (`pi.usage`), which also counts compaction summaries; null when pi kept none. */
    ledger: Totals.nullable(),
    /** Sum of reported model.end usage for declared caption/recap calls, outside pi.usage; gaps disclose missing usage. */
    auxiliary: Totals.optional(),
  }),
});
export type SessionDump = z.infer<typeof SessionDump>;

/**
 * Every fate a lead met, in the order captured, and what they add up to whatever that order. A lead
 * attached to several units reaches Publish once per target, and each target keeps its own outcome:
 * a later fate never undoes an earlier terminal one.
 */
export const LeadLedger = z.strictObject({
  leadId: z.string(),
  fates: z.array(
    z.strictObject({
      seq: z.int(),
      stage: z.string(),
      handoff: LeadHandoff,
      fate: LeadFate,
      reason: z.string().optional(),
      rank: z.int().optional(),
      cut: z.int().optional(),
      unitId: z.string().optional(),
      findId: z.string().optional(),
      publicationId: z.string().optional(),
      referenceId: z.string().optional(),
    }),
  ),
  /** Each Publish target by its reference, sorted, with the terminal fates it reached; none while it is open. */
  targets: z.array(
    z.strictObject({ referenceId: z.string(), terminal: z.array(LeadFate) }),
  ),
  /** Every terminal fate the lead reached on any path or target, in `LeadFate` order. */
  terminal: z.array(LeadFate),
  /**
   * `published` when any target was published; otherwise the one terminal fate all of them agree
   * on; null while none was reached, or when different ones were and nothing was published.
   */
  final: LeadFate.nullable(),
});
export type LeadLedger = z.infer<typeof LeadLedger>;

export const GapCode = z.enum([
  /** Journal lines cut short by a crash mid-append. */
  "journal-torn",
  /** The capture records which evidence was lost and why. */
  "journal-failed",
  /** A process's journal session ended without its clean close: a crash, or a failed capture. */
  "journal-interrupted",
  "run-start-missing",
  "run-start-conflict",
  "run-end-missing",
  /** A scored run's requests asked for reasoning summaries (10.10). */
  "scored-with-summaries",
  "session-unbound",
  /** A scored or reading run's conversation bound without the stage or agent it belongs to. */
  "session-unattributed",
  "stage-end-missing",
  /** A conversation or task names an owner the storage does not hold. */
  "edge-missing",
  /** Tasks not yet terminal, or a `pi.live` generation or tool round, at capture. */
  "work-in-flight",
  "request-missing",
  /** Calls dispatched that never settled (a crash or a cut mid-stream). */
  "calls-unended",
  /** A declared auxiliary call settled without final token usage. */
  "auxiliary-usage-missing",
  "calls-unjoined",
  /** pi's usage ledgers count tokens beyond the stored turns that the unjoined calls do not match. */
  "ledger-unreconciled",
  "turns-uncaptured",
  /** A turn's stored usage differs from its call's. */
  "usage-mismatch",
  "tool-results-missing",
  /** A tool call ran (its result is not `tool_unavailable`) without a definition any `pi.system` entry offered. */
  "tool-definitions-missing",
  /** Finders returned findings but none received a fate. */
  "lead-fates-absent",
  "leads-open",
]);
export type GapCode = z.infer<typeof GapCode>;

/**
 * What a run still owes while it runs: a held, interrupted or coding snapshot is open, and these are
 * work it has not done yet, not capture it lost. Once `run.end` is captured nothing is owed any more,
 * so the same codes are missing evidence and count against completeness.
 */
export const EXECUTION_GAPS: ReadonlySet<GapCode> = new Set<GapCode>([
  "run-end-missing",
  "stage-end-missing",
  "work-in-flight",
  "tool-results-missing",
  "lead-fates-absent",
  "leads-open",
]);

export const Gap = z.strictObject({
  code: GapCode,
  /** `capture`: evidence the dump lacks. `execution`: work an open run has not done yet. */
  kind: z.enum(["capture", "execution"]),
  count: z.int().nonnegative(),
  detail: z.string(),
});
export type Gap = z.infer<typeof Gap>;

/** `held`: the job waits for a claim with the credential. `interrupted`: a later claim resumes it. `ended`: the job is over. */
export const CloseMode = z.enum(["held", "interrupted", "ended"]);
export type CloseMode = z.infer<typeof CloseMode>;

export const NATIVE_BACKUP_FILE = "native/pi.sqlite";
export const NATIVE_BACKUP_MEDIA_TYPE = "application/vnd.sqlite3";

/**
 * Whether the dump holds pi's exact native state: a consistent SQLite copy taken with `VACUUM INTO`,
 * WAL-committed state included, that pi's own storage opens again. Separate from `complete`, which
 * is about what was observed. A portable copy withholds it.
 */
export const BackupStatus = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("captured"),
    format: z.literal("sqlite"),
    file: z.literal(NATIVE_BACKUP_FILE),
    sha256: Sha256,
    size: z.int().nonnegative(),
  }),
  z.strictObject({ status: z.literal("unavailable"), reason: z.string() }),
  z.strictObject({ status: z.literal("withheld"), reason: z.string() }),
]);
export type BackupStatus = z.infer<typeof BackupStatus>;

export { RAW_JOURNAL_FILE, journalObjectFile } from "./types.ts";
export const RAW_JOURNAL_MEDIA_TYPE = "application/x-ndjson";

/**
 * The journal file and its referenced objects preserve the original calls behind the masked session
 * files. A close receipt checks those hashes before removing the run folder.
 */
export const RawJournal = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("captured"),
    file: z.literal(RAW_JOURNAL_FILE),
    sha256: Sha256,
    size: z.int().nonnegative(),
    objects: z
      .array(z.strictObject({ sha256: Sha256, size: z.int().nonnegative() }))
      .optional(),
  }),
  z.strictObject({ status: z.literal("unavailable"), reason: z.string() }),
  z.strictObject({ status: z.literal("withheld"), reason: z.string() }),
]);
export type RawJournal = z.infer<typeof RawJournal>;

/**
 * A durable external output. Text and JSON are sanitized (identifiers and credentials masked over
 * parsed values); anything else is kept raw and uninspected, never claimed masked. `file` holds the
 * bytes this dump carries and `original` the bytes as captured; a portable copy drops the original
 * and every raw artifact, so their files are null and only the restricted capture can recompute them.
 */
export const ArtifactRecord = z.strictObject({
  scope: CaptureScope,
  name: z.string(),
  mediaType: z.string(),
  sanitization: z.enum(["sanitized", "raw-uninspected"]),
  file: z.string().nullable(),
  sha256: Sha256.nullable(),
  size: z.int().nonnegative().nullable(),
  original: z.strictObject({
    sha256: Sha256,
    size: z.int().nonnegative(),
    file: z.string().nullable(),
  }),
});
export type ArtifactRecord = z.infer<typeof ArtifactRecord>;

export const RunDump = z.strictObject({
  runId: z.string(),
  /** Null when no `run.start` was captured: such a dump is never filed as a dataset. */
  runKind: RunKind.nullable(),
  sourceRevision: SourceRevision.nullable(),
  harnessRevision: z.string().optional(),
  route: z.string().nullable(),
  pricing: RoutePricing.nullable(),
  status: z.union([StageStatus, z.literal("unknown")]),
  /** `ended` only once `run.end` was captured; a held, interrupted or coding snapshot is `open`. */
  execution: z.enum(["ended", "open"]),
  publicationId: z.string().optional(),
  /** The close this snapshot was taken at; null for one taken outside a close, such as a coding session's direct export. */
  close: CloseMode.nullable(),
  rate: PriceRate.nullable(),
  backup: BackupStatus,
  journal: RawJournal,
  stages: z.array(
    z.strictObject({
      stage: z.string(),
      status: z.union([StageStatus, z.literal("unknown")]),
      reason: z.string().optional(),
      sessions: z.array(PiId),
      /** pi's ledgers summed over the stage's sessions, children included. */
      totals: Totals,
    }),
  ),
  /** pi's ledgers summed over every conversation. */
  totals: Totals,
  sessions: z.array(z.strictObject({ conversationId: PiId, file: z.string() })),
  /** Declared contract observations, never byte-exact provider evidence. Absent on historical pi runs. */
  contractContexts: z.array(ContractContextCapture).optional(),
  sessionDocuments: z.array(StoredDocument),
  leads: z.strictObject({
    /** How many fates each hand-off produced; a zero is a producer that emitted nothing. */
    handoffs: z.strictObject({
      find: z.int().nonnegative().default(0),
      verify: z.int().nonnegative().default(0),
      investigate: z.int().nonnegative(),
      rank: z.int().nonnegative(),
      assemble: z.int().nonnegative(),
      dispose: z.int().nonnegative(),
      publish: z.int().nonnegative(),
    }),
    ledger: z.array(LeadLedger),
    /** Leads with no terminal fate, or with a Publish target that has none. */
    open: z.array(z.string()),
  }),
  artifacts: z.array(ArtifactRecord),
  gaps: z.array(Gap),
  /**
   * True only with no gap of kind `capture`. An open run's owed work does not count; an ended run's
   * does, so an ended run is complete only with no gap at all.
   */
  complete: z.boolean(),
});
export type RunDump = z.infer<typeof RunDump>;
