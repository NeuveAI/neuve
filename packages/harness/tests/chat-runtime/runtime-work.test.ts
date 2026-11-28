// Why: a runtime with tools of its own (Codex) reports its commands and file changes as work it
// starts, and goes on with its turn while pi records each one. The chat must show each as a
// tool call that is running, with the outcome the runtime reported, keep the turn's later output
// in order, release nothing back to the runtime, and send the turn the chat's own folder. pi's
// shell and file tools and the pass-through itself are never served to such a runtime.
import { expect, spyOn, test } from "bun:test";
import { Type, type SystemMessage } from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTool,
  GenerationTask,
  hook,
  LiveDoc,
} from "@earendil-works/pi-durable";
import {
  Account,
  RuntimeEvent,
  TurnFailed,
  type RuntimeShape,
  type RuntimeSession,
  type SessionPolicy,
} from "@neuve/runtime";
import { capabilities, openCodexSession } from "@neuve/runtime-codex";
import { Cause, Effect, Queue, Stream } from "effect";
import { codex, completed } from "../../../runtime-codex/tests/codex-fake.ts";
import { STOP_ENTRY_KIND } from "../../src/chat-runtime/extension.ts";
import {
  ATTENDED_SECTION,
  RUNTIME_WORK_TOOL,
} from "../../src/chat-runtime/transcript.ts";
import { FakeRuntime, caps, context, fixture, until } from "./fixture.ts";

