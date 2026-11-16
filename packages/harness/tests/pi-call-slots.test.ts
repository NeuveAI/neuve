// Why: a run sends at most its configured number of model requests at once (10.27), whichever agent
// conversation sends them, and tells a request's wait for a slot apart from the provider's time
// (10.95, 10.97). Under pi the limit sits at the routed providers' public stream boundary
// (pi/call-slots.ts). This drives a real pi Harness whose conversations each dispatch through their
// own logical provider, all over the same slots, against a local OpenAI Responses endpoint that
// holds its answers until the test lets them go. It checks the bound across providers, that a
// request cancelled while waiting never reaches the provider or keeps a slot, that a slot is held
// until a stream aborted mid-way ends, and the wait span and metric the incumbent `withSlot` records.
import { afterAll, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  createModels,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Model,
  type MutableModels,
  type Provider,
} from "@earendil-works/pi-ai";
import {
  stream as responsesStream,
  streamSimple as responsesStreamSimple,
} from "@earendil-works/pi-ai/api/openai-responses";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import {
  createRegistry,
  Harness,
  MemoryStorage,
  type Conversation,
} from "@earendil-works/pi-durable";
import { Effect, Metric, Tracer } from "effect";
import { callSlots, limitProvider } from "../src/pi/call-slots.ts";
import { REVIEW_SETTINGS } from "../src/pi/host.ts";
import {
  nativeRetryAdmission,
  NativeAttemptsDoc,
} from "../src/pi/providers/retry-admission.ts";
import {
  runLogTracer,
  type RunLog,
  type RunLogRecord,
} from "../src/run-log.ts";
import { writeMetrics } from "../src/telemetry.ts";

// The endpoint: every request arrives and waits for the test to let it answer.
type Held = {
  readonly id: number;
  readonly answer: () => void;
  readonly answered: Promise<void>;
};
const arrived: Array<Held> = [];
let arrivals = 0;
const waitingFor = new Set<(count: number) => void>();
const usage = { input_tokens: 4, output_tokens: 2, total_tokens: 6 };
const event = (type: string, body: Record<string, unknown>, n: number) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...body, sequence_number: n })}\n\n`;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 30,
  async fetch(request) {
    await request.json();
    const id = ++arrivals;
    let answer = () => {};
    const answered = new Promise<void>((resolve) => (answer = resolve));
    arrived.push({ id, answer, answered });
    for (const notify of waitingFor) notify(arrivals);
    const done = {
      type: "message",
      id: `msg_${id}`,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "ok", annotations: [] }],
    };
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream<Uint8Array>({
        async start(controller) {
          // The stream has begun: the request holds its slot from here until it ends.
          controller.enqueue(
            encoder.encode(
              event(
                "response.created",
                {
                  response: {
                    id: `resp_${id}`,
                    status: "in_progress",
                    output: [],
                  },
                },
                0,
              ),
            ),
          );
          await answered;
          controller.enqueue(
            encoder.encode(
              event(
                "response.output_item.done",
                { output_index: 0, item: done },
                1,
              ),
            ),
          );
          controller.enqueue(
            encoder.encode(
              event(
                "response.completed",
                {
                  response: {
                    id: `resp_${id}`,
                    status: "completed",
                    output: [done],
                    usage,
                  },
                },
                2,
              ),
            ),
          );
          controller.close();
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  },
});
afterAll(() => server.stop(true));
const ORIGIN = `http://127.0.0.1:${server.port}`;

const untilArrivals = (count: number) =>
  new Promise<void>((resolve) => {
    if (arrivals >= count) return resolve();
    const notify = (now: number) => {
      if (now < count) return;
      waitingFor.delete(notify);
      resolve();
    };
    waitingFor.add(notify);
  });
const settle = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

