import { expect, test } from "bun:test";
import type {
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { Account, TurnLimit, type RuntimeEvent } from "@neuve/runtime";
import { Deferred, Effect, Exit, Fiber, Layer, Queue, Stream } from "effect";
import { openClaudeSession } from "../src/session.ts";
import { ClaudeSdk } from "../src/services.ts";
import { result, usage } from "./frames.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { TOOL_USE_ID_META } from "../src/tools.ts";

test("R6-F1 steering accepted after a result snapshot stays open for its own result", async () => {
  const account = Account.parse({
    name: "test",
    kind: "claude-subscription",
    runtime: "claude-code",
    credential: { kind: "claude-config-folder" },
  });
  if (account.kind !== "claude-subscription") throw new Error("fixture");
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const frames = yield* Queue.unbounded<SDKMessage>();
        const delivery = yield* Deferred.make<void>();
        const buffered = yield* Deferred.make<void>();
        const sends: SDKUserMessage[] = [];
        const layer = Layer.succeed(ClaudeSdk, {
          prefixes: { usage: [], organization: [] },
          open: () =>
            Effect.gen(function* () {
              const close = Queue.shutdown(frames);
              yield* Effect.addFinalizer(() => close);
              return {
                messages: Stream.fromQueue(frames).pipe(
                  Stream.tap(() =>
                    Deferred.succeed(buffered, undefined).pipe(
                      Effect.andThen(Deferred.await(delivery)),
                    ),
                  ),
                ),
                close,
                offer: (message: SDKUserMessage) =>
                  Effect.sync(() => {
                    sends.push(message);
                  }),
                interrupt: Effect.void,
                setModel: () => Effect.void,
                applyFlagSettings: () => Effect.void,
                initializationResult: Effect.succeed({ account: {} }),
              };
            }),
        });
        const session = yield* openClaudeSession(
          account,
          {
            systemPrompt: "fixture",
            tools: [],
            approvalPolicy: "allow",
            turnLimit: TurnLimit.parse(5),
          },
          { cwd: "/test", executable: "/test/claude", environment: {} },
        ).pipe(Effect.provide(layer));
        const events: RuntimeEvent[] = [];
        const gotUsage = yield* Deferred.make<void>();
        yield* Stream.runForEach(session.events, (e) =>
          Effect.gen(function* () {
            events.push(e);
            if (e.type === "usage")
              yield* Deferred.succeed(gotUsage, undefined);
          }),
        ).pipe(Effect.forkScoped);
        yield* session.startTurn({ turnId: "one", message: "fixture" });
        // The producer made this snapshot before the second send; transport delivery is delayed.
        yield* Queue.offer(
          frames,
          result({
            user_message_uuid: sends[0]!.uuid!,
            user_message_uuids: [sends[0]!.uuid!],
            queued_turn_count: 0,
            modelUsage: { m: usage(10) },
          }),
        );
        yield* Deferred.await(buffered);
        yield* session.steerTurn({ turnId: "one", message: "fixture" });
        yield* Deferred.succeed(delivery, undefined);
        yield* Deferred.await(gotUsage);
        yield* Effect.sleep("10 millis");
        expect(sends).toHaveLength(2);
        expect(events.filter((e) => e.type === "turn.finished")).toHaveLength(
          0,
        );
        yield* Queue.offer(
          frames,
          result({
            user_message_uuid: sends[1]!.uuid!,
            user_message_uuids: [sends[1]!.uuid!],
            queued_turn_count: 0,
            modelUsage: { m: usage(15) },
          }),
        );
      }),
    ).pipe(Effect.timeout("2 seconds")),
  );
});

