import type { InspectionBudget } from "./credential-detectors.ts";
import {
  contractContexts,
  contractContextGaps,
  contractTotals,
} from "./contract-context.ts";
import { withRetainedSdk } from "./retained-sdk.ts";
import { z } from "zod";
import { callsOf, outcomeOfStop } from "./call-lifecycle.ts";
import { compatibleScope, nativeScopes } from "./scope.ts";
import {
  providerOutput,
  reconcileProviderOutput,
  ResponseMessage,
  type OriginalResponseFacts,
} from "./provider-output.ts";
import { maskText } from "../../masking.ts";
import {
  PiUsage,
  PiUsageDoc,
  ZERO,
  addTokens,
  sameTokens,
  tokensOf,
  costOf,
  addTotals,
  accountUsage,
  sameUsageBucket,
  sameUsage,
  type UsageAccounting,
} from "./usage.ts";
import {
  CallRecord,
  EXECUTION_GAPS,
  RunDump,
  SessionDump,
  type ArtifactRecord,
  type BackupStatus,
  type Binding,
  type CallRole,
  type Gap,
  type LeadLedger,
  type RawJournal,
  type Turn,
  type Totals,
} from "./dump.ts";
import { LOST_WRITE_PREFIX, sha256Of } from "./journal.ts";
import {
  maskArtifact,
  restrictCall,
  restrictRun,
  restrictSession,
} from "./mask.ts";
import {
  Json,
  CaptureScope,
  LeadFate,
  TERMINAL_FATES,
  type LeadHandoff,
  type CapturedEvent,
  type JournalLine,
} from "./types.ts";
import {
  DumpFailed,
  type NativeSnapshot,
  type NativeConversation,
  type ProjectionRecipe,
} from "./sources.ts";

export interface RawCaptureSources {
  readonly native: NativeSnapshot;
  readonly lines: ReadonlyArray<JournalLine>;
  readonly tornLines: number;
  readonly backup: BackupStatus;
  readonly journal: RawJournal;
  readonly artifacts: ReadonlyArray<{
    readonly event: Extract<CapturedEvent, { type: "artifact" }>;
    readonly bytes: Uint8Array;
  }>;
}
export interface CanonicalProjection {
  readonly run: RunDump;
  readonly sessions: ReadonlyArray<SessionDump>;
  readonly unjoined: ReadonlyArray<CallRecord>;
  readonly artifacts: ReadonlyArray<{
    readonly name: string;
    readonly mediaType: string;
    readonly bytes: Uint8Array;
  }>;
}
const PiToolCall = z.object({
  type: z.literal("toolCall"),
  id: z.string(),
  name: z.string(),
});
const PiAssistant = z.object({
  api: z.string().optional(),
  role: z.literal("assistant"),
  content: z.array(z.object({ type: z.string() }).catchall(Json)),
  responseModel: z.string().optional(),
  rawStopReason: z.string().optional(),
  diagnostics: ResponseMessage.shape.diagnostics,
  provider: z.string(),
  model: z.string(),
  responseId: z.string().optional(),
  stopReason: z.string(),
  errorMessage: z.string().optional(),
  timestamp: z.number(),
  usage: PiUsage,
});
const PiSystem = z.object({
  role: z.literal("system"),
  toolsAdded: z.array(z.object({ name: z.string() }).loose()).optional(),
  toolsRemoved: z.array(z.object({ name: z.string() })).optional(),
});
const PiToolResult = z.object({
  role: z.literal("toolResult"),
  toolCallId: z.string(),
  toolName: z.string(),
  usage: PiUsage.optional(),
});
const PiToolResultData = z.object({
  diagnostics: z.array(z.object({ code: z.string() }).loose()),
});
const PiLive = z.object({
  run: z.unknown().optional(),
  generation: z.unknown().optional(),
  tools: z.unknown().optional(),
});
const LivePartial = z.object({
  generation: z.object({ message: z.object({ responseId: z.string() }) }),
});
const RequestedSummary = z.object({
  reasoning: z.object({ summary: z.string() }),
});

const parse = <T>(schema: z.ZodType<T>, value: unknown, what: string): T => {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new DumpFailed({
      reason: `${what}: ${parsed.error.issues[0]?.message ?? "unexpected shape"}`,
    });
  return parsed.data;
};

/** A record pi handed over, checked as JSON before it enters the dump. */
const asJson = (value: unknown, what: string): Json =>
  parse(Json, value, `${what} is not JSON`);

type Event<T extends CapturedEvent["type"]> = Extract<
  CapturedEvent,
  { type: T }
>;

/** Distinct fates in `LeadFate` order, so a summary never depends on the order events came in. */
const terminalOf = (fates: ReadonlyArray<{ readonly fate: LeadFate }>) =>
  LeadFate.options.filter(
    (fate) => TERMINAL_FATES.has(fate) && fates.some((f) => f.fate === fate),
  );

