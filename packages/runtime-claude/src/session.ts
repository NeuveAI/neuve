// The one-permit section owns turns, sends, approvals, children, generation,
// cleanup fibers, stopped, identity/session id, held results and the usage baseline.
import type {
  CanUseTool,
  Options,
  PermissionResult,
  SDKMessage,
  SDKResultMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  RuntimeUnavailable,
  TurnFailed,
  type CallUsage,
  type ContentBlock,
  type InterruptReason,
  type RuntimeEvent,
  type RuntimeSession,
  type RuntimeModel,
  type SessionPolicy,
  type TurnOutcome,
  type ToolDefinition,
  type ToolOutcome,
} from "@neuve/runtime";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Queue,
  Semaphore,
  Scope,
  Stream,
} from "effect";
import { z } from "zod";
import { childEnvironment, type ClaudeAccount } from "./environment.ts";
import {
  addUsage,
  assistantRateInfo,
  assistantText,
  advanceLedger,
  limitWindow,
  modelUsage,
  modelLimits,
  outcomeFromResult,
  runtimeModels,
  selectionEffort,
  usageBlocked,
  zeroUsage,
  type TurnObservations,
} from "./mapping.ts";
import { ClaudeSdk, type QuerySession } from "./services.ts";
import { messageCollector } from "./messages.ts";
import {
  consumesFrame,
  validFrame,
  protocolErrorLine,
  type ProtocolErrorSite,
} from "./protocol.ts";
import {
  ClaudeToolDefinitionError,
  declaresToolUseId,
  toolServer,
} from "./tools.ts";

function claudeOutputSchema(
  schema: NonNullable<SessionPolicy["outputSchema"]>,
) {
  const { $schema: _, ...output } = schema;
  return output;
}

export type SessionIdentity =
  | { readonly sessionId: string }
  | {
      readonly resume: string;
      readonly resumeSessionAt?: string;
      readonly forkSession?: boolean;
      readonly sessionId?: string;
    };
export interface InternalSessionOptions {
  readonly handleTool?: (
    definition: ToolDefinition,
    input: unknown,
    context: { readonly callId: string; readonly signal: AbortSignal },
  ) => Effect.Effect<ToolOutcome>;
  readonly cwd: string;
  readonly executable: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly interruptTimeoutMs?: number;
  /** Optional internal snapshot; public resumes establish their baseline from the first result. */
  readonly usageBaseline?: ReadonlyMap<string, Readonly<CallUsage>>;
  readonly identity?: SessionIdentity;
  readonly heldResults?: ReadonlyArray<{
    readonly toolName: string;
    readonly text: string;
  }>;
}
interface CallSettlement {
  readonly outcome: ToolOutcome | undefined;
  readonly started: number | undefined;
  readonly finished: number;
}
interface Turn {
  readonly id: string;
  readonly message: string | ReadonlyArray<ContentBlock>;
  readonly messages: ReturnType<typeof messageCollector>;
  readonly requestUsage: Map<string, CallUsage>;
  streamUsageAfterResult: boolean;
  completedMessages: number;
  endTurn: boolean;
  lastEntry?: string;
  lastEntryIsCarrier: boolean;
  readonly calls: Map<
    string,
    {
      toolName: string;
      announced: boolean;
      handler?: { started: number; abort: AbortController };
    }
  >;
  readonly final: boolean;
  readonly scope: Scope.Closeable;
  readonly abort: AbortController;
  readonly usage: Map<string, CallUsage>;
  progressed: boolean;
  readonly rejected: Map<string, ReturnType<typeof limitWindow>>;
  observations: TurnObservations;
  readonly sends: Set<string>;
  readonly pendingSends: Set<string>;
  readonly heldSteers: SDKUserMessage[];
  readonly remainingCalls: Map<string, Set<string>>;
  readonly settledCalls: Map<string, CallSettlement>;
  toolRan: boolean;
  refreshRetried: boolean;
  failedOutcome?: Extract<TurnOutcome, { status: "failed" }>;
  ending?: TurnOutcome;
  starting?: Fiber.Fiber<void, RuntimeUnavailable | TurnFailed>;
  cancellation?: Fiber.Fiber<void>;
  cleanup?: Fiber.Fiber<void>;
}
interface Child {
  readonly generation: number;
  readonly final: boolean;
  readonly scope: Scope.Closeable;
  query?: QuerySession;
  ready: boolean;
  opening?: Fiber.Fiber<void, RuntimeUnavailable>;
  disposal?: Fiber.Fiber<void>;
}
const abortWait = (signal: AbortSignal) =>
  Effect.callback<void>((resume) => {
    const done = () => resume(Effect.void);
    if (signal.aborted) done();
    else signal.addEventListener("abort", done, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", done));
  });
const userMessage = (
  message: string | ReadonlyArray<ContentBlock>,
  steering = false,
): SDKUserMessage => ({
  type: "user",
  message: {
    role: "user",
    content:
      typeof message === "string"
        ? message
        : message.map((block) =>
            block.type === "text"
              ? { type: "text", text: block.text }
              : {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: block.mimeType,
                    data: block.data,
                  },
                },
          ),
  },
  parent_tool_use_id: null,
  uuid: crypto.randomUUID(),
  ...(steering ? { priority: "now" } : {}),
});
const deny = (): PermissionResult => ({
  behavior: "deny",
  message: "The turn or tool is unavailable.",
  interrupt: true,
});

/**
 * The message backstop of a final turn, in place of the policy's turnLimit. Claude Code often
 * answers a final turn in text first and only then calls StructuredOutput, and it may retry an
 * output that fails the schema: three messages allow one answer, the call and one retry. A fourth
 * ends the turn failed with turn-limit-reached, as any turn past its backstop does.
 */
export const FINAL_TURN_MESSAGES = 3;

// Result binding, sdk.d.ts:5991-5999:
// Rule 1: plural stamps are authoritative, including the earlier prefix when capped at 64.
// Rule 2: singular-only stamps consume their prefix; zero/absent queue depth also drains folded steers.
// Rule 3: unstamped results use ordered queue drainage, preserving legacy streaming-abort handling.
// Queue depth is a producer snapshot (sdk.d.ts:6117), so rule 1 never consumes later sends.
function consumedSendCount(
  frame: SDKResultMessage,
  pending: readonly string[],
) {
  if (frame.user_message_uuids !== undefined) {
    const stamps = new Set(frame.user_message_uuids);
    return pending.findLastIndex((id) => stamps.has(id)) + 1;
  }
  const queued = frame.queued_turn_count;
  if (frame.user_message_uuid !== undefined) {
    return queued === undefined || queued === 0
      ? pending.length
      : pending.lastIndexOf(frame.user_message_uuid) + 1;
  }
  const remaining =
    queued ??
    (frame.terminal_reason === "aborted_streaming" ||
    frame.terminal_reason === "aborted_tools"
      ? Math.max(0, pending.length - 1)
      : 0);
  return Math.max(0, pending.length - remaining);
}

