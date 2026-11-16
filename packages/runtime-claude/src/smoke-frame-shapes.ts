import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

export const smokeToolName = (name: unknown) =>
  name === "mcp__neuve__note"
    ? "note"
    : name === "mcp__neuve__finish"
      ? "finish"
      : name === "StructuredOutput"
        ? "StructuredOutput"
        : "other";

const tag = (value: unknown) =>
  typeof value === "string" && /^[a-z][a-z0-9_]{0,39}$/.test(value)
    ? value
    : "unrecognized";
const blockShape = (block: unknown) => {
  const fields = block !== null && typeof block === "object" ? block : {};
  const type = "type" in fields ? tag(fields.type) : "unknown";
  return {
    type,
    ...(type === "tool_use"
      ? { tool: smokeToolName("name" in fields ? fields.name : undefined) }
      : {}),
  };
};

/** Only block tags and field presence survive; provider values never enter this result. */
export const toolsFrameShape = (frame: SDKMessage) => {
  if (frame === null || typeof frame !== "object") return {};
  const blocks =
    frame.type === "assistant" && Array.isArray(frame.message?.content)
      ? frame.message.content
      : frame.type === "stream_event" &&
          frame.event?.type === "content_block_start"
        ? [frame.event.content_block]
        : frame.type === "stream_event" &&
            frame.event?.type === "message_start" &&
            Array.isArray(frame.event.message?.content)
          ? frame.event.message.content
          : undefined;
  return {
    ...(blocks === undefined ? {} : { blocks: blocks.map(blockShape) }),
    ...(frame.type !== "user"
      ? {}
      : {
          content:
            typeof frame.message?.content === "string"
              ? "string"
              : Array.isArray(frame.message?.content)
                ? frame.message.content.map((block) => blockShape(block).type)
                : "unknown",
          isReplayPresent: "isReplay" in frame,
          isSyntheticPresent: "isSynthetic" in frame,
          toolUseResultPresent: "tool_use_result" in frame,
          priorityPresent: "priority" in frame,
        }),
  };
};
