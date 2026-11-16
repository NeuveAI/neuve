import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { Effect } from "effect";
import { headDigest } from "../../src/chat-runtime/transcript.ts";
import { NativeHeads } from "../../src/chat-runtime/heads.ts";
import { account, context, fixture, until } from "./fixture.ts";

// A tool-result carrier can acknowledge a later native checkpoint than the last assistant message.
test("the carrier checkpoint is persisted and used by a later fork", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-runtime-carrier-"));
  const run = await fixture({ headsDirectory: directory });
  try {
    run.fake.frames.push({
      calls: [{ callId: "carrier-tool", toolName: "probe", input: { n: 8 } }],
      resumePoint: "assistant-checkpoint",
      finishAfterResults: "tool-result-checkpoint",
    });
    expect((await run.submit("finish on the tool result")).status).toBe("done");
    const messages = await run.messages();
    expect(
      messages
        .filter((message) => message.role === "assistant")
        .map((message) => message.responseId),
    ).toEqual([
      "native:session-1:assistant-checkpoint",
      "native:session-1:tool-result-checkpoint:c",
    ]);
    const saved = await NativeHeads.open(directory);
    expect(saved.get(String(run.conversation.id))).toMatchObject({
      session: "session-1",
      resumePoint: "tool-result-checkpoint",
    });
    await saved.close();
    await run.bridge.closeConversation(String(run.conversation.id));
    run.fake.failOpen = (start) => start?.kind === "resume" && !start.fork;
    run.fake.frames.push({ text: "forked" });
    expect((await run.submit("next")).status).toBe("done");
    expect(run.fake.opened[1]?.start).toEqual({
      kind: "resume",
      session: "session-1",
      at: "tool-result-checkpoint",
      fork: true,
    });
    expect(run.fake.requests.at(-1)?.input).toEqual([
      { type: "text", text: "next" },
    ]);
    expect(run.executed).toEqual([8]);
    expect(run.fake.unrecordedRequests).toBe(0);
  } finally {
    await run.close();
    await rm(directory, { recursive: true, force: true });
  }
});