export const openClaudeSession = (
  account: ClaudeAccount,
  policy: SessionPolicy,
  config: InternalSessionOptions,
) =>
  Effect.gen(function* () {
    const sdk = yield* ClaudeSdk;
    const sessionScope = yield* Scope.fork(yield* Effect.scope);
    for (const tool of policy.tools) {
      if (tool.description.length > 4096)
        return yield* new ClaudeToolDefinitionError(account.name, tool.name);
      if (declaresToolUseId(tool.inputSchema))
        return yield* new ClaudeToolDefinitionError(
          account.name,
          tool.name,
          "reserved-input-key",
        );
    }
    const context = yield* Effect.context<never>();
    const runPromise = Effect.runPromiseWith(context);
    const queue = yield* Queue.unbounded<RuntimeEvent, Cause.Done>();
    const semaphore = yield* Semaphore.make(1);
    const state = semaphore.withPermits(1);
    const pendingPermissions = new Set<Promise<PermissionResult | null>>();
    const approvals = new Map<
      string,
      {
        turn: Turn;
        answer: Deferred.Deferred<PermissionResult>;
        settled: Deferred.Deferred<void>;
      }
    >();
    let active: Turn | undefined;
    let stopped = false;
    let pendingProtocolFault = false;
    let lastEndedByTool = false;
    let generation = 0;
    let child: Child | undefined;
    let identity: SessionIdentity = config.identity ?? {
      sessionId: crypto.randomUUID(),
    };
    // sdk.d.ts:2150-2154 permits a chosen id on a fork, so open already names the new session.
    if (
      "resume" in identity &&
      identity.forkSession &&
      identity.sessionId === undefined
    )
      identity = { ...identity, sessionId: crypto.randomUUID() };
    let sessionId =
      "resume" in identity
        ? (identity.sessionId ?? identity.resume)
        : identity.sessionId;
    let resumePoint =
      "resume" in identity ? identity.resumeSessionAt : undefined;
    let mayHavePersistedTurn = false;
    let heldResults = config.heldResults ?? [];
    let ledger = new Map<string, CallUsage>(
      Array.from(config.usageBaseline ?? [], ([model, usage]) => [
        model,
        { ...usage },
      ]),
    );
    let resumeUsage =
      "resume" in identity && config.usageBaseline === undefined;
    let selectedModel = policy.model;
    let models: ReadonlyArray<RuntimeModel> | undefined;
    const limits = new Map<string, ReturnType<typeof modelLimits>>();
    let modelSwitch: Fiber.Fiber<void, TurnFailed> | undefined;
    let discardedSteers = 0;
    const ignoredTypes = new Set<string>();
    const timeoutMs = config.interruptTimeoutMs ?? 10_000;
    const now = () => new Date().toISOString();
    const emit = (event: RuntimeEvent) =>
      Queue.offer(queue, event).pipe(Effect.asVoid);
    const failure = (
      reason: ConstructorParameters<typeof TurnFailed>[0]["reason"],
    ) => new TurnFailed({ account: account.name, reason });
    const failOutcome = (
      reason: ConstructorParameters<typeof TurnFailed>[0]["reason"],
      disposition: "reusable" | "broken",
    ): TurnOutcome => ({
      status: "failed",
      disposition,
      failure: { _tag: "TurnFailed", account: account.name, reason },
    });
    const interrupted = (reason?: InterruptReason): TurnOutcome => ({
      status: "interrupted",
      ...(reason === undefined ? {} : { reason }),
    });
    // Helpers ending in Locked run only with the permit. They schedule waits, never join them.
    const disposeLocked = (previous: Child) =>
      Effect.gen(function* () {
        if (previous.disposal !== undefined) return previous.disposal;
        previous.ready = false;
        if (child === previous) generation++;
        if (mayHavePersistedTurn)
          identity = {
            resume: sessionId,
            ...(resumePoint === undefined
              ? {}
              : { resumeSessionAt: resumePoint }),
          };
        previous.disposal = yield* Effect.forkIn(
          Effect.gen(function* () {
            const snapshot = yield* state(
              Effect.sync(() => ({
                query: previous.query,
                opening: previous.opening,
                permissions: [...pendingPermissions],
              })),
            );
            yield* Effect.all(
              [
                Effect.promise(() =>
                  Promise.allSettled(snapshot.permissions),
                ).pipe(
                  Effect.andThen(
                    snapshot.query === undefined
                      ? Effect.void
                      : snapshot.query.close.pipe(
                          Effect.catchCause(() => Effect.void),
                        ),
                  ),
                ),
                snapshot.opening === undefined
                  ? Effect.void
                  : Fiber.interrupt(snapshot.opening),
              ],
              { concurrency: "unbounded" },
            );
            yield* Scope.close(previous.scope, Exit.void);
            yield* state(
              Effect.sync(() => {
                if (child === previous) child = undefined;
                server.clearStamps();
              }),
            );
          }),
          sessionScope,
          { startImmediately: false },
        );
        return previous.disposal;
      });
    const cancelLocked = (turn: Turn) =>
      Effect.gen(function* () {
        if (turn.cancellation !== undefined) return turn.cancellation;
        turn.abort.abort();
        for (const [callId, call] of turn.calls)
          if (call.handler === undefined) yield* settleCallLocked(turn, callId);
        const settled: Deferred.Deferred<void>[] = [];
        for (const request of approvals.values()) {
          if (request.turn !== turn) continue;
          settled.push(request.settled);
          yield* Deferred.succeed(request.answer, deny());
        }
        turn.cancellation = yield* Effect.forkIn(
          Effect.all(
            [
              Scope.close(turn.scope, Exit.void),
              Effect.forEach(settled, Deferred.await, { discard: true }),
            ],
            { concurrency: "unbounded", discard: true },
          ),
          sessionScope,
          { startImmediately: false },
        );
        return turn.cancellation;
      });
    const publishLocked = (turn: Turn, outcome: TurnOutcome) =>
      Effect.gen(function* () {
        if (active !== turn) return;
        yield* emitMessagesLocked(turn, turn.messages.finish());
        for (const callId of turn.calls.keys())
          yield* settleCallLocked(turn, callId);
        yield* emitStreamUsageLocked(turn);
        if (turn.lastEntryIsCarrier) resumePoint = turn.lastEntry;
        active = undefined;
        lastEndedByTool = turn.endTurn;
        server.clearStamps();
        yield* emit({
          type: "turn.finished",
          turnId: turn.id,
          at: now(),
          outcome,
          ...(turn.lastEntryIsCarrier && turn.lastEntry !== undefined
            ? { resumePoint: turn.lastEntry }
            : {}),
        });
        if (stopped) yield* Queue.end(queue);
      });
    const finishLocked = (turn: Turn, outcome: TurnOutcome) =>
      Effect.gen(function* () {
        if (active !== turn || turn.ending !== undefined) return;
        turn.ending = outcome;
        yield* emitMessagesLocked(turn, turn.messages.finish());
        if (
          (outcome.status === "completed" || turn.lastEntryIsCarrier) &&
          turn.lastEntry !== undefined
        )
          resumePoint = turn.lastEntry;
        if (turn.requestUsage.size > 0) {
          resumeUsage = true;
          turn.streamUsageAfterResult = true;
          yield* emitStreamUsageLocked(turn);
        }
        const closing =
          outcome.status === "interrupted" ||
          (outcome.status === "failed" && outcome.disposition === "broken") ||
          child?.disposal !== undefined;
        if (outcome.status === "failed" && outcome.disposition === "broken")
          stopped = true;
        const disposal =
          closing && child !== undefined
            ? yield* disposeLocked(child)
            : undefined;
        const cancellation = yield* cancelLocked(turn);
        turn.cleanup = yield* Effect.forkIn(
          Effect.gen(function* () {
            const done = yield* Effect.all(
              [
                Fiber.await(cancellation),
                disposal === undefined
                  ? Effect.succeed(Exit.void)
                  : Fiber.await(disposal),
              ],
              { concurrency: "unbounded" },
            ).pipe(Effect.timeoutOption(timeoutMs));
            yield* state(
              Effect.gen(function* () {
                if (active !== turn) return;
                const cleaned =
                  done._tag === "Some" && done.value.every(Exit.isSuccess);
                if (!cleaned) {
                  stopped = true;
                  // A stalled scope remains session-owned. Cancel only the SDK wait.
                  if (disposal !== undefined)
                    yield* Effect.forkIn(
                      Fiber.interrupt(disposal),
                      sessionScope,
                    );
                }
                const ending = turn.ending ?? outcome;
                yield* publishLocked(
                  turn,
                  !cleaned && ending.status !== "failed" && !turn.endTurn
                    ? ending.status === "interrupted"
                      ? ending
                      : interrupted("shutdown")
                    : ending,
                );
              }),
            );
          }),
          sessionScope,
          { startImmediately: false },
        );
      });
    const dieLocked = (reason: "provider-failed" | "protocol-error") =>
      Effect.gen(function* () {
        stopped = true;
        if (active !== undefined && active.ending === undefined)
          yield* finishLocked(active, failOutcome(reason, "broken"));
        else {
          if (child !== undefined) {
            const disposal = yield* disposeLocked(child);
            yield* Effect.forkIn(
              Fiber.await(disposal).pipe(
                Effect.timeoutOption(timeoutMs),
                Effect.flatMap((done) =>
                  done._tag === "None"
                    ? state(
                        Effect.forkIn(Fiber.interrupt(disposal), sessionScope),
                      )
                    : Effect.void,
                ),
              ),
              sessionScope,
              { startImmediately: false },
            );
          }
          if (active === undefined) yield* Queue.end(queue);
        }
      });
    const withProtocolWarning = <A, E, R>(
      transition: Effect.Effect<A, E, R>,
      site: ProtocolErrorSite,
      frame?: unknown,
    ) =>
      transition.pipe(
        Effect.onExit(() =>
          Effect.forkIn(
            Effect.sync(() => protocolErrorLine(site, frame)).pipe(
              Effect.flatMap(Effect.logWarning),
              Effect.catchCause(() => Effect.void),
            ),
            sessionScope,
            { startImmediately: false },
          ).pipe(Effect.asVoid),
        ),
      );
    const dieProtocolLocked = (site: ProtocolErrorSite, frame?: unknown) =>
      withProtocolWarning(dieLocked("protocol-error"), site, frame);
    const protocolFault = (site: ProtocolErrorSite) =>
      state(dieProtocolLocked(site));
    const receiveLocked = (
      turn: Turn,
      frame: SDKMessage,
      site: ProtocolErrorSite,
    ) =>
      Effect.try({
        try: () => turn.messages.receive(frame),
        catch: () => undefined,
      }).pipe(
        Effect.catch(() =>
          dieProtocolLocked(site, frame).pipe(Effect.as(undefined)),
        ),
      );
    const offerLocked = (current: Child, turn: Turn, message: SDKUserMessage) =>
      Effect.gen(function* () {
        const query = current.query;
        if (
          query === undefined ||
          !current.ready ||
          current.disposal !== undefined
        )
          return yield* failure("session-stopped");
        if (message.uuid !== undefined) {
          turn.sends.add(message.uuid);
          turn.pendingSends.add(message.uuid);
        }
        return yield* Effect.forkIn(
          Effect.uninterruptibleMask((restore) =>
            restore(
              query.offer(message).pipe(Effect.timeout("25 seconds")),
            ).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  mayHavePersistedTurn = true;
                }),
              ),
            ),
          ).pipe(
            Effect.mapError(() => failure("provider-failed")),
            Effect.onError(() =>
              state(
                Effect.gen(function* () {
                  if (
                    active === turn &&
                    turn.ending === undefined &&
                    child === current &&
                    generation === current.generation
                  )
                    yield* dieLocked("provider-failed");
                }),
              ),
            ),
          ),
          turn.scope,
          { startImmediately: false },
        );
      });
    const sendLocked = (
      current: Child,
      turn: Turn,
      text: string | ReadonlyArray<ContentBlock>,
      steering = false,
    ) => offerLocked(current, turn, userMessage(text, steering));
    const offerHeldLocked = (current: Child, turn: Turn) =>
      Effect.forEach(turn.heldSteers.splice(0), (message) =>
        offerLocked(current, turn, message),
      );
    const settleCallLocked = (
      turn: Turn,
      callId: string,
      settlement: CallSettlement = {
        outcome: undefined,
        started: turn.calls.get(callId)?.handler?.started,
        finished: Date.now(),
      },
    ): Effect.Effect<Array<Fiber.Fiber<void, TurnFailed>>> =>
      Effect.gen(function* () {
        const previous = turn.settledCalls.get(callId);
        if (previous !== undefined) {
          if (turn.ending === undefined) return [];
          settlement = previous;
        }
        turn.settledCalls.set(callId, settlement);
        const { outcome, started, finished } = settlement;
        const call = turn.calls.get(callId);
        if (call === undefined) return [];
        if (outcome === undefined) call.handler?.abort.abort();
        if (!call.announced) {
          if (turn.ending !== undefined) {
            call.handler?.abort.abort();
            turn.calls.delete(callId);
            turn.settledCalls.delete(callId);
            turn.remainingCalls.get(callId)?.delete(callId);
            turn.remainingCalls.delete(callId);
          }
          return [];
        }
        if (outcome?.endTurn === true) {
          turn.endTurn = true;
          discardedSteers += turn.heldSteers.length;
          turn.heldSteers.length = 0;
        }
        turn.calls.delete(callId);
        yield* emit({
          type: "tool.finished",
          turnId: turn.id,
          at: now(),
          callId,
          toolName: call.toolName,
          errored: outcome === undefined || outcome.error !== undefined,
          ...(started === undefined ? {} : { durationMs: finished - started }),
        });
        const remaining = turn.remainingCalls.get(callId);
        remaining?.delete(callId);
        turn.remainingCalls.delete(callId);
        if (active !== turn || turn.ending !== undefined || stopped) return [];
        return remaining === undefined ||
          turn.endTurn ||
          remaining.size > 0 ||
          child === undefined ||
          !child.ready ||
          child.disposal !== undefined
          ? []
          : yield* offerHeldLocked(child, turn).pipe(Effect.orDie);
      });
    const canUseTool: CanUseTool = (wireName, input, options) => {
      let permissionTurn: Turn | undefined;
      const response = runPromise(
        Effect.gen(function* () {
          const prepared = yield* state(
            Effect.gen(function* () {
              const turn = active;
              permissionTurn = turn;
              const definition = policy.tools.find(
                (tool) => `mcp__neuve__${tool.name}` === wireName,
              );
              if (
                wireName === "StructuredOutput" &&
                turn?.final &&
                turn.ending === undefined
              )
                return {
                  behavior: "allow",
                  updatedInput: input,
                } satisfies PermissionResult;
              if (definition === undefined) {
                yield* dieProtocolLocked("permission-unknown-tool");
                return deny();
              }
              if (
                turn === undefined ||
                turn.ending !== undefined ||
                stopped ||
                options.signal.aborted
              )
                return deny();
              if (policy.approvalPolicy === "allow")
                return {
                  behavior: "allow",
                  updatedInput: input,
                } satisfies PermissionResult;
              const parsed = z.json().safeParse(input);
              if (!parsed.success) {
                yield* dieProtocolLocked("permission-input-json");
                return deny();
              }
              const requestId = crypto.randomUUID();
              const answer = yield* Deferred.make<PermissionResult>();
              const settled = yield* Deferred.make<void>();
              approvals.set(requestId, { turn, answer, settled });
              yield* emit({
                type: "approval.requested",
                turnId: turn.id,
                at: now(),
                requestId,
                callId: options.toolUseID,
                toolName: definition.name,
                input: parsed.data,
              });
              return { requestId, turn, answer, settled };
            }),
          );
          if ("behavior" in prepared) return prepared;
          return yield* Effect.raceFirst(
            Deferred.await(prepared.answer),
            abortWait(
              AbortSignal.any([options.signal, prepared.turn.abort.signal]),
            ).pipe(Effect.as(deny())),
          ).pipe(
            Effect.map((response): PermissionResult =>
              response.behavior === "allow"
                ? { behavior: "allow", updatedInput: input }
                : response,
            ),
            Effect.ensuring(
              state(
                Effect.gen(function* () {
                  approvals.delete(prepared.requestId);
                  yield* Deferred.succeed(prepared.settled, undefined);
                }),
              ),
            ),
          );
        }).pipe(
          Effect.onExit((exit) =>
            permissionTurn === undefined ||
            (Exit.isSuccess(exit) && exit.value.behavior === "allow")
              ? Effect.void
              : state(settleCallLocked(permissionTurn, options.toolUseID)).pipe(
                  Effect.flatMap((offers) =>
                    Effect.forEach(offers, Fiber.join, { discard: true }).pipe(
                      Effect.orDie,
                    ),
                  ),
                ),
          ),
        ),
      );
      void runPromise(
        state(
          Effect.sync(() => {
            pendingPermissions.add(response);
          }),
        ),
      );
      const settled = () =>
        runPromise(
          state(
            Effect.sync(() => {
              pendingPermissions.delete(response);
            }),
          ),
        );
      void response.then(settled, settled);
      return response;
    };
    const server = yield* Effect.try({
      try: () =>
        toolServer(
          policy.tools,
          (definition, input, callId, signal) =>
            runPromise(
              Effect.gen(function* () {
                const turn = yield* state(
                  Effect.sync(() =>
                    active?.ending === undefined && !stopped
                      ? active
                      : undefined,
                  ),
                );
                if (turn === undefined)
                  return {
                    content: [{ type: "text", text: "The turn ended." }],
                    isError: true,
                  };
                const callAbort = new AbortController();
                const toolSignal = AbortSignal.any([
                  signal,
                  turn.abort.signal,
                  callAbort.signal,
                ]);
                let returnedOutcome: ToolOutcome | undefined;
                let handlerStarted: number | undefined;
                const work = Effect.gen(function* () {
                  const parsedInput = z.json().safeParse(input);
                  if (!parsedInput.success) {
                    yield* protocolFault("tool-input-json");
                    return {
                      content: [
                        {
                          type: "text" as const,
                          text: "Tool input is not JSON.",
                        },
                      ],
                      isError: true,
                    };
                  }
                  const admitted = yield* state(
                    Effect.gen(function* () {
                      if (
                        active !== turn ||
                        turn.ending !== undefined ||
                        stopped ||
                        toolSignal.aborted ||
                        turn.settledCalls.has(callId) ||
                        turn.calls.get(callId)?.handler !== undefined
                      )
                        return false;
                      const collected = yield* Effect.try({
                        try: () => turn.messages.completeForTool(callId),
                        catch: () => undefined,
                      }).pipe(
                        Effect.catch(() =>
                          dieProtocolLocked("tool-completion-receive").pipe(
                            Effect.as(undefined),
                          ),
                        ),
                      );
                      if (collected === undefined) return false;
                      yield* acceptMessagesLocked(turn, collected);
                      const call = turn.calls.get(callId) ?? {
                        toolName: definition.name,
                        announced: false,
                      };
                      handlerStarted = Date.now();
                      call.handler = {
                        started: handlerStarted,
                        abort: callAbort,
                      };
                      turn.calls.set(callId, call);
                      turn.toolRan = true;
                      return true;
                    }),
                  );
                  if (!admitted)
                    return {
                      content: [
                        { type: "text" as const, text: "The turn ended." },
                      ],
                      isError: true,
                    };
                  return yield* Effect.raceFirst(
                    config.handleTool === undefined
                      ? definition.handle(input, { callId, signal: toolSignal })
                      : config.handleTool(definition, input, {
                          callId,
                          signal: toolSignal,
                        }),
                    abortWait(toolSignal).pipe(
                      Effect.andThen(Effect.interrupt),
                    ),
                  ).pipe(
                    Effect.map((outcome) => {
                      returnedOutcome = outcome;
                      return {
                        content: [
                          { type: "text" as const, text: outcome.text },
                        ],
                        // Claude Code honours claude/endTurn only on a result that isn't an
                        // error; it answers an errored one with a new response. The text keeps
                        // the refusal, and tool.finished still reports it errored.
                        isError:
                          outcome.error !== undefined &&
                          outcome.endTurn !== true,
                        ...(outcome.endTurn === true
                          ? { _meta: { "claude/endTurn": true } }
                          : {}),
                      };
                    }),
                  );
                }).pipe(
                  Effect.ensuring(
                    state(
                      Effect.gen(function* () {
                        if (returnedOutcome === undefined) callAbort.abort();
                        const handler = turn.calls.get(callId)?.handler;
                        const offers =
                          handler !== undefined && handler.abort !== callAbort
                            ? []
                            : yield* settleCallLocked(turn, callId, {
                                outcome: returnedOutcome,
                                started: handlerStarted,
                                finished: Date.now(),
                              });
                        return offers;
                      }),
                    ).pipe(
                      Effect.flatMap((offers) =>
                        Effect.forEach(offers, Fiber.join, {
                          discard: true,
                        }).pipe(Effect.orDie),
                      ),
                    ),
                  ),
                );
                const fiber = yield* state(
                  Effect.suspend(() =>
                    active === turn && turn.ending === undefined
                      ? Effect.forkIn(work, turn.scope, {
                          startImmediately: false,
                        })
                      : Effect.succeed(undefined),
                  ),
                );
                if (fiber === undefined)
                  return {
                    content: [{ type: "text", text: "The turn ended." }],
                    isError: true,
                  };
                return yield* Fiber.join(fiber).pipe(
                  Effect.catchCause(() =>
                    Effect.succeed({
                      content: [
                        {
                          type: "text" as const,
                          text: "The tool stopped before returning a result.",
                        },
                      ],
                      isError: true,
                    }),
                  ),
                );
              }),
              { signal },
            ),
          () => runPromise(protocolFault("tool-server-protocol")),
        ),
      catch: () => undefined,
    }).pipe(
      Effect.catch(() =>
        withProtocolWarning(failure("protocol-error"), "tool-server-create"),
      ),
    );

    const emitMessagesLocked = (
      turn: Turn,
      messages: ReturnType<Turn["messages"]["finish"]>,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        for (const message of messages) {
          const event = turn.messages.event(message, turn.id, now());
          resumePoint = event.resumePoint;
          const remaining = new Set(
            event.toolCalls
              .map((call) => call.callId)
              .filter((callId) => !turn.settledCalls.has(callId)),
          );
          for (const callId of remaining)
            turn.remainingCalls.set(callId, remaining);
          if (event.usage !== undefined && event.model !== undefined)
            turn.requestUsage.set(
              event.model,
              addUsage(
                turn.requestUsage.get(event.model) ?? zeroUsage(),
                event.usage,
              ),
            );
          yield* emit(event);
          if (
            event.toolCalls.length > 0 &&
            remaining.size === 0 &&
            active === turn &&
            turn.ending === undefined &&
            !stopped &&
            !turn.endTurn &&
            child?.ready &&
            child.disposal === undefined
          )
            yield* offerHeldLocked(child, turn).pipe(Effect.orDie);
        }
      });
    const emitStreamUsageLocked = (turn: Turn) =>
      Effect.gen(function* () {
        for (const [model, delta] of turn.requestUsage) {
          const total = addUsage(turn.usage.get(model) ?? zeroUsage(), delta);
          turn.usage.set(model, total);
          yield* emit({
            type: "usage",
            turnId: turn.id,
            at: now(),
            scope: "turn",
            model,
            ...limits.get(model),
            usage: total,
            costUsd: null,
          });
        }
        turn.requestUsage.clear();
      });
    const closeCompletedLocked = (turn: Turn) =>
      Effect.gen(function* () {
        pendingProtocolFault = true;
        yield* emitMessagesLocked(turn, turn.messages.finish());
        if (turn.lastEntry !== undefined) resumePoint = turn.lastEntry;
        if (child !== undefined) yield* disposeLocked(child);
        yield* emitStreamUsageLocked(turn);
        yield* finishLocked(turn, { status: "completed" });
      });
    const acceptMessagesLocked = (
      turn: Turn,
      collected: ReturnType<Turn["messages"]["receive"]>,
    ) =>
      Effect.gen(function* () {
        const ready = [...collected.ready];
        let completed = collected.completed;
        // A result ledger already includes the request. Stream-derived totals need only its correction.
        if (turn.ending === undefined || turn.streamUsageAfterResult)
          for (const { model, delta } of collected.usageUpdates)
            turn.requestUsage.set(
              model,
              addUsage(turn.requestUsage.get(model) ?? zeroUsage(), delta),
            );
        for (const call of collected.calls) {
          const tracked = turn.calls.get(call.callId);
          if (tracked === undefined)
            turn.calls.set(call.callId, {
              toolName: call.toolName,
              announced: true,
            });
          else tracked.announced = true;
          yield* emit({
            type: "tool.started",
            turnId: turn.id,
            at: now(),
            ...call,
          });
          const settlement = turn.settledCalls.get(call.callId);
          if (settlement !== undefined) {
            const completion = turn.messages.completeForTool(call.callId);
            ready.push(...completion.ready);
            completed += completion.completed;
            turn.settledCalls.delete(call.callId);
            yield* settleCallLocked(turn, call.callId, settlement);
          }
        }
        yield* emitMessagesLocked(turn, ready);
        turn.completedMessages += completed;
      });

    const openQueryLocked = (final: boolean) =>
      Effect.gen(function* () {
        const current: Child = {
          generation: ++generation,
          final,
          scope: yield* Scope.fork(sessionScope),
          ready: false,
        };
        child = current;
        const queryIdentity = identity;
        const effort = selectionEffort(selectedModel, models).effort;
        const options: Options = {
          pathToClaudeCodeExecutable: config.executable,
          env: childEnvironment(config.environment, account),
          cwd: config.cwd,
          tools: [],
          settingSources: [],
          // The live PreToolUse experiment used false; true suppresses the fallback hook.
          // settingSources remains empty: only this query's SDK hook is registered.
          settings: { disableAllHooks: false },
          hooks: {
            PreToolUse: [
              { matcher: "mcp__neuve__.*", hooks: [server.stampToolUseId] },
            ],
          },
          strictMcpConfig: true,
          skills: [],
          systemPrompt: policy.systemPrompt,
          mcpServers: { neuve: server },
          allowedTools:
            policy.approvalPolicy === "allow"
              ? policy.tools.map((tool) => `mcp__neuve__${tool.name}`)
              : [],
          permissionMode: "default",
          canUseTool,
          ...(selectedModel === undefined
            ? {}
            : {
                ...(selectedModel.id === "default"
                  ? {}
                  : { model: selectedModel.id }),
                ...(effort === undefined ? {} : { effort }),
              }),
          includePartialMessages: true,
          persistSession: true,
          ...queryIdentity,
          ...(final && policy.outputSchema !== undefined
            ? {
                outputFormat: {
                  type: "json_schema",
                  schema: claudeOutputSchema(policy.outputSchema),
                },
              }
            : {}),
          stderr: () => {},
        };

        current.opening = yield* Effect.forkIn(
          Effect.gen(function* () {
            const query = yield* sdk
              .open(options)
              .pipe(Effect.provideService(Scope.Scope, current.scope));
            const accepted = yield* state(
              Effect.sync(() => {
                current.query = query;
                return (
                  child === current &&
                  current.generation === generation &&
                  !stopped &&
                  current.disposal === undefined
                );
              }),
            );
            if (!accepted) return;
            const init = yield* query.initializationResult;
            const initializedModels = yield* Effect.try(() =>
              runtimeModels(init.models),
            ).pipe(Effect.catch(() => Effect.succeed(undefined)));
            const effortUpdate = yield* state(
              Effect.sync(() => {
                if (
                  child !== current ||
                  current.generation !== generation ||
                  stopped ||
                  current.disposal !== undefined
                )
                  return undefined;
                models = initializedModels;
                const selection = selectionEffort(selectedModel, models);
                return !selection.refused && selection.effort !== options.effort
                  ? { effortLevel: selection.effort ?? null }
                  : undefined;
              }),
            );
            // Reconcile options chosen before init with the new child's model list.
            // Refusal waits for a turn, before its prompt is sent.
            if (effortUpdate !== undefined)
              yield* query
                .applyFlagSettings(effortUpdate)
                .pipe(Effect.timeout("25 seconds"));
            yield* state(
              Effect.gen(function* () {
                if (
                  child !== current ||
                  current.generation !== generation ||
                  stopped ||
                  current.disposal !== undefined
                )
                  return;
                current.ready = true;
                const pump = Stream.runForEach(query.messages, (frame) =>
                  state(
                    Effect.gen(function* () {
                      if (
                        child !== current ||
                        current.generation !== generation ||
                        stopped
                      )
                        return;
                      const valid = yield* Effect.try({
                        try: () => validFrame(frame),
                        catch: () => undefined,
                      }).pipe(
                        Effect.catch(() =>
                          dieProtocolLocked("valid-frame-throw", frame).pipe(
                            Effect.as(undefined),
                          ),
                        ),
                      );
                      if (valid === undefined) return;
                      if (!valid) {
                        if (active?.endTurn && active.ending === undefined)
                          yield* closeCompletedLocked(active);
                        else yield* dieProtocolLocked("invalid-frame", frame);
                        return;
                      }
                      if (!consumesFrame(frame)) {
                        if (!ignoredTypes.has(frame.type)) {
                          ignoredTypes.add(frame.type);
                          yield* Effect.logInfo(
                            /^[a-z][a-z0-9_]{0,39}$/.test(frame.type)
                              ? frame.type
                              : "unrecognized",
                          );
                        }
                        return;
                      }
                      if (frame.type === "system" && frame.subtype === "init") {
                        if (active !== undefined)
                          yield* receiveLocked(active, frame, "init-receive");
                        sessionId = frame.session_id;
                        return;
                      }
                      if (frame.type === "conversation_reset") {
                        if (active !== undefined)
                          yield* receiveLocked(active, frame, "reset-receive");
                        sessionId = frame.new_conversation_id;
                        resumePoint = undefined;
                        ledger.clear();
                        return;
                      }
                      const turn = active;
                      const publishedTail =
                        turn?.messages.isPublishedTail(frame) ?? false;
                      const isReply =
                        frame.type === "result" ||
                        ((frame.type === "assistant" ||
                          frame.type === "stream_event") &&
                          frame.parent_tool_use_id === null);
                      if (
                        isReply &&
                        (turn?.ending === undefined || publishedTail)
                      ) {
                        // sdk.d.ts:3725-3733, 5781-5785, 5993-5999, 6054-6060.
                        // Older producers omit stamps: only the one open turn and ordered frames can bind them.
                        const stamps = [
                          ...(frame.user_message_uuids ?? []),
                          ...(frame.user_message_uuid === undefined
                            ? []
                            : [frame.user_message_uuid]),
                        ];
                        if (
                          turn === undefined ||
                          (frame.type === "result" &&
                            turn.pendingSends.size === 0) ||
                          frame.user_message_uuids?.length === 0 ||
                          stamps.some((id) => !turn.sends.has(id))
                        ) {
                          if (turn === undefined && lastEndedByTool)
                            pendingProtocolFault = true;
                          if (turn?.ending !== undefined)
                            turn.ending = failOutcome(
                              "protocol-error",
                              "broken",
                            );
                          yield* dieProtocolLocked("reply-binding", frame);
                          return;
                        }
                      }
                      if (turn !== undefined && publishedTail) {
                        const collected = yield* receiveLocked(
                          turn,
                          frame,
                          "published-tail-receive",
                        );
                        if (collected !== undefined)
                          yield* acceptMessagesLocked(turn, collected);
                        return;
                      }
                      if (turn?.ending !== undefined) {
                        if (turn.messages.isPublishedFrame(frame)) {
                          yield* withProtocolWarning(
                            Effect.gen(function* () {
                              turn.ending = failOutcome(
                                "protocol-error",
                                "broken",
                              );
                              stopped = true;
                              if (child !== undefined)
                                yield* disposeLocked(child);
                            }),
                            "published-frame-ending",
                            frame,
                          );
                          return;
                        }
                        if (
                          turn.endTurn &&
                          turn.messages.isFurtherOutput(frame)
                        ) {
                          pendingProtocolFault = true;
                          if (child !== undefined) yield* disposeLocked(child);
                        }
                        return;
                      }
                      if (turn === undefined) {
                        if (
                          frame.type === "system" &&
                          frame.subtype === "api_retry"
                        ) {
                          if (lastEndedByTool) pendingProtocolFault = true;
                          yield* dieProtocolLocked("retry-without-turn", frame);
                        }
                        return;
                      }
                      if (turn.messages.isPublishedFrame(frame)) {
                        yield* dieProtocolLocked(
                          "published-frame-open-turn",
                          frame,
                        );
                        return;
                      }
                      if (
                        (turn.endTurn ||
                          turn.completedMessages >=
                            (turn.final
                              ? FINAL_TURN_MESSAGES
                              : policy.turnLimit)) &&
                        turn.messages.isFurtherOutput(frame)
                      ) {
                        if (turn.endTurn) yield* closeCompletedLocked(turn);
                        else {
                          yield* emitMessagesLocked(
                            turn,
                            turn.messages.finish(),
                          );
                          yield* emitStreamUsageLocked(turn);
                          resumeUsage = true;
                          if (
                            turn.lastEntryIsCarrier &&
                            turn.lastEntry !== undefined
                          )
                            resumePoint = turn.lastEntry;
                          if (child !== undefined) yield* disposeLocked(child);
                          yield* finishLocked(
                            turn,
                            failOutcome("turn-limit-reached", "reusable"),
                          );
                        }
                        return;
                      }
                      const collected = yield* receiveLocked(
                        turn,
                        frame,
                        "message-receive",
                      );
                      if (collected === undefined) return;
                      if (
                        (frame.type === "assistant" || frame.type === "user") &&
                        frame.parent_tool_use_id === null &&
                        frame.uuid !== undefined
                      ) {
                        turn.lastEntry = frame.uuid;
                        turn.lastEntryIsCarrier =
                          frame.type === "user" &&
                          Array.isArray(frame.message.content) &&
                          frame.message.content.some(
                            (block) => block.type === "tool_result",
                          );
                      }
                      yield* acceptMessagesLocked(turn, collected);
                      if (frame.type === "stream_event") {
                        if (
                          frame.event.type === "content_block_start" &&
                          frame.event.content_block.type === "tool_use"
                        ) {
                          const name = frame.event.content_block.name;
                          if (
                            !(name === "StructuredOutput" && turn.final) &&
                            !policy.tools.some(
                              (tool) => `mcp__neuve__${tool.name}` === name,
                            )
                          ) {
                            yield* dieProtocolLocked(
                              "stream-unknown-tool",
                              frame,
                            );
                            return;
                          }
                        }
                        if (
                          frame.parent_tool_use_id === null &&
                          frame.event.type === "content_block_delta" &&
                          frame.event.delta.type === "text_delta"
                        ) {
                          turn.progressed = true;
                          yield* emit({
                            type: "text",
                            turnId: turn.id,
                            at: now(),
                            text: frame.event.delta.text,
                          });
                        }
                      } else if (
                        frame.type === "assistant" &&
                        frame.parent_tool_use_id === null
                      ) {
                        const foreign = frame.message.content.some(
                          (block) =>
                            block.type === "tool_use" &&
                            !(
                              block.name === "StructuredOutput" && turn.final
                            ) &&
                            !policy.tools.some(
                              (tool) =>
                                `mcp__neuve__${tool.name}` === block.name,
                            ),
                        );
                        if (foreign) {
                          yield* dieProtocolLocked(
                            "assistant-unknown-tool",
                            frame,
                          );
                          return;
                        }
                        if (frame.error !== undefined)
                          turn.observations = {
                            ...turn.observations,
                            assistant: {
                              code: frame.error,
                              text: assistantText(frame),
                            },
                          };
                        const info =
                          frame.error === "rate_limit"
                            ? assistantRateInfo(frame)
                            : undefined;
                        if (info !== undefined && usageBlocked(info))
                          turn.rejected.set(
                            info.rateLimitType ?? "other",
                            limitWindow(info, now()),
                          );
                      } else if (frame.type === "rate_limit_event") {
                        const window = limitWindow(
                          frame.rate_limit_info,
                          now(),
                        );
                        yield* emit({
                          type: "rate-limit",
                          turnId: turn.id,
                          at: now(),
                          ...window,
                        });
                        const key =
                          frame.rate_limit_info.rateLimitType ?? "other";
                        if (usageBlocked(frame.rate_limit_info))
                          turn.rejected.set(key, window);
                        else turn.rejected.delete(key);
                      } else if (
                        frame.type === "system" &&
                        frame.subtype === "api_retry"
                      ) {
                        yield* emit({
                          type: "retry",
                          turnId: turn.id,
                          at: now(),
                          attempt: frame.attempt,
                          maxAttempts: frame.max_retries,
                          delayMs: frame.retry_delay_ms,
                          ...(frame.error_status === null
                            ? {}
                            : { httpStatus: frame.error_status }),
                        });
                      } else if (frame.type === "result") {
                        const pendingAtResult = [...turn.pendingSends];
                        for (const [model, entry] of Object.entries(
                          frame.modelUsage,
                        ))
                          limits.set(model, modelLimits(entry));
                        const currentUsage = new Map(
                          Object.entries(frame.modelUsage).map(
                            ([model, entry]) => [model, modelUsage(entry)],
                          ),
                        );
                        const advanced = advanceLedger(ledger, currentUsage);
                        const deltas = resumeUsage
                          ? new Map(turn.requestUsage)
                          : advanced.deltas;
                        turn.streamUsageAfterResult = resumeUsage;
                        ledger = resumeUsage ? currentUsage : advanced.baseline;
                        resumeUsage = false;
                        for (const [model, delta] of deltas) {
                          const total = addUsage(
                            turn.usage.get(model) ?? zeroUsage(),
                            delta,
                          );
                          turn.usage.set(model, total);
                          yield* emit({
                            type: "usage",
                            turnId: turn.id,
                            at: now(),
                            scope: "turn",
                            model,
                            ...limits.get(model),
                            usage: total,
                            costUsd: null,
                          });
                        }
                        turn.requestUsage.clear();
                        if (turn.endTurn) {
                          yield* finishLocked(turn, { status: "completed" });
                          return;
                        }
                        const consumedCount = consumedSendCount(
                          frame,
                          pendingAtResult,
                        );
                        for (const id of pendingAtResult.slice(
                          0,
                          consumedCount,
                        ))
                          turn.pendingSends.delete(id);
                        // Claude Code has moved on; settle even calls it never dispatched.
                        for (const callId of turn.calls.keys())
                          yield* settleCallLocked(turn, callId);
                        if (turn.heldSteers.length > 0)
                          yield* offerHeldLocked(current, turn);
                        const hasQueuedWork = turn.pendingSends.size > 0;
                        const assistant = turn.observations.assistant;
                        if (
                          turn.ending === undefined &&
                          !turn.refreshRetried &&
                          !turn.toolRan &&
                          !turn.progressed &&
                          turn.sends.size === 1 &&
                          turn.pendingSends.size === 0 &&
                          assistant?.code === "server_error" &&
                          /another Claude Code process is refreshing it/i.test(
                            assistant.text,
                          )
                        ) {
                          turn.refreshRetried = true;
                          turn.observations = {};
                          yield* sendLocked(current, turn, turn.message);
                          return;
                        }
                        const observed: TurnObservations = {
                          ...turn.observations,
                          limited: turn.rejected.values().next().value,
                        };
                        const resultOutcome = outcomeFromResult(
                          account,
                          frame,
                          observed,
                          turn.final && !hasQueuedWork,
                          sdk.prefixes,
                        );
                        if (resultOutcome.status === "failed")
                          turn.failedOutcome ??= resultOutcome;
                        if (turn.ending === undefined && hasQueuedWork) return;
                        if (turn.cleanup !== undefined) return;
                        const outcome = turn.failedOutcome ?? resultOutcome;
                        yield* finishLocked(turn, outcome);
                      }
                    }),
                  ),
                ).pipe(
                  Effect.catchCause(() =>
                    state(
                      Effect.gen(function* () {
                        if (
                          child === current &&
                          current.generation === generation &&
                          !stopped
                        )
                          yield* dieLocked("provider-failed");
                      }),
                    ),
                  ),
                  Effect.ensuring(
                    state(
                      Effect.gen(function* () {
                        if (
                          child === current &&
                          current.generation === generation &&
                          !stopped
                        )
                          yield* dieLocked("provider-failed");
                      }),
                    ),
                  ),
                );
                yield* Effect.forkIn(pump, current.scope, {
                  startImmediately: false,
                });
              }),
            );
          }).pipe(
            Effect.timeout("25 seconds"),
            Effect.mapError(
              () =>
                new RuntimeUnavailable({
                  account: account.name,
                  reason: "start-failed",
                }),
            ),
          ),
          sessionScope,
          { startImmediately: false },
        );
        return current.opening;
      });
    const waitDisposal = (disposal: Fiber.Fiber<void>) =>
      Effect.gen(function* () {
        const done = yield* Fiber.join(disposal).pipe(
          Effect.timeoutOption(timeoutMs),
        );
        if (done._tag === "Some") return;
        yield* state(
          Effect.gen(function* () {
            stopped = true;
            yield* Effect.forkIn(Fiber.interrupt(disposal), sessionScope);
            if (active !== undefined) {
              yield* finishLocked(active, interrupted("shutdown"));
              yield* publishLocked(active, interrupted("shutdown"));
            }
            yield* Queue.end(queue);
          }),
        );
        return yield* failure("session-stopped");
      });
    const startWork = (turn: Turn) =>
      Effect.gen(function* () {
        const previous = yield* state(
          Effect.gen(function* () {
            if (active !== turn || turn.ending !== undefined || stopped)
              return yield* failure("session-stopped");
            return child !== undefined &&
              (child.final !== turn.final || !child.ready)
              ? yield* disposeLocked(child)
              : undefined;
          }),
        );
        if (previous !== undefined) yield* waitDisposal(previous);
        const opening = yield* state(
          Effect.gen(function* () {
            if (active !== turn || turn.ending !== undefined || stopped)
              return yield* failure("session-stopped");
            return child === undefined
              ? yield* openQueryLocked(turn.final)
              : undefined;
          }),
        );
        if (opening !== undefined) yield* Fiber.join(opening);
        const sending = yield* state(
          Effect.gen(function* () {
            if (
              active !== turn ||
              turn.ending !== undefined ||
              stopped ||
              child === undefined ||
              !child.ready
            )
              return yield* failure("session-stopped");
            if (selectionEffort(selectedModel, models).refused) {
              return yield* withProtocolWarning(
                Effect.gen(function* () {
                  yield* finishLocked(
                    turn,
                    failOutcome("protocol-error", "reusable"),
                  );
                  return yield* failure("protocol-error");
                }),
                "start-effort-refused",
              );
            }
            const held = ("resume" in identity ? heldResults : [])
              .map(
                (result) =>
                  `The ${result.toolName} tool already ran; do not call it again. Its result was: ${result.text}`,
              )
              .join("\n");
            const text = !held
              ? turn.message
              : typeof turn.message === "string"
                ? `${held}\n${turn.message}`
                : [{ type: "text" as const, text: held }, ...turn.message];
            heldResults = [];
            return yield* sendLocked(child, turn, text);
          }),
        );
        yield* Fiber.join(sending);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            const ended = yield* state(
              Effect.sync(() =>
                turn.ending?.status === "failed" &&
                turn.ending.failure._tag === "TurnFailed"
                  ? {
                      reason: turn.ending.failure.reason,
                      cleanup: turn.cleanup,
                    }
                  : undefined,
              ),
            );
            if (ended === undefined) return yield* Effect.failCause(cause);
            // Publish the recorded fault before the caller can close its session scope.
            if (ended.cleanup !== undefined) yield* Fiber.join(ended.cleanup);
            return yield* failure(ended.reason);
          }),
        ),
        Effect.onError(() =>
          state(
            Effect.gen(function* () {
              if (active === turn && turn.ending === undefined)
                yield* dieLocked("provider-failed");
            }),
          ),
        ),
      );
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const shutdown = yield* state(
          Effect.gen(function* () {
            stopped = true;
            if (active !== undefined) {
              const turn = active;
              yield* cancelLocked(turn);
              yield* publishLocked(turn, interrupted("shutdown"));
            }
            const existing = child?.disposal;
            const disposal =
              child === undefined ? undefined : yield* disposeLocked(child);
            yield* Queue.end(queue);
            return { existing, disposal };
          }),
        );
        if (shutdown.existing !== undefined)
          yield* Effect.forkIn(
            Fiber.interrupt(shutdown.existing),
            sessionScope,
          );
        else if (shutdown.disposal !== undefined)
          yield* Fiber.join(shutdown.disposal).pipe(
            Effect.interruptible,
            Effect.timeoutOption(timeoutMs),
          );
        yield* Effect.promise(() => server.instance.close()).pipe(
          Effect.timeoutOption(timeoutMs),
        );
      }),
    );
    const initial = yield* state(openQueryLocked(false));
    yield* Fiber.join(initial).pipe(
      Effect.onError(() =>
        Effect.gen(function* () {
          const disposal = yield* state(
            Effect.gen(function* () {
              stopped = true;
              return child === undefined
                ? undefined
                : yield* disposeLocked(child);
            }),
          );
          if (disposal !== undefined)
            yield* Fiber.join(disposal).pipe(Effect.timeoutOption(timeoutMs));
        }),
      ),
    );
    const session: RuntimeSession & {
      readonly continuation: Effect.Effect<
        Readonly<{
          sessionId: string;
          resumePoint?: string;
          usageBaseline: ReadonlyMap<string, Readonly<CallUsage>>;
        }>
      >;
      readonly diagnostics: Effect.Effect<
        Readonly<{ discardedSteers: number }>
      >;
    } = {
      get nativeSessionId() {
        return sessionId;
      },
      events: Stream.fromQueue(queue),
      diagnostics: state(Effect.sync(() => ({ discardedSteers }))),
      continuation: state(
        Effect.sync(() => ({
          sessionId,
          ...(resumePoint === undefined ? {} : { resumePoint }),
          usageBaseline: new Map(
            Array.from(ledger, ([model, usage]) => [model, { ...usage }]),
          ),
        })),
      ),
      startTurn: (input) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const starting = yield* state(
              Effect.gen(function* () {
                if (pendingProtocolFault) {
                  return yield* withProtocolWarning(
                    failure("protocol-error"),
                    "start-pending-protocol",
                  );
                }
                if (stopped) return yield* failure("session-stopped");
                if (active !== undefined || child?.disposal !== undefined)
                  return yield* failure("previous-turn-active");
                if (input.final && policy.outputSchema === undefined)
                  return yield* failure("no-output-schema");
                const turn: Turn = {
                  id: input.turnId,
                  message: input.message,
                  messages: messageCollector(policy.tools),
                  requestUsage: new Map(),
                  streamUsageAfterResult: false,
                  completedMessages: 0,
                  lastEntryIsCarrier: false,
                  calls: new Map(),
                  endTurn: false,
                  final: input.final === true,
                  scope: yield* Scope.fork(sessionScope),
                  abort: new AbortController(),
                  usage: new Map(),
                  progressed: false,
                  rejected: new Map(),
                  observations: {},
                  sends: new Set(),
                  pendingSends: new Set(),
                  heldSteers: [],
                  remainingCalls: new Map(),
                  settledCalls: new Map(),
                  toolRan: false,
                  refreshRetried: false,
                };
                active = turn;
                yield* emit({
                  type: "turn.started",
                  turnId: turn.id,
                  at: now(),
                });
                turn.starting = yield* Effect.forkIn(
                  startWork(turn),
                  sessionScope,
                  { startImmediately: false },
                );
                return turn.starting;
              }),
            );
            yield* restore(Fiber.join(starting));
          }),
        ),
      steerTurn: (input) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const sending = yield* state(
              Effect.gen(function* () {
                if (stopped) return yield* failure("session-stopped");
                const turn = active;
                if (
                  turn === undefined ||
                  turn.id !== input.turnId ||
                  turn.ending !== undefined ||
                  child === undefined ||
                  !child.ready ||
                  child.disposal !== undefined ||
                  turn.endTurn
                )
                  return yield* failure("previous-turn-active");
                if (policy.tools.length > 0) {
                  const message = userMessage(input.message, true);
                  if (message.uuid !== undefined) turn.sends.add(message.uuid);
                  turn.heldSteers.push(message);
                  return undefined;
                }
                return yield* sendLocked(child, turn, input.message, true);
              }),
            );
            if (sending !== undefined) yield* restore(Fiber.join(sending));
          }),
        ),
      interruptTurn: (input) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const cleanup = yield* state(
              Effect.gen(function* () {
                const turn = active;
                if (turn === undefined || turn.id !== input.turnId)
                  return yield* failure("previous-turn-active");
                if (turn.cleanup === undefined) {
                  yield* finishLocked(turn, interrupted(input.reason));
                  if (turn.starting !== undefined)
                    yield* Effect.forkIn(
                      Fiber.interrupt(turn.starting),
                      sessionScope,
                    );
                }
                return turn.cleanup;
              }),
            );
            if (cleanup !== undefined) yield* restore(Fiber.join(cleanup));
          }),
        ),
      respondToApproval: (input) =>
        state(
          Effect.gen(function* () {
            const request = approvals.get(input.requestId);
            if (
              request === undefined ||
              active !== request.turn ||
              request.turn.ending !== undefined ||
              Deferred.isDoneUnsafe(request.answer)
            )
              return yield* failure("previous-turn-active");
            yield* Deferred.succeed(
              request.answer,
              input.decision === "allow"
                ? { behavior: "allow" }
                : {
                    behavior: "deny",
                    message: input.message ?? "Denied by the user.",
                  },
            );
          }),
        ),
      setModel: (model) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const switching = yield* state(
              Effect.gen(function* () {
                const previous = modelSwitch;
                modelSwitch = yield* Effect.forkIn(
                  Effect.gen(function* () {
                    if (previous !== undefined) yield* Fiber.await(previous);
                    const target = yield* state(
                      Effect.gen(function* () {
                        if (
                          child?.query === undefined ||
                          !child.ready ||
                          stopped ||
                          child.disposal !== undefined
                        )
                          return yield* failure("session-stopped");
                        const selection = selectionEffort(model, models);
                        if (selection.refused) {
                          return yield* withProtocolWarning(
                            failure("protocol-error"),
                            "model-effort-refused",
                          );
                        }
                        return {
                          current: child,
                          query: child.query,
                          effort: selection.effort,
                        };
                      }),
                    );
                    const changed = yield* target.query
                      .setModel(model.id === "default" ? undefined : model.id)
                      .pipe(
                        Effect.andThen(
                          target.query.applyFlagSettings({
                            effortLevel: target.effort ?? null,
                          }),
                        ),
                        Effect.timeout("25 seconds"),
                        Effect.exit,
                      );
                    if (Exit.isFailure(changed)) {
                      const disposal = yield* state(
                        Effect.gen(function* () {
                          if (
                            child !== target.current ||
                            generation !== target.current.generation
                          )
                            return undefined;
                          const disposal = yield* disposeLocked(target.current);
                          if (
                            active !== undefined &&
                            active.ending === undefined
                          )
                            yield* finishLocked(
                              active,
                              failOutcome("provider-failed", "reusable"),
                            );
                          return disposal;
                        }),
                      );
                      if (disposal !== undefined)
                        yield* waitDisposal(disposal).pipe(
                          Effect.catch(() => Effect.void),
                        );
                      return yield* failure("provider-failed");
                    }
                    yield* state(
                      Effect.gen(function* () {
                        if (
                          child !== target.current ||
                          generation !== target.current.generation ||
                          stopped ||
                          !target.current.ready
                        )
                          return yield* failure("provider-failed");
                        selectedModel = model;
                      }),
                    );
                  }),
                  sessionScope,
                  { startImmediately: false },
                );
                return modelSwitch;
              }),
            );
            yield* restore(Fiber.join(switching));
          }),
        ),
    };
    return session;
  });
