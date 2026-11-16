import { expect, test } from "bun:test";
import { configure } from "@earendil-works/pi-durable";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import { isContextOverflow } from "@earendil-works/pi-ai/utils/overflow";
import { account, context, FakeRuntime, fixture, until } from "./fixture.ts";
import { terminalText, resumeFailed } from "../../src/chat-runtime/failure.ts";
import { handoff } from "../../src/chat-runtime/handoff.ts";
import { pointer, usage } from "../../src/chat-runtime/transcript.ts";
import { STOP_ENTRY_KIND } from "../../src/chat-runtime/extension.ts";
import { Effect } from "effect";
import { type RuntimeFailure } from "@neuve/runtime";

test("1: two serial tool rounds queue a steer before either-order results, so pi stays the executor", async () => {
  const run = await fixture({
    execute: async (n, read) => {
      if (n === 1)
        await read().submit(
          { type: "input", content: "steer", whenBusy: "steer" },
          context,
        );
      return { content: [{ type: "text", text: `result-${n}` }] };
    },
  });
  run.fake.frames.push(
    {
      text: "First",
      calls: [
        { callId: "a", toolName: "probe", input: { n: 1 } },
        { callId: "b", toolName: "probe", input: { n: 2 } },
      ],
    },
    {
      text: "Second",
      calls: [{ callId: "c", toolName: "probe", input: { n: 3 } }],
    },
    { text: "Done" },
  );
  try {
    const result = await run.submit("hello");
    expect(result.status).toBe("done");
    expect(run.executed).toEqual([1, 2, 3]);
    expect(
      run.fake.results.map(({ id, outcome }) => [id, outcome.text]),
    ).toEqual([
      ["a", "result-1"],
      ["b", "result-2"],
      ["c", "result-3"],
    ]);
    expect(run.fake.order.indexOf("steer")).toBeLessThan(
      run.fake.order.indexOf("result:a"),
    );
    expect(run.fake.opened).toHaveLength(1);
    expect(run.fake.requests).toHaveLength(4);
    expect(run.fake.logs).toEqual([]);
    expect(run.fake.unrecordedRequests).toBe(0);
    expect(
      (await run.messages()).filter((message) => message.role === "assistant"),
    ).toHaveLength(3);
  } finally {
    await run.close();
  }
});

test("2: pi rejects malformed input and foreign tool calls stay out of its transcript, so native handlers never validate", async () => {
  const run = await fixture();
  run.fake.frames.push(
    {
      calls: [
        { callId: "bad", toolName: "probe", input: { n: "bad" } },
        { callId: "foreign", toolName: "unknown", input: {} },
      ],
    },
    { text: "Recovered" },
  );
  try {
    expect((await run.submit("bad input")).status).toBe("done");
    expect(run.executed).toEqual([]);
    expect(run.fake.results[0]?.outcome.error).toContain("n");
    expect(JSON.stringify(await run.messages())).not.toContain(
      '"id":"foreign"',
    );
    expect(run.fake.logs.map((log) => log.event)).toEqual([
      "chat-runtime.tool.foreign",
    ]);
    const session = run.fake.opened[0]!.session;
    session.emit({ type: "text", text: "lone output" });
    await until(() => session.closed === 1);
    expect(run.fake.logs.at(-1)?.event).toBe("chat-runtime.protocol.fault");
    expect(run.fake.requests).toHaveLength(2);
    expect(run.fake.unrecordedRequests).toBe(0);
  } finally {
    await run.close();
  }
});