const ledgerOf = (lines: ReadonlyArray<JournalLine>): Array<LeadLedger> => {
  const fates = new Map<string, Array<LeadLedger["fates"][number]>>();
  for (const { seq, event } of lines) {
    if (event.type === "findings.returned")
      for (const id of event.findingIds) if (!fates.has(id)) fates.set(id, []);
    if (event.type !== "lead.fate") continue;
    fates.set(event.leadId, [
      ...(fates.get(event.leadId) ?? []),
      {
        seq,
        stage: event.scope.stage,
        handoff: event.handoff,
        fate: event.fate,
        reason: event.reason,
        rank: event.rank,
        cut: event.cut,
        unitId: event.unitId,
        findId: event.findId,
        publicationId: event.publicationId,
        referenceId: event.referenceId,
      },
    ]);
  }
  return [...fates].map(([leadId, history]) => {
    const terminal = terminalOf(history);
    return {
      leadId,
      fates: history,
      targets: [...new Set(history.flatMap((f) => f.referenceId ?? []))]
        .toSorted()
        .map((referenceId) => ({
          referenceId,
          terminal: terminalOf(
            history.filter((f) => f.referenceId === referenceId),
          ),
        })),
      terminal,
      final: terminal.includes("published")
        ? "published"
        : terminal.length === 1
          ? terminal[0]!
          : null,
    };
  });
};

/**
 * Each process session of the journal, named by the line that opened it: whether it closed cleanly,
 * and why one failed where that was written. A run reopened after a clean close starts a new clean
 * session; an earlier unclean one stays disclosed on its own.
 */
const sessionsOf = (lines: ReadonlyArray<JournalLine>) => {
  const sessions: Array<{
    opened: number;
    closed: boolean;
    failures: Array<string>;
    lostWrites: Array<string>;
  }> = [];
  for (const { seq, event } of lines) {
    if (event.type === "journal.open")
      sessions.push({
        opened: seq,
        closed: false,
        failures: [],
        lostWrites: [],
      });
    const current = sessions.at(-1);
    if (current === undefined) continue;
    if (event.type === "journal.close") current.closed = true;
    if (event.type === "journal.failed") {
      if (event.reason.startsWith(LOST_WRITE_PREFIX))
        current.lostWrites.push(event.reason.slice(LOST_WRITE_PREFIX.length));
      else current.failures.push(event.reason);
    }
  }
  return sessions;
};

