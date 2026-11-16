import { expect, test } from "bun:test";
import { Effect } from "effect";
import { account, context, fixture, until } from "./fixture.ts";

// A transcript-only continuation must replay uncertain input without losing a committed steer.
test("a seed after a later tool checkpoint must preserve an unconsumed committed steer", async () => {
  let accepted = false;
  let calls = 0;
  const gate = Promise.withResolvers<void>();
  const run = await fixture({
    registry: (registry) => ({
      ...registry,
      openSession: (...args) =>
        registry.openSession(...args).pipe(
          Effect.map((session) => ({
            ...session,
            get nativeSessionId() {
              return session.nativeSessionId;
            },
            steerTurn: () =>
              Effect.sync(() => {
                accepted = true;
              }),
          })),
        ),
    }),
    execute: async (n, read, signal) => {
      calls++;
      if (n === 1)
        await read().submit(
          { type: "input", content: "committed held steer", whenBusy: "steer" },
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
    work = run.submit("original input");
    await until(() => accepted && calls === 2);
    await run.conversation.abort(context);
    await run.bridge.closeConversation(String(run.conversation.id));
    await work;
    const imported = await run.messages();
    expect(JSON.stringify(imported)).toContain("committed held steer");
    const seed = await run.harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: { model: { provider: "subscription", modelId: "sonnet" } },
      },
      context,
    );
    await (
      await seed.submit(
        { type: "write", entry: { kind: "import", model: imported } },
        context,
      )
    ).wait(context);
    run.fake.frames.push({ text: "seed reply" });
    expect(
      (
        await (
          await seed.submit(
            { type: "input", content: "continue seed" },
            context,
          )
        ).wait(context)
      ).status,
    ).toBe("done");
    expect(run.fake.opened.at(-1)?.start).toEqual({ kind: "new" });
    const sent = JSON.stringify(run.fake.requests.at(-1)?.input);
    expect(sent.match(/committed held steer/g)).toHaveLength(1);
    expect(sent.match(/original input/g)).toHaveLength(1);
    expect(run.executed).toEqual([1, 2]);
  } finally {
    gate.resolve();
    await run.close();
    await work;
  }
});

// A live protocol failure has not attempted a resume or fork.
test("ordinary live protocol failure must not use the failed-fork recovery text", async () => {
  const run = await fixture();
  try {
    const replies: import("@earendil-works/pi-ai").AssistantMessage[] = [];
    const stream = run.bridge.stream.bind(run.bridge);
    run.bridge.stream = (...args) => {
      const s = stream(...args);
      void s.result().then((m) => replies.push(m));
      return s;
    };
    run.fake.frames.push({
      failure: {
        _tag: "TurnFailed",
        account: account().name,
        reason: "protocol-error",
      },
    });
    await run.submit("ordinary input");
    expect(replies[0]?.errorMessage).toBe(
      "This turn did not produce an answer. Try another message.",
    );
  } finally {
    await run.close();
  }
});
