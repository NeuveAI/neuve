import { accountReadRefused } from "@neuve/runtime";
import { readData } from "@neuve/records-core";
import type { Context } from "@earendil-works/chord";
import type {
  DocumentReader,
  Extension,
  Harness,
  Task,
  TaskId,
} from "@earendil-works/pi-durable";
import type { z } from "zod";
import { Effect } from "effect";
import { withRecords, type StageRecord } from "../../pipeline.ts";
import {
  contractHoldCorruption,
  contractHoldNeedsNewerBuild,
} from "../failure-policy.ts";
import { RunControlDoc, registerResumeRuntimes } from "../control.ts";
import {
  AgentStepInput,
  agentStepTask,
  type AgentStepCheckpoint,
} from "./agent-step.ts";
import { submitNameOf } from "./agent.ts";
import { childId } from "./children.ts";
import {
  AgentContextDoc,
  AgentKind,
  RunToolsDoc,
  type ToolDeclaration,
} from "./docs.ts";
import type { StageServices } from "./services.ts";
import { stepClaims } from "./step-claim.ts";
import { kindExtension, type KindTools, type ResolvedAgent } from "./tools.ts";

/**
 * The agent step task and its kinds' extensions, over a way to prepare an agent from a step's
 * durable input: the review's own steps (run.ts), or any other agent built the same way.
 */
export interface AgentKinds {
  readonly agentStep: Task<
    AgentStepInput,
    AgentStepCheckpoint,
    StageRecord,
    object
  >;
  /**
   * After `Harness.open` and the routes' restore, before resume admission or `resume()`:
   * reclassifies saved contract provider holds, installs every kind's extension from the run's
   * frozen declarations and prepares the step that froze each, so its tools' zod schemas judge
   * the calls a resumed generation makes. At most one step per kind.
   */
  readonly restore: (harness: Harness, context: Context) => Promise<void>;
}

export const agentKinds = (
  services: StageServices,
  agents: {
    /** The agent of a step task, cached per task by the caller. */
    readonly prepare: (
      taskId: TaskId,
      input: AgentStepInput,
      read: DocumentReader,
      context: Context,
    ) => Promise<ResolvedAgent>;
  },
): AgentKinds => {
  const { ctx } = services;
  const installed = new Map<AgentKind, Extension>();
  /** By kind, then tool: the zod input schema of each tool, from an agent of the kind. */
  const inputs = new Map<AgentKind, Map<string, z.ZodType | undefined>>();

  const prepared = async (
    taskId: TaskId,
    input: AgentStepInput,
    read: DocumentReader,
    context: Context,
  ) => {
    const agent = {
      ...(await agents.prepare(taskId, input, read, context)),
      deadline: input.deadline,
    };
    if (!inputs.has(input.kind)) {
      const spec = agent.step.spec;
      inputs.set(
        input.kind,
        new Map([
          ...[...spec.tools, agent.vent].map(
            (tool) => [tool.name, tool.input] as const,
          ),
          [submitNameOf(spec), spec.submit.schema] as const,
        ]),
      );
    }
    return agent;
  };

  /** The steps' claims (record 0016): a step's conversation sends nothing until it holds. */
  const claims = stepClaims((effect, signal) =>
    services.run(withRecords(ctx, effect), signal),
  );
  const kindTools: KindTools = {
    admitted: claims.admitted,
    route: ctx.config.route,
    ceiling: ctx.config.budgets.contextCeiling,
    log: ctx.log,
    run: services.run,
    endRound: services.endRound,
    inputOf: (kind, tool) => inputs.get(kind)?.get(tool),
    resolve: async (read, conversationId, context) => {
      const doc = await read.snapshot(AgentContextDoc, conversationId, context);
      if (doc === undefined || doc.step === null)
        throw new Error(
          `Conversation ${conversationId} has no agent step; its tools cannot run`,
        );
      return prepared(
        childId<StageRecord>(doc.step.taskId),
        readData(AgentStepInput, doc.step.input),
        read,
        context,
      );
    },
  };

  const install = (
    kind: AgentKind,
    declarations: ReadonlyArray<ToolDeclaration>,
  ): Extension => {
    const held = installed.get(kind);
    if (held !== undefined) return held;
    const extension = kindExtension(kind, declarations, kindTools);
    services.registry.install(extension);
    installed.set(kind, extension);
    return extension;
  };

  return {
    agentStep: agentStepTask({ services, prepare: prepared, install, claims }),
    restore: async (harness, context) => {
      registerResumeRuntimes(harness, services.runtimes);
      // Active runs restore kinds before admitting resumes or scheduling tasks.
      const control = await harness.snapshot(RunControlDoc, context);
      for (const held of Object.values(control?.held ?? {})) {
        const corrupt = contractHoldCorruption(held);
        if (corrupt !== undefined) throw corrupt;
      }
      for (const [id, held] of Object.entries(control?.held ?? {})) {
        if (
          held.engine !== "contract" ||
          contractHoldNeedsNewerBuild(held) ||
          held.recovery.kind !== "provider-policy" ||
          !(
            (held.failure._tag === "TurnFailed" &&
              (held.failure.reason === "provider-failed" ||
                held.failure.reason === "provider-unavailable")) ||
            (held.failure._tag === "RuntimeUnavailable" &&
              held.failure.reason === "start-failed")
          )
        )
          continue;
        const result = await services.run(
          services.runtimes.capabilities(held.account).pipe(Effect.result),
          context.abortSignal,
        );
        // A failed lookup means the account is gone or unusable; never send automatically.
        if (result._tag === "Failure" && accountReadRefused(result.failure))
          continue;
        if (result._tag === "Success" && !result.success.internalRetries)
          continue;
        await harness.commit(async (tx) => {
          const doc = await tx.doc(RunControlDoc);
          doc.held[id] = { ...held, recovery: { kind: "explicit-account" } };
        }, context);
      }
      const doc = await harness.snapshot(RunToolsDoc, context);
      for (const [name, frozen] of Object.entries(doc?.kinds ?? {})) {
        const kind = AgentKind.parse(name);
        install(kind, frozen.tools);
        const id = childId<StageRecord>(frozen.step);
        const task = await harness.getTask(id, context);
        if (task === undefined)
          throw new Error(
            `The step that froze the ${kind} tools (${frozen.step}) is gone`,
          );
        await prepared(
          id,
          readData(AgentStepInput, task.input),
          harness,
          context,
        );
      }
    },
  };
};
