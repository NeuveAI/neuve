import { copyJson } from "@earendil-works/chord";
import { readData } from "@neuve/records-core";
import {
  JsonSchema,
  TurnFailed,
  runtimeFailureToError,
  type ToolDefinition,
  type ToolOutcome,
  type ToolCall,
} from "@neuve/runtime";
import { Effect } from "effect";
import { physicalTurnId } from "./contract-recovery.ts";
import { REMINDER_SHARE } from "../../budget.ts";
import { capResult, describeZodError, RECORDS } from "../../toolkit.ts";
import { reminderText, submitNameOf } from "./agent.ts";
import { ToolState, type ToolDeclaration } from "./docs.ts";
import {
  contractFacts,
  type ContractState,
  type ContractStore,
} from "./contract-state.ts";
import {
  budgetLine,
  roundEnds,
  strictArguments,
  submitted,
  type ResolvedAgent,
} from "./tools.ts";
import type { StageServices } from "./services.ts";

export const ROUND_ENDED = "The round ended.";
export const FINAL_TOOLS_UNAVAILABLE =
  "Tools are unavailable for the final answer.";

/** A publication signal, never a timer or an execution slot while a handler waits. */
export function contractTools(input: {
  readonly agent: ResolvedAgent;
  readonly frozen: ReadonlyArray<ToolDeclaration>;
  readonly store: ContractStore;
  readonly services: StageServices;
  readonly ceiling: number;
}) {
  const { agent, frozen, store, services, ceiling } = input;
  const spec = agent.step.spec;
  let committed: ContractState | undefined;
  let stopped: { error: unknown } | undefined;
  const waiters = new Set<() => void>();
  const publish = () => {
    for (const wake of waiters) wake();
    waiters.clear();
  };
  const close = (error: unknown) => {
    stopped = { error };
    unsubscribe();
    publish();
  };
  const unsubscribe = store.subscribe((state) => {
    committed = state;
    publish();
  });
  const pending = new Map<string, Promise<ToolOutcome>>();

  const checkActive = (signal: AbortSignal) => {
    signal.throwIfAborted();
    if (stopped !== undefined) throw stopped.error;
  };

  async function ready(call: ToolCall) {
    for (;;) {
      checkActive(call.signal);
      let wake = () => {};
      const changed = new Promise<void>((resolve) => {
        wake = resolve;
        waiters.add(wake);
      });
      const abort = () => wake();
      call.signal.addEventListener("abort", abort, { once: true });
      try {
        const state = committed;
        checkActive(call.signal);
        const round = state?.rounds.at(-1);
        if (state !== undefined && round?.state === "settled")
          throw round.outcome?.status === "failed"
            ? runtimeFailureToError(round.outcome.failure)
            : new TurnFailed({
                account: state.account,
                reason: "protocol-error",
              });
        const message = state?.events.find(
          (event) =>
            event.type === "message.finished" &&
            event.toolCalls.some((item) => item.callId === call.callId),
        );
        if (state !== undefined && message?.type === "message.finished") {
          if (state.calls[call.callId]?.status === "cancelled")
            throw new TurnFailed({
              account: state.account,
              reason: "protocol-error",
            });
          const at = message.toolCalls.findIndex(
            (item) => item.callId === call.callId,
          );
          const earlier = message.toolCalls.slice(0, at);
          if (
            earlier.every(
              (item) =>
                state.calls[item.callId]?.status === "completed" ||
                state.calls[item.callId]?.status === "cancelled",
            )
          )
            return { state, message };
        }
        await changed;
      } finally {
        waiters.delete(wake);
        call.signal.removeEventListener("abort", abort);
      }
    }
  }

  const apply = async (
    declaration: ToolDeclaration,
    call: ToolCall,
  ): Promise<ToolOutcome> => {
    const { state, message } = await ready(call);
    const prior = state.calls[call.callId];
    if (prior?.status === "completed") return prior.outcome;
    if (prior?.status === "started")
      throw new TurnFailed({
        account: state.account,
        reason: "protocol-error",
      });
    const rawCall = message.toolCalls.find(
      (item) => item.callId === call.callId,
    );
    if (rawCall === undefined || rawCall.toolName !== declaration.name)
      throw new TurnFailed({
        account: state.account,
        reason: "protocol-error",
      });
    const round = state.rounds.find(
      (r) => physicalTurnId(r) === message.turnId,
    );
    if (round === undefined)
      throw new TurnFailed({
        account: state.account,
        reason: "protocol-error",
      });
    const final = round.final;
    const ended = state.endedMessages.includes(message.messageId);
    const eligible = !final && !ended;
    await store.update((doc) => {
      doc.calls[call.callId] = { status: "started", eligible };
    });
    let outcome: ToolOutcome;
    let nextState = state.toolState;
    let reminded = false;
    if (final)
      outcome = {
        text: FINAL_TOOLS_UNAVAILABLE,
        error: "FinalToolsUnavailable",
        endTurn: true,
      };
    else if (ended) outcome = { text: ROUND_ENDED, endTurn: true };
    else {
      const facts = contractFacts({
        ...state,
        calls: {
          ...state.calls,
          [call.callId]: { status: "started", eligible: true },
        },
      });
      spec.state?.load(nextState ?? undefined, facts.turns);
      const own = [...spec.tools, agent.vent].find(
        (tool) => tool.name === declaration.name,
      );
      const isSubmit = declaration.name === submitNameOf(spec);
      const raw = rawCall.input;
      const prepared = strictArguments(declaration)?.(raw) ?? raw;
      const schema = isSubmit ? spec.submit.schema : own?.input;
      const parsed =
        schema === undefined
          ? { success: true as const, data: undefined }
          : schema.safeParse(prepared);
      outcome = !parsed.success
        ? {
            text: `Invalid input for ${declaration.name}: ${describeZodError(parsed.error)}`,
            error: "InvalidInput",
          }
        : isSubmit
          ? submitted(
              spec,
              parsed.data,
              facts.calls
                .filter(
                  (item) =>
                    item.name === submitNameOf(spec) && item.id !== call.callId,
                )
                .map((item) => item.arguments),
            )
          : own === undefined
            ? {
                text: `Tool ${declaration.name} is disconnected.`,
                error: "ToolDisconnected",
              }
            : await services.run(own.handle(parsed.data, call), call.signal);
      const endTurn = roundEnds(spec, facts, ceiling, agent.deadline);
      reminded =
        !endTurn &&
        !state.reminder &&
        facts.turns >= Math.floor(spec.turnLimit * REMINDER_SHARE);
      const line = [
        reminded ? reminderText(spec, facts.turns) : undefined,
        budgetLine(spec, facts.turns, own?.resultCap),
      ]
        .filter((line) => line !== undefined)
        .join("\n\n");
      outcome = {
        ...outcome,
        text: capResult(outcome.text, line, own?.resultCap),
        ...(endTurn ? { endTurn: true as const } : {}),
      };
      nextState = spec.state?.save() ?? null;
      services.ctx.log.write({
        type: "tool.call",
        stage: spec.stage,
        agent: spec.agent,
        tool: declaration.name,
        turn: facts.turns,
        resultBytes: Buffer.byteLength(outcome.text),
        ...(outcome.error === undefined ? {} : { error: outcome.error }),
      });
    }
    const completed = outcome;
    await store.update(async (doc, tx) => {
      doc.calls[call.callId] = {
        status: "completed",
        eligible,
        outcome: completed,
      };
      doc.toolState =
        nextState === null
          ? null
          : readData(ToolState, copyJson(nextState), {
              source: "neuve.contract-context.toolState",
            });
      if (reminded) doc.reminder = true;
      if (
        completed.endTurn === true &&
        !doc.endedMessages.includes(message.messageId)
      )
        doc.endedMessages.push(message.messageId);
      if (eligible && declaration.replay === "unsafe")
        await agent.recordExternal?.(tx);
    });
    return outcome;
  };

  const definitions: ToolDefinition[] = frozen.map((declaration) => {
    const own = [...spec.tools, agent.vent].find(
      (tool) => tool.name === declaration.name,
    );
    return {
      name: declaration.name,
      description: declaration.description,
      inputSchema: JsonSchema.parse(declaration.parameters),
      hints: own?.hints ?? RECORDS,
      strict: declaration.strict,
      handle: (_raw, call) =>
        Effect.promise(async () => {
          if (call === undefined)
            throw new Error(
              "Contract tool requires its native call id and abort signal",
            );
          let work = pending.get(call.callId);
          if (work === undefined) {
            work = apply(declaration, call);
            pending.set(call.callId, work);
          }
          return work;
        }),
    };
  });
  return {
    definitions,
    close,
    join: async () => {
      await Promise.allSettled(pending.values());
    },
  };
}
