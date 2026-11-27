// The fake checks what crosses the Codex connection and what the session reports to its caller.
import { describe, expect, test } from "bun:test";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
  AccountRejected,
  AccountName,
  RuntimeEvent,
  SignInRequired,
  TurnLimit,
  type RuntimeSession,
  type SessionPolicy,
  type SessionStart,
} from "@neuve/runtime";
import { Effect, Exit, Fiber, Logger, Queue, Scope, Stream } from "effect";
import { launchArguments, turnSettings } from "../src/launch.ts";
import type { LogEntry } from "../src/log.ts";
import { openCodexSession, type CodexSignInCheck } from "../src/session.ts";
import {
  codex,
  completed,
  OWN,
  OWN_EXCLUDE,
  SILENT,
  type Process,
} from "./codex-fake.ts";

const account = AccountName.parse("codex");
const policy: SessionPolicy = {
  systemPrompt: "fixture",
  tools: [],
  approvalPolicy: "allow",
  turnLimit: TurnLimit.parse(8),
};
/** A session that serves one of Neuve's tools, and so holds a token (these bind a local port). */
const withTool: SessionPolicy = {
  ...policy,
  tools: [
    {
      name: "t",
      description: "t",
      inputSchema: { type: "object" },
      hints: {
        readOnly: true,
        destructive: false,
        idempotent: true,
        openWorld: false,
      },
      handle: () => Effect.succeed({ text: "" }),
    },
  ],
};
const write = { folder: "/work", access: "write" } as const;
const readOnly = { folder: "/work", access: "read-only" } as const;

/** Every event is a valid contract event, and each started turn ends exactly once. */
const reader = (session: RuntimeSession) =>
  Effect.gen(function* () {
    const events: RuntimeEvent[] = [];
    const queue = yield* Queue.unbounded<RuntimeEvent>();
    let ended = false;
    const fiber = yield* Stream.runForEach(session.events, (event) =>
      Effect.sync(() => {
        RuntimeEvent.parse(event);
        events.push(event);
        Queue.offerUnsafe(queue, event);
      }),
    ).pipe(
      Effect.ensuring(Effect.sync(() => (ended = true))),
      Effect.forkDetach,
    );
    const next = (type: RuntimeEvent["type"]) =>
      Effect.gen(function* () {
        while (true) {
          const event = yield* Queue.take(queue);
          if (event.type === type) return event;
        }
      });
    return {
      events,
      next,
      ended: () => ended,
      done: Fiber.await(fiber),
      finished: () => events.filter((e) => e.type === "turn.finished"),
    };
  });

const until = (check: () => boolean) =>
  Effect.gen(function* () {
    while (!check()) yield* Effect.sleep("1 millis");
  });
const written = (process: Process, method: string) =>
  process.io.written.filter((m) => m.method === method);

function run(
  fake: ReturnType<typeof codex>,
  body: (
    session: RuntimeSession,
    read: Effect.Success<ReturnType<typeof reader>>,
    scope: Scope.Closeable,
  ) => Effect.Effect<void, unknown>,
  overrides: {
    policy?: SessionPolicy;
    start?: SessionStart;
    stopWait?: `${number} millis`;
    broken?: ReadonlyArray<string>;
    log?: (entry: LogEntry) => void;
    checkSignIn?: CodexSignInCheck;
  } = {},
) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const session = yield* openCodexSession({
        account,
        program: "/test/codex",
        codexHome:
          overrides.checkSignIn === undefined ? undefined : "/neuve/codex",
        cwd: "/work",
        // An inherited Codex home must not reach Codex: the account names its own, or none.
        environment: {
          HOME: "/home",
          OPENAI_API_KEY: "sk-should-go",
          CODEX_HOME: "/inherited-home",
        },
        policy: overrides.policy ?? policy,
        start: overrides.start ?? { kind: "new" },
        interruptWait: "50 millis",
        stopWait: overrides.stopWait ?? "10 millis",
        broken: overrides.broken,
        log: overrides.log,
        neuveSignIn:
          overrides.checkSignIn === undefined
            ? undefined
            : {
                checkSignIn: overrides.checkSignIn,
                tokenCommand: ["/neuve/bin/neuve", "auth", "lease", account],
              },
      }).pipe(Scope.provide(scope));
      const read = yield* reader(session);
      yield* body(session, read, scope).pipe(
        Effect.ensuring(Scope.close(scope, Exit.void)),
      );
    }).pipe(Effect.provide(fake.layer), Effect.timeout("3 seconds")),
  );
}

const startOn = (
  fake: ReturnType<typeof codex>,
  session: RuntimeSession,
  workspace: { folder: string; access: "write" | "read-only" } = write,
) =>
  Effect.gen(function* () {
    yield* session.startTurn({ turnId: "turn", message: "go", workspace });
    yield* until(() => written(fake.current(), "turn/start").length > 0);
  });

// A sign-in that expires after session open must be checked before Codex starts the next turn.
test("an expired Neuve sign-in refuses a turn before it starts", async () => {
  const fake = codex();
  const hint = {
    kind: "command",
    command: "neuve auth login",
    account,
  } as const;
  const expired = new AccountRejected({ account, hint, reason: "expired" });
  let usable = true;
  await run(
    fake,
    (session, read) =>
      Effect.gen(function* () {
        usable = false;
        yield* session.startTurn({
          turnId: "turn",
          message: "go",
          workspace: readOnly,
        });
        expect(yield* read.next("turn.finished")).toMatchObject({
          outcome: {
            status: "failed",
            disposition: "reusable",
            failure: {
              _tag: "AccountRejected",
              account,
              hint,
              reason: "expired",
            },
          },
        });
        expect(written(fake.current(), "turn/start")).toHaveLength(0);
      }),
    {
      checkSignIn: () =>
        Effect.suspend(() =>
          usable ? Effect.succeed("stored-token") : Effect.fail(expired),
        ),
    },
  );
});

const unauthorized = completed("failed", {
  message: "Unauthorized",
  codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } },
});

test("a new session on the same account uses the renewed sign-in", async () => {
  const fake = codex();
  let token = "stored-token";
  const checkSignIn: CodexSignInCheck = (rejected) =>
    Effect.sync(() => {
      if (rejected === token) token = "renewed-token";
      return token;
    });
  await run(
    fake,
    (session, read) =>
      Effect.gen(function* () {
        yield* startOn(fake, session, readOnly);
        const process = fake.current();
        expect(
          JSON.stringify({ args: process.args, env: process.env }),
        ).not.toContain(token);
        fake.send("error", {
          threadId: "thread-1",
          turnId: "codex-turn",
          willRetry: true,
          error: {
            message: "Reconnecting",
            codexErrorInfo: {
              responseStreamDisconnected: { httpStatusCode: 401 },
            },
          },
        });
        expect(yield* read.next("retry")).toMatchObject({
          turnId: "turn",
          attempt: 1,
        });
        fake.send("turn/completed", unauthorized);
        expect(yield* read.next("turn.finished")).toMatchObject({
          outcome: {
            status: "failed",
            disposition: "reusable",
            failure: {
              _tag: "TurnFailed",
              account,
              reason: "provider-failed",
            },
          },
        });
        expect(fake.current()).toBe(process);
      }),
    { checkSignIn },
  );

  const next = codex();
  await run(
    next,
    (session, read) =>
      Effect.gen(function* () {
        expect(token === "renewed-token").toBe(true);
        yield* startOn(next, session, readOnly);
        next.send("turn/completed", completed("completed"));
        expect(yield* read.next("turn.finished")).toMatchObject({
          outcome: { status: "completed" },
        });
      }),
    { checkSignIn },
  );
});

test("a 401 reply to turn/start renews Neuve sign-in and ends the turn as provider-failed", async () => {
  const fake = codex((message, process) => {
    if (message.method !== "turn/start") return;
    queueMicrotask(() =>
      process.io.send({
        id: message.id,
        error: { code: 401, message: "Unauthorized" },
      }),
    );
    return SILENT;
  });
  let token = "stored-token";
  await run(
    fake,
    (session, read) =>
      Effect.gen(function* () {
        yield* startOn(fake, session, readOnly);
        expect(yield* read.next("turn.finished")).toMatchObject({
          outcome: {
            status: "failed",
            disposition: "reusable",
            failure: { _tag: "TurnFailed", account, reason: "provider-failed" },
          },
        });
        expect(token === "renewed-token").toBe(true);
      }),
    {
      checkSignIn: (rejected) =>
        Effect.sync(() => {
          if (rejected === token) token = "renewed-token";
          return token;
        }),
    },
  );
});

test("a refused renewal leaves the failed turn reusable and the next check asks for sign-in", async () => {
  const fake = codex();
  const hint = {
    kind: "command",
    command: "neuve auth login",
    account,
  } as const;
  let signedIn = true;
  await run(
    fake,
    (session, read) =>
      Effect.gen(function* () {
        yield* startOn(fake, session, readOnly);
        fake.send("turn/completed", unauthorized);
        expect(yield* read.next("turn.finished")).toMatchObject({
          outcome: {
            status: "failed",
            disposition: "reusable",
            failure: { _tag: "TurnFailed", account, reason: "provider-failed" },
          },
        });
        yield* session.startTurn({
          turnId: "next",
          message: "continue",
          workspace: readOnly,
        });
        expect(yield* read.next("turn.finished")).toMatchObject({
          turnId: "next",
          outcome: {
            status: "failed",
            disposition: "reusable",
            failure: { _tag: "SignInRequired", account, hint },
          },
        });
        expect(written(fake.current(), "turn/start")).toHaveLength(1);
      }),
    {
      checkSignIn: (rejected) =>
        Effect.suspend((): ReturnType<CodexSignInCheck> => {
          if (!signedIn)
            return Effect.fail(new SignInRequired({ account, hint }));
          if (rejected !== "stored-token")
            return Effect.succeed("stored-token");
          signedIn = false;
          return Effect.fail(
            new AccountRejected({ account, hint, reason: "other" }),
          );
        }),
    },
  );
});

