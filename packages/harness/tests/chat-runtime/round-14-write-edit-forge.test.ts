import { expect, test } from "bun:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { CapturedStorage } from "./captured-storage.ts";
import { context, fixture, until } from "./fixture.ts";

// A write submission must not impersonate a direct person edit and release a held gate.
for (const kind of ["control", "write-edit"] as const) {
  test(`recovered pi tool, ${kind}: no native request on the gated target`, async () => {
    const storage = new CapturedStorage();
    const source = await fixture({
      storage,
      execute: async (_n, _read, signal) => {
        await new Promise<void>((resolve) =>
          signal?.addEventListener("abort", () => resolve(), { once: true }),
        );
        return { content: [{ type: "text", text: "old result" }] };
      },
    });
    await source.conversation.configure(
      { model: { provider: "faux", modelId: "coder" } },
      context,
    );
    source.faux.setResponses([
      fauxAssistantMessage(
        [
          {
            type: "toolCall",
            id: "source-call",
            name: "probe",
            arguments: { n: 1 },
          },
        ],
        { stopReason: "toolUse" },
      ),
    ]);
    const sourceWork = source
      .submit("original pi request")
      .catch(() => undefined);
    let targetWork: Promise<unknown> | undefined;
    let reopened: Awaited<ReturnType<typeof fixture>> | undefined;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    try {
      await until(() => source.executed.length === 1);
      const target = await source.harness.createConversation(
        {
          ownership: { kind: "ownerless" },
          agent: { model: { provider: "subscription", modelId: "sonnet" } },
        },
        context,
      );
      source.fake.frames.push({
        calls: [{ callId: "target-call", toolName: "probe", input: { n: 2 } }],
      });
      targetWork = (async () =>
        (
          await target.submit(
            { type: "input", content: "person: original target request" },
            context,
          )
        ).wait(context))().catch(() => undefined);
      await until(() => source.executed.length === 2);
      const copy = await storage.snapshot();
      await source.close();
      await sourceWork;
      await targetWork;
      reopened = await fixture({
        storage: copy,
        conversationId: source.conversation.id,
        execute: async (n, _read, _signal, api) => {
          if (n !== 1)
            return { content: [{ type: "text", text: "target result" }] };
          entered.resolve();
          await release.promise;
          const to = (await api.conversation(target.id, context))!;
          if (kind === "write-edit")
            await to.submit(
              {
                type: "write",
                entry: {
                  kind: "ace.edit",
                  data: {
                    author: "tool",
                    target: 0,
                    text: "tool rewrite",
                    at: 0,
                  },
                },
              } as never,
              context,
            );
          await (
            await to.submit(
              {
                type: "input",
                content: "automatic recovered message",
                requestId: `message:source:${api.taskId}`,
              },
              context,
            )
          ).wait(context);
          return { content: [{ type: "text", text: "message sent" }] };
        },
      });
      reopened.faux.setResponses([fauxAssistantMessage("pi parent completed")]);
      reopened.fake.frames.push({ text: "unrequested target response" });
      const idle = reopened.harness.waitForIdle(context);
      await entered.promise;
      await until(async () => {
        const to = (await reopened!.harness.conversation(target.id, context))!;
        return (await to.context(context)).entries.some((e) =>
          e.model?.some(
            (m) => m.role === "assistant" && m.stopReason === "aborted",
          ),
        );
      });
      expect(reopened.fake.requests).toHaveLength(0);
      release.resolve();
      await idle;
      const to = (await reopened.harness.conversation(target.id, context))!;
      const edits = (await to.context(context)).entries.filter(
        (e) => e.kind === "ace.edit",
      );
      if (kind === "write-edit") {
        expect(edits).toHaveLength(1);
        expect(edits[0]!.byTaskId).toBeUndefined();
      }
      expect(reopened.fake.requests).toHaveLength(0);
    } finally {
      release.resolve();
      await reopened?.close();
      await source.close();
      await sourceWork;
      await targetWork;
    }
  });
}
