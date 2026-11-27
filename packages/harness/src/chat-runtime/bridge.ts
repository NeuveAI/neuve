import type { TurnRecovery } from "@neuve/records-core";
import { Identity } from "@neuve/records-core/capture";
import type { TurnRecoveryCheckpoint } from "@neuve/records-schema";
import {
  TURN_CANCELLED,
  TURN_RETRY_FAILURE,
  TurnRetryFailure,
} from "@neuve/records-schema/turn-recovery";
import {
  RecoveryOwnershipUnknown,
  type RecoveryResult,
  type TurnRecoveryDriver,
} from "./recovery.ts";
import {
  continueSavedTurn,
  replayTool,
  retryAt,
  retryDecision,
  toolLedger,
} from "./retry.ts";
import {
  createAssistantMessageEventStream,
  type AssistantMessageEventStream,
} from "@earendil-works/pi-ai/utils/event-stream";
import type {
  AssistantMessage,
  Context,
  Model,
  Api,
  SimpleStreamOptions,
  SystemMessage,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import { Effect, Exit, Scope, Stream } from "effect";
import type { ConversationId } from "@earendil-works/pi-durable";
import {
  accountForProvider,
  RuntimeFailure,
  runtimeErrorToFailure,
  type AccountName,
  type ContentBlock,
  type ContinuationIdentity,
  type RuntimeCapabilities,
  type RuntimeEvent,
  type RuntimeRegistryShape,
  type RuntimeSession,
  type SessionPolicy,
  type SessionStart,
  type ToolCall,
  type ToolOutcome,
} from "@neuve/runtime";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { NativeHeads } from "./heads.ts";
import { HANDOFF_TOKENS, MAY_HAVE_RUN, handoff } from "./handoff.ts";
import {
  interrupted,
  markTerminal,
  resumeFailed,
  terminalText,
} from "./failure.ts";
import {
  alreadyRan,
  ATTENDED_SECTION,
  digest,
  full,
  headDigest,
  mirrorCalls,
  newest,
  pointer,
  policy,
  policyKey,
  PLAN_TOOL,
  responseId,
  resultText,
  RUNTIME_WORK_TOOL,
  usage,
  userContent,
  type Log,
} from "./transcript.ts";

export type AccountRoute = {
  name: AccountName;
  continuation: ContinuationIdentity;
  capabilities: RuntimeCapabilities;
};
type Generation = {
  settled: boolean;
  recovery?: TurnRecovery.RecoveryState | undefined;
  selection?: SessionPolicy["model"];
  owner: string;
  chat?: ConversationId;
  attended: boolean;
  account: AccountName;
  cancellation: AbortController;
  key: string;
  streams: AssistantMessageEventStream[];
  message: AssistantMessage;
  messages: Context["messages"];
  /** The chat's own folder, from its agent: where a runtime with its own tools works. */
  folder?: string | undefined;
  /** Channel policy for this request. Keep its temporary tool offer out of continuation digests. */
  toolOffer?: SystemMessage;
  pluginTools?: ReadonlySet<string>;
  mcpServers?: SessionPolicy["mcpServers"];
  cleanup: (() => void)[];
  head?: {
    owner: string;
    previous: ReturnType<NativeHeads["get"]>;
    value: Parameters<NativeHeads["set"]>[1];
  };
};
const ambiguousToolEffect =
  "A tool may have run without a recorded result. Send a message to recover the work.";
const unsafeContinuation =
  "This turn could not safely continue. Send a message to recover it.";
const planningRequest = Symbol.for("neuve.chat.plan-request");

const sandboxPluginTools = Symbol.for("neuve.chat.sandbox-plugin-tools");
const nativePluginServers = Symbol.for("neuve.chat.native-plugin-servers");

function offeredMessages(
  generation: Generation,
): readonly Context["messages"][number][] {
  const { messages, toolOffer } = generation;
  return toolOffer ? [...messages, toolOffer] : messages;
}

type HeldCall = {
  result?: ToolOutcome | undefined;
  waiter?: ((value: ToolOutcome) => void) | undefined;
  delivered: boolean;
};
const stoppedCall = {
  text: "Stopped.",
  error: "Stopped.",
} satisfies ToolOutcome;
type WorkOutcome = { output?: string | undefined; errored: boolean };
type TranscriptEvent =
  | Exclude<RuntimeEvent, { type: "work.started" | "work.finished" }>
  | (Extract<RuntimeEvent, { type: "work.started" }> & {
      outcome: Promise<WorkOutcome>;
    });
type ApprovalRequestEvent = Extract<
  RuntimeEvent,
  { type: "approval.requested" }
>;
type ApprovalReply = Parameters<RuntimeSession["respondToApproval"]>[0];
type ApprovalEnd = "turn-ended" | "runtime-resolved" | "stopped";
type LiveApproval = {
  turn: string;
  reply?: Promise<boolean>;
  closing?: Promise<void>;
};
export interface ApprovalStore {
  restart(): Promise<void>;
  open(chat: ConversationId, event: ApprovalRequestEvent): Promise<void>;
  close(
    chat: ConversationId,
    requests: ReadonlySet<string>,
    reason: ApprovalEnd,
  ): Promise<void>;
  watch(
    chat: ConversationId,
    reply: (answer: ApprovalReply) => Promise<void>,
  ): Promise<() => Promise<void>>;
}
type Live = {
  owner: string;
  chat?: ConversationId;
  approvals: Map<string, LiveApproval>;
  approvalWatch?: () => Promise<void>;
  approvalEnd?: "stopped";
  scope: Scope.Closeable;
  state:
    | { kind: "acquiring"; start: SessionStart }
    | { kind: "open"; session: RuntimeSession };
  cancellation: AbortController;
  route: AccountRoute;
  policy: SessionPolicy;
  calls: Map<string, HeldCall>;
  pendingWork: Map<string, (outcome: WorkOutcome) => void>;
  /**
   * Set while a round recorded as a tool call waits for pi's next generation, on a runtime with
   * its own tools, whose turn goes on meanwhile. Its events are taken as they arrive and kept in
   * `backlog`, in order, so the bridge knows whether the turn has already ended; the next
   * generation records them.
   */
  holding?: boolean;
  /** Whether `pump` is recording events now; it alone handles them, in order. */
  pumping?: boolean;
  backlog: TranscriptEvent[];
  /** Set when the runtime's event stream has ended: cleanly, or with a failure. */
  streamEnded?: "ended" | "failed" | undefined;
  /** The person's message that arrived after the runtime's turn had ended: the next turn's input. */
  followUp?: ContentBlock[] | undefined;
  generation?: Generation | undefined;
  lastGeneration?: Generation;
  reserved?: Generation | undefined;
  replay?: { key: string; message: AssistantMessage };
  turn?: string | undefined;
  lastResumePoint?: string | undefined;
  checkpoint?: Pick<
    Parameters<NativeHeads["set"]>[1],
    "session" | "resumePoint" | "digest" | "checkpointThrough"
  >;
  recovery?: TurnRecovery.RecoveryState | undefined;
  recoveryEnd?: ((result: RecoveryResult) => void) | undefined;
  retryRequest?: Parameters<RuntimeSession["startTurn"]>[0]["message"];
  retryBase?: string | undefined;
  logicalTurn?: string | undefined;
  last: number;
  timer?: ReturnType<typeof setTimeout>;
  closing?: Promise<void>;
  reader?: Promise<void>;
  command?: Promise<void>;
  acquisition?: Promise<void>;
};
export interface BridgeOptions {
  registry: RuntimeRegistryShape;
  channel?: string | undefined;
  recovery?: TurnRecoveryDriver;
  heads: NativeHeads;
  skills?: { home: string; carried?: string | undefined };
  log?: Log;
  idleMs?: number;
  now?: () => number;
}
/** The only model requests are startTurn and the release of a recorded pi tool round. */
export class ChatRuntimeBridge {
  private readonly sessions = new Set<Live>();
  private readonly requests = new Map<string, Generation>();
  private readonly conversationCloses = new Map<string, number>();
  private readonly accountCloses = new Map<AccountName, number>();
  private readonly identities = new WeakMap<
    object,
    {
      conversation: ConversationId;
      generation: string;
      redispatched: boolean;
      folder?: string | undefined;
    }
  >();
  private readonly workResults = new Map<string, Promise<WorkOutcome>>();
  takeWorkResult(callId: string) {
    const outcome = this.workResults.get(callId);
    this.workResults.delete(callId);
    return outcome;
  }
  private readonly limitListeners = new Set<
    (
      account: AccountName,
      model: string,
      limits: { contextWindow?: number; maxTokens?: number },
    ) => void
  >();
  subscribeModelLimits(
    listener: (
      account: AccountName,
      model: string,
      limits: { contextWindow?: number; maxTokens?: number },
    ) => void,
  ) {
    this.limitListeners.add(listener);
    return () => {
      this.limitListeners.delete(listener);
    };
  }
  private readonly log: Log;
  private closed = false;
  private readonly now: () => number;
  private approvals?: ApprovalStore;
  constructor(private readonly options: BridgeOptions) {
    this.log = options.log ?? (() => {});
    this.now = options.now ?? Date.now;
  }
  async subscribeRecovery(
    listener: Parameters<TurnRecoveryDriver["subscribe"]>[0],
  ) {
    return this.options.recovery?.subscribe(listener);
  }
  async attachApprovals(store: ApprovalStore) {
    await store.restart();
    this.approvals = store;
  }
  identify(
    messages:
      Context["messages"] | readonly import("@earendil-works/pi-ai").Message[],
    conversation: import("@earendil-works/pi-durable").ConversationId,
    generation: import("@earendil-works/pi-durable").TaskId | string,
    redispatched = false,
    folder?: string,
  ): void {
    for (const message of messages)
      this.identities.set(message, {
        conversation,
        generation: String(generation),
        redispatched,
        ...(folder?.startsWith("/") ? { folder } : {}),
      });
  }
  isRedispatched(
    messages: readonly import("@earendil-works/pi-ai").Message[],
  ): boolean {
    return (
      messages
        .map((message) => this.identities.get(message))
        .findLast((identity) => identity !== undefined)?.redispatched === true
    );
  }
  stream(
    route: AccountRoute,
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
    selection?: SessionPolicy["model"],
  ): AssistantMessageEventStream {
    const stream = createAssistantMessageEventStream();
    const requested = normalizeContext(context).messages;
    const pluginTools: unknown =
      options && Reflect.get(options, sandboxPluginTools);
    const mcpServers: SessionPolicy["mcpServers"] =
      options && Reflect.get(options, nativePluginServers);
    const toolOffer = requested.find(
      (message): message is SystemMessage =>
        message.role === "system" && Object.hasOwn(message, planningRequest),
    );
    const attendance = requested.findLast(
      (message): message is SystemMessage =>
        message.role === "system" &&
        Object.hasOwn(message.sections ?? {}, ATTENDED_SECTION),
    );
    const messages = requested.filter(
      (message) => message !== toolOffer && message !== attendance,
    );
    const identity = messages
      .map((message) => this.identities.get(message))
      .findLast((value) => value !== undefined);
    const key =
      (identity?.generation ?? crypto.randomUUID()) +
      digest(messages) +
      JSON.stringify([model.provider, model.id, selection]);
    const known = this.requests.get(key);
    if (known) {
      this.subscribe(known, stream, options?.signal);
      return stream;
    }
    const generation: Generation = {
      settled: false,
      selection,
      key,
      owner:
        identity === undefined
          ? crypto.randomUUID()
          : String(identity.conversation),
      ...(identity === undefined ? {} : { chat: identity.conversation }),
      attended: attendance?.sections?.[ATTENDED_SECTION] === "true",
      account: route.name,
      cancellation: new AbortController(),
      streams: [],
      messages,
      ...(identity?.folder === undefined ? {} : { folder: identity.folder }),
      ...(toolOffer === undefined ? {} : { toolOffer }),
      ...(pluginTools instanceof Set ? { pluginTools } : {}),
      ...(mcpServers === undefined ? {} : { mcpServers }),
      cleanup: [],
      message: {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: [],
        usage: usage(),
        stopReason: "pending",
        timestamp: this.now(),
      },
    };
    this.requests.set(key, generation);
    this.subscribe(generation, stream, options?.signal);
    const run = identity?.redispatched
      ? this.resumeRecovery(route, generation, selection)
      : this.generate(route, generation, selection);
    void run.catch((error: unknown) => {
      if (generation.settled) return;
      const parsed = RuntimeFailure.safeParse(error);
      const live = [...this.sessions].find(
        (session) =>
          session.generation === generation || session.reserved === generation,
      );
      this.finish(
        live,
        generation,
        "error",
        this.options.heads.isRefused(generation.owner)
          ? resumeFailed
          : parsed.success
            ? terminalText(parsed.data)
            : "This turn could not be completed. Try another message.",
      );
      if (live) void this.closeLive(live);
      this.log("chat-runtime.generation.failed", {
        account: route.name,
        typed: parsed.success,
      });
    });
    return stream;
  }
  private subscribe(
    gen: Generation,
    stream: AssistantMessageEventStream,
    signal?: AbortSignal,
  ) {
    gen.streams.push(stream);
    stream.push({ type: "start", partial: gen.message });
    if (!signal) return;
    const abort = () => {
      signal.removeEventListener("abort", abort);
      gen.streams = gen.streams.filter((item) => item !== stream);
      const message = structuredClone(gen.message);
      message.stopReason = "aborted";
      if (message.responseId)
        message.responseId = responseId(pointer(message)?.session ?? "");
      markTerminal(message);
      stream.push({ type: "error", reason: "aborted", error: message });
      if (!gen.streams.length) {
        const live = [...this.sessions].find(
          (item) => item.generation === gen || item.reserved === gen,
        );
        this.finish(live, gen, "aborted");
        if (live) void this.closeLive(live);
      }
    };
    signal.addEventListener("abort", abort, { once: true });
    gen.cleanup.push(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  }
  private async generate(
    route: AccountRoute,
    gen: Generation,
    selection: SessionPolicy["model"],
  ) {
    const driver = this.options.recovery;
    const priorRecovery = await driver?.latest(gen.owner);
    if (
      driver &&
      priorRecovery &&
      (priorRecovery.value.state === "scheduled" ||
        priorRecovery.value.state === "started" ||
        priorRecovery.value.state === "running") &&
      ![...this.sessions].some(
        (live) =>
          live.owner === gen.owner &&
          live.recovery?.event === priorRecovery.event &&
          !live.closing,
      )
    ) {
      await driver.cancel(priorRecovery.value.turn);
      for (const request of this.requests.values()) {
        if (
          request !== gen &&
          request.recovery?.value.turn === priorRecovery.value.turn
        )
          this.finish(undefined, request, "aborted");
      }
    }
    const lastMessage = gen.messages.at(-1);
    if (
      priorRecovery?.value.state === "terminal" &&
      priorRecovery.value.reason === "ambiguous-tool-effect" &&
      lastMessage?.role === "toolResult"
    ) {
      const { transcriptDigest } = priorRecovery.value.checkpoint;
      const callIndex = gen.messages.findLastIndex(
        (message) =>
          message.role === "assistant" &&
          message.content.some(
            (block) =>
              block.type === "toolCall" && block.id === lastMessage.toolCallId,
          ),
      );
      if (
        headDigest(gen.messages) === transcriptDigest ||
        (callIndex >= 0 &&
          headDigest(gen.messages.slice(0, callIndex)) === transcriptDigest)
      ) {
        gen.recovery = priorRecovery;
        this.finish(undefined, gen, "error", ambiguousToolEffect);
        return;
      }
    }
    const conversationEpoch = this.conversationCloses.get(gen.owner);
    const accountEpoch = this.accountCloses.get(route.name);
    const cancelled = () =>
      this.closed ||
      gen.settled ||
      this.conversationCloses.get(gen.owner) !== conversationEpoch ||
      this.accountCloses.get(route.name) !== accountEpoch;
    if (cancelled()) {
      this.finish(undefined, gen, "aborted");
      return;
    }
    if (this.options.heads.isRefused(gen.owner)) {
      this.finish(undefined, gen, "error", resumeFailed);
      return;
    }
    const previous = newest(gen.messages);
    const prior =
      previous.message?.role === "assistant" ? previous.message : undefined;
    const compatible =
      prior &&
      (prior.provider === gen.message.provider ||
        (previous.pointer !== undefined &&
          (await this.compatible(
            prior.provider,
            route.continuation,
            gen.cancellation.signal,
          ))));
    if (cancelled()) {
      this.finish(undefined, gen, "aborted");
      return;
    }
    // Join a live end before reading its fork requirement.
    await Promise.all(
      [...this.sessions]
        .filter((live) => live.owner === gen.owner && live.closing)
        .map((live) => live.closing),
    );
    if (cancelled()) {
      this.finish(undefined, gen, "aborted");
      return;
    }
    const ownerHead = this.options.heads.get(gen.owner);
    const matchingContinuation =
      !ownerHead?.continuation ||
      (ownerHead.continuation.runtime === route.continuation.runtime &&
        ownerHead.continuation.key === route.continuation.key);
    const ownedContinuation =
      ownerHead?.continuation !== undefined &&
      matchingContinuation &&
      ownerHead.previousDigest ===
        headDigest(gen.messages.slice(0, previous.index + 1));
    const savedHead =
      matchingContinuation && (compatible || ownedContinuation || !prior)
        ? ownerHead
        : undefined;
    // Without input receipts, only a completed-turn pointer is safe to replay after.
    let completed: AssistantMessage | undefined;
    if (compatible) {
      const providers = new Set([gen.message.provider, prior?.provider]);
      for (let index = gen.messages.length - 1; index >= 0; index--) {
        const message = gen.messages[index];
        if (message?.role !== "assistant") continue;
        if (!pointer(message)) break;
        if (!providers.has(message.provider)) {
          if (
            !(await this.compatible(
              message.provider,
              route.continuation,
              gen.cancellation.signal,
            ))
          )
            break;
          providers.add(message.provider);
        }
        if (full(message) && pointer(message)?.completed) {
          completed = message;
          break;
        }
      }
    }
    const completedPoint = completed && pointer(completed);
    // A runtime that resumes only between turns forks only at the transcript's last completed turn
    // of this continuation, and only when nothing contradicts that lineage: with no head of this
    // continuation the transcript is all there is; with one, it must name that point or a fork from
    // it, over the transcript as it was then. Anything else (an edit since, or a session opened new
    // after one) opens new: a fork there would use a native session that holds other text.
    const lineage = matchingContinuation ? ownerHead : undefined;
    const forkPoint =
      route.capabilities.resumeInTurn ||
      !completed ||
      completedPoint?.resumePoint === undefined ||
      lineage === undefined ||
      (lineage.digest ===
        headDigest(
          gen.messages.slice(0, gen.messages.indexOf(completed) + 1),
        ) &&
        (lineage.resumePoint === completedPoint.resumePoint ||
          (lineage.forkedFrom?.session === completedPoint.session &&
            lineage.forkedFrom.resumePoint === completedPoint.resumePoint)))
        ? completedPoint
        : undefined;
    const firstInput = savedHead?.inputs?.[0];
    const before = firstInput?.before;
    const savedBase =
      before ??
      (!firstInput &&
      savedHead &&
      (savedHead.completed || savedHead.inputs !== undefined)
        ? savedHead.resumePoint
          ? {
              session: savedHead.session,
              resumePoint: savedHead.resumePoint,
              digest: savedHead.digest,
            }
          : savedHead.forkedFrom
            ? { ...savedHead.forkedFrom, digest: savedHead.digest }
            : undefined
        : undefined);
    const baseIndex = savedBase
      ? gen.messages.findLastIndex(
          (_message, index) =>
            headDigest(gen.messages.slice(0, index + 1)) === savedBase.digest ||
            (!firstInput &&
              savedHead?.completed === true &&
              headDigest(gen.messages.slice(0, index + 1)) ===
                savedHead.checkpointThrough),
        )
      : -1;
    const ownedHead = savedHead;
    // If a legacy/mismatched head cannot prove its boundary, use the transcript's completed flag.
    const target = !route.capabilities.resumeInTurn
      ? forkPoint
      : savedBase && baseIndex >= 0
        ? savedBase
        : completedPoint;
    const mirroredIndex = target?.resumePoint
      ? gen.messages.findLastIndex(
          (message) =>
            full(message) &&
            pointer(message)?.session === target.session &&
            pointer(message)?.resumePoint === target.resumePoint,
        )
      : -1;
    const checkpointIndex =
      savedBase && target === savedBase ? baseIndex : mirroredIndex;
    const point = ownedHead
      ? { session: ownedHead.session, resumePoint: ownedHead.resumePoint }
      : compatible
        ? previous.pointer
        : undefined;
    if (point) gen.message.responseId = responseId(point.session);
    const matchesHead =
      ownedHead !== undefined &&
      target !== undefined &&
      ownedHead.session === target.session &&
      ownedHead.resumePoint === target.resumePoint &&
      ownedHead.digest ===
        headDigest(gen.messages.slice(0, checkpointIndex + 1));
    const matchesCurrentHead =
      ownedHead &&
      gen.messages.some(
        (_message, index) =>
          headDigest(gen.messages.slice(0, index + 1)) === ownedHead.digest,
      );
    let live =
      point && matchesCurrentHead
        ? this.find(point.session, gen.owner)
        : undefined;
    live ??= [...this.sessions].find(
      (session) =>
        session.owner === gen.owner &&
        (session.generation?.key === gen.key ||
          session.replay?.key === gen.key),
    );
    if (live?.closing) {
      await live.closing;
      live = undefined;
    }
    if (cancelled()) {
      this.finish(undefined, gen, "aborted");
      return;
    }
    const desired = policy(
      offeredMessages(gen),
      () => Effect.succeed(stoppedCall),
      selection,
      {
        folder: gen.folder,
        skills: this.options.skills,
        ownTools: route.capabilities.ownTools,
        pluginTools: gen.pluginTools,
        mcpServers: gen.mcpServers,
        approvals: route.capabilities.approvals,
        attended: gen.attended,
      },
    );
    const tail = gen.messages.slice(previous.index + 1);
    const results = tail.filter(
      (message): message is ToolResultMessage => message.role === "toolResult",
    );
    const users = userContent(tail);
    if (live?.generation) {
      throw new Error("A different generation is active");
    }
    if (live?.replay?.key === gen.key) {
      this.finish(
        undefined,
        { ...gen, message: structuredClone(live.replay.message) },
        live.replay.message.stopReason === "toolUse"
          ? "toolUse"
          : live.replay.message.stopReason === "error"
            ? "error"
            : live.replay.message.stopReason === "aborted"
              ? "aborted"
              : "stop",
      );
      return;
    }
    const active = live;
    const heldRound =
      active &&
      active.turn &&
      results.some((result) => active.calls.has(result.toolCallId));
    if (live) this.reserve(live, gen);
    if (live && !heldRound) {
      if (live.state.kind !== "open") return;
      const changed =
        JSON.stringify(live.policy.model) !== JSON.stringify(selection);
      const reopen =
        policyKey(live.policy) !== policyKey(desired) ||
        live.route.name !== route.name ||
        (changed && (!route.capabilities.modelSwitchInSession || !selection));
      if (reopen) {
        live.reserved = undefined;
        await this.closeLive(live);
        live = undefined;
        if (cancelled()) {
          this.finish(undefined, gen, "aborted");
          return;
        }
      } else if (changed && selection) {
        const switched = await Effect.runPromise(
          live.state.session.setModel(selection).pipe(Effect.result),
          { signal: live.cancellation.signal },
        );
        if (cancelled() || live.closing) {
          this.finish(undefined, gen, "aborted");
          await this.closeLive(live);
          return;
        }
        if (switched._tag === "Failure") {
          live.reserved = undefined;
          await this.closeLive(live);
          if (cancelled()) {
            this.finish(undefined, gen, "aborted");
            return;
          }
          throw runtimeErrorToFailure(switched.failure);
        }
        live.policy = desired;
      }
    }
    if (!live) {
      // Invariant line 6: with no live instruction and no live held call, no turn starts.
      if (!route.capabilities.resumeInTurn && users.length === 0) {
        this.finish(undefined, gen, "error", interrupted);
        return;
      }
      let start: SessionStart = { kind: "new" };
      let fallback: SessionStart | undefined;
      if (point) {
        if (target?.resumePoint)
          fallback = {
            kind: "resume",
            session: target.session,
            at: target.resumePoint,
            fork: true,
          };
        if (
          matchesHead &&
          ownedHead &&
          ownedHead.completed &&
          !ownedHead.pending &&
          !ownedHead.forkRequired
        )
          start = { kind: "resume", session: ownedHead.session, fork: false };
        else if (fallback) start = fallback;
      }
      try {
        live = await this.open(route, gen, selection, start, cancelled);
      } catch (first) {
        if (start.kind !== "resume" || !sessionFailure(first)) throw first;
        if (!fallback || start.fork) {
          this.finish(undefined, gen, "error", resumeFailed);
          return;
        }
        try {
          start = fallback;
          live = await this.open(route, gen, selection, start, cancelled);
        } catch (second) {
          if (!sessionFailure(second)) throw second;
          this.finish(undefined, gen, "error", resumeFailed);
          return;
        }
      }
      if (!live) return;
      if (cancelled()) {
        await this.closeLive(live);
        this.finish(undefined, gen, "aborted");
        return;
      }
      if (live.closing || live.state.kind !== "open") return;
      if (
        start.kind === "resume" &&
        start.fork &&
        nativeId(live.state.session) === start.session
      ) {
        this.finish(live, gen, "error", resumeFailed);
        await this.closeLive(live);
        return;
      }
      gen.message.responseId = responseId(nativeId(live.state.session));
      const inPlace = start.kind === "resume" && !start.fork;
      const inputMessages = gen.messages.slice(
        target ? checkpointIndex + 1 : 0,
      );
      await this.options.heads.set(gen.owner, {
        session: nativeId(live.state.session),
        continuation: route.continuation,
        previousDigest: headDigest(gen.messages.slice(0, previous.index + 1)),
        ...(start.kind === "resume" && start.fork && target?.resumePoint
          ? {
              forkedFrom: {
                session: target.session,
                resumePoint: target.resumePoint,
              },
            }
          : inPlace && ownedHead
            ? {
                ...(ownedHead.checkpointThrough
                  ? { checkpointThrough: ownedHead.checkpointThrough }
                  : {}),
                ...(ownedHead.resumePoint
                  ? { resumePoint: ownedHead.resumePoint }
                  : {}),
                ...(ownedHead.forkedFrom
                  ? { forkedFrom: ownedHead.forkedFrom }
                  : {}),
              }
            : {}),
        pending: true,
        forkRequired: true,
        inputs: [],
        digest:
          inPlace && ownedHead
            ? ownedHead.digest
            : target
              ? headDigest(gen.messages.slice(0, checkpointIndex + 1))
              : headDigest(gen.messages),
      });
      if (cancelled() || live.closing) {
        this.finish(live, gen, "aborted");
        await this.closeLive(live);
        return;
      }
      if (!this.bind(live, gen)) return;
      // A runtime that resumes only between turns: a clean continuation resumes in place and gets
      // the inputs as today; anything else gets the hand-over of what its session does not hold.
      const message =
        !route.capabilities.resumeInTurn && !inPlace
          ? handOver(gen.messages, target ? checkpointIndex : -1)
          : point
            ? given(inputMessages)
            : prior
              ? handoff(gen.messages)
              : given(gen.messages);
      await this.start(live, message);
      return;
    }
    // A runtime that went on and ended its turn while pi recorded its work cannot be steered: the
    // person's message waits for that turn's end, which the kept events hold, and then starts the
    // next turn. Decided before binding, which starts recording those events.
    const ended =
      heldRound === true &&
      live.backlog.some((event) => event.type === "turn.finished");
    if (ended && users.length)
      live.followUp = [...(live.followUp ?? []), ...users];
    if (!this.bind(live, gen) || live.state.kind !== "open") return;
    if (heldRound) {
      if (!(await this.markPending(live))) return;
      if (users.length && ended) {
        // Recorded with the round's result below; the turn's end then starts it.
      } else if (users.length) {
        if (!(await this.markPending(live, "steer"))) return;
        await this.command(
          live,
          live.state.session.steerTurn({ turnId: live.turn!, message: users }),
        );
      }
      if (live.closing) return;
      for (const result of results) {
        if (!(await this.markPending(live, "result"))) return;
        this.release(live, result);
      }
    } else await this.start(live, users);
  }
  private async compatible(
    provider: string,
    target: ContinuationIdentity,
    signal: AbortSignal,
  ) {
    const parsed = (await import("@neuve/runtime")).AccountName.safeParse(
      accountForProvider(provider) ?? provider,
    );
    if (!parsed.success) return false;
    const identity = await Effect.runPromise(
      this.options.registry.continuation(parsed.data).pipe(Effect.result),
      { signal },
    );
    return (
      identity._tag === "Success" &&
      identity.success.runtime === target.runtime &&
      identity.success.key === target.key
    );
  }
  private async open(
    route: AccountRoute,
    gen: Generation,
    selection: SessionPolicy["model"],
    start: SessionStart,
    cancelled: () => boolean,
  ): Promise<Live | undefined> {
    if (cancelled()) {
      this.finish(undefined, gen, "aborted");
      return;
    }
    const scope = Scope.makeUnsafe();
    const { channel, skills } = this.options;
    const configured = {
      ...policy(
        offeredMessages(gen),
        (name, call, input) => this.wait(() => live, call, name, input),
        selection,
        {
          folder: gen.folder,
          skills,
          ownTools: route.capabilities.ownTools,
          pluginTools: gen.pluginTools,
          mcpServers: gen.mcpServers,
          approvals: route.capabilities.approvals,
          attended: gen.attended,
        },
      ),
      ...(channel === undefined || gen.chat === undefined
        ? {}
        : { environment: Identity.aceChatEnvironment(channel, gen.chat) }),
    };
    const live: Live = {
      owner: gen.owner,
      ...(gen.chat === undefined ? {} : { chat: gen.chat }),
      approvals: new Map(),
      scope,
      state: { kind: "acquiring", start },
      cancellation: new AbortController(),
      route,
      policy: configured,
      calls: new Map(),
      pendingWork: new Map(),
      backlog: [],
      generation: gen,
      last: this.now(),
    };
    this.sessions.add(live);
    try {
      let acquisitionExit: Exit.Exit<unknown, unknown> = Exit.void;
      const acquired = Promise.withResolvers<void>();
      live.acquisition = acquired.promise;
      const acquisition = Effect.runPromise(
        this.options.registry.openSession(route.name, configured, start).pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.onExit((exit) =>
            Effect.sync(() => {
              acquisitionExit = exit;
              if (live.closing && Exit.isFailure(exit)) {
                const defect = exit.cause.reasons.find(
                  (reason) => reason._tag === "Die",
                );
                if (defect)
                  this.log("chat-runtime.close.failed", { cause: defect._tag });
              }
            }),
          ),
          Effect.result,
        ),
        { signal: live.cancellation.signal },
      );
      void acquisition.then(
        () => acquired.resolve(),
        () => acquired.resolve(),
      );
      const opened = await acquisition;
      if (opened._tag === "Failure") {
        await this.closeLive(live, false, acquisitionExit);
        throw runtimeErrorToFailure(opened.failure);
      }
      if (cancelled() || live.closing) {
        await this.closeLive(live);
        return;
      }
      live.state = { kind: "open", session: opened.success };
    } catch (error) {
      if (cancelled()) {
        await this.closeLive(live);
        return;
      }
      await this.closeLive(live, false);
      throw error;
    }
    // Approval records follow the reader even while pi holds transcript recording at a tool call.
    live.reader = Effect.runPromise(
      Stream.runForEach(live.state.session.events, (event) => {
        const keep = Effect.sync(() => {
          // Pi waits for the result before starting the generation that drains the backlog.
          if (event.type === "work.finished") {
            live.pendingWork.get(event.workId)?.({
              output: event.output,
              errored: event.errored,
            });
            live.pendingWork.delete(event.workId);
            return;
          }
          if (event.type === "work.started") {
            if (live.closing) return;
            const { promise, resolve } = Promise.withResolvers<WorkOutcome>();
            live.pendingWork.set(event.workId, resolve);
            live.backlog.push({ ...event, outcome: promise });
          } else live.backlog.push(event);
          void this.pump(live);
        });
        if (
          event.type === "approval.requested" ||
          event.type === "approval.resolved" ||
          event.type === "turn.finished"
        )
          return Effect.uninterruptible(
            Effect.promise(() => this.trackApproval(live, event)),
          ).pipe(Effect.andThen(keep));
        return keep;
      }),
      { signal: live.cancellation.signal },
    ).then(
      () => this.endReader(live, "ended"),
      () => this.endReader(live, "failed"),
    );
    void live.reader.then(() => this.pump(live));
    return live;
  }
  private async trackApproval(
    live: Live,
    event:
      | ApprovalRequestEvent
      | Extract<RuntimeEvent, { type: "approval.resolved" | "turn.finished" }>,
  ) {
    const store = this.approvals;
    const chat = live.chat;
    if (!store || chat === undefined) return;
    if (event.type === "approval.requested") {
      if (live.closing || live.approvalEnd === "stopped") return;
      live.approvals.set(event.requestId, { turn: event.turnId });
      await store.open(chat, event);
      live.approvalWatch ??= await store.watch(chat, async (answer) => {
        await this.replyToApproval(chat, answer);
      });
    } else if (event.type === "approval.resolved") {
      await this.closeApprovals(live, "runtime-resolved", [event.requestId]);
    } else {
      await this.closeApprovals(
        live,
        live.approvalEnd ?? "turn-ended",
        [...live.approvals]
          .filter(([, approval]) => approval.turn === event.turnId)
          .map(([id]) => id),
      );
    }
  }
  async replyToApproval(
    chat: ConversationId,
    answer: ApprovalReply,
    record?: () => Promise<void>,
  ): Promise<boolean> {
    const { requestId } = answer;
    const live = [...this.sessions].find(
      (session) => session.chat === chat && session.approvals.has(requestId),
    );
    const approval = live?.approvals.get(requestId);
    if (!live || !approval || live.state.kind !== "open") return false;
    if (approval.closing) {
      await approval.closing;
      return false;
    }
    if (live.closing || live.approvalEnd || approval.reply) return false;
    const session = live.state.session;
    const reply = Promise.resolve().then(async () => {
      const delivered = await Effect.runPromise(
        session.respondToApproval(answer),
      );
      if (delivered.delivered) {
        await record?.();
        live.approvals.delete(requestId);
        return true;
      }
      if (delivered.reason !== undefined) {
        const reason =
          delivered.reason === "turn-ended"
            ? (live.approvalEnd ?? delivered.reason)
            : delivered.reason;
        await this.approvals?.close(chat, new Set([requestId]), reason);
        live.approvals.delete(requestId);
      }
      return false;
    });
    approval.reply = reply;
    try {
      return await reply;
    } catch (error) {
      this.log("chat-runtime.approval.reply.failed", {
        requestId,
        cause: error instanceof Error ? error.message : String(error),
      });
      if (record) throw error;
      return false;
    } finally {
      delete approval.reply;
    }
  }

  private async closeApprovals(
    live: Live,
    reason: ApprovalEnd,
    ids: Iterable<string>,
  ) {
    const { approvals: store } = this;
    const { chat } = live;
    if (!store || chat === undefined) return;
    const closing = new Map<string, LiveApproval>();
    const previous = new Set<Promise<void>>();
    for (const id of ids) {
      const approval = live.approvals.get(id);
      if (approval?.closing) previous.add(approval.closing);
      else if (approval) closing.set(id, approval);
    }
    const closed = Promise.resolve().then(async () => {
      // A reply that reached the process must keep its recorded answer even if the turn ends.
      await Promise.allSettled([...closing.values()].map(({ reply }) => reply));
      const requests = new Set(
        [...closing.keys()].filter((id) => live.approvals.has(id)),
      );
      if (!requests.size) return;
      await store.close(chat, requests, reason);
      for (const id of requests) live.approvals.delete(id);
    });
    for (const approval of closing.values()) approval.closing = closed;
    try {
      await Promise.all([closed, ...previous]);
    } finally {
      for (const approval of closing.values()) delete approval.closing;
    }
  }
  private async endReader(
    live: Live,
    status: NonNullable<Live["streamEnded"]>,
  ) {
    this.settleWork(live, "The runtime ended before reporting a result.");
    const reason = live.approvalEnd ?? "turn-ended";
    try {
      await this.closeApprovals(live, reason, live.approvals.keys());
    } catch (error) {
      status = "failed";
      this.log("chat-runtime.approval.close.failed", {
        owner: live.owner,
        reason,
        cause: error instanceof Error ? error.message : String(error),
      });
    } finally {
      await live.approvalWatch?.();
      live.streamEnded = status;
    }
  }
  private reserve(live: Live, gen: Generation) {
    clearTimeout(live.timer);
    live.reserved = gen;
    gen.cleanup.push(() => {
      if (live.reserved === gen) live.reserved = undefined;
    });
  }
  private bind(live: Live, gen: Generation) {
    if (live.closing || gen.settled || live.state.kind !== "open") {
      this.finish(undefined, gen, "aborted");
      return false;
    }
    if (live.reserved !== gen) this.reserve(live, gen);
    if (gen.settled) return false;
    live.reserved = undefined;
    live.generation = gen;
    gen.recovery = live.recovery;
    gen.message.responseId = responseId(nativeId(live.state.session));
    if (live.holding) {
      live.holding = false;
      void this.pump(live);
    }
    return !gen.settled;
  }
  private async command(
    live: Live,
    command: Effect.Effect<void, import("@neuve/runtime").RuntimeError>,
  ) {
    const done = Promise.withResolvers<void>();
    live.command = done.promise;
    let failed = false;
    try {
      const result = await Effect.runPromise(command.pipe(Effect.result), {
        signal: live.cancellation.signal,
      });
      if (result._tag === "Failure") {
        failed = true;
        if (live.generation)
          this.finish(
            live,
            live.generation,
            "error",
            terminalText(runtimeErrorToFailure(result.failure)),
          );
      }
    } finally {
      done.resolve();
      if (live.command === done.promise) delete live.command;
    }
    if (failed) await this.closeLive(live);
  }
  private async markPending(
    live: Live,
    kind?: "message" | "steer" | "result",
  ): Promise<boolean> {
    const head = this.options.heads.get(live.owner);
    if (!head || live.closing) return false;
    const point = head.resumePoint
      ? { session: head.session, resumePoint: head.resumePoint }
      : head.forkedFrom;
    await this.options.heads.set(live.owner, {
      ...head,
      pending: true,
      forkRequired: true,
      ...(kind
        ? {
            inputs: [
              ...(head.inputs ?? []),
              {
                kind,
                through: headDigest(live.generation?.messages ?? []),
                ...(point ? { before: { ...point, digest: head.digest } } : {}),
              },
            ],
          }
        : {}),
    });
    return !live.closing;
  }
  private async start(
    live: Live,
    message: Parameters<RuntimeSession["startTurn"]>[0]["message"],
  ) {
    if (live.closing || live.state.kind !== "open") {
      if (live.generation) this.finish(live, live.generation, "aborted");
      return;
    }
    live.retryBase = this.options.heads.get(live.owner)?.resumePoint;
    if (!(await this.markPending(live, "message"))) return;
    live.turn = crypto.randomUUID();
    live.retryRequest = message;
    live.logicalTurn ??= crypto.randomUUID();
    live.lastResumePoint = undefined;
    const folder = live.route.capabilities.ownTools
      ? live.policy.folder
      : undefined;
    const offer = live.generation?.toolOffer;
    const access =
      offer && Reflect.get(offer, planningRequest) === true
        ? "read-only"
        : "write";
    await this.command(
      live,
      live.state.session.startTurn({
        turnId: live.turn,
        message,
        ...(folder === undefined ? {} : { workspace: { folder, access } }),
      }),
    );
    await this.followSession(live);
  }
  /**
   * A runtime may replace a session that holds no turn yet when the turn starts (Codex starts a new
   * thread when it restarts for the turn's mode). The head follows before any round is recorded,
   * so the turn's later rounds find this session and the next message resumes it.
   */
  private async followSession(live: Live) {
    const head = this.options.heads.get(live.owner);
    if (
      head === undefined ||
      live.closing ||
      live.state.kind !== "open" ||
      head.session === nativeId(live.state.session)
    )
      return;
    await this.options.heads.set(live.owner, {
      ...head,
      session: nativeId(live.state.session),
    });
  }
  private async resolveDelivery(live: Live) {
    const head = this.options.heads.get(live.owner);
    if (!head?.pending || live.state.kind !== "open") return;
    const {
      pending: _pending,
      completed: _completed,
      deliveredThrough: _delivered,
      ...unfinished
    } = head;
    await this.options.heads.set(live.owner, {
      ...unfinished,
      ...(live.checkpoint ?? {}),
      session: nativeId(live.state.session),
      forkRequired: true,
    });
  }
  private wait(
    read: () => Live | undefined,
    call: ToolCall | undefined,
    name?: string,
    input?: unknown,
  ): Effect.Effect<ToolOutcome> {
    return Effect.callback((resume) => {
      const live = read();
      const cancel = () => {
        if (live) void this.closeLive(live, !live.command);
        resume(Effect.interrupt);
      };
      if (live && call?.signal.aborted) {
        cancel();
        return;
      }
      if (!live || !call?.callId || live.closing) {
        if (live && !call?.callId) {
          this.log("chat-runtime.protocol.fault", {
            reason: "missing-call-id",
          });
          void this.closeLive(live);
        }
        resume(Effect.succeed(stoppedCall));
        return;
      }
      if (live.recovery && live.generation && name) {
        try {
          const recorded = replayTool(
            toolLedger(live.generation.messages),
            call.callId,
            name,
            input,
          );
          if (recorded) {
            this.log("chat-runtime.retry.tool-replayed", {
              turn: live.recovery.value.turn,
              call: call.callId,
            });
            resume(Effect.succeed(recorded));
            return;
          }
        } catch {
          this.log("chat-runtime.retry.tool-ambiguous", {
            turn: live.recovery.value.turn,
            call: call.callId,
          });
          void this.closeLive(live);
          resume(Effect.succeed(stoppedCall));
          return;
        }
      }
      const entry = live.calls.get(call.callId) ?? { delivered: false };
      live.calls.set(call.callId, entry);
      if (entry.delivered || entry.waiter) {
        this.log("chat-runtime.protocol.fault", {
          reason: "duplicate-handler",
        });
        void this.closeLive(live);
        resume(Effect.succeed(stoppedCall));
        return;
      }
      const done = (value: ToolOutcome) => {
        call.signal.removeEventListener("abort", abort);
        entry.waiter = undefined;
        entry.delivered = true;
        entry.result = undefined;
        resume(Effect.succeed(value));
      };
      const abort = cancel;
      entry.waiter = done;
      call.signal.addEventListener("abort", abort, { once: true });
      if (entry.result) done(entry.result);
      return Effect.sync(() => {
        call.signal.removeEventListener("abort", abort);
        entry.waiter = undefined;
        // Scope.close starts synchronously. Do not join shutdown from a handler it must drain.
        void this.closeLive(live, !live.command);
      });
    });
  }
  private release(live: Live, result: ToolResultMessage) {
    const entry = live.calls.get(result.toolCallId);
    if (!entry || entry.delivered || entry.result) return;
    const outcome: ToolOutcome = {
      text: resultText(result),
      ...(result.isError ? { error: resultText(result) } : {}),
    };
    entry.result = outcome;
    entry.waiter?.(outcome);
  }
  /**
   * The one place events are recorded, in order: what the reader kept, until a round recorded as
   * a tool call holds for pi's next generation (a runtime with its own tools goes on meanwhile), a
   * person's stop closes the session, or nothing is left. Once the stream has ended and nothing is
   * left, it ends the session, as a failure in recording does, with the same message.
   */
  private async pump(live: Live): Promise<void> {
    if (live.pumping) return;
    live.pumping = true;
    let failed = false;
    try {
      while (live.backlog.length > 0 && !live.holding && !live.closing)
        await this.handle(live, live.backlog.shift()!);
    } catch {
      failed = true;
    } finally {
      live.pumping = false;
    }
    if (live.closing) return;
    if (!failed && live.backlog.length > 0 && !live.holding)
      return this.pump(live);
    if (
      failed ||
      (live.streamEnded !== undefined &&
        live.backlog.length === 0 &&
        !live.holding)
    )
      await this.endLive(live, failed || live.streamEnded === "failed");
  }
  /** The session's end: the open generation is answered when the end was a failure, then closed. */
  private async endLive(live: Live, failed: boolean) {
    // Account checks can end events before returning their typed command failure.
    await live.command;
    if (failed && !live.closing && live.generation)
      this.finish(
        live,
        live.generation,
        "error",
        this.options.heads.isRefused(live.owner)
          ? resumeFailed
          : "This turn did not produce an answer. Try another message.",
      );
    if (!live.closing) await this.closeLive(live);
  }
  private async handle(live: Live, event: TranscriptEvent) {
    // Scope closure may publish an interrupted turn before checkTurn returns its typed failure.
    if (event.type === "turn.finished") await live.command;
    if (live.closing || live.state.kind !== "open") return;
    const session = live.state.session;
    const gen = live.generation;
    if (
      (event.type === "text" ||
        event.type === "message.finished" ||
        event.type === "tool.started" ||
        event.type === "work.started") &&
      !gen
    ) {
      this.log("chat-runtime.protocol.fault", {
        reason: "output-without-generation",
      });
      await this.closeLive(live);
      return;
    }
    if (event.type === "text" && gen) {
      gen.message.responseId = responseId(nativeId(session));
      let block = gen.message.content.at(-1);
      if (block?.type !== "text") {
        block = { type: "text", text: "" };
        gen.message.content.push(block);
        for (const stream of gen.streams)
          stream.push({
            type: "text_start",
            contentIndex: gen.message.content.length - 1,
            partial: gen.message,
          });
      }
      block.text += event.text;
      for (const stream of gen.streams)
        stream.push({
          type: "text_delta",
          contentIndex: gen.message.content.length - 1,
          delta: event.text,
          partial: gen.message,
        });
    }
    if (event.type === "message.finished" && gen) {
      // Only a runtime that resumes inside a turn can resume at a message.
      const resumePoint = live.route.capabilities.resumeInTurn
        ? event.resumePoint
        : undefined;
      live.lastResumePoint = resumePoint;
      for (const [id, call] of live.calls)
        if (call.delivered) live.calls.delete(id);
      const calls = mirrorCalls(
        event,
        new Set(live.policy.tools.map((tool) => tool.name)),
        this.log,
      );
      const ledger = live.recovery ? toolLedger(gen.messages) : undefined;
      const freshCalls = ledger
        ? calls.filter((call) => {
            if (call.type !== "toolCall" || !ledger.calls.has(call.id))
              return true;
            replayTool(ledger, call.id, call.name, call.arguments);
            return false;
          })
        : calls;
      for (const call of freshCalls)
        if (call.type === "toolCall") {
          live.calls.set(
            call.id,
            live.calls.get(call.id) ?? { delivered: false },
          );
          gen.message.content.push(call);
        }
      gen.message.usage = usage(event.usage);
      if (event.model) gen.message.responseModel = event.model;
      if (event.stopReason === "tool-use" && !freshCalls.length) return;
      gen.message.responseId = responseId(
        nativeId(session),
        event.stopReason === "end-turn" || event.stopReason === "tool-use"
          ? resumePoint
          : "",
      );
      if (event.stopReason === "tool-use") {
        await this.followSession(live);
        if (resumePoint !== undefined)
          await this.recordHead(live, gen, resumePoint, "toolUse");
        this.finish(live, gen, "toolUse");
      } else if (event.stopReason === "end-turn") {
        gen.message.stopReason = "stop";
        if (resumePoint !== undefined)
          live.checkpoint = {
            session: nativeId(session),
            resumePoint,
            checkpointThrough: headDigest(gen.messages),
            digest: headDigest([...gen.messages, gen.message]),
          };
        // Keep the generation open through turn.finished, so failures and carrier checkpoints are recorded.
      } else {
        const refusal =
          event.stopReason === "refusal"
            ? gen.message.content
                .flatMap((block) => (block.type === "text" ? [block.text] : []))
                .join("")
                .trim()
            : "";
        this.finish(
          live,
          gen,
          "error",
          refusal ||
            "This turn did not produce an answer. Try another message.",
        );
        await this.closeLive(live);
      }
    }
    if (event.type === "work.started" && gen) {
      const id = `work-${event.workId}`;
      this.workResults.set(id, event.outcome);
      live.calls.set(id, { delivered: true });
      gen.message.content.push({
        type: "toolCall",
        id,
        name: RUNTIME_WORK_TOOL,
        arguments: {
          kind: event.kind,
          input: event.input,
        },
      });
      gen.message.responseId = responseId(nativeId(session), "");
      await this.followSession(live);
      this.finish(live, gen, "toolUse");
      return;
    }
    if (event.type === "usage" && event.scope === "turn") {
      if (gen && event.contextTokens !== undefined) {
        gen.message.diagnostics = [
          ...(gen.message.diagnostics ?? []).filter(
            (item) => item.type !== "neuve.context-usage",
          ),
          {
            type: "neuve.context-usage",
            timestamp: gen.message.timestamp,
            details: { tokens: event.contextTokens },
          },
        ];
      }
      if (
        event.model &&
        (event.contextWindow !== undefined ||
          event.maxOutputTokens !== undefined)
      )
        for (const listener of this.limitListeners)
          listener(live.route.name, event.model, {
            ...(event.contextWindow === undefined
              ? {}
              : { contextWindow: event.contextWindow }),
            ...(event.maxOutputTokens === undefined
              ? {}
              : { maxTokens: event.maxOutputTokens }),
          });
    }
    if (event.type === "turn.finished") {
      if ([...live.calls.values()].some((call) => !call.delivered)) {
        if (event.outcome.status === "failed" && (gen ?? live.lastGeneration))
          await this.retryTurn(live, (gen ?? live.lastGeneration)!, event);
        this.log("chat-runtime.protocol.fault", {
          reason: "turn-ended-with-held-calls",
        });
        await this.closeLive(live);
        return;
      }
      live.turn = undefined;
      if (gen) {
        if (event.outcome.status === "completed") {
          const point = turnResumePoint(event) ?? live.lastResumePoint;
          if (!point && !live.route.capabilities.resumeInTurn) {
            // The contract requires this turn's end as its resume point. Without it nothing proves
            // what the native session holds, so no head may survive to fork a stale turn from.
            this.log("chat-runtime.protocol.fault", {
              reason: "turn-ended-without-resume-point",
            });
            const head = this.options.heads.get(gen.owner);
            if (head)
              await this.options.heads
                .restore(gen.owner, head, undefined)
                .catch(() => {
                  this.log("chat-runtime.head.restore.failed", {
                    owner: gen.owner,
                  });
                });
            this.finish(
              live,
              gen,
              "error",
              "This turn did not produce an answer. Try another message.",
            );
            await this.closeLive(live);
            return;
          }
          if (point) {
            gen.message.responseId = responseId(nativeId(session), point, true);
            await this.recordHead(live, gen, point, "stop");
          }
          if (live.recovery && this.options.recovery) {
            const recovered = await this.options.recovery.settle({
              turn: live.recovery.value.turn,
              expected: live.recovery.event,
              state: "recovered",
            });
            live.recoveryEnd?.({
              state: recovered,
              message: { ...structuredClone(gen.message), stopReason: "stop" },
            });
            gen.recovery = undefined;
            live.recovery = undefined;
            live.recoveryEnd = undefined;
            if (recovered.value.state !== "recovered") {
              this.finish(live, gen, "aborted");
              await this.closeLive(live);
              return;
            }
          }
          live.logicalTurn = undefined;
          // The person wrote while the ended turn was still being recorded: their message starts
          // the next turn, and its answer continues this generation.
          if (point && live.followUp !== undefined && !live.closing) {
            const message = live.followUp;
            live.followUp = undefined;
            await this.start(live, message);
            return;
          }
          if (!point) await this.resolveDelivery(live);
          this.finish(live, gen, "stop");
          if (!point) await this.closeLive(live);
        } else {
          if (
            event.outcome.status === "failed" &&
            (await this.retryTurn(live, gen, event))
          )
            return;
          this.finish(
            live,
            gen,
            event.outcome.status === "interrupted" ? "aborted" : "error",
            event.outcome.status === "failed"
              ? (gen.message.errorMessage ??
                  terminalText(event.outcome.failure))
              : undefined,
          );
          await this.closeLive(live);
        }
      }
      if (event.outcome.status !== "completed") await this.closeLive(live);
      this.idle(live);
    }
  }
  private async resumeRecovery(
    route: AccountRoute,
    gen: Generation,
    selection: SessionPolicy["model"],
  ) {
    const driver = this.options.recovery;
    const state =
      driver &&
      (await driver.find(
        gen.owner,
        digest([{ role: "user", content: gen.key, timestamp: 0 }]),
      ));
    if (
      !driver ||
      !state ||
      (state.value.state !== "scheduled" && state.value.job === undefined) ||
      state.value.checkpoint.transcriptDigest !== headDigest(gen.messages) ||
      state.value.checkpoint.resultsDigest !==
        toolLedger(gen.messages).digest ||
      state.value.checkpoint.account !== route.name ||
      state.value.checkpoint.continuation !== JSON.stringify(route.continuation)
    ) {
      this.finish(undefined, gen, "aborted");
      return;
    }
    gen.recovery = state;
    await this.recover(route, gen, selection, state);
  }
  private async retryTurn(
    live: Live,
    gen: Generation,
    event: Extract<RuntimeEvent, { type: "turn.finished" }>,
  ) {
    const driver = this.options.recovery;
    if (event.outcome.status !== "failed" || live.state.kind !== "open")
      return false;
    const ledger = toolLedger(gen.messages);
    let decision = retryDecision(event.outcome, {
      ledger: toolLedger(
        gen.messages.slice(
          gen.messages.findLastIndex(
            (message) =>
              message.role === "assistant" &&
              pointer(message)?.completed === true,
          ) + 1,
        ),
      ),
      outstanding:
        live.pendingWork.size > 0 ||
        [...live.calls.values()].some((call) => !call.delivered),
      canResume: live.route.capabilities.resume,
      ...(event.resumePoint === undefined
        ? {}
        : { resumePoint: event.resumePoint }),
    });
    if (decision.retry && gen.message.stopReason === "stop")
      decision = { retry: false, reason: "unsafe-continuation" };
    const repeat = decision.retry && decision.continuation === "repeat-request";
    const request = repeat ? live.retryRequest : continueSavedTurn;
    const point = repeat ? live.retryBase : event.resumePoint;
    if (
      request === undefined ||
      (repeat && point !== undefined && !live.route.capabilities.resume)
    )
      decision = { retry: false, reason: "unsafe-continuation" };
    if (!decision.retry && decision.reason === "ambiguous-tool-effect")
      gen.message.errorMessage = ambiguousToolEffect;
    if (
      !driver ||
      (!live.recovery &&
        !decision.retry &&
        decision.reason === "terminal-runtime-failure")
    )
      return false;
    const checkpoint: TurnRecoveryCheckpoint = {
      id: await driver.saveRequest(request ?? continueSavedTurn),
      generation: digest([{ role: "user", content: gen.key, timestamp: 0 }]),
      account: live.route.name,
      session: nativeId(live.state.session),
      ...(point === undefined ? {} : { resumePoint: point }),
      continuation: JSON.stringify(live.route.continuation),
      transcriptDigest: headDigest(gen.messages),
      resultsDigest: ledger.digest,
      continuationMode: decision.retry ? decision.continuation : "resume",
    };
    const turn =
      live.recovery?.value.turn ?? live.logicalTurn ?? crypto.randomUUID();
    const origin = live.recovery
      ? { expected: live.recovery.event }
      : { first: { chat: gen.owner, checkpoint } };
    if (!decision.retry) {
      const terminal = await driver.settle({
        turn,
        ...origin,
        state: "terminal",
        reason: decision.reason,
      });
      gen.recovery = terminal;
      live.recoveryEnd?.({
        state: terminal,
        message: {
          ...structuredClone(gen.message),
          stopReason: "error",
          errorMessage:
            gen.message.errorMessage ?? terminalText(event.outcome.failure),
        },
      });
      live.recoveryEnd = undefined;
      return false;
    }
    if (gen.settled) return false;
    const scheduled = await driver.schedule({
      turn,
      ...origin,
      checkpoint,
      nextAt: retryAt(
        Math.min(5, (live.recovery?.value.attempt ?? 0) + 1),
        this.now(),
        decision.retryAfterMs,
      ),
      reason: decision.reason,
    });
    if (gen.settled && !this.closed) await driver.cancel(turn);
    live.recovery = scheduled;
    gen.recovery = scheduled;
    live.recoveryEnd?.({
      state: scheduled,
      ...(scheduled.value.state === "terminal"
        ? {
            message: {
              ...structuredClone(gen.message),
              stopReason: "error",
              errorMessage: terminalText(event.outcome.failure),
            },
          }
        : {}),
    });
    live.recoveryEnd = undefined;
    if (scheduled.value.state !== "scheduled") return false;
    gen.message = { ...gen.message, content: [], usage: usage() };
    live.generation = undefined;
    await this.closeLive(live, false);
    if (!gen.settled)
      await this.recover(live.route, gen, gen.selection, scheduled);
    return true;
  }
  private async recover(
    route: AccountRoute,
    gen: Generation,
    selection: SessionPolicy["model"],
    scheduled: TurnRecovery.RecoveryState,
  ) {
    try {
      await this.dispatchRecovery(route, gen, selection, scheduled);
    } catch (error) {
      if (gen.settled) return;
      if (error instanceof RecoveryOwnershipUnknown) {
        gen.recovery = undefined;
        this.finish(undefined, gen, "error", unsafeContinuation);
        return;
      }
      const current = gen.recovery ?? scheduled;
      const terminal = await this.options.recovery
        ?.settle({
          turn: current.value.turn,
          expected: current.event,
          state: "terminal",
          reason: "unsafe-continuation",
        })
        .catch(() =>
          this.log("chat-runtime.retry.publication.failed", {
            turn: current.value.turn,
          }),
        );
      if (terminal) gen.recovery = terminal;
      this.finish(undefined, gen, "error", unsafeContinuation);
    }
  }
  private async dispatchRecovery(
    route: AccountRoute,
    gen: Generation,
    selection: SessionPolicy["model"],
    scheduled: TurnRecovery.RecoveryState,
  ) {
    const driver = this.options.recovery!;
    let holder = false;
    const output = await driver.execute(
      scheduled,
      gen.cancellation.signal,
      async (signal, scheduled) => {
        holder = true;
        const attemptSignal = AbortSignal.any([
          signal,
          gen.cancellation.signal,
        ]);
        const started = await driver.wait(scheduled, attemptSignal);
        gen.recovery = started;
        if (gen.settled || signal.aborted || started.value.state !== "started")
          return { state: started };
        const checkpoint = started.value.checkpoint;
        if (
          checkpoint.transcriptDigest !== headDigest(gen.messages) ||
          checkpoint.resultsDigest !== toolLedger(gen.messages).digest
        )
          throw new Error("Durable recovery generation changed");
        const cancelled = () =>
          this.closed || gen.settled || attemptSignal.aborted;
        const request = await driver.loadRequest(checkpoint.id);
        if (cancelled()) return { state: started };
        const start: SessionStart =
          checkpoint.resumePoint === undefined
            ? { kind: "new" }
            : {
                kind: "resume",
                session: checkpoint.session,
                at: checkpoint.resumePoint,
                fork: false,
              };
        const live = await this.open(route, gen, selection, start, cancelled);
        if (!live || live.state.kind !== "open" || cancelled())
          return { state: started };
        live.recovery = started;
        live.logicalTurn = started.value.turn;
        await this.options.heads.set(gen.owner, {
          session: nativeId(live.state.session),
          continuation: route.continuation,
          previousDigest: checkpoint.transcriptDigest,
          digest: checkpoint.transcriptDigest,
          ...(checkpoint.resumePoint === undefined
            ? {}
            : { resumePoint: checkpoint.resumePoint }),
          checkpointThrough: checkpoint.transcriptDigest,
          pending: true,
          forkRequired: true,
          inputs: [],
        });
        const completed = Promise.withResolvers<RecoveryResult>();
        live.recoveryEnd = completed.resolve;
        const current = await driver.latest(gen.owner);
        if (current?.event !== started.event || cancelled()) {
          await this.closeLive(live);
          return { state: current ?? started };
        }
        if (!this.bind(live, gen)) return { state: started };
        await this.start(live, request);
        return completed.promise;
      },
    );
    if (!gen.settled && (!holder || output.state.value.state !== "scheduled")) {
      gen.recovery = output.state;
      if (output.state.value.state === "scheduled") {
        await this.dispatchRecovery(route, gen, selection, output.state);
      } else if (output.message) {
        gen.message = structuredClone(output.message);
        this.finish(
          undefined,
          gen,
          output.message.stopReason === "stop" ? "stop" : "error",
          output.message.errorMessage,
        );
      } else if (output.state.value.state === "cancelled") {
        this.finish(undefined, gen, "aborted");
      } else
        this.finish(
          undefined,
          gen,
          "error",
          output.state.value.reason === "ambiguous-tool-effect"
            ? ambiguousToolEffect
            : unsafeContinuation,
        );
    }
  }
  private async recordHead(
    live: Live,
    gen: Generation,
    point: string,
    stopReason: "stop" | "toolUse",
  ) {
    if (live.closing || live.state.kind !== "open") return;
    const session = nativeId(live.state.session);
    const previous = this.options.heads.get(gen.owner);
    const head = {
      owner: gen.owner,
      previous,
      value: {
        session,
        continuation: live.route.continuation,
        previousDigest: previous?.previousDigest,
        resumePoint: point,
        checkpointThrough: headDigest(gen.messages),
        digest: headDigest([...gen.messages, { ...gen.message, stopReason }]),
        ...(stopReason === "stop"
          ? { completed: true as const }
          : {
              pending: true as const,
              forkRequired: true as const,
              ...(previous?.inputs ? { inputs: previous.inputs } : {}),
            }),
      },
    };
    live.checkpoint = {
      session: head.value.session,
      resumePoint: head.value.resumePoint,
      checkpointThrough: head.value.checkpointThrough,
      digest: head.value.digest,
    };
    gen.head = head;
    try {
      await this.options.heads.set(gen.owner, head.value);
    } finally {
      if (
        gen.settled &&
        (gen.message.stopReason === "error" ||
          gen.message.stopReason === "aborted")
      )
        this.restoreHead(head);
    }
  }
  private restoreHead(head: NonNullable<Generation["head"]>) {
    void this.options.heads
      .restore(head.owner, head.value, head.previous)
      .catch(() => {
        this.log("chat-runtime.head.restore.failed", { owner: head.owner });
      });
  }
  private finish(
    live: Live | undefined,
    gen: Generation,
    reason: "stop" | "toolUse" | "error" | "aborted",
    text?: string,
  ) {
    if (gen.settled) return;
    gen.settled = true;
    const recovery = gen.recovery?.value;
    if (reason === "aborted" || recovery?.state === "cancelled") {
      (gen.message.diagnostics ??= []).push({
        type: TURN_CANCELLED,
        timestamp: this.now(),
      });
    } else if (reason === "error" && recovery?.state === "terminal") {
      const details = TurnRetryFailure.safeParse({
        turn: recovery.turn,
        attempt: recovery.attempt,
        reason: recovery.reason,
      });
      if (details.success)
        (gen.message.diagnostics ??= []).push({
          type: TURN_RETRY_FAILURE,
          timestamp: this.now(),
          details: details.data,
        });
    }
    if (
      !this.closed &&
      (reason === "error" || reason === "aborted") &&
      gen.recovery &&
      recovery?.state !== "terminal" &&
      this.options.recovery
    )
      void this.options.recovery.cancel(gen.recovery.value.turn).catch(() =>
        this.log("chat-runtime.retry.cancel.failed", {
          turn: gen.recovery?.value.turn,
        }),
      );
    this.requests.delete(gen.key);
    gen.message.stopReason = reason;
    if (reason === "error" || reason === "aborted") {
      if (gen.head) this.restoreHead(gen.head);
      gen.cancellation.abort();
      if (gen.message.responseId)
        gen.message.responseId = responseId(
          pointer(gen.message)?.session ?? "",
        );
      if (text) gen.message.errorMessage = text;
      markTerminal(gen.message);
    }
    for (const clean of gen.cleanup) clean();
    for (const stream of gen.streams) {
      if (reason === "error" || reason === "aborted")
        stream.push({
          type: "error",
          reason: gen.message.stopReason === "aborted" ? "aborted" : "error",
          error: gen.message,
        });
      else stream.push({ type: "done", reason, message: gen.message });
    }
    if (live) {
      live.replay = { key: gen.key, message: structuredClone(gen.message) };
      if (live.generation === gen) {
        live.lastGeneration = gen;
        live.generation = undefined;
      }
      if (
        reason === "toolUse" &&
        live.turn !== undefined &&
        live.route.capabilities.ownTools
      )
        live.holding = true;
      this.idle(live);
    }
  }
  private idle(live: Live) {
    if (
      live.closing ||
      live.state.kind === "acquiring" ||
      live.generation ||
      live.reserved ||
      live.turn
    )
      return;
    live.last = this.now();
    clearTimeout(live.timer);
    live.timer = setTimeout(() => {
      if (
        live.state.kind === "open" &&
        !live.generation &&
        !live.reserved &&
        !live.turn
      )
        void this.closeLive(live);
    }, this.options.idleMs ?? 600_000);
    live.timer.unref?.();
    // A tool round is busy even while no pi generation streams.
    const idle = [...this.sessions]
      .filter(
        (item) =>
          item.state.kind === "open" &&
          !item.turn &&
          !item.generation &&
          !item.reserved &&
          !item.closing,
      )
      .sort((a, b) => a.last - b.last);
    for (const extra of idle.slice(0, -2)) void this.closeLive(extra);
  }
  private find(session: string, owner: string) {
    return [...this.sessions].find(
      (live) =>
        live.owner === owner &&
        live.state.kind === "open" &&
        nativeId(live.state.session) === session,
    );
  }
  async closeSession(session: string) {
    await Promise.all(
      [...this.sessions]
        .filter(
          (live) =>
            live.state.kind === "open" &&
            nativeId(live.state.session) === session,
        )
        .map((live) => this.closeLive(live)),
    );
  }
  /** Stop closes the records before pi aborts the turn and writes its Stop entry. */
  async stopApprovals(chat: ConversationId) {
    await this.cancelRecovery(String(chat));
    const sessions = [...this.sessions].filter(
      (live) =>
        live.chat === chat && (live.turn || live.generation || live.reserved),
    );
    for (const live of sessions) live.approvalEnd = "stopped";
    await Promise.all(
      sessions.map((live) =>
        this.closeApprovals(live, "stopped", live.approvals.keys()),
      ),
    );
  }
  private async cancelRecovery(owner: string) {
    const driver = this.options.recovery;
    const state = await driver?.latest(owner);
    if (driver && state) await driver.cancel(state.value.turn);
  }
  async closeConversation(owner: string, forgetHead = false, stopped = false) {
    this.conversationCloses.set(
      owner,
      (this.conversationCloses.get(owner) ?? 0) + 1,
    );
    const head = this.options.heads.get(owner);
    const forgetting =
      forgetHead && head
        ? this.options.heads.restore(owner, head, undefined)
        : Promise.resolve();
    const closing = Promise.all(
      [...this.sessions]
        .filter((live) => live.owner === owner)
        .map((live) => {
          if (stopped) live.approvalEnd = "stopped";
          return this.closeLive(live);
        }),
    );
    for (const gen of this.requests.values())
      if (gen.owner === owner) this.finish(undefined, gen, "aborted");
    await Promise.all([closing, forgetting, this.cancelRecovery(owner)]);
  }
  async closeAccount(account: AccountName) {
    this.accountCloses.set(account, (this.accountCloses.get(account) ?? 0) + 1);
    const closing = Promise.all(
      [...this.sessions]
        .filter((live) => live.route.name === account)
        .map((live) => this.closeLive(live)),
    );
    for (const gen of this.requests.values())
      if (gen.account === account) this.finish(undefined, gen, "aborted");
    await closing;
  }
  private settleWork(live: Live, output: string) {
    for (const resolve of live.pendingWork.values())
      resolve({ output, errored: true });
    live.pendingWork.clear();
  }
  private closeLive(
    live: Live,
    settle = true,
    exit: Exit.Exit<unknown, unknown> = Exit.void,
  ): Promise<void> {
    if (settle) {
      if (live.reserved) this.finish(live, live.reserved, "aborted");
      if (live.generation) this.finish(live, live.generation, "aborted");
    }
    if (live.closing) {
      if (settle) live.cancellation.abort();
      return live.closing;
    }
    const closed = Promise.withResolvers<void>();
    live.closing = closed.promise;
    live.holding = false;
    live.backlog.length = 0;
    live.followUp = undefined;
    clearTimeout(live.timer);
    const command = live.command;
    const closingScope = Effect.runPromise(
      Scope.close(live.scope, exit).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            this.log("chat-runtime.close.failed", {
              cause: cause.reasons[0]?._tag ?? "Unknown",
            });
          }),
        ),
      ),
    );
    if (settle) live.cancellation.abort();
    void Promise.allSettled([
      closingScope,
      live.acquisition,
      command,
      live.reader,
    ]).then(async () => {
      if (command && live.generation)
        this.finish(live, live.generation, "aborted");
      for (const [id, call] of live.calls) {
        call.waiter?.(stoppedCall);
        this.workResults.delete(id);
      }
      live.calls.clear();
      try {
        await this.resolveDelivery(live);
      } catch {
        this.log("chat-runtime.head.resolve.failed", { owner: live.owner });
      }
      if (live.recoveryEnd && live.recovery && this.options.recovery) {
        const fallback = live.recovery;
        const state = await this.options.recovery
          .settle({
            turn: fallback.value.turn,
            expected: fallback.event,
            state: "terminal",
            reason: "unsafe-continuation",
          })
          .catch(() => {
            this.log("chat-runtime.retry.settlement.failed", {
              turn: fallback.value.turn,
            });
            return fallback;
          });
        live.recoveryEnd({ state });
        live.recoveryEnd = undefined;
      }
      this.sessions.delete(live);
      closed.resolve();
    });
    return live.closing;
  }
  async close() {
    this.closed = true;
    const closing = Promise.all(
      [...this.sessions].map((live) => this.closeLive(live)),
    );
    for (const gen of this.requests.values())
      this.finish(undefined, gen, "aborted");
    await closing;
    await this.options.heads.close();
  }
}

