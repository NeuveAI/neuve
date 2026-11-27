// Why (NEU-148 round 27): the briefing is a durable task of its own inside a review. It must wait
// without holding anything, survive a worker stop, run each call once per key, start nothing near
// the cut-off, store nothing for a call it stopped, and reuse what is stored. These drive the
// production briefing task and agent step on a real pi Harness over SQLite (so a worker can stop
// and another open the same storage), with pi-ai's faux provider as the model (no network) and a
// real Records store for the stored answers. Only the front task and the group's Assess are
// stand-ins, and the step is prepared from the fixture's range as run.ts prepares it from stored
// outputs (the seam: `briefingAgent` reads the same values from the store).
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
  defineTask,
  type TaskId,
  type TaskOutcome,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Context, Effect, Layer, Scope } from "effect";
import {
  Blobs,
  Computations,
  Store,
  mintUlid,
  storeLocationIn,
} from "@neuve/records-core";
import { defaultConfig } from "../src/config.ts";
import { McpClients, mcpClientsLayer } from "../src/mcp-client.ts";
import { storedOutput, ventTool, type StageRecord } from "../src/pipeline.ts";
import type { RunLog, RunLogRecord } from "../src/run-log.ts";
import { agentRoutes, clearInheritedAgentRoute } from "../src/pi/bindings.ts";
import { erased } from "../src/pi/stages/agent.ts";
import type { AgentStepInput } from "../src/pi/stages/agent-step.ts";
import {
  BRIEFING_TASK,
  briefingTask,
  type BriefingTaskInput,
  type BriefingTaskResult,
} from "../src/pi/stages/briefing-task.ts";
import { ChildrenDoc } from "../src/pi/stages/docs.ts";
import type { FrontResult } from "../src/pi/stages/front-task.ts";
import { agentKinds } from "../src/pi/stages/kinds.ts";
import {
  readingBinds,
  type ReadingTaskResult,
} from "../src/pi/stages/reading-task.ts";
import type { KindParams } from "../src/pi/stages/run.ts";
import { stageRunner, type StageServices } from "../src/pi/stages/services.ts";
import { reviewBatches, settleBatch } from "../src/readings/batches.ts";
import {
  BRIEFING_SUBMIT,
  BriefingStored,
  briefingContextOf,
  briefingLayout,
  briefingStep,
  digestMaterial,
  partMaterial,
} from "../src/readings/briefing.ts";
import { planReadings, type ReadingPlan } from "../src/readings/plan.ts";
import { mixedRange } from "./fixtures/readings.ts";
import { settledBriefingsOf } from "../src/readings/collect.ts";
import type { ReviewMap } from "../src/review-map.ts";
import {
  FRAME,
  MAP_GROUP,
  decided,
  excluded,
  hunks,
  hunks as fixtureHunks,
  plan as fixturePlan,
  settle,
  structures as fixtureStructures,
} from "./fixtures/briefing.ts";
import { testRuntimes } from "./pi/stages/fixture.ts";

