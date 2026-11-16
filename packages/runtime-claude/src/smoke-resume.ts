import {
  TurnLimit,
  type Account,
  type RuntimeShape,
  type SessionPolicy,
} from "@neuve/runtime";
import { Effect } from "effect";
import {
  collect,
  point,
  completed,
  requests,
  protocolError,
} from "./smoke-events.ts";
import { z } from "zod";

const tokenSchema = z.strictObject({
  messageToken: z.string(),
  steerToken: z.string(),
});
const policy: SessionPolicy = {
  systemPrompt:
    "Remember the named tokens in this conversation. Return them when asked.",
  tools: [],
  approvalPolicy: "allow",
  turnLimit: TurnLimit.parse(3),
  outputSchema: z
    .record(z.string(), z.json())
    .parse(z.toJSONSchema(tokenSchema)),
};
interface RecallSource {
  readonly session: string;
  readonly at: string;
  readonly messageToken: string;
  readonly steerToken: string;
}

const completedInputs = (runtime: RuntimeShape, account: Account) =>
  Effect.gen(function* () {
    const messageToken = crypto.randomUUID();
    const steerToken = crypto.randomUUID();
    const stored = yield* Effect.scoped(
      Effect.gen(function* () {
        const session = yield* runtime.openSession(account, policy, {
          kind: "new",
        });
        yield* session.startTurn({
          turnId: "smoke-inputs",
          message: `Remember messageToken as ${messageToken}. Reply briefly.`,
        });
        yield* session.steerTurn({
          turnId: "smoke-inputs",
          message: `Remember steerToken as ${steerToken}. Reply briefly.`,
        });
        const events = yield* collect(session);
        return { events, session: session.nativeSessionId, at: point(events) };
      }),
    );
    const inputCompleted = completed(stored.events);
    const counts = {
      inputCompleted,
      protocolError: protocolError(stored.events),
      resumeCompleted: false,
      messageTokenFound: false,
      steerTokenFound: false,
      requests: requests(stored.events),
      withinPlan: requests(stored.events) <= 3,
      events: stored.events.length,
    };
    if (!inputCompleted || stored.at === undefined)
      return { counts, source: undefined };
    // Close the writer before reopening its persisted chain in place.
    const resumed = yield* Effect.scoped(
      Effect.gen(function* () {
        const session = yield* runtime.openSession(account, policy, {
          kind: "resume",
          session: stored.session,
          at: stored.at,
          fork: false,
        });
        yield* session.startTurn({
          turnId: "smoke-resumed-inputs",
          message:
            "Return the remembered messageToken and steerToken in the requested schema.",
          final: true,
        });
        const events = yield* collect(session);
        const end = events.findLast((event) => event.type === "turn.finished");
        const output = tokenSchema.safeParse(
          end?.outcome.status === "completed"
            ? end.outcome.structuredOutput
            : undefined,
        );
        return {
          counts: {
            inputCompleted,
            protocolError: counts.protocolError || protocolError(events),
            resumeCompleted: completed(events),
            messageTokenFound:
              output.success && output.data.messageToken === messageToken,
            steerTokenFound:
              output.success && output.data.steerToken === steerToken,
            requests: counts.requests + requests(events),
            withinPlan: counts.requests + requests(events) <= 3,
            events: counts.events + events.length,
          },
          session: session.nativeSessionId,
          at: point(events),
        };
      }),
    );
    return {
      counts: resumed.counts,
      source:
        resumed.counts.resumeCompleted && resumed.at !== undefined
          ? {
              session: resumed.session,
              at: resumed.at,
              messageToken,
              steerToken,
            }
          : undefined,
    };
  });

/** The summary never contains the tokens or the continuation identity. */
export const checkCompletedInputs = (runtime: RuntimeShape, account: Account) =>
  completedInputs(runtime, account).pipe(Effect.map((result) => result.counts));

export const checkForkPersistence = (
  runtime: RuntimeShape,
  account: Account,
  source: RecallSource | undefined,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      if (source === undefined)
        return {
          forkCompleted: false,
          messageTokenFound: false,
          steerTokenFound: false,
          nativeSessionIdDiffers: false,
          protocolError: false,
          requests: 0,
          withinPlan: true,
          events: 0,
        };
      const session = yield* runtime.openSession(account, policy, {
        kind: "resume",
        session: source.session,
        at: source.at,
        fork: true,
      });
      yield* session.startTurn({
        turnId: "smoke-fork",
        final: true,
        message:
          "Return the remembered messageToken and steerToken in the requested schema.",
      });
      const events = yield* collect(session);
      const end = events.findLast((event) => event.type === "turn.finished");
      const output = tokenSchema.safeParse(
        end?.outcome.status === "completed"
          ? end.outcome.structuredOutput
          : undefined,
      );
      return {
        forkCompleted: completed(events),
        protocolError: protocolError(events),
        messageTokenFound:
          output.success && output.data.messageToken === source.messageToken,
        steerTokenFound:
          output.success && output.data.steerToken === source.steerToken,
        nativeSessionIdDiffers: session.nativeSessionId !== source.session,
        requests: requests(events),
        withinPlan: requests(events) <= 1,
        events: events.length,
      };
    }),
  );

/** Run the fork only after the resumed writer has closed. */
export const checkPersistence = (runtime: RuntimeShape, account: Account) =>
  Effect.gen(function* () {
    const resumed = yield* completedInputs(runtime, account);
    const fork = yield* checkForkPersistence(runtime, account, resumed.source);
    return { inputs: resumed.counts, fork };
  });