/**
 * What a session on a runtime that resumes only between turns is sent after anything but a clean
 * continuation: exactly today's size-limited hand-over of what it does not hold, everything after
 * `fork` (-1 for a new session), with nothing exempt from the budget. The live instruction is, as
 * always, the user messages after the last assistant message. When the handed-over part ends in an
 * interrupted turn (an assistant message after the last finished reply), the model is told that
 * its steps may already have run; it may no longer hold the request it was working on, and the
 * person says again what they want.
 */
function handOver(messages: Context["messages"], fork: number): ContentBlock[] {
  const unheld = messages.slice(fork + 1);
  const lastReply = unheld.findLastIndex((message, index) => {
    if (message.role !== "assistant") return false;
    if (message.stopReason === "stop" || message.stopReason === "length")
      return true;
    if (message.stopReason !== "toolUse") return false;
    const calls = message.content.filter((part) => part.type === "toolCall");
    const result = unheld[index + 1];
    return (
      calls.length === 1 &&
      calls[0]?.name === PLAN_TOOL &&
      result?.role === "toolResult" &&
      result.toolCallId === calls[0].id &&
      !result.isError
    );
  });
  const interrupted = unheld.some(
    (message, index) => index > lastReply && message.role === "assistant",
  );
  return handoff(unheld, HANDOFF_TOKENS, {
    skipEmpty: true,
    ...(interrupted ? { note: MAY_HAVE_RUN } : {}),
  });
}
/** Inputs as a turn's message: user content, and each tool result as already run. */
function given(messages: Context["messages"]) {
  return messages.flatMap((message) =>
    message.role === "toolResult"
      ? alreadyRan([message])
      : userContent([message]),
  );
}
// The registry forwards nativeSessionId as a getter (ruling 11a); read it live, never copy it.
function nativeId(session: RuntimeSession): string {
  return session.nativeSessionId;
}
// The tool-result carrier checkpoint (ruling 11b) takes precedence over the last message's.
function turnResumePoint(
  event: Extract<RuntimeEvent, { type: "turn.finished" }>,
): string | undefined {
  return event.resumePoint;
}

function sessionFailure(error: unknown): boolean {
  const failure = RuntimeFailure.safeParse(error);
  return failure.success && failure.data._tag === "TurnFailed";
}
