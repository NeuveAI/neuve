import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createModels,
  isContextOverflow,
  isRetryableAssistantError,
  type AssistantMessage,
  type MutableModels,
} from "@earendil-works/pi-ai";
import {
  Harness,
  MemoryStorage,
  createRegistry,
  defineExtension,
  defineTool,
  type HarnessSettings,
} from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { OPUS_ROUTE, SOL_ROUTE } from "../../../src/route.ts";
import {
  CaptureFailed,
  type ModelCaptureEvent,
} from "../../../src/pi/capture/types.ts";
import {
  createAgentRouteProvider,
  createRouteModels,
  type RouteModelsOptions,
} from "../../../src/pi/providers/agent-route-provider.ts";
import {
  routeFailureOf,
  routeFailureOfSubmission,
  schedulerText,
  type RouteFailure,
  type RouteFailureKind,
} from "../../../src/pi/providers/failure.ts";
import { conversationId } from "../../../src/pi/providers/wire.ts";
import {
  completed,
  created,
  functionCallItem,
  messageItem,
  openEndpoint,
  schema,
  sse,
  tokenCommand,
  type Responder,
} from "./fixture.ts";

// pi's own Harness decides every retry and overflow from the failed turn's `errorMessage`, so these
// tests count what reached a local provider endpoint while pi's generation ran its real schedule.

const context = BACKGROUND_CONTEXT;
const endpoint = openEndpoint();
afterAll(() => endpoint.stop());
const scratch = mkdtempSync(join(tmpdir(), "scheduler-text-"));
const token = tokenCommand(scratch, "lease");
const SESSION = "01JSCHEDULERTEXT";

const refuse =
  (status: number, code: string, message: string, requestId: string) => () =>
    Response.json(
      { error: { code, message } },
      { status, headers: { "x-request-id": requestId } },
    );

const answer = (tag: string) => () =>
  sse([
    created(`resp_${tag}`),
    ...messageItem(0, `msg_${tag}`, "final_answer", "Done."),
    completed(`resp_${tag}`),
  ]);

const sentTo = (session: string) =>
  endpoint.received.filter(
    (request) => request.headers.get("session-id") === session,
  ).length;

const openHarness = async (
  models: MutableModels,
  model: { readonly provider: string; readonly modelId: string },
  settings: HarnessSettings,
) => {
  const registry = createRegistry();
  registry.install(defineExtension({ name: "none" }));
  const harness = await Harness.open(
    new MemoryStorage(),
    { models, registry, settings },
    context,
  );
  const conversation = await harness.createConversation(
    { ownership: { kind: "ownerless" }, agent: { model } },
    context,
  );
  const ask = async (content: string) =>
    (await conversation.submit({ type: "input", content }, context)).wait(
      context,
    );
  return { harness, conversation, ask };
};

/** A coding session on the OpenAI route with its own `session-id`, driven by pi's Harness. */
const session = async (
  affinity: string,
  settings: HarnessSettings,
  change: Partial<Omit<RouteModelsOptions, "purpose">> = {},
) => {
  const captured: Array<ModelCaptureEvent> = [];
  const models = createRouteModels({
    credentialInspection: "ephemeral" as const,
    route: SOL_ROUTE,
    auth: { tokenCommand: token.path },
    fetch: endpoint.fetch,
    capture: (event) => captured.push(event),
    runId: SESSION,
    sessionAffinity: affinity,
    ...change,
  });
  const opened = await openHarness(
    models,
    { provider: "openai", modelId: SOL_ROUTE.model },
    settings,
  );
  return { ...opened, captured, id: conversationId(SESSION, affinity) };
};

const ended = (captured: ReadonlyArray<ModelCaptureEvent>) =>
  captured.flatMap((event) =>
    event.type === "model.end" ? [event.error ?? null] : [],
  );

const RETRY = { retry: { maxRetries: 2, baseDelayMs: 1 } };

