// Why: a runtime that runs its own loop but resumes only between turns, ends no turn from a tool
// and reports usage only per turn still serves coding chats. Each row below is one way a turn can
// end or continuity can break, under the rule record 0017 states for such a runtime, and asserts
// what the runtime received: where the session opened, what was handed over as context (the
// "may already have run" sentence where a turn was interrupted, and nothing past the budget), and
// the live instruction exactly. Claude Code's path is the other suites' subject.
import { expect, test } from "bun:test";
import type { ContentBlock, SessionStart } from "@neuve/runtime";
import { STOP_ENTRY_KIND } from "../../src/chat-runtime/extension.ts";
import {
  interrupted,
  resumeFailed,
  terminalText,
} from "../../src/chat-runtime/failure.ts";
import {
  HANDOFF_TOKENS,
  MAY_HAVE_RUN,
  handoff,
} from "../../src/chat-runtime/handoff.ts";
import {
  FakeRuntime,
  account,
  caps,
  context,
  fixture,
  until,
} from "./fixture.ts";

type Run = Awaited<ReturnType<typeof fixture>>;
const runtimeWith = (resumeInTurn: boolean) => {
  const fake = new FakeRuntime();
  if (!resumeInTurn)
    fake.capabilities = {
      ...caps,
      toolEndsTurn: false,
      resumeInTurn: false,
      perMessageUsage: false,
    };
  return fake;
};
type Reason =
  | "provider-failed"
  | "context-overflow"
  | "turn-limit-reached"
  | "session-stopped"
  | "previous-turn-active";
const failure = (run: Run, reason: Reason = "provider-failed") => ({
  _tag: "TurnFailed" as const,
  account: run.statuses.values[0]!.name,
  reason,
});
const failed = (
  run: Run,
  reason: Reason = "provider-failed",
  disposition: "reusable" | "broken" = "broken",
) => ({ failure: failure(run, reason), disposition });
const call = (callId: string, n: number) => ({
  calls: [{ callId, toolName: "probe", input: { n } }],
});
const texts = (input: unknown) =>
  (input as ContentBlock[]).map((block) =>
    block.type === "text" ? block.text : "",
  );
const HISTORY = "Previous conversation, newest first.";

test.each([
  ["plan_write", false],
  ["plan_write", true],
  ["plan_enter", false],
  ["plan_enter", true],
] as const)(
  "handover only warns after a failed standalone %s call (error: %s)",
  async (toolName, isError) => {
    const fake = runtimeWith(false);
    fake.capabilities.ownTools = true;
    const run = await fixture({
      fake,
      toolName,
      execute: async () => ({
        content: [{ type: "text", text: "Plan result" }],
        isError,
        control: { terminate: true },
      }),
    });
    try {
      fake.frames.push({
        calls: [{ callId: "plan", toolName, input: { n: 1 } }],
      });
      await run.submit("Write the plan");
      await closed(run, 0);
      fake.frames.push({ text: "Follow-up done." });
      await run.submit("Continue");
      const handedOver = texts(fake.requests.at(-1)?.input).find((text) =>
        text.startsWith(HISTORY),
      );
      expect(handedOver).toContain("Plan result");
      expect(handedOver?.includes(MAY_HAVE_RUN)).toBe(isError);
      expect(fake.opened[1]?.start).toEqual({ kind: "new" });
    } finally {
      await run.close();
    }
  },
);

const usage0 = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
/** pi's own loop answers on a direct route; "length" is a reply cut at its token limit. */
const directAnswer = (run: Run, text: string, stopReason = "stop") =>
  run.faux.appendResponses([
    {
      role: "assistant",
      provider: "faux",
      api: "faux",
      model: "coder",
      content: [{ type: "text", text }],
      stopReason,
      usage: usage0,
      timestamp: 0,
      ...(stopReason === "error" ? { errorMessage: "direct failure" } : {}),
    } as never,
  ]);
const to = (run: Run, provider: string, modelId = "sonnet") =>
  run.conversation.configure({ model: { provider, modelId } }, context);
const closed = (run: Run, index: number) =>
  until(() => run.fake.opened[index]!.session.closed === 1);
const closedLast = (run: Run) =>
  until(() => run.fake.opened.at(-1)!.session.closed === 1);
const lastAssistant = async (run: Run) =>
  (await run.conversation.context(context)).entries
    .flatMap((entry) => entry.model ?? [])
    .findLast((message) => message.role === "assistant");
