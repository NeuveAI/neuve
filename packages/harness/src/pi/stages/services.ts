import { cpuJob, CpuWork } from "../../budget/cpu.ts";
import type { Budget } from "../../budget/scheduler.ts";
import type { Context } from "@earendil-works/chord";
import { Cause, Effect, Exit } from "effect";
import type { Registry, TaskId, Tx } from "@earendil-works/pi-durable";
import type { FileSystem } from "effect/FileSystem";
import type { SqlClient } from "effect/sql/SqlClient";
import type { Blobs, Computations } from "@neuve/records-core";
import type { Integrations } from "../../integrations.ts";
import { McpClients } from "../../mcp-client.ts";
import type { RunContext } from "../../pipeline.ts";
import type { RuntimeRegistryShape } from "@neuve/runtime";
import type { ContractSessionSlots } from "../session-slots.ts";
import type { Capture } from "../capture/types.ts";
import type { AgentRouteRuntime } from "../contracts.ts";

/** What the stages' Effect code runs with: the worker's Records services and the run's MCP clients. */
export type StageRequirements =
  | SqlClient
  | FileSystem
  | Blobs.BlobStore
  | Computations.ComputationStore
  | McpClients;

/**
 * Runs one of the stages' Effects to a promise, for pi's tasks and tools. `signal` is pi's: a
 * cancelled call or task interrupts the Effect. A failure rejects with its error as the Effect
 * failed with it. The native task boundary persists tagged failures as structured failed outcomes.
 */
export type StageRunner = <A, E>(
  effect: Effect.Effect<A, E, StageRequirements>,
  signal?: AbortSignal,
) => Promise<A>;

/**
 * The route's free count of a first request's tokens (§2.1, 10.35), where the route has one: null
 * when it counts nothing (the OpenAI route, 10.85). A count the provider refuses fails, which stops
 * the run as the preflight did.
 */
export type CountTokens = (
  request: {
    readonly label: string;
    readonly system: string;
    readonly user: string;
    readonly tools: ReadonlyArray<{
      readonly name: string;
      readonly description: string;
      readonly input_schema: Record<string, unknown>;
    }>;
  },
  signal?: AbortSignal,
) => Promise<number | null>;

/**
 * What the runtime hands the review stages for one run (0014). The run's context is the incumbent
 * one; its model-call slots, retries and route belong to the provider's `Models` now, so the stages
 * never call a model themselves.
 */
export interface StageServices {
  readonly ctx: RunContext["Service"];
  /** The agent routes the runtime owns: each conversation is bound before its first submission. */
  readonly routes: Pick<
    AgentRouteRuntime,
    "bindAgentRoute" | "prepareFinalGeneration"
  >;
  readonly capture: Capture;
  /** The harness's registry: the stages install one tool extension per agent kind in it. */
  readonly registry: Registry;
  /** Account runtime capabilities, shared by every step in this attempt. */
  readonly runtimes: RuntimeRegistryShape;
  readonly contractSessions?: ContractSessionSlots;
  readonly integrations: Integrations;
  /** The run's MCP connections, one per server, closed by the runtime when the run ends (10.51). */
  readonly clients: McpClients["Service"];
  readonly run: StageRunner;
  /**
   * Ends a generation whose tool round the stage's policy ends but pi cannot, because a call of the
   * round was refused before it ran (pi ends a round only when every call asks it to). Called from
   * the generation's own `afterTools` hook with that hook's context: commits `decide`, and when it
   * returns true aborts the generation (`Harness.abortTask(generation, context)`) before it creates
   * its next request. The abort settles the run's submission as `aborted`; the agent step then reads
   * the stop `decide` recorded and applies its policy.
   */
  readonly endRound: (
    input: {
      readonly generation: TaskId;
      readonly decide: (tx: Tx) => Promise<boolean>;
    },
    context: Context,
  ) => Promise<void>;
  readonly countTokens?: CountTokens | undefined;
}

/** The runner over the run's own services, for a runtime that adds nothing to them. */
export const stageRunner =
  (
    ctx: RunContext["Service"],
    clients: McpClients["Service"],
    budget?: Budget,
  ): StageRunner =>
  async (effect, signal) => {
    const exit = await Effect.runPromiseExit(
      cpuJob(
        {
          class: "interactive",
          position: "understand",
          stage: 0,
        },
        effect,
      ).pipe(
        Effect.provide(ctx.records),
        Effect.provideService(McpClients, clients),
        (work) =>
          budget === undefined
            ? work
            : Effect.provideService(work, CpuWork, {
                budget,
                priority: {
                  class: "interactive",
                  position: "understand",
                  stage: 0,
                },
                inherited: false,
              }),
      ),
      signal === undefined ? undefined : { signal },
    );
    if (Exit.isSuccess(exit)) return exit.value;
    throw Cause.squash(exit.cause);
  };
