import { expect, test } from "bun:test";
import type {
  Options,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  Account,
  TurnLimit,
  type RuntimeEvent,
  type SessionPolicy,
} from "@neuve/runtime";
import { Effect, Exit, Layer, Queue, Scope, Stream } from "effect";
import { childEnvironment } from "../src/environment.ts";
import {
  openClaudeSession,
  type InternalSessionOptions,
} from "../src/session.ts";
import { ClaudeSdk } from "../src/services.ts";
import { assistant, result, textDelta, usage } from "./frames.ts";

const parsedAccount = Account.parse({
  name: "test",
  kind: "claude-subscription",
  runtime: "claude-code",
  credential: { kind: "claude-config-folder" },
});
if (parsedAccount.kind !== "claude-subscription") throw new Error("fixture");
const account = parsedAccount;
const policy: SessionPolicy = {
  systemPrompt: "test",
  tools: [],
  turnLimit: TurnLimit.parse(5),
  approvalPolicy: "allow",
  outputSchema: { type: "object" },
};

function fixture() {
  const sends: SDKUserMessage[] = [];
  const children: Array<{
    options: Options;
    frames: Queue.Queue<SDKMessage>;
    closed: boolean;
  }> = [];
  const opening = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  let holdSecond = false;
  const layer = Layer.succeed(ClaudeSdk, {
    prefixes: {
      usage: ["You've hit your"],
      organization: ["organization disallowed"],
    },
    open: (options) =>
      Effect.gen(function* () {
        const frames = yield* Queue.unbounded<SDKMessage>();
        const child = { options, frames, closed: false };
        children.push(child);
        const close = Effect.sync(() => {
          child.closed = true;
        }).pipe(Effect.andThen(Queue.shutdown(frames)));
        yield* Effect.addFinalizer(() => close);
        return {
          messages: Stream.fromQueue(frames),
          close,
          offer: (message: SDKUserMessage) =>
            Effect.sync(() => {
              expect(child.closed).toBe(false);
              sends.push(message);
            }),
          interrupt: Effect.die("Stop must close"),
          setModel: () => Effect.void,
          applyFlagSettings: () => Effect.void,
          initializationResult:
            children.length === 2 && holdSecond
              ? Effect.promise(() => {
                  opening.resolve();
                  return gate.promise;
                }).pipe(Effect.as({ account: {} }))
              : Effect.succeed({ account: {} }),
        };
      }),
  });
  return {
    layer,
    sends,
    children,
    opening,
    gate,
    hold: () => {
      holdSecond = true;
    },
  };
}
function run(
  body: (
    f: ReturnType<typeof fixture>,
    session: Effect.Success<ReturnType<typeof openClaudeSession>>,
    seen: RuntimeEvent[],
    next: () => Effect.Effect<RuntimeEvent>,
  ) => Effect.Effect<void, unknown, Scope.Scope>,
  sessionPolicy = policy,
  options: Partial<InternalSessionOptions> = {},
) {
  const f = fixture();
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* openClaudeSession(account, sessionPolicy, {
          cwd: "/test",
          executable: "/test/claude",
          environment: {},
          ...options,
        });
        const seen: RuntimeEvent[] = [];
        const events = yield* Queue.unbounded<RuntimeEvent>();
        yield* Stream.runForEach(session.events, (event) =>
          Effect.sync(() => {
            seen.push(event);
            Queue.offerUnsafe(events, event);
          }),
        ).pipe(Effect.forkScoped);
        const next = (): Effect.Effect<RuntimeEvent> =>
          Effect.gen(function* () {
            while (true) {
              const e = yield* Queue.take(events);
              if (e.type === "turn.finished") return e;
            }
          });
        yield* body(f, session, seen, next);
      }),
    ).pipe(Effect.provide(f.layer), Effect.timeout("2 seconds")),
  );
}

