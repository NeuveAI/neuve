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
import { Effect, Exit, Layer, Queue, Scope, Stream } from "effect";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { openClaudeSession } from "../src/session.ts";
import { ClaudeSdk } from "../src/services.ts";
import { TOOL_USE_ID_INPUT } from "../src/tools.ts";
import { assistant, errorResult, result, textDelta, usage } from "./frames.ts";

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

for (const stamps of ["both", "first", "last", "neither"] as const) {
  test(`R2-F1/R2-N3 queued steering stays on its turn: ${stamps} stamped`, () =>
    run((f) =>
      Effect.gen(function* () {
        const session = yield* openClaudeSession(account, policy, config);
        const r = yield* reader(session);
        yield* session.startTurn({ turnId: "one", message: "fixture" });
        yield* session.steerTurn({ turnId: "one", message: "fixture" });
        yield* Queue.offer(
          f.children[0]!.frames,
          result({
            ...(stamps === "both" || stamps === "first"
              ? { user_message_uuids: [f.sends[0]!.uuid!] }
              : {}),
            queued_turn_count: 1,
            modelUsage: { m: usage(10) },
          }),
        );
        yield* Queue.offer(f.children[0]!.frames, textDelta("queued work"));
        expect(yield* r.until("text", "turn.finished")).toMatchObject({
          type: "text",
          turnId: "one",
          text: "queued work",
        });
        expect(
          yield* session
            .startTurn({ turnId: "two", message: "too soon" })
            .pipe(Effect.flip),
        ).toMatchObject({ reason: "previous-turn-active" });
        yield* Queue.offer(
          f.children[0]!.frames,
          result({
            ...(stamps === "both" || stamps === "last"
              ? { user_message_uuids: [f.sends[1]!.uuid!] }
              : {}),
            queued_turn_count: 0,
            modelUsage: { m: usage(20) },
          }),
        );
        expect(yield* r.until("turn.finished")).toMatchObject({
          turnId: "one",
          outcome: { status: "completed" },
        });
        expect(
          r.events
            .filter((e) => e.type === "usage")
            .map((e) => [e.turnId, e.usage.input]),
        ).toEqual([
          ["one", 10],
          ["one", 20],
        ]);
        yield* session.startTurn({ turnId: "two", message: "fixture" });
        yield* Queue.offer(
          f.children[0]!.frames,
          result({ modelUsage: { m: usage(21) } }),
        );
        expect(yield* r.until("turn.finished")).toMatchObject({
          turnId: "two",
          outcome: { status: "completed" },
        });
        expect(
          r.events
            .filter((e) => e.type === "usage")
            .map((e) => [e.turnId, e.usage.input]),
        ).toEqual([
          ["one", 10],
          ["one", 20],
          ["two", 1],
        ]);
        expect(r.events.filter((e) => e.type === "turn.finished")).toHaveLength(
          2,
        );
      }),
    ));
}

test("R2-F1 unstamped drain accounts for coalesced sends", () =>
  run((f) =>
    Effect.gen(function* () {
      const session = yield* openClaudeSession(account, policy, config);
      const r = yield* reader(session);
      yield* session.startTurn({ turnId: "one", message: "fixture" });
      yield* session.steerTurn({ turnId: "one", message: "fixture" });
      yield* session.steerTurn({ turnId: "one", message: "fixture" });
      yield* Queue.offer(
        f.children[0]!.frames,
        result({ queued_turn_count: 2 }),
      );
      yield* Queue.offer(f.children[0]!.frames, textDelta("queued work"));
      expect(yield* r.until("text", "turn.finished")).toMatchObject({
        type: "text",
      });
      yield* Queue.offer(
        f.children[0]!.frames,
        result({ queued_turn_count: 0 }),
      );
      expect(yield* r.until("turn.finished")).toMatchObject({
        outcome: { status: "completed" },
      });
    }),
  ));

test("R2-F1 final queued turn requires structured output only on its drain", () =>
  run((f) =>
    Effect.gen(function* () {
      const session = yield* openClaudeSession(
        account,
        { ...policy, outputSchema: { type: "object" } },
        config,
      );
      const r = yield* reader(session);
      yield* session.startTurn({
        turnId: "one",
        message: "fixture",
        final: true,
      });
      yield* session.steerTurn({ turnId: "one", message: "fixture" });
      const frames = f.children[1]!.frames;
      yield* Queue.offer(frames, result({ queued_turn_count: 1 }));
      yield* Queue.offer(
        frames,
        result({
          queued_turn_count: 0,
          structured_output: { value: "fixture" },
        }),
      );
      expect(yield* r.until("turn.finished")).toMatchObject({
        outcome: {
          status: "completed",
          structuredOutput: { value: "fixture" },
        },
      });
    }),
  ));