// Why: the contract's central promise is one terminal event per started turn. Each row is one way
// a Codex turn ends, from the turn-endings table in PROTOCOL.md, with the outcome it must give and
// whether the session goes on.
describe("each way a turn ends gives exactly one terminal event", () => {
  test("completion, with Codex's own work and usage on the way", async () => {
    const fake = codex();
    await run(fake, (session, read) =>
      Effect.gen(function* () {
        yield* startOn(fake, session);
        fake.send("item/agentMessage/delta", {
          threadId: "thread-1",
          turnId: "codex-turn",
          itemId: "m1",
          delta: "Hello",
        });
        fake.send("item/completed", {
          threadId: "thread-1",
          turnId: "codex-turn",
          completedAtMs: 0,
          item: {
            type: "commandExecution",
            id: "c1",
            command: "ls",
            cwd: "/work",
            status: "failed",
            aggregatedOutput: "denied",
            exitCode: 1,
            durationMs: 5,
          },
        });
        fake.send("item/completed", {
          threadId: "thread-1",
          turnId: "codex-turn",
          completedAtMs: 0,
          item: {
            type: "fileChange",
            id: "f1",
            status: "completed",
            changes: [{ path: "/work/a", kind: { type: "add" }, diff: "+a" }],
          },
        });
        const breakdown = (input: number, cached: number, output: number) => ({
          totalTokens: input + output,
          inputTokens: input,
          cachedInputTokens: cached,
          cacheWriteInputTokens: 0,
          outputTokens: output,
          reasoningOutputTokens: 1,
        });
        // A resumed thread's totals start where its earlier turns left them.
        fake.send("thread/tokenUsage/updated", {
          threadId: "thread-1",
          turnId: "codex-turn",
          tokenUsage: {
            total: breakdown(1100, 600, 120),
            last: breakdown(100, 60, 20),
            modelContextWindow: 400000,
          },
        });
        fake.send("item/completed", {
          threadId: "thread-1",
          turnId: "codex-turn",
          completedAtMs: 0,
          item: {
            type: "agentMessage",
            id: "m1",
            text: "Hello",
            phase: "final_answer",
          },
        });
        fake.send("turn/completed", completed("completed"));
        const end = yield* read.next("turn.finished");
        expect(end).toMatchObject({
          outcome: { status: "completed" },
          resumePoint: "codex-turn",
        });
        const types = read.events.map((e) => e.type);
        expect(types).toEqual([
          "turn.started",
          "text",
          "work.started",
          "work.finished",
          "work.started",
          "work.finished",
          "usage",
          "message.finished",
          "turn.finished",
        ]);
        expect(read.events[3]).toMatchObject({
          kind: "command",
          workId: "c1",
          errored: true,
          output: "denied",
        });
        expect(read.events[5]).toMatchObject({
          kind: "file-change",
          errored: false,
        });
        expect(read.events[6]).toMatchObject({
          scope: "turn",
          contextWindow: 400000,
          contextTokens: 120,
          usage: { input: 40, cacheRead: 60, output: 20, thinking: 1 },
          costUsd: null,
        });
        expect(read.ended()).toBe(false);
      }),
    );
  });

  // Seen live: Codex completes no item for a command an interrupt cut short.
  test("an interrupted command reports a stopped result without an item completion", async () => {
    const fake = codex((message, process) => {
      if (message.method === "turn/interrupt")
        queueMicrotask(() =>
          process.io.send({
            method: "turn/completed",
            params: completed("interrupted"),
          }),
        );
      return undefined;
    });
    await run(fake, (session, read) =>
      Effect.gen(function* () {
        yield* startOn(fake, session);
        fake.send("item/started", {
          threadId: "thread-1",
          turnId: "codex-turn",
          item: {
            type: "commandExecution",
            id: "c1",
            command: "sleep 120",
            cwd: "/work",
            status: "inProgress",
            aggregatedOutput: null,
            exitCode: null,
            durationMs: null,
          },
        });
        expect(yield* read.next("work.started")).toMatchObject({
          workId: "c1",
          kind: "command",
          input: { command: "sleep 120" },
        });
        yield* session.interruptTurn({ turnId: "turn" });
        yield* read.next("turn.finished");
        expect(read.events.map((e) => e.type)).toEqual([
          "turn.started",
          "work.started",
          "work.finished",
          "turn.finished",
        ]);
        expect(read.events[2]).toMatchObject({
          workId: "c1",
          kind: "command",
          errored: true,
          output: "Stopped.",
          input: { command: "sleep 120" },
        });
      }),
    );
  });

  test("an interrupt Codex honours", async () => {
    const fake = codex((message, process) => {
      if (message.method === "turn/interrupt")
        queueMicrotask(() =>
          process.io.send({
            method: "turn/completed",
            params: completed("interrupted"),
          }),
        );
      return undefined;
    });
    await run(fake, (session, read) =>
      Effect.gen(function* () {
        yield* startOn(fake, session);
        yield* session.interruptTurn({ turnId: "turn", reason: "stop" });
        expect(yield* read.next("turn.finished")).toMatchObject({
          outcome: { status: "interrupted", reason: "stop" },
        });
        yield* Effect.sleep("80 millis");
        expect(read.finished()).toHaveLength(1);
        expect(read.ended()).toBe(false);
      }),
    );
  });

  test("an interrupt Codex does not honour: the turn ends interrupted and the process is stopped", async () => {
    const fake = codex();
    await run(fake, (session, read) =>
      Effect.gen(function* () {
        yield* startOn(fake, session);
        yield* session.interruptTurn({ turnId: "turn", reason: "stop" });
        expect(yield* read.next("turn.finished")).toMatchObject({
          outcome: { status: "interrupted", reason: "stop" },
        });
        yield* read.done;
        yield* until(() => fake.current().io.exited());
        // The death the stop causes is no second ending.
        expect(read.finished()).toHaveLength(1);
      }),
    );
  });

  test("an interrupt before Codex has named the turn is sent once it has", async () => {
    let answer: (() => void) | undefined;
    const fake = codex((message, process) => {
      if (message.method === "turn/start") {
        answer = () =>
          process.io.send({
            id: message.id,
            result: { turn: { id: "codex-turn" } },
          });
        return SILENT;
      }
      if (message.method === "turn/interrupt")
        queueMicrotask(() =>
          process.io.send({
            method: "turn/completed",
            params: completed("interrupted"),
          }),
        );
      return undefined;
    });
    await run(fake, (session, read) =>
      Effect.gen(function* () {
        const started = yield* session
          .startTurn({ turnId: "turn", message: "go", workspace: write })
          .pipe(Effect.forkDetach);
        yield* until(() => answer !== undefined);
        yield* session.interruptTurn({ turnId: "turn" });
        expect(written(fake.current(), "turn/interrupt")).toHaveLength(0);
        answer!();
        yield* Fiber.join(started);
        expect(yield* read.next("turn.finished")).toMatchObject({
          outcome: { status: "interrupted" },
        });
        expect(written(fake.current(), "turn/interrupt")).toHaveLength(1);
      }),
    );
  });

  test("process death: failed and broken, then the stream ends", async () => {
    const fake = codex();
    await run(fake, (session, read) =>
      Effect.gen(function* () {
        yield* startOn(fake, session);
        fake.current().io.exit({ exitCode: 1 });
        expect(yield* read.next("turn.finished")).toMatchObject({
          outcome: {
            status: "failed",
            disposition: "broken",
            failure: { _tag: "TurnFailed", reason: "provider-failed" },
          },
        });
        yield* read.done;
        expect(read.finished()).toHaveLength(1);
        expect(
          yield* Effect.flip(
            session.startTurn({
              turnId: "next",
              message: "go",
              workspace: write,
            }),
          ),
        ).toMatchObject({ reason: "session-stopped" });
      }),
    );
  });

  // Two sources of one ending: the death, and the turn/start it leaves unanswered.
  test("process death while turn/start waits for its answer: still one ending", async () => {
    const fake = codex((message) =>
      message.method === "turn/start" ? SILENT : undefined,
    );
    await run(fake, (session, read) =>
      Effect.gen(function* () {
        const started = yield* session
          .startTurn({ turnId: "turn", message: "go", workspace: write })
          .pipe(Effect.forkDetach);
        yield* until(() => written(fake.current(), "turn/start").length > 0);
        fake.current().io.exit({ exitCode: 1 });
        yield* Fiber.join(started);
        yield* read.done;
        expect(read.finished()).toHaveLength(1);
        expect(read.finished()[0]).toMatchObject({
          outcome: { status: "failed", disposition: "broken" },
        });
      }),
    );
  });

  test("scope closure: interrupted, then the stream ends and Codex is stopped", async () => {
    const fake = codex();
    await run(fake, (session, read, scope) =>
      Effect.gen(function* () {
        yield* startOn(fake, session);
        yield* Scope.close(scope, Exit.void);
        yield* read.done;
        expect(read.finished()).toEqual([
          expect.objectContaining({
            outcome: { status: "interrupted", reason: "shutdown" },
          }),
        ]);
        expect(fake.current().io.exited()).toBe(true);
      }),
    );
  });

  test("sign-in required: Codex's login is gone, and the hint is codex login", async () => {
    const fake = codex();
    await run(fake, (session, read) =>
      Effect.gen(function* () {
        yield* startOn(fake, session);
        fake.send("error", {
          threadId: "thread-1",
          turnId: "codex-turn",
          willRetry: false,
          error: {
            message: "401",
            codexErrorInfo: "unauthorized",
            additionalDetails: null,
          },
        });
        fake.send("turn/completed", completed("failed", null));
        expect(yield* read.next("turn.finished")).toMatchObject({
          outcome: {
            status: "failed",
            disposition: "reusable",
            failure: {
              _tag: "SignInRequired",
              hint: { kind: "command", command: "codex login" },
            },
          },
        });
        expect(read.finished()).toHaveLength(1);
      }),
    );
  });

  test("usage limit: the account's limit, with the window Codex reported", async () => {
    const fake = codex();
    await run(fake, (session, read) =>
      Effect.gen(function* () {
        yield* startOn(fake, session);
        fake.send("account/rateLimits/updated", {
          rateLimits: {
            limitId: null,
            limitName: null,
            primary: {
              usedPercent: 100,
              windowDurationMins: 300,
              resetsAt: 1_800_000_000,
            },
            secondary: {
              usedPercent: 40,
              windowDurationMins: 10080,
              resetsAt: null,
            },
            rateLimitReachedType: "primary",
          },
        });
        fake.send(
          "turn/completed",
          completed("failed", {
            message: "limit",
            codexErrorInfo: "usageLimitExceeded",
            additionalDetails: null,
          }),
        );
        expect(yield* read.next("turn.finished")).toMatchObject({
          outcome: {
            status: "failed",
            disposition: "reusable",
            failure: {
              _tag: "UsageLimitReached",
              window: "five-hour",
              status: "rejected",
              utilization: 1,
            },
          },
        });
        expect(read.events.filter((e) => e.type === "rate-limit")).toHaveLength(
          2,
        );
      }),
    );
  });

  test("a turn/completed that does not decode is a protocol error, not a hang", async () => {
    const fake = codex();
    await run(fake, (session, read) =>
      Effect.gen(function* () {
        yield* startOn(fake, session);
        fake.send("turn/completed", { threadId: "thread-1", turn: { id: 7 } });
        expect(yield* read.next("turn.finished")).toMatchObject({
          outcome: {
            status: "failed",
            failure: { reason: "protocol-error" },
            disposition: "broken",
          },
        });
        yield* read.done;
      }),
    );
  });

  test("a final turn: structured output from the last message, or the reason there is none", async () => {
    for (const [text, outcome] of [
      ['{"ok":true}', { status: "completed", structuredOutput: { ok: true } }],
      [
        "not json",
        { status: "failed", failure: { reason: "structured-output-invalid" } },
      ],
      [
        undefined,
        { status: "failed", failure: { reason: "structured-output-missing" } },
      ],
    ] as const) {
      const fake = codex();
      await run(
        fake,
        (session, read) =>
          Effect.gen(function* () {
            yield* session.startTurn({
              turnId: "turn",
              message: "go",
              workspace: write,
              final: true,
            });
            yield* until(
              () => written(fake.current(), "turn/start").length > 0,
            );
            expect(
              written(fake.current(), "turn/start")[0]!.params,
            ).toMatchObject({
              outputSchema: { type: "object" },
            });
            if (text !== undefined)
              fake.send("item/completed", {
                threadId: "thread-1",
                turnId: "codex-turn",
                completedAtMs: 0,
                item: {
                  type: "agentMessage",
                  id: "m",
                  text,
                  phase: "final_answer",
                },
              });
            fake.send("turn/completed", completed("completed"));
            expect(yield* read.next("turn.finished")).toMatchObject({
              outcome,
            });
          }),
        { policy: { ...policy, outputSchema: { type: "object" } } },
      );
    }
  });
});

