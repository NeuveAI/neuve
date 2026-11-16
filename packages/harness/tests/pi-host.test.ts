import type { FrontInput, FrontResult } from "../src/pi/stages/front-task.ts";
import type {
  FinderInput,
  FinderResult,
} from "../src/pi/stages/finder-task.ts";
import { FINDERS } from "../src/find.ts";
import {
  findDeadline,
  MIN_FIND_WINDOW_MS,
  VERIFY_RESERVE_MS,
} from "../src/budget.ts";
// Why: the review host owns a run's lifecycle boundaries over pi's native durability: one review
// task per run admitted across claims, Understand and independent batches as owned child tasks,
// Publish after the cut-off with what the stages kept, a stop that aborts, and an agent step that
// holds on a provider failure, survives `Harness.close` without an abort and resumes its own
// conversation on the next claim, never the same claim. Everything runs on a real pi Harness over
// SQLite; the held step talks to a local OpenAI Responses fixture through pi-ai's own adapter. The
// stages here are minimal native tasks in the stage lane's port shape; the real stages are theirs.
import { afterAll, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, type Model, type Provider } from "@earendil-works/pi-ai";
import {
  stream as responsesStream,
  streamSimple as responsesStreamSimple,
} from "@earendil-works/pi-ai/api/openai-responses";
import {
  configure,
  Harness,
  createRegistry,
  defineExtension,
  defineTask,
  type ConversationId,
  type Extension,
  type HarnessSettings,
  type Storage,
  type SubmissionId,
  type TaskId,
  type Tx,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type {
  AgentRouteRuntime,
  CreateRouteProvider,
} from "../src/pi/contracts.ts";
import {
  awaitResume,
  enterHeld,
  holds,
  leaveHeld,
  resumeSubmission,
} from "../src/pi/control.ts";
import {
  HostOpenFailed,
  REVIEW_SETTINGS,
  openReviewHost,
  type QueueClaim,
  type ReviewHost,
} from "../src/pi/host.ts";
import {
  childOf,
  type PublishInput,
  type ReviewStagesPort,
} from "../src/pi/review-task.ts";
import { SourceOwnership } from "../src/pi/source-ownership.ts";
import { StorageCloseFailed, type CloseMode } from "../src/pi/storage.ts";
import type { ModelCaptureEvent } from "../src/pi/capture/types.ts";
import { heldFailure } from "../src/pi/failure-policy.ts";
import { callSlots, type CallSlots } from "../src/pi/call-slots.ts";
import { Effect } from "effect";
import { openCaptureJournal } from "../src/pi/capture/journal.ts";
import { writeNativeMeasurements } from "../src/pi/measurements.ts";
import type { RunLog, RunLogRecord } from "../src/run-log.ts";
import { createAgentRouteProvider } from "../src/pi/providers/agent-route-provider.ts";
import { routeFailureOfSubmission } from "../src/pi/providers/failure.ts";
import type { PrecomputeOutput, StageRecord } from "../src/pipeline.ts";
import { SOL_ROUTE } from "../src/route.ts";

const directory = mkdtempSync(join(tmpdir(), "harness-pi-host-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

let databases = 0;
const database = () => join(directory, `pi-${++databases}.sqlite`);

// The local OpenAI Responses fixture: each test queues the answers its requests get.

type Answer =
  "unauthorized" | "final" | { readonly status: number; readonly code: string };
const answers: Array<Answer> = [];
const requests: Array<{ readonly input: unknown }> = [];

const FINAL_TEXT = "the change maps to one behaviour";
const usage = { input_tokens: 40, output_tokens: 12, total_tokens: 52 };
const sse = (events: ReadonlyArray<Record<string, unknown>>) =>
  events
    .map(
      (event, index) =>
        `event: ${String(event.type)}\ndata: ${JSON.stringify({ ...event, sequence_number: index })}\n\n`,
    )
    .join("");
const finalTurn = () => {
  const done = {
    type: "message",
    id: "msg_1",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: FINAL_TEXT, annotations: [] }],
  };
  return sse([
    {
      type: "response.created",
      response: { id: "resp_1", status: "in_progress", output: [] },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...done, status: "in_progress", content: [] },
    },
    {
      type: "response.output_text.delta",
      output_index: 0,
      item_id: "msg_1",
      content_index: 0,
      delta: FINAL_TEXT,
    },
    { type: "response.output_item.done", output_index: 0, item: done },
    {
      type: "response.completed",
      response: { id: "resp_1", status: "completed", output: [done], usage },
    },
  ]);
};

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const body = (await request.json()) as { readonly input: unknown };
    requests.push({ input: body.input });
    const answer = answers.shift();
    if (answer === "final")
      return new Response(finalTurn(), {
        headers: { "content-type": "text/event-stream" },
      });
    if (typeof answer === "object")
      return Response.json(
        { error: { code: answer.code, message: "refused (fixture)" } },
        { status: answer.status },
      );
    if (answer === "unauthorized")
      return Response.json(
        {
          error: {
            message: "Incorrect API key provided (fixture)",
            type: "invalid_request_error",
            code: "invalid_api_key",
          },
        },
        { status: 401 },
      );
    return Response.json(
      { error: { message: "unexpected request" } },
      { status: 400 },
    );
  },
});
afterAll(() => server.stop(true));
const ORIGIN = `http://127.0.0.1:${server.port}`;

const fixtureProvider: CreateRouteProvider = (binding) => {
  const model: Model<"openai-responses"> = {
    id: binding.physicalModel,
    name: binding.physicalModel,
    api: "openai-responses",
    provider: binding.logicalProvider,
    baseUrl: `${ORIGIN}/v1`,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: true,
    contextWindow: SOL_ROUTE.window,
    maxTokens: SOL_ROUTE.maxOutputTokens,
  };
  const provider: Provider<"openai-responses"> = {
    id: binding.logicalProvider,
    name: binding.logicalProvider,
    baseUrl: `${ORIGIN}/v1`,
    auth: {
      apiKey: {
        name: "fixture key",
        resolve: async () => ({
          auth: { apiKey: "fixture-key" },
          source: "fixture",
        }),
      },
    },
    getModels: () => [model],
    stream: (m, transcript, options) =>
      responsesStream(m, transcript, { ...options, maxRetries: 0 }),
    streamSimple: (m, transcript, options) =>
      responsesStreamSimple(m, transcript, { ...options, maxRetries: 0 }),
  };
  return provider as unknown as Provider;
};

// The stages, in the stage lane's port shape. `log` records what each code step was handed.

type Log = {
  precompute: number;
  plan: number;
  published: Array<PublishInput>;
  started: Array<string>;
};
const newLog = (): Log => ({
  precompute: 0,
  plan: 0,
  published: [],
  started: [],
});

