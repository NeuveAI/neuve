import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import type { RuntimeRegistryShape } from "@neuve/runtime";
import { Effect, Stream } from "effect";
import {
  ChatRuntimeBridge,
  NativeHeads,
} from "../../src/chat-runtime/index.ts";
import { account, caps, context, fixture, until } from "./fixture.ts";

const route = {
  name: account().name,
  capabilities: caps,
  continuation: { runtime: account().runtime, key: "/shared" },
};

// Ruling 25(b): Stop without a resume point opens fresh and replays the committed input.
test("Stop during the first reply opens fresh with both inputs", async () => {
  let streaming = false;
  const run = await fixture({
    registry: (registry) => ({
      ...registry,
      openSession: (...args) =>
        Effect.gen(function* () {
          const session = yield* registry.openSession(...args);
          if (session.nativeSessionId !== "session-1") return session;
          return {
            ...session,
            get nativeSessionId() {
              return session.nativeSessionId;
            },
            events: session.events.pipe(
              Stream.filter((event) => {
                if (event.type === "text") streaming = true;
                return (
                  event.type !== "message.finished" &&
                  event.type !== "turn.finished"
                );
              }),
            ),
          };
        }),
    }),
  });
  let work: ReturnType<typeof run.submit> | undefined;
  try {
    run.fake.frames.push({ text: "partial reply" });
    work = run.submit("first input");
    await until(() => streaming);
    await run.conversation.abort(context);
    await (
      await run.conversation.submit(
        {
          type: "write",
          entry: { kind: "ace.stopped", data: {} },
        },
        context,
      )
    ).wait(context);
    await run.bridge.closeConversation(String(run.conversation.id));
    expect((await work).status).toBe("unanswered");
    const head = run.heads.get(String(run.conversation.id));
    expect(head?.pending).toBeUndefined();
    expect(head?.resumePoint).toBeUndefined();
    expect(head?.forkRequired).toBe(true);
    expect(head?.deliveredThrough).toBeUndefined();
    run.fake.frames.push({ text: "next reply" });
    expect((await run.submit("next input")).status).toBe("done");
    expect(run.fake.opened[1]?.start).toEqual({
      kind: "new",
    });
    expect(run.fake.requests.map((request) => request.input)).toEqual([
      [{ type: "text", text: "first input" }],
      [
        { type: "text", text: "first input" },
        { type: "text", text: "next input" },
      ],
    ]);
    expect(run.fake.opened[0]?.session.interrupted).toBe(0);
    expect(run.fake.unrecordedRequests).toBe(0);
  } finally {
    await run.close();
    await work;
  }
});

// Ruling 25(b): a first-turn failure has no receipt, and a disk reopen must preserve a fresh replay.
test("a first-turn provider failure persists uncertainty and opens fresh with both inputs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-runtime-r9b-failure-"));
  let registry: RuntimeRegistryShape | undefined;
  const run = await fixture({
    headsDirectory: directory,
    registry: (value) => (registry = value),
  });
  let recovered: ChatRuntimeBridge | undefined;
  try {
    run.fake.frames.push({
      failure: {
        _tag: "TurnFailed",
        account: account().name,
        reason: "provider-failed",
      },
    });
    expect((await run.submit("first input")).status).toBe("unanswered");
    await run.bridge.close();
    const heads = await NativeHeads.open(directory);
    expect(heads.get(String(run.conversation.id))).toMatchObject({
      session: "session-1",
      forkRequired: true,
    });
    expect(heads.get(String(run.conversation.id))?.pending).toBeUndefined();
    recovered = new ChatRuntimeBridge({ registry: registry!, heads });
    const messages: Message[] = [
      ...(await run.messages()),
      { role: "user", content: "next input", timestamp: 2 },
    ];
    recovered.identify(messages, run.conversation.id, "after-failure");
    run.fake.frames.push({ text: "recovered" });
    const result = await recovered
      .stream(route, run.models.getModel("subscription", "sonnet")!, {
        messages,
      })
      .result();
    expect(result.stopReason).toBe("stop");
    expect(run.fake.opened[1]?.start).toEqual({
      kind: "new",
    });
    expect(run.fake.requests.at(-1)?.input).toEqual([
      { type: "text", text: "first input" },
      { type: "text", text: "next input" },
    ]);
    expect(run.fake.requests).toHaveLength(2);
    expect(run.executed).toEqual([]);
  } finally {
    await recovered?.close();
    await run.close();
    await rm(directory, { recursive: true, force: true });
  }
});

// Acknowledged steers can still be queued in the runtime, so an unfinished tool round needs a pinned fork.
test("Stop after steer acceptance pins the checkpoint and preserves the result and steer", async () => {
  const gate = Promise.withResolvers<void>();
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
            // Accepted into memory, but never sent before Stop discards it.
            steerTurn: () =>
              Effect.sync(() => {
                accepted = true;
              }),
          };
        }),
    }),
    execute: async (_n, read) => {
      await read().submit(
        { type: "input", content: "delivered steer", whenBusy: "steer" },
        context,
      );
      return { content: [{ type: "text", text: "pending result" }] };
    },
  });
  let work: ReturnType<typeof run.submit> | undefined;
  try {
    run.fake.frames.push({
      calls: [{ callId: "held", toolName: "probe", input: { n: 1 } }],
      delayHandler: () =>
        Promise.race([
          gate.promise,
          new Promise<void>((resolve) =>
            run.fake.opened[0]!.session.abort.signal.addEventListener(
              "abort",
              () => resolve(),
              { once: true },
            ),
          ),
        ]),
    });
    work = run.submit("first input");
    await until(() => accepted);
    await run.bridge.closeConversation(String(run.conversation.id));
    expect((await work).status).toBe("unanswered");
    expect(run.fake.results).toEqual([]);
    expect(run.fake.requests).toHaveLength(1);
    expect(run.heads.get(String(run.conversation.id))?.forkRequired).toBe(true);
    run.fake.frames.push({ text: "recovered" });
    expect((await run.submit("next input")).status).toBe("done");
    // Ruling 27: the original turn message is also unproven.
    expect(run.fake.opened[1]?.start).toEqual({ kind: "new" });
    expect(run.fake.requests.at(-1)?.input).toEqual([
      { type: "text", text: "first input" },
      {
        type: "text",
        text: "probe already ran. Do not call it again. Result:\npending result",
      },
      { type: "text", text: "delivered steer" },
      { type: "text", text: "next input" },
    ]);
    expect(run.executed).toEqual([1]);
    expect(run.fake.unrecordedRequests).toBe(0);
  } finally {
    gate.resolve();
    await run.close();
    await work;
  }
});