test("3: chosen switches hand off once, while model changes reuse a compatible session and pi keeps its transcript", async () => {
  const run = await fixture({
    accounts: [account(), account("other", "different")],
  });
  try {
    run.fake.frames.push({ text: "one" });
    await run.submit("first");
    await run.harness.commit(
      (tx) =>
        configure(tx, run.conversation.id, {
          model: { provider: "subscription", modelId: "real" },
          thinkingLevel: "high",
        }),
      context,
    );
    run.fake.frames.push({ text: "two" });
    await run.submit("second");
    expect(run.fake.opened).toHaveLength(1);
    expect(run.fake.opened[0]?.session.models).toEqual([
      { id: "real", effort: "high" },
    ]);
    await run.harness.commit(
      (tx) =>
        configure(tx, run.conversation.id, {
          model: { provider: "other", modelId: "sonnet" },
        }),
      context,
    );
    run.fake.frames.push({
      failure: {
        _tag: "TurnFailed",
        account: account("other").name,
        reason: "provider-failed",
      },
    });
    await run.submit("switch");
    expect(JSON.stringify(run.fake.requests.at(-1)?.input)).toContain(
      "Previous conversation",
    );
    run.fake.frames.push({ text: "recovered" });
    expect((await run.submit("again")).status).toBe("done");
    // Ruling 25(b): a failed handoff with no checkpoint restarts fresh, without another handoff.
    expect(run.fake.opened[2]?.start).toEqual({ kind: "new" });
    expect(run.fake.requests.at(-1)?.input).toEqual([
      { type: "text", text: "first" },
      { type: "text", text: "second" },
      { type: "text", text: "switch" },
      { type: "text", text: "again" },
    ]);
    expect(run.fake.requests).toHaveLength(4);
    await run.harness.commit(
      (tx) =>
        configure(tx, run.conversation.id, {
          model: { provider: "faux", modelId: "coder" },
        }),
      context,
    );
    run.faux.appendResponses([piAnswer("pi answer")]);
    expect((await run.submit("back to pi")).status).toBe("done");
    expect(run.fake.opened).toHaveLength(3);
    const blocks = handoff(
      [
        { role: "user", content: "old".repeat(20_000), timestamp: 1 },
        ...(await run.messages()),
      ],
      2000,
    );
    expect(
      Buffer.byteLength(blocks[0]!.type === "text" ? blocks[0]!.text : ""),
    ).toBeLessThanOrEqual(2000);
    expect(JSON.stringify(blocks)).toContain("items left out");
  } finally {
    await run.close();
  }
});

test("4: a failed in-place resume forks once at the full checkpoint, so aborted partials never cause a handoff", async () => {
  const run = await fixture();
  try {
    run.fake.frames.push({ text: "checkpoint" });
    await run.submit("first");
    const first = run.fake.opened[0]!.session;
    await run.bridge.closeSession(first.id);
    await run.conversation.submit(
      {
        type: "write",
        entry: {
          kind: "pi.assistant",
          model: [
            {
              ...piAnswer("partial"),
              provider: "subscription",
              model: "sonnet",
              stopReason: "aborted",
              responseId: `native:${first.id}:`,
            },
          ],
        },
      },
      context,
    );
    run.fake.failOpen = (start) => start.kind === "resume";
    const result = await run.submit("resume");
    expect(result.status).toBe("unanswered");
    expect(run.fake.failures).toEqual([
      { kind: "resume", session: first.id, fork: false },
      { kind: "resume", session: first.id, at: "point-1", fork: true },
    ]);
    const last = (await run.conversation.context(context)).entries
      .flatMap((entry) => entry.model ?? [])
      .findLast((message) => message.role === "assistant");
    expect(last?.role === "assistant" && last.errorMessage).toBe(resumeFailed);
    expect(run.fake.requests).toHaveLength(1);
  } finally {
    await run.close();
  }
});

test("5: reopen delivers undelivered results as already-ran text once, so no tool is executed twice", async () => {
  const run = await fixture({
    execute: async (n) => {
      await run.bridge.closeSession(run.fake.opened[0]!.session.id);
      return {
        content: [
          { type: "text", text: `ran-${n}` },
          { type: "image", mimeType: "image/png", data: "AA==" },
        ],
      };
    },
  });
  run.fake.frames.push(
    { calls: [{ callId: "once", toolName: "probe", input: { n: 7 } }] },
    { text: "after reopen" },
  );
  try {
    expect((await run.submit("work")).status).toBe("done");
    expect(run.executed).toEqual([7]);
    expect(run.fake.opened).toHaveLength(2);
    const input = JSON.stringify(run.fake.requests.at(-1)?.input);
    expect(input).toContain("probe already ran. Do not call it again.");
    expect(input).toContain("An image was returned and shown in the chat.");
    expect(input).not.toContain("tool_result");
    const previous = await run.messages();
    const replayContext = previous.slice(
      0,
      previous.findLastIndex((message) => message.role === "assistant"),
    );
    const model = run.models.getModel("subscription", "sonnet")!;
    const before = run.fake.requests.length;
    const entry = (await run.conversation.context(context)).entries.findLast(
      (entry) => entry.kind === "pi.assistant",
    );
    run.bridge.identify(replayContext, run.conversation.id, entry!.byTaskId!);
    await run.models.streamSimple(model, { messages: replayContext }).result();
    expect(run.fake.requests).toHaveLength(before);
  } finally {
    await run.close();
  }
});