test("round 2 environment rejects independent credential and session names by prefix", () => {
  const names = [
    "CLAUDECODE",
    "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
    "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
    "CLAUDE_CODE_SESSION_ACCESS_TOKEN",
    "CLAUDE_CODE_HOST_CREDS_FILE",
    "CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH",
    "CLAUDE_CODE_OAUTH_SCOPES",
    "CLAUDE_CODE_API_BASE_URL",
    "ANTHROPIC_IDENTITY_TOKEN",
    "ANTHROPIC_CUSTOM_HEADERS",
    "CLAUDE_AGENT_SDK_MCP_NO_PREFIX",
    "USE_LOCAL_OAUTH",
    "USE_STAGING_OAUTH",
    "CLAUDE_CODE_FUTURE_TOKEN",
    "MCP_FUTURE",
    "AWS_BEARER_FUTURE",
    "ELECTRON_RUN_AS_NODE",
    "CLAUDE_AUTO_BACKGROUND_TASKS",
  ];
  const env = childEnvironment(
    {
      ...Object.fromEntries(names.map((name) => [name, "fixture"])),
      HOME: "/home",
      PATH: "/path",
      UNRELATED: "kept",
    },
    account,
  );
  const added = [
    "CLAUDE_CODE_DISABLE_AUTO_MEMORY",
    "CLAUDE_CODE_AUTO_CONNECT_IDE",
    "CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL",
    "CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS",
    "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS",
    "CLAUDE_AGENT_SDK_CLIENT_APP",
  ];
  expect(
    Object.keys(env)
      .filter((name) => /^(CLAUDE|ANTHROPIC_|MCP_|AWS_BEARER)/.test(name))
      .sort(),
  ).toEqual(added.sort());
  for (const name of names)
    if (!added.includes(name)) expect(env[name]).toBeUndefined();
  expect(env).toMatchObject({
    HOME: "/home",
    PATH: "/path",
    UNRELATED: "kept",
  });
});
for (const text of [
  "not logged in",
  "overloaded",
  "529",
  "You've hit your limit",
]) {
  test(`round 2 ordinary answer completes: ${text}`, () =>
    run((f, session, _, next) =>
      Effect.gen(function* () {
        yield* session.startTurn({ turnId: "one", message: "test" });
        yield* Queue.offer(f.children[0]!.frames, assistant(undefined, text));
        yield* Queue.offer(f.children[0]!.frames, result({ result: text }));
        expect(yield* next()).toMatchObject({
          outcome: { status: "completed" },
        });
      }),
    ));
}

test("round 2 close during gated reopen closes the child and never offers after shutdown", async () => {
  const f = fixture();
  f.hold();
  const seen: RuntimeEvent[] = [];
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const session = yield* openClaudeSession(account, policy, {
          cwd: "/test",
          executable: "/test/claude",
          environment: {},
        }).pipe(Effect.provideService(Scope.Scope, scope));

        const start = Effect.runPromise(
          session.startTurn({ turnId: "final", message: "final", final: true }),
        );
        yield* Effect.promise(() => f.opening.promise);
        yield* Scope.close(scope, Exit.void);
        f.gate.resolve();
        yield* Effect.promise(() => start.catch(() => undefined));
        seen.push(...(yield* Stream.runCollect(session.events)));
        expect(f.sends).toHaveLength(0);
        expect(f.children.every((child) => child.closed)).toBe(true);
        expect(seen.filter((e) => e.type === "turn.finished")).toMatchObject([
          { outcome: { status: "interrupted" } },
        ]);
      }),
    ).pipe(Effect.provide(f.layer), Effect.timeout("2 seconds")),
  );
});

