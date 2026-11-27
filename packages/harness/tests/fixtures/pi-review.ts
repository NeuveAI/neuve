import { testRuntimes } from "../pi/stages/fixture.ts";
import { runStageOutputs } from "../../src/stage-view.ts";
// Boundary proof: real native tasks, git objects, Records and publisher; only the model is stubbed.
import {
  childOf,
  reviewTask,
  reviewExtension,
} from "../../src/pi/review-task.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type AssistantMessage,
  type Message,
} from "@earendil-works/pi-ai";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Context, Effect, Layer, Scope, Tracer } from "effect";
import type { z } from "zod";
import {
  Blobs,
  Computations,
  Log,
  Store,
  mintUlid,
  storeLocationIn,
} from "@neuve/records-core";
import { defaultConfig } from "../../src/config.ts";
import { RangeManifest, type ManifestHunk } from "../../src/manifest.ts";
import { McpClients, mcpClientsLayer } from "../../src/mcp-client.ts";
import { storedOutput } from "../../src/pipeline.ts";
import { openRunLog, runLogTracer } from "../../src/run-log.ts";
import {
  agentRoutes,
  clearInheritedAgentRoute,
} from "../../src/pi/bindings.ts";
import type { CaptureEvent } from "../../src/pi/capture/types.ts";
import {
  reviewStages,
  stageRunner,
  type StageServices,
} from "../../src/pi/stages/index.ts";

/** One recorded request: the agent it was bound for and what the model was sent. */
export interface Sent {
  readonly agent: string;
  readonly messages: ReadonlyArray<Message>;
}

export const textOf = (messages: ReadonlyArray<Message>) =>
  JSON.stringify(messages);

/** A model turn that calls tools, as the faux provider answers it. */
export const toolTurn = (
  calls: ReadonlyArray<{
    readonly name: string;
    readonly id: string;
    readonly args: Parameters<typeof fauxToolCall>[1];
  }>,
): AssistantMessage =>
  fauxAssistantMessage(
    calls.map((call) => fauxToolCall(call.name, call.args, { id: call.id })),
    { stopReason: "toolUse" },
  );

/** The lines of a request's text, as the model reads them (the request is held as JSON). */
export const linesOf = (messages: ReadonlyArray<Message>) =>
  textOf(messages).split("\\n");

export type Answer = (
  agent: string,
  messages: ReadonlyArray<Message>,
  hunks: ReadonlyArray<ManifestHunk>,
) => AssistantMessage | Promise<AssistantMessage>;

const gitIn =
  (repository: string) =>
  (...args: Array<string>) => {
    const run = Bun.spawnSync(["git", "-C", repository, ...args], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.com",
      },
    });
    if (run.exitCode !== 0) throw new Error(run.stderr.toString());
    return run.stdout.toString().trim();
  };