test("R6-F3 malformed conversation reset fails rather than changing continuation", async () => {
  const account = Account.parse({
    name: "test",
    kind: "claude-subscription",
    runtime: "claude-code",
    credential: { kind: "claude-config-folder" },
  });
  if (account.kind !== "claude-subscription") throw new Error("fixture");
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const frames = yield* Queue.unbounded<SDKMessage>();
        const layer = Layer.succeed(ClaudeSdk, {
          prefixes: { usage: [], organization: [] },
          open: () =>
            Effect.gen(function* () {
              const close = Queue.shutdown(frames);
              yield* Effect.addFinalizer(() => close);
              return {
                messages: Stream.fromQueue(frames),
                close,
                offer: () => Effect.void,
                interrupt: Effect.void,
                setModel: () => Effect.void,
                applyFlagSettings: () => Effect.void,
                initializationResult: Effect.succeed({ account: {} }),
              };
            }),
        });
        const session = yield* openClaudeSession(
          account,
          {
            systemPrompt: "fixture",
            tools: [],
            approvalPolicy: "allow",
            turnLimit: TurnLimit.parse(5),
          },
          { cwd: "/test", executable: "/test/claude", environment: {} },
        ).pipe(Effect.provide(layer));
        yield* session.startTurn({ turnId: "one", message: "fixture" });
        const malformed = {
          type: "conversation_reset",
          session_id: "fixture",
          uuid: crypto.randomUUID(),
        } as SDKMessage;
        yield* Queue.offer(frames, malformed);
        yield* Queue.offer(frames, result());
        const events = yield* Stream.runCollect(
          session.events.pipe(
            Stream.takeUntil((e) => e.type === "turn.finished"),
          ),
        );
        const finished = events.find((e) => e.type === "turn.finished");
        const continuation = yield* session.continuation;
        expect({
          outcome: finished?.outcome.status,
          hasSessionId: typeof continuation.sessionId === "string",
        }).toEqual({ outcome: "failed", hasSessionId: true });
      }),
    ).pipe(Effect.timeout("2 seconds")),
  );
});

test("R6-F4 stalled tool finalizer cannot prevent child shutdown on Stop", async () => {
  const account = Account.parse({
    name: "test",
    kind: "claude-subscription",
    runtime: "claude-code",
    credential: { kind: "claude-config-folder" },
  });
  if (account.kind !== "claude-subscription") throw new Error("fixture");
  const release = Promise.withResolvers<void>();
  const finalizing = Promise.withResolvers<void>();
  const watchdog = setTimeout(() => release.resolve(), 1500);
  let childClosed = false;
  let observedClosed = false;
  const client = new Client({ name: "fixture", version: "1" });
  let call: Promise<unknown> | undefined;
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>();
          const layer = Layer.succeed(ClaudeSdk, {
            prefixes: { usage: [], organization: [] },
            open: (options) =>
              Effect.gen(function* () {
                const frames = yield* Queue.unbounded<SDKMessage>();
                const close = Effect.sync(() => {
                  childClosed = true;
                }).pipe(Effect.andThen(Queue.shutdown(frames)));
                yield* Effect.addFinalizer(() => close);
                const server = options.mcpServers?.neuve;
                if (server?.type !== "sdk") throw new Error("fixture");
                const [a, b] = InMemoryTransport.createLinkedPair();
                yield* Effect.promise(() =>
                  Promise.all([client.connect(a), server.instance.connect(b)]),
                );
                return {
                  messages: Stream.fromQueue(frames),
                  close,
                  offer: () => Effect.void,
                  interrupt: Effect.void,
                  setModel: () => Effect.void,
                  applyFlagSettings: () => Effect.void,
                  initializationResult: Effect.succeed({ account: {} }),
                };
              }),
          });
          const session = yield* openClaudeSession(
            account,
            {
              systemPrompt: "fixture",
              approvalPolicy: "allow",
              turnLimit: TurnLimit.parse(5),
              tools: [
                {
                  name: "wait",
                  description: "fixture",
                  inputSchema: { type: "object" },
                  hints: {
                    readOnly: true,
                    destructive: false,
                    idempotent: true,
                    openWorld: false,
                  },
                  handle: () =>
                    Deferred.succeed(started, undefined).pipe(
                      Effect.andThen(Effect.never),
                      Effect.ensuring(
                        Effect.promise(() => {
                          finalizing.resolve();
                          return release.promise;
                        }),
                      ),
                    ),
                },
              ],
            },
            {
              cwd: "/test",
              executable: "/test/claude",
              environment: {},
              interruptTimeoutMs: 30,
            },
          ).pipe(Effect.provide(layer));
          yield* Stream.runForEach(session.events, (e) =>
            e.type === "tool.started"
              ? Deferred.succeed(started, undefined)
              : Effect.void,
          ).pipe(Effect.forkScoped);
          yield* session.startTurn({ turnId: "one", message: "fixture" });
          call = client
            .callTool({
              name: "wait",
              arguments: {},
              _meta: { [TOOL_USE_ID_META]: "tool-1" },
            })
            .catch(() => undefined);
          yield* Deferred.await(started);
          const stop = yield* session
            .interruptTurn({ turnId: "one", reason: "stop" })
            .pipe(Effect.forkScoped);
          yield* Effect.promise(() => finalizing.promise);
          yield* Effect.sleep("100 millis");
          observedClosed = childClosed;
          release.resolve();
          yield* Effect.promise(() => call!);
          yield* Effect.promise(() => client.close());
          yield* Fiber.join(stop);
        }),
      ).pipe(Effect.timeout("2 seconds")),
    );
    expect(observedClosed).toBe(true);
  } finally {
    release.resolve();
    clearTimeout(watchdog);
    await client.close();
    await call;
  }
});

