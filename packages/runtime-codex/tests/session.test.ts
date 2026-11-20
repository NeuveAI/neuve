import { describe, expect, test } from "bun:test";
import {
  AccountName,
  RuntimeEvent,
  TurnLimit,
  type RuntimeSession,
  type SessionPolicy,
  type SessionStart,
} from "@neuve/runtime";
import { Effect, Exit, Fiber, Queue, Scope, Stream } from "effect";
import { turnSettings } from "../src/launch.ts";
import { openCodexSession } from "../src/session.ts";
import {
  codex,
  completed,
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
  overrides: { policy?: SessionPolicy; start?: SessionStart } = {},
) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const session = yield* openCodexSession({
        account,
        program: "/test/codex",
        cwd: "/work",
        environment: { HOME: "/home", OPENAI_API_KEY: "sk-should-go" },
        policy: overrides.policy ?? policy,
        start: overrides.start ?? { kind: "new" },
        interruptWait: "50 millis",
        stopWait: "10 millis",
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
          "work.finished",
          "work.finished",
          "usage",
          "message.finished",
          "turn.finished",
        ]);
        expect(read.events[2]).toMatchObject({
          kind: "command",
          workId: "c1",
          errored: true,
          output: "denied",
        });
        expect(read.events[3]).toMatchObject({
          kind: "file-change",
          errored: false,
        });
        expect(read.events[4]).toMatchObject({
          scope: "turn",
          contextWindow: 400000,
          usage: { input: 40, cacheRead: 60, output: 20, thinking: 1 },
          costUsd: null,
        });
        expect(read.ended()).toBe(false);
      }),
    );
  });

  // Seen live: Codex completes no item for a command an interrupt cut short.
  test("work an interrupt cut short is reported once, as not finished", async () => {
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
        yield* Effect.sleep("5 millis");
        yield* session.interruptTurn({ turnId: "turn" });
        yield* read.next("turn.finished");
        expect(read.events.map((e) => e.type)).toEqual([
          "turn.started",
          "work.finished",
          "turn.finished",
        ]);
        expect(read.events[1]).toMatchObject({
          workId: "c1",
          kind: "command",
          errored: true,
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
          '{name="own-skill",enabled=false}',
        );
        expect(clean.args.join(" ")).not.toContain("repo-skill");
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
        expect(fake.processes).toHaveLength(2);
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
              { itemId: `c${id}`, command: "rm x", cwd: "/work" },
              id,
            );
            const event = yield* read.next("approval.requested");
            expect(event).toMatchObject({
              work: "command",
              callId: `c${id}`,
              input: { command: "rm x" },
            });
            if (event.type !== "approval.requested") throw new Error("fixture");
            yield* session.respondToApproval({
              requestId: event.requestId,
              decision,
            });
            yield* until(() => answer(process, id) !== undefined);
            expect(answer(process, id)).toMatchObject({
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
          yield* read.next("approval.requested");
          fake.send("turn/completed", completed("completed"));
          yield* read.next("turn.finished");
          yield* until(() => answer(process, 103) !== undefined);
          expect(answer(process, 103)).toMatchObject({
            result: { decision: "decline" },
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
            if (id === "thread-fork")
              expect(
                written(fake.current(), "thread/fork")[0]!.params,
              ).toMatchObject({
                threadId: "thread-0",
                lastTurnId: "turn-earlier",
              });
          }),
        { start: { kind: "resume", session: "thread-0", at, fork: false } },
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
                  skills: [{ name: "own-skill", scope: "user", enabled: true }],
                  errors: [],
                },
              ],
            }
          : undefined,
    ],
  ] as const) {
    test(`a clean session is refused when Codex reports ${what}`, async () => {
      fake0 = codex(reply as never);
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

  test("work started and completed is reported once", async () => {
    const fake = codex();
    await run(fake, (session, read) =>
      Effect.gen(function* () {
        yield* startOn(fake, session);
        const item = {
          type: "commandExecution",
          id: "c1",
          command: "ls",
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
        fake.send("item/completed", {
          threadId: "thread-1",
          turnId: "codex-turn",
          completedAtMs: 0,
          item: { ...item, status: "completed", exitCode: 0 },
        });
        fake.send("turn/completed", completed("completed"));
        yield* read.next("turn.finished");
        expect(read.events.filter((e) => e.type === "work.finished")).toEqual([
          expect.objectContaining({ workId: "c1", errored: false }),
        ]);
      }),
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
