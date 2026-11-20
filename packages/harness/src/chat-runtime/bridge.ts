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
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import { Effect, Exit, Scope, Stream } from "effect";
import {
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
import { handoff } from "./handoff.ts";
import { markTerminal, resumeFailed, terminalText } from "./failure.ts";
import {
  alreadyRan,
  digest,
  full,
  headDigest,
  mirrorCalls,
  newest,
  pointer,
  policy,
  policyKey,
  responseId,
  resultText,
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
  owner: string;
  account: AccountName;
  cancellation: AbortController;
  key: string;
  streams: AssistantMessageEventStream[];
  message: AssistantMessage;
  messages: Context["messages"];
  cleanup: (() => void)[];
  head?: {
    owner: string;
    previous: ReturnType<NativeHeads["get"]>;
    value: Parameters<NativeHeads["set"]>[1];
  };
};
type HeldCall = {
  result?: ToolOutcome | undefined;
  waiter?: ((value: ToolOutcome) => void) | undefined;
  delivered: boolean;
};
type Live = {
  owner: string;
  scope: Scope.Closeable;
  state:
    | { kind: "acquiring"; start: SessionStart }
    | { kind: "open"; session: RuntimeSession };
  cancellation: AbortController;
  route: AccountRoute;
  policy: SessionPolicy;
  calls: Map<string, HeldCall>;
  generation?: Generation | undefined;
  reserved?: Generation | undefined;
  replay?: { key: string; message: AssistantMessage };
  turn?: string | undefined;
  lastResumePoint?: string | undefined;
  checkpoint?: Pick<
    Parameters<NativeHeads["set"]>[1],
    "session" | "resumePoint" | "digest" | "checkpointThrough"
  >;
  last: number;
  timer?: ReturnType<typeof setTimeout>;
  closing?: Promise<void>;
  reader?: Promise<void>;
  command?: Promise<void>;
  acquisition?: Promise<void>;
};
export interface BridgeOptions {
  registry: RuntimeRegistryShape;
  heads: NativeHeads;
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
    { conversation: string; generation: string; redispatched: boolean }
  >();
  private readonly limitListeners = new Set<
    (
      account: AccountName,
      model: string,
      limits: { contextWindow: number; maxTokens: number },
    ) => void
  >();
  subscribeModelLimits(
    listener: (
      account: AccountName,
      model: string,
      limits: { contextWindow: number; maxTokens: number },
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
  constructor(private readonly options: BridgeOptions) {
    this.log = options.log ?? (() => {});
    this.now = options.now ?? Date.now;
  }
  identify(
    messages:
      Context["messages"] | readonly import("@earendil-works/pi-ai").Message[],
    conversation: import("@earendil-works/pi-durable").ConversationId,
    generation: import("@earendil-works/pi-durable").TaskId | string,
    redispatched = false,
  ): void {
    for (const message of messages)
      this.identities.set(message, {
        conversation: String(conversation),
        generation: String(generation),
        redispatched,
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
    const messages = normalizeContext(context).messages;
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
      key,
      owner: identity?.conversation ?? crypto.randomUUID(),
      account: route.name,
      cancellation: new AbortController(),
      streams: [],
      messages,
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
    if (identity?.redispatched) {
      this.finish(undefined, generation, "aborted");
      return stream;
    }
    void this.generate(route, generation, selection).catch((error: unknown) => {
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
      (prior.provider === route.name ||
        (await this.compatible(
          prior.provider,
          route.continuation,
          gen.cancellation.signal,
        )));
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
      const providers = new Set([route.name, prior?.provider]);
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
    const target = savedBase && baseIndex >= 0 ? savedBase : completedPoint;
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
      gen.messages,
      () => Effect.succeed({ text: "Call stopped.", error: "Call stopped." }),
      selection,
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
      // A runtime that resumes only between turns lost a failed turn's output. Only this
      // conversation's own head on this continuation says where that turn began: the messages its
      // first input went through. The turn's request goes again as the instruction, and what it
      // already did follows as text, every result in full. Earlier messages are history: in a new
      // session they go through the budgeted hand-over, never as an instruction. A head that cannot
      // say where the turn began gets the budgeted hand-over of the whole conversation.
      const lost =
        !route.capabilities.resumeInTurn && firstInput
          ? lostTurn(
              gen.messages,
              firstInput.through,
              target ? checkpointIndex + 1 : 0,
            )
          : undefined;
      const message = lost
        ? lost
        : !route.capabilities.resumeInTurn && firstInput
          ? handoff(gen.messages)
          : point
            ? given(inputMessages)
            : prior
              ? handoff(gen.messages)
              : given(gen.messages);
      await this.start(live, message);
      return;
    }
    if (!this.bind(live, gen) || live.state.kind !== "open") return;
    if (heldRound) {
      if (!(await this.markPending(live))) return;
      if (users.length) {
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
      provider,
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
    const configured = policy(
      gen.messages,
      (_name, call) => this.wait(() => live, call),
      selection,
    );
    const live: Live = {
      owner: gen.owner,
      scope,
      state: { kind: "acquiring", start },
      cancellation: new AbortController(),
      route,
      policy: configured,
      calls: new Map(),
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
    // Register the consumer before startTurn can emit its first event.
    live.reader = Effect.runPromise(
      Stream.runForEach(live.state.session.events, (event) =>
        Effect.promise(() => this.event(live, event)),
      ),
      { signal: live.cancellation.signal },
    ).catch(async () => {
      await live.command;
      if (!live.closing && live.generation)
        this.finish(
          live,
          live.generation,
          "error",
          this.options.heads.isRefused(live.owner)
            ? resumeFailed
            : "This turn did not produce an answer. Try another message.",
        );
    });
    void live.reader.then(async () => {
      // Account checks can end events before returning their typed command failure.
      await live.command;
      if (!live.closing) await this.closeLive(live);
    });
    return live;
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
    gen.message.responseId = responseId(nativeId(live.state.session));
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
    if (!(await this.markPending(live, "message"))) return;
    live.turn = crypto.randomUUID();
    live.lastResumePoint = undefined;
    await this.command(
      live,
      live.state.session.startTurn({ turnId: live.turn, message }),
    );
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
  ): Effect.Effect<ToolOutcome> {
    return Effect.callback((resume) => {
      const live = read();
      const stopped = { text: "Call stopped.", error: "Call stopped." };
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
        resume(Effect.succeed(stopped));
        return;
      }
      const entry = live.calls.get(call.callId) ?? { delivered: false };
      live.calls.set(call.callId, entry);
      if (entry.delivered || entry.waiter) {
        this.log("chat-runtime.protocol.fault", {
          reason: "duplicate-handler",
        });
        void this.closeLive(live);
        resume(Effect.succeed(stopped));
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
  private async event(live: Live, event: RuntimeEvent) {
    // Scope closure may publish an interrupted turn before checkTurn returns its typed failure.
    if (event.type === "turn.finished") await live.command;
    if (live.closing || live.state.kind !== "open") return;
    const session = live.state.session;
    const gen = live.generation;
    if (
      (event.type === "text" ||
        event.type === "message.finished" ||
        event.type === "tool.started") &&
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
      for (const call of calls)
        if (call.type === "toolCall") {
          live.calls.set(
            call.id,
            live.calls.get(call.id) ?? { delivered: false },
          );
          gen.message.content.push(call);
        }
      gen.message.usage = usage(event.usage);
      if (event.model) gen.message.responseModel = event.model;
      if (event.stopReason === "tool-use" && !calls.length) return;
      gen.message.responseId = responseId(
        nativeId(session),
        event.stopReason === "end-turn" || event.stopReason === "tool-use"
          ? resumePoint
          : "",
      );
      if (event.stopReason === "tool-use") {
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
        this.finish(
          live,
          gen,
          "error",
          "This turn did not produce an answer. Try another message.",
        );
        await this.closeLive(live);
      }
    }
    if (event.type === "usage" && event.scope === "turn" && event.model) {
      if (
        event.contextWindow !== undefined &&
        event.maxOutputTokens !== undefined
      )
        for (const listener of this.limitListeners)
          listener(live.route.name, event.model, {
            contextWindow: event.contextWindow,
            maxTokens: event.maxOutputTokens,
          });
    }
    if (event.type === "turn.finished") {
      if ([...live.calls.values()].some((call) => !call.delivered)) {
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
          if (!point) await this.resolveDelivery(live);
          this.finish(live, gen, "stop");
          if (!point) await this.closeLive(live);
        } else {
          this.finish(
            live,
            gen,
            event.outcome.status === "interrupted" ? "aborted" : "error",
            event.outcome.status === "failed"
              ? terminalText(event.outcome.failure)
              : undefined,
          );
          await this.closeLive(live);
        }
      }
      if (event.outcome.status !== "completed") await this.closeLive(live);
      this.idle(live);
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
      if (live.generation === gen) live.generation = undefined;
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
  async closeConversation(owner: string, forgetHead = false) {
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
        .map((live) => this.closeLive(live)),
    );
    for (const gen of this.requests.values())
      if (gen.owner === owner) this.finish(undefined, gen, "aborted");
    await Promise.all([closing, forgetting]);
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
    void Promise.allSettled([closingScope, live.acquisition, command]).then(
      async () => {
        if (command && live.generation)
          this.finish(live, live.generation, "aborted");
        for (const call of live.calls.values())
          call.waiter?.({ text: "Call stopped.", error: "Call stopped." });
        live.calls.clear();
        try {
          await this.resolveDelivery(live);
        } catch {
          this.log("chat-runtime.head.resolve.failed", { owner: live.owner });
        }
        this.sessions.delete(live);
        closed.resolve();
      },
    );
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
 * A failed turn on a runtime that resumes only between turns, as the next turn's message: history
 * from `base` before the turn's request through the budgeted hand-over, the request itself, then
 * what the turn already did, in full. Undefined when no message is the one the first input went
 * `through`.
 */
function lostTurn(
  all: Context["messages"],
  through: string,
  base: number,
): ContentBlock[] | undefined {
  // Failed partials are in no request and in no digest, so they are neither history nor lost work.
  const messages = all.filter(
    (message, index) =>
      index >= base &&
      !(
        message.role === "assistant" &&
        (message.stopReason === "error" || message.stopReason === "aborted")
      ),
  );
  const before = all.slice(0, base);
  const end = messages.findLastIndex(
    (_message, index) =>
      headDigest([...before, ...messages.slice(0, index + 1)]) === through,
  );
  if (end < 0) return;
  const start =
    messages.findLastIndex(
      (message, index) => index <= end && message.role === "assistant",
    ) + 1;
  const history = messages.slice(0, start);
  const after = messages.slice(end + 1);
  return [
    ...(history.length > 0 ? handoff(history) : []),
    ...given(messages.slice(start, end + 1)),
    ...(after.some((message) => message.role === "assistant")
      ? handoff(after, Number.POSITIVE_INFINITY)
      : given(after)),
  ];
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