/** pi compacts the history into a summary it writes as the context's first message. */
const compact = async (run: Run, summary: string) => {
  directAnswer(run, summary);
  const task = await run.conversation.compact(undefined, context);
  expect(
    (await run.harness.waitForTask(task, context)).state.outcome,
  ).toMatchObject({ status: "completed" });
};
/** pi's own edit of an earlier entry: its model messages omitted, or replaced. */
const editEntry = async (
  run: Run,
  match: (message: Awaited<ReturnType<Run["messages"]>>[number]) => boolean,
  replacement?: (message: never) => unknown,
) => {
  const entry = (await run.conversation.context(context)).entries.find((item) =>
    item.model?.some(match),
  )!;
  await (
    await run.conversation.submit(
      {
        type: "write",
        entry: {
          kind: "neuve.test-edit",
          edits: [
            replacement === undefined
              ? { target: entry.id, action: "omit" }
              : {
                  target: entry.id,
                  action: "replace",
                  messages: entry.model!.map((message) =>
                    replacement(message as never),
                  ),
                },
          ],
        },
      } as never,
      context,
    )
  ).wait(context);
};
const fork = (at: string) => ({
  kind: "resume" as const,
  session: "session-1",
  at,
  fork: true,
});
const bigRequest = `REQUEST-${"q".repeat(40_000)}`;
const id = (callId: string) => `"id":"${callId}"`;

type Expect = {
  /** Where the session that received it opened; "live" when it went to an open session. */
  start?: SessionStart | "live";
  /** Present in the hand-over (the interrupted request among them when there is one). */
  context?: string[];
  /** Never in the hand-over. */
  absent?: string[];
  /** The "may already have run" sentence. */
  sentence?: boolean;
  /** No hand-over block at all. */
  noContext?: boolean;
  /** Exactly the live instruction. */
  instruction: string[];
  /** Which request, counted from the last (1). */
  request?: number;
};
type Row = {
  /** The row of the invariant's table this proves. */
  row: string;
  name: string;
  accounts?: ReturnType<typeof account>[];
  idleMs?: number;
  execute?: (n: number) => string;
  /** Calls, by number, whose tool waits until released (or aborted). */
  hold?: number[];
  steps: (run: Run, release: () => void, held: () => number) => Promise<Expect>;
};

const completedThen = async (run: Run) => {
  run.fake.frames.push({ text: "one" });
  await run.submit("first");
};
const loss =
  (
    reason: Reason = "provider-failed",
    disposition: "reusable" | "broken" = "broken",
    request = "second",
  ): Row["steps"] =>
  async (run) => {
    await completedThen(run);
    run.fake.frames.push(call("lost", 7), failed(run, reason, disposition));
    await run.submit(request);
    await closed(run, 0);
    run.fake.frames.push({ text: "recovered" });
    await run.submit("third");
    return {
      start: fork("point-1"),
      context: [request, id("lost"), "result-7"],
      absent: ["first"],
      sentence: true,
      instruction: ["third"],
    };
  };

