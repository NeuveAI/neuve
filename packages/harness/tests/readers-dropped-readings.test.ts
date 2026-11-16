// Why (NEU-148, readers round 18, the release retest's item ii): when the section readings' plan
// failed admission (a repository path over the budget host's limit), the review went on with no
// section readings and said nothing, so a person read a packet that looked like the redesign's. Every
// drop of the plan now publishes per batch from a plan that stands in for it, every section the
// person's with the builder's note, and one run gap that says how the plan ended; "nothing to read"
// and the off switch say nothing. These drive the real review task, the real plan task with the
// real readings port and the real batch waiters, and publish through the real `publishSettled` on
// a real Records store, with stand-in front, finder, fill, link and old-packet stages.
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
} from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { Context, Effect, Layer, Scope } from "effect";
import {
  Blobs,
  Computations,
  PublishedPackets,
  Store,
  mintUlid,
  storeLocationIn,
} from "@neuve/records-core";
import type { RecordEvent } from "@neuve/records-schema";
import { graphTestPrerequisite } from "../../../scripts/graph-test-prerequisite.ts";
import type { Budget } from "../src/budget/scheduler.ts";
import { defaultConfig, type ReadingsConfig } from "../src/config.ts";
import { FINDERS } from "../src/find.ts";
import { captureOutlineSource } from "../src/graph-outline.ts";
import { defaultManifestSettings, frontManifest } from "../src/manifest.ts";
import { McpClients, mcpClientsLayer } from "../src/mcp-client.ts";
import type { PrecomputeOutput, StageRecord } from "../src/pipeline.ts";
import {
  childOf,
  reviewExtension,
  reviewTask,
  type PublishInput,
  type ReviewStagesPort,
} from "../src/pi/review-task.ts";
import { settledStages } from "../src/pi/stages/batch-waiter-task.ts";
import type {
  FinderInput,
  FinderResult,
} from "../src/pi/stages/finder-task.ts";
import type { FrontInput, FrontResult } from "../src/pi/stages/front-task.ts";
import { agentKinds } from "../src/pi/stages/kinds.ts";
import { readingTask } from "../src/pi/stages/reading-task.ts";
import { readingsStages } from "../src/pi/stages/readings-plan-task.ts";
import { stageRunner, type StageServices } from "../src/pi/stages/services.ts";
import { DEFAULT_READING_BOUNDS } from "../src/reading-groups.ts";
import { readingsPort } from "../src/readings/collect.ts";
import { READING_RECIPE } from "../src/readings/plan.ts";
import { ReviewMap, buildMapManifest } from "../src/review-map.ts";
import { buildReceipt } from "../src/receipt.ts";
import { zeroUsage } from "../src/route.ts";
import type { RunLog, RunLogRecord } from "../src/run-log.ts";
import { frame } from "./fixtures/link.ts";
import { eventsOf } from "./publish-sections-fixtures.ts";

const ENGINE = "NEUVE_GRAPH_OUTLINE_EXECUTABLE";
const source = captureOutlineSource();
const graph = graphTestPrerequisite({
  available: "sha256" in source.key,
  message:
    "The Graph engine at NEUVE_GRAPH_OUTLINE_EXECUTABLE (or apps/neuve-graph/entire-graph) is missing: build it, or point the variable at one.",
});

const directory = mkdtempSync(join(tmpdir(), "readers-dropped-readings-"));
const scopes: Array<Scope.Closeable> = [];
afterAll(async () => {
  for (const scope of scopes)
    await Effect.runPromise(Scope.close(scope, {} as never)).catch(() => {});
  rmSync(directory, { recursive: true, force: true });
});

const PROBE: ReadingsConfig = {
  mode: "probe",
  bounds: { ...DEFAULT_READING_BOUNDS, maxFiles: 1 },
  recipe: READING_RECIPE,
};
/** The gap a dropped plan's packet carries, word for word. */
const DROPPED =
  "Section readings: the plan for reading the changed sections failed, so no reading judged them and a person decides each one.";

type Packet = Extract<RecordEvent, { kind: "packet.published@2" }>;
const record = (
  stage: StageRecord["stage"],
  agent: string,
  status: StageRecord["status"] = "computed",
): StageRecord => ({ stage, agent, status, wallMs: 1 });