test("R6-F2 Stop interrupts a started final turn during query initialization", async () => {
  const account = Account.parse({
    name: "test",
    kind: "claude-subscription",
    runtime: "claude-code",
    credential: { kind: "claude-config-folder" },
  });
  if (account.kind !== "claude-subscription") throw new Error("fixture");
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const opening = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let opens = 0;
        const layer = Layer.succeed(ClaudeSdk, {
          prefixes: { usage: [], organization: [] },
          open: () =>
            Effect.gen(function* () {
              const second = ++opens === 2;
              const frames = yield* Queue.unbounded<SDKMessage>();
              const close = Queue.shutdown(frames);
              yield* Effect.addFinalizer(() => close);
              return {
                messages: Stream.fromQueue(frames),
                close,
                offer: () => Queue.offer(frames, result()).pipe(Effect.asVoid),
                interrupt: Effect.void,
                setModel: () => Effect.void,
                applyFlagSettings: () => Effect.void,
                initializationResult: second
                  ? Deferred.succeed(opening, undefined).pipe(
                      Effect.andThen(Deferred.await(release)),
                      Effect.as({ account: {} }),
                    )
                  : Effect.succeed({ account: {} }),
              };
            }),
        });
        const session = yield* openClaudeSession(
          account,
          {
            systemPrompt: "fixture",
            tools: [],
            approvalPolicy: "allow",
            turnLimit: TurnLimit.parse(5),
            outputSchema: { type: "object" },
          },
          { cwd: "/test", executable: "/test/claude", environment: {} },
        ).pipe(Effect.provide(layer));
        yield* session.startTurn({ turnId: "normal", message: "fixture" });
        yield* Stream.runDrain(
          session.events.pipe(
            Stream.takeUntil((e) => e.type === "turn.finished"),
          ),
        );
        yield* session
          .startTurn({ turnId: "final", message: "fixture", final: true })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(opening);
        const stopped = yield* session
          .interruptTurn({ turnId: "final", reason: "stop" })
          .pipe(Effect.exit);
        expect(Exit.isSuccess(stopped)).toBe(true);
        yield* Deferred.succeed(release, undefined);
      }),
    ).pipe(Effect.timeout("2 seconds")),
  );
});
