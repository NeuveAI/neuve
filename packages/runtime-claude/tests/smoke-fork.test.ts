import { expect, test } from "bun:test";
import { Effect, Stream } from "effect";
import { checkForkPersistence, checkPersistence } from "../src/smoke-resume.ts";
import { assistant, errorResult, result, SESSION_ID } from "./frames.ts";
import { inbound, out, type Entry } from "./replay.ts";
import { account, runReplay } from "./smoke-fixture.ts";

const source = {
  session: SESSION_ID,
  at: "resumed-final-point",
  messageToken: "message-fixture",
  steerToken: "steer-fixture",
};
const recall =
  "Return the remembered messageToken and steerToken in the requested schema.";

// Reason: a fork must use the resumed chain, retain both inputs and acquire a new session identity.
for (const mode of [
  "valid",
  "same-id",
  "message-missing",
  "steer-missing",
  "invalid-output",
  "fork-failed",
  "source-missing",
  "protocol-error",
] as const) {
  test(`smoke fork: ${mode}`, async () => {
    const reply = assistant(undefined);
    let forkId: string | undefined;
    const entries: Entry[] =
      mode === "source-missing"
        ? []
        : [
            out({
              type: "query.open",
              check: (options) => {
                expect(options.resume).toBe(source.session);
                expect(options.resumeSessionAt).toBe(source.at);
                expect(options.forkSession).toBe(true);
                expect(options.model).toBeUndefined();
                expect(options.sessionId).not.toBe(source.session);
                forkId = options.sessionId;
              },
            }),
            out({ type: "query.close" }),
            out({
              type: "query.open",
              check: (options) => {
                expect(options.resume).toBe(source.session);
                expect(options.sessionId).toBe(forkId);
                expect(options.resumeSessionAt).toBe(source.at);
                expect(options.forkSession).toBe(true);
                expect(options.outputFormat?.type).toBe("json_schema");
                expect(JSON.stringify(options.outputFormat)).not.toContain(
                  source.messageToken,
                );
                expect(JSON.stringify(options.outputFormat)).not.toContain(
                  source.steerToken,
                );
              },
            }),
            out({ type: "prompt.offer", message: recall }),
            inbound(reply),
            ...(mode === "protocol-error"
              ? [
                  inbound({
                    type: "stream_event",
                    parent_tool_use_id: null,
                    uuid: crypto.randomUUID(),
                    session_id: SESSION_ID,
                    event: { type: "message_stop" },
                  }),
                  inbound(reply),
                ]
              : [
                  inbound(
                    mode === "fork-failed"
                      ? errorResult("error_max_turns")
                      : result({
                          structured_output:
                            mode === "invalid-output"
                              ? {}
                              : {
                                  messageToken:
                                    mode === "message-missing"
                                      ? "absent"
                                      : source.messageToken,
                                  steerToken:
                                    mode === "steer-missing"
                                      ? "absent"
                                      : source.steerToken,
                                },
                        }),
                  ),
                ]),
            out({ type: "query.close" }),
          ];
    const counts = await runReplay(entries, (runtime) =>
      checkForkPersistence(
        {
          ...runtime,
          openSession: (account, policy, start) =>
            runtime.openSession(account, policy, start).pipe(
              Effect.map(
                (session) =>
                  new Proxy(session, {
                    get(target, key) {
                      return key === "nativeSessionId"
                        ? mode === "same-id"
                          ? source.session
                          : "fork-session"
                        : Reflect.get(target, key);
                    },
                  }),
              ),
            ),
        },
        account,
        mode === "source-missing" ? undefined : source,
      ),
    );
    expect(counts).toMatchObject({
      forkCompleted: ![
        "fork-failed",
        "source-missing",
        "protocol-error",
      ].includes(mode),
      messageTokenFound: ![
        "message-missing",
        "invalid-output",
        "fork-failed",
        "source-missing",
        "protocol-error",
      ].includes(mode),
      steerTokenFound: ![
        "steer-missing",
        "invalid-output",
        "fork-failed",
        "source-missing",
        "protocol-error",
      ].includes(mode),
      protocolError: mode === "protocol-error",
      nativeSessionIdDiffers: mode !== "same-id" && mode !== "source-missing",
      requests: mode === "source-missing" ? 0 : 1,
    });
  });
}