// Why: what Codex may do in a turn is set by the folder and access the turn carries; a read-only
// turn must run with none of the person's own additions on, which takes its own process.
describe("the mode table", () => {
  test("a read-only turn runs clean; a write turn restarts on the person's Codex and resumes the thread", async () => {
    const fake = codex();
    await run(fake, (session, read) =>
      Effect.gen(function* () {
        // Opening: one process to read the person's names, then a clean one.
        expect(fake.processes).toHaveLength(2);
        const clean = fake.current();
        expect(clean.args).toContain("mcp_servers.own-server.enabled=false");
        expect(clean.args).toContain("plugins.own-plugin.enabled=false");
        expect(clean.args).toContain("apps.own-app.enabled=false");
        expect(clean.args.join(" ")).toContain(
          '{path="/home/.codex/skills/own-skill/SKILL.md",enabled=false}',
        );
        yield* startOn(fake, session, readOnly);
        expect(fake.processes).toHaveLength(2);
        expect(written(clean, "turn/start")[0]!.params).toMatchObject({
          cwd: "/work",
          sandboxPolicy: { type: "readOnly", networkAccess: false },
          approvalPolicy: "never",
        });
        fake.send("turn/completed", completed("completed"));
        yield* read.next("turn.finished");
        yield* startOn(fake, session, write);
        expect(fake.processes).toHaveLength(3);
        const own = fake.current();
        expect(own.clean).toBe(false);
        expect(clean.io.exited()).toBe(true);
        expect(written(own, "thread/resume")[0]!.params).toMatchObject({
          threadId: "thread-1",
          developerInstructions: "fixture",
        });
        expect(written(own, "turn/start")[0]!.params).toMatchObject({
          sandboxPolicy: {
            type: "workspaceWrite",
            writableRoots: ["/work"],
            networkAccess: false,
            excludeTmpdirEnvVar: true,
            excludeSlashTmp: true,
          },
        });
        expect(session.nativeSessionId).toBe("thread-1");
        expect(read.finished()).toHaveLength(1);
      }),
    );
  });

  test("the carried stdio server starts in the write process with the chat folder and a distinct name", async () => {
    const fake = codex();
    const server = {
      type: "stdio",
      command: "npx",
      args: ["--autoConnect"],
    } as const;
    const scoped = {
      ...policy,
      mcpServers: { "chrome-devtools": { ...server, args: [...server.args] } },
    };
    await run(
      fake,
      (session, read) =>
        Effect.gen(function* () {
          expect(
            fake.processes.every(
              ({ args }) =>
                !args.some((arg) => arg.includes("neuve_chrome_devtools")),
            ),
          ).toBe(true);
          yield* startOn(fake, session, write);
          expect(fake.current().args).toContain(
            'mcp_servers.neuve_chrome_devtools.command="npx"',
          );
          expect(fake.current().args).toContain(
            'mcp_servers.neuve_chrome_devtools.args=["--autoConnect","--workspace=/work"]',
          );
          expect(fake.current().args).toContain(
            'mcp_servers.neuve_chrome_devtools.default_tools_approval_mode="approve"',
          );
          expect(fake.current().args).not.toContain(
            "mcp_servers.chrome_devtools.enabled=false",
          );
          fake.send("turn/completed", completed("completed"));
          yield* read.next("turn.finished");
          yield* startOn(fake, session, readOnly);
          expect(
            fake
              .current()
              .args.some((arg) => arg.includes("neuve_chrome_devtools")),
          ).toBe(false);
        }),
      { policy: scoped },
    );
    const personal = {
      mcpServers: ["chrome_devtools", "neuve_chrome_devtools"],
      plugins: [],
      apps: [],
      exclude: [],
      skills: [],
    };
    const launch = (folder: string) =>
      launchArguments("own", personal, undefined, undefined, undefined, {
        folder,
        mcpServers: scoped.mcpServers,
      });
    expect(
      launch("/work/chat lane").filter((arg) => arg.startsWith("mcp_servers.")),
    ).toEqual([
      'mcp_servers.neuve_chrome_devtools_2.command="npx"',
      'mcp_servers.neuve_chrome_devtools_2.args=["--autoConnect","--workspace=/work/chat lane"]',
      'mcp_servers.neuve_chrome_devtools_2.default_tools_approval_mode="approve"',
    ]);
    expect(launch("/").some((arg) => arg.startsWith("mcp_servers."))).toBe(
      false,
    );
  });

  test("a turn without its folder and access is refused before it starts", async () => {
    const fake = codex();
    await run(fake, (session, read) =>
      Effect.gen(function* () {
        expect(
          yield* Effect.flip(
            session.startTurn({ turnId: "turn", message: "go" }),
          ),
        ).toMatchObject({ _tag: "TurnFailed", reason: "protocol-error" });
        expect(read.events).toHaveLength(0);
      }),
    );
  });

  test("a setting that cannot be switched off refuses read-only turns, and only them", async () => {
    const fake = codex((message) =>
      message.method === "config/read"
        ? { config: { mcp_servers: { "dotted.name": { enabled: true } } } }
        : undefined,
    );
    await run(fake, (session, read) =>
      Effect.gen(function* () {
        // The session opened on the person's own Codex, never on a clean one with that setting on.
        expect(fake.processes.map((p) => p.clean)).toEqual([true, false]);
        yield* session.startTurn({
          turnId: "turn",
          message: "go",
          workspace: readOnly,
        });
        expect(yield* read.next("turn.finished")).toMatchObject({
          outcome: {
            status: "failed",
            disposition: "reusable",
            failure: { _tag: "RuntimeUnavailable", reason: "start-failed" },
          },
        });
        expect(written(fake.current(), "turn/start")).toHaveLength(0);
        yield* session.startTurn({
          turnId: "next",
          message: "go",
          workspace: write,
        });
        yield* until(() => written(fake.current(), "turn/start").length > 0);
        // One process at a time: the refusal closed the person's Codex and read their settings
        // again, so the write turn runs on a new one, and no clean process ever got a turn.
        expect(fake.processes.map((p) => p.clean)).toEqual([
          true,
          false,
          true,
          false,
        ]);
        expect(
          fake.processes.map((p) => written(p, "turn/start").length),
        ).toEqual([0, 0, 0, 1]);
      }),
    );
  });

  // The probe that reads the person's own exclude list must not set it, or it reads back its own
  // flag and the person's list is lost (the reviewer's finding; the fake answers from the flags).
  test("the token is in Codex's environment only, never on its command line; OpenAI's key is removed", async () => {
    const fake = codex();
    await run(
      fake,
      () =>
        Effect.sync(() => {
          const probe = fake.processes[0]!;
          expect(probe.env.NEUVE_CODEX_TOOL_TOKEN).toBeUndefined();
          expect(probe.args.join(" ")).not.toContain(
            "shell_environment_policy",
          );
          const { env, args } = fake.current();
          const token = env.NEUVE_CODEX_TOOL_TOKEN;
          expect(token).toBeString();
          expect(args.join(" ")).not.toContain(token!);
          expect(args).toContain(
            // The person's own list is kept: a `-c` value replaces the setting.
            'shell_environment_policy.exclude=["OWN_SECRET_*","NEUVE_CODEX_TOOL_TOKEN"]',
          );
          expect(env.OPENAI_API_KEY).toBeUndefined();
          expect(env.CODEX_HOME).toBeUndefined();
        }),
      { policy: withTool },
    );
  });

  test("a session with none of Neuve's tools holds no token and leaves the exclude list alone", async () => {
    const fake = codex();
    await run(fake, () =>
      Effect.sync(() => {
        for (const p of fake.processes) {
          expect(p.env.NEUVE_CODEX_TOOL_TOKEN).toBeUndefined();
          expect(p.args.join(" ")).not.toContain("shell_environment_policy");
        }
      }),
    );
  });

  // Codex can filter its own environment before spawning a shell, so the chat needs both launch inputs.
  test("an Ace chat reaches the Codex process and its restricted shell environment", async () => {
    const fake = codex((message, process) =>
      message.method === "config/read" && process === fake.processes[0]
        ? {
            config: {
              ...OWN,
              shell_environment_policy: { include_only: ["PATH", "HOME"] },
            },
          }
        : undefined,
    );
    await run(
      fake,
      () =>
        Effect.sync(() => {
          expect(
            fake.processes.map((process) => process.env.NEUVE_ACE_CHAT),
          ).toEqual(["channel-a/7", "channel-a/7"]);
          expect(fake.current().args).toContain(
            'shell_environment_policy.set.NEUVE_ACE_CHAT="channel-a/7"',
          );
          expect(fake.current().args).toContain(
            'shell_environment_policy.include_only=["PATH","HOME","NEUVE_ACE_CHAT"]',
          );
        }),
      { policy: { ...policy, environment: { NEUVE_ACE_CHAT: "channel-a/7" } } },
    );
  });
});

