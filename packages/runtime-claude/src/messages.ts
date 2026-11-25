import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { CallUsage, RuntimeEvent, ToolDefinition } from "@neuve/runtime";
import { z } from "zod";
import { zeroUsage } from "./mapping.ts";

/** Claude Code resumes inside a turn, so every message it reports names its resume point. */
type Finished = Extract<RuntimeEvent, { type: "message.finished" }> & {
  readonly resumePoint: string;
};
type Call = Finished["toolCalls"][number];
export const requestUsage = z.object({
  input_tokens: z.number().int().nonnegative().nullish(),
  output_tokens: z.number().int().nonnegative().nullish(),
  cache_read_input_tokens: z.number().int().nonnegative().nullish(),
  cache_creation_input_tokens: z.number().int().nonnegative().nullish(),
  cache_creation: z
    .object({
      ephemeral_5m_input_tokens: z.number().int().nonnegative(),
      ephemeral_1h_input_tokens: z.number().int().nonnegative(),
    })
    .nullish(),
  output_tokens_details: z
    .object({ thinking_tokens: z.number().int().nonnegative() })
    .nullish(),
});
const closingBlock = z.strictObject({
  type: z.literal("content_block_stop"),
  index: z.number().int().nonnegative(),
});
// The exceptional skip accepts only SDK closing-frame metadata, never additional payload fields.
const closingBlockFrame = z.strictObject({
  type: z.literal("stream_event"),
  event: closingBlock,
  parent_tool_use_id: z.null(),
  uuid: z.string().optional(),
  session_id: z.string().min(1),
  ttft_ms: z.number().nonnegative().optional(),
  user_message_uuid: z.string().optional(),
  user_message_uuids: z.array(z.string()).optional(),
  resume_reason: z.string().optional(),
});
const closingMessage = z.strictObject({ type: z.literal("message_stop") });
const stopReason = (reason: string | null): Finished["stopReason"] => {
  switch (reason) {
    case "end_turn":
      return "end-turn";
    case "tool_use":
      return "tool-use";
    case "max_tokens":
      return "max-tokens";
    case "refusal":
      return "refusal";
    default:
      return "other";
  }
};
interface Message {
  id: string;
  model: string;
  uuid?: string;
  reason: string | null;
  usage: CallUsage;
  streamUsage: boolean;
  complete: boolean;
  session: string;
  streamed: boolean;
  blockIndices: Set<number>;
  calls: Map<string, Call>;
}
/** Root responses span per-block assistant frames (sdk.d.ts:3709). */
export function messageCollector(tools: ReadonlyArray<ToolDefinition>) {
  let current: Message | undefined;
  let latestMessageId: string | undefined;
  let streamOpen = false;
  let streamInvalidated = false;
  let publishedStream: Message | undefined;
  let closedStream: Message | undefined;
  let conversationId: string | undefined;
  const blocks = new Map<
    number,
    { id: string; name: string; json: string; input: unknown }
  >();
  const started = new Set<string>();
  const emitted = new Set<string>();
  const ready: Message[] = [];
  const takeReady = () => ready.splice(0);
  const collected = (
    calls: Call[],
    completed: number,
    usageUpdates: { model: string; delta: CallUsage }[] = [],
    skippedClosingFrame = false,
  ) => ({
    calls,
    completed,
    ready: takeReady(),
    usageUpdates,
    skippedClosingFrame,
  });
  const publish = () => {
    if (current?.complete && !emitted.has(current.id)) {
      if (current.uuid === undefined) {
        current = undefined;
        throw new Error("Missing completed message chain UUID");
      }
      emitted.add(current.id);
      ready.push(current);
      if (current.streamed && !streamInvalidated) {
        if (streamOpen) publishedStream = current;
        else closedStream = current;
      }
    }
  };
  const stash = () => {
    publish();
    current = undefined;
    blocks.clear();
  };
  const call = (id: string, name: string, input: unknown): Call | undefined => {
    const tool = tools.find((tool) => `mcp__neuve__${tool.name}` === name);
    if (tool === undefined || current === undefined) return;
    const value = {
      callId: id,
      toolName: tool.name,
      input: z.json().parse(input),
    };
    current.calls.set(id, value);
    if (started.has(id)) return;
    started.add(id);
    return value;
  };
  const updateUsage = (value: unknown, message = current) => {
    if (message === undefined) return;
    const usage = requestUsage.parse(value);
    const previous = message.usage;
    const cacheWrite1h =
      usage.cache_creation?.ephemeral_1h_input_tokens ??
      (usage.cache_creation_input_tokens != null &&
      usage.cache_creation_input_tokens < previous.cacheWrite1h
        ? 0
        : previous.cacheWrite1h);
    message.usage = {
      input: usage.input_tokens ?? previous.input,
      output: usage.output_tokens ?? previous.output,
      cacheRead: usage.cache_read_input_tokens ?? previous.cacheRead,
      cacheWrite5m:
        usage.cache_creation?.ephemeral_5m_input_tokens ??
        (usage.cache_creation_input_tokens == null
          ? previous.cacheWrite5m
          : usage.cache_creation_input_tokens - cacheWrite1h),
      cacheWrite1h,
      ...(usage.output_tokens_details == null
        ? previous.thinking === undefined
          ? {}
          : { thinking: previous.thinking }
        : { thinking: usage.output_tokens_details.thinking_tokens }),
    };
  };
  const isPublishedFrame = (frame: SDKMessage) => {
    if (frame.type === "assistant" && frame.parent_tool_use_id === null)
      return (
        emitted.has(frame.message.id) ||
        (streamInvalidated && frame.message.id === current?.id)
      );
    if (frame.type !== "stream_event" || frame.parent_tool_use_id !== null)
      return false;
    return frame.event.type === "message_start"
      ? emitted.has(frame.event.message.id) ||
          (streamInvalidated && frame.event.message.id === current?.id)
      : streamInvalidated ||
          (latestMessageId !== undefined && emitted.has(latestMessageId));
  };
  const publishedTail = (frame: SDKMessage): Message | undefined => {
    if (
      frame.type !== "stream_event" ||
      frame.parent_tool_use_id !== null ||
      streamInvalidated
    )
      return;
    const message = publishedStream ?? closedStream;
    if (
      message === undefined ||
      message.id !== latestMessageId ||
      frame.session_id !== message.session
    )
      return;
    // After message_stop only a known, content-free block closure is harmless.
    // Usage and message-stop tails retain their existing open-stream ordering rule.
    if (
      frame.event.type === "content_block_stop" &&
      message.blockIndices.has(frame.event.index) &&
      closingBlockFrame.safeParse(frame).success
    )
      return message;
    if (
      publishedStream !== undefined &&
      (frame.event.type === "message_delta" ||
        (frame.event.type === "message_stop" &&
          closingMessage.safeParse(frame.event).success))
    )
      return message;
  };
  const isPublishedTail = (frame: SDKMessage) =>
    publishedTail(frame) !== undefined;
  return {
    isPublishedFrame,
    isPublishedTail,
    isFurtherOutput(frame: SDKMessage) {
      return (
        (frame.type === "assistant" &&
          frame.parent_tool_use_id === null &&
          frame.message.id !== current?.id) ||
        (frame.type === "stream_event" &&
          frame.parent_tool_use_id === null &&
          (frame.event.type === "message_start" ||
            frame.event.type === "content_block_start" ||
            frame.event.type === "content_block_delta"))
      );
    },
    receive(frame: SDKMessage) {
      if (frame.type === "conversation_reset") {
        publishedStream = undefined;
        closedStream = undefined;
        streamInvalidated = latestMessageId !== undefined;
        conversationId = frame.new_conversation_id;
        return collected([], 0);
      }
      if (frame.type === "system" && frame.subtype === "init") {
        if (
          conversationId !== undefined &&
          conversationId !== frame.session_id
        ) {
          publishedStream = undefined;
          closedStream = undefined;
          streamInvalidated = latestMessageId !== undefined;
        }
        conversationId = frame.session_id;
        return collected([], 0);
      }
      if (frame.type === "assistant" || frame.type === "stream_event")
        conversationId ??= frame.session_id;
      const tail = publishedTail(frame);
      if (tail !== undefined && frame.type === "stream_event") {
        const message = tail;
        if (frame.event.type === "message_delta") {
          const before = message.usage;
          message.streamUsage = true;
          message.reason = frame.event.delta.stop_reason ?? message.reason;
          updateUsage(frame.event.usage, message);
          const after = message.usage;
          return collected([], 0, [
            {
              model: message.model,
              delta: {
                input: after.input - before.input,
                output: after.output - before.output,
                cacheRead: after.cacheRead - before.cacheRead,
                cacheWrite5m: after.cacheWrite5m - before.cacheWrite5m,
                cacheWrite1h: after.cacheWrite1h - before.cacheWrite1h,
                ...(after.thinking === undefined
                  ? {}
                  : {
                      thinking: after.thinking - (before.thinking ?? 0),
                    }),
              },
            },
          ]);
        }
        if (frame.event.type === "content_block_stop") {
          blocks.delete(frame.event.index);
          return collected([], 0, [], true);
        }
        if (frame.event.type === "message_stop") {
          streamOpen = false;
          closedStream = message;
          publishedStream = undefined;
        }
        return collected([], 0);
      }
      if (isPublishedFrame(frame))
        throw new Error("Frame of a published response");
      const calls: Call[] = [];
      let completed = 0;
      if (frame.type === "assistant" && frame.parent_tool_use_id === null) {
        if (current?.id !== frame.message.id) {
          stash();
          publishedStream = undefined;
          closedStream = undefined;
          streamOpen = false;
          streamInvalidated = false;
          latestMessageId = frame.message.id;
          current = {
            id: frame.message.id,
            model: frame.message.model,
            reason: frame.message.stop_reason,
            usage: zeroUsage(),
            streamUsage: false,
            complete: false,
            session: frame.session_id,
            streamed: false,
            blockIndices: new Set(),
            calls: new Map(),
          };
        }
        current.uuid = frame.uuid;
        current.model = frame.message.model;
        current.reason = frame.message.stop_reason ?? current.reason;
        if (!current.streamUsage) {
          current.usage = zeroUsage();
          updateUsage(frame.message.usage);
        }
        for (const block of frame.message.content) {
          if (block.type === "tool_use") {
            const value = call(block.id, block.name, block.input);
            if (value !== undefined) calls.push(value);
          }
        }
        // Older/non-streamed producers deliver the complete assistant response at once.
        if (
          !streamOpen &&
          frame.message.stop_reason !== null &&
          !current.complete
        ) {
          current.complete = true;
          completed++;
        }
      } else if (
        frame.type === "stream_event" &&
        frame.parent_tool_use_id === null
      ) {
        const event = frame.event;
        if (event.type === "content_block_start" && current !== undefined)
          current.blockIndices.add(event.index);
        if (event.type === "message_start") {
          if (current?.id === event.message.id)
            return collected(calls, completed);
          stash();
          publishedStream = undefined;
          closedStream = undefined;
          streamOpen = true;
          streamInvalidated = false;
          latestMessageId = event.message.id;
          current = {
            id: event.message.id,
            model: event.message.model,
            reason: event.message.stop_reason,
            usage: zeroUsage(),
            streamUsage: true,
            complete: false,
            session: frame.session_id,
            streamed: true,
            blockIndices: new Set(),
            calls: new Map(),
          };
          updateUsage(event.message.usage);
        } else if (event.type === "message_delta" && current !== undefined) {
          current.streamUsage = true;
          current.reason = event.delta.stop_reason ?? current.reason;
          updateUsage(event.usage);
        } else if (
          event.type === "content_block_start" &&
          event.content_block.type === "tool_use"
        ) {
          const block = event.content_block;
          blocks.set(event.index, {
            id: block.id,
            name: block.name,
            json: "",
            input: block.input,
          });
        } else if (
          event.type === "content_block_delta" &&
          event.delta.type === "input_json_delta"
        ) {
          const block = blocks.get(event.index);
          if (block !== undefined) block.json += event.delta.partial_json;
        } else if (event.type === "content_block_stop") {
          const block = blocks.get(event.index);
          if (block !== undefined) {
            const value = call(
              block.id,
              block.name,
              block.json ? JSON.parse(block.json) : block.input,
            );
            if (value !== undefined) calls.push(value);
            blocks.delete(event.index);
          }
        } else if (event.type === "message_stop" && current !== undefined) {
          streamOpen = false;
          if (!current.complete) {
            current.complete = true;
            completed++;
          }
          publish();
        }
      } else if (frame.type === "result") {
        if (current !== undefined) current.complete = true;
        stash();
      }
      return collected(calls, completed);
    },
    completeForTool(callId: string) {
      let completed = 0;
      if (!streamOpen && current?.calls.has(callId)) {
        if (!current.complete) {
          current.complete = true;
          completed++;
        }
        current.reason ??= "tool_use";
        publish();
      }
      return collected([], completed);
    },
    finish() {
      if (current?.uuid === undefined) current = undefined;
      stash();
      return takeReady();
    },
    event(message: Message, turnId: string, at: string): Finished {
      if (message.uuid === undefined)
        throw new Error("Missing completed message chain UUID");
      return {
        type: "message.finished",
        turnId,
        at,
        messageId: message.id,
        resumePoint: message.uuid,
        model: message.model,
        stopReason: stopReason(message.reason),
        toolCalls: [...message.calls.values()],
        usage: message.usage,
      };
    },
  };
}