const rows: Row[] = [
  {
    row: "1",
    name: "a completed turn, then a new message to the open session",
    steps: async (run) => {
      await completedThen(run);
      run.fake.frames.push({ text: "two" });
      await run.submit("second");
      expect(run.fake.opened).toHaveLength(1);
      return { start: "live", noContext: true, instruction: ["second"] };
    },
  },
  {
    row: "2",
    name: "a completed turn, an idle close, then a new message",
    idleMs: 5,
    steps: async (run) => {
      await completedThen(run);
      await closed(run, 0);
      run.fake.frames.push({ text: "two" });
      await run.submit("second");
      return {
        start: { kind: "resume", session: "session-1", fork: false },
        noContext: true,
        instruction: ["second"],
      };
    },
  },
  {
    row: "3",
    name: "a completed turn, a model switch, then a new message",
    steps: async (run) => {
      await completedThen(run);
      await to(run, "subscription", "real");
      run.fake.frames.push({ text: "two" });
      await run.submit("second");
      expect(run.fake.opened[0]!.session.models.at(-1)?.id).toBe("real");
      return { start: "live", noContext: true, instruction: ["second"] };
    },
  },
  {
    row: "5",
    name: "the process dies after a tool round, then a new message",
    steps: loss(),
  },
  {
    row: "5 (image)",
    name: "an image in the interrupted request, then continue",
    steps: async (run) => {
      await completedThen(run);
      const image = "A".repeat(300_000);
      run.fake.frames.push(call("lost", 7), failed(run));
      await (
        await run.conversation.submit(
          {
            type: "input",
            content: [
              { type: "text", text: "LOOK-AT-THIS" },
              { type: "image", data: image, mimeType: "image/png" },
            ],
          } as never,
          context,
        )
      )
        .wait(context)
        .catch(() => undefined);
      await closed(run, 0);
      run.fake.frames.push({ text: "recovered" });
      await run.submit("continue");
      // The image is never sent as text: past the budget, the request is left out.
      expect(JSON.stringify(run.fake.requests.at(-1)!.input)).not.toContain(
        image.slice(0, 1_000),
      );
      return {
        start: fork("point-1"),
        context: [id("lost"), "result-7"],
        sentence: true,
        instruction: ["continue"],
      };
    },
  },
  {
    row: "5 (two interrupted turns)",
    name: "two interrupted turns, the second with a 40 KB request, then a retry",
    steps: async (run) => {
      await completedThen(run);
      run.fake.frames.push(call("a", 1), call("b", 2), failed(run));
      await run.submit("REQUEST");
      await closed(run, 0);
      run.fake.frames.push(call("c", 3), failed(run));
      await run.submit(bigRequest);
      await closed(run, 1);
      run.fake.frames.push({ text: "recovered" });
      await run.submit("try again 2");
      expect(JSON.stringify(run.fake.requests.at(-1)!.input)).not.toContain(
        bigRequest,
      );
      return {
        start: fork("point-1"),
        context: [id("c"), "result-3"],
        sentence: true,
        instruction: ["try again 2"],
      };
    },
  },
  {
    row: "8",
    name: "a turn that fails before any output, then a new message",
    steps: async (run) => {
      await completedThen(run);
      run.fake.frames.push(failed(run));
      await run.submit("second");
      await closed(run, 0);
      run.fake.frames.push({ text: "recovered" });
      await run.submit("third");
      return {
        start: fork("point-1"),
        context: ["second"],
        absent: ["first"],
        sentence: true,
        instruction: ["third"],
      };
    },
  },
  {
    row: "9",
    name: "the very first turn fails, then a new message",
    steps: async (run) => {
      run.fake.frames.push(call("lost", 3), failed(run));
      await run.submit("first");
      await closed(run, 0);
      run.fake.frames.push({ text: "recovered" });
      await run.submit("second");
      return {
        start: { kind: "new" },
        context: ["first", id("lost"), "result-3"],
        sentence: true,
        instruction: ["second"],
      };
    },
  },
  {
    row: "10",
    name: "a stopped turn, then a new message",
    hold: [5],
    steps: async (run, release, held) => {
      await completedThen(run);
      run.fake.frames.push(call("held", 5));
      const work = run.submit("second");
      await until(() => held() === 1);
      await run.conversation.abort(context);
      await run.conversation.submit(
        {
          type: "write",
          entry: { kind: STOP_ENTRY_KIND, data: { author: "test" } },
        },
        context,
      );
      await closed(run, 0);
      release();
      await work.catch(() => undefined);
      run.fake.frames.push({ text: "recovered" });
      await run.submit("third");
      return {
        start: fork("point-1"),
        context: ["second", id("held")],
        sentence: true,
        instruction: ["third"],
      };
    },
  },
  {
    row: "11",
    name: "a completed turn that ends without its resume point, then a new message",
    steps: async (run) => {
      await completedThen(run);
      run.fake.frames.push({ text: "two", omitTurnPoint: true });
      await run.submit("second");
      await closed(run, 0);
      expect(run.heads.get(String(run.conversation.id))).toBeUndefined();
      run.fake.frames.push({ text: "recovered" });
      await run.submit("third");
      return {
        start: fork("point-1"),
        context: ["second"],
        sentence: true,
        instruction: ["third"],
      };
    },
  },
  ...(
    [
      ["turn-limit-reached", "broken"],
      ["session-stopped", "broken"],
      ["previous-turn-active", "reusable"],
      ["provider-failed", "reusable"],
    ] as const
  ).map(([reason, disposition]): Row => ({
    row: "13",
    name: `a turn that fails with ${reason}, ${disposition}, then a new message`,
    steps: loss(reason, disposition),
  })),
  {
    row: "14",
    name: "a session that fails to open with a pointer, then a new message",
    steps: async (run) => {
      await completedThen(run);
      run.fake.frames.push(call("lost", 7), failed(run));
      await run.submit("second");
      await closed(run, 0);
      run.fake.failOpen = (start) => start.kind === "resume";
      await run.submit("third");
      expect((await lastAssistant(run))?.errorMessage).toBe(resumeFailed);
      run.fake.failOpen = () => false;
      run.fake.frames.push({ text: "recovered" });
      await run.submit("fourth");
      // The failed open's reply carries the same pointer as the lost turn's tool-use message, so
      // the extension does not put it back: the request it failed to send is an instruction again.
      return {
        start: fork("point-1"),
        context: ["second", id("lost")],
        sentence: true,
        instruction: ["third", "fourth"],
      };
    },
  },
  {
    row: "15",
    name: "a session that fails to open with no pointer, then a new message",
    steps: async (run) => {
      run.fake.failOpen = () => true;
      await run.submit("first");
      run.fake.failOpen = () => false;
      run.fake.frames.push({ text: "one" });
      await run.submit("second");
      return {
        start: { kind: "new" },
        noContext: true,
        instruction: ["first", "second"],
      };
    },
  },
  {
    row: "16",
    name: "direct-route replies, one cut at its length limit, then a switch",
    steps: async (run) => {
      await to(run, "faux", "coder");
      directAnswer(run, "ok");
      await run.submit("FIRST-REQ");
      directAnswer(run, "long answer cut off", "length");
      await run.submit("TRUNCATED-REQ");
      await to(run, "subscription");
      run.fake.frames.push({ text: "hi" });
      await run.submit("next");
      return {
        start: { kind: "new" },
        context: ["FIRST-REQ", "TRUNCATED-REQ", "long answer cut off"],
        sentence: false,
        instruction: ["next"],
      };
    },
  },
  {
    row: "17",
    name: "a failed direct-route reply, then a switch",
    steps: async (run) => {
      await to(run, "faux", "coder");
      directAnswer(run, "ok");
      await run.submit("FIRST-REQ");
      directAnswer(run, "broken", "error");
      await run.submit("FAILED-REQ");
      await to(run, "subscription");
      run.fake.frames.push({ text: "hi" });
      await run.submit("next");
      return {
        start: { kind: "new" },
        context: ["FIRST-REQ"],
        sentence: false,
        instruction: ["FAILED-REQ", "next"],
      };
    },
  },
  {
    row: "18",
    name: "direct-route history, then a runtime turn lost after a tool round",
    steps: async (run) => {
      await to(run, "faux", "coder");
      directAnswer(run, "pi answer");
      await run.submit("DELETE-THE-BRANCH");
      await to(run, "subscription");
      run.fake.frames.push(call("lost", 7), failed(run));
      await run.submit("second");
      await closed(run, 0);
      run.fake.frames.push({ text: "recovered" });
      await run.submit("third");
      return {
        start: { kind: "new" },
        context: ["DELETE-THE-BRANCH", "pi answer", "second", id("lost")],
        sentence: true,
        instruction: ["third"],
      };
    },
  },
  {
    row: "19",
    name: "an account change to a different continuation",
    accounts: [account(), account("other", "different")],
    steps: async (run) => {
      await completedThen(run);
      await to(run, "other");
      run.fake.frames.push({ text: "two" });
      await run.submit("switch");
      expect(run.fake.opened[1]!.account).toBe("other");
      expect(run.fake.requests.at(-1)!.input).toEqual(
        handoff((await run.messages()).slice(0, -1)),
      );
      return {
        start: { kind: "new" },
        context: ["first", "one"],
        sentence: false,
        instruction: ["switch"],
      };
    },
  },
  {
    row: "20",
    name: "an account change on the same continuation",
    accounts: [account(), account("other", "shared")],
    steps: async (run) => {
      await completedThen(run);
      await to(run, "other");
      run.fake.frames.push({ text: "two" });
      await run.submit("switch");
      // A clean continuation: the head is completed on this continuation, so it resumes in place.
      return {
        start: { kind: "resume", session: "session-1", fork: false },
        noContext: true,
        instruction: ["switch"],
      };
    },
  },
  {
    row: "22",
    name: "a reset with hand-over text, then a turn that fails before any output",
    steps: async (run) => {
      await completedThen(run);
      await run.conversation.reset("HANDOFF-TEXT", context);
      run.fake.frames.push(failed(run));
      await run.submit("second");
      await closedLast(run);
      run.fake.frames.push({ text: "recovered" });
      await run.submit("third");
      return {
        start: { kind: "new" },
        context: ["HANDOFF-TEXT", "second"],
        sentence: true,
        instruction: ["third"],
      };
    },
  },
  {
    row: "23",
    name: "an earlier message edited, then a new message",
    steps: async (run) => {
      await completedThen(run);
      run.fake.frames.push({ text: "two" });
      await run.submit("EDIT-ME");
      await run.bridge.closeConversation(String(run.conversation.id));
      await editEntry(
        run,
        (message) => message.role === "user" && message.content === "EDIT-ME",
        (message: { content: string }) => ({ ...message, content: "EDITED" }),
      );
      run.fake.frames.push({ text: "three" });
      await run.submit("second");
      return {
        start: { kind: "new" },
        context: ["EDITED"],
        absent: ["EDIT-ME"],
        sentence: false,
        instruction: ["second"],
      };
    },
  },
  {
    row: "24",
    name: "an edit that omits an answer, then a new message",
    steps: async (run) => {
      await completedThen(run);
      run.fake.frames.push({ text: "two" });
      await run.submit("REQ2");
      await run.bridge.closeConversation(String(run.conversation.id));
      await editEntry(
        run,
        (message) =>
          message.role === "assistant" &&
          JSON.stringify(message.content).includes('"two"'),
      );
      run.fake.frames.push({ text: "three" });
      await run.submit("second");
      // The head names the omitted answer, not the earlier turn, so the lineage is not proven: new.
      return {
        start: { kind: "new" },
        context: ["first", "one"],
        sentence: false,
        instruction: ["REQ2", "second"],
      };
    },
  },
  {
    row: "25",
    name: "an edit that replaces an answer, then a new message",
    steps: async (run) => {
      await completedThen(run);
      run.fake.frames.push({ text: "two" });
      await run.submit("REQ2");
      await run.bridge.closeConversation(String(run.conversation.id));
      await editEntry(
        run,
        (message) =>
          message.role === "assistant" &&
          JSON.stringify(message.content).includes('"two"'),
        (message: object) => ({
          ...message,
          content: [{ type: "text", text: "REPLACED" }],
        }),
      );
      run.fake.frames.push({ text: "three" });
      await run.submit("second");
      return {
        start: { kind: "new" },
        context: ["REQ2", "REPLACED"],
        sentence: false,
        instruction: ["second"],
      };
    },
  },
  {
    row: "23b",
    name: "an edit, a new session that then fails, and another message",
    steps: async (run) => {
      await completedThen(run);
      run.fake.frames.push({ text: "two" });
      await run.submit("EDIT-ME");
      await run.bridge.closeConversation(String(run.conversation.id));
      await editEntry(
        run,
        (message) => message.role === "user" && message.content === "EDIT-ME",
        (message: { content: string }) => ({ ...message, content: "EDITED" }),
      );
      run.fake.frames.push(call("lost", 7), failed(run));
      await run.submit("second");
      await closedLast(run);
      run.fake.frames.push({ text: "recovered" });
      await run.submit("third");
      // Every session after the edit opens new: none may fork into the text before it.
      expect(run.fake.opened.map((opened) => opened.start)).toEqual([
        { kind: "new" },
        { kind: "new" },
        { kind: "new" },
      ]);
      return {
        start: { kind: "new" },
        context: ["EDITED", "second", id("lost")],
        absent: ["EDIT-ME"],
        sentence: true,
        instruction: ["third"],
      };
    },
  },
  ...(["lost heads store", "head from another continuation"] as const).map(
    (lost): Row => ({
      row: "23c",
      name: `an edit with a ${lost} forks at the old text (accepted)`,
      steps: async (run) => {
        await completedThen(run);
        run.fake.frames.push({ text: "two" });
        await run.submit("EDIT-ME");
        await run.bridge.closeConversation(String(run.conversation.id));
        await editEntry(
          run,
          (message) => message.role === "user" && message.content === "EDIT-ME",
          (message: { content: string }) => ({
            ...message,
            content: "EDITED",
          }),
        );
        const owner = String(run.conversation.id);
        if (lost === "lost heads store")
          await run.heads.restore(owner, run.heads.get(owner)!, undefined);
        else
          await run.heads.set(owner, {
            ...run.heads.get(owner)!,
            continuation: { runtime: "claude-code", key: "/elsewhere" },
          });
        run.fake.frames.push({ text: "three" });
        await run.submit("second");
        // Without this continuation's head there is no digest to compare: the fork holds "EDIT-ME".
        return {
          start: fork("point-2"),
          noContext: true,
          instruction: ["second"],
        };
      },
    }),
  ),
  {
    row: "26",
    name: "a loss, then a lost heads store",
    steps: async (run) => {
      await completedThen(run);
      run.fake.frames.push(call("lost", 7), failed(run));
      await run.submit("second");
      await closed(run, 0);
      await run.bridge.closeConversation(String(run.conversation.id), true);
      expect(run.heads.get(String(run.conversation.id))).toBeUndefined();
      run.fake.frames.push({ text: "recovered" });
      await run.submit("third");
      return {
        start: fork("point-1"),
        context: ["second", id("lost")],
        sentence: true,
        instruction: ["third"],
      };
    },
  },
  {
    row: "28",
    name: "a loss, then a head from another continuation",
    steps: async (run) => {
      await completedThen(run);
      run.fake.frames.push(call("lost", 7), failed(run));
      await run.submit("second");
      await closed(run, 0);
      const owner = String(run.conversation.id);
      await run.heads.set(owner, {
        ...run.heads.get(owner)!,
        continuation: { runtime: "claude-code", key: "/elsewhere" },
      });
      run.fake.frames.push({ text: "recovered" });
      await run.submit("third");
      return {
        start: fork("point-1"),
        context: ["second", id("lost")],
        sentence: true,
        instruction: ["third"],
      };
    },
  },
  {
    row: "29",
    name: "a steer inside a turn that is then lost",
    hold: [5],
    steps: async (run, release, held) => {
      await completedThen(run);
      run.fake.frames.push(call("held", 5));
      const work = run.submit("second");
      await until(() => held() === 1);
      const steer = run.conversation.submit(
        { type: "input", content: "STEER-NOW", whenBusy: "steer" },
        context,
      );
      run.fake.frames.push(call("after", 6), failed(run));
      release();
      await work.catch(() => undefined);
      await (await steer).wait(context).catch(() => undefined);
      await closed(run, 0);
      run.fake.frames.push({ text: "recovered" });
      await run.submit("third");
      return {
        start: fork("point-1"),
        context: ["second", "STEER-NOW", id("held"), id("after")],
        sentence: true,
        instruction: ["third"],
      };
    },
  },
  {
    row: "30",
    name: "a message queued while a call is held, then a loss",
    hold: [5],
    steps: async (run, release, held) => {
      await completedThen(run);
      run.fake.frames.push(call("held", 5));
      const work = run.submit("second");
      await until(() => held() === 1);
      void run.conversation.submit(
        { type: "input", content: "QUEUED" },
        context,
      );
      run.fake.frames.push(call("after", 6), failed(run));
      release();
      await work.catch(() => undefined);
      await closed(run, 0);
      // pi starts the queued message's request only when the next one arrives, then that one.
      run.fake.frames.push({ text: "recovered" }, { text: "after third" });
      await run.submit("third");
      expect(texts(run.fake.requests.at(-1)!.input)).toEqual(["third"]);
      return {
        start: fork("point-1"),
        context: ["second", id("held")],
        sentence: true,
        instruction: ["QUEUED"],
        request: 2,
      };
    },
  },
];

