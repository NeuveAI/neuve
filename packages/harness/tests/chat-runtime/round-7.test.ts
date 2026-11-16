import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { TurnFailed } from "@neuve/runtime";
import { Effect, Scope } from "effect";
import { headDigest } from "../../src/chat-runtime/transcript.ts";
import { NativeHeads } from "../../src/chat-runtime/heads.ts";
import { account, caps, context, fixture, until } from "./fixture.ts";

function observe(run: Awaited<ReturnType<typeof fixture>>) {
  const messages: AssistantMessage[] = [];
  const stream = run.bridge.stream.bind(run.bridge);
  run.bridge.stream = (...args) => {
    const output = stream(...args);
    void output.result().then((message) => messages.push(message));
    return output;
  };
  return messages;
}

for (const end of [
  "ace.stopped",
  "pi.reset",
  "account",
  "signal",
  "worker",
] as const) {
  // F6: cancellation must reach the allocated session before openSession returns.
  test(`${end} settles an acquiring stream and closes its scope while acquisition is held`, async () => {
    const gate = Promise.withResolvers<void>();
    let scope: Scope.Scope | undefined;
    const run = await fixture({
      registry: (registry) => ({
        ...registry,
        openSession: (...args) =>
          Effect.gen(function* () {
            scope = yield* Scope.Scope;
            const session = yield* registry.openSession(...args);
            yield* Effect.promise(() => gate.promise);
            return session;
          }),
      }),
    });
    const results = observe(run);
    const controller = new AbortController();
    const stream = run.bridge.stream.bind(run.bridge);
    run.bridge.stream = (...args) =>
      stream(
        args[0],
        args[1],
        args[2],
        { ...args[3], signal: controller.signal },
        args[4],
      );
    const work = run.submit("first");
    try {
      await until(() => run.fake.opened.length === 1);
      if (end === "account") await run.bridge.closeAccount(account().name);
      else if (end === "signal") controller.abort();
      else if (end === "worker") await run.bridge.close();
      else
        await run.harness.commit(
          (tx) =>
            tx.appendEntry(run.conversation.id, {
              kind: end,
              ...(end === "pi.reset" ? { head: "self" } : {}),
              data: {},
            }),
          context,
        );
      await until(() => results.length === 1);
      expect(results[0]?.stopReason).toBe("aborted");
      expect(scope?.state._tag).toBe("Closed");
      expect(run.fake.opened[0]?.session.closed).toBe(1);
      expect(run.fake.requests).toEqual([]);
      expect(run.fake.unrecordedRequests).toBe(0);
      expect((await work).status).toBe("unanswered");
    } finally {
      gate.resolve();
      await work;
      await run.close();
    }
  });
}

for (const failure of ["interruption", "defect", "typed failure"] as const) {
  // F7: every unsuccessful acquisition exit must release its scope, including Effect interruption and defects.
  test(`${failure} during acquisition closes its allocated scope before the gate is released`, async () => {
    const gate = Promise.withResolvers<void>();
    let fail = () => {};
    let scope: Scope.Scope | undefined;
    const run = await fixture({
      registry: (registry) => ({
        ...registry,
        openSession: (...args) =>
          Effect.gen(function* () {
            scope = yield* Scope.Scope;
            const session = yield* registry.openSession(...args);
            yield* Effect.callback<void, TurnFailed>((resume) => {
              fail = () =>
                resume(
                  failure === "interruption"
                    ? Effect.interrupt
                    : failure === "defect"
                      ? Effect.die("failed acquisition")
                      : Effect.fail(
                          new TurnFailed({
                            account: account().name,
                            reason: "provider-failed",
                          }),
                        ),
                );
              void gate.promise.then(() => resume(Effect.void));
            });
            return session;
          }),
      }),
    });
    const results = observe(run);
    const work = run.submit("first");
    try {
      await until(() => run.fake.opened.length === 1);
      fail();
      expect((await work).status).toBe("unanswered");
      expect(results[0]?.stopReason).toBe("error");
      expect(scope?.state._tag).toBe("Closed");
      expect(run.fake.opened[0]?.session.closed).toBe(1);
      expect(run.fake.requests).toEqual([]);
    } finally {
      gate.resolve();
      await work;
      await run.close();
    }
  });
}