for (const kind of ["result", "assistant", "partial"] as const) {
  test(`round 2 late steer ${kind} cannot finish the next turn`, () =>
    run((f, session, seen, next) =>
      Effect.gen(function* () {
        yield* session.startTurn({ turnId: "one", message: "first" });
        yield* session.steerTurn({ turnId: "one", message: "steer" });
        const first = f.sends[0]!.uuid!;
        const steer = f.sends[1]!.uuid!;
        yield* Queue.offer(
          f.children[0]!.frames,
          result({
            user_message_uuids: [first, steer],
            queued_turn_count: 0,
            modelUsage: { m: usage(10) },
          }),
        );
        yield* next();
        yield* session.startTurn({ turnId: "two", message: "second" });
        const late =
          kind === "result"
            ? result({ modelUsage: { m: usage(20) } })
            : kind === "assistant"
              ? assistant(undefined, "late")
              : textDelta("late");
        yield* Queue.offer(f.children[0]!.frames, {
          ...late,
          user_message_uuids: [steer],
        });
        expect(yield* next()).toMatchObject({
          turnId: "two",
          outcome: {
            status: "failed",
            disposition: "broken",
            failure: { reason: "protocol-error" },
          },
        });
        expect(
          seen.filter((e) => e.type === "text" && e.turnId === "two"),
        ).toHaveLength(0);
        expect(f.children[0]!.closed).toBe(true);
      }),
    ));
}

test("round 2 result with no open turn closes the session", () =>
  run((f, session, _, next) =>
    Effect.gen(function* () {
      yield* session.startTurn({ turnId: "one", message: "first" });
      yield* session.steerTurn({ turnId: "one", message: "steer" });
      yield* Queue.offer(f.children[0]!.frames, result());
      yield* next();
      yield* Queue.offer(f.children[0]!.frames, result());
      yield* Effect.yieldNow;
      expect(
        yield* session
          .startTurn({ turnId: "two", message: "second" })
          .pipe(Effect.flip),
      ).toMatchObject({ reason: "session-stopped" });
    }),
  ));

test("round 2 folded steer binds all sends and all usage to the open turn", () =>
  run((f, session, seen, next) =>
    Effect.gen(function* () {
      yield* session.startTurn({ turnId: "one", message: "first" });
      yield* session.steerTurn({ turnId: "one", message: "steer" });
      const stamps = f.sends.map((send) => send.uuid!);
      yield* Queue.offer(f.children[0]!.frames, {
        ...textDelta("folded"),
        user_message_uuids: stamps,
      });
      yield* Queue.offer(
        f.children[0]!.frames,
        result({ user_message_uuids: stamps, modelUsage: { m: usage(30) } }),
      );
      expect(yield* next()).toMatchObject({
        turnId: "one",
        outcome: { status: "completed" },
      });
      expect(seen.filter((e) => e.type === "usage")).toMatchObject([
        { turnId: "one", usage: { input: 30 } },
      ]);
    }),
  ));

test("round 2 steering after a result is refused without a send", () =>
  run((f, session, _, next) =>
    Effect.gen(function* () {
      yield* session.startTurn({ turnId: "one", message: "first" });
      yield* Queue.offer(f.children[0]!.frames, result());
      yield* next();
      expect(
        yield* session
          .steerTurn({ turnId: "one", message: "late" })
          .pipe(Effect.flip),
      ).toMatchObject({ reason: "previous-turn-active" });
      expect(f.sends).toHaveLength(1);
    }),
  ));

test("round 2 Stop closes queued work and next start resumes the same session", () =>
  run((f, session, seen, next) =>
    Effect.gen(function* () {
      yield* session.startTurn({ turnId: "one", message: "first" });
      yield* session.steerTurn({ turnId: "one", message: "queued" });
      const id = (yield* session.continuation).sessionId;
      yield* session.interruptTurn({ turnId: "one", reason: "stop" });
      expect(yield* next()).toMatchObject({
        outcome: { status: "interrupted", reason: "stop" },
      });
      expect(f.children[0]!.closed).toBe(true);
      yield* session.startTurn({ turnId: "two", message: "next" });
      expect(f.children[1]!.options.resume).toBe(id);
      yield* Queue.offer(f.children[1]!.frames, result());
      yield* next();
      expect(seen.filter((e) => e.type === "turn.finished")).toHaveLength(2);
    }),
  ));

