import { expect, test } from "bun:test";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { Account, type SessionStart } from "@neuve/runtime";
import { Effect, Layer } from "effect";
import { makeRuntime } from "../src/runtime.ts";
import { checkCompletedInputs } from "../src/smoke-resume.ts";
import { ClaudeExecutable, ClaudeProcess } from "../src/services.ts";
import { assistant, errorResult, result, SESSION_ID } from "./frames.ts";
import { inbound, out, replay, type Entry } from "./replay.ts";

const account = Account.parse({
  name: "test",
  kind: "claude-subscription",
  runtime: "claude-code",
  credential: { kind: "claude-config-folder" },
});
for (const mode of [
  "valid",
  "message-missing",
  "steer-missing",
  "invalid-output",
  "input-failed",
  "resume-failed",
  "point-missing",
] as const) {
  // Reason: a completed input turn must resume its exact chain, and output must prove both tokens survived.
  // Invalid or missing receipts must fail without printing or returning the remembered values.
  test(`completed-input smoke resumes in place and reports only counts and booleans: ${mode}`, async () => {
    const firstResult = result({ queued_turn_count: 1 });
    const inputResult =
      mode === "input-failed" ? errorResult("error_max_turns") : result();
    const recallResult =
      mode === "resume-failed" ? errorResult("error_max_turns") : result();
    let messageToken = "";
    let steerToken = "";
    const capture = (message: SDKUserMessage) => {
      if (typeof message.message.content !== "string")
        throw new Error("fixture");
      const token = message.message.content.match(/as ([a-f0-9-]+)\./)?.[1];
      if (token === undefined || message.uuid === undefined)
        throw new Error("fixture");
      if (message.priority === "now") {
        steerToken = token;
        inputResult.user_message_uuids = [message.uuid];
        if (recallResult.subtype === "success")
          recallResult.structured_output =
            mode === "invalid-output"
              ? { messageToken: true }
              : {
                  messageToken:
                    mode === "message-missing" ? "absent" : messageToken,
                  steerToken: mode === "steer-missing" ? "absent" : steerToken,
                };
      } else {
        messageToken = token;
        firstResult.user_message_uuids = [message.uuid];
      }
    };
    const firstReply = assistant(undefined, "fixture");
    firstReply.message.id = "first";
    const lastReply = assistant(undefined, "fixture");
    lastReply.message.id = "last";
    const recallReply = assistant(undefined, "fixture");
    recallReply.message.id = "recall";
    const resumes = mode !== "input-failed" && mode !== "point-missing";
    const entries: Entry[] = [
      out({ type: "query.open" }),
      out({
        type: "prompt.offer",
        message: /^Remember messageToken as [a-f0-9-]+\. Reply briefly\.$/,
        check: capture,
      }),
      out({
        type: "prompt.offer",
        message: /^Remember steerToken as [a-f0-9-]+\. Reply briefly\.$/,
        priority: "now",
        check: capture,
      }),
      ...(mode === "point-missing" ? [] : [inbound(firstReply)]),
      inbound(firstResult),
      ...(mode === "point-missing" ? [] : [inbound(lastReply)]),
      inbound(inputResult),
      out({ type: "query.close" }),
      ...(resumes
        ? [
            out({
              type: "query.open",
              check: (options) => {
                expect(options.resume).toBe(SESSION_ID);
                expect(options.resumeSessionAt).toBe(lastReply.uuid);
                expect(options.forkSession).toBe(false);
              },
            }),
            out({ type: "query.close" }),
            out({
              type: "query.open",
              check: (options) => {
                expect(options.resume).toBe(SESSION_ID);
                expect(options.resumeSessionAt).toBe(lastReply.uuid);
                expect(options.outputFormat).toMatchObject({
                  type: "json_schema",
                });
                expect(JSON.stringify(options.outputFormat)).not.toContain(
                  messageToken,
                );
                expect(JSON.stringify(options.outputFormat)).not.toContain(
                  steerToken,
                );
              },
            }),
            out({
              type: "prompt.offer",
              message:
                "Return the remembered messageToken and steerToken in the requested schema.",
            }),
            inbound(recallReply),
            inbound(recallResult),
            out({ type: "query.close" }),
          ]
        : []),
    ];
    const fake = replay(entries);
    const starts: SessionStart[] = [];
    const counts = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* makeRuntime({
            cwd: "/test",
            environment: {},
            identity: { sessionId: SESSION_ID },
          });
          return yield* checkCompletedInputs(
            {
              ...runtime,
              openSession: (account, policy, start) => {
                starts.push(start);
                expect(policy.tools).toEqual([]);
                expect(Number(policy.turnLimit)).toBe(3);
                return runtime.openSession(account, policy, start);
              },
            },
            account,
          );
        }),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            fake.layer,
            Layer.succeed(ClaudeExecutable, {
              resolve: () => Effect.succeed("/test/claude"),
            }),
            Layer.succeed(ClaudeProcess, {
              run: () => Effect.die("No process allowed"),
            }),
          ),
        ),
        Effect.timeout("3 seconds"),
      ),
    );
    expect(starts).toEqual(
      resumes
        ? [
            { kind: "new" },
            {
              kind: "resume",
              session: SESSION_ID,
              at: lastReply.uuid,
              fork: false,
            },
          ]
        : [{ kind: "new" }],
    );
    expect(messageToken).not.toBe(steerToken);
    expect(counts).toMatchObject({
      inputCompleted: mode !== "input-failed",
      resumeCompleted: resumes && mode !== "resume-failed",
      messageTokenFound:
        resumes &&
        !["message-missing", "invalid-output", "resume-failed"].includes(mode),
      steerTokenFound:
        resumes &&
        !["steer-missing", "invalid-output", "resume-failed"].includes(mode),
      requests: mode === "point-missing" ? 0 : resumes ? 3 : 2,
    });
    expect(
      Object.values(counts).every(
        (value) => typeof value === "boolean" || typeof value === "number",
      ),
    ).toBe(true);
    expect(JSON.stringify(counts)).not.toContain(messageToken);
    expect(JSON.stringify(counts)).not.toContain(steerToken);
  });
}
