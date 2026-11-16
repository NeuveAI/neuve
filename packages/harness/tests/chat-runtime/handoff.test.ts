import { expect, test } from "bun:test";
import type { Message } from "@earendil-works/pi-ai";
import { handoff } from "../../src/chat-runtime/handoff.ts";
import { usage } from "../../src/chat-runtime/transcript.ts";
import { account, context, fixture, until } from "./fixture.ts";

// Switching after a terminating tool must carry its durable result, without repeating the operation.
test("a different-identity handoff after a tool carries its already-ran result", async () => {
  const run = await fixture({
    accounts: [account(), account("other", "different")],
    execute: async () => ({
      content: [{ type: "text", text: "SIDE_EFFECT_COMPLETED_42" }],
      control: { terminate: true },
    }),
  });
  run.fake.frames.push({
    calls: [{ callId: "completed-call", toolName: "probe", input: { n: 42 } }],
  });
  try {
    await run.submit("perform operation once");
    expect(run.executed).toEqual([42]);
    await until(() => run.fake.opened[0]?.session.closed === 1);
    await run.conversation.configure(
      { model: { provider: "other", modelId: "sonnet" } },
      context,
    );
    run.fake.frames.push({ text: "new account answer" });
    await run.submit("continue after completed tool");
    expect(
      (await run.messages()).some(
        (message) =>
          message.role === "toolResult" &&
          JSON.stringify(message).includes("SIDE_EFFECT_COMPLETED_42"),
      ),
    ).toBe(true);
    expect(run.fake.opened.map(({ account }) => account)).toEqual([
      "subscription",
      "other",
    ]);
    const input = JSON.stringify(run.fake.requests.at(-1)?.input);
    expect(input).toContain("Previous conversation");
    expect(input).toContain("probe already ran. Do not call it again.");
    expect(input).toContain("SIDE_EFFECT_COMPLETED_42");
    expect(input).not.toContain("tool_result");
    expect(input.indexOf("SIDE_EFFECT_COMPLETED_42")).toBeLessThan(
      input.indexOf("continue after completed tool"),
    );
    expect(run.executed).toEqual([42]);
  } finally {
    await run.close();
  }
});

function toolRound(id: string, result: string): Message[] {
  return [
    {
      role: "assistant",
      api: "neuve-runtime",
      provider: "subscription",
      model: "sonnet",
      content: [{ type: "toolCall", id, name: "probe", arguments: {} }],
      usage: usage(),
      stopReason: "toolUse",
      timestamp: 1,
    },
    {
      role: "toolResult",
      toolCallId: id,
      toolName: "probe",
      content: [{ type: "text", text: result }],
      isError: false,
      timestamp: 2,
    },
  ];
}

// Results in older rounds and after the last assistant retain their position in newest-first history.
test("handoff preserves every retained tool result in order before the new message", () => {
  const blocks = handoff([
    ...toolRound("older-call", "older-result"),
    ...toolRound("newer-call", "newer-result"),
    { role: "user", content: "new message", timestamp: 3 },
  ]);
  const text = blocks[0]?.type === "text" ? blocks[0].text : "";
  expect(text).toContain("0 older items left out");
  expect(text.indexOf("newer-result")).toBeLessThan(text.indexOf("newer-call"));
  expect(text.indexOf("newer-call")).toBeLessThan(text.indexOf("older-result"));
  expect(text.indexOf("older-result")).toBeLessThan(text.indexOf("older-call"));
  expect(
    text.match(/probe already ran\. Do not call it again\./g),
  ).toHaveLength(2);
  expect(blocks.at(-1)).toEqual({ type: "text", text: "new message" });
});

// A large omitted result must not leave its smaller call suggesting unfinished work.
test("handoff never retains a call whose completed result exceeds its budget", () => {
  const blocks = handoff(
    [
      ...toolRound("omitted-call", "large-result".repeat(1000)),
      ...toolRound("kept-call", "kept-result"),
      { role: "user", content: "new message", timestamp: 3 },
    ],
    2000,
  );
  const text = blocks[0]?.type === "text" ? blocks[0].text : "";
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(2000);
  expect(text).toContain("2 older items left out");
  expect(text).not.toContain("omitted-call");
  expect(text).not.toContain("large-result");
  expect(text).toContain("kept-call");
  expect(text).toContain("kept-result");
  expect(blocks.at(-1)).toEqual({ type: "text", text: "new message" });
});
