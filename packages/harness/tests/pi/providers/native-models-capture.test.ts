import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  InMemoryCredentialStore,
  Type,
  type Models,
} from "@earendil-works/pi-ai";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { CallRecord } from "../../../src/pi/capture/dump.ts";
import { retainedContext } from "../../../src/pi/capture/retained-context.ts";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import {
  CredentialJson,
  InspectionBudget,
} from "../../../src/pi/capture/credential-detectors.ts";
import { createPrivateInspection } from "../../../src/pi/capture/private-inspection.ts";
import { Json, type ModelCaptureEvent } from "../../../src/pi/capture/types.ts";
import { SourceOwnership } from "../../../src/pi/source-ownership.ts";
import { captureNativeModels } from "../../../src/pi/providers/native-models-capture.ts";
import { completed, created, messageItem, sse } from "./fixture.ts";

const KEY = "synthetic-native-only-key-9b83d94a";
const directory = mkdtempSync(join(tmpdir(), "native-models-capture-"));
afterAll(() => rmSync(directory, { force: true, recursive: true }));
const native = async () => {
  const credentials = new InMemoryCredentialStore();
  for (const provider of ["anthropic", "openai", "google"])
    await credentials.modify(provider, async () => ({
      type: "api_key",
      key: KEY,
    }));
  return builtinModels({
    credentials,
    authContext: { env: async () => undefined, fileExists: async () => false },
  });
};
const select = (models: Models, provider: string) => {
  const model = models.getModels(provider)[0];
  if (model === undefined) throw new Error(`Pinned catalog lacks ${provider}`);
  return model;
};
const answer = (text = "native answer") =>
  sse([
    {
      type: "message_start",
      message: {
        id: "msg_native",
        type: "message",
        role: "assistant",
        model: "native-physical-model",
        content: [],
        stop_reason: null,
        usage: { input_tokens: 7, output_tokens: 1 },
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
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 4 },
    },
    { type: "message_stop" },
  ]);
const local = (response: () => Response) => {
  const received: Array<{ body: Json; headers: Headers; path: string }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      received.push({
        body: Json.parse(await request.json()),
        headers: request.headers,
        path: new URL(request.url).pathname,
      });
      return response();
    },
  });
  return { server, received };
};
const capture = (defaults: Models, events: ModelCaptureEvent[]) =>
  captureNativeModels(defaults, {
    capture: (event) => events.push(event),
    credentialInspection: "ephemeral",
    runId: "native-test",
  });

test("native provider catalogs, prices, effort, availability and private auth remain the original SDK's", async () => {
  const defaults = await native();
  const wrapped = capture(defaults, []);
  expect(wrapped.getProviders()).toEqual(defaults.getProviders());
  for (const provider of defaults.getProviders())
    expect(wrapped.getProvider(provider.id)).toBe(provider);
  expect(wrapped.getAllModels()).toEqual(defaults.getAllModels());
  expect(wrapped.getModels("openai")).toEqual(defaults.getModels("openai"));
  expect(await wrapped.getAvailable("anthropic")).toEqual(
    await defaults.getAvailable("anthropic"),
  );
  expect(await wrapped.getAuth("anthropic")).toEqual(
    await defaults.getAuth("anthropic"),
  );
  expect(await wrapped.checkAuth("openai")).toEqual(
    await defaults.checkAuth("openai"),
  );
  expect(await wrapped.refresh({ allowNetwork: false, providers: [] })).toEqual(
    { aborted: false, errors: new Map() },
  );
  const model = select(defaults, "openai");
  expect(wrapped.getModel("openai", model.id)).toBe(model);
  expect(wrapped.getModelOfType("chat", "openai", model.id)).toBe(model);
  expect(wrapped.getModelsOfType("chat", "openai")).toEqual(
    defaults.getModels("openai"),
  );
});

