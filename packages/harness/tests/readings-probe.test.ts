// Why (NEU-148, the probe): the section readings run inside every review unless the user's settings
// turn them off (`review.sectionReadings: "off"`), and they only record what they produced. These
// hold three boundaries: with the off switch nothing about a review changes (configuration, run
// key, stage keys, no port);
// the readers' reading tasks are created at once, in the review's commit, each once; and the
// collector decides every planned section by the deciding code, forms units from settled sections
// only, and writes run-log rows that carry no model text.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import {
  Harness,
  createRegistry,
  defineExtension,
  defineTask,
  type TaskId,
  type TaskOutcome,
  type Tx,
} from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { Context, Effect, Layer, Option, Scope } from "effect";
import { z } from "zod";
import {
  Blobs,
  Computations,
  Store,
  mintUlid,
  storeLocationIn,
} from "@neuve/records-core";
import {
  PipelineConfig,
  defaultConfig,
  runKeyFor,
  runSpec,
  type ReadingsConfig,
} from "../src/config.ts";
import { AssessedSection } from "@neuve/records-schema";
import { judgementCounts } from "../src/judgement-trace.ts";
import { McpClients, mcpClientsLayer } from "../src/mcp-client.ts";
import {
  agentStageSpec,
  storedOutput,
  type StageRecord,
} from "../src/pipeline.ts";
import { prepareReviewConfig, readingsConfig } from "../src/request.ts";
import type { RunLog, RunLogRecord } from "../src/run-log.ts";
import { Settings } from "../src/settings.ts";
import { reviewStages } from "../src/pi/stages/index.ts";
import { agentKinds } from "../src/pi/stages/kinds.ts";
import {
  READING_TASK,
  ReadingsRunDoc,
  readPlan,
  readingTask,
  remembered,
  failureLabel,
  type ReadingTaskInput,
  type ReadingTaskResult,
} from "../src/pi/stages/reading-task.ts";
import { stageRunner, type StageServices } from "../src/pi/stages/services.ts";
import { ClaimStored, claimKey } from "../src/readings/claims.ts";
import { CODE_GAPS } from "../src/readings/decide.ts";
import {
  planSpec,
  readingsDisclosure,
  readingsPort,
  settledOf,
} from "../src/readings/collect.ts";
import { FindStored } from "../src/find.ts";
import { captureOutlineSource } from "../src/graph-outline.ts";
import { OPUS_ROUTE, zeroUsage, type RouteEffort } from "../src/route.ts";
import {
  addedLines,
  recordedLane,
  type RecordedEntry,
} from "../src/lane-rule.ts";
import type { AgentResult } from "../src/pi/stages/agent.ts";
import type { FrontResult } from "../src/pi/stages/front-task.ts";
import type {
  AssessAnswer,
  LaneReviewAnswer,
} from "../src/readings/answers.ts";
import {
  READING_RECIPE,
  planReadings,
  type ReadingPlan,
} from "../src/readings/plan.ts";
import { renderReading } from "../src/readings/reading.ts";
import { EVIDENCE_RECIPE } from "../src/readings/evidence.ts";
import {
  decisionsIn,
  finderSections,
  replayDecision,
  replayRun,
  runLogsOf,
} from "../src/readings/replay-hold.ts";
import {
  AssessStored,
  LaneReviewStored,
  assessStep,
  laneReviewStep,
  type ReadingProducer,
} from "../src/readings/steps.ts";
import { frame, manifestOf, mapOf } from "./fixtures/link.ts";
import { diff, mixedRange, oidOf, riskRange } from "./fixtures/readings.ts";
import { noStructure, type BlobStructure } from "../src/sections.ts";
import { testRuntimes } from "./pi/stages/fixture.ts";

