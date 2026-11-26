// Why (NEU-148, the readers' step keys): a review on another model, at another effort or on another
// provider must never show another route's reading as its own. These read the same reading group
// through the production reading task and agent step, twice over one real Records store (a store
// opened again for each review, as two review processes open it), with pi-ai's faux provider as the
// model (no network), and count what the computation store holds and what the model was asked.
import { Database } from "bun:sqlite";
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
  fauxToolCall,
  type Message,
} from "@earendil-works/pi-ai";
import {
  Harness,
  createRegistry,
  defineExtension,
  type TaskId,
} from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { Context, Effect, Exit, Layer, Scope } from "effect";
import {
  Blobs,
  Computations,
  Store,
  mintUlid,
  storeLocationIn,
  type StoreLocation,
} from "@neuve/records-core";
import { defaultConfig } from "../src/config.ts";
import { McpClients, mcpClientsLayer } from "../src/mcp-client.ts";
import { ventTool } from "../src/pipeline.ts";
import type { RunLog, RunLogRecord } from "../src/run-log.ts";
import { agentRoutes, clearInheritedAgentRoute } from "../src/pi/bindings.ts";
import { erased } from "../src/pi/stages/agent.ts";
import type { AgentStepInput } from "../src/pi/stages/agent-step.ts";
import { agentKinds } from "../src/pi/stages/kinds.ts";
import {
  readingBinds,
  readingTask,
  withStepEffort,
  type ReadingKind,
  type ReadingTaskInput,
  type ReadingTaskResult,
} from "../src/pi/stages/reading-task.ts";
import { stageRunner, type StageServices } from "../src/pi/stages/services.ts";
import { planReadings } from "../src/readings/plan.ts";
import { renderReading } from "../src/readings/reading.ts";
import { assessStep, laneReviewStep } from "../src/readings/steps.ts";
import {
  OPUS_ROUTE,
  SOL_ROUTE,
  type AnyRouteConfig,
  type RouteEffort,
} from "../src/route.ts";
import { mixedRange } from "./fixtures/readings.ts";
import { testRuntimes } from "./pi/stages/fixture.ts";

