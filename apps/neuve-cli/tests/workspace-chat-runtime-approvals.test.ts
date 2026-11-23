// A held pi question must leave approval document commits and runtime replies running.
// This workspace also sees both work kinds and can detect drift between them.
import { expect, test } from "bun:test";
import { ApprovalAskedSchema, ApprovalRequestSchema } from "@ace/channel/frame";
import {
  ApprovalRequestsDefinition,
  type ApprovalRequest,
} from "@ace/channel/protocol";
import { defineDoc } from "@earendil-works/pi-durable";
import { STOP_ENTRY_KIND } from "@neuve/harness/chat-runtime";
import { ApprovalAsked, WorkKind } from "@neuve/runtime";
import { Queue } from "effect";
import { z } from "zod";
import { ATTENDED_SECTION as CHANNEL_ATTENDED_SECTION } from "../../../packages/channel/src/approvals.ts";
import {
  Questions,
  QuestionsDoc,
} from "../../../packages/channel/src/questions.ts";
import { ATTENDED_SECTION as BRIDGE_ATTENDED_SECTION } from "../../../packages/harness/src/chat-runtime/transcript.ts";
import { CapturedStorage } from "../../../packages/harness/tests/chat-runtime/captured-storage.ts";
import {
  caps,
  context,
  FakeRuntime,
  fixture,
  until,
} from "../../../packages/harness/tests/chat-runtime/fixture.ts";
import { approvalRecords } from "../src/workspace-chat-runtime.ts";

const doc = defineDoc(ApprovalRequestsDefinition);
const request = {
  type: "approval.requested",
  requestId: "request-1",
  callId: "work-1",
  work: "command",
  input: { command: "pwd" },
} as const;

test("the channel and bridge agree on the attendance section", () => {
  expect(CHANNEL_ATTENDED_SECTION).toBe(BRIDGE_ATTENDED_SECTION);
});

test("the channel and runtime agree on the kinds of work and approval descriptions", () => {
  type ChannelWork = Exclude<ApprovalRequest["work"], undefined>;
  true satisfies [ChannelWork] extends [WorkKind] ? true : never;
  true satisfies [WorkKind] extends [ChannelWork] ? true : never;
  expect(z.toJSONSchema(ApprovalAskedSchema)).toEqual(
    z.toJSONSchema(ApprovalAsked),
  );

  const { requestId, callId, input } = request;
  for (const work of WorkKind.options) {
    const record = {
      requestId,
      callId,
      input,
      asked: { kind: "unrecognised" },
      work,
      openedAt: 1,
      state: { kind: "open" },
    } satisfies ApprovalRequest;
    expect(ApprovalRequestSchema.parse(record)).toEqual(record);
  }
});

async function heldQuestion(storage?: CapturedStorage) {
  const fake = new FakeRuntime();
  fake.capabilities = {
    ...caps,
    ownTools: true,
    approvals: true,
    toolEndsTurn: false,
    resumeInTurn: false,
    perMessageUsage: false,
  };
  const run = await fixture({
    fake,
    approvals: approvalRecords,
    ...(storage ? { storage } : {}),
  });
  run.pi.install(new Questions(() => {}).extension);
  fake.frames.push({
    calls: [
      {
        callId: "question-1",
        toolName: "question",
        input: {
          questions: [
            {
              header: "Choice",
              question: "Which option?",
              options: [
                { label: "First", description: "Use the first option" },
              ],
              multiple: false,
            },
          ],
        },
      },
    ],
  });
  const work = run.submit("Ask the question").catch(() => undefined);
  const chat = run.conversation.id;
  try {
    await until(
      async () =>
        (await run.harness.snapshot(QuestionsDoc, chat, context))?.questions[
          "question-1"
        ] !== undefined,
    );
    const records = async () =>
      (await run.harness.snapshot(doc, chat, context))?.requests ?? [];
    return { ...run, work, chat, records, session: fake.opened[0]!.session };
  } catch (error) {
    await run.close();
    throw error;
  }
}