const setup = async (
  row: Pick<Row, "accounts" | "execute" | "hold" | "idleMs">,
  fake: FakeRuntime,
) => {
  const gates: Array<PromiseWithResolvers<void>> = [];
  let holding = 0;
  const run = await fixture({
    fake,
    ...(row.accounts ? { accounts: row.accounts } : {}),
    ...(row.idleMs === undefined ? {} : { idleMs: row.idleMs }),
    execute: async (n, _conversation, signal) => {
      if (row.hold?.includes(n)) {
        const gate = Promise.withResolvers<void>();
        gates.push(gate);
        holding++;
        signal?.addEventListener("abort", () => gate.resolve(), {
          once: true,
        });
        await gate.promise;
      }
      return {
        content: [{ type: "text", text: row.execute?.(n) ?? `result-${n}` }],
      };
    },
  });
  return {
    run,
    release: () => gates.shift()?.resolve(),
    held: () => holding,
    end: () => gates.forEach((gate) => gate.resolve()),
  };
};

for (const row of rows)
  test(`table row ${row.row}: ${row.name}`, async () => {
    const { run, release, held, end } = await setup(row, runtimeWith(false));
    try {
      const expected = await row.steps(run, release, held);
      const index = run.fake.requests.length - (expected.request ?? 1);
      const sent = texts(run.fake.requests[index]!.input);
      const blocks = sent.filter((text) => text.startsWith(HISTORY));
      const handedOver = blocks.join("\n");
      expect(blocks.length).toBeLessThanOrEqual(1);
      if (expected.noContext) expect(blocks).toEqual([]);
      // The live instruction, exactly.
      expect(sent.filter((text) => !text.startsWith(HISTORY))).toEqual(
        expected.instruction,
      );
      for (const item of expected.context ?? [])
        expect(handedOver).toContain(item);
      for (const item of expected.absent ?? [])
        expect(handedOver).not.toContain(`"content":"${item}"`);
      if (expected.sentence !== undefined)
        expect(handedOver.includes(MAY_HAVE_RUN)).toBe(expected.sentence);
      // Nothing is exempt from the budget: no block is larger than it.
      for (const text of sent.filter((text) => text.startsWith(HISTORY)))
        expect(Buffer.byteLength(text)).toBeLessThanOrEqual(HANDOFF_TOKENS);
      if (expected.start === "live")
        expect(run.fake.requests[index]!.session).toBe(
          run.fake.opened[0]!.session.id,
        );
      else if (expected.start)
        expect(
          run.fake.opened.find(
            (opened) => opened.session.id === run.fake.requests[index]!.session,
          )?.start,
        ).toEqual(expected.start);
    } finally {
      end();
      await run.close();
    }
  });