// Why: Codex's approval requests must reach a person only when one is attending, and nothing may
// wait on a person otherwise; a request still open when its turn ends must be answered.
describe("Codex's requests", () => {
  const ask = (
    process: Process,
    method: string,
    params: Record<string, unknown>,
    id: number,
  ) =>
    process.io.send({
      id,
      method,
      params: { threadId: "thread-1", turnId: "codex-turn", ...params },
    });
  const answer = (process: Process, id: number) =>
    process.io.written.find((m) => m.id === id && m.method === undefined);

  test("attended: raised as the contract's request, and both answers reach Codex", async () => {
    const fake = codex();
    const command = "/bin/zsh -lc 'curl -sI https://example.com'";
    const execpolicy = ["curl", "-sI"];
    await run(
      fake,
      (session, read) =>
        Effect.gen(function* () {
          yield* startOn(fake, session);
          const process = fake.current();
          for (const [id, decision, expected] of [
            [101, "allow", "accept"],
            [102, "deny", "decline"],
          ] as const) {
            ask(
              process,
              "item/commandExecution/requestApproval",
              {
                itemId: `c${id}`,
                kind: "command",
                command,
                cwd: "/work",
                commandActions: [{ type: "unknown", command }],
                proposedExecpolicyAmendment: execpolicy,
                availableDecisions: [
                  "accept",
                  {
                    acceptWithExecpolicyAmendment: {
                      execpolicy_amendment: execpolicy,
                    },
                  },
                  "cancel",
                ],
              },
              id,
            );
            const event = yield* read.next("approval.requested");
            expect(event).toMatchObject({
              work: "command",
              callId: `c${id}`,
              input: { command },
              asked: { kind: "command", command, folder: "/work" },
            });
            if (event.type !== "approval.requested") throw new Error("fixture");
            expect(
              yield* session.respondToApproval({
                requestId: event.requestId,
                decision,
              }),
            ).toEqual({ delivered: true });
            yield* until(() => answer(process, id) !== undefined);
            expect(answer(process, id)).toEqual({
              id,
              result: { decision: expected },
            });
          }
          // One left open when the turn ends is declined with it.
          ask(
            process,
            "item/fileChange/requestApproval",
            { itemId: "f1" },
            103,
          );
          const last = yield* read.next("approval.requested");
          if (last.type !== "approval.requested") throw new Error("fixture");
          fake.send("turn/completed", completed("completed"));
          yield* read.next("turn.finished");
          expect(
            yield* session.respondToApproval({
              requestId: last.requestId,
              decision: "allow",
            }),
          ).toEqual({ delivered: false, reason: "turn-ended" });
          yield* until(() => answer(process, 103) !== undefined);
          expect(answer(process, 103)).toMatchObject({
            result: { decision: "decline" },
          });
        }),
      { policy: { ...policy, approvalPolicy: "ask" } },
    );
  });

  test("Codex resolution closes one request and leaves the next request for the same item answerable", async () => {
    const fake = codex();
    await run(
      fake,
      (session, read) =>
        Effect.gen(function* () {
          yield* startOn(fake, session);
          const process = fake.current();
          ask(
            process,
            "item/commandExecution/requestApproval",
            { itemId: "c1" },
            301,
          );
          const first = yield* read.next("approval.requested");
          if (first.type !== "approval.requested") throw new Error("fixture");
          const resolved = { threadId: "thread-1", requestId: 301 };
          fake.send("serverRequest/resolved", resolved);
          expect(yield* read.next("approval.resolved")).toEqual({
            type: "approval.resolved",
            turnId: "turn",
            at: expect.any(String),
            requestId: first.requestId,
          });
          fake.send("serverRequest/resolved", resolved);
          ask(
            process,
            "item/permissions/requestApproval",
            {
              itemId: "c1",
              permissions: { network: { enabled: true }, fileSystem: null },
            },
            302,
          );
          const second = yield* read.next("approval.requested");
          if (second.type !== "approval.requested") throw new Error("fixture");
          expect(second.callId).toBe("c1");
          expect(second.requestId).not.toBe(first.requestId);
          expect(
            yield* session.respondToApproval({
              requestId: first.requestId,
              decision: "allow",
            }),
          ).toEqual({ delivered: false, reason: "runtime-resolved" });
          expect(
            yield* session.respondToApproval({
              requestId: "unknown",
              decision: "allow",
            }),
          ).toEqual({ delivered: false });
          yield* session.respondToApproval({
            requestId: second.requestId,
            decision: "deny",
          });
          yield* until(() => answer(process, 302) !== undefined);
          expect(answer(process, 302)).toEqual({
            id: 302,
            result: { permissions: {}, scope: "turn" },
          });
          fake.send("serverRequest/resolved", {
            threadId: "thread-1",
            requestId: 302,
          });
          fake.send("turn/completed", completed("completed"));
          expect(yield* read.next("turn.finished")).toMatchObject({
            outcome: { status: "completed" },
          });
          expect(answer(process, 301)).toBeUndefined();
          expect(
            read.events.filter((event) => event.type === "approval.resolved"),
          ).toHaveLength(1);
          expect(read.ended()).toBe(false);
        }),
      { policy: { ...policy, approvalPolicy: "ask" } },
    );
  });

  test("answers two simultaneous requests for one item by request ID", async () => {
    const fake = codex();
    await run(
      fake,
      (session, read) =>
        Effect.gen(function* () {
          yield* startOn(fake, session);
          const process = fake.current();
          ask(
            process,
            "item/commandExecution/requestApproval",
            { itemId: "c1" },
            301,
          );
          const command = yield* read.next("approval.requested");
          ask(
            process,
            "item/permissions/requestApproval",
            {
              itemId: "c1",
              permissions: { network: { enabled: true }, fileSystem: null },
            },
            302,
          );
          const permissions = yield* read.next("approval.requested");
          if (
            command.type !== "approval.requested" ||
            permissions.type !== "approval.requested"
          )
            throw new Error("fixture");
          expect([command.callId, permissions.callId]).toEqual(["c1", "c1"]);
          yield* session.respondToApproval({
            requestId: permissions.requestId,
            decision: "allow",
          });
          yield* session.respondToApproval({
            requestId: command.requestId,
            decision: "deny",
          });
          yield* until(
            () =>
              answer(process, 301) !== undefined &&
              answer(process, 302) !== undefined,
          );
          expect(answer(process, 301)).toEqual({
            id: 301,
            result: { decision: "decline" },
          });
          expect(answer(process, 302)).toEqual({
            id: 302,
            result: {
              permissions: { network: { enabled: true } },
              scope: "turn",
            },
          });
        }),
      { policy: { ...policy, approvalPolicy: "ask" } },
    );
  });

  test("a file approval includes the earlier item's changes and omits them when the item is missing", async () => {
    const fake = codex();
    await run(
      fake,
      (session, read) =>
        Effect.gen(function* () {
          yield* startOn(fake, session);
          const process = fake.current();
          const changes = [
            { path: "/work/add", kind: { type: "add" }, diff: "hello\n" },
            { path: "/work/delete", kind: { type: "delete" }, diff: "-old" },
            {
              path: "/work/update",
              kind: { type: "update", move_path: "/work/moved" },
              diff: "-old\n+new",
            },
          ];
          fake.send("item/started", {
            threadId: "thread-1",
            turnId: "codex-turn",
            startedAtMs: 1,
            item: {
              type: "fileChange",
              id: "f1",
              status: "inProgress",
              changes,
            },
          });
          ask(
            process,
            "item/fileChange/requestApproval",
            { itemId: "f1", startedAtMs: 3, reason: null, grantRoot: null },
            401,
          );
          expect(yield* read.next("approval.requested")).toMatchObject({
            work: "file-change",
            callId: "f1",
            input: { reason: null, grantRoot: null, changes },
            asked: {
              kind: "file-change",
              changes: [
                { path: "/work/add", kind: "add", diff: "hello\n" },
                { path: "/work/delete", kind: "delete", diff: "-old" },
                {
                  path: "/work/update",
                  kind: "update",
                  newPath: "/work/moved",
                  diff: "-old\n+new",
                },
              ],
            },
          });
          ask(
            process,
            "item/fileChange/requestApproval",
            { itemId: "f2" },
            402,
          );
          const missing = yield* read.next("approval.requested");
          expect(missing).toMatchObject({
            work: "file-change",
            callId: "f2",
            asked: { kind: "file-change", changes: null },
          });
          if (missing.type !== "approval.requested") throw new Error("fixture");
          expect(missing.input).toEqual({
            threadId: "thread-1",
            turnId: "codex-turn",
            itemId: "f2",
          });
        }),
      { policy: { ...policy, approvalPolicy: "ask" } },
    );
  });

  test("the displayed root write grant matches the profile sent back with turn scope", async () => {
    const fake = codex();
    await run(
      fake,
      (session, read) =>
        Effect.gen(function* () {
          yield* startOn(fake, session);
          const process = fake.current();
          const permissions = {
            network: { enabled: true },
            fileSystem: {
              entries: [
                {
                  path: { type: "special", value: { kind: "root" } },
                  access: "write",
                },
              ],
            },
          };
          ask(
            process,
            "item/permissions/requestApproval",
            { itemId: "p1", permissions, reason: "Need root", cwd: "/work" },
            501,
          );
          const event = yield* read.next("approval.requested");
          expect(event).toMatchObject({
            input: { permissions },
            asked: {
              kind: "wider-access",
              reason: "Need root",
              folder: "/work",
              network: true,
              paths: [{ access: "write", target: { kind: "root" } }],
            },
          });
          if (event.type !== "approval.requested") throw new Error("fixture");
          yield* session.respondToApproval({
            requestId: event.requestId,
            decision: "allow",
          });
          yield* until(() => answer(process, 501) !== undefined);
          expect(answer(process, 501)).toMatchObject({
            result: { permissions, scope: "turn" },
          });
        }),
      { policy: { ...policy, approvalPolicy: "ask" } },
    );
  });

  test("unattended and read-only: declined at once, another server's prompt too, and the turn goes on", async () => {
    for (const workspace of [write, readOnly]) {
      const fake = codex();
      await run(fake, (session, read) =>
        Effect.gen(function* () {
          yield* startOn(fake, session, workspace);
          const process = fake.current();
          ask(
            process,
            "item/commandExecution/requestApproval",
            { itemId: "c1" },
            201,
          );
          ask(
            process,
            "mcpServer/elicitation/request",
            {
              serverName: "someone",
              mode: "form",
              message: "ok?",
              requestedSchema: {},
              _meta: null,
            },
            202,
          );
          yield* until(
            () =>
              answer(process, 201) !== undefined &&
              answer(process, 202) !== undefined,
          );
          expect(answer(process, 201)).toMatchObject({
            result: { decision: "decline" },
          });
          expect(answer(process, 202)).toMatchObject({
            result: { action: "decline" },
          });
          expect(read.events.some((e) => e.type === "approval.requested")).toBe(
            false,
          );
          fake.send("turn/completed", completed("completed"));
          expect(yield* read.next("turn.finished")).toMatchObject({
            outcome: { status: "completed" },
          });
        }),
      );
    }
  });
});

