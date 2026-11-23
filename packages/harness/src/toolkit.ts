import type { Effect } from "effect";
import type {
  ToolCall,
  ToolHints,
  ToolOutcome as RuntimeToolOutcome,
  ToolSpec as RuntimeToolSpec,
} from "@neuve/runtime";
export type { ToolHints } from "@neuve/runtime";
import { z } from "zod";
import {
  BUDGET_LINE_BYTES,
  READ_MANY_RESULT_BYTES,
  READ_MANY_RESULT_TOKENS,
  TOOL_RESULT_BYTES,
  TOOL_RESULT_TOKENS,
  clipBytes,
} from "./budget.ts";

/** Shared tool specifications and provider schemas used by pi's native tool registrations. */

/** A read-only lookup at a fixed revision: the same arguments always give the same result. */
export const READ_ONLY: ToolHints = {
  readOnly: true,
  destructive: false,
  idempotent: true,
  openWorld: false,
};

/** Records something about the agent's own work (a submission, a vent): not destructive, local. */
export const RECORDS: ToolHints = {
  readOnly: false,
  destructive: false,
  idempotent: false,
  openWorld: false,
};

/**
 * A task a tool call starts as another task's child, in the commit that records the call's answer
 * (pi/stages/tools.ts): created and named in the owner's children together, once per owner and
 * name, so a call rerun after a crash, or a later call asking for the same name, finds the child
 * already started. An owner that takes no new work (finished, finishing or being stopped) gets none.
 */
export interface ChildRequest {
  /** The task that owns the child: its abort stops the child, and it waits for the child. */
  readonly owner: number;
  /** The child's name in its owner's children (`ChildrenDoc`). */
  readonly name: string;
  /** The registered task kind to start. */
  readonly task: string;
  /** The task's input, as that kind takes it. */
  readonly input: unknown;
  /** Keys, names and counts for the span that records the start; never content. */
  readonly attributes: Readonly<Record<string, string | number>>;
  /**
   * The child's kind and the computation keys it reads, for its `task.inputs` run-log record, so a
   * collector joins its start with its inputs' producers.
   */
  readonly kind: string;
  readonly inputs: Readonly<Record<string, string>>;
}

/**
 * What a tool handler returns: the runtime contract's outcome (`@neuve/runtime`), plus a child task
 * the call's answer starts (`ChildRequest`), which only the harness's own tools ask for.
 */
export interface ToolOutcome extends RuntimeToolOutcome {
  readonly child?: ChildRequest | undefined;
}

/** 10.18's cap on a tool result, which every tool has unless it declares another. */
export const TOOL_RESULT_CAP = {
  tokens: TOOL_RESULT_TOKENS,
  bytes: TOOL_RESULT_BYTES,
} as const;

/** `read_many`'s larger cap (budget.ts `READ_MANY_RESULT_TOKENS`), the owner's ruling of 12 November. */
export const READ_MANY_CAP = {
  tokens: READ_MANY_RESULT_TOKENS,
  bytes: READ_MANY_RESULT_BYTES,
} as const;

/** The caps a tool result can have: no other size can be declared without a constant here. */
export type ResultCap = typeof TOOL_RESULT_CAP | typeof READ_MANY_CAP;

/** The runtime contract's tool (`@neuve/runtime`), with the harness's outcome and result cap. */
export interface ToolSpec<I = unknown> extends Omit<
  RuntimeToolSpec<I>,
  "handle"
> {
  readonly handle: (input: I, call?: ToolCall) => Effect.Effect<ToolOutcome>;
  readonly available?: false;
  /** A larger result cap the tool declares (`ResultCap`); absent, 10.18's `TOOL_RESULT_CAP`. */
  readonly resultCap?: ResultCap | undefined;
}

export const defineTool = <I>(spec: ToolSpec<I>): ToolSpec<unknown> =>
  spec as unknown as ToolSpec<unknown>;

/**
 * The JSON Schema keywords Anthropic's strict tools and structured outputs accept (the same set
 * Effect's own `toCodecAnthropic` keeps for Effect schemas). `additionalProperties` is kept only as
 * `false`. Anything else, such as `minLength`, `maxLength`, numeric bounds and `$schema`, is
 * removed from what the provider sees; zod still enforces it.
 */
const SUPPORTED_KEYWORDS = new Set([
  "$ref",
  "type",
  "title",
  "description",
  "enum",
  "const",
  "anyOf",
  "allOf",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "pattern",
  "format",
  "$defs",
]);