// Reason: row 6. After the process dies while a call is held, pi asks for the next reply with no
// user message; the bridge starts no turn, ends the request with the typed failure, pi does not
// retry it, and no handler is left waiting.
test("table row 6: a process that dies while a call is held starts no turn", async () => {
  const gate = Promise.withResolvers<void>();
  let held = 0;
  const run = await fixture({
    fake: runtimeWith(false),
    execute: async (n) => {
      if (n === 5) {
        held++;
        await gate.promise;
      }
      return { content: [{ type: "text", text: `result-${n}` }] };
    },
  });
  try {
    await completedThen(run);
    run.fake.frames.push(call("held", 5));
    const work = run.submit("second");
    await until(() => held === 1);
    run.fake.opened[0]!.session.emit({
      type: "turn.finished",
      outcome: {
        status: "failed",
        failure: failure(run),
        disposition: "broken",
      },
    });
    await closed(run, 0);
    const requests = run.fake.requests.length;
    gate.resolve();
    const outcome = await work;
    expect(outcome.status).not.toBe("done");
    await run.harness.waitForIdle(context);
    expect((await lastAssistant(run))?.errorMessage).toBe(interrupted);
    expect(run.fake.requests).toHaveLength(requests);
    expect(run.fake.opened).toHaveLength(1);
    // The held handler was settled when the session closed, not left waiting.
    await until(() => run.fake.opened[0]!.session.jobs.size === 0);
  } finally {
    gate.resolve();
    await run.close();
  }
});

