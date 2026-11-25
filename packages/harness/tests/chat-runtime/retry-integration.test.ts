// Why: live model retries must wait on Records jobs and preserve tool effects across restart.
import { readFileSync } from "node:fs";
import { watchTurnRecovery } from "../../../channel/src/turn-recovery";
import { hostBudget } from "../../src/budget/local.ts";
import { sharedWorkSocket } from "@neuve/records-core/shared-work-socket";
import type { ClaimEvent } from "@neuve/records-core/shared-work";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Blobs,
  Computations,
  JobQueue,
  Store,
  TurnRecovery,
  Worker,
  storeLocationIn,
} from "@neuve/records-core";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Layer, ManagedRuntime, Option } from "effect";
import {
  ChatRuntimeBridge,
  NativeHeads,
} from "../../src/chat-runtime/index.ts";
import { turnRecoveryStore } from "../../src/chat-runtime/recovery-store.ts";
import { continueSavedTurn } from "../../src/chat-runtime/retry.ts";
import { fixture, until, caps, account, type Frame } from "./fixture.ts";

const failed = (
  kind: "protocol" | "transient-provider" = "transient-provider",
  continuation: "resume" | "repeat-request" = "repeat-request",
): Frame => ({
  failure: {
    _tag: "TurnFailed",
    account: "subscription" as never,
    reason: kind === "protocol" ? "protocol-error" : "provider-failed",
  },
  disposition: "reusable",
  retry: { kind, continuation },
  ...(continuation === "resume" ? { resumePoint: "saved-result-carrier" } : {}),
});
async function setup(now = () => Date.now() - 120_000) {
  const directory = await mkdtemp(join(tmpdir(), "neuve-turn-retry-"));
  const logs: { event: string; fields: Readonly<Record<string, unknown>> }[] =
    [];
  const log = (event: string, fields: Readonly<Record<string, unknown>>) => {
    logs.push({ event, fields });
  };
  const location = storeLocationIn(directory);
  const transport = sharedWorkSocket({ directory: join(directory, "budget") });
  const driverOptions = {
    log,
    transport,
    namespace: "channel",
    wake: async () => {},
  };
  const budget = await hostBudget({
    directory: join(directory, "budget"),
    threads: 2,
    fixed: 4,
  }).catch(async (error: unknown) => {
    await rm(directory, { recursive: true, force: true });
    throw error;
  });
  if (!budget) throw new Error("Shared-work test host did not start");
  const host = budget;
  await host.claims.ready;
  const store = await turnRecoveryStore(location, driverOptions);
  const sql = Store.layer(location, { create: false });
  const blobs = Blobs.layer(location).pipe(
    Layer.provide(sql),
    Layer.provide(BunFileSystem.layer),
  );
  const computations = Computations.layer.pipe(
    Layer.provide(sql),
    Layer.provide(blobs),
  );
  const queues = JobQueue.layer.pipe(Layer.provide(sql));
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(sql, blobs, computations, queues, BunFileSystem.layer).pipe(
      Layer.provide(BunFileSystem.layer),
    ),
  );
  const stop = new AbortController();
  const ready = Promise.withResolvers<void>();
  const worker = runtime.runPromise(
    Effect.scoped(
      Worker.run({
        location,
        handlers: {
          "chat.turn-retry@1": Worker.defaultHandlers["chat.turn-retry@1"]!,
        },
        openSessions: Effect.succeed(1),
        afterRecovery: Effect.sync(() => ready.resolve()),
      }),
    ),
    { signal: stop.signal },
  );
  void worker.then(
    (exit) => ready.reject(new Error(`Records worker ended: ${exit.reason}`)),
    ready.reject,
  );
  let run: Awaited<ReturnType<typeof fixture>> | undefined;
  async function cleanup() {
    await run?.close();
    stop.abort();
    await worker.catch(() => {});
    await runtime.dispose();
    await store.close();
    await host.close();
    await rm(directory, { recursive: true, force: true });
  }
  try {
    await ready.promise;
    let registry: import("@neuve/runtime").RuntimeRegistryShape | undefined;
    run = await fixture({
      recovery: store.driver,
      now,
      registry: (value) => (registry = value),
    });
    return {
      ...run,
      logs,
      driver: store.driver,
      store,
      driverOptions,
      directory,
      location,
      registry: registry!,
      cleanup,
      delivery: (event: string) =>
        runtime.runPromise(TurnRecovery.delivery(event)),
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

test("a delivered retry replaces provisional output and settles the same generation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "neuve-retry-delivery-"));
  const location = storeLocationIn(directory);
  const closed = Promise.withResolvers<ClaimEvent>();
  const published = Promise.withResolvers<void>();
  const deliver = JobQueue.JobQueue.use((queue) =>
    Effect.gen(function* () {
      const job = Option.getOrThrow(yield* queue.take(["chat.turn-retry@1"]));
      yield* queue.complete(job.seq, job.attempts);
    }),
  ).pipe(
    Effect.provide(JobQueue.layer),
    Effect.provide(Store.layer(location, { create: false })),
    Effect.provide(BunFileSystem.layer),
  );
  const store = await turnRecoveryStore(location, {
    namespace: "channel",
    wake: () => Effect.runPromise(deliver),
    transport: {
      async claim() {
        let first = true;
        const close = () => closed.resolve({ kind: "lost" });
        return {
          kind: "connected",
          claim: {
            async next() {
              if (!first) return closed.promise;
              first = false;
              return {
                kind: "claimed",
                takeover: false,
                waiters: 0,
                declaring: false,
              };
            },
            withdraw: close,
            close,
            async settle() {
              published.resolve();
            },
          },
        };
      },
    },
  });
  let run: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    run = await fixture({
      recovery: store.driver,
      now: () => Date.now() - 120_000,
    });
    run.fake.frames.push(
      { ...failed(), text: "incomplete attempt" },
      { text: "recovered" },
    );
    expect((await run.submit("do the work")).status).toBe("done");
    expect((await run.messages()).at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "recovered" }],
    });
    expect(run.fake.opened).toHaveLength(2);
    expect(run.fake.requests[1]?.input).toEqual(run.fake.requests[0]?.input);
    expect(
      (await store.driver.latest(String(run.conversation.id)))?.value,
    ).toMatchObject({
      state: "recovered",
      attempt: 1,
    });
    await published.promise;
  } finally {
    await run?.close();
    closed.resolve({ kind: "lost" });
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);