describe("a refusal pi must not retry", () => {
  const cases: ReadonlyArray<
    readonly [
      name: string,
      status: number,
      code: string,
      message: string,
      requestId: string,
      settled: string,
      kind: RouteFailureKind,
    ]
  > = [
    [
      "revoked-500",
      401,
      "invalid_token",
      "Token revoked",
      "req_7c1e9a5003d24b6f8e0a1c2b3d4e5f60",
      "OpenAI API error (HTTP 401): the provider refused the credential or plan access",
      "auth",
    ],
    [
      "ineligible-429",
      403,
      "subscription_sharing_user_not_eligible",
      "Not eligible",
      "req_0a4290bd7e6f45c3a1b2c3d4e5f6a7b8",
      "OpenAI API error (HTTP 403): the provider refused the credential or plan access",
      "auth",
    ],
    [
      "invalid-502",
      400,
      "invalid_request_error",
      "Invalid value for tools",
      "req_aa5021bd7e6f45c3a1b2c3d4e5f6a7b8",
      "OpenAI API error (HTTP 400): the provider refused the request as invalid",
      "invalid_request",
    ],
    [
      "worded-transient",
      403,
      "server_error_500_try_again",
      "Server error 500, overloaded: please retry your request, it timed out",
      "req_5245205035045205245025035045201a",
      "OpenAI API error (HTTP 403): the provider refused the credential or plan access",
      "auth",
    ],
    [
      "insufficient-quota",
      429,
      "insufficient_quota",
      "You exceeded your current quota",
      "req_4295005025035045205244295005020a",
      "OpenAI API error: quota exceeded, the account's usage quota is used up",
      "plan_quota",
    ],
    [
      "usage-limit",
      429,
      "subscription_sharing_usage_limit_exceeded",
      "Usage limit reached",
      "req_0ff4290ff5000ff5020ff5030ff504",
      "OpenAI API error: quota exceeded, the account's usage quota is used up",
      "plan_quota",
    ],
  ];

  for (const [name, status, code, message, requestId, settled, kind] of cases)
    test(`${name}: HTTP ${status} ${code} is sent once and keeps its full detail`, async () => {
      const opened = await session(name, RETRY);
      endpoint.respondTo(
        opened.id,
        refuse(status, code, message, requestId),
        refuse(status, code, message, requestId),
        refuse(status, code, message, requestId),
      );
      const result = await opened.ask("Go.");
      const detail = `OpenAI API error (HTTP ${status}, ${code}): ${message} (request ${requestId})`;

      expect(sentTo(opened.id)).toBe(1);
      expect(result).toMatchObject({
        status: "unanswered",
        reason: "model_error",
        detail: settled,
      });
      expect(
        await routeFailureOfSubmission(opened.conversation, result, context),
      ).toEqual({ kind, status, code, requestId, detail });
      expect(ended(opened.captured)).toEqual([{ type: code, message: detail }]);
      expect(opened.captured).toContainEqual(
        expect.objectContaining({ type: "model.response", status, requestId }),
      );
      await opened.harness.close(context);
    });
});

