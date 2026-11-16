import { Effect, Fiber } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { expect, test } from "bun:test";
import {
  closeCeiling,
  deadlineTimer,
  MAX_CLOSE_MS,
  withProgressWatchdog,
  joinedScan,
} from "../../../src/pi/capture/watchdog.ts";
import { InspectionBudget } from "../../../src/pi/capture/credential-detectors.ts";
import { closeInspectionBudget } from "../../../src/pi/capture/safety.ts";

test("the inventory sizes one close allowance and earlier elapsed work is charged", async () => {
  const inventory = {
    records: 70000,
    bytes: 200 * 1024 * 1024,
    calls: 100,
    frames: 10000,
  };
  expect(closeCeiling(inventory)).toBe(320000);
  expect(closeCeiling({ ...inventory, records: 10000000 })).toBe(MAX_CLOSE_MS);
  expect(() =>
    closeCeiling({ ...inventory, bytes: Number.MAX_SAFE_INTEGER + 1 }),
  ).toThrow();
  const budget = closeInspectionBudget(inventory, performance.now() - 320001);
  expect(() => budget.charge("units", 0)).toThrow("cancelled");
  await expect(
    new Promise<void>((resolve) => {
      const stop = deadlineTimer(performance.now() + 5, () => {
        stop();
        resolve();
      });
    }),
  ).resolves.toBeUndefined();
});

test("no progress is measured on the Effect clock", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        withProgressWatchdog(() => Effect.never).pipe(Effect.result),
      );
      yield* TestClock.adjust("29 seconds");
      expect(fiber.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust("9 seconds");
      return yield* Fiber.join(fiber);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );
  expect(result._tag).toBe("Failure");
  if (result._tag === "Failure")
    expect(result.failure).toMatchObject({ _tag: "ScanNoProgress" });
});

test("charged work inside one unfinished source keeps the watcher alive", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const budget = new InspectionBudget();
      const fiber = yield* Effect.forkChild(
        withProgressWatchdog((tick) => {
          budget.onProgress = tick;
          return Effect.never;
        }),
      );
      for (let i = 0; i < 12; i++) {
        yield* TestClock.adjust("5 seconds");
        budget.charge("units", 1);
        yield* Effect.promise(() => budget.checkpoint(0));
      }
      expect(fiber.pollUnsafe()).toBeUndefined();
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );
});

test("interruption aborts a promise and waits for its cleanup", async () => {
  let stopped = false;
  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        joinedScan(
          (signal) =>
            new Promise<void>((resolve) => {
              signal.addEventListener(
                "abort",
                () => {
                  stopped = true;
                  resolve();
                },
                { once: true },
              );
            }),
        ),
      );
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.scoped),
  );
  expect(stopped).toBe(true);
});

test("inventory arithmetic rejects fractional and overflowing counts", () => {
  const inventory = { records: 0, bytes: 0, calls: 0, frames: 0 };
  expect(closeCeiling(inventory)).toBe(30_000);
  expect(() => closeCeiling({ ...inventory, records: 0.5 })).toThrow();
  expect(() =>
    closeCeiling({ ...inventory, frames: Number.MAX_SAFE_INTEGER }),
  ).toThrow();
});

test("a no-progress interruption persists the watchdog cause instead of cancellation", async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { openCaptureJournal } =
    await import("../../../src/pi/capture/journal.ts");
  const { buildDump } = await import("../../../src/pi/capture/build.ts");
  const { NO_PROGRESS_REASON, ScanNoProgress } =
    await import("../../../src/pi/capture/watchdog.ts");
  const root = mkdtempSync(join(tmpdir(), "no-progress-diagnostic-"));
  try {
    const journal = openCaptureJournal(join(root, "capture"), "synthetic");
    journal.close();
    const controller = new AbortController();
    controller.abort(new ScanNoProgress());
    await expect(
      buildDump({
        runId: "synthetic",
        journal: journal.directory,
        signal: controller.signal,
      }),
    ).rejects.toBeDefined();
    expect(
      JSON.parse(
        readFileSync(join(root, "capture", "close-diagnostic.json"), "utf8"),
      ).refusal,
    ).toBe(NO_PROGRESS_REASON);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("worker progress is throttled and receivers reject duplicate, regressing and over-budget units", async () => {
  const { relayChargedProgress, validProgress } =
    await import("../../../src/pi/capture/progress-relay.ts");
  let now = 0;
  const sent: number[] = [];
  const relay = relayChargedProgress(
    (units) => sent.push(units),
    () => now,
  );
  relay(0);
  relay(1);
  relay(2);
  now = 999;
  relay(3);
  now = 1000;
  relay(4);
  relay(4);
  now = 2000;
  relay(4);
  relay(3);
  relay(5);
  expect(sent).toEqual([1, 4, 5]);
  expect(
    [0, 1, 3, 4, 11, 4.5].map((units) => validProgress(3, units, 10)),
  ).toEqual([false, false, false, true, false, false]);
});

test("the actual watchdog error reaches the joined operation's combined abort signal", async () => {
  let observed: unknown;
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        withProgressWatchdog((_tick, watchdogSignal) =>
          joinedScan(
            (signal) =>
              new Promise<void>((_resolve, reject) => {
                const combined = AbortSignal.any([signal, watchdogSignal]);
                combined.addEventListener(
                  "abort",
                  () => {
                    observed = combined.reason;
                    reject(combined.reason);
                  },
                  { once: true },
                );
              }),
          ),
        ).pipe(Effect.result),
      );
      yield* TestClock.adjust("29 seconds");
      expect(observed).toBeUndefined();
      yield* TestClock.adjust("9 seconds");
      return yield* Fiber.join(fiber);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );
  expect(result._tag).toBe("Failure");
  if (result._tag === "Failure") {
    expect(result.failure).toMatchObject({ _tag: "ScanNoProgress" });
    expect(observed).toBe(result.failure);
  }
});
