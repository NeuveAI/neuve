import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { rateInfo } from "./mapping.ts";
import { requestUsage } from "./messages.ts";

const count = z.number().int().nonnegative();
const modelLedger = z.record(
  z.string(),
  z.object({
    inputTokens: count,
    outputTokens: count,
    cacheReadInputTokens: count,
    cacheCreationInputTokens: count,
    cacheCreationEphemeral5mInputTokens: count.optional(),
    cacheCreationEphemeral1hInputTokens: count.optional(),
    thinkingTokens: count.optional(),
  }),
);
const resultFrame = z.object({
  subtype: z.enum([
    "success",
    "error_during_execution",
    "error_max_turns",
    "error_max_budget_usd",
    "error_max_structured_output_retries",
  ]),
  is_error: z.boolean(),
  queued_turn_count: count.optional(),
  modelUsage: modelLedger,
  terminal_reason: z.string().optional(),
  api_error_status: z.number().int().min(100).max(599).nullable().optional(),
});
const contentBlock = z
  .looseObject({ type: z.string() })
  .refine(
    (block) =>
      (block.type !== "text" || typeof block.text === "string") &&
      (block.type !== "tool_use" ||
        (typeof block.name === "string" &&
          typeof block.id === "string" &&
          z.json().safeParse(block.input).success)),
  );
const assistantFrame = z.object({
  uuid: z.string().min(1),
  parent_tool_use_id: z.string().nullable(),
  error: z.string().optional(),
  message: z.object({
    id: z.string().min(1),
    model: z.string().min(1),
    stop_reason: z.string().nullable(),
    content: z.array(contentBlock),
  }),
});
const streamFrame = z.object({
  parent_tool_use_id: z.string().nullable(),
  event: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("message_start"),
      message: z.object({
        id: z.string().min(1),
        model: z.string().min(1),
        stop_reason: z.string().nullable(),
        usage: requestUsage,
      }),
    }),
    z.object({
      type: z.literal("message_delta"),
      delta: z.object({ stop_reason: z.string().nullable() }),
      usage: requestUsage,
    }),
    z.object({ type: z.literal("message_stop") }),
    z.object({ type: z.literal("content_block_stop"), index: count }),
    z.object({
      type: z.literal("content_block_start"),
      index: count,
      content_block: contentBlock,
    }),
    z.object({
      type: z.literal("content_block_delta"),
      index: count,
      delta: z
        .looseObject({ type: z.string() })
        .refine(
          (delta) =>
            (delta.type !== "text_delta" || typeof delta.text === "string") &&
            (delta.type !== "input_json_delta" ||
              typeof delta.partial_json === "string"),
        ),
    }),
  ]),
});
const replyBinding = z.object({
  user_message_uuid: z.string().optional(),
  user_message_uuids: z.array(z.string()).optional(),
});
const consumedTypes = new Set<string>([
  "assistant",
  "user",
  "result",
  "stream_event",
  "system",
  "rate_limit_event",
  "conversation_reset",
]);
export const consumesFrame = (frame: SDKMessage): boolean =>
  consumedTypes.has(frame.type);

/** Validate consumed fields at IPC ingress; other string tags are ignored, including undeclared SDK frames. */
export function validFrame(frame: SDKMessage): boolean {
  if (
    frame === null ||
    typeof frame !== "object" ||
    typeof frame.type !== "string"
  )
    return false;
  if (
    (frame.type === "result" ||
      frame.type === "assistant" ||
      frame.type === "stream_event") &&
    !replyBinding.safeParse(frame).success
  )
    return false;
  if (frame.type === "conversation_reset")
    return z.object({ new_conversation_id: z.string().min(1) }).safeParse(frame)
      .success;
  if (frame.type === "result")
    return (
      resultFrame.safeParse(frame).success &&
      (frame.subtype === "success"
        ? typeof frame.result === "string"
        : z.array(z.string()).safeParse(frame.errors).success)
    );
  if (frame.type === "user")
    return z
      .object({
        parent_tool_use_id: z.string().nullable(),
        uuid: z.string().min(1).optional(),
        // sdk.d.ts:6574,6579: user carriers contain a MessageParam with string or block-array content.
        message: z.object({
          content: z.union([
            z.string(),
            z.array(z.object({ type: z.string() })),
          ]),
        }),
      })
      .safeParse(frame).success;
  if (frame.type === "assistant")
    return assistantFrame.safeParse(frame).success;
  if (frame.type === "stream_event")
    return streamFrame.safeParse(frame).success;
  if (frame.type === "rate_limit_event")
    return z
      .object({
        rate_limit_info: rateInfo,
      })
      .safeParse(frame).success;
  if (frame.type === "system") {
    if (frame.subtype === "api_retry")
      return z
        .object({
          attempt: z.number().int().positive(),
          max_retries: z.number().int().positive(),
          retry_delay_ms: z.number().nonnegative(),
          error_status: z.number().int().min(100).max(599).nullable(),
        })
        .safeParse(frame).success;
    if (frame.subtype === "init") return typeof frame.session_id === "string";
    return true;
  }
  return true;
}