const directory = mkdtempSync(join(tmpdir(), "pi-briefing-task-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const deferred = <T = void>() => {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const untilAborted = (signal: AbortSignal) =>
  new Promise<never>((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
  });

const textOf = (value: unknown): string =>
  typeof value === "string"
    ? value
    : Array.isArray(value)
      ? value.map(textOf).join("\n")
      : value !== null && typeof value === "object"
        ? Object.values(value).map(textOf).join("\n")
        : "";

/** The one reading group the fixture's batch is read in. */
const fixtureGroup = fixturePlan.groups.find((g) =>
  g.keys.some((key) => fixturePlan.sections.some((s) => s.key === key)),
)!;
const plan = fixturePlan;
const group = fixtureGroup;

/** The fixture's Map as Map stores it: one group of all three files, the lockfile excluded. */
const reviewMap: ReviewMap = {
  frame: "frame",
  source: "agent",
  groups: [
    {
      id: MAP_GROUP.id,
      label: MAP_GROUP.label,
      why: MAP_GROUP.why,
      tier: "core",
      doneWhen: ["D1"],
      files: MAP_GROUP.files.map(({ path }) => ({ path, placedBy: "map" })),
      hunkIds: [...MAP_GROUP.hunkIds],
      changedLines: 1,
    },
  ],
  excluded: excluded.map((e) => ({ ...e, by: "fixture", hunkIds: [] })),
  rolledUp: [],
  unlinkedDoneWhen: [],
  gaps: [],
};

const world = async (
  name: string,
  options: {
    /** The plan the briefing reads; the fixture's when absent. */
    readonly plan?: ReadingPlan;
    /** The briefing's own group; the fixture's when absent. */
    readonly group?: ReadingPlan["groups"][number];
    /** The Map; the fixture's one group when absent. */
    readonly map?: ReviewMap;
    /** The range's hunks and structures; the fixture's when absent. */
    readonly hunks?: typeof fixtureHunks;
    readonly structures?: typeof fixtureStructures;
  } = {},
) => {
  const hunks = options.hunks ?? fixtureHunks;
  const structures = options.structures ?? fixtureStructures;
  const plan = options.plan ?? fixturePlan;
  const group = options.group ?? fixtureGroup;
  const map = options.map ?? reviewMap;
  const mapGroupOf = (batch: string) => {
    const held = map.groups.find((g) => g.id === batch)!;
    return {
      id: held.id,
      label: held.label,
      why: held.why,
      files: held.files.map(({ path }) => ({ path })),
      hunkIds: held.hunkIds,
      doneWhen: held.doneWhen,
    };
  };
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
    repository: root,
    runId,
    runKey: "f".repeat(64),
    range: {
      baseRef: "main",
      baseOid: "1".repeat(40),
      headOid: "2".repeat(40),
    },
    cycleId: mintUlid(),
    config: defaultConfig(),
    log,
    startedAt: Date.now(),
    reconciliationId: mintUlid(),
    records,
  };
  const run = stageRunner(ctx, clients);
  const store = (op: string, value: unknown) =>
    run(
      Effect.gen(function* () {
        const computations = yield* Computations.ComputationStore;
        return (yield* computations.run(
          { op, opVersion: 1, inputs: { name } },
          Effect.succeed({
            bytes: new TextEncoder().encode(JSON.stringify(value)),
            mediaType: "application/json",
          }),
        )).computation.key;
      }),
    );
  const planKey = await store("test.briefing-plan", plan);
  const mapKey = await store("test.briefing-map", map);

  // The model: every request it is sent, and a whole answer; `hold` keeps a call in flight.
  const sent: Array<string> = [];
  let hold: ReturnType<typeof deferred> | undefined;
  const answer = async (
    messages: ReadonlyArray<Message>,
    final: boolean,
  ): Promise<AssistantMessage> => {
    const text = textOf(messages);
    sent.push(text);
    if (hold !== undefined) await hold.promise;
    // A digest call answers with no section and the digest, through the one submit tool.
    const digestCall = text.includes("You write a batch digest");
    const sections = [
      ...new Set(
        [...text.matchAll(/^Section (\d+):/gm)].map((m) => Number(m[1])),
      ),
    ];
    // Round 27b: every section is asked for a title and Briefed, and every marked file for a lead.
    const marked =
      /Files with several sections \(write lead\): ([^\n]+)/.exec(text)?.[1] ??
      "";
    const leadPaths = [...marked.matchAll(/(\S+) \(sections [\d, ]+\)/g)].map(
      (m) => m[1]!,
    );
    const value = {
      sections: sections.map((n) => ({
        n,
        title: "Counting parsed items",
        briefed: `Section ${n} changes how items are counted.`,
        explained: {
          before: `Section ${n} did not count.`,
          after: `Section ${n} counts.`,
          terms: [],
          cites: [],
        },
      })),
      leads: leadPaths.map((path) => ({
        path,
        title: "Counting what parsing returns",
        text: "Parsing now counts what it returns.",
      })),
      digest:
        digestCall || text.includes("write the batch digest too")
          ? {
              digest: "The batch lets callers count parsed items.",
              uncertainty: [],
              limitations: [],
            }
          : null,
    };
    return final
      ? fauxAssistantMessage([fauxText(JSON.stringify(value))], {
          stopReason: "stop",
        })
      : fauxAssistantMessage(
          [
            fauxToolCall(BRIEFING_SUBMIT, value as never, {
              id: `c${sent.length}`,
            }),
          ],
          { stopReason: "toolUse" },
        );
  };

  const models = createModels();
  let harness: Harness | undefined;
  const routes = () => {
    if (harness === undefined) throw new Error("the harness is not open");
    return agentRoutes({
      harness,
      models,
      runId,
      createProvider: (binding, readBinding) => {
        const faux = fauxProvider({
          api: "faux",
          provider: binding.logicalProvider,
          models: [{ id: binding.physicalModel }],
        });
        faux.setResponses(
          Array.from(
            { length: 16 },
            () => async (transcript) =>
              answer(
                transcript.messages,
                (await readBinding()).mode.kind === "final",
              ),
          ),
        );
        return faux.provider;
      },
    });
  };
  /** Every route bind (a conversation's model slot) and every step preparation, as made. */
  const binds: Array<{ readonly agent: string; readonly reading: unknown }> =
    [];
  const prepared: Array<AgentStepInput> = [];
  const services = (): StageServices => ({
    ctx,
    runtimes: testRuntimes().registry,
    routes: {
      bindAgentRoute: (input, c) => {
        binds.push({ agent: input.agent, reading: input.reading });
        return routes().bindAgentRoute(input, c);
      },
      prepareFinalGeneration: (input, c) =>
        routes().prepareFinalGeneration(input, c),
    },
    capture: () => {},
    registry: createRegistry(),
    integrations: { status: "absent", path: "(none)" },
    clients,
    run,
    endRound: async ({ generation, decide }, hookContext) => {
      if (harness === undefined) throw new Error("the harness is not open");
      const stop = await harness.commit(decide, hookContext);
      if (stop) await harness.abortTask(generation, hookContext);
    },
  });
  /** A part's step, as `briefingAgent` builds it from the stored plan, Map and Frame. */
  const prepare = async (_taskId: number, input: AgentStepInput) => {
    prepared.push(input);
    const params = input.params as KindParams<"brief">;
    if (params.call === "digest")
      return {
        step: erased(
          briefingStep({
            stage: "verify",
            call: "digest",
            group: params.group,
            material: digestMaterial({
              plan,
              sections: plan.sections
                .filter((s) =>
                  mapGroupOf(params.batch).hunkIds.includes(s.hunkIds[0]!),
                )
                .map((s) => s.key),
              paths: mapGroupOf(params.batch).files.map((f) => f.path),
              hunks,
              context: briefingContextOf(FRAME, mapGroupOf(params.batch)),
              assess: new Map(),
              evidence: [],
              commits: [],
            }),
            hunks,
          }),
        ),
        vent: ventTool(ctx, "verify"),
      };
    const material = partMaterial({
      plan,
      group: params.group,
      part: { sections: params.sections, digest: params.digest === true },
      hunks,
      structures,
      context: briefingContextOf(FRAME, mapGroupOf(params.batch)),
      assess: new Map(),
    });
    return {
      step: erased(
        briefingStep({
          stage: "verify",
          call: "part",
          group: params.group,
          batch: "batch-key",
          material,
          hunks,
        }),
      ),
      vent: ventTool(ctx, "verify"),
    };
  };

  // The front task and the group's Assess: each ends when the test releases it, or is stopped.
  let frontEnd = deferred();
  /** Each group's Assess ends when the test releases that group. */
  let assessEnds = new Map<string, ReturnType<typeof deferred<void>>>();
  const assessEnd = (of: string) => {
    const held = assessEnds.get(of) ?? deferred<void>();
    assessEnds.set(of, held);
    return held;
  };
  const holder = <R>(
    task: string,
    end: (input: { readonly group?: string }) => Promise<void>,
    result: (input: { readonly group?: string }) => R,
  ) =>
    defineTask<{ readonly group?: string }, { phase: "run" }, R>({
      name: task,
      version: 1,
      initial: () => ({ phase: "run" }),
      phases: {
        run: async (t, runtime, c) => {
          await Promise.race([end(t.input), untilAborted(runtime.signal)]);
          await runtime.commit(
            () => ({
              status: "terminal",
              outcome: { status: "completed", result: result(t.input) },
            }),
            c,
          );
        },
      },
      abort: (_task, runtime, c) =>
        runtime.commit(
          () => ({
            status: "terminal",
            outcome: { status: "aborted", reason: "stopped" },
          }),
          c,
        ),
    });
  const front = holder<FrontResult>(
    "test.front",
    () => frontEnd.promise,
    () => ({ frameKey: "frame", mapKey }) as FrontResult,
  );
  const assess = holder<ReadingTaskResult>(
    "test.assess",
    (input) => assessEnd(input.group ?? group.id).promise,
    (input) => ({
      kind: "assess",
      group: input.group ?? group.id,
      steps: [],
      claims: [],
      stages: [],
      notJudged: [],
      failures: [],
    }),
  );

  const storage = join(root, "pi.sqlite");
  /**
   * `older`: in place of the briefing task, a stand-in of the same kind at version 1, as an older
   * build stored it, which runs until it is stopped.
   */
  const open = async (options: { readonly older?: boolean } = {}) => {
    frontEnd = deferred();
    assessEnds = new Map();
    const registry = createRegistry();
    const s = { ...services(), registry };
    const bound = readingBinds(s, { prepare }, true);
    const kinds = agentKinds(bound.services, { prepare: bound.prepare });
    const real = briefingTask(s, kinds.agentStep);
    const briefing =
      options.older === true
        ? (defineTask<BriefingTaskInput, { phase: "run" }, BriefingTaskResult>({
            name: BRIEFING_TASK,
            version: 1,
            initial: () => ({ phase: "run" }),
            phases: {
              run: async (_t, runtime) => untilAborted(runtime.signal),
            },
            abort: (t, runtime, c) =>
              runtime.commit(
                () => ({
                  status: "terminal",
                  outcome: {
                    status: "aborted",
                    reason: "stopped",
                    result: { group: t.input.group, calls: [], stages: [] },
                  },
                }),
                c,
              ),
          }) as unknown as typeof real)
        : real;
    registry.install(
      defineExtension({
        name: "neuve.stages",
        tasks: [kinds.agentStep, briefing, front, assess],
      }),
    );
    harness = await Harness.open(
      await openNodeSqliteStorage(storage),
      {
        models,
        registry,
        settings: { compaction: { enabled: false }, retry: { maxRetries: 0 } },
        conversationCreated: clearInheritedAgentRoute,
      },
      context,
    );
    await routes().restoreAgentRoutes(context);
    harness.resume();
    return { harness, briefing };
  };
  const current = () => {
    if (harness === undefined) throw new Error("the harness is not open");
    return harness;
  };
  /** The front task, the group's Assess, and `count` briefings of the group, in one commit. */
  const create = async (
    briefing: Awaited<ReturnType<typeof open>>["briefing"],
    options: {
      readonly cutoffAt?: number;
      readonly count?: number;
      /** Other groups whose Assess the briefing is given, each released on its own. */
      readonly others?: ReadonlyArray<string>;
      /** Also the group's digest task (`digest.<group>`), as `create` makes it. */
      readonly digests?: boolean;
    } = {},
  ) => {
    const h = current();
    const conversation = await h.root(context);
    const owner = {
      ownership: { kind: "conversation" } as const,
      conversationId: conversation.id,
    };
    return h.commit(async (tx) => {
      const f = await tx.createTask(front, {}, owner);
      const a = await tx.createTask(assess, { group: group.id }, owner);
      const others: Record<string, number> = {};
      for (const other of options.others ?? [])
        others[other] = Number(
          await tx.createTask(assess, { group: other }, owner),
        );
      const input: BriefingTaskInput = {
        planKey,
        group: group.id,
        rank: group.rank,
        manifestKey: "manifest",
        cutoffAt: options.cutoffAt ?? Date.now() + 600_000,
        front: Number(f),
        assess: { [group.id]: Number(a), ...others },
      };
      const briefings: Array<TaskId<BriefingTaskResult>> = [];
      for (let at = 0; at < (options.count ?? 1); at++)
        briefings.push(
          (await tx.createTask(
            briefing,
            input,
            owner,
          )) as TaskId<BriefingTaskResult>,
        );
      const digest =
        options.digests === true
          ? ((await tx.createTask(
              briefing,
              { ...input, role: "digests" },
              owner,
            )) as TaskId<BriefingTaskResult>)
          : undefined;
      return { front: f, assess: a, others, briefings, digest };
    }, context);
  };
  const stateOf = (task: TaskId) =>
    current().commit(async (tx) => (await tx.task(task))?.state, context);
  const until = async (task: TaskId, status: string) => {
    for (let at = 0; at < 1_500; at++) {
      if ((await stateOf(task))?.status === status) return stateOf(task);
      await Bun.sleep(10);
    }
    throw new Error(`task ${Number(task)} never became ${status}`);
  };
  /** Every agent step task the store holds, with its owner and state. */
  const steps = async () =>
    (
      await current().commit(
        async (tx) => (await tx.scanTasks({}, 1000)).items,
        context,
      )
    ).filter((task) => task.kind === "neuve.agent-step");
  /** The `batch` briefing tasks a digest task made, one per shared batch. */
  const batchTasks = async (owner: TaskId) =>
    (
      await current().commit(
        async (tx) => (await tx.scanTasks({}, 1000)).items,
        context,
      )
    ).filter(
      (task) =>
        task.kind === "neuve.briefing" && Number(task.owner) === Number(owner),
    );
  const childrenOf = async (task: TaskId) =>
    (await current().snapshot(ChildrenDoc, task, context))?.children ?? {};
  const result = async (task: TaskId) => {
    const state = await stateOf(task);
    return (state as { outcome?: TaskOutcome<BriefingTaskResult> }).outcome;
  };
  /** The review's briefings as `collect` reads them, from these tasks' outcomes. */
  const briefingsOf = async (task: TaskId, digest?: TaskId) =>
    settledBriefingsOf({
      plan,
      groups: map.groups,
      ended: new Map([
        [`brief.${group.id}`, await result(task)],
        ...(digest === undefined
          ? []
          : [[`digest.${group.id}`, await result(digest)] as const]),
      ]),
      read: (key) =>
        run(storedOutput(ctx, key, BriefingStored)).catch(() => undefined),
    });
  return {
    open,
    create,
    stateOf,
    until,
    steps,
    childrenOf,
    batchTasks,
    result,
    briefingsOf,
    sent,
    rows,
    binds,
    prepared,
    holdCalls: () => {
      hold = deferred();
      return hold;
    },
    releaseFront: () => frontEnd.resolve(),
    releaseAssess: (of: string = group.id) => assessEnd(of).resolve(),
    stop: (task: TaskId) => current().abortTask(task, context),
    inspect: () => current().inspect(context),
    close: async () => {
      await current().close(context);
      harness = undefined;
    },
  };
};

/** The batch of the fixture, settled from a briefing's outcome, while a follow-on is left or not. */
const settledWith = async (
  briefings: Awaited<
    ReturnType<Awaited<ReturnType<typeof world>>["briefingsOf"]>
  >,
  final: boolean,
) => {
  const out = settle(briefings.briefings);
  const decision = decided();
  const batches = reviewBatches({
    plan,
    hunks,
    groups: [MAP_GROUP],
    sections: decision.sections,
  });
  const batch = batches.find((b) => b.mapGroup === MAP_GROUP.id)!;
  return settleBatch({
    key: batch.key,
    batches,
    ended: batch.readings.map((name) => ({ name, ended: true })),
    settled: out,
    sections: decision.sections,

    final,
  });
};

const briefingCalls = (sent: ReadonlyArray<string>) =>
  sent.filter((text) => text.includes("You write the briefing")).length;

// Reason: a waiting briefing must cost nothing and survive a worker stop; its work is done once.
test("it waits on the front task and its Assess with allSettled holding nothing, and after a worker stop resumes and briefs once", async () => {
  const w = await world("wait-and-stop");
  const first = await w.open();
  const ids = await w.create(first.briefing);
  const id = ids.briefings[0]!;
  const waiting = await w.until(id, "waiting");
  // Parked on the front task and its own Assess, both at once, and on nothing else.
  expect(waiting).toMatchObject({
    status: "waiting",
    policy: "allSettled",
    checkpoint: { phase: "wait" },
  });
  expect((waiting as { on: ReadonlyArray<number> }).on.map(Number)).toEqual([
    Number(ids.front),
    Number(ids.assess),
  ]);
  // Holding nothing: no step task (no invocation), no step prepared (no CPU work), no route bound
  // (no model slot), no model call.
  expect(await w.steps()).toEqual([]);
  expect(await w.childrenOf(id)).toEqual({});
  expect(w.prepared).toEqual([]);
  expect(w.binds).toEqual([]);
  expect(w.sent).toEqual([]);
  // The worker stops while it waits; another opens the same storage.
  await w.close();
  await w.open();
  const resumed = await w.until(id, "waiting");
  expect((resumed as { on: ReadonlyArray<number> }).on.map(Number)).toEqual([
    Number(ids.front),
    Number(ids.assess),
  ]);
  expect(await w.steps()).toEqual([]);
  // Its Assess alone ends: it still waits on the front task.
  w.releaseAssess();
  await w.until(ids.assess, "terminal");
  w.releaseFront();
  await w.until(id, "terminal");
  const outcome = await w.result(id);
  expect(outcome?.status).toBe("completed");
  const calls = outcome?.status === "completed" ? outcome.result.calls : [];
  // One part per the layout, each stored once, one model call each, bound as a brief reading.
  const layout = briefingLayout(plan, [MAP_GROUP]);
  expect(calls.map((c) => [c.name, c.state])).toEqual(
    (layout.parts.get(group.id) ?? []).map((_, at) => [`part.${at}`, "stored"]),
  );
  // Each part's step was created once, by this briefing, across the worker stop.
  expect(
    (await w.steps()).filter((step) => Number(step.owner) === Number(id)),
  ).toHaveLength(calls.length);
  expect((await w.steps()).length).toBe(calls.length);
  expect(briefingCalls(w.sent)).toBe(calls.length);
  expect(w.binds.map((b) => b.reading)).toEqual(
    calls.map(() => ({ kind: "brief", rank: group.rank })),
  );
  // The receipt's row per response is labelled by the briefing's kind, not Verify's stage.
  expect(
    w.rows.filter((r) => r.type === "model.call").map((r) => r["stage"]),
  ).toEqual(calls.map(() => "brief"));
  await w.close();
}, 120_000);

// Reason: record 0016. Two reviews that ask for the same part run it once; the other subscribes.
// A follow-on (or a later review) that finds the part stored makes no call at all.
test("one run per key: two briefings of the same part make one model call; a later one, woken inside 60 s of the cut-off, reuses the stored part with no call and no cut", async () => {
  const w = await world("one-run");
  const opened = await w.open();
  const ids = await w.create(opened.briefing, { count: 2 });
  w.releaseAssess();
  w.releaseFront();
  for (const id of ids.briefings) await w.until(id, "terminal");
  const results = await Promise.all(ids.briefings.map((id) => w.result(id)));
  const keys = results.map((outcome) =>
    outcome?.status === "completed"
      ? outcome.result.calls.map((c) => c.key)
      : [],
  );
  expect(keys[0]!.every((key) => key !== null)).toBe(true);
  expect(keys[1]).toEqual(keys[0]!);
  const parts = keys[0]!.length;
  expect(briefingCalls(w.sent)).toBe(parts);
  await w.close();
  // A repeat review: a new worker and a new briefing of the same group, woken inside the 60 s
  // margin (review item 3), find every part stored by its key and reuse it: no call, no cut.
  const before = w.sent.length;
  const again = await w.open();
  const later = await w.create(again.briefing, {
    cutoffAt: Date.now() + 30_000,
  });
  w.releaseAssess();
  w.releaseFront();
  await w.until(later.briefings[0]!, "terminal");
  const reused = await w.result(later.briefings[0]!);
  expect(
    reused?.status === "completed"
      ? reused.result.calls.map((c) => [c.key, c.state])
      : [],
  ).toEqual(keys[0]!.map((key) => [key, "stored"]));
  expect(
    reused?.status === "completed"
      ? reused.result.stages.map((s) => s.status)
      : [],
  ).toEqual(keys[0]!.map(() => "reused"));
  expect(w.sent.length).toBe(before);
  const settledLater = await w.briefingsOf(later.briefings[0]!);
  expect(
    [...settledLater.briefings.sections.values()].map((s) => s.state),
  ).toEqual([...settledLater.briefings.sections.values()].map(() => "written"));
  await w.close();
}, 120_000);

// Reason: ruling 3 and the margin. Within 60 s of the cut-off nothing starts; the batch waits for a
// follow-on, and only a final run publishes it, with the cut gap.
test("inside 60 s of the cut-off with nothing stored it sends nothing: the batch is held as not reached, and a final run publishes it with briefing-cut", async () => {
  const w = await world("margin");
  const opened = await w.open();
  const ids = await w.create(opened.briefing, {
    cutoffAt: Date.now() + 30_000,
  });
  w.releaseAssess();
  w.releaseFront();
  const id = ids.briefings[0]!;
  await w.until(id, "terminal");
  const outcome = await w.result(id);
  expect(outcome?.status).toBe("completed");
  const calls = outcome?.status === "completed" ? outcome.result.calls : [];
  expect(calls.length).toBeGreaterThan(0);
  expect(calls.every((c) => c.state === "not-reached" && c.key === null)).toBe(
    true,
  );
  // Each part's step looked its key up (review item 3), found nothing and was skipped: no model
  // call and no route bound.
  const made = await w.steps();
  expect(made).toHaveLength(calls.length);
  for (const step of made)
    expect(
      (step.state as { outcome?: { result?: StageRecord } }).outcome?.result
        ?.status,
    ).toBe("skipped");
  expect(w.sent).toEqual([]);
  expect(w.binds).toEqual([]);
  const briefings = await w.briefingsOf(id);
  expect(
    [...briefings.briefings.sections.values()].map((s) => s.state),
  ).toEqual([...briefings.briefings.sections.values()].map(() => "cut"));
  expect(await settledWith(briefings, false)).toMatchObject({
    settled: false,
    gap: { kind: "not-reached" },
  });
  const final = await settledWith(briefings, true);
  expect(final.settled).toBe(true);
  if (final.settled)
    expect(
      (final.batch.gaps ?? []).some((g) => g.kind === "briefing-cut"),
    ).toBe(true);
  await w.close();
}, 120_000);

// Reason: a call stopped while the model writes stores nothing, and reads as cut, never completed.
test("stopped mid-call (the cut-off's stop), the part stores nothing and reads as cut", async () => {
  const w = await world("mid-call");
  const opened = await w.open();
  const ids = await w.create(opened.briefing);
  const held = w.holdCalls();
  w.releaseAssess();
  w.releaseFront();
  const id = ids.briefings[0]!;
  for (let at = 0; at < 1_500 && w.sent.length === 0; at++) await Bun.sleep(10);
  expect(w.sent.length).toBeGreaterThan(0);
  // As the host stops a review's children at the cut-off.
  await w.stop(id);
  held.resolve(undefined);
  await w.until(id, "terminal");
  const outcome = await w.result(id);
  expect(outcome?.status).toBe("aborted");
  const calls =
    outcome?.status === "aborted" || outcome?.status === "completed"
      ? (outcome.result?.calls ?? [])
      : [];
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) {
    expect(call.key).toBeNull();
    expect(call.state).not.toBe("stored");
  }
  // No step ended completed with a stored output.
  for (const step of await w.steps()) {
    const state = step.state as {
      status: string;
      outcome?: { status: string; result?: StageRecord };
    };
    expect(state.status).toBe("terminal");
    expect(
      state.outcome?.status === "completed" &&
        (state.outcome.result?.status === "computed" ||
          state.outcome.result?.status === "reused"),
    ).toBe(false);
  }
  const briefings = await w.briefingsOf(id);
  for (const section of briefings.briefings.sections.values())
    expect(section.state).toBe("cut");
  await w.close();
}, 120_000);

