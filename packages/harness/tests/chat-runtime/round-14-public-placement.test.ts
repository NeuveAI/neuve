import { expect, test } from "bun:test";
import { account, fixture } from "./fixture.ts";
// The public request boundary must preserve both person release and agent rejection.
for (const delayed of [false, true])
  for (const author of ["person", "agent@source"]) {
    test(`Channel.handle ask ${author}, delayed=${delayed}: preserves input origin and delivery`, async () => {
      const { Channel } = await import("@ace/channel");
      const { chatRuntimeExtension } =
        await import("../../src/chat-runtime/index.ts");
      const { Questions, QuestionsDoc } =
        await import("../../../channel/src/questions.ts");
      const { CapturedStorage } = await import("./captured-storage.ts");
      const { context, until } = await import("./fixture.ts");
      const { LiveDoc } = await import("@earendil-works/pi-durable");
      const { NodeExecutionEnv } =
        await import("@earendil-works/pi-durable/env/node");
      const storage = new CapturedStorage();
      const source = await fixture({ storage });
      source.pi.install(new Questions(() => {}).extension);
      source.fake.frames.push({
        calls: [
          {
            callId: "public-question",
            toolName: "question",
            input: {
              questions: [
                {
                  header: "Choice",
                  question: "Which?",
                  options: [{ label: "Alpha", description: "Use Alpha" }],
                  multiple: false,
                },
              ],
            },
          },
        ],
      });
      const work = source
        .submit("person: ask a question")
        .catch(() => undefined);
      let channel: Awaited<ReturnType<typeof Channel.open>> | undefined;
      let runtime: Awaited<ReturnType<typeof fixture>> | undefined;
      let extension: ReturnType<typeof chatRuntimeExtension> | undefined;
      let attached: import("@earendil-works/pi-durable").Harness | undefined;
      try {
        await until(
          async () =>
            !!(
              await source.harness.snapshot(
                QuestionsDoc,
                source.conversation.id,
                context,
              )
            )?.questions["public-question"],
        );
        const copy = await storage.snapshot();
        await source.close();
        await work;
        runtime = await fixture();
        extension = chatRuntimeExtension(
          runtime.bridge,
          (provider) => provider === account().name,
        );
        const selected = runtime;
        const runtimeExtension = extension;
        channel = await Channel.open({
          id: `public-${author}`,
          name: "public",
          owner: "person",
          project: "/private/tmp",
          storage: copy,
          models: runtime.models,
          resume: false,
          env: (cwd) => new NodeExecutionEnv({ cwd }),
          directory: {
            self: { id: `public-${author}`, name: "public" },
            list: async () => [],
            deliver: async () => {},
          },
          log: () => {},
          extension: {
            extensions: runtimeExtension.extensions,
            nonTurnModels: () => selected.native,
            attach: async (harness) => {
              attached = harness;
              await runtimeExtension.attach(harness);
            },
          },
        });
        if (!attached) throw new Error("Missing Harness");
        await attached.resume();
        await until(
          async () =>
            (
              await attached!.snapshot(LiveDoc, source.conversation.id, context)
            )?.tools?.some(
              (slot) => slot.name === "question" && slot.status === "running",
            ) === true,
        );
        expect(runtime.fake.requests).toEqual([]);
        if (delayed) {
          const original = attached.submission.bind(attached);
          const h = attached;
          attached.submission = async (id, ctx) => {
            const result = await original(id, ctx);
            if (!result) return result;
            return {
              id: result.id,
              wait: result.wait.bind(result),
              abort: result.abort.bind(result),
              status: async (c) => {
                await until(async () => {
                  const target = await h.conversation(
                    source.conversation.id,
                    context,
                  );
                  return (await target!.context(context)).entries.some((e) =>
                    e.model?.some(
                      (m) =>
                        m.role === "user" &&
                        m.content === `${author}: public person message`,
                    ),
                  );
                });
                return result.status(c);
              },
            };
          };
        }
        runtime.fake.frames.push({ text: "received" });
        await channel.handle(
          {
            op: "ask",
            author,
            chat: source.conversation.id,
            text: "public person message",
          },
          () => {},
        );
        await attached.waitForIdle(context);
        expect(runtime.fake.requests).toHaveLength(author === "person" ? 1 : 0);
        if (author === "person") {
          const sent = JSON.stringify(runtime.fake.requests[0]?.input);
          expect(sent.split("public person message")).toHaveLength(2);
          expect(sent).not.toContain("Tool question was aborted");
        }
      } finally {
        await channel?.close();
        await extension?.close();
        await runtime?.close();
        await source.close();
        await work;
      }
    });
  }
