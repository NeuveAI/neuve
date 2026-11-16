import type { SdkInvocation } from "../../../src/pi/capture/types.ts";
import {
  sdkContextSnapshot,
  retainedContext,
} from "../../../src/pi/capture/retained-context.ts";
import {
  providerOutput,
  reconcileProviderOutput,
} from "../../../src/pi/capture/provider-output.ts";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { test, expect } from "bun:test";
import { retainedSdk } from "../../../src/pi/capture/retained-sdk.ts";
import { withholdReasoning } from "../../../src/pi/capture/mask.ts";
import {
  InspectionBudget,
  DEFAULT_INSPECTION_LIMITS,
} from "../../../src/pi/capture/credential-detectors.ts";
import type { CallRecord } from "../../../src/pi/capture/dump.ts";
import { Json } from "../../../src/pi/capture/types.ts";
const capturedInvocation = (api: string): SdkInvocation =>
  api === "anthropic-messages"
    ? {
        version: 1,
        api: "anthropic-messages",
        authMode: "non-oauth",
        options: { cacheRetention: "none" },
      }
    : {
        version: 1,
        api: "openai-responses",
        options: { cacheRetention: "none" },
      };
const empty = { conversations: [], session: [] };
const call = (api: string, frames: unknown[]): Omit<CallRecord, "role"> => ({
  callId: "offline",
  scope: { runId: "offline" },
  route: "synthetic",
  provider: api === "anthropic-messages" ? "anthropic" : "openai",
  model: "synthetic",
  api,
  headerNames: [],
  credentialCoverage: "none",
  body: { status: "sent", json: { model: "synthetic", stream: true } },
  sdkContext: sdkContextSnapshot(
    "offline",
    {
      id: "synthetic",
      name: "synthetic",
      api:
        api === "anthropic-messages"
          ? "anthropic-messages"
          : "openai-responses",
      provider: api === "anthropic-messages" ? "anthropic" : "openai",
      baseUrl: "https://capture.invalid",
      reasoning: true,
      input: ["text"],
      contextWindow: 1000,
      maxTokens: 100,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
    normalizeContext({ messages: [] }),
    capturedInvocation(api),
  ),
  requestedAt: 0,
  response: null,
  end: null,
  events: frames.map((raw) => {
    const data = Json.parse(raw);
    if (
      data === null ||
      typeof data !== "object" ||
      Array.isArray(data) ||
      !("type" in data) ||
      typeof data.type !== "string"
    )
      throw Error("fixture");
    return { at: 0, name: data.type, data };
  }),
});
const responseStart = {
  type: "response.created",
  response: { id: "r", status: "in_progress" },
};
const anthropicStart = {
  type: "message_start",
  message: {
    id: "a",
    model: "synthetic",
    usage: { input_tokens: 0, output_tokens: 0 },
  },
};
test("SDK emitted scalars survive safe replacement and every prefix", async () => {
  const frames = [
    responseStart,
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id: "m", content: [] },
    },
    {
      type: "response.output_text.delta",
      output_index: 0,
      delta: "synthetic-",
    },
    { type: "response.output_text.delta", output_index: 0, delta: "secret" },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "message",
        id: "m",
        content: [{ type: "output_text", text: "safe replacement" }],
      },
    },
  ];
  for (let end = 1; end <= frames.length; end++) {
    const texts: string[] = [];
    await retainedSdk(
      call("openai-responses", frames.slice(0, end)),
      empty,
      (v) => texts.push(v),
      undefined,
      { purpose: "scalar-enumeration" },
    );
    if (end >= 4) expect(texts).toContain("synthetic-secret");
  }
});
test("an Anthropic signature split across deltas keeps every distinct prefix", async () => {
  const texts: string[] = [];
  await retainedSdk(
    call("anthropic-messages", [
      anthropicStart,
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "", signature: "prefix" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "-secret" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "-later" },
      },
    ]),
    empty,
    (v) => texts.push(v),
    undefined,
    { purpose: "scalar-enumeration" },
  );
  expect(texts).toContain("prefix-secret");
  expect(texts).toContain("prefix-secret-later");
});
test("a JSON-decoded credential prefix survives an extension that no longer parses", async () => {
  const escaped = '"\\u0073ynthetic-secret"';
  const texts: string[] = [];
  await retainedSdk(
    call("openai-responses", [
      responseStart,
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "message", id: "m", content: [] },
      },
      {
        type: "response.output_text.delta",
        output_index: 0,
        delta: '"\\u0073',
      },
      {
        type: "response.output_text.delta",
        output_index: 0,
        delta: 'ynthetic-secret"',
      },
      {
        type: "response.output_text.delta",
        output_index: 0,
        delta: " trailing",
      },
    ]),
    empty,
    (value) => texts.push(value),
    undefined,
    { purpose: "scalar-enumeration" },
  );
  expect(texts).toContain(escaped);
  expect(texts).toContain(escaped + " trailing");
  expect(JSON.parse(escaped)).toBe("synthetic-secret");
  expect(() => JSON.parse(escaped + " trailing")).toThrow();
});
test("Anthropic duplicate indices and argument repair use actual SDK state", async () => {
  const texts: string[] = [];
  await retainedSdk(
    call("anthropic-messages", [
      anthropicStart,
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "a", name: "t", input: {} },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json: '{"x":"\\u0073ynthetic-',
        },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: 'secret"}' },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "second" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "-tail" },
      },
    ]),
    empty,
    (v) => texts.push(v),
    undefined,
    { purpose: "scalar-enumeration" },
  );
  expect(texts).toContain("synthetic-secret");
  expect(texts).toContain("second-tail");
});
test("portable reasoning preserves arrays and event discriminators", () => {
  expect(
    withholdReasoning(
      Json.parse({
        name: "response.reasoning_summary_text.delta",
        data: {
          type: "response.reasoning_summary_text.delta",
          output_index: 0,
          delta: "private thinking",
        },
        item: {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "private thinking" }],
        },
      }),
    ),
  ).toEqual({
    name: "response.reasoning_summary_text.delta",
    data: {
      type: "response.reasoning_summary_text.delta",
      output_index: 0,
      delta: "<withheld: reasoning summary, 16 characters>",
    },
    item: {
      type: "reasoning",
      summary: [
        {
          type: "summary_text",
          text: "<withheld: reasoning summary, 16 characters>",
        },
      ],
    },
  });
});
test("SDK work budget and cancellation refuse instead of truncating", async () => {
  const signal = AbortSignal.abort();
  await expect(
    retainedSdk(
      call("openai-responses", [responseStart]),
      empty,
      () => {},
      new InspectionBudget(DEFAULT_INSPECTION_LIMITS, signal),
      { purpose: "scalar-enumeration" },
    ),
  ).rejects.toMatchObject({ reason: "cancelled" });
  await expect(
    retainedSdk(
      call("openai-responses", Array(200).fill(responseStart)),
      empty,
      () => {},
      new InspectionBudget({ ...DEFAULT_INSPECTION_LIMITS, units: 100 }),
      { purpose: "scalar-enumeration" },
    ),
  ).rejects.toBeDefined();
});

