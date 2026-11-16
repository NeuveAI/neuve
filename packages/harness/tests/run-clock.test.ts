// The run clock (the run's start, stored once per run ID) and the claims that set it. Each case
// drives the real `review.run` handler in its own process (tests/fixtures/run-clock.ts), stops
// its first claim as a stopping worker does, puts the job back uncounted, waits, and runs the next
// claim to its receipt.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { settingsPath } from "../src/settings.ts";
import { runProcess } from "./fixtures/process.ts";

const root = mkdtempSync(
  join(
    process.env.NEUVE_TEST_STORE_DIRECTORY ?? tmpdir(),
    "harness-run-clock-",
  ),
);
afterAll(() => rmSync(root, { recursive: true, force: true }));

type Observed = {
  firstExit: string;
  admittedBeforeStop: boolean;
  secondOutcome: string;
  releasedMs: number;
  firstClaimAt: number;
  secondClaimAt: number;
  clockAfterFirst: number | null;
  clockAfterSecond: number | null;
  enqueuedAt: number;
  admitted: Array<string>;
  runStarted: Array<number>;
  receipt: { startedAt: number; queueWaitMs: number; cutoffAt: number } | null;
  expectedCutoffAt: number | null;
  reviewTaskCutoffs: Array<number>;
};

const scenario = async (name: "before-work" | "during-open" | "after-work") => {
  const directory = join(root, name);
  const home = join(directory, "home");
  // The clock is the subject, not the section readings: they are off, so the run is short.
  mkdirSync(dirname(settingsPath(home)), { recursive: true });
  writeFileSync(
    settingsPath(home),
    JSON.stringify({ version: 1, review: { sectionReadings: "off" } }),
  );
  const {
    OPENAI_API_KEY: _openai,
    ANTHROPIC_API_KEY: _anthropic,
    ...env
  } = process.env;
  const run = await runProcess(
    [
      process.execPath,
      "run",
      join(import.meta.dir, "fixtures", "run-clock.ts"),
    ],
    {
      timeout: 50_000,
      env: {
        ...env,
        HOME: home,
        SCENARIO_ROOT: directory,
        SCENARIO_CASE: name,
      },
    },
  );
  if (run.exitCode !== 0) throw new Error(run.stderr.toString());
  return JSON.parse(
    run.stdout.toString().trim().split("\n").at(-1)!,
  ) as Observed;
};

// Why: case 108. A follow-on's first claim stored the run's clock and was stopped before doing any
// work; every later claim read that start, found its cut-off long past, and could do nothing. A
// claim stopped before its open (here, waiting for its budget, an interruptible point) admits no
// review task and must leave no clock, so the next claim gets the run's full time: the cut-off is
// computed from the second claim's start. Its receipt's `startedAt` is that start, and its queue
// wait counts the time the job sat released.
test("a claim stopped before doing work leaves no clock; the next claim gets the full time", async () => {
  const observed = await scenario("before-work");
  expect(observed.firstExit).toBe("stopped");
  expect(observed.admittedBeforeStop).toBe(false);
  expect(observed.clockAfterFirst).toBeNull();
  expect(observed.secondOutcome).toBe("completed");
  // The review task was created by the second claim, from the second claim's clock.
  expect(observed.admitted).toEqual(["created"]);
  const clock = observed.clockAfterSecond!;
  expect(clock).toBeGreaterThanOrEqual(observed.secondClaimAt);
  expect(observed.receipt).not.toBeNull();
  expect(observed.receipt!.startedAt).toBe(clock);
  expect(observed.receipt!.cutoffAt).toBe(observed.expectedCutoffAt!);
  // Every stage reads the review task's cut-off: the same clock.
  expect(observed.reviewTaskCutoffs).toEqual([observed.expectedCutoffAt!]);
  // Queue wait: enqueue to the run's start, the released time included, and the receipt says so.
  expect(observed.receipt!.queueWaitMs).toBe(clock - observed.enqueuedAt);
  expect(observed.receipt!.queueWaitMs).toBeGreaterThanOrEqual(
    observed.releasedMs,
  );
}, 60_000);

// Why: a stop during the open cannot interrupt it. The open runs to its end and admits the review
// task, whose cut-off comes from this claim's start; then the stop takes effect. The start must be
// stored with that admission, or the next claim would take a fresh clock and continue a task cut
// off by the old one: two clocks. So the next claim reads the first start, and the review task's
// cut-off, the receipt's and the stored clock are one value.
test("a stop during the open stores the start the admitted review task was cut from", async () => {
  const observed = await scenario("during-open");
  expect(observed.firstExit).toBe("stopped");
  expect(observed.admittedBeforeStop).toBe(false);
  const clock = observed.clockAfterFirst!;
  expect(clock).not.toBeNull();
  expect(clock).toBeGreaterThanOrEqual(observed.firstClaimAt);
  expect(clock).toBeLessThan(observed.secondClaimAt);
  expect(observed.clockAfterSecond).toBe(clock);
  expect(observed.secondOutcome).toBe("completed");
  // The first claim created the task; the next one continued it.
  expect(observed.admitted.at(-1)).toBe("continued");
  expect(observed.receipt).not.toBeNull();
  expect(observed.receipt!.startedAt).toBe(clock);
  expect(observed.receipt!.cutoffAt).toBe(observed.expectedCutoffAt!);
  expect(observed.reviewTaskCutoffs).toEqual([observed.receipt!.cutoffAt]);
  expect(observed.receipt!.queueWaitMs).toBe(clock - observed.enqueuedAt);
  expect(observed.receipt!.queueWaitMs).toBeLessThan(observed.releasedMs);
}, 60_000);

// Why: unchanged by design (10.15). A claim that began work (its review task admitted, Precompute
// running) and then stopped, retried after a wait, keeps the run's first start, so a crash or a
// retry cannot extend a review. The receipt's `startedAt` is the first start, and its queue wait
// is only the time before the first claim.
test("a claim stopped after starting work keeps the first start on the next claim", async () => {
  const observed = await scenario("after-work");
  expect(observed.firstExit).toBe("stopped");
  expect(observed.admittedBeforeStop).toBe(true);
  const clock = observed.clockAfterFirst!;
  expect(clock).not.toBeNull();
  expect(clock).toBeGreaterThanOrEqual(observed.firstClaimAt);
  expect(clock).toBeLessThan(observed.secondClaimAt);
  expect(observed.clockAfterSecond).toBe(clock);
  expect(observed.secondOutcome).toBe("completed");
  expect(observed.admitted).toEqual(["created", "continued"]);
  expect(observed.receipt).not.toBeNull();
  expect(observed.receipt!.startedAt).toBe(clock);
  expect(observed.receipt!.cutoffAt).toBe(observed.expectedCutoffAt!);
  expect(observed.reviewTaskCutoffs).toEqual([observed.expectedCutoffAt!]);
  expect(observed.receipt!.queueWaitMs).toBe(clock - observed.enqueuedAt);
  expect(observed.receipt!.queueWaitMs).toBeLessThan(observed.releasedMs);
}, 60_000);
