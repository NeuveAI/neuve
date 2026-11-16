import { expect, test } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import { stream as anthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { z } from "zod";
import { stream } from "@earendil-works/pi-ai/api/openai-responses";
import { retainedSdk } from "../../../src/pi/capture/retained-sdk.ts";
import { sdkContextSnapshot } from "../../../src/pi/capture/retained-context.ts";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import type { CallRecord } from "../../../src/pi/capture/dump.ts";
import { Json } from "../../../src/pi/capture/types.ts";

const model = {
  id: "actual-original-alias",
  name: "original",
  api: "openai-responses" as const,
  provider: "openai",
  baseUrl: "https://capture.invalid/v1",
  reasoning: true,
  input: ["text" as const],
  contextWindow: 1000,
  maxTokens: 100,
  cost: { input: 2, output: 4, cacheRead: 1, cacheWrite: 2 },
};
const context = normalizeContext({
  messages: [{ role: "user", content: "original transcript", timestamp: 1 }],
});
const opening = {
  type: "response.created",
  response: { id: "r", status: "in_progress", model: "provider-alias" },
};
const cases = [
  {
    name: "usage limit",
    terminal: {
      type: "response.incomplete",
      response: {
        id: "r",
        status: "incomplete",
        incomplete_details: {
          reason: "subscription_sharing_usage_limit_exceeded",
        },
      },
    },
    expected:
      "Response incomplete: subscription_sharing_usage_limit_exceeded\nCheck your ChatGPT usage: https://chatgpt.com/settings/usage",
  },
  {
    name: "content filter",
    terminal: {
      type: "response.incomplete",
      response: {
        id: "r",
        status: "incomplete",
        incomplete_details: { reason: "content_filter" },
      },
    },
    expected: "Response incomplete: content_filter",
  },
  {
    name: "unknown incomplete",
    terminal: {
      type: "response.incomplete",
      response: { id: "r", status: "incomplete" },
    },
    expected: "Response incomplete without a provider reason",
  },
  {
    name: "failed envelope",
    terminal: {
      type: "response.failed",
      response: {
        id: "r",
        status: "failed",
        error: { code: "original_code", message: "original failure" },
      },
    },
    expected: "original_code: original failure",
  },
  {
    name: "original SDK envelope",
    terminal: {
      type: "error",
      error: {
        type: "server_error",
        code: "original_code",
        message: "original failure",
      },
    },
    expected: "original failure",
  },
  {
    name: "flat SDK envelope",
    terminal: {
      type: "error",
      code: "original_code",
      message: "original flat failure",
    },
    expected: "original flat failure",
  },
  {
    name: "EOF",
    terminal: undefined,
    expected: "OpenAI Responses stream ended before a terminal response event",
  },
];
for (const example of cases)
  test(`retained output uses the complete public SDK wrapper for ${example.name}`, async () => {
    const frames = [
      opening,
      ...(example.terminal === undefined ? [] : [example.terminal]),
    ];
    const call: Omit<CallRecord, "role"> = {
      callId: "original-call",
      scope: { runId: "offline" },
      route: "synthetic",
      provider: "openai",
      model: model.id,
      api: model.api,
      headerNames: [],
      credentialCoverage: "none",
      body: { status: "sent", json: { stream: true } },
      requestedAt: 0,
      response: null,
      end: null,
      sdkContext: sdkContextSnapshot("original-call", model, context, {
        version: 1,
        api: "openai-responses",
        options: { cacheRetention: "none" },
      }),
      events: [
        ...frames.map((frame) => ({
          at: 0,
          name: frame.type,
          data: Json.parse(frame),
        })),
        {
          at: 0,
          name: "sdk_invocation_end",
          data: {
            version: 1,
            callId: "original-call",
            callbacks:
              frames.length - (example.terminal?.type === "error" ? 1 : 0),
            abort: { status: "not-aborted" },
          },
        },
      ],
    };
    let requests = 0;
    const oracle = stream(model, context, {
      apiKey: "retained-offline-dummy",
      env: {},
      cacheRetention: "none",
      maxRetries: 0,
      fetch: Object.assign(
        async () => {
          requests++;
          return new Response(
            frames
              .map(
                (frame) =>
                  `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`,
              )
              .join(""),
            { headers: { "content-type": "text/event-stream" } },
          );
        },
        { preconnect() {} },
      ),
    });
    const expected = await oracle.result();
    const scalars: string[] = [];
    const actual = await retainedSdk(
      call,
      { conversations: [], session: [] },
      (value) => scalars.push(value),
    );
    const { timestamp: _expectedTime, ...expectedStable } = expected;
    if (actual === null || typeof actual !== "object" || Array.isArray(actual))
      throw Error("SDK message");
    const actualStable = Object.fromEntries(
      Object.entries(actual).filter(([key]) => key !== "timestamp"),
    );
    expect(Json.parse(actualStable)).toEqual(Json.parse(expectedStable));
    expect(actual).toMatchObject({
      model: model.id,
      errorMessage: example.expected,
    });
    expect(scalars).toContain(example.expected);
    expect(scalars).toContain("original transcript");
    expect(requests).toBe(1);
  });

const semanticCall = (
  target:
    | typeof model
    | (Omit<typeof model, "api" | "provider" | "id"> & {
        id: string;
        api: "anthropic-messages";
        provider: string;
        compat: { supportsMidConvoEffort: boolean };
      }),
  frames: readonly { type: string }[],
  invocation: Parameters<typeof sdkContextSnapshot>[3],
  callbacks?: number,
): Omit<CallRecord, "role"> => ({
  callId: "semantics",
  scope: { runId: "offline" },
  route: "synthetic",
  provider: target.provider,
  model: target.id,
  api: target.api,
  headerNames: [],
  credentialCoverage: "none",
  body: { status: "sent", json: { stream: true } },
  requestedAt: 0,
  response: null,
  end: null,
  sdkContext: sdkContextSnapshot("semantics", target, context, invocation),
  events: [
    ...frames.map((frame) => ({
      at: 0,
      name: frame.type,
      data: Json.parse(frame),
    })),
    ...(callbacks === undefined
      ? []
      : [
          {
            at: 0,
            name: "sdk_invocation_end",
            data: Json.parse({
              version: 1,
              callId: "semantics",
              callbacks,
              abort: { status: "not-aborted" },
            }),
          },
        ]),
  ],
});

const successful = [
  opening,
  {
    type: "response.completed",
    response: {
      id: "r",
      status: "completed",
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    },
  },
];

test("requested flex service tier applies when the response omits its service tier", async () => {
  const options = {
    serviceTier: "flex" as const,
    cacheRetention: "none" as const,
  };
  const expected = await stream(model, context, {
    ...options,
    apiKey: "retained-offline-dummy",
    env: {},
    maxRetries: 0,
    fetch: Object.assign(
      async () =>
        new Response(
          successful
            .map(
              (frame) =>
                `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`,
            )
            .join(""),
          { headers: { "content-type": "text/event-stream" } },
        ),
      { preconnect() {} },
    ),
  }).result();
  const actual = await retainedSdk(
    semanticCall(
      model,
      successful,
      { version: 1, api: "openai-responses", options },
      2,
    ),
    { conversations: [], session: [] },
  );
  expect(actual).toMatchObject({ model: model.id, stopReason: "stop" });
  const priced = z
    .object({
      usage: z.object({
        cost: z.object({
          input: z.number(),
          output: z.number(),
          total: z.number(),
        }),
      }),
    })
    .parse(actual);
  expect(priced.usage.cost.input).toBeCloseTo(0.00001, 12);
  expect(priced.usage.cost.output).toBeCloseTo(0.00001, 12);
  expect(priced.usage.cost.total).toBeCloseTo(0.00002, 12);
  const stable = (value: unknown) =>
    Json.parse(
      Object.fromEntries(
        Object.entries(Json.parse(value) ?? {}).filter(
          ([key]) => key !== "timestamp",
        ),
      ),
    );
  expect(stable(actual)).toEqual(stable(expected));
});

test("missing invocation, completed end and callback contradictions refuse", async () => {
  const known = {
    version: 1 as const,
    api: "openai-responses" as const,
    options: { cacheRetention: "none" as const },
  };
  await expect(
    retainedSdk(semanticCall(model, successful, undefined, 2), {
      conversations: [],
      session: [],
    }),
  ).rejects.toBeDefined();
  await expect(
    retainedSdk(
      semanticCall(
        model,
        successful,
        { version: 1, api: "openai-responses", options: {} },
        2,
      ),
      { conversations: [], session: [] },
    ),
  ).rejects.toThrow("cache retention");
  const missingEnd = semanticCall(model, successful, known);
  missingEnd.end = { at: 0, outcome: "completed", stopReason: "stop" };
  await expect(
    retainedSdk(
      missingEnd,
      { conversations: [], session: [] },
      undefined,
      undefined,
      { purpose: "scalar-enumeration" },
    ),
  ).rejects.toBeDefined();
  await expect(
    retainedSdk(semanticCall(model, successful, known, 1), {
      conversations: [],
      session: [],
    }),
  ).rejects.toBeDefined();
});

test("unresolved signal abortion refuses while an interrupted prefix has derived SDK views", async () => {
  const frames = [
    opening,
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id: "m", content: [] },
    },
    {
      type: "response.output_text.delta",
      output_index: 0,
      delta: "retained interrupted prefix",
    },
  ];
  const prefix = semanticCall(model, frames, {
    version: 1,
    api: "openai-responses",
    options: { cacheRetention: "none" },
  });
  const strings: string[] = [];
  const actual = await retainedSdk(
    prefix,
    { conversations: [], session: [] },
    (value) => strings.push(value),
    undefined,
    { purpose: "scalar-enumeration" },
  );
  expect(actual).toMatchObject({
    content: [{ type: "text", text: "retained interrupted prefix" }],
  });
  expect(strings).toContain("retained interrupted prefix");
  const aborted = structuredClone(prefix);
  aborted.events.push({
    at: 0,
    name: "sdk_invocation_end",
    data: {
      version: 1,
      callId: "semantics",
      callbacks: 3,
      abort: {
        status: "aborted",
        afterCallbacks: 3,
        boundary: "unresolved",
        reason: {
          kind: "error",
          name: "AbortError",
          message: "actual captured cancellation",
        },
      },
    },
  });
  const original = JSON.stringify(aborted);
  await expect(
    retainedSdk(
      aborted,
      { conversations: [], session: [] },
      undefined,
      undefined,
      { purpose: "scalar-enumeration" },
    ),
  ).rejects.toBeDefined();
  expect(JSON.stringify(aborted)).toBe(original);
});