// The fixture's three read sections in two groups and two batches: group A holds helper and count,
// group B drop; batch X is helper's alone (A only), batch S is count's and drop's (A and B).
const [helperKey, countKey, dropKey] = ["helper", "count", "drop"].map((name) =>
  fixturePlan.sections.find((s) => s.name === name)!,
);
const twoGroups: ReadingPlan = {
  ...fixturePlan,
  groups: [
    {
      ...fixtureGroup,
      id: "ga",
      paths: ["src/parse.ts"],
      keys: [helperKey!.key, countKey!.key],
    },
    { ...fixtureGroup, id: "gb", paths: ["src/old.ts"], keys: [dropKey!.key] },
  ],
};
const twoBatches: ReviewMap = {
  ...reviewMap,
  groups: [
    {
      ...reviewMap.groups[0]!,
      id: "mx",
      label: "Help the parser",
      files: [{ path: "src/parse.ts", placedBy: "map" }],
      hunkIds: [...helperKey!.hunkIds],
    },
    {
      ...reviewMap.groups[0]!,
      id: "ms",
      label: "Count parsed items",
      files: [
        { path: "src/parse.ts", placedBy: "map" },
        { path: "src/old.ts", placedBy: "map" },
      ],
      hunkIds: [...countKey!.hunkIds, ...dropKey!.hunkIds],
    },
  ],
};
const callOf = (step: { readonly input: unknown }) =>
  ((step.input as AgentStepInput).params as { call?: string }).call;