test("exact call context keeps grammar properties and excludes model credentials", async () => {
  const model = {
    id: "synthetic",
    name: "synthetic",
    api: "openai-responses" as const,
    provider: "openai",
    baseUrl: "https://offline.invalid",
    headers: { Authorization: "never-copy-model-header" },
    reasoning: true,
    input: ["text" as const],
    contextWindow: 1000,
    maxTokens: 100,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: {
      supportsOpenAIGrammarTools: true,
      supportsMidConvoSystemMessages: true,
      supportsAdditionalTools: true,
    },
  };
  const context = normalizeContext({
    messages: [
      {
        role: "system",
        timestamp: 0,
        content: "safe",
        toolsAdded: [
          {
            name: "grammar",
            description: "safe",
            parameters: {
              type: "object",
              required: ["query"],
              properties: { query: { type: "string" } },
            },
            constrainedSampling: {
              type: "grammar",
              variants: { openai_regex: ".*" },
            },
          },
        ],
      },
    ],
  });
  const snapshot = sdkContextSnapshot(
    "offline",
    model,
    context,
    capturedInvocation(model.api),
  );
  expect(JSON.stringify(snapshot)).not.toContain("never-copy-model-header");
  context.messages.length = 0;
  expect(snapshot.messages).toHaveLength(1);
  const input = call("openai-responses", [
    responseStart,
    {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        type: "custom_tool_call",
        id: "i",
        call_id: "c",
        name: "grammar",
        input: "",
      },
    },
    {
      type: "response.custom_tool_call_input.delta",
      output_index: 0,
      delta: "safe body",
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "custom_tool_call",
        id: "i",
        call_id: "c",
        name: "grammar",
        input: "safe body",
      },
    },
  ]);
  input.sdkContext = snapshot;
  const scalars: string[] = [];
  const output = await retainedSdk(
    input,
    empty,
    (v) => scalars.push(v),
    undefined,
    { purpose: "scalar-enumeration" },
  );
  expect(scalars).toContain('{"query":"safe body');
  expect(output).toMatchObject({
    content: [{ type: "toolCall", arguments: { query: "safe body" } }],
  });
  await expect(
    retainedSdk({ ...input, callId: "other" }, empty, undefined, undefined, {
      purpose: "scalar-enumeration",
    }),
  ).rejects.toThrow("another call");
});
for (const partial of [false, true])
  test(`withheld reasoning native aggregate agrees with ${partial ? "partial" : "final-only"} wire leaves and refuses unrelated text`, async () => {
    const frames = partial
      ? [
          responseStart,
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { type: "reasoning", id: "i", summary: [] },
          },
          {
            type: "response.reasoning_summary_text.delta",
            output_index: 0,
            delta: "private one",
          },
          { type: "response.reasoning_summary_part.done", output_index: 0 },
          {
            type: "response.reasoning_summary_text.delta",
            output_index: 0,
            delta: "private two",
          },
        ]
      : [
          responseStart,
          {
            type: "response.output_item.done",
            output_index: 0,
            item: {
              type: "reasoning",
              id: "i",
              summary: [
                { type: "summary_text", text: "private one" },
                { type: "summary_text", text: "private two" },
              ],
            },
          },
        ];
    const original = call("openai-responses", frames),
      facts = await providerOutput(original);
    if (facts === null) throw Error("facts missing");

    const native = {
      content: withholdReasoning(facts.content),
      usage: {
        ...facts.usage,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      responseId: "r",
      stopReason: "error",
    };
    const portable = {
      ...original,
      events: original.events.map((event) => ({
        ...event,
        data: withholdReasoning(event.data),
      })),
    };
    const projected = await providerOutput(portable);
    if (projected === null) throw Error("projection missing");
    expect(JSON.stringify(portable)).not.toContain("private one");
    expect(() =>
      reconcileProviderOutput(portable, projected, native, []),
    ).not.toThrow();
    expect(() =>
      reconcileProviderOutput(
        portable,
        projected,
        { ...native, content: [{ type: "text", text: "forged" }] },
        [],
      ),
    ).toThrow();
  });

