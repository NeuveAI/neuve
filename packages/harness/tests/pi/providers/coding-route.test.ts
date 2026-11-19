import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type {
  AssistantMessage,
  MutableModels,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import {
  Harness,
  MemoryStorage,
  createRegistry,
  defineExtension,
  defineTool,
  type Conversation,
  type ConversationId,
  type Extension,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { OPUS_ROUTE, SOL_ROUTE } from "../../../src/route.ts";
import type { ModelCaptureEvent } from "../../../src/pi/capture/types.ts";
import {
  createRouteModels,
  routeToolArguments,
  type RouteModelsOptions,
} from "../../../src/pi/providers/agent-route-provider.ts";
import { routeFailureOfSubmission } from "../../../src/pi/providers/failure.ts";
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
} from "./fixture.ts";

// A coding session runs pi's own Harness over the route's `Models`, as the host's channel worker
// does: the native coding tools, the physical provider's ID, and the channel's ID as the run.

const context = BACKGROUND_CONTEXT;
const endpoint = openEndpoint();
afterAll(() => endpoint.stop());
const scratch = mkdtempSync(join(tmpdir(), "coding-route-"));
const token = tokenCommand(scratch, "lease");
const workdir = mkdtempSync(join(tmpdir(), "coding-route-work-"));
writeFileSync(join(workdir, "notes.txt"), "one\ntwo\nthree\n");

const SESSION = "01JCHANNELCODING";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The coding tools as the host composes them: the route's preparation, then each tool's own repair. */
const codingTools = (prepared: Array<unknown>) => {
  const prepare = routeToolArguments(SOL_ROUTE)!;
  return defineExtension({
    name: "coding-tools",
    tools: CodingTools.tools!.map((tool): ToolRegistration => ({
      ...(tool as ToolRegistration),
      prepareArguments: (args) => {
        const ready = prepare(args, tool.parameters);
        prepared.push(ready);
        return tool.prepareArguments?.(ready as never) ?? ready;
      },
    })),
  });
};

const routeModels = (
  captured: Array<ModelCaptureEvent>,
  change: Partial<Omit<RouteModelsOptions, "purpose">> = {},
) =>
  createRouteModels({
    credentialInspection: "ephemeral" as const,
    route: SOL_ROUTE,
    auth: { tokenCommand: token.path },
    fetch: endpoint.fetch,
    capture: (event) => captured.push(event),
    runId: SESSION,
    sessionAffinity: SESSION,
    ...change,
  });

const openSession = async (
  models: MutableModels,
  extension: Extension,
  retry: { readonly maxRetries: number; readonly baseDelayMs?: number },
) => {
  const registry = createRegistry();
  registry.install(extension);
  const harness = await Harness.open(
    new MemoryStorage(),
    {
      models,
      registry,
      env: () => new NodeExecutionEnv({ cwd: workdir }),
      settings: { retry },
    },
    context,
  );
  const conversation = await harness.createConversation(
    {
      ownership: { kind: "ownerless" },
      agent: { model: { provider: "openai", modelId: SOL_ROUTE.model } },
    },
    context,
  );
  const ask = async (content: string) =>
    (await conversation.submit({ type: "input", content }, context)).wait(
      context,
    );
  return { harness, conversation, ask };
};

describe("a coding session on the route's Models", () => {
  const captured: Array<ModelCaptureEvent> = [];

  test("runs the native coding tools, keeps the model's nulls in the transcript and captures each call under the session", async () => {
    const models = routeModels(captured);
    expect(models.getProviders().map((provider) => provider.id)).toEqual([
      "openai",
    ]);
    expect(models.getModel("openai", SOL_ROUTE.model)).toMatchObject({
      provider: "openai",
      id: "gpt-6.1-sol",
      api: "openai-responses",
    });

    const session = conversationId(SESSION, SESSION);
    endpoint.respondTo(
      session,
      () =>
        sse([
          created("resp_c_1"),
          ...functionCallItem(0, {
            id: "fc_c_1",
            callId: "call_c_1",
            name: "read",
            arguments: '{"path": "notes.txt", "offset": null}',
          }),
          completed("resp_c_1", {
            input_tokens: 300,
            input_tokens_details: { cached_tokens: 128 },
            output_tokens: 12,
            total_tokens: 312,
          }),
        ]),
      () =>
        sse([
          created("resp_c_2"),
          ...messageItem(0, "msg_c_2", "final_answer", "It lists three."),
          completed("resp_c_2"),
        ]),
    );
    const prepared: Array<unknown> = [];
    const { harness, conversation, ask } = await openSession(
      models,
      codingTools(prepared),
      {
        maxRetries: 0,
      },
    );

    const answered = await ask("What is in notes.txt?");
    expect(answered.status).toBe("done");
    expect(
      await routeFailureOfSubmission(conversation, answered, context),
    ).toBeUndefined();

    expect(prepared).toEqual([{ path: "notes.txt" }]);
    const messages = (await conversation.context(context)).messages;
    const assistants = messages.filter(
      (message): message is AssistantMessage => message.role === "assistant",
    );
    expect(
      assistants[0]!.content.find((block) => block.type === "toolCall"),
    ).toMatchObject({
      name: "read",
      arguments: { path: "notes.txt", offset: null },
    });
    const result = messages.find(
      (message): message is ToolResultMessage => message.role === "toolResult",
    )!;
    expect(result.isError).toBe(false);
    expect(result.content).toEqual([
      { type: "text", text: "one\ntwo\nthree\n" },
    ]);
    expect(
      assistants.map((message) => [message.provider, message.model]),
    ).toEqual([
      ["openai", "gpt-6.1-sol"],
      ["openai", "gpt-6.1-sol"],
    ]);

    const sent = endpoint.received.filter(
      (request) => request.headers.get("session-id") === session,
    );
    expect(sent).toHaveLength(2);
    const offered = sent[0]!.body["tools"] as Array<{
      description: string;
      tools: Array<{ name: string; strict: boolean }>;
    }>;
    expect(offered[0]!.description).toBe("Neuve's tools.");
    expect(offered[0]!.tools.map((tool) => [tool.name, tool.strict])).toEqual([
      ["read", false],
      ["write", false],
      ["edit", false],
      ["bash", false],
    ]);
    expect(sent[1]!.body["input"]).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "What is in notes.txt?" }],
      },
      {
        type: "function_call",
        call_id: "call_c_1",
        name: "read",
        namespace: "neuve",
        arguments: '{"path":"notes.txt","offset":null}',
      },
      {
        type: "function_call_output",
        call_id: "call_c_1",
        output: "one\ntwo\nthree\n",
      },
    ]);
    expect(JSON.stringify(sent.map((request) => request.body))).not.toContain(
      SESSION,
    );

    const requests = captured.filter((event) => event.type === "model.request");
    expect(
      requests.map((event) => [
        event.scope,
        event.route,
        event.provider,
        event.model,
      ]),
    ).toEqual(
      Array(2).fill([{ runId: SESSION }, "openai", "openai", "gpt-6.1-sol"]),
    );
    expect(requests.map((event) => event.logicalRoute)).toEqual([
      undefined,
      undefined,
    ]);
    expect(
      captured
        .filter((event) => event.type === "model.response")
        .map((event) => event.responseId),
    ).toEqual(["resp_c_1", "resp_c_2"]);
    const ends = captured.filter((event) => event.type === "model.end");
    expect(
      ends.map((event) => [event.responseId, event.messageTimestamp]),
    ).toEqual(
      assistants.map((message) => [message.responseId, message.timestamp]),
    );
    expect(ends[0]).toEqual({
      type: "model.end",
      scope: { runId: SESSION },
      callId: requests[0]!.callId,
      outcome: "completed",
      responseId: "resp_c_1",
      messageTimestamp: assistants[0]!.timestamp,
      sdkUsage: assistants[0]!.usage,
      stopReason: "toolUse",
      usage: {
        input: 172,
        output: 12,
        cacheRead: 128,
        cacheWrite: 0,
        reasoning: 0,
        totalTokens: 312,
      },
    });
    expect(
      captured.find(
        (event) =>
          event.type === "model.event" &&
          event.name === "function_call.arguments",
      ),
    ).toMatchObject({
      data: {
        raw: '{"path": "notes.txt", "offset": null}',
        arguments: { path: "notes.txt", offset: null },
        replay: '{"path":"notes.txt","offset":null}',
      },
    });
    for (const event of requests) expect(event.callId).toMatch(UUID);
    await harness.close(context);
  });

  test("a rebuilt factory keeps the session's cache affinity and mints call IDs of its own", async () => {
    const before = new Set(captured.map((event) => event.callId));
    expect(before.size).toBe(2);
    const again: Array<ModelCaptureEvent> = [];
    const models = routeModels(again, {
      agent: "coder",
      conversationId: 3 as ConversationId,
    });
    const session = conversationId(SESSION, SESSION);
    endpoint.respondTo(session, () =>
      sse([
        created("resp_c_3"),
        ...messageItem(0, "msg_c_3", "final_answer", "Again."),
        completed("resp_c_3"),
      ]),
    );
    const sent = endpoint.received.length;

    const message = await models.complete(
      models.getModel("openai", SOL_ROUTE.model)!,
      { messages: [{ role: "user", content: "Again.", timestamp: 1 }] },
    );

    expect(message.stopReason).toBe("stop");
    expect(endpoint.received[sent]!.headers.get("session-id")).toBe(session);
    const request = again.find((event) => event.type === "model.request")!;
    expect(request.scope).toEqual({
      runId: SESSION,
      agent: "coder",
      conversationId: 3,
    });
    expect(request.callId).toMatch(UUID);
    expect(before.has(request.callId)).toBe(false);
  });
});