const PRECOMPUTE: PrecomputeOutput = {
  files: [],
  diffBytes: 0,
  manifest: "manifest-key",
  scope: "scope-key",
  hunks: 1,
  reviewLines: 1,
  strongestStratum: "nothing",
  scopeGaps: [],
} as unknown as PrecomputeOutput;

const record = (
  stage: StageRecord["stage"],
  agent: string,
  status: StageRecord["status"] = "computed",
): StageRecord => ({
  stage,
  agent,
  status,
  wallMs: 1,
});

const understood = (agent: string): FrontResult => ({
  stages: [record("frame", agent)],
  frameKey: "frame-key",
  mapKey: "map-key",
  frameStratum: "nothing",
  manifestKey: "manifest-key",
  scopeKey: "scope-key",
  strongestStratum: "nothing",
  disclosures: [],
});

type BatchBehaviour =
  | { readonly kind: "complete"; readonly afterMs?: number }
  | { readonly kind: "fail" }
  | { readonly kind: "never"; readonly partial: boolean };

type Stages = {
  readonly bulk?: ReadonlyArray<string>;
  readonly missingPrecompute?: "manifest" | "all";
  readonly frame?: "plain" | "agent" | "never";
  readonly behaviours?: Readonly<Record<string, BatchBehaviour>>;
};

/** The frame agent step: one owned conversation, held on a provider failure, as AgentStep does. */
type AgentCheckpoint =
  | { readonly phase: "open" }
  | { readonly phase: "bind"; readonly conversationId: ConversationId }
  | {
      readonly phase: "submit";
      readonly conversationId: ConversationId;
      readonly request: string;
      readonly resume: boolean;
    }
  | {
      readonly phase: "held";
      readonly conversationId: ConversationId;
      readonly failedSubmissionId: SubmissionId;
    };

const TASK_TEXT = "map the change into behaviours";

const stagesOf =
  (spec: Stages, log: Log) =>
  ({ routes }: { readonly routes: AgentRouteRuntime }) => {
    // The front task starts the finders when Frame lands (NEU-148 slice B), owned by the review,
    // under the start rule, and returns them: the stand-ins do so in their last commit.
    const withFinders = async (
      tx: Tx,
      runtime: { readonly taskId: TaskId; now(): number },
      input: FrontInput,
    ): Promise<FrontResult> => {
      const self = await tx.task(runtime.taskId);
      const now = runtime.now();
      const deadline = findDeadline(now, input.cutoffAt);
      const started =
        input.cutoffAt - VERIFY_RESERVE_MS - now >= MIN_FIND_WINDOW_MS;
      const finders: Array<{
        lens: FinderInput["lens"];
        task: TaskId<FinderResult>;
      }> = [];
      if (started && self?.owner !== undefined)
        for (const lens of FINDERS)
          finders.push({
            lens,
            task: await tx.createTask(
              batch,
              {
                lens,
                frameKey: "frame-key",
                manifestKey: "manifest-key",
                front: runtime.taskId,
                cutoffAt: input.cutoffAt,
                deadline,
              },
              { ownership: { kind: "task", taskId: self.owner } },
            ),
          });
      return {
        ...understood("frame.1"),
        finders: { start: now, deadline, started, finders },
      };
    };
    const agentUnderstand = defineTask<
      FrontInput,
      AgentCheckpoint,
      FrontResult
    >({
      name: "test.frame",
      version: 1,
      initial: () => ({ phase: "open" }),
      phases: {
        open: async (_task, runtime, context) => {
          await runtime.commit(async (tx) => {
            const conversation = await tx.createConversation({
              ownership: { kind: "task", taskId: runtime.taskId },
            });
            return {
              status: "running",
              checkpoint: { phase: "bind", conversationId: conversation.id },
            };
          }, context);
        },
        bind: async (task, runtime, context) => {
          const { conversationId } = task.state.checkpoint;
          const model = await routes.bindAgentRoute(
            {
              conversationId,
              stage: "frame",
              agent: "frame.1",
              route: SOL_ROUTE,
            },
            context,
          );
          await runtime.commit(async (tx) => {
            await configure(tx, conversationId, {
              model,
              thinkingLevel: "high",
            });
            return {
              status: "running",
              checkpoint: {
                phase: "submit",
                conversationId,
                request: `initial:${runtime.taskId}`,
                resume: false,
              },
            };
          }, context);
        },
        submit: async (task, runtime, context) => {
          const at = task.state.checkpoint;
          const handle = await runtime.conversation(at.conversationId, context);
          const submission = await handle!.submit(
            {
              type: "input",
              content: at.resume ? [] : TASK_TEXT,
              requestId: at.request,
            },
            context,
          );
          const settled = await submission.wait(context);
          if (holds(settled)) {
            // The provider's typed failure on the failed turn, read from pi's stored entries.
            const failure = await routeFailureOfSubmission(
              {
                entries: async (query, _limit, _cursor, context) => ({
                  items: (
                    await runtime.context(at.conversationId, context)
                  ).entries
                    .filter((entry) => entry.id >= (query.minEntryId ?? 0))
                    .reverse(),
                }),
              },
              settled,
              context,
            );
            return runtime.commit(async (tx) => {
              await enterHeld(tx, runtime.taskId, {
                conversationId: at.conversationId,
                settled,
                failure,
              });
              return {
                status: "running",
                checkpoint: {
                  phase: "held",
                  conversationId: at.conversationId,
                  failedSubmissionId: settled.id,
                },
              };
            }, context);
          }
          await runtime.commit(
            async (tx) => ({
              status: "terminal",
              outcome: {
                status: "completed",
                result: await withFinders(tx, runtime, task.input),
              },
            }),
            context,
          );
        },
        held: async (task, runtime, context) => {
          const at = task.state.checkpoint;
          const woken = await awaitResume(
            runtime,
            context,
            task.input.cutoffAt,
          );
          if (woken === "cutoff")
            return runtime.commit(async (tx) => {
              await leaveHeld(tx, runtime.taskId);
              return {
                status: "terminal",
                outcome: { status: "aborted", reason: "cutoff" },
              };
            }, context);
          await runtime.commit(async (tx) => {
            await leaveHeld(tx, runtime.taskId);
            return {
              status: "running",
              checkpoint: {
                phase: "submit",
                conversationId: at.conversationId,
                request: resumeSubmission(at.failedSubmissionId, woken.nonce)
                  .requestId,
                resume: true,
              },
            };
          }, context);
        },
      },
      abort: async (_task, runtime, context) => {
        await runtime.commit(async (tx) => {
          await leaveHeld(tx, runtime.taskId);
          return {
            status: "terminal",
            outcome: { status: "aborted", reason: "stopped" },
          };
        }, context);
      },
    });

    const plainUnderstand = defineTask<
      FrontInput,
      { phase: "run" },
      FrontResult
    >({
      name: "test.frame",
      version: 1,
      initial: () => ({ phase: "run" }),
      phases: {
        run: async (task, runtime, context) => {
          if (spec.frame === "never")
            await runtime.sleep(task.input.cutoffAt + 3_600_000, context);
          await runtime.commit(
            async (tx) => ({
              status: "terminal",
              outcome: {
                status: "completed",
                result: await withFinders(tx, runtime, task.input),
              },
            }),
            context,
          );
        },
      },
      abort: async (_task, runtime, context) => {
        await runtime.commit(
          () => ({
            status: "terminal",
            outcome: { status: "aborted", reason: "stopped" },
          }),
          context,
        );
      },
    });

    const behaviourOf = (id: string) =>
      spec.behaviours?.[id] ?? { kind: "complete" };
    const candidateOf = (
      lens: FinderInput["lens"],
      status: StageRecord["status"],
    ): FinderResult => ({
      lens,
      findKey: status === "computed" ? `found-${lens}` : null,
      findings: [],
      stages: [record("find", `find.${lens}`, status)],
      end: {
        find: status === "computed" ? "completed" : "cutoff",
        verify: "completed",
      },
    });
    const batch = defineTask<FinderInput, { phase: "run" }, FinderResult>({
      name: "test.batch",
      version: 1,
      initial: () => ({ phase: "run" }),
      phases: {
        run: async (task, runtime, context) => {
          const id = `b${FINDERS.indexOf(task.input.lens) + 1}`;
          const behaviour = behaviourOf(id);
          log.started.push(id);
          if (behaviour.kind === "fail")
            return runtime.commit(
              () => ({
                status: "terminal",
                outcome: {
                  status: "failed",
                  error: {
                    message: `batch ${id} failed`,
                    detail: { tag: "Broken", retryable: true },
                  },
                },
              }),
              context,
            );
          if (behaviour.kind === "never")
            await runtime.sleep(task.input.cutoffAt + 3_600_000, context);
          if (behaviour.kind === "complete" && behaviour.afterMs !== undefined)
            await runtime.sleep(runtime.now() + behaviour.afterMs, context);
          await runtime.commit(
            () => ({
              status: "terminal",
              outcome: {
                status: "completed",
                result: candidateOf(task.input.lens, "computed"),
              },
            }),
            context,
          );
        },
      },
      // A batch the run's cut-off stops keeps what it recorded, as the stage lane's batches do.
      abort: async (task, runtime, context) => {
        const behaviour = behaviourOf(
          `b${FINDERS.indexOf(task.input.lens) + 1}`,
        );
        await runtime.commit(
          () => ({
            status: "terminal",
            outcome:
              behaviour.kind === "never" && behaviour.partial
                ? {
                    status: "aborted",
                    reason: "cutoff",
                    result: candidateOf(task.input.lens, "interrupted"),
                  }
                : { status: "aborted", reason: "cutoff" },
          }),
          context,
        );
      },
    });

    const frame = spec.frame === "agent" ? agentUnderstand : plainUnderstand;
    const port: ReviewStagesPort = {
      front:
        spec.frame === "agent"
          ? childOf(agentUnderstand)
          : childOf(plainUnderstand),
      finder: childOf(batch),
      fill: async () => ({ record: record("link", "link.fill"), groups: [] }),
      link: async (input) => {
        log.plan++;
        return {
          record: record("link", "link"),
          candidates:
            input.finders.length === 0
              ? [
                  {
                    candidate: "coverage",
                    assembledKey: "coverage-filled",
                    disposed: [],
                  },
                ]
              : input.finders.map((f) => ({
                  candidate: f.lens,
                  assembledKey: `assembled-${f.lens}`,
                  disposed: [],
                })),
          changeMapKey: "change-map-key",
          disclosures: [],
        };
      },
      coverage: async () => ({
        record: record("precompute", "precompute.coverage"),
        ...(spec.missingPrecompute === "manifest"
          ? { facts: { key: "coverage-key", output: PRECOMPUTE } }
          : {}),
      }),
      precompute: async () => {
        log.precompute += 1;
        if (spec.missingPrecompute !== undefined)
          return { record: record("precompute", "precompute", "skipped") };
        return {
          record: record("precompute", "precompute"),
          facts: { key: "precompute-key", output: PRECOMPUTE },
        };
      },
      publish: async (input) => {
        log.published.push(input);
        return [record("publish", "publish")];
      },
    };
    const extension: Extension = defineExtension({
      name: "test.stages",
      tasks: [frame, batch],
    });
    return { port, extension };
  };

