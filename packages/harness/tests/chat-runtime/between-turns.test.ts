// Why: a runtime that runs its own loop but resumes only between turns, ends no turn from a tool
// and reports no per-message usage still serves coding chats. The bridge must keep no resume point
// inside a turn, and recover a failed turn from the last completed one, handing the lost part over
// as text, never running a completed call again.
import { expect, test } from "bun:test";
import type { ContentBlock } from "@neuve/runtime";
import { resumeFailed } from "../../src/chat-runtime/failure.ts";
import { HANDOFF_TOKENS, handoff } from "../../src/chat-runtime/handoff.ts";
import {
  FakeRuntime,
  account,
  caps,
  context,
  fixture,
  until,
} from "./fixture.ts";

const betweenTurns = () => {
  const fake = new FakeRuntime();
  fake.capabilities = {
    ...caps,
    toolEndsTurn: false,
    resumeInTurn: false,
    perMessageUsage: false,
  };
  return fake;
};
const failed = (run: Awaited<ReturnType<typeof fixture>>) => ({
  failure: {
    _tag: "TurnFailed" as const,
    account: run.statuses.values[0]!.name,
    reason: "provider-failed" as const,
  },
});
const call = (callId: string, n: number) => ({
  calls: [{ callId, toolName: "probe", input: { n } }],
});
const text = (input: unknown) =>
  (input as ContentBlock[])
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("\n");

// Reason: chats need only "runs its own loop", so the account is offered and a turn completes.
test("a runtime that resumes only between turns serves a chat turn", async () => {
  const run = await fixture({ fake: betweenTurns() });
  try {
    expect(run.models.getModel("subscription", "sonnet")).toBeDefined();
    run.fake.frames.push({ text: "hello" });
    expect((await run.submit("first")).status).toBe("done");
    expect(run.fake.opened).toHaveLength(1);
    expect(run.heads.get(String(run.conversation.id))).toMatchObject({
      session: "session-1",
      resumePoint: "point-1",
      completed: true,
    });
  } finally {
    await run.close();
  }
});

// Reason: the runtime cannot resume inside a turn, so a head there would point at nothing it can open.
test("no head is recorded inside a turn, only at its end", async () => {
  const points: Array<string | undefined> = [];
  let read = () => undefined as string | undefined;
  const run = await fixture({
    fake: betweenTurns(),
    execute: async (n) => {
      points.push(read());
      return { content: [{ type: "text", text: `result-${n}` }] };
    },
  });
  read = () => run.heads.get(String(run.conversation.id))?.resumePoint;
  try {
    run.fake.frames.push(call("one", 1), call("two", 2), { text: "done" });
    expect((await run.submit("first")).status).toBe("done");
    expect(points).toEqual([undefined, undefined]);
    expect(run.heads.get(String(run.conversation.id))).toMatchObject({
      resumePoint: "point-3",
      completed: true,
    });
    expect(run.executed).toEqual([1, 2]);
  } finally {
    await run.close();
  }
});

// Reason: when the process dies inside a turn, the turn's output exists only in Neuve's transcript;
// the next turn forks at the last completed turn and gets that output as text, not a rerun.
test("after the process dies inside a turn, the next turn forks at the last completed turn with the lost part as text", async () => {
  const run = await fixture({ fake: betweenTurns() });
  try {
    run.fake.frames.push({ text: "one" });
    await run.submit("first");
    run.fake.frames.push(call("lost", 7), failed(run));
    await run.submit("second");
    await until(() => run.fake.opened[0]!.session.closed === 1);
    expect(run.executed).toEqual([7]);
    run.fake.frames.push({ text: "recovered" });
    expect((await run.submit("third")).status).toBe("done");
    expect(run.fake.opened[1]!.start).toEqual({
      kind: "resume",
      session: "session-1",
      at: "point-1",
      fork: true,
    });
    const sent = text(run.fake.requests.at(-1)!.input);
    expect(sent).toStartWith("second\nPrevious conversation, newest first.");
    expect(sent).toContain('"id":"lost"');
    expect(sent).toContain("probe already ran. Do not call it again.");
    expect(sent).toContain("result-7");
    expect(sent).toEndWith("third");
    expect(run.executed).toEqual([7]);
  } finally {
    await run.close();
  }
});

