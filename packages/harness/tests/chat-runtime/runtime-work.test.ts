// Why: a runtime with tools of its own (Codex) reports its commands and file changes as work it
// already did, and goes on with its turn while pi records each one. The chat must show each as a
// tool call that already ran, with the outcome the runtime reported, keep the turn's later output
// in order, release nothing back to the runtime, and send the turn the chat's own folder. pi's
// shell and file tools and the pass-through itself are never served to such a runtime.
import { expect, test } from "bun:test";
import type { SystemMessage } from "@earendil-works/pi-ai";
import {
  defineExtension,
  GenerationTask,
  hook,
} from "@earendil-works/pi-durable";
import {
  RuntimeEvent,
  TurnFailed,
  type RuntimeShape,
  type RuntimeSession,
  type SessionPolicy,
} from "@neuve/runtime";
import { Cause, Effect, Queue, Stream } from "effect";
import {
  ATTENDED_SECTION,
  RUNTIME_WORK_TOOL,
} from "../../src/chat-runtime/transcript.ts";
import { FakeRuntime, caps, context, fixture, until } from "./fixture.ts";

// Give the bridge the same request marker it receives when a chat is planning.
test.each([
  { runtimeName: "Codex-like", ownTools: true },
  { runtimeName: "Claude subscription-like", ownTools: false },
])(
  "plan mode limits tools and workspace access on a $runtimeName runtime",
  async ({ ownTools }) => {
    const fake = new FakeRuntime();
    fake.capabilities = {
      ...caps,
      ownTools,
      approvals: true,
      toolEndsTurn: !ownTools,
      resumeInTurn: !ownTools,
      perMessageUsage: !ownTools,
    };
    const workspaces: unknown[] = [];
    const openSession = fake.shape.openSession;
    const captureWorkspace: RuntimeShape["openSession"] = (...args) =>
      Effect.map(openSession(...args), (session) => ({
        ...session,
        get nativeSessionId() {
          return session.nativeSessionId;
        },
        startTurn(input) {
          workspaces.push(input.workspace);
          return session.startTurn(input);
        },
      }));
    Object.assign(fake.shape, { openSession: captureWorkspace });
    const runtime = await fixture({ fake, toolName: "question" });
    try {
      await runtime.conversation.configure({ cwd: "/work/lane" }, context);
      let planning = false;
      runtime.pi.install(
        defineExtension({
          name: "plan-mode-test",
          hooks: [
            hook(GenerationTask, {
              beforeRequest({ messages }) {
                const attended: SystemMessage = {
                  role: "system",
                  content: "",
                  timestamp: 0,
                  sections: { [ATTENDED_SECTION]: "true" },
                };
                if (!planning) return { messages: [...messages, attended] };
                const offer: SystemMessage = {
                  role: "system",
                  content: "",
                  timestamp: messages.at(-1)?.timestamp ?? 0,
                  toolsRemoved: [{ name: "question" }],
                };
                Object.defineProperty(
                  offer,
                  Symbol.for("neuve.chat.plan-request"),
                  {
                    value: true,
                  },
                );
                return { messages: [...messages, attended, offer] };
              },
            }),
          ],
        }),
      );
      for (const readOnly of [false, true, false]) {
        planning = readOnly;
        fake.frames.push({ text: "Turn complete." });
        expect((await runtime.submit("Inspect the repo")).status).toBe("done");
      }
      expect(workspaces).toEqual(
        ownTools
          ? ["write", "read-only", "write"].map((access) => ({
              folder: "/work/lane",
              access,
            }))
          : [undefined, undefined, undefined],
      );
      expect(
        fake.opened.map(({ policy }) => policy.tools.map(({ name }) => name)),
      ).toEqual([["question"], [], ["question"]]);
      expect(fake.opened.map(({ policy }) => policy.approvalPolicy)).toEqual(
        ownTools ? ["ask", "allow", "ask"] : ["allow", "allow", "allow"],
      );
    } finally {
      await runtime.close();
    }
  },
);

