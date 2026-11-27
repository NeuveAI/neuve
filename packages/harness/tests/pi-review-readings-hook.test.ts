// Why (NEU-148): two model readings will judge each changed section of a review. The review task
// gives them one optional hook. Their plan reads only what exists when Precompute ends (the range
// manifest's key and the front task's ID), so the review creates a plan task in the commit that
// creates the front task; that task runs the readings' `prepare` beside Frame and Map and creates
// the reading tasks, owned by the review, in its own commit. Nothing waits for it but Link: the
// review waits for it beside the finders, then on the readings it named, and hands their outcomes
// to the readings' collector before Link. The finders are started by the front task when Frame
// lands (slice B), as the stand-in below does. These tests drive the real review task and the real
// plan task on a real pi Harness with minimal native child tasks in the stage port's shape, as
// `pi-host.test.ts` does (the shape test's fixture builds its own port and cannot take one).
import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import {
  Harness,
  createRegistry,
  defineExtension,
  defineTask,
  type TaskOutcome,
  type Tx,
} from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import {} from "../src/budget.ts";
import {
  childOf,
  reviewExtension,
  reviewTask,
  type PublishInput,
  type ReviewStagesPort,
} from "../src/pi/review-task.ts";
import type { FrontInput, FrontResult } from "../src/pi/stages/front-task.ts";
import type { LeadsInput, LeadsResult } from "../src/pi/stages/leads-task.ts";
import type {
  RelationsInput,
  RelationsResult,
} from "../src/pi/stages/relations-task.ts";
import {
  READINGS_PLAN_TASK,
  readingsPlanTask,
} from "../src/pi/stages/readings-plan-task.ts";
import type { PrecomputeOutput, StageRecord } from "../src/pipeline.ts";
import type { RunLog, RunLogRecord } from "../src/run-log.ts";

const record = (
  stage: StageRecord["stage"],
  agent: string,
  status: StageRecord["status"] = "computed",
): StageRecord => ({ stage, agent, status, wallMs: 1 });

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

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
const FALLBACK_REASON = "the frame is unavailable";