// Why: a session opens on what the caller names, and a resume at a point that is not the thread's
// end must not quietly continue past it.
describe("opening", () => {
  test("resume at the thread's last turn continues it; at an earlier one it forks there", async () => {
    for (const [at, id] of [
      ["turn-a", "thread-0"],
      ["turn-earlier", "thread-fork"],
    ] as const) {
      const fake = codex();
      await run(
        fake,
        (session) =>
          Effect.sync(() => {
            expect(session.nativeSessionId).toBe(id);
            expect(
              written(fake.current(), "thread/resume")[0]!.params,
            ).toMatchObject({
              threadId: "thread-0",
              developerInstructions: "new instructions",
            });
            if (id === "thread-fork")
              expect(
                written(fake.current(), "thread/fork")[0]!.params,
              ).toMatchObject({
                threadId: "thread-0",
                lastTurnId: "turn-earlier",
                developerInstructions: "new instructions",
              });
          }),
        {
          policy: { ...policy, systemPrompt: "new instructions" },
          start: { kind: "resume", session: "thread-0", at, fork: false },
        },
      );
    }
  });

  test("signed out: the session is refused with Codex's sign-in", async () => {
    const fake = codex((message) =>
      message.method === "account/read"
        ? { account: null, requiresOpenaiAuth: true }
        : undefined,
    );
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        openCodexSession({
          account,
          program: "/test/codex",
          cwd: "/work",
          environment: {},
          codexHome: "/second-home",
          policy,
          start: { kind: "new" },
          stopWait: "10 millis",
        }),
      ).pipe(Effect.provide(fake.layer)),
    );
    expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain(
      "SignInRequired",
    );
    expect(JSON.stringify(exit)).toContain("/second-home");
  });

  test("a program that does not answer as Codex is refused as a failed start", async () => {
    const fake = codex((message, process) => {
      if (message.method === "initialize")
        process.io.emit("this is not codex\n");
      return SILENT;
    });
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        openCodexSession({
          account,
          program: "/test/codex",
          cwd: "/work",
          environment: {},
          policy,
          start: { kind: "new" },
          stopWait: "10 millis",
        }),
      ).pipe(Effect.provide(fake.layer)),
    );
    expect(JSON.stringify(exit)).toContain("start-failed");
  });
});

// Why: a process whose start is cut short, by the caller or by the session closing, must not be
// left running, and the turn it was starting for must still end once.
describe("a start cut short", () => {
  const stuck = () =>
    codex((message, process) =>
      message.method === "initialize" &&
      process.args.includes("features.hooks=false") === false
        ? SILENT
        : undefined,
    );
  test("the session closes while a write turn waits on Codex's handshake", async () => {
    const fake = stuck();
    await run(fake, (session, read, scope) =>
      Effect.gen(function* () {
        yield* session
          .startTurn({ turnId: "turn", message: "go", workspace: write })
          .pipe(Effect.forkDetach);
        yield* until(() => fake.processes.length === 3);
        yield* Scope.close(scope, Exit.void);
        yield* read.done;
        expect(read.finished()).toEqual([
          expect.objectContaining({
            outcome: { status: "interrupted", reason: "shutdown" },
          }),
        ]);
        expect(fake.processes.every((p) => p.io.exited())).toBe(true);
      }),
    );
  });

  test("the caller gives up while a write turn waits on Codex's handshake", async () => {
    const fake = stuck();
    await run(fake, (session, read) =>
      Effect.gen(function* () {
        const started = yield* session
          .startTurn({ turnId: "turn", message: "go", workspace: write })
          .pipe(Effect.forkDetach);
        yield* until(() => fake.processes.length === 3);
        yield* Fiber.interrupt(started);
        expect(yield* read.next("turn.finished")).toMatchObject({
          outcome: { status: "interrupted" },
        });
        yield* until(() => fake.processes[2]!.io.exited());
        expect(read.finished()).toHaveLength(1);
      }),
    );
  });
});

// Why: steering, a model switch and fork are declared, so each must reach Codex as the contract
// says.
describe("what else is declared", () => {
  test("a steer reaches the running turn by Codex's id", async () => {
    const fake = codex();
    await run(fake, (session) =>
      Effect.gen(function* () {
        yield* startOn(fake, session);
        yield* session.steerTurn({ turnId: "turn", message: "and this" });
        expect(written(fake.current(), "turn/steer")[0]!.params).toMatchObject({
          threadId: "thread-1",
          expectedTurnId: "codex-turn",
          input: [{ type: "text", text: "and this" }],
        });
      }),
    );
  });

  test("a model switch is carried by the next turn, and no effort clears the last one", async () => {
    const fake = codex();
    await run(fake, (session, read) =>
      Effect.gen(function* () {
        yield* session.setModel({ id: "gpt-other", effort: "low" });
        yield* startOn(fake, session);
        expect(written(fake.current(), "turn/start")[0]!.params).toMatchObject({
          model: "gpt-other",
          effort: "low",
        });
        fake.send("turn/completed", completed("completed"));
        yield* read.next("turn.finished");
        yield* session.setModel({ id: "gpt-other" });
        yield* session.startTurn({
          turnId: "next",
          message: "go",
          workspace: write,
        });
        yield* until(() => written(fake.current(), "turn/start").length > 1);
        expect(written(fake.current(), "turn/start")[1]!.params).toMatchObject({
          model: "gpt-other",
          effort: null,
        });
      }),
    );
  });

  test("a fork opens a new thread from the named one", async () => {
    const fake = codex();
    await run(
      fake,
      (session) =>
        Effect.sync(() => {
          expect(session.nativeSessionId).toBe("thread-fork");
          expect(
            written(fake.current(), "thread/fork")[0]!.params,
          ).toMatchObject({
            threadId: "thread-0",
          });
        }),
      { start: { kind: "resume", session: "thread-0", fork: true } },
    );
  });
});