// Reason: review item 4. A batch waits only on the briefing work it needs. X, group A's alone,
// publishes once A's parts are done, though group B's Assess, which only S's digest needs, runs on.
test("a batch of one group waits only on its own group's parts: X is done while the shared batch's digest still waits on the other group's Assess", async () => {
  const layout = briefingLayout(twoGroups, twoBatches.groups);
  expect(layout.digests.get("mx")).toMatchObject({ kind: "part", group: "ga" });
  expect(layout.digests.get("ms")).toEqual({
    kind: "call",
    group: "ga",
    groups: ["ga", "gb"],
  });
  // What each batch's waiter waits on: X never names B's work or A's digest task.
  const sections = decided().sections;
  const waits = reviewBatches({
    plan: twoGroups,
    hunks,
    groups: twoBatches.groups.map((g) => ({
      ...g,
      files: g.files.map(({ path }) => ({ path })),
    })),
    sections: sections.map((s) => ({
      ...s,
      mapGroup:
        s.section.key === helperKey!.key
          ? "mx"
          : s.cause === "excluded"
            ? s.mapGroup
            : "ms",
    })),
  });
  expect(waits.find((b) => b.mapGroup === "mx")!.readings).toEqual([
    "assess.ga",
    "lane-review.ga",
    "brief.ga",
  ]);
  expect(waits.find((b) => b.mapGroup === "ms")!.readings).toEqual([
    "assess.ga",
    "lane-review.ga",
    "brief.ga",
    "assess.gb",
    "lane-review.gb",
    "brief.gb",
    "digest.ga",
  ]);
  // At the durable task: A's briefing and digest task, B's Assess held.
  const w = await world("one-group-batch", {
    plan: twoGroups,
    group: twoGroups.groups[0]!,
    map: twoBatches,
  });
  const opened = await w.open();
  const ids = await w.create(opened.briefing, {
    others: ["gb"],
    digests: true,
  });
  w.releaseFront();
  w.releaseAssess("ga");
  const brief = await w.until(ids.briefings[0]!, "terminal");
  const outcome = (brief as { outcome?: TaskOutcome<BriefingTaskResult> })
    .outcome;
  expect(
    outcome?.status === "completed"
      ? outcome.result.calls.map((c) => [c.batch, c.call, c.digest, c.state])
      : [],
  ).toEqual([
    ["ms", "part", false, "stored"],
    ["mx", "part", true, "stored"],
  ]);
  // B's Assess still runs, and only the shared digest waits on it.
  expect(
    (await w.stateOf(ids.others["gb"]! as unknown as TaskId))?.status,
  ).toBe("running");
  // The digest task waits on its one per-batch child, which waits on B's Assess alone.
  const digest = await w.until(ids.digest!, "waiting");
  const [child] = await w.batchTasks(ids.digest!);
  expect(child).toBeDefined();
  expect((digest as { on: ReadonlyArray<number> }).on.map(Number)).toEqual([
    Number(child!.id),
  ]);
  const childWaits = await w.until(child!.id, "waiting");
  expect(childWaits).toMatchObject({
    policy: "allSettled",
    checkpoint: { phase: "digests" },
  });
  expect((childWaits as { on: ReadonlyArray<number> }).on.map(Number)).toEqual([
    ids.others["gb"]!,
  ]);
  expect((await w.steps()).some((s) => callOf(s) === "digest")).toBe(false);
  // X's digest was written in its part: settled, it is the agent's with no briefing gap.
  const briefings = await w.briefingsOf(ids.briefings[0]!, ids.digest);
  expect(briefings.briefings.digests.get("mx")).toMatchObject({
    state: "written",
  });
  w.releaseAssess("gb");
  await w.until(ids.digest!, "terminal");
  const ended = await w.result(ids.digest!);
  expect(
    ended?.status === "completed"
      ? ended.result.calls.map((c) => [c.batch, c.call, c.state])
      : [],
  ).toEqual([["ms", "digest", "stored"]]);
  await w.close();
}, 120_000);

