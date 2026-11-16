import { foldJson, isJsonObject } from "./json-walk.ts";
import { z } from "zod";
import type { Model, Message } from "@earendil-works/pi-ai";
import {
  normalizeContext,
  resolveTranscript,
  getDeclaredTools,
  toToolDeclaration,
} from "@earendil-works/pi-ai/utils/transcript";
import { createGrammarToolInputProperties } from "@earendil-works/pi-ai/api/constrained-sampling";
import type { NativeSnapshot } from "./sources.ts";
import type { Api, TranscriptContext } from "@earendil-works/pi-ai";
import {
  Json,
  SdkContext,
  SdkCompat,
  SdkCost,
  SdkInvocation,
  SdkInvocationEnd,
  RETAINED_SDK_PIN,
} from "./types.ts";
import type { CallRecord } from "./dump.ts";

type Call = Omit<CallRecord, "role">;
export class RetainedContextUnavailable extends Error {}
export type RetainedContext = {
  model: Model<"openai-responses" | "anthropic-messages">;
  context: TranscriptContext;
  invocation: SdkInvocation | undefined;
  grammarToolInputProperties: ReadonlyMap<string, string>;
};
const record = (
  v: Json | undefined,
): Readonly<Record<string, Json>> | undefined =>
  v !== undefined && isJsonObject(v) ? v : undefined;
const customTypes: ReadonlySet<string> = new Set([
  "custom",
  "custom_tool_call",
  "custom_tool_call_output",
]);
const custom = (value: Json): boolean =>
  foldJson(value, undefined, (value, _state, children) => {
    const object = record(value);
    if (object !== undefined && customTypes.has(String(object["type"])))
      return true;
    for (const [, found] of children(() => undefined)) if (found) return true;
    return false;
  });

const legacyEvents = new Set([
  "response.created",
  "response.queued",
  "response.in_progress",
  "response.output_item.added",
  "response.output_item.done",
  "response.output_text.delta",
  "response.refusal.delta",
  "response.reasoning_summary_text.delta",
  "response.reasoning_summary_part.done",
  "response.reasoning_text.delta",
  "response.function_call_arguments.delta",
  "response.function_call_arguments.done",
  "response.completed",
  "response.incomplete",
  "response.failed",
  "error",
]);
const legacyTypes: ReadonlySet<string> = new Set([
  "message",
  "reasoning",
  "function_call",
  "output_text",
  "summary_text",
  "refusal",
]);
// Only these retained shapes have no dependency on a missing tool map or model rates.
const legacyIndependent = (value: Json): boolean =>
  foldJson(value, false, (value, usage, children) => {
    if (usage && (value === null || value === 0)) return true;
    if (usage && record(value) === undefined) return false;
    const object = record(value);
    if (!usage && object !== undefined) {
      const transformations = object["input_transformations"];
      if (Array.isArray(transformations) && transformations.length)
        return false;
      const type = object["type"];
      if (
        typeof type === "string" &&
        !legacyEvents.has(type) &&
        !legacyTypes.has(type)
      )
        return false;
    }
    for (const [, independent] of children((key) => usage || key === "usage"))
      if (!independent) return false;
    return true;
  });