// One process's open of a run: fresh Models and registry over the run's database, as after restart.

type Opened = {
  readonly host: ReviewHost<{
    readonly mode: CloseMode;
    readonly tasks: number;
  }>;
  readonly storage: Storage;
  readonly exports: Array<{ readonly mode: CloseMode; readonly tasks: number }>;
};

const claim = (claimedAt: string): QueueClaim => ({
  jobSeq: 7,
  attempt: 1,
  claimedAt,
});

const open = async (
  path: string,
  options: {
    readonly claim: QueueClaim;
    readonly slots?: CallSlots;
    readonly stages: Stages;
    readonly log: Log;
    readonly cutoffAt?: number;
    readonly failExport?: boolean;
    readonly failStages?: boolean;
    readonly exports?: Opened["exports"];
    readonly storage?: Storage;
    readonly provider?: CreateRouteProvider;
    readonly settings?: HarnessSettings;
    readonly runLog?: RunLog;
    readonly cutoffGraceMs?: number;
    readonly onReport?: (error: unknown) => void;
  },
): Promise<Opened> => {
  const ownership = SourceOwnership.acquire(path);
  const storage = options.storage ?? (await openNodeSqliteStorage(path));
  const exports: Opened["exports"] = options.exports ?? [];
  const host = await openReviewHost(
    {
      storage,
      ownership,
      log: options.runLog,
      models: createModels(),
      createRouteProvider: options.provider ?? fixtureProvider,
      slots:
        options.slots ??
        callSlots(8, (effect, signal) =>
          Effect.runPromise(
            effect,
            signal === undefined ? undefined : { signal },
          ),
        ),
      ...(options.settings === undefined ? {} : { settings: options.settings }),
      registry: createRegistry(),
      run: {
        runId: "run-1",
        runKey: "run-key",
        generation: 1,
        cycleId: "cycle-1",
        range: {
          baseRef: "main",
          baseOid: "a".repeat(40),
          headOid: "b".repeat(40),
        },
        config: {} as never,
        cutoffAt: options.cutoffAt ?? Date.now() + 3_600_000,
      },
      claim: options.claim,
      stages: (input) => {
        if (options.failStages === true)
          throw new Error("the stages could not be built");
        return stagesOf(options.stages, options.log)(input);
      },
      onClose: async ({ mode, reads, context }) => {
        if (options.failExport === true)
          throw new Error("the capture store refused the dump");
        const page = await reads.scanTasks({}, 1_000, undefined, context);
        const exported = { mode, tasks: page.items.length };
        exports.push(exported);
        return exported;
      },
      cutoffGraceMs: options.cutoffGraceMs ?? 50,
      onReport: options.onReport,
    },
    context,
  ).finally(() => ownership.release());
  return { host, storage, exports };
};

