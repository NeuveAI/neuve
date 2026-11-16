import { LiveDoc, type ConversationId } from "@earendil-works/pi-durable";
// Regression reason: The answer-commit/result crash cut must preserve the answer, and resumed questions must remain open.
import { expect, test } from "bun:test";
import { CapturedStorage } from "./captured-storage.ts";
import { context, fixture, until } from "./fixture.ts";
import {
  Questions,
  QuestionsDoc,
  answer,
} from "../../../channel/src/questions.ts";

// Ruling 28 names a question answer as a person's act. The attach-time abort now settles every live
// `question` tool in a gated Claude chat as "Tool question was aborted", so an answer the person
// committed is never the tool's result. Claude later reads an error instead of the answer.
const QUESTION = {
  callId: "question-call",
  toolName: "question",
  input: {
    questions: [
      {
        header: "Choice",
        question: "Which option?",
        options: [{ label: "Alpha-choice", description: "Use A" }],
        multiple: false,
      },
    ],
  },
};

async function pendingQuestion() {
  const storage = new CapturedStorage();
  const source = await fixture({ storage });
  source.pi.install(new Questions(() => {}).extension);
  source.fake.frames.push({ calls: [QUESTION] });
  const work = source.submit("ask a question").catch(() => undefined);
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
  return { storage, source, work };
}

async function reopen(
  copy: Awaited<ReturnType<CapturedStorage["snapshot"]>>,
  id: ConversationId,
) {
  const reopened = await fixture({ storage: copy, conversationId: id });
  reopened.pi.install(new Questions(() => {}).extension);
  return reopened;
}

test("an answer committed before the crash reaches Claude on the person's next message", async () => {
  const { storage, source, work } = await pendingQuestion();
  let reopened: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    const captured =
      Promise.withResolvers<Awaited<ReturnType<CapturedStorage["snapshot"]>>>();
    const stop = source.harness.subscribeCommits(({ changes }) => {
      if (
        changes.some(
          (change) =>
            change.type === "document" &&
            change.record.kind === QuestionsDoc.definition.kind &&
            change.ops.some((op) => op[0] === "s" && op[1][2] === "answer"),
        )
      )
        void storage.snapshot().then(captured.resolve, captured.reject);
    });
    await answer(
      source.harness,
      source.conversation.id,
      "question-call",
      "person",
      [{ choices: [0] }],
      context,
    );
    const copy = await captured.promise;
    stop();
    await source.close();
    await work;
    reopened = await reopen(copy, source.conversation.id);
    await reopened.harness.waitForIdle(context);
    expect(reopened.fake.requests).toEqual([]);
    reopened.fake.frames.push({ text: "continuing" });
    await reopened.submit("person: go on");
    const sent = JSON.stringify(reopened.fake.requests[0]?.input);
    // The answer is still recorded as the person's, so the desk shows it as given.
    expect(
      (
        await reopened.harness.snapshot(
          QuestionsDoc,
          reopened.conversation.id,
          context,
        )
      )?.questions["question-call"]?.answer?.author,
    ).toBe("person");
    expect(sent).not.toContain("Tool question was aborted");
    expect(sent).toContain("Alpha-choice");
  } finally {
    await reopened?.close();
    await source.close();
    await work;
  }
});

test("an answer committed after attach is what Claude receives when the gate releases", async () => {
  const { storage, source, work } = await pendingQuestion();
  let reopened: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    const copy = await storage.snapshot();
    await source.close();
    await work;
    reopened = await reopen(copy, source.conversation.id);
    reopened.fake.frames.push({ text: "answer acknowledged" });
    await answer(
      reopened.harness,
      reopened.conversation.id,
      "question-call",
      "person",
      [{ choices: [0] }],
      context,
    );
    await reopened.harness.waitForIdle(context);
    // round-12's CLI test stops at this count.
    expect(reopened.fake.requests).toHaveLength(1);
    const sent = JSON.stringify(reopened.fake.requests[0]?.input);
    expect(sent).not.toContain("Tool question was aborted");
    expect(sent).toContain("Alpha-choice");
  } finally {
    await reopened?.close();
    await source.close();
    await work;
  }
});

test("in the production order a pending question remains answerable and delivers its answer", async () => {
  const { storage, source, work } = await pendingQuestion();
  let reopened: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    const copy = await storage.snapshot();
    await source.close();
    await work;
    reopened = await reopen(copy, source.conversation.id);
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
    reopened.fake.frames.push({ text: "answer acknowledged" });
    await answer(
      reopened.harness,
      reopened.conversation.id,
      "question-call",
      "person",
      [{ choices: [0] }],
      context,
    );
    await reopened.harness.waitForIdle(context);
    expect(reopened.fake.requests).toHaveLength(1);
    expect(JSON.stringify(reopened.fake.requests[0]?.input)).toContain(
      "Alpha-choice",
    );
  } finally {
    await reopened?.close();
    await source.close();
    await work;
  }
});
