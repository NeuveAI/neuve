import { Database } from "bun:sqlite";
// Regression cases from capacity review 1. These exercise real adapter and runtime boundaries.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hostBudget,
  workerBudget,
  closeWorkerBudget,
} from "../src/budget/local.ts";
import { type Request } from "../src/budget/scheduler.ts";
const directory = () => mkdtempSync(join(tmpdir(), "budget-revision-"));
const request: Request = {
  owner: "review",
  priority: { class: "interactive", position: "new", stage: 0 },
  resource: { kind: "provider", account: "a".repeat(64) },
};

test("hostloss: a living worker re-elects after its host exits and keeps model streams alive", async () => {
  const path = directory();
  const previous = process.env.NEUVE_BUDGET_DIRECTORY;
  process.env.NEUVE_BUDGET_DIRECTORY = path;
  const host = await hostBudget({ directory: path, threads: 2, fixed: 4 });
  if (!host) throw new Error("No host");
  try {
    const budget = await workerBudget();
    const running = await budget.admit(request);
    await host.close();
    expect(running.signal?.aborted ?? false).toBe(false);
    running.release();
    const next = await budget.admit(request);
    next.release();
    const cpu = await budget.admit({
      ...request,
      resource: { kind: "cpu", permits: 1 },
    });
    cpu.release();
    await budget.throttle("a".repeat(64), true, true);
    expect((await budget.observe()).providerHeld).toBe(0);
  } finally {
    await host.close();
    await closeWorkerBudget();
    if (previous === undefined) delete process.env.NEUVE_BUDGET_DIRECTORY;
    else process.env.NEUVE_BUDGET_DIRECTORY = previous;
    rmSync(path, { recursive: true, force: true });
  }
});

import { Effect, Metric } from "effect";
import { callSlots } from "../src/pi/call-slots.ts";
import { localBudget } from "../src/budget/local.ts";
import { writeMetrics } from "../src/telemetry.ts";
import type { RunLogRecord } from "../src/run-log.ts";

test("metrics: a socket client records host limit changes in its attempt registry", async () => {
  const path = directory();
  const previousMode = process.env.NEUVE_MODEL_CONCURRENCY;
  process.env.NEUVE_MODEL_CONCURRENCY = "adaptive";
  let host: Awaited<ReturnType<typeof hostBudget>>;
  try {
    host = await hostBudget({ directory: path, threads: 2 });
  } finally {
    if (previousMode === undefined) delete process.env.NEUVE_MODEL_CONCURRENCY;
    else process.env.NEUVE_MODEL_CONCURRENCY = previousMode;
  }

  if (!host) throw new Error("No host");
  const seed = await host.scheduler.admit(request);
  await seed.release();
  await host.scheduler.throttle("a".repeat(64), true, true);
  const registry: Metric.MetricRegistry = new Map();
  const pending: Promise<unknown>[] = [];
  const slots = callSlots(
    8,
    (effect, signal) => {
      const running = Effect.runPromise(
        effect.pipe(Effect.provideService(Metric.MetricRegistry, registry)),
        signal ? { signal } : undefined,
      );
      pending.push(running);
      return running;
    },
    {
      budget: localBudget(path),
      account: "a".repeat(64),
      owner: "client",
      priority: () => request.priority,
    },
  );
  try {
    const release = await slots.acquire({}, undefined);
    release();
    await Promise.all(pending);
    const records: RunLogRecord[] = [];
    writeMetrics(
      {
        path: "",
        read: () => records,
        write: (r) => {
          records.push(r);
        },
      },
      registry,
    );
    expect(
      records.find((r) => r.name === "harness.budget.limit")?.state,
    ).toEqual({ value: 5 });
    expect(
      records.find((r) => r.name === "harness.budget.limitChanges")?.state,
    ).toEqual({ value: 1 });
    expect(
      records.find((r) => r.name === "harness.budget.floor")?.state,
    ).toEqual({ value: 0 });
  } finally {
    await host.close();
    rmSync(path, { recursive: true, force: true });
  }
});