// Why: rows of the turn-endings table that a request Codex never answers, a caller that gives up,
// or a race can reach. The invariant: one terminal event per turn, and no Codex turn left running
// that Neuve does not track.
describe("cancelling a turn", () => {
  test("turn/start never answered: the interrupt's deadline ends the turn and stops Codex", async () => {
    const fake = codex((message) =>
      message.method === "turn/start" ? SILENT : undefined,
    );
    await run(fake, (session, read) =>
      Effect.gen(function* () {
        yield* session
          .startTurn({ turnId: "turn", message: "go", workspace: write })
          .pipe(Effect.forkDetach);
        yield* until(() => written(fake.current(), "turn/start").length > 0);
        yield* session.interruptTurn({ turnId: "turn", reason: "stop" });
        expect(yield* read.next("turn.finished")).toMatchObject({
          outcome: { status: "interrupted", reason: "stop" },
        });
        yield* read.done;
        yield* until(() => fake.current().io.exited());
        expect(read.finished()).toHaveLength(1);
      }),
    );
  });

  test("the resume after a change of mode never answered: the same deadline", async () => {
    const fake = codex((message, process) =>
      message.method === "thread/resume" && !process.clean ? SILENT : undefined,
    );
    await run(fake, (session, read) =>
      Effect.gen(function* () {
        yield* session
          .startTurn({ turnId: "turn", message: "go", workspace: write })
          .pipe(Effect.forkDetach);
        yield* until(() => written(fake.current(), "thread/resume").length > 0);
        yield* session.interruptTurn({ turnId: "turn" });
        expect(yield* read.next("turn.finished")).toMatchObject({
          outcome: { status: "interrupted" },
        });
        yield* read.done;
        expect(fake.processes.every((p) => p.io.exited())).toBe(true);
      }),
    );
  });

  test("a caller that gives up after turn/start was written: Codex's turn is interrupted once named", async () => {
    let answer: (() => void) | undefined;
    const fake = codex((message, process) => {
      if (message.method === "turn/start") {
        answer = () => {
          process.io.send({
            id: message.id,
            result: { turn: { id: "codex-turn" } },
          });
          process.io.send({
            method: "turn/started",
            params: { threadId: "thread-1", turn: { id: "codex-turn" } },
          });
        };
        return SILENT;
      }
      if (message.method === "turn/interrupt")
        queueMicrotask(() =>
          process.io.send({
            method: "turn/completed",
            params: completed("interrupted"),
          }),
        );
      return undefined;
    });
    await run(fake, (session, read) =>
      Effect.gen(function* () {
        const started = yield* session
          .startTurn({ turnId: "turn", message: "go", workspace: write })
          .pipe(Effect.forkDetach);
        yield* until(() => answer !== undefined);
        yield* Fiber.interrupt(started);
        answer!();
        expect(yield* read.next("turn.finished")).toMatchObject({
          outcome: { status: "interrupted" },
        });
        expect(written(fake.current(), "turn/interrupt")).toHaveLength(1);
        expect(read.finished()).toHaveLength(1);
        expect(read.ended()).toBe(false);
      }),
    );
  });

  test("a second interrupt sends nothing more and starts no second deadline", async () => {
    const fake = codex();
    await run(fake, (session, read) =>
      Effect.gen(function* () {
        yield* startOn(fake, session);
        yield* session.interruptTurn({ turnId: "turn", reason: "stop" });
        yield* Effect.sleep("30 millis");
        yield* session.interruptTurn({ turnId: "turn", reason: "cutoff" });
        expect(yield* read.next("turn.finished")).toMatchObject({
          outcome: { status: "interrupted", reason: "stop" },
        });
        expect(written(fake.current(), "turn/interrupt")).toHaveLength(1);
      }),
    );
  });

  test("an interrupt racing completion: one ending, and the session goes on", async () => {
    const fake = codex();
    await run(fake, (session, read) =>
      Effect.gen(function* () {
        yield* startOn(fake, session);
        fake.send("turn/completed", completed("completed"));
        yield* session.interruptTurn({ turnId: "turn" });
        yield* read.next("turn.finished");
        yield* Effect.sleep("80 millis");
        expect(read.finished()).toHaveLength(1);
        expect(read.ended()).toBe(false);
        expect(fake.current().io.exited()).toBe(false);
      }),
    );
  });

  test("a second turn while one runs is refused, and the first goes on", async () => {
    const fake = codex();
    await run(fake, (session, read) =>
      Effect.gen(function* () {
        yield* startOn(fake, session);
        expect(
          yield* Effect.flip(
            session.startTurn({
              turnId: "second",
              message: "go",
              workspace: write,
            }),
          ),
        ).toMatchObject({ reason: "previous-turn-active" });
        fake.send("turn/completed", completed("completed"));
        expect(yield* read.next("turn.finished")).toMatchObject({
          turnId: "turn",
        });
        expect(
          read.events.filter((e) => e.type === "turn.started"),
        ).toHaveLength(1);
      }),
    );
  });
});