// Reason: review N1, the waterfall the design avoids. A digest that needs another group's Assess
// waits on that Assess alone and starts beside its own group's parts, which still run.
test("a shared batch's digest waits only on the groups' Assess and starts while the owner's parts still run", async () => {
  const w = await world("digest-beside-parts", {
    plan: twoGroups,
    group: twoGroups.groups[0]!,
    map: twoBatches,
  });
  const opened = await w.open();
  const ids = await w.create(opened.briefing, {
    others: ["gb"],
    digests: true,
  });
  const held = w.holdCalls();
  w.releaseFront();
  w.releaseAssess("ga");
  // The parts start, and their model calls are in flight (held).
  for (let at = 0; at < 1_500 && w.sent.length === 0; at++) await Bun.sleep(10);
  expect(w.sent.length).toBeGreaterThan(0);
  // The briefing waits on its parts; the digest task on B's Assess alone, never on the parts.
  const parts = (await w.steps()).filter((s) => callOf(s) === "part");
  expect(parts.length).toBe(2);
  const brief = await w.until(ids.briefings[0]!, "waiting");
  expect(
    (brief as { on: ReadonlyArray<number> }).on.map(Number).sort(),
  ).toEqual(parts.map((p) => Number(p.id)).sort());
  await w.until(ids.digest!, "waiting");
  const [child] = await w.batchTasks(ids.digest!);
  const waiting = await w.until(child!.id, "waiting");
  expect((waiting as { on: ReadonlyArray<number> }).on.map(Number)).toEqual([
    ids.others["gb"]!,
  ]);
  // B's Assess ends: the digest starts while both parts are still in their model calls.
  w.releaseAssess("gb");
  let digest: Awaited<ReturnType<typeof w.steps>>[number] | undefined;
  for (let at = 0; at < 1_500 && digest === undefined; at++) {
    digest = (await w.steps()).find((s) => callOf(s) === "digest");
    if (digest === undefined) await Bun.sleep(10);
  }
  expect(digest).toBeDefined();
  for (const part of await w.steps())
    if (callOf(part) === "part") expect(part.state.status).not.toBe("terminal");
  held.resolve(undefined);
  await w.until(ids.briefings[0]!, "terminal");
  await w.until(ids.digest!, "terminal");
  const ended = await w.result(ids.digest!);
  expect(
    ended?.status === "completed"
      ? ended.result.calls.map((c) => [c.call, c.state])
      : [],
  ).toEqual([["digest", "stored"]]);
  await w.close();
}, 120_000);

