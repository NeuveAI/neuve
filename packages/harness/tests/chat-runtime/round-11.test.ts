import { expect, test } from "bun:test";
import { MemoryStorage, type StorageWrite } from "@earendil-works/pi-durable";
import { pointer, responseId } from "../../src/chat-runtime/transcript.ts";
import { context, fixture, until } from "./fixture.ts";

class CapturedStorage extends MemoryStorage {
  readonly commits: (readonly StorageWrite[])[] = [];
  override async commit(...args: Parameters<MemoryStorage["commit"]>) {
    const seq = await super.commit(...args);
    this.commits.push(structuredClone(args[0]));
    return seq;
  }
  async snapshot() {
    const copy = new MemoryStorage();
    for (const writes of [...this.commits]) await copy.commit(writes, context);
    return copy;
  }
}

// Queued follow-ups become new runs, so the reopening gate must survive task and run changes.
for (const explicit of [false, true]) {
  test(`queued input on reopen ${explicit ? "runs once after a new person submission" : "stops without opening or sending"}`, async () => {
    const storage = new CapturedStorage();
    const source = await fixture({
      storage,
      toolName: "read",
      execute: async (_n, _read, signal) => {
        await new Promise<void>((resolve) =>
          signal?.addEventListener("abort", () => resolve(), { once: true }),
        );
        return {
          content: [{ type: "text", text: "old result" }],
          control: { terminate: true },
        };
      },
    });
    let reopened: Awaited<ReturnType<typeof fixture>> | undefined;
    source.fake.frames.push({
      calls: [{ callId: "c1", toolName: "read", input: { n: 1 } }],
    });
    const work = source.submit("original request").catch(() => undefined);
    try {
      await until(() => source.executed.length === 1);
      await source.conversation.submit(
        {
          type: "input",
          content: "queued before attach",
          whenBusy: "followUp",
        },
        context,
      );
      const copy = await storage.snapshot();
      await source.close();
      await work;
      reopened = await fixture({
        storage: copy,
        toolName: "read",
        conversationId: source.conversation.id,
        execute: async () => ({
          content: [{ type: "text", text: "recovered result" }],
          control: { terminate: true },
        }),
      });
      reopened.fake.frames.push(
        // The allowlisted read reruns and terminates its old run before the queued inputs.
        { text: "queued answer" },
        { text: "explicit answer" },
      );
      if (explicit) {
        expect((await reopened.submit("person just sent this")).status).toBe(
          "done",
        );
        expect(reopened.fake.opened).toHaveLength(1);
        expect(reopened.fake.requests).toHaveLength(2);
        const sent = JSON.stringify(
          reopened.fake.requests.map((request) => request.input),
        );
        expect(sent.match(/person just sent this/g)).toHaveLength(1);
        expect(sent.match(/queued before attach/g)).toHaveLength(1);
      } else {
        await reopened.harness.waitForIdle(context);
        expect(reopened.fake.opened).toEqual([]);
        expect(reopened.fake.requests).toEqual([]);
        const stopped = (await reopened.conversation.context(context)).entries
          .flatMap((entry) => entry.model ?? [])
          .findLast((message) => message.role === "assistant");
        expect(stopped?.stopReason).toBe("aborted");
      }
    } finally {
      await reopened?.close();
      await source.close();
      await work;
    }
  });
}

// A stopped turn proves none of its inputs stored, even after two checkpoints advance past its steer.
for (const seed of [false, true]) {
  test(`${seed ? "seed with only completed flags" : "source with input receipts"} forks before uncertain input and gives every item once`, async () => {
    let calls = 0;
    const run = await fixture({
      execute: async (n, read, signal) => {
        calls++;
        if (n === 1)
          await read().submit(
            { type: "input", content: "held steer", whenBusy: "steer" },
            context,
          );
        if (n === 3)
          await new Promise<void>((resolve) =>
            signal?.addEventListener("abort", () => resolve(), { once: true }),
          );
        return { content: [{ type: "text", text: `result-${n}` }] };
      },
    });
    let work: ReturnType<typeof run.submit> | undefined;
    try {
      run.fake.frames.push({
        text: "completed answer",
        resumePoint: "completed-base",
      });
      await run.submit("stored input");
      const completed = (await run.messages()).findLast(
        (message) => message.role === "assistant",
      );
      expect(completed?.responseId).toBe("native:session-1:completed-base:c");
      run.fake.frames.push(
        ...[1, 2, 3].map((n) => ({
          resumePoint: `checkpoint-${n}`,
          calls: [{ callId: `c${n}`, toolName: "probe", input: { n } }],
        })),
      );
      work = run.submit("uncertain turn message");
      await until(() => calls === 3);
      const pending = run.heads.get(String(run.conversation.id));
      expect(pending?.inputs?.map((input) => input.kind)).toEqual([
        "message",
        "steer",
        "result",
        "result",
      ]);
      expect(pending?.inputs?.[0]?.before?.resumePoint).toBe("completed-base");
      expect(pending?.inputs?.[1]?.before?.resumePoint).toBe("checkpoint-1");
      await run.conversation.abort(context);
      await run.bridge.closeConversation(String(run.conversation.id));
      await work;
      let conversation = run.conversation;
      if (seed) {
        const transcript = await run.messages();
        conversation = await run.harness.createConversation(
          {
            ownership: { kind: "ownerless" },
            agent: { model: { provider: "subscription", modelId: "sonnet" } },
          },
          context,
        );
        await (
          await conversation.submit(
            { type: "write", entry: { kind: "import", model: transcript } },
            context,
          )
        ).wait(context);
        expect(run.heads.get(String(conversation.id))).toBeUndefined();
      }
      run.fake.frames.push({ text: "recovered answer" });
      expect(
        (
          await (
            await conversation.submit(
              { type: "input", content: "continue now" },
              context,
            )
          ).wait(context)
        ).status,
      ).toBe("done");
      expect(run.fake.opened.at(-1)?.start).toEqual({
        kind: "resume",
        session: "session-1",
        at: "completed-base",
        fork: true,
      });
      const input = run.fake.requests.at(-1)?.input;
      expect(input).toEqual([
        { type: "text", text: "uncertain turn message" },
        {
          type: "text",
          text: "probe already ran. Do not call it again. Result:\nresult-1",
        },
        { type: "text", text: "held steer" },
        {
          type: "text",
          text: "probe already ran. Do not call it again. Result:\nresult-2",
        },
        {
          type: "text",
          text: "The probe call returned an error: <harness>\n[error] Tool probe was aborted\n</harness>",
        },
        { type: "text", text: "continue now" },
      ]);
      expect(run.executed).toEqual([1, 2, 3]);
    } finally {
      await run.close();
      await work;
    }
  });
}

// Legacy pointers remain readable, but only a completed flag authorizes transcript-only recovery.
test("old pointer parsing and completed pointer rendering share one format", async () => {
  const run = await fixture();
  try {
    run.fake.frames.push({ text: "answer" });
    await run.submit("message");
    const answer = (await run.messages()).findLast(
      (message) => message.role === "assistant",
    )!;
    expect(
      pointer({ ...answer, responseId: "native:old-session:old-point" }),
    ).toEqual({ session: "old-session", resumePoint: "old-point" });
    expect(pointer({ ...answer, responseId: "native:old-session:" })).toEqual({
      session: "old-session",
    });
    expect(
      pointer({ ...answer, responseId: responseId("session", "point", true) }),
    ).toEqual({ session: "session", resumePoint: "point", completed: true });
  } finally {
    await run.close();
  }
});