// Reason: a fork that cannot be opened must fail visibly, and nothing may run in its place.
test("a resume that fails ends the turn without a new session or a rerun", async () => {
  const run = await fixture({ fake: betweenTurns() });
  try {
    run.fake.frames.push({ text: "one" });
    await run.submit("first");
    run.fake.frames.push(call("lost", 7), failed(run));
    await run.submit("second");
    await until(() => run.fake.opened[0]!.session.closed === 1);
    run.fake.failOpen = (start) => start.kind === "resume";
    await run.submit("third");
    expect(run.fake.failures).toEqual([
      { kind: "resume", session: "session-1", at: "point-1", fork: true },
    ]);
    expect(run.fake.opened).toHaveLength(1);
    const last = (await run.conversation.context(context)).entries
      .flatMap((entry) => entry.model ?? [])
      .findLast((message) => message.role === "assistant");
    expect(last?.role === "assistant" && last.errorMessage).toBe(resumeFailed);
    expect(run.executed).toEqual([7]);
  } finally {
    await run.close();
  }
});

// Reason: a first turn that fails has no completed turn to resume, so the next starts fresh and
// still hands the lost part over as text.
test("a failed first turn starts a new session with the lost part as text", async () => {
  const run = await fixture({ fake: betweenTurns() });
  try {
    run.fake.frames.push(call("lost", 3), failed(run));
    await run.submit("first");
    await until(() => run.fake.opened[0]!.session.closed === 1);
    run.fake.frames.push({ text: "recovered" });
    expect((await run.submit("second")).status).toBe("done");
    expect(run.fake.opened[1]!.start).toEqual({ kind: "new" });
    const sent = text(run.fake.requests.at(-1)!.input);
    expect(sent).toStartWith("first\nPrevious conversation, newest first.");
    expect(sent).toContain("probe already ran. Do not call it again.");
    expect(sent).toEndWith("second");
    expect(run.executed).toEqual([3]);
  } finally {
    await run.close();
  }
});

// Reason: when the process dies while a call is held, pi's next request ends in that call's result
// with no new message, so the lost turn's own request must still arrive as the instruction.
test("a process that dies while a call is held resumes with the turn's request and the result already run", async () => {
  const gate = Promise.withResolvers<void>();
  let held = false;
  const run = await fixture({
    fake: betweenTurns(),
    execute: async (n) => {
      if (held) await gate.promise;
      return { content: [{ type: "text", text: `result-${n}` }] };
    },
  });
  try {
    run.fake.frames.push({ text: "one" });
    await run.submit("first");
    held = true;
    run.fake.frames.push(call("held", 5));
    const work = run.submit("second");
    await until(() => run.executed.length === 1);
    const session = run.fake.opened[0]!.session;
    session.emit({
      type: "turn.finished",
      outcome: {
        status: "failed",
        failure: failed(run).failure,
        disposition: "broken",
      },
    });
    await until(() => session.closed === 1);
    run.fake.frames.push({ text: "recovered" });
    gate.resolve();
    expect((await work).status).toBe("done");
    expect(run.fake.opened[1]!.start).toEqual({
      kind: "resume",
      session: "session-1",
      at: "point-1",
      fork: true,
    });
    const sent = text(run.fake.requests.at(-1)!.input);
    expect(sent).toStartWith("second\nPrevious conversation, newest first.");
    expect(sent).toContain('"id":"held"');
    // The hand-over is JSON, newest first: the held call's result is the first item it keeps.
    expect(sent).toContain(
      '{"type":"text","text":"probe already ran. Do not call it again. Result:\\nresult-5"}',
    );
    expect(run.executed).toEqual([5]);
  } finally {
    gate.resolve();
    await run.close();
  }
});