// A native tool with a referenced optional object, as the channel's own tools may declare: pi's
// constrained sampling refuses `$defs`, so it is offered without, as the coding tools are.
describe("a native tool's null arguments on the plan route", () => {
  const PARAMETERS = schema({
    type: "object",
    $defs: {
      range: {
        type: "object",
        properties: { start: { type: "integer" }, end: { type: "integer" } },
        required: ["start"],
      },
    },
    properties: {
      path: { type: "string" },
      range: { $ref: "#/$defs/range" },
      anchor: {
        type: "object",
        properties: { line: { type: "integer" }, side: { type: "string" } },
        required: ["line"],
      },
      pick: {
        anyOf: [
          {
            type: "object",
            properties: { x: { type: "string" }, y: { type: "string" } },
            required: ["x"],
          },
          {
            type: "object",
            properties: { z: { type: "integer" } },
            required: ["z"],
          },
        ],
      },
      reason: { anyOf: [{ type: "string" }, { type: "null" }] },
    },
    required: ["path"],
  });
  const WRITTEN =
    '{"path":"a.ts","range":null,"anchor":{"line":3,"side":null},"pick":{"x":"1","y":null},"reason":null}';

  /** One session whose `note` tool records what it executed with, its arguments prepared or not. */
  const session = async (affinity: string, prepare: boolean) => {
    const executed: Array<unknown> = [];
    const prepareArguments = routeToolArguments(SOL_ROUTE)!;
    const note = defineTool({
      name: "note",
      description: "Note a range.",
      parameters: PARAMETERS,
      ...(prepare
        ? {
            prepareArguments: (args: unknown) =>
              prepareArguments(args, PARAMETERS) as never,
          }
        : {}),
      execute: async (args) => {
        executed.push(args);
        return { content: [{ type: "text", text: "noted" }] };
      },
    });
    endpoint.respondTo(
      conversationId(SESSION, affinity),
      () =>
        sse([
          created(`resp_${affinity}_1`),
          ...functionCallItem(0, {
            id: `fc_${affinity}`,
            callId: `call_${affinity}`,
            name: "note",
            arguments: WRITTEN,
          }),
          completed(`resp_${affinity}_1`),
        ]),
      () =>
        sse([
          created(`resp_${affinity}_2`),
          ...messageItem(0, `msg_${affinity}`, "final_answer", "Done."),
          completed(`resp_${affinity}_2`),
        ]),
    );
    const { harness, conversation, ask } = await openSession(
      routeModels([], { sessionAffinity: affinity }),
      defineExtension({ name: "notes", tools: [note] }),
      { maxRetries: 0 },
    );
    expect((await ask("Note it.")).status).toBe("done");
    const messages = (await conversation.context(context)).messages;
    await harness.close(context);
    const call = messages
      .flatMap((message) =>
        message.role === "assistant" ? message.content : [],
      )
      .find((block) => block.type === "toolCall");
    const result = messages.find(
      (message): message is ToolResultMessage => message.role === "toolResult",
    )!;
    return {
      executed,
      written: call?.type === "toolCall" ? call.arguments : undefined,
      isError: result.isError,
      text: result.content.map((part) =>
        part.type === "text" ? part.text : "",
      ),
    };
  };

  test("pi refuses a null on a referenced optional object, and the route's preparation lets the tool run with only the added nulls gone", async () => {
    const raw = await session("unprepared", false);
    expect(raw.executed).toEqual([]);
    expect(raw.isError).toBe(true);
    expect(raw.text.join("")).toMatch(/range/);

    const prepared = await session("prepared", true);
    expect(prepared.executed).toEqual([
      { path: "a.ts", anchor: { line: 3 }, pick: { x: "1" }, reason: null },
    ]);
    expect(prepared.isError).toBe(false);
    expect(prepared.text).toEqual(["noted"]);
    expect(prepared.written).toEqual({
      path: "a.ts",
      range: null,
      anchor: { line: 3, side: null },
      pick: { x: "1", y: null },
      reason: null,
    });
  });
});