// Reason: row 7. The no-turn rule twice in a row: after the first, the person's message opens a
// fork that dies while a call is held again, and the bridge again starts no turn.
test("table row 7: a process that dies while a call is held, twice, starts no turn either time", async () => {
  const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  let held = 0;
  const run = await fixture({
    fake: runtimeWith(false),
    execute: async (n) => {
      if (n === 5 || n === 6) await gates[held++]!.promise;
      return { content: [{ type: "text", text: `result-${n}` }] };
    },
  });
  const die = (index: number) =>
    run.fake.opened[index]!.session.emit({
      type: "turn.finished",
      outcome: {
        status: "failed",
        failure: failure(run),
        disposition: "broken",
      },
    });
  try {
    await completedThen(run);
    for (const [index, message] of ["second", "continue"].entries()) {
      run.fake.frames.push(call(`held-${index}`, 5 + index));
      const work = run.submit(message);
      await until(() => held === index + 1);
      die(index);
      await closed(run, index);
      const requests = run.fake.requests.length;
      gates[index]!.resolve();
      expect((await work).status).not.toBe("done");
      await run.harness.waitForIdle(context);
      expect((await lastAssistant(run))?.errorMessage).toBe(interrupted);
      expect(run.fake.requests).toHaveLength(requests);
      expect(run.fake.opened).toHaveLength(index + 1);
      await until(() => run.fake.opened[index]!.session.jobs.size === 0);
    }
    expect(run.fake.opened[1]!.start).toEqual(fork("point-1"));
  } finally {
    for (const gate of gates) gate.resolve();
    await run.close();
  }
});