// Reason: the hand-over for a change of account keeps a budget and drops what does not fit; a lost
// turn's results must all arrive, or the model could ask for a completed call again.
test("a lost result larger than the hand-over budget still arrives in full", async () => {
  const large = "x".repeat(HANDOFF_TOKENS * 2);
  const run = await fixture({
    fake: betweenTurns(),
    execute: async () => ({ content: [{ type: "text", text: large }] }),
  });
  try {
    run.fake.frames.push({ text: "one" });
    await run.submit("first");
    run.fake.frames.push(call("big", 9), failed(run));
    await run.submit("second");
    await until(() => run.fake.opened[0]!.session.closed === 1);
    run.fake.frames.push({ text: "recovered" });
    expect((await run.submit("third")).status).toBe("done");
    const sent = text(run.fake.requests.at(-1)!.input);
    expect(sent).toContain('"id":"big"');
    expect(sent).toContain(
      `probe already ran. Do not call it again. Result:\\n${large}`,
    );
    expect(run.executed).toEqual([9]);
  } finally {
    await run.close();
  }
});

// Reason: an ordinary change of account must not take the lost-turn path: the new account gets the
// budgeted hand-over of the conversation, never its first message again as a live instruction.
test("an account change onto such a runtime sends the budgeted hand-over", async () => {
  const run = await fixture({
    fake: betweenTurns(),
    accounts: [account(), account("other", "different")],
  });
  try {
    run.fake.frames.push({ text: "one" });
    await run.submit("first");
    run.fake.frames.push({ text: "two" });
    await run.submit("second");
    await run.conversation.configure(
      { model: { provider: "other", modelId: "sonnet" } },
      context,
    );
    run.fake.frames.push({ text: "three" });
    expect((await run.submit("switch")).status).toBe("done");
    expect(run.fake.opened[1]).toMatchObject({
      account: "other",
      start: { kind: "new" },
    });
    expect(run.fake.requests.at(-1)!.input).toEqual(
      handoff((await run.messages()).slice(0, -1)),
    );
  } finally {
    await run.close();
  }
});

// Reason: without this conversation's own head the bridge cannot prove what a lost turn was, so it
// keeps today's message: the inputs after the transcript's last completed turn, nothing re-sent.
test("with the heads store lost, a failed turn is not handed over again", async () => {
  const run = await fixture({ fake: betweenTurns() });
  try {
    run.fake.frames.push({ text: "one" });
    await run.submit("first");
    run.fake.frames.push(call("lost", 7), failed(run));
    await run.submit("second");
    await until(() => run.fake.opened[0]!.session.closed === 1);
    await run.bridge.closeConversation(String(run.conversation.id), true);
    expect(run.heads.get(String(run.conversation.id))).toBeUndefined();
    run.fake.frames.push({ text: "recovered" });
    expect((await run.submit("third")).status).toBe("done");
    expect(run.fake.requests.at(-1)!.input).toEqual([
      { type: "text", text: "second" },
      {
        type: "text",
        text: "probe already ran. Do not call it again. Result:\nresult-7",
      },
      { type: "text", text: "third" },
    ]);
    expect(run.executed).toEqual([7]);
  } finally {
    await run.close();
  }
});

// Reason: a head recorded under another continuation belongs to another native lineage, so it is
// no proof of a lost turn either, and the message stays as today.
test("with a head from another continuation, a failed turn is not handed over again", async () => {
  const run = await fixture({ fake: betweenTurns() });
  try {
    run.fake.frames.push({ text: "one" });
    await run.submit("first");
    run.fake.frames.push(call("lost", 7), failed(run));
    await run.submit("second");
    await until(() => run.fake.opened[0]!.session.closed === 1);
    const owner = String(run.conversation.id);
    await run.heads.set(owner, {
      ...run.heads.get(owner)!,
      continuation: { runtime: "claude-code", key: "/elsewhere" },
    });
    run.fake.frames.push({ text: "recovered" });
    expect((await run.submit("third")).status).toBe("done");
    expect(text(run.fake.requests.at(-1)!.input)).not.toContain(
      "Previous conversation",
    );
    expect(run.fake.requests.at(-1)!.input).toEqual([
      { type: "text", text: "second" },
      {
        type: "text",
        text: "probe already ran. Do not call it again. Result:\nresult-7",
      },
      { type: "text", text: "third" },
    ]);
  } finally {
    await run.close();
  }
});

