// Why: replay attribution must keep admission wait timestamps when the real provider budget is
// contended. Exercise the slot boundary directly so no network or model stands in for admission.
import { expect, test } from "bun:test";
import { Context, Effect, Tracer } from "effect";
import { Scheduler } from "../src/budget/scheduler.ts";
import { callSlots } from "../src/pi/call-slots.ts";
import { reviewPriority } from "../src/pi/priority.ts";
import { runLogTracer, type RunLogRecord } from "../src/run-log.ts";
import { CurrentAttempt, spanClock } from "../src/telemetry.ts";

test("a contended call budget retains a timestamp pair and per-call identity", async () => {
  // Read the test's times from the clock the span is stamped with (the runtime's default Clock):
  // Date.now() can sit milliseconds from it in a long-lived process.
  const now = Effect.runSync(spanClock);
  /** Whole milliseconds, truncated as the run log truncates a span's start. */
  const ms = (nanos: bigint) => Number(nanos / 1_000_000n);
  const records: RunLogRecord[] = [];
  const tracer = runLogTracer({
    path: "",
    write: (r) => records.push(r),
    read: () => records,
  });
  const telemetry = Context.make(Tracer.Tracer, tracer);
  const slots = callSlots(1, (effect, signal) =>
    Effect.runPromiseWith(telemetry)(
      effect,
      signal === undefined ? undefined : { signal },
    ),
  );
  const first = await slots.acquire(
    { "harness.conversation_id": "1", "harness.call_sequence": "1" },
    undefined,
  );
  let granted = false;
  const queuedAt = now();
  const waiting = slots
    .acquire(
      { "harness.conversation_id": "2", "harness.call_sequence": "1" },
      undefined,
    )
    .then((release) => {
      granted = true;
      return release;
    });
  await Bun.sleep(60);
  expect(granted).toBe(false);
  const releasedAt = now();
  first();
  const second = await waiting;
  second();
  // The sink's fallback enqueues one microtask per record.
  await Bun.sleep(0);
  const span = records.find(
    (r) =>
      r.type === "span" &&
      r["name"] === "harness.call-slot.wait" &&
      typeof r["attributes"] === "object" &&
      r["attributes"] !== null &&
      "harness.conversation_id" in r["attributes"] &&
      r["attributes"]["harness.conversation_id"] === "2",
  );
  expect(span).toBeDefined();
  const start = Date.parse(String(span?.["start"]));
  const duration = Number(span?.["durationMs"]);
  // The log truncates `start` to whole milliseconds, so the start bounds truncate the test's times
  // the same way and need no tolerance. `start + durationMs` adds the truncation of `durationMs`
  // and so lies less than 2 ms below the span's real end: the end bound allows those two.
  expect(start).toBeGreaterThanOrEqual(ms(queuedAt));
  expect(start).toBeLessThanOrEqual(ms(releasedAt));
  expect(start + duration).toBeGreaterThan(Number(releasedAt) / 1e6 - 2);
  expect(duration).toBeGreaterThanOrEqual(50);
  expect(span?.["attributes"]).toEqual({
    "harness.conversation_id": "2",
    "harness.call_sequence": "1",
    "harness.slot.owner": "run",
    "harness.slot.band": "turn",
    "harness.slot.position": "new",
    "harness.slot.stage": "0",
  });
  expect(span?.["status"]).toBe("ok");
});

// Why: every wait and every limiter decision must be attributable to its owner, band, stage and
// cause, in each run that sees it.
test("a reading's slot wait carries owner, band, stage and rank, and each run writes one budget.limit line per decision", async () => {
  const account = "c".repeat(64);
  const budget = new Scheduler(2, 2);
  const run = (owner: string) => {
    const records: RunLogRecord[] = [];
    const log = {
      path: "",
      write: (r: RunLogRecord) => records.push(r),
      read: () => records,
    };
    const attempt = { log, settled: false, landing: 0 };
    const telemetry = Context.make(Tracer.Tracer, runLogTracer(log));
    const slots = callSlots(
      8,
      (effect, signal) =>
        Effect.runPromiseWith(telemetry)(
          effect.pipe(Effect.provideService(CurrentAttempt, attempt)),
          signal === undefined ? undefined : { signal },
        ),
      {
        budget,
        account,
        owner,
        priority: () => reviewPriority("find", false),
      },
    );
    const once = async () => {
      const release = await slots.acquire(
        { "harness.stage": "assess" },
        undefined,
        reviewPriority("assess", false, 42),
      );
      release();
      await Bun.sleep(0);
    };
    return { records, once };
  };
  const first = run("run-7"),
    second = run("run-8");
  const records = first.records;
  await first.once();
  await budget.throttle(account);
  await first.once();
  await first.once();
  await second.once();
  await second.once();
  await Bun.sleep(0);
  const span = records.find(
    (r) => r.type === "span" && r["name"] === "harness.call-slot.wait",
  );
  expect(span?.["attributes"]).toEqual({
    "harness.stage": "assess",
    "harness.slot.owner": "run-7",
    "harness.slot.band": "reading",
    "harness.slot.position": "new",
    "harness.slot.stage": "40",
    "harness.slot.rank": "42",
  });
  const line = {
    type: "budget.limit",
    limit: 5,
    change: -3,
    cause: "throttled",
    limitClimb: 0,
    limitStep: 0,
    limitThrottled: 1,
    limitRetryAfter: 0,
    limitSlowing: 0,
  };
  for (const seen of [first.records, second.records])
    expect(seen.filter((r) => r.type === "budget.limit")).toEqual([line]);
});