/** A repository with two commits: two changed code files, or an empty change (nothing to read). */
const repositoryOf = (name: string, change: "code" | "empty") => {
  const repository = join(directory, name, "repo");
  mkdirSync(join(repository, "src"), { recursive: true });
  Bun.spawnSync(["git", "init", "-q", repository]);
  const git = (...args: Array<string>) =>
    Bun.spawnSync(["git", "-C", repository, ...args])
      .stdout.toString()
      .trim();
  const commit = (message: string) => {
    git("add", "-A");
    git(
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.test",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      message,
    );
    return git("rev-parse", "HEAD");
  };
  writeFileSync(
    join(repository, "src", "count.ts"),
    "export function count(items: Array<string>) {\n  return items.length;\n}\n",
  );
  writeFileSync(
    join(repository, "src", "label.ts"),
    "export const label = (n: number) => `${n} items`;\n",
  );
  const base = commit("base");
  if (change === "code") {
    writeFileSync(
      join(repository, "src", "count.ts"),
      "export function count(items: Array<string>) {\n  return items.filter(Boolean).length;\n}\n",
    );
    writeFileSync(
      join(repository, "src", "label.ts"),
      'export const label = (n: number) => `${n} item${n === 1 ? "" : "s"}`;\n',
    );
  }
  const head = commit("count only filled items");
  return { repository, range: { baseOid: base, headOid: head } };
};

/** A budget host that refuses every grant, as one refuses an owner path over its limit. */
const refusing: Budget = {
  admit: async () => {
    throw new Error("owner: Too big: expected string to have <=128 characters");
  },
  throttle: async () => {},
  capacity: async () => ({}) as never,
  observe: async () => ({}) as never,
};

type World = Awaited<ReturnType<typeof worldOf>>;
const worlds = new Map<string, World>();
/** A repository and its Records store, with one cycle that every run of it publishes in. */
const worldOf = async (name: string, change: "code" | "empty") => {
  const { repository, range } = repositoryOf(name, change);
  const location = storeLocationIn(join(directory, name, "store"));
  const scope = await Effect.runPromise(Scope.make());
  scopes.push(scope);
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
  return {
    repository,
    range,
    location,
    records,
    clients,
    cycleId: mintUlid(),
  };
};

/**
 * One real review on a real Records store. `admission: "refused"`: every CPU grant the readings ask
 * for is refused, so the readings' plan fails admission. `change: "empty"`: the range changes no
 * file (nothing to read). `readings: false`: the off switch, so the run has no readings port.
 */