for (const stamped of [true, false]) {
  test(`R2-F1 extra result after drain closes: stamped=${stamped}`, () =>
    run((f) =>
      Effect.gen(function* () {
        const session = yield* openClaudeSession(account, policy, config);
        const r = yield* reader(session);
        yield* session.startTurn({ turnId: "one", message: "fixture" });
        const frame = result({
          ...(stamped ? { user_message_uuids: [f.sends[0]!.uuid!] } : {}),
          queued_turn_count: 0,
        });
        yield* Queue.offer(f.children[0]!.frames, frame);
        yield* r.until("turn.finished");
        yield* Queue.offer(f.children[0]!.frames, frame);
        yield* Effect.promise(() => f.children[0]!.onClose);
        expect(
          yield* session
            .startTurn({ turnId: "two", message: "fixture" })
            .pipe(Effect.flip),
        ).toMatchObject({ reason: "session-stopped" });
        expect(r.events.filter((e) => e.type === "turn.finished")).toHaveLength(
          1,
        );
      }),
    ));
}

test("R2-F2 zeroed crash retains the continuation baseline, resume charges only 5", () =>
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
        result({ modelUsage: { m: usage(10) } }),
      );
      yield* r.until("turn.finished");
      yield* session.startTurn({ turnId: "two", message: "fixture" });
      yield* Queue.offer(
        f.children[0]!.frames,
        errorResult("error_during_execution", { modelUsage: {} }),
      );
      expect(yield* r.until("turn.finished")).toMatchObject({
        outcome: { status: "failed" },
      });
      const saved = yield* session.continuation;
      expect(saved.usageBaseline.get("m")?.input).toBe(10);
      yield* Scope.close(scope, Exit.void);
      const resumed = yield* openClaudeSession(account, policy, {
        ...config,
        identity: { resume: saved.sessionId },
        usageBaseline: saved.usageBaseline,
      });
      const rr = yield* reader(resumed);
      yield* resumed.startTurn({ turnId: "three", message: "fixture" });
      yield* Queue.offer(
        f.children[1]!.frames,
        result({ modelUsage: { m: usage(15) } }),
      );
      yield* rr.until("turn.finished");
      expect(
        rr.events.filter((e) => e.type === "usage").map((e) => e.usage.input),
      ).toEqual([5]);
    }),
  ));

for (const field of [
  "inputTokens",
  "outputTokens",
  "cacheReadInputTokens",
  "cacheCreationEphemeral5mInputTokens",
  "cacheCreationEphemeral1hInputTokens",
  "thinkingTokens",
] as const) {
  test(`R2-F2 regression in ${field} preserves that model without resetting another`, () =>
    run((f) =>
      Effect.gen(function* () {
        const session = yield* openClaudeSession(account, policy, config);
        const r = yield* reader(session);
        const before = {
          ...usage(10, 10),
          cacheReadInputTokens: 10,
          cacheCreationInputTokens: 20,
          cacheCreationEphemeral5mInputTokens: 10,
          cacheCreationEphemeral1hInputTokens: 10,
          thinkingTokens: 10,
        };
        const after = {
          ...before,
          // Lower the total too: unattributed writes now remain in the 5m count.
          ...(field === "cacheCreationEphemeral5mInputTokens"
            ? { cacheCreationInputTokens: 10 }
            : {}),
          [field]: 0,
        };
        for (const [id, ledger] of [
          ["one", { m: before, other: usage(5) }],
          ["two", { m: after, other: usage(8) }],
        ] as const) {
          yield* session.startTurn({ turnId: id, message: "fixture" });
          yield* Queue.offer(
            f.children[0]!.frames,
            result({ modelUsage: ledger }),
          );
          yield* r.until("turn.finished");
        }
        expect(
          (yield* session.continuation).usageBaseline.get("m"),
        ).toMatchObject({
          input: 10,
          output: 10,
          cacheRead: 10,
          cacheWrite5m: 10,
          cacheWrite1h: 10,
          thinking: 10,
        });
        expect(
          r.events
            .filter((e) => e.type === "usage")
            .filter((e) => e.turnId === "two")
            .map((e) => [e.model, e.usage.input]),
        ).toEqual([["other", 3]]);
      }),
    ));
}

