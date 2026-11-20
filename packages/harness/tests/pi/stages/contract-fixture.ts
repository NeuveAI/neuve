import { expect } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  RuntimeUnavailable,
  TurnFailed,
  type RuntimeEvent,
  type RuntimeRegistryShape,
  type SessionPolicy,
  type TurnOutcome,
  type ToolOutcome,
} from "@neuve/runtime";
import { Effect, Exit, Queue, Scope, Stream } from "effect";
import { z } from "zod";
import {
  ClaudeRouteConfig,
  OPUS_ROUTE,
  zeroUsage,
} from "../../../src/route.ts";
import { ContractContextDoc } from "../../../src/pi/stages/docs.ts";
import { ContractState } from "../../../src/pi/stages/contract-state.ts";
import type { AgentStep } from "../../../src/pi/stages/agent.ts";
import { world } from "./fixture.ts";

export type Message = Extract<RuntimeEvent, { type: "message.finished" }>;
type Usage = Extract<RuntimeEvent, { type: "usage" }>;
export type Call = Message["toolCalls"][number];
export const call = (
  callId: string,
  toolName: string,
  input: Call["input"],
): Call => ({ callId, toolName, input });
export const submit = (id: string, answer: unknown): Call =>
  call(id, "submit_frame", z.json().parse({ answer }));
export const probe = (id: string, n: number): Call => call(id, "probe", { n });
export const usage = { ...zeroUsage, input: 12, output: 3 };
export const route = ClaudeRouteConfig.parse({
  provider: "claude",
  model: OPUS_ROUTE.model,
  effort: OPUS_ROUTE.effort,
  maxOutputTokens: OPUS_ROUTE.maxOutputTokens,
  window: OPUS_ROUTE.window,
  account: { name: "fake-claude", kind: "claude-subscription" },
  price: null,
});
const capabilities = {
  ownsLoop: true,
  toolEndsTurn: true,
  resumeInTurn: true,
  perMessageUsage: true,
  resume: true,
  fork: true,
  interrupt: true,
  modelSwitchInSession: false,
  structuredOutput: true,
  steering: false,
  approvals: false,
  perRequestTelemetry: true,
  byteExactCapture: false,
  nativeToolServer: true,
  statusProbe: false,
  internalRetries: true,
};
interface Turn {
  readonly signal: AbortSignal;
  readonly final: boolean;
  readonly turnId: string;
  readonly prompt: string;
  readonly policy: SessionPolicy;
  readonly message: (
    calls?: readonly Call[],
    options?: {
      usage?: Message["usage"];
      /** Present as undefined to send a message without its resume point. */
      resumePoint?: string | undefined;
      id?: string;
      stopReason?: Message["stopReason"];
    },
  ) => Promise<Message>;
  readonly charge: (
    amount: Usage["usage"],
    scope?: Usage["scope"],
    model?: string,
  ) => Promise<void>;
  readonly send: (event: RuntimeEvent) => Promise<void>;
  readonly endStream: () => void;
  readonly invoke: (item: Call, signal?: AbortSignal) => Promise<ToolOutcome>;
  readonly native: (id: string) => void;
}
export type Script = (turn: Turn) => Promise<TurnOutcome | void>;

