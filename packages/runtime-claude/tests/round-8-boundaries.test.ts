import { expect, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Account, TurnLimit, type RuntimeEvent } from "@neuve/runtime";
import { Deferred, Effect, Fiber, Layer, Queue, Stream } from "effect";
import { openClaudeSession } from "../src/session.ts";
import { ClaudeSdk } from "../src/services.ts";
import { TOOL_USE_ID_META } from "../src/tools.ts";

const account = Account.parse({
  name: "test",
  kind: "claude-subscription",
  runtime: "claude-code",
  credential: { kind: "claude-config-folder" },
});
if (account.kind !== "claude-subscription") throw new Error("fixture");
const policy = {
  systemPrompt: "fixture",
  tools: [],
  approvalPolicy: "allow" as const,
  turnLimit: TurnLimit.parse(5),
};
const config = {
  cwd: "/test",
  executable: "/test/claude",
  environment: {},
  interruptTimeoutMs: 30,
};

// Reason: invalid reset identities must fail at ingress without mutating identity or usage.
for (const id of [undefined, null, 1, ""]) {
  test(`R6-F3 reset identity rejects ${JSON.stringify(id)}`, () =>
    Effect.runPromise(
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
          const session = yield* openClaudeSession(account, policy, {
            ...config,
            usageBaseline: new Map([
              [
                "m",
                {
                  input: 10,
                  output: 2,
                  cacheRead: 3,
                  cacheWrite5m: 4,
                  cacheWrite1h: 0,
                },
              ],
            ]),
          }).pipe(Effect.provide(layer));
          const before = yield* session.continuation;
          yield* session.startTurn({ turnId: "one", message: "fixture" });
          // Deliberately malformed IPC at the validation boundary.
          yield* Queue.offer(frames, {
            type: "conversation_reset",
            new_conversation_id: id,
          } as SDKMessage);
          const events = yield* Stream.runCollect(session.events);
          expect(
            events.filter((e) => e.type === "turn.finished"),
          ).toMatchObject([
            {
              outcome: {
                status: "failed",
                disposition: "broken",
                failure: { reason: "protocol-error" },
              },
            },
          ]);
          expect(yield* session.continuation).toEqual(before);
        }),
      ).pipe(Effect.timeout("2 seconds")),
    ));
}

// Reason: a stalled tool finalizer must not delay child close, Stop's return or turn.finished past one shared deadline.
test("R6-F4 Stop returns and finishes before a gated tool finalizer releases", async () => {
  const release = Promise.withResolvers<void>();
  const finalizing = Promise.withResolvers<void>();
  const client = new Client({ name: "fixture", version: "1" });
  let call: Promise<unknown> | undefined;
  let childClosed = false;
  const watchdog = setTimeout(() => release.resolve(), 1500);
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
              ...policy,
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
            config,
          ).pipe(Effect.provide(layer));
          const events: RuntimeEvent[] = [];
          const consumer = yield* Stream.runForEach(session.events, (event) =>
            Effect.gen(function* () {
              events.push(event);
              if (event.type === "tool.started")
                yield* Deferred.succeed(started, undefined);
            }),
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
          const began = performance.now();
          const stop = yield* session
            .interruptTurn({ turnId: "one", reason: "stop" })
            .pipe(Effect.forkScoped);
          yield* Effect.promise(() => finalizing.promise);
          expect(
            (yield* Fiber.await(stop).pipe(Effect.timeoutOption(150)))._tag,
          ).toBe("Some");
          expect(childClosed).toBe(true);
          expect(performance.now() - began).toBeLessThan(150);
          yield* Fiber.join(consumer).pipe(Effect.timeout(50));
          expect(
            events.filter((e) => e.type === "turn.finished"),
          ).toMatchObject([
            { outcome: { status: "interrupted", reason: "stop" } },
          ]);
          expect(
            yield* session
              .startTurn({ turnId: "two", message: "fixture" })
              .pipe(Effect.flip),
          ).toMatchObject({ reason: "session-stopped" });
          const count = events.length;
          release.resolve();
          yield* Effect.promise(() => call!);
          expect(events).toHaveLength(count);
        }).pipe(Effect.ensuring(Effect.sync(() => release.resolve()))),
      ).pipe(Effect.timeout("2 seconds")),
    );
  } finally {
    release.resolve();
    clearTimeout(watchdog);
    await client.close();
    await call;
  }
});