for (const text of [
  "overloaded",
  "not logged in",
  "You've hit your limit",
  "529",
]) {
  test(`R2-F3 recovered retry keeps successful answer: ${text}`, () =>
    run((f) =>
      Effect.gen(function* () {
        const session = yield* openClaudeSession(account, policy, config);
        const r = yield* reader(session);
        yield* session.startTurn({ turnId: "one", message: "fixture" });
        yield* Queue.offer(f.children[0]!.frames, {
          type: "system",
          subtype: "api_retry",
          attempt: 1,
          max_retries: 10,
          retry_delay_ms: 1,
          error_status: 529,
          error: "overloaded",
          uuid: crypto.randomUUID(),
          session_id: "fixture",
        });
        yield* Queue.offer(f.children[0]!.frames, result({ result: text }));
        expect(yield* r.until("turn.finished")).toMatchObject({
          outcome: { status: "completed" },
        });
        yield* session.startTurn({ turnId: "two", message: "fixture" });
        yield* Queue.offer(
          f.children[0]!.frames,
          result({ api_error_status: 529 }),
        );
        expect(yield* r.until("turn.finished")).toMatchObject({
          outcome: {
            status: "failed",
            disposition: "reusable",
            failure: { reason: "provider-unavailable" },
          },
        });
      }),
    ));
}

for (const status of [400, 401, 403, 429, 500, 503, 529]) {
  test(`R2-F4 HTTP ${status} fails reusable`, () =>
    run((f) =>
      Effect.gen(function* () {
        const session = yield* openClaudeSession(account, policy, config);
        const r = yield* reader(session);
        yield* session.startTurn({ turnId: "one", message: "fixture" });
        yield* Queue.offer(
          f.children[0]!.frames,
          result({ api_error_status: status }),
        );
        expect(yield* r.until("turn.finished")).toMatchObject({
          outcome: {
            status: "failed",
            disposition: "reusable",
            failure: {
              reason:
                status >= 500 ? "provider-unavailable" : "provider-failed",
            },
          },
        });
        yield* session.startTurn({ turnId: "two", message: "fixture" });
        yield* Queue.offer(f.children[0]!.frames, result());
        expect(yield* r.until("turn.finished")).toMatchObject({
          outcome: { status: "completed" },
        });
      }),
    ));
}

for (const status of [401, 403]) {
  test(`R2-F4 HTTP ${status} retains authentication account rules`, () =>
    run((f) =>
      Effect.gen(function* () {
        const session = yield* openClaudeSession(account, policy, config);
        const r = yield* reader(session);
        yield* session.startTurn({ turnId: "one", message: "fixture" });
        yield* Queue.offer(
          f.children[0]!.frames,
          assistant("authentication_failed"),
        );
        yield* Queue.offer(
          f.children[0]!.frames,
          result({ api_error_status: status }),
        );
        expect(yield* r.until("turn.finished")).toMatchObject({
          outcome: {
            status: "failed",
            disposition: "reusable",
            failure: {
              _tag: status === 403 ? "AccountRejected" : "SignInRequired",
            },
          },
        });
      }),
    ));
}

for (const status of [400, 503]) {
  test(`R2-F4 queued HTTP ${status} still fails after a successful drain`, () =>
    run((f) =>
      Effect.gen(function* () {
        const session = yield* openClaudeSession(account, policy, config);
        const r = yield* reader(session);
        yield* session.startTurn({ turnId: "one", message: "fixture" });
        yield* session.steerTurn({ turnId: "one", message: "fixture" });
        yield* Queue.offer(
          f.children[0]!.frames,
          result({ api_error_status: status, queued_turn_count: 1 }),
        );
        yield* Queue.offer(
          f.children[0]!.frames,
          result({ queued_turn_count: 0 }),
        );
        expect(yield* r.until("turn.finished")).toMatchObject({
          outcome: {
            status: "failed",
            disposition: "reusable",
            failure: {
              reason:
                status >= 500 ? "provider-unavailable" : "provider-failed",
            },
          },
        });
      }),
    ));
}

test("R2-F5 open rejects a schema declaring the reserved key with a named typed error", () =>
  run((f) =>
    Effect.gen(function* () {
      const error = yield* openClaudeSession(
        account,
        {
          ...policy,
          tools: [
            {
              name: "fixture",
              description: "fixture",
              inputSchema: {
                type: "object",
                properties: { [TOOL_USE_ID_INPUT]: { type: "string" } },
                required: [TOOL_USE_ID_INPUT],
              },
              hints: {
                readOnly: true,
                destructive: false,
                idempotent: true,
                openWorld: false,
              },
              handle: () => Effect.succeed({ text: "fixture" }),
            },
          ],
        },
        config,
      ).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "TurnFailed",
        reason: "protocol-error",
        toolName: "fixture",
      });
      expect(error.message).toContain("fixture");
      expect(error.message).toContain(TOOL_USE_ID_INPUT);
      expect(f.children).toHaveLength(0);
    }),
  ));