// Why: each of these was a planted fault the first tests let through.
describe("what the first tests missed", () => {
  test("the clean session switches off web search and bundled skills, and keeps the person's exclude list", async () => {
    const fake = codex();
    await run(fake, () =>
      Effect.sync(() => {
        const { args } = fake.current();
        expect(args).toContain('web_search="disabled"');
        expect(args).toContain("skills.bundled.enabled=false");
        expect(args).toContain("features.hooks=false");
      }),
    );
  });

  let fake0 = codex();
  for (const [what, reply] of [
    [
      "a hook still listed",
      (m: Record<string, unknown>) =>
        m.method === "hooks/list"
          ? { data: [{ cwd: "/work", hooks: [{}], warnings: [], errors: [] }] }
          : undefined,
    ],
    [
      "a server of the person's with tools",
      (m: Record<string, unknown>) =>
        m.method === "mcpServerStatus/list"
          ? {
              data: [
                { name: "own-server", runtimeStatus: null, tools: { t: {} } },
              ],
              nextCursor: null,
            }
          : undefined,
    ],
    [
      "web search not off",
      (m: Record<string, unknown>, p: Process) =>
        m.method === "config/read" && p.clean && fake0.processes.length > 1
          ? {
              config: {
                web_search: "live",
                features: { hooks: false, apps: false, plugins: false },
              },
            }
          : undefined,
    ],
    [
      "a skill of the person's enabled",
      (m: Record<string, unknown>, p: Process) =>
        m.method === "skills/list" && fake0.processes.length > 1
          ? {
              data: [
                {
                  cwd: "/work",
                  skills: [
                    {
                      name: "own-skill",
                      path: "/home/.codex/skills/own-skill/SKILL.md",
                      enabled: true,
                    },
                  ],
                  errors: [],
                },
              ],
            }
          : undefined,
    ],
  ] as const) {
    test(`a clean session is refused when Codex reports ${what}`, async () => {
      fake0 = codex(reply);
      const exit = await Effect.runPromiseExit(
        Effect.scoped(
          openCodexSession({
            account,
            program: "/test/codex",
            cwd: "/work",
            environment: {},
            policy,
            start: { kind: "new" },
            stopWait: "10 millis",
          }),
        ).pipe(Effect.provide(fake0.layer)),
      );
      expect(JSON.stringify(exit)).toContain("start-failed");
      expect(fake0.processes.every((p) => p.io.exited())).toBe(true);
    });
  }

  test("an unattended write turn asks nothing: never", () => {
    expect(turnSettings(write, "allow").approvalPolicy).toBe("never");
    expect(turnSettings(write, "ask").approvalPolicy).toBe("on-request");
    expect(turnSettings(readOnly, "ask").approvalPolicy).toBe("never");
  });

  test.each(["own", "clean"] as const)(
    "%s Codex allows the selected skill path and disables its same-name copy",
    (configuration) => {
      const args = launchArguments(
        configuration,
        {
          mcpServers: [],
          plugins: [],
          apps: [],
          exclude: [],
          skills: [
            { path: "/home/.agents/skills/neuve/SKILL.md", enabled: true },
            { path: "/carried skills/neuve/SKILL.md", enabled: false },
          ],
        },
        undefined,
      );
      expect(args).toContain(
        'skills.config=[{path="/home/.agents/skills/neuve/SKILL.md",enabled=true},{path="/carried skills/neuve/SKILL.md",enabled=false}]',
      );
      expect(args).toContain("skills.bundled.enabled=false");
      expect(args.includes("features.hooks=false")).toBe(
        configuration === "clean",
      );
    },
  );

  test.each([
    { label: "a different spelling of an allowed skill", enabled: true },
    { label: "an allowed skill that Codex leaves disabled", enabled: false },
  ])("Codex starts with $label", async ({ enabled }) => {
    const project = resolve(import.meta.dir, "../../../apps/neuve-cli/skills");
    const lowerCase = `${project}/neuve/skill.md`;
    const path = enabled
      ? await realpath(lowerCase).then(
          () => lowerCase,
          () => `${project}/neuve/./SKILL.md`,
        )
      : `${project}/neuve/SKILL.md`;
    const flag = `skills.config=[{path=${JSON.stringify(path)},enabled=true}]`;
    const fake = codex((message, process) =>
      message.method === "skills/list"
        ? {
            data: [
              {
                skills: [
                  {
                    name: "neuve",
                    path,
                    enabled: enabled && process.args.includes(flag),
                  },
                ],
              },
            ],
          }
        : undefined,
    );
    const logs: unknown[] = [];
    const session = await Effect.runPromise(
      Effect.scoped(
        openCodexSession({
          account,
          program: "/test/codex",
          cwd: "/work",
          environment: {},
          policy: {
            ...policy,
            skillRoots: { user: project, project, carried: undefined },
          },
          start: { kind: "new" },
          stopWait: "10 millis",
        }),
      ).pipe(
        Effect.provide(fake.layer),
        Effect.provide(
          Logger.layer([Logger.make(({ message }) => logs.push(message))]),
        ),
      ),
    );
    expect(session.nativeSessionId).toBe("thread-1");
    expect(fake.current().args).toContain(flag);
    expect(logs).toEqual(
      enabled ? [] : [["codex: skills were not enabled", ["neuve"]]],
    );
  });

  test("under ask, a request during a clean turn is declined, and one from Neuve's own server too", async () => {
    const fake = codex();
    await run(
      fake,
      (session, read) =>
        Effect.gen(function* () {
          yield* startOn(fake, session, readOnly);
          const process = fake.current();
          process.io.send({
            id: 301,
            method: "item/commandExecution/requestApproval",
            params: {
              threadId: "thread-1",
              turnId: "codex-turn",
              itemId: "c1",
            },
          });
          yield* until(() => process.io.written.some((m) => m.id === 301));
          fake.send("turn/completed", completed("completed"));
          yield* read.next("turn.finished");
          yield* startOn(fake, session, write);
          const own = fake.current();
          own.io.send({
            id: 302,
            method: "mcpServer/elicitation/request",
            params: {
              threadId: "thread-1",
              turnId: "codex-turn",
              serverName: "neuve",
              mode: "form",
              message: "ok?",
              requestedSchema: {},
              _meta: null,
            },
          });
          yield* until(() => own.io.written.some((m) => m.id === 302));
          expect(process.io.written.find((m) => m.id === 301)).toMatchObject({
            result: { decision: "decline" },
          });
          expect(own.io.written.find((m) => m.id === 302)).toMatchObject({
            result: { action: "decline" },
          });
          expect(read.events.some((e) => e.type === "approval.requested")).toBe(
            false,
          );
        }),
      { policy: { ...withTool, approvalPolicy: "ask" } },
    );
  });

  test("a call to a server of the person's named neuve is their work when Neuve serves no tools", async () => {
    const fake = codex();
    await run(fake, (session, read) =>
      Effect.gen(function* () {
        yield* startOn(fake, session);
        fake.send("item/completed", {
          threadId: "thread-1",
          turnId: "codex-turn",
          completedAtMs: 0,
          item: {
            type: "mcpToolCall",
            id: "m1",
            server: "neuve",
            tool: "x",
            status: "completed",
            arguments: {},
            result: null,
            error: null,
            durationMs: null,
          },
        });
        fake.send("turn/completed", completed("completed"));
        yield* read.next("turn.finished");
        expect(read.events.filter((e) => e.type === "work.finished")).toEqual([
          expect.objectContaining({ workId: "m1", kind: "tool" }),
        ]);
      }),
    );
  });

  test("a long command reports its start while Codex still runs it", async () => {
    const fake = codex();
    const log: LogEntry[] = [];
    const secret = "sk-012345678901234567890123";
    await run(
      fake,
      (session, read) =>
        Effect.gen(function* () {
          yield* startOn(fake, session);
          const item = {
            type: "commandExecution",
            id: "c1",
            command: `sleep 120 # ${secret}`,
            cwd: "/work",
            status: "inProgress",
            aggregatedOutput: null,
            exitCode: null,
            durationMs: null,
          };
          fake.send("item/started", {
            threadId: "thread-1",
            turnId: "codex-turn",
            item,
          });
          expect(yield* read.next("work.started")).toMatchObject({
            workId: "c1",
            kind: "command",
            input: { command: `sleep 120 # ${secret}`, cwd: "/work" },
          });
          expect(read.events.map((event) => event.type)).toEqual([
            "turn.started",
            "work.started",
          ]);
          expect(JSON.stringify(log)).toContain("sleep 120 # <token>");
          expect(JSON.stringify(log)).not.toContain(secret);
          fake.send("item/completed", {
            threadId: "thread-1",
            turnId: "codex-turn",
            completedAtMs: 0,
            item: { ...item, status: "completed", exitCode: 0 },
          });
          fake.send("turn/completed", completed("completed"));
          yield* read.next("turn.finished");
          expect(read.events.filter((e) => e.type === "work.finished")).toEqual(
            [expect.objectContaining({ workId: "c1", errored: false })],
          );
        }),
      { log: (entry) => log.push(entry) },
    );
  });

  test("a server of the person's under Neuve's name refuses a session that serves Neuve's tools", async () => {
    const fake = codex((m) =>
      m.method === "config/read" && fake.processes.length === 1
        ? { config: { mcp_servers: { neuve: { enabled: true } } } }
        : undefined,
    );
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        openCodexSession({
          account,
          program: "/test/codex",
          cwd: "/work",
          environment: {},
          policy: {
            ...policy,
            tools: [
              {
                name: "t",
                description: "t",
                inputSchema: { type: "object" },
                hints: {
                  readOnly: true,
                  destructive: false,
                  idempotent: true,
                  openWorld: false,
                },
                handle: () => Effect.succeed({ text: "" }),
              },
            ],
          },
          start: { kind: "new" },
          stopWait: "10 millis",
        }),
      ).pipe(Effect.provide(fake.layer)),
    );
    expect(JSON.stringify(exit)).toContain("start-failed");
    // Refused on the names alone, before a process with Neuve's server in it starts.
    expect(fake.processes).toHaveLength(1);
  });
});

// Why: the third round of defects in one place, the hand-over from one process to the next (the
// session's states in PROTOCOL.md). A process becomes current only once checked and with the thread
// loaded; after every wait the session and the turn are re-checked; every process is closed at the
// end. Each test is one of the outer reviewer's reproductions, now asserted.
describe("handing the session from one process to the next", () => {
  test("a read-only start abandoned in its clean check leaves no unchecked process current", async () => {
    // Processes: 0 reads the settings, 1 is clean, 2 the person's own, 3 reads them again, 4 is
    // the clean one whose check never finishes.
    const fake = codex((message, process) =>
      message.method === "hooks/list" && fake.processes.indexOf(process) === 4
        ? SILENT
        : undefined,
    );
    await run(fake, (session, read) =>
      Effect.gen(function* () {
        yield* startOn(fake, session);
        fake.send("turn/completed", completed("completed"));
        yield* read.next("turn.finished");
        const abandoned = yield* session
          .startTurn({ turnId: "r1", message: "go", workspace: readOnly })
          .pipe(Effect.forkDetach);
        yield* until(
          () =>
            fake.processes.length === 5 &&
            written(fake.processes[4]!, "hooks/list").length > 0,
        );
        yield* Fiber.interrupt(abandoned);
        expect(yield* read.next("turn.finished")).toMatchObject({
          outcome: { status: "interrupted" },
        });
        yield* session.startTurn({
          turnId: "r2",
          message: "go",
          workspace: readOnly,
        });
        yield* until(() => written(fake.current(), "turn/start").length > 0);
        const unchecked = fake.processes[4]!;
        expect(written(unchecked, "turn/start")).toHaveLength(0);
        expect(unchecked.io.exited()).toBe(true);
        // The turn went to a process that passed its check and loaded the thread first.
        const used = fake.current();
        expect(fake.processes.indexOf(used)).toBe(6);
        expect(used.clean).toBe(true);
        expect(written(used, "mcpServerStatus/list")).toHaveLength(1);
        expect(written(used, "thread/resume")).toHaveLength(1);
      }),
    );
  });

  test("a refused resume after a change of mode: that process is closed, and the next turn starts over", async () => {
    // Processes: 0 reads the settings, 1 is clean, 2 the person's own and refuses the thread.
    const fake = codex((message, process) =>
      message.method === "thread/resume" &&
      fake.processes.indexOf(process) === 2
        ? new Error("thread not found")
        : undefined,
    );
    await run(fake, (session, read) =>
      Effect.gen(function* () {
        yield* startOn(fake, session, readOnly);
        fake.send("turn/completed", completed("completed"));
        yield* read.next("turn.finished");
        yield* session.startTurn({
          turnId: "w1",
          message: "go",
          workspace: write,
        });
        expect(yield* read.next("turn.finished")).toMatchObject({
          outcome: { status: "failed", disposition: "reusable" },
        });
        const refused = fake.processes[2]!;
        expect(written(refused, "turn/start")).toHaveLength(0);
        yield* until(() => refused.io.exited());
        yield* session.startTurn({
          turnId: "w2",
          message: "go",
          workspace: write,
        });
        yield* until(() => written(fake.current(), "turn/start").length > 0);
        const used = fake.current();
        expect(fake.processes.indexOf(used)).toBe(3);
        expect(written(used, "thread/resume")).toHaveLength(1);
        expect(written(refused, "turn/start")).toHaveLength(0);
      }),
    );
  });

  test("the scope closes while a change of mode stops the old process: nothing starts after, and every process ends", async () => {
    const fake = codex();
    await run(
      fake,
      (session, read, scope) =>
        Effect.gen(function* () {
          yield* startOn(fake, session, readOnly);
          fake.send("turn/completed", completed("completed"));
          yield* read.next("turn.finished");
          fake.current().io.ignoreTerm();
          yield* session
            .startTurn({ turnId: "w1", message: "go", workspace: write })
            .pipe(Effect.forkDetach);
          yield* Effect.sleep("20 millis");
          yield* Scope.close(scope, Exit.void);
          const started = fake.processes.length;
          yield* Effect.sleep("300 millis");
          expect(fake.processes).toHaveLength(started);
          expect(fake.processes.every((p) => p.io.exited())).toBe(true);
          expect(
            fake.processes.map((p) => written(p, "turn/start").length),
          ).toEqual(fake.processes.map((_, i) => (i === 1 ? 1 : 0)));
          expect(read.finished().map((e) => e.outcome)).toEqual([
            { status: "completed" },
            { status: "interrupted", reason: "shutdown" },
          ]);
        }),
      { stopWait: "200 millis" },
    );
  });

  test("the scope closes while a turn's process is starting: it is closed, and turn/start is never sent", async () => {
    // The person's own Codex never answers its handshake, so the write turn waits in its start.
    const fake = codex((message, process) =>
      message.method === "initialize" && !process.clean ? SILENT : undefined,
    );
    await run(fake, (session, read, scope) =>
      Effect.gen(function* () {
        yield* session
          .startTurn({ turnId: "w1", message: "go", workspace: write })
          .pipe(Effect.forkDetach);
        yield* until(() => fake.processes.length === 3);
        yield* Scope.close(scope, Exit.void);
        yield* read.done;
        yield* Effect.sleep("30 millis");
        expect(fake.processes).toHaveLength(3);
        expect(fake.processes.every((p) => p.io.exited())).toBe(true);
        expect(
          fake.processes.every((p) => written(p, "turn/start").length === 0),
        ).toBe(true);
      }),
    );
  });
});

