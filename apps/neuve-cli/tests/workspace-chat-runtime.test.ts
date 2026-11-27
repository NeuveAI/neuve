import { expect, test } from "bun:test";
import { createModels } from "@earendil-works/pi-ai";
import {
  workspaceChatModels,
  workspaceChatRuntime,
} from "../src/workspace-chat-runtime.ts";
import {
  account,
  fixture,
  testModels,
} from "../../../packages/harness/tests/chat-runtime/fixture.ts";

test("absent injected sources preserve the existing Models object, so current pi workers change nothing", async () => {
  const native = createModels();
  const runtime = await workspaceChatRuntime(
    native,
    "/private/tmp/unused-chat-runtime",
  );
  expect(runtime.models).toBe(native);
  expect(runtime.extensions).toEqual([]);
  expect(runtime.owns("subscription")).toBe(false);
  expect((await workspaceChatModels()).current()).toEqual([]);
  await runtime.close();
});

test("the host lists status rows and their exact efforts only while signed in, so its picker follows the runtime", async () => {
  const run = await fixture({
    accounts: [account(), account("faux")],
    statusModels: [
      ...testModels,
      {
        id: "simple",
        displayName: "Simple",
        description: "No effort control",
        supportsEffort: false,
      },
      {
        id: "unspecified",
        displayName: "Unspecified",
        description: "Effort support absent",
        supportedEffortLevels: ["high"],
      },
      {
        id: "no-levels",
        displayName: "No levels",
        description: "Effort levels absent",
        supportsEffort: true,
      },
    ],
  });
  const name = account().name;
  try {
    // Use a status-only registry facade: listing must not open any session.
    const { Effect, Stream } = await import("effect");
    const listing = await workspaceChatModels(run.native, {
      registry: {
        accountEvents: Stream.empty,
        capabilities: () => Effect.succeed(run.fake.capabilities),
        continuation: () =>
          Effect.succeed({ runtime: "claude-code", key: "test" }),
        openSession: () => Effect.die("Listing must not open a session"),
        probe: () => Effect.succeed(run.statuses.values[0]!),
        signOut: () => Effect.void,
      },
      statuses: run.statuses,
    });
    expect(listing.current().filter((row) => row.provider === name)).toEqual([
      {
        provider: name,
        modelId: "sonnet",
        efforts: ["low", "medium", "high", "xhigh", "max"],
      },
      {
        provider: name,
        modelId: "real",
        efforts: ["low", "medium", "high"],
      },
      { provider: name, modelId: "simple", efforts: [] },
      { provider: name, modelId: "unspecified", efforts: [] },
      { provider: name, modelId: "no-levels", efforts: [] },
    ]);
    // The host's picker needs the same selectable provider ID and real account name as the worker.
    expect(
      listing.current().filter((row) => row.account === "faux"),
    ).toContainEqual({
      provider: "account:faux",
      account: "faux",
      modelId: "sonnet",
      efforts: ["low", "medium", "high", "xhigh", "max"],
    });
    run.statuses.set([
      {
        ...run.statuses.values[0]!,
        signIn: {
          state: "not-signed-in",
          hint: { kind: "command", command: "neuve auth login", account: name },
        },
      },
    ]);
    expect(listing.current()).toEqual([]);
    expect(run.fake.opened).toEqual([]);
    await listing.close();
  } finally {
    await run.close();
  }
});