// Reason: Neuve round 48. A group that owns two shared batches starts each batch's digest as soon
// as that batch's own holding groups' Assess have settled: X (G and H) never waits on J, which
// holds only Y.
test("a digest task owning two shared batches starts each digest once its own batch's Assess have settled", async () => {
  const range = mixedRange();
  const kept = new Set(["src/parse.ts", "src/old.ts", "notes.txt"]);
  const list = range.hunks.filter((h) => kept.has(h.path));
  const read = planReadings({
    hunks: list,
    structures: range.structures,
    excluded: range.excluded,
  });
  const section = (path: string, name: string | null) =>
    read.sections.find((s) => s.path === path && s.name === name)!;
  const [helper, count, drop, notes] = [
    section("src/parse.ts", "helper"),
    section("src/parse.ts", "count"),
    section("src/old.ts", "drop"),
    read.sections.find((s) => s.path === "notes.txt")!,
  ];
  const base = read.groups[0]!;
  const three: ReadingPlan = {
    ...read,
    groups: [
      {
        ...base,
        id: "gg",
        paths: ["src/parse.ts", "notes.txt"],
        keys: [helper!.key, notes!.key],
      },
      { ...base, id: "gh", paths: ["src/parse.ts"], keys: [count!.key] },
      { ...base, id: "gj", paths: ["src/old.ts"], keys: [drop!.key] },
    ],
  };
  const batch = (
    id: string,
    files: ReadonlyArray<string>,
    of: ReadonlyArray<typeof helper>,
  ) => ({
    ...reviewMap.groups[0]!,
    id,
    label: `Batch ${id}`,
    files: files.map((path) => ({ path, placedBy: "map" as const })),
    hunkIds: of.flatMap((s) => [...s!.hunkIds]),
  });
  const map: ReviewMap = {
    ...reviewMap,
    excluded: [],
    groups: [
      batch("mx", ["src/parse.ts"], [helper, count]),
      batch("my", ["notes.txt", "src/old.ts"], [notes, drop]),
    ],
  };
  const layout = briefingLayout(three, map.groups);
  expect(layout.digests.get("mx")).toEqual({
    kind: "call",
    group: "gg",
    groups: ["gg", "gh"],
  });
  expect(layout.digests.get("my")).toEqual({
    kind: "call",
    group: "gg",
    groups: ["gg", "gj"],
  });
  const w = await world("two-shared-digests", {
    plan: three,
    group: three.groups[0]!,
    map,
    hunks: new Map(range.hunks.map((h) => [h.hunkId, h])),
    structures: range.structures,
  });
  const opened = await w.open();
  const ids = await w.create(opened.briefing, {
    count: 0,
    others: ["gh", "gj"],
    digests: true,
  });
  const batchOf = (step: { readonly input: unknown }) =>
    ((step.input as AgentStepInput).params as { batch?: string }).batch;
  w.releaseFront();
  w.releaseAssess("gg");
  w.releaseAssess("gh");
  // X's digest starts while J's Assess still runs; Y's has not started.
  let x: Awaited<ReturnType<typeof w.steps>>[number] | undefined;
  for (let at = 0; at < 1_500 && x === undefined; at++) {
    x = (await w.steps()).find((s) => batchOf(s) === "mx");
    if (x === undefined) await Bun.sleep(10);
  }
  expect(x).toBeDefined();
  expect(
    (await w.stateOf(ids.others["gj"]! as unknown as TaskId))?.status,
  ).toBe("running");
  expect((await w.steps()).some((s) => batchOf(s) === "my")).toBe(false);
  // The digest task itself waits on its two per-batch children, holding no slot.
  const waiting = await w.until(ids.digest!, "waiting");
  expect(waiting).toMatchObject({
    policy: "allSettled",
    checkpoint: { phase: "end" },
  });
  expect((waiting as { on: ReadonlyArray<number> }).on).toHaveLength(2);
  // J's Assess ends: Y's digest starts, and both end stored.
  w.releaseAssess("gj");
  await w.until(ids.digest!, "terminal");
  const ended = await w.result(ids.digest!);
  expect(
    ended?.status === "completed"
      ? ended.result.calls.map((c) => [c.batch, c.call, c.state]).sort()
      : [],
  ).toEqual([
    ["mx", "digest", "stored"],
    ["my", "digest", "stored"],
  ]);
  expect((await w.steps()).filter((s) => batchOf(s) === "my")).toHaveLength(1);
  await w.close();
}, 120_000);