test("reusable protocol failure resumes exact saved history; a reproduced completed tool runs once", async () => {
  const run = await setup();
  try {
    const calls = [{ callId: "effect", toolName: "probe", input: { n: 1 } }];
    run.fake.frames.push(
      { calls },
      failed("protocol", "resume"),
      { calls },
      { text: "finished" },
    );
    expect((await run.submit("perform one effect")).status).toBe("done");
    expect(run.executed).toEqual([1]);
    expect(run.fake.opened[1]?.start).toEqual({
      kind: "resume",
      session: "session-1",
      at: "saved-result-carrier",
      fork: false,
    });
    expect(
      run.fake.requests.find((row) => row.session === "session-2")?.input,
    ).toBe(continueSavedTurn);
    expect(
      run.fake.logs.some(
        (row) => row.event === "chat-runtime.retry.tool-replayed",
      ),
    ).toBe(true);
  } finally {
    await run.cleanup();
  }
}, 20_000);

test("six failed requests exhaust five durable retries, never a seventh model request", async () => {
  const run = await setup();
  try {
    run.fake.frames.push(...Array.from({ length: 6 }, () => failed()));
    await run.submit("retry budget");
    expect(run.fake.opened).toHaveLength(6);
    expect(
      run.logs.find((row) => row.event === "chat-runtime.retry.terminal")
        ?.fields.reason,
    ).toBe("retry-budget-exhausted");
  } finally {
    await run.cleanup();
  }
}, 20_000);

