import { expect, test } from "bun:test";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { Effect } from "effect";
import { AccountNotFound } from "@neuve/runtime";
import { account, caps, context, fixture, until } from "./fixture.ts";
import { resumeFailed } from "../../src/chat-runtime/failure.ts";

type Run = Awaited<ReturnType<typeof fixture>>;
function observe(run: Run) {
  const messages: AssistantMessage[] = [];
  const stream = run.bridge.stream.bind(run.bridge);
  run.bridge.stream = (...args) => {
    const output = stream(...args);
    void output.result().then((message) => messages.push(message));
    return output;
  };
  return messages;
}

// An unfinished fork must preserve its inherited checkpoint.
test("S1: Stop during a fork's first startTurn leaves the chat resumable", async () => {
  const gate = Promise.withResolvers<void>();
  let armed = false;
  let entered = false;
  const run = await fixture({
    registry: (registry) => ({
      ...registry,
      openSession: (name, policy, start) =>
        Effect.gen(function* () {
          const session = yield* registry.openSession(name, policy, start);
          const fork = start?.kind === "resume" && start.fork;
          return {
            ...session,
            get nativeSessionId() {
              return session.nativeSessionId;
            },
            startTurn: (input) =>
              (armed && fork
                ? Effect.promise(async () => {
                    entered = true;
                    await gate.promise;
                  })
                : Effect.void
              ).pipe(Effect.andThen(session.startTurn(input))),
          };
        }),
    }),
  });
  const results = observe(run);
  let work: ReturnType<Run["submit"]> | undefined;
  try {
    run.fake.frames.push({ text: "one" });
    expect((await run.submit("first")).status).toBe("done");
    await run.bridge.closeSession("session-1");
    run.fake.failOpen = (start) => start?.kind === "resume" && !start.fork;
    armed = true;
    work = run.submit("second");
    await until(() => entered);
    expect(run.fake.opened[1]?.start).toMatchObject({
      kind: "resume",
      fork: true,
    });
    await run.bridge.closeConversation(String(run.conversation.id));
    await until(
      () => results.length === 2 && run.fake.opened[1]?.session.closed === 1,
    );
    expect(results[1]?.stopReason).toBe("aborted");
    expect(results[1]?.responseId).toBe("native:session-2:");
    await work;
    armed = false;
    run.fake.failOpen = () => false;
    run.fake.frames.push({ text: "three" });
    const third = await run.submit("third");
    // Asserted while the fork's startTurn gate is still held.
    expect(results.at(-1)?.errorMessage).not.toBe(resumeFailed);
    expect(third.status).toBe("done");
    expect(run.fake.opened[2]?.start).toEqual({
      kind: "resume",
      session: "session-1",
      at: "point-1",
      fork: true,
    });
    expect(run.fake.requests.at(-1)?.input).toEqual([
      { type: "text", text: "second" },
      { type: "text", text: "third" },
    ]);
    expect(run.fake.unrecordedRequests).toBe(0);
  } finally {
    gate.resolve();
    await work;
    await run.close();
  }
});

// A stopped steer must leave the undelivered result in the replay input.
test("S2: Stop during a held-round steer still delivers pi's result on the next resume", async () => {
  const gate = Promise.withResolvers<void>();
  let armed = false;
  let entered = false;
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
            steerTurn: (input) =>
              (armed
                ? Effect.promise(async () => {
                    entered = true;
                    await gate.promise;
                  })
                : Effect.void
              ).pipe(Effect.andThen(session.steerTurn(input))),
          };
        }),
    }),
    execute: async (_n, read) => {
      await read().submit(
        { type: "input", content: "steer-text", whenBusy: "steer" },
        context,
      );
      return { content: [{ type: "text", text: "tool-output-1" }] };
    },
  });
  const results = observe(run);
  let work: ReturnType<Run["submit"]> | undefined;
  try {
    armed = true;
    run.fake.frames.push({
      calls: [{ callId: "c1", toolName: "probe", input: { n: 1 } }],
    });
    work = run.submit("begin");
    await until(() => entered);
    await run.bridge.closeConversation(String(run.conversation.id));
    await until(
      () => results.length === 2 && run.fake.opened[0]?.session.closed === 1,
    );
    expect(results[0]?.stopReason).toBe("toolUse");
    expect(results[1]?.stopReason).toBe("aborted");
    // The handler was interrupted by the close: Claude never received pi's result.
    expect(run.fake.results).toEqual([]);
    await work;
    armed = false;
    run.fake.frames.push({ text: "after" });
    expect((await run.submit("next")).status).toBe("done");
    expect(run.executed).toEqual([1]);
    // Ruling 27: the original turn message is also unproven.
    expect(run.fake.opened[1]?.start).toEqual({ kind: "new" });
    const input = JSON.stringify(run.fake.requests.at(-1)?.input);
    // Asserted while the steer gate is still held.
    expect(input).toContain("tool-output-1");
    expect(input).toContain("steer-text");
  } finally {
    gate.resolve();
    await work;
    await run.close();
  }
});

