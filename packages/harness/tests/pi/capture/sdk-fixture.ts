import Anthropic from "@anthropic-ai/sdk";
import type { Model } from "@earendil-works/pi-ai";
import type { OpenAIResponsesOptions } from "@earendil-works/pi-ai/api/openai-responses";
import type { AnthropicOptions } from "@earendil-works/pi-ai/api/anthropic-messages";
import { stream as responses } from "@earendil-works/pi-ai/api/openai-responses";
import { stream as anthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import {
  retainedContext,
  sdkContextSnapshot,
  sdkInvocationTracker,
} from "../../../src/pi/capture/retained-context.ts";
import { SdkInvocation, Json } from "../../../src/pi/capture/types.ts";
import { CallRecord } from "../../../src/pi/capture/dump.ts";
import { expect } from "bun:test";

export const captureSdk = async (call: CallRecord) => {
  const api =
    call.api === "anthropic-messages"
      ? "anthropic-messages"
      : "openai-responses";
  const captured =
    call.sdkContext === undefined
      ? undefined
      : retainedContext(call, { conversations: [], session: [] });
  const model: Model<"openai-responses" | "anthropic-messages"> =
    captured?.model ?? {
      id: call.model,
      name: call.model,
      provider: call.provider,
      api,
      baseUrl: "https://capture.invalid/v1",
      reasoning: true,
      input: ["text"],
      contextWindow: 1_000_000,
      maxTokens: 16,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
  const context = captured?.context ?? normalizeContext({ messages: [] });
  const invocation =
    captured?.invocation ??
    SdkInvocation.parse({
      version: 1,
      api,
      options: { cacheRetention: "short" },
      ...(api === "anthropic-messages" ? { authMode: "non-oauth" } : {}),
    });
  const tracker = sdkInvocationTracker(
    call.callId,
    new AbortController().signal,
  );
  const frames = call.events.filter(
    ({ name }) => name !== "sdk_invocation_end",
  );
  let body: Json | undefined;
  const fetch = Object.assign(
    async (_input: unknown, init?: RequestInit) => {
      if (typeof init?.body !== "string")
        throw new Error("missing actual SDK JSON body");
      body = Json.parse(JSON.parse(init.body));
      return new Response(
        frames
          .map(
            ({ name, data }) =>
              `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`,
          )
          .join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
    { preconnect() {} },
  );
  // JSON snapshots omit undefined properties; reconcile Zod optional fields with the SDK option types.
  const options = {
    env: {},
    maxRetries: 0,
    onProviderStreamEvent: tracker.onProviderStreamEvent,
    ...(captured === undefined
      ? {}
      : {
          onPayload: () =>
            call.body.status === "sent" ? call.body.json : undefined,
        }),
  };
  if (invocation.api === "openai-responses")
    await responses({ ...model, api: "openai-responses" }, context, {
      ...(invocation.options as OpenAIResponsesOptions),
      ...options,
      apiKey: "sk-synthetic-offline",
      fetch,
    }).result();
  else {
    const client = new Anthropic({
      apiKey: "sk-synthetic-offline",
      authToken: null,
      webhookKey: null,
      baseURL: model.baseUrl,
      maxRetries: 0,
      fetch,
      logLevel: "off",
    });
    await anthropic(
      { ...model, api: "anthropic-messages", compat: {} },
      context,
      { ...(invocation.options as AnthropicOptions), ...options, client },
    ).result();
  }
  if (body === undefined)
    throw new Error("SDK did not send the fixture request");
  expect(body).toMatchObject({ stream: true });
  return CallRecord.parse({
    ...call,
    body: { status: "sent", json: body },
    sdkContext: sdkContextSnapshot(call.callId, model, context, invocation),
    events: [
      ...frames,
      { at: 3, name: "sdk_invocation_end", data: tracker.finish() },
    ],
  });
};