describe("retries on a coding session", () => {
  const retryAfter = "Fri, 01 Jan 2100 00:00:00 GMT";
  const refusal = (code: string, message: string) => (): Response =>
    Response.json(
      { error: { code, message } },
      { status: 429, headers: { "retry-after": retryAfter } },
    );

  test("pi retries a rate limit on its own bounded backoff, not the route's Retry-After, and never retries the plan's usage limit", async () => {
    const captured: Array<ModelCaptureEvent> = [];
    const limited = routeModels(captured, { sessionAffinity: "rate-limit" });
    endpoint.respondTo(
      conversationId(SESSION, "rate-limit"),
      refusal("rate_limit_exceeded", "Slow down"),
      refusal("rate_limit_exceeded", "Slow down"),
    );
    const rate = await openSession(limited, codingTools([]), {
      maxRetries: 1,
      baseDelayMs: 20,
    });
    // The route's Retry-After is in the year 2100: a session that waited for it never settles.
    const settled = await rate.ask("Go.");
    expect(settled).toMatchObject({
      status: "unanswered",
      reason: "model_error",
      detail: "OpenAI API error (HTTP 429): rate limited by the provider",
    });
    expect(
      await routeFailureOfSubmission(rate.conversation, settled, context),
    ).toEqual({
      kind: "rate_limit",
      retryAfterAt: 4_102_444_800_000,
      status: 429,
      code: "rate_limit_exceeded",
      detail: "OpenAI API error (HTTP 429, rate_limit_exceeded): Slow down",
    });
    expect(
      captured
        .filter(
          (event) =>
            event.type === "model.event" && event.name === "http_error",
        )
        .map((event) => (event.type === "model.event" ? event.data : null)),
    ).toEqual([
      {
        status: 429,
        code: "rate_limit_exceeded",
        retryAfter,
        bodyRedactions: [],
        body: JSON.stringify({
          error: { code: "rate_limit_exceeded", message: "Slow down" },
        }),
      },
      {
        status: 429,
        code: "rate_limit_exceeded",
        retryAfter,
        bodyRedactions: [],
        body: JSON.stringify({
          error: { code: "rate_limit_exceeded", message: "Slow down" },
        }),
      },
    ]);
    await rate.harness.close(context);

    const quota = routeModels([], { sessionAffinity: "usage-limit" });
    const session = conversationId(SESSION, "usage-limit");
    endpoint.respondTo(
      session,
      refusal(
        "subscription_sharing_usage_limit_exceeded",
        "Usage limit reached",
      ),
      refusal(
        "subscription_sharing_usage_limit_exceeded",
        "Usage limit reached",
      ),
    );
    const plan = await openSession(quota, codingTools([]), {
      maxRetries: 3,
      baseDelayMs: 20,
    });
    const quotaSettled = await plan.ask("Go.");
    expect(quotaSettled.status).toBe("unanswered");
    expect(
      await routeFailureOfSubmission(plan.conversation, quotaSettled, context),
    ).toEqual({
      kind: "plan_quota",
      retryAfterAt: 4_102_444_800_000,
      status: 429,
      code: "subscription_sharing_usage_limit_exceeded",
      detail:
        "OpenAI API error (HTTP 429, subscription_sharing_usage_limit_exceeded): Usage limit reached",
    });
    expect(
      endpoint.received.filter(
        (request) => request.headers.get("session-id") === session,
      ),
    ).toHaveLength(1);
    await plan.harness.close(context);
  });
});

