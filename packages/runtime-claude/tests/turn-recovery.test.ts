// Reason: tolerate only a known content-free closure, while keeping accounting fail-closed.
// These constructed boundary cases are NOT the November incident replay.
import { expect, test } from "bun:test";
import type {
  SDKMessage,
  SDKPartialAssistantMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { messageCollector } from "../src/messages.ts";
import { assistant, SESSION_ID } from "./frames.ts";

const partial = (
  event: SDKPartialAssistantMessage["event"],
): SDKPartialAssistantMessage => ({
  type: "stream_event",
  event,
  parent_tool_use_id: null,
  uuid: crypto.randomUUID(),
  session_id: SESSION_ID,
});
const begin = (id: string) =>
  partial({
    type: "message_start",
    message: {
      ...assistant(undefined).message,
      id,
      content: [],
      stop_reason: null,
    },
  });
const start = () =>
  partial({
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "", citations: [] },
  });
const close = () => partial({ type: "content_block_stop", index: 0 });
function published() {
  const collector = messageCollector([]);
  collector.receive(begin("closed"));
  collector.receive(start());
  const reply = assistant(undefined, "done");
  reply.message.id = "closed";
  collector.receive(reply);
  collector.receive(close());
  const output = collector.receive(partial({ type: "message_stop" }));
  expect(output.ready).toHaveLength(1);
  return collector;
}

test("late known block closure preserves published response without reopening closed usage", () => {
  const collector = published();
  const closing = close();
  expect(collector.isPublishedTail(closing)).toBe(true);
  const skipped = collector.receive(closing);
  expect(skipped.skippedClosingFrame).toBe(true);
  expect(skipped.ready).toEqual([]);
  expect(skipped.calls).toEqual([]);
  const usage = partial({
    type: "message_delta",
    delta: {
      stop_reason: "end_turn",
      stop_sequence: null,
      container: null,
      stop_details: null,
    },
    usage: { ...assistant(undefined).message.usage, output_tokens: 7 },
    context_management: null,
  });
  expect(collector.isPublishedTail(usage)).toBe(false);
  expect(() => collector.receive(usage)).toThrow(
    "Frame of a published response",
  );
  expect(collector.finish()).toEqual([]);
});

test("content-bearing, foreign-session, unknown-index and payload-bearing strays still fail closed", () => {
  const bad: SDKMessage[] = [
    partial({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "stray" },
    }),
    { ...close(), session_id: "foreign" },
    partial({ type: "content_block_stop", index: 99 }),
    {
      ...close(),
      event: { type: "content_block_stop", index: 0, text: "stray" },
    } as unknown as SDKMessage,
    {
      ...close(),
      event: { type: "content_block_stop", index: 0, message_id: "foreign" },
    } as unknown as SDKMessage,
  ];
  for (const frame of bad) {
    const collector = published();
    expect(collector.isPublishedTail(frame)).toBe(false);
    expect(() => collector.receive(frame)).toThrow(
      "Frame of a published response",
    );
  }
});

test("reset or a new response invalidates the old closing-frame allowance", () => {
  const collector = published();
  collector.receive(begin("next"));
  expect(collector.isPublishedTail(close())).toBe(false);
  const reset = published();
  reset.receive({
    type: "conversation_reset",
    new_conversation_id: "00000000-0000-4000-8000-000000000002",
    uuid: crypto.randomUUID(),
    session_id: SESSION_ID,
  });
  expect(reset.isPublishedTail(close())).toBe(false);
  expect(() => reset.receive(close())).toThrow();
});