const providerFor = (id: string, origin = ORIGIN): Provider => {
  const model: Model<"openai-responses"> = {
    id: "model-1",
    name: "model-1",
    api: "openai-responses",
    provider: id,
    baseUrl: `${origin}/v1`,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: false,
    contextWindow: 100_000,
    maxTokens: 1_000,
  };
  const provider: Provider<"openai-responses"> = {
    id,
    name: id,
    baseUrl: `${origin}/v1`,
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

const memoryLog = (): RunLog => {
  const records: Array<RunLogRecord> = [];
  return {
    path: "",
    write: (record) =>
      records.push(JSON.parse(JSON.stringify(record)) as RunLogRecord),
    read: () => records,
  };
};

/** One run: its slots, its telemetry and a harness whose conversations each have a provider of their own. */
const openRun = async (limit: number, conversations: number) => {
  const log = memoryLog();
  const registry: Metric.MetricRegistry = new Map();
  const telemetry = await Effect.runPromise(
    Effect.context<never>().pipe(
      Effect.provideService(Tracer.Tracer, runLogTracer(log)),
      Effect.provideService(Metric.MetricRegistry, registry),
    ),
  );
  const slots = callSlots(limit, (effect, signal) =>
    Effect.runPromiseWith(telemetry)(
      effect,
      signal === undefined ? undefined : { signal },
    ),
  );
  const models: MutableModels = createModels();
  for (let n = 1; n <= conversations; n++)
    models.setProvider(
      limitProvider(providerFor(`route-${n}`), slots, {
        provider: "openai",
        model: "model-1",
      }),
    );
  const harness = await Harness.open(
    new MemoryStorage(),
    {
      models,
      registry: createRegistry(),
      settings: {
        stream: { maxRetries: 0 },
        retry: { enabled: false },
        compaction: { enabled: false },
      },
    },
    context,
  );
  const opened: Array<Conversation> = [];
  for (let n = 1; n <= conversations; n++)
    opened.push(
      await harness.createConversation(
        {
          ownership: { kind: "ownerless" },
          agent: { model: { provider: `route-${n}`, modelId: "model-1" } },
        },
        context,
      ),
    );
  return { log, registry, harness, conversations: opened };
};

const reset = () => {
  arrived.length = 0;
  arrivals = 0;
};

const metricsOf = (registry: Metric.MetricRegistry) => {
  const written: Array<RunLogRecord> = [];
  writeMetrics(
    { path: "", write: (entry) => written.push(entry), read: () => [] },
    registry,
  );
  return written.filter(
    (entry) => entry["name"] === "harness.model_call.slot_wait.duration",
  );
};

test("one run's slots bound its requests across every agent conversation's provider, and each wait is measured", async () => {
  reset();
  const run = await openRun(2, 3);
  const submissions = await Promise.all(
    run.conversations.map((conversation) =>
      conversation.submit({ type: "input", content: "go" }, context),
    ),
  );
  await untilArrivals(2);
  await settle(150);
  const whileFull = arrivals;
  arrived[0]!.answer();
  await untilArrivals(3);
  for (const held of arrived) held.answer();
  const settled = await Promise.all(
    submissions.map((submission) => submission.wait(context)),
  );
  await run.harness.close(context);

  expect(whileFull).toBe(2);
  expect(settled.map((submission) => submission.status)).toEqual([
    "done",
    "done",
    "done",
  ]);
  const waits = run.log
    .read()
    .filter(
      (record) =>
        record.type === "span" && record["name"] === "harness.call-slot.wait",
    )
    .map((record) => record["durationMs"] as number)
    .sort((a, b) => a - b);
  expect(waits.length).toBe(3);
  // Two took a free slot at once; the third waited out the held one.
  expect(waits[2]!).toBeGreaterThanOrEqual(140);
  const [metric] = metricsOf(run.registry);
  expect((metric?.["state"] as { count: number }).count).toBe(3);
  expect(metric?.["attributes"]).toMatchObject({
    "gen_ai.operation.name": "chat",
    "gen_ai.provider.name": "openai",
    "gen_ai.request.model": "model-1",
    unit: "s",
  });
});

test("a request cancelled while it waits never reaches its provider and keeps no slot", async () => {
  reset();
  const run = await openRun(1, 3);
  const [first, waiting, later] = run.conversations;
  const holding = await first!.submit(
    { type: "input", content: "go" },
    context,
  );
  await untilArrivals(1);
  const cancelled = await waiting!.submit(
    { type: "input", content: "go" },
    context,
  );
  await settle(100);
  await waiting!.abort(context);
  const cancelledSettled = await cancelled.wait(context);
  await settle(100);
  const afterCancel = arrivals;
  arrived[0]!.answer();
  await holding.wait(context);
  // The slot the cancelled request never held is free for the next one.
  const next = await later!.submit({ type: "input", content: "go" }, context);
  await untilArrivals(2);
  arrived[1]!.answer();
  const nextSettled = await next.wait(context);
  await run.harness.close(context);

  expect(afterCancel).toBe(1);
  expect(cancelledSettled.status).toBe("unanswered");
  expect(nextSettled.status).toBe("done");
  expect(arrivals).toBe(2);
});

test("a slot is held until a stream aborted midway has ended, then the next request takes it", async () => {
  reset();
  const run = await openRun(1, 2);
  const [streaming, next] = run.conversations;
  const aborted = await streaming!.submit(
    { type: "input", content: "go" },
    context,
  );
  await untilArrivals(1);
  const queued = await next!.submit({ type: "input", content: "go" }, context);
  await settle(150);
  const beforeAbort = arrivals;
  await streaming!.abort(context);
  const abortedSettled = await aborted.wait(context);
  await untilArrivals(2);
  arrived[1]!.answer();
  const queuedSettled = await queued.wait(context);
  arrived[0]!.answer();
  await run.harness.close(context);

  expect(beforeAbort).toBe(1);
  expect(abortedSettled.status).toBe("unanswered");
  expect(queuedSettled.status).toBe("done");
  expect(arrivals).toBe(2);
});

// The boundary on its own: providers that fail in every way a stream can, one slot between them.

const EMPTY = normalizeContext({ messages: [] });
const MODEL: Model<"openai-responses"> = {
  id: "model-1",
  name: "model-1",
  api: "openai-responses",
  provider: "fake",
  baseUrl: "http://127.0.0.1:9",
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  reasoning: false,
  contextWindow: 100_000,
  maxTokens: 1_000,
};
const answer = (): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text: "ok" }],
  api: MODEL.api,
  provider: MODEL.provider,
  model: MODEL.id,
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: Date.now(),
});