test("attended and unattended requests reopen the same chat with the corresponding policy", async () => {
  const fake = new FakeRuntime();
  fake.capabilities = {
    ...caps,
    ownTools: true,
    approvals: true,
    toolEndsTurn: false,
    resumeInTurn: false,
    perMessageUsage: false,
  };
  const run = await fixture({ fake, toolName: "question" });
  try {
    let attended: boolean | undefined;
    run.pi.install(
      defineExtension({
        name: "request-attendance-test",
        hooks: [
          hook(GenerationTask, {
            beforeRequest({ messages }) {
              if (attended === undefined) return;
              const marker: SystemMessage = {
                role: "system",
                content: "",
                sections: { [ATTENDED_SECTION]: String(attended) },
                timestamp: 0,
              };
              return { messages: [...messages, marker] };
            },
          }),
        ],
      }),
    );
    for (const value of [undefined, true, false]) {
      attended = value;
      fake.frames.push({ text: "Turn complete." });
      expect((await run.submit("Continue")).status).toBe("done");
    }
    expect(
      fake.opened.map(({ policy }) => ({
        policy: policy.approvalPolicy,
        tools: policy.tools.map(({ name }) => name),
      })),
    ).toEqual([
      { policy: "allow", tools: ["question"] },
      { policy: "ask", tools: ["question"] },
      { policy: "allow", tools: ["question"] },
    ]);
    expect(fake.opened[1]?.start).toMatchObject({
      kind: "resume",
      fork: false,
    });
    expect(fake.opened[2]?.start).toMatchObject({
      kind: "resume",
      fork: false,
    });
    expect(fake.opened[1]?.policy.systemPrompt).toBe(
      fake.opened[0]?.policy.systemPrompt,
    );
  } finally {
    await run.close();
  }
});