// Reason: row 12. A forked session that overflows does so again on every new message: each fails
// with the typed failure the person sees, without a retry loop, and a new chat works.
test("table row 12: repeated context overflow fails typed each time, and a new chat works", async () => {
  const run = await fixture({ fake: runtimeWith(false) });
  const overflow = failure(run, "context-overflow");
  try {
    await completedThen(run);
    for (const [index, message] of ["second", "third"].entries()) {
      run.fake.frames.push({ failure: overflow });
      await run.submit(message);
      await closed(run, index);
      expect((await lastAssistant(run))?.errorMessage).toBe(
        terminalText(overflow),
      );
      expect(run.fake.opened[index]!.start).toEqual(
        index === 0 ? { kind: "new" } : fork("point-1"),
      );
    }
    expect(run.fake.requests).toHaveLength(3);
    const fresh = await run.harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: { model: { provider: "subscription", modelId: "sonnet" } },
      },
      context,
    );
    run.fake.frames.push({ text: "fresh" });
    expect(
      (
        await (
          await fresh.submit({ type: "input", content: "new chat" }, context)
        ).wait(context)
      ).status,
    ).toBe("done");
    expect(texts(run.fake.requests.at(-1)!.input)).toEqual(["new chat"]);
  } finally {
    await run.close();
  }
});

