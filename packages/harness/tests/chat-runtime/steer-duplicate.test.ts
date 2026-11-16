import { expect, test } from "bun:test";
import { context, fixture, until } from "./fixture.ts";

// Ruling 27 requires replay before all uncertain input, regardless of whether the runtime accepted a steer.
test("Stop after an accepted steer gives it once in a fresh session without a completed base", async () => {
  let calls = 0;
  const gate = Promise.withResolvers<void>();
  const run = await fixture({
    execute: async (n, read, signal) => {
      calls++;
      if (n === 1)
        await read().submit(
          { type: "input", content: "held steer", whenBusy: "steer" },
          context,
        );
      if (n === 2)
        await Promise.race([
          gate.promise,
          new Promise<void>((resolve) =>
            signal?.addEventListener("abort", () => resolve(), { once: true }),
          ),
        ]);
      return { content: [{ type: "text", text: `result-${n}` }] };
    },
  });
  let work: ReturnType<typeof run.submit> | undefined;
  try {
    run.fake.frames.push(
      { calls: [{ callId: "c1", toolName: "probe", input: { n: 1 } }] },
      { calls: [{ callId: "c2", toolName: "probe", input: { n: 2 } }] },
    );
    work = run.submit("first input");
    await until(() => calls === 2);
    // Native order: the steer reached the session before the round-2 message (its resume point).
    expect(run.fake.order).toEqual([
      "start",
      "handler:c1",
      "steer",
      "result:c1",
      "handler:c2",
    ]);
    await run.conversation.abort(context);
    await (
      await run.conversation.submit(
        { type: "write", entry: { kind: "ace.stopped", data: {} } },
        context,
      )
    ).wait(context);
    await run.bridge.closeConversation(String(run.conversation.id));
    await work;
    run.fake.frames.push({ text: "next reply" });
    expect((await run.submit("next input")).status).toBe("done");
    const fork = run.fake.opened.at(-1)?.start;
    // With no completed turn before the first input, a fresh session excludes all uncertain native history.
    expect(fork).toEqual({ kind: "new" });
    const sent = JSON.stringify(run.fake.requests.at(-1)?.input);
    // 23(b): the committed steer must not be duplicated in Claude's context.
    expect(sent.match(/held steer/g)).toHaveLength(1);
    expect(sent.match(/first input/g)).toHaveLength(1);
  } finally {
    gate.resolve();
    await run.close();
    await work;
  }
});