// A runtime may finish an uninterruptible acquisition after close; its closed scope must prevent resurrection.
test("a late acquisition return cannot reopen its closed scope or start a request", async () => {
  const gate = Promise.withResolvers<void>();
  let scope: Scope.Scope | undefined;
  let exited = false;
  const run = await fixture({
    registry: (registry) => ({
      ...registry,
      openSession: (...args) =>
        Effect.gen(function* () {
          scope = yield* Scope.Scope;
          const session = yield* registry.openSession(...args);
          yield* Effect.promise(() => gate.promise);
          return session;
        }).pipe(
          Effect.uninterruptible,
          Effect.ensuring(
            Effect.sync(() => {
              exited = true;
            }),
          ),
        ),
    }),
  });
  const results = observe(run);
  const work = run.submit("late open");
  let closing: Promise<void> | undefined;
  let returned = false;
  try {
    await until(() => run.fake.opened.length === 1);
    closing = run.bridge.close().then(() => {
      returned = true;
    });
    await until(() => results.length === 1);
    expect(results[0]?.stopReason).toBe("aborted");
    expect(scope?.state._tag).toBe("Closed");
    expect(run.fake.opened[0]?.session.closed).toBe(1);
    expect(run.fake.requests).toEqual([]);
    expect(exited).toBe(false);
    expect(returned).toBe(false);
  } finally {
    gate.resolve();
    await closing;
    expect(exited).toBe(true);
    await work;
    await run.close();
    expect(run.fake.opened[0]?.session.closed).toBe(1);
    expect(run.fake.requests).toEqual([]);
  }
});

for (const leaving of [0, 1]) {
  // R1: each subscriber owns its cancellation; only the last abort may cancel the shared run.
  test(`subscriber ${leaving} can leave a shared acquisition without cancelling its peer`, async () => {
    const gate = Promise.withResolvers<void>();
    let scope: Scope.Scope | undefined;
    const run = await fixture({
      registry: (registry) => ({
        ...registry,
        openSession: (...args) =>
          Effect.gen(function* () {
            scope = yield* Scope.Scope;
            const session = yield* registry.openSession(...args);
            yield* Effect.promise(() => gate.promise);
            return session;
          }),
      }),
    });
    const controllers = [new AbortController(), new AbortController()];
    const results: AssistantMessage[] = [];
    try {
      const messages: Message[] = [
        { role: "user", content: "same", timestamp: 1 },
      ];
      run.bridge.identify(messages, run.conversation.id, "shared");
      const model = run.models.getModel("subscription", "sonnet")!;
      const streams = controllers.map((controller) =>
        run.models.streamSimple(
          model,
          { messages },
          { signal: controller.signal },
        ),
      );
      for (const output of streams)
        void output.result().then((message) => results.push(message));
      await until(() => run.fake.opened.length === 1);
      controllers[leaving]!.abort();
      expect((await streams[leaving]!.result()).stopReason).toBe("aborted");
      expect(results).toHaveLength(1);
      expect(run.fake.opened[0]?.session.closed).toBe(0);
      controllers[1 - leaving]!.abort();
      expect((await streams[1 - leaving]!.result()).stopReason).toBe("aborted");
      await run.bridge.close();
      expect(scope?.state._tag).toBe("Closed");
      expect(run.fake.opened).toHaveLength(1);
      expect(run.fake.opened[0]?.session.closed).toBe(1);
      expect(run.fake.requests).toEqual([]);
    } finally {
      gate.resolve();
      await run.close();
    }
  });
}

// R1 also requires the remaining subscriber to receive the actual successful run, including all output after its peer leaves.
test("a subscriber without a signal receives the one answer after both cancellable subscribers leave", async () => {
  const run = await fixture();
  try {
    const messages: Message[] = [
      { role: "user", content: "shared answer", timestamp: 1 },
    ];
    run.bridge.identify(messages, run.conversation.id, "shared-answer");
    const model = run.models.getModel("subscription", "sonnet")!;
    const first = new AbortController();
    const second = new AbortController();
    run.fake.frames.push({ text: "the shared answer" });
    run.fake.admitted++;
    const route = {
      name: account().name,
      capabilities: caps,
      continuation: { runtime: account().runtime, key: "/shared" },
    };
    const a = run.bridge.stream(
      route,
      model,
      { messages },
      { signal: first.signal },
    );
    const b = run.bridge.stream(
      route,
      model,
      { messages },
      { signal: second.signal },
    );
    const c = run.bridge.stream(route, model, { messages });
    first.abort();
    second.abort();
    expect((await a.result()).stopReason).toBe("aborted");
    expect((await b.result()).stopReason).toBe("aborted");
    expect(await c.result()).toMatchObject({
      stopReason: "stop",
      content: [{ type: "text", text: "the shared answer" }],
    });
    expect(run.fake.opened).toHaveLength(1);
    expect(run.fake.requests).toHaveLength(1);
    await run.bridge.close();
    expect(run.fake.opened[0]?.session.closed).toBe(1);
    expect(run.fake.unrecordedRequests).toBe(0);
  } finally {
    await run.close();
  }
});

