import { expect, test } from "bun:test";
import type {
  Options,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { Account, TurnLimit, type RuntimeEvent } from "@neuve/runtime";
import {
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Queue,
  Scope,
  Stream,
} from "effect";
import { openClaudeSession } from "../src/session.ts";
import { ClaudeSdk, ClaudeSdkError } from "../src/services.ts";
import { result, textDelta, usage } from "./frames.ts";

const parsedAccount = Account.parse({
  name: "test",
  kind: "claude-subscription",
  runtime: "claude-code",
  credential: { kind: "claude-config-folder" },
});
if (parsedAccount.kind !== "claude-subscription") throw new Error("fixture");
const account = parsedAccount;
const policy = {
  systemPrompt: "fixture",
  tools: [],
  approvalPolicy: "allow" as const,
  turnLimit: TurnLimit.parse(5),
  outputSchema: { type: "object" },
};
const config = {
  cwd: "/test",
  executable: "/test/claude",
  environment: {},
  interruptTimeoutMs: 100,
};
type Session = Effect.Success<ReturnType<typeof openClaudeSession>>;

const fixture = Effect.gen(function* () {
  const frameBuffered = yield* Deferred.make<void>();
  const deliverFrame = yield* Deferred.make<void>();
  const offerStarted = yield* Deferred.make<void>();
  const steerStarted = yield* Deferred.make<void>();
  const releaseOffer = yield* Deferred.make<void>();
  const opening = yield* Deferred.make<void>();
  const releaseOpening = yield* Deferred.make<void>();
  const closing = yield* Deferred.make<void>();
  const releaseClose = yield* Deferred.make<void>();
  const children: Array<{
    frames: Queue.Queue<SDKMessage>;
    sends: SDKUserMessage[];
    closed: boolean;
    disposed: boolean;
    options: Options;
  }> = [];
  const gates = { frame: false, offer: false, opening: false, close: false };
  let overlaps = 0;
  const layer = Layer.succeed(ClaudeSdk, {
    prefixes: { usage: [], organization: [] },
    open: (options) =>
      Effect.gen(function* () {
        if (children.some((child) => !child.disposed)) overlaps++;
        const child = {
          frames: yield* Queue.unbounded<SDKMessage>(),
          sends: [] as SDKUserMessage[],
          closed: false,
          disposed: false,
          options,
        };
        children.push(child);
        const close = Effect.gen(function* () {
          yield* Deferred.succeed(closing, undefined);
          if (gates.close) yield* Deferred.await(releaseClose);
          child.closed = true;
          yield* Queue.shutdown(child.frames);
        });
        yield* Effect.addFinalizer(() =>
          close.pipe(
            Effect.andThen(
              Effect.sync(() => {
                child.disposed = true;
              }),
            ),
          ),
        );
        return {
          messages: Stream.fromQueue(child.frames).pipe(
            Stream.tap(() =>
              Effect.gen(function* () {
                if (!gates.frame) return;
                yield* Deferred.succeed(frameBuffered, undefined);
                yield* Deferred.await(deliverFrame);
              }),
            ),
          ),
          close,
          offer: (message) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(offerStarted, undefined);
              if (message.priority === "now")
                yield* Deferred.succeed(steerStarted, undefined);
              if (gates.offer) yield* Deferred.await(releaseOffer);
              if (child.closed)
                return yield* new ClaudeSdkError({ method: "offer" });
              child.sends.push(message);
            }),
          interrupt: Effect.void,
          setModel: () => Effect.void,
          applyFlagSettings: () => Effect.void,
          initializationResult: Effect.gen(function* () {
            if (gates.opening) {
              yield* Deferred.succeed(opening, undefined);
              yield* Deferred.await(releaseOpening);
            }
            return { account: {} };
          }),
        };
      }),
  });
  const release = Effect.all(
    [deliverFrame, releaseOffer, releaseOpening, releaseClose].map((d) =>
      Deferred.succeed(d, undefined),
    ),
    { discard: true },
  );
  return {
    children,
    gates,
    layer,
    frameBuffered,
    deliverFrame,
    offerStarted,
    steerStarted,
    releaseOffer,
    opening,
    releaseOpening,
    closing,
    releaseClose,
    release,
    overlaps: () => overlaps,
  };
});
type Fixture = Effect.Success<typeof fixture>;
function reader(session: Session) {
  return Effect.gen(function* () {
    const events: RuntimeEvent[] = [];
    const queue = yield* Queue.unbounded<RuntimeEvent>();
    const fiber = yield* Stream.runForEach(session.events, (e) =>
      Effect.sync(() => {
        events.push(e);
        Queue.offerUnsafe(queue, e);
      }),
    ).pipe(Effect.forkScoped);
    const until = (type: RuntimeEvent["type"]) =>
      Effect.gen(function* () {
        while (true) {
          const event = yield* Queue.take(queue);
          if (event.type === type) return event;
        }
      });
    return { events, fiber, until };
  });
}
type Reader = Effect.Success<ReturnType<typeof reader>>;
function assertEvents(events: RuntimeEvent[], ids: string[]) {
  expect(
    events.filter((e) => e.type === "turn.started").map((e) => e.turnId),
  ).toEqual(ids);
  expect(
    events.filter((e) => e.type === "turn.finished").map((e) => e.turnId),
  ).toEqual(ids);
  const open = new Set<string>();
  for (const event of events) {
    if (event.type === "turn.started") open.add(event.turnId);
    else {
      expect(open.has(event.turnId)).toBe(true);
      if (event.type === "turn.finished") open.delete(event.turnId);
    }
  }
  expect([...open]).toEqual([]);
}
function run(
  body: (
    f: Fixture,
    session: Session,
    r: Reader,
    scope: Scope.Closeable,
  ) => Effect.Effect<void, unknown, Scope.Scope>,
) {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const scope = yield* Scope.fork(yield* Effect.scope);
        const session = yield* openClaudeSession(account, policy, config).pipe(
          Effect.provide(f.layer),
          Effect.provideService(Scope.Scope, scope),
        );
        const r = yield* reader(session);
        yield* body(f, session, r, scope).pipe(Effect.ensuring(f.release));
        yield* Scope.close(scope, Exit.void);
        yield* Fiber.join(r.fiber);
        expect(f.overlaps()).toBe(0);
        expect(f.children.every((child) => child.disposed)).toBe(true);
      }),
    ).pipe(Effect.timeout("2 seconds")),
  );
}
const begin = (session: Session, turnId = "one") =>
  session.startTurn({ turnId, message: "fixture" });
