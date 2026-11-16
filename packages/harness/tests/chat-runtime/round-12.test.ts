import { expect, test } from "bun:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
  type Conversation,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { CapturedStorage } from "./captured-storage.ts";
import { context, fixture, until } from "./fixture.ts";

// Recovered tools can create new submissions outside their own conversation, including new children.
for (const kind of ["subagent", "message", "pi-child"] as const) {
  test(`B17: recovered ${kind} work cannot authorize native sends, while a person's child message can`, async () => {
    const storage = new CapturedStorage();
    const source = await fixture({
      storage,
      toolName: kind === "message" ? "message" : "subagent",
      execute: async (_n, _read, signal) => {
        await new Promise<void>((resolve) =>
          signal?.addEventListener("abort", () => resolve(), { once: true }),
        );
        return { content: [{ type: "text", text: "never" }] };
      },
    });
    if (kind === "pi-child") {
      await source.conversation.configure(
        { model: { provider: "faux", modelId: "coder" } },
        context,
      );
      source.faux.setResponses([
        fauxAssistantMessage(
          [
            {
              type: "toolCall",
              id: "c1",
              name: "subagent",
              arguments: { n: 1 },
            },
          ],
          { stopReason: "toolUse" },
        ),
      ]);
    } else
      source.fake.frames.push({
        calls: [
          {
            callId: "c1",
            toolName: kind === "message" ? "message" : "subagent",
            input: { n: 1 },
          },
        ],
      });
    const work = source.submit("delegate this").catch(() => undefined);
    let reopened: Awaited<ReturnType<typeof fixture>> | undefined;
    const target = Promise.withResolvers<Conversation>();
    try {
      await until(() => source.executed.length === 1);
      // Message targets can already exist, unlike the newly created subagent child.
      const existing =
        kind === "message"
          ? await source.harness.createConversation(
              {
                ownership: { kind: "ownerless" },
                agent: {
                  model: { provider: "subscription", modelId: "sonnet" },
                },
              },
              context,
            )
          : undefined;
      const copy = await storage.snapshot();
      await source.close();
      await work;
      const active =
        Promise.withResolvers<Awaited<ReturnType<typeof fixture>>>();
      reopened = await fixture({
        storage: copy,
        toolName: kind === "message" ? "message" : "subagent",
        conversationId: source.conversation.id,
        execute: async (_n, _read, _signal, api) => {
          const run = await active.promise;
          const child = existing
            ? (await run.harness.conversation(existing.id, context))!
            : await api
                .commit(async (tx) => {
                  const record = await tx.createConversation({
                    ownership: { kind: "task", taskId: api.taskId },
                  });
                  return record.id;
                }, context)
                .then((id) => run.harness.conversation(id, context))
                .then((child) => {
                  if (!child) throw new Error("Missing child");
                  return child;
                });
          await child.configure(
            {
              model:
                kind === "pi-child"
                  ? { provider: "faux", modelId: "coder" }
                  : { provider: "subscription", modelId: "sonnet" },
            },
            context,
          );
          target.resolve(child);
          const settled = await (
            await child.submit(
              {
                type: "input",
                content: "automatic tool request",
                requestId: requestId(kind, api),
              },
              context,
            )
          ).wait(context);
          return {
            content: [{ type: "text", text: `child ${settled.status}` }],
          };
        },
      });
      reopened.faux.setResponses([
        fauxAssistantMessage("pi child reply"),
        fauxAssistantMessage("pi parent reply"),
      ]);
      active.resolve(reopened);
      await reopened.harness.waitForIdle(context);
      expect(reopened.fake.opened).toEqual([]);
      expect(reopened.fake.requests).toEqual([]);
      if (kind !== "pi-child") {
        expect(reopened.executed).toEqual([]);
        // A new request by the person may delegate normally after the source was stopped.
        reopened.fake.frames.push(
          {
            calls: [
              {
                callId: "requested",
                toolName: kind === "message" ? "message" : "subagent",
                input: { n: 2 },
              },
            ],
          },
          { text: "child answer" },
          { text: "parent answer" },
        );
        await reopened.submit("person asks to delegate again");
      }
      const child = await target.promise;
      expect(reopened.executed).toEqual(kind === "pi-child" ? [1] : [2]);
      const messages = (await child.context(context)).entries.flatMap(
        (entry) => entry.model ?? [],
      );
      expect(
        messages.findLast((message) => message.role === "assistant")
          ?.stopReason,
      ).toBe("stop");
      if (kind !== "pi-child") {
        // A task-owned chat remains available for the person to continue after recovery.
        reopened.fake.frames.push({ text: "requested child reply" });
        expect(
          (
            await (
              await child.submit(
                { type: "input", content: "person just sent this" },
                context,
              )
            ).wait(context)
          ).status,
        ).toBe("done");
        expect(reopened.fake.requests).toHaveLength(4);
        expect(JSON.stringify(reopened.fake.requests.at(-1)?.input)).toContain(
          "person just sent this",
        );
      }
    } finally {
      await reopened?.close();
      await source.close();
      await work;
    }
  });
}

function requestId(
  kind: "subagent" | "message" | "pi-child",
  api: ToolExecutionApi,
) {
  return kind === "message"
    ? `message:source-channel:${api.taskId}`
    : `subagent:${api.taskId}`;
}
