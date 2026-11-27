// Why (NEU-148, WP8, the publish phase): with the readings on, a review publishes each batch as soon
// as it is settled, through records' `publishSettled`, by one waiter task per batch chained in batch
// order (the scheduler lane's shape, `design/publish-waiter-0016.md`, amended), and ends with one
// `ending: true` call after every waiter ended; a batch not reached by the cut-off is never
// published partially, and the run asks once for its follow-on run. These tests drive the real
// review task, plan task and waiter task on a real pi Harness with scripted readings and checks.
// Every publication uses the real `publishSettled` and Records store.
import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import {
  Harness,
  createRegistry,
  defineExtension,
  defineTask,
  type Storage,
  type TaskId,
  type TaskOutcome,
} from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { Effect } from "effect";
import { PublishedPackets } from "@neuve/records-core";
import type { RecordEvent } from "@neuve/records-schema";
import { defaultConfig } from "../src/config.ts";
import { CrossBatchClaimsDoc } from "../src/pi/cross-batch-claims.ts";
import {
  childOf,
  reviewExtension,
  reviewTask,
  type FollowOnAnswer,
  type PublishInput,
  type ReviewStagesPort,
} from "../src/pi/review-task.ts";
import {
  BATCH_WAITER_TASK,
  settledStages,
} from "../src/pi/stages/batch-waiter-task.ts";
import { droppedPlanGap } from "../src/readings/batches.ts";
import { DROPPED_PLAN_GAP } from "../src/readings/collect.ts";
import type { FrontInput, FrontResult } from "../src/pi/stages/front-task.ts";
import { readingsPlanTask } from "../src/pi/stages/readings-plan-task.ts";
import type { StageServices } from "../src/pi/stages/services.ts";
import type { PrecomputeOutput, StageRecord } from "../src/pipeline.ts";
import { batchKeyOf } from "../src/publish-sections.ts";
import {
  atTime,
  comment,
  eventsOf,
  keyedOf,
  scratch,
  threeBatches,
  TOTALS,
} from "./publish-sections-fixtures.ts";

type Packet = Extract<RecordEvent, { kind: "packet.published@2" }>;
const record = (
  stage: StageRecord["stage"],
  agent: string,
  status: StageRecord["status"] = "computed",
): StageRecord => ({ stage, agent, status, wallMs: 1 });
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
const abortOf = (signal: AbortSignal) =>
  new Promise<never>((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason));
  });
const T = Date.UTC(2026, 10, 13, 9, 0, 0);
const RUN_ID = "01KA0000000000000000000000";
const CYCLE = "01KA0000000000000000000001";
const PRECOMPUTE = {
  files: [],
  diffBytes: 0,
  manifest: "manifest-key",
  scope: "scope-key",
  hunks: 1,
  reviewLines: 1,
  strongestStratum: "nothing",
  scopeGaps: [],
} as unknown as PrecomputeOutput;
const RUN_GAP = {
  key: "run:graph",
  kind: "graph-unavailable",
  detail: "Graph was not reachable.",
};
/** A gate the test opens: what a stand-in task waits on before it ends. */
const gate = () => {
  let open: () => void = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
};

