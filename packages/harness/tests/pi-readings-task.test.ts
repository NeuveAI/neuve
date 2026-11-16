// Why (NEU-148, the probe): a section reading runs inside a real review as a durable task beside the
// finders. It must never fail the review, never judge a section it could not read, never read a
// section a third time, and check each distinct defect claim once. These drive the production
// reading task and agent step on a real pi Harness over memory storage, with pi-ai's faux provider
// as the model (no network) and a real Records store for the stored answers.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
  type Api,
  type AssistantMessage,
  type Model,
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
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
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
import { storedOutput, type StageRecord } from "../src/pipeline.ts";
import type { RunLog, RunLogRecord } from "../src/run-log.ts";
import { agentRoutes, clearInheritedAgentRoute } from "../src/pi/bindings.ts";
import type { AgentRouteBinding } from "../src/pi/contracts.ts";
import { RunControlDoc } from "../src/pi/control.ts";
import {
  routeFailureDiagnostic,
  schedulerText,
  type RouteFailureKind,
} from "../src/pi/providers/failure.ts";
import { erased } from "../src/pi/stages/agent.ts";
import type { AgentStepInput } from "../src/pi/stages/agent-step.ts";
import { childId } from "../src/pi/stages/children.ts";
import type { FrontResult } from "../src/pi/stages/front-task.ts";
import { agentKinds } from "../src/pi/stages/kinds.ts";
import {
  failureLabel,
  readingBinds,
  readingTask,
  withStepEffort,
  type ReadingTaskInput,
  type ReadingTaskResult,
} from "../src/pi/stages/reading-task.ts";
import {
  OPUS_ROUTE,
  SOL_ROUTE,
  stepEffortOf,
  type AnyRouteConfig,
  type RouteEffort,
} from "../src/route.ts";
import { bindingProvider } from "../src/pi/attempt.ts";
import type { RouteTransportOptions } from "../src/pi/providers/agent-route-provider.ts";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
  completed,
  created,
  functionCallItem,
  messageItem,
  openEndpoint,
  sse,
  tokenCommand,
} from "./pi/providers/fixture.ts";
import { stageRunner, type StageServices } from "../src/pi/stages/services.ts";
import { ventTool } from "../src/pipeline.ts";
import {
  ClaimStored,
  claimKey,
  claimVerdict,
  claimVerifyStep,
} from "../src/readings/claims.ts";
import { GroupEvidence } from "../src/readings/evidence.ts";
import { planReadings } from "../src/readings/plan.ts";
import { renderReading } from "../src/readings/reading.ts";
import {
  AssessStored,
  LaneReviewStored,
  assessStep,
  laneReviewOutcomes,
  laneReviewStep,
} from "../src/readings/steps.ts";
import { mixedRange } from "./fixtures/readings.ts";

