import { createHash } from "node:crypto";

/**
 * The native OpenAI route's wire: its tool namespace, strict JSON Schema subset and inverse,
 * conversation affinity, usage, error body, safety-buffering headers and stall watch. The public
 * catalogue probe also reads the pure error-body parser here.
 */

/** Raw usage as the Responses API reports it, read by route.ts for telemetry and cost. */
export interface RawOpenAiUsage {
  readonly input_tokens?: number;
  readonly input_tokens_details?: {
    readonly cached_tokens?: number;
    readonly cache_write_tokens?: number;
  };
  readonly output_tokens?: number;
  readonly output_tokens_details?: { readonly reasoning_tokens?: number };
}

/** The single namespace the harness's function tools are grouped in. */
export const TOOL_NAMESPACE = "neuve";

/** A fixed namespace for `conversationId`'s name-based UUIDs. */
const CONVERSATION_NAMESPACE = Buffer.from(
  "6f1d3c2a8b7e4f50a9c4d2e1b0f3a7c6",
  "hex",
);

/**
 * One agent conversation's `session-id`: a name-based UUID (version 5, SHA-1, RFC 9562) of the
 * run ID and the agent's name, so the same agent in the same run, resumed or retried, gets the
 * same UUID and nothing else does. It holds neither input, and no prompt or source text.
 */
export const conversationId = (runId: string, agent: string) => {
  const bytes = createHash("sha1")
    .update(CONVERSATION_NAMESPACE)
    .update(JSON.stringify([runId, agent]))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/**
 * How long an attempt may go with no sign of life outside an open reasoning item, waiting for the
 * response headers or the next stream event, before it is aborted as stalled and retried. From the
 * run log of 22 October 2026: a Sol call got its headers after 13.5 s and `response.created`, then
 * nothing for about 10 minutes until the run's 9:45 cut-off (10.42) ended the review with
 * Investigate never through a turn. The longest healthy wait for headers seen so far is 44.8 s
 * (Understand turn 3 of that run) and the longest silence mid-stream 29.9 s, so 120 s leaves well
 * over twice either before a stall is called.
 */
export const STREAM_STALL_MS = 120_000;

/**
 * The limit while a reasoning item is open (added, not yet done). The request asks for no reasoning
 * summary, so the stream is silent while the model thinks: both long mid-stream silences seen so far
 * (29.9 s the longest, at medium effort) fell inside an open reasoning item, and at high effort
 * reasoning may run past `STREAM_STALL_MS`. The run's cut-off bounds it anyway.
 */
export const REASONING_STALL_MS = 300_000;

/** The `error.type` of a stalled attempt, reported by the native route failure. */
export const STREAM_STALLED = "stream_stalled";

/** The stall limits for the calls in scope, outside and inside reasoning; tests shorten them. */
export interface StallLimits {
  readonly quietMs: number;
  readonly reasoningMs: number;
}

// OpenAI's strict JSON Schema subset (structured outputs guide: supported schemas)

type Json = Record<string, unknown>;
export const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Formats the strict subset accepts; any other is dropped (zod still checks it). */
const STRICT_FORMATS = new Set([
  "date-time",
  "time",
  "date",
  "duration",
  "email",
  "hostname",
  "ipv4",
  "ipv6",
  "uuid",
]);

const acceptsNull = (schema: unknown): boolean => {
  if (!isObject(schema)) return false;
  const type = schema["type"];
  if (type === "null" || (Array.isArray(type) && type.includes("null")))
    return true;
  if (schema["const"] === null) return true;
  if (Array.isArray(schema["enum"]) && schema["enum"].includes(null))
    return true;
  const anyOf = schema["anyOf"];
  return Array.isArray(anyOf) && anyOf.some(acceptsNull);
};

/**
 * The strict form of a JSON Schema: every object lists all its properties as required and sets
 * `additionalProperties: false`; a property that was optional becomes `anyOf [schema, null]`
 * unless it already accepts null. Formats outside the subset are dropped.
 */
export const toStrictSchema = (schema: unknown): Json => {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!isObject(node)) return node;
    const out: Json = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === "format" && !STRICT_FORMATS.has(String(value))) continue;
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
    if (isObject(out["properties"]) || out["type"] === "object") {
      const properties = isObject(out["properties"]) ? out["properties"] : {};
      const required = new Set(
        Array.isArray(node["required"]) ? (node["required"] as string[]) : [],
      );
      out["properties"] = Object.fromEntries(
        Object.entries(properties).map(([name, child]) => [
          name,
          required.has(name) || acceptsNull(child)
            ? child
            : { anyOf: [child, { type: "null" }] },
        ]),
      );
      out["required"] = Object.keys(properties);
      out["additionalProperties"] = false;
    }
    return out;
  };
  return walk(schema) as Json;
};

/**
 * The inverse of `toStrictSchema` on a value: removes the nulls strict mode made the model write
 * for optional properties, so the value is what the original schema (and zod) expect. A null on a
 * property that accepted null before is kept.
 */
