import { expect, test } from "bun:test";
import type {
  Options,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  Account,
  TurnLimit,
  type RuntimeEvent,
  type SessionPolicy,
} from "@neuve/runtime";
import { Effect, Exit, Fiber, Layer, Queue, Scope, Stream } from "effect";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { openClaudeSession } from "../src/session.ts";
import { ClaudeSdk } from "../src/services.ts";
import { assistant, errorResult, result, usage } from "./frames.ts";

const parsedAccount = Account.parse({
  name: "test",
  kind: "claude-subscription",
  runtime: "claude-code",
  credential: { kind: "claude-config-folder" },
});
if (parsedAccount.kind !== "claude-subscription") throw new Error("fixture");
const account = parsedAccount;
const policy: SessionPolicy = {
  systemPrompt: "fixture",
  tools: [],
  approvalPolicy: "allow",
  turnLimit: TurnLimit.parse(5),
};
const config = { cwd: "/test", executable: "/test/claude", environment: {} };

function fixture() {
  const sends: SDKUserMessage[] = [];
  const children: Array<{
    frames: Queue.Queue<SDKMessage>;
    closed: boolean;
    options: Options;
    onClose: Promise<void>;
  }> = [];
  const layer = Layer.succeed(ClaudeSdk, {
    prefixes: { usage: ["You've hit your"], organization: [] },
    open: (options) =>
      Effect.gen(function* () {
        const closed = Promise.withResolvers<void>();
        const child = {
          frames: yield* Queue.unbounded<SDKMessage>(),
          closed: false,
          options,
          onClose: closed.promise,
        };
        children.push(child);
        const close = Effect.sync(() => {
          child.closed = true;
          closed.resolve();
        }).pipe(Effect.andThen(Queue.shutdown(child.frames)));
        yield* Effect.addFinalizer(() => close);
        return {
          messages: Stream.fromQueue(child.frames),
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
  return { sends, children, layer };
}
function run(
  body: (
    f: ReturnType<typeof fixture>,
  ) => Effect.Effect<void, unknown, Scope.Scope | ClaudeSdk>,
) {
  const f = fixture();
  return Effect.runPromise(
    Effect.scoped(body(f)).pipe(
      Effect.provide(f.layer),
      Effect.timeout("2 seconds"),
    ),
  );
}
function reader(session: Effect.Success<ReturnType<typeof openClaudeSession>>) {
  return Effect.gen(function* () {
    const events: RuntimeEvent[] = [];
    const queue = yield* Queue.unbounded<RuntimeEvent>();
    yield* Stream.runForEach(session.events, (event) =>
      Effect.sync(() => {
        events.push(event);
        Queue.offerUnsafe(queue, event);
      }),
    ).pipe(Effect.forkScoped);
    const until = (...types: RuntimeEvent["type"][]) =>
      Effect.gen(function* () {
        while (true) {
          const event = yield* Queue.take(queue);
          if (types.includes(event.type)) return event;
        }
      });
    return { events, until };
  });
}

import { outcomeFromResult } from "../src/mapping.ts";
for (const [code, status, reason] of [
  ["oauth_org_not_allowed", 403, "organization-not-allowed"],
  ["account_on_hold", 403, "account-on-hold"],
  ["billing_error", 402, "billing"],
] as const)
  test(`R4-F1 ${code} with HTTP ${status}`, () => {
    const outcome = outcomeFromResult(
      account,
      result({ is_error: true, api_error_status: status }),
      { assistant: { code, text: "fixture" } },
      false,
      { usage: [], organization: [] },
    );
    expect(outcome).toMatchObject({
      status: "failed",
      failure: { _tag: "AccountRejected", reason },
    });
  });
test("R4-F2 a conversation clear resets cumulative accounting", () =>
  run((f) =>
    Effect.gen(function* () {
      const session = yield* openClaudeSession(account, policy, config);
      const r = yield* reader(session);
      yield* session.startTurn({ turnId: "one", message: "fixture" });
      yield* Queue.offer(
        f.children[0]!.frames,
        result({ modelUsage: { m: usage(100) } }),
      );
      yield* r.until("turn.finished");
      yield* session.startTurn({ turnId: "clear", message: "/clear" });
      yield* Queue.offer(f.children[0]!.frames, {
        type: "conversation_reset",
        new_conversation_id: crypto.randomUUID(),
        uuid: crypto.randomUUID(),
        session_id: crypto.randomUUID(),
        trigger: "clear",
      });
      yield* Queue.offer(f.children[0]!.frames, result({ modelUsage: {} }));
      yield* r.until("turn.finished");
      yield* session.startTurn({ turnId: "two", message: "fixture" });
      yield* Queue.offer(
        f.children[0]!.frames,
        result({ modelUsage: { m: usage(5) } }),
      );
      yield* r.until("turn.finished");
      expect(
        r.events
          .filter((e) => e.type === "usage" && e.turnId === "two")
          .map((e) => (e.type === "usage" ? e.usage.input : -1)),
      ).toEqual([5]);
    }),
  ));

import { TOOL_USE_ID_META } from "../src/tools.ts";
test("R4-F4 tool finished timing is a completion snapshot", () =>
  run((f) =>
    Effect.gen(function* () {
      let ended = 0;
      const tool = {
        name: "fixture",
        description: "fixture",
        inputSchema: { type: "object" },
        hints: {
          readOnly: true,
          destructive: false,
          idempotent: true,
          openWorld: false,
        },
        handle: () =>
          Effect.sleep("15 millis").pipe(
            Effect.andThen(
              Effect.sync(() => {
                ended = Date.now();
                return { text: "fixture" };
              }),
            ),
          ),
      };
      const session = yield* openClaudeSession(
        account,
        { ...policy, tools: [tool] },
        config,
      );
      const r = yield* reader(session);
      yield* session.startTurn({ turnId: "one", message: "fixture" });
      const frame = assistant(undefined);
      frame.message.content = [
        {
          type: "tool_use",
          id: "call-1",
          name: "mcp__neuve__fixture",
          input: {},
        },
      ];
      yield* Queue.offer(f.children[0]!.frames, frame);
      yield* r.until("tool.started");
      const server = f.children[0]!.options.mcpServers!.neuve!;
      if (server.type !== "sdk") throw Error("fixture");
      const client = new Client({ name: "fixture", version: "1" });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      yield* Effect.acquireRelease(
        Effect.promise(async () => {
          await Promise.all([client.connect(ct), server.instance.connect(st)]);
          return client;
        }),
        (c) => Effect.promise(() => c.close()),
      );
      yield* Effect.promise(() =>
        client.callTool({
          name: "fixture",
          arguments: {},
          _meta: { [TOOL_USE_ID_META]: "call-1" },
        }),
      );
      const event = yield* r.until("tool.finished");
      if (event.type !== "tool.finished") throw Error("fixture");
      const first = event.durationMs;
      yield* Effect.sleep("20 millis");
      expect({
        timestampAfterHandler: Date.parse(event.at) >= ended,
        durationFrozen: event.durationMs === first,
      }).toEqual({ timestampAfterHandler: true, durationFrozen: true });
    }),
  ));
test("R4-F5 continuation snapshot does not share mutable usage values", () =>
  run((f) =>
    Effect.gen(function* () {
      const session = yield* openClaudeSession(account, policy, config);
      const r = yield* reader(session);
      yield* session.startTurn({ turnId: "one", message: "fixture" });
      yield* Queue.offer(
        f.children[0]!.frames,
        result({ modelUsage: { m: usage(10) } }),
      );
      yield* r.until("turn.finished");
      const saved = yield* session.continuation;
      Object.assign(saved.usageBaseline.get("m")!, { input: 1000 });
      yield* session.startTurn({ turnId: "two", message: "fixture" });
      yield* Queue.offer(
        f.children[0]!.frames,
        result({ modelUsage: { m: usage(15) } }),
      );
      yield* r.until("turn.finished");
      expect(
        r.events
          .filter((e) => e.type === "usage" && e.turnId === "two")
          .map((e) => (e.type === "usage" ? e.usage.input : -1)),
      ).toEqual([5]);
    }),
  ));
test("R4-F3 cancelling Stop still settles the started turn", async () => {
  const closing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const frames = await Effect.runPromise(Queue.unbounded<SDKMessage>());

  const layer = Layer.succeed(ClaudeSdk, {
    prefixes: { usage: [], organization: [] },
    open: () =>
      Effect.gen(function* () {
        const close = Effect.promise(async () => {
          closing.resolve();
          await release.promise;
        }).pipe(Effect.andThen(Queue.shutdown(frames)));
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
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* openClaudeSession(account, policy, config);
          const r = yield* reader(session);
          yield* session.startTurn({ turnId: "one", message: "fixture" });
          const fiber = yield* session
            .interruptTurn({ turnId: "one", reason: "stop" })
            .pipe(Effect.forkScoped);
          yield* Effect.promise(() => closing.promise);
          const cancellation = yield* Fiber.interrupt(fiber).pipe(
            Effect.forkScoped({ startImmediately: true }),
          );
          release.resolve();
          yield* Fiber.join(cancellation);
          const finished = yield* r
            .until("turn.finished")
            .pipe(Effect.timeoutOption("50 millis"));
          expect(finished._tag).toBe("Some");
          expect(
            r.events.filter((e) => e.type === "turn.finished"),
          ).toHaveLength(1);
          expect(
            r.events.find((e) => e.type === "turn.finished"),
          ).toMatchObject({
            turnId: "one",
            outcome: { status: "interrupted", reason: "stop" },
          });
        }),
      ).pipe(Effect.provide(layer), Effect.timeout("2 seconds")),
    );
  } finally {
    release.resolve();
  }
});

for (const status of [401, 402, 403, 500]) {
  for (const [code, reason] of [
    ["oauth_org_not_allowed", "organization-not-allowed"],
    ["account_on_hold", "account-on-hold"],
    ["billing_error", "billing"],
    ["server_error", "organization-not-allowed"],
  ] as const) {
    test(`R4-F1 explicit ${code} or organization prefix beats HTTP ${status}`, () => {
      expect(
        outcomeFromResult(
          account,
          result({ is_error: true, api_error_status: status }),
          {
            assistant: {
              code,
              text:
                code === "server_error"
                  ? "Organization policy: fixture"
                  : "fixture",
            },
          },
          false,
          { usage: [], organization: ["Organization policy:"] },
        ),
      ).toMatchObject({
        status: "failed",
        failure: { _tag: "AccountRejected", reason },
      });
    });
  }
}

test("R4-F2 zeroed crash after reset retains only the new baseline on resume", () =>
  run((f) =>
    Effect.gen(function* () {
      const scope = yield* Scope.fork(yield* Effect.scope);
      const session = yield* openClaudeSession(account, policy, config).pipe(
        Effect.provideService(Scope.Scope, scope),
      );
      const r = yield* reader(session);
      yield* session.startTurn({ turnId: "one", message: "fixture" });
      yield* Queue.offer(
        f.children[0]!.frames,
        result({ modelUsage: { m: usage(100) } }),
      );
      yield* r.until("turn.finished");
      yield* session.startTurn({ turnId: "two", message: "fixture" });
      yield* Queue.offer(f.children[0]!.frames, {
        type: "conversation_reset",
        new_conversation_id: crypto.randomUUID(),
        uuid: crypto.randomUUID(),
        session_id: crypto.randomUUID(),
      });
      yield* Queue.offer(
        f.children[0]!.frames,
        result({ modelUsage: { m: usage(5) } }),
      );
      yield* r.until("turn.finished");
      yield* session.startTurn({ turnId: "crash", message: "fixture" });
      yield* Queue.offer(
        f.children[0]!.frames,
        errorResult("error_during_execution", {
          modelUsage: {
            m: {
              ...usage(0, 0),
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
            },
          },
        }),
      );
      expect(yield* r.until("turn.finished")).toMatchObject({
        outcome: { status: "failed" },
      });
      const saved = yield* session.continuation;
      expect(saved.usageBaseline.get("m")?.input).toBe(5);
      yield* Scope.close(scope, Exit.void);
      const resumed = yield* openClaudeSession(account, policy, {
        ...config,
        identity: { resume: saved.sessionId },
        usageBaseline: saved.usageBaseline,
      });
      const rr = yield* reader(resumed);
      yield* resumed.startTurn({ turnId: "resumed", message: "fixture" });
      yield* Queue.offer(
        f.children[1]!.frames,
        result({ modelUsage: { m: usage(8) } }),
      );
      yield* rr.until("turn.finished");
      expect(
        rr.events.filter((e) => e.type === "usage").map((e) => e.usage.input),
      ).toEqual([3]);
    }),
  ));

for (const ending of ["failure", "interruption"] as const) {
  test(`R4-F4 tool timing is fixed on handler ${ending}`, () =>
    run((f) =>
      Effect.gen(function* () {
        let ended = 0;
        const ready = Promise.withResolvers<void>();
        const tool = {
          name: "fixture",
          description: "fixture",
          inputSchema: { type: "object" },
          hints: {
            readOnly: true,
            destructive: false,
            idempotent: true,
            openWorld: false,
          },
          handle: () =>
            Effect.gen(function* () {
              yield* Effect.sleep("15 millis");
              ready.resolve();
              return yield* ending === "failure"
                ? Effect.die("fixture")
                : Effect.never;
            }).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  ended = Date.now();
                }),
              ),
            ),
        };
        const session = yield* openClaudeSession(
          account,
          { ...policy, tools: [tool] },
          config,
        );
        const r = yield* reader(session);
        yield* session.startTurn({ turnId: "one", message: "fixture" });
        const frame = assistant(undefined);
        frame.message.content = [
          {
            type: "tool_use",
            id: "call-1",
            name: "mcp__neuve__fixture",
            input: {},
          },
        ];
        yield* Queue.offer(f.children[0]!.frames, frame);
        yield* r.until("tool.started");
        const server = f.children[0]!.options.mcpServers!.neuve!;
        if (server.type !== "sdk") throw Error("fixture");
        const client = new Client({ name: "fixture", version: "1" });
        const [ct, st] = InMemoryTransport.createLinkedPair();
        yield* Effect.acquireRelease(
          Effect.promise(async () => {
            await Promise.all([
              client.connect(ct),
              server.instance.connect(st),
            ]);
            return client;
          }),
          (c) => Effect.promise(() => c.close()),
        );
        const call = yield* Effect.promise(() =>
          client.callTool({
            name: "fixture",
            arguments: {},
            _meta: { [TOOL_USE_ID_META]: "call-1" },
          }),
        ).pipe(Effect.forkScoped);
        yield* Effect.promise(() => ready.promise);
        if (ending === "interruption")
          yield* session.interruptTurn({ turnId: "one", reason: "stop" });
        expect((yield* Fiber.join(call)).isError).toBe(true);
        const event = yield* r.until("tool.finished");
        if (event.type !== "tool.finished") throw Error("fixture");
        const first = event.durationMs;
        yield* Effect.sleep("20 millis");
        expect({
          timestampAfterHandler: Date.parse(event.at) >= ended,
          durationFrozen: event.durationMs === first,
          errored: event.errored,
        }).toEqual({
          timestampAfterHandler: true,
          durationFrozen: true,
          errored: true,
        });
        expect(
          Object.getOwnPropertyDescriptor(event, "durationMs")?.get,
        ).toBeUndefined();
        expect(r.events.filter((e) => e.type === "tool.finished")).toHaveLength(
          1,
        );
      }),
    ));
}

test("R4-F5 importing a baseline copies the caller's usage values", () =>
  run((f) =>
    Effect.gen(function* () {
      const baseline = new Map([
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
      ]);
      const session = yield* openClaudeSession(account, policy, {
        ...config,
        identity: { resume: crypto.randomUUID() },
        usageBaseline: baseline,
      });
      const r = yield* reader(session);
      baseline.get("m")!.input = 1000;
      yield* session.startTurn({ turnId: "one", message: "fixture" });
      yield* Queue.offer(
        f.children[0]!.frames,
        result({ modelUsage: { m: usage(15) } }),
      );
      yield* r.until("turn.finished");
      expect(
        r.events.filter((e) => e.type === "usage").map((e) => e.usage.input),
      ).toEqual([5]);
    }),
  ));