const JsonObject = z.record(z.string(), Json);
const Text = z.looseObject({
  type: z.literal("text"),
  text: z.string(),
  textSignature: z.string().optional(),
});
const Image = z.looseObject({
  type: z.literal("image"),
  data: z.string(),
  mimeType: z.string(),
});
const Tool = z.looseObject({
  name: z.string(),
  description: z.string(),
  parameters: JsonObject,
  constrainedSampling: z
    .union([
      z.literal(false),
      z.strictObject({
        type: z.literal("json_schema"),
        strict: z.enum(["prefer", "require"]),
      }),
      z.strictObject({
        type: z.literal("grammar"),
        variants: z.strictObject({
          openai_lark: z.string().optional(),
          openai_regex: z.string().optional(),
        }),
      }),
    ])
    .optional(),
});
const Usage = z.looseObject({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  cacheWrite1h: z.number().optional(),
  reasoning: z.number().optional(),
  totalTokens: z.number(),
  cost: z.looseObject({
    input: z.number(),
    output: z.number(),
    cacheRead: z.number(),
    cacheWrite: z.number(),
    total: z.number(),
  }),
});
const Messages = z.array(
  z.discriminatedUnion("role", [
    z.looseObject({
      role: z.literal("system"),
      timestamp: z.number(),
      content: z.union([z.string(), z.array(Text)]),
      sections: z
        .record(z.string(), z.union([z.string(), z.null()]))
        .optional(),
      toolsAdded: z.array(Tool).optional(),
      toolsRemoved: z.array(z.looseObject({ name: z.string() })).optional(),
    }),
    z.looseObject({
      role: z.literal("user"),
      timestamp: z.number(),
      content: z.union([z.string(), z.array(z.union([Text, Image]))]),
    }),
    z.looseObject({
      role: z.literal("assistant"),
      timestamp: z.number(),
      api: z.string(),
      provider: z.string(),
      model: z.string(),
      content: z.array(
        z.union([
          Text,
          z.looseObject({
            type: z.literal("thinking"),
            thinking: z.string(),
            thinkingSignature: z.string().optional(),
            redacted: z.boolean().optional(),
          }),
          z.looseObject({
            type: z.literal("toolCall"),
            id: z.string(),
            name: z.string(),
            arguments: JsonObject,
            thoughtSignature: z.string().optional(),
            namespace: z.string().optional(),
          }),
        ]),
      ),
      usage: Usage,
      stopReason: z.enum([
        "pending",
        "stop",
        "length",
        "toolUse",
        "error",
        "aborted",
        "deferred",
      ]),
      responseModel: z.string().optional(),
      responseId: z.string().optional(),
      providerThinkingLevel: z.string().optional(),
      thinkingLevel: z
        .enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"])
        .optional(),
      diagnostics: z
        .array(
          z.looseObject({
            type: z.string(),
            timestamp: z.number(),
            error: z
              .looseObject({
                name: z.string().optional(),
                message: z.string(),
                stack: z.string().optional(),
                code: z.union([z.string(), z.number()]).optional(),
              })
              .optional(),
            details: JsonObject.optional(),
          }),
        )
        .optional(),
      deferred: z
        .looseObject({
          provider: z.string(),
          modelId: z.string(),
          api: z.string(),
          id: z.string(),
          expiresAt: z.number().optional(),
          pollAfterMs: z.number().optional(),
          data: Json.optional(),
        })
        .optional(),
      errorMessage: z.string().optional(),
      rawStopReason: z.string().optional(),
      endTurn: z.boolean().optional(),
    }),
    z.looseObject({
      role: z.literal("toolResult"),
      timestamp: z.number(),
      toolCallId: z.string(),
      toolName: z.string(),
      content: z.array(z.union([Text, Image])),
      details: Json.optional(),
      usage: Usage.optional(),
      isError: z.boolean(),
      nestedCalls: z
        .looseObject({
          complete: z.boolean(),
          calls: z.array(
            z.looseObject({
              id: z.string(),
              name: z.string(),
              arguments: JsonObject.optional(),
              argumentsBytes: z.number().optional(),
              status: z.enum(["ok", "error", "unfinished"]),
              durationMs: z.number().optional(),
              error: z.string().optional(),
            }),
          ),
        })
        .optional(),
    }),
  ]),
);
// JSON input contains no explicit undefined values. The schema validates every SDK field;
// this assertion only reconciles Zod optional properties with exactOptionalPropertyTypes.
const parseMessages = (value: unknown): Message[] =>
  Messages.parse(value) as Message[];