const within = <T>(promise: Promise<T>, ms: number): Promise<T | "timeout"> =>
  Promise.race([
    promise,
    new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), ms),
    ),
  ]);

test("the host runs front and four finders, then links and publishes in lens order", async () => {
  const log = newLog();
  const run = await open(database(), {
    claim: claim("t1"),
    log,
    stages: { behaviours: { b1: { kind: "complete", afterMs: 80 } } },
  });
  const end = await run.host.ended(context);
  await run.host.close("ended", context);
  expect(end.kind === "settled" && end.task.state.outcome.status).toBe(
    "completed",
  );
  expect(log.started.sort()).toEqual(["b1", "b2", "b3", "b4"]);
  expect(log.published[0]!.candidates.map((c) => c.candidate)).toEqual([
    ...FINDERS,
  ]);
  expect(log.plan).toBe(1);
  expect(run.exports).toEqual([{ mode: "ended", tasks: 6 }]);
});

test("a later claim continues the run's review and a repeated claim joins it; neither runs a stage twice", async () => {
  const path = database();
  const log = newLog();
  const first = await open(path, { claim: claim("t1"), log, stages: {} });
  await first.host.ended(context);
  await first.host.close("ended", context);

  const same = await open(path, { claim: claim("t1"), log, stages: {} });
  const sameEnd = await same.host.ended(context);
  await same.host.close("ended", context);
  const later = await open(path, { claim: claim("t2"), log, stages: {} });
  const laterEnd = await later.host.ended(context);
  await later.host.close("ended", context);

  expect([
    first.host.admission.admitted,
    same.host.admission.admitted,
    later.host.admission.admitted,
  ]).toEqual(["created", "joined", "continued"]);
  expect(same.host.admission.taskId).toBe(first.host.admission.taskId);
  expect(later.host.admission.taskId).toBe(first.host.admission.taskId);
  expect([sameEnd.kind, laterEnd.kind]).toEqual(["settled", "settled"]);
  expect({
    precompute: log.precompute,
    plan: log.plan,
    published: log.published.length,
  }).toEqual({
    precompute: 1,
    plan: 1,
    published: 1,
  });
});

test("a failed batch fails the review without publishing; the queue's retry admits a new review and keeps the old", async () => {
  const path = database();
  const log = newLog();
  const failing = await open(path, {
    claim: claim("t1"),
    log,
    stages: { behaviours: { b1: { kind: "fail" } } },
  });
  const failed = await failing.host.ended(context);
  await failing.host.close("interrupted", context);

  const retry = await open(path, {
    claim: { jobSeq: 7, attempt: 2, claimedAt: "t2" },
    log,
    stages: {},
  });
  const retried = await retry.host.ended(context);
  const old = await retry.host.harness.getTask(
    failing.host.admission.taskId,
    context,
  );
  await retry.host.close("ended", context);

  expect(failed.kind === "settled" && failed.task.state.outcome).toEqual({
    status: "failed",
    error: {
      message: "batch b1 failed",
      detail: { tag: "Broken", retryable: true },
    },
  });
  expect(retry.host.admission.admitted).toBe("created");
  expect(retry.host.admission.taskId).not.toBe(failing.host.admission.taskId);
  expect(old?.state.status === "terminal" && old.state.outcome.status).toBe(
    "failed",
  );
  expect(retried.kind === "settled" && retried.task.state.outcome.status).toBe(
    "completed",
  );
  expect(log.published.length).toBe(1);
});

test("past the cut-off the host interrupts front and still lets publication settle", async () => {
  const log = newLog();
  const run = await open(database(), {
    claim: claim("cutoff"),
    log,
    cutoffAt: Date.now() + 300,
    stages: { frame: "never" },
  });
  const end = await within(run.host.ended(context), 10_000);
  await run.host.close("ended", context);
  expect(
    end !== "timeout" &&
      end.kind === "settled" &&
      end.task.state.outcome.status,
  ).toBe("completed");
  expect(log.started).toEqual([]);
  expect(log.published).toHaveLength(1);
  expect(log.published[0]!.candidates).toEqual([]);
});

test("a stop aborts the review and its stage work, and nothing is published", async () => {
  const log = newLog();
  const run = await open(database(), {
    claim: claim("t1"),
    log,
    stages: { frame: "never" },
  });
  await within(new Promise((resolve) => setTimeout(resolve, 100)), 200);
  const stopped = await run.host.stop(context, 5_000);
  const children = await run.host.harness.inspect(context);
  await run.host.close("ended", context);

  expect(stopped?.state.outcome).toEqual({
    status: "aborted",
    reason: "stopped",
    result: {
      stages: [
        record("precompute", "precompute.coverage"),
        record("precompute", "precompute"),
      ],
    },
  });
  expect(children.tasks.length).toBe(0);
  expect(log.published).toEqual([]);
});

test("the stop bound includes an invocation that ignores cancellation and keeps its abort mark", async () => {
  let release = () => {};
  let started = () => {};
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let exports = 0;
  const path = database();
  const ownership = SourceOwnership.acquire(path);
  const storage = await openNodeSqliteStorage(path);
  const host = await openReviewHost(
    {
      storage,
      ownership,
      models: createModels(),
      registry: createRegistry(),
      createRouteProvider: fixtureProvider,
      slots: { acquire: async () => () => {} },
      claim: claim("uncooperative"),
      run: {
        runId: "stop-bound",
        runKey: "key",
        generation: 1,
        cycleId: "cycle",
        range: {
          baseRef: "main",
          baseOid: "a".repeat(40),
          headOid: "b".repeat(40),
        },
        config: {} as never,
        cutoffAt: Date.now() + 60_000,
      },
      stages: () => ({
        extension: defineExtension({ name: "stop-bound" }),
        port: {
          precompute: async () => {
            started();
            await gate;
            return { record: record("precompute", "precompute") };
          },
          link: async () => {
            throw new Error("unused");
          },
          front: async () => {
            throw new Error("unused");
          },
          finder: async () => {
            throw new Error("unused");
          },
          fill: async () => {
            throw new Error("unused");
          },
          publish: async () => [],
        },
      }),
      onClose: async () => {
        exports++;
        return "closed";
      },
    },
    context,
  ).finally(() => ownership.release());
  await running;
  try {
    expect(await within(host.stop(context, 20), 200)).toBeUndefined();
    const pending = await host.harness.getTask(host.admission.taskId, context);
    expect(pending?.abortRequested).toBe(true);
    expect(pending?.state.status).not.toBe("terminal");
    expect(
      await within(
        host.cleanup({ mode: "ended", stop: true, withinMs: 20 }, context),
        200,
      ),
    ).toMatchObject({ kind: "pending", phase: "stopping" });
    expect(
      await host.cleanup({ mode: "ended", stop: true, withinMs: 20 }, context),
    ).toMatchObject({ kind: "pending", phase: "stopping" });
    expect(exports).toBe(0);
    expect(
      (await storage.scanTasks({}, 100, undefined, context)).items.some(
        (task) => task.abortRequested && task.state.status !== "terminal",
      ),
    ).toBe(true);
  } finally {
    release();
    for (let n = 0; n < 100 && exports === 0; n++) await Bun.sleep(5);
    expect(exports).toBe(1);
  }
});

