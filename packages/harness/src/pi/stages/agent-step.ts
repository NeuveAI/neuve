import { accountReadRefused } from "@neuve/runtime";
import { safeRead } from "@neuve/records-schema";
import { readData } from "@neuve/records-core";
import { randomUUID } from "node:crypto";
import { scopedLogSpan } from "../../log-span.ts";
import {
  cutoffReached,
  cutoffNotes,
  stageStartPolicy,
} from "../../stage-policy.ts";
import {
  definePolicyTask as defineTask,
  runtimeFailurePolicy,
  contractHoldNeedsNewerBuild,
  heldFailure,
  isAccountFailure,
} from "../failure-policy.ts";
import { copyJson, type Context, type JsonValue } from "@earendil-works/chord";
import { withCancel } from "@earendil-works/chord/context";
import { isContextOverflow } from "@earendil-works/pi-ai";
import {
  configure,
  type ConversationId,
  type DocumentReader,
  type Extension,
  type SettledSubmissionRecord,
  type SubmissionId,
  type Task,
  type TaskId,
  type TaskRuntime,
  type UserInput,
} from "@earendil-works/pi-durable";
import { Effect, Metric, Option } from "effect";
import { z } from "zod";
import { Computations } from "@neuve/records-core";
import {
  JsonSchema,
  RuntimeFailure,
  runtimeErrorToFailure,
  runtimeFailureToError,
} from "@neuve/runtime";
import {
  MAX_CONTINUATIONS,
  MAX_INVALID_SUBMISSIONS,
  estimateTokens,
} from "../../budget.ts";
import { dropAddedNulls } from "../providers/wire.ts";
import {
  AgentStored,
  agentStageSpec,
  needsModel,
  recordStage,
  recordStageStart,
  storedBytes,
  withRecords,
  type ContextFigures,
  type StageRecord,
} from "../../pipeline.ts";
import { StepName } from "../../reader-text.ts";
import {
  costOf,
  routeAccount,
  routeAtEffort,
  stepEffortOf,
  storedUsage,
  zeroUsage,
  routeRuntimeError,
  type AnyRouteConfig,
  type RouteAccount,
} from "../../route.ts";
import { METRICS } from "../../telemetry.ts";
import { wireSchema } from "../../toolkit.ts";
import {
  routeFailureOfSubmission,
  type RouteFailure,
} from "../providers/failure.ts";
import {
  awaitResume,
  RunControlDoc,
  enterHeld,
  enterContractHeld,
  type ContractHeldStep,
  holds,
  leaveHeld,
  resumeSubmission,
} from "../control.ts";
import {
  answerText,
  assistantOf,
  continueText,
  finalText,
  isRefusal,
  MARK,
  outcomeOf,
  refusedText,
  scanSubmissions,
  submissionOfError,
  submitNameOf,
  transcriptFacts,
  type AgentResult,
  type AgentStep,
  type EndedBy,
  type SubmissionOutcome,
} from "./agent.ts";
import {
  AgentContextDoc,
  ContractContextDoc,
  ContractPartialsDoc,
  AgentKind,
  RunToolsDoc,
  ToolState,
  type ToolDeclaration,
} from "./docs.ts";
import type { StageServices } from "./services.ts";
import {
  compareDeclarations,
  offeredTools,
  parseOutput,
  submissionOf,
  submitShape,
  wireTool,
  type ResolvedAgent,
} from "./tools.ts";

import {
  ContractRecoveryFailed,
  physicalTurnId,
  retryContractRound,
} from "./contract-recovery.ts";
import { contractStep } from "./contract-step.ts";
import {
  INTERRUPTED,
  stepClaims,
  type ClaimEnd,
  type StepClaims,
} from "./step-claim.ts";
import {
  ContractState,
  contractFacts,
  contractStore,
  ContractWriteRefused,
  preserveContractState,
} from "./contract-state.ts";

export { RouteRuntimeMismatch } from "../../route.ts";

/** Check provider agreement before selecting the stage's generation path. */
export const stageRouteError = (route: AnyRouteConfig, ownsLoop: boolean) =>
  routeRuntimeError(route, ownsLoop);

/**
 * One agent context of a review stage as a native pi task (0014). It keys the step and reuses a
 * stored output without a model call; otherwise it creates a conversation it owns, binds the
 * conversation's route (the runtime's `bindAgentRoute`), selects its kind's extension and tools,
 * and submits the task. pi's generation and tool tasks run every model call and tool call. Between
 * pi's runs this task applies the context's bounded policy, unchanged (§3.4, 10.11, 10.42):
 *
 * - a run that ends in text gets the open items, at most three times;
 * - an accepted submission ends the context; more than two failed ones end it with code's repair,
 *   else the backstop;
 * - the turn limit, the context ceiling, an overflow or the open items used up lead to the final
 *   generation: final mode is committed through the runtime's `prepareFinalGeneration` (the route
 *   then sends `tool_choice: none` with the output schema, tools still offered), and the existing
 *   final prompt is submitted unchanged; an answer that fails gets the refusal, at most twice;
 * - a model call the provider could not answer holds the step (`control.ts`): its task and its
 *   conversation stay until the runtime resumes the job, which sends the same request again;
 *   a spec with `unanswered: "fail"` ends failed instead, unless the account failed (`isAccountFailure`);
 * - the run's cut-off aborts the conversation, which keeps what pi committed, and the step keeps
 *   its partial output for this run only.
 *
 * The output is stored under the step's computation key, as before, and the stage record is
 * disclosed in Records (`recordStage`).
 */

export const AgentStepInput = z.strictObject({
  kind: AgentKind,
  /** The kind's own parameters, parsed when the step is prepared (run.ts). */
  params: z.json(),
  /** The run's cut-off (10.42): durable, so a resumed step stops at the same time. */
  cutoffAt: z.number(),
  deadline: z.number().optional(),
});
export type AgentStepInput = {
  readonly kind: AgentKind;
  readonly params: JsonValue;
  readonly cutoffAt: number;
  readonly deadline?: number | undefined;
};

/** The step's estimate of its first request (UN9) and the route's count of it, where it counts. */
type Estimate = { readonly estimated: number; readonly counted: number | null };

type Running = {
  readonly engine?: undefined;
  readonly startedAt: number;
  readonly conversationId: number;
  readonly estimate: Estimate | null;
  /** Turns the conversation held when this process first took the step up again. */
  readonly resumedTurns: number;
};

type ContractRunning = {
  readonly engine: "contract";
  readonly startedAt: number;
  readonly estimate: Estimate | null;
  readonly resumedTurns: number;
  readonly conversationId?: undefined;
};

type ContractCheckpoint = ContractRunning & {
  readonly phase: "contract";
  readonly account: RouteAccount["name"];
  readonly opening?: boolean;
  readonly internalRetries?: boolean;
};

/** The submission the context is answering: its request ID and input, to find it again. */
type Asking = {
  readonly request: string;
  readonly content: UserInput;
};

type RunningCheckpoint = Running &
  Asking & { readonly phase: "running"; readonly continuations: number };
type FinalCheckpoint = Running &
  Asking & {
    readonly phase: "final";
    readonly endedBy: EndedBy;
    readonly refusals: number;
    /** What each refusal sent answered; absent in a checkpoint an older build stored. */
    readonly refused?: ReadonlyArray<SubmissionOutcome>;
  };

export type AgentStepCheckpoint =
  | { readonly phase: "start" }
  | {
      readonly phase: "stub-hold";
      readonly startedAt: number;
      readonly until: number;
    }
  | {
      readonly phase: "bind";
      readonly startedAt: number;
      readonly conversationId: number;
      readonly estimate: Estimate | null;
    }
  | ContractCheckpoint
  | {
      readonly phase: "provider-held";
      readonly engine: "contract";
      readonly from: ContractCheckpoint;
      readonly held: ContractHeldStep;
      readonly failure: RuntimeFailure;
    }
  | RunningCheckpoint
  | FinalCheckpoint
  | {
      /** Held for the provider (`control.ts`): `from` is the phase it resumes in, final mode kept. */
      readonly phase: "provider-held";
      readonly engine?: undefined;
      readonly from: RunningCheckpoint | FinalCheckpoint;
      readonly failedSubmissionId: number;
      /** Why the provider did not answer, as the route recorded it on the failed turn. */
      readonly failure: RouteFailure | null;
    };

/** What interrupted a step: the run's cut-off, or its owner's abort before it. */
type Interruption = "cutoff" | "aborted";

type Runtime = TaskRuntime<
  AgentStepInput,
  AgentStepCheckpoint,
  StageRecord,
  object
>;
type Step = AgentStep<unknown, unknown>;

/** What the agent step task needs of its run. */
export interface AgentStepHost {
  readonly services: StageServices;
  /**
   * The agent a step task runs, prepared once per process from its durable input (run.ts). `read`
   * reads the run's committed documents.
   */
  readonly prepare: (
    taskId: TaskId,
    input: AgentStepInput,
    read: DocumentReader,
    context: Context,
  ) => Promise<ResolvedAgent>;
  /** Installs a kind's extension from its frozen declarations (once per process) and returns it. */
  readonly install: (
    kind: AgentKind,
    declarations: ReadonlyArray<ToolDeclaration>,
  ) => Extension;
  /** The steps' claims, shared with the kinds' extensions, whose requests wait on them. */
  readonly claims?: StepClaims;
}