// Questions have no submission, so the gate must follow the production document's answer commit.
for (const skipped of [false, true]) {
  for (const afterAttach of [false, true]) {
    test(`a question ${skipped ? "skip" : "answer"} ${afterAttach ? "after" : "before"} attach ${afterAttach ? "releases" : "preserves"} the restart gate`, async () => {
      const { Questions, QuestionsDoc, answer } =
        await import("../../../packages/channel/src/questions.ts");
      const { QUESTIONS_DOC_KIND } =
        await import("@neuve/harness/chat-runtime");
      const { CapturedStorage } =
        await import("../../../packages/harness/tests/chat-runtime/captured-storage.ts");
      const { context, until } =
        await import("../../../packages/harness/tests/chat-runtime/fixture.ts");
      expect(QUESTIONS_DOC_KIND).toBe(QuestionsDoc.definition.kind);
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
      const work = source.submit("ask a question").catch(() => undefined);
      let reopened: Awaited<ReturnType<typeof fixture>> | undefined;
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
        let copy;
        if (!afterAttach) {
          // Capture the actual answer commit before the tool can finish, just as a crash can.
          const captured =
            Promise.withResolvers<
              Awaited<ReturnType<typeof storage.snapshot>>
            >();
          const stop = source.harness.subscribeCommits(({ changes }) => {
            if (
              changes.some(
                (change) =>
                  change.type === "document" &&
                  change.record.kind === QuestionsDoc.definition.kind &&
                  change.ops.some(
                    (op) => op[0] === "s" && op[1][2] === "answer",
                  ),
              )
            ) {
              void storage.snapshot().then(captured.resolve, captured.reject);
            }
          });
          try {
            await answer(
              source.harness,
              source.conversation.id,
              "question-call",
              "person",
              skipped ? null : [{ choices: [0] }],
              context,
            );
            copy = await captured.promise;
          } finally {
            stop();
          }
        } else copy = await storage.snapshot();
        await source.close();
        await work;
        reopened = await fixture({
          storage: copy,
          conversationId: source.conversation.id,
        });
        reopened.pi.install(new Questions(() => {}).extension);
        reopened.fake.frames.push({ text: "answer acknowledged" });
        if (afterAttach)
          await answer(
            reopened.harness,
            reopened.conversation.id,
            "question-call",
            "person",
            skipped ? null : [{ choices: [0] }],
            context,
          );
        await reopened.harness.waitForIdle(context);
        expect(reopened.fake.requests).toHaveLength(afterAttach ? 1 : 0);
        const messages = (
          await reopened.conversation.context(context)
        ).entries.flatMap((entry) => entry.model ?? []);
        expect(
          messages.findLast((message) => message.role === "assistant")
            ?.stopReason,
        ).toBe(afterAttach ? "stop" : "aborted");
        expect(
          (
            await reopened.harness.snapshot(
              QuestionsDoc,
              reopened.conversation.id,
              context,
            )
          )?.questions["question-call"]?.answer,
        ).toMatchObject({
          author: "person",
          ...(skipped ? { skipped: true } : {}),
        });
        if (!afterAttach) {
          // A pre-crash answer stays gated until a new person action, then reaches the runtime.
          await reopened.submit("person: continue with the recorded answer");
          expect(reopened.fake.requests).toHaveLength(1);
        }
        const sent = JSON.stringify(reopened.fake.requests[0]?.input);
        expect(sent).toContain(
          skipped ? "person skipped the question" : "answeredBy",
        );
        if (!skipped) expect(sent).toContain("choices");
      } finally {
        await reopened?.close();
        await source.close();
        await work;
      }
    });
  }
}

// An edit is a person's action without a submission; only edits committed after attach authorize recovery.
for (const afterAttach of [false, true]) {
  test(`a real channel edit ${afterAttach ? "after" : "before"} attach ${afterAttach ? "releases" : "preserves"} the restart gate`, async () => {
    const { Channel } = await import("@ace/channel");
    const { EDIT_ENTRY_KIND, chatRuntimeExtension } =
      await import("@neuve/harness/chat-runtime");
    const { CapturedStorage } =
      await import("../../../packages/harness/tests/chat-runtime/captured-storage.ts");
    const { context, until } =
      await import("../../../packages/harness/tests/chat-runtime/fixture.ts");
    const storage = new CapturedStorage();
    const source = await fixture({
      storage,
      execute: async (_n, _read, signal) => {
        await new Promise<void>((resolve) =>
          signal?.addEventListener("abort", () => resolve(), { once: true }),
        );
        return { content: [{ type: "text", text: "old result" }] };
      },
    });
    source.fake.frames.push({
      calls: [{ callId: "edit-call", toolName: "probe", input: { n: 1 } }],
    });
    const work = source
      .submit("person: original request")
      .catch(() => undefined);
    let reopened: Awaited<ReturnType<typeof fixture>> | undefined;
    let channel: Awaited<ReturnType<typeof Channel.open>> | undefined;
    let extension: ReturnType<typeof chatRuntimeExtension> | undefined;
    try {
      await until(() => source.executed.length === 1);
      const entry = (await source.conversation.context(context)).entries.find(
        (entry) => entry.kind === "pi.user",
      );
      if (!entry) throw new Error("Missing person's message");
      const copy = await storage.snapshot();
      await source.close();
      await work;
      reopened = await fixture();
      reopened.fake.frames.push({ text: "edited request acknowledged" });
      extension = chatRuntimeExtension(
        reopened.bridge,
        (provider) => provider === account().name,
      );
      const runtimeExtension = extension;
      let attached: import("@earendil-works/pi-durable").Harness | undefined;
      const committed: import("@earendil-works/pi-durable").EntryRecord[] = [];
      const submissions: unknown[] = [];
      channel = await Channel.open({
        id: "chat-runtime-edit",
        name: "edit",
        owner: "person",
        project: "/private/tmp",
        storage: copy,
        models: reopened.models,
        resume: false,
        env: () => {
          throw new Error("No execution expected");
        },
        directory: {
          self: { id: "chat-runtime-edit", name: "edit" },
          list: async () => [],
          deliver: async () => {},
        },
        log: () => {},
        extension: {
          extensions: runtimeExtension.extensions,
          // Captions are outside this turn and must use the ordinary pi model layer.
          nonTurnModels: () => reopened!.native,
          attach: async (harness) => {
            attached = harness;
            harness.subscribeCommits(({ changes }) => {
              for (const change of changes) {
                if (change.type === "entry") committed.push(change.value);
                if (change.type === "submission")
                  submissions.push(change.value);
              }
            });
            if (afterAttach) await runtimeExtension.attach(harness);
          },
        },
      });
      await channel.handle(
        {
          op: "edit",
          author: "person",
          chat: source.conversation.id,
          entry: entry.id,
          text: "edited request",
        },
        () => {},
      );
      expect(committed).toHaveLength(1);
      expect(committed[0]?.kind).toBe(EDIT_ENTRY_KIND);
      expect(submissions).toEqual([]);
      if (!attached) throw new Error("Missing channel harness");
      if (!afterAttach) await runtimeExtension.attach(attached);
      await attached.waitForIdle(context);
      expect(reopened.fake.requests).toHaveLength(afterAttach ? 1 : 0);
      if (afterAttach)
        expect(JSON.stringify(reopened.fake.requests[0]?.input)).toContain(
          "edited request",
        );
    } finally {
      await channel?.close();
      await extension?.close();
      await reopened?.close();
      await source.close();
      await work;
    }
  });
}

