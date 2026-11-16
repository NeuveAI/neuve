import { TurnLimit, type Account } from "@neuve/runtime";
import { Effect, Logger, Stream, type Cause } from "effect";
import { diagnoseObservation, failureShape } from "./smoke-diagnose.ts";
import { smokeToolName } from "./smoke-frame-shapes.ts";
import { toolOutputObservation, type SmokeRuntime } from "./smoke-runtime.ts";
import { checkProbe } from "./smoke-checks.ts";
import { checkTools } from "./smoke-tools.ts";
import { collect, completed, requests, protocolError } from "./smoke-events.ts";
import { recordFixture } from "./smoke-fixture-recorder.ts";

export const toolsDiagnosis = ({
  multiRound = false,
  record = false,
}: { multiRound?: boolean; record?: boolean } = {}) => {
  const fixtureFrames: unknown[] = [];
  const fixtureSends: string[] = [];
  const mode = multiRound
    ? ("diagnose-tools-multi-round" as const)
    : ("diagnose-tools" as const);
  const requestCap = multiRound ? 4 : 2;
  const observation = diagnoseObservation({ tools: true });
  const tools = toolOutputObservation();
  const permissions: Array<{
    tool: ReturnType<typeof smokeToolName>;
    behavior: "allow" | "deny";
  }> = [];
  const handlers = {
    note: { calls: 0, returnedError: false },
    finish: { calls: 0, returnedError: false },
  };
  let step: "probe" | "tools" = "probe";
  let stoppedAtCap = false;
  let stop: Effect.Effect<void> = Effect.void;
  let ending: ReturnType<typeof observation.event>;
  const counts = () => ({
    expectedRequests: multiRound ? 3 : 1,
    requestsStarted: observation.totalRequestsStarted,
    requestsCompleted: observation.totalRequestsCompleted,
    withinPlan: observation.totalRequestsStarted <= requestCap,
    stoppedAtCap,
  });
  const snapshot = () => ({
    ...ending,
    ...observation.partial(),
    ...(ending?.firedPath === "unclassified" &&
    permissions.some(
      (call) =>
        call.behavior === "deny" &&
        (call.tool === "other" || call.tool === "StructuredOutput"),
    )
      ? { firedPath: "canUseToolUnknown" }
      : {}),
    canUseTool: [...permissions],
    handlers,
  });
  const thisObservation = {
    ...observation,
    begin: () => {
      observation.begin();
      observation.allowNormalSend();
      tools.begin();
    },
    finish: tools.finish,
    discardSteer: tools.discardSteer,
    get extraRequest() {
      return tools.extraRequest;
    },
    get discardedSteerAbsent() {
      return tools.discardedSteerAbsent;
    },
    get discardedSteerNotOffered() {
      return tools.discardedSteerNotOffered;
    },
    offered: (message: Parameters<typeof observation.offered>[0]) => {
      if (record && step === "tools" && message.uuid !== undefined)
        fixtureSends.push(message.uuid);
      observation.observe(() => {
        observation.offered(message);
        tools.offered(message);
      });
    },
    receive: (frame: Parameters<typeof observation.receive>[0]) => {
      if (record && step === "tools") fixtureFrames.push(frame);
      observation.observe(() => {
        observation.receive(frame);
        tools.receive(frame);
      });
    },
    permission: (name: string, behavior: "allow" | "deny") =>
      observation.observe(() => {
        permissions.push({ tool: smokeToolName(name), behavior });
      }),
    afterReceive: () => {
      if (
        step !== "tools" ||
        stoppedAtCap ||
        observation.totalRequestsStarted <= requestCap
      )
        return Effect.void;
      stoppedAtCap = true;
      return stop;
    },
  };
  return {
    fixture: () => recordFixture(fixtureFrames, fixtureSends),
    observation: thisObservation,
    failure: (cause: Cause.Cause<unknown>) => ({
      mode,
      outcome: "failed" as const,
      step,
      ...failureShape(cause),
      ...counts(),
      tools: snapshot(),
    }),
    run: (runtime: SmokeRuntime, account: Account) =>
      Effect.gen(function* () {
        const probe = yield* checkProbe(runtime, account);
        step = "tools";
        const observed: SmokeRuntime = {
          ...runtime,
          openSession: (account, policy, start) =>
            Effect.gen(function* () {
              const scope = yield* Effect.scope;
              observation.toolPolicy(policy.tools);
              const session = yield* runtime.openSession(
                account,
                {
                  ...policy,
                  tools: policy.tools.map((tool) => ({
                    ...tool,
                    handle: (input, call) =>
                      Effect.sync(() =>
                        observation.observe(() => {
                          const handler =
                            tool.name === "note"
                              ? handlers.note
                              : handlers.finish;
                          handler.calls++;
                          if (call !== undefined)
                            observation.handler(call.callId);
                        }),
                      ).pipe(
                        Effect.andThen(tool.handle(input, call)),
                        Effect.tap((outcome) =>
                          Effect.sync(() =>
                            observation.observe(() => {
                              const handler =
                                tool.name === "note"
                                  ? handlers.note
                                  : handlers.finish;
                              handler.returnedError ||=
                                outcome.error !== undefined;
                            }),
                          ),
                        ),
                      ),
                  })),
                },
                start,
              );
              // The interrupt owns a sibling fiber: child disposal can cancel the blocked reader without waiting on itself.
              stop = session
                .interruptTurn({ turnId: "smoke-tools", reason: "cutoff" })
                .pipe(
                  Effect.catchCause(() => Effect.void),
                  Effect.forkIn(scope),
                  Effect.andThen(Effect.never),
                );
              return {
                ...session,
                get nativeSessionId() {
                  return session.nativeSessionId;
                },
                events: session.events.pipe(
                  Stream.tap((event) =>
                    Effect.sync(() => {
                      if (
                        event.type === "tool.finished" &&
                        (event.toolName === "note" ||
                          event.toolName === "finish")
                      )
                        handlers[event.toolName].returnedError ||=
                          event.errored;
                      const diagnosis = observation.event(event);
                      if (diagnosis !== undefined) ending = diagnosis;
                    }),
                  ),
                ),
              };
            }),
        };
        const checks = yield* multiRound
          ? checkMultiRoundTools(observed, account, thisObservation)
          : checkTools(observed, account, thisObservation);
        return {
          mode,
          probe: probe.counts,
          tools: { ...snapshot(), checks },
          ...counts(),
        };
      }).pipe(
        Effect.provide(
          Logger.layer([observation.logger], { mergeWithExisting: true }),
        ),
      ),
  };
};

