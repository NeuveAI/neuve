import { expect, test } from "bun:test";
import { Effect } from "effect";
import { account, context, fixture, until } from "./fixture.ts";

// pi may reject input before execution, so a chosen switch must preserve the error without forbidding a corrected call.
test("handoff describes a validation-rejected call as an error", async () => {
  const run = await fixture({
    accounts: [account(), account("other", "different")],
  });
  try {
    run.fake.frames.push(
      {
        calls: [{ callId: "invalid", toolName: "probe", input: { n: "bad" } }],
      },
      { text: "validation failed" },
    );
    await run.submit("perform operation");
    expect(run.executed).toEqual([]);
    const result = (await run.messages()).find(
      (message) => message.role === "toolResult",
    );
    expect(result).toMatchObject({ isError: true });
    await run.conversation.configure(
      { model: { provider: "other", modelId: "sonnet" } },
      context,
    );
    run.fake.frames.push({ text: "continue" });
    await run.submit("correct the call");
    const input = JSON.stringify(run.fake.requests.at(-1)?.input);
    expect(input).toContain("The probe call returned an error: ");
    expect(input).toContain("Validation failed");
    expect(input).not.toContain("probe already ran");
    expect(input).not.toContain("Do not call it again");
    expect(run.fake.unrecordedRequests).toBe(0);
  } finally {
    await run.close();
  }
});

// Re-attach must use the same truthful error description when the native session never received the result.
test("re-attach carries an error result without forbidding a retry", async () => {
  const run = await fixture({
    execute: async () => {
      await run.bridge.closeSession(run.fake.opened[0]!.session.id);
      return {
        isError: true,
        content: [{ type: "text", text: "input rejected" }],
      };
    },
  });
  try {
    run.fake.frames.push(
      { calls: [{ callId: "error", toolName: "probe", input: { n: 1 } }] },
      { text: "received error" },
    );
    await run.submit("attempt operation");
    // Ruling 27: the first turn never completed, so replay in a fresh session.
    expect(run.fake.opened[1]?.start).toEqual({ kind: "new" });
    expect(run.fake.requests[1]?.input).toEqual([
      { type: "text", text: "attempt operation" },
      {
        type: "text",
        text: "The probe call returned an error: input rejected",
      },
    ]);
    expect(run.executed).toEqual([1]);
    expect(run.fake.unrecordedRequests).toBe(0);
  } finally {
    await run.close();
  }
});

for (const kind of ["ace.stopped", "pi.reset"] as const) {
  // A close must settle the waiting stream while setModel is still blocked, without starting native work.
  test(`${kind} during setModel aborts the stream and starts no turn`, async () => {
    const gate = Promise.withResolvers<void>();
    const run = await fixture();
    let switching = false;
    let result: { stopReason: string } | undefined;
    let work: ReturnType<typeof run.submit> | undefined;
    try {
      run.fake.frames.push({ text: "first answer" });
      await run.submit("first");
      const source = run.fake.opened[0]!.session;
      source.setModel = (model) =>
        Effect.gen(function* () {
          switching = true;
          yield* Effect.promise(() => gate.promise);
          source.models.push(model);
        });
      await run.conversation.configure(
        { model: { provider: "subscription", modelId: "real" } },
        context,
      );
      const stream = run.bridge.stream.bind(run.bridge);
      run.bridge.stream = (...args) => {
        const output = stream(...args);
        void output.result().then((message) => {
          result = message;
        });
        return output;
      };
      run.fake.frames.push({ text: "must not start" });
      work = run.submit("next");
      await until(() => switching);
      await run.harness.commit(
        (tx) =>
          tx.appendEntry(run.conversation.id, {
            kind,
            ...(kind === "pi.reset" ? { head: "self" } : {}),
            data: {},
          }),
        context,
      );
      await until(() => source.closed === 1);
      await until(() => result !== undefined);
      expect(result).toMatchObject({ stopReason: "aborted" });
      gate.resolve();
      await work;
      expect(run.fake.order).toEqual(["start"]);
      expect(run.fake.requests).toEqual([
        { session: "session-1", input: [{ type: "text", text: "first" }] },
      ]);
      expect(run.fake.opened).toHaveLength(1);
      expect(source.interrupted).toBe(0);
    } finally {
      gate.resolve();
      await run.conversation.abort(context);
      await work;
      await run.close();
    }
  });
}

// The fork excludes the failed turn, so its input must replay that user's message before the retry and omit partial assistant text.
test("fork recovery replays the failed turn's user message before try again", async () => {
  const run = await fixture();
  try {
    run.fake.frames.push({ text: "full checkpoint" });
    await run.submit("first");
    run.fake.frames.push({
      beforeMessage: () =>
        run.fake.opened[0]!.session.emit({
          type: "text",
          text: "unmirrored partial",
        }),
      failure: {
        _tag: "TurnFailed",
        account: account().name,
        reason: "provider-failed",
      },
    });
    await run.submit("preserve this failed request");
    run.fake.failOpen = (start) => start.kind === "resume" && !start.fork;
    run.fake.frames.push({ text: "recovered" });
    await run.submit("try again");
    // Ruling 25(b): an incomplete turn goes directly to the pinned fork.
    expect(run.fake.failures).toEqual([]);
    expect(run.fake.opened.at(-1)?.start).toEqual({
      kind: "resume",
      session: "session-1",
      at: "point-1",
      fork: true,
    });
    expect(run.fake.requests.at(-1)?.input).toEqual([
      { type: "text", text: "preserve this failed request" },
      { type: "text", text: "try again" },
    ]);
    expect(run.fake.unrecordedRequests).toBe(0);
  } finally {
    await run.close();
  }
});

// Tool results and steers after the selected checkpoint never reached the fork and must arrive in their original order as text.
test("fork recovery replays a tool result then a steer before try again", async () => {
  const run = await fixture({
    execute: async (_n, read) => {
      await read().submit(
        { type: "input", content: "steer after result", whenBusy: "steer" },
        context,
      );
      return { content: [{ type: "text", text: "completed tool output" }] };
    },
  });
  try {
    run.fake.frames.push({ text: "full checkpoint" });
    await run.submit("first");
    run.fake.frames.push(
      { calls: [{ callId: "completed", toolName: "probe", input: { n: 2 } }] },
      {
        failure: {
          _tag: "TurnFailed",
          account: account().name,
          reason: "provider-failed",
        },
      },
    );
    await run.submit("failed turn with tool");
    run.fake.failOpen = (start) => start.kind === "resume" && !start.fork;
    run.fake.frames.push({ text: "recovered" });
    await run.submit("try again");
    expect(run.fake.opened.at(-1)?.start).toEqual({
      kind: "resume",
      session: "session-1",
      at: "point-1",
      fork: true,
    });
    expect(run.fake.requests.at(-1)?.input).toEqual([
      { type: "text", text: "failed turn with tool" },
      {
        type: "text",
        text: "probe already ran. Do not call it again. Result:\ncompleted tool output",
      },
      { type: "text", text: "steer after result" },
      { type: "text", text: "try again" },
    ]);
    expect(run.executed).toEqual([2]);
    expect(run.fake.unrecordedRequests).toBe(0);
  } finally {
    await run.close();
  }
});