for (const kind of ["assistant", "terminal"] as const)
  test(`round 2 unknown ${kind} failure maps to provider-failed`, () =>
    run((f, session, _, next) =>
      Effect.gen(function* () {
        yield* session.startTurn({ turnId: "one", message: "first" });
        const frame =
          kind === "assistant"
            ? { ...assistant(undefined), error: "future_error" }
            : { ...result(), terminal_reason: "future_reason" };
        // An IPC ingress deliberately exceeds the installed type's enum.
        yield* Queue.offer(f.children[0]!.frames, frame as SDKMessage);
        if (kind === "assistant")
          yield* Queue.offer(f.children[0]!.frames, result());
        expect(yield* next()).toMatchObject({
          outcome: {
            disposition: "reusable",
            failure: { reason: "provider-failed" },
          },
        });
      }),
    ));

// A resumed model can ask for a plugin tool that vanished from its current policy.
test.each(["SDK lookup", "permission callback"] as const)(
  "an unavailable Neuve tool returns an error and the turn completes after %s",
  (source) =>
    run((f, session, seen, next) =>
      Effect.gen(function* () {
        yield* session.startTurn({ turnId: "one", message: "Read my issue" });
        const child = f.children[0]!;
        expect(child.options.tools).toEqual([]);
        expect(child.options.allowedTools).not.toContain("ToolSearch");
        const sessionId = (yield* session.continuation).sessionId;
        const block = {
          type: "tool_use" as const,
          name: "mcp__neuve__linear_get_issue",
          id: "unavailable",
          input: { id: "fixture-issue" },
        };
        const call = assistant(undefined);
        call.session_id = sessionId;
        call.message.stop_reason = "tool_use";
        call.message.content = [block];
        const stream = (event: SDKPartialAssistantMessage["event"]) => ({
          ...textDelta(""),
          session_id: sessionId,
          event,
        });
        yield* Queue.offerAll(child.frames, [
          stream({
            type: "message_start",
            message: { ...call.message, content: [], stop_reason: null },
          }),
          stream({
            type: "content_block_start",
            index: 0,
            content_block: block,
          }),
          call,
          stream({ type: "content_block_stop", index: 0 }),
          stream({ type: "message_stop" }),
        ]);
        let error = `Error: No such tool available: ${block.name}`;
        if (source === "permission callback") {
          const permission = yield* Effect.promise(() =>
            child.options.canUseTool!(block.name, block.input, {
              signal: new AbortController().signal,
              toolUseID: block.id,
              requestId: "fixture",
            }),
          );
          expect(permission).toEqual({
            behavior: "deny",
            message: "This tool is not available now.",
          });
          if (permission?.behavior === "deny") error = permission.message;
        }
        const reply = assistant(undefined, "Linear is unavailable.");
        reply.message.id = "answer";
        yield* Queue.offerAll(child.frames, [
          {
            type: "user",
            parent_tool_use_id: null,
            session_id: sessionId,
            uuid: crypto.randomUUID(),
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: block.id,
                  is_error: true,
                  content: error,
                },
              ],
            },
          },
          stream({
            type: "message_start",
            message: { ...reply.message, content: [], stop_reason: null },
          }),
          stream({
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "", citations: [] },
          }),
          { ...textDelta("Linear is unavailable."), session_id: sessionId },
          { ...reply, session_id: sessionId },
          stream({ type: "content_block_stop", index: 0 }),
          stream({ type: "message_stop" }),
          result({ session_id: sessionId }),
        ]);
        expect(yield* next()).toMatchObject({
          outcome: { status: "completed" },
        });
        expect(child.closed).toBe(false);
        expect(seen.filter((event) => event.type === "text")).toMatchObject([
          { text: "Linear is unavailable." },
        ]);
        expect(
          seen.filter((event) => event.type === "message.finished"),
        ).toMatchObject([
          { messageId: call.message.id, stopReason: "tool-use", toolCalls: [] },
          {
            messageId: reply.message.id,
            stopReason: "end-turn",
            toolCalls: [],
          },
        ]);
        expect(
          seen.filter(
            (event) =>
              event.type === "tool.started" || event.type === "tool.finished",
          ),
        ).toEqual([]);
      }),
    ),
);

