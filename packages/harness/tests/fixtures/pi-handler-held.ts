import { scanCaptures } from "../pi/capture/fixture.ts";
// The handler-level held scenario, run by tests/pi-handler.test.ts in its own process so that its
// HOME (settings, integrations, sign-in) is a scratch folder: Bun reads the home folder once at
// start. It drives the real `review.run` handler over a real Records store, git repository, native
// pi storage, the front and finder tasks, the route's own provider and capture, against a local OpenAI Responses
// endpoint. The route's credential is a token command; removing it mid-run is the credential lost.
// It prints one JSON object of observations; the test asserts on them.
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { z } from "zod";
import { createSession } from "@earendil-works/pi-durable";
import { RunControlDoc } from "../../src/pi/control.ts";
import { mock } from "bun:test";
import { reviewStages } from "../../src/pi/stages/index.ts";
import { Cause, Duration, Effect, Exit, Fiber, Layer, Option } from "effect";
import {
  Blobs,
  Computations,
  JobQueue,
  JOB_POLICIES,
  Log,
  Store,
  Worker,
  storeLocationIn,
} from "@neuve/records-core";
import { reviewRunHandler } from "../../src/handler.ts";
import { readCapturedDump } from "../../src/pi/capture/export.ts";
import { requestReview } from "../../src/request.ts";
import { SOL_ROUTE, OPUS_ROUTE } from "../../src/route.ts";
import { openRunLog } from "../../src/run-log.ts";
import { piDatabase, runFolder } from "../../src/run-folder.ts";
import { openReviewHost, REVIEW_SETTINGS } from "../../src/pi/host.ts";
import { exportOnClose } from "../../src/run-folder.ts";
import { SourceOwned, SourceOwnership } from "../../src/pi/source-ownership.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const root = process.env["SCENARIO_ROOT"];
if (root === undefined) throw new Error("SCENARIO_ROOT is not set");
const requestedPolicy = process.env["SCENARIO_POLICY"];
const policy = requestedPolicy === "aged-retry" ? "retry" : requestedPolicy;
let requestedStopCause: string | null = null;
let deadlinePendingTask: boolean | null = null;
let release = () => {};
let exportStarted = false;
let exportSettled = false;
let stalledMs = 0;
// The policy cases test which failures the handler retries, counts and stops on, not how long its
// backoff is. They keep the review's retry policy (four attempts, each wait doubling, jittered)
// with a 50 ms base instead of 2 s, so held-final's three waits take about 0.35 s of wall clock
// instead of about 14 s. Each retry is still scheduled and admitted by the native retry admission.
const policySettings =
  policy === undefined
    ? undefined
    : {
        ...REVIEW_SETTINGS,
        retry: { ...REVIEW_SETTINGS.retry, baseDelayMs: 50 },
      };