const runReview = async (
  name: string,
  options: {
    readonly admission?: "refused";
    readonly change?: "code" | "empty";
    readonly readings?: boolean;
    /** How each finder's Find ended: by submit (the default) or at the finders' time limit. */
    readonly finderEnd?: "submit" | "timeout";
    /** The stored Map holds none of the changed hunks, so no batch can be formed. */
    readonly emptyMap?: boolean;
    /** The run has the readings port but no publish phase (`settledStages` gives none). */
    readonly publisher?: boolean;
    /** The finders' Find records' status: computed (the default), or reused from a stored answer. */
    readonly finderStatus?: "computed" | "reused";
    /** The run's cut-off from now; by default ten minutes. Under 75 s, the plan is cut at once. */
    readonly cutoffAfterMs?: number;
    /** False: no follow-on run is left under the cap, so this run has no successor. */
    readonly successor?: boolean;
    /** The request's generation: above 0, a follow-on run of the same run key. */
    readonly generation?: number;
    /** The readings' `prepare` throws (a read it makes fails), so the plan task ends `failed`. */
    readonly prepareThrows?: boolean;
  } = {},
) => {
  process.env[ENGINE] = source.executable;
  const on = options.readings !== false;
  // One repository, store and cycle per name: a follow-on run of the same name shares them.
  const world =
    worlds.get(name) ?? (await worldOf(name, options.change ?? "code"));
  worlds.set(name, world);
  const { repository, range, location, records, clients, cycleId } = world;
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
    repository,
    runId,
    runKey: "f".repeat(64),
    range: { baseRef: "main", ...range },
    cycleId,
    config: on ? { ...defaultConfig(), readings: PROBE } : defaultConfig(),
    log,
    startedAt: Date.now(),
    reconciliationId: mintUlid(),
    records,
  };
  // The manifest and the Map as the review's earlier stages store them, with grants as usual.
  const plain = stageRunner(ctx, clients);
  const manifest = await plain(
    frontManifest(
      repository,
      range,
      defaultManifestSettings(1_000_000),
      source,
    ),
  );
  const hunks = manifest.value.hunks;
  const map = ReviewMap.parse({
    frame: "frame-key",
    source: "agent",
    groups:
      hunks.length === 0 || options.emptyMap === true
        ? []
        : [
            {
              id: "m1",
              label: "Counting",
              why: "Counting changes.",
              tier: "core",
              doneWhen: [],
              files: [...new Set(hunks.map((hunk) => hunk.path))].map(
                (path) => ({ path, placedBy: "map" }),
              ),
              hunkIds: hunks.map((hunk) => hunk.hunkId),
              changedLines: hunks.length,
            },
          ],
    excluded: buildMapManifest(manifest.value).excluded,
    rolledUp: [],
    unlinkedDoneWhen: [],
    gaps: [],
  });
  const mapKey = await plain(
    Effect.gen(function* () {
      const computations = yield* Computations.ComputationStore;
      return (yield* computations.run(
        { op: "test.map", opVersion: 1, inputs: { name } },
        Effect.succeed({
          bytes: new TextEncoder().encode(JSON.stringify(map)),
          mediaType: "application/json",
        }),
      )).computation.key;
    }),
  );
  // The Frame collect reads for each unit's Guided rows (round 25).
  const frameKey = await plain(
    Effect.gen(function* () {
      const computations = yield* Computations.ComputationStore;
      return (yield* computations.run(
        { op: "test.frame", opVersion: 1, inputs: { name } },
        Effect.succeed({
          bytes: new TextEncoder().encode(JSON.stringify(frame)),
          mediaType: "application/json",
        }),
      )).computation.key;
    }),
  );
  // The readings' and the publisher's stage runner: with `admission: "refused"`, every grant fails.
  const run =
    options.admission === "refused"
      ? stageRunner(ctx, clients, refusing)
      : plain;
  const registry = createRegistry();
  const services: StageServices = {
    ctx,
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
  const kinds = agentKinds(services, {
    prepare: async () => {
      throw new Error("no step runs in this test");
    },
  });
  const reading = readingTask(services, kinds.agentStep);
  const real = on ? readingsPort(services, reading, PROBE) : undefined;
  const port =
    real === undefined || options.prepareThrows !== true
      ? real
      : {
          ...real,
          prepare: async () => {
            throw new Error("the stored plan could not be read");
          },
        };
  const plan = readingsStages(log, port);
  const settled = settledStages(services, port);

  // Stand-ins: each finder completes with no finding; the front task starts them and ends with
  // the Frame and the Map.
  const finder = defineTask<FinderInput, { phase: "run" }, FinderResult>({
    name: "test.finder",
    version: 1,
    initial: () => ({ phase: "run" }),
    phases: {
      run: (task, runtime, context) =>
        runtime.commit(
          () => ({
            status: "terminal",
            outcome: {
              status: "completed",
              result: {
                lens: task.input.lens,
                findKey: null,
                findings: [],
                stages: [
                  {
                    ...record(
                      "find",
                      `find.${task.input.lens}`,
                      options.finderStatus ?? "computed",
                    ),
                    agentResult: {
                      agent: `find.${task.input.lens}`,
                      stage: "find",
                      status: "submitted",
                      endedBy: options.finderEnd ?? "submit",
                      turnsUsed: 1,
                      turnLimit: 12,
                      finalGeneration: options.finderEnd === "timeout",
                      usage: zeroUsage,
                      costUsd: null,
                      resumedTurns: 0,
                      restarted: false,
                      modelCalls: 1,
                    },
                  },
                ],
                end: { find: "completed", verify: "completed" },
              },
            },
          }),
          context,
        ),
    },
    abort: (_task, runtime, context) =>
      runtime.commit(
        () => ({
          status: "terminal",
          outcome: { status: "aborted", reason: "stopped" },
        }),
        context,
      ),
  });
  const front = defineTask<FrontInput, { phase: "run" }, FrontResult>({
    name: "test.front",
    version: 1,
    initial: () => ({ phase: "run" }),
    phases: {
      run: (task, runtime, context) =>
        runtime.commit(async (tx) => {
          const owner = (await tx.task(runtime.taskId))?.owner;
          const finders: Array<{
            lens: FinderInput["lens"];
            task: TaskId<FinderResult>;
          }> = [];
          for (const lens of FINDERS)
            finders.push({
              lens,
              task: await tx.createTask(
                finder,
                {
                  lens,
                  frameKey,
                  manifestKey: manifest.key,
                  front: runtime.taskId,
                  cutoffAt: task.input.cutoffAt,
                  deadline: task.input.cutoffAt,
                },
                { ownership: { kind: "task", taskId: owner! } },
              ),
            });
          return {
            status: "terminal",
            outcome: {
              status: "completed",
              result: {
                stages: [record("frame", "frame")],
                frameKey,
                mapKey,
                manifestKey: manifest.key,
                scopeKey: "scope-key",
                strongestStratum: "nothing",
                frameStratum: "nothing",
                disclosures: [],
                finders: {
                  start: runtime.now(),
                  deadline: task.input.cutoffAt,
                  started: true,
                  finders,
                },
              },
            },
          };
        }, context),
    },
    abort: (_task, runtime, context) =>
      runtime.commit(
        () => ({
          status: "terminal",
          outcome: { status: "aborted", reason: "stopped" },
        }),
        context,
      ),
  });
  const calls: Array<string> = [];
  let asked = 0;
  let published: PublishInput | undefined;
  const stages: ReviewStagesPort = {
    front: childOf(front),
    precompute: async () => ({
      record: record("precompute", "precompute"),
      facts: {
        key: "precompute-key",
        output: {
          files: [],
          diffBytes: 0,
          manifest: manifest.key,
          scope: "scope-key",
          hunks: hunks.length,
          reviewLines: hunks.length,
          strongestStratum: "nothing",
          scopeGaps: [],
        } as unknown as PrecomputeOutput,
      },
    }),
    fill: async () => ({ record: record("link", "link.fill"), groups: [] }),
    link: async () => ({
      record: record("link", "link"),
      candidates: [],
      changeMapKey: "change-map-key",
      disclosures: [],
    }),
    publish: async (input) => {
      calls.push("publish");
      published = input;
      return [record("publish", "publish")];
    },
    ...plan.port,
    ...(options.publisher === false
      ? {}
      : {
          ...settled.port,
          ...(options.successor === false
            ? { followOnLeft: async () => false }
            : {}),
          // Each ask counted; the store has no request to follow, so records refuses it.
          followOn: async (signal?: AbortSignal) => {
            asked += 1;
            return settled.port.followOn === undefined
              ? "refused"
              : settled.port.followOn(signal);
          },
        }),
  };
  registry.install(
    defineExtension({
      name: "test.stages",
      tasks: [kinds.agentStep, reading, front, finder, plan.task, settled.task],
    }),
  );
  const review = reviewTask(stages, log);
  registry.install(reviewExtension(review));
  const harness = await Harness.open(
    new MemoryStorage(),
    {
      models: createModels(),
      registry,
      settings: { compaction: { enabled: false }, retry: { maxRetries: 0 } },
    },
    context,
  );
  try {
    const root = await harness.root(context);
    const id = await harness.commit(
      (tx) =>
        tx.createTask(
          review,
          {
            range: { baseRef: "main", ...range },
            config: {} as never,
            runKey: ctx.runKey,
            runId,
            cycleId,
            generation: options.generation ?? 0,
            cutoffAt: Date.now() + (options.cutoffAfterMs ?? 600_000),
          },
          { ownership: { kind: "conversation" }, conversationId: root.id },
        ),
      context,
    );
    harness.resume();
    const done = await harness.waitForTask(id, context);
    type Services = typeof records extends Context.Context<infer S> ? S : never;
    const inRecords = <A, E>(program: Effect.Effect<A, E, Services>) =>
      Effect.runPromise(Effect.provide(program, records));
    const packets = (
      (await inRecords(
        eventsOf(cycleId, "packet.published@2"),
      )) as Array<Packet>
    ).sort((x, y) => (x.id < y.id ? -1 : 1));
    const newest =
      packets.length === 0
        ? undefined
        : await inRecords(PublishedPackets.readExact(packets.at(-1)!.id));
    // The run's receipt, from its run log as the runtime builds it.
    const receipt = buildReceipt({
      runId,
      runKey: ctx.runKey,
      generation: options.generation ?? 0,
      jobSeq: 1,
      range: { baseRef: "main", ...range },
      cycleId,
      config: ctx.config,
      enqueuedAt: new Date(ctx.startedAt).toISOString(),
      startedAt: ctx.startedAt,
      endedAt: Date.now(),
      stages: [],
      records: rows,
    });
    return {
      asked,
      receipt,
      outcome: done.state.outcome,
      calls,
      published,
      packets,
      newest: newest?.kind === "packet.published@2" ? newest : undefined,
      rows,
    };
  } finally {
    await harness.close(context);
  }
};