for (const route of [
  "metadata",
  "metadata-hook",
  "hook",
  "unwritten",
] as const) {
  test(`R2-F5 real MCP preserves caller data and accepts only written fallback stamps: ${route}`, () =>
    run((f) =>
      Effect.gen(function* () {
        const received: unknown[] = [];
        const session = yield* openClaudeSession(
          account,
          {
            ...policy,
            tools: [
              {
                name: "fixture",
                description: "fixture",
                inputSchema: { type: "object", additionalProperties: true },
                hints: {
                  readOnly: true,
                  destructive: false,
                  idempotent: true,
                  openWorld: false,
                },
                handle: (input) =>
                  Effect.sync(() => {
                    received.push(input);
                    return { text: "fixture" };
                  }),
              },
            ],
          },
          config,
        );
        const r = yield* reader(session);
        yield* session.startTurn({ turnId: "one", message: "fixture" });
        const options = f.children[0]!.options;
        const server = options.mcpServers?.neuve;
        if (server === undefined || !("instance" in server))
          throw new Error("fixture server");
        const hook = options.hooks?.PreToolUse?.[0]?.hooks[0];
        if (hook === undefined) throw new Error("fixture hook");
        const client = new Client({ name: "fixture", version: "1" });
        const [ct, st] = InMemoryTransport.createLinkedPair();
        yield* Effect.acquireRelease(
          Effect.promise(async () => {
            await Promise.all([
              client.connect(ct),
              server.instance.connect(st),
            ]);
          }),
          () =>
            Effect.promise(async () => {
              await client.close();
            }),
        );
        if (route === "hook") {
          const responses = yield* Effect.promise(async () => {
            const calls = await Promise.all(
              ["first", "second"].map(async (id) => {
                const response = await hook(
                  {
                    hook_event_name: "PreToolUse",
                    session_id: "fixture",
                    transcript_path: "/unused",
                    cwd: "/test",
                    tool_name: "mcp__neuve__fixture",
                    tool_use_id: id,
                    tool_input: { value: id },
                  },
                  id,
                  { signal: new AbortController().signal },
                );
                if (
                  !("hookSpecificOutput" in response) ||
                  response.hookSpecificOutput?.hookEventName !== "PreToolUse"
                )
                  throw new Error("fixture stamp");
                return client.callTool({
                  name: "fixture",
                  arguments: response.hookSpecificOutput.updatedInput,
                });
              }),
            );
            return calls;
          });
          expect(responses.every((response) => !response.isError)).toBe(true);
          expect(received).toEqual([{ value: "first" }, { value: "second" }]);
          const unregistered = yield* Effect.promise(() =>
            hook(
              {
                hook_event_name: "PreToolUse",
                session_id: "fixture",
                transcript_path: "/unused",
                cwd: "/test",
                tool_name: "mcp__neuve__unknown",
                tool_use_id: "unknown",
                tool_input: {},
              },
              "unknown",
              { signal: new AbortController().signal },
            ),
          );
          expect(unregistered).toEqual({});
        } else {
          let input: Record<string, unknown> = {
            [TOOL_USE_ID_INPUT]: "caller value",
          };
          if (route === "metadata") {
            expect(
              yield* Effect.promise(() =>
                hook(
                  {
                    hook_event_name: "PreToolUse",
                    session_id: "fixture",
                    transcript_path: "/unused",
                    cwd: "/test",
                    tool_name: "mcp__neuve__fixture",
                    tool_use_id: "native-id",
                    tool_input: input,
                  },
                  "native-id",
                  { signal: new AbortController().signal },
                ),
              ),
            ).toEqual({});
          }
          if (route === "metadata-hook") {
            const response = yield* Effect.promise(() =>
              hook(
                {
                  hook_event_name: "PreToolUse",
                  session_id: "fixture",
                  transcript_path: "/unused",
                  cwd: "/test",
                  tool_name: "mcp__neuve__fixture",
                  tool_use_id: "native-id",
                  tool_input: { value: "fixture" },
                },
                "native-id",
                { signal: new AbortController().signal },
              ),
            );
            if (
              !("hookSpecificOutput" in response) ||
              response.hookSpecificOutput?.hookEventName !== "PreToolUse" ||
              response.hookSpecificOutput.updatedInput === undefined
            )
              throw new Error("fixture stamp");
            input = response.hookSpecificOutput.updatedInput;
          }
          const response = yield* Effect.promise(() =>
            client.callTool({
              name: "fixture",
              arguments: input,
              ...(route !== "unwritten"
                ? { _meta: { "claudecode/toolUseId": "native-id" } }
                : {}),
            }),
          );
          if (route !== "unwritten") {
            expect(response.isError).toBe(false);
            expect(received).toEqual([
              route === "metadata"
                ? { [TOOL_USE_ID_INPUT]: "caller value" }
                : { value: "fixture" },
            ]);
          } else {
            expect(response.isError).toBe(true);
            expect(received).toEqual([]);
            expect(yield* r.until("turn.finished")).toMatchObject({
              outcome: {
                status: "failed",
                disposition: "broken",
                failure: { reason: "protocol-error" },
              },
            });
            return;
          }
        }
        yield* Queue.offer(f.children[0]!.frames, result());
        yield* r.until("turn.finished");
      }),
    ));
}