test("actual pinned Anthropic SDK captures the HTTP body and offered tools, preserves execution and privately guards auth", async () => {
  const defaults = await native();
  const endpoint = local(() => answer());
  const root = mkdtempSync(join(directory, "authority-"));
  const source = join(root, "source");
  mkdirSync(source, { mode: 0o700 });
  const ownership = SourceOwnership.acquire(source);
  const inspection = createPrivateInspection({
    ownership,
    source,
    directory: join(root, "private"),
    excludedRoots: [source],
  });
  const events: ModelCaptureEvent[] = [];
  const wrapped = captureNativeModels(defaults, {
    capture: (event) => events.push(event),
    credentialInspection: inspection,
    runId: "native-durable",
    agent: "actual-agent",
  });
  const model = {
    ...select(defaults, "anthropic"),
    baseUrl: endpoint.server.url.origin,
  };
  const input = {
    systemPrompt: "A native system prompt",
    messages: [
      {
        role: "user",
        content: JSON.stringify({ nested: JSON.stringify({ token: KEY }) }),
        timestamp: 100,
      },
    ],
    tools: [
      {
        name: "read_source",
        description: "Read selected source",
        parameters: Type.Object({
          path: Type.String(),
          thought: Type.String({ description: "A legitimate field" }),
          thoughts: Type.Array(Type.String()),
        }),
      },
    ],
  } satisfies Parameters<Models["streamSimple"]>[1];
  let payloads = 0;
  let responses = 0;
  let providerEvents = 0;
  try {
    const result = await wrapped.completeSimple(model, input, {
      maxRetries: 0,
      onPayload: () => {
        payloads++;
      },
      onResponse: () => {
        responses++;
      },
      onProviderStreamEvent: () => {
        providerEvents++;
      },
    });
    expect(result.stopReason).toBe("stop");
    expect(result.content).toEqual([{ type: "text", text: "native answer" }]);
    expect(result.provider).toBe("anthropic");
    expect(endpoint.received).toHaveLength(1);
    expect(endpoint.received[0]?.headers.get("x-api-key")).toBe(KEY);
    expect(payloads).toBe(1);
    expect(responses).toBe(1);
    expect(providerEvents).toBe(6);
    const request = events.find((event) => event.type === "model.request");
    expect(request?.type).toBe("model.request");
    if (request?.type !== "model.request")
      throw new Error("No request captured");
    expect(request.scope).toEqual({
      runId: "native-durable",
      agent: "actual-agent",
    });
    expect(request.provider).toBe("anthropic");
    expect(request.model).toBe(model.id);
    expect(request.path).toBe("/v1/messages");
    expect(request.body.status).toBe("sent");
    const physicalBody = JSON.stringify(endpoint.received[0]?.body);
    expect(physicalBody).toContain('"name":"read_source"');
    expect(physicalBody).toContain(KEY);
    expect(JSON.stringify(request.body)).toContain('"name":"read_source"');
    expect(JSON.stringify(request.body)).toContain("[REDACTED]");
    expect(request.body).toMatchObject({
      json: {
        tools: expect.arrayContaining([
          expect.objectContaining({
            input_schema: expect.objectContaining({
              properties: {
                path: { type: "string" },
                thought: { type: "string", description: "A legitimate field" },
                thoughts: { type: "array", items: { type: "string" } },
              },
            }),
          }),
        ]),
      },
    });
    expect(JSON.stringify(events)).not.toContain(KEY);
    expect(
      events.find((event) => event.type === "credential.registration"),
    ).toMatchObject({ callId: request.callId });
    expect(
      events.find((event) => event.type === "model.response"),
    ).toMatchObject({ status: 200 });
    expect(events.find((event) => event.type === "model.end")).toMatchObject({
      outcome: "completed",
      sdkUsage: { input: 7, output: 4, totalTokens: 11 },
      usage: { input: 7, output: 4, totalTokens: 11 },
    });
    expect(
      events.find(
        (event) =>
          event.type === "model.event" && event.name === "native_call_timing",
      ),
    ).toBeDefined();
    const inspected = await inspection.inspectJson({
      json: CredentialJson.serialize({ quoted: JSON.stringify(KEY) }),
      budget: new InspectionBudget(),
    });
    expect(inspected.status).toBe("complete");
    if (inspected.status === "complete")
      expect(inspected.matches.length).toBeGreaterThan(0);
    expect(
      readFileSync(join(root, "private", "authority.sqlite")).includes(KEY),
    ).toBe(false);
    expect(request.sdkContext?.unavailableReason).toContain("not certified");
    const { type: _type, ...requestFields } = request;
    const call = CallRecord.parse({
      ...requestFields,
      role: "unjoined",
      requestedAt: 1,
      response: null,
      end: null,
      events: [],
    });
    expect(() =>
      retainedContext(call, { conversations: [], session: [] }),
    ).toThrow("not certified");
  } finally {
    endpoint.server.stop(true);
    inspection.close();
    ownership.release();
  }
});