/** Shape-only diagnostics, in validFrame's validation order. Never used by the runtime. */
export function frameShapeIssues(
  frame: SDKMessage,
): readonly { path: string; code: string }[] {
  const issues = (schema: z.ZodType, value: unknown) => {
    const parsed = schema.safeParse(value);
    return parsed.success
      ? []
      : parsed.error.issues.map((issue) => ({
          // Record keys are provider values, unlike schema field names.
          path: issue.path.reduce<string>(
            (path, part, index) =>
              typeof part === "number" ||
              (issue.path[0] === "modelUsage" && index === 1)
                ? `${path}[]`
                : `${path}${path ? "." : ""}${String(part)}`,
            "",
          ),
          code: issue.code,
        }));
  };
  if (
    frame === null ||
    typeof frame !== "object" ||
    typeof frame.type !== "string"
  )
    return issues(z.object({ type: z.string() }), frame);
  if (
    frame.type === "result" ||
    frame.type === "assistant" ||
    frame.type === "stream_event"
  ) {
    const binding = issues(replyBinding, frame);
    if (binding.length > 0) return binding;
  }
  if (frame.type === "conversation_reset")
    return issues(z.object({ new_conversation_id: z.string().min(1) }), frame);
  if (frame.type === "result") {
    const result = issues(resultFrame, frame);
    if (result.length > 0) return result;
    return issues(
      frame.subtype === "success"
        ? z.object({ result: z.string() })
        : z.object({ errors: z.array(z.string()) }),
      frame,
    );
  }
  if (frame.type === "user")
    return issues(
      z.object({
        parent_tool_use_id: z.string().nullable(),
        uuid: z.string().min(1).optional(),
        message: z.object({
          content: z.union([
            z.string(),
            z.array(z.object({ type: z.string() })),
          ]),
        }),
      }),
      frame,
    );
  if (frame.type === "assistant") return issues(assistantFrame, frame);
  if (frame.type === "stream_event") return issues(streamFrame, frame);
  if (frame.type === "rate_limit_event")
    return issues(z.object({ rate_limit_info: rateInfo }), frame);
  if (frame.type === "system") {
    if (frame.subtype === "api_retry")
      return issues(
        z.object({
          attempt: z.number().int().positive(),
          max_retries: z.number().int().positive(),
          retry_delay_ms: z.number().nonnegative(),
          error_status: z.number().int().min(100).max(599).nullable(),
        }),
        frame,
      );
    return frame.subtype === "init"
      ? issues(z.object({ session_id: z.string() }), frame)
      : [];
  }
  return [];
}

// Fixed call-site names are shared with the diagnose logger; no provider values belong here.
export const protocolErrorSite = z.enum([
  "permission-unknown-tool",
  "permission-input-json",
  "tool-input-json",
  "tool-completion-receive",
  "tool-server-protocol",
  "tool-server-create",
  "invalid-frame",
  "valid-frame-throw",
  "init-receive",
  "reset-receive",
  "reply-binding",
  "published-tail-receive",
  "published-frame-ending",
  "retry-without-turn",
  "published-frame-open-turn",
  "message-receive",
  "stream-unknown-tool",
  "assistant-unknown-tool",
  "start-effort-refused",
  "start-pending-protocol",
  "model-effort-refused",
]);
export type ProtocolErrorSite = z.infer<typeof protocolErrorSite>;
// SDK 0.3.316 sdk.d.ts SDKMessage and BetaRawMessageStreamEvent discriminants.
const frameTypes = new Set<string>([
  "assistant",
  "user",
  "result",
  "stream_event",
  "system",
  "rate_limit_event",
  "conversation_reset",
  "auth_status",
  "tool_progress",
  "tool_use_summary",
  "prompt_suggestion",
]);
const systemSubtypes = new Set<string>([
  "init",
  "api_retry",
  "compact_boundary",
  "status",
  "control_request_progress",
  "model_refusal_fallback",
  "model_refusal_no_fallback",
  "local_command_output",
  "hook_started",
  "hook_progress",
  "hook_response",
  "plugin_install",
  "task_notification",
  "task_started",
  "task_updated",
  "task_progress",
  "background_tasks_changed",
  "thinking_tokens",
  "session_state_changed",
  "worker_shutting_down",
  "commands_changed",
  "notification",
  "files_persisted",
  "memory_recall",
  "elicitation_complete",
  "permission_denied",
  "mirror_error",
  "informational",
]);
const resultSubtypes = new Set<string>([
  "success",
  "error_during_execution",
  "error_max_turns",
  "error_max_budget_usd",
  "error_max_structured_output_retries",
]);
const eventTypes = new Set<string>([
  "message_start",
  "message_delta",
  "message_stop",
  "content_block_start",
  "content_block_delta",
  "content_block_stop",
]);
const allowedTag = (value: unknown, allowed: ReadonlySet<string>) =>
  typeof value === "string" && allowed.has(value) ? value : "other";

/** Reads only allowlisted enum tags, including on rejected or throwing IPC frames. */
export function protocolFrameShape(frame: unknown): {
  type: string;
  subtype?: string;
} {
  try {
    if (frame === null || typeof frame !== "object") return { type: "other" };
    const type = allowedTag(
      "type" in frame ? frame.type : undefined,
      frameTypes,
    );
    if (type === "system" || type === "result")
      return {
        type,
        subtype: allowedTag(
          "subtype" in frame ? frame.subtype : undefined,
          type === "system" ? systemSubtypes : resultSubtypes,
        ),
      };
    if (type === "stream_event") {
      const event = "event" in frame ? frame.event : undefined;
      return {
        type,
        subtype: allowedTag(
          event !== null && typeof event === "object" && "type" in event
            ? event.type
            : undefined,
          eventTypes,
        ),
      };
    }
    return { type };
  } catch {
    return { type: "other" };
  }
}
export const protocolErrorLine = (site: ProtocolErrorSite, frame?: unknown) => {
  const { type, subtype } = protocolFrameShape(frame);
  return `claude-runtime protocol-error site=${site} frame=${type}${subtype === undefined ? "" : `/${subtype}`}`;
};