// Exercise the head as the sole native-state record across opening, mirroring, cancellation and failed forks.
test("every recovery target and input follows the conversation head across Stop, steer and a failed first fork turn", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "chat-runtime-head-sequence-"),
  );
  const firstGate = Promise.withResolvers<void>();
  const steerGate = Promise.withResolvers<void>();
  const forkGate = Promise.withResolvers<void>();
  let firstHeld = false;
  let steerHeld = false;
  let forkHeld = false;
  let holdFirst = true;
  let holdSteer = true;
  let holdFork = true;
  const inputs: Message[][] = [];
  const outputs: AssistantMessage[] = [];
  const run = await fixture({
    headsDirectory: directory,
    registry: (registry) => ({
      ...registry,
      openSession: (name, policy, start) =>
        Effect.gen(function* () {
          const session = yield* registry.openSession(name, policy, start);
          return {
            ...session,
            get nativeSessionId() {
              return session.nativeSessionId;
            },
            startTurn: (input) =>
              Effect.gen(function* () {
                if (holdFirst) {
                  firstHeld = true;
                  yield* Effect.promise(() => firstGate.promise);
                } else if (holdFork && start?.kind === "resume" && start.fork) {
                  forkHeld = true;
                  yield* Effect.promise(() => forkGate.promise);
                }
                yield* session.startTurn(input);
              }),
            steerTurn: (input) =>
              Effect.gen(function* () {
                if (holdSteer) {
                  steerHeld = true;
                  yield* Effect.promise(() => steerGate.promise);
                }
                yield* session.steerTurn(input);
              }),
          };
        }),
    }),
    execute: async (_n, read) => {
      await read().submit(
        { type: "input", content: "steer survives", whenBusy: "steer" },
        context,
      );
      return { content: [{ type: "text", text: "saved tool result" }] };
    },
  });
  const stream = run.bridge.stream.bind(run.bridge);
  run.bridge.stream = (...args) => {
    inputs.push(structuredClone(args[2].messages));
    const output = stream(...args);
    void output.result().then((message) => outputs.push(message));
    return output;
  };
  const owner = String(run.conversation.id);
  let work: ReturnType<typeof run.submit> | undefined;
  try {
    run.fake.frames.push({ text: "first answer" });
    work = run.submit("first input");
    try {
      await until(() => firstHeld);
      expect(run.heads.get(owner)).toEqual({
        session: "session-1",
        continuation: { runtime: "claude-code", key: "/shared" },
        previousDigest: headDigest([]),
        pending: true,
        forkRequired: true,
        digest: headDigest(inputs[0]!),
        inputs: [{ kind: "message", through: headDigest(inputs[0]!) }],
      });
      expect(run.fake.requests).toEqual([]);
      expect(
        JSON.parse(
          await readFile(join(directory, "native-heads.json"), "utf8"),
        ),
      ).toEqual({ [owner]: run.heads.get(owner) });
    } finally {
      holdFirst = false;
      firstGate.resolve();
    }
    expect((await work).status).toBe("done");
    const first = run.heads.get(owner)!;
    expect(first).toEqual({
      session: "session-1",
      continuation: { runtime: "claude-code", key: "/shared" },
      previousDigest: headDigest([]),
      resumePoint: "point-1",
      completed: true,
      checkpointThrough: headDigest(inputs[0]!),
      digest: headDigest([...inputs[0]!, outputs[0]!]),
    });

    run.fake.frames.push({
      calls: [{ callId: "stopped-tool", toolName: "probe", input: { n: 9 } }],
    });
    work = run.submit("tool input");
    await until(() => steerHeld);
    const acknowledged = run.heads.get(owner)!;
    expect(acknowledged).toEqual({
      session: "session-1",
      continuation: { runtime: "claude-code", key: "/shared" },
      previousDigest: headDigest([]),
      resumePoint: "point-2",
      pending: true,
      forkRequired: true,
      inputs: [
        {
          kind: "message",
          through: headDigest(inputs[1]!),
          before: {
            session: "session-1",
            resumePoint: "point-1",
            digest: first.digest,
          },
        },
        {
          kind: "steer",
          through: headDigest(inputs[2]!),
          before: {
            session: "session-1",
            resumePoint: "point-2",
            digest: headDigest([...inputs[1]!, outputs[1]!]),
          },
        },
      ],
      checkpointThrough: headDigest(inputs[1]!),
      digest: headDigest([...inputs[1]!, outputs[1]!]),
    });
    await run.bridge.closeConversation(owner);
    await work;
    expect(outputs.at(-1)?.stopReason).toBe("aborted");
    const { pending: _pending, ...clean } = acknowledged;
    expect(run.heads.get(owner)).toEqual({
      ...clean,
      forkRequired: true,
    });
    expect(run.fake.results).toEqual([]);

    run.fake.failOpen = (start) => start?.kind === "resume" && !start.fork;
    run.fake.frames.push({
      beforeMessage: () =>
        run.fake.opened
          .at(-1)!
          .session.emit({ type: "text", text: "unmirrored fork text" }),
      failure: {
        _tag: "TurnFailed",
        account: account().name,
        reason: "provider-failed",
      },
    });
    work = run.submit("fork input");
    try {
      await until(() => forkHeld);
      expect(run.fake.opened[1]?.start).toEqual({
        kind: "resume",
        session: acknowledged.session,
        at: first.resumePoint,
        fork: true,
      });
      expect(run.heads.get(owner)).toEqual({
        session: "session-2",
        continuation: { runtime: "claude-code", key: "/shared" },
        previousDigest: headDigest(inputs[3]!.slice(0, -1)),
        pending: true,
        forkRequired: true,
        inputs: [
          {
            kind: "message",
            through: headDigest(inputs[3]!),
            before: {
              session: "session-1",
              resumePoint: "point-1",
              digest: first.digest,
            },
          },
        ],
        forkedFrom: { session: "session-1", resumePoint: "point-1" },
        digest: first.digest,
      });
      expect(run.fake.requests).toHaveLength(2);
    } finally {
      holdFork = false;
      forkGate.resolve();
    }
    expect((await work).status).toBe("unanswered");
    const unfinished = run.heads.get(owner)!;
    expect(unfinished.resumePoint).toBeUndefined();
    expect(unfinished.forkedFrom).toEqual({
      session: "session-1",
      resumePoint: "point-1",
    });
    expect(run.fake.requests[2]?.input).toEqual([
      { type: "text", text: "tool input" },
      {
        type: "text",
        text: "probe already ran. Do not call it again. Result:\nsaved tool result",
      },
      { type: "text", text: "steer survives" },
      { type: "text", text: "fork input" },
    ]);
    // A stale partial pointer cannot replace the authoritative head's native session.
    await (
      await run.conversation.submit(
        {
          type: "write",
          entry: {
            kind: "pi.assistant",
            model: [
              { ...outputs.at(-1)!, responseId: "native:stale-session:" },
            ],
          },
        },
        context,
      )
    ).wait(context);
    run.fake.frames.push({ text: "recovered" });
    expect((await run.submit("next input")).status).toBe("done");
    // Ruling 25(b): both incomplete turns require a pinned fork.
    expect(run.fake.failures).toEqual([]);
    expect(run.fake.opened[2]?.start).toEqual({
      kind: "resume",
      session: unfinished.forkedFrom!.session,
      at: unfinished.forkedFrom!.resumePoint,
      fork: true,
    });
    expect(run.fake.requests[3]?.input).toEqual([
      { type: "text", text: "tool input" },
      {
        type: "text",
        text: "probe already ran. Do not call it again. Result:\nsaved tool result",
      },
      { type: "text", text: "steer survives" },
      { type: "text", text: "fork input" },
      { type: "text", text: "next input" },
    ]);
    expect(run.heads.get(owner)).toEqual({
      session: "session-3",
      continuation: { runtime: "claude-code", key: "/shared" },
      previousDigest: headDigest(inputs.at(-1)!.slice(0, -1)),
      resumePoint: "point-4",
      completed: true,
      checkpointThrough: headDigest(inputs.at(-1)!),
      digest: headDigest([...inputs.at(-1)!, outputs.at(-1)!]),
    });
    expect(
      Object.keys(
        JSON.parse(
          await readFile(join(directory, "native-heads.json"), "utf8"),
        ),
      ),
    ).toEqual([owner]);
    run.fake.frames.push({ text: "same live session" });
    expect((await run.submit("one more input")).status).toBe("done");
    expect(run.fake.opened).toHaveLength(3);
    expect(run.fake.requests.at(-1)?.session).toBe("session-3");
    expect(run.fake.requests.at(-1)?.input).toEqual([
      { type: "text", text: "one more input" },
    ]);
    expect(run.executed).toEqual([9]);
    expect(run.fake.unrecordedRequests).toBe(0);
  } finally {
    holdFirst = false;
    holdSteer = false;
    holdFork = false;
    firstGate.resolve();
    steerGate.resolve();
    forkGate.resolve();
    await work;
    await run.close();
    await rm(directory, { recursive: true, force: true });
  }
});