describe("a failure pi is meant to retry", () => {
  test("a rate limit is retried on pi's bounded schedule and no further", async () => {
    const opened = await session("throttled", RETRY);
    endpoint.respondTo(
      opened.id,
      refuse(429, "rate_limit_exceeded", "Slow down", "req_r1"),
      refuse(429, "rate_limit_exceeded", "Slow down", "req_r2"),
      refuse(429, "rate_limit_exceeded", "Slow down", "req_r3"),
    );
    const result = await opened.ask("Go.");

    expect(sentTo(opened.id)).toBe(3);
    expect(result.detail).toBe(
      "OpenAI API error (HTTP 429): rate limited by the provider",
    );
    expect(
      await routeFailureOfSubmission(opened.conversation, result, context),
    ).toEqual({
      kind: "rate_limit",
      status: 429,
      code: "rate_limit_exceeded",
      requestId: "req_r3",
      detail:
        "OpenAI API error (HTTP 429, rate_limit_exceeded): Slow down (request req_r3)",
    });
    await opened.harness.close(context);
  });

  test("a server error is retried until the provider answers", async () => {
    const opened = await session("server", RETRY);
    endpoint.respondTo(
      opened.id,
      refuse(503, "server_error", "Unavailable", "req_s1"),
      refuse(500, "server_error", "Internal", "req_s2"),
      answer("server"),
    );
    expect((await opened.ask("Go.")).status).toBe("done");
    expect(sentTo(opened.id)).toBe(3);
    await opened.harness.close(context);
  });

  test("a stream that fails after partial output is retried, and the failed turn keeps the partial text", async () => {
    const opened = await session("partial", RETRY);
    endpoint.respondTo(
      opened.id,
      () =>
        sse([
          created("resp_p1"),
          {
            type: "response.output_item.added",
            output_index: 0,
            item: {
              type: "message",
              id: "msg_p1",
              role: "assistant",
              phase: "final_answer",
              content: [],
            },
          },
          {
            type: "response.output_text.delta",
            output_index: 0,
            content_index: 0,
            delta: "Half",
          },
          {
            type: "response.failed",
            response: {
              id: "resp_p1",
              status: "failed",
              error: {
                code: "server_error",
                message: "An error occurred while processing your request.",
              },
            },
          },
        ]),
      answer("partial"),
    );
    expect((await opened.ask("Go.")).status).toBe("done");
    expect(sentTo(opened.id)).toBe(2);
    const turns = (
      await opened.conversation.entries({}, 100, undefined, context)
    ).items
      .toSorted((a, b) => a.id - b.id)
      .flatMap((entry) =>
        (entry.model ?? []).filter(
          (message): message is AssistantMessage =>
            message.role === "assistant",
        ),
      );
    expect(
      turns.map((turn) => [turn.stopReason, turn.errorMessage ?? null]),
    ).toEqual([
      [
        "error",
        "OpenAI API error: the stream failed or ended without a terminal event",
      ],
      ["stop", null],
    ]);
    expect(turns[0]!.content).toMatchObject([{ type: "text", text: "Half" }]);
    expect(routeFailureOf(turns[0]!)).toEqual({
      kind: "stream",
      status: 200,
      code: "server_error",
      requestId: "req_1",
      detail:
        "OpenAI API error (HTTP 200, server_error): An error occurred while processing your request. (request req_1)",
    });
    await opened.harness.close(context);
  });

  test("a stalled stream is retried", async () => {
    const opened = await session("stalled", RETRY, {
      stallLimits: { quietMs: 1000, reasoningMs: 1000 },
    });
    endpoint.respondTo(
      opened.id,
      () => sse([created("resp_t1")], { hold: true }),
      async () => {
        await Bun.sleep(200);
        return answer("stalled")();
      },
    );
    const result = await opened.ask("Go.");
    expect(result.status, JSON.stringify(ended(opened.captured))).toBe("done");
    expect(sentTo(opened.id)).toBe(2);
    expect(ended(opened.captured)).toEqual([
      {
        type: "stream_stalled",
        message: expect.stringMatching(
          /^stream_stalled: timed out after \d+ ms waiting for a stream event$/,
        ),
      },
      null,
    ]);
    await opened.harness.close(context);
  });
});

/** A token command that fails the way `exit` says on its first run and leases a token after. */
const failingOnce = (name: string, exit: number) => {
  const path = join(scratch, name);
  const count = `${path}.count`;
  writeFileSync(count, "0");
  writeFileSync(
    path,
    `#!/bin/sh\nn=$(( $(cat '${count}') + 1 ))\necho $n > '${count}'\n[ $n -eq 1 ] && exit ${exit}\nprintf '{"access_token":"tok-%s","expires_at":%s}' $n ${Date.now() + 3_600_000}\n`,
  );
  chmodSync(path, 0o700);
  return { path, runs: () => Number(readFileSync(count, "utf8").trim()) };
};

