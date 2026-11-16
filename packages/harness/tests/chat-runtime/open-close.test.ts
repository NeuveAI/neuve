import { expect, test } from "bun:test";
import { Effect } from "effect";
import { account, context, fixture, until } from "./fixture.ts";

for (const kind of ["ace.stopped", "pi.reset", "account"] as const) {
  // A committed end must cover the session whose open has not returned yet.
  test(`${kind} during an open closes its scope without starting a turn`, async () => {
    const gate = Promise.withResolvers<void>();
    let opening = false;
    const run = await fixture({
      registry: (registry) => ({
        ...registry,
        openSession: (...args) =>
          Effect.gen(function* () {
            opening = true;
            yield* Effect.promise(() => gate.promise);
            return yield* registry.openSession(...args);
          }),
      }),
    });
    const closed = Promise.withResolvers<void>();
    const closeConversation = run.bridge.closeConversation.bind(run.bridge);
    run.bridge.closeConversation = async (owner) => {
      await closeConversation(owner);
      closed.resolve();
    };
    let result: Promise<{ stopReason: string }> | undefined;
    const stream = run.bridge.stream.bind(run.bridge);
    run.bridge.stream = (...args) => {
      const output = stream(...args);
      result = output.result();
      return output;
    };
    run.fake.frames.push({ text: "must not run" });
    const work = run.submit("begin");
    try {
      await until(() => opening);
      if (kind === "account") await run.bridge.closeAccount(account().name);
      else {
        await run.harness.commit(
          (tx) =>
            tx.appendEntry(run.conversation.id, {
              kind,
              ...(kind === "pi.reset" ? { head: "self" } : {}),
              data: {},
            }),
          context,
        );
        await closed.promise;
      }
      expect(run.fake.opened).toHaveLength(0);
      await work;
      expect(run.fake.requests).toEqual([]);
      expect(run.fake.order).toEqual([]);
      expect(run.fake.opened).toHaveLength(0);
      expect(await result).toMatchObject({
        stopReason: "aborted",
      });
    } finally {
      gate.resolve();
      await work;
      await run.close();
    }
  });

  // A previous close must not invalidate a later generation's open.
  test(`${kind} before a generation still permits its next open`, async () => {
    const run = await fixture();
    try {
      if (kind === "account") await run.bridge.closeAccount(account().name);
      else {
        const closed = Promise.withResolvers<void>();
        const closeConversation = run.bridge.closeConversation.bind(run.bridge);
        run.bridge.closeConversation = async (owner) => {
          await closeConversation(owner);
          closed.resolve();
        };
        await run.harness.commit(
          (tx) =>
            tx.appendEntry(run.conversation.id, {
              kind,
              ...(kind === "pi.reset" ? { head: "self" } : {}),
              data: {},
            }),
          context,
        );
        await closed.promise;
      }
      run.fake.frames.push({ text: "next message works" });
      expect((await run.submit("next message")).status).toBe("done");
      expect(run.fake.opened).toHaveLength(1);
      expect(run.fake.opened[0]?.session.closed).toBe(0);
      expect(run.fake.requests).toHaveLength(1);
    } finally {
      await run.close();
    }
  });
}
