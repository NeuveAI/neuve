import { describe, expect, test } from "bun:test";
import { Effect, Tracer } from "effect";
import { z } from "zod";
import { maskText } from "../src/masking.ts";
import { MAX_SPAN_EVENTS, runLogTracer } from "../src/run-log.ts";
import { OPUS_ROUTE, SOL_ROUTE, costOf, type CallUsage } from "../src/route.ts";
import { convertMcpInputSchema, wireSchema } from "../src/toolkit.ts";

/**
 * Boundaries where a regression would pass silently: nothing downstream would fail, the output
 * would just be wrong (7.3, 11.2).
 */

// Why: a lossy conversion would let a proxied tool accept input its own schema refuses (10.53);
// the tool would keep working, so nothing would show it.
describe("MCP input schema conversion", () => {
  test("converts a schema whose validation keywords all survive", () => {
    const converted = convertMcpInputSchema({
      type: "object",
      properties: {
        query: { type: "string", maxLength: 200 },
        state: { type: "string", enum: ["open", "closed"] },
      },
      required: ["query"],
      additionalProperties: false,
    });
    expect(converted.status).toBe("converted");
    if (converted.status === "converted") {
      expect(
        converted.schema.safeParse({ query: "x".repeat(201) }).success,
      ).toBe(false);
      expect(
        converted.schema.safeParse({ query: "ok", extra: 1 }).success,
      ).toBe(false);
    }
  });

  test("refuses keywords zod drops or cannot express", () => {
    for (const schema of [
      {
        type: "object",
        patternProperties: { "^x-": { type: "string" } },
        additionalProperties: false,
      },
      {
        type: "object",
        properties: { a: { type: "string" } },
        if: { required: ["a"] },
        then: { required: ["b"] },
      },
      {
        type: "object",
        properties: { term: { type: "string", not: { const: "" } } },
      },
      {
        type: "object",
        properties: { id: { $ref: "https://example.com/id.json" } },
      },
    ])
      expect(convertMcpInputSchema(schema).status).toBe("refused");
  });
});

// Why: a keyword the provider rejects only fails the request (loud), but losing zod's own caps
// from the parse side would accept oversized input silently; both halves are checked here.
describe("tool schemas on the wire", () => {
  test("strips rejected keywords while zod keeps enforcing them", () => {
    const schema = z.strictObject({
      title: z.string().min(3).max(40),
      count: z.int().min(1).max(9),
    });
    const { schema: wire, removed } = wireSchema(schema);
    expect(JSON.stringify(wire)).not.toMatch(
      /minLength|maxLength|minimum|maximum|\$schema/,
    );
    expect([...removed]).toEqual(
      expect.arrayContaining(["maxLength", "maximum", "$schema"]),
    );
    expect(
      (wire as { additionalProperties?: unknown }).additionalProperties,
    ).toBe(false);
    // The removed limits stay visible to the agent in the field's description.
    expect(JSON.stringify(wire)).toContain("3 to 40 characters");
    expect(JSON.stringify(wire)).toContain("from 1 up to 9");
    expect(schema.safeParse({ title: "x".repeat(41), count: 2 }).success).toBe(
      false,
    );
  });
});

// Why: a masking regression would leave identifiers in 30-day captures (10.8, 10.24) with no error.
describe("capture masking", () => {
  test("masks emails, key shapes with their prefix, and declared identifiers, keeping JSON valid", () => {
    const capture = JSON.stringify({
      text: "ping ana@example.com with sk-ant-api03-abcdefghijklmnop and lin_api_0123456789abcdefghijklmn about ABC-123",
    });
    const masked = maskText(capture, ["ABC-123"]);
    expect(masked).not.toMatch(
      /ana@example\.com|abcdefghijklmnop|0123456789abcdefghij|ABC-123/,
    );
    expect(masked).toContain("sk-ant-<masked>");
    expect(masked).toContain("lin_<masked>");
    expect(() => JSON.parse(masked)).not.toThrow();
  });
});

// Why: cost is computed, never reported by the provider; a wrong split would misstate spend (2.5).
describe("usage and cost", () => {
  test("prices input, output and both cache TTLs from the frozen table", () => {
    const usage: CallUsage = {
      input: 1_000,
      output: 500,
      cacheRead: 10_000,
      cacheWrite5m: 1_000,
      cacheWrite1h: 2_000,
      thinking: 120,
    };
    expect(costOf(OPUS_ROUTE, usage)).toBeCloseTo(0.037, 9);
  });

  test("a subscription route keeps per-token cost unknown", () => {
    expect(
      costOf(SOL_ROUTE, {
        input: 1_000,
        output: 500,
        cacheRead: 0,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
      }),
    ).toBeNull();
  });
});

// Why: content in a span would reach the run log and any OTLP collector with no error (§3.8).
describe("span attributes", () => {
  test("keeps call metadata and drops tool content", async () => {
    const written: Array<Record<string, unknown>> = [];
    const tracer = runLogTracer({
      path: "",
      write: (record) => written.push(record),
      read: () => [],
    });
    await Effect.runPromise(
      Effect.void.pipe(
        Effect.withSpan("harness.tool-call", {
          attributes: {
            "gen_ai.request.model": "claude-opus-5-5",
            parameters: { notes: ["secret text"] },
            tool: "submit_investigate",
          },
        }),
        Effect.provideService(Tracer.Tracer, tracer),
      ),
    );
    expect(written.filter((row) => row["type"] === "span.start")).toHaveLength(
      1,
    );
    const ended = written.filter((row) => row["type"] === "span");
    expect(ended).toHaveLength(1);
    expect(ended[0]?.["attributes"]).toEqual({
      "gen_ai.request.model": "claude-opus-5-5",
    });
  });
  // Why: span events now carry the attempt's stream (10.97), and Effect also turns every log line
  // into an event on the current span, whose name is the message and whose attributes may hold an
  // error's text. Only the harness's named events may pass, with metadata attributes, bounded.
  test("keeps the harness's named events with metadata, drops log events, and bounds them", async () => {
    const written: Array<Record<string, unknown>> = [];
    const tracer = runLogTracer({
      path: "",
      write: (record) => written.push(record),
      read: () => [],
    });
    await Effect.runPromise(
      Effect.gen(function* () {
        const span = yield* Effect.currentSpan;
        span.event("harness.stream.gap", 1n, {
          "harness.gap_ms": 3_200,
          content: "secret text",
          "error.type": "stream",
        });
        yield* Effect.logWarning("secret text in a log line");
        for (let n = 0; n < MAX_SPAN_EVENTS + 5; n += 1)
          span.event("harness.stream.item", 2n);
      }).pipe(
        Effect.withSpan("harness.model-call"),
        Effect.provideService(Tracer.Tracer, tracer),
      ),
    );
    expect(written.filter((row) => row["type"] === "span.start")).toHaveLength(
      1,
    );
    const ended = written.filter((row) => row["type"] === "span");
    expect(ended).toHaveLength(1);
    const events = ended[0]?.["events"] as Array<Record<string, unknown>>;
    expect(events[0]).toMatchObject({
      name: "harness.stream.gap",
      attributes: { "harness.gap_ms": 3_200, "error.type": "stream" },
    });
    expect(events).toHaveLength(MAX_SPAN_EVENTS);
    expect(ended[0]?.["eventsDropped"]).toBe(6);
    expect(JSON.stringify(written)).not.toContain("secret");
  });
});