export const deriveCapture = async (
  runId: string,
  sources: RawCaptureSources,
  recipe: ProjectionRecipe,
  sourceFacts: "original" | "portable" = "original",
  budget?: InspectionBudget,
): Promise<CanonicalProjection> => {
  const { native, lines } = sources;
  const { declared, rate } = recipe;
  const events = lines.map((line) => line.event);
  if (events.some((event) => event.scope.runId !== runId))
    throw new DumpFailed({ reason: "raw source belongs to another run" });
  const of = <T extends CapturedEvent["type"]>(type: T) =>
    events.filter((event): event is Event<T> => event.type === type);
  const starts = of("run.start");
  const start = starts[0];
  const pricing = start?.pricing ?? null;
  const review = start?.runKind !== "coding";
  const end = of("run.end").at(-1);
  const stageEnds = new Map(of("stage.end").map((e) => [e.scope.stage, e]));
  const contracts = contractContexts(native);
  const binds = new Map(
    of("session.bind").map((e) => [e.scope.conversationId, e]),
  );
  const byId = new Map(native.conversations.map((c) => [c.id, c]));
  const taskIds = new Set<number>(
    native.conversations.flatMap((c) => c.tasks.map((task) => task.id)),
  );

  const bindingOf = (id: number, seen = new Set<number>()): Binding | null => {
    const direct = binds.get(id);
    if (direct !== undefined)
      return {
        ...(direct.scope.stage === undefined
          ? {}
          : { stage: direct.scope.stage }),
        ...(direct.scope.agent === undefined
          ? {}
          : { agent: direct.scope.agent }),
        ...(direct.scope.taskId === undefined
          ? {}
          : { taskId: direct.scope.taskId }),
        ...(direct.computationId === undefined
          ? {}
          : { computationId: direct.computationId }),
      };
    const owner = byId.get(id)?.record.owner?.conversationId;
    if (owner === undefined || seen.has(owner)) return null;
    seen.add(id);
    const inherited = bindingOf(owner, seen);
    return inherited === null
      ? null
      : { ...inherited, inheritedFrom: inherited.inheritedFrom ?? owner };
  };

  // Every stored assistant message, so a call can join the one it produced.
  const assistants = native.conversations.flatMap((c) =>
    c.entries
      .filter((entry) => entry.kind === "pi.assistant")
      .map((entry) => ({
        conversationId: c.id,
        entry,
        message: parse(
          PiAssistant,
          entry.model?.[0],
          `assistant entry ${entry.id}`,
        ),
      })),
  );
  const validateScope = nativeScopes(native, runId);
  const modelScopes = new Map<string, Array<CaptureScope>>();
  for (const { event } of lines) {
    if (!event.type.startsWith("model.")) continue;
    validateScope(event.scope);
    if ("callId" in event) {
      const observed = modelScopes.get(event.callId) ?? [];
      observed.push(event.scope);
      modelScopes.set(event.callId, observed);
    }
  }
  const calls = callsOf(
    lines,
    recipe.sourceValidationVersion !== undefined,
    validateScope,
  );
  for (const loss of recipe.captureLosses ?? [])
    if (
      loss.credentialCoverage === "required" &&
      calls.get(loss.callId)?.end === null
    )
      calls.delete(loss.callId);
  for (const call of calls.values()) {
    if (call.purpose === undefined) continue;
    if (review)
      throw new DumpFailed({
        reason: "auxiliary purposes are only valid in coding runs",
      });
    if (
      call.scope.conversationId === undefined ||
      !byId.has(call.scope.conversationId)
    )
      throw new DumpFailed({
        reason: `auxiliary call ${call.callId} names no native conversation`,
      });
  }
  const callOfEntry = new Map<number, { callId: string; join: Turn["join"] }>();
  const joinedCalls = new Set<string>();
  const joinBy = (
    key: (call: Omit<CallRecord, "role">) => string | number | undefined,
    keyOf: (
      message: z.infer<typeof PiAssistant>,
    ) => string | number | undefined,
    join: NonNullable<Turn["join"]>,
  ) => {
    for (const call of calls.values()) {
      if (call.purpose !== undefined) continue;
      const wanted = key(call);
      if (wanted === undefined || joinedCalls.has(call.callId)) continue;
      const matches = assistants.filter(
        (a) => !callOfEntry.has(a.entry.id) && keyOf(a.message) === wanted,
      );
      const only = matches.length === 1 ? matches[0] : undefined;
      if (only === undefined) continue;
      if (
        (call.scope.conversationId !== undefined &&
          call.scope.conversationId !== only.conversationId) ||
        call.model !== only.message.model ||
        (call.logicalRoute ?? call.provider) !== only.message.provider
      )
        throw new DumpFailed({
          reason: `call ${call.callId} contradicts native assistant ownership`,
        });
      for (const scope of modelScopes.get(call.callId) ?? [])
        validateScope(scope, {
          conversationId: only.conversationId,
          ...(only.entry.byTaskId === undefined
            ? {}
            : { taskId: only.entry.byTaskId }),
        });
      if (
        call.end !== null &&
        call.end.outcome !== outcomeOfStop(only.message.stopReason)
      )
        throw new DumpFailed({
          reason: `call ${call.callId} contradicts native assistant output outcome`,
        });
      callOfEntry.set(only.entry.id, { callId: call.callId, join });
      joinedCalls.add(call.callId);
    }
  };
  joinBy(
    (call) => call.end?.responseId ?? call.response?.responseId,
    (message) => message.responseId,
    "response-id",
  );
  // Only between a call and a message that both lack a response ID: one that has it joins by it or not at all.
  joinBy(
    (call) =>
      (call.end?.responseId ?? call.response?.responseId) === undefined
        ? call.end?.messageTimestamp
        : undefined,
    (message) =>
      message.responseId === undefined ? message.timestamp : undefined,
    "message-timestamp",
  );
  const nativeOfCall = new Map(
    assistants.flatMap((assistant) => {
      const joined = callOfEntry.get(assistant.entry.id);
      return joined === undefined
        ? []
        : [[joined.callId, assistant.message] as const];
    }),
  );
  const decoded = new Map<string, OriginalResponseFacts>();
  await withRetainedSdk(async (run) => {
    for (const call of calls.values()) {
      const output = await providerOutput(
        call,
        nativeOfCall.get(call.callId),
        native,
        run,
        budget,
      );
      if (output !== null) {
        reconcileProviderOutput(
          call,
          output,
          undefined,
          sourceFacts === "portable" ? declared : undefined,
        );
        decoded.set(call.callId, output);
      }
    }
  });
  for (const assistant of assistants) {
    const joined = callOfEntry.get(assistant.entry.id);
    if (joined === undefined) continue;
    const call = calls.get(joined.callId)!;
    const output = decoded.get(joined.callId);
    if (output !== undefined)
      reconcileProviderOutput(
        call,
        output,
        assistant.message,
        sourceFacts === "portable" ? declared : undefined,
      );
    if (
      (call.end?.sdkUsage !== undefined &&
        !sameUsage(call.end.sdkUsage, assistant.message.usage)) ||
      (call.end?.stopReason !== undefined &&
        call.end.stopReason !== assistant.message.stopReason)
    )
      throw new DumpFailed({
        reason: `call ${joined.callId} contradicts native assistant output at entry ${assistant.entry.id}`,
      });
  }
  const messageOf = new Map(assistants.map((a) => [a.entry.id, a.message]));

  const usageMismatches: Array<number> = [];
  const missingResults: Array<string> = [];
  const undefinedTools: Array<string> = [];
  const offeredNames = (conversation: NativeConversation, until?: number) => {
    const names = new Set<string>();
    for (const entry of conversation.entries) {
      if (until !== undefined && entry.id > until) break;
      if (entry.kind !== "pi.system") continue;
      const system = parse(
        PiSystem,
        entry.model?.[0],
        `system entry ${entry.id}`,
      );
      for (const tool of system.toolsAdded ?? []) names.add(tool.name);
    }
    const parent = conversation.record.parent;
    const from =
      parent === undefined ? undefined : byId.get(parent.conversationId);
    if (parent !== undefined && from !== undefined)
      for (const name of offeredNames(from, parent.at)) names.add(name);
    return names;
  };

  const sessions: Array<SessionDump> = [];
  for (const conversation of native.conversations) {
    const { id } = conversation;
    const results = new Map<
      string,
      { entryId: number; unavailable: boolean }
    >();
    for (const entry of conversation.entries) {
      if (entry.kind !== "pi.tool-result") continue;
      const result = parse(
        PiToolResult,
        entry.model?.[0],
        `tool result ${entry.id}`,
      );
      const data = PiToolResultData.safeParse(entry.data);
      results.set(result.toolCallId, {
        entryId: entry.id,
        unavailable:
          data.success &&
          data.data.diagnostics.some((d) => d.code === "tool_unavailable"),
      });
    }
    const offered = offeredNames(conversation);
    const turns: Array<Turn> = [];
    const offeredTools: SessionDump["offeredTools"] = [];
    const compactions: SessionDump["compactions"] = [];
    let turnTotals: Totals = {
      tokens: ZERO,
      cost: costOf(ZERO, 0, pricing, rate),
    };
    for (const entry of conversation.entries) {
      const message = messageOf.get(entry.id);
      if (message !== undefined) {
        const tokens = tokensOf(message.usage);
        const cost = costOf(tokens, message.usage.cost.total, pricing, rate);
        const joined = callOfEntry.get(entry.id);
        const call =
          joined === undefined ? undefined : calls.get(joined.callId);
        if (
          call?.end?.usage !== undefined &&
          !sameTokens(call.end.usage, tokens)
        )
          usageMismatches.push(entry.id);
        const toolCalls = message.content.flatMap((content) => {
          const toolCall = PiToolCall.safeParse(content);
          if (!toolCall.success) return [];
          const result = results.get(toolCall.data.id);
          if (result === undefined) {
            // pi starts a tool round only for a `toolUse` stop, so under any other stop the call
            // was never dispatched. pi drops an `error` or `aborted` turn from the next request
            // and replays any other with a synthetic "No result provided" result.
            if (message.stopReason === "toolUse")
              missingResults.push(`${id}:${toolCall.data.id}`);
          } else if (!result.unavailable && !offered.has(toolCall.data.name))
            undefinedTools.push(`${id}:${toolCall.data.name}`);
          return [
            {
              id: toolCall.data.id,
              name: toolCall.data.name,
              resultEntryId: result?.entryId ?? null,
            },
          ];
        });
        turns.push({
          entryId: entry.id,
          ...(entry.byTaskId === undefined ? {} : { taskId: entry.byTaskId }),
          provider: message.provider,
          model: message.model,
          ...(message.responseId === undefined
            ? {}
            : { responseId: message.responseId }),
          stopReason: message.stopReason,
          ...(message.errorMessage === undefined
            ? {}
            : { errorMessage: message.errorMessage }),
          messageTimestamp: message.timestamp,
          requestedAt: call?.requestedAt ?? null,
          respondedAt: call?.response?.at ?? null,
          endedAt: call?.end?.at ?? null,
          tokens,
          cost,
          callId: call?.callId ?? null,
          join: joined?.join ?? null,
          toolCalls,
        });
        turnTotals = addTotals(turnTotals, { tokens, cost });
      } else if (entry.kind === "pi.system") {
        const system = parse(
          PiSystem,
          entry.model?.[0],
          `system entry ${entry.id}`,
        );
        if (
          system.toolsAdded !== undefined ||
          system.toolsRemoved !== undefined
        )
          offeredTools.push({
            entryId: entry.id,
            added: (system.toolsAdded ?? []).map((tool) =>
              asJson(tool, "tool"),
            ),
            removed: (system.toolsRemoved ?? []).map((tool) => tool.name),
          });
      } else if (entry.kind === "pi.compaction") {
        const reason = z.object({ reason: z.string() }).safeParse(entry.data);
        compactions.push({
          entryId: entry.id,
          ...(entry.head === undefined ? {} : { head: entry.head }),
          ...(reason.success ? { reason: reason.data.reason } : {}),
        });
      }
    }
    const usageDoc = conversation.documents.find(
      (doc) => doc.kind === "pi.usage",
    );
    const ledger =
      usageDoc === undefined
        ? null
        : Object.values(parse(PiUsageDoc, usageDoc.value, "pi.usage")).reduce(
            (sum, bucket) =>
              Object.values(bucket).reduce(
                (inner, usage) =>
                  addTotals(inner, {
                    tokens: tokensOf(usage),
                    cost: costOf(
                      tokensOf(usage),
                      usage.cost.total,
                      pricing,
                      rate,
                    ),
                  }),
                sum,
              ),
            { tokens: ZERO, cost: costOf(ZERO, 0, pricing, rate) },
          );
    const live = conversation.documents.find((doc) => doc.kind === "pi.live");
    const liveState =
      live === undefined ? undefined : parse(PiLive, live.value, "pi.live");
    const inFlight =
      liveState !== undefined &&
      (liveState.run !== undefined ||
        liveState.generation !== undefined ||
        liveState.tools !== undefined)
        ? asJson(
            {
              ...(liveState.run === undefined ? {} : { run: liveState.run }),
              ...(liveState.generation === undefined
                ? {}
                : { generation: liveState.generation }),
              ...(liveState.tools === undefined
                ? {}
                : { tools: liveState.tools }),
            },
            "pi.live",
          )
        : null;
    const binding = bindingOf(id);
    sessions.push({
      conversationId: id,
      ...(conversation.record.parent === undefined
        ? {}
        : { parent: conversation.record.parent }),
      ...(conversation.record.owner === undefined
        ? {}
        : { owner: conversation.record.owner }),
      binding,
      status:
        binding?.stage === undefined
          ? "unknown"
          : (stageEnds.get(binding.stage)?.status ?? "unknown"),
      entries: conversation.entries.map((entry) =>
        asJson(entry, `entry ${entry.id}`),
      ),
      tasks: conversation.tasks.map((task) => asJson(task, `task ${task.id}`)),
      documents: [...conversation.documents],
      taskDocuments: conversation.taskDocuments.map((t) => ({
        taskId: t.taskId,
        documents: [...t.documents],
      })),
      offeredTools,
      turns,
      compactions,
      inFlight,
      calls: [],
      totals: { turns: turnTotals, ledger },
    });
  }

  // A call no stored turn answers is a compaction summary when pi's ledgers count exactly its tokens
  // beyond the stored turns: pi records a summary's usage but keeps no message for it.
  const liveResponses = new Set(
    sessions.flatMap((s) => {
      const partial = LivePartial.safeParse(s.inFlight);
      return partial.success
        ? [partial.data.generation.message.responseId]
        : [];
    }),
  );
  const liveOwners = sessions.flatMap((session) => {
    const partial = LivePartial.safeParse(session.inFlight);
    return partial.success
      ? [
          {
            conversationId: session.conversationId,
            responseId: partial.data.generation.message.responseId,
          },
        ]
      : [];
  });
  for (const call of calls.values()) {
    const responseId = call.end?.responseId ?? call.response?.responseId;
    const owners = liveOwners.filter(
      (owner) => owner.responseId === responseId,
    );
    if (call.purpose !== undefined || owners.length !== 1) continue;
    for (const scope of modelScopes.get(call.callId) ?? []) {
      const owner = { runId, conversationId: owners[0]!.conversationId };
      if (!compatibleScope(scope, owner))
        throw new DumpFailed({
          reason: "capture scope contradicts native partial ownership",
        });
      validateScope({ ...scope, ...owner });
    }
  }
  const inFlightCalls = new Set(
    [...calls.values()]
      .filter((call) => {
        const responseId = call.end?.responseId ?? call.response?.responseId;
        return (
          call.purpose === undefined &&
          !joinedCalls.has(call.callId) &&
          responseId !== undefined &&
          liveResponses.has(responseId)
        );
      })
      .map((call) => call.callId),
  );
  const unjoined = [...calls.values()].filter(
    (call) =>
      call.purpose === undefined &&
      !joinedCalls.has(call.callId) &&
      !inFlightCalls.has(call.callId),
  );
  const modelLedger = native.conversations.reduce((sum, conversation) => {
    const doc = conversation.documents.find((d) => d.kind === "pi.usage");
    if (doc === undefined) return sum;
    return Object.values(
      parse(PiUsageDoc, doc.value, "pi.usage").models,
    ).reduce((inner, usage) => addTokens(inner, tokensOf(usage)), sum);
  }, ZERO);
  const turnTokens = sessions
    .flatMap((s) => s.turns)
    .reduce((sum, turn) => addTokens(sum, turn.tokens), ZERO);
  const unjoinedTokens = unjoined.reduce(
    (sum, call) => addTokens(sum, call.end?.usage ?? ZERO),
    ZERO,
  );
  const ledgerAccounting: UsageAccounting = new Map();
  const sourceAccounting: UsageAccounting = new Map();
  for (const conversation of native.conversations) {
    const doc = conversation.documents.find(
      (document) => document.kind === "pi.usage",
    );
    if (doc !== undefined) {
      const ledger = parse(PiUsageDoc, doc.value, "pi.usage");
      for (const bucket of ["models", "tools"] as const)
        for (const [key, usage] of Object.entries(ledger[bucket]))
          accountUsage(ledgerAccounting, conversation.id, bucket, key, usage);
    }
    const toolNames = new Map(
      assistants
        .filter((a) => a.conversationId === conversation.id)
        .flatMap((a) =>
          a.message.content.flatMap((part) => {
            const call = PiToolCall.safeParse(part);
            return call.success
              ? [[call.data.id, call.data.name] as const]
              : [];
          }),
        ),
    );
    for (const entry of conversation.entries) {
      if (entry.kind !== "pi.tool-result") continue;
      const result = parse(
        PiToolResult,
        entry.model?.[0],
        `tool result ${entry.id}`,
      );
      const name = toolNames.get(result.toolCallId);
      if (name !== undefined && name !== result.toolName)
        throw new DumpFailed({
          reason: `native tool result ${entry.id} contradicts tool call name`,
        });
      if (result.usage !== undefined)
        accountUsage(
          sourceAccounting,
          conversation.id,
          "tools",
          result.toolName,
          result.usage,
        );
    }
  }
  for (const assistant of assistants)
    accountUsage(
      sourceAccounting,
      assistant.conversationId,
      "models",
      `${assistant.message.provider}/${assistant.message.model}`,
      assistant.message.usage,
    );
  const compactionOwners = new Map<string, number>();
  const compactionConversations = native.conversations.filter((c) =>
    c.tasks.some((t) => t.kind === "pi.compaction"),
  );
  const summaryPrefix =
    "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
  const summarySuffix = "\n</summary>";
  const textParts = z.array(
    z.object({ type: z.string(), text: z.string().optional() }),
  );
  const nativeSummary = z.object({
    role: z.literal("user"),
    content: textParts,
  });
  for (const call of unjoined) {
    // This is derived membership. Never rewrite the provider's observed capture scope.
    if (call.end?.sdkUsage === undefined || call.end.outcome === "aborted")
      continue;
    const content = textParts.safeParse(decoded.get(call.callId)?.content);
    const summary =
      content.success && !content.data.some((part) => part.type === "toolCall")
        ? content.data
            .filter((part) => part.type === "text")
            .map((part) => part.text ?? "")
            .join("\n")
            .trim()
        : undefined;
    const candidates = compactionConversations.filter(
      (c) =>
        ledgerAccounting
          .get(c.id)
          ?.models.has(
            `${call.logicalRoute ?? call.provider}/${call.model}`,
          ) === true &&
        (call.scope.conversationId === undefined ||
          call.scope.conversationId === c.id) &&
        (summary === undefined ||
          call.end?.outcome !== "completed" ||
          c.entries.some((entry) => {
            if (entry.kind !== "pi.compaction") return false;
            const message = nativeSummary.safeParse(entry.model?.[0]);
            return (
              message.success &&
              message.data.content.map((part) => part.text ?? "").join("\n") ===
                `${summaryPrefix}${summary}${summarySuffix}`
            );
          })),
    );
    if (candidates.length !== 1) continue;
    const owner = candidates[0]!;
    for (const scope of modelScopes.get(call.callId) ?? []) {
      if (
        scope.conversationId !== undefined &&
        scope.conversationId !== owner.id
      )
        throw new DumpFailed({
          reason: "compaction capture scope contradicts native ownership",
        });
      if (
        scope.taskId !== undefined &&
        !owner.tasks.some(
          (task) => task.id === scope.taskId && task.kind === "pi.compaction",
        )
      )
        throw new DumpFailed({
          reason: "compaction capture scope contradicts native task",
        });
    }
    compactionOwners.set(call.callId, owner.id);
    accountUsage(
      sourceAccounting,
      owner.id,
      "models",
      `${call.logicalRoute ?? call.provider}/${call.model}`,
      call.end.sdkUsage,
    );
  }
  const reconciledConversations = new Set<number>();
  for (const conversation of native.conversations) {
    const ledger = ledgerAccounting.get(conversation.id);
    const source = sourceAccounting.get(conversation.id);
    if (
      !sameUsageBucket(ledger?.tools ?? new Map(), source?.tools ?? new Map())
    )
      throw new DumpFailed({
        reason: `native tool ledger contradicts conversation ${conversation.id} sources`,
      });
    const matches = sameUsageBucket(
      ledger?.models ?? new Map(),
      source?.models ?? new Map(),
    );
    if (!matches)
      throw new DumpFailed({
        reason: `native model ledger contradicts conversation ${conversation.id} sources`,
      });
    reconciledConversations.add(conversation.id);
  }
  const reconciled =
    reconciledConversations.size === native.conversations.length;
  const roleOfUnjoined = (call: Omit<CallRecord, "role">): CallRole => {
    const owner = compactionOwners.get(call.callId);
    return owner !== undefined && reconciledConversations.has(owner)
      ? "non-turn"
      : "unjoined";
  };
  const record = (call: Omit<CallRecord, "role">): CallRecord =>
    CallRecord.parse({
      ...call,
      role:
        call.purpose !== undefined
          ? "non-turn"
          : joinedCalls.has(call.callId)
            ? "turn"
            : inFlightCalls.has(call.callId)
              ? "in-flight"
              : roleOfUnjoined(call),
    });
  const unjoinedCalls = [...calls.values()]
    .filter(
      (call) => call.purpose === undefined && !joinedCalls.has(call.callId),
    )
    .map(record);
  const emptyTotals = (): Totals => ({
    tokens: ZERO,
    cost: costOf(ZERO, 0, pricing, rate),
  });
  for (const session of sessions) {
    const auxiliary = [...calls.values()].filter(
      (call) =>
        call.purpose !== undefined &&
        call.scope.conversationId === session.conversationId,
    );
    session.calls = [
      ...session.turns.flatMap((turn) => {
        const call = turn.callId === null ? undefined : calls.get(turn.callId);
        return call === undefined ? [] : [record(call)];
      }),
      ...auxiliary.map(record),
    ];
    if (auxiliary.length > 0)
      session.totals.auxiliary = auxiliary.reduce((sum, call) => {
        const tokens = call.end?.usage ?? ZERO;
        const cost = costOf(tokens, 0, pricing, rate);
        // model.end keeps token counters, never a native ledger's dollar cost.
        if (pricing === "metered")
          cost.recorded = {
            status: "unknown",
            reason: "auxiliary call usage has no captured per-token price",
          };
        return addTotals(sum, { tokens, cost });
      }, emptyTotals());
  }
  const sessionTotals = (session: SessionDump) =>
    session.totals.auxiliary === undefined
      ? (session.totals.ledger ?? session.totals.turns)
      : addTotals(
          session.totals.ledger ?? session.totals.turns,
          session.totals.auxiliary,
        );
  const stageNames = [
    ...new Set([
      ...sessions.flatMap((s) =>
        s.binding?.stage === undefined ? [] : [s.binding.stage],
      ),
      ...stageEnds.keys(),
      ...contracts.map((context) => context.state.stage),
    ]),
  ];
  const stages = stageNames.map((stage) => {
    const members = sessions.filter((s) => s.binding?.stage === stage);
    const ended = stageEnds.get(stage);
    return {
      stage,
      status: ended?.status ?? ("unknown" as const),
      ...(ended?.reason === undefined ? {} : { reason: ended.reason }),
      sessions: members.map((s) => s.conversationId),
      totals: contracts
        .filter((context) => context.state.stage === stage)
        .reduce(
          (sum, context) => addTotals(sum, contractTotals(context)),
          members.reduce(
            (sum, s) => addTotals(sum, sessionTotals(s)),
            emptyTotals(),
          ),
        ),
    };
  });

  const ledger = ledgerOf(lines);
  const open = ledger
    .filter(
      (lead) =>
        lead.terminal.length === 0 ||
        lead.targets.some((target) => target.terminal.length === 0),
    )
    .map((lead) => lead.leadId);
  const handoffs: Record<LeadHandoff, number> = {
    find: 0,
    verify: 0,
    investigate: 0,
    rank: 0,
    assemble: 0,
    dispose: 0,
    publish: 0,
  };
  for (const fate of ledger.flatMap((lead) => lead.fates))
    handoffs[fate.handoff] += 1;

  const artifacts: Array<ArtifactRecord> = [];
  const artifactContents: Array<CanonicalProjection["artifacts"][number]> = [];
  for (const [index, source] of sources.artifacts.entries()) {
    const { event: artifact, bytes: original } = source;
    const masked = maskArtifact(artifact.mediaType, original, declared);
    const file = `artifacts/${index}`;
    const raw = masked._tag !== "Masked";
    const originalFile = raw ? file : `${file}.original`;
    artifacts.push({
      scope: artifact.scope,
      name: artifact.name,
      mediaType: artifact.mediaType,
      sanitization: raw ? "raw-uninspected" : "sanitized",
      file,
      sha256: raw ? artifact.sha256 : sha256Of(masked.bytes),
      size: raw ? artifact.size : masked.bytes.byteLength,
      original: {
        sha256: artifact.sha256,
        size: artifact.size,
        file: originalFile,
      },
    });
    artifactContents.push({
      name: file,
      mediaType: artifact.mediaType,
      bytes: raw ? original : masked.bytes,
    });
    if (!raw)
      artifactContents.push({
        name: originalFile,
        mediaType: artifact.mediaType,
        bytes: original,
      });
  }

  const journalSessions = sessionsOf(lines);
  const failures = [
    ...journalSessions.flatMap((s) => s.failures),
    ...(recipe.captureLosses ?? []).map(
      ({ callId, event, kind, reason, at }) =>
        `call ${callId} lost capture at ${event} (${kind}, ${reason}, ${at}). The rest of its capture was skipped.`,
    ),
  ];
  const interrupted = journalSessions.filter((s) => !s.closed);
  const lostWrites = interrupted.flatMap((session) => session.lostWrites);
  const differing = starts.filter(
    (other) => JSON.stringify(other) !== JSON.stringify(start),
  ).length;
  const summaryCalls = [...calls.values()].filter(
    (call) =>
      call.body.status === "sent" &&
      RequestedSummary.safeParse(call.body.json).success,
  ).length;
  const unbound = sessions.filter(
    (s) => s.binding === null && s.entries.length > 0,
  );
  const unattributed = review
    ? sessions.filter(
        (s) =>
          s.binding !== null &&
          (s.binding.stage === undefined || s.binding.agent === undefined),
      )
    : [];
  const unended = stageNames.filter(
    (stage) =>
      !stageEnds.has(stage) &&
      (sessions.some((s) => s.binding?.stage === stage) ||
        contracts.some((c) => c.state.stage === stage)),
  );
  const missingEdges = [
    ...[...binds.keys()]
      .filter((id) => !byId.has(id))
      .map((id) => `session.bind of conversation ${id}`),
    ...native.conversations.flatMap((c) => [
      ...(c.record.owner !== undefined &&
      (!byId.has(c.record.owner.conversationId) ||
        !taskIds.has(c.record.owner.taskId))
        ? [`conversation ${c.id}`]
        : []),
      ...c.tasks.flatMap((task) =>
        task.owner !== undefined && !taskIds.has(task.owner)
          ? [`task ${task.id}`]
          : [],
      ),
    ]),
  ];
  const running = native.conversations.flatMap((c) =>
    c.tasks
      .filter((task) => task.state.status !== "terminal")
      .map((task) => task.id),
  );
  const live = sessions.filter((s) => s.inFlight !== null);
  const bodiless = [...calls.values()].filter(
    (call) => call.body.status === "missing",
  );
  const unsettled = [...calls.values()].filter(
    (call) => call.end === null && !inFlightCalls.has(call.callId),
  );
  const uncaptured = sessions.flatMap((s) =>
    s.turns.filter((t) => t.callId === null),
  );

  const ids = (items: ReadonlyArray<string | number>) => items.join(", ");
  // Each gap with how many times it occurs; a count of zero means it was not found.
  const found: ReadonlyArray<readonly [Gap["code"], number, string]> = [
    ...contractContextGaps(contracts, native, runId),
    [
      "journal-torn",
      sources.tornLines,
      "journal lines cut short by a crash mid-append",
    ],
    [
      "journal-failed",
      failures.length,
      failures.map((reason) => maskText(reason, declared)).join("; "),
    ],
    [
      "journal-interrupted",
      interrupted.length,
      `capture sessions opened at line ${ids(interrupted.map((s) => s.opened))} ended without a clean close (a crash, a failed capture, or a capture taken while one was open), so events may be missing` +
        (lostWrites.length === 0
          ? ""
          : `. Lost writes: ${maskText(lostWrites.join(", "), declared)}.`),
    ],
    [
      "run-start-missing",
      start === undefined ? 1 : 0,
      "no run.start captured: the run's kind, source and pricing are unknown",
    ],
    [
      "run-start-conflict",
      differing,
      "run.start captured again with different values",
    ],
    [
      "run-end-missing",
      end === undefined ? 1 : 0,
      "no run.end captured: the run stopped before it ended",
    ],
    [
      "scored-with-summaries",
      start?.runKind === "scored" ? summaryCalls : 0,
      "a scored run's requests asked for reasoning summaries; it can only be a reading run",
    ],
    [
      "session-unbound",
      unbound.length,
      `conversations without session.bind: ${ids(unbound.map((s) => s.conversationId))}`,
    ],
    [
      "session-unattributed",
      unattributed.length,
      `conversations bound without a stage or agent: ${ids(unattributed.map((s) => s.conversationId))}`,
    ],
    [
      "stage-end-missing",
      unended.length,
      `stages without stage.end: ${ids(unended)}`,
    ],
    [
      "edge-missing",
      missingEdges.length,
      `owners not in storage: ${ids(missingEdges)}`,
    ],
    [
      "work-in-flight",
      running.length + live.length,
      `tasks not terminal: ${ids(running) || "none"}; conversations mid-run: ${ids(live.map((s) => s.conversationId)) || "none"}`,
    ],
    [
      "request-missing",
      bodiless.length,
      bodiless
        .map(
          (call) =>
            `${call.callId}: ${call.body.status === "missing" ? maskText(call.body.reason, declared) : ""}`,
        )
        .join("; "),
    ],
    [
      "calls-unended",
      unsettled.length,
      `calls dispatched that never settled: ${ids(unsettled.map((c) => c.callId))}`,
    ],
    [
      "auxiliary-usage-missing",
      [...calls.values()].filter(
        (call) =>
          call.purpose !== undefined &&
          call.end !== null &&
          call.end.usage === undefined,
      ).length,
      "settled auxiliary calls without final usage; their token totals are unknown",
    ],
    [
      "calls-unjoined",
      unjoined.filter((call) => roleOfUnjoined(call) === "unjoined").length,
      "calls no stored turn answers and pi's usage ledgers do not account for",
    ],
    [
      "ledger-unreconciled",
      reconciled ? 0 : 1,
      `pi's ledgers count ${modelLedger.totalTokens} tokens; stored turns ${turnTokens.totalTokens} and unjoined calls ${unjoinedTokens.totalTokens}`,
    ],
    [
      "turns-uncaptured",
      uncaptured.length,
      "stored turns with no captured call",
    ],
    [
      "usage-mismatch",
      usageMismatches.length,
      `turns whose stored usage differs from their call's: ${ids(usageMismatches)}`,
    ],
    [
      "tool-results-missing",
      missingResults.length,
      `tool calls without a result: ${ids(missingResults)}`,
    ],
    [
      "tool-definitions-missing",
      undefinedTools.length,
      `tools called without an offered definition: ${ids(undefinedTools)}`,
    ],
    [
      "lead-fates-absent",
      review &&
      ledger.length > 0 &&
      ledger.every((lead) => lead.fates.length === 0)
        ? 1
        : 0,
      "finders returned findings but no lead.fate was captured",
    ],
    [
      "leads-open",
      open.length,
      `leads without a terminal fate, or with a Publish target without one: ${ids(open)}`,
    ],
  ];
  const execution = end === undefined ? "open" : "ended";
  const gaps: Array<Gap> = found
    .filter(([, count]) => count > 0)
    .map(([code, count, detail]) => ({
      code,
      kind:
        execution === "open" && EXECUTION_GAPS.has(code)
          ? "execution"
          : "capture",
      count,
      detail,
    }));

  const run = RunDump.parse(
    restrictRun(
      {
        runId,
        runKind: start?.runKind ?? recipe.captureLossRunKind ?? null,
        sourceRevision: start?.sourceRevision ?? null,
        ...(start?.harnessRevision === undefined
          ? {}
          : { harnessRevision: start.harnessRevision }),
        route: start?.route ?? null,
        pricing,
        status: end?.status ?? "unknown",
        execution,
        ...(end?.publicationId === undefined
          ? {}
          : { publicationId: end.publicationId }),
        close: recipe.close,
        rate,
        backup: sources.backup,
        journal: sources.journal,
        stages,
        totals: contracts.reduce(
          (sum, context) => addTotals(sum, contractTotals(context)),
          sessions.reduce(
            (sum, s) => addTotals(sum, sessionTotals(s)),
            emptyTotals(),
          ),
        ),
        sessions: sessions.map((s) => ({
          conversationId: s.conversationId,
          file: `sessions/${s.conversationId}.json`,
        })),
        ...(contracts.length === 0 ? {} : { contractContexts: contracts }),
        sessionDocuments: native.session,
        leads: { handoffs, ledger, open },
        artifacts,
        gaps,
        complete: gaps.every((g) => g.kind === "execution"),
      },
      declared,
    ),
  );

  return {
    run,
    sessions: sessions.map((session) =>
      SessionDump.parse(restrictSession(session, declared)),
    ),
    unjoined: unjoinedCalls.map((call) =>
      CallRecord.parse(restrictCall(call, declared)),
    ),
    artifacts: artifactContents,
  };
};
