import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  Harness,
  MemoryStorage,
  createRegistry,
  defineExtension,
} from "@earendil-works/pi-durable";
import { SOL_ROUTE } from "../../../src/route.ts";
import type { ModelCaptureEvent } from "../../../src/pi/capture/types.ts";
import { createRouteModels } from "../../../src/pi/providers/agent-route-provider.ts";
import { refusalEvidence } from "../../../src/pi/providers/credential-evidence.ts";
import {
  routeFailureOfSubmission,
  type RouteFailureKind,
} from "../../../src/pi/providers/failure.ts";
import {
  observeResponse,
  readRefusal,
} from "../../../src/pi/providers/response-observer.ts";
import {
  completed,
  created,
  messageItem,
  openEndpoint,
  sse,
  tokenCommand,
  type Responder,
} from "./fixture.ts";

const context = BACKGROUND_CONTEXT;
const token = tokenCommand(
  mkdtempSync(join(tmpdir(), "stream-errors-")),
  "lease",
);

const run = async (responders: Responder[], captureFailure = false) => {
  const endpoint = openEndpoint();
  endpoint.respond(...responders);
  const captured: ModelCaptureEvent[] = [];
  const registry = createRegistry();
  registry.install(defineExtension({ name: "none" }));
  const harness = await Harness.open(
    new MemoryStorage(),
    {
      registry,
      models: createRouteModels({
        credentialInspection: "ephemeral" as const,
        route: SOL_ROUTE,
        auth: { tokenCommand: token.path },
        fetch: endpoint.fetch,
        capture(event) {
          if (
            captureFailure &&
            event.type === "model.event" &&
            event.name === "error"
          )
            throw new Error("lost event: 503 timeout");
          captured.push(event);
        },
        runId: "stream-errors",
        sessionAffinity: "native",
      }),
      settings: { retry: { maxRetries: 2, baseDelayMs: 1 } },
    },
    context,
  );
  try {
    const conversation = await harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: { model: { provider: "openai", modelId: SOL_ROUTE.model } },
      },
      context,
    );
    const result = await (
      await conversation.submit({ type: "input", content: "Review." }, context)
    ).wait(context);
    return {
      result,
      captured,
      sent: endpoint.received.length,
      failure: await routeFailureOfSubmission(conversation, result, context),
    };
  } finally {
    await harness.close(context);
    endpoint.stop();
  }
};

const success = () =>
  sse([
    created("resp_ok"),
    ...messageItem(0, "msg_ok", "final_answer", "Done."),
    completed("resp_ok"),
  ]);
const cases: ReadonlyArray<readonly [string, RouteFailureKind, number]> = [
  ["subscription_sharing_usage_limit_exceeded", "plan_quota", 1],
  ["subscription_sharing_user_not_eligible", "auth", 1],
  ["rate_limit_exceeded", "rate_limit", 2],
];
for (const shape of ["error", "response.failed", "nested-error"] as const) {
  for (const [code, kind, attempts] of cases) {
    test(`${shape} ${code} keeps its native retry policy and original provider event`, async () => {
      const error = { code, message: "Provider detail with 503 timeout words" };
      const event =
        shape === "response.failed"
          ? {
              type: shape,
              response: { id: "resp_error", status: "failed", error },
            }
          : shape === "nested-error"
            ? { error }
            : { type: "error", ...error, param: null, sequence_number: 2 };
      const refusal = () =>
        shape === "nested-error"
          ? new Response(`data: ${JSON.stringify(event)}\n\n`, {
              headers: { "content-type": "text/event-stream" },
            })
          : sse([created("resp_error"), event]);
      const opened = await run([refusal, success]);
      expect(opened.sent).toBe(attempts);
      expect(opened.result.status).toBe(attempts === 1 ? "unanswered" : "done");
      if (attempts === 1) expect(opened.failure).toMatchObject({ kind, code });
      expect(
        opened.captured.filter(
          (item) =>
            item.type === "model.event" &&
            item.name === (shape === "nested-error" ? "message" : shape),
        ),
      ).toHaveLength(1);
      expect(opened.captured).toContainEqual(
        expect.objectContaining({ type: "model.event", data: event }),
      );
    });
  }
}