test("commits and forwards approvals while a question holds recording, then closes them when the runtime stream dies", async () => {
  const run = await heldQuestion();
  try {
    run.session.emit(request);
    await until(async () => (await run.records()).length === 1);
    expect(await run.records()).toEqual([
      {
        requestId: "request-1",
        callId: "work-1",
        work: "command",
        input: { command: "pwd" },
        asked: { kind: "unrecognised" },
        openedAt: Date.parse("2026-11-10T12:00:00Z"),
        state: { kind: "open" },
      },
    ]);
    expect(
      await run.bridge.replyToApproval(
        run.chat,
        { requestId: "request-1", decision: "allow" },
        () =>
          run.harness.commit(async (tx) => {
            const state = await tx.doc(doc, run.chat);
            state.requests[0]!.state = {
              kind: "answered",
              by: "person",
              at: 1,
              decision: "allow",
            };
          }, context),
      ),
    ).toBe(true);
    await until(() => run.session.approvalAnswers.length === 1);
    expect(run.session.approvalAnswers).toEqual([
      { requestId: "request-1", decision: "allow" },
    ]);

    const asked = {
      kind: "wider-access",
      paths: [{ access: "write", target: { kind: "root" } }],
      network: true,
    } satisfies ApprovalAsked;
    run.session.emit({ ...request, requestId: "request-2", asked });
    await until(async () => (await run.records()).length === 2);
    expect((await run.records())[1]?.asked).toEqual(asked);
    await run.harness.commit(async (tx) => {
      const state = await tx.doc(doc, run.chat);
      state.requests[1]!.state = {
        kind: "closed",
        reason: "message",
        by: "person",
      };
    }, context);
    await until(() => run.session.approvalAnswers.length === 2);
    expect(run.session.approvalAnswers[1]).toEqual({
      requestId: "request-2",
      decision: "deny",
    });

    run.session.emit({ ...request, requestId: "request-3" });
    await until(async () => (await run.records()).length === 3);
    Queue.endUnsafe(run.session.queue);
    await until(async () => (await run.records())[2]?.state.kind === "closed");
    expect((await run.records()).map((record) => record.state)).toEqual([
      { kind: "answered", by: "person", at: 1, decision: "allow" },
      { kind: "closed", reason: "message", by: "person" },
      { kind: "closed", reason: "turn-ended" },
    ]);
    expect(
      (await run.harness.snapshot(QuestionsDoc, run.chat, context))?.questions[
        "question-1"
      ]?.answer,
    ).toBeUndefined();
    expect(run.fake.requests).toHaveLength(1);
    expect(run.fake.results).toEqual([]);
  } finally {
    await run.close();
    await run.work;
  }
});

test.each(["runtime-resolved", "turn-ended", "stopped"] as const)(
  "closes held approvals with %s",
  async (reason) => {
    const run = await heldQuestion();
    try {
      run.session.emit(request);
      run.session.emit({ ...request, requestId: "request-2" });
      await until(async () => (await run.records()).length === 2);
      if (reason === "runtime-resolved")
        run.session.emit({ type: "approval.resolved", requestId: "request-1" });
      else if (reason === "turn-ended")
        run.session.emit({
          type: "turn.finished",
          outcome: { status: "completed" },
          resumePoint: "end",
        });
      else {
        await run.stopApprovals();
        await run.conversation.abort(context);
        await run.harness.commit(
          (tx) =>
            tx.appendEntry(run.chat, {
              kind: STOP_ENTRY_KIND,
              data: { author: "person" },
            }),
          context,
        );
      }
      await until(
        async () =>
          (await run.records()).filter(
            (record) => record.state.kind === "closed",
          ).length === (reason === "runtime-resolved" ? 1 : 2),
      );
      expect((await run.records()).map((record) => record.state)).toEqual([
        { kind: "closed", reason },
        reason === "runtime-resolved"
          ? { kind: "open" }
          : { kind: "closed", reason },
      ]);
    } finally {
      await run.close();
      await run.work;
    }
  },
);

test("attach closes approvals left open in the stored channel before any turn starts", async () => {
  const storage = new CapturedStorage();
  const source = await heldQuestion(storage);
  try {
    source.session.emit(request);
    await until(async () => (await source.records()).length === 1);
    const reopened = await fixture({
      storage: await storage.snapshot(),
      conversationId: source.chat,
      approvals: approvalRecords,
    });
    try {
      const restored = await reopened.harness.snapshot(
        doc,
        source.chat,
        context,
      );
      expect(restored?.requests.map((record) => record.state)).toEqual([
        { kind: "closed", reason: "restarted" },
      ]);
      expect(reopened.fake.opened).toEqual([]);
    } finally {
      await reopened.close();
    }
  } finally {
    await source.close();
    await source.work;
  }
});

test("logs why a request could not be closed when storage admission is sealed", async () => {
  const run = await heldQuestion();
  try {
    run.session.emit(request);
    await until(async () => (await run.records()).length === 1);
    await run.harness.close(context);
    Queue.endUnsafe(run.session.queue);
    const event = "chat-runtime.approval.close.failed";
    await until(() => run.fake.logs.some((line) => line.event === event));
    expect(run.fake.logs.find((line) => line.event === event)).toEqual({
      event,
      fields: {
        owner: String(run.chat),
        reason: "turn-ended",
        cause: "Session is closed",
      },
    });
  } finally {
    await run.close();
    await run.work;
  }
});