const final = (session: Session) =>
  session.startTurn({ turnId: "final", message: "fixture", final: true });
const reply = (f: Fixture, index = 0) =>
  Queue.offer(f.children[index]!.frames, result());
const completed = (f: Fixture, session: Session, r: Reader) =>
  Effect.gen(function* () {
    yield* begin(session);
    yield* reply(f);
    yield* r.until("turn.finished");
  });

// Reason: only plural stamps can distinguish a delayed snapshot from a folded steer.
test("round 8b plural and singular stamps differ on the same delayed result sequence", async () => {
  for (const queued of [0, undefined]) {
    for (const plural of [true, false]) {
      await run((f, session, r) =>
        Effect.gen(function* () {
          yield* begin(session);
          f.gates.frame = true;
          const first = f.children[0]!.sends[0]!.uuid!;
          yield* Queue.offer(
            f.children[0]!.frames,
            result({
              user_message_uuid: first,
              ...(plural ? { user_message_uuids: [first] } : {}),
              ...(queued === undefined ? {} : { queued_turn_count: queued }),
              modelUsage: { m: usage(10) },
            }),
          );
          yield* Deferred.await(f.frameBuffered);
          yield* session.steerTurn({ turnId: "one", message: "fixture" });
          yield* Deferred.succeed(f.deliverFrame, undefined);
          yield* r.until("usage");
          // This serialized read waits until result binding has completed.
          yield* session.continuation;
          expect(f.children[0]!.sends).toHaveLength(2);
          if (plural) {
            expect(
              r.events.filter((e) => e.type === "turn.finished"),
            ).toHaveLength(0);
            const last = f.children[0]!.sends[1]!.uuid!;
            yield* Queue.offer(f.children[0]!.frames, {
              ...textDelta("steer reply"),
              user_message_uuid: last,
            });
            expect(yield* r.until("text")).toMatchObject({
              turnId: "one",
              text: "steer reply",
            });
            yield* Queue.offer(
              f.children[0]!.frames,
              result({
                user_message_uuid: last,
                user_message_uuids: [last],
                queued_turn_count: 0,
              }),
            );
          }
          expect(yield* r.until("turn.finished")).toMatchObject({
            turnId: "one",
            outcome: { status: "completed" },
          });
          assertEvents(r.events, ["one"]);
        }),
      );
    }
  }
});