for (const kind of ["permission", "assistant", "partial"] as const)
  test(`round 2 foreign tool via ${kind} closes without mirrored tool events`, () =>
    run((f, session, seen, next) =>
      Effect.gen(function* () {
        yield* session.startTurn({ turnId: "one", message: "first" });
        if (kind === "permission") {
          const response = yield* Effect.promise(() =>
            f.children[0]!.options.canUseTool!(
              "Bash",
              {},
              {
                signal: new AbortController().signal,
                toolUseID: "foreign",
                requestId: "fixture",
              },
            ),
          );
          expect(response).toMatchObject({ behavior: "deny", interrupt: true });
        } else {
          const block = {
            type: "tool_use" as const,
            name: "Bash",
            id: "foreign",
            input: {},
          };
          const frame = assistant(undefined);
          frame.message.content = [block];
          yield* Queue.offer(
            f.children[0]!.frames,
            kind === "assistant"
              ? frame
              : {
                  ...textDelta(""),
                  event: {
                    type: "content_block_start" as const,
                    index: 0,
                    content_block: block,
                  },
                },
          );
        }
        expect(yield* next()).toMatchObject({
          outcome: {
            disposition: "broken",
            failure: { reason: "protocol-error" },
          },
        });
        expect(
          seen.some(
            (e) => e.type === "tool.started" || e.type === "tool.finished",
          ),
        ).toBe(false);
      }),
    ));

test("round 2 StructuredOutput is allowed only in a final turn and never mirrored", () =>
  run((f, session, seen, next) =>
    Effect.gen(function* () {
      yield* session.startTurn({
        turnId: "one",
        message: "final",
        final: true,
      });
      const response = yield* Effect.promise(() =>
        f.children[1]!.options.canUseTool!(
          "StructuredOutput",
          { value: "ok" },
          {
            signal: new AbortController().signal,
            toolUseID: "structured",
            requestId: "fixture",
          },
        ),
      );
      expect(response).toMatchObject({ behavior: "allow" });
      const frame = assistant(undefined);
      frame.message.content = [
        {
          type: "tool_use",
          name: "StructuredOutput",
          id: "structured",
          input: {},
        },
      ];
      yield* Queue.offer(f.children[1]!.frames, frame);
      yield* Queue.offer(
        f.children[1]!.frames,
        result({ structured_output: {} }),
      );
      expect(yield* next()).toMatchObject({ outcome: { status: "completed" } });
      expect(
        seen.some(
          (e) => e.type === "tool.started" || e.type === "approval.requested",
        ),
      ).toBe(false);
    }),
  ));

test("round 2 resumed held results are user text delivered once", () =>
  run(
    (f, session, _, next) =>
      Effect.gen(function* () {
        yield* session.startTurn({ turnId: "one", message: "continue" });
        expect(f.sends[0]!.message.content).toBe(
          "The read tool already ran; do not call it again. Its result was: fixture result\ncontinue",
        );
        yield* Queue.offer(f.children[0]!.frames, result());
        yield* next();
        yield* session.startTurn({ turnId: "two", message: "next" });
        expect(f.sends[1]!.message.content).toBe("next");
        yield* Queue.offer(f.children[0]!.frames, result());
        yield* next();
      }),
    policy,
    {
      identity: { resume: "fixture-session" },
      usageBaseline: new Map(),
      heldResults: [{ toolName: "read", text: "fixture result" }],
    },
  ));

const readTool = {
  name: "read",
  description: "read",
  inputSchema: { type: "object" },
  hints: {
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: false,
  },
  handle: () => Effect.succeed({ text: "fixture" }),
};

test("round 2 descriptions over 4096 fail at open with the tool name before SDK use", async () => {
  const f = fixture();
  const error = await Effect.runPromise(
    Effect.scoped(
      openClaudeSession(
        account,
        { ...policy, tools: [{ ...readTool, description: "x".repeat(4097) }] },
        { cwd: "/test", executable: "/test/claude", environment: {} },
      ).pipe(Effect.flip),
    ).pipe(Effect.provide(f.layer)),
  );
  expect(error).toMatchObject({
    _tag: "TurnFailed",
    reason: "protocol-error",
    toolName: "read",
  });
  expect(error.message).toContain("read");
  expect(f.children).toHaveLength(0);
});

