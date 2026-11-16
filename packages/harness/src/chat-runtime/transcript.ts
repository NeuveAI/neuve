import { createHash } from "node:crypto";
import type {
  AssistantMessage,
  Message,
  ToolResultMessage,
  Tool,
} from "@earendil-works/pi-ai";
import {
  getCurrentSystemPrompt,
  getCurrentTools,
} from "@earendil-works/pi-ai/utils/transcript";
import {
  ContentBlock,
  JsonSchema,
  TurnLimit,
  type ToolCall,
  type ToolDefinition,
  type SessionPolicy,
  type RuntimeEvent,
  type CallUsage,
} from "@neuve/runtime";
import type { Effect } from "effect";

export type Log = (
  event: string,
  fields: Readonly<Record<string, unknown>>,
) => void;
export type Pointer = {
  session: string;
  resumePoint?: string;
  completed?: true;
};
export function pointer(message: Message): Pointer | undefined {
  if (message.role !== "assistant") return;
  const match = /^native:([^:]+):(.*?)(:c)?$/.exec(message.responseId ?? "");
  if (!match?.[1]) return;
  return {
    session: match[1],
    ...(match[2] ? { resumePoint: match[2] } : {}),
    ...(match[2] && match[3] ? { completed: true } : {}),
  };
}
export function responseId(
  session: string,
  resumePoint = "",
  completed = false,
): string {
  return `native:${session}:${resumePoint}${resumePoint && completed ? ":c" : ""}`;
}
export function full(message: Message): boolean {
  return (
    message.role === "assistant" &&
    (message.stopReason === "stop" || message.stopReason === "toolUse") &&
    pointer(message)?.resumePoint !== undefined
  );
}
export function newest(messages: readonly Message[]) {
  const index = messages.findLastIndex(
    (message) => message.role === "assistant",
  );
  const message = messages[index];
  return { index, message, pointer: message ? pointer(message) : undefined };
}
export function checkpoint(messages: readonly Message[], session: string) {
  return messages.findLast(
    (message) => full(message) && pointer(message)?.session === session,
  );
}
export function userContent(messages: readonly Message[]): ContentBlock[] {
  return messages.flatMap((message) => {
    if (message.role !== "user") return [];
    if (typeof message.content === "string")
      return [{ type: "text", text: message.content }];
    return message.content.map((block) => ContentBlock.parse(block));
  });
}
export function resultText(result: ToolResultMessage): string {
  return result.content
    .map((block) =>
      block.type === "text"
        ? block.text
        : "An image was returned and shown in the chat.",
    )
    .join("\n");
}
export function alreadyRan(
  results: readonly ToolResultMessage[],
): ContentBlock[] {
  return results.map((result) => ({
    type: "text",
    text: result.isError
      ? `The ${result.toolName} call returned an error: ${resultText(result)}`
      : `${result.toolName} already ran. Do not call it again. Result:\n${resultText(result)}`,
  }));
}
// Hash model-visible fields only, so copies and pi's JSON publication preserve the digest.
export function digest(messages: readonly Message[]): string {
  const visible = messages.map((message) => {
    switch (message.role) {
      case "assistant":
        return {
          role: message.role,
          content: message.content,
          provider: message.provider,
          model: message.model,
          responseId: message.responseId,
          stopReason: message.stopReason,
        };
      case "toolResult":
        return {
          role: message.role,
          content: message.content,
          toolCallId: message.toolCallId,
          toolName: message.toolName,
          isError: message.isError,
        };
      case "system":
        return {
          role: message.role,
          content: message.content,
          sections: message.sections,
          toolsAdded: message.toolsAdded,
          toolsRemoved: message.toolsRemoved,
        };
      case "user":
        return { role: message.role, content: message.content };
    }
  });
  return createHash("sha256").update(JSON.stringify(visible)).digest("hex");
}
// pi omits failed partials from later requests. They cannot be part of an acknowledged head.
export function headDigest(messages: readonly Message[]): string {
  return digest(
    messages.filter(
      (message) =>
        message.role !== "assistant" ||
        (message.stopReason !== "error" && message.stopReason !== "aborted"),
    ),
  );
}
export function definitions(
  tools: readonly Tool[],
  handle: (
    name: string,
    call: ToolCall | undefined,
  ) => Effect.Effect<import("@neuve/runtime").ToolOutcome>,
): ToolDefinition[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: JsonSchema.parse(tool.parameters),
    strict: false,
    hints: {
      readOnly: false,
      destructive: false,
      idempotent: false,
      openWorld: false,
    },
    handle: (_input, call) => handle(tool.name, call),
  }));
}
export function policy(
  messages: readonly Message[],
  handle: Parameters<typeof definitions>[1],
  model?: SessionPolicy["model"],
): SessionPolicy {
  return {
    systemPrompt: getCurrentSystemPrompt(messages),
    tools: definitions(getCurrentTools(messages), handle),
    approvalPolicy: "allow",
    turnLimit: TurnLimit.parse(Number.MAX_SAFE_INTEGER),
    ...(model ? { model } : {}),
  };
}
export function policyKey(value: SessionPolicy): string {
  return JSON.stringify({
    systemPrompt: value.systemPrompt,
    tools: value.tools.map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    })),
  });
}
export function mirrorCalls(
  event: Extract<RuntimeEvent, { type: "message.finished" }>,
  tools: ReadonlySet<string>,
  log: Log,
): AssistantMessage["content"] {
  return event.toolCalls.flatMap((call) => {
    if (!tools.has(call.toolName)) {
      log("chat-runtime.tool.foreign", { toolName: call.toolName });
      return [];
    }
    // pi validates the raw value, including non-object arguments, at the tool boundary.
    return [
      {
        type: "toolCall",
        id: call.callId,
        name: call.toolName,
        arguments: rawArguments(call.input),
      },
    ];
  });
}
function rawArguments(
  input: unknown,
): import("@earendil-works/pi-ai").JsonObject {
  // The public pi type says object; its validator must see the actual malformed input too.
  return input as import("@earendil-works/pi-ai").JsonObject;
}
export function usage(value?: CallUsage): AssistantMessage["usage"] {
  const input = value?.input ?? 0,
    output = value?.output ?? 0,
    cacheRead = value?.cacheRead ?? 0;
  const cacheWrite = (value?.cacheWrite5m ?? 0) + (value?.cacheWrite1h ?? 0);
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    cacheWrite1h: value?.cacheWrite1h ?? 0,
    ...(value?.thinking === undefined ? {} : { reasoning: value.thinking }),
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}
