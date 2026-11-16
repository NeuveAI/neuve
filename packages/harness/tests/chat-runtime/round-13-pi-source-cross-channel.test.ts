// Regression reason: A recovered pi message must preserve its target gate even across independent task-id stores.
import { expect, test } from "bun:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { CapturedStorage } from "./captured-storage.ts";
import { context, fixture, until } from "./fixture.ts";

// Ruling 28: a re-run `message` tool reaching another chat is automatic and releases nothing.
// The attach-time abort covers only loop-owning sources. A pi-account source keeps pi's
// behaviour, so its recovered `message` tool runs again and delivers
// `message:<source channel>:<source task>` to another channel's separate Harness, whose gate
// has never seen that task. Within one Harness the same submission is gated (control below).

type Run = Awaited<ReturnType<typeof fixture>>;
const taskIds: string[] = [];
const OFFSET = Number(process.env.OFFSET ?? 1000);

async function piSourceMidMessage() {
  const storage = new CapturedStorage();
  const source = await fixture({
    storage,
    toolName: "message",
    execute: async (_n, _read, signal) => {
      await new Promise<void>((resolve) =>
        signal?.addEventListener("abort", () => resolve(), { once: true }),
      );
      return { content: [{ type: "text", text: "old" }] };
    },
  });
  await source.conversation.configure(
    { model: { provider: "faux", modelId: "coder" } },
    context,
  );
  source.faux.setResponses([
    fauxAssistantMessage(
      [{ type: "toolCall", id: "m1", name: "message", arguments: { n: 1 } }],
      { stopReason: "toolUse" },
    ),
  ]);
  const work = source
    .submit("person: tell the other channel")
    .catch(() => undefined);
  await until(() => source.executed.length === 1);
  const copy = await storage.snapshot();
  await source.close();
  await work;
  return { source, copy };
}

// A Claude chat in its own channel, restarted with its own in-flight tool: gated at attach.
async function gatedClaudeTarget() {
  const storage = new CapturedStorage();
  const target = await fixture({
    storage,
    execute: async (_n, _read, signal) => {
      await new Promise<void>((resolve) =>
        signal?.addEventListener("abort", () => resolve(), { once: true }),
      );
      return { content: [{ type: "text", text: "old" }] };
    },
  });
  target.fake.frames.push({
    calls: [{ callId: "t1", toolName: "probe", input: { n: 1 } }],
  });
  const work = target.submit("person: target request").catch(() => undefined);
  await until(() => target.executed.length === 1);
  const copy = await storage.snapshot();
  await target.close();
  await work;
  const reopened = await fixture({
    storage: copy,
    conversationId: target.conversation.id,
  });
  await reopened.harness.waitForIdle(context);
  expect(reopened.fake.requests).toEqual([]);
  return reopened;
}

test("cross-channel: a pi source's recovered message tool must not release a gated Claude chat", async () => {
  const { source, copy } = await piSourceMidMessage();
  const target = await gatedClaudeTarget();
  let reopened: Run | undefined;
  try {
    target.fake.frames.push({ text: "unrequested target answer" });
    reopened = await fixture({
      storage: copy,
      conversationId: source.conversation.id,
      toolName: "message",
      execute: async (n, _read, _signal, api) => {
        // directory.deliver -> target channel's #admit with the tool's request ID. Task IDs are
        // per-store integers; offset this one so it does not collide with a recovered task id
        // in the target's own store (a source channel with longer history).
        taskIds.push(String(api.taskId));
        await (
          await target.conversation.submit(
            {
              type: "input",
              content: "agent@source: automatic recovered message",
              requestId: `message:source-channel:${Number(api.taskId) + OFFSET}`,
            },
            context,
          )
        ).wait(context);
        return { content: [{ type: "text", text: `delivered ${n}` }] };
      },
    });
    reopened.faux.setResponses([fauxAssistantMessage("pi parent reply")]);
    await reopened.harness.waitForIdle(context);
    await target.harness.waitForIdle(context);

    expect(reopened.executed).toEqual([1]); // pi behaviour: the pi tool re-runs
    expect(target.fake.opened.map((o) => o.start.kind)).toEqual([]);
    expect(target.fake.requests).toHaveLength(0);
  } finally {
    await reopened?.close();
    await target.close();
    await source.close();
  }
});

test("same channel control: the identical submission into a Claude chat of the source's Harness stays gated", async () => {
  const { source, copy } = await piSourceMidMessage();
  let reopened: Run | undefined;
  try {
    let claudeChat: import("@earendil-works/pi-durable").Conversation;
    reopened = await fixture({
      storage: copy,
      conversationId: source.conversation.id,
      toolName: "message",
      execute: async (n, _read, _signal, api) => {
        const run = await ready.promise;
        claudeChat = await run.harness.createConversation(
          {
            ownership: { kind: "ownerless" },
            agent: { model: { provider: "subscription", modelId: "sonnet" } },
          },
          context,
        );
        await (
          await claudeChat.submit(
            {
              type: "input",
              content: "agent@source: automatic recovered message",
              requestId: `message:source-channel:${api.taskId}`,
            },
            context,
          )
        ).wait(context);
        return { content: [{ type: "text", text: `delivered ${n}` }] };
      },
    });
    ready.resolve(reopened);
    reopened.fake.frames.push({ text: "unrequested" });
    reopened.faux.setResponses([fauxAssistantMessage("pi parent reply")]);
    await reopened.harness.waitForIdle(context);
    expect(reopened.executed).toEqual([1]);
    expect(reopened.fake.opened).toEqual([]);
    expect(reopened.fake.requests).toEqual([]);
  } finally {
    await reopened?.close();
    await source.close();
  }
});
const ready = Promise.withResolvers<Run>();