if (!policy?.startsWith("close-")) {
  const originalHost = openReviewHost;
  mock.module("../../src/pi/host.ts", () => ({
    openReviewHost: async (...args: Parameters<typeof openReviewHost>) => {
      const host = await originalHost(
        policySettings === undefined
          ? args[0]
          : { ...args[0], settings: policySettings },
        args[1],
      );
      return {
        ...host,
        cleanup: async (
          input: Parameters<typeof host.cleanup>[0],
          context: Parameters<typeof host.cleanup>[1],
        ) => {
          if (input.stop) requestedStopCause = input.stopCause ?? null;
          const cleanup = await host.cleanup(input, context);
          if (policy === "deadline" && input.stopCause === "deadline") {
            try {
              deadlinePendingTask = false;
              if (cleanup.kind === "pending") {
                const page = await args[0].storage.scanTasks(
                  {},
                  100,
                  undefined,
                  BACKGROUND_CONTEXT,
                );
                deadlinePendingTask = page.items.some(
                  (task) =>
                    task.abortRequested && task.state.status !== "terminal",
                );
              }
            } finally {
              // The handler joins cleanup; release even when its observation fails.
              release();
            }
          }
          return cleanup;
        },
      };
    },
  }));
}
if (policy?.startsWith("close-")) {
  const originalHost = openReviewHost;
  const originalExport = exportOnClose;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  mock.module("../../src/pi/host.ts", () => ({
    openReviewHost: async (...args: Parameters<typeof openReviewHost>) => {
      const host = await originalHost(...args);
      return {
        ...host,
        cleanup: (
          input: Parameters<typeof host.cleanup>[0],
          context: Parameters<typeof host.cleanup>[1],
        ) => host.cleanup({ ...input, withinMs: 5 }, context),
      };
    },
  }));
  mock.module("../../src/run-folder.ts", () => ({
    exportOnClose: (...args: Parameters<typeof exportOnClose>) => {
      const hook = originalExport(...args);
      return (input: Parameters<typeof hook>[0]) =>
        Effect.gen(function* () {
          exportStarted = true;
          const began = Date.now();
          while (Date.now() - began < 60) Math.sqrt(Date.now());
          stalledMs = Date.now() - began;
          yield* Effect.promise(() => gate);
          if (policy === "close-failure")
            throw new Error("synthetic delayed export failure");
          const receipt = yield* hook(input);
          exportSettled = true;
          return receipt;
        });
    },
  }));
}
if (policy === "deadline") {
  // Keep the gate closed until deadline-stop cleanup is observed.
  const original = reviewStages;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  mock.module("../../src/pi/stages/index.ts", () => ({
    reviewStages: (...args: Parameters<typeof reviewStages>) => ({
      ...original(...args),
      precompute: async () => {
        await gate;
        return {
          record: { stage: "precompute", status: "computed", wallMs: 0 },
        };
      },
    }),
  }));
}
if (requestedPolicy === "aged-retry") {
  const original = reviewStages;
  mock.module("../../src/pi/stages/index.ts", () => ({
    reviewStages: (...args: Parameters<typeof reviewStages>) => ({
      ...original(...args),
      precompute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return {
          record: { stage: "precompute", status: "computed", wallMs: 100 },
        };
      },
    }),
  }));
}
if (policy === "preflight")
  process.env["NEUVE_POLICY_FIXTURE_KEY"] = "synthetic-local-only";

// The route's credential: a token command printing a fixture lease, runnable only while present.
const token = join(root, "token");
writeFileSync(
  token,
  `#!/bin/sh\nprintf '{"access_token":"fixture-token","expires_at":%s}' ${Date.now() + 3_600_000}\n`,
);
const credential = (present: boolean) =>
  chmodSync(token, present ? 0o700 : 0o600);
credential(true);
process.env["NEUVE_OPENAI_TOKEN_COMMAND"] = token;

// The local Responses endpoint. Every answer is plain text, so each agent runs its policy to its
// final generation and its backstop. The first final-generation request is refused 401 after the
// credential is removed, as a sign-in that lapsed mid-run.
type Seen = {
  readonly index: number;
  readonly final: boolean;
  readonly input: unknown;
  readonly status: number;
};
const seen: Array<Seen> = [];
let refused = policy?.startsWith("close-") ?? false;
const usage = { input_tokens: 40, output_tokens: 12, total_tokens: 52 };
const text = (index: number) => {
  const id = `msg_${index}`;
  const done = {
    type: "message",
    id,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "no submission", annotations: [] }],
  };
  return [
    {
      type: "response.created",
      response: { id: `resp_${index}`, status: "in_progress", output: [] },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...done, status: "in_progress", content: [] },
    },
    {
      type: "response.output_text.delta",
      output_index: 0,
      item_id: id,
      content_index: 0,
      delta: "no submission",
    },
    { type: "response.output_item.done", output_index: 0, item: done },
    {
      type: "response.completed",
      response: {
        id: `resp_${index}`,
        status: "completed",
        output: [done],
        usage,
      },
    },
  ]
    .map(
      (event, n) =>
        `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number: n })}\n\n`,
    )
    .join("");
};
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const body = (await request.json()) as {
      readonly input?: unknown;
      readonly text?: { readonly format?: { readonly type?: string } };
    };
    const index = seen.length + 1;
    const final = body.text?.format?.type === "json_schema";
    if (policy === "preflight") {
      seen.push({ index, final, input: body.input, status: 401 });
      return Response.json(
        {
          type: "error",
          error: {
            type: "authentication_error",
            message: "invalid synthetic fixture key",
          },
        },
        { status: 401 },
      );
    }
    if (final && (!refused || policy === "held-final")) {
      refused = true;
      if (policy !== "retry" && policy !== "held-final") credential(false);
      const status =
        policy === "held-final"
          ? 500
          : policy === "retry" || policy === "crash-quota"
            ? 429
            : 401;
      seen.push({ index, final, input: body.input, status });
      return Response.json(
        {
          error:
            policy === "held-final"
              ? { code: "server_error", message: "fixture service failure" }
              : policy === "crash-quota"
                ? {
                    code: "subscription_sharing_usage_limit_exceeded",
                    message: "fixture plan quota",
                  }
                : policy === "retry"
                  ? { code: "rate_limit_exceeded", message: "fixture throttle" }
                  : {
                      code: "invalid_token",
                      message: "Token expired (fixture)",
                    },
        },
        { status },
      );
    }
    seen.push({ index, final, input: body.input, status: 200 });
    return new Response(text(index), {
      headers: { "content-type": "text/event-stream" },
    });
  },
});
const ORIGIN = `http://127.0.0.1:${server.port}`;
const toLocal = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  return fetch(new URL(`${url.pathname}${url.search}`, ORIGIN), init);
}) as typeof fetch;