const SUPPORTED_FORMATS = new Set([
  "date-time",
  "time",
  "date",
  "duration",
  "email",
  "hostname",
  "uri",
  "ipv4",
  "ipv6",
  "uuid",
]);

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Strips a JSON Schema to the supported keywords, recursively, and reports what it removed. */
export const stripForProvider = (
  schema: unknown,
  removed = new Set<string>(),
): { readonly schema: Json; readonly removed: ReadonlySet<string> } => {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!isObject(node)) return node;
    const out: Json = {};
    for (const [key, value] of Object.entries(node)) {
      if (!SUPPORTED_KEYWORDS.has(key)) {
        removed.add(key);
        continue;
      }
      if (key === "additionalProperties" && value !== false) {
        removed.add("additionalProperties(non-false)");
        continue;
      }
      if (key === "format" && !SUPPORTED_FORMATS.has(String(value))) {
        removed.add(`format:${String(value)}`);
        continue;
      }
      if (key === "properties" || key === "$defs") {
        out[key] = Object.fromEntries(
          Object.entries(isObject(value) ? value : {}).map(([name, child]) => [
            name,
            walk(child),
          ]),
        );
        continue;
      }
      out[key] = walk(value);
    }
    // What was removed still binds: the agent reads it in the description, zod enforces it.
    const limits = describeLimits(node);
    if (limits !== undefined)
      out["description"] =
        typeof out["description"] === "string" && out["description"] !== ""
          ? `${out["description"]} (${limits})`
          : limits;
    return out;
  };
  return { schema: walk(schema) as Json, removed };
};

/** Integer bounds zod adds for `z.int()` are the safe-integer range, which says nothing. */
const MEANINGFUL = (value: unknown) =>
  typeof value === "number" && Math.abs(value) < Number.MAX_SAFE_INTEGER;

/**
 * The removed length, size and numeric bounds of one schema node, in words, the way Anthropic's own
 * SDKs move unsupported constraints into the description.
 */
const describeLimits = (node: Json): string | undefined => {
  const parts: Array<string> = [];
  const range = (low: unknown, high: unknown, unit: string) => {
    const lo = MEANINGFUL(low) ? (low as number) : undefined;
    const hi = MEANINGFUL(high) ? (high as number) : undefined;
    if (lo !== undefined && hi !== undefined)
      parts.push(`${lo} to ${hi} ${unit}`);
    else if (hi !== undefined) parts.push(`at most ${hi} ${unit}`);
    else if (lo !== undefined && lo > 1) parts.push(`at least ${lo} ${unit}`);
  };
  range(node["minLength"], node["maxLength"], "characters");
  range(node["minItems"], node["maxItems"], "items");
  if (MEANINGFUL(node["minimum"]) || MEANINGFUL(node["maximum"])) {
    const lo = MEANINGFUL(node["minimum"])
      ? `from ${String(node["minimum"])}`
      : "";
    const hi = MEANINGFUL(node["maximum"])
      ? `up to ${String(node["maximum"])}`
      : "";
    parts.push([lo, hi].filter((part) => part !== "").join(" "));
  }
  return parts.length === 0 ? undefined : parts.join("; ");
};

/** The JSON Schema zod produces for a tool or output schema, as the provider will see it. */
export const wireSchema = (
  schema: z.ZodType,
  io: "input" | "output" = "output",
) => stripForProvider(z.toJSONSchema(schema, { target: "draft-2020-12", io }));

export const describeZodError = (error: z.ZodError) => z.prettifyError(error);

export const toolInputRefusal = (
  name: string,
  schema: z.ZodType,
  error: z.ZodError,
  raw: unknown,
) => {
  const input = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" });
  const show = (value: unknown) => JSON.stringify(value) ?? "no value";
  const sentences = error.issues.map((issue) => {
    let path = "";
    let received = raw;
    let node: unknown = input;
    for (const key of issue.path) {
      if (typeof key === "number") {
        path += `[${key}]`;
        received = Array.isArray(received) ? received[key] : undefined;
        node = isObject(node)
          ? ((Array.isArray(node["prefixItems"])
              ? node["prefixItems"][key]
              : undefined) ?? node["items"])
          : undefined;
      } else {
        const field = String(key);
        path += path === "" ? field : `.${field}`;
        received = isObject(received) ? received[field] : undefined;
        const properties = isObject(node) ? node["properties"] : undefined;
        node = isObject(properties) ? properties[field] : undefined;
      }
    }
    const field = path === "" ? `${name} arguments` : `${name} ${path}`;
    if (issue.code === "unrecognized_keys") {
      const properties = isObject(node) ? node["properties"] : undefined;
      const keys = Object.keys(isObject(properties) ? properties : {});
      const accepted =
        keys.length === 0
          ? "no keys"
          : `only the keys ${keys.map(show).join(", ")}`;
      return `${field} accepts ${accepted} and received unknown ${issue.keys.length === 1 ? "key" : "keys"} ${issue.keys.map(show).join(", ")}.`;
    }
    const acceptsNull =
      isObject(node) &&
      Array.isArray(node["anyOf"]) &&
      node["anyOf"].some(
        (option: unknown) => isObject(option) && option["type"] === "null",
      );
    if (received === undefined && acceptsNull)
      return `${field} received no value and accepts explicit null.`;
    const value = show(received);
    if (issue.code === "invalid_value") {
      const choices = [
        ...issue.values.map(show),
        ...(acceptsNull ? ["null"] : []),
      ];
      return `${field} accepts ${choices.join(" or ")} and received ${value}.`;
    }
    const type =
      isObject(node) && typeof node["type"] === "string"
        ? node["type"]
        : undefined;
    const limits = isObject(node) ? describeLimits(node) : undefined;
    if (
      issue.code === "invalid_type" ||
      (limits !== undefined &&
        (issue.code === "too_big" || issue.code === "too_small"))
    ) {
      const expected =
        type ?? (issue.code === "invalid_type" ? issue.expected : issue.origin);
      return `${field} takes ${/^[aeiou]/.test(expected) ? "an" : "a"} ${expected}${limits === undefined ? "" : ` (${limits})`}${acceptsNull ? " or null" : ""} and received ${value}.`;
    }
    return `${field} received ${value} (${issue.message.replace(/\.$/, "")}).`;
  });
  return capResult(sentences.join("\n"), undefined);
};

