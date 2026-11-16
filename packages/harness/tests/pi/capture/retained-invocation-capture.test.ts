import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRouteModels } from "../../../src/pi/providers/agent-route-provider.ts";
import { sdkInvocationTracker } from "../../../src/pi/capture/retained-context.ts";
import {
  SdkInvocationEnd,
  type ModelCaptureEvent,
} from "../../../src/pi/capture/types.ts";
import { SOL_ROUTE, OPUS_ROUTE } from "../../../src/route.ts";
import { ClaudeSubscriptionTokenRefused } from "../../../src/subscription-token.ts";
import { tokenCommand, sse } from "../providers/fixture.ts";

test("abort capture records observed callback count and safe reason without inventing a replay boundary", () => {
  const controller = new AbortController();
  const tracker = sdkInvocationTracker("abort-fixture", controller.signal);
  tracker.onProviderStreamEvent();
  controller.abort(new Error("fixture abort reason"));
  tracker.onProviderStreamEvent();
  const result = tracker.finish();
  expect(result).toEqual({
    version: 1,
    callId: "abort-fixture",
    callbacks: 2,
    abort: {
      status: "aborted",
      afterCallbacks: 1,
      boundary: "unresolved",
      reason: { kind: "error", name: "Error", message: "fixture abort reason" },
    },
  });
  expect(Object.isFrozen(result.abort)).toBe(true);
  const ordinary = new AbortController();
  const complete = sdkInvocationTracker(
    "complete-fixture",
    ordinary.signal,
  ).finish();
  ordinary.abort("later cleanup");
  expect(complete.abort).toEqual({ status: "not-aborted" });
});

for (const route of [
  SOL_ROUTE,
  { ...OPUS_ROUTE, credentialVariable: "NEUVE_INVOCATION_FIXTURE_KEY" },
])
  test(`${route.provider} captures options actually passed to public SDK and terminal callback provenance`, async () => {
    const root = mkdtempSync(join(tmpdir(), "invocation-capture-"));
    const captured: ModelCaptureEvent[] = [];
    const syntheticKey = "synthetic-invocation-key";
    const frames =
      route.provider === "openai"
        ? [
            {
              type: "response.created",
              response: { id: "r", status: "in_progress" },
            },
            {
              type: "response.output_item.added",
              output_index: 0,
              item: { type: "message", id: "m", content: [] },
            },
            {
              type: "response.output_text.delta",
              output_index: 0,
              delta: "safe fixture",
            },
            {
              type: "response.completed",
              response: { id: "r", status: "completed", output: [] },
            },
          ]
        : [
            {
              type: "message_start",
              message: {
                id: "r",
                model: route.model,
                usage: { input_tokens: 0, output_tokens: 0 },
              },
            },
            {
              type: "content_block_start",
              index: 0,
              content_block: { type: "text", text: "safe fixture" },
            },
            { type: "content_block_stop", index: 0 },
            {
              type: "message_delta",
              delta: { stop_reason: "end_turn" },
              usage: { output_tokens: 0 },
            },
            { type: "message_stop" },
          ];
    try {
      if (route.provider === "anthropic")
        process.env[route.credentialVariable] = syntheticKey;
      const models = createRouteModels({
        route,
        runId: "invocation-fixture",
        sessionAffinity: "fixture",
        credentialInspection: "ephemeral",
        capture: (event) => captured.push(event),
        ...(route.provider === "openai"
          ? {
              auth: {
                tokenCommand: tokenCommand(root, "synthetic-lease").path,
              },
            }
          : {}),
        fetch: Object.assign(async () => sse(frames), { preconnect() {} }),
      });
      const model = models.getModel(route.provider, route.model);
      if (model === undefined) throw Error("fixture model missing");
      const result = await models.complete(
        model,
        {
          messages: [{ role: "user", content: "fixture input", timestamp: 1 }],
        },
        { apiKey: syntheticKey },
      );
      expect(result.errorMessage).toBeUndefined();
      expect(result.stopReason).toBe("stop");
      const request = captured.find((event) => event.type === "model.request");
      if (request?.type !== "model.request")
        throw Error("fixture request missing");
      expect(request.sdkContext?.invocation).toEqual(
        route.provider === "openai"
          ? {
              version: 1,
              api: "openai-responses",
              options: { cacheRetention: "none" },
            }
          : {
              version: 1,
              api: "anthropic-messages",
              authMode: "non-oauth",
              options: {
                maxTokens: route.maxOutputTokens,
                cacheRetention: "long",
              },
            },
      );
      expect(JSON.stringify(request.sdkContext)).not.toContain(
        "synthetic-invocation-key",
      );
      const end = captured.find(
        (event) =>
          event.type === "model.event" && event.name === "sdk_invocation_end",
      );
      if (end?.type !== "model.event")
        throw Error("fixture invocation end missing");
      expect(SdkInvocationEnd.parse(end.data)).toEqual({
        version: 1,
        callId: request.callId,
        callbacks: frames.length,
        abort: { status: "not-aborted" },
      });
      expect(captured.indexOf(end)).toBeLessThan(
        captured.findIndex((event) => event.type === "model.end"),
      );
    } finally {
      if (route.provider === "anthropic")
        delete process.env[route.credentialVariable];
      rmSync(root, { recursive: true, force: true });
    }
  });