for (const failure of [
  {
    _tag: "SignInRequired",
    account: "subscription",
    hint: { kind: "settings", entry: "accounts" },
  },
  { _tag: "UsageLimitReached", account: "subscription" },
  { _tag: "AccountRejected", account: "subscription" },
  { _tag: "TurnFailed", account: "subscription", reason: "provider-failed" },
])
  test(`terminal ${failure._tag} has no harness retry`, async () => {
    const run = await setup();
    try {
      run.fake.frames.push({
        failure: failure as NonNullable<Frame["failure"]>,
      });
      await run.submit("request");
      expect(run.fake.opened).toHaveLength(1);
      expect(
        run.logs.some((row) => row.event === "chat-runtime.retry.scheduled"),
      ).toBe(false);
    } finally {
      await run.cleanup();
    }
  }, 20_000);

test("channel worker restart during backoff reloads the same generation request, attempt and chosen time", async () => {
  const run = await setup(Date.now);
  let restarted: Awaited<ReturnType<typeof turnRecoveryStore>> | undefined;
  let bridge: ChatRuntimeBridge | undefined;
  try {
    const messages = [
      {
        role: "user" as const,
        content: "exact durable original request",
        timestamp: 0,
      },
    ];
    const model = run.models.getModel("subscription", "sonnet")!;
    const route = {
      name: account().name,
      continuation: { runtime: "claude-code" as const, key: "/shared" },
      capabilities: caps,
    };
    run.bridge.identify(messages, run.conversation.id, "persisted-generation");
    run.fake.frames.push(failed());
    const first = run.bridge.stream(route, model, { messages }).result();
    await until(() =>
      run.logs.some((row) => row.event === "chat-runtime.retry.scheduled"),
    );
    const scheduled = run.logs.find(
      (row) => row.event === "chat-runtime.retry.scheduled",
    )!.fields;
    const body = await run.driver.loadRequest(scheduled.checkpoint as string);
    expect(body).toEqual([
      { type: "text", text: "exact durable original request" },
    ]);
    await run.bridge.close();
    await first;
    await run.store.close();
    restarted = await turnRecoveryStore(run.location, run.driverOptions);
    bridge = new ChatRuntimeBridge({
      registry: run.registry,
      heads: await NativeHeads.open(),
      recovery: restarted.driver,
    });
    bridge.identify(
      messages,
      run.conversation.id,
      "persisted-generation",
      true,
    );
    run.fake.frames.push({ text: "recovered after restart" });
    expect(
      (await bridge.stream(route, model, { messages }).result()).stopReason,
    ).toBe("stop");
    expect(run.fake.requests[1]?.input).toEqual(body);
    expect(
      run.logs.filter((row) => row.event === "chat-runtime.retry.scheduled"),
    ).toHaveLength(1);
    expect(
      run.logs.find((row) => row.event === "chat-runtime.retry.started")?.fields
        .attempt,
    ).toBe(1);
    expect(scheduled.nextAt).toBeDefined();
  } finally {
    await bridge?.close();
    await restarted?.close();
    await run.cleanup();
  }
}, 20_000);