// The contract cannot prove a returned tool result reached native storage before a live provider failure.
test("a live failure after tool and steer acceptance replays their suffix on a pinned fork", async () => {
  const run = await fixture({
    execute: async (_n, read) => {
      await read().submit(
        { type: "input", content: "delivered steer", whenBusy: "steer" },
        context,
      );
      return { content: [{ type: "text", text: "delivered result" }] };
    },
  });
  try {
    run.fake.frames.push(
      { calls: [{ callId: "delivered", toolName: "probe", input: { n: 1 } }] },
      {
        failure: {
          _tag: "TurnFailed",
          account: account().name,
          reason: "provider-failed",
        },
      },
    );
    expect((await run.submit("first input")).status).toBe("unanswered");
    await run.bridge.closeConversation(String(run.conversation.id));
    expect(run.fake.results).toEqual([
      { id: "delivered", outcome: { text: "delivered result" } },
    ]);
    expect(run.heads.get(String(run.conversation.id))?.pending).toBeUndefined();
    expect(run.heads.get(String(run.conversation.id))?.forkRequired).toBe(true);
    run.fake.frames.push({ text: "recovered" });
    expect((await run.submit("next input")).status).toBe("done");
    // Ruling 27: the original turn message is also unproven.
    expect(run.fake.opened[1]?.start).toEqual({ kind: "new" });
    expect(run.fake.requests.at(-1)?.input).toEqual([
      { type: "text", text: "first input" },
      {
        type: "text",
        text: "probe already ran. Do not call it again. Result:\ndelivered result",
      },
      { type: "text", text: "delivered steer" },
      { type: "text", text: "next input" },
    ]);
    expect(run.executed).toEqual([1]);
    expect(run.fake.unrecordedRequests).toBe(0);
  } finally {
    await run.close();
  }
});

for (const checkpoint of [false, true]) {
  // The live-end write is atomic: a crash before its rename still sees pending, never an unsafe resume.
  test(`a crash after live end but before resolution ${checkpoint ? "pins the committed checkpoint" : "opens fresh without a checkpoint"}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "chat-runtime-r9b-crash-"));
    const gate = Promise.withResolvers<void>();
    let resolving = false;
    let registry: RuntimeRegistryShape | undefined;
    const run = await fixture({
      headsDirectory: directory,
      registry: (value) => (registry = value),
    });
    let recovered: ChatRuntimeBridge | undefined;
    const set = run.heads.set.bind(run.heads);
    run.heads.set = async (owner, head) => {
      if (head.forkRequired && !head.pending) {
        resolving = true;
        await gate.promise;
      }
      await set(owner, head);
    };
    try {
      if (checkpoint) {
        run.fake.frames.push({ text: "checkpoint" });
        await run.submit("committed input");
      }
      run.fake.frames.push({
        failure: {
          _tag: "TurnFailed",
          account: account().name,
          reason: "provider-failed",
        },
      });
      expect((await run.submit("failed input")).status).toBe("unanswered");
      await until(() => resolving);
      const heads = await NativeHeads.open(directory);
      expect(heads.get(String(run.conversation.id))?.pending).toBe(true);
      recovered = new ChatRuntimeBridge({ registry: registry!, heads });
      const messages: Message[] = [
        ...(await run.messages()),
        { role: "user", content: "next input", timestamp: 3 },
      ];
      recovered.identify(
        messages,
        run.conversation.id,
        "crash-before-resolution",
      );
      const count = run.fake.requests.length;
      run.fake.frames.push({ text: "recovered" });
      const result = await recovered
        .stream(route, run.models.getModel("subscription", "sonnet")!, {
          messages,
        })
        .result();
      // All recovery assertions hold while the original resolution write is blocked.
      if (checkpoint) {
        expect(result.stopReason).toBe("stop");
        expect(run.fake.opened.at(-1)?.start).toEqual({
          kind: "resume",
          session: "session-1",
          at: "point-1",
          fork: true,
        });
        expect(run.fake.requests.at(-1)?.input).toEqual([
          { type: "text", text: "failed input" },
          { type: "text", text: "next input" },
        ]);
        expect(run.fake.requests).toHaveLength(count + 1);
      } else {
        expect(result.stopReason).toBe("stop");
        expect(run.fake.opened.at(-1)?.start).toEqual({ kind: "new" });
        expect(run.fake.requests.at(-1)?.input).toEqual([
          { type: "text", text: "failed input" },
          { type: "text", text: "next input" },
        ]);
        expect(run.fake.requests).toHaveLength(count + 1);
      }
      expect(run.executed).toEqual([]);
    } finally {
      await recovered?.close();
      gate.resolve();
      await run.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