describe("a failure before anything is sent", () => {
  test("a sign-in that cannot lease is not retried, even when its own text names a server error", async () => {
    const lease = failingOnce("lease 503 timed out, try again", 1);
    const opened = await session("sign-in", RETRY, {
      auth: { tokenCommand: lease.path, leaseRetryDelaysMs: [] },
    });
    const result = await opened.ask("Go.");

    expect(lease.runs()).toBe(1);
    expect(sentTo(opened.id)).toBe(0);
    expect(result.detail).toBe(
      "OpenAI API error: the route's credential is unavailable",
    );
    expect(
      await routeFailureOfSubmission(opened.conversation, result, context),
    ).toEqual({
      kind: "sign_in",
      detail: `the token command ${lease.path} exited with 1; check the refresher's sign-in`,
    });
    await opened.harness.close(context);
  });

  test("a sign-in that may work later is retried", async () => {
    const lease = failingOnce("lease-busy", 75);
    const opened = await session("sign-in-busy", RETRY, {
      auth: { tokenCommand: lease.path, leaseRetryDelaysMs: [] },
    });
    endpoint.respondTo(opened.id, answer("busy"));

    expect((await opened.ask("Go.")).status).toBe("done");
    expect(lease.runs()).toBe(2);
    expect(sentTo(opened.id)).toBe(1);
    await opened.harness.close(context);
  });

  test("a capture failure is not retried, even when its cause reads as a timeout", async () => {
    let requests = 0;
    const opened = await session("capture", RETRY, {
      capture: (event) => {
        if (event.type !== "model.request") return;
        requests += 1;
        throw new CaptureFailed({
          kind: "io",
          event: "model.request",
          detail: "ETIMEDOUT: timed out after 503 ms, try again",
        });
      },
    });
    const result = await opened.ask("Go.");

    expect(requests).toBe(1);
    expect(sentTo(opened.id)).toBe(0);
    expect(result.detail).toBe(
      "OpenAI API error: capture failed, the call could not be recorded",
    );
    expect(
      await routeFailureOfSubmission(opened.conversation, result, context),
    ).toEqual({
      kind: "capture",
      detail:
        "capture failed: model.request was not recorded: io: ETIMEDOUT: timed out after 503 ms, try again",
    });
    await opened.harness.close(context);
  });

  test("a binding that cannot be read is not retried, even when the route's IDs and its cause read as transient", async () => {
    const LOGICAL = "agent-route.run-500.server-error";
    let reads = 0;
    const models = createModels();
    models.setProvider(
      createAgentRouteProvider({
        credentialInspection: "ephemeral" as const,
        route: SOL_ROUTE,
        auth: { tokenCommand: token.path },
        fetch: endpoint.fetch,
        capture: () => undefined,
        logicalProvider: LOGICAL,
        readBinding: async () => {
          reads += 1;
          throw new Error("the binding store timed out (HTTP 503)");
        },
      }),
    );
    const opened = await openHarness(
      models,
      { provider: LOGICAL, modelId: SOL_ROUTE.model },
      RETRY,
    );
    const before = endpoint.received.length;
    const result = await opened.ask("Go.");

    expect(reads).toBe(1);
    expect(endpoint.received.length).toBe(before);
    expect(result.detail).toBe(
      "OpenAI API error: the agent route binding is missing or names another route",
    );
    expect(
      await routeFailureOfSubmission(opened.conversation, result, context),
    ).toEqual({
      kind: "binding",
      detail: `agent route binding unavailable for ${LOGICAL}: the binding store timed out (HTTP 503)`,
    });
    await opened.harness.close(context);
  });
});

test("a cancelled call is not retried", async () => {
  const opened = await session("cancelled", RETRY);
  endpoint.respondTo(opened.id, () =>
    sse([created("resp_c1")], { hold: true }),
  );
  const pending = opened.ask("Go.");
  while (sentTo(opened.id) === 0) await Bun.sleep(5);
  await opened.conversation.abort(context);
  const result = await pending;

  expect([result.status, result.reason]).toEqual(["unanswered", "aborted"]);
  expect(sentTo(opened.id)).toBe(1);
  await opened.harness.close(context);
});

