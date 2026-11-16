import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { OPUS_ROUTE } from "../../../src/route.ts";
import type { ModelCaptureEvent } from "../../../src/pi/capture/types.ts";
import { createRouteModels } from "../../../src/pi/providers/agent-route-provider.ts";
import {
  routeFailureOfSubmission,
  type RouteFailureKind,
} from "../../../src/pi/providers/failure.ts";
import { openEndpoint, sse } from "./fixture.ts";

const VARIABLE = "NEUVE_TEST_ANTHROPIC_STREAM_ERROR_KEY";
const KEY = "synthetic-anthropic-stream-key";
const start = {
  type: "message_start",
  message: {
    id: "msg_partial",
    type: "message",
    role: "assistant",
    model: OPUS_ROUTE.model,
    content: [],
    stop_reason: null,
    usage: { input_tokens: 7, output_tokens: 1 },
  },
};
const partial = [
  start,
  {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "partial original text" },
  },
];
const cases: ReadonlyArray<readonly [string, RouteFailureKind, number]> = [
  ["authentication_error", "auth", 1],
  ["permission_error", "auth", 1],
  ["rate_limit_error", "rate_limit", 2],
  ["overloaded_error", "server", 2],
  ["api_error", "server", 2],
  ["invalid_request_error", "invalid_request", 1],
  ["not_found_error", "invalid_request", 1],
  ["billing_error", "provider", 1],
  ["timeout_error", "server", 2],
  ["unknown_synthetic_error", "stream", 2],
];
for (const [code, kind, attempts] of cases) {
  test(`Anthropic physical SSE ${code} survives the SDK throw and native SQLite makes ${attempts} attempt(s)`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "anthropic-physical-"));
    const endpoint = openEndpoint();
    process.env[VARIABLE] = KEY;
    const captured: ModelCaptureEvent[] = [];
    const terminal = {
      type: "error",
      error: {
        type: code,
        message: "synthetic refusal 503 timeout",
        extra: { original: "retain", echoed: KEY },
      },
    };
    const refuse = () =>
      sse([...partial, terminal], {
        hold: true,
        headers: { "request-id": KEY },
      });
    endpoint.respond(refuse, refuse);
    const models = createRouteModels({
      credentialInspection: "ephemeral" as const,
      route: { ...OPUS_ROUTE, credentialVariable: VARIABLE },
      baseUrl: endpoint.server.url.origin,
      capture: (event) => captured.push(event),
      runId: "anthropic-physical",
      sessionAffinity: "native",
    });
    const harness = await Harness.open(
      await openNodeSqliteStorage(join(directory, "native.sqlite")),
      {
        models,
        registry: createRegistry(),
        settings: { retry: { maxRetries: 1, baseDelayMs: 1 } },
      },
      context,
    );
    try {
      const conversation = await harness.root(context, {
        agent: { model: { provider: "anthropic", modelId: OPUS_ROUTE.model } },
      });
      const result = await (
        await conversation.submit(
          { type: "input", content: "Review." },
          context,
        )
      ).wait(context);
      expect(endpoint.received).toHaveLength(attempts);
      expect(result.status).toBe("unanswered");
      expect(
        await routeFailureOfSubmission(conversation, result, context),
      ).toMatchObject({ kind, status: 200, code, requestId: "[REDACTED]" });
      for (const name of [
        "message_start",
        "content_block_start",
        "content_block_delta",
        "error",
      ])
        expect(
          captured.filter(
            (event) => event.type === "model.event" && event.name === name,
          ),
        ).toHaveLength(attempts);
      expect(
        captured
          .filter(
            (event) => event.type === "model.event" && event.name === "error",
          )
          .map((event) => ("data" in event ? event.data : null)),
      ).toEqual(
        Array.from({ length: attempts }, () => ({
          ...terminal,
          error: {
            ...terminal.error,
            extra: { original: "retain", echoed: "[REDACTED]" },
          },
        })),
      );
      expect(captured.filter((event) => event.type === "model.end")).toEqual(
        Array.from({ length: attempts }, () =>
          expect.objectContaining({
            outcome: "failed",
            usage: {
              input: 7,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 8,
            },
          }),
        ),
      );
      const entries = await conversation.entries({}, 100, undefined, context);
      const messages = entries.items
        .flatMap((entry) => entry.model ?? [])
        .filter((message) => message.role === "assistant");
      expect(messages).toHaveLength(attempts);
      for (const message of messages)
        expect(message.content).toContainEqual(
          expect.objectContaining({
            type: "text",
            text: "partial original text",
          }),
        );
      expect(JSON.stringify(captured)).not.toContain(KEY);
      console.log(
        JSON.stringify({
          proof: "anthropic-physical-sqlite",
          code,
          kind,
          httpStatus: 200,
          requests: endpoint.received.length,
          capturedErrors: captured.filter(
            (event) => event.type === "model.event" && event.name === "error",
          ).length,
          partialTextAndUsageVerified: true,
          capturedCopiesExcludeCredential: true,
        }),
      );
    } finally {
      await harness.close(context);
      endpoint.stop();
      delete process.env[VARIABLE];
      rmSync(directory, { recursive: true, force: true });
    }
  }, 10_000);
}

test("Anthropic success records each physical event once and keeps native output", async () => {
  const endpoint = openEndpoint();
  process.env[VARIABLE] = KEY;
  const captured: ModelCaptureEvent[] = [];
  endpoint.respond(() =>
    sse([
      ...partial,
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 2 },
      },
      { type: "message_stop" },
    ]),
  );
  const models = createRouteModels({
    credentialInspection: "ephemeral" as const,
    route: { ...OPUS_ROUTE, credentialVariable: VARIABLE },
    baseUrl: endpoint.server.url.origin,
    capture: (event) => captured.push(event),
    runId: "anthropic-success",
    sessionAffinity: "native",
  });
  try {
    const message = await models.completeSimple(
      models.getModel("anthropic", OPUS_ROUTE.model)!,
      { messages: [{ role: "user", content: "Review.", timestamp: 1 }] },
    );
    expect(message.stopReason).toBe("stop");
    expect(message.content).toContainEqual(
      expect.objectContaining({ type: "text", text: "partial original text" }),
    );
    expect(
      captured.filter(
        (event) =>
          event.type === "model.event" && event.name === "message_start",
      ),
    ).toHaveLength(1);
    expect(
      captured.filter(
        (event) =>
          event.type === "model.event" && event.name === "message_stop",
      ),
    ).toHaveLength(1);
    expect(captured.filter((event) => event.type === "model.end")).toHaveLength(
      1,
    );
  } finally {
    endpoint.stop();
    delete process.env[VARIABLE];
  }
});