type Behaviour = "answers" | "throws" | "rejects" | "ends-early" | "held";
const fake = (
  behaviour: Behaviour,
  calls: Array<Behaviour>,
  gate?: Promise<void>,
): Provider => {
  const start = () => {
    calls.push(behaviour);
    if (behaviour === "throws") throw new Error("the provider threw");
    const events = createAssistantMessageEventStream();
    void (async () => {
      if (behaviour === "held") await gate;
      if (behaviour === "ends-early") {
        events.end();
        return;
      }
      const message = answer();
      events.push({ type: "done", reason: "stop", message });
      events.end(message);
    })();
    if (behaviour !== "rejects") return events;
    // An iterable whose iteration fails partway, as a broken transport's would.
    return {
      ...events,
      async *[Symbol.asyncIterator](): AsyncGenerator<AssistantMessageEvent> {
        throw new Error("the provider's stream broke");
      },
    } as unknown as ReturnType<Provider["streamSimple"]>;
  };
  return {
    id: "fake",
    name: "fake",
    auth: {
      apiKey: {
        name: "none",
        resolve: async () => ({ auth: {}, source: "test" }),
      },
    },
    getModels: () => [MODEL],
    stream: () => start(),
    streamSimple: () => start(),
  };
};

const within = <T>(promise: Promise<T>, ms = 2_000) =>
  Promise.race([
    promise,
    new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), ms)),
  ]);