test("capture never sees a Claude subscription token request", () => {
  const variable = "NEUVE_INVOCATION_OAUTH_FIXTURE_KEY";
  const previous = process.env[variable];
  const syntheticKey = "sk-ant-oat-synthetic-invocation-key";
  const captured: ModelCaptureEvent[] = [];
  const fetch = mock(async () => sse([]));
  try {
    process.env[variable] = syntheticKey;
    let refusal: unknown;
    try {
      createRouteModels({
        route: { ...OPUS_ROUTE, credentialVariable: variable },
        runId: "invocation-refusal-fixture",
        sessionAffinity: "fixture",
        credentialInspection: "ephemeral",
        capture: (event) => captured.push(event),
        fetch: Object.assign(fetch, { preconnect() {} }),
      });
    } catch (cause) {
      refusal = cause;
    }
    expect(refusal).toBeInstanceOf(ClaudeSubscriptionTokenRefused);
    if (!(refusal instanceof ClaudeSubscriptionTokenRefused))
      throw Error("fixture subscription refusal missing");
    expect(refusal._tag).toBe("ClaudeSubscriptionTokenRefused");
    expect(refusal.message).toContain(variable);
    expect(refusal.message).not.toContain(syntheticKey);
    expect(fetch).toHaveBeenCalledTimes(0);
    expect(
      captured.filter((event) => event.type === "model.request"),
    ).toHaveLength(0);
  } finally {
    if (previous === undefined) delete process.env[variable];
    else process.env[variable] = previous;
  }
});

test("actual signal abort provenance uses the credential masking pipeline", async () => {
  const controller = new AbortController();
  const captured: ModelCaptureEvent[] = [];
  const variable = "NEUVE_INVOCATION_ABORT_FIXTURE_KEY";
  process.env[variable] = "synthetic-abort-fixture-key";
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const route = { ...OPUS_ROUTE, credentialVariable: variable };
    const models = createRouteModels({
      route,
      runId: "invocation-abort-fixture",
      sessionAffinity: "fixture",
      credentialInspection: "ephemeral",
      capture: (event) => captured.push(event),
      fetch: Object.assign(
        async () => {
          timer = setTimeout(
            () => controller.abort(new Error("synthetic-abort-fixture-key")),
            50,
          );
          return sse(
            [
              {
                type: "message_start",
                message: {
                  id: "r",
                  model: route.model,
                  usage: { input_tokens: 0, output_tokens: 0 },
                },
              },
            ],
            { hold: true },
          );
        },
        { preconnect() {} },
      ),
    });
    const model = models.getModel(route.provider, route.model);
    if (model === undefined) throw Error("fixture model missing");
    await models.complete(
      model,
      { messages: [{ role: "user", content: "fixture", timestamp: 1 }] },
      { signal: controller.signal },
    );
    const event = captured.find(
      (value) =>
        value.type === "model.event" && value.name === "sdk_invocation_end",
    );
    if (event?.type !== "model.event") throw Error("abort provenance missing");
    const end = SdkInvocationEnd.parse(event.data);
    expect(end.callbacks).toBe(1);
    expect(end.abort).toMatchObject({
      status: "aborted",
      afterCallbacks: 1,
      boundary: "unresolved",
      reason: { kind: "error", name: "Error" },
    });
    expect(JSON.stringify(captured)).not.toContain(
      "synthetic-abort-fixture-key",
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    delete process.env[variable];
  }
});

test("omitted explicit Anthropic key with owned headers takes the pinned non-OAuth branch", async () => {
  const captured: ModelCaptureEvent[] = [];
  const models = createRouteModels({
    route: { ...OPUS_ROUTE, credentialVariable: "NEUVE_UNUSED_HEADER_CONTROL" },
    runId: "header-owned-control",
    sessionAffinity: "fixture",
    credentialInspection: "ephemeral",
    capture: (event) => captured.push(event),
    fetch: Object.assign(
      async () =>
        sse([
          {
            type: "message_start",
            message: {
              id: "r",
              model: OPUS_ROUTE.model,
              usage: { input_tokens: 0, output_tokens: 0 },
            },
          },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 0 },
          },
          { type: "message_stop" },
        ]),
      { preconnect() {} },
    ),
  });
  const provider = models.getProvider("anthropic");
  const model = models.getModel("anthropic", OPUS_ROUTE.model);
  if (provider === undefined || model === undefined)
    throw Error("fixture provider missing");
  const output = await provider
    .stream(
      model,
      normalizeContext({
        messages: [{ role: "user", content: "fixture", timestamp: 1 }],
      }),
      { headers: { "x-api-key": "synthetic-header-owned-key" } },
    )
    .result();
  expect(output.stopReason).toBe("stop");
  const request = captured.find((event) => event.type === "model.request");
  if (request?.type !== "model.request") throw Error("fixture request missing");
  expect(request.sdkContext?.invocation).toEqual({
    version: 1,
    api: "anthropic-messages",
    authMode: "non-oauth",
    options: { cacheRetention: "long", maxTokens: OPUS_ROUTE.maxOutputTokens },
  });
  expect(request.headerNames).toContain("x-api-key");
  expect(JSON.stringify(captured)).not.toContain("synthetic-header-owned-key");
});
