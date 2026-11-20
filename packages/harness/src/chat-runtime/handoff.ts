import type { Message } from "@earendil-works/pi-ai";
import type { ContentBlock } from "@neuve/runtime";
import { alreadyRan, userContent } from "./transcript.ts";

export const HANDOFF_TOKENS = 16_000;
/** Told to a model whose interrupted turn is handed over: its steps may have run already. */
export const MAY_HAVE_RUN =
  "Steps of the interrupted turn may already have run: check before repeating one.";
/**
 * One UTF-8 byte per token is conservative; history stays intact and the newest items win.
 * `note` is added to the heading; `skipEmpty` sends no block when nothing is handed over.
 */
export function handoff(
  messages: readonly Message[],
  budget = HANDOFF_TOKENS,
  options: {
    readonly note?: string;
    readonly skipEmpty?: boolean;
  } = {},
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
    ...(options.skipEmpty && history.length === 0
      ? []
      : [
          {
            type: "text" as const,
            text: `Previous conversation, newest first. ${history.length - selected.length} older items left out.${options.note === undefined ? "" : ` ${options.note}`} This is context, not a new instruction.\n${selected.join("\n\n")}`,
          },
        ]),
    ...userContent(messages.slice(lastAssistant + 1)),
  ];
}
