// The run clock's scenarios, run by tests/run-clock.test.ts in its own process so that its HOME
// (settings, sign-in) is a scratch folder. It drives the real `review.run` handler over a real
// Records store, git repository and pi storage against a local OpenAI Responses endpoint, stops
// the first claim, puts the job back uncounted as a stopping worker does, waits, and runs the next
// claim to its receipt. SCENARIO_CASE picks where the first claim stops:
// - `before-work`: waiting for its budget, just before the open, so no review task is admitted;
// - `during-open`: during the open, which runs to its end and admits the review task first;
// - `after-work`: once the review task is admitted and Precompute is running.
// It prints one JSON object of observations; the test asserts on them.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { mock } from "bun:test";
import { Cause, Effect, Exit, Fiber, Layer, Option } from "effect";
import {
  Blobs,
  Computations,
  JobQueue,
  readData,
  Store,
  storeLocationIn,
} from "@neuve/records-core";
import * as budgetLocal from "../../src/budget/local.ts";
import { PipelineConfig } from "../../src/config.ts";
import { reviewRunHandler } from "../../src/handler.ts";
import { openReviewHost } from "../../src/pi/host.ts";
import { reviewStages } from "../../src/pi/stages/index.ts";
import { readCapturedDump } from "../../src/pi/capture/export.ts";
import { requestReview } from "../../src/request.ts";
import { SOL_ROUTE } from "../../src/route.ts";
import { openRunLog } from "../../src/run-log.ts";
import { effectiveCutoffAt } from "../../src/run-schedule.ts";
import { scanCaptures } from "../pi/capture/fixture.ts";

const root = process.env["SCENARIO_ROOT"];
if (root === undefined) throw new Error("SCENARIO_ROOT is not set");
const scenario = process.env["SCENARIO_CASE"];
if (
  scenario !== "before-work" &&
  scenario !== "during-open" &&
  scenario !== "after-work"
)
  throw new Error(`unknown SCENARIO_CASE ${scenario}`);
/** How long the job waits released between the two claims. */
const RELEASED_MS = 400;

// The first claim's stop point: a gate it waits on, armed just before the first claim runs.
// `entered` says the claim reached it.
let armed = false;
let entered = false;
let openGate: () => void = () => {};
const gate = new Promise<void>((resolve) => {
  openGate = resolve;
});
const atGate = () => {
  if (!armed) return false;
  armed = false;
  entered = true;
  return true;
};
if (scenario === "before-work") {
  // The claim's budget, taken just before the open: an interruptible wait, as a stop finds it.
  const original = budgetLocal.jobBudget;
  const replaced = {
    ...budgetLocal,
    jobBudget: Effect.suspend(() =>
      atGate()
        ? Effect.promise(() => gate).pipe(Effect.andThen(original))
        : original,
    ),
  };
  mock.module("../../src/budget/local.ts", () => replaced);
} else if (scenario === "during-open") {
  // The open, which the stop cannot interrupt: it waits, then opens and admits the review task.
  const original = openReviewHost;
  mock.module("../../src/pi/host.ts", () => ({
    openReviewHost: async (...args: Parameters<typeof openReviewHost>) => {
      if (atGate()) await gate;
      return original(...args);
    },
  }));
} else {
  const original = reviewStages;
  mock.module("../../src/pi/stages/index.ts", () => ({
    reviewStages: (...args: Parameters<typeof reviewStages>) => {
      const stages = original(...args);
      return {
        ...stages,
        precompute: async (...input: Parameters<typeof stages.precompute>) => {
          if (atGate()) await gate;
          return stages.precompute(...input);
        },
      };
    },
  }));
}

// The route's credential: a token command printing a fixture lease.
const token = join(root, "token");
writeFileSync(
  token,
  `#!/bin/sh\nprintf '{"access_token":"fixture-token","expires_at":%s}' ${Date.now() + 3_600_000}\n`,
  { mode: 0o700 },
);
process.env["NEUVE_OPENAI_TOKEN_COMMAND"] = token;

