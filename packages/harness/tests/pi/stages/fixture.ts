import {
  type AccountName,
  type RuntimeError,
  type RuntimeRegistryShape,
  type RuntimeCapabilities,
  type RuntimeCapability,
} from "@neuve/runtime";
// Why (0014, the pi port's restart and policy boundaries): an agent step runs on pi's own generation
// and tool tasks, so the stage's bounded policy has to hold through pi's native boundaries. These
// run the production agent step, its kind's static extension and the runtime's route bindings on a
// real Harness over SQLite, with pi-ai's faux provider as the transport and a real Records store:
//
// - a required field the model left null is refused by the tool's zod schema before pi can coerce
//   it, the tool's own code never runs, and three refused submissions end the context with the
//   backstop instead of looping until the cut-off;
// - a round that reads and submits ends where the submission is accepted, with no further request,
//   and a strict tool's added nulls are dropped while a field that accepts null keeps it;
// - a step closed mid-context reopens on the same conversation: the same prompt, offered tools and
//   schemas, the handles its tools recorded, its final generation in final mode, one binding and no
//   model call counted twice;
// - a model call the provider refused holds the step with the route's typed failure, and a resume
//   nonce sends the same request again with nothing new in it.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type AssistantMessage,
  type Message,
} from "@earendil-works/pi-ai";
import {
  Harness,
  createRegistry,
  defineExtension,
  type ConversationId,
  type TaskId,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Context, Effect, Layer, Scope, Stream, Tracer } from "effect";
import { z } from "zod";
import {
  Blobs,
  Computations,
  Store,
  mintUlid,
  storeLocationIn,
} from "@neuve/records-core";
import { defaultConfig } from "../../../src/config.ts";
import type { DirectRouteConfig, RouteEffort } from "../../../src/route.ts";
import { HandleRegistry } from "../../../src/lookups.ts";
import { McpClients, mcpClientsLayer } from "../../../src/mcp-client.ts";
import {
  storedOutput,
  ventTool,
  type StageRecord,
} from "../../../src/pipeline.ts";
import { openRunLog, runLogTracer } from "../../../src/run-log.ts";
import { RECORDS, defineTool, type ToolSpec } from "../../../src/toolkit.ts";
import {
  agentRoutes,
  clearInheritedAgentRoute,
} from "../../../src/pi/bindings.ts";
import type { CaptureEvent } from "../../../src/pi/capture/types.ts";
import {
  RunControlDoc,
  admitResume,
  credentialLost,
} from "../../../src/pi/control.ts";
import type { AgentRouteBinding } from "../../../src/pi/contracts.ts";
import {
  createAgentRouteProvider,
  type RouteTransportOptions,
} from "../../../src/pi/providers/agent-route-provider.ts";
import { SourceOwnership } from "../../../src/pi/source-ownership.ts";
import { createPrivateInspection } from "../../../src/pi/capture/private-inspection.ts";
import { openCaptureJournal } from "../../../src/pi/capture/journal.ts";
import { routeFailureDiagnostic } from "../../../src/pi/providers/failure.ts";
import { erased, type AgentStep } from "../../../src/pi/stages/agent.ts";
import type { AgentStepInput } from "../../../src/pi/stages/agent-step.ts";
import { AgentContextDoc, RunToolsDoc } from "../../../src/pi/stages/docs.ts";
import { agentKinds } from "../../../src/pi/stages/kinds.ts";
import {
  stageRunner,
  type StageServices,
} from "../../../src/pi/stages/services.ts";
import { Scheduler } from "../../../src/budget/scheduler.ts";
import { contractSessionSlots } from "../../../src/pi/session-slots.ts";
import {
  exportingStorage,
  type ExportOnClose,
} from "../../../src/pi/storage.ts";
import type { ContractPort } from "../../../src/pi/stages/contract-step.ts";
import { toolState } from "../../../src/pi/stages/tool-state.ts";