test("6: Stop, reset, terminate, idle and worker close close scopes and settle handlers without interrupting", async () => {
  for (const end of ["stop", "reset", "terminate", "idle", "worker"] as const) {
    const run = await fixture({
      idleMs: end === "idle" ? 10 : 600_000,
      execute: async () => ({ control: { terminate: true } }),
    });
    run.fake.frames.push(
      end === "terminate"
        ? { calls: [{ callId: "end", toolName: "probe", input: { n: 0 } }] }
        : { text: "done" },
    );
    try {
      await run.submit("start");
      if (end === "stop" || end === "reset")
        await run.conversation.submit(
          {
            type: "write",
            entry: {
              kind: end === "stop" ? STOP_ENTRY_KIND : "pi.reset",
              ...(end === "reset" ? { head: "self" as const } : {}),
              data: {},
            },
          },
          context,
        );
      if (end === "worker") await run.bridge.close();
      await until(() => run.fake.opened[0]!.session.closed === 1);
      expect(run.fake.opened[0]!.session.interrupted).toBe(0);
    } finally {
      await run.close();
    }
  }
});

test("7: terminal failures name the remedy and reject pi retry and overflow heuristics, so pi does not run another loop", () => {
  const failures: RuntimeFailure[] = [
    {
      _tag: "UsageLimitReached",
      account: account().name,
      resetsAt: "2026-11-10T15:00:00Z",
    },
    {
      _tag: "SignInRequired",
      account: account().name,
      hint: {
        kind: "command",
        command: "neuve auth login",
        account: account().name,
      },
    },
    { _tag: "TurnFailed", account: account().name, reason: "context-overflow" },
    { _tag: "AccountRejected", account: account().name },
    {
      _tag: "SignInRequired",
      account: account().name,
      hint: { kind: "settings", entry: "accounts" },
    },
    {
      _tag: "RuntimeUnavailable",
      account: account().name,
      reason: "not-installed",
    },
    { _tag: "AccountNotFound", account: account().name },
    {
      _tag: "CapabilityUnsupported",
      account: account().name,
      capability: "resume",
    },
  ];
  for (const text of [
    ...failures.map((failure) => terminalText(failure)),
    resumeFailed,
  ]) {
    const message = {
      role: "assistant" as const,
      api: "neuve-runtime",
      provider: "subscription",
      model: "sonnet",
      content: [],
      usage: usage(),
      stopReason: "error" as const,
      errorMessage: text,
      timestamp: 0,
    };
    expect(isRetryableAssistantError(message)).toBe(false);
    expect(isContextOverflow(message)).toBe(false);
  }
  expect(terminalText(failures[0]!, Date.parse("2026-11-10T12:00:00Z"))).toBe(
    `Usage limit reached for subscription. Resets at ${new Date("2026-11-10T15:00:00Z").toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}.`,
  );
  expect(terminalText(failures[1]!)).toContain("neuve auth login subscription");
});

test("9: non-account requests pass straight through the Models layer, so pi chat behavior stays intact", async () => {
  const run = await fixture();
  try {
    run.faux.appendResponses([piAnswer("native")]);
    const model = run.models.getModel("faux", "coder")!;
    expect(
      (
        await run.models.completeSimple(model, {
          messages: [{ role: "user", content: "hello", timestamp: 0 }],
        })
      ).content,
    ).toEqual([{ type: "text", text: "native" }]);
    expect(run.fake.opened).toHaveLength(0);
    expect(run.models.getProvider("faux")).toBe(run.native.getProvider("faux"));
  } finally {
    await run.close();
  }
});

