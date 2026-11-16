import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { OPUS_ROUTE, SOL_ROUTE } from "../../../src/route.ts";
import type { CaptureEvent } from "../../../src/pi/capture/types.ts";
import {
  PreflightFailed,
  createCountTokens,
} from "../../../src/pi/providers/count-tokens.ts";
import { openEndpoint } from "./fixture.ts";

const endpoint = openEndpoint();
afterAll(() => endpoint.stop());

const VARIABLE = "NEUVE_TEST_COUNT_TOKENS_KEY";
const KEY = "sk-ant-synthetic-count-tokens";
const ROUTE = { ...OPUS_ROUTE, credentialVariable: VARIABLE };
afterEach(() => {
  delete process.env[VARIABLE];
});

const REQUEST = {
  label: "investigate-1.initial-context",
  system: "You review.",
  user: "Review the range.",
  tools: [
    {
      name: "submit",
      description: "Submit.",
      input_schema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  ],
};

const UUID =
  "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

const counter = (
  captured: Array<CaptureEvent>,
  capture: (event: CaptureEvent) => void = (event) => captured.push(event),
) =>
  createCountTokens({
    credentialInspection: "ephemeral" as const,
    route: ROUTE,
    capture,
    runId: "run-count",
    baseUrl: endpoint.server.url.origin,
  });

const artifacts = (captured: ReadonlyArray<CaptureEvent>) =>
  captured
    .filter((event) => event.type === "artifact")
    .map((event) =>
      event.type === "artifact"
        ? {
            name: event.name.replace(new RegExp(UUID), "<call>"),
            scope: event.scope,
            mediaType: event.mediaType,
            json: JSON.parse(new TextDecoder().decode(event.bytes)) as unknown,
          }
        : event.type,
    );

const refusal =
  (status: number, type: string, message: string) => (): Response =>
    Response.json(
      { type: "error", error: { type, message } },
      { status, headers: { "request-id": `req_${status}` } },
    );

describe("the Anthropic route's free count", () => {
  test("sends the incumbent payload to count_tokens with the route's key alone, and keeps the call as artifacts, not model events", async () => {
    process.env[VARIABLE] = KEY;
    const captured: Array<CaptureEvent> = [];
    endpoint.respond(() =>
      Response.json(
        { input_tokens: 1234 },
        { headers: { "request-id": "req_count" } },
      ),
    );
    const sent = endpoint.received.length;

    expect(await counter(captured)(REQUEST)).toBe(1234);

    const received = endpoint.received[sent]!;
    expect(received.path).toBe("/v1/messages/count_tokens");
    expect(received.headers.get("x-api-key")).toBe(KEY);
    expect(received.headers.get("traceparent")).toBeNull();
    expect(received.body).toEqual({
      model: "claude-opus-5-5",
      system: "You review.",
      messages: [{ role: "user", content: "Review the range." }],
      tools: REQUEST.tools,
    });
    const kept = artifacts(captured);
    expect(kept.map((artifact) => (artifact as { name: string }).name)).toEqual(
      [
        "count-tokens/<call>/call.json",
        "count-tokens/<call>/request.json",
        "count-tokens/<call>/outcome.json",
      ],
    );
    expect(kept[0]).toMatchObject({
      scope: { runId: "run-count" },
      mediaType: "application/json",
      json: {
        label: "investigate-1.initial-context",
        route: "anthropic",
        provider: "anthropic",
        model: "claude-opus-5-5",
        path: "/v1/messages/count_tokens",
        headerNames: expect.arrayContaining(["x-api-key", "anthropic-version"]),
      },
    });
    expect(kept[1]).toMatchObject({ json: received.body });
    expect(kept[2]).toMatchObject({
      json: {
        status: 200,
        requestId: "req_count",
        body: { input_tokens: 1234 },
      },
    });
    expect(captured.some((event) => event.type.startsWith("model."))).toBe(
      false,
    );
    const names = new Set(
      captured
        .filter((event) => event.type === "artifact")
        .map((event) =>
          event.type === "artifact" ? event.name.split("/")[1] : "",
        ),
    );
    expect(names.size).toBe(1);
    expect(JSON.stringify(artifacts(captured)).includes(KEY)).toBe(false);
  });

  test("leaves tools out when there are none, and mints a fresh call ID per count", async () => {
    process.env[VARIABLE] = KEY;
    const captured: Array<CaptureEvent> = [];
    endpoint.respond(
      () => Response.json({ input_tokens: 7 }),
      () => Response.json({ input_tokens: 9 }),
    );
    const sent = endpoint.received.length;
    const count = counter(captured);

    expect(
      await count({ label: "range.diff", system: "", user: "diff", tools: [] }),
    ).toBe(7);
    expect(
      await count({ label: "range.diff", system: "", user: "diff", tools: [] }),
    ).toBe(9);

    expect(endpoint.received[sent]!.body).toEqual({
      model: "claude-opus-5-5",
      system: "",
      messages: [{ role: "user", content: "diff" }],
    });
    const calls = new Set(
      captured
        .filter((event) => event.type === "artifact")
        .map((event) =>
          event.type === "artifact" ? event.name.split("/")[1] : "",
        ),
    );
    expect(calls.size).toBe(2);
  });

  test("a refused credential is not retryable; a rate limit or a server error is", async () => {
    process.env[VARIABLE] = KEY;
    endpoint.respond(
      refusal(401, "authentication_error", "invalid x-api-key"),
      refusal(403, "permission_error", "not allowed"),
      refusal(429, "rate_limit_error", "slow down"),
      refusal(500, "api_error", "internal"),
    );
    const count = counter([]);
    const failures = [];
    for (let attempt = 0; attempt < 4; attempt++)
      failures.push(
        await count(REQUEST).then(
          () => undefined,
          (error: unknown) => error,
        ),
      );

    for (const failure of failures)
      expect(failure).toBeInstanceOf(PreflightFailed);
    expect(
      failures.map((failure) => {
        const { message, retryable, status } = failure as PreflightFailed;
        return { message, retryable, status };
      }),
    ).toEqual([
      {
        message:
          "token counting (investigate-1.initial-context) failed: HTTP 401 authentication_error: invalid x-api-key",
        retryable: false,
        status: 401,
      },
      {
        message:
          "token counting (investigate-1.initial-context) failed: HTTP 403 permission_error: not allowed",
        retryable: false,
        status: 403,
      },
      {
        message:
          "token counting (investigate-1.initial-context) failed: HTTP 429 rate_limit_error: slow down",
        retryable: true,
        status: 429,
      },
      {
        message:
          "token counting (investigate-1.initial-context) failed: HTTP 500 api_error: internal",
        retryable: true,
        status: 500,
      },
    ]);
  });

  test("a missing key or a request that cannot be recorded sends nothing", async () => {
    const sent = endpoint.received.length;
    const missing = await counter([])(REQUEST).catch((error: unknown) => error);
    expect(missing).toMatchObject({
      _tag: "PreflightFailed",
      message: `token counting (investigate-1.initial-context) failed: ${VARIABLE} is not set in this process's environment`,
      retryable: false,
    });

    process.env[VARIABLE] = KEY;
    const unrecorded = await counter([], () => {
      throw new Error("journal write failed");
    })(REQUEST).catch((error: unknown) => error);
    expect(unrecorded).toMatchObject({
      _tag: "PreflightFailed",
      message:
        "token counting (investigate-1.initial-context) failed: capture failed: journal write failed",
      retryable: false,
    });
    expect(endpoint.received.length).toBe(sent);
  });

  test("the caller's signal cancels a count in flight, and an aborted signal sends nothing", async () => {
    process.env[VARIABLE] = KEY;
    let release!: () => void;
    let entered = false;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let finished!: () => void;
    const joined = new Promise<void>((resolve) => {
      finished = resolve;
    });
    endpoint.respond(async () => {
      entered = true;
      await held;
      finished();
      return Response.json({ input_tokens: 1 });
    });
    const controller = new AbortController();
    const reason = new Error("run cut off");
    const startedAt = performance.now();
    const counting = counter([])(REQUEST, controller.signal).catch(
      (error: unknown) => error,
    );
    const until = Date.now() + 2000;
    while (!entered && Date.now() < until) await Bun.sleep(1);
    expect(entered).toBe(true);
    controller.abort(reason);
    const cancelled = await counting;
    release();
    await joined;
    expect(cancelled).toBe(reason);
    expect(performance.now() - startedAt).toBeLessThan(1_500);

    const sent = endpoint.received.length;
    const before = await counter([])(REQUEST, controller.signal).catch(
      (error: unknown) => error,
    );
    expect(before).toBe(reason);
    expect(endpoint.received.length).toBe(sent);
  });
});

test("the OpenAI route counts nothing, and reads, sends and records nothing", async () => {
  const touched: Array<string> = [];
  const count = createCountTokens({
    credentialInspection: "ephemeral" as const,
    route: SOL_ROUTE,
    capture: () => touched.push("capture"),
    runId: "run-count",
    fetch: (() => {
      touched.push("fetch");
      return Promise.reject(new Error("no request"));
    }) as unknown as typeof globalThis.fetch,
  });

  expect(await count(REQUEST)).toBeNull();
  expect(touched).toEqual([]);
});

for (const json of [true, false]) {
  test(`count refusal preserves complete ${json ? "JSON" : "non-JSON"} evidence and redacts the active key`, async () => {
    process.env[VARIABLE] = KEY;
    const captured: CaptureEvent[] = [];
    const detail = `Rejected ${KEY} ${"detail ".repeat(400)}TAIL_PROVIDER_DIAGNOSTIC`;
    const raw = json
      ? ` \r\n${JSON.stringify({ error: { type: "authentication_error", message: detail }, nested: JSON.stringify({ key: KEY, harmless: "keep me" }) })}  \r\n`
      : ` \r\n${detail}  \r\n`;
    endpoint.respond((request) => {
      expect(request.headers.get("x-api-key")).toBe(KEY);
      return new Response(raw, { status: 401 });
    });
    const failure = await counter(captured)(REQUEST).catch(
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({
      _tag: "PreflightFailed",
      status: 401,
      retryable: false,
      message: json
        ? expect.stringContaining("Rejected [REDACTED]")
        : expect.stringContaining("HTTP 401"),
    });
    const kept = artifacts(captured);
    expect(kept[2]).toMatchObject({
      json: {
        text: raw.replaceAll(KEY, "[REDACTED]"),
        bodyRedactions: ["x-api-key"],
        body: json
          ? {
              error: {
                message: expect.stringContaining("TAIL_PROVIDER_DIAGNOSTIC"),
              },
              nested: JSON.stringify({
                key: "[REDACTED]",
                harmless: "keep me",
              }),
            }
          : { unparsed: raw.replaceAll(KEY, "[REDACTED]") },
      },
    });
    expect(JSON.stringify(kept)).not.toContain(KEY);
    expect(JSON.stringify(failure)).not.toContain(KEY);
    expect(kept[1]).toMatchObject({
      json: {
        system: REQUEST.system,
        messages: [{ role: "user", content: REQUEST.user }],
      },
    });
  });
}

test("a count response over the capture object limit fails explicitly and cancels its body", async () => {
  process.env[VARIABLE] = KEY;
  const captured: CaptureEvent[] = [];
  let cancelled = false;
  const count = createCountTokens({
    credentialInspection: "ephemeral" as const,
    route: ROUTE,
    runId: "oversize-count",
    capture: (event) => captured.push(event),
    fetch: (async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(512 * 1024 * 1024 + 1));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 503 },
      )) as typeof globalThis.fetch,
  });
  const failure = await count(REQUEST).catch((error: unknown) => error);
  expect(failure).toMatchObject({
    _tag: "PreflightFailed",
    retryable: false,
    message:
      "token counting (investigate-1.initial-context) failed: capture failed: HTTP error body exceeds the 536870912-byte capture object limit",
  });
  expect(cancelled).toBe(true);
  expect(
    artifacts(captured).map((artifact) =>
      typeof artifact === "object" ? artifact.name : artifact,
    ),
  ).toEqual([
    "count-tokens/<call>/call.json",
    "count-tokens/<call>/request.json",
  ]);
});

test("escaped credentials inside nested provider JSON strings stay redacted after decoding", async () => {
  process.env[VARIABLE] = KEY;
  const captured: CaptureEvent[] = [];
  const raw = JSON.stringify({
    error: { type: "authentication_error", message: `Rejected ${KEY}` },
    nested: JSON.stringify({ key: KEY, harmless: "keep me" }),
  }).replaceAll("sk-ant-", "\\u0073k-ant-");
  endpoint.respond(() => new Response(raw, { status: 401 }));
  const failure = await counter(captured)(REQUEST).catch(
    (error: unknown) => error,
  );
  expect(failure).toMatchObject({
    message: expect.stringContaining("Rejected [REDACTED]"),
    retryable: false,
  });
  expect(artifacts(captured)[2]).toMatchObject({
    json: {
      body: {
        error: { message: "Rejected [REDACTED]" },
        nested: JSON.stringify({ key: "[REDACTED]", harmless: "keep me" }),
      },
      bodyRedactions: ["x-api-key"],
    },
  });
  expect(JSON.stringify(artifacts(captured))).not.toContain(KEY);
});
