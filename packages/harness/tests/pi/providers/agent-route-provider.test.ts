import { openRunLog } from "../../../src/run-log.ts";
import { storeLocationIn } from "@neuve/records-core";
import { callUsageOf } from "../../../src/pi/providers/usage.ts";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createModels,
  isRetryableAssistantError,
  validateToolArguments,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type Tool,
  type ToolCall,
} from "@earendil-works/pi-ai";
import type { ConversationId } from "@earendil-works/pi-durable";
import { conversationId } from "../../../src/pi/providers/wire.ts";
import { OPUS_ROUTE, SOL_ROUTE, costOf } from "../../../src/route.ts";
import {
  CaptureFailed,
  type ModelCaptureEvent,
} from "../../../src/pi/capture/types.ts";
import type { AgentRouteBinding } from "../../../src/pi/contracts.ts";
import { SourceOwnership } from "../../../src/pi/source-ownership.ts";
import { createPrivateInspection } from "../../../src/pi/capture/private-inspection.ts";
import { routeFailureOf } from "../../../src/pi/providers/failure.ts";
import {
  createAgentRouteProvider,
  routeToolArguments,
  type AgentRouteProviderOptions,
} from "../../../src/pi/providers/agent-route-provider.ts";
import {
  completed,
  created,
  functionCallItem,
  messageItem,
  openEndpoint,
  reasoningItem,
  schema,
  sse,
  tokenCommand,
} from "./fixture.ts";

// The route's provider speaks to OpenAI's subscription route and Anthropic through pi-ai's own
// adapters and `Models`, so these tests drive a real local HTTP server with literal SSE and read
// the request bodies the route actually received.

const endpoint = openEndpoint();
afterAll(() => endpoint.stop());
const scratch = mkdtempSync(join(tmpdir(), "agent-route-provider-"));

const LOGICAL = "agent-route.run-1.understand";

const bindingOf = (
  change: Partial<AgentRouteBinding> = {},
): AgentRouteBinding => ({
  runId: "run-1",
  stage: "frame",
  agent: "frame",
  conversationId: 7 as ConversationId,
  logicalProvider: LOGICAL,
  physicalProvider: "openai",
  physicalModel: SOL_ROUTE.model,
  mode: { kind: "normal" },
  ...change,
});

const SCOPE = {
  runId: "run-1",
  stage: "frame",
  agent: "frame",
  conversationId: 7,
};

/** The route's provider in pi's `Models`, reading whatever binding `state` holds at dispatch. */
const routed = (
  state: { binding: AgentRouteBinding | undefined },
  captured: Array<ModelCaptureEvent>,
  change: Partial<AgentRouteProviderOptions> = {},
) => {
  const options: AgentRouteProviderOptions = {
    credentialInspection: "ephemeral",
    route: SOL_ROUTE,
    baseUrl: `${endpoint.server.url.origin}/v1`,
    capture: (event) => captured.push(event),
    logicalProvider: LOGICAL,
    readBinding: async () => {
      if (state.binding === undefined)
        throw new Error("conversation 7 has no agent route");
      return state.binding;
    },
    ...change,
  };
  const models = createModels();
  models.setProvider(createAgentRouteProvider(options));
  return {
    models,
    model: models.getModel(options.logicalProvider, options.route.model)!,
  };
};

const user = (text: string) => ({
  role: "user" as const,
  content: text,
  timestamp: 1,
});

const TOOLS: Array<Tool> = [
  {
    name: "submit",
    description: "Submit.",
    parameters: schema({
      type: "object",
      properties: { path: { type: "string" }, note: { type: "string" } },
      required: ["path"],
    }),
    constrainedSampling: { type: "json_schema", strict: "require" },
  },
  {
    name: "read",
    description: "Read.",
    parameters: schema({
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    }),
  },
];

/** The model wrote spaces into its arguments; pi parses them and replays its own serialization. */
const RAW_ARGUMENTS = '{"path": "a.ts", "note": null}';

const ROUND_ONE = [
  created("resp_1"),
  ...reasoningItem(0, "rs_1", "enc-1"),
  ...messageItem(1, "msg_1", "commentary", "Checking."),
  ...functionCallItem(2, {
    id: "fc_1",
    callId: "call_1",
    name: "submit",
    arguments: RAW_ARGUMENTS,
  }),
  completed("resp_1", {
    input_tokens: 100,
    input_tokens_details: { cached_tokens: 64 },
    output_tokens: 20,
    output_tokens_details: { reasoning_tokens: 8 },
    total_tokens: 120,
  }),
];

const finalRound = (text: string) => [
  created("resp_2"),
  ...messageItem(0, "msg_2", "final_answer", text),
  completed("resp_2"),
];

const FINAL_SCHEMA = {
  type: "object",
  properties: { verdict: { type: "string" }, reason: { type: "string" } },
  required: ["verdict"],
};

const callEvents = (captured: ReadonlyArray<ModelCaptureEvent>, at: number) =>
  captured.filter((event) => event.callId === captured[at]!.callId);

const namesOf = (events: ReadonlyArray<ModelCaptureEvent>) =>
  events.map((event) =>
    event.type === "model.event" ? event.name : event.type,
  );