const outcome = (message: AssistantMessage | "hung") =>
  message === "hung"
    ? "hung"
    : {
        stopReason: message.stopReason,
        errorMessage: message.errorMessage ?? null,
      };
const plainRun = callSlots(1, (effect, signal) =>
  Effect.runPromise(effect, signal === undefined ? undefined : { signal }),
);

test("every way a provider's stream can fail settles as an error and gives its slot back", async () => {
  const calls: Array<Behaviour> = [];
  const route = { provider: "openai", model: "model-1" };
  const results = [];
  for (const behaviour of [
    "throws",
    "rejects",
    "ends-early",
    "answers",
  ] as const) {
    const provider = limitProvider(fake(behaviour, calls), plainRun, route);
    results.push(
      outcome(await within(provider.streamSimple(MODEL, EMPTY).result())),
    );
  }

  expect(calls).toEqual(["throws", "rejects", "ends-early", "answers"]);
  expect(results).toEqual([
    { stopReason: "error", errorMessage: "the provider threw" },
    { stopReason: "error", errorMessage: "the provider's stream broke" },
    {
      stopReason: "error",
      errorMessage: "the provider's stream ended without a terminal event",
    },
    { stopReason: "stop", errorMessage: null },
  ]);
});

test("a request cancelled while it waits never calls its provider, and the slot passes to the next", async () => {
  const slots = callSlots(1, (effect, signal) =>
    Effect.runPromise(effect, signal === undefined ? undefined : { signal }),
  );
  const route = { provider: "openai", model: "model-1" };
  const calls: Array<Behaviour> = [];
  let open = () => {};
  const gate = new Promise<void>((resolve) => (open = resolve));
  const holding = limitProvider(
    fake("held", calls, gate),
    slots,
    route,
  ).streamSimple(MODEL, EMPTY);
  const waiting = new AbortController();
  const cancelled = limitProvider(
    fake("answers", calls),
    slots,
    route,
  ).streamSimple(MODEL, EMPTY, { signal: waiting.signal });
  const alreadyCancelled = new AbortController();
  alreadyCancelled.abort();
  const neverStarted = limitProvider(
    fake("answers", calls),
    slots,
    route,
  ).streamSimple(MODEL, EMPTY, { signal: alreadyCancelled.signal });
  await settle(50);
  waiting.abort();
  const cancelledResult = await within(cancelled.result());
  const neverStartedResult = await within(neverStarted.result());
  const callsWhileHeld = [...calls];
  open();
  const heldResult = await within(holding.result());
  const next = await within(
    limitProvider(fake("answers", calls), slots, route)
      .streamSimple(MODEL, EMPTY)
      .result(),
  );

  expect(callsWhileHeld).toEqual(["held"]);
  // Ended by pi-ai's own terminal for a request that never reached its provider.
  expect(cancelledResult !== "hung" && cancelledResult.stopReason).toBe(
    "error",
  );
  expect(neverStartedResult !== "hung" && neverStartedResult.stopReason).toBe(
    "error",
  );
  expect([outcome(heldResult), outcome(next)]).toEqual([
    { stopReason: "stop", errorMessage: null },
    { stopReason: "stop", errorMessage: null },
  ]);
  expect(calls).toEqual(["held", "answers"]);
});