/**
 * A tool result as the agent reads it: the text and the budget line, held to the hard cap (10.18),
 * or to the larger cap its tool declares. A result that still exceeds it, which the tools' paging
 * should prevent, is cut with a note the agent can act on.
 */
export const capResult = (
  text: string,
  line: string | undefined,
  cap: ResultCap = TOOL_RESULT_CAP,
) => {
  const full = line === undefined ? text : `${text}\n\n${line}`;
  if (Buffer.byteLength(full) <= cap.bytes) return full;
  const tail = `\n[result cut at the ${cap.tokens.toLocaleString("en")}-token cap; ask for the next page or narrow the lookup]${line === undefined ? "" : `\n\n${line}`}`;
  return `${clipBytes(text, cap.bytes - Buffer.byteLength(tail))}${tail}`;
};

/** Whether a result with its budget line is near or over its cap, which telemetry records. */
export const nearCap = (
  text: string,
  withBudgetLine: boolean,
  cap: ResultCap = TOOL_RESULT_CAP,
) =>
  Buffer.byteLength(text) + (withBudgetLine ? BUDGET_LINE_BYTES : 0) >
  cap.bytes;

/**
 * How one MCP tool's input schema converts to zod (10.53): converted with `z.fromJSONSchema`, then
 * converted back with `z.toJSONSchema` and compared keyword by keyword. A schema whose validation
 * keywords do not all survive the round trip would let the proxied tool accept input its own schema
 * refuses, or refuse what it accepts, so it is refused rather than used lossily.
 */
export type McpSchemaConversion =
  | { readonly status: "converted"; readonly schema: z.ZodType }
  | {
      readonly status: "refused";
      readonly reason: string;
      readonly lost: ReadonlyArray<string>;
    };

/** Keywords that only describe; they may change shape in the round trip without loss. */
const ANNOTATION_KEYWORDS = new Set([
  "title",
  "description",
  "$comment",
  "examples",
  "default",
  "$schema",
  "$id",
  "deprecated",
  "readOnly",
  "writeOnly",
]);

const validationFacts = (
  schema: unknown,
  path = "#",
  into = new Set<string>(),
) => {
  if (Array.isArray(schema)) {
    schema.forEach((item, index) =>
      validationFacts(item, `${path}/${index}`, into),
    );
    return into;
  }
  if (!isObject(schema)) return into;
  for (const [key, value] of Object.entries(schema)) {
    if (ANNOTATION_KEYWORDS.has(key)) continue;
    if (isObject(value) || Array.isArray(value)) {
      if (key === "required" || key === "enum")
        into.add(
          `${path}/${key}=${JSON.stringify([...(value as Array<unknown>)].sort())}`,
        );
      else validationFacts(value, `${path}/${key}`, into);
      continue;
    }
    into.add(`${path}/${key}=${JSON.stringify(value)}`);
  }
  return into;
};

export const convertMcpInputSchema = (
  jsonSchema: unknown,
): McpSchemaConversion => {
  let converted: z.ZodType;
  try {
    converted = z.fromJSONSchema(jsonSchema as never);
  } catch (error) {
    return {
      status: "refused",
      reason: error instanceof Error ? error.message : String(error),
      lost: [],
    };
  }
  let back: unknown;
  try {
    back = z.toJSONSchema(converted, { target: "draft-2020-12" });
  } catch (error) {
    return {
      status: "refused",
      reason: `the converted schema has no JSON Schema form: ${error instanceof Error ? error.message : String(error)}`,
      lost: [],
    };
  }
  const before = validationFacts(jsonSchema);
  const after = validationFacts(back);
  const lost = [...before].filter((fact) => !after.has(fact)).sort();
  return lost.length === 0
    ? { status: "converted", schema: converted }
    : {
        status: "refused",
        reason: `${lost.length} validation keyword(s) did not survive conversion`,
        lost,
      };
};
