import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import {
  AccountNotFound,
  AccountRejected,
  CapabilityUnsupported,
  RuntimeUnavailable,
  SignInRequired,
  TurnFailed,
  UsageLimitReached,
  type RuntimeRegistryShape,
} from "@neuve/runtime";
import { Effect } from "effect";
import {
  ChatRuntimeBridge,
  NativeHeads,
} from "../../src/chat-runtime/index.ts";
import { resumeFailed } from "../../src/chat-runtime/failure.ts";
import { account, caps, context, fixture, until } from "./fixture.ts";

const route = {
  name: account().name,
  capabilities: caps,
  continuation: { runtime: account().runtime, key: "/shared" },
};

// O1: a runtime violating the fork identity contract must never transfer source ownership.
test("a fork reporting its source id is closed before any head or request is written", async () => {
  let invalid = true;
  const run = await fixture({
    registry: (registry) => ({
      ...registry,
      openSession: (name, policy, start) =>
        Effect.gen(function* () {
          const session = yield* registry.openSession(name, policy, start);
          return {
            ...session,
            get nativeSessionId() {
              return invalid && start?.kind === "resume" && start.fork
                ? start.session
                : session.nativeSessionId;
            },
          };
        }),
    }),
  });
  try {
    run.fake.frames.push({ text: "source answer" });
    await run.submit("source input");
    const source = run.heads.get(String(run.conversation.id));
    const copy = await run.harness.createConversation(
      { ownership: { kind: "ownerless" } },
      context,
    );
    const messages: Message[] = [
      ...(await run.messages()),
      { role: "user", content: "copy input", timestamp: 2 },
    ];
    const model = run.models.getModel("subscription", "sonnet")!;
    run.bridge.identify(messages, copy.id, "invalid-fork");
    const refused = await run.bridge
      .stream(route, model, { messages }, undefined, { id: "sonnet" })
      .result();
    expect(refused.errorMessage).toBe(resumeFailed);
    expect(run.heads.get(String(copy.id))).toBeUndefined();
    expect(run.heads.get(String(run.conversation.id))).toEqual(source);
    expect(run.fake.requests).toHaveLength(1);
    await until(() => run.fake.opened[1]?.session.closed === 1);
    invalid = false;
    run.fake.frames.push({ text: "valid fork" });
    run.bridge.identify(messages, copy.id, "valid-fork");
    expect(
      (
        await run.bridge
          .stream(route, model, { messages }, undefined, { id: "sonnet" })
          .result()
      ).responseId,
    ).toBe("native:session-3:point-2:c");
    expect(run.heads.get(String(copy.id))?.session).toBe("session-3");
    expect(run.fake.opened[0]?.session.closed).toBe(0);
  } finally {
    await run.close();
  }
});

const accountFailures = [
  {
    error: new AccountNotFound({ account: account().name }),
    text: "The selected account subscription is no longer available.",
  },
  {
    error: new SignInRequired({
      account: account().name,
      hint: { kind: "command", command: "claude auth login" },
    }),
    text: "Sign in for subscription: run claude auth login on this machine, then send your message again.",
  },
  {
    error: new AccountRejected({ account: account().name }),
    text: "Sign in again for subscription.",
  },
  {
    error: new RuntimeUnavailable({
      account: account().name,
      reason: "not-installed",
    }),
    text: "The selected account subscription cannot run here.",
  },
  {
    error: new CapabilityUnsupported({
      account: account().name,
      capability: "resume",
    }),
    text: "The selected account subscription cannot continue this turn.",
  },
  {
    error: new UsageLimitReached({ account: account().name }),
    text: "Usage limit reached for subscription.",
  },
];
for (const phase of ["resume", "fallback fork"] as const) {
  // O2: account failures are terminal at either acquisition boundary and must never trigger another open.
  test(`typed account failures on ${phase} keep their text and stop acquisition`, async () => {
    for (const failure of accountFailures) {
      let armed = false;
      let attempts = 0;
      const run = await fixture({
        registry: (registry) => ({
          ...registry,
          openSession: (...args) => {
            if (!armed) return registry.openSession(...args);
            attempts++;
            return phase === "fallback fork" && attempts === 1
              ? Effect.fail(
                  new TurnFailed({
                    account: account().name,
                    reason: "protocol-error",
                  }),
                )
              : Effect.fail(failure.error);
          },
        }),
      });
      try {
        run.fake.frames.push({ text: "first answer" });
        await run.submit("first input");
        await run.bridge.closeConversation(String(run.conversation.id));
        armed = true;
        const messages: Message[] = [
          ...(await run.messages()),
          { role: "user", content: "next", timestamp: 2 },
        ];
        run.bridge.identify(messages, run.conversation.id, "typed-open");
        const result = await run.bridge
          .stream(
            route,
            run.models.getModel("subscription", "sonnet")!,
            { messages },
            undefined,
            { id: "sonnet" },
          )
          .result();
        expect(result.errorMessage).toBe(failure.text);
        expect(attempts).toBe(phase === "resume" ? 1 : 2);
        expect(run.fake.requests).toHaveLength(1);
      } finally {
        await run.close();
      }
    }
  });
}