test("portable context preserves model semantics and user JSON", () => {
  const value = Json.parse({
    model: { reasoning: true, compat: { supportsOpenAIGrammarTools: true } },
    messages: [
      {
        role: "user",
        content: '{ "reasoning": "user data", "summary": "user summary" }',
      },
    ],
  });
  expect(withholdReasoning(value)).toEqual(value);
});

test("Anthropic redacted reasoning has the declared withheld semantic class", async () => {
  const original = call("anthropic-messages", [
    anthropicStart,
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "redacted_thinking", data: "opaque original" },
    },
    { type: "content_block_stop", index: 0 },
  ]);
  const facts = await providerOutput(original);
  if (facts === null) throw Error("facts");
  const native = {
    content: withholdReasoning(facts.content),
    usage: {
      ...facts.usage,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    responseId: "a",
    stopReason: "error",
  };
  const portable = {
    ...original,
    events: original.events.map((event) => ({
      ...event,
      data: withholdReasoning(event.data),
    })),
  };
  const output = await providerOutput(portable);
  if (output === null) throw Error("output");
  expect(() =>
    reconcileProviderOutput(portable, output, native, []),
  ).not.toThrow();
});

const contextModel = {
  id: "synthetic",
  name: "synthetic",
  api: "anthropic-messages" as const,
  provider: "anthropic",
  baseUrl: "https://offline.invalid",
  reasoning: true,
  input: ["text" as const, "image" as const],
  contextWindow: 1000,
  maxTokens: 100,
  cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
};
test("complete public compatibility metadata and pricing survive immutable capture and replay", async () => {
  const fallback = {
    provider: "anthropic",
    model: "fallback",
    cost: {
      input: 5,
      output: 7,
      cacheRead: 9,
      cacheWrite: 11,
      tiers: [
        {
          inputTokensAbove: 10,
          input: 13,
          output: 17,
          cacheRead: 19,
          cacheWrite: 23,
        },
      ],
    },
  };
  const model = {
    ...contextModel,
    compat: {
      allowedFallbackModels: [fallback],
      forceAdaptiveThinking: true,
      sendSessionAffinityHeaders: true,
      sessionAffinityFormat: "openrouter" as const,
      supportsMidConvoEffort: true,
    },
  };
  const context = normalizeContext({
    messages: [
      { role: "user", timestamp: 1, content: '{"payload":"preserved"}' },
      {
        role: "toolResult",
        toolCallId: "c",
        toolName: "t",
        timestamp: 2,
        isError: false,
        content: [{ type: "text", text: "result" }],
        details: { payload: [null, 1, false, "same"] },
      },
    ],
  });
  const snapshot = sdkContextSnapshot(
    "offline",
    model,
    context,
    capturedInvocation(model.api),
  );
  fallback.cost.input = 999;
  context.messages.length = 0;
  const original = call("anthropic-messages", [
    {
      ...anthropicStart,
      message: {
        ...anthropicStart.message,
        model: "fallback",
        usage: { input_tokens: 2, output_tokens: 3 },
      },
    },
    { type: "message_stop" },
  ]);
  original.sdkContext = snapshot;
  const replay = retainedContext(original, empty);
  expect(replay.model.compat).toMatchObject({
    allowedFallbackModels: [{ cost: { input: 5 } }],
    forceAdaptiveThinking: true,
    sessionAffinityFormat: "openrouter",
  });
  expect(replay.model.input).toEqual(["text", "image"]);
  expect(replay.context.messages).toHaveLength(2);
  expect(JSON.stringify(replay.context.messages)).toContain("preserved");
  expect(
    Object.isFrozen(snapshot.model.compat?.allowedFallbackModels?.[0]?.cost),
  ).toBe(true);
  const output = await retainedSdk(original, empty, undefined, undefined, {
    purpose: "scalar-enumeration",
  });
  expect(output).toMatchObject({
    responseModel: "fallback",
    usage: { cost: { input: 0.00001, output: 0.000021 } },
  });
});
test("unknown or invalid compat never becomes defaulted replay", () => {
  for (const compat of [
    { supportsTemperature: "yes" },
    { futureSemanticField: true },
    {
      allowedFallbackModels: [
        { provider: "anthropic", model: "f", cost: { input: "bad" } },
      ],
    },
  ]) {
    const snapshot = sdkContextSnapshot(
      "offline",
      { ...contextModel, ...JSON.parse(JSON.stringify({ compat })) },
      normalizeContext({ messages: [] }),
      capturedInvocation(contextModel.api),
    );
    expect(snapshot.unavailableReason).toBeDefined();
    const input = { ...call("anthropic-messages", []), sdkContext: snapshot };
    expect(() => retainedContext(input, empty)).toThrow(
      "unsupported SDK compatibility",
    );
  }
});
test("malformed persisted message fields are rejected at the typed SDK boundary", () => {
  const snapshot = sdkContextSnapshot(
    "offline",
    contextModel,
    normalizeContext({ messages: [] }),
    capturedInvocation(contextModel.api),
  );
  for (const message of [
    { role: "user", timestamp: 1, content: 7 },
    {
      role: "system",
      timestamp: 1,
      content: "safe",
      toolsAdded: [
        {
          name: "t",
          description: "d",
          parameters: {},
          constrainedSampling: {
            type: "grammar",
            variants: { openai_regex: 1 },
          },
        },
      ],
    },
  ]) {
    expect(() =>
      retainedContext(
        {
          ...call("anthropic-messages", []),
          sdkContext: { ...snapshot, messages: [Json.parse(message)] },
        },
        empty,
      ),
    ).toThrow();
  }
});
test("context excludes credentials and callbacks while preserving declared tool metadata", () => {
  const model = {
    ...contextModel,
    headers: { Authorization: "provider-header-secret" },
    apiKey: "api-key-secret",
    env: { token: "environment-secret" },
    onPayload: () => "callback-secret",
  };
  const tool = {
    name: "t",
    description: "literal description",
    parameters: {
      type: "object",
      properties: {
        user: { type: "string", description: "literal parameter" },
      },
    },
    execute: () => "tool-callback-secret",
    constrainedSampling: {
      type: "grammar" as const,
      variants: { openai_lark: "start: /.+/" },
    },
  };
  const snapshot = sdkContextSnapshot(
    "offline",
    model,
    normalizeContext({
      messages: [
        { role: "system", timestamp: 0, content: "system", toolsAdded: [tool] },
      ],
    }),
    capturedInvocation(model.api),
  );
  const serialized = JSON.stringify(snapshot);
  for (const secret of [
    "provider-header-secret",
    "api-key-secret",
    "environment-secret",
    "callback-secret",
    "tool-callback-secret",
    "execute",
  ])
    expect(serialized).not.toContain(secret);
  expect(serialized).toContain("literal parameter");
  expect(serialized).toContain("openai_lark");
  expect(snapshot.unavailableReason).toBeUndefined();
});

test("older saved contexts cannot silently synthesize new model semantics", () => {
  const snapshot = sdkContextSnapshot(
    "offline",
    contextModel,
    normalizeContext({ messages: [] }),
    capturedInvocation(contextModel.api),
  );
  const { cost: _cost, input: _input, ...model } = snapshot.model;
  expect(() =>
    retainedContext(
      { ...call("anthropic-messages", []), sdkContext: { ...snapshot, model } },
      empty,
    ),
  ).toThrow("original SDK model context was not captured");
});