test("a durable side-effect result survives worker restart and a provider's reproduced call is answered, not run", async () => {
  const run = await setup(Date.now);
  let restarted: Awaited<ReturnType<typeof turnRecoveryStore>> | undefined;
  let bridge: ChatRuntimeBridge | undefined;
  try {
    const calls = [
      { callId: "durable-effect", toolName: "probe", input: { n: 7 } },
    ];
    run.fake.frames.push({ calls }, { text: "effect recorded" });
    await run.submit("perform the effect");
    expect(run.executed).toEqual([7]);
    // These are the pi-published messages/result, not the old bridge's in-memory call set.
    const messages = JSON.parse(
      JSON.stringify(await run.messages()),
    ) as import("@earendil-works/pi-ai").Message[];
    messages.push({
      role: "user",
      content: "finish from the recorded work",
      timestamp: Date.now(),
    });
    const model = run.models.getModel("subscription", "sonnet")!;
    const route = {
      name: account().name,
      continuation: { runtime: "claude-code" as const, key: "/shared" },
      capabilities: caps,
    };
    run.bridge.identify(
      messages,
      run.conversation.id,
      "effect-recovery-generation",
    );
    run.fake.frames.push(failed("protocol", "resume"));
    const pending = run.bridge.stream(route, model, { messages }).result();
    await until(() =>
      run.logs.some((row) => row.event === "chat-runtime.retry.scheduled"),
    );
    await run.bridge.close();
    await pending;
    await run.store.close();
    restarted = await turnRecoveryStore(run.location, run.driverOptions);
    bridge = new ChatRuntimeBridge({
      registry: run.registry,
      heads: await NativeHeads.open(),
      recovery: restarted.driver,
    });
    bridge.identify(
      messages,
      run.conversation.id,
      "effect-recovery-generation",
      true,
    );
    run.fake.frames.push(
      { calls },
      { text: "recovered without repeating the effect" },
    );
    expect(
      (await bridge.stream(route, model, { messages }).result()).stopReason,
    ).toBe("stop");
    expect(run.executed).toEqual([7]);
    expect(
      run.fake.results.filter((row) => row.id === "durable-effect"),
    ).toHaveLength(2);
    expect(run.fake.results.at(-1)?.outcome.text).toBe("result-7");
    expect(run.fake.opened.at(-1)?.start).toMatchObject({
      kind: "resume",
      at: "saved-result-carrier",
    });
  } finally {
    await bridge?.close();
    await restarted?.close();
    await run.cleanup();
  }
}, 20_000);

test("Stop cancels a pending retry durably; its later queue delivery cannot start the provider", async () => {
  const run = await setup(Date.now);
  try {
    run.fake.frames.push(failed());
    const work = run.submit("stopped work");
    await until(() =>
      run.logs.some((row) => row.event === "chat-runtime.retry.scheduled"),
    );
    await run.stopApprovals();
    await run.bridge.closeConversation(
      String(run.conversation.id),
      false,
      true,
    );
    await work;
    const event = run.logs.find(
      (row) => row.event === "chat-runtime.retry.scheduled",
    )!.fields.event as string;
    await Bun.sleep(3_000);
    expect((await run.delivery(event))?.state).toBe("completed");
    expect(run.fake.opened).toHaveLength(1);
    expect(
      run.logs.some((row) => row.event === "chat-runtime.retry.started"),
    ).toBe(false);
  } finally {
    await run.cleanup();
  }
}, 20_000);