test("a provider failure holds the step across close; the same claim never wakes it, the next resumes its own conversation once", async () => {
  const path = database();
  const log = newLog();
  requests.length = 0;
  answers.push("unauthorized");

  const first = await open(path, {
    claim: claim("t1"),
    log,
    stages: { frame: "agent" },
  });
  const held = await first.host.ended(context);
  await first.host.close("held", context);
  const storageClosed = await first.storage
    .scanTasks({}, 1, undefined, context)
    .then(
      () => "open",
      () => "closed",
    );

  expect(first.host.resume).toBe("none");
  expect(held.kind).toBe("held");
  if (held.kind !== "held") return;
  expect(
    held.steps.map((step) => ({
      reason: step.reason,
      auth: step.detail?.includes("401") ?? false,
    })),
  ).toEqual([{ reason: "model_error", auth: true }]);
  expect(first.exports.map((entry) => entry.mode)).toEqual(["held"]);
  expect(storageClosed).toBe("closed");
  expect(requests.length).toBe(1);

  // The same claim again (a repeated handler call): it joins, and the step stays held.
  const again = await open(path, {
    claim: claim("t1"),
    log,
    stages: { frame: "agent" },
  });
  const stillHeld = await again.host.ended(context);
  const step = await again.host.harness.getTask(held.steps[0]!.taskId, context);
  await again.host.close("held", context);

  expect([
    again.host.admission.admitted,
    again.host.resume,
    stillHeld.kind,
  ]).toEqual(["joined", "joined", "held"]);
  expect(step?.state.status !== "terminal" && step?.state.checkpoint).toEqual({
    phase: "held",
    conversationId: held.steps[0]!.conversationId,
    failedSubmissionId: held.steps[0]!.failedSubmissionId,
  });
  expect(requests.length).toBe(1);

  // The next claim wakes it: the same conversation sends the same request again, once.
  answers.push("final");
  const next = await open(path, {
    claim: claim("t2"),
    log,
    stages: { frame: "agent" },
  });
  const done = await next.host.ended(context);
  const submissions = await next.storage.scanSubmissions(
    { conversationId: held.steps[0]!.conversationId },
    10,
    undefined,
    context,
  );
  await next.host.close("ended", context);

  expect([next.host.admission.admitted, next.host.resume]).toEqual([
    "continued",
    "committed",
  ]);
  expect(done.kind === "settled" && done.task.state.outcome.status).toBe(
    "completed",
  );
  expect(requests.length).toBe(2);
  expect(requests[1]!.input).toEqual(requests[0]!.input);
  const resumeRequest = `resume:${held.steps[0]!.failedSubmissionId}:job:7:attempt:1:claim:t2`;
  expect(
    submissions.items.map((submission) => [
      submission.requestId,
      submission.status,
    ]),
  ).toEqual([
    [`initial:${held.steps[0]!.taskId}`, "unanswered"],
    [resumeRequest, "done"],
  ]);
  expect(log.published.length).toBe(1);

  // That claim repeated: nothing runs and nothing is sent again.
  const repeated = await open(path, {
    claim: claim("t2"),
    log,
    stages: { frame: "agent" },
  });
  const settledAgain = await repeated.host.ended(context);
  await repeated.host.close("ended", context);
  expect([
    repeated.host.admission.admitted,
    repeated.host.resume,
    settledAgain.kind,
  ]).toEqual(["joined", "joined", "settled"]);
  expect(requests.length).toBe(2);
});

test("a close whose export fails still closes the database and fails, so the run folder is kept", async () => {
  const log = newLog();
  let flushes = 0;
  const run = await open(database(), {
    claim: claim("t1"),
    log,
    stages: {},
    failExport: true,
    runLog: {
      path: "synthetic",
      write: () => {},
      enqueue: () => {},
      read: () => [],
      flush: async () => {
        flushes++;
      },
    },
  });
  await run.host.ended(context);
  const closed = await run.host.close("ended", context).then(
    () => undefined,
    (error: unknown) => error,
  );
  const storageClosed = await run.storage
    .scanTasks({}, 1, undefined, context)
    .then(
      () => "open",
      () => "closed",
    );

  expect(closed).toBeInstanceOf(StorageCloseFailed);
  expect(
    closed instanceof StorageCloseFailed && [closed.mode, closed.message],
  ).toEqual([
    "ended",
    "export failed: capture close failed (private details suppressed)",
  ]);
  expect(storageClosed).toBe("closed");
  expect(flushes).toBe(1);
});

test("an open that fails closes through the export barrier, and a failed close is reported with the open's error", async () => {
  const log = newLog();
  const exported: Opened["exports"] = [];
  const cleanStorage = await openNodeSqliteStorage(database());
  const clean = await open(join(directory, "profile", "runs", "clean"), {
    claim: claim("t1"),
    log,
    stages: {},
    failStages: true,
    exports: exported,
    storage: cleanStorage,
  }).then(
    () => undefined,
    (error: unknown) => error,
  );
  const cleanClosed = await cleanStorage
    .scanTasks({}, 1, undefined, context)
    .then(
      () => "open",
      () => "closed",
    );

  const failingStorage = await openNodeSqliteStorage(database());
  const failing = await open(join(directory, "profile", "runs", "failing"), {
    claim: claim("t1"),
    log,
    stages: {},
    failStages: true,
    failExport: true,
    storage: failingStorage,
  }).then(
    () => undefined,
    (error: unknown) => error,
  );
  const failingClosed = await failingStorage
    .scanTasks({}, 1, undefined, context)
    .then(
      () => "open",
      () => "closed",
    );

  expect(clean instanceof Error && clean.message).toBe(
    "the stages could not be built",
  );
  expect(exported).toEqual([{ mode: "interrupted", tasks: 0 }]);
  expect(cleanClosed).toBe("closed");
  expect(failing).toBeInstanceOf(HostOpenFailed);
  expect(failing instanceof HostOpenFailed && failing.message).toBe(
    "the stages could not be built; closing it failed too: export failed: capture close failed (private details suppressed)",
  );
  expect(failingClosed).toBe("closed");
});

