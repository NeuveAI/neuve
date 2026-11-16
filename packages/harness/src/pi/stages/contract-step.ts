import { copyJson, type Context } from "@earendil-works/chord";
import type { TaskId, Tx, DocumentReader } from "@earendil-works/pi-durable";
import { canonicalJson, readData, sha256Hex } from "@neuve/records-core";
import {
  JsonSchema,
  RuntimeEvent,
  RuntimeFailure,
  TurnFailed,
  TurnLimit,
  runtimeFailureToError,
  type AccountName,
  type RuntimeSession,
  type TurnOutcome,
} from "@neuve/runtime";
import { runtimeFailurePolicy } from "../failure-policy.ts";
import {
  ContractRecoveryFailed,
  contractSessionStart,
  physicalTurnId,
  retryContractRound,
} from "./contract-recovery.ts";
import { Cause, Effect, Exit, Scope, Stream } from "effect";
import {
  MAX_CONTINUATIONS,
  MAX_INVALID_SUBMISSIONS,
  REMINDER_SHARE,
} from "../../budget.ts";
import { routeAccount, type AnyRouteConfig } from "../../route.ts";
import type { RunLog } from "../../run-log.ts";
import { wireSchema } from "../../toolkit.ts";
import { dropAddedNulls } from "../providers/wire.ts";
import {
  continueText,
  finalText,
  refusedText,
  reminderText,
  scanSubmissions,
  submitNameOf,
  type AgentResult,
  type AgentStep,
  type EndedBy,
} from "./agent.ts";
import {
  ContractContextDoc,
  type AgentKind,
  type ToolDeclaration,
} from "./docs.ts";
import {
  contractFacts,
  contractStore,
  ContractWriteRefused,
  ContractState,
} from "./contract-state.ts";
import { contractTools } from "./contract-tools.ts";
import type { StageServices } from "./services.ts";
import { parseOutput, submissionOf, type ResolvedAgent } from "./tools.ts";

class ContractSessionReopen extends Error {}

export type ContractEnding = Pick<
  AgentResult<unknown>,
  "status" | "endedBy" | "output" | "repairedFrom" | "finalGeneration"
> & { readonly output: unknown };
export interface ContractPort {
  readonly taskId: TaskId;
  readonly signal: AbortSignal;
  readonly snapshot: DocumentReader["snapshot"];
  readonly commit: (
    change: (tx: Tx) => Promise<undefined>,
    context: Context,
  ) => Promise<void>;
}

/** Preserve the native tagged error rather than Effect's promise wrapper. */
async function value<A, E>(
  effect: Effect.Effect<A, E>,
  signal?: AbortSignal,
): Promise<A> {
  const exit = await Effect.runPromiseExit(
    effect,
    signal === undefined ? undefined : { signal },
  );
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
}

/** Deterministic projections can be emitted again from the task document without a second outbox. */
export function emitContractTelemetry(
  state: ContractState,
  log: RunLog,
  route: Pick<AnyRouteConfig, "model" | "effort" | "maxOutputTokens">,
  from = 0,
) {
  const seen = new Set<string>();
  state.events.forEach((event, ordinal) => {
    if (ordinal < from) return;
    if (event.type === "message.finished") {
      if (seen.has(event.messageId)) return;
      seen.add(event.messageId);
    }
    emitContractEvent(state, log, route, event, ordinal);
  });
}

/**
 * What the run log keeps of an event the task document doesn't: names, counts and identifiers only
 * (run-log.ts). Text deltas are model output and are not logged; tool and approval inputs are kept as
 * a hash of their arguments, as tool calls are.
 */