test("actual pinned OpenAI stream keeps effective payload changes, request callbacks and per-attempt usage", async () => {
  const defaults = await native();
  const endpoint = local(() =>
    sse([
      created("resp_native"),
      ...messageItem(0, "item", "final_answer", "OpenAI local answer"),
      completed("resp_native"),
    ]),
  );
  const events: ModelCaptureEvent[] = [];
  const wrapped = capture(defaults, events);
  const catalogModel = defaults
    .getModels("openai")
    .find((entry) => entry.api === "openai-responses");
  if (catalogModel === undefined)
    throw new Error("Pinned SDK lacks Responses model");
  const model = {
    ...catalogModel,
    baseUrl: `${endpoint.server.url.origin}/v1`,
  };
  let headerTransforms = 0;
  try {
    const result = await wrapped.complete(
      model,
      { messages: [{ role: "user", content: "native OpenAI", timestamp: 1 }] },
      {
        maxRetries: 0,
        transformHeaders: (headers) => {
          headerTransforms++;
          return { ...headers, "x-native-transformed": "kept" };
        },
        onPayload: (payload) => {
          const body = Json.parse(JSON.parse(JSON.stringify(payload)));
          if (body === null || typeof body !== "object" || Array.isArray(body))
            throw new Error("Unexpected SDK payload");
          return { ...body, metadata: { local: "effective change" } };
        },
      },
    );
    expect(result.stopReason).toBe("stop");
    expect(result.responseId).toBe("resp_native");
    expect(headerTransforms).toBe(1);
    expect(endpoint.received[0]?.headers.get("x-native-transformed")).toBe(
      "kept",
    );
    const request = events.find((event) => event.type === "model.request");
    expect(request?.type).toBe("model.request");
    if (request?.type !== "model.request")
      throw new Error("Missing native request");
    const physical = endpoint.received[0];
    if (physical === undefined) throw new Error("No request received");
    expect(request.body).toEqual({ status: "sent", json: physical.body });
    expect(events.find((event) => event.type === "model.end")).toMatchObject({
      responseId: "resp_native",
      usage: { input: 10, output: 5, totalTokens: 15 },
    });
  } finally {
    endpoint.server.stop(true);
  }
});

test("credential echoes are masked in captured events and refused before the native terminal result", async () => {
  const defaults = await native();
  const endpoint = local(() => answer(KEY));
  const events: ModelCaptureEvent[] = [];
  try {
    const wrapped = capture(defaults, events);
    const result = await wrapped.completeSimple(
      { ...select(defaults, "anthropic"), baseUrl: endpoint.server.url.origin },
      { messages: [{ role: "user", content: "echo fixture", timestamp: 1 }] },
      { maxRetries: 0 },
    );
    expect(result.stopReason).toBe("error");
    expect(result.content).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(JSON.stringify(events)).not.toContain(KEY);
    expect(
      events.find(
        (event) =>
          event.type === "credential.guard" && event.status === "exposed",
      ),
    ).toBeDefined();
  } finally {
    endpoint.server.stop(true);
  }
});

test("native HTTP retries preserve provider behavior and record distinct physical attempts", async () => {
  const defaults = await native();
  let attempts = 0;
  const endpoint = local(() =>
    ++attempts === 1
      ? new Response(
          JSON.stringify({
            type: "error",
            error: { type: "overloaded_error", message: "local retry" },
          }),
          {
            status: 529,
            headers: {
              "content-type": "application/json",
              "retry-after-ms": "1",
            },
          },
        )
      : answer(),
  );
  const events: ModelCaptureEvent[] = [];
  try {
    const result = await capture(defaults, events).completeSimple(
      { ...select(defaults, "anthropic"), baseUrl: endpoint.server.url.origin },
      { messages: [{ role: "user", content: "retry", timestamp: 1 }] },
      { maxRetries: 1 },
    );
    expect(result.stopReason).toBe("stop");
    expect(attempts).toBe(2);
    const requests = events.filter((event) => event.type === "model.request");
    const ends = events.filter((event) => event.type === "model.end");
    expect(requests).toHaveLength(2);
    expect(new Set(requests.map((request) => request.callId)).size).toBe(2);
    expect(ends.map((event) => event.outcome)).toEqual(["failed", "completed"]);
  } finally {
    endpoint.server.stop(true);
  }
});