test("a potentially executed tool without a durable result ends visibly instead of retrying", async () => {
  const directory = await mkdtemp(join(tmpdir(), "neuve-ambiguous-retry-"));
  const logs: { event: string; fields: Readonly<Record<string, unknown>> }[] =
    [];
  const store = await turnRecoveryStore(storeLocationIn(directory), {
    namespace: "channel",
    wake: async () => {},
    log: (event, fields) => logs.push({ event, fields }),
  });
  const gate =
    Promise.withResolvers<
      import("@earendil-works/pi-durable").ToolExecutionResult
    >();
  const run = await fixture({
    recovery: store.driver,
    execute: () => gate.promise,
  });
  let work: ReturnType<typeof run.submit> | undefined;
  try {
    run.fake.frames.push({
      calls: [
        { callId: "uncertain-effect", toolName: "probe", input: { n: 9 } },
      ],
      finishAfterResults: "late-carrier",
    });
    work = run.submit("effect with no durable result yet");
    await until(() => run.executed.length === 1);
    run.fake.opened[0]!.session.emit({
      type: "turn.finished",
      resumePoint: "claimed-but-unproven-carrier",
      outcome: {
        status: "failed",
        disposition: "reusable",
        failure: {
          _tag: "TurnFailed",
          account: account().name,
          reason: "protocol-error",
        },
        retry: { kind: "protocol", continuation: "resume" },
      },
    });
    await until(() =>
      logs.some((row) => row.event === "chat-runtime.retry.terminal"),
    );
    expect(
      logs.find((row) => row.event === "chat-runtime.retry.terminal")?.fields
        .reason,
    ).toBe("ambiguous-tool-effect");
    expect(
      logs.some((row) => row.event === "chat-runtime.retry.scheduled"),
    ).toBe(false);
    expect(run.fake.opened).toHaveLength(1);
    expect(run.executed).toEqual([9]);
  } finally {
    gate.resolve({ content: [{ type: "text", text: "late result" }] });
    await work;
    await run.close();
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);

async function sharedSchedule(run: Awaited<ReturnType<typeof setup>>) {
  const checkpoint = {
    id: await run.driver.saveRequest("durable shared request"),
    generation: "shared-generation",
    account: "subscription",
    session: "shared-session",
    continuation: "shared-continuation",
    transcriptDigest: "a".repeat(64),
    resultsDigest: "b".repeat(64),
    continuationMode: "repeat-request" as const,
  };
  const initial = await run.driver.begin({
    turn: "shared-turn",
    chat: String(run.conversation.id),
    checkpoint,
  });
  return run.driver.schedule({
    turn: initial.value.turn,
    expected: initial.event,
    checkpoint,
    reason: "temporary-provider-failure",
    nextAt: "2000-01-01T00:00:00.000Z",
  });
}

test("two drivers join one actual attempt; second opener is ready and attaches to live state without ending it", async () => {
  const run = await setup();
  const second = await turnRecoveryStore(run.location, run.driverOptions);
  const gate = Promise.withResolvers<void>();
  let effects = 0;
  try {
    const schedule = await sharedSchedule(run);
    const first = run.driver.execute(
      schedule,
      new AbortController().signal,
      async (signal) => {
        const started = await run.driver.wait(schedule, signal);
        effects++;
        await gate.promise;
        return {
          state: await run.driver.settle({
            turn: "shared-turn",
            expected: started.event,
            state: "recovered",
          }),
        };
      },
    );
    await until(() => effects === 1);
    const active = await second.driver.find(
      String(run.conversation.id),
      "shared-generation",
    );
    expect(active?.value.state).toBe("started");
    const joined = second.driver.execute(
      active!,
      new AbortController().signal,
      async () => {
        throw new Error("Duplicate native attempt");
      },
    );
    await until(() =>
      run.logs.some(
        (row) =>
          row.event === "chat-runtime.retry.shared-work" &&
          row.fields.role === "waiter",
      ),
    );
    gate.resolve();
    expect(await joined).toEqual(await first);
    expect(effects).toBe(1);
  } finally {
    gate.resolve();
    await second.close();
    await run.cleanup();
  }
}, 20_000);

test("an unavailable shared host cannot duplicate or terminalize another holder's live side effect", async () => {
  const run = await setup();
  const second = await turnRecoveryStore(run.location, {
    ...run.driverOptions,
    transport: sharedWorkSocket({
      directory: join(run.directory, "absent-host"),
    }),
  });
  const gate = Promise.withResolvers<void>();
  let effects = 0;
  try {
    const schedule = await sharedSchedule(run);
    const first = run.driver.execute(
      schedule,
      new AbortController().signal,
      async (signal) => {
        const started = await run.driver.wait(schedule, signal);
        effects++;
        await gate.promise;
        return {
          state: await run.driver.settle({
            turn: "shared-turn",
            expected: started.event,
            state: "recovered",
          }),
        };
      },
    );
    await until(() => effects === 1);
    await expect(
      second.driver.execute(
        schedule,
        new AbortController().signal,
        async () => {
          effects++;
          throw new Error("Unsafe duplicate");
        },
      ),
    ).rejects.toThrow("ownership");
    expect(
      (await run.driver.latest(String(run.conversation.id)))?.value.state,
    ).toBe("started");
    gate.resolve();
    await first;
    expect(effects).toBe(1);
  } finally {
    gate.resolve();
    await second.close();
    await run.cleanup();
  }
}, 20_000);

for (const dies of [false, true])
  test(`cross-process subscribers share actual attempt/publication; holder death=${dies}`, async () => {
    const run = await setup();
    const children: Bun.Subprocess<"pipe", "pipe", "pipe">[] = [];
    const spawn = () => {
      const events: Record<string, unknown>[] = [];
      const child = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          join(import.meta.dir, "../fixtures/turn-recovery-process.ts"),
        ],
        {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...process.env,
            NEUVE_RETRY_CHAT: String(run.conversation.id),
            NEUVE_RETRY_STORE: run.directory,
            NEUVE_RETRY_HOST: join(run.directory, "budget"),
          },
        },
      );
      children.push(child);
      const output = (async () => {
        const reader = child.stdout
          .pipeThrough(new TextDecoderStream())
          .getReader();
        let buffer = "";
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          buffer += next.value;
          let at: number;
          while ((at = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, at);
            buffer = buffer.slice(at + 1);
            if (line.startsWith("{")) events.push(JSON.parse(line));
          }
        }
      })();
      return { child, events, output };
    };
    try {
      await sharedSchedule(run);
      const holder = spawn();
      await until(() =>
        holder.events.some((event) => event.event === "native-effect"),
      );
      const waiter = spawn();
      await until(() => waiter.events.some((event) => event.role === "waiter"));
      if (dies) {
        holder.child.kill("SIGKILL");
        await holder.child.exited;
      } else {
        holder.child.stdin.write("release\n");
        holder.child.stdin.flush();
      }
      await waiter.child.exited;
      await waiter.output;
      if (!dies) {
        await holder.child.exited;
        await holder.output;
      }
      const result = waiter.events.find((event) => event.event === "result");
      expect(result?.state).toBe(dies ? "terminal" : "recovered");
      if (dies) expect(result?.reason).toBe("unsafe-continuation");
      expect(readFileSync(join(run.directory, "effects"), "utf8")).toBe(
        "effect\n",
      );
    } finally {
      for (const child of children) {
        try {
          child.kill("SIGKILL");
        } catch {}
        await child.exited;
      }
      await run.cleanup();
    }
  }, 30_000);