test("round 2 description at 4096 is accepted", () =>
  run(
    (f, session, _, next) =>
      Effect.gen(function* () {
        yield* session.startTurn({ turnId: "one", message: "test" });
        yield* Queue.offer(f.children[0]!.frames, result());
        expect(yield* next()).toMatchObject({
          outcome: { status: "completed" },
        });
      }),
    { ...policy, tools: [{ ...readTool, description: "x".repeat(4096) }] },
  ));

test("round 2 non-JSON permission input produces a typed failure and denial", () =>
  run(
    (f, session, _, next) =>
      Effect.gen(function* () {
        yield* session.startTurn({ turnId: "one", message: "test" });
        const response = yield* Effect.promise(() =>
          f.children[0]!.options.canUseTool!(
            "mcp__neuve__read",
            { invalid: () => {} },
            {
              signal: new AbortController().signal,
              toolUseID: "fixture",
              requestId: "fixture",
            },
          ),
        );
        expect(response).toMatchObject({ behavior: "deny", interrupt: true });
        expect(yield* next()).toMatchObject({
          outcome: { status: "failed", failure: { reason: "protocol-error" } },
        });
      }),
    { ...policy, tools: [readTool], approvalPolicy: "ask" },
  ));

test.each(["a deferred Neuve tool", "a native MCP tool"] as const)(
  "Claude Code can search for %s",
  (target) =>
    run(
      (f, session, _, next) =>
        Effect.gen(function* () {
          yield* session.startTurn({ turnId: "one", message: "Find an issue" });
          const child = f.children[0]!;
          expect(child.options.tools).toEqual(["ToolSearch"]);
          expect(child.options.allowedTools).toContain("ToolSearch");
          expect(child.options.env?.ENABLE_TOOL_SEARCH).toBe("true");
          const input = {
            query:
              target === "a native MCP tool"
                ? "select:mcp__chrome-devtools__take_screenshot"
                : "select:mcp__neuve__linear_get_issue",
          };
          const permission = yield* Effect.promise(() =>
            child.options.canUseTool!("ToolSearch", input, {
              signal: new AbortController().signal,
              toolUseID: "search",
              requestId: "fixture",
            }),
          );
          expect(permission).toEqual({
            behavior: "allow",
            updatedInput: input,
          });
          const sessionId = (yield* session.continuation).sessionId;
          const toolUse = assistant(undefined);
          toolUse.session_id = sessionId;
          toolUse.message.stop_reason = "tool_use";
          toolUse.message.content = [
            { type: "tool_use", name: "ToolSearch", id: "search", input },
          ];
          yield* Queue.offerAll(child.frames, [
            toolUse,
            {
              type: "user",
              parent_tool_use_id: null,
              session_id: sessionId,
              uuid: crypto.randomUUID(),
              message: {
                role: "user",
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: "search",
                    content: "Found the tool.",
                  },
                ],
              },
            },
            result({ session_id: sessionId }),
          ]);
          expect(yield* next()).toMatchObject({
            outcome: { status: "completed" },
          });
        }),
      {
        ...policy,
        outputSchema: undefined,
        ...(target === "a native MCP tool"
          ? {
              mcpServers: {
                "chrome-devtools": { type: "stdio" as const, command: "npx" },
              },
            }
          : {
              tools: [
                {
                  name: "linear_get_issue",
                  description: "Read a Linear issue.",
                  inputSchema: { type: "object" },
                  deferred: true,
                  hints: {
                    readOnly: true,
                    destructive: false,
                    idempotent: true,
                    openWorld: false,
                  },
                  handle: () => Effect.succeed({ text: "fixture" }),
                },
              ],
            }),
      },
      {
        environment: {
          ENABLE_TOOL_SEARCH: "false",
          ANTHROPIC_BASE_URL: "https://proxy.invalid",
        },
      },
    ),
);