// Give the bridge the same request marker it receives when a chat is planning.
test.each([
  { runtimeName: "Codex-like", ownTools: true, devtools: false },
  { runtimeName: "Claude subscription-like", ownTools: false, devtools: false },
  {
    runtimeName: "Claude subscription-like with DevTools",
    ownTools: false,
    devtools: true,
  },
])(
  "plan mode limits tools and workspace access on a $runtimeName runtime",
  async ({ ownTools, devtools }) => {
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
    const servers = {
      "chrome-devtools": {
        type: "stdio" as const,
        command: "devtools-fixture",
      },
    };
    const runtime = await fixture({
      fake,
      toolName: "question",
      ...(devtools
        ? {
            plugins: {
              httpTools: () => new Set(),
              nativeServers: () => servers,
            },
          }
        : {}),
    });
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
                  sections: { [ATTENDED_SECTION]: String(!devtools) },
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
      if (devtools) {
        expect(
          fake.opened.map(({ policy }) => [policy.folder, policy.mcpServers]),
        ).toEqual([
          ["/work/lane", servers],
          [undefined, undefined],
          ["/work/lane", servers],
        ]);
      }
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

// The subprocess must receive the chat identity to attribute Records calls.
test("an attended Codex write turn launches Neuve Records with its chat identity", async () => {
  const server = codex();
  const run = await fixture({
    channel: "records-fixture",
    accounts: [
      Account.parse({
        name: "codex",
        kind: "chatgpt-subscription",
        runtime: "codex",
        credential: { kind: "codex-home" },
      }),
    ],
    runtimes: [
      {
        ...new FakeRuntime().shape,
        kind: "codex",
        continuation: ({ name }) => ({ runtime: "codex", key: name }),
        capabilities: () => Effect.succeed(capabilities),
        openSession: (account, policy, start) =>
          openCodexSession({
            account: account.name,
            program: "/fixture/codex",
            cwd: "/work",
            environment: {},
            policy,
            start,
          }).pipe(Effect.provide(server.layer)),
      },
    ],
  });
  const which = Bun.which;
  const lookup = spyOn(Bun, "which").mockImplementation((command, options) =>
    command === "neuve" ? "/fixture/bin/neuve" : which(command, options),
  );
  try {
    run.pi.install(
      defineExtension({
        name: "attended-records-test",
        hooks: [
          hook(GenerationTask, {
            beforeRequest({ messages }) {
              const marker: SystemMessage = {
                role: "system",
                content: "",
                sections: { [ATTENDED_SECTION]: "true" },
                timestamp: 0,
              };
              return { messages: [...messages, marker] };
            },
          }),
        ],
      }),
    );
    await run.conversation.configure({ cwd: "/work" }, context);
    const submitted = run.submit("Record proof after changing the notes");
    await until(
      () =>
        server.processes
          .at(-1)
          ?.io.written.some(({ method }) => method === "turn/start") ?? false,
    );
    expect(
      server
        .current()
        .args.filter((arg) => arg.startsWith("mcp_servers.neuve_records.")),
    ).toEqual([
      'mcp_servers.neuve_records.command="/fixture/bin/neuve"',
      'mcp_servers.neuve_records.args=["mcp","--repo","/work"]',
      `mcp_servers.neuve_records.env={"NEUVE_ACE_CHAT"="records-fixture/${run.conversation.id}"}`,
      'mcp_servers.neuve_records.default_tools_approval_mode="approve"',
      "mcp_servers.neuve_records.tool_timeout_sec=31536000",
    ]);
    server.send("turn/completed", completed("completed"));
    expect((await submitted).status).toBe("done");
  } finally {
    lookup.mockRestore();
    await run.close();
  }
});

test("a Codex chat with DevTools continues after a command and preserves overlapping work in order", async () => {
  const codex = Account.parse({
    name: "codex",
    kind: "chatgpt-subscription",
    runtime: "codex",
    credential: { kind: "codex-home" },
  });
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
  let finishWork: (() => void) | undefined;
  (fake as { shape: FakeRuntime["shape"] }).shape = {
    ...fake.shape,
    kind: "codex",
    continuation: ({ name }) => ({ runtime: "codex", key: name }),
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
          startTurn: (input) =>
            Effect.sync(() => {
              turns.push(input);
              turnId = input.turnId;
              thread = "thread-1";
              emit({ type: "turn.started" });
              emit({ type: "text", text: "Reading. " });
              const read = work("c1", "command", {
                command: "cat notes.txt",
                cwd: "/work/lane",
              });
              emit(read.start);
              emit({ type: "text", text: "Editing. " });
              const edit = work("f1", "file-change", {
                changes: [{ path: "notes.txt", kind: "update" }],
              });
              emit(edit.start);
              emit(edit.finish("-hello\n+hello, world", true));
              finishWork = () => {
                emit(read.finish("hello"));
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
              };
            }),
          steerTurn: () => Effect.void,
          interruptTurn: () => Effect.void,
          setModel: () => Effect.void,
          respondToApproval: () =>
            Effect.sync(() => {
              released++;
              return { delivered: true } as const;
            }),
          events: Stream.fromQueue(queue),
        } satisfies RuntimeSession as RuntimeSession;
      }),
  };
  const browserTool = "chrome-devtools_list_pages";
  const run = await fixture({
    accounts: [codex],
    fake,
    toolName: "question",
    plugins: {
      httpTools: () => new Set(),
      nativeTool: (name) => name === browserTool,
      nativeServers: (folder) =>
        folder === undefined
          ? undefined
          : {
              "chrome-devtools": {
                type: "stdio",
                command: "devtools-fixture",
                args: [folder],
              },
            },
    },
  });
  run.pi.install(
    defineExtension({
      name: "ace-plugin-chrome-devtools",
      tools: [
        defineTool({
          name: browserTool,
          description: "List pages.",
          parameters: Type.Object({}),
          execute: async () => {
            throw new Error(
              "The bridge must not call pi's Chrome DevTools tool.",
            );
          },
        }),
      ],
    }),
  );
  try {
    await run.conversation.configure({ cwd: "/work/lane" }, context);
    const submitted = run.submit("change the notes");
    await until(async () =>
      (await run.messages()).some(
        (m) => m.role === "assistant" && m.stopReason === "toolUse",
      ),
    );
    const running = (await run.conversation.context(context)).entries.flatMap(
      (entry) => entry.model ?? [],
    );
    expect(
      running.filter(
        (message) =>
          message.role === "assistant" || message.role === "toolResult",
      ),
    ).toEqual([
      expect.objectContaining({
        role: "assistant",
        content: [
          { type: "text", text: "Reading. " },
          expect.objectContaining({
            type: "toolCall",
            name: "runtime_work",
            arguments: {
              kind: "command",
              input: { command: "cat notes.txt", cwd: "/work/lane" },
            },
          }),
        ],
      }),
    ]);
    if (!finishWork) throw new Error("Work did not start");
    finishWork();
    const settled = await submitted;
    const last = (await run.conversation.context(context)).entries
      .flatMap((entry) => entry.model ?? [])
      .findLast((message) => message.role === "assistant");
    expect(last).toMatchObject({
      stopReason: "stop",
      content: [{ type: "text", text: "Done." }],
    });
    expect(settled.status).toBe("done");
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
        },
      }),
      expect.objectContaining({
        name: RUNTIME_WORK_TOOL,
        arguments: expect.objectContaining({
          kind: "file-change",
        }),
      }),
    ]);
    const results = messages.filter((m) => m.role === "toolResult");
    expect(results.map((result) => result.toolCallId)).toEqual(
      calls.map((call) => call.id),
    );
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
    expect(
      messages.flatMap((m) =>
        m.role === "assistant"
          ? m.content.map((b) => (b.type === "text" ? b.text : b.type))
          : m.role === "toolResult"
            ? [m.role]
            : [],
      ),
    ).toEqual([
      "Reading. ",
      "toolCall",
      "toolResult",
      "Editing. ",
      "toolCall",
      "toolResult",
      "Done.",
    ]);
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
    expect(opened).toHaveLength(1);
    expect(opened[0]?.mcpServers).toEqual({
      "chrome-devtools": {
        type: "stdio",
        command: "devtools-fixture",
        args: ["/work/lane"],
      },
    });
    expect(opened[0]?.tools.map((tool) => tool.name)).toEqual(["question"]);
    // A call the bridge did not record, as a model calling the tool would make, gets nothing.
    expect(run.bridge.takeWorkResult("work-forged")).toBeUndefined();
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
        return {
          nativeSessionId: "thread-1",
          startTurn: (input) =>
            Effect.sync(() => {
              turnId = input.turnId;
              void (async () => {
                emit({ type: "turn.started" });
                emit(work("before").start);
                emit(work("before").finish("one"));
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
                emit(work("after").start);
                emit(work("after").finish("two"));
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
          respondToApproval: () => Effect.succeed({ delivered: true }),
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
              b.type === "toolCall" ? [[b.name, b.arguments]] : [],
            )
          : [],
      ),
    ).toEqual([
      ["runtime_work", { kind: "command", input: { command: "before" } }],
      ["question", { n: 7 }],
      ["runtime_work", { kind: "command", input: { command: "after" } }],
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
                emit(work("ls").start);
                emit(work("ls").finish("notes.txt"));
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
          respondToApproval: () => Effect.succeed({ delivered: true }),
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
          respondToApproval: () => Effect.succeed({ delivered: true }),
          events: Stream.fromQueue(queue),
        } satisfies RuntimeSession as RuntimeSession;
      }),
  };
  return fake;
};
const work = (
  workId: string,
  kind = "command",
  input: Record<string, unknown> = { command: workId },
) => {
  const fields = { workId, kind, input };
  return {
    start: { ...fields, type: "work.started" },
    finish: (output = workId, errored = false) => ({
      ...fields,
      type: "work.finished",
      output,
      errored,
    }),
  };
};