import { Scheduler } from "../src/budget/scheduler.ts";
test("cancel/admit race releases a grant delivered after interruption", async () => {
  const budget = new Scheduler(1, 1, 4);
  const slots = callSlots(
    4,
    (effect, signal) =>
      Effect.runPromise(effect, signal ? { signal } : undefined),
    {
      budget,
      account: "a".repeat(64),
      owner: "race",
      priority: () => request.priority,
    },
  );
  const held = await Promise.all(
    Array.from({ length: 4 }, () => budget.admit(request)),
  );
  const controller = new AbortController();
  const waiting = slots.acquire({}, controller.signal).then(
    (release) => release(),
    () => {},
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  held[0]?.release();
  controller.abort();
  await waiting;
  for (const grant of held.slice(1)) await grant.release();
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect((await budget.observe()).providerHeld).toBe(0);
});

import { spyOn } from "bun:test";
test("admission caps never fail an interactive call or break a waiting background job", async () => {
  const timer = globalThis.setTimeout;
  const capped = new Proxy(timer, {
    apply(target, receiver, args: unknown[]) {
      const [callback, delay, ...rest] = args;
      return Reflect.apply(target, receiver, [
        callback,
        delay === 300_000 ? 5 : delay,
        ...rest,
      ]);
    },
  });
  const spy = spyOn(globalThis, "setTimeout").mockImplementation(capped);
  try {
    for (const kind of ["interactive", "preparation"] as const) {
      const budget = new Scheduler(1, 1, 1);
      const held = await budget.admit(request);
      const waiting = Effect.runPromise(
        acquireGrant(budget, {
          ...request,
          priority: { ...request.priority, class: kind },
        }),
      ).then(
        async (g) => {
          await g.release();
          return "admitted";
        },
        () => "error",
      );
      await new Promise((resolve) => timer(resolve, 20));
      await held.release();
      expect(await waiting).toBe("admitted");
    }
  } finally {
    spy.mockRestore();
  }
});

test("background queue saturation leaves interactive space and idle accounts expire", async () => {
  let now = 0;
  const budget = new Scheduler(2, 1, 1, undefined, () => now);
  const held = await budget.admit(request);
  const controller = new AbortController();
  const queued = Array.from({ length: 4096 }, () =>
    budget
      .admit(
        { ...request, priority: { ...request.priority, class: "preparation" } },
        controller.signal,
      )
      .then(
        (g) => g.release(),
        () => {},
      ),
  );
  const interactive = budget.admit(request, controller.signal);
  interactive.catch(() => {});
  await held.release();
  const grant = await interactive;
  await grant.release();
  controller.abort();
  await Promise.all(queued);
  const accounts = new Scheduler(2, 1, 4, undefined, () => now);
  for (let n = 0; n < 64; n++) {
    const g = await accounts.admit({
      ...request,
      resource: { kind: "provider", account: n.toString(16).padStart(64, "0") },
    });
    await g.release();
  }
  now = 120_000;
  const fresh = await accounts.admit({
    ...request,
    resource: { kind: "provider", account: "f".repeat(64) },
  });
  await fresh.release();
  expect((await accounts.observe()).providerAccounts).toBeLessThan(64);
}, 20_000);

test("an active interactive run reserves a model slot between calls", async () => {
  const budget = new Scheduler(2, 1, 4);
  const leave = await budget.activate?.("a".repeat(64), "person");
  const background = {
    ...request,
    priority: { ...request.priority, class: "preparation" as const },
  };
  const held = await Promise.all(
    Array.from({ length: 3 }, () => budget.admit(background)),
  );
  let fourth = false;
  const last = budget.admit(background).then((g) => {
    fourth = true;
    return g;
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(fourth).toBe(false);
  const interactive = await budget.admit(request);
  await interactive.release();
  leave?.();
  for (const grant of held) await grant.release();
  await (await last).release();
});

import { LIMIT_CAUSE, ProviderLimit } from "../src/budget/scheduler.ts";
// Why: real throttling must still back off immediately, once per window, with or without a 429.
test("a throttle signal cuts at once, once per window, and Retry-After alone cuts too", () => {
  const sample = {
    durationMs: 100,
    firstTokenMs: 1_000,
    throttled: false,
    retryAfter: false,
  };
  const idle = new ProviderLimit(undefined);
  for (let n = 0; n < 40; n++) idle.record(sample);
  expect(idle.limit).toBe(8);
  const events: Array<Record<string, number>> = [];
  const limit = new ProviderLimit(undefined, (n) => events.push(n));
  limit.congested();
  expect(limit.limit).toBe(5);
  for (let n = 0; n < 10; n++) limit.congested();
  limit.record({ ...sample, throttled: true });
  expect(limit.limit).toBe(5);
  for (let n = 0; n < 19; n++) limit.record(sample);
  limit.record({ ...sample, retryAfter: true });
  expect(limit.limit).toBe(4);
  expect(events.filter((e) => e.cause !== undefined)).toMatchObject([
    { limit: 5, change: -3, cause: LIMIT_CAUSE.throttled, limitThrottled: 1 },
    { limit: 4, change: -1, cause: LIMIT_CAUSE.retryAfter, limitRetryAfter: 1 },
  ]);
  const header = new ProviderLimit(undefined);
  header.congested(true, false);
  expect(header.limit).toBe(5);
});

// Why: time to answer that stays doubled is the one slowing signal; one noisy window, a thin
// window or a level that has become the new normal must not cut.
test("slowing cuts once on a second slow window in a row, and a level that stays high becomes normal", () => {
  const limiter = () => {
    const events: Array<Record<string, number>> = [];
    const limit = new ProviderLimit(undefined, (n) => events.push(n));
    const window = (answerMs: number, answers = 20) => {
      for (let n = 0; n < 20; n++)
        limit.record({
          durationMs: 30_000,
          throttled: false,
          retryAfter: false,
          ...(n < answers ? { firstTokenMs: answerMs } : {}),
        });
    };
    const slowing = () =>
      events.filter((e) => e.cause === LIMIT_CAUSE.slowing).length;
    return { limit, window, slowing, events };
  };
  // One slow window between normal ones holds; the normal one after it ends the run.
  const noisy = limiter();
  noisy.window(1_000);
  noisy.window(1_000);
  noisy.window(2_300);
  noisy.window(1_000);
  noisy.window(2_300);
  expect(noisy.limit.limit).toBe(8);
  // Four answers at ten times the baseline neither continue nor end the run.
  noisy.window(10_000, 4);
  expect(noisy.limit.limit).toBe(8);
  expect(
    noisy.events.findLast((e) => e.answerSamples !== undefined),
  ).toMatchObject({ answerSamples: 4, answerMs: 10_000 });
  // The second slow window in a row cuts, once.
  noisy.window(2_300);
  expect(noisy.limit.limit).toBe(5);
  expect(noisy.events.at(-1)).toMatchObject({
    cause: LIMIT_CAUSE.slowing,
    limitSlowing: 1,
  });
  // A level that triples and stays cuts once, then is the new normal.
  const tripled = limiter();
  tripled.window(1_000);
  tripled.window(1_000);
  for (let n = 0; n < 8; n++) tripled.window(3_000);
  expect(tripled.slowing()).toBe(1);
  expect(tripled.limit.limit).toBe(5);
  // The reviewer's case: a first window at 0.3 s, then a steady 0.9 s.
  const steady = limiter();
  steady.window(300);
  for (let n = 0; n < 8; n++) steady.window(900);
  expect(steady.slowing()).toBe(1);
  expect(steady.limit.limit).toBe(5);
});

import { clientBudget, cpuChildSettings } from "../src/budget/local.ts";
test("floor is transient, disclosed, and lowers only background children", async () => {
  const path = directory();
  const client = await clientBudget(path);
  const grant = await client.admit({
    ...request,
    resource: { kind: "cpu", permits: 1 },
  });
  try {
    const settings = cpuChildSettings(grant, {
      ...request.priority,
      class: "preparation",
    });
    expect(settings.env.NEUVE_BUDGET_FLOOR).toBe("1");
    expect(settings.env.NEUVE_CPU_GRANT_PERMITS).toBeUndefined();
    expect(settings.prefix).toEqual(["/usr/bin/nice", "-n", "19"]);
    expect(cpuChildSettings(grant, request.priority).prefix).toEqual([]);
    const host = await hostBudget({ directory: path, threads: 2, fixed: 4 });
    if (!host) throw new Error("No host");
    try {
      expect((await client.capacity()).threads).toBe(2);
    } finally {
      await host.close();
    }
  } finally {
    await grant.release();
    rmSync(path, { recursive: true, force: true });
  }
});

import * as os from "node:os";
// Why: the macOS case with a real grant once took a background class instead, and no test noticed.
test("a real grant on macOS lowers only a background child's CPU priority", async () => {
  const platform = spyOn(os, "platform").mockReturnValue("darwin");
  const budget = new Scheduler(4, 4, 4);
  const grant = await budget.admit({
    ...request,
    resource: { kind: "cpu", permits: 1 },
  });
  try {
    expect(grant.floor).toBeFalsy();
    for (const background of ["preparation", "speculation"] as const)
      expect(
        cpuChildSettings(grant, { ...request.priority, class: background })
          .prefix,
      ).toEqual(["/usr/bin/nice", "-n", "19"]);
    expect(cpuChildSettings(grant, request.priority).prefix).toEqual([]);
  } finally {
    await grant.release();
    platform.mockRestore();
  }
});

import { unlinkSync } from "node:fs";
test("a live socket prevents split brain after its election file is removed", async () => {
  const path = directory();
  const host = await hostBudget({ directory: path, threads: 2, fixed: 4 });
  if (!host) throw new Error("No host");
  try {
    unlinkSync(join(path, "budget.sqlite"));
    const other = await hostBudget({ directory: path, threads: 2, fixed: 4 });
    await other?.close();
    expect(other).toBeUndefined();
  } finally {
    await host.close();
    rmSync(path, { recursive: true, force: true });
  }
});

import * as net from "node:net";
test("an accept error after listen does not crash the budget worker", async () => {
  const path = directory();
  const server = net.createServer();
  const factory = spyOn(net, "createServer").mockReturnValue(server);
  const host = await hostBudget({ directory: path, threads: 2, fixed: 4 });
  if (!host) throw new Error("No host");
  factory.mockRestore();
  try {
    expect(() =>
      server.emit("error", new Error("accept failed")),
    ).not.toThrow();
  } finally {
    await host.close();
    rmSync(path, { recursive: true, force: true });
  }
});

test("an active review re-registers its reserve when the host is replaced", async () => {
  const path = directory();
  const host = await hostBudget({ directory: path, threads: 2, fixed: 4 });
  if (!host) throw new Error("No host");
  const budget = await workerBudget(path);
  const leave = await budget.activate?.("a".repeat(64), "living-review");
  try {
    await host.close();
    await budget.capacity();
    expect((await budget.observe()).activeRuns).toBe(1);
  } finally {
    leave?.();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await closeWorkerBudget(path);
    await host.close();
    rmSync(path, { recursive: true, force: true });
  }
});

test("a floor grant is disclosed even if a host returns before metrics are read", async () => {
  const path = directory(),
    budget = await clientBudget(path);
  let host: Awaited<ReturnType<typeof hostBudget>>;
  const admit = budget.admit.bind(budget);
  budget.admit = async (...args) => {
    const grant = await admit(...args);
    host = await hostBudget({ directory: path, threads: 2, fixed: 8 });
    return grant;
  };
  const registry: Metric.MetricRegistry = new Map(),
    pending: Promise<unknown>[] = [];
  const slots = callSlots(
    8,
    (effect, signal) => {
      const p = Effect.runPromise(
        effect.pipe(Effect.provideService(Metric.MetricRegistry, registry)),
        signal ? { signal } : undefined,
      );
      pending.push(p);
      return p;
    },
    {
      budget,
      account: "a".repeat(64),
      owner: "floor-race",
      priority: () => request.priority,
    },
  );
  try {
    const release = await slots.acquire({}, undefined);
    release();
    await Promise.all(pending);
    const records: RunLogRecord[] = [];
    writeMetrics(
      {
        path: "",
        read: () => records,
        write: (r) => {
          records.push(r);
        },
      },
      registry,
    );
    expect(
      records.find((r) => r.name === "harness.budget.floor")?.state,
    ).toEqual({ value: 1 });
  } finally {
    await host?.close();
    rmSync(path, { recursive: true, force: true });
  }
});

import { acquireGrant } from "../src/budget/acquire.ts";
test("a timed-out background admission withdraws and lets its job defer before retry", async () => {
  const timer = globalThis.setTimeout;
  const capped = new Proxy(timer, {
    apply(target, receiver, args: unknown[]) {
      const [callback, delay, ...rest] = args;
      return Reflect.apply(target, receiver, [
        callback,
        delay === 300_000 ? 5 : delay,
        ...rest,
      ]);
    },
  });
  const spy = spyOn(globalThis, "setTimeout").mockImplementation(capped);
  const budget = new Scheduler(1, 1, 1),
    held = await budget.admit(request);
  let yielded = 0,
    resume = () => {};
  const deferred = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const pending = Effect.runPromise(
    acquireGrant(
      budget,
      { ...request, priority: { ...request.priority, class: "preparation" } },
      async () => {
        yielded++;
        await deferred;
      },
    ),
  );
  try {
    await new Promise((resolve) => timer(resolve, 20));
    expect(yielded).toBe(1);
    expect((await budget.observe()).waiting).toBe(0);
    await held.release();
    resume();
    await (await pending).release();
  } finally {
    spy.mockRestore();
    resume();
    await held.release();
  }
});

test("outage floor keeps its fourth provider slot for interactive work without a lease", async () => {
  const path = directory();
  const budget = await clientBudget(path);
  const background = {
    ...request,
    priority: { ...request.priority, class: "preparation" as const },
  };
  const held = await Promise.all(
    Array.from({ length: 3 }, () => budget.admit(background)),
  );
  const abort = new AbortController();
  let fourth = false;
  const waiting = budget.admit(background, abort.signal).then(
    (grant) => {
      fourth = true;
      return grant.release();
    },
    () => {},
  );
  try {
    await Bun.sleep(10);
    expect(fourth).toBe(false);
    const interactive = await budget.admit(request);
    expect(interactive.floor).toBe(true);
    await interactive.release();
  } finally {
    abort.abort();
    await waiting;
    for (const grant of held) await grant.release();
    rmSync(path, { recursive: true, force: true });
  }
});

test("lock busy retries the connection before using the recovery floor", async () => {
  const path = directory();
  const host = await hostBudget({ directory: path, threads: 2, fixed: 4 });
  if (!host) throw new Error("Fixture host did not start");
  await host.close();
  const lock = new Database(join(path, "budget.sqlite"));
  lock.exec("BEGIN IMMEDIATE");
  const release = setTimeout(() => lock.close(), 15);
  try {
    const budget = await workerBudget(path);
    const grant = await budget.admit(request);
    expect(grant.floor).not.toBe(true);
    await grant.release();
  } finally {
    clearTimeout(release);
    try {
      lock.close();
    } catch {}
    await closeWorkerBudget(path);
    rmSync(path, { recursive: true, force: true });
  }
});

import { admitForJob, BudgetAdmissionFailed } from "../src/budget/acquire.ts";
import { BackgroundYield } from "../src/budget/scheduler.ts";
test("admission errors are typed failures and yielded retries keep their age", async () => {
  const budget = new Scheduler(1, 1, 4);
  const cause = new Error("admission refused");
  budget.admit = async () => {
    throw cause;
  };
  const outcome = await Effect.runPromise(
    Effect.result(acquireGrant(budget, request)),
  );
  expect(outcome._tag).toBe("Failure");
  if (outcome._tag === "Failure") {
    expect(outcome.failure).toBeInstanceOf(BudgetAdmissionFailed);
    expect(outcome.failure.cause).toBe(cause);
  }
  const times: Array<number | undefined> = [];
  budget.admit = async (queued) => {
    times.push(queued.queuedAt);
    if (times.length < 3) throw new BackgroundYield();
    return { permits: 1, release() {} };
  };
  const grant = await admitForJob(
    budget,
    { ...request, priority: { ...request.priority, class: "preparation" } },
    new AbortController().signal,
  );
  await grant.release();
  expect(times[0]).toBeGreaterThan(0);
  expect(times).toEqual([times[0], times[0], times[0]]);
});

test("measurement errors never refuse an admitted model call or leak its slot", async () => {
  const budget = new Scheduler(1, 1, 4);
  let measurements = 0;
  budget.measure = async () => {
    measurements++;
    throw new Error("measurement failed");
  };
  const slots = callSlots(
    4,
    (work, signal) => Effect.runPromise(work, { signal }),
    {
      budget,
      account: "a".repeat(64),
      owner: "run",
      priority: () => request.priority,
    },
  );
  const release = await slots.acquire({}, undefined);
  expect(measurements).toBe(1);
  expect((await budget.observe()).providerHeld).toBe(1);
  release();
  for (let n = 0; n < 100 && (await budget.observe()).providerHeld; n++)
    await Bun.sleep(1);
  expect((await budget.observe()).providerHeld).toBe(0);
  expect(measurements).toBe(2);
});
