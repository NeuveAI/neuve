// Stop must preserve a reply already in flight and close the other open requests.
import { expect, test } from "bun:test";
import { ApprovalRequestsDefinition } from "@ace/channel/protocol";
import { defineDoc } from "@earendil-works/pi-durable";
import { Effect } from "effect";
import {
  caps,
  context,
  FakeRuntime,
  fixture,
  until,
} from "../../../packages/harness/tests/chat-runtime/fixture.ts";
import { approvalRecords } from "../src/workspace-chat-runtime.ts";

test("Stop keeps the delivered answer and closes the other approval", async () => {
  const fake = new FakeRuntime();
  fake.capabilities = { ...caps, approvals: true };
  const turn = Promise.withResolvers<void>();
  fake.frames.push({
    calls: [{ callId: "hold", toolName: "probe", input: { n: 1 } }],
    delayHandler: () => turn.promise,
    finishAfterResults: "end",
  });
  const run = await fixture({ fake, approvals: approvalRecords });
  const delivery = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const work = run.submit("Start the turn").catch(() => undefined);
  const chat = run.conversation.id;
  const doc = defineDoc(ApprovalRequestsDefinition);
  const records = async () =>
    (await run.harness.snapshot(doc, chat, context))?.requests ?? [];
  try {
    await until(() => fake.requests.length === 1);
    const session = fake.opened[0]!.session;
    session.respondToApproval = () =>
      Effect.promise(async () => {
        started.resolve();
        await delivery.promise;
        return { delivered: true };
      });
    for (const requestId of ["chosen", "unanswered"]) {
      session.emit({
        type: "approval.requested",
        requestId,
        callId: requestId,
        work: "command",
        input: {},
      });
    }
    await until(async () => (await records()).length === 2);
    expect((await records()).map(({ state }) => state.kind)).toEqual([
      "open",
      "open",
    ]);

    const answer = run.bridge.replyToApproval(
      chat,
      { requestId: "chosen", decision: "allow" },
      () =>
        run.harness.commit(async (tx) => {
          const { requests } = await tx.doc(doc, chat);
          const request = requests.find(
            ({ requestId }) => requestId === "chosen",
          );
          if (request?.state.kind !== "open")
            throw new Error(
              "The chosen approval closed before delivery finished.",
            );
          request.state = {
            kind: "answered",
            by: "person",
            at: 1,
            decision: "allow",
          };
        }, context),
    );
    await started.promise;
    const outcomes = Promise.allSettled([answer, run.stopApprovals()]);
    // Give Stop a turn to commit while delivery is still held.
    await new Promise<void>((resolve) => setImmediate(resolve));
    delivery.resolve();
    const settled = await outcomes;
    expect(
      (await records()).map(({ requestId, state }) => ({ requestId, state })),
    ).toEqual([
      {
        requestId: "chosen",
        state: { kind: "answered", by: "person", at: 1, decision: "allow" },
      },
      { requestId: "unanswered", state: { kind: "closed", reason: "stopped" } },
    ]);
    expect(settled).toEqual([
      { status: "fulfilled", value: true },
      { status: "fulfilled", value: undefined },
    ]);
    await run.conversation.abort(context);
  } finally {
    delivery.resolve();
    turn.resolve();
    await run.close();
    await work;
  }
});
