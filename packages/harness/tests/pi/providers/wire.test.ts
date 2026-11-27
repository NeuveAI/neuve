// Every real submission schema must satisfy the native route's strict JSON Schema rules.
import { expect, test } from "bun:test";
import { z } from "zod";
import { FrameSubmission } from "../../../src/frame.ts";
import { MapSubmission } from "../../../src/review-map.ts";
import { FindSubmission } from "../../../src/find-schema.ts";
import { VerifySubmission } from "../../../src/verify.ts";
import { wireSchema } from "../../../src/toolkit.ts";
import {
  StreamStall,
  conversationId,
  dropAddedNulls,
  errorOf,
  prepareToolArguments,
  safetyBufferingOf,
  toStrictSchema,
  watchForStall,
  type StallPhase,
} from "../../../src/pi/providers/wire.ts";

type Json = Record<string, unknown>;

test("a conversation's session-id is a version 5 UUID of its run and agent, and of nothing else", () => {
  const one = conversationId("01JRUN", "understand.one");
  expect(one).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  expect(conversationId("01JRUN", "understand.one")).toBe(one);
  expect(conversationId("01JRUN", "understand.two")).not.toBe(one);
  expect(conversationId("01JOTHERRUN", "understand.one")).not.toBe(one);
});

const NODE = {
  type: "object",
  properties: { line: { type: "integer" }, label: { type: "string" } },
  required: ["line"],
};
const SCHEMA = {
  type: "object",
  $defs: { node: NODE },
  properties: {
    path: { type: "string" },
    at: { type: "string", format: "date-time" },
    url: { type: "string", format: "uri" },
    note: { type: "string" },
    reason: { anyOf: [{ type: "string" }, { type: "null" }] },
    nodes: { type: "array", items: { $ref: "#/$defs/node" } },
    child: {
      anyOf: [
        {
          type: "object",
          properties: { x: { type: "string" }, y: { type: "string" } },
          required: ["x"],
        },
        { type: "object", properties: { z: { type: "integer" } } },
      ],
    },
  },
  required: ["path"],
};

test("the strict form requires every property, closes every object and makes the optional ones nullable", () => {
  expect(toStrictSchema(SCHEMA)).toEqual({
    type: "object",
    $defs: {
      node: {
        type: "object",
        properties: {
          line: { type: "integer" },
          label: { anyOf: [{ type: "string" }, { type: "null" }] },
        },
        required: ["line", "label"],
        additionalProperties: false,
      },
    },
    properties: {
      path: { type: "string" },
      at: {
        anyOf: [{ type: "string", format: "date-time" }, { type: "null" }],
      },
      url: { anyOf: [{ type: "string" }, { type: "null" }] },
      note: { anyOf: [{ type: "string" }, { type: "null" }] },
      reason: { anyOf: [{ type: "string" }, { type: "null" }] },
      nodes: {
        anyOf: [
          { type: "array", items: { $ref: "#/$defs/node" } },
          { type: "null" },
        ],
      },
      child: {
        anyOf: [
          {
            anyOf: [
              {
                type: "object",
                properties: {
                  x: { type: "string" },
                  y: { anyOf: [{ type: "string" }, { type: "null" }] },
                },
                required: ["x", "y"],
                additionalProperties: false,
              },
              {
                type: "object",
                properties: {
                  z: { anyOf: [{ type: "integer" }, { type: "null" }] },
                },
                required: ["z"],
                additionalProperties: false,
              },
            ],
          },
          { type: "null" },
        ],
      },
    },
    required: ["path", "at", "url", "note", "reason", "nodes", "child"],
    additionalProperties: false,
  });
});

test("prepared tool arguments drop only the nulls strict mode added, on a copy", () => {
  const written = {
    path: "a.ts",
    at: null,
    note: null,
    reason: null,
    nodes: [{ line: 4, label: null }],
    child: { x: "1", y: null },
  };
  const original = structuredClone(written);

  expect(prepareToolArguments(written, SCHEMA)).toEqual({
    path: "a.ts",
    reason: null,
    nodes: [{ line: 4 }],
    child: { x: "1" },
  });
  expect(written).toEqual(original);
  // A required property's null is the model's error; validation, not preparation, refuses it.
  expect(prepareToolArguments({ path: null, note: null }, SCHEMA)).toEqual({
    path: null,
  });
  expect(prepareToolArguments("not an object", SCHEMA)).toBe("not an object");
});