export function fakeRuntime(script: Script[], stageFixture = true) {
  const turns: Turn[] = [];
  const outcomes: import("@neuve/runtime").ToolOutcome[] = [];
  let opens = 0;
  let closes = 0;
  let onClose = async () => {};
  let openError = false;
  let openDefect: unknown;
  let startError = false;
  let identity = "fake-account-identity";
  let capabilityError: import("@neuve/runtime").RuntimeError | undefined;
  let internalRetries = capabilities.internalRetries;
  let probeState: "signed-in" | "not-signed-in" | "stale" | "limited" =
    "signed-in";
  let probes = 0;
  const starts: import("@neuve/runtime").SessionStart[] = [];
  const unused = () => Effect.die(new Error("Unused fake operation"));
  const registry: RuntimeRegistryShape = {
    accountEvents: Stream.empty,
    capabilities: (account) => {
      expect(account).toBe(route.account.name);
      return capabilityError === undefined
        ? Effect.succeed({ ...capabilities, internalRetries })
        : Effect.fail(capabilityError);
    },
    continuation: () =>
      Effect.succeed({ runtime: "claude-code", key: identity }),
    probe: (name) =>
      Effect.sync(() => {
        probes++;
        return {
          name,
          kind: "claude-subscription" as const,
          signIn:
            probeState === "not-signed-in"
              ? {
                  state: "not-signed-in" as const,
                  hint: {
                    kind: "settings" as const,
                    entry: "accounts" as const,
                  },
                }
              : { state: "signed-in" as const },
          checkedAt: new Date(
            probeState === "stale" ? 0 : Date.now(),
          ).toISOString(),
          limits:
            probeState === "limited"
              ? [{ window: "five-hour" as const, status: "rejected" as const }]
              : [],
        };
      }),
    signOut: unused,
    openSession: (account, policy, start = { kind: "new" }) =>
      Effect.gen(function* () {
        expect(account).toBe(route.account.name);
        if (openDefect !== undefined) return yield* Effect.die(openDefect);
        if (openError)
          return yield* new RuntimeUnavailable({
            account: route.account.name,
            reason: "start-failed",
          });
        starts.push(start);
        expect(policy.approvalPolicy).toBe("allow");
        expect(policy.turnLimit).toBeGreaterThan(0);
        if (stageFixture)
          expect(policy.systemPrompt).toContain("SYSTEM-MARK-7f3");
        expect(policy.outputSchema).toBeDefined();
        expect(policy.model).toEqual({ id: route.model, effort: route.effort });
        if (stageFixture)
          expect(policy.tools.map((tool) => tool.name)).toEqual([
            "probe",
            "vent",
            "submit_frame",
          ]);
        const queue = yield* Queue.unbounded<
          RuntimeEvent,
          import("effect").Cause.Done
        >();
        let native =
          start.kind === "resume"
            ? start.fork
              ? `fork-${opens + 1}`
              : start.session
            : "native-open";
        let messages = 0;
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            opens++;
          }),
          () =>
            Effect.promise(async () => {
              try {
                await onClose();
              } finally {
                closes++;
                Queue.endUnsafe(queue);
              }
            }),
        );
        const finished = new Set<string>();
        const send = async (event: RuntimeEvent) => {
          if (event.type === "turn.finished") finished.add(event.turnId);
          await Effect.runPromise(Queue.offer(queue, event));
        };
        return {
          get nativeSessionId() {
            return native;
          },
          events: Stream.fromQueue(queue),
          startTurn: (input) =>
            Effect.gen(function* () {
              if (startError)
                return yield* new TurnFailed({
                  account: route.account.name,
                  reason: "provider-failed",
                });
              yield* Effect.promise(async (signal) => {
                const turn: Turn = {
                  signal,
                  turnId: input.turnId,
                  final: input.final === true,
                  prompt: String(input.message),
                  policy,
                  send,
                  endStream: () => {
                    Queue.endUnsafe(queue);
                  },
                  native: (id) => {
                    native = id;
                  },
                  message: async (calls = [], options = {}) => {
                    const message: Message = {
                      type: "message.finished",
                      turnId: input.turnId,
                      at: new Date().toISOString(),
                      messageId: options.id ?? `m${turns.length}-${++messages}`,
                      ...(Object.hasOwn(options, "resumePoint")
                        ? options.resumePoint === undefined
                          ? {}
                          : { resumePoint: options.resumePoint }
                        : { resumePoint: `point-${turns.length}` }),
                      stopReason:
                        options.stopReason ??
                        (calls.length > 0 ? "tool-use" : "end-turn"),
                      toolCalls: [...calls],
                      ...(Object.hasOwn(options, "usage")
                        ? options.usage === undefined
                          ? {}
                          : { usage: options.usage }
                        : { usage }),
                    };
                    await send(message);
                    return message;
                  },
                  charge: (amount, scope = "turn", model) =>
                    send({
                      type: "usage",
                      turnId: input.turnId,
                      at: new Date().toISOString(),
                      usage: amount,
                      scope,
                      costUsd: null,
                      ...(model === undefined ? {} : { model }),
                    }),
                  invoke: async (
                    item,
                    signal = new AbortController().signal,
                  ) => {
                    const tool = policy.tools.find(
                      (tool) => tool.name === item.toolName,
                    );
                    if (tool === undefined) throw new Error("Tool not offered");
                    const result = await Effect.runPromise(
                      tool.handle(item.input, { callId: item.callId, signal }),
                    );
                    outcomes.push(result);
                    return result;
                  },
                };
                turns.push(turn);
                await send({
                  type: "turn.started",
                  turnId: input.turnId,
                  at: new Date().toISOString(),
                });
                const next = script.shift();
                if (next === undefined)
                  throw new Error("Fake has no next turn");
                const outcome = (await next(turn)) ?? { status: "completed" };
                if (!finished.has(input.turnId))
                  await send({
                    type: "turn.finished",
                    turnId: input.turnId,
                    at: new Date().toISOString(),
                    outcome,
                    resumePoint: `carrier-${turns.length}`,
                  });
              });
            }),
          steerTurn: unused,
          interruptTurn: unused,
          setModel: unused,
          respondToApproval: unused,
        };
      }),
  };
  return {
    registry,
    starts,
    setIdentity: (key: string) => {
      identity = key;
    },
    capabilityError: (error?: import("@neuve/runtime").RuntimeError) => {
      capabilityError = error;
    },
    internalRetries: (enabled: boolean) => {
      internalRetries = enabled;
    },
    probeState: (state: typeof probeState) => {
      probeState = state;
    },
    probes: () => probes,
    turns,
    outcomes,
    onClose: (read: () => Promise<void>) => {
      onClose = read;
    },
    opens: () => opens,
    closes: () => closes,
    openError: (enabled = true) => {
      openError = enabled;
    },
    openDefect: (error: unknown) => {
      openDefect = error;
    },
    startError: (enabled = true) => {
      startError = enabled;
    },
  };
}