// O3: cleanup defects cannot retain a live entry, held tool handler, or the worker's heads writer.
test("a failing finalizer releases held calls and permits another turn and worker close", async () => {
  let fail = true;
  const run = await fixture({
    registry: (registry) => ({
      ...registry,
      openSession: (...args) =>
        Effect.gen(function* () {
          const session = yield* registry.openSession(...args);
          if (fail) {
            fail = false;
            yield* Effect.addFinalizer(() =>
              Effect.die("private finalizer details"),
            );
          }
          return session;
        }),
    }),
  });
  let headsClosed = false;
  const closeHeads = run.heads.close.bind(run.heads);
  run.heads.close = async () => {
    await closeHeads();
    headsClosed = true;
  };
  try {
    run.fake.frames.push({ text: "first" });
    await run.submit("first");
    const messages: Message[] = [
      ...(await run.messages()),
      { role: "user", content: "tool", timestamp: 2 },
    ];
    run.bridge.identify(messages, run.conversation.id, "held-tool");
    run.fake.frames.push({
      calls: [{ callId: "held", toolName: "probe", input: { n: 1 } }],
    });
    const result = await run.bridge
      .stream(
        route,
        run.models.getModel("subscription", "sonnet")!,
        { messages },
        undefined,
        { id: "sonnet" },
      )
      .result();
    expect(result.stopReason).toBe("toolUse");
    await until(() => run.fake.order.includes("handler:held"));
    await run.bridge.closeConversation(String(run.conversation.id));
    expect(run.fake.opened[0]?.session.closed).toBe(1);
    expect(run.fake.opened[0]?.session.jobs.size).toBe(0);
    expect(
      run.fake.logs.filter((row) => row.event === "chat-runtime.close.failed"),
    ).toEqual([
      { event: "chat-runtime.close.failed", fields: { cause: "Die" } },
    ]);
    run.fake.frames.push({ text: "second" });
    expect((await run.submit("second")).status).toBe("done");
    expect(run.fake.opened).toHaveLength(2);
    await run.bridge.close();
    expect(headsClosed).toBe(true);
  } finally {
    await run.close();
  }
});

// F10: acquireRelease masks cancellation until its acquisition and late-registered release finish.
for (const fails of [false, true]) {
  test(`close joins pending acquisition and its ${fails ? "failing" : "successful"} late finalizer while aborting the generation promptly`, async () => {
    const acquire = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let acquiring = false;
    let finalizing = false;
    let alive = false;
    let closeReturned = false;
    const run = await fixture({
      registry: (registry) => ({
        ...registry,
        openSession: (...args) =>
          Effect.gen(function* () {
            yield* Effect.acquireRelease(
              Effect.promise(async () => {
                alive = true;
                acquiring = true;
                await acquire.promise;
                return {};
              }),
              () =>
                Effect.promise(async () => {
                  finalizing = true;
                  await release.promise;
                  alive = false;
                }).pipe(
                  Effect.andThen(
                    fails
                      ? Effect.die("private late release details")
                      : Effect.void,
                  ),
                ),
            );
            return yield* registry.openSession(...args);
          }),
      }),
    });
    const work = run.submit("first");
    let closing: Promise<void> | undefined;
    try {
      try {
        await until(() => acquiring);
        closing = run.bridge.close().then(() => {
          closeReturned = true;
        });
        expect((await work).status).toBe("unanswered");
        expect(alive).toBe(true);
        expect(closeReturned).toBe(false);
        expect(run.fake.requests).toEqual([]);
      } finally {
        acquire.resolve();
      }
      try {
        await until(() => finalizing);
        expect(alive).toBe(true);
        expect(closeReturned).toBe(false);
        expect(run.fake.opened).toEqual([]);
      } finally {
        release.resolve();
      }
      await closing;
      expect(alive).toBe(false);
      expect(closeReturned).toBe(true);
      expect(
        run.fake.logs.filter(
          (row) => row.event === "chat-runtime.close.failed",
        ),
      ).toEqual(
        fails
          ? [{ event: "chat-runtime.close.failed", fields: { cause: "Die" } }]
          : [],
      );
    } finally {
      acquire.resolve();
      release.resolve();
      await closing;
      await work;
      await run.close();
    }
  });
}