test("an intercepted SDK error whose capture fails is terminal, even when its detail sounds transient", async () => {
  const opened = await run(
    [
      () =>
        sse([
          created("resp_capture"),
          { type: "error", code: "rate_limit_exceeded", message: "retry" },
        ]),
      success,
    ],
    true,
  );
  expect(opened.sent).toBe(1);
  expect(opened.failure).toMatchObject({ kind: "capture" });
});

test("HTTP refusals retain the entire original body without captured credential or header values", async () => {
  const text = ` { "error": { "code": "invalid_token", "message": "${"long detail ".repeat(1000)}" }, "extra": [1, true] } `;
  const opened = await run([
    () =>
      new Response(text, {
        status: 401,
        headers: {
          "x-request-id": "req_body",
          "x-private": "private-response-header",
        },
      }),
  ]);
  expect(opened.sent).toBe(1);
  expect(opened.captured).toContainEqual(
    expect.objectContaining({
      name: "http_error",
      data: {
        status: 401,
        code: "invalid_token",
        retryAfter: null,
        bodyRedactions: [],
        body: text,
      },
    }),
  );
  const evidence = JSON.stringify(opened.captured);
  expect(evidence).not.toContain("private-response-header");
  expect(evidence).not.toContain("tok-1");
});

test("the observation boundary preserves CRLF, multibyte chunks and bytes while forwarding cancellation", async () => {
  const text =
    ': keepalive\r\nevent: error\r\ndata: {"type":"error",\r\ndata: "message":"ação 🥔"}\r\n\r\n';
  const bytes = new TextEncoder().encode(text);
  const events: unknown[] = [];
  const response = observeResponse(
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
          controller.close();
        },
      }),
      { status: 200, headers: { "x-request-id": "same" } },
    ),
    (name, data) => events.push({ name, data }),
    (cause) => new Error(String(cause)),
  );
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  expect(response.headers.get("x-request-id")).toBe("same");
  expect(events).toEqual([
    { name: "error", data: { type: "error", message: "ação 🥔" } },
  ]);
  let cancelSource: ((reason: unknown) => void) | undefined;
  const cancellation = new Promise<unknown>((resolve) => {
    cancelSource = resolve;
  });
  const held = observeResponse(
    new Response(
      new ReadableStream<Uint8Array>({
        cancel(reason) {
          cancelSource?.(reason);
        },
      }),
    ),
    () => undefined,
    (cause) => new Error(String(cause)),
  );
  await held.body?.cancel("owner stopped");
  expect(await cancellation).toBe("owner stopped");
});

test("an HTTP refusal that echoes active credentials records explicit redaction", async () => {
  const opened = await run([
    (request) =>
      new Response(
        JSON.stringify({
          error: {
            code: "invalid_token",
            message: `Rejected ${request.headers.get("authorization")}`,
          },
        }),
        { status: 401 },
      ),
  ]);
  const evidence = opened.captured.find(
    (event) => event.type === "model.event" && event.name === "http_error",
  );
  expect(evidence).toMatchObject({
    data: { bodyRedactions: ["authorization"] },
  });
  expect(JSON.stringify(evidence)).toContain("[REDACTED]");
  expect(JSON.stringify(opened)).not.toContain("tok-");
});

