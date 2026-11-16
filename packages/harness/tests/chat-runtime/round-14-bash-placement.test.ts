import { expect, test } from "bun:test";
import { CapturedStorage } from "./captured-storage.ts";
import { context, fixture, until } from "./fixture.ts";

// A steer keeps its admission origin after task-scoped placement by an allowlisted read run under ruling 28b.
for (const delayed of [false, true])
  for (const author of ["person", "agent@source"]) {
    test(`${author} steer, delayed=${delayed}: placement preserves release and delivery`, async () => {
      const content = `${author}: go on`;
      const storage = new CapturedStorage();
      const source = await fixture({
        storage,
        toolName: "read",
        execute: async (_n, _read, signal) => {
          await new Promise<void>((resolve) =>
            signal?.addEventListener("abort", () => resolve(), { once: true }),
          );
          return { content: [{ type: "text", text: "old" }] };
        },
      });
      source.fake.frames.push({
        calls: [{ callId: "read-call", toolName: "read", input: { n: 1 } }],
      });
      const work = source.submit("person: original").catch(() => undefined);
      const release = Promise.withResolvers<void>();
      const observed = Promise.withResolvers<void>();
      let reopened: Awaited<ReturnType<typeof fixture>> | undefined;
      try {
        await until(() => source.executed.length === 1);
        const copy = await storage.snapshot();
        await source.close();
        await work;
        reopened = await fixture({
          storage: copy,
          conversationId: source.conversation.id,
          toolName: "read",
          execute: async () => {
            await release.promise;
            return { content: [{ type: "text", text: "reran" }] };
          },
        });
        const run = reopened;
        await run.harness.resume();
        await until(() => run.executed.length === 1);
        expect(run.fake.requests).toHaveLength(0);
        const original = run.harness.submission.bind(run.harness);
        run.harness.submission = async (id, ctx) => {
          const result = await original(id, ctx);
          if (!result) return result;
          return {
            id: result.id,
            wait: result.wait.bind(result),
            abort: result.abort.bind(result),
            status: async (c) => {
              observed.resolve();
              if (delayed)
                await until(async () =>
                  (await run.conversation.context(context)).entries.some((e) =>
                    e.model?.some(
                      (m) => m.role === "user" && m.content === content,
                    ),
                  ),
                );
              return result.status(c);
            },
          };
        };
        run.fake.frames.push({ text: "requested answer" });
        const input = await run.conversation.submit(
          { type: "input", whenBusy: "steer", content },
          context,
        );
        await observed.promise;
        expect(run.fake.requests).toHaveLength(0);
        release.resolve();
        await input.wait(context);
        await run.harness.waitForIdle(context);
        const entry = (await run.conversation.context(context)).entries.find(
          (e) =>
            e.model?.some((m) => m.role === "user" && m.content === content),
        );
        expect(entry?.byTaskId).toBeDefined();
        expect(run.fake.requests).toHaveLength(author === "person" ? 1 : 0);
        if (author === "person") {
          const sent = JSON.stringify(run.fake.requests[0]?.input);
          expect(sent.split(content)).toHaveLength(2);
        }
      } finally {
        release.resolve();
        await reopened?.close();
        await source.close();
        await work;
      }
    });
  }