export const runReview = async (options: {
  readonly directory: string;
  readonly base: Record<string, string>;
  readonly head: Record<string, string>;
  readonly message: string;
  readonly answer: Answer;
  readonly cutoffAfterMs?: number;
  readonly abortReview?: boolean;
  readonly abortBeforeFill?: boolean;
  readonly precomputeDeadline?: boolean;
  /** Called as Publish starts. */
  readonly onPublish?: () => void;
  readonly afterBatchPublished?: (index: number) => void;
  /** Wraps the range's leads computation (`harness.range-leads`), to hold or fail it. */
  readonly leads?: <A, E, R>(
    compute: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, unknown, R>;
  /**
   * Wraps the chunking (`harness.blob-chunks`) of the blobs at these paths: the store work a tree's
   * index is built from, so an unchanged path holds the head-index prefetch and nothing the
   * manifest chunks. Give the test a tree no earlier test in the file built, or the prefetch
   * answers from memory and never reaches it.
   */
  readonly chunks?: {
    readonly paths: ReadonlyArray<string>;
    readonly wrap: <A, E, R>(
      compute: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, unknown, R>;
  };
}) => {
  const repository = join(options.directory, "repo");
  Bun.spawnSync(["git", "init", "-q", "-b", "main", repository]);
  const git = gitIn(repository);
  const commit = (message: string, files: Record<string, string>) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(repository, path, ".."), { recursive: true });
      writeFileSync(join(repository, path), text);
    }
    git("add", "-A");
    git("commit", "-q", "-m", message);
    return git("rev-parse", "HEAD");
  };
  const baseOid = commit("base", options.base);
  const headOid = commit(options.message, options.head);

  const location = storeLocationIn(join(options.directory, "store"));
  const scope = await Effect.runPromise(Scope.make());
  const built = await Effect.runPromise(
    Layer.buildWithScope(
      Computations.layer.pipe(
        Layer.provideMerge(Blobs.layer(location)),
        Layer.provideMerge(Store.layer(location, { create: true })),
        Layer.provideMerge(BunFileSystem.layer),
      ),
      scope,
    ),
  );
  const store = Context.get(built, Computations.ComputationStore);
  const { leads, chunks } = options;
  const wrapOf = (spec: Computations.ComputationSpec) =>
    spec.op === "harness.range-leads"
      ? leads
      : spec.op === "harness.blob-chunks" &&
          chunks?.paths.includes(
            String((spec.config as { path?: unknown } | undefined)?.path),
          )
        ? chunks.wrap
        : undefined;
  const records =
    leads === undefined && chunks === undefined
      ? built
      : Context.add(built, Computations.ComputationStore, {
          ...store,
          run: (spec, compute) => {
            const wrap = wrapOf(spec);
            return store.run(
              spec,
              wrap === undefined ? compute : (wrap(compute) as typeof compute),
            );
          },
        });
  await Effect.runPromise(Effect.provide(Store.prepareForWrite, records));
  const integrations = { status: "absent" as const, path: "(none)" };
  const clients = Context.get(
    await Effect.runPromise(
      Layer.buildWithScope(mcpClientsLayer(integrations), scope),
    ),
    McpClients,
  );
  const runId = mintUlid();
  const log = openRunLog(location, runId);
  const ctx = {
    location,
    repository,
    runId,
    runKey: "f".repeat(64),
    range: { baseRef: "main", baseOid, headOid },
    cycleId: mintUlid(),
    config: defaultConfig(),
    log: {
      ...log,
      write: (record: Parameters<typeof log.write>[0]) => {
        log.write(record);
        if (
          record.type === "publish.waiter" &&
          record["status"] === "published"
        )
          options.afterBatchPublished?.(Number(record["index"]));
      },
    },
    startedAt: Date.now(),
    reconciliationId: mintUlid(),
    records,
  };
  const read = <O>(key: string, schema: z.ZodType<O>) =>
    Effect.runPromise(storedOutput(ctx, key, schema));

  const sent: Array<Sent> = [];
  const timeline: Array<{ event: string; at: number }> = [];
  const actualNow = () => Date.now();
  const started = actualNow();
  let advanced = false;
  let fillFinished = false;
  let enteredFill = () => {};
  const fillEntered = new Promise<void>((resolve) => {
    enteredFill = resolve;
  });
  const cutoffAt = started + (options.cutoffAfterMs ?? 550_000);
  /**
   * The review's clock, the harness's `now`: the real time until the script reaches the cut-off,
   * then the cut-off. The process clock is never moved, so nothing else (Records' monotonic ULIDs,
   * which later tests in the same process read times from) ever sees a future time.
   */
  const now = () => (advanced ? cutoffAt : actualNow());
  const interrupt = async () => {
    if (advanced || !fillFinished) return;
    advanced = true;
    const state = await open().inspect(context);
    const review = state.tasks.find(
      (task) => task.record.kind === "neuve.review",
    );
    if (review !== undefined) await open().abortTask(review.record.id, context);
  };
  const scriptErrors: Array<string> = [];
  /** Extension failures pi reported without failing the calling operation. */
  const reports: Array<string> = [];
  const events: Array<CaptureEvent> = [];
  let hunks: ReadonlyArray<ManifestHunk> = [];
  const models = createModels();
  const registry = createRegistry();
  let harness: Harness | undefined;
  const open = () => {
    if (harness === undefined) throw new Error("the harness is not open");
    return harness;
  };
  const routes = () =>
    agentRoutes({
      harness: open(),
      models,
      runId,
      createProvider: (binding) => {
        const faux = fauxProvider({
          provider: binding.logicalProvider,
          models: [{ id: binding.physicalModel }],
        });
        faux.setResponses(
          Array.from({ length: 20 }, () => (transcript) => {
            sent.push({ agent: binding.agent, messages: transcript.messages });
            timeline.push({ event: binding.agent, at: now() - started });
            try {
              return options.answer(binding.agent, transcript.messages, hunks);
            } catch (error) {
              // A script that cannot answer is the fixture's fault: say so, never hold the step.
              scriptErrors.push(`${binding.agent}: ${String(error)}`);
              throw error;
            }
          }),
        );
        return faux.provider;
      },
    });
  const services: StageServices = {
    ctx,
    routes: {
      bindAgentRoute: (input, ctxt) => routes().bindAgentRoute(input, ctxt),
      prepareFinalGeneration: (input, ctxt) =>
        routes().prepareFinalGeneration(input, ctxt),
    },
    capture: (event) => {
      events.push(event);
    },
    registry,
    runtimes: testRuntimes().registry,
    integrations,
    clients,
    run: (effect, signal) =>
      stageRunner(ctx, clients)(
        effect.pipe(
          Effect.provideService(Tracer.Tracer, runLogTracer(ctx.log)),
        ),
        signal,
      ),
    endRound: async ({ generation, decide }, hookContext) => {
      if (await open().commit(decide, hookContext))
        await open().abortTask(generation, hookContext);
    },
  };
  const stages = reviewStages(services);
  let precomputed: Awaited<ReturnType<typeof stages.precompute>> | undefined;
  const task = reviewTask(
    {
      ...stages,
      front: childOf(stages.front),
      precompute: async (...args) => {
        timeline.push({ event: "precompute", at: now() - started });
        const prepared = await stages.precompute(
          args[0],
          options.precomputeDeadline ? now() : args[1],
        );
        precomputed = prepared;
        if (prepared.facts !== undefined)
          hunks = (await read(prepared.facts.output.manifest, RangeManifest))
            .hunks;
        return prepared;
      },
      fill: async (...args) => {
        if (options.abortBeforeFill) {
          enteredFill();
          await new Promise<never>((_resolve, reject) => {
            const stop = () =>
              reject(
                new DOMException("Review stopped before fill", "AbortError"),
              );
            const signal = args[3];
            if (signal?.aborted) stop();
            else signal?.addEventListener("abort", stop, { once: true });
          });
        }
        timeline.push({ event: "fill.start", at: now() - started });
        const filled = await stages.fill(...args);
        fillFinished = true;
        timeline.push({ event: "fill.end", at: now() - started });
        if (options.abortReview)
          void interrupt().catch((error) => scriptErrors.push(String(error)));
        return filled;
      },
      link: async (...args) => {
        timeline.push({ event: "link", at: now() - started });
        return stages.link(...args);
      },
      publishSettled: async (...args) => {
        timeline.push({ event: "publish", at: now() - started });
        options.onPublish?.();
        return stages.publishSettled!(...args);
      },
      publish: async (...args) => {
        timeline.push({ event: "publish", at: now() - started });
        options.onPublish?.();
        return stages.publish(...args);
      },
    },
    ctx.log,
  );
  registry.install(stages.extension);
  registry.install(reviewExtension(task));
  harness = await Harness.open(
    await openNodeSqliteStorage(join(options.directory, "pi.sqlite")),
    {
      models,
      registry,
      settings: { compaction: { enabled: false }, retry: { maxRetries: 0 } },
      conversationCreated: clearInheritedAgentRoute,
      onReport: (error) => reports.push(String(error)),
      now,
    },
    context,
  );
  let stall: ReturnType<typeof setTimeout> | undefined;
  try {
    await routes().restoreAgentRoutes(context);
    await stages.restore(harness, context);
    const root = await harness.root(context);
    const id = await harness.commit(
      (tx) =>
        tx.createTask(
          task,
          {
            range: ctx.range,
            config: ctx.config,
            runKey: ctx.runKey,
            runId: ctx.runId,
            cycleId: ctx.cycleId,
            generation: 0,
            cutoffAt,
          },
          { ownership: { kind: "conversation" }, conversationId: root.id },
        ),
      context,
    );
    harness.resume();
    if (options.abortBeforeFill) {
      await fillEntered;
      await harness.abortTask(id, context);
    }
    const ended = await Promise.race([
      harness.waitForTask(id, context),
      new Promise<never>((_, reject) => {
        stall = setTimeout(() => {
          void open()
            .inspect(context)
            .then((state) =>
              reject(
                new Error(
                  `Review stalled: ${JSON.stringify({ tasks: state.tasks.map((t) => ({ id: t.record.id, kind: t.record.kind, state: t.record.state })), reports, scriptErrors })}`,
                ),
              ),
            );
        }, 30_000);
      }),
    ]);
    if (scriptErrors.length) throw new Error(scriptErrors.join("; "));
    const tasks = await harness.commit(
      async (tx) => (await tx.scanTasks({}, 1000)).items,
      context,
    );
    const publicationHistory = await Effect.runPromise(
      Log.history({ cycleId: ctx.cycleId, limit: 100_000 }).pipe(
        Effect.provide(records),
      ),
    );
    const manifest = RangeManifest.parse({
      ...(await read(
        (await stages.coverage()).facts!.output.manifest,
        RangeManifest,
      )),
    });
    writeFileSync(
      join(options.directory, "observations.json"),
      JSON.stringify(
        {
          modelCalls: sent.length,
          agents: Object.fromEntries(
            [...new Set(sent.map((s) => s.agent))].map((agent) => [
              agent,
              sent.filter((s) => s.agent === agent).length,
            ]),
          ),
          timeline,
          tasks: tasks.map((t) => ({
            id: t.id,
            kind: t.kind,
            owner: t.owner ?? null,
            status: t.state.status,
          })),
          outcome: ended.state.outcome.status,
        },
        null,
        2,
      ),
    );
    return {
      log: ctx.log,
      readBlob: async (hash: string): Promise<unknown> => {
        const blob = await Effect.runPromise(
          Context.get(records, Blobs.BlobStore).get(hash),
        );
        if (blob._tag === "Pruned") throw new Error(`Blob ${hash} was pruned`);
        return JSON.parse(new TextDecoder().decode(blob.bytes));
      },
      precomputed,
      stageOutputs: await services.run(runStageOutputs(ctx.runId)),
      sent,
      events,
      reports,
      tasks,
      manifest,
      publicationHistory,
      timeline,
      outcome: ended.state.outcome,
      read,
      lookup: (op: string) =>
        services.run(Computations.matchingInputs([{ op, inputs: {} }])),
    };
  } finally {
    clearTimeout(stall);
    await harness.close(context);
    // Return values keep a read function over these services for assertions after the run.
  }
};