// Reason: the contract requires such a runtime to end a completed turn with its resume point;
// without it nothing proves what the native session holds, so the turn fails, no head is left to
// fork a stale turn from, and the next turn starts from the transcript's last completed turn.
test("a completed turn without its resume point is a protocol fault that leaves no head", async () => {
  const run = await fixture({ fake: betweenTurns() });
  try {
    run.fake.frames.push({ text: "one" });
    await run.submit("first");
    run.fake.frames.push({ text: "two", omitTurnPoint: true });
    await run.submit("second");
    await until(() => run.fake.opened[0]!.session.closed === 1);
    expect(run.fake.logs).toContainEqual({
      event: "chat-runtime.protocol.fault",
      fields: { reason: "turn-ended-without-resume-point" },
    });
    expect(run.heads.get(String(run.conversation.id))).toBeUndefined();
    run.fake.frames.push({ text: "recovered" });
    expect((await run.submit("third")).status).toBe("done");
    expect(run.fake.opened[1]!.start).toEqual({
      kind: "resume",
      session: "session-1",
      at: "point-1",
      fork: true,
    });
    expect(run.fake.requests.at(-1)!.input).toEqual([
      { type: "text", text: "second" },
      { type: "text", text: "third" },
    ]);
  } finally {
    await run.close();
  }
});

const directAnswer = (run: Awaited<ReturnType<typeof fixture>>, text: string) =>
  run.faux.appendResponses([
    {
      role: "assistant",
      provider: "faux",
      api: "faux",
      model: "coder",
      content: [{ type: "text", text }],
      stopReason: "stop",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      timestamp: 0,
    } as never,
  ]);
const onDirect = (run: Awaited<ReturnType<typeof fixture>>) =>
  run.conversation.configure(
    { model: { provider: "faux", modelId: "coder" } },
    context,
  );
const onRuntime = (run: Awaited<ReturnType<typeof fixture>>) =>
  run.conversation.configure(
    { model: { provider: "subscription", modelId: "sonnet" } },
    context,
  );

// Reason: a turn answered on a direct route carries no native completion marker, so the lost turn
// must start where this conversation's own head says its first input began; the finished direct
// request is history in the budgeted hand-over, never a live instruction again.
test("after direct-route turns, a failed runtime turn hands over only itself as the instruction", async () => {
  const run = await fixture({ fake: betweenTurns() });
  try {
    await onDirect(run);
    directAnswer(run, "pi answer");
    expect((await run.submit("DELETE-THE-BRANCH")).status).toBe("done");
    directAnswer(run, "pi again");
    expect((await run.submit("another direct")).status).toBe("done");
    await onRuntime(run);
    run.fake.frames.push(call("lost", 7), failed(run));
    await run.submit("second");
    await until(() => run.fake.opened[0]!.session.closed === 1);
    run.fake.frames.push({ text: "recovered" });
    expect((await run.submit("third")).status).toBe("done");
    expect(run.fake.opened[1]!.start).toEqual({ kind: "new" });
    const sent = run.fake.requests.at(-1)!.input as ContentBlock[];
    const blocks = sent.map((block) =>
      block.type === "text" ? block.text : "",
    );
    // History first, as context; the instruction is the failed turn's own request.
    expect(blocks[0]).toStartWith("Previous conversation, newest first.");
    expect(blocks[0]).toContain("DELETE-THE-BRANCH");
    expect(blocks[1]).toBe("second");
    expect(blocks[2]).toStartWith("Previous conversation, newest first.");
    expect(blocks[2]).toContain('"id":"lost"');
    expect(blocks[2]).not.toContain("DELETE-THE-BRANCH");
    expect(blocks.at(-1)).toBe("third");
    expect(
      blocks.filter((block) => block === "DELETE-THE-BRANCH"),
    ).toHaveLength(0);
    expect(run.executed).toEqual([7]);
  } finally {
    await run.close();
  }
});

