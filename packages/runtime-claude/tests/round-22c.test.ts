import { expect, test } from "bun:test";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { Account, TurnLimit, type SessionStart } from "@neuve/runtime";
import { Effect, Layer } from "effect";
import { makeRuntime } from "../src/runtime.ts";
import { ClaudeExecutable, ClaudeProcess } from "../src/services.ts";
import { collect, point } from "../src/smoke-events.ts";
import { assistant, result, SESSION_ID } from "./frames.ts";
import { inbound, out, replay, type Entry } from "./replay.ts";

const account = Account.parse({
  name: "fixture",
  kind: "claude-subscription",
  runtime: "claude-code",
  credential: { kind: "claude-config-folder" },
});
const policy = {
  systemPrompt: "fixture",
  tools: [],
  approvalPolicy: "allow" as const,
  turnLimit: TurnLimit.parse(3),
  outputSchema: { type: "object" },
};
const close = out({ type: "query.close" });
const offer = out({ type: "prompt.offer", message: "fixture" });
const identity = (options: Options) =>
  Object.fromEntries(
    ["sessionId", "resume", "resumeSessionAt", "forkSession"].flatMap((key) =>
      key in options ? [[key, Reflect.get(options, key)]] : [],
    ),
  );

async function scenario(
  start: SessionStart,
  prior: "none" | "normal" | "interrupted" = "none",
) {
  const reply = assistant(undefined);
  const finalReply = assistant(undefined);
  finalReply.message.id = "final-request";
  const finalResult = result({ structured_output: { ok: true } });
  let native = "";
  const entries: Entry[] = [
    out({
      type: "query.open",
      check: (options) => {
        native = options.sessionId ?? options.resume ?? "";
        reply.session_id =
          finalReply.session_id =
          finalResult.session_id =
            native;
      },
    }),
  ];
  if (prior === "normal")
    entries.push(offer, inbound(reply), inbound(result()));
  if (prior === "interrupted") entries.push(offer);
  entries.push(
    close,
    out({ type: "query.open" }),
    offer,
    inbound(finalReply),
    inbound(finalResult),
  );
  if (prior === "interrupted") {
    // Reopening another child proves a successful offer is remembered across child lifetimes.
    entries.push(close, out({ type: "query.open" }), offer, inbound(result()));
  }
  entries.push(close);
  const fake = replay(entries);
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* makeRuntime({
          cwd: "/test",
          environment: {},
          identity: { sessionId: SESSION_ID },
        });
        const session = yield* runtime.openSession(account, policy, start);
        expect(session.nativeSessionId).toBe(native);
        if (prior !== "none") {
          yield* session.startTurn({ turnId: "prior", message: "fixture" });
          if (prior === "interrupted")
            yield* session.interruptTurn({ turnId: "prior", reason: "stop" });
          const events = yield* collect(session);
          expect(events.at(-1)).toMatchObject({
            outcome: {
              status: prior === "normal" ? "completed" : "interrupted",
            },
          });
          expect(point(events)).toBe(
            prior === "normal" ? reply.uuid : undefined,
          );
          expect(fake.opens).toHaveLength(1);
        }
        yield* session.startTurn({
          turnId: "final",
          message: "fixture",
          final: true,
        });
        expect((yield* collect(session)).at(-1)).toMatchObject({
          outcome: { status: "completed", structuredOutput: { ok: true } },
        });
        expect(session.nativeSessionId).toBe(native);
        if (prior === "interrupted") {
          yield* session.startTurn({ turnId: "later", message: "fixture" });
          expect((yield* collect(session)).at(-1)).toMatchObject({
            outcome: { status: "completed" },
          });
          expect(session.nativeSessionId).toBe(native);
        }
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
  expect(fake.opens[1]?.outputFormat).toEqual({
    type: "json_schema",
    schema: policy.outputSchema,
  });
  return {
    opens: fake.opens,
    native,
    point: reply.uuid,
    finalPoint: finalReply.uuid,
  };
}

// Reason: a fresh eager child has no transcript to resume when the first turn is final.
test("R22c first-turn-final keeps the original new identity", async () => {
  const { opens, native } = await scenario({ kind: "new" });
  expect(native).toBe(SESSION_ID);
  expect(identity(opens[1]!)).toEqual({ sessionId: native });
});

for (const at of [undefined, "parent-point"]) {
  // Reason: an unused fork must retain its parent, optional point and chosen child id for the final reopen.
  test(`R22c fork-then-final keeps fork intent ${at === undefined ? "without" : "with"} a parent point`, async () => {
    const { opens, native } = await scenario({
      kind: "resume",
      session: "parent",
      fork: true,
      ...(at === undefined ? {} : { at }),
    });
    expect(native).not.toBe("parent");
    expect(identity(opens[1]!)).toEqual({
      resume: "parent",
      forkSession: true,
      sessionId: native,
      ...(at === undefined ? {} : { resumeSessionAt: at }),
    });
  });
}

// Reason: passes before; a normal fork turn persists the child and the final reopen must resume its point.
test("R22c fork-then-normal resumes the child for its later final", async () => {
  const { opens, native, point } = await scenario(
    { kind: "resume", session: "parent", at: "parent-point", fork: true },
    "normal",
  );
  expect(identity(opens[0]!)).toEqual({
    resume: "parent",
    resumeSessionAt: "parent-point",
    forkSession: true,
    sessionId: native,
  });
  expect(identity(opens[1]!)).toEqual({
    resume: native,
    resumeSessionAt: point,
  });
});

// Reason: passes before; a normal new-session turn must keep the existing resume and usage behavior.
test("R22c normal-then-final resumes the new session at its point", async () => {
  const { opens, native, point } = await scenario({ kind: "new" }, "normal");
  expect(identity(opens[1]!)).toEqual({
    resume: native,
    resumeSessionAt: point,
  });
});

// Reason: an unused non-fork resume retains the exact opened identity, including explicit forkSession false.
test("R22c resume-then-final keeps the opened resume identity", async () => {
  const { opens, native } = await scenario({
    kind: "resume",
    session: "parent",
    at: "parent-point",
    fork: false,
  });
  expect(native).toBe("parent");
  expect(identity(opens[1]!)).toEqual({
    resume: "parent",
    resumeSessionAt: "parent-point",
    forkSession: false,
  });
});

// Reason: passes before; a successful offer can persist without a reply and must enable resume for every later child.
test("R22c an offered turn without a reply permanently enables resume", async () => {
  const { opens, native, finalPoint } = await scenario(
    { kind: "resume", session: "parent", fork: true },
    "interrupted",
  );
  expect(identity(opens[1]!)).toEqual({ resume: native });
  expect(identity(opens[2]!)).toEqual({
    resume: native,
    resumeSessionAt: finalPoint,
  });
});
