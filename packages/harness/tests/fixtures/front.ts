import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { Harness, createRegistry, type Task } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Context, Effect, Exit, Layer, Scope } from "effect";
import {
  Blobs,
  Computations,
  Store,
  mintUlid,
  storeLocationIn,
} from "@neuve/records-core";
import { defaultConfig } from "../../src/config.ts";
import { McpClients, mcpClientsLayer } from "../../src/mcp-client.ts";
import { openRunLog } from "../../src/run-log.ts";
import { precomputeStage, storedOutput } from "../../src/pipeline.ts";
import { Frame } from "../../src/frame.ts";
import { ReviewMap } from "../../src/review-map.ts";
import {
  agentRoutes,
  clearInheritedAgentRoute,
} from "../../src/pi/bindings.ts";
import { RunControlDoc } from "../../src/pi/control.ts";
import { agentKinds } from "../../src/pi/stages/kinds.ts";
import { stageRun } from "../../src/pi/stages/run.ts";
import { frontTask } from "../../src/pi/stages/front-task.ts";
import { finderTask } from "../../src/pi/stages/finder-task.ts";
import { RunSetupDoc } from "../../src/pi/stages/docs.ts";
import {
  stageRunner,
  type StageServices,
} from "../../src/pi/stages/services.ts";