test("Codex's own work shows as calls that already ran, in order, and nothing goes back to it", async () => {
  const fake = new FakeRuntime();
  fake.capabilities = {
    ...caps,
    ownTools: true,
    toolEndsTurn: false,
    resumeInTurn: false,
    perMessageUsage: false,
  };
  const opened: SessionPolicy[] = [];
  const turns: unknown[] = [];
  let released = 0;
  (fake as { shape: FakeRuntime["shape"] }).shape = {
    ...fake.shape,
    openSession: (_account, policy) =>
      Effect.gen(function* () {
        opened.push(policy);
        const queue = yield* Queue.unbounded<RuntimeEvent, Cause.Done>();
        let turnId = "";
        const emit = (event: Record<string, unknown>) =>
          Queue.offerUnsafe(
            queue,
            RuntimeEvent.parse({
              ...event,
              turnId,
              at: "2026-11-21T12:00:00Z",
            }),
          );
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => Queue.endUnsafe(queue)),
        );
        let thread = "thread-0";
        return {
          // Codex starts a new thread when it restarts for the first turn's mode.
          get nativeSessionId() {
            return thread;
          },
          // The whole turn arrives at once: later output reaches the bridge while pi records the
          // first piece of work, as Codex's does.
          startTurn: (input) =>
            Effect.sync(() => {
              turns.push(input);
              turnId = input.turnId;
              thread = "thread-1";
              emit({ type: "turn.started" });
              emit({ type: "text", text: "Reading. " });
              emit({
                type: "work.finished",
                workId: "c1",
                kind: "command",
                input: { command: "cat notes.txt", cwd: "/work/lane" },
                output: "hello",
                errored: false,
              });
              emit({ type: "text", text: "Editing. " });
              emit({
                type: "work.finished",
                workId: "f1",
                kind: "file-change",
                input: { changes: [{ path: "notes.txt", kind: "update" }] },
                output: "-hello\n+hello, world",
                errored: true,
              });
              emit({ type: "text", text: "Done." });
              emit({
                type: "message.finished",
                messageId: "m1",
                stopReason: "end-turn",
                toolCalls: [],
              });
              emit({
                type: "turn.finished",
                outcome: { status: "completed" },
                resumePoint: "codex-turn-1",
              });
            }),
          steerTurn: () => Effect.void,
          interruptTurn: () => Effect.void,
          setModel: () => Effect.void,
          respondToApproval: () =>
            Effect.sync(() => {
              released++;
            }),
          events: Stream.fromQueue(queue),
        } satisfies RuntimeSession as RuntimeSession;
      }),
  };
  const run = await fixture({ fake, toolName: "question" });
  try {
    await run.conversation.configure({ cwd: "/work/lane" }, context);
    await run.submit("change the notes");
    await until(async () =>
      (await run.messages()).some(
        (m) => m.role === "assistant" && m.stopReason === "stop",
      ),
    );
    const messages = await run.messages();
    const calls = messages.flatMap((m) =>
      m.role === "assistant"
        ? m.content.filter((block) => block.type === "toolCall")
        : [],
    );
    expect(calls).toEqual([
      expect.objectContaining({
        name: RUNTIME_WORK_TOOL,
        arguments: {
          kind: "command",
          input: { command: "cat notes.txt", cwd: "/work/lane" },
          errored: false,
        },
      }),
      expect.objectContaining({
        name: RUNTIME_WORK_TOOL,
        arguments: expect.objectContaining({
          kind: "file-change",
          errored: true,
        }),
      }),
    ]);
    const results = messages.filter((m) => m.role === "toolResult");
    expect(
      results.map((r) => [
        r.toolName,
        r.isError,
        r.content.map((b) => (b.type === "text" ? b.text : "")).join(""),
      ]),
    ).toEqual([
      [RUNTIME_WORK_TOOL, false, "hello"],
      [RUNTIME_WORK_TOOL, true, "-hello\n+hello, world"],
    ]);
    const text = messages
      .flatMap((m) =>
        m.role === "assistant"
          ? m.content.flatMap((b) => (b.type === "text" ? [b.text] : []))
          : [],
      )
      .join("");
    expect(text).toBe("Reading. Editing. Done.");
    // One turn, with the chat's folder; no result released; the pass-through never served.
    expect(turns).toEqual([
      expect.objectContaining({
        workspace: { folder: "/work/lane", access: "write" },
      }),
    ]);
    expect(released).toBe(0);
    // The head followed the new thread, so the next message resumes the session that holds the turn.
    expect(run.heads.get(String(run.conversation.id))?.session).toBe(
      "thread-1",
    );
    expect(opened[0]?.folder).toBe("/work/lane");
    expect(opened[0]?.tools.map((tool) => tool.name)).toEqual(["question"]);
    // A call the bridge did not record, as a model calling the tool would make, gets nothing.
    expect(run.bridge.ran("work-forged")).toBeUndefined();
  } finally {
    await run.close();
  }
});

// Why: each state of an account whose program cannot run (not installed, a file that does not
// answer as the program, a version marked broken) fails the chat with the account's own fix, and
// opens no session; another account in the same chat layer is unaffected.
test("a chat on an account whose program cannot run fails with that state's fix", async () => {
  const run = await fixture();
  try {
    const fix =
      "Found /usr/local/bin/codex, which did not answer as Codex. Install Codex with npm install -g @openai/codex.";
    run.statuses.set([
      {
        ...run.statuses.values[0]!,
        signIn: {
          state: "runtime-unavailable",
          reason: "unrecognized-program",
          program: "Codex",
          fix,
        },
      },
    ]);
    const model = run.models.getModel("subscription", "sonnet")!;
    const message = await run.models
      .streamSimple(model, {
        messages: [{ role: "user", content: "hi", timestamp: 0 }],
      })
      .result();
    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toBe(fix);
    expect(run.fake.opened).toEqual([]);
  } finally {
    await run.close();
  }
});