// Reason: the defect. The readings' plan fails admission inside the real review: the review still
// publishes per batch through the real publisher, never the old packet, the packet carries the one
// gap with its exact text, and every section is human-required with the builder's note, with no
// agent's disposition anywhere.
test.skipIf(graph.skip)(
  "a readings plan refused admission publishes every section to a person, with the gap that says the plan failed",
  async () => {
    graph.require();
    const run = await runReview("refused", { admission: "refused" });
    expect(run.outcome?.status).toBe("completed");
    expect(
      run.rows.filter((row) => row.type === "readings.plan"),
    ).toContainEqual({ type: "readings.plan", plan: null, unavailable: true });
    expect(run.calls).not.toContain("publish");
    const packet = run.newest!;
    expect(packet.complete).toBe(true);
    const sectionGaps = packet.gaps
      .map((gap) => gap.payload)
      .filter((gap) => gap.kind === "section-readings");
    expect(sectionGaps.map((gap) => gap.detail)).toEqual([DROPPED]);
    const units = packet.batches.flatMap((batch) => batch.units);
    const pathOf = (unit: (typeof units)[number]) =>
      (unit.recorded?.payload as { readonly path?: string } | undefined)?.path;
    expect(units.map(pathOf).sort()).toEqual(["src/count.ts", "src/label.ts"]);
    for (const unit of units) {
      expect(unit.assessment?.payload.lane).toBe("human-required");
      expect(unit.disposition).toBeUndefined();
      expect(unit.sections.length).toBeGreaterThan(0);
      for (const section of unit.sections)
        expect(section.undecided?.cause).toBe("failed");
    }
    // The builder's note, one per unit: no agent decided its sections, so a person does.
    const notes = packet.gaps
      .map((gap) => gap.payload)
      .filter((gap) => gap.kind === "undecided-failed");
    expect(notes).toHaveLength(units.length);
    for (const note of notes)
      expect(note.detail).toMatch(
        /^No agent decided .* in this run, so a person decides (it|them)\.$/,
      );
  },
  240_000,
);