test("a provider's error body and safety-buffering headers read as the route reports them", () => {
  expect(
    errorOf({
      error: {
        code: "subscription_sharing_usage_limit_exceeded",
        param: "",
        message: "Usage limit reached",
      },
    }),
  ).toEqual({
    code: "subscription_sharing_usage_limit_exceeded",
    param: undefined,
    message: "Usage limit reached",
  });
  expect(
    errorOf({ error: { type: "overloaded_error" }, detail: "Overloaded" }),
  ).toEqual({
    code: "overloaded_error",
    param: undefined,
    message: "Overloaded",
  });
  expect(errorOf({ detail: "Unauthorized" })).toEqual({
    code: undefined,
    param: undefined,
    message: "Unauthorized",
  });

  expect(
    safetyBufferingOf(
      new Headers({
        "X-Codex-Safety-Buffering-Reason": "review",
        "x-codex-safety-buffering-active": "true",
        "x-request-id": "req_1",
      }),
    ),
  ).toEqual({
    "x-codex-safety-buffering-active": "true",
    "x-codex-safety-buffering-reason": "review",
  });
  expect(safetyBufferingOf(new Headers({ "x-request-id": "r" }))).toBe(
    undefined,
  );
});

// Why: the reasoning limit must hold only while a reasoning item is open. Inside one, silence past
// the reasoning limit is still a stall; once the item is done, the short limit applies again at
// once, not behind the longer timer set while the item was open.
test("the stall watch applies the reasoning limit only while a reasoning item is open", async () => {
  const limits = { quietMs: 100, reasoningMs: 400 };
  const hang = (signal: AbortSignal) =>
    new Promise<never>((_, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason)),
    );
  const stalled = async (
    script: (touch: (next: StallPhase) => void) => Promise<void>,
  ) => {
    const startedAt = performance.now();
    const error = await watchForStall(
      limits,
      new AbortController().signal,
      async (signal, touch) => {
        await script(touch);
        return hang(signal);
      },
    ).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(StreamStall);
    return {
      stall: error as StreamStall,
      elapsed: performance.now() - startedAt,
    };
  };
  const noHeaders = await stalled(async () => {});
  expect(noHeaders.stall.awaiting).toBe("headers");
  expect(noHeaders.stall.gapMs).toBeGreaterThanOrEqual(limits.quietMs);
  expect(noHeaders.elapsed).toBeLessThan(limits.reasoningMs - 100);
  const inside = await stalled(async (touch) => touch("reasoning"));
  expect(inside.stall.awaiting).toBe("reasoning");
  expect(inside.stall.gapMs).toBeGreaterThanOrEqual(limits.reasoningMs);
  const after = await stalled(async (touch) => {
    touch("reasoning");
    await Bun.sleep(50);
    touch("event");
  });
  expect(after.stall.awaiting).toBe("event");
  expect(after.stall.gapMs).toBeGreaterThanOrEqual(limits.quietMs);
  expect(after.elapsed).toBeLessThan(limits.reasoningMs - 100);
});

test("every stage's submission schema meets OpenAI's strict rules, and its added nulls drop out", () => {
  const schemas = {
    FrameSubmission,
    MapSubmission,
    FindSubmission,
    VerifySubmission,
  };
  for (const [name, schema] of Object.entries(schemas)) {
    const strict = toStrictSchema(wireSchema(schema as z.ZodType).schema);
    expect(strict["type"], name).toBe("object");
    expect(JSON.stringify(strict), name).not.toContain('"allOf"');
    const visit = (node: unknown, path: string) => {
      if (Array.isArray(node))
        return node.forEach((n, i) => visit(n, `${path}/${i}`));
      if (typeof node !== "object" || node === null) return;
      const n = node as Json;
      if (n["properties"] !== undefined || n["type"] === "object") {
        expect(n["additionalProperties"], `${name}${path}`).toBe(false);
        expect(
          [...(n["required"] as string[])].sort(),
          `${name}${path}`,
        ).toEqual(Object.keys((n["properties"] as Json) ?? {}).sort());
      }
      for (const [key, value] of Object.entries(n))
        if (key === "properties" || key === "$defs")
          for (const [child, inner] of Object.entries(value as Json))
            visit(inner, `${path}/${key}/${child}`);
        else visit(value, `${path}/${key}`);
    };
    visit(strict, "");
  }
  // The inverse on a nested value with $defs and a union.
  const Node = z.strictObject({
    kind: z.enum(["a", "b"]),
    label: z.string().optional(),
    child: z
      .union([
        z.strictObject({ x: z.string(), y: z.string().optional() }),
        z.strictObject({ z: z.int() }),
      ])
      .optional(),
  });
  const original = wireSchema(z.strictObject({ nodes: z.array(Node) })).schema;
  const value = {
    nodes: [
      { kind: "a", label: null, child: { x: "1", y: null } },
      { kind: "b", label: "l", child: null },
    ],
  };
  expect(dropAddedNulls(original, value)).toEqual({
    nodes: [
      { kind: "a", child: { x: "1" } },
      { kind: "b", label: "l" },
    ],
  });
});
