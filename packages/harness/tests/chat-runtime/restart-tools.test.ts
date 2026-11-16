import { expect, test } from "bun:test";
import { MemoryStorage, type StorageWrite } from "@earendil-works/pi-durable";
import { context, fixture, until } from "./fixture.ts";

class CapturedStorage extends MemoryStorage {
  commits: (readonly StorageWrite[])[] = [];
  override async commit(...args: Parameters<MemoryStorage["commit"]>) {
    const seq = await super.commit(...args);
    this.commits.push(structuredClone(args[0]));
    return seq;
  }
  async snapshot() {
    const copy = new MemoryStorage();
    for (const writes of [...this.commits]) await copy.commit(writes, context);
    return copy;
  }
}

// A surviving generation can be in tools, where finishing it creates a successor task ID.
test("reopening during tools must stop before its automatic successor sends", async () => {
  const storage = new CapturedStorage();
  const gate = Promise.withResolvers<void>();
  const source = await fixture({
    storage,
    execute: async () => {
      await gate.promise;
      return { content: [{ type: "text", text: "tool output" }] };
    },
  });
  let reopened: Awaited<ReturnType<typeof fixture>> | undefined;
  const work = source
    .submit("original explicit request")
    .catch(() => undefined);
  try {
    source.fake.frames.push({
      calls: [{ callId: "held", toolName: "probe", input: { n: 1 } }],
    });
    await until(() => source.executed.length === 1);
    const inspection = await source.harness.inspect(context);
    const copy = await storage.snapshot();
    await source.bridge.close();
    gate.resolve();
    await source.close();
    await work;
    reopened = await fixture({
      storage: copy,
      conversationId: source.conversation.id,
      fake: source.fake,
    });
    reopened.fake.frames.push({ text: "automatic reply after restart" });
    await reopened.harness.waitForIdle(context);
    expect(reopened.fake.opened).toHaveLength(1);
    expect(reopened.fake.requests).toHaveLength(1);
  } finally {
    gate.resolve();
    await reopened?.close();
    await source.close();
    await work;
  }
});