test("cancellation while the original HTTP refusal is being read remains aborted", async () => {
  const endpoint = openEndpoint();
  const controller = new AbortController();
  const captured: ModelCaptureEvent[] = [];
  endpoint.respond(
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(stream) {
            stream.enqueue(new TextEncoder().encode('{"error":'));
          },
        }),
        { status: 401 },
      ),
  );
  const models = createRouteModels({
    credentialInspection: "ephemeral" as const,
    route: SOL_ROUTE,
    auth: { tokenCommand: token.path },
    fetch: endpoint.fetch,
    runId: "body-abort",
    sessionAffinity: "body-abort",
    capture(event) {
      captured.push(event);
      if (event.type === "model.response") controller.abort();
    },
  });
  try {
    const message = await models.complete(
      models.getModel("openai", SOL_ROUTE.model)!,
      {
        messages: [{ role: "user", content: "Review.", timestamp: Date.now() }],
      },
      { signal: controller.signal },
    );
    expect(message.stopReason).toBe("aborted");
    expect(captured.at(-1)).toMatchObject({
      type: "model.end",
      outcome: "aborted",
      error: { type: "aborted" },
    });
    expect(endpoint.received).toHaveLength(1);
  } finally {
    endpoint.stop();
  }
});

test("a non-JSON HTTP refusal retains its original text as evidence", async () => {
  const body = "upstream unavailable\r\nwith original whitespace  ";
  const opened = await run(
    Array.from({ length: 3 }, () => () => new Response(body, { status: 503 })),
  );
  expect(opened.sent).toBe(3);
  expect(opened.failure).toMatchObject({ kind: "server", status: 503 });
  const bodies = opened.captured.flatMap((event) =>
    event.type === "model.event" && event.name === "http_error"
      ? [event.data]
      : [],
  );
  expect(bodies).toEqual(
    Array.from({ length: 3 }, () => ({
      status: 503,
      code: null,
      retryAfter: null,
      body,
      bodyRedactions: [],
    })),
  );
});

for (const shape of ["error", "response.failed", "nested-error"] as const) {
  test(`${shape} credential echoes are redacted in native capture and failure diagnostics`, async () => {
    let active = "";
    const refuse: Responder = (request) => {
      active = request.headers.get("authorization")!;
      const error = {
        code: "invalid_token",
        message: `Rejected ${active}`,
        nested: JSON.stringify({ authorization: active, harmless: "keep me" }),
      };
      const event =
        shape === "response.failed"
          ? { type: shape, response: { id: "resp_echo", error } }
          : shape === "nested-error"
            ? { error }
            : { type: "error", ...error };
      return shape === "nested-error"
        ? new Response(`data: ${JSON.stringify(event)}\n\n`, {
            headers: { "content-type": "text/event-stream" },
          })
        : sse([created("resp_echo"), event]);
    };
    const opened = await run([refuse, refuse, refuse]);
    expect(active).toMatch(/^Bearer tok-\d+$/);
    expect(opened.sent).toBe(3);
    expect(opened.result.status).toBe("unanswered");
    expect(opened.failure).toMatchObject({
      kind: "stream",
      code: "invalid_token",
      detail: expect.stringContaining("Rejected [REDACTED]"),
    });
    expect(JSON.stringify(opened)).not.toContain(active.replace("Bearer ", ""));
    expect(opened.captured).toContainEqual(
      expect.objectContaining({
        type: "model.event",
        name: "credential_redactions",
        data: {
          name: shape === "nested-error" ? "message" : shape,
          bodyRedactions: ["authorization"],
        },
      }),
    );
    expect(JSON.stringify(opened.captured)).toContain("keep me");
    expect(opened.captured).toContainEqual(
      expect.objectContaining({
        type: "model.end",
        error: expect.objectContaining({
          message: expect.stringContaining("Rejected [REDACTED]"),
        }),
      }),
    );
  });
}