/** A stage's injected registry: unused operations fail instead of opening anything. */
export const testRuntimes = () => {
  const calls: AccountName[] = [];
  let sessionOpens = 0;
  const policy: {
    ownsLoop: boolean;
    error?: RuntimeError;
    lacking?: ReadonlyArray<RuntimeCapability>;
  } = {
    ownsLoop: false,
  };
  const capabilities: RuntimeCapabilities = {
    ownsLoop: false,
    toolEndsTurn: true,
    resumeInTurn: true,
    perMessageUsage: true,
    resume: false,
    fork: false,
    interrupt: false,
    modelSwitchInSession: false,
    structuredOutput: false,
    steering: false,
    approvals: false,
    perRequestTelemetry: false,
    ownTools: false,
    byteExactCapture: false,
    nativeToolServer: false,
    statusProbe: false,
    internalRetries: false,
  };
  const unused = () => Effect.die(new Error("Unused registry operation"));
  const registry: RuntimeRegistryShape = {
    accountEvents: Stream.empty,
    capabilities: (name) =>
      Effect.suspend(() => {
        calls.push(name);
        return policy.error === undefined
          ? Effect.succeed({
              ...capabilities,
              ownsLoop: policy.ownsLoop,
              ...Object.fromEntries(
                (policy.lacking ?? []).map((name) => [name, false]),
              ),
            })
          : Effect.fail(policy.error);
      }),
    continuation: unused,
    probe: unused,
    signOut: unused,
    openSession: () => {
      sessionOpens++;
      return unused();
    },
  };
  return { registry, policy, calls, sessionOpens: () => sessionOpens };
};

