import type { SdkInvocation } from "../../../src/pi/capture/types.ts";
import { expect, test } from "bun:test";
import type { Model } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import type { CallRecord } from "../../../src/pi/capture/dump.ts";
import {
  retainedContext,
  sdkContextSnapshot,
} from "../../../src/pi/capture/retained-context.ts";

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
const native = { conversations: [], session: [] };
const fixture = (
  api: "openai-responses" | "anthropic-messages",
  logicalRoute?: string,
): Omit<CallRecord, "role"> => {
  const provider = api === "openai-responses" ? "openai" : "anthropic";
  const model: Model<typeof api> = {
    id: "identity-model",
    name: "identity-model",
    provider: logicalRoute ?? provider,
    api,
    baseUrl: "https://capture.invalid/v1",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 1000,
    maxTokens: 20,
    cost: { input: 2, output: 3, cacheRead: 1, cacheWrite: 4 },
    compat: { supportsMidConvoSystemMessages: true },
  };
  return {
    callId: "identity-call",
    scope: { runId: "identity-run", conversationId: 13 },
    route: "identity-route",
    ...(logicalRoute === undefined ? {} : { logicalRoute }),
    provider,
    model: model.id,
    api,
    headerNames: [],
    credentialCoverage: "none",
    body: { status: "sent", json: { model: model.id, input: [] } },
    sdkContext: sdkContextSnapshot(
      "identity-call",
      model,
      normalizeContext({
        messages: [{ role: "user", content: "preserved input", timestamp: 1 }],
      }),
      capturedInvocation(api),
    ),
    requestedAt: 1,
    response: null,
    events: [],
    end: null,
  };
};

// Logical SDK providers and physical destinations are different identity domains.
test.each(["openai-responses", "anthropic-messages"] as const)(
  "%s retains exact SDK metadata for logical and direct providers",
  (api) => {
    for (const logicalRoute of [undefined, "neuve-route:identity-run:13"]) {
      const call = fixture(api, logicalRoute);
      const original = structuredClone(call);
      const replay = retainedContext(call, native);
      expect(replay.model).toMatchObject({
        id: "identity-model",
        provider: logicalRoute ?? call.provider,
        api,
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 2, output: 3, cacheRead: 1, cacheWrite: 4 },
        compat: { supportsMidConvoSystemMessages: true },
      });
      expect(replay.context.messages).toEqual([
        { role: "user", content: "preserved input", timestamp: 1 },
      ]);
      expect(call).toEqual(original);
    }
  },
);

// Contradictory captured identity must still refuse replay at the boundary.
test.each(["openai-responses", "anthropic-messages"] as const)(
  "%s refuses logical-route, call, model and physical API contradictions",
  (api) => {
    const call = fixture(api, "neuve-route:identity-run:13");
    const wrongApi =
      api === "openai-responses" ? "anthropic-messages" : "openai-responses";
    for (const changed of [
      { ...call, logicalRoute: "neuve-route:other-run:13" },
      { ...call, callId: "another-call" },
      { ...call, model: "another-model" },
      { ...call, api: wrongApi },
      {
        ...call,
        provider: api === "openai-responses" ? "anthropic" : "openai",
      },
      { ...call, api: "unsupported-protocol" },
      { ...call, logicalRoute: call.provider },
    ])
      expect(() => retainedContext(changed, native)).toThrow(
        "SDK context belongs to another call",
      );
    const direct = fixture(api);
    expect(() =>
      retainedContext({ ...direct, provider: "wrong-provider" }, native),
    ).toThrow("SDK context belongs to another call");
    if (api === "openai-responses")
      expect(() =>
        retainedContext(
          { ...call, events: [{ at: 1, name: "message_start", data: {} }] },
          native,
        ),
      ).toThrow("SDK context belongs to another call");
  },
);