// The public request boundary must preserve both person release and agent rejection.
for (const action of ["ask", "answer"] as const) {
  test(`Channel.handle ${action} releases a recovered question and delivers the person's input`, async () => {
    const { Channel } = await import("@ace/channel");
    const { chatRuntimeExtension } =
      await import("@neuve/harness/chat-runtime");
    const { Questions, QuestionsDoc } =
      await import("../../../packages/channel/src/questions.ts");
    const { CapturedStorage } =
      await import("../../../packages/harness/tests/chat-runtime/captured-storage.ts");
    const { context, until } =
      await import("../../../packages/harness/tests/chat-runtime/fixture.ts");
    const { LiveDoc } = await import("@earendil-works/pi-durable");
    const { NodeExecutionEnv } =
      await import("@earendil-works/pi-durable/env/node");
    const storage = new CapturedStorage();
    const source = await fixture({ storage });
    source.pi.install(new Questions(() => {}).extension);
    source.fake.frames.push({
      calls: [
        {
          callId: "public-question",
          toolName: "question",
          input: {
            questions: [
              {
                header: "Choice",
                question: "Which?",
                options: [{ label: "Alpha", description: "Use Alpha" }],
                multiple: false,
              },
            ],
          },
        },
      ],
    });
    const work = source.submit("person: ask a question").catch(() => undefined);
    let channel: Awaited<ReturnType<typeof Channel.open>> | undefined;
    let runtime: Awaited<ReturnType<typeof fixture>> | undefined;
    let extension: ReturnType<typeof chatRuntimeExtension> | undefined;
    let attached: import("@earendil-works/pi-durable").Harness | undefined;
    try {
      await until(
        async () =>
          !!(
            await source.harness.snapshot(
              QuestionsDoc,
              source.conversation.id,
              context,
            )
          )?.questions["public-question"],
      );
      const copy = await storage.snapshot();
      await source.close();
      await work;
      runtime = await fixture();
      extension = chatRuntimeExtension(
        runtime.bridge,
        (provider) => provider === account().name,
      );
      const selected = runtime;
      const runtimeExtension = extension;
      channel = await Channel.open({
        id: `public-${action}`,
        name: "public",
        owner: "person",
        project: "/private/tmp",
        storage: copy,
        models: runtime.models,
        resume: false,
        env: (cwd) => new NodeExecutionEnv({ cwd }),
        directory: {
          self: { id: `public-${action}`, name: "public" },
          list: async () => [],
          deliver: async () => {},
        },
        log: () => {},
        extension: {
          extensions: runtimeExtension.extensions,
          nonTurnModels: () => selected.native,
          attach: async (harness) => {
            attached = harness;
            await runtimeExtension.attach(harness);
          },
        },
      });
      if (!attached) throw new Error("Missing Harness");
      await attached.resume();
      await until(
        async () =>
          (
            await attached!.snapshot(LiveDoc, source.conversation.id, context)
          )?.tools?.some(
            (slot) => slot.name === "question" && slot.status === "running",
          ) === true,
      );
      expect(runtime.fake.requests).toEqual([]);
      if (action === "ask") {
        // A live agent's public message has no recovered task in this Harness.
        await channel.handle(
          {
            op: "ask",
            author: "agent@other-channel",
            chat: source.conversation.id,
            text: "automatic live agent message",
          },
          () => {},
        );
        await attached.waitForIdle(context);
        expect(runtime.fake.requests).toEqual([]);
      }
      runtime.fake.frames.push({ text: "received" });
      await channel.handle(
        action === "answer"
          ? {
              op: "answer",
              author: "person",
              chat: source.conversation.id,
              call: "public-question",
              answers: [{ choices: [0] }],
            }
          : {
              op: "ask",
              author: "person",
              chat: source.conversation.id,
              text: "public person message",
            },
        () => {},
      );
      await attached.waitForIdle(context);
      expect(runtime.fake.requests).toHaveLength(1);
      const sent = JSON.stringify(runtime.fake.requests[0]?.input);
      expect(sent).toContain(
        action === "answer" ? "Alpha" : "public person message",
      );
      if (action === "answer") expect(sent).toContain("answeredBy");
      expect(sent).not.toContain("Tool question was aborted");
    } finally {
      await channel?.close();
      await extension?.close();
      await runtime?.close();
      await source.close();
      await work;
    }
  });
}