export async function setup(
  name: string,
  script: Script[],
  options: {
    capture?: import("../../../src/pi/capture/types.ts").Capture;
    onClose?: import("../../../src/pi/storage.ts").ExportOnClose<void>;
    limit?: number;
    sessions?: import("../../../src/pi/stages/services.ts").StageServices["contractSessions"];
    beforeCommit?: (
      port: import("../../../src/pi/stages/contract-step.ts").ContractPort,
    ) => Promise<void>;
    afterCommit?: (
      port: import("../../../src/pi/stages/contract-step.ts").ContractPort,
    ) => Promise<void>;
    retries?: number;
    configure?: (
      step: AgentStep<unknown, unknown>,
    ) => AgentStep<unknown, unknown>;
  } = {},
) {
  const fake = fakeRuntime(script);
  const run = await world(
    `contract-${name}`,
    options.limit ?? 6,
    false,
    false,
    "faux",
    undefined,
    false,
    undefined,
    {
      ...(options.capture === undefined ? {} : { capture: options.capture }),
      ...(options.onClose === undefined ? {} : { onClose: options.onClose }),
      runtimes: fake.registry,
      sessions: options.sessions,
      ...(options.beforeCommit === undefined
        ? {}
        : { beforeCommit: options.beforeCommit }),
      ...(options.afterCommit === undefined
        ? {}
        : { afterCommit: options.afterCommit }),
      configure: (step) =>
        options.configure?.({
          ...step,
          spec: { ...step.spec, retries: options.retries },
        }) ?? { ...step, spec: { ...step.spec, retries: options.retries } },
    },
  );
  run.ctx.config.route = route;
  let opened = await run.open();
  let taskId: Awaited<ReturnType<typeof run.start>> | undefined;
  let closedState: ContractState | undefined;
  // pi retires task documents at terminal settlement. Observe the real document at session close, before retirement.
  fake.onClose(async () => {
    if (taskId !== undefined)
      try {
        const snapshot = await opened.harness.snapshot(
          ContractContextDoc,
          taskId,
          context,
        );
        if (snapshot?.data != null)
          closedState = ContractState.parse(snapshot.data);
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("clos"))
          throw error;
      }
  });
  const begin = async (cutoff?: number, deadline?: number) => {
    taskId = await run.start(opened, cutoff, deadline);
    await opened.harness.resume();
    return taskId;
  };
  return {
    run,
    fake,
    get opened() {
      return opened;
    },
    reopen: async () => {
      opened = await run.open();
      closedState = undefined;
      await opened.harness.resume();
    },
    begin,
    start: async (cutoff?: number, deadline?: number) => {
      const id = await begin(cutoff, deadline);
      return (await opened.harness.waitForTask(id, context)).state.outcome;
    },
    state: async () => {
      if (taskId === undefined) throw new Error("Not started");
      return (
        await opened.harness.snapshot(ContractContextDoc, taskId, context)
      )?.data == null
        ? (closedState ??
            (() => {
              throw new Error("No saved state");
            })())
        : ContractState.parse(
            (await opened.harness.snapshot(ContractContextDoc, taskId, context))
              ?.data,
          );
    },
    close: async () => {
      await opened.harness.close(context);
      await Effect.runPromise(Scope.close(run.scope, Exit.succeed(undefined)));
    },
  };
}

export async function waitHeld(
  harness: import("@earendil-works/pi-durable").Harness,
) {
  const { RunControlDoc } = await import("../../../src/pi/control.ts");
  await harness.commit(async (tx) => {
    await tx.doc(RunControlDoc);
  }, context);
  const watch = await harness.watchDoc(RunControlDoc, context);
  if (watch === undefined) throw new Error("No run control");
  try {
    return await new Promise<
      import("../../../src/pi/control.ts").ContractHeldStep
    >((resolve) => {
      const observe = (value: typeof watch.value) => {
        const held = Object.values(value?.held ?? {}).find(
          (step) => step.engine === "contract",
        );
        if (held?.engine === "contract") resolve(held);
      };
      observe(watch.value);
      watch.start(async (value) => observe(value));
    });
  } finally {
    await watch.stop();
  }
}
