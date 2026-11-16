// Regression reason: Review notifications and recovered foreign pi messages must preserve the target gate after ruling 28b aborts its unlisted probe.
import { expect, test } from "bun:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { CapturedStorage } from "./captured-storage.ts";
import { context, fixture, until } from "./fixture.ts";
async function held(signal: AbortSignal | undefined) {
  await new Promise<void>((resolve) =>
    signal?.addEventListener("abort", () => resolve(), { once: true }),
  );
  return { content: [{ type: "text" as const, text: "old result" }] };
}
for (const kind of ["review", "foreign-message"] as const) {
  test(`automatic ${kind} does not release a gated subscription chat`, async () => {
    const storage = new CapturedStorage();
    const source = await fixture({
      storage,
      execute: (_n, _read, signal) => held(signal),
    });
    source.fake.frames.push({
      calls: [{ callId: "target-call", toolName: "probe", input: { n: 1 } }],
    });
    const work = source.submit("original request").catch(() => undefined);
    let target: Awaited<ReturnType<typeof fixture>> | undefined;
    let foreign: Awaited<ReturnType<typeof fixture>> | undefined;
    let restored: Awaited<ReturnType<typeof fixture>> | undefined;
    let foreignWork: Promise<unknown> | undefined;
    const resume = Promise.withResolvers<void>();
    try {
      await until(() => source.executed.length === 1);
      const copy = await storage.snapshot();
      await source.close();
      await work;
      target = await fixture({
        storage: copy,
        conversationId: source.conversation.id,
      });
      await target.harness.waitForIdle(context);
      expect(target.executed).toEqual([]);
      expect(JSON.stringify(await target.messages())).toContain(
        "Tool probe was aborted",
      );
      target.fake.frames.push({ text: "unrequested response" });
      if (kind === "review") {
        await (
          await target.conversation.submit(
            {
              type: "input",
              whenBusy: "followUp",
              requestId: "neuve.review:review-1:terminal:notice-1",
              content:
                "[Neuve system note] Review review-1 is completed. Point the person at the review card without summarizing findings. Completing a review does not approve the change.",
            },
            context,
          )
        ).wait(context);
      } else {
        const foreignStorage = new CapturedStorage();
        foreign = await fixture({
          storage: foreignStorage,
          execute: (_n, _read, signal) => held(signal),
        });
        await foreign.conversation.configure(
          { model: { provider: "faux", modelId: "coder" } },
          context,
        );
        for (let i = 0; i < 5; i++) {
          foreign.faux.setResponses([fauxAssistantMessage("pi warmup")]);
          await foreign.submit(`warmup ${i}`);
        }
        foreign.faux.setResponses([
          fauxAssistantMessage(
            [
              {
                type: "toolCall",
                id: "foreign-call",
                name: "probe",
                arguments: { n: 1 },
              },
            ],
            { stopReason: "toolUse" },
          ),
        ]);
        foreignWork = foreign
          .submit("original pi source request")
          .catch(() => undefined);
        await until(() => foreign!.executed.length === 1);
        const foreignCopy = await foreignStorage.snapshot();
        await foreign.close();
        await foreignWork;
        const destination = target;
        restored = await fixture({
          storage: foreignCopy,
          conversationId: foreign.conversation.id,
          execute: async (_n, _read, _signal, api) => {
            await resume.promise;
            const view = await destination.harness.inspect(context);

            await (
              await destination.conversation.submit(
                {
                  type: "input",
                  content: "automatic recovered cross-channel message",
                  requestId: `message:foreign-channel:${api.taskId}`,
                },
                context,
              )
            ).wait(context);
            return { content: [{ type: "text", text: "delivered" }] };
          },
        });
        restored.faux.setResponses([fauxAssistantMessage("source complete")]);
        resume.resolve();
        await restored.harness.waitForIdle(context);
      }

      expect(target.fake.requests).toHaveLength(0);
    } finally {
      resume.resolve();
      await restored?.close();
      await foreign?.close();
      await target?.close();
      await source.close();
      await work;
      await foreignWork;
    }
  });
}