const multiRoundPrompt =
  "Call note once in your first response. After its result, call note twice in parallel in your second response. After both results, call finish once in your third response. Do not finish before both rounds of note calls have returned.";
export const checkMultiRoundTools = (
  runtime: SmokeRuntime,
  account: Account,
  observation: Pick<
    ReturnType<typeof toolsDiagnosis>["observation"],
    "begin" | "finish"
  >,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      observation.begin();
      let noteCalls = 0;
      let finishCalls = 0;
      const hints = {
        readOnly: true,
        destructive: false,
        idempotent: true,
        openWorld: false,
      };
      const inputSchema = {
        type: "object" as const,
        properties: {},
        additionalProperties: false,
      };
      const session = yield* runtime.openSession(
        account,
        {
          systemPrompt: multiRoundPrompt,
          approvalPolicy: "allow",
          turnLimit: TurnLimit.parse(4),
          tools: [
            {
              name: "note",
              description: "Return a non-ending result for the next response.",
              hints,
              inputSchema,
              handle: () =>
                Effect.sync(() => {
                  noteCalls++;
                  return {
                    text:
                      noteCalls === 1
                        ? "Now call note twice in parallel in the same response."
                        : "After both parallel note results, call finish.",
                  };
                }),
            },
            {
              name: "finish",
              description:
                "Finish after one note call, then two parallel note calls.",
              hints,
              inputSchema,
              handle: () =>
                Effect.sync(() => {
                  finishCalls++;
                  observation.finish();
                  return { text: "Finished.", endTurn: true };
                }),
            },
          ],
        },
        { kind: "new" },
      );
      yield* session.startTurn({
        turnId: "smoke-tools",
        message: multiRoundPrompt,
      });
      const events = yield* collect(session);
      const rounds = events.filter(
        (event) => event.type === "message.finished",
      );
      return {
        toolsCompleted: completed(events),
        noteCalls,
        finishCalls,
        threeResponses: requests(events) === 3,
        roundOneSingle:
          rounds[0]?.toolCalls.length === 1 &&
          rounds[0].toolCalls[0]?.toolName === "note",
        roundTwoParallel:
          rounds[1]?.toolCalls.length === 2 &&
          rounds[1].toolCalls.every((call) => call.toolName === "note"),
        roundThreeFinish:
          rounds[2]?.toolCalls.length === 1 &&
          rounds[2].toolCalls[0]?.toolName === "finish",
        protocolError: protocolError(events),
      };
    }),
  );
