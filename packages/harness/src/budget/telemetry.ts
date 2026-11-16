import { Effect, Metric } from "effect";
import { CurrentAttempt, recordLate } from "../telemetry.ts";
import type { Numbers } from "./scheduler.ts";

/** Run in the requesting attempt, never in a detached global metric registry. */
export const recordBudget = (numbers: Numbers) =>
  recordLate(
    Effect.gen(function* () {
      for (const [name, value] of Object.entries(numbers))
        yield* Metric.update(Metric.gauge(`harness.budget.${name}`), value);
      const attempt = yield* CurrentAttempt;
      if (numbers.limit !== undefined)
        attempt?.log.write({
          type: "budget.receipt",
          floor: numbers.floor ?? 0,
          limit: numbers.limit,
        });
      else if (numbers.floor === 1)
        attempt?.log.write({ type: "budget.floor", floor: 1 });
    }),
  );