// Why: in a real chat Neuve's own tools are served beside Codex's, and a call to one is held open
// while pi runs it, with Codex's own work before and after it in the same turn. Both kinds of
// round must take turns in order, the held call must get pi's result, and nothing else goes back.
// The tool is named `question`, the one an unattended Codex session is still served.
test("a call to one of Neuve's tools between two pieces of Codex's own work is run by pi and answered", async () => {
  const fake = new FakeRuntime();
  fake.capabilities = {
    ...caps,
    ownTools: true,
    toolEndsTurn: false,
    resumeInTurn: false,
    perMessageUsage: false,
  };
  const answered: unknown[] = [];
  (fake as { shape: FakeRuntime["shape"] }).shape = {
    ...fake.shape,
    openSession: (_account, policy) =>
      Effect.gen(function* () {
        const queue = yield* Queue.unbounded<RuntimeEvent, Cause.Done>();
        let turnId = "";
        const emit = (event: Record<string, unknown>) =>
          Queue.offerUnsafe(
            queue,
            RuntimeEvent.parse({
              ...event,
              turnId,
              at: "2026-11-21T12:00:00Z",
            }),
          );
        const abort = new AbortController();
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            abort.abort();
            Queue.endUnsafe(queue);
          }),
        );
        const work = (workId: string, output: string) =>
          emit({
            type: "work.finished",
            workId,
            kind: "command",
            input: { command: workId },
            output,
            errored: false,
          });
        return {
          nativeSessionId: "thread-1",
          startTurn: (input) =>
            Effect.sync(() => {
              turnId = input.turnId;
              void (async () => {
                emit({ type: "turn.started" });
                work("before", "one");
                emit({
                  type: "message.finished",
                  messageId: "t1",
                  stopReason: "tool-use",
                  toolCalls: [
                    { callId: "t1", toolName: "question", input: { n: 7 } },
                  ],
                });
                emit({
                  type: "tool.started",
                  callId: "t1",
                  toolName: "question",
                  input: { n: 7 },
                });
                const tool = policy.tools.find((t) => t.name === "question")!;
                const outcome = await Effect.runPromise(
                  tool.handle({ n: 7 }, { callId: "t1", signal: abort.signal }),
                );
                answered.push(outcome);
                emit({
                  type: "tool.finished",
                  callId: "t1",
                  toolName: "question",
                  errored: false,
                });
                work("after", "two");
                emit({ type: "text", text: "Done." });
                emit({
                  type: "message.finished",
                  messageId: "m",
                  stopReason: "end-turn",
                  toolCalls: [],
                });
                emit({
                  type: "turn.finished",
                  outcome: { status: "completed" },
                  resumePoint: "turn-1",
                });
              })();
            }),
          steerTurn: () => Effect.void,
          interruptTurn: () => Effect.void,
          setModel: () => Effect.void,
          respondToApproval: () => Effect.void,
          events: Stream.fromQueue(queue),
        } satisfies RuntimeSession as RuntimeSession;
      }),
  };
  const run = await fixture({ fake, toolName: "question" });
  try {
    await run.conversation.configure({ cwd: "/work/lane" }, context);
    await run.submit("go");
    await until(async () =>
      (await run.messages()).some(
        (m) => m.role === "assistant" && m.stopReason === "stop",
      ),
    );
    const messages = await run.messages();
    expect(
      messages.flatMap((m) =>
        m.role === "assistant"
          ? m.content.flatMap((b) =>
              b.type === "toolCall" ? [`${b.name}:${b.id}`] : [],
            )
          : [],
      ),
    ).toEqual([
      `${RUNTIME_WORK_TOOL}:work-before`,
      "question:t1",
      `${RUNTIME_WORK_TOOL}:work-after`,
    ]);
    expect(run.executed).toEqual([7]);
    expect(answered).toEqual([expect.objectContaining({ text: "result-7" })]);
    expect(messages.at(-1)).toMatchObject({
      role: "assistant",
      stopReason: "stop",
    });
  } finally {
    await run.close();
  }
});