// Reason: the combined runner must fork from the final point published by the in-place resumed session, after closing it.
test("smoke persistence shares the in-place resumed session with the fork", async () => {
  let messageToken = "";
  let steerToken = "";
  const first = result({ queued_turn_count: 1 });
  const second = result();
  const resumed = result();
  const forked = result();
  const firstReply = assistant(undefined);
  firstReply.message.id = "input-first";
  const lastReply = assistant(undefined);
  lastReply.message.id = "input-last";
  const resumedReply = assistant(undefined);
  resumedReply.message.id = "resumed";
  const forkReply = assistant(undefined);
  forkReply.message.id = "fork";
  const resumeCarrier = "resumed-carrier";
  let forkId: string | undefined;
  const entries: Entry[] = [
    out({ type: "query.open" }),
    out({
      type: "prompt.offer",
      message: /^Remember messageToken as /,
      check: (message) => {
        messageToken =
          String(message.message.content).match(/as ([a-f0-9-]+)\./)?.[1] ?? "";
        first.user_message_uuids = [message.uuid!];
      },
    }),
    out({
      type: "prompt.offer",
      message: /^Remember steerToken as /,
      priority: "now",
      check: (message) => {
        steerToken =
          String(message.message.content).match(/as ([a-f0-9-]+)\./)?.[1] ?? "";
        second.user_message_uuids = [message.uuid!];
        resumed.structured_output = forked.structured_output = {
          messageToken,
          steerToken,
        };
      },
    }),
    inbound(firstReply),
    inbound(first),
    inbound(lastReply),
    inbound(second),
    out({ type: "query.close" }),
    out({
      type: "query.open",
      check: (options) => {
        expect(options.resume).toBe(SESSION_ID);
        expect(options.resumeSessionAt).toBe(lastReply.uuid);
        expect(options.forkSession).toBe(false);
      },
    }),
    out({ type: "query.close" }),
    out({ type: "query.open" }),
    out({ type: "prompt.offer", message: recall }),
    inbound(resumedReply),
    inbound(resumed),
    out({ type: "query.close" }),
    out({
      type: "query.open",
      check: (options) => {
        expect(options.resume).toBe("resumed-session");
        expect(options.resumeSessionAt).toBe(resumeCarrier);
        expect(options.forkSession).toBe(true);
        forkId = options.sessionId;
      },
    }),
    out({ type: "query.close" }),
    out({
      type: "query.open",
      check: (options) => {
        expect(options.resume).toBe("resumed-session");
        expect(options.sessionId).toBe(forkId);
        expect(options.resumeSessionAt).toBe(resumeCarrier);
        expect(options.forkSession).toBe(true);
      },
    }),
    out({ type: "prompt.offer", message: recall }),
    inbound(forkReply),
    inbound(forked),
    out({ type: "query.close" }),
  ];
  const counts = await runReplay(entries, (runtime) =>
    checkPersistence(
      {
        ...runtime,
        openSession: (account, policy, start) =>
          runtime.openSession(account, policy, start).pipe(
            Effect.map(
              (session) =>
                new Proxy(session, {
                  get(target, key) {
                    if (key === "nativeSessionId")
                      return start.kind === "resume"
                        ? start.fork
                          ? "fork-session"
                          : "resumed-session"
                        : target.nativeSessionId;
                    if (
                      key === "events" &&
                      start.kind === "resume" &&
                      !start.fork
                    )
                      return target.events.pipe(
                        Stream.map((event) =>
                          event.type === "turn.finished"
                            ? { ...event, resumePoint: resumeCarrier }
                            : event,
                        ),
                      );
                    return Reflect.get(target, key);
                  },
                }),
            ),
          ),
      },
      account,
    ),
  );
  expect(counts.inputs).toMatchObject({
    inputCompleted: true,
    resumeCompleted: true,
    messageTokenFound: true,
    steerTokenFound: true,
    requests: 3,
  });
  expect(counts.fork).toMatchObject({
    forkCompleted: true,
    messageTokenFound: true,
    steerTokenFound: true,
    nativeSessionIdDiffers: true,
    requests: 1,
  });
  expect(messageToken).not.toBe(steerToken);
});