// The route's own provider, as production registers it, against the local server: a token command
// leases a fixture token, and every request goes to the local server instead of the real host.
const token = (() => {
  const path = join(directory, "token");
  writeFileSync(
    path,
    `#!/bin/sh\nprintf '{"access_token":"fixture-token","expires_at":%s}' ${Date.now() + 3_600_000}\n`,
  );
  chmodSync(path, 0o700);
  return path;
})();
const routeProvider =
  (captured: Array<ModelCaptureEvent>, log?: RunLog): CreateRouteProvider =>
  (binding, readBinding) =>
    createAgentRouteProvider({
      credentialInspection: "ephemeral" as const,
      route: SOL_ROUTE,
      auth: { tokenCommand: token },
      log,
      fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        );
        return fetch(new URL(`${url.pathname}${url.search}`, ORIGIN), init);
      }) as typeof fetch,
      capture: (event) => captured.push(event),
      logicalProvider: binding.logicalProvider,
      readBinding,
    });

test.each([
  {
    refusal: { status: 401, code: "invalid_token" },
    failure: { kind: "auth", status: 401, code: "invalid_token" },
    policy: { tag: "AuthenticationError", retryable: false },
  },
  {
    refusal: { status: 403, code: "forbidden" },
    failure: { kind: "auth", status: 403, code: "forbidden" },
    policy: { tag: "AuthenticationError", retryable: false },
  },
  {
    refusal: { status: 429, code: "subscription_sharing_usage_limit_exceeded" },
    failure: {
      kind: "plan_quota",
      status: 429,
      code: "subscription_sharing_usage_limit_exceeded",
    },
    policy: { tag: "QuotaExhaustedError", retryable: false },
  },
])(
  "a held step keeps the route's typed failure ($refusal.status $refusal.code) across close and reopen",
  async ({ refusal, failure, policy }) => {
    const path = database();
    const log = newLog();
    const captured: Array<ModelCaptureEvent> = [];
    requests.length = 0;
    // pi's own retries stay on, with short delays: a refusal pi retries would show as extra requests.
    answers.push(refusal, refusal, refusal, refusal);
    const settings = {
      ...REVIEW_SETTINGS,
      retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 },
    };

    const first = await open(path, {
      claim: claim("t1"),
      log,
      stages: { frame: "agent" },
      provider: routeProvider(captured),
      settings,
    });
    const held = await first.host.ended(context);
    await first.host.close("held", context);
    const again = await open(path, {
      claim: claim("t1"),
      log,
      stages: { frame: "agent" },
      provider: routeProvider(captured),
      settings,
    });
    const reopened = await again.host.ended(context);
    await again.host.close("held", context);
    answers.length = 0;

    expect(
      held.kind === "held" && held.steps.map((step) => step.failure),
    ).toEqual([failure]);
    expect(
      reopened.kind === "held" && reopened.steps.map((step) => step.failure),
    ).toEqual([failure]);
    expect(reopened.kind === "held" && heldFailure(reopened.steps)).toEqual(
      policy,
    );
    expect(requests.length).toBe(1);
    expect(
      captured.filter((event) => event.type === "model.request").length,
    ).toBe(1);
  },
);

test("a held step whose failed turn recorded no route failure is disclosed as unclassified, never as auth", async () => {
  const path = database();
  const log = newLog();
  answers.push("unauthorized");
  const run = await open(path, {
    claim: claim("t1"),
    log,
    stages: { frame: "agent" },
  });
  const held = await run.host.ended(context);
  await run.host.close("held", context);
  answers.length = 0;

  expect(
    held.kind === "held" && held.steps.map((step) => step.failure),
  ).toEqual([null]);
  expect(held.kind === "held" && heldFailure(held.steps)).toEqual({
    tag: "ModelError",
    retryable: true,
    unclassified:
      "the failed turn recorded no route failure, so its kind is unknown",
  });
});

test("the attempt's measurements are read from the capture journal the route's own provider wrote", async () => {
  const path = database();
  const log = newLog();
  const journalFolder = join(directory, "journal-measured");
  const journal = openCaptureJournal(journalFolder, "run-1");
  requests.length = 0;
  answers.push({ status: 401, code: "invalid_token" });
  const fromJournal: CreateRouteProvider = (binding, readBinding) =>
    createAgentRouteProvider({
      credentialInspection: "ephemeral" as const,
      route: SOL_ROUTE,
      auth: { tokenCommand: token },
      fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        );
        return fetch(new URL(`${url.pathname}${url.search}`, ORIGIN), init);
      }) as typeof fetch,
      capture: journal.capture,
      logicalProvider: binding.logicalProvider,
      readBinding,
    });
  const first = await open(path, {
    claim: claim("t1"),
    log,
    stages: { frame: "agent" },
    provider: fromJournal,
  });
  await first.host.ended(context);
  await first.host.close("held", context);
  answers.push("final");
  const next = await open(path, {
    claim: claim("t2"),
    log,
    stages: { frame: "agent" },
    provider: fromJournal,
  });
  await next.host.ended(context);
  await next.host.close("ended", context);
  journal.close();

  const written: Array<RunLogRecord> = [];
  writeNativeMeasurements(
    { path: "", write: (entry) => written.push(entry), read: () => written },
    journalFolder,
    "medium",
    { kind: "ready", claim: claim("t1"), journalAfterSeq: 0, logFromIndex: 0 },
  );
  const byName = new Map(written.map((entry) => [entry["name"], entry]));

  expect(requests.length).toBe(2);
  const { headerNames, ...strict } = byName.get("strict-flag") ?? {
    type: "missing",
  };
  expect(strict).toEqual({
    type: "measurement",
    name: "strict-flag",
    requests: 2,
    strictValues: [],
    statuses: [401, 200],
    keywordsSent: [],
  });
  expect(headerNames).toContain("authorization");
  expect(byName.get("thinking-and-append-only")).toEqual({
    type: "measurement",
    name: "thinking-and-append-only",
    agents: [
      {
        agent: "frame.1",
        messageCounts: [1, 1],
        appendOnly: false,
        signedThinkingReplayed: false,
        thinkingBeforeToolUse: false,
        responseBlockTypes: [[], ["message"]],
        // The refused call has an error; its wording is the provider's, not asserted here.
        errors: [expect.any(String)],
      },
    ],
  });
  expect(byName.get("turn-latency")?.["turns"]).toBe(2);
});