export const AGENT_STEP = "neuve.agent-step";

export const agentStepTask = (
  host: AgentStepHost,
): Task<AgentStepInput, AgentStepCheckpoint, StageRecord, object> => {
  const { services } = host;
  const { ctx } = services;
  /** Steps this process started or took up again: the others resume turns a crash left. */
  const taken = new Set<number>();
  /**
   * Each step's claim on its key (record 0016): the conversation runs inside the `compute` of the
   * step's own `store.run`, so one run per key calls the model and every other caller subscribes.
   */
  const claims =
    host.claims ??
    stepClaims((effect, signal) =>
      services.run(withRecords(ctx, effect), signal),
    );
  /**
   * Ends the task's claim, recorded for its waiters. Recording can fail (a store error, an attempt
   * a starting worker abandoned); that is logged and never replaces the step's own outcome.
   */
  const endClaim = async (taskId: number, ending: ClaimEnd) => {
    try {
      await claims.fail(taskId, ending);
    } catch (error) {
      ctx.log.write({
        type: "claim.end-failed",
        taskId,
        tag: ending.tag,
        message: (error instanceof Error ? error.message : String(error)).slice(
          0,
          500,
        ),
      });
    }
  };

  const prepared = async (
    task: { readonly id: TaskId; readonly input: AgentStepInput },
    runtime: Runtime,
    context: Context,
  ) => host.prepare(task.id, task.input, runtime, context);

  const keyOf = (step: Step) =>
    agentStageSpec(ctx.config, step.spec, {
      op: step.op,
      opVersion: step.opVersion,
      inputs: step.inputs,
    });

  const scopeOf = (step: Step, taskId: TaskId, conversationId?: number) => ({
    runId: ctx.runId,
    stage: step.spec.stage,
    agent: step.spec.agent,
    taskId,
    ...(conversationId === undefined ? {} : { conversationId }),
  });

  /** The record's last writes: the run log, Records (`recordStage`) and the stage's duration. */
  const finalize = async (record: StageRecord, runtime: Runtime) => {
    ctx.log.write({ type: "stage", ...record });
    const lens =
      record.stage === "find" || record.stage === "verify"
        ? record.agent?.split(".")[1]
        : undefined;
    if (
      ctx.log.telemetryEnabled !== false &&
      !ctx.log
        .read()
        .some(
          (entry) =>
            entry.type === "span" && entry["taskId"] === runtime.taskId,
        )
    )
      ctx.log.write({
        type: "span",
        taskId: runtime.taskId,
        name: `harness.stage.${record.stage}`,
        spanId: randomUUID(),
        start: new Date(Date.now() - record.wallMs).toISOString(),
        durationMs: record.wallMs,
        attributes: {
          "harness.stage": record.stage,
          "harness.agent": record.agent ?? record.stage,
          ...(lens === undefined ? {} : { "harness.batch": lens }),
        },
        status: record.status,
      });
    await services.run(
      Effect.gen(function* () {
        yield* recordStage(ctx, record);
        yield* Metric.update(
          Metric.withAttributes(METRICS.stageDuration, {
            "harness.stage": record.stage,
            "harness.status": record.status,
          }),
          record.wallMs / 1_000,
        );
      }),
      runtime.signal,
    );
  };

  const lookup = (step: Step, signal: AbortSignal) =>
    services.run(
      withRecords(
        ctx,
        Effect.gen(function* () {
          const store = yield* Computations.ComputationStore;
          return Option.getOrUndefined(
            yield* store.lookup(Computations.computationKey(keyOf(step)).key),
          );
        }),
      ),
      signal,
    );

  /** A stored step's record: what the context stored and how the step ended. */
  const recordOf = (
    step: Step,
    status: StageRecord["status"],
    key: string,
    stored: z.infer<typeof AgentStored>,
    wallMs: number,
  ): StageRecord => {
    const output = safeRead(step.schema, stored.output);
    const summary = StoredSummary.safeParse(stored.summary);
    const context = StoredContext.safeParse(stored.context);
    return {
      stage: step.spec.stage,
      agent: step.spec.agent,
      status,
      key,
      wallMs,
      ...(summary.success ? { agentResult: summary.data } : {}),
      ...(step.note === undefined || !output.success
        ? {}
        : {
            note: step.note(
              output.data,
              context.success ? context.data : undefined,
            ),
          }),
    };
  };

  /** Reads a stored step's output and summary back. */
  const readStored = (key: string, signal: AbortSignal) =>
    services.run(
      Effect.map(storedBytes(ctx, key), (bytes) =>
        readData(AgentStored, JSON.parse(new TextDecoder().decode(bytes))),
      ),
      signal,
    );

  /** The conversation's facts and its tools' state, as committed. */
  const conversationOf = async (
    runtime: Runtime,
    conversationId: number,
    context: Context,
  ) => {
    const view = await runtime.context(
      conversationId as ConversationId,
      context,
    );
    const doc = await runtime.snapshot(
      AgentContextDoc,
      conversationId as ConversationId,
      context,
    );
    const stored = doc === undefined ? null : copyJson(doc.state);
    return {
      facts: transcriptFacts(view.entries),
      state: stored === null ? undefined : readData(ToolState, stored),
      applied: doc?.applied ?? {},
    };
  };

  const contractConversationOf = async (runtime: Runtime, context: Context) => {
    const snapshot = await runtime.snapshot(
      ContractContextDoc,
      runtime.taskId,
      context,
    );
    if (snapshot?.data == null)
      return {
        facts: transcriptFacts({
          engine: "contract",
          messages: [],
          usage: zeroUsage,
          eligibleCalls: new Set(),
        }),
        state: undefined,
        doc: undefined,
      };
    const doc = await contractStore(runtime, context).read();
    return {
      facts: contractFacts(doc),
      state: doc.toolState ?? undefined,
      doc,
    };
  };

  /** The step's estimate of its first request (UN9, 10.35), with the route's count where it has one. */
  const estimate = async (
    agent: ResolvedAgent,
    signal: AbortSignal,
  ): Promise<Estimate> => {
    const { step } = agent;
    const tools = [...step.spec.tools, agent.vent, submitShape(step.spec)].map(
      (spec) => {
        const tool = wireTool(spec);
        return {
          name: tool.name,
          description: tool.description,
          input_schema: { ...tool.parameters },
        };
      },
    );
    const label = `${step.spec.agent}.initial-context`;
    const bytes = new TextEncoder().encode(
      step.spec.system + step.spec.task + JSON.stringify(tools),
    ).length;
    const estimated = estimateTokens(bytes);
    // A count that fails leaves the estimate uncounted, as before.
    const counted =
      services.countTokens === undefined
        ? null
        : await services
            .countTokens(
              { label, system: step.spec.system, user: step.spec.task, tools },
              signal,
            )
            .catch(() => null);
    ctx.log.write({
      type: "estimate",
      label,
      bytes,
      estimate: estimated,
      counted,
      ...(counted === null || counted === 0
        ? {}
        : {
            ratio: Number((estimated / counted).toFixed(3)),
            bytesPerToken: Number((bytes / counted).toFixed(3)),
          }),
    });
    return { estimated, counted };
  };

  /**
   * The context's result and its stored output: the summary in the run log, the output stored
   * under the step's key with its usage, then the stage record.
   */
  const finish = async (
    runtime: Runtime,
    step: Step,
    at: Running | ContractRunning,
    ending: {
      readonly status: AgentResult<unknown>["status"];
      readonly endedBy: EndedBy;
      readonly output: unknown;
      readonly repairedFrom?: unknown;
      readonly finalGeneration: boolean;
      /** What the final phase answered to the final answer the step ends on. */
      readonly answered?: SubmissionOutcome | undefined;
    },
    context: Context,
  ) => {
    const conversation =
      at.engine === "contract"
        ? await contractConversationOf(runtime, context)
        : await conversationOf(runtime, at.conversationId, context);
    const { facts, state } = conversation;
    // The tools' state as the context left it, for the backstop, the partial and the composition.
    step.spec.state?.load(state, facts.turns);
    // What the step answered at the time, as recorded with each answer: each call of the submit
    // tool, then each final answer it refused and the one it ended on.
    const answers =
      "applied" in conversation
        ? [
            ...submitLabels(
              step,
              conversation.facts.calls,
              (id) => conversation.applied[id]?.submission,
            ),
            ...((at as Running & Pick<Partial<FinalCheckpoint>, "refused">)
              .refused ?? []),
            ...(ending.answered === undefined ? [] : [ending.answered]),
          ]
        : [
            ...submitLabels(step, conversation.facts.calls, (id) => {
              const call = conversation.doc?.calls[id];
              return call?.status === "completed"
                ? submissionOfError(call.outcome.error)
                : undefined;
            }),
            ...contractFinalOutcomes(
              step,
              conversation.doc,
              ending.status !== "interrupted" && ending.finalGeneration,
            ),
          ];
    const output = ending.output;
    const result: AgentResult<unknown> = {
      agent: step.spec.agent,
      stage: step.spec.stage,
      status: ending.status,
      output,
      endedBy: ending.endedBy,
      turnsUsed: facts.turns,
      turnLimit: step.spec.turnLimit,
      finalGeneration: ending.finalGeneration,
      usage: facts.usage,
      costUsd:
        at.engine === "contract" ? null : costOf(ctx.config.route, facts.usage),
      resumedTurns: at.resumedTurns,
      restarted: false,
      modelCalls: facts.turns,
      ...(ending.repairedFrom === undefined || output === undefined
        ? {}
        : { repairedFrom: ending.repairedFrom }),
      ...(facts.firstInput === undefined
        ? {}
        : { context: { firstCall: facts.firstInput, peak: facts.peakInput } }),
      submissions: answers,
    };
    const {
      output: _output,
      repairedFrom: _repairedFrom,
      submissions: _submissions,
      ...summary
    } = result;
    ctx.log.write({ type: "agent", ...summary });
    const figures: ContextFigures = {
      planned: step.planned,
      ...(at.estimate === null
        ? {}
        : { estimated: at.estimate.estimated, counted: at.estimate.counted }),
      firstCall: result.context?.firstCall,
      peak: result.context?.peak,
    };
    ctx.log.write({ type: "context", agent: step.spec.agent, ...figures });
    if (ending.status === "interrupted")
      return { result, summary, figures, record: undefined };
    const hold = ctx.config.stub?.hold;
    if (hold?.at === "before-commit" && hold.stage === step.spec.stage) {
      ctx.log.write({
        type: "progress",
        message: `${step.spec.agent}: output ready; holding ${hold.seconds} s before the store commits it (stub setting)`,
      });
      await runtime.sleep(runtime.now() + hold.seconds * 1_000, context);
    }
    const composed = step.compose(result);
    // The claim's `compute` publishes the output under the step's key and wakes its waiters.
    const stored = await claims.settle(runtime.taskId, {
      bytes: new TextEncoder().encode(
        JSON.stringify({
          output: composed,
          summary,
          context: figures,
        }),
      ),
      mediaType: "application/json",
      usage: storedUsage(result.usage),
      model: ctx.config.route.model,
    });
    const held = readData(
      AgentStored,
      JSON.parse(new TextDecoder().decode(stored.output)),
    );
    const record = recordOf(
      step,
      stored.status === "computed" ? "computed" : "reused",
      stored.computation.key,
      held,
      runtime.now() - at.startedAt,
    );
    return { result, summary, figures, record };
  };

  /**
   * Ends the step with its record: completed, or aborted with an interrupted record. `cause` says
   * what interrupted it: the run's cut-off (10.42), or its owner's abort before the cut-off (the
   * attempt's deadline, the run stopped, a sibling's failure), which captures and the task's
   * outcome name as such; the record's status is `interrupted` either way.
   */
  const end = async (
    runtime: Runtime,
    step: Step,
    record: StageRecord,
    context: Context,
    conversationId?: number,
    cause: Interruption = "cutoff",
  ) => {
    await finalize(record, runtime);
    services.capture({
      type: "stage.end",
      scope: scopeOf(step, runtime.taskId, conversationId),
      status:
        record.status === "interrupted"
          ? cause
          : record.status === "skipped"
            ? "cutoff"
            : "completed",
      ...(record.note === undefined ? {} : { reason: record.note }),
    });
    const contract =
      conversationId === undefined
        ? await runtime.snapshot(ContractContextDoc, runtime.taskId, context)
        : undefined;
    await contractWrite(
      runtime,
      async (tx) => {
        if (contract?.data != null) {
          const state = readData(ContractState, contract.data, {
            source: "neuve.contract-context",
          });
          const round = state.rounds.at(-1);
          if (record.status === "interrupted" && round?.dispatched) {
            state.settlements[physicalTurnId(round)] ??= round.outcome ?? {
              status: "interrupted",
            };
            for (const [id, call] of Object.entries(state.calls))
              if (call.status === "observed")
                state.calls[id] = { status: "cancelled", eligible: false };
          }
          (await tx.doc(ContractPartialsDoc)).contexts[String(runtime.taskId)] =
            copyJson(
              preserveContractState(
                copyJson(
                  (await tx.doc(ContractContextDoc, runtime.taskId)).data,
                ),
                state,
              ),
            );
        }
        await leaveHeld(tx, runtime.taskId);
        return record.status === "interrupted"
          ? {
              status: "terminal",
              outcome: { status: "aborted", reason: cause, result: record },
            }
          : {
              status: "terminal",
              outcome: { status: "completed", result: record },
            };
      },
      context,
    );
  };

  const fail = async (
    runtime: Runtime,
    step: Step,
    error: {
      readonly tag: string;
      readonly message: string;
      readonly retryable: boolean;
      readonly failure?: RouteFailure | undefined;
      readonly reason?: string | undefined;
    },
    context: Context,
    conversationId?: number,
    partial?: ContractState,
  ) => {
    // The work failed: waiters get this failure with the step's own retryability.
    await endClaim(runtime.taskId, {
      tag: error.tag,
      message: error.message,
      retryable: error.retryable,
    });
    services.capture({
      type: "stage.end",
      scope: scopeOf(step, runtime.taskId, conversationId),
      status: "failed",
      reason: `${error.tag}: ${error.message}`.slice(0, 500),
    });
    await contractWrite(
      runtime,
      async (tx) => {
        if (partial !== undefined) {
          const stored = (await tx.doc(ContractContextDoc, runtime.taskId))
            .data;
          (await tx.doc(ContractPartialsDoc)).contexts[String(runtime.taskId)] =
            copyJson(preserveContractState(copyJson(stored), partial));
        }
        await leaveHeld(tx, runtime.taskId);
        return {
          status: "terminal",
          outcome: {
            status: "failed",
            error: {
              message: `${error.tag}: ${error.message}`,
              detail: copyJson(error),
            },
          },
        };
      },
      context,
    );
  };

  const failContract = async (
    runtime: Runtime,
    step: Step,
    error: Parameters<typeof fail>[2],
    context: Context,
  ) => {
    const snapshot = await runtime.snapshot(
      ContractContextDoc,
      runtime.taskId,
      context,
    );
    return fail(
      runtime,
      step,
      error,
      context,
      undefined,
      snapshot?.data == null
        ? undefined
        : readData(ContractState, snapshot.data, {
            source: "neuve.contract-context",
          }),
    );
  };

  /**
   * The run's cut-off (10.42), or its owner's abort, reached a running context: pi aborts the
   * conversation, which keeps every committed turn and turns an answer in flight into an aborted
   * entry; what the context recorded is kept for this run only, disclosed.
   */
  const interrupted = async (
    runtime: Runtime,
    step: Step,
    at: Running | ContractRunning,
    context: Context,
    cause: Interruption = "cutoff",
  ) => {
    const why =
      cause === "cutoff"
        ? "interrupted at the run's cut-off (10.42)"
        : "interrupted before the run's cut-off: its run was stopped";
    const disclosure =
      cause === "cutoff"
        ? {}
        : {
            disclosure: `${StepName(step.spec.stage, step.spec.agent)} was stopped before it finished, so its part of the review is incomplete.`,
          };
    if (at.engine !== "contract") {
      const conversation = await runtime.conversation(
        at.conversationId as ConversationId,
        context,
      );
      await conversation?.abort(context);
    }
    // Released only once the conversation is aborted, so no new holder starts beside its call.
    await endClaim(runtime.taskId, {
      tag: INTERRUPTED,
      message: why,
      retryable: true,
      released: true,
    });
    const { result, summary, figures } = await finish(
      runtime,
      step,
      at,
      {
        status: "interrupted",
        endedBy: "timeout",
        output: undefined,
        finalGeneration: false,
      },
      context,
    );
    const wallMs = runtime.now() - at.startedAt;
    if (step.partial === undefined)
      return end(
        runtime,
        step,
        {
          stage: step.spec.stage,
          agent: step.spec.agent,
          status: "interrupted",
          wallMs,
          agentResult: summary,
          note: `${why}; its partial work is not stored as an output`,
          ...disclosure,
        },
        context,
        at.conversationId,
        cause,
      );
    const partial = step.partial({
      ...summary,
      submissions: result.submissions,
    });
    const kept = await services.run(
      withRecords(
        ctx,
        Effect.gen(function* () {
          const store = yield* Computations.ComputationStore;
          return yield* store.run(
            {
              op: `${step.op}.partial`,
              opVersion: step.opVersion,
              inputs: { run: ctx.runId, agent: step.spec.agent },
            },
            Effect.succeed({
              bytes: new TextEncoder().encode(
                JSON.stringify({ output: partial, summary, context: figures }),
              ),
              mediaType: "application/json",
            }),
          );
        }),
      ),
      runtime.signal,
    );
    return end(
      runtime,
      step,
      {
        ...recordOf(
          step,
          "interrupted",
          kept.computation.key,
          { output: partial, summary, context: figures },
          wallMs,
        ),
        note: `${why}; what it recorded is kept for this run only (computation ${kept.computation.key.slice(0, 12)}), disclosed`,
        ...disclosure,
      },
      context,
      at.conversationId,
      cause,
    );
  };

  /**
   * Submits `content` once under `request` (a resumed step finds the same submission) and waits for
   * the run it starts, until the run's cut-off.
   */
  const answered = async (
    runtime: Runtime,
    at: Asking & { readonly conversationId: number },
    cutoffAt: number,
    context: Context,
  ): Promise<SettledSubmissionRecord | "cutoff"> => {
    const conversation = await runtime.conversation(
      at.conversationId as ConversationId,
      context,
    );
    if (conversation === undefined)
      throw new Error(`conversation ${at.conversationId} is gone`);
    const submission = await conversation.submit(
      { type: "input", content: at.content, requestId: at.request },
      context,
    );
    const left = cutoffAt - runtime.now();
    if (left <= 0) {
      const now = await submission.status(context);
      if (now.status === "done" || now.status === "unanswered") return now;
      return "cutoff";
    }
    const deadline = withCancel(context);
    const timer = setTimeout(() => deadline.cancel("cutoff"), left);
    try {
      return await submission.wait(deadline.context);
    } catch (error) {
      if (runtime.now() >= cutoffAt && runtime.signal.aborted === false)
        return "cutoff";
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };

  /** What the context's submissions amount to, read from its transcript as its submit tool read them. */
  const submissions = (
    step: Step,
    calls: ReturnType<typeof transcriptFacts>["calls"],
  ) =>
    scanSubmissions(
      calls
        .filter((call) => call.name === submitNameOf(step.spec))
        .map((call) => call.arguments),
      submissionOf(step.spec),
      step.spec.advise,
    );

  /** The newest schema-valid output repaired by code, when it then passes its checks. */
  const repaired = (step: Step, data: unknown) => {
    if (data === undefined || step.spec.repair === undefined) return undefined;
    const fixed = step.spec.repair(data);
    return ((step.spec.checkRepaired ?? step.spec.check)?.(fixed) ?? [])
      .length === 0
      ? fixed
      : undefined;
  };

  /** Moves to the final generation, unless the cut-off already passed. */
  const toFinal = async (
    runtime: Runtime,
    step: Step,
    at: Running,
    endedBy: EndedBy,
    cutoffAt: number,
    context: Context,
  ) => {
    if (runtime.now() >= cutoffAt)
      return interrupted(runtime, step, at, context);
    // Final mode is committed before the prompt is submitted, so the request that answers it is
    // the final generation: `tool_choice: none` and the output schema, tools still offered.
    await services.routes.prepareFinalGeneration(
      {
        conversationId: at.conversationId as ConversationId,
        schema: finalSchema(step),
      },
      context,
    );
    await runtime.commit(async (tx) => {
      (
        await tx.doc(AgentContextDoc, at.conversationId as ConversationId)
      ).final = true;
      return {
        status: "running",
        checkpoint: {
          phase: "final",
          startedAt: at.startedAt,
          conversationId: at.conversationId,
          estimate: at.estimate,
          resumedTurns: at.resumedTurns,
          endedBy,
          refusals: 0,
          request: "final",
          content: finalText(endedBy),
        },
      };
    }, context);
  };

  /** Whether the conversation's newest tool round was ended by the stage's policy (`endRound`). */
  const stoppedRound = async (
    runtime: Runtime,
    conversationId: number,
    context: Context,
  ) => {
    const doc = await runtime.snapshot(
      AgentContextDoc,
      conversationId as ConversationId,
      context,
    );
    if (doc?.stopped == null) return false;
    const view = await runtime.context(
      conversationId as ConversationId,
      context,
    );
    const newest = view.entries.findLast(
      (entry) => assistantOf(entry) !== undefined,
    );
    return newest !== undefined && newest.id <= doc.stopped.assistant;
  };

  /**
   * Why an unanswered submission's model call failed, as the route recorded it on the failed turn
   * (`providers/failure.ts`), read from pi's stored entries of the conversation.
   */
  const failureOf = async (
    runtime: Runtime,
    conversationId: number,
    settled: SettledSubmissionRecord,
    context: Context,
  ) => {
    const view = await runtime.context(
      conversationId as ConversationId,
      context,
    );
    return routeFailureOfSubmission(
      {
        entries: async (query) => ({
          items: view.entries
            .filter(
              (entry) =>
                query.minEntryId === undefined || entry.id >= query.minEntryId,
            )
            .reverse(),
        }),
      },
      settled,
      context,
    );
  };

  /**
   * A model call the provider could not answer (`model_error`, past pi's retries): the step holds,
   * keeping its task, its conversation and its route's mode, until the runtime resumes the job.
   * The hold may last hours, so it releases its claim (no verdict on the work): its waiters claim
   * again, and the resumed phase claims again.
   */
  const hold = async (
    runtime: Runtime,
    at: RunningCheckpoint | FinalCheckpoint,
    settled: SettledSubmissionRecord,
    failure: RouteFailure | undefined,
    context: Context,
  ) => {
    const held = heldFailure([
      {
        failure:
          failure === undefined
            ? null
            : { kind: failure.kind, status: null, code: null },
      },
    ]);
    await endClaim(runtime.taskId, {
      tag: held.tag,
      message: `held for the provider: ${settled.reason}`,
      retryable: held.retryable,
      released: true,
    });
    return runtime.commit(async (tx) => {
      await enterHeld(tx, runtime.taskId, {
        conversationId: at.conversationId as ConversationId,
        settled,
        failure,
      });
      return {
        status: "running",
        checkpoint: {
          phase: "provider-held",
          from: at,
          failedSubmissionId: settled.id,
          failure: failure ?? null,
        },
      };
    }, context);
  };

  /** Whether the step holds: one whose spec ends failed instead holds only for the account. */
  const holdsFor = (
    step: Step,
    settled: SettledSubmissionRecord,
    failure: RouteFailure | undefined,
  ) =>
    holds(settled) &&
    (step.spec.unanswered !== "fail" || isAccountFailure(failure));

  /** The retryability a hold records for `failure` (`heldFailure`), for a step that fails instead. */
  const heldRetryable = (failure: RouteFailure | undefined) =>
    heldFailure([
      {
        failure:
          failure === undefined
            ? null
            : { kind: failure.kind, status: null, code: null },
      },
    ]).retryable;

  /** A settled submission that is neither answered, held nor an overflow: the step fails. */
  const failed = (
    runtime: Runtime,
    step: Step,
    settled: SettledSubmissionRecord,
    detail: string | undefined,
    failure: RouteFailure | undefined,
    context: Context,
    conversationId: number,
    retryable = true,
  ) =>
    fail(
      runtime,
      step,
      {
        // The kind and status only: the provider's own words stay in the capture.
        ...(failure === undefined
          ? {}
          : {
              failure: {
                kind: failure.kind,
                ...(failure.status === undefined
                  ? {}
                  : { status: failure.status }),
              },
            }),
        tag:
          settled.reason === "model_error"
            ? "ModelError"
            : String(settled.reason),
        message: String(
          settled.detail === undefined
            ? (detail ?? settled.reason)
            : typeof settled.detail === "string"
              ? settled.detail
              : JSON.stringify(settled.detail),
        ).slice(0, 500),
        retryable,
      },
      context,
      conversationId,
    );

  /**
   * Whether this process holds the step's claim on its key (record 0016), begun when it holds
   * none: before the conversation opens, and when a phase that can submit to the model runs in a
   * process that holds nothing for it (a resumed run). While it waits, pi sends nothing for its
   * conversation: each request waits in the kind extension's `beforeRequest` hook (`tools.ts`) on
   * `claims.admitted`. A holder that released the claim gave no verdict, so the step claims again
   * at once. Otherwise the step has ended, without a model call: with the output another run stored
   * or shared, or with that run's failure and retryability.
   */
  const claimed = async (
    runtime: Runtime,
    step: Step,
    startedAt: number,
    context: Context,
    at: { readonly conversationId?: number; readonly contract?: true } = {},
  ) => {
    if (claims.holds(runtime.taskId)) return true;
    let answer = await claims.begin(
      runtime.taskId,
      keyOf(step),
      runtime.signal,
    );
    // Event-driven: each begin wakes on the previous holder's recorded end; the signal bounds it.
    while (answer.kind === "released") {
      ctx.log.write({
        type: "progress",
        message: `${step.spec.agent}: the run holding this step's key gave it up (${answer.tag}); claiming it again`,
      });
      answer = await claims.begin(runtime.taskId, keyOf(step), runtime.signal);
    }
    if (answer.kind === "holder") return true;
    if (at.conversationId !== undefined) {
      const conversation = await runtime.conversation(
        at.conversationId as ConversationId,
        context,
      );
      await conversation?.abort(context);
    }
    if (answer.kind === "stored") {
      const { computation, output, status } = answer.result;
      ctx.log.write({
        type: "progress",
        message: `${step.spec.agent}: output ${status === "shared" ? "shared by another run" : "found in the computation store"} (${computation.key.slice(0, 12)}); no model call`,
      });
      const held = readData(
        AgentStored,
        JSON.parse(new TextDecoder().decode(output)),
      );
      await end(
        runtime,
        step,
        recordOf(
          step,
          "reused",
          computation.key,
          held,
          runtime.now() - startedAt,
        ),
        context,
        at.conversationId,
      );
      return false;
    }
    // The holder's work failed: its own retryability decides this step's.
    const error = {
      tag: answer.tag,
      message: answer.message,
      retryable: answer.retryable,
    };
    await (at.contract
      ? failContract(runtime, step, error, context)
      : fail(runtime, step, error, context, at.conversationId));
    return false;
  };

  return defineTask<AgentStepInput, AgentStepCheckpoint, StageRecord>({
    name: AGENT_STEP,
    version: 1,
    initial: () => ({ phase: "start" }),
    phases: {
      start: async (task, runtime, context) => {
        using phaseSpan = scopedLogSpan(ctx.log, "harness.pi.phase", {
          "harness.task_id": runtime.taskId,
          "harness.phase": "start",
          "harness.task_kind": "agent",
        });

        const agent = await prepared(task, runtime, context);
        const { step } = agent;
        const startedAt = runtime.now();
        await services.run(
          recordStageStart(ctx, step.spec.stage, step.spec.agent),
          runtime.signal,
        );
        const stored = await lookup(step, runtime.signal);
        if (stored !== undefined) {
          const held = await readStored(stored.key, runtime.signal);
          ctx.log.write({
            type: "progress",
            message: `${step.spec.agent}: output found in the computation store (${stored.key.slice(0, 12)}); no model call`,
          });
          return end(
            runtime,
            step,
            recordOf(step, "reused", stored.key, held, 0),
            context,
          );
        }
        const policy = stageStartPolicy({
          now: startedAt,
          cutoffAt: task.input.cutoffAt,
          stored: false,
          afterCutoff: false,
          holdable: true,
          stage: step.spec.stage,
          hold: ctx.config.stub?.hold,
        });
        if (policy.kind === "skip")
          return end(
            runtime,
            step,
            {
              stage: step.spec.stage,
              agent: step.spec.agent,
              status: "skipped",
              wallMs: 0,
              note: cutoffNotes.skipped,
            },
            context,
          );
        // A recompose reuses stored outputs; a step without one stops here unless its policy lets
        // this operation call the model.
        if (ctx.recompose !== undefined && !ctx.recompose.allow.has(step.op))
          return fail(
            runtime,
            step,
            needsModel(step.op, step.spec.agent),
            context,
          );
        if (policy.holdMs !== undefined) {
          const wait = policy.holdMs;
          ctx.log.write({
            type: "progress",
            message: `${step.spec.agent}: holding ${Math.round(wait / 1000)} s (stub setting)`,
          });
          await runtime.commit(
            () => ({
              status: "running",
              checkpoint: {
                phase: "stub-hold",
                startedAt,
                until: startedAt + wait,
              },
            }),
            context,
          );
          return;
        }
        await open(runtime, agent, startedAt, context);
      },
      "stub-hold": async (task, runtime, context) => {
        using phaseSpan = scopedLogSpan(ctx.log, "harness.pi.phase", {
          "harness.task_id": runtime.taskId,
          "harness.phase": "stub-hold",
          "harness.task_kind": "agent",
        });

        const agent = await prepared(task, runtime, context);
        await runtime.sleep(task.state.checkpoint.until, context);
        if (cutoffReached(runtime.now(), task.input.cutoffAt))
          return end(
            runtime,
            agent.step,
            {
              stage: agent.step.spec.stage,
              agent: agent.step.spec.agent,
              status: "interrupted",
              wallMs: runtime.now() - task.state.checkpoint.startedAt,
              note: cutoffNotes.held,
            },
            context,
          );
        await open(runtime, agent, task.state.checkpoint.startedAt, context);
      },
      contract: async (task, runtime, context) => {
        const held = (await runtime.snapshot(RunControlDoc, context))?.held[
          String(runtime.taskId)
        ];
        if (held !== undefined && contractHoldNeedsNewerBuild(held)) {
          await awaitResume(runtime, context);
          return;
        }
        const agent = await prepared(task, runtime, context);
        const { step } = agent;
        if (
          !(await claimed(
            runtime,
            step,
            task.state.checkpoint.startedAt,
            context,
            { contract: true },
          ))
        )
          return;
        if (task.state.checkpoint.opening)
          return open(runtime, agent, task.state.checkpoint.startedAt, context);
        const own = offeredTools(agent);
        const kept = { frozen: own };
        await runtime.commit(async (tx) => {
          const tools = await tx.doc(RunToolsDoc);
          const held = tools.kinds[task.input.kind];
          if (held === undefined)
            tools.kinds[task.input.kind] = {
              step: runtime.taskId,
              tools: [...own],
            };
          else
            kept.frozen = held.tools.map((tool) => ({
              ...tool,
              parameters: z
                .record(z.string(), z.json())
                .parse(copyJson(tool.parameters)),
            }));
        }, context);
        const compared = compareDeclarations(kept.frozen, own);
        if (compared.status === "differs")
          return failContract(
            runtime,
            step,
            { tag: "ToolsDiffer", message: compared.detail, retryable: false },
            context,
          );
        if (compared.status === "external")
          ctx.log.write({
            type: "gap",
            kind: "integration-tools-changed",
            agent: step.spec.agent,
            detail: "The step retains the run's frozen integration tools.",
            cause: compared.changed.join(", "),
          });
        let ending;
        try {
          // The contract engine's dispatch gate: every runtime turn starts inside `contractStep`,
          // which runs only in this phase and only while this process holds the step's claim.
          await claims.granted(runtime.taskId, runtime.signal);
          ending = await contractStep({
            port: runtime,
            context,
            agent,
            kind: task.input.kind,
            frozen: kept.frozen,
            account: task.state.checkpoint.account,
            services,
            // At the step's effort, as its key is (`agentStageSpec`), so its requests follow it.
            route: routeAtEffort(
              ctx.config.route,
              stepEffortOf(ctx.config.route, step.spec.stage, step.spec.effort),
            ),
            startedAt: task.state.checkpoint.startedAt,
            cutoffAt: task.input.cutoffAt,
          });
        } catch (error) {
          if (error instanceof ContractWriteRefused)
            return holdContractWrite(runtime, context);
          if (runtime.signal.aborted) throw error;
          if (error instanceof ContractRecoveryFailed)
            return failContract(
              runtime,
              step,
              {
                tag: error._tag,
                reason: error.reason,
                message: error.message,
                retryable: false,
              },
              context,
            );
          const failure = RuntimeFailure.safeParse(
            typeof error === "object" && error !== null ? { ...error } : error,
          );
          if (
            failure.success &&
            runtimeFailurePolicy(failure.data).action === "hold"
          )
            return holdContract(
              runtime,
              agent,
              task.state.checkpoint,
              failure.data,
              context,
            );
          return failContract(
            runtime,
            step,
            {
              ...(failure.success ? failure.data : {}),
              tag: failure.success
                ? failure.data._tag
                : "ContractProtocolFailure",
              message: failure.success
                ? runtimeFailureToError(failure.data).message
                : "the runtime failed unexpectedly",
              retryable: false,
            },
            context,
          );
        }
        if (ending.status === "interrupted")
          return interrupted(runtime, step, task.state.checkpoint, context);
        return store(runtime, step, task.state.checkpoint, ending, context);
      },
      bind: async (task, runtime, context) => {
        using phaseSpan = scopedLogSpan(ctx.log, "harness.pi.phase", {
          "harness.task_id": runtime.taskId,
          "harness.phase": "bind",
          "harness.task_kind": "agent",
        });

        const agent = await prepared(task, runtime, context);
        const { step } = agent;
        const { conversationId, startedAt, estimate } = task.state.checkpoint;
        if (
          !(await claimed(runtime, step, startedAt, context, {
            conversationId,
          }))
        )
          return;
        const conversation = conversationId as ConversationId;
        const kind = task.input.kind;
        const own = offeredTools(agent);
        // The kind's declarations are the run's: the first agent of the kind freezes them, every
        // later one offers the same (tools.ts).
        // Set inside the commit below, which control flow does not follow into.
        const kept: {
          frozen: ReadonlyArray<ToolDeclaration>;
          compared: ReturnType<typeof compareDeclarations>;
        } = { frozen: own, compared: { status: "same" } };
        await runtime.commit(async (tx) => {
          const tools = await tx.doc(RunToolsDoc);
          const held = tools.kinds[kind];
          if (held === undefined)
            tools.kinds[kind] = {
              step: runtime.taskId,
              tools: own.map((declaration) => ({ ...declaration })),
            };
          else {
            kept.frozen = held.tools.map((declaration) => ({ ...declaration }));
            kept.compared = compareDeclarations(kept.frozen, own);
          }
          return undefined;
        }, context);
        const { frozen, compared } = kept;
        if (compared.status === "differs")
          return fail(
            runtime,
            step,
            {
              tag: "ToolsDiffer",
              message: `${step.spec.agent} ${compared.detail}`,
              retryable: false,
            },
            context,
          );
        if (compared.status === "external")
          ctx.log.write({
            type: "gap",
            stage: step.spec.stage,
            agent: step.spec.agent,
            kind: "integration-tools-changed",
            detail:
              "An integration's tools changed while this review ran, so this step was offered them as the review first read them.",
            cause: compared.changed.join(", "),
          });
        const extension = host.install(kind, frozen);
        const model = await services.routes.bindAgentRoute(
          {
            conversationId: conversation,
            stage: step.spec.stage,
            agent: step.spec.agent,
            route: ctx.config.route,
            effort: stepEffortOf(
              ctx.config.route,
              step.spec.stage,
              step.spec.effort,
            ),
          },
          context,
        );
        services.capture({
          type: "session.bind",
          scope: {
            runId: ctx.runId,
            stage: step.spec.stage,
            agent: step.spec.agent,
            conversationId,
            taskId: runtime.taskId,
          },
          computationId: Computations.computationKey(keyOf(step)).key,
        });
        await runtime.commit(async (tx) => {
          const doc = await tx.doc(AgentContextDoc, conversation);
          doc.step = {
            taskId: runtime.taskId,
            kind,
            agent: step.spec.agent,
            input: copyJson(task.input),
          };
          doc.system = step.spec.system;
          await configure(tx, conversation, {
            model,
            thinkingLevel: null,
            extensions: [extension],
            tools: extension.tools ?? [],
            instructions: null,
          });
          return {
            status: "running",
            checkpoint: {
              phase: "running",
              startedAt,
              conversationId,
              estimate,
              resumedTurns: 0,
              request: "task",
              content: step.spec.task,
              continuations: 0,
            },
          };
        }, context);
      },
      running: async (task, runtime, context) => {
        using phaseSpan = scopedLogSpan(ctx.log, "harness.pi.phase", {
          "harness.task_id": runtime.taskId,
          "harness.phase": "running",
          "harness.task_kind": "agent",
        });

        const { step } = await prepared(task, runtime, context);
        const at = task.state.checkpoint;
        if (!(await claimed(runtime, step, at.startedAt, context, at))) return;
        const resumed = await resumedTurns(runtime, at, context);
        const settled = await answered(
          runtime,
          at,
          task.input.cutoffAt,
          context,
        );
        if (settled === "cutoff")
          return interrupted(runtime, step, resumed, context);
        const { facts } = await conversationOf(
          runtime,
          at.conversationId,
          context,
        );
        const scan = submissions(step, facts.calls);
        if (scan.accepted !== undefined)
          return store(
            runtime,
            step,
            resumed,
            {
              status: "submitted",
              endedBy: "submit",
              output: scan.accepted,
              finalGeneration: false,
            },
            context,
          );
        // Invalid submissions are answered with their problems and retried at most twice, as the
        // final generation is; past that, code's repair, else the backstop (§3.5).
        if (
          scan.failed.length > (step.spec.retries ?? MAX_INVALID_SUBMISSIONS)
        ) {
          const last = scan.failed.at(-1);
          const parsed = submissionOf(step.spec)(last);
          const fixed = repaired(step, parsed.data);
          if (fixed !== undefined) {
            ctx.log.write({
              type: "gap",
              stage: step.spec.stage,
              agent: step.spec.agent,
              kind: "output-repaired",
              detail: `${StepName(step.spec.stage, step.spec.agent)} gave ${scan.failed.length} answers that failed its checks, so code repaired the last one; parts of it may have been dropped.`,
              cause: parsed.message.slice(0, 1_500),
            });
            return store(
              runtime,
              step,
              resumed,
              {
                status: "submitted",
                endedBy: "submit",
                output: fixed,
                repairedFrom: parsed.data,
                finalGeneration: false,
              },
              context,
            );
          }
          ctx.log.write({
            type: "gap",
            stage: step.spec.stage,
            agent: step.spec.agent,
            kind: "invalid-submissions",
            detail: `${StepName(step.spec.stage, step.spec.agent)} never gave an answer that passed its checks, so its result is a fallback built by code from what it recorded.`,
          });
          return store(
            runtime,
            step,
            resumed,
            {
              status: "backstop",
              endedBy: "submit",
              output: undefined,
              finalGeneration: false,
            },
            context,
          );
        }
        // A round the stage's policy ended through the runtime's `endRound` (tools.ts) settles
        // aborted: the policy goes on from the transcript as if pi had ended the round itself.
        const stopped =
          settled.status === "unanswered" &&
          settled.reason === "aborted" &&
          (await stoppedRound(runtime, at.conversationId, context));
        if (settled.status === "unanswered" && !stopped) {
          const last = facts.last;
          const failure = await failureOf(
            runtime,
            at.conversationId,
            settled,
            context,
          );
          // An overflow goes to the final generation, as before, never to a hold.
          if (
            failure?.kind === "context_overflow" ||
            (last !== undefined &&
              last.stopReason === "error" &&
              isContextOverflow(last))
          )
            return toFinal(
              runtime,
              step,
              resumed,
              "overflow",
              task.input.cutoffAt,
              context,
            );
          // A refusal is recorded with its category (the hook) and the stage goes on without that
          // turn's output (§3.5), as after a text reply.
          if (!isRefusal(last)) {
            if (holdsFor(step, settled, failure))
              return hold(runtime, at, settled, failure, context);
            return failed(
              runtime,
              step,
              settled,
              last?.errorMessage,
              failure,
              context,
              at.conversationId,
              // The option's branch keeps the retryability its hold would have recorded.
              holds(settled) ? heldRetryable(failure) : undefined,
            );
          }
        }
        if (
          task.input.deadline !== undefined &&
          runtime.now() >= task.input.deadline
        )
          return toFinal(
            runtime,
            step,
            resumed,
            "timeout",
            task.input.cutoffAt,
            context,
          );
        if (
          facts.turns >= step.spec.turnLimit ||
          facts.lastInput >= ctx.config.budgets.contextCeiling
        )
          return toFinal(
            runtime,
            step,
            resumed,
            facts.lastInput >= ctx.config.budgets.contextCeiling
              ? "ceiling"
              : "turn-limit",
            task.input.cutoffAt,
            context,
          );
        // A text reply does not end the stage: the open items, at most three times.
        if (at.continuations >= MAX_CONTINUATIONS)
          return toFinal(
            runtime,
            step,
            resumed,
            "continuations",
            task.input.cutoffAt,
            context,
          );
        if (runtime.now() >= task.input.cutoffAt)
          return interrupted(runtime, step, resumed, context);
        const continuations = at.continuations + 1;
        await runtime.commit(
          () => ({
            status: "running",
            checkpoint: {
              ...at,
              resumedTurns: resumed.resumedTurns,
              request: `continue:${continuations}`,
              content: continueText(step.spec, facts.turns),
              continuations,
            },
          }),
          context,
        );
      },
      final: async (task, runtime, context) => {
        using phaseSpan = scopedLogSpan(ctx.log, "harness.pi.phase", {
          "harness.task_id": runtime.taskId,
          "harness.phase": "final",
          "harness.task_kind": "agent",
        });

        const { step } = await prepared(task, runtime, context);
        const at = task.state.checkpoint;
        if (!(await claimed(runtime, step, at.startedAt, context, at))) return;
        const resumed = await resumedTurns(runtime, at, context);
        const settled = await answered(
          runtime,
          at,
          task.input.cutoffAt,
          context,
        );
        if (settled === "cutoff")
          return interrupted(runtime, step, resumed, context);
        if (settled.status === "unanswered") {
          const failure = await failureOf(
            runtime,
            at.conversationId,
            settled,
            context,
          );
          return holdsFor(step, settled, failure)
            ? hold(runtime, at, settled, failure, context)
            : failed(
                runtime,
                step,
                settled,
                undefined,
                failure,
                context,
                at.conversationId,
                holds(settled) ? heldRetryable(failure) : undefined,
              );
        }
        const answer = (
          await conversationOf(runtime, at.conversationId, context)
        ).facts.last;
        let value: unknown;
        try {
          // The route's strict schema made the model write null for optional fields; the value is
          // read with them removed, as the provider's own final reading does.
          value = dropAddedNulls(
            finalSchema(step),
            JSON.parse(answerText(answer)),
          );
        } catch {
          value = undefined;
        }
        const parsed = parseOutput(step.spec)(value);
        if (parsed.success)
          return store(
            runtime,
            step,
            resumed,
            {
              status: "final-generation",
              endedBy: at.endedBy,
              output: parsed.data,
              finalGeneration: true,
              answered: "accepted",
            },
            context,
          );
        const refusals = at.refusals + 1;
        if (refusals > (step.spec.retries ?? MAX_INVALID_SUBMISSIONS)) {
          const fixed = repaired(step, parsed.data);
          if (fixed !== undefined)
            ctx.log.write({
              type: "gap",
              stage: step.spec.stage,
              agent: step.spec.agent,
              kind: "output-repaired",
              detail: `${StepName(step.spec.stage, step.spec.agent)} still gave an answer that failed its checks after ${step.spec.retries ?? MAX_INVALID_SUBMISSIONS} retries, so code repaired it; parts of it may have been dropped.`,
              cause: parsed.message.slice(0, 1_500),
            });
          return store(
            runtime,
            step,
            resumed,
            fixed === undefined
              ? {
                  status: "backstop",
                  endedBy: at.endedBy,
                  output: undefined,
                  finalGeneration: true,
                  answered: outcomeOf(parsed),
                }
              : {
                  status: "final-generation",
                  endedBy: at.endedBy,
                  output: fixed,
                  repairedFrom: parsed.data,
                  finalGeneration: true,
                  answered: outcomeOf(parsed),
                },
            context,
          );
        }
        if (runtime.now() >= task.input.cutoffAt)
          return interrupted(runtime, step, resumed, context);
        await runtime.commit(
          () => ({
            status: "running",
            checkpoint: {
              ...at,
              resumedTurns: resumed.resumedTurns,
              refusals,
              refused: [...(at.refused ?? []), outcomeOf(parsed)],
              request: `refused:${refusals}`,
              content: refusedText(parsed.message),
            },
          }),
          context,
        );
      },
      /**
       * Held for the provider: waits on the run control document, without polling, for a resume
       * nonce of a later claim of the job. A harness that closes ends the watch, which rejects, so
       * the phase runs again on reopen; the cut-off ends the step as interrupted.
       */
      "provider-held": async (task, runtime, context) => {
        using phaseSpan = scopedLogSpan(ctx.log, "harness.pi.phase", {
          "harness.task_id": runtime.taskId,
          "harness.phase": "provider-held",
          "harness.task_kind": "agent",
        });

        const { step } = await prepared(task, runtime, context);
        if (task.state.checkpoint.engine === "contract") {
          const { from } = task.state.checkpoint;
          const woken = await awaitResume(
            runtime,
            context,
            task.input.cutoffAt,
          );
          if (woken === "cutoff")
            return interrupted(runtime, step, from, context);
          await contractWrite(
            runtime,
            async (tx) => {
              const doc = await tx.doc(ContractContextDoc, runtime.taskId);
              if (doc.data !== null) {
                const state = readData(ContractState, doc.data, {
                  source: "neuve.contract-context",
                });
                retryContractRound(state);
                doc.data = copyJson(
                  preserveContractState(copyJson(doc.data), state),
                );
              }
              await leaveHeld(tx, runtime.taskId);
              return { status: "running", checkpoint: from };
            },
            context,
          );
          return;
        }
        const { from, failedSubmissionId } = task.state.checkpoint;
        const woken = await awaitResume(runtime, context, task.input.cutoffAt);
        if (woken === "cutoff")
          return interrupted(runtime, step, from, context);
        // The nonce is in the checkpoint before anything is submitted: a crash after this commit
        // submits the same request ID again, which pi joins. Nothing new is sent: the same model
        // request goes out again, in the phase and route mode it failed in.
        const resume = resumeSubmission(
          failedSubmissionId as SubmissionId,
          woken.nonce,
        );
        await runtime.commit(async (tx) => {
          await leaveHeld(tx, runtime.taskId);
          return {
            status: "running",
            checkpoint: {
              ...from,
              request: resume.requestId,
              content: resume.content,
            },
          };
        }, context);
      },
    },
    /**
     * The step's owner was aborted (the run's attempt deadline, the host's cut-off backstop, or a
     * sibling's failure): pi has already aborted the conversation it owns, keeping what it
     * committed.
     */
    abort: async (task, runtime, context) => {
      const held = (await runtime.snapshot(RunControlDoc, context))?.held[
        String(runtime.taskId)
      ];
      if (held !== undefined && contractHoldNeedsNewerBuild(held)) {
        await awaitResume(runtime, context);
        return;
      }
      const checkpoint = task.state.checkpoint;
      const { step } = await prepared(task, runtime, context);
      // What stopped it: the run's cut-off once it passed, otherwise its owner's abort.
      const cause: Interruption =
        runtime.now() >= task.input.cutoffAt ? "cutoff" : "aborted";
      if (checkpoint.phase === "contract")
        return interrupted(runtime, step, checkpoint, context, cause);
      if (checkpoint.phase === "running" || checkpoint.phase === "final")
        return interrupted(runtime, step, checkpoint, context, cause);
      if (checkpoint.phase === "provider-held")
        return interrupted(runtime, step, checkpoint.from, context, cause);
      await endClaim(runtime.taskId, {
        tag: INTERRUPTED,
        message: "the step was stopped before its conversation started",
        retryable: true,
        released: true,
      });
      await end(
        runtime,
        step,
        {
          stage: step.spec.stage,
          agent: step.spec.agent,
          status: "interrupted",
          wallMs:
            checkpoint.phase === "start"
              ? 0
              : runtime.now() - checkpoint.startedAt,
          note:
            cause === "cutoff"
              ? "interrupted before it started (10.42); nothing is stored"
              : "stopped before it started: its run was stopped; nothing is stored",
          ...(cause === "cutoff"
            ? {}
            : {
                disclosure: `${StepName(step.spec.stage, step.spec.agent)} didn't start: the review was stopped first, so its part of the review is missing.`,
              }),
        },
        context,
        undefined,
        cause,
      );
    },
  });

  async function contractWrite(
    runtime: Runtime,
    change: Parameters<Runtime["commit"]>[0],
    context: Context,
  ) {
    try {
      await runtime.commit(change, context);
    } catch (error) {
      if (!(error instanceof ContractWriteRefused)) throw error;
      await holdContractWrite(runtime, context);
    }
  }

  async function holdContractWrite(runtime: Runtime, context: Context) {
    // Held for a newer build: no verdict on the work, so its waiters claim again.
    await endClaim(runtime.taskId, {
      tag: "ContractWriteRefused",
      message: "held for a newer build that can preserve this context",
      retryable: false,
      released: true,
    });
    await runtime.commit(async (tx, current) => {
      const at = current.state.checkpoint;
      const from = at.phase === "provider-held" ? at.from : at;
      if (from.phase !== "contract")
        throw new Error("A contract write requires a contract checkpoint");
      const control = await tx.doc(RunControlDoc);
      const existing = control.held[String(runtime.taskId)];
      // A newer build's hold is opaque. Even its nonce must stay byte for byte.
      if (existing !== undefined && contractHoldNeedsNewerBuild(existing))
        return undefined;
      const state = readData(
        ContractState,
        (await tx.doc(ContractContextDoc, runtime.taskId)).data,
        { source: "neuve.contract-context" },
      );
      const round = state.rounds.at(-1);
      const held =
        existing?.engine === "contract"
          ? { ...existing, writeRefused: true as const }
          : await enterContractHeld(tx, runtime.taskId, {
              writeRefused: true,
              account: state.account,
              continuation: state.continuation,
              savedPhase: state.final ? "final" : "running",
              mode: state.final ? "final" : "running",
              round:
                round === undefined
                  ? null
                  : {
                      id: round.id,
                      prompt: round.prompt,
                      attempt: round.attempt,
                    },
              native: state.native,
              failure: {
                _tag: "TurnFailed",
                account: state.account,
                reason: "protocol-error",
              },
              reason: "contract-write-refused",
              detail:
                "This update cannot preserve newer fields; leave it to a newer build",
              recovery: { kind: "provider-policy" },
            });
      control.held[String(runtime.taskId)] = held;
      return {
        status: "running",
        checkpoint: {
          phase: "provider-held",
          engine: "contract",
          from,
          held,
          failure: held.failure,
        },
      };
    }, context);
    // Abort handlers must also stay live until the host closes held. Returning would fault them.
    await awaitResume(runtime, context);
  }

  async function holdContract(
    runtime: Runtime,
    agent: ResolvedAgent,
    from: ContractCheckpoint,
    failure: RuntimeFailure,
    context: Context,
    internalRetries?: boolean,
  ) {
    const snapshot = await runtime.snapshot(
      ContractContextDoc,
      runtime.taskId,
      context,
    );
    const state =
      snapshot?.data == null
        ? undefined
        : readData(ContractState, snapshot.data, {
            source: "neuve.contract-context",
          });
    const position =
      state === undefined && accountReadRefused(failure)
        ? { savedPhase: "open" as const, continuation: null }
        : {
            savedPhase: from.opening
              ? ("open" as const)
              : state?.final
                ? ("final" as const)
                : ("running" as const),
            continuation:
              state?.continuation ??
              (await services.run(
                services.runtimes.continuation(from.account),
                runtime.signal,
              )),
          };
    const internallyRetried =
      from.internalRetries ??
      internalRetries ??
      ((failure._tag === "TurnFailed" &&
        (failure.reason === "provider-failed" ||
          failure.reason === "provider-unavailable")) ||
      (failure._tag === "RuntimeUnavailable" &&
        failure.reason === "start-failed")
        ? await services.run(
            services.runtimes
              .capabilities(from.account)
              .pipe(Effect.map((capabilities) => capabilities.internalRetries)),
            runtime.signal,
          )
        : false);
    const policy = runtimeFailurePolicy(
      failure,
      state?.final,
      internallyRetried,
    );
    // A step whose spec ends failed on an unanswered call holds only for the account.
    if (
      policy.action === "hold" &&
      agent.step.spec.unanswered === "fail" &&
      !isAccountFailure(failure)
    )
      return failContract(
        runtime,
        agent.step,
        {
          ...failure,
          tag: failure._tag,
          message: runtimeFailureToError(failure).message,
          retryable: policy.retryable,
        },
        context,
      );
    // A hold may outlast this process, so it releases the claim (no verdict on the work). A
    // failure ends it with the retryability the thrown error gets (`definePolicyTask`).
    const thrown = runtimeFailureToError(failure);
    await endClaim(runtime.taskId, {
      tag: failure._tag,
      message: thrown.message,
      retryable:
        policy.action === "hold"
          ? policy.retryable
          : !("retryable" in thrown) || thrown.retryable !== false,
      released: policy.action === "hold",
    });
    if (policy.action !== "hold") throw thrown;
    await runtime.commit(async (tx) => {
      const round = state?.rounds.at(-1);
      const held = await enterContractHeld(tx, runtime.taskId, {
        failure,
        account: from.account,
        ...position,
        mode: state?.final ? "final" : "running",
        round:
          round === undefined
            ? null
            : { id: round.id, prompt: round.prompt, attempt: round.attempt },
        native: state?.native ?? null,
        reason: failure._tag,
        detail: runtimeFailureToError(failure).message,
        recovery: {
          kind:
            policy.retryable || accountReadRefused(failure)
              ? "provider-policy"
              : "explicit-account",
        },
      });
      return {
        status: "running",
        checkpoint: {
          phase: "provider-held",
          engine: "contract",
          from,
          held,
          failure,
        },
      };
    }, context);
  }

  /** Creates the step's conversation, owned by it, and estimates its first request. */
  async function open(
    runtime: Runtime,
    agent: ResolvedAgent,
    startedAt: number,
    context: Context,
  ) {
    // The start policy, the recompose guard and the stub hold ran before: only a step that is
    // about to call the model claims its key. The step is named here, not read off `agent` in the
    // call, so the reader registry can follow its schema to `prepared` (reader-registry.test.ts).
    const { step } = agent;
    if (!(await claimed(runtime, step, startedAt, context))) return;
    ctx.log.write({
      type: "progress",
      message: `${agent.step.spec.agent}: started`,
    });
    taken.add(runtime.taskId);
    const route = ctx.config.route;
    const account = routeAccount(route);
    if (account !== undefined) {
      const resolved = await services.run(
        services.runtimes.capabilities(account.name).pipe(Effect.result),
        runtime.signal,
      );
      if (resolved._tag === "Failure") {
        const error = resolved.failure;
        if (
          account.kind === "claude-subscription" &&
          runtimeFailurePolicy(runtimeErrorToFailure(error)).action === "hold"
        )
          return holdContract(
            runtime,
            agent,
            {
              phase: "contract",
              engine: "contract",
              startedAt,
              estimate: null,
              resumedTurns: 0,
              account: account.name,
              opening: true,
            },
            runtimeErrorToFailure(error),
            context,
            false, // Capability lookup failed before any session or request.
          );
        return fail(
          runtime,
          agent.step,
          {
            ...runtimeErrorToFailure(error),
            tag: error._tag,
            message: error.message,
            retryable: false,
          },
          context,
        );
      }
      const { ownsLoop } = resolved.success;
      const error = stageRouteError(route, ownsLoop);
      if (error !== undefined)
        return fail(
          runtime,
          agent.step,
          {
            ...error,
            tag: error._tag,
            message: error.message,
          },
          context,
        );
      if (ownsLoop) {
        await runtime.commit(
          () => ({
            status: "running",
            checkpoint: {
              phase: "contract",
              engine: "contract",
              startedAt,
              estimate: null,
              resumedTurns: 0,
              account: account.name,
              internalRetries: resolved.success.internalRetries,
            },
          }),
          context,
        );
        return;
      }
    }
    const estimated = await estimate(agent, runtime.signal);
    await runtime.commit(async (tx) => {
      const conversation = await tx.createConversation({
        ownership: { kind: "task", taskId: runtime.taskId },
      });
      return {
        status: "running",
        checkpoint: {
          phase: "bind",
          startedAt,
          conversationId: conversation.id,
          estimate: estimated,
        },
      };
    }, context);
  }

  /** Stores the context's output and ends the step, after the context's record is final. */
  async function store(
    runtime: Runtime,
    step: Step,
    at: Running | ContractRunning,
    ending: Parameters<typeof finish>[3],
    context: Context,
  ) {
    const done = await finish(runtime, step, at, ending, context);
    if (done.record === undefined)
      throw new Error(`${step.spec.agent} stored no record`);
    return end(runtime, step, done.record, context, at.conversationId);
  }

  /** The turns the conversation held when this process first took a started step up again. */
  async function resumedTurns<T extends Running>(
    runtime: Runtime,
    at: T,
    context: Context,
  ): Promise<T> {
    if (taken.has(runtime.taskId)) return at;
    taken.add(runtime.taskId);
    const { facts } = await conversationOf(runtime, at.conversationId, context);
    return facts.turns <= at.resumedTurns
      ? at
      : { ...at, resumedTurns: facts.turns };
  }
};

/** The final generation's output schema: the submit tool's, as the route sends it (10.11). */
const finalSchema = (step: Step) => {
  const schema = copyJson(wireSchema(step.spec.submit.schema).schema);
  if (schema === null || typeof schema !== "object" || Array.isArray(schema))
    throw new TypeError("The final-generation schema must be a JSON object");
  return schema;
};

/**
 * What the step answered to each call of the submit tool, in the order the model wrote them, as
 * `label` reads it from the answer stored for the call; a call with none recorded has no entry.
 */
const submitLabels = (
  step: Step,
  calls: ReadonlyArray<{ readonly id: string; readonly name: string }>,
  label: (id: string) => SubmissionOutcome | undefined,
) =>
  calls.flatMap((call) => {
    const found =
      call.name === submitNameOf(step.spec) ? label(call.id) : undefined;
    return found === undefined ? [] : [found];
  });

/**
 * The contract engine's final answers, from its rounds: each final round a refusal round
 * followed, then the last when the step `ended` on it, judged again as `contractStep` judged them.
 */
const contractFinalOutcomes = (
  step: Step,
  state: ContractState | undefined,
  ended: boolean,
) => {
  if (state === undefined) return [];
  const schema = JsonSchema.parse(wireSchema(step.spec.submit.schema).schema);
  const judged = (round: ContractState["rounds"][number]) =>
    outcomeOf(
      parseOutput(step.spec)(
        dropAddedNulls(
          schema,
          round.outcome?.status === "completed"
            ? round.outcome.structuredOutput
            : undefined,
        ),
      ),
    );
  const { rounds } = state;
  return rounds.flatMap((round, index) =>
    round.final &&
    (rounds[index + 1]?.prompt.startsWith(MARK.invalid) === true ||
      (ended && index === rounds.length - 1))
      ? [judged(round)]
      : [],
  );
};

/** A stored summary as a stage record carries it; an older or foreign one is left out. */
const StoredSummary = z
  .object({
    agent: z.string(),
    stage: z.enum(["frame", "map", "find", "verify"]),
    status: z.enum([
      "submitted",
      "final-generation",
      "backstop",
      "interrupted",
    ]),
    endedBy: z.enum([
      "submit",
      "turn-limit",
      "ceiling",
      "continuations",
      "overflow",
      "timeout",
    ]),
    turnsUsed: z.number(),
    turnLimit: z.number(),
    finalGeneration: z.boolean(),
    usage: z.object({
      input: z.number(),
      cacheWrite5m: z.number(),
      cacheWrite1h: z.number(),
      cacheRead: z.number(),
      output: z.number(),
      thinking: z.number().optional(),
    }),
    costUsd: z.number().nullable(),
    resumedTurns: z.number(),
    restarted: z.boolean(),
    modelCalls: z.number(),
    context: z.object({ firstCall: z.number(), peak: z.number() }).optional(),
  })
  .loose();

const StoredContext = z
  .object({
    planned: z.record(z.string(), z.number()).optional(),
    estimated: z.number().optional(),
    counted: z.number().nullable().optional(),
    firstCall: z.number().optional(),
    peak: z.number().optional(),
  })
  .loose();