// The permit is already real, but limited() cannot construct/iterate holding() until this gate opens.
test("cancellation after actual slot admission before holding first iteration frees the slot for an HTTP waiter", async () => {
  reset();
  const slotRuns: Array<Promise<unknown>> = [];
  const slots = callSlots(1, (effect, signal) => {
    const running = Effect.runPromise(
      effect,
      signal === undefined ? undefined : { signal },
    );
    slotRuns.push(running);
    return running;
  });
  const admitted = Promise.withResolvers<void>();
  const continueSetup = Promise.withResolvers<void>();
  const cancelled = new AbortController();
  const cleanup = new AbortController();
  const route = { provider: "openai", model: "model-1" };
  const models = createModels();
  const firstProvider = limitProvider(
    providerFor("cancelled-before-iteration"),
    {
      async acquire(attributes, signal) {
        const release = await slots.acquire(attributes, signal);
        admitted.resolve();
        await continueSetup.promise;
        return release;
      },
    },
    route,
  );
  models.setProvider(firstProvider);
  const firstModel = models.getModel("cancelled-before-iteration", "model-1")!;
  const first = models.streamSimple(firstModel, EMPTY, {
    signal: cancelled.signal,
  });
  await admitted.promise;
  const waiterQueued = Promise.withResolvers<void>();
  models.setProvider(
    limitProvider(
      providerFor("waiter-after-admission"),
      {
        acquire(attributes, signal) {
          const acquiring = slots.acquire(attributes, signal);
          waiterQueued.resolve();
          return acquiring;
        },
      },
      route,
    ),
  );
  const waiter = models.streamSimple(
    models.getModel("waiter-after-admission", "model-1")!,
    EMPTY,
    { signal: cleanup.signal },
  );
  const settlements = [first.result(), waiter.result()];
  await waiterQueued.promise;
  cancelled.abort();
  continueSetup.resolve();
  try {
    const cancelledResult = await within(first.result());
    expect(cancelledResult !== "hung" && cancelledResult.stopReason).toBe(
      "aborted",
    );
    expect(await within(untilArrivals(1))).not.toBe("hung");
    arrived[0]!.answer();
    const result = await within(waiter.result());
    expect(result !== "hung" && result.stopReason).toBe("stop");
    expect(
      result !== "hung" &&
        result.content.map((block) =>
          block.type === "text" ? block.text : block.type,
        ),
    ).toEqual(["ok"]);
    expect(arrivals).toBe(1);
    // A third real SDK dispatch proves final cleanup left no permit behind either stream.
    models.setProvider(
      limitProvider(providerFor("after-cleanup"), slots, route),
    );
    const last = models.streamSimple(
      models.getModel("after-cleanup", "model-1")!,
      EMPTY,
      { signal: cleanup.signal },
    );
    settlements.push(last.result());
    expect(await within(untilArrivals(2))).not.toBe("hung");
    arrived[1]!.answer();
    expect((await last.result()).stopReason).toBe("stop");
    expect(arrivals).toBe(2);
  } finally {
    cancelled.abort();
    continueSetup.resolve();
    cleanup.abort();
    for (const request of arrived) request.answer();
    await Promise.all(settlements);
    expect(await within(Promise.allSettled(slotRuns))).not.toBe("hung");
  }
});

type Backoff = { at: number };
const retryRun = async () => {
  const requests: Array<{ name: string; at: number }> = [];
  const backoff = Promise.withResolvers<Backoff>();
  const local = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = await request.text();
      const name = body.includes("retrying")
        ? "retrying"
        : body.includes("other")
          ? "other"
          : "after cancellation";
      requests.push({ name, at: Date.now() });
      if (
        name === "retrying" &&
        requests.filter((entry) => entry.name === name).length === 1
      )
        return Response.json(
          {
            error: { message: "503 service unavailable", type: "server_error" },
          },
          { status: 503 },
        );
      const id = requests.length;
      const message = {
        type: "message",
        id: `msg_${id}`,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: name, annotations: [] }],
      };
      return new Response(
        event(
          "response.created",
          { response: { id: `resp_${id}`, status: "in_progress", output: [] } },
          0,
        ) +
          event(
            "response.output_item.done",
            { output_index: 0, item: message },
            1,
          ) +
          event(
            "response.completed",
            {
              response: {
                id: `resp_${id}`,
                status: "completed",
                output: [message],
                usage,
              },
            },
            2,
          ),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const models = createModels();
  const retry = nativeRetryAdmission(REVIEW_SETTINGS);
  const slotRuns: Array<Promise<unknown>> = [];
  const slots = callSlots(1, (effect, signal) => {
    const running = Effect.runPromise(
      effect,
      signal === undefined ? undefined : { signal },
    );
    slotRuns.push(running);
    return running;
  });
  const harness = await Harness.open(
    new MemoryStorage(),
    { models, registry: createRegistry(), settings: retry.settings },
    context,
  );
  const conversations: Array<Conversation> = [];
  for (let n = 0; n < 3; n++) {
    const id = `retry-route-${n}`;
    const conversation = await harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: { model: { provider: id, modelId: "model-1" } },
      },
      context,
    );
    conversations.push(conversation);
    models.setProvider(
      retry.provider(
        limitProvider(
          providerFor(id, `http://127.0.0.1:${local.port}`),
          slots,
          { provider: "openai", model: "model-1" },
        ),
        { harness, conversationId: conversation.id },
      ),
    );
  }
  const retrying = conversations[0]!;
  const stop = harness.subscribeCommits((publication) => {
    for (const change of publication.changes) {
      if (
        change.type === "document" &&
        change.record.kind === "neuve.retry-admission" &&
        change.conversationId === retrying.id &&
        typeof change.value?.until === "number" &&
        change.value.until > 0
      ) {
        backoff.resolve({ at: change.value.until });
      }
    }
  });
  return {
    requests,
    harness,
    conversations,
    backoff: backoff.promise,
    async close() {
      stop();
      await harness.close(context);
      expect(await within(Promise.allSettled(slotRuns))).not.toBe("hung");
      local.stop(true);
    },
  };
};