// A fork still acquiring in another conversation cannot own this resume.
test("S3: another conversation's acquiring fork does not capture this conversation's resume", async () => {
  const gate = Promise.withResolvers<void>();
  let armed = false;
  let entered = false;
  const run = await fixture({
    registry: (registry) => ({
      ...registry,
      openSession: (name, policy, start) =>
        Effect.gen(function* () {
          const session = yield* registry.openSession(name, policy, start);
          if (armed && start?.kind === "resume" && start.fork)
            yield* Effect.promise(async () => {
              entered = true;
              await gate.promise;
            });
          return session;
        }),
    }),
  });
  let other: ReturnType<Run["bridge"]["stream"]> | undefined;
  let otherOwner: string | undefined;
  try {
    run.fake.frames.push({ text: "one" });
    expect((await run.submit("first")).status).toBe("done");
    await run.bridge.closeSession("session-1");
    const copied: Message[] = [
      ...(await run.messages()),
      { role: "user", content: "copy", timestamp: 2 },
    ];
    const copy = await run.harness.createConversation(
      { ownership: { kind: "ownerless" } },
      context,
    );
    otherOwner = String(copy.id);
    run.bridge.identify(copied, copy.id, "copy-generation");
    armed = true;
    other = run.bridge.stream(
      {
        name: account().name,
        capabilities: caps,
        continuation: { runtime: account().runtime, key: "/shared" },
      },
      run.models.getModel("subscription", "sonnet")!,
      { messages: copied },
    );
    await until(() => entered);
    expect(run.fake.opened[1]?.start).toMatchObject({
      kind: "resume",
      session: "session-1",
      fork: true,
    });
    run.fake.frames.push({ text: "two" });
    const second = await run.submit("second");
    expect(run.fake.logs.map((log) => log.event)).not.toContain(
      "chat-runtime.generation.failed",
    );
    // Asserted while the copy's acquisition gate is still held.
    expect(second.status).toBe("done");
    expect(run.fake.opened[2]?.start).toEqual({
      kind: "resume",
      session: "session-1",
      fork: false,
    });
  } finally {
    // Stop the copy before releasing acquisition, so cleanup cannot invent a model request.
    if (otherOwner) await run.bridge.closeConversation(otherOwner);
    gate.resolve();
    armed = false;
    if (other) await other.result();
    await run.close();
  }
});

for (const stop of [false, true]) {
  // Closing native handlers during a command must preserve its typed failure, while explicit Stop remains prompt.
  test(`a steer closing native handlers ${stop ? "still permits prompt Stop" : "waits for its typed failure"}`, async () => {
    const gate = Promise.withResolvers<void>();
    let checking = false;
    const run = await fixture({
      registry: (registry, fake) => ({
        ...registry,
        openSession: (...args) =>
          Effect.gen(function* () {
            const session = yield* registry.openSession(...args);
            return {
              ...session,
              get nativeSessionId() {
                return session.nativeSessionId;
              },
              steerTurn: () =>
                Effect.gen(function* () {
                  yield* Effect.promise(() => fake.opened[0]!.session.close());
                  checking = true;
                  yield* Effect.promise(() => gate.promise);
                  return yield* new AccountNotFound({
                    account: account().name,
                  });
                }),
            };
          }),
      }),
      execute: async (_n, read) => {
        await read().submit(
          { type: "input", content: "steer", whenBusy: "steer" },
          context,
        );
        return { content: [{ type: "text", text: "recorded result" }] };
      },
    });
    const results = observe(run);
    run.fake.frames.push({
      calls: [{ callId: "account-tool", toolName: "probe", input: { n: 1 } }],
    });
    const work = run.submit("begin");
    try {
      await until(() => checking);
      expect(results).toHaveLength(1);
      expect(results[0]?.stopReason).toBe("toolUse");
      if (stop) {
        await run.bridge.closeConversation(String(run.conversation.id));
        await until(() => results.length === 2);
        expect(results[1]?.stopReason).toBe("aborted");
      }
      expect(run.fake.requests).toHaveLength(1);
      expect(run.fake.results).toEqual([]);
    } finally {
      gate.resolve();
      await work;
      await run.close();
    }
    if (!stop) {
      expect(results[1]?.stopReason).toBe("error");
      expect(results[1]?.errorMessage).toBe(
        "The selected account subscription is no longer available.",
      );
    }
  });
}