export const dropAddedNulls = (schema: unknown, value: unknown): unknown => {
  const root = isObject(schema) ? schema : {};
  const resolve = (node: unknown): unknown => {
    if (!isObject(node) || typeof node["$ref"] !== "string") return node;
    const match = /^#\/\$defs\/(.+)$/.exec(node["$ref"]);
    const defs = root["$defs"];
    return match !== null && isObject(defs) ? resolve(defs[match[1]!]) : node;
  };
  const walk = (raw: unknown, data: unknown): unknown => {
    const node = resolve(raw);
    if (!isObject(node)) return data;
    if (Array.isArray(data))
      return node["items"] === undefined
        ? data
        : data.map((item) => walk(node["items"], item));
    if (!isObject(data)) return data;
    const branches = Array.isArray(node["anyOf"]) ? node["anyOf"] : undefined;
    if (branches !== undefined && node["properties"] === undefined) {
      const keys = Object.keys(data);
      const branch = branches
        .map(resolve)
        .find(
          (candidate) =>
            isObject(candidate) &&
            isObject(candidate["properties"]) &&
            keys.every((key) =>
              Object.hasOwn(candidate["properties"] as Json, key),
            ),
        );
      return branch === undefined ? data : walk(branch, data);
    }
    const properties = isObject(node["properties"]) ? node["properties"] : {};
    const required = new Set(
      Array.isArray(node["required"]) ? (node["required"] as string[]) : [],
    );
    const out: Json = {};
    for (const [key, item] of Object.entries(data)) {
      const child = properties[key];
      if (
        item === null &&
        !required.has(key) &&
        child !== undefined &&
        !acceptsNull(resolve(child))
      )
        continue;
      out[key] = child === undefined ? item : walk(child, item);
    }
    return out;
  };
  return walk(root, value);
};

/**
 * A tool call's arguments as the tool's own schema reads them, for `ToolRegistration.prepareArguments`
 * on the OpenAI route: `dropAddedNulls` on a copy, so the transcript keeps what the model wrote. A
 * null on a nullable property, or on a required one, is left for the tool's validation to judge.
 */
export const prepareToolArguments = (args: unknown, schema: unknown) =>
  dropAddedNulls(schema, args);

/** Codes the "Sign in with ChatGPT" errors guide says not to retry. */
export const NOT_RETRYABLE_CODES =
  /^(subscription_sharing_(user_not_eligible|unsupported_capability|route_not_supported|invalid_user)|chatpass_v2_)/;
export const USAGE_LIMIT = "subscription_sharing_usage_limit_exceeded";

export const errorOf = (body: unknown) => {
  const record = isObject(body) ? body : {};
  const error = isObject(record["error"]) ? record["error"] : record;
  const text = (value: unknown) =>
    typeof value === "string" && value !== "" ? value : undefined;
  return {
    code: text(error["code"]) ?? text(error["type"]),
    param: text(error["param"]),
    message: text(error["message"]) ?? text(record["detail"]),
  };
};

/** The prefix of the response headers that say whether the route holds output back. */
const SAFETY_BUFFERING = "x-codex-safety-buffering-";

/** The response's `x-codex-safety-buffering-*` headers, by name, or undefined when it sent none. */
export const safetyBufferingOf = (headers: Headers) => {
  const kept = [...headers]
    .filter(([name]) => name.toLowerCase().startsWith(SAFETY_BUFFERING))
    .map(([name, value]) => [name.toLowerCase(), value.slice(0, 200)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return kept.length === 0 ? undefined : Object.fromEntries(kept);
};

/**
 * What a stalled attempt was waiting for: its response headers, the next event outside reasoning,
 * or the next event while a reasoning item was open.
 */
export type StallPhase = "headers" | "event" | "reasoning" | "admission";

/** An attempt that went too long without a sign of life: the silence it measured, and in what phase. */
export class StreamStall {
  constructor(
    readonly gapMs: number,
    readonly awaiting: Exclude<StallPhase, "admission">,
  ) {}
}

/**
 * Runs `run` under a stall watch: it gets a signal that aborts when the phase's limit passes with
 * no `touch`, at which point the result rejects with a `StreamStall` at once, whether or not `run`
 * honours the signal. Each `touch` names the phase the attempt is in next: `reasoningMs` applies
 * while it waits inside an open reasoning item, `quietMs` otherwise. The watch ends with `run` or
 * when `parent` aborts. Times come from Bun's performance clock (10.97), not Effect's, so a test
 * clock cannot hold a stall off forever.
 */
export const watchForStall = <A>(
  limits: StallLimits,
  parent: AbortSignal,
  run: (signal: AbortSignal, touch: (next: StallPhase) => void) => Promise<A>,
): Promise<A> =>
  new Promise<A>((resolve, reject) => {
    const controller = new AbortController();
    let lastAt = performance.now();
    let awaiting: StallPhase = "headers";
    let timer: ReturnType<typeof setTimeout> | undefined;
    let over = false;
    const limit = () =>
      awaiting === "reasoning" ? limits.reasoningMs : limits.quietMs;
    const stop = () => {
      over = true;
      clearTimeout(timer);
      parent.removeEventListener("abort", stop);
    };
    // One timer at a time: when it fires early because of a later touch, it waits the rest; a
    // change of phase sets it afresh, so a shorter limit is not left behind a longer one.
    const arm = (delay: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (over || awaiting === "admission") return;
        const silent = performance.now() - lastAt;
        if (silent < limit()) return arm(limit() - silent);
        const stall = new StreamStall(Math.round(silent), awaiting);
        stop();
        reject(stall);
        controller.abort(stall);
      }, delay);
    };
    parent.addEventListener("abort", stop, { once: true });
    arm(limit());
    run(AbortSignal.any([parent, controller.signal]), (next) => {
      if (over) return;
      lastAt = performance.now();
      if (next === "admission") {
        awaiting = next;
        clearTimeout(timer);
        return;
      }
      if (next !== awaiting) {
        awaiting = next;
        arm(limit());
      }
    })
      .then(resolve, reject)
      .finally(stop);
  });
