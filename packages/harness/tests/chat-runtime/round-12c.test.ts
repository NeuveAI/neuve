import { expect, test } from "bun:test";
import { CapturedStorage } from "./captured-storage.ts";
import { context, fixture, until } from "./fixture.ts";

class HeldAbortStorage extends CapturedStorage {
  holdAborts = false;
  readonly marking = Promise.withResolvers<void>();
  readonly release = Promise.withResolvers<void>();

  override async commit(...args: Parameters<CapturedStorage["commit"]>) {
    if (
      this.holdAborts &&
      args[0].some(
        (write) => write.type === "task" && write.value.abortRequested,
      )
    ) {
      this.marking.resolve();
      await this.release.promise;
    }
    return super.commit(...args);
  }
}

// Reason: Ruling 28b must abort a recovered bash even if a prior attach died before its mark. Reopen must
// repeat the abort, and attach must not expose the channel while a mark is uncommitted.
test("B18: an uncommitted attach abort leaves the saved tool safe to abort on another reopen", async () => {
  const storage = new CapturedStorage();
  const source = await fixture({
    storage,
    toolName: "bash",
    execute: async (_n, _read, signal) => {
      await new Promise<void>((resolve) =>
        signal?.addEventListener("abort", () => resolve(), { once: true }),
      );
      return { content: [{ type: "text", text: "old result" }] };
    },
  });
  source.fake.frames.push({
    calls: [{ callId: "saved", toolName: "bash", input: { n: 1 } }],
  });
  const work = source.submit("original request").catch(() => undefined);
  const held = new HeldAbortStorage();
  let opening: ReturnType<typeof fixture> | undefined;
  let recovered: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    await until(() => source.executed.length === 1);
    for (const writes of [...storage.commits])
      await held.commit(writes, context);
    await source.close();
    await work;
    held.holdAborts = true;
    let attached = false;
    opening = fixture({
      storage: held,
      toolName: "bash",
      conversationId: source.conversation.id,
    }).then((run) => {
      attached = true;
      return run;
    });
    await held.marking.promise;
    expect(attached).toBe(false);
    const beforeAbortCommit = await held.snapshot();
    held.release.resolve();
    const first = await opening;
    const view = await first.harness.inspect(context);
    expect(view.scheduling).toBe("paused");
    expect(
      view.tasks
        .filter(({ record }) => record.kind === "pi.tool")
        .map(({ record }) => record.abortRequested),
    ).toEqual([true]);
    await first.harness.waitForIdle(context);
    expect(first.executed).toEqual([]);
    expect(first.fake.requests).toEqual([]);
    recovered = await fixture({
      storage: beforeAbortCommit,
      toolName: "bash",
      conversationId: source.conversation.id,
    });
    await recovered.harness.waitForIdle(context);
    expect(recovered.executed).toEqual([]);
    expect(recovered.fake.opened).toEqual([]);
    expect(recovered.fake.requests).toEqual([]);
    expect(JSON.stringify(await recovered.messages())).toContain(
      "Tool bash was aborted",
    );
  } finally {
    held.release.resolve();
    await (await opening)?.close();
    await recovered?.close();
    await source.close();
    await work;
  }
});