const directory = mkdtempSync(join(tmpdir(), "readings-probe-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const RANGE = {
  baseRef: "main",
  baseOid: "1".repeat(40),
  headOid: "2".repeat(40),
};

/**
 * The run key of `defaultConfig()` over `RANGE` on this branch's base, before the probe existed
 * (computed there): a run without the setting must keep it.
 */

/** Where every world stores the Frame its readings are collected with: one key for all. */
const FRAME_SPEC: Computations.ComputationSpec = {
  op: "test.frame",
  opVersion: 1,
  inputs: {},
};
const FRAME_KEY = Computations.computationKey(FRAME_SPEC).key;

const PROBE: ReadingsConfig = {
  mode: "probe",
  bounds: { maxFiles: 16, maxCharacters: 48_000, maxItems: 40 },
  recipe: READING_RECIPE,
};

/** A task that only owns the reading tasks, as the review task does. */
const readingOwner = defineTask<object, { phase: "wait" }, object>({
  name: "test.owner",
  version: 1,
  initial: () => ({ phase: "wait" }),
  phases: {
    wait: (_task, runtime, c) =>
      runtime.commit(
        () => ({
          status: "terminal",
          outcome: { status: "completed", result: {} },
        }),
        c,
      ),
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

/** Holds `heldChild` until the test releases it, so its owner stays `completing`. */
let releaseHeld = () => {};
const held = new Promise<void>((resolve) => {
  releaseHeld = resolve;
});
const terminalAbort = (
  _task: unknown,
  runtime: { commit: (change: () => object, c: never) => Promise<unknown> },
  c: never,
) =>
  runtime.commit(
    () => ({
      status: "terminal",
      outcome: { status: "aborted", reason: "stopped" },
    }),
    c,
  );
const heldChild = defineTask<object, { phase: "run" }, object>({
  name: "test.held-child",
  version: 1,
  initial: () => ({ phase: "run" }),
  phases: {
    run: async (_task, runtime, c) => {
      await held;
      await runtime.commit(
        () => ({
          status: "terminal",
          outcome: { status: "completed", result: {} },
        }),
        c,
      );
    },
  },
  abort: terminalAbort as never,
});
/** An owner that starts a held child, then decides its outcome: `completing` while the child runs. */
const finishingOwner = defineTask<
  object,
  { phase: "start" } | { phase: "finish" },
  object
>({
  name: "test.finishing-owner",
  version: 1,
  initial: () => ({ phase: "start" }),
  phases: {
    start: (_task, runtime, c) =>
      runtime.commit(async (tx) => {
        await tx.createTask(
          heldChild,
          {},
          { ownership: { kind: "task", taskId: runtime.taskId } },
        );
        return { status: "running", checkpoint: { phase: "finish" } };
      }, c),
    finish: (_task, runtime, c) =>
      runtime.commit(
        () => ({
          status: "terminal",
          outcome: { status: "completed", result: {} },
        }),
        c,
      ),
  },
  abort: terminalAbort as never,
});

/** A run's context over a fresh Records store, with an in-memory run log. */
const world = async (name: string, config = defaultConfig()) => {
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
  const ctx = {
    location,
    repository: root,
    runId: mintUlid(),
    runKey: "f".repeat(64),
    range: RANGE,
    cycleId: mintUlid(),
    config,
    log,
    startedAt: Date.now(),
    reconciliationId: mintUlid(),
    records,
  };
  const run = stageRunner(ctx, clients);
  const registry = createRegistry();
  const services: StageServices = {
    ctx,
    runtimes: testRuntimes().registry,
    routes: {
      bindAgentRoute: async () => {
        throw new Error("no model in this test");
      },
      prepareFinalGeneration: async () => {},
    },
    capture: () => {},
    registry,
    integrations: { status: "absent", path: "(none)" },
    clients,
    run,
    endRound: async () => {},
  };
  /** Stores a value as a computation of its own; returns its key. */
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
  /** Stores a value under a given computation spec. */
  const storeAt = (spec: Computations.ComputationSpec, value: unknown) =>
    run(
      Effect.gen(function* () {
        const computations = yield* Computations.ComputationStore;
        return (yield* computations.run(
          spec,
          Effect.succeed({
            bytes: new TextEncoder().encode(JSON.stringify(value)),
            mediaType: "application/json",
          }),
        )).computation.key;
      }),
    );
  /**
   * A harness with the reading task installed, never resumed unless a test resumes it: tasks are
   * created, not run. The port reads `readings`, the probe's block unless given.
   */
  const open = async (readings: ReadingsConfig = PROBE) => {
    const kinds = agentKinds(services, {
      prepare: async () => {
        throw new Error("no step runs in this test");
      },
    });
    const task = readingTask(services, kinds.agentStep);
    registry.install(
      defineExtension({
        name: "test.stages",
        tasks: [kinds.agentStep, task, readingOwner, finishingOwner, heldChild],
      }),
    );
    const harness = await Harness.open(
      new MemoryStorage(),
      {
        models: createModels(),
        registry,
        settings: { compaction: { enabled: false }, retry: { maxRetries: 0 } },
      },
      context,
    );
    return { harness, port: readingsPort(services, task, readings) };
  };
  // The Frame collect reads for each unit's Guided rows (round 25).
  await storeAt(FRAME_SPEC, frame);
  return { ctx, run, rows, services, store, storeAt, open };
};

// Reason: the legacy off switch cannot bypass the sole general reviewer in new reviews.
test("new configuration always freezes comprehensive readings and sections, while old frozen JSON is still readable", async () => {
  for (const sectionReadings of ["probe", "off"])
    expect(
      Settings.safeParse({ version: 1, review: { sectionReadings } }).success,
    ).toBe(true);
  expect(
    Settings.safeParse({ version: 1, review: { sectionReadings: "on" } })
      .success,
  ).toBe(false);
  const block = readingsConfig(Option.none());
  expect(block.scopeAndTests).toBe(true);
  expect(
    readingsConfig(
      Option.some({ version: 1, review: { sectionReadings: "off" } }),
    ),
  ).toEqual(block);
  const location = storeLocationIn(join(directory, "config"));
  const frozen = (readings: ReadingsConfig | undefined) =>
    Effect.runPromise(
      prepareReviewConfig({
        location,
        search: {},
        stack: undefined,
        deadline: undefined,
        sections: undefined,
        readings,
      }),
    );
  const normal = await frozen(block);
  const attemptedOff = await frozen(undefined);
  expect(attemptedOff).toEqual(defaultConfig());
  expect(attemptedOff.sections).toBeDefined();
  expect(attemptedOff.readings).toEqual(block);
  expect(runKeyFor(RANGE, normal)).toBe(runKeyFor(RANGE, attemptedOff));
  expect(
    (runSpec(RANGE, normal).config as { readings?: unknown }).readings,
  ).toEqual(block);
  // Legacy parsing never fills an omitted block or relabels an old frozen request.
  const {
    readings: _readings,
    sections: _sections,
    ownership: _ownership,
    ...legacy
  } = normal;
  expect(PipelineConfig.parse(legacy)).toEqual(legacy);
}, 30_000);

/** The readings fixture still gives each hunk the `leads` the manifest no longer holds. */
const withoutLeads = (hunks: ReturnType<typeof mixedRange>["hunks"]) =>
  hunks.map((hunk) => {
    const { leads: _leads, ...rest } = hunk as typeof hunk & {
      leads?: unknown;
    };
    return rest;
  });

/**
 * The Map of a range as the review makes it: every file the plan excludes is on the Map's excluded
 * list with its reason, since the plan is made from that list (`mapOf` names only the lockfile).
 */
const mapFor = (
  hunks: ReturnType<typeof withoutLeads>,
  excluded: ReturnType<typeof mixedRange>["excluded"],
) => {
  const map = mapOf(hunks);
  return {
    ...map,
    excluded: excluded.map(({ path, reason }) => ({
      path,
      reason,
      by: "code" as const,
      hunkIds: hunks.filter((h) => h.path === path).map((h) => h.hunkId),
    })),
  };
};

/** The mixed range's plan, its groups re-ranked: three groups, two of them tied. */
const threeGroups = (): ReadingPlan => {
  const range = mixedRange();
  const plan = planReadings({
    hunks: range.hunks,
    structures: range.structures,
    excluded: range.excluded,
    bounds: { maxItems: 1 },
  });
  expect(plan.groups.length).toBeGreaterThanOrEqual(3);
  return {
    ...plan,
    groups: plan.groups
      .slice(0, 3)
      .map((group, at) => ({ ...group, rank: [100, 900, 900][at]! })),
  };
};

// Reason: no release loop and no duplicate reading.
test("prepare plans before the commit and create makes every reading task of a three-group plan in it, by rank with Assess first, each once", async () => {
  const run = await world("create");
  const range = mixedRange();
  const plan = threeGroups();
  const manifestKey = await run.store(
    "test.manifest",
    manifestOf(withoutLeads(range.hunks)),
  );
  const mapKey = await run.store(
    "test.map",
    mapFor(withoutLeads(range.hunks), range.excluded),
  );
  // The plan as a probe run stores it, under its own key: `prepare` finds it there.
  await run.storeAt(
    planSpec({
      manifestKey,
      bounds: PROBE.bounds,
      source: captureOutlineSource().key,
    }),
    plan,
  );
  const { harness, port } = await run.open();
  const input = {
    frameKey: FRAME_KEY,
    mapKey,
    manifestKey,
    cutoffAt: Date.now() + 60_000,
  };
  // Prepared twice (a replayed phase): the same value, and one plan row.
  const signal = new AbortController().signal;
  const prepared = await port.prepare(input, signal);
  expect(await port.prepare(input, signal)).toEqual(prepared);
  expect(JSON.parse(JSON.stringify(prepared))).toEqual(prepared);
  const root = await harness.root(context);
  // One commit, as the review task's front phase makes it; the same commit calling `create` again
  // (a replayed change) finds every task it made, and so does a later commit.
  const [first, again] = await harness.commit(async (tx) => {
    const owning = await tx.createTask(
      readingOwner,
      {},
      { ownership: { kind: "conversation" }, conversationId: root.id },
    );
    const a = await port.create(tx, prepared, owning);
    const b = await port.create(tx, prepared, owning);
    return [a, b] as const;
  }, context);
  const later = await harness.commit(async (tx) => {
    const owning = (await tx.scanTasks({}, 100)).items.find(
      (t) => t.kind === "test.owner",
    )!.id;
    return port.create(tx, prepared, owning);
  }, context);
  const planKey = (prepared as { plan: string }).plan;
  const [a, b, c] = plan.groups;
  expect(first.map((reading) => reading.name)).toEqual([
    `assess.${b!.id}`,
    `lane-review.${b!.id}`,
    `assess.${c!.id}`,
    `lane-review.${c!.id}`,
    `assess.${a!.id}`,
    `lane-review.${a!.id}`,
  ]);
  expect(again).toEqual(first);
  expect(later).toEqual(first);
  const tasks = await harness.commit(
    async (tx) => (await tx.scanTasks({}, 1000)).items,
    context,
  );
  const readings = tasks.filter((task) => task.kind === READING_TASK);
  expect(readings).toHaveLength(6);
  expect(readings.map((task) => Number(task.id))).toEqual(
    first.map((reading) => Number(reading.task)),
  );
  const inputs = readings.map((task) => task.input as ReadingTaskInput);
  expect(inputs.map((i) => [i.kind, i.group, i.rank])).toEqual([
    ["assess", b!.id, 900],
    ["lane-review", b!.id, 900],
    ["assess", c!.id, 900],
    ["lane-review", c!.id, 900],
    ["assess", a!.id, 100],
    ["lane-review", a!.id, 100],
  ]);
  expect(inputs.every((i) => i.planKey === planKey)).toBe(true);
  // One plan row, with counts only.
  const planned = run.rows.filter((row) => row.type === "readings.plan");
  expect(planned).toHaveLength(1);
  expect(planned[0]).toMatchObject({ plan: planKey, groups: 3, tasks: 6 });
  // No plan can be made (here, no manifest): no task, and the review goes on.
  const none = await port.prepare(
    { ...input, manifestKey: "no-such-manifest" },
    signal,
  );
  expect(none).toMatchObject({ plan: null, tasks: [] });
  expect(
    await harness.commit(
      async (tx) =>
        port.create(
          tx,
          none,
          (await tx.scanTasks({}, 100)).items.find(
            (t) => t.kind === "test.owner",
          )!.id,
        ),
      context,
    ),
  ).toEqual([]);
  await harness.close(context);

  // Reason: the review task calls `create` unguarded inside its own commit, so a value that is not
  // what `prepare` hands over, or a task that cannot be created, must leave no reading and one row
  // that says where, never throw and never carry the error's words.
  const broken = {
    doc: async () => ({ plan: null, unavailable: null, tasks: {} }),
    createTask: async () => {
      throw new Error("BROKEN-MARK the store is gone");
    },
  } as unknown as Tx;
  const owner = 1 as Parameters<typeof port.create>[2];
  expect(await port.create(broken, prepared, owner)).toEqual([]);
  expect(await port.create(broken, { not: "prepared" }, owner)).toEqual([]);
  const failures = run.rows.filter((row) => row.type === "readings.create");
  expect(
    failures.map(({ type, failed, step }) => ({ type, failed, step })),
  ).toEqual([
    { type: "readings.create", failed: true, step: "task" },
    { type: "readings.create", failed: true, step: "input" },
  ]);
  expect(JSON.stringify(failures)).not.toContain("BROKEN-MARK");
}, 30_000);

// Reason: the review still calls `prepare` with the Frame and Map keys, and the timeline lane will
// call it with the front task instead, before either exists; both forms must work, give the same
// plan, and a replayed `create` must find the same tasks under either.
test("prepare takes both input forms with no Map in the store: the keys go on Lane review tasks only, the front task on every task, and a replayed create finds each task", async () => {
  type Listed = {
    plan: string;
    tasks: Array<{ name: string; input: ReadingTaskInput }>;
  };
  for (const form of ["today", "early"] as const) {
    const run = await world(`forms-${form}`);
    const range = mixedRange();
    const manifestKey = await run.store(
      "test.manifest",
      manifestOf(withoutLeads(range.hunks)),
    );
    // The plan as a probe run stores it: its key names the manifest only, so no Map is needed.
    await run.storeAt(
      planSpec({
        manifestKey,
        bounds: PROBE.bounds,
        source: captureOutlineSource().key,
      }),
      threeGroups(),
    );
    const { harness, port } = await run.open();
    const signal = new AbortController().signal;
    const cutoffAt = Date.now() + 60_000;
    // Neither key names a stored computation: `prepare` reads no Frame and no Map.
    const today = (await port.prepare(
      { frameKey: "no-frame", mapKey: "no-map", manifestKey, cutoffAt },
      signal,
    )) as Listed;
    const early = (await port.prepare(
      { manifestKey, cutoffAt, front: 4242 as TaskId<FrontResult> },
      signal,
    )) as Listed;
    expect(today.plan).toEqual(expect.any(String));
    expect(early.plan).toBe(today.plan);
    expect(early.tasks.map((t) => t.name)).toEqual(
      today.tasks.map((t) => t.name),
    );
    expect(today.tasks).toHaveLength(6);
    for (const { input } of today.tasks) {
      expect(input.front).toBeUndefined();
      expect([input.frameKey, input.mapKey]).toEqual(
        input.kind === "lane-review"
          ? ["no-frame", "no-map"]
          : [undefined, undefined],
      );
    }
    // The early form: no keys anywhere, and the front task's ID on every reading task. A Lane review
    // waits on it; an Assess task only looks at it, and never waits.
    for (const { input } of early.tasks) {
      expect(input.front).toBe(4242);
      expect([input.frameKey, input.mapKey]).toEqual([undefined, undefined]);
    }
    expect(run.rows.filter((row) => row.type === "readings.plan")).toHaveLength(
      1,
    );

    // This form's `create`, twice in one commit (a replayed change) and again in a later commit:
    // the same tasks each time, created once, each with the input `prepare` listed.
    const prepared = form === "today" ? today : early;
    const root = await harness.root(context);
    const owner = await harness.commit(
      (tx) =>
        tx.createTask(
          readingOwner,
          {},
          { ownership: { kind: "conversation" }, conversationId: root.id },
        ),
      context,
    );
    const [first, again] = await harness.commit(
      async (tx) =>
        [
          await port.create(tx, prepared, owner),
          await port.create(tx, prepared, owner),
        ] as const,
      context,
    );
    const later = await harness.commit(
      (tx) => port.create(tx, prepared, owner),
      context,
    );
    expect(first.map((r) => r.name)).toEqual(prepared.tasks.map((t) => t.name));
    expect(again).toEqual(first);
    expect(later).toEqual(first);
    const stored = (
      await harness.commit(
        async (tx) => (await tx.scanTasks({}, 1000)).items,
        context,
      )
    ).filter((task) => task.kind === READING_TASK);
    expect(stored.map((task) => Number(task.id))).toEqual(
      first.map((r) => Number(r.task)),
    );
    expect(stored.map((task): unknown => task.input)).toEqual(
      prepared.tasks.map((t) => t.input),
    );
    await harness.close(context);
  }
}, 30_000);

const result = <O>(output: O): AgentResult<O> => ({
  agent: "reading.test",
  stage: "verify",
  status: "submitted",
  output,
  endedBy: "submit",
  turnsUsed: 1,
  turnLimit: 1,
  finalGeneration: false,
  usage: zeroUsage,
  costUsd: null,
  resumedTurns: 0,
  restarted: false,
  modelCalls: 1,
});

const MARKS = {
  defect: "COMMENT-MARK the count drops its last item",
  risk: "COMMENT-MARK a caller may rely on the old length",
  unsure: "UNSURE-MARK the callers were not shown",
  requirement: "REQ-MARK counting returns every parsed item",
  checked: "CHECKED-MARK read the rows and the callers",
  reason: "REASON-MARK the cited line drops the item",
  finder: "FINDER-MARK a caller may pass an empty text",
  lean: "LEAN-MARK no person adds anything here",
  gapKind: "GAPKIND-MARK parser-callers",
  gap: "GAP-MARK the parser's callers were not shown",
};

// Reason: the probe's numbers come from these rows, and model content must not leave the run.
test("collect decides every planned section as the deciding code does, forms units from settled sections only, and writes one model-free row per section", async () => {
  const run = await world("collect");
  const range = mixedRange();
  const plan = planReadings({
    hunks: range.hunks,
    structures: range.structures,
    excluded: range.excluded,
    bounds: { maxItems: 4 },
  });
  // A group of four sections (the code files), and another group (the text and the guide).
  const A = plan.groups.find((group) => group.keys.length === 4);
  const B = plan.groups.find((group) => group !== A);
  expect(A).toBeDefined();
  expect(B).toBeDefined();
  const planKey = await run.store("test.readings-plan", plan);
  // The readings fixture still gives each hunk the `leads` the manifest no longer holds.
  const manifestHunks = range.hunks.map((hunk) => {
    const { leads: _leads, ...rest } = hunk as typeof hunk & {
      leads?: unknown;
    };
    return rest;
  });
  const manifestKey = await run.store(
    "test.manifest",
    manifestOf(manifestHunks),
  );
  // Two Map groups (batches): one over group A's files, one over everything else the map holds.
  const base = mapFor(manifestHunks, range.excluded);
  const inA = (path: string) => A!.paths.includes(path);
  const mapped = base.groups[0]!;
  const mapKey = await run.store("test.map", {
    ...base,
    groups: [
      {
        ...mapped,
        id: "m1",
        files: mapped.files.filter((f) => inA(f.path)),
        hunkIds: manifestHunks
          .filter((h) => inA(h.path) && mapped.hunkIds.includes(h.hunkId))
          .map((h) => h.hunkId),
      },
      {
        ...mapped,
        id: "m2",
        files: mapped.files.filter((f) => !inA(f.path)),
        hunkIds: manifestHunks
          .filter((h) => !inA(h.path) && mapped.hunkIds.includes(h.hunkId))
          .map((h) => h.hunkId),
      },
    ],
  });
  const hunks = new Map(range.hunks.map((hunk) => [hunk.hunkId, hunk]));
  const sources = { hunks, structures: range.structures };

  // Group A's Assess: every section but the fourth answered; the first rests on a requirement.
  const assess = assessStep({
    stage: "verify",
    reading: renderReading(plan, A!.id, { for: "assess", ...sources }),
  });
  const review = laneReviewStep({
    stage: "verify",
    reading: renderReading(plan, A!.id, { for: "lane-review", ...sources }),
    goal: { goal: "Let callers count parsed items.", doneWhen: [] },
    tools: [],
    keys: { frame: "frame-key", manifest: manifestKey },
  });
  const index = renderReading(plan, A!.id, {
    for: "lane-review",
    ...sources,
  }).index;
  const at = (s: number) => {
    const section = index.sections.find((x) => x.index === s)!;
    const owned = section.owned[0]!;
    return {
      side: owned.side,
      line: owned.startLine,
      cite: `${section.file}${owned.side === "new" ? "n" : "o"}${owned.startLine}`,
    };
  };
  const assessAnswer: AssessAnswer = {
    factors: [],
    requirements: [
      {
        t: MARKS.requirement,
        kinds: ["test-run"],
        cites: [at(1).cite],
        testable: true,
        untested: "",
        proof: [],
        agree: true,
      },
    ],
    impact: [],
    classes: [
      // Complex and easy, with the reading's word on a person: the lean the lane rule reads.
      {
        S: [2, 3],
        c: "h",
        v: "e",
        F: [],
        R: [],
        person: { need: "no", why: MARKS.lean },
        gaps: null,
      },
      // A gap of the reading's own beside the relations gap code adds to this undeclared section.
      {
        S: [1],
        c: "l",
        v: "e",
        F: [],
        R: [0],
        person: null,
        gaps: [{ axis: "complexity", kind: MARKS.gapKind, t: MARKS.gap }],
      },
    ],
  };
  // A first answer sent back (a cite of lines no section owns, a section left out): its problem
  // classes reach the call's row as counts, its cite and its words never.
  expect(
    assess.spec.check!({
      ...assessAnswer,
      factors: [
        { f: "connections", t: "SENTBACK-MARK two callers", cites: ["9n77"] },
      ],
    }),
  ).not.toEqual([]);
  const assessKey = await run.store(
    "test.assess",
    AssessStored.parse(
      assess.compose({
        ...result(assess.spec.repair!(assessAnswer)),
        repairedFrom: assessAnswer,
      }),
    ),
  );
  // Group A's Lane review: approve, a confirmed defect, unsure, approve.
  const files = [...new Set(index.sections.map((s) => s.file))];
  const reviewAnswer: LaneReviewAnswer = {
    files: files.map((f) => ({ f, checked: MARKS.checked, rows: null })),
    sections: { a: [1, 4], r: [2], u: [3] },
    comments: [
      {
        s: 1,
        side: at(1).side,
        start: at(1).line,
        end: at(1).line,
        kind: "risk",
        effect: null,
        t: MARKS.risk,
        cites: [at(1).cite],
        fails: "",
        row: null,
      },
      {
        s: 2,
        side: at(2).side,
        start: at(2).line,
        end: at(2).line,
        kind: "defect",
        effect: null,
        t: MARKS.defect,
        cites: [at(2).cite],
        fails: "The last item is dropped on every call.",
        row: null,
      },
    ],
    unsure: [{ s: 3, t: MARKS.unsure }],
  };
  expect(review.spec.check!(reviewAnswer)).toEqual([]);
  const reviewKey = await run.store(
    "test.lane-review",
    LaneReviewStored.parse(review.compose(result(reviewAnswer))),
  );
  // The sections in the reading's own numbering: section 1 first.
  const keys = index.sections.map((section) => section.key);
  const defect = claimKey({
    path: plan.sections.find((s) => s.key === keys[1])!.path,
    side: at(2).side,
    startLine: at(2).line,
    endLine: at(2).line,
    text: MARKS.defect,
  });
  const claimed = await run.store(
    "test.claim",
    ClaimStored.parse({
      decision: "keep",
      reason: MARKS.reason,
      claim: defect,
      section: keys[1],
      source: "agent",
    }),
  );
  const recordOf = (
    agent: string,
    key?: string,
    usage?: AgentResult<unknown>["usage"],
    reused = false,
  ): StageRecord => {
    const { output: _output, ...summary } = {
      ...result(null),
      usage: usage ?? zeroUsage,
    };
    return {
      stage: "verify",
      agent,
      status:
        key === undefined ? "interrupted" : reused ? "reused" : "computed",
      ...(key === undefined ? {} : { key }),
      wallMs: 1,
      ...(usage === undefined ? {} : { agentResult: summary }),
    };
  };
  const completed = (
    value: ReadingTaskResult,
  ): TaskOutcome<ReadingTaskResult> => ({ status: "completed", result: value });
  const readings = [
    {
      name: `assess.${A!.id}`,
      outcome: completed({
        kind: "assess",
        group: A!.id,
        steps: [assessKey],
        claims: [],
        // The route reported reasoning tokens for this call.
        stages: [
          recordOf(`assess.${A!.id}`, assessKey, {
            ...zeroUsage,
            input: 1_200,
            cacheRead: 300,
            // Written to the provider's cache: part of the call's input, beside the other two.
            cacheWrite5m: 200,
            cacheWrite1h: 5_000,
            output: 240,
            thinking: 60,
          }),
        ],
        notJudged: [{ section: keys[3]!, cause: "failed" }],
        // Its re-read of the fourth section failed at the provider.
        failures: [{ part: "reread", failure: "invalid_request" }],
      }),
    },
    {
      name: `lane-review.${A!.id}`,
      outcome: completed({
        kind: "lane-review",
        group: A!.id,
        steps: [reviewKey],
        claims: [
          {
            key: defect,
            section: keys[1]!,
            verifyKey: claimed,
            reached: true,
          },
        ],
        stages: [
          // This route reports no reasoning tokens.
          recordOf(`lane-review.${A!.id}`, reviewKey, {
            ...zeroUsage,
            input: 900,
            output: 180,
          }),
          // The claim's check was reused from an earlier run.
          recordOf(
            `verify.claim.${defect.slice(0, 12)}`,
            claimed,
            undefined,
            true,
          ),
        ],
        notJudged: [],
      }),
    },
    // Group B: Assess stopped before it returned anything; Lane review cut off before it read.
    {
      name: `assess.${B!.id}`,
      outcome: { status: "aborted", reason: "cutoff" } as TaskOutcome<unknown>,
    },
    {
      name: `lane-review.${B!.id}`,
      outcome: {
        status: "aborted",
        reason: "cutoff",
        result: {
          kind: "lane-review",
          group: B!.id,
          steps: [],
          claims: [],
          stages: [recordOf(`lane-review.${B!.id}`)],
          notJudged: B!.keys.map((section) => ({
            section,
            cause: "not-reached",
          })),
        },
      } as TaskOutcome<unknown>,
    },
  ];
  // A finder's kept risk on the first section's lines: a comment on its unit, never a row's text.
  const first = plan.sections.find((s) => s.key === keys[0])!;
  const findKey = await run.store(
    "test.find",
    FindStored.parse({
      lens: "risky-edges",
      source: "agent",
      findings: [
        {
          id: "risky-edges.1",
          lens: "risky-edges",
          hunkId: first.hunkIds[0],
          claim: MARKS.finder,
          kind: "risk",
          about: "code",
          signal: null,
          critical: false,
          anchors: [
            {
              path: first.path,
              side: at(1).side,
              startLine: at(1).line,
              endLine: at(1).line,
            },
          ],
          doneWhen: null,
          // Another Map group's id: placement is by anchor alone.
          group: "m2",
          evidence: [first.hunkIds[0]],
        },
      ],
      notes: [],
      reading: { used: 0, limit: 1 },
    }),
  );
  const { harness, port } = await run.open();
  await harness.commit(async (tx) => {
    (await tx.doc(ReadingsRunDoc)).plan = planKey;
    return undefined;
  }, context);
  const collected = await port.collect(
    {
      frameKey: FRAME_KEY,
      mapKey,
      manifestKey,
      readings,
      finders: [
        {
          lens: "risky-edges",
          findKey,
          findings: [
            { id: "risky-edges.1", verifyKey: "verify-key", status: "kept" },
          ],
          stages: [],
          end: { find: "completed", verify: "completed" },
        },
      ],
    },
    harness,
    context,
    new AbortController().signal,
  );
  await harness.close(context);

  const sections = run.rows.filter((row) => row.type === "reading.section");
  expect(sections).toHaveLength(plan.sections.length + plan.unread.length);
  const row = (key: string) =>
    sections.find((entry) => entry["section"] === key)!;
  // The judged approval: settled with a verdict, and its lane from rule 3 (the relations gap of
  // an undeclared section sends it to human-suggested).
  expect(row(keys[0]!)).toMatchObject({
    state: "settled",
    verdict: "approve",
    cause: null,
    lane: { applied: "human-suggested" },
    comments: { shown: 1, belowCut: 0, refuted: 0, unranked: 0 },
  });
  // The confirmed defect: a request for changes resting on it.
  expect(row(keys[1]!)).toMatchObject({
    state: "settled",
    verdict: "request-changes",
    cause: null,
    claimFates: { confirmed: 1, refuted: 0, unconfirmed: 0 },
    comments: { shown: 1 },
  });
  // Its claim by anchor and outcome only, resting the request for changes.
  const owner = plan.sections.find((s) => s.key === keys[1])!;
  expect(row(keys[1]!)["claims"]).toEqual([
    {
      key: defect,
      path: owner.path,
      side: at(2).side,
      startLine: at(2).line,
      endLine: at(2).line,
      source: "lane-review",
      verify: "confirmed",
      restsOn: true,
    },
  ]);
  expect(row(keys[0]!)["claims"]).toEqual([]);
  // Unsure: undecided, so human-required, with no verdict.
  expect(row(keys[2]!)).toMatchObject({
    state: "settled",
    verdict: null,
    cause: "unsure",
    reading: "lane-review",
    lane: { judged: expect.any(String), applied: "human-required" },
  });
  // Assess failed: undecided on Assess, human-required; the review's approval still stands as a verdict.
  expect(row(keys[3]!)).toMatchObject({
    state: "settled",
    verdict: "approve",
    cause: "failed",
    reading: "assess",
    lane: { judged: null, applied: "human-required" },
  });
  // Not reached: not settled, no lane, waiting for the next generation.
  for (const key of B!.keys)
    expect(row(key)).toMatchObject({
      state: "waiting",
      lane: null,
      verdict: null,
      cause: "not-reached",
      reading: "assess",
    });
  // Too large to read and unreadable: settled, undecided, human-required with that cause.
  // Excluded: settled with no reading, in today's lane for such a file, in the generated batch.
  for (const unread of plan.unread)
    expect(row(unread.key)).toMatchObject(
      unread.cause === "excluded"
        ? {
            state: "settled",
            cause: "excluded",
            reading: null,
            verdict: null,
            lane: { judged: null, applied: "human-suggested" },
          }
        : {
            state: "settled",
            cause: unread.cause,
            reading: "assess",
            lane: { applied: "human-required" },
          },
    );
  const unreadCount = (cause: string) =>
    plan.unread.filter((u) => u.cause === cause).length;
  expect(unreadCount("too-large")).toBe(1);
  expect(unreadCount("unreadable")).toBe(2);
  expect(row(keys[0]!)["owned"]).toEqual(
    plan.sections
      .find((s) => s.key === keys[0])!
      .owned.map(
        (r) =>
          `${plan.sections.find((s) => s.key === keys[0])!.path}:${r.side}:${r.startLine === r.endLine ? r.startLine : `${r.startLine}-${r.endLine}`}`,
      ),
  );

  // Reason (round 2g): another lane scores runs from these rows. Each settled section's row
  // carries its entry reduced to what the lane rule reads, and the trail on the row is that rule
  // run again on it; an excluded file carries the map's reason. No text of any kind: the
  // requirement's words and the lean's reason are empty strings, read only into a note no row has.
  const trail = (value: ReturnType<typeof recordedLane>) => ({
    judged: value.judged,
    surfaced: value.surfaced,
    floors: value.floors,
    applied: value.applied,
  });
  let rerun = 0;
  for (const section of [...plan.sections, ...plan.unread]) {
    const entry = row(section.key);
    if (entry["state"] !== "settled") {
      expect(entry["entry"]).toBeNull();
      expect(entry["lane"]).toBeNull();
      continue;
    }
    const own = section.hunkIds.map((id) => hunks.get(id)!);
    const added = addedLines(
      section.owned
        .filter((r) => r.side === "new")
        .map((r) => ({
          kind: "lines",
          path: own[0]?.newPath ?? section.path,
          ...r,
        })),
      own,
    );
    expect(trail(recordedLane(entry["entry"] as RecordedEntry, added))).toEqual(
      entry["lane"] as ReturnType<typeof trail>,
    );
    rerun++;
    expect(entry["excluded"]).toEqual(
      "cause" in section && section.cause === "excluded"
        ? {
            reason: range.excluded.find((e) => e.path === section.path)!.reason,
          }
        : null,
    );
  }
  expect(rerun).toBe(sections.filter((r) => r["state"] === "settled").length);
  // The mix covers every branch the rule reads: a judged entry with a requirement and its
  // coverage, a lean, code's gaps, an undecided one and an excluded file.
  expect(row(keys[0]!)["entry"]).toEqual({
    assess: {
      complexity: { level: "low", factors: [] },
      easeOfValidation: {
        level: "easy",
        requirements: [
          {
            cites: [expect.stringMatching(/^src\/[a-z.]+:(new|old):\d+-\d+$/)],
            coverage: "missing",
            requirement: "",
          },
        ],
      },
      // The finder's kept risk about code, a move the rule reads (14.28).
      movement: [
        {
          signal: "kept-finding",
          axis: "complexity",
          direction: "toward-human",
          cites: [expect.any(String)],
        },
      ],
      lean: null,
      gaps: [
        { axis: "complexity", kind: "model" },
        { axis: "ease-of-validation", kind: "relations-unavailable" },
      ],
    },
    lane: { floors: [] },
  });
  // Reason (round 2h): another lane scores "the lane by the model's levels alone" from these rows,
  // so each gap names whether code wrote it, as a closed label: code's own kind, else `model`,
  // never the reading's words. Leaving code's gaps out of a row's entry and running the rule again
  // gives the lane the section has without them: the first section keeps human-suggested, by the
  // reading's own gap; the second (high and easy, the reading saying no person is needed) goes to
  // agentic, as `laneOf` gives such an assessment with no gap. The second requests changes on a
  // confirmed defect, so under lane rule 5 its stored lane is human-required by the verdict's moves
  // (14.34); the levels-alone lane leaves those moves out with code's gaps.
  const withoutCode = (key: string) => {
    const entry = row(key)["entry"] as {
      assess: {
        gaps: ReadonlyArray<{ axis: string; kind: string }>;
        movement: ReadonlyArray<{ signal: string }>;
      };
    };
    return {
      ...entry,
      assess: {
        ...entry.assess,
        gaps: entry.assess.gaps.filter(
          (gap) => !CODE_GAPS.some((own) => own.kind === gap.kind),
        ),
        movement: entry.assess.movement.filter(
          (move) => move.signal !== "confirmed-request-changes",
        ),
      },
    } as unknown as RecordedEntry;
  };
  expect(
    (row(keys[1]!)["entry"] as { assess: { gaps: unknown } }).assess.gaps,
  ).toEqual([{ axis: "ease-of-validation", kind: "relations-unavailable" }]);
  expect(
    [keys[0]!, keys[1]!].map((key) => [
      // The judged lane: the rule's lane before the added lines and the floors.
      (row(key)["lane"] as { judged: string }).judged,
      recordedLane(withoutCode(key), []).judged,
    ]),
  ).toEqual([
    ["human-suggested", "human-suggested"],
    ["human-required", "agentic"],
  ]);
  const rowsText = JSON.stringify(run.rows);
  expect(rowsText).not.toContain("GAPKIND-MARK");
  expect(rowsText).not.toContain("GAP-MARK");
  expect(row(keys[1]!)["entry"]).toMatchObject({
    assess: { lean: { lane: "agentic", reason: "" } },
  });
  expect(row(keys[2]!)["entry"]).toMatchObject({
    undecided: { cause: "unsure" },
  });
  expect(row(keys[3]!)["entry"]).toEqual({
    assess: null,
    lane: { floors: [] },
    undecided: { cause: "failed" },
  });
  const excludedRow = row(plan.unread.find((u) => u.cause === "excluded")!.key);
  expect(excludedRow["entry"]).toEqual({
    assess: null,
    lane: { floors: [] },
    excluded: {
      reason: expect.stringMatching(/^(lockfile|declared-generated)$/),
    },
  });
  // Nothing but numbers, identifiers and closed labels in an entry: every string is a cite, a
  // move's finding comment ID or confirmed claim's key (a Lane review claim's is a SHA-256, cited by
  // the moves a confirmed request for changes gives, 14.34), a label of the rule's closed sets, or
  // empty.
  const strings = (value: unknown): Array<string> =>
    typeof value === "string"
      ? [value]
      : Array.isArray(value)
        ? value.flatMap(strings)
        : value !== null && typeof value === "object"
          ? Object.values(value).flatMap(strings)
          : [];
  for (const entry of sections)
    for (const text of strings(entry["entry"]))
      expect(text).toMatch(
        /^(|low|high|easy|hard|missing|shallow|solid|agentic|human-suggested|human-required|static-automation|complexity|ease-of-validation|model|relations-unavailable|structure-unavailable|lockfile|declared-generated|failed|not-reached|too-large|unreadable|refused|unsure|unconfirmed|disagreed|removal|kept-finding|confirmed-request-changes|toward-human|[a-z-]+\.\d+|f\.[0-9a-f]{64}|[0-9a-f]{64}|[^\s]+:(new|old):\d+-\d+|[0-9A-HJKMNP-TV-Z]{26})$/,
      );

  // Reason (round 2g): "time to the first settled batch" is computed from these. A settled batch
  // says when its last reading or claim check ended: the latest completion of their stored
  // computations; one not settled, or one whose sections no reading read, says null.
  const completedAt = await run.run(
    Effect.gen(function* () {
      const computations = yield* Computations.ComputationStore;
      return yield* computations.lookupMany([assessKey, reviewKey, claimed]);
    }),
  );
  const latest = [assessKey, reviewKey, claimed]
    .map((key) => completedAt.get(key)!.completedAt)
    .sort()
    .at(-1);
  const batchRows = run.rows.filter((r) => r.type === "reading.batch");
  const batchOf = (id: string) => batchRows.find((b) => b["mapGroup"] === id)!;
  expect(batchOf("m1")["settledAt"]).toBe(latest!);
  expect(batchOf("m2")["settledAt"]).toBeNull();
  expect(batchOf("generated")["settledAt"]).toBeNull();
  // Reason (the review's N3): a reused step keeps an earlier run's time, so the batch says how many
  // of its steps were reused. m1's claim check was; m2 and the generated batch have none.
  expect(batchOf("m1")["reused"]).toBe(1);
  expect(batchOf("m2")["reused"]).toBe(0);
  expect(batchOf("generated")["reused"]).toBe(0);

  // Batches: m1 (group A) is settled and forms units; m2 holds group B's waiting sections, so it is
  // not settled and forms none, though its too-large and unreadable sections are settled; the
  // generated batch holds the two excluded files, one unit each.
  const batches = run.rows.filter((r) => r.type === "reading.batch");
  const batch = (id: string) => batches.find((b) => b["mapGroup"] === id)!;
  expect(batches).toHaveLength(3);
  expect(batch("generated")).toMatchObject({
    settled: true,
    ready: true,
    sections: { settled: 2, waiting: {}, unread: { excluded: 2 } },
    units: 2,
  });
  expect(batch("m1")["settled"]).toBe(true);
  expect(batch("m2")).toMatchObject({
    settled: false,
    sections: {
      settled: 3,
      waiting: { "not-reached": B!.keys.length },
      unread: { "too-large": 1, unreadable: 2 },
    },
    units: 0,
  });
  expect(batch("m1")).toMatchObject({
    sections: { settled: 4, waiting: {}, unread: {} },
  });
  expect(batch("m1")["units"]).toBeGreaterThan(0);

  // Units from settled batches only: never one of m2's sections.
  const decided = run.rows.find((r) => r.type === "readings.decision")!;
  const stored = (await run.run(
    storedOutput(run.ctx, decided["key"] as string, z.any()),
  )) as {
    units: Array<{
      mapGroup: string;
      units: Array<{ sectionKeys: Array<string> }>;
    }>;
  };
  // Each section row carries what the floor rule read, exactly as the stored entry holds it, so the
  // floor rule can be run again from the row alone.
  const decisionSections = (
    stored as unknown as {
      sections: Array<{
        key: string;
        decision: {
          settled: boolean;
          entry?: { floorInputs: unknown };
        } | null;
      }>;
    }
  ).sections;
  expect(decisionSections.some((e) => e.decision?.settled === true)).toBe(true);
  for (const entry of decisionSections)
    expect(row(entry.key)["floorInputs"]).toEqual(
      entry.decision?.settled === true
        ? entry.decision.entry!.floorInputs
        : null,
    );
  // Section 1 removes a declaration: code writes its `removed` impact entry from the plan's facts
  // (the model no longer does), so the floor rule reads it; the removal floor is off, so no lane moves.
  // It also carries the finder's kept risk about code (14.28), a move on complexity the row's entry
  // carries whole; its relations gap already holds it at human-suggested, and no floor reads it.
  expect(row(keys[0]!)["floorInputs"]).toEqual({
    facts: {
      removesDeclaration: false,
      removesPublicName: false,
      effects: ["removed"],
    },
    options: { removal: false },
  });
  const entryRow = row(keys[0]!)["entry"] as {
    assess: { movement: Array<Record<string, unknown>> };
  };
  expect(entryRow.assess.movement).toEqual([
    expect.objectContaining({
      signal: "kept-finding",
      axis: "complexity",
      direction: "toward-human",
    }),
  ]);
  const inUnits = stored.units
    .filter((g) => g.mapGroup !== "generated")
    .flatMap((g) => g.units.flatMap((u) => u.sectionKeys));
  const settled = sections
    .filter((s) => s["state"] === "settled")
    .map((s) => s["section"] as string)
    .filter((key) => A!.keys.includes(key));
  expect([...inUnits].sort()).toEqual([...settled].sort());
  expect([...inUnits].sort()).toEqual([...A!.keys].sort());
  expect(batch("m1")["units"]).toBe(
    stored.units.find((g) => g.mapGroup === "m1")!.units.length,
  );

  // One row per call that ran, or was cut off, with its figures.
  const calls = run.rows.filter((r) => r.type === "reading.call");
  // In the plan's group order (B before A here), Assess before Lane review.
  expect(plan.groups.indexOf(B!)).toBeLessThan(plan.groups.indexOf(A!));
  expect(
    calls.map((c) => [c["kind"], c["group"], c["part"], c["run"]]),
  ).toEqual([
    ["assess", B!.id, "read", "not-started"],
    ["lane-review", B!.id, "read", "interrupted"],
    ["assess", A!.id, "read", "ran"],
    ["assess", A!.id, "reread", "failed"],
    ["lane-review", A!.id, "read", "ran"],
    ["verify-claim", A!.id, "claim", "reused"],
  ]);
  expect(calls[2]).toMatchObject({
    sections: 4,
    rank: A!.rank,
    source: "agent",
    key: assessKey,
    // Why the first answer was sent back, what the answer given last broke, and what code's repair
    // left: counts per class only.
    problems: {
      first: { "missing-row": 1, "unknown-cite": 1 },
      given: { "missing-row": 1 },
      repaired: { "missing-row": 1 },
    },
  });
  // A failed step's row says what kind of failure it was; no other row has a failure.
  expect(calls[3]).toMatchObject({
    run: "failed",
    key: null,
    failure: "invalid_request",
  });
  expect(calls.filter((c) => "failure" in c)).toHaveLength(1);
  // The Lane review's answer passed its checks the first time.
  expect(calls[4]!["problems"]).toEqual({ first: {}, given: {}, repaired: {} });

  // Reason (round 2f): the probe reports output tokens per section, the split between reasoning and
  // answer, and how often a reading was unremarkable, from these numbers alone. Assess wrote two
  // classes over four sections, two of them outside the larger class; the Lane review's largest
  // verdict list holds two of four; a route that reports no reasoning gives null, never 0; a call
  // that did not run, or the claim check, has no class numbers.
  expect(calls[2]).toMatchObject({
    sections: 4,
    outputTokens: 240,
    reasoningTokens: 60,
    classes: 2,
    outside: 2,
  });
  expect(calls[4]).toMatchObject({
    sections: 4,
    outputTokens: 180,
    reasoningTokens: null,
    classes: null,
    outside: 2,
  });
  for (const at of [0, 3])
    expect(calls[at]).toMatchObject({
      outputTokens: null,
      reasoningTokens: null,
      classes: null,
      outside: null,
    });
  expect(calls[5]).toMatchObject({ classes: null, outside: null });
  // Reason (round 2g): the call's own input and cached-input counts, as the route reported them;
  // null where no call ran, and for a record that carries no usage (the claim check here).
  // The three input fields together are all the call's input (the fix round's D2).
  expect(calls[2]).toMatchObject({
    inputTokens: 1_200,
    cachedInputTokens: 300,
    cacheWriteTokens: 5_200,
  });
  expect(calls[4]).toMatchObject({
    inputTokens: 900,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
  });
  for (const at of [0, 3, 5])
    expect(calls[at]).toMatchObject({
      inputTokens: null,
      cachedInputTokens: null,
      cacheWriteTokens: null,
    });
  for (const call of calls)
    for (const name of [
      "inputTokens",
      "cachedInputTokens",
      "cacheWriteTokens",
      "outputTokens",
      "reasoningTokens",
      "classes",
      "outside",
    ])
      expect(call[name] === null || typeof call[name] === "number").toBe(true);

  // One row per unit, each formed from settled sections only.
  const unitRows = run.rows.filter((r) => r.type === "reading.unit");
  expect(unitRows.length).toBe(
    stored.units.reduce((sum, g) => sum + g.units.length, 0),
  );
  const requesting = unitRows.find((u) =>
    (u["sections"] as Array<string>).includes(keys[1]!),
  )!;
  // Under lane rule 5 the confirmed request for changes is human-required (14.34), so it shares one
  // unit per file and lane with the undecided (unsure) section of the same file: the unit has no
  // verdict while a section is undecided, and its comment is still shown.
  expect(requesting).toMatchObject({
    lane: "human-required",
    verdict: null,
    undecided: { unsure: 1 },
    comments: { shown: 1, belowCut: 0 },
  });
  expect(requesting["sections"]).toContain(keys[2]!);
  const settledRows = sections
    .filter((s) => s["state"] === "settled")
    .map((s) => s["section"] as string);
  for (const unit of unitRows)
    for (const key of unit["sections"] as Array<string>)
      expect(settledRows).toContain(key);

  // No model text in any row the readings wrote, the new fields of this round included (a batch's
  // readiness and failed checks, the decision's batch and finding counts, a finder's claim).
  const written = JSON.stringify(
    run.rows.filter((r) => r.type.startsWith("reading")),
  );
  for (const mark of Object.values(MARKS)) expect(written).not.toContain(mark);
  for (const mark of [
    "LEAN-MARK",
    "SENTBACK-MARK",
    "9n77",
    "COMMENT-MARK",
    "UNSURE-MARK",
    "REQ-MARK",
    "REASON-MARK",
    "FINDER-MARK",
  ])
    expect(written).not.toContain(mark);
  expect(batch("m1")).toMatchObject({ ready: true, reason: null, problems: 0 });
  expect(batch("m2")).toMatchObject({ ready: false, reason: "waiting" });
  expect(decided).toMatchObject({
    batches: { total: 3, ready: 2 },
    findings: { placed: 1, unplaced: 0 },
  });
  // The comment bodies are carried only in the stored decision, for the publisher: the Lane
  // review's comment and the finder's, on the first section's unit.
  const forPublisher = await settledOf(run.services, decided["key"] as string);
  expect(forPublisher.totals).toEqual({
    batches: 3,
    sections: plan.sections.length + plan.unread.length,
  });
  expect(forPublisher.batches.map((b) => b.title)).toEqual([
    expect.any(String),
    "Lockfiles and generated files",
  ]);
  const bodies = forPublisher.batches[0]!.units.flatMap((u) =>
    u.comments.map((c) => [c.id, c.section, c.body]),
  );
  expect(bodies).toContainEqual(["risky-edges.1", keys[0]!, MARKS.finder]);
  expect(bodies.map(([, , body]) => body)).toContain(MARKS.defect);

  // What the review gets: every record, the cut-off one with no gap of its own, and one disclosure.
  // B's Assess, stopped before it returned anything, reads as not started at the cut-off.
  expect(collected.stages).toHaveLength(5);
  expect(collected.stages.slice(0, 2)).toMatchObject([
    { agent: `assess.${B!.id}`, status: "skipped", disclosure: null },
    { status: "interrupted", disclosure: null },
  ]);
  expect(collected.stages.slice(2).map((r) => r.status)).toEqual([
    "computed",
    "computed",
    "reused",
  ]);
  const notReached = B!.keys.length;
  const total = plan.sections.length + 3;
  expect(collected.disclosures).toEqual([
    {
      kind: "section-readings",
      detail: `Section readings: ${notReached + 4} of ${total} sections were not judged (1 failed, ${notReached} not reached, 1 too large to read, 2 with no text to read); ${notReached} sections are still waiting (${notReached} for a reading not reached).`,
    },
  ]);
  // Every section judged, one waiting for a claim's check: the run still says so.
  expect(readingsDisclosure(5, [], ["check-not-reached"])).toEqual([
    {
      kind: "section-readings",
      detail:
        "Section readings: all 5 sections were judged; 1 section is still waiting (1 for a claim check not reached).",
    },
  ]);
}, 30_000);

// Reason (round 6): the rows must say what each section was shown of its callers and tests, in
// each of the four states, as closed labels and counts only, and a section's gap may go only where
// both readings of its group were shown one stored decision.
test("the rows name each section's relation evidence in all four states, each call's evidence rows and the totals, with no path, name or source text; a group whose readings were shown two decisions keeps every gap", async () => {
  const MARK = {
    path: "EVIDENCE-PATH-MARK.ts",
    symbol: "SYMBOL-MARK",
    text: "SOURCE-MARK const n = count(text);",
    from: "CALLER-MARK",
  };
  const collectOnce = async (
    name: string,
    agree: boolean,
    /** The third section's state: read with nothing, or past a cap. */
    third: "no-evidence" | "over-cap" = "no-evidence",
    /** The first section's caller row unconfirmed, though the decision still says `shown`. */
    forged = false,
    /**
     * The old switch (`callsLiftGap`) in the run's configuration, as a configuration frozen before
     * round 13 holds it: ignored, so the decision's `shown` stands either way.
     */
    config = false,
  ) => {
    const run = await world(name);
    const range = mixedRange();
    const plan = planReadings({
      hunks: range.hunks,
      structures: range.structures,
      excluded: range.excluded,
      bounds: { maxItems: 4 },
    });
    const A = plan.groups.find((group) => group.keys.length === 4)!;
    const planKey = await run.store("test.readings-plan", plan);
    const manifestHunks = withoutLeads(range.hunks);
    const manifestKey = await run.store(
      "test.manifest",
      manifestOf(manifestHunks),
    );
    const mapKey = await run.store(
      "test.map",
      mapFor(manifestHunks, range.excluded),
    );
    const sources = {
      hunks: new Map(range.hunks.map((hunk) => [hunk.hunkId, hunk])),
      structures: range.structures,
    };
    const assess = assessStep({
      stage: "verify",
      reading: renderReading(plan, A.id, { for: "assess", ...sources }),
    });
    const reviewReading = renderReading(plan, A.id, {
      for: "lane-review",
      ...sources,
    });
    const review = laneReviewStep({
      stage: "verify",
      reading: reviewReading,
      goal: { goal: "Let callers count parsed items.", doneWhen: [] },
      tools: [],
      keys: { frame: "frame-key", manifest: manifestKey },
    });
    // Both readings judge every section: low and easy, approved.
    const all = [1, 2, 3, 4];
    const assessKey = await run.store(
      "test.assess",
      AssessStored.parse(
        assess.compose(
          result({
            factors: [],
            requirements: [],
            impact: [],
            classes: [
              {
                S: all,
                c: "l",
                v: "e",
                F: [],
                R: [],
                person: null,
                gaps: null,
              },
            ],
          } satisfies AssessAnswer),
        ),
      ),
    );
    const files = [...new Set(reviewReading.index.sections.map((s) => s.file))];
    const reviewKey = await run.store(
      "test.lane-review",
      LaneReviewStored.parse(
        review.compose(
          result({
            files: files.map((f) => ({
              f,
              checked: MARKS.checked,
              rows: null,
            })),
            sections: { a: all, r: [], u: [] },
            comments: [],
            unsure: [],
          } satisfies LaneReviewAnswer),
        ),
      ),
    );
    // What the group was shown, in reading order: whole, in part, read with nothing, not read.
    const keys = reviewReading.index.sections.map((s) => s.key);
    const row = (
      kind: "caller" | "test",
      confirmed = true,
      shows: "call" | "reference" | "caller" = "call",
    ) => ({
      kind,
      symbol: MARK.symbol,
      path: MARK.path,
      shows,
      line: 12,
      text: MARK.text,
      from: MARK.from,
      confirmed,
    });
    const evidence = {
      recipe: EVIDENCE_RECIPE,
      group: A.id,
      outcome: "read",
      relations: { head: "h".repeat(64), base: null },
      sections: [
        {
          key: keys[0]!,
          relations: "shown",
          rows: [row("caller", !forged), row("test", false, "caller")],
        },
        // A confirmed caller that only names its caller beside an unconfirmed test row: counted
        // apart.
        {
          key: keys[1]!,
          relations: "partial",
          rows: [row("caller", true, "reference"), row("test", false)],
        },
        { key: keys[2]!, relations: third, rows: [] },
        { key: keys[3]!, relations: "not-read", rows: [] },
      ],
    };
    const evidenceKey = await run.store("test.reading-evidence", evidence);
    // The other decision, the same rows under another key: as if the Lane review had decided apart.
    const otherKey = await run.storeAt(
      { op: "test.reading-evidence", opVersion: 2, inputs: { name } },
      evidence,
    );
    const recordOf = (agent: string, key: string): StageRecord => ({
      stage: "verify",
      agent,
      status: "computed",
      key,
      wallMs: 1,
    });
    const readings = [
      {
        name: `assess.${A.id}`,
        outcome: {
          status: "completed",
          result: {
            kind: "assess",
            group: A.id,
            steps: [assessKey],
            claims: [],
            stages: [recordOf(`assess.${A.id}`, assessKey)],
            notJudged: [],
            evidence: evidenceKey,
          },
        } as TaskOutcome<ReadingTaskResult>,
      },
      {
        name: `lane-review.${A.id}`,
        outcome: {
          status: "completed",
          result: {
            kind: "lane-review",
            group: A.id,
            steps: [reviewKey],
            claims: [],
            stages: [recordOf(`lane-review.${A.id}`, reviewKey)],
            notJudged: [],
            evidence: agree ? evidenceKey : otherKey,
          },
        } as TaskOutcome<ReadingTaskResult>,
      },
    ];
    const { harness, port } = await run.open(
      config ? { ...PROBE, callsLiftGap: true } : PROBE,
    );
    await harness.commit(async (tx) => {
      (await tx.doc(ReadingsRunDoc)).plan = planKey;
      return undefined;
    }, context);
    await port.collect(
      { frameKey: FRAME_KEY, mapKey, manifestKey, readings },
      harness,
      context,
      new AbortController().signal,
    );
    await harness.close(context);
    const sectionRow = (key: string) =>
      run.rows.find(
        (entry) => entry.type === "reading.section" && entry["section"] === key,
      )!;
    const gapped = (key: string) =>
      (
        sectionRow(key)["entry"] as {
          assess: { gaps: Array<{ kind: string }> };
        }
      ).assess.gaps.some((gap) => gap.kind === "relations-unavailable");
    const undeclared = (key: string) =>
      plan.sections.find((s) => s.key === key)!.declared === null;
    return { run, plan, keys, sectionRow, gapped, undeclared };
  };

  const one = await collectOnce("evidence-rows", true);
  const { keys, sectionRow } = one;
  expect(
    keys.map((key) => ({
      relations: sectionRow(key)["relations"],
      relationRows: sectionRow(key)["relationRows"],
    })),
  ).toEqual([
    // The hold (round 22): the section the evidence shows whole is recorded `partial`.
    {
      relations: "partial",
      relationRows: {
        callers: 1,
        tests: 0,
        unconfirmedCallers: 0,
        unconfirmedTests: 1,
      },
    },
    {
      relations: "partial",
      relationRows: {
        callers: 1,
        tests: 0,
        unconfirmedCallers: 0,
        unconfirmedTests: 1,
      },
    },
    {
      relations: "no-evidence",
      relationRows: {
        callers: 0,
        tests: 0,
        unconfirmedCallers: 0,
        unconfirmedTests: 0,
      },
    },
    {
      relations: "not-read",
      relationRows: {
        callers: 0,
        tests: 0,
        unconfirmedCallers: 0,
        unconfirmedTests: 0,
      },
    },
  ]);
  // The hold: every undeclared section keeps its gap, the one shown whole too.
  for (const key of keys)
    if (one.undeclared(key)) expect(one.gapped(key)).toBe(true);
  expect(one.undeclared(keys[0]!)).toBe(true);
  // A section of another group, which read nothing (its readings are missing), is not read.
  const elsewhere = one.plan.sections.find((s) => !keys.includes(s.key))!;
  expect(sectionRow(elsewhere.key)["relations"]).toBe("not-read");
  // Each call's reading showed two confirmed rows (1 + 1 + 0 + 0) and two unconfirmed.
  const calls = one.run.rows.filter((row) => row.type === "reading.call");
  expect(
    calls
      .filter((row) => row["run"] === "ran")
      .map((row) => [row["kind"], row["evidenceRows"], row["unconfirmedRows"]]),
  ).toEqual([
    ["assess", 2, 2],
    ["lane-review", 2, 2],
  ]);
  const decision = one.run.rows.find(
    (row) => row.type === "readings.decision",
  )!;
  const total = one.plan.sections.length + one.plan.unread.length;
  expect(decision["relations"]).toEqual({
    shown: 0,
    partial: 2,
    "no-evidence": 1,
    "over-cap": 0,
    "not-read": total - 3,
  });
  // Each group by how its decision was made: group A's read the head's relations; every other
  // group's readings are missing, so it has none.
  expect(decision["evidence"]).toEqual({
    read: 1,
    "not-stored": 0,
    failed: 0,
    "over-bound": 0,
    none: one.plan.groups.length - 1,
  });
  // And its rows: caller rows by what their line shows, and test rows, as counts.
  expect(decision["relationRowKinds"]).toEqual({
    call: 1,
    reference: 1,
    caller: 0,
    tests: 2,
  });
  expect(decision["siteLines"]).toBeUndefined();
  // No path, symbol name or source text of a row reaches any row of the run log.
  const logged = JSON.stringify(one.run.rows);
  for (const mark of Object.values(MARK)) expect(logged).not.toContain(mark);

  // The Lane review was shown another decision: nothing is shown whole, and every gap stays.
  const two = await collectOnce("evidence-rows-apart", false, "over-cap");
  expect(two.sectionRow(two.keys[0]!)["relations"]).toBe("partial");
  expect(two.gapped(two.keys[0]!)).toBe(true);
  // A hand-made decision that says `shown` on an unconfirmed caller row (round 6f): the stored form
  // refuses it, so the group reads as shown nothing, and the section keeps its gap.
  const forged = await collectOnce(
    "evidence-rows-forged",
    true,
    undefined,
    true,
  );
  expect(forged.sectionRow(forged.keys[0]!)["relations"]).toBe("not-read");
  expect(forged.gapped(forged.keys[0]!)).toBe(true);
  // A section past a cap has its own state, and keeps its gap.
  expect(two.sectionRow(two.keys[2]!)["relations"]).toBe("over-cap");
  if (two.undeclared(two.keys[2]!)) expect(two.gapped(two.keys[2]!)).toBe(true);
  expect(
    (
      two.run.rows.find((row) => row.type === "readings.decision")![
        "relations"
      ] as Record<string, number>
    )["over-cap"],
  ).toBe(1);

  // Round 13: the lift is no switch. A run whose configuration still carries the old switch (frozen
  // before this round) collects the same: under the hold (round 22), the first section keeps its gap.
  const frozen = await collectOnce(
    "evidence-rows-old-switch",
    true,
    undefined,
    false,
    true,
  );
  expect(frozen.sectionRow(frozen.keys[0]!)["relations"]).toBe("partial");
  expect(frozen.gapped(frozen.keys[0]!)).toBe(true);
}, 30_000);

// Reason (round 20): a person reads why the callers are missing. When the group's readings waited
// on the head gate and it ended at its cut-off before the head's relations were stored, the gap says
// they were still being computed (or not started); a failed gate,
// one that had the head, a decision that read the head and a review with no gate read as before.
// The kind stays `relations-unavailable`, so whatever counts gaps by kind counts the same.
test("the relations gap a person reads names how the head gate ended: still being computed, not started, published or stopped; a failed gate, no gate and a read decision read as before, under the same kind", async () => {
  const gapsOf = async (
    name: string,
    outcome: "read" | "not-stored",
    gate?: { status: string; wallMs: number | null },
  ) => {
    const run = await world(name);
    const range = mixedRange();
    const plan = planReadings({
      hunks: range.hunks,
      structures: range.structures,
      excluded: range.excluded,
      bounds: { maxItems: 4 },
    });
    const A = plan.groups.find((group) => group.keys.length === 4)!;
    const planKey = await run.store("test.readings-plan", plan);
    const manifestHunks = withoutLeads(range.hunks);
    const manifestKey = await run.store(
      "test.manifest",
      manifestOf(manifestHunks),
    );
    const mapKey = await run.store(
      "test.map",
      mapFor(manifestHunks, range.excluded),
    );
    const sources = {
      hunks: new Map(range.hunks.map((hunk) => [hunk.hunkId, hunk])),
      structures: range.structures,
    };
    const all = [1, 2, 3, 4];
    const assessKey = await run.store(
      "test.assess",
      AssessStored.parse(
        assessStep({
          stage: "verify",
          reading: renderReading(plan, A.id, { for: "assess", ...sources }),
        }).compose(
          result({
            factors: [],
            requirements: [],
            impact: [],
            classes: [
              {
                S: all,
                c: "l",
                v: "e",
                F: [],
                R: [],
                person: null,
                gaps: null,
              },
            ],
          } satisfies AssessAnswer),
        ),
      ),
    );
    const reviewReading = renderReading(plan, A.id, {
      for: "lane-review",
      ...sources,
    });
    const files = [...new Set(reviewReading.index.sections.map((s) => s.file))];
    const reviewKey = await run.store(
      "test.lane-review",
      LaneReviewStored.parse(
        laneReviewStep({
          stage: "verify",
          reading: reviewReading,
          goal: { goal: "Let callers count parsed items.", doneWhen: [] },
          tools: [],
          keys: { frame: "frame-key", manifest: manifestKey },
        }).compose(
          result({
            files: files.map((f) => ({
              f,
              checked: MARKS.checked,
              rows: null,
            })),
            sections: { a: all, r: [], u: [] },
            comments: [],
            unsure: [],
          } satisfies LaneReviewAnswer),
        ),
      ),
    );
    const keys = reviewReading.index.sections.map((s) => s.key);
    // Nothing shown for any section: the head was not stored, or it was and nothing was supported.
    const evidenceKey = await run.store("test.reading-evidence", {
      recipe: EVIDENCE_RECIPE,
      group: A.id,
      outcome,
      relations: {
        head: outcome === "read" ? "h".repeat(64) : null,
        base: null,
      },
      sections: keys.map((key) => ({
        key,
        relations: outcome === "read" ? "no-evidence" : "not-read",
        rows: [],
      })),
      ...(gate === undefined ? {} : { gate }),
    });
    const recordOf = (agent: string, key: string): StageRecord => ({
      stage: "verify",
      agent,
      status: "computed",
      key,
      wallMs: 1,
    });
    const readings = (["assess", "lane-review"] as const).map((kind) => ({
      name: `${kind}.${A.id}`,
      outcome: {
        status: "completed",
        result: {
          kind,
          group: A.id,
          steps: [kind === "assess" ? assessKey : reviewKey],
          claims: [],
          stages: [
            recordOf(
              `${kind}.${A.id}`,
              kind === "assess" ? assessKey : reviewKey,
            ),
          ],
          notJudged: [],
          evidence: evidenceKey,
        },
      } as TaskOutcome<ReadingTaskResult>,
    }));
    const { harness, port } = await run.open(PROBE);
    await harness.commit(async (tx) => {
      (await tx.doc(ReadingsRunDoc)).plan = planKey;
      return undefined;
    }, context);
    await port.collect(
      { frameKey: FRAME_KEY, mapKey, manifestKey, readings },
      harness,
      context,
      new AbortController().signal,
    );
    await harness.close(context);
    const decision = run.rows.find((row) => row.type === "readings.decision")!;
    // Each undeclared section's relations gap, as the stored decision holds it (the words the
    // person reads), and as its row labels it (the closed kind only): every one is the same.
    const stored = (await run.run(
      storedOutput(run.ctx, decision["key"] as string, z.any()),
    )) as {
      sections: Array<{
        key: string;
        decision: {
          entry: {
            assess: {
              gaps: Array<{ axis: string; kind: string; detail: string }>;
            };
          };
        };
      }>;
    };
    const undeclared = keys.filter(
      (key) => plan.sections.find((s) => s.key === key)!.declared === null,
    );
    expect(undeclared.length).toBeGreaterThan(0);
    const details = new Set(
      undeclared.map((key) =>
        JSON.stringify(
          stored.sections
            .find((section) => section.key === key)!
            .decision.entry.assess.gaps.filter(
              (gap) => gap.kind === "relations-unavailable",
            ),
        ),
      ),
    );
    expect(details.size).toBe(1);
    const gaps = JSON.parse([...details][0]!) as Array<{
      axis: string;
      kind: string;
      detail: string;
    }>;
    expect(gaps).toHaveLength(1);
    for (const key of undeclared) {
      const entry = run.rows.find(
        (row) => row.type === "reading.section" && row["section"] === key,
      )!["entry"] as { assess: { gaps: Array<{ kind: string }> } };
      expect(entry.assess.gaps.map((gap) => gap.kind)).toContain(
        "relations-unavailable",
      );
    }
    return { gap: gaps[0]!, gates: decision["gates"] };
  };
  const UNAVAILABLE =
    "The callers and tests of this code were not available, so how it is used could not be checked.";
  const cases: Array<
    [
      string,
      "read" | "not-stored",
      { status: string; wallMs: number | null } | undefined,
      string,
    ]
  > = [
    ["no-gate", "not-stored", undefined, UNAVAILABLE],
    [
      "cutoff-reading",
      "not-stored",
      { status: "cutoff", wallMs: 41_000 },
      "The callers and tests of this code were still being computed when it was read.",
    ],
    [
      "cutoff-unstarted",
      "not-stored",
      { status: "cutoff", wallMs: 0 },
      "The callers and tests of this code had not started being computed when it was read.",
    ],
    [
      "cutoff-unplanned",
      "not-stored",
      { status: "cutoff", wallMs: null },
      "The callers and tests of this code had not started being computed when it was read.",
    ],
    [
      "published",
      "not-stored",
      { status: "published", wallMs: 300 },
      "The callers and tests of this code were not computed before the review was published, so how it is used could not be checked.",
    ],
    [
      "stopped",
      "not-stored",
      { status: "stopped", wallMs: null },
      "The callers and tests of this code were not computed because the review was stopped, so how it is used could not be checked.",
    ],
    ["failed", "not-stored", { status: "failed", wallMs: 40 }, UNAVAILABLE],
    [
      "stored-missing",
      "not-stored",
      { status: "stored", wallMs: 9 },
      UNAVAILABLE,
    ],
    // A decision that read the head says the section's own state (here no caller shows how it is
    // used), whatever the gate's end (round 23).
    [
      "read",
      "read",
      { status: "cutoff", wallMs: 41_000 },
      "No caller shows how this code is used.",
    ],
  ];
  for (const [name, outcome, gate, detail] of cases) {
    const { gap, gates } = await gapsOf(`gate-gap-${name}`, outcome, gate);
    expect([name, gap]).toEqual([
      name,
      { axis: "ease-of-validation", kind: "relations-unavailable", detail },
    ]);
    // Code's own gap, by its words: a closed kind, never `model`.
    expect(CODE_GAPS.some((own) => own.detail === gap.detail)).toBe(true);
    // The decision row counts each group by its gate's end, only when one waited on a gate.
    if (gate === undefined) expect(gates).toBeUndefined();
    else expect((gates as Record<string, number>)[gate.status]).toBe(1);
  }
}, 60_000);

// Reason (round 22): the gates score the lift and the hold from one set of runs, with no model call,
// so the hold's replay must read what a review stored and give, through the production lane code,
// the published lane (the lift) and the lane with the relations gap held where the lift took it.
/**
 * Plant 203's shape, collected as a review collects it: a group of four sections, all low and easy
 * and approved, the first shown whole by a trusted call from a file that is not a test, with no kept
 * finding. Returns the world, the plan, the group's section keys and the keys stored.
 */
const liftShaped = async (name: string) => {
  const run = await world(name);
  const range = mixedRange();
  const plan = planReadings({
    hunks: range.hunks,
    structures: range.structures,
    excluded: range.excluded,
    bounds: { maxItems: 4 },
  });
  const A = plan.groups.find((group) => group.keys.length === 4)!;
  const planKey = await run.store("test.readings-plan", plan);
  const manifestHunks = withoutLeads(range.hunks);
  const manifestKey = await run.store(
    "test.manifest",
    manifestOf(manifestHunks),
  );
  const mapKey = await run.store(
    "test.map",
    mapFor(manifestHunks, range.excluded),
  );
  const sources = {
    hunks: new Map(range.hunks.map((hunk) => [hunk.hunkId, hunk])),
    structures: range.structures,
  };
  const all = [1, 2, 3, 4];
  const assessKey = await run.store(
    "test.assess",
    AssessStored.parse(
      assessStep({
        stage: "verify",
        reading: renderReading(plan, A.id, { for: "assess", ...sources }),
      }).compose(
        result({
          factors: [],
          requirements: [],
          impact: [],
          classes: [
            { S: all, c: "l", v: "e", F: [], R: [], person: null, gaps: null },
          ],
        } satisfies AssessAnswer),
      ),
    ),
  );
  const reviewReading = renderReading(plan, A.id, {
    for: "lane-review",
    ...sources,
  });
  const files = [...new Set(reviewReading.index.sections.map((s) => s.file))];
  const reviewKey = await run.store(
    "test.lane-review",
    LaneReviewStored.parse(
      laneReviewStep({
        stage: "verify",
        reading: reviewReading,
        goal: { goal: "Let callers count parsed items.", doneWhen: [] },
        tools: [],
        keys: { frame: "frame-key", manifest: manifestKey },
      }).compose(
        result({
          files: files.map((f) => ({ f, checked: MARKS.checked, rows: null })),
          sections: { a: all, r: [], u: [] },
          comments: [],
          unsure: [],
        } satisfies LaneReviewAnswer),
      ),
    ),
  );
  const keys = reviewReading.index.sections.map((s) => s.key);
  // The first section is shown whole, by a trusted call from a file that is not a test: the lift.
  const evidenceKey = await run.store("test.reading-evidence", {
    recipe: EVIDENCE_RECIPE,
    group: A.id,
    outcome: "read",
    relations: { head: "h".repeat(64), base: null },
    sections: keys.map((key, at) => ({
      key,
      relations: at === 0 ? "shown" : "no-evidence",
      rows:
        at === 0
          ? [
              {
                kind: "caller",
                symbol: "count",
                path: "src/use.ts",
                shows: "call",
                line: 3,
                text: "count(text);",
                from: "use",
                confirmed: true,
              },
            ]
          : [],
    })),
  });
  const recordOf = (agent: string, key: string): StageRecord => ({
    stage: "verify",
    agent,
    status: "computed",
    key,
    wallMs: 1,
  });
  const readings = (["assess", "lane-review"] as const).map((kind) => {
    const step = kind === "assess" ? assessKey : reviewKey;
    return {
      name: `${kind}.${A.id}`,
      outcome: {
        status: "completed",
        result: {
          kind,
          group: A.id,
          steps: [step],
          claims: [],
          stages: [recordOf(`${kind}.${A.id}`, step)],
          notJudged: [],
          evidence: evidenceKey,
        },
      } as TaskOutcome<ReadingTaskResult>,
    };
  });
  const { harness, port } = await run.open(PROBE);
  await harness.commit(async (tx) => {
    (await tx.doc(ReadingsRunDoc)).plan = planKey;
    return undefined;
  }, context);
  await port.collect(
    { frameKey: FRAME_KEY, mapKey, manifestKey, readings },
    harness,
    context,
    new AbortController().signal,
  );
  await harness.close(context);
  return { run, plan, A, keys, manifestKey, evidenceKey, sources };
};

test("the hold's replay reads a stored review and gives each section's published lane, the same lane recomputed, and the lane with the relations gap held where its evidence was shown", async () => {
  const { run, keys, manifestKey } = await liftShaped("replay-hold");
  // The run log as the review writes it, under the store's run logs.
  const logs = join(run.ctx.location.directory, "run-logs");
  mkdirSync(logs, { recursive: true });
  writeFileSync(
    join(logs, `${run.ctx.runId}.jsonl`),
    [
      { type: "run.started", runId: run.ctx.runId, runKey: run.ctx.runKey },
      ...run.rows,
    ]
      .map((row) => JSON.stringify(row))
      .join("\n") + "\n",
  );
  const [selected] = runLogsOf(logs, { run: run.ctx.runId });
  expect(runLogsOf(logs, { cycle: run.ctx.runKey })).toEqual([selected!]);
  const replayed = replayRun({
    database: run.ctx.location.database,
    directory: run.ctx.location.directory,
    runLog: selected!.path,
    manifestKey,
  })!;
  const decision = run.rows.find((row) => row.type === "readings.decision")!;
  expect(replayed.decision).toBe(String(decision["key"]));
  const sectionRows = run.rows.filter(
    (row) =>
      row.type === "reading.section" && row["decision"] === decision["key"],
  );
  // One replayed section per stored one; the recomputed lane is the published one everywhere.
  expect(replayed.sections.map((s) => s.key).sort()).toEqual(
    sectionRows.map((row) => String(row["section"])).sort(),
  );
  for (const section of replayed.sections) {
    const row = sectionRows.find((r) => r["section"] === section.key)!;
    const published =
      (row["lane"] as { applied: string } | null)?.applied ?? null;
    expect([section.key, section.published]).toEqual([section.key, published]);
    // The product is lane rule 5: its columns recompute the published lane from the stored moves,
    // which a rule 5 decision holds, the verdict's among them (14.34).
    if (section.published !== null)
      expect([
        section.key,
        section.confirmedLift,
        section.confirmedHold,
      ]).toEqual([section.key, published, published]);
    // Rule 4's columns differ only where a confirmed request for changes moved the section.
    if (section.verdictMoves.length === 0)
      expect([section.key, section.matrixLift, section.matrixHold]).toEqual([
        section.key,
        section.confirmedLift,
        section.confirmedHold,
      ]);
    expect(section.movesFrom).toBe("stored");
    expect(section.verdictMovesFrom).toBe("stored");
  }
  expect(replayed.notes).toEqual([]);
  // The product holds the gap now (round 22): no row says `shown`, so the section the evidence shows
  // whole is published with a person, and the hold changes nothing anywhere.
  const lifted = replayed.sections.find((s) => s.key === keys[0])!;
  expect(lifted).toMatchObject({
    shown: false,
    published: "human-suggested",
    lift: "human-suggested",
    hold: "human-suggested",
    matrixLift: "human-suggested",
    matrixHold: "human-suggested",
    keptFinding: false,
  });
  for (const section of replayed.sections) {
    expect(section.shown).toBe(false);
    expect([section.key, section.hold]).toEqual([section.key, section.lift]);
  }
  // With no run log (a copied database), the shown sections derived from the entries give the same.
  expect(decisionsIn(run.ctx.location.database).map((d) => d.key)).toEqual([
    replayed.decision,
  ]);
  expect(
    replayDecision({
      database: run.ctx.location.database,
      directory: run.ctx.location.directory,
      decisionKey: replayed.decision,
      manifestKey,
    }),
  ).toEqual(replayed.sections);
  // A decision stored before the finding floor names its kept findings by their comments.
  expect([
    ...finderSections([
      { units: [], comments: [[{ source: "finder", section: "s1" }]] },
      { comments: [{ source: "lane-review", section: "s2" }] },
    ]),
  ]).toEqual(["s1"]);
}, 60_000);

// Reason (round 22, the hold): gates' decisive check lost plant 203 to the lift, which took a low,
// easy, approved section with a trusted caller row and no kept finding to an agent. Held, it stays
// with a person, its relations gap kept in true words (the callers were read), while its readings
// still see the caller rows.
test("plant 203's shape, a trusted not-test caller row shown and no kept finding, stays human-suggested with approve and the relations gap kept in true words, while its reading still shows the caller rows", async () => {
  const { run, plan, A, keys, evidenceKey, sources } =
    await liftShaped("hold-203");
  const decision = run.rows.find((row) => row.type === "readings.decision")!;
  const row = run.rows.find(
    (r) => r.type === "reading.section" && r["section"] === keys[0],
  )!;
  expect(row).toMatchObject({
    state: "settled",
    relations: "partial",
    verdict: "approve",
    lane: { applied: "human-suggested" },
  });
  const stored = (await run.run(
    storedOutput(run.ctx, decision["key"] as string, z.any()),
  )) as {
    sections: Array<{
      key: string;
      decision: {
        entry: {
          assess: {
            gaps: Array<{ axis: string; kind: string; detail: string }>;
          };
          lane: { judged: string; applied: string; floors: Array<unknown> };
        };
      };
    }>;
  };
  const entry = stored.sections.find((s) => s.key === keys[0])!.decision.entry;
  expect(entry.lane).toMatchObject({
    judged: "human-suggested",
    applied: "human-suggested",
    floors: [],
  });
  // The gap's own words: the callers were read, and a person still reviews the change.
  expect(
    entry.assess.gaps.filter((gap) => gap.kind === "relations-unavailable"),
  ).toEqual([
    {
      axis: "ease-of-validation",
      kind: "relations-unavailable",
      detail: "The callers of this code were read; a person still reviews it.",
    },
  ]);
  // The readings still see the callers: the stored evidence shows the section whole, with its row,
  // and the reading's text holds the caller line.
  const evidence = (await run.run(
    storedOutput(run.ctx, evidenceKey, z.any()),
  )) as { sections: Array<{ key: string; relations: string }> };
  expect(evidence.sections.find((s) => s.key === keys[0])!.relations).toBe(
    "shown",
  );
  const reading = renderReading(plan, A.id, {
    for: "assess",
    ...sources,
    evidence: evidence as never,
  });
  expect(reading.text).toContain(
    "caller of count, called here: src/use.ts line 3",
  );
}, 60_000);

// Reason: a replayed Link phase must give the same answer and the same rows once, and a reading
// that failed must never read as a timed-out review (a skipped or interrupted record does).
test("collect twice on the same outcomes gives the same answer and writes its rows once; only a stopped reading adds a cut-short record", async () => {
  const run = await world("collect-twice");
  const range = mixedRange();
  const plan = planReadings({
    hunks: range.hunks,
    structures: range.structures,
    excluded: range.excluded,
    bounds: { maxItems: 4 },
  });
  const planKey = await run.store("test.readings-plan", plan);
  const manifestKey = await run.store(
    "test.manifest",
    manifestOf(withoutLeads(range.hunks)),
  );
  const mapKey = await run.store(
    "test.map",
    mapFor(withoutLeads(range.hunks), range.excluded),
  );
  const [A, B] = plan.groups;
  const { harness, port } = await run.open();
  await harness.commit(async (tx) => {
    (await tx.doc(ReadingsRunDoc)).plan = planKey;
    return undefined;
  }, context);
  const signal = new AbortController().signal;
  const collect = (readings: Parameters<typeof port.collect>[0]["readings"]) =>
    port.collect(
      { frameKey: FRAME_KEY, mapKey, manifestKey, readings },
      harness,
      context,
      signal,
    );
  // Failed, faulted, orphaned, missing and stopped readings.
  const ended = [
    {
      name: `assess.${A!.id}`,
      outcome: {
        status: "failed",
        error: { message: "the reading failed" },
      } as TaskOutcome<unknown>,
    },
    {
      name: `lane-review.${A!.id}`,
      outcome: {
        status: "faulted",
        error: { message: "the reading broke" },
      } as TaskOutcome<unknown>,
    },
    {
      name: `assess.${B!.id}`,
      outcome: {
        status: "orphaned",
        reason: "its owner ended",
      } as unknown as TaskOutcome<unknown>,
    },
    { name: `lane-review.${B!.id}`, outcome: undefined },
  ];
  const first = await collect(ended);
  const rows = run.rows.length;
  const second = await collect(ended);
  expect(second).toEqual(first);
  // The same decision, and not one row more.
  expect(run.rows.length).toBe(rows);
  expect(run.rows.filter((r) => r.type === "readings.decision")).toHaveLength(
    1,
  );
  expect(run.rows.filter((r) => r.type === "reading.section")).toHaveLength(
    plan.sections.length + plan.unread.length,
  );
  // None of them ran out of time: no record at all, so the receipt cannot read a time-out.
  expect(first.stages).toEqual([]);
  expect(first.disclosures[0]?.detail).toContain("failed");

  // A stopped reading, alone: one skipped record, which is the cut-off's.
  const stopped = await collect([
    {
      name: `assess.${A!.id}`,
      outcome: { status: "aborted", reason: "cutoff" } as TaskOutcome<unknown>,
    },
  ]);
  expect(stopped.stages.map((r) => [r.agent, r.status])).toEqual([
    [`assess.${A!.id}`, "skipped"],
  ]);
  // No reading at all: every section failed, nothing thrown, no record.
  const empty = await collect([]);
  expect(empty.stages).toEqual([]);
  expect(empty.disclosures).toHaveLength(1);
  await harness.close(context);
}, 30_000);

// Reason: record 0016: no read is shared in flight between callers, so one caller's abort never
// fails another's preparation.
test("two callers of the same read: the first one's abort leaves the second with its value", async () => {
  const run = await world("two-callers");
  const plan = threeGroups();
  const key = await run.store("test.readings-plan", plan);
  const first = new AbortController();
  const a = readPlan(run.ctx, run.run, key, first.signal);
  const b = readPlan(run.ctx, run.run, key, new AbortController().signal);
  first.abort();
  const [ended, read] = await Promise.allSettled([a, b]);
  expect(ended.status).toBe("rejected");
  expect(read).toEqual({ status: "fulfilled", value: plan });
  // A later caller is answered from the value the second read completed.
  expect(await readPlan(run.ctx, run.run, key)).toEqual(plan);
}, 30_000);

// Reason: record 0016: one run per key, every other caller subscribes, and one caller's abort never
// fails another; the work stops only when no caller still wants it.
test("concurrent callers of one read make one run; an aborted caller leaves the rest their value; the run stops only when no caller wants it", async () => {
  const run = await world("shared-reads");
  let runs = 0;
  const signals: Array<AbortSignal> = [];
  const gate = () => {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { opened, open };
  };
  // A read held open until the test lets it finish.
  const slow = (
    key: string,
    held: ReturnType<typeof gate>,
    signal?: AbortSignal,
  ) =>
    remembered(
      run.ctx,
      key,
      async (shared) => {
        runs++;
        signals.push(shared);
        await held.opened;
        return `value of ${key}`;
      },
      signal,
    );

  // Two hundred callers at once: one run, and every caller gets its value.
  const many = gate();
  const all = Array.from({ length: 200 }, () => slow("many", many));
  many.open();
  expect(await Promise.all(all)).toEqual(
    Array.from({ length: 200 }, () => "value of many"),
  );
  expect(runs).toBe(1);
  // A later caller is answered from the completed value, with no run.
  expect(await slow("many", gate())).toBe("value of many");
  expect(runs).toBe(1);

  // The first caller aborts while the read runs: the second still gets the value of the one run,
  // and the run was never cancelled.
  runs = 0;
  signals.length = 0;
  const one = gate();
  const first = new AbortController();
  const a = slow("one", one, first.signal);
  const b = slow("one", one, new AbortController().signal);
  await Promise.resolve();
  first.abort();
  one.open();
  const [ended, kept] = await Promise.allSettled([a, b]);
  expect(ended.status).toBe("rejected");
  expect(kept).toEqual({ status: "fulfilled", value: "value of one" });
  expect(runs).toBe(1);
  expect(signals[0]!.aborted).toBe(false);

  // Every caller aborts: then, and only then, the run is cancelled.
  runs = 0;
  signals.length = 0;
  const none = gate();
  const x = new AbortController();
  const y = new AbortController();
  const p = slow("none", none, x.signal);
  const q = slow("none", none, y.signal);
  await new Promise((resolve) => setTimeout(resolve, 0));
  x.abort();
  expect(signals[0]!.aborted).toBe(false);
  y.abort();
  expect(signals[0]!.aborted).toBe(true);
  expect((await Promise.allSettled([p, q])).map((r) => r.status)).toEqual([
    "rejected",
    "rejected",
  ]);
  expect(runs).toBe(1);
}, 30_000);

// Reason: only a finding Verify kept may weigh on a section, and a kept finding that cannot be read
// must never be skipped silently, since a section would then read as clear of it.
test("collect takes only kept findings; a dropped or unverified one is neither a claim nor a comment, and a kept one it cannot read is a run gap", async () => {
  const run = await world("collect-finders");
  const range = mixedRange();
  const plan = planReadings({
    hunks: range.hunks,
    structures: range.structures,
    excluded: range.excluded,
    bounds: { maxItems: 4 },
  });
  const planKey = await run.store("test.readings-plan", plan);
  const manifestKey = await run.store(
    "test.manifest",
    manifestOf(withoutLeads(range.hunks)),
  );
  const mapKey = await run.store(
    "test.map",
    mapFor(withoutLeads(range.hunks), range.excluded),
  );
  // Three read sections, each the owner of one finding's anchor.
  const [X, Y, Z] = plan.sections;
  const findingOn = (id: string, section: (typeof plan.sections)[number]) => {
    const owned = section.owned[0]!;
    return {
      id,
      lens: "correctness",
      hunkId: owned.hunkId,
      claim: `FINDER-MARK ${id}`,
      kind: "defect",
      about: "code",
      signal: null,
      critical: true,
      anchors: [
        {
          path: section.path,
          side: owned.side,
          startLine: owned.startLine,
          endLine: owned.startLine,
        },
      ],
      doneWhen: null,
      group: "g9",
      evidence: [],
    };
  };
  const findKey = await run.store(
    "test.find",
    FindStored.parse({
      lens: "correctness",
      source: "agent",
      findings: [
        findingOn("correctness.1", X!),
        findingOn("correctness.2", Y!),
        findingOn("correctness.3", Z!),
        findingOn("correctness.4", Z!),
      ],
      notes: [],
      reading: { used: 0, limit: 1 },
    }),
  );
  const { harness, port } = await run.open();
  await harness.commit(async (tx) => {
    (await tx.doc(ReadingsRunDoc)).plan = planKey;
    return undefined;
  }, context);
  // Every reading failed: each section is settled, undecided, with no verdict of its own.
  const readings = plan.groups.flatMap((group) =>
    (["assess", "lane-review"] as const).map((kind) => ({
      name: `${kind}.${group.id}`,
      outcome: {
        status: "failed",
        error: { message: "the reading failed" },
      } as TaskOutcome<unknown>,
    })),
  );
  await port.collect(
    {
      frameKey: FRAME_KEY,
      mapKey,
      manifestKey,
      readings,
      finders: [
        {
          lens: "correctness",
          findKey,
          findings: [
            // Kept: a confirmed claim on X.
            { id: "correctness.1", verifyKey: "verify-1", status: "kept" },
            // Dropped by Verify, unverified, and kept with no Verify: none takes part.
            { id: "correctness.2", verifyKey: "verify-2", status: "dropped" },
            { id: "correctness.3", verifyKey: null, status: "unverified" },
            { id: "correctness.4", verifyKey: null, status: "kept" },
            // Kept, but the stored output does not hold it.
            { id: "correctness.9", verifyKey: "verify-9", status: "kept" },
          ],
          stages: [],
          end: { find: "completed", verify: "completed" },
        },
        {
          // Kept, but the finder's output cannot be read.
          lens: "risky-edges",
          findKey: "f".repeat(64),
          findings: [
            { id: "risky-edges.1", verifyKey: "verify-r", status: "kept" },
          ],
          stages: [],
          end: { find: "completed", verify: "completed" },
        },
      ],
    },
    harness,
    context,
    new AbortController().signal,
  );
  await harness.close(context);

  const row = (key: string) =>
    run.rows.find((r) => r.type === "reading.section" && r["section"] === key)!;
  // Only the kept, verified finding is a claim, and it makes its section request changes.
  expect(row(X!.key)).toMatchObject({
    verdict: "request-changes",
    claims: [
      expect.objectContaining({
        key: "correctness.1",
        source: "finder",
        verify: "confirmed",
        restsOn: true,
      }),
    ],
  });
  for (const section of [Y!, Z!])
    expect(row(section.key)).toMatchObject({ verdict: null, claims: [] });
  const decided = run.rows.find((r) => r.type === "readings.decision")!;
  expect(decided["findings"]).toEqual({ placed: 1, unplaced: 0, unread: 2 });
  // No finding's text in any row.
  expect(
    JSON.stringify(run.rows.filter((r) => r.type.startsWith("reading"))),
  ).not.toContain("FINDER-MARK");
  // For the publisher: one finder comment only, and the run says what could not be read; the
  // settled batches are still handed over.
  const forPublisher = await settledOf(run.services, decided["key"] as string);
  const finderComments = forPublisher.batches
    .flatMap((b) => b.units.flatMap((u) => u.comments))
    .filter((c) => c.body.startsWith("FINDER-MARK"));
  expect(finderComments.map((c) => [c.id, c.section, c.restedOn])).toEqual([
    ["correctness.1", X!.key, true],
  ]);
  expect(forPublisher.batches.length).toBeGreaterThan(0);
  expect(forPublisher.gaps).toEqual([
    {
      key: "findings-unread:2:2",
      kind: "findings-unread",
      detail:
        "2 verified findings of 2 finders could not be read, so they are on no unit, and a unit shown with no finding may still have one.",
    },
  ]);
}, 30_000);

// Reason (round 2h): one confirmed check must not leave a second section that rests on the same
// claim marked as disagreeing with it. A Lane review that writes the same defect (same words, one
// anchor overlapping both sections' lines) on two sections and requests changes on both makes one
// claim, checked once (record 0016); its outcome must reach both sections, their rows and their
// units, whether the two sections share a unit or not, and whatever the check decided.
const sharedClaim = async (
  name: string,
  options: {
    /** The check kept or dropped the claim, failed, or was not reached. */
    readonly decision: "keep" | "drop" | "failed" | "not-reached";
    /** Whether count is assessed high and hard on cited evidence, so it is in a unit of its own. */
    readonly apart: boolean;
  },
) => {
  const run = await world(name);
  const range = mixedRange();
  const plan = planReadings({
    hunks: range.hunks,
    structures: range.structures,
    excluded: range.excluded,
    bounds: { maxItems: 4 },
  });
  const A = plan.groups.find((group) => group.keys.length === 4)!;
  const planKey = await run.store("test.readings-plan", plan);
  const manifestKey = await run.store(
    "test.manifest",
    manifestOf(withoutLeads(range.hunks)),
  );
  const mapKey = await run.store(
    "test.map",
    mapFor(withoutLeads(range.hunks), range.excluded),
  );
  const hunks = new Map(range.hunks.map((hunk) => [hunk.hunkId, hunk]));
  const sources = { hunks, structures: range.structures };
  const assessReading = renderReading(plan, A.id, {
    for: "assess",
    ...sources,
  });
  const reviewReading = renderReading(plan, A.id, {
    for: "lane-review",
    ...sources,
  });
  const index = reviewReading.index;
  const named = (name: string) => {
    const planned = plan.sections.find(
      (s) => s.path === "src/parse.ts" && s.name === name,
    )!;
    return {
      planned,
      section: index.sections.find((s) => s.key === planned.key)!,
    };
  };
  const helper = named("helper");
  const count = named("count");
  expect(A.keys).toContain(helper.planned.key);
  expect(A.keys).toContain(count.planned.key);
  expect(helper.section.file).toBe(count.section.file);
  const lineOf = (owned: ReadonlyArray<{ side: string; startLine: number }>) =>
    owned.find((r) => r.side === "new")!;
  // One anchor, new lines from helper's change to the end of count: it overlaps both sections.
  const start = lineOf(helper.section.owned).startLine;
  const end = Math.max(
    ...count.section.owned
      .filter((r) => r.side === "new")
      .map((r) => r.endLine),
  );
  const numbers = index.sections.map((s) => s.index);
  const others = numbers.filter(
    (s) => s !== helper.section.index && s !== count.section.index,
  );
  const cite = `${count.section.file}n${lineOf(count.section.owned).startLine}`;
  const assess = assessStep({ stage: "verify", reading: assessReading });
  const assessAnswer: AssessAnswer = {
    factors: [{ f: "connections", t: "Callers count items.", cites: [cite] }],
    requirements: [
      {
        t: "Counting returns every parsed item.",
        kinds: ["test-run"],
        cites: [cite],
        testable: true,
        untested: "",
        proof: [],
        agree: true,
      },
    ],
    impact: [],
    classes: options.apart
      ? [
          {
            S: numbers.filter((s) => s !== count.section.index),
            c: "l",
            v: "e",
            F: [],
            R: [],
            person: null,
            gaps: null,
          },
          {
            S: [count.section.index],
            c: "h",
            v: "h",
            F: [0],
            R: [0],
            person: null,
            gaps: null,
          },
        ]
      : [
          {
            S: numbers,
            c: "l",
            v: "e",
            F: [],
            R: [],
            person: null,
            gaps: null,
          },
        ],
  };
  expect(assess.spec.check!(assessAnswer)).toEqual([]);
  const assessKey = await run.store(
    "test.assess",
    AssessStored.parse(
      assess.compose(result(assess.spec.repair!(assessAnswer))),
    ),
  );
  const review = laneReviewStep({
    stage: "verify",
    reading: reviewReading,
    goal: { goal: "Let callers count parsed items.", doneWhen: [] },
    tools: [],
    keys: { frame: "frame-key", manifest: manifestKey },
  });
  const words = "KEEP-CLAIM the count is taken before the items are parsed";
  const defectOn = (s: number) => ({
    s,
    side: "new" as const,
    start,
    end,
    kind: "defect" as const,
    effect: null,
    t: words,
    cites: [],
    fails: "Every caller gets zero.",
    row: null,
  });
  const reviewAnswer: LaneReviewAnswer = {
    files: [...new Set(index.sections.map((s) => s.file))].map((f) => ({
      f,
      checked: "Read the rows and the callers.",
      rows: null,
    })),
    sections: {
      a: others,
      r: [helper.section.index, count.section.index],
      u: [],
    },
    comments: [defectOn(helper.section.index), defectOn(count.section.index)],
    unsure: [],
  };
  // The answer passes the checks: both defects are on lines each section owns.
  expect(review.spec.check!(reviewAnswer)).toEqual([]);
  const reviewKey = await run.store(
    "test.lane-review",
    LaneReviewStored.parse(review.compose(result(reviewAnswer))),
  );
  const claim = claimKey({
    path: "src/parse.ts",
    side: "new",
    startLine: start,
    endLine: end,
    text: words,
  });
  const verifyKey = await run.store(
    "test.claim",
    ClaimStored.parse({
      decision: options.decision === "drop" ? "drop" : "keep",
      reason: "The cited lines show it.",
      claim,
      section: helper.planned.key,
      source: "agent",
    }),
  );
  const readings = [
    {
      name: `assess.${A.id}`,
      outcome: {
        status: "completed",
        result: {
          kind: "assess",
          group: A.id,
          steps: [assessKey],
          claims: [],
          stages: [],
          notJudged: [],
        },
      } as TaskOutcome<ReadingTaskResult>,
    },
    {
      name: `lane-review.${A.id}`,
      outcome: {
        status: "completed",
        result: {
          kind: "lane-review",
          group: A.id,
          steps: [reviewKey],
          // One check of the claim, as the reading task makes it: on the first section only.
          claims: [
            {
              key: claim,
              section: helper.planned.key,
              // A check that failed has no stored output; one never started was not reached.
              verifyKey:
                options.decision === "keep" || options.decision === "drop"
                  ? verifyKey
                  : null,
              reached: options.decision !== "not-reached",
            },
          ],
          stages: [],
          notJudged: [],
        },
      } as TaskOutcome<ReadingTaskResult>,
    },
  ];
  const { harness, port } = await run.open();
  await harness.commit(async (tx) => {
    (await tx.doc(ReadingsRunDoc)).plan = planKey;
    return undefined;
  }, context);
  await port.collect(
    { frameKey: FRAME_KEY, mapKey, manifestKey, readings, finders: [] },
    harness,
    context,
    new AbortController().signal,
  );
  await harness.close(context);
  const row = (key: string) =>
    run.rows.find((r) => r.type === "reading.section" && r["section"] === key)!;
  const decided = run.rows.find((r) => r.type === "readings.decision")!;
  const forPublisher = await settledOf(run.services, decided["key"] as string);
  const units = forPublisher.batches.flatMap((b) => b.units);
  const unitOf = (key: string) =>
    units.find((u) => u.sectionKeys.includes(key))!;
  return { claim, helper: helper.planned, count: count.planned, row, unitOf };
};

test("a claim on two sections in one unit, its one check confirmed: both sections request changes, resting on it", async () => {
  const { claim, helper, count, row, unitOf } = await sharedClaim(
    "shared-claim-confirmed",
    { decision: "keep", apart: false },
  );
  for (const section of [helper, count])
    expect(row(section.key)).toMatchObject({
      state: "settled",
      verdict: "request-changes",
      cause: null,
      claimFates: { confirmed: 1, refuted: 0, unconfirmed: 0 },
      claims: [{ key: claim, verify: "confirmed", restsOn: true }],
    });
  // One unit holds both: its request rests on the one comment, which its ID rule keeps once.
  const unit = unitOf(helper.key);
  expect(unitOf(count.key)).toBe(unit);
  expect(unit.verdict).toBe("request-changes");
  expect(
    unit.comments
      .filter((c) => c.id === claim)
      .map((c) => [c.kind, c.restedOn, c.shown]),
  ).toEqual([["defect", true, true]]);
}, 30_000);

test("a claim on two sections in one unit, its one check refuted: both follow the rule for a refuted claim", async () => {
  const { claim, helper, count, row, unitOf } = await sharedClaim(
    "shared-claim-refuted",
    { decision: "drop", apart: false },
  );
  // A request whose every claim was refuted is undecided (disagreed): human-required, no verdict.
  for (const section of [helper, count])
    expect(row(section.key)).toMatchObject({
      state: "settled",
      verdict: null,
      cause: "disagreed",
      reading: "verify",
      lane: { applied: "human-required" },
      claimFates: { confirmed: 0, refuted: 1, unconfirmed: 0 },
      claims: [{ key: claim, verify: "refuted", restsOn: false }],
    });
  // The refuted defect keeps its place, never shown and never rested on.
  expect(
    unitOf(helper.key)
      .comments.filter((c) => c.id === claim)
      .map((c) => [c.kind, c.restedOn, c.shown]),
  ).toEqual([["defect", false, false]]);
}, 30_000);

// Reason (14.34): count is assessed apart, high and hard, and helper low and easy, which under lane
// rule 4 put them in different units. A confirmed request for changes now moves both axes, so both
// are human-required, and one unit per file and lane holds both: a confirmed claim shared by two
// sections of one file never spans two units any more. Its request rests on the claim once.
test("a claim on two sections assessed apart, its one check confirmed: both are human-required, so one unit holds both and rests its request on it", async () => {
  const { claim, helper, count, row, unitOf } = await sharedClaim(
    "shared-claim-apart",
    { decision: "keep", apart: true },
  );
  for (const section of [helper, count])
    expect(row(section.key)).toMatchObject({
      verdict: "request-changes",
      cause: null,
      claimFates: { confirmed: 1, refuted: 0, unconfirmed: 0 },
      claims: [{ key: claim, verify: "confirmed", restsOn: true }],
    });
  // count high and hard on cited evidence, helper low and easy: both human-required by the moves.
  expect(row(count.key)["lane"]).toMatchObject({ applied: "human-required" });
  expect(row(helper.key)["lane"]).toMatchObject({ applied: "human-required" });
  const unit = unitOf(helper.key);
  expect(unitOf(count.key)).toBe(unit);
  expect(unit.lane).toBe("human-required");
  expect(unit.verdict).toBe("request-changes");
  // The unit holds the claim's comment once (IDs are unique within a unit) and rests on it.
  expect(
    unit.comments
      .filter((c) => c.id === claim)
      .map((c) => [c.restedOn, c.shown]),
  ).toEqual([[true, true]]);
}, 30_000);

test("a claim on two sections whose one check failed or was not reached: both sections take that fate", async () => {
  // Failed (no stored output): the claim is unconfirmed on both, so both are undecided on it.
  const failed = await sharedClaim("shared-claim-failed", {
    decision: "failed",
    apart: false,
  });
  for (const section of [failed.helper, failed.count])
    expect(failed.row(section.key)).toMatchObject({
      state: "settled",
      verdict: null,
      cause: "unconfirmed",
      reading: "verify",
      claimFates: { confirmed: 0, refuted: 0, unconfirmed: 1 },
      claims: [{ key: failed.claim, verify: "unconfirmed", restsOn: false }],
    });
  // Not reached before the follow-on cap: both sections wait for it, neither is decided without it.
  const waiting = await sharedClaim("shared-claim-not-reached", {
    decision: "not-reached",
    apart: false,
  });
  for (const section of [waiting.helper, waiting.count])
    expect(waiting.row(section.key)).toMatchObject({
      state: "waiting",
      verdict: null,
      cause: "not-reached",
      reading: "verify",
      lane: null,
    });
}, 30_000);

// Reason: the readings' plan creates the readings in its own terminal commit, and the runtime
// refuses a task under an owner that is finishing only when that commit is assembled, which would
// fail the whole commit. `create` must make none, write its row, and let the commit land.
test("create makes no reading and writes its row when the owner is completing or terminal, where the runtime would refuse the task at commit", async () => {
  const run = await world("owner-finishing");
  const range = mixedRange();
  const manifestKey = await run.store(
    "test.manifest",
    manifestOf(withoutLeads(range.hunks)),
  );
  await run.storeAt(
    planSpec({
      manifestKey,
      bounds: PROBE.bounds,
      source: captureOutlineSource().key,
    }),
    threeGroups(),
  );
  const { harness, port } = await run.open();
  const prepared = await port.prepare(
    {
      frameKey: FRAME_KEY,
      mapKey: "map-key",
      manifestKey,
      cutoffAt: Date.now() + 60_000,
    },
    new AbortController().signal,
  );
  expect((prepared as { tasks: Array<unknown> }).tasks).toHaveLength(6);
  const root = await harness.root(context);
  const owning = {
    ownership: { kind: "conversation" } as const,
    conversationId: root.id,
  };
  const [ended, finishing] = await harness.commit(
    async (tx) =>
      [
        await tx.createTask(readingOwner, {}, owning),
        await tx.createTask(finishingOwner, {}, owning),
      ] as const,
    context,
  );
  harness.resume();
  await harness.waitForTask(ended, context);
  const statusOf = (task: TaskId) =>
    harness.commit(async (tx) => (await tx.task(task))?.state.status, context);
  // The finishing owner decided its outcome while its child runs: completing (bounded look).
  for (
    let at = 0;
    at < 500 && (await statusOf(finishing)) !== "completing";
    at++
  )
    await Bun.sleep(10);
  expect(await statusOf(ended)).toBe("terminal");
  expect(await statusOf(finishing)).toBe("completing");
  for (const owner of [ended, finishing]) {
    // The runtime's own refusal comes at commit, after the change returned.
    await expect(
      harness.commit(async (tx) => {
        await tx.createTask(
          readingOwner,
          {},
          { ownership: { kind: "task", taskId: owner } },
        );
        return undefined;
      }, context),
    ).rejects.toThrow(/is (terminal|completing)/);
    const before = run.rows.length;
    // `create` in a commit that read nothing first, as the plan's commit calls it: no reading, its
    // row, and the commit lands.
    expect(
      await harness.commit((tx) => port.create(tx, prepared, owner), context),
    ).toEqual([]);
    expect(run.rows.slice(before)).toEqual([
      { type: "readings.create", failed: true, step: "task" },
    ]);
  }
  const tasks = await harness.commit(
    async (tx) => (await tx.scanTasks({}, 1000)).items,
    context,
  );
  expect(tasks.filter((task) => task.kind === READING_TASK)).toEqual([]);
  expect(
    (await harness.snapshot(ReadingsRunDoc, context))?.tasks ?? {},
  ).toEqual({});
  releaseHeld();
  await harness.waitForTask(finishing, context);
  await harness.close(context);
}, 30_000);

/**
 * One run of the risk range's readings, on a route at `effort` (`low` unless given), with effort by
 * risk or without: what `prepare` lists and writes, and the rows `collect` writes for outcomes that
 * leave a row of every kind (a not-started Assess; a Lane review's interrupted read, unstarted claim
 * and failed re-read).
 */
const riskRows = async (byRisk: boolean, effort: RouteEffort = "low") => {
  const run = await world(
    `rows-${byRisk ? "on" : "off"}${effort === "low" ? "" : `-${effort}`}`,
    defaultConfig(undefined, { ...OPUS_ROUTE, effort }),
  );
  const range = riskRange();
  const hunks = withoutLeads(range.hunks);
  const manifestKey = await run.store("test.manifest", manifestOf(hunks));
  const mapKey = await run.store("test.map", mapFor(hunks, []));
  const plan = planReadings({
    hunks,
    structures: range.structures,
    bounds: PROBE.bounds,
    ...(byRisk ? { split: "by-risk" as const } : {}),
  });
  const config: ReadingsConfig = byRisk
    ? { ...PROBE, effort: "by-risk" }
    : PROBE;
  await run.storeAt(
    planSpec({
      manifestKey,
      bounds: PROBE.bounds,
      source: captureOutlineSource().key,
      ...(byRisk ? { effort: "by-risk" as const } : {}),
    }),
    plan,
  );
  const { harness, port } = await run.open(config);
  const prepared = (await port.prepare(
    {
      frameKey: FRAME_KEY,
      mapKey,
      manifestKey,
      cutoffAt: Date.now() + 60_000,
    },
    new AbortController().signal,
  )) as {
    plan: string;
    tasks: Array<{ name: string; input: ReadingTaskInput }>;
  };
  await harness.commit(async (tx) => {
    (await tx.doc(ReadingsRunDoc)).plan = prepared.plan;
    return undefined;
  }, context);
  const claim = "c".repeat(64);
  const readings = plan.groups.flatMap((group) => [
    {
      name: `assess.${group.id}`,
      outcome: { status: "aborted", reason: "cutoff" } as TaskOutcome<unknown>,
    },
    {
      name: `lane-review.${group.id}`,
      outcome: {
        status: "completed",
        result: {
          kind: "lane-review",
          group: group.id,
          steps: [],
          claims: [
            {
              key: claim,
              section: group.keys[0]!,
              verifyKey: null,
              reached: false,
            },
          ],
          stages: [
            {
              stage: "verify",
              agent: `lane-review.${group.id}`,
              status: "interrupted",
              wallMs: 1,
            },
            {
              stage: "verify",
              agent: `verify.claim.${claim.slice(0, 12)}`,
              status: "interrupted",
              wallMs: 1,
            },
          ],
          notJudged: group.keys.map((section) => ({
            section,
            cause: "failed",
          })),
          failures: [{ part: "reread", failure: "invalid_request" }],
        } satisfies ReadingTaskResult,
      } as TaskOutcome<unknown>,
    },
  ]);
  await port.collect(
    { frameKey: FRAME_KEY, mapKey, manifestKey, readings },
    harness,
    context,
    new AbortController().signal,
  );
  await harness.close(context);
  return { run, plan, prepared };
};

// Reason: a run at any effort must be scorable against the rule, and the rows must say the effort
// each call was decided at; closed labels, booleans and counts only, never text.
test("the rows name each call's effort and why, each section's facts and the plan's classes, with effort by risk on and off", async () => {
  const on = await riskRows(true);
  const off = await riskRows(false);
  const [high, medium] = on.plan.groups;
  expect(on.plan.groups).toHaveLength(2);
  expect(off.plan.groups).toHaveLength(1);
  const [only] = off.plan.groups;

  // The tasks `prepare` listed: by risk, fixed levels; off, each kind's (the route's, low here).
  const listed = (prepared: (typeof on)["prepared"]) =>
    prepared.tasks.map(({ input }) => [
      input.kind,
      input.effort,
      input.claimEffort,
    ]);
  expect(listed(on.prepared)).toEqual([
    ["assess", "medium", undefined],
    ["lane-review", "high", "high"],
    ["assess", "medium", undefined],
    ["lane-review", "medium", "high"],
  ]);
  expect(listed(off.prepared)).toEqual([
    ["assess", "low", undefined],
    ["lane-review", "low", undefined],
  ]);

  // The plan row: sections and groups per class, the high sections by reason; `rule` says whether
  // the efforts follow the classes.
  const planRow = (run: (typeof on)["run"]) =>
    run.rows.find((row) => row.type === "readings.plan")!["effort"];
  const sections = { high: 3, medium: 7 };
  const groupsBy = { "top-quarter": 1, removal: 1, "public-surface": 1 };
  const highSectionsBy = {
    "top-quarter+public-surface": 1,
    "top-quarter": 1,
    removal: 1,
  };
  expect(planRow(on.run)).toEqual({
    rule: "by-risk",
    sections,
    groups: { high: 1, medium: 1 },
    groupsBy,
    highSectionsBy,
  });
  expect(planRow(off.run)).toEqual({
    rule: null,
    sections,
    groups: { high: 1, medium: 0 },
    groupsBy,
    highSectionsBy,
  });

  // Each call's row: the effort it was decided at, and why its group's class is high.
  const calls = (run: (typeof on)["run"]) =>
    run.rows
      .filter((row) => row.type === "reading.call")
      .map((row) => [
        row["kind"],
        row["group"],
        row["part"],
        row["run"],
        row["effort"],
        row["effortWhy"],
      ]);
  const all = ["top-quarter", "removal", "public-surface"];
  expect(calls(on.run)).toEqual([
    ["assess", high!.id, "read", "not-started", "medium", all],
    ["lane-review", high!.id, "read", "interrupted", "high", all],
    ["verify-claim", high!.id, "claim", "interrupted", "high", all],
    ["lane-review", high!.id, "reread", "failed", "high", all],
    ["assess", medium!.id, "read", "not-started", "medium", []],
    ["lane-review", medium!.id, "read", "interrupted", "medium", []],
    ["verify-claim", medium!.id, "claim", "interrupted", "high", []],
    ["lane-review", medium!.id, "reread", "failed", "medium", []],
  ]);
  expect(calls(off.run)).toEqual([
    ["assess", only!.id, "read", "not-started", "low", all],
    ["lane-review", only!.id, "read", "interrupted", "low", all],
    ["verify-claim", only!.id, "claim", "interrupted", "low", all],
    ["lane-review", only!.id, "reread", "failed", "low", all],
  ]);

  // Each section's facts, the same on and off: booleans only.
  const facts = (run: (typeof on)["run"]) =>
    Object.fromEntries(
      run.rows
        .filter((row) => row.type === "reading.section")
        .map((row) => [
          row["section"],
          { risk: row["risk"], topQuarter: row["topQuarter"] },
        ]),
    );
  expect(facts(on.run)).toEqual(facts(off.run));
  const byName = (name: string) =>
    facts(on.run)[on.plan.sections.find((s) => s.name === name)!.key];
  expect(byName("f1")).toEqual({
    risk: { removal: false, publicSurface: true },
    topQuarter: true,
  });
  expect(byName("drop")).toEqual({
    risk: { removal: true, publicSurface: false },
    topQuarter: false,
  });
  expect(byName("f9")).toEqual({
    risk: { removal: false, publicSurface: false },
    topQuarter: false,
  });

  // No text in any new field: closed labels, booleans and counts.
  for (const run of [on.run, off.run])
    for (const row of run.rows) {
      if (row.type === "reading.call") {
        expect(["low", "medium", "high"]).toContain(row["effort"] as string);
        for (const why of row["effortWhy"] as Array<string>)
          expect(all).toContain(why);
      }
      if (row.type === "reading.section") {
        const risk = row["risk"] as Record<string, unknown>;
        expect(Object.keys(risk).sort()).toEqual(["publicSurface", "removal"]);
        for (const value of [...Object.values(risk), row["topQuarter"]])
          expect(typeof value).toBe("boolean");
      }
    }
}, 30_000);

// Reason: the effort decided must be the effort recorded: on a high route with nothing set, Assess
// and Lane review are listed and recorded at medium, the claim check at the route's high; effort by
// risk keeps its fixed levels.
test("on a high route, the rows name Assess and Lane review at medium and the claim check at high; by risk, the levels are as on any route", async () => {
  const off = await riskRows(false, "high");
  const on = await riskRows(true, "high");
  const [only] = off.plan.groups;
  const [high, medium] = on.plan.groups;
  const listed = (prepared: (typeof on)["prepared"]) =>
    prepared.tasks.map(({ input }) => [
      input.kind,
      input.effort,
      input.claimEffort,
    ]);
  expect(listed(off.prepared)).toEqual([
    ["assess", "medium", undefined],
    ["lane-review", "medium", undefined],
  ]);
  expect(listed(on.prepared)).toEqual([
    ["assess", "medium", undefined],
    ["lane-review", "high", "high"],
    ["assess", "medium", undefined],
    ["lane-review", "medium", "high"],
  ]);
  const calls = (run: (typeof on)["run"]) =>
    run.rows
      .filter((row) => row.type === "reading.call")
      .map((row) => [row["kind"], row["group"], row["part"], row["effort"]]);
  expect(calls(off.run)).toEqual([
    ["assess", only!.id, "read", "medium"],
    ["lane-review", only!.id, "read", "medium"],
    ["verify-claim", only!.id, "claim", "high"],
    ["lane-review", only!.id, "reread", "medium"],
  ]);
  expect(calls(on.run)).toEqual([
    ["assess", high!.id, "read", "medium"],
    ["lane-review", high!.id, "read", "high"],
    ["verify-claim", high!.id, "claim", "high"],
    ["lane-review", high!.id, "reread", "high"],
    ["assess", medium!.id, "read", "medium"],
    ["lane-review", medium!.id, "read", "medium"],
    ["verify-claim", medium!.id, "claim", "high"],
    ["lane-review", medium!.id, "reread", "medium"],
  ]);
}, 30_000);

// Reason: the record must say when a judgement was carried. A reading another review stored and
// this one found again by its key is carried from that review and run; one this review stored (on
// an earlier run of it, which shares the run key) is fresh. The producer is stored with the output
// and is not part of the key, so both reviews' steps find the same stored reading.
test("a reading another review stored and this one reused is recorded as carried from that review and run, one this review stored is fresh, and the run's judgement ledger counts both", async () => {
  const run = await world("carried");
  const range = mixedRange();
  const plan = planReadings({
    hunks: range.hunks,
    structures: range.structures,
    excluded: range.excluded,
    bounds: { maxItems: 4 },
  });
  const A = plan.groups.find((group) => group.keys.length === 4)!;
  const B = plan.groups.find((group) => group !== A)!;
  expect(A).toBeDefined();
  expect(B).toBeDefined();
  const planKey = await run.store("test.readings-plan", plan);
  const manifestHunks = withoutLeads(range.hunks);
  const manifestKey = await run.store(
    "test.manifest",
    manifestOf(manifestHunks),
  );
  const mapKey = await run.store(
    "test.map",
    mapFor(manifestHunks, range.excluded),
  );
  const hunks = new Map(range.hunks.map((hunk) => [hunk.hunkId, hunk]));
  const sources = { hunks, structures: range.structures };

  const earlier: ReadingProducer = {
    review: "e".repeat(64),
    run: mintUlid(),
    cycle: mintUlid(),
    head: "3".repeat(40),
  };
  // An earlier run of this same review: its run key is this run's.
  const ownEarlierRun: ReadingProducer = {
    review: run.ctx.runKey,
    run: mintUlid(),
    cycle: run.ctx.cycleId,
    head: RANGE.headOid,
  };
  const thisRun: ReadingProducer = {
    review: run.ctx.runKey,
    run: run.ctx.runId,
    cycle: run.ctx.cycleId,
    head: RANGE.headOid,
  };
  const stepOf = (group: typeof A, by: ReadingProducer) =>
    assessStep({
      stage: "verify",
      reading: renderReading(plan, group.id, { for: "assess", ...sources }),
      by,
    });
  const specOf = (step: ReturnType<typeof stepOf>) =>
    agentStageSpec(run.ctx.config, step.spec, {
      op: step.op,
      opVersion: step.opVersion,
      inputs: step.inputs,
    });
  // The producer is not in the key: the earlier review's step and this one's are one computation.
  expect(Computations.computationKey(specOf(stepOf(A, earlier))).key).toBe(
    Computations.computationKey(specOf(stepOf(A, thisRun))).key,
  );
  /** Every section in one plain class, as an answer the checks accept whole. */
  const answerOf = (group: typeof A): AssessAnswer => ({
    factors: [],
    requirements: [],
    impact: [],
    classes: [
      {
        S: renderReading(plan, group.id, {
          for: "assess",
          ...sources,
        }).index.sections.map((section) => section.index),
        c: "l",
        v: "e",
        F: [],
        R: [],
        person: null,
        gaps: null,
      },
    ],
  });
  /** Stores what the step composes under its own key, as the agent step stores it. */
  const stored = async (group: typeof A, by: ReadingProducer) => {
    const step = stepOf(group, by);
    expect(step.spec.check!(answerOf(group))).toEqual([]);
    return run.storeAt(specOf(step), {
      output: AssessStored.parse(step.compose(result(answerOf(group)))),
      summary: null,
    });
  };
  const keyA = await stored(A, earlier);
  const keyB = await stored(B, ownEarlierRun);
  const outputOf = async (key: string) =>
    run.run(
      Effect.gen(function* () {
        const store = yield* Computations.ComputationStore;
        return Option.getOrThrow(yield* store.lookup(key)).outputHash;
      }),
    );

  const reused = (agent: string, key: string): StageRecord => ({
    stage: "verify",
    agent,
    status: "reused",
    key,
    wallMs: 0,
  });
  const readings = [A, B].map((group, at) => ({
    name: `assess.${group.id}`,
    outcome: {
      status: "completed",
      result: {
        kind: "assess",
        group: group.id,
        steps: [[keyA, keyB][at]!],
        claims: [],
        stages: [reused(`assess.${group.id}`, [keyA, keyB][at]!)],
        notJudged: [],
      },
    } as TaskOutcome<ReadingTaskResult>,
  }));
  const { harness, port } = await run.open();
  await harness.commit(async (tx) => {
    (await tx.doc(ReadingsRunDoc)).plan = planKey;
    return undefined;
  }, context);
  await port.collect(
    { frameKey: FRAME_KEY, mapKey, manifestKey, readings },
    harness,
    context,
    new AbortController().signal,
  );
  await harness.close(context);

  const decisionKey = run.rows.find((row) => row.type === "readings.decision")!
    .key as string;
  const decision = await run.run(
    storedOutput(
      run.ctx,
      decisionKey,
      z.looseObject({
        sections: z.array(
          z.looseObject({
            key: z.string(),
            decision: z
              .looseObject({ entry: z.unknown().nullable() })
              .nullable(),
          }),
        ),
      }),
    ),
  );
  const entryOf = (key: string) =>
    AssessedSection.parse(
      decision.sections.find((section) => section.key === key)!.decision!.entry,
    );
  for (const key of A.keys) {
    const entry = entryOf(key);
    expect(entry.lineage).toBe("carried");
    expect(entry.from).toEqual({
      review: earlier.review,
      run: earlier.run,
      cycle: earlier.cycle,
      head: earlier.head,
      judgement: keyA,
      output: await outputOf(keyA),
      savedMs: expect.any(Number),
    });
  }
  for (const key of B.keys) {
    const entry = entryOf(key);
    expect(entry.lineage).toBe("fresh");
    expect(entry.from).toBeUndefined();
  }
  // The ledger: one row per judged section, carried or fresh, and the counts the receipt sends.
  const ledger = run.rows.filter((row) => row.type === "judgement");
  expect(
    ledger
      .map((row) => [row["unit"], row["source"]])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  ).toEqual(
    [
      ...A.keys.map((key) => [key, "carried"]),
      ...B.keys.map((key) => [key, "fresh"]),
    ].sort((a, b) => a[0]!.localeCompare(b[0]!)),
  );
  expect(judgementCounts(run.rows)).toMatchObject({
    carried: A.keys.length,
    fresh: B.keys.length,
  });
});

/**
 * A world that stores real Assess and Lane review outputs under their own step keys, as the agent
 * step stores them, each produced by a review named by `by`, and collects a plan's readings.
 */
const lineageWorld = async (
  name: string,
  plan: ReadingPlan,
  range: {
    readonly hunks: ReturnType<typeof mixedRange>["hunks"];
    readonly structures: ReadonlyMap<string, BlobStructure>;
    readonly excluded: ReturnType<typeof mixedRange>["excluded"];
  },
) => {
  const run = await world(name);
  const planKey = await run.store("test.readings-plan", plan);
  const manifestHunks = withoutLeads(range.hunks);
  const manifestKey = await run.store(
    "test.manifest",
    manifestOf(manifestHunks),
  );
  const mapKey = await run.store(
    "test.map",
    mapFor(manifestHunks, range.excluded),
  );
  const hunks = new Map(range.hunks.map((hunk) => [hunk.hunkId, hunk]));
  const sources = { hunks, structures: range.structures };
  const earlier: ReadingProducer = {
    review: "e".repeat(64),
    run: mintUlid(),
    cycle: mintUlid(),
    head: "3".repeat(40),
  };
  const thisRun: ReadingProducer = {
    review: run.ctx.runKey,
    run: run.ctx.runId,
    cycle: run.ctx.cycleId,
    head: RANGE.headOid,
  };
  type Step = Pick<
    ReturnType<typeof assessStep>,
    "spec" | "op" | "opVersion" | "inputs"
  > & { readonly compose: (result: AgentResult<never>) => unknown };
  /** Stores what the step composes under its own key, taking at least `ms` to compute. */
  const storeStep = (step: Step, answer: unknown, ms = 0) =>
    run.run(
      Effect.gen(function* () {
        const computations = yield* Computations.ComputationStore;
        return (yield* computations.run(
          agentStageSpec(run.ctx.config, step.spec, {
            op: step.op,
            opVersion: step.opVersion,
            inputs: step.inputs,
          }),
          Effect.gen(function* () {
            if (ms > 0) yield* Effect.sleep(`${ms} millis`);
            return {
              bytes: new TextEncoder().encode(
                JSON.stringify({
                  output: step.compose(result(answer as never)),
                  summary: null,
                }),
              ),
              mediaType: "application/json",
            };
          }),
        )).computation.key;
      }),
    );
  /** An Assess of the group (or of `only` its sections, a re-read), every section in one class. */
  const assess = (
    group: string,
    by: ReadingProducer,
    options: {
      readonly only?: ReadonlyArray<string>;
      readonly ms?: number;
    } = {},
  ) => {
    const reading = renderReading(plan, group, {
      for: "assess",
      ...sources,
      ...(options.only === undefined ? {} : { only: options.only }),
    });
    const answer: AssessAnswer = {
      factors: [],
      requirements: [],
      impact: [],
      classes: [
        {
          S: reading.index.sections.map((section) => section.index),
          c: "l",
          v: "e",
          F: [],
          R: [],
          person: null,
          gaps: null,
        },
      ],
    };
    const step = assessStep({ stage: "verify", reading, by });
    expect(step.spec.check!(answer)).toEqual([]);
    return storeStep(step as never, answer, options.ms);
  };
  /** A Lane review of the group approving every section. */
  const review = (group: string, by: ReadingProducer, ms = 0) => {
    const reading = renderReading(plan, group, {
      for: "lane-review",
      ...sources,
    });
    const answer: LaneReviewAnswer = {
      files: [...new Set(reading.index.sections.map((s) => s.file))].map(
        (f) => ({ f, checked: MARKS.checked, rows: null }),
      ),
      sections: {
        a: reading.index.sections.map((section) => section.index),
        r: [],
        u: [],
      },
      comments: [],
      unsure: [],
    };
    const step = laneReviewStep({
      stage: "verify",
      reading,
      goal: { goal: "g", doneWhen: [] },
      tools: [],
      keys: { frame: "frame-key", manifest: manifestKey },
      by,
    });
    expect(step.spec.check!(answer)).toEqual([]);
    return storeStep(step as never, answer, ms);
  };
  const reading = (
    kind: "assess" | "lane-review",
    group: string,
    steps: ReadonlyArray<string>,
  ) => ({
    name: `${kind}.${group}`,
    outcome: {
      status: "completed",
      result: {
        kind,
        group,
        steps: [...steps],
        claims: [],
        stages: steps.map((key): StageRecord => ({
          stage: "verify",
          agent: `${kind}.${group}`,
          status: "reused",
          key,
          wallMs: 0,
        })),
        notJudged: [],
      },
    } as TaskOutcome<ReadingTaskResult>,
  });
  /** Collects the readings; returns each section's stored entry and the run's ledger. */
  const collect = async (
    readings: ReadonlyArray<ReturnType<typeof reading>>,
  ) => {
    const { harness, port } = await run.open();
    await harness.commit(async (tx) => {
      (await tx.doc(ReadingsRunDoc)).plan = planKey;
      return undefined;
    }, context);
    await port.collect(
      { frameKey: FRAME_KEY, mapKey, manifestKey, readings: [...readings] },
      harness,
      context,
      new AbortController().signal,
    );
    await harness.close(context);
    const decisionKey = run.rows.find(
      (row) => row.type === "readings.decision",
    )!.key as string;
    const decision = await run.run(
      storedOutput(
        run.ctx,
        decisionKey,
        z.looseObject({
          sections: z.array(
            z.looseObject({
              key: z.string(),
              decision: z
                .looseObject({ entry: z.unknown().nullable() })
                .nullable(),
            }),
          ),
        }),
      ),
    );
    const entryOf = (key: string) =>
      AssessedSection.parse(
        decision.sections.find((section) => section.key === key)!.decision!
          .entry,
      );
    const ledger = new Map(
      run.rows
        .filter((row) => row.type === "judgement")
        .map((row) => [
          row["unit"] as string,
          { source: row["source"], savedMs: row["savedMs"] as number },
        ]),
    );
    return { entryOf, ledger, counts: judgementCounts(run.rows) };
  };
  return { earlier, thisRun, assess, review, reading, collect };
};

// Reason (round 17, review finding B1): the ledger sums its rows' saved time, and one carried
// reading serves every section of its group, so a group's time must count once, not once per
// section. Each carried computation counts once, Assess and Lane review alike (finding N1).
test("a carried 25-section group records each carried reading's time once in the ledger, Assess and Lane review alike", async () => {
  const files = Array.from(
    { length: 25 },
    (_, at) => `lib/many/f${String(at).padStart(2, "0")}.txt`,
  );
  const hunks = files.flatMap((path, at) =>
    diff(path, `one ${at}\ntwo\n`, `one ${at}\ntwo changed\n`),
  );
  const none = noStructure("unsupported-language", null, 0);
  const structures = new Map<string, BlobStructure>(
    files.flatMap((_, at) => [
      [oidOf(`one ${at}\ntwo\n`), none],
      [oidOf(`one ${at}\ntwo changed\n`), none],
    ]),
  );
  const range = { hunks, structures, excluded: [] };
  const plan = planReadings({
    hunks,
    structures,
    excluded: [],
    bounds: { maxFiles: 32, maxItems: 40, maxCharacters: 48_000 },
  });
  expect(plan.groups).toHaveLength(1);
  const group = plan.groups[0]!;
  expect(group.keys).toHaveLength(25);
  const w = await lineageWorld("carried-group", plan, range);
  const assessKey = await w.assess(group.id, w.earlier, { ms: 60 });
  const reviewKey = await w.review(group.id, w.earlier, 40);
  const { entryOf, ledger, counts } = await w.collect([
    w.reading("assess", group.id, [assessKey]),
    w.reading("lane-review", group.id, [reviewKey]),
  ]);
  // Every entry names the Assess it rests on, with that reading's own time.
  const assessMs = entryOf(group.keys[0]!).from!.savedMs;
  expect(assessMs).toBeGreaterThanOrEqual(60);
  for (const key of group.keys) {
    expect(entryOf(key).lineage).toBe("carried");
    expect(entryOf(key).from).toMatchObject({
      judgement: assessKey,
      savedMs: assessMs,
    });
  }
  // The ledger: 25 carried rows; the two readings' times on one row, 0 on the other 24.
  expect([...ledger.values()].map((row) => row.source)).toEqual(
    Array(25).fill("carried"),
  );
  const timed = [...ledger.values()].filter((row) => row.savedMs > 0);
  expect(timed).toHaveLength(1);
  expect(timed[0]!.savedMs).toBeGreaterThanOrEqual(assessMs + 40);
  expect(counts).toMatchObject({ carried: 25, fresh: 0 });
  expect(counts.savedSeconds).toBe(timed[0]!.savedMs / 1000);
}, 30_000);

// Reason (Neuve's review of round 17): the lineage must hold for a reused Lane review as for a reused
// Assess, and a section this review read again is this review's judgement, not the earlier one's.
test("only a reused Lane review makes its sections carried from it; a section this review re-read over a carried Assess is fresh, its neighbours carried", async () => {
  const range = mixedRange();
  const plan = planReadings({
    hunks: range.hunks,
    structures: range.structures,
    excluded: range.excluded,
    bounds: { maxItems: 4 },
  });
  const A = plan.groups.find((group) => group.keys.length === 4)!;
  const B = plan.groups.find((group) => group !== A)!;
  expect(A).toBeDefined();
  expect(B).toBeDefined();
  const w = await lineageWorld("carried-review", plan, range);
  // Group A: Assess this review's; Lane review another review's.
  const assessA = await w.assess(A.id, w.thisRun);
  const reviewA = await w.review(A.id, w.earlier);
  // Group B: Assess another review's, then re-read here for its first section; Lane review here.
  const assessB = await w.assess(B.id, w.earlier);
  const rereadB = await w.assess(B.id, w.thisRun, { only: [B.keys[0]!] });
  const reviewB = await w.review(B.id, w.thisRun);
  const { entryOf, ledger, counts } = await w.collect([
    w.reading("assess", A.id, [assessA]),
    w.reading("lane-review", A.id, [reviewA]),
    w.reading("assess", B.id, [assessB, rereadB]),
    w.reading("lane-review", B.id, [reviewB]),
  ]);
  for (const key of A.keys) {
    expect(entryOf(key).lineage).toBe("carried");
    expect(entryOf(key).from).toMatchObject({
      review: w.earlier.review,
      run: w.earlier.run,
      judgement: reviewA,
    });
  }
  expect(entryOf(B.keys[0]!).lineage).toBe("fresh");
  expect(entryOf(B.keys[0]!).from).toBeUndefined();
  for (const key of B.keys.slice(1)) {
    expect(entryOf(key).lineage).toBe("carried");
    expect(entryOf(key).from).toMatchObject({ judgement: assessB });
  }
  // The ledger as the entries say; each carried reading's time on one row only.
  for (const key of [...A.keys, ...B.keys])
    expect(ledger.get(key)!.source).toBe(entryOf(key).lineage);
  expect(ledger.get(B.keys[0]!)!.savedMs).toBe(0);
  const timedA = A.keys.filter((key) => ledger.get(key)!.savedMs > 0);
  const timedB = B.keys.filter((key) => ledger.get(key)!.savedMs > 0);
  expect(timedA.length).toBeLessThanOrEqual(1);
  expect(timedB.length).toBeLessThanOrEqual(1);
  expect(counts).toMatchObject({
    carried: A.keys.length + B.keys.length - 1,
    fresh: 1,
  });
}, 30_000);
