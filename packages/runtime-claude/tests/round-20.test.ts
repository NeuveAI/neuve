import { expect, test } from "bun:test";
import type {
  Options,
  SDKMessage,
  SDKPartialAssistantMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  Account,
  RuntimeEvent,
  TurnLimit,
  type RuntimeSession,
  type SessionPolicy,
} from "@neuve/runtime";
import {
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Logger,
  Queue,
  Scope,
  Stream,
} from "effect";
import { TestClock } from "effect/testing";
import { makeRuntime } from "../src/runtime.ts";
import {
  ClaudeExecutable,
  ClaudeProcess,
  ClaudeSdk,
  ClaudeSdkError,
} from "../src/services.ts";
import { frameShapeIssues, validFrame } from "../src/protocol.ts";
import { assistant, result, SESSION_ID, textDelta, usage } from "./frames.ts";
import { inbound, out, replay, type Entry } from "./replay.ts";

const account = Account.parse({
  name: "test",
  kind: "claude-subscription",
  runtime: "claude-code",
  credential: { kind: "claude-config-folder" },
});
const policy: SessionPolicy = {
  systemPrompt: "fixture",
  tools: [],
  approvalPolicy: "allow",
  turnLimit: TurnLimit.parse(1),
  outputSchema: { type: "object" },
};
const executable = Layer.succeed(ClaudeExecutable, {
  resolve: () => Effect.succeed("/test/claude"),
});
const processLayer = Layer.succeed(ClaudeProcess, {
  run: () => Effect.die("No process allowed"),
});
const open = out({ type: "query.open" });
const close = out({ type: "query.close" });
const offer = out({ type: "prompt.offer", message: "fixture" });
// These fixtures deliberately cross the SDK's narrower declared union at the IPC boundary.
const wire = (frame: unknown) => frame as SDKMessage;
const ignored = (type = "command_lifecycle", state = "queued") =>
  wire({
    type,
    state,
    uuid: "private-frame-uuid",
    content: "private-frame-content",
    user_message_uuid: "private-reply-stamp",
    modelUsage: "private-ledger",
  });
const partial = (
  event: SDKPartialAssistantMessage["event"],
): SDKPartialAssistantMessage => ({
  type: "stream_event",
  parent_tool_use_id: null,
  uuid: crypto.randomUUID(),
  session_id: SESSION_ID,
  event,
});
const message = assistant(undefined, "hello");
const reply = [
  partial({
    type: "message_start",
    message: { ...message.message, content: [], stop_reason: null },
  }),
  textDelta("hello"),
  message,
  partial({ type: "message_stop" }),
];
const malformed = wire({
  ...message,
  message: { ...message.message, id: undefined },
});
const reader = (s: RuntimeSession) =>
  Effect.gen(function* () {
    const seen: RuntimeEvent[] = [];
    const queue = yield* Queue.unbounded<RuntimeEvent>();
    yield* Stream.runForEach(s.events, (event) =>
      Effect.sync(() => {
        RuntimeEvent.parse(event);
        seen.push(event);
        Queue.offerUnsafe(queue, event);
      }),
    ).pipe(Effect.forkScoped);
    const finished = Effect.gen(function* () {
      while (true) {
        const event = yield* Queue.take(queue);
        if (event.type === "turn.finished") return event;
      }
    });
    return { seen, finished };
  });
function runReplay(
  entries: Entry[],
  body: (
    s: RuntimeSession,
    r: Effect.Success<ReturnType<typeof reader>>,
  ) => Effect.Effect<void, unknown, import("effect").Scope.Scope>,
  sessionPolicy = policy,
  logs: unknown[] = [],
) {
  const fake = replay(entries);
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* makeRuntime({ cwd: "/test", environment: {} });
        const s = yield* runtime.openSession(account, sessionPolicy);
        yield* body(s, yield* reader(s));
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          fake.layer,
          executable,
          processLayer,
          Logger.layer([Logger.make(({ message }) => logs.push(message))]),
        ),
      ),
      Effect.timeout("3 seconds"),
    ),
  );
}
const normalize = (seen: RuntimeEvent[]) =>
  seen.map((event) => {
    const { at: _, ...fields } = event;
    return fields;
  });

