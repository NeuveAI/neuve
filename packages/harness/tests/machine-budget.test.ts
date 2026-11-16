// These tests exercise scheduling and process lifetime boundaries, which types cannot prove.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Socket } from "node:net";
import {
  hostBudget,
  localBudget,
  RELEASE_WAIT_MS,
} from "../src/budget/local.ts";
import {
  LIMIT_CAUSE,
  ProviderLimit,
  Scheduler,
  type Request,
  type Numbers,
} from "../src/budget/scheduler.ts";
const priority = (
  position: "new" | "understand" | "continuation" | "started" = "new",
  kind: "interactive" | "preparation" | "speculation" = "interactive",
) => ({ class: kind, position, stage: 0 });
const call = (
  position: Parameters<typeof priority>[0] = "new",
  kind: Parameters<typeof priority>[1] = "interactive",
): Request => ({
  owner: "review",
  priority: priority(position, kind),
  resource: { kind: "provider", account: "a".repeat(64) },
});
const cpu = (permits = 1): Request => ({
  owner: "cpu",
  priority: priority(),
  resource: { kind: "cpu", permits },
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

test("priority order, aging within class and background at the next boundary", async () => {
  let now = 0;
  const budget = new Scheduler(8, 4, 1, undefined, () => now);
  const held = await budget.admit(call());
  const order: string[] = [];
  const queued = (name: string, request: Request) =>
    budget.admit(request).then((g) => {
      order.push(name);
      g.release();
    });
  const background = queued("background", call("understand", "preparation"));
  const old = queued("aged", call());
  now = 40_000;
  const understand = queued("understand", call("understand"));
  const continuation = queued("continuation", call("continuation"));
  const started = queued("started", call("started"));
  held.release();
  await Promise.all([background, old, understand, continuation, started]);
  expect(order).toEqual([
    "aged",
    "understand",
    "continuation",
    "started",
    "background",
  ]);
});

const answered = (durationMs: number, firstTokenMs = 1_400) => ({
  durationMs,
  firstTokenMs,
  throttled: false,
  retryAfter: false,
});

// Why: the owner's bounds. Climb by half to 32 before the first cut, by one after; never outside 4..32.
test("the adaptive limit climbs 8, 12, 18, 27, 32, steps by one after a cut, and a long sweep stays in 4..32", () => {
  let now = 0;
  const events: Numbers[] = [];
  const limiter = new ProviderLimit(
    undefined,
    (n) => events.push(n),
    () => now,
  );
  const window = (throttle = false) => {
    limiter.used(limiter.limit);
    if (throttle) limiter.congested();
    for (let n = 0; n < 20; n++) {
      now += 100;
      limiter.record(answered(10_000));
    }
  };
  const seen = [limiter.limit];
  window();
  for (let n = 0; n < 5; n++) {
    window();
    seen.push(limiter.limit);
  }
  expect(seen).toEqual([8, 12, 18, 27, 32, 32]);
  window(true);
  expect(limiter.limit).toBe(22);
  window();
  window();
  expect(limiter.limit).toBe(24);
  expect(
    events.filter((e) => e.cause !== undefined).map((e) => e.cause),
  ).toEqual([
    LIMIT_CAUSE.climb,
    LIMIT_CAUSE.climb,
    LIMIT_CAUSE.climb,
    LIMIT_CAUSE.climb,
    LIMIT_CAUSE.throttled,
    LIMIT_CAUSE.step,
    LIMIT_CAUSE.step,
  ]);
  for (let n = 0; n < 12; n++) window(true);
  expect(limiter.limit).toBe(4);
  let seed = 1;
  for (let n = 0; n < 2_000; n++) {
    seed = (seed * 48_271) % 2_147_483_647;
    window(seed % 3 === 0);
    expect(limiter.limit).toBeGreaterThanOrEqual(4);
    expect(limiter.limit).toBeLessThanOrEqual(32);
  }
  const fixed = new ProviderLimit(24);
  fixed.congested(true, true);
  fixed.record({ durationMs: 100, throttled: true, retryAfter: true });
  expect(fixed.limit).toBe(24);
});

// Why: the old limiter cut here, because whole-stream duration tracks output length.
test("mixed 4 s and 40 s calls with a steady time to answer never cut, and the limit climbs", () => {
  let now = 0;
  const events: Numbers[] = [];
  const limiter = new ProviderLimit(
    undefined,
    (n) => events.push(n),
    () => now,
  );
  for (let w = 0; w < 6; w++) {
    limiter.used(limiter.limit);
    for (let n = 0; n < 20; n++) {
      now += 100;
      limiter.record(answered(w > 0 && n % 2 ? 40_000 : 4_000, 1_300 + n * 10));
    }
  }
  expect(events.some((e) => (e.change ?? 0) < 0)).toBe(false);
  expect(limiter.limit).toBe(32);
  expect(
    events.findLast((e) => e.slowestTenthMs !== undefined)?.slowestTenthMs,
  ).toBe(40_000);
});

test("CPU reserve, cut grants and background share while reviews run", async () => {
  const budget = new Scheduler(8, 4);
  const a = await budget.admit(cpu(4));
  const b = await budget.admit(cpu(3));
  const background = await budget.admit({
    ...cpu(8),
    priority: priority("new", "preparation"),
  });
  expect(background.permits).toBe(1);
  expect((await budget.observe()).held).toBe(8);
  a.release();
  b.release();
  background.release();
  expect((await budget.observe()).held).toBe(0);
});

test("worker election, two client processes, process death and host takeover", async () => {
  const directory = mkdtempSync(join(tmpdir(), "neuve-budget-test-"));
  const host = await hostBudget({
    directory,
    threads: 2,
    efficiency: 1,
    fixed: 4,
  });
  expect(host).toBeDefined();
  if (!host) throw new Error("No host");
  try {
    expect(await hostBudget({ directory, threads: 2 })).toBeUndefined();
    const module = join(import.meta.dir, "../src/budget/local.ts");
    const script = `import { localBudget } from ${JSON.stringify(module)}; const grant=await localBudget(${JSON.stringify(directory)}).admit(${JSON.stringify(cpu())}); console.log("granted"); setInterval(()=>{},1000);`;
    const children = [0, 1].map(() =>
      Bun.spawn([process.execPath, "-e", script], {
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    try {
      for (const child of children) {
        const reader = child.stdout.getReader();
        const result = await reader.read();
        expect(new TextDecoder().decode(result.value)).toContain("granted");
        reader.releaseLock();
      }
      expect((await localBudget(directory).observe()).held).toBe(2);
      children[0]?.kill("SIGKILL");
      await children[0]?.exited;
      for (
        let i = 0;
        i < 100 && (await localBudget(directory).observe()).held !== 1;
        i++
      )
        await tick();
      expect((await localBudget(directory).observe()).held).toBe(1);
    } finally {
      for (const child of children) {
        child.kill();
        await child.exited;
      }
    }
    await host.close();
    const successor = await hostBudget({ directory, threads: 2 });
    expect(successor).toBeDefined();
    await successor?.close();
  } finally {
    await host.close().catch(() => {});
    rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);

test("cancelled wait is removed and oversize input is rejected", async () => {
  const budget = new Scheduler(1, 1, 1);
  const held = await budget.admit(call());
  const controller = new AbortController();
  const waiting = budget.admit(call(), controller.signal);
  controller.abort();
  await expect(waiting).rejects.toThrow();
  expect((await budget.observe()).waiting).toBe(0);
  held.release();
  expect(() => budget.admit(cpu(0))).toThrow();
});

test("host crash releases election lock and signals live holders", async () => {
  const directory = mkdtempSync(join(tmpdir(), "neuve-budget-crash-"));
  const module = join(import.meta.dir, "../src/budget/local.ts");
  const hostScript = `import {hostBudget} from ${JSON.stringify(module)}; await hostBudget({directory:${JSON.stringify(directory)},threads:2,fixed:4}); console.log("ready"); setInterval(()=>{},1000);`;
  const host = Bun.spawn([process.execPath, "-e", hostScript], {
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const reader = host.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(
      "ready",
    );
    reader.releaseLock();
    const grant = await localBudget(directory).admit(cpu());
    const child = Bun.spawn(
      [process.execPath, "-e", "setTimeout(()=>{},300)"],
      { stdio: ["ignore", "ignore", "ignore", grant.descriptor] },
    );
    // Killing the host must tell a live caller to cancel; a successor can then claim the kernel lock.
    host.kill("SIGKILL");
    await host.exited;
    for (let n = 0; n < 100 && !grant.signal?.aborted; n++) await tick();
    expect(grant.signal?.aborted).toBe(true);
    await child.exited;
    grant.release();
    const successor = await hostBudget({ directory, threads: 2, fixed: 4 });
    expect(successor).toBeDefined();
    await successor?.close();
  } finally {
    host.kill();
    await host.exited;
    rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);

test("a child inherits its grant descriptor after its parent exits", async () => {
  const directory = mkdtempSync(join(tmpdir(), "neuve-budget-fd-"));
  const host = await hostBudget({ directory, threads: 2, fixed: 4 });
  if (!host) throw new Error("No host");
  const module = join(import.meta.dir, "../src/budget/local.ts");
  const script = `import {localBudget} from ${JSON.stringify(module)}; const grant=await localBudget(${JSON.stringify(directory)}).admit(${JSON.stringify(cpu())}); Bun.spawn([process.execPath,"-e","setTimeout(()=>{},2000)"],{stdio:["ignore","ignore","ignore",grant.descriptor]}); process.exit(0);`;
  try {
    const parent = Bun.spawn([process.execPath, "-e", script], {
      stdout: "ignore",
      stderr: "pipe",
    });
    expect(await parent.exited).toBe(0);
    expect((await localBudget(directory).observe()).held).toBe(1);
    for (
      let n = 0;
      n < 500 && (await localBudget(directory).observe()).held !== 0;
      n++
    )
      await tick();
    expect((await localBudget(directory).observe()).held).toBe(0);
  } finally {
    await host.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);

test("a large CPU waiter blocks smaller followers", async () => {
  const budget = new Scheduler(8, 4);
  const a = await budget.admit(cpu(4));
  const b = await budget.admit(cpu(3));
  const order: string[] = [];
  const large = budget.admit(cpu(4)).then((g) => {
    order.push("large");
    g.release();
  });
  const small = budget.admit(cpu(1)).then((g) => {
    order.push("small");
    g.release();
  });
  await tick();
  expect(order).toEqual([]);
  a.release();
  b.release();
  await Promise.all([large, small]);
  expect(order).toEqual(["large", "small"]);
});

test("Retry-After without 429 suppresses growth but keeps 429 share zero", () => {
  const events: Numbers[] = [];
  const limiter = new ProviderLimit(undefined, (n) => events.push(n));
  const sample = { durationMs: 100, throttled: false, retryAfter: false };
  for (let n = 0; n < 39; n++) limiter.record(sample);
  limiter.congested(true, false);
  limiter.record(sample);
  expect(limiter.limit).toBe(5);
  expect(
    events.findLast((e) => e.retryAfterShare !== undefined)?.retryAfterShare,
  ).toBe(0.05);
  expect(
    events.findLast((e) => e.throttleShare !== undefined)?.throttleShare,
  ).toBe(0);
});

test("invalid initialization leaves the host election lock available", async () => {
  const directory = mkdtempSync(join(tmpdir(), "neuve-budget-invalid-"));
  try {
    await expect(
      hostBudget({ directory, threads: 0, fixed: 4 }),
    ).rejects.toThrow();
    const host = await hostBudget({ directory, threads: 2, fixed: 4 });
    expect(host).toBeDefined();
    await host?.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a host that never answers cannot hold a release forever", async () => {
  const directory = mkdtempSync(join(tmpdir(), "neuve-budget-silent-"));
  const connections: Array<Socket> = [];
  // Half-open, so reading the client's end does not close this side: a stopped host says nothing.
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    connections.push(socket);
    socket.once("data", () =>
      socket.write(`${JSON.stringify({ kind: "grant", permits: 1 })}\n`),
    );
  });
  await new Promise<void>((resolve) =>
    server.listen(join(directory, "budget.sock"), resolve),
  );
  try {
    const grant = await localBudget(directory).admit(cpu());
    const started = performance.now();
    await grant.release();
    expect(performance.now() - started).toBeLessThan(RELEASE_WAIT_MS + 2_000);
  } finally {
    for (const socket of connections) socket.destroy();
    server.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 15_000);