describe("the OpenAI route", () => {
  test("sends the route's request, replays the history and makes the final generation the binding asks for", async () => {
    const token = tokenCommand(scratch, "lease-shape");
    const captured: Array<ModelCaptureEvent> = [];
    const state = { binding: bindingOf() };
    const { models, model } = routed(state, captured, {
      auth: { tokenCommand: token.path },
    });
    expect(model).toMatchObject({
      id: "gpt-6.1-sol",
      provider: LOGICAL,
      api: "openai-responses",
    });
    expect(models.getProviders().map((provider) => provider.id)).toEqual([
      LOGICAL,
    ]);
    expect(
      (await models.getAvailable()).map((model) => [model.provider, model.id]),
    ).toEqual([[LOGICAL, "gpt-6.1-sol"]]);
    expect(await models.checkAuth("openai")).toBeUndefined();
    expect(token.runs()).toBe(0);
    endpoint.received.length = 0;
    endpoint.respond(() => sse(ROUND_ONE));
    const context: Context = {
      systemPrompt: "You review.",
      messages: [user("Review it.")],
      tools: TOOLS,
    };
    const first = await models.complete(model, context);

    expect(endpoint.received[0]!.path).toBe("/v1/responses");
    expect(endpoint.received[0]!.headers.get("authorization")).toBe(
      "Bearer tok-1",
    );
    expect(endpoint.received[0]!.headers.get("session-id")).toBe(
      conversationId("run-1", "frame"),
    );
    expect(endpoint.received[0]!.body).toEqual({
      model: "gpt-6.1-sol",
      instructions: "You review.",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Review it." }],
        },
      ],
      tools: [
        {
          type: "namespace",
          name: "neuve",
          description: "Neuve's review tools.",
          tools: [
            {
              type: "function",
              name: "submit",
              description: "Submit.",
              parameters: {
                type: "object",
                properties: {
                  path: { type: "string" },
                  note: { anyOf: [{ type: "string" }, { type: "null" }] },
                },
                required: ["path", "note"],
                additionalProperties: false,
              },
              strict: true,
            },
            {
              type: "function",
              name: "read",
              description: "Read.",
              parameters: {
                type: "object",
                properties: { path: { type: "string" } },
                required: ["path"],
              },
              strict: false,
            },
          ],
        },
      ],
      tool_choice: "auto",
      reasoning: { effort: "medium", context: "all_turns" },
      include: ["reasoning.encrypted_content"],
      store: false,
      stream: true,
    });

    expect(first.stopReason).toBe("toolUse");
    expect(first.provider).toBe(LOGICAL);
    expect(first.model).toBe("gpt-6.1-sol");
    const call = first.content.find((block) => block.type === "toolCall")!;
    expect(call).toEqual({
      type: "toolCall",
      id: "call_1|fc_1",
      name: "submit",
      namespace: "neuve",
      arguments: { path: "a.ts", note: null },
    });
    expect(first.usage).toMatchObject({
      input: 36,
      cacheRead: 64,
      cacheWrite: 0,
      output: 20,
      reasoning: 8,
    });
    expect(costOf(SOL_ROUTE, callUsageOf(first.usage))).toBeNull();

    state.binding = bindingOf({
      mode: { kind: "final", schema: FINAL_SCHEMA },
    });
    endpoint.respond(() =>
      sse(finalRound('{"verdict":"clean","reason":null}')),
    );
    const second = await models.complete(model, {
      ...context,
      messages: [
        user("Review it."),
        first,
        {
          role: "toolResult",
          toolCallId: call.id,
          toolName: "submit",
          content: [{ type: "text", text: "ok" }],
          isError: false,
          timestamp: 2,
        },
      ],
    });

    const replay = endpoint.received[1]!.body;
    expect(replay["input"]).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Review it." }],
      },
      {
        type: "reasoning",
        id: "rs_1",
        summary: [],
        encrypted_content: "enc-1",
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Checking.", annotations: [] }],
        phase: "commentary",
      },
      {
        type: "function_call",
        call_id: "call_1",
        name: "submit",
        namespace: "neuve",
        arguments: '{"path":"a.ts","note":null}',
      },
      { type: "function_call_output", call_id: "call_1", output: "ok" },
    ]);
    expect(replay["tool_choice"]).toBe("none");
    expect(replay["text"]).toEqual({
      format: {
        type: "json_schema",
        name: "stage_output",
        strict: true,
        schema: {
          type: "object",
          properties: {
            verdict: { type: "string" },
            reason: { anyOf: [{ type: "string" }, { type: "null" }] },
          },
          required: ["verdict", "reason"],
          additionalProperties: false,
        },
      },
    });
    expect(
      (replay["tools"] as Array<{ tools: Array<unknown> }>)[0]!.tools,
    ).toHaveLength(2);
    expect(endpoint.received[1]!.headers.get("session-id")).toBe(
      conversationId("run-1", "frame"),
    );
    expect(second.stopReason).toBe("stop");
    const text = second.content.find((block) => block.type === "text")!;
    expect(JSON.parse(text.type === "text" ? text.text : "")).toEqual({
      verdict: "clean",
      reason: null,
    });
    expect(token.runs()).toBe(1);

    const firstCall = callEvents(captured, 0);
    expect(namesOf(firstCall)).toEqual([
      "model.request",
      "credential_guard",
      "model.response",
      "response.created",
      "response.output_item.added",
      "response.output_item.done",
      "response.output_item.added",
      "response.output_text.delta",
      "response.output_item.done",
      "response.output_item.added",
      "response.function_call_arguments.delta",
      "response.output_item.done",
      "response.completed",
      "sdk_invocation_end",
      "function_call.arguments",
      "credential_guard",
      "model.end",
    ]);
    expect(firstCall[0]).toMatchObject({
      scope: SCOPE,
      path: "/v1/responses",
      route: "openai",
      provider: "openai",
      model: "gpt-6.1-sol",
      logicalRoute: LOGICAL,
      api: "openai-responses",
      body: { status: "sent", json: endpoint.received[0]!.body },
    });
    const firstRequest = firstCall[0]!;
    expect(firstRequest.callId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(
      firstRequest.type === "model.request" && firstRequest.sdkContext,
    ).toMatchObject({
      version: 1,
      callId: firstRequest.callId,
      stage: "provider-input",
      model: {
        id: "gpt-6.1-sol",
        provider: LOGICAL,
        api: "openai-responses",
        reasoning: true,
      },
      invocation: {
        version: 1,
        api: "openai-responses",
        options: { cacheRetention: "none" },
      },
    });
    expect(
      firstRequest.type === "model.request" &&
        firstRequest.sdkContext?.invocation,
    ).toEqual({
      version: 1,
      api: "openai-responses",
      options: { cacheRetention: "none" },
    });
    expect(firstCall[2]).toEqual({
      type: "model.response",
      scope: SCOPE,
      callId: firstCall[0]!.callId,
      status: 200,
      requestId: "req_1",
      responseId: "resp_1",
    });
    // Every finished item as the provider sent it: encrypted reasoning, the message's phase, the
    // function call's own argument text.
    expect(
      firstCall
        .filter(
          (event) =>
            event.type === "model.event" &&
            event.name === "response.output_item.done",
        )
        .map((event) => (event.type === "model.event" ? event.data : null)),
    ).toEqual([
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "reasoning",
          id: "rs_1",
          summary: [],
          encrypted_content: "enc-1",
        },
      },
      {
        type: "response.output_item.done",
        output_index: 1,
        item: {
          type: "message",
          id: "msg_1",
          role: "assistant",
          phase: "commentary",
          status: "completed",
          content: [
            { type: "output_text", text: "Checking.", annotations: [] },
          ],
        },
      },
      {
        type: "response.output_item.done",
        output_index: 2,
        item: {
          type: "function_call",
          id: "fc_1",
          call_id: "call_1",
          name: "submit",
          namespace: "neuve",
          status: "completed",
          arguments: RAW_ARGUMENTS,
        },
      },
    ]);
    expect(firstCall[13]).toEqual({
      type: "model.event",
      scope: SCOPE,
      callId: firstCall[0]!.callId,
      name: "sdk_invocation_end",
      data: {
        version: 1,
        callId: firstCall[0]!.callId,
        callbacks: 10,
        abort: { status: "not-aborted" },
      },
    });
    expect(firstCall[14]).toMatchObject({
      data: {
        callId: "call_1",
        itemId: "fc_1",
        name: "submit",
        raw: RAW_ARGUMENTS,
        arguments: { path: "a.ts", note: null },
        replay: '{"path":"a.ts","note":null}',
        replayMatchesRaw: false,
      },
    });
    expect(firstCall.at(-1)).toEqual({
      type: "model.end",
      scope: SCOPE,
      callId: firstCall[0]!.callId,
      outcome: "completed",
      responseId: "resp_1",
      messageTimestamp: first.timestamp,
      sdkUsage: first.usage,
      stopReason: "toolUse",
      usage: {
        input: 36,
        output: 20,
        cacheRead: 64,
        cacheWrite: 0,
        reasoning: 8,
        totalTokens: 120,
      },
    });
    const secondCall = callEvents(captured, firstCall.length);
    expect(secondCall[0]!.callId).not.toBe(firstRequest.callId);
    expect(namesOf(secondCall)).toEqual([
      "model.request",
      "credential_guard",
      "model.response",
      "response.created",
      "response.output_item.added",
      "response.output_text.delta",
      "response.output_item.done",
      "response.completed",
      "sdk_invocation_end",
      "credential_guard",
      "model.end",
    ]);
    expect(secondCall[8]).toEqual({
      type: "model.event",
      scope: SCOPE,
      callId: secondCall[0]!.callId,
      name: "sdk_invocation_end",
      data: {
        version: 1,
        callId: secondCall[0]!.callId,
        callbacks: 5,
        abort: { status: "not-aborted" },
      },
    });
    expect(secondCall[0]).toMatchObject({
      type: "model.request",
      logicalRoute: LOGICAL,
      body: { status: "sent", json: replay },
    });
    expect(JSON.stringify(captured)).not.toContain("tok-1");
  });

  test("tells the plan's usage limit from a rate limit, and asks the token command again after a 401", async () => {
    const token = tokenCommand(scratch, "lease-errors");
    const captured: Array<ModelCaptureEvent> = [];
    const { models, model } = routed({ binding: bindingOf() }, captured, {
      auth: { tokenCommand: token.path },
    });
    const refusal =
      (
        status: number,
        code: string,
        message: string,
        headers: Record<string, string>,
      ) =>
      () =>
        Response.json({ error: { code, message } }, { status, headers });
    endpoint.respond(
      refusal(
        429,
        "subscription_sharing_usage_limit_exceeded",
        "Usage limit reached",
        { "x-request-id": "req_q" },
      ),
      refusal(429, "rate_limit_exceeded", "Slow down", {
        "x-request-id": "req_r",
        "retry-after": "7",
      }),
      refusal(401, "invalid_token", "Token revoked", {}),
      refusal(
        403,
        "subscription_sharing_user_not_eligible",
        "Not eligible",
        {},
      ),
      refusal(403, "forbidden", "Forbidden", {}),
      () => sse(finalRound('{"verdict":"clean"}')),
    );
    const context: Context = { messages: [user("Review it.")] };

    const quota = await models.complete(model, context);
    expect(quota.stopReason).toBe("error");
    expect(quota.errorMessage).toBe(
      "OpenAI API error: quota exceeded, the account's usage quota is used up",
    );
    expect(isRetryableAssistantError(quota)).toBe(false);
    expect(routeFailureOf(quota)).toEqual({
      kind: "plan_quota",
      status: 429,
      code: "subscription_sharing_usage_limit_exceeded",
      requestId: "req_q",
      detail:
        "OpenAI API error (HTTP 429, subscription_sharing_usage_limit_exceeded): Usage limit reached (request req_q)",
    });

    const limited = await models.complete(model, context);
    expect(limited.errorMessage).toBe(
      "OpenAI API error (HTTP 429): rate limited by the provider",
    );
    expect(isRetryableAssistantError(limited)).toBe(true);
    expect(routeFailureOf(limited)).toEqual({
      kind: "rate_limit",
      status: 429,
      code: "rate_limit_exceeded",
      requestId: "req_r",
      retryAfterAt: expect.any(Number),
      detail:
        "OpenAI API error (HTTP 429, rate_limit_exceeded): Slow down (request req_r)",
    });
    expect(captured).toContainEqual(
      expect.objectContaining({
        name: "http_error",
        data: {
          status: 429,
          code: "rate_limit_exceeded",
          retryAfter: "7",
          bodyRedactions: [],
          body: JSON.stringify({
            error: { code: "rate_limit_exceeded", message: "Slow down" },
          }),
        },
      }),
    );

    const refused = await models.complete(model, context);
    expect(refused.errorMessage).toBe(
      "OpenAI API error (HTTP 401): the provider refused the credential or plan access",
    );
    expect(routeFailureOf(refused)).toEqual({
      kind: "auth",
      status: 401,
      code: "invalid_token",
      detail: "OpenAI API error (HTTP 401, invalid_token): Token revoked",
    });
    expect(isRetryableAssistantError(refused)).toBe(false);
    expect(token.runs()).toBe(1);
    const ineligible = await models.complete(model, context);
    expect(routeFailureOf(ineligible)).toEqual({
      kind: "auth",
      status: 403,
      code: "subscription_sharing_user_not_eligible",
      detail:
        "OpenAI API error (HTTP 403, subscription_sharing_user_not_eligible): Not eligible",
    });
    const forbidden = await models.complete(model, context);
    expect(routeFailureOf(forbidden)).toEqual({
      kind: "auth",
      status: 403,
      code: "forbidden",
      detail: "OpenAI API error (HTTP 403, forbidden): Forbidden",
    });
    expect(isRetryableAssistantError(forbidden)).toBe(false);
    const after = await models.complete(model, context);
    expect(after.stopReason).toBe("stop");
    expect(routeFailureOf(after)).toBeUndefined();
    expect(token.runs()).toBe(2);
    expect(endpoint.received.at(-1)!.headers.get("authorization")).toBe(
      "Bearer tok-2",
    );
    expect(
      captured
        .filter((event) => event.type === "model.end")
        .map((event) =>
          event.type === "model.end" ? event.error?.type : event.type,
        ),
    ).toEqual([
      "subscription_sharing_usage_limit_exceeded",
      "rate_limit_exceeded",
      "invalid_token",
      "subscription_sharing_user_not_eligible",
      "forbidden",
      undefined,
    ]);
  });

  test("never reports a failed or cut-off stream as an answer", async () => {
    const token = tokenCommand(scratch, "lease-streams");
    const { models, model } = routed({ binding: bindingOf() }, [], {
      auth: { tokenCommand: token.path },
    });
    endpoint.respond(
      () =>
        sse([
          created("resp_f"),
          {
            type: "response.failed",
            response: {
              id: "resp_f",
              status: "failed",
              error: {
                code: "subscription_sharing_usage_limit_exceeded",
                message: "Usage limit reached",
              },
            },
          },
        ]),
      () => sse([created("resp_f")]),
      () =>
        new Response(
          `data: ${JSON.stringify(created("resp_f"))}\n\ndata: {not json\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const context: Context = { messages: [user("Review it.")] };

    const failed = await models.complete(model, context);
    expect(failed.stopReason).toBe("error");
    expect(failed.errorMessage).toBe(
      "OpenAI API error: quota exceeded, the account's usage quota is used up",
    );
    expect(isRetryableAssistantError(failed)).toBe(false);
    expect(routeFailureOf(failed)).toEqual({
      kind: "plan_quota",
      status: 200,
      code: "subscription_sharing_usage_limit_exceeded",
      requestId: "req_1",
      detail:
        "OpenAI API error (HTTP 200, subscription_sharing_usage_limit_exceeded): Usage limit reached (request req_1)",
    });

    const cut = await models.complete(model, context);
    expect(cut.stopReason).toBe("error");
    expect(cut.errorMessage).toBe(
      "OpenAI API error: the stream failed or ended without a terminal event",
    );
    expect(isRetryableAssistantError(cut)).toBe(true);
    expect(routeFailureOf(cut)).toEqual({
      kind: "stream",
      detail: "OpenAI Responses stream ended before a terminal response event",
    });

    const malformed = await models.complete(model, context);
    expect(malformed.stopReason).toBe("error");
  });

  test("an aborted streaming call persists timing and delta counts without content", async () => {
    const token = tokenCommand(scratch, "lease-telemetry-abort");
    const controller = new AbortController();
    const log = openRunLog(storeLocationIn(scratch), "metadata-only");
    let observed = false;
    const { models, model } = routed({ binding: bindingOf() }, [], {
      log,
      auth: { tokenCommand: token.path },
      capture: (event) => {
        if (
          event.type === "model.event" &&
          event.name === "response.function_call_arguments.delta"
        ) {
          const progress = log
            .read()
            .findLast((row) => row.type === "model.call.progress");
          expect(progress).toMatchObject({
            stage: "frame",
            agent: "frame",
            sentAt: expect.any(String),
            headersAt: expect.any(String),
            firstTokenAt: expect.any(String),
            blocks: { toolArguments: { deltas: 1, characters: 26 } },
          });
          expect(
            log.read().some((row) => row.type === "model.call"),
          ).toBeFalse();
          observed = true;
          controller.abort("secret abort text");
        }
      },
    });
    endpoint.respond(() =>
      sse(
        [
          {
            type: "response.created",
            response: {
              id: "resp_metadata",
              status: "in_progress",
              output: [],
              usage: {
                input_tokens: 10,
                output_tokens: 2,
                total_tokens: 12,
                input_tokens_details: {
                  cached_tokens: 3,
                  cache_write_tokens: 1,
                },
              },
            },
          },
          {
            type: "response.output_item.added",
            output_index: 0,
            item: {
              id: "fc_metadata",
              type: "function_call",
              call_id: "tool_metadata",
              name: "read",
              arguments: "",
            },
          },
          {
            type: "response.function_call_arguments.delta",
            output_index: 0,
            item_id: "fc_metadata",
            delta: '{"path":"private-content"}',
          },
        ],
        { hold: true },
      ),
    );
    const message = await models.complete(
      model,
      { messages: [user("secret user content")], tools: TOOLS },
      { signal: controller.signal },
    );
    expect(observed).toBeTrue();
    expect(message.stopReason).toBe("aborted");
    const calls = log.read().filter((row) => row.type === "model.call");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      abortReason: "aborted",
      failureKind: "aborted",
      usage: {
        input: 6,
        output: 2,
        cacheRead: 3,
        cacheWrite5m: 1,
        cacheWrite1h: 0,
        thinking: 0,
      },
      streamEndAt: expect.any(String),
      blocks: { toolArguments: { deltas: 1, characters: 26 } },
    });
    const text = JSON.stringify(log.read());
    for (const forbidden of [
      "secret user content",
      "private-content",
      "secret abort text",
    ])
      expect(text).not.toContain(forbidden);
  });

  test("stops on the caller's signal as aborted", async () => {
    const token = tokenCommand(scratch, "lease-abort");
    const controller = new AbortController();
    const captured: Array<ModelCaptureEvent> = [];
    const { models, model } = routed({ binding: bindingOf() }, captured, {
      auth: { tokenCommand: token.path },
      capture: (event) => {
        captured.push(event);
        if (event.type === "model.event" && event.name === "response.created")
          controller.abort();
      },
    });
    endpoint.respond(() => sse([created("resp_a")], { hold: true }));
    const message = await models.complete(
      model,
      { messages: [user("Review it.")] },
      { signal: controller.signal },
    );
    expect(message.stopReason).toBe("aborted");
    expect(message.errorMessage).toBe(
      "OpenAI API error: the request was aborted",
    );
    expect(routeFailureOf(message)).toEqual({
      kind: "aborted",
      detail: "OpenAI Responses stream ended before a terminal response event",
    });
    expect(captured.at(-1)).toMatchObject({
      type: "model.end",
      outcome: "aborted",
      error: { type: "aborted" },
    });
  });

  test("aborts a stalled stream as retryable and names what it waited for", async () => {
    const token = tokenCommand(scratch, "lease-stall");
    const context: Context = { messages: [user("Review it.")] };
    const root = mkdtempSync(join(scratch, "durable-stall-"));
    const source = join(root, "source");
    mkdirSync(source, { mode: 0o700 });
    const ownership = SourceOwnership.acquire(source);
    try {
      const inspection = createPrivateInspection({
        ownership,
        source,
        directory: join(root, "private"),
        excludedRoots: [source],
      });
      try {
        const preflight = openEndpoint();
        try {
          preflight.respond(() => sse(finalRound('{"verdict":"clean"}')));
          const { models, model } = routed({ binding: bindingOf() }, [], {
            auth: { tokenCommand: token.path },
            credentialInspection: inspection,
            baseUrl: `${preflight.server.url.origin}/v1`,
          });
          const message = await models.complete(model, context);
          expect(message.stopReason).toBe("stop");
          expect(message.content).toMatchObject([
            { type: "text", text: '{"verdict":"clean"}' },
          ]);
          expect(preflight.received.map((request) => request.path)).toEqual([
            "/v1/responses",
          ]);
        } finally {
          await preflight.stop();
        }
        const complete = async (
          respond: Parameters<ReturnType<typeof openEndpoint>["respond"]>[0],
        ) => {
          const local = openEndpoint();
          try {
            local.respond(respond);
            const { models, model } = routed({ binding: bindingOf() }, [], {
              auth: { tokenCommand: token.path },
              credentialInspection: inspection,
              baseUrl: `${local.server.url.origin}/v1`,
              stallLimits: { quietMs: 200, reasoningMs: 900 },
            });
            const message = await models.complete(model, context);
            expect(local.received.map((request) => request.path)).toEqual([
              "/v1/responses",
            ]);
            return message;
          } finally {
            await local.stop();
          }
        };
        const reasoningAdded = reasoningItem(0, "rs_s", "enc-s")[0]!;
        const stalled = async (
          waiting: string,
          respond: Parameters<typeof complete>[0],
        ) => {
          const message = await complete(respond);
          expect(message.stopReason).toBe("error");
          expect(message.errorMessage).toBe(
            "OpenAI API error: the stream stalled and timed out",
          );
          expect(isRetryableAssistantError(message)).toBe(true);
          expect(routeFailureOf(message)).toEqual({
            kind: "stalled",
            detail: expect.stringMatching(
              new RegExp(
                `^stream_stalled: timed out after \\d+ ms waiting for ${waiting}$`,
              ),
            ),
          });
        };
        await stalled("the response headers", async () => {
          await Bun.sleep(600);
          return sse([created("resp_s")]);
        });
        await stalled("a stream event", () =>
          sse([created("resp_s")], { hold: true }),
        );
        await stalled("a stream event inside a reasoning item", () =>
          sse([created("resp_s"), reasoningAdded], { hold: true }),
        );
        const thought = await complete(() =>
          sse([
            created("resp_s"),
            reasoningAdded,
            500,
            reasoningItem(0, "rs_s", "enc-s")[1]!,
            ...finalRound('{"verdict":"clean"}').slice(1),
          ]),
        );
        expect(thought.stopReason).toBe("stop");
      } finally {
        inspection.close();
      }
    } finally {
      ownership.release();
    }
  });
});

describe("the agent route binding", () => {
  test("a missing binding, or one naming another route, fails before anything is sent", async () => {
    const token = tokenCommand(scratch, "lease-binding");
    const captured: Array<ModelCaptureEvent> = [];
    const state: { binding: AgentRouteBinding | undefined } = {
      binding: undefined,
    };
    const { models, model } = routed(state, captured, {
      auth: { tokenCommand: token.path },
    });
    const sent = endpoint.received.length;
    const context: Context = { messages: [user("Review it.")] };

    const missing = await models.complete(model, context);
    expect(missing.stopReason).toBe("error");
    expect(missing.errorMessage).toBe(
      "OpenAI API error: the agent route binding is missing or names another route",
    );
    expect(routeFailureOf(missing)).toEqual({
      kind: "binding",
      detail: `agent route binding unavailable for ${LOGICAL}: conversation 7 has no agent route`,
    });

    state.binding = bindingOf({
      logicalProvider: "agent-route.run-1.investigate",
      physicalModel: "gpt-6.1-luna",
    });
    const foreign = await models.complete(model, context);
    expect(routeFailureOf(foreign)).toEqual({
      kind: "binding",
      detail: `agent route binding for ${LOGICAL} names logical provider agent-route.run-1.investigate, physical model gpt-6.1-luna, not this route`,
    });

    expect(endpoint.received.length).toBe(sent);
    expect(captured).toEqual([]);
    expect(token.runs()).toBe(0);
  });
});

describe("capture", () => {
  const failingAt =
    (captured: Array<ModelCaptureEvent>, name: string) =>
    (event: ModelCaptureEvent) => {
      if ((event.type === "model.event" ? event.name : event.type) === name)
        throw new CaptureFailed({
          kind: "io",
          event: name,
          detail: "ENOSPC: no space left on device",
        });
      captured.push(event);
    };

  test("a request that cannot be recorded is never sent", async () => {
    const token = tokenCommand(scratch, "lease-capture-request");
    const captured: Array<ModelCaptureEvent> = [];
    const { models, model } = routed({ binding: bindingOf() }, captured, {
      auth: { tokenCommand: token.path },
      capture: failingAt(captured, "model.request"),
    });
    const sent = endpoint.received.length;

    const message = await models.complete(model, {
      messages: [user("Review it.")],
    });

    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toBe(
      "OpenAI API error: capture failed, the call could not be recorded",
    );
    expect(routeFailureOf(message)).toEqual({
      kind: "capture",
      detail:
        "capture failed: model.request was not recorded: io: ENOSPC: no space left on device",
    });
    expect(endpoint.received.length).toBe(sent);
    expect(captured).toEqual([]);
  });

  test("a call refused before the provider names a response joins its stored message by timestamp", async () => {
    const token = tokenCommand(scratch, "lease-capture-timestamp");
    const captured: Array<ModelCaptureEvent> = [];
    const { models, model } = routed({ binding: bindingOf() }, captured, {
      auth: { tokenCommand: token.path },
    });
    endpoint.respond(() =>
      Response.json(
        { error: { code: "server_error", message: "Try again" } },
        { status: 500, headers: { "x-request-id": "req_t" } },
      ),
    );

    const message = await models.complete(model, {
      messages: [user("Review it.")],
    });

    expect(message.stopReason).toBe("error");
    expect(message.responseId).toBeUndefined();
    expect(namesOf(captured)).toEqual([
      "model.request",
      "credential_guard",
      "model.response",
      "http_error",
      "sdk_invocation_end",
      "credential_guard",
      "model.end",
    ]);
    expect(captured[2]).toEqual({
      type: "model.response",
      scope: SCOPE,
      callId: captured[0]!.callId,
      status: 500,
      requestId: "req_t",
    });
    expect(captured[4]).toEqual({
      type: "model.event",
      scope: SCOPE,
      callId: captured[0]!.callId,
      name: "sdk_invocation_end",
      data: {
        version: 1,
        callId: captured[0]!.callId,
        callbacks: 0,
        abort: { status: "not-aborted" },
      },
    });
    expect(captured[6]).toEqual({
      type: "model.end",
      scope: SCOPE,
      callId: captured[0]!.callId,
      outcome: "failed",
      messageTimestamp: message.timestamp,
      sdkUsage: message.usage,
      stopReason: "error",
      error: {
        type: "server_error",
        message:
          "OpenAI API error (HTTP 500, server_error): Try again (request req_t)",
      },
    });
  });

  test("an event that cannot be recorded mid-stream fails the call", async () => {
    const token = tokenCommand(scratch, "lease-capture-event");
    const captured: Array<ModelCaptureEvent> = [];
    const { models, model } = routed({ binding: bindingOf() }, captured, {
      auth: { tokenCommand: token.path },
      capture: failingAt(captured, "response.created"),
    });
    endpoint.respond(() => sse(finalRound('{"verdict":"clean"}')));

    const message = await models.complete(model, {
      messages: [user("Review it.")],
    });

    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toBe(
      "OpenAI API error: capture failed, the call could not be recorded",
    );
    expect(captured.at(-1)).toMatchObject({
      type: "model.end",
      outcome: "failed",
      error: {
        type: "capture",
        message:
          "capture failed: model.event response.created was not recorded: io: ENOSPC: no space left on device",
      },
    });
  });

  test("a stream cut off mid-answer keeps every event that arrived, deltas included, in order", async () => {
    const token = tokenCommand(scratch, "lease-capture-partial");
    const captured: Array<ModelCaptureEvent> = [];
    const { models, model } = routed({ binding: bindingOf() }, captured, {
      auth: { tokenCommand: token.path },
    });
    const summaryDelta = {
      type: "response.reasoning_summary_text.delta",
      output_index: 0,
      summary_index: 0,
      delta: "Synthetic partial summary.",
    };
    const textDelta = {
      type: "response.output_text.delta",
      output_index: 1,
      content_index: 0,
      delta: "Half an ans",
    };
    endpoint.respond(() =>
      sse([
        created("resp_p"),
        ...reasoningItem(0, "rs_p", "enc-p"),
        summaryDelta,
        {
          type: "response.output_item.added",
          output_index: 1,
          item: {
            type: "message",
            id: "msg_p",
            role: "assistant",
            phase: "final_answer",
            content: [],
          },
        },
        textDelta,
      ]),
    );

    const message = await models.complete(model, {
      messages: [user("Review it.")],
    });

    expect(message.stopReason).toBe("error");
    expect(namesOf(captured)).toEqual([
      "model.request",
      "credential_guard",
      "model.response",
      "response.created",
      "response.output_item.added",
      "response.output_item.done",
      "response.reasoning_summary_text.delta",
      "response.output_item.added",
      "response.output_text.delta",
      "sdk_invocation_end",
      "credential_guard",
      "model.end",
    ]);
    expect(captured[9]).toEqual({
      type: "model.event",
      scope: SCOPE,
      callId: captured[0]!.callId,
      name: "sdk_invocation_end",
      data: {
        version: 1,
        callId: captured[0]!.callId,
        callbacks: 6,
        abort: { status: "not-aborted" },
      },
    });
    expect(
      captured
        .filter(
          (event) =>
            event.type === "model.event" && event.name.endsWith(".delta"),
        )
        .map((event) => (event.type === "model.event" ? event.data : null)),
    ).toEqual([summaryDelta, textDelta]);
    expect(captured.at(-1)).toMatchObject({
      type: "model.end",
      outcome: "failed",
      responseId: "resp_p",
    });
  });

  test("a delta is recorded while its call is still streaming, before the call settles", async () => {
    const token = tokenCommand(scratch, "lease-capture-live");
    const captured: Array<ModelCaptureEvent> = [];
    const controller = new AbortController();
    const arrived = Promise.withResolvers<Array<string>>();
    const { models, model } = routed({ binding: bindingOf() }, captured, {
      auth: { tokenCommand: token.path },
      capture: (event) => {
        captured.push(event);
        if (event.type === "model.event" && event.name.endsWith(".delta"))
          arrived.resolve(namesOf(captured));
      },
    });
    const delta = {
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      delta: "Still stream",
    };
    endpoint.respond(() =>
      sse(
        [
          created("resp_l"),
          {
            type: "response.output_item.added",
            output_index: 0,
            item: {
              type: "message",
              id: "msg_l",
              role: "assistant",
              phase: "final_answer",
              content: [],
            },
          },
          delta,
        ],
        { hold: true },
      ),
    );

    const pending = models.complete(
      model,
      { messages: [user("Review it.")] },
      { signal: controller.signal },
    );
    expect(await arrived.promise).toEqual([
      "model.request",
      "credential_guard",
      "model.response",
      "response.created",
      "response.output_item.added",
      "response.output_text.delta",
    ]);
    controller.abort();
    expect((await pending).stopReason).toBe("aborted");
    expect(
      captured.find(
        (event) =>
          event.type === "model.event" && event.name.endsWith(".delta"),
      ),
    ).toMatchObject({ data: delta });
  });

  test("an answer whose end cannot be recorded settles as failed, not answered", async () => {
    const token = tokenCommand(scratch, "lease-capture-end");
    const captured: Array<ModelCaptureEvent> = [];
    const { models, model } = routed({ binding: bindingOf() }, captured, {
      auth: { tokenCommand: token.path },
      capture: failingAt(captured, "model.end"),
    });
    const sent = endpoint.received.length;
    endpoint.respond(() => sse(finalRound('{"verdict":"clean"}')));

    const message: AssistantMessage = await models.complete(model, {
      messages: [user("Review it.")],
    });

    expect(endpoint.received.length).toBe(sent + 1);
    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toBe(
      "OpenAI API error: capture failed, the call could not be recorded",
    );
    expect(routeFailureOf(message)).toEqual({
      kind: "capture",
      detail:
        "capture failed: model.end was not recorded: io: ENOSPC: no space left on device",
    });
    expect(namesOf(captured)).toEqual([
      "model.request",
      "credential_guard",
      "model.response",
      "response.created",
      "response.output_item.added",
      "response.output_text.delta",
      "response.output_item.done",
      "response.completed",
      "sdk_invocation_end",
      "credential_guard",
    ]);
    expect(captured[8]).toEqual({
      type: "model.event",
      scope: SCOPE,
      callId: captured[0]!.callId,
      name: "sdk_invocation_end",
      data: {
        version: 1,
        callId: captured[0]!.callId,
        callbacks: 5,
        abort: { status: "not-aborted" },
      },
    });
  });
});

describe("the Anthropic route", () => {
  const VARIABLE = "NEUVE_TEST_ANTHROPIC_KEY";
  const KEY = "sk-ant-test-provider-lane";

  test("streams with the route's key variable, cap, effort, caching and the binding's final generation", async () => {
    const route = { ...OPUS_ROUTE, credentialVariable: VARIABLE };
    const logical = "agent-route.run-1.assemble";
    const captured: Array<ModelCaptureEvent> = [];
    const models = createModels();
    models.setProvider(
      createAgentRouteProvider({
        credentialInspection: "ephemeral" as const,
        route,
        baseUrl: endpoint.server.url.origin,
        capture: (event) => captured.push(event),
        logicalProvider: logical,
        readBinding: async () =>
          bindingOf({
            stage: "map",
            agent: "map",
            logicalProvider: logical,
            physicalProvider: "anthropic",
            physicalModel: route.model,
            mode: { kind: "final", schema: FINAL_SCHEMA },
          }),
      }),
    );
    const model = models.getModel(logical, route.model) as Model<Api>;
    expect(model).toMatchObject({
      provider: logical,
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    });

    delete process.env[VARIABLE];
    expect(await models.checkAuth(logical)).toBeUndefined();
    process.env[VARIABLE] = KEY;
    expect(await models.checkAuth(logical)).toEqual({
      source: VARIABLE,
      type: "api_key",
    });

    endpoint.received.length = 0;
    endpoint.respond(() =>
      sse(
        [
          {
            type: "message_start",
            message: {
              id: "msg_a",
              type: "message",
              role: "assistant",
              model: "claude-opus-5-5",
              content: [],
              stop_reason: null,
              usage: {
                input_tokens: 10,
                cache_creation_input_tokens: 200,
                cache_read_input_tokens: 0,
                cache_creation: {
                  ephemeral_5m_input_tokens: 0,
                  ephemeral_1h_input_tokens: 200,
                },
                output_tokens: 1,
              },
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
            delta: { type: "text_delta", text: '{"verdict":"clean"}' },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 12 },
          },
          { type: "message_stop" },
        ],
        { headers: { "request-id": "req_a" } },
      ),
    );
    let message: AssistantMessage;
    try {
      message = await models.complete(model, {
        systemPrompt: "You review.",
        messages: [user("Review it.")],
        tools: TOOLS,
      });
    } finally {
      delete process.env[VARIABLE];
    }

    const sent = endpoint.received[0]!;
    expect(sent.path).toBe("/v1/messages");
    expect(sent.headers.get("x-api-key")).toBe(KEY);
    const { tools, messages, ...rest } = sent.body;
    expect(rest).toEqual({
      model: "claude-opus-5-5",
      max_tokens: 128_000,
      stream: true,
      system: [
        {
          type: "text",
          text: "You review.",
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
      ],
      cache_control: { type: "ephemeral" },
      output_config: {
        effort: "medium",
        format: { type: "json_schema", schema: FINAL_SCHEMA },
      },
      tool_choice: { type: "none" },
    });
    expect(messages).toEqual([
      { role: "user", content: [{ type: "text", text: "Review it." }] },
    ]);
    expect(
      (tools as Array<Record<string, unknown>>).map((tool) => [
        tool["name"],
        tool["strict"] === true,
        "cache_control" in tool,
      ]),
    ).toEqual([
      ["submit", true, false],
      ["read", false, false],
    ]);

    expect(message.stopReason).toBe("stop");
    expect(message.provider).toBe(logical);
    expect(message.usage).toMatchObject({
      input: 10,
      cacheWrite: 200,
      cacheWrite1h: 200,
      output: 12,
    });
    expect(costOf(route, callUsageOf(message.usage))).toBeCloseTo(
      10 * 4e-6 + 200 * 8e-6 + 12 * 20e-6,
      12,
    );
    expect(message.usage.cost.total).toBeCloseTo(
      costOf(route, callUsageOf(message.usage)),
      12,
    );
    expect(captured[0]).toMatchObject({
      type: "model.request",
      scope: {
        runId: "run-1",
        stage: "map",
        agent: "map",
        conversationId: 7,
      },
      route: "anthropic",
      provider: "anthropic",
      model: "claude-opus-5-5",
    });
    const request = captured[0]!;
    expect(
      request.type === "model.request" && request.sdkContext?.invocation,
    ).toEqual({
      version: 1,
      api: "anthropic-messages",
      authMode: "non-oauth",
      options: { maxTokens: 128_000, cacheRetention: "long" },
    });
    expect(
      captured.find((event) => event.type === "model.response"),
    ).toMatchObject({ status: 200, requestId: "req_a" });
    expect(captured.at(-3)).toEqual({
      type: "model.event",
      scope: {
        runId: "run-1",
        stage: "map",
        agent: "map",
        conversationId: 7,
      },
      callId: request.callId,
      name: "sdk_invocation_end",
      data: {
        version: 1,
        callId: request.callId,
        callbacks: 6,
        abort: { status: "not-aborted" },
      },
    });
    expect(JSON.stringify(captured)).not.toContain(KEY);
  });
});

describe("strict tool arguments", () => {
  const ITEM = {
    type: "object",
    properties: { line: { type: "integer" }, label: { type: "string" } },
    required: ["line"],
  };
  const parameters = schema({
    type: "object",
    $defs: { range: ITEM },
    properties: {
      path: { type: "string" },
      note: { type: "string" },
      reason: { anyOf: [{ type: "string" }, { type: "null" }] },
      anchor: {
        type: "object",
        properties: { line: { type: "integer" }, side: { type: "string" } },
        required: ["line"],
      },
      lines: { type: "array", items: ITEM },
      range: { $ref: "#/$defs/range" },
    },
    required: ["path"],
  });
  const tool: Tool = {
    name: "submit",
    description: "Submit.",
    parameters,
    constrainedSampling: { type: "json_schema", strict: "require" },
  };
  /** What strict mode makes the model write: every property present, the optional ones as null. */
  const written = {
    path: "a.ts",
    note: null,
    reason: null,
    anchor: { line: 3, side: null },
    lines: [{ line: 4, label: null }],
    range: null,
  };
  const validated = (args: unknown) =>
    validateToolArguments(tool, {
      type: "toolCall",
      id: "call_1",
      name: "submit",
      arguments: args as ToolCall["arguments"],
    }) as unknown;

  test("pi's own validation keeps a null on a referenced optional property, which the strict schema forbids", () => {
    expect(() => validated(written)).toThrow(/range/);
  });

  test("the prepared arguments drop only the nulls strict mode added, nested ones too, and leave the transcript's alone", () => {
    const original = structuredClone(written);
    const prepared = routeToolArguments(SOL_ROUTE)?.(written, parameters);

    expect(prepared).toEqual({
      path: "a.ts",
      reason: null,
      anchor: { line: 3 },
      lines: [{ line: 4 }],
    });
    expect(validated(prepared)).toEqual({
      path: "a.ts",
      reason: null,
      anchor: { line: 3 },
      lines: [{ line: 4 }],
    });
    expect(written).toEqual(original);
  });
});

// Regression: a terminal telemetry append must not prevent the transport's terminal event.
test("a failed terminal telemetry write cannot hang a model call", async () => {
  const token = tokenCommand(scratch, "lease-log-failure");
  const { models, model } = routed({ binding: bindingOf() }, [], {
    auth: { tokenCommand: token.path },
    log: {
      path: "synthetic",
      read: () => [],
      write: (record) => {
        if (record.type === "model.call")
          throw new Error("synthetic log failure");
      },
    },
  });
  endpoint.respond(() => sse(finalRound("safe fixture answer")));
  const pending = models.complete(model, { messages: [user("Review it.")] });
  const result = await Promise.race([pending, Bun.sleep(500).then(() => null)]);
  expect(result?.stopReason).toBe("stop");
});