for (const final of [false, true]) {
  // Reason: undeclared lifecycle frames must preserve every observable event, usage total and continuation point.
  test(`R20 lifecycle frames are inert in ${final ? "final" : "normal"} turns`, async () => {
    const captures: RuntimeEvent[][] = [];
    for (const addIgnored of [false, true]) {
      const frames = addIgnored
        ? [
            ignored(),
            reply[0]!,
            ignored("command_lifecycle", "started"),
            ...reply.slice(1),
            ignored("command_lifecycle", "completed"),
          ]
        : reply;
      await runReplay(
        [
          open,
          ...(final ? [close, open] : []),
          offer,
          ...frames.map(inbound),
          inbound(
            result({
              modelUsage: { "test-model": usage(11) },
              ...(final ? { structured_output: { ok: true } } : {}),
            }),
          ),
          close,
        ],
        (s, r) =>
          Effect.gen(function* () {
            yield* s.startTurn({
              turnId: "one",
              message: "fixture",
              ...(final ? { final: true } : {}),
            });
            expect((yield* r.finished).outcome).toEqual(
              final
                ? { status: "completed", structuredOutput: { ok: true } }
                : { status: "completed" },
            );
            expect(
              r.seen.filter((e) => e.type === "usage").at(-1),
            ).toMatchObject({ usage: { input: 11, output: 2 } });
            expect(
              r.seen.find((e) => e.type === "message.finished"),
            ).toMatchObject({ resumePoint: message.uuid });
            captures.push(r.seen);
          }),
      );
    }
    expect(normalize(captures[1]!)).toEqual(normalize(captures[0]!));
  });
}

// Reason: ignored frames after an endTurn handler must not poison the next turn as further model output.
test("R20 lifecycle frames after an endTurn tool do not record a protocol fault", () =>
  runReplay(
    [
      open,
      offer,
      inbound(ignored()),
      {
        type: "tool.calls",
        calls: [{ name: "finish", callId: "call", input: { value: "ok" } }],
      },
      inbound(ignored("command_lifecycle", "completed")),
      inbound(result()),
      inbound(ignored("command_lifecycle", "cancelled")),
      offer,
      inbound(assistant(undefined, "next")),
      inbound(result()),
      close,
    ],
    (s, r) =>
      Effect.gen(function* () {
        yield* s.startTurn({ turnId: "one", message: "fixture" });
        expect((yield* r.finished).outcome).toEqual({ status: "completed" });
        yield* s.startTurn({ turnId: "two", message: "fixture" });
        expect((yield* r.finished).outcome).toEqual({ status: "completed" });
        expect(r.seen.filter((e) => e.type === "tool.started")).toHaveLength(1);
        expect(r.seen.filter((e) => e.type === "tool.finished")).toHaveLength(
          1,
        );
      }),
    {
      ...policy,
      tools: [
        {
          name: "finish",
          description: "fixture",
          inputSchema: {
            type: "object",
            properties: { value: { type: "string", minLength: 2 } },
            required: ["value"],
            additionalProperties: false,
          },
          hints: {
            readOnly: true,
            destructive: false,
            idempotent: true,
            openWorld: false,
          },
          handle: () => Effect.succeed({ text: "ok", endTurn: true }),
        },
      ],
    },
  ));

// Reason: logs must deduplicate across child reopenings and expose only safe tags, never frame fields.
test("R20 unknown frames log their safe tag once per session across turns and children", async () => {
  const logs: unknown[] = [];
  await runReplay(
    [
      open,
      offer,
      inbound(ignored("brand_new_frame")),
      inbound(ignored("brand_new_frame")),
      inbound(ignored("private unsafe tag")),
      inbound(ignored("private unsafe tag")),
      inbound(message),
      inbound(result()),
      close,
      open,
      offer,
      inbound(ignored("brand_new_frame")),
      inbound(message),
      inbound(result({ structured_output: {} })),
      close,
    ],
    (s, r) =>
      Effect.gen(function* () {
        yield* s.startTurn({ turnId: "one", message: "fixture" });
        expect((yield* r.finished).outcome.status).toBe("completed");
        yield* s.startTurn({ turnId: "two", message: "fixture", final: true });
        expect((yield* r.finished).outcome.status).toBe("completed");
      }),
    policy,
    logs,
  );
  const serialized = JSON.stringify(logs);
  expect(serialized.match(/brand_new_frame/g)).toHaveLength(1);
  expect(serialized.match(/unrecognized/g)).toHaveLength(1);
  for (const field of [
    "private-frame-uuid",
    "private-frame-content",
    "private-reply-stamp",
    "private-ledger",
    "private unsafe tag",
    "queued",
  ])
    expect(serialized).not.toContain(field);
});