describe("a context overflow", () => {
  const ANTHROPIC_KEY = "NEUVE_TEST_SCHEDULER_ANTHROPIC_KEY";
  process.env[ANTHROPIC_KEY] = "sk-ant-synthetic";
  afterAll(() => {
    delete process.env[ANTHROPIC_KEY];
  });

  const anthropicAnswer = (text: string) => () =>
    sse(
      [
        {
          type: "message_start",
          message: {
            id: "msg_a",
            type: "message",
            role: "assistant",
            content: [],
            model: OPUS_ROUTE.model,
            stop_reason: null,
            usage: { input_tokens: 10, output_tokens: 1 },
          },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 5 },
        },
        { type: "message_stop" },
      ],
      { headers: { "request-id": "req_a" } },
    );

  /**
   * One answered turn, then an overflow: pi compacts the earlier turn (the summary request is the
   * third one sent) and sends the request once more. A refusal pi took for anything else would end
   * the run after the second request.
   */
  const overflow = async (
    models: MutableModels,
    model: { readonly provider: string; readonly modelId: string },
    queue: (...responders: Array<Responder>) => () => number,
    answered: Responder,
    refusal: Responder,
  ) => {
    const sent = queue(answered, refusal, answered, answered);
    const opened = await openHarness(models, model, {
      ...RETRY,
      compaction: { enabled: true, keepRecentTokens: 1 },
    });
    expect((await opened.ask("First.")).status).toBe("done");
    const result = await opened.ask("Second.");
    const failed = (
      await opened.conversation.entries({}, 100, undefined, context)
    ).items.flatMap((entry) =>
      (entry.model ?? []).filter(
        (message): message is AssistantMessage =>
          message.role === "assistant" && message.stopReason === "error",
      ),
    );
    await opened.harness.close(context);
    return { result, sent: sent(), failed };
  };

  test("an OpenAI overflow goes to pi's compaction, never to a retry", async () => {
    const affinity = "overflow-openai";
    const id = conversationId(SESSION, affinity);
    const { result, sent, failed } = await overflow(
      createRouteModels({
        credentialInspection: "ephemeral" as const,
        route: SOL_ROUTE,
        auth: { tokenCommand: token.path },
        fetch: endpoint.fetch,
        capture: () => undefined,
        runId: SESSION,
        sessionAffinity: affinity,
      }),
      { provider: "openai", modelId: SOL_ROUTE.model },
      (...responders) => {
        endpoint.respondTo(id, ...responders);
        return () => sentTo(id);
      },
      answer("overflow"),
      refuse(
        400,
        "context_length_exceeded",
        "Your input exceeds the context window of this model",
        "req_50050050050050050050050050050050",
      ),
    );
    expect(result.status).toBe("done");
    expect(sent).toBe(4);
    expect(failed.map((turn) => turn.errorMessage)).toEqual([
      "OpenAI API error (HTTP 400): the request exceeds the context window",
    ]);
    expect(isContextOverflow(failed[0]!)).toBe(true);
    expect(routeFailureOf(failed[0]!)?.kind).toBe("context_overflow");
  });

  test("an Anthropic overflow, named only in the provider's message, goes to pi's compaction", async () => {
    const { result, sent, failed } = await overflow(
      createRouteModels({
        credentialInspection: "ephemeral" as const,
        route: { ...OPUS_ROUTE, credentialVariable: ANTHROPIC_KEY },
        fetch: endpoint.fetch,
        capture: () => undefined,
        runId: SESSION,
        sessionAffinity: "overflow-anthropic",
      }),
      { provider: "anthropic", modelId: OPUS_ROUTE.model },
      (...responders) => {
        const before = endpoint.received.length;
        endpoint.respond(...responders);
        return () => endpoint.received.length - before;
      },
      anthropicAnswer("Done."),
      () =>
        Response.json(
          {
            type: "error",
            error: {
              type: "invalid_request_error",
              message: "prompt is too long: 213462 tokens > 200000 maximum",
            },
          },
          { status: 400, headers: { "request-id": "req_011CA500429502" } },
        ),
    );
    expect(result.status).toBe("done");
    expect(sent).toBe(4);
    expect(failed.map((turn) => turn.errorMessage)).toEqual([
      "Anthropic API error (HTTP 400): the request exceeds the context window",
    ]);
    expect(isContextOverflow(failed[0]!)).toBe(true);
    expect(routeFailureOf(failed[0]!)).toEqual({
      kind: "context_overflow",
      status: 400,
      code: "invalid_request_error",
      requestId: "req_011CA500429502",
      detail:
        "Anthropic API error (HTTP 400, invalid_request_error): prompt is too long: 213462 tokens > 200000 maximum (request req_011CA500429502)",
    });
  });
});