test("the native SDK receives credential echo bytes unchanged while capture keeps a redacted copy", async () => {
  const endpoint = openEndpoint();
  const captured: ModelCaptureEvent[] = [];
  let active = "";
  endpoint.respond((request) => {
    active = request.headers.get("authorization")!;
    return sse([
      created("resp_original"),
      ...messageItem(0, "msg_original", "final_answer", `original ${active}`),
      completed("resp_original"),
    ]);
  });
  const models = createRouteModels({
    credentialInspection: "ephemeral" as const,
    route: SOL_ROUTE,
    auth: { tokenCommand: token.path },
    fetch: endpoint.fetch,
    runId: "original-bytes",
    sessionAffinity: "original-bytes",
    capture: (event) => captured.push(event),
  });
  try {
    const message = await models.complete(
      models.getModel("openai", SOL_ROUTE.model)!,
      {
        messages: [{ role: "user", content: "Original input.", timestamp: 1 }],
      },
    );
    expect(message.stopReason).toBe("stop");
    expect(message.content).toContainEqual(
      expect.objectContaining({
        type: "text",
        text: `original ${active}`,
      }),
    );
    expect(endpoint.received[0]!.body["input"]).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Original input." }],
      },
    ]);
    expect(JSON.stringify(captured)).not.toContain(
      active.replace("Bearer ", ""),
    );
    expect(JSON.stringify(captured)).toContain("original [REDACTED]");
  } finally {
    endpoint.stop();
  }
});

test("the refusal reader forwards original bytes while its evidence redacts escaped credential strings", async () => {
  const key = 'synthetic-"quoted"-key';
  const text = ` \r\n${JSON.stringify({ error: { message: `Rejected ${key}` } })}  \r\n`;
  const bytes = new TextEncoder().encode(text);
  const observed = await readRefusal(
    new Response(bytes, { status: 401 }),
    (cause) => new Error(String(cause)),
  );
  const evidence = refusalEvidence(
    observed.text,
    new Headers({ "x-api-key": key }),
  );
  expect(evidence).toEqual({
    body: ' \r\n{"error":{"message":"Rejected [REDACTED]"}}  \r\n',
    bodyRedactions: ["x-api-key"],
  });
  expect(new Uint8Array(await observed.response.arrayBuffer())).toEqual(bytes);
});

test("a credential crossing the diagnostic summary boundary is redacted before shortening", async () => {
  const refuse: Responder = (request) =>
    sse([
      created("resp_summary"),
      {
        type: "error",
        code: "invalid_token",
        message: `${"x".repeat(295)}${request.headers.get("authorization")!.replace("Bearer ", "")}`,
      },
    ]);
  const opened = await run([refuse, refuse, refuse]);
  expect(opened.sent).toBe(3);
  expect(opened.failure).toMatchObject({
    kind: "stream",
    detail: expect.stringContaining(`${"x".repeat(295)}[REDA`),
  });
  expect(JSON.stringify(opened)).not.toContain("tok-");
});

test("credential exclusion precedes safety-buffering header shortening", async () => {
  const opened = await run([
    (request) =>
      sse(
        [
          created("resp_buffering"),
          ...messageItem(0, "msg_buffering", "final_answer", "Done."),
          completed("resp_buffering"),
        ],
        {
          headers: {
            "x-codex-safety-buffering-reason": `${"x".repeat(198)}${request.headers.get("authorization")!.replace("Bearer ", "")}`,
          },
        },
      ),
  ]);
  expect(opened.captured).toContainEqual(
    expect.objectContaining({
      type: "model.event",
      name: "safety_buffering",
      data: { "x-codex-safety-buffering-reason": `${"x".repeat(198)}[R` },
    }),
  );
  expect(opened.captured).toContainEqual(
    expect.objectContaining({
      type: "model.event",
      name: "credential_redactions",
      data: { name: "safety_buffering", bodyRedactions: ["authorization"] },
    }),
  );
});

test("aborting physical observation cancels a held source after its error event", async () => {
  const controller = new AbortController();
  let cancelled = false;
  const response = observeResponse(
    new Response(
      new ReadableStream<Uint8Array>({
        start(stream) {
          stream.enqueue(
            new TextEncoder().encode(
              'event: error\ndata: {"type":"error"}\n\n',
            ),
          );
        },
        cancel() {
          cancelled = true;
        },
      }),
    ),
    () => undefined,
    (cause) => new Error(String(cause)),
    controller.signal,
  );
  const reader = response.body!.getReader();
  expect((await reader.read()).done).toBe(false);
  controller.abort();
  await reader.read().catch(() => undefined);
  reader.releaseLock();
  expect(cancelled).toBe(true);
});