function runLogMetadata(
  event: RuntimeEvent,
): Record<string, unknown> | undefined {
  const base = { type: event.type, turnId: event.turnId, at: event.at };
  switch (event.type) {
    case "text":
      return undefined;
    case "tool.started":
      return {
        ...base,
        callId: event.callId,
        toolName: event.toolName,
        argsHash: sha256Hex(canonicalJson(copyJson(event.input))).slice(0, 16),
      };
    case "approval.requested":
      return {
        ...base,
        requestId: event.requestId,
        callId: event.callId,
        toolName: event.toolName,
      };
    case "retry":
      return {
        ...base,
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        httpStatus: event.httpStatus,
      };
    case "rate-limit":
      return {
        ...base,
        window: event.window,
        model: event.model,
        status: event.status,
        utilization: event.utilization,
        resetsAt: event.resetsAt,
        observedAt: event.observedAt,
      };
    default:
      return base;
  }
}

function emitContractEvent(
  state: Pick<ContractState, "contextKey" | "stage" | "agent" | "rounds">,
  log: RunLog,
  route: Pick<AnyRouteConfig, "model" | "effort" | "maxOutputTokens">,
  event: RuntimeEvent,
  ordinal: number,
) {
  const id = (parts: unknown) =>
    `contract:${sha256Hex(canonicalJson(copyJson([state.contextKey, parts])))}`;
  if (event.type === "message.finished") {
    log.write({
      type: "model.call",
      telemetryId: id(["message", event.messageId]),
      stage: state.stage,
      agent: state.agent,
      call: `${state.contextKey}:${event.messageId}`,
      kind:
        state.rounds.find((round) => physicalTurnId(round) === event.turnId)
          ?.final === true
          ? "final"
          : "turn",
      model: event.model ?? route.model,
      effort: route.effort,
      configuredMaxTokens: route.maxOutputTokens,
      observedAt: event.at,
      finishReason: event.stopReason,
      refused: event.stopReason === "refusal",
      usage: event.usage,
      costUsd: null,
      responseId: event.messageId,
      toolCalls: event.toolCalls.map((call) => call.toolName),
    });
    if (event.stopReason === "refusal")
      log.write({
        type: "gap",
        telemetryId: id(["refusal", event.messageId]),
        kind: "refusal",
        stage: state.stage,
        agent: state.agent,
        detail:
          "The model declined one turn; the stage continued without its output.",
      });
  } else if (event.type === "usage") {
    log.write({
      type: "runtime.usage",
      telemetryId: id(["usage", ordinal]),
      contextKey: state.contextKey,
      stage: state.stage,
      agent: state.agent,
      turnId: event.turnId,
      scope: event.scope,
      model: event.model ?? route.model,
      revision: ordinal,
      usage: event.usage,
      costUsd: null,
    });
  }
}

export function repairedContract(
  step: AgentStep<unknown, unknown>,
  data: unknown,
) {
  if (data === undefined || step.spec.repair === undefined) return undefined;
  const fixed = step.spec.repair(data);
  return ((step.spec.checkRepaired ?? step.spec.check)?.(fixed) ?? [])
    .length === 0
    ? fixed
    : undefined;
}