export const sdkContextSnapshot = (
  callId: string,
  model: Model<Api>,
  context: TranscriptContext,
  invocation?: SdkInvocation,
): SdkContext => {
  const compat = SdkCompat.safeParse(model.compat ?? {});
  const cost = SdkCost.safeParse(model.cost);
  let jsonCompatible = false;
  let copied: Json[] = [];
  try {
    const messages = context.messages.map((message) =>
      message.role === "system"
        ? {
            ...message,
            ...(message.toolsAdded === undefined
              ? {}
              : { toolsAdded: message.toolsAdded.map(toToolDeclaration) }),
          }
        : message,
    );
    jsonCompatible = Json.array().safeParse(messages).success;
    copied = Json.array().parse(JSON.parse(JSON.stringify(messages)));
  } catch {
    jsonCompatible = false;
  }
  const validated = Messages.safeParse(copied);
  const incompatibleAffinity =
    model.api === "anthropic-messages" &&
    compat.success &&
    compat.data.sessionAffinityFormat !== undefined &&
    compat.data.sessionAffinityFormat !== "openrouter";
  const unavailableReason =
    !compat.success || incompatibleAffinity
      ? "unsupported SDK compatibility metadata"
      : !cost.success
        ? "unsupported SDK pricing metadata"
        : !jsonCompatible || !validated.success
          ? "unsupported SDK message context"
          : undefined;
  const snapshot = SdkContext.parse({
    version: 1,
    sdkPin: RETAINED_SDK_PIN,
    callId,
    stage: "provider-input",
    model: {
      id: model.id,
      provider: model.provider,
      api: model.api,
      reasoning: model.reasoning,
      input: model.input,
      ...(compat.success ? { compat: compat.data } : {}),
      ...(cost.success ? { cost: cost.data } : {}),
    },
    messages: copied,
    ...(invocation === undefined ? {} : { invocation }),
    ...(unavailableReason === undefined ? {} : { unavailableReason }),
  });
  const freeze = (value: unknown): void => {
    if (value !== null && typeof value === "object") {
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
  };
  freeze(snapshot);
  return snapshot;
};

export const sdkInvocationTracker = (callId: string, signal: AbortSignal) => {
  let callbacks = 0;
  let abort: SdkInvocationEnd["abort"] = { status: "not-aborted" };
  const observeAbort = () => {
    const reason: unknown = signal.reason;
    abort = {
      status: "aborted",
      afterCallbacks: callbacks,
      boundary: "unresolved",
      reason:
        typeof reason === "string"
          ? { kind: "string", value: reason }
          : reason instanceof Error
            ? { kind: "error", name: reason.name, message: reason.message }
            : { kind: "unsupported" },
    };
  };
  signal.addEventListener("abort", observeAbort, { once: true });
  if (signal.aborted) observeAbort();
  return {
    onProviderStreamEvent: () => {
      callbacks++;
    },
    finish: (): SdkInvocationEnd => {
      signal.removeEventListener("abort", observeAbort);
      const captured = SdkInvocationEnd.parse({
        version: 1,
        callId,
        callbacks,
        abort,
      });
      Object.freeze(captured.abort);
      if (captured.abort.status === "aborted")
        Object.freeze(captured.abort.reason);
      return Object.freeze(captured);
    },
  };
};

/** Only captured call-specific semantics can resolve custom grammar properties. */
export const retainedContext = (
  call: Call,
  _native: NativeSnapshot,
): RetainedContext => {
  const api =
    call.api === "anthropic-messages" ||
    call.events.some(
      (e) => e.name.startsWith("content_block_") || e.name === "message_start",
    )
      ? "anthropic-messages"
      : "openai-responses";
  const model: RetainedContext["model"] = {
    id: call.model,
    name: call.model,
    api,
    provider: call.provider,
    baseUrl: "https://capture.invalid/v1",
    reasoning: true,
    input: ["text"],
    contextWindow: 1_000_000,
    maxTokens: 1,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  if (call.sdkContext !== undefined) {
    const parsed = SdkContext.safeParse(call.sdkContext);
    if (!parsed.success)
      throw new RetainedContextUnavailable("unsupported captured SDK context");
    const captured = parsed.data;
    const physicalApi =
      call.provider === "anthropic"
        ? "anthropic-messages"
        : call.provider === "openai"
          ? "openai-responses"
          : undefined;
    if (
      captured.callId !== call.callId ||
      captured.model.id !== call.model ||
      captured.model.provider !== (call.logicalRoute ?? call.provider) ||
      (physicalApi !== undefined && captured.model.api !== physicalApi) ||
      captured.model.api !== (call.api ?? model.api) ||
      captured.model.api !== model.api
    )
      throw new RetainedContextUnavailable(
        "SDK context belongs to another call",
      );
    if (captured.unavailableReason !== undefined)
      throw new RetainedContextUnavailable(captured.unavailableReason);
    if (captured.model.cost === undefined || captured.model.input === undefined)
      throw new RetainedContextUnavailable(
        "original SDK model context was not captured",
      );
    if (
      captured.model.api === "anthropic-messages" &&
      captured.model.compat?.sessionAffinityFormat !== undefined &&
      captured.model.compat.sessionAffinityFormat !== "openrouter"
    )
      throw new RetainedContextUnavailable(
        "unsupported Anthropic affinity metadata",
      );
    if (captured.invocation === undefined)
      throw new RetainedContextUnavailable(
        "original SDK invocation options were not captured",
      );
    if (captured.invocation.options.cacheRetention === undefined)
      throw new RetainedContextUnavailable(
        "effective SDK cache retention was not captured",
      );
    if (captured.invocation.api !== captured.model.api)
      throw new RetainedContextUnavailable(
        "SDK invocation belongs to another API",
      );
    if (
      captured.invocation?.api === "anthropic-messages" &&
      captured.invocation.authMode === "unknown"
    )
      throw new RetainedContextUnavailable(
        "original Anthropic authentication semantics were not captured",
      );
    const exactModel = {
      ...model,
      provider: captured.model.provider,
      reasoning: captured.model.reasoning,
      cost: captured.model.cost,
      input: captured.model.input,
      compat: captured.model.compat,
    };
    const context = resolveTranscript(
      normalizeContext({ messages: parseMessages(captured.messages) }),
      captured.model.compat?.supportsMidConvoSystemMessages,
    );
    return {
      model: exactModel as RetainedContext["model"],
      invocation: captured.invocation,
      context,
      grammarToolInputProperties: createGrammarToolInputProperties(
        getDeclaredTools(context.messages),
        captured.model.compat?.supportsOpenAIGrammarTools ?? false,
      ),
    };
  }
  const body = call.body.status === "sent" ? record(call.body.json) : undefined;
  const usesCustom =
    (body !== undefined && custom(body)) ||
    call.events.some(
      (event) => event.name.includes("custom_tool_call") || custom(event.data),
    );
  if (usesCustom)
    throw new RetainedContextUnavailable(
      "original call-specific SDK context was not captured",
    );
  const frames = call.events.filter(
    ({ name }) =>
      name.startsWith("response.") ||
      name === "error" ||
      name.startsWith("message_") ||
      name.startsWith("content_block_"),
  );
  if (
    api !== "openai-responses" ||
    frames.length === 0 ||
    (call.api !== undefined && call.api !== api) ||
    call.logicalRoute !== undefined ||
    call.provider !== "openai" ||
    frames.some(
      ({ name, data }) => !legacyEvents.has(name) || !legacyIndependent(data),
    )
  )
    throw new RetainedContextUnavailable(
      "original SDK context is required for retained output semantics",
    );
  return {
    model,
    invocation: undefined,
    context: normalizeContext({ messages: [] }),
    grammarToolInputProperties: new Map(),
  };
};