// Reason: no false alarms. A range with nothing to read, and the off switch, publish the old packet
// as before: no section-readings gap, no per-batch packet.
test.skipIf(graph.skip)(
  "nothing to read, and the readings off, publish as before with no section-readings gap",
  async () => {
    graph.require();
    for (const [name, options] of [
      ["nothing-to-read", { change: "empty" }],
      ["off", { readings: false }],
    ] as const) {
      const run = await runReview(name, options);
      expect({ name, status: run.outcome?.status }).toEqual({
        name,
        status: "completed",
      });
      expect({ name, calls: run.calls }).toEqual({ name, calls: ["publish"] });
      expect({ name, packets: run.packets.length }).toEqual({
        name,
        packets: 0,
      });
      expect({
        name,
        disclosures: run.published!.disclosures.filter(
          (d) => d.kind === "section-readings",
        ),
      }).toEqual({ name, disclosures: [] });
    }
  },
  240_000,
);

// Reason (the coordinator's addition, and round 31 for a reused answer): a finder that gave its final answer because the finders'
// time limit came is still `completed`, but a person is told: the receipt carries one plain line and
// the packet one disclosed gap. A finder that ended by submit gives neither.
test.skipIf(graph.skip)(
  "a finder answering at its time limit puts one line on the receipt and the packet; one ending by submit puts none",
  async () => {
    graph.require();
    const LINE = "The finders answered at their time limit.";
    const GAP =
      "The finders answered at their time limit, so their findings are what they had found by then.";
    // Round 31: a time-limited answer reused from the store (a follow-on, or a review sharing it)
    // keeps how it ended, so it gives the same line.
    for (const [finderEnd, finderStatus] of [
      ["timeout", "computed"],
      ["timeout", "reused"],
      ["submit", "computed"],
    ] as const) {
      const run = await runReview(`finders-${finderEnd}-${finderStatus}`, {
        admission: "refused",
        finderEnd,
        finderStatus,
      });
      const at = finderEnd === "timeout";
      expect({ finderEnd, status: run.outcome?.status }).toEqual({
        finderEnd,
        status: "completed",
      });
      expect({
        finderEnd,
        lines: run.receipt.disclosures.filter((d) => d === LINE),
      }).toEqual({ finderEnd, lines: at ? [LINE] : [] });
      // The finders' status is unchanged: every one completed.
      const ended = run.rows.filter((row) => row.type === "finders.ended");
      expect(ended.at(-1)?.["finders"]).toEqual(
        FINDERS.map((lens) => ({
          lens,
          find: "completed",
          verify: "completed",
          again: false,
        })),
      );
      expect({
        finderEnd,
        gaps: run
          .newest!.gaps.map((gap) => gap.payload)
          .filter((gap) => gap.kind === "finders-at-limit")
          .map((gap) => gap.detail),
      }).toEqual({ finderEnd, gaps: at ? [GAP] : [] });
    }
  },
  240_000,
);

