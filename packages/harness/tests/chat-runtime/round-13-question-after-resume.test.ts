import { LiveDoc, type ConversationId } from "@earendil-works/pi-durable";
// Regression reason: A question stays answerable after scheduling resumes and delivers that answer to the runtime.
import { expect, test } from "bun:test";
import { MemoryStorage, type StorageWrite } from "@earendil-works/pi-durable";
import {
  Questions,
  QuestionsDoc,
  answer,
} from "../../../channel/src/questions.ts";
import { context, fixture, until } from "./fixture.ts";

class CapturedStorage extends MemoryStorage {
  commits: (readonly StorageWrite[])[] = [];
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

// A question-card answer is an explicit person action, committed via QuestionsDoc rather than a submission.
test("an explicit answer after reopen releases the conversation restart gate", async () => {
  const storage = new CapturedStorage();
  const source = await fixture({ storage });
  source.pi.install(new Questions(() => {}).extension);
  source.fake.frames.push({
    calls: [
      {
        callId: "question-call",
        toolName: "question",
        input: {
          questions: [
            {
              header: "Choice",
              question: "Which option?",
              options: [{ label: "A", description: "Use A" }],
              multiple: false,
            },
          ],
        },
      },
    ],
  });
  let reopened: Awaited<ReturnType<typeof fixture>> | undefined;
  const work = source.submit("ask a question").catch(() => undefined);
  try {
    await until(
      async () =>
        !!(
          await source.harness.snapshot(
            QuestionsDoc,
            source.conversation.id,
            context,
          )
        )?.questions["question-call"],
    );
    const copy = await storage.snapshot();
    await source.close();
    await work;
    reopened = await fixture({
      storage: copy,
      conversationId: source.conversation.id,
    });
    reopened.pi.install(new Questions(() => {}).extension);
    const replies: Promise<unknown>[] = [];
    const stream = reopened.bridge.stream.bind(reopened.bridge);
    reopened.bridge.stream = (...args) => {
      const result = stream(...args);
      replies.push(result.result());
      return result;
    };
    reopened.fake.frames.push({ text: "answer acknowledged" });
    await reopened.harness.resume();
    await until(
      async () =>
        (
          await reopened!.harness.snapshot(
            LiveDoc,
            reopened!.conversation.id,
            context,
          )
        )?.tools?.some(
          (slot) => slot.name === "question" && slot.status === "running",
        ) === true,
    );
    await answer(
      reopened.harness,
      reopened.conversation.id,
      "question-call",
      "person",
      [{ choices: [0] }],
      context,
    );
    await reopened.harness.waitForIdle(context);
    const messages = await reopened.messages();

    expect(reopened.fake.requests).toHaveLength(1);
    expect(
      messages.findLast((message) => message.role === "assistant")?.stopReason,
    ).toBe("stop");
    expect(JSON.stringify(reopened.fake.requests[0]?.input)).toContain(
      "answeredBy",
    );
    expect(JSON.stringify(reopened.fake.requests[0]?.input)).toContain(
      "choices",
    );
  } finally {
    await reopened?.close();
    await source.close();
    await work;
  }
});

test("control: the same question answer continues a chat without a reopen", async () => {
  const run = await fixture();
  run.pi.install(new Questions(() => {}).extension);
  run.fake.frames.push(
    {
      calls: [
        {
          callId: "question-call",
          toolName: "question",
          input: {
            questions: [
              {
                header: "Choice",
                question: "Which option?",
                options: [{ label: "A", description: "Use A" }],
                multiple: false,
              },
            ],
          },
        },
      ],
    },
    { text: "answer acknowledged" },
  );
  const work = run.submit("ask a question");
  try {
    await until(
      async () =>
        !!(
          await run.harness.snapshot(QuestionsDoc, run.conversation.id, context)
        )?.questions["question-call"],
    );
    await answer(
      run.harness,
      run.conversation.id,
      "question-call",
      "person",
      [{ choices: [0] }],
      context,
    );
    expect((await work).status).toBe("done");
    expect(run.fake.requests).toHaveLength(2);
    expect(JSON.stringify(run.fake.results)).toContain("answeredBy");
    expect(JSON.stringify(run.fake.results)).toContain("choices");
  } finally {
    await run.close();
    await work;
  }
});