// The front task starts the finders when Frame lands (NEU-148 slice B), owned by the review, and
// returns them: this stand-in does so in its one commit, under the same start rule, reading `clock`
// for the time, and then writes the one `review.schedule` row as the front task does. `before` runs
// as it starts; `atEnd` inside its terminal commit; `fallback` ends it without a Frame or a Map.
const frontTask = (
  clock: (now: number) => number,
  log: RunLog,
  hooks: {
    readonly before?: () => Promise<void>;
    readonly atEnd?: (tx: Tx) => Promise<void>;
    readonly fallback?: boolean;
    /** It ends failed, as a front task whose step failed does. */
    readonly fails?: boolean;
    readonly ended?: () => void;
    /** How each finder ends, by lens; a lens not named completes with its findings. */
  },
) =>
  defineTask<FrontInput, { phase: "run" }, FrontResult>({
    name: "test.front",
    version: 1,
    initial: () => ({ phase: "run" }),
    phases: {
      run: async (task, runtime, context) => {
        await hooks.before?.();
        await runtime.commit(async (tx) => {
          await hooks.atEnd?.(tx);
          if (hooks.fails)
            return {
              status: "terminal",
              outcome: { status: "failed", error: { message: "Frame failed" } },
            };
          if (hooks.fallback)
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
                  reason: FALLBACK_REASON,
                },
              },
            };
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
                disclosures: [],
              },
            },
          };
        }, context);
        hooks.ended?.();
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
const leads = defineTask<LeadsInput, { phase: "run" }, LeadsResult>({
  name: "test.leads",
  version: 1,
  initial: () => ({ phase: "run" }),
  phases: {
    run: (_task, runtime, context) =>
      runtime.commit(
        () => ({
          status: "terminal",
          outcome: {
            status: "completed",
            result: { status: "stored", key: "leads-key" },
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
/**
 * A stand-in for the relations task: held until `released` (or its abort), then stored. It writes
 * `relations.end` as it ends and `relations.aborted` when pi aborts it.
 */
const relationsTask = (released: Promise<void>, calls: Array<string>) =>
  defineTask<RelationsInput, { phase: "run" }, RelationsResult>({
    name: "test.relations",
    version: 1,
    initial: () => ({ phase: "run" }),
    phases: {
      run: async (_task, runtime, context) => {
        await Promise.race([
          released,
          new Promise<never>((_resolve, reject) => {
            if (runtime.signal.aborted) reject(runtime.signal.reason);
            runtime.signal.addEventListener("abort", () =>
              reject(runtime.signal.reason),
            );
          }),
        ]);
        calls.push("relations.end");
        await runtime.commit(
          () => ({
            status: "terminal",
            outcome: { status: "completed", result: { status: "stored" } },
          }),
          context,
        );
      },
    },
    abort: (_task, runtime, context) => {
      calls.push("relations.aborted");
      return runtime.commit(
        () => ({
          status: "terminal",
          outcome: {
            status: "aborted",
            reason: "stopped",
            result: { status: "stopped" },
          },
        }),
        context,
      );
    },
  });
/**
 * How a reading task ends: a result, an explicit failure, an uncaught throw (a fault), or, for
 * `stops`, by stopping the review while it runs and then honouring its own abort.
 */
type ReadingEnd = "completed" | "failed" | "faulted" | "stops";
type ReadingInput = {
  readonly name: string;
  readonly end: ReadingEnd;
  readonly manifestKey: string;
};
const readingTask = (stop: () => void) =>
  defineTask<ReadingInput, { phase: "run" }, { name: string; judged: string }>({
    name: "test.reading",
    version: 1,
    initial: () => ({ phase: "run" }),
    phases: {
      run: async (task, runtime, context) => {
        if (task.input.end === "faulted")
          throw new Error(`reading ${task.input.name} broke`);
        if (task.input.end === "stops") {
          stop();
          await new Promise<never>((_resolve, reject) => {
            if (runtime.signal.aborted) reject(runtime.signal.reason);
            runtime.signal.addEventListener("abort", () =>
              reject(runtime.signal.reason),
            );
          });
        }
        await runtime.commit(
          () => ({
            status: "terminal",
            outcome:
              task.input.end === "failed"
                ? {
                    status: "failed",
                    error: { message: `reading ${task.input.name} failed` },
                  }
                : {
                    status: "completed",
                    result: {
                      name: task.input.name,
                      judged: task.input.manifestKey,
                    },
                  },
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

type Readings = NonNullable<ReviewStagesPort["readings"]>;
type Collected = Parameters<Readings["collect"]>[0];
type Replayable = "precompute" | "front" | "fill" | "link" | "plan";

/** What one run saw: every commit's next state, the tasks each commit created, the stage calls. */
type Seen = {
  /** `phase` is the review's phase, or `plan` for the readings' plan task. */
  readonly commits: Array<{
    readonly phase: string;
    readonly state: Record<string, unknown> | undefined;
    readonly created: ReadonlyArray<{ kind: string; id: number }>;
  }>;
  readonly collected: Array<Collected>;
  /** The stage calls and, as `tx:<phase>`, each commit's change as it starts. */
  readonly calls: Array<string>;
  /** Open review and plan transactions when `prepare` was called and when it resolved. */
  readonly open: Array<number>;
  readonly prepared: Array<Parameters<Readings["prepare"]>[0]>;
  /** The deadline each finder was created with, in creation order (read from their inputs). */
  /** How many reading tasks existed in the front task's terminal commit. */
  readingsAtFrontEnd?: number;
  published?: PublishInput;
  /** The finders' results Link received. */
  /** When Link started, in true time. */
  linkAt?: number;
  /** The review's status as the relations stand-in was released, after Publish's commit. */
  reviewAtRelease?: string;
};

const runReview = async (options: {
  /** The readings' ends, in creation order; absent leaves the port without `readings`. */
  readonly readings?: ReadonlyArray<ReadingEnd>;
  readonly cutoffAfterMs?: number;
  /** Interrupts this phase's (or the plan task's) first commit after its change ran, then replays it. */
  readonly replay?: Replayable;
  /**
   * How `prepare` behaves past its usual few milliseconds:
   * - `throws`, `throwsSync`: rejects, or throws before returning a promise;
   * - `slow`: succeeds only once Fill (or, after a fallback, Publish) has started, so after Frame,
   *   the finders' start and Map;
   * - `held`: honours its signal, and is held until it aborts;
   * - `ignores`: ignores its signal and never settles;
   * - `stops`: stops the review, then honours its signal;
   * - `stopsBeforeCommit`: succeeds; the review is then stopped before the plan's commit runs.
   */
  readonly prepare?:
    | "throws"
    | "throwsSync"
    | "slow"
    | "held"
    | "ignores"
    | "stops"
    | "stopsBeforeCommit";
  /**
   * The front task reads the clock as this long before the cut-off, so the start rule lets the
   * finders start although the cut-off is near and two runs start them at the same moment relative
   * to it; the review's phases read true time.
   */
  readonly frontAtMsBeforeCutoff?: number;
  /** The front task waits (up to 5 s) for the plan's commit before its own. */
  readonly frontWaitsForPlan?: boolean;
  /** The front task ends without a Frame or a Map. */
  readonly frontFallback?: boolean;
  /** How each finder ends, by lens; a lens not named completes with its findings. */
  /** The front task ends failed. */
  readonly frontFails?: boolean;
  /**
   * The port has a relations starter; its task is held until the review's Publish commit has
   * landed (or until pi aborts it).
   */
  readonly relations?: boolean;
}) => {
  const seen: Seen = {
    commits: [],
    collected: [],
    calls: [],
    open: [],
    prepared: [],
  };
  /** The review's and the plan's commits whose change is running now. */
  let open = 0;
  let stopReview: (() => Promise<unknown>) | undefined;
  let fillStarted: () => void = () => {};
  const fillYet = new Promise<void>((resolve) => {
    fillStarted = resolve;
  });
  let published: () => void = () => {};
  const publishYet = new Promise<void>((resolve) => {
    published = resolve;
  });
  let planLanded: () => void = () => {};
  const planYet = new Promise<void>((resolve) => {
    planLanded = resolve;
  });
  /** Rejects when the signal aborts, as a `prepare` or Fill that honours it does. */
  const abortOf = (signal: AbortSignal) =>
    new Promise<never>((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      signal.addEventListener("abort", () => reject(signal.reason));
    });
  const records: Array<RunLogRecord> = [];
  const log: RunLog = {
    path: "(memory)",
    write: (entry) => {
      records.push(entry);
    },
    read: () => records,
  };
  const reading = readingTask(() => void stopReview?.());
  let releaseRelations: () => void = () => {};
  const relationsReleased = new Promise<void>((resolve) => {
    releaseRelations = resolve;
  });
  /** The review's status now, once it exists. */
  let reviewStatus: () => Promise<string | undefined> = async () => undefined;
  const relations = relationsTask(relationsReleased, seen.calls);
  const ends = options.readings;
  const readings: Readings | undefined =
    ends === undefined
      ? undefined
      : {
          prepare: (input, signal) => {
            seen.calls.push("readings.prepare");
            seen.prepared.push(input);
            if (options.prepare === "throwsSync")
              throw new Error("the plan broke at once");
            return (async () => {
              seen.open.push(open);
              // Slow work: it yields, and no transaction may be open while it runs or as it ends.
              await sleep(5);
              seen.open.push(open);
              if (options.prepare === "throws")
                throw new Error("the plan broke");
              if (options.prepare === "slow")
                await Promise.race([fillYet, publishYet, sleep(10_000)]);
              if (options.prepare === "ignores") await new Promise(() => {});
              if (options.prepare === "stops") void stopReview?.();
              if (options.prepare === "held" || options.prepare === "stops")
                await abortOf(signal);
              expect(signal.aborted).toBe(false);
              seen.calls.push("readings.prepared");
              return {
                manifestKey: input.manifestKey,
                plan: ends.map((end, index) => ({
                  name: `r${index + 1}`,
                  end,
                })),
              };
            })();
          },
          create: async (tx, prepared, owner) => {
            seen.calls.push("readings.create");
            const { manifestKey, plan } = prepared as {
              manifestKey: string;
              plan: ReadonlyArray<{ name: string; end: ReadingEnd }>;
            };
            const created = [];
            for (const { name, end } of plan)
              created.push({
                name,
                task: await tx.createTask(
                  reading,
                  { name, end, manifestKey },
                  { ownership: { kind: "task", taskId: owner } },
                ),
              });
            return created;
          },
          collect: async (input) => {
            seen.calls.push("readings.collect");
            seen.collected.push(input);
            return {
              stages: input.readings.map((r) =>
                record(
                  "verify",
                  `read.${r.name}`,
                  r.outcome?.status === "completed" ? "computed" : "skipped",
                ),
              ),
              disclosures: input.readings
                .filter((r) => r.outcome?.status !== "completed")
                .map((r) => ({
                  kind: "reading",
                  detail: `Reading ${r.name} did not judge this range.`,
                })),
            };
          },
        };
  const front = frontTask(
    (now) =>
      options.frontAtMsBeforeCutoff === undefined
        ? now
        : cutoffAt - options.frontAtMsBeforeCutoff,
    log,
    {
      ...(options.frontFallback ? { fallback: true } : {}),
      ...(options.frontFails ? { fails: true } : {}),
      ended: () => seen.calls.push("front.end"),
      ...(options.frontWaitsForPlan
        ? {
            before: () => Promise.race([planYet, sleep(5_000)]),
            atEnd: async (tx) => {
              seen.readingsAtFrontEnd = (
                await tx.scanTasks({}, 1000)
              ).items.filter((t) => t.kind === "test.reading").length;
            },
          }
        : {}),
    },
  );

  // Every commit's next state and the tasks created inside it, as pi stores them.
  type Commit = (
    change: (tx: Tx, current: unknown) => unknown,
    c: typeof context,
  ) => Promise<void>;
  type Runtime = { readonly commit: Commit; readonly signal: AbortSignal };
  type Handler = (
    task: unknown,
    runtime: Runtime,
    c: typeof context,
  ) => Promise<void>;
  const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  const observed = (label: string, runtime: Runtime, interrupt?: Error) => ({
    ...runtime,
    commit: (async (change, c) => {
      if (label === "plan" && options.prepare === "stopsBeforeCommit") {
        // Its plan is back; the review is stopped before this commit runs.
        seen.calls.push("plan.stopping");
        void stopReview?.();
        await abortOf(runtime.signal).catch(() => {});
      }
      await runtime.commit(async (tx, current) => {
        seen.calls.push(`tx:${label}`);
        open++;
        try {
          const created: Array<{ kind: string; id: number }> = [];
          const counted = new Proxy(tx, {
            get: (target, property) => {
              if (property === "createTask")
                return async (...args: Parameters<Tx["createTask"]>) => {
                  const id = await target.createTask(...args);
                  created.push({ kind: args[0].definition.name, id });
                  return id;
                };
              const value: unknown = Reflect.get(target, property);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
          const state = await change(counted, current);
          // A replay: the change ran and created its children, then the commit never landed.
          if (interrupt !== undefined) throw interrupt;
          seen.commits.push({
            phase: label,
            state:
              state === undefined
                ? undefined
                : json(state as Record<string, unknown>),
            created,
          });
          return state;
        } finally {
          open--;
        }
      }, c);
      if (label === "plan") planLanded();
      if (label === "publish" && options.relations) {
        seen.reviewAtRelease = String(await reviewStatus());
        releaseRelations();
      }
    }) as Commit,
  });
  const replayed = new Set<string>();
  /** A task whose phases see `observed` runtimes, and replay as `options.replay` says. */
  const observe = <T>(original: T, name: "review" | "plan"): T => {
    const definition = (
      original as unknown as {
        definition: { phases: Record<string, Handler> };
      }
    ).definition;
    const phases = Object.fromEntries(
      Object.entries(definition.phases).map(([phase, run]) => {
        const label = name === "review" ? phase : name;
        const handler: Handler = async (task, runtime, c) => {
          if (options.replay !== label || replayed.has(label))
            return run(task, observed(label, runtime), c);
          replayed.add(label);
          const interruption = new Error(
            `replay after the ${label} commit's change`,
          );
          try {
            await run(task, observed(label, runtime, interruption), c);
          } catch (error) {
            if (error !== interruption) throw error;
            seen.calls.push(`${label}.replayed`);
            await run(task, observed(label, runtime), c);
          }
        };
        return [phase, handler];
      }),
    );
    return {
      ...original,
      definition: { ...definition, phases },
    } as unknown as T;
  };
  // Registered whatever the port says, as the stages extension registers it.
  const plan = observe(readingsPlanTask(log, readings), "plan");
  const port: ReviewStagesPort = {
    front: childOf(front),
    leads: childOf(leads),
    ...(options.relations ? { relations: childOf(relations) } : {}),
    precompute: async () => ({
      record: record("precompute", "precompute"),
      facts: { key: "precompute-key", output: PRECOMPUTE },
    }),
    fill: async () => {
      seen.calls.push("fill");
      fillStarted();
      return { record: record("link", "link.fill"), groups: [] };
    },
    link: async (input) => {
      seen.calls.push("link");
      seen.linkAt = Date.now();
      return {
        record: record("link", "link"),
        candidates: [],
        changeMapKey: "change-map-key",
        disclosures: [{ kind: "link", detail: "Link disclosed this." }],
      };
    },
    publish: async (input) => {
      seen.calls.push("publish");
      seen.published = input;
      published();
      return [record("publish", "publish")];
    },
    ...(readings === undefined
      ? {}
      : { readings, readingsPlan: childOf(plan) }),
  };
  const task = observe(reviewTask(port, log), "review");
  const registry = createRegistry();
  registry.install(
    defineExtension({
      name: "test.stages",
      tasks: [front, leads, relations, reading, plan],
    }),
  );
  registry.install(reviewExtension(task));
  const harness = await Harness.open(
    new MemoryStorage(),
    {
      models: createModels(),
      registry,
      settings: { compaction: { enabled: false }, retry: { maxRetries: 0 } },
    },
    context,
  );
  const cutoffAt = Date.now() + (options.cutoffAfterMs ?? 600_000);
  try {
    const root = await harness.root(context);
    const id = await harness.commit(
      (tx) =>
        tx.createTask(
          task,
          {
            range: {
              baseRef: "main",
              baseOid: "a".repeat(40),
              headOid: "b".repeat(40),
            },
            config: {} as never,
            runKey: "run-key",
            runId: "run-1",
            cycleId: "cycle-1",
            generation: 0,
            cutoffAt,
          },
          { ownership: { kind: "conversation" }, conversationId: root.id },
        ),
      context,
    );
    stopReview = () => harness.abortTask(id, context);
    reviewStatus = () =>
      harness.commit(async (tx) => (await tx.task(id))?.state.status, context);
    harness.resume();
    const ended = await harness.waitForTask(id, context);
    seen.calls.push("review.terminal");
    const tasks = await harness.commit(
      async (tx) => (await tx.scanTasks({}, 1000)).items,
      context,
    );
    // Telemetry is written a microtask late.
    await sleep(0);
    return {
      seen,
      cutoffAt,
      endedAt: Date.now(),
      outcome: ended.state.outcome as TaskOutcome<{
        stages: ReadonlyArray<StageRecord>;
      }>,
      tasks: tasks
        .map((t) => ({
          id: Number(t.id),
          kind: t.kind,
          owner: t.owner === undefined ? undefined : Number(t.owner),
          status: t.state.status,
          outcome: (t.state as { outcome?: TaskOutcome<unknown> }).outcome,
        }))
        .sort((a, b) => a.id - b.id),
      records,
    };
  } finally {
    await harness.close(context);
  }
};
type Run = Awaited<ReturnType<typeof runReview>>;

/** The review's commits only, as the port-absent run commits them. */
const states = (run: Run) =>
  run.seen.commits
    .filter((commit) => commit.phase !== "plan")
    .map((commit) => ({ phase: commit.phase, state: commit.state }));
/** The same with the plan's ID taken out of each checkpoint. */
/**
 * What a port-absent run publishes, with the one line a review with the readings on adds when no
 * reading ran (round 18: no drop is silent).
 */
const withNoReadings = (absent: Run) => ({
  ...absent.seen.published!,
  disclosures: [
    ...absent.seen.published!.disclosures,
    {
      kind: "section-readings",
      detail:
        "Section readings: none ran in this review, so no section was judged by a reading.",
    },
  ],
});

const withoutPlan = (run: Run) =>
  states(run).map(({ phase, state }) => {
    const checkpoint = { ...(state?.["checkpoint"] as object) } as Record<
      string,
      unknown
    >;
    delete checkpoint["plan"];
    return { phase, state: { ...state, checkpoint } };
  });

const checkpointOf = (run: Run, phase: string, index = 0) => {
  const state = run.seen.commits.filter((c) => c.phase === phase)[index]?.state;
  return state?.["checkpoint"] as Record<string, unknown> | undefined;
};
const outcomeOf = (r: Collected["readings"][number]) => r.outcome;
const kind = (run: Run, name: string) =>
  run.tasks.filter((t) => t.kind === name);

// The run's fixed values, as the review task without the hook (f1ed6458) commits them.
const PRE = record("precompute", "precompute");
const FRAME = record("frame", "frame");
const FILL = record("link", "link.fill");
const LINK = record("link", "link");
const SOURCES = {
  sources: { manifest: "manifest-key", changeMap: null, scope: "scope-key" },
  strongestStratum: "nothing",
  disclosures: [],
};
const KEYS = {
  frameKey: "frame-key",
  mapKey: "map-key",
  manifestKey: "manifest-key",
};
// Task IDs on a fresh store without the port: the front is 7, the leads 8, the finders 9 to 12.
// With it, the plan is 9, created in the same commit, and the finders and readings follow in the
// order the front task's and the plan's commits land.
const PLAN = 9;

const THREE: ReadonlyArray<ReadingEnd> = [
  "completed",
  "completed",
  "completed",
];
/** The run log's `readings.prepare` rows and the `prepare` span's end. */
const prepareRows = (run: Run) =>
  run.records.filter((r) => r.type === "readings.prepare");
const prepareSpans = (run: Run) =>
  run.records.filter(
    (r) => r.type === "span" && r["name"] === "harness.readings.prepare",
  );
const reviewOf = (run: Run) => kind(run, "neuve.review")[0]!.id;
/** The readings in creation order, by the names `create` gave them. */
const readingsOf = (run: Run) =>
  kind(run, "test.reading").map((t, index) => ({
    name: `r${index + 1}`,
    task: t.id,
  }));
/**
 * The review's commits up to Link's wait, without the plan's ID and with each finder named by its
 * place, not its task ID (the plan's ID shifts them).
 */
const upToLinkWait = (run: Run) => {
  const finders = kind(run, "test.finder").map((t) => t.id);
  return JSON.parse(
    JSON.stringify(withoutPlan(run).slice(0, 2)).replaceAll(
      /"task":(\d+)/g,
      (_match, id: string) => `"task":"finder ${finders.indexOf(Number(id))}"`,
    ),
  ) as unknown;
};
const before = (run: Run, first: string, then: string) => {
  const a = run.seen.calls.indexOf(first);
  const b = run.seen.calls.indexOf(then);
  expect(a).toBeGreaterThanOrEqual(0);
  expect(b).toBeGreaterThan(a);
};

// Why: the hook must cost nothing when it is off. These values are what the same run commits on
// f1ed6458, before the hook existed (this test was run there, unchanged, and passed). Since
// 5c783b7d no checkpoint names the leads task and Link goes to Publish at once (`running`). With
// the port absent no plan task is created, so every task ID is today's.

// Why: the readings' plan starts when its inputs exist, in Precompute's commit beside the front
// task, so it never waits for Frame or Map; the review waits for it only before Link, beside the
// finders, then on the readings it named, and collects them without a poll in creation order.

// Why: the readings exist before the front task ends. The front task here waits for the plan's
// commit before its own (up to 5 s); had the plan waited for the front task, its commit would find
// no reading.

// Why: a failed reading must never fail the review; the collector records it as not judged.
test("a failed and a faulted reading still complete and publish the review, with the collector's records", async () => {
  const run = await runReview({
    readings: ["failed", "faulted", "completed"],
  });
  expect(run.outcome.status).toBe("completed");
  expect(run.seen.calls).toContain("publish");
  expect(run.seen.collected).toHaveLength(1);
  const got = run.seen.collected[0]!.readings;
  expect(got.map((r) => r.name)).toEqual(["r1", "r2", "r3"]);
  expect(got.map((r) => outcomeOf(r)?.status)).toEqual([
    "failed",
    "faulted",
    "completed",
  ]);
  expect(outcomeOf(got[0]!)).toEqual({
    status: "failed",
    error: { message: "reading r1 failed" },
  });
  expect(outcomeOf(got[1]!)).toMatchObject({
    status: "faulted",
    error: { message: expect.stringContaining("reading r2 broke") },
  });
  expect(outcomeOf(got[2]!)).toEqual({
    status: "completed",
    result: { name: "r3", judged: "manifest-key" },
  });
  const read = [
    record("verify", "read.r1", "skipped"),
    record("verify", "read.r2", "skipped"),
    record("verify", "read.r3"),
  ];
  // The collector's records come after the finders' and before Link's.
  expect(run.outcome).toEqual({
    status: "completed",
    result: {
      stages: [PRE, FRAME, FILL, ...read, LINK, record("publish", "publish")],
    },
  });
  expect(run.seen.published?.stages).toEqual([PRE, FRAME, FILL, ...read, LINK]);
  // The readings' disclosures come after Link's, so Link's gaps keep their places (and keys).
  expect(run.seen.published?.disclosures).toEqual([
    { kind: "link", detail: "Link disclosed this." },
    { kind: "reading", detail: "Reading r1 did not judge this range." },
    { kind: "reading", detail: "Reading r2 did not judge this range." },
  ]);
}, 30_000);

// Why: replay safety, in the shape test's pattern. A review phase or the plan task replayed after
// its commit's change ran (and the commit did not land) creates each task once, in the commit that
// lands: one plan, one front task, four finders, three readings, collected once. Only a replayed
// plan prepares again, with its own row and span; a replayed review phase never plans.
for (const replay of ["precompute", "front", "fill", "link", "plan"] as const)
  test(`replaying ${replay === "plan" ? "the plan task" : `the ${replay} phase`} creates each reading once`, async () => {
    const run = await runReview({ readings: THREE, replay });
    expect(run.outcome.status).toBe("completed");
    expect(run.seen.calls).toContain(`${replay}.replayed`);
    expect(kind(run, READINGS_PLAN_TASK)).toHaveLength(1);
    expect(kind(run, "test.front")).toHaveLength(1);
    expect(kind(run, "test.reading")).toHaveLength(3);
    const plans = replay === "plan" ? 2 : 1;
    expect(run.seen.calls.filter((c) => c === "readings.prepare")).toHaveLength(
      plans,
    );
    expect(run.seen.calls.filter((c) => c === "readings.create")).toHaveLength(
      plans,
    );
    expect(prepareRows(run).map((r) => r["status"])).toEqual(
      Array(plans).fill("ok"),
    );
    expect(prepareSpans(run).map((s) => s["status"])).toEqual(
      Array(plans).fill("ok"),
    );
    expect(run.seen.open).toEqual(Array(plans * 2).fill(0));
    const readings = readingsOf(run);
    expect(checkpointOf(run, "link")?.["readings"]).toEqual(readings);
    expect(run.seen.collected).toHaveLength(1);
    expect(
      run.seen.collected[0]!.readings.map((r) => outcomeOf(r)?.status),
    ).toEqual(["completed", "completed", "completed"]);
  }, 30_000);

// Why: the finders' start rule no longer gates the readings. When too little time is left for the
// finders, the readings exist anyway, Link waits for their plan and them, and the collector runs.

// Why: an optional port must not be able to fail a review. A `prepare` that throws, as a rejected
// promise or before it returns one, leaves the review publishing exactly what a port-absent run
// publishes, every finder's candidate included and the line that no reading ran, with no reading
// and one row saying it failed.
for (const mode of ["throws", "throwsSync"] as const)
  test(`a prepare that ${mode === "throws" ? "rejects" : "throws at once"}: the review publishes as without the port, with no reading`, async () => {
    const absent = await runReview({});
    const run = await runReview({ readings: THREE, prepare: mode });
    expect(run.outcome).toEqual(absent.outcome);
    expect(run.seen.published).toEqual(withNoReadings(absent));
    expect(run.seen.published?.candidates).toHaveLength(0);
    expect(run.seen.calls).toContain("readings.prepare");
    expect(run.seen.calls).not.toContain("readings.create");
    expect(run.seen.calls).not.toContain("readings.collect");
    expect(kind(run, "test.reading")).toHaveLength(0);
    expect(run.seen.commits.find((c) => c.phase === "plan")?.state).toEqual({
      status: "terminal",
      outcome: {
        status: "completed",
        result: { status: "failed", readings: [] },
      },
    });
    // Link goes on to Publish at once: there is no reading to wait on.
    expect(run.seen.commits.filter((c) => c.phase === "link")).toHaveLength(1);
    expect(prepareRows(run)).toEqual([
      {
        type: "readings.prepare",
        taskId: reviewOf(run),
        status: "failed",
        // The failure's kind, never its text (round 22): a thrown Error says `Error`.
        tag: "Error",
        durationMs: expect.any(Number),
      },
    ]);
    expect(prepareSpans(run).map((s) => s["status"])).toEqual(["error"]);
  }, 30_000);

// cut-off): a `prepare` held until its signal aborts, or one deaf to it that never settles, ends the
// plan at that bound without readings, and Link follows then, not at the cut-off. The review
// publishes what a port-absent run publishes, with the line that no reading ran. The run's cut-off is
// 76 s away, so the bound comes in about a second.
for (const mode of ["held", "ignores"] as const)
  test(`a prepare that is ${mode === "held" ? "held to its bound" : "deaf to its signal"} ends the plan at its bound, without readings`, async () => {
    const options = { cutoffAfterMs: 76_000, frontAtMsBeforeCutoff: 200_000 };
    const absent = await runReview(options);
    const run = await runReview({ ...options, readings: THREE, prepare: mode });
    expect(run.outcome.status).toBe("completed");
    expect(run.seen.published).toEqual(withNoReadings(absent));
    expect(run.seen.published?.candidates).toHaveLength(0);
    expect(run.seen.calls).not.toContain("readings.create");
    expect(run.seen.calls).not.toContain("readings.collect");
    expect(kind(run, "test.reading")).toHaveLength(0);
    expect(prepareRows(run)).toEqual([
      {
        type: "readings.prepare",
        taskId: reviewOf(run),
        status: "cutoff",
        durationMs: expect.any(Number),
      },
    ]);
    expect(prepareSpans(run).map((s) => s["status"])).toEqual(["error"]);
    // A timer may fire a few milliseconds early.
    expect(run.seen.linkAt).toBeGreaterThanOrEqual(run.cutoffAt - 75_050);
    // Link, and the whole run, came long before the cut-off: the cut-off is a minute further on.
    expect(run.endedAt).toBeLessThan(run.cutoffAt - 60_000);
  }, 30_000);

// Why: going on without readings must not swallow a real stop. A stop while `prepare` runs aborts
// the plan with the review: aborted, nothing published, no reading, the span ended once, and no
// `readings.prepare` row (the row says how a `prepare` ended for the review; this one ended with it).
test("a stop during prepare still stops the review", async () => {
  const run = await runReview({ readings: THREE, prepare: "stops" });
  expect(run.outcome).toMatchObject({ status: "aborted", reason: "stopped" });
  expect(run.seen.calls).not.toContain("publish");
  expect(run.seen.calls).not.toContain("readings.create");
  expect(kind(run, "test.reading")).toHaveLength(0);
  expect(kind(run, READINGS_PLAN_TASK)).toEqual([
    expect.objectContaining({
      status: "terminal",
      outcome: {
        status: "aborted",
        reason: "stopped",
        result: { status: "stopped", readings: [] },
      },
    }),
  ]);
  expect(prepareRows(run)).toEqual([]);
  expect(prepareSpans(run).map((s) => s["status"])).toEqual(["error"]);
}, 30_000);

// Why: a stop after `prepare` returned and before the plan's commit stops the review, creates no
// reading, and ends the span once, as it ended (`ok`).
test("a stop after prepare returned and before the plan's commit still stops the review", async () => {
  const run = await runReview({
    readings: THREE,
    prepare: "stopsBeforeCommit",
  });
  expect(run.outcome).toMatchObject({ status: "aborted", reason: "stopped" });
  expect(run.seen.calls).toContain("plan.stopping");
  expect(run.seen.calls).not.toContain("readings.create");
  expect(run.seen.calls).not.toContain("publish");
  expect(kind(run, "test.reading")).toHaveLength(0);
  expect(kind(run, READINGS_PLAN_TASK)[0]?.outcome).toMatchObject({
    status: "aborted",
  });
  expect(prepareRows(run).map((r) => r["status"])).toEqual(["ok"]);
  expect(prepareSpans(run).map((s) => s["status"])).toEqual(["ok"]);
}, 30_000);

// Why: a stop while the readings run, and while the review waits, stops the review and every
// reading it owns: no unowned work, nothing published, no hang.
test("a stop while the readings run stops the review and its readings", async () => {
  const run = await runReview({
    readings: ["completed", "stops", "completed"],
  });
  expect(run.outcome).toMatchObject({ status: "aborted", reason: "stopped" });
  expect(run.seen.calls).not.toContain("publish");
  expect(run.seen.calls).not.toContain("readings.collect");
  const readings = kind(run, "test.reading");
  expect(readings).toHaveLength(3);
  for (const t of readings) expect(t.status).toBe("terminal");
  expect(readings[1]!.outcome).toMatchObject({ status: "aborted" });
  expect(kind(run, READINGS_PLAN_TASK)[0]).toMatchObject({
    status: "terminal",
  });
}, 30_000);

test("when Frame falls back, no reading starts and the review publishes its fallback", async () => {
  const absent = await runReview({ frontFallback: true });
  const run = await runReview({ readings: THREE, frontFallback: true });
  expect(run.outcome.status).toBe("completed");
  expect(run.seen.published).toEqual(withNoReadings(absent));
  expect(run.seen.published?.reason).toBe(FALLBACK_REASON);
  expect(run.seen.calls).not.toContain("readings.prepare");
  expect(kind(run, "test.reading")).toEqual([]);
}, 30_000);

// Why: a finding must reach the readings' decision exactly as it reaches Link. With one finder
// completed (its unused Verify included), one aborted at the cut-off with no result (the review
// fills in its entry) and one skipped, the collector gets the very list Link gets, in its order.
// The readings are created by their plan; `collect` runs in Link's invocation after it waited on
// them, with the same finders' list that invocation hands Link.

// Why (NEU-148 WP11): the relations task is started in Precompute's commit beside the leads and
// nothing in the review waits for it. Held until Publish's commit has landed, it moves none of
// Frame, the finders' start, Map, Link or Publish: the review's commits up to Link's wait, the
// schedule and what it publishes are a run's without it. The review owns it, so the review stays
// `completing` after Publish and becomes terminal only once it ends.
test("a held relations task delays nothing before Publish, and the review ends only after it", async () => {
  const options = { frontAtMsBeforeCutoff: 200_000 };
  const absent = await runReview(options);
  const run = await runReview({ ...options, relations: true });
  expect(run.outcome).toEqual(absent.outcome);
  const review = reviewOf(run);
  const pre = run.seen.commits.filter((c) => c.phase === "precompute");
  expect(pre).toHaveLength(1);
  expect(pre[0]!.created).toEqual([
    { kind: "test.front", id: 7 },
    { kind: "test.leads", id: 8 },
    { kind: "test.relations", id: 9 },
  ]);
  // No checkpoint or wait names it: the commits are a run's without it, the finders by place.
  expect(upToLinkWait(run)).toEqual(upToLinkWait(absent));
  expect(states(run).map((s) => s.phase)).toEqual(
    states(absent).map((s) => s.phase),
  );
  for (const { state } of states(run))
    expect((state?.["on"] as number[] | undefined) ?? []).not.toContain(9);
  expect(run.seen.published).toEqual(absent.seen.published);
  // Its input row names the manifest alone.
  expect(
    run.records.filter(
      (r) => r.type === "task.inputs" && r["kind"] === "relations",
    ),
  ).toEqual([
    {
      type: "task.inputs",
      taskId: 9,
      owner: review,
      kind: "relations",
      inputs: { manifest: "computation:manifest-key" },
    },
  ]);
  // Publish's commit landed while it was held: the review was completing, not terminal.
  expect(run.seen.reviewAtRelease).toBe("completing");
  before(run, "publish", "relations.end");
  before(run, "relations.end", "review.terminal");
  expect(kind(run, "test.relations")).toEqual([
    expect.objectContaining({
      id: 9,
      owner: review,
      status: "terminal",
      outcome: { status: "completed", result: { status: "stored" } },
    }),
  ]);
}, 30_000);

// Why: the review stays `completing` until the relations task ends, also on the path where Frame
// falls back and the review goes to Publish from the front phase.
test("when Frame falls back, a held relations task changes nothing published, and the review ends after it", async () => {
  const absent = await runReview({ frontFallback: true });
  const run = await runReview({ frontFallback: true, relations: true });
  expect(run.outcome).toEqual(absent.outcome);
  expect(run.seen.published).toEqual(absent.seen.published);
  expect(withoutPlan(run)).toEqual(withoutPlan(absent));
  expect(run.seen.reviewAtRelease).toBe("completing");
  before(run, "publish", "relations.end");
  before(run, "relations.end", "review.terminal");
}, 30_000);

// Why: a review whose front task fails is failed, and pi aborts the work it owns first: the held
// relations task is aborted, not left running, and the review still ends.
test("when the front task fails, pi aborts the relations task and the review fails", async () => {
  const absent = await runReview({ frontFails: true });
  const run = await runReview({ frontFails: true, relations: true });
  expect(run.outcome).toEqual(absent.outcome);
  expect(run.outcome.status).toBe("failed");
  expect(run.seen.calls).not.toContain("publish");
  expect(run.seen.calls).not.toContain("relations.end");
  before(run, "relations.aborted", "review.terminal");
  expect(kind(run, "test.relations")).toEqual([
    expect.objectContaining({
      status: "terminal",
      outcome: {
        status: "aborted",
        reason: "stopped",
        result: { status: "stopped" },
      },
    }),
  ]);
}, 30_000);