// Reason (review N1): no silent drop. A dropped plan whose batches cannot be formed (the stored Map
// holds none of the changed hunks), or a run with the readings port but no publish phase, publishes
// the old packet; it carries the line that no reading ran, and only that section-readings line.
test.skipIf(graph.skip)(
  "a dropped plan with no batch to publish, or no publisher, puts the no-readings line on the old packet",
  async () => {
    graph.require();
    const NONE_RAN =
      "Section readings: none ran in this review, so no section was judged by a reading.";
    for (const [name, options] of [
      ["no-batch", { emptyMap: true }],
      ["no-publisher", { publisher: false }],
    ] as const) {
      const run = await runReview(`dropped-${name}`, {
        admission: "refused",
        ...options,
      });
      expect({ name, status: run.outcome?.status }).toEqual({
        name,
        status: "completed",
      });
      expect({ name, calls: run.calls }).toEqual({ name, calls: ["publish"] });
      expect({ name, packets: run.packets.length }).toEqual({
        name,
        packets: 0,
      });
      expect({
        name,
        lines: run
          .published!.disclosures.filter((d) => d.kind === "section-readings")
          .map((d) => d.detail),
      }).toEqual({ name, lines: [NONE_RAN] });
    }
  },
  240_000,
);

const HELD =
  "Section readings: the plan for reading the changed sections did not finish before its cut-off, so its sections wait for the next run.";
const CUT_SETTLED =
  "Section readings: the plan for reading the changed sections did not finish before its cut-off, so no reading judged them and a person decides each one.";
/** Every section key a packet's batches publish. */
const sectionKeysOf = (
  packet: NonNullable<Awaited<ReturnType<typeof runReview>>["newest"]>,
) =>
  packet.batches.flatMap((batch) =>
    batch.units.flatMap((unit) => unit.sections.map((section) => section.key)),
  );

// Reason (round 31, the reviewer's addendum): a plan cut at the cut-off is "not reached", as a cut
// reading is. With a successor, the stand-in plan's batches all wait: nothing is decided, every
// batch is pending, the run asks for its follow-on, and the gap says the sections wait.
test.skipIf(graph.skip)(
  "a first run whose plan is cut publishes nothing decided, holds every batch, and asks one follow-on",
  async () => {
    graph.require();
    const run = await runReview("cut-successor", { cutoffAfterMs: 60_000 });
    expect(run.outcome?.status).toBe("completed");
    expect(run.calls).not.toContain("publish");
    expect(run.asked).toBe(1);
    const packet = run.newest!;
    expect(packet.complete).toBe(false);
    expect(packet.batches).toEqual([]);
    expect(packet.counts.pending.batches).toBeGreaterThan(0);
    expect(packet.counts.pending.sections).toBeGreaterThan(0);
    expect(
      packet.gaps
        .map((gap) => gap.payload)
        .filter((gap) => gap.kind === "section-readings")
        .map((gap) => gap.detail),
    ).toEqual([HELD]);
  },
  240_000,
);