test.each([
  ["person stops the chat", "Tool runtime_work was aborted"],
  ["Codex interrupts the turn", "Stopped."],
  ["the turn finishes the work", "first result"],
  ["the session dies", "The runtime ended before reporting a result."],
] as const)(
  "work settles when %s and a reopened chat records new work once",
  async (event, result) => {
    const running = work("c1", "command", { command: "sleep 120" });
    const reopened = work("c2", "command", { command: "pwd" });
    let finishTurn: (() => void) | undefined;
    let turns = 0;
    const fake = scripted((emit, end) => {
      emit({ type: "turn.started" });
      if (++turns === 1) {
        emit({ type: "text", text: "Starting. " });
        emit(running.start);
        if (event === "person stops the chat") {
          emit({ type: "text", text: "Buffered text." });
          emit(work("queued").start);
        }
        finishTurn = () => {
          if (event === "the session dies") {
            end();
          } else {
            const interrupted = event === "Codex interrupts the turn";
            emit(running.finish(result, interrupted));
            emit(
              interrupted
                ? { type: "turn.finished", outcome: { status: "interrupted" } }
                : {
                    type: "turn.finished",
                    outcome: { status: "completed" },
                    resumePoint: "finished",
                  },
            );
          }
        };
        return;
      }
      emit(reopened.start);
      emit(reopened.finish("/work/lane"));
      emit({ type: "text", text: "Back." });
      emit({
        type: "turn.finished",
        outcome: { status: "completed" },
        resumePoint: "reopened",
      });
    });
    const run = await fixture({ fake });
    try {
      await run.conversation.configure({ cwd: "/work/lane" }, context);
      const submitted = run.submit("go");
      await until(
        async () =>
          (
            await run.harness.snapshot(LiveDoc, run.conversation.id, context)
          )?.tools?.some(
            (slot) => slot.name === "runtime_work" && slot.status === "running",
          ) ?? false,
      );
      expect(
        (await run.conversation.context(context)).entries.some((entry) =>
          entry.model?.some((message) => message.role === "toolResult"),
        ),
      ).toBe(false);
      if (event === "person stops the chat") {
        await run.stopApprovals();
        await run.conversation.abort(context);
        await run.conversation.submit(
          {
            type: "write",
            entry: { kind: STOP_ENTRY_KIND, data: { author: "test" } },
          },
          context,
        );
      } else {
        if (!finishTurn) throw new Error("Work did not start");
        finishTurn();
      }
      await submitted;
      expect((await run.submit("again")).status).toBe("done");
      const entries = (await run.conversation.context(context)).entries;
      const messages = entries.flatMap((entry) => entry.model ?? []);
      const calls = messages.flatMap((m) =>
        m.role === "assistant"
          ? m.content.filter((b) => b.type === "toolCall")
          : [],
      );
      const outcomes = messages.filter((m) => m.role === "toolResult");
      expect(calls.map((call) => call.arguments)).toEqual([
        { kind: "command", input: { command: "sleep 120" } },
        { kind: "command", input: { command: "pwd" } },
      ]);
      expect(outcomes.map((outcome) => outcome.toolCallId)).toEqual([
        "work-c1",
        "work-c2",
      ]);
      expect(outcomes.map((outcome) => outcome.isError)).toEqual([
        event !== "the turn finishes the work",
        false,
      ]);
      if (event === "person stops the chat")
        expect(JSON.stringify(entries)).toContain(result);
      else
        expect(outcomes[0]?.content).toEqual([{ type: "text", text: result }]);
      expect(outcomes[1]?.content).toEqual([
        { type: "text", text: "/work/lane" },
      ]);
      expect(JSON.stringify(entries)).not.toContain("Buffered text.");
    } finally {
      await run.close();
    }
  },
);

// Why: Codex's process can die while pi still records its work. Everything Codex reported before
// its stream ended (each command it really ran, and the turn's failure) must still be recorded.
test("the stream ending with work still kept records every piece and the turn's failure", async () => {
  const fake = scripted((emit, end) => {
    emit({ type: "turn.started" });
    emit(work("first").start);
    emit(work("first").finish());
    emit(work("second").start);
    emit(work("second").finish());
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
          ? m.content.flatMap((b) =>
              b.type === "toolCall" ? [b.arguments] : [],
            )
          : [],
      ),
    ).toEqual([
      { kind: "command", input: { command: "first" } },
      { kind: "command", input: { command: "second" } },
    ]);
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
    emit(work("only").start);
    emit(work("only").finish());
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
          respondToApproval: () => Effect.succeed({ delivered: true }),
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
