import { expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { NativeHeads } from "../../src/chat-runtime/heads.ts";
import { Effect, Layer, Queue, Stream } from "effect";
import { fixture, until } from "./fixture.ts";
import { makeRuntime } from "../../../runtime-claude/src/runtime.ts";
import {
  ClaudeSdk,
  ClaudeExecutable,
  ClaudeProcess,
  type QuerySession,
} from "../../../runtime-claude/src/services.ts";

// The production adapter's offer acknowledges its queue, not receipt by the native child.
test("Stop after startTurn accepts queued input must not silently lose the committed input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-runtime-queued-"));
  type Input = Parameters<QuerySession["offer"]>[0];
  type Frame = Stream.Success<QuerySession["messages"]>;
  const offers: Input[] = [];
  const children: { pending: Input[]; closed: boolean }[] = [];
  const actual = await Effect.runPromise(
    makeRuntime({ cwd: "/fake", environment: {} }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(ClaudeExecutable, {
            resolve: () => Effect.succeed("/fake/claude"),
          }),
          Layer.succeed(ClaudeProcess, {
            run: () => Effect.die("No process allowed"),
          }),
          Layer.succeed(ClaudeSdk, {
            prefixes: { usage: [], organization: [] },
            open: () =>
              Effect.gen(function* () {
                const frames = yield* Queue.unbounded<Frame>();
                const pending: Input[] = [];
                const child = { pending, closed: false };
                children.push(child);
                const close = Effect.sync(() => {
                  child.closed = true;
                  child.pending.length = 0;
                }).pipe(Effect.andThen(Queue.shutdown(frames)));
                yield* Effect.addFinalizer(() => close);
                return {
                  messages: Stream.fromQueue(frames),
                  close,
                  offer: (message: Input) =>
                    Effect.sync(() => {
                      child.pending.push(message);
                      offers.push(message);
                    }),
                  initializationResult: Effect.succeed({
                    account: { tokenSource: "oauth" },
                  }),
                  setModel: () => Effect.void,
                  applyFlagSettings: () => Effect.void,
                  interrupt: Effect.void,
                };
              }),
          }),
        ),
      ),
    ),
  );
  let acknowledged = false;
  const run = await fixture({
    headsDirectory: directory,
    registry: (registry) => ({
      ...registry,
      openSession: (name, policy, start) =>
        actual
          .openSession(
            {
              name,
              kind: "claude-subscription",
              runtime: "claude-code",
              credential: { kind: "claude-config-folder", folder: "/fake" },
            },
            policy,
            start,
          )
          .pipe(
            Effect.map((session) => ({
              ...session,
              get nativeSessionId() {
                return session.nativeSessionId;
              },
              startTurn: (input) =>
                session.startTurn(input).pipe(
                  Effect.tap(() =>
                    Effect.sync(() => {
                      acknowledged = true;
                    }),
                  ),
                ),
            })),
          ),
    }),
  });
  let first: ReturnType<typeof run.submit> | undefined;
  let second: ReturnType<typeof run.submit> | undefined;
  try {
    first = run.submit("first committed input");
    await until(() => acknowledged);
    await run.bridge.closeConversation(String(run.conversation.id));
    expect((await first).status).toBe("unanswered");
    expect(children[0]?.closed).toBe(true);
    expect(children[0]?.pending).toEqual([]);
    expect(run.heads.get(String(run.conversation.id))?.pending).toBeUndefined();
    const persisted = await NativeHeads.open(directory);
    expect(persisted.get(String(run.conversation.id))?.pending).toBeUndefined();
    expect(
      persisted.get(String(run.conversation.id))?.deliveredThrough,
    ).toBeUndefined();
    expect(persisted.get(String(run.conversation.id))?.forkRequired).toBe(true);
    await persisted.close();
    second = run.submit("next input");
    await until(() => offers.length === 2);

    expect(offers[1]?.message.content).toEqual([
      { type: "text", text: "first committed input" },
      { type: "text", text: "next input" },
    ]);
    expect(children).toHaveLength(2);
  } finally {
    await run.close();
    await first;
    await second;
    await rm(directory, { recursive: true, force: true });
  }
});

// Cancellation can land after native input is sent but before startTurn returns its acknowledgement.
test("Stop during an acknowledged-in-flight start must not silently duplicate sent input", async () => {
  let armed = true;
  const run = await fixture({
    registry: (registry) => ({
      ...registry,
      openSession: (...args) =>
        registry.openSession(...args).pipe(
          Effect.map((session) => ({
            ...session,
            get nativeSessionId() {
              return session.nativeSessionId;
            },
            events: session.events.pipe(
              Stream.filter(
                (event) =>
                  !armed ||
                  (event.type !== "message.finished" &&
                    event.type !== "turn.finished"),
              ),
            ),
            startTurn: (input) =>
              session
                .startTurn(input)
                .pipe(
                  Effect.andThen(
                    Effect.suspend(() => (armed ? Effect.never : Effect.void)),
                  ),
                ),
          })),
        ),
    }),
  });
  let first: ReturnType<typeof run.submit> | undefined;
  try {
    run.fake.frames.push({ text: "native partial" });
    first = run.submit("already sent input");
    await until(() => run.fake.requests.length === 1);
    await run.bridge.closeConversation(String(run.conversation.id));
    await first;
    armed = false;
    run.fake.frames.push({ text: "next answer" });
    expect((await run.submit("next input")).status).toBe("done");
    // Ruling 25(b) discards the uncertain old session; its input occurs once in the fresh conversation.
    expect(run.fake.opened.at(-1)?.start).toEqual({ kind: "new" });
    expect(run.fake.requests.at(-1)?.input).toEqual([
      { type: "text", text: "already sent input" },
      { type: "text", text: "next input" },
    ]);
    expect(run.fake.requests).toHaveLength(2);
  } finally {
    await run.close();
    await first;
  }
});
