import { expect, test } from "bun:test";
import {
  DEFAULT_INSPECTION_LIMITS,
  InspectionBudget,
} from "../../../src/pi/capture/credential-detectors.ts";

// Checkpoints must service timer-based cancellation even when immediate turns suffice for I/O.
test("the first inspection yield services already queued timers", async () => {
  const budget = new InspectionBudget();
  let fired = false;
  setTimeout(() => {
    fired = true;
  }, 0);
  await budget.checkpoint(DEFAULT_INSPECTION_LIMITS.yieldUnits);
  expect(fired).toBe(true);
});

test("successive inspection yields continue servicing cancellation timers", async () => {
  const controller = new AbortController();
  const budget = new InspectionBudget(
    DEFAULT_INSPECTION_LIMITS,
    controller.signal,
  );
  await budget.checkpoint(DEFAULT_INSPECTION_LIMITS.yieldUnits);
  setTimeout(() => controller.abort(), 2);
  const start = performance.now();
  await expect(
    (async () => {
      while (performance.now() - start < 1000) {
        budget.charge("units", 1);
        await budget.checkpoint(DEFAULT_INSPECTION_LIMITS.yieldUnits);
      }
      throw new Error("cancellation timer starved");
    })(),
  ).rejects.toMatchObject({
    reason: "cancelled",
    message: "Credential inspection unavailable (cancelled)",
  });
  expect(controller.signal.aborted).toBe(true);
});

test("yield scheduling cannot reset exhausted work or allow pre-cancelled work", async () => {
  const budget = new InspectionBudget({
    ...DEFAULT_INSPECTION_LIMITS,
    units: 1,
  });
  budget.charge("units", 1);
  await budget.checkpoint(DEFAULT_INSPECTION_LIMITS.yieldUnits);
  expect(() => budget.charge("units", 1)).toThrow(
    "Credential inspection unavailable (budget)",
  );
  expect(() => budget.charge("units", 0)).toThrow(
    "Credential inspection unavailable (budget)",
  );
  const controller = new AbortController();
  controller.abort();
  const cancelled = new InspectionBudget(
    DEFAULT_INSPECTION_LIMITS,
    controller.signal,
  );
  await expect(cancelled.checkpoint(0)).rejects.toMatchObject({
    reason: "cancelled",
  });
  expect(() => cancelled.charge("units", 0)).toThrow(
    "Credential inspection unavailable (cancelled)",
  );
});