const directory = mkdtempSync(join(tmpdir(), "pi-readings-task-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

/** Every string in a value, joined: what a request's messages say, whatever their shape. */
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

/** How the model answers, per reading. */
interface Policy {
  /** Section numbers an Assess answer leaves out, by how many sections the reading has. */
  readonly skip?: (sections: number) => ReadonlySet<number>;
  /** A Lane review's defect comments, by section number, in the reading's own numbering. */
  readonly defects?: ReadonlyArray<{ readonly s: number; readonly t: string }>;
  /** Fails every reading step before it starts: an expected failure, or a fault. */
  readonly fail?: "failed" | "faulted";
  /**
   * What every Assess answer holds beyond its one class: a factor over its text bound, more
   * requirements than the cap, or (the first submission only) an answer not of the schema.
   */
  readonly assess?: "long-factor" | "many-requirements" | "broken-first";
  /** Every reading's model call fails with a route failure of this kind, past pi's retries. */
  readonly refuse?: RouteFailureKind;
}

type Sent = {
  readonly mode: AgentRouteBinding["mode"];
  readonly messages: ReadonlyArray<Message>;
};

/**
 * The real wire in place of the faux model: the run's route, and the transport the attempt's own
 * provider factory (`bindingProvider`) is given, pointed at a local endpoint. The harness is then
 * stored in SQLite, so a test can close it and open it again.
 */
interface Wire {
  readonly route: AnyRouteConfig;
  readonly transport: Omit<RouteTransportOptions, "route" | "log">;
}

const world = async (name: string, policy: Policy, wire?: Wire) => {
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
    config:
      wire === undefined
        ? defaultConfig()
        : defaultConfig(undefined, wire.route),
    log,
    startedAt: Date.now(),
    reconciliationId: mintUlid(),
    records,
  };
  const run = stageRunner(ctx, clients);

  // The range, its plan and the plan's stored computation.
  const range = mixedRange();
  const plan = planReadings({
    hunks: range.hunks,
    structures: range.structures,
    excluded: range.excluded,
  });
  const hunks = new Map(range.hunks.map((hunk) => [hunk.hunkId, hunk]));
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
  const planKey = await store("test.readings-plan", plan);
  const group = plan.groups[0]!;

  // The model: what each request is sent, and the answer the policy gives it.
  const sent: Array<Sent> = [];
  const answer = (at: Sent): AssistantMessage => {
    const text = textOf(at.messages);
    if (policy.refuse !== undefined)
      return {
        ...fauxAssistantMessage([], {
          stopReason: "error",
          errorMessage: schedulerText("Route", {
            kind: policy.refuse,
            status: 400,
          }),
        }),
        diagnostics: [
          routeFailureDiagnostic(
            {
              kind: policy.refuse,
              status: 400,
              detail: "PROVIDER-WORDS-4m",
            },
            Date.now(),
          ),
        ],
      };
    const sections = numbers(text, /^Section (\d+):/gm);
    const files = numbers(text, /File (\d+)\n/g);
    const reply = (tool: string, value: unknown) =>
      at.mode.kind === "final"
        ? fauxAssistantMessage([fauxText(JSON.stringify(value))], {
            stopReason: "stop",
          })
        : fauxAssistantMessage(
            [fauxToolCall(tool, value as never, { id: `call-${sent.length}` })],
            { stopReason: "toolUse" },
          );
    if (text.includes("Check whether the supplied evidence")) {
      if (text.includes("STALL-CLAIM"))
        return at.mode.kind === "final"
          ? fauxAssistantMessage([fauxText("not an answer")], {
              stopReason: "stop",
            })
          : reply("submit_verify", { decision: "maybe" });
      return reply("submit_verify", {
        decision: text.includes("KEEP-CLAIM") ? "keep" : "drop",
        reason: "Read the cited lines.",
      });
    }
    if (text.includes("You assess changed code")) {
      const skip = policy.skip?.(sections.length) ?? new Set<number>();
      const asked = sent.filter((x) =>
        textOf(x.messages).includes("You assess changed code"),
      ).length;
      if (policy.assess === "broken-first" && asked === 1)
        return reply("submit_assess", { classes: "every section is fine" });
      const requirements =
        policy.assess === "many-requirements"
          ? Array.from({ length: 9 }, (_, i) => ({
              t: `Requirement ${i} holds.`,
              kinds: ["test-run"],
              cites: [],
              testable: true,
              untested: "",
              proof: [],
              agree: false,
            }))
          : [];
      return reply("submit_assess", {
        factors:
          policy.assess === "long-factor"
            ? [{ f: "connections", t: "x".repeat(130), cites: [] }]
            : [],
        requirements,
        impact: [],
        classes: [
          {
            S: sections.filter((s) => !skip.has(s)),
            c: "l",
            v: "e",
            F: policy.assess === "long-factor" ? [0] : [],
            R: requirements.map((_, i) => i),
            person: null,
            gaps: null,
          },
        ],
      });
    }
    const index = renderReading(plan, group.id, {
      for: "lane-review",
      hunks,
      structures: range.structures,
    }).index;
    const defects = policy.defects ?? [];
    return reply("submit_review", {
      files: files.map((f) => ({
        f,
        checked: "Read the rows and callers.",
        rows: null,
      })),
      sections: {
        a: sections.filter((s) => !defects.some((d) => d.s === s)),
        r: sections.filter((s) => defects.some((d) => d.s === s)),
        u: [],
      },
      comments: defects.map((d) => {
        const section = index.sections.find((x) => x.index === d.s)!;
        const owned = section.owned[0]!;
        return {
          s: d.s,
          side: owned.side,
          start: owned.startLine,
          end: owned.startLine,
          kind: "defect",
          effect: null,
          t: d.t,
          cites: [
            `${section.file}${owned.side === "new" ? "n" : "o"}${owned.startLine}`,
          ],
          fails: "The count is off by one on this path.",
          row: null,
        };
      }),
      unsure: [],
    });
  };

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
        if (wire !== undefined)
          return bindingProvider(wire.route, { ...wire.transport, log })(
            binding,
            readBinding,
          );
        const faux = fauxProvider({
          api: "faux",
          provider: binding.logicalProvider,
          models: [{ id: binding.physicalModel }],
        });
        faux.setResponses(
          Array.from({ length: 64 }, () => async (transcript) => {
            const at = {
              mode: (await readBinding()).mode,
              messages: transcript.messages,
            };
            sent.push(at);
            return answer(at);
          }),
        );
        return faux.provider;
      },
    });
  };
  // Every bind the agent steps make, as they make it.
  const binds: Array<{
    readonly agent: string;
    readonly effort: RouteEffort | undefined;
    readonly conversationId: number;
  }> = [];
  const services: StageServices = {
    ctx,
    routes: {
      bindAgentRoute: (input, c) => {
        binds.push({
          agent: input.agent,
          effort: input.effort,
          conversationId: Number(input.conversationId),
        });
        return routes().bindAgentRoute(input, c);
      },
      prepareFinalGeneration: (input, c) =>
        routes().prepareFinalGeneration(input, c),
    },
    capture: () => {},
    registry,
    integrations: { status: "absent", path: "(none)" },
    clients,
    run,
    endRound: async ({ generation, decide }, hookContext) => {
      if (harness === undefined) throw new Error("the harness is not open");
      const stop = await harness.commit(decide, hookContext);
      if (stop) await harness.abortTask(generation, hookContext);
    },
  };

  /**
   * The readings' agents, built as run.ts builds them, over the fixture's range, each at the effort
   * its parameters carry as `readingStep` sets it (`withStepEffort`).
   */
  const prepare = async (_taskId: number, input: AgentStepInput) => {
    const agent = await prepareStep(input);
    return {
      ...agent,
      step: withStepEffort(
        agent.step,
        (input.params as { effort?: RouteEffort }).effort,
      ),
    };
  };
  const prepareStep = async (input: AgentStepInput) => {
    if (policy.fail === "failed")
      throw {
        _tag: "ReadingBroke",
        message: "the reading could not be prepared",
        retryable: false,
      };
    if (policy.fail === "faulted") throw new Error("the reading broke");
    const vent = ventTool(ctx, "verify");
    const p = input.params as {
      group: string;
      part?: "read" | "reread";
      only?: Array<string>;
      answer?: string;
      claim?: string;
    };
    if (input.kind === "verify-claim") {
      const stored = await run(storedOutput(ctx, p.answer!, LaneReviewStored));
      const found = laneReviewOutcomes(stored, plan).flatMap(
        ({ key, outcome }) =>
          outcome.judged
            ? outcome.judgement.comments
                .filter((c) => c.kind === "defect" && claimKey(c) === p.claim)
                .map((comment) => ({ key, comment }))
            : [],
      )[0]!;
      return {
        step: erased(
          claimVerifyStep({
            key: p.claim!,
            section: found.key,
            comment: found.comment,
            reading: renderReading(plan, p.group, {
              for: "lane-review",
              hunks,
              structures: range.structures,
              only: [found.key],
            }),
            turnLimit: 1,
          }),
        ),
        vent,
      };
    }
    const only = p.part === "reread" ? p.only : undefined;
    const step =
      input.kind === "assess"
        ? erased(
            assessStep({
              stage: "verify",
              reading: renderReading(plan, p.group, {
                for: "assess",
                hunks,
                structures: range.structures,
                only,
              }),
            }),
          )
        : erased(
            laneReviewStep({
              stage: "verify",
              reading: renderReading(plan, p.group, {
                for: "lane-review",
                hunks,
                structures: range.structures,
                only,
              }),
              goal: { goal: "Let callers count parsed items.", doneWhen: [] },
              tools: [],
              keys: { frame: "frame-key", manifest: "manifest-key" },
            }),
          );
    return {
      step:
        p.part === "reread"
          ? {
              ...step,
              spec: { ...step.spec, agent: `${step.spec.agent}.reread` },
            }
          : step,
      vent,
    };
  };

  /**
   * A stand-in for the front task: it ends as told (both keys, a null Map key, failed, or stopped
   * with no result), at once or once the test releases it, so a reading can be made to look at it
   * while it runs or after it ended.
   */
  type FrontEnd = "keys" | "null-map" | "failed" | "aborted";
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  type FrontKeys = Pick<FrontResult, "frameKey" | "mapKey">;
  const front = defineTask<
    { readonly end: FrontEnd; readonly hold: boolean },
    { phase: "run" },
    FrontKeys
  >({
    name: "test.front",
    version: 1,
    initial: () => ({ phase: "run" }),
    phases: {
      run: async (task, runtime, c) => {
        if (task.input.hold) await held;
        const end = task.input.end;
        const outcome: TaskOutcome<FrontKeys> =
          end === "failed"
            ? { status: "failed", error: { message: "Frame failed" } }
            : end === "aborted"
              ? { status: "aborted", reason: "stopped" }
              : {
                  status: "completed",
                  result: {
                    frameKey: "front-frame",
                    mapKey: end === "keys" ? "front-map" : null,
                  },
                };
        await runtime.commit(() => ({ status: "terminal", outcome }), c);
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

  const open = async (
    wrap: (task: ReturnType<typeof readingTask>) => typeof task = (t) => t,
  ) => {
    const bound = readingBinds(services, { prepare }, true);
    const kinds = agentKinds(bound.services, { prepare: bound.prepare });
    const reading = wrap(readingTask(services, kinds.agentStep));
    registry.install(
      defineExtension({
        name: "neuve.stages",
        tasks: [kinds.agentStep, reading, front],
      }),
    );
    if (wire !== undefined) mkdirSync(root, { recursive: true });
    harness = await Harness.open(
      wire === undefined
        ? new MemoryStorage()
        : await openNodeSqliteStorage(join(root, "pi.sqlite")),
      {
        models,
        registry,
        settings: { compaction: { enabled: false }, retry: { maxRetries: 0 } },
        conversationCreated: clearInheritedAgentRoute,
      },
      context,
    );
    await routes().restoreAgentRoutes(context);
    return { harness, reading };
  };

  /** Runs one reading task to its end; returns its outcome, its children and every task. */
  const read = async (
    kind: ReadingTaskInput["kind"],
    wrap?: Parameters<typeof open>[0],
    cutoffAt = Date.now() + 60_000,
    options: {
      /** The efforts the reading's input carries, as `prepare` lists them. */
      readonly effort?: Pick<ReadingTaskInput, "effort" | "claimEffort">;
      /** Runs once the reading ended, before the harness closes. */
      readonly after?: (harness: Harness) => Promise<void>;
    } = {},
  ) => {
    const opened = await open(wrap);
    const rootConversation = await opened.harness.root(context);
    const input: ReadingTaskInput = {
      kind,
      planKey,
      group: group.id,
      rank: group.rank,
      manifestKey: "manifest-key",
      cutoffAt,
      ...(kind === "lane-review"
        ? { frameKey: "frame-key", mapKey: "map-key" }
        : {}),
      ...options.effort,
    };
    const id = (await opened.harness.commit(
      (tx) =>
        tx.createTask(opened.reading, input, {
          ownership: { kind: "conversation" },
          conversationId: rootConversation.id,
        }),
      context,
    )) as TaskId<ReadingTaskResult>;
    opened.harness.resume();
    const ended = await opened.harness.waitForTask(id, context);
    const tasks = await opened.harness.commit(
      async (tx) => (await tx.scanTasks({}, 1000)).items,
      context,
    );
    // The steps the run control document holds for the provider: a held review.
    const held = Object.keys(
      (await opened.harness.snapshot(RunControlDoc, context))?.held ?? {},
    );
    await options.after?.(opened.harness);
    await opened.harness.close(context);
    const steps = tasks.filter(
      (task) =>
        task.kind === "neuve.agent-step" && Number(task.owner) === Number(id),
    );
    // The reading's children by the names it started them under.
    const children = Object.fromEntries(
      steps.map((task) => {
        const input = task.input as AgentStepInput;
        const params = input.params as { part?: string; claim?: string };
        return [
          input.kind === "verify-claim"
            ? `claim.${params.claim}`
            : (params.part ?? "?"),
          Number(task.id),
        ];
      }),
    );
    return { outcome: ended.state.outcome, children, steps, held, id };
  };

  /**
   * Starts one reading and returns once its step is held for the provider: the reading's state
   * then, the steps the run control document holds, and the reading's agent steps.
   */
  const readUntilHeld = async (kind: ReadingTaskInput["kind"]) => {
    const opened = await open();
    const rootConversation = await opened.harness.root(context);
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
    };
    const id = (await opened.harness.commit(
      (tx) =>
        tx.createTask(opened.reading, input, {
          ownership: { kind: "conversation" },
          conversationId: rootConversation.id,
        }),
      context,
    )) as TaskId<ReadingTaskResult>;
    opened.harness.resume();
    const watch = await opened.harness.watchTaskGraph(context);
    try {
      await new Promise<void>((resolve) => {
        const check = () => {
          const tasks = Object.values(watch.value?.tasks ?? {});
          if (
            tasks.some(
              (task) =>
                task.state !== undefined &&
                "phase" in task.state &&
                task.state.phase === "provider-held",
            )
          )
            resolve();
        };
        check();
        watch.start(async () => check());
      });
    } finally {
      await watch.stop();
    }
    const reading = await opened.harness.getTask(id, context);
    const tasks = await opened.harness.commit(
      async (tx) => (await tx.scanTasks({}, 1000)).items,
      context,
    );
    const held = Object.keys(
      (await opened.harness.snapshot(RunControlDoc, context))?.held ?? {},
    );
    await opened.harness.close(context);
    const steps = tasks.filter(
      (task) =>
        task.kind === "neuve.agent-step" && Number(task.owner) === Number(id),
    );
    return { reading: reading?.state, held, steps };
  };

  /**
   * Runs one reading created as the early form creates it: no Frame or Map key, the front task's ID
   * instead. With `hold`, the front task runs until the test releases it: once the Lane review is
   * waiting on it (`after-wait`), once the reading ended (`after-end`, which an Assess never
   * waits for), or never before the cut-off, where the reading is stopped as the host stops a
   * review's children (`cutoff`).
   */
  const readEarly = async (
    kind: ReadingTaskInput["kind"],
    end: FrontEnd,
    options: {
      readonly hold?: "after-wait" | "after-end" | "cutoff";
      readonly cutoffAt?: number;
      readonly wrap?: Parameters<typeof open>[0];
    } = {},
  ) => {
    const opened = await open(options.wrap);
    const rootConversation = await opened.harness.root(context);
    const cutoffAt = options.cutoffAt ?? Date.now() + 60_000;
    const [frontId, id] = await opened.harness.commit(async (tx) => {
      const owner = {
        ownership: { kind: "conversation" } as const,
        conversationId: rootConversation.id,
      };
      const f = await tx.createTask(
        front,
        { end, hold: options.hold !== undefined },
        owner,
      );
      const input: ReadingTaskInput = {
        kind,
        planKey,
        group: group.id,
        rank: group.rank,
        manifestKey: "manifest-key",
        cutoffAt,
        front: Number(f),
      };
      return [
        f,
        (await tx.createTask(
          opened.reading,
          input,
          owner,
        )) as TaskId<ReadingTaskResult>,
      ] as const;
    }, context);
    opened.harness.resume();
    const statusOf = (task: TaskId) =>
      opened.harness.commit(
        async (tx) => (await tx.task(task))?.state.status,
        context,
      );
    // Whether the reading parked on the front task: the test looks until it does (bounded).
    let waited = false;
    if (options.hold === "after-wait" || options.hold === "cutoff")
      for (let at = 0; at < 500 && !waited; at++) {
        waited = (await statusOf(id)) === "waiting";
        if (!waited) await Bun.sleep(10);
      }
    if (options.hold === "after-wait") release();
    if (options.hold === "cutoff") {
      await Bun.sleep(Math.max(0, cutoffAt - Date.now() + 5));
      await opened.harness.abortTask(id, context);
    }
    const ended = await opened.harness.waitForTask(id, context);
    // The front task was still running when the reading ended, unless released before.
    const frontAtEnd = await statusOf(frontId);
    release();
    await opened.harness.waitForTask(frontId, context);
    const tasks = await opened.harness.commit(
      async (tx) => (await tx.scanTasks({}, 1000)).items,
      context,
    );
    await opened.harness.close(context);
    const steps = tasks.filter(
      (task) =>
        task.kind === "neuve.agent-step" && Number(task.owner) === Number(id),
    );
    return {
      outcome: ended.state.outcome,
      steps,
      waited,
      frontAtEnd,
      id: Number(id),
    };
  };

  return {
    ctx,
    run,
    plan,
    group,
    planKey,
    sent,
    binds,
    routes,
    prepare,
    open,
    models,
    read,
    readUntilHeld,
    readEarly,
    rows,
    release: () => release(),
  };
};

const resultOf = (outcome: { status: string; result?: unknown }) => {
  expect(outcome.status).toBe("completed");
  return outcome.result as ReadingTaskResult;
};

// Reason: failed twice means not judged, never a third call and never a judgement.
test("a reading answered whole needs no re-read; one that leaves two sections reads them once more, and a section left again is failed", async () => {
  // Every section answered: no re-read.
  const whole = await (await world("whole", {})).read("assess");
  const all = resultOf(whole.outcome);
  expect(Object.keys(whole.children)).toEqual(["read"]);
  expect(whole.steps).toHaveLength(1);
  expect(all.notJudged).toEqual([]);
  expect(all.steps).toHaveLength(1);

  // Sections 2 and 3 left out of the first reading; the re-read (two sections) answers them.
  const twice = await world("twice", {
    skip: (count) => (count > 2 ? new Set([2, 3]) : new Set()),
  });
  const second = await twice.read("assess");
  const answered = resultOf(second.outcome);
  expect(Object.keys(second.children).sort()).toEqual(["read", "reread"]);
  expect(second.steps).toHaveLength(2);
  expect(answered.notJudged).toEqual([]);
  expect(answered.steps).toHaveLength(2);
  const reread = await twice.run(
    storedOutput(twice.ctx, answered.steps[1]!, AssessStored),
  );
  // In the plan's reading order, the second and third sections, and nothing else.
  expect(reread.sections).toEqual([twice.group.keys[1]!, twice.group.keys[2]!]);

  // The re-read leaves its first section out again: that one is failed, and no third step runs.
  const thrice = await world("thrice", {
    skip: (count) => (count > 2 ? new Set([2, 3]) : new Set([1])),
  });
  const third = await thrice.read("assess");
  const left = resultOf(third.outcome);
  expect(third.steps).toHaveLength(2);
  expect(left.notJudged).toEqual([
    { section: thrice.group.keys[1]!, cause: "failed" },
  ]);
}, 60_000);

// Reason: one failed reading must never fail the review, nor read as a review that ran out of time.
test("a reading whose steps fail or fault still ends completed, with every section failed and no cut-short record; one the cut-off stops records that", async () => {
  for (const fail of ["failed", "faulted"] as const) {
    const run = await world(`broken-${fail}`, { fail });
    const ended = await run.read("lane-review");
    const result = resultOf(ended.outcome);
    // The failed read is re-read once, alone; that fails too, and nothing more is started.
    expect(Object.keys(ended.children).sort()).toEqual(["read", "reread"]);
    expect(ended.steps.map((step) => step.state.status)).toEqual([
      "terminal",
      "terminal",
    ]);
    expect(
      ended.steps.map(
        (step) =>
          (step.state as { outcome: { status: string } }).outcome.status,
      ),
    ).toEqual([fail, fail]);
    expect(result.steps).toEqual([]);
    expect(result.claims).toEqual([]);
    expect(result.notJudged).toEqual(
      run.group.keys.map((section) => ({ section, cause: "failed" })),
    );
    // What kind of failure each step was, as a label: the step task's tag, or unknown when the
    // runtime faulted it with no detail; never its message.
    expect(result.failures).toEqual(
      (["read", "reread"] as const).map((part) => ({
        part,
        failure: fail === "failed" ? "ReadingBroke" : "unknown",
      })),
    );
    expect(JSON.stringify(result)).not.toContain("could not be prepared");
    expect(JSON.stringify(result)).not.toContain("the reading broke");
    // A failed step has no record, and the reading adds none: a failure is never a time-out.
    expect(
      result.stages.filter(
        (r) => r.status === "skipped" || r.status === "interrupted",
      ),
    ).toEqual([]);
  }
  // At the cut-off the step is not started: its record is the cut-off's skipped one, the sections
  // are not reached, and there is no re-read.
  const late = await world("cut-off", {});
  const cut = await late.read("assess", undefined, Date.now() - 1);
  const stopped = resultOf(cut.outcome);
  expect(Object.keys(cut.children)).toEqual(["read"]);
  expect(stopped.stages.map((r) => r.status)).toEqual(["skipped"]);
  expect(stopped.notJudged).toEqual(
    late.group.keys.map((section) => ({ section, cause: "not-reached" })),
  );
  expect(late.sent).toHaveLength(0);
}, 60_000);

// Reason: the first real probe run lacked this. A reading step whose model call the provider could
// not answer ends failed through its spec's option (`unanswered: "fail"`): its sections are not
// judged (`failed`), its row's failure label is the route failure's kind, and the review is not
// held. A step stopped by the account itself (`isAccountFailure`) still holds: the reading waits,
// the review is held, and no section is recorded as not judged.
test("a reading step the provider could not answer ends failed with its route failure's kind and no hold; one the account stopped holds the review", async () => {
  for (const kind of ["assess", "lane-review"] as const) {
    const run = await world(`refused-${kind}`, { refuse: "invalid_request" });
    const ended = await run.read(kind);
    const result = resultOf(ended.outcome);
    expect(Object.keys(ended.children).sort()).toEqual(["read", "reread"]);
    expect(
      ended.steps.map(
        (step) =>
          (step.state as { outcome: { status: string } }).outcome.status,
      ),
    ).toEqual(["failed", "failed"]);
    expect(result.steps).toEqual([]);
    expect(result.notJudged).toEqual(
      run.group.keys.map((section) => ({ section, cause: "failed" })),
    );
    expect(result.failures).toEqual(
      (["read", "reread"] as const).map((part) => ({
        part,
        failure: "invalid_request",
      })),
    );
    expect(ended.held).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("PROVIDER-WORDS-4m");
    // One model call per step: the failed read, then the re-read's.
    expect(run.sent).toHaveLength(2);
  }
  for (const kind of ["auth", "sign_in", "binding", "plan_quota"] as const) {
    // An operation name takes no underscore.
    const run = await world(`account-${kind.replace("_", "-")}`, {
      refuse: kind,
    });
    const held = await run.readUntilHeld("assess");
    expect(held.reading?.status).toBe("waiting");
    expect(held.steps).toHaveLength(1);
    expect(held.held).toEqual([String(held.steps[0]!.id)]);
    expect(held.steps[0]!.state).toMatchObject({
      status: "running",
      checkpoint: { phase: "provider-held", failure: { kind } },
    });
    expect(run.sent).toHaveLength(1);
  }
}, 120_000);

// Reason: one check per distinct claim, and an unchecked claim is never a confirmed one.
test("identical defect claims make one check, a replayed claims phase starts none twice, and keep, drop and a backstop are confirmed, refuted and unconfirmed", async () => {
  const run = await world("claims", {
    defects: [
      { s: 1, t: "KEEP-CLAIM: count misses the last item" },
      // The same claim, written in other case and spacing: one check serves both.
      { s: 1, t: "keep-claim:   count misses the  LAST item" },
      { s: 2, t: "DROP-CLAIM: the helper returns early" },
      { s: 3, t: "STALL-CLAIM: the test asserts the wrong length" },
    ],
  });
  let replayed = 0;
  const ended = await run.read("lane-review", (task) => {
    const claims = task.definition.phases.claims;
    return {
      definition: {
        ...task.definition,
        phases: {
          ...task.definition.phases,
          // The claims phase's commit runs its change, then is interrupted before it lands; the
          // phase runs again from the same checkpoint.
          claims: async (t, runtime, c) => {
            const interruption = new Error("interrupted before the commit");
            try {
              await claims(
                t,
                {
                  ...runtime,
                  commit: (async (change: never, cc: never) =>
                    runtime.commit(async (tx) => {
                      await (change as (tx: unknown) => Promise<unknown>)(tx);
                      throw interruption;
                    }, cc)) as typeof runtime.commit,
                },
                c,
              );
            } catch (error) {
              if (error !== interruption) throw error;
              replayed++;
              await claims(t, runtime, c);
            }
          },
        },
      },
    };
  });
  expect(replayed).toBe(1);
  const result = resultOf(ended.outcome);
  // Three distinct claims, one check each, and no check started twice.
  expect(result.claims).toHaveLength(3);
  expect(
    Object.keys(ended.children).filter((n) => n.startsWith("claim.")),
  ).toHaveLength(3);
  const checks = ended.steps.filter(
    (step) => (step.input as AgentStepInput).kind === "verify-claim",
  );
  expect(checks).toHaveLength(3);
  const verdicts = [];
  for (const claim of result.claims) {
    expect(claim.verifyKey).not.toBeNull();
    const stored = await run.run(
      storedOutput(run.ctx, claim.verifyKey!, ClaimStored),
    );
    expect(stored.claim).toBe(claim.key);
    verdicts.push(claimVerdict(stored));
  }
  // In claim order: the KEEP claim, the DROP claim, the claim whose check never gave an answer.
  expect(verdicts).toEqual(["confirmed", "refuted", "unconfirmed"]);
  // A claim with no finished check is never confirmed.
  expect(claimVerdict(undefined)).toBe("unconfirmed");
}, 90_000);

// Reason: a claim whose check the cut-off kept from running was not reached; it is never
// "unconfirmed", and no check is started for it once the cut-off has passed.
test("past the cut-off the claims phase starts no check and records each claim as not reached", async () => {
  const run = await world("claims-late", {
    defects: [
      { s: 1, t: "KEEP-CLAIM: count misses the last item" },
      { s: 2, t: "DROP-CLAIM: the helper returns early" },
    ],
  });
  const ended = await run.read("lane-review", (task) => {
    const claims = task.definition.phases.claims;
    return {
      definition: {
        ...task.definition,
        phases: {
          ...task.definition.phases,
          // The claims phase runs after the cut-off: its clock says so.
          claims: (t, runtime, c) =>
            claims(t, { ...runtime, now: () => t.input.cutoffAt + 1 }, c),
        },
      },
    };
  });
  const result = resultOf(ended.outcome);
  expect(result.claims).toHaveLength(2);
  expect(
    result.claims.map((claim) => [claim.reached, claim.verifyKey]),
  ).toEqual([
    [false, null],
    [false, null],
  ]);
  expect(
    ended.steps.filter(
      (step) => (step.input as AgentStepInput).kind === "verify-claim",
    ),
  ).toHaveLength(0);
  expect(
    Object.keys(ended.children).filter((n) => n.startsWith("claim.")),
  ).toEqual([]);
  // The checks it did not start read as cut short: one skipped record for the reading's claims,
  // so the run is not stored as the range's review and a later one checks them.
  expect(
    result.stages.filter(
      (r) => r.status === "skipped" || r.status === "interrupted",
    ),
  ).toEqual([
    {
      stage: "verify",
      agent: `lane-review.${run.group.id}.claims`,
      status: "skipped",
      wallMs: 0,
      note: "The checks of this reading's claims did not start before the review's cut-off.",
      disclosure: null,
    },
  ]);
}, 60_000);

// Reason: the probe must say why readings failed without any provider text. A failed step's outcome
// gives its route failure's kind, else its tag, as a label; anything that is not a short word of
// letters and underscores is unknown, and the message never comes through.
test("a failed step's label is its failure kind or its tag, a label that is not a short word is unknown, and the message never comes through", () => {
  const failed = (detail: unknown) =>
    ({
      status: "failed",
      error: {
        message: "PROVIDER-TEXT-MARK Invalid schema for response_format",
        detail,
      },
    }) as Parameters<typeof failureLabel>[0];
  expect(
    failureLabel(
      failed({
        tag: "ModelError",
        message: "PROVIDER-TEXT-MARK",
        failure: { kind: "invalid_request", message: "PROVIDER-TEXT-MARK" },
      }),
    ),
  ).toBe("invalid_request");
  expect(failureLabel(failed({ tag: "ModelError" }))).toBe("ModelError");
  expect(failureLabel(failed({ tag: "Model Error" }))).toBe("unknown");
  expect(failureLabel(failed({ tag: "x".repeat(41) }))).toBe("unknown");
  expect(failureLabel(failed({ tag: "x".repeat(40) }))).toBe("x".repeat(40));
  expect(
    failureLabel(failed({ tag: "ModelError", failure: { kind: "a kind" } })),
  ).toBe("unknown");
  expect(failureLabel(failed("PROVIDER-TEXT-MARK"))).toBe("unknown");
  expect(failureLabel(failed(undefined))).toBe("unknown");
  expect(failureLabel(undefined)).toBe("unknown");
  expect(
    failureLabel({ status: "orphaned", reason: "PROVIDER-TEXT-MARK" }),
  ).toBe("unknown");
});

// Reason (round 2f, second amendment): a size slip must not cost a turn or a group, and the probe
// must be able to say why an answer was sent back. A factor over its text bound, or more
// requirements than the cap, is accepted on the first call, stored (clipped, or whole) and counted;
// it never costs a second model call.
test("an over-long factor or an over-cap requirement list is accepted on the first call, stored clipped or whole, and counted", async () => {
  for (const assess of ["long-factor", "many-requirements"] as const) {
    const at = await world(assess, { assess });
    const ended = await at.read("assess");
    const result = resultOf(ended.outcome);
    expect(result.notJudged).toEqual([]);
    expect(result.steps).toHaveLength(1);
    // One model call: no send-back, no re-read.
    expect(
      at.sent.filter((x) =>
        textOf(x.messages).includes("You assess changed code"),
      ),
    ).toHaveLength(1);
    const stored = await at.run(
      storedOutput(at.ctx, result.steps[0]!, AssessStored),
    );
    if (assess === "long-factor") {
      // Clipped to the factor's bound (80 characters since round 2h); one long word has no word
      // boundary to cut at, so it is cut at the bound, ending with the ellipsis.
      expect(stored.answer.factors[0]!.t).toBe(`${"x".repeat(79)}\u2026`);
      expect(stored.problems.first).toEqual({ "clipped-text": 1 });
    } else {
      expect(stored.answer.requirements).toHaveLength(9);
      expect(stored.answer.classes[0]!.R).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
      expect(stored.problems.first).toEqual({ "over-cap": 2 });
    }
  }
}, 60_000);

// Reason (round 2f, second amendment D1): a submission zod refuses is sent back without reaching
// the step's checks, so the stored counts must still say the first answer was not the schema.
// The composition reads it from what the step recorded for each answer (`AgentResult.submissions`).
test("a first answer not of the schema, then a good one, stores not-the-schema under first", async () => {
  const at = await world("broken-first", { assess: "broken-first" });
  const ended = await at.read("assess");
  const result = resultOf(ended.outcome);
  const stored = await at.run(
    storedOutput(at.ctx, result.steps[0]!, AssessStored),
  );
  expect(stored.problems.first).toEqual({ "not-the-schema": 1 });
  // The answer the checks judged after it is still what `given` counts: none of its problems.
  expect(stored.problems.given).toEqual({});
}, 60_000);

const paramsOf = (step: { readonly input: unknown }) =>
  (step.input as AgentStepInput).params as {
    part?: string;
    frame?: string;
    map?: string;
  };

// Reason: a reading must not fail the review, nor run without the Frame, because Map was late. A
// Lane review created before the Frame and the Map waits on the front task, then reads with the keys
// its result holds; when that task ends without them, or the cut-off comes first, it is not reached.
test("a Lane review given the front task waits on it and reads with its keys; with a null key, a failed or stopped front task, or the cut-off first, it ends not reached", async () => {
  // Parked on the front task while it ran, then read with its keys; so does one that finds it ended.
  for (const hold of ["after-wait", undefined] as const) {
    const at = await world(`front-keys-${hold ?? "ended"}`, {});
    const ended = await at.readEarly("lane-review", "keys", {
      ...(hold === undefined ? {} : { hold }),
    });
    if (hold !== undefined) expect(ended.waited).toBe(true);
    const result = resultOf(ended.outcome);
    expect(result.notJudged).toEqual([]);
    expect(result.steps).toHaveLength(1);
    expect(ended.steps.map(paramsOf)).toEqual([
      expect.objectContaining({
        part: "read",
        frame: "front-frame",
        map: "front-map",
      }),
    ]);
    expect(
      at.rows.find(
        (row) => row.type === "task.inputs" && row["taskId"] === ended.id,
      )?.["inputs"],
    ).toMatchObject({
      frame: "computation:front-frame",
      map: "computation:front-map",
    });
  }
  // The re-read is shown the keys the read found.
  const again = await world("front-reread", { fail: "failed" });
  const reread = await again.readEarly("lane-review", "keys", {
    hold: "after-wait",
  });
  expect(reread.steps.map(paramsOf)).toEqual([
    expect.objectContaining({ frame: "front-frame", map: "front-map" }),
    expect.objectContaining({ frame: "front-frame", map: "front-map" }),
  ]);
  expect(reread.steps.map((step) => paramsOf(step).part).sort()).toEqual([
    "read",
    "reread",
  ]);

  // The front task ended with no Map, failed, or was stopped with nothing: not reached, no step.
  for (const end of ["null-map", "failed", "aborted"] as const) {
    const at = await world(`front-${end}`, {});
    const ended = await at.readEarly("lane-review", end, {
      hold: "after-wait",
    });
    expect(ended.waited).toBe(true);
    const result = resultOf(ended.outcome);
    expect(result.notJudged).toEqual(
      at.group.keys.map((section) => ({ section, cause: "not-reached" })),
    );
    expect(result.steps).toEqual([]);
    expect(result.claims).toEqual([]);
    expect(result.failures).toEqual([]);
    expect(result.stages.map((r) => [r.agent, r.status])).toEqual([
      [`lane-review.${at.group.id}`, "skipped"],
    ]);
    expect(ended.steps).toEqual([]);
    expect(at.sent).toHaveLength(0);
  }

  // The cut-off comes while it waits: stopped as the host stops a review's children, not reached.
  const late = await world("front-cutoff", {});
  const cut = await late.readEarly("lane-review", "keys", {
    hold: "cutoff",
    cutoffAt: Date.now() + 400,
  });
  expect(cut.waited).toBe(true);
  expect(cut.frontAtEnd).toBe("running");
  expect(cut.outcome).toMatchObject({ status: "aborted", reason: "cutoff" });
  const stopped = (cut.outcome as { result: ReadingTaskResult }).result;
  expect(stopped.notJudged).toEqual(
    late.group.keys.map((section) => ({ section, cause: "not-reached" })),
  );
  expect(stopped.steps).toEqual([]);
  expect(cut.steps).toEqual([]);
  expect(late.sent).toHaveLength(0);
}, 90_000);

// Reason: that is the point of the round. An Assess task reads from the plan alone, so it starts
// at once, with no Frame or Map in the store, while the front task still runs; it only stops by
// itself, before a model step, when it can see the front task ended with no Frame or Map.
test("an Assess task given the front task reads at once with no Frame or Map in the store, and stops before a step once the front task ended without them", async () => {
  // The front task runs throughout: the reading never waits for it.
  const early = await world("assess-early", {});
  const ran = await early.readEarly("assess", "keys", { hold: "after-end" });
  expect(ran.frontAtEnd).toBe("running");
  expect(ran.waited).toBe(false);
  const read = resultOf(ran.outcome);
  expect(read.notJudged).toEqual([]);
  expect(read.steps).toHaveLength(1);
  expect(ran.steps.map(paramsOf)).toEqual([
    expect.not.objectContaining({ frame: expect.anything() }),
  ]);
  // No Frame and no Map is stored anywhere in this world.
  for (const key of ["front-frame", "front-map"])
    await expect(
      early.run(storedOutput(early.ctx, key, AssessStored)),
    ).rejects.toBeDefined();

  // The front task ended with no Map before the read: no step is started.
  const before = await world("assess-unframed", {});
  const none = await before.readEarly("assess", "null-map", {
    wrap: (task) => {
      const read = task.definition.phases.read;
      return {
        definition: {
          ...task.definition,
          phases: {
            ...task.definition.phases,
            read: async (t, runtime, c) => {
              await runtime.waitForTask(childId(t.input.front!), c);
              return read(t, runtime, c);
            },
          },
        },
      };
    },
  });
  const unread = resultOf(none.outcome);
  expect(unread.notJudged).toEqual(
    before.group.keys.map((section) => ({ section, cause: "not-reached" })),
  );
  expect(unread.steps).toEqual([]);
  expect(none.steps).toEqual([]);
  expect(before.sent).toHaveLength(0);

  // It ended so after the read and before the re-read: the read stands, no re-read is started.
  const between = await world("assess-between", {
    skip: (count) => (count > 2 ? new Set([2, 3]) : new Set()),
  });
  const once = await between.readEarly("assess", "null-map", {
    hold: "after-end",
    wrap: (task) => {
      const reread = task.definition.phases.reread;
      return {
        definition: {
          ...task.definition,
          phases: {
            ...task.definition.phases,
            reread: async (t, runtime, c) => {
              between.release();
              await runtime.waitForTask(childId(t.input.front!), c);
              return reread(t, runtime, c);
            },
          },
        },
      };
    },
  });
  const left = resultOf(once.outcome);
  expect(left.steps).toHaveLength(1);
  expect(once.steps.map((step) => paramsOf(step).part)).toEqual(["read"]);
  expect(left.notJudged).toEqual([
    { section: between.group.keys[1]!, cause: "not-reached" },
    { section: between.group.keys[2]!, cause: "not-reached" },
  ]);
}, 90_000);

// Reason: the binding refuses a second bind of a conversation at another effort, so a resumed step
// or a re-read that asked for another effort than its read would fail the reading. And a reading's
// own `task.inputs` row is where the Frame and Map it read are named, in either input form.
test("a reading's read, re-read and claim checks bind at the efforts its input carries, each step prepared again from its stored input binds at the same, and a Lane review's own row names its Frame and Map", async () => {
  type Run = Awaited<ReturnType<typeof world>>;
  /** After the reading ended: every step prepared again from its stored input and bound again. */
  const resume = (run: Run, out: Array<string>) => async (harness: Harness) => {
    const tasks = await harness.commit(
      async (tx) => (await tx.scanTasks({}, 1000)).items,
      context,
    );
    for (const task of tasks.filter((t) => t.kind === "neuve.agent-step")) {
      const { step } = await run.prepare(0, task.input as AgentStepInput);
      const conversationId = run.binds.find(
        (bind) => bind.agent === step.spec.agent,
      )!.conversationId as never;
      const bind = (effort: RouteEffort) =>
        run.routes().bindAgentRoute(
          {
            conversationId,
            stage: step.spec.stage,
            agent: step.spec.agent,
            route: run.ctx.config.route,
            effort,
          },
          context,
        );
      // As the agent step binds: at its spec's effort, which its stored parameters still give.
      const effort = stepEffortOf(
        run.ctx.config.route,
        step.spec.stage,
        step.spec.effort,
      );
      await bind(effort);
      const stored = await run.routes().readBinding(conversationId, context);
      out.push(`${step.spec.agent}:${effort}:${stored.effort ?? "route"}`);
      // Any other effort is refused: a step that asked for one could not run.
      await expect(bind(effort === "low" ? "high" : "low")).rejects.toThrow(
        "refusing",
      );
    }
  };
  const efforts = (run: Run) =>
    [...new Set(run.binds.map((b) => `${b.agent}:${b.effort}`))].sort();
  /**
   * The one relation evidence key every step of a reading carries (the read, the re-read and each
   * claim's check), which its result names too.
   */
  const evidenceOf = (ended: Awaited<ReturnType<Run["read"]>>) => {
    const keys = new Set(
      ended.steps.map(
        (step) =>
          ((step.input as AgentStepInput).params as { evidence?: string })
            .evidence,
      ),
    );
    expect(keys.size).toBe(1);
    const [key] = [...keys];
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(resultOf(ended.outcome as never).evidence).toBe(key!);
    return key!;
  };

  // An Assess at high on the medium route, whose read leaves two sections: the re-read at high too.
  const assess = await world("effort-assess", {
    skip: (count) => (count > 2 ? new Set([2, 3]) : new Set()),
  });
  const g = assess.group.id;
  const assessResumed: Array<string> = [];
  const assessed = await assess.read("assess", undefined, undefined, {
    effort: { effort: "high" },
    after: resume(assess, assessResumed),
  });
  expect(Object.keys(assessed.children).sort()).toEqual(["read", "reread"]);
  expect(efforts(assess)).toEqual([
    `assess.${g}.reread:high`,
    `assess.${g}:high`,
  ]);
  expect(assessResumed.sort()).toEqual([
    `assess.${g}.reread:high:high`,
    `assess.${g}:high:high`,
  ]);
  // An Assess reads no Frame or Map: its own row names the plan and the manifest only.
  expect(
    assess.rows.find(
      (row) => row.type === "task.inputs" && row["taskId"] === assessed.id,
    )?.["inputs"],
  ).toEqual({
    plan: `computation:${assess.planKey}`,
    manifest: "computation:manifest-key",
    // The group's relation evidence: decided once, here from a manifest the store does not hold,
    // so it shows nothing and names no relations read.
    evidence: `computation:${evidenceOf(assessed)}`,
  });
  // That decision met an error (the manifest is not in the store): it was stored as failed, showing
  // nothing, and the reading started and ran all the same.
  expect(
    await assess.run(
      storedOutput(assess.ctx, evidenceOf(assessed), GroupEvidence),
    ),
  ).toMatchObject({ outcome: "failed", sections: [] });

  // A Lane review at low with its claims' checks at high.
  const review = await world("effort-review", {
    defects: [{ s: 1, t: "KEEP-CLAIM: count misses the last item" }],
  });
  const reviewResumed: Array<string> = [];
  const reviewed = await review.read("lane-review", undefined, undefined, {
    effort: { effort: "low", claimEffort: "high" },
    after: resume(review, reviewResumed),
  });
  const claim = Object.keys(reviewed.children).find((n) =>
    n.startsWith("claim."),
  )!;
  const check = `verify.claim.${claim.slice("claim.".length, "claim.".length + 12)}`;
  expect(efforts(review)).toEqual([
    `lane-review.${review.group.id}:low`,
    `${check}:high`,
  ]);
  expect(reviewResumed.sort()).toEqual([
    `lane-review.${review.group.id}:low:low`,
    `${check}:high:high`,
  ]);
  // Given its Frame and Map in its input (today's form), its own row names them.
  expect(
    review.rows.find(
      (row) => row.type === "task.inputs" && row["taskId"] === reviewed.id,
    )?.["inputs"],
  ).toEqual({
    plan: `computation:${review.planKey}`,
    manifest: "computation:manifest-key",
    frame: "computation:frame-key",
    map: "computation:map-key",
    evidence: `computation:${evidenceOf(reviewed)}`,
  });

  // At the route's effort with no claim effort (effort by risk off, no step-effort setting): every
  // step binds at the route's, and every binding is stored as before, with no effort of its own.
  const plain = await world("effort-plain", {
    defects: [{ s: 1, t: "KEEP-CLAIM: count misses the last item" }],
  });
  const plainResumed: Array<string> = [];
  await plain.read("lane-review", undefined, undefined, {
    effort: { effort: "medium" },
    after: resume(plain, plainResumed),
  });
  expect(plain.binds.every((b) => b.effort === "medium")).toBe(true);
  expect(plainResumed.every((r) => r.endsWith(":medium:route"))).toBe(true);
  expect(plainResumed).toHaveLength(2);
}, 90_000);

/** The effort a request body was sent at, on either route's wire. */
const sentEffort = (body: Record<string, unknown>) =>
  ((body["reasoning"] ?? body["output_config"]) as { effort?: unknown })
    ?.effort;

/**
 * The model's answer to one request, on the route's wire: an Assess submission listing every
 * section the reading shows in one class; once the submission's result is in the request, a plain
 * text reply.
 */
const wireAnswer = (
  provider: AnyRouteConfig["provider"],
  body: Record<string, unknown>,
  at: number,
) => {
  const raw = JSON.stringify(body);
  const answered =
    raw.includes('"function_call_output"') || raw.includes('"tool_result"');
  const sections = numbers(textOf(body), /^Section (\d+):/gm);
  const args = JSON.stringify({
    factors: [],
    requirements: [],
    impact: [],
    classes: [
      { S: sections, c: "l", v: "e", F: [], R: [], person: null, gaps: null },
    ],
  });
  if (provider === "openai")
    return sse([
      created(`resp_${at}`),
      ...(answered
        ? messageItem(0, `msg_${at}`, "final_answer", "done")
        : functionCallItem(0, {
            id: `fc_${at}`,
            callId: `call_${at}`,
            name: "submit_assess",
            arguments: args,
          })),
      completed(`resp_${at}`),
    ]);
  return sse([
    {
      type: "message_start",
      message: {
        id: `msg_${at}`,
        type: "message",
        role: "assistant",
        model: OPUS_ROUTE.model,
        content: [],
        stop_reason: null,
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    },
    answered
      ? {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        }
      : {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: `toolu_${at}`,
            name: "submit_assess",
            input: {},
          },
        },
    answered
      ? {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "done" },
        }
      : {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: args },
        },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: answered ? "end_turn" : "tool_use" },
      usage: { output_tokens: 2 },
    },
    { type: "message_stop" },
  ]);
};