// Reason: Stop must revoke a buffered result before it can publish output or finish twice.
test("race pair: Stop with result", () =>
  run((f, session, r, scope) =>
    Effect.gen(function* () {
      yield* begin(session);
      f.gates.frame = true;
      yield* Queue.offer(f.children[0]!.frames, result());
      yield* Deferred.await(f.frameBuffered);
      yield* session.interruptTurn({ turnId: "one", reason: "stop" });
      yield* Deferred.succeed(f.deliverFrame, undefined);
      yield* Scope.close(scope, Exit.void);
      yield* Fiber.join(r.fiber);
      expect(r.events.at(-1)).toMatchObject({
        outcome: { status: "interrupted", reason: "stop" },
      });
      assertEvents(r.events, ["one"]);
    }),
  ));

// Reason: a send waiting at the SDK boundary must be cancelled when Stop owns the turn.
test("race pair: Stop with steer", () =>
  run((f, session, r, scope) =>
    Effect.gen(function* () {
      yield* begin(session);
      f.gates.offer = true;
      const steering = yield* session
        .steerTurn({ turnId: "one", message: "fixture" })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(f.steerStarted);
      yield* session.interruptTurn({ turnId: "one", reason: "stop" });
      yield* Deferred.succeed(f.releaseOffer, undefined);
      yield* Fiber.await(steering);
      expect(f.children[0]!.sends).toHaveLength(1);
      yield* Scope.close(scope, Exit.void);
      yield* Fiber.join(r.fiber);
      assertEvents(r.events, ["one"]);
    }),
  ));

// Reason: a final turn owns its half-opened child, even before initialization completes.
test("race pair: Stop with reopen", () =>
  run((f, session, r, scope) =>
    Effect.gen(function* () {
      yield* completed(f, session, r);
      f.gates.opening = true;
      const starting = yield* final(session).pipe(Effect.forkScoped);
      yield* Deferred.await(f.opening);
      yield* session.interruptTurn({ turnId: "final", reason: "stop" });
      yield* Deferred.succeed(f.releaseOpening, undefined);
      yield* Fiber.await(starting);
      expect(f.children[1]!.sends).toHaveLength(0);
      expect(f.children[1]!.disposed).toBe(true);
      yield* Scope.close(scope, Exit.void);
      yield* Fiber.join(r.fiber);
      assertEvents(r.events, ["one", "final"]);
    }),
  ));

// Reason: queue depth predates delivery; a newer accepted send keeps ownership of its reply.
test("race pair: steer with result", () =>
  run((f, session, r, scope) =>
    Effect.gen(function* () {
      yield* begin(session);
      f.gates.frame = true;
      const first = f.children[0]!.sends[0]!.uuid!;
      yield* Queue.offer(
        f.children[0]!.frames,
        result({
          user_message_uuid: first,
          user_message_uuids: [first],
          queued_turn_count: 0,
          modelUsage: { m: usage(10) },
        }),
      );
      yield* Deferred.await(f.frameBuffered);
      yield* session.steerTurn({ turnId: "one", message: "fixture" });
      yield* Deferred.succeed(f.deliverFrame, undefined);
      yield* r.until("usage");
      expect(r.events.filter((e) => e.type === "turn.finished")).toHaveLength(
        0,
      );
      const last = f.children[0]!.sends[1]!.uuid!;
      yield* Queue.offer(f.children[0]!.frames, {
        ...textDelta("fixture"),
        user_message_uuid: last,
      });
      expect(yield* r.until("text")).toMatchObject({
        turnId: "one",
        text: "fixture",
      });
      yield* Queue.offer(
        f.children[0]!.frames,
        result({ user_message_uuid: last, queued_turn_count: 0 }),
      );
      yield* r.until("turn.finished");
      yield* Scope.close(scope, Exit.void);
      yield* Fiber.join(r.fiber);
      assertEvents(r.events, ["one"]);
    }),
  ));

// Reason: admission must wait until the old child's finalizer confirms disposal.
test("race pair: start with cleanup", () =>
  run((f, session, r, scope) =>
    Effect.gen(function* () {
      yield* begin(session);
      f.gates.close = true;
      const stop = yield* session
        .interruptTurn({ turnId: "one", reason: "stop" })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(f.closing);
      expect(yield* begin(session, "two").pipe(Effect.flip)).toMatchObject({
        reason: "previous-turn-active",
      });
      expect(f.children).toHaveLength(1);
      yield* Deferred.succeed(f.releaseClose, undefined);
      yield* Fiber.join(stop);
      yield* r.until("turn.finished");
      yield* begin(session, "two");
      expect(f.children[0]!.disposed).toBe(true);
      yield* reply(f, 1);
      expect(yield* r.until("turn.finished")).toMatchObject({
        turnId: "two",
        outcome: { status: "completed" },
      });
      yield* Scope.close(scope, Exit.void);
      yield* Fiber.join(r.fiber);
      assertEvents(r.events, ["one", "two"]);
    }),
  ));

