import { expect, test } from "bun:test";
import { CapturedStorage } from "./captured-storage.ts";
import { context, fixture, until } from "./fixture.ts";

// A delayed submission lookup must still release a person's steer after placement by an allowlisted read.
for (const kind of ["control", "delayed"] as const) {
  test(`person steer during a recovered tool, ${kind}: releases the gate`, async () => {
    const storage = new CapturedStorage();
    const source = await fixture({
      storage,
      toolName: "read",
      execute: async (_n, _read, signal) => {
        await new Promise<void>((resolve) =>
          signal?.addEventListener("abort", () => resolve(), { once: true }),
        );
        return { content: [{ type: "text", text: "old result" }] };
      },
    });
    source.fake.frames.push({
      calls: [{ callId: "read-call", toolName: "read", input: { n: 1 } }],
    });
    const work = source.submit("person: run it").catch(() => undefined);
    let reopened: Awaited<ReturnType<typeof fixture>> | undefined;
    const go = Promise.withResolvers<void>();
    try {
      await until(() => source.executed.length === 1);
      const copy = await storage.snapshot();
      await source.close();
      await work;
      reopened = await fixture({
        storage: copy,
        toolName: "read",
        conversationId: source.conversation.id,
        execute: async () => {
          await go.promise;
          return { content: [{ type: "text", text: "rerun result" }] };
        },
      });
      const run = reopened;
      run.fake.frames.push({ text: "reply to the person" });
      // Opening leaves scheduling paused; waiting resumes it, as the worker's resume does.
      const idle = run.harness.waitForIdle(context);
      await until(() => run.executed.length === 1);
      expect(run.fake.requests).toHaveLength(0);
      const placed = new Set<string>();
      run.harness.subscribeCommits(({ changes }) => {
        for (const change of changes)
          if (change.type === "submission" && change.value.status === "placed")
            placed.add(String(change.value.id));
      });
      if (kind === "delayed") {
        const original = run.harness.submission.bind(run.harness);
        run.harness.submission = async (id, c) => {
          await until(() => placed.has(String(id)));
          return original(id, c);
        };
      }
      const steer = await run.conversation.submit(
        {
          type: "input",
          content: "person: also check the logs",
          whenBusy: "steer",
        },
        context,
      );
      go.resolve();
      await steer.wait(context).catch(() => undefined);
      await idle;
      await run.harness.waitForIdle(context);
      const record = await steer.status(context);
      if (record.entry === undefined) throw new Error("Steer was not placed");
      const entryId = record.entry;
      const entry = await run.harness.commit(
        (tx) => tx.entry(entryId),
        context,
      );

      expect(record.entry).toBeDefined();
      if (kind === "delayed") expect(entry?.byTaskId).toBeDefined();
      expect(run.fake.requests).toHaveLength(1);
      expect(
        JSON.stringify(run.fake.requests[0]?.input).split(
          "also check the logs",
        ),
      ).toHaveLength(2);
    } finally {
      go.resolve();
      await reopened?.close();
      await source.close();
      await work;
    }
  });
}