test("10: provider collisions retain pi and signed-out accounts give the sign-in command, while equal identities resume", async () => {
  const run = await fixture({
    accounts: [account(), account("other"), account("faux")],
  });
  try {
    expect(run.models.getModels("faux").map((model) => model.id)).toEqual([
      "coder",
    ]);
    expect(run.fake.logs).toContainEqual({
      event: "chat-runtime.account.shadowed",
      fields: { name: "faux" },
    });
    run.fake.frames.push({ text: "first" });
    await run.submit("first");
    await run.harness.commit(
      (tx) =>
        configure(tx, run.conversation.id, {
          model: { provider: "other", modelId: "sonnet" },
        }),
      context,
    );
    run.fake.frames.push({ text: "continued" });
    await run.submit("other");
    expect(run.fake.opened.at(-1)?.start).toEqual({
      kind: "resume",
      session: "session-1",
      fork: false,
    });
    expect(JSON.stringify(run.fake.requests.at(-1)?.input)).not.toContain(
      "Previous conversation",
    );
    const status = run.statuses.values[0]!;
    run.statuses.set([
      {
        ...status,
        signIn: {
          state: "not-signed-in",
          hint: {
            kind: "command",
            command: "neuve auth login",
            account: status.name,
          },
        },
      },
    ]);
    const model = run.models.getModel("subscription", "sonnet")!;
    const failed = await run.models
      .streamSimple(model, {
        messages: [{ role: "user", content: "hello", timestamp: 0 }],
      })
      .result();
    expect(failed.errorMessage).toContain("neuve auth login subscription");
    expect(
      (await run.models.getAvailable()).some(
        (model) => model.provider === "subscription",
      ),
    ).toBe(false);
  } finally {
    await run.close();
  }
});

test("11: the session id is read live after a native fork through the unmodified registry, so the next mirrored pointer names the new session", async () => {
  const run = await fixture();
  try {
    run.fake.frames.push({ text: "first" });
    await run.submit("first");
    const session = run.fake.opened[0]!.session;
    run.fake.frames.push({
      beforeMessage: () => {
        session.id = "forked-session";
      },
      text: "forked",
    });
    await run.submit("second");
    const latest = (await run.messages()).findLast(
      (message) => message.role === "assistant",
    );
    expect(latest && pointer(latest)?.session).toBe("forked-session");
    expect(run.heads.get(String(run.conversation.id))?.resumePoint).toBe(
      "point-2",
    );
    expect(run.fake.opened).toHaveLength(1);
  } finally {
    await run.close();
  }
});

function piAnswer(
  text: string,
): import("@earendil-works/pi-ai").AssistantMessage {
  return {
    role: "assistant",
    provider: "faux",
    api: "faux",
    model: "coder",
    content: [{ type: "text", text }],
    stopReason: "stop",
    usage: usage(),
    timestamp: 0,
  };
}

test("6b: Stop during a held tool closes its scope, so queued native work cannot continue after the person's Stop", async () => {
  const run = await fixture({
    execute: async (_n, _read, signal) => {
      await new Promise<void>((resolve) =>
        signal?.addEventListener("abort", () => resolve(), { once: true }),
      );
      return { content: [] };
    },
  });
  run.fake.frames.push({
    calls: [{ callId: "held", toolName: "probe", input: { n: 1 } }],
  });
  try {
    const work = run.submit("wait");
    await until(
      () =>
        run.executed.length === 1 && run.fake.order.includes("handler:held"),
    );
    await run.conversation.abort(context);
    await run.conversation.submit(
      {
        type: "write",
        entry: { kind: STOP_ENTRY_KIND, data: { author: "test" } },
      },
      context,
    );
    await until(() => run.fake.opened[0]!.session.closed === 1);
    expect((await work).status).toBe("unanswered");
    expect(run.fake.results).toEqual([]);
    expect(run.fake.opened[0]!.session.interrupted).toBe(0);
    expect(run.fake.requests).toHaveLength(1);
    expect(run.fake.unrecordedRequests).toBe(0);
  } finally {
    await run.close();
  }
});