// Reason: a briefing's calls are bound as Verify, so their route telemetry would count as Verify.
test("a briefing's route calls write the brief stage on their telemetry; its binding and other readings stay verify", async () => {
  const rows: Array<RunLogRecord> = [];
  const runLog: RunLog = {
    path: "(memory)",
    write: (row) => {
      rows.push(row);
    },
    read: () => rows,
  };
  const run = await open(database(), {
    claim: claim("brief-telemetry"),
    stages: {},
    log: newLog(),
    provider: routeProvider([], runLog),
  });
  try {
    await run.host.ended(context);
    answers.length = 0;
    const readings = [
      { agent: "brief.1", reading: { kind: "brief", rank: 1 } },
      { agent: "assess.1", reading: { kind: "assess", rank: 1 } },
      { agent: "verify.1", reading: undefined },
    ] as const;
    answers.push(...readings.map(() => "final" as const));
    const stored: Array<string> = [];
    for (const { agent, reading } of readings) {
      const conversation = await run.host.harness.createConversation(
        { ownership: { kind: "ownerless" } },
        context,
      );
      const model = await run.host.routes.bindAgentRoute(
        {
          conversationId: conversation.id,
          stage: "verify",
          agent,
          route: SOL_ROUTE,
          reading,
        },
        context,
      );
      await conversation.configure({ model }, context);
      const submission = await conversation.submit(
        { type: "input", content: "Read it.", requestId: agent },
        context,
      );
      expect((await submission.wait(context)).status).toBe("done");
      stored.push(
        (await run.host.routes.readBinding(conversation.id, context)).stage,
      );
    }
    await Bun.sleep(5);
    const stagesOf = (agent: string, type: string) => [
      ...new Set(
        rows
          .filter((row) => row.type === type && row["agent"] === agent)
          .map((row) => row["stage"]),
      ),
    ];
    for (const type of [
      "model.call.start",
      "model.call.progress",
      "model.call",
    ])
      expect(readings.map(({ agent }) => stagesOf(agent, type))).toEqual([
        ["brief"],
        ["verify"],
        ["verify"],
      ]);
    expect(stored).toEqual(["verify", "verify", "verify"]);
  } finally {
    await run.host.close("ended", context);
  }
}, 30000);

// A claim alone must not authorize recovery of a terminal refusal committed before a worker crash.
test.each([
  { status: 401, code: "invalid_token" },
  { status: 429, code: "subscription_sharing_usage_limit_exceeded" },
])(
  "a crash before classifying terminal HTTP $status preserves the hold on new claims",
  async (refusal) => {
    const path = database();
    const log = newLog();
    const captured: Array<ModelCaptureEvent> = [];
    requests.length = 0;
    answers.length = 0;
    answers.push(refusal);
    const first = await open(path, {
      claim: claim("crashed"),
      log,
      stages: { frame: "agent" },
      provider: routeProvider(captured),
    });
    const held = await first.host.ended(context);
    expect(held.kind).toBe("held");
    await first.host.close("interrupted", context);
    answers.push("final");
    for (const claimedAt of ["reclaimed", "reclaimed", "later"]) {
      const next = await open(path, {
        claim: claim(claimedAt),
        log,
        stages: { frame: "agent" },
        provider: routeProvider(captured),
      });
      expect(next.host.resume).toBe("blocked");
      expect((await next.host.ended(context)).kind).toBe("held");
      await next.host.close("interrupted", context);
    }
    expect(requests).toHaveLength(1);
    expect(log.published).toHaveLength(0);
    answers.length = 0;
  },
);