test("each settled submission keeps its own run's failure across retries, later runs and a reopen", async () => {
  const refuse = (status: number, code: string, message: string) => () =>
    Response.json({ error: { code, message } }, { status });
  const session = conversationId(SESSION, "attribution");
  endpoint.respondTo(
    session,
    refuse(500, "server_error", "Try again"),
    refuse(401, "invalid_token", "Token revoked"),
    refuse(
      429,
      "subscription_sharing_usage_limit_exceeded",
      "Usage limit reached",
    ),
    refuse(500, "server_error", "Try again"),
    refuse(500, "server_error", "Try again"),
  );
  const directory = mkdtempSync(join(tmpdir(), "coding-route-attribution-"));
  const open = async () => {
    const registry = createRegistry();
    registry.install(codingTools([]));
    return Harness.open(
      await openNodeJsonlStorage(directory, context),
      {
        models: routeModels([], { sessionAffinity: "attribution" }),
        registry,
        env: () => new NodeExecutionEnv({ cwd: workdir }),
        settings: { retry: { maxRetries: 1, baseDelayMs: 20 } },
      },
      context,
    );
  };
  const ask = async (conversation: Conversation, content: string) =>
    (await conversation.submit({ type: "input", content }, context)).wait(
      context,
    );

  const before = await open();
  const conversation = await before.createConversation(
    {
      ownership: { kind: "ownerless" },
      agent: { model: { provider: "openai", modelId: SOL_ROUTE.model } },
    },
    context,
  );
  const first = await ask(conversation, "One.");
  const second = await ask(conversation, "Two.");
  await before.close(context);
  const after = await open();
  after.resume();
  const reopened = (await after.conversation(conversation.id, context))!;
  const third = await ask(reopened, "Three.");

  expect(
    [first, second, third].map((settled) => [settled.status, settled.detail]),
  ).toEqual([
    [
      "unanswered",
      "OpenAI API error (HTTP 401): the provider refused the credential or plan access",
    ],
    [
      "unanswered",
      "OpenAI API error: quota exceeded, the account's usage quota is used up",
    ],
    ["unanswered", "OpenAI API error (HTTP 500): server error"],
  ]);
  expect(
    await Promise.all(
      [first, second, third].map((settled) =>
        routeFailureOfSubmission(reopened, settled, context),
      ),
    ),
  ).toEqual([
    {
      kind: "auth",
      status: 401,
      code: "invalid_token",
      detail: "OpenAI API error (HTTP 401, invalid_token): Token revoked",
    },
    {
      kind: "plan_quota",
      status: 429,
      code: "subscription_sharing_usage_limit_exceeded",
      detail:
        "OpenAI API error (HTTP 429, subscription_sharing_usage_limit_exceeded): Usage limit reached",
    },
    {
      kind: "server",
      status: 500,
      code: "server_error",
      detail: "OpenAI API error (HTTP 500, server_error): Try again",
    },
  ]);
  expect(
    endpoint.received.filter(
      (request) => request.headers.get("session-id") === session,
    ),
  ).toHaveLength(5);
  await after.close(context);
});