test("6c: the compaction hook declines only owned-loop accounts, so pi retains its own compaction", async () => {
  const run = await fixture();
  try {
    run.fake.frames.push({ text: "first answer" }, { text: "second answer" });
    await run.submit("first message".repeat(100));
    await run.submit("second message".repeat(100));
    const declined = await run.harness.waitForTask(
      await run.conversation.compact(undefined, context),
      context,
    );
    expect(declined.state.outcome.status).toBe("completed");
    expect(declined.state.outcome).toEqual({ status: "completed", result: {} });
    expect(run.fake.requests).toHaveLength(2);
    await run.conversation.configure(
      { model: { provider: "faux", modelId: "coder" } },
      context,
    );
    run.faux.appendResponses([piAnswer("summary")]);
    const compacted = await run.harness.waitForTask(
      await run.conversation.compact(undefined, context),
      context,
    );
    expect(compacted.state.outcome.status).toBe("completed");
    expect(JSON.stringify(compacted.state.outcome)).not.toContain("declined");
    expect(run.faux.state.callCount).toBe(1);
  } finally {
    await run.close();
  }
});

test("6d: only two idle sessions remain open, so child chats can run while older idle sessions retire", async () => {
  const run = await fixture();
  try {
    for (let n = 0; n < 3; n++) {
      const conversation = await run.harness.createConversation(
        {
          ownership: { kind: "ownerless" },
          agent: { model: { provider: "subscription", modelId: "sonnet" } },
        },
        context,
      );
      run.fake.frames.push({ text: `answer-${n}` });
      expect(
        (
          await (
            await conversation.submit(
              { type: "input", content: `chat-${n}` },
              context,
            )
          ).wait(context)
        ).status,
      ).toBe("done");
    }
    await until(() => run.fake.opened[0]!.session.closed === 1);
    expect(run.fake.opened.map((opened) => opened.session.closed)).toEqual([
      1, 0, 0,
    ]);
  } finally {
    await run.close();
  }
});

test("3b: unavailable in-session model switching and changed prompt reopen in place, so fixed policies stay consistent", async () => {
  const fake = new FakeRuntime();
  fake.capabilities.modelSwitchInSession = false;
  const run = await fixture({
    fake,
  });
  try {
    fake.frames.push({ text: "first" });
    await run.submit("first");
    await run.conversation.configure(
      {
        model: { provider: "subscription", modelId: "real" },
        thinkingLevel: "low",
      },
      context,
    );
    fake.frames.push({ text: "second" });
    await run.submit("second");
    expect(fake.opened[1]?.start.kind).toBe("resume");
    expect(fake.opened[1]?.policy.model).toEqual({ id: "real", effort: "low" });
    await run.conversation.configure(
      { instructions: "Updated prompt" },
      context,
    );
    fake.frames.push({ text: "third" });
    await run.submit("third");
    expect(fake.opened[2]?.start.kind).toBe("resume");
    expect(fake.opened[2]?.policy.systemPrompt).toContain("Updated prompt");
    expect(fake.opened[0]?.policy.model?.id).toBe("sonnet");
  } finally {
    await run.close();
  }
});

test("pasted images cross the turn boundary as content blocks, so a person's image is retained", async () => {
  const run = await fixture();
  try {
    run.fake.frames.push({ text: "image seen" });
    const content = [
      { type: "text" as const, text: "look" },
      { type: "image" as const, mimeType: "image/png", data: "AA==" },
    ];
    expect(
      (
        await (
          await run.conversation.submit({ type: "input", content }, context)
        ).wait(context)
      ).status,
    ).toBe("done");
    expect(run.fake.requests[0]?.input).toEqual(content);
  } finally {
    await run.close();
  }
});