test("production native retries release the slot during the committed jittered backoff", async () => {
  const run = await retryRun();
  try {
    const retrying = await run.conversations[0]!.submit(
      { type: "input", content: "retrying" },
      context,
    );
    const backoff = await run.backoff;
    const other = await run.conversations[1]!.submit(
      { type: "input", content: "other" },
      context,
    );
    expect((await other.wait(context)).status).toBe("done");
    expect(run.requests.map((entry) => entry.name)).toEqual([
      "retrying",
      "other",
    ]);
    expect(run.requests[1]!.at).toBeLessThan(backoff.at);
    expect((await retrying.wait(context)).status).toBe("done");
    expect(run.requests.map((entry) => entry.name)).toEqual([
      "retrying",
      "other",
      "retrying",
    ]);
    expect(run.requests[2]!.at).toBeGreaterThanOrEqual(backoff.at);
    const attempts = await run.harness.snapshot(NativeAttemptsDoc, context);
    expect(
      Object.values(attempts?.generations ?? {}).map((values) => [...values]),
    ).toEqual([[1, 2], [1]]);
  } finally {
    await run.close();
  }
});

test("cancelling production retry backoff leaves no later dispatch and another HTTP request still completes", async () => {
  const run = await retryRun();
  try {
    const retrying = await run.conversations[0]!.submit(
      { type: "input", content: "retrying" },
      context,
    );
    const backoff = await run.backoff;
    const other = await run.conversations[1]!.submit(
      { type: "input", content: "other" },
      context,
    );
    expect((await other.wait(context)).status).toBe("done");
    expect(run.requests[1]!.at).toBeLessThan(backoff.at);
    await run.conversations[0]!.abort(context);
    expect((await retrying.wait(context)).status).toBe("unanswered");
    // Observe past the actual persisted production deadline, not an arbitrary settling interval.
    while (Date.now() <= backoff.at)
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.max(1, Math.ceil(backoff.at - Date.now()))),
      );
    const after = await run.conversations[2]!.submit(
      { type: "input", content: "after cancellation" },
      context,
    );
    expect((await after.wait(context)).status).toBe("done");
    const attempts = await run.harness.snapshot(NativeAttemptsDoc, context);
    expect(
      Object.values(attempts?.generations ?? {}).map((values) => [...values]),
    ).toEqual([[1], [1], [1]]);
    await run.harness.close(context);
    expect(run.requests.map((entry) => entry.name)).toEqual([
      "retrying",
      "other",
      "after cancellation",
    ]);
  } finally {
    await run.close();
  }
});
