import { captureSdk } from "./sdk-fixture.ts";
import { expect, test } from "bun:test";
import OpenAI from "openai";
import {
  formatProviderError,
  normalizeProviderError,
} from "@earendil-works/pi-ai/utils/error-body";
import { CallRecord } from "../../../src/pi/capture/dump.ts";
import {
  retainedSdk,
  RetainedSdkUnavailable,
} from "../../../src/pi/capture/retained-sdk.ts";
import {
  providerOutput,
  reconcileProviderOutput,
} from "../../../src/pi/capture/provider-output.ts";

import { Json } from "../../../src/pi/capture/types.ts";

const empty = { conversations: [], session: [] };
const fixtures = [
  [
    "flat",
    '{"type":"error","code":"synthetic_code","message":"inner failure"}',
    "inner failure",
    true,
  ],
  [
    "nested",
    '{"type":"error","error":{"code":"synthetic_code","message":"inner failure"}}',
    "inner failure",
    true,
  ],
  [
    "outer decoy",
    '{"type":"error","code":"decoy","message":"outer failure","error":{"code":"synthetic_code","message":"inner failure"}}',
    "inner failure",
    true,
  ],
  [
    "null nested",
    '{"type":"error","code":"synthetic_code","message":"inner failure","error":null}',
    "inner failure",
    true,
  ],
  [
    "nested type",
    '{"type":"error","error":{"type":"synthetic_code","message":"inner failure"}}',
    "inner failure",
    true,
  ],
  [
    "duplicate nested last",
    '{"type":"error","error":{"code":"decoy","message":"outer failure"},"error":{"code":"synthetic_code","message":"inner failure"}}',
    "inner failure",
    true,
  ],
  [
    "duplicate message last",
    '{"type":"error","code":"synthetic_code","message":"outer failure","message":"inner failure"}',
    "inner failure",
    true,
  ],
  [
    "string nested",
    '{"type":"error","code":"synthetic_code","message":"inner failure","error":"unsupported"}',
    undefined,
    false,
  ],
  [
    "array nested",
    '{"type":"error","code":"synthetic_code","message":"inner failure","error":[]}',
    undefined,
    false,
  ],
  [
    "numeric code",
    '{"type":"error","error":{"code":7,"message":"inner failure"}}',
    "inner failure",
    false,
  ],
  [
    "empty message",
    '{"type":"error","error":{"code":"synthetic_code","message":""}}',
    undefined,
    false,
  ],
  [
    "object message",
    '{"type":"error","error":{"code":"synthetic_code","message":{"text":"inner failure"}}}',
    undefined,
    false,
  ],
] satisfies ReadonlyArray<
  readonly [string, string, string | undefined, boolean]
>;

const callFor = async (raw: string, name = "error") =>
  captureSdk(
    CallRecord.parse({
      callId: "synthetic-transport",
      role: "unjoined",
      scope: { runId: "synthetic-transport" },
      route: "synthetic",
      provider: "openai",
      model: "synthetic",
      api: "openai-responses",
      credentialCoverage: "none",
      headerNames: [],
      body: { status: "sent", json: {} },
      requestedAt: 1,
      response: { at: 2, status: 200, requestId: "synthetic-trace" },
      events: [{ at: 3, name, data: JSON.parse(raw) }],
      end: {
        at: 4,
        outcome: "failed",
        stopReason: "error",
        error: {
          type: "synthetic_code",
          message:
            "OpenAI API error (HTTP 200, synthetic_code): inner failure (request synthetic-trace)",
        },
      },
    }),
  );