export const runFront = async (
  directory: string,
  stop?: "setup" | "map" | "user-stop" | "native-frame",
  path = "app.ts",
) => {
  const repository = join(directory, "repo");
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", "-C", repository, ...args], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  mkdirSync(repository, { recursive: true });
  git("init", "-q");
  writeFileSync(join(repository, path), "export const value = 1;\n");
  git("add", ".");
  git("commit", "-qm", "base");
  const baseOid = git("rev-parse", "HEAD");
  writeFileSync(join(repository, path), "export const value = 2;\n");
  git("add", ".");
  git("commit", "-qm", "Change the value");
  const headOid = git("rev-parse", "HEAD");
  const location = storeLocationIn(join(directory, "records")),
    scope = await Effect.runPromise(Scope.make());
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
  const integrations = {
    status: "absent",
    path: "(none)",
  } satisfies StageServices["integrations"];
  const clients = Context.get(
    await Effect.runPromise(
      Layer.buildWithScope(mcpClientsLayer(integrations), scope),
    ),
    McpClients,
  );
  const ctx = {
    location,
    repository,
    runId: mintUlid(),
    runKey: "f".repeat(64),
    range: { baseRef: "main", baseOid, headOid },
    cycleId: mintUlid(),
    config: defaultConfig(),
    log: openRunLog(location, mintUlid()),
    startedAt: Date.now(),
    reconciliationId: mintUlid(),
    records,
  };
  const models = createModels(),
    registry = createRegistry(),
    sent: string[] = [];
  let harness: Harness;
  const routes = () =>
    agentRoutes({
      harness,
      models,
      runId: ctx.runId,
      createProvider: (binding) => {
        const faux = fauxProvider({
          provider: binding.logicalProvider,
          models: [{ id: binding.physicalModel }],
        });
        faux.setResponses(
          Array.from({ length: 8 }, () => async (_transcript, options) => {
            sent.push(binding.agent);
            if (stop === "native-frame" && binding.agent === "frame") {
              await new Promise<void>((resolve) => {
                if (options?.signal?.aborted) resolve();
                else
                  options?.signal?.addEventListener("abort", () => resolve(), {
                    once: true,
                  });
              });
            }
            return fauxAssistantMessage(
              [
                fauxToolCall(
                  binding.agent === "frame" ? "submit_frame" : "submit_map",
                  binding.agent === "frame"
                    ? {
                        goal: "Change the exported value",
                        stratum: "nothing",
                        sourceIds: [],
                        doneWhen: [
                          {
                            text: "The exported value is updated",
                            candidateId: null,
                            sectionId: null,
                          },
                        ],
                      }
                    : {
                        groups: [
                          {
                            label: "Value",
                            why: "Updates the exported value.",
                            tier: "core",
                            doneWhen: ["D1"],
                            entries: ["f1"],
                          },
                        ],
                      },
                ),
              ],
              { stopReason: "toolUse" },
            );
          }),
        );
        return faux.provider;
      },
    });
  const services: StageServices = {
    ctx,
    registry,
    integrations,
    clients,
    run: stageRunner(ctx, clients),
    capture: () => {},
    routes: {
      bindAgentRoute: (input, c) => routes().bindAgentRoute(input, c),
      prepareFinalGeneration: (input, c) =>
        routes().prepareFinalGeneration(input, c),
    },
    endRound: async ({ generation, decide }, c) => {
      if (await harness.commit(decide, c))
        await harness.abortTask(generation, c);
    },
  };
  const run = stageRun(services),
    kinds = agentKinds(services, run),
    // Created conversation-owned here, the front task has no review to start finders for.
    front = frontTask(
      services,
      run,
      kinds.agentStep,
      finderTask(services, run, kinds.agentStep),
    );
  const stopPhase: typeof front.definition.phases.setup = async (t, r, c) => {
    await r.commit(async (tx) => {
      const doc = await tx.doc(RunControlDoc);
      doc.stopCause = stop === "user-stop" ? "user-stop" : "cutoff";
      return undefined;
    }, c);
    await front.definition.abort!(t, r, c);
  };
  const task: typeof front =
    stop === undefined || stop === "native-frame"
      ? front
      : {
          definition: {
            ...front.definition,
            phases: {
              ...front.definition.phases,
              [stop === "user-stop" ? "setup" : stop]: stopPhase,
            },
          },
        };
  registry.install({ name: "test.front", tasks: [kinds.agentStep, task] });
  harness = await Harness.open(
    await openNodeSqliteStorage(join(directory, "pi.sqlite")),
    {
      models,
      registry,
      settings: { compaction: { enabled: false }, retry: { maxRetries: 0 } },
      conversationCreated: clearInheritedAgentRoute,
    },
    context,
  );
  try {
    await routes().restoreAgentRoutes(context);
    await kinds.restore(harness, context);
    harness.resume();
    const computed = await services.run(
      precomputeStage(ctx, { integrations, clients }),
    );
    if (computed.key === undefined) throw new Error("Precompute failed");
    const root = await harness.root(context);
    const id = await harness.commit(
      (tx) =>
        tx.createTask(
          task,
          { cutoffAt: Date.now() + 60_000, precompute: computed.key! },
          { ownership: { kind: "conversation" }, conversationId: root.id },
        ),
      context,
    );
    let aborting: Promise<void> | undefined;
    const watch =
      stop === "native-frame"
        ? setInterval(() => {
            if (!sent.includes("frame") || aborting !== undefined) return;
            aborting = (async () => {
              await harness.commit(async (tx) => {
                const doc = await tx.doc(RunControlDoc);
                doc.stopCause = "cutoff";
              }, context);
              await harness.abortTask(id, context);
            })();
          }, 10)
        : undefined;
    const settled = await harness
      .waitForTask(id, context)
      .finally(() => clearInterval(watch));
    await aborting;
    const outcome = settled.state.outcome;
    if (outcome.status !== "completed" && outcome.status !== "aborted")
      throw new Error(JSON.stringify(outcome));
    if (outcome.result === undefined) throw new Error("Missing result");
    return {
      log: ctx.log.read(),
      result: outcome.result,
      sent,
      frame:
        outcome.result.frameKey === null
          ? null
          : await services.run(
              storedOutput(ctx, outcome.result.frameKey, Frame),
            ),
      map:
        outcome.result.mapKey === null
          ? null
          : await services.run(
              storedOutput(ctx, outcome.result.mapKey, ReviewMap),
            ),
      setup: await harness.snapshot(RunSetupDoc, context),
    };
  } finally {
    await harness.close(context);
    await Effect.runPromise(Scope.close(scope, Exit.succeed(undefined)));
  }
};
