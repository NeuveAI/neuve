import { expect, test } from "bun:test";
import { TurnFailed } from "@neuve/runtime";
import { Effect } from "effect";
import { account, context, fixture, until } from "./fixture.ts";

for (const idle of ["limit", "timer"] as const) {
  // Preparation is busy: neither other chats finishing nor the old idle timer may evict a pending model switch.
  test(`idle ${idle} preserves a session preparing its model switch`, async () => {
    const gate = Promise.withResolvers<void>();
    const idleMs = idle === "timer" ? 100 : 600_000;
    const run = await fixture({ idleMs });
    let switching = false;
    let work: ReturnType<typeof run.submit> | undefined;
    try {
      run.fake.frames.push({ text: "first answer" });
      await run.submit("first");
      const source = run.fake.opened[0]!.session;
      source.setModel = (model) =>
        Effect.promise(async () => {
          switching = true;
          await gate.promise;
          source.models.push(model);
        });
      await run.conversation.configure(
        { model: { provider: "subscription", modelId: "real" } },
        context,
      );
      work = run.submit("next");
      await until(() => switching);
      if (idle === "limit") {
        for (let n = 0; n < 2; n++) {
          const other = await run.harness.createConversation(
            {
              ownership: { kind: "ownerless" },
              agent: {
                model: { provider: "subscription", modelId: "sonnet" },
              },
            },
            context,
          );
          run.fake.frames.push({ text: "other answer" });
          expect(
            (
              await (
                await other.submit({ type: "input", content: "other" }, context)
              ).wait(context)
            ).status,
          ).toBe("done");
        }
        await Bun.sleep(10);
      } else await Bun.sleep(idleMs * 2);
      expect(source.closed).toBe(0);
      expect(run.fake.requests).toHaveLength(idle === "limit" ? 3 : 1);
      run.fake.frames.push({ text: "switched answer" });
      gate.resolve();
      expect((await work).status).toBe("done");
      expect(run.fake.requests.at(-1)).toEqual({
        session: source.id,
        input: [{ type: "text", text: "next" }],
      });
      expect((await run.messages()).at(-1)).toMatchObject({
        content: [{ type: "text", text: "switched answer" }],
      });
      expect(source.models).toEqual([{ id: "real" }]);
      if (idle === "limit") {
        // Once bound and finished, the source rejoins the normal idle limit.
        await until(() => run.fake.opened[1]!.session.closed === 1);
        expect(source.closed).toBe(0);
      } else await until(() => source.closed === 1);
      expect(run.fake.unrecordedRequests).toBe(0);
    } finally {
      gate.resolve();
      await run.conversation.abort(context);
      await work;
      await run.close();
    }
  });
}

// A failed preparation must release its source and allow the next resumed session to retire normally.
test("setModel failure releases preparation and leaves idle retirement working", async () => {
  const gate = Promise.withResolvers<void>();
  let switching = false;
  const run = await fixture({
    idleMs: 100,
    registry: (registry) => ({
      ...registry,
      openSession: (...args) =>
        registry.openSession(...args).pipe(
          Effect.map((session) => ({
            ...session,
            setModel: () =>
              Effect.gen(function* () {
                switching = true;
                yield* Effect.promise(() => gate.promise);
                return yield* new TurnFailed({
                  account: account().name,
                  reason: "provider-failed",
                });
              }),
          })),
        ),
    }),
  });
  let work: ReturnType<typeof run.submit> | undefined;
  try {
    run.fake.frames.push({ text: "first answer" });
    await run.submit("first");
    const source = run.fake.opened[0]!.session;
    let result: { stopReason: string } | undefined;
    const stream = run.bridge.stream.bind(run.bridge);
    run.bridge.stream = (...args) => {
      const output = stream(...args);
      void output.result().then((message) => {
        result = message;
      });
      return output;
    };
    await run.conversation.configure(
      { model: { provider: "subscription", modelId: "real" } },
      context,
    );
    work = run.submit("switch fails");
    await until(() => switching);
    expect(source.closed).toBe(0);
    gate.resolve();
    expect((await work).status).toBe("unanswered");
    expect(result).toMatchObject({ stopReason: "error" });
    expect(source.closed).toBe(1);
    expect(run.fake.requests).toHaveLength(1);
    run.fake.frames.push({ text: "recovered" });
    expect((await run.submit("try again")).status).toBe("done");
    expect(run.fake.opened[1]?.start).toEqual({
      kind: "resume",
      session: source.id,
      fork: false,
    });
    await until(() => run.fake.opened[1]!.session.closed === 1);
    expect(run.fake.opened.map(({ session }) => session.closed)).toEqual([
      1, 1,
    ]);
    expect(run.fake.unrecordedRequests).toBe(0);
  } finally {
    gate.resolve();
    await run.conversation.abort(context);
    await work;
    await run.close();
  }
});