// Reason: the coordinator's round 50 finding. A version-1 briefing task's digest children were agent
// steps; this build reads them as briefing tasks, so a stored version-1 task must never be resumed by
// it. It is held, never run, and a stop ends it orphaned, which the collector reads as failed.
test("a briefing task stored by an older build is never resumed: held as migration_failed, a stop ends it orphaned and its sections read as failed", async () => {
  const w = await world("older-version");
  const older = await w.open({ older: true });
  const ids = await w.create(older.briefing);
  const id = ids.briefings[0]!;
  await w.until(id, "running");
  await w.close();
  // This build opens the same storage.
  await w.open();
  let held: unknown;
  for (let at = 0; at < 500 && held === undefined; at++) {
    const inspection = await w.inspect();
    held = inspection.tasks.find(
      (task) =>
        Number(task.record.id) === Number(id) && task.state.kind === "blocked",
    )?.state;
    if (held === undefined) await Bun.sleep(10);
  }
  expect(held).toMatchObject({ kind: "blocked", reason: "migration_failed" });
  // No step was made and no model was called for it.
  expect(await w.steps()).toEqual([]);
  expect(w.sent).toEqual([]);
  // The review's stop (or its cut-off) aborts it: it ends orphaned, never running this code.
  await w.stop(id);
  const ended = await w.until(id, "terminal");
  expect(
    (ended as { outcome: TaskOutcome<BriefingTaskResult> }).outcome.status,
  ).toBe("orphaned");
  // The collector reads it as a failed briefing: code's text stands, with a briefing-failed gap.
  const read = await w.briefingsOf(id);
  expect(read.briefings.sections.size).toBeGreaterThan(0);
  for (const section of read.briefings.sections.values())
    expect(section.state).toBe("failed");
  await w.close();
}, 120_000);