test("7b: account names in sign-in commands cannot trigger pi retries, so terminal text stays verbatim", async () => {
  const run = await fixture({ accounts: [account("timeout")] });
  try {
    const status = run.statuses.values[0]!;
    run.statuses.set([
      {
        ...status,
        signIn: {
          state: "not-signed-in",
          hint: {
            kind: "command",
            command: "neuve auth login",
            account: status.name,
          },
        },
      },
    ]);
    const model = run.models.getModel("timeout", "sonnet")!;
    const failed = await run.models
      .streamSimple(model, { messages: [] })
      .result();
    expect(failed.errorMessage).toContain("neuve auth login timeout");
    expect(isRetryableAssistantError(failed)).toBe(false);
    expect(isContextOverflow(failed)).toBe(false);
    expect(run.fake.requests).toHaveLength(0);
  } finally {
    await run.close();
  }
});

test("tool handoff controls end with an error instead of opening a session, so only a person's switch hands off", async () => {
  const run = await fixture({
    execute: async () => ({
      control: { handoff: "must not become a new request" },
    }),
  });
  run.fake.frames.push({
    calls: [{ callId: "handoff", toolName: "probe", input: { n: 1 } }],
  });
  try {
    await run.submit("start");
    await until(() => run.fake.opened[0]!.session.closed === 1);
    const result = (await run.messages()).findLast(
      (message) => message.role === "toolResult",
    );
    expect(result?.role === "toolResult" && result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("This turn could not continue");
    expect(run.fake.opened).toHaveLength(1);
    expect(run.fake.requests).toHaveLength(1);
  } finally {
    await run.close();
  }
});

test("identical chats have separate sessions, so concurrent conversations never subscribe to each other's answer", async () => {
  const run = await fixture();
  try {
    const other = await run.harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: { model: { provider: "subscription", modelId: "sonnet" } },
      },
      context,
    );
    run.fake.frames.push({ text: "one" }, { text: "two" });
    const results = await Promise.all([
      run.submit("identical"),
      other
        .submit({ type: "input", content: "identical" }, context)
        .then((handle) => handle.wait(context)),
    ]);
    expect(results.map((result) => result.status)).toEqual(["done", "done"]);
    expect(run.fake.opened).toHaveLength(2);
    const left = (await run.messages()).findLast(
      (message) => message.role === "assistant",
    );
    const right = (await other.context(context)).messages.findLast(
      (message) => message.role === "assistant",
    );
    expect(left && pointer(left)?.session).not.toBe(
      right && pointer(right)?.session,
    );
  } finally {
    await run.close();
  }
});

test("a seeded chat forks even with an identical digest, so it cannot advance the source chat's native head", async () => {
  const run = await fixture();
  try {
    run.fake.frames.push({ text: "source" });
    await run.submit("first");
    const seeded = await run.harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: { model: { provider: "subscription", modelId: "sonnet" } },
      },
      context,
    );
    await (
      await seeded.submit(
        {
          type: "write",
          entry: { kind: "import", model: await run.messages() },
        },
        context,
      )
    ).wait(context);
    run.fake.frames.push({ text: "seed" });
    await (
      await seeded.submit({ type: "input", content: "continue" }, context)
    ).wait(context);
    expect(run.fake.opened[1]?.start).toEqual({
      kind: "resume",
      session: "session-1",
      at: "point-1",
      fork: true,
    });
    expect(run.fake.opened[0]?.session.closed).toBe(0);
  } finally {
    await run.close();
  }
});

test("concurrent subscribers to the same pi generation share one request, so a repeated request phase never duplicates native work", async () => {
  const run = await fixture();
  try {
    const messages: import("@earendil-works/pi-ai").Message[] = [
      { role: "user", content: "same generation", timestamp: 1 },
    ];
    run.bridge.identify(messages, run.conversation.id, "repeated-generation");
    run.fake.frames.push({ text: "once" });
    const model = run.models.getModel("subscription", "sonnet")!;
    const first = run.models.streamSimple(model, { messages });
    const second = run.models.streamSimple(model, { messages });
    const results = await Promise.all([first.result(), second.result()]);
    expect(results[0]?.responseId).toBe(results[1]?.responseId);
    expect(run.fake.requests).toHaveLength(1);
    expect(run.fake.opened).toHaveLength(1);
  } finally {
    await run.close();
  }
});