test("an unsupported SDK transport remains executable and declares the absent wire observation", async () => {
  const defaults = await native();
  const events: ModelCaptureEvent[] = [];
  let reachedNativePayload = false;
  const result = await capture(defaults, events).completeSimple(
    select(defaults, "google"),
    { messages: [{ role: "user", content: "local stop", timestamp: 1 }] },
    {
      onPayload: () => {
        reachedNativePayload = true;
        throw new Error("Local fixture stops before network");
      },
    },
  );
  expect(reachedNativePayload).toBe(true);
  expect(result.stopReason).toBe("error");
  expect(result.errorMessage).toContain("Local fixture stops before network");
  expect(events.find((event) => event.type === "model.request")).toMatchObject({
    body: { status: "missing" },
  });
  expect(
    events.find(
      (event) =>
        event.type === "model.event" && event.name === "native_capture_gap",
    ),
  ).toBeDefined();
});

test("capture rejection prevents a physical send through the actual pinned SDK", async () => {
  const defaults = await native();
  const endpoint = local(() => answer());
  try {
    const wrapped = captureNativeModels(defaults, {
      runId: "native-rejected",
      credentialInspection: "ephemeral",
      capture: () => {
        throw new Error("Local capture rejection");
      },
    });
    const result = await wrapped.completeSimple(
      { ...select(defaults, "anthropic"), baseUrl: endpoint.server.url.origin },
      { messages: [{ role: "user", content: "not sent", timestamp: 1 }] },
      { maxRetries: 0 },
    );
    expect(result.stopReason).toBe("error");
    expect(endpoint.received).toHaveLength(0);
  } finally {
    endpoint.server.stop(true);
  }
});

test.each(["caption", "recap"] as const)(
  "native %s raw captures retain provider reasoning and their actual conversation identity",
  async (purpose) => {
    const defaults = await native();
    const secretReasoning = "synthetic-hidden-native-reasoning";
    const secretSignature = "synthetic-encrypted-native-signature";
    const endpoint = local(() =>
      sse([
        {
          type: "message_start",
          message: {
            id: "msg_auxiliary",
            type: "message",
            role: "assistant",
            model: "native-model",
            content: [],
            stop_reason: null,
            usage: { input_tokens: 3, output_tokens: 1 },
          },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", thinking: "", signature: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: secretReasoning },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "signature_delta", signature: secretSignature },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 2 },
        },
        { type: "message_stop" },
      ]),
    );
    const events: ModelCaptureEvent[] = [];
    try {
      const wrapped = captureNativeModels(defaults, {
        runId: "auxiliary",
        purpose,
        conversationId: ROOT_CONVERSATION_ID,
        capture: (event) => events.push(event),
        credentialInspection: "ephemeral",
      });
      const result = await wrapped.completeSimple(
        {
          ...select(defaults, "anthropic"),
          baseUrl: endpoint.server.url.origin,
        },
        { messages: [{ role: "user", content: purpose, timestamp: 1 }] },
        { maxRetries: 0 },
      );
      expect(result.stopReason).toBe("stop");
      expect(
        events.find((event) => event.type === "model.request"),
      ).toMatchObject({
        purpose,
        scope: { runId: "auxiliary", conversationId: ROOT_CONVERSATION_ID },
      });
      expect(JSON.stringify(events)).toContain(secretReasoning);
      expect(JSON.stringify(events)).toContain(secretSignature);
      expect(JSON.stringify(events)).not.toContain("[Reasoning withheld]");
    } finally {
      endpoint.server.stop(true);
    }
  },
);
