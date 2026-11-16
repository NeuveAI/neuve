// Regression reason: ToolExecutionApi.commit must not impersonate a person through an edit or question answer.
import { expect, test } from "bun:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Questions, QuestionsDoc } from "../../../channel/src/questions.ts";
import { CapturedStorage } from "./captured-storage.ts";
import { context, fixture, until } from "./fixture.ts";

for (const kind of ["control", "edit", "answer"] as const) {
  test(`recovered pi tool writing ${kind} does not release its subscription target`, async () => {
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
    source.pi.install(new Questions(() => {}).extension);
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
            { type: "input", content: "original target request" },
            context,
          )
        ).wait(context))().catch(() => undefined);
      await until(() => source.executed.length === 2);
      await source.harness.commit(async (tx) => {
        const doc = await tx.doc(QuestionsDoc, target.id);
        doc.questions["pending"] = {
          items: [
            {
              header: "Choice",
              question: "Which?",
              options: [{ label: "A", description: "A" }],
              multiple: false,
            },
          ],
        };
      }, context);
      const copy = await storage.snapshot();
      await source.close();
      await sourceWork;
      await targetWork;
      const active =
        Promise.withResolvers<Awaited<ReturnType<typeof fixture>>>();
      reopened = await fixture({
        storage: copy,
        conversationId: source.conversation.id,
        execute: async (_n, _read, _signal, api) => {
          if (_n !== 1)
            return { content: [{ type: "text", text: "target result" }] };
          entered.resolve();
          await release.promise;
          if (kind === "edit")
            await api.commit(
              (tx) =>
                tx.appendEntry(target.id, {
                  kind: "ace.edit",
                  data: {
                    author: "tool",
                    target: 0,
                    text: "tool rewrite",
                    at: 0,
                  },
                }),
              context,
            );
          if (kind === "answer")
            await api.commit(async (tx) => {
              const doc = await tx.doc(QuestionsDoc, target.id);
              doc.questions["pending"]!.answer = {
                author: "tool",
                at: 0,
                answers: [{ question: "Which?", choices: ["A"] }],
              };
            }, context);
          const run = await active.promise;
          const to = (await run.harness.conversation(target.id, context))!;
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
      reopened.pi.install(new Questions(() => {}).extension);
      reopened.faux.setResponses([fauxAssistantMessage("pi parent completed")]);
      reopened.fake.frames.push({ text: "unrequested target response" });
      active.resolve(reopened);
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
      release.resolve();
      await idle;

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