test("each submission is told its own run's final failure across a tool round, a steered input, retries with the same text, a later run and a reopen", async () => {
  const affinity = "attribution";
  const id = conversationId(SESSION, affinity);
  const directory = mkdtempSync(join(tmpdir(), "scheduler-text-attribution-"));
  const note = defineTool({
    name: "note",
    description: "Note it.",
    parameters: schema({ type: "object", properties: {} }),
    execute: async () => ({ content: [{ type: "text", text: "noted" }] }),
  });
  const open = async () => {
    const registry = createRegistry();
    registry.install(defineExtension({ name: "notes", tools: [note] }));
    return Harness.open(
      await openNodeJsonlStorage(directory, context),
      {
        models: createRouteModels({
          credentialInspection: "ephemeral" as const,
          route: SOL_ROUTE,
          auth: { tokenCommand: token.path },
          fetch: endpoint.fetch,
          capture: () => undefined,
          runId: SESSION,
          sessionAffinity: affinity,
        }),
        registry,
        settings: { retry: { maxRetries: 1, baseDelayMs: 1 } },
      },
      context,
    );
  };
  let release = () => {};
  const steered = new Promise<void>((resolve) => {
    release = resolve;
  });
  endpoint.respondTo(
    id,
    async () => {
      await steered;
      return sse([
        created("resp_n"),
        ...functionCallItem(0, {
          id: "fc_n",
          callId: "call_n",
          name: "note",
          arguments: "{}",
        }),
        completed("resp_n"),
      ]);
    },
    refuse(500, "server_error", "First", "req_first"),
    refuse(500, "overloaded", "Second", "req_second"),
    refuse(401, "invalid_token", "Token revoked", "req_later"),
  );

  const before = await open();
  const conversation = await before.createConversation(
    {
      ownership: { kind: "ownerless" },
      agent: { model: { provider: "openai", modelId: SOL_ROUTE.model } },
    },
    context,
  );
  const first = await conversation.submit(
    { type: "input", content: "One." },
    context,
  );
  while (sentTo(id) === 0) await Bun.sleep(5);
  const second = await conversation.submit(
    { type: "input", content: "Also this.", whenBusy: "steer" },
    context,
  );
  release();
  const settled = [await first.wait(context), await second.wait(context)];
  const later = await (
    await conversation.submit({ type: "input", content: "Two." }, context)
  ).wait(context);
  const attributed = async (view: typeof conversation) =>
    Promise.all(
      [...settled, later].map((record) =>
        routeFailureOfSubmission(view, record, context),
      ),
    );
  const live = await attributed(conversation);
  await before.close(context);
  const after = await open();
  after.resume();
  const reopened = await attributed(
    (await after.conversation(conversation.id, context))!,
  );

  expect(sentTo(id)).toBe(4);
  expect(settled[1]!.entry).toBeGreaterThan(settled[0]!.entry!);
  expect(
    [...settled, later].map((record) => [record.status, record.detail]),
  ).toEqual([
    ["unanswered", "OpenAI API error (HTTP 500): server error"],
    ["unanswered", "OpenAI API error (HTTP 500): server error"],
    [
      "unanswered",
      "OpenAI API error (HTTP 401): the provider refused the credential or plan access",
    ],
  ]);
  const terminal: RouteFailure = {
    kind: "server",
    status: 500,
    code: "overloaded",
    requestId: "req_second",
    detail:
      "OpenAI API error (HTTP 500, overloaded): Second (request req_second)",
  };
  const refused: RouteFailure = {
    kind: "auth",
    status: 401,
    code: "invalid_token",
    requestId: "req_later",
    detail:
      "OpenAI API error (HTTP 401, invalid_token): Token revoked (request req_later)",
  };
  expect(live).toEqual([terminal, terminal, refused]);
  expect(reopened).toEqual([terminal, terminal, refused]);
  await after.close(context);
});

test("each kind's scheduler text is what pi's own classifiers read it as", () => {
  const read = (failure: RouteFailure, transient = false) => {
    const message: AssistantMessage = {
      role: "assistant",
      content: [],
      api: "openai-responses",
      provider: "openai",
      model: SOL_ROUTE.model,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "error",
      errorMessage: schedulerText("OpenAI API error", failure, transient),
      timestamp: 1,
    };
    return isContextOverflow(message)
      ? "overflow"
      : isRetryableAssistantError(message)
        ? "retried"
        : "final";
  };
  const failures: ReadonlyArray<RouteFailure> = [
    { kind: "auth", status: 401 },
    { kind: "auth", status: 503 },
    { kind: "plan_quota", status: 429 },
    { kind: "rate_limit", status: 429 },
    { kind: "context_overflow", status: 400 },
    { kind: "context_overflow", status: 500 },
    { kind: "invalid_request", status: 400 },
    { kind: "invalid_request", status: 502 },
    { kind: "server", status: 500 },
    { kind: "server", status: 529 },
    { kind: "provider", status: 409 },
    { kind: "stream" },
    { kind: "stalled" },
    { kind: "sign_in" },
    { kind: "binding" },
    { kind: "capture" },
    { kind: "aborted" },
  ];
  expect(
    failures.map((failure) => [
      failure.kind,
      failure.status ?? null,
      read(failure),
    ]),
  ).toEqual([
    ["auth", 401, "final"],
    ["auth", 503, "final"],
    ["plan_quota", 429, "final"],
    ["rate_limit", 429, "retried"],
    ["context_overflow", 400, "overflow"],
    ["context_overflow", 500, "overflow"],
    ["invalid_request", 400, "final"],
    ["invalid_request", 502, "final"],
    ["server", 500, "retried"],
    ["server", 529, "retried"],
    ["provider", 409, "final"],
    ["stream", null, "retried"],
    ["stalled", null, "retried"],
    ["sign_in", null, "final"],
    ["binding", null, "final"],
    ["capture", null, "final"],
    ["aborted", null, "final"],
  ]);
  expect(read({ kind: "sign_in" }, true)).toBe("retried");
});
