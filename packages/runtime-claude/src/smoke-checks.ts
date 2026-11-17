import { TurnLimit, type Account, type RuntimeShape } from "@neuve/runtime";
import { Effect } from "effect";
import { z } from "zod";
import { collect, completed, protocolError, requests } from "./smoke-events.ts";
import { FINAL_TURN_MESSAGES } from "./session.ts";

export const checkProbe = (runtime: RuntimeShape, account: Account) =>
  Effect.gen(function* () {
    const probe = yield* runtime.probe(account);
    const first = probe.models?.[0];
    return {
      counts: {
        modelsPresent: (probe.models?.length ?? 0) > 0,
        defaultFirst: first?.id === "default",
        resolvedModelPresent: (first?.resolvedModel?.length ?? 0) > 0,
        rows: probe.models?.length ?? 0,
        requests: 0,
        withinPlan: true,
      },
      resolvedModel: first?.id === "default" ? first.resolvedModel : undefined,
    };
  });

export const checkNormalAndFinal = (
  runtime: RuntimeShape,
  account: Account,
  resolvedModel: string | undefined,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const schema = z.strictObject({ ok: z.boolean() });
      const session = yield* runtime.openSession(
        account,
        {
          systemPrompt: "Return the requested structured response.",
          tools: [],
          turnLimit: TurnLimit.parse(3),
          approvalPolicy: "allow",
          outputSchema: z
            .record(z.string(), z.json())
            .parse(z.toJSONSchema(schema)),
        },
        { kind: "new" },
      );
      yield* session.startTurn({
        turnId: "smoke-normal",
        message: "Reply briefly.",
      });
      const normal = yield* collect(session);
      const normalEnd = normal.findLast(
        (event) => event.type === "turn.finished",
      );
      const broken =
        normalEnd?.outcome.status === "failed" &&
        normalEnd.outcome.disposition === "broken";
      const final = broken
        ? []
        : yield* Effect.gen(function* () {
            yield* session.startTurn({
              turnId: "smoke",
              message: "Return ok as true.",
              final: true,
            });
            return yield* collect(session);
          });
      const events = [...normal, ...final];
      const messages = events.filter(
        (event) => event.type === "message.finished",
      );
      const normalMessages = normal.filter(
        (event) => event.type === "message.finished",
      );
      const models = new Set(
        messages.flatMap((event) =>
          event.model === undefined ? [] : [event.model],
        ),
      );
      const limits = [normal, final].map((turn) => {
        const latest = new Map(
          turn.flatMap((event) =>
            event.type === "usage" && event.scope === "turn"
              ? [[event.model, event] as const]
              : [],
          ),
        );
        return [...latest.values()];
      });
      const end = final.findLast((event) => event.type === "turn.finished");
      return {
        normalCompleted: completed(normal),
        finalCompleted: completed(final),
        structuredOutputParsed:
          end?.outcome.status === "completed" &&
          schema.safeParse(end.outcome.structuredOutput).success,
        defaultModelMatches:
          resolvedModel !== undefined &&
          normalMessages.length > 0 &&
          normalMessages.every((event) => event.model === resolvedModel),
        distinctModels: models.size,
        modelsAgree:
          models.size === 1 &&
          messages.every((event) => event.model !== undefined),
        contextWindowPositive: limits.every(
          (turn) =>
            turn.length > 0 &&
            turn.every((event) => (event.contextWindow ?? 0) > 0),
        ),
        maxOutputTokensPositive: limits.every(
          (turn) =>
            turn.length > 0 &&
            turn.every((event) => (event.maxOutputTokens ?? 0) > 0),
        ),
        protocolError: protocolError(events),
        requests: requests(events),
        withinPlan: requests(events) <= 2,
        events: events.length,
      };
    }),
  );

/**
 * The full smoke's model requests: probe 0, normal and final 2, inputs 2, fork 1 (persistence and
 * fork together 3), tools 2, and the refused round 1 with its final turn up to its backstop.
 */
export const EXPECTED_REQUESTS = 8 + 1 + FINAL_TURN_MESSAGES;

export const checkRequestPlan = (
  steps: Readonly<Record<string, { readonly requests: number }>>,
) => {
  const requests = Object.values(steps).reduce(
    (sum, step) => sum + step.requests,
    0,
  );
  return {
    requests,
    expectedRequests: EXPECTED_REQUESTS,
    withinPlan: requests <= EXPECTED_REQUESTS,
  };
};