const directory = mkdtempSync(join(tmpdir(), "pi-stage-agent-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const SYSTEM = "You title units. SYSTEM-MARK-7f3.";
const TASK = "Title the units. TASK-MARK-91c.";

/** The submission: a required count, an optional note, and parts whose weight accepts null. */
const Submission = z.strictObject({
  answer: z.int(),
  note: z.string().optional(),
  parts: z
    .array(
      z.strictObject({
        label: z.string().optional(),
        weight: z.number().nullable(),
      }),
    )
    .optional(),
});

/** One recorded provider request: the route's mode at dispatch and what the model was sent. */
interface Sent {
  readonly mode: AgentRouteBinding["mode"];
  readonly messages: ReadonlyArray<Message>;
}

type Reply = (
  sent: Sent,
  signal: AbortSignal | undefined,
) => AssistantMessage | Promise<AssistantMessage>;

/** One test's world: a store, a run, a scripted route and the counts of what reached the tools. */
export const world = async (
  name: string,
  turnLimit = 6,
  distinct = false,
  strictAnswer = false,
  api = "faux",
  transport?: Pick<RouteTransportOptions, "fetch" | "auth"> & {
    readonly route: DirectRouteConfig;
  },
  durableCapture = false,
  extras: {
    /** More tools for the agent, built over its own handle registry. */
    readonly tools?: (handles: HandleRegistry) => ReadonlyArray<ToolSpec>;
    /** Whether the stage runner traces into the run log, so tool-call spans are written. */
    readonly traced?: boolean;
    /** The route's token count the stage services offer, for a test that counts or must not. */
    readonly countTokens?: StageServices["countTokens"];
  } = {},
  contract?: {
    readonly capture?: import("../../../src/pi/capture/types.ts").Capture;
    readonly onClose?: ExportOnClose<void>;
    readonly runtimes?: RuntimeRegistryShape;
    readonly sessions?: StageServices["contractSessions"];
    readonly afterCommit?: (port: ContractPort) => Promise<void>;
    readonly beforeCommit?: (port: ContractPort) => Promise<void>;
    readonly configure?: (
      step: AgentStep<unknown, unknown>,
    ) => AgentStep<unknown, unknown>;
  },
) => {
  const runtime = testRuntimes();
  const root = join(directory, name);
  const location = storeLocationIn(root);
  const scope = await Effect.runPromise(Scope.make());
  const records = await Effect.runPromise(
    Layer.buildWithScope(
      Computations.layer.pipe(
        Layer.provideMerge(Blobs.layer(location)),
        Layer.provideMerge(Store.layer(location, { create: true })),
        Layer.provideMerge(BunFileSystem.layer),
      ),
      scope,
    ),
  );
  await Effect.runPromise(Effect.provide(Store.prepareForWrite, records));
  const clients = Context.get(
    await Effect.runPromise(
      Layer.buildWithScope(
        mcpClientsLayer({ status: "absent", path: "(none)" }),
        scope,
      ),
    ),
    McpClients,
  );
  const runId = mintUlid();
  const ctx = {
    location,
    repository: root,
    runId,
    runKey: "f".repeat(64),
    range: {
      baseRef: "main",
      baseOid: "1".repeat(40),
      headOid: "2".repeat(40),
    },
    cycleId: mintUlid(),
    config: defaultConfig(undefined, transport?.route),
    log: openRunLog(location, runId),
    startedAt: Date.now(),
    reconciliationId: mintUlid(),
    records,
  };
  const sent: Array<Sent> = [];
  const script: Array<Reply> = [];
  const probes: Array<unknown> = [];
  const policy: {
    retries?: number;
    replayFinalize?: boolean;
    effort?: RouteEffort;
  } = {};
  let finalizationReplays = 0;
  const backstops: Array<number> = [];
  const events: Array<CaptureEvent> = [];
  const database = join(root, "pi.sqlite");
  const ownership = durableCapture ? SourceOwnership.acquire(root) : undefined;
  const authority =
    ownership === undefined
      ? undefined
      : createPrivateInspection({
          ownership,
          source: root,
          directory: join(directory, `${name}-private`),
          excludedRoots: [root],
        });
  const journal = durableCapture
    ? openCaptureJournal(join(root, "capture"), runId)
    : undefined;
  const capture = (event: CaptureEvent) => {
    events.push(event);
    journal?.capture(event);
    contract?.capture?.(event);
  };
  journal?.capture({
    type: "run.start",
    scope: { runId },
    runKind: "scored",
    sourceRevision: "2".repeat(40),
    route: "chatgpt",
    pricing: "subscription",
  });
  let pauseRound:
    ((signal: AbortSignal | undefined) => Promise<void>) | undefined;

  /** The agent a step task prepares: rebuilt per process, as a reopened run rebuilds it. */
  const agentFor = (taskId?: number) => {
    const handles = new HandleRegistry();
    const probe = defineTool({
      name: "probe",
      description: "Probe one numbered region and remember it.",
      input: z.strictObject({
        n: z.int(),
        why: z.string().max(200).optional(),
      }),
      hints: RECORDS,
      handle: (input: { n: number }) =>
        Effect.sync(() => {
          probes.push(input);
          handles.noteSeen(`p${input.n}`, "probe", input);
          return { text: `probed ${input.n}` };
        }),
    });
    const step: AgentStep<
      z.infer<typeof Submission>,
      { readonly status: string; readonly output: unknown }
    > = {
      spec: {
        stage: "frame",
        agent: taskId === undefined ? "frame" : `frame.${taskId}`,
        turnLimit,
        retries: policy.retries,
        effort: policy.effort,
        budgetNote: () => "lookup allowance 0 / 4",
        system: SYSTEM,
        task: TASK,
        tools: [probe, ...(extras.tools?.(handles) ?? [])],
        submit: {
          description: "Submit the titles. Ends the call.",
          schema: strictAnswer
            ? Submission.extend({ answer: z.int().min(1) })
            : Submission,
          name: "submit_frame",
        },
        check: (output) =>
          output.answer > 0 ? [] : ["answer must be positive"],
        repair: (output) => ({ ...output, answer: 1 }),
        backstop: () => {
          backstops.push(0);
          return { answer: 0 };
        },
        state: toolState({ handles }),
      },
      op: `test.agent.${name}`,
      opVersion: 1,
      inputs:
        taskId === undefined ? { run: runId } : { run: runId, task: taskId },
      compose: (result) => ({
        status: result.status,
        output: result.output ?? null,
      }),
      schema: z.strictObject({ status: z.string(), output: z.unknown() }),
    };
    return {
      step: contract?.configure?.(erased(step)) ?? erased(step),
      vent: ventTool(ctx, "frame"),
    };
  };

  /** Opens the run's harness over its SQLite file, as the runtime host does, and its stages. */
  const open = async () => {
    const models = createModels();
    const registry = createRegistry();
    let harness: Harness | undefined;
    const routes = () => {
      if (harness === undefined) throw new Error("the harness is not open");
      return agentRoutes({
        harness,
        models,
        runId,
        createProvider: (binding, readBinding) => {
          if (transport !== undefined)
            return createAgentRouteProvider({
              ...transport,
              log: ctx.log,
              credentialInspection: authority ?? "ephemeral",
              capture,
              logicalProvider: binding.logicalProvider,
              readBinding,
            });
          const faux = fauxProvider({
            api,
            provider: binding.logicalProvider,
            models: [{ id: binding.physicalModel }],
          });
          faux.setResponses(
            Array.from({ length: 64 }, () => async (transcript, options) => {
              const at = {
                mode: (await readBinding()).mode,
                messages: transcript.messages,
              };
              sent.push(at);
              const next = script.shift();
              if (next === undefined)
                throw new Error("the script has no answer for this request");
              return next(at, options?.signal);
            }),
          );
          return faux.provider;
        },
      });
    };
    const services: StageServices = {
      ctx,
      routes: {
        bindAgentRoute: (input, ctxt) => routes().bindAgentRoute(input, ctxt),
        prepareFinalGeneration: (input, ctxt) =>
          routes().prepareFinalGeneration(input, ctxt),
      },
      capture: (event) => {
        capture(event);
      },
      registry,
      runtimes: contract?.runtimes ?? runtime.registry,
      contractSessions:
        contract?.sessions ??
        contractSessionSlots(
          new Scheduler(8, 8, 8),
          ctx.config.budgets.callsInFlight,
          runId,
        ),
      countTokens: extras.countTokens,
      integrations: { status: "absent", path: "(none)" },
      clients,
      run: extras.traced
        ? (effect, signal) =>
            stageRunner(ctx, clients)(
              Effect.provideService(
                effect,
                Tracer.Tracer,
                runLogTracer(ctx.log),
              ),
              signal,
            )
        : stageRunner(ctx, clients),
      endRound: async ({ generation, decide }, hookContext) => {
        if (harness === undefined) throw new Error("the harness is not open");
        const stop = await harness.commit(decide, hookContext);
        await pauseRound?.(hookContext.abortSignal);
        if (stop) await harness.abortTask(generation, hookContext);
      },
    };
    const kinds = agentKinds(services, {
      prepare: async (taskId) => agentFor(distinct ? taskId : undefined),
    });
    const running = kinds.agentStep.definition.phases.running;
    const step: typeof kinds.agentStep = policy.replayFinalize
      ? {
          definition: {
            ...kinds.agentStep.definition,
            phases: {
              ...kinds.agentStep.definition.phases,
              running: async (task, runtime, c) => {
                const interruption = new Error("replay before terminal commit");
                try {
                  await running(
                    task,
                    {
                      ...runtime,
                      commit: async (...args) => {
                        if (
                          finalizationReplays === 0 &&
                          ctx.log
                            .read()
                            .some(
                              (entry) =>
                                entry.type === "span" &&
                                entry["name"] === "harness.stage.frame",
                            )
                        ) {
                          finalizationReplays++;
                          throw interruption;
                        }
                        return runtime.commit(...args);
                      },
                    },
                    c,
                  );
                } catch (error) {
                  if (error !== interruption) throw error;
                  await running(task, runtime, c);
                }
              },
            },
          },
        }
      : kinds.agentStep;
    const contractPhase = step.definition.phases.contract;
    const instrumentRuntime = (
      runtime: Parameters<typeof contractPhase>[1],
    ): typeof runtime => ({
      ...runtime,
      commit: async (...args) => {
        await contract?.beforeCommit?.(runtime);
        const result = await runtime.commit(...args);
        await contract?.afterCommit?.(runtime);
        return result;
      },
    });
    const instrumented =
      contract?.afterCommit === undefined &&
      contract?.beforeCommit === undefined
        ? step
        : ({
            definition: {
              ...step.definition,
              phases: {
                ...step.definition.phases,
                contract: async (task, runtime, c) =>
                  contractPhase(task, instrumentRuntime(runtime), c),
              },
              abort: async (task, runtime, c) =>
                step.definition.abort(task, instrumentRuntime(runtime), c),
            },
          } satisfies typeof step);
    registry.install(
      defineExtension({ name: "neuve.stages", tasks: [instrumented] }),
    );
    const storage = await openNodeSqliteStorage(database);
    harness = await Harness.open(
      contract?.onClose === undefined
        ? storage
        : exportingStorage(storage, {
            mode: () => "ended",
            onClose: contract.onClose,
          }).storage,
      {
        models,
        registry,
        settings: {
          compaction: { enabled: false },
          // The route provider owns its retries; a refusal here settles at once.
          retry: { maxRetries: 0 },
        },
        conversationCreated: clearInheritedAgentRoute,
      },
      context,
    );
    await routes().restoreAgentRoutes(context);
    await kinds.restore(harness, context);
    return { harness, kinds };
  };

  const start = async (
    opened: Awaited<ReturnType<typeof open>>,
    cutoffAt = Date.now() + 60_000,
    deadline?: number,
  ) => {
    const conversation = await opened.harness.root(context);
    const input: AgentStepInput = {
      kind: "frame",
      params: {},
      cutoffAt,
      ...(deadline === undefined ? {} : { deadline }),
    };
    return opened.harness.commit(
      (tx) =>
        tx.createTask(opened.kinds.agentStep, input, {
          ownership: { kind: "conversation" },
          conversationId: conversation.id,
        }),
      context,
    );
  };

  return {
    policy,
    runtime,
    finalizationReplays: () => finalizationReplays,
    ctx,
    clients,
    agentFor,
    sent,
    script,
    probes,
    backstops,
    events,
    open,
    start,
    scope,
    database,
    journal,
    authority,
    ownership,
    root,
    pauseRound: (pause: typeof pauseRound) => {
      pauseRound = pause;
    },
  };
};

export const toolResults = (messages: ReadonlyArray<Message>) =>
  messages.flatMap((message) =>
    message.role === "toolResult"
      ? [
          {
            name: message.toolName,
            error: message.isError,
            text: message.content
              .map((part) => (part.type === "text" ? part.text : ""))
              .join(""),
          },
        ]
      : [],
  );

export const systemOf = (messages: ReadonlyArray<Message>) => {
  const system = messages.find((message) => message.role === "system");
  return system?.role === "system" ? system : undefined;
};

export const settled = async (harness: Harness, id: TaskId<StageRecord>) => {
  const done = await harness.waitForTask(id, context);
  const outcome = done.state.outcome;
  if (outcome.status !== "completed")
    throw new Error(`step ended ${JSON.stringify(outcome)}`);
  return outcome.result;
};

export const agentConversation = async (harness: Harness) =>
  harness.commit(async (tx) => {
    const page = await tx.scanConversations({}, 32);
    for (const conversation of page.items) {
      const doc = await tx.doc(AgentContextDoc, conversation.id);
      if (doc.step !== null) return conversation.id;
    }
    throw new Error("No agent conversation");
  }, context);