// Acquiring sessions are busy, so neither the idle cap nor its timer may close them.
test("idle retirement skips an acquiring session until explicit cancellation closes it under its gate", async () => {
  const gate = Promise.withResolvers<void>();
  let opening = 0;
  const run = await fixture({
    idleMs: 50,
    registry: (registry) => ({
      ...registry,
      openSession: (...args) =>
        Effect.gen(function* () {
          const session = yield* registry.openSession(...args);
          if (++opening === 1) yield* Effect.promise(() => gate.promise);
          return session;
        }),
    }),
  });
  const results = observe(run);
  const work = run.submit("held acquisition");
  try {
    await until(() => run.fake.opened.length === 1);
    for (let n = 0; n < 3; n++) {
      const other = await run.harness.createConversation(
        {
          ownership: { kind: "ownerless" },
          agent: { model: { provider: "subscription", modelId: "sonnet" } },
        },
        context,
      );
      run.fake.frames.push({ text: "other answer" });
      await (
        await other.submit({ type: "input", content: "other" }, context)
      ).wait(context);
    }
    await Bun.sleep(100);
    expect(run.fake.opened[0]?.session.closed).toBe(0);
    await run.bridge.closeConversation(String(run.conversation.id));
    await until(() =>
      results.some((message) => message.stopReason === "aborted"),
    );
    expect(run.fake.opened[0]?.session.closed).toBe(1);
    expect(run.fake.requests).toHaveLength(3);
    expect(run.fake.unrecordedRequests).toBe(0);
  } finally {
    gate.resolve();
    await work;
    await run.close();
  }
});

