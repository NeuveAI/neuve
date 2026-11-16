import { expect, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { RuntimeEvent } from "@neuve/runtime";
import { Effect, Stream } from "effect";
import { toolOutputObservation } from "../src/smoke-runtime.ts";
import { checkTools } from "../src/smoke-tools.ts";
import { assistant, errorResult, result, SESSION_ID } from "./frames.ts";
import { inbound, out, type Entry } from "./replay.ts";
import { account, runReplay } from "./smoke-fixture.ts";

const carrier = (callId: string): SDKMessage => ({
  type: "user",
  uuid: crypto.randomUUID(),
  session_id: SESSION_ID,
  parent_tool_use_id: null,
  message: {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: callId, content: "fixture" }],
  },
});
const schemas = {
  note: { type: "object", properties: {}, additionalProperties: false },
  finish: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: { steerToken: { type: "string" } },
    required: ["steerToken"],
    additionalProperties: false,
  },
};

// Reason: a held steer must reach finish, and endTurn must end after exactly two balanced tool-use messages.
for (const mode of [
  "valid",
  "turn-failed",
  "carrier-missing",
  "token-missing",
  "request-after-finish",
  "unbalanced",
  "duplicate-finish",
  "protocol-error",
  "no-note",
  "no-finish",
  "steer-failed",
  "provider-request-after-finish",
  "discarded-token-later",
  "discarded-offered",
] as const) {
  test(`smoke tools: ${mode}`, async () => {
    const observation = toolOutputObservation();
    let token = "";
    const toolCarrier = carrier("finish-call");
    const lastResult = result();
    let steers = 0;
    const schemasCheck = { schemas };
    const entries: Entry[] = [
      out({
        type: "query.open",
        check: (options) => {
          expect(options.model).toBeUndefined();
          expect(options.maxTurns).toBeUndefined();
        },
      }),
      out({
        type: "prompt.offer",
        message:
          "Call note once, then finish once with the steerToken supplied while note runs.",
      }),
      ...(mode === "turn-failed"
        ? [inbound(errorResult("error_max_turns"))]
        : [
            ...(mode === "no-note"
              ? []
              : [
                  {
                    type: "smoke.tool.calls",
                    ...schemasCheck,
                    calls: [{ name: "note", callId: "note-call", input: {} }],
                  } satisfies Entry,
                  ...(mode === "steer-failed"
                    ? []
                    : [
                        out({
                          type: "prompt.offer",
                          message: /^Use steerToken as /,
                          priority: "now",
                          check: (message) => {
                            token =
                              String(message.message.content).match(
                                /as ([a-f0-9-]+)\./,
                              )?.[1] ?? "";
                            expect(token.length).toBeGreaterThan(0);
                          },
                        }),
                      ]),
                  inbound(carrier("note-call")),
                ]),
            ...(mode === "no-finish"
              ? [inbound(assistant(undefined)), inbound(result())]
              : [
                  {
                    type: "smoke.tool.calls",
                    ...schemasCheck,
                    calls: [
                      {
                        name: "finish",
                        callId: "finish-call",
                        get input() {
                          return {
                            steerToken:
                              mode === "token-missing" ? "absent" : token,
                          };
                        },
                      },
                    ],
                  } satisfies Entry,
                  ...(mode === "discarded-offered"
                    ? [
                        out({
                          type: "prompt.offer",
                          message: /^Discard steerToken as /,
                          priority: "now",
                        }),
                      ]
                    : []),
                  inbound(toolCarrier),
                  ...(mode === "provider-request-after-finish"
                    ? [inbound(assistant(undefined))]
                    : [inbound(lastResult)]),
                ]),
          ]),
      out({ type: "query.close" }),
    ];
    const counts = await runReplay(
      entries,
      (runtime) =>
        checkTools(
          {
            ...runtime,
            openSession: (account, policy, start) => {
              expect(Number(policy.turnLimit)).toBe(3);
              expect(policy.tools.map((tool) => tool.name)).toEqual([
                "note",
                "finish",
              ]);
              if (mode === "discarded-offered")
                policy = {
                  ...policy,
                  tools: policy.tools.map((tool) =>
                    tool.name !== "finish"
                      ? tool
                      : {
                          ...tool,
                          handle: (input, call) =>
                            tool
                              .handle(input, call)
                              .pipe(
                                Effect.map(
                                  ({ endTurn: _endTurn, ...output }) => output,
                                ),
                              ),
                        },
                  ),
                };
              return runtime.openSession(account, policy, start).pipe(
                Effect.map(
                  (session) =>
                    new Proxy(session, {
                      get(target, key) {
                        if (
                          key === "steerTurn" &&
                          mode === "discarded-token-later"
                        )
                          return (
                            input: Parameters<typeof target.steerTurn>[0],
                          ) => {
                            if (++steers === 2)
                              lastResult.result = String(input.message);
                            return target.steerTurn(input);
                          };
                        if (key === "steerTurn" && mode === "steer-failed")
                          return () => Effect.fail({ _tag: "fixture" });
                        if (key !== "events") return Reflect.get(target, key);
                        return target.events.pipe(
                          Stream.flatMap(
                            (event): Stream.Stream<RuntimeEvent> => {
                              if (
                                event.type === "tool.finished" &&
                                mode === "unbalanced" &&
                                event.toolName === "finish"
                              )
                                return Stream.empty;
                              if (
                                event.type === "tool.finished" &&
                                mode === "duplicate-finish" &&
                                event.toolName === "finish"
                              )
                                return Stream.fromIterable([event, event]);
                              if (event.type === "turn.finished") {
                                if (mode === "carrier-missing")
                                  return Stream.succeed({
                                    ...event,
                                    resumePoint: undefined,
                                  });
                                if (mode === "protocol-error")
                                  return Stream.succeed({
                                    ...event,
                                    outcome: {
                                      status: "failed",
                                      disposition: "broken",
                                      failure: {
                                        _tag: "TurnFailed",
                                        account: account.name,
                                        reason: "protocol-error",
                                      },
                                    },
                                  });
                                if (mode === "request-after-finish")
                                  return Stream.fromIterable([
                                    {
                                      type: "message.finished",
                                      turnId: event.turnId,
                                      at: event.at,
                                      messageId: "extra",
                                      resumePoint: "extra",
                                      stopReason: "end-turn",
                                      toolCalls: [],
                                    },
                                    event,
                                  ]);
                              }
                              return Stream.succeed(event);
                            },
                          ),
                        );
                      },
                    }),
                ),
              );
            },
          },
          account,
          observation,
        ),
      observation,
    );
    expect(counts).toMatchObject({
      discardedSteerAbsent: mode !== "discarded-token-later",
      discardedSteers: [
        "turn-failed",
        "no-finish",
        "steer-failed",
        "discarded-offered",
      ].includes(mode)
        ? 0
        : 1,
      discardedSteerNotOffered: mode !== "discarded-offered",
    });
    expect(counts.toolsCompleted).toBe(
      !["turn-failed", "protocol-error"].includes(mode),
    );
    expect(counts.carrierPresent).toBe(
      !["turn-failed", "carrier-missing", "no-finish"].includes(mode),
    );
    expect(counts.noteCalledOnce).toBe(
      !["turn-failed", "no-note"].includes(mode),
    );
    expect(counts.finishCalledOnce).toBe(
      !["turn-failed", "no-finish"].includes(mode),
    );
    expect(counts.steerAccepted).toBe(
      !["turn-failed", "no-note", "steer-failed"].includes(mode),
    );
    expect(counts.finishReceivedSteerToken).toBe(
      ![
        "turn-failed",
        "no-note",
        "no-finish",
        "token-missing",
        "steer-failed",
      ].includes(mode),
    );
    expect(counts.twoMessages).toBe(
      !["turn-failed", "no-note", "request-after-finish"].includes(mode),
    );
    expect(counts.noRequestAfterFinish).toBe(
      ![
        "turn-failed",
        "no-note",
        "request-after-finish",
        "provider-request-after-finish",
        "discarded-offered",
      ].includes(mode),
    );
    expect(counts.balancedTools).toBe(
      !["turn-failed", "unbalanced", "duplicate-finish"].includes(mode),
    );
    expect(counts.protocolError).toBe(mode === "protocol-error");
    expect(counts.requests).toBe(
      mode === "turn-failed"
        ? 0
        : mode === "no-note"
          ? 1
          : mode === "request-after-finish"
            ? 3
            : 2,
    );
  });
}