// Reason: rows 16, 19 and 21. A plain account change, with a long final direct reply and a
// compaction summary in the transcript, reaches such a runtime exactly as it reaches Claude Code:
// neither addition applies, since no turn was interrupted.
test("table rows 16, 19, 21: a plain account change sends what a Claude account receives", async () => {
  const sentTo = async (resumeInTurn: boolean) => {
    const run = await fixture({ fake: runtimeWith(resumeInTurn) });
    try {
      await to(run, "faux", "coder");
      directAnswer(run, "a1");
      await run.submit(`Q1 ${"x".repeat(400)}`);
      directAnswer(run, "a2");
      await run.submit(`Q2 ${"y".repeat(400)}`);
      await compact(run, "SUMMARY-TEXT");
      directAnswer(run, `long ${"z".repeat(2_000)}`, "length");
      await run.submit("LONG-REQ");
      await to(run, "subscription");
      run.fake.frames.push({ text: "hi" });
      await run.submit("next");
      return texts(run.fake.requests.at(-1)!.input).map((text) =>
        text.replace(/"timestamp":\d+/g, "").replace(/"faux:[^"]*"/g, '"faux"'),
      );
    } finally {
      await run.close();
    }
  };
  const claude = await sentTo(true);
  expect(claude.at(-1)).toBe("next");
  expect(claude[0]).toContain("SUMMARY-TEXT");
  expect(await sentTo(false)).toEqual(claude);
});

// Reason: chats need only "runs its own loop", so the account is offered and a turn completes.
test("a runtime that resumes only between turns serves a chat turn", async () => {
  const run = await fixture({ fake: runtimeWith(false) });
  try {
    expect(run.models.getModel("subscription", "sonnet")).toBeDefined();
    run.fake.frames.push({ text: "hello" });
    expect((await run.submit("first")).status).toBe("done");
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
    fake: runtimeWith(false),
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
  } finally {
    await run.close();
  }
});

// Reason: the fault the contract's turn-end obligation needs is logged, so it can be found.
test("a completed turn without its resume point is logged as a protocol fault", async () => {
  const run = await fixture({ fake: runtimeWith(false) });
  try {
    run.fake.frames.push({ text: "two", omitTurnPoint: true });
    await run.submit("first");
    await closed(run, 0);
    expect(run.fake.logs).toContainEqual({
      event: "chat-runtime.protocol.fault",
      fields: { reason: "turn-ended-without-resume-point" },
    });
  } finally {
    await run.close();
  }
});