// Reason: a neighbour of the case above: several runtime turns after the direct ones; the lost
// turn follows the last completed runtime turn, which the new session forks from, so no history
// is handed over at all.
test("after direct and completed runtime turns, a failed turn forks at the last completed one", async () => {
  const run = await fixture({ fake: betweenTurns() });
  try {
    await onDirect(run);
    directAnswer(run, "pi answer");
    await run.submit("DELETE-THE-BRANCH");
    await onRuntime(run);
    run.fake.frames.push({ text: "one" });
    await run.submit("first");
    run.fake.frames.push({ text: "two" });
    await run.submit("REPEAT-ME");
    run.fake.frames.push(call("lost", 7), failed(run));
    await run.submit("second");
    await until(() => run.fake.opened[0]!.session.closed === 1);
    run.fake.frames.push({ text: "recovered" });
    expect((await run.submit("third")).status).toBe("done");
    expect(run.fake.opened[1]!.start).toMatchObject({
      kind: "resume",
      session: "session-1",
      fork: true,
    });
    const sent = text(run.fake.requests.at(-1)!.input);
    expect(sent).toStartWith("second\nPrevious conversation, newest first.");
    expect(sent).not.toContain("DELETE-THE-BRANCH");
    expect(sent).not.toContain("REPEAT-ME");
  } finally {
    await run.close();
  }
});

// Reason: another neighbour: the first runtime turn fails before any output, so nothing was lost
// but its request; the direct history still goes only through the budgeted hand-over.
test("after a direct-route turn, a runtime turn that fails before any output resends only its request", async () => {
  const run = await fixture({ fake: betweenTurns() });
  try {
    await onDirect(run);
    directAnswer(run, "pi answer");
    await run.submit("DELETE-THE-BRANCH");
    await onRuntime(run);
    run.fake.frames.push(failed(run));
    await run.submit("second");
    await until(() => run.fake.opened[0]!.session.closed === 1);
    run.fake.frames.push({ text: "recovered" });
    expect((await run.submit("third")).status).toBe("done");
    const blocks = (run.fake.requests.at(-1)!.input as ContentBlock[]).map(
      (block) => (block.type === "text" ? block.text : ""),
    );
    expect(blocks[0]).toStartWith("Previous conversation, newest first.");
    expect(blocks[0]).toContain("DELETE-THE-BRANCH");
    expect(blocks.slice(1)).toEqual(["second", "third"]);
  } finally {
    await run.close();
  }
});

// Reason: a neighbour: switching from one such runtime account to another and back changes
// continuation each time, so each switch takes the budgeted hand-over, and a later failed turn
// still hands over only itself as the instruction.
test("switching between two such accounts and back keeps earlier requests out of the instruction", async () => {
  const run = await fixture({
    fake: betweenTurns(),
    accounts: [account(), account("other", "different")],
  });
  const to = (provider: string) =>
    run.conversation.configure(
      { model: { provider, modelId: "sonnet" } },
      context,
    );
  try {
    run.fake.frames.push({ text: "one" });
    await run.submit("DELETE-THE-BRANCH");
    await to("other");
    run.fake.frames.push({ text: "two" });
    await run.submit("on other");
    await to("subscription");
    run.fake.frames.push(call("lost", 7), failed(run));
    await run.submit("second");
    await until(() => run.fake.opened.at(-1)!.session.closed === 1);
    run.fake.frames.push({ text: "recovered" });
    expect((await run.submit("third")).status).toBe("done");
    const blocks = (run.fake.requests.at(-1)!.input as ContentBlock[]).map(
      (block) => (block.type === "text" ? block.text : ""),
    );
    expect(blocks[0]).toStartWith("Previous conversation, newest first.");
    expect(blocks[0]).toContain("DELETE-THE-BRANCH");
    expect(blocks[1]).toBe("second");
    expect(blocks.at(-1)).toBe("third");
    expect(blocks.filter((block) => block === "DELETE-THE-BRANCH")).toEqual([]);
    expect(run.executed).toEqual([7]);
  } finally {
    await run.close();
  }
});