for (const [name, frame] of [
  ["assistant id", malformed],
  ["result subtype", wire({ ...result(), subtype: "future_result" })],
] as const) {
  // Reason: tolerance for unrelated tags must not weaken consumed-frame validation; this guard passes on the base.
  test(`R20 malformed consumed ${name} remains a broken protocol failure`, () =>
    runReplay([open, offer, inbound(frame), close], (s, r) =>
      Effect.gen(function* () {
        yield* s.startTurn({ turnId: "one", message: "fixture" });
        expect((yield* r.finished).outcome).toEqual({
          status: "failed",
          disposition: "broken",
          failure: {
            _tag: "TurnFailed",
            account: account.name,
            reason: "protocol-error",
          },
        });
      }),
    ));
}

// Reason: shape diagnostics and validation must agree for arbitrary IPC headers as well as consumed frames.
test("R20 shape diagnostics accept unknown string tags and reject missing or nonstring tags", () => {
  for (const frame of [
    ignored(),
    ignored("brand_new_frame"),
    ignored("unsafe tag"),
    wire(null),
    wire({}),
    wire({ type: 42 }),
    malformed,
  ]) {
    expect(frameShapeIssues(frame).length === 0).toBe(validFrame(frame));
    expect(validFrame(frame)).toBe(
      typeof frame?.type === "string" && frame !== malformed,
    );
  }
});

type StartMode =
  | "open-fault"
  | "ready-fault"
  | "first-frame"
  | "first-send"
  | "provider-fault"
  | "open-failure"
  | "timeout";