test("conversation reconnect reconstructs the durable attempt/time and advances through recovery without provider history", async () => {
  const run = await setup(Date.now);
  let first: Awaited<ReturnType<typeof watchTurnRecovery>> | undefined;
  let second: typeof first;
  try {
    run.fake.frames.push(failed(), { text: "recovered" });
    const work = run.submit("private original request");
    await until(() =>
      run.logs.some((row) => row.event === "chat-runtime.retry.scheduled"),
    );
    const sent: import("../../../channel/src/protocol").Event[] = [];
    first = await watchTurnRecovery(run.harness, run.conversation.id, (event) =>
      sent.push(event),
    );
    const waiting = sent.find((event) => event.kind === "turn-retry-status");
    expect(waiting).toEqual({
      kind: "turn-retry-status",
      chat: run.conversation.id,
      status: {
        turn: expect.any(String),
        state: "scheduled",
        attempt: 1,
        reason: "temporary-provider-failure",
        nextAt: expect.any(String),
      },
    });
    await first.stop();
    first = undefined;
    const reconnected: typeof sent = [];
    second = await watchTurnRecovery(
      run.harness,
      run.conversation.id,
      (event) => reconnected.push(event),
    );
    expect(reconnected[0]).toEqual(waiting);
    expect(JSON.stringify(waiting)).not.toContain("private original request");
    expect(JSON.stringify(waiting)).not.toContain("session-1");
    await work;
    await until(() =>
      reconnected.some(
        (event) =>
          event.kind === "turn-retry-status" &&
          event.status?.state === "recovered",
      ),
    );
    expect(
      reconnected.some(
        (event) =>
          event.kind === "turn-retry-status" &&
          event.status?.state === "started",
      ),
    ).toBe(true);
  } finally {
    await first?.stop();
    await second?.stop();
    await run.cleanup();
  }
}, 20_000);