describe("the route's Models", () => {
  const OTHERS = ["anthropic", "google", "amazon-bedrock", "openai-codex"];

  test("list only the configured plan route, check its sign-in without leasing a token, and send to the public Responses API with the Neuve token alone", async () => {
    const lease = tokenCommand(scratch, "lease-catalogue");
    const urls: Array<string> = [];
    const captured: Array<ModelCaptureEvent> = [];
    const models = routeModels(captured, {
      auth: { tokenCommand: lease.path },
      sessionAffinity: "catalogue",
      fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
        urls.push(input instanceof Request ? input.url : String(input));
        return endpoint.fetch(input, init);
      }) as typeof globalThis.fetch,
    });
    const AMBIENT = "sk-ambient-openai-not-neuve";

    expect(
      models.getProviders().map((provider) => [provider.id, provider.name]),
    ).toEqual([["openai", "OpenAI (ChatGPT plan)"]]);
    expect(
      models
        .getModels()
        .map((model) => [model.provider, model.id, model.baseUrl]),
    ).toEqual([["openai", "gpt-6.1-sol", "https://api.openai.com/v1"]]);
    expect(
      (await models.getAvailable()).map((model) => [model.provider, model.id]),
    ).toEqual([["openai", "gpt-6.1-sol"]]);
    expect(await models.checkAuth("openai")).toEqual({
      source: "neuve-sign-in",
      type: "api_key",
    });
    expect(
      await models.getAuth("openai", { env: { OPENAI_API_KEY: AMBIENT } }),
    ).toEqual({ auth: {}, source: "neuve-sign-in" });
    for (const other of OTHERS) {
      expect(models.getModels(other)).toEqual([]);
      expect(await models.checkAuth(other)).toBeUndefined();
    }
    expect(lease.runs()).toBe(0);

    endpoint.respondTo(conversationId(SESSION, "catalogue"), () =>
      sse([
        created("resp_k"),
        ...messageItem(0, "msg_k", "final_answer", "Listed."),
        completed("resp_k"),
      ]),
    );
    const message = await models.complete(
      models.getModel("openai", SOL_ROUTE.model)!,
      { messages: [{ role: "user", content: "List.", timestamp: 1 }] },
      { apiKey: AMBIENT, headers: { "x-caller": "kept" } },
    );

    expect(message.stopReason).toBe("stop");
    expect(lease.runs()).toBe(1);
    expect(urls).toEqual(["https://api.openai.com/v1/responses"]);
    const sent = endpoint.received.at(-1)!;
    expect(sent.headers.get("authorization")).toBe("Bearer tok-1");
    expect(captured[0]).toMatchObject({
      type: "model.request",
      headerNames: expect.arrayContaining(["authorization", "session-id"]),
    });
    const kept = JSON.stringify(captured);
    for (const secret of ["tok-1", AMBIENT, "Bearer"])
      expect(kept).not.toContain(secret);
  });

  test("an Anthropic session lists only its route, resolves only the route's own key variable, and is the only route that skips tool argument preparation", async () => {
    const VARIABLE = "NEUVE_TEST_CODING_ANTHROPIC_KEY";
    const models = createRouteModels({
      credentialInspection: "ephemeral" as const,
      route: { ...OPUS_ROUTE, credentialVariable: VARIABLE },
      capture: () => undefined,
      runId: SESSION,
      sessionAffinity: SESSION,
    });

    expect(routeToolArguments(OPUS_ROUTE)).toBeUndefined();
    expect(routeToolArguments(SOL_ROUTE)).toBeDefined();
    expect(
      models.getModels().map((model) => [model.provider, model.id]),
    ).toEqual([["anthropic", OPUS_ROUTE.model]]);
    expect(
      await models.getAuth("anthropic", {
        env: { ANTHROPIC_API_KEY: "sk-ant-ambient" },
      }),
    ).toBeUndefined();
    expect(
      await models.getAuth("anthropic", {
        env: { [VARIABLE]: "sk-ant-route" },
      }),
    ).toEqual({ auth: { apiKey: "sk-ant-route" }, source: VARIABLE });
    for (const other of ["openai", ...OTHERS.slice(1)])
      expect(await models.checkAuth(other)).toBeUndefined();
  });
});