// A repository with one change to review.
const repository = join(root, "repo");
mkdirSync(repository, { recursive: true });
const git = (...args: Array<string>) => {
  const result = Bun.spawnSync(["git", "-C", repository, ...args], {
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
};
git("init", "-q");
for (const [n, body] of [
  [1, "export const limit = 1;\n"],
  [2, "export const limit = 2;\n"],
] as const) {
  writeFileSync(join(repository, "limit.ts"), body);
  git("add", ".");
  git(
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "-q",
    "-m",
    `limit ${n}`,
  );
}

const location = storeLocationIn(join(root, "store"));
const services = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(
      Layer.mergeAll(
        JobQueue.layer,
        Computations.layer.pipe(Layer.provideMerge(Blobs.layer(location))),
      ),
    ),
    Effect.provide(Store.layer(location, { create: true })),
    Effect.provide(BunFileSystem.layer),
  ) as Effect.Effect<A, E, never>;

const handler = reviewRunHandler({ location, repository, fetch: toLocal });

const outcomeOf = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isSuccess(exit)
    ? "completed"
    : Option.match(Cause.findErrorOption(exit.cause), {
        onNone: () => "defect",
        onSome: (error) =>
          typeof error === "object" && error !== null && "_tag" in error
            ? String(error._tag)
            : "untagged",
      });

const observed = await Effect.runPromise(
  services(
    Effect.gen(function* () {
      yield* Store.prepareForWrite;
      const request = yield* requestReview({
        location,
        repository,
        range: "HEAD~1..HEAD",
        requester: { _tag: "Unresolved" },
        route:
          policy === "preflight"
            ? { ...OPUS_ROUTE, credentialVariable: "NEUVE_POLICY_FIXTURE_KEY" }
            : SOL_ROUTE,
        deadline: policy === "deadline" ? Duration.millis(15_050) : undefined,
        stub: { turnLimit: 1 },
        search: {},
        stack: undefined,
      });
      const queue = yield* JobQueue.JobQueue;
      if (policy?.startsWith("close-")) {
        const runId = request.events.find(
          (event) => event.kind === "review.requested@1",
        )!.id;
        let workerEnded = false;
        const worker = yield* Effect.forkChild(
          Worker.run({
            location,
            handlers: { "review.run": handler, "review.run@2": handler },
            idleTimeout: "20 millis",
            pollInterval: "5 millis",
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                workerEnded = true;
              }),
            ),
          ),
        );
        while (!exportStarted) yield* Effect.sleep("5 millis");
        yield* Effect.sleep("25 millis");
        const log = openRunLog(location, runId);
        let sourceHeld = false;
        try {
          const owner = SourceOwnership.acquire(runFolder(location, runId));
          owner.release();
        } catch (error) {
          if (error instanceof SourceOwned) sourceHeld = true;
          else throw error;
        }
        const pending = log
          .read()
          .filter((record) => record.type === "run.cleanup-pending");
        const beforeRelease = {
          sourceHeld,
          workerEnded,
          terminal: log
            .read()
            .filter(
              (record) =>
                record.type === "run.snapshot" ||
                record.type === "run.close-failed",
            ).length,
          completed: log
            .read()
            .some((record) => record.type === "run.completed"),
        };
        const socket = yield* Worker.socketPathFor(location);
        let slotReleasedBeforeSettlement = false;
        if (policy === "close-drop") {
          const active = (yield* queue.list({
            states: ["active"],
            limit: 10,
          })).find((job) => ["review.run", "review.run@2"].includes(job.kind));
          if (active === undefined)
            throw new Error("fixture review is not active");
          yield* Worker.reachWorker(socket, `drop ${active.seq}`);
          while (
            Option.getOrThrow(yield* queue.inspect(active.seq)).state ===
            "active"
          )
            yield* Effect.sleep("10 millis");
          slotReleasedBeforeSettlement = true;
          yield* Effect.sleep("50 millis");
        }
        if (policy === "close-interrupt") {
          yield* Effect.forkChild(Fiber.interrupt(worker));
          yield* Effect.sleep("25 millis");
        }
        if (policy === "close-stop") {
          yield* Worker.reachWorker(socket, "stop");
          yield* Effect.sleep("25 millis");
        }
        const workerBeforeSettlement = workerEnded;
        let sourceHeldBeforeSettlement = false;
        try {
          const owner = SourceOwnership.acquire(runFolder(location, runId));
          owner.release();
        } catch (error) {
          if (error instanceof SourceOwned) sourceHeldBeforeSettlement = true;
          else throw error;
        }
        release();
        if (
          policy !== "close-stop" &&
          policy !== "close-interrupt" &&
          policy !== "close-drop"
        ) {
          while (!log.read().some((record) => record.type === "run.completed"))
            yield* Effect.sleep("5 millis");
          yield* Worker.reachWorker(socket, "stop");
        }
        const exit = yield* Fiber.await(worker);
        const records = log.read();
        const snapshot = records.find(
          (record) => record.type === "run.snapshot",
        );
        const capture = snapshot?.["capture"];
        yield* scanCaptures(location);
        const dump =
          typeof capture === "string" ? yield* readCapturedDump(capture) : null;
        return {
          pending: pending.length,
          stalledMs,
          beforeRelease,
          workerBeforeSettlement,
          sourceHeldBeforeSettlement,
          slotReleasedBeforeSettlement,
          exportSettled,
          exit,
          snapshots: records.filter((record) => record.type === "run.snapshot")
            .length,
          failures: records.filter(
            (record) => record.type === "run.close-failed",
          ).length,
          order: records
            .filter((record) =>
              [
                "run.cleanup-pending",
                "run.snapshot",
                "run.close-failed",
                "run.completed",
              ].includes(record.type),
            )
            .map((record) => record.type),
          exported: dump?.run.runId ?? null,
          folderRetained: existsSync(runFolder(location, runId)),
        };
      }
      const claimA = Option.getOrThrow(
        yield* queue.take(["review.run", "review.run@2"]),
      );
      const runId = claimA.eventId!;

      if (requestedPolicy === "aged-retry") {
        const computations = yield* Computations.ComputationStore;
        yield* computations.run(
          { op: "review.run.started", opVersion: 1, inputs: { runId } },
          Effect.succeed({
            bytes: new TextEncoder().encode(
              JSON.stringify({ startedAt: Date.now() - 600_000 }),
            ),
            mediaType: "application/json",
          }),
        );
      }
      // Claim A: the final generation's request is refused and the credential is gone.
      const began = Date.now();
      let first = yield* Effect.exit(
        handler(
          policy === "deadline" || policy === "held-final"
            ? { ...claimA, attempts: JOB_POLICIES["review.run"].maxAttempts }
            : claimA,
        ),
      );
      if (policy === "crash-auth" || policy === "crash-quota") {
        // Reconstruct the committed hold immediately before the handler records credential loss.
        // The raw host probe separately exercises the actual interrupted close at this crash boundary.
        yield* Effect.promise(async () => {
          const session = createSession(
            await openNodeSqliteStorage(piDatabase(location, runId)),
          );
          try {
            await session.commit(async (tx) => {
              const doc = await tx.doc(RunControlDoc);
              for (const id of Object.keys(doc.held))
                delete doc.held[id]!.recovery;
            }, BACKGROUND_CONTEXT);
          } finally {
            await session.close(BACKGROUND_CONTEXT);
          }
        });
        yield* queue.release(claimA.seq, claimA.attempts);
        credential(true);
        const reclaimed = Option.getOrThrow(
          yield* queue.take(["review.run", "review.run@2"]),
        );
        first = yield* Effect.exit(handler(reclaimed));
      }
      if (policy !== undefined) {
        const elapsed = Date.now() - began;
        const log = openRunLog(location, runId).read();
        const error = Exit.isFailure(first)
          ? Option.getOrUndefined(Cause.findErrorOption(first.cause))
          : null;
        const snapshot = log.find(
          (entry) => entry.type === "run.snapshot" && entry["mode"] === "ended",
        );
        // Only the preflight case reads the dump; scanning the others' captures spent seconds of
        // CPU, at nice 10, that no assertion used.
        if (policy === "preflight") yield* scanCaptures(location);
        const dump =
          policy === "preflight" && typeof snapshot?.["capture"] === "string"
            ? yield* readCapturedDump(snapshot["capture"])
            : undefined;
        const Failure = z.object({
          kind: z.string(),
          state: z.object({
            status: z.literal("terminal"),
            outcome: z.object({
              status: z.literal("failed"),
              error: z.object({
                detail: z.object({
                  tag: z.string(),
                  retryable: z.boolean(),
                  status: z.number().optional(),
                }),
              }),
            }),
          }),
        });
        const failures =
          dump?.sessions.flatMap((session) =>
            session.tasks.flatMap((task) => {
              const parsed = Failure.safeParse(task);
              return parsed.success ? [parsed.data] : [];
            }),
          ) ?? [];
        const completed = yield* Log.history({ kind: "run.completed@1" });
        const persisted = completed.find(
          (entry) => entry.event.kind === "run.completed@1",
        );
        const retained = existsSync(runFolder(location, runId));
        return {
          failures,
          persisted: persisted?.event.payload ?? null,
          cause: Exit.isFailure(first) ? Cause.pretty(first.cause) : null,
          outcome: outcomeOf(first),
          error,
          elapsed,
          retained,
          pendingTask: deadlinePendingTask,
          stopCause: requestedStopCause,
          physicalRequests: seen.length,
          successful: log.filter(
            (entry) =>
              entry.type === "model.call" &&
              entry["finishReason"] !== "error" &&
              entry["finishReason"] !== "aborted",
          ).length,
          failed: log.filter(
            (entry) =>
              entry.type === "model.call" &&
              (entry["finishReason"] === "error" ||
                entry["finishReason"] === "aborted"),
          ).length,
          receipt: log.find((entry) => entry.type === "receipt") ?? null,
          cleanup: log.filter((entry) => entry.type === "run.cleanup-pending"),
          snapshots: log.filter((entry) => entry.type === "run.snapshot"),
        };
      }
      const afterFirst = seen.length;
      // The same claim's handler again (a repeated call within one claim): nothing wakes.
      const repeated = yield* Effect.exit(handler(claimA));
      const afterRepeat = seen.length;
      const folderWhileHeld = existsSync(runFolder(location, runId));
      // The held step's own checkpoint, read from the closed run's pi database.
      const stepCheckpoint = yield* Effect.promise(async () => {
        const storage = await openNodeSqliteStorage(
          piDatabase(location, runId),
        );
        try {
          const page = await storage.scanTasks(
            {},
            1_000,
            undefined,
            BACKGROUND_CONTEXT,
          );
          const step = page.items.find(
            (task) =>
              task.state.status !== "terminal" &&
              task.state.status !== "completing" &&
              (task.state.checkpoint as { phase?: unknown }).phase ===
                "provider-held",
          );
          return step === undefined ||
            step.state.status === "terminal" ||
            step.state.status === "completing"
            ? null
            : ((step.state.checkpoint as { failure?: unknown }).failure ??
                null);
        } finally {
          await storage.close(BACKGROUND_CONTEXT);
        }
      });
      // The worker holds the job: back to waiting, its attempt uncounted.
      yield* queue.release(claimA.seq, claimA.attempts);

      // The credential is back; the next claim resumes the held step.
      credential(true);
      const claimB = Option.getOrThrow(
        yield* queue.take(["review.run", "review.run@2"]),
      );
      const resumed = yield* Effect.exit(handler(claimB));
      if (Exit.isSuccess(resumed))
        yield* queue.complete(claimB.seq, claimB.attempts);

      const log = openRunLog(location, runId).read();
      const ended = log.find(
        (record) =>
          record.type === "run.snapshot" && record["mode"] === "ended",
      );
      const held = log.find((record) => record.type === "run.held");
      const step = (
        held?.["steps"] as Array<Record<string, unknown>> | undefined
      )?.[0];
      yield* scanCaptures(location);
      // With the readings on, the hold can cancel calls still in flight, and the capture refuses
      // to export a cancelled call; the refusal is reported, so the handler's policy still is.
      let dumpRefused: string | null = null;
      const dump =
        typeof ended?.["capture"] === "string"
          ? yield* readCapturedDump(ended["capture"]).pipe(
              Effect.catchTag("DumpRefused", (refused) =>
                Effect.sync(() => {
                  dumpRefused = refused.reason;
                  return undefined;
                }),
              ),
            )
          : undefined;
      const session = dump?.sessions.find(
        (candidate) => candidate.conversationId === step?.["conversationId"],
      );
      const failed = seen.find((request) => request.status === 401);
      return {
        taskKinds: [
          ...new Set(
            dump?.sessions.flatMap((session) =>
              session.tasks.flatMap((task) =>
                task !== null &&
                typeof task === "object" &&
                !Array.isArray(task) &&
                "kind" in task &&
                typeof task.kind === "string"
                  ? [task.kind]
                  : [],
              ),
            ) ?? [],
          ),
        ].sort(),
        receiptTotals: log.find((entry) => entry.type === "receipt")?.[
          "totals"
        ],
        nativeAttempts: log
          .filter((entry) => entry.type === "model.native-attempt")
          .map((entry) => entry["id"]),
        runKey: request.runKey,
        claims: {
          sameSeq: claimA.seq === claimB.seq,
          sameAttempt: claimA.attempts === claimB.attempts,
          newClaimTime: claimA.startedAt !== claimB.startedAt,
        },
        outcomes: [outcomeOf(first), outcomeOf(repeated), outcomeOf(resumed)],
        requests: { afterFirst, afterRepeat, total: seen.length },
        folderWhileHeld,
        folderAfter: existsSync(runFolder(location, runId)),
        admitted: log
          .filter((record) => record.type === "run.admitted")
          .map((record) => [record["admitted"], record["resume"]]),
        heldFailure: step?.["failure"] ?? null,
        // Every claim's held decision: claim A, then the same claim reopened.
        heldFailures: log
          .filter((record) => record.type === "run.held")
          .map((record) =>
            (record["steps"] as Array<Record<string, unknown>>).map(
              (held) => held["failure"],
            ),
          ),
        stepCheckpointFailure: stepCheckpoint,
        snapshots: log
          .filter((record) => record.type === "run.snapshot")
          .map((record) => [record["mode"], record["execution"]]),
        endedCapture: ended?.["capture"] ?? null,
        dumpRefused,
        // The publish phase's calls (readings on): each batch waiter's ending, then each call.
        waiters: log
          .filter((record) => record.type === "publish.waiter")
          .map((record) => [record["index"], record["status"]]),
        publications: log
          .filter((record) => record.type === "publish.settled")
          .map((record) => ({
            ending: record["ending"],
            ordinal: record["ordinal"],
            complete: record["complete"],
            refused: record["refused"],
          })),
        // Every model request waited for one of the run's call slots, as the run log's telemetry says.
        slotWaitSpans: log.filter(
          (record) =>
            record.type === "span" &&
            record["name"] === "harness.call-slot.wait",
        ).length,
        slotWaitMetricCount: log
          .filter(
            (record) =>
              record.type === "metric" &&
              record["name"] === "harness.model_call.slot_wait.duration",
          )
          .reduce(
            (sum, record) =>
              sum +
              ((record["state"] as { count?: number } | undefined)?.count ?? 0),
            0,
          ),
        completed:
          log.find((record) => record.type === "run.completed") ?? null,
        // The resumed request: the same model input as the refused one, still the final generation.
        resumedFinal: seen
          .filter((request) => request.index > (failed?.index ?? 0))
          .filter((request) => Bun.deepEquals(request.input, failed?.input))
          .map((request) => ({ final: request.final, status: request.status })),
        // The held step's conversation in the ended capture: the refused call and the resumed one.
        heldConversationCalls:
          session?.calls.map((call) => ({
            status: call.response?.status ?? null,
            sameInput:
              call.body.status === "sent" &&
              Bun.deepEquals(
                (call.body.json as { readonly input?: unknown }).input,
                failed?.input,
              ),
          })) ?? null,
      };
    }),
  ),
).finally(() => server.stop(true));

console.log(JSON.stringify(observed));