// Reason: scope closure takes ownership from a Stop whose child wait is still pending.
test("race pair: scope close with Stop", () =>
  run((f, session, r, scope) =>
    Effect.gen(function* () {
      yield* begin(session);
      f.gates.close = true;
      const stop = yield* session
        .interruptTurn({ turnId: "one", reason: "stop" })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(f.closing);
      const closure = yield* Scope.close(scope, Exit.void).pipe(
        Effect.forkScoped,
      );
      yield* Fiber.join(r.fiber);
      expect(r.events.at(-1)).toMatchObject({
        outcome: { status: "interrupted", reason: "shutdown" },
      });
      yield* Deferred.succeed(f.releaseClose, undefined);
      yield* Fiber.join(closure);
      yield* Fiber.await(stop);
      assertEvents(r.events, ["one"]);
    }),
  ));

// Reason: buffered SDK output must not escape after the session's scope ends.
test("race pair: scope close with result", () =>
  run((f, session, r, scope) =>
    Effect.gen(function* () {
      yield* begin(session);
      f.gates.frame = true;
      yield* Queue.offer(f.children[0]!.frames, result());
      yield* Deferred.await(f.frameBuffered);
      yield* Scope.close(scope, Exit.void);
      yield* Deferred.succeed(f.deliverFrame, undefined);
      yield* Fiber.join(r.fiber);
      assertEvents(r.events, ["one"]);
    }),
  ));

// Reason: closing the session cancels an SDK offer that has not returned to its caller.
test("race pair: scope close with steer", () =>
  run((f, session, r, scope) =>
    Effect.gen(function* () {
      yield* begin(session);
      f.gates.offer = true;
      const steering = yield* session
        .steerTurn({ turnId: "one", message: "fixture" })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(f.steerStarted);
      yield* Scope.close(scope, Exit.void);
      yield* Deferred.succeed(f.releaseOffer, undefined);
      yield* Fiber.await(steering);
      yield* Fiber.join(r.fiber);
      expect(f.children[0]!.sends).toHaveLength(1);
      assertEvents(r.events, ["one"]);
    }),
  ));

// Reason: scope closure revokes a final turn while its replacement child is initializing.
test("race pair: scope close with reopen", () =>
  run((f, session, r, scope) =>
    Effect.gen(function* () {
      yield* completed(f, session, r);
      f.gates.opening = true;
      const starting = yield* final(session).pipe(Effect.forkScoped);
      yield* Deferred.await(f.opening);
      yield* Scope.close(scope, Exit.void);
      yield* Deferred.succeed(f.releaseOpening, undefined);
      yield* Fiber.await(starting);
      yield* Fiber.join(r.fiber);
      expect(f.children[1]!.sends).toHaveLength(0);
      assertEvents(r.events, ["one", "final"]);
    }),
  ));

// Reason: turn.started commits ownership before a first SDK offer can block.
test("race pair: scope close with start", () =>
  run((f, session, r, scope) =>
    Effect.gen(function* () {
      f.gates.offer = true;
      const starting = yield* begin(session).pipe(Effect.forkScoped);
      yield* Deferred.await(f.offerStarted);
      yield* Scope.close(scope, Exit.void);
      yield* Deferred.succeed(f.releaseOffer, undefined);
      yield* Fiber.await(starting);
      yield* Fiber.join(r.fiber);
      expect(f.children[0]!.sends).toHaveLength(0);
      assertEvents(r.events, ["one"]);
    }),
  ));

// Reason: closing during old-child cleanup must cancel reopening before a second child exists.
test("race pair: scope close with cleanup", () =>
  run((f, session, r, scope) =>
    Effect.gen(function* () {
      yield* completed(f, session, r);
      f.gates.close = true;
      const starting = yield* final(session).pipe(Effect.forkScoped);
      yield* Deferred.await(f.closing);
      const closure = yield* Scope.close(scope, Exit.void).pipe(
        Effect.forkScoped,
      );
      yield* Fiber.join(r.fiber);
      yield* Deferred.succeed(f.releaseClose, undefined);
      yield* Fiber.join(closure);
      yield* Fiber.await(starting);
      expect(f.children).toHaveLength(1);
      assertEvents(r.events, ["one", "final"]);
    }),
  ));