const transportError = async (raw: string, name = "error") => {
  if (Object.hasOwn(process.env, "OPENAI_CUSTOM_HEADERS"))
    throw new Error("ambient provider configuration prevents isolated replay");
  let requests = 0;
  const client = new OpenAI({
    apiKey: "retained-offline-dummy",
    adminAPIKey: null,
    organization: null,
    project: null,
    webhookSecret: null,
    baseURL: "https://capture.invalid",
    maxRetries: 0,
    logLevel: "off",
    logger: { error() {}, warn() {}, info() {}, debug() {} },
    fetch: async () => {
      requests++;
      return new Response(`event: ${name}\ndata: ${raw}\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  try {
    const stream = await client.responses.create({
      model: "synthetic",
      input: [],
      stream: true,
    });
    for await (const _event of stream) {
    }
  } catch (error) {
    expect(requests).toBe(1);
    return formatProviderError(
      normalizeProviderError(error),
      "OpenAI API error",
    );
  }
  throw new Error("expected actual SDK transport failure");
};

for (const [label, raw, expected, agrees] of fixtures)
  test(`retained OpenAI transport agrees with the pinned client for ${label}`, async () => {
    const actual = await transportError(raw);
    if (expected !== undefined) expect(actual).toBe(expected);
    const call = await callFor(raw);
    const output = await providerOutput(call);
    expect(output?.finish?.errorMessage).toBe(actual);
    if (output === null) throw new Error("missing transport output");
    if (agrees) {
      expect(() => reconcileProviderOutput(call, output)).not.toThrow();
      const changed = structuredClone(call);
      changed.end!.error!.message = "contradictory effective failure";
      expect(() => reconcileProviderOutput(changed, output)).toThrow(
        "contradicts",
      );
    } else
      expect(() => reconcileProviderOutput(call, output)).toThrow(
        "contradicts",
      );
  });

test("OpenAI transport observes nested errors outside an error event", async () => {
  const raw =
    '{"type":"response.in_progress","response":{"id":"r","status":"in_progress"},"error":{"code":"synthetic_code","message":"inner failure"}}';
  const call = await callFor(raw, "response.in_progress");
  const result = await retainedSdk(call, empty);
  expect(result).toMatchObject({
    stopReason: "error",
    errorMessage: await transportError(raw, "response.in_progress"),
  });
});

test("subscription failures retain the pinned native SDK usage link", async () => {
  const raw =
    '{"type":"error","error":{"code":"subscription_sharing_usage_limit_exceeded","message":"subscription_sharing_usage_limit_exceeded"}}';
  expect(await retainedSdk(await callFor(raw), empty)).toMatchObject({
    stopReason: "error",
    errorMessage:
      "subscription_sharing_usage_limit_exceeded\nCheck your ChatGPT usage: https://chatgpt.com/settings/usage",
  });
});

test("OpenAI replay refuses ambient custom headers before reading their value", async () => {
  const call = await callFor(fixtures[0]![1]);
  const prior = process.env;
  process.env = Object.defineProperty({}, "OPENAI_CUSTOM_HEADERS", {
    get() {
      throw new Error("ambient header value was read");
    },
  });
  try {
    await expect(retainedSdk(call, empty)).rejects.toBeInstanceOf(
      RetainedSdkUnavailable,
    );
  } finally {
    process.env = prior;
  }
});

test("OpenAI replay supplies auth metadata without reading ambient values", async () => {
  const call = await callFor(fixtures[0]![1]);
  const prior = process.env;
  const reads: string[] = [];
  process.env = Object.fromEntries(
    [
      "OPENAI_API_KEY",
      "OPENAI_ADMIN_KEY",
      "OPENAI_ORG_ID",
      "OPENAI_PROJECT_ID",
      "OPENAI_WEBHOOK_SECRET",
      "OPENAI_BASE_URL",
      "OPENAI_LOG",
    ].map((key) => [key, "synthetic-unread-value"]),
  );
  for (const key of Object.keys(process.env))
    Object.defineProperty(process.env, key, {
      get() {
        reads.push(key);
        throw new Error("ambient auth value was read");
      },
    });
  try {
    expect(await retainedSdk(call, empty)).toMatchObject({
      stopReason: "error",
      errorMessage: "inner failure",
    });
    expect(reads).toEqual([]);
  } finally {
    process.env = prior;
  }
});

test("OpenAI replay keeps unavailable invocation metadata explicit", async () => {
  const original = await callFor(fixtures[0]![1]);
  const ending = original.events.find(
    ({ name }) => name === "sdk_invocation_end",
  )!;
  expect(ending.data).toMatchObject({
    callbacks: 0,
    abort: { status: "not-aborted" },
  });
  for (const missing of [
    "context",
    "invocation",
    "cache-retention",
    "end",
    "callbacks",
  ] as const) {
    const call = structuredClone(original);
    if (missing === "context") delete call.sdkContext;
    else if (missing === "invocation") delete call.sdkContext!.invocation;
    else if (missing === "cache-retention")
      delete call.sdkContext!.invocation!.options.cacheRetention;
    else if (missing === "end")
      call.events = call.events.filter(
        ({ name }) => name !== "sdk_invocation_end",
      );
    else {
      const end = call.events.find(
        ({ name }) => name === "sdk_invocation_end",
      )!;
      end.data = {
        version: 1,
        callId: call.callId,
        callbacks: 1,
        abort: { status: "not-aborted" },
      };
    }
    await expect(retainedSdk(call, empty), missing).rejects.toThrow();
  }
});