for (const shape of ["answer", "tool-use"] as const) {
  for (const end of ["Stop", "write failure"] as const) {
    // R2: an unfinished head cannot outlive the partial pointer that pi recorded.
    test(`${shape} head rolls back and resolves delivery after ${end}, so recovery preserves its unproven input while the old write is held`, async () => {
      const gate = Promise.withResolvers<void>();
      const failed = Promise.withResolvers<void>();
      const directory = await mkdtemp(join(tmpdir(), "chat-runtime-rollback-"));
      const run = await fixture({ headsDirectory: directory });
      const results = observe(run);
      const set = run.heads.set.bind(run.heads);
      let writing = false;
      let observed: ReturnType<typeof run.heads.get>;
      run.heads.set = (session, head) => {
        if (writing || !head.resumePoint) return set(session, head);
        observed = head;
        const write = set(session, head);
        writing = true;
        if (end === "write failure")
          return Promise.race([gate.promise, failed.promise])
            .then(() => write)
            .then(() => {
              throw new Error("disk write failed");
            });
        return gate.promise.then(() => write);
      };
      run.fake.frames.push(
        shape === "answer"
          ? { text: "answer" }
          : { calls: [{ callId: "c1", toolName: "probe", input: { n: 1 } }] },
      );
      const work = run.submit("first");
      try {
        await until(() => writing);
        if (end === "Stop")
          await run.bridge.closeConversation(String(run.conversation.id));
        else failed.resolve();
        await until(
          () =>
            results.length === 1 && run.fake.opened[0]?.session.closed === 1,
        );
        expect(results[0]?.stopReason).toBe(
          end === "Stop" ? "aborted" : "error",
        );
        expect(results[0]?.responseId).toBe("native:session-1:");
        const { pending: _pending, completed: _completed, ...base } = observed!;
        const resolved = {
          ...base,
          forkRequired: true,
          inputs: [
            { kind: "message", through: headDigest(await run.messages()) },
          ],
        } satisfies Parameters<typeof run.heads.set>[1];
        expect(run.heads.get(String(run.conversation.id))).toEqual(resolved);
        await run.heads.close();
        const disk = await NativeHeads.open(directory);
        expect(disk.get(String(run.conversation.id))).toEqual(resolved);
        await disk.close();
        await work;
        run.fake.frames.push({ text: "recovered" });
        expect((await run.submit("next")).status).toBe("done");
        // Ruling 27: Stop or a failed final head write cannot prove the first turn stored.
        expect(run.fake.opened[1]?.start).toEqual({ kind: "new" });
        expect(run.fake.requests.at(-1)?.input).toEqual([
          { type: "text", text: "first" },
          { type: "text", text: "next" },
        ]);
        expect(run.fake.requests).toHaveLength(2);
        expect(run.fake.unrecordedRequests).toBe(0);
      } finally {
        gate.resolve();
        await work;
        await run.close();
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
}

// R3: interruption without call.signal abort must close before the runtime's timeout recovery can send another request.
test("an interrupted handler closes its scope while pi still holds the tool, then re-attaches its result as text", async () => {
  const toolGate = Promise.withResolvers<void>();
  let scope: Scope.Scope | undefined;
  let scopeAtRecovery: string | undefined;
  let recovered = false;
  const run = await fixture({
    registry: (registry) => ({
      ...registry,
      openSession: (name, policy, start) =>
        Effect.gen(function* () {
          scope = yield* Scope.Scope;
          return yield* registry.openSession(
            name,
            {
              ...policy,
              tools: policy.tools.map((tool) => ({
                ...tool,
                handle: (input, call) =>
                  tool.handle(input, call).pipe(
                    Effect.timeout("30 millis"),
                    Effect.catch(() =>
                      Effect.sync(() => {
                        scopeAtRecovery = scope?.state._tag;
                        recovered = true;
                        return {
                          text: "Call stopped.",
                          error: "Call stopped.",
                        };
                      }),
                    ),
                  ),
              })),
            },
            start,
          );
        }),
    }),
    execute: async () => {
      await toolGate.promise;
      return { content: [{ type: "text", text: "slow result" }] };
    },
  });
  const results = observe(run);
  run.fake.frames.push(
    { calls: [{ callId: "slow", toolName: "probe", input: { n: 1 } }] },
    { text: "reattached" },
  );
  const work = run.submit("slow tool");
  try {
    await until(() => recovered);
    expect(results[0]?.stopReason).toBe("toolUse");
    expect(scopeAtRecovery).toBe("Closed");
    expect(run.fake.opened[0]?.session.closed).toBe(1);
    expect(run.fake.requests).toHaveLength(1);
    expect(run.fake.unrecordedRequests).toBe(0);
  } finally {
    toolGate.resolve();
    try {
      expect((await work).status).toBe("done");
      expect(run.executed).toEqual([1]);
      expect(JSON.stringify(run.fake.requests[1]?.input)).toContain(
        "probe already ran. Do not call it again.",
      );
      expect(JSON.stringify(run.fake.requests[1]?.input)).toContain(
        "slow result",
      );
    } finally {
      await run.close();
    }
  }
});

// The invariant must hold at every bridge-driven runtime method and checkpoint await, even if its promise never settles.
test("every lifecycle gate remains reachable by worker close before its runtime or disk promise returns", async () => {
  const stages = [
    "openSession",
    "continuation",
    "setModel",
    "startTurn",
    "steerTurn",
    "handler",
    "initial head",
    "answer head",
    "tool head",
  ] as const;
  for (const stage of stages) {
    const gate = Promise.withResolvers<void>();
    let armed = false;
    let entered = false;
    let scope: Scope.Scope | undefined;
    const hold = () =>
      Effect.promise(async () => {
        entered = true;
        await gate.promise;
      });
    const run = await fixture({
      accounts: [account(), account("alias")],
      registry: (registry) => ({
        ...registry,
        continuation: (name) =>
          (armed && stage === "continuation" ? hold() : Effect.void).pipe(
            Effect.andThen(registry.continuation(name)),
          ),
        openSession: (...args) =>
          Effect.gen(function* () {
            scope = yield* Scope.Scope;
            const session = yield* registry.openSession(...args);
            if (armed && stage === "openSession") yield* hold();
            return {
              ...session,
              get nativeSessionId() {
                return session.nativeSessionId;
              },
              setModel: (model) =>
                (armed && stage === "setModel" ? hold() : Effect.void).pipe(
                  Effect.andThen(session.setModel(model)),
                ),
              startTurn: (input) =>
                (armed && stage === "startTurn" ? hold() : Effect.void).pipe(
                  Effect.andThen(session.startTurn(input)),
                ),
              steerTurn: (input) =>
                (armed && stage === "steerTurn" ? hold() : Effect.void).pipe(
                  Effect.andThen(session.steerTurn(input)),
                ),
            };
          }),
      }),
      execute: async (_n, read) => {
        if (stage === "handler") {
          entered = true;
          await gate.promise;
        }
        if (stage === "steerTurn")
          await read().submit(
            { type: "input", content: "steer", whenBusy: "steer" },
            context,
          );
        return { content: [{ type: "text", text: "ran" }] };
      },
    });
    const results = observe(run);
    const set = run.heads.set.bind(run.heads);
    run.heads.set = (session, head) => {
      const write = set(session, head);
      if (
        armed &&
        !entered &&
        ((stage === "initial head" && !head.resumePoint) ||
          ((stage === "answer head" || stage === "tool head") &&
            head.resumePoint))
      ) {
        entered = true;
        return gate.promise.then(() => write);
      }
      return write;
    };
    let work: ReturnType<typeof run.submit> | undefined;
    try {
      if (stage === "setModel" || stage === "continuation") {
        run.fake.frames.push({ text: "first" });
        await run.submit("first");
        await run.conversation.configure(
          {
            model: {
              provider: stage === "continuation" ? "alias" : "subscription",
              modelId: "real",
            },
          },
          context,
        );
      }
      armed = true;
      const tools =
        stage === "handler" || stage === "steerTurn" || stage === "tool head";
      run.fake.frames.push(
        tools
          ? { calls: [{ callId: "c1", toolName: "probe", input: { n: 1 } }] }
          : { text: "answer" },
      );
      work = run.submit("at gate");
      await until(() => entered);
      const requests = run.fake.requests.length;
      await run.bridge.close();
      await until(
        () =>
          results.length ===
          (stage === "steerTurn" ||
          stage === "setModel" ||
          stage === "continuation"
            ? 2
            : 1),
      );
      expect(results.at(-1)?.stopReason).toBe(
        stage === "handler" ? "toolUse" : "aborted",
      );
      expect(scope?.state._tag).toBe("Closed");
      expect(run.fake.opened.every(({ session }) => session.closed === 1)).toBe(
        true,
      );
      expect(run.fake.requests).toHaveLength(requests);
      expect(run.fake.unrecordedRequests).toBe(0);
      expect(
        run.fake.opened.every(({ session }) => session.interrupted === 0),
      ).toBe(true);
    } finally {
      gate.resolve();
      await work;
      await run.close();
    }
  }
});

// A completed turn with held handlers must retire, so its pi results are replayed rather than discarded.
test("a turn ending before its held tool closes and later replays that tool exactly once", async () => {
  const gate = Promise.withResolvers<void>();
  const run = await fixture({
    execute: async () => {
      await gate.promise;
      return { content: [{ type: "text", text: "held result" }] };
    },
  });
  const results = observe(run);
  run.fake.frames.push(
    { calls: [{ callId: "held", toolName: "probe", input: { n: 1 } }] },
    { text: "resumed" },
  );
  const work = run.submit("begin");
  try {
    await until(() => run.executed.length === 1);
    const source = run.fake.opened[0]!.session;
    source.emit({ type: "turn.finished", outcome: { status: "completed" } });
    await until(() => source.closed === 1);
    expect(results[0]?.stopReason).toBe("toolUse");
    expect(run.fake.requests).toHaveLength(1);
    expect(run.fake.unrecordedRequests).toBe(0);
  } finally {
    gate.resolve();
    try {
      expect((await work).status).toBe("done");
      expect(run.executed).toEqual([1]);
      expect(JSON.stringify(run.fake.requests[1]?.input)).toContain(
        "held result",
      );
      expect(JSON.stringify(run.fake.requests[1]?.input)).toContain(
        "already ran",
      );
    } finally {
      await run.close();
    }
  }
});