/** How a reading ends: with an answer, cut off (not reached), or refused on quota. */
type ReadingEnd = "completed" | "cutoff" | "quota";
const tasksOf = (gates: {
  readonly readings: Readonly<Record<string, Promise<void>>>;
  /** The front task ends with no Frame or Map. */
  readonly frontFallback?: boolean;
}) => {
  const front = defineTask<FrontInput, { phase: "run" }, FrontResult>({
    name: "test.front",
    version: 1,
    initial: () => ({ phase: "run" }),
    phases: {
      run: (task, runtime, context) =>
        runtime.commit(async (tx) => {
          if (gates.frontFallback)
            return {
              status: "terminal",
              outcome: {
                status: "completed",
                result: {
                  stages: [record("frame", "frame", "skipped")],
                  frameKey: null,
                  mapKey: null,
                  manifestKey: "manifest-key",
                  scopeKey: "scope-key",
                  strongestStratum: "nothing",
                  frameStratum: "nothing",
                  disclosures: [],
                  reason: "the frame is unavailable",
                },
              },
            };
          const owner = (await tx.task(runtime.taskId))?.owner;
          return {
            status: "terminal",
            outcome: {
              status: "completed",
              result: {
                stages: [record("frame", "frame")],
                frameKey: "frame-key",
                mapKey: "map-key",
                manifestKey: "manifest-key",
                scopeKey: "scope-key",
                strongestStratum: "nothing",
                frameStratum: "nothing",
                disclosures: [
                  {
                    kind: "source-moved",
                    detail: "An external source moved since it was read.",
                  },
                ],
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
  const reading = defineTask<
    { readonly name: string; readonly end: ReadingEnd },
    { phase: "run" },
    { readonly name: string }
  >({
    name: "test.reading",
    version: 1,
    initial: () => ({ phase: "run" }),
    phases: {
      run: async (task, runtime, context) => {
        await Promise.race([
          gates.readings[task.input.name] ?? Promise.resolve(),
          abortOf(runtime.signal),
        ]);
        const { end } = task.input;
        await runtime.commit(
          () => ({
            status: "terminal",
            outcome:
              end === "completed"
                ? { status: "completed", result: { name: task.input.name } }
                : end === "quota"
                  ? {
                      status: "failed",
                      error: { message: "quota refused" },
                    }
                  : { status: "aborted", reason: "cutoff" },
          }),
          context,
        );
      },
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
  return { front, reading };
};

type Store = ReturnType<typeof scratch>;

/**
 * One review run on `store` (its pi storage given or fresh). `readings`: each batch's reading end,
 * by batch name; absent, the run has no readings (the off switch). `probe`: the readings port has no
 * `batches` or `settle`, as on a branch without the builder. `publisher`: the publish phase's port is
 * given (`settledStages`). `crashAtCall`: the run stops (the harness closes) as that publication
 * starts, before it does anything; `stopAtCall`: the review is stopped then. With `joined`,
 * the review's collector waits (up to 5 s) until
 * every waiter ended, so each settled batch is published by its own waiter; without it, waiters
 * that wake after the review is at Publish end late. `firstCallAfterPublish`: the first
 * publication starts only once the review is at Publish.
 */
const runReview = async (
  store: Store,
  options: {
    readonly readings?: Readonly<Record<"a" | "b" | "c", ReadingEnd>>;
    readonly probe?: boolean;
    readonly publisher?: boolean;
    readonly followOn?: FollowOnAnswer;
    /** The readings' end order, by batch name. */
    readonly order?: ReadonlyArray<"a" | "b" | "c">;
    readonly crashAtCall?: number;
    readonly stopAtCall?: number;
    readonly joined?: boolean;
    readonly firstCallAfterPublish?: boolean;
    readonly followOnThrows?: boolean;
    /** The readings' plan cannot be made. */
    readonly planFails?: boolean;
    /** The request's generation: above 0, a follow-on run. */
    readonly generation?: number;
    /** The front task ends with no Frame or Map. */
    readonly frontFallback?: boolean;
    /** The read of whether a follow-on is left fails. */
    readonly followOnLeftThrows?: boolean;
    /** Records refuses this run's ending call (a store error), before it writes anything. */
    readonly endingFails?: boolean;
    /** The read of the chain's totals fails (a store error). */
    readonly chainTotalsFails?: boolean;
    readonly incomingRace?: boolean;
    readonly bypassIncomingCheck?: boolean;
    readonly firstSettleRefused?: boolean;
    /** The run's cut-off; by default ten minutes ahead. In the past, the run starts already cut off. */
    readonly cutoffAt?: number;
    /** The request's run ID: each generation of a sequence is its own request. */
    readonly runId?: string;
    readonly storage?: Storage;
    readonly reviewId?: TaskId;
  },
) => {
  const fixtures = threeBatches();
  const byName = { a: fixtures.a, b: fixtures.b, c: fixtures.c } as const;
  const keyOf = (name: "a" | "b" | "c") => batchKeyOf(byName[name].paths);
  const readingGates = { a: gate(), b: gate(), c: gate() };
  const { front, reading } = tasksOf({
    ...(options.frontFallback ? { frontFallback: true } : {}),
    readings: Object.fromEntries(
      Object.entries(readingGates).map(([n, g]) => [`r${n}`, g.opened]),
    ),
  });
  const calls: Array<string> = [];
  const settles: Array<{ batch: string; last: boolean; final: boolean }> = [];
  const commits: Array<unknown> = [];
  let published: PublishInput | undefined;
  let crashed: () => void = () => {};
  const crash = new Promise<void>((resolve) => {
    crashed = resolve;
  });
  let runs = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  let firstCheckWaited = false;
  const firstCheckGate = gate();
  const firstCheckWaiting = gate();
  const firstPublished = gate();
  const secondPublished = gate();
  let registerSecond: (() => Promise<void>) | undefined;
  let stopReview: () => void = () => {};
  let atPublish: () => void = () => {};
  const publishing = new Promise<void>((resolve) => {
    atPublish = resolve;
  });
  const waiterRows = () =>
    ctx.log.read().filter((r) => r.type === "publish.waiter").length;
  const runId = options.runId ?? RUN_ID;
  const base = store.ctx({ runId, startedAt: T });
  const ctx = {
    ...base,
    log: {
      ...base.log,
      write: (row: Parameters<typeof base.log.write>[0]) => {
        base.log.write(row);
        if (row.type !== "publish.waiter" || row["status"] !== "published")
          return;
        if (row["index"] === 0) firstPublished.open();
        if (row["index"] === 1) secondPublished.open();
      },
    },
    config: {
      ...defaultConfig(),
      readings: {
        mode: "probe" as const,
        bounds: { maxFiles: 8, maxCharacters: 60_000, maxItems: 40 },
        recipe: "test-recipe",
      },
    },
  };
  // The stage runner as the runtime's is: no grant held, the run's Records services provided.
  const services = {
    ctx,
    run: async (
      effect: Effect.Effect<unknown, unknown, never>,
      signal?: AbortSignal,
    ) => {
      runs += 1;
      if (options.crashAtCall === runs) {
        crashed();
        await abortOf(signal!);
      }
      if (options.stopAtCall === runs) {
        stopReview();
        await abortOf(signal!);
      }
      if (options.firstCallAfterPublish && runs === 1) await publishing;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        return await store.run(atTime(T)(effect as never));
      } finally {
        inFlight -= 1;
      }
    },
  } as unknown as StageServices;
  const ends = options.readings;
  const readings: NonNullable<ReviewStagesPort["readings"]> | undefined =
    ends === undefined
      ? undefined
      : {
          prepare: async (_input, signal) => {
            if (options.planFails) throw new Error("the plan broke");
            // Past the cut-off a real plan's bound has ended: it honours its signal.
            if (
              options.cutoffAt !== undefined &&
              options.cutoffAt <= Date.now()
            )
              await abortOf(signal);
            return { plan: "plan-key" };
          },
          create: async (tx, _prepared, owner) => {
            const created = [];
            for (const name of ["a", "b", "c"] as const)
              created.push({
                name: `r${name}`,
                task: (await tx.createTask(
                  reading,
                  { name: `r${name}`, end: ends[name] },
                  { ownership: { kind: "task", taskId: owner } },
                )) as TaskId<unknown>,
              });
            return created;
          },
          collect: async () => {
            calls.push("readings.collect");
            if (options.joined)
              for (let i = 0; i < 250 && waiterRows() < 3; i++) await sleep(20);
            return { stages: [], disclosures: [] };
          },
          ...(options.probe
            ? {}
            : {
                // With no reading (the plan was dropped), the readers' batches are the stand-in
                // plan's, none waits on a reading, and the run's first gap says how the plan ended.
                batches: async (input) => ({
                  batches: (["a", "b", "c"] as const).map((name) => ({
                    key: keyOf(name),
                    readings: input.readings.length === 0 ? [] : [`r${name}`],
                  })),
                  totals: TOTALS,
                  gaps: [
                    // As the readers say it: a plan that failed, or one cut at its cut-off.
                    ...(input.readings.length === 0
                      ? [
                          input.planCut === true
                            ? droppedPlanGap("not-reached", false)
                            : DROPPED_PLAN_GAP,
                        ]
                      : []),
                    RUN_GAP,
                  ],
                }),
                // Settled when its reading completed; not reached when it was cut off, unless this
                // is the last allowed run. A quota refusal holds it.
                settle: async (input) => {
                  settles.push({
                    batch: input.batch,
                    last: input.last,
                    final: input.final,
                  });
                  const name = (["a", "b", "c"] as const).find(
                    (n) => keyOf(n) === input.batch,
                  )!;
                  if (
                    name === "a" &&
                    options.firstSettleRefused &&
                    settles.filter(({ batch }) => batch === input.batch)
                      .length === 1
                  ) {
                    return {
                      settled: false,
                      gap: {
                        key: "batch:a",
                        kind: "refused",
                        detail: "The store was busy.",
                      },
                    };
                  }
                  if (name === "a" && registerSecond !== undefined) {
                    const register = registerSecond;
                    registerSecond = undefined;
                    firstCheckGate.open();
                    await register();
                  }
                  const outcome = input.readings[0]?.outcome;
                  const gap = (kind: "not-reached" | "quota") => ({
                    settled: false as const,
                    gap: {
                      key: `batch:${name}`,
                      kind,
                      detail: `Batch ${name} is still being judged.`,
                    },
                  });
                  if (outcome?.status === "failed") return gap("quota");
                  // A batch with no reading (the plan dropped): one that failed settles, every
                  // section the person's; one cut at its cut-off is not reached, as the readers
                  // decide it, unless this is the last allowed run.
                  if (
                    (input.readings.length > 0 || input.planCut === true) &&
                    outcome?.status !== "completed" &&
                    !input.last
                  )
                    return gap("not-reached");
                  const batch = byName[name];
                  if (
                    name !== "a" ||
                    (!options.incomingRace && !options.bypassIncomingCheck)
                  )
                    return { settled: true as const, batch };
                  const incoming = (input.incoming ?? []).flatMap((claim) => {
                    if (claim.verifyKey === null) return [];
                    const { kind, text, path, side, startLine, endLine } =
                      claim.comment;
                    return [
                      comment(claim.key, {
                        kind,
                        anchor: { path, side, startLine, endLine },
                        body: text,
                        section: claim.target.section,
                      }),
                    ];
                  });
                  return {
                    settled: true as const,
                    batch: {
                      ...batch,
                      units: batch.units.map((unit, i) =>
                        i === 0
                          ? {
                              ...unit,
                              comments: [...unit.comments, ...incoming],
                            }
                          : unit,
                      ),
                    },
                  };
                },
              }),
        };
  const plan = readingsPlanTask(undefined, readings);
  const settled = settledStages(services, readings);
  let asked = 0;
  const askedAt: Array<{ endingRow: boolean; endedCommit: boolean }> = [];
  const port: ReviewStagesPort = {
    front: childOf(front),
    precompute: async () => ({
      record: record("precompute", "precompute"),
      facts: { key: "precompute-key", output: PRECOMPUTE },
    }),
    fill: async () => ({ record: record("link", "link.fill"), groups: [] }),
    link: async () => ({
      record: record("link", "link"),
      candidates: [],
      changeMapKey: "change-map-key",
      disclosures: [
        { kind: "link", detail: "Link disclosed this." },
        {
          kind: "finding-unanchored",
          detail:
            "One verified finding has no unique unit owning its primary anchor and is not published.",
        },
      ],
    }),
    publish: async (input) => {
      calls.push("publish");
      published = input;
      return [record("publish", "publish")];
    },
    ...(readings === undefined
      ? {}
      : { readings, readingsPlan: childOf(plan) }),
    ...(options.publisher === false
      ? {}
      : {
          ...settled.port,
          ...(settled.port.publishSettled === undefined ||
          settled.port.chainTotals === undefined
            ? {}
            : {
                publishSettled: (input, signal) => {
                  if (options.endingFails && input.ending)
                    return Promise.reject(new Error("the store was busy"));
                  return settled.port.publishSettled!(input, signal);
                },
                chainTotals: (signal) =>
                  options.chainTotalsFails
                    ? Promise.reject(new Error("the store was busy"))
                    : settled.port.chainTotals!(signal),
              }),
          ...(settled.port.followOn === undefined
            ? {}
            : {
                // Read only: whether a follow-on run is left under the cap.
                followOnLeft: async () => {
                  if (options.followOnLeftThrows)
                    throw new Error("the store could not be read");
                  return options.followOn !== "cap-reached";
                },
                followOn: async () => {
                  asked += 1;
                  // Where the ask stands: after the ending call's row and the commit holding it.
                  askedAt.push({
                    endingRow: ctx.log
                      .read()
                      .some(
                        (r) =>
                          r.type === "publish.settled" && r["ending"] === true,
                      ),
                    endedCommit: commits.some(
                      (c) =>
                        (c as { state?: { checkpoint?: { ended?: unknown } } })
                          .state?.checkpoint?.ended !== undefined,
                    ),
                  });
                  if (options.followOnThrows)
                    throw new Error("the store refused the ask");
                  return options.followOn ?? "requested";
                },
              }),
        }),
  };
  const review = reviewTask(port, ctx.log);
  // Every commit's next state, as the review commits it.
  const observed = {
    ...review,
    definition: {
      ...review.definition,
      phases: Object.fromEntries(
        Object.entries(review.definition.phases).map(([phase, run]) => [
          phase,
          (
            task: never,
            runtime: { commit: (...a: never[]) => unknown },
            c: never,
          ) =>
            (run as (...a: unknown[]) => Promise<void>)(
              task,
              {
                ...runtime,
                commit: (change: (...a: never[]) => unknown, cc: never) =>
                  (runtime.commit as (...a: unknown[]) => Promise<void>)(
                    async (...args: never[]) => {
                      const state = await change(...args);
                      const stored = JSON.parse(
                        JSON.stringify({ phase, state }),
                      );
                      commits.push(stored);
                      if (stored.state?.checkpoint?.phase === "publish")
                        setTimeout(atPublish, 0);
                      return state;
                    },
                    cc,
                  ),
              },
              c,
            ),
        ]),
      ),
    },
  } as unknown as typeof review;
  const registry = createRegistry();
  const check = defineTask<{ number: number }, { phase: "check" }, StageRecord>(
    {
      name: "test.verify-claim",
      version: 1,
      initial: () => ({ phase: "check" }),
      phases: {
        check: async (task, runtime, c) => {
          if (task.input.number === 1)
            await Promise.race([
              firstCheckGate.opened,
              abortOf(runtime.signal),
            ]);
          await runtime.commit(
            () => ({
              status: "terminal",
              outcome: {
                status: "completed",
                result: {
                  ...record("verify", "verify.claim"),
                  key: String(task.input.number),
                },
              },
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
    },
  );
  registry.install(
    defineExtension({
      name: "test.stages",
      tasks: [front, reading, plan, settled.task, check],
    }),
  );
  registry.install(reviewExtension(observed));
  const storage = options.storage ?? new MemoryStorage();
  const harness = await Harness.open(
    storage,
    {
      models: createModels(),
      registry,
      settings: { compaction: { enabled: false }, retry: { maxRetries: 0 } },
    },
    context,
  );
  let id = options.reviewId;
  let stopWatching: (() => Promise<unknown>) | undefined;
  try {
    if (options.incomingRace || options.bypassIncomingCheck) {
      const root = await harness.root(context);
      const register = (number: number) =>
        harness.commit(async (tx) => {
          const task = await tx.createTask(
            check,
            { number },
            {
              ownership: { kind: "conversation" },
              conversationId: root.id,
            },
          );
          const key = `incoming-${number}`;
          (await tx.doc(CrossBatchClaimsDoc)).claims[key] = {
            key,
            task,
            answer: "lane-review-answer",
            from: "another-group",
            target: {
              batch: keyOf("a"),
              section: byName.a.sections[0]!.identity.key,
            },
            comment: {
              path: "src/a.ts",
              side: "new",
              startLine: number === 1 ? 3 : 5,
              endLine: number === 1 ? 3 : 5,
              kind: "risk",
              text: `Incoming claim ${number}.`,
              fails: "",
              evidenceAnchors: [],
            },
          };
          return task;
        }, context);
      const first = await register(1);
      if (options.incomingRace)
        registerSecond = async () => {
          await harness.waitForTask(await register(2), context);
        };
      const graph = await harness.watchTaskGraph(context);
      stopWatching = () => graph.stop();
      graph.start(async ({ tasks }) => {
        if (
          Object.values(tasks).some(
            ({ kind, state }) =>
              kind === BATCH_WAITER_TASK &&
              state.status === "waiting" &&
              state.phase === "publish" &&
              state.on.includes(first),
          )
        ) {
          firstCheckWaited = true;
          firstCheckWaiting.open();
          if (!options.bypassIncomingCheck) firstCheckGate.open();
        }
      });
    }
    if (id === undefined) {
      const root = await harness.root(context);
      id = await harness.commit(
        (tx) =>
          tx.createTask(
            observed,
            {
              range: {
                baseRef: "main",
                baseOid: "1".repeat(40),
                headOid: "2".repeat(40),
              },
              config: {} as never,
              runKey: "c".repeat(64),
              runId,
              cycleId: CYCLE,
              generation: options.generation ?? 0,
              cutoffAt: options.cutoffAt ?? Date.now() + 600_000,
            },
            { ownership: { kind: "conversation" }, conversationId: root.id },
          ),
        context,
      );
    }
    const reviewId = id;
    stopReview = () => void harness.abortTask(reviewId, context);
    harness.resume();
    const ended = harness.waitForTask(id, context);
    // Release the readings in the requested order once the waiters exist.
    const order = options.order ?? ["a", "b", "c"];
    const release = (async () => {
      for (let i = 0; i < 250; i++) {
        if (commits.some((c) => JSON.stringify(c).includes('"publishing"')))
          break;
        await sleep(10);
      }
      if (options.bypassIncomingCheck) {
        readingGates.a.open();
        await Promise.race([firstCheckWaiting.opened, sleep(2_000)]);
        readingGates.b.open();
        await Promise.race([secondPublished.opened, sleep(2_000)]);
        firstCheckGate.open();
        await Promise.race([firstPublished.opened, sleep(2_000)]);
        readingGates.c.open();
        return;
      }
      for (const name of order) {
        readingGates[name].open();
        await sleep(30);
      }
    })();
    if (options.crashAtCall !== undefined) {
      // The wait ends with the harness, as a process's does.
      ended.catch(() => {});
      await crash;
      return { id, crashed: true as const, storage, calls, settles };
    }
    if (options.stopAtCall !== undefined) {
      const done = await ended;
      await release;
      const all = (
        await harness.commit(
          async (tx) => (await tx.scanTasks({}, 1000)).items,
          context,
        )
      ).filter((t) => t.kind === BATCH_WAITER_TASK);
      return {
        id,
        crashed: true as const,
        storage,
        calls,
        settles,
        stopped: done.state.outcome as TaskOutcome<unknown>,
        waiterOutcomes: all.map(
          (t) => (t.state as { outcome?: TaskOutcome<unknown> }).outcome,
        ),
      };
    }
    const done = await ended;
    await release;
    const tasks = (
      await harness.commit(
        async (tx) => (await tx.scanTasks({}, 1000)).items,
        context,
      )
    ).filter((t) => t.kind === BATCH_WAITER_TASK);
    return {
      id,
      crashed: false as const,
      storage,
      outcome: done.state.outcome as TaskOutcome<{
        stages: Array<StageRecord>;
      }>,
      waiters: tasks
        .sort((x, y) => Number(x.id) - Number(y.id))
        .map((t) => ({
          input: t.input as { index: number; previous: number | null },
          outcome: (t.state as { outcome?: TaskOutcome<unknown> }).outcome,
        })),
      calls,
      settles,
      summaries: ctx.log.read().filter((r) => r.type === "publish.settled"),
      commits,
      published,
      asked,
      askedAt,
      maxInFlight,
      firstCheckWaited,
      log: ctx.log.read(),
    };
  } finally {
    firstCheckGate.open();
    await stopWatching?.();
    await harness.close(context);
  }
};

const packetsOf = (store: Store) =>
  store.run(
    Effect.map(eventsOf(CYCLE, "packet.published@2"), (events) =>
      (events as Array<Packet>).sort((x, y) => (x.id < y.id ? -1 : 1)),
    ),
  );

/** What a run left in Records: its packets in order and every keyed ID of its namespace. */
const observedIn = async (store: Store) => {
  const packets = await packetsOf(store);
  return {
    packets: packets.map((p) => ({
      id: p.id,
      manifest: p.refs[0].ref,
      supersedes: p.causation?.supersedes ?? null,
      ordinal: p.payload.ordinal,
      complete: p.payload.complete,
      pending: p.payload.counts.pending,
      added: p.payload.added,
    })),
    keyed: await store.run(keyedOf(CYCLE, "c".repeat(64))),
  };
};

/** The batches each packet holds, by title, read back through the read model. */
const batchesOf = async (store: Store, packet: Packet) => {
  const read = await store.run(PublishedPackets.readExact(packet.id));
  return read?.kind === "packet.published@2"
    ? read.batches.map((b) => b.recorded?.payload.title)
    : [];
};

const ALL: Readonly<Record<"a" | "b" | "c", ReadingEnd>> = {
  a: "completed",
  b: "completed",
  c: "completed",
};
type Done = Extract<Awaited<ReturnType<typeof runReview>>, { crashed: false }>;
const done = (run: Awaited<ReturnType<typeof runReview>>): Done => {
  if (run.crashed) throw new Error("the run did not end");
  return run;
};
const published = {
  status: "completed",
  result: { status: "published" },
} as const;
const late = { status: "completed", result: { status: "late" } } as const;
const gapKinds = async (store: Store, packet: Packet) => {
  const read = await store.run(PublishedPackets.readExact(packet.id));
  return read?.kind === "packet.published@2"
    ? read.gaps.map((g) => g.payload.kind)
    : [];
};

// Reason: with the readings off, or on without the builder (the probe's shape), the review commits,
// creates and publishes exactly as before the publish phase existed: the old packet (`publish`),
// no waiter, no `publishSettled` call, whether or not the publish phase's port is given.

// Reason: the per-batch rule. Readings that end out of order still publish in batch order, one
// serial call at a time, each packet superseding the last; the one ending call comes after every
// waiter and is the only complete packet; the old packet is never published.
test("three batches settled out of order publish in batch order, one call at a time, ending complete", async () => {
  const store = scratch({ cycleId: CYCLE });
  const run = done(
    await runReview(store, {
      readings: ALL,
      order: ["c", "b", "a"],
      joined: true,
    }),
  );
  expect(run.outcome.status).toBe("completed");
  expect(run.calls).not.toContain("publish");
  expect(run.maxInFlight).toBe(1);
  // The chain: waiter k waits on waiter k-1, and every waiter published.
  expect(run.waiters.map((w) => w.input.index)).toEqual([0, 1, 2]);
  expect(run.waiters[0]!.input.previous).toBeNull();
  expect(run.waiters.map((w) => w.outcome)).toEqual(Array(3).fill(published));
  const packets = await packetsOf(store);
  // Three batch packets in batch order, then the ending packet, which adds no batch.
  expect(packets.map((p) => p.payload.ordinal)).toEqual([1, 2, 3, 4]);
  expect(packets.map((p) => p.payload.added.batches)).toEqual([1, 1, 1, 0]);
  expect(packets.map((p) => p.causation?.supersedes ?? null)).toEqual([
    null,
    packets[0]!.id,
    packets[1]!.id,
    packets[2]!.id,
  ]);
  expect(packets.map((p) => p.payload.complete)).toEqual([
    false,
    false,
    false,
    true,
  ]);
  expect(await batchesOf(store, packets[0]!)).toEqual(["Retry policy"]);
  expect(await batchesOf(store, packets[2]!)).toEqual([
    "Retry policy",
    "Guards",
    "Lookup table",
  ]);
  // The ending call is the last call, after every waiter's.
  const rows = run.log.filter(
    (r) => r.type === "publish.settled" || r.type === "publish.waiter",
  );
  expect(rows.map((r) => r.type).at(-1)).toBe("publish.settled");
  expect(rows.at(-1)).toMatchObject({ ending: true });
  // The publish stage is recorded once, by the ending call.
  const stages =
    run.outcome.status === "completed" ? run.outcome.result.stages : [];
  expect(stages.filter((s) => s.stage === "publish")).toHaveLength(1);
  expect(stages.at(-1)?.note).toContain("packet complete");
});

// The first check is still running when the target reading ends. A second claim registers while
// the waiter is settling the batch. The first packet needs both anchors because it freezes the batch.
test("a batch waits for an incoming check and includes a claim registered during settlement", async () => {
  const store = scratch({ cycleId: CYCLE });
  const run = done(
    await runReview(store, { readings: ALL, joined: true, incomingRace: true }),
  );
  expect(run.firstCheckWaited).toBe(true);
  const [first] = await packetsOf(store);
  if (first === undefined) throw new Error("No packet");
  const packet = await store.run(PublishedPackets.readExact(first.id));
  if (packet?.kind !== "packet.published@2") throw new Error("No batch packet");
  const incoming = packet.batches
    .flatMap((batch) =>
      batch.units.flatMap((unit) =>
        unit.comments.map(({ payload }) => payload),
      ),
    )
    .filter(({ body }) => body.startsWith("Incoming claim "));
  expect(incoming).toEqual([
    expect.objectContaining({
      body: "Incoming claim 1.",
      anchor: { path: "src/a.ts", side: "new", startLine: 3, endLine: 3 },
    }),
    expect.objectContaining({
      body: "Incoming claim 2.",
      anchor: { path: "src/a.ts", side: "new", startLine: 5, endLine: 5 },
    }),
  ]);
});

// A pending incoming check defers its target without delaying a decided batch.
test("a decided batch publishes while an earlier batch waits for Verify", async () => {
  const store = scratch({ cycleId: CYCLE });
  const run = done(
    await runReview(store, {
      readings: ALL,
      joined: true,
      bypassIncomingCheck: true,
    }),
  );
  expect(run.firstCheckWaited).toBe(true);
  const [first, second] = await packetsOf(store);
  expect(await batchesOf(store, first!)).toEqual(["Guards"]);
  expect(await batchesOf(store, second!)).toEqual(["Guards", "Retry policy"]);
  const packet = await store.run(PublishedPackets.readExact(second!.id));
  if (packet?.kind !== "packet.published@2") throw new Error("No batch packet");
  expect(
    packet.batches.flatMap((batch) =>
      batch.units.flatMap((unit) =>
        unit.comments.map(({ payload }) => payload),
      ),
    ),
  ).toContainEqual(
    expect.objectContaining({
      body: "Incoming claim 1.",
      anchor: { path: "src/a.ts", side: "new", startLine: 3, endLine: 3 },
    }),
  );
});

// A transient refusal of the first batch must not leave it waiting for the ending packet.
test("the next waiter publishes an earlier batch whose settlement first failed", async () => {
  const store = scratch({ cycleId: CYCLE });
  const run = done(
    await runReview(store, {
      readings: ALL,
      joined: true,
      firstSettleRefused: true,
    }),
  );
  expect(run.waiters[0]?.outcome).toEqual({
    status: "completed",
    result: { status: "not-settled", kind: "refused" },
  });
  const [first] = await packetsOf(store);
  if (first === undefined) throw new Error("No packet");
  expect(first.payload.complete).toBe(false);
  expect(await batchesOf(store, first)).toEqual(["Retry policy", "Guards"]);
});

// Reason: the cut-off of the scheduler's amended shape. The review commits to Publish once its
// readings ended and then waits for every waiter: a waiter that wakes after that publishes
// nothing (`late`), the calls never overlap, and the ending call publishes the rest in one packet.
test("waiters that wake after the review is at Publish end late; the ending call publishes their batches", async () => {
  const store = scratch({ cycleId: CYCLE });
  const run = done(
    await runReview(store, { readings: ALL, firstCallAfterPublish: true }),
  );
  expect(run.waiters.map((w) => w.outcome)).toEqual([published, late, late]);
  expect(run.maxInFlight).toBe(1);
  const packets = await packetsOf(store);
  expect(packets.map((p) => p.payload.added.batches)).toEqual([1, 2]);
  expect(await batchesOf(store, packets[1]!)).toEqual([
    "Retry policy",
    "Guards",
    "Lookup table",
  ]);
  expect(packets[1]!.payload.complete).toBe(true);
});

// Reason: the gate ("a replay publishes identical packets") and record 0016. The same review run
// again over the same Records writes nothing new; one stopped between two publications and resumed
// writes exactly the packets and keyed IDs of an uninterrupted run.
test("a replayed review and one resumed after a crash write identical packets and no duplicate", async () => {
  const whole = scratch({ cycleId: CYCLE });
  done(
    await runReview(whole, {
      readings: ALL,
      order: ["c", "b", "a"],
      joined: true,
    }),
  );
  const once = await observedIn(whole);
  expect(once.packets).toHaveLength(4);
  // A replay of the whole review: every waiter and the ending call repeat calls already in the chain.
  const again = done(
    await runReview(whole, {
      readings: ALL,
      order: ["c", "b", "a"],
      joined: true,
    }),
  );
  expect(await observedIn(whole)).toEqual(once);
  // Each repeated call found its publication in the chain: no packet but the first run's.
  const ids = new Set(once.packets.map((p) => p.id));
  const repeated = again.summaries.slice(4);
  expect(repeated.length).toBeGreaterThan(0);
  for (const row of repeated)
    expect(ids.has(String(row["packetEventId"]))).toBe(true);

  // A crash as the second publication starts, after the first landed; then the same review resumes.
  const crashedStore = scratch({ cycleId: CYCLE });
  const storage = new MemoryStorage();
  // The pi store outlives the harness, as a file does across a process's death.
  const kept = new Proxy(storage, {
    get: (target, property) => {
      if (property === "close") return async () => {};
      const value: unknown = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Storage;
  const stopped = await runReview(crashedStore, {
    readings: ALL,
    order: ["c", "b", "a"],
    joined: true,
    crashAtCall: 2,
    storage: kept,
  });
  expect((await packetsOf(crashedStore)).map((p) => p.payload.ordinal)).toEqual(
    [1],
  );
  const resumed = done(
    await runReview(crashedStore, {
      readings: ALL,
      joined: true,
      storage: kept,
      reviewId: stopped.id,
    }),
  );
  expect(resumed.outcome.status).toBe("completed");
  expect(await observedIn(crashedStore)).toEqual(once);
});

// Reason: a stopped review publishes nothing more: a stop while a waiter's call is about to start
// ends the review aborted, its waiters stopped, and no ending call is made.
test("a review stopped while a waiter publishes makes no ending call", async () => {
  const store = scratch({ cycleId: CYCLE });
  const run = await runReview(store, {
    readings: ALL,
    joined: true,
    stopAtCall: 1,
  });
  if (!("stopped" in run)) throw new Error("expected a stop");
  expect(run.stopped?.status).toBe("aborted");
  expect(await packetsOf(store)).toEqual([]);
  expect((run.waiterOutcomes ?? []).every((o) => o?.status === "aborted")).toBe(
    true,
  );
});

// Reason: WP8's hazards and 14.6. A review whose time ends with one batch not reached publishes the
// settled batches, never the partial one, ends with `ending: true`, and asks for exactly one
// follow-on run; none on a quota refusal; and with no follow-on left (past the cap, or an ask that
// fails), the last run settles what was not reached (human-required, by the builder) and publishes it.
test("at the cut-off the settled batches publish, the partial one never does, and one follow-on is asked", async () => {
  const store = scratch({ cycleId: CYCLE });
  const run = done(
    await runReview(store, {
      readings: { a: "completed", b: "completed", c: "cutoff" },
      joined: true,
    }),
  );
  expect(run.asked).toBe(1);
  // The ask came after the ending call was stored: when it was made, the ending call's row was
  // written and the commit that holds the ending (`ended`) had landed.
  expect(run.askedAt).toEqual([{ endingRow: true, endedCommit: true }]);
  expect(run.waiters.map((w) => w.outcome)).toEqual([
    published,
    published,
    {
      status: "completed",
      result: { status: "not-settled", kind: "not-reached" },
    },
  ]);
  const packets = await packetsOf(store);
  const last = packets.at(-1)!;
  expect(await batchesOf(store, last)).toEqual(["Retry policy", "Guards"]);
  expect(last.payload.complete).toBe(false);
  expect(last.payload.counts.pending).toEqual({ batches: 1, sections: 1 });
  expect(run.settles.filter((s) => s.last)).toEqual([]);
  expect(
    run.log.filter((r) => r.type === "publish.settled").at(-1),
  ).toMatchObject({ ending: true });

  // A quota refusal: no follow-on is asked, and the refused batch stays pending.
  const quotaStore = scratch({ cycleId: CYCLE });
  const quota = done(
    await runReview(quotaStore, {
      readings: { a: "completed", b: "completed", c: "quota" },
      joined: true,
    }),
  );
  expect(quota.asked).toBe(0);
  const quotaLast = (await packetsOf(quotaStore)).at(-1)!;
  expect(await batchesOf(quotaStore, quotaLast)).toEqual([
    "Retry policy",
    "Guards",
  ]);

  // Past the cap: decided read-only before the ending call, so none is asked, and the batch not
  // reached settles on that call as the last run's (human-required, by the builder).
  const capStore = scratch({ cycleId: CYCLE });
  const cap = done(
    await runReview(capStore, {
      readings: { a: "completed", b: "completed", c: "cutoff" },
      joined: true,
      followOn: "cap-reached",
    }),
  );
  expect(cap.outcome.status).toBe("completed");
  expect(cap.asked).toBe(0);
  expect(cap.settles.filter((s) => s.last).map((s) => s.batch)).toEqual([
    batchKeyOf(["src/c.ts"]),
  ]);
  const capLast = (await packetsOf(capStore)).at(-1)!;
  expect(await batchesOf(capStore, capLast)).toEqual([
    "Retry policy",
    "Guards",
    "Lookup table",
  ]);
  expect(capLast.payload.complete).toBe(true);

  // An ask that fails, after the ending call is stored: a recorded outcome, not the review's
  // failure; the batch not reached stays pending as the stored packet says.
  const failStore = scratch({ cycleId: CYCLE });
  const failing = done(
    await runReview(failStore, {
      readings: { a: "completed", b: "completed", c: "cutoff" },
      joined: true,
      followOnThrows: true,
    }),
  );
  expect(failing.outcome.status).toBe("completed");
  expect(failing.asked).toBe(1);
  const asks = failing.log.filter((r) => r.type === "publish.follow-on");
  expect(asks).toHaveLength(1);
  expect(asks[0]).toMatchObject({ answer: "refused", failed: true });
  expect((await packetsOf(failStore)).at(-1)!.payload.counts.pending).toEqual({
    batches: 1,
    sections: 1,
  });
});

// Reason: WP8's hazards. A unit of a batch not yet published has no disposition and is counted only
// as pending, never among the units waiting on a person; and a batch's own gap is not repeated in
// later packets, while each packet names each run gap once.
test("a pending unit is never counted as waiting on a person, and gaps are not repeated", async () => {
  const store = scratch({ cycleId: CYCLE });
  const run = done(
    await runReview(store, {
      readings: { a: "completed", b: "completed", c: "cutoff" },
      joined: true,
    }),
  );
  const ending = run.summaries.at(-1) as unknown as {
    closure: Record<string, number>;
    pending: { batches: number; sections: number };
  };
  // Published: batch a (an agentic unit that requests changes, a human-required unit) and b (one
  // human-required unit). Batch c's agentic unit is pending: in no closure count.
  const closed = Object.values(ending.closure).reduce((sum, n) => sum + n, 0);
  expect(closed).toBe(3);
  expect(ending.pending).toEqual({ batches: 1, sections: 1 });
  const packets = await packetsOf(store);
  for (const packet of packets)
    expect(await batchesOf(store, packet)).not.toContain("Lookup table");
  // Batch b's not-decided gap is on the packet that published b, and on no later one.
  const kinds = [];
  for (const packet of packets) kinds.push(await gapKinds(store, packet));
  expect(kinds[1]).toContain("undecided-failed");
  expect(kinds[0]).not.toContain("undecided-failed");
  const undecided = (
    await store.run(eventsOf(CYCLE, "gap.disclosed@1"))
  ).filter(
    (g) =>
      (g as { payload: { kind: string } }).payload.kind === "undecided-failed",
  );
  expect(undecided).toHaveLength(1);
  // Each packet names each run gap once.
  for (const list of kinds)
    expect(
      list.filter((k) => k === "graph-unavailable").length,
    ).toBeLessThanOrEqual(1);
});

/** What makes a run's receipt say `timed-out` (`receipt.ts`): a stage cut short. */
const cutShortOf = (run: Done) =>
  run.outcome.status === "completed"
    ? run.outcome.result.stages.filter(
        (s) => s.status === "interrupted" || s.status === "skipped",
      )
    : [];
/** A packet's run gaps, kind and detail, as Records holds them. */
const gapsOf = async (store: Store, packet: Packet) => {
  const read = await store.run(PublishedPackets.readExact(packet.id));
  return read?.kind === "packet.published@2"
    ? read.gaps.map((g) => ({ kind: g.payload.kind, detail: g.payload.detail }))
    : [];
};
/** A packet's batches by the event that recorded each: a published batch never changes. */
const batchIdsOf = async (store: Store, packet: Packet) => {
  const read = await store.run(PublishedPackets.readExact(packet.id));
  return read?.kind === "packet.published@2"
    ? read.batches.map((b) => b.recorded?.id)
    : [];
};
/**
 * 14.6's zero reversals along a chain: each packet supersedes the one before it and holds its
 * batches, the same recorded events in the same order, as a prefix.
 */
const expectNoReversal = async (store: Store) => {
  const packets = await packetsOf(store);
  for (const [index, packet] of packets.entries()) {
    if (index === 0) continue;
    const before = packets[index - 1]!;
    expect(packet.causation?.supersedes).toBe(before.id);
    const earlier = await batchIdsOf(store, before);
    expect((await batchIdsOf(store, packet)).slice(0, earlier.length)).toEqual(
      earlier,
    );
  }
  return packets;
};
const FOLLOW_ON_RUN = "01KA0000000000000000000002";
const NEXT_RUN = "01KA0000000000000000000003";

// Reason: a person never sees a range that cannot be reviewed. A review whose cut-off comes before
// any batch is decided ends properly: its stages carry the cut-off (its receipt says `timed-out`, so
// the next request starts the next generation rather than joining a completed review), one packet
// says nothing is decided and why, and one follow-on is asked. The next generation, given time,
// publishes every batch and ends complete, with no stage cut short (its receipt says `completed`).
test("a review cut off with nothing settled ends timed-out with a gap, and the next generation completes", async () => {
  const store = scratch({ cycleId: CYCLE });
  const first = done(
    await runReview(store, {
      readings: { a: "cutoff", b: "cutoff", c: "cutoff" },
      joined: true,
    }),
  );
  expect(first.outcome.status).toBe("completed");
  expect(cutShortOf(first).map((s) => s.agent)).toEqual(["link.batches"]);
  expect(first.asked).toBe(1);
  const [only] = await packetsOf(store);
  expect(await packetsOf(store)).toHaveLength(1);
  expect(only!.payload.complete).toBe(false);
  expect(only!.payload.added.batches).toBe(0);
  expect(only!.payload.counts.pending).toEqual(TOTALS);
  expect(await gapsOf(store, only!)).toContainEqual({
    kind: "batches-not-reached",
    detail:
      "The review ran out of time before any batch was decided: they wait for a follow-on run, or for the next request when none starts.",
  });

  const next = done(
    await runReview(store, {
      readings: ALL,
      joined: true,
      generation: 1,
      runId: FOLLOW_ON_RUN,
    }),
  );
  expect(next.outcome.status).toBe("completed");
  expect(cutShortOf(next)).toEqual([]);
  expect(next.calls).not.toContain("publish");
  const packets = await expectNoReversal(store);
  const last = packets.at(-1)!;
  expect(last.payload.complete).toBe(true);
  expect(await batchesOf(store, last)).toEqual([
    "Retry policy",
    "Guards",
    "Lookup table",
  ]);
});

// Reason: 14.6. With some batches settled by the cut-off, they are published and the rest stay
// pending under a gap that says so; the follow-on publishes the rest, never writing a published
// batch again, and its last packet is complete: zero reversals along the chain.
test("a review cut off with some batches settled publishes them, and the follow-on completes with no reversal", async () => {
  const store = scratch({ cycleId: CYCLE });
  const first = done(
    await runReview(store, {
      readings: { a: "completed", b: "cutoff", c: "cutoff" },
      joined: true,
    }),
  );
  expect(first.asked).toBe(1);
  expect(cutShortOf(first)).toHaveLength(1);
  const ending = (await packetsOf(store)).at(-1)!;
  expect(await batchesOf(store, ending)).toEqual(["Retry policy"]);
  expect(ending.payload.counts.pending.batches).toBe(2);
  expect(await gapsOf(store, ending)).toContainEqual({
    kind: "batches-not-reached",
    detail:
      "2 of 3 batch(es) were not reached before the cut-off: they wait for a follow-on run, or for the next request when none starts.",
  });
  const published = await batchIdsOf(store, ending);

  const next = done(
    await runReview(store, {
      readings: ALL,
      joined: true,
      generation: 1,
      runId: FOLLOW_ON_RUN,
    }),
  );
  expect(next.outcome.status).toBe("completed");
  expect(cutShortOf(next)).toEqual([]);
  const packets = await expectNoReversal(store);
  const last = packets.at(-1)!;
  expect(last.payload.complete).toBe(true);
  expect(last.payload.counts.pending).toEqual({ batches: 0, sections: 0 });
  // Batch a is the same recorded batch: frozen, never written again.
  expect((await batchIdsOf(store, last))[0]).toBe(published[0]);
  expect(await batchesOf(store, last)).toEqual([
    "Retry policy",
    "Guards",
    "Lookup table",
  ]);
});

// Reason: the defect (plant 108). A follow-on whose clock is already past its cut-off reaches
// Publish with no batches by Front (no Frame or Map). It never fails, so it never fails every
// attempt with no receipt: it ends with a cut-off stage (its receipt says `timed-out`), one ending
// call that adds no batch and says why with the chain's pending counts unchanged, and, only once
// that call is stored, one ask for the next follow-on (a fresh run with its own clock). That next
// run, given time, completes. One whose readings' plan was cut off goes on per batch instead
// (round 18): its batches are not reached, and it asks for the next follow-on the same way.
test("a follow-on past its cut-off with no batches ends with a gap, never a retryable failure", async () => {
  for (const frontFallback of [false, true]) {
    const store = scratch({ cycleId: CYCLE });
    done(
      await runReview(store, {
        readings: { a: "completed", b: "cutoff", c: "cutoff" },
        joined: true,
      }),
    );
    const before = await packetsOf(store);
    const stale = done(
      await runReview(store, {
        readings: ALL,
        generation: 1,
        runId: FOLLOW_ON_RUN,
        cutoffAt: Date.now() - 1_000,
        ...(frontFallback ? { frontFallback } : {}),
      }),
    );
    expect({ frontFallback, status: stale.outcome.status }).toEqual({
      frontFallback,
      status: "completed",
    });
    expect(stale.calls).not.toContain("publish");
    expect(stale.asked).toBe(1);
    expect(stale.askedAt).toEqual([{ endingRow: true, endedCommit: true }]);
    if (!frontFallback) {
      // The plan cut off: every batch waits, nothing is decided, and the chain goes on.
      expect(stale.waiters).toHaveLength(3);
      const held = (await expectNoReversal(store)).at(-1)!;
      expect(held.payload.complete).toBe(false);
      expect(held.payload.counts.pending).toEqual(
        before.at(-1)!.payload.counts.pending,
      );
      const next = done(
        await runReview(store, {
          readings: ALL,
          joined: true,
          generation: 2,
          runId: NEXT_RUN,
        }),
      );
      expect(next.outcome.status).toBe("completed");
      expect((await expectNoReversal(store)).at(-1)!.payload.complete).toBe(
        true,
      );
      continue;
    }
    expect(stale.waiters).toHaveLength(0);
    expect(cutShortOf(stale).at(-1)).toMatchObject({
      agent: "link.batches",
      status: "interrupted",
    });
    expect(stale.log.filter((r) => r.type === "publish.no-batches")).toEqual([
      expect.objectContaining({ cutoff: true, chain: true, published: true }),
    ]);
    const packets = await expectNoReversal(store);
    expect(packets).toHaveLength(before.length + 1);
    const last = packets.at(-1)!;
    expect(last.payload.added.batches).toBe(0);
    expect(last.payload.complete).toBe(false);
    expect(last.payload.counts.pending).toEqual(
      before.at(-1)!.payload.counts.pending,
    );
    expect(await gapsOf(store, last)).toContainEqual({
      kind: "batches-not-reached",
      detail:
        "This follow-on review ran out of time before any batch was decided: the batches not yet published wait for a follow-on run, or for the next request when none starts.",
    });

    const next = done(
      await runReview(store, {
        readings: ALL,
        joined: true,
        generation: 2,
        runId: NEXT_RUN,
      }),
    );
    expect(next.outcome.status).toBe("completed");
    expect(cutShortOf(next)).toEqual([]);
    const after = await expectNoReversal(store);
    expect(after.at(-1)!.payload.complete).toBe(true);
  }
});

// Reason: records' one ending call per run and the B1 order (the ask only after the stored ending
// call). For a follow-on with no batches, a failed read of the chain's totals or a failed ending
// call is a real error, not a lack of time: the run fails, to be retried, with no `ended` commit,
// no ask and no packet. The retried attempt (a new review task, as the host admits after a failed
// one) makes the ending call and only then asks.
test("a follow-on's failed ending call fails the run; the retry makes the call and then asks", async () => {
  for (const failing of ["endingFails", "chainTotalsFails"] as const) {
    const store = scratch({ cycleId: CYCLE });
    done(
      await runReview(store, {
        readings: { a: "completed", b: "cutoff", c: "cutoff" },
        joined: true,
      }),
    );
    const before = await packetsOf(store);
    const stale = {
      readings: ALL,
      generation: 1,
      runId: FOLLOW_ON_RUN,
      cutoffAt: Date.now() - 1_000,
      // With no Frame or Map: the no-batches ending call (a cut-off plan goes on per batch).
      frontFallback: true,
    };
    const failed = done(await runReview(store, { ...stale, [failing]: true }));
    expect({ failing, status: failed.outcome.status }).not.toEqual({
      failing,
      status: "completed",
    });
    expect(failed.asked).toBe(0);
    expect(
      failed.commits.some(
        (c) =>
          (c as { state?: { checkpoint?: { ended?: unknown } } }).state
            ?.checkpoint?.ended !== undefined,
      ),
    ).toBe(false);
    expect(await packetsOf(store)).toEqual(before);

    const retried = done(await runReview(store, stale));
    expect(retried.outcome.status).toBe("completed");
    expect(retried.asked).toBe(1);
    expect(retried.askedAt).toEqual([{ endingRow: true, endedCommit: true }]);
    const packets = await expectNoReversal(store);
    expect(packets).toHaveLength(before.length + 1);
    expect(packets.at(-1)!.payload.counts.pending).toEqual(
      before.at(-1)!.payload.counts.pending,
    );
  }
});

// Reason: the timeline lane's note. The read of whether a follow-on is left is caught as the ask
// is: when it fails, none is left (a logged outcome), and Publish still makes its ending call, as
// the last run the review is allowed.
test("a failed read of the follow-on cap counts as a successor that may exist: the ending call is made and the ask decides", async () => {
  const store = scratch({ cycleId: CYCLE });
  const run = done(
    await runReview(store, {
      readings: { a: "completed", b: "completed", c: "cutoff" },
      joined: true,
      followOnLeftThrows: true,
    }),
  );
  expect(run.outcome.status).toBe("completed");
  expect(run.log.filter((r) => r.type === "publish.follow-on-left")).toEqual([
    expect.objectContaining({ failed: true }),
  ]);
  expect(
    run.log.filter((r) => r.type === "publish.settled").at(-1),
  ).toMatchObject({ ending: true });
  // Not the last run: nothing not reached is settled, it stays pending, and the follow-on is asked.
  expect(run.settles.filter((s) => s.last || s.final)).toEqual([]);
  expect(run.asked).toBe(1);
  const last = (await packetsOf(store)).at(-1)!;
  expect(last.payload.complete).toBe(false);
  expect(last.payload.counts.pending).toEqual({ batches: 1, sections: 1 });
});

// Reason (round 18, replacing ruling 5b's old-packet fallback for a plan that failed): with the
// readings on and the plan dropped, a review never quietly publishes the old packet. A first run and
// a follow-on alike publish per batch from the batches the readers give for the dropped plan (no
// reading waits, every section the person's), and the run's gap says the plan failed.
test("a dropped plan: a first run and a follow-on each publish per batch, never the old packet, with the gap that says the plan failed", async () => {
  for (const generation of [0, 1]) {
    const store = scratch({ cycleId: CYCLE });
    const run = done(
      await runReview(store, { readings: ALL, planFails: true, generation }),
    );
    expect(run.outcome.status).toBe("completed");
    expect(run.calls).not.toContain("publish");
    expect(run.waiters).toHaveLength(3);
    // No reading was made: each batch waits on none, and none holds it.
    expect(run.asked).toBe(0);
    const packets = await packetsOf(store);
    const newest = packets.at(-1)!;
    expect(newest.payload.complete).toBe(true);
    expect(await gapsOf(store, newest)).toContainEqual({
      kind: "section-readings",
      detail: DROPPED_PLAN_GAP.detail,
    });
    expect(DROPPED_PLAN_GAP.detail).toBe(
      "Section readings: the plan for reading the changed sections failed, so no reading judged them and a person decides each one.",
    );
  }
});

// Reason: records' B2 by every path. A follow-on run whose Front ends with no Frame or Map goes
// straight to Publish: it never publishes the old packet over the per-batch chain, and never fails;
// a first run in the same state publishes the old packet as before.
test("a follow-on run whose Front has no Frame or Map ends cut short instead of publishing the old packet", async () => {
  const first = done(
    await runReview(scratch({ cycleId: CYCLE }), {
      readings: ALL,
      frontFallback: true,
    }),
  );
  expect(first.calls).toContain("publish");
  expect(first.outcome.status).toBe("completed");
  const store = scratch({ cycleId: CYCLE });
  const followOn = done(
    await runReview(store, {
      readings: ALL,
      frontFallback: true,
      generation: 1,
    }),
  );
  expect(followOn.outcome.status).toBe("completed");
  expect(followOn.calls).not.toContain("publish");
  expect(cutShortOf(followOn).length).toBeGreaterThan(0);
  expect(await packetsOf(store)).toEqual([]);
});

const notSettled = {
  status: "completed",
  result: { status: "not-settled", kind: "not-reached" },
} as const;
/**
 * Each published section of a packet, by section key: its unit, assessment and disposition as
 * Records holds them, so two packets compare by section key, whatever their unit IDs.
 */
const bySection = async (store: Store, packet: Packet) => {
  const read = await store.run(PublishedPackets.readExact(packet.id));
  const out = new Map<string, string>();
  if (read?.kind !== "packet.published@2") return out;
  for (const batch of read.batches)
    for (const unit of batch.units)
      for (const section of unit.sections)
        out.set(
          section.key,
          JSON.stringify({
            batch: batch.key,
            unit: unit.recorded?.id ?? null,
            assessment: unit.assessment?.payload ?? null,
            disposition: unit.disposition?.payload ?? null,
          }),
        );
  return out;
};
/** Zero reversals by section key: a section decided in a packet is the same in every later one. */
const expectNoSectionReversal = async (store: Store) => {
  const packets = await expectNoReversal(store);
  let before = new Map<string, string>();
  for (const packet of packets) {
    const now = await bySection(store, packet);
    for (const [key, value] of before) expect(now.get(key)).toBe(value);
    before = now;
  }
  return packets;
};

// Reason (14.6, round 14's chain under one run key): a follow-on reuses what is decided. Run 1
// decides batch A and leaves B and C not reached; the follow-on
// of the same run key, leaves A's batch key, its recorded batch, its unit IDs, lanes and verdicts
// byte-equal, and decides only B and C, all through the real `publishSettled` on a real store.
test("a chain under one run key: the follow-on leaves the decided batch byte-equal and decides only the rest", async () => {
  const store = scratch({ cycleId: CYCLE });
  const first = done(
    await runReview(store, {
      readings: { a: "completed", b: "cutoff", c: "cutoff" },
      joined: true,
    }),
  );
  expect(first.asked).toBe(1);
  const ending = (await packetsOf(store)).at(-1)!;
  expect(await batchesOf(store, ending)).toEqual(["Retry policy"]);
  const decided = await bySection(store, ending);
  expect(decided.size).toBeGreaterThan(0);
  const next = done(
    await runReview(store, {
      readings: ALL,
      joined: true,
      generation: 1,
      runId: FOLLOW_ON_RUN,
    }),
  );
  expect(next.outcome.status).toBe("completed");
  const packets = await expectNoSectionReversal(store);
  const last = packets.at(-1)!;
  expect(last.payload.complete).toBe(true);
  const after = await bySection(store, last);
  for (const [key, value] of decided) expect(after.get(key)).toBe(value);
  // Run 2 handed A again and the publisher kept it frozen: only B and C were added.
  expect(
    packets
      .slice(packets.findIndex((p) => p.id === ending.id) + 1)
      .reduce((sum, p) => sum + p.payload.added.batches, 0),
  ).toBe(2);
  // The publisher kept the earlier batch frozen when its waiter handed it back.
  expect(Number(next.summaries[0]!["handed"])).toBe(1);
  expect(next.summaries[0]!["frozen"]).toBe(0);
});