// Why: Codex goes on while pi records its work, and may end its turn before pi's next request. A
// message the person sends then cannot steer a finished turn: it must not lose the turn's end or
// its final answer, and must start the next turn.
test("a message sent after Codex's turn ended, while its work is recorded, starts the next turn", async () => {
  const fake = new FakeRuntime();
  fake.capabilities = {
    ...caps,
    ownTools: true,
    toolEndsTurn: false,
    resumeInTurn: false,
    perMessageUsage: false,
  };
  const turns: Array<{ message: unknown }> = [];
  let conversation:
    (() => import("@earendil-works/pi-durable").Conversation) | undefined;
  (fake as { shape: FakeRuntime["shape"] }).shape = {
    ...fake.shape,
    openSession: (account) =>
      Effect.gen(function* () {
        const queue = yield* Queue.unbounded<RuntimeEvent, Cause.Done>();
        let turnId = "";
        let open = false;
        const emit = (event: Record<string, unknown>) =>
          Queue.offerUnsafe(
            queue,
            RuntimeEvent.parse({
              ...event,
              turnId,
              at: "2026-11-21T12:00:00Z",
            }),
          );
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => Queue.endUnsafe(queue)),
        );
        return {
          nativeSessionId: "thread-1",
          startTurn: (input) =>
            Effect.promise(async () => {
              turns.push({ message: input.message });
              turnId = input.turnId;
              open = true;
              if (turns.length === 1) {
                // The person writes while this generation runs; pi delivers it with the round's result.
                await conversation!().submit(
                  { type: "input", content: "and then?", whenBusy: "steer" },
                  context,
                );
                emit({ type: "turn.started" });
                emit({
                  type: "work.finished",
                  workId: "c1",
                  kind: "command",
                  input: { command: "ls" },
                  output: "notes.txt",
                  errored: false,
                });
                emit({ type: "text", text: "Done." });
                emit({
                  type: "message.finished",
                  messageId: "m1",
                  stopReason: "end-turn",
                  toolCalls: [],
                });
                open = false;
                emit({
                  type: "turn.finished",
                  outcome: { status: "completed" },
                  resumePoint: "turn-1",
                });
              } else {
                emit({ type: "turn.started" });
                emit({ type: "text", text: " Then nothing." });
                emit({
                  type: "message.finished",
                  messageId: "m2",
                  stopReason: "end-turn",
                  toolCalls: [],
                });
                open = false;
                emit({
                  type: "turn.finished",
                  outcome: { status: "completed" },
                  resumePoint: "turn-2",
                });
              }
            }),
          // As Codex: a turn that has ended cannot be steered.
          steerTurn: () =>
            open
              ? Effect.void
              : Effect.fail(
                  new TurnFailed({
                    account: account.name,
                    reason: "session-stopped",
                  }),
                ),
          interruptTurn: () => Effect.void,
          setModel: () => Effect.void,
          respondToApproval: () => Effect.void,
          events: Stream.fromQueue(queue),
        } satisfies RuntimeSession as RuntimeSession;
      }),
  };
  const run = await fixture({ fake });
  conversation = () => run.conversation;
  try {
    await run.conversation.configure({ cwd: "/work/lane" }, context);
    await run.submit("go");
    await until(async () =>
      (await run.messages()).some(
        (m) =>
          m.role === "assistant" &&
          m.stopReason === "stop" &&
          m.content.some(
            (b) => b.type === "text" && b.text.includes("Then nothing."),
          ),
      ),
    );
    const messages = await run.messages();
    const text = messages
      .flatMap((m) =>
        m.role === "assistant"
          ? m.content.flatMap((b) => (b.type === "text" ? [b.text] : []))
          : [],
      )
      .join("");
    expect(text).toContain("Done.");
    expect(text).toContain("Then nothing.");
    expect(turns).toHaveLength(2);
    expect(JSON.stringify(turns[1]!.message)).toContain("and then?");
    expect(
      messages.some((m) => m.role === "assistant" && m.stopReason === "error"),
    ).toBe(false);
  } finally {
    await run.close();
  }
});