test("an undefined cleanup rejection remains visible beside a host startup failure", async () => {
  const original = Harness.open;
  let closes = 0;
  const opening = spyOn(Harness, "open").mockImplementation(async (...args) => {
    const harness = await original(...args);
    const close = harness.close.bind(harness);
    harness.close = async (context) => {
      closes++;
      await close(context);
      throw undefined;
    };
    return harness;
  });
  try {
    const error = await open(database(), {
      claim: claim("undefined-cleanup"),
      log: newLog(),
      stages: {},
      failStages: true,
    }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(HostOpenFailed);
    if (error instanceof HostOpenFailed) {
      expect(error.cause).toBeInstanceOf(Error);
      if (error.cause instanceof Error)
        expect(error.cause.message).toBe("the stages could not be built");
      expect(Object.hasOwn(error, "closeError")).toBe(true);
      expect(error.closeError).toBeUndefined();
    }
    expect(closes).toBe(1);
  } finally {
    opening.mockRestore();
  }
});

// Production observation must use enqueue rather than calling a sink from a pi listener.
test("task commit observations never invoke the synchronous log sink", async () => {
  const observations: RunLogRecord[] = [];
  let writes = 0;
  let flushes = 0;
  const run = await open(database(), {
    claim: claim("observer"),
    stages: {},
    log: newLog(),
    runLog: {
      path: "synthetic",
      flush: async () => {
        flushes++;
      },
      read: () => observations,
      write: (record) => {
        if (record.type === "pi.task") {
          writes++;
          throw new Error("synchronous observer invoked");
        }
        observations.push(record);
      },
      enqueue: (record) => {
        observations.push(record);
      },
    },
  });
  const end = await within(run.host.ended(context), 10000);
  await run.host.close("ended", context);
  expect(
    end !== "timeout" &&
      end.kind === "settled" &&
      end.task.state.outcome.status,
  ).toBe("completed");
  expect(observations.some((record) => record.type === "pi.task")).toBeTrue();
  expect(writes).toBe(0);
  expect(flushes).toBe(1);
});

test("resume after the cut-off preserves one marker at the original boundary", async () => {
  const records: RunLogRecord[] = [];
  const log: RunLog = {
    path: "synthetic",
    write: (record) => records.push(record),
    enqueue: (record) => records.push(record),
    read: () => records,
  };
  const path = database();
  const cutoffAt = Date.now() + 150;
  const options = {
    stages: { frame: "never" as const },
    log: newLog(),
    runLog: log,
    cutoffAt,
    cutoffGraceMs: 100000,
  };
  const first = await open(path, { ...options, claim: claim("marker-first") });
  for (
    let i = 0;
    i < 200 &&
    !records.some(
      (row) => row.type === "cutoff" && row["point"] === "stop-new-work",
    );
    i++
  )
    await Bun.sleep(5);
  expect(
    records.filter(
      (row) => row.type === "cutoff" && row["point"] === "stop-new-work",
    ),
  ).toHaveLength(1);
  expect(
    (await first.host.harness.getTask(first.host.admission.taskId, context))
      ?.state.status,
  ).not.toBe("terminal");
  await first.host.close("interrupted", context);
  const second = await open(path, {
    ...options,
    claim: claim("marker-resume"),
  });
  await Bun.sleep(50);
  await second.host.harness.commit(() => undefined, context);
  await second.host.close("interrupted", context);
  const markers = records.filter(
    (row) => row.type === "cutoff" && row["point"] === "stop-new-work",
  );
  expect(markers).toHaveLength(1);
  expect(markers[0]?.at).toBe(new Date(cutoffAt).toISOString());
});

// Reproduce the crash window after the durable flag commits but before the marker survives.
test("resume recovers a committed cut-off flag with a missing marker", async () => {
  const records: RunLogRecord[] = [];
  let dropped = false;
  const log: RunLog = {
    path: "synthetic",
    write: (record) => records.push(record),
    read: () => records,
    enqueue: (record) => {
      if (
        record.type === "cutoff" &&
        record["point"] === "stop-new-work" &&
        !dropped
      ) {
        dropped = true;
        return;
      }
      records.push(record);
    },
  };
  const path = database();
  const cutoffAt = Date.now() + 50;
  const options = {
    stages: { frame: "never" as const },
    log: newLog(),
    runLog: log,
    cutoffAt,
    cutoffGraceMs: 100000,
  };
  const first = await open(path, {
    ...options,
    claim: claim("lost-marker-first"),
  });
  for (let i = 0; i < 200 && !dropped; i++) await Bun.sleep(5);
  expect(dropped).toBeTrue();
  await first.host.close("interrupted", context);
  const second = await open(path, {
    ...options,
    claim: claim("lost-marker-resume"),
  });
  await Bun.sleep(30);
  await second.host.close("interrupted", context);
  const markers = records.filter(
    (record) => record.type === "cutoff" && record["point"] === "stop-new-work",
  );
  expect(markers).toHaveLength(1);
  expect(markers[0]?.at).toBe(new Date(cutoffAt).toISOString());
});

// Why: every stopped run must reach Publish, with coverage when it was bound and a gap otherwise.
test.each(["manifest", "all"] as const)(
  "missing Precompute facts with %s coverage still reaches Publish",
  async (missingPrecompute) => {
    const log = newLog();
    const run = await open(database(), {
      claim: claim("missing-" + missingPrecompute),
      log,
      stages: { missingPrecompute },
      cutoffAt: Date.now() + 60_000,
    });
    const end = await within(run.host.ended(context), 5_000);
    await run.host.close("ended", context);
    expect(
      end !== "timeout" &&
        end.kind === "settled" &&
        end.task.state.outcome.status,
    ).toBe("completed");
    expect(log.published).toHaveLength(1);
    if (missingPrecompute === "manifest") {
      expect(log.published[0]?.candidates).toHaveLength(1);
      expect(log.published[0]?.sources.manifest).toBe("manifest-key");
      expect(
        log.published[0]?.disclosures.some((gap) => gap.kind === "precompute"),
      ).toBe(true);
    } else {
      expect(log.published[0]?.sources.manifest).toBeNull();
      expect(log.published[0]?.reason).toContain("manifest");
    }
  },
  15_000,
);

// Why: bulk output and cached native batches must survive collection in change-map order.
// A cut-off report writes a control record in production, and that sink can also fail.
test("cutoff timer failures contain a throwing report sink", async () => {
  const records: RunLogRecord[] = [];
  let reports = 0;
  const run = await open(database(), {
    claim: claim("throwing-report"),
    stages: { behaviours: { b1: { kind: "never", partial: false } } },
    log: newLog(),
    cutoffAt: Date.now() + 100,
    runLog: {
      path: "synthetic",
      write: (record) => records.push(record),
      enqueue: (record) => records.push(record),
      read: () => records,
    },
    onReport: () => {
      reports++;
      throw new Error("Control log refused report");
    },
  });
  const broken = spyOn(run.host.harness, "commit").mockRejectedValue(
    new Error("Timer commit failed"),
  );
  try {
    for (let i = 0; i < 100 && reports < 2; i++) await Bun.sleep(5);
    expect(reports).toBe(2);
    expect(
      records.filter(
        (record) =>
          record.type === "telemetry.loss" &&
          record["operation"] === "cutoff-report",
      ),
    ).toHaveLength(2);
  } finally {
    broken.mockRestore();
    await run.host.close("interrupted", context);
  }
});

import {
  Scheduler,
  type Request as BudgetRequest,
} from "../src/budget/scheduler.ts";

test("openReviewHost admits provider calls using each real route stage and its next transcript turn", async () => {
  const budget = new Scheduler(4, 4, 4);
  const admitted: BudgetRequest[] = [];
  const admit = budget.admit.bind(budget);
  budget.admit = (request, signal) => {
    admitted.push(request);
    return admit(request, signal);
  };
  const run = await open(database(), {
    claim: claim("priority"),
    stages: {},
    log: newLog(),
    slots: callSlots(4, (work, signal) => Effect.runPromise(work, { signal }), {
      budget,
      account: "a".repeat(64),
      owner: "priority-run",
      priority: () => ({ class: "interactive", position: "new", stage: 0 }),
    }),
  });
  try {
    await run.host.ended(context);
    answers.length = 0;
    answers.push(...Array.from({ length: 8 }, () => "final" as const));
    for (const stage of ["frame", "find", "map", "verify"] as const) {
      const conversation = await run.host.harness.createConversation(
        { ownership: { kind: "ownerless" } },
        context,
      );
      const model = await run.host.routes.bindAgentRoute(
        {
          conversationId: conversation.id,
          stage,
          agent: `${stage}.priority`,
          route: SOL_ROUTE,
        },
        context,
      );
      await conversation.configure({ model }, context);
      for (const turn of [1, 2]) {
        const submission = await conversation.submit(
          {
            type: "input",
            content: `turn ${turn}`,
            requestId: `${stage}-${turn}`,
          },
          context,
        );
        const end = await submission.wait(context);
        expect(end.status).toBe("done");
      }
    }
    expect(admitted.map((request) => request.priority)).toEqual([
      { class: "interactive", position: "understand", stage: 10 },
      { class: "interactive", position: "understand", stage: 10 },
      { class: "interactive", position: "new", stage: 30 },
      { class: "interactive", position: "continuation", stage: 30 },
      { class: "interactive", position: "understand", stage: 20 },
      { class: "interactive", position: "understand", stage: 20 },
      { class: "interactive", position: "started", stage: 90 },
      { class: "interactive", position: "continuation", stage: 90 },
    ]);
    expect((await budget.observe()).providerHeld).toBe(0);
  } finally {
    await run.host.close("ended", context);
  }
}, 30000);