// The local Responses endpoint: every answer is plain text.
const usage = { input_tokens: 40, output_tokens: 12, total_tokens: 52 };
let requests = 0;
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
    await request.arrayBuffer();
    requests += 1;
    return new Response(text(requests), {
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

/** The run's stored clock, if any: the start every later claim reads. */
const storedClock = (runId: string) =>
  Effect.gen(function* () {
    const store = yield* Computations.ComputationStore;
    const held = yield* store.lookup(
      Computations.computationKey({
        op: "review.run.started",
        opVersion: 1,
        inputs: { runId },
      }).key,
    );
    if (Option.isNone(held)) return null;
    const blobs = yield* Blobs.BlobStore;
    const read = yield* blobs.get(held.value.outputHash);
    if (read._tag === "Pruned") throw new Error("the stored clock was pruned");
    return (
      JSON.parse(new TextDecoder().decode(read.bytes)) as { startedAt: number }
    ).startedAt;
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
        route: SOL_ROUTE,
        deadline: undefined,
        stub: { turnLimit: 1 },
        search: {},
        stack: undefined,
      });
      const queue = yield* JobQueue.JobQueue;
      const claimA = Option.getOrThrow(
        yield* queue.take(["review.run", "review.run@2"]),
      );
      const runId = claimA.eventId!;
      const firstClaimAt = Date.now();

      // Claim A, stopped at the scenario's point as a stopping worker interrupts its handler.
      armed = true;
      const first = yield* Effect.forkChild(handler(claimA));
      while (!entered) yield* Effect.sleep("5 millis");
      const admittedBeforeStop = openRunLog(location, runId)
        .read()
        .some((record) => record.type === "run.admitted");
      const stopping = yield* Effect.forkChild(Fiber.interrupt(first));
      yield* Effect.sleep("20 millis");
      // What the stop waited on goes on: an open runs to its end, Precompute settles unread.
      openGate();
      yield* Fiber.await(stopping);
      const firstExit = yield* Fiber.await(first);
      const clockAfterFirst = yield* storedClock(runId);

      // The worker puts the job back uncounted; it waits released, then the next claim runs it.
      yield* queue.release(claimA.seq, claimA.attempts);
      yield* Effect.sleep(`${RELEASED_MS} millis`);
      const claimB = Option.getOrThrow(
        yield* queue.take(["review.run", "review.run@2"]),
      );
      const secondClaimAt = Date.now();
      const second = yield* Effect.exit(handler(claimB));
      if (Exit.isSuccess(second))
        yield* queue.complete(claimB.seq, claimB.attempts);
      const clockAfterSecond = yield* storedClock(runId);

      const log = openRunLog(location, runId).read();
      const receipt = log.find((record) => record.type === "receipt") as
        | {
            timing: {
              enqueuedAt: string;
              startedAt: string;
              queueWaitMs: number;
            };
            timeout: { cutoffAt: string };
          }
        | undefined;
      // The review task's own cut-off, as every stage reads it, from the ended capture.
      const ended = log.find(
        (record) =>
          record.type === "run.snapshot" && record["mode"] === "ended",
      );
      yield* scanCaptures(location);
      const dump =
        typeof ended?.["capture"] === "string"
          ? yield* readCapturedDump(ended["capture"])
          : undefined;
      const reviewTasks =
        dump?.sessions.flatMap((session) =>
          session.tasks.flatMap((task) => {
            const record = task as {
              kind?: unknown;
              input?: { cutoffAt?: unknown };
            };
            return record.kind === "neuve.review" &&
              typeof record.input?.cutoffAt === "number"
              ? [record.input.cutoffAt]
              : [];
          }),
        ) ?? [];
      const requested = request.events.find(
        (event) => event.kind === "review.requested@1",
      )!;
      if (requested.kind !== "review.requested@1")
        throw new Error("no review request");
      const config = readData(
        PipelineConfig,
        requested.payload.pipeline.config,
      );
      return {
        firstExit: Exit.isSuccess(firstExit) ? "completed" : "stopped",
        admittedBeforeStop,
        secondOutcome: Exit.isSuccess(second) ? "completed" : "failed",
        secondCause: Exit.isFailure(second) ? Cause.pretty(second.cause) : null,
        releasedMs: RELEASED_MS,
        firstClaimAt,
        secondClaimAt,
        clockAfterFirst,
        clockAfterSecond,
        enqueuedAt: Date.parse(claimA.enqueuedAt),
        admitted: log
          .filter((record) => record.type === "run.admitted")
          .map((record) => record["admitted"]),
        runStarted: log
          .filter((record) => record.type === "run.started")
          .map((record) => record["queueWaitMs"]),
        receipt:
          receipt === undefined
            ? null
            : {
                startedAt: Date.parse(receipt.timing.startedAt),
                queueWaitMs: receipt.timing.queueWaitMs,
                cutoffAt: Date.parse(receipt.timeout.cutoffAt),
              },
        expectedCutoffAt:
          clockAfterSecond === null
            ? null
            : effectiveCutoffAt(clockAfterSecond, config.budgets),
        reviewTaskCutoffs: reviewTasks,
      };
    }),
  ),
).finally(() => server.stop(true));

console.log(JSON.stringify(observed));