const WIRE_KEY = "NEUVE_TEST_READINGS_WIRE_KEY";

// Reason (the scheduler lane's review of its mechanism): two links held only by reading the code.
// This drives the real reading task and the real agent step, through the real `readingBinds`
// wrapper and the routes' binding owner, with the attempt's own provider factory against a local
// endpoint: the spec's effort, the bind, the stored binding, each request body and each
// `model.call` row must agree, and after the run is closed mid-call and opened again (the
// bindings restored), the request still goes out at the reading's level.
for (const base of [
  SOL_ROUTE,
  { ...OPUS_ROUTE, credentialVariable: WIRE_KEY },
] as const)
  test(`end to end on the ${base.provider} route: a reading at high on a medium route binds, is stored, is sent and is recorded at high, and so after a reopen`, async () => {
    process.env[WIRE_KEY] = "sk-ant-test-readings-wire";
    const endpoints: Array<ReturnType<typeof openEndpoint>> = [];
    try {
      const route = { ...base, effort: "medium" } as AnyRouteConfig;
      const token = tokenCommand(directory, `lease-${base.provider}`);
      const wireTo = (endpoint: ReturnType<typeof openEndpoint>): Wire => ({
        route,
        transport: {
          auth: { tokenCommand: token.path },
          fetch: endpoint.fetch,
          capture: () => {},
          credentialInspection: "ephemeral",
        },
      });
      let at = 0;
      const answers = (
        endpoint: ReturnType<typeof openEndpoint>,
        count: number,
      ) =>
        endpoint.respond(
          ...Array.from(
            { length: count },
            () => () =>
              wireAnswer(route.provider, endpoint.received.at(-1)!.body, ++at),
          ),
        );

      // One run through.
      const endpoint = openEndpoint();
      endpoints.push(endpoint);
      answers(endpoint, 8);
      const run = await world(`wire-${base.provider}`, {}, wireTo(endpoint));
      const stored: Array<string> = [];
      const ended = await run.read("assess", undefined, undefined, {
        effort: { effort: "high" },
        after: async () => {
          for (const bind of run.binds)
            stored.push(
              (
                await run
                  .routes()
                  .readBinding(bind.conversationId as never, context)
              ).effort ?? "route",
            );
        },
      });
      const result = resultOf(ended.outcome);
      expect(result.notJudged).toEqual([]);
      expect(result.steps).toHaveLength(1);
      // The bind the agent step made through `readingBinds`, and the binding it stored.
      expect(run.binds.map((bind) => bind.effort)).toEqual(["high"]);
      expect(stored).toEqual(["high"]);
      // Every request went out at high, and every row of its calls says high.
      const sent = endpoint.received.map((request) => sentEffort(request.body));
      expect(sent.length).toBeGreaterThan(0);
      expect(sent).toEqual(sent.map(() => "high"));
      const recorded = run.rows
        .filter((row) => row.type === "model.call")
        .map((row) => row["effort"]);
      expect(recorded.length).toBeGreaterThanOrEqual(sent.length);
      expect(recorded).toEqual(recorded.map(() => "high"));

      // Bound and stored, the run closed and opened again: the routes restore each binding and
      // build its provider again with the attempt's factory, and that provider still sends the
      // reading's level. (The request is made on the restored model directly: a request on the
      // conversation would wait in the kinds' `beforeRequest` gate for a step that holds its claim,
      // and this step has ended.)
      const again = await world(
        `wire-resume-${base.provider}`,
        {},
        wireTo(endpoint),
      );
      const before = endpoint.received.length;
      answers(endpoint, 8);
      await again.read("assess", undefined, undefined, {
        effort: { effort: "high" },
      });
      expect(again.binds.map((bind) => bind.effort)).toEqual(["high"]);
      expect(endpoint.received.length).toBeGreaterThan(before);
      const conversationId = again.binds[0]!.conversationId as never;
      const reopened = await again.open();
      const binding = await again.routes().readBinding(conversationId, context);
      expect(binding.effort).toBe("high");
      const resent = endpoint.received.length;
      answers(endpoint, 1);
      await again.models.complete(
        again.models.getModel(
          binding.logicalProvider,
          binding.physicalModel,
        ) as Model<Api>,
        {
          systemPrompt: "You review.",
          messages: [{ role: "user", content: "Once more.", timestamp: 1 }],
        },
      );
      await reopened.harness.close(context);
      expect(endpoint.received).toHaveLength(resent + 1);
      expect(
        endpoint.received.slice(before).map((r) => sentEffort(r.body)),
      ).toEqual(endpoint.received.slice(before).map(() => "high"));
    } finally {
      for (const endpoint of endpoints) endpoint.stop();
      delete process.env[WIRE_KEY];
    }
  }, 60_000);