for (const toolUse of [false, true]) {
  // Ruling 25(b): a native receipt can precede pi publication; pin it and replay only later input.
  test(`an uncommitted ${toolUse ? "tool" : "answer"} receipt pins its newest checkpoint on a second bridge`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "chat-runtime-r9-ahead-"));
    let registry: RuntimeRegistryShape | undefined;
    const run = await fixture({
      headsDirectory: directory,
      registry: (value) => (registry = value),
    });
    let reopened: ChatRuntimeBridge | undefined;
    try {
      run.fake.frames.push({ text: "committed answer" });
      await run.submit("first");
      const messages: Message[] = [
        ...(await run.messages()),
        { role: "user", content: "second", timestamp: 2 },
      ];
      run.bridge.identify(messages, run.conversation.id, "lost");
      run.fake.frames.push(
        toolUse
          ? {
              calls: [
                { callId: "lost-tool", toolName: "probe", input: { n: 1 } },
              ],
            }
          : { text: "lost answer" },
      );
      const lost = await run.bridge
        .stream(
          route,
          run.models.getModel("subscription", "sonnet")!,
          { messages },
          undefined,
          { id: "sonnet" },
        )
        .result();
      expect(lost.responseId).toBe(
        `native:session-1:point-2${toolUse ? "" : ":c"}`,
      );
      await run.bridge.close();
      reopened = new ChatRuntimeBridge({
        registry: registry!,
        heads: await NativeHeads.open(directory),
      });
      messages.push({ role: "user", content: "next", timestamp: 3 });
      reopened.identify(messages, run.conversation.id, "explicit-next");
      run.fake.frames.push({ text: "recovered" });
      expect(
        (
          await reopened
            .stream(
              route,
              run.models.getModel("subscription", "sonnet")!,
              { messages },
              undefined,
              { id: "sonnet" },
            )
            .result()
        ).stopReason,
      ).toBe("stop");
      expect(run.fake.opened.at(-1)?.start).toEqual({
        kind: "resume",
        session: "session-1",
        at: toolUse ? "point-1" : "point-2",
        fork: true,
      });
      expect(run.fake.requests.at(-1)?.input).toEqual([
        ...(toolUse ? [{ type: "text", text: "second" }] : []),
        { type: "text", text: "next" },
      ]);
      expect(run.executed).toEqual([]);
    } finally {
      await reopened?.close();
      await run.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

// A matching saved continuation cannot override the person's intervening switch to pi.
test("switching back after a pi reply starts the chosen handoff instead of resuming an older head", async () => {
  const run = await fixture();
  try {
    run.fake.frames.push({ text: "native answer" });
    await run.submit("native input");
    const reply = (await run.messages()).findLast(
      (message) => message.role === "assistant",
    )!;
    if (reply.role !== "assistant") throw new Error("Missing assistant reply");
    const { responseId: _pointer, ...piReply } = reply;
    const messages: Message[] = [
      ...(await run.messages()),
      { role: "user", content: "pi input", timestamp: 2 },
      {
        ...piReply,
        provider: "faux",
        model: "coder",
        content: [{ type: "text", text: "pi answer" }],
      },
      { role: "user", content: "back to native", timestamp: 3 },
    ];
    run.bridge.identify(messages, run.conversation.id, "chosen-return");
    run.fake.frames.push({ text: "new handoff" });
    expect(
      (
        await run.bridge
          .stream(
            route,
            run.models.getModel("subscription", "sonnet")!,
            { messages },
            undefined,
            { id: "sonnet" },
          )
          .result()
      ).stopReason,
    ).toBe("stop");
    expect(run.fake.opened[1]?.start).toEqual({ kind: "new" });
    expect(JSON.stringify(run.fake.requests.at(-1)?.input)).toContain(
      "pi answer",
    );
    expect(JSON.stringify(run.fake.requests.at(-1)?.input)).toContain(
      "Previous conversation",
    );
  } finally {
    await run.close();
  }
});

// Reset must forget the owning head even when no new assistant pointer exists yet.
test("reset removes a resolved owning head before the next generation", async () => {
  const run = await fixture();
  try {
    run.fake.frames.push({
      failure: {
        _tag: "TurnFailed",
        account: account().name,
        reason: "provider-failed",
      },
    });
    await run.submit("old input");
    await run.bridge.closeConversation(String(run.conversation.id));
    expect(run.heads.get(String(run.conversation.id))?.forkRequired).toBe(true);
    expect(run.heads.get(String(run.conversation.id))?.pending).toBeUndefined();
    await (
      await run.conversation.submit(
        { type: "write", entry: { kind: "pi.reset", head: "self", data: {} } },
        context,
      )
    ).wait(context);
    expect(run.heads.get(String(run.conversation.id))).toBeUndefined();
    run.fake.frames.push({ text: "fresh answer" });
    expect((await run.submit("fresh input")).status).toBe("done");
    expect(run.fake.opened[1]?.start).toEqual({ kind: "new" });
    expect(run.fake.requests.at(-1)?.input).toEqual([
      { type: "text", text: "fresh input" },
    ]);
  } finally {
    await run.close();
  }
});