test("captured Anthropic effort owns thinking level and preserves the original model alias", async () => {
  const target = {
    ...model,
    id: "claude-opus-4-7",
    api: "anthropic-messages" as const,
    provider: "anthropic",
    compat: { supportsMidConvoEffort: true },
  };
  const frames = [
    {
      type: "message_start",
      message: {
        id: "a",
        model: "actual-provider-alias",
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 3 },
    },
    { type: "message_stop" },
  ];
  const options = {
    effort: "low" as const,
    maxTokens: 100,
    cacheRetention: "long" as const,
  };
  const oracle = anthropic(target, context, {
    ...options,
    env: {},
    maxRetries: 0,
    client: new Anthropic({
      apiKey: "retained-offline-dummy",
      authToken: null,
      webhookKey: null,
      logLevel: "off",
      logger: { error() {}, warn() {}, info() {}, debug() {} },
      baseURL: "https://capture.invalid",
      maxRetries: 0,
      fetch: async () =>
        new Response(
          frames
            .map(
              (frame) =>
                `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`,
            )
            .join(""),
          { headers: { "content-type": "text/event-stream" } },
        ),
    }),
  });
  const expected = await oracle.result();
  const actual = await retainedSdk(
    semanticCall(
      target,
      frames,
      { version: 1, api: "anthropic-messages", authMode: "non-oauth", options },
      3,
    ),
    { conversations: [], session: [] },
  );
  expect(actual).toMatchObject({
    model: "claude-opus-4-7",
    responseModel: "actual-provider-alias",
    providerThinkingLevel: "low",
    stopReason: "stop",
    usage: { input: 10, output: 3, totalTokens: 13 },
  });
  const stable = (value: unknown) =>
    Json.parse(
      Object.fromEntries(
        Object.entries(Json.parse(value) ?? {}).filter(
          ([key]) => key !== "timestamp",
        ),
      ),
    );
  expect(stable(actual)).toEqual(stable(expected));
  for (const authMode of ["oauth", "unknown"] as const)
    await expect(
      retainedSdk(
        semanticCall(
          target,
          frames,
          { version: 1, api: "anthropic-messages", authMode, options },
          3,
        ),
        { conversations: [], session: [] },
      ),
    ).rejects.toBeDefined();
});