/** A Codex-like session whose whole turn is the given events, after which its stream may end. */
const scripted = (
  script: (
    emit: (event: Record<string, unknown>) => void,
    end: () => void,
  ) => void,
) => {
  const fake = new FakeRuntime();
  fake.capabilities = {
    ...caps,
    ownTools: true,
    toolEndsTurn: false,
    resumeInTurn: false,
    perMessageUsage: false,
  };
  (fake as { shape: FakeRuntime["shape"] }).shape = {
    ...fake.shape,
    openSession: () =>
      Effect.gen(function* () {
        const queue = yield* Queue.unbounded<RuntimeEvent, Cause.Done>();
        let turnId = "";
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => Queue.endUnsafe(queue)),
        );
        return {
          nativeSessionId: "thread-1",
          startTurn: (input) =>
            Effect.sync(() => {
              turnId = input.turnId;
              script(
                (event) =>
                  Queue.offerUnsafe(
                    queue,
                    RuntimeEvent.parse({
                      ...event,
                      turnId,
                      at: "2026-11-21T12:00:00Z",
                    }),
                  ),
                () => Queue.endUnsafe(queue),
              );
            }),
          steerTurn: () => Effect.void,
          interruptTurn: () => Effect.void,
          setModel: () => Effect.void,
          respondToApproval: () => Effect.void,
          events: Stream.fromQueue(queue),
        } satisfies RuntimeSession as RuntimeSession;
      }),
  };
  return fake;
};
const work = (workId: string) => ({
  type: "work.finished",
  workId,
  kind: "command",
  input: { command: workId },
  output: workId,
  errored: false,
});

// Why: Codex's process can die while pi still records its work. Everything Codex reported before
// its stream ended (each command it really ran, and the turn's failure) must still be recorded.
test("the stream ending with work still kept records every piece and the turn's failure", async () => {
  const fake = scripted((emit, end) => {
    emit({ type: "turn.started" });
    emit(work("first"));
    emit(work("second"));
    emit({ type: "text", text: "partial" });
    emit({
      type: "turn.finished",
      outcome: {
        status: "failed",
        failure: {
          _tag: "TurnFailed",
          account: "subscription",
          reason: "provider-failed",
        },
        disposition: "broken",
      },
    });
    end();
  });
  const run = await fixture({ fake });
  try {
    await run.conversation.configure({ cwd: "/work/lane" }, context);
    await run.submit("go");
    await until(
      async () =>
        (await run.messages()).filter((m) => m.role === "toolResult").length ===
        2,
    );
    const messages = await run.messages();
    expect(
      messages.flatMap((m) =>
        m.role === "assistant"
          ? m.content.flatMap((b) => (b.type === "toolCall" ? [b.id] : []))
          : [],
      ),
    ).toEqual(["work-first", "work-second"]);
    const entries = (await run.conversation.context(context)).entries.flatMap(
      (entry) => entry.model ?? [],
    );
    expect(
      entries.some(
        (m) =>
          m.role === "assistant" &&
          m.stopReason === "error" &&
          m.errorMessage ===
            "This turn did not produce an answer. Try another message.",
      ),
    ).toBe(true);
  } finally {
    await run.close();
  }
});