/** One scoped contract session owns all rounds of a stage context. */
export async function contractStep(input: {
  readonly port: ContractPort;
  readonly context: Context;
  readonly agent: ResolvedAgent;
  readonly kind: AgentKind;
  readonly frozen: ReadonlyArray<ToolDeclaration>;
  readonly account: AccountName;
  readonly services: StageServices;
  readonly route: Pick<AnyRouteConfig, "model" | "effort" | "maxOutputTokens">;
  readonly startedAt: number;
  readonly cutoffAt: number;
}): Promise<ContractEnding> {
  const { port, context, agent, kind, frozen, services, route } = input;
  const { step } = agent;
  const spec = step.spec;
  const schema = JsonSchema.parse(wireSchema(spec.submit.schema).schema);
  const store = contractStore(port, context);
  const existing = await port.snapshot(
    ContractContextDoc,
    port.taskId,
    context,
  );
  const continuation = await value(
    services.runtimes.continuation(input.account),
    port.signal,
  );
  const initial: ContractState =
    existing?.data != null
      ? readData(ContractState, existing.data, {
          source: "neuve.contract-context",
        })
      : {
          contextKey: `${services.ctx.runId}:${port.taskId}:${spec.agent}`,
          agent: spec.agent,
          stage: spec.stage,
          kind,
          account: input.account,
          accountKind: routeAccount(services.ctx.config.route)?.kind,
          continuation,
          startedAt: input.startedAt,
          system: spec.system,
          outputSchema: schema,
          declarations: frozen.map((tool) => ({
            ...tool,
            parameters: JsonSchema.parse(tool.parameters),
          })),
          model: { id: route.model, effort: route.effort },
          native: null,
          continuations: 0,
          refusals: 0,
          endedBy: "turn-limit",
          final: false,
          ending: null,
          rounds: [],
          events: [],
          settlements: {},
          calls: {},
          toolState: null,
          reminder: false,
          endedMessages: [],
        };
  if (
    initial.account !== input.account ||
    canonicalJson(initial.continuation) !== canonicalJson(continuation)
  )
    throw new ContractRecoveryFailed({ reason: "continuation-mismatch" });
  if (existing?.data == null)
    await port.commit(async (tx) => {
      (await tx.doc(ContractContextDoc, port.taskId)).data = copyJson(initial);
      return undefined;
    }, context);
  if (initial.ending !== null)
    return { ...initial.ending, output: initial.ending.output };
  // Do not convert a process interruption into a settled protocol failure.
  if (initial.rounds.at(-1)?.state === "active") {
    contractSessionStart(initial);
    await store.update(retryContractRound);
  }
  const controller = new AbortController();
  const abort = () => controller.abort(port.signal.reason);
  port.signal.addEventListener("abort", abort, { once: true });
  if (port.signal.aborted) abort();
  const timer = setTimeout(
    () => controller.abort("cutoff"),
    Math.max(0, input.cutoffAt - Date.now()),
  );
  const scope = await value(Scope.make());
  const admission = await value(Scope.make());
  const tools = contractTools({
    agent,
    frozen,
    store,
    services,
    ceiling: services.ctx.config.budgets.contextCeiling,
  });
  let committed = await store.read();
  const unsubscribe = store.subscribe((state) => {
    committed = state;
  });
  let consumer: Promise<void> | undefined;
  let dispatch: Promise<void> | undefined;
  let terminal:
    | {
        resolve: (outcome: TurnOutcome) => void;
        reject: (error: unknown) => void;
      }
    | undefined;
  let streamFailure: unknown;
  let settling = false;
  let session: RuntimeSession | undefined;
  const protocol = () =>
    new TurnFailed({ account: input.account, reason: "protocol-error" });
  const cutoff: ContractEnding = {
    status: "interrupted",
    endedBy: "timeout",
    output: undefined,
    finalGeneration: false,
  };
  async function ensureSession() {
    if (session !== undefined) return session;
    const state = await store.read();
    const start = contractSessionStart(state);
    if (services.contractSessions === undefined) throw protocol();
    const grant = await value(
      Scope.provide(
        services.contractSessions.acquire(state.continuation),
        admission,
      ),
      controller.signal,
    );
    const revoked = () => controller.abort(grant.signal?.reason);
    grant.signal?.addEventListener("abort", revoked, { once: true });
    if (grant.signal?.aborted) revoked();
    revokeGrant = () => grant.signal?.removeEventListener("abort", revoked);
    session = await value(
      Scope.provide(
        services.runtimes.openSession(
          input.account,
          {
            systemPrompt: state.system,
            tools: tools.definitions,
            outputSchema: state.outputSchema,
            approvalPolicy: "allow",
            model: state.model,
            turnLimit: TurnLimit.parse(
              Math.max(1, spec.turnLimit - contractFacts(state).turns),
            ),
          },
          start,
        ),
        scope,
      ),
      controller.signal,
    );
    const live = session;
    await store.update((doc) => {
      doc.native = {
        sessionId: live.nativeSessionId,
        resumePoint: start.kind === "resume" ? (start.at ?? null) : null,
      };
    });
    consumer = value(
      Stream.runForEach(live.events, (raw) =>
        Effect.promise(async () => {
          const event = RuntimeEvent.parse(raw);
          const active = committed.rounds.at(-1);
          if (
            active === undefined ||
            event.turnId !== physicalTurnId(active) ||
            active.state === "settled"
          )
            throw protocol();
          if (
            ![
              "message.finished",
              "usage",
              "tool.finished",
              "turn.finished",
            ].includes(event.type)
          ) {
            if (event.type === "tool.started")
              await store.update((doc) => {
                const round = doc.rounds.at(-1);
                if (
                  round === undefined ||
                  event.turnId !== physicalTurnId(round) ||
                  round.state === "settled" ||
                  doc.calls[event.callId] !== undefined ||
                  doc.rounds.some((item) =>
                    Object.hasOwn(item.announced, event.callId),
                  ) ||
                  !frozen.some((tool) => tool.name === event.toolName)
                )
                  throw protocol();
                round.announced[event.callId] = {
                  toolName: event.toolName,
                  status: "announced",
                };
              });
            const metadata = runLogMetadata(event);
            if (metadata !== undefined)
              services.ctx.log.write({
                type: "runtime.event",
                contextKey: committed.contextKey,
                stage: spec.stage,
                agent: spec.agent,
                event: metadata,
              });
            return;
          }
          if (event.type === "turn.finished") settling = true;
          let appended: number | undefined;
          await store.update((doc) => {
            const round = doc.rounds.at(-1);
            if (
              round === undefined ||
              event.turnId !== physicalTurnId(round) ||
              round.state === "settled"
            )
              throw protocol();
            if (event.type === "message.finished") {
              if (event.usage === undefined) throw protocol();
              const previous = doc.events.find(
                (item) =>
                  item.type === "message.finished" &&
                  item.messageId === event.messageId,
              );
              if (previous !== undefined) {
                if (
                  canonicalJson(copyJson(previous)) !==
                  canonicalJson(copyJson(event))
                )
                  throw protocol();
                return;
              }
              for (const call of event.toolCalls) {
                const announced = round.announced[call.callId];
                if (
                  doc.calls[call.callId] !== undefined ||
                  (announced !== undefined &&
                    announced.toolName !== call.toolName) ||
                  !frozen.some((tool) => tool.name === call.toolName)
                )
                  throw protocol();
                doc.calls[call.callId] = {
                  status:
                    announced?.status === "cancelled"
                      ? "cancelled"
                      : "observed",
                  eligible: false,
                };
                delete round.announced[call.callId];
              }
              doc.native = {
                sessionId: live.nativeSessionId,
                resumePoint: event.resumePoint,
              };
            }
            if (event.type === "tool.finished") {
              const call = doc.calls[event.callId];
              const announced = round.announced[event.callId];
              if (call?.status === "observed" && event.errored)
                doc.calls[event.callId] = {
                  status: "cancelled",
                  eligible: false,
                };
              else if (
                call === undefined &&
                announced?.status === "announced" &&
                announced.toolName === event.toolName &&
                event.errored
              )
                announced.status = "cancelled";
              else if (call?.status !== "completed") throw protocol();
            }
            appended = doc.events.length;
            doc.events.push(event);
            if (event.type === "usage") contractFacts(doc); // Reject mixed accounting modes at their boundary.
            if (event.type === "turn.finished") {
              if (event.outcome.status === "completed") {
                for (const message of doc.events) {
                  if (
                    message.type !== "message.finished" ||
                    message.turnId !== physicalTurnId(round)
                  )
                    continue;
                  for (const call of message.toolCalls) {
                    const entry = doc.calls[call.callId];
                    if (
                      entry?.status === "observed" &&
                      (round.final ||
                        doc.endedMessages.includes(message.messageId))
                    )
                      doc.calls[call.callId] = {
                        status: "cancelled",
                        eligible: false,
                      };
                    else if (
                      entry?.status !== "completed" &&
                      entry?.status !== "cancelled"
                    )
                      throw protocol();
                  }
                }
              }
              round.state = "settled";
              round.outcome = event.outcome;
              round.carrier = event.resumePoint !== undefined;
              const last = doc.events.findLast(
                (item) => item.type === "message.finished",
              );
              doc.native = {
                sessionId: live.nativeSessionId,
                resumePoint:
                  event.resumePoint ??
                  (last?.type === "message.finished" ? last.resumePoint : null),
              };
            }
          });
          if (appended !== undefined)
            emitContractEvent(
              committed,
              services.ctx.log,
              route,
              event,
              appended,
            );
          if (event.type === "turn.finished") terminal?.resolve(event.outcome);
        }),
      ),
      controller.signal,
    ).then(
      () => {
        if (!controller.signal.aborted) return failStream(protocol());
      },
      (error) => {
        if (!controller.signal.aborted) return failStream(error);
      },
    );

    return live;
  }
  let revokeGrant = () => {};
  let reopen = false;
  try {
    for (;;) {
      if (streamFailure !== undefined) throw streamFailure;
      if (Date.now() >= input.cutoffAt) return cutoff;
      let state = await store.read();
      if (state.rounds.length === 0) {
        await store.update((doc) => {
          doc.rounds.push({
            id: `${doc.contextKey}:round:1`,
            prompt: spec.task,
            final: false,
            attempt: 1,
            dispatched: false,
            recovery: null,
            state: "prepared",
            outcome: null,
            announced: {},
            carrier: false,
            fork: false,
          });
        });
        state = await store.read();
      }
      const round = state.rounds.at(-1);
      if (round === undefined) throw protocol();
      const { final } = round;
      const endedBy = state.endedBy;
      let outcome = round.outcome;
      settling = false;
      const done = new Promise<TurnOutcome>((resolve, reject) => {
        terminal = { resolve, reject };
      });
      // Observe failure even if cancellation interrupts the preparation commit before dispatch.
      void done.catch(() => {});
      const abortTurn = () => terminal?.reject(controller.signal.reason);
      controller.signal.addEventListener("abort", abortTurn, { once: true });
      try {
        if (round.state !== "settled") {
          const live = await ensureSession();
          await store.update((doc) => {
            const round = doc.rounds.at(-1);
            if (round !== undefined) {
              if (round.dispatched) round.attempt++;
              round.dispatched = true;
              round.state = "active";
            }
          });
          controller.signal.throwIfAborted();
          const sending = (await store.read()).rounds.at(-1);
          if (sending === undefined) throw protocol();
          dispatch = value(
            live.startTurn({
              turnId: physicalTurnId(sending),
              message: sending.recovery
                ? `${sending.recovery}\n\n${sending.prompt}`
                : sending.prompt,
              ...(final ? { final: true } : {}),
            }),
            controller.signal,
          );
          outcome = await Promise.race([
            done,
            dispatch.then(
              () => done,
              (error) => {
                if (settling || streamFailure !== undefined) return done;
                throw error;
              },
            ),
          ]);
          if (outcome.status === "completed") await dispatch;
        }
        if (outcome === null) throw protocol();
        let structured: unknown;
        if (outcome.status === "interrupted")
          return { ...cutoff, finalGeneration: final };
        if (outcome.status === "failed") {
          const policy = runtimeFailurePolicy(outcome.failure, final);
          if (policy.action === "final") {
            await queueRound(finalText(policy.endedBy), true, {
              endedBy: policy.endedBy,
            });
            if (outcome.disposition === "broken") {
              // Closing a broken session is required before reopening at its durable safe point.
              throw new ContractSessionReopen();
            }
            continue;
          }
          if (policy.action !== "refuse")
            throw runtimeFailureToError(outcome.failure);
          await dispatch?.catch(() => {});
        } else structured = outcome.structuredOutput;
        const committed = await store.read();
        const facts = contractFacts(committed);
        spec.state?.load(committed.toolState ?? undefined, facts.turns);
        if (final) {
          const parsed = parseOutput(spec)(dropAddedNulls(schema, structured));
          if (parsed.success)
            return await finish({
              status: "final-generation",
              endedBy,
              output: parsed.data,
              finalGeneration: true,
            });
          const refusals = committed.refusals + 1;
          if (refusals > (spec.retries ?? MAX_INVALID_SUBMISSIONS)) {
            const fixed = repairedContract(step, parsed.data);
            disclose(
              fixed === undefined ? "invalid-output" : "output-repaired",
              fixed === undefined ? undefined : parsed.message,
            );
            await store.update((doc) => {
              doc.refusals = refusals;
            });
            return await finish(
              fixed === undefined
                ? {
                    status: "backstop",
                    endedBy,
                    output: undefined,
                    finalGeneration: true,
                  }
                : {
                    status: "final-generation",
                    endedBy,
                    output: fixed,
                    repairedFrom: parsed.data,
                    finalGeneration: true,
                  },
            );
          }
          await queueRound(refusedText(parsed.message), true, { refusals });
          if (outcome.status === "failed" && outcome.disposition === "broken")
            throw new ContractSessionReopen();
          continue;
        }
        const scan = scanSubmissions(
          facts.calls
            .filter((call) => call.name === submitNameOf(spec))
            .map((call) => call.arguments),
          submissionOf(spec),
          spec.advise,
        );
        if (scan.accepted !== undefined) {
          await store.update((doc) => {
            doc.endedBy = "submit";
          });
          return await finish({
            status: "submitted",
            endedBy: "submit",
            output: scan.accepted,
            finalGeneration: false,
          });
        }
        if (scan.failed.length > (spec.retries ?? MAX_INVALID_SUBMISSIONS)) {
          await store.update((doc) => {
            doc.endedBy = "submit";
          });
          const parsed = submissionOf(spec)(scan.failed.at(-1));
          const fixed = repairedContract(step, parsed.data);
          disclose(
            fixed === undefined ? "invalid-submissions" : "output-repaired",
            fixed === undefined ? undefined : parsed.message,
          );
          return await finish(
            fixed === undefined
              ? {
                  status: "backstop",
                  endedBy: "submit",
                  output: undefined,
                  finalGeneration: false,
                }
              : {
                  status: "submitted",
                  endedBy: "submit",
                  output: fixed,
                  repairedFrom: parsed.data,
                  finalGeneration: false,
                },
          );
        }
        const ceiling = services.ctx.config.budgets.contextCeiling;
        const end =
          agent.deadline !== undefined && Date.now() >= agent.deadline
            ? "timeout"
            : facts.lastInput >= ceiling
              ? "ceiling"
              : facts.turns >= spec.turnLimit
                ? "turn-limit"
                : committed.continuations >= MAX_CONTINUATIONS
                  ? "continuations"
                  : undefined;
        if (end !== undefined) {
          await queueRound(finalText(end), true, { endedBy: end });
        } else {
          let prompt = continueText(spec, facts.turns);
          const reminded =
            !committed.reminder &&
            facts.turns >= Math.floor(spec.turnLimit * REMINDER_SHARE);
          if (reminded) prompt += `\n\n${reminderText(spec, facts.turns)}`;
          await queueRound(prompt, false, {
            continuations: committed.continuations + 1,
            reminder: committed.reminder || reminded,
          });
        }
      } catch (error) {
        if (controller.signal.aborted) throw error;
        const failure = RuntimeFailure.safeParse(
          typeof error === "object" && error !== null ? { ...error } : error,
        );
        const policy = failure.success
          ? runtimeFailurePolicy(failure.data, final)
          : undefined;
        if (failure.success)
          await store.update((doc) => {
            const current = doc.rounds.at(-1);
            if (current?.dispatched)
              doc.settlements[physicalTurnId(current)] ??= current.outcome ?? {
                status: "failed",
                disposition: "broken",
                failure: failure.data,
              };
          });
        if (
          failure.success &&
          (policy?.action === "final" || policy?.action === "refuse")
        ) {
          await store.update((doc) => {
            const current = doc.rounds.at(-1);
            if (current === undefined) throw protocol();
            current.state = "settled";
            current.outcome = {
              status: "failed",
              disposition: "broken",
              failure: failure.data,
            };
          });
          if (policy.action === "final") {
            await queueRound(finalText(policy.endedBy), true, {
              endedBy: policy.endedBy,
            });
          }
          throw new ContractSessionReopen();
        }
        throw error;
      } finally {
        controller.signal.removeEventListener("abort", abortTurn);
        terminal = undefined;
      }
    }
  } catch (error) {
    if (error instanceof ContractSessionReopen) reopen = true;
    else if (
      !port.signal.aborted &&
      controller.signal.aborted &&
      Date.now() >= input.cutoffAt
    )
      return cutoff;
    else throw error;
  } finally {
    clearTimeout(timer);
    port.signal.removeEventListener("abort", abort);
    tools.close(protocol());
    controller.abort("session closing");
    try {
      try {
        await value(Scope.close(scope, Exit.succeed(undefined)));
      } finally {
        try {
          await consumer;
        } finally {
          try {
            await dispatch?.catch(() => {});
          } finally {
            await tools.join();
          }
        }
      }
    } finally {
      revokeGrant();
      try {
        await value(Scope.close(admission, Exit.succeed(undefined)));
      } finally {
        unsubscribe();
        // A runtime may wrap a tool error, or refusal may arrive while closing. Never settle over it.
        if (store.refusal !== undefined) throw store.refusal;
      }
    }
  }

  if (reopen) return contractStep(input);
  throw protocol();

  async function finish(ending: ContractEnding): Promise<ContractEnding> {
    await store.update((doc) => {
      doc.ending = {
        status: ending.status,
        endedBy: ending.endedBy,
        finalGeneration: ending.finalGeneration,
        ...(ending.output === undefined
          ? {}
          : { output: copyJson(ending.output) }),
        ...(ending.repairedFrom === undefined
          ? {}
          : { repairedFrom: copyJson(ending.repairedFrom) }),
      };
    });
    return ending;
  }
  async function queueRound(
    prompt: string,
    final: boolean,
    change: Partial<
      Pick<ContractState, "endedBy" | "refusals" | "continuations" | "reminder">
    > = {},
  ) {
    await store.update((doc) => {
      Object.assign(doc, change);
      doc.final = final;
      doc.rounds.push({
        id: `${doc.contextKey}:round:${doc.rounds.length + 1}`,
        prompt,
        final,
        attempt: 1,
        dispatched: false,
        recovery: null,
        state: "prepared",
        outcome: null,
        announced: {},
        carrier: false,
        fork: false,
      });
    });
  }
  async function failStream(error: unknown) {
    if (controller.signal.aborted) return;
    streamFailure = error;
    tools.close(error);
    try {
      if (error instanceof ContractWriteRefused) return;
      const failure = RuntimeFailure.safeParse(
        typeof error === "object" && error !== null ? { ...error } : error,
      );
      await store.update((doc) => {
        const round = doc.rounds.at(-1);
        if (round === undefined || round.state === "settled") return;
        round.state = "settled";
        round.outcome = {
          status: "failed",
          disposition: "broken",
          failure: failure.success
            ? failure.data
            : {
                _tag: "TurnFailed",
                account: input.account,
                reason: "protocol-error",
              },
        };
      });
    } finally {
      terminal?.reject(store.refusal ?? error);
    }
  }

  /**
   * As pi does: a cause only for repaired output, whose schema parsed, so its check messages name
   * identifiers and counts. A backstop logs no cause: schema errors can quote submitted keys.
   */
  function disclose(kind: string, cause: string | undefined) {
    services.ctx.log.write({
      type: "gap",
      stage: spec.stage,
      agent: spec.agent,
      kind,
      ...(cause === undefined ? {} : { cause: cause.slice(0, 1500) }),
      detail:
        kind === "output-repaired"
          ? "Code repaired the last output after its invalid-output chances were used up."
          : "The stage used its code backstop after its invalid-output chances were used up.",
    });
  }
}
