import { expect, test } from "bun:test";
import { Effect } from "effect";
import { account, context, fixture, until } from "./fixture.ts";

// runtime-claude/src/production.ts:92-98: startTurn success is Queue.offer into an in-memory
// queue, the same acceptance the table already distrusts for steers. Scope close
// (Queue.shutdown + abort) can discard it before Claude Code reads stdin.
test("Stop after startTurn acceptance must not mark the input delivered", async () => {
  let swallow = false;
  let accepted = false;
  const run = await fixture({
    registry: (registry) => ({
      ...registry,
      openSession: (...args) =>
        Effect.gen(function* () {
          const session = yield* registry.openSession(...args);
          return {
            ...session,
            get nativeSessionId() {
              return session.nativeSessionId;
            },
            startTurn: (input: Parameters<typeof session.startTurn>[0]) =>
              swallow
                ? Effect.sync(() => {
                    accepted = true; // held in memory, never reaches native storage
                  })
                : session.startTurn(input),
          };
        }),
    }),
  });
  let work: ReturnType<typeof run.submit> | undefined;
  try {
    run.fake.frames.push({ text: "committed answer" });
    expect((await run.submit("first")).status).toBe("done");
    swallow = true;
    work = run.submit("second, accepted but never persisted");
    await until(() => accepted);
    swallow = false;
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
    expect((await run.submit("third")).status).toBe("done");
    const native = run.fake.requests.flatMap((request) =>
      Array.isArray(request.input)
        ? request.input.map((block: { text?: string }) => block.text)
        : [],
    );
    const committed = JSON.stringify(await run.messages());
    expect(committed).toContain("second, accepted but never persisted");
    // 23(b): the person's committed second message must reach Claude at least once.
    expect(
      native.filter((text) => text === "second, accepted but never persisted"),
    ).toHaveLength(1);
    expect(run.fake.opened.at(-1)?.start).toEqual({
      kind: "resume",
      session: "session-1",
      at: "point-1",
      fork: true,
    });
    expect(run.fake.requests.at(-1)?.input).toEqual([
      { type: "text", text: "second, accepted but never persisted" },
      { type: "text", text: "third" },
    ]);
  } finally {
    await run.close();
    await work;
  }
});

// A tool-use checkpoint H after a held round clears forkRequired, but the held steer
// (runtime-claude session.ts:1655-1659, offered only after calls settle) is not proven
// to precede that checkpoint in native storage.
test("a later tool-use checkpoint must not clear an unproven held steer", async () => {
  let swallowSteer = true;
  let accepted = false;
  let calls = 0;
  const gate = Promise.withResolvers<void>();
  const run = await fixture({
    registry: (registry) => ({
      ...registry,
      openSession: (...args) =>
        Effect.gen(function* () {
          const session = yield* registry.openSession(...args);
          return {
            ...session,
            get nativeSessionId() {
              return session.nativeSessionId;
            },
            steerTurn: (input: Parameters<typeof session.steerTurn>[0]) =>
              swallowSteer
                ? Effect.sync(() => {
                    accepted = true;
                  })
                : session.steerTurn(input),
          };
        }),
    }),
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
    await until(() => accepted && calls === 2);
    const head = run.heads.get(String(run.conversation.id));
    swallowSteer = false;
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
    const native = JSON.stringify(run.fake.requests.map((r) => r.input));
    expect(JSON.stringify(await run.messages())).toContain("held steer");
    // 23(b): the person's committed steer must reach Claude at least once.
    expect(native.match(/held steer/g)).toHaveLength(1);
    expect(head?.pending).toBe(true);
    expect(head?.forkRequired).toBe(true);
    // Ruling 27: no completed point exists before this turn's original message.
    expect(run.fake.opened.at(-1)?.start).toEqual({ kind: "new" });
    expect(run.fake.requests.at(-1)?.input).toEqual([
      { type: "text", text: "first input" },
      {
        type: "text",
        text: "probe already ran. Do not call it again. Result:\nresult-1",
      },
      { type: "text", text: "held steer" },
      {
        type: "text",
        text: "The probe call returned an error: <harness>\n[error] Tool probe was aborted\n</harness>",
      },
      { type: "text", text: "next input" },
    ]);
    expect(run.executed).toEqual([1, 2]);
    const completed = run.heads.get(String(run.conversation.id));
    expect(completed?.completed).toBe(true);
    expect(completed?.pending).toBeUndefined();
    expect(completed?.forkRequired).toBeUndefined();
    expect(completed?.steers).toBeUndefined();
    await run.bridge.closeConversation(String(run.conversation.id));
    run.fake.frames.push({ text: "continued cleanly" });
    expect((await run.submit("after completed turn")).status).toBe("done");
    expect(run.fake.opened.at(-1)?.start).toEqual({
      kind: "resume",
      session: "session-2",
      fork: false,
    });
    expect(run.fake.requests.at(-1)?.input).toEqual([
      { type: "text", text: "after completed turn" },
    ]);
  } finally {
    gate.resolve();
    await run.close();
    await work;
  }
});
