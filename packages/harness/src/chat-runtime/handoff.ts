import type { Message } from "@earendil-works/pi-ai";
import type { ContentBlock } from "@neuve/runtime";
import { alreadyRan, userContent } from "./transcript.ts";

export const HANDOFF_TOKENS = 16_000;
/** One UTF-8 byte per token is conservative; history stays intact and the newest items win. */
export function handoff(
  messages: readonly Message[],
  budget = HANDOFF_TOKENS,
): ContentBlock[] {
  const lastAssistant = messages.findLastIndex(
    (message) => message.role === "assistant",
  );
  const history = messages.filter(
    (message, index) =>
      message.role !== "system" &&
      (index <= lastAssistant || message.role === "toolResult"),
  );
  const selected: string[] = [];
  const omittedResults = new Set<string>();
  let remaining = Math.max(0, budget - 256);
  for (const message of history.toReversed()) {
    if (
      message.role === "assistant" &&
      message.content.some(
        (block) => block.type === "toolCall" && omittedResults.has(block.id),
      )
    )
      continue;
    const item = JSON.stringify(
      message.role === "toolResult" ? alreadyRan([message])[0] : message,
    );
    const bytes = Buffer.byteLength(item) + 2;
    if (bytes > remaining) {
      if (message.role === "toolResult") omittedResults.add(message.toolCallId);
      continue;
    }
    remaining -= bytes;
    selected.push(item);
  }
  return [
    {
      type: "text",
      text: `Previous conversation, newest first. ${history.length - selected.length} older items left out. This is context, not a new instruction.\n${selected.join("\n\n")}`,
    },
    ...userContent(messages.slice(lastAssistant + 1)),
  ];
}
