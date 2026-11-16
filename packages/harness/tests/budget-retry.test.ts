import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clientBudget, hostBudget } from "../src/budget/local.ts";
import type { Request } from "../src/budget/scheduler.ts";

const request: Request = {
  owner: "budget-retry",
  priority: { class: "interactive", position: "new", stage: 0 },
  resource: { kind: "cpu", permits: 2 },
};
const directory = () => mkdtempSync(join(tmpdir(), "budget-retry-"));

// The outage boundary must keep one CPU thread, cancellation and disclosure
// even when admissions skip the socket.
test("remembered outage skips sockets and serializes CPU work at the disclosed floor", async () => {
  const path = directory();
  const socket = spyOn(net, "createConnection");
  const clock = spyOn(performance, "now").mockReturnValue(0);
  const budget = await clientBudget(path);
  try {
    const first = await budget.admit(request);
    expect(first.floor).toBe(true);
    expect(first.permits).toBe(1);
    expect(first.numbers).toMatchObject({ floor: 1, limit: 4 });
    const attempts = socket.mock.calls.length;
    expect(attempts).toBeGreaterThan(0);
    let granted = false;
    const second = budget.admit(request).then((grant) => {
      granted = true;
      return grant;
    });
    await Bun.sleep(5);
    expect(granted).toBe(false);
    await first.release();
    const next = await second;
    expect(next.floor).toBe(true);
    expect(next.permits).toBe(1);
    const abort = new AbortController();
    const cancelled = budget.admit(request, abort.signal);
    abort.abort();
    await expect(cancelled).rejects.toThrow();
    await next.release();
    expect(socket.mock.calls.length).toBe(attempts);
  } finally {
    clock.mockRestore();
    socket.mockRestore();
    rmSync(path, { recursive: true, force: true });
  }
});

// A monotonic test clock pins the retry edges without making timing assertions
// depend on the machine's load. Connections still use the real private socket.
test("outage memory doubles from 100 ms to a bounded 1 s and retries at expiry", async () => {
  const path = directory();
  let now = 0;
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  const socket = spyOn(net, "createConnection");
  const budget = await clientBudget(path);
  try {
    await (await budget.admit(request)).release();
    for (const delay of [100, 200, 400, 800, 1000, 1000]) {
      const attempts = socket.mock.calls.length;
      now += delay - 1;
      const remembered = await budget.admit(request);
      expect(remembered.floor).toBe(true);
      await remembered.release();
      expect(socket.mock.calls.length).toBe(attempts);
      now++;
      const retry = await budget.admit(request);
      expect(retry.floor).toBe(true);
      await retry.release();
      expect(socket.mock.calls.length).toBeGreaterThan(attempts);
    }
  } finally {
    clock.mockRestore();
    socket.mockRestore();
    rmSync(path, { recursive: true, force: true });
  }
});

// Host return must restore normal grants at the capped expiry, then reset the
// next outage to 100 ms. Existing live grants still obey the host's scheduler.
test("a returning host is joined by the 1 s expiry and success resets failure memory", async () => {
  const path = directory();
  let now = 0;
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  const budget = await clientBudget(path);
  let host: Awaited<ReturnType<typeof hostBudget>>;
  try {
    await (await budget.admit(request)).release();
    for (const delay of [100, 200, 400, 800]) {
      now += delay;
      await (await budget.admit(request)).release();
    }
    host = await hostBudget({ directory: path, threads: 4, fixed: 4 });
    if (!host) throw new Error("Private host did not start");
    now += 999;
    const remembered = await budget.admit(request);
    expect(remembered.floor).toBe(true);
    await remembered.release();
    now++;
    for (let index = 0; index < 10; index++) {
      const live = await budget.admit(request);
      expect(live.floor).not.toBe(true);
      expect(live.permits).toBe(2);
      await live.release();
    }
    await host.close();
    await (await budget.admit(request)).release();
    host = await hostBudget({ directory: path, threads: 4, fixed: 4 });
    if (!host) throw new Error("Private host did not restart");
    now += 100;
    const reset = await budget.admit(request);
    expect(reset.floor).not.toBe(true);
    expect(reset.permits).toBe(2);
    await reset.release();
  } finally {
    clock.mockRestore();
    await host?.close();
    rmSync(path, { recursive: true, force: true });
  }
});

// Review reserves must re-register immediately through the existing recovery
// path even if the last admission recorded an outage.
test("active review leases bypass admission memory and replay their host reserve", async () => {
  const path = directory();
  const clock = spyOn(performance, "now").mockReturnValue(0);
  const budget = await clientBudget(path);
  let host: Awaited<ReturnType<typeof hostBudget>>;
  let leave: (() => void) | undefined;
  try {
    await (await budget.admit(request)).release();
    leave = await budget.activate?.("a".repeat(64), "retry-review");
    host = await hostBudget({ directory: path, threads: 4, fixed: 4 });
    if (!host) throw new Error("Private host did not start");
    const grant = await budget.admit(request);
    expect(grant.floor).not.toBe(true);
    expect(grant.permits).toBe(2);
    expect((await budget.observe()).activeRuns).toBe(1);
    await grant.release();
  } finally {
    leave?.();
    clock.mockRestore();
    await host?.close();
    rmSync(path, { recursive: true, force: true });
  }
});
