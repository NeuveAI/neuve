import {
  TurnLimit,
  type Account,
  type RuntimeEvent,
  type RuntimeSession,
} from "@neuve/runtime";
import { Deferred, Effect } from "effect";
import { z } from "zod";
import type { SmokeRuntime, ToolOutputObservation } from "./smoke-runtime.ts";
import { collect, completed, protocolError, requests } from "./smoke-events.ts";

const hints = {
  readOnly: true,
  destructive: false,
  idempotent: true,
  openWorld: false,
};

export const checkTools = (
  runtime: SmokeRuntime,
  account: Account,
  observation?: Omit<ToolOutputObservation, "offered" | "receive">,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      observation?.begin();
      const token = crypto.randomUUID();
      const discardedToken = crypto.randomUUID();
      const ready = yield* Deferred.make<RuntimeSession>();
      let noteCalls = 0;
      let finishCalls = 0;
      let steerAccepted = false;
      let discardedSteerAccepted = false;
      let discardedSteerAbsentFromTools = true;
      let finishReceivedSteerToken = false;
      const finishInput = z.strictObject({ steerToken: z.string() });
      const session = yield* runtime.openSession(
        account,
        {
          systemPrompt:
            "Call note once, wait for its result and the steering message, then call finish once with the steerToken from that message. Never call both tools in the same response.",
          approvalPolicy: "allow",
          turnLimit: TurnLimit.parse(3),
          tools: [
            {
              name: "note",
              description: "Continue after receiving a steering message.",
              hints,
              inputSchema: {
                type: "object",
                properties: {},
                additionalProperties: false,
              },
              handle: (input) =>
                Effect.gen(function* () {
                  if (JSON.stringify(input).includes(discardedToken))
                    discardedSteerAbsentFromTools = false;
                  noteCalls++;
                  const active = yield* Deferred.await(ready);
                  steerAccepted = yield* active
                    .steerTurn({
                      turnId: "smoke-tools",
                      message: `Use steerToken as ${token}. Call finish with this token in steerToken.`,
                    })
                    .pipe(
                      Effect.match({
                        onSuccess: () => true,
                        onFailure: () => false,
                      }),
                    );
                  return {
                    text: "Continue with the steering message, then call finish.",
                  };
                }),
            },
            {
              name: "finish",
              description: "Finish with the steering message's token.",
              hints,
              inputSchema: z
                .record(z.string(), z.json())
                .parse(z.toJSONSchema(finishInput)),
              handle: (input) =>
                Effect.gen(function* () {
                  finishCalls++;
                  if (JSON.stringify(input).includes(discardedToken))
                    discardedSteerAbsentFromTools = false;
                  observation?.finish();
                  const parsed = finishInput.safeParse(input);
                  finishReceivedSteerToken =
                    parsed.success && parsed.data.steerToken === token;
                  observation?.discardSteer(discardedToken);
                  const active = yield* Deferred.await(ready);
                  discardedSteerAccepted = yield* active
                    .steerTurn({
                      turnId: "smoke-tools",
                      message: `Discard steerToken as ${discardedToken}. This steer must be held until finish settles.`,
                    })
                    .pipe(
                      Effect.match({
                        onSuccess: () => true,
                        onFailure: () => false,
                      }),
                    );
                  return { text: "Finished.", endTurn: true };
                }),
            },
          ],
        },
        { kind: "new" },
      );
      yield* Deferred.succeed(ready, session);
      yield* session.startTurn({
        turnId: "smoke-tools",
        message:
          "Call note once, then finish once with the steerToken supplied while note runs.",
      });
      const events = yield* collect(session);
      const diagnostics = yield* session.diagnostics;
      const end = events.findLast((event) => event.type === "turn.finished");
      return {
        toolsCompleted: completed(events),
        carrierPresent: end?.resumePoint !== undefined,
        noteCalledOnce: noteCalls === 1,
        finishCalledOnce: finishCalls === 1,
        steerAccepted,
        finishReceivedSteerToken,
        discardedSteerAccepted,
        discardedSteerAbsent:
          discardedSteerAbsentFromTools &&
          !events.some((event) =>
            JSON.stringify(event).includes(discardedToken),
          ) &&
          observation?.discardedSteerAbsent !== false,
        discardedSteerNotOffered:
          observation?.discardedSteerNotOffered !== false,
        discardedSteers: diagnostics.discardedSteers,
        oneDiscardedSteer: diagnostics.discardedSteers === 1,
        twoMessages: requests(events) === 2,
        noRequestAfterFinish:
          requests(events) === 2 &&
          observation?.extraRequest !== true &&
          observation?.discardedSteerNotOffered !== false,
        balancedTools: balancedToolEvents(events),
        protocolError: protocolError(events),
        requests: requests(events),
        withinPlan: requests(events) <= 2,
        events: events.length,
      };
    }),
  );

const balancedToolEvents = (events: readonly RuntimeEvent[]) => {
  const calls = new Map<string, { starts: number; finishes: number }>();
  for (const event of events) {
    if (event.type !== "tool.started" && event.type !== "tool.finished")
      continue;
    const call = calls.get(event.callId) ?? { starts: 0, finishes: 0 };
    if (event.type === "tool.started") call.starts++;
    else call.finishes++;
    calls.set(event.callId, call);
  }
  return (
    calls.size > 0 &&
    [...calls.values()].every(
      (call) => call.starts === 1 && call.finishes === 1,
    )
  );
};