const directory = mkdtempSync(join(tmpdir(), "readings-route-keys-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const textOf = (value: unknown): string =>
  typeof value === "string"
    ? value
    : Array.isArray(value)
      ? value.map(textOf).join("\n")
      : value !== null && typeof value === "object"
        ? Object.values(value).map(textOf).join("\n")
        : "";

const numbers = (text: string, pattern: RegExp) => [
  ...new Set([...text.matchAll(pattern)].map((match) => Number(match[1]))),
];

const range = mixedRange();
const plan = planReadings({
  hunks: range.hunks,
  structures: range.structures,
  excluded: range.excluded,
});
const hunks = new Map(range.hunks.map((hunk) => [hunk.hunkId, hunk]));
const group = plan.groups[0]!;

/** Every section answered, so no re-read: one step computation per reading. */
const answer = (messages: ReadonlyArray<Message>, call: number) => {
  const text = textOf(messages);
  const sections = numbers(text, /^Section (\d+):/gm);
  const files = numbers(text, /File (\d+)\n/g);
  const submit = (tool: string, value: unknown) =>
    fauxAssistantMessage(
      [fauxToolCall(tool, value as never, { id: `call-${call}` })],
      { stopReason: "toolUse" },
    );
  if (text.includes("You assess changed code"))
    return submit("submit_assess", {
      factors: [],
      requirements: [],
      impact: [],
      classes: [
        { S: sections, c: "l", v: "e", F: [], R: [], person: null, gaps: null },
      ],
    });
  return submit("submit_review", {
    files: files.map((f) => ({ f, checked: "Read the rows.", rows: null })),
    sections: { a: sections, r: [], u: [] },
    comments: [],
    unsure: [],
  });
};

/**
 * One review's reading of the group: the reading task and its agent step on a fresh harness, over the
 * store at `location` opened for this review alone, on `route`. Returns the step computations the
 * reading names and the model calls it made.
 */
const review = async (
  location: StoreLocation,
  kind: ReadingKind,
  route: AnyRouteConfig,
  effort?: RouteEffort,
) => {
  const scope = await Effect.runPromise(Scope.make());
  try {
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
    const rows: Array<RunLogRecord> = [];
    const log: RunLog = {
      path: "(memory)",
      write: (row) => {
        rows.push(row);
      },
      read: () => rows,
    };
    const runId = mintUlid();
    const ctx = {
      location,
      repository: directory,
      runId,
      runKey: "f".repeat(64),
      range: {
        baseRef: "main",
        baseOid: "1".repeat(40),
        headOid: "2".repeat(40),
      },
      cycleId: mintUlid(),
      config: defaultConfig(undefined, route),
      log,
      startedAt: Date.now(),
      reconciliationId: mintUlid(),
      records,
    };
    const run = stageRunner(ctx, clients);
    // The plan as a stored computation, the same in every review.
    const planKey = await run(
      Effect.gen(function* () {
        const computations = yield* Computations.ComputationStore;
        return (yield* computations.run(
          { op: "test.readings-plan", opVersion: 1, inputs: {} },
          Effect.succeed({
            bytes: new TextEncoder().encode(JSON.stringify(plan)),
            mediaType: "application/json",
          }),
        )).computation.key;
      }),
    );

    const models = createModels();
    const registry = createRegistry();
    let calls = 0;
    let harness: Harness | undefined;
    const routes = () =>
      agentRoutes({
        harness: harness!,
        models,
        runId,
        createProvider: (binding) => {
          const faux = fauxProvider({
            api: "faux",
            provider: binding.logicalProvider,
            models: [{ id: binding.physicalModel }],
          });
          faux.setResponses(
            Array.from({ length: 16 }, () => async (transcript) => {
              calls++;
              return answer(transcript.messages, calls);
            }),
          );
          return faux.provider;
        },
      });
    const services: StageServices = {
      ctx,
      runtimes: testRuntimes().registry,
      routes: {
        bindAgentRoute: (input, c) => routes().bindAgentRoute(input, c),
        prepareFinalGeneration: (input, c) =>
          routes().prepareFinalGeneration(input, c),
      },
      capture: () => {},
      registry,
      integrations: { status: "absent", path: "(none)" },
      clients,
      run,
      endRound: async ({ generation, decide }, hookContext) => {
        const stop = await harness!.commit(decide, hookContext);
        if (stop) await harness!.abortTask(generation, hookContext);
      },
    };
    // The readings' steps as run.ts prepares them, at the effort their parameters carry.
    const prepare = async (_taskId: number, input: AgentStepInput) => {
      const step =
        input.kind === "assess"
          ? erased(
              assessStep({
                stage: "verify",
                reading: renderReading(plan, group.id, {
                  for: "assess",
                  hunks,
                  structures: range.structures,
                }),
              }),
            )
          : erased(
              laneReviewStep({
                stage: "verify",
                reading: renderReading(plan, group.id, {
                  for: "lane-review",
                  hunks,
                  structures: range.structures,
                }),
                goal: { goal: "Let callers count parsed items.", doneWhen: [] },
                tools: [],
                keys: { frame: "frame-key", manifest: "manifest-key" },
              }),
            );
      return {
        step: withStepEffort(
          step,
          (input.params as { effort?: RouteEffort }).effort,
        ),
        vent: ventTool(ctx, "verify"),
      };
    };
    const bound = readingBinds(services, { prepare }, true);
    const kinds = agentKinds(bound.services, { prepare: bound.prepare });
    const reading = readingTask(services, kinds.agentStep);
    registry.install(
      defineExtension({
        name: "neuve.stages",
        tasks: [kinds.agentStep, reading],
      }),
    );
    harness = await Harness.open(
      new MemoryStorage(),
      {
        models,
        registry,
        settings: { compaction: { enabled: false }, retry: { maxRetries: 0 } },
        conversationCreated: clearInheritedAgentRoute,
      },
      context,
    );
    await routes().restoreAgentRoutes(context);
    const root = await harness.root(context);
    const input: ReadingTaskInput = {
      kind,
      planKey,
      group: group.id,
      rank: group.rank,
      manifestKey: "manifest-key",
      cutoffAt: Date.now() + 60_000,
      ...(kind === "lane-review"
        ? { frameKey: "frame-key", mapKey: "map-key" }
        : {}),
      ...(effort === undefined ? {} : { effort }),
    };
    const id = (await harness.commit(
      (tx) =>
        tx.createTask(reading, input, {
          ownership: { kind: "conversation" },
          conversationId: root.id,
        }),
      context,
    )) as TaskId<ReadingTaskResult>;
    harness.resume();
    const ended = await harness.waitForTask(id, context);
    await harness.close(context);
    expect(ended.state.outcome?.status).toBe("completed");
    const result = (ended.state.outcome as { result: ReadingTaskResult })
      .result;
    expect(result.notJudged).toEqual([]);
    return { steps: result.steps, calls };
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
};

/** The computations the store holds for one op: the rows two reviews made or shared. */
const stored = (location: StoreLocation, op: string) => {
  const db = new Database(location.database, { readonly: true });
  try {
    return db
      .query("SELECT key, material FROM computations WHERE op = ?")
      .all(op) as Array<{ key: string; material: string }>;
  } finally {
    db.close();
  }
};

const OP = { assess: "harness.assess", "lane-review": "harness.lane-review" };

/** Two reviews of the same group over one store, the first on `a`, the second on `b`. */
const twice = async (
  name: string,
  kind: ReadingKind,
  a: { readonly route: AnyRouteConfig; readonly effort?: RouteEffort },
  b: { readonly route: AnyRouteConfig; readonly effort?: RouteEffort },
) => {
  const location = storeLocationIn(join(directory, name));
  const first = await review(location, kind, a.route, a.effort);
  const second = await review(location, kind, b.route, b.effort);
  return { first, second, rows: stored(location, OP[kind]) };
};

/** A second Anthropic model on the same route: only the model differs. */
const OTHER_MODEL: AnyRouteConfig = { ...OPUS_ROUTE, model: "claude-other" };

// Reason: the records lane's claim that Assess has no model in its key. The route's provider, model
// and effort are in every reading step's key, outside its inputs (`agentStageSpec`): the same route
// reuses the stored reading, another model, effort or provider makes its own.
for (const kind of ["assess", "lane-review"] as const)
  test(`${kind} reuses the stored reading until its route or ceiling changes`, async () => {
    const location = storeLocationIn(join(directory, `${kind}-ceiling`));
    const old = await review(location, kind, {
      ...SOL_ROUTE,
      window: 1_050_000,
    });
    const current = await review(location, kind, SOL_ROUTE);
    const reused = await review(location, kind, SOL_ROUTE);
    expect([old.calls, current.calls, reused.calls]).toEqual([1, 1, 0]);
    expect(current.steps).not.toEqual(old.steps);
    expect(reused.steps).toEqual(current.steps);
    expect(
      stored(location, OP[kind])
        .map(({ material }) => JSON.parse(material).config.contextCeiling)
        .sort((a, b) => a - b),
    ).toEqual([237_500, 525_000]);

    // Each pair differs in one thing only: two computations, the second read by the model.
    const route = (r: AnyRouteConfig, effort?: RouteEffort) =>
      effort === undefined ? { route: r } : { route: r, effort };
    for (const [name, a, b, differs] of [
      ["model", route(OPUS_ROUTE), route(OTHER_MODEL), "model"],
      [
        "effort",
        route(OPUS_ROUTE, "medium"),
        route(OPUS_ROUTE, "high"),
        "reasoning",
      ],
      ["provider", route(OPUS_ROUTE), route(SOL_ROUTE), "provider"],
    ] as const) {
      const pair = await twice(`${kind}-${name}`, kind, a, b);
      expect(pair.first.calls).toBe(1);
      expect(pair.second.calls).toBe(1);
      expect(pair.second.steps).not.toEqual(pair.first.steps);
      expect(pair.rows).toHaveLength(2);
      // The keys differ by the route, never by the inputs: the inputs are the same in both.
      const materials = pair.rows.map(
        (row) =>
          JSON.parse(row.material) as {
            inputs: unknown;
            route: Record<string, string>;
          },
      );
      expect(materials[0]!.inputs).toEqual(materials[1]!.inputs);
      expect(materials[0]!.route[differs]).not.toBe(
        materials[1]!.route[differs],
      );
    }
  }, 60_000);