// Why: faults planted in round three that no test caught; each is pinned here.
describe("what the planted faults showed", () => {
  test("a version marked broken is refused, with the reason in the log", async () => {
    const fake = codex();
    const logs: string[] = [];
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        openCodexSession({
          account,
          program: "/test/codex",
          cwd: "/work",
          environment: {},
          policy,
          start: { kind: "new" },
          stopWait: "10 millis",
          broken: ["0.171.0-alpha.13"],
        }),
      ).pipe(
        Effect.provide(fake.layer),
        Effect.provide(
          Logger.layer([
            Logger.make(({ message }) => logs.push(JSON.stringify(message))),
          ]),
        ),
      ),
    );
    expect(JSON.stringify(exit)).toContain("unsupported-version");
    expect(logs.join("\n")).toContain("marked broken");
    expect(logs.join("\n")).toContain("0.171.0-alpha.13");
    expect(fake.processes.every((p) => p.io.exited())).toBe(true);
  });

  for (const feature of ["hooks", "apps", "plugins"])
    test(`a clean process that still has ${feature} on is refused for a read-only turn`, async () => {
      const fake = codex((message, process) => {
        if (message.method !== "config/read" || !process.clean) return;
        return {
          config: {
            // Everything else reads back off, so only this switch can refuse the process.
            mcp_servers: { "own-server": { enabled: false } },
            features: {
              hooks: false,
              apps: false,
              plugins: false,
              [feature]: true,
            },
            web_search: "disabled",
          },
        };
      });
      const exit = await Effect.runPromiseExit(
        Effect.scoped(
          openCodexSession({
            account,
            program: "/test/codex",
            cwd: "/work",
            environment: {},
            policy,
            start: { kind: "new" },
            stopWait: "10 millis",
          }),
        ).pipe(Effect.provide(fake.layer)),
      );
      expect(JSON.stringify(exit)).toContain("start-failed");
    });

  test("a clean process with one of the person's servers still enabled is refused, tools or none", async () => {
    // The server lists no tools, as one that failed to start does; its switch is what is read.
    const fake = codex((message, process) => {
      if (!process.clean) return;
      if (message.method === "config/read")
        return {
          config: {
            mcp_servers: { "own-server": { enabled: true } },
            features: { hooks: false, apps: false, plugins: false },
            web_search: "disabled",
          },
        };
      if (message.method === "mcpServerStatus/list")
        return {
          data: [{ name: "own-server", tools: {}, runtimeStatus: null }],
          nextCursor: null,
        };
    });
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        openCodexSession({
          account,
          program: "/test/codex",
          cwd: "/work",
          environment: {},
          policy,
          start: { kind: "new" },
          stopWait: "10 millis",
        }),
      ).pipe(Effect.provide(fake.layer)),
    );
    expect(JSON.stringify(exit)).toContain("start-failed");
  });

  test("a completion for another Codex turn does not end the open one", async () => {
    const fake = codex();
    await run(fake, (session, read) =>
      Effect.gen(function* () {
        yield* startOn(fake, session);
        fake.send(
          "turn/completed",
          completed("completed", null, "another-turn"),
        );
        yield* Effect.sleep("20 millis");
        expect(read.finished()).toHaveLength(0);
        fake.send("turn/completed", completed("completed"));
        yield* read.next("turn.finished");
        expect(read.finished()).toHaveLength(1);
      }),
    );
  });

  test("Codex's own question tool is off in both configurations, and the token is never in the log", async () => {
    const fake = codex();
    const entries: LogEntry[] = [];
    await run(
      fake,
      (session, read) =>
        Effect.gen(function* () {
          yield* startOn(fake, session);
          const token = fake.current().env.NEUVE_CODEX_TOOL_TOKEN!;
          // Were a command ever to print the token, the log would still not hold it.
          fake.send("item/completed", {
            threadId: "thread-1",
            turnId: "codex-turn",
            completedAtMs: 0,
            item: {
              type: "commandExecution",
              id: "c1",
              command: "env",
              cwd: "/work",
              status: "completed",
              aggregatedOutput: `NEUVE_CODEX_TOOL_TOKEN=${token}`,
              exitCode: 0,
              durationMs: 1,
            },
          });
          fake.send("turn/completed", completed("completed"));
          yield* read.next("turn.finished");
          for (const p of fake.processes)
            expect(p.args).toContain(
              "tools.experimental_request_user_input.enabled=false",
            );
          expect(fake.processes.some((p) => p.clean)).toBe(true);
          expect(fake.processes.some((p) => !p.clean)).toBe(true);
          expect(token).toBeString();
          expect(entries.length).toBeGreaterThan(0);
          expect(JSON.stringify(entries)).not.toContain(token);
        }),
      { policy: withTool, log: (entry) => entries.push(entry) },
    );
  });
});

// Why: round four of the hand-over, from the runtime slice's review. Each test fails on the code
// before it: a process that died after its last answer was made current; a refused resume of a
// thread whose first turn was cut short silently started a new thread.
describe("the hand-over, round four", () => {
  test("a process that dies after its last answer is never made current, and the session goes on", async () => {
    // Processes: 0 reads the settings, 1 is clean, 2 the person's own, which answers the resume
    // and then dies before it is made current.
    const fake = codex((message, process) => {
      if (
        message.method !== "thread/resume" ||
        fake.processes.indexOf(process) !== 2
      )
        return undefined;
      queueMicrotask(() => {
        process.io.send({
          id: message.id,
          result: { thread: { id: "thread-1", turns: [] } },
        });
        process.io.exit({ exitCode: 1 });
      });
      return SILENT;
    });
    await run(fake, (session, read) =>
      Effect.gen(function* () {
        yield* startOn(fake, session, readOnly);
        fake.send("turn/completed", completed("completed"));
        yield* read.next("turn.finished");
        yield* session.startTurn({
          turnId: "w1",
          message: "go",
          workspace: write,
        });
        expect(yield* read.next("turn.finished")).toMatchObject({
          outcome: { status: "failed", disposition: "reusable" },
        });
        expect(written(fake.processes[2]!, "turn/start")).toHaveLength(0);
        expect(read.ended()).toBe(false);
        // The death of a process that was not current did not stop the session.
        yield* session.startTurn({
          turnId: "w2",
          message: "go",
          workspace: write,
        });
        yield* until(() => written(fake.current(), "turn/start").length > 0);
        expect(fake.processes.indexOf(fake.current())).toBe(3);
        expect(written(fake.current(), "thread/resume")).toHaveLength(1);
      }),
    );
  });

  test("a refused resume of a thread whose first turn was cut short fails, and starts no new thread", async () => {
    // Processes: 0 reads the settings, 1 is clean, 2 the person's own, which refuses the thread.
    const fake = codex((message, process) =>
      message.method === "thread/resume" &&
      fake.processes.indexOf(process) === 2
        ? new Error("thread not found")
        : undefined,
    );
    await run(fake, (session, read) =>
      Effect.gen(function* () {
        yield* startOn(fake, session, readOnly);
        yield* session.interruptTurn({ turnId: "turn" });
        fake.send("turn/completed", completed("interrupted"));
        yield* read.next("turn.finished");
        yield* session.startTurn({
          turnId: "w1",
          message: "go",
          workspace: write,
        });
        expect(yield* read.next("turn.finished")).toMatchObject({
          outcome: { status: "failed" },
        });
        expect(written(fake.processes[2]!, "thread/start")).toHaveLength(0);
        expect(written(fake.processes[2]!, "turn/start")).toHaveLength(0);
      }),
    );
  });

  test("an interrupt while the old process is stopped for a change of mode ends the turn, and nothing is sent", async () => {
    const fake = codex();
    await run(
      fake,
      (session, read) =>
        Effect.gen(function* () {
          yield* startOn(fake, session, readOnly);
          fake.send("turn/completed", completed("completed"));
          yield* read.next("turn.finished");
          fake.current().io.ignoreTerm();
          const before = fake.processes.length;
          yield* session
            .startTurn({ turnId: "w1", message: "go", workspace: write })
            .pipe(Effect.forkDetach);
          yield* Effect.sleep("20 millis");
          yield* session.interruptTurn({ turnId: "w1" });
          expect(yield* read.next("turn.finished")).toMatchObject({
            outcome: { status: "interrupted" },
          });
          yield* Effect.sleep("300 millis");
          for (const p of fake.processes.slice(before))
            expect(written(p, "turn/start")).toHaveLength(0);
        }),
      { stopWait: "200 millis" },
    );
  });

  test("closing the session waits until every process it started has ended", async () => {
    const fake = codex();
    await run(
      fake,
      (session, read, scope) =>
        Effect.gen(function* () {
          yield* startOn(fake, session);
          for (const p of fake.processes) p.io.ignoreTerm();
          yield* Scope.close(scope, Exit.void);
          // No wait after the close: the finalizer itself waited for the kills.
          expect(fake.processes.every((p) => p.io.exited())).toBe(true);
          yield* read.done;
        }),
      { stopWait: "100 millis" },
    );
  });
});