// Reason (the reviewer's addendum): with no successor, the cut plan's batches settle by the last-run
// rule: every section human-required, cause not-reached, no disposition, the gap saying a person
// decides each one; no follow-on is asked.
test.skipIf(graph.skip)(
  "a run with no successor whose plan is cut settles every section as human-required, not reached",
  async () => {
    graph.require();
    const run = await runReview("cut-final", {
      cutoffAfterMs: 60_000,
      successor: false,
    });
    expect(run.outcome?.status).toBe("completed");
    expect(run.asked).toBe(0);
    const packet = run.newest!;
    expect(packet.complete).toBe(true);
    const units = packet.batches.flatMap((batch) => batch.units);
    expect(units.length).toBe(2);
    for (const unit of units) {
      expect(unit.assessment?.payload.lane).toBe("human-required");
      expect(unit.disposition).toBeUndefined();
      for (const section of unit.sections)
        expect(section.undecided?.cause).toBe("not-reached");
    }
    expect(
      packet.gaps
        .map((gap) => gap.payload)
        .filter((gap) => gap.kind === "section-readings")
        .map((gap) => gap.detail),
    ).toEqual([CUT_SETTLED]);
  },
  240_000,
);

// Reason (the reviewer's addendum, and round 31's reversal check): a follow-on whose plan is cut
// off holds its batches and asks again, so the chain never stalls; when a later run's real plan
// decides, nothing decided earlier is reversed (the cut runs decided no section, by key).
test.skipIf(graph.skip)(
  "a follow-on whose plan is cut holds every batch and asks again; the real plan then decides with no reversal",
  async () => {
    graph.require();
    const first = await runReview("cut-chain", { cutoffAfterMs: 60_000 });
    const followOn = await runReview("cut-chain", {
      cutoffAfterMs: 60_000,
      generation: 1,
    });
    expect(followOn.outcome?.status).toBe("completed");
    expect(followOn.calls).not.toContain("publish");
    expect(followOn.asked).toBe(1);
    // Its ending call adds nothing the chain's newest packet does not already say, so the publisher
    // keeps that packet; it still holds every batch pending.
    expect(followOn.packets.length).toBeGreaterThanOrEqual(
      first.packets.length,
    );
    const held = followOn.newest!;
    expect(held.complete).toBe(false);
    expect(held.batches).toEqual([]);
    expect(held.counts.pending.batches).toBeGreaterThan(0);
    // The next generation plans for real: its sections are decided (no model here, so its readings
    // fail and each is the person's), and no section key the cut runs published changes.
    const decided = await runReview("cut-chain", { generation: 2 });
    expect(decided.outcome?.status).toBe("completed");
    const last = decided.newest!;
    expect(last.complete).toBe(true);
    const before = [first.newest!, held].flatMap(sectionKeysOf);
    expect(before).toEqual([]);
    expect(sectionKeysOf(last).length).toBeGreaterThan(0);
    expect(
      last.gaps
        .map((gap) => gap.payload)
        .filter((gap) => gap.detail === HELD || gap.detail === CUT_SETTLED),
    ).toEqual([]);
  },
  240_000,
);

// Reason (round 32): a missing readings document does not prove a cut-off. A `prepare` that throws
// leaves none too; its plan failed, so the run settles every section as the person's at once, asks
// no follow-on, and the gap says the plan failed, never that a cut-off happened.
test.skipIf(graph.skip)(
  "a prepare that throws settles every section as failed, asks no follow-on, and says the plan failed",
  async () => {
    graph.require();
    const run = await runReview("prepare-throws", { prepareThrows: true });
    expect(run.outcome?.status).toBe("completed");
    expect(run.asked).toBe(0);
    expect(run.calls).not.toContain("publish");
    const packet = run.newest!;
    expect(packet.complete).toBe(true);
    const units = packet.batches.flatMap((batch) => batch.units);
    expect(units.length).toBe(2);
    for (const unit of units) {
      expect(unit.assessment?.payload.lane).toBe("human-required");
      expect(unit.disposition).toBeUndefined();
      for (const section of unit.sections)
        expect(section.undecided?.cause).toBe("failed");
    }
    expect(
      packet.gaps
        .map((gap) => gap.payload)
        .filter((gap) => gap.kind === "section-readings")
        .map((gap) => gap.detail),
    ).toEqual([DROPPED]);
  },
  240_000,
);