function startup(mode: StartMode) {
  return Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    let opens = 0,
      closes = 0,
      sends = 0;
    const fault = (options: Options) =>
      Effect.gen(function* () {
        const server = options.mcpServers?.neuve;
        if (server?.type !== "sdk") return yield* Effect.die("Missing server");
        const client = new Client({ name: "fixture", version: "1" });
        const [a, b] = InMemoryTransport.createLinkedPair();
        yield* Effect.addFinalizer(() => Effect.promise(() => client.close()));
        yield* Effect.promise(() =>
          Promise.all([client.connect(a), server.instance.connect(b)]),
        );
        yield* Effect.promise(() =>
          client.callTool({ name: "unknown", arguments: {} }),
        );
      });
    const sdk = Layer.succeed(ClaudeSdk, {
      prefixes: { usage: [], organization: [] },
      open: (options) =>
        Effect.gen(function* () {
          opens++;
          const final = options.outputFormat !== undefined;
          const scope = yield* Effect.scope;
          const frames = yield* Queue.unbounded<SDKMessage>();
          let closed = false;
          const close = Effect.gen(function* () {
            if (!closed) {
              closed = true;
              closes++;
              yield* Queue.shutdown(frames);
            }
          });
          yield* Effect.addFinalizer(() => close);
          if (final) {
            yield* Deferred.succeed(entered, undefined);
            if (mode === "open-fault") yield* fault(options);
            if (mode === "open-failure")
              return yield* new ClaudeSdkError({ method: "open" });
            if (mode === "timeout") yield* Effect.never;
          }
          return {
            messages:
              final && mode === "first-frame"
                ? Stream.fromIterable([malformed])
                : final && mode === "provider-fault"
                  ? Stream.fail(new ClaudeSdkError({ method: "messages" }))
                  : Stream.fromQueue(frames),
            close,
            offer: () =>
              Effect.gen(function* () {
                sends++;
                if (final && mode === "first-send") {
                  yield* Queue.offer(frames, malformed);
                  yield* Effect.never;
                }
              }),
            interrupt: Effect.void,
            setModel: () => Effect.void,
            applyFlagSettings: () => Effect.void,
            initializationResult:
              final && mode === "ready-fault"
                ? fault(options).pipe(
                    Effect.provideService(Scope.Scope, scope),
                    Effect.as({ account: { tokenSource: "none" } }),
                  )
                : Effect.succeed({ account: { tokenSource: "none" } }),
          };
        }),
    });
    const runtime = yield* makeRuntime({ cwd: "/test", environment: {} }).pipe(
      Effect.provide(Layer.mergeAll(sdk, executable, processLayer)),
    );
    return { runtime, entered, counts: () => ({ opens, closes, sends }) };
  });
}
for (const mode of [
  "open-fault",
  "ready-fault",
  "first-frame",
  "first-send",
  "provider-fault",
] as const) {
  // Reason: a child fault at any startup boundary must retain its typed reason and publish exactly one failed turn.
  test(`R20 ${mode} reaches the started turn with its original typed reason`, () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* startup(mode);
          const s = yield* f.runtime.openSession(account, policy);
          const r = yield* reader(s);
          const started = yield* s
            .startTurn({ turnId: "one", message: "fixture", final: true })
            .pipe(Effect.exit);
          const reason =
            mode === "provider-fault" ? "provider-failed" : "protocol-error";
          if (Exit.isFailure(started)) {
            expect(started.cause).toMatchObject({
              reasons: [{ error: { _tag: "TurnFailed", reason } }],
            });
          }
          expect((yield* r.finished).outcome).toEqual({
            status: "failed",
            disposition: "broken",
            failure: { _tag: "TurnFailed", account: account.name, reason },
          });
          expect(r.seen.filter((e) => e.type === "turn.finished")).toHaveLength(
            1,
          );
          expect(f.counts().closes).toBe(2);
          if (mode === "open-fault" || mode === "ready-fault")
            expect(f.counts().sends).toBe(0);
          if (mode === "first-send") expect(f.counts().sends).toBe(1);
        }),
      ).pipe(Effect.timeout("3 seconds")),
    ));
}
for (const mode of ["open-failure", "timeout"] as const) {
  // Reason: a genuine launch failure or 25-second open timeout without a prior fault keeps RuntimeUnavailable.
  test(`R20 genuine ${mode} keeps start-failed`, () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* startup(mode);
          const s = yield* f.runtime.openSession(account, policy);
          const r = yield* reader(s);
          const starting = yield* s
            .startTurn({ turnId: "one", message: "fixture", final: true })
            .pipe(Effect.forkScoped);
          yield* Deferred.await(f.entered);
          if (mode === "timeout") yield* TestClock.adjust("25 seconds");
          expect(yield* Fiber.join(starting).pipe(Effect.flip)).toMatchObject({
            _tag: "RuntimeUnavailable",
            reason: "start-failed",
          });
          expect((yield* r.finished).outcome).toMatchObject({
            status: "failed",
            failure: { reason: "provider-failed" },
          });
          expect(f.counts()).toEqual({ opens: 2, closes: 2, sends: 0 });
        }),
      ).pipe(Effect.provide(TestClock.layer()), Effect.timeout("3 seconds")),
    ));
}

// Reason: an immediate caller scope close after a failed start must not replace the recorded fault with interruption.
test("R20 a failed start publishes its fault before the caller closes the session", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* startup("first-send");
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
        const s = yield* f.runtime
          .openSession(account, policy)
          .pipe(Effect.provideService(Scope.Scope, scope));
        yield* s
          .startTurn({ turnId: "one", message: "fixture", final: true })
          .pipe(Effect.exit);
        yield* Scope.close(scope, Exit.void);
        const events = yield* Stream.runCollect(s.events);
        expect(events.filter((e) => e.type === "turn.finished")).toMatchObject([
          {
            outcome: {
              status: "failed",
              disposition: "broken",
              failure: { _tag: "TurnFailed", reason: "protocol-error" },
            },
          },
        ]);
      }),
    ).pipe(Effect.timeout("3 seconds")),
  ));