// Why: a failure while recording the kept events (here the resume record cannot be written) must
// end the generation with the bridge's failure message, never leave the chat waiting.
test("a failure while recording kept events ends the generation with the failure message", async () => {
  const fake = scripted((emit) => {
    emit({ type: "turn.started" });
    emit(work("only"));
    emit({ type: "text", text: "Done." });
    emit({
      type: "message.finished",
      messageId: "m",
      stopReason: "end-turn",
      toolCalls: [],
    });
    emit({
      type: "turn.finished",
      outcome: { status: "completed" },
      resumePoint: "turn-1",
    });
  });
  const run = await fixture({ fake });
  const set = run.heads.set.bind(run.heads);
  run.heads.set = async (owner, value) => {
    if (value.completed) throw new Error("the disk is full");
    return set(owner, value);
  };
  try {
    await run.conversation.configure({ cwd: "/work/lane" }, context);
    await run.submit("go");
    const entries = (await run.conversation.context(context)).entries.flatMap(
      (entry) => entry.model ?? [],
    );
    expect(
      entries.some(
        (m) =>
          m.role === "assistant" &&
          m.stopReason === "error" &&
          m.errorMessage ===
            "This turn did not produce an answer. Try another message.",
      ),
    ).toBe(true);
  } finally {
    await run.close();
  }
});

// Why: serving a tool is running it, because the bridge hands pi every call to a served tool, and
// pi runs Ace's tools outside the runtime's sandbox. An unattended runtime with its own sandbox must
// never get Ace's `lane` (it moves the chat's folder, and so the runtime's writable root): it is not
// served, and a call to it that reaches the bridge anyway is dropped, never run by pi.
test("a call to a withheld tool is never run by pi, and the turn still completes", async () => {
  const fake = new FakeRuntime();
  fake.capabilities = {
    ...caps,
    ownTools: true,
    toolEndsTurn: false,
    resumeInTurn: false,
    perMessageUsage: false,
  };
  const opened: SessionPolicy[] = [];
  (fake as { shape: FakeRuntime["shape"] }).shape = {
    ...fake.shape,
    openSession: (_account, policy) =>
      Effect.gen(function* () {
        opened.push(policy);
        const queue = yield* Queue.unbounded<RuntimeEvent, Cause.Done>();
        let turnId = "";
        const emit = (event: Record<string, unknown>) =>
          Queue.offerUnsafe(
            queue,
            RuntimeEvent.parse({
              ...event,
              turnId,
              at: "2026-11-21T12:00:00Z",
            }),
          );
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => Queue.endUnsafe(queue)),
        );
        return {
          nativeSessionId: "thread-1",
          startTurn: (input) =>
            Effect.sync(() => {
              turnId = input.turnId;
              emit({ type: "turn.started" });
              emit({
                type: "message.finished",
                messageId: "t1",
                stopReason: "tool-use",
                toolCalls: [
                  { callId: "t1", toolName: "lane", input: { n: 7 } },
                ],
              });
              emit({ type: "text", text: "Done." });
              emit({
                type: "message.finished",
                messageId: "m",
                stopReason: "end-turn",
                toolCalls: [],
              });
              emit({
                type: "turn.finished",
                outcome: { status: "completed" },
                resumePoint: "turn-1",
              });
            }),
          steerTurn: () => Effect.void,
          interruptTurn: () => Effect.void,
          setModel: () => Effect.void,
          respondToApproval: () => Effect.void,
          events: Stream.fromQueue(queue),
        } satisfies RuntimeSession as RuntimeSession;
      }),
  };
  const run = await fixture({ fake, toolName: "lane" });
  try {
    await run.conversation.configure({ cwd: "/work/lane" }, context);
    await run.submit("go");
    await until(async () =>
      (await run.messages()).some(
        (m) => m.role === "assistant" && m.stopReason === "stop",
      ),
    );
    expect(opened[0]?.tools.map((tool) => tool.name)).toEqual([]);
    expect(opened[0]?.systemPrompt).toContain("lane");
    expect(run.executed).toEqual([]);
    const calls = (await run.messages()).flatMap((m) =>
      m.role === "assistant"
        ? m.content.filter((block) => block.type === "toolCall")
        : [],
    );
    expect(calls).toEqual([]);
  } finally {
    await run.close();
  }
});
